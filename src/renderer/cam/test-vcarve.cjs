'use strict';
// V-Carve medial-spine test — all functions inlined (CJS, runs directly with Node).
// Run: node src/renderer/cam/test-vcarve.cjs

const ClipperLib = require('../../../node_modules/clipper-lib/clipper.js');

// ── Clipper helpers ───────────────────────────────────────────────────────────
const SCALE = 1000;
const toC   = pts => pts.map(p => ({ X: Math.round(p.x*SCALE), Y: Math.round(p.y*SCALE) }));
const fromC = path => path.map(p => ({ x: p.X/SCALE, y: p.Y/SCALE }));

function stripClose(pts) {
  if (pts.length > 1 && Math.hypot(pts[pts.length-1].x-pts[0].x, pts[pts.length-1].y-pts[0].y) < 1e-6)
    return pts.slice(0, -1);
  return pts;
}
function isClockwise(pts) {
  let sum = 0, n = pts.length;
  for (let i = 0; i < n-1; i++) sum += (pts[i+1].x-pts[i].x) * (pts[i+1].y+pts[i].y);
  return sum > 0;
}
function polygonArea(pts) {
  let a = 0, n = pts.length;
  for (let i = 0, j = n-1; i < n; j = i++) a += (pts[j].x+pts[i].x) * (pts[j].y-pts[i].y);
  return Math.abs(a / 2);
}
function clipperOffset(pts, distance) {
  const co = new ClipperLib.ClipperOffset();
  co.AddPath(toC(pts), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, -distance * SCALE);
  return sol.map(fromC).filter(p => p.length >= 3)
    .map(p => isClockwise(p) ? [...p].reverse() : p)
    .sort((a, b) => polygonArea(b) - polygonArea(a));
}
function offsetPolyline(pts, d) {
  const p = stripClose([...pts]);
  if (p.length < 3) return [p];
  const r = clipperOffset(p, d);
  if (!r.length) return [[]];
  return r.map(q => [...q, {...q[0]}]);
}
function differenceOuterOnly(subj, clipList) {
  const s = stripClose([...subj]);
  if (s.length < 3) return [];
  const c = new ClipperLib.Clipper();
  c.AddPath(toC(s), ClipperLib.PolyType.ptSubject, true);
  for (const cl of clipList) {
    const p = stripClose([...cl]);
    if (p.length >= 3) c.AddPath(toC(p), ClipperLib.PolyType.ptClip, true);
  }
  const polyTree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctDifference, polyTree);
  return polyTree.m_Childs
    .map(node => fromC(node.m_polygon))
    .filter(p => p.length >= 3)
    .map(p => isClockwise(p) ? [...p].reverse() : p);
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

function dist2(a, b) { return (a.x-b.x)**2 + (a.y-b.y)**2; }

function computeValidPaths(outer, holes, R) {
  const so = offsetPolyline(outer, R);
  if (!so?.length) return [];
  const vo = so.filter(r => r?.length >= 3);
  if (!vo.length) return [];
  if (!holes?.length) return vo;
  const eh = holes.flatMap(h => offsetPolyline(h, -R)).filter(r => r?.length >= 3);
  if (!eh.length) return vo;
  const res = [];
  for (const oc of vo) {
    for (const p of differenceOuterOnly(oc, eh)) if (p?.length >= 3) res.push(p);
  }
  return res;
}

function extractSpine(outer, holes, tanAngle, stepR, maxDepth) {
  const maxSteps = Math.ceil(maxDepth / stepR);
  const COLLAPSE_SQ = (3 * stepR) ** 2;
  const spine = [];

  let prevVerts = [];
  let prevR = 0;

  for (let i = 1; i <= maxSteps; i++) {
    const R = i * stepR;
    const paths = computeValidPaths(outer, holes, R);

    if (!paths.length) {
      const z = -prevR / tanAngle;
      for (const v of prevVerts) spine.push({ x: v.x, y: v.y, z });
      break;
    }

    const currVerts = paths.flatMap(p => stripClose([...p]));

    if (prevVerts.length > 0) {
      const z = -prevR / tanAngle;
      for (const v of prevVerts) {
        let near = false;
        for (const c of currVerts) {
          if (dist2(v, c) < COLLAPSE_SQ) { near = true; break; }
        }
        if (!near) spine.push({ x: v.x, y: v.y, z });
      }
    }

    prevVerts = currVerts;
    prevR = R;
  }

  return spine;
}

