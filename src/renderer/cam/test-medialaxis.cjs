// Standalone CJS test script for Phase 1 medial axis extraction.
// Run: node src/renderer/cam/test-medialaxis.cjs
// All geometry functions inlined from offset.js / medialaxis.js.

'use strict';
const ClipperLib = require('../../../node_modules/clipper-lib/clipper.js');

// ── Geometry helpers (from offset.js) ─────────────────────────────────────────
const SCALE = 1000;
function toC(pts) { return pts.map(p => ({ X: Math.round(p.x*SCALE), Y: Math.round(p.y*SCALE) })); }
function fromC(path) { return path.map(p => ({ x: p.X/SCALE, y: p.Y/SCALE })); }

function stripClose(pts) {
  if (pts.length > 1 && Math.hypot(pts[pts.length-1].x-pts[0].x, pts[pts.length-1].y-pts[0].y) < 1e-6)
    return pts.slice(0, -1);
  return pts;
}
function isClockwise(pts) {
  let sum = 0, n = pts.length;
  for (let i = 0; i < n-1; i++) sum += (pts[i+1].x-pts[i].x)*(pts[i+1].y+pts[i].y);
  return sum > 0;
}
function polygonArea(pts) {
  let a = 0, n = pts.length;
  for (let i = 0, j = n-1; i < n; j=i++) a += (pts[j].x+pts[i].x)*(pts[j].y-pts[i].y);
  return Math.abs(a/2);
}
function clipperOffset(pts, distance) {
  const co = new ClipperLib.ClipperOffset();
  co.AddPath(toC(pts), ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, -distance*SCALE);
  return sol.map(fromC).filter(p=>p.length>=3)
    .map(p => isClockwise(p)?[...p].reverse():p)
    .sort((a,b)=>polygonArea(b)-polygonArea(a));
}
function offsetPolyline(pts, d, closed=true) {
  const p = stripClose([...pts]);
  if (p.length < 3) return [p];
  const r = clipperOffset(p, d);
  if (!r.length) return [[]];
  return r.map(q=>[...q,{...q[0]}]);
}
function differencePolygons(subj, clipList) {
  const s = stripClose([...subj]);
  if (s.length < 3) return [];
  const c = new ClipperLib.Clipper();
  c.AddPath(toC(s), ClipperLib.PolyType.ptSubject, true);
  for (const cl of clipList) { const p = stripClose([...cl]); if (p.length>=3) c.AddPath(toC(p), ClipperLib.PolyType.ptClip, true); }
  const sol = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctDifference, sol);
  return sol.map(fromC).filter(p=>p.length>=3).map(p=>isClockwise(p)?[...p].reverse():p);
}

// ── Medial axis helpers (from medialaxis.js) ──────────────────────────────────
function vertexCenter(pts) {
  let sx=0, sy=0; for (const p of pts){sx+=p.x;sy+=p.y;} return {x:sx/pts.length,y:sy/pts.length};
}
function bboxCenter(pts) {
  let minX=pts[0].x,maxX=pts[0].x,minY=pts[0].y,maxY=pts[0].y;
  for (const p of pts){if(p.x<minX)minX=p.x;if(p.x>maxX)maxX=p.x;if(p.y<minY)minY=p.y;if(p.y>maxY)maxY=p.y;}
  return {x:(minX+maxX)/2,y:(minY+maxY)/2};
}
function dist2(a,b){return (a.x-b.x)**2+(a.y-b.y)**2;}

function computeValidPaths(outer, holes, d) {
  const shrunk = offsetPolyline(outer, d, true);
  if (!shrunk?.length) return [];
  const vo = shrunk.filter(r=>r?.length>=3);
  if (!vo.length) return [];
  if (!holes?.length) return vo;
  const eh = holes.flatMap(h=>offsetPolyline(h,-d,true)).filter(r=>r?.length>=3);
  if (!eh.length) return vo;
  const res = [];
  for (const oc of vo) { for (const p of differencePolygons(oc,eh)) if(p?.length>=3) res.push(p); }
  return res;
}

