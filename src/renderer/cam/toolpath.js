// CAM Toolpath Engine - all 2.5D operations

import { offsetPolyline, roundedOffsetPolyline, generatePocketOffsets, generateRestMachiningPasses, generateRasterPasses, polygonArea, isClockwise, clipPolygonToRegion, stripClose, pointInPolygon, differencePolygons, unionPolygons, intersectPolygons } from './offset.js';
import { circleToPoints, arcToPoints, polylineToPoints } from '../dxf/parser.js';
// jspoly loaded as a global via public/index.html <script> tag (webpack can't bundle it â€” it has internal requires).
// In browser context the IIFE sets window.JSPoly (uppercase); module.exports.jspoly only exists in Node.
const _jspoly = window.JSPoly;

// â”€â”€ Entry point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Compute the TRUE medial axis (skeleton) of V-carve shapes for visualization.
// Uses the same JSPoly Voronoi engine as the toolpath generator, so the preview
// exactly matches the equidistant centerline that the V-bit will follow.
// Returns {polylines: [[{x,y},...], ...]} â€” one 2-point polyline per medial axis edge.
export function computeVCarveMedialAxis(op, entities) {
  if (!op.selectedIds?.length) return { polylines: [] };
  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { polylines: [] };

  const allProfiles = buildPocketProfiles(selected);
  if (!allProfiles.length) return { polylines: [] };

  allProfiles.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));

  const shapeGroups = [];
  for (const rawProfile of allProfiles) {
    let placed = false;
    for (const group of shapeGroups) {
      if (rawProfile.some(pt => pointInPolygon(pt, group.outer))) {
        group.holes.push(rawProfile); placed = true; break;
      }
    }
    if (!placed) shapeGroups.push({ outer: rawProfile, holes: [] });
  }

  const polylines = [];

  for (const { outer: rawOuter, holes } of shapeGroups) {
    const outer = stripClose([...rawOuter]);
    if (outer.length < 3) continue;
    const jsHoles = holes.map(h => stripClose([...h]).map(v => ({ x: v.x, y: v.y })));

    let segs;
    try {
      segs = _jspoly.construct_medial_axis(outer.map(v => ({ x: v.x, y: v.y })), jsHoles, 0.1, undefined, 0);
    } catch (_) { continue; }
    if (!segs?.length) continue;

    segs = segs.filter(s => s.point0.radius > 1e-6 || s.point1.radius > 1e-6);
    if (!segs.length) continue;

    // Build adjacency graph
    const nodeMap = new Map();
    const ptKey  = v => `${v.x.toFixed(4)},${v.y.toFixed(4)}`;
    const getNode = v => {
      const k = ptKey(v);
      if (!nodeMap.has(k)) nodeMap.set(k, { x: v.x, y: v.y, radius: v.radius, adj: [] });
      return nodeMap.get(k);
    };
    for (const seg of segs) {
      const n0 = getNode(seg.point0), n1 = getNode(seg.point1);
      if (n0 !== n1 && !n0.adj.includes(n1)) { n0.adj.push(n1); n1.adj.push(n0); }
    }

    // Prune short hair branches (same threshold as the toolpath generator)
    let anyPruned = true;
    while (anyPruned) {
      anyPruned = false;
      for (const [key, node] of [...nodeMap]) {
        if (node.adj.length !== 1) continue;
        const nbr = node.adj[0];
        if (Math.hypot(node.x - nbr.x, node.y - nbr.y) < 1.5) {
          nbr.adj = nbr.adj.filter(n => n !== node);
          nodeMap.delete(key);
          anyPruned = true; break;
        }
      }
    }

    // Emit each graph edge as a 2-point polyline â€” this IS the true medial axis
    const seen = new Set();
    for (const [, node] of nodeMap) {
      for (const nbr of node.adj) {
        const ek = [ptKey(node), ptKey(nbr)].sort().join('~');
        if (seen.has(ek)) continue;
        seen.add(ek);
        polylines.push([{ x: node.x, y: node.y }, { x: nbr.x, y: nbr.y }]);
      }
    }
  }

  return { polylines };
}

export function generateToolpath(operation, entities, context = {}) {
  const { type } = operation;
  switch (type) {
    case 'contour':   return generateContour(operation, entities);
    case 'pocket':    return generatePocket(operation, entities, context);
    case 'adaptive':  return generateAdaptive(operation, entities, context);
    case 'face':      return generateFace(operation, entities);
    case 'drill':     return generateDrill(operation, entities);
    case 'bore':      return generateBore(operation, entities);
    case 'circular':  return generateCircular(operation, entities);
    case 'engrave':   return generateEngrave(operation, entities);
    case 'trace':     return generateEngrave(operation, entities);
    case 'slot':      return generateSlot(operation, entities);
    case 'chamfer':      return generateChamfer(operation, entities);
    case 'thread':       return generateThread(operation, entities);
    case 'taperedpocket': return generateTaperedPocket(operation, entities, context);
    case 'taperedplug':   return generateTaperedPlug(operation, entities, context);
    case 'vcarve':        return generateVCarve(operation, entities, context);
    case 'vcarve2':       return generateVCarve2(operation, entities, context);
    case 'cornerlift':    return generateCornerLift(operation, entities, context);
    case 'dogbone':       return generateDogbone(operation, entities);
    case 'text':          return generateText(operation, entities);
    case 'stlraster': {
      const hm = context.stlHeightmap;
      if (!hm) return { moves: [], warnings: ['STL heightmap not available â€” re-generate from the 3D view'] };
      return generateSTLRaster(hm, operation.params);
    }
    default:             return { moves: [], warnings: ['Unknown operation: ' + type] };
  }
}

// â”€â”€ Tab engine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Returns evenly-spaced tab centre t-values [0,1) for automatic placement.
export function computeAutoTabPositions(tabCount) {
  return Array.from({ length: tabCount }, (_, i) => (i + 0.5) / tabCount);
}

// Insert hold-down tab Z-lifts into one Z-pass around a closed contour.
//
// Assumes the caller has already moved to pts[0] at cutZ (via plunge or ramp).
// Returns feed moves covering pts[1]â€¦pts[n-1]â€¦close-to-pts[0], with Z shaped
// by tabProfile: 'flat' (step plateau), 'dmd' (sinÂ² curve), 'triangle' (ramp).
//
// tabTValues : t âˆˆ [0,1) â€” arc-fraction positions of tab centres
// tabTopZ    : Z of tab top surface = floorZ + tabHeight  (must be > cutZ)
function insertTabsIntoContour(contourPts, cutZ, tabTopZ, tabWidth, tabTValues, feedRate, tabProfile) {
  tabProfile = tabProfile || 'flat';
  const pts = stripClose([...contourPts]);
  const n   = pts.length;

  // Arc-length table: cumLen[i] = arc distance from pts[0] to pts[i % n]
  const cumLen = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cumLen.push(cumLen[i] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const totalLen = cumLen[n];

  // Bail when tabs are not meaningful
  if (totalLen < 1e-6 || !tabTValues.length || tabTopZ <= cutZ + 1e-6) {
    const m = [];
    for (let i = 1; i < n; i++) m.push({ type: 'feed', x: pts[i].x, y: pts[i].y, z: cutZ, f: feedRate });
    m.push({ type: 'feed', x: pts[0].x, y: pts[0].y, z: cutZ, f: feedRate });
    return m;
  }

  // Interpolate XY at arc-length s
  function ptAtS(s) {
    if (s >= totalLen - 1e-9) return { ...pts[0] };
    for (let i = 0; i < n; i++) {
      if (s <= cumLen[i + 1] + 1e-9) {
        const d = cumLen[i + 1] - cumLen[i];
        const t = d > 1e-9 ? (s - cumLen[i]) / d : 0;
        const a = pts[i], b = pts[(i + 1) % n];
        return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      }
    }
    return { ...pts[0] };
  }

  if (tabProfile === 'flat') {
    // Convert t-values â†’ sorted entering/leaving arc-length events.
    // Tabs that straddle the seam (s = 0 / totalLen) are nudged inward.
    const tabBounds = [];
    for (const t of tabTValues) {
      const center = ((t % 1) + 1) % 1 * totalLen;
      const s0     = Math.max(1e-9,            center - tabWidth / 2);
      const s1     = Math.min(totalLen - 1e-9, center + tabWidth / 2);
      if (s1 - s0 > 1e-6) {
        tabBounds.push({ s: s0, entering: true  });
        tabBounds.push({ s: s1, entering: false });
      }
    }
    tabBounds.sort((a, b) => a.s - b.s);

    const moves = [];
    let curZ  = cutZ;
    let tbIdx = 0;

    function walkTo(s) {
      while (tbIdx < tabBounds.length && tabBounds[tbIdx].s <= s + 1e-9) {
        const ev = tabBounds[tbIdx++];
        const tp = ptAtS(ev.s);
        moves.push({ type: 'feed', x: tp.x, y: tp.y, z: curZ,   f: feedRate }); // arrive at transition XY
        curZ = ev.entering ? tabTopZ : cutZ;
        moves.push({ type: 'feed', x: tp.x, y: tp.y, z: curZ,   f: feedRate }); // lift or drop
      }
      const pt = ptAtS(s);
      moves.push({ type: 'feed', x: pt.x, y: pt.y, z: curZ, f: feedRate });
    }

    for (let i = 1; i <= n; i++) walkTo(i < n ? cumLen[i] : totalLen);
    return moves;
  }

  // Profiled tab: DMD Curve (sinÂ²) or Triangle
  const tabH = tabTopZ - cutZ;

  function profileZ(d, w) {
    const frac = Math.max(0, Math.min(1, d / w));
    if (tabProfile === 'dmd') {
      const s = Math.sin(Math.PI * frac);
      return cutZ + tabH * s * s;
    }
    // triangle
    return cutZ + tabH * (frac <= 0.5 ? 2 * frac : 2 * (1 - frac));
  }

  const tabIntervals = [];
  for (const t of tabTValues) {
    const center = ((t % 1) + 1) % 1 * totalLen;
    const s0 = Math.max(1e-9,            center - tabWidth / 2);
    const s1 = Math.min(totalLen - 1e-9, center + tabWidth / 2);
    if (s1 - s0 > 1e-6) tabIntervals.push({ s0, s1 });
  }
  tabIntervals.sort((a, b) => a.s0 - b.s0);

  const SAMPLE_STEP = 0.25; // mm between profile samples
  const moves = [];
  let cur   = 0;
  let tiIdx = 0;

  function emit(s, z) {
    const pt = ptAtS(s);
    moves.push({ type: 'feed', x: pt.x, y: pt.y, z, f: feedRate });
  }

  function advanceTo(sTarget) {
    while (tiIdx < tabIntervals.length && tabIntervals[tiIdx].s0 < sTarget - 1e-9) {
      const ti = tabIntervals[tiIdx];
      if (cur < ti.s0 - 1e-9) { emit(ti.s0, cutZ); cur = ti.s0; }
      const w = ti.s1 - ti.s0;
      const nSamples = Math.max(4, Math.ceil(w / SAMPLE_STEP));
      for (let k = 1; k <= nSamples; k++) {
        const s = ti.s0 + (k / nSamples) * w;
        emit(s, profileZ(s - ti.s0, w));
      }
      cur = ti.s1;
      tiIdx++;
    }
    if (cur < sTarget - 1e-9) { emit(sTarget, cutZ); cur = sTarget; }
  }

  for (let i = 1; i <= n; i++) advanceTo(i < n ? cumLen[i] : totalLen);
  return moves;
}

// â”€â”€ Contour â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateContour(op, entities) {
  const moves = [], warnings = [];
  const p = op.params;
  const toolR = (p.toolDiameter || 6.35) / 2;
  // cutSide: 'outside' = expand outward (negative dist), 'inside' = shrink inward (positive dist)
  const cutSide = p.cutSide || 'outside';
  const sign    = cutSide === 'inside' ? 1 : cutSide === 'center' ? 0 : -1;
  const offset  = sign * (toolR + (p.stockToLeave || 0));
  const effectiveLeadIn = p.leadInStyle ?? (p.rampEntry ? 'ramp' : 'plunge');
  const leadInArcR = p.leadInArcRadius || toolR;
  const safeZ = p.safeZ || 25;

  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { moves: [], warnings: ['No entities selected'], contours: [] };

  const tabsEnabled = !!(p.tabs && (p.tabWidth || 0) > 0 && (p.tabHeight || 0) > 0);
  const floorZ      = (p.topZ ?? 0) - (p.totalDepth || 10);
  const tabTopZ     = floorZ + (p.tabHeight || 1.5);        // height of material left at tab bottom
  const tabTValues  = tabsEnabled
    ? (p.tabMode === 'manual' ? (p.tabPositions || []) : computeAutoTabPositions(p.tabCount || 4))
    : [];

  const contours = []; // stored in toolpath result for canvas visualisation / manual snapping

  for (const entity of selected) {
    let profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;

    const closed = isEntityClosed(entity);
    // Normalize closed profiles to CCW so inside/outside offset is unambiguous
    if (closed && isClockwise(profile)) profile = [...profile].reverse();

    let contourPts = profile;

    if (offset !== 0 && closed) {
      const offsets = offsetPolyline(profile, offset, true);
      if (offsets[0]?.length >= 3) contourPts = offsets[0];
    }
    if (p.climb === false) contourPts = [...contourPts].reverse();
    // For p.climb === 'both', contourPts stays in climb (CCW) direction; direction alternates per pass.

    if (closed) contours.push(stripClose([...contourPts]));

    const passes = buildZPasses(p.topZ ?? 0, p.totalDepth || 10, p.depthPerPass || 3);
    const canArc = closed && contourPts.length > 2;
    const resolvedLeadIn = (effectiveLeadIn === 'arc' && !canArc) ? 'plunge' : effectiveLeadIn;

    for (let zi = 0; zi < passes.length; zi++) {
      const z = passes[zi];
      // For 'both': odd passes reverse direction while keeping the same start point (P0) so
      // keepDown transitions are seamless â€” the closed loop always returns to P0.
      const passProfile = (p.climb === 'both' && zi % 2 === 1 && contourPts.length > 1)
        ? [contourPts[0], ...[...contourPts].slice(1).reverse()]
        : contourPts;

      if (zi === 0 || !p.keepDown || !closed) {
        moves.push(...buildLeadIn(passProfile, p.topZ ?? 0, z, safeZ, resolvedLeadIn, p.rampAngle || 3, leadInArcR, p.feedRate || 1500, p.plungeRate || 500, cutSide));
      } else {
        // Keep down: tool is at passProfile[0] (always contourPts[0]) â€” just plunge deeper
        moves.push({ type: 'feed', x: passProfile[0].x, y: passProfile[0].y, z, f: p.plungeRate || 500 });
      }

      const useTabsThisPass = tabsEnabled && closed && tabTValues.length > 0 && z < tabTopZ - 1e-6;

      if (useTabsThisPass) {
        moves.push(...insertTabsIntoContour(passProfile, z, tabTopZ, p.tabWidth || 6, tabTValues, p.feedRate || 1500, p.tabProfile || 'flat'));
      } else {
        for (let i = 1; i < passProfile.length; i++) {
          moves.push({ type: 'feed', x: passProfile[i].x, y: passProfile[i].y, z, f: p.feedRate || 1500 });
        }
        if (closed) {
          moves.push({ type: 'feed', x: passProfile[0].x, y: passProfile[0].y, z, f: p.feedRate || 1500 });
        }
      }
    }
    moves.push({ type: 'rapid', x: contourPts[0].x, y: contourPts[0].y, z: p.safeZ || 25 });
  }
  return { moves, warnings, contours, tabTValues };
}

// Reorder passes so each next pass starts closest to where the previous one ended.
// This minimises rapid travel without reversing individual passes (which would
// flip climb/conventional direction).
function sortPassesByProximity(passes) {
  if (passes.length <= 1) return passes;
  const used = new Uint8Array(passes.length);
  const result = [];
  let cx = passes[0][0].x, cy = passes[0][0].y;
  for (let n = 0; n < passes.length; n++) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < passes.length; i++) {
      if (used[i]) continue;
      const d = Math.hypot(passes[i][0].x - cx, passes[i][0].y - cy);
      if (d < bestD) { bestD = d; best = i; }
    }
    used[best] = 1;
    result.push(passes[best]);
    const last = passes[best][passes[best].length - 1];
    cx = last.x; cy = last.y;
  }
  return result;
}

