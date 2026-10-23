// Plasma Cut operation — the PLASMA screen's toolpath.
//
// A torch cuts through in one pass, so there are no depths, plunges, tabs
// or Z moves at all: each cut is a rapid to the pierce point, torch on,
// lead-in, the kerf-compensated profile, optional overcut, torch off. The
// DMD-C3 Plasma Control app fills in the pierce itself (touch-off, pierce
// height, delay, cut height) from its Material Library when it runs the
// program, so the program stays material-independent apart from the kerf.
//
//  - Holes vs outlines are worked out from nesting: a closed shape inside
//    an odd number of others is a hole, otherwise an outline (so a part
//    nested inside another part's hole is an outline again).
//  - Kerf: half a kerf outward on outlines, inward on holes.
//  - Direction: outlines clockwise, holes counter-clockwise (standard for a
//    clockwise-swirl torch — the square side of the cut is on the part).
//    Either way the scrap is on the LEFT of travel, so the lead-in always
//    comes from the left.
//  - Order: deepest first (holes before the outline around them; a part
//    inside a hole before that hole), nearest next within the same depth.
//  - Open shapes are cut on the line, as drawn.
//  - Scrap narrower than the kerf (a slot between two letters, a pinch in a
//    cut-out, a thin notch into an outline) is cut down its centerline,
//    spliced into the shape's cut — see narrowSlots.js.
//  - Outlines start at the middle of their longest straight run, unless the
//    outline entity carries a `leadAt` point (set by Nest → Apply): then they
//    start at the nearest point to it, so the lead-in lands where the nester
//    left room for it.

import { offsetPolyline, isClockwise, pointInPolygon, stripClose, polygonArea } from './offset.js';
import { narrowCenterlines, spliceSlots } from './narrowSlots.js';

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function bounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Starts a closed loop (no closing point) at the middle of its longest segment — a straight run is the cleanest place to pierce, lead in and close. */
function startOnLongestSegment(loop) {
  let best = 0, bestLen = -1;
  for (let i = 0; i < loop.length; i++) {
    const len = dist(loop[i], loop[(i + 1) % loop.length]);
    if (len > bestLen) { bestLen = len; best = i; }
  }
  const a = loop[best], b = loop[(best + 1) % loop.length];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return [mid, ...loop.slice(best + 1), ...loop.slice(0, best + 1)];
}

/** Starts a closed loop (no closing point) at the point on it nearest to `pt`. */
function startNearest(loop, pt) {
  let best = 0, bestD = Infinity, bestP = loop[0];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const ex = b.x - a.x, ey = b.y - a.y, len2 = ex * ex + ey * ey;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((pt.x - a.x) * ex + (pt.y - a.y) * ey) / len2)) : 0;
    const q = { x: a.x + t * ex, y: a.y + t * ey };
    const d = dist(q, pt);
    if (d < bestD) { bestD = d; best = i; bestP = q; }
  }
  const next = loop.slice(best + 1).concat(loop.slice(0, best + 1));
  // Don't double a vertex when the nearest point is one.
  if (dist(bestP, next[0]) < 1e-6) return next;
  if (dist(bestP, next[next.length - 1]) < 1e-6) return [next[next.length - 1], ...next.slice(0, -1)];
  return [bestP, ...next];
}

/**
 * The kerf-compensated cut paths of a closed shape (CCW `loop`, no closing
 * point), in cut direction, not yet started anywhere — biggest first. An
 * outline gives one. A hole that's narrower than the kerf somewhere comes
 * apart when it's offset inward, into a path per wide-enough piece; each
 * is cut. Empty if the kerf doesn't fit at all.
 */
function kerfPaths(loop, isHole, kerf) {
  let paths = [loop];
  if (kerf > 0) {
    paths = offsetPolyline(loop, isHole ? kerf / 2 : -kerf / 2, true)
      .filter(r => r && r.length >= 4)
      .map(r => stripClose(r)) // CCW
      .sort((a, b) => polygonArea(b) - polygonArea(a));
    if (!isHole) paths = paths.slice(0, 1);
  }
  return isHole ? paths : paths.map(p => [...p].reverse()); // outlines clockwise
}

