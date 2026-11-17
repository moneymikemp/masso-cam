import React, { useState, useMemo, useRef, useEffect } from 'react';
import { v4 as uuid } from 'uuid';
import { parseDxf, scaleEntities } from '../../dxf/parser';
import { parseSvg } from '../../svg/parser';
import { translateEntity } from '../../cam/offsetEngine';
import { nestPartsFromEntities, entityToProfile, generateToolpath } from '../../cam/toolpath';
import { outsideLead } from '../../cam/plasmaToolpath';
import { nestSheets, nestConflicts, bumpDistance } from '../../plasma/nesting';
import { placeEntity, placePoint } from '../../plasma/placement';
import { loadPlasmaMaterials, findThickness, paramsFromThickness } from '../../plasma/plasmaMaterials';
import { getDefaultParams } from '../../store/AppContext';

// Nest (PLASMA screen → ▦ Nest), a part list like ProNest's Edit Part List.
// Parts come from DXF/SVG files or from the drawing (one file or drawing can
// hold several — each outermost outline is a part) and live in the project
// (state.partList), with a quantity (or Fill: as many as the sheet has room
// for), material, priority and rotation each. Nest groups the parts by
// material — a material sets the kerf and lead-in, so thicknesses never
// share a sheet — and fills the sheet sizes you enter, as many sheets as it
// takes (plasma/nesting.js nestSheets). Apply lays the sheets out side by
// side in the drawing, with a calculated Plasma Cut per sheet, replacing
// the drawing's own copies of parts taken from it; 💾 Plasma G-code then
// writes a program per sheet. Two tabs: ① Parts (the list) and ② Nest (sheet
// sizes, spacing and the result, which zooms and pans).

const MM = 25.4;
const PREFS_KEY = 'dmdcam.partlist';
const SHEET_GAP = 2 * MM; // between sheets in the drawing

const S = {
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' },
  box: { background:'#1a1a38', border:'1px solid #3a3a70', borderRadius:8, padding:'16px 20px', width:'98vw', height:'95vh', display:'flex', flexDirection:'column', color:'#ccc', fontFamily:'system-ui,sans-serif' },
  title: { fontSize:15, fontWeight:700, color:'#ffbb66', marginBottom:10, display:'flex', alignItems:'center', gap:10 },
  bar: { display:'flex', gap:8, alignItems:'center', marginBottom:8 },
  tableWrap: { flex:1, minHeight:120, overflowY:'auto', background:'#0d0d20', border:'1px solid #2a2a50', borderRadius:4 },
  th: { position:'sticky', top:0, background:'#14142c', fontSize:10, color:'#8888aa', textAlign:'left', padding:'5px 6px', fontWeight:600, borderBottom:'1px solid #2a2a50' },
  td: { padding:'3px 6px', fontSize:12, borderBottom:'1px solid #1c1c3a', verticalAlign:'middle' },
  input: { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:3, padding:'3px 6px', fontSize:12, boxSizing:'border-box' },
  lower: { flex:1, minHeight:0, display:'flex', gap:14 },
  side: { width:330, flexShrink:0, overflowY:'auto' },
  section: { fontSize:10, fontWeight:700, color:'#8888aa', textTransform:'uppercase', letterSpacing:0.5, margin:'8px 0 6px' },
  grid: { display:'grid', gridTemplateColumns:'130px 1fr', gap:'6px 10px', alignItems:'center' },
  label: { fontSize:11, color:'#8888aa', textAlign:'right' },
  preview: { flex:1, minWidth:0, display:'flex', flexDirection:'column', background:'#0d0d22', border:'1px solid #1a1a40', borderRadius:4, padding:8 },
  tab: active => ({ padding:'4px 10px', fontSize:11, cursor:'pointer', borderRadius:3, whiteSpace:'nowrap', color: active ? '#fff' : '#aaaacc', background: active ? '#5a4a2a' : '#22224a', border:'1px solid #3a3a60' }),
  btn: { padding:'6px 14px', borderRadius:4, cursor:'pointer', fontSize:12, border:'none' },
  primary: { background:'#aa6a2a', color:'#fff' },
  secondary: { background:'#2a2a4a', color:'#aaa', border:'1px solid #3a3a60' },
  link: { background:'none', border:'none', color:'#88aaff', cursor:'pointer', fontSize:12, padding:'2px 0' },
  warn: { fontSize:11, color:'#cc8866' },
  drop: { outline:'2px dashed #aa6a2a', outlineOffset:-4 },
  trayRow: { display:'flex', alignItems:'center', gap:8, padding:'3px 6px', marginBottom:3, background:'#14142c', border:'1px solid #2a2a50', borderRadius:4, cursor:'grab', userSelect:'none' },
};

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* per-viewer convenience only */ }
}

function fileBase(path) {
  return String(path).split(/[\\/]/).pop().replace(/\.(dxf|svg)$/i, '');
}

/** The quantity a file name asks for — "Cross Plate x 4", "Gusset X2", "Plate x4.dwg" — else 1. */
function qtyFromName(name) {
  const m = /(?:^|[\s_-])x\s*(\d{1,4})\s*(?:\.dwg)?$/i.exec(name.trim());
  return m && +m[1] > 0 ? +m[1] : 1;
}

/** Parts found in entities: each outermost outline with everything inside it, moved so its corner is at 0,0 (mm). */
function partsFromEntities(entities, ids, name) {
  const { parts, loose } = nestPartsFromEntities(entities, ids);
  const byId = new Map(entities.map(e => [e.id, e]));
  return {
    loose,
    parts: parts.map((p, i) => {
      const minX = Math.min(...p.outline.map(q => q.x)), minY = Math.min(...p.outline.map(q => q.y));
      const ents = p.ids.map(id => byId.get(id)).filter(Boolean).map(e => {
        const moved = translateEntity(e, -minX, -minY);
        delete moved.leadAt; delete moved.nestSheet;
        return moved;
      });
      return { name: parts.length > 1 ? `${name} (${i + 1})` : name, sourceIndex: i, sourceIds: p.ids, entities: ents };
    }),
  };
}

/** A DXF/SVG file's parts. */
function partsFromFile(path, content, isInch) {
  let entities;
  if (/\.svg$/i.test(path)) {
    entities = parseSvg(content).entities;
  } else {
    const dxf = parseDxf(content);
    // A unitless DXF is taken to be in the app's units.
    entities = dxf.dxfUnits === 'unitless' && isInch ? scaleEntities(dxf.entities, MM) : dxf.entities;
  }
  const r = partsFromEntities(entities, null, fileBase(path));
  return { loose: r.loose, parts: r.parts.map(({ sourceIds, ...p }) => ({ ...p, path })) };
}

/**
 * Identical parts (same outline size and area, same entity count — in the
 * same orientation) as one part with a quantity, e.g. a drawing that is
 * already a sheet of stakes.
 */
function groupIdentical(parts) {
  const out = [];
  const byKey = new Map();
  for (const p of parts) {
    const sh = partShape(p);
    const key = sh && `${p.entities.length}|${sh.w.toFixed(2)}|${sh.h.toFixed(2)}|${Math.abs(sh.area).toFixed(0)}`;
    const same = key && byKey.get(key);
    if (same) { same.qty += p.qty; same.sourceIds = [...same.sourceIds, ...p.sourceIds]; continue; }
    const copy = { ...p };
    if (key) byKey.set(key, copy);
    out.push(copy);
  }
  return out;
}

