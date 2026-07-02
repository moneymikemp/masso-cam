// Geometry offset engine
// Uses Clipper (Angus Johnson's polygon clipping library) for all closed-polygon
// offsetting. Clipper correctly handles concave polygons — no spikes at reflex
// corners, and automatically splits shapes that separate under deep inset.

import ClipperLib from 'clipper-lib';

// ── Clipper coordinate helpers ────────────────────────────────────────────────
// Clipper requires integer coordinates. 1 unit = 0.001 mm (micron precision).

const SCALE = 1000;

function toClipper(pts) {
  return pts.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
}

function fromClipper(path) {
  return path.map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));
}

export function stripClose(pts) {
  if (pts.length > 1 &&
      Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y) < 1e-6) {
    return pts.slice(0, -1);
  }
  return pts;
}

// Clip a polygon to a boundary region using Clipper boolean intersection.
// Returns the portion of ringPts that lies inside boundaryPts.
// Both inputs may have or omit a closing point — stripClose is applied internally.
// Returns an array of polygons (WITHOUT closing point, CCW-normalised).
export function clipPolygonToRegion(ringPts, boundaryPts) {
  const ring  = stripClose([...ringPts]);
  const bound = stripClose([...boundaryPts]);
  if (ring.length < 3 || bound.length < 3) return [];
  const c = new ClipperLib.Clipper();
  c.AddPath(toClipper(ring),  ClipperLib.PolyType.ptSubject, true);
  c.AddPath(toClipper(bound), ClipperLib.PolyType.ptClip,    true);
  const solution = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctIntersection, solution);
  return solution
    .map(fromClipper)
    .filter(p => p.length >= 3)
    .map(p => isClockwise(p) ? [...p].reverse() : p);
}

// Subtract clipPaths from subjectPts using Clipper boolean difference.
// Returns array of CCW polygons representing subject MINUS all clipPaths.
// Hole boundaries in Clipper output (CW) are reversed to CCW so callers can
// iterate all results uniformly — each is a valid ring to trace.
export function differencePolygons(subjectPts, clipPtsList) {
  const subject = stripClose([...subjectPts]);
  if (subject.length < 3) return [];
  const c = new ClipperLib.Clipper();
  c.AddPath(toClipper(subject), ClipperLib.PolyType.ptSubject, true);
  for (const clipPts of clipPtsList) {
    const clip = stripClose([...clipPts]);
    if (clip.length >= 3) c.AddPath(toClipper(clip), ClipperLib.PolyType.ptClip, true);
  }
  const solution = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctDifference, solution);
  return solution
    .map(fromClipper)
    .filter(p => p.length >= 3)
    .map(p => isClockwise(p) ? [...p].reverse() : p);
}

// Union of multiple polygons. Returns array of CCW result polygons.
export function unionPolygons(ptsList) {
  const clean = ptsList.map(p => stripClose([...p])).filter(p => p.length >= 3);
  if (!clean.length) return [];
  const c = new ClipperLib.Clipper();
  for (const pts of clean) c.AddPath(toClipper(pts), ClipperLib.PolyType.ptSubject, true);
  const solution = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return solution.map(fromClipper).filter(p => p.length >= 3).map(p => isClockwise(p) ? [...p].reverse() : p);
}

// Intersection of all polygons. Returns array of CCW result polygons.
export function intersectPolygons(ptsList) {
  const clean = ptsList.map(p => stripClose([...p])).filter(p => p.length >= 3);
  if (clean.length < 2) return clean;
  const c = new ClipperLib.Clipper();
  c.AddPath(toClipper(clean[0]), ClipperLib.PolyType.ptSubject, true);
  for (let i = 1; i < clean.length; i++) c.AddPath(toClipper(clean[i]), ClipperLib.PolyType.ptClip, true);
  const solution = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctIntersection, solution);
  return solution.map(fromClipper).filter(p => p.length >= 3).map(p => isClockwise(p) ? [...p].reverse() : p);
}

