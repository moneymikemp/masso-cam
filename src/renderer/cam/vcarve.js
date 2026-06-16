// Phase 2: V-Carve path reconstruction and G-code generation.
//
// Pipeline:
//   erodeWithHistory   — erosion loop with annular-ring vertex emission and
//                        stroke-ridge mining; only the outermost (largest) ring
//                        is emitted as a skeleton ring — inner hole boundaries
//                        collapse to a single vertexCenter terminal instead.
//   deduplicateNodes   — merge event nodes within 1.5×stepSize radius
//   buildGraph         — 2×stepSize proximity edges + explicit ring cycles +
//                        MST bridge that includes fully-isolated nodes so no
//                        terminal or junction node is ever left orphaned
//   traverseGraph      — DFS + backtrack with Z-slope continuity preference
//   generateGCode      — G21/G90 metric G-code

import {
  offsetPolyline,
  differencePolygons,
  isClockwise,
  stripClose,
  polygonArea,
} from './offset.js';

// ── Geometry helpers ──────────────────────────────────────────────────────────

function vertexCenter(pts) {
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  return { x: sx / pts.length, y: sy / pts.length };
}

function bboxCenter(pts) {
  let mnX = pts[0].x, mxX = pts[0].x, mnY = pts[0].y, mxY = pts[0].y;
  for (const p of pts) {
    if (p.x < mnX) mnX = p.x; if (p.x > mxX) mxX = p.x;
    if (p.y < mnY) mnY = p.y; if (p.y > mxY) mxY = p.y;
  }
  return { x: (mnX + mxX) / 2, y: (mnY + mxY) / 2 };
}

function dist2(a, b) { return (a.x - b.x) ** 2 + (a.y - b.y) ** 2; }
function dist3(a, b) { return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2); }

// Minimum distance from point p to line segment [a, b].
function ptSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Minimum distance from point p to the nearest edge of any boundary polygon.
// This gives the true local half-width at p, used to compute Z = -(R / tan(angle)).
function wallDist(p, outer, holes) {
  let minD = Infinity;
  const on = outer.length;
  for (let i = 0; i < on; i++) {
    const d = ptSegDist(p, outer[i], outer[(i + 1) % on]);
    if (d < minD) minD = d;
  }
  for (const h of holes) {
    const hn = h.length;
    for (let i = 0; i < hn; i++) {
      const d = ptSegDist(p, h[i], h[(i + 1) % hn]);
      if (d < minD) minD = d;
    }
  }
  return minD;
}

function computeValidPaths(outer, holes, d) {
  const so = offsetPolyline(outer, d, true);
  if (!so?.length) return [];
  const vo = so.filter(r => r?.length >= 3);
  if (!vo.length) return [];
  if (!holes?.length) return vo;
  const eh = holes.flatMap(h => offsetPolyline(h, -d, true)).filter(r => r?.length >= 3);
  if (!eh.length) return vo;
  const res = [];
  for (const oc of vo) {
    for (const p of differencePolygons(oc, eh)) if (p?.length >= 3) res.push(p);
  }
  return res;
}

