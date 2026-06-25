// CAM Toolpath Engine - all 2.5D operations

import { offsetPolyline, generatePocketOffsets, generateRestMachiningPasses, generateRasterPasses, polygonArea, isClockwise, clipPolygonToRegion, stripClose, pointInPolygon, differencePolygons } from './offset.js';
import { circleToPoints, arcToPoints, polylineToPoints } from '../dxf/parser.js';

// ── Entry point ───────────────────────────────────────────────────────────────

// Compute approximate medial axis (skeleton) of V-carve shapes for visualization.
// Returns {polylines: [[{x,y},...], ...]} — closed polylines at several erosion
// depth fractions.  Early fractions expose thin stroke slivers; late fractions
// converge on the medial axis of each filled region / hole annulus.
export function computeVCarveMedialAxis(op, entities) {
  if (!op.selectedIds?.length) return { polylines: [] };
  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { polylines: [] };

  const allProfiles = buildPocketProfiles(selected);
  if (!allProfiles.length) return { polylines: [] };

  allProfiles.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));

  const shapeGroups = [];
  for (const rawProfile of allProfiles) {
    const profile = isClockwise(rawProfile) ? [...rawProfile].reverse() : rawProfile;
    let placed = false;
    for (const group of shapeGroups) {
      if (profile.some(pt => pointInPolygon(pt, group.outer))) {
        group.holes.push(profile);
        placed = true;
        break;
      }
    }
    if (!placed) shapeGroups.push({ outer: profile, holes: [] });
  }

  const SKEL_STEP = 0.3; // mm — coarser than toolpath ring step; fast enough for UI
  const polylines = [];

  for (const { outer, holes } of shapeGroups) {
    if (Math.abs(polygonArea(outer)) < SKEL_STEP * SKEL_STEP * 4) continue;

    // Collect the eroded ring-sets at every step until the region collapses.
    const allRings = [];
    for (let i = 1; i <= 2000; i++) {
      const d = i * SKEL_STEP;
      const shrunkOuter = offsetPolyline(outer, d, true);
      if (!shrunkOuter || !shrunkOuter.length) break;

      const expandedHoles = holes.flatMap(h => offsetPolyline(h, -d, true));
      const validRings = expandedHoles.length > 0
        ? shrunkOuter.flatMap(r => differencePolygons(r, expandedHoles))
        : shrunkOuter;

      if (!validRings || !validRings.length) break;
      allRings.push(validRings);
    }

    const n = allRings.length;
    if (n === 0) continue;

    // Emit rings at a spread of erosion fractions so the user can see:
    //  - early fractions: stroke regions that collapse first (thin strokes visible)
    //  - late fractions: innermost rings converging on the medial axis
    const fractions = [0.15, 0.35, 0.55, 0.75, 0.9, 1.0];
    const emitted = new Set();
    for (const frac of fractions) {
      const idx = Math.min(n - 1, Math.floor(frac * n));
      if (emitted.has(idx)) continue;
      emitted.add(idx);
      for (const ring of allRings[idx]) {
        const pts = stripClose([...ring]);
        if (pts.length >= 2) polylines.push([...pts, pts[0]]);
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
    case 'dogbone':       return generateDogbone(operation, entities);
    case 'text':          return generateText(operation, entities);
    default:             return { moves: [], warnings: ['Unknown operation: ' + type] };
  }
}

// ── Tab engine ────────────────────────────────────────────────────────────────

// Returns evenly-spaced tab centre t-values [0,1) for automatic placement.
export function computeAutoTabPositions(tabCount) {
  return Array.from({ length: tabCount }, (_, i) => (i + 0.5) / tabCount);
}

// Insert hold-down tab Z-lifts into one Z-pass around a closed contour.
//
// Assumes the caller has already moved to pts[0] at cutZ (via plunge or ramp).
// Returns feed moves covering pts[1]…pts[n-1]…close-to-pts[0], with Z shaped
// by tabProfile: 'flat' (step plateau), 'dmd' (sin² curve), 'triangle' (ramp).
//
// tabTValues : t ∈ [0,1) — arc-fraction positions of tab centres
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
    // Convert t-values → sorted entering/leaving arc-length events.
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

  // Profiled tab: DMD Curve (sin²) or Triangle
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

// ── Contour ───────────────────────────────────────────────────────────────────

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
      // keepDown transitions are seamless — the closed loop always returns to P0.
      const passProfile = (p.climb === 'both' && zi % 2 === 1 && contourPts.length > 1)
        ? [contourPts[0], ...[...contourPts].slice(1).reverse()]
        : contourPts;

      if (zi === 0 || !p.keepDown || !closed) {
        moves.push(...buildLeadIn(passProfile, p.topZ ?? 0, z, safeZ, resolvedLeadIn, p.rampAngle || 3, leadInArcR, p.feedRate || 1500, p.plungeRate || 500, cutSide));
      } else {
        // Keep down: tool is at passProfile[0] (always contourPts[0]) — just plunge deeper
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

// ── Pocket ────────────────────────────────────────────────────────────────────

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
  const islandExclusions = islandProfiles.map((island, idx) => {
    const ccw = isClockwise(island) ? [...island].reverse() : island;
    const expanded = offsetPolyline(ccw, -toolR, true)[0];
    const result = expanded && expanded.length >= 3 ? expanded : ccw;
    console.log(`[DBG pocket] island[${idx}] pts=${island.length} cw=${isClockwise(island)} expanded=${expanded?.length ?? 'FAIL'} exclusion_pts=${result.length}`);
    return result;
  });
  console.log(`[DBG pocket] profiles=${profiles.length} outerArea=${polygonArea(outerProfile).toFixed(1)} islands=${islandExclusions.length} cutSide=${p.cutSide}`);
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

      for (let pi = 0; pi < orderedPasses.length; pi++) {
        // For 'both': alternate climb/conventional on each successive ring pass
        const pass = (p.climb === 'both' && pi % 2 === 1) ? [...orderedPasses[pi]].reverse() : orderedPasses[pi];
        if (!pass || pass.length < 2) continue;
        if (pi === 0) {
          // buildLeadIn left us near pass start inside the already-cut area — short hop is safe
          moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: z + 0.5 });
        } else {
          // Islands: must clear island walls (topZ) unless keepDown is explicitly set.
          // No islands: concentric rings share the floor, z+0.5 is always safe.
          const retractZ = (hasIslands && !p.keepDown) ? topZ : z + 0.5;
          moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: retractZ });
        }
        moves.push({ type: 'feed', x: pass[0].x, y: pass[0].y, z, f: plungeRate });
        for (let i = 1; i < pass.length; i++) {
          moves.push({ type: 'feed', x: pass[i].x, y: pass[i].y, z, f: feedRate });
        }
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

