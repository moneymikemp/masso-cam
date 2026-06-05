// DXF Parser — converts dxf-parser (npm) output to internal geometry format.
// Falls back to a hand-rolled ASCII parser when the library is unavailable or fails.
// Supports: LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, SPLINE, ELLIPSE

export function parseDxf(content) {
  // Read units from raw text regardless of which parser path runs
  const insUnits = readInsUnitsFromText(content);
  const dxfUnits = insUnitsToLabel(insUnits);
  let result;

  try {
    // CRA/webpack will bundle this require() at build time.
    // Handle both direct-CJS export and ESM-wrapped default export.
    const mod = require('dxf-parser');
    const DxfParser = (typeof mod === 'function') ? mod : (mod.default ?? mod.DxfParser ?? mod);
    if (typeof DxfParser !== 'function') throw new Error('dxf-parser did not export a constructor');

    const parser = new DxfParser();
    const dxf = parser.parseSync(content);

    const rawTypes = [...new Set((dxf.entities || []).map(e => e.type))];
    console.log('[DXF] Library OK — raw entities:', dxf.entities?.length, '| types:', rawTypes.join(', ') || 'none');

    result = extractGeometry(dxf);
    console.log('[DXF] Extracted:', result.entities.length, 'entities | types:',
      [...new Set(result.entities.map(e => e.type))].join(', ') || 'none');
  } catch (err) {
    console.warn('[DXF] Library path failed — using built-in fallback parser. Reason:', err.message);
    result = parseSimpleDxf(content);
    console.log('[DXF] Fallback found:', result.entities.length, 'entities | types:',
      [...new Set(result.entities.map(e => e.type))].join(', ') || 'none');
  }

  if (insUnits === 1) {
    console.log('[DXF] Scaling from inches → mm (×25.4)');
    result.entities = scaleEntities(result.entities, 25.4);
  }
  return { ...result, dxfUnits };
}

function insUnitsToLabel(insUnits) {
  if (insUnits === 1) return 'inch';
  if (insUnits === 4) return 'mm';
  return 'unitless';
}

function readInsUnitsFromText(content) {
  const match = content.match(/^\s*\$INSUNITS\s*$[\r\n]+\s*70\s*[\r\n]+\s*(\d+)/m);
  return match ? parseInt(match[1], 10) : 0;
}

function scaleEntities(entities, factor) {
  return entities.map(e => {
    switch (e.type) {
      case 'line':
        return { ...e,
          start: { x: e.start.x * factor, y: e.start.y * factor },
          end:   { x: e.end.x   * factor, y: e.end.y   * factor },
        };
      case 'circle':
        return { ...e,
          center: { x: e.center.x * factor, y: e.center.y * factor },
          radius: e.radius * factor,
        };
      case 'arc':
        return { ...e,
          center: { x: e.center.x * factor, y: e.center.y * factor },
          radius: e.radius * factor,
        };
      case 'polyline':
        return { ...e,
          vertices: e.vertices.map(v => ({ ...v, x: v.x * factor, y: v.y * factor })),
        };
      default:
        return e;
    }
  });
}

// ── dxf-parser library path ────────────────────────────────────────────────────

