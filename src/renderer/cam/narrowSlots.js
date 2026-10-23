// Narrow slots for the Plasma Cut — scrap that's narrower than the kerf.
//
// A kerf-compensated path stays half a kerf (k) off the drawn line, so it
// can't get into any part of a cut-out narrower than the kerf (a slot
// between two letters, a stencil letter's waist) — nor into a notch cut
// into an outline. Those bits of scrap would be left standing. Here they
// are cut down their centerline instead: the torch runs up the middle and
// back (a spur), or through a pinch to join the loops it split into (a
// bridge). That removes the whole slot and overcuts each wall by
// k − (slot width)/2 there, and only there.
//
// How: the narrow scrap is what the compensated path can't sweep —
// (cut-out) minus ((cut-out shrunk by k) grown by k), or for an outline,
// (outline grown by k, shrunk by k) minus the outline. Each bit of it is
// rasterised with the scrap around it, thinned to a one-pixel skeleton
// (Zhang–Suen), and the skeleton inside the narrow bit — where the slot is
// at least half a kerf wide, so no wall is overcut by more than k/2 — is
// traced into a polyline and spliced into the cut.
//
// All mm. Loops are point arrays without a closing point.

import ClipperLib from 'clipper-lib';

const SCALE = 1000;
const toInt = pts => pts.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
const fromInt = path => path.map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function offsetPaths(paths, delta) {
  const co = new ClipperLib.ClipperOffset(2, 0.01 * SCALE);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta * SCALE);
  return out;
}

function clip(type, subject, clipPaths) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true);
  const out = new ClipperLib.PolyTree();
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return out;
}

/** Outer rings of a PolyTree with their holes: [[outer, ...holes]] (Clipper ints). */
function polyGroups(tree) {
  const groups = [];
  const walk = node => {
    for (const child of node.Childs()) {
      if (!child.IsHole()) {
        groups.push([child.Contour(), ...child.Childs().map(h => h.Contour())]);
        for (const h of child.Childs()) walk(h);
      }
    }
  };
  walk(tree);
  return groups;
}

/** Even-odd fill of polygons (mm) onto a grid: mask[row * w + col] = 1 inside. */
function rasterise(polys, x0, y0, g, w, h) {
  const mask = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    const y = y0 + (row + 0.5) * g;
    const xs = [];
    for (const poly of polys) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - x0) / g - 0.5)), c1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / g - 0.5));
      for (let col = c0; col <= c1; col++) mask[row * w + col] = 1;
    }
  }
  return mask;
}

/** Zhang–Suen thinning, in place. */
function thin(m, w, h) {
  const at = (r, c) => (r >= 0 && r < h && c >= 0 && c < w ? m[r * w + c] : 0);
  let changed = true;
  const del = [];
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          if (!m[r * w + c]) continue;
          const p = [at(r - 1, c), at(r - 1, c + 1), at(r, c + 1), at(r + 1, c + 1), at(r + 1, c), at(r + 1, c - 1), at(r, c - 1), at(r - 1, c - 1)];
          const b = p.reduce((s, v) => s + v, 0);
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let i = 0; i < 8; i++) if (!p[i] && p[(i + 1) % 8]) a++;
          if (a !== 1) continue;
          if (pass === 0 ? p[0] * p[2] * p[4] || p[2] * p[4] * p[6] : p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
          del.push(r * w + c);
        }
      }
      if (del.length) changed = true;
      for (const i of del) m[i] = 0;
    }
  }
}

/** Distance from a point to the nearest edge of a loop. */
function distToLoop(p, loop) {
  let best = Infinity;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[j], b = loop[i];
    const ex = b.x - a.x, ey = b.y - a.y, len2 = ex * ex + ey * ey;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * ex - p.x, a.y + t * ey - p.y));
  }
  return best;
}

/** Nearest point on a loop: { i (segment start index), p }. */
function nearestOnLoop(pt, loop) {
  let best = { d: Infinity, i: 0, p: loop[0] };
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const ex = b.x - a.x, ey = b.y - a.y, len2 = ex * ex + ey * ey;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((pt.x - a.x) * ex + (pt.y - a.y) * ey) / len2)) : 0;
    const p = { x: a.x + t * ex, y: a.y + t * ey };
    const d = dist(p, pt);
    if (d < best.d) best = { d, i, p };
  }
  return best;
}

/** Douglas–Peucker. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const a = pts[s], b = pts[e];
    let worst = -1, wd = tol;
    for (let i = s + 1; i < e; i++) {
      const ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey) || 1e-12;
      const d = Math.abs((pts[i].x - a.x) * ey - (pts[i].y - a.y) * ex) / len;
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([s, worst], [worst, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Centerlines of the narrow scrap of one closed shape.
 * loop: the drawn shape (CCW, no closing point); isHole: scrap inside (a
 * cut-out) or outside (an outline); kerf: mm. Returns polylines (mm),
 * each running from the end nearest the normal cut path to the far end.
 */
