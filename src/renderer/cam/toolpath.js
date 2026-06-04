// CAM Toolpath Engine
// Generates toolpath point arrays for all 2.5D operations
// All coordinates in mm, Z positive up

import { offsetPolyline, generatePocketOffsets, generateRasterPasses, ensureWinding, isClockwise, polygonArea } from './offset.js';
import { circleToPoints, arcToPoints, polylineToPoints } from '../dxf/parser.js';

// ── Entry point ───────────────────────────────────────────────────────────────

export function generateToolpath(operation, entities) {
  const { type } = operation;
  switch (type) {
    case 'contour':        return generateContour(operation, entities);
    case 'pocket':         return generatePocket(operation, entities);
    case 'adaptive':       return generateAdaptive(operation, entities);
    case 'face':           return generateFace(operation, entities);
    case 'drill':          return generateDrill(operation, entities);
    case 'bore':           return generateBore(operation, entities);
    case 'circular':       return generateCircular(operation, entities);
    case 'engrave':        return generateEngrave(operation, entities);
    case 'trace':          return generateTrace(operation, entities);
    case 'slot':           return generateSlot(operation, entities);
    case 'chamfer':        return generateChamfer(operation, entities);
    case 'thread':         return generateThread(operation, entities);
    default:               return { moves: [], warnings: ['Unknown operation type: ' + type] };
  }
}

// ── Contour (2D Profile) ──────────────────────────────────────────────────────

function generateContour(op, entities) {
  const moves = [];
  const warnings = [];
  const {
    toolDiameter = 6.35,
    compensation = 'left',  // left, right, center
    stockToLeave = 0,
    depthPerPass = 3,
    totalDepth = 10,
    safeZ = 5,
    topZ = 0,
    leadIn = true,
    leadInRadius = 0,
    tabs = false,
    tabHeight = 3,
    tabWidth = 6,
    tabCount = 4,
    rampEntry = false,
    rampAngle = 3,
    feedRate = 1500,
    plungeRate = 500,
    spindleRpm = 18000,
    finishPass = false,
    finishStockToLeave = 0,
  } = op.params;

  const offset = compensation === 'center' ? 0
    : (toolDiameter / 2 + stockToLeave) * (compensation === 'left' ? 1 : -1);

  const selectedEntities = getSelectedEntities(entities, op.selectedIds);
  if (selectedEntities.length === 0) {
    return { moves: [], warnings: ['No entities selected'] };
  }

  for (const entity of selectedEntities) {
    const profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;

    let contourPts;
    if (offset !== 0) {
      const offsets = offsetPolyline(profile, offset, entity.closed, 'round');
      contourPts = offsets[0] || profile;
    } else {
      contourPts = profile;
    }

    const passes = buildZPasses(topZ, -(Math.abs(totalDepth)), depthPerPass);

    for (let pi = 0; pi < passes.length; pi++) {
      const z = passes[pi];
      const isLastPass = pi === passes.length - 1;

      moves.push({ type: 'rapid', x: contourPts[0].x, y: contourPts[0].y, z: safeZ });

      if (rampEntry && entity.closed) {
        const rampMoves = buildRampEntry(contourPts, topZ, z, rampAngle, feedRate, plungeRate);
        moves.push(...rampMoves);
      } else {
        moves.push({ type: 'feed', x: contourPts[0].x, y: contourPts[0].y, z, f: plungeRate });
      }

      // Add tab logic on last pass
      const tabPositions = (tabs && isLastPass) ? computeTabPositions(contourPts, tabCount) : [];

      for (let i = 1; i < contourPts.length; i++) {
        const pt = contourPts[i];
        // Check if we're near a tab
        let inTab = false;
        for (const tp of tabPositions) {
          const d = Math.hypot(pt.x - contourPts[tp].x, pt.y - contourPts[tp].y);
          if (d < tabWidth / 2) { inTab = true; break; }
        }
        const cutZ = inTab ? Math.max(z, topZ - (Math.abs(totalDepth) - tabHeight)) : z;
        moves.push({ type: 'feed', x: pt.x, y: pt.y, z: cutZ, f: feedRate });
      }

      if (entity.closed) {
        moves.push({ type: 'feed', x: contourPts[0].x, y: contourPts[0].y, z, f: feedRate });
      }
    }

    if (finishPass && finishStockToLeave !== stockToLeave) {
      const finOffset = (toolDiameter / 2 + finishStockToLeave) * (compensation === 'left' ? 1 : -1);
      const finOffsets = offsetPolyline(profile, finOffset, entity.closed, 'round');
      const finPts = finOffsets[0] || profile;
      const finZ = -(Math.abs(totalDepth));
      moves.push({ type: 'rapid', x: finPts[0].x, y: finPts[0].y, z: safeZ });
      moves.push({ type: 'feed', x: finPts[0].x, y: finPts[0].y, z: finZ, f: plungeRate });
      for (let i = 1; i < finPts.length; i++) {
        moves.push({ type: 'feed', x: finPts[i].x, y: finPts[i].y, z: finZ, f: feedRate * 0.7 });
      }
    }

    moves.push({ type: 'rapid', x: contourPts[0].x, y: contourPts[0].y, z: safeZ });
  }

  return { moves, warnings };
}

