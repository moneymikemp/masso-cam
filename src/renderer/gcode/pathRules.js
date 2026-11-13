// Path rules for THC plasma tables (as SheetCam's "Path rules"), applied to a
// plasma toolpath's moves before posting:
//   - small holes: the whole cut at a reduced feed with the THC off
//   - tight curves and sharp corners: a little slower, THC off from a margin
//     before them to a margin after (the arc voltage jumps when the torch
//     slows into them, and the THC would dive)
//   - the end of each cut: THC off for the last bit
// Lengths are mm. A cut is the moves between torch_on and torch_off; lines
// and arcs are split where a rule starts or ends, and { type: 'thc', on }
// moves mark where the THC goes off and back on. torch_on gets thcOff: true
// when the whole cut runs without the THC.
//
// rules: { holeDia, holeFeed (%), arcDia, cornerAngle (°, included), slowFeed (%),
//          margin, endOff, minThcLength }

const EPS = 1e-6;

export function applyPathRules(moves, rules) {
  const out = [];
  let at = null;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (m.type === 'torch_on' && at) {
      let j = i + 1;
      while (j < moves.length && moves[j].type !== 'torch_off') j++;
      const cut = applyToCut(moves.slice(i + 1, j), at, rules);
      out.push({ ...m, ...(cut.thcOff ? { thcOff: true, thcNote: cut.thcNote } : {}) }, ...cut.moves);
      for (let k = i + 1; k < j; k++) at = endOf(moves[k], at);
      i = j - 1;
      continue;
    }
    out.push(m);
    at = endOf(m, at);
  }
  return out;
}

function endOf(m, at) {
  if (m.x === undefined && m.y === undefined) return at;
  return { x: m.x ?? at?.x ?? 0, y: m.y ?? at?.y ?? 0 };
}

// The cut's moves as segments from `start`: lines, and arcs with centre, radius and sweep (ccw +).
function segmentsOf(moves, start) {
  const segs = [];
  let p = start;
  for (const m of moves) {
    const q = endOf(m, p);
    if (m.type === 'arc_cw' || m.type === 'arc_ccw') {
      const c = { x: p.x + (m.i || 0), y: p.y + (m.j || 0) };
      const r = Math.hypot(p.x - c.x, p.y - c.y);
      const a0 = Math.atan2(p.y - c.y, p.x - c.x);
      let sweep = Math.atan2(q.y - c.y, q.x - c.x) - a0;
      if (m.type === 'arc_ccw') { while (sweep <= EPS) sweep += 2 * Math.PI; } else { while (sweep >= -EPS) sweep -= 2 * Math.PI; }
      segs.push({ arc: true, move: m, p, q, c, r, a0, sweep, len: r * Math.abs(sweep) });
    } else {
      segs.push({ arc: false, move: m, p, q, len: Math.hypot(q.x - p.x, q.y - p.y) });
    }
    p = q;
  }
  return segs;
}