function greedyMatch(prevCenters, curCenters) {
  const claimed = new Set();
  const prevMatch = new Array(prevCenters.length).fill(-1);
  for (let pi = 0; pi < prevCenters.length; pi++) {
    let best = -1, bd = Infinity;
    for (let ci = 0; ci < curCenters.length; ci++) {
      if (claimed.has(ci)) continue;
      const d = dist2(prevCenters[pi], curCenters[ci]);
      if (d < bd) { bd = d; best = ci; }
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

function sharpCorners(poly, maxDeg) {
  const pts = stripClose(poly);
  const n = pts.length;
  const thr = Math.cos(maxDeg * Math.PI / 180);
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    const ax = prev.x - cur.x, ay = prev.y - cur.y;
    const bx = next.x - cur.x, by = next.y - cur.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    if ((ax * bx + ay * by) / (la * lb) >= thr) out.push({ x: cur.x, y: cur.y });
  }
  return out;
}

// ── Erosion with history ──────────────────────────────────────────────────────

function erodeWithHistory(outer, holes, config) {
  const { stepSize, bitHalfAngleDeg, maxSteps } = config;
  const tanAngle = Math.tan(bitHalfAngleDeg * Math.PI / 180);

  const rawNodes = [];
  const rings = [];
  let ringCounter = 0;

  function pushNode(x, y, d, type, extra = {}) {
    rawNodes.push({ x, y, z: -(d / tanAngle), eventType: type, stepD: d, source: 'event', ...extra });
  }

  // Emit every vertex of the outermost collapsing ring as a skeleton node.
  // Only call this for the LARGEST area path in the collapse set — that is the
  // outer contour of the material ribbon.  Smaller paths in the same Clipper
  // result are inner hole boundaries (reversed to CCW by differencePolygons)
  // and should not produce a parallel ring; their centroid is emitted instead.
  function emitAnnularRing(poly, d) {
    const pts = stripClose([...poly]);
    const rid = ringCounter++;
    for (let vi = 0; vi < pts.length; vi++) {
      rawNodes.push({
        x: pts[vi].x, y: pts[vi].y, z: -(d / tanAngle),
        eventType: 'terminal', source: 'annular', stepD: d,
        ringId: rid, ringIdx: vi, ringLen: pts.length,
      });
    }
  }

  function mineRidgePoints(startRingIdx) {
    for (let ri = startRingIdx; ri < rings.length; ri++) {
      const { d, paths } = rings[ri];
      // Only mine corners from the largest-area path at each depth — that is the
      // outer stroke contour. Smaller paths (stem channels, inner hole boundaries)
      // produce spurious corner clusters that create star-pattern traversal artifacts.
      const mainPath = paths.reduce((best, p) =>
        polygonArea(p) > polygonArea(best) ? p : best, paths[0]);
      for (const c of sharpCorners(mainPath, 120)) {
        rawNodes.push({ x: c.x, y: c.y, z: -(d / tanAngle),
          eventType: 'terminal', source: 'event', stepD: d });
      }
    }
  }

  // Classify and emit paths from a termination event.
  // The largest-area path is the outer contour → annular ring vertices.
  // All other paths are inner hole boundaries reversed to CCW → single centroid.
  function emitCollapse(paths, d) {
    const sorted = [...paths].sort((a, b) => polygonArea(b) - polygonArea(a));
    const mineThresh = stepSize * stepSize * 50;
    for (let pi = 0; pi < sorted.length; pi++) {
      const p = sorted[pi];
      if (pi === 0 && polygonArea(p) > mineThresh) {
        emitAnnularRing(p, d);
        mineRidgePoints(Math.floor(rings.length * 0.5));
      } else {
        const c = vertexCenter(p);
        pushNode(c.x, c.y, d, 'terminal');
      }
    }
  }

  let prevPaths = computeValidPaths(outer, holes, stepSize);
  if (!prevPaths.length) return { rawNodes, rings };
  rings.push({ d: stepSize, paths: prevPaths });

  for (let i = 2; i <= maxSteps; i++) {
    const curD  = i * stepSize;
    const prevD = (i - 1) * stepSize;
    const curPaths = computeValidPaths(outer, holes, curD);

    if (curPaths.length === 0) {
      emitCollapse(prevPaths, prevD);
      prevPaths = [];
      break;
    }

    const prevCenters = prevPaths.map(bboxCenter);
    const curCenters  = curPaths.map(bboxCenter);

    if (curPaths.length !== prevPaths.length) {
      const { prevMatch, orphanCurs } = greedyMatch(prevCenters, curCenters);

      // Terminated prevPaths — use emitCollapse so the largest is a ring, rest are centroids.
      const terminated = prevPaths.filter((_, pi) => prevMatch[pi] < 0);
      if (terminated.length > 0) emitCollapse(terminated, prevD);

      for (const ci of orphanCurs) {
        let bestPi = 0, bd = dist2(curCenters[ci], prevCenters[0]);
        for (let pi = 1; pi < prevCenters.length; pi++) {
          const d = dist2(curCenters[ci], prevCenters[pi]);
          if (d < bd) { bd = d; bestPi = pi; }
        }
        const c = vertexCenter(prevPaths[bestPi]);
        pushNode(c.x, c.y, prevD, 'junction');
      }
    } else {
      const jumpThresh = (20 * stepSize) ** 2;
      for (let pi = 0; pi < prevPaths.length; pi++) {
        let bd2 = dist2(prevCenters[pi], curCenters[0]);
        for (let ci = 1; ci < curCenters.length; ci++) {
          const d2 = dist2(prevCenters[pi], curCenters[ci]);
          if (d2 < bd2) bd2 = d2;
        }
        if (bd2 > jumpThresh) {
          const c = vertexCenter(prevPaths[pi]);
          pushNode(c.x, c.y, prevD, 'junction');
        }
      }
    }

    rings.push({ d: curD, paths: curPaths });
    prevPaths = curPaths;
  }

  for (const p of prevPaths) {
    const c = vertexCenter(p);
    pushNode(c.x, c.y, maxSteps * stepSize, 'terminal');
  }

  return { rawNodes, rings };
}

// ── Step A: Spatial deduplication ────────────────────────────────────────────

export function deduplicateNodes(rawNodes, stepSize) {
  const rSq = (1.5 * stepSize) ** 2;
  const out  = [];
  const used = new Set();

  for (let i = 0; i < rawNodes.length; i++) {
    if (used.has(i)) continue;

    if (rawNodes[i].source !== 'event') {
      out.push({ ...rawNodes[i] });
      continue;
    }

    const group = [rawNodes[i]];
    used.add(i);
    for (let j = i + 1; j < rawNodes.length; j++) {
      if (used.has(j) || rawNodes[j].source !== 'event') continue;
      if (dist2(rawNodes[i], rawNodes[j]) <= rSq) {
        group.push(rawNodes[j]);
        used.add(j);
      }
    }

    const avgX = group.reduce((s, n) => s + n.x, 0) / group.length;
    const avgY = group.reduce((s, n) => s + n.y, 0) / group.length;
    const minZ = Math.min(...group.map(n => n.z));
    const type = group.some(n => n.eventType === 'junction') ? 'junction' : 'terminal';
    out.push({ x: avgX, y: avgY, z: minZ, eventType: type, source: 'event', stepD: group[0].stepD });
  }
  return out;
}

// ── Step C: Adjacency graph ───────────────────────────────────────────────────

export function buildGraph(nodes, stepSize) {
  const n = nodes.length;
  for (let i = 0; i < n; i++) nodes[i].id = i;

  const adj = Array.from({ length: n }, () => []);

  function addEdge(a, b) {
    if (a === b) return;
    if (adj[a].some(e => e.toId === b)) return;
    const d = dist3(nodes[a], nodes[b]);
    adj[a].push({ toId: b, dist: d });
    adj[b].push({ toId: a, dist: d });
  }

  // Rule 1: 2D proximity — nodes within 2×stepSize connect automatically.
  const thr2d = (2.0 * stepSize) ** 2;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
      if (dx * dx + dy * dy <= thr2d) addEdge(i, j);
    }
  }

  // Rule 2: Annular ring cycle — sequential edges through the ring, plus one
  // bridge from the ring to the nearest non-ring skeleton node.
  const ringGroups = new Map();
  for (let i = 0; i < n; i++) {
    if (nodes[i].source !== 'annular') continue;
    const rg = ringGroups.get(nodes[i].ringId) ?? [];
    rg.push(i);
    ringGroups.set(nodes[i].ringId, rg);
  }

  for (const [, rg] of ringGroups) {
    rg.sort((a, b) => nodes[a].ringIdx - nodes[b].ringIdx);
    for (let k = 0; k < rg.length; k++) addEdge(rg[k], rg[(k + 1) % rg.length]);

    let bestRi = rg[0], bestSk = -1, bestD = Infinity;
    for (const ri of rg) {
      for (let j = 0; j < n; j++) {
        if (nodes[j].source === 'annular' && nodes[j].ringId === nodes[ri].ringId) continue;
        const d = dist2(nodes[ri], nodes[j]);
        if (d < bestD) { bestD = d; bestRi = ri; bestSk = j; }
      }
    }
    if (bestSk >= 0) addEdge(bestRi, bestSk);
  }

  // Rule 3: MST bridge — iteratively connect the closest pair from different
  // components until the graph is fully connected.  Isolated nodes (adj = [])
  // are assigned their own single-node component so they are never skipped.
  function getComps() {
    const c = new Array(n).fill(-1); let cc = 0;
    for (let s = 0; s < n; s++) {
      if (c[s] >= 0) continue;
      if (!adj[s].length) { c[s] = cc++; continue; } // isolated → own component
      const q = [s]; c[s] = cc;
      for (let qi = 0; qi < q.length; qi++)
        for (const e of adj[q[qi]]) if (c[e.toId] < 0) { c[e.toId] = cc; q.push(e.toId); }
      cc++;
    }
    return { c, cc };
  }

  let { c: comp, cc: compCount } = getComps();
  while (compCount > 1) {
    let ba = -1, bb = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (comp[i] === comp[j]) continue;
        const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
        const d  = dx * dx + dy * dy;
        if (d < bd) { bd = d; ba = i; bb = j; }
      }
    }
    if (ba < 0) break;
    addEdge(ba, bb);
    ({ c: comp, cc: compCount } = getComps());
  }

  return { nodes, adj };
}