/** Outline and size of a list part (its entities form exactly one part). */
function partShape(part) {
  const found = nestPartsFromEntities(part.entities).parts[0];
  if (!found) return null;
  const xs = found.outline.map(q => q.x), ys = found.outline.map(q => q.y);
  return { ...found, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function Thumb({ part }) {
  const d = useMemo(() => {
    const paths = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of part.entities) {
      const pts = entityToProfile(e);
      if (!pts?.length) continue;
      for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
      paths.push(pts);
    }
    return { paths, minX, minY, w: maxX - minX || 1, h: maxY - minY || 1 };
  }, [part.entities]);
  return (
    <svg viewBox={`${d.minX} ${-d.minY - d.h} ${d.w} ${d.h}`} style={{ width:56, height:32, display:'block' }} preserveAspectRatio="xMidYMid meet">
      {d.paths.map((pts, i) => <path key={i} d={pts.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)},${(-p.y).toFixed(1)}`).join('')} fill="none" stroke="#55dd77" strokeWidth={Math.max(d.w, d.h) / 60} />)}
    </svg>
  );
}

export default function PartListModal({ partList, entities, selectedEntityIds, activeWorkspaceId, stockConfig, table, isInch, dispatch, onClose }) {
  const { origin = 'll', longAxis = 'y', travelX = 0, travelY = 0 } = table || {};
  const prefs = useMemo(loadPrefs, []);
  const toDisp = v => (isInch ? +(v / MM).toFixed(4) : +v.toFixed(2));
  const toMM = v => (isInch ? v * MM : v);
  const unit = isInch ? 'in' : 'mm';
  const fmt = mm => `${toDisp(mm)}${isInch ? '"' : ' mm'}`;

  const [lib, setLib] = useState([]);
  useEffect(() => { loadPlasmaMaterials().then(setLib); }, []);
  const matName = key => {
    const [m, t] = (key || '').split('|');
    const found = findThickness(lib, m, t);
    return found ? `${found.material.name} ${found.thickness.label}` : null;
  };

  // Sheets and spacing (mm), remembered between sessions.
  const [sheets, setSheets] = useState(() => (prefs.sheets || [{ w: 96 * MM, l: 48 * MM, count: 0 }]).map(s => ({ w: toDisp(s.w), l: toDisp(s.l), count: s.count || '', turn: !!s.turn })));
  const [margin, setMargin] = useState(toDisp(prefs.margin ?? 0.1 * MM));
  const [spacing, setSpacing] = useState(toDisp(prefs.spacing ?? 0.1 * MM));
  const [pierceSep, setPierceSep] = useState(toDisp(prefs.pierceSep ?? 0.1 * MM));
  const [angleStep, setAngleStep] = useState(prefs.angleStep ?? 5);
  const [pairs, setPairs] = useState(prefs.pairs ?? true);

  const [message, setMessage] = useState('');
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState(null); // [{ materialKey, materialName, thickness, cut, parts, res }]
  const [sheetIdx, setSheetIdx] = useState(0);
  const [tab, setTab] = useState('parts'); // 'parts' | 'nest'
  const cancelled = useRef(false);
  const closed = useRef(false);
  useEffect(() => () => { cancelled.current = closed.current = true; }, []);

  const shapes = useMemo(() => new Map(partList.map(p => [p.id, partShape(p)])), [partList]);

  function setList(next) {
    dispatch({ type: 'SET_PART_LIST', payload: next });
    setResults(null);
  }
  const update = (id, changes) => setList(partList.map(p => (p.id === id ? { ...p, ...changes } : p)));

  // Ticked rows, for setting one material on many parts (none ticked = all).
  const [checked, setChecked] = useState(() => new Set());
  const ticked = partList.filter(p => checked.has(p.id));
  const toggle = id => setChecked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  function setMaterialFor(key) {
    if (!key) return;
    const ids = new Set((ticked.length ? ticked : partList).map(p => p.id));
    setList(partList.map(p => (ids.has(p.id) ? { ...p, materialKey: key } : p)));
    savePrefs({ ...loadPrefs(), lastMaterial: key });
    setMessage(`${matName(key)} on ${ids.size === partList.length ? 'all' : ids.size} part${ids.size === 1 ? '' : 's'}.`);
  }

  function addFiles(files) {
    const added = [];
    let loose = 0, failed = [];
    for (const f of files) {
      try {
        const r = partsFromFile(f.path, f.content, isInch);
        loose += r.loose;
        const qty = qtyFromName(fileBase(f.path));
        for (const p of r.parts) added.push({ id: uuid(), qty, materialKey: prefs.lastMaterial || '', priority: 5, rotation: 'any', ...p });
        if (!r.parts.length) failed.push(fileBase(f.path));
      } catch (err) {
        failed.push(fileBase(f.path));
      }
    }
    if (added.length) setList([...partList, ...added]);
    setMessage([
      added.length && `Added ${added.length} part${added.length === 1 ? '' : 's'}.`,
      failed.length && `No closed outline in: ${failed.join(', ')}.`,
      loose && `${loose} shape${loose === 1 ? '' : 's'} outside any outline left out.`,
    ].filter(Boolean).join(' '));
  }

  // The drawing's parts (the selected ones, if any are selected). Nested
  // sheets from an earlier Apply aren't parts of the drawing.
  function addFromDrawing() {
    const drawing = entities.filter(e => !e.nestSheet);
    const sel = (selectedEntityIds || []).filter(id => drawing.some(e => e.id === id));
    const r = partsFromEntities(drawing, sel, 'Drawing');
    const have = new Set(partList.flatMap(p => p.sourceIds || []));
    const fresh = r.parts.filter(p => !p.sourceIds.some(id => have.has(id)));
    const added = groupIdentical(fresh.map(p => ({ id: uuid(), qty: 1, materialKey: prefs.lastMaterial || '', priority: 5, rotation: 'any', ...p })));
    if (added.length === 1) added[0].name = 'Drawing';
    if (added.length) setList([...partList, ...added]);
    const copies = added.reduce((s, p) => s + p.qty, 0);
    setMessage([
      added.length
        ? `Added ${added.length} part${added.length === 1 ? '' : 's'}${copies > added.length ? ` (${copies} copies)` : ''} from the ${sel.length ? 'selection' : 'drawing'} — Apply replaces ${copies === 1 ? 'it' : 'them'} with the nest.`
        : r.parts.length ? 'Those parts are already in the list.' : 'No closed outlines in the drawing.',
      r.loose && `${r.loose} shape${r.loose === 1 ? '' : 's'} outside any outline left out.`,
    ].filter(Boolean).join(' '));
  }

  async function addParts() {
    try {
      // In a browser (dev server) there's no Electron dialog: use a file input.
      const files = window.electron?.openParts ? await window.electron.openParts() : await new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.dxf,.svg'; input.multiple = true;
        input.onchange = async () => resolve(await Promise.all([...input.files].map(async f => ({ path: f.name, content: await f.text() }))));
        input.click();
      });
      if (files?.length) addFiles(files);
    } catch (err) {
      setMessage(`Couldn't open the file picker (${err.message}) — restart DMDCAM, or drop files on this window.`);
    }
  }

  async function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    setTab('parts');
    const files = [];
    for (const f of e.dataTransfer.files) {
      if (!/\.(dxf|svg)$/i.test(f.name)) continue;
      files.push({ path: f.path || f.name, content: await f.text() });
    }
    if (files.length) addFiles(files);
  }

  // Re-read each part's file; a part keeps its settings and takes the new geometry.
  async function refresh() {
    const next = [];
    let changed = 0, missing = 0;
    const cache = new Map();
    for (const p of partList) {
      if (!p.path || !window.electron?.readPartFile) { next.push(p); continue; }
      if (!cache.has(p.path)) {
        const content = await window.electron.readPartFile(p.path);
        let parsed = null;
        try { parsed = content ? partsFromFile(p.path, content, isInch).parts : null; } catch { parsed = null; }
        cache.set(p.path, parsed);
      }
      const fresh = cache.get(p.path)?.[p.sourceIndex];
      if (fresh) { next.push({ ...p, entities: fresh.entities }); changed++; }
      else { next.push(p); missing++; }
    }
    setList(next);
    setMessage(`Refreshed ${changed} part${changed === 1 ? '' : 's'} from their files${missing ? ` — ${missing} not found` : ''}.`);
  }

  // keepLocked: keep each sheet that has locked parts, those parts where they
  // are, and nest the rest around them (then on to new sheets).
  async function nest(keepLocked = false) {
    // Each sheet turned so its long side runs along the table's length (⚙ Machine),
    // or across it when its ↕/↔ toggle says so.
    const sizes = sheets.map(s => {
      const a = toMM(+s.w), b = toMM(+s.l);
      const alongX = (longAxis === 'x') !== !!s.turn;
      const [w, l] = alongX ? [Math.max(a, b), Math.min(a, b)] : [Math.min(a, b), Math.max(a, b)];
      return { w, l, count: Math.max(0, Math.round(+s.count || 0)), turn: !!s.turn };
    }).filter(s => s.w > 0 && s.l > 0);
    if (!sizes.length) { setMessage('Enter at least one sheet size.'); return; }
    const big = travelX > 0 && travelY > 0 && sizes.find(s => s.w > travelX + 0.5 || s.l > travelY + 0.5);
    const tableNote = big ? `⚠ A ${fmt(big.w)} × ${fmt(big.l)} sheet is bigger than the table travel (${fmt(travelX)} × ${fmt(travelY)}, ⚙ Machine) — parts past it can't be cut.` : '';
    const mm = { margin: toMM(margin), spacing: toMM(spacing), pierceSep: toMM(pierceSep) };
    savePrefs({ ...prefs, sheets: sizes, ...mm, angleStep, pairs });
    const groups = new Map();
    // Re-nesting keeps each material's parts in the same order (placements
    // point at them by index), with the list's current quantities.
    // A part since removed from the list, or moved to another material, keeps its
    // place (and any locked copies) with a quantity of 0.
    if (keepLocked) for (const gr of results || []) groups.set(gr.materialKey, gr.parts.map(p => {
      const now = partList.find(x => x.id === p.id);
      return now && now.materialKey === gr.materialKey ? now : { ...p, qty: 0, fill: false };
    }));
    for (const p of partList) {
      if (!(p.fill || p.qty > 0) || !shapes.get(p.id) || !matName(p.materialKey)) continue;
      if (!groups.has(p.materialKey)) groups.set(p.materialKey, []);
      if (!groups.get(p.materialKey).some(x => x.id === p.id)) groups.get(p.materialKey).push(p);
    }
    if (!groups.size) { setMessage('Give the parts a quantity and a material first.'); return; }
    const prev = keepLocked ? results || [] : [];
    cancelled.current = false;
    setTab('nest');
    setRunning(true);
    setProgress(0);
    setResults(null);
    const out = [];
    try {
      let g = 0;
      for (const [key, parts] of groups) {
        const [materialId, thicknessId] = key.split('|');
        const { material, thickness } = findThickness(lib, materialId, thicknessId);
        const cut = paramsFromThickness(thickness);
        const input = parts.map(p => {
          const sh = shapes.get(p.id) || partShape(p);
          return { outline: sh.outline, lead: outsideLead(sh.outline, cut), qty: p.fill ? 0 : Math.round(p.qty), fill: !!p.fill, priority: p.priority ?? 5, rotation: p.rotation || 'any' };
        });
        const gi = g;
        const before = prev.find(gr => gr.materialKey === key);
        const fixedSheets = (before?.res.sheets || []).filter(sh => sh.placements.some(pl => pl.locked))
          .map(sh => ({ w: sh.w, l: sh.l, placements: sh.placements.filter(pl => pl.locked).map(({ part, angle, x, y }) => ({ part, angle, x, y })) }));
        const res = await nestSheets(input, sizes, {
          fixedSheets,
          ...mm,
          kerf: cut.kerf,
          rotation: 'any',
          angleStep,
          allowPairs: pairs,
          corner: origin, // pack into the corner the table is zeroed at
          onProgress: f => setProgress((gi + f) / groups.size),
          cancelled: () => cancelled.current,
        });
        out.push({ materialKey: key, materialId, thicknessId, materialName: `${material.name} ${thickness.label}`, thickness, cut, parts, leads: input.map(i => i.lead), margin: mm.margin, res,
          // Not on a sheet: what didn't fit, and parts taken off a sheet by hand.
          tray: res.unplaced.flatMap((n, i) => Array.from({ length: n }, () => ({ part: i, angle: 0 }))) });
        g++;
        if (cancelled.current) break;
      }
    } finally {
      if (!closed.current) {
        setRunning(false);
        setResults(out);
        setSheetIdx(0);
        setView(null);
        if (tableNote) setMessage(tableNote);
      }
    }
  }

  // Flattened sheet list across materials, for the tabs and Apply.
  const allSheets = useMemo(() => (results || []).flatMap((gr, gi) => gr.res.sheets.map((sh, k) => ({ group: gr, gi, sheet: sh, k }))), [results]);
  const placedById = useMemo(() => {
    const m = new Map();
    for (const gr of results || []) {
      const counts = gr.parts.map(() => 0);
      for (const sh of gr.res.sheets) for (const pl of sh.placements) counts[pl.part]++;
      gr.parts.forEach((p, i) => m.set(p.id, counts[i]));
    }
    return m;
  }, [results]);
  const unplacedTotal = (results || []).reduce((s, gr) => s + (gr.tray?.length || 0), 0);

  function apply() {
    if (!allSheets.length) return;
    if (allSheets.every(s => !s.sheet.placements.length)) { setMessage('Every sheet is empty — drag parts onto one first.'); return; }
    const red = allSheets.reduce((n, { group, sheet }) => n + nestConflicts(group.res.parts, sheet, group.margin, sheet.placements).size, 0);
    if (red && !window.confirm(`${red} part${red === 1 ? ' is' : 's are'} too close to another part or the sheet edge (red). Apply anyway?`)) return;
    const add = [], ops = [], sheetRects = [];
    // Parts taken from the drawing: the nest replaces the drawing's copies.
    const nested = new Set(allSheets.flatMap(({ group, sheet }) => sheet.placements.map(pl => group.parts[pl.part].id)));
    const remove = new Set(partList.filter(p => nested.has(p.id)).flatMap(p => p.sourceIds || []));
    let x0 = 0;
    for (const { group, sheet, k } of allSheets) {
      if (!sheet.placements.length) continue; // emptied by hand
      const id = uuid();
      const name = `${group.materialName} — Sheet ${k + 1}`;
      const ids = [];
      for (const pl0 of sheet.placements) {
        const pl = { ...pl0, x: pl0.x + x0 };
        const part = group.parts[pl.part];
        const frame = group.res.parts[pl.part];
        const lead = group.leads[pl.part];
        const outlineIds = new Set(shapes.get(part.id).outlineIds);
        const leadAt = lead && placePoint(lead.start, frame, pl);
        for (const e of part.entities) {
          const placed = { ...placeEntity(e, frame, pl), nestSheet: id };
          if (outlineIds.has(e.id) && leadAt) placed.leadAt = leadAt;
          add.push(placed);
          ids.push(placed.id);
        }
      }
      sheetRects.push({ id, name, x: x0, y: 0, w: sheet.w, l: sheet.l });
      ops.push({
        id: uuid(),
        workspaceId: activeWorkspaceId,
        name,
        type: 'plasma',
        enabled: true,
        toolId: null,
        selectedIds: ids,
        params: {
          ...getDefaultParams('plasma'),
          materialId: group.materialId,
          thicknessId: group.thicknessId,
          materialName: group.materialName,
          ...paramsFromThickness(group.thickness),
          sheet: { id, x: x0, y: 0, w: sheet.w, l: sheet.l },
        },
        toolpath: null,
      });
      x0 += sheet.w + SHEET_GAP;
    }
    const finalEntities = [...entities.filter(e => !e.nestSheet && !remove.has(e.id)), ...add];
    for (const op of ops) op.toolpath = generateToolpath(op, finalEntities, { stockConfig, allEntities: finalEntities });
    // The list keeps those parts (their geometry is stored), but they no longer point into the drawing.
    if (remove.size) dispatch({ type: 'SET_PART_LIST', payload: partList.map(p => (p.sourceIds?.some(id => remove.has(id)) ? { ...p, sourceIds: undefined } : p)) });
    dispatch({ type: 'APPLY_PART_NEST', payload: { add, ops, sheets: sheetRects, remove: [...remove] } });
    const first = sheetRects[0];
    dispatch({ type: 'SET_STOCK_CONFIG', payload: { width: first.w, length: first.l, datum: 'bl', stockOriginX: first.x, stockOriginY: first.y, stockOffset: 0 } });
    dispatch({ type: 'SET_STATUS', payload: `Nested ${sheetRects.length} sheet${sheetRects.length === 1 ? '' : 's'} — 💾 Plasma G-code writes one program per sheet` });
    onClose();
  }

  const current = allSheets[sheetIdx];
  // Hand editing. sel: the selected placements (indexes on this sheet).
  // drag = { mode: 'move' | 'rotate' | 'box', ids, orig: Map i → placement,
  // live: Map i → placement (while moving), base: the other parts' conflicts,
  // cx, cy, scale (move), pivot, a0 (rotate), p0, p1 (box, view coords) } —
  // committed to the results on release.
  const [drag, setDrag] = useState(null);
  const [sel, setSel] = useState([]);
  const selSet = useMemo(() => new Set(sel), [sel]);
  useEffect(() => { setSel([]); setDrag(null); }, [sheetIdx, results?.length]);
  const placements = useMemo(() => {
    if (!current) return [];
    return drag?.live ? current.sheet.placements.map((p, i) => drag.live.get(i) || p) : current.sheet.placements;
  }, [current, drag]);
  const sheetConflicts = useMemo(() => (current ? nestConflicts(current.group.res.parts, current.sheet, current.group.margin, current.sheet.placements) : new Set()), [current]);
  const conflicts = useMemo(() => {
    if (!drag?.live || !current) return sheetConflicts;
    const live = nestConflicts(current.group.res.parts, current.sheet, current.group.margin, placements, { only: drag.ids });
    return new Set([...drag.base, ...live]);
  }, [drag, current, placements, sheetConflicts]);
  const previewPaths = useMemo(() => {
    if (!current) return [];
    const { group, sheet } = current;
    return placements.map(pl => {
      const frame = group.res.parts[pl.part];
      const c = Math.cos(pl.angle), s = Math.sin(pl.angle);
      const d = pts => pts.map((q, i) => `${i ? 'L' : 'M'}${(q.x * c - q.y * s + pl.x).toFixed(2)},${(sheet.l - (q.x * s + q.y * c + pl.y)).toFixed(2)}`).join('');
      const lead = group.leads[pl.part];
      return { outline: d(frame.local) + 'Z', lead: lead ? d(lead.leadPts.map(q => ({ x: q.x - frame.cx, y: q.y - frame.cy }))) : null };
    });
  }, [current, placements]);

  // Hand edits to the current sheet's group: its placements and its tray.
  const BUMP_NOTE = 'No clear spot that way before the sheet edge — try another direction, or drag it.';
  const LOCK_NOTE = 'Locked parts stay put — press L (or 🔓 Unlock) to free them.';
  const anyLocked = (results || []).some(gr => gr.res.sheets.some(sh => sh.placements.some(pl => pl.locked)));
  function editCurrent(fn) {
    const { gi, k } = current;
    setMessage(m => (m === BUMP_NOTE || m === LOCK_NOTE ? '' : m)); // a stale warning goes once something moves
    setResults(rs => rs.map((gr, g) => {
      if (g !== gi) return gr;
      const { placements: next, tray } = fn(gr.res.sheets[k].placements, gr.tray || []);
      return { ...gr, tray, res: { ...gr.res, sheets: gr.res.sheets.map((sh, j) => (j !== k ? sh : { ...sh, placements: next })) } };
    }));
  }
  /** changed: Map index → new placement. */
  const setPlacements = changed => editCurrent((ps, tray) => ({ placements: ps.map((p, n) => changed.get(n) || p), tray }));
  // Locked parts don't move: the tools work on the rest of the selection.
  const free = ids => {
    const f = ids.filter(i => !current.sheet.placements[i]?.locked);
    if (!f.length && ids.length) setMessage(LOCK_NOTE);
    return f;
  };
  function toggleLock(ids) {
    const ps = current.sheet.placements;
    const lock = !ids.every(i => ps[i]?.locked);
    setPlacements(new Map(ids.map(i => [i, { ...ps[i], locked: lock }])));
  }
  function takeOff(all) {
    const ids = free(all);
    if (!ids.length) return;
    const out = new Set(ids);
    editCurrent((ps, tray) => ({ placements: ps.filter((_, n) => !out.has(n)), tray: [...tray, ...ps.filter((_, n) => out.has(n)).map(p => ({ part: p.part, angle: p.angle }))] }));
    setSel([]);
  }
  function placeFromTray(part, angle, x, y) {
    const n = current.sheet.placements.length;
    editCurrent((ps, tray) => {
      const t = [...tray];
      const w = t.findIndex(e => e.part === part);
      if (w >= 0) t.splice(w, 1); // none waiting: an extra copy
      return { placements: [...ps, { part, angle, x, y }], tray: t };
    });
    setSel([n]);
  }
  // A part's box on the sheet (sheet coordinates, y up), and a group's.
  const partBox = pl => {
    const local = current.group.res.parts[pl.part].local;
    const c = Math.cos(pl.angle), sn = Math.sin(pl.angle);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of local) {
      const x = q.x * c - q.y * sn + pl.x, y = q.x * sn + q.y * c + pl.y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  };
  const groupBox = (ids, pls) => ids.map(i => partBox(pls[i])).reduce((a, b) => ({
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  }));

  const TAU = 2 * Math.PI;
  const norm = a => ((a % TAU) + TAU) % TAU;
  // A placement turned by da about a point (the part turns with it).
  const turnAbout = (pl, pv, da) => {
    const c = Math.cos(da), sn = Math.sin(da), x = pl.x - pv.x, y = pl.y - pv.y;
    return { ...pl, x: pv.x + x * c - y * sn, y: pv.y + x * sn + y * c, angle: norm(pl.angle + da) };
  };
  const pivotOf = ids => { const b = groupBox(ids, current.sheet.placements); return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; };
  const startState = ids => ({
    ids,
    orig: new Map(ids.map(i => [i, current.sheet.placements[i]])),
    base: nestConflicts(current.group.res.parts, current.sheet, current.group.margin, current.sheet.placements, { skip: ids }),
  });

  // Click a part: select it (Shift/Ctrl+click adds or drops it); drag moves the selection.
  function startDrag(e, i) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.shiftKey || e.ctrlKey) { setSel(s => (s.includes(i) ? s.filter(n => n !== i) : [...s, i])); return; }
    const picked = selSet.has(i) ? sel : [i];
    setSel(picked);
    const ids = free(picked);
    if (!ids.length) return;
    svgRef.current.setPointerCapture(e.pointerId);
    setDrag({ mode: 'move', ...startState(ids), cx: e.clientX, cy: e.clientY, scale: svgRef.current.getScreenCTM().a });
  }
  function turn(all, dir) {
    const ids = free(all);
    if (!ids.length) return;
    const pv = pivotOf(ids);
    setPlacements(new Map(ids.map(i => [i, turnAbout(current.sheet.placements[i], pv, (dir * Math.PI) / 2)])));
  }
  function nudge(all, dx, dy, step) {
    const ids = free(all);
    if (!ids.length) return;
    setPlacements(new Map(ids.map(i => { const pl = current.sheet.placements[i]; return [i, { ...pl, x: pl.x + dx * step, y: pl.y + dy * step }]; })));
  }
  function bump(all, dx, dy) {
    const ids = free(all);
    if (!ids.length) return;
    const { group, sheet } = current;
    // Red: out to the first clear spot that way; clear: on until it touches.
    const r = bumpDistance(group.res.parts, sheet, group.margin, sheet.placements, ids, dx, dy);
    if (!r) { setMessage(BUMP_NOTE); return; }
    nudge(ids, dx, dy, r.d);
  }
  // Pointer angle about a point, in sheet terms (y up).
  const pointerAngle = (e, pv) => {
    const pt = toSvg(e.clientX, e.clientY);
    return pt ? Math.atan2(current.sheet.l - pt.y - pv.y, pt.x - pv.x) : 0;
  };
  function startRotate(e, all) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const ids = free(all);
    if (!ids.length) return;
    svgRef.current.setPointerCapture(e.pointerId);
    const pivot = pivotOf(ids);
    setDrag({ mode: 'rotate', ...startState(ids), pivot, a0: pointerAngle(e, pivot) });
  }
  // Keys for the selection: R / Shift+R turn, arrows nudge (Shift ×10), Ctrl+arrow bumps,
  // L locks / unlocks, Delete takes off the sheet, Ctrl+A selects all, Esc lets go.
  useEffect(() => {
    if (tab !== 'nest' || !current) return undefined;
    const onKey = e => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); setSel(current.sheet.placements.map((_, i) => i)); return; }
      if (!sel.length) return;
      const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); turn(sel, e.shiftKey ? -1 : 1); }
      else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); toggleLock(sel); }
      else if (dirs[e.key]) {
        e.preventDefault();
        const [dx, dy] = dirs[e.key];
        if (e.ctrlKey) bump(sel, dx, dy);
        else nudge(sel, dx, dy, (isInch ? 0.01 * MM : 0.25) * (e.shiftKey ? 10 : 1));
      } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); takeOff(sel); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSel([]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Sheet view zoom and pan: a viewBox (mm, y down); null = the whole sheet.
  const svgRef = useRef(null);
  const [view, setView] = useState(null);
  const [pan, setPan] = useState(null);
  useEffect(() => setView(null), [sheetIdx]);
  // Fit shows the sheet and any part left hanging off it.
  const extent = useMemo(() => {
    if (!current) return null;
    const { w, l } = current.sheet;
    const e = { minX: 0, minY: 0, maxX: w, maxY: l, off: 0 };
    for (const pl of current.sheet.placements) {
      const b = partBox(pl);
      if (b.minX < -0.01 || b.minY < -0.01 || b.maxX > w + 0.01 || b.maxY > l + 0.01) e.off++;
      e.minX = Math.min(e.minX, b.minX); e.minY = Math.min(e.minY, b.minY); e.maxX = Math.max(e.maxX, b.maxX); e.maxY = Math.max(e.maxY, b.maxY);
    }
    return e;
  }, [current]);
  const fitBox = extent ? (() => {
    const pad = Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY) * 0.01;
    return { x: extent.minX - pad, y: current.sheet.l - extent.maxY - pad, w: extent.maxX - extent.minX + 2 * pad, h: extent.maxY - extent.minY + 2 * pad };
  })() : null;
  const usedPct = current ? placements.reduce((t, pl) => t + current.group.res.parts[pl.part].area, 0)
    / Math.max(1, (current.sheet.w - 2 * current.group.margin) * (current.sheet.l - 2 * current.group.margin)) : 0;
  // Click the red count: select the next red part and centre on it.
  function showRed() {
    const list = [...conflicts].sort((a, b) => a - b);
    if (!list.length) return;
    const next = list.find(i => !sel.length || i > sel[0]) ?? list[0];
    setSel([next]);
    const b = partBox(current.sheet.placements[next]);
    setView(v => {
      const box = v || fitBox;
      return { ...box, x: (b.minX + b.maxX) / 2 - box.w / 2, y: current.sheet.l - (b.minY + b.maxY) / 2 - box.h / 2 };
    });
  }

  // Dragging a part from Not on a sheet onto the sheet: trayDrag = { part, angle, pt (sheet coords, or null off the view) }.
  const [trayDrag, setTrayDrag] = useState(null);
  useEffect(() => {
    if (!trayDrag || !current) return undefined;
    const over = e => {
      const el = svgRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return null;
      const pt = toSvg(e.clientX, e.clientY);
      return pt && { x: pt.x, y: current.sheet.l - pt.y };
    };
    const move = e => { const pt = over(e); setTrayDrag(t => t && { ...t, pt }); };
    const up = e => {
      const pt = over(e);
      if (pt) placeFromTray(trayDrag.part, trayDrag.angle, pt.x, pt.y);
      setTrayDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  });
  const vb = view || fitBox;
  const zoom = vb && fitBox ? fitBox.w / vb.w : 1;
  const toSvg = (cx, cy) => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(cx, cy).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };
  // A native listener: React's wheel handler is passive and can't stop the page scrolling.
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !fitBox) return undefined;
    const onWheel = e => {
      e.preventDefault();
      const pt = toSvg(e.clientX, e.clientY);
      if (!pt) return;
      setView(v => {
        const b = v || fitBox;
        const f = Math.min(Math.max(e.deltaY > 0 ? 1.2 : 1 / 1.2, fitBox.w / 40 / b.w), (fitBox.w * 2) / b.w); // 2× out to 40× in
        return { x: pt.x - (pt.x - b.x) * f, y: pt.y - (pt.y - b.y) * f, w: b.w * f, h: b.h * f };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });
  function startPan(e) {
    if (e.button === 0) {
      // Empty sheet: a selection box (Shift keeps what's already selected).
      const pt = toSvg(e.clientX, e.clientY);
      if (!pt) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ mode: 'box', p0: pt, p1: pt, keep: e.shiftKey ? sel : [] });
      return;
    }
    if (e.button !== 1 && e.button !== 2) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setPan({ cx: e.clientX, cy: e.clientY, b: vb, scale: svgRef.current.getScreenCTM().a });
  }
  function movePan(e) {
    if (drag?.mode === 'box') {
      const pt = toSvg(e.clientX, e.clientY);
      if (pt) setDrag(d => ({ ...d, p1: pt }));
      return;
    }
    if (drag?.mode === 'rotate') {
      // One part: its angle in 1° steps (15° with Shift); a group: the turn in those steps.
      const step = ((e.shiftKey ? 15 : 1) * Math.PI) / 180;
      const raw = pointerAngle(e, drag.pivot) - drag.a0;
      const one = drag.ids.length === 1 ? drag.orig.get(drag.ids[0]) : null;
      const da = one ? Math.round((one.angle + raw) / step) * step - one.angle : Math.round(raw / step) * step;
      setDrag(d => ({ ...d, da, live: new Map(d.ids.map(i => [i, turnAbout(d.orig.get(i), d.pivot, da)])) }));
      return;
    }
    if (drag?.mode === 'move') {
      // Screen y runs down, the sheet's y up.
      const dx = (e.clientX - drag.cx) / drag.scale, dy = (e.clientY - drag.cy) / drag.scale;
      setDrag(d => ({ ...d, live: new Map(d.ids.map(i => { const o = d.orig.get(i); return [i, { ...o, x: o.x + dx, y: o.y - dy }]; })) }));
      return;
    }
    if (!pan) return;
    const dx = (e.clientX - pan.cx) / pan.scale, dy = (e.clientY - pan.cy) / pan.scale;
    setView({ ...pan.b, x: pan.b.x - dx, y: pan.b.y - dy });
  }
  const endPan = () => {
    if (drag?.mode === 'box') {
      const { p0, p1 } = drag;
      const x0 = Math.min(p0.x, p1.x), x1 = Math.max(p0.x, p1.x), t = Math.min(p0.y, p1.y), b = Math.max(p0.y, p1.y);
      const L = current.sheet.l;
      // Left to right: parts wholly inside; right to left: any part it touches.
      const crossing = p1.x < p0.x;
      const picked = (x1 - x0) * (b - t) > 0 ? current.sheet.placements.flatMap((pl, i) => {
        const q = partBox(pl);
        const top = L - q.maxY, bot = L - q.minY;
        const hit = crossing ? q.maxX >= x0 && q.minX <= x1 && bot >= t && top <= b : q.minX >= x0 && q.maxX <= x1 && top >= t && bot <= b;
        return hit ? [i] : [];
      }) : [];
      setSel([...new Set([...drag.keep, ...picked])]);
      setDrag(null);
    } else if (drag) {
      if (drag.live) setPlacements(drag.live);
      setDrag(null);
    }
    setPan(null);
  };

  return (
    <div style={S.overlay}>
      <div style={{ ...S.box, ...(dragging ? S.drop : {}) }} onClick={e => e.stopPropagation()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        <div style={S.title}>
          ▦ Nest
          <span style={S.tab(tab === 'parts')} onClick={() => setTab('parts')}>① Parts ({partList.length})</span>
          <span style={S.tab(tab === 'nest')} onClick={() => setTab('nest')}>② Nest{allSheets.length ? ` (${allSheets.length} sheet${allSheets.length === 1 ? '' : 's'})` : ''}</span>
          <span style={{ flex:1, fontSize:11, fontWeight:400, color:'#8888aa', textAlign:'right' }}>{message}</span>
        </div>

        {tab === 'parts' && <>
        <div style={S.bar}>
          <button style={{ ...S.btn, ...S.secondary }} onClick={addFromDrawing}
            title="The parts in the drawing (the selected ones, if any) — Apply replaces them with the nest">+ From Drawing{selectedEntityIds?.length ? ' (selection)' : ''}</button>
          <button style={{ ...S.btn, ...S.secondary }} onClick={addParts}>+ Add Parts…</button>
          <button style={{ ...S.btn, ...S.secondary }} onClick={refresh} disabled={!partList.length} title="Re-read each part's DXF/SVG file">⟳ Refresh</button>
          <select style={S.input} value="" disabled={!partList.length} onChange={e => setMaterialFor(e.target.value)}
            title="Tick parts in the list to set only those; none ticked sets every part">
            <option value="">Set material for {ticked.length ? `${ticked.length} ticked` : 'all'}…</option>
            {lib.flatMap(m => m.thicknesses.map(t => <option key={`${m.id}|${t.id}`} value={`${m.id}|${t.id}`}>{m.name} {t.label}</option>))}
          </select>
          <span style={{ flex:1, fontSize:11, color:'#666688' }}>Drop DXF/SVG files on this window to add them.</span>
          <span style={{ fontSize:11, color:'#8888aa' }}>{partList.length} part{partList.length === 1 ? '' : 's'}, {partList.reduce((s, p) => s + (p.fill ? 0 : +p.qty || 0), 0)} total{partList.some(p => p.fill) ? ' + fill' : ''}</span>
        </div>

        <div style={S.tableWrap}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>
                <th style={S.th}>
                  <input type="checkbox" title="Tick all / none" disabled={!partList.length}
                    checked={partList.length > 0 && ticked.length === partList.length}
                    ref={el => { if (el) el.indeterminate = ticked.length > 0 && ticked.length < partList.length; }}
                    onChange={e => setChecked(new Set(e.target.checked ? partList.map(p => p.id) : []))} />
                </th>
                <th style={S.th} />
                <th style={{ ...S.th, width:'34%' }}>Name</th>
                <th style={S.th}>Size</th>
                <th style={S.th}>Qty</th>
                <th style={S.th}>Material</th>
                <th style={S.th} title="Lower goes on the sheet first">Priority</th>
                <th style={S.th}>Rotation</th>
                <th style={S.th}>Placed</th>
                <th style={S.th} />
              </tr>
            </thead>
            <tbody>
              {partList.map(p => {
                const sh = shapes.get(p.id);
                const placed = placedById.get(p.id);
                return (
                  <tr key={p.id} style={checked.has(p.id) ? { background:'#2a2a48' } : undefined}>
                    <td style={S.td}><input type="checkbox" checked={checked.has(p.id)} onChange={() => toggle(p.id)} /></td>
                    <td style={S.td}><Thumb part={p} /></td>
                    <td style={S.td}><input style={{ ...S.input, width:'100%', minWidth:280 }} value={p.name} title={p.path ? `${p.name}\n${p.path}` : p.name} onChange={e => update(p.id, { name: e.target.value })} /></td>
                    <td style={{ ...S.td, color:'#8888aa', whiteSpace:'nowrap' }}>{sh ? `${fmt(sh.w)} × ${fmt(sh.h)}` : '⚠ no outline'}</td>
                    <td style={{ ...S.td, whiteSpace:'nowrap' }}>
                      {p.fill
                        ? <input style={{ ...S.input, width:64, color:'#ffbb66' }} value="Fill" readOnly title="As many as the sheet has room for" />
                        : <input style={{ ...S.input, width:64 }} type="number" min={0} value={p.qty} onChange={e => update(p.id, { qty: Math.max(0, Math.round(+e.target.value || 0)) })} />}
                      <label style={{ fontSize:11, color:'#aaaacc', marginLeft:6 }} title="Fill the room left on each sheet after the counted parts (a sheet of its own if no part has a count)">
                        <input type="checkbox" checked={!!p.fill} onChange={e => update(p.id, { fill: e.target.checked })} style={{ verticalAlign:'middle' }} /> Fill
                      </label>
                    </td>
                    <td style={S.td}>
                      <select style={{ ...S.input, ...(matName(p.materialKey) ? {} : { borderColor:'#aa6644' }) }} value={p.materialKey || ''}
                        onChange={e => { update(p.id, { materialKey: e.target.value }); savePrefs({ ...loadPrefs(), lastMaterial: e.target.value }); }}>
                        <option value="">⚠ (none)</option>
                        {lib.flatMap(m => m.thicknesses.map(t => <option key={`${m.id}|${t.id}`} value={`${m.id}|${t.id}`}>{m.name} {t.label}</option>))}
                      </select>
                    </td>
                    <td style={S.td}><input style={{ ...S.input, width:52 }} type="number" min={1} max={10} value={p.priority ?? 5} onChange={e => update(p.id, { priority: Math.min(10, Math.max(1, Math.round(+e.target.value || 5))) })} /></td>
                    <td style={S.td}>
                      <select style={S.input} value={p.rotation || 'any'} onChange={e => update(p.id, { rotation: e.target.value })}>
                        <option value="any">Any</option>
                        <option value="90">90° steps</option>
                        <option value="none">None</option>
                      </select>
                    </td>
                    <td style={{ ...S.td, color: placed == null ? '#555577' : !p.fill && placed < p.qty ? '#cc8866' : '#55dd77' }}>{placed == null ? '–' : p.fill ? `${placed} (fill)` : `${placed} of ${p.qty}`}</td>
                    <td style={S.td}><button style={{ ...S.link, color:'#cc6666' }} onClick={() => setList(partList.filter(x => x.id !== p.id))} title="Remove part">✕</button></td>
                  </tr>
                );
              })}
              {!partList.length && <tr><td style={{ ...S.td, color:'#666688', padding:20 }} colSpan={10}>No parts yet — click + From Drawing for the parts you imported, + Add Parts… for DXF/SVG files, or drop files on this window.</td></tr>}
            </tbody>
          </table>
        </div>
        </>}

        {tab === 'nest' && <div style={S.lower}>
          <div style={S.side}>
            <div style={S.section}>Sheets <span style={{ fontWeight:400, textTransform:'none', color:'#666688' }}>(used in order; count blank = as many as needed; long side along {longAxis === 'x' ? 'X' : 'Y'} as ⚙ Machine — ↕/↔ turns a sheet)</span></div>
            {sheets.map((s, i) => (
              <div key={i} style={{ display:'flex', gap:6, alignItems:'center', marginBottom:4 }}>
                <input style={{ ...S.input, width:70 }} type="number" min={0} value={s.w} onChange={e => setSheets(ss => ss.map((x, j) => (j === i ? { ...x, w: e.target.value } : x)))} title={`Width X (${unit})`} />
                <span style={{ fontSize:11 }}>×</span>
                <input style={{ ...S.input, width:70 }} type="number" min={0} value={s.l} onChange={e => setSheets(ss => ss.map((x, j) => (j === i ? { ...x, l: e.target.value } : x)))} title={`Length Y (${unit})`} />
                <span style={{ fontSize:11, color:'#8888aa' }}>{unit}</span>
                <input style={{ ...S.input, width:56 }} type="number" min={0} placeholder="∞" value={s.count} onChange={e => setSheets(ss => ss.map((x, j) => (j === i ? { ...x, count: e.target.value } : x)))} title="How many of this size (blank = as many as needed)" />
                {(() => {
                  const alongX = (longAxis === 'x') !== !!s.turn;
                  return (
                    <button style={{ ...S.btn, ...S.secondary, padding:'2px 8px', fontSize:13, ...(s.turn ? { color:'#ffbb66', borderColor:'#aa6a2a' } : {}) }}
                      onClick={() => setSheets(ss => ss.map((x, j) => (j === i ? { ...x, turn: !x.turn } : x)))}
                      title={`Long side along ${alongX ? 'X' : 'Y'}${s.turn ? ' (turned from ⚙ Machine)' : ' (as ⚙ Machine)'} — click to turn this sheet 90°`}>{alongX ? '↔' : '↕'}</button>
                  );
                })()}
                {sheets.length > 1 && <button style={{ ...S.link, color:'#cc6666' }} onClick={() => setSheets(ss => ss.filter((x, j) => j !== i))}>✕</button>}
              </div>
            ))}
            <button style={S.link} onClick={() => setSheets(ss => [...ss, { ...ss[ss.length - 1] }])}>+ Add sheet size</button>

            <div style={S.section}>Spacing</div>
            <div style={S.grid}>
              <span style={S.label} title="Steel left between the sheet edge and the cuts">Edge margin ({unit})</span>
              <input style={{ ...S.input, width:90 }} type="number" min={0} step={isInch ? 0.05 : 1} value={margin} onChange={e => setMargin(+e.target.value)} />
              <span style={S.label} title="Steel left between parts after cutting; the kerf is added on top">Part spacing ({unit})</span>
              <input style={{ ...S.input, width:90 }} type="number" min={0} step={isInch ? 0.01 : 0.5} value={spacing} onChange={e => setSpacing(+e.target.value)} />
              <span style={S.label} title="No other part's cut closer than this to a pierce point">Pierce sep. ({unit})</span>
              <input style={{ ...S.input, width:90 }} type="number" min={0} step={isInch ? 0.01 : 0.5} value={pierceSep} onChange={e => setPierceSep(+e.target.value)} />
              <span style={S.label}>Angle steps</span>
              <select style={{ ...S.input, width:150 }} value={angleStep} onChange={e => setAngleStep(+e.target.value)}>
                <option value={5}>5° (best fit)</option>
                <option value={15}>15° (faster)</option>
              </select>
              <span />
              <label style={{ fontSize:11, color:'#aaaacc', display:'flex', gap:6, alignItems:'center' }}>
                <input type="checkbox" checked={pairs} onChange={e => setPairs(e.target.checked)} /> Interlock 180° pairs
              </label>
            </div>
            <div style={{ ...S.warn, marginTop:10 }}>
              {partList.some(p => p.qty > 0 && !matName(p.materialKey)) && <div>⚠ Parts without a material are skipped.</div>}
            </div>
            {current && (() => {
              const tray = current.group.tray || [];
              const waiting = tray.reduce((m, t) => m.set(t.part, (m.get(t.part) || 0) + 1), new Map());
              const elsewhere = unplacedTotal - tray.length;
              return <>
                <div style={S.section}>Parts — {current.group.materialName} <span style={{ fontWeight:400, textTransform:'none', color:'#666688' }}>· drag onto the sheet</span></div>
                {current.group.parts.map((p, part) => {
                  const placed = placedById.get(p.id) || 0;
                  const wait = waiting.get(part) || 0;
                  const done = p.fill || placed >= p.qty;
                  return (
                    <div key={part} style={{ ...S.trayRow, borderColor: wait ? '#aa6a2a' : '#2a2a50' }}
                      title={wait ? `${wait} not on a sheet — drag onto the sheet` : 'All on sheets — drag to place an extra copy'}
                      onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); setSel([]); setTrayDrag({ part, angle: 0, pt: null }); }}>
                      <Thumb part={p} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:12, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name}</div>
                        <div style={{ fontSize:11, color: done && !wait ? '#55dd77' : '#ffbb66' }}>
                          {p.fill ? `${placed} nested (fill)` : `${placed} of ${p.qty} nested`}{wait ? ` · ${wait} not on a sheet` : ''}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {elsewhere > 0 && <div style={{ ...S.warn, marginTop:6 }}>⚠ {elsewhere} part{elsewhere === 1 ? '' : 's'} of another material not on a sheet — open one of its sheets.</div>}
              </>;
            })()}
          </div>

          <div style={S.preview}>
            <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:6 }}>
              {allSheets.map((s, i) => (
                <span key={i} style={S.tab(i === sheetIdx)} onClick={() => setSheetIdx(i)}>
                  {s.group.materialName} — {s.k + 1} <span style={{ color:'#8888aa' }}>({s.sheet.placements.length})</span>
                </span>
              ))}
            </div>
            <div style={{ flex:1, minHeight:0 }}>
              {current ? (
                <svg ref={svgRef} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} style={{ width:'100%', height:'100%', display:'block', cursor: pan ? 'grabbing' : 'crosshair', touchAction:'none' }}
                  onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onContextMenu={e => e.preventDefault()} onDoubleClick={e => { if (e.target.tagName !== 'path') setView(null); }}>
                  <rect x={0} y={0} width={current.sheet.w} height={current.sheet.l} fill="#1c1c30" stroke="#666699" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                  {previewPaths.map((p, i) => {
                    const bad = conflicts.has(i), locked = placements[i]?.locked;
                    return <path key={i} d={p.outline} fill={bad ? 'rgba(230,70,70,0.45)' : locked ? 'rgba(90,140,230,0.35)' : 'rgba(80,200,110,0.35)'} stroke={selSet.has(i) ? '#ffffff' : bad ? '#ff6666' : locked ? '#88aaff' : '#55dd77'}
                      strokeWidth={selSet.has(i) ? 2 : 1} vectorEffect="non-scaling-stroke" style={{ cursor: drag?.mode === 'move' && selSet.has(i) ? 'grabbing' : 'move' }} onPointerDown={e => startDrag(e, i)} />;
                  })}
                  {previewPaths.map((p, i) => p.lead && <path key={`l${i}`} d={p.lead} fill="none" stroke="#ffaa44" strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />)}
                  {placements.map((pl, i) => {
                    if (!pl.locked) return null;
                    const b = partBox(pl);
                    const el = svgRef.current;
                    const upp = el?.clientWidth ? 1 / Math.min(el.clientWidth / vb.w, el.clientHeight / vb.h) : vb.w / 800;
                    return <text key={`k${i}`} x={(b.minX + b.maxX) / 2} y={current.sheet.l - (b.minY + b.maxY) / 2} textAnchor="middle" dominantBaseline="central" fontSize={14 * upp} pointerEvents="none">🔒</text>;
                  })}
                  {trayDrag?.pt && (() => {
                    const ghost = { part: trayDrag.part, angle: trayDrag.angle, x: trayDrag.pt.x, y: trayDrag.pt.y };
                    const frame = current.group.res.parts[ghost.part];
                    const all = [...current.sheet.placements, ghost];
                    const bad = nestConflicts(current.group.res.parts, current.sheet, current.group.margin, all, { only: all.length - 1 }).size > 0;
                    const c = Math.cos(ghost.angle), sn = Math.sin(ghost.angle);
                    const d = frame.local.map((q, i) => `${i ? 'L' : 'M'}${(q.x * c - q.y * sn + ghost.x).toFixed(2)},${(current.sheet.l - (q.x * sn + q.y * c + ghost.y)).toFixed(2)}`).join('') + 'Z';
                    return <path d={d} fill={bad ? 'rgba(230,70,70,0.45)' : 'rgba(80,200,110,0.5)'} stroke="#ffffff" strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />;
                  })()}
                  {sel.length > 0 && sel.every(i => placements[i]) && (() => {
                    const g = groupBox(sel, placements);
                    const L = current.sheet.l;
                    const x0 = g.minX, x1 = g.maxX, top = L - g.maxY, bot = L - g.minY;
                    const el = svgRef.current;
                    const upp = el?.clientWidth ? 1 / Math.min(el.clientWidth / vb.w, el.clientHeight / vb.h) : vb.w / 800; // mm per screen pixel
                    const off = 14 * upp, r = 9 * upp, mx = (x0 + x1) / 2, my = (top + bot) / 2;
                    const handle = (key, x, y, glyph, title, onDown) => (
                      <g key={key} transform={`translate(${x},${y})`} style={{ cursor:'pointer' }} onPointerDown={onDown}>
                        <title>{title}</title>
                        <circle r={r} fill="#2a2a50" stroke="#ffffff" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                        <text textAnchor="middle" dominantBaseline="central" fontSize={12 * upp} fill="#ffffff" style={{ userSelect:'none' }}>{glyph}</text>
                      </g>
                    );
                    const click = fn => e => { if (e.button !== 0) return; e.stopPropagation(); fn(); };
                    const it = sel.length === 1 ? 'it' : 'them';
                    return (
                      <g>
                        <rect x={x0} y={top} width={x1 - x0} height={bot - top} fill="none" stroke="#ffffff" strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />
                        {handle('tl', x0 - off, top - off, '⟲', 'Turn 90° left (R)', click(() => turn(sel, 1)))}
                        {handle('tr', x1 + off, top - off, '⟳', 'Turn 90° right (Shift+R)', click(() => turn(sel, -1)))}
                        {handle('bl', x0 - off, bot + off, '↻', 'Hold and drag to rotate (1° steps, Shift = 15°)', e => startRotate(e, sel))}
                        {handle('u', mx, top - off, '▲', `Bump up until ${it} touch${sel.length === 1 ? 'es' : ''} — if red, up until clear (Ctrl+↑)`, click(() => bump(sel, 0, 1)))}
                        {handle('d', mx, bot + off, '▼', 'Bump down (Ctrl+↓)', click(() => bump(sel, 0, -1)))}
                        {handle('l', x0 - off, my, '◀', 'Bump left (Ctrl+←)', click(() => bump(sel, -1, 0)))}
                        {handle('r', x1 + off, my, '▶', 'Bump right (Ctrl+→)', click(() => bump(sel, 1, 0)))}
                        {handle('x', x1 + off, bot + off, '✕', `Take ${it} off the sheet (Delete) — wait${sel.length === 1 ? 's' : ''} in Not on a sheet`, click(() => takeOff(sel)))}
                        {drag?.mode === 'rotate' && (
                          <text x={mx} y={my} textAnchor="middle" dominantBaseline="central" fontSize={16 * upp} fill="#ffffff" stroke="#000000" strokeWidth={3 * upp} paintOrder="stroke" pointerEvents="none">
                            {sel.length === 1 ? `${((placements[sel[0]].angle * 180) / Math.PI).toFixed(0)}°` : `${(((drag.da || 0) * 180) / Math.PI).toFixed(0)}° turn`}
                          </text>
                        )}
                      </g>
                    );
                  })()}
                  {drag?.mode === 'box' && (() => {
                    const { p0, p1 } = drag;
                    const crossing = p1.x < p0.x;
                    return <rect x={Math.min(p0.x, p1.x)} y={Math.min(p0.y, p1.y)} width={Math.abs(p1.x - p0.x)} height={Math.abs(p1.y - p0.y)}
                      fill={crossing ? 'rgba(120,200,120,0.12)' : 'rgba(120,160,255,0.12)'} stroke={crossing ? '#88dd88' : '#88aaff'} strokeDasharray={crossing ? '4 3' : undefined}
                      strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />;
                  })()}
                </svg>
              ) : (
                <div style={{ fontSize:12, color:'#666688', padding:20 }}>{running ? `Nesting… ${Math.round(progress * 100)}%` : results ? `Nothing fit on the sheet size${sheets.length === 1 ? '' : 's'} given — check the size and the units (${unit}).` : 'Set quantities and materials, then click Nest.'}</div>
              )}
            </div>
            {current && (
              <div style={{ fontSize:11, color:'#aaaacc', marginTop:6 }}>
                Sheet {sheetIdx + 1} of {allSheets.length}: {fmt(current.sheet.w)} × {fmt(current.sheet.l)} · {placements.length} parts · {(usedPct * 100).toFixed(1)}% used
                {conflicts.size > 0 && <span style={{ color:'#ff7777', cursor:'pointer', textDecoration:'underline' }} onClick={showRed} title="Show the next red part"> · ⚠ {conflicts.size} too close (red){extent?.off ? `, ${extent.off} off the sheet` : ''}</span>}
                {sel.length === 1 && placements[sel[0]] && <span style={{ color:'#ffffff' }}> · {current.group.parts[placements[sel[0]].part].name} at {((placements[sel[0]].angle * 180) / Math.PI).toFixed(1)}° — R turns, arrows nudge, Ctrl+arrow bumps</span>}
                {sel.length > 1 && <span style={{ color:'#ffffff' }}> · {sel.length} parts selected — they move, turn and bump together</span>}
                {sel.length > 0 && (
                  <> · <button style={{ ...S.link, color:'#aaccff' }} onClick={() => toggleLock(sel)} title="Locked parts stay put, and Re-nest Unlocked nests around them (L)">
                    {sel.every(i => placements[i]?.locked) ? '🔓 Unlock' : '🔒 Lock'}</button></>
                )}
                {placements.some(pl => pl.locked) && <span style={{ color:'#aaccff' }}> · 🔒 {placements.filter(pl => pl.locked).length} locked</span>}
                {running && <> · Nesting… {Math.round(progress * 100)}%</>}
                <span style={{ float:'right', color:'#666688' }}>
                  click a part (Shift+click adds), drag to move, L locks · drag on the sheet = select box · right-drag = pan · wheel = zoom · {Math.round(zoom * 100)}%{' '}
                  <button style={S.link} onClick={() => setView(null)} title="Whole sheet (or double-click)">Fit</button>
                </span>
              </div>
            )}
          </div>
        </div>}

        <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:12 }}>
          <button style={{ ...S.btn, ...S.secondary }} onClick={() => { cancelled.current = closed.current = true; onClose(); }}>Close</button>
          <button style={{ ...S.btn, ...S.secondary }} onClick={running ? () => { cancelled.current = true; } : () => nest()} disabled={!partList.length}
            title={anyLocked ? 'Start over: a fresh nest, locks and hand moves dropped' : undefined}>{running ? 'Stop' : results ? 'Nest Again' : 'Nest'}</button>
          {anyLocked && !running && (
            <button style={{ ...S.btn, ...S.secondary, color:'#aaccff', borderColor:'#5577aa' }} onClick={() => nest(true)}
              title="Keep the locked parts where they are and nest everything else around them">🔒 Re-nest Unlocked</button>
          )}
          <button style={{ ...S.btn, ...S.primary, opacity: allSheets.length && !running ? 1 : 0.5 }} onClick={apply} disabled={!allSheets.length || running}
            title="Lay the sheets out in the drawing with a Plasma Cut each (replaces the previous nest, and the drawing's copies of parts taken from it)">Apply</button>
        </div>
      </div>
    </div>
  );
}
