// Masso G3 Post-Processor
// Generates G-code compatible with Masso G3 controller
// Key Masso G3 notes:
//   - NO G43/G49 (tool length offsets handled internally by Masso)
//   - NO G40 (cutter comp not used)
//   - Tool change: T1 M6 format
//   - G20 = inches, G21 = mm
//   - G28 = return to machine home
//   - Supports G81/G83 canned drill cycles

export const DEFAULT_POST_CONFIG = {
  name: 'Masso G3',
  units: 'mm',             // mm or inch
  coolant: 'off',          // off, flood, mist
  spindleDelay: 3,         // seconds to wait after M3
  lineNumbering: true,
  lineIncrement: 10,
  decimals: 3,             // auto-set: 3 for mm, 4 for inch
  safeZ: 25.0,
  toolChangeZ: 50.0,
  homeAtEnd: false,
  homeX: 0,
  homeY: 0,
  useCannedDrill: true,    // use G81/G83 instead of long-hand drill moves
  programHeader: '',
  programFooter: '',
};

export function generateGcode(operations, postConfig = {}) {
  const cfg = { ...DEFAULT_POST_CONFIG, ...postConfig };
  
  // Auto decimals based on units
  const dec = cfg.units === 'inch' ? 4 : 3;
  
  // Unit conversion factor (all internal coords are mm)
  const uf = cfg.units === 'inch' ? 1 / 25.4 : 1;
  
  const lines = [];
  let lineNum = 10;
  let currentTool = null;
  let currentSpindle = 0;
  let currentFeed = 0;
  let modalG = null;

  function n() {
    if (!cfg.lineNumbering) return '';
    const s = `N${lineNum} `;
    lineNum += cfg.lineIncrement;
    return s;
  }

  function fmt(val) {
    return (val * uf).toFixed(dec);
  }

  function fmtF(val) {
    // Feed rate conversion: mm/min to in/min if needed
    return (val * uf).toFixed(cfg.units === 'inch' ? 2 : 0);
  }

  function emit(line) { lines.push(line); }

  // ── Program Header ──────────────────────────────────────────────────────────
  emit('%');
  emit(`(MassoCAM - Generated ${new Date().toLocaleString()})`);
  emit(`(Units: ${cfg.units === 'mm' ? 'Metric mm' : 'Imperial inch'})`);
  emit('');
  emit(`${n()}${cfg.units === 'mm' ? 'G21' : 'G20'}`);
  emit(`${n()}G90 G17 G94`);
  if (cfg.wcs) emit(`${n()}${cfg.wcs} (Work offset)`);
  // NOTE: No G43/G49/G40 - Masso G3 handles tool offsets internally

  if (cfg.programHeader) {
    emit(''); emit('(--- Custom Header ---)');
    for (const l of cfg.programHeader.split('\n')) emit(l);
  }

  // ── Operations ─────────────────────────────────────────────────────────────
  for (const op of operations) {
    if (!op.enabled) continue;
    const { toolpath, tool, params } = op;
    if (!toolpath?.moves?.length) continue;

    emit('');
    emit(`(--- ${op.name} [${op.type}] ---)`);
    if (tool) emit(`(Tool: ${tool.name} dia=${tool.diameter}mm)`);
    if (toolpath.warnings?.length > 0) {
      for (const w of toolpath.warnings) emit(`(WARNING: ${w})`);
    }

    // Tool change
    if (tool && tool.id !== currentTool) {
      emit('');
      emit(`${n()}G0 Z${fmt(cfg.toolChangeZ)} (Retract)`);
      emit(`${n()}M5 (Spindle off)`);
      if (cfg.coolant !== 'off') emit(`${n()}M9 (Coolant off)`);
      emit(`${n()}T${tool.toolNumber || 1} M6 (Tool change)`);
      currentTool = tool.id;
      currentSpindle = 0;
    }

    // Spindle
    const rpm = params?.spindleRpm || tool?.feeds?.[0]?.spindle_rpm || 18000;
    if (rpm !== currentSpindle) {
      emit(`${n()}S${rpm} M3`);
      if (cfg.spindleDelay > 0) emit(`${n()}G4 P${cfg.spindleDelay * 1000}`);
      currentSpindle = rpm;
    }

    // Coolant
    if (cfg.coolant === 'flood') emit(`${n()}M8`);
    else if (cfg.coolant === 'mist') emit(`${n()}M7`);

    // Moves
    modalG = null;
    currentFeed = 0;

    for (const move of toolpath.moves) {
      switch (move.type) {

        case 'rapid': {
          const parts = ['G0'];
          if (move.x !== undefined) parts.push(`X${fmt(move.x)}`);
          if (move.y !== undefined) parts.push(`Y${fmt(move.y)}`);
          if (move.z !== undefined) parts.push(`Z${fmt(move.z)}`);
          emit(`${n()}${parts.join(' ')}`);
          modalG = 'G0';
          break;
        }

        case 'feed': {
          const parts = [];
          if (modalG !== 'G1') { parts.push('G1'); modalG = 'G1'; }
          if (move.x !== undefined) parts.push(`X${fmt(move.x)}`);
          if (move.y !== undefined) parts.push(`Y${fmt(move.y)}`);
          if (move.z !== undefined) parts.push(`Z${fmt(move.z)}`);
          if (move.f !== undefined && move.f !== currentFeed) {
            parts.push(`F${fmtF(move.f)}`);
            currentFeed = move.f;
          }
          if (parts.length > 0) emit(`${n()}${parts.join(' ')}`);
          break;
        }

        case 'arc_cw': {
          const parts = ['G2'];
          if (move.x !== undefined) parts.push(`X${fmt(move.x)}`);
          if (move.y !== undefined) parts.push(`Y${fmt(move.y)}`);
          if (move.z !== undefined) parts.push(`Z${fmt(move.z)}`);
          if (move.i !== undefined) parts.push(`I${fmt(move.i)}`);
          if (move.j !== undefined) parts.push(`J${fmt(move.j)}`);
          if (move.f !== undefined) parts.push(`F${fmtF(move.f)}`);
          emit(`${n()}${parts.join(' ')}`);
          modalG = 'G2'; break;
        }

        case 'arc_ccw': {
          const parts = ['G3'];
          if (move.x !== undefined) parts.push(`X${fmt(move.x)}`);
          if (move.y !== undefined) parts.push(`Y${fmt(move.y)}`);
          if (move.z !== undefined) parts.push(`Z${fmt(move.z)}`);
          if (move.i !== undefined) parts.push(`I${fmt(move.i)}`);
          if (move.j !== undefined) parts.push(`J${fmt(move.j)}`);
          if (move.f !== undefined) parts.push(`F${fmtF(move.f)}`);
          emit(`${n()}${parts.join(' ')}`);
          modalG = 'G3'; break;
        }

        case 'dwell':
          emit(`${n()}G4 P${move.p}`);
          break;
      }
    }
  }

  // ── Footer ──────────────────────────────────────────────────────────────────
  emit('');
  emit('(--- End of Program ---)');
  emit(`${n()}M5 (Spindle off)`);
  if (cfg.coolant !== 'off') emit(`${n()}M9 (Coolant off)`);
  if (cfg.homeAtEnd) {
    emit(`${n()}G0 Z${fmt(cfg.toolChangeZ)}`);
    emit(`${n()}G28 (Return to machine home)`);
  } else {
    emit(`${n()}G0 Z${fmt(cfg.safeZ)}`);
  }

  if (cfg.programFooter) {
    emit('');
    for (const l of cfg.programFooter.split('\n')) emit(l);
  }

  emit(`${n()}M30`);
  emit('%');

  return lines.join('\n');
}

export function estimateCycleTime(operations) {
  let totalSeconds = 0;
  const RAPID_SPEED = 5000;

  for (const op of operations) {
    if (!op.enabled || !op.toolpath?.moves) continue;
    let prevX = 0, prevY = 0, prevZ = 25;

    for (const move of op.toolpath.moves) {
      const x = move.x ?? prevX;
      const y = move.y ?? prevY;
      const z = move.z ?? prevZ;
      const dist = Math.hypot(x - prevX, y - prevY, z - prevZ);

      if (move.type === 'rapid') totalSeconds += (dist / RAPID_SPEED) * 60;
      else if (move.type === 'feed') totalSeconds += (dist / (move.f || op.params?.feedRate || 1000)) * 60;
      else if (move.type === 'dwell') totalSeconds += (move.p || 0) / 1000;

      if (move.x !== undefined) prevX = move.x;
      if (move.y !== undefined) prevY = move.y;
      if (move.z !== undefined) prevZ = move.z;
    }
  }
  return totalSeconds;
}

export function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