/** Points `length` along a closed loop from its start (for the overcut past the start point). */
function walkAlong(loop, length) {
  const out = [];
  let left = length;
  for (let i = 0; i < loop.length && left > 1e-6; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const seg = dist(a, b);
    if (seg <= 1e-9) continue;
    if (seg >= left) {
      out.push({ x: a.x + ((b.x - a.x) * left) / seg, y: a.y + ((b.y - a.y) * left) / seg });
      break;
    }
    out.push(b);
    left -= seg;
  }
  return out;
}

/**
 * Lead-in onto `loop[0]` from the left of travel (the scrap side). Arc: a
 * quarter circle of radius `length` ending tangent at the start (always
 * counter-clockwise, since it turns toward the path from the left). Line:
 * straight in, square to the path. Shrunk until the pierce point is on the
 * scrap side of the cut; null if even a short one doesn't fit.
 */
function leadIn(loop, isHole, style, length) {
  const P = loop[0], Q = loop[1];
  const len = dist(P, Q);
  if (len < 1e-9 || length <= 0) return null;
  const tx = (Q.x - P.x) / len, ty = (Q.y - P.y) / len;
  const nx = -ty, ny = tx; // left of travel
  let R = length;
  if (isHole) {
    const b = bounds(loop);
    R = Math.min(R, Math.min(b.w, b.h) * 0.25);
  }
  for (let attempt = 0; attempt < 5 && R > 0.2; attempt++, R /= 2) {
    const pierce = style === 'line' ? { x: P.x + nx * R, y: P.y + ny * R } : { x: P.x + nx * R - tx * R, y: P.y + ny * R - ty * R };
    const inScrap = isHole ? pointInPolygon(pierce, loop) : !pointInPolygon(pierce, loop);
    if (!inScrap) continue;
    return style === 'line'
      ? { pierce, move: { type: 'feed', x: P.x, y: P.y } }
      : // Center C = P + R·N; the pierce point is C − R·T, so C sits R·T from it (G3 I/J).
        { pierce, move: { type: 'arc_ccw', x: P.x, y: P.y, i: tx * R, j: ty * R } };
  }
  return null;
}

/**
 * Joins loose pieces (lines, arcs, open polylines — how many DXF parts are
 * drawn) end to end into as few paths as possible; a path whose ends meet is
 * a closed shape. pieces: [{ pts, ids }] → [{ profile, closed, ids }].
 * Ends that meet exactly (within `snap`) are joined first; whatever is still
 * open then gets a second pass that bridges gaps up to `gapSnap` (0.25 mm,
 * about 0.01") — real DXFs often leave hairline gaps in an outline.
 */
export function chainPieces(pieces, snap = 0.01, gapSnap = 0.25) {
  const first = chainOnce(pieces, snap);
  const open = first.filter(c => !c.closed);
  if (!open.length || gapSnap <= snap) return first;
  return [...first.filter(c => c.closed), ...chainOnce(open.map(c => ({ pts: c.profile, ids: c.ids })), gapSnap)];
}

function chainOnce(pieces, snap) {
  const left = pieces.filter(p => p.pts && p.pts.length >= 2).map(p => ({ ...p, used: false }));
  const out = [];
  for (const seed of left) {
    if (seed.used) continue;
    seed.used = true;
    let chain = [...seed.pts];
    const ids = [...(seed.ids || [])];
    let grew = true;
    while (grew && dist(chain[0], chain[chain.length - 1]) > snap) {
      grew = false;
      for (const piece of left) {
        if (piece.used) continue;
        const a = piece.pts[0], b = piece.pts[piece.pts.length - 1];
        const head = chain[0], tail = chain[chain.length - 1];
        if (dist(tail, a) <= snap) chain = [...chain, ...piece.pts.slice(1)];
        else if (dist(tail, b) <= snap) chain = [...chain, ...[...piece.pts].reverse().slice(1)];
        else if (dist(head, b) <= snap) chain = [...piece.pts.slice(0, -1), ...chain];
        else if (dist(head, a) <= snap) chain = [...[...piece.pts].reverse().slice(0, -1), ...chain];
        else continue;
        piece.used = true;
        ids.push(...(piece.ids || []));
        grew = true;
      }
    }
    const closed = chain.length >= 4 && dist(chain[0], chain[chain.length - 1]) <= snap;
    if (closed) chain[chain.length - 1] = { ...chain[0] }; // exactly closed, no sliver segment
    out.push({ profile: chain, closed, ids });
  }
  return out;
}