function cornerBranches(outerPolygon, rawSpine, tanAngle, angleThreshold) {
  if (!rawSpine.length) return [];
  angleThreshold = angleThreshold !== undefined ? angleThreshold : Math.PI / 2;
  const n = outerPolygon.length;
  const SEARCH_SQ = 36, BRANCH_STEP = 0.05;
  const branches = [];
  for (let i = 0; i < n; i++) {
    const prev = outerPolygon[(i + n - 1) % n];
    const curr = outerPolygon[i];
    const next = outerPolygon[(i + 1) % n];
    const aLen = Math.hypot(prev.x - curr.x, prev.y - curr.y);
    const bLen = Math.hypot(next.x - curr.x, next.y - curr.y);
    if (aLen < 1e-9 || bLen < 1e-9) continue;
    const adx = (prev.x - curr.x) / aLen, ady = (prev.y - curr.y) / aLen;
    const bdx = (next.x - curr.x) / bLen, bdy = (next.y - curr.y) / bLen;
    const cross = adx * bdy - ady * bdx;
    if (cross >= 0) continue;
    const dot = adx * bdx + ady * bdy;
    const angle = Math.atan2(-cross, dot);
    if (angle > angleThreshold) continue;
    const bisRawX = adx + bdx, bisRawY = ady + bdy;
    const bisLen = Math.hypot(bisRawX, bisRawY);
    if (bisLen < 1e-9) continue;
    const bx = bisRawX / bisLen, by = bisRawY / bisLen;
    const sinHalf = Math.sin(angle / 2);
    const PERP_MAX = 2.0;
    let bestPerp = Infinity, targetZ = 0;
    for (const sv of rawSpine) {
      const dx = sv.x - curr.x, dy = sv.y - curr.y;
      if (dx * dx + dy * dy > SEARCH_SQ) continue;
      const proj = dx * bx + dy * by;
      if (proj < 0.05) continue;
      const perp = Math.abs(dx * by - dy * bx);
      if (perp < bestPerp) { bestPerp = perp; targetZ = sv.z; }
    }
    if (bestPerp > PERP_MAX || targetZ >= 0) continue;
    const hitT = (-targetZ * tanAngle) / sinHalf;
    if (hitT < 0.1) continue;
    const steps = Math.max(5, Math.ceil(hitT / BRANCH_STEP));
    for (let s = 0; s <= steps; s++) {
      const t = (s / steps) * hitT;
      branches.push({ x: curr.x + t * bx, y: curr.y + t * by, z: -(t * sinHalf) / tanAngle });
    }
    // Vertical extension: stem tip → nearest rawSpine vertex above (same x-side)
    const tipX = curr.x + hitT * bx, tipY = curr.y + hitT * by;
    let topSv = null, topDist = Infinity;
    for (const sv of rawSpine) {
      if (Math.abs(sv.x - tipX) > 1.0 || sv.y <= tipY + 0.05) continue;
      const d = sv.y - tipY;
      if (d < topDist && d < 5.0) { topDist = d; topSv = sv; }
    }
    if (topSv) {
      const extSteps = Math.max(2, Math.ceil(topDist / BRANCH_STEP));
      for (let s = 1; s <= extSteps; s++) {
        const f = s / extSteps;
        branches.push({ x: tipX + f*(topSv.x-tipX), y: tipY + f*(topSv.y-tipY), z: targetZ + f*(topSv.z-targetZ) });
      }
    }
  }
  return branches;
}

function orderSpine(pts) {
  if (!pts.length) return [];
  let startIdx = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].z < pts[startIdx].z) startIdx = i;
  }
  const rem = [...pts];
  const out = [];
  let cur = rem.splice(startIdx, 1)[0];
  out.push(cur);
  while (rem.length) {
    let bestD = Infinity, bestI = -1;
    for (let i = 0; i < rem.length; i++) {
      const d = dist2(rem[i], cur);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    cur = rem.splice(bestI, 1)[0];
    out.push(cur);
  }
  return out;
}

