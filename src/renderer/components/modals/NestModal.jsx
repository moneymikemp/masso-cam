import React, { useState, useMemo, useRef, useEffect } from 'react';
import { nestPartsFromEntities } from '../../cam/toolpath';
import { outsideLead } from '../../cam/plasmaToolpath';
import { nestParts } from '../../plasma/nesting';
import { placeEntity, placePoint } from '../../plasma/placement';
import { loadPlasmaMaterials, findThickness, paramsFromThickness } from '../../plasma/plasmaMaterials';

// Nest (PLASMA screen → ▦ Nest). Lays copies of the selected parts (or every
// part in the drawing) out on a sheet — see plasma/nesting.js. Like ProNest,
// each part's outside lead-in is worked out first and nested with the part,
// and the spacing is the steel left between cuts (kerf on top). Apply swaps
// the parts for the nested copies in one undo step, tags each outline with
// its lead-in point (entity.leadAt) so the Plasma Cut starts it exactly
// there, and sets the stock to the sheet, bottom-left at 0,0.

const MM_PER_INCH = 25.4;
const PREFS_KEY = 'dmdcam.nest';

const S = {
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' },
  box: { background:'#1a1a38', border:'1px solid #3a3a70', borderRadius:8, padding:'20px 24px', width:880, maxWidth:'95vw', maxHeight:'92vh', overflow:'auto', color:'#ccc', fontFamily:'system-ui,sans-serif' },
  title: { fontSize:14, fontWeight:700, color:'#ffbb66', marginBottom:12 },
  cols: { display:'flex', gap:18, alignItems:'flex-start' },
  side: { width:300, flexShrink:0 },
  section: { fontSize:10, fontWeight:700, color:'#8888aa', textTransform:'uppercase', letterSpacing:0.5, margin:'10px 0 6px' },
  grid: { display:'grid', gridTemplateColumns:'110px 1fr', gap:'6px 10px', alignItems:'center' },
  label: { fontSize:11, color:'#8888aa', textAlign:'right' },
  input: { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:4, padding:'4px 8px', fontSize:12, width:'100%', boxSizing:'border-box' },
  partRow: { display:'grid', gridTemplateColumns:'1fr 70px', gap:8, alignItems:'center', fontSize:11, padding:'3px 0', borderBottom:'1px solid #22224a' },
  preview: { flex:1, minWidth:0, background:'#0d0d22', border:'1px solid #1a1a40', borderRadius:4, padding:8 },
  stats: { fontSize:11, color:'#aaaacc', marginTop:8, minHeight:16 },
  btnRow: { display:'flex', justifyContent:'flex-end', gap:8, marginTop:14 },
  btn: { padding:'6px 16px', borderRadius:4, cursor:'pointer', fontSize:12, border:'none' },
  btnPrimary: { background:'#aa6a2a', color:'#fff' },
  btnSecondary: { background:'#2a2a4a', color:'#aaa', border:'1px solid #3a3a60' },
};

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}

function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* per-viewer convenience only */ }
}

