import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { v4 as uuid } from 'uuid';
import { useApp } from '../../store/AppContext';
import { circleToPoints, arcToPoints, polylineToPoints } from '../../dxf/parser';
import { computeAutoTabPositions } from '../../cam/toolpath';

const COLORS = {
  background: '#1a1a2e',
  grid: '#252540',
  gridMajor: '#303058',
  axis: '#404070',
  entity: '#4488ff',
  entityHover: '#88bbff',
  entitySelected: '#ffcc44',
  toolpathCut: '#00ff88',
  toolpathRapid: '#ff4444',
  toolpathPlunge: '#ff8800',
  origin: '#ff4444',
  stockFill: 'rgba(180, 140, 60, 0.06)',
  stockBorder: 'rgba(200, 160, 80, 0.45)',
  medialAxis: '#ff00ff',
};

// ── Entity editing helpers (pure functions, no React) ─────────────────────────

function entityBounds(e) {
  switch (e.type) {
    case 'line':     return { minX: Math.min(e.start.x, e.end.x), maxX: Math.max(e.start.x, e.end.x), minY: Math.min(e.start.y, e.end.y), maxY: Math.max(e.start.y, e.end.y) };
    case 'circle':   return { minX: e.center.x - e.radius, maxX: e.center.x + e.radius, minY: e.center.y - e.radius, maxY: e.center.y + e.radius };
    case 'arc':      return { minX: e.center.x - e.radius, maxX: e.center.x + e.radius, minY: e.center.y - e.radius, maxY: e.center.y + e.radius };
    case 'polyline': { const xs = (e.vertices||[]).map(v=>v.x), ys = (e.vertices||[]).map(v=>v.y); return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }; }
    default: return null;
  }
}

function selBoundsOf(entities, ids) {
  let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity, found=false;
  for (const e of entities) {
    if (!ids.includes(e.id)) continue;
    const b = entityBounds(e); if (!b) continue;
    found = true;
    if (b.minX < minX) minX = b.minX; if (b.maxX > maxX) maxX = b.maxX;
    if (b.minY < minY) minY = b.minY; if (b.maxY > maxY) maxY = b.maxY;
  }
  return found ? { minX, maxX, minY, maxY } : null;
}

function applyXform(entity, xf) {
  function pt(p) {
    if (xf.type === 'move')   return { x: p.x + xf.dx, y: p.y + xf.dy };
    if (xf.type === 'scale')  return { x: xf.cx + (p.x - xf.cx) * xf.s, y: xf.cy + (p.y - xf.cy) * xf.s };
    if (xf.type === 'rotate') {
      const cos = Math.cos(xf.a), sin = Math.sin(xf.a), rx = p.x - xf.cx, ry = p.y - xf.cy;
      return { x: xf.cx + rx*cos - ry*sin, y: xf.cy + rx*sin + ry*cos };
    }
    return p;
  }
  const r = (xf.type === 'scale') ? entity.radius * xf.s : entity.radius;
  switch (entity.type) {
    case 'line':     return { ...entity, start: pt(entity.start), end: pt(entity.end) };
    case 'circle':   return { ...entity, center: pt(entity.center), radius: r };
    case 'arc':      return { ...entity, center: pt(entity.center), radius: r,
      startAngle: xf.type==='rotate' ? entity.startAngle + xf.a : entity.startAngle,
      endAngle:   xf.type==='rotate' ? entity.endAngle   + xf.a : entity.endAngle };
    case 'polyline': return { ...entity, vertices: (entity.vertices||[]).map(pt) };
    default: return entity;
  }
}

// ── Trim helpers ─────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;

// Returns how far along the arc (0..span) the angle lands, or null if outside
function arcFrac(angle, startAngle, endAngle) {
  let ea = endAngle <= startAngle ? endAngle + TAU : endAngle;
  let a = angle;
  while (a < startAngle) a += TAU;
  while (a > startAngle + TAU) a -= TAU;
  if (a > ea + 1e-9) return null;
  return a - startAngle;
}

// Intersection t on l1 (0..1), checking t2 on l2 also in (0,1). Returns null if none.
function lineLineParam(p1, p2, p3, p4) {
  const dx1 = p2.x-p1.x, dy1 = p2.y-p1.y;
  const dx2 = p4.x-p3.x, dy2 = p4.y-p3.y;
  const den = dx1*dy2 - dy1*dx2;
  if (Math.abs(den) < 1e-10) return null;
  const t1 = ((p3.x-p1.x)*dy2 - (p3.y-p1.y)*dx2) / den;
  const t2 = ((p3.x-p1.x)*dy1 - (p3.y-p1.y)*dx1) / den;
  const eps = 1e-9;
  if (t1 < eps || t1 > 1-eps || t2 < eps || t2 > 1-eps) return null;
  return t1;
}

// t values on line [0..1] where it hits circle; optionally filtered by arc range
function lineCircleParams(ls, le, cx, cy, r, arcSa, arcEa) {
  const dx = le.x-ls.x, dy = le.y-ls.y;
  const fx = ls.x-cx, fy = ls.y-cy;
  const a = dx*dx+dy*dy, b = 2*(fx*dx+fy*dy), c = fx*fx+fy*fy-r*r;
  const disc = b*b - 4*a*c;
  if (disc < 0) return [];
  const sqD = Math.sqrt(disc);
  const result = [];
  for (const sign of [-1, 1]) {
    const t = (-b + sign*sqD) / (2*a);
    if (t < 1e-9 || t > 1-1e-9) continue;
    if (arcSa != null) {
      const px = ls.x+t*dx, py = ls.y+t*dy;
      const angle = Math.atan2(py-cy, px-cx);
      if (arcFrac(angle, arcSa, arcEa) === null) continue;
    }
    result.push(t);
  }
  return result;
}

// Intersection angles on circle1 that also lie on circle2 (or arc2 if Sa2!=null)
function circleCircleAngles(cx1, cy1, r1, cx2, cy2, r2, sa1, ea1, sa2, ea2) {
  const dx = cx2-cx1, dy = cy2-cy1, D = Math.hypot(dx, dy);
  if (D > r1+r2+1e-9 || D < Math.abs(r1-r2)-1e-9 || D < 1e-9) return [];
  const a = (r1*r1-r2*r2+D*D)/(2*D);
  const h2 = r1*r1-a*a;
  if (h2 < 0) return [];
  const h = Math.sqrt(h2);
  const ux = dx/D, uy = dy/D;
  const px = cx1+a*ux, py = cy1+a*uy;
  const result = [];
  for (const sign of [-1, 1]) {
    const ix = px+sign*h*(-uy), iy = py+sign*h*ux;
    const ang1 = Math.atan2(iy-cy1, ix-cx1);
    const ang2 = Math.atan2(iy-cy2, ix-cx2);
    if (sa1 != null && arcFrac(ang1, sa1, ea1) === null) continue;
    if (sa2 != null && arcFrac(ang2, sa2, ea2) === null) continue;
    result.push(ang1);
  }
  return result;
}

// Returns the intersection angles on the target entity contributed by one other entity
function intersectionsOnTarget(target, other) {
  const params = [];
  const iArc = target.type === 'arc';
  const sa = iArc ? target.startAngle : null;
  const ea = iArc ? target.endAngle   : null;

  if (target.type === 'line') {
    const ls = target.start, le = target.end;
    if (other.type === 'line') {
      const t = lineLineParam(ls, le, other.start, other.end);
      if (t != null) params.push(t);
    } else if (other.type === 'circle' || other.type === 'arc') {
      const osa = other.type === 'arc' ? other.startAngle : null;
      const oea = other.type === 'arc' ? other.endAngle   : null;
      lineCircleParams(ls, le, other.center.x, other.center.y, other.radius, osa, oea)
        .forEach(t => params.push(t));
    } else if (other.type === 'polyline') {
      const v = other.vertices || [];
      const n = other.closed ? v.length : v.length-1;
      for (let i = 0; i < n; i++) {
        const t = lineLineParam(ls, le, v[i], v[(i+1)%v.length]);
        if (t != null) params.push(t);
      }
    }
  } else if (target.type === 'arc' || target.type === 'circle') {
    const tc = target.center, tr = target.radius;
    if (other.type === 'line') {
      lineCircleParams(other.start, other.end, tc.x, tc.y, tr, null, null).forEach(t => {
        const px = other.start.x+t*(other.end.x-other.start.x);
        const py = other.start.y+t*(other.end.y-other.start.y);
        const angle = Math.atan2(py-tc.y, px-tc.x);
        if (!iArc || arcFrac(angle, sa, ea) != null) params.push(angle);
      });
    } else if (other.type === 'circle' || other.type === 'arc') {
      const osa = other.type === 'arc' ? other.startAngle : null;
      const oea = other.type === 'arc' ? other.endAngle   : null;
      circleCircleAngles(tc.x, tc.y, tr, other.center.x, other.center.y, other.radius, sa, ea, osa, oea)
        .forEach(ang => params.push(ang));
    } else if (other.type === 'polyline') {
      const v = other.vertices || [];
      const n = other.closed ? v.length : v.length-1;
      for (let i = 0; i < n; i++) {
        lineCircleParams(v[i], v[(i+1)%v.length], tc.x, tc.y, tr, null, null).forEach(t => {
          const px = v[i].x+t*(v[(i+1)%v.length].x-v[i].x);
          const py = v[i].y+t*(v[(i+1)%v.length].y-v[i].y);
          const angle = Math.atan2(py-tc.y, px-tc.x);
          if (!iArc || arcFrac(angle, sa, ea) != null) params.push(angle);
        });
      }
    }
  }
  return params;
}

// Main trim: returns replacement entities or null if not trimmable
function doTrim(target, clickPt, others) {
  const params = [];
  for (const other of others) {
    intersectionsOnTarget(target, other).forEach(p => params.push(p));
  }
  if (params.length === 0) return null;

  if (target.type === 'line') {
    params.sort((a, b) => a-b);
    const dx = target.end.x-target.start.x, dy = target.end.y-target.start.y;
    const len2 = dx*dx+dy*dy;
    if (len2 < 1e-10) return null;
    const ct = ((clickPt.x-target.start.x)*dx+(clickPt.y-target.start.y)*dy)/len2;
    let lo = 0, hi = 1;
    for (const t of params) { if (t < ct) lo = Math.max(lo, t); }
    for (const t of params) { if (t > ct) { hi = Math.min(hi, t); break; } }
    const pieces = [];
    if (lo > 1e-6)
      pieces.push({ ...target, id: uuid(), end: { x: target.start.x+lo*dx, y: target.start.y+lo*dy } });
    if (hi < 1-1e-6)
      pieces.push({ ...target, id: uuid(), start: { x: target.start.x+hi*dx, y: target.start.y+hi*dy } });
    return pieces;
  }

  if (target.type === 'arc') {
    const effEnd = target.endAngle <= target.startAngle ? target.endAngle+TAU : target.endAngle;
    // Normalize params into [startAngle, effEnd]
    const sorted = params.map(a => {
      while (a < target.startAngle) a += TAU;
      while (a > target.startAngle+TAU) a -= TAU;
      return a;
    }).filter(a => a > target.startAngle+1e-9 && a < effEnd-1e-9).sort((a, b) => a-b);
    if (sorted.length === 0) return null;
    let ca = Math.atan2(clickPt.y-target.center.y, clickPt.x-target.center.x);
    while (ca < target.startAngle) ca += TAU;
    while (ca > target.startAngle+TAU) ca -= TAU;
    let lo = target.startAngle, hi = effEnd;
    for (const a of sorted) { if (a < ca) lo = Math.max(lo, a); }
    for (const a of sorted) { if (a > ca) { hi = Math.min(hi, a); break; } }
    const pieces = [];
    if (lo > target.startAngle+1e-6)
      pieces.push({ ...target, id: uuid(), startAngle: target.startAngle, endAngle: lo });
    if (hi < effEnd-1e-6)
      pieces.push({ ...target, id: uuid(), startAngle: hi, endAngle: target.endAngle });
    return pieces;
  }

  if (target.type === 'circle') {
    // Deduplicate and sort all intersection angles in [0, TAU)
    const angles = [...new Set(params.map(a => { const n = ((a%TAU)+TAU)%TAU; return Math.round(n*1e7)/1e7; }))]
      .map(Number).sort((a, b) => a-b);
    if (angles.length < 2) return null;
    const ca = ((Math.atan2(clickPt.y-target.center.y, clickPt.x-target.center.x) % TAU)+TAU) % TAU;
    // Find the two consecutive angles bracketing click
    let lo = angles[angles.length-1]-TAU, hi = angles[0]; // wrap-around default
    for (let i = 0; i < angles.length; i++) {
      if (angles[i] <= ca) lo = angles[i];
      else { hi = angles[i]; break; }
    }
    // Keep: arc from hi CCW to lo (the untrimmed portion)
    return [{ ...target, id: uuid(), type: 'arc', startAngle: hi, endAngle: lo }];
  }

  return null;
}

// ── Measurement label helper ──────────────────────────────────────────────────

function drawMeasureLabel(ctx, text, x, y) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = 'bold 11px monospace';
  const tw = ctx.measureText(text).width;
  const pw = tw + 10, ph = 17;
  ctx.fillStyle = 'rgba(0,20,30,0.88)';
  ctx.strokeStyle = '#00ccdd';
  ctx.lineWidth = 0.8;
  ctx.fillRect(x - pw/2, y - ph/2, pw, ph);
  ctx.strokeRect(x - pw/2, y - ph/2, pw, ph);
  ctx.fillStyle = '#aaffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ── Mirror helpers ────────────────────────────────────────────────────────────

function mirrorPt(p, p1, p2) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { ...p };
  const ux = dx / len, uy = dy / len;
  const vx = p.x - p1.x, vy = p.y - p1.y;
  const proj = vx * ux + vy * uy;
  return { x: p1.x + 2 * proj * ux - vx, y: p1.y + 2 * proj * uy - vy };
}

function mirrorEntity(entity, p1, p2) {
  const mp = p => mirrorPt(p, p1, p2);
  switch (entity.type) {
    case 'line':
      return { ...entity, id: uuid(), start: mp(entity.start), end: mp(entity.end) };
    case 'circle':
      return { ...entity, id: uuid(), center: mp(entity.center) };
    case 'arc': {
      const newCenter = mp(entity.center);
      const sp = { x: entity.center.x + entity.radius * Math.cos(entity.startAngle), y: entity.center.y + entity.radius * Math.sin(entity.startAngle) };
      const ep = { x: entity.center.x + entity.radius * Math.cos(entity.endAngle),   y: entity.center.y + entity.radius * Math.sin(entity.endAngle) };
      const newSp = mp(sp), newEp = mp(ep);
      // Winding reverses across a mirror — swap start/end
      return { ...entity, id: uuid(), center: newCenter,
        startAngle: Math.atan2(newEp.y - newCenter.y, newEp.x - newCenter.x),
        endAngle:   Math.atan2(newSp.y - newCenter.y, newSp.x - newCenter.x) };
    }
    case 'polyline':
      return { ...entity, id: uuid(), vertices: entity.vertices.map(mp) };
    default:
      return { ...entity, id: uuid() };
  }
}

// ── Drawing tool helpers ──────────────────────────────────────────────────────