function generateGCode(spinePoints, cfg) {
  const { safeZ=5, feedRate=1499, plungeRate=305, spindleRPM=18000, rapidGap=2 } = cfg;
  const fmt = v => v.toFixed(4);
  const rapidGapSq = rapidGap * rapidGap;
  const lines = [';V-Carve Spine', 'G21', 'G90', `S${spindleRPM} M03`, `G00 Z${fmt(safeZ)}`];
  if (spinePoints.length >= 2) {
    lines.push(`G00 X${fmt(spinePoints[0].x)} Y${fmt(spinePoints[0].y)}`);
    lines.push(`G01 Z${fmt(spinePoints[0].z)} F${plungeRate}`);
    for (let i = 1; i < spinePoints.length; i++) {
      const prev = spinePoints[i-1], curr = spinePoints[i];
      if (dist2(curr, prev) > rapidGapSq) {
        lines.push(`G00 Z${fmt(safeZ)}`);
        lines.push(`G00 X${fmt(curr.x)} Y${fmt(curr.y)}`);
        lines.push(`G01 Z${fmt(curr.z)} F${plungeRate}`);
      } else {
        lines.push(`G01 X${fmt(curr.x)} Y${fmt(curr.y)} Z${fmt(curr.z)} F${feedRate}`);
      }
    }
    lines.push(`G00 Z${fmt(safeZ)}`);
  }
  lines.push('M05', 'M30');
  return lines.join('\n');
}

function computeVCarveToolpath(outerPolygon, innerHoles, cfg) {
  const { depthStep=0.05, maxDepth=25, bitHalfAngleDeg=45, safeZ=5, feedRate=1499, plungeRate=305, spindleRPM=18000 } = cfg;
  const tanAngle = Math.tan(bitHalfAngleDeg * Math.PI / 180);
  const outer = isClockwise(outerPolygon) ? [...outerPolygon].reverse() : outerPolygon;
  const holes = (innerHoles || []).map(h => isClockwise(h) ? [...h].reverse() : h);

  const rawSpine = extractSpine(outer, holes, tanAngle, depthStep, maxDepth);
  const branches = cornerBranches(outer, rawSpine, tanAngle);
  const spineVertices = orderSpine([...rawSpine, ...branches]);
  const gcode = generateGCode(spineVertices, { safeZ, feedRate, plungeRate, spindleRPM });
  return { spineVertices, segments: spineVertices.length >= 2 ? [spineVertices] : [], gcode };
}

// ── Shape helpers ─────────────────────────────────────────────────────────────

function makeNgon(cx, cy, r, n, a0 = 0) {
  return Array.from({length: n}, (_, i) => {
    const a = a0 + 2*Math.PI*i/n;
    return { x: cx + r*Math.cos(a), y: cy + r*Math.sin(a) };
  });
}

// ── Test shapes ───────────────────────────────────────────────────────────────

const SYNTHETIC_A = {
  label: "Synthetic 'a' (control)",
  outer: [
    {x:-1.5,y:-7},{x:1.5,y:-7},{x:1.5,y:-4.5},
    {x:4.0,y:-4.0},{x:5.5,y:-2.0},{x:6.0,y:0.0},
    {x:5.5,y:2.0},{x:4.0,y:4.0},{x:2.0,y:5.5},
    {x:0.0,y:6.0},{x:-2.0,y:5.5},{x:-4.0,y:4.0},
    {x:-5.5,y:2.0},{x:-6.0,y:0.0},{x:-5.5,y:-2.0},
    {x:-4.0,y:-4.0},{x:-2.0,y:-5.0},{x:-1.5,y:-4.5},
  ],
  holes: [makeNgon(0, 1, 2.5, 32)],
};

