// Phase 2 pipeline test — CJS, all functions inlined.
// Run: node src/renderer/cam/test-vcarve.cjs
'use strict';

const ClipperLib = require('../../../node_modules/clipper-lib/clipper.js');

// ── Geometry ──────────────────────────────────────────────────────────────────
const SCALE = 1000;
const toC   = pts => pts.map(p => ({ X: Math.round(p.x*SCALE), Y: Math.round(p.y*SCALE) }));
const fromC = path => path.map(p => ({ x: p.X/SCALE, y: p.Y/SCALE }));

function stripClose(pts) {
  if (pts.length > 1 && Math.hypot(pts[pts.length-1].x-pts[0].x, pts[pts.length-1].y-pts[0].y) < 1e-6)
    return pts.slice(0, -1);
  return pts;
}
function isClockwise(pts) {
  let sum=0, n=pts.length;
  for(let i=0;i<n-1;i++) sum+=(pts[i+1].x-pts[i].x)*(pts[i+1].y+pts[i].y);
  return sum>0;
}
function polygonArea(pts) {
  let a=0,n=pts.length;
  for(let i=0,j=n-1;i<n;j=i++) a+=(pts[j].x+pts[i].x)*(pts[j].y-pts[i].y);
  return Math.abs(a/2);
}
function clipperOffset(pts, distance) {
  const co=new ClipperLib.ClipperOffset();
  co.AddPath(toC(pts),ClipperLib.JoinType.jtMiter,ClipperLib.EndType.etClosedPolygon);
  const sol=new ClipperLib.Paths();
  co.Execute(sol,-distance*SCALE);
  return sol.map(fromC).filter(p=>p.length>=3)
    .map(p=>isClockwise(p)?[...p].reverse():p)
    .sort((a,b)=>polygonArea(b)-polygonArea(a));
}
function offsetPolyline(pts,d,closed=true){
  const p=stripClose([...pts]);
  if(p.length<3)return[p];
  const r=clipperOffset(p,d);
  if(!r.length)return[[]];
  return r.map(q=>[...q,{...q[0]}]);
}
function differencePolygons(subj,clipList){
  const s=stripClose([...subj]);
  if(s.length<3)return[];
  const c=new ClipperLib.Clipper();
  c.AddPath(toC(s),ClipperLib.PolyType.ptSubject,true);
  for(const cl of clipList){const p=stripClose([...cl]);if(p.length>=3)c.AddPath(toC(p),ClipperLib.PolyType.ptClip,true);}
  const sol=new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctDifference,sol);
  return sol.map(fromC).filter(p=>p.length>=3).map(p=>isClockwise(p)?[...p].reverse():p);
}

function vertexCenter(pts){let sx=0,sy=0;for(const p of pts){sx+=p.x;sy+=p.y;}return{x:sx/pts.length,y:sy/pts.length};}
function bboxCenter(pts){let mnX=pts[0].x,mxX=pts[0].x,mnY=pts[0].y,mxY=pts[0].y;for(const p of pts){if(p.x<mnX)mnX=p.x;if(p.x>mxX)mxX=p.x;if(p.y<mnY)mnY=p.y;if(p.y>mxY)mxY=p.y;}return{x:(mnX+mxX)/2,y:(mnY+mxY)/2};}
function dist2(a,b){return(a.x-b.x)**2+(a.y-b.y)**2;}
function dist3(a,b){return Math.sqrt((a.x-b.x)**2+(a.y-b.y)**2+(a.z-b.z)**2);}

function ptSegDist(p,a,b){
  const dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;
  if(len2===0)return Math.hypot(p.x-a.x,p.y-a.y);
  const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2));
  return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy));
}
function wallDist(p,outer,holes){
  let minD=Infinity,on=outer.length;
  for(let i=0;i<on;i++){const d=ptSegDist(p,outer[i],outer[(i+1)%on]);if(d<minD)minD=d;}
  for(const h of holes){const hn=h.length;for(let i=0;i<hn;i++){const d=ptSegDist(p,h[i],h[(i+1)%hn]);if(d<minD)minD=d;}}
  return minD;
}