// ── Pocket ────────────────────────────────────────────────────────────────────

function generatePocket(op, entities) {
  const moves = [];
  const warnings = [];
  const {
    toolDiameter = 6.35,
    stepover = 0.45,
    depthPerPass = 3,
    totalDepth = 10,
    safeZ = 5,
    topZ = 0,
    feedRate = 1500,
    plungeRate = 500,
    spindleRpm = 18000,
    finishPass = true,
    finishAllowance = 0.2,
    startFromCenter = false,
  } = op.params;

  const selectedEntities = getSelectedEntities(entities, op.selectedIds);
  if (selectedEntities.length === 0) return { moves: [], warnings: ['No entities selected'] };

  for (const entity of selectedEntities) {
    const profile = entityToProfile(entity);
    if (!profile || profile.length < 3) { warnings.push('Entity too simple for pocket'); continue; }

    const passes = buildZPasses(topZ, -(Math.abs(totalDepth)), depthPerPass);

    for (const z of passes) {
      const clearanceOffset = finishPass ? -(toolDiameter / 2 + finishAllowance) : -(toolDiameter / 2);
      const initialOffsets = offsetPolyline(profile, clearanceOffset, true, 'miter');
      if (!initialOffsets || initialOffsets[0]?.length < 3) { warnings.push('Pocket too small for tool'); continue; }

      const pocketPasses = generatePocketOffsets(initialOffsets[0], toolDiameter / 2, stepover);

      // Sort passes - either center-out or outside-in
      const sortedPasses = startFromCenter ? [...pocketPasses].reverse() : pocketPasses;

      let prevX = sortedPasses[0]?.[0]?.x ?? 0;
      let prevY = sortedPasses[0]?.[0]?.y ?? 0;

      moves.push({ type: 'rapid', x: prevX, y: prevY, z: safeZ });
      moves.push({ type: 'feed', x: prevX, y: prevY, z, f: plungeRate });

      for (const pass of sortedPasses) {
        if (!pass || pass.length < 2) continue;
        moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: z + 0.5 });
        moves.push({ type: 'feed', x: pass[0].x, y: pass[0].y, z, f: plungeRate });
        for (let i = 1; i < pass.length; i++) {
          moves.push({ type: 'feed', x: pass[i].x, y: pass[i].y, z, f: feedRate });
        }
        moves.push({ type: 'feed', x: pass[0].x, y: pass[0].y, z, f: feedRate });
      }

      if (finishPass) {
        const finOffset = -(toolDiameter / 2);
        const finPts = offsetPolyline(profile, finOffset, true, 'round')[0] || profile;
        moves.push({ type: 'rapid', x: finPts[0].x, y: finPts[0].y, z: z + 0.5 });
        moves.push({ type: 'feed', x: finPts[0].x, y: finPts[0].y, z, f: plungeRate });
        for (let i = 1; i < finPts.length; i++) {
          moves.push({ type: 'feed', x: finPts[i].x, y: finPts[i].y, z, f: feedRate * 0.6 });
        }
        moves.push({ type: 'feed', x: finPts[0].x, y: finPts[0].y, z, f: feedRate * 0.6 });
      }
    }

    moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
  }

  return { moves, warnings };
}

