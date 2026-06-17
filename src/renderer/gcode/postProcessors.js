// Post-processor registry for DMDCAM.
// Defines coreGenerate() (shared move emitter) plus hook sets for each supported
// controller.  postprocessor.js imports generateForPP() and dispatches to the
// correct hook set based on cfg.postProcessor.

// ── Shared move emitter ───────────────────────────────────────────────────────

export function coreGenerate(operations, cfg, hooks) {
  const dec = cfg.units === 'inch' ? 4 : 3;
  const uf  = cfg.units === 'inch' ? 1 / 25.4 : 1;
  const lines = [];
  let lineNum = cfg.lineIncrement || 10;
  let currentToolId = null;
  let currentSpindle = 0;
  let currentFeed = 0;
  let modalG = null;

  function n() {
    if (!cfg.lineNumbering) return '';
    const s = `N${lineNum} `;
    lineNum += (cfg.lineIncrement || 10);
    return s;
  }
  function fmt(v)  { return (v * uf).toFixed(dec); }
  function fmtF(v) { return (v * uf).toFixed(cfg.units === 'inch' ? 2 : 0); }

  const sox = cfg.stockOriginX ?? 0;
  const soy = cfg.stockOriginY ?? 0;
  function fmtX(v) { return fmt(v - sox); }
  function fmtY(v) { return fmt(v - soy); }

  const ctx = { cfg, n, fmt, fmtF };

  function emit(l) { lines.push(l); }
  function emitAll(arr) { if (arr?.length) arr.forEach(l => emit(l)); }

  emitAll(hooks.programStart(ctx));

  function emitMoves(moves) {
    modalG = null; currentFeed = 0;
    for (const move of moves) {
      switch (move.type) {
        case 'rapid': {
          const p = ['G0'];
          if (move.x !== undefined) p.push(`X${fmtX(move.x)}`);
          if (move.y !== undefined) p.push(`Y${fmtY(move.y)}`);
          if (move.z !== undefined) p.push(`Z${fmt(move.z)}`);
          emit(`${n()}${p.join(' ')}`); modalG = 'G0'; break;
        }
        case 'feed': {
          const p = [];
          if (modalG !== 'G1') { p.push('G1'); modalG = 'G1'; }
          if (move.x !== undefined) p.push(`X${fmtX(move.x)}`);
          if (move.y !== undefined) p.push(`Y${fmtY(move.y)}`);
          if (move.z !== undefined) p.push(`Z${fmt(move.z)}`);
          if (move.f !== undefined && move.f !== currentFeed) {
            p.push(`F${fmtF(move.f)}`); currentFeed = move.f;
          }
          if (p.length > 0) emit(`${n()}${p.join(' ')}`); break;
        }
        case 'arc_cw': {
          const p = ['G2'];
          if (move.x !== undefined) p.push(`X${fmtX(move.x)}`);
          if (move.y !== undefined) p.push(`Y${fmtY(move.y)}`);
          if (move.z !== undefined) p.push(`Z${fmt(move.z)}`);
          if (move.i !== undefined) p.push(`I${fmt(move.i)}`);
          if (move.j !== undefined) p.push(`J${fmt(move.j)}`);
          if (move.f !== undefined) p.push(`F${fmtF(move.f)}`);
          emit(`${n()}${p.join(' ')}`); modalG = 'G2'; break;
        }
        case 'arc_ccw': {
          const p = ['G3'];
          if (move.x !== undefined) p.push(`X${fmtX(move.x)}`);
          if (move.y !== undefined) p.push(`Y${fmtY(move.y)}`);
          if (move.z !== undefined) p.push(`Z${fmt(move.z)}`);
          if (move.i !== undefined) p.push(`I${fmt(move.i)}`);
          if (move.j !== undefined) p.push(`J${fmt(move.j)}`);
          if (move.f !== undefined) p.push(`F${fmtF(move.f)}`);
          emit(`${n()}${p.join(' ')}`); modalG = 'G3'; break;
        }
        case 'dwell':
          emit(`${n()}G4 P${move.p}`); break;
        default: break;
      }
    }
  }

  for (const op of operations) {
    if (!op.enabled) continue;
    const { toolpath, tool, params } = op;
    if (!toolpath?.moves?.length) continue;

    emit('');
    emit(`(--- ${op.name} [${op.type}] ---)`);
    emit(`; ${params?.climb === false ? 'Conventional' : 'Climb'}`);
    if (tool) emit(`(Tool: ${tool.name} dia=${tool.diameter}mm)`);
    if (toolpath.warnings?.length) {
      toolpath.warnings.forEach(w => emit(`(WARNING: ${w})`));
    }

    if (tool && tool.id !== currentToolId) {
      const toolNum = cfg.toolNumbers?.[String(tool.id)] ?? tool.tool_number ?? tool.toolNumber ?? 1;
      emit('');
      emitAll(hooks.toolChange({ ...tool, _resolvedNum: toolNum }, ctx));
      currentToolId = tool.id;
      currentSpindle = 0;
    }

    const rpm = params?.spindleRpm || tool?.feeds?.[0]?.spindle_rpm || 18000;
    if (rpm !== currentSpindle) {
      emitAll(hooks.spindleOn(rpm, ctx));
      currentSpindle = rpm;
    }

    emitAll(hooks.coolantOn(ctx));

    if (toolpath.subToolpaths?.length > 0) {
      let activeToolKey = null;
      for (const sub of toolpath.subToolpaths) {
        if (!sub.moves?.length) continue;
        emit('');
        emit(`(Pass: ${sub.name})`);
        const subKey = sub.toolKey ?? sub.toolHint ?? null;
        if (subKey !== activeToolKey) {
          emitAll(hooks.subPassChange(sub, ctx));
          activeToolKey = subKey;
        }
        emitAll(hooks.coolantOn(ctx));
        emitMoves(sub.moves);
      }
    } else {
      emitMoves(toolpath.moves);
    }
  }

  emit('');
  emit('(--- End of Program ---)');
  emitAll(hooks.programEnd(ctx));

  return lines.join('\n');
}

