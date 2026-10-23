// Plasma nesting — places copies of parts on a sheet (PLASMA screen → ▦ Nest).
//
// Works on no-fit polygons (NFPs): for two shapes A and B, NFP(A, B) is
// every offset of B that makes it overlap A, built as the Minkowski sum
// A ⊕ (−B) with Clipper. A placement is legal when it's outside every NFP
// and inside the sheet. A part's shape is what its cut takes out of the
// sheet — the outline grown by the kerf, plus the outside lead-in (its
// path grown by half the kerf) — grown by half the part spacing, so two
// touching shapes leave exactly one spacing of steel between the cuts.
// The pierce point also gets a clearance circle (pierce separation).
// Holes are ignored, so nothing nests inside a hole.
//
// Two strategies:
//  - Array: one part, many copies (stakes, brackets). Tries the part alone
//    and paired with a 180° copy, at a range of angles, and for each finds
//    the tightest repeating lattice (one row vector along X, one slanted
//    vector between rows) from the NFPs. The lattice with the most parts on
//    the sheet wins. This is what gives ProNest-style interlocked rows.
//  - Mixed: several parts. By priority, then biggest first, each at the
//    leftmost (then lowest) legal spot, trying its allowed rotations —
//    bottom-left fill over NFP vertices.
//  - Part lists (nestSheets): per sheet, each part with many copies left
//    goes down as an array block in its own strip, left to right in
//    priority order; the rest fill in around them. Then on to the next
//    sheet until everything is placed.
//
// All units mm. A part's local frame is centred on its outline's bounding
// box; a placement { part, angle, x, y } means: rotate the part about its
// centre by `angle` (radians), then move the centre to (x, y).

import ClipperLib from 'clipper-lib';

const SCALE = 1000; // Clipper integer units per mm
const EPS = 0.002; // mm — "touching" slack
const DEG = Math.PI / 180;

// ── Polygons ────────────────────────────────────────────────────────────────

const toInt = pts => pts.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
const fromInt = path => path.map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));

