// SVG Parser — converts an SVG document (via the browser's native DOMParser) into the
// same internal geometry format used by dxf/parser.js: line / circle / arc / polyline
// (bulge) entities. Curves (path C/S/Q/T/A commands, circle/ellipse/rounded-rect) are
// sampled into polyline vertices, mirroring how dxf/parser.js handles SPLINE/ELLIPSE.
//
// Supports: <path>, <line>, <rect> (incl. rounded corners), <circle>, <ellipse>,
// <polyline>, <polygon>, <g>/<svg>/<a> nesting with `transform`. Not supported:
// <text>, <image>, <use>, CSS-file styling, percentage widths/heights.

const UNIT_TO_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };
const CURVE_SEGMENTS = 16;
const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function parseSvg(content) {
  const doc = new DOMParser().parseFromString(content, 'image/svg+xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error('Invalid SVG: ' + parseErr.textContent.slice(0, 200));

  const svgEl = doc.documentElement;
  const { scaleX, scaleY, originX, originY } = computeUnitScale(svgEl);

  const layers = {};
  const entities = [];
  let idCounter = 0;

  function ensureLayer(name) {
    if (!layers[name]) layers[name] = { name, color: '#888888', visible: true, locked: false, entityCount: 0 };
    layers[name].entityCount++;
  }

  // viewBox-space -> mm, then flip Y since SVG's Y axis points down and this app's
  // canvas (like DXF) treats Y as pointing up.
  function toMM(p) {
    return { x: (p.x - originX) * scaleX, y: -((p.y - originY) * scaleY) };
  }

  function pushEntity(geo, layer) {
    ensureLayer(layer);
    entities.push({ ...geo, layer, id: `svg_${idCounter++}` });
  }

  function isHidden(el) {
    const style = el.getAttribute('style') || '';
    return el.getAttribute('display') === 'none' ||
      el.getAttribute('visibility') === 'hidden' ||
      /display\s*:\s*none/.test(style);
  }

  function walk(el, matrix, layer) {
    if (!el || el.nodeType !== 1 || isHidden(el)) return;
    const tag = el.tagName.toLowerCase();
    const m = multiply(matrix, parseTransform(el.getAttribute('transform')));
    const nextLayer = (tag === 'g' && el.getAttribute('id')) ? el.getAttribute('id') : layer;

    switch (tag) {
      case 'g': case 'svg': case 'a':
        for (const child of el.children) walk(child, m, nextLayer);
        return;

      case 'path': {
        const d = el.getAttribute('d');
        if (!d) return;
        for (const sp of parsePathData(d)) {
          if (sp.points.length < 2) continue;
          const vertices = sp.points.map(p => ({ ...toMM(applyMatrix(m, p)), bulge: 0 }));
          pushEntity({ type: 'polyline', vertices, closed: sp.closed }, nextLayer);
        }
        return;
      }

      case 'line': {
        const start = toMM(applyMatrix(m, { x: num(el, 'x1'), y: num(el, 'y1') }));
        const end   = toMM(applyMatrix(m, { x: num(el, 'x2'), y: num(el, 'y2') }));
        pushEntity({ type: 'line', start, end }, nextLayer);
        return;
      }

      case 'rect': {
        const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
        if (w <= 0 || h <= 0) return;
        let rx = el.hasAttribute('rx') ? num(el, 'rx') : (el.hasAttribute('ry') ? num(el, 'ry') : 0);
        let ry = el.hasAttribute('ry') ? num(el, 'ry') : rx;
        rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
        const pts = (rx > 0 || ry > 0)
          ? roundedRectPoints(x, y, w, h, rx, ry)
          : [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }];
        const vertices = pts.map(p => ({ ...toMM(applyMatrix(m, p)), bulge: 0 }));
        pushEntity({ type: 'polyline', vertices, closed: true }, nextLayer);
        return;
      }

      case 'circle': {
        const r = num(el, 'r');
        if (r <= 0) return;
        const pts = ellipsePoints(num(el, 'cx'), num(el, 'cy'), r, r, 64);
        const vertices = pts.map(p => ({ ...toMM(applyMatrix(m, p)), bulge: 0 }));
        pushEntity({ type: 'polyline', vertices, closed: true }, nextLayer);
        return;
      }

      case 'ellipse': {
        const rx = num(el, 'rx'), ry = num(el, 'ry');
        if (rx <= 0 || ry <= 0) return;
        const pts = ellipsePoints(num(el, 'cx'), num(el, 'cy'), rx, ry, 72);
        const vertices = pts.map(p => ({ ...toMM(applyMatrix(m, p)), bulge: 0 }));
        pushEntity({ type: 'polyline', vertices, closed: true }, nextLayer);
        return;
      }

      case 'polyline': case 'polygon': {
        const raw = parseNumberList(el.getAttribute('points') || '');
        const pts = [];
        for (let i = 0; i + 1 < raw.length; i += 2) pts.push({ x: raw[i], y: raw[i + 1] });
        if (pts.length < 2) return;
        const vertices = pts.map(p => ({ ...toMM(applyMatrix(m, p)), bulge: 0 }));
        pushEntity({ type: 'polyline', vertices, closed: tag === 'polygon' }, nextLayer);
        return;
      }

      default:
        return; // text/image/use/etc. — unsupported, skip
    }
  }

  for (const child of svgEl.children) walk(child, IDENTITY, 'default');

  return { entities, layers };
}