// ── Settings spec field helpers ───────────────────────────────────────────────
// Used by MachineProfilesModal to render form fields dynamically.

const SPEC_UNITS          = { key:'units',          label:'Output Units',       type:'select',   options:[{v:'mm',l:'Metric (mm) — G21'},{v:'inch',l:'Imperial (inch) — G20'}] };
const SPEC_COOLANT        = { key:'coolant',         label:'Coolant',            type:'select',   options:[{v:'off',l:'Off'},{v:'flood',l:'Flood (M8)'},{v:'mist',l:'Mist (M7)'}] };
const SPEC_SPINDLE_DELAY  = { key:'spindleDelay',    label:'Spindle Ramp Delay', type:'number',   unit:'sec', min:0, max:30, step:0.5, note:'Dwell after M3 before moving' };
const SPEC_SAFE_Z         = { key:'safeZ',           label:'Safe Z',             type:'number',   unit:'mm',  step:1 };
const SPEC_TOOL_CHANGE_Z  = { key:'toolChangeZ',     label:'Tool Change Z',      type:'number',   unit:'mm',  step:1 };
const SPEC_LINE_NUMBERING = { key:'lineNumbering',   label:'Line Numbers',       type:'checkbox' };
const SPEC_LINE_INCREMENT = { key:'lineIncrement',   label:'Line Increment',     type:'number',   min:1, max:100, step:1 };
const SPEC_HOME_AT_END    = { key:'homeAtEnd',       label:'Home at End (G28)',  type:'checkbox' };
const SPEC_HEADER         = { key:'programHeader',   label:'Program Header',     type:'textarea', note:'Custom lines after the main header block' };
const SPEC_FOOTER         = { key:'programFooter',   label:'Program Footer',     type:'textarea', note:'Custom lines before M30 / M2' };

const COMMON_SPEC = [SPEC_UNITS, SPEC_COOLANT, SPEC_SPINDLE_DELAY, SPEC_SAFE_Z, SPEC_TOOL_CHANGE_Z, SPEC_LINE_NUMBERING, SPEC_LINE_INCREMENT, SPEC_HOME_AT_END, SPEC_HEADER, SPEC_FOOTER];

const COMMON_DEFAULTS = {
  units: 'mm', coolant: 'off', spindleDelay: 3, safeZ: 25, toolChangeZ: 50,
  lineNumbering: true, lineIncrement: 10, homeAtEnd: false,
  programHeader: '', programFooter: '',
};