function getEntitySnapPoints(e) {
  const pts = [];
  switch (e.type) {
    case 'line':
      pts.push({ pt: e.start, type: 'endpoint' }, { pt: e.end, type: 'endpoint' },
        { pt: { x: (e.start.x+e.end.x)/2, y: (e.start.y+e.end.y)/2 }, type: 'midpoint' });
      break;
    case 'circle':
      pts.push({ pt: e.center, type: 'center' });
      for (let a = 0; a < Math.PI*2; a += Math.PI/2)
        pts.push({ pt: { x: e.center.x + e.radius*Math.cos(a), y: e.center.y + e.radius*Math.sin(a) }, type: 'endpoint' });
      break;
    case 'arc': {
      const s = { x: e.center.x + e.radius*Math.cos(e.startAngle), y: e.center.y + e.radius*Math.sin(e.startAngle) };
      const en = { x: e.center.x + e.radius*Math.cos(e.endAngle),   y: e.center.y + e.radius*Math.sin(e.endAngle) };
      let span = e.endAngle - e.startAngle; while (span < 0) span += Math.PI*2;
      const ma = e.startAngle + span/2;
      pts.push({ pt: s, type: 'endpoint' }, { pt: en, type: 'endpoint' },
        { pt: { x: e.center.x + e.radius*Math.cos(ma), y: e.center.y + e.radius*Math.sin(ma) }, type: 'midpoint' },
        { pt: e.center, type: 'center' });
      break;
    }
    case 'polyline':
      (e.vertices||[]).forEach((v, i, arr) => {
        pts.push({ pt: v, type: 'endpoint' });
        const next = arr[i+1] ?? (e.closed ? arr[0] : null);
        if (next) pts.push({ pt: { x: (v.x+next.x)/2, y: (v.y+next.y)/2 }, type: 'midpoint' });
      });
      break;
    default: break;
  }
  return pts;
}

function getEntityGrips(entity) {
  switch (entity.type) {
    case 'line': {
      const mx = (entity.start.x + entity.end.x) / 2, my = (entity.start.y + entity.end.y) / 2;
      return [
        { x: entity.start.x, y: entity.start.y, gripType: 'start' },
        { x: entity.end.x,   y: entity.end.y,   gripType: 'end'   },
        { x: mx, y: my, gripType: 'mid' },
      ];
    }
    case 'circle':
      return [{ x: entity.center.x, y: entity.center.y, gripType: 'center' }];
    case 'arc': {
      const sp = { x: entity.center.x + entity.radius * Math.cos(entity.startAngle), y: entity.center.y + entity.radius * Math.sin(entity.startAngle) };
      const ep = { x: entity.center.x + entity.radius * Math.cos(entity.endAngle),   y: entity.center.y + entity.radius * Math.sin(entity.endAngle) };
      let span = entity.endAngle - entity.startAngle; while (span < 0) span += 2 * Math.PI;
      const ma = entity.startAngle + span / 2;
      const mp = { x: entity.center.x + entity.radius * Math.cos(ma), y: entity.center.y + entity.radius * Math.sin(ma) };
      return [
        { ...sp, gripType: 'start' },
        { ...ep, gripType: 'end'   },
        { ...mp, gripType: 'mid'   },
      ];
    }
    case 'polyline':
      return (entity.vertices || []).map((v, i) => ({ x: v.x, y: v.y, gripType: 'vertex', vertexIdx: i }));
    default:
      return [];
  }
}

// arcMid/arcOther: saved at drag start for arc-endpoint drags (see onMouseDown)
function applyGrip(entity, gripType, vertexIdx, newPos, arcMid, arcOther) {
  switch (entity.type) {
    case 'line':
      if (gripType === 'start') return { ...entity, start: { x: newPos.x, y: newPos.y } };
      if (gripType === 'end')   return { ...entity, end:   { x: newPos.x, y: newPos.y } };
      if (gripType === 'mid') {
        // Translate the whole line by the delta from its current midpoint
        const mx = (entity.start.x + entity.end.x) / 2, my = (entity.start.y + entity.end.y) / 2;
        const dx = newPos.x - mx, dy = newPos.y - my;
        return { ...entity, start: { x: entity.start.x + dx, y: entity.start.y + dy }, end: { x: entity.end.x + dx, y: entity.end.y + dy } };
      }
      break;
    case 'circle':
      if (gripType === 'center') return { ...entity, center: { x: newPos.x, y: newPos.y } };
      break;
    case 'arc':
      if ((gripType === 'start' || gripType === 'end') && arcMid && arcOther) {
        const p1 = gripType === 'start' ? newPos   : arcOther;
        const p2 = gripType === 'start' ? arcOther : newPos;
        const arc = arcFrom3Pts(p1, p2, arcMid);
        if (arc) return { ...entity, center: arc.center, radius: arc.radius, startAngle: arc.startAngle, endAngle: arc.endAngle };
      }
      if (gripType === 'mid' && arcMid && arcOther) {
        // arcOther here is the arc's start point; arcMid is the arc's end point
        // Pull arc through new midpoint, keeping start and end endpoints fixed
        const arc = arcFrom3Pts(arcOther, arcMid, newPos);
        if (arc) return { ...entity, center: arc.center, radius: arc.radius, startAngle: arc.startAngle, endAngle: arc.endAngle };
      }
      break;
    case 'polyline':
      if (gripType === 'vertex' && vertexIdx != null) {
        const verts = entity.vertices.map((v, i) => i === vertexIdx ? { x: newPos.x, y: newPos.y } : v);
        return { ...entity, vertices: verts };
      }
      break;
  }
  return entity;
}

function lineLineIntersect(e1, e2) {
  if (e1.type !== 'line' || e2.type !== 'line') return null;
  const a = e1.start, b = e1.end, c = e2.start, d = e2.end;
  const d1x = b.x-a.x, d1y = b.y-a.y, d2x = d.x-c.x, d2y = d.y-c.y;
  const denom = d1x*d2y - d1y*d2x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((c.x-a.x)*d2y - (c.y-a.y)*d2x) / denom;
  const u = ((c.x-a.x)*d1y - (c.y-a.y)*d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + t*d1x, y: a.y + t*d1y, snapType: 'intersection' };
}

function snapEntities(world, entities, layers, radius) {
  // Priority: endpoint > center > intersection > midpoint
  const priority = { endpoint: 0, center: 1, intersection: 2, midpoint: 3 };
  let best = null, bestDist = Infinity, bestPri = 99;

  const visLines = [];
  for (const e of entities) {
    const layer = layers[e.layer];
    if (layer && !layer.visible) continue;
    for (const { pt, type } of getEntitySnapPoints(e)) {
      const d = Math.hypot(pt.x - world.x, pt.y - world.y);
      const pri = priority[type] ?? 99;
      if (d < radius && (d < bestDist - 0.01 || (Math.abs(d - bestDist) < 0.01 && pri < bestPri))) {
        bestDist = d; bestPri = pri;
        best = { x: pt.x, y: pt.y, snapType: type };
      }
    }
    if (e.type === 'line') visLines.push(e);
  }

  // Line-line intersection snap (only among nearby lines)
  if (visLines.length >= 2 && bestPri > priority.intersection) {
    for (let i = 0; i < visLines.length; i++) {
      for (let j = i + 1; j < visLines.length; j++) {
        const pt = lineLineIntersect(visLines[i], visLines[j]);
        if (!pt) continue;
        const d = Math.hypot(pt.x - world.x, pt.y - world.y);
        if (d < radius && d < bestDist) { bestDist = d; bestPri = priority.intersection; best = pt; }
      }
    }
  }

  return best;
}

// Returns { center, radius, startAngle, endAngle } for an arc through 3 points,
// or null if points are collinear.
function arcFrom3Pts(p1, p2, p3) {
  const ax = p2.x-p1.x, ay = p2.y-p1.y;
  const bx = p3.x-p1.x, by = p3.y-p1.y;
  const D = 2*(ax*by - ay*bx);
  if (Math.abs(D) < 1e-10) return null;
  const ux = (by*(ax*ax+ay*ay) - ay*(bx*bx+by*by)) / D;
  const uy = (ax*(bx*bx+by*by) - bx*(ax*ax+ay*ay)) / D;
  const cx = p1.x+ux, cy = p1.y+uy;
  const r = Math.hypot(p1.x-cx, p1.y-cy);
  let sa = Math.atan2(p1.y-cy, p1.x-cx);
  let ea = Math.atan2(p2.y-cy, p2.x-cx);
  const ma = Math.atan2(p3.y-cy, p3.x-cx);
  // Normalize to CCW from sa; ensure midpoint p3 falls on the arc
  const norm = (a, ref) => { let x = a-ref; while (x < 0) x += Math.PI*2; return x; };
  if (norm(ma, sa) > norm(ea, sa)) { const t=sa; sa=ea; ea=t; }
  return { center: { x: cx, y: cy }, radius: r, startAngle: sa, endAngle: ea };
}

function constrainTo45(start, end) {
  const dx = end.x-start.x, dy = end.y-start.y;
  const dist = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI/4)) * (Math.PI/4);
  return { x: start.x + dist*Math.cos(angle), y: start.y + dist*Math.sin(angle) };
}

// ─────────────────────────────────────────────────────────────────────────────

