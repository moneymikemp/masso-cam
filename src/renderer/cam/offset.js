// Geometry offset engine - pure JS, no external dependencies
// Uses normal-based offsetting for convex/simple polygons
// Good enough for 2.5D CAM on typical CNC router geometry

export function offsetPolyline(points, distance, closed = true) {
  if (!points || points.length < 2) return [points || []];
  if (!closed) return [simpleOpenOffset(points, distance)];
  return [simpleClosedOffset(points, distance)];
}

function simpleClosedOffset(points, distance) {
  // Remove duplicate last point if closed
  let pts = [...points];
  if (pts.length > 1) {
    const last = pts[pts.length - 1];
    const first = pts[0];
    if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-6) {
      pts = pts.slice(0, -1);
    }
  }
  if (pts.length < 3) return pts;

  const result = [];
  const n = pts.length;

  for (let i = 0; i < n; i++) {
    const prev = pts[(i + n - 1) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];

    // Inward normal of prev->curr edge
    const d1x = curr.x - prev.x, d1y = curr.y - prev.y;
    const l1 = Math.hypot(d1x, d1y);
    const n1x = -d1y / l1, n1y = d1x / l1;

    // Inward normal of curr->next edge
    const d2x = next.x - curr.x, d2y = next.y - curr.y;
    const l2 = Math.hypot(d2x, d2y);
    const n2x = -d2y / l2, n2y = d2x / l2;

    // Bisector
    let bx = n1x + n2x, by = n1y + n2y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) {
      bx = n1x; by = n1y;
    } else {
      // Scale bisector so offset is correct distance
      const dot = n1x * (bx / bl) + n1y * (by / bl);
      const scale = dot > 0.1 ? distance / dot : distance;
      bx = (bx / bl) * scale;
      by = (by / bl) * scale;
    }

    result.push({ x: curr.x + bx, y: curr.y + by });
  }

  // Close the polygon
  result.push({ ...result[0] });
  return result;
}

function simpleOpenOffset(points, distance) {
  const result = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    let nx, ny;
    if (i === 0) {
      const dx = points[1].x - points[0].x;
      const dy = points[1].y - points[0].y;
      const l = Math.hypot(dx, dy);
      nx = -dy / l; ny = dx / l;
    } else if (i === n - 1) {
      const dx = points[n-1].x - points[n-2].x;
      const dy = points[n-1].y - points[n-2].y;
      const l = Math.hypot(dx, dy);
      nx = -dy / l; ny = dx / l;
    } else {
      const d1x = points[i].x - points[i-1].x, d1y = points[i].y - points[i-1].y;
      const l1 = Math.hypot(d1x, d1y);
      const d2x = points[i+1].x - points[i].x, d2y = points[i+1].y - points[i].y;
      const l2 = Math.hypot(d2x, d2y);
      nx = (-d1y/l1 + -d2y/l2) / 2;
      ny = (d1x/l1 + d2x/l2) / 2;
    }
    result.push({ x: points[i].x + nx * distance, y: points[i].y + ny * distance });
  }
  return result;
}

export function isClockwise(points) {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    sum += (points[i+1].x - points[i].x) * (points[i+1].y + points[i].y);
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
    if (((yi > point.y) !== (yj > point.y)) &&
        (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

export function polygonArea(points) {
  let area = 0;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return Math.abs(area / 2);
}

// Generate concentric pocket passes by repeatedly shrinking the polygon
export function generatePocketOffsets(outerPoints, toolRadius, stepover) {
  const passes = [];
  const step = toolRadius * 2 * stepover;
  
  // Remove closing point if present
  let current = [...outerPoints];
  if (current.length > 1) {
    const last = current[current.length - 1];
    if (Math.hypot(last.x - current[0].x, last.y - current[0].y) < 1e-6) {
      current = current.slice(0, -1);
    }
  }

  const initialArea = polygonArea(current);
  if (initialArea < step * step) return passes;

  // Make sure winding is consistent (CCW for inward offset)
  if (isClockwise(current)) current = current.reverse();

  const MAX_PASSES = 200;

  for (let i = 0; i < MAX_PASSES; i++) {
    // Shrink by one step (positive distance = inward for CCW polygon)
    const shrunk = simpleClosedOffset(current, +step);
    
    if (!shrunk || shrunk.length < 4) break;
    
    const area = polygonArea(shrunk);
    
    // Stop if area is too small or has collapsed
    if (area < step * step * 0.5) break;
    if (area > initialArea * 1.1) break; // Sanity check - area should shrink
    
    // Check for self-intersection collapse by verifying area decreased
    if (i > 0 && area >= polygonArea(current) * 0.98) break;

    passes.push([...shrunk]);
    current = shrunk.slice(0, -1); // Remove closing point for next iteration
  }

  return passes;
}

// Generate zig-zag raster passes for face milling
export function generateRasterPasses(bounds, angle, stepover, toolRadius) {
  const step = toolRadius * 2 * stepover;
  const passes = [];
  const rad = angle * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const w = (bounds.maxX - bounds.minX) / 2 + toolRadius * 2;
  const h = (bounds.maxY - bounds.minY) / 2 + toolRadius * 2;
  const r = Math.hypot(w, h);

  let y = -r, dir = 1;
  while (y <= r) {
    const px1 = -r * cos - y * sin + cx;
    const py1 = -r * sin + y * cos + cy;
    const px2 =  r * cos - y * sin + cx;
    const py2 =  r * sin + y * cos + cy;
    passes.push(dir > 0
      ? [{ x: px1, y: py1 }, { x: px2, y: py2 }]
      : [{ x: px2, y: py2 }, { x: px1, y: py1 }]);
    y += step;
    dir = -dir;
  }
  return passes;
}
