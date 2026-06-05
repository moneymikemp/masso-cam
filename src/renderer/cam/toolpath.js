// CAM Toolpath Engine - all 2.5D operations

import { offsetPolyline, generatePocketOffsets, generateRasterPasses, polygonArea, isClockwise } from './offset.js';
import { circleToPoints, arcToPoints, polylineToPoints } from '../dxf/parser.js';

// ── Entry point ───────────────────────────────────────────────────────────────

export function generateToolpath(operation, entities) {
  const { type } = operation;
  switch (type) {
    case 'contour':   return generateContour(operation, entities);
    case 'pocket':    return generatePocket(operation, entities);
    case 'adaptive':  return generateAdaptive(operation, entities);
    case 'face':      return generateFace(operation, entities);
    case 'drill':     return generateDrill(operation, entities);
    case 'bore':      return generateBore(operation, entities);
    case 'circular':  return generateCircular(operation, entities);
    case 'engrave':   return generateEngrave(operation, entities);
    case 'trace':     return generateEngrave(operation, entities);
    case 'slot':      return generateSlot(operation, entities);
    case 'chamfer':      return generateChamfer(operation, entities);
    case 'thread':       return generateThread(operation, entities);
    case 'taperedinlay': return generateTaperedInlay(operation, entities);
    default:             return { moves: [], warnings: ['Unknown operation: ' + type] };
  }
}

// ── Contour ───────────────────────────────────────────────────────────────────

function generateContour(op, entities) {
  const moves = [], warnings = [];
  const p = op.params;
  const toolR = (p.toolDiameter || 6.35) / 2;
  const flip = p.flipSide ? -1 : 1;
  const offset = p.compensation === 'center' ? 0
    : (toolR + (p.stockToLeave || 0)) * (p.compensation === 'right' ? 1 : -1) * flip;

  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { moves: [], warnings: ['No entities selected'] };

  for (const entity of selected) {
    const profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;

    const closed = isEntityClosed(entity);
    let contourPts = profile;

    if (offset !== 0 && closed) {
      const offsets = offsetPolyline(profile, offset, true);
      if (offsets[0]?.length >= 3) contourPts = offsets[0];
    }

    const passes = buildZPasses(p.topZ ?? 0, p.totalDepth || 10, p.depthPerPass || 3);

    for (const z of passes) {
      moves.push({ type: 'rapid', x: contourPts[0].x, y: contourPts[0].y, z: p.safeZ || 25 });

      if (p.rampEntry && closed && contourPts.length > 2) {
        moves.push(...buildRampEntry(contourPts, p.topZ ?? 0, z, p.rampAngle || 3, p.feedRate || 1500, p.plungeRate || 500));
      } else {
        moves.push({ type: 'feed', x: contourPts[0].x, y: contourPts[0].y, z, f: p.plungeRate || 500 });
      }

      for (let i = 1; i < contourPts.length; i++) {
        moves.push({ type: 'feed', x: contourPts[i].x, y: contourPts[i].y, z, f: p.feedRate || 1500 });
      }
      if (closed) {
        moves.push({ type: 'feed', x: contourPts[0].x, y: contourPts[0].y, z, f: p.feedRate || 1500 });
      }
    }
    moves.push({ type: 'rapid', x: contourPts[0].x, y: contourPts[0].y, z: p.safeZ || 25 });
  }
  return { moves, warnings };
}

// ── Pocket ────────────────────────────────────────────────────────────────────