function computeValidPaths(outer,holes,d){
  const so=offsetPolyline(outer,d,true);
  if(!so?.length)return[];
  const vo=so.filter(r=>r?.length>=3);
  if(!vo.length)return[];
  if(!holes?.length)return vo;
  const eh=holes.flatMap(h=>offsetPolyline(h,-d,true)).filter(r=>r?.length>=3);
  if(!eh.length)return vo;
  const res=[];
  for(const oc of vo)for(const p of differencePolygons(oc,eh))if(p?.length>=3)res.push(p);
  return res;
}
function greedyMatch(pc,cc){
  const claimed=new Set(),pm=new Array(pc.length).fill(-1);
  for(let pi=0;pi<pc.length;pi++){let best=-1,bd=Infinity;for(let ci=0;ci<cc.length;ci++){if(claimed.has(ci))continue;const d=dist2(pc[pi],cc[ci]);if(d<bd){bd=d;best=ci;}}pm[pi]=best;if(best>=0)claimed.add(best);}
  const oc=[];for(let ci=0;ci<cc.length;ci++)if(!claimed.has(ci))oc.push(ci);
  return{prevMatch:pm,orphanCurs:oc};
}
function sharpCorners(poly,maxDeg){
  const pts=stripClose(poly),n=pts.length,thr=Math.cos(maxDeg*Math.PI/180),out=[];
  for(let i=0;i<n;i++){const prev=pts[(i-1+n)%n],cur=pts[i],next=pts[(i+1)%n];const ax=prev.x-cur.x,ay=prev.y-cur.y,bx=next.x-cur.x,by=next.y-cur.y,la=Math.hypot(ax,ay),lb=Math.hypot(bx,by);if(la<1e-6||lb<1e-6)continue;if((ax*bx+ay*by)/(la*lb)>=thr)out.push({x:cur.x,y:cur.y});}
  return out;
}

function erodeWithHistory(outer,holes,cfg){
  const{stepSize,bitHalfAngleDeg,maxSteps}=cfg;
  const tanA=Math.tan(bitHalfAngleDeg*Math.PI/180);
  const rawNodes=[],rings=[];let ringCounter=0;
  function pushNode(x,y,d,type,extra){rawNodes.push(Object.assign({x,y,z:-(d/tanA),eventType:type,stepD:d,source:'event'},extra));}
  function emitRing(poly,d){const pts=stripClose([...poly]),rid=ringCounter++;for(let vi=0;vi<pts.length;vi++)rawNodes.push({x:pts[vi].x,y:pts[vi].y,z:-(d/tanA),eventType:'terminal',source:'annular',stepD:d,ringId:rid,ringIdx:vi,ringLen:pts.length});}
  function mineRidge(startRi){for(let ri=startRi;ri<rings.length;ri++){const{d,paths}=rings[ri];const mp=paths.reduce((b,p)=>polygonArea(p)>polygonArea(b)?p:b,paths[0]);for(const c of sharpCorners(mp,120))rawNodes.push({x:c.x,y:c.y,z:-(d/tanA),eventType:'terminal',source:'event',stepD:d});}}
  // Fix 3: only largest-area path → annular ring; smaller paths → centroid terminal
  function emitCollapse(paths,d){
    const sorted=[...paths].sort((a,b)=>polygonArea(b)-polygonArea(a));
    const thresh=stepSize*stepSize*50;
    for(let pi=0;pi<sorted.length;pi++){const p=sorted[pi];if(pi===0&&polygonArea(p)>thresh){emitRing(p,d);mineRidge(Math.floor(rings.length*0.5));}else{const c=vertexCenter(p);pushNode(c.x,c.y,d,'terminal');}}
  }
  let prevPaths=computeValidPaths(outer,holes,stepSize);
  if(!prevPaths.length)return{rawNodes,rings};
  rings.push({d:stepSize,paths:prevPaths});
  for(let i=2;i<=maxSteps;i++){
    const curD=i*stepSize,prevD=(i-1)*stepSize;
    const curPaths=computeValidPaths(outer,holes,curD);
    if(!curPaths.length){emitCollapse(prevPaths,prevD);prevPaths=[];break;}
    const pc=prevPaths.map(bboxCenter),cc=curPaths.map(bboxCenter);
    if(curPaths.length!==prevPaths.length){
      const{prevMatch,orphanCurs}=greedyMatch(pc,cc);
      const terminated=prevPaths.filter((_,pi)=>prevMatch[pi]<0);
      if(terminated.length>0)emitCollapse(terminated,prevD);
      for(const ci of orphanCurs){let bpi=0,bd=dist2(cc[ci],pc[0]);for(let pi=1;pi<pc.length;pi++){const d=dist2(cc[ci],pc[pi]);if(d<bd){bd=d;bpi=pi;}}const c=vertexCenter(prevPaths[bpi]);pushNode(c.x,c.y,prevD,'junction');}
    }else{
      const jt=(20*stepSize)**2;
      for(let pi=0;pi<prevPaths.length;pi++){let bd2=dist2(pc[pi],cc[0]);for(let ci=1;ci<cc.length;ci++){const d2=dist2(pc[pi],cc[ci]);if(d2<bd2)bd2=d2;}if(bd2>jt){const c=vertexCenter(prevPaths[pi]);pushNode(c.x,c.y,prevD,'junction');}}
    }
    rings.push({d:curD,paths:curPaths});prevPaths=curPaths;
  }
  for(const p of prevPaths){const c=vertexCenter(p);pushNode(c.x,c.y,maxSteps*stepSize,'terminal');}
  return{rawNodes,rings};
}