// â”€â”€ Pocket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generatePocket(op, entities, context = {}) {
  const moves = [], warnings = [];
  const p = op.params;
  const toolDia = p.toolDiameter || 6.35;
  const toolR = toolDia / 2;
  const stepover = p.stepover || 0.45;
  const safeZ = p.safeZ || 25;
  const topZ = p.topZ ?? 0;
  const feedRate = p.feedRate || 1500;
  const plungeRate = p.plungeRate || 500;
  const leadInStyle = p.leadInStyle || 'plunge';
  const leadInArcR  = p.leadInArcRadius != null ? p.leadInArcRadius : (leadInStyle === 'helical' ? toolR * 0.5 : toolR);

  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { moves: [], warnings: ['No entities selected'] };

  // Build profiles: chain individual LINE/ARC segments into one closed polygon
  // when the selection consists of disconnected segments rather than a polyline.
  const profiles = buildPocketProfiles(selected);

  if (!profiles.length) return { moves: [], warnings: ['No valid closed entities selected'] };

  // Largest polygon = outer boundary; anything smaller inside it = island
  profiles.sort((a, b) => polygonArea(b) - polygonArea(a));
  // Normalise to CCW so a positive inset offset always shrinks inward
  const outerProfile = isClockwise(profiles[0]) ? [...profiles[0]].reverse() : profiles[0];
  const islandProfiles = profiles.slice(1);

  if (islandProfiles.length > 0) {
    warnings.push(`${islandProfiles.length} island(s) detected`);
  }

  if (polygonArea(outerProfile) < toolR * toolR * Math.PI) {
    warnings.push(`Pocket too small for tool diameter ${toolDia}mm`);
    return { moves, warnings };
  }

  // Expand each island outward by toolR to get the exclusion zone the tool
  // centre must stay outside of.  For a CCW polygon positive offset = inward,
  // so expand outward with -toolR (after normalising to CCW).
  const islandExclusions = islandProfiles.map((island) => {
    const ccw = isClockwise(island) ? [...island].reverse() : island;
    const expanded = offsetPolyline(ccw, -toolR, true)[0];
    return (expanded && expanded.length >= 3) ? expanded : ccw;
  });
  const hasIslands = islandExclusions.length > 0;
  if (hasIslands && p.cutSide !== 'outside') {
    const chkOffset = toolR + (p.finishPass ? (p.finishAllowance || 0.2) : 0);
    const chkBound = offsetPolyline(outerProfile, chkOffset, true)[0] ?? null;
    warnNarrowGaps(islandExclusions, chkBound, toolR, warnings);
  }

  const zPasses = buildZPasses(topZ, p.totalDepth || 10, p.depthPerPass || 3);

  for (const z of zPasses) {
    let clearPasses;

    if (p.cutSide === 'outside') {
      // Outside (boss) mode: expand outward from the profile, clipped to boundary
      clearPasses = [];
      const step = toolR * 2 * stepover;
      const clipBound = getStockBoundary(context, op, context.allEntities);

      for (let i = 0, dist = toolR; i < 200; i++, dist += step) {
        const rawRings = offsetPolyline(outerProfile, -dist, true); // negative = expand outward
        let any = false;
        for (const rawRing of rawRings) {
          if (!rawRing || rawRing.length < 3 || polygonArea(rawRing) < step * step * 0.5) continue;
          const ringPts = stripClose([...rawRing]);
          const clippedRings = clipBound ? clipPolygonToRegion(ringPts, clipBound) : [ringPts];
          for (const clipped of clippedRings) {
            if (!clipped || clipped.length < 3) continue;
            clearPasses.push([...clipped, clipped[0]]);
            any = true;
          }
        }
        if (!any) break;
      }
      if (!clearPasses.length) warnings.push('No outside clearing passes generated');
    } else {
      const boundaryOffset = toolR + (p.finishPass ? (p.finishAllowance || 0.2) : 0);
      const boundary = offsetPolyline(outerProfile, boundaryOffset, true)[0];
      if (!boundary || boundary.length < 4 || polygonArea(boundary) < toolR * toolR) {
        warnings.push('Shape too small for pocket after tool offset');
        continue;
      }
      clearPasses = p.restMachining && (p.previousToolDiameter || 0) > 0
        ? generateRestMachiningPasses(outerProfile, toolR, p.previousToolDiameter / 2, stepover, islandExclusions)
        : generatePocketOffsets(boundary, toolR, stepover, islandExclusions);
      if (clearPasses.length === 0 && islandExclusions.length === 0) {
        warnings.push('No clearing passes generated - pocket may be too small');
      }
    }

    const sortedPasses = p.startFromCenter ? [...clearPasses].reverse() : clearPasses;
    const directedPasses = p.climb === false ? sortedPasses.map(pass => [...pass].reverse()) : sortedPasses;
    const orderedPasses = sortPassesByProximity(directedPasses);

    if (orderedPasses.length > 0) {
      const pocketCutSide = p.cutSide === 'outside' ? 'outside' : 'inside';
      moves.push(...buildLeadIn(orderedPasses[0], topZ, z, safeZ, leadInStyle, p.rampAngle || 3, leadInArcR, feedRate, plungeRate, pocketCutSide));

      let lastPassX = null, lastPassY = null;
      for (let pi = 0; pi < orderedPasses.length; pi++) {
        // For 'both': alternate climb/conventional on each successive ring pass
        const pass = (p.climb === 'both' && pi % 2 === 1) ? [...orderedPasses[pi]].reverse() : orderedPasses[pi];
        if (!pass || pass.length < 2) continue;
        if (pi === 0) {
          // buildLeadIn left us near pass start inside the already-cut area â€” short hop is safe
          moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: z + 0.5 });
        } else if (hasIslands && !p.keepDown) {
          // Two-step retract: lift Z straight up at current XY first, then traverse at
          // safeZ. A single diagonal rapid (simultaneous XYZ) would have the tool below
          // topZ while crossing island walls, risking a gouge.
          if (lastPassX !== null) moves.push({ type: 'rapid', x: lastPassX, y: lastPassY, z: safeZ });
          moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: safeZ });
        } else {
          // No islands: concentric rings share the floor, z+0.5 is always safe.
          moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: z + 0.5 });
        }
        moves.push({ type: 'feed', x: pass[0].x, y: pass[0].y, z, f: plungeRate });
        for (let i = 1; i < pass.length; i++) {
          moves.push({ type: 'feed', x: pass[i].x, y: pass[i].y, z, f: feedRate });
        }
        lastPassX = pass[pass.length - 1].x;
        lastPassY = pass[pass.length - 1].y;
      }
    }

    // Finish pass: trace the pocket wall (inside mode) or boss perimeter (outside mode)
    if (p.finishPass) {
      const finSign = p.cutSide === 'outside' ? -1 : 1;
      const finBoundary = offsetPolyline(outerProfile, finSign * toolR, true)[0];
      if (finBoundary && finBoundary.length >= 3) {
        moves.push({ type: 'rapid', x: finBoundary[0].x, y: finBoundary[0].y, z: safeZ });
        moves.push({ type: 'feed', x: finBoundary[0].x, y: finBoundary[0].y, z, f: plungeRate });
        for (let i = 1; i < finBoundary.length; i++) {
          moves.push({ type: 'feed', x: finBoundary[i].x, y: finBoundary[i].y, z, f: feedRate * 0.7 });
        }
        moves.push({ type: 'feed', x: finBoundary[0].x, y: finBoundary[0].y, z, f: feedRate * 0.7 });
      }
    }
  }

  moves.push({ type: 'rapid', x: outerProfile[0].x, y: outerProfile[0].y, z: safeZ });
  return { moves, warnings };
}

// â”€â”€ Adaptive â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateAdaptive(op, entities, context = {}) {
  const moves = [], warnings = [];
  const p = op.params;
  const toolR = (p.toolDiameter || 6.35) / 2;
  const stepover = p.stepover || 0.35;
  const safeZ = p.safeZ || 25;
  const leadInStyle = p.leadInStyle || 'ramp';
  const leadInArcR  = p.leadInArcRadius != null ? p.leadInArcRadius : (leadInStyle === 'helical' ? toolR * 0.5 : toolR);
  const trochR = toolR * (p.optimalLoad || 0.3);

  warnings.push('Adaptive: trochoidal approximation');

  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { moves: [], warnings: ['No entities selected'] };

  // Build profiles and separate outer boundary from islands (same approach as pocket)
  const profiles = buildPocketProfiles(selected);
  if (!profiles.length) return { moves: [], warnings: ['No valid closed entities selected'] };
  profiles.sort((a, b) => polygonArea(b) - polygonArea(a));

  const profile = isClockwise(profiles[0]) ? [...profiles[0]].reverse() : profiles[0];
  const islandProfiles = profiles.slice(1);
  if (islandProfiles.length > 0) warnings.push(`${islandProfiles.length} island(s) detected`);

  // Expand islands by (toolR + trochR): toolR keeps the tool edge at the island wall,
  // the extra trochR ensures the trochoidal arcs never breach the island boundary.
  const islandExclusions = islandProfiles.map(island => {
    const ccw = isClockwise(island) ? [...island].reverse() : island;
    const expanded = offsetPolyline(ccw, -(toolR + trochR), true)[0];
    return expanded && expanded.length >= 3 ? expanded : ccw;
  });

  // Pre-shrink the outer boundary by toolR so the tool center stays inside the profile.
  // Without this, trochoidal arcs (radius trochR) reach outside the raw profile boundary.
  const innerBoundary = offsetPolyline(profile, toolR, true)[0];
  if (islandExclusions.length > 0) warnNarrowGaps(islandExclusions, innerBoundary ?? null, toolR, warnings);

  const passes = buildZPasses(p.topZ ?? 0, p.totalDepth || 15, p.depthPerPass || 5);

  for (const z of passes) {
    let clearPasses;
    if (p.cutSide === 'outside') {
      // Expand outward from profile, clipped to boundary
      clearPasses = [];
      const step = toolR * 2 * stepover * 0.8;
      const clipBound = getStockBoundary(context, op, context.allEntities);
      for (let i = 0, dist = toolR; i < 200; i++, dist += step) {
        const rawRings = offsetPolyline(profile, -dist, true);
        let any = false;
        for (const rawRing of rawRings) {
          if (!rawRing || rawRing.length < 3 || polygonArea(rawRing) < step * step * 0.5) continue;
          const ringPts = stripClose([...rawRing]);
          const clippedRings = clipBound ? clipPolygonToRegion(ringPts, clipBound) : [ringPts];
          for (const clipped of clippedRings) {
            if (!clipped || clipped.length < 3) continue;
            clearPasses.push([...clipped, clipped[0]]);
            any = true;
          }
        }
        if (!any) break;
      }
    } else {
      if (!innerBoundary || innerBoundary.length < 3 || polygonArea(innerBoundary) < toolR * toolR) continue;
      clearPasses = p.restMachining && (p.previousToolDiameter || 0) > 0
        ? generateRestMachiningPasses(innerBoundary, toolR, p.previousToolDiameter / 2, stepover * 0.8, islandExclusions)
        : generatePocketOffsets(innerBoundary, toolR, stepover * 0.8, islandExclusions);
    }
    if (!clearPasses.length) continue;

    const adaptRampProfile = clearPasses[clearPasses.length - 1] || profile;
    const adaptCutSide = p.cutSide === 'outside' ? 'outside' : 'inside';
    moves.push(...buildLeadIn(adaptRampProfile, p.topZ ?? 0, z, safeZ, leadInStyle, p.rampAngle || 2, leadInArcR, p.feedRate || 2000, p.plungeRate || 500, adaptCutSide));

    const arcDir = p.climb === false ? -1 : 1;
    const passOrder = p.climb === false ? clearPasses : [...clearPasses].reverse();
    for (let pi = 0; pi < passOrder.length; pi++) {
      const pass = passOrder[pi];
      if (!pass || pass.length < 2) continue;
      // Retract and reposition between passes so the tool never traverses island
      // material or uncut stock at cutting depth when moving to the next ring.
      if (pi > 0) {
        moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: safeZ });
        moves.push({ type: 'feed',  x: pass[0].x, y: pass[0].y, z, f: p.plungeRate || 500 });
      }
      for (let i = 0; i < pass.length - 1; i++) {
        const pt = pass[i];
        const next = pass[i + 1];
        const angle = Math.atan2(next.y - pt.y, next.x - pt.x);
        for (let t = 0; t <= 1; t += 0.2) {
          const arcA = angle + arcDir * (Math.PI / 2 + t * Math.PI * 2);
          moves.push({ type: 'feed', x: pt.x + t * (next.x - pt.x) + Math.cos(arcA) * trochR, y: pt.y + t * (next.y - pt.y) + Math.sin(arcA) * trochR, z, f: p.feedRate || 2000 });
        }
      }
    }
  }
  moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
  return { moves, warnings };
}

// â”€â”€ Face â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateFace(op, entities) {
  const moves = [];
  const p = op.params;
  const toolR = (p.toolDiameter || 25.4) / 2;
  const safeZ = p.safeZ || 25;
  const leadInStyle = p.leadInStyle || 'plunge';
  const leadInArcR  = p.leadInArcRadius || toolR;
  const selected = getSelectedEntities(entities, op.selectedIds);
  const bounds = selected.length ? getEntityBounds(selected) : { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const expanded = { minX: bounds.minX - (p.stockLeft || 2), minY: bounds.minY - (p.stockFront || 2), maxX: bounds.maxX + (p.stockRight || 2), maxY: bounds.maxY + (p.stockBack || 2) };
  const passes = buildZPasses(p.topZ ?? 0, p.totalDepth || 3, p.depthPerPass || 1);

  for (const z of passes) {
    const rasterPasses = generateRasterPasses(expanded, p.angle || 0, p.stepover || 0.75, toolR);
    if (!rasterPasses.length) continue;
    moves.push(...buildLeadIn(rasterPasses[0], p.topZ ?? 0, z, safeZ, leadInStyle, p.rampAngle || 3, leadInArcR, p.feedRate || 3000, p.plungeRate || 800, 'outside'));
    for (const pass of rasterPasses) {
      moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: z + 0.2 });
      moves.push({ type: 'feed', x: pass[0].x, y: pass[0].y, z, f: (p.feedRate || 3000) * 0.5 });
      moves.push({ type: 'feed', x: pass[1].x, y: pass[1].y, z, f: p.feedRate || 3000 });
    }
  }
  moves.push({ type: 'rapid', x: 0, y: 0, z: p.safeZ || 25 });
  return { moves, warnings: [] };
}

// â”€â”€ Drill â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateDrill(op, entities) {
  const moves = [];
  const p = op.params;
  const safeZ = p.safeZ || 25;
  const topZ = p.topZ ?? 0;
  const targetZ = topZ - Math.abs(p.totalDepth || 20);
  const retractZ = topZ + Math.abs(p.retractHeight || 2);

  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { moves: [], warnings: ['No entities selected'] };

  for (const entity of selected) {
    let cx, cy;
    if (entity.type === 'circle' || entity.type === 'arc') {
      cx = entity.center.x; cy = entity.center.y;
    } else {
      const pts = entityToProfile(entity);
      if (!pts) continue;
      cx = pts.reduce((s, pt) => s + pt.x, 0) / pts.length;
      cy = pts.reduce((s, pt) => s + pt.y, 0) / pts.length;
    }

    moves.push({ type: 'rapid', x: cx, y: cy, z: safeZ });
    moves.push({ type: 'rapid', x: cx, y: cy, z: retractZ });

    if (p.peckDepth > 0) {
      let curZ = topZ;
      while (curZ > targetZ) {
        const nextZ = Math.max(targetZ, curZ - p.peckDepth);
        moves.push({ type: 'feed', x: cx, y: cy, z: nextZ, f: p.feedRate || 300 });
        if (p.chipBreak) {
          moves.push({ type: 'feed', x: cx, y: cy, z: nextZ + 0.5, f: (p.feedRate || 300) * 3 });
        } else {
          moves.push({ type: 'rapid', x: cx, y: cy, z: retractZ });
        }
        curZ = nextZ;
        if (curZ <= targetZ) break;
      }
    } else {
      moves.push({ type: 'feed', x: cx, y: cy, z: targetZ, f: p.feedRate || 300 });
    }

    if (p.dwellTime > 0) moves.push({ type: 'dwell', p: p.dwellTime * 1000 });
    moves.push({ type: 'rapid', x: cx, y: cy, z: safeZ });
  }
  return { moves, warnings: [] };
}

// â”€â”€ Bore â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateBore(op, entities) {
  const moves = [];
  const p = op.params;
  const toolR = (p.toolDiameter || 6.35) / 2;
  const selected = getSelectedEntities(entities, op.selectedIds);

  for (const entity of selected) {
    if (entity.type !== 'circle') continue;
    const { center, radius } = entity;
    const helixR = radius - toolR;
    if (helixR <= 0) continue;
    const targetZ = (p.topZ ?? 0) - Math.abs(p.totalDepth || 20);
    const turns = Math.abs(p.totalDepth || 20) / (p.helicalPitch || 1.5);
    const steps = Math.ceil(turns * 36);
    const dir = p.direction === 'conventional' ? 1 : -1;

    moves.push({ type: 'rapid', x: center.x + helixR, y: center.y, z: p.safeZ || 25 });
    moves.push({ type: 'rapid', x: center.x + helixR, y: center.y, z: p.topZ ?? 0 });

    for (let i = 1; i <= steps; i++) {
      const angle = (i / steps) * turns * Math.PI * 2 * dir;
      const z = (p.topZ ?? 0) - (i / steps) * Math.abs(p.totalDepth || 20);
      moves.push({ type: 'feed', x: center.x + Math.cos(angle) * helixR, y: center.y + Math.sin(angle) * helixR, z, f: p.feedRate || 600 });
    }
    for (let i = 0; i <= 36; i++) {
      const angle = (i / 36) * Math.PI * 2 * dir;
      moves.push({ type: 'feed', x: center.x + Math.cos(angle) * helixR, y: center.y + Math.sin(angle) * helixR, z: targetZ, f: (p.feedRate || 600) * 0.7 });
    }
    moves.push({ type: 'rapid', x: center.x, y: center.y, z: targetZ });
    moves.push({ type: 'rapid', x: center.x, y: center.y, z: p.safeZ || 25 });
  }
  return { moves, warnings: [] };
}

// â”€â”€ Circular Pocket â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateCircular(op, entities) {
  const moves = [];
  const p = op.params;
  const toolR = (p.toolDiameter || 6.35) / 2;
  const stepover = p.stepover || 0.4;
  const selected = getSelectedEntities(entities, op.selectedIds);

  for (const entity of selected) {
    if (entity.type !== 'circle') continue;
    const { center, radius } = entity;
    const passes = buildZPasses(p.topZ ?? 0, p.totalDepth || 10, p.depthPerPass || 3);

    for (const z of passes) {
      const step = toolR * 2 * stepover;
      const restR = p.restMachining && (p.previousToolDiameter || 0) > 0
        ? Math.max(toolR, radius - p.previousToolDiameter / 2) : toolR;
      // leadInStyle controls entry: 'plunge' = straight down, anything else = helical.
      // Falls back to legacy helicalEntry boolean when leadInStyle is not set.
      const circLeadIn = p.leadInStyle ?? (p.helicalEntry !== false ? 'ramp' : 'plunge');
      if (restR > toolR) {
        moves.push({ type: 'rapid', x: center.x + restR, y: center.y, z: p.safeZ || 25 });
        moves.push({ type: 'feed',  x: center.x + restR, y: center.y, z, f: p.plungeRate || 400 });
      } else if (circLeadIn === 'plunge') {
        moves.push({ type: 'rapid', x: center.x, y: center.y, z: p.safeZ || 25 });
        moves.push({ type: 'feed',  x: center.x, y: center.y, z, f: p.plungeRate || 400 });
      } else {
        moves.push({ type: 'rapid', x: center.x, y: center.y, z: p.safeZ || 25 });
        moves.push(...buildHelicalEntry(center, toolR * 0.5, p.topZ ?? 0, z, p.plungeRate || 400));
      }

      const circDir = p.climb === false ? -1 : 1;
      let r = restR;
      while (r <= radius - toolR) {
        const segs = Math.max(24, Math.ceil(r * 2 * Math.PI / (toolR * 0.5)));
        for (let i = 0; i <= segs; i++) {
          const a = circDir * (i / segs) * Math.PI * 2;
          moves.push({ type: 'feed', x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r, z, f: p.feedRate || 1200 });
        }
        r += step;
      }

      // Final finish circle
      const finR = radius - toolR;
      if (finR > 0) {
        for (let i = 0; i <= 72; i++) {
          const a = circDir * (i / 72) * Math.PI * 2;
          moves.push({ type: 'feed', x: center.x + Math.cos(a) * finR, y: center.y + Math.sin(a) * finR, z, f: (p.feedRate || 1200) * 0.7 });
        }
      }
    }
    moves.push({ type: 'rapid', x: center.x, y: center.y, z: p.safeZ || 25 });
  }
  return { moves, warnings: [] };
}

// â”€â”€ Engrave / Trace â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateEngrave(op, entities) {
  const moves = [];
  const p = op.params;
  const z = (p.topZ ?? 0) - Math.abs(p.depth || 1.5);
  const safeZ = p.safeZ || 25;
  const selected = getSelectedEntities(entities, op.selectedIds);

  for (let ei = 0; ei < selected.length; ei++) {
    const entity = selected[ei];
    let profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;
    if (p.climb === false || (p.climb === 'both' && ei % 2 === 1)) profile = [...profile].reverse();
    moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
    moves.push({ type: 'feed', x: profile[0].x, y: profile[0].y, z, f: p.plungeRate || 300 });
    for (let i = 1; i < profile.length; i++) {
      moves.push({ type: 'feed', x: profile[i].x, y: profile[i].y, z, f: p.feedRate || 800 });
    }
    if (isEntityClosed(entity)) {
      moves.push({ type: 'feed', x: profile[0].x, y: profile[0].y, z, f: p.feedRate || 800 });
    }
    moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
  }
  return { moves, warnings: [] };
}