function extractGeometry(dxf) {
  const layers = {};
  const entities = [];

  if (!dxf || !dxf.entities) return { layers: {}, entities: [] };

  // Debug flags — log the raw object the first time each problem type is seen
  let loggedLwpolyline = false;
  let loggedArc        = false;

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

    // ── RAW ENTITY DEBUG ───────────────────────────────────────────────────
    if (entity.type === 'LWPOLYLINE' && !loggedLwpolyline) {
      loggedLwpolyline = true;
      console.log('[DXF DEBUG] First LWPOLYLINE raw entity:');
      console.log('  type:',     entity.type);
      console.log('  closed:',   entity.closed);
      console.log('  shape:',    entity.shape);
      console.log('  flags:',    entity.flags);
      console.log('  vertices (raw):', JSON.stringify(entity.vertices));
      if (Array.isArray(entity.vertices) && entity.vertices.length > 0) {
        const v0 = entity.vertices[0];
        console.log('  vertices[0] keys:', Object.keys(v0));
        console.log('  vertices[0] values:', JSON.stringify(v0));
        // Probe every likely coordinate property
        console.log('  vertices[0].x:', v0.x, ' .y:', v0.y,
          ' [0]:', v0[0], ' [1]:', v0[1]);
      }
      console.log('  full entity dump:', JSON.stringify(entity, null, 2));
    }

    if (entity.type === 'LINE' && !loggedArc) {
      // Borrow the loggedArc flag as "loggedLine" — we only need one LINE sample
      loggedArc = true;
      console.log('[DXF DEBUG] First LINE raw entity:');
      console.log('  start:', JSON.stringify(entity.start), ' end:', JSON.stringify(entity.end));
      console.log('  vertices:', JSON.stringify(entity.vertices));
      console.log('  full entity dump:', JSON.stringify(entity, null, 2));
    }

    if (entity.type === 'ARC' && !loggedLwpolyline) {
      // Borrow the loggedLwpolyline flag as "loggedArc"
      loggedLwpolyline = true;
      console.log('[DXF DEBUG] First ARC raw entity:');
      console.log('  center:',     JSON.stringify(entity.center));
      console.log('  radius:',     entity.radius);
      console.log('  startAngle:', entity.startAngle, '← confirmed RADIANS from dxf-parser');
      console.log('  endAngle:',   entity.endAngle,   '← confirmed RADIANS from dxf-parser');
      console.log('  full entity dump:', JSON.stringify(entity, null, 2));
    }
    // ── END DEBUG ──────────────────────────────────────────────────────────

    const geo = convertEntity(entity);
    if (geo) {
      entities.push({ ...geo, layer, id: `${entity.type}_${entities.length}` });
    } else {
      console.log('[DXF] convertEntity: skipped entity type', entity.type);
    }
  }

  return { layers, entities };
}