// ── Adaptive Clearing ─────────────────────────────────────────────────────────

function generateAdaptive(op, entities) {
  const moves = [];
  const warnings = [];
  const {
    toolDiameter = 6.35,
    stepover = 0.35,
    depthPerPass = 5,
    totalDepth = 15,
    safeZ = 5,
    topZ = 0,
    feedRate = 2000,
    plungeRate = 500,
    rampAngle = 2,
    optimalLoad = 0.3,
  } = op.params;

  const selectedEntities = getSelectedEntities(entities, op.selectedIds);
  if (selectedEntities.length === 0) return { moves: [], warnings: ['No entities selected'] };

  warnings.push('Adaptive: using trochoidal approximation');

  for (const entity of selectedEntities) {
    const profile = entityToProfile(entity);
    if (!profile || profile.length < 3) continue;

    const passes = buildZPasses(topZ, -(Math.abs(totalDepth)), depthPerPass);
    const step = toolDiameter * stepover;
    const trochRadius = toolDiameter * optimalLoad;

    for (const z of passes) {
      const pocketPasses = generatePocketOffsets(profile, toolDiameter / 2, stepover * 0.8);
      if (!pocketPasses.length) continue;

      moves.push({ type: 'rapid', x: pocketPasses[0]?.[0]?.x ?? 0, y: pocketPasses[0]?.[0]?.y ?? 0, z: safeZ });

      // Ramp into first position
      const rampMoves = buildRampEntry(
        pocketPasses[pocketPasses.length - 1] || pocketPasses[0],
        topZ, z, rampAngle, feedRate * 0.5, plungeRate
      );
      moves.push(...rampMoves);

      // Trochoidal passes from inside out
      for (const pass of [...pocketPasses].reverse()) {
        if (!pass || pass.length < 2) continue;
        for (let i = 0; i < pass.length - 1; i++) {
          const pt = pass[i];
          const next = pass[i + 1];
          // Add small trochoidal arc at each point
          const angle = Math.atan2(next.y - pt.y, next.x - pt.x);
          const perpAngle = angle + Math.PI / 2;
          for (let t = 0; t <= 1; t += 0.1) {
            const arcA = perpAngle + t * Math.PI * 2;
            moves.push({
              type: 'feed',
              x: pt.x + Math.cos(t) * (next.x - pt.x) + Math.cos(arcA) * trochRadius,
              y: pt.y + Math.sin(t) * (next.y - pt.y) + Math.sin(arcA) * trochRadius,
              z, f: feedRate
            });
          }
        }
      }
    }

    moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
  }

  return { moves, warnings };
}

// ── Face Milling ──────────────────────────────────────────────────────────────