function deduplicateNodes(rawNodes,stepSize){
  const rSq=(1.5*stepSize)**2,out=[],used=new Set();
  for(let i=0;i<rawNodes.length;i++){
    if(used.has(i))continue;
    if(rawNodes[i].source!=='event'){out.push(Object.assign({},rawNodes[i]));continue;}
    const group=[rawNodes[i]];used.add(i);
    for(let j=i+1;j<rawNodes.length;j++){if(used.has(j)||rawNodes[j].source!=='event')continue;if(dist2(rawNodes[i],rawNodes[j])<=rSq){group.push(rawNodes[j]);used.add(j);}}
    out.push({x:group.reduce((s,n)=>s+n.x,0)/group.length,y:group.reduce((s,n)=>s+n.y,0)/group.length,z:Math.min(...group.map(n=>n.z)),eventType:group.some(n=>n.eventType==='junction')?'junction':'terminal',source:'event',stepD:group[0].stepD});
  }
  return out;
}

function buildGraph(nodes,stepSize){
  const n=nodes.length;
  for(let i=0;i<n;i++)nodes[i].id=i;
  const adj=Array.from({length:n},()=>[]);
  function addEdge(a,b){if(a===b)return;if(adj[a].some(e=>e.toId===b))return;const d=dist3(nodes[a],nodes[b]);adj[a].push({toId:b,dist:d});adj[b].push({toId:a,dist:d});}
  // Rule 1: 2×stepSize proximity
  const thr2d=(2*stepSize)**2;
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const dx=nodes[i].x-nodes[j].x,dy=nodes[i].y-nodes[j].y;if(dx*dx+dy*dy<=thr2d)addEdge(i,j);}
  // Rule 2: Ring cycles
  const rg=new Map();
  for(let i=0;i<n;i++){if(nodes[i].source!=='annular')continue;const r=rg.get(nodes[i].ringId)||[];r.push(i);rg.set(nodes[i].ringId,r);}
  for(const[,r]of rg){r.sort((a,b)=>nodes[a].ringIdx-nodes[b].ringIdx);for(let k=0;k<r.length;k++)addEdge(r[k],r[(k+1)%r.length]);let bRi=r[0],bSk=-1,bD=Infinity;for(const ri of r)for(let j=0;j<n;j++){if(nodes[j].source==='annular'&&nodes[j].ringId===nodes[ri].ringId)continue;const d=dist2(nodes[ri],nodes[j]);if(d<bD){bD=d;bRi=ri;bSk=j;}}if(bSk>=0)addEdge(bRi,bSk);}
  // Rule 3: MST bridge — Fix 2: isolated nodes get own component so they're never skipped
  function getComps(){const c=new Array(n).fill(-1);let cc=0;for(let s=0;s<n;s++){if(c[s]>=0)continue;if(!adj[s].length){c[s]=cc++;continue;}const q=[s];c[s]=cc;for(let qi=0;qi<q.length;qi++)for(const e of adj[q[qi]])if(c[e.toId]<0){c[e.toId]=cc;q.push(e.toId);}cc++;}return{c,cc};}
  let{c:comp,cc:compCount}=getComps();
  while(compCount>1){let ba=-1,bb=-1,bd=Infinity;for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){if(comp[i]===comp[j])continue;const dx=nodes[i].x-nodes[j].x,dy=nodes[i].y-nodes[j].y,d=dx*dx+dy*dy;if(d<bd){bd=d;ba=i;bb=j;}}if(ba<0)break;addEdge(ba,bb);({c:comp,cc:compCount}=getComps());}
  return{nodes,adj};
}