// ── Graph traversal: DFS with backtracking ───────────────────────────────────

function dfsComponent(nodes, adj, startId, stepSize) {
  const visited = new Set([startId]);
  const path = [nodes[startId]];
  const stack = [{ id: startId, prevZ: nodes[startId].z }];

  while (stack.length > 0) {
    const { id: v, prevZ } = stack[stack.length - 1];
    const curZ = nodes[v].z;
    const dz   = curZ - prevZ;

    // XY direction of current movement — used to penalise reversals so the tool
    // prefers to keep moving forward through a cluster rather than zig-zagging.
    const stackLen = stack.length;
    const prevId = stackLen >= 2 ? stack[stackLen - 2].id : -1;
    const dirX = prevId >= 0 ? nodes[v].x - nodes[prevId].x : 0;
    const dirY = prevId >= 0 ? nodes[v].y - nodes[prevId].y : 0;
    const dirLen = Math.hypot(dirX, dirY);

    let chosen = null, bestScore = Infinity;
    for (const e of adj[v]) {
      if (visited.has(e.toId)) continue;
      const zScore = Math.abs(nodes[e.toId].z - curZ - dz);

      let dirPenalty = 0;
      if (dirLen > 1e-6) {
        const toX = nodes[e.toId].x - nodes[v].x;
        const toY = nodes[e.toId].y - nodes[v].y;
        const toLen = Math.hypot(toX, toY);
        if (toLen > 1e-6) {
          const dot = (dirX * toX + dirY * toY) / (dirLen * toLen);
          // (1 - dot) is 0 for straight-ahead, 2 for full reversal; scale by
          // stepSize so penalty is in the same mm range as the Z-slope score.
          dirPenalty = (1 - dot) * stepSize;
        }
      }

      const score = zScore + dirPenalty;
      if (score < bestScore) { bestScore = score; chosen = e; }
    }

    if (chosen) {
      visited.add(chosen.toId);
      path.push(nodes[chosen.toId]);
      stack.push({ id: chosen.toId, prevZ: curZ });
    } else {
      stack.pop();
      if (stack.length > 0) path.push(nodes[stack[stack.length - 1].id]);
    }
  }
  return path;
}