// Offset a closed polygon.
// positive distance = shrink inward; negative = expand outward.
// Returns result polygons (CCW, no closing point) sorted by area descending.
// Concave shapes may split into >1 polygon when inset far enough.
function clipperClosedOffset(points, distance) {
  const co = new ClipperLib.ClipperOffset();
  co.AddPath(toClipper(points), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const solution = new ClipperLib.Paths();
  co.Execute(solution, -distance * SCALE);
  return solution
    .map(fromClipper)
    .filter(p => p.length >= 3)
    .map(p => isClockwise(p) ? [...p].reverse() : p)
    .sort((a, b) => polygonArea(b) - polygonArea(a));
}

// ── Public API ────────────────────────────────────────────────────────────────

// Offset a polyline or closed polygon by `distance`.
// For closed paths, returns an array of result polygons (usually one, but may be
// more when a concave shape splits). Callers that handle one polygon use [0].
// For open paths, returns a single offset path.
export function offsetPolyline(points, distance, closed = true) {
  if (!points || points.length < 2) return [points || []];
  if (!closed) return [simpleOpenOffset(points, distance)];

  const pts = stripClose([...points]);
  if (pts.length < 3) return [pts];

  const results = clipperClosedOffset(pts, distance);
  if (!results.length) return [[]];

  // Add closing point to each result to match the pre-existing API contract.
  return results.map(r => [...r, { ...r[0] }]);
}

// Generate concentric pocket clearing passes by repeatedly shrinking the polygon.
// Uses Clipper for each offset step so concave corners are handled correctly.
// When a concave shape splits into sub-polygons, each sub-polygon continues
// shrinking independently — all sub-regions get clearing passes.
//
// When islands are present, uses a contour-following "donut-offset" approach:
// the initial cuttable area (outer MINUS islands) is shrunk by one stepover per
// iteration. Because island boundaries are stored as CW holes in Clipper, the
// negative offset simultaneously shrinks the CCW outer boundary inward AND expands
// the CW island holes outward. Each iteration produces:
//   CCW paths → outer-wall-following passes (same as no-island case)
//   CW paths  → island-wall-following passes (reversed to CCW for the toolpath)
// This matches Fusion 360-style concentric offsets that hug both the outer wall
// and island walls simultaneously.
export function generatePocketOffsets(outerPoints, toolRadius, stepover, islands = []) {
  const passes = [];
  const step = toolRadius * 2 * stepover;

  let outer = stripClose([...outerPoints]);
  if (isClockwise(outer)) outer = [...outer].reverse();
  if (polygonArea(outer) < step * step) return passes;

  if (islands.length === 0) {
    // Simple case: no islands — pure inward spiral.
    let queue = [outer];
    for (let i = 0; i < 200 && queue.length > 0; i++) {
      const nextQueue = [];
      for (const poly of queue) {
        for (const sp of clipperClosedOffset(poly, step)) {
          if (polygonArea(sp) < step * step * 0.5) continue;
          nextQueue.push(sp);
          passes.push([...sp, sp[0]]);
        }
      }
      queue = nextQueue;
    }
    return passes;
  }

  // Islands present: contour-following donut-offset approach.
  // Step 1: compute the cuttable region as outer MINUS island exclusion zones.
  //   Clipper Paths output: CCW paths = outer boundaries, CW paths = island holes.
  const ic = new ClipperLib.Clipper();
  ic.AddPath(toClipper(outer), ClipperLib.PolyType.ptSubject, true);
  for (const isl of islands) {
    const clip = stripClose([...isl]);
    if (clip.length >= 3) ic.AddPath(toClipper(clip), ClipperLib.PolyType.ptClip, true);
  }
  const icPaths = new ClipperLib.Paths();
  ic.Execute(ClipperLib.ClipType.ctDifference, icPaths,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);

  let currentOuters = [];
  let currentHoles = [];
  for (const path of icPaths) {
    const pts = fromClipper(path);
    if (pts.length < 3) continue;
    if (isClockwise(pts)) {
      currentHoles.push(pts);               // CW = island hole
    } else if (polygonArea(pts) >= step * step * 0.5) {
      currentOuters.push(pts);              // CCW = outer boundary
    }
  }
  if (currentOuters.length === 0) return passes;

  // Step 2: repeatedly shrink the outer CCW boundary and expand the CW island holes
  //   by one stepover. ClipperOffset with a negative delta on a set of CCW+CW paths
  //   shrinks CCW (outer) and grows CW (holes) simultaneously, producing passes that
  //   follow both the outer wall and the island walls at each erosion level.
  for (let iter = 0; iter < 200; iter++) {
    if (currentOuters.length === 0) break;

    const co = new ClipperLib.ClipperOffset();
    for (const o of currentOuters) {
      co.AddPath(toClipper(o), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
    }
    for (const h of currentHoles) {
      if (h.length >= 3) {
        co.AddPath(toClipper(h), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
      }
    }

    const solution = new ClipperLib.Paths();
    co.Execute(solution, -step * SCALE);

    const nextOuters = [];
    const nextHoles = [];

    for (const path of solution) {
      const pts = fromClipper(path);
      if (pts.length < 3) continue;
      const area = polygonArea(pts);
      if (area < step * step * 0.5) continue;

      if (isClockwise(pts)) {
        // CW = expanded island hole — save for next iteration AND add as island pass
        nextHoles.push(pts);
        const ccw = [...pts].reverse();
        passes.push([...ccw, ccw[0]]);
      } else {
        // CCW = shrunken outer boundary — save for next iteration AND add as outer pass
        nextOuters.push(pts);
        passes.push([...pts, pts[0]]);
      }
    }

    currentOuters = nextOuters;
    currentHoles = nextHoles;
  }

  return passes;
}

// Generate rest-machining passes: only the strip that the previous (larger) tool
// could not reach but the current (smaller) tool can.
//
//   profile           — raw pocket boundary polygon (closing point optional)
//   currentToolRadius — radius of the current tool
//   previousToolRadius — radius of the previous larger tool whose cleared zone is excluded
//   stepover          — fraction (0–1)
//   islands           — additional exclusion polygons (pocket islands, etc.)
export function generateRestMachiningPasses(profile, currentToolRadius, previousToolRadius, stepover, islands = []) {
  const step = currentToolRadius * 2 * stepover;
  const clean = stripClose([...profile]);

  // Where the current (small) tool's center can reach.
  const currentReach = clipperClosedOffset(clean, currentToolRadius);
  if (!currentReach.length) return [];

  // The previous (large) tool's cleared zone — passes that fall inside are skipped.
  const previousReach = clipperClosedOffset(clean, previousToolRadius);
  const prevExclusions = previousReach.map(p => isClockwise(p) ? [...p].reverse() : p);

  const allIslands = [...islands, ...prevExclusions];
  const passes = [];
  let queue = currentReach.map(p => isClockwise(p) ? [...p].reverse() : p);

  for (let i = 0; i < 200 && queue.length > 0; i++) {
    const nextQueue = [];
    for (const poly of queue) {
      for (const sp of clipperClosedOffset(poly, step)) {
        if (polygonArea(sp) < step * step * 0.5) continue;
        nextQueue.push(sp);
        if (allIslands.length > 0) {
          const dc2 = new ClipperLib.Clipper();
          dc2.AddPath(toClipper(stripClose([...sp])), ClipperLib.PolyType.ptSubject, true);
          for (const isl of allIslands) {
            const clip = stripClose([...isl]);
            if (clip.length >= 3) dc2.AddPath(toClipper(clip), ClipperLib.PolyType.ptClip, true);
          }
          const dcSol2 = new ClipperLib.Paths();
          dc2.Execute(ClipperLib.ClipType.ctDifference, dcSol2,
            ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
          for (const path of dcSol2) {
            const pts = fromClipper(path);
            if (pts.length < 3 || isClockwise(pts)) continue;
            if (polygonArea(pts) >= step * step * 0.5) passes.push([...pts, pts[0]]);
          }
        } else {
          passes.push([...sp, sp[0]]);
        }
      }
    }
    queue = nextQueue;
  }
  return passes;
}

// ── Geometry utilities ────────────────────────────────────────────────────────

export function isClockwise(points) {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += (points[j].x - points[i].x) * (points[j].y + points[i].y);
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

// ── Open-path offset (unchanged) ──────────────────────────────────────────────

function simpleOpenOffset(points, distance) {
  const result = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    let nx, ny;
    if (i === 0) {
      const dx = points[1].x - points[0].x, dy = points[1].y - points[0].y;
      const l = Math.hypot(dx, dy);
      nx = -dy / l; ny = dx / l;
    } else if (i === n - 1) {
      const dx = points[n - 1].x - points[n - 2].x, dy = points[n - 1].y - points[n - 2].y;
      const l = Math.hypot(dx, dy);
      nx = -dy / l; ny = dx / l;
    } else {
      const d1x = points[i].x - points[i - 1].x, d1y = points[i].y - points[i - 1].y;
      const l1 = Math.hypot(d1x, d1y);
      const d2x = points[i + 1].x - points[i].x, d2y = points[i + 1].y - points[i].y;
      const l2 = Math.hypot(d2x, d2y);
      nx = (-d1y / l1 + -d2y / l2) / 2;
      ny = (d1x / l1 + d2x / l2) / 2;
    }
    result.push({ x: points[i].x + nx * distance, y: points[i].y + ny * distance });
  }
  return result;
}
