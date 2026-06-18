// DXF R12 (AC1009) exporter.
// Produces a file compatible with AutoCAD R12 and all modern CAD applications.
// All coordinates are in millimetres. Angles are decimal degrees CCW from +X.

function fmt(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '0';
  return parseFloat(n.toFixed(6)).toString();
}

function radToDeg(r) {
  let d = (r * 180 / Math.PI) % 360;
  if (d < 0) d += 360;
  return d;
}

// Map a CSS hex colour to the nearest AutoCAD Colour Index (ACI 1–7).
function hexToAci(hex) {
  if (!hex || typeof hex !== 'string') return 7;
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  const palette = [
    [1, 255,   0,   0],
    [2, 255, 255,   0],
    [3,   0, 255,   0],
    [4,   0, 255, 255],
    [5,   0,   0, 255],
    [6, 255,   0, 255],
    [7, 255, 255, 255],
  ];
  let best = 7, bestDist = Infinity;
  for (const [idx, cr, cg, cb] of palette) {
    const d = Math.sqrt((r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2);
    if (d < bestDist) { bestDist = d; best = idx; }
  }
  return best;
}

// Flatten text operation contours into a list of absolute-coordinate polyline records.
function collectTextContours(operations) {
  const contours = [];
  for (const op of (operations || [])) {
    if (op.type !== 'text' || !op.enabled) continue;
    const { textContoursRel, textX = 0, textY = 0 } = op.params || {};
    if (!textContoursRel?.length) continue;
    for (const group of textContoursRel) {
      for (const contour of group) {
        if (!contour?.length) continue;
        contours.push(contour.map(pt => ({ x: pt.x + textX, y: pt.y + textY })));
      }
    }
  }
  return contours;
}

export function exportDxf(entities, layers, operations) {
  const lines = [];
  const w = (code, val) => { lines.push(String(code), String(val)); };

  // ── HEADER ────────────────────────────────────────────────────────────────
  w(0, 'SECTION'); w(2, 'HEADER');
  w(9, '$ACADVER'); w(1, 'AC1009');
  w(9, '$EXTMIN'); w(10, '0.0'); w(20, '0.0'); w(30, '0.0');
  w(9, '$EXTMAX'); w(10, '1000.0'); w(20, '1000.0'); w(30, '0.0');
  w(0, 'ENDSEC');

  // ── TABLES ────────────────────────────────────────────────────────────────
  const textContours = collectTextContours(operations);

  const usedLayerNames = [...new Set(entities.map(e => e.layer || '0'))];
  if (!usedLayerNames.includes('0')) usedLayerNames.unshift('0');
  if (textContours.length > 0 && !usedLayerNames.includes('TEXT')) usedLayerNames.push('TEXT');

  w(0, 'SECTION'); w(2, 'TABLES');

  // LTYPE table — define CONTINUOUS so LAYER entries can reference it
  w(0, 'TABLE'); w(2, 'LTYPE'); w(70, 1);
  w(0, 'LTYPE'); w(2, 'CONTINUOUS'); w(70, 0);
  w(3, 'Solid line'); w(72, 65); w(73, 0); w(40, '0.0');
  w(0, 'ENDTAB');

  // LAYER table
  w(0, 'TABLE'); w(2, 'LAYER'); w(70, usedLayerNames.length);
  for (const name of usedLayerNames) {
    const layer = layers?.[name];
    // TEXT layer has no entry in layers{} — use cyan (4) to distinguish it
    const color = name === 'TEXT' ? 4 : layer ? hexToAci(layer.color) : 7;
    w(0, 'LAYER');
    w(2, name);
    w(70, 0);       // flags: on, not frozen, not locked
    w(62, color);   // ACI colour
    w(6, 'CONTINUOUS');
  }
  w(0, 'ENDTAB');

  w(0, 'ENDSEC');

  // ── ENTITIES ──────────────────────────────────────────────────────────────
  w(0, 'SECTION'); w(2, 'ENTITIES');

  for (const e of entities) {
    const layer = e.layer || '0';
    switch (e.type) {
      case 'line':
        w(0, 'LINE'); w(8, layer);
        w(10, fmt(e.start.x)); w(20, fmt(e.start.y)); w(30, '0.0');
        w(11, fmt(e.end.x));   w(21, fmt(e.end.y));   w(31, '0.0');
        break;

      case 'circle':
        w(0, 'CIRCLE'); w(8, layer);
        w(10, fmt(e.center.x)); w(20, fmt(e.center.y)); w(30, '0.0');
        w(40, fmt(e.radius));
        break;

      case 'arc':
        w(0, 'ARC'); w(8, layer);
        w(10, fmt(e.center.x)); w(20, fmt(e.center.y)); w(30, '0.0');
        w(40, fmt(e.radius));
        w(50, fmt(radToDeg(e.startAngle)));
        w(51, fmt(radToDeg(e.endAngle)));
        break;

      case 'polyline': {
        const flags = e.closed ? 1 : 0;
        w(0, 'POLYLINE'); w(8, layer);
        w(66, 1);                               // vertices-follow flag
        w(10, '0.0'); w(20, '0.0'); w(30, '0.0');
        w(70, flags);
        for (const v of (e.vertices || [])) {
          w(0, 'VERTEX'); w(8, layer);
          w(10, fmt(v.x)); w(20, fmt(v.y)); w(30, '0.0');
        }
        w(0, 'SEQEND'); w(8, layer);
        break;
      }

      default: break;
    }
  }

  // Text engraving contours (absolute coordinates, closed polylines on layer TEXT)
  for (const contour of textContours) {
    w(0, 'POLYLINE'); w(8, 'TEXT');
    w(66, 1); // vertices follow
    w(10, '0.0'); w(20, '0.0'); w(30, '0.0');
    w(70, 1); // closed
    for (const pt of contour) {
      w(0, 'VERTEX'); w(8, 'TEXT');
      w(10, fmt(pt.x)); w(20, fmt(pt.y)); w(30, '0.0');
    }
    w(0, 'SEQEND'); w(8, 'TEXT');
  }

  w(0, 'ENDSEC');
  w(0, 'EOF');

  // Each DXF group code and its value occupy separate lines (CRLF per spec)
  return lines.join('\r\n') + '\r\n';
}