export function narrowCenterlines(loop, isHole, kerf) {
  const k = kerf / 2;
  if (!(k > 0) || loop.length < 3) return [];
  const L = [toInt(loop)];
  // What the compensated path sweeps, and the narrow scrap it misses.
  let narrow;
  if (isHole) {
    const swept = offsetPaths(offsetPaths(L, -k), k);
    narrow = clip(ClipperLib.ClipType.ctDifference, L, swept);
  } else {
    const closed = offsetPaths(offsetPaths(L, k), -k);
    narrow = clip(ClipperLib.ClipType.ctDifference, closed, L);
  }
  const g = Math.max(0.02, k / 8); // grid cell
  const minLen = kerf; // shorter bits are corner slivers, not slots
  const out = [];
  for (const group of polyGroups(narrow)) {
    const ring = fromInt(group[0]);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ring) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    if (Math.max(maxX - minX, maxY - minY) < minLen) continue;
    // Grid over the bit plus a margin, with the scrap around it, so the skeleton runs out to where the cut path is.
    const m = 2 * k + 2 * g;
    const x0 = minX - m, y0 = minY - m;
    const w = Math.ceil((maxX - minX + 2 * m) / g), h = Math.ceil((maxY - minY + 2 * m) / g);
    if (w * h > 4e6) continue;
    const scrapMask = rasterise([loop], x0, y0, g, w, h);
    if (!isHole) for (let i = 0; i < scrapMask.length; i++) scrapMask[i] ^= 1;
    const bitMask = rasterise(group.map(fromInt), x0, y0, g, w, h);
    thin(scrapMask, w, h);
    // Skeleton pixels in the bit, where the slot is at least half a kerf wide.
    const keep = new Uint8Array(w * h);
    for (let i = 0; i < keep.length; i++) {
      if (!scrapMask[i] || !bitMask[i]) continue;
      const p = { x: x0 + ((i % w) + 0.5) * g, y: y0 + (Math.floor(i / w) + 0.5) * g };
      if (distToLoop(p, loop) >= k / 2 - g) keep[i] = 1;
    }
    // Trace each connected piece: from the pixel nearest the swept edge out to the far end.
    const seen = new Uint8Array(w * h);
    for (let start = 0; start < keep.length; start++) {
      if (!keep[start] || seen[start]) continue;
      const comp = [];
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        comp.push(i);
        const r = Math.floor(i / w), c = i % w;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if ((dr || dc) && rr >= 0 && rr < h && cc >= 0 && cc < w && keep[rr * w + cc] && !seen[rr * w + cc]) { seen[rr * w + cc] = 1; stack.push(rr * w + cc); }
        }
      }
      if (comp.length * g < minLen * 0.75) continue;
      const pt = i => ({ x: x0 + ((i % w) + 0.5) * g, y: y0 + (Math.floor(i / w) + 0.5) * g });
      // Longest path through the piece (two BFS sweeps), oriented to start at the end nearer the scrap's wide part.
      const inComp = new Set(comp);
      const bfs = from => {
        const prev = new Map([[from, -1]]);
        const q = [from];
        let last = from;
        while (q.length) {
          const i = q.shift();
          last = i;
          const r = Math.floor(i / w), c = i % w;
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const j = (r + dr) * w + (c + dc);
            if ((dr || dc) && inComp.has(j) && !prev.has(j)) { prev.set(j, i); q.push(j); }
          }
        }
        return { last, prev };
      };
      const a = bfs(comp[0]).last;
      const { last: b, prev } = bfs(a);
      const path = [];
      for (let i = b; i !== -1; i = prev.get(i)) path.push(pt(i));
      // Start at the end with more room (closer to the wide part of the scrap).
      if (distToLoop(path[0], loop) < distToLoop(path[path.length - 1], loop)) path.reverse();
      out.push(simplify(path, g));
    }
  }
  return out;
}

/**
 * Splices narrow-slot centerlines into a shape's kerf-compensated cut
 * loops (already started; the start stays first). A centerline touching
 * one loop becomes a spur (in and back); one touching two loops joins them
 * (a bridge); one touching none is its own open cut.
 * Returns { loops, open: [polyline], slots: count }.
 */
export function spliceSlots(loops, centerlines, kerf) {
  const reach = kerf * 1.5; // how close a centerline end must be to a loop to join it
  let ls = loops.map(l => [...l]);
  const open = [];
  let slots = 0;
  for (const line of centerlines) {
    if (line.length < 2) continue;
    const ends = [line[0], line[line.length - 1]];
    const near = ends.map(e => ls.map((l, li) => ({ li, ...nearestOnLoop(e, l) })).sort((p, q) => p.d - q.d)[0]);
    const a = near[0] && near[0].d <= reach ? near[0] : null;
    const b = near[1] && near[1].d <= reach ? near[1] : null;
    slots++;
    if (a && b && a.li !== b.li) {
      // Bridge: loop A up to Ja, across to Jb, all the way round B, back across, on round A.
      const A = ls[a.li], B = ls[b.li];
      const Bround = [b.p, ...B.slice(b.i + 1), ...B.slice(0, b.i + 1), b.p];
      const joined = [...A.slice(0, a.i + 1), a.p, ...line, ...Bround, ...[...line].reverse(), a.p, ...A.slice(a.i + 1)];
      ls = ls.filter((_, i) => i !== a.li && i !== b.li);
      ls.splice(Math.min(a.li, b.li), 0, joined);
    } else if (a || b) {
      // Spur: from the nearer end's attachment point up the slot and back.
      const at = a && (!b || a.d <= b.d) ? a : b;
      const spur = at === a ? line : [...line].reverse();
      const L = ls[at.li];
      ls[at.li] = [...L.slice(0, at.i + 1), at.p, ...spur, ...[...spur].reverse(), at.p, ...L.slice(at.i + 1)];
    } else {
      open.push(line);
    }
  }
  return { loops: ls, open, slots };
}