// ── Adaptive ──────────────────────────────────────────────────────────────────

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

// ── Face ──────────────────────────────────────────────────────────────────────

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

// ── Drill ─────────────────────────────────────────────────────────────────────

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

// ── Bore ──────────────────────────────────────────────────────────────────────

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

// ── Circular Pocket ───────────────────────────────────────────────────────────

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

// ── Engrave / Trace ───────────────────────────────────────────────────────────

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

// ── Slot ──────────────────────────────────────────────────────────────────────

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

// ── Chamfer ───────────────────────────────────────────────────────────────────

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

// ── Thread ────────────────────────────────────────────────────────────────────

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

// ── Tapered Pocket / Tapered Plug ────────────────────────────────────────────
//
// Each operation has four independently-enabled passes:
//   Taper Contour  — V-bit traces the exact profile at full depth (defines walls)
//   Taper Cleanup  — V-bit concentric clearing of floor area near walls
//   Detail Endmill — small endmill clears medium-detail areas
//   Bulk Endmill   — large endmill removes remaining bulk
//
// cutSide 'inside'  (pocket default): clears inside the profile boundary.
// cutSide 'outside' (plug default):   clears outside the profile boundary.
//   For outside cuts the taper-contour tip is offset outward by depth×tan(halfAngle)
//   so the taper wall intersects the profile edge exactly at the top surface.
//
// Plug raises the effective topZ by fitTolerance/tan(halfAngle) so the plug
// engages the pocket walls fractionally higher, leaving a controlled fit gap.
//
// Wall-clearance formula used by all concentric-clearing passes:
//   wallLeave = depth × tan(halfAngle) + wallStock
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

  // Strip closing points before centroid computation — polylineToPoints adds
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

