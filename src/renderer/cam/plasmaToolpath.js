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

import { offsetPolyline, isClockwise, pointInPolygon, stripClose } from './offset.js';

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
 */
export function chainPieces(pieces, snap = 0.01) {
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
      closed.push({ loop });
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
  for (const c of closed) {
    let path = c.loop;
    if (kerf > 0) {
      const res = offsetPolyline(c.loop, c.isHole ? kerf / 2 : -kerf / 2, true);
      const off = res[0] && res[0].length >= 4 ? stripClose(res[0]) : null;
      if (!off) {
        warnings.push(`A ${c.isHole ? 'hole' : 'shape'} is too small for a ${kerf.toFixed(2)} mm kerf — skipped.`);
        continue;
      }
      path = off; // CCW
    }
    if (!c.isHole) path = [...path].reverse(); // outlines clockwise
    cuts.push({ kind: c.isHole ? 'hole' : 'outline', depth: c.depth, loop: startOnLongestSegment(path) });
  }
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
