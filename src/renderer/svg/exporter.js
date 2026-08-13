// SVG exporter — inverse of svg/parser.js. Coordinates are in millimetres; since
// this app treats Y as pointing up (like DXF) and SVG's Y axis points down, every
// output coordinate is Y-negated here, mirroring the flip svg/parser.js applies on
// import.
//
// Arc/bulge sweep-flag note: this app's arcs/bulges use the CCW-from-start-to-end
// convention (see dxf/parser.js arcToPoints/bulgeToPts). Negating Y reverses the
// apparent rotational sense, so a CCW arc here always maps to SVG sweep-flag 0
// (positive bulge too, since positive bulge = CCW); CW maps to sweep-flag 1.

import { entitiesToSegments } from '../dxf/parser';
import { collectTextContours } from '../dxf/exporter';

// getBounds() only looks at raw vertices, so a bulge arc that sags past its
// vertices would get clipped by the viewBox — walk the actual rendered points
// (bulge arcs included) instead.
function tightBounds(entities) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function addPt(x, y) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  // entitiesToSegments doesn't handle the native 'ellipse' entity type, so sample
  // it directly here to keep it out of the viewBox-clipping trap too.
  for (const e of entities) {
    if (e.type !== 'ellipse') continue;
    const { center, rx, ry, rotation: erot = 0 } = e;
    const cos = Math.cos(erot), sin = Math.sin(erot);
    for (let i = 0; i < 64; i++) {
      const t = (i / 64) * 2 * Math.PI;
      const lx = rx * Math.cos(t), ly = ry * Math.sin(t);
      addPt(center.x + lx * cos - ly * sin, center.y + lx * sin + ly * cos);
    }
  }
  for (const seg of entitiesToSegments(entities)) {
    for (const p of seg.points) addPt(p.x, p.y);
  }
  if (!isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100, width: 200, height: 200 };
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function fmt(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '0';
  return parseFloat(n.toFixed(4)).toString();
}

function contourToPathD(vertices, closed) {
  if (!vertices || vertices.length === 0) return '';
  const pts = vertices;
  let d = `M ${fmt(pts[0].x)} ${fmt(-pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1], cur = pts[i];
    if (prev.bulge) {
      const angle = 4 * Math.atan(Math.abs(prev.bulge));
      const dist = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      if (dist < 1e-9) continue;
      const r = dist / (2 * Math.sin(angle / 2));
      const largeArc = angle > Math.PI ? 1 : 0;
      const sweep = prev.bulge > 0 ? 0 : 1;
      d += ` A ${fmt(r)} ${fmt(r)} 0 ${largeArc} ${sweep} ${fmt(cur.x)} ${fmt(-cur.y)}`;
    } else {
      d += ` L ${fmt(cur.x)} ${fmt(-cur.y)}`;
    }
  }
  if (closed) {
    const last = pts[pts.length - 1], first = pts[0];
    if (last.bulge) {
      const angle = 4 * Math.atan(Math.abs(last.bulge));
      const dist = Math.hypot(first.x - last.x, first.y - last.y);
      if (dist >= 1e-9) {
        const r = dist / (2 * Math.sin(angle / 2));
        const largeArc = angle > Math.PI ? 1 : 0;
        const sweep = last.bulge > 0 ? 0 : 1;
        d += ` A ${fmt(r)} ${fmt(r)} 0 ${largeArc} ${sweep} ${fmt(first.x)} ${fmt(-first.y)}`;
      }
    }
    d += ' Z';
  }
  return d;
}

function circleArcPathD(center, r, startAngle, endAngle) {
  let end = endAngle;
  if (end <= startAngle) end += Math.PI * 2;
  const span = end - startAngle;
  const p1 = { x: center.x + r * Math.cos(startAngle), y: center.y + r * Math.sin(startAngle) };
  const p2 = { x: center.x + r * Math.cos(endAngle), y: center.y + r * Math.sin(endAngle) };
  const largeArc = span > Math.PI ? 1 : 0;
  return `M ${fmt(p1.x)} ${fmt(-p1.y)} A ${fmt(r)} ${fmt(r)} 0 ${largeArc} 0 ${fmt(p2.x)} ${fmt(-p2.y)}`;
}

export function exportSvg(entities, layers, operations) {
  const bounds = tightBounds(entities);
  const { minX, maxY, width, height } = bounds;
  const w = width > 0 ? width : 1;
  const h = height > 0 ? height : 1;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" ` +
    `viewBox="${fmt(minX)} ${fmt(-maxY)} ${fmt(w)} ${fmt(h)}">`
  );

  const byLayer = new Map();
  for (const e of entities) {
    const layer = e.layer || '0';
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer).push(e);
  }

  for (const [layerName, layerEntities] of byLayer) {
    const layerInfo = layers?.[layerName];
    const stroke = layerInfo?.color || '#000000';
    parts.push(`  <g id="${escapeAttr(layerName)}" stroke="${stroke}" fill="none" stroke-width="0.1">`);
    for (const e of layerEntities) {
      switch (e.type) {
        case 'line':
          parts.push(`    <line x1="${fmt(e.start.x)}" y1="${fmt(-e.start.y)}" x2="${fmt(e.end.x)}" y2="${fmt(-e.end.y)}"/>`);
          break;
        case 'circle':
          parts.push(`    <circle cx="${fmt(e.center.x)}" cy="${fmt(-e.center.y)}" r="${fmt(e.radius)}"/>`);
          break;
        case 'arc':
          parts.push(`    <path d="${circleArcPathD(e.center, e.radius, e.startAngle, e.endAngle)}"/>`);
          break;
        case 'polyline': {
          const d = contourToPathD(e.vertices, e.closed);
          if (d) parts.push(`    <path d="${d}"/>`);
          break;
        }
        case 'ellipse': {
          const { center, rx, ry, rotation: erot = 0 } = e;
          const cos = Math.cos(erot), sin = Math.sin(erot);
          const pts = Array.from({ length: 64 }, (_, i) => {
            const t = (i / 64) * 2 * Math.PI;
            const lx = rx * Math.cos(t), ly = ry * Math.sin(t);
            return { x: center.x + lx * cos - ly * sin, y: center.y + lx * sin + ly * cos, bulge: 0 };
          });
          const d = contourToPathD(pts, true);
          if (d) parts.push(`    <path d="${d}"/>`);
          break;
        }
        default: break;
      }
    }
    parts.push('  </g>');
  }

  const textContours = collectTextContours(operations);
  if (textContours.length > 0) {
    parts.push('  <g id="TEXT" stroke="#00ffff" fill="none" stroke-width="0.1">');
    for (const contour of textContours) {
      const d = contourToPathD(contour.vertices, contour.closed);
      if (d) parts.push(`    <path d="${d}"/>`);
    }
    parts.push('  </g>');
  }

  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