// ── Unit / viewBox handling ────────────────────────────────────────────────────

function unitFactor(attr) {
  if (!attr) return null;
  const match = attr.trim().match(/^([\d.eE+-]+)\s*([a-zA-Z%]*)$/);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  if (unit === '%') return null; // needs a container size we don't have
  return UNIT_TO_MM[unit] ?? UNIT_TO_MM[''];
}

function computeUnitScale(svgEl) {
  const viewBoxAttr = svgEl.getAttribute('viewBox');
  const widthAttr = svgEl.getAttribute('width');
  const heightAttr = svgEl.getAttribute('height');

  let vb = null;
  if (viewBoxAttr) {
    const parts = parseNumberList(viewBoxAttr);
    if (parts.length === 4) vb = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }

  if (vb) {
    const wf = unitFactor(widthAttr), hf = unitFactor(heightAttr);
    const widthMM  = wf != null ? parseFloat(widthAttr) * wf : null;
    const heightMM = hf != null ? parseFloat(heightAttr) * hf : null;
    return {
      scaleX: (widthMM != null && vb.w) ? widthMM / vb.w : UNIT_TO_MM[''],
      scaleY: (heightMM != null && vb.h) ? heightMM / vb.h : UNIT_TO_MM[''],
      originX: vb.x, originY: vb.y,
    };
  }

  return {
    scaleX: unitFactor(widthAttr) ?? UNIT_TO_MM[''],
    scaleY: unitFactor(heightAttr) ?? UNIT_TO_MM[''],
    originX: 0, originY: 0,
  };
}

// ── Transform matrices (2D affine, SVG [a b c d e f] convention) ──────────────────

function multiply(A, B) {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e,
    f: A.b * B.e + A.d * B.f + A.f,
  };
}

function applyMatrix(M, p) {
  return { x: M.a * p.x + M.c * p.y + M.e, y: M.b * p.x + M.d * p.y + M.f };
}