// ── V-Carve ───────────────────────────────────────────────────────────────────
//
// Generates inward-offset concentric passes, each at the depth dictated by the
// V-bit geometry.  For a V-bit with half-angle α and tip radius r, a pass at
// offset distance d from the nearest boundary cuts at:
//
//   h = clamp( (d - r) / tan(α) ,  flatDepth, maxDepth )
//
// This is identical to the Tapered Pocket per-vertex depth formula, applied to
// every ring instead of every contour vertex.  Rings are generated with the
// same Clipper offsetPolyline used by 2D Pocket.
//
// Move count is bounded by (tipRadius + maxDepth·tan(α)) / XY_STEP rings, so
// even large shapes with deep settings stay within a few hundred passes.
function generateVCarve(op, entities, context = {}) {
  const moves = [], warnings = [];
  const p = op.params;

  const halfAngleDeg = Math.max(1, Math.min(89, p.halfAngle ?? 15));
  const halfAngleRad = halfAngleDeg * Math.PI / 180;
  const tanAngle     = Math.tan(halfAngleRad);
  const tipRadius    = (p.tipDiameter ?? 0) / 2;
  const maxDepth     = Math.abs(p.maxDepth ?? 15);
  const flatDepth    = Math.max(0, Math.min(maxDepth, p.flatDepth ?? 0));
  const safeZ        = p.safeZ ?? 25;
  const topZ         = p.topZ ?? 0;
  const feedRate     = p.feedRate ?? 1500;
  const plungeRate   = p.plungeRate ?? 300;
  const depthPerPass = Math.max(0.01, p.depthPerPass ?? maxDepth); // default = single pass

  // Require explicit entity assignment — the fallback to all entities in
  // getSelectedEntities would pick up reference geometry (bounding boxes, etc.)
  if (!op.selectedIds?.length) return { moves: [], warnings: ['Select letter/shape entities for this operation (use Assign button)'] };

  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { moves: [], warnings: ['No entities selected'] };

  const allProfiles = buildPocketProfiles(selected);
  if (!allProfiles.length) return { moves: [], warnings: ['No closed profiles found — select a closed shape'] };

  // Sort by area descending: largest polygon = outer boundary; smaller ones inside
  // it are holes (counter-spaces in letters like 'a', 'd', 'e', 'o').
  allProfiles.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));

  // Group into shape groups: each outer profile collects any profiles whose
  // points lie inside it as holes.  Unplaced profiles start new groups.
  const shapeGroups = [];
  for (const rawProfile of allProfiles) {
    const profile = isClockwise(rawProfile) ? [...rawProfile].reverse() : rawProfile;
    let placed = false;
    for (const group of shapeGroups) {
      if (profile.some(pt => pointInPolygon(pt, group.outer))) {
        group.holes.push(profile);
        placed = true;
        break;
      }
    }
    if (!placed) shapeGroups.push({ outer: profile, holes: [] });
  }

  // XY spacing between successive offset rings.  0.2 mm gives smooth depth
  // transitions; the loop always terminates once the valid region collapses.
  const XY_STEP = 0.2;
  const numPasses = Math.max(1, Math.ceil(maxDepth / depthPerPass));

  for (const { outer, holes } of shapeGroups) {
    if (Math.abs(polygonArea(outer)) < XY_STEP * XY_STEP * 4) {
      warnings.push('Profile too small to V-carve');
      continue;
    }

    let anyMoves = false;

    for (let pass = 1; pass <= numPasses; pass++) {
      const passMaxH = Math.min(depthPerPass * pass, maxDepth);
      const prevMaxH = depthPerPass * (pass - 1);

      // Jump directly to the first ring where this pass needs to cut.
      const minD   = Math.max(XY_STEP, prevMaxH * tanAngle + tipRadius);
      const startI = Math.max(1, Math.ceil(minD / XY_STEP));

      let prevHThis = -Infinity;

      for (let i = startI; i <= 5000; i++) {
        const d      = i * XY_STEP;
        const rawH   = d <= tipRadius ? 0 : (d - tipRadius) / tanAngle;
        const hFinal = Math.max(flatDepth, Math.min(maxDepth, rawH));

        // Skip rings already cut at full final depth by a previous pass.
        if (hFinal <= prevMaxH) continue;

        const hThis = Math.min(passMaxH, hFinal);

        // Shrink outer boundary inward by d — points at distance ≥ d from outer.
        const shrunkOuter = offsetPolyline(outer, d, true);
        if (!shrunkOuter || shrunkOuter.length === 0) break; // shape fully collapsed

        // Grow each hole outward by d — exclusion zone around each hole boundary.
        // differencePolygons subtracts these from each shrunk ring; Clipper also
        // returns the hole inner boundary as a CW path (reversed → CCW by
        // differencePolygons), so both sides of the groove are traced automatically.
        const expandedHoles = holes.flatMap(hole => offsetPolyline(hole, -d, true));

        const validRings = expandedHoles.length > 0
          ? shrunkOuter.flatMap(r => differencePolygons(r, expandedHoles))
          : shrunkOuter;

        if (!validRings || validRings.length === 0) break; // valid region collapsed

        const atCap = hThis >= passMaxH && prevHThis >= passMaxH;
        let gotAny = false;

        for (const ring of validRings) {
          if (!ring || ring.length < 3) continue;
          const pts = stripClose([...ring]);
          if (pts.length < 3) continue;

          gotAny = true;
          anyMoves = true;
          const z = topZ - hThis;

          moves.push({ type: 'rapid', x: pts[0].x, y: pts[0].y, z: safeZ });
          moves.push({ type: 'feed',  x: pts[0].x, y: pts[0].y, z, f: plungeRate });
          for (let j = 1; j < pts.length; j++) {
            moves.push({ type: 'feed', x: pts[j].x, y: pts[j].y, z, f: feedRate });
          }
          moves.push({ type: 'feed', x: pts[0].x, y: pts[0].y, z, f: feedRate });
        }

        if (!gotAny || atCap) break;
        prevHThis = hThis;
      }
    }

    if (!anyMoves) {
      warnings.push('Profile produced no V-carve passes — check max depth and angle');
    }
  }

  // Final lift to safe Z.
  if (moves.length) {
    const last = moves[moves.length - 1];
    moves.push({ type: 'rapid', x: last.x, y: last.y, z: safeZ });
  }

  return { moves, warnings };
}

