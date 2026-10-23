// Plasma material library for the PLASMA screen.
//
// Same ids, names and numbers as the DMD-C3 Plasma Control app's default
// Material Library, so a posted program's material tag
//   (DMD-C3 material: mild-steel | 1-8 | Mild Steel 1/8" | kerf 0.0450)
// is picked automatically there (F6 → F2). Kerf, cut feed and lead-in shape
// the path. Amps, arc volts, pierce delay and pierce/cut heights are for
// posts that put them in the program (CommandCNC); the DMD-C3 app keeps its
// own. Values are inches, like the Plasma app's library; the Plasma Cut
// operation converts to mm.

export const DEFAULT_PLASMA_MATERIALS = [
  {
    id: 'mild-steel',
    name: 'Mild Steel',
    thicknesses: [
      { id: '16ga', label: '16 ga', kerfIn: 0.04, feedInMin: 180, leadInLengthIn: 0.12, leadStyle: 'arc' },
      { id: '1-8', label: '1/8"', kerfIn: 0.045, feedInMin: 140, leadInLengthIn: 0.14, leadStyle: 'arc' },
      // Hypertherm Powermax 65 cut charts (shielded consumables).
      { id: '14ga', label: '14 ga (0.075") 45A shielded', kerfIn: 0.055, feedInMin: 270, leadInLengthIn: 0.15, leadStyle: 'arc', amps: 45, process: '45A Shielded', pierceDelayS: 0.2, pierceHeightIn: 0.15, cutHeightIn: 0.06, arcVolts: 130 },
      { id: '12ga', label: '12 ga (0.105") 45A shielded', kerfIn: 0.058, feedInMin: 190, leadInLengthIn: 0.15, leadStyle: 'arc', amps: 45, process: '45A Shielded', pierceDelayS: 0.4, pierceHeightIn: 0.15, cutHeightIn: 0.06, arcVolts: 133 },
      { id: '10ga', label: '10 ga (0.135") 65A shielded', kerfIn: 0.065, feedInMin: 190, leadInLengthIn: 0.15, leadStyle: 'arc', amps: 65, process: '65A Shielded', pierceDelayS: 0.1, pierceHeightIn: 0.15, cutHeightIn: 0.06, arcVolts: 125 },
      { id: '3-16', label: '3/16"', kerfIn: 0.05, feedInMin: 95, leadInLengthIn: 0.15, leadStyle: 'arc' },
      { id: '1-4', label: '1/4"', kerfIn: 0.055, feedInMin: 70, leadInLengthIn: 0.17, leadStyle: 'arc' },
      { id: '3-8', label: '3/8"', kerfIn: 0.065, feedInMin: 38, leadInLengthIn: 0.2, leadStyle: 'arc' },
    ],
  },
  {
    id: 'stainless-steel',
    name: 'Stainless Steel',
    thicknesses: [{ id: '1-8', label: '1/8"', kerfIn: 0.045, feedInMin: 110, leadInLengthIn: 0.14, leadStyle: 'arc' }],
  },
  {
    id: 'aluminum',
    name: 'Aluminum',
    thicknesses: [{ id: '1-8', label: '1/8"', kerfIn: 0.05, feedInMin: 160, leadInLengthIn: 0.15, leadStyle: 'arc' }],
  },
];

const STORE_KEY = 'plasmaMaterials';

export async function loadPlasmaMaterials() {
  try {
    const saved = await window.electron?.storeGet?.(STORE_KEY);
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {
    // fall through to the defaults
  }
  return DEFAULT_PLASMA_MATERIALS;
}

export async function savePlasmaMaterials(materials) {
  await window.electron?.storeSet?.(STORE_KEY, materials);
}

export function findThickness(materials, materialId, thicknessId) {
  const material = materials.find(m => m.id === materialId);
  const thickness = material?.thicknesses.find(t => t.id === thicknessId);
  return material && thickness ? { material, thickness } : null;
}

/** Operation params (mm) for a library entry. */
export function paramsFromThickness(thickness) {
  return {
    kerf: thickness.kerfIn * 25.4,
    feedRate: thickness.feedInMin * 25.4,
    leadInLength: thickness.leadInLengthIn * 25.4,
    leadInStyle: thickness.leadStyle || 'arc',
  };
}

// Used when a thickness has no value of its own (Hypertherm's usual 0.15" / 0.06").
const CUT_FALLBACK = { pierceHeightIn: 0.15, cutHeightIn: 0.06, pierceDelayS: 0.5 };

/** Per-cut torch values for a Plasma Cut's material (mm, seconds, volts, amps) — what op._cut holds for the posts. */
export function cutSettingsFor(materials, params = {}) {
  const t = findThickness(materials, params.materialId, params.thicknessId)?.thickness || {};
  return {
    pierceHeight: (t.pierceHeightIn ?? CUT_FALLBACK.pierceHeightIn) * 25.4,
    cutHeight: (t.cutHeightIn ?? CUT_FALLBACK.cutHeightIn) * 25.4,
    pierceDelay: t.pierceDelayS ?? CUT_FALLBACK.pierceDelayS,
    volts: t.arcVolts || 0,
    amps: t.amps || 0,
  };
}

const MACHINE_KEY = 'plasmaMachine';

/** The PLASMA screen's machine: { postProcessor, settings: { [postId]: {...} } } (lengths mm). */
export async function loadPlasmaMachine() {
  try {
    const saved = await window.electron?.storeGet?.(MACHINE_KEY);
    if (saved && saved.postProcessor) return { settings: {}, ...saved };
  } catch {
    // fall through to the default
  }
  return { postProcessor: 'dmdPlasma', settings: {} };
}

export async function savePlasmaMachine(machine) {
  await window.electron?.storeSet?.(MACHINE_KEY, machine);
}

/** The Plasma app's material tag line (kerf in inches) — see its shared/gcode/programMaterial.ts. */
export function materialTagLine({ materialId, thicknessId, name, kerfMm }) {
  const clean = s => String(s ?? '').replace(/[()|]/g, ' ').replace(/\s+/g, ' ').trim() || '-';
  return `(DMD-C3 material: ${clean(materialId)} | ${clean(thicknessId)} | ${clean(name)} | kerf ${(kerfMm / 25.4).toFixed(4)})`;
}