export function traverseGraph(nodes, adj, stepSize = 0.05) {
  if (!nodes.length) return [];

  const n = nodes.length;
  const comp = new Array(n).fill(-1);
  let compCount = 0;

  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    // Include isolated nodes — they are already bridged by buildGraph's MST step.
    if (!adj[s].length) { comp[s] = compCount++; continue; }
    const q = [s]; comp[s] = compCount;
    for (let qi = 0; qi < q.length; qi++)
      for (const e of adj[q[qi]]) if (comp[e.toId] < 0) { comp[e.toId] = compCount; q.push(e.toId); }
    compCount++;
  }

  const segments = [];
  for (let c = 0; c < compCount; c++) {
    const compIds = [];
    for (let i = 0; i < n; i++) if (comp[i] === c) compIds.push(i);
    if (compIds.length < 2) continue;

    const terminals  = compIds.filter(id => adj[id].length === 1);
    const candidates = terminals.length > 0 ? terminals : compIds;
    const startId = candidates.reduce((best, id) =>
      (nodes[id].x ** 2 + nodes[id].y ** 2) < (nodes[best].x ** 2 + nodes[best].y ** 2) ? id : best,
      candidates[0]);

    const seg = dfsComponent(nodes, adj, startId, stepSize);
    if (seg.length > 1) segments.push(seg);
  }
  return segments;
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
    '; V-Carve — MassoCAM Phase 2',
    'G21       ; metric mm',
    'G90       ; absolute',
    `S${spindleRPM} M03 ; spindle CW`,
    `G00 Z${fmt(safeZ)} ; lift to safe height`,
  ];

  for (const seg of segments) {
    if (seg.length < 2) continue;
    const s = seg[0];
    lines.push(`G00 X${fmt(s.x)} Y${fmt(s.y)}`);
    lines.push(`G01 Z${fmt(s.z)} F${plungeRate}`);
    for (let i = 1; i < seg.length; i++) {
      const p = seg[i];
      lines.push(`G01 X${fmt(p.x)} Y${fmt(p.y)} Z${fmt(p.z)} F${feedRate}`);
    }
    lines.push(`G00 Z${fmt(safeZ)}`);
  }

  lines.push('M05 ; spindle off', 'M30 ; end program');
  return lines.join('\n');
}