function generateTaperedPocket(op, entities, context = {}) {
  const p = op.params;
  const warnings = [];
  // Require explicit entity selection — falling back to all entities risks picking
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
  return buildTaperedPasses(selected, plugTopZ, depth, safeZ, plugParams, warnings, stockBound);
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
  // clearing).  buildPocketClearing / buildPlugClearing internally sort by area so the
  // largest profile becomes the outer clearing boundary and smaller ones become island
  // exclusions — no need to split them here.
  const allProfiles = buildPocketProfiles(selected);
  allProfiles.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  const partProfiles = allProfiles;
  const effectiveClipBound = stockBound;

  const subToolpaths = [];

  if (tc.enabled !== false) {
    const tcRad = Math.max(0.5, (tc.angle || 10) / 2) * Math.PI / 180;
    subToolpaths.push({
      name: 'Taper Contour', color: '#ff8844',
      toolKey:  tc.toolId ?? 'taper',
      toolDesc: `Taper bit — tip ⌀${tc.tipDia || 0.5}mm  ${tc.angle || 10}° half-angle`,
      rpm: tc.rpm || 24000,
      moves: buildTaperTrace(selected, topZ, depth, safeZ, tc.feed || 1000, tc.plunge || 300, tcRad, cutSide, (tc.tipDia || 0) / 2, p.sharpCornerAngle ?? 180, tc.leadInStyle || 'plunge', tc.leadInRampAngle || 3, tc.leadInArcRadius || 0, partProfiles),
    });
  }

  if (tk.enabled !== false) {
    const tkRad = Math.max(0.5, (tk.angle || 10) / 2) * Math.PI / 180;
    const tipR  = (tk.tipDia || 0.5) / 2;
    subToolpaths.push({
      name: 'Taper Cleanup', color: '#ffcc44',
      toolKey:  tk.toolId ?? 'taper',
      toolDesc: `Taper bit — tip ⌀${tk.tipDia || 0.5}mm  ${tk.angle || 10}° half-angle`,
      rpm: tk.rpm || 24000,
      // Single contour trace at final wall position — not a clearing pass.
      // Reaches all profiles (including inner contours) unlike clearFn which treats
      // inner profiles as island exclusions.
      moves: buildTaperTrace(selected, topZ, depth, safeZ,
        tk.feed || 1000, tk.plunge || 300, tkRad, cutSide, tipR,
        p.sharpCornerAngle ?? 180, tk.leadInStyle || 'plunge', tk.leadInRampAngle || 3, tk.leadInArcRadius || 0, partProfiles),
    });
  }

  if (de.enabled !== false) {
    const deR = (de.diameter || 1.5875) / 2;
    const deDepthPerPass = de.depthPerPass || de.diameter || 1.5875;
    const dePrevR = de.restMachining && (de.prevDiameter || 0) > 0 ? de.prevDiameter / 2 : 0;
    subToolpaths.push({
      name: 'Detail Endmill', color: '#44ff88',
      toolKey:  de.toolId ?? 'detailEndmill',
      toolDesc: `Endmill ⌀${de.diameter || 1.5875}mm`,
      rpm: de.rpm || 18000,
      moves: clearFn(selected, topZ, depth, safeZ,
        deR, deDepthPerPass, de.wallStock || 0.254, de.feed || 800, de.plunge || 300,
        wallRad, 'Detail Endmill', warnings, dePrevR, effectiveClipBound, de.leadInStyle || 'plunge', de.leadInArcRadius || 0, partProfiles),
    });
  }

  if (be.enabled !== false) {
    const beR = (be.diameter || 6.35) / 2;
    const beDepthPerPass = be.depthPerPass || be.diameter || 6.35;
    const bePrevR = be.restMachining && (be.prevDiameter || 0) > 0 ? be.prevDiameter / 2 : 0;
    subToolpaths.push({
      name: 'Bulk Endmill', color: '#4499ff',
      toolKey:  be.toolId ?? 'bulkEndmill',
      toolDesc: `Endmill ⌀${be.diameter || 6.35}mm`,
      rpm: be.rpm || 18000,
      moves: clearFn(selected, topZ, depth, safeZ,
        beR, beDepthPerPass, be.wallStock || 0.254, be.feed || 1500, be.plunge || 500,
        wallRad, 'Bulk Endmill', warnings, bePrevR, effectiveClipBound, be.leadInStyle || 'plunge', be.leadInArcRadius || 0, partProfiles),
    });
  }

  const moves = subToolpaths.flatMap(st => st.moves);
  return { moves, subToolpaths, warnings };
}

// ── Corner-relief helpers ─────────────────────────────────────────────────────