// â”€â”€ Slot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateSlot(op, entities) {
  const moves = [];
  const p = op.params;
  const safeZ = p.safeZ || 25;
  const selected = getSelectedEntities(entities, op.selectedIds);

  for (const entity of selected) {
    let profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;
    const baseProfile = p.climb === false ? [...profile].reverse() : profile;
    const passes = buildZPasses(p.topZ ?? 0, p.totalDepth || 10, p.depthPerPass || 3);

    for (let zi = 0; zi < passes.length; zi++) {
      const z = passes[zi];
      // For 'both': alternate direction each depth pass
      const passProfile = (p.climb === 'both' && zi % 2 === 1) ? [...baseProfile].reverse() : baseProfile;
      moves.push({ type: 'rapid', x: passProfile[0].x, y: passProfile[0].y, z: safeZ });
      if (p.rampEntry) {
        moves.push(...buildRampEntry(passProfile, p.topZ ?? 0, z, p.rampAngle || 3, p.feedRate || 1000, p.plungeRate || 300));
      } else {
        moves.push({ type: 'feed', x: passProfile[0].x, y: passProfile[0].y, z, f: p.plungeRate || 300 });
      }
      for (let i = 1; i < passProfile.length; i++) {
        moves.push({ type: 'feed', x: passProfile[i].x, y: passProfile[i].y, z, f: p.feedRate || 1000 });
      }
      if (isEntityClosed(entity)) {
        moves.push({ type: 'feed', x: passProfile[0].x, y: passProfile[0].y, z, f: p.feedRate || 1000 });
      }
    }
    moves.push({ type: 'rapid', x: baseProfile[0].x, y: baseProfile[0].y, z: safeZ });
  }
  return { moves, warnings: [] };
}

// â”€â”€ Chamfer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateChamfer(op, entities) {
  const moves = [];
  const p = op.params;
  const chamferDepth = (p.chamferWidth || 1) * Math.tan(((p.chamferAngle || 45) * Math.PI) / 180);
  const tipZ = (p.topZ ?? 0) - chamferDepth;
  const selected = getSelectedEntities(entities, op.selectedIds);

  for (const entity of selected) {
    let profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;
    const closed = isEntityClosed(entity);
    if (closed && isClockwise(profile)) profile = [...profile].reverse();
    const cutSide = p.cutSide || 'outside';
    const sign = cutSide === 'inside' ? 1 : -1;
    const tipOffset = sign * ((p.chamferWidth || 1) + (p.stockToLeave || 0));
    const offsets = offsetPolyline(profile, tipOffset, closed);
    let contourPts = offsets[0] || profile;
    if (p.climb === false) contourPts = [...contourPts].reverse();

    moves.push({ type: 'rapid', x: contourPts[0].x, y: contourPts[0].y, z: p.safeZ || 25 });
    moves.push({ type: 'feed', x: contourPts[0].x, y: contourPts[0].y, z: tipZ, f: p.plungeRate || 300 });
    for (let i = 1; i < contourPts.length; i++) {
      moves.push({ type: 'feed', x: contourPts[i].x, y: contourPts[i].y, z: tipZ, f: p.feedRate || 800 });
    }
    if (closed) {
      moves.push({ type: 'feed', x: contourPts[0].x, y: contourPts[0].y, z: tipZ, f: p.feedRate || 800 });
    }
    moves.push({ type: 'rapid', x: contourPts[0].x, y: contourPts[0].y, z: p.safeZ || 25 });
  }
  return { moves, warnings: [] };
}

// â”€â”€ Thread â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateThread(op, entities) {
  const moves = [];
  const p = op.params;
  const toolR = (p.toolDiameter || 6.35) / 2;
  const selected = getSelectedEntities(entities, op.selectedIds);

  for (const entity of selected) {
    if (entity.type !== 'circle') continue;
    const { center, radius } = entity;
    const threadR = radius - toolR;
    if (threadR <= 0) continue;
    const targetZ = (p.topZ ?? 0) - Math.abs(p.totalDepth || 15);
    const turns = Math.abs(p.totalDepth || 15) / (p.pitch || 1.25);
    const steps = Math.ceil(turns * 36);
    const dir = p.direction === 'left' ? 1 : -1;

    moves.push({ type: 'rapid', x: center.x + threadR, y: center.y, z: p.safeZ || 25 });
    moves.push({ type: 'rapid', x: center.x + threadR, y: center.y, z: p.topZ ?? 0 });

    for (let i = 1; i <= steps; i++) {
      const angle = (i / steps) * turns * Math.PI * 2 * dir;
      const z = (p.topZ ?? 0) - (i / steps) * Math.abs(p.totalDepth || 15);
      moves.push({ type: 'feed', x: center.x + Math.cos(angle) * threadR, y: center.y + Math.sin(angle) * threadR, z, f: p.feedRate || 400 });
    }
    for (let i = 0; i <= 36; i++) {
      const angle = (i / 36) * Math.PI * 2 * dir;
      moves.push({ type: 'feed', x: center.x + Math.cos(angle) * threadR, y: center.y + Math.sin(angle) * threadR, z: targetZ, f: (p.feedRate || 400) * 0.6 });
    }
    moves.push({ type: 'rapid', x: center.x, y: center.y, z: targetZ });
    moves.push({ type: 'rapid', x: center.x, y: center.y, z: p.safeZ || 25 });
  }
  return { moves, warnings: [] };
}

// â”€â”€ Tapered Pocket / Tapered Plug â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Each operation has four independently-enabled passes:
//   Taper Contour  â€” V-bit traces the exact profile at full depth (defines walls)
//   Taper Cleanup  â€” V-bit concentric clearing of floor area near walls
//   Detail Endmill â€” small endmill clears medium-detail areas
//   Bulk Endmill   â€” large endmill removes remaining bulk
//
// cutSide 'inside'  (pocket default): clears inside the profile boundary.
// cutSide 'outside' (plug default):   clears outside the profile boundary.
//   For outside cuts the taper-contour tip is offset outward by depthÃ—tan(halfAngle)
//   so the taper wall intersects the profile edge exactly at the top surface.
//
// Plug raises the effective topZ by fitTolerance/tan(halfAngle) so the plug
// engages the pocket walls fractionally higher, leaving a controlled fit gap.
//
// Wall-clearance formula used by all concentric-clearing passes:
//   wallLeave = depth Ã— tan(halfAngle) + wallStock
// Inside: outer boundary inset by (toolR + wallLeave); islands outset by same.
// Outside: profile outset by (toolR + wallLeave) becomes the exclusion island;
//          stock bounding box is the outer clearing boundary.

// Mirror entities across the X axis (reflect Y around the centroid Y of all profiles).
// Used to generate a plug toolpath that is a mirror image of the pocket so the plug
// fits when physically flipped over and glued in.
// Chains LINE/ARC segments first (same as buildPocketProfiles) so the centroid is
// computed from the closed profile, not individual segment midpoints.
export function mirrorEntitiesX(entities) {
  const profiles = buildPocketProfiles(entities);
  if (!profiles.length) return entities;

  // Strip closing points before centroid computation â€” polylineToPoints adds
  // a duplicate closing vertex for closed polylines, biasing the vertex average
  // toward the first vertex and shifting the mirrored geometry off-center.
  const cleanProfiles = profiles.map(p => stripClose([...p]));
  const allPts = cleanProfiles.flat();
  if (!allPts.length) return entities;

  // Use bounding box center as the mirror axis, NOT the vertex average.
  // Arc tessellation (circleToPoints / polylineToPoints bulge expansion) creates
  // many densely-packed points along curves and only 2 points per straight segment.
  // The vertex average drifts toward arc-heavy regions; the bounding box center
  // is stable and matches what the user sees as the shape's position on canvas.
  // Mirroring around bbox-center-Y also preserves minY/maxY exactly, so the
  // plug profile's Y extents are identical to the pocket's.
  const minX = Math.min(...allPts.map(p => p.x));
  const maxX = Math.max(...allPts.map(p => p.x));
  const minY = Math.min(...allPts.map(p => p.y));
  const maxY = Math.max(...allPts.map(p => p.y));
  const origCx = (minX + maxX) / 2;
  const origCy = (minY + maxY) / 2;
  console.log('[mirrorEntitiesX] bbox:', minX.toFixed(4), minY.toFixed(4), 'to', maxX.toFixed(4), maxY.toFixed(4),
    '| bbox center (mirror axis):', origCx.toFixed(4), origCy.toFixed(4));

  const mirrored = cleanProfiles.map(pts =>
    pts.map(pt => ({ x: pt.x, y: 2 * origCy - pt.y }))
  );

  // Verify: bbox center of mirrored profiles should equal origCy exactly.
  const mirPts = mirrored.flat();
  const mirMinY = Math.min(...mirPts.map(p => p.y));
  const mirMaxY = Math.max(...mirPts.map(p => p.y));
  const mirCy   = (mirMinY + mirMaxY) / 2;
  const dy = origCy - mirCy;  // should be ~0
  const mirMinX = Math.min(...mirPts.map(p => p.x));
  const mirMaxX = Math.max(...mirPts.map(p => p.x));
  const mirCx   = (mirMinX + mirMaxX) / 2;
  const dx = origCx - mirCx;  // should be ~0
  console.log('[mirrorEntitiesX] post-mirror bbox center:', mirCx.toFixed(4), mirCy.toFixed(4),
    '| correction dx:', dx.toFixed(6), 'dy:', dy.toFixed(6));

  return mirrored.map((pts, i) => ({
    id: `__mirror_${i}`,
    type: 'polyline',
    vertices: pts.map(pt => ({ x: pt.x + dx, y: pt.y + dy })),
    closed: true,
  }));
}

// Mirror entities across the Y axis (reflect X around the centroid X of all profiles).
// Same logic as mirrorEntitiesX but flips left-right instead of top-bottom.
export function mirrorEntitiesY(entities) {
  const profiles = buildPocketProfiles(entities);
  if (!profiles.length) return entities;
  const cleanProfiles = profiles.map(p => stripClose([...p]));
  const allPts = cleanProfiles.flat();
  if (!allPts.length) return entities;
  const minX = Math.min(...allPts.map(p => p.x));
  const maxX = Math.max(...allPts.map(p => p.x));
  const minY = Math.min(...allPts.map(p => p.y));
  const maxY = Math.max(...allPts.map(p => p.y));
  const origCx = (minX + maxX) / 2;
  const origCy = (minY + maxY) / 2;
  const mirrored = cleanProfiles.map(pts =>
    pts.map(pt => ({ x: 2 * origCx - pt.x, y: pt.y }))
  );
  const mirPts = mirrored.flat();
  const mirMinX = Math.min(...mirPts.map(p => p.x));
  const mirMaxX = Math.max(...mirPts.map(p => p.x));
  const mirMinY = Math.min(...mirPts.map(p => p.y));
  const mirMaxY = Math.max(...mirPts.map(p => p.y));
  const dx = origCx - (mirMinX + mirMaxX) / 2;
  const dy = origCy - (mirMinY + mirMaxY) / 2;
  return mirrored.map((pts, i) => ({
    id: `__mirror_${i}`,
    type: 'polyline',
    vertices: pts.map(pt => ({ x: pt.x + dx, y: pt.y + dy })),
    closed: true,
  }));
}

// Apply mirror transform from op params. Supports new `mirror` string ('x'|'y'|'none')
// and old boolean `mirrorX` for backwards compatibility with saved project files.
function applyMirror(selected, p) {
  const mirror = p.mirror ?? (p.mirrorX ? 'x' : 'none');
  if (mirror === 'x') return mirrorEntitiesX(selected);
  if (mirror === 'y') return mirrorEntitiesY(selected);
  return selected;
}

// â”€â”€ V-Carve â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Returns the shortest distance from point pt to any edge of outer or any hole.
// Used to compute true V-bit contact depth at each skeleton centroid.
function distToNearestWall(pt, outer, holes) {
  let min = Infinity;
  const checkEdges = poly => {
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) { min = Math.min(min, Math.hypot(pt.x - a.x, pt.y - a.y)); continue; }
      const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
      min = Math.min(min, Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy)));
    }
  };
  checkEdges(outer);
  holes.forEach(checkEdges);
  return min;
}