function parseTransform(str) {
  if (!str) return IDENTITY;
  let result = IDENTITY;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(str))) {
    const args = parseNumberList(m[2]);
    let T = IDENTITY;
    switch (m[1]) {
      case 'translate':
        T = { a: 1, b: 0, c: 0, d: 1, e: args[0] || 0, f: args[1] || 0 };
        break;
      case 'scale': {
        const sx = args[0] ?? 1, sy = args[1] ?? sx;
        T = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
        break;
      }
      case 'rotate': {
        const rad = (args[0] || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const R = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
        T = (args.length >= 3)
          ? multiply(multiply({ a: 1, b: 0, c: 0, d: 1, e: args[1], f: args[2] }, R),
                     { a: 1, b: 0, c: 0, d: 1, e: -args[1], f: -args[2] })
          : R;
        break;
      }
      case 'skewX': {
        const t = Math.tan((args[0] || 0) * Math.PI / 180);
        T = { a: 1, b: 0, c: t, d: 1, e: 0, f: 0 };
        break;
      }
      case 'skewY': {
        const t = Math.tan((args[0] || 0) * Math.PI / 180);
        T = { a: 1, b: t, c: 0, d: 1, e: 0, f: 0 };
        break;
      }
      case 'matrix':
        if (args.length === 6) T = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
        break;
      default:
        break;
    }
    result = multiply(result, T);
  }
  return result;
}

// ── Path data ("d" attribute) parsing ──────────────────────────────────────────

class PathCursor {
  constructor(d) { this.s = d; this.i = 0; this.n = d.length; }
  skipSep() { while (this.i < this.n && /[\s,]/.test(this.s[this.i])) this.i++; }
  peekCmd() {
    this.skipSep();
    if (this.i >= this.n) return null;
    const c = this.s[this.i];
    return /[MmLlHhVvCcSsQqTtAaZz]/.test(c) ? c : null;
  }
  nextCmd() { const c = this.peekCmd(); if (c) this.i++; return c; }
  nextNumber() {
    this.skipSep();
    const m = this.s.slice(this.i).match(/^[-+]?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][-+]?\d+)?/);
    if (!m) return 0;
    this.i += m[0].length;
    return parseFloat(m[0]);
  }
  nextFlag() {
    this.skipSep();
    if (this.i >= this.n || (this.s[this.i] !== '0' && this.s[this.i] !== '1')) return false;
    return this.s[this.i++] === '1';
  }
  hasMoreArgs() {
    this.skipSep();
    return this.i < this.n && /[-+.\d]/.test(this.s[this.i]);
  }
}

