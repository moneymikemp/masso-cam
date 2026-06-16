// Outside-In Constant-Step V-Carve Layering.
//
// Steps from Z=0 (outermost/shallowest) downward to maximum pocket depth.
// At each depth Z, the required inward offset R = |Z| × tan(bitHalfAngleDeg)
// is fed to Clipper, which returns exactly the paths where the tool center can
// safely travel without gouging any wall.  Narrow sections that cannot fit the
// bit at that depth naturally vanish — no skeleton or collision detection needed.
//
// Pipeline:
//   computeValidPaths      — Clipper inward offset at each depth step
//   computeVCarveToolpath  — depth loop + closest-point ring entry ordering
//   generateGCode          — one closed ring per depth layer, Z constant per ring

import {
  offsetPolyline,
  differencePolygons,
  isClockwise,
} from './offset.js';

// ── Geometry helpers ──────────────────────────────────────────────────────────

function dist2(a, b) { return (a.x - b.x) ** 2 + (a.y - b.y) ** 2; }

function closestPointIdx(pts, target) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = dist2(pts[i], target);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ── Offset helper ─────────────────────────────────────────────────────────────

// Returns valid tool-center paths at inward offset R.
// Outer polygon shrinks inward by R; holes expand outward by R.
// Clipper naturally removes any region too narrow for the bit at this depth.
function computeValidPaths(outer, holes, R) {
  const so = offsetPolyline(outer, R, true);
  if (!so?.length) return [];
  const vo = so.filter(r => r?.length >= 3);
  if (!vo.length) return [];
  if (!holes?.length) return vo;
  const eh = holes.flatMap(h => offsetPolyline(h, -R, true)).filter(r => r?.length >= 3);
  if (!eh.length) return vo;
  const res = [];
  for (const oc of vo) {
    for (const p of differencePolygons(oc, eh)) if (p?.length >= 3) res.push(p);
  }
  return res;
}

// ── G-code generation ─────────────────────────────────────────────────────────

export function generateGCode(segments, config) {
  const {
    safeZ      = 5.0,
    feedRate   = 1499,
    plungeRate = 305,
    spindleRPM = 18000,
  } = config;
  const fmt = v => v.toFixed(4);
  const lines = [
    '; V-Carve — MassoCAM Outside-In Layering',
    'G21',
    'G90',
    `S${spindleRPM} M03`,
    `G00 Z${fmt(safeZ)}`,
  ];

  for (const seg of segments) {
    if (seg.length < 2) continue;
    lines.push(`G00 X${fmt(seg[0].x)} Y${fmt(seg[0].y)}`);
    lines.push(`G01 Z${fmt(seg[0].z)} F${plungeRate}`);
    // Z is constant within a ring — omit it after the plunge line.
    for (let i = 1; i < seg.length; i++) {
      lines.push(`G01 X${fmt(seg[i].x)} Y${fmt(seg[i].y)} F${feedRate}`);
    }
    lines.push(`G00 Z${fmt(safeZ)}`);
  }

  lines.push('M05', 'M30');
  return lines.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

export function computeVCarveToolpath(outerPolygon, innerHoles = [], config = {}) {
  const {
    depthStep       = 0.1,
    maxDepth        = 25.0,
    bitHalfAngleDeg = 45,
    safeZ           = 5.0,
    feedRate        = 1499,
    plungeRate      = 305,
    spindleRPM      = 18000,
  } = config;

  const tanAngle = Math.tan(bitHalfAngleDeg * Math.PI / 180);
  const outer = isClockwise(outerPolygon) ? [...outerPolygon].reverse() : outerPolygon;
  const holes = innerHoles.map(h => isClockwise(h) ? [...h].reverse() : h);

  // Accumulate layers shallowest-first (conventional CNC order: outer edges cut
  // first so an aborted job still leaves the perimeter correctly profiled).
  const layers = [];
  const maxSteps = Math.ceil(maxDepth / depthStep);
  for (let i = 1; i <= maxSteps; i++) {
    const z = -(i * depthStep);
    const R = Math.abs(z) * tanAngle;
    const paths = computeValidPaths(outer, holes, R);
    if (!paths.length) break; // geometry exhausted — no more material at this depth
    layers.push({ z, paths });
  }

  // Build ordered toolpath segments.
  // Each segment is one closed ring cut at a constant Z depth.
  // The ring entry point is chosen to be the XY position closest to where the
  // previous ring ended, minimising rapid travel between depth layers.
  const segments = [];
  let lastPt = null;

  for (const { z, paths } of layers) {
    const orderedPaths = lastPt
      ? [...paths].sort((a, b) => {
          const da = Math.min(...a.map(p => dist2(p, lastPt)));
          const db = Math.min(...b.map(p => dist2(p, lastPt)));
          return da - db;
        })
      : paths;

    for (const path of orderedPaths) {
      const startIdx = lastPt ? closestPointIdx(path, lastPt) : 0;
      const rotated = startIdx === 0
        ? path
        : [...path.slice(startIdx), ...path.slice(0, startIdx)];
      const seg = rotated.map(p => ({ x: p.x, y: p.y, z }));
      seg.push({ ...seg[0] }); // close ring — tool returns to entry point
      segments.push(seg);
      lastPt = seg[0]; // ring is closed; tool ends at entry point
    }
  }

  const gcode = generateGCode(segments, { safeZ, feedRate, plungeRate, spindleRPM });
  return { layers, segments, gcode };
}