function generateVCarve(op, entities, context = {}) {
  const moves = [], warnings = [];
  const p = op.params;
  const safeZ        = p.safeZ ?? 25;
  const topZ         = p.topZ ?? 0;
  const maxDepth     = Math.abs(p.maxDepth ?? 15);
  const halfAngle    = Math.max(1, Math.min(89, p.halfAngle ?? 15));
  const tanHalfAngle = Math.tan(halfAngle * Math.PI / 180);
  const tipR         = (p.tipDiameter ?? 0) / 2;
  const plungeRate   = p.plungeRate ?? 500;
  const feedRate     = p.feedRate ?? 1500;

  if (!op.selectedIds?.length) return { moves, warnings: ['Select entities'] };
  const selected = getSelectedEntities(entities, op.selectedIds);
  const profiles = buildPocketProfiles(selected);

  // Contact-First Z: depth where V-bit sides touch nearest wall
  const zOf = r => topZ - Math.min(maxDepth, Math.max(p.flatDepth || 0, (r - tipR) / tanHalfAngle));

  // Closest point on segment [A,B] to point P
  const closestOnSeg = (P, A, B) => {
    const dx = B.x - A.x, dy = B.y - A.y;
    const len2 = dx*dx + dy*dy;
    if (len2 < 1e-20) return { x: A.x, y: A.y };
    const t = Math.max(0, Math.min(1, ((P.x-A.x)*dx + (P.y-A.y)*dy) / len2));
    return { x: A.x + t*dx, y: A.y + t*dy };
  };

  // Nudge a spine node to the exact midpoint between its two nearest boundary walls.
  // Wall-1: absolute closest boundary point.
  // Wall-2: closest boundary point whose direction from node is opposite to wall-1
  //         (dot product < 0), ensuring we find the far wall, not a second nearby point
  //         on the same wall.
  // Returns { x, y, radius } with corrected position and updated wall-distance.
  const nudgeToCenter = (node, boundary) => {
    const nb = boundary.length;
    let d1 = Infinity, p1 = null;
    for (let i = 0; i < nb; i++) {
      const cp = closestOnSeg(node, boundary[i], boundary[(i+1)%nb]);
      const d  = Math.hypot(cp.x - node.x, cp.y - node.y);
      if (d < d1) { d1 = d; p1 = cp; }
    }
    if (!p1) return node;
    const dx1 = p1.x - node.x, dy1 = p1.y - node.y;
    let d2 = Infinity, p2 = null;
    for (let i = 0; i < nb; i++) {
      const cp = closestOnSeg(node, boundary[i], boundary[(i+1)%nb]);
      const dx = cp.x - node.x, dy = cp.y - node.y;
      if (dx*dx1 + dy*dy1 >= 0) continue; // same half-plane as wall-1 â†’ skip
      const d  = Math.hypot(dx, dy);
      if (d < d2) { d2 = d; p2 = cp; }
    }
    if (!p2) return node; // can't identify opposite wall â€” leave unchanged
    return { x: (p1.x+p2.x)/2, y: (p1.y+p2.y)/2, radius: (d1+d2)/2 };
  };

  // Ramer-Douglas-Peucker (perpendicular distance in XY, Z carried by index)
  const simplify = (pts, tol) => {
    if (pts.length <= 2) return pts;
    const sqTol = tol * tol;
    const step = (arr, a, b) => {
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = (function(pt, p1, p2) {
          let x = p1.x, y = p1.y, dx = p2.x - x, dy = p2.y - y;
          if (dx !== 0 || dy !== 0) {
            const t = ((pt.x - x) * dx + (pt.y - y) * dy) / (dx * dx + dy * dy);
            if (t > 1) { x = p2.x; y = p2.y; } else if (t > 0) { x += dx * t; y += dy * t; }
          }
          return (pt.x - x) ** 2 + (pt.y - y) ** 2;
        })(arr[i], arr[a], arr[b]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (idx !== -1 && maxD > sqTol) return [...step(arr, a, idx), ...step(arr, idx, b)];
      return [arr[b]];
    };
    return [pts[0], ...step(pts, 0, pts.length - 1)];
  };

  for (const raw of profiles) {

    // â”€â”€ Step 1: Input smoothing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const boundary = simplify(stripClose([...raw]), 0.01);
    if (boundary.length < 3) continue;

    // â”€â”€ Step 2: Build medial axis graph â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let segs;
    try {
      segs = _jspoly.construct_medial_axis(boundary.map(v => ({ x: v.x, y: v.y })), [], 0.1, undefined, 0);
    } catch (e) { continue; }
    if (!segs?.length) continue;

    const nodeMap = new Map();
    const ptKey   = v => `${v.x.toFixed(3)},${v.y.toFixed(3)}`;
    const getNode = v => {
      const k = ptKey(v);
      if (!nodeMap.has(k)) nodeMap.set(k, { x: v.x, y: v.y, radius: v.radius, adj: [], protected: false });
      return nodeMap.get(k);
    };
    for (const s of segs) {
      const n0 = getNode(s.point0), n1 = getNode(s.point1);
      if (n0 !== n1 && !n0.adj.includes(n1)) { n0.adj.push(n1); n1.adj.push(n0); }
    }

    // â”€â”€ Step 3: Identify & protect convex corners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const nb = boundary.length;
    let area = 0;
    for (let i = 0; i < nb; i++) {
      const j = (i + 1) % nb;
      area += boundary[i].x * boundary[j].y - boundary[j].x * boundary[i].y;
    }
    for (let i = 0; i < nb; i++) {
      const A = boundary[(i - 1 + nb) % nb];
      const B = boundary[i];
      const C = boundary[(i + 1) % nb];
      const cross = (B.x - A.x) * (C.y - B.y) - (B.y - A.y) * (C.x - B.x);
      if (cross * area <= 0) continue; // concave or flat â€” skip
      let best = null, dMin = Infinity;
      for (const n of nodeMap.values()) {
        const d = (n.x - B.x) ** 2 + (n.y - B.y) ** 2;
        if (d < dMin) { dMin = d; best = n; }
      }
      if (!best) continue;
      const ck = `CV_${B.x.toFixed(3)},${B.y.toFixed(3)}`;
      if (!nodeMap.has(ck)) nodeMap.set(ck, { x: B.x, y: B.y, radius: 0, adj: [], protected: true });
      const cn = nodeMap.get(ck);
      cn.protected = true;
      if (!best.adj.includes(cn)) { best.adj.push(cn); cn.adj.push(best); }
    }

    // â”€â”€ Step 4: Corner-to-Corner pruning â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Iteratively delete non-protected leaves until every remaining leaf is a
    // protected corner.  Restarting after each deletion lets cascading stubs
    // collapse automatically, leaving only the clean spine + corner extensions.
    let pruned = true;
    while (pruned) {
      pruned = false;
      for (const [key, node] of nodeMap) {
        if (node.adj.length === 1 && !node.protected) {
          node.adj[0].adj = node.adj[0].adj.filter(a => a !== node);
          nodeMap.delete(key);
          pruned = true;
          break;
        }
      }
    }
    if (nodeMap.size === 0) continue;

    // â”€â”€ Step 5: Midpoint nudging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // JSPoly's Voronoi can be biased toward one wall due to polygon tessellation.
    // For each non-protected spine node: find the two nearest boundary walls on
    // opposite sides, move the node to their exact midpoint, and update radius.
    // Protected corner nodes sit on the boundary (radius=0) â€” do not nudge them.
    for (const node of nodeMap.values()) {
      if (node.protected) continue;
      const nudged = nudgeToCenter(node, boundary);
      node.x      = nudged.x;
      node.y      = nudged.y;
      node.radius = nudged.radius;
    }

    // â”€â”€ Step 6: Chain-based path extraction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // A "chain" is a maximal run of consecutive degree-2 nodes between two
    // junctions or leaves.  Walking chains instead of DFS-with-backtrack fixes
    // three artifacts at once:
    //   â€¢ No rainbow fragmentation â€” each edge visited exactly once, one direction.
    //   â€¢ No stray cross-gap line â€” RDP chord is a short in-material vector, never
    //     a zero-length start==end that degenerates into a distance-from-origin check.
    //   â€¢ No false-lift ribs â€” Corner-to-Corner pruning (Step 4) already removed
    //     every non-protected leaf, so the only chains left are spine + corner arms.
    const edgeKey     = (a, b) => [ptKey(a), ptKey(b)].sort().join('~');
    const visitedEdges = new Set();

    for (const [, startNode] of nodeMap) {
      for (const neighbor of [...startNode.adj]) {
        const ek = edgeKey(startNode, neighbor);
        if (visitedEdges.has(ek)) continue;

        // Walk the chain: follow degree-2 nodes until a junction (â‰¥3) or leaf (1)
        const chain = [startNode];
        let prev = startNode, cur = neighbor;
        while (true) {
          visitedEdges.add(edgeKey(prev, cur));
          chain.push(cur);
          if (cur.adj.length !== 2) break;
          const nxt = cur.adj.find(n => n !== prev);
          if (!nxt || visitedEdges.has(edgeKey(cur, nxt))) break;
          prev = cur; cur = nxt;
        }

        if (chain.length < 2) continue;

        // â”€â”€ Step 7: RDP after nudging (arc already centred) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const rawPts = chain.map(n => ({ x: n.x, y: n.y, z: zOf(n.radius) }));
        const smooth = simplify(rawPts, 0.1);
        if (smooth.length < 2) continue;

        // â”€â”€ Step 8: Safe transitions â€” rapid to safeZ before every chain â”€â”€â”€â”€â”€â”€
        moves.push({ type: 'rapid', x: smooth[0].x, y: smooth[0].y, z: safeZ });
        moves.push({ type: 'feed',  x: smooth[0].x, y: smooth[0].y, z: smooth[0].z, f: plungeRate });
        smooth.slice(1).forEach(pt => moves.push({ type: 'feed', ...pt, f: feedRate }));
        moves.push({ type: 'rapid', z: safeZ });
      }
    }
  }
  return { moves, warnings };
}

// â”€â”€ vcarve2: experimental F-Engrave-inspired directional V-carve â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Adds two ideas on top of vcarve's Corner-to-Corner + Midpoint-Nudge foundation:
//
//  1. Directional rib filter (Step 4b): after Corner-to-Corner pruning, any
//     remaining branch that runs nearly perpendicular (>80Â°) to its parent chain
//     is a Voronoi rib, not a corner arm â€” delete it.
//
//  2. Parallel-wall Z filter (Step 7): when computing Z for a spine node, ignore
//     boundary wall segments whose direction is within 10Â° of the spine's travel
//     direction at that node.  The "parallel trap" is why Voronoi Z lifts the bit
//     too early on long curves â€” the bit is running alongside a wall, the Voronoi
//     radius shrinks, and the formula incorrectly signals shallowing.  By skipping
//     that parallel wall and using the next-closest non-parallel wall instead,
//     depth stays true until the channel genuinely narrows.
//
function generateVCarve2(op, entities, context = {}) {
  console.log('[VCARVE-VERSION]', 'BUILD-TEST-' + Date.now());
  const moves = [], warnings = [];
  const p = op.params;

  const halfAngleDeg = Math.max(1, Math.min(89, p.halfAngle ?? 15));
  const tanAngle     = Math.tan(halfAngleDeg * Math.PI / 180);
  const tipRadius    = (p.tipDiameter ?? 0) / 2;
  const safeZ        = p.safeZ ?? 25;
  const topZ         = p.topZ ?? 0;
  const maxDepth     = Math.abs(p.maxDepth ?? 15);
  const feedRate     = p.feedRate ?? 1500;
  const plungeRate   = p.plungeRate ?? 300;

  if (!op.selectedIds?.length) return { moves: [], warnings: ['Select entities'] };
  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { moves: [], warnings: ['No entities selected'] };
  const allProfiles = buildPocketProfiles(selected);
  if (!allProfiles.length) return { moves: [], warnings: ['No closed profiles found'] };

  // Ray vs segment: returns distance t along ray, or null if no hit.
  const raySeg = (px, py, dx, dy, ax, ay, bx, by) => {
    const ex = bx - ax, ey = by - ay;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) return null;
    const fx = ax - px, fy = ay - py;
    const t = (fx * ey - fy * ex) / denom;
    const s = (fx * dy - fy * dx) / denom;
    return (t > 1e-6 && s >= 0 && s <= 1) ? t : null;
  };

  // RDP in XY, carries Z by value.
  const rdp = (pts, tol) => {
    if (pts.length <= 2) return pts;
    const sq = tol * tol;
    const reduce = (a, b) => {
      let mi = a, md = -1;
      const dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y;
      const len2 = dx * dx + dy * dy;
      for (let i = a + 1; i < b; i++) {
        let d;
        if (len2 < 1e-20) {
          d = (pts[i].x - pts[a].x) ** 2 + (pts[i].y - pts[a].y) ** 2;
        } else {
          const tc = Math.max(0, Math.min(1, ((pts[i].x - pts[a].x) * dx + (pts[i].y - pts[a].y) * dy) / len2));
          d = (pts[i].x - pts[a].x - tc * dx) ** 2 + (pts[i].y - pts[a].y - tc * dy) ** 2;
        }
        if (d > md) { md = d; mi = i; }
      }
      if (md > sq) return [...reduce(a, mi), ...reduce(mi, b)];
      return [pts[b]];
    };
    return [pts[0], ...reduce(0, pts.length - 1)];
  };

  let _profileIdx = 0;
  for (const profile of allProfiles) {
    const _pi = _profileIdx++;
    const boundary = stripClose([...profile]);
    const nb = boundary.length;
    if (nb < 3) continue;

    let cx = 0, cy = 0;
    for (const v of boundary) { cx += v.x; cy += v.y; }
    cx /= nb; cy /= nb;

    const cumLen = [0];
    for (let i = 0; i < nb; i++) {
      const a = boundary[i], b = boundary[(i + 1) % nb];
      cumLen.push(cumLen[i] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const totalLen = cumLen[nb];
    const sampleStep = Math.min(totalLen / 200, 1.0);
    const numSamples = Math.ceil(totalLen / sampleStep);

    // Step 1: sample boundary, cast inward ray, collect spine candidates.
    // Build arc-length positions: uniform grid + dense cluster near each sharp
    // corner vertex.  Near a corner where two walls converge, the cross-section
    // narrows to zero; sampling only at the uniform grid step misses the tiny
    // cross-sections because the corner vertex itself falls between grid points.
    // Injecting samples at 0.02–0.5 mm from the corner forces the ray-caster to
    // emit spine candidates with very small w (MIC → 0) right at the tip.
    const arcPositions = [];
    for (let k = 0; k < numSamples; k++) {
      arcPositions.push((k + 0.5) / numSamples * totalLen);
    }
    const hardCorners = []; // arc-length positions of sharp boundary corners (≤120°)
    for (let i = 0; i < nb; i++) {
      const prv = boundary[(i - 1 + nb) % nb], cur = boundary[i], nxt = boundary[(i + 1) % nb];
      const ax = prv.x - cur.x, ay = prv.y - cur.y;
      const bx = nxt.x - cur.x, by = nxt.y - cur.y;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-9 || lb < 1e-9) continue;
      const angleDeg = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) * 180 / Math.PI;
      if (angleDeg > 120) continue; // only dense-sample near genuinely sharp corners
      const pos = cumLen[i];
      hardCorners.push(pos); // record for Step 4 path-break detection
      for (const d of [0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.2, 0.35, 0.5]) {
        if (pos - d > 0)        arcPositions.push(pos - d);
        if (pos + d < totalLen) arcPositions.push(pos + d);
      }
    }

    const candidates = [];
    for (const s of arcPositions) {
      let si = 0;
      for (let i = 0; i < nb; i++) { if (cumLen[i + 1] >= s) { si = i; break; } }
      const A = boundary[si], B = boundary[(si + 1) % nb];
      const segLen = cumLen[si + 1] - cumLen[si];
      const frac   = segLen > 1e-9 ? (s - cumLen[si]) / segLen : 0;
      const px = A.x + frac * (B.x - A.x);
      const py = A.y + frac * (B.y - A.y);
      const el = segLen || 1;
      const ex = (B.x - A.x) / el, ey = (B.y - A.y) / el;
      const lx = -ey, ly = ex;
      const inward = (lx * (cx - px) + ly * (cy - py)) >= 0;
      const nx = inward ? lx : ey;
      const ny = inward ? ly : -ex;

      let bestT = Infinity;
      for (let i = 0; i < nb; i++) {
        const C = boundary[i], D = boundary[(i + 1) % nb];
        const hit = raySeg(px, py, nx, ny, C.x, C.y, D.x, D.y);
        if (hit !== null && hit < bestT) bestT = hit;
      }
      if (!isFinite(bestT)) continue;

      const halfW = bestT / 2;
      const mx = px + nx * halfW;
      const my = py + ny * halfW;

      let inside = false;
      for (let i = 0; i < nb; i++) {
        const ci = boundary[i], di = boundary[(i + 1) % nb];
        if ((ci.y > my) !== (di.y > my)) {
          const xc = ci.x + (my - ci.y) / (di.y - ci.y) * (di.x - ci.x);
          if (mx < xc) inside = !inside;
        }
      }
      if (!inside) continue;

      const depth = Math.min(maxDepth, Math.max(0, (halfW - tipRadius) / tanAngle));
      candidates.push({ x: mx, y: my, z: topZ - depth, w: bestT, s });
    }
    if (candidates.length < 2) continue;

    // Step 2: reject longitudinal samples whose width >> median cross-sectional width.
    const sorted  = [...candidates].sort((a, b) => a.w - b.w);
    const medianW = sorted[Math.floor(sorted.length / 2)].w;
    const filtered = candidates.filter(c => c.w <= medianW * 2.2);
    if (filtered.length < 2) continue;

    // Diagnostic A: does the raw skeleton contain near-zero MIC points at all?
    const minWFiltered = Math.min(...filtered.map(p => p.w));
    console.log('[vcarve2 min-mic] after-filter:', (minWFiltered / 2).toFixed(3), 'mm  median:', (medianW / 2).toFixed(3), 'mm  pts:', filtered.length, 'profile#', _pi);

    // Step 3: global spatial deduplication.  Keep w (= full ray distance = 2×MIC)
    // so downstream steps can distinguish genuine terminal nodes (w → 0) from noise.
    // Only merge two nearby candidates when their w values are within 4× of each other —
    // a corner-tip sample (w≈0.14) and a stroke-body sample (w≈2.4) are at genuinely
    // different spine locations and must NOT be collapsed together.
    const MERGE_D = sampleStep * 0.6;
    const deduped = [];
    for (const c of filtered) {
      let merged = false;
      for (const d of deduped) {
        // Adaptive merge radius: two spine points may only merge when their
        // spatial distance is less than the smaller of their two MIC radii.
        // This prevents a corner-tip node (halfW≈0.07mm) from being collapsed
        // into a nearby stroke-body node (halfW≈0.28mm) that is 0.2mm away —
        // they represent genuinely different medial-axis locations.
        const mergeThresh = Math.min(MERGE_D, c.w / 2, d.w / 2);
        if (Math.hypot(c.x - d.x, c.y - d.y) < mergeThresh) {
          if (c.z < d.z) { d.z = c.z; d.w = c.w; }
          merged = true; break;
        }
      }
      if (!merged) deduped.push({ x: c.x, y: c.y, z: c.z, w: c.w, s: c.s });
    }
    const minWDeduped = deduped.length ? Math.min(...deduped.map(p => p.w)) : Infinity;
    console.log('[vcarve2 min-mic] after-dedup:', (minWDeduped / 2).toFixed(3), 'mm  pts:', deduped.length, 'profile#', _pi);
    if (deduped.length < 2) continue;

    // Step 4: order by boundary arc-length parameter s.
    // Each candidate records the arc-length position on the boundary where its
    // inward ray was cast; sorting by s makes the toolpath trace the contour in
    // boundary order.  Depth rises naturally at every serif corner tip as the
    // local half-width → 0.  No proximity graph or branch pruning needed.
    //
    // Break condition: XY distance jump OR the two consecutive s-positions straddle
    // a sharp boundary corner.  The corner check stops the spine at true terminal
    // end-walls (e.g. isthmus junctions) even when XY candidates stay close.
    // The seam case (corner at s≈0 or s≈totalLen) is handled by the s0 > s1 branch.
    const crossesHardCorner = (s0, s1) => {
      if (s0 <= s1) return hardCorners.some(h => h > s0 && h < s1);
      return hardCorners.some(h => h > s0 || h < s1); // wrap-around seam
    };

    deduped.sort((a, b) => a.s - b.s);
    const ordered = [];
    for (let i = 0; i < deduped.length; i++) {
      const pt = { ...deduped[i] };
      if (i > 0) {
        const prev = ordered[ordered.length - 1];
        const xyJump = Math.hypot(pt.x - prev.x, pt.y - prev.y) > sampleStep * 4;
        if (xyJump || crossesHardCorner(prev.s, pt.s)) pt.breakPath = true;
      }
      ordered.push(pt);
    }
    console.log('[vcarve2 s-sort]', `profile#${_pi} pts=${ordered.length} s-range=[${deduped[0].s.toFixed(1)},${deduped[deduped.length-1].s.toFixed(1)}]`);
    if (ordered.length < 2) continue;

    // Step 4.5: remove isolated Z spikes within each continuous segment.
    for (let i = ordered.length - 2; i >= 1; i--) {
      if (ordered[i].breakPath || ordered[i + 1]?.breakPath) continue;
      if (ordered[i].z < ordered[i - 1].z - 0.3 && ordered[i].z < ordered[i + 1].z - 0.3)
        ordered.splice(i, 1);
    }

    // Step 5: split into continuous segments (deep-clone to avoid mutation).
    // Carry w so Step 6 can log back-calculated MIC radius.
    const segments = [];
    let seg = [{ x: ordered[0].x, y: ordered[0].y, z: ordered[0].z, w: ordered[0].w }];
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].breakPath) {
        segments.push(seg);
        seg = [{ x: ordered[i].x, y: ordered[i].y, z: ordered[i].z, w: ordered[i].w }];
      } else {
        seg.push({ x: ordered[i].x, y: ordered[i].y, z: ordered[i].z, w: ordered[i].w });
      }
    }
    segments.push(seg);

    // Step 6: orient, optionally split, RDP-smooth, and emit each segment.
    //
    // Three cases based on where the min-mic (narrowest = shallowest) point sits:
    //   end   (>90%): clean terminal branch already ordered junction→tip — emit as-is
    //   start (<10%): terminal branch traversed tip-first — reverse so tip is at tail
    //   middle       : through-stroke crossing a waist — split at the waist into two
    //                  sub-segments, each running from the waist outward to its arm end
    //
    // This ensures every emitted path ends at the shallowest point (or starts there
    // for split arms), so the bit rises naturally to the surface at corner tips.
    const segsToEmit = [];
    for (const segment of segments) {
      if (segment.length < 1) continue;

      let minW = Infinity, minIdx = 0;
      for (let i = 0; i < segment.length; i++) {
        const w = segment[i].w ?? Infinity;
        if (w < minW) { minW = w; minIdx = i; }
      }
      const relPos = minIdx / Math.max(1, segment.length - 1);
      const posLabel = relPos < 0.1 ? 'start' : relPos > 0.9 ? 'end' : 'middle';
      console.log('[vcarve2 order]', `len=${segment.length} min-mic=${(minW / 2).toFixed(3)} at=${posLabel}(idx=${minIdx})`);

      if (posLabel === 'end') {
        // Tip at tail — trim any straggler points past the minimum.
        segsToEmit.push(segment.slice(0, minIdx + 1));
      } else if (posLabel === 'start' && minIdx === 0) {
        // Tip is the very first point — just reverse the whole segment.
        console.log('[vcarve2 reversed]', 'minIdx=0, reversing whole segment');
        segsToEmit.push([...segment].reverse());
      } else {
        // minIdx is in the middle OR near the start with pre-tip nodes.
        // Pre-tip nodes (original[0..minIdx-1]) may be a second Y-arm traversed
        // before the min-mic point — emit them as a separate forward-order segment
        // (junction → its own tip) so both serif arms get cut.
        if (minIdx > 0) {
          console.log('[vcarve2 split-pre]', `emitting ${minIdx} pre-tip nodes as second arm`);
          segsToEmit.push(segment.slice(0, minIdx)); // second arm: already tip-at-end order
        }
        // Main segment reversed so the min-mic tip is at the tail.
        console.log('[vcarve2 split-main]', `emitting ${segment.length - minIdx} main nodes reversed`);
        segsToEmit.push([...segment.slice(minIdx)].reverse());
      }
    }

    for (const seg of segsToEmit) {
      const smooth = rdp(seg, 0.03);
      if (smooth.length < 1) continue;

      // Diagnostic: last-5 MIC/Z values to confirm the tip is rising.
      const tail = smooth.slice(-Math.min(5, smooth.length));
      console.log('[vcarve2 tail]', `len=${smooth.length}`, tail.map(pt => {
        const mic = pt.w != null ? pt.w / 2 : (topZ - pt.z) * tanAngle + tipRadius;
        return `mic=${mic.toFixed(3)} z=${pt.z.toFixed(3)}`;
      }).join(' → '));

      moves.push({ type: 'rapid', x: smooth[0].x, y: smooth[0].y, z: safeZ });
      moves.push({ type: 'feed',  x: smooth[0].x, y: smooth[0].y, z: smooth[0].z, f: plungeRate });
      for (let i = 1; i < smooth.length; i++)
        moves.push({ type: 'feed', x: smooth[i].x, y: smooth[i].y, z: smooth[i].z, f: feedRate });
      moves.push({ type: 'rapid', z: safeZ });
    }
  }

  return { moves, warnings };
}

// ── Corner Lift diagnostic ──────────────────────────────────────────────────
// For each sharp concave corner, walks the angle bisector inward from the tip
// and computes V-bit depth at each step.  Nearby corners (same serif) are
// merged into a single Y-branch path so their walks don't cross.