// Cumulative arc lengths for a closed polygon (no closing point assumed).
function cumArcLen(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++)
    c.push(c[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return c;
}

// For each contour point, compute the inscribed circle radius: the largest circle
// centred at (P + r·n_P) — where n_P is the inward normal at P — that fits inside
// the polygon without crossing any non-adjacent boundary segment.
//
// Apollonius formula for segment j with inward normal n_j:
//   r = L_P / (1 − n_P · n_j)
// where L_P = n_j · (P − A) is the signed distance from P to the line of segment j.
// When n_P · n_j ≈ 1 (nearly parallel, same direction — dense tessellation neighbours),
// the denominator collapses to ≈ 0 and the constraint is skipped automatically.
// Endpoint constraints handle cases where the circle centre projects past a segment end.
//
// Used by:  maxDepth = (r_inscribed − tipRadius) / tan(halfAngle)
function computeContourLocalWidths(rawPts) {
  const cw  = isClockwise(rawPts);
  const pts = cw ? [...rawPts].reverse() : rawPts;
  const n   = pts.length;
  const out = new Array(n).fill(Infinity);

  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];

    // Inward normal at vertex i: average adjacent-edge tangents, rotate 90° CCW.
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

      // Inward normal of segment j (CCW polygon: rotate edge vector 90° CCW).
      const ex = bx - ax, ey = by - ay;
      const el = Math.hypot(ex, ey);
      if (el < 1e-10) continue;
      const njx = -ey / el, njy = ex / el;

      // Signed distance from curr to the line of segment j (positive = inside polygon).
      const lp = njx * (curr.x - ax) + njy * (curr.y - ay);
      if (lp <= 0) continue;  // curr outside this half-plane — non-convex artefact, skip

      // Apollonius constraint: r = lp / (1 − n_P · n_j).
      // denom → 0 when walls are nearly co-directional (dense tessellation neighbours) — skip.
      // Guard: also verify the inscribed-circle tangent point falls within the actual
      // segment (not just on its infinite line extension).  A segment whose LINE passes
      // close to P but whose extents are far away (e.g. a handle wall above a pan body
      // point) would otherwise produce a falsely tiny r.
      const dot   = nPx * njx + nPy * njy;
      const denom = 1 - dot;
      if (denom > 1e-6) {
        const r = lp / denom;
        if (r > 0 && r < rMin) {
          // Inscribed circle centre Q = P + r·n_P; tangent point T = Q − r·n_j.
          const qx = curr.x + r * nPx, qy = curr.y + r * nPy;
          const tx = qx - r * njx,     ty = qy - r * njy;
          // Parameterise T along segment j: s ∈ [0,1] means T is within the segment.
          const s = ((tx - ax) * ex + (ty - ay) * ey) / (el * el);
          if (s >= 0 && s <= 1) rMin = r;
        }
      }

      // Endpoint constraints: prevent the inscribed-circle centre from flying past
      // an endpoint vertex into open space.  For vertex V: dist(centre, V) ≥ r
      // simplifies to r ≤ |P−V|² / (2·|(P−V)·n_P|) when (P−V)·n_P < 0.
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
//   1. min-filter — never exceed the tightest local constraint.
//   2. box-average — soften abrupt transitions.
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

// ─────────────────────────────────────────────────────────────────────────────

// Trace selected contours with the taper bit, applying adaptive Z (corner relief)
// so the bit lifts in narrow features where the taper body would otherwise gouge
// the opposite wall.  Formula: maxDepth = (r_inscribed - tipRadius) / tan(halfAngle)
//
// cutSide 'outside': tip is offset outward by depth × tan(halfAngle) so the taper
// wall intersects the profile edge exactly at the top surface.
// Corner-relief taper contour pass.
//
// At every convex polygon corner (interior angle < 180°) the bit ramps out
// along the outward angle bisector while rising from floor to surface, then
// retraces back to full depth.  This creates the correct taper-wall geometry
// at inside corners so a pocket and plug cut from the same profile mate.
//
// Formula:  tan(φ) = sin(α) / tan(θ)
//   φ = ramp angle from horizontal
//   α = half the interior corner angle
//   θ = bit half-angle (tcRad)
//   ramp distance = depth * tan(θ) / sin(α)
//
// Concave arc sections whose radius is smaller than the bit's taper footprint
// (bitRadius = tipRadius + depth×tanAlpha) are handled separately: Z is lifted
// so the bit's contact radius at the surface matches the arc radius:
//   Z = topZ − (arcRadius − tipRadius) / tanAlpha
// The local arc radius is estimated from the circumradius of consecutive
// tessellated triplets; large smooth curves have circumradius >> bitRadius and
// are left at full depth unchanged.
//
// MIN_CORNER_TURN guards the bisector ramp so it fires only at genuine polygon
// corners (single vertex with a large turn) and not at the fine steps of a
// tessellated smooth arc.
//
// For an outside (plug) cut the trace path is pre-offset inward by
// depth*tan(θ) so the taper body at the surface aligns with the profile
// boundary — identical ramp geometry then produces mating walls.
//
// tipRadius: tip flat radius (0 for a pointed V-bit).
// sharpCornerAngle: only interior angles strictly below this value (degrees)
//   trigger the bisector ramp.  180° = all convex corners (Fusion default);
//   lower values (e.g. 170°) suppress ramps at near-straight tessellation joints.
function buildTaperTrace(entities, topZ, depth, safeZ, feedRate, plungeRate, tcRad, cutSide, tipRadius = 0, sharpCornerAngle = 180, leadInStyle = 'plunge', leadInRampAngle = 3, leadInArcRadius = 0, prebuiltProfiles = null) {
  const moves     = [];
  const tanAlpha  = Math.tan(tcRad);
  const floorZ    = topZ - depth;
  const bitRadius = tipRadius + depth * tanAlpha;
  const traceOffset = cutSide === 'outside' ? -(depth * tanAlpha) : 0;

  // Convert the user-facing interior-angle threshold to a minimum exterior turn.
  // e.g. sharpCornerAngle=170° → only turns >10° trigger a ramp.
  // Floor at 12° so arc tessellation vertices (72-pt circles = 5°/step,
  // 36-pt arcs = 10°/step) never trigger corner ramps regardless of sharpCornerAngle.
  const MIN_CORNER_TURN = Math.max(12 * Math.PI / 180, (180 - sharpCornerAngle) * Math.PI / 180);

  const isOutside = cutSide === 'outside';
  const profiles = prebuiltProfiles ?? buildPocketProfiles(entities);

  // Identify the outermost profile. Ring-boss counters (nested inside the outer profile)
  // get a flipped trace offset so the taper approaches from inside the hole. Separate
  // bosses (two circles apart) are NOT nested and are traced from the outside like the
  // outer profile — their offset must not be flipped.
  const outerProfileRef = profiles.length > 1
    ? [...profiles].sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)))[0]
    : profiles[0];
  const outerProfileCCW = isClockwise(outerProfileRef) ? [...outerProfileRef].reverse() : outerProfileRef;

  for (const rawProfile of profiles) {
    // Normalise winding to CCW before offsetting.  mirrorEntitiesX Y-flips the
    // polygon, reversing its winding to CW.  Clipper's ClipperOffset treats CW
    // paths as holes and applies the delta in the opposite direction, so a CW
    // input to offsetPolyline contracts where it should expand (and vice-versa),
    // placing the trace path on the wrong side of the profile.  Normalising
    // first ensures Clipper always sees a CCW outer boundary.
    const rawStripped = stripClose([...rawProfile]);
    if (rawStripped.length < 3) continue;
    const rawCCW = isClockwise(rawStripped) ? [...rawStripped].reverse() : rawStripped;

    // Detect ring-boss counter: an inner profile whose midpoint lies inside the outer profile.
    // Separate bosses (two circles apart) fail this test and use the standard outward offset.
    const isInnerProfile = profiles.length > 1 && rawProfile !== outerProfileRef;
    const testPt = rawCCW[Math.floor(rawCCW.length / 2)];
    const isNestedInner = isInnerProfile && isOutside && !!testPt && pointInPolygon(testPt, outerProfileCCW);

    // Ring-boss counters: flip offset so the taper approaches from inside the hole.
    // All other profiles (outer profile + separate bosses): standard outward offset.
    const profileTraceOffset = isNestedInner ? -traceOffset : traceOffset;

    const offsetResult = profileTraceOffset !== 0
      ? offsetPolyline(rawCCW, profileTraceOffset, true)[0]
      : null;
    // Nested ring-boss counters: if the inward offset collapses (hole too small for the taper),
    // skip rather than fall back to the raw boundary — the boundary fallback would trace the
    // boss ring wall and cut into the boss material.
    // All other profiles: fall back to rawCCW so the trace is never lost.
    const traceRaw = offsetResult ?? (isNestedInner ? null : rawCCW);
    if (!traceRaw || traceRaw.length < 2) continue;
    const ptsRaw = stripClose([...traceRaw]);
    if (ptsRaw.length < 3) continue;
    // offsetPolyline always returns CCW; the isClockwise guard is a safety net.
    const pts = isClockwise(ptsRaw) ? [...ptsRaw].reverse() : ptsRaw;
    const n   = pts.length;

    // Pre-compute per-vertex Z.  Tight arc vertices whose circumradius R < bitRadius
    // get lifted: Z = topZ − (R − tipRadius) / tanAlpha.
    // For pocket (inside cut) we lift at concave vertices (cross < 0).
    // For plug  (outside cut) we lift at convex vertices (cross > 0) because the
    // bit is on the outside and those arcs bulge toward it.
    // arcCross > 0 means "needs the lift check"; we compute R = la*lb*lac/(2*arcCross).
    const zAtPt = pts.map((P, i) => {
      if (tanAlpha < 1e-10) return floorZ;
      const Pprv = pts[(i - 1 + n) % n];
      const Pnxt = pts[(i + 1) % n];
      const ax = P.x - Pprv.x, ay = P.y - Pprv.y;
      const bx = Pnxt.x - P.x, by = Pnxt.y - P.y;
      const cross    = ax * by - ay * bx;
      const arcCross = isOutside ? cross : -cross;   // positive = candidate for lift
      if (arcCross <= 0) return floorZ;
      const la  = Math.hypot(ax, ay);
      const lb  = Math.hypot(bx, by);
      if (la < 1e-10 || lb < 1e-10) return floorZ;
      const lac = Math.hypot(ax + bx, ay + by);
      const R   = (la * lb * lac) / (2 * arcCross);
      if (!isFinite(R) || R >= bitRadius) return floorZ;
      const liftDepth = Math.max(0, (R - tipRadius) / tanAlpha);
      return topZ - liftDepth;
    });

    const arcR = leadInArcRadius || Math.max(0.5, tipRadius || 1);
    moves.push(...buildLeadIn(pts, topZ, zAtPt[0], safeZ, leadInStyle, leadInRampAngle, arcR, feedRate, plungeRate, cutSide));

    for (let i = 0; i < n; i++) {
      const P    = pts[i];
      const Pnxt = pts[(i + 1) % n];
      const Pprv = pts[(i - 1 + n) % n];

      const ax = P.x - Pprv.x, ay = P.y - Pprv.y;
      const bx = Pnxt.x - P.x, by = Pnxt.y - P.y;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);

      if (la > 1e-10 && lb > 1e-10 && tanAlpha > 1e-10) {
        const ux1 = ax / la, uy1 = ay / la;
        const ux2 = bx / lb, uy2 = by / lb;
        const cross       = ux1 * uy2 - uy1 * ux2;   // normalised; >0 = convex (CCW)
        // Pocket (inside):  ramp at convex corners  (cross > 0, bit crowds outside the turn)
        // Plug   (outside): ramp at concave corners (cross < 0, bit crowds inside the turn)
        const cornerCross = isOutside ? -cross : cross;

        if (cornerCross > 1e-6) {
          const turnAngle = Math.atan2(cornerCross, ux1 * ux2 + uy1 * uy2);
          // Guard: only ramp at genuine polygon corners, not arc tessellation steps.
          if (turnAngle > MIN_CORNER_TURN) {
            const alpha    = (Math.PI - turnAngle) / 2;
            const sinAlpha = Math.sin(alpha);
            if (sinAlpha > 1e-6) {
              const rampDist = (depth * tanAlpha) / sinAlpha;
              // Pocket: outward bisector (rightNormal) pushes ramp away from CCW interior.
              // Plug:   inward bisector (leftNormal = negate rightNormal) pushes into stock.
              const s  = isOutside ? -1 : 1;
              const rx = s * (uy1 + uy2);
              const ry = s * (-ux1 - ux2);
              const rl = Math.hypot(rx, ry);
              if (rl > 1e-10) {
                const rampX = P.x + (rx / rl) * rampDist;
                const rampY = P.y + (ry / rl) * rampDist;
                moves.push({ type: 'feed', x: rampX, y: rampY, z: topZ,   f: feedRate });
                moves.push({ type: 'feed', x: P.x,   y: P.y,   z: floorZ, f: feedRate });
              }
            }
          }
        }
      }

      // Advance to next vertex; use pre-computed Z (lifted for tight concave arcs).
      moves.push({ type: 'feed', x: Pnxt.x, y: Pnxt.y, z: zAtPt[(i + 1) % n], f: feedRate });
    }

    moves.push({ type: 'rapid', x: pts[0].x, y: pts[0].y, z: safeZ });
  }
  return moves;
}