function dfsComponent(nodes,adj,startId,stepSize){
  const visited=new Set([startId]),path=[nodes[startId]],stack=[{id:startId,prevZ:nodes[startId].z}];
  while(stack.length>0){
    const{id:v,prevZ}=stack[stack.length-1],curZ=nodes[v].z,dz=curZ-prevZ;
    const sl=stack.length,pid=sl>=2?stack[sl-2].id:-1;
    const dx=pid>=0?nodes[v].x-nodes[pid].x:0,dy=pid>=0?nodes[v].y-nodes[pid].y:0,dl=Math.hypot(dx,dy);
    let chosen=null,best=Infinity;
    for(const e of adj[v]){
      if(visited.has(e.toId))continue;
      const zs=Math.abs(nodes[e.toId].z-curZ-dz);
      let dp=0;if(dl>1e-6){const tx=nodes[e.toId].x-nodes[v].x,ty=nodes[e.toId].y-nodes[v].y,tl=Math.hypot(tx,ty);if(tl>1e-6){const dot=(dx*tx+dy*ty)/(dl*tl);dp=(1-dot)*stepSize;}}
      const s=zs+dp;if(s<best){best=s;chosen=e;}
    }
    if(chosen){visited.add(chosen.toId);path.push(nodes[chosen.toId]);stack.push({id:chosen.toId,prevZ:curZ});}
    else{stack.pop();if(stack.length>0)path.push(nodes[stack[stack.length-1].id]);}
  }
  return path;
}

function traverseGraph(nodes,adj,stepSize=0.05){
  if(!nodes.length)return[];
  const n=nodes.length,comp=new Array(n).fill(-1);let cc=0;
  for(let s=0;s<n;s++){
    if(comp[s]>=0)continue;
    if(!adj[s].length){comp[s]=cc++;continue;}
    const q=[s];comp[s]=cc;for(let qi=0;qi<q.length;qi++)for(const e of adj[q[qi]])if(comp[e.toId]<0){comp[e.toId]=cc;q.push(e.toId);}cc++;
  }
  const segs=[];
  for(let c=0;c<cc;c++){
    const ids=[];for(let i=0;i<n;i++)if(comp[i]===c)ids.push(i);
    if(ids.length<2)continue;
    const terms=ids.filter(id=>adj[id].length===1),cands=terms.length>0?terms:ids;
    const sid=cands.reduce((b,id)=>(nodes[id].x**2+nodes[id].y**2)<(nodes[b].x**2+nodes[b].y**2)?id:b,cands[0]);
    const seg=dfsComponent(nodes,adj,sid,stepSize);if(seg.length>1)segs.push(seg);
  }
  return segs;
}

function generateGCode(segs,cfg){
  const{safeZ=5,feedRate=1499,plungeRate=305,spindleRPM=18000}=cfg;
  const f=v=>v.toFixed(4);
  const L=[';V-Carve','G21','G90',`S${spindleRPM} M03`,`G00 Z${f(safeZ)}`];
  for(const seg of segs){if(seg.length<2)continue;const s=seg[0];L.push(`G00 X${f(s.x)} Y${f(s.y)}`);L.push(`G01 Z${f(s.z)} F${plungeRate}`);for(let i=1;i<seg.length;i++){const p=seg[i];L.push(`G01 X${f(p.x)} Y${f(p.y)} Z${f(p.z)} F${feedRate}`);}L.push(`G00 Z${f(safeZ)}`);}
  L.push('M05','M30');return L.join('\n');
}

function makeNgon(cx,cy,r,n,a0=0){return Array.from({length:n},(_,i)=>{const a=a0+2*Math.PI*i/n;return{x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)};});}