function parsePathData(d) {
  const cur = new PathCursor(d);
  const subpaths = [];
  let curSub = null;
  let curX = 0, curY = 0, startX = 0, startY = 0;
  let prevCmd = null, prevCtrl = null;

  function startSubpath(x, y) {
    if (curSub && curSub.points.length) subpaths.push(curSub);
    curSub = { points: [{ x, y }], closed: false };
    curX = x; curY = y; startX = x; startY = y;
  }
  function lineTo(x, y) {
    if (!curSub) startSubpath(curX, curY);
    curSub.points.push({ x, y });
    curX = x; curY = y;
  }
  function closeSubpath() {
    if (!curSub) return;
    curSub.closed = true;
    if (Math.hypot(curX - startX, curY - startY) > 1e-9) curSub.points.push({ x: startX, y: startY });
    curX = startX; curY = startY;
  }
  function cubicTo(x1, y1, x2, y2, x, y) {
    if (!curSub) startSubpath(curX, curY);
    curSub.points.push(...sampleCubicBezier(curX, curY, x1, y1, x2, y2, x, y, CURVE_SEGMENTS).slice(1));
    curX = x; curY = y;
  }
  function quadTo(x1, y1, x, y) {
    if (!curSub) startSubpath(curX, curY);
    curSub.points.push(...sampleQuadBezier(curX, curY, x1, y1, x, y, CURVE_SEGMENTS).slice(1));
    curX = x; curY = y;
  }
  function arcTo(rx, ry, rotDeg, largeArc, sweep, x, y) {
    if (!curSub) startSubpath(curX, curY);
    curSub.points.push(...sampleSvgArc(curX, curY, rx, ry, rotDeg, largeArc, sweep, x, y, CURVE_SEGMENTS).slice(1));
    curX = x; curY = y;
  }

  let cmd = cur.nextCmd();
  while (cmd) {
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === 'M') {
      const x = cur.nextNumber(), y = cur.nextNumber();
      startSubpath(rel ? curX + x : x, rel ? curY + y : y);
      while (cur.hasMoreArgs()) {
        const x2 = cur.nextNumber(), y2 = cur.nextNumber();
        lineTo(rel ? curX + x2 : x2, rel ? curY + y2 : y2);
      }
      prevCtrl = null;
    } else if (C === 'L') {
      do {
        const x = cur.nextNumber(), y = cur.nextNumber();
        lineTo(rel ? curX + x : x, rel ? curY + y : y);
      } while (cur.hasMoreArgs());
      prevCtrl = null;
    } else if (C === 'H') {
      do { lineTo(rel ? curX + cur.nextNumber() : cur.nextNumber(), curY); } while (cur.hasMoreArgs());
      prevCtrl = null;
    } else if (C === 'V') {
      do { lineTo(curX, rel ? curY + cur.nextNumber() : cur.nextNumber()); } while (cur.hasMoreArgs());
      prevCtrl = null;
    } else if (C === 'C') {
      do {
        const x1 = cur.nextNumber(), y1 = cur.nextNumber(), x2 = cur.nextNumber(), y2 = cur.nextNumber(), x = cur.nextNumber(), y = cur.nextNumber();
        const ax1 = rel ? curX + x1 : x1, ay1 = rel ? curY + y1 : y1;
        const ax2 = rel ? curX + x2 : x2, ay2 = rel ? curY + y2 : y2;
        const ax = rel ? curX + x : x, ay = rel ? curY + y : y;
        cubicTo(ax1, ay1, ax2, ay2, ax, ay);
        prevCtrl = { x: ax2, y: ay2 };
      } while (cur.hasMoreArgs());
    } else if (C === 'S') {
      let smoothOk = prevCmd && 'CS'.includes(prevCmd.toUpperCase());
      do {
        const x2 = cur.nextNumber(), y2 = cur.nextNumber(), x = cur.nextNumber(), y = cur.nextNumber();
        const ax2 = rel ? curX + x2 : x2, ay2 = rel ? curY + y2 : y2;
        const ax = rel ? curX + x : x, ay = rel ? curY + y : y;
        const c1 = smoothOk ? { x: 2 * curX - prevCtrl.x, y: 2 * curY - prevCtrl.y } : { x: curX, y: curY };
        cubicTo(c1.x, c1.y, ax2, ay2, ax, ay);
        prevCtrl = { x: ax2, y: ay2 };
        smoothOk = true;
      } while (cur.hasMoreArgs());
    } else if (C === 'Q') {
      do {
        const x1 = cur.nextNumber(), y1 = cur.nextNumber(), x = cur.nextNumber(), y = cur.nextNumber();
        const ax1 = rel ? curX + x1 : x1, ay1 = rel ? curY + y1 : y1;
        const ax = rel ? curX + x : x, ay = rel ? curY + y : y;
        quadTo(ax1, ay1, ax, ay);
        prevCtrl = { x: ax1, y: ay1 };
      } while (cur.hasMoreArgs());
    } else if (C === 'T') {
      let smoothOk = prevCmd && 'QT'.includes(prevCmd.toUpperCase());
      do {
        const x = cur.nextNumber(), y = cur.nextNumber();
        const ax = rel ? curX + x : x, ay = rel ? curY + y : y;
        const c1 = smoothOk ? { x: 2 * curX - prevCtrl.x, y: 2 * curY - prevCtrl.y } : { x: curX, y: curY };
        quadTo(c1.x, c1.y, ax, ay);
        prevCtrl = c1;
        smoothOk = true;
      } while (cur.hasMoreArgs());
    } else if (C === 'A') {
      do {
        const rx = cur.nextNumber(), ry = cur.nextNumber(), rot = cur.nextNumber();
        const largeArc = cur.nextFlag(), sweep = cur.nextFlag();
        const x = cur.nextNumber(), y = cur.nextNumber();
        const ax = rel ? curX + x : x, ay = rel ? curY + y : y;
        arcTo(rx, ry, rot, largeArc, sweep, ax, ay);
      } while (cur.hasMoreArgs());
      prevCtrl = null;
    } else if (C === 'Z') {
      closeSubpath();
      prevCtrl = null;
    }

    prevCmd = cmd;
    cmd = cur.nextCmd();
  }
  if (curSub && curSub.points.length) subpaths.push(curSub);
  return subpaths;
}