// Generic concentric pocket-clearing pass.
// Works for both V-bit cleanup (small toolR, single Z pass) and endmill passes.
//
//   toolR       — effective cutting radius for stepover / offset generation
//   depthPerPass — Z step between levels (pass full depth for single-level)
//   wallStock   — explicit standoff added on top of the taper geometry clearance
//   taperRad    — half-angle (rad) of the wall that defines clearance geometry
function buildPocketClearing(entities, topZ, depth, safeZ, toolR, depthPerPass, wallStock, feedRate, plungeRate, taperRad, passLabel, warnings, prevToolR = 0, stockBound = null, leadInStyle = 'plunge', leadInArcRadius = 0, prebuiltProfiles = null) {
  const moves     = [];
  const wallLeave = depth * Math.tan(taperRad) + wallStock;
  const inset     = toolR + wallLeave;
  const zPasses   = buildZPasses(topZ, depth, depthPerPass);

  // Profile extraction: chain individual LINE/ARC segments when selected
  // instead of a closed polyline, same logic as generatePocket.
  const profiles = prebuiltProfiles ?? buildPocketProfiles(entities);
  if (!profiles.length) return moves;

  profiles.sort((a, b) => polygonArea(b) - polygonArea(a));
  const islandProfiles = profiles.slice(1);

  // Normalise to CCW so a positive offset shrinks inward (generatePocketOffsets
  // does the same internally; doing it here keeps offsetPolyline correct too).
  const outerProfile = isClockwise(profiles[0]) ? [...profiles[0]].reverse() : profiles[0];

  // Use toolR for the outer boundary inset — identical to generatePocket.
  // Using the full (toolR + wallLeave) inset in a single offsetPolyline call
  // creates large spikes at concave arc junctions in complex shapes; toolR
  // keeps the offset small and spike-free.  Island exclusion zones still use
  // the full inset so the endmill stays clear of inner taper walls.
  const boundary = offsetPolyline(outerProfile, toolR, true)[0];
  if (!boundary || boundary.length < 4 || polygonArea(boundary) < toolR * toolR * Math.PI * 0.25) {
    warnings.push(`${passLabel}: contour too small for ⌀${(toolR * 2).toFixed(2)}mm tool`);
    return moves;
  }

  const islandExclusions = islandProfiles.map(island => {
    const ccw      = isClockwise(island) ? [...island].reverse() : island;
    const expanded = offsetPolyline(ccw, -inset, true)[0];
    return (expanded && expanded.length >= 3) ? expanded : ccw;
  });

  if (islandExclusions.length > 0) warnNarrowGaps(islandExclusions, boundary, toolR, warnings);
  const clearPasses = prevToolR > 0
    ? generateRestMachiningPasses(outerProfile, toolR, prevToolR, 0.45, islandExclusions)
    : generatePocketOffsets(boundary, toolR, 0.45, islandExclusions);
  if (!clearPasses.length) {
    if (islandExclusions.length === 0 && prevToolR === 0) {
      warnings.push(`${passLabel}: no clearing passes — contour too small after wall clearance`);
    }
    return moves;
  }

  const helixR = leadInArcRadius || toolR * 0.5;
  moves.push(...buildLeadIn(clearPasses[0], topZ, zPasses[0], safeZ, leadInStyle, 3, helixR, feedRate, plungeRate, 'inside'));

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

// Concentric clearing for outside cuts (tapered plug).
// Expands rings outward from the plug profile and clips each to the stock boundary,
// matching the 2D Pocket outside-boss approach. generatePocketOffsets is NOT used
// here because its island exclusion relies on a vertex-in-polygon check that fails
// when a large rectangular ring surrounds a central exclusion zone — the ring corners
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
  // no stock is configured). The stock boundary is used as-is for clipping — the
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
  //     each boss independently — neither boss is cut through.
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

// ── Helpers ───────────────────────────────────────────────────────────────────

// Warn when pre-expanded island exclusion zones overlap each other (gap between the raw
// island boundaries is less than twice the expansion amount — i.e. less than tool diameter
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
        warnings.push(`Gap between islands too small for ø${dia} mm tool — some areas will not be machined. Use a smaller tool or increase spacing.`);
        return;
      }
    }
  }
  // Island-to-boundary overflow check
  if (boundary) {
    for (const excl of exclusionZones) {
      if (excl.some(pt => !pointInPolygon(pt, boundary))) {
        warnings.push(`Island too close to pocket wall for ø${dia} mm tool — some areas will not be machined. Use a smaller tool or increase spacing.`);
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

// Quarter-circle tangential arc lead-in.  The tool approaches pts[0] along a 90° arc
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

  // Arc start A = center - R*T (90° before P in travel direction).
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
    default:         return null;
  }
}

function isEntityClosed(entity) {
  if (!entity) return false;
  if (entity.type === 'circle') return true;
  if (entity.type === 'arc') return false;
  if (entity.type === 'polyline') return entity.closed;
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
    .map(e => ({ pts: entityToProfile(e), used: false }))
    .filter(s => s.pts && s.pts.length >= 2);

  if (!segs.length) return null;

  const chain = [...segs[0].pts];
  segs[0].used = true;

  for (let pass = 0; pass < segs.length; pass++) {
    const tail = chain[chain.length - 1];
    let found = false;
    for (const seg of segs) {
      if (seg.used) continue;
      const head = seg.pts[0];
      const foot = seg.pts[seg.pts.length - 1];
      if (ptDist(tail, head) <= SNAP) {
        chain.push(...seg.pts.slice(1));
        seg.used = true; found = true; break;
      }
      if (ptDist(tail, foot) <= SNAP) {
        chain.push(...[...seg.pts].reverse().slice(1));
        seg.used = true; found = true; break;
      }
    }
    if (!found) break;
  }

  // Drop duplicate closing point if chain loops back to start
  const closeDist = chain.length > 1 ? ptDist(chain[0], chain[chain.length - 1]) : Infinity;
  const isClosed = closeDist <= SNAP;
  if (isClosed) chain.pop();
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

// ── Dogbone Fillets ──────────────────────────────────────────────────────────

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

// ── Text Engraving ─────────────────────────────────────────────────────────────

function generateText(op) {
  const moves = [], warnings = [];
  const p = op.params;

  if (!p.textContoursRel?.length) {
    return {
      moves: [],
      warnings: ['No text geometry — click "Generate Geometry" in the Text Engraving params'],
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

      // Inset outer by toolR → tool-centre travel boundary
      const boundary = offsetPolyline(outerCCW, toolR, true)[0];
      if (!boundary || boundary.length < 3) {
        warnings.push('Letter too small for this tool diameter');
        continue;
      }

      // Expand each hole outward by toolR → exclusion zone for tool centre
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
