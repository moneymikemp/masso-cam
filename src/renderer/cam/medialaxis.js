// Phase 1: Medial axis skeleton extraction via iterative Clipper erosion.
//
// Theory: as we erode the valid material region inward step-by-step, the
// last moment a sub-region exists is its medial axis depth.  We detect two
// topological events by watching path-count changes between consecutive steps:
//
//   terminal — an isolated sub-path vanishes (collapse)
//   junction — a single sub-path becomes 2+ paths (pinch / split)
//
// Hole boundaries are tracked as separate CCW paths alongside outer boundaries.
// Greedy nearest-bbox-center matching between consecutive steps identifies
// which path continued, split, or terminated.

import {
  offsetPolyline,
  differencePolygons,
  isClockwise,
  stripClose,
} from './offset.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

function vertexCenter(pts) {
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  return { x: sx / pts.length, y: sy / pts.length };
}

function bboxCenter(pts) {
  let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function dist2(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

// Compute all flat CCW path segments of the valid material region at erosion d.
// Outer shrinks inward; each hole expands outward; their difference is returned
// as a flat array of CCW paths (Clipper1 cannot give a PolyTree, so outer ring
// and hole boundaries are returned as separate CCW paths).
function computeValidPaths(outer, holes, d) {
  const shrunkOuter = offsetPolyline(outer, d, true);
  if (!shrunkOuter?.length) return [];

  const validOuter = shrunkOuter.filter(r => r?.length >= 3);
  if (!validOuter.length) return [];

  if (!holes?.length) return validOuter;

  const expandedHoles = holes
    .flatMap(h => offsetPolyline(h, -d, true))
    .filter(r => r?.length >= 3);

  if (!expandedHoles.length) return validOuter;

  const result = [];
  for (const outerComp of validOuter) {
    const parts = differencePolygons(outerComp, expandedHoles);
    for (const part of parts) {
      if (part?.length >= 3) result.push(part);
    }
  }
  return result;
}

// Greedy nearest-center matching: assign each prev to its nearest unmatched cur.
// Returns prevMatch[pi] = ci index, or -1 if no cur was available (terminal).
// Unmatched curs (no prev claimed them) are returned as orphanCurs[].
function greedyMatch(prevCenters, curCenters) {
  const claimed = new Set();
  const prevMatch = new Array(prevCenters.length).fill(-1);

  for (let pi = 0; pi < prevCenters.length; pi++) {
    let best = -1, bestD = Infinity;
    for (let ci = 0; ci < curCenters.length; ci++) {
      if (claimed.has(ci)) continue;
      const d = dist2(prevCenters[pi], curCenters[ci]);
      if (d < bestD) { bestD = d; best = ci; }
    }
    prevMatch[pi] = best;
    if (best >= 0) claimed.add(best);
  }

  const orphanCurs = [];
  for (let ci = 0; ci < curCenters.length; ci++) {
    if (!claimed.has(ci)) orphanCurs.push(ci);
  }

  return { prevMatch, orphanCurs };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract raw skeleton nodes for one shape (outer boundary + optional holes).
 *
 * @param {Array<{x,y}>} outerPolygon  CCW or CW — normalized internally
 * @param {Array<Array<{x,y}>} innerHoles  hole boundaries (any winding)
 * @param {object} config
 *   stepSize       mm per erosion step (default 0.05)
 *   bitHalfAngleDeg  V-bit half-angle in degrees (default 45)
 *   maxSteps       safety cap on iterations (default 3000)
 * @returns {Array<{x,y,z,eventType}>}
 */
export function extractRawSkeletonPoints(outerPolygon, innerHoles = [], config = {}) {
  const {
    stepSize = 0.05,
    bitHalfAngleDeg = 45,
    maxSteps = 3000,
  } = config;

  const tanAngle = Math.tan(bitHalfAngleDeg * Math.PI / 180);
  const nodes = [];

  // Normalize windings: outer CCW, holes CCW (offsetPolyline uses sign of distance
  // to choose direction — CCW + negative distance = expand outward for holes).
  const outer = isClockwise(outerPolygon) ? [...outerPolygon].reverse() : outerPolygon;
  const holes = innerHoles.map(h => isClockwise(h) ? [...h].reverse() : h);

  let prevPaths = computeValidPaths(outer, holes, stepSize);
  if (prevPaths.length === 0) return nodes;

  for (let i = 2; i <= maxSteps; i++) {
    const curD = i * stepSize;
    const prevD = (i - 1) * stepSize;
    const curPaths = computeValidPaths(outer, holes, curD);

    if (curPaths.length === 0) {
      // Every remaining path terminated this step.
      for (const p of prevPaths) {
        const c = vertexCenter(p);
        nodes.push({ x: c.x, y: c.y, z: -(prevD / tanAngle), eventType: 'terminal' });
      }
      prevPaths = [];
      break;
    }

    const prevCenters = prevPaths.map(bboxCenter);
    const curCenters  = curPaths.map(bboxCenter);

    if (curPaths.length !== prevPaths.length) {
      const { prevMatch, orphanCurs } = greedyMatch(prevCenters, curCenters);

      // Prev paths with no matching cur → terminal collapse.
      for (let pi = 0; pi < prevPaths.length; pi++) {
        if (prevMatch[pi] < 0) {
          const c = vertexCenter(prevPaths[pi]);
          nodes.push({ x: c.x, y: c.y, z: -(prevD / tanAngle), eventType: 'terminal' });
        }
      }

      // Orphan cur paths (no prev claimed them) → split from their nearest prev → junction.
      for (const ci of orphanCurs) {
        let bestPi = 0, bestD = dist2(curCenters[ci], prevCenters[0]);
        for (let pi = 1; pi < prevCenters.length; pi++) {
          const d = dist2(curCenters[ci], prevCenters[pi]);
          if (d < bestD) { bestD = d; bestPi = pi; }
        }
        const c = vertexCenter(prevPaths[bestPi]);
        nodes.push({ x: c.x, y: c.y, z: -(prevD / tanAngle), eventType: 'junction' });
      }
    } else {
      // Same path count — check for a silent pinch event: a waist within a single connected
      // region collapses (stem of a T, serif foot, etc.) without changing path count.
      // Signature: the matched bbox center jumps much farther than smooth erosion would move it.
      const jumpThresh = (20 * stepSize) ** 2;
      for (let pi = 0; pi < prevPaths.length; pi++) {
        let best = 0, bestD2 = dist2(prevCenters[pi], curCenters[0]);
        for (let ci = 1; ci < curCenters.length; ci++) {
          const d2 = dist2(prevCenters[pi], curCenters[ci]);
          if (d2 < bestD2) { bestD2 = d2; best = ci; }
        }
        if (bestD2 > jumpThresh) {
          const c = vertexCenter(prevPaths[pi]);
          nodes.push({ x: c.x, y: c.y, z: -(prevD / tanAngle), eventType: 'junction' });
        }
      }
    }

    prevPaths = curPaths;
  }

  // If loop completed without full collapse, emit remaining paths as terminals.
  for (const p of prevPaths) {
    const c = vertexCenter(p);
    nodes.push({ x: c.x, y: c.y, z: -(maxSteps * stepSize / tanAngle), eventType: 'terminal' });
  }

  return nodes;
}

/**
 * Convenience wrapper: extract skeleton nodes for all shape groups in a V-carve
 * operation, handling multiple letters / islands automatically.
 *
 * @param {Array<{outer, holes}>} shapeGroups
 * @param {object} config  passed through to extractRawSkeletonPoints
 * @returns {Array<{x,y,z,eventType}>}
 */
export function extractSkeletonForGroups(shapeGroups, config = {}) {
  const allNodes = [];
  for (const { outer, holes } of shapeGroups) {
    const pts = extractRawSkeletonPoints(outer, holes ?? [], config);
    for (const n of pts) allNodes.push(n);
  }
  return allNodes;
}
