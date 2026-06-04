// DXF Parser wrapper - converts dxf-parser output to our internal geometry format
// Supports: LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, SPLINE, ELLIPSE, INSERT

export function parseDxf(content) {
  try {
    // Use dxf-parser library (loaded via CDN fallback or npm)
    const DxfParser = window.DxfParser || require('dxf-parser');
    const parser = new DxfParser();
    const dxf = parser.parseSync(content);
    return extractGeometry(dxf);
  } catch (err) {
    // Fallback: manual ASCII DXF parser for simple files
    return parseSimpleDxf(content);
  }
}

function extractGeometry(dxf) {
  const layers = {};
  const entities = [];

  if (!dxf || !dxf.entities) return { layers: {}, entities: [] };

  for (const entity of dxf.entities) {
    const layer = entity.layer || '0';
    if (!layers[layer]) {
      layers[layer] = {
        name: layer,
        color: getLayerColor(dxf, layer),
        visible: true,
        locked: false,
        entityCount: 0,
      };
    }
    layers[layer].entityCount++;

    const geo = convertEntity(entity);
    if (geo) {
      entities.push({ ...geo, layer, id: `${entity.type}_${entities.length}` });
    }
  }

  return { layers, entities };
}

function convertEntity(entity) {
  switch (entity.type) {
    case 'LINE':
      return {
        type: 'line',
        start: { x: entity.vertices?.[0]?.x ?? entity.start?.x ?? 0, y: entity.vertices?.[0]?.y ?? entity.start?.y ?? 0 },
        end:   { x: entity.vertices?.[1]?.x ?? entity.end?.x ?? 0,   y: entity.vertices?.[1]?.y ?? entity.end?.y ?? 0 },
      };

    case 'CIRCLE':
      return {
        type: 'circle',
        center: { x: entity.center?.x ?? 0, y: entity.center?.y ?? 0 },
        radius: entity.radius ?? 0,
      };

    case 'ARC':
      return {
        type: 'arc',
        center: { x: entity.center?.x ?? 0, y: entity.center?.y ?? 0 },
        radius: entity.radius ?? 0,
        startAngle: (entity.startAngle ?? 0) * Math.PI / 180,
        endAngle: (entity.endAngle ?? 0) * Math.PI / 180,
      };

    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const verts = (entity.vertices || []).map(v => ({ x: v.x ?? 0, y: v.y ?? 0, bulge: v.bulge ?? 0 }));
      return {
        type: 'polyline',
        vertices: verts,
        closed: entity.closed || entity.shape || false,
      };
    }

    case 'SPLINE': {
      if (!entity.controlPoints || entity.controlPoints.length < 2) return null;
      const pts = sampleSpline(entity.controlPoints, entity.degree || 3, entity.knots || [], 64);
      return { type: 'polyline', vertices: pts.map(p => ({ x: p.x, y: p.y, bulge: 0 })), closed: false };
    }

    case 'ELLIPSE': {
      const pts = sampleEllipse(entity, 72);
      return { type: 'polyline', vertices: pts.map(p => ({ x: p.x, y: p.y, bulge: 0 })), closed: true };
    }

    default:
      return null;
  }
}

// Convert all entities to polyline segments for toolpath use
export function entitiesToSegments(entities) {
  const segments = [];
  for (const e of entities) {
    switch (e.type) {
      case 'line':
        segments.push({ points: [e.start, e.end], closed: false, source: e });
        break;
      case 'circle': {
        const pts = circleToPoints(e.center, e.radius, 72);
        segments.push({ points: pts, closed: true, source: e });
        break;
      }
      case 'arc': {
        const pts = arcToPoints(e.center, e.radius, e.startAngle, e.endAngle, 36);
        segments.push({ points: pts, closed: false, source: e });
        break;
      }
      case 'polyline': {
        const pts = polylineToPoints(e.vertices, e.closed);
        segments.push({ points: pts, closed: e.closed, source: e });
        break;
      }
    }
  }
  return segments;
}

export function circleToPoints(center, radius, count = 64) {
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const a = (i / count) * Math.PI * 2;
    pts.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius });
  }
  return pts;
}