export function generatePlasma(op, shapes) {
  const p = op.params || {};
  const kerf = Math.max(0, p.kerf ?? 1.143);
  const feed = p.feedRate || 3556;
  const leadStyle = p.leadInStyle === 'line' ? 'line' : p.leadInStyle === 'none' ? 'none' : 'arc';
  const leadLen = Math.max(0, p.leadInLength ?? 3.556);
  const overcut = Math.max(0, p.overcut ?? 0);
  const warnings = [];

  if (!shapes.length) return { moves: [], warnings: ['No entities selected'], contours: [] };

  // Closed shapes, CCW-normalised (the offset engine's convention), without a closing point.
  const closed = [];
  const open = [];
  for (const s of shapes) {
    if (!s.profile || s.profile.length < 2) continue;
    if (s.closed) {
      let loop = stripClose([...s.profile]);
      if (loop.length < 3) continue;
      if (isClockwise(loop)) loop = [...loop].reverse();
      closed.push({ loop, leadAt: s.leadAt });
    } else {
      open.push({ pts: s.profile });
    }
  }

  // Nesting depth: how many other closed shapes contain this one.
  for (const c of closed) {
    const probe = c.loop[0];
    c.depth = closed.filter(o => o !== c && pointInPolygon(probe, o.loop)).length;
    c.isHole = c.depth % 2 === 1;
  }

  // Kerf offset and cut direction.
  const cuts = [];
  let splitHoles = 0, slotCount = 0;
  for (const c of closed) {
    // Start each loop first, so the narrow-slot spurs spliced in after never hold the lead-in.
    const started = kerfPaths(c.loop, c.isHole, kerf).map(path => (c.leadAt && !c.isHole ? startNearest(path, c.leadAt) : startOnLongestSegment(path)));
    const { loops, open: slotLines, slots } = kerf > 0
      ? spliceSlots(started, narrowCenterlines(c.loop, c.isHole, kerf), kerf)
      : { loops: started, open: [], slots: 0 };
    slotCount += slots;
    if (!loops.length && !slotLines.length) {
      warnings.push(`A ${c.isHole ? 'hole' : 'shape'} is too small for a ${kerf.toFixed(2)} mm kerf — skipped.`);
      continue;
    }
    if (loops.length > 1) splitHoles++;
    for (const loop of loops) cuts.push({ kind: c.isHole ? 'hole' : 'outline', depth: c.depth, loop });
    for (const pts of slotLines) cuts.push({ kind: 'open', depth: c.depth, pts });
  }
  if (slotCount) warnings.push(`${slotCount} spot${slotCount === 1 ? '' : 's'} narrower than the kerf cut down the centerline — the walls there are cut back slightly.`);
  if (splitHoles) warnings.push(`${splitHoles} hole${splitHoles === 1 ? ' is' : 's are'} still in separate pieces — narrower than half the kerf somewhere, too thin to cut through.`);
  for (const o of open) cuts.push({ kind: 'open', depth: Infinity, pts: o.pts });

  // Deepest first, nearest next within a depth.
  const order = [];
  let here = { x: 0, y: 0 };
  const remaining = [...cuts];
  while (remaining.length) {
    const deepest = Math.max(...remaining.map(c => c.depth));
    let bestI = -1, bestD = Infinity;
    remaining.forEach((c, i) => {
      if (c.depth !== deepest) return;
      const start = c.loop ? c.loop[0] : c.pts[0];
      const d = dist(here, start);
      if (d < bestD) { bestD = d; bestI = i; }
    });
    const next = remaining.splice(bestI, 1)[0];
    order.push(next);
    here = next.loop ? next.loop[0] : next.pts[next.pts.length - 1];
  }

  const moves = [];
  const contours = [];
  let skippedLeads = 0;
  for (const c of order) {
    if (c.kind === 'open') {
      moves.push({ type: 'rapid', x: c.pts[0].x, y: c.pts[0].y });
      moves.push({ type: 'torch_on' });
      for (let i = 1; i < c.pts.length; i++) moves.push({ type: 'feed', x: c.pts[i].x, y: c.pts[i].y, f: feed });
      moves.push({ type: 'torch_off' });
      continue;
    }
    const loop = c.loop;
    contours.push([...loop]);
    const lead = leadStyle === 'none' ? null : leadIn(loop, c.kind === 'hole', leadStyle, leadLen);
    if (leadStyle !== 'none' && !lead) skippedLeads++;
    const start = lead ? lead.pierce : loop[0];
    moves.push({ type: 'rapid', x: start.x, y: start.y });
    moves.push({ type: 'torch_on' });
    if (lead) moves.push({ ...lead.move, f: feed });
    for (let i = 1; i < loop.length; i++) moves.push({ type: 'feed', x: loop[i].x, y: loop[i].y, f: feed });
    moves.push({ type: 'feed', x: loop[0].x, y: loop[0].y, f: feed });
    for (const pt of walkAlong(loop, overcut)) moves.push({ type: 'feed', x: pt.x, y: pt.y, f: feed });
    moves.push({ type: 'torch_off' });
  }
  if (skippedLeads) warnings.push(`${skippedLeads} cut${skippedLeads === 1 ? '' : 's'} too small for a lead-in — pierced on the path.`);

  return { moves, warnings, contours };
}