// ── Hook utilities ────────────────────────────────────────────────────────────

function pushFooter(arr, { cfg }) {
  if (cfg.programFooter) { arr.push(''); cfg.programFooter.split('\n').forEach(l => arr.push(l)); }
}

// ── Masso G3 ─────────────────────────────────────────────────────────────────
// - No G43/G49 (Masso handles tool offsets internally)
// - T# M6 format
// - G4 P in milliseconds

const massoG3Hooks = {
  programStart: ({ cfg, n }) => {
    const ls = [
      '%',
      `(DMDCAM - Masso G3 - Generated ${new Date().toLocaleString()})`,
      `(Units: ${cfg.units === 'mm' ? 'Metric mm' : 'Imperial inch'})`,
      '',
      `${n()}${cfg.units === 'mm' ? 'G21' : 'G20'}`,
      `${n()}G90 G17 G94`,
    ];
    if (cfg.wcs) ls.push(`${n()}${cfg.wcs} (Work offset)`);
    ls.push('(NOTE: No G43/G49 — Masso handles tool offsets internally)');
    if (cfg.programHeader) { ls.push('', '(--- Custom Header ---)'); cfg.programHeader.split('\n').forEach(l => ls.push(l)); }
    return ls;
  },
  toolChange: ({ _resolvedNum, name }, { cfg, n, fmt }) => {
    const ls = [
      `${n()}G0 Z${fmt(cfg.toolChangeZ)} (Retract)`,
      `${n()}M5 (Spindle off)`,
    ];
    if (cfg.coolant !== 'off') ls.push(`${n()}M9 (Coolant off)`);
    ls.push(`${n()}T${_resolvedNum} M6 (Tool: ${name || ''})`);
    return ls;
  },
  spindleOn: (rpm, { cfg, n }) => {
    const ls = [`${n()}S${rpm} M3`];
    if (cfg.spindleDelay > 0) ls.push(`${n()}G4 P${Math.round(cfg.spindleDelay * 1000)}`);
    return ls;
  },
  coolantOn: ({ cfg, n }) => {
    if (cfg.coolant === 'flood') return [`${n()}M8`];
    if (cfg.coolant === 'mist')  return [`${n()}M7`];
    return [];
  },
  subPassChange: (sub, { cfg, n, fmt }) => {
    const ls = [
      `${n()}G0 Z${fmt(cfg.safeZ)}`,
      `${n()}M5`,
      `${n()}M0 (Install: ${sub.toolDesc || sub.name})`,
      `${n()}S${sub.rpm || 18000} M3`,
    ];
    if (cfg.spindleDelay > 0) ls.push(`${n()}G4 P${Math.round(cfg.spindleDelay * 1000)}`);
    return ls;
  },
  programEnd: (ctx) => {
    const { cfg, n, fmt } = ctx;
    const ls = [`${n()}M5 (Spindle off)`];
    if (cfg.coolant !== 'off') ls.push(`${n()}M9 (Coolant off)`);
    if (cfg.homeAtEnd) {
      ls.push(`${n()}G0 Z${fmt(cfg.toolChangeZ)}`);
      ls.push(`${n()}G28 (Return to machine home)`);
    } else {
      ls.push(`${n()}G0 Z${fmt(cfg.safeZ)}`);
    }
    pushFooter(ls, ctx);
    ls.push(`${n()}M30`);
    ls.push('%');
    return ls;
  },
};

// ── LinuxCNC ──────────────────────────────────────────────────────────────────
// - G43/G49 tool length compensation (optional)
// - M3 S{rpm} order (M-code before S-word)
// - G4 P in seconds
// - M2 or M30 end code

