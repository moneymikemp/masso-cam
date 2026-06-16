// Outside-In V-Carve test — CJS, all functions inlined.
// Run: node src/renderer/cam/test-vcarve.cjs
'use strict';

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
function offsetPolyline(pts, d, closed = true) {
  const p = stripClose([...pts]);
  if (p.length < 3) return [p];
  const r = clipperOffset(p, d);
  if (!r.length) return [[]];
  return r.map(q => [...q, {...q[0]}]);
}
function differencePolygons(subj, clipList) {
  const s = stripClose([...subj]);
  if (s.length < 3) return [];
  const c = new ClipperLib.Clipper();
  c.AddPath(toC(s), ClipperLib.PolyType.ptSubject, true);
  for (const cl of clipList) {
    const p = stripClose([...cl]);
    if (p.length >= 3) c.AddPath(toC(p), ClipperLib.PolyType.ptClip, true);
  }
  const sol = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctDifference, sol);
  return sol.map(fromC).filter(p => p.length >= 3).map(p => isClockwise(p) ? [...p].reverse() : p);
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

function dist2(a, b) { return (a.x-b.x)**2 + (a.y-b.y)**2; }

function closestPointIdx(pts, target) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = dist2(pts[i], target);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function computeValidPaths(outer, holes, R) {
  const so = offsetPolyline(outer, R, true);
  if (!so?.length) return [];
  const vo = so.filter(r => r?.length >= 3);
  if (!vo.length) return [];
  if (!holes?.length) return vo;
  const eh = holes.flatMap(h => offsetPolyline(h, -R, true)).filter(r => r?.length >= 3);
  if (!eh.length) return vo;
  const res = [];
  for (const oc of vo) for (const p of differencePolygons(oc, eh)) if (p?.length >= 3) res.push(p);
  return res;
}

function generateGCode(segments, cfg) {
  const { safeZ=5, feedRate=1499, plungeRate=305, spindleRPM=18000 } = cfg;
  const fmt = v => v.toFixed(4);
  const lines = [';V-Carve Outside-In', 'G21', 'G90', `S${spindleRPM} M03`, `G00 Z${fmt(safeZ)}`];
  for (const seg of segments) {
    if (seg.length < 2) continue;
    lines.push(`G00 X${fmt(seg[0].x)} Y${fmt(seg[0].y)}`);
    lines.push(`G01 Z${fmt(seg[0].z)} F${plungeRate}`);
    for (let i = 1; i < seg.length; i++) lines.push(`G01 X${fmt(seg[i].x)} Y${fmt(seg[i].y)} F${feedRate}`);
    lines.push(`G00 Z${fmt(safeZ)}`);
  }
  lines.push('M05', 'M30');
  return lines.join('\n');
}

function computeVCarveToolpath(outerPolygon, innerHoles, cfg) {
  const { depthStep=0.1, maxDepth=25, bitHalfAngleDeg=45, safeZ=5, feedRate=1499, plungeRate=305, spindleRPM=18000 } = cfg;
  const tanAngle = Math.tan(bitHalfAngleDeg * Math.PI / 180);
  const outer = isClockwise(outerPolygon) ? [...outerPolygon].reverse() : outerPolygon;
  const holes = (innerHoles || []).map(h => isClockwise(h) ? [...h].reverse() : h);

  const layers = [];
  const maxSteps = Math.ceil(maxDepth / depthStep);
  for (let i = 1; i <= maxSteps; i++) {
    const z = -(i * depthStep);
    const R = Math.abs(z) * tanAngle;
    const paths = computeValidPaths(outer, holes, R);
    if (!paths.length) break;
    layers.push({ z, paths });
  }

  const segments = [];
  let lastPt = null;
  for (const { z, paths } of layers) {
    const orderedPaths = lastPt
      ? [...paths].sort((a, b) =>
          Math.min(...a.map(p => dist2(p, lastPt))) -
          Math.min(...b.map(p => dist2(p, lastPt))))
      : paths;
    for (const path of orderedPaths) {
      const startIdx = lastPt ? closestPointIdx(path, lastPt) : 0;
      const rotated = startIdx === 0 ? path : [...path.slice(startIdx), ...path.slice(0, startIdx)];
      const seg = rotated.map(p => ({ x: p.x, y: p.y, z }));
      seg.push({...seg[0]});
      segments.push(seg);
      lastPt = seg[0];
    }
  }

  const gcode = generateGCode(segments, { safeZ, feedRate, plungeRate, spindleRPM });
  return { layers, segments, gcode };
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

const CFG = { depthStep: 0.1, bitHalfAngleDeg: 45, maxDepth: 25, safeZ: 5, feedRate: 1498.6, plungeRate: 304.8, spindleRPM: 18000 };

let allPass = true;

for (const shape of [SYNTHETIC_A, REALISTIC_A]) {
  console.log(`── ${shape.label} ──────────────────`);
  const t0 = Date.now();
  const result = computeVCarveToolpath(shape.outer, shape.holes, CFG);
  const ms = Date.now() - t0;

  const { layers, segments, gcode } = result;
  const totalMoves = segments.reduce((s, sg) => s + sg.length, 0);
  const zMin = layers.length ? layers[layers.length - 1].z : 0;
  const zMax = layers.length ? layers[0].z : 0;

  console.log(`Layers    : ${layers.length}`);
  console.log(`Rings     : ${segments.length}  (${totalMoves} moves)`);
  console.log(`G-code    : ${gcode.split('\n').length} lines`);
  console.log(`Z range   : ${zMin.toFixed(3)} → ${zMax.toFixed(3)} mm`);
  console.log(`Time      : ${ms}ms`);

  // Verify layer Z ordering (each layer strictly more negative than previous)
  let layersOrdered = true;
  for (let i = 1; i < layers.length; i++) {
    if (layers[i].z >= layers[i-1].z) { layersOrdered = false; break; }
  }

  // Verify each segment is closed (last point = first point)
  let allClosed = true;
  for (const seg of segments) {
    const first = seg[0], last = seg[seg.length - 1];
    if (Math.abs(first.x - last.x) > 1e-9 || Math.abs(first.y - last.y) > 1e-9) {
      allClosed = false; break;
    }
  }

  // Verify Z is constant within each segment
  let zConstantPerRing = true;
  for (const seg of segments) {
    const z0 = seg[0].z;
    if (seg.some(p => Math.abs(p.z - z0) > 1e-9)) { zConstantPerRing = false; break; }
  }

  // Verify G-code has expected markers
  const gcodeOk = gcode.includes('G01') && gcode.includes('M30') && gcode.includes('G21');

  const ok = layers.length > 0 && segments.length > 0 && layersOrdered && allClosed && zConstantPerRing && gcodeOk;
  if (!ok) allPass = false;

  const checks = [
    ['layers > 0',          layers.length > 0],
    ['layers ordered',      layersOrdered],
    ['rings > 0',           segments.length > 0],
    ['rings closed',        allClosed],
    ['Z constant per ring', zConstantPerRing],
    ['G-code valid',        gcodeOk],
  ];
  for (const [label, pass] of checks) console.log(`  ${pass ? '✓' : '✗'} ${label}`);
  console.log();
}

console.log('══════════════════════════════');
console.log(allPass ? 'ALL PASS ✓' : 'SOME TESTS FAILED ✗');
