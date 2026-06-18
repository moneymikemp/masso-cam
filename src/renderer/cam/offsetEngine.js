// Geometry engine: offset, translate, rotate entities.

export function translateEntity(entity, dx, dy) {
  const pt = p => ({ x: p.x + dx, y: p.y + dy });
  switch (entity.type) {
    case 'line':     return { ...entity, start: pt(entity.start), end: pt(entity.end) };
    case 'circle':   return { ...entity, center: pt(entity.center) };
    case 'arc':      return { ...entity, center: pt(entity.center) };
    case 'polyline': return { ...entity, vertices: (entity.vertices||[]).map(pt) };
    default: return entity;
  }
}

export function rotateEntityAround(entity, cx, cy, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const pt = p => {
    const rx = p.x - cx, ry = p.y - cy;
    return { x: cx + rx*cos - ry*sin, y: cy + rx*sin + ry*cos };
  };
  switch (entity.type) {
    case 'line':     return { ...entity, start: pt(entity.start), end: pt(entity.end) };
    case 'circle':   return { ...entity, center: pt(entity.center) };
    case 'arc':      return { ...entity, center: pt(entity.center), startAngle: entity.startAngle + angle, endAngle: entity.endAngle + angle };
    case 'polyline': return { ...entity, vertices: (entity.vertices||[]).map(pt) };
    default: return entity;
  }
}

export function entityBoundingBox(entity) {
  switch (entity.type) {
    case 'line':     return { minX: Math.min(entity.start.x, entity.end.x), maxX: Math.max(entity.start.x, entity.end.x), minY: Math.min(entity.start.y, entity.end.y), maxY: Math.max(entity.start.y, entity.end.y) };
    case 'circle':   return { minX: entity.center.x - entity.radius, maxX: entity.center.x + entity.radius, minY: entity.center.y - entity.radius, maxY: entity.center.y + entity.radius };
    case 'arc':      return { minX: entity.center.x - entity.radius, maxX: entity.center.x + entity.radius, minY: entity.center.y - entity.radius, maxY: entity.center.y + entity.radius };
    case 'polyline': {
      const xs = (entity.vertices||[]).map(v => v.x), ys = (entity.vertices||[]).map(v => v.y);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    }
    default: return null;
  }
}

export function selectionBoundingBox(entities, ids) {
  let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity, found=false;
  for (const e of entities) {
    if (!ids.includes(e.id)) continue;
    const b = entityBoundingBox(e); if (!b) continue;
    found = true;
    if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX;
    if (b.minY < minY) minY = b.minY; if (b.maxY > maxY) maxY = b.maxY;
  }
  return found ? { minX, maxX, minY, maxY } : null;
}

function segOffset(a, b, d) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const nx = -dy / len * d, ny = dx / len * d;
  return { p1: { x: a.x + nx, y: a.y + ny }, p2: { x: b.x + nx, y: b.y + ny } };
}

function segIntersect(s1, s2) {
  const d1x = s1.p2.x - s1.p1.x, d1y = s1.p2.y - s1.p1.y;
  const d2x = s2.p2.x - s2.p1.x, d2y = s2.p2.y - s2.p1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((s2.p1.x - s1.p1.x) * d2y - (s2.p1.y - s1.p1.y) * d2x) / denom;
  return { x: s1.p1.x + t * d1x, y: s1.p1.y + t * d1y };
}

export function offsetEntity(entity, distance) {
  switch (entity.type) {
    case 'line': {
      const s = segOffset(entity.start, entity.end, distance);
      return s ? { ...entity, start: s.p1, end: s.p2 } : null;
    }
    case 'circle': {
      const r = entity.radius + distance;
      return r > 0.001 ? { ...entity, radius: r } : null;
    }
    case 'arc': {
      const r = entity.radius + distance;
      return r > 0.001 ? { ...entity, radius: r } : null;
    }
    case 'polyline': {
      const verts = entity.vertices || [];
      if (verts.length < 2) return null;
      const closed = entity.closed;
      const n = verts.length;
      const segCount = closed ? n : n - 1;
      const segs = [];
      for (let i = 0; i < segCount; i++) {
        const s = segOffset(verts[i], verts[(i+1) % n], distance);
        if (s) segs.push(s);
      }
      if (!segs.length) return null;
      const newVerts = [];
      if (!closed) newVerts.push(segs[0].p1);
      for (let i = 0; i < segs.length; i++) {
        const ni = (i + 1) % segs.length;
        if (!closed && i === segs.length - 1) { newVerts.push(segs[i].p2); break; }
        const pt = segIntersect(segs[i], segs[ni]);
        newVerts.push(pt ?? { x: (segs[i].p2.x + segs[ni].p1.x) / 2, y: (segs[i].p2.y + segs[ni].p1.y) / 2 });
      }
      return newVerts.length >= 2 ? { ...entity, vertices: newVerts } : null;
    }
    default: return null;
  }
}