function _cornerLiftPaths(op, entities) {
  const p = op.params;
  const halfAngleDeg  = Math.max(1, Math.min(89, p.halfAngle ?? 15));
  const tanAngle      = Math.tan(halfAngleDeg * Math.PI / 180);
  const tipRadius     = (p.tipDiameter ?? 0) / 2;
  const topZ          = p.topZ ?? 0;
  const maxDepth      = Math.abs(p.maxDepth ?? 15);
  const cornerThresh  = p.cornerAngle ?? 110;
  const stepSize      = 0.1;
  const minSegLen     = 0.5;
  const clusterRadius = 10.0; // corners within this distance share a Y-branch

  if (!op.selectedIds?.length) return [];
  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return [];
  const allProfiles = buildPocketProfiles(selected);
  if (!allProfiles.length) return [];

  const ptSegDist = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx*dx + dy*dy;
    if (len2 < 1e-20) return Math.hypot(px-ax, py-ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / len2));
    return Math.hypot(px - (ax + t*dx), py - (ay + t*dy));
  };

  // Returns clusters: [{ paths: [{x,y,z},...], type: 'single'|'y-branch' }]
  const clusters = [];
  console.log('[cornerlift] profiles found:', allProfiles.length);

  for (const profile of allProfiles) {
    const boundary = stripClose([...profile]);
    const nb = boundary.length;
    if (nb < 3) continue;

    const cw = isClockwise(boundary);
    console.log('[cornerlift] profile: vertices=', nb, 'isClockwise=', cw,
      'polygonArea=', polygonArea(boundary).toFixed(3));

    const stopDist = maxDepth * tanAngle + tipRadius + 1.0;

    // ── Pass 1: find qualifying corners — position + bisector direction only,
    //           no walk generated yet.  Clustering must happen before walking so
    //           paired corners can use each other's position for stopping. ─────
    const candidates = []; // { idx, cur:{x,y}, dx, dy }

    for (let i = 0; i < nb; i++) {
      const prv = boundary[(i - 1 + nb) % nb];
      const cur = boundary[i];
      const nxt = boundary[(i + 1) % nb];

      // Incoming direction: from cur back toward the previous segment.
      // If the incoming segment is an arc, use its true tangent at cur (negated
      // to point backward) instead of the chord to prv, which may be very short.
      let ax, ay, la;
      if (cur._arcTangentIn) {
        ax = -cur._arcTangentIn.dx;
        ay = -cur._arcTangentIn.dy;
        la = 1; // unit vector — bypass the minSegLen chord-length check
      } else {
        ax = prv.x - cur.x; ay = prv.y - cur.y;
        la = Math.hypot(ax, ay);
        if (la < minSegLen) continue;
      }

      // Outgoing direction: from cur toward the next segment.
      // Same logic for arc starts.
      let bx, by, lb;
      if (cur._arcTangentOut) {
        bx = cur._arcTangentOut.dx;
        by = cur._arcTangentOut.dy;
        lb = 1;
      } else {
        bx = nxt.x - cur.x; by = nxt.y - cur.y;
        lb = Math.hypot(bx, by);
        if (lb < minSegLen) continue;
      }

      const cross = ax * by - ay * bx;
      const isConcave = cw ? (cross > 0) : (cross < 0);

      const cosA = Math.max(-1, Math.min(1, (ax*bx + ay*by) / (la*lb)));
      const wedgeAngle = Math.acos(cosA) * 180 / Math.PI;

      const verdict = !isConcave ? 'skip(convex)'
        : wedgeAngle > cornerThresh ? `skip(angle>${cornerThresh}°)` : 'LIFT';
      console.log('[cornerlift] v#' + i,
        `(${cur.x.toFixed(3)},${cur.y.toFixed(3)})`,
        isConcave ? 'CONCAVE' : 'convex',
        `wedge=${wedgeAngle.toFixed(1)}°  cross=${cross.toFixed(4)}  → ${verdict}`);

      if (!isConcave || wedgeAngle > cornerThresh) continue;

      const biX = ax/la + bx/lb, biY = ay/la + by/lb;
      const biL = Math.hypot(biX, biY);
      if (biL < 1e-9) continue;

      let dx = -biX/biL, dy = -biY/biL;
      if (!pointInPolygon({ x: cur.x + dx * 0.5, y: cur.y + dy * 0.5 }, boundary)) {
        dx = -dx; dy = -dy;
      }

      candidates.push({ idx: i, cur: { x: cur.x, y: cur.y }, dx, dy });
    }

    // ── Pass 2: cluster candidates within clusterRadius ────────────────────
    const used = new Set();
    const clusterGroups = [];
    for (let a = 0; a < candidates.length; a++) {
      if (used.has(a)) continue;
      used.add(a);
      const group = [candidates[a]];
      for (let b = a + 1; b < candidates.length; b++) {
        if (used.has(b)) continue;
        if (Math.hypot(candidates[a].cur.x - candidates[b].cur.x,
            candidates[a].cur.y - candidates[b].cur.y) < clusterRadius) {
          group.push(candidates[b]);
          used.add(b);
        }
      }
      clusterGroups.push(group);
    }

    // ── Pass 3: generate walks with cluster-appropriate stopping ───────────
    //
    // Single corner: stop when wallDist peaks (crossed the stroke medial axis).
    //
    // Paired corners (same serif): each arm stops at the PERPENDICULAR BISECTOR
    // Single-corner walk: follow bisector direction, stop when wallDist peaks.
    const makeWalkSingle = (cand, boundary, nb) => {
      const path = [];
      let px = cand.cur.x, py = cand.cur.y;
      let peakWallDist = 0;
      for (let step = 0; step <= 200; step++) {
        let wallDist = Infinity;
        for (let j = 0; j < nb; j++) {
          const d = ptSegDist(px, py,
            boundary[j].x, boundary[j].y,
            boundary[(j+1)%nb].x, boundary[(j+1)%nb].y);
          if (d < wallDist) wallDist = d;
        }
        if (wallDist > peakWallDist) peakWallDist = wallDist;
        if (step > 3 && wallDist < peakWallDist - stepSize) break;
        const z = topZ - Math.max(0, Math.min(maxDepth, (wallDist - tipRadius) / tanAngle));
        path.push({ x: px, y: py, z });
        if (wallDist >= stopDist) break;
        px += cand.dx * stepSize;
        py += cand.dy * stepSize;
      }
      return path;
    };

    // Paired-corner walk: straight line from corner tip to junction.
    // The junction is pre-computed so both arms share exactly the same endpoint.
    const makeWalkToJunction = (cand, jx, jy, jz, boundary, nb) => {
      const path = [];
      const totalDist = Math.hypot(jx - cand.cur.x, jy - cand.cur.y);
      if (totalDist < stepSize) return path;
      const dirX = (jx - cand.cur.x) / totalDist;
      const dirY = (jy - cand.cur.y) / totalDist;
      const numSteps = Math.ceil(totalDist / stepSize);
      for (let step = 0; step <= numSteps; step++) {
        const t = Math.min(step * stepSize, totalDist);
        const px = cand.cur.x + dirX * t;
        const py = cand.cur.y + dirY * t;
        let wallDist = Infinity;
        for (let j = 0; j < nb; j++) {
          const d = ptSegDist(px, py,
            boundary[j].x, boundary[j].y,
            boundary[(j+1)%nb].x, boundary[(j+1)%nb].y);
          if (d < wallDist) wallDist = d;
        }
        const z = topZ - Math.max(0, Math.min(maxDepth, (wallDist - tipRadius) / tanAngle));
        path.push({ x: px, y: py, z });
      }
      // Snap last point to exact junction so both arms share the same coordinate.
      if (path.length > 0) path[path.length - 1] = { x: jx, y: jy, z: jz };
      return path;
    };

    for (const group of clusterGroups) {
      const isPaired = group.length >= 2;
      // For clusters > 2, keep the two with the most separation (widest serif).
      if (group.length > 2) {
        group.sort((a, b) => {
          const dA = Math.hypot(a.cur.x - group[0].cur.x, a.cur.y - group[0].cur.y);
          const dB = Math.hypot(b.cur.x - group[0].cur.x, b.cur.y - group[0].cur.y);
          return dB - dA;
        });
        group.splice(2);
      }

      const paths = [];

      if (!isPaired) {
        const path = makeWalkSingle(group[0], boundary, nb);
        if (path.length >= 2) {
          console.log('[cornerlift] single v#' + group[0].idx + ' steps=' + path.length,
            `tip-z=${path[0].z.toFixed(3)} end-z=${path[path.length-1].z.toFixed(3)}`);
          paths.push(path);
        }
      } else {
        const ca = group[0], cb = group[1];

        // Find junction = intersection of bisector rays from ca and cb.
        // Ray from ca: P = ca.cur + t * (ca.dx, ca.dy)
        // Ray from cb: P = cb.cur + s * (cb.dx, cb.dy)
        // Solving: t*ca.dx - s*cb.dx = ex,  t*ca.dy - s*cb.dy = ey
        // det = ca.dy*cb.dx - ca.dx*cb.dy,  t = (cb.dx*ey - cb.dy*ex) / det
        const ex = cb.cur.x - ca.cur.x, ey = cb.cur.y - ca.cur.y;
        const det = ca.dy * cb.dx - ca.dx * cb.dy;
        const midX = (ca.cur.x + cb.cur.x) / 2;
        const midY = (ca.cur.y + cb.cur.y) / 2;

        let jx = midX, jy = midY;
        if (Math.abs(det) > 1e-6) {
          const t = (cb.dx * ey - cb.dy * ex) / det;
          if (t > 0 && t < 40) {
            jx = ca.cur.x + t * ca.dx;
            jy = ca.cur.y + t * ca.dy;
          }
          // t <= 0 means rays diverge — fall back to midpoint M.
        }

        // Compute junction Z from wallDist at junction point.
        let jWallDist = Infinity;
        for (let j = 0; j < nb; j++) {
          const d = ptSegDist(jx, jy,
            boundary[j].x, boundary[j].y,
            boundary[(j+1)%nb].x, boundary[(j+1)%nb].y);
          if (d < jWallDist) jWallDist = d;
        }
        const jz = topZ - Math.max(0, Math.min(maxDepth, (jWallDist - tipRadius) / tanAngle));

        console.log('[cornerlift] Y-branch v#' + ca.idx + ' + v#' + cb.idx,
          `det=${det.toFixed(4)} junc=(${jx.toFixed(3)},${jy.toFixed(3)},${jz.toFixed(3)})`);

        for (const cand of [ca, cb]) {
          const path = makeWalkToJunction(cand, jx, jy, jz, boundary, nb);
          if (path.length >= 2) {
            console.log('[cornerlift] → v#' + cand.idx + ' steps=' + path.length,
              `tip-z=${path[0].z.toFixed(3)} junc-z=${path[path.length-1].z.toFixed(3)}`);
            paths.push(path);
          }
        }
      }

      if (paths.length === 0) continue;
      clusters.push({ paths, type: isPaired && paths.length === 2 ? 'y-branch' : 'single' });
    }
  }

  return clusters;
}

export function computeCornerLiftPolylines(op, entities) {
  // Each cluster contributes one polyline per arm so the canvas shows the full Y.
  return _cornerLiftPaths(op, entities)
    .flatMap(({ paths }) => paths.map(path => path.map(pt => ({ x: pt.x, y: pt.y }))));
}

function generateCornerLift(op, entities, context = {}) {
  const moves = [], warnings = [];
  const p = op.params;
  const safeZ      = p.safeZ ?? 25;
  const feedRate   = p.feedRate ?? 1500;
  const plungeRate = p.plungeRate ?? 300;

  const clusters = _cornerLiftPaths(op, entities);
  if (clusters.length === 0) {
    warnings.push('No sharp corners found — try raising the Corner Angle threshold');
    return { moves, warnings };
  }

  for (const { paths, type } of clusters) {
    if (type === 'single') {
      const [path] = paths;
      moves.push({ type: 'rapid', z: safeZ });
      moves.push({ type: 'rapid', x: path[0].x, y: path[0].y, z: safeZ });
      moves.push({ type: 'feed',  x: path[0].x, y: path[0].y, z: path[0].z, f: plungeRate });
      for (let i = 1; i < path.length; i++)
        moves.push({ type: 'feed', x: path[i].x, y: path[i].y, z: path[i].z, f: feedRate });
      moves.push({ type: 'rapid', z: safeZ });
    } else {
      // Y-branch: enter at corner1 tip, deepen along arm1 to junction,
      // bridge to arm2 junction, then rise along arm2 reversed to corner2 tip.
      const [path1, path2] = paths;
      const j1 = path1[path1.length - 1];
      const j2 = path2[path2.length - 1];
      moves.push({ type: 'rapid', z: safeZ });
      moves.push({ type: 'rapid', x: path1[0].x, y: path1[0].y, z: safeZ });
      moves.push({ type: 'feed',  x: path1[0].x, y: path1[0].y, z: path1[0].z, f: plungeRate });
      for (let i = 1; i < path1.length; i++)
        moves.push({ type: 'feed', x: path1[i].x, y: path1[i].y, z: path1[i].z, f: feedRate });
      // Bridge between the two arm endpoints (negligible for symmetric serifs).
      if (Math.hypot(j1.x - j2.x, j1.y - j2.y) > 0.01)
        moves.push({ type: 'feed', x: j2.x, y: j2.y, z: Math.min(j1.z, j2.z), f: feedRate });
      // Rise along arm2 reversed toward corner2 tip.
      for (let i = path2.length - 2; i >= 0; i--)
        moves.push({ type: 'feed', x: path2[i].x, y: path2[i].y, z: path2[i].z, f: feedRate });
      moves.push({ type: 'rapid', z: safeZ });
    }
  }

  return { moves, warnings };
}

function generateTaperedPocket(op, entities, context = {}) {
  const p = op.params;
  const warnings = [];
  // Require explicit entity selection â€” falling back to all entities risks picking
  // up stock boundary rectangles or other reference geometry as the pocket outline.
  if (!op.selectedIds?.length) {
    return { moves: [], subToolpaths: [], warnings: ['Select specific entities before calculating Tapered Pocket'] };
  }
  let selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { moves: [], subToolpaths: [], warnings: ['No entities found for selected IDs'] };
  selected = applyMirror(selected, p);

  const topZ   = p.topZ ?? 0;
  const depth  = Math.abs(p.pocketDepth || 5);
  const safeZ  = p.safeZ ?? 10;
  return buildTaperedPasses(selected, topZ, depth, safeZ, p, warnings, null);
}

function generateTaperedPlug(op, entities, context = {}) {
  const p = op.params;
  const warnings = [];
  if (!op.selectedIds?.length) {
    return { moves: [], subToolpaths: [], warnings: ['Select specific entities before calculating Tapered Plug'] };
  }
  let selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { moves: [], subToolpaths: [], warnings: ['No entities found for selected IDs'] };
  selected = applyMirror(selected, p);

  const depth   = Math.abs(p.pocketDepth || 5);
  const safeZ   = p.safeZ ?? 10;
  const passes  = p.passes || {};
  const tcAngle = passes.taperContour?.angle ?? passes.taperCleanup?.angle ?? 10;
  const wallRad = Math.max(0.5, tcAngle / 2) * Math.PI / 180;
  // Raise topZ so the plug engages the pocket walls fractionally higher,
  // leaving a fitTolerance gap uniformly around the perimeter.
  const plugTopZ = (p.topZ ?? 0) + (p.fitTolerance || 0.127) / Math.tan(wallRad);

  // Build clip boundary: per-op stock dimensions (centered on geometry) take precedence
  // over the global stock panel. This lets each plug specify its own blank size.
  let stockBound;
  if (p.stockW > 0 || p.stockH > 0) {
    const b = getEntityBounds(selected);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const hw = (p.stockW > 0 ? p.stockW : (b.maxX - b.minX) * 3) / 2;
    const hh = (p.stockH > 0 ? p.stockH : (b.maxY - b.minY) * 3) / 2;
    // CCW rectangle
    stockBound = [
      { x: cx - hw, y: cy - hh }, { x: cx + hw, y: cy - hh },
      { x: cx + hw, y: cy + hh }, { x: cx - hw, y: cy + hh },
    ];
  } else {
    stockBound = getStockBoundary(context, op, context.allEntities);
  }

  // Default cutSide for plug is 'outside'; the UI displays this default but only
  // writes p.cutSide when the user explicitly changes the dropdown, so p.cutSide
  // may be undefined on operations created before the field existed.
  const plugParams = p.cutSide != null ? p : { ...p, cutSide: 'outside' };
  const result = buildTaperedPasses(selected, plugTopZ, depth, safeZ, plugParams, warnings, stockBound);

  // Optional outer boundary contour â€” same logic as CAD "Offset & Union":
  // expand only outer contours (skip inner islands detected by centroid containment),
  // offset each outward with round joins, union into one perimeter, then profile-cut it.
  if (p.boundaryEnabled && (p.boundaryOffset ?? 0) > 0) {
    const allProfiles = buildPocketProfiles(selected).map(pr => stripClose([...pr]));
    if (allProfiles.length > 0) {
      // Skip inner contours: if a profile's centroid is inside any other profile, it's a hole.
      const outerProfiles = allProfiles.filter(pts => {
        const cx = pts.reduce((s, pt) => s + pt.x, 0) / pts.length;
        const cy = pts.reduce((s, pt) => s + pt.y, 0) / pts.length;
        return !allProfiles.some(other => other !== pts && pointInPolygon({ x: cx, y: cy }, other));
      });

      if (outerProfiles.length > 0) {
        // Ensure CCW, then expand outward with round joins so gaps between shapes fill in
        const toCCW = pts => isClockwise(pts) ? [...pts].reverse() : pts;
        const expanded = outerProfiles
          .flatMap(pts => roundedOffsetPolyline(toCCW(pts), -p.boundaryOffset, true))
          .filter(pr => pr?.length >= 3)
          .map(pr => { const s = stripClose([...pr]); return toCCW(s); });

        if (expanded.length > 0) {
          const unioned = unionPolygons(expanded);
          const outerBoundary = unioned[0];
          if (outerBoundary?.length >= 3) {
            const ccwBnd = isClockwise(outerBoundary) ? [...outerBoundary].reverse() : outerBoundary;
            const passes   = p.passes || {};
            const bePass   = passes.bulkEndmill   || {};
            const dePass   = passes.detailEndmill || {};
            const useEm    = (bePass.enabled !== false && (bePass.diameter || 0) > 0) ? bePass : dePass;
            const emR      = (useEm.diameter || 6.35) / 2;
            const emDpp    = useEm.depthPerPass || useEm.diameter || 6.35;
            const emFeed   = useEm.feed || 1500;
            const emPlunge = useEm.plunge || 500;

            // Tool centre path: boundary expanded outward by tool radius
            const toolPath = offsetPolyline(stripClose([...ccwBnd]), -emR, true)[0];
            if (toolPath?.length >= 3) {
              const bndMoves = [];
              const numPasses = Math.max(1, Math.ceil(depth / emDpp));
              const start = toolPath[0];
              bndMoves.push({ type: 'rapid', x: start.x, y: start.y, z: safeZ });
              for (let i = 0; i < numPasses; i++) {
                const z = plugTopZ - Math.min((i + 1) * emDpp, depth);
                bndMoves.push({ type: 'feed', x: start.x, y: start.y, z, f: emPlunge });
                for (let j = 1; j < toolPath.length; j++) {
                  bndMoves.push({ type: 'feed', x: toolPath[j].x, y: toolPath[j].y, z, f: emFeed });
                }
                bndMoves.push({ type: 'feed', x: start.x, y: start.y, z, f: emFeed });
              }
              bndMoves.push({ type: 'rapid', z: safeZ });

              result.subToolpaths.push({
                name: 'Boundary Cut',
                color: '#cc44ff',
                toolKey:  useEm.toolId ?? 'bulkEndmill',
                toolDesc: `Endmill âŒ€${useEm.diameter || 6.35}mm`,
                rpm: useEm.rpm || 18000,
                moves: bndMoves,
              });
              result.moves.push(...bndMoves);
            }
          }
        }
      }
    }
  }

  return result;
}