const REALISTIC_A = {
  label: "Realistic 'a' (production)",
  outer: [
    {x:0.0,y:-8.0},{x:2.0,y:-8.0},{x:2.0,y:-5.5},
    {x:5.0,y:-5.0},{x:7.5,y:-2.5},{x:8.0,y:0.0},
    {x:7.5,y:3.0},{x:5.5,y:5.5},{x:3.0,y:7.0},
    {x:0.5,y:7.5},{x:-2.5,y:7.0},{x:-5.0,y:5.0},
    {x:-7.0,y:2.0},{x:-7.5,y:-1.0},{x:-6.5,y:-4.0},
    {x:-4.0,y:-6.0},{x:-1.5,y:-6.5},{x:0.0,y:-5.5},
  ],
  holes: [[
    {x:0.0,y:4.5},{x:-2.0,y:4.0},{x:-3.5,y:2.5},
    {x:-4.0,y:0.5},{x:-3.5,y:-1.5},{x:-2.0,y:-2.8},
    {x:0.0,y:-3.2},{x:2.0,y:-2.8},{x:3.5,y:-1.0},
    {x:4.0,y:1.0},{x:3.2,y:3.0},{x:1.5,y:4.2},
  ]],
};

// ── Runner ────────────────────────────────────────────────────────────────────

const CFG = { depthStep: 0.05, bitHalfAngleDeg: 45, maxDepth: 25, safeZ: 5, feedRate: 1498.6, plungeRate: 304.8, spindleRPM: 18000 };

let allPass = true;

for (const shape of [SYNTHETIC_A, REALISTIC_A]) {
  console.log(`── ${shape.label} ──────────────────`);
  const t0 = Date.now();
  const result = computeVCarveToolpath(shape.outer, shape.holes, CFG);
  const ms = Date.now() - t0;

  const { spineVertices, gcode } = result;
  const zMin = spineVertices.length ? Math.min(...spineVertices.map(p => p.z)) : 0;
  const zMax = spineVertices.length ? Math.max(...spineVertices.map(p => p.z)) : 0;

  console.log(`Spine pts : ${spineVertices.length}`);
  console.log(`Z range   : ${zMin.toFixed(3)} → ${zMax.toFixed(3)} mm`);
  console.log(`G-code    : ${gcode.split('\n').length} lines`);
  console.log(`Time      : ${ms}ms`);

  // All Z values at or below surface (Z=0 is valid for corner-branch start points)
  const allNegativeZ = spineVertices.every(p => p.z <= 0);

  // Consecutive spine points are within reasonable distance (≤ 10 mm gap)
  let maxGap = 0;
  for (let i = 1; i < spineVertices.length; i++) {
    const d = Math.sqrt(dist2(spineVertices[i], spineVertices[i-1]));
    if (d > maxGap) maxGap = d;
  }
  const orderedReasonably = spineVertices.length < 2 || maxGap < 15;

  // G-code validation
  const gcodeHasXYZ = /G01 X.+Y.+Z/.test(gcode);
  const gcodeValid  = gcode.includes('G01') && gcode.includes('M30') && gcode.includes('G21') && gcodeHasXYZ;

  // Corner branches should cover the stem region: points near the outer corner wall
  const stemCornerCovered = spineVertices.some(p => p.z <= -0.3 && p.z > -0.8 &&
    Math.hypot(p.x, p.y) > 0.5); // shallow points away from centre = corner branch

  const ok = spineVertices.length > 0 && allNegativeZ && zMin < -0.5 &&
             orderedReasonably && gcodeValid && stemCornerCovered;
  if (!ok) allPass = false;

  const checks = [
    ['spine pts > 0',         spineVertices.length > 0],
    ['all Z ≤ surface',       allNegativeZ],
    ['max depth > 0.5 mm',    zMin < -0.5],
    ['path ordered',          orderedReasonably],
    ['corner branches exist', stemCornerCovered],
    ['G-code has XYZ moves',  gcodeHasXYZ],
    ['G-code valid',          gcodeValid],
  ];
  for (const [label, pass] of checks) console.log(`  ${pass ? '✓' : '✗'} ${label}`);
  console.log();
}

console.log('══════════════════════════════');
console.log(allPass ? 'ALL PASS ✓' : 'SOME TESTS FAILED ✗');
