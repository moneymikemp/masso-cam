import React, { useState, useMemo, useRef, useEffect } from 'react';
import { v4 as uuid } from 'uuid';
import { parseDxf, scaleEntities } from '../../dxf/parser';
import { parseSvg } from '../../svg/parser';
import { translateEntity } from '../../cam/offsetEngine';
import { nestPartsFromEntities, entityToProfile, generateToolpath } from '../../cam/toolpath';
import { outsideLead } from '../../cam/plasmaToolpath';
import { nestSheets } from '../../plasma/nesting';
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
// writes a program per sheet.

const MM = 25.4;
const PREFS_KEY = 'dmdcam.partlist';
const SHEET_GAP = 2 * MM; // between sheets in the drawing

const S = {
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' },
  box: { background:'#1a1a38', border:'1px solid #3a3a70', borderRadius:8, padding:'16px 20px', width:1180, maxWidth:'97vw', height:'90vh', display:'flex', flexDirection:'column', color:'#ccc', fontFamily:'system-ui,sans-serif' },
  title: { fontSize:15, fontWeight:700, color:'#ffbb66', marginBottom:10, display:'flex', alignItems:'center', gap:10 },
  bar: { display:'flex', gap:8, alignItems:'center', marginBottom:8 },
  tableWrap: { flex:'1 1 45%', minHeight:120, overflowY:'auto', background:'#0d0d20', border:'1px solid #2a2a50', borderRadius:4 },
  th: { position:'sticky', top:0, background:'#14142c', fontSize:10, color:'#8888aa', textAlign:'left', padding:'5px 6px', fontWeight:600, borderBottom:'1px solid #2a2a50' },
  td: { padding:'3px 6px', fontSize:12, borderBottom:'1px solid #1c1c3a', verticalAlign:'middle' },
  input: { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:3, padding:'3px 6px', fontSize:12, boxSizing:'border-box' },
  lower: { flex:'1 1 55%', minHeight:0, display:'flex', gap:14, marginTop:10 },
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

export default function PartListModal({ partList, entities, selectedEntityIds, activeWorkspaceId, stockConfig, isInch, dispatch, onClose }) {
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
  const [sheets, setSheets] = useState(() => (prefs.sheets || [{ w: 96 * MM, l: 48 * MM, count: 0 }]).map(s => ({ w: toDisp(s.w), l: toDisp(s.l), count: s.count || '' })));
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
  const cancelled = useRef(false);
  const closed = useRef(false);
  useEffect(() => () => { cancelled.current = closed.current = true; }, []);

  const shapes = useMemo(() => new Map(partList.map(p => [p.id, partShape(p)])), [partList]);

  function setList(next) {
    dispatch({ type: 'SET_PART_LIST', payload: next });
    setResults(null);
  }
  const update = (id, changes) => setList(partList.map(p => (p.id === id ? { ...p, ...changes } : p)));

  function addFiles(files) {
    const added = [];
    let loose = 0, failed = [];
    for (const f of files) {
      try {
        const r = partsFromFile(f.path, f.content, isInch);
        loose += r.loose;
        for (const p of r.parts) added.push({ id: uuid(), qty: 1, materialKey: prefs.lastMaterial || '', priority: 5, rotation: 'any', ...p });
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
      const files = await window.electron?.openParts?.();
      if (files?.length) addFiles(files);
    } catch (err) {
      setMessage(`Couldn't open the file picker (${err.message}) — restart DMDCAM, or drop files on this window.`);
    }
  }

  async function onDrop(e) {
    e.preventDefault();
    setDragging(false);
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

  async function nest() {
    const sizes = sheets.map(s => ({ w: toMM(+s.w), l: toMM(+s.l), count: Math.max(0, Math.round(+s.count || 0)) })).filter(s => s.w > 0 && s.l > 0);
    if (!sizes.length) { setMessage('Enter at least one sheet size.'); return; }
    const mm = { margin: toMM(margin), spacing: toMM(spacing), pierceSep: toMM(pierceSep) };
    savePrefs({ ...prefs, sheets: sizes, ...mm, angleStep, pairs });
    const groups = new Map();
    for (const p of partList) {
      if (!(p.fill || p.qty > 0) || !shapes.get(p.id) || !matName(p.materialKey)) continue;
      if (!groups.has(p.materialKey)) groups.set(p.materialKey, []);
      groups.get(p.materialKey).push(p);
    }
    if (!groups.size) { setMessage('Give the parts a quantity and a material first.'); return; }
    cancelled.current = false;
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
          const sh = shapes.get(p.id);
          return { outline: sh.outline, lead: outsideLead(sh.outline, cut), qty: p.fill ? 0 : Math.round(p.qty), fill: !!p.fill, priority: p.priority ?? 5, rotation: p.rotation || 'any' };
        });
        const gi = g;
        const res = await nestSheets(input, sizes, {
          ...mm,
          kerf: cut.kerf,
          rotation: 'any',
          angleStep,
          allowPairs: pairs,
          onProgress: f => setProgress((gi + f) / groups.size),
          cancelled: () => cancelled.current,
        });
        out.push({ materialKey: key, materialId, thicknessId, materialName: `${material.name} ${thickness.label}`, thickness, cut, parts, leads: input.map(i => i.lead), res });
        g++;
        if (cancelled.current) break;
      }
    } finally {
      if (!closed.current) {
        setRunning(false);
        setResults(out);
        setSheetIdx(0);
      }
    }
  }

  // Flattened sheet list across materials, for the tabs and Apply.
  const allSheets = useMemo(() => (results || []).flatMap(gr => gr.res.sheets.map((sh, k) => ({ group: gr, sheet: sh, k }))), [results]);
  const placedById = useMemo(() => {
    const m = new Map();
    for (const gr of results || []) gr.parts.forEach((p, i) => m.set(p.id, gr.res.placed[i]));
    return m;
  }, [results]);
  const unplacedTotal = (results || []).reduce((s, gr) => s + gr.res.unplaced.reduce((a, b) => a + b, 0), 0);

  function apply() {
    if (!allSheets.length) return;
    const add = [], ops = [], sheetRects = [];
    // Parts taken from the drawing: the nest replaces the drawing's copies.
    const nested = new Set(allSheets.flatMap(({ group, sheet }) => sheet.placements.map(pl => group.parts[pl.part].id)));
    const remove = new Set(partList.filter(p => nested.has(p.id)).flatMap(p => p.sourceIds || []));
    let x0 = 0;
    for (const { group, sheet, k } of allSheets) {
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
  const previewPaths = useMemo(() => {
    if (!current) return [];
    const { group, sheet } = current;
    return sheet.placements.map(pl => {
      const frame = group.res.parts[pl.part];
      const c = Math.cos(pl.angle), s = Math.sin(pl.angle);
      const d = pts => pts.map((q, i) => `${i ? 'L' : 'M'}${(q.x * c - q.y * s + pl.x).toFixed(2)},${(sheet.l - (q.x * s + q.y * c + pl.y)).toFixed(2)}`).join('');
      const lead = group.leads[pl.part];
      return { outline: d(frame.local) + 'Z', lead: lead ? d(lead.leadPts.map(q => ({ x: q.x - frame.cx, y: q.y - frame.cy }))) : null };
    });
  }, [current]);

  return (
    <div style={S.overlay}>
      <div style={{ ...S.box, ...(dragging ? S.drop : {}) }} onClick={e => e.stopPropagation()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        <div style={S.title}>▦ Nest <span style={{ fontSize:11, fontWeight:400, color:'#666688' }}>— part list: add the drawing's parts, or drop DXF/SVG files here</span></div>

        <div style={S.bar}>
          <button style={{ ...S.btn, ...S.secondary }} onClick={addFromDrawing}
            title="The parts in the drawing (the selected ones, if any) — Apply replaces them with the nest">+ From Drawing{selectedEntityIds?.length ? ' (selection)' : ''}</button>
          <button style={{ ...S.btn, ...S.secondary }} onClick={addParts}>+ Add Parts…</button>
          <button style={{ ...S.btn, ...S.secondary }} onClick={refresh} disabled={!partList.length} title="Re-read each part's DXF/SVG file">⟳ Refresh</button>
          <span style={{ flex:1, fontSize:11, color:'#8888aa' }}>{message}</span>
          <span style={{ fontSize:11, color:'#8888aa' }}>{partList.length} part{partList.length === 1 ? '' : 's'}, {partList.reduce((s, p) => s + (p.fill ? 0 : +p.qty || 0), 0)} total{partList.some(p => p.fill) ? ' + fill' : ''}</span>
        </div>

        <div style={S.tableWrap}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>
                <th style={S.th} />
                <th style={S.th}>Name</th>
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
                  <tr key={p.id}>
                    <td style={S.td}><Thumb part={p} /></td>
                    <td style={S.td}><input style={{ ...S.input, width:'100%' }} value={p.name} title={p.path || ''} onChange={e => update(p.id, { name: e.target.value })} /></td>
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
                    <td style={{ ...S.td, color: placed == null ? '#555577' : !p.fill && placed < p.qty ? '#cc8866' : '#55dd77' }}>{placed == null ? '–' : `${placed}`}</td>
                    <td style={S.td}><button style={{ ...S.link, color:'#cc6666' }} onClick={() => setList(partList.filter(x => x.id !== p.id))} title="Remove part">✕</button></td>
                  </tr>
                );
              })}
              {!partList.length && <tr><td style={{ ...S.td, color:'#666688', padding:20 }} colSpan={9}>No parts yet — click + From Drawing for the parts you imported, + Add Parts… for DXF/SVG files, or drop files on this window.</td></tr>}
            </tbody>
          </table>
        </div>

        <div style={S.lower}>
          <div style={S.side}>
            <div style={S.section}>Sheets <span style={{ fontWeight:400, textTransform:'none', color:'#666688' }}>(used in order; count blank = as many as needed)</span></div>
            {sheets.map((s, i) => (
              <div key={i} style={{ display:'flex', gap:6, alignItems:'center', marginBottom:4 }}>
                <input style={{ ...S.input, width:70 }} type="number" min={0} value={s.w} onChange={e => setSheets(ss => ss.map((x, j) => (j === i ? { ...x, w: e.target.value } : x)))} title={`Width X (${unit})`} />
                <span style={{ fontSize:11 }}>×</span>
                <input style={{ ...S.input, width:70 }} type="number" min={0} value={s.l} onChange={e => setSheets(ss => ss.map((x, j) => (j === i ? { ...x, l: e.target.value } : x)))} title={`Length Y (${unit})`} />
                <span style={{ fontSize:11, color:'#8888aa' }}>{unit}</span>
                <input style={{ ...S.input, width:56 }} type="number" min={0} placeholder="∞" value={s.count} onChange={e => setSheets(ss => ss.map((x, j) => (j === i ? { ...x, count: e.target.value } : x)))} title="How many of this size (blank = as many as needed)" />
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
              {unplacedTotal > 0 && <div>⚠ {unplacedTotal} part{unplacedTotal === 1 ? '' : 's'} didn't fit on the sheets (too big, or the sheet counts ran out).</div>}
            </div>
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
                <svg viewBox={`${-current.sheet.w * 0.01} ${-current.sheet.l * 0.01} ${current.sheet.w * 1.02} ${current.sheet.l * 1.02}`} style={{ width:'100%', height:'100%', display:'block' }}>
                  <rect x={0} y={0} width={current.sheet.w} height={current.sheet.l} fill="#1c1c30" stroke="#666699" strokeWidth={current.sheet.w / 500} />
                  {previewPaths.map((p, i) => <path key={i} d={p.outline} fill="rgba(80,200,110,0.35)" stroke="#55dd77" strokeWidth={current.sheet.w / 900} />)}
                  {previewPaths.map((p, i) => p.lead && <path key={`l${i}`} d={p.lead} fill="none" stroke="#ffaa44" strokeWidth={current.sheet.w / 700} />)}
                </svg>
              ) : (
                <div style={{ fontSize:12, color:'#666688', padding:20 }}>{running ? `Nesting… ${Math.round(progress * 100)}%` : 'Set quantities and materials, then click Nest.'}</div>
              )}
            </div>
            {current && (
              <div style={{ fontSize:11, color:'#aaaacc', marginTop:6 }}>
                Sheet {sheetIdx + 1} of {allSheets.length}: {fmt(current.sheet.w)} × {fmt(current.sheet.l)} · {current.sheet.placements.length} parts · {(current.sheet.utilization * 100).toFixed(1)}% used
                {running && <> · Nesting… {Math.round(progress * 100)}%</>}
              </div>
            )}
          </div>
        </div>

        <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:12 }}>
          <button style={{ ...S.btn, ...S.secondary }} onClick={() => { cancelled.current = closed.current = true; onClose(); }}>Close</button>
          <button style={{ ...S.btn, ...S.secondary }} onClick={running ? () => { cancelled.current = true; } : nest} disabled={!partList.length}>{running ? 'Stop' : results ? 'Nest Again' : 'Nest'}</button>
          <button style={{ ...S.btn, ...S.primary, opacity: allSheets.length && !running ? 1 : 0.5 }} onClick={apply} disabled={!allSheets.length || running}
            title="Lay the sheets out in the drawing with a Plasma Cut each (replaces the previous nest, and the drawing's copies of parts taken from it)">Apply</button>
        </div>
      </div>
    </div>
  );
}