export default function CAMCanvas() {
  const canvasRef = useRef(null);
  const { state, dispatch } = useApp();
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [statusMsg, setStatusMsg] = useState('');
  const statusTimerRef = useRef(null);

  function showStatus(msg) {
    setStatusMsg(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatusMsg(''), 2000);
  }

  const { viewport, entities, layers, operations, selectedEntityIds, hoveredEntityId, showToolpaths, showRapids, bounds, stockConfig, tabPlacementActive, tabPlacementOpId, dogboneSelectionActive, dogboneSelectionOpId, textPlacementActive, textPlacementOpId, medialAxisPolylines, postConfig, activeTool, gridSnap, refImage, previewEntities } = state;
  const isInch = postConfig?.units === 'inch';

  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 });
  const [liveXf, setLiveXf] = useState(null); // drives overlay position during drag
  const dragRef = useRef(null); // { type, startWorld, cx, cy, startAngle } — stable drag state
  const xfRef  = useRef(null); // current live transform applied in drawEntities
  const onDragMoveRef = useRef(null);
  const onDragUpRef   = useRef(null);

  // Drawing tool state
  const drawStateRef   = useRef(null);  // { tool, pts[], dragging? }
  const previewRef     = useRef(null);  // { cur: {x,y}, snapType, shift }
  const lastSnapRef    = useRef(null);  // { pos: {x,y}, shift } — for drag-commit on mouseup
  const lastClickScr   = useRef(null);  // screen position of the last first-click (for dim input)
  const onDrawMoveRef  = useRef(null);  // fresh-closure draw preview handler
  const onDrawClickRef = useRef(null);  // fresh-closure draw click handler
  const [drawPhase, setDrawPhase] = useState(0); // incremented after each draw interaction

  // Dimension input overlay (appears after first click in line/circle/rect)
  const [dimInput, setDimInput]   = useState(null);
  const dimInputRef = useRef(null); // mirrors dimInput without stale closure issues

  // Coordinate input dialog (Spacebar while drawing)
  const [coordInput, setCoordInput] = useState(null);

  // Reference image
  const refImageRef = useRef(null); // cached HTMLImageElement

  const [zSliderPos, setZSliderPos] = useState(0); // 0 = all passes; 1..N = pass index
  const [isAnimating, setIsAnimating] = useState(false);
  const draggingTabRef = useRef(null); // { opId, tabIdx } when dragging a manual tab marker
  const commitPolylineRef = useRef(null);
  const gripDragRef = useRef(null); // { entityId, gripType, vertexIdx, curWorld, snapType }
  const [nearGrip, setNearGrip] = useState(false);
  const polygonSidesRef = useRef(6); // persists across polygon draws

  // Context menu + clipboard
  const [contextMenu, setContextMenu] = useState(null); // { x, y } screen pixels
  const clipboardRef  = useRef([]);   // copied entity objects
  const clipBasePtRef = useRef(null); // base point for "copy with base point"
  // Command mode for two-point operations triggered from context menu
  // { type: 'moveBase'|'moveDest'|'pasteBase'|'pasteDest', ids?, base? }
  const cmdModeRef = useRef(null);
  const [cmdMode, setCmdMode] = useState(null);
  const setCmdModeSync = (v) => { cmdModeRef.current = v; setCmdMode(v); };
  // Transform input overlay (scale / rotate from context menu)
  const [transformInput, setTransformInput] = useState(null); // { type: 'scale'|'rotate', vals }

  // Unique Z levels where cutting happens, sorted shallowest → deepest.
  const zLevels = useMemo(() => {
    const zSet = new Set();
    for (const op of operations) {
      if (!op.enabled || !op.toolpath) continue;
      const moveLists = op.toolpath.subToolpaths?.length > 0
        ? op.toolpath.subToolpaths.map(st => st.moves)
        : [op.toolpath.moves];
      for (const moves of moveLists) {
        if (!moves) continue;
        let curZ = 0;
        for (const m of moves) {
          if (m.z !== undefined) curZ = m.z;
          if (m.type === 'feed') zSet.add(Math.round(curZ * 1000) / 1000);
        }
      }
    }
    return [...zSet].sort((a, b) => b - a);
  }, [operations]);

  // Resolved index into zLevels (null = show all).
  const filterZIndex = zSliderPos === 0 ? null : zSliderPos - 1;

  // Reset slider whenever the toolpath depth structure changes.
  useEffect(() => {
    setZSliderPos(0);
    setIsAnimating(false);
  }, [zLevels.length]);

  // Step-by-step animation: advance one pass every 700 ms.
  useEffect(() => {
    if (!isAnimating) return;
    if (zSliderPos >= zLevels.length) { setIsAnimating(false); return; }
    const t = setTimeout(() => setZSliderPos(p => p + 1), 700);
    return () => clearTimeout(t);
  }, [isAnimating, zSliderPos, zLevels.length]);

  // Load reference image into a cached Image element
  useEffect(() => {
    if (refImage?.dataUrl) {
      const img = new Image();
      img.onload = () => { refImageRef.current = img; draw(); };
      img.src = refImage.dataUrl;
    } else {
      refImageRef.current = null;
    }
  }, [refImage?.dataUrl]);

  // Reset draw state whenever the active tool changes
  useEffect(() => {
    if (activeTool === 'select') {
      drawStateRef.current = null;
    } else {
      drawStateRef.current = activeTool === 'polyline'
        ? { tool: 'polyline', pts: [], segs: [], nextSegType: 'line', arcMid: null, dragging: false }
        : activeTool === 'polygon'
        ? { tool: 'polygon', pts: [], sides: polygonSidesRef.current, dragging: false }
        : activeTool === 'mirror'
        ? { tool: 'mirror', pts: [] }
        : activeTool === 'measure'
        ? { tool: 'measure', pts: [] }
        : { tool: activeTool, pts: [], dragging: false };
    }
    previewRef.current = null;
    lastSnapRef.current = null;
    lastClickScr.current = null;
    dimInputRef.current = null;
    setDimInput(null);
    setCoordInput(null);
    setDrawPhase(p => p + 1);
  }, [activeTool]);

  // Show/hide dim input overlay based on draw state phase
  useEffect(() => {
    const ds = drawStateRef.current;
    const shouldShow = ds && ds.pts.length === 1 && ['line', 'circle', 'rect', 'polygon'].includes(ds.tool);
    if (!shouldShow) {
      if (dimInputRef.current) { dimInputRef.current = null; setDimInput(null); }
      return;
    }
    if (!dimInputRef.current) {
      const screen = lastClickScr.current || { x: canvasDims.w / 2, y: canvasDims.h / 2 };
      const anchor = ds.pts[0];
      // Default angle for line: direction of current mouse to anchor
      const mouse = lastSnapRef.current?.pos;
      const defaultAngle = (ds.tool === 'line' && mouse)
        ? (Math.atan2(mouse.y - anchor.y, mouse.x - anchor.x) * 180 / Math.PI).toFixed(1)
        : '0';
      const defaultVals = ds.tool === 'polygon'
        ? { sides: String(polygonSidesRef.current), radius: '' }
        : { angle: defaultAngle };
      const newDI = { tool: ds.tool, anchor, screen, vals: defaultVals };
      dimInputRef.current = newDI;
      setDimInput(newDI);
    }
  }, [drawPhase]);

  function togglePlay() {
    if (isAnimating) { setIsAnimating(false); }
    else { setZSliderPos(1); setIsAnimating(true); }
  }

  // World to canvas
  const w2c = useCallback((x, y) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const cx = canvas.width / 2 + viewport.panX + x * viewport.zoom;
    const cy = canvas.height / 2 + viewport.panY - y * viewport.zoom;
    return { x: cx, y: cy };
  }, [viewport]);

  // Canvas to world
  const c2w = useCallback((cx, cy) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const x = (cx - canvas.width / 2 - viewport.panX) / viewport.zoom;
    const y = -(cy - canvas.height / 2 - viewport.panY) / viewport.zoom;
    return { x, y };
  }, [viewport]);

  // Fit view to bounds
  const fitView = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bounds) return;
    const margin = 0.85;
    const scaleX = (canvas.width * margin) / Math.max(bounds.width, 1);
    const scaleY = (canvas.height * margin) / Math.max(bounds.height, 1);
    const zoom = Math.min(scaleX, scaleY);
    const panX = -((bounds.minX + bounds.maxX) / 2) * zoom;
    const panY = ((bounds.minY + bounds.maxY) / 2) * zoom;
    dispatch({ type: 'SET_VIEWPORT', payload: { zoom, panX, panY } });
  }, [bounds, dispatch]);

  // Auto-fit on load
  useEffect(() => {
    if (bounds) fitView();
  }, [bounds]);

  // Resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      setCanvasDims({ w: canvas.width, h: canvas.height });
      draw();
    });
    ro.observe(canvas);
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    setCanvasDims({ w: canvas.width, h: canvas.height });
    return () => ro.disconnect();
  }, []);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Reference image (drawn before grid, faded)
    if (refImage && refImageRef.current) {
      const img = refImageRef.current;
      const mpp = refImage.mmPerPixel || 0.1;
      const imgW_mm = img.naturalWidth * mpp;
      const imgH_mm = img.naturalHeight * mpp;
      const screenTL = w2c(refImage.x || 0, (refImage.y || 0) + imgH_mm);
      const screenW = imgW_mm * viewport.zoom;
      const screenH = imgH_mm * viewport.zoom;
      ctx.globalAlpha = refImage.opacity ?? 0.35;
      ctx.drawImage(img, screenTL.x, screenTL.y, screenW, screenH);
      ctx.globalAlpha = 1;
    }

    drawGrid(ctx);
    drawStock(ctx);
    drawOrigin(ctx);
    drawEntities(ctx);
    drawPreviewEntities(ctx);
    if (showToolpaths) {
      drawToolpaths(ctx);
      drawTextPreviews(ctx);
    }
    if (medialAxisPolylines?.length) drawMedialAxis(ctx);
    drawPreview(ctx);
    drawMouseCoords(ctx);
  }

  function drawGrid(ctx) {
    const gridSize = 10;
    const majorEvery = 10;
    const topLeft = c2w(0, 0);
    const botRight = c2w(ctx.canvas.width, ctx.canvas.height);

    const startX = Math.floor(topLeft.x / gridSize) * gridSize;
    const endX = Math.ceil(botRight.x / gridSize) * gridSize;
    const startY = Math.floor(botRight.y / gridSize) * gridSize;
    const endY = Math.ceil(topLeft.y / gridSize) * gridSize;

    for (let x = startX; x <= endX; x += gridSize) {
      const screen = w2c(x, 0);
      const isMajor = x % (gridSize * majorEvery) === 0;
      ctx.strokeStyle = isMajor ? COLORS.gridMajor : COLORS.grid;
      ctx.lineWidth = isMajor ? 0.5 : 0.3;
      ctx.beginPath();
      ctx.moveTo(screen.x, 0);
      ctx.lineTo(screen.x, ctx.canvas.height);
      ctx.stroke();
    }
    for (let y = startY; y <= endY; y += gridSize) {
      const screen = w2c(0, y);
      const isMajor = y % (gridSize * majorEvery) === 0;
      ctx.strokeStyle = isMajor ? COLORS.gridMajor : COLORS.grid;
      ctx.lineWidth = isMajor ? 0.5 : 0.3;
      ctx.beginPath();
      ctx.moveTo(0, screen.y);
      ctx.lineTo(ctx.canvas.width, screen.y);
      ctx.stroke();
    }
  }

  function drawOrigin(ctx) {
    // Crosshair sits at the datum point, which may not be world (0,0) when
    // the stock has been fitted to the part without moving geometry.
    const ox = stockConfig?.stockOriginX ?? 0;
    const oy = stockConfig?.stockOriginY ?? 0;
    const o = w2c(ox, oy);
    const size = 12;
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(o.x, o.y - size); ctx.lineTo(o.x, o.y + size); ctx.stroke();
    ctx.strokeStyle = '#44ff44';
    ctx.beginPath(); ctx.moveTo(o.x - size, o.y); ctx.lineTo(o.x + size, o.y); ctx.stroke();
  }

  function drawStock(ctx) {
    if (!stockConfig || stockConfig.width <= 0 || stockConfig.length <= 0) return;
    // stockOriginX/Y is the world position of the datum point.
    // The stock rectangle is offset from it based on the datum fraction.
    const ox   = stockConfig.stockOriginX ?? 0;
    const oy   = stockConfig.stockOriginY ?? 0;
    const xOff = (stockConfig.datum[1] === 'l' ? 0 : stockConfig.datum[1] === 'c' ? 0.5 : 1) * stockConfig.width;
    const yOff = (stockConfig.datum[0] === 'b' ? 0 : stockConfig.datum[0] === 'm' ? 0.5 : 1) * stockConfig.length;
    const minX = ox - xOff,                    maxX = ox + stockConfig.width  - xOff;
    const minY = oy - yOff,                    maxY = oy + stockConfig.length - yOff;
    const tl = w2c(minX, maxY);
    const br = w2c(maxX, minY);
    const w = br.x - tl.x, h = br.y - tl.y;
    ctx.fillStyle = COLORS.stockFill;
    ctx.fillRect(tl.x, tl.y, w, h);
    ctx.strokeStyle = COLORS.stockBorder;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(tl.x, tl.y, w, h);
    ctx.setLineDash([]);
  }

  function drawPreviewEntities(ctx) {
    if (!previewEntities?.length) return;
    ctx.strokeStyle = 'rgba(68,255,136,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    for (const e of previewEntities) drawEntity(ctx, e);
    ctx.setLineDash([]);
  }

  function drawEntities(ctx) {
    const xf = xfRef.current;
    const gd = gripDragRef.current;
    for (const entity of entities) {
      const layer = layers[entity.layer];
      if (layer && !layer.visible) continue;

      const isSelected = selectedEntityIds.includes(entity.id);
      const isHovered = hoveredEntityId === entity.id;

      ctx.strokeStyle = isSelected ? COLORS.entitySelected : isHovered ? COLORS.entityHover : (layer?.color || COLORS.entity);
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.setLineDash([]);

      let drawn = entity;
      if (gd && entity.id === gd.entityId && gd.curWorld) {
        drawn = applyGrip(entity, gd.gripType, gd.vertexIdx, gd.curWorld, gd.arcMid, gd.arcOther);
      } else if (xf && isSelected) {
        drawn = applyXform(entity, xf);
      }
      drawEntity(ctx, drawn);

      // Grip handles on selected entities (select tool only)
      if (isSelected && activeTool === 'select') {
        const grips = getEntityGrips(drawn);
        const sz = 7;
        for (const grip of grips) {
          const s = w2c(grip.x, grip.y);
          ctx.strokeStyle = '#0a0a20';
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          if (grip.gripType === 'center') {
            ctx.fillStyle = '#44ff88'; // green diamond — circle/arc center
            ctx.beginPath();
            ctx.moveTo(s.x, s.y - sz / 2); ctx.lineTo(s.x + sz / 2, s.y);
            ctx.lineTo(s.x, s.y + sz / 2); ctx.lineTo(s.x - sz / 2, s.y);
            ctx.closePath(); ctx.fill(); ctx.stroke();
          } else if (grip.gripType === 'mid') {
            ctx.fillStyle = '#44ddff'; // cyan diamond — midpoint (move line / pull arc)
            ctx.beginPath();
            ctx.moveTo(s.x, s.y - sz / 2); ctx.lineTo(s.x + sz / 2, s.y);
            ctx.lineTo(s.x, s.y + sz / 2); ctx.lineTo(s.x - sz / 2, s.y);
            ctx.closePath(); ctx.fill(); ctx.stroke();
          } else {
            ctx.fillStyle = '#ffcc44'; // yellow square — endpoints
            ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
            ctx.strokeRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
          }
        }
      }
    }

    // Snap indicator during grip drag
    if (gd?.snapType && gd.curWorld) drawSnapIndicator(ctx, gd.curWorld, gd.snapType);
  }

  function drawEntity(ctx, entity) {
    ctx.beginPath();
    switch (entity.type) {
      case 'line': {
        const s = w2c(entity.start.x, entity.start.y);
        const e = w2c(entity.end.x, entity.end.y);
        ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
        break;
      }
      case 'circle': {
        const c = w2c(entity.center.x, entity.center.y);
        ctx.arc(c.x, c.y, entity.radius * viewport.zoom, 0, Math.PI * 2);
        break;
      }
      case 'arc': {
        const pts = arcToPoints(entity.center, entity.radius, entity.startAngle, entity.endAngle, 48);
        if (!pts.length) break;
        const first = w2c(pts[0].x, pts[0].y);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < pts.length; i++) {
          const p = w2c(pts[i].x, pts[i].y);
          ctx.lineTo(p.x, p.y);
        }
        break;
      }
      case 'polyline': {
        if (!entity.vertices?.length) break;
        const pts = polylineToPoints(entity.vertices, false);
        if (!pts.length) break;
        const first = w2c(pts[0].x, pts[0].y);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < pts.length; i++) {
          const p = w2c(pts[i].x, pts[i].y);
          ctx.lineTo(p.x, p.y);
        }
        if (entity.closed) ctx.closePath();
        break;
      }
    }
    ctx.stroke();
  }

  function drawMoveList(ctx, moves, baseCutColor) {
    const SNAP = 0.001;
    let prevX = 0, prevY = 0, curZ = 0;
    for (const move of moves) {
      const x = move.x ?? prevX;
      const y = move.y ?? prevY;
      if (move.z !== undefined) curZ = move.z;

      if (move.type === 'rapid') {
        // Hide rapid air-moves when a specific pass is selected — they're distracting.
        if (showRapids && filterZIndex === null) {
          ctx.strokeStyle = COLORS.toolpathRapid;
          ctx.lineWidth = 0.7;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          const s = w2c(prevX, prevY), e = w2c(x, y);
          ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else if (move.type === 'feed') {
        const targetZ = filterZIndex !== null ? zLevels[filterZIndex] : null;
        const atTarget = targetZ === null || Math.abs(curZ - targetZ) <= SNAP;
        if (atTarget) {
          const isPlunge = (x === prevX && y === prevY);
          // Color each Z-level pass distinctly; plunges keep their orange marker.
          let cutColor = baseCutColor;
          if (!isPlunge && zLevels.length > 0) {
            const zi = zLevels.findIndex(zl => Math.abs(zl - curZ) < SNAP);
            if (zi >= 0) cutColor = passColor(zi, zLevels.length);
          }
          ctx.strokeStyle = isPlunge ? COLORS.toolpathPlunge : cutColor;
          ctx.lineWidth = filterZIndex !== null ? 1.5 : 1;
          ctx.setLineDash([]);
          ctx.beginPath();
          const s = w2c(prevX, prevY), e = w2c(x, y);
          ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
          ctx.stroke();
        }
      }
      // Always advance position so skipped moves don't corrupt subsequent start points.
      if (move.x !== undefined) prevX = x;
      if (move.y !== undefined) prevY = y;
    }
  }

  function drawToolpaths(ctx) {
    for (const op of operations) {
      if (!op.enabled || !op.toolpath?.moves) continue;
      if (op.toolpath.subToolpaths?.length > 0) {
        // Draw each sub-toolpath in its own colour (tapered inlay etc.)
        for (const sub of op.toolpath.subToolpaths) {
          drawMoveList(ctx, sub.moves, sub.color || COLORS.toolpathCut);
        }
      } else {
        const cutColor = op.type === 'drill' ? COLORS.toolpathPlunge : COLORS.toolpathCut;
        drawMoveList(ctx, op.toolpath.moves, cutColor);
      }
      // Tab markers — drawn for ops that have tab params set, regardless of mode
      if (op.params?.tabs && op.toolpath.contours?.length) {
        drawTabMarkers(ctx, op);
      }
      // Dogbone corner markers — always shown when toolpath has candidate corners
      if (op.type === 'dogbone' && op.toolpath.candidateCorners?.length) {
        drawDogboneCorners(ctx, op);
      }
    }
    // When in manual placement mode, draw the active contour highlight even if
    // no tab markers exist yet (so the user can see what they're snapping to).
    if (tabPlacementActive && tabPlacementOpId) {
      const op = operations.find(o => o.id === tabPlacementOpId);
      if (op?.toolpath?.contours?.length) drawContourHighlight(ctx, op.toolpath.contours);
    }
  }

  // Draws orange tab markers (span + end-caps + centre crossbar) for one operation.
  function drawTabMarkers(ctx, op) {
    const p = op.params;
    const tValues = (p.tabMode === 'manual')
      ? (p.tabPositions || [])
      : computeAutoTabPositions(p.tabCount || 4);
    if (!tValues.length) return;

    for (const contour of op.toolpath.contours) {
      if (!contour || contour.length < 2) continue;

      // Arc-length table for this contour
      const n = contour.length;
      const cumLen = [0];
      for (let i = 0; i < n; i++) {
        const a = contour[i], b = contour[(i + 1) % n];
        cumLen.push(cumLen[i] + Math.hypot(b.x - a.x, b.y - a.y));
      }
      const totalLen = cumLen[n];
      if (totalLen < 1e-6) continue;

      function ptAndTangentAtT(t) {
        const s = ((t % 1) + 1) % 1 * totalLen;
        for (let i = 0; i < n; i++) {
          if (s <= cumLen[i + 1] + 1e-9) {
            const d = cumLen[i + 1] - cumLen[i];
            const frac = d > 1e-9 ? (s - cumLen[i]) / d : 0;
            const a = contour[i], b = contour[(i + 1) % n];
            return {
              x: a.x + frac * (b.x - a.x),
              y: a.y + frac * (b.y - a.y),
              tx: d > 1e-9 ? (b.x - a.x) / d : 1,
              ty: d > 1e-9 ? (b.y - a.y) / d : 0,
            };
          }
        }
        return { x: contour[0].x, y: contour[0].y, tx: 1, ty: 0 };
      }

      const tabWidth = p.tabWidth || 6;

      for (const t of tValues) {
        const { x, y, tx, ty } = ptAndTangentAtT(t);
        const halfW = Math.min(tabWidth / 2, totalLen / 4);

        // World-space tab span endpoints
        const s0w = { x: x - tx * halfW, y: y - ty * halfW };
        const s1w = { x: x + tx * halfW, y: y + ty * halfW };

        const cs0 = w2c(s0w.x, s0w.y);
        const cs1 = w2c(s1w.x, s1w.y);
        const cc  = w2c(x, y);

        // Screen-space normal (perpendicular to span, for end-caps and crossbar)
        const sdx = cs1.x - cs0.x, sdy = cs1.y - cs0.y;
        const slen = Math.hypot(sdx, sdy);
        const snx = slen > 1e-9 ? -sdy / slen : 0;
        const sny = slen > 1e-9 ?  sdx / slen : 1;

        const CAP = 5, BAR = 6; // pixels

        // Span line
        ctx.strokeStyle = '#ff8844';
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(cs0.x, cs0.y);
        ctx.lineTo(cs1.x, cs1.y);
        ctx.stroke();

        // End caps
        ctx.strokeStyle = '#ffaa66';
        ctx.lineWidth = 1.5;
        for (const c of [cs0, cs1]) {
          ctx.beginPath();
          ctx.moveTo(c.x + snx * CAP, c.y + sny * CAP);
          ctx.lineTo(c.x - snx * CAP, c.y - sny * CAP);
          ctx.stroke();
        }

        // Centre crossbar
        ctx.beginPath();
        ctx.moveTo(cc.x + snx * BAR, cc.y + sny * BAR);
        ctx.lineTo(cc.x - snx * BAR, cc.y - sny * BAR);
        ctx.stroke();
      }
    }
  }

  // Draws a soft highlight around the contour(s) of the active placement operation.
  function drawContourHighlight(ctx, contours) {
    ctx.strokeStyle = 'rgba(153, 68, 255, 0.45)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    for (const contour of contours) {
      if (!contour.length) continue;
      ctx.beginPath();
      const first = w2c(contour[0].x, contour[0].y);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < contour.length; i++) {
        const p = w2c(contour[i].x, contour[i].y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function drawDogboneCorners(ctx, op) {
    const candidates = op.toolpath?.candidateCorners;
    if (!candidates?.length) return;
    const p = op.params || {};
    const autoMode = (p.cornerMode || 'auto') === 'auto';
    const selected = p.selectedCorners || [];
    const toolR = (p.toolDiameter || 6.35) / 2;

    if ((dogboneSelectionActive && dogboneSelectionOpId === op.id) || autoMode) {
      if (op.toolpath?.contours?.length) drawContourHighlight(ctx, op.toolpath.contours);
    }

    for (const c of candidates) {
      const sc = w2c(c.x, c.y);
      const isActive = autoMode || selected.some(s => Math.hypot(s.x - c.x, s.y - c.y) < 0.1);

      ctx.beginPath();
      ctx.arc(sc.x, sc.y, 4, 0, Math.PI * 2);
      if (isActive) {
        ctx.fillStyle = '#44ff88';
        ctx.fill();
      } else {
        ctx.strokeStyle = '#778899';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (isActive) {
        const dc = w2c(c.x + toolR * c.bisX, c.y + toolR * c.bisY);
        const screenR = Math.max(2, toolR * viewport.zoom);
        ctx.strokeStyle = 'rgba(68, 255, 136, 0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(dc.x, dc.y, screenR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(68, 255, 136, 0.6)';
        ctx.beginPath();
        ctx.arc(dc.x, dc.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawTextPreviews(ctx) {
    for (const op of operations) {
      if (op.type !== 'text' || !op.enabled) continue;
      const tp = op.params;
      if (!tp.textContoursRel?.length) continue;
      const tx = tp.textX || 0, ty = tp.textY || 0;
      const isActive = textPlacementActive && textPlacementOpId === op.id;

      ctx.strokeStyle = isActive ? 'rgba(68,255,136,0.85)' : 'rgba(80,160,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);

      for (const group of tp.textContoursRel) {
        for (const contour of group) {
          if (contour.length < 2) continue;
          ctx.beginPath();
          const f = w2c(contour[0].x + tx, contour[0].y + ty);
          ctx.moveTo(f.x, f.y);
          for (let i = 1; i < contour.length; i++) {
            const pt = w2c(contour[i].x + tx, contour[i].y + ty);
            ctx.lineTo(pt.x, pt.y);
          }
          ctx.closePath();
          ctx.stroke();
        }
      }

      if (tp.textBoundsRel) {
        const b = tp.textBoundsRel;
        const tl = w2c(b.minX + tx, b.maxY + ty);
        const br = w2c(b.maxX + tx, b.minY + ty);
        ctx.strokeStyle = isActive ? 'rgba(68,255,136,0.35)' : 'rgba(80,160,255,0.25)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        ctx.setLineDash([]);
      }
    }
  }

  function drawMedialAxis(ctx) {
    if (!medialAxisPolylines?.length) return;
    ctx.setLineDash([]);
    for (let pi = 0; pi < medialAxisPolylines.length; pi++) {
      const poly = medialAxisPolylines[pi];
      if (!poly || poly.length < 2) continue;
      // Fade from semi-transparent (outermost, earliest fractions) to opaque (innermost)
      const alpha = 0.35 + 0.65 * (pi / Math.max(medialAxisPolylines.length - 1, 1));
      ctx.strokeStyle = `rgba(255,0,255,${alpha.toFixed(2)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const f = w2c(poly[0].x, poly[0].y);
      ctx.moveTo(f.x, f.y);
      for (let i = 1; i < poly.length; i++) {
        const p = w2c(poly[i].x, poly[i].y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }

  function drawMouseCoords(ctx) {
    const world = c2w(mousePos.x, mousePos.y);
    const MM_PER_INCH = 25.4;
    const cx = isInch ? world.x / MM_PER_INCH : world.x;
    const cy = isInch ? world.y / MM_PER_INCH : world.y;
    const unit = isInch ? 'in' : 'mm';
    const decimals = isInch ? 4 : 3;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(8, ctx.canvas.height - 28, 180, 20);
    ctx.fillStyle = '#aaaacc';
    ctx.font = '11px monospace';
    ctx.fillText(`X: ${cx.toFixed(decimals)}  Y: ${cy.toFixed(decimals)} ${unit}`, 14, ctx.canvas.height - 14);
  }

  function drawSnapIndicator(ctx, pt, type) {
    if (!type) return;
    const s = w2c(pt.x, pt.y);
    const sz = 7;
    ctx.setLineDash([]);
    ctx.lineWidth = 1.5;
    if (type === 'endpoint') {
      ctx.strokeStyle = '#ffcc44';
      ctx.strokeRect(s.x - sz/2, s.y - sz/2, sz, sz);
    } else if (type === 'midpoint') {
      ctx.strokeStyle = '#44aaff';
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - sz/2); ctx.lineTo(s.x + sz/2, s.y);
      ctx.lineTo(s.x, s.y + sz/2); ctx.lineTo(s.x - sz/2, s.y);
      ctx.closePath(); ctx.stroke();
    } else if (type === 'center') {
      ctx.strokeStyle = '#44ff88';
      ctx.beginPath(); ctx.arc(s.x, s.y, sz/2, 0, Math.PI*2); ctx.stroke();
    } else if (type === 'intersection') {
      ctx.strokeStyle = '#ff8844';
      ctx.beginPath();
      ctx.moveTo(s.x - sz/2, s.y - sz/2); ctx.lineTo(s.x + sz/2, s.y + sz/2);
      ctx.moveTo(s.x + sz/2, s.y - sz/2); ctx.lineTo(s.x - sz/2, s.y + sz/2);
      ctx.stroke();
    } else if (type === 'grid') {
      ctx.strokeStyle = '#44ff88'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.x - sz/2, s.y); ctx.lineTo(s.x + sz/2, s.y);
      ctx.moveTo(s.x, s.y - sz/2); ctx.lineTo(s.x, s.y + sz/2);
      ctx.stroke();
    }
  }

  function drawPreview(ctx) {
    const ds = drawStateRef.current;
    const pv = previewRef.current;
    if (!ds || !pv) return;
    const { cur, snapType, shift } = pv;
    const pts = ds.pts;

    // Committed-point markers
    ctx.setLineDash([]);
    for (const p of pts) {
      const s = w2c(p.x, p.y);
      ctx.fillStyle = '#ffcc44';
      ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI*2); ctx.fill();
    }

    ctx.strokeStyle = '#44ff88';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);

    switch (ds.tool) {
      case 'line': {
        if (pts.length < 1) break;
        const end = shift ? constrainTo45(pts[0], cur) : cur;
        const s0 = w2c(pts[0].x, pts[0].y), se = w2c(end.x, end.y);
        ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(se.x, se.y); ctx.stroke();
        break;
      }
      case 'circle': {
        if (pts.length < 1) break;
        const r = Math.hypot(cur.x - pts[0].x, cur.y - pts[0].y);
        if (r < 0.01) break;
        const c = w2c(pts[0].x, pts[0].y);
        ctx.beginPath(); ctx.arc(c.x, c.y, r * viewport.zoom, 0, Math.PI*2); ctx.stroke();
        // Radius label
        const MM_PER_INCH = 25.4;
        const rDisp = isInch ? r / MM_PER_INCH : r;
        const ls = w2c(pts[0].x, pts[0].y + r);
        ctx.setLineDash([]);
        ctx.fillStyle = '#44ff88'; ctx.font = '11px monospace';
        ctx.fillText(`r=${rDisp.toFixed(isInch?3:2)}${isInch?'″':'mm'}`, ls.x + 6, ls.y);
        break;
      }
      case 'arc': {
        if (pts.length === 1) {
          const s0 = w2c(pts[0].x, pts[0].y), sc = w2c(cur.x, cur.y);
          ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(sc.x, sc.y); ctx.stroke();
        } else if (pts.length === 2) {
          // pts[0]=start, pts[1]=midpoint, cur=end candidate
          const arc = arcFrom3Pts(pts[0], cur, pts[1]);
          if (arc) {
            const arcPts = arcToPoints(arc.center, arc.radius, arc.startAngle, arc.endAngle, 64);
            if (arcPts.length > 1) {
              const f = w2c(arcPts[0].x, arcPts[0].y);
              ctx.beginPath(); ctx.moveTo(f.x, f.y);
              for (let i = 1; i < arcPts.length; i++) {
                const p = w2c(arcPts[i].x, arcPts[i].y); ctx.lineTo(p.x, p.y);
              }
              ctx.stroke();
            }
          }
        }
        break;
      }
      case 'rect': {
        if (pts.length < 1) break;
        let dx = cur.x - pts[0].x, dy = cur.y - pts[0].y;
        if (shift) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx)*s; dy = Math.sign(dy)*s; }
        if (Math.abs(dx) < 0.01 || Math.abs(dy) < 0.01) break;
        const x2 = pts[0].x + dx, y2 = pts[0].y + dy;
        const tl = w2c(Math.min(pts[0].x, x2), Math.max(pts[0].y, y2));
        const br = w2c(Math.max(pts[0].x, x2), Math.min(pts[0].y, y2));
        ctx.beginPath(); ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y); ctx.stroke();
        break;
      }
      case 'polygon': {
        if (pts.length < 1) break;
        const r = Math.hypot(cur.x - pts[0].x, cur.y - pts[0].y);
        if (r < 0.01) break;
        const n = ds.sides || polygonSidesRef.current;
        const angle = Math.atan2(cur.y - pts[0].y, cur.x - pts[0].x);
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const a = angle + i * 2 * Math.PI / n;
          const p = w2c(pts[0].x + r * Math.cos(a), pts[0].y + r * Math.sin(a));
          if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        // Radius line
        const rp = w2c(cur.x, cur.y);
        const cp = w2c(pts[0].x, pts[0].y);
        ctx.beginPath(); ctx.moveTo(cp.x, cp.y); ctx.lineTo(rp.x, rp.y); ctx.stroke();
        break;
      }
      case 'polyline': {
        if (ds.pts.length === 0) break;
        const plPts = ds.pts, plSegs = ds.segs || [];
        // Draw committed segments
        for (let i = 0; i < plSegs.length && i < plPts.length - 1; i++) {
          const seg = plSegs[i];
          if (seg.type === 'line') {
            const s0 = w2c(plPts[i].x, plPts[i].y), se = w2c(plPts[i+1].x, plPts[i+1].y);
            ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(se.x, se.y); ctx.stroke();
          } else if (seg.type === 'arc') {
            const arc = arcFrom3Pts(plPts[i], plPts[i+1], seg.mid);
            if (arc) {
              const aPts = arcToPoints(arc.center, arc.radius, arc.startAngle, arc.endAngle, 48);
              if (aPts.length > 1) {
                const f = w2c(aPts[0].x, aPts[0].y);
                ctx.beginPath(); ctx.moveTo(f.x, f.y);
                for (let j = 1; j < aPts.length; j++) { const p = w2c(aPts[j].x, aPts[j].y); ctx.lineTo(p.x, p.y); }
                ctx.stroke();
              }
            }
          }
        }
        // Draw next-segment preview to cursor
        const lastPt = plPts[plPts.length - 1];
        if (ds.nextSegType === 'arc' && ds.arcMid !== null) {
          // Have arc midpoint, preview arc from lastPt through arcMid to cursor
          const arc = arcFrom3Pts(lastPt, cur, ds.arcMid);
          if (arc) {
            const aPts = arcToPoints(arc.center, arc.radius, arc.startAngle, arc.endAngle, 48);
            if (aPts.length > 1) {
              const f = w2c(aPts[0].x, aPts[0].y);
              ctx.beginPath(); ctx.moveTo(f.x, f.y);
              for (let j = 1; j < aPts.length; j++) { const p = w2c(aPts[j].x, aPts[j].y); ctx.lineTo(p.x, p.y); }
              ctx.stroke();
            }
          }
        } else {
          const s0 = w2c(lastPt.x, lastPt.y), se = w2c(cur.x, cur.y);
          ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(se.x, se.y); ctx.stroke();
        }
        break;
      }
      case 'measure': {
        ctx.strokeStyle = '#00ccdd';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 3]);

        // Draw locked segment(s) already placed
        for (let i = 0; i < pts.length - 1; i++) {
          const a = w2c(pts[i].x, pts[i].y), b = w2c(pts[i+1].x, pts[i+1].y);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }

        // Live arm: last locked point → cursor
        if (pts.length >= 1) {
          const last = pts[pts.length - 1];
          const ls = w2c(last.x, last.y), cs = w2c(cur.x, cur.y);
          ctx.beginPath(); ctx.moveTo(ls.x, ls.y); ctx.lineTo(cs.x, cs.y); ctx.stroke();

          // Distance label from last locked → cursor
          if (pts.length === 1) {
            const dist = Math.hypot(cur.x - last.x, cur.y - last.y);
            const label = isInch ? `${(dist / 25.4).toFixed(4)}"` : `${dist.toFixed(2)} mm`;
            drawMeasureLabel(ctx, label, (ls.x + cs.x) / 2, (ls.y + cs.y) / 2 - 14);
          }
        }

        // After 2 locked points: show locked distance + live angle
        if (pts.length >= 2) {
          // Locked distance label
          const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
          const distLabel = isInch ? `${(d / 25.4).toFixed(4)}"` : `${d.toFixed(2)} mm`;
          const m0 = w2c((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
          drawMeasureLabel(ctx, distLabel, m0.x, m0.y - 14);

          // Angle between ray pts[0]→pts[1] and ray pts[1]→cursor (at vertex pts[1])
          const dx1 = pts[0].x - pts[1].x, dy1 = pts[0].y - pts[1].y;
          const dx2 = cur.x  - pts[1].x, dy2 = cur.y  - pts[1].y;
          const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
          if (len1 > 0.001 && len2 > 0.001) {
            const dot = (dx1*dx2 + dy1*dy2) / (len1 * len2);
            const angleDeg = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
            const vs = w2c(pts[1].x, pts[1].y);
            drawMeasureLabel(ctx, `${angleDeg.toFixed(2)}°`, vs.x + 18, vs.y - 18);
            // Angle arc in screen space
            const a1 = Math.atan2(w2c(pts[0].x, pts[0].y).y - vs.y, w2c(pts[0].x, pts[0].y).x - vs.x);
            const a2 = Math.atan2(w2c(cur.x, cur.y).y     - vs.y, w2c(cur.x, cur.y).x     - vs.x);
            let span = a2 - a1;
            while (span >  Math.PI) span -= 2 * Math.PI;
            while (span < -Math.PI) span += 2 * Math.PI;
            ctx.setLineDash([3, 2]);
            ctx.beginPath(); ctx.arc(vs.x, vs.y, 22, a1, a1 + span, span < 0); ctx.stroke();
          }
        }

        ctx.setLineDash([]);
        break;
      }
      case 'mirror': {
        const p1 = pts[0];
        // Dashed axis line
        ctx.setLineDash([6, 4]);
        const a = w2c(p1.x, p1.y), b = w2c(cur.x, cur.y);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.setLineDash([]);
        // Ghost of mirrored selected entities
        const selEnts = entities.filter(e => selectedEntityIds.includes(e.id));
        if (selEnts.length > 0) {
          ctx.save();
          ctx.globalAlpha = 0.45;
          ctx.strokeStyle = '#88ccff';
          ctx.lineWidth = 1.2;
          for (const ent of selEnts) {
            drawEntity(ctx, mirrorEntity(ent, p1, cur));
          }
          ctx.restore();
        }
        break;
      }
    }
    ctx.setLineDash([]);
    drawSnapIndicator(ctx, cur, snapType);
  }

  useEffect(() => { draw(); }, [entities, layers, operations, viewport, selectedEntityIds, hoveredEntityId, showToolpaths, showRapids, mousePos, stockConfig, zSliderPos, zLevels, tabPlacementActive, tabPlacementOpId, dogboneSelectionActive, dogboneSelectionOpId, textPlacementActive, textPlacementOpId, medialAxisPolylines, liveXf, drawPhase, refImage, previewEntities]);

  // Mouse events
  const onMouseDown = useCallback((e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - viewport.panX, y: e.clientY - viewport.panY });
      return;
    }

    const canvas = canvasRef.current;
    const rect   = canvas.getBoundingClientRect();
    const cx     = e.clientX - rect.left;
    const cy     = e.clientY - rect.top;
    const world  = c2w(cx, cy);

    // ── Close context menu on any click ───────────────────────────────────
    if (contextMenu) { setContextMenu(null); }

    // ── Command mode intercept (move/paste two-point operations) ──────────
    if (e.button === 0 && cmdModeRef.current) {
      const snapped = (() => {
        const snapRadius = 14 / viewport.zoom;
        const es = snapEntities(world, entities, layers, snapRadius);
        if (es) return es;
        if (gridSnap) return { x: Math.round(world.x / 10) * 10, y: Math.round(world.y / 10) * 10 };
        return world;
      })();
      if (handleCmdModeClick(snapped)) return;
    }

    // ── Tab placement / drag mode ──────────────────────────────────────────
    if (tabPlacementActive && tabPlacementOpId) {
      const op = operations.find(o => o.id === tabPlacementOpId);
      if (op?.toolpath?.contours?.length) {
        const snapR = 20 / viewport.zoom; // world-space snap radius
        const { t, x: sx, y: sy } = snapToContour(world, op.toolpath.contours);

        if (e.button === 0) {
          const existing = (op.params.tabPositions || []);
          // Check if click is near an existing tab marker (for drag or remove)
          let nearestIdx = -1, nearestDist = Infinity;
          for (let i = 0; i < existing.length; i++) {
            const ep = tabWorldPosForT(existing[i], op.toolpath.contours);
            const d  = ep ? Math.hypot(ep.x - world.x, ep.y - world.y) : Infinity;
            if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
          }
          if (nearestIdx >= 0 && nearestDist < snapR) {
            // Start dragging existing tab
            draggingTabRef.current = { opId: tabPlacementOpId, tabIdx: nearestIdx };
          } else {
            // Place new tab
            dispatch({ type: 'UPDATE_TAB_POSITIONS', payload: { opId: tabPlacementOpId, positions: [...existing, t] } });
            showStatus(`Tab placed (${existing.length + 1} total)`);
          }
        } else if (e.button === 2) {
          // Right-click: remove nearest tab
          const existing = (op.params.tabPositions || []);
          let nearestIdx = -1, nearestDist = Infinity;
          for (let i = 0; i < existing.length; i++) {
            const ep = tabWorldPosForT(existing[i], op.toolpath.contours);
            const d  = ep ? Math.hypot(ep.x - world.x, ep.y - world.y) : Infinity;
            if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
          }
          if (nearestIdx >= 0 && nearestDist < snapR) {
            const updated = existing.filter((_, i) => i !== nearestIdx);
            dispatch({ type: 'UPDATE_TAB_POSITIONS', payload: { opId: tabPlacementOpId, positions: updated } });
            showStatus(`Tab removed (${updated.length} remaining)`);
          }
        }
        return; // don't fall through to entity selection
      }
    }

    // ── Dogbone corner selection ───────────────────────────────────────────
    if (dogboneSelectionActive && dogboneSelectionOpId && e.button === 0) {
      const op = operations.find(o => o.id === dogboneSelectionOpId);
      const candidates = op?.toolpath?.candidateCorners;
      if (candidates?.length) {
        const snapR = 15 / viewport.zoom;
        let nearestIdx = -1, nearestDist = Infinity;
        for (let i = 0; i < candidates.length; i++) {
          const d = Math.hypot(candidates[i].x - world.x, candidates[i].y - world.y);
          if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
        }
        if (nearestIdx >= 0 && nearestDist < snapR) {
          const clicked = candidates[nearestIdx];
          const existing = op.params.selectedCorners || [];
          const alreadyIdx = existing.findIndex(s => Math.hypot(s.x - clicked.x, s.y - clicked.y) < 0.1);
          let updated;
          if (alreadyIdx >= 0) {
            updated = existing.filter((_, i) => i !== alreadyIdx);
            showStatus(`Corner deselected (${updated.length} selected)`);
          } else {
            updated = [...existing, { x: clicked.x, y: clicked.y, bisX: clicked.bisX, bisY: clicked.bisY }];
            showStatus(`Corner selected (${updated.length} selected)`);
          }
          dispatch({ type: 'UPDATE_DOGBONE_CORNERS', payload: { opId: dogboneSelectionOpId, corners: updated } });
        }
        return;
      }
    }

    // ── Text placement ─────────────────────────────────────────────────────
    if (textPlacementActive && textPlacementOpId && e.button === 0) {
      const textOp = operations.find(o => o.id === textPlacementOpId);
      if (textOp) {
        dispatch({ type: 'UPDATE_OPERATION', payload: {
          id: textPlacementOpId,
          changes: { params: { ...textOp.params, textX: world.x, textY: world.y } },
        }});
        dispatch({ type: 'SET_TEXT_PLACEMENT', payload: { active: false, opId: null } });
        showStatus(`Text placed at (${world.x.toFixed(1)}, ${world.y.toFixed(1)})`);
      }
      return;
    }

    // ── Drawing tools ──────────────────────────────────────────────────────
    if (activeTool !== 'select' && e.button === 0) {
      onDrawClickRef.current?.(world, e.shiftKey, cx, cy);
      return;
    }

    // ── Grip drag ─────────────────────────────────────────────────────────
    if (e.button === 0 && activeTool === 'select' && selectedEntityIds.length > 0) {
      const snapR = 10 / viewport.zoom;
      for (const entity of entities) {
        if (!selectedEntityIds.includes(entity.id)) continue;
        for (const grip of getEntityGrips(entity)) {
          if (Math.hypot(grip.x - world.x, grip.y - world.y) < snapR) {
            let arcMid = null, arcOther = null;
            if (entity.type === 'arc') {
              const sp = { x: entity.center.x + entity.radius * Math.cos(entity.startAngle), y: entity.center.y + entity.radius * Math.sin(entity.startAngle) };
              const ep = { x: entity.center.x + entity.radius * Math.cos(entity.endAngle),   y: entity.center.y + entity.radius * Math.sin(entity.endAngle) };
              let span = entity.endAngle - entity.startAngle; if (span < 0) span += 2 * Math.PI;
              const ma = entity.startAngle + span / 2;
              const mp = { x: entity.center.x + entity.radius * Math.cos(ma), y: entity.center.y + entity.radius * Math.sin(ma) };
              if (grip.gripType === 'start') { arcMid = mp; arcOther = ep; }
              else if (grip.gripType === 'end') { arcMid = mp; arcOther = sp; }
              else if (grip.gripType === 'mid') {
                // reuse arcOther=start, arcMid=end so applyGrip can call arcFrom3Pts(start, end, newMid)
                arcOther = sp; arcMid = ep;
              }
            }
            gripDragRef.current = { entityId: entity.id, gripType: grip.gripType, vertexIdx: grip.vertexIdx ?? null, curWorld: null, snapType: null, arcMid, arcOther };
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
      }
    }

    // ── Normal entity selection / move drag ───────────────────────────────
    if (e.button === 0) {
      const hit = findEntityAt(world, 10 / viewport.zoom);
      if (hit) {
        if (e.ctrlKey || e.shiftKey) {
          dispatch({ type: 'TOGGLE_ENTITY_SELECT', payload: hit.id });
        } else if (selectedEntityIds.includes(hit.id) && selectedEntityIds.length > 0) {
          // Click on already-selected entity → start move drag
          startDrag(e, 'move', {});
        } else {
          dispatch({ type: 'SELECT_ENTITIES', payload: [hit.id] });
        }
      } else if (!e.ctrlKey) {
        dispatch({ type: 'SELECT_ENTITIES', payload: [] });
      }
    }
  }, [viewport, c2w, dispatch, tabPlacementActive, tabPlacementOpId, dogboneSelectionActive, dogboneSelectionOpId, textPlacementActive, textPlacementOpId, operations, selectedEntityIds, activeTool]);

  const onMouseMove = useCallback((e) => {
    const canvas = canvasRef.current;
    const rect   = canvas.getBoundingClientRect();
    const cx     = e.clientX - rect.left;
    const cy     = e.clientY - rect.top;
    setMousePos({ x: cx, y: cy });

    if (isPanning) {
      dispatch({ type: 'SET_VIEWPORT', payload: { panX: e.clientX - panStart.x, panY: e.clientY - panStart.y } });
      return;
    }

    // Drag an existing tab marker
    if (draggingTabRef.current) {
      const { opId, tabIdx } = draggingTabRef.current;
      const op = operations.find(o => o.id === opId);
      if (op?.toolpath?.contours?.length) {
        const world = c2w(cx, cy);
        const { t } = snapToContour(world, op.toolpath.contours);
        const updated = [...(op.params.tabPositions || [])];
        updated[tabIdx] = t;
        dispatch({ type: 'UPDATE_TAB_POSITIONS', payload: { opId, positions: updated } });
      }
      return;
    }

    // Draw tool preview (non-dragging — line/arc click modes and hover snap)
    if (!draggingTabRef.current) {
      onDrawMoveRef.current?.(cx, cy, e.shiftKey);
    }

    const world = c2w(cx, cy);
    const hit = findEntityAt(world, 8 / viewport.zoom);
    dispatch({ type: 'HOVER_ENTITY', payload: hit?.id || null });

    // Near-grip check — drives cursor style
    if (activeTool === 'select' && selectedEntityIds.length > 0) {
      const snapR = 10 / viewport.zoom;
      let near = false;
      outer: for (const ent of entities) {
        if (!selectedEntityIds.includes(ent.id)) continue;
        for (const g of getEntityGrips(ent)) {
          if (Math.hypot(g.x - world.x, g.y - world.y) < snapR) { near = true; break outer; }
        }
      }
      setNearGrip(near);
    } else if (nearGrip) {
      setNearGrip(false);
    }
  }, [isPanning, panStart, viewport, c2w, dispatch, operations]);

  const onMouseUp = useCallback(() => {
    setIsPanning(false);
    draggingTabRef.current = null;
  }, []);

  const onDoubleClick = useCallback((e) => {
    // Double-click finishes polyline drawing
    if (drawStateRef.current?.tool === 'polyline') {
      commitPolylineRef.current?.(false);
      return;
    }

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const world = c2w(e.clientX - rect.left, e.clientY - rect.top);
    const hit = findEntityAt(world, 10 / viewport.zoom);
    if (!hit || !['line', 'arc', 'polyline'].includes(hit.type)) return;

    const connectedIds = findConnectedEntities(hit, entities, layers);
    dispatch({ type: 'SELECT_ENTITIES', payload: connectedIds });
    if (connectedIds.length > 1) {
      showStatus(`Selected ${connectedIds.length} connected entities`);
    }
  }, [viewport, c2w, entities, layers, dispatch]);

  // Composite snap: entity snap first, then grid, then raw
  onDrawMoveRef.current = (cx, cy, shiftHeld) => {
    const ds = drawStateRef.current;
    if (!ds) return;
    const world = c2w(cx, cy);
    const snapRadius = 14 / viewport.zoom;
    const entitySnap = snapEntities(world, entities, layers, snapRadius);
    let snapped = world, snapType = null;
    if (entitySnap) {
      snapped = entitySnap; snapType = entitySnap.snapType;
    } else if (gridSnap) {
      snapped = { x: Math.round(world.x / 10) * 10, y: Math.round(world.y / 10) * 10 };
      snapType = 'grid';
    }
    previewRef.current = { cur: snapped, snapType, shift: shiftHeld };
    lastSnapRef.current = { pos: snapped, shift: shiftHeld };
  };

  onDrawClickRef.current = (world, shiftHeld, screenX, screenY) => {
    const ds = drawStateRef.current;
    if (!ds) return;
    const snapped = previewRef.current?.cur ?? world;

    switch (ds.tool) {
      case 'line':
        if (ds.pts.length === 0) {
          lastClickScr.current = { x: screenX ?? 0, y: screenY ?? 0 };
          drawStateRef.current = { ...ds, pts: [snapped] };
        } else {
          const end = shiftHeld ? constrainTo45(ds.pts[0], snapped) : snapped;
          dispatch({ type: 'ADD_ENTITIES', payload: [{ id: uuid(), type: 'line', layer: '0', start: { ...ds.pts[0] }, end: { ...end } }] });
          drawStateRef.current = { tool: 'line', pts: [], dragging: false };
        }
        break;
      case 'circle':
        if (ds.pts.length === 0) {
          lastClickScr.current = { x: screenX ?? 0, y: screenY ?? 0 };
          drawStateRef.current = { ...ds, pts: [snapped] };
        } else {
          const r = Math.hypot(snapped.x - ds.pts[0].x, snapped.y - ds.pts[0].y);
          if (r > 0.01) dispatch({ type: 'ADD_ENTITIES', payload: [{ id: uuid(), type: 'circle', layer: '0', center: { ...ds.pts[0] }, radius: r }] });
          drawStateRef.current = { tool: 'circle', pts: [], dragging: false };
        }
        break;
      case 'arc':
        if (ds.pts.length < 2) {
          drawStateRef.current = { ...ds, pts: [...ds.pts, snapped] };
        } else {
          // pts[0]=start, pts[1]=midpoint on arc, snapped=end
          const arc = arcFrom3Pts(ds.pts[0], snapped, ds.pts[1]);
          if (arc) dispatch({ type: 'ADD_ENTITIES', payload: [{ id: uuid(), type: 'arc', layer: '0', ...arc }] });
          drawStateRef.current = { tool: 'arc', pts: [], dragging: false };
        }
        break;
      case 'rect':
        if (ds.pts.length === 0) {
          lastClickScr.current = { x: screenX ?? 0, y: screenY ?? 0 };
          drawStateRef.current = { ...ds, pts: [snapped] };
        } else {
          let dx = snapped.x - ds.pts[0].x, dy = snapped.y - ds.pts[0].y;
          if (shiftHeld) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx)*s; dy = Math.sign(dy)*s; }
          const x2 = ds.pts[0].x + dx, y2 = ds.pts[0].y + dy;
          if (Math.abs(dx) > 0.01 && Math.abs(dy) > 0.01) {
            const minX = Math.min(ds.pts[0].x, x2), maxX = Math.max(ds.pts[0].x, x2);
            const minY = Math.min(ds.pts[0].y, y2), maxY = Math.max(ds.pts[0].y, y2);
            dispatch({ type: 'ADD_ENTITIES', payload: [{ id: uuid(), type: 'polyline', layer: '0',
              vertices: [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }],
              closed: true }] });
          }
          drawStateRef.current = { tool: 'rect', pts: [], dragging: false };
        }
        break;
      case 'polygon': {
        if (ds.pts.length === 0) {
          lastClickScr.current = { x: screenX ?? 0, y: screenY ?? 0 };
          drawStateRef.current = { ...ds, pts: [snapped] };
        } else {
          const center = ds.pts[0];
          const r = Math.hypot(snapped.x - center.x, snapped.y - center.y);
          if (r > 0.01) {
            const n = ds.sides || polygonSidesRef.current;
            const angle = Math.atan2(snapped.y - center.y, snapped.x - center.x);
            const vertices = Array.from({ length: n }, (_, i) => {
              const a = angle + i * 2 * Math.PI / n;
              return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
            });
            dispatch({ type: 'ADD_ENTITIES', payload: [{ id: uuid(), type: 'polyline', layer: '0', vertices, closed: true }] });
          }
          drawStateRef.current = { tool: 'polygon', pts: [], sides: ds.sides || polygonSidesRef.current, dragging: false };
        }
        break;
      }
      case 'mirror': {
        if (ds.pts.length === 0) {
          drawStateRef.current = { tool: 'mirror', pts: [snapped] };
        } else {
          const p1 = ds.pts[0], p2 = snapped;
          const selEnts = entities.filter(e => selectedEntityIds.includes(e.id));
          if (selEnts.length > 0) {
            const mirrored = selEnts.map(e => mirrorEntity(e, p1, p2));
            dispatch({ type: 'ADD_ENTITIES', payload: mirrored });
          }
          drawStateRef.current = { tool: 'mirror', pts: [] };
        }
        break;
      }
      case 'trim': {
        const tol = 8 / viewport.zoom;
        const hit = findEntityAt(world, tol);
        if (!hit) break;
        const others = entities.filter(e => {
          const lyr = layers[e.layer];
          return e.id !== hit.id && (!lyr || lyr.visible);
        });
        const result = doTrim(hit, world, others);
        if (result !== null) {
          dispatch({ type: 'DELETE_ENTITIES', payload: [hit.id] });
          if (result.length > 0) dispatch({ type: 'ADD_ENTITIES', payload: result });
          showStatus('Trimmed');
        } else {
          showStatus('No intersection found to trim');
        }
        break;
      }
      case 'measure': {
        const newPts = [...ds.pts, snapped];
        if (newPts.length >= 3) {
          // Show angle then reset
          drawStateRef.current = { tool: 'measure', pts: [] };
        } else {
          drawStateRef.current = { tool: 'measure', pts: newPts };
        }
        break;
      }
      case 'polyline': {
        const segs = ds.segs || [];
        if (ds.pts.length === 0) {
          drawStateRef.current = { ...ds, pts: [snapped] };
        } else if (ds.nextSegType === 'arc' && ds.arcMid === null) {
          // First arc click: store midpoint, don't advance pts yet
          drawStateRef.current = { ...ds, arcMid: snapped };
        } else if (ds.nextSegType === 'arc' && ds.arcMid !== null) {
          // Second arc click: snapped = end, arcMid already stored
          drawStateRef.current = { ...ds, pts: [...ds.pts, snapped], segs: [...segs, { type: 'arc', mid: ds.arcMid }], arcMid: null, nextSegType: 'line' };
        } else {
          drawStateRef.current = { ...ds, pts: [...ds.pts, snapped], segs: [...segs, { type: 'line' }] };
        }
        break;
      }
    }
    setDrawPhase(p => p + 1);
  };

  // Commit entity from dimension input overlay
  function commitFromDimInput() {
    const di = dimInputRef.current;
    if (!di) return;
    const { tool, anchor, vals } = di;
    const MM_PER_INCH = 25.4;
    const conv = v => isInch ? parseFloat(v) * MM_PER_INCH : parseFloat(v);

    let newEntity = null;
    if (tool === 'line') {
      const len = conv(vals.length ?? '');
      const angleDeg = parseFloat(vals.angle ?? '0');
      if (!isNaN(len) && len > 0.001) {
        const ar = angleDeg * Math.PI / 180;
        newEntity = { id: uuid(), type: 'line', layer: '0', start: { ...anchor }, end: { x: anchor.x + len * Math.cos(ar), y: anchor.y + len * Math.sin(ar) } };
      }
    } else if (tool === 'circle') {
      const dia = conv(vals.diameter ?? '');
      if (!isNaN(dia) && dia > 0.001) {
        newEntity = { id: uuid(), type: 'circle', layer: '0', center: { ...anchor }, radius: dia / 2 };
      }
    } else if (tool === 'rect') {
      const w = conv(vals.width ?? ''), h = conv(vals.height ?? '');
      if (!isNaN(w) && !isNaN(h) && Math.abs(w) > 0.001 && Math.abs(h) > 0.001) {
        const x2 = anchor.x + w, y2 = anchor.y + h;
        const minX = Math.min(anchor.x, x2), maxX = Math.max(anchor.x, x2);
        const minY = Math.min(anchor.y, y2), maxY = Math.max(anchor.y, y2);
        newEntity = { id: uuid(), type: 'polyline', layer: '0', closed: true,
          vertices: [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }] };
      }
    } else if (tool === 'polygon') {
      const n = Math.round(parseFloat(vals.sides ?? '6'));
      const r = conv(vals.radius ?? '');
      if (!isNaN(n) && n >= 3 && !isNaN(r) && r > 0.001) {
        polygonSidesRef.current = n;
        const vertices = Array.from({ length: n }, (_, i) => {
          const a = i * 2 * Math.PI / n;
          return { x: anchor.x + r * Math.cos(a), y: anchor.y + r * Math.sin(a) };
        });
        newEntity = { id: uuid(), type: 'polyline', layer: '0', closed: true, vertices };
      }
    }

    if (newEntity) dispatch({ type: 'ADD_ENTITIES', payload: [newEntity] });

    drawStateRef.current = tool === 'polygon'
      ? { tool, pts: [], sides: polygonSidesRef.current, dragging: false }
      : { tool, pts: [], dragging: false };
    previewRef.current = null;
    lastSnapRef.current = null;
    lastClickScr.current = null;
    dimInputRef.current = null;
    setDimInput(null);
    setDrawPhase(p => p + 1);
  }

  // Commit all pending polyline segments as individual line/arc entities
  function commitPolyline(close = false) {
    const ds = drawStateRef.current;
    if (!ds || ds.tool !== 'polyline') return;
    const pts = ds.pts, segs = ds.segs || [];
    if (pts.length >= 2 && segs.length >= 1) {
      const finalPts = close ? [...pts, pts[0]] : pts;
      const finalSegs = close ? [...segs, { type: 'line' }] : segs;
      const newEntities = [];
      for (let i = 0; i < finalSegs.length && i < finalPts.length - 1; i++) {
        const seg = finalSegs[i];
        if (seg.type === 'line') {
          newEntities.push({ id: uuid(), type: 'line', layer: '0', start: { ...finalPts[i] }, end: { ...finalPts[i + 1] } });
        } else if (seg.type === 'arc') {
          const arc = arcFrom3Pts(finalPts[i], finalPts[i + 1], seg.mid);
          if (arc) newEntities.push({ id: uuid(), type: 'arc', layer: '0', ...arc });
        }
      }
      if (newEntities.length > 0) dispatch({ type: 'ADD_ENTITIES', payload: newEntities });
    }
    drawStateRef.current = { tool: 'polyline', pts: [], segs: [], nextSegType: 'line', arcMid: null, dragging: false };
    previewRef.current = null;
    lastSnapRef.current = null;
    setDrawPhase(p => p + 1);
  }
  commitPolylineRef.current = commitPolyline;

  // Commit coordinate input (Space dialog) as a draw click
  function commitCoordInput() {
    const ci = coordInput;
    if (!ci) return;
    const MM_PER_INCH = 25.4;
    const xMM = isInch ? parseFloat(ci.x) * MM_PER_INCH : parseFloat(ci.x);
    const yMM = isInch ? parseFloat(ci.y) * MM_PER_INCH : parseFloat(ci.y);
    if (isNaN(xMM) || isNaN(yMM)) { setCoordInput(null); return; }
    const world = { x: xMM, y: yMM };
    previewRef.current = { cur: world, snapType: null, shift: false };
    lastSnapRef.current = { pos: world, shift: false };
    onDrawClickRef.current?.(world, false, canvasDims.w / 2, canvasDims.h / 2);
    setCoordInput(null);
  }

  const onWheelRef = useRef(null);
  onWheelRef.current = (e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    const newZoom = Math.max(0.01, Math.min(1000, viewport.zoom * factor));
    const worldX = (mx - canvas.width / 2 - viewport.panX) / viewport.zoom;
    const worldY = (my - canvas.height / 2 - viewport.panY) / viewport.zoom;
    const newPanX = mx - canvas.width / 2 - worldX * newZoom;
    const newPanY = my - canvas.height / 2 - worldY * newZoom;
    dispatch({ type: 'SET_VIEWPORT', payload: { zoom: newZoom, panX: newPanX, panY: newPanY } });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e) => onWheelRef.current(e);
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, []);

  // Window-level drag handlers (move / scale / rotate)
  onDragMoveRef.current = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;

    // Grip drag
    if (gripDragRef.current) {
      const world = c2w(cx, cy);
      const snapRadius = 14 / viewport.zoom;
      const others = entities.filter(en => en.id !== gripDragRef.current.entityId);
      const snap = snapEntities(world, others, layers, snapRadius);
      const snapped = snap || (gridSnap ? { x: Math.round(world.x/10)*10, y: Math.round(world.y/10)*10 } : world);
      gripDragRef.current = { ...gripDragRef.current, curWorld: snapped, snapType: snap?.snapType || (gridSnap ? 'grid' : null) };
      setDrawPhase(p => p + 1);
      return;
    }

    // Transform drag (move/scale/rotate handles)
    const dr = dragRef.current;
    if (dr) {
      const cur = c2w(cx, cy);
      let xf;
      if (dr.type === 'move') {
        xf = { type: 'move', dx: cur.x - dr.startWorld.x, dy: cur.y - dr.startWorld.y };
      } else if (dr.type === 'scale') {
        const orig = Math.hypot(dr.startWorld.x - dr.cx, dr.startWorld.y - dr.cy) || 1;
        const now  = Math.hypot(cur.x - dr.cx, cur.y - dr.cy);
        xf = { type: 'scale', cx: dr.cx, cy: dr.cy, s: now / orig };
      } else if (dr.type === 'rotate') {
        const a = Math.atan2(cur.y - dr.cy, cur.x - dr.cx) - dr.startAngle;
        xf = { type: 'rotate', cx: dr.cx, cy: dr.cy, a };
      }
      xfRef.current = xf;
      setLiveXf(xf);
      return;
    }

    // Draw drag (circle center → radius, rect corner → opposite corner)
    if (drawStateRef.current?.dragging) {
      onDrawMoveRef.current?.(cx, cy, e.shiftKey);
      setDrawPhase(p => p + 1); // force canvas repaint for preview
    }
  };

  onDragUpRef.current = () => {
    // Grip drag commit
    const gd = gripDragRef.current;
    if (gd) {
      gripDragRef.current = null;
      if (gd.curWorld) {
        const entity = entities.find(e => e.id === gd.entityId);
        if (entity) {
          const updated = applyGrip(entity, gd.gripType, gd.vertexIdx, gd.curWorld, gd.arcMid, gd.arcOther);
          dispatch({ type: 'TRANSFORM_ENTITIES', payload: [updated] });
        }
      }
      setDrawPhase(p => p + 1);
      return;
    }

    // Transform drag commit
    const dr = dragRef.current;
    if (dr) {
      dragRef.current = null;
      const xf = xfRef.current;
      xfRef.current = null;
      setLiveXf(null);
      if (xf) {
        const updated = entities.filter(e => selectedEntityIds.includes(e.id)).map(e => applyXform(e, xf));
        dispatch({ type: 'TRANSFORM_ENTITIES', payload: updated });
      }
      return;
    }

    // No draw-drag commit needed (circle/rect are now click-click, not drag)
    previewRef.current = null;
    setDrawPhase(p => p + 1);
  };

  useEffect(() => {
    const mm = (e) => onDragMoveRef.current && onDragMoveRef.current(e);
    const mu = ()  => onDragUpRef.current  && onDragUpRef.current();
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
    return () => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      const inputFocused = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      // Spacebar → open coord input (only when drawing, not in an input)
      if (e.key === ' ' && !inputFocused && drawStateRef.current) {
        e.preventDefault();
        setCoordInput({ x: '', y: '' });
        return;
      }

      // Polyline: Enter = finish, A = arc segment, L = line segment, C = close
      if (!inputFocused && drawStateRef.current?.tool === 'polyline') {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitPolylineRef.current?.(false);
          return;
        }
        if (e.key.toLowerCase() === 'c') {
          e.preventDefault();
          commitPolylineRef.current?.(true);
          return;
        }
        if (e.key.toLowerCase() === 'a') {
          e.preventDefault();
          drawStateRef.current = { ...drawStateRef.current, nextSegType: 'arc', arcMid: null };
          setDrawPhase(p => p + 1);
          return;
        }
        if (e.key.toLowerCase() === 'l') {
          e.preventDefault();
          drawStateRef.current = { ...drawStateRef.current, nextSegType: 'line', arcMid: null };
          setDrawPhase(p => p + 1);
          return;
        }
      }

      if (inputFocused) return;

      if (e.key === 'Escape') {
        if (contextMenu) { setContextMenu(null); return; }
        if (transformInput) { setTransformInput(null); return; }
        if (cmdModeRef.current) { setCmdModeSync(null); return; }
        if (coordInput) { setCoordInput(null); return; }
        if (dimInputRef.current) { dimInputRef.current = null; setDimInput(null); return; }
        if (drawStateRef.current) {
          drawStateRef.current = null;
          previewRef.current = null;
          lastClickScr.current = null;
          dispatch({ type: 'SET_ACTIVE_TOOL', payload: 'select' });
          setDrawPhase(p => p + 1);
        }
        return;
      }
      if (e.key === 'Delete' && selectedEntityIds.length > 0) {
        dispatch({ type: 'DELETE_ENTITIES', payload: selectedEntityIds });
        return;
      }
      if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        dispatch({ type: 'UNDO_ENTITY' });
        return;
      }
      if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
        e.preventDefault();
        dispatch({ type: 'REDO_ENTITY' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedEntityIds, dispatch, coordInput, contextMenu, transformInput]);

  // ── Context menu actions ─────────────────────────────────────────────────────

  function ctxCopy() {
    const sel = entities.filter(e => selectedEntityIds.includes(e.id));
    clipboardRef.current = sel.map(e => ({ ...e }));
    clipBasePtRef.current = null;
    setContextMenu(null);
    showStatus(`Copied ${sel.length} entit${sel.length === 1 ? 'y' : 'ies'}`);
  }

  function ctxCut() {
    const sel = entities.filter(e => selectedEntityIds.includes(e.id));
    clipboardRef.current = sel.map(e => ({ ...e }));
    clipBasePtRef.current = null;
    dispatch({ type: 'DELETE_ENTITIES', payload: selectedEntityIds });
    setContextMenu(null);
    showStatus(`Cut ${sel.length} entit${sel.length === 1 ? 'y' : 'ies'}`);
  }

  function ctxErase() {
    dispatch({ type: 'DELETE_ENTITIES', payload: selectedEntityIds });
    setContextMenu(null);
  }

  function ctxPaste() {
    const cb = clipboardRef.current;
    if (!cb.length) return;
    setContextMenu(null);
    if (clipBasePtRef.current) {
      // Enter paste-at-point mode: user clicks placement → paste relative to stored base
      setCmdModeSync({ type: 'pasteDest', base: clipBasePtRef.current, entities: cb });
      showStatus('Paste — click to place');
    } else {
      const offset = 10;
      const pasted = cb.map(e => {
        const shifted = applyXform(e, { type: 'move', dx: offset, dy: offset });
        return { ...shifted, id: uuid() };
      });
      dispatch({ type: 'ADD_ENTITIES', payload: pasted });
      dispatch({ type: 'SELECT_ENTITIES', payload: pasted.map(e => e.id) });
      showStatus(`Pasted ${pasted.length} entit${pasted.length === 1 ? 'y' : 'ies'}`);
    }
  }

  function ctxCopyWithBase() {
    const sel = entities.filter(e => selectedEntityIds.includes(e.id));
    clipboardRef.current = sel.map(e => ({ ...e }));
    clipBasePtRef.current = null;
    setContextMenu(null);
    setCmdModeSync({ type: 'pasteBase', entities: sel });
    showStatus('Copy with Base Point — click to set base point');
  }

  function ctxMove() {
    setContextMenu(null);
    setCmdModeSync({ type: 'moveBase', ids: [...selectedEntityIds] });
    showStatus('Move — click base point');
  }

  function ctxScale() {
    setContextMenu(null);
    setTransformInput({ type: 'scale', vals: { factor: '' } });
  }

  function ctxRotate() {
    setContextMenu(null);
    setTransformInput({ type: 'rotate', vals: { angle: '' } });
  }

  function commitTransformInput() {
    if (!transformInput) return;
    const { type, vals } = transformInput;
    const sel = entities.filter(e => selectedEntityIds.includes(e.id));
    if (!sel.length) { setTransformInput(null); return; }
    const bounds = selBoundsOf(entities, selectedEntityIds);
    const cx = bounds ? (bounds.minX + bounds.maxX) / 2 : 0;
    const cy = bounds ? (bounds.minY + bounds.maxY) / 2 : 0;
    let xf = null;
    if (type === 'scale') {
      const s = parseFloat(vals.factor);
      if (!isNaN(s) && s > 0) xf = { type: 'scale', cx, cy, s };
    } else if (type === 'rotate') {
      const deg = parseFloat(vals.angle);
      if (!isNaN(deg)) xf = { type: 'rotate', cx, cy, a: deg * Math.PI / 180 };
    }
    if (xf) dispatch({ type: 'TRANSFORM_ENTITIES', payload: sel.map(e => applyXform(e, xf)) });
    setTransformInput(null);
  }

  // Intercept canvas clicks when a command mode is active
  function handleCmdModeClick(world) {
    const cm = cmdModeRef.current;
    if (!cm) return false;
    if (cm.type === 'moveBase') {
      setCmdModeSync({ ...cm, type: 'moveDest', base: world });
      showStatus('Move — click destination');
      return true;
    }
    if (cm.type === 'moveDest') {
      const dx = world.x - cm.base.x, dy = world.y - cm.base.y;
      const sel = entities.filter(e => cm.ids.includes(e.id));
      const updated = sel.map(e => applyXform(e, { type: 'move', dx, dy }));
      dispatch({ type: 'TRANSFORM_ENTITIES', payload: updated });
      setCmdModeSync(null);
      return true;
    }
    if (cm.type === 'pasteBase') {
      clipBasePtRef.current = world;
      setCmdModeSync({ type: 'pasteDest', base: world, entities: cm.entities });
      showStatus('Copy with Base Point — click to place');
      return true;
    }
    if (cm.type === 'pasteDest') {
      const dx = world.x - cm.base.x, dy = world.y - cm.base.y;
      const pasted = cm.entities.map(e => {
        const shifted = applyXform(e, { type: 'move', dx, dy });
        return { ...shifted, id: uuid() };
      });
      dispatch({ type: 'ADD_ENTITIES', payload: pasted });
      dispatch({ type: 'SELECT_ENTITIES', payload: pasted.map(e => e.id) });
      setCmdModeSync(null);
      showStatus(`Pasted ${pasted.length} entit${pasted.length === 1 ? 'y' : 'ies'}`);
      return true;
    }
    return false;
  }

  function startDrag(e, type, extra) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const world = c2w(e.clientX - rect.left, e.clientY - rect.top);
    dragRef.current = { type, startWorld: world, ...extra };
    e.preventDefault();
    e.stopPropagation();
  }

  function findEntityAt(world, tolerance) {
    for (let i = entities.length - 1; i >= 0; i--) {
      const e = entities[i];
      const layer = layers[e.layer];
      if (layer && !layer.visible) continue;
      if (entityContains(e, world, tolerance)) return e;
    }
    return null;
  }

  function entityContains(entity, pt, tol) {
    switch (entity.type) {
      case 'circle': {
        const d = Math.hypot(pt.x - entity.center.x, pt.y - entity.center.y);
        return Math.abs(d - entity.radius) < tol;
      }
      case 'line': {
        const dx = entity.end.x - entity.start.x;
        const dy = entity.end.y - entity.start.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) return false;
        const t = Math.max(0, Math.min(1, ((pt.x - entity.start.x) * dx + (pt.y - entity.start.y) * dy) / (len * len)));
        const cx = entity.start.x + t * dx;
        const cy = entity.start.y + t * dy;
        return Math.hypot(pt.x - cx, pt.y - cy) < tol;
      }
      case 'polyline': {
        const pts = polylineToPoints(entity.vertices, false);
        for (let i = 0; i < pts.length - 1; i++) {
          const dx = pts[i+1].x - pts[i].x;
          const dy = pts[i+1].y - pts[i].y;
          const len = Math.hypot(dx, dy);
          if (len < 1e-9) continue;
          const t = Math.max(0, Math.min(1, ((pt.x - pts[i].x) * dx + (pt.y - pts[i].y) * dy) / (len * len)));
          const cx = pts[i].x + t * dx;
          const cy = pts[i].y + t * dy;
          if (Math.hypot(pt.x - cx, pt.y - cy) < tol) return true;
        }
        return false;
      }
      case 'arc': {
        const d = Math.hypot(pt.x - entity.center.x, pt.y - entity.center.y);
        if (Math.abs(d - entity.radius) > tol) return false;
        const angle = Math.atan2(pt.y - entity.center.y, pt.x - entity.center.x);
        let end = entity.endAngle;
        if (end <= entity.startAngle) end += Math.PI * 2;
        let a = angle;
        if (a < entity.startAngle) a += Math.PI * 2;
        return a >= entity.startAngle && a <= end;
      }
      default: return false;
    }
  }

  // Selection bounding box in world space, updated live during drag
  const selBnds = useMemo(() => {
    const raw = selBoundsOf(entities, selectedEntityIds);
    if (!raw || !liveXf) return raw;
    const corners = [
      { x: raw.minX, y: raw.minY }, { x: raw.maxX, y: raw.minY },
      { x: raw.maxX, y: raw.maxY }, { x: raw.minX, y: raw.maxY },
    ].map(p => {
      const ap = applyXform({ type: 'line', start: p, end: p }, liveXf);
      return ap.start;
    });
    return { minX: Math.min(...corners.map(c=>c.x)), maxX: Math.max(...corners.map(c=>c.x)), minY: Math.min(...corners.map(c=>c.y)), maxY: Math.max(...corners.map(c=>c.y)) };
  }, [entities, selectedEntityIds, liveXf, canvasDims]);

  // Convert world bbox → screen pixels for the overlay div
  const overlayScreen = useMemo(() => {
    if (!selBnds) return null;
    const tl = w2c(selBnds.minX, selBnds.maxY);
    const br = w2c(selBnds.maxX, selBnds.minY);
    return { left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y,
      cx: (tl.x + br.x) / 2, cy: (tl.y + br.y) / 2 };
  }, [selBnds, viewport]);

  // World-space centre of the selection bbox (for rotate/scale pivot)
  const selCentre = useMemo(() => {
    if (!selBnds) return null;
    return { x: (selBnds.minX + selBnds.maxX) / 2, y: (selBnds.minY + selBnds.maxY) / 2 };
  }, [selBnds]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: COLORS.background }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block',
          cursor: isPanning ? 'grabbing' : nearGrip ? 'pointer' : (tabPlacementActive || dogboneSelectionActive || textPlacementActive) ? 'cell' : activeTool !== 'select' ? 'crosshair' : 'default' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={e => {
          e.preventDefault();
          if (tabPlacementActive || dogboneSelectionActive || textPlacementActive) return;
          const canvas = canvasRef.current;
          const rect = canvas.getBoundingClientRect();
          const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
          // Clamp menu so it doesn't overflow canvas
          const menuW = 200, menuH = 240;
          const x = Math.min(cx, rect.width  - menuW - 4);
          const y = Math.min(cy, rect.height - menuH - 4);
          setContextMenu({ x: Math.max(0, x), y: Math.max(0, y) });
        }}
      />
      {/* Toolbar overlays */}
      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4 }}>
        <CanvasButton title="Zoom Fit" onClick={fitView}>⊡</CanvasButton>
        <CanvasButton title="Zoom In" onClick={() => dispatch({ type: 'SET_VIEWPORT', payload: { zoom: viewport.zoom * 1.4 } })}>+</CanvasButton>
        <CanvasButton title="Zoom Out" onClick={() => dispatch({ type: 'SET_VIEWPORT', payload: { zoom: viewport.zoom / 1.4 } })}>−</CanvasButton>
      </div>
      {showToolpaths && zLevels.length > 0 && (
        <div style={{ position: 'absolute', bottom: 32, left: '50%', transform: 'translateX(-50%)', background: 'rgba(10,10,30,0.88)', border: '1px solid #2a2a50', borderRadius: 6, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'all', userSelect: 'none' }}>
          <button
            onClick={togglePlay}
            title={isAnimating ? 'Stop' : 'Play through passes'}
            style={{ width: 22, height: 22, background: '#111128', border: '1px solid #4444aa', color: '#aaaacc', borderRadius: 3, cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0 }}
          >
            {isAnimating ? '⏹' : '▶'}
          </button>
          <input
            type="range" min={0} max={zLevels.length} value={Math.min(zSliderPos, zLevels.length)}
            style={{ width: 160, cursor: 'pointer', accentColor: filterZIndex !== null ? passColor(filterZIndex, zLevels.length) : '#5566ff' }}
            onChange={e => { setIsAnimating(false); setZSliderPos(Number(e.target.value)); }}
          />
          {zSliderPos === 0
            ? <span style={{ color: '#666688', fontSize: 11, fontFamily: 'monospace', minWidth: 112 }}>all passes</span>
            : <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#ccccee', minWidth: 112, display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 9, height: 9, borderRadius: 2, background: passColor(filterZIndex, zLevels.length), flexShrink: 0 }} />
                {`Z${(zLevels[filterZIndex] ?? 0).toFixed(2)}  ${zSliderPos}/${zLevels.length}`}
              </div>}
        </div>
      )}
      {statusMsg && (
        <div style={{ position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.75)', color: '#ffcc44', padding: '5px 14px', borderRadius: 4, fontSize: 12, pointerEvents: 'none', whiteSpace: 'nowrap', border: '1px solid rgba(255,204,68,0.3)' }}>
          {statusMsg}
        </div>
      )}
      {entities.length === 0 && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', color: '#555577', textAlign: 'center', pointerEvents: 'none' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📐</div>
          <div style={{ fontSize: 16, fontFamily: 'sans-serif' }}>Import a DXF file to begin</div>
          <div style={{ fontSize: 12, marginTop: 6, opacity: 0.6 }}>File → Import DXF  or  Ctrl+I</div>
        </div>
      )}
      {tabPlacementActive && (
        <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', background: 'rgba(80,20,120,0.88)', color: '#cc88ff', padding: '4px 14px', borderRadius: 4, fontSize: 11, pointerEvents: 'none', border: '1px solid rgba(153,68,255,0.5)', whiteSpace: 'nowrap' }}>
          Left-click to place tab · Right-click to remove · Drag to reposition
        </div>
      )}
      {dogboneSelectionActive && (
        <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', background: 'rgba(10,50,30,0.88)', color: '#44ff88', padding: '4px 14px', borderRadius: 4, fontSize: 11, pointerEvents: 'none', border: '1px solid rgba(68,255,136,0.4)', whiteSpace: 'nowrap' }}>
          Click corners to toggle dogbone fillets
        </div>
      )}
      {textPlacementActive && (
        <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', background: 'rgba(10,30,60,0.88)', color: '#88ccff', padding: '4px 14px', borderRadius: 4, fontSize: 11, pointerEvents: 'none', border: '1px solid rgba(80,160,255,0.4)', whiteSpace: 'nowrap' }}>
          Click to place text origin (baseline of first line)
        </div>
      )}

      {/* ── Drawing tool status banner ───────────────────────────────────────── */}
      {activeTool !== 'select' && !tabPlacementActive && !dogboneSelectionActive && !textPlacementActive && (() => {
        const ds = drawStateRef.current;
        const msgs = {
          line:     ds?.pts?.length === 1 ? 'Click to set endpoint (Shift = 45°)' : 'Click to set start point',
          circle:   ds?.pts?.length === 1 ? 'Click to set radius point (or type diameter above)' : 'Click to set center',
          arc:      ds?.pts?.length === 2 ? 'Click to set end point' : ds?.pts?.length === 1 ? 'Click midpoint on arc' : 'Click to set start point',
          rect:     ds?.pts?.length === 1 ? 'Click opposite corner (Shift = square, or type W/H above)' : 'Click first corner',
          polyline: ds?.nextSegType === 'arc'
            ? (ds?.arcMid ? 'Click arc end point · L = line mode · Enter = finish' : 'Click arc midpoint · L = line mode')
            : (ds?.pts?.length === 0 ? 'Click to start · A = arc seg · Enter = finish · Dbl-click = finish' : 'Click to add point · A = arc · C = close · Enter = finish'),
          polygon:  ds?.pts?.length === 1 ? 'Click to set radius (or type Sides/Radius above)' : 'Click to set center',
          mirror:   ds?.pts?.length === 1 ? 'Click second point of mirror axis' : selectedEntityIds.length === 0 ? 'Select entities first, then click mirror axis start' : 'Click first point of mirror axis',
          measure:  ds?.pts?.length === 2 ? 'Click third point to measure angle · Esc to reset' : ds?.pts?.length === 1 ? 'Click second point to lock distance' : 'Click first point',
          trim:     'Click segment to trim · Esc to exit',
        };
        const labels = { line: 'Line', circle: 'Circle', arc: 'Arc', rect: 'Rectangle', polyline: 'Polyline', polygon: 'Polygon', mirror: 'Mirror', measure: 'Measure', trim: 'Trim' };
        return (
          <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', background: 'rgba(10,30,10,0.9)', color: '#88ff88', padding: '4px 14px', borderRadius: 4, fontSize: 11, pointerEvents: 'none', border: '1px solid rgba(68,255,68,0.4)', whiteSpace: 'nowrap' }}>
            <strong>{labels[activeTool]}</strong> — {msgs[activeTool]} · Esc to cancel
          </div>
        );
      })()}

      {/* ── Dimension input overlay ──────────────────────────────────────────── */}
      {dimInput && (() => {
        const { tool, screen, vals } = dimInput;
        const unit = isInch ? 'in' : 'mm';
        const left = Math.min(screen.x + 18, canvasDims.w - 180);
        const top  = Math.max(screen.y - 90, 8);
        const inputSt = { background:'#0d0d20', border:'1px solid #3344aa', color:'#cce', borderRadius:3, padding:'3px 6px', fontSize:11, width:90, fontFamily:'monospace' };
        const rowSt = { display:'flex', alignItems:'center', gap:6, marginBottom:4 };
        const lblSt = { fontSize:10, color:'#8888bb', width:65, textAlign:'right', flexShrink:0 };

        function onEnter(e) { if (e.key === 'Enter') { commitFromDimInput(); } else if (e.key === 'Escape') { dimInputRef.current = null; setDimInput(null); } }
        function updateVal(k, v) { const nd = { ...dimInputRef.current, vals: { ...dimInputRef.current.vals, [k]: v } }; dimInputRef.current = nd; setDimInput(nd); }

        return (
          <div style={{ position:'absolute', left, top, background:'rgba(8,8,28,0.97)', border:'1px solid #3344aa', borderRadius:5, padding:'8px 10px', zIndex:15, fontSize:11, color:'#aab', boxShadow:'0 2px 8px rgba(0,0,0,0.6)' }}>
            {tool === 'line' && <>
              <div style={rowSt}><span style={lblSt}>Length ({unit})</span><input autoFocus style={inputSt} type="text" value={vals.length??''} onChange={e=>updateVal('length',e.target.value)} onKeyDown={onEnter} /></div>
              <div style={rowSt}><span style={lblSt}>Angle (°)</span><input style={inputSt} type="text" value={vals.angle??'0'} onChange={e=>updateVal('angle',e.target.value)} onKeyDown={onEnter} /></div>
            </>}
            {tool === 'circle' && (
              <div style={rowSt}><span style={lblSt}>Diameter ({unit})</span><input autoFocus style={inputSt} type="text" value={vals.diameter??''} onChange={e=>updateVal('diameter',e.target.value)} onKeyDown={onEnter} /></div>
            )}
            {tool === 'rect' && <>
              <div style={rowSt}><span style={lblSt}>Width ({unit})</span><input autoFocus style={inputSt} type="text" value={vals.width??''} onChange={e=>updateVal('width',e.target.value)} onKeyDown={onEnter} /></div>
              <div style={rowSt}><span style={lblSt}>Height ({unit})</span><input style={inputSt} type="text" value={vals.height??''} onChange={e=>updateVal('height',e.target.value)} onKeyDown={onEnter} /></div>
            </>}
            {tool === 'polygon' && <>
              <div style={rowSt}><span style={lblSt}>Sides</span><input autoFocus style={inputSt} type="text" value={vals.sides??'6'} onChange={e=>updateVal('sides',e.target.value)} onKeyDown={onEnter} /></div>
              <div style={rowSt}><span style={lblSt}>Radius ({unit})</span><input style={inputSt} type="text" value={vals.radius??''} onChange={e=>updateVal('radius',e.target.value)} onKeyDown={onEnter} /></div>
            </>}
            <div style={{ fontSize:9, color:'#445566', marginTop:3 }}>Enter to commit · Esc to freehand</div>
          </div>
        );
      })()}

      {/* ── Coordinate input dialog (Spacebar) ───────────────────────────────── */}
      {coordInput && (() => {
        const unit = isInch ? 'in' : 'mm';
        const inputSt = { background:'#0d0d20', border:'1px solid #3344aa', color:'#cce', borderRadius:3, padding:'3px 8px', fontSize:12, width:110, fontFamily:'monospace' };
        const rowSt = { display:'flex', alignItems:'center', gap:8, marginBottom:6 };
        const lblSt = { fontSize:11, color:'#8888bb', width:60, textAlign:'right', flexShrink:0 };
        function onKey(e) {
          if (e.key === 'Enter') commitCoordInput();
          else if (e.key === 'Escape') setCoordInput(null);
          else if (e.key === 'Tab') { e.preventDefault(); const inputs = document.querySelectorAll('[data-coord-input]'); const cur = [...inputs].indexOf(e.target); inputs[(cur+1)%inputs.length]?.focus(); }
        }
        return (
          <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'rgba(8,8,28,0.97)', border:'1px solid #4455cc', borderRadius:6, padding:'14px 16px', zIndex:20, minWidth:220, boxShadow:'0 4px 16px rgba(0,0,0,0.7)' }}>
            <div style={{ fontSize:12, fontWeight:600, color:'#8888ff', marginBottom:10 }}>Set Point ({unit})</div>
            <div style={rowSt}><span style={lblSt}>X</span><input data-coord-input autoFocus style={inputSt} type="text" value={coordInput.x} onChange={e=>setCoordInput(c=>({...c,x:e.target.value}))} onKeyDown={onKey} /></div>
            <div style={rowSt}><span style={lblSt}>Y</span><input data-coord-input style={inputSt} type="text" value={coordInput.y} onChange={e=>setCoordInput(c=>({...c,y:e.target.value}))} onKeyDown={onKey} /></div>
            <div style={{ fontSize:9, color:'#445566', marginTop:4 }}>Enter to place · Esc to cancel · Tab to switch fields</div>
          </div>
        );
      })()}

      {/* ── Entity transform overlay ─────────────────────────────────────────── */}
      {overlayScreen && selectedEntityIds.length > 0 && !tabPlacementActive && !dogboneSelectionActive && !textPlacementActive && (() => {
        const { left, top, width, height, cx, cy } = overlayScreen;
        const handleSize = 10;
        const hs = handleSize / 2;
        const rotHandleY = top - 24;
        const scaleCorners = [
          { key: 'tl', x: left,         y: top },
          { key: 'tr', x: left + width, y: top },
          { key: 'bl', x: left,         y: top + height },
          { key: 'br', x: left + width, y: top + height },
        ];
        return (
          <>
            {/* Dashed selection bbox */}
            <div style={{ position: 'absolute', left, top, width, height, border: '1.5px dashed rgba(255,204,68,0.7)', pointerEvents: 'none', boxSizing: 'border-box' }} />

            {/* Rotate handle */}
            <div
              title="Rotate"
              style={{ position: 'absolute', left: cx - hs, top: rotHandleY - hs, width: handleSize, height: handleSize, borderRadius: '50%', background: '#88ccff', border: '1.5px solid #fff', cursor: 'grab', boxSizing: 'border-box' }}
              onMouseDown={e => { if (selCentre) startDrag(e, 'rotate', { cx: selCentre.x, cy: selCentre.y, startAngle: Math.atan2(c2w(e.clientX - canvasRef.current.getBoundingClientRect().left, e.clientY - canvasRef.current.getBoundingClientRect().top).y - selCentre.y, c2w(e.clientX - canvasRef.current.getBoundingClientRect().left, e.clientY - canvasRef.current.getBoundingClientRect().top).x - selCentre.x) }); }}
            />

            {/* Scale corner handles — hidden for single-entity selection (grips handle editing) */}
            {selectedEntityIds.length > 1 && scaleCorners.map(({ key, x, y }) => (
              <div
                key={key}
                title="Scale"
                style={{ position: 'absolute', left: x - hs, top: y - hs, width: handleSize, height: handleSize, background: '#ffcc44', border: '1.5px solid #fff', cursor: 'nwse-resize', boxSizing: 'border-box' }}
                onMouseDown={e => { if (selCentre) startDrag(e, 'scale', { cx: selCentre.x, cy: selCentre.y }); }}
              />
            ))}

            {/* Delete button */}
            <div
              title="Delete (Del)"
              style={{ position: 'absolute', left: left + width + 4, top: top - 2, background: '#cc2222', color: '#fff', border: 'none', borderRadius: 3, width: 18, height: 18, fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}
              onMouseDown={e => { e.stopPropagation(); dispatch({ type: 'DELETE_ENTITIES', payload: selectedEntityIds }); }}
            >
              ✕
            </div>
          </>
        );
      })()}

      {/* ── Command mode banner ───────────────────────────────────────────── */}
      {cmdMode && !transformInput && (
        <div style={{ position:'absolute', top:8, left:'50%', transform:'translateX(-50%)', background:'rgba(30,10,30,0.92)', color:'#ff88ff', padding:'4px 14px', borderRadius:4, fontSize:11, pointerEvents:'none', border:'1px solid rgba(255,68,255,0.4)', whiteSpace:'nowrap' }}>
          {cmdMode.type === 'moveBase'  && <><strong>Move</strong> — click base point · Esc to cancel</>}
          {cmdMode.type === 'moveDest'  && <><strong>Move</strong> — click destination · Esc to cancel</>}
          {cmdMode.type === 'pasteBase' && <><strong>Copy with Base Point</strong> — click to set base · Esc to cancel</>}
          {cmdMode.type === 'pasteDest' && <><strong>Paste</strong> — click to place · Esc to cancel</>}
        </div>
      )}

      {/* ── Transform input overlay (scale / rotate) ─────────────────────── */}
      {transformInput && (() => {
        const { type, vals } = transformInput;
        const inputSt = { background:'#0d0d20', border:'1px solid #3344aa', color:'#cce', borderRadius:3, padding:'3px 6px', fontSize:11, width:90, fontFamily:'monospace' };
        const rowSt = { display:'flex', alignItems:'center', gap:6, marginBottom:4 };
        const lblSt = { fontSize:10, color:'#8888bb', width:60, textAlign:'right', flexShrink:0 };
        const updTI = (k, v) => setTransformInput(ti => ({ ...ti, vals: { ...ti.vals, [k]: v } }));
        const onKey = (e) => { if (e.key === 'Enter') commitTransformInput(); else if (e.key === 'Escape') setTransformInput(null); };
        return (
          <div style={{ position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)', background:'rgba(8,8,28,0.97)', border:'1px solid #3344aa', borderRadius:5, padding:'10px 14px', zIndex:20, fontSize:11, color:'#aab', boxShadow:'0 2px 12px rgba(0,0,0,0.7)', minWidth:200 }}>
            <div style={{ fontSize:11, color:'#8888bb', marginBottom:8 }}>{type === 'scale' ? 'Scale Selected' : 'Rotate Selected'}</div>
            {type === 'scale' && (
              <div style={rowSt}><span style={lblSt}>Factor</span><input autoFocus style={inputSt} type="text" placeholder="e.g. 2 or 0.5" value={vals.factor} onChange={e=>updTI('factor',e.target.value)} onKeyDown={onKey} /></div>
            )}
            {type === 'rotate' && (
              <div style={rowSt}><span style={lblSt}>Degrees</span><input autoFocus style={inputSt} type="text" placeholder="e.g. 45 or -90" value={vals.angle} onChange={e=>updTI('angle',e.target.value)} onKeyDown={onKey} /></div>
            )}
            <div style={{ display:'flex', gap:6, marginTop:4 }}>
              <button onClick={commitTransformInput} style={{ flex:1, background:'#1a3a1a', border:'1px solid #44aa44', color:'#88ff88', borderRadius:3, padding:'3px 0', fontSize:11, cursor:'pointer' }}>Apply</button>
              <button onClick={() => setTransformInput(null)} style={{ flex:1, background:'#1a1a3a', border:'1px solid #3344aa', color:'#8888cc', borderRadius:3, padding:'3px 0', fontSize:11, cursor:'pointer' }}>Cancel</button>
            </div>
          </div>
        );
      })()}

      {/* ── Right-click context menu ──────────────────────────────────────── */}
      {contextMenu && (() => {
        const hasSel = selectedEntityIds.length > 0;
        const hasCB  = clipboardRef.current.length > 0;
        const mnuSt = { position:'absolute', left:contextMenu.x, top:contextMenu.y, background:'#151528', border:'1px solid #3344aa', borderRadius:5, zIndex:25, minWidth:190, boxShadow:'0 4px 16px rgba(0,0,0,0.7)', overflow:'hidden', fontSize:12 };
        const itemSt = (disabled) => ({ padding:'6px 14px', cursor:disabled?'default':'pointer', color:disabled?'#444466':'#ccccee', background:'transparent', display:'block', width:'100%', textAlign:'left', border:'none', fontSize:12 });
        const divSt = { borderTop:'1px solid #2a2a50', margin:'2px 0' };
        const Item = ({ label, onClick, disabled }) => (
          <button style={itemSt(disabled)} disabled={disabled}
            onMouseEnter={e => { if (!disabled) e.target.style.background='#1e1e40'; }}
            onMouseLeave={e => { e.target.style.background='transparent'; }}
            onClick={onClick}>{label}</button>
        );
        return (
          <div style={mnuSt}>
            {hasSel && <>
              <Item label="Cut"                 onClick={ctxCut} />
              <Item label="Copy"                onClick={ctxCopy} />
              <Item label="Copy with Base Point" onClick={ctxCopyWithBase} />
              <div style={divSt} />
              <Item label="Move"                onClick={ctxMove} />
              <Item label="Scale…"              onClick={ctxScale} />
              <Item label="Rotate…"             onClick={ctxRotate} />
              <div style={divSt} />
              <Item label="Erase"               onClick={ctxErase} />
            </>}
            {hasCB && <>
              {hasSel && <div style={divSt} />}
              <Item label="Paste" onClick={ctxPaste} />
            </>}
            {!hasSel && !hasCB && (
              <div style={{ padding:'8px 14px', color:'#555577', fontSize:11 }}>Nothing selected</div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// Snap world-point to the nearest point on any of the given closed contour polygons.
// Returns { t: 0..1, x, y } where t is the arc-fraction along the closest contour.
function snapToContour(worldPt, contours) {
  let bestDist = Infinity, bestT = 0, bestX = 0, bestY = 0;
  for (const contour of contours) {
    if (!contour || contour.length < 2) continue;
    const n = contour.length;
    const cumLen = [0];
    for (let i = 0; i < n; i++) {
      const a = contour[i], b = contour[(i + 1) % n];
      cumLen.push(cumLen[i] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const totalLen = cumLen[n];
    if (totalLen < 1e-6) continue;
    for (let i = 0; i < n; i++) {
      const a = contour[i], b = contour[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const t  = Math.max(0, Math.min(1, ((worldPt.x - a.x) * dx + (worldPt.y - a.y) * dy) / (len * len)));
      const cx = a.x + t * dx, cy = a.y + t * dy;
      const d  = Math.hypot(worldPt.x - cx, worldPt.y - cy);
      if (d < bestDist) {
        bestDist = d;
        bestX = cx; bestY = cy;
        bestT = (cumLen[i] + t * len) / totalLen;
      }
    }
  }
  return { t: bestT, x: bestX, y: bestY };
}

// Return the world-space XY of a tab at arc-fraction t on the given contours.
function tabWorldPosForT(t, contours) {
  for (const contour of contours) {
    if (!contour || contour.length < 2) continue;
    const n = contour.length;
    const cumLen = [0];
    for (let i = 0; i < n; i++) {
      const a = contour[i], b = contour[(i + 1) % n];
      cumLen.push(cumLen[i] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const totalLen = cumLen[n];
    if (totalLen < 1e-6) continue;
    const s = ((t % 1) + 1) % 1 * totalLen;
    for (let i = 0; i < n; i++) {
      if (s <= cumLen[i + 1] + 1e-9) {
        const d    = cumLen[i + 1] - cumLen[i];
        const frac = d > 1e-9 ? (s - cumLen[i]) / d : 0;
        const a    = contour[i], b = contour[(i + 1) % n];
        return { x: a.x + frac * (b.x - a.x), y: a.y + frac * (b.y - a.y) };
      }
    }
  }
  return null;
}

// Maps a pass index to a distinct hue: red (shallow) → blue (deep).
function passColor(index, total) {
  const hue = Math.round((index / Math.max(total - 1, 1)) * 270);
  return `hsl(${hue}, 85%, 55%)`;
}

// Returns the two connectable endpoint positions for line/arc/polyline.
// Circles have no endpoints and return [].
function getEndpoints(entity) {
  switch (entity.type) {
    case 'line':
      return [entity.start, entity.end];
    case 'arc': {
      const { center, radius, startAngle, endAngle } = entity;
      return [
        { x: center.x + radius * Math.cos(startAngle), y: center.y + radius * Math.sin(startAngle) },
        { x: center.x + radius * Math.cos(endAngle),   y: center.y + radius * Math.sin(endAngle)   },
      ];
    }
    case 'polyline': {
      if (!entity.vertices?.length) return [];
      const first = entity.vertices[0];
      const last  = entity.vertices[entity.vertices.length - 1];
      return [{ x: first.x, y: first.y }, { x: last.x, y: last.y }];
    }
    default:
      return [];
  }
}

// BFS walk: starting from startEntity, follow endpoint connections (within 0.01 mm)
// through all visible line/arc/polyline entities and return the complete set of IDs.
function findConnectedEntities(startEntity, allEntities, allLayers) {
  const SNAP = 0.01;
  function ptDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // Pre-compute endpoints for every chainable, visible entity.
  const candidates = allEntities
    .filter(e => {
      if (!['line', 'arc', 'polyline'].includes(e.type)) return false;
      const layer = allLayers[e.layer];
      return !(layer && !layer.visible);
    })
    .map(e => ({ id: e.id, pts: getEndpoints(e) }))
    .filter(c => c.pts.length > 0);

  const selected = new Set([startEntity.id]);
  // The frontier is the set of open endpoints we still need to match against.
  let searchPts = getEndpoints(startEntity);

  while (searchPts.length > 0) {
    const nextPts = [];
    for (const sp of searchPts) {
      for (const cand of candidates) {
        if (selected.has(cand.id)) continue;
        for (const cp of cand.pts) {
          if (ptDist(sp, cp) <= SNAP) {
            selected.add(cand.id);
            // The other endpoint(s) of the newly added segment become new search points.
            nextPts.push(...cand.pts.filter(p => ptDist(p, sp) > SNAP));
            break;
          }
        }
      }
    }
    searchPts = nextPts;
  }

  return [...selected];
}

function CanvasButton({ title, onClick, children }) {
  return (
    <button onClick={onClick} title={title} style={{ width: 28, height: 28, background: 'rgba(30,30,60,0.8)', border: '1px solid #444488', color: '#aaaacc', borderRadius: 4, cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </button>
  );
}