function generateFace(op, entities) {
  const moves = [];
  const {
    toolDiameter = 25.4,
    stepover = 0.75,
    depthPerPass = 1,
    totalDepth = 3,
    safeZ = 5,
    topZ = 0,
    feedRate = 3000,
    plungeRate = 800,
    angle = 0,
    stockLeft = 1,
    stockRight = 1,
    stockFront = 1,
    stockBack = 1,
  } = op.params;

  const selectedEntities = getSelectedEntities(entities, op.selectedIds);
  const bounds = selectedEntities.length > 0
    ? getEntityBounds(selectedEntities)
    : op.stockBounds || { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  const expandedBounds = {
    minX: bounds.minX - stockLeft,
    minY: bounds.minY - stockFront,
    maxX: bounds.maxX + stockRight,
    maxY: bounds.maxY + stockBack,
  };

  const passes = buildZPasses(topZ, -(Math.abs(totalDepth)), depthPerPass);

  for (const z of passes) {
    const rasterPasses = generateRasterPasses(expandedBounds, angle, stepover, toolDiameter / 2);
    moves.push({ type: 'rapid', x: rasterPasses[0][0].x, y: rasterPasses[0][0].y, z: safeZ });
    moves.push({ type: 'feed', x: rasterPasses[0][0].x, y: rasterPasses[0][0].y, z, f: plungeRate });
    for (const pass of rasterPasses) {
      moves.push({ type: 'rapid', x: pass[0].x, y: pass[0].y, z: z + 0.2 });
      moves.push({ type: 'feed', x: pass[0].x, y: pass[0].y, z, f: feedRate * 0.5 });
      moves.push({ type: 'feed', x: pass[1].x, y: pass[1].y, z, f: feedRate });
    }
  }
  moves.push({ type: 'rapid', x: 0, y: 0, z: safeZ });

  return { moves, warnings: [] };
}

// ── Drill ─────────────────────────────────────────────────────────────────────

function generateDrill(op, entities) {
  const moves = [];
  const {
    totalDepth = 20,
    safeZ = 5,
    topZ = 0,
    feedRate = 300,
    spindleRpm = 3000,
    peckDepth = 0,
    dwellTime = 0,
    retractHeight = 2,
    chipBreak = false,
  } = op.params;

  const selectedEntities = getSelectedEntities(entities, op.selectedIds);

  for (const entity of selectedEntities) {
    let cx, cy;
    if (entity.type === 'circle') { cx = entity.center.x; cy = entity.center.y; }
    else if (entity.type === 'arc')   { cx = entity.center.x; cy = entity.center.y; }
    else {
      const profile = entityToProfile(entity);
      if (!profile) continue;
      cx = profile.reduce((s, p) => s + p.x, 0) / profile.length;
      cy = profile.reduce((s, p) => s + p.y, 0) / profile.length;
    }

    const targetZ = topZ - Math.abs(totalDepth);
    moves.push({ type: 'rapid', x: cx, y: cy, z: safeZ });
    moves.push({ type: 'rapid', x: cx, y: cy, z: retractHeight });

    if (peckDepth > 0) {
      let currentZ = topZ;
      while (currentZ > targetZ) {
        const nextZ = Math.max(targetZ, currentZ - peckDepth);
        moves.push({ type: 'feed', x: cx, y: cy, z: nextZ, f: feedRate });
        if (chipBreak) {
          moves.push({ type: 'feed', x: cx, y: cy, z: nextZ + 0.5, f: feedRate * 3 });
        } else {
          moves.push({ type: 'rapid', x: cx, y: cy, z: retractHeight });
        }
        currentZ = nextZ;
        if (currentZ <= targetZ) break;
      }
    } else {
      moves.push({ type: 'feed', x: cx, y: cy, z: targetZ, f: feedRate });
    }

    if (dwellTime > 0) moves.push({ type: 'dwell', p: dwellTime * 1000 });
    moves.push({ type: 'rapid', x: cx, y: cy, z: safeZ });
  }

  return { moves, warnings: [] };
}

// ── Bore ──────────────────────────────────────────────────────────────────────

function generateBore(op, entities) {
  const moves = [];
  const {
    toolDiameter = 6.35,
    totalDepth = 20,
    safeZ = 5,
    topZ = 0,
    feedRate = 600,
    plungeRate = 200,
    helicalPitch = 1.5,
    direction = 'climb',
  } = op.params;

  const selectedEntities = getSelectedEntities(entities, op.selectedIds);

  for (const entity of selectedEntities) {
    if (entity.type !== 'circle') { continue; }
    const { center, radius } = entity;
    const boreDiam = radius * 2;
    const helixRadius = radius - toolDiameter / 2;
    if (helixRadius <= 0) continue;

    const targetZ = topZ - Math.abs(totalDepth);
    moves.push({ type: 'rapid', x: center.x + helixRadius, y: center.y, z: safeZ });
    moves.push({ type: 'rapid', x: center.x + helixRadius, y: center.y, z: topZ });

    // Helical descent
    const turns = Math.abs(totalDepth) / helicalPitch;
    const steps = Math.ceil(turns * 36);
    for (let i = 1; i <= steps; i++) {
      const angle = (i / steps) * turns * Math.PI * 2 * (direction === 'climb' ? -1 : 1);
      const z = topZ - (i / steps) * Math.abs(totalDepth);
      moves.push({ type: 'feed', x: center.x + Math.cos(angle) * helixRadius, y: center.y + Math.sin(angle) * helixRadius, z, f: feedRate });
    }

    // Full circle finish at bottom
    for (let i = 0; i <= 36; i++) {
      const angle = (i / 36) * Math.PI * 2 * (direction === 'climb' ? -1 : 1);
      moves.push({ type: 'feed', x: center.x + Math.cos(angle) * helixRadius, y: center.y + Math.sin(angle) * helixRadius, z: targetZ, f: feedRate * 0.7 });
    }

    moves.push({ type: 'rapid', x: center.x, y: center.y, z: targetZ });
    moves.push({ type: 'rapid', x: center.x, y: center.y, z: safeZ });
  }

  return { moves, warnings: [] };
}

// ── Circular Pocket ───────────────────────────────────────────────────────────

function generateCircular(op, entities) {
  const moves = [];
  const {
    toolDiameter = 6.35,
    totalDepth = 10,
    safeZ = 5,
    topZ = 0,
    feedRate = 1200,
    plungeRate = 400,
    stepover = 0.4,
    helicalEntry = true,
  } = op.params;

  const selectedEntities = getSelectedEntities(entities, op.selectedIds);

  for (const entity of selectedEntities) {
    if (entity.type !== 'circle') continue;
    const { center, radius } = entity;
    const passes = buildZPasses(topZ, -(Math.abs(totalDepth)), op.params.depthPerPass || 3);

    for (const z of passes) {
      // Start from center, spiral out
      let r = toolDiameter * 0.1;
      const step = toolDiameter * stepover;
      moves.push({ type: 'rapid', x: center.x, y: center.y, z: safeZ });

      if (helicalEntry) {
        const rampMoves = buildHelicalEntry(center, r, topZ, z, op.params.plungeRate || 400, feedRate);
        moves.push(...rampMoves);
      } else {
        moves.push({ type: 'feed', x: center.x, y: center.y, z, f: plungeRate });
      }

      while (r <= radius - toolDiameter / 2) {
        const segments = Math.max(24, Math.ceil(r * 2 * Math.PI / (toolDiameter * 0.1)));
        for (let i = 0; i <= segments; i++) {
          const a = (i / segments) * Math.PI * 2;
          moves.push({ type: 'feed', x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r, z, f: feedRate });
        }
        r += step;
      }

      // Final finish pass
      const finR = radius - toolDiameter / 2;
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        moves.push({ type: 'feed', x: center.x + Math.cos(a) * finR, y: center.y + Math.sin(a) * finR, z, f: feedRate * 0.6 });
      }
    }

    moves.push({ type: 'rapid', x: center.x, y: center.y, z: safeZ });
  }

  return { moves, warnings: [] };
}

