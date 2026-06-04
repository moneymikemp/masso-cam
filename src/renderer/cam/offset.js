// Geometry offset engine
// Used for tool radius compensation (inside/outside contour offset)
// and pocket clearing stepover calculations

const CLIPPER_SCALE = 1000;

export function offsetPolyline(points, distance, closed = true, joinType = 'miter') {
  // Scale up for integer math
  const scaled = points.map(p => ({ X: Math.round(p.x * CLIPPER_SCALE), Y: Math.round(p.y * CLIPPER_SCALE) }));
  const offsetDist = distance * CLIPPER_SCALE;

  try {
    if (window.ClipperLib) {
      return clipperOffset(scaled, offsetDist, closed, joinType);
    }
  } catch (e) {}

  // Fallback: simple geometric offset
  return simpleOffset(points, distance, closed);
}

function clipperOffset(scaledPts, offsetDist, closed, joinType) {
  const ClipperLib = window.ClipperLib;
  const co = new ClipperLib.ClipperOffset(2, 0.25);
  const joinTypeMap = { miter: ClipperLib.JoinType.jtMiter, round: ClipperLib.JoinType.jtRound, square: ClipperLib.JoinType.jtSquare };
  const endType = closed ? ClipperLib.EndType.etClosedPolygon : ClipperLib.EndType.etOpenButt;

  co.AddPath(scaledPts, joinTypeMap[joinType] || ClipperLib.JoinType.jtMiter, endType);
  const solution = new ClipperLib.Paths();
  co.Execute(solution, offsetDist);

  return solution.map(path =>
    path.map(pt => ({ x: pt.X / CLIPPER_SCALE, y: pt.Y / CLIPPER_SCALE }))
  );
}

function simpleOffset(points, distance, closed) {
  if (points.length < 2) return [points];
  const result = [];

  for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = -dy / len * distance;
    const ny = dx / len * distance;

    if (i === 0) result.push({ x: p1.x + nx, y: p1.y + ny });
    else {
      const prev = points[i - 1];
      const pdx = p1.x - prev.x;
      const pdy = p1.y - prev.y;
      const plen = Math.hypot(pdx, pdy);
      if (plen > 1e-9) {
        const pnx = -pdy / plen * distance;
        const pny = pdx / plen * distance;
        const bx = (nx + pnx) / 2;
        const by = (ny + pny) / 2;
        const blen = Math.hypot(bx, by);
        const scale = blen > 1e-9 ? (distance / blen) : 1;
        result.push({ x: p1.x + bx * scale, y: p1.y + by * scale });
      }
    }
  }
  if (closed && result.length > 0) result.push({ ...result[0] });
  return [result];
}

export function isClockwise(points) {
  let sum = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i], p2 = points[i + 1];
    sum += (p2.x - p1.x) * (p2.y + p1.y);
  }
  return sum > 0;
}

export function ensureWinding(points, clockwise) {
  const cw = isClockwise(points);
  if (cw !== clockwise) return [...points].reverse();
  return points;
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if (((yi > point.y) !== (yj > point.y)) && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

export function polygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return Math.abs(area / 2);
}

export function closestPointOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

// Generate concentric pocket passes via repeated inward offset
export function generatePocketOffsets(outerPoints, toolRadius, stepover, islands = []) {
  const passes = [];
  let current = [outerPoints];
  const step = toolRadius * 2 * stepover;

  for (let pass = 0; pass < 500; pass++) {
    if (!current || current.length === 0) break;
    const next = [];
    for (const poly of current) {
      if (poly.length < 3) continue;
      const offsets = offsetPolyline(poly, -step, true, 'miter');
      for (const o of offsets) {
        if (o.length >= 3 && polygonArea(o) > step * step * 0.1) {
          next.push(o);
        }
      }
    }
    if (next.length === 0) break;
    passes.push(...next);
    current = next;
  }
  return passes;
}

// Generate zig-zag raster passes for face milling
export function generateRasterPasses(bounds, angle, stepover, toolRadius) {
  const { minX, minY, maxX, maxY } = bounds;
  const step = toolRadius * 2 * stepover;
  const passes = [];
  const rad = angle * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);

  // Extend bounds for rotated passes
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const w = (maxX - minX) / 2 + toolRadius * 2;
  const h = (maxY - minY) / 2 + toolRadius * 2;
  const r = Math.hypot(w, h);

  let y = -r;
  let dir = 1;
  while (y <= r) {
    const px1 = -r * cos - y * sin + cx;
    const py1 = -r * sin + y * cos + cy;
    const px2 = r * cos - y * sin + cx;
    const py2 = r * sin + y * cos + cy;
    passes.push(dir > 0 ? [{ x: px1, y: py1 }, { x: px2, y: py2 }] : [{ x: px2, y: py2 }, { x: px1, y: py1 }]);
    y += step;
    dir = -dir;
  }
  return passes;
}