function applyToCut(moves, start, rules) {
  const segs = segmentsOf(moves, start);
  const total = segs.reduce((s, g) => s + g.len, 0);
  if (!segs.length || total < EPS) return { moves };

  // Small hole: a cut whose (line) points sit on one circle.
  const pts = segs.filter(g => !g.arc).map(g => g.q);
  if (pts.length >= 8 && rules.holeDia > 0) {
    const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length, cy = pts.reduce((s, q) => s + q.y, 0) / pts.length;
    const rs = pts.map(q => Math.hypot(q.x - cx, q.y - cy));
    const rMean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const spread = Math.max(...rs) - Math.min(...rs);
    if (2 * rMean < rules.holeDia && spread < Math.max(0.05, 0.03 * rMean)) {
      const k = (rules.holeFeed || 100) / 100;
      return { thcOff: true, thcNote: 'small hole', moves: moves.map(m => (m.f !== undefined ? { ...m, f: m.f * k } : m)) };
    }
  }

  // Slow zones [from, to] along the cut, from its vertices between two lines.
  const zones = [];
  const margin = Math.max(0, rules.margin || 0);
  let s = 0;
  for (let k = 0; k < segs.length - 1; k++) {
    s += segs[k].len;
    const a = segs[k], b = segs[k + 1];
    if (a.arc || b.arc || a.len < EPS || b.len < EPS) continue;
    const d1 = { x: (a.q.x - a.p.x) / a.len, y: (a.q.y - a.p.y) / a.len };
    const d2 = { x: (b.q.x - b.p.x) / b.len, y: (b.q.y - b.p.y) / b.len };
    const turn = Math.acos(Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y))) * 180 / Math.PI;
    if (turn < 0.5) continue;
    const sharp = rules.cornerAngle > 0 && 180 - turn < rules.cornerAngle;
    // Radius through the three points: a tight curve drawn as short lines.
    const chord = Math.hypot(b.q.x - a.p.x, b.q.y - a.p.y);
    const radius = chord / (2 * Math.sin(turn * Math.PI / 180));
    const tight = rules.arcDia > 0 && 2 * radius < rules.arcDia;
    if (sharp || tight) zones.push([s - margin, s + margin]);
  }
  const thcCut = total > (rules.minThcLength || 0);
  const endOff = Math.max(0, rules.endOff || 0);
  const merged = [];
  for (const [f, t] of zones.sort((p, q) => p[0] - q[0])) {
    const z = [Math.max(0, f), Math.min(total, t)];
    const last = merged[merged.length - 1];
    if (last && z[0] <= last[1] + EPS) last[1] = Math.max(last[1], z[1]);
    else merged.push(z);
  }
  const endAt = thcCut && endOff > 0 ? Math.max(0, total - endOff) : total;
  if (!merged.length && endAt >= total - EPS) return { moves };

  // THC on only between the slow zones, and only where that stretch is at
  // least the minimum THC length: switching it on for less does nothing useful.
  const minOn = Math.max(0, rules.minThcLength || 0);
  const onStretches = [];
  let from = 0;
  for (const [f, t] of merged) { if (f > from) onStretches.push([from, Math.min(f, endAt)]); from = Math.max(from, t); }
  if (from < endAt) onStretches.push([from, endAt]);
  const thcOn = thcCut ? onStretches.filter(([f, t]) => t - f >= Math.max(minOn, EPS)) : [];
  if (thcCut && !thcOn.length && !merged.length) return { thcOff: true, thcNote: 'no long straight run', moves };

  // Where things change along the cut.
  const slowK = (rules.slowFeed || 100) / 100;
  const marks = new Set();
  merged.forEach(([f, t]) => { marks.add(f); marks.add(t); });
  thcOn.forEach(([f, t]) => { marks.add(f); marks.add(t); });
  const cuts = [...marks].filter(v => v > EPS && v < total - EPS).sort((p, q) => p - q);
  const slowAt = v => merged.some(([f, t]) => v > f + EPS && v < t - EPS);
  const thcAt = v => thcOn.some(([f, t]) => v > f + EPS && v < t - EPS);

  // The THC starts on (torch_on's Q20) only if the cut's first stretch has it on.
  const startOn = thcCut && thcAt(Math.min(cuts[0] ?? total, total) / 2);
  const outMoves = [];
  let thcState = startOn;
  const setThc = on => { if (thcCut && on !== thcState) { outMoves.push({ type: 'thc', on }); thcState = on; } };
  let s0 = 0;
  for (const g of segs) {
    const s1 = s0 + g.len;
    const bounds = [s0, ...cuts.filter(v => v > s0 + EPS && v < s1 - EPS), s1];
    for (let k = 0; k < bounds.length - 1; k++) {
      const from = bounds[k], to = bounds[k + 1], mid = (from + to) / 2;
      setThc(thcAt(mid));
      outMoves.push(piece(g, (from - s0) / g.len, (to - s0) / g.len, slowAt(mid) ? slowK : 1));
    }
    s0 = s1;
  }
  return { moves: outMoves, ...(thcCut && !startOn ? { thcOff: true, thcNote: thcOn.length ? 'curves at the start' : 'no long straight run' } : {}) };
}

// The part of a segment from fraction t0 to t1, as a move.
function piece(g, t0, t1, k) {
  const m = g.move;
  const f = m.f !== undefined ? { f: m.f * k } : {};
  if (t0 <= EPS && t1 >= 1 - EPS) return { ...m, ...f };
  if (!g.arc) {
    return { ...m, x: g.p.x + (g.q.x - g.p.x) * t1, y: g.p.y + (g.q.y - g.p.y) * t1, ...f };
  }
  const a = t => g.a0 + g.sweep * t;
  const from = { x: g.c.x + g.r * Math.cos(a(t0)), y: g.c.y + g.r * Math.sin(a(t0)) };
  const to = t1 >= 1 - EPS ? g.q : { x: g.c.x + g.r * Math.cos(a(t1)), y: g.c.y + g.r * Math.sin(a(t1)) };
  return { ...m, x: to.x, y: to.y, i: g.c.x - from.x, j: g.c.y - from.y, ...f };
}