// ── Engrave ───────────────────────────────────────────────────────────────────

function generateEngrave(op, entities) {
  const moves = [];
  const {
    depth = 1.5,
    safeZ = 5,
    topZ = 0,
    feedRate = 800,
    plungeRate = 300,
  } = op.params;

  const selectedEntities = getSelectedEntities(entities, op.selectedIds);

  for (const entity of selectedEntities) {
    const profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;

    const z = topZ - Math.abs(depth);
    moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
    moves.push({ type: 'feed', x: profile[0].x, y: profile[0].y, z, f: plungeRate });
    for (let i = 1; i < profile.length; i++) {
      moves.push({ type: 'feed', x: profile[i].x, y: profile[i].y, z, f: feedRate });
    }
    if (entity.closed) {
      moves.push({ type: 'feed', x: profile[0].x, y: profile[0].y, z, f: feedRate });
    }
    moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
  }

  return { moves, warnings: [] };
}

// ── Trace ─────────────────────────────────────────────────────────────────────

function generateTrace(op, entities) {
  return generateEngrave({ ...op, params: { ...op.params, depth: op.params.depth || 0.5 } }, entities);
}

// ── Slot ──────────────────────────────────────────────────────────────────────

function generateSlot(op, entities) {
  const moves = [];
  const {
    toolDiameter = 6.35,
    depthPerPass = 2,
    totalDepth = 10,
    safeZ = 5,
    topZ = 0,
    feedRate = 1000,
    plungeRate = 300,
    rampEntry = true,
    rampAngle = 3,
  } = op.params;

  const selectedEntities = getSelectedEntities(entities, op.selectedIds);

  for (const entity of selectedEntities) {
    const profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;

    const passes = buildZPasses(topZ, -(Math.abs(totalDepth)), depthPerPass);

    for (const z of passes) {
      if (rampEntry) {
        const rampMoves = buildRampEntry(profile, topZ, z, rampAngle, feedRate * 0.5, plungeRate);
        moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
        moves.push(...rampMoves);
      } else {
        moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
        moves.push({ type: 'feed', x: profile[0].x, y: profile[0].y, z, f: plungeRate });
      }

      for (let i = 1; i < profile.length; i++) {
        moves.push({ type: 'feed', x: profile[i].x, y: profile[i].y, z, f: feedRate });
      }
      if (entity.closed) {
        moves.push({ type: 'feed', x: profile[0].x, y: profile[0].y, z, f: feedRate });
      }
    }

    moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: safeZ });
  }

  return { moves, warnings: [] };
}