// ── Sampling helpers ────────────────────────────────────────────────────────────

function sampleCubicBezier(x0, y0, x1, y1, x2, y2, x3, y3, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, e = t * t * t;
    pts.push({ x: a * x0 + b * x1 + c * x2 + e * x3, y: a * y0 + b * y1 + c * y2 + e * y3 });
  }
  return pts;
}

function sampleQuadBezier(x0, y0, x1, y1, x2, y2, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    const a = mt * mt, b = 2 * mt * t, c = t * t;
    pts.push({ x: a * x0 + b * x1 + c * x2, y: a * y0 + b * y1 + c * y2 });
  }
  return pts;
}

// Endpoint-to-center arc parameterization per SVG spec appendix F.6.5.
function sampleSvgArc(x0, y0, rx, ry, xRotDeg, largeArc, sweep, x, y, n) {
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) return [{ x: x0, y: y0 }, { x, y }];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = xRotDeg * Math.PI / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);

  const dx2 = (x0 - x) / 2, dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  let rxSq = rx * rx, rySq = ry * ry;
  const x1pSq = x1p * x1p, y1pSq = y1p * y1p;
  const lambda = x1pSq / rxSq + y1pSq / rySq;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s;
    rxSq = rx * rx; rySq = ry * ry;
  }

  const sign = (largeArc !== sweep) ? 1 : -1;
  const numerator = Math.max(rxSq * rySq - rxSq * y1pSq - rySq * x1pSq, 0);
  const co = sign * Math.sqrt(numerator / (rxSq * y1pSq + rySq * x1pSq || 1));
  const cxp = co * (rx * y1p / ry);
  const cyp = co * (-ry * x1p / rx);

  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  function angleBetween(ux, uy, vx, vy) {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  }
  const theta1 = angleBetween(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angleBetween((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const segs = Math.max(4, Math.min(n * 4, Math.round(Math.abs(dTheta) / (Math.PI / 24))));
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = theta1 + dTheta * (i / segs);
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    pts.push({ x: cosPhi * ex - sinPhi * ey + cx, y: sinPhi * ex + cosPhi * ey + cy });
  }
  pts[0] = { x: x0, y: y0 };
  pts[pts.length - 1] = { x, y };
  return pts;
}

function ellipsePoints(cx, cy, rx, ry, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return pts;
}

function roundedRectPoints(x, y, w, h, rx, ry) {
  const seg = 8;
  const pts = [];
  function arcCorner(cx, cy, startDeg, endDeg) {
    for (let i = 0; i <= seg; i++) {
      const a = (startDeg + (endDeg - startDeg) * (i / seg)) * Math.PI / 180;
      pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
    }
  }
  arcCorner(x + w - rx, y + ry, -90, 0);
  arcCorner(x + w - rx, y + h - ry, 0, 90);
  arcCorner(x + rx, y + h - ry, 90, 180);
  arcCorner(x + rx, y + ry, 180, 270);
  pts.push({ ...pts[0] });
  return pts;
}

function num(el, attr, fallback = 0) {
  const raw = el.getAttribute(attr);
  if (raw == null) return fallback;
  const v = parseFloat(raw);
  return isNaN(v) ? fallback : v;
}

function parseNumberList(str) {
  return (str.match(/[-+]?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
}