const linuxcncHooks = {
  programStart: ({ cfg, n }) => {
    const ls = [
      '%',
      `(DMDCAM - LinuxCNC - Generated ${new Date().toLocaleString()})`,
      `(Units: ${cfg.units === 'mm' ? 'Metric mm' : 'Imperial inch'})`,
      '',
      `${n()}${cfg.units === 'mm' ? 'G21' : 'G20'}`,
      `${n()}G90 G17 G94 G40 G49`,
    ];
    if (cfg.wcs) ls.push(`${n()}${cfg.wcs}`);
    if (cfg.programHeader) { ls.push('', '(--- Custom Header ---)'); cfg.programHeader.split('\n').forEach(l => ls.push(l)); }
    return ls;
  },
  toolChange: ({ _resolvedNum, name }, { cfg, n, fmt }) => {
    const ls = [
      `${n()}G0 Z${fmt(cfg.toolChangeZ)}`,
      `${n()}M5`,
    ];
    if (cfg.coolant !== 'off') ls.push(`${n()}M9`);
    ls.push(`${n()}G49 (Cancel tool length comp)`);
    ls.push(`${n()}T${_resolvedNum} M6 (${name || 'Tool change'})`);
    if (cfg.toolLengthComp) ls.push(`${n()}G43 H${_resolvedNum} (Tool length compensation)`);
    return ls;
  },
  spindleOn: (rpm, { cfg, n }) => {
    const ls = [`${n()}M3 S${rpm}`];
    if (cfg.spindleDelay > 0) ls.push(`${n()}G4 P${cfg.spindleDelay}`);
    return ls;
  },
  coolantOn: ({ cfg, n }) => {
    if (cfg.coolant === 'flood') return [`${n()}M8`];
    if (cfg.coolant === 'mist')  return [`${n()}M7`];
    return [];
  },
  subPassChange: (sub, { cfg, n, fmt }) => {
    const ls = [
      `${n()}G0 Z${fmt(cfg.safeZ)}`,
      `${n()}M5`,
      `${n()}M0 (Install: ${sub.toolDesc || sub.name})`,
      `${n()}M3 S${sub.rpm || 18000}`,
    ];
    if (cfg.spindleDelay > 0) ls.push(`${n()}G4 P${cfg.spindleDelay}`);
    return ls;
  },
  programEnd: (ctx) => {
    const { cfg, n, fmt } = ctx;
    const ls = [`${n()}M5`];
    if (cfg.coolant !== 'off') ls.push(`${n()}M9`);
    if (cfg.toolLengthComp) ls.push(`${n()}G49`);
    if (cfg.homeAtEnd) {
      ls.push(`${n()}G0 Z${fmt(cfg.toolChangeZ)}`);
      ls.push(`${n()}G28`);
    } else {
      ls.push(`${n()}G0 Z${fmt(cfg.safeZ)}`);
    }
    pushFooter(ls, ctx);
    ls.push(`${n()}${cfg.programEndCode || 'M2'}`);
    ls.push('%');
    return ls;
  },
};

// ── GRBL ──────────────────────────────────────────────────────────────────────
// - No automatic tool changes (M0 manual pause)
// - S value is scaled 0–$30 (cfg.maxSpindleSpeed) from real RPM
// - No coolant M-codes by default
// - G4 P in seconds
// - M2 program end, no % delimiters

const grblHooks = {
  programStart: ({ cfg, n }) => {
    const ls = [
      `(DMDCAM - GRBL 1.1 - Generated ${new Date().toLocaleString()})`,
      `(Units: ${cfg.units === 'mm' ? 'mm' : 'inch'})`,
      '',
      `${n()}${cfg.units === 'mm' ? 'G21' : 'G20'}`,
      `${n()}G90 G17 G94`,
    ];
    if (cfg.wcs) ls.push(`${n()}${cfg.wcs}`);
    if (cfg.programHeader) { ls.push(''); cfg.programHeader.split('\n').forEach(l => ls.push(l)); }
    return ls;
  },
  toolChange: ({ _resolvedNum, name }, { cfg, n, fmt }) => [
    `${n()}G0 Z${fmt(cfg.safeZ)}`,
    `${n()}M5`,
    `${n()}M0 (Manual tool change: T${_resolvedNum} ${name || ''})`,
  ],
  spindleOn: (rpm, { cfg, n }) => {
    const maxS = cfg.maxSpindleSpeed || 1000;
    const machineMax = cfg.machineMaxSpindle || 24000;
    const s = Math.min(Math.round((rpm / machineMax) * maxS), maxS);
    const ls = [`${n()}M3 S${s}`];
    if (cfg.spindleDelay > 0) ls.push(`${n()}G4 P${cfg.spindleDelay}`);
    return ls;
  },
  coolantOn: () => [],
  subPassChange: (sub, { cfg, n, fmt }) => [
    `${n()}G0 Z${fmt(cfg.safeZ)}`,
    `${n()}M5`,
    `${n()}M0 (Change to: ${sub.toolDesc || sub.name})`,
  ],
  programEnd: (ctx) => {
    const { cfg, n, fmt } = ctx;
    const ls = [`${n()}M5`, `${n()}G0 Z${fmt(cfg.safeZ)}`];
    pushFooter(ls, ctx);
    ls.push(`${n()}M2`);
    return ls;
  },
};