/**
 * The outside cut of a part outline as a Plasma Cut with these params makes
 * it (no leadAt yet): where it starts and the lead-in's path from the pierce,
 * arcs as points. For the nester, which keeps room for it. outline: closed
 * points, no closing point. params: { kerf, leadInStyle, leadInLength } (mm).
 * Returns { start, pierce, leadPts } or null if the kerf doesn't fit.
 */
export function outsideLead(outline, params = {}) {
  let loop = stripClose([...outline]);
  if (loop.length < 3) return null;
  if (isClockwise(loop)) loop = [...loop].reverse();
  const [path] = kerfPaths(loop, false, Math.max(0, params.kerf ?? 1.143));
  if (!path) return null;
  const cut = startOnLongestSegment(path);
  const style = params.leadInStyle === 'line' ? 'line' : params.leadInStyle === 'none' ? 'none' : 'arc';
  const lead = style === 'none' ? null : leadIn(cut, false, style, Math.max(0, params.leadInLength ?? 3.556));
  const start = cut[0];
  if (!lead) return { start, pierce: start, leadPts: [start] };
  if (lead.move.type === 'feed') return { start, pierce: lead.pierce, leadPts: [lead.pierce, start] };
  // Arc: counter-clockwise from the pierce to the start around C = pierce + (i, j).
  const C = { x: lead.pierce.x + lead.move.i, y: lead.pierce.y + lead.move.j };
  const R = dist(C, start);
  const a0 = Math.atan2(lead.pierce.y - C.y, lead.pierce.x - C.x);
  let a1 = Math.atan2(start.y - C.y, start.x - C.x);
  while (a1 < a0) a1 += 2 * Math.PI;
  const n = 8;
  const leadPts = Array.from({ length: n + 1 }, (_, k) => {
    const a = a0 + ((a1 - a0) * k) / n;
    return { x: C.x + R * Math.cos(a), y: C.y + R * Math.sin(a) };
  });
  return { start, pierce: lead.pierce, leadPts };
}