function rotatePts(pts, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return pts.map(p => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
}

function bboxOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function area(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return Math.abs(a / 2);
}

/**
 * The nesting shape: the union of `pieces` — [{ pts, closed, grow }], each
 * grown by its own `grow` mm (round corners; open pieces like a lead-in get
 * round ends) — as one outer outline, simplified to at most `maxPts` points.
 * NFP cost goes with the product of two shapes' point counts, and a real
 * part's arcs come in as hundreds of points. Steps, until it fits:
 *  - simplify within a growing tolerance (the pieces are grown by it first,
 *    so the shape never shrinks inside them);
 *  - then also close notches narrower than twice a growing radius (grow by
 *    it, shrink back) — a tree's spikes or a sign's lettering edge, where no
 *    other part could fit anyway.
 * Either way the shape only ever grows, so clearances stay guaranteed.
 */
function nestShape(pieces, maxPts = 80) {
  const steps = [];
  for (let tol = 0.01; tol <= 0.65; tol *= 2) steps.push({ tol, close: 0 });
  for (let close = 1; close <= 32; close *= 2) steps.push({ tol: Math.max(0.64, close / 6), close });
  let path = null;
  for (const { tol, close } of steps) {
    const c = new ClipperLib.Clipper();
    for (const piece of pieces) {
      const co = new ClipperLib.ClipperOffset(2, Math.max(0.05, tol) * SCALE);
      co.AddPath(toInt(piece.pts), ClipperLib.JoinType.jtRound, piece.closed ? ClipperLib.EndType.etClosedPolygon : ClipperLib.EndType.etOpenRound);
      const grown = new ClipperLib.Paths();
      co.Execute(grown, (piece.grow + tol + close) * SCALE);
      c.AddPaths(grown, ClipperLib.PolyType.ptSubject, true);
    }
    let out = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    if (close > 0 && out.length) {
      const back = new ClipperLib.ClipperOffset(2, Math.max(0.05, tol) * SCALE);
      back.AddPaths(out, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
      const shrunk = new ClipperLib.Paths();
      back.Execute(shrunk, -close * SCALE);
      out = shrunk;
    }
    if (!out.length) return pieces[0].pts;
    let best = out[0];
    for (const p of out) if (Math.abs(ClipperLib.Clipper.Area(p)) > Math.abs(ClipperLib.Clipper.Area(best))) best = p;
    const light = ClipperLib.JS.Lighten(best, tol * SCALE);
    path = light.length >= 3 ? light : best; // a single path in, a single path out
    if (path.length <= maxPts) break;
  }
  if (!ClipperLib.Clipper.Orientation(path)) path.reverse();
  return fromInt(path);
}

/**
 * A ring set for fast queries: flat coordinates + bounds per ring. Only
 * outer rings are kept and the set is their union — holes are dropped
 * (nothing nests in a hole), and Clipper's Minkowski output can include
 * zero-area sliver holes that would otherwise flip an even-odd test.
 */
function makeRings(paths) {
  const rings = paths.filter(p => p.length >= 3 && ClipperLib.Clipper.Area(p) > 1).map(p => {
    const xs = new Float64Array(p.length), ys = new Float64Array(p.length);
    p.forEach((q, i) => { xs[i] = q.X / SCALE; ys[i] = q.Y / SCALE; });
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < p.length; i++) {
      if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i];
      if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i];
    }
    return { xs, ys, n: p.length, minX, minY, maxX, maxY };
  });
  const b = rings.reduce((a, r) => ({ minX: Math.min(a.minX, r.minX), minY: Math.min(a.minY, r.minY), maxX: Math.max(a.maxX, r.maxX), maxY: Math.max(a.maxY, r.maxY) }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  return { rings, paths, ...b };
}

/** NFP(A, B) as Clipper paths: offsets t where B + t overlaps A. A, B are Clipper int paths. */
function nfpPaths(A, B) {
  const negB = B.map(p => ({ X: -p.X, Y: -p.Y }));
  // The paths form also unions in A itself (shifted), filling the sum's interior.
  return ClipperLib.Clipper.MinkowskiSum(negB, [A], true);
}

function rotatePaths(paths, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return paths.map(p => p.map(q => ({ X: Math.round(q.X * c - q.Y * s), Y: Math.round(q.X * s + q.Y * c) })));
}

function translatePaths(paths, dx, dy) {
  const ix = Math.round(dx * SCALE), iy = Math.round(dy * SCALE);
  return paths.map(p => p.map(q => ({ X: q.X + ix, Y: q.Y + iy })));
}

/** Strictly inside some ring of the set (more than EPS from its boundary). */
function insideRings(set, x, y) {
  if (x <= set.minX || x >= set.maxX || y <= set.minY || y >= set.maxY) return false;
  const hit = set.rings.filter(r => {
    if (x < r.minX || x > r.maxX || y < r.minY || y > r.maxY) return false;
    const { xs, ys, n } = r;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      if ((ys[i] > y) !== (ys[j] > y) && x < ((xs[j] - xs[i]) * (y - ys[i])) / (ys[j] - ys[i]) + xs[i]) inside = !inside;
    }
    return inside;
  });
  if (!hit.length) return false;
  // On (or within EPS of) an edge counts as touching, not overlapping.
  for (const r of hit) {
    if (x < r.minX - EPS || x > r.maxX + EPS || y < r.minY - EPS || y > r.maxY + EPS) continue;
    const { xs, ys, n } = r;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ex = xs[i] - xs[j], ey = ys[i] - ys[j];
      const len2 = ex * ex + ey * ey;
      let t = len2 > 0 ? ((x - xs[j]) * ex + (y - ys[j]) * ey) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = xs[j] + t * ex - x, dy = ys[j] + t * ey - y;
      if (dx * dx + dy * dy < EPS * EPS) return false;
    }
  }
  return true;
}

/** Where the line x = c (axis 'x') or y = c (axis 'y') is inside the ring set: [[from, to], …] along the other axis, ring by ring (they may overlap). */
function intervalsOnLine(set, axis, c) {
  const out = [];
  for (const r of set.rings) {
    const lo = axis === 'x' ? r.minX : r.minY, hi = axis === 'x' ? r.maxX : r.maxY;
    if (c < lo || c > hi) continue;
    const a = axis === 'x' ? r.xs : r.ys, b = axis === 'x' ? r.ys : r.xs;
    const hits = [];
    for (let i = 0, j = r.n - 1; i < r.n; j = i++) {
      if ((a[i] > c) !== (a[j] > c)) hits.push(b[j] + ((b[i] - b[j]) * (c - a[j])) / (a[i] - a[j]));
    }
    hits.sort((p, q) => p - q);
    for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i], hits[i + 1]]);
  }
  return out;
}

/** Smallest value ≥ from that isn't strictly inside any of the intervals. */
function firstFree(intervals, from) {
  const iv = intervals.filter(([, b]) => b > from).sort((p, q) => p[0] - q[0]);
  let v = from;
  for (const [a, b] of iv) {
    if (a < v - EPS && b > v + EPS) v = b;
    else if (a >= v - EPS && a < v + EPS && b > v + EPS) v = b;
  }
  return v;
}

// ── Parts ───────────────────────────────────────────────────────────────────

/**
 * Prepares parts for nesting. parts: [{ outline: [{x,y}] (closed, no closing point), qty }].
 * Adds the local-frame centre, the nesting shape (as rotate-ready points) and the area.
 */