// ── Chamfer ───────────────────────────────────────────────────────────────────

function generateChamfer(op, entities) {
  const moves = [];
  const {
    toolDiameter = 6.35,
    chamferAngle = 45,
    chamferWidth = 1.0,
    topZ = 0,
    safeZ = 5,
    feedRate = 800,
    plungeRate = 300,
    stockToLeave = 0,
  } = op.params;

  const chamferDepth = chamferWidth * Math.tan(chamferAngle * Math.PI / 180);
  const tipZ = topZ - chamferDepth;

  const selectedEntities = getSelectedEntities(entities, op.selectedIds);

  for (const entity of selectedEntities) {
    const profile = entityToProfile(entity);
    if (!profile || profile.length < 2) continue;

    const tipOffset = chamferWidth + stockToLeave;
    const offsets = offsetPolyline(profile, -tipOffset, entity.closed, 'miter');
    const contourPts = offsets[0] || profile;

    moves.push({ type: 'rapid', x: contourPts[0].x, y: contourPts[0].y, z: safeZ });
    moves.push({ type: 'feed', x: contourPts[0].x, y: contourPts[0].y, z: tipZ, f: plungeRate });
    for (let i = 1; i < contourPts.length; i++) {
      moves.push({ type: 'feed', x: contourPts[i].x, y: contourPts[i].y, z: tipZ, f: feedRate });
    }
    if (entity.closed) {
      moves.push({ type: 'feed', x: contourPts[0].x, y: contourPts[0].y, z: tipZ, f: feedRate });
    }
    moves.push({ type: 'rapid', x: contourPts[0].x, y: contourPts[0].y, z: safeZ });
  }

  return { moves, warnings: [] };
}

// ── Thread Milling ────────────────────────────────────────────────────────────