// Shared 4-pass builder used by both Pocket and Plug.
// topZ is the caller's effective origin (stock top for pocket, raised for plug).
function buildTaperedPasses(selected, topZ, depth, safeZ, p, warnings, stockBound = null) {
  const passes  = p.passes || {};
  const tc = passes.taperContour  || {};
  const tk = passes.taperCleanup  || {};
  const de = passes.detailEndmill || {};
  const be = passes.bulkEndmill   || {};

  const cutSide = p.cutSide ?? 'inside';
  const clearFn = cutSide === 'outside' ? buildPlugClearing : buildPocketClearing;

  // The contour pass defines the wall geometry; use its angle for endmill clearance.
  const wallAngle = tc.angle ?? tk.angle ?? 10;
  const wallRad   = Math.max(0.5, wallAngle / 2) * Math.PI / 180;

  // Build profiles from selected entities.  All profiles are machined (taper trace +
  // clearing).  buildPocketClearing groups them by containment so spatially-separate
  // shapes (e.g. letters "C" and "L") each get independent clearing, while truly
  // nested profiles (e.g. the counter inside "O") become island exclusions.
  const allProfiles = buildPocketProfiles(selected);
  allProfiles.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  const partProfiles = allProfiles;
  const effectiveClipBound = stockBound;

  const subToolpaths = [];

  // Operation order: clearing first (Bulk â†’ Detail), taper traces last (Cleanup â†’ Contour).
  // Clearing must run before the taper trace so the endmill can reach right to the profile
  // boundary on clean stock; the taper bit then cuts the finished tapered wall last.

  if (be.enabled !== false) {
    const beR = (be.diameter || 6.35) / 2;
    const beDepthPerPass = be.depthPerPass || be.diameter || 6.35;
    const bePrevR = be.restMachining && (be.prevDiameter || 0) > 0 ? be.prevDiameter / 2 : 0;
    subToolpaths.push({
      name: 'Bulk Endmill', color: '#4499ff',
      toolKey:  be.toolId ?? 'bulkEndmill',
      toolDesc: `Endmill âŒ€${be.diameter || 6.35}mm`,
      rpm: be.rpm || 18000,
      moves: clearFn(selected, topZ, depth, safeZ,
        beR, beDepthPerPass, be.wallStock || 0.254, be.feed || 1500, be.plunge || 500,
        wallRad, 'Bulk Endmill', warnings, bePrevR, effectiveClipBound, be.leadInStyle || 'plunge', be.leadInArcRadius || 0, partProfiles),
    });
  }

  if (de.enabled !== false) {
    const deR = (de.diameter || 1.5875) / 2;
    const deDepthPerPass = de.depthPerPass || de.diameter || 1.5875;
    const dePrevR = de.restMachining && (de.prevDiameter || 0) > 0 ? de.prevDiameter / 2 : 0;
    subToolpaths.push({
      name: 'Detail Endmill', color: '#44ff88',
      toolKey:  de.toolId ?? 'detailEndmill',
      toolDesc: `Endmill âŒ€${de.diameter || 1.5875}mm`,
      rpm: de.rpm || 18000,
      moves: clearFn(selected, topZ, depth, safeZ,
        deR, deDepthPerPass, de.wallStock || 0.254, de.feed || 800, de.plunge || 300,
        wallRad, 'Detail Endmill', warnings, dePrevR, effectiveClipBound, de.leadInStyle || 'plunge', de.leadInArcRadius || 0, partProfiles),
    });
  }

  if (tk.enabled !== false) {
    const tkRad = Math.max(0.5, (tk.angle || 10) / 2) * Math.PI / 180;
    const tipR  = (tk.tipDia || 0.5) / 2;
    subToolpaths.push({
      name: 'Taper Cleanup', color: '#ffcc44',
      toolKey:  tk.toolId ?? 'taper',
      toolDesc: `Taper bit â€” tip âŒ€${tk.tipDia || 0.5}mm  ${tk.angle || 10}Â° half-angle`,
      rpm: tk.rpm || 24000,
      // Single contour trace at final wall position â€” not a clearing pass.
      // Reaches all profiles (including inner contours) unlike clearFn which treats
      // inner profiles as island exclusions.
      moves: buildTaperTrace(selected, topZ, depth, safeZ,
        tk.feed || 1000, tk.plunge || 300, tkRad, cutSide, tipR,
        p.sharpCornerAngle ?? 180, tk.leadInStyle || 'plunge', tk.leadInRampAngle || 3, tk.leadInArcRadius || 0, partProfiles),
    });
  }

  if (tc.enabled !== false) {
    const tcRad = Math.max(0.5, (tc.angle || 10) / 2) * Math.PI / 180;
    subToolpaths.push({
      name: 'Taper Contour', color: '#ff8844',
      toolKey:  tc.toolId ?? 'taper',
      toolDesc: `Taper bit â€” tip âŒ€${tc.tipDia || 0.5}mm  ${tc.angle || 10}Â° half-angle`,
      rpm: tc.rpm || 24000,
      moves: buildTaperTrace(selected, topZ, depth, safeZ, tc.feed || 1000, tc.plunge || 300, tcRad, cutSide, (tc.tipDia || 0) / 2, p.sharpCornerAngle ?? 180, tc.leadInStyle || 'plunge', tc.leadInRampAngle || 3, tc.leadInArcRadius || 0, partProfiles),
    });
  }

  const moves = subToolpaths.flatMap(st => st.moves);
  return { moves, subToolpaths, warnings };
}

// â”€â”€ Corner-relief helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Cumulative arc lengths for a closed polygon (no closing point assumed).
function cumArcLen(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++)
    c.push(c[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return c;
}

// For each contour point, compute the inscribed circle radius: the largest circle
// centred at (P + rÂ·n_P) â€” where n_P is the inward normal at P â€” that fits inside
// the polygon without crossing any non-adjacent boundary segment.
//
// Apollonius formula for segment j with inward normal n_j:
//   r = L_P / (1 âˆ’ n_P Â· n_j)
// where L_P = n_j Â· (P âˆ’ A) is the signed distance from P to the line of segment j.
// When n_P Â· n_j â‰ˆ 1 (nearly parallel, same direction â€” dense tessellation neighbours),
// the denominator collapses to â‰ˆ 0 and the constraint is skipped automatically.
// Endpoint constraints handle cases where the circle centre projects past a segment end.
//
// Used by:  maxDepth = (r_inscribed âˆ’ tipRadius) / tan(halfAngle)
function computeContourLocalWidths(rawPts) {
  const cw  = isClockwise(rawPts);
  const pts = cw ? [...rawPts].reverse() : rawPts;
  const n   = pts.length;
  const out = new Array(n).fill(Infinity);

  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];

    // Inward normal at vertex i: average adjacent-edge tangents, rotate 90Â° CCW.
    const t1x = curr.x - prev.x, t1y = curr.y - prev.y;
    const t2x = next.x - curr.x, t2y = next.y - curr.y;
    const l1  = Math.hypot(t1x, t1y) || 1, l2 = Math.hypot(t2x, t2y) || 1;
    const tx  = t1x / l1 + t2x / l2,   ty  = t1y / l1 + t2y / l2;
    const tl  = Math.hypot(tx, ty) || 1;
    const nPx = -ty / tl, nPy = tx / tl;  // inward normal for CCW polygon

    let rMin = Infinity;

    for (let j = 0; j < n; j++) {
      // Skip the two segments directly attached to vertex i.
      if (j === i || j === ((i - 1 + n) % n)) continue;

      const j2 = (j + 1) % n;
      const ax = pts[j].x,  ay = pts[j].y;
      const bx = pts[j2].x, by = pts[j2].y;

      // Inward normal of segment j (CCW polygon: rotate edge vector 90Â° CCW).
      const ex = bx - ax, ey = by - ay;
      const el = Math.hypot(ex, ey);
      if (el < 1e-10) continue;
      const njx = -ey / el, njy = ex / el;

      // Signed distance from curr to the line of segment j (positive = inside polygon).
      const lp = njx * (curr.x - ax) + njy * (curr.y - ay);
      if (lp <= 0) continue;  // curr outside this half-plane â€” non-convex artefact, skip

      // Apollonius constraint: r = lp / (1 âˆ’ n_P Â· n_j).
      // denom â†’ 0 when walls are nearly co-directional (dense tessellation neighbours) â€” skip.
      // Guard: also verify the inscribed-circle tangent point falls within the actual
      // segment (not just on its infinite line extension).  A segment whose LINE passes
      // close to P but whose extents are far away (e.g. a handle wall above a pan body
      // point) would otherwise produce a falsely tiny r.
      const dot   = nPx * njx + nPy * njy;
      const denom = 1 - dot;
      if (denom > 1e-6) {
        const r = lp / denom;
        if (r > 0 && r < rMin) {
          // Inscribed circle centre Q = P + rÂ·n_P; tangent point T = Q âˆ’ rÂ·n_j.
          const qx = curr.x + r * nPx, qy = curr.y + r * nPy;
          const tx = qx - r * njx,     ty = qy - r * njy;
          // Parameterise T along segment j: s âˆˆ [0,1] means T is within the segment.
          const s = ((tx - ax) * ex + (ty - ay) * ey) / (el * el);
          if (s >= 0 && s <= 1) rMin = r;
        }
      }

      // Endpoint constraints: prevent the inscribed-circle centre from flying past
      // an endpoint vertex into open space.  For vertex V: dist(centre, V) â‰¥ r
      // simplifies to r â‰¤ |Pâˆ’V|Â² / (2Â·|(Pâˆ’V)Â·n_P|) when (Pâˆ’V)Â·n_P < 0.
      for (const [vx, vy] of [[curr.x - ax, curr.y - ay], [curr.x - bx, curr.y - by]]) {
        const dotV = vx * nPx + vy * nPy;
        if (dotV < -1e-10) {
          const r = (vx * vx + vy * vy) / (-2 * dotV);
          if (r > 0 && r < rMin) rMin = r;
        }
      }
    }

    out[i] = rMin;  // inscribed circle radius at this contour point
  }

  return cw ? out.reverse() : out;
}

// Smooth a circular depth array in two passes:
//   1. min-filter â€” never exceed the tightest local constraint.
//   2. box-average â€” soften abrupt transitions.
function smoothDepthProfile(depths, winHalf = 4) {
  const n   = depths.length;
  const idx = k => ((k % n) + n) % n;

  const mn = depths.map((_, i) => {
    let m = depths[i];
    for (let k = 1; k <= winHalf; k++)
      m = Math.min(m, depths[idx(i - k)], depths[idx(i + k)]);
    return m;
  });

  return mn.map((_, i) => {
    let s = 0;
    for (let k = -winHalf; k <= winHalf; k++) s += mn[idx(i + k)];
    return s / (2 * winHalf + 1);
  });
}

// Remap a depth array from one polygon to another via arc-length fraction.
// Aligns starting vertices (Clipper may reorder the result polygon).
function arcLengthRemap(depths, fromPts, toPts) {
  const fromCum  = cumArcLen(fromPts);
  const fromLast = fromPts[fromPts.length - 1];
  const fromPerim = fromCum[fromCum.length - 1] +
    Math.hypot(fromPts[0].x - fromLast.x, fromPts[0].y - fromLast.y);

  const toCum  = cumArcLen(toPts);
  const toLast = toPts[toPts.length - 1];
  const toPerim = toCum[toCum.length - 1] +
    Math.hypot(toPts[0].x - toLast.x, toPts[0].y - toLast.y);

  const nf = depths.length, nt = toPts.length;

  // Find the toPts vertex closest to fromPts[0] to correct for Clipper reordering.
  let offset = 0, bestD = Infinity;
  for (let i = 0; i < nt; i++) {
    const d = Math.hypot(toPts[i].x - fromPts[0].x, toPts[i].y - fromPts[0].y);
    if (d < bestD) { bestD = d; offset = i; }
  }

  return toPts.map((_, ti) => {
    const ai  = (ti + offset) % nt;
    const frac = toPerim > 0 ? toCum[ai] / toPerim : 0;
    const target = frac * fromPerim;

    let lo = 0, hi = nf - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fromCum[mid] <= target) lo = mid; else hi = mid;
    }
    if (fromCum[hi] <= fromCum[lo]) return depths[lo];
    const t = (target - fromCum[lo]) / (fromCum[hi] - fromCum[lo]);
    return depths[lo] + t * (depths[hi] - depths[lo]);
  });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Trace selected contours with the taper bit.
//
// Uses roundedOffsetPolyline (jtRound) for the base trace path so concave
// sections never produce miter spikes.  Sharp corners from the original letter
// are restored by corner-sharpening ramp moves: at each convex turn in the
// rounded path the bit ramps to the original sharp corner (P + bisector Ã— bitRadius)
// at topZ, then returns to the arc at floorZ.  This produces the same "spider leg"
// corner geometry as Fusion 360 V-carve.
//
// Pocket (inside): offset inward by bitRadius so the taper flank at the surface
//   follows the letter boundary.
// Plug (outside):  offset outward by depthÃ—tan(halfAngle) so the taper flank at
//   the surface aligns with the profile boundary â€” mating walls result.
//
// MIN_CORNER_TURN prevents gentle tessellation arc steps (â‰¤12Â°) from triggering
// spurious corner ramps while still catching genuine letter corners.
function buildTaperTrace(entities, topZ, depth, safeZ, feedRate, plungeRate, tcRad, cutSide, tipRadius = 0, sharpCornerAngle = 180, leadInStyle = 'plunge', leadInRampAngle = 3, leadInArcRadius = 0, prebuiltProfiles = null) {
  const moves     = [];
  const tanAlpha  = Math.tan(tcRad);
  const floorZ    = topZ - depth;
  const bitRadius = tipRadius + depth * tanAlpha;
  const traceOffset = cutSide === 'outside' ? -(depth * tanAlpha) : bitRadius;
  const isOutside   = cutSide === 'outside';

  // Floor at 12Â° so arc tessellation steps never trigger corner ramps.
  const MIN_CORNER_TURN = Math.max(12 * Math.PI / 180, (180 - sharpCornerAngle) * Math.PI / 180);

  const profiles = prebuiltProfiles ?? buildPocketProfiles(entities);
  const outerProfileRef = profiles.length > 1
    ? [...profiles].sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)))[0]
    : profiles[0];
  const outerProfileCCW = isClockwise(outerProfileRef) ? [...outerProfileRef].reverse() : outerProfileRef;

  for (const rawProfile of profiles) {
    const rawStripped = stripClose([...rawProfile]);
    if (rawStripped.length < 3) continue;
    const rawCCW = isClockwise(rawStripped) ? [...rawStripped].reverse() : rawStripped;

    const isInnerProfile = profiles.length > 1 && rawProfile !== outerProfileRef;
    const testPt = rawCCW[Math.floor(rawCCW.length / 2)];
    const isNestedInner = isInnerProfile && isOutside && !!testPt && pointInPolygon(testPt, outerProfileCCW);
    const profileTraceOffset = isNestedInner ? -traceOffset : traceOffset;

    const rawOffsets = roundedOffsetPolyline(rawCCW, profileTraceOffset, true);
    const tracePolygons = (rawOffsets ?? []).filter(r => r?.length >= 3);

    for (const traceRaw of tracePolygons) {
      const ptsRaw = stripClose([...traceRaw]);
      if (ptsRaw.length < 3) continue;
      const pts = isClockwise(ptsRaw) ? [...ptsRaw].reverse() : ptsRaw;
      const n   = pts.length;

      const arcR = leadInArcRadius || Math.max(0.5, tipRadius || 1);
      moves.push(...buildLeadIn(pts, topZ, floorZ, safeZ, leadInStyle, leadInRampAngle, arcR, feedRate, plungeRate, cutSide));

      // Start at i=1; lead-in already landed at pts[0].  Wrap back to pts[0] at i=n.
      for (let i = 1; i <= n; i++) {
        const P    = pts[i % n];
        const Pprv = pts[(i - 1 + n) % n];
        const Pnxt = pts[(i + 1) % n];

        moves.push({ type: 'feed', x: P.x, y: P.y, z: floorZ, f: feedRate });

        const ax = P.x - Pprv.x, ay = P.y - Pprv.y;
        const bx = Pnxt.x - P.x, by = Pnxt.y - P.y;
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);

        if (la > 1e-10 && lb > 1e-10) {
          const ux1 = ax / la, uy1 = ay / la;
          const ux2 = bx / lb, uy2 = by / lb;
          const cross       = ux1 * uy2 - uy1 * ux2;
          const cornerCross = isOutside ? -cross : cross;

          if (cornerCross > 1e-6) {
            const turnAngle = Math.atan2(cornerCross, ux1 * ux2 + uy1 * uy2);
            if (turnAngle > MIN_CORNER_TURN) {
              // Reconstruct the original sharp corner: the rounded arc passes through P
              // at distance bitRadius from the original polygon corner.  Moving bitRadius
              // along the outward bisector from P arrives at the original corner vertex.
              const s  = isOutside ? -1 : 1;
              const rx = s * (uy1 + uy2);
              const ry = s * (-ux1 - ux2);
              const rl = Math.hypot(rx, ry);
              if (rl > 1e-10) {
                const cornerX = P.x + (rx / rl) * bitRadius;
                const cornerY = P.y + (ry / rl) * bitRadius;
                moves.push({ type: 'feed', x: cornerX, y: cornerY, z: topZ,   f: feedRate });
                moves.push({ type: 'feed', x: P.x,     y: P.y,     z: floorZ, f: feedRate });
              }
            }
          }
        }
      }

      moves.push({ type: 'rapid', x: pts[0].x, y: pts[0].y, z: safeZ });
    }
  }
  return moves;
}