function prepareParts(parts, opts) {
  const spacing = Math.max(0, opts.spacing || 0), kerf = Math.max(0, opts.kerf || 0);
  return parts.map((p, index) => {
    const b = bboxOf(p.outline);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const toLocal = q => ({ x: q.x - cx, y: q.y - cy });
    const local = p.outline.map(toLocal);
    // What the cut removes: the outline grown by the kerf, and the lead-in's kerf.
    const cut = [{ pts: local, closed: true, grow: kerf }];
    const leadPts = p.lead?.leadPts?.length >= 2 ? p.lead.leadPts.map(toLocal) : null;
    if (leadPts) cut.push({ pts: leadPts, closed: false, grow: kerf / 2 });
    const pieces = cut.map(c => ({ ...c, grow: c.grow + spacing / 2 }));
    // Pierce separation: no other part's cut within it of the pierce point.
    const pierceR = (opts.pierceSep || 0) - spacing / 2;
    if (p.lead?.pierce && pierceR > 0) {
      const pc = toLocal(p.lead.pierce);
      pieces.push({ pts: Array.from({ length: 32 }, (_, k) => ({ x: pc.x + Math.cos((k * Math.PI) / 16) * pierceR, y: pc.y + Math.sin((k * Math.PI) / 16) * pierceR })), closed: true, grow: 0 });
    }
    return {
      index, qty: p.qty, fill: !!p.fill, cx, cy, local,
      rotation: p.rotation, priority: p.priority ?? 5,
      shape: nestShape(pieces),
      // Mixed nesting builds an NFP per part pair and relative angle; it
      // uses a coarser (still only grown) shape, since NFP cost goes with
      // the product of the two shapes' point counts.
      coarse: nestShape(pieces, 48),
      cutShape: nestShape(cut, 400), // for the sheet edge margin
      boxAngle: minBoxAngle(local),
      area: area(local),
    };
  });
}