// ── Public API ───────────────────────────────────────────────────────────────

export function computeVCarveToolpath(outerPolygon, innerHoles = [], config = {}) {
  const {
    stepSize        = 0.05,
    bitHalfAngleDeg = 45,
    maxSteps        = 3000,
    safeZ           = 5.0,
    feedRate        = 1499,
    plungeRate      = 305,
    spindleRPM      = 18000,
  } = config;

  const tanAngle = Math.tan(bitHalfAngleDeg * Math.PI / 180);

  // Normalise windings: outer CCW, holes CCW (offsetPolyline convention).
  const outer = isClockwise(outerPolygon) ? [...outerPolygon].reverse() : outerPolygon;
  const holes = innerHoles.map(h => isClockwise(h) ? [...h].reverse() : h);

  const { rawNodes, rings } = erodeWithHistory(outer, holes, { stepSize, bitHalfAngleDeg, maxSteps });

  if (!rawNodes.length) {
    return { rawNodes: [], rings: [], dedupNodes: [], graph: null, segments: [], gcode: '; No skeleton found\n' };
  }

  const dedupNodes = deduplicateNodes(rawNodes, stepSize);
  const graph      = buildGraph(dedupNodes, stepSize);
  const segments   = traverseGraph(graph.nodes, graph.adj, stepSize);

  // Fix 1: Recompute Z for every traversal point from the actual wall distance
  // at that XY position.  This replaces the discretised erosion-step depth with
  // a continuous value: Z = -(wallDist / tan(bitHalfAngleDeg)).
  // It also corrects any Z bias introduced by deduplication or MST bridging.
  for (const seg of segments) {
    for (const p of seg) {
      const wd = wallDist(p, outer, holes);
      p.z = -(Math.max(wd, 0) / tanAngle);
    }
  }

  const gcode = generateGCode(segments, { safeZ, feedRate, plungeRate, spindleRPM });

  return { rawNodes, rings, dedupNodes, graph, segments, gcode };
}