function run(label,outerIn,holesIn,cfg){
  const t0=Date.now();
  const tanA=Math.tan(cfg.bitHalfAngleDeg*Math.PI/180);
  const outer=isClockwise(outerIn)?[...outerIn].reverse():outerIn;
  const holes=holesIn.map(h=>isClockwise(h)?[...h].reverse():h);
  const{rawNodes,rings}=erodeWithHistory(outer,holes,cfg);
  const dedup=deduplicateNodes(rawNodes,cfg.stepSize);
  const graph=buildGraph(dedup,cfg.stepSize);
  const segs=traverseGraph(graph.nodes,graph.adj,cfg.stepSize);
  // Fix 1: recompute Z from actual wall distance
  for(const seg of segs)for(const p of seg){const wd=wallDist(p,outer,holes);p.z=-(Math.max(wd,0)/tanA);}
  const gcode=generateGCode(segs,cfg);
  const ms=Date.now()-t0;

  console.log(`\n── ${label} ──────────────────`);
  console.log(`Raw nodes : ${rawNodes.length}  (term:${rawNodes.filter(n=>n.eventType==='terminal'&&n.source==='event').length}  junc:${rawNodes.filter(n=>n.eventType==='junction').length}  annular:${rawNodes.filter(n=>n.source==='annular').length})`);
  console.log(`Dedup     : ${dedup.length}`);
  console.log(`Graph     : ${graph.nodes.length} nodes, ${graph.adj.reduce((s,a)=>s+a.length,0)/2|0} edges`);
  console.log(`Segments  : ${segs.length}  (${segs.reduce((s,g)=>s+g.length,0)} moves)`);
  console.log(`G-code    : ${gcode.split('\n').length} lines`);
  console.log(`Time      : ${ms}ms`);

  if(segs.length>0){
    const allPts=segs.flat();
    const zVals=allPts.map(p=>p.z);
    const zMin=Math.min(...zVals),zMax=Math.max(...zVals);
    // Count distinct Z values to detect flattening
    const zSet=new Set(zVals.map(z=>z.toFixed(3)));
    console.log(`Z range   : ${zMin.toFixed(3)} → ${zMax.toFixed(3)} mm  (${zSet.size} distinct depths)`);
  }

  const gcLines=gcode.split('\n');
  console.log(`G-code sample (first 10 lines):`);
  gcLines.slice(0,10).forEach(l=>console.log('  '+l));
  if(gcLines.length>10)console.log(`  ...${gcLines.length-10} more lines`);

  return{rawNodes,dedup,segs,gcode};
}

const CFG = { stepSize:0.1, bitHalfAngleDeg:45, maxSteps:3000, safeZ:5, feedRate:1498.6, plungeRate:304.8, spindleRPM:18000 };

const SYNTHETIC_A = {
  outer: [
    {x:-1.5,y:-7},{x:1.5,y:-7},{x:1.5,y:-4.5},
    {x:4.0,y:-4.0},{x:5.5,y:-2.0},{x:6.0,y:0.0},
    {x:5.5,y:2.0},{x:4.0,y:4.0},{x:2.0,y:5.5},
    {x:0.0,y:6.0},{x:-2.0,y:5.5},{x:-4.0,y:4.0},
    {x:-5.5,y:2.0},{x:-6.0,y:0.0},{x:-5.5,y:-2.0},
    {x:-4.0,y:-4.0},{x:-2.0,y:-5.0},{x:-1.5,y:-4.5},
  ],
  holes: [makeNgon(0,1,2.5,32)],
};

const REALISTIC_A = {
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

const r1 = run("Synthetic 'a' (control)", SYNTHETIC_A.outer, SYNTHETIC_A.holes, CFG);
const r2 = run("Realistic 'a' (production)", REALISTIC_A.outer, REALISTIC_A.holes, CFG);

console.log('\n══════════════════════════════');
const ok1 = r1.segs.length > 0 && r1.gcode.includes('G01') && r1.segs.flat().some(p=>p.z<-0.1);
const ok2 = r2.segs.length > 0 && r2.gcode.includes('G01') && r2.segs.flat().some(p=>p.z<-0.1);
// Verify Z is not static
function zIsVarying(segs) {
  const vals = segs.flat().map(p=>Math.round(p.z*10)/10);
  return new Set(vals).size > 3;
}
const v1 = zIsVarying(r1.segs), v2 = zIsVarying(r2.segs);
console.log(`Synthetic 'a': ${ok1?'✓ OK':'✗ FAIL — no toolpath'}  Z varying: ${v1?'✓':'✗ FLAT'}`);
console.log(`Realistic 'a': ${ok2?'✓ OK':'✗ FAIL — no toolpath'}  Z varying: ${v2?'✓':'✗ FLAT'}`);
