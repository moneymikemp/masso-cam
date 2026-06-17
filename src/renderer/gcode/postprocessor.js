// Post-processor dispatch layer.
// All move-emission logic lives in postProcessors.js (coreGenerate + hooks).
// This file keeps its original public API so callers don't change.

import { generateForPP } from './postProcessors';

export const DEFAULT_POST_CONFIG = {
  name: 'Masso G3',
  postProcessor: 'massoG3',
  units: 'mm',
  coolant: 'off',
  spindleDelay: 3,
  lineNumbering: true,
  lineIncrement: 10,
  decimals: 3,
  safeZ: 25.0,
  toolChangeZ: 50.0,
  homeAtEnd: false,
  homeX: 0,
  homeY: 0,
  programHeader: '',
  programFooter: '',
  toolNumbers: {},
};

export function generateGcode(operations, postConfig = {}) {
  const cfg = { ...DEFAULT_POST_CONFIG, ...postConfig };
  return generateForPP(cfg.postProcessor || 'massoG3', operations, cfg);
}

// ── Tool-split export helper ───────────────────────────────────────────────────

// String values used as sub-pass toolKey when no library tool has been assigned.
const BUILTIN_SUB_KEYS = new Set(['taper', 'detailEndmill', 'bulkEndmill']);

function resolveOpToolKey(op, tools) {
  if (!op.toolId) return { key: '__notool', toolNum: null };
  const t = tools.find(t => String(t.id) === String(op.toolId));
  return t ? { key: String(op.toolId), toolNum: t.tool_number ?? null }
           : { key: String(op.toolId), toolNum: null };
}

function resolveSubToolKey(sub, tools) {
  const k = sub.toolKey;
  if (k && !BUILTIN_SUB_KEYS.has(k)) {
    const t = tools.find(t => String(t.id) === String(k));
    return t ? { key: String(k), toolNum: t.tool_number ?? null }
             : { key: String(k), toolNum: null };
  }
  return { key: k || '__notool', toolNum: null };
}

/**
 * Group ops (and, for tapered ops, individual sub-passes) by physical tool.
 * Returns [{toolNum, ops[]}] sorted by toolNum, where `ops` may contain
 * synthetic versions of tapered ops restricted to one tool's sub-passes.
 *
 * Library-assigned tools use their tool_number. Unassigned tools (string
 * keys or missing toolId) receive sequential numbers that avoid conflicts
 * with any library numbers already in use.
 */
function buildToolGroups(ops, tools) {
  const byKey   = new Map(); // groupKey → { toolNum, ops[] }
  const libNums = new Set(); // tool_numbers already claimed by library tools

  function group(key, toolNum) {
    if (!byKey.has(key)) byKey.set(key, { toolNum: null, ops: [] });
    const g = byKey.get(key);
    if (toolNum != null && g.toolNum == null) { g.toolNum = toolNum; libNums.add(toolNum); }
    return g;
  }

  for (const op of ops) {
    if (op.toolpath?.subToolpaths?.length > 0) {
      // Tapered op: split sub-passes by tool, create a virtual op per group.
      const subsByKey = new Map();
      for (const sub of op.toolpath.subToolpaths) {
        if (!sub.moves?.length) continue;
        const { key, toolNum } = resolveSubToolKey(sub, tools);
        if (!subsByKey.has(key)) subsByKey.set(key, { toolNum, subs: [] });
        subsByKey.get(key).subs.push(sub);
      }
      for (const [key, { toolNum, subs }] of subsByKey) {
        group(key, toolNum).ops.push({
          ...op,
          toolpath: { ...op.toolpath, subToolpaths: subs, moves: subs.flatMap(s => s.moves) },
        });
      }
    } else {
      const { key, toolNum } = resolveOpToolKey(op, tools);
      group(key, toolNum).ops.push(op);
    }
  }

  // Assign sequential T-numbers to groups without a library tool number,
  // skipping any numbers already taken by library tools.
  let seq = 1;
  for (const g of byKey.values()) {
    if (g.toolNum == null) {
      while (libNums.has(seq)) seq++;
      g.toolNum = seq++;
    }
  }

  return [...byKey.values()].sort((a, b) => a.toolNum - b.toolNum);
}

/**
 * Generate G-code split by tool number.
 *
 * Returns [{suffix, gcode}]:
 *   [{suffix:'',    gcode}]            — all ops share one tool (or none assigned)
 *   [{suffix:'_T1', gcode}, ...]       — one entry per tool, sorted by T-number
 *
 * Tapered operations are split at the sub-pass level so each physical tool
 * (taper bit, detail endmill, bulk endmill) gets its own file.
 *
 * @param {object[]} ops        - enabled, calculated operations
 * @param {object[]} tools      - tool library from db-get-tools (may be [])
 * @param {object}   postConfig - post-processor config
 */
export function generateGcodeByTool(ops, tools, postConfig) {
  const groups = buildToolGroups(ops, tools || []);
  if (groups.length <= 1) {
    return [{ suffix: '', gcode: generateGcode(ops, postConfig) }];
  }
  return groups.map(g => ({
    suffix: `_T${g.toolNum}`,
    gcode:  generateGcode(g.ops, postConfig),
  }));
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