// ── Mach3 ─────────────────────────────────────────────────────────────────────
// - T# M6 tool change
// - M3 S{rpm} spindle (S after M-code)
// - M8/M9 coolant, G4 P in seconds
// - M30 program end

const mach3Hooks = {
  programStart: ({ cfg, n }) => {
    const ls = [
      '%',
      `(DMDCAM - Mach3 - Generated ${new Date().toLocaleString()})`,
      `(Units: ${cfg.units === 'mm' ? 'Metric mm' : 'Imperial inch'})`,
      '',
      `${n()}${cfg.units === 'mm' ? 'G21' : 'G20'}`,
      `${n()}G90 G17 G94`,
    ];
    if (cfg.wcs) ls.push(`${n()}${cfg.wcs}`);
    if (cfg.programHeader) { ls.push('', '(--- Custom Header ---)'); cfg.programHeader.split('\n').forEach(l => ls.push(l)); }
    return ls;
  },
  toolChange: ({ _resolvedNum, name }, { cfg, n, fmt }) => {
    const ls = [
      `${n()}G0 Z${fmt(cfg.toolChangeZ)}`,
      `${n()}M5`,
    ];
    if (cfg.coolant !== 'off') ls.push(`${n()}M9`);
    ls.push(`${n()}T${_resolvedNum} M6 (${name || 'Tool change'})`);
    return ls;
  },
  spindleOn: (rpm, { cfg, n }) => {
    const ls = [`${n()}M3 S${rpm}`];
    if (cfg.spindleDelay > 0) ls.push(`${n()}G4 P${cfg.spindleDelay}`);
    return ls;
  },
  coolantOn: ({ cfg, n }) => {
    if (cfg.coolant === 'flood') return [`${n()}M8`];
    if (cfg.coolant === 'mist')  return [`${n()}M7`];
    return [];
  },
  subPassChange: (sub, { cfg, n, fmt }) => {
    const ls = [
      `${n()}G0 Z${fmt(cfg.safeZ)}`,
      `${n()}M5`,
      `${n()}M0 (Install: ${sub.toolDesc || sub.name})`,
      `${n()}M3 S${sub.rpm || 18000}`,
    ];
    if (cfg.spindleDelay > 0) ls.push(`${n()}G4 P${cfg.spindleDelay}`);
    return ls;
  },
  programEnd: (ctx) => {
    const { cfg, n, fmt } = ctx;
    const ls = [`${n()}M5`];
    if (cfg.coolant !== 'off') ls.push(`${n()}M9`);
    if (cfg.homeAtEnd) {
      ls.push(`${n()}G0 Z${fmt(cfg.toolChangeZ)}`);
      ls.push(`${n()}G28`);
    } else {
      ls.push(`${n()}G0 Z${fmt(cfg.safeZ)}`);
    }
    pushFooter(ls, ctx);
    ls.push(`${n()}M30`);
    ls.push('%');
    return ls;
  },
};

// ── Mach4, UCCNC, Centroid CNC12 ─────────────────────────────────────────────
// These share the same tool change / spindle / coolant / footer as Mach3.
// Only the program start comment differs.

function makeMach3Variant(controllerName) {
  return {
    ...mach3Hooks,
    programStart: ({ cfg, n }) => {
      const ls = [
        '%',
        `(DMDCAM - ${controllerName} - Generated ${new Date().toLocaleString()})`,
        `(Units: ${cfg.units === 'mm' ? 'Metric mm' : 'Imperial inch'})`,
        '',
        `${n()}${cfg.units === 'mm' ? 'G21' : 'G20'}`,
        `${n()}G90 G17 G94`,
      ];
      if (cfg.wcs) ls.push(`${n()}${cfg.wcs}`);
      if (cfg.programHeader) { ls.push('', '(--- Custom Header ---)'); cfg.programHeader.split('\n').forEach(l => ls.push(l)); }
      return ls;
    },
  };
}