function generatePocket(op, entities) {
  const moves = [], warnings = [];
  const p = op.params;
  const toolDia = p.toolDiameter || 6.35;
  const toolR = toolDia / 2;
  const stepover = p.stepover || 0.45;
  const safeZ = p.safeZ || 25;
  const topZ = p.topZ ?? 0;
  const feedRate = p.feedRate || 1500;
  const plungeRate = p.plungeRate || 500;

  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { moves: [], warnings: ['No entities selected'] };

  // Build a profile for every selected entity; keep those with ≥ 3 points
  const profiles = selected
    .map(e => entityToProfile(e))
    .filter(prof => prof && prof.length >= 3);

  if (!profiles.length) return { moves: [], warnings: ['No valid closed entities selected'] };

  // Largest polygon = outer boundary; anything smaller inside it = island
  profiles.sort((a, b) => polygonArea(b) - polygonArea(a));
  const outerProfile = profiles[0];
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
  const islandExclusions = islandProfiles.map(island => {
    const ccw = isClockwise(island) ? [...island].reverse() : island;
    const expanded = offsetPolyline(ccw, -toolR, true)[0];
    return expanded && expanded.length >= 3 ? expanded : ccw;
  });

  const zPasses = buildZPasses(topZ, p.totalDepth || 10, p.depthPerPass || 3);

  for (const z of zPasses) {
    // Inset outer boundary by toolR (+ finish allowance when finishing)
    const boundaryOffset = +(toolR + (p.finishPass ? (p.finishAllowance || 0.2) : 0));
    const boundary = offsetPolyline(outerProfile, boundaryOffset, true)[0];

    if (!boundary || boundary.length < 4 || polygonArea(boundary) < toolR * toolR) {
      warnings.push('Shape too small for pocket after tool offset');
      continue;
    }

    // Generate concentric clearing passes, skipping any that enter an island
    const clearPasses = generatePocketOffsets(boundary, toolR, stepover, islandExclusions);

    if (clearPasses.length === 0 && islandExclusions.length === 0) {
      warnings.push('No clearing passes generated - pocket may be too small');
    }

    const sortedPasses = p.startFromCenter ? [...clearPasses].reverse() : clearPasses;

    if (sortedPasses.length > 0) {
      const startPt = sortedPasses[0][0];
      moves.push({ type: 'rapid', x: startPt.x, y: startPt.y, z: safeZ });
      moves.push({ type: 'feed', x: startPt.x, y: startPt.y, z, f: plungeRate });

      for (const pass of sortedPasses) {
        if (!pass || pass.length < 2) continue;
        moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: z + 0.5 });
        moves.push({ type: 'feed', x: pass[0].x, y: pass[0].y, z, f: plungeRate });
        for (let i = 1; i < pass.length; i++) {
          moves.push({ type: 'feed', x: pass[i].x, y: pass[i].y, z, f: feedRate });
        }
      }
    }

    // Finish pass along the outer boundary wall
    if (p.finishPass) {
      const finBoundary = offsetPolyline(outerProfile, +toolR, true)[0];
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

function generateAdaptive(op, entities) {
  const moves = [], warnings = [];
  const p = op.params;
  const toolR = (p.toolDiameter || 6.35) / 2;
  const stepover = p.stepover || 0.35;
  const safeZ = p.safeZ || 25;

  warnings.push('Adaptive: trochoidal approximation');

  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { moves: [], warnings: ['No entities selected'] };

  for (const entity of selected) {
    const profile = entityToProfile(entity);
    if (!profile || profile.length < 3) continue;

    const passes = buildZPasses(p.topZ ?? 0, p.totalDepth || 15, p.depthPerPass || 5);
    const trochR = toolR * (p.optimalLoad || 0.3);

    for (const z of passes) {
      const clearPasses = generatePocketOffsets(profile, toolR, stepover * 0.8);
      if (!clearPasses.length) continue;

      moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
      moves.push(...buildRampEntry(clearPasses[clearPasses.length - 1] || profile, p.topZ ?? 0, z, p.rampAngle || 2, p.feedRate || 2000, p.plungeRate || 500));

      for (const pass of [...clearPasses].reverse()) {
        if (!pass || pass.length < 2) continue;
        for (let i = 0; i < pass.length - 1; i++) {
          const pt = pass[i];
          const next = pass[i + 1];
          const angle = Math.atan2(next.y - pt.y, next.x - pt.x);
          for (let t = 0; t <= 1; t += 0.2) {
            const arcA = angle + Math.PI / 2 + t * Math.PI * 2;
            moves.push({ type: 'feed', x: pt.x + t * (next.x - pt.x) + Math.cos(arcA) * trochR, y: pt.y + t * (next.y - pt.y) + Math.sin(arcA) * trochR, z, f: p.feedRate || 2000 });
          }
        }
      }
    }
    moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
  }
  return { moves, warnings };
}

// ── Face ──────────────────────────────────────────────────────────────────────

function generateFace(op, entities) {
  const moves = [];
  const p = op.params;
  const toolR = (p.toolDiameter || 25.4) / 2;
  const selected = getSelectedEntities(entities, op.selectedIds);
  const bounds = selected.length ? getEntityBounds(selected) : { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const expanded = { minX: bounds.minX - (p.stockLeft || 2), minY: bounds.minY - (p.stockFront || 2), maxX: bounds.maxX + (p.stockRight || 2), maxY: bounds.maxY + (p.stockBack || 2) };
  const passes = buildZPasses(p.topZ ?? 0, p.totalDepth || 3, p.depthPerPass || 1);

  for (const z of passes) {
    const rasterPasses = generateRasterPasses(expanded, p.angle || 0, p.stepover || 0.75, toolR);
    if (!rasterPasses.length) continue;
    moves.push({ type: 'rapid', x: rasterPasses[0][0].x, y: rasterPasses[0][0].y, z: p.safeZ || 25 });
    moves.push({ type: 'feed', x: rasterPasses[0][0].x, y: rasterPasses[0][0].y, z, f: p.plungeRate || 800 });
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
      moves.push({ type: 'rapid', x: center.x, y: center.y, z: p.safeZ || 25 });
      moves.push(...buildHelicalEntry(center, toolR * 0.5, p.topZ ?? 0, z, p.plungeRate || 400));

      let r = toolR;
      while (r <= radius - toolR) {
        const segs = Math.max(24, Math.ceil(r * 2 * Math.PI / (toolR * 0.5)));
        for (let i = 0; i <= segs; i++) {
          const a = (i / segs) * Math.PI * 2;
          moves.push({ type: 'feed', x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r, z, f: p.feedRate || 1200 });
        }
        r += step;
      }

      // Final finish circle
      const finR = radius - toolR;
      if (finR > 0) {
        for (let i = 0; i <= 72; i++) {
          const a = (i / 72) * Math.PI * 2;
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

  for (const entity of selected) {
    const profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;
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
    const profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;
    const passes = buildZPasses(p.topZ ?? 0, p.totalDepth || 10, p.depthPerPass || 3);

    for (const z of passes) {
      moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
      if (p.rampEntry) {
        moves.push(...buildRampEntry(profile, p.topZ ?? 0, z, p.rampAngle || 3, p.feedRate || 1000, p.plungeRate || 300));
      } else {
        moves.push({ type: 'feed', x: profile[0].x, y: profile[0].y, z, f: p.plungeRate || 300 });
      }
      for (let i = 1; i < profile.length; i++) {
        moves.push({ type: 'feed', x: profile[i].x, y: profile[i].y, z, f: p.feedRate || 1000 });
      }
      if (isEntityClosed(entity)) {
        moves.push({ type: 'feed', x: profile[0].x, y: profile[0].y, z, f: p.feedRate || 1000 });
      }
    }
    moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
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
    const profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;
    const tipOffset = -((p.chamferWidth || 1) + (p.stockToLeave || 0));
    const offsets = offsetPolyline(profile, tipOffset, isEntityClosed(entity));
    const contourPts = offsets[0] || profile;

    moves.push({ type: 'rapid', x: contourPts[0].x, y: contourPts[0].y, z: p.safeZ || 25 });
    moves.push({ type: 'feed', x: contourPts[0].x, y: contourPts[0].y, z: tipZ, f: p.plungeRate || 300 });
    for (let i = 1; i < contourPts.length; i++) {
      moves.push({ type: 'feed', x: contourPts[i].x, y: contourPts[i].y, z: tipZ, f: p.feedRate || 800 });
    }
    if (isEntityClosed(entity)) {
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

// ── Tapered Inlay ─────────────────────────────────────────────────────────────

function generateTaperedInlay(op, entities) {
  const p = op.params;
  const warnings = [];
  const selected = getSelectedEntities(entities, op.selectedIds);
  if (!selected.length) return { moves: [], subToolpaths: [], warnings: ['No entities selected'] };

  const topZ     = p.topZ ?? 0;
  const depth    = Math.abs(p.pocketDepth || 5);
  const safeZ    = p.safeZ ?? 10;
  // p.taperAngle is the full included angle shown in the UI (e.g. 10°).
  // All geometry calculations need the half-angle (axis → cutting edge).
  // Guard at 0.5° half-angle to prevent tan() blowing up for near-zero tapers.
  const taperRad = Math.max(0.5, (p.taperAngle || 10) / 2) * Math.PI / 180;
  // Raising the plug's Z reference by this amount makes the plug fractionally
  // smaller — it engages the angled pocket walls at a slightly higher position,
  // leaving a fitTolerance gap all around the perimeter.
  const plugTopZ = topZ + (p.fitTolerance || 0.127) / Math.tan(taperRad);

  const subToolpaths = [];

  if (p.doPocketTaper !== false) {
    subToolpaths.push({
      name: 'Pocket Taper', color: '#ff8844', toolHint: 'taper',
      moves: buildTaperTrace(selected, topZ, depth, safeZ, p.taperFeedRate || 1000, p.taperPlungeRate || 300),
    });
  }
  if (p.doPocketCleanup !== false) {
    subToolpaths.push({
      name: 'Pocket Cleanup', color: '#44ff88', toolHint: 'endmill',
      moves: buildInlayCleanup(selected, topZ, depth, safeZ, p, taperRad, warnings),
    });
  }
  if (p.doPlugTaper !== false) {
    subToolpaths.push({
      name: 'Plug Taper', color: '#ff44bb', toolHint: 'taper',
      moves: buildTaperTrace(selected, plugTopZ, depth, safeZ, p.taperFeedRate || 1000, p.taperPlungeRate || 300),
    });
  }
  if (p.doPlugCleanup !== false) {
    subToolpaths.push({
      name: 'Plug Cleanup', color: '#4499ff', toolHint: 'endmill',
      moves: buildInlayCleanup(selected, plugTopZ, depth, safeZ, p, taperRad, warnings),
    });
  }

  // Flatten all sub-moves into toolpath.moves so the rest of the pipeline
  // (cycle-time, canvas) can treat this like any other operation.
  const moves = subToolpaths.flatMap(st => st.moves);
  return { moves, subToolpaths, warnings };
}

// Trace selected contours with the taper bit at full depth.
// The V-bit axis follows the contour line directly — the taper geometry
// automatically creates the angled pocket/plug walls.
function buildTaperTrace(entities, topZ, depth, safeZ, feedRate, plungeRate) {
  const moves = [];
  const z = topZ - depth;
  for (const entity of entities) {
    const profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;
    moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
    moves.push({ type: 'feed',  x: profile[0].x, y: profile[0].y, z, f: plungeRate });
    for (let i = 1; i < profile.length; i++) {
      moves.push({ type: 'feed', x: profile[i].x, y: profile[i].y, z, f: feedRate });
    }
    if (isEntityClosed(entity)) {
      moves.push({ type: 'feed', x: profile[0].x, y: profile[0].y, z, f: feedRate });
    }
    moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
  }
  return moves;
}

// Clear the material between the outer taper wall and any island taper walls.
//
// Wall-stock formula (taperRad is the half-angle):
//   wallLeave = depth × tan(halfAngle) + safetyMargin
//
// The outer boundary is inset by (endmillR + wallLeave) so the endmill centre
// stays clear of the angled pocket wall.  Each island is outset by the same
// amount to create an exclusion zone — passes that enter any exclusion zone are
// discarded by generatePocketOffsets, preventing the endmill from cutting into
// island taper walls.
//
// When multiple entities are selected the largest polygon is the outer boundary
// and all smaller polygons inside it are treated as islands (mirrors generatePocket).
function buildInlayCleanup(entities, topZ, depth, safeZ, p, taperRad, warnings) {
  const moves      = [];
  const endmillR   = (p.endmillDiameter || 3.175) / 2;
  const wallLeave  = depth * Math.tan(taperRad) + (p.safetyMargin || 0.254);
  const inset      = endmillR + wallLeave;
  const zPasses    = buildZPasses(topZ, depth, p.endmillDiameter || 3.175);

  // Build profiles and sort by area: largest = outer boundary, rest = islands
  const profiles = entities
    .map(e => entityToProfile(e))
    .filter(prof => prof && prof.length >= 3);

  if (!profiles.length) return moves;

  profiles.sort((a, b) => polygonArea(b) - polygonArea(a));
  const outerProfile   = profiles[0];
  const islandProfiles = profiles.slice(1);

  // Inset outer boundary — endmill centre must stay ≥ inset from the taper wall
  const boundary = offsetPolyline(outerProfile, inset, true)[0];
  if (!boundary || boundary.length < 4 || polygonArea(boundary) < endmillR * endmillR * Math.PI * 0.25) {
    warnings.push(`Cleanup: outer contour too small for ⌀${(p.endmillDiameter || 3.175).toFixed(2)}mm endmill + wall clearance`);
    return moves;
  }

  // Outset each island by inset to create an exclusion zone the endmill must avoid
  const islandExclusions = islandProfiles.map(island => {
    const ccw      = isClockwise(island) ? [...island].reverse() : island;
    const expanded = offsetPolyline(ccw, -inset, true)[0];
    return (expanded && expanded.length >= 3) ? expanded : ccw;
  });

  const clearPasses = generatePocketOffsets(boundary, endmillR, 0.45, islandExclusions);
  if (!clearPasses.length) {
    if (islandExclusions.length === 0) {
      warnings.push('Cleanup: no clearing passes — contour may be too small after wall clearance');
    }
    return moves;
  }

  const startPt = clearPasses[0][0];
  moves.push({ type: 'rapid', x: startPt.x, y: startPt.y, z: safeZ });
  moves.push({ type: 'feed',  x: startPt.x, y: startPt.y, z: zPasses[0], f: p.endmillPlungeRate || 500 });

  for (const z of zPasses) {
    for (const pass of clearPasses) {
      if (!pass || pass.length < 2) continue;
      moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: z + 0.5 });
      moves.push({ type: 'feed',  x: pass[0].x, y: pass[0].y, z, f: p.endmillPlungeRate || 500 });
      for (let i = 1; i < pass.length; i++) {
        moves.push({ type: 'feed', x: pass[i].x, y: pass[i].y, z, f: p.endmillFeedRate || 1500 });
      }
    }
  }
  moves.push({ type: 'rapid', x: outerProfile[0].x, y: outerProfile[0].y, z: safeZ });
  return moves;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