// Generic concentric pocket-clearing pass.
// Works for both V-bit cleanup (small toolR, single Z pass) and endmill passes.
//
//   toolR       â€” effective cutting radius for stepover / offset generation
//   depthPerPass â€” Z step between levels (pass full depth for single-level)
//   wallStock   â€” explicit standoff added on top of the taper geometry clearance
//   taperRad    â€” half-angle (rad) of the wall that defines clearance geometry
function buildPocketClearing(entities, topZ, depth, safeZ, toolR, depthPerPass, wallStock, feedRate, plungeRate, taperRad, passLabel, warnings, prevToolR = 0, stockBound = null, leadInStyle = 'plunge', leadInArcRadius = 0, prebuiltProfiles = null) {
  const moves     = [];
  const wallLeave = depth * Math.tan(taperRad) + wallStock;
  const inset     = toolR + wallLeave;
  const zPasses   = buildZPasses(topZ, depth, depthPerPass);

  const profiles = prebuiltProfiles ?? buildPocketProfiles(entities);
  if (!profiles.length) return moves;

  // Sort largest-first so the containment check finds immediate parents correctly.
  profiles.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));

  // Normalise all profiles to CCW so positive offsets consistently shrink inward.
  const ccwProfiles = profiles.map(p => isClockwise(p) ? [...p].reverse() : p);

  // Build a containment tree: for each profile find its immediate parent (the smallest
  // enclosing profile), or -1 if it is a root (top-level, not inside anything).
  // Multiple separate letters (e.g. "C" and "L") both appear as roots and each gets
  // its own independent clearing. A hole inside "O" appears as a child and becomes an
  // island exclusion for its parent letter.
  const parents = ccwProfiles.map((prof, i) => {
    const testPt = prof[Math.floor(prof.length / 2)];
    if (!testPt) return -1;
    let parentIdx = -1;
    for (let j = 0; j < ccwProfiles.length; j++) {
      if (j === i) continue;
      if (pointInPolygon(testPt, ccwProfiles[j])) {
        if (parentIdx === -1 ||
            Math.abs(polygonArea(ccwProfiles[j])) < Math.abs(polygonArea(ccwProfiles[parentIdx]))) {
          parentIdx = j;
        }
      }
    }
    return parentIdx;
  });

  const rootIndices = ccwProfiles.map((_, i) => i).filter(i => parents[i] === -1);

  for (const rootIdx of rootIndices) {
    const outerProfile = ccwProfiles[rootIdx];

    // Direct children: profiles whose immediate parent is this root become island exclusions.
    const islandProfiles = ccwProfiles.filter((_, i) => parents[i] === rootIdx);

    // Clearing runs BEFORE the taper trace, so the endmill cuts into clean stock and
    // can safely reach the profile edge (toolR boundary = edge touches the profile).
    // Island exclusion zones use the full inset so the endmill stays clear of any
    // inner taper walls left by a prior island-trace pass.
    const boundary = offsetPolyline(outerProfile, toolR, true)[0];
    if (!boundary || boundary.length < 4 || polygonArea(boundary) < toolR * toolR * Math.PI * 0.25) {
      warnings.push(`${passLabel}: contour too small for âŒ€${(toolR * 2).toFixed(2)}mm tool`);
      continue;
    }

    const islandExclusions = islandProfiles.map(island => {
      const expanded = offsetPolyline(island, -inset, true)[0];
      return (expanded && expanded.length >= 3) ? expanded : island;
    });

    if (islandExclusions.length > 0) warnNarrowGaps(islandExclusions, boundary, toolR, warnings);
    const clearPasses = prevToolR > 0
      ? generateRestMachiningPasses(outerProfile, toolR, prevToolR, 0.45, islandExclusions)
      : generatePocketOffsets(boundary, toolR, 0.45, islandExclusions);
    if (!clearPasses.length) {
      if (islandExclusions.length === 0 && prevToolR === 0) {
        warnings.push(`${passLabel}: no clearing passes â€” contour too small after wall clearance`);
      }
      continue;
    }

    const helixR = leadInArcRadius || toolR * 0.5;
    moves.push(...buildLeadIn(clearPasses[0], topZ, zPasses[0], safeZ, leadInStyle, 3, helixR, feedRate, plungeRate, 'inside'));

    const hasIslands = islandExclusions.length > 0;
    let lastClearX = null, lastClearY = null;
    for (const z of zPasses) {
      for (const pass of clearPasses) {
        if (!pass || pass.length < 2) continue;
        if (hasIslands && lastClearX !== null) {
          // Two-step retract: lift Z straight up at current XY first, then traverse at
          // safeZ so the tool doesn't contact island walls during a diagonal rapid.
          moves.push({ type: 'rapid', x: lastClearX, y: lastClearY, z: safeZ });
        }
        moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: hasIslands ? safeZ : z + 0.5 });
        moves.push({ type: 'feed',  x: pass[0].x, y: pass[0].y, z, f: plungeRate });
        for (let i = 1; i < pass.length; i++) {
          moves.push({ type: 'feed', x: pass[i].x, y: pass[i].y, z, f: feedRate });
        }
        lastClearX = pass[pass.length - 1].x;
        lastClearY = pass[pass.length - 1].y;
      }
    }
    moves.push({ type: 'rapid', x: outerProfile[0].x, y: outerProfile[0].y, z: safeZ });
  }

  return moves;
}

// Concentric clearing for outside cuts (tapered plug).
// Expands rings outward from the plug profile and clips each to the stock boundary,
// matching the 2D Pocket outside-boss approach. generatePocketOffsets is NOT used
// here because its island exclusion relies on a vertex-in-polygon check that fails
// when a large rectangular ring surrounds a central exclusion zone â€” the ring corners
// stay outside the zone even when the ring sides pass through it.
//
// Same parameter signature as buildPocketClearing so buildTaperedPasses can
// dispatch between the two with a single function reference.
function buildPlugClearing(entities, topZ, depth, safeZ, toolR, depthPerPass, wallStock, feedRate, plungeRate, taperRad, passLabel, warnings, prevToolR = 0, stockBound = null, leadInStyle = 'plunge', leadInArcRadius = 0, prebuiltProfiles = null) {
  const moves     = [];
  const wallLeave = depth * Math.tan(taperRad) + wallStock;
  const outset    = toolR + wallLeave;
  const step      = toolR * 2 * 0.45;
  const zPasses   = buildZPasses(topZ, depth, depthPerPass);

  const profiles = prebuiltProfiles ?? buildPocketProfiles(entities);
  if (!profiles.length) return moves;

  profiles.sort((a, b) => polygonArea(b) - polygonArea(a));
  const outerProfile = isClockwise(profiles[0]) ? [...profiles[0]].reverse() : profiles[0];

  // Clip boundary: stock rect (preferred) or entity bounds + margin (fallback when
  // no stock is configured). The stock boundary is used as-is for clipping â€” the
  // tool-centre-to-edge offset is already baked into `outset` on the inner side.
  let clipBound = stockBound;
  if (!clipBound) {
    const b = getEntityBounds(entities);
    const margin = Math.max(toolR * 3, outset + toolR * 2);
    clipBound = [
      { x: b.minX - margin, y: b.minY - margin },
      { x: b.maxX + margin, y: b.minY - margin },
      { x: b.maxX + margin, y: b.maxY + margin },
      { x: b.minX - margin, y: b.maxY + margin },
    ];
  }

  const prevOutset = prevToolR > 0 ? prevToolR + wallLeave : null;

  if (profiles.length === 1) {
    // Single boss: expand rings outward from the profile boundary, clip each to the
    // stock boundary. More efficient than stock-inward clearing for a lone boss.
    const clearPasses = [];
    for (let i = 0, dist = outset; i < 200; i++, dist += step) {
      if (prevOutset !== null && dist >= prevOutset) break;

      const rawRings = offsetPolyline(outerProfile, -dist, true); // negative = expand outward
      let any = false;
      for (const rawRing of rawRings) {
        if (!rawRing || rawRing.length < 3 || polygonArea(rawRing) < step * step * 0.5) continue;
        const ringPts = stripClose([...rawRing]);
        const clipped = clipPolygonToRegion(ringPts, clipBound);
        for (const c of clipped) {
          if (!c || c.length < 3) continue;
          clearPasses.push([...c, c[0]]);
          any = true;
        }
      }
      if (!any) break;
    }

    if (!clearPasses.length) {
      warnings.push(`${passLabel}: no outside clearing passes generated`);
      return moves;
    }

    const helixR = leadInArcRadius || toolR * 0.5;
    moves.push(...buildLeadIn(clearPasses[0], topZ, zPasses[0], safeZ, leadInStyle, 3, helixR, feedRate, plungeRate, 'outside'));

    for (const z of zPasses) {
      for (const pass of clearPasses) {
        if (!pass || pass.length < 2) continue;
        moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: z + 0.5 });
        moves.push({ type: 'feed',  x: pass[0].x, y: pass[0].y, z, f: plungeRate });
        for (let i = 1; i < pass.length; i++) {
          moves.push({ type: 'feed', x: pass[i].x, y: pass[i].y, z, f: feedRate });
        }
      }
    }
    moves.push({ type: 'rapid', x: outerProfile[0].x, y: outerProfile[0].y, z: safeZ });
    return moves;
  }

  // Multiple boss profiles: sweep inward from the stock boundary treating every boss as
  // an island exclusion zone. This handles both topologies without any topology detection
  // in the clearing loop:
  //   - Separate bosses (two circles apart): clearing fills the stock area, stops near
  //     each boss independently â€” neither boss is cut through.
  //   - Ring bosses (letter with counter): clearing stops outside the outer ring; the
  //     interior hole is pocket-cleared separately below.
  const inset = toolR + wallLeave;
  const allBossExclusions = profiles.map(prof => {
    const ccw = isClockwise(prof) ? [...prof].reverse() : prof;
    const expanded = offsetPolyline(ccw, -inset, true)[0];
    return (expanded && expanded.length >= 3) ? expanded : ccw;
  });

  const clipBoundaryCCW = isClockwise(clipBound) ? [...clipBound].reverse() : [...clipBound];
  const stockBoundaryInset = offsetPolyline(clipBoundaryCCW, toolR, true)[0];

  if (!stockBoundaryInset || stockBoundaryInset.length < 3) {
    warnings.push(`${passLabel}: stock boundary too small for multi-boss clearing`);
    return moves;
  }

  if (allBossExclusions.length > 1) warnNarrowGaps(allBossExclusions, null, toolR, warnings);
  const multiClearPasses = prevToolR > 0
    ? generateRestMachiningPasses(clipBoundaryCCW, toolR, prevToolR, 0.45, allBossExclusions)
    : generatePocketOffsets(stockBoundaryInset, toolR, 0.45, allBossExclusions);

  if (multiClearPasses.length) {
    const helixR = leadInArcRadius || toolR * 0.5;
    moves.push(...buildLeadIn(multiClearPasses[0], topZ, zPasses[0], safeZ, leadInStyle, 3, helixR, feedRate, plungeRate, 'outside'));
    for (const z of zPasses) {
      for (const pass of multiClearPasses) {
        if (!pass || pass.length < 2) continue;
        moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: z + 0.5 });
        moves.push({ type: 'feed',  x: pass[0].x, y: pass[0].y, z, f: plungeRate });
        for (let i = 1; i < pass.length; i++) {
          moves.push({ type: 'feed', x: pass[i].x, y: pass[i].y, z, f: feedRate });
        }
      }
    }
  } else {
    warnings.push(`${passLabel}: no multi-boss clearing passes generated`);
  }

  // Hole-clear any inner profiles nested inside the outer profile (ring-boss counters like
  // letter "O"). Separate bosses (two circles apart) won't pass the pointInPolygon test.
  for (const innerProfRaw of profiles.slice(1)) {
    const innerProfile = isClockwise(innerProfRaw) ? [...innerProfRaw].reverse() : innerProfRaw;
    const testPt = innerProfile[Math.floor(innerProfile.length / 2)];
    if (testPt && pointInPolygon(testPt, outerProfile)) {
      const holeMoves = buildPocketClearing(
        [], topZ, depth, safeZ, toolR, depthPerPass, wallStock,
        feedRate, plungeRate, taperRad, passLabel, warnings, prevToolR,
        null, leadInStyle, leadInArcRadius, [innerProfile]
      );
      moves.push(...holeMoves);
    }
  }

  return moves;
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Warn when pre-expanded island exclusion zones overlap each other (gap between the raw
// island boundaries is less than twice the expansion amount â€” i.e. less than tool diameter
// plus any wall-leave) or when an exclusion zone overflows the pocket/stock boundary
// (island too close to the outer wall).  One warning is emitted and the function returns
// so the array stays concise.  Uses pointInPolygon for quick vertex-in-polygon tests which
// catches all practical cases (convex or mildly concave island shapes).
function warnNarrowGaps(exclusionZones, boundary, toolR, warnings) {
  if (!exclusionZones.length) return;
  const dia = (toolR * 2).toFixed(2);
  // Island-to-island overlap check
  for (let i = 0; i < exclusionZones.length - 1; i++) {
    for (let j = i + 1; j < exclusionZones.length; j++) {
      const a = exclusionZones[i], b = exclusionZones[j];
      if (a.some(pt => pointInPolygon(pt, b)) || b.some(pt => pointInPolygon(pt, a))) {
        warnings.push(`Gap between islands too small for Ã¸${dia}â€¯mm tool â€” some areas will not be machined. Use a smaller tool or increase spacing.`);
        return;
      }
    }
  }
  // Island-to-boundary overflow check
  if (boundary) {
    for (const excl of exclusionZones) {
      if (excl.some(pt => !pointInPolygon(pt, boundary))) {
        warnings.push(`Island too close to pocket wall for Ã¸${dia}â€¯mm tool â€” some areas will not be machined. Use a smaller tool or increase spacing.`);
        return;
      }
    }
  }
}

function buildZPasses(topZ, totalDepth, depthPerPass) {
  const passes = [];
  const bottom = topZ - Math.abs(totalDepth);
  let z = topZ - Math.abs(depthPerPass);
  while (z > bottom) {
    passes.push(z);
    z -= Math.abs(depthPerPass);
  }
  passes.push(bottom);
  return passes;
}

function buildRampEntry(profile, topZ, targetZ, rampAngleDeg, feedRate, plungeRate) {
  const moves = [];
  const depth = topZ - targetZ;
  if (depth <= 0) return moves;
  const rampAngleRad = rampAngleDeg * Math.PI / 180;
  let z = topZ;
  moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: topZ + 0.5 });

  for (let i = 0; i < profile.length - 1 && z > targetZ; i++) {
    const segLen = Math.hypot(profile[i+1].x - profile[i].x, profile[i+1].y - profile[i].y);
    const zDrop = segLen * Math.tan(rampAngleRad);
    const newZ = Math.max(targetZ, z - zDrop);
    moves.push({ type: 'feed', x: profile[i+1].x, y: profile[i+1].y, z: newZ, f: plungeRate });
    z = newZ;
  }
  return moves;
}

// Quarter-circle tangential arc lead-in.  The tool approaches pts[0] along a 90Â° arc
// that is tangent to the contour entry direction at pts[0].
// cutSide 'inside' : arc center is to the left of T  (CCW sweep, approach from interior)
// cutSide 'outside': arc center is to the right of T (CW  sweep, approach from exterior)
function buildArcLeadIn(pts, targetZ, arcRadius, feedRate, safeZ, cutSide = 'outside') {
  if (!pts || pts.length < 2) return [];
  const P = pts[0], Q = pts[1];
  const dx = Q.x - P.x, dy = Q.y - P.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [];
  const tx = dx / len, ty = dy / len;
  const R = Math.max(0.1, arcRadius);

  // Arc center: right of T for outside, left for inside
  const s = cutSide === 'inside' ? -1 : 1;
  const cx = P.x + s * ty * R;
  const cy = P.y - s * tx * R;

  // Arc start A = center - R*T (90Â° before P in travel direction).
  // Verified: at i=SEGS the tessellation lands exactly on P for both cut sides.
  const ax = cx - tx * R;
  const ay = cy - ty * R;

  const startAngle = Math.atan2(ay - cy, ax - cx);
  const sweepDir   = cutSide === 'inside' ? 1 : -1;  // +1 = CCW, -1 = CW
  const SEGS = 12;

  const moves = [];
  moves.push({ type: 'rapid', x: ax, y: ay, z: safeZ });
  moves.push({ type: 'feed',  x: ax, y: ay, z: targetZ, f: feedRate });
  for (let i = 1; i <= SEGS; i++) {
    const a = startAngle + sweepDir * (i / SEGS) * (Math.PI / 2);
    moves.push({ type: 'feed', x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), z: targetZ, f: feedRate });
  }
  return moves;
}

// Unified lead-in dispatcher.  Includes the approach rapid so callers do not need
// a separate rapid before calling.
// arcRadius doubles as the helix radius for 'helical' style.
function buildLeadIn(pts, topZ, targetZ, safeZ, leadInStyle, rampAngle, arcRadius, feedRate, plungeRate, cutSide) {
  if (!pts || pts.length < 1) return [];
  if (leadInStyle === 'ramp' && pts.length >= 2) {
    return buildRampEntry(pts, topZ, targetZ, rampAngle || 3, feedRate, plungeRate);
  }
  if (leadInStyle === 'arc' && pts.length >= 2) {
    return buildArcLeadIn(pts, targetZ, arcRadius || 3.175, feedRate, safeZ, cutSide || 'outside');
  }
  if (leadInStyle === 'helical') {
    const helixR = Math.max(0.1, arcRadius || 0.5);
    const center = { x: pts[0].x, y: pts[0].y };
    return [
      { type: 'rapid', x: center.x, y: center.y, z: safeZ },
      ...buildHelicalEntry(center, helixR, topZ, targetZ, plungeRate),
    ];
  }
  // plunge (default)
  return [
    { type: 'rapid', x: pts[0].x, y: pts[0].y, z: safeZ },
    { type: 'feed',  x: pts[0].x, y: pts[0].y, z: targetZ, f: plungeRate },
  ];
}

function buildHelicalEntry(center, radius, topZ, targetZ, plungeRate) {
  const moves = [];
  const depth = topZ - targetZ;
  const steps = Math.max(18, Math.ceil(depth / 0.5));
  moves.push({ type: 'rapid', x: center.x + radius, y: center.y, z: topZ });
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const z = topZ - (i / steps) * depth;
    moves.push({ type: 'feed', x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius, z, f: plungeRate });
  }
  return moves;
}

function entityToProfile(entity) {
  if (!entity) return null;
  switch (entity.type) {
    case 'circle':   return circleToPoints(entity.center, entity.radius, 72);
    case 'arc':      return arcToPoints(entity.center, entity.radius, entity.startAngle, entity.endAngle, 36);
    case 'polyline': return polylineToPoints(entity.vertices, entity.closed);
    case 'line':     return [entity.start, entity.end];
    case 'ellipse': {
      const { center, rx, ry, rotation = 0 } = entity;
      const cos = Math.cos(rotation), sin = Math.sin(rotation);
      return Array.from({ length: 64 }, (_, i) => {
        const t = (i / 64) * 2 * Math.PI;
        const lx = rx * Math.cos(t), ly = ry * Math.sin(t);
        return { x: center.x + lx * cos - ly * sin, y: center.y + lx * sin + ly * cos };
      });
    }
    default:         return null;
  }
}

function isEntityClosed(entity) {
  if (!entity) return false;
  if (entity.type === 'circle') return true;
  if (entity.type === 'arc') return false;
  if (entity.type === 'polyline') return entity.closed;
  if (entity.type === 'ellipse') return true;
  return false;
}

function getSelectedEntities(entities, ids) {
  if (!ids || ids.length === 0) return entities;
  return entities.filter(e => ids.includes(e.id));
}

// Chains individual LINE and ARC entities into one closed point array by
// matching endpoints within SNAP tolerance. Returns null if the result has
// fewer than 3 points or the segments cannot be connected.
function chainSegments(entities) {
  const SNAP = 0.01;
  function ptDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  const segs = entities
    .filter(e => e.type === 'line' || e.type === 'arc')
    .map(e => ({ pts: entityToProfile(e), entity: e, used: false }))
    .filter(s => s.pts && s.pts.length >= 2);

  if (!segs.length) return null;

  const chain = [...segs[0].pts];
  segs[0].used = true;

  // arcEvents records tangent info for arc-entity endpoints so the corner
  // detector gets the true tangent direction rather than a short first chord.
  // { idx: chainIndex, key: '_arcTangentOut'|'_arcTangentIn', dx, dy }
  const arcEvents = [];

  function recordArcTangents(entity, startIdx, endIdx, reversed) {
    if (entity.type !== 'arc') return;
    const sA = entity.startAngle; // radians
    const eA = entity.endAngle;   // radians
    // CCW tangent at a given angle: rotate the radius vector 90° CCW → (-sin, cos).
    // Reversed arc travels CW, so negate: (sin, -cos).
    if (!reversed) {
      arcEvents.push({ idx: startIdx, key: '_arcTangentOut', dx: -Math.sin(sA), dy:  Math.cos(sA) });
      arcEvents.push({ idx: endIdx,   key: '_arcTangentIn',  dx: -Math.sin(eA), dy:  Math.cos(eA) });
    } else {
      arcEvents.push({ idx: startIdx, key: '_arcTangentOut', dx:  Math.sin(eA), dy: -Math.cos(eA) });
      arcEvents.push({ idx: endIdx,   key: '_arcTangentIn',  dx:  Math.sin(sA), dy: -Math.cos(sA) });
    }
  }

  recordArcTangents(segs[0].entity, 0, chain.length - 1, false);

  for (let pass = 0; pass < segs.length; pass++) {
    const tail = chain[chain.length - 1];
    let found = false;
    for (const seg of segs) {
      if (seg.used) continue;
      const head = seg.pts[0];
      const foot = seg.pts[seg.pts.length - 1];
      const junctionIdx = chain.length - 1;
      if (ptDist(tail, head) <= SNAP) {
        chain.push(...seg.pts.slice(1));
        seg.used = true; found = true;
        recordArcTangents(seg.entity, junctionIdx, chain.length - 1, false);
        break;
      }
      if (ptDist(tail, foot) <= SNAP) {
        chain.push(...[...seg.pts].reverse().slice(1));
        seg.used = true; found = true;
        recordArcTangents(seg.entity, junctionIdx, chain.length - 1, true);
        break;
      }
    }
    if (!found) break;
  }

  // Drop duplicate closing point if chain loops back to start
  const origLen = chain.length;
  const closeDist = origLen > 1 ? ptDist(chain[0], chain[origLen - 1]) : Infinity;
  const isClosed = closeDist <= SNAP;
  if (isClosed) chain.pop();

  // Apply arc tangent events. Events for the removed closing point move to index 0.
  for (const ev of arcEvents) {
    let idx = ev.idx;
    if (isClosed && idx === origLen - 1) idx = 0;
    if (idx >= chain.length) continue;
    chain[idx] = { ...chain[idx], [ev.key]: { dx: ev.dx, dy: ev.dy } };
  }

  return chain.length >= 3 ? chain : null;
}