export function arcToPoints(center, radius, startAngle, endAngle, count = 32) {
  const pts = [];
  let end = endAngle;
  if (end <= startAngle) end += Math.PI * 2;
  const span = end - startAngle;
  for (let i = 0; i <= count; i++) {
    const a = startAngle + (i / count) * span;
    pts.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius });
  }
  return pts;
}

export function polylineToPoints(vertices, closed) {
  const pts = [];
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    pts.push({ x: v.x, y: v.y });
    if (v.bulge && v.bulge !== 0 && i < vertices.length - 1) {
      const next = vertices[(i + 1) % vertices.length];
      const bulgePts = bulgeToPts(v, next, v.bulge);
      pts.push(...bulgePts.slice(1, -1));
    }
  }
  if (closed && pts.length > 0) pts.push({ ...pts[0] });
  return pts;
}

function bulgeToPts(p1, p2, bulge) {
  const angle = 4 * Math.atan(Math.abs(bulge));
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const r = dist / (2 * Math.sin(angle / 2));
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const perpX = -dy / dist;
  const perpY = dx / dist;
  const d = Math.sqrt(Math.max(0, r * r - (dist / 2) * (dist / 2)));
  const sign = bulge > 0 ? 1 : -1;
  const cx = midX + sign * d * perpX;
  const cy = midY + sign * d * perpY;
  const startAngle = Math.atan2(p1.y - cy, p1.x - cx);
  const endAngle = Math.atan2(p2.y - cy, p2.x - cx);
  return arcToPoints({ x: cx, y: cy }, r, startAngle, endAngle, Math.max(4, Math.ceil(angle * 8)));
}

function sampleEllipse(entity, count) {
  const cx = entity.center?.x ?? 0;
  const cy = entity.center?.y ?? 0;
  const mx = entity.majorAxisEndPoint?.x ?? 1;
  const my = entity.majorAxisEndPoint?.y ?? 0;
  const major = Math.hypot(mx, my);
  const minor = major * (entity.axisRatio ?? 1);
  const rotation = Math.atan2(my, mx);
  const pts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const ex = Math.cos(a) * major;
    const ey = Math.sin(a) * minor;
    pts.push({
      x: cx + ex * Math.cos(rotation) - ey * Math.sin(rotation),
      y: cy + ex * Math.sin(rotation) + ey * Math.cos(rotation),
    });
  }
  pts.push({ ...pts[0] });
  return pts;
}

function sampleSpline(controlPoints, degree, knots, count) {
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    pts.push(evaluateBSpline(controlPoints, degree, knots, t));
  }
  return pts;
}

function evaluateBSpline(pts, degree, knots, t) {
  const n = pts.length - 1;
  const d = degree;
  if (knots.length === 0) {
    // Uniform knot vector
    knots = [];
    for (let i = 0; i <= n + d + 1; i++) knots.push(i);
  }
  const tMin = knots[d];
  const tMax = knots[n + 1];
  const tScaled = tMin + t * (tMax - tMin);
  const clampedT = Math.min(tScaled, tMax - 1e-9);

  // De Boor
  let span = d;
  for (let i = d; i <= n; i++) {
    if (clampedT >= knots[i] && clampedT < knots[i + 1]) { span = i; break; }
  }
  const dpts = [];
  for (let i = 0; i <= d; i++) {
    const idx = span - d + i;
    dpts.push({ x: pts[idx]?.x ?? 0, y: pts[idx]?.y ?? 0 });
  }
  for (let r = 1; r <= d; r++) {
    for (let j = d; j >= r; j--) {
      const i = span - d + j;
      const denom = knots[i + d - r + 1] - knots[i];
      const alpha = denom === 0 ? 0 : (clampedT - knots[i]) / denom;
      dpts[j] = {
        x: (1 - alpha) * dpts[j - 1].x + alpha * dpts[j].x,
        y: (1 - alpha) * dpts[j - 1].y + alpha * dpts[j].y,
      };
    }
  }
  return dpts[d];
}