function generateThread(op, entities) {
  const moves = [];
  const {
    pitch = 1.25,
    totalDepth = 15,
    safeZ = 5,
    topZ = 0,
    feedRate = 400,
    plungeRate = 200,
    toolDiameter = 6.35,
    internal = true,
    direction = 'right',
  } = op.params;

  const selectedEntities = getSelectedEntities(entities, op.selectedIds);

  for (const entity of selectedEntities) {
    if (entity.type !== 'circle') continue;
    const { center, radius } = entity;
    const threadRadius = radius - toolDiameter / 2;
    if (threadRadius <= 0) continue;

    const targetZ = topZ - Math.abs(totalDepth);
    const turns = Math.abs(totalDepth) / pitch;
    const steps = Math.ceil(turns * 36);
    const dir = direction === 'right' ? -1 : 1;

    moves.push({ type: 'rapid', x: center.x + threadRadius, y: center.y, z: safeZ });
    moves.push({ type: 'rapid', x: center.x + threadRadius, y: center.y, z: topZ });

    for (let i = 1; i <= steps; i++) {
      const angle = (i / steps) * turns * Math.PI * 2 * dir;
      const z = topZ - (i / steps) * Math.abs(totalDepth);
      moves.push({ type: 'feed', x: center.x + Math.cos(angle) * threadRadius, y: center.y + Math.sin(angle) * threadRadius, z, f: feedRate });
    }

    // Final full pass at bottom
    for (let i = 0; i <= 36; i++) {
      const angle = (i / 36) * Math.PI * 2 * dir;
      moves.push({ type: 'feed', x: center.x + Math.cos(angle) * threadRadius, y: center.y + Math.sin(angle) * threadRadius, z: targetZ, f: feedRate * 0.6 });
    }

    moves.push({ type: 'rapid', x: center.x, y: center.y, z: targetZ });
    moves.push({ type: 'rapid', x: center.x, y: center.y, z: safeZ });
  }

  return { moves, warnings: [] };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildZPasses(topZ, bottomZ, depthPerPass) {
  const passes = [];
  let z = topZ - Math.abs(depthPerPass);
  while (z > bottomZ) {
    passes.push(z);
    z -= Math.abs(depthPerPass);
  }
  passes.push(bottomZ);
  return passes;
}

function buildRampEntry(profile, topZ, targetZ, rampAngleDeg, feedRate, plungeRate) {
  const moves = [];
  const totalDepth = topZ - targetZ;
  const rampAngleRad = rampAngleDeg * Math.PI / 180;
  const rampLength = totalDepth / Math.tan(rampAngleRad);
  let distSoFar = 0;
  let z = topZ;

  moves.push({ type: 'rapid', x: profile[0].x, y: profile[0].y, z: topZ + 0.5 });

  for (let i = 0; i < profile.length - 1 && z > targetZ; i++) {
    const p1 = profile[i];
    const p2 = profile[i + 1];
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const zDrop = segLen * Math.tan(rampAngleRad);
    const newZ = Math.max(targetZ, z - zDrop);
    moves.push({ type: 'feed', x: p2.x, y: p2.y, z: newZ, f: plungeRate });
    z = newZ;
    distSoFar += segLen;
    if (distSoFar >= rampLength) break;
  }

  return moves;
}

function buildHelicalEntry(center, radius, topZ, targetZ, plungeRate, feedRate) {
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
  return { minX, minY, maxX, maxY };
}

function computeTabPositions(profile, count) {
  const totalLen = profile.reduce((sum, p, i) => {
    if (i === 0) return 0;
    return sum + Math.hypot(p.x - profile[i-1].x, p.y - profile[i-1].y);
  }, 0);
  const interval = totalLen / count;
  const positions = [];
  let dist = 0, next = interval / 2;
  for (let i = 1; i < profile.length; i++) {
    dist += Math.hypot(profile[i].x - profile[i-1].x, profile[i].y - profile[i-1].y);
    while (next <= dist) { positions.push(i); next += interval; }
  }
  return positions;
}