function convertEntity(entity) {
  switch (entity.type) {
    case 'LINE':
      return {
        type: 'line',
        start: { x: entity.start?.x ?? 0, y: entity.start?.y ?? 0 },
        end:   { x: entity.end?.x   ?? 0, y: entity.end?.y   ?? 0 },
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
        // dxf-parser already returns angles in radians — use them directly.
        startAngle: entity.startAngle ?? 0,
        endAngle:   entity.endAngle   ?? 0,
      };

    case 'LWPOLYLINE':
    case 'POLYLINE': {
      // dxf-parser v1.x stores LWPOLYLINE vertices as [{x,y,bulge?}]
      // Some versions also set entity.shape (not entity.closed) for the closed flag.
      const rawVerts = entity.vertices;
      const verts = Array.isArray(rawVerts)
        ? rawVerts.map(v => ({ x: v.x ?? 0, y: v.y ?? 0, bulge: v.bulge ?? 0 }))
        : [];

      if (verts.length < 2) return null;

      // Closed flag lives in different fields across dxf-parser versions
      const closed = !!(
        entity.closed ||
        entity.shape  ||
        (entity.flags != null && (entity.flags & 1))
      );

      return { type: 'polyline', vertices: verts, closed };
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

// ── Built-in fallback ASCII parser ────────────────────────────────────────────
// Handles LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE (with VERTEX sub-entities).
// Robust to blank lines, leading/trailing spaces, and \r\n line endings.

function parseSimpleDxf(content) {
  const lines = content.split(/\r?\n/);
  const entities = [];
  const layers = {};
  let pos = 0;
  let ungotGroup = null;

  function ensureLayer(name) {
    if (!layers[name]) {
      layers[name] = { name, color: '#888888', visible: true, locked: false, entityCount: 0 };
    }
    layers[name].entityCount++;
  }

  // Read the next code/value pair, skipping blank and non-numeric lines.
  function readGroup() {
    if (ungotGroup) { const g = ungotGroup; ungotGroup = null; return g; }
    while (pos < lines.length) {
      const codeLine = lines[pos++].trim();
      if (!codeLine) continue;                     // skip blank lines
      const code = parseInt(codeLine, 10);
      if (isNaN(code)) continue;                   // skip non-code lines
      // Skip blank lines between the code and its value
      while (pos < lines.length && !lines[pos].trim()) pos++;
      if (pos >= lines.length) return null;
      const value = lines[pos++].trim();
      return { code, value };
    }
    return null;
  }

  // "Push back" a group so the next readGroup() returns it.
  function unget(g) { ungotGroup = g; }

  // Read fields for the current entity until next entity boundary (code 0).
  // Returns an object shaped by the provided field-code handlers.
  function readEntityFields(handlers) {
    let g;
    while ((g = readGroup()) !== null) {
      if (g.code === 0) { unget(g); return; }
      const h = handlers[g.code];
      if (h) h(g.value);
    }
  }

  let g;
  while ((g = readGroup()) !== null) {
    if (g.code !== 0) continue;   // advance until an entity-start marker

    // ── LINE ────────────────────────────────────────────────────────────────
    if (g.value === 'LINE') {
      const d = { layer: '0', x1: NaN, y1: NaN, x2: NaN, y2: NaN };
      readEntityFields({
        8:  v => d.layer = v,
        10: v => d.x1 = parseFloat(v),
        20: v => d.y1 = parseFloat(v),
        11: v => d.x2 = parseFloat(v),
        21: v => d.y2 = parseFloat(v),
      });
      if (!isNaN(d.x1) && !isNaN(d.y1) && !isNaN(d.x2) && !isNaN(d.y2)) {
        ensureLayer(d.layer);
        entities.push({ type: 'line', layer: d.layer, id: `line_${entities.length}`,
          start: { x: d.x1, y: d.y1 }, end: { x: d.x2, y: d.y2 } });
      }

    // ── CIRCLE ──────────────────────────────────────────────────────────────
    } else if (g.value === 'CIRCLE') {
      const d = { layer: '0', cx: 0, cy: 0, r: NaN };
      readEntityFields({
        8:  v => d.layer = v,
        10: v => d.cx = parseFloat(v),
        20: v => d.cy = parseFloat(v),
        40: v => d.r  = parseFloat(v),
      });
      if (!isNaN(d.r)) {
        ensureLayer(d.layer);
        entities.push({ type: 'circle', layer: d.layer, id: `circle_${entities.length}`,
          center: { x: d.cx, y: d.cy }, radius: d.r });
      }

    // ── ARC ─────────────────────────────────────────────────────────────────
    } else if (g.value === 'ARC') {
      const d = { layer: '0', cx: 0, cy: 0, r: NaN, sa: 0, ea: 0 };
      readEntityFields({
        8:  v => d.layer = v,
        10: v => d.cx = parseFloat(v),
        20: v => d.cy = parseFloat(v),
        40: v => d.r  = parseFloat(v),
        50: v => d.sa = parseFloat(v),
        51: v => d.ea = parseFloat(v),
      });
      if (!isNaN(d.r)) {
        ensureLayer(d.layer);
        entities.push({ type: 'arc', layer: d.layer, id: `arc_${entities.length}`,
          center: { x: d.cx, y: d.cy }, radius: d.r,
          startAngle: d.sa * Math.PI / 180,
          endAngle:   d.ea * Math.PI / 180 });
      }

    // ── LWPOLYLINE ──────────────────────────────────────────────────────────
    // Vertices are inline: repeated 10(x)/20(y) pairs, optional 42(bulge).
    } else if (g.value === 'LWPOLYLINE') {
      const d = { layer: '0', flags: 0 };
      const vertices = [];
      let curX = null, curY = null, curBulge = 0;
      let g2;
      while ((g2 = readGroup()) !== null) {
        if (g2.code === 0) { unget(g2); break; }
        if      (g2.code === 8)  { d.layer = g2.value; }
        else if (g2.code === 70) { d.flags = parseInt(g2.value, 10) || 0; }
        else if (g2.code === 10) {
          // A new x signals the start of the next vertex; flush the previous one.
          if (curX !== null && curY !== null) vertices.push({ x: curX, y: curY, bulge: curBulge });
          curX = parseFloat(g2.value); curY = null; curBulge = 0;
        }
        else if (g2.code === 20) { curY    = parseFloat(g2.value); }
        else if (g2.code === 42) { curBulge = parseFloat(g2.value); }
      }
      if (curX !== null && curY !== null) vertices.push({ x: curX, y: curY, bulge: curBulge });
      if (vertices.length >= 2) {
        ensureLayer(d.layer);
        entities.push({ type: 'polyline', layer: d.layer, id: `polyline_${entities.length}`,
          vertices, closed: !!(d.flags & 1) });
      }

    // ── POLYLINE (2D polyline with separate VERTEX sub-entities) ────────────
    } else if (g.value === 'POLYLINE') {
      const d = { layer: '0', flags: 0, vertices: [] };
      let g2;
      // Read POLYLINE header fields
      while ((g2 = readGroup()) !== null) {
        if (g2.code === 0) {
          if (g2.value === 'VERTEX') {
            // Read one VERTEX sub-entity
            const vd = { x: 0, y: 0, bulge: 0 };
            let g3;
            while ((g3 = readGroup()) !== null) {
              if (g3.code === 0) { unget(g3); break; }
              if (g3.code === 10) vd.x     = parseFloat(g3.value);
              if (g3.code === 20) vd.y     = parseFloat(g3.value);
              if (g3.code === 42) vd.bulge = parseFloat(g3.value);
            }
            d.vertices.push(vd);
          } else if (g2.value === 'SEQEND') {
            // Consume SEQEND fields then stop
            let g3;
            while ((g3 = readGroup()) !== null) {
              if (g3.code === 0) { unget(g3); break; }
            }
            break;
          } else {
            unget(g2);
            break;
          }
        } else {
          if (g2.code === 8)  d.layer = g2.value;
          if (g2.code === 70) d.flags = parseInt(g2.value, 10) || 0;
        }
      }
      if (d.vertices.length >= 2) {
        ensureLayer(d.layer);
        entities.push({ type: 'polyline', layer: d.layer, id: `polyline_${entities.length}`,
          vertices: d.vertices, closed: !!(d.flags & 1) });
      }
    }
    // All other entity types (SECTION, TABLE, BLOCK, etc.) are skipped;
    // readEntityFields is not called so their fields are consumed by the outer
    // loop's single-group-at-a-time advance.
  }

  return { layers, entities };
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

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
  const perpY =  dx / dist;
  const d = Math.sqrt(Math.max(0, r * r - (dist / 2) * (dist / 2)));
  const sign = bulge > 0 ? 1 : -1;
  const cx = midX + sign * d * perpX;
  const cy = midY + sign * d * perpY;
  const startAngle = Math.atan2(p1.y - cy, p1.x - cx);
  const endAngle   = Math.atan2(p2.y - cy, p2.x - cx);
  return arcToPoints({ x: cx, y: cy }, r, startAngle, endAngle, Math.max(4, Math.ceil(angle * 8)));
}

function sampleEllipse(entity, count) {
  const cx = entity.center?.x ?? 0;
  const cy = entity.center?.y ?? 0;
  const mx = entity.majorAxisEndPoint?.x ?? 1;
  const my = entity.majorAxisEndPoint?.y ?? 0;
  const major    = Math.hypot(mx, my);
  const minor    = major * (entity.axisRatio ?? 1);
  const rotation = Math.atan2(my, mx);
  const pts = [];
  for (let i = 0; i < count; i++) {
    const a  = (i / count) * Math.PI * 2;
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
    pts.push(evaluateBSpline(controlPoints, degree, knots, i / count));
  }
  return pts;
}

function evaluateBSpline(pts, degree, knots, t) {
  const n = pts.length - 1;
  const d = degree;
  if (knots.length === 0) {
    knots = [];
    for (let i = 0; i <= n + d + 1; i++) knots.push(i);
  }
  const tMin    = knots[d];
  const tMax    = knots[n + 1];
  const tScaled = tMin + t * (tMax - tMin);
  const ct      = Math.min(tScaled, tMax - 1e-9);
  let span = d;
  for (let i = d; i <= n; i++) {
    if (ct >= knots[i] && ct < knots[i + 1]) { span = i; break; }
  }
  const dpts = [];
  for (let i = 0; i <= d; i++) {
    const idx = span - d + i;
    dpts.push({ x: pts[idx]?.x ?? 0, y: pts[idx]?.y ?? 0 });
  }
  for (let r = 1; r <= d; r++) {
    for (let j = d; j >= r; j--) {
      const i     = span - d + j;
      const denom = knots[i + d - r + 1] - knots[i];
      const alpha = denom === 0 ? 0 : (ct - knots[i]) / denom;
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

export function getBounds(entities) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function addPt(x, y) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  for (const e of entities) {
    if      (e.type === 'line')     { addPt(e.start.x, e.start.y); addPt(e.end.x, e.end.y); }
    else if (e.type === 'circle')   { addPt(e.center.x - e.radius, e.center.y - e.radius); addPt(e.center.x + e.radius, e.center.y + e.radius); }
    else if (e.type === 'arc')      { addPt(e.center.x - e.radius, e.center.y - e.radius); addPt(e.center.x + e.radius, e.center.y + e.radius); }
    else if (e.type === 'polyline') { for (const v of e.vertices) addPt(v.x, v.y); }
  }
  if (!isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100, width: 200, height: 200 };
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