export default function NestModal({ entities, operations, selectedEntityIds, isInch, dispatch, onClose }) {
  const prefs = useMemo(loadPrefs, []);
  const toDisp = v => (isInch ? +(v / MM_PER_INCH).toFixed(4) : +v.toFixed(2));
  const toMM = v => (isInch ? v * MM_PER_INCH : v);
  const unit = isInch ? 'in' : 'mm';

  // Stored in mm; defaults are a 96" × 48" sheet.
  const [sheetW, setSheetW] = useState(toDisp(prefs.sheetW ?? 96 * MM_PER_INCH));
  const [sheetL, setSheetL] = useState(toDisp(prefs.sheetL ?? 48 * MM_PER_INCH));
  const [margin, setMargin] = useState(toDisp(prefs.margin ?? 0.25 * MM_PER_INCH));
  const [spacing, setSpacing] = useState(toDisp(prefs.spacing ?? 0.1 * MM_PER_INCH));
  const [rotation, setRotation] = useState(prefs.rotation ?? 'any5');
  const [pairs, setPairs] = useState(prefs.pairs ?? true);

  // Cut: from the first Plasma Cut if there is one, else last time's, else 1/8" mild steel.
  const plasmaOps = (operations || []).filter(op => op.type === 'plasma');
  const cutFrom = plasmaOps[0]?.params || prefs.cut || {};
  const [matKey, setMatKey] = useState(cutFrom.materialId ? `${cutFrom.materialId}|${cutFrom.thicknessId}` : '');
  const [kerf, setKerf] = useState(toDisp(cutFrom.kerf ?? 1.143));
  const [leadStyle, setLeadStyle] = useState(cutFrom.leadInStyle || 'arc');
  const [leadLen, setLeadLen] = useState(toDisp(cutFrom.leadInLength ?? 3.556));
  const [pierceSep, setPierceSep] = useState(toDisp(prefs.pierceSep ?? 0.1 * MM_PER_INCH));
  const [lib, setLib] = useState([]);
  useEffect(() => { loadPlasmaMaterials().then(setLib); }, []);
  const pickMaterial = key => {
    setMatKey(key);
    const [materialId, thicknessId] = key.split('|');
    const found = findThickness(lib, materialId, thicknessId);
    if (!found) return;
    const p = paramsFromThickness(found.thickness);
    setKerf(toDisp(p.kerf));
    setLeadStyle(p.leadInStyle);
    setLeadLen(toDisp(p.leadInLength));
  };

  const { parts, loose } = useMemo(() => nestPartsFromEntities(entities, selectedEntityIds), [entities, selectedEntityIds]);
  const single = parts.length === 1;
  const [fill, setFill] = useState(true);
  const [qtys, setQtys] = useState(() => parts.map(() => 1));

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const cancelled = useRef(false); // Stop: end the search, keep the best so far
  const closed = useRef(false);
  useEffect(() => () => { cancelled.current = closed.current = true; }, []);

  const sheetMM = { w: toMM(sheetW), l: toMM(sheetL), m: toMM(margin) };

  async function run() {
    const mm = { sheetW: sheetMM.w, sheetL: sheetMM.l, margin: sheetMM.m, spacing: toMM(spacing), pierceSep: toMM(pierceSep) };
    const [materialId, thicknessId] = matKey ? matKey.split('|') : [];
    const cut = { materialId, thicknessId, kerf: toMM(kerf), leadInStyle: leadStyle, leadInLength: toMM(leadLen) };
    savePrefs({ ...mm, rotation, pairs, cut });
    cancelled.current = false;
    setRunning(true);
    setProgress(0);
    setResult(null);
    try {
      const sheet = { minX: mm.margin, minY: mm.margin, maxX: mm.sheetW - mm.margin, maxY: mm.sheetL - mm.margin };
      const leads = parts.map(p => outsideLead(p.outline, cut));
      const input = parts.map((p, i) => ({ outline: p.outline, lead: leads[i], qty: single && fill ? 0 : Math.max(0, Math.round(qtys[i] || 0)) }));
      const res = await nestParts(input.filter(p => p.qty > 0 || (single && fill)), sheet, {
        spacing: mm.spacing,
        kerf: cut.kerf,
        pierceSep: mm.pierceSep,
        rotation: rotation === 'any5' || rotation === 'any15' ? 'any' : rotation,
        angleStep: rotation === 'any15' ? 15 : 5,
        allowPairs: pairs && rotation !== 'none',
        onProgress: setProgress,
        cancelled: () => cancelled.current,
      });
      // nestParts saw only the parts with a quantity; map its indexes back.
      const kept = parts.map((p, i) => i).filter(i => single && fill ? true : Math.round(qtys[i] || 0) > 0);
      res.placements = res.placements.map(pl => ({ ...pl, src: kept[pl.part] }));
      res.leads = leads;
      res.cut = cut;
      if (!closed.current) setResult(res);
    } finally {
      if (!closed.current) setRunning(false);
    }
  }

  function apply() {
    if (!result?.placements.length) return;
    const byId = new Map(entities.map(e => [e.id, e]));
    const add = [];
    for (const pl of result.placements) {
      const frame = result.parts[pl.part];
      const outlineIds = new Set(parts[pl.src].outlineIds);
      const lead = result.leads[pl.src];
      const leadAt = lead && placePoint(lead.start, frame, pl);
      for (const id of parts[pl.src].ids) {
        const e = byId.get(id);
        if (!e) continue;
        const placed = placeEntity(e, frame, pl);
        if (outlineIds.has(id)) {
          if (leadAt) placed.leadAt = leadAt;
          else delete placed.leadAt;
        }
        add.push(placed);
      }
    }
    const remove = parts.flatMap(p => p.ids);
    dispatch({ type: 'REPLACE_ENTITIES', payload: { remove, add } });
    dispatch({ type: 'SET_STOCK_CONFIG', payload: { width: sheetMM.w, length: sheetMM.l, datum: 'bl', stockOriginX: 0, stockOriginY: 0, stockOffset: 0 } });
    // A Plasma Cut on a selection would point at the replaced entities — make it cut the whole sheet.
    for (const op of plasmaOps) {
      if (op.selectedIds?.length && !op.params?.sheet) dispatch({ type: 'UPDATE_OPERATION', payload: { id: op.id, changes: { selectedIds: [] } } });
    }
    dispatch({ type: 'SET_STATUS', payload: `Nested ${result.placements.length} parts — recalculate the Plasma Cuts (⟳)` });
    onClose();
  }

  // Preview: the sheet, its margin, and every placed outline.
  const previewPaths = useMemo(() => {
    if (!result) return [];
    return result.placements.map(pl => {
      const part = result.parts[pl.part];
      const c = Math.cos(pl.angle), s = Math.sin(pl.angle);
      const d = pts => pts.map((q, i) => `${i ? 'L' : 'M'}${(q.x * c - q.y * s + pl.x).toFixed(2)},${(sheetMM.l - (q.x * s + q.y * c + pl.y)).toFixed(2)}`).join('');
      const lead = result.leads[pl.src];
      return { outline: d(part.local) + 'Z', lead: lead ? d(lead.leadPts.map(q => ({ x: q.x - part.cx, y: q.y - part.cy }))) : null };
    });
  }, [result, sheetMM.l]);

  const total = single && fill ? null : qtys.reduce((s, q) => s + Math.max(0, Math.round(q || 0)), 0);
  const fmt = mm => `${toDisp(mm)} ${unit}`;
  const usedLen = result?.placements.length ? Math.max(...result.placements.map(pl => pl.right ?? 0)) : 0;

  return (
    <div style={S.overlay}>
      <div style={S.box} onClick={e => e.stopPropagation()}>
        <div style={S.title}>▦ Nest</div>
        <div style={S.cols}>
          <div style={S.side}>
            <div style={S.section}>Sheet</div>
            <div style={S.grid}>
              <span style={S.label}>Width X ({unit})</span>
              <input style={S.input} type="number" step={isInch ? 0.5 : 10} value={sheetW} onChange={e => setSheetW(+e.target.value)} />
              <span style={S.label}>Length Y ({unit})</span>
              <input style={S.input} type="number" step={isInch ? 0.5 : 10} value={sheetL} onChange={e => setSheetL(+e.target.value)} />
              <span style={S.label} title="Steel left between the sheet edge and the cuts">Edge margin ({unit})</span>
              <input style={S.input} type="number" step={isInch ? 0.05 : 1} value={margin} onChange={e => setMargin(+e.target.value)} />
              <span style={S.label} title="Steel left between parts after cutting. The kerf is added on top.">Part spacing ({unit})</span>
              <input style={S.input} type="number" step={isInch ? 0.01 : 0.5} value={spacing} onChange={e => setSpacing(+e.target.value)} />
              <span style={S.label}>Rotation</span>
              <select style={S.input} value={rotation} onChange={e => setRotation(e.target.value)}>
                <option value="any5">Any angle (5° steps)</option>
                <option value="any15">Any angle (15° steps, faster)</option>
                <option value="90">90° steps</option>
                <option value="none">None</option>
              </select>
              <span />
              <label style={{ fontSize:11, color:'#aaaacc', display:'flex', gap:6, alignItems:'center' }} title="Pair each part with a copy turned 180° so they interlock (one part type only)">
                <input type="checkbox" checked={pairs} disabled={rotation === 'none'} onChange={e => setPairs(e.target.checked)} /> Interlock 180° pairs
              </label>
            </div>

            <div style={S.section}>Cut</div>
            <div style={S.grid}>
              <span style={S.label}>Material</span>
              <select style={S.input} value={matKey} onChange={e => pickMaterial(e.target.value)} title="Fills in kerf and lead-in from the plasma material library">
                <option value="">—</option>
                {lib.flatMap(m => m.thicknesses.map(t => <option key={`${m.id}|${t.id}`} value={`${m.id}|${t.id}`}>{m.name} {t.label}</option>))}
              </select>
              <span style={S.label}>Kerf ({unit})</span>
              <input style={S.input} type="number" min={0} step={isInch ? 0.001 : 0.02} value={kerf} onChange={e => setKerf(+e.target.value)} />
              <span style={S.label}>Lead-in</span>
              <select style={S.input} value={leadStyle} onChange={e => setLeadStyle(e.target.value)}>
                <option value="arc">Arc</option>
                <option value="line">Line</option>
                <option value="none">None</option>
              </select>
              {leadStyle !== 'none' && <>
                <span style={S.label}>Lead length ({unit})</span>
                <input style={S.input} type="number" min={0} step={isInch ? 0.01 : 0.25} value={leadLen} onChange={e => setLeadLen(+e.target.value)} />
              </>}
              <span style={S.label} title="No other part's cut closer than this to a pierce point">Pierce sep. ({unit})</span>
              <input style={S.input} type="number" min={0} step={isInch ? 0.01 : 0.5} value={pierceSep} onChange={e => setPierceSep(+e.target.value)} />
            </div>
            {plasmaOps.some(op => Math.abs((op.params?.kerf ?? 1.143) - toMM(kerf)) > 0.001 || (op.params?.leadInStyle || 'arc') !== leadStyle || (leadStyle !== 'none' && Math.abs((op.params?.leadInLength ?? 3.556) - toMM(leadLen)) > 0.001)) && (
              <div style={{ fontSize:10, color:'#cc8866', marginTop:4 }}>Your Plasma Cut uses a different kerf or lead-in — set it to match, or the leads won't fit where the nest left room.</div>
            )}

            <div style={S.section}>Parts</div>
            {!parts.length && <div style={{ fontSize:11, color:'#cc8866' }}>No closed outlines found. Select a part's outline, or select nothing to nest the whole drawing.</div>}
            {single && (
              <label style={{ fontSize:11, color:'#aaaacc', display:'flex', gap:6, alignItems:'center', marginBottom:4 }}>
                <input type="checkbox" checked={fill} onChange={e => setFill(e.target.checked)} /> Fill the sheet
              </label>
            )}
            {parts.map((p, i) => {
              const xs = p.outline.map(q => q.x), ys = p.outline.map(q => q.y);
              return (
                <div key={i} style={S.partRow}>
                  <span>Part {i + 1} <span style={{ color:'#666688' }}>— {fmt(Math.max(...xs) - Math.min(...xs))} × {fmt(Math.max(...ys) - Math.min(...ys))}, {p.ids.length} shapes</span></span>
                  <input style={S.input} type="number" min={0} disabled={single && fill} value={qtys[i] ?? 1} title="Quantity"
                    onChange={e => setQtys(q => q.map((v, j) => (j === i ? +e.target.value : v)))} />
                </div>
              );
            })}
            {loose > 0 && <div style={{ fontSize:10, color:'#666688', marginTop:4 }}>{loose} shape{loose === 1 ? '' : 's'} not inside any outline — left out.</div>}
          </div>

          <div style={S.preview}>
            <svg viewBox={`${-sheetMM.w * 0.01} ${-sheetMM.l * 0.01} ${sheetMM.w * 1.02} ${sheetMM.l * 1.02}`} style={{ width:'100%', maxHeight:460, display:'block' }}>
              <rect x={0} y={0} width={sheetMM.w} height={sheetMM.l} fill="#1c1c30" stroke="#666699" strokeWidth={sheetMM.w / 500} />
              <rect x={sheetMM.m} y={sheetMM.m} width={Math.max(0, sheetMM.w - 2 * sheetMM.m)} height={Math.max(0, sheetMM.l - 2 * sheetMM.m)} fill="none" stroke="#44446a" strokeDasharray={`${sheetMM.w / 150}`} strokeWidth={sheetMM.w / 800} />
              {previewPaths.map((p, i) => <path key={i} d={p.outline} fill="rgba(80,200,110,0.35)" stroke="#55dd77" strokeWidth={sheetMM.w / 900} />)}
              {previewPaths.map((p, i) => p.lead && <path key={`l${i}`} d={p.lead} fill="none" stroke="#ffaa44" strokeWidth={sheetMM.w / 700} />)}
            </svg>
            <div style={S.stats}>
              {running && <>Nesting… {Math.round(progress * 100)}%</>}
              {!running && result && <>
                <strong style={{ color:'#ffbb66' }}>{result.placements.length}</strong> part{result.placements.length === 1 ? '' : 's'} placed{total != null && total !== result.placements.length ? ` of ${total}` : ''}
                {' · '}{(result.utilization * 100).toFixed(1)}% of sheet used
                {usedLen > 0 && <> · cut length along X {fmt(usedLen)}</>}
                {result.info && <span style={{ color:'#666688' }}> · {result.info}</span>}
              </>}
              {!running && !result && parts.length > 0 && <>Set the sheet and click Nest.</>}
            </div>
          </div>
        </div>

        <div style={S.btnRow}>
          <button style={{ ...S.btn, ...S.btnSecondary }} onClick={() => { cancelled.current = closed.current = true; onClose(); }}>Cancel</button>
          <button style={{ ...S.btn, ...S.btnSecondary }} onClick={running ? () => { cancelled.current = true; } : run} disabled={!parts.length}>{running ? 'Stop' : result ? 'Nest Again' : 'Nest'}</button>
          <button style={{ ...S.btn, ...S.btnPrimary, opacity: result?.placements.length && !running ? 1 : 0.5 }} onClick={apply} disabled={!result?.placements.length || running}>Apply</button>
        </div>
      </div>
    </div>
  );
}