// Build profiles for pocket operations. When selected entities are individual
// LINE/ARC segments (not a closed polyline), chains them into a single closed
// polygon first. Falls back to per-entity conversion for polylines and circles.
function buildPocketProfiles(entities) {
  const segEnts   = entities.filter(e => e.type === 'line' || e.type === 'arc');
  const otherEnts = entities.filter(e => e.type !== 'line' && e.type !== 'arc');

  const profiles = otherEnts
    .map(e => entityToProfile(e))
    .filter(p => p && p.length >= 3);

  if (segEnts.length >= 2) {
    const chained = chainSegments(segEnts);
    if (chained) profiles.push(chained);
  } else if (segEnts.length === 1) {
    const pts = entityToProfile(segEnts[0]);
    if (pts && pts.length >= 3) profiles.push(pts);
  }

  return profiles;
}

// Returns a CCW polygon (no closing point) representing the clipping boundary:
// uses op.boundaryIds entities when set, otherwise the stock rectangle from context.stockConfig.
function getStockBoundary(context, op, allEntities) {
  if (op.boundaryIds?.length && allEntities?.length) {
    const boundEnts = allEntities.filter(e => op.boundaryIds.includes(e.id));
    if (boundEnts.length) {
      const profiles = buildPocketProfiles(boundEnts);
      if (profiles.length) {
        const p = profiles[0];
        return isClockwise(p) ? [...p].reverse() : p;
      }
    }
  }
  const sc = context?.stockConfig;
  if (!sc || !(sc.width > 0) || !(sc.length > 0)) return null;
  const ox   = sc.stockOriginX ?? 0;
  const oy   = sc.stockOriginY ?? 0;
  const xOff = (sc.datum?.[1] === 'l' ? 0 : sc.datum?.[1] === 'c' ? 0.5 : 1) * sc.width;
  const yOff = (sc.datum?.[0] === 'b' ? 0 : sc.datum?.[0] === 'm' ? 0.5 : 1) * sc.length;
  const minX = ox - xOff,  maxX = minX + sc.width;
  const minY = oy - yOff,  maxY = minY + sc.length;
  // CCW rectangle (Y-up convention)
  return [
    { x: minX, y: minY }, { x: maxX, y: minY },
    { x: maxX, y: maxY }, { x: minX, y: maxY },
  ];
}

function getEntityBounds(entities) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of entities) {
    const pts = entityToProfile(e) || [];
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX: isFinite(minX) ? minX : 0, minY: isFinite(minY) ? minY : 0, maxX: isFinite(maxX) ? maxX : 100, maxY: isFinite(maxY) ? maxY : 100 };
}

// â”€â”€ Dogbone Fillets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Returns all concave (interior) corners of the selected closed geometry.
// Each corner is { x, y, bisX, bisY } where bisX/bisY is the unit vector
// pointing into the pocket interior (toward the dogbone center).
export function detectConcaveCorners(entities, selectedIds) {
  const selected = getSelectedEntities(entities, selectedIds);
  if (!selected.length) return [];
  const profiles = buildPocketProfiles(selected);
  const corners = [];

  for (const rawProfile of profiles) {
    const poly = stripClose([...rawProfile]);
    const n = poly.length;
    if (n < 3) continue;
    const cw = isClockwise(poly);

    for (let i = 0; i < n; i++) {
      const A = poly[(i - 1 + n) % n];
      const V = poly[i];
      const B = poly[(i + 1) % n];

      const ux = V.x - A.x, uy = V.y - A.y;
      const wx = B.x - V.x, wy = B.y - V.y;
      const uLen = Math.hypot(ux, uy);
      const wLen = Math.hypot(wx, wy);
      if (uLen < 1e-6 || wLen < 1e-6) continue;

      const cross = ux * wy - uy * wx;
      if (Math.abs(cross) / (uLen * wLen) < 0.05) continue; // nearly collinear

      // CW polygon: right turn (cross < 0) = interior corner needing dogbone
      // CCW polygon: left turn (cross > 0) = interior corner needing dogbone
      if (!(cw ? cross < 0 : cross > 0)) continue;

      // Bisector toward interior: average of unit vectors pointing back toward A and forward toward B
      const d1x = -ux / uLen, d1y = -uy / uLen;
      const d2x =  wx / wLen, d2y =  wy / wLen;
      const bx = d1x + d2x, by = d1y + d2y;
      const bLen = Math.hypot(bx, by);
      if (bLen < 1e-6) continue;

      corners.push({ x: V.x, y: V.y, bisX: bx / bLen, bisY: by / bLen });
    }
  }
  return corners;
}

function generateDogbone(op, entities) {
  const moves = [];
  const warnings = [];
  const p = op.params;
  const contours = buildPocketProfiles(entities);
  const candidateCorners = detectConcaveCorners(entities, op.selectedIds);

  if (!candidateCorners.length) {
    const msg = op.selectedIds?.length ? 'No sharp internal corners detected' : 'No geometry assigned';
    return { moves, warnings: [msg], candidateCorners, contours };
  }

  const toolR = (p.toolDiameter || 6.35) / 2;
  const safeZ = p.safeZ || 25;
  const passes = buildZPasses(p.topZ ?? 0, p.totalDepth || 10, p.depthPerPass || 3);
  const corners = (p.cornerMode || 'auto') === 'auto'
    ? candidateCorners
    : (p.selectedCorners || []);

  if (!corners.length) {
    warnings.push('No corners selected. Use "Select on Canvas" to pick corners.');
    return { moves, warnings, candidateCorners, contours };
  }

  for (const corner of corners) {
    const cx = corner.x + toolR * corner.bisX;
    const cy = corner.y + toolR * corner.bisY;
    moves.push({ type: 'rapid', x: cx, y: cy, z: safeZ });
    for (const z of passes) {
      moves.push({ type: 'feed', x: cx, y: cy, z, f: p.plungeRate || 500 });
    }
    moves.push({ type: 'rapid', x: cx, y: cy, z: safeZ });
  }

  return { moves, warnings, candidateCorners, contours };
}

// â”€â”€ Text Engraving â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateText(op) {
  const moves = [], warnings = [];
  const p = op.params;

  if (!p.textContoursRel?.length) {
    return {
      moves: [],
      warnings: ['No text geometry â€” click "Generate Geometry" in the Text Engraving params'],
      contours: [],
    };
  }

  const safeZ    = p.safeZ || 25;
  const topZ     = p.topZ ?? 0;
  const feedRate = p.feedRate || 1500;
  const plungeR  = p.plungeRate || 500;
  const toolR    = (p.toolDiameter || 6.35) / 2;
  const stepover = p.stepover || 0.45;
  const tx       = p.textX || 0;
  const ty       = p.textY || 0;
  const mode     = p.outputMode || 'engraved';
  const zPasses  = buildZPasses(topZ, Math.abs(p.totalDepth || 1.5), p.depthPerPass || 0.5);

  // Apply text placement offset to all stored relative contours
  const glyphGroups = p.textContoursRel.map(group =>
    group.map(contour => contour.map(pt => ({ x: pt.x + tx, y: pt.y + ty })))
  );
  const allContours = glyphGroups.flat();

  if (mode === 'filled') {
    for (const group of glyphGroups) {
      if (!group.length) continue;

      // Sort by absolute area: largest = outer letter boundary, rest = counter holes
      const sorted = [...group].sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
      const outer = sorted[0];
      if (!outer || outer.length < 3) continue;

      // Normalise outer to CCW (positive offset = shrink inward)
      const outerCCW = isClockwise(outer) ? [...outer].reverse() : outer;

      // Inset outer by toolR â†’ tool-centre travel boundary
      const boundary = offsetPolyline(outerCCW, toolR, true)[0];
      if (!boundary || boundary.length < 3) {
        warnings.push('Letter too small for this tool diameter');
        continue;
      }

      // Expand each hole outward by toolR â†’ exclusion zone for tool centre
      const islandExclusions = sorted.slice(1)
        .map(h => {
          const hCCW = isClockwise(h) ? [...h].reverse() : h;
          return offsetPolyline(hCCW, -toolR, true)[0];
        })
        .filter(e => e?.length >= 3);

      const clearPasses = generatePocketOffsets(boundary, toolR, stepover, islandExclusions);
      if (!clearPasses.length) {
        warnings.push('Pocket area too small for this tool');
        continue;
      }

      for (const z of zPasses) {
        moves.push({ type: 'rapid', x: clearPasses[0][0].x, y: clearPasses[0][0].y, z: safeZ });
        moves.push({ type: 'feed',  x: clearPasses[0][0].x, y: clearPasses[0][0].y, z, f: plungeR });
        for (let pi = 0; pi < clearPasses.length; pi++) {
          const pass = clearPasses[pi];
          if (!pass || pass.length < 2) continue;
          if (pi > 0) {
            moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: safeZ });
            moves.push({ type: 'feed',  x: pass[0].x, y: pass[0].y, z, f: plungeR });
          }
          for (let i = 1; i < pass.length; i++) {
            moves.push({ type: 'feed', x: pass[i].x, y: pass[i].y, z, f: feedRate });
          }
        }
        const lastPass = clearPasses[clearPasses.length - 1];
        moves.push({ type: 'rapid', x: lastPass[lastPass.length - 1].x, y: lastPass[lastPass.length - 1].y, z: safeZ });
      }
    }
  } else {
    // Engraved or Outlined: trace each closed contour at depth
    for (const group of glyphGroups) {
      for (const rawContour of group) {
        if (rawContour.length < 3) continue;

        let contour = rawContour;
        if (mode === 'outlined') {
          // Inset by toolR so cutting edge follows the letter boundary exactly
          const ccw = isClockwise(rawContour) ? [...rawContour].reverse() : rawContour;
          const offset = offsetPolyline(ccw, toolR, true)[0];
          if (offset?.length >= 3) contour = offset;
        }

        moves.push({ type: 'rapid', x: contour[0].x, y: contour[0].y, z: safeZ });
        for (const z of zPasses) {
          moves.push({ type: 'feed', x: contour[0].x, y: contour[0].y, z, f: plungeR });
          for (let i = 1; i < contour.length; i++) {
            moves.push({ type: 'feed', x: contour[i].x, y: contour[i].y, z, f: feedRate });
          }
          moves.push({ type: 'feed', x: contour[0].x, y: contour[0].y, z, f: feedRate });
        }
        moves.push({ type: 'rapid', x: contour[0].x, y: contour[0].y, z: safeZ });
      }
    }
  }

  return { moves, warnings, contours: allContours };
}

// â”€â”€ 3D Raster (STL surface â€” ball-nose drop cutter) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// For a ball-nose cutter of radius R at (cx, cy), every heightmap cell
// (px, py, h) within lateral distance d < R forces the ball centre up to at
// least h + sqrt(RÂ²-dÂ²).  The max over all such cells, minus R, gives the
// gouge-free tool-tip Z.  When R=0 this degenerates to a nearest-cell lookup.
function dropCutterZ(cx, cy, toolRadius, heights, gridW, gridH, minX, maxX, minY, maxY) {
  const dxCell = (maxX - minX) / (gridW - 1);
  const dyCell = (maxY - minY) / (gridH - 1);
  const R  = toolRadius;
  const R2 = R * R;

  const colC = (cx - minX) / dxCell;
  const rowC = (cy - minY) / dyCell;

  if (R === 0) {
    const col = Math.max(0, Math.min(gridW - 1, Math.round(colC)));
    const row = Math.max(0, Math.min(gridH - 1, Math.round(rowC)));
    return heights[row * gridW + col];
  }

  const colSpan = Math.ceil(R / dxCell);
  const rowSpan = Math.ceil(R / dyCell);
  const colLo = Math.max(0,        Math.floor(colC - colSpan));
  const colHi = Math.min(gridW - 1, Math.ceil(colC + colSpan));
  const rowLo = Math.max(0,        Math.floor(rowC - rowSpan));
  const rowHi = Math.min(gridH - 1, Math.ceil(rowC + rowSpan));

  let ballCentreZ = -Infinity;

  for (let row = rowLo; row <= rowHi; row++) {
    const wy = minY + row * dyCell;
    const dy = wy - cy;
    const dy2 = dy * dy;
    if (dy2 >= R2) continue;                       // entire row outside circle

    for (let col = colLo; col <= colHi; col++) {
      const wx = minX + col * dxCell;
      const dx = wx - cx;
      const d2 = dx * dx + dy2;
      if (d2 >= R2) continue;                      // outside circle

      const required = heights[row * gridW + col] + Math.sqrt(R2 - d2);
      if (required > ballCentreZ) ballCentreZ = required;
    }
  }

  if (ballCentreZ === -Infinity) {
    // Fallback: no cells inside circle
    const col = Math.max(0, Math.min(gridW - 1, Math.round(colC)));
    const row = Math.max(0, Math.min(gridH - 1, Math.round(rowC)));
    return heights[row * gridW + col] - R;
  }

  return ballCentreZ - R;   // tip = centre - R
}

// Boustrophedon raster in one axis.
// axis='x' â†’ lines run along X, stepping in Y; axis='y' â†’ lines along Y, stepping in X.
function rasterLines(heightmap, rParams, axis) {
  const { heights, gridW, gridH, minX, maxX, minY, maxY } = heightmap;
  const toolRadius = (rParams.toolDiameter ?? 6.35) / 2;
  const stepover   = rParams.stepover   ?? 2;
  const safeZ      = rParams.safeZ      ?? 5;
  const feedRate   = rParams.feedRate   ?? 1500;
  const plungeRate = rParams.plungeRate ?? 500;
  const zOffset    = rParams.zOffset    ?? 0;

  function tipZ(x, y) {
    return dropCutterZ(x, y, toolRadius, heights, gridW, gridH, minX, maxX, minY, maxY) + zOffset;
  }

  const moves = [];
  let lineIdx = 0;

  if (axis === 'y') {
    // Lines run along Y, stepping in X
    const yStep = (maxY - minY) / (gridH - 1);
    for (let x = minX; x <= maxX + 1e-6; x += stepover) {
      const px  = Math.min(x, maxX);
      const rev = lineIdx % 2 === 1;
      const yStart = rev ? maxY : minY;
      const yEnd   = rev ? minY : maxY;
      const yDir   = rev ? -1   : 1;
      const ys = [yStart];
      for (let y = yStart + yDir * yStep; rev ? y >= yEnd - 1e-6 : y <= yEnd + 1e-6; y += yDir * yStep)
        ys.push(Math.max(minY, Math.min(maxY, y)));
      if (Math.abs(ys[ys.length - 1] - yEnd) > 1e-6) ys.push(yEnd);
      moves.push({ type: 'rapid', x: px, y: ys[0],             z: safeZ });
      moves.push({ type: 'feed',  x: px, y: ys[0],             z: tipZ(px, ys[0]), f: plungeRate });
      for (let i = 1; i < ys.length; i++)
        moves.push({ type: 'feed', x: px, y: ys[i],            z: tipZ(px, ys[i]), f: feedRate });
      moves.push({ type: 'rapid', x: px, y: ys[ys.length - 1], z: safeZ });
      lineIdx++;
      if (px >= maxX) break;
    }
  } else {
    // Lines run along X (default), stepping in Y
    const xStep = (maxX - minX) / (gridW - 1);
    for (let y = minY; y <= maxY + 1e-6; y += stepover) {
      const py  = Math.min(y, maxY);
      const rev = lineIdx % 2 === 1;
      const xStart = rev ? maxX : minX;
      const xEnd   = rev ? minX : maxX;
      const xDir   = rev ? -1   : 1;
      const xs = [xStart];
      for (let x = xStart + xDir * xStep; rev ? x >= xEnd - 1e-6 : x <= xEnd + 1e-6; x += xDir * xStep)
        xs.push(Math.max(minX, Math.min(maxX, x)));
      if (Math.abs(xs[xs.length - 1] - xEnd) > 1e-6) xs.push(xEnd);
      moves.push({ type: 'rapid', x: xs[0],             y: py, z: safeZ });
      moves.push({ type: 'feed',  x: xs[0],             y: py, z: tipZ(xs[0], py), f: plungeRate });
      for (let i = 1; i < xs.length; i++)
        moves.push({ type: 'feed', x: xs[i],            y: py, z: tipZ(xs[i], py), f: feedRate });
      moves.push({ type: 'rapid', x: xs[xs.length - 1], y: py, z: safeZ });
      lineIdx++;
      if (py >= maxY) break;
    }
  }

  return moves;
}

// Generate a 3D raster toolpath over a pre-computed STL heightmap.
// Supports optional rough pass (large stepover + Z allowance) followed by
// finish pass (tight stepover following the actual surface).
// direction: 'x' | 'y' | 'both' (crosshatch â€” runs both axes in sequence)
export function generateSTLRaster(heightmap, params) {
  const moves = [];

  if (params.roughEnabled) {
    const roughParams = {
      ...params,
      stepover:  params.roughStepover  ?? Math.max((params.stepover ?? 2) * 3, 6),
      zOffset:   (params.zOffset ?? 0) + (params.roughAllowance ?? 1),
      feedRate:  params.roughFeedRate  ?? params.feedRate,
    };
    const dir = params.direction ?? 'x';
    if (dir === 'both') {
      moves.push(...rasterLines(heightmap, roughParams, 'x'));
      moves.push(...rasterLines(heightmap, roughParams, 'y'));
    } else {
      moves.push(...rasterLines(heightmap, roughParams, dir));
    }
  }

  if (params.finishEnabled !== false) {
    // Use a separate finish tool diameter if one was resolved (from finishToolId).
    const finishDia = params.finishToolDiameter ?? params.toolDiameter;
    const finishParams = finishDia !== params.toolDiameter
      ? { ...params, toolDiameter: finishDia }
      : params;
    const dir = params.direction ?? 'x';
    if (dir === 'both') {
      moves.push(...rasterLines(heightmap, finishParams, 'x'));
      moves.push(...rasterLines(heightmap, finishParams, 'y'));
    } else {
      moves.push(...rasterLines(heightmap, finishParams, dir));
    }
  }

  return { moves };
}