function greedyMatch(prevC, curC) {
  const claimed = new Set(), pm = new Array(prevC.length).fill(-1);
  for (let pi=0; pi<prevC.length; pi++) {
    let best=-1, bd=Infinity;
    for (let ci=0;ci<curC.length;ci++){if(claimed.has(ci))continue;const d=dist2(prevC[pi],curC[ci]);if(d<bd){bd=d;best=ci;}}
    pm[pi]=best; if(best>=0)claimed.add(best);
  }
  const orphans=[];
  for(let ci=0;ci<curC.length;ci++){if(!claimed.has(ci))orphans.push(ci);}
  return {prevMatch:pm, orphanCurs:orphans};
}

function extractRawSkeletonPoints(outerPolygon, innerHoles=[], config={}) {
  const {stepSize=0.05, bitHalfAngleDeg=45, maxSteps=3000} = config;
  const tanAngle = Math.tan(bitHalfAngleDeg*Math.PI/180);
  const nodes = [];

  const outer = isClockwise(outerPolygon)?[...outerPolygon].reverse():outerPolygon;
  const holes = innerHoles.map(h=>isClockwise(h)?[...h].reverse():h);

  let prevPaths = computeValidPaths(outer, holes, stepSize);
  if (!prevPaths.length) return nodes;

  for (let i=2; i<=maxSteps; i++) {
    const curD=i*stepSize, prevD=(i-1)*stepSize;
    const curPaths = computeValidPaths(outer, holes, curD);

    if (!curPaths.length) {
      for (const p of prevPaths) { const c=vertexCenter(p); nodes.push({x:c.x,y:c.y,z:-(prevD/tanAngle),eventType:'terminal'}); }
      prevPaths=[];
      break;
    }
    const pc=prevPaths.map(bboxCenter), cc=curPaths.map(bboxCenter);
    if (curPaths.length !== prevPaths.length) {
      const {prevMatch, orphanCurs} = greedyMatch(pc, cc);
      for (let pi=0;pi<prevPaths.length;pi++) {
        if (prevMatch[pi]<0) { const c=vertexCenter(prevPaths[pi]); nodes.push({x:c.x,y:c.y,z:-(prevD/tanAngle),eventType:'terminal'}); }
      }
      for (const ci of orphanCurs) {
        let bpi=0,bd=dist2(cc[ci],pc[0]);
        for(let pi=1;pi<pc.length;pi++){const d=dist2(cc[ci],pc[pi]);if(d<bd){bd=d;bpi=pi;}}
        const c=vertexCenter(prevPaths[bpi]);
        nodes.push({x:c.x,y:c.y,z:-(prevD/tanAngle),eventType:'junction'});
      }
    } else {
      const jumpThresh = (20*stepSize)**2;
      for (let pi=0;pi<prevPaths.length;pi++) {
        let best=0,bestD2=dist2(pc[pi],cc[0]);
        for(let ci=1;ci<cc.length;ci++){const d2=dist2(pc[pi],cc[ci]);if(d2<bestD2){bestD2=d2;best=ci;}}
        if (bestD2>jumpThresh) {
          const c=vertexCenter(prevPaths[pi]);
          nodes.push({x:c.x,y:c.y,z:-(prevD/tanAngle),eventType:'junction'});
        }
      }
    }
    prevPaths = curPaths;
  }
  for (const p of prevPaths) { const c=vertexCenter(p); nodes.push({x:c.x,y:c.y,z:-(maxSteps*stepSize/tanAngle),eventType:'terminal'}); }
  return nodes;
}

// ── Test shape helpers ────────────────────────────────────────────────────────
function makeNgon(cx, cy, r, n, startAngle=0) {
  const pts=[];
  for(let i=0;i<n;i++){const a=startAngle+(2*Math.PI*i)/n;pts.push({x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)});}
  return pts;
}