const mach4Hooks    = makeMach3Variant('Mach4');
const uccncHooks    = makeMach3Variant('UCCNC');
const centroidHooks = makeMach3Variant('Centroid CNC12');

// ── Post-Processor Registry ───────────────────────────────────────────────────

export const POST_PROCESSORS = {
  massoG3: {
    id: 'massoG3',
    label: 'Masso G3',
    description: 'Masso G3 CNC controller (Fanuc dialect, no G43/G49)',
    defaultSettings: { ...COMMON_DEFAULTS },
    settingsSpec: COMMON_SPEC,
    hooks: massoG3Hooks,
  },
  linuxcnc: {
    id: 'linuxcnc',
    label: 'LinuxCNC',
    description: 'LinuxCNC (formerly EMC2) — supports G43/G49 tool length comp',
    defaultSettings: { ...COMMON_DEFAULTS, toolLengthComp: true, programEndCode: 'M2' },
    settingsSpec: [
      SPEC_UNITS, SPEC_COOLANT, SPEC_SPINDLE_DELAY, SPEC_SAFE_Z, SPEC_TOOL_CHANGE_Z,
      { key:'toolLengthComp',  label:'Tool Length Comp (G43)', type:'checkbox', note:'Emit G43 H# after each tool change' },
      { key:'programEndCode',  label:'Program End Code',       type:'select',   options:[{v:'M2',l:'M2 — end program'},{v:'M30',l:'M30 — end + rewind'}] },
      SPEC_LINE_NUMBERING, SPEC_LINE_INCREMENT, SPEC_HOME_AT_END, SPEC_HEADER, SPEC_FOOTER,
    ],
    hooks: linuxcncHooks,
  },
  grbl: {
    id: 'grbl',
    label: 'GRBL',
    description: 'GRBL 1.1 — hobby CNC, laser cutters. Single-tool or M0 manual change.',
    defaultSettings: { ...COMMON_DEFAULTS, coolant: 'off', maxSpindleSpeed: 1000, machineMaxSpindle: 24000 },
    settingsSpec: [
      SPEC_UNITS, SPEC_SPINDLE_DELAY, SPEC_SAFE_Z,
      { key:'maxSpindleSpeed',   label:'GRBL Max S ($30)',   type:'number', min:1, max:10000, step:1,    note:'$30 firmware setting (usually 1000)' },
      { key:'machineMaxSpindle', label:'Machine Max RPM',    type:'number', min:1000, max:60000, step:1000, note:'Real RPM at S=max — used to scale output' },
      SPEC_LINE_NUMBERING, SPEC_LINE_INCREMENT, SPEC_HEADER, SPEC_FOOTER,
    ],
    hooks: grblHooks,
  },
  mach3: {
    id: 'mach3',
    label: 'Mach3',
    description: 'Mach3 CNC controller',
    defaultSettings: { ...COMMON_DEFAULTS },
    settingsSpec: COMMON_SPEC,
    hooks: mach3Hooks,
  },
  mach4: {
    id: 'mach4',
    label: 'Mach4',
    description: 'Mach4 CNC controller',
    defaultSettings: { ...COMMON_DEFAULTS },
    settingsSpec: COMMON_SPEC,
    hooks: mach4Hooks,
  },
  uccnc: {
    id: 'uccnc',
    label: 'UCCNC',
    description: 'UCCNC motion controller',
    defaultSettings: { ...COMMON_DEFAULTS },
    settingsSpec: COMMON_SPEC,
    hooks: uccncHooks,
  },
  centroid: {
    id: 'centroid',
    label: 'Centroid CNC12',
    description: 'Centroid CNC12 controller',
    defaultSettings: { ...COMMON_DEFAULTS },
    settingsSpec: COMMON_SPEC,
    hooks: centroidHooks,
  },
};

export const PP_LIST = Object.values(POST_PROCESSORS);

// Dispatch to the correct post-processor by ID.
export function generateForPP(ppId, operations, cfg) {
  const pp = POST_PROCESSORS[ppId] || POST_PROCESSORS.massoG3;
  return coreGenerate(operations, cfg, pp.hooks);
}
