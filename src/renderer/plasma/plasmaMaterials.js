// Plasma material library for the PLASMA screen.
//
// Same ids, names and numbers as the DMD-C3 Plasma Control app's default
// Material Library, so a posted program's material tag
//   (DMD-C3 material: mild-steel | 1-8 | Mild Steel 1/8" | kerf 0.0450)
// is picked automatically there (F6 → F2). Only what DMDCAM needs for the
// path lives here — kerf, cut feed, lead-in; pierce/cut heights and pierce
// delay stay in the Plasma app. Values are inches, like the Plasma app's
// library; the Plasma Cut operation converts to mm.

export const DEFAULT_PLASMA_MATERIALS = [
  {
    id: 'mild-steel',
    name: 'Mild Steel',
    thicknesses: [
      { id: '16ga', label: '16 ga', kerfIn: 0.04, feedInMin: 180, leadInLengthIn: 0.12, leadStyle: 'arc' },
      { id: '1-8', label: '1/8"', kerfIn: 0.045, feedInMin: 140, leadInLengthIn: 0.14, leadStyle: 'arc' },
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

/** The Plasma app's material tag line (kerf in inches) — see its shared/gcode/programMaterial.ts. */
export function materialTagLine({ materialId, thicknessId, name, kerfMm }) {
  const clean = s => String(s ?? '').replace(/[()|]/g, ' ').replace(/\s+/g, ' ').trim() || '-';
  return `(DMD-C3 material: ${clean(materialId)} | ${clean(thicknessId)} | ${clean(name)} | kerf ${(kerfMm / 25.4).toFixed(4)})`;
}