// ── Test shapes ───────────────────────────────────────────────────────────────
const shapes = {
  'Thin rectangle 20×4mm': {
    outer: [{x:0,y:0},{x:20,y:0},{x:20,y:4},{x:0,y:4}],
    holes: [],
    expect: 'Terminal nodes along y≈2 centerline',
  },
  'T-shape (5mm stem, 8mm-tall bar) — stem collapses at d=2.5 before bar at d=4': {
    outer: [
      {x:-2.5,y:0},{x:2.5,y:0},{x:2.5,y:10},
      {x:7.5,y:10},{x:7.5,y:18},{x:-7.5,y:18},
      {x:-7.5,y:10},{x:-2.5,y:10},
    ],
    holes: [],
    expect: 'Junction where stem collapses into bar (d≈2.5mm), then terminal for bar (d≈4mm)',
  },
  'O-shape (r=10 outer, r=5 inner)': {
    outer: makeNgon(0,0,10,48),
    holes: [makeNgon(0,0,5,48)],
    expect: 'Terminal nodes ~at donut collapse (near origin)',
  },
  "Letter 'a' (bowl r=6 + stem + counter r=2.5)": {
    outer: [
      {x:-1.5,y:-7},{x:1.5,y:-7},{x:1.5,y:-4.5},
      {x:4.0,y:-4.0},{x:5.5,y:-2.0},{x:6.0,y:0.0},
      {x:5.5,y:2.0},{x:4.0,y:4.0},{x:2.0,y:5.5},
      {x:0.0,y:6.0},{x:-2.0,y:5.5},{x:-4.0,y:4.0},
      {x:-5.5,y:2.0},{x:-6.0,y:0.0},{x:-5.5,y:-2.0},
      {x:-4.0,y:-4.0},{x:-2.0,y:-5.0},{x:-1.5,y:-4.5},
    ],
    holes: [makeNgon(0,1,2.5,32)],
    expect: 'Junction where bowl meets stem, terminal in stem, terminal(s) in bowl after counter collapses',
  },
};

// ── Run all tests ─────────────────────────────────────────────────────────────
const CFG = { stepSize: 0.1, bitHalfAngleDeg: 45, maxSteps: 3000 };

let allPass = true;
for (const [name, {outer, holes, expect}] of Object.entries(shapes)) {
  const t0 = Date.now();
  const nodes = extractRawSkeletonPoints(outer, holes, CFG);
  const ms = Date.now() - t0;

  const terminals = nodes.filter(n=>n.eventType==='terminal');
  const junctions = nodes.filter(n=>n.eventType==='junction');

  console.log(`\n──────────────────────────────────────────`);
  console.log(`Shape : ${name}`);
  console.log(`Expect: ${expect}`);
  console.log(`Result: ${nodes.length} nodes total — ${terminals.length} terminal, ${junctions.length} junction  (${ms}ms)`);

  if (terminals.length > 0) {
    const zMin = Math.min(...terminals.map(n=>n.z)).toFixed(3);
    const zMax = Math.max(...terminals.map(n=>n.z)).toFixed(3);
    const xVals = terminals.map(n=>n.x.toFixed(1)).join(', ').slice(0,80);
    const yVals = terminals.map(n=>n.y.toFixed(1)).join(', ').slice(0,80);
    console.log(`  Terminal Z range: ${zMin} → ${zMax} mm`);
    console.log(`  Terminal X: ${xVals}${terminals.length>8?'…':''}`);
    console.log(`  Terminal Y: ${yVals}${terminals.length>8?'…':''}`);
  }
  if (junctions.length > 0) {
    for (const j of junctions) {
      console.log(`  Junction @ (${j.x.toFixed(2)}, ${j.y.toFixed(2)}) z=${j.z.toFixed(3)}`);
    }
  }

  // Basic sanity: should have at least 1 node
  if (nodes.length === 0) {
    console.log(`  FAIL: expected at least 1 node, got 0`);
    allPass = false;
  } else {
    console.log(`  OK`);
  }
}

console.log(`\n══════════════════════════════════════════`);
console.log(allPass ? 'All tests produced nodes.' : 'Some tests produced 0 nodes — review above.');