function getLayerColor(dxf, layerName) {
  if (!dxf.tables?.layer?.layers) return '#888888';
  const layer = dxf.tables.layer.layers[layerName];
  if (!layer) return '#888888';
  return dxfColorToHex(layer.colorIndex ?? 7);
}

const DXF_COLORS = {
  1:'#ff0000',2:'#ffff00',3:'#00ff00',4:'#00ffff',5:'#0000ff',
  6:'#ff00ff',7:'#ffffff',8:'#c0c0c0',9:'#808080',
  10:'#ff4040',11:'#ffaaaa',12:'#c06030',13:'#ffc0a0',
  14:'#808000',15:'#c0c060',16:'#408000',17:'#a0c060',
  30:'#ff8000',31:'#ffcc80',32:'#c05000',
  40:'#80ff00',41:'#ccff80',42:'#408000',
  50:'#00ff80',51:'#80ffc0',
  60:'#00ff40',70:'#80ffc0',
  130:'#0080ff',131:'#80c0ff',140:'#004080',
  150:'#0000c0',160:'#c0c0ff',
  200:'#8000ff',201:'#c080ff',
  210:'#ff00c0',211:'#ffa0e0',
};
function dxfColorToHex(index) {
  return DXF_COLORS[index] || '#888888';
}

// Simple fallback DXF parser for basic files
function parseSimpleDxf(content) {
  const lines = content.split(/\r?\n/);
  const entities = [];
  const layers = {};
  let i = 0;

  function readGroup() {
    if (i >= lines.length - 1) return null;
    const code = parseInt(lines[i++].trim(), 10);
    const value = lines[i++].trim();
    return { code, value };
  }

  while (i < lines.length) {
    const g = readGroup();
    if (!g) break;
    if (g.code === 0 && g.value === 'LINE') {
      const data = {};
      let g2;
      while ((g2 = readGroup()) && g2.code !== 0) {
        if (g2.code === 8) data.layer = g2.value;
        if (g2.code === 10) data.x1 = parseFloat(g2.value);
        if (g2.code === 20) data.y1 = parseFloat(g2.value);
        if (g2.code === 11) data.x2 = parseFloat(g2.value);
        if (g2.code === 21) data.y2 = parseFloat(g2.value);
      }
      i -= 2;
      const layer = data.layer || '0';
      if (!layers[layer]) layers[layer] = { name: layer, color: '#888', visible: true, locked: false, entityCount: 0 };
      layers[layer].entityCount++;
      entities.push({ type: 'line', layer, id: `line_${entities.length}`, start: { x: data.x1 || 0, y: data.y1 || 0 }, end: { x: data.x2 || 0, y: data.y2 || 0 } });
    } else if (g.code === 0 && g.value === 'CIRCLE') {
      const data = {};
      let g2;
      while ((g2 = readGroup()) && g2.code !== 0) {
        if (g2.code === 8) data.layer = g2.value;
        if (g2.code === 10) data.cx = parseFloat(g2.value);
        if (g2.code === 20) data.cy = parseFloat(g2.value);
        if (g2.code === 40) data.r = parseFloat(g2.value);
      }
      i -= 2;
      const layer = data.layer || '0';
      if (!layers[layer]) layers[layer] = { name: layer, color: '#888', visible: true, locked: false, entityCount: 0 };
      layers[layer].entityCount++;
      entities.push({ type: 'circle', layer, id: `circle_${entities.length}`, center: { x: data.cx || 0, y: data.cy || 0 }, radius: data.r || 0 });
    }
  }

  return { layers, entities };
}

export function getBounds(entities) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function addPt(x, y) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  for (const e of entities) {
    if (e.type === 'line') { addPt(e.start.x, e.start.y); addPt(e.end.x, e.end.y); }
    else if (e.type === 'circle') { addPt(e.center.x - e.radius, e.center.y - e.radius); addPt(e.center.x + e.radius, e.center.y + e.radius); }
    else if (e.type === 'arc') { addPt(e.center.x - e.radius, e.center.y - e.radius); addPt(e.center.x + e.radius, e.center.y + e.radius); }
    else if (e.type === 'polyline') { for (const v of e.vertices) addPt(v.x, v.y); }
  }
  if (!isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100, width: 200, height: 200 };
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