/** Convex hull of { x, y } points, counter-clockwise. */
function convexHull(pts) {
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = list => {
    const h = [];
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    return h.slice(0, -1);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** The rotation (radians, 0–90°) that gives the part its smallest bounding box — its convex hull's edges are the candidates. */
function minBoxAngle(pts) {
  const hull = convexHull(pts);
  let best = 0, bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = -Math.atan2(b.y - a.y, b.x - a.x);
    const bb = bboxOf(rotatePts(hull, ang));
    const ar = (bb.maxX - bb.minX) * (bb.maxY - bb.minY);
    if (ar < bestArea - 1e-6) { bestArea = ar; best = ang; }
  }
  return ((best % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
}

/** One part at one angle: Clipper shapes + the bounds of what its cut removes (for the sheet edge). */
function orient(part, angle, cache) {
  const key = `${part.index}@${angle.toFixed(6)}`;
  if (cache && cache.has(key)) return cache.get(key);
  const shape = toInt(rotatePts(part.shape, angle));
  const coarse = part.coarse ? toInt(rotatePts(part.coarse, angle)) : shape;
  const tight = bboxOf(rotatePts(part.cutShape, angle));
  const o = { part, angle, shape, coarse, tight, key };
  cache?.set(key, o);
  return o;
}

// ── Array nesting (one part, lattice) ──────────────────────────────────────

/**
 * Tightest lattice for a unit (one or two oriented shapes at offsets) with
 * the row vector v1 along +X. members: [{ o (oriented), dx, dy }].
 * Returns { w, v2: {x, y}, cellArea } or null.
 */
function bestLattice(members, nfpCache, samples = 32) {
  const sets = [];
  for (const a of members) {
    for (const b of members) {
      const key = `${a.o.key}|${b.o.key}`;
      let base = nfpCache.get(key);
      if (!base) { base = nfpPaths(a.o.shape, b.o.shape); nfpCache.set(key, base); }
      sets.push(makeRings(translatePaths(base, a.dx - b.dx, a.dy - b.dy)));
    }
  }
  // F: the forbidden lattice vectors, kept as separate ring sets (a Clipper
  // union per candidate was most of the run time). Intervals from each set
  // may overlap; firstFree copes with that.
  const F = {
    minX: Math.min(...sets.map(f => f.minX)), maxX: Math.max(...sets.map(f => f.maxX)),
    minY: Math.min(...sets.map(f => f.minY)), maxY: Math.max(...sets.map(f => f.maxY)),
  };
  if (!isFinite(F.minX)) return null;
  const linesOf = (axis, c) => sets.flatMap(f => intervalsOnLine(f, axis, c));

  // Row spacing: the first gap along +X where every multiple also clears F.
  const row = linesOf('y', 0);
  let w = firstFree(row, EPS);
  for (let guard = 0; guard < 50; guard++) {
    let moved = false;
    for (let k = 2; k * w <= F.maxX; k++) {
      const hit = row.find(([a, b]) => a < k * w - EPS && b > k * w + EPS);
      if (hit) { w = hit[1] / k; moved = true; break; }
    }
    if (!moved) break;
  }
  if (!(w > EPS) || !isFinite(w)) return null;

  // Rows: for a row shift dx, the lowest dy where rows 1, 2, … clear F.
  const dyFor = dx => {
    let m = 1, dy = EPS;
    for (let guard = 0; guard < 40; guard++) {
      const blocked = [];
      for (let k2 = 1; k2 <= m; k2++) {
        const base = k2 * dx;
        const k1Lo = Math.ceil((F.minX - base) / w), k1Hi = Math.floor((F.maxX - base) / w);
        for (let k1 = k1Lo; k1 <= k1Hi; k1++) {
          for (const [a, b] of linesOf('x', base + k1 * w)) if (b > 0) blocked.push([a / k2, b / k2]);
        }
      }
      dy = firstFree(blocked, EPS);
      if ((m + 1) * dy <= F.maxY + EPS) m++;
      else break;
    }
    return dy;
  };

  let best = null;
  const consider = dx => {
    const dy = dyFor(dx);
    if (!best || dy < best.dy - 1e-9) best = { dx, dy };
  };
  for (let i = 0; i < samples; i++) consider((i / samples) * w);
  let step = w / samples;
  for (let pass = 0; pass < 3; pass++) {
    const c = best.dx;
    for (let i = -4; i <= 4; i++) if (i) consider(((c + (i * step) / 4) % w + w) % w);
    step /= 4;
  }
  return { w, v2: { x: best.dx, y: best.dy }, cellArea: w * best.dy };
}

/** Places a lattice of units on the sheet; returns the placements that fit (best of a few phase shifts). */
function fillLattice(members, lat, sheet, blocked) {
  const { w, v2 } = lat;
  // Unit bounds (real outlines) relative to the unit origin.
  let ub = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const m of members) {
    ub = { minX: Math.min(ub.minX, m.dx + m.o.tight.minX), minY: Math.min(ub.minY, m.dy + m.o.tight.minY), maxX: Math.max(ub.maxX, m.dx + m.o.tight.maxX), maxY: Math.max(ub.maxY, m.dy + m.o.tight.maxY) };
  }
  const W = sheet.maxX - sheet.minX, H = sheet.maxY - sheet.minY;
  let best = null;
  const PH = 6;
  for (let pa = 0; pa < PH; pa++) {
    for (let pb = 0; pb < PH; pb++) {
      const ox = sheet.minX - ub.minX + (pa / PH) * w + (pb / PH) * v2.x;
      const oy = sheet.minY - ub.minY + (pb / PH) * v2.y;
      const out = [];
      const jLo = Math.floor((-(ub.maxY - ub.minY) - v2.y) / v2.y), jHi = Math.ceil(H / v2.y) + 1;
      for (let j = jLo; j <= jHi; j++) {
        const rowX = ox + j * v2.x, rowY = oy + j * v2.y;
        const iLo = Math.floor((sheet.minX - (ub.maxX - ub.minX) - rowX - ub.minX) / w) - 1, iHi = Math.ceil((sheet.maxX - rowX - ub.minX) / w) + 1;
        for (let i = iLo; i <= iHi; i++) {
          const ux = rowX + i * w;
          for (const m of members) {
            const x = ux + m.dx, y = rowY + m.dy, t = m.o.tight;
            if (x + t.minX < sheet.minX - EPS || x + t.maxX > sheet.maxX + EPS || y + t.minY < sheet.minY - EPS || y + t.maxY > sheet.maxY + EPS) continue;
            if (blocked && blocked(m.o, x, y)) continue;
            out.push({ part: m.o.part.index, angle: m.o.angle, x, y, left: x + t.minX, right: x + t.maxX, bottom: y + t.minY });
          }
        }
      }
      const used = out.length ? Math.max(...out.map(p => p.right)) - sheet.minX : 0;
      if (!best || out.length > best.length || (out.length === best.length && used < best.used)) best = Object.assign(out, { used });
    }
  }
  void W;
  return best || [];
}

// Fitting an array around parts already on the sheet: every lattice when
// there are only a few, else the tightest few angles' lattices.
const OBSTACLES_FULL = 10;
const OBSTACLE_LATTICES = 12;
const OBSTACLES_MAX = 40; // beyond this, the array goes in a strip past them instead

/**
 * Array nest of one part. opts: { angleStep (deg), allowPairs, obstacles, onProgress }.
 * Yields to the UI between angles. Returns { placements, info }.
 */
async function arrayNest(part, sheet, qty, opts) {
  const step = Math.max(1, opts.angleStep || 5);
  const cache = new Map(), nfpCache = new Map();
  const yieldToUI = () => new Promise(r => setTimeout(r, 0));
  // opts.obstacles: parts already on the sheet ([{ o, x, y }]); lattice
  // copies that would hit one are left out, so the array fills in around them.
  // Each obstacle's NFP is only built once a copy comes near it.
  const obstacles = opts.obstacles || [];
  const near = Math.max(0, opts.spacing || 0) + Math.max(0, opts.pierceSep || 0) + 1;
  const obstacleNfps = new Map();
  const blocked = obstacles.length ? (o, x, y) => {
    let sets = obstacleNfps.get(o.key);
    if (!sets) { sets = obstacles.map(() => null); obstacleNfps.set(o.key, sets); }
    const t = o.tight;
    return obstacles.some((ob, i) => {
      const u = ob.o.tight;
      if (x + t.maxX + near < ob.x + u.minX || x + t.minX - near > ob.x + u.maxX
        || y + t.maxY + near < ob.y + u.minY || y + t.minY - near > ob.y + u.maxY) return false;
      if (!sets[i]) sets[i] = makeRings(translatePaths(nfpPaths(ob.o.coarse, o.coarse), ob.x, ob.y));
      return insideRings(sets[i], x, y);
    });
  } : null;
  let best = null;
  // With obstacles, fitting a lattice around them is the slow part, so the
  // sweep only ranks lattices by how tight they are; the best few per
  // angle are fitted afterwards.
  let ranked = obstacles.length > OBSTACLES_FULL ? [] : null;
  const evaluate = (members, label) => {
    const lat = bestLattice(members, nfpCache);
    if (!lat) return null;
    if (ranked) { ranked.push({ members, label, cell: lat.cellArea / members.length }); return null; }
    const placed = fillLattice(members, lat, sheet, blocked);
    const count = qty ? Math.min(qty, placed.length) : placed.length;
    const cand = { placed, count, cellArea: lat.cellArea / members.length, label };
    if (!best || count > best.count || (count === best.count && cand.cellArea < best.cellArea - 1e-6)) best = cand;
    return cand;
  };

  // Turning both shapes turns their NFP the same way, so the four NFPs
  // (part/part, part/180° copy and back) are built once and rotated per angle.
  const P0 = orient(part, 0), P1 = orient(part, Math.PI);
  const baseNfp = {
    '00': nfpPaths(P0.shape, P0.shape),
    '01': opts.allowPairs === false ? null : nfpPaths(P0.shape, P1.shape),
  };
  baseNfp['11'] = baseNfp['00']; // a 180° turn maps NFP(P, P) onto itself
  baseNfp['10'] = baseNfp['01'] && baseNfp['01'].map(p => p.map(q => ({ X: -q.X, Y: -q.Y })));

  // Best arrangement at one angle (degrees): the part alone, and paired with a 180° copy.
  const tryAngle = async deg => {
    const theta = deg * DEG;
    const A = orient(part, theta, cache);
    const B = orient(part, theta + Math.PI, cache);
    for (const [k, a, b] of [['00', A, A], ['01', A, B], ['10', B, A], ['11', B, B]]) {
      if (baseNfp[k]) nfpCache.set(`${a.key}|${b.key}`, rotatePaths(baseNfp[k], theta));
    }
    evaluate([{ o: A, dx: 0, dy: 0 }], `single ${deg}°`);
    if (opts.allowPairs === false) return;
    const nAB = makeRings(nfpCache.get(`${A.key}|${B.key}`));
    // Pair offsets on the outer boundary of NFP(A, B): B touching A.
    const outer = nAB.rings.reduce((p, r) => (!p || (r.maxX - r.minX) * (r.maxY - r.minY) > (p.maxX - p.minX) * (p.maxY - p.minY) ? r : p), null);
    if (!outer) return;
    const N = Math.min(outer.n, 64);
    const scored = [];
    for (let k = 0; k < N; k++) {
      const idx = Math.floor((k * outer.n) / N);
      const lat = bestLattice([{ o: A, dx: 0, dy: 0 }, { o: B, dx: outer.xs[idx], dy: outer.ys[idx] }], nfpCache, 16);
      if (lat) scored.push({ idx, cell: lat.cellArea });
      if (k % 10 === 9) { await yieldToUI(); if (opts.cancelled?.()) return; }
    }
    scored.sort((p, q) => p.cell - q.cell);
    // Refine the best few: neighbouring boundary points, full lattice search.
    for (const sc of scored.slice(0, 3)) {
      for (let d = -3; d <= 3; d++) {
        const idx = (sc.idx + d + outer.n) % outer.n;
        evaluate([{ o: A, dx: 0, dy: 0 }, { o: B, dx: outer.xs[idx], dy: outer.ys[idx] }], `pair ${deg}°`);
      }
      await yieldToUI();
    }
  };

  const angles = [];
  for (let a = 0; a < 180 - 1e-9; a += step) angles.push(a);
  for (let i = 0; i < angles.length; i++) {
    await tryAngle(angles[i]);
    opts.onProgress?.(((i + 1) / angles.length) * (ranked ? 0.5 : 1));
    if (opts.cancelled?.()) break;
  }
  if (ranked) {
    const bestPerAngle = new Map();
    for (const r of ranked) if (!bestPerAngle.has(r.label) || r.cell < bestPerAngle.get(r.label).cell) bestPerAngle.set(r.label, r);
    const top = [...bestPerAngle.values()].sort((p, q) => p.cell - q.cell).slice(0, OBSTACLE_LATTICES);
    ranked = null;
    for (let i = 0; i < top.length; i++) {
      evaluate(top[i].members, top[i].label);
      opts.onProgress?.(0.5 + ((i + 1) / top.length) * 0.5);
      await yieldToUI();
      if (opts.cancelled?.()) break;
    }
  }
  opts.onProgress?.(1);
  if (!best) return { placements: [], info: 'No arrangement fits on the sheet.' };
  const kept = [...best.placed].sort((p, q) => p.left - q.left || p.y - q.y).slice(0, best.count);
  // A partial block (fewer copies than the sheet holds) slides down and left
  // into the corner, moved as one so the spacing between copies stays — not
  // when it was fitted around parts already on the sheet.
  const slide = kept.length && !obstacles.length;
  const dx = slide ? sheet.minX - Math.min(...kept.map(p => p.left)) : 0;
  const dy = slide ? sheet.minY - Math.min(...kept.map(p => p.bottom)) : 0;
  const placements = kept.map(p => ({ ...p, x: p.x + dx, y: p.y + dy, left: p.left + dx, right: p.right + dx, bottom: p.bottom + dy }));
  return { placements, info: best.label };
}

// ── Mixed nesting (bottom-left fill) ───────────────────────────────────────

/**
 * Rotations to try for a part in a mixed nest: its own setting, else the
 * nest's. "Any" here means the four square turns plus the four that give
 * the part its smallest bounding box — every rotation is tried for every
 * copy against every placed part, so a fine sweep is too slow.
 */
function mixedAngles(part, rotation) {
  if (rotation === 'none') return [0];
  const quarter = [0, 1, 2, 3].map(k => (k * Math.PI) / 2);
  if (rotation === '90' || !(part.boxAngle > 1e-3)) return quarter;
  return [...quarter, ...quarter.map(a => a + part.boxAngle)];
}

/** preplaced: [{ o, x, y }] already on the sheet (an array block) — the rest go around them. */
async function mixedNest(parts, sheet, opts, preplaced = []) {
  const cache = new Map();
  // NFP(R_a X, R_b Y) = R_a · NFP(X, R_(b−a) Y): one NFP per part pair and
  // relative angle, turned to each placed copy's angle (and cached so).
  const relCache = new Map(), turnedCache = new Map();
  const nfpFor = (placedO, o) => {
    const rel = (((o.angle - placedO.angle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const key = `${placedO.part.index}|${o.part.index}@${rel.toFixed(6)}`;
    let base = relCache.get(key);
    if (!base) {
      base = nfpPaths(orient(placedO.part, 0, cache).coarse, orient(o.part, rel, cache).coarse);
      relCache.set(key, base);
    }
    if (!placedO.angle) return base;
    const tkey = `${key}#${placedO.angle.toFixed(6)}`;
    let turned = turnedCache.get(tkey);
    if (!turned) { turned = rotatePaths(base, placedO.angle); turnedCache.set(tkey, turned); }
    return turned;
  };
  const items = [];
  for (const p of parts) for (let i = 0; i < p.qty; i++) items.push(p);
  items.sort((p, q) => !!p.fill - !!q.fill || p.priority - q.priority || q.area - p.area);

  const placed = [...preplaced];
  const unplaced = [];
  const full = new Set(); // parts that didn't fit: more copies won't either
  for (let n = 0; n < items.length; n++) {
    const part = items[n];
    if (full.has(part.index)) { unplaced.push(part.index); continue; }
    let best = null;
    for (const angle of mixedAngles(part, part.rotation || opts.rotation)) {
      const o = orient(part, angle, cache);
      const t = o.tight;
      const ifp = { minX: sheet.minX - t.minX, maxX: sheet.maxX - t.maxX, minY: sheet.minY - t.minY, maxY: sheet.maxY - t.maxY };
      if (ifp.minX > ifp.maxX + EPS || ifp.minY > ifp.maxY + EPS) continue;
      const nfps = placed.map(pl => makeRings(translatePaths(nfpFor(pl.o, o), pl.x, pl.y)));
      const cands = [{ x: ifp.minX, y: ifp.minY }, { x: ifp.minX, y: ifp.maxY }, { x: ifp.maxX, y: ifp.minY }];
      for (const f of nfps) {
        for (const r of f.rings) for (let i = 0; i < r.n; i++) cands.push({ x: r.xs[i], y: r.ys[i] });
        for (const [a, b] of intervalsOnLine(f, 'x', ifp.minX)) cands.push({ x: ifp.minX, y: a }, { x: ifp.minX, y: b });
        for (const [a, b] of intervalsOnLine(f, 'y', ifp.minY)) cands.push({ x: a, y: ifp.minY }, { x: b, y: ifp.minY });
      }
      const key = c => Math.round(c.x / 0.5) * 1e6 + c.y;
      cands.sort((p, q) => key(p) - key(q));
      for (const c of cands) {
        if (c.x < ifp.minX - EPS || c.x > ifp.maxX + EPS || c.y < ifp.minY - EPS || c.y > ifp.maxY + EPS) continue;
        if (best && key(c) >= key(best)) break;
        if (nfps.some(f => insideRings(f, c.x, c.y))) continue;
        best = { o, x: c.x, y: c.y };
        break;
      }
    }
    if (best) placed.push(best);
    else { unplaced.push(part.index); full.add(part.index); }
    opts.onProgress?.((n + 1) / items.length);
    if (n % 2 === 1) await new Promise(r => setTimeout(r, 0));
    if (opts.cancelled?.()) break;
  }
  const placements = placed.slice(preplaced.length).map(p => ({ part: p.o.part.index, angle: p.o.angle, x: p.x, y: p.y }));
  return { placements, info: unplaced.length ? `${unplaced.length} part${unplaced.length === 1 ? '' : 's'} didn't fit` : '' };
}

/** Array-nest options for one part's rotation setting. */
function arrayOpts(opts, rotation) {
  if (rotation === 'none') return { ...opts, angleStep: 180, allowPairs: false };
  if (rotation === '90') return { ...opts, angleStep: 90 };
  return opts;
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * parts: [{ outline, qty, lead }] — qty 0 on a single part means "fill the
 * sheet"; lead is the outside lead-in from plasmaToolpath's outsideLead.
 * sheet: { minX, minY, maxX, maxY } (already inset by the edge margin).
 * opts: { spacing, kerf, pierceSep, rotation: 'any' | '90' | 'none', angleStep, allowPairs, onProgress, cancelled }.
 * Returns { placements: [{ part, angle, x, y }], parts (prepared: cx, cy per part), utilization, info }.
 */
export async function nestParts(parts, sheet, opts = {}) {
  const prepared = prepareParts(parts, opts);
  let result;
  if (prepared.length === 1 && opts.rotation !== '90' && opts.rotation !== 'none') {
    result = await arrayNest(prepared[0], sheet, prepared[0].qty || 0, opts);
  } else if (prepared.length === 1 && !prepared[0].qty) {
    // Fill with restricted rotation: lattice at the allowed angles only.
    const angleStep = opts.rotation === 'none' ? 180 : 90;
    result = await arrayNest(prepared[0], sheet, 0, { ...opts, angleStep });
  } else {
    result = await mixedNest(prepared.map(p => ({ ...p, qty: p.qty || 1 })), sheet, opts);
  }
  const used = result.placements.reduce((s, pl) => s + prepared[pl.part].area, 0);
  const sheetArea = (sheet.maxX - sheet.minX) * (sheet.maxY - sheet.minY);
  return { ...result, parts: prepared, utilization: sheetArea > 0 ? used / sheetArea : 0 };
}

/**
 * A part list onto as many sheets as it takes.
 * parts: [{ outline, lead, qty, fill, priority, rotation }] (qty ≥ 1, or fill:
 * as many as fit in the room left on each sheet).
 * sheetSizes: [{ w, l, count }] in mm, used in order; count 0/blank = as
 * many as needed. opts: as nestParts, plus margin (mm).
 * Returns { sheets: [{ w, l, placements, utilization }], parts (prepared),
 * placed: count per part, unplaced: count per part }.
 */
export async function nestSheets(parts, sheetSizes, opts = {}) {
  const prepared = prepareParts(parts, opts);
  // Fill parts have no count: they take whatever room each sheet has left
  // after the counted parts, and only get a sheet of their own when there
  // are no counted parts at all.
  const remaining = prepared.map(p => (p.fill ? Infinity : Math.max(0, Math.round(p.qty || 0))));
  const placedCount = prepared.map(() => 0);
  const countedLeft = () => prepared.reduce((s, p) => s + (p.fill ? 0 : remaining[p.index]), 0);
  const total = Math.max(1, countedLeft());
  const sheets = [];
  const margin = Math.max(0, opts.margin || 0);
  const cache = new Map();

  for (const size of sheetSizes) {
    const limit = size.count > 0 ? size.count : Infinity;
    for (let used = 0; used < limit && sheets.length < 100; used++) {
      if (opts.cancelled?.()) break;
      if (!countedLeft() && (sheets.length || !prepared.some(p => p.fill))) break;
      const sheet = { minX: margin, minY: margin, maxX: size.w - margin, maxY: size.l - margin };
      const sheetArea = (sheet.maxX - sheet.minX) * (sheet.maxY - sheet.minY);
      const done = total - countedLeft();
      const sub = { ...opts, onProgress: f => opts.onProgress?.(Math.min(1, (done + f * Math.max(1, countedLeft()) * 0.5) / total)) };
      // Counted parts first (by priority), fill parts last.
      const active = prepared.filter(p => remaining[p.index] > 0)
        .sort((a, b) => a.fill - b.fill || a.priority - b.priority || remaining[b.index] - remaining[a.index]);

      // Parts with many copies: an array block each, in strips left to right
      // (a strip starts one spacing — or pierce separation — past the last).
      let placements = [];
      let stripX = sheet.minX;
      const gap = Math.max(opts.spacing || 0, opts.pierceSep || 0);
      const strip = async p => {
        if (stripX >= sheet.maxX) return;
        const res = await arrayNest(p, { ...sheet, minX: stripX }, p.fill ? 0 : remaining[p.index], arrayOpts(sub, p.rotation || opts.rotation));
        if (!res.placements.length) return;
        placements = placements.concat(res.placements.map(({ part, angle, x, y }) => ({ part, angle, x, y })));
        stripX = Math.max(...res.placements.map(pl => pl.right)) + gap;
      };
      // A few copies go in the mixed fill, packed into the corner.
      for (const p of active) if (!p.fill && remaining[p.index] >= 6) await strip(p);
      const leftOf = p => remaining[p.index] - placements.filter(pl => pl.part === p.index).length;
      const mixed = async rest => {
        if (!rest.length) return;
        const pre = placements.map(pl => ({ o: orient(prepared[pl.part], pl.angle, cache), x: pl.x, y: pl.y }));
        const res = await mixedNest(rest, sheet, sub, pre);
        placements = placements.concat(res.placements);
      };
      const counted = active.filter(p => !p.fill && leftOf(p) > 0);
      await mixed(counted.map(p => ({ ...p, qty: leftOf(p) })));
      // Fill parts: an array strip to the right of everything placed, then
      // single copies into the gaps that leaves (when other parts are on the
      // sheet), until one won't fit — no sheet holds more than its area allows.
      // Fill parts: an array over the whole sheet with the copies that would
      // hit a placed part left out, then single copies into what gaps are
      // left (when other parts are on the sheet), until one won't fit — no
      // sheet holds more than its area allows.
      const fills = active.filter(p => p.fill);
      const shared = placements.length > 0;
      for (const p of fills) {
        if (placements.length > OBSTACLES_MAX) {
          stripX = Math.max(...placements.map(pl => pl.x + orient(prepared[pl.part], pl.angle, cache).tight.maxX)) + gap;
          await strip(p);
          continue;
        }
        const obstacles = placements.map(pl => ({ o: orient(prepared[pl.part], pl.angle, cache), x: pl.x, y: pl.y }));
        const res = await arrayNest(p, sheet, 0, { ...arrayOpts(sub, p.rotation || opts.rotation), obstacles });
        placements = placements.concat(res.placements.map(({ part, angle, x, y }) => ({ part, angle, x, y })));
      }
      const arrayed = new Set(placements.map(pl => pl.part));
      await mixed(fills.filter(p => shared || !arrayed.has(p.index)).map(p => ({ ...p, qty: Math.ceil(sheetArea / Math.max(p.area, 1)) + 1 })));
      if (!placements.length) break; // nothing left fits this size — try the next
      for (const pl of placements) { remaining[pl.part]--; placedCount[pl.part]++; }
      const usedArea = placements.reduce((s, pl) => s + prepared[pl.part].area, 0);
      sheets.push({ w: size.w, l: size.l, placements, utilization: usedArea / ((sheet.maxX - sheet.minX) * (sheet.maxY - sheet.minY)) });
      await new Promise(r => setTimeout(r, 0));
    }
  }
  opts.onProgress?.(1);
  return {
    sheets,
    parts: prepared,
    placed: placedCount,
    unplaced: prepared.map(p => (p.fill ? 0 : remaining[p.index])),
  };
}

export const _test = { nfpPaths, makeRings, insideRings, intervalsOnLine, bestLattice, prepareParts, orient };
