import React, { useState, useEffect } from 'react';

const MM = 25.4;

// Keys from wiz state that belong in a saved preset (excludes per-job fields: jobName, entityIds)
const PRESET_KEYS = [
  'taperToolId','angle','tipDia','taperRpm','taperFeed','taperPlunge','cleanupWallStock',
  'detailEnabled','detailToolId','detailDiameter','detailRpm','detailFeed','detailPlunge','detailWallStock',
  'bulkEnabled','bulkToolId','bulkDiameter','bulkRpm','bulkFeed','bulkPlunge','bulkWallStock',
  'plugDetailEnabled','plugDetailToolId','plugDetailDiameter','plugDetailRpm','plugDetailFeed','plugDetailPlunge','plugDetailWallStock',
  'plugBulkEnabled','plugBulkToolId','plugBulkDiameter','plugBulkRpm','plugBulkFeed','plugBulkPlunge','plugBulkWallStock',
  'pocketDepth','pocketTopZ','pocketSafeZ','pocketStockW','pocketStockH',
  'engagementDepth','mirror',
];

// ─── Styles ───────────────────────────────────────────────────────────────────

const S = {
  overlay:  { position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' },
  wizard:   { background:'#1a1a38', border:'1px solid #3a3a70', borderRadius:10, width:900, maxWidth:'96vw', maxHeight:'92vh', display:'flex', flexDirection:'column', fontFamily:'system-ui,sans-serif', color:'#ccc', overflow:'hidden' },
  hdr:      { padding:'14px 20px 12px', borderBottom:'1px solid #2a2a50', flexShrink:0 },
  hdrTitle: { fontSize:15, fontWeight:700, color:'#aaaaff', marginBottom:12 },
  body:     { flex:1, overflow:'auto', padding:'18px 22px', minHeight:0 },
  footer:   { padding:'12px 20px', borderTop:'1px solid #2a2a50', display:'flex', justifyContent:'space-between', alignItems:'center', gap:8, flexShrink:0 },

  btn:    { padding:'7px 18px', borderRadius:4, cursor:'pointer', fontSize:12, border:'none', fontWeight:600 },
  btnPri: { background:'#3a3aaa', color:'#fff' },
  btnSec: { background:'#22224a', color:'#9999cc', border:'1px solid #3a3a60' },
  btnGrn: { background:'#1a3a2a', color:'#44cc88', border:'1px solid #2a5a3a' },
  btnRed: { background:'#2a1a1a', color:'#cc6666', border:'1px solid #5a2a2a' },

  sec:   { fontSize:10, color:'#5555aa', textTransform:'uppercase', letterSpacing:1, marginTop:14, marginBottom:7, borderBottom:'1px solid #1a1a38', paddingBottom:3 },
  row:   { display:'flex', alignItems:'center', gap:6, marginBottom:7 },
  lbl:   { fontSize:11, color:'#8888aa', width:140, flexShrink:0 },
  inp:   { flex:1, background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:3, padding:'3px 7px', fontSize:11 },
  sel:   { flex:1, background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:3, padding:'3px 5px', fontSize:11 },
  unit:  { fontSize:10, color:'#555577', width:50, flexShrink:0 },
  grid2: { display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 24px' },

  warn: { background:'#1a1000', border:'1px solid #443300', borderRadius:4, padding:'9px 13px', fontSize:11, color:'#ffaa44', marginBottom:10 },
  info: { background:'#001022', border:'1px solid #003366', borderRadius:4, padding:'9px 13px', fontSize:11, color:'#6699cc', marginBottom:10 },

  card:  { background:'#0d0d20', border:'1px solid #2a2a50', borderRadius:6, padding:'12px 14px' },
  cardT: { fontSize:12, fontWeight:700, color:'#8888cc', marginBottom:8 },
  kv:    { display:'flex', justifyContent:'space-between', marginBottom:4, fontSize:11 },
  kvK:   { color:'#555577' },
  kvV:   { color:'#ccccee' },

  fitCard: { background:'#080f08', border:'1px solid #1a3a1a', borderRadius:6, padding:'13px 15px', marginTop:14 },
  fitTit:  { fontSize:11, fontWeight:700, color:'#44cc88', marginBottom:9 },
};

// ─── Step Indicator ───────────────────────────────────────────────────────────

const STEP_LABELS = ['Geometry', 'Pocket', 'Plug', 'Review', 'Done'];

function StepBar({ current }) {
  // 9-column grid: [dot 26px][line auto][dot 26px]...[dot 26px], 2 rows
  const cols = '26px 1fr 26px 1fr 26px 1fr 26px 1fr 26px';
  return (
    <div style={{ display:'grid', gridTemplateColumns: cols, gridTemplateRows:'26px 16px', alignItems:'center', rowGap:4 }}>
      {/* Row 1: dots and connecting lines */}
      {[1,2,3,4,5].map((n, i) => (
        <React.Fragment key={n}>
          {i > 0 && (
            <div style={{ height:2, background: current > i ? '#4444aa' : '#1a1a38', alignSelf:'center' }} />
          )}
          <div style={{
            width:26, height:26, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:11, fontWeight:700,
            background: current > n ? '#3a3aaa' : current === n ? '#5555cc' : '#0d0d20',
            color: current >= n ? '#fff' : '#444466',
            border: `2px solid ${current > n ? '#5555cc' : current === n ? '#8888ff' : '#2a2a50'}`,
          }}>
            {current > n ? '✓' : n}
          </div>
        </React.Fragment>
      ))}
      {/* Row 2: labels centered under each dot */}
      {STEP_LABELS.map((lbl, i) => (
        <React.Fragment key={`L${i}`}>
          {i > 0 && <div />}
          <div style={{ textAlign:'center', fontSize:9, whiteSpace:'nowrap', color: current === i+1 ? '#aaaaff' : '#444466', alignSelf:'start' }}>
            {lbl}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Form Helpers ──────────────────────────────────────────────────────────────

function F({ label, unit, children }) {
  return (
    <div style={S.row}>
      <span style={S.lbl}>{label}</span>
      {children}
      {unit && <span style={S.unit}>{unit}</span>}
    </div>
  );
}

function Num({ value, onChange, min, max, step = 0.1, disabled }) {
  return (
    <input type="number" style={{ ...S.inp, opacity: disabled ? 0.45 : 1 }}
      value={value} min={min} max={max} step={step} disabled={disabled}
      onChange={e => { const n = parseFloat(e.target.value); if (!isNaN(n)) onChange(n); }} />
  );
}

function ToolSel({ value, onChange, tools, dUnit, isInch }) {
  return (
    <F label="Tool">
      <select style={S.sel} value={value || ''} onChange={e => onChange(e.target.value || null)}>
        <option value="">Manual settings...</option>
        {tools.map(t => (
          <option key={t.id} value={String(t.id)}>
            {t.name} ({t.type}, ⌀{isInch ? (t.diameter / MM).toFixed(4) : t.diameter}{dUnit})
          </option>
        ))}
      </select>
    </F>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function InlayWizard({ onClose, onGenerate, onSelectEntities, selectedEntityIds = [], entities = [], tools = [], isInch = false }) {
  const [step, setStep]     = useState(1);
  const [created, setCreated] = useState(null);

  const dUnit = isInch ? 'in'     : 'mm';
  const fUnit = isInch ? 'in/min' : 'mm/min';
  const dStep = isInch ? 0.001    : 0.01;
  const fStep = isInch ? 1        : 25;
  const d   = v => isInch ? +(v / MM).toFixed(5) : v;
  const m   = v => isInch ? v * MM : v;
  const fmt = (v, dec) => isInch ? (v / MM).toFixed(dec ?? 4) : v.toFixed(dec ?? 2);

  const taperTools   = tools.filter(t => ['tapered','engraving'].includes(t.type));
  const endmillTools = tools.filter(t => ['flat','upcut','downcut','compression'].includes(t.type));

  const [wiz, setWiz] = useState(() => ({
    jobName:          'Inlay',
    entityIds:        [...selectedEntityIds],
    pocketDepth:      5,
    pocketTopZ:       0,
    pocketSafeZ:      10,
    pocketStockW:     0,
    pocketStockH:     0,
    plugs: [{ id: 'plug-1', name: 'Plug 1', entityIds: [], topZ: 0, safeZ: 10, stockW: 0, stockH: 0 }],
    taperToolId:      null,
    angle:            10,
    tipDia:           0.5,
    taperRpm:         24000,
    taperFeed:        1000,
    taperPlunge:      300,
    cleanupWallStock: 0.254,
    detailEnabled:    true,
    detailToolId:     null,
    detailDiameter:   1.5875,
    detailRpm:        18000,
    detailFeed:       800,
    detailPlunge:     300,
    detailWallStock:  0.254,
    bulkEnabled:      true,
    bulkToolId:       null,
    bulkDiameter:     6.35,
    bulkRpm:          18000,
    bulkFeed:         1500,
    bulkPlunge:       500,
    bulkWallStock:    0.254,
    engagementDepth:  0.057 * MM,   // mm — 0.057" is middle of ideal range
    mirror:           'x',           // 'x' | 'y' | 'none'
    plugDetailEnabled:    true,
    plugDetailToolId:     null,
    plugDetailDiameter:   1.5875,
    plugDetailRpm:        18000,
    plugDetailFeed:       800,
    plugDetailPlunge:     300,
    plugDetailWallStock:  0.254,
    plugBulkEnabled:      true,
    plugBulkToolId:       null,
    plugBulkDiameter:     6.35,
    plugBulkRpm:          18000,
    plugBulkFeed:         1500,
    plugBulkPlunge:       500,
    plugBulkWallStock:    0.254,
  }));

  const [presets, setPresets]               = useState([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetName, setPresetName]         = useState('');
  const [pickingFor, setPickingFor]         = useState(null); // null | 'pocket' | plugId
  const picking = pickingFor !== null;

  useEffect(() => {
    window.electron.storeGet('inlayPresets').then(data => {
      if (Array.isArray(data)) setPresets(data);
    });
  }, []);

  function set(key, val) { setWiz(w => ({ ...w, [key]: val })); }

  function addPlug() {
    setWiz(w => ({
      ...w,
      plugs: [...w.plugs, { id: `plug-${Date.now()}`, name: `Plug ${w.plugs.length + 1}`, entityIds: [], topZ: 0, safeZ: 10, stockW: 0, stockH: 0 }],
    }));
  }
  function removePlug(id) { setWiz(w => ({ ...w, plugs: w.plugs.filter(p => p.id !== id) })); }
  function updatePlug(id, key, val) { setWiz(w => ({ ...w, plugs: w.plugs.map(p => p.id === id ? { ...p, [key]: val } : p) })); }

  function selectTaperTool(id) {
    const t = id ? tools.find(t => String(t.id) === id) : null;
    setWiz(w => ({
      ...w,
      taperToolId: id || null,
      ...(t?.tipDiameter != null ? { tipDia: t.tipDiameter      } : {}),
      ...(t?.taperAngle  != null ? { angle:  t.taperAngle * 2  } : {}),  // tool stores half-angle; wizard uses inclusive
    }));
  }

  function selectEndmillTool(prefix, id) {
    const t = id ? tools.find(t => String(t.id) === id) : null;
    setWiz(w => ({
      ...w,
      [`${prefix}ToolId`]:     id || null,
      ...(t?.diameter != null ? { [`${prefix}Diameter`]: t.diameter } : {}),
    }));
  }

  function handleLoadPreset() {
    const p = presets.find(p => p.id === selectedPresetId);
    if (!p) return;
    setWiz(w => {
      const update = {};
      for (const k of PRESET_KEYS) { if (p[k] !== undefined) update[k] = p[k]; }
      return { ...w, ...update };
    });
  }

  async function handleSavePreset() {
    const name = presetName.trim();
    if (!name) return;
    const data = { name };
    for (const k of PRESET_KEYS) data[k] = wiz[k];
    const existing = presets.find(p => p.name === name);
    let updated;
    if (existing) {
      data.id = existing.id;
      updated = presets.map(p => p.id === existing.id ? data : p);
      setSelectedPresetId(existing.id);
    } else {
      data.id = Date.now().toString();
      updated = [...presets, data];
      setSelectedPresetId(data.id);
    }
    setPresets(updated);
    await window.electron.storeSet('inlayPresets', updated);
  }

  async function handleDeletePreset() {
    if (!selectedPresetId) return;
    const updated = presets.filter(p => p.id !== selectedPresetId);
    setPresets(updated);
    setSelectedPresetId('');
    setPresetName('');
    await window.electron.storeSet('inlayPresets', updated);
  }

  // Fit calculations — fitTolerance is derived, never stored directly
  const taperRad     = Math.max(0.5, wiz.angle / 2) * Math.PI / 180;
  const fitTolerance = wiz.engagementDepth * Math.tan(taperRad);  // mm, back-calculated
  const plugProud    = wiz.engagementDepth;                        // mm — same value, different framing
  const engDepthIn   = wiz.engagementDepth / MM;
  const fitQuality   = engDepthIn < 0.030 ? 'tight' : engDepthIn > 0.100 ? 'loose' : engDepthIn > 0.080 ? 'getting_loose' : 'ideal';
  const fitColor     = { tight:'#ff4444', ideal:'#44cc88', getting_loose:'#ffaa33', loose:'#ff4444' }[fitQuality];
  const fitLabel     = { tight:'Too Tight', ideal:'Ideal', getting_loose:'Getting Loose', loose:'Too Loose' }[fitQuality];

  const taperPasses = {
    taperContour: { enabled: true, toolId: wiz.taperToolId, angle: wiz.angle, tipDia: wiz.tipDia, rpm: wiz.taperRpm, feed: wiz.taperFeed, plunge: wiz.taperPlunge },
    taperCleanup: { enabled: true, toolId: wiz.taperToolId, angle: wiz.angle, tipDia: wiz.tipDia, rpm: wiz.taperRpm, feed: wiz.taperFeed, plunge: wiz.taperPlunge, wallStock: wiz.cleanupWallStock },
  };

  function buildPocketPasses() {
    return {
      ...taperPasses,
      detailEndmill: { enabled: wiz.detailEnabled,     toolId: wiz.detailToolId,    diameter: wiz.detailDiameter,    rpm: wiz.detailRpm,    feed: wiz.detailFeed,    plunge: wiz.detailPlunge,    wallStock: wiz.detailWallStock },
      bulkEndmill:   { enabled: wiz.bulkEnabled,       toolId: wiz.bulkToolId,      diameter: wiz.bulkDiameter,      rpm: wiz.bulkRpm,      feed: wiz.bulkFeed,      plunge: wiz.bulkPlunge,      wallStock: wiz.bulkWallStock },
    };
  }

  function buildPlugPasses() {
    return {
      ...taperPasses,
      detailEndmill: { enabled: wiz.plugDetailEnabled, toolId: wiz.plugDetailToolId, diameter: wiz.plugDetailDiameter, rpm: wiz.plugDetailRpm, feed: wiz.plugDetailFeed, plunge: wiz.plugDetailPlunge, wallStock: wiz.plugDetailWallStock },
      bulkEndmill:   { enabled: wiz.plugBulkEnabled,   toolId: wiz.plugBulkToolId,   diameter: wiz.plugBulkDiameter,   rpm: wiz.plugBulkRpm,   feed: wiz.plugBulkFeed,   plunge: wiz.plugBulkPlunge,   wallStock: wiz.plugBulkWallStock },
    };
  }

  function handleGenerate() {
    const pocketOp = {
      type: 'taperedpocket',
      name: `${wiz.jobName} — Pocket`,
      selectedIds: wiz.entityIds,
      params: {
        pocketDepth: wiz.pocketDepth, topZ: wiz.pocketTopZ, safeZ: wiz.pocketSafeZ,
        stockW: wiz.pocketStockW, stockH: wiz.pocketStockH,
        passes: buildPocketPasses(), mirror: 'none', cutSide: 'inside',
      },
    };
    const plugOps = wiz.plugs.map(plug => ({
      type: 'taperedplug',
      name: `${wiz.jobName} — ${plug.name}`,
      selectedIds: plug.entityIds,
      params: {
        pocketDepth: wiz.pocketDepth, topZ: plug.topZ, safeZ: plug.safeZ,
        stockW: plug.stockW, stockH: plug.stockH,
        passes: buildPlugPasses(), mirror: wiz.mirror, fitTolerance, cutSide: 'outside',
      },
    }));
    onGenerate(pocketOp, plugOps);
    setCreated({ pocketName: pocketOp.name, plugNames: plugOps.map(p => p.name) });
    setStep(5);
  }

  // ── Step renderers ─────────────────────────────────────────────────────────

  function renderStep1() {
    const nSel = wiz.entityIds.length;
    const typeMap = {};
    if (nSel > 0) {
      entities.filter(e => wiz.entityIds.includes(e.id))
        .forEach(e => { typeMap[e.type] = (typeMap[e.type] || 0) + 1; });
    }
    const typeSummary = Object.entries(typeMap)
      .map(([t, n]) => `${n} ${t}${n > 1 ? 's' : ''}`)
      .join(', ');

    return (
      <>
        <div style={S.sec}>Preset</div>
        <div style={{ display:'flex', gap:6, marginBottom:6 }}>
          <select style={{ ...S.sel, flex:1 }} value={selectedPresetId}
            onChange={e => {
              setSelectedPresetId(e.target.value);
              const p = presets.find(p => p.id === e.target.value);
              if (p) setPresetName(p.name);
            }}>
            <option value="">— select a preset —</option>
            {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button style={{ ...S.btn, ...S.btnPri, opacity: selectedPresetId ? 1 : 0.4 }}
            disabled={!selectedPresetId} onClick={handleLoadPreset}>Load</button>
          <button style={{ ...S.btn, ...S.btnRed, opacity: selectedPresetId ? 1 : 0.4 }}
            disabled={!selectedPresetId} onClick={handleDeletePreset}>Delete</button>
        </div>

        <div style={S.sec}>Job</div>
        <F label="Job Name">
          <input style={S.inp} type="text" value={wiz.jobName} maxLength={60}
            onChange={e => set('jobName', e.target.value)} />
        </F>

        <div style={S.sec}>Pocket Geometry</div>
        {nSel === 0 ? (
          <div style={{ ...S.warn, fontSize:10, marginBottom:8 }}>No entities selected for the pocket.</div>
        ) : (
          <div style={{ ...S.info, fontSize:10, marginBottom:8 }}>{nSel} {nSel === 1 ? 'entity' : 'entities'} selected{typeSummary ? `: ${typeSummary}` : ''}</div>
        )}
        <button style={{ ...S.btn, ...S.btnSec, marginBottom:12, fontSize:11 }}
          onClick={() => { if (onSelectEntities) onSelectEntities(wiz.entityIds); setPickingFor('pocket'); }}>
          {nSel === 0 ? 'Select Pocket Geometry' : 'Change Pocket Selection'}
        </button>

        <div style={S.sec}>Plugs</div>
        {wiz.plugs.map(plug => {
          const nPl = plug.entityIds.length;
          return (
            <div key={plug.id} style={{ ...S.card, marginBottom:10 }}>
              <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
                <input style={{ ...S.inp, flex:1 }} value={plug.name}
                  onChange={e => updatePlug(plug.id, 'name', e.target.value)} />
                {wiz.plugs.length > 1 && (
                  <button style={{ ...S.btn, ...S.btnRed, padding:'3px 8px', fontSize:11 }}
                    onClick={() => removePlug(plug.id)}>Remove</button>
                )}
              </div>
              {nPl === 0 ? (
                <div style={{ ...S.warn, fontSize:10, marginBottom:8 }}>No geometry selected for this plug.</div>
              ) : (
                <div style={{ ...S.info, fontSize:10, marginBottom:8 }}>{nPl} {nPl === 1 ? 'entity' : 'entities'} selected</div>
              )}
              <button style={{ ...S.btn, ...S.btnSec, marginBottom:10, fontSize:11 }}
                onClick={() => { if (onSelectEntities) onSelectEntities(plug.entityIds); setPickingFor(plug.id); }}>
                {nPl === 0 ? 'Select Geometry' : 'Change Selection'}
              </button>
              <div style={S.grid2}>
                <F label="Top of Stock" unit={dUnit}>
                  <Num value={d(plug.topZ)} onChange={v => updatePlug(plug.id, 'topZ', m(v))} step={dStep} />
                </F>
                <F label="Safe Z" unit={dUnit}>
                  <Num value={d(plug.safeZ)} onChange={v => updatePlug(plug.id, 'safeZ', m(v))} min={0} step={dStep} />
                </F>
                <F label="Stock Width" unit={dUnit}>
                  <Num value={d(plug.stockW)} onChange={v => updatePlug(plug.id, 'stockW', m(v))} min={0} step={dStep} />
                </F>
                <F label="Stock Height" unit={dUnit}>
                  <Num value={d(plug.stockH)} onChange={v => updatePlug(plug.id, 'stockH', m(v))} min={0} step={dStep} />
                </F>
              </div>
            </div>
          );
        })}
        <button style={{ ...S.btn, ...S.btnSec, width:'100%' }} onClick={addPlug}>+ Add Plug</button>
      </>
    );
  }

  function renderStep2() {
    return (
      <>
        <div style={S.sec}>Depth</div>
        <div style={S.grid2}>
          <F label="Pocket Depth" unit={dUnit}>
            <Num value={d(wiz.pocketDepth)} onChange={v => set('pocketDepth', m(v))} min={0} step={dStep} />
          </F>
          <F label="Top of Stock" unit={dUnit}>
            <Num value={d(wiz.pocketTopZ)} onChange={v => set('pocketTopZ', m(v))} step={dStep} />
          </F>
          <F label="Safe Z" unit={dUnit}>
            <Num value={d(wiz.pocketSafeZ)} onChange={v => set('pocketSafeZ', m(v))} min={0} step={dStep} />
          </F>
        </div>

        <div style={S.sec}>Pocket Stock Size (optional)</div>
        <div style={{ ...S.info, fontSize:10, marginTop:-4, marginBottom:10 }}>
          Stock dimensions for wrapping. Leave at 0 to use geometry bounding box.
        </div>
        <div style={S.grid2}>
          <F label="Stock Width" unit={dUnit}>
            <Num value={d(wiz.pocketStockW)} onChange={v => set('pocketStockW', m(v))} min={0} step={dStep} />
          </F>
          <F label="Stock Height" unit={dUnit}>
            <Num value={d(wiz.pocketStockH)} onChange={v => set('pocketStockH', m(v))} min={0} step={dStep} />
          </F>
        </div>

        <div style={S.sec}>Taper Bit (Contour + Cleanup)</div>
        <ToolSel value={wiz.taperToolId} onChange={selectTaperTool} tools={taperTools} dUnit={dUnit} isInch={isInch} />
        <div style={S.grid2}>
          <div style={S.row}>
            <span style={S.lbl}>Taper Angle</span>
            <Num value={wiz.angle} onChange={v => set('angle', v)} min={1} max={60} step={0.5} />
            <span style={{ fontSize:10, color:'#555577', whiteSpace:'nowrap', flexShrink:0 }}>
              ° incl. ({(wiz.angle / 2).toFixed(1)}°/side)
            </span>
          </div>
          <F label="Tip Diameter" unit={dUnit}>
            <Num value={d(wiz.tipDia)} onChange={v => set('tipDia', m(v))} min={0} step={dStep} />
          </F>
          <F label="Spindle RPM" unit="rpm">
            <Num value={wiz.taperRpm} onChange={v => set('taperRpm', v)} step={100} min={100} />
          </F>
          <F label="Feed Rate" unit={fUnit}>
            <Num value={d(wiz.taperFeed)} onChange={v => set('taperFeed', m(v))} step={fStep} min={1} />
          </F>
          <F label="Plunge Rate" unit={fUnit}>
            <Num value={d(wiz.taperPlunge)} onChange={v => set('taperPlunge', m(v))} step={fStep} min={1} />
          </F>
          <F label="Cleanup Wall Stock" unit={dUnit}>
            <Num value={d(wiz.cleanupWallStock)} onChange={v => set('cleanupWallStock', m(v))} min={0} step={dStep} />
          </F>
        </div>

        <div style={{ ...S.row, marginTop:12 }}>
          <input type="checkbox" style={{ marginRight:6, cursor:'pointer' }}
            checked={wiz.detailEnabled} onChange={e => set('detailEnabled', e.target.checked)} />
          <span style={{ ...S.sec, margin:0, border:'none', padding:0 }}>Detail Endmill</span>
        </div>
        {wiz.detailEnabled && <>
          <ToolSel value={wiz.detailToolId} onChange={id => selectEndmillTool('detail', id)} tools={endmillTools} dUnit={dUnit} isInch={isInch} />
          <div style={S.grid2}>
            <F label="Diameter" unit={dUnit}>
              <Num value={d(wiz.detailDiameter)} onChange={v => set('detailDiameter', m(v))} min={0} step={dStep} />
            </F>
            <F label="Wall Stock" unit={dUnit}>
              <Num value={d(wiz.detailWallStock)} onChange={v => set('detailWallStock', m(v))} min={0} step={dStep} />
            </F>
            <F label="Spindle RPM" unit="rpm">
              <Num value={wiz.detailRpm} onChange={v => set('detailRpm', v)} step={100} min={100} />
            </F>
            <F label="Feed Rate" unit={fUnit}>
              <Num value={d(wiz.detailFeed)} onChange={v => set('detailFeed', m(v))} step={fStep} min={1} />
            </F>
            <F label="Plunge Rate" unit={fUnit}>
              <Num value={d(wiz.detailPlunge)} onChange={v => set('detailPlunge', m(v))} step={fStep} min={1} />
            </F>
          </div>
        </>}

        <div style={{ ...S.row, marginTop:10 }}>
          <input type="checkbox" style={{ marginRight:6, cursor:'pointer' }}
            checked={wiz.bulkEnabled} onChange={e => set('bulkEnabled', e.target.checked)} />
          <span style={{ ...S.sec, margin:0, border:'none', padding:0 }}>Bulk Endmill</span>
        </div>
        {wiz.bulkEnabled && <>
          <ToolSel value={wiz.bulkToolId} onChange={id => selectEndmillTool('bulk', id)} tools={endmillTools} dUnit={dUnit} isInch={isInch} />
          <div style={S.grid2}>
            <F label="Diameter" unit={dUnit}>
              <Num value={d(wiz.bulkDiameter)} onChange={v => set('bulkDiameter', m(v))} min={0} step={dStep} />
            </F>
            <F label="Wall Stock" unit={dUnit}>
              <Num value={d(wiz.bulkWallStock)} onChange={v => set('bulkWallStock', m(v))} min={0} step={dStep} />
            </F>
            <F label="Spindle RPM" unit="rpm">
              <Num value={wiz.bulkRpm} onChange={v => set('bulkRpm', v)} step={100} min={100} />
            </F>
            <F label="Feed Rate" unit={fUnit}>
              <Num value={d(wiz.bulkFeed)} onChange={v => set('bulkFeed', m(v))} step={fStep} min={1} />
            </F>
            <F label="Plunge Rate" unit={fUnit}>
              <Num value={d(wiz.bulkPlunge)} onChange={v => set('bulkPlunge', m(v))} step={fStep} min={1} />
            </F>
          </div>
        </>}
      </>
    );
  }

  function renderStep3() {
    // Slider bounds in display units
    const engMinIn = 0.010, engMaxIn = 0.120;
    const engMin   = isInch ? engMinIn       : engMinIn * MM;
    const engMax   = isInch ? engMaxIn       : engMaxIn * MM;
    const engVal   = isInch ? plugProud / MM : plugProud;
    const engStp   = isInch ? 0.001          : 0.01;
    const engPct   = Math.min(100, Math.max(0, (engVal - engMin) / (engMax - engMin) * 100));

    // Zone gradient: tight(red) 0–18.18% | ideal(green) 18.18–63.64% | getting loose(yellow) 63.64–81.82% | too loose(red) 81.82–100%
    const trackGrad = 'linear-gradient(to right,#6b1f1f 0%,#6b1f1f 18.18%,#1a4a2a 18.18%,#1a4a2a 63.64%,#5a4000 63.64%,#5a4000 81.82%,#6b1f1f 81.82%,#6b1f1f 100%)';

    return (
      <>
        <div style={{ ...S.row, marginTop:4 }}>
          <input type="checkbox" style={{ marginRight:6, cursor:'pointer' }}
            checked={wiz.plugDetailEnabled} onChange={e => set('plugDetailEnabled', e.target.checked)} />
          <span style={{ ...S.sec, margin:0, border:'none', padding:0 }}>Detail Endmill</span>
        </div>
        {wiz.plugDetailEnabled && <>
          <ToolSel value={wiz.plugDetailToolId} onChange={id => selectEndmillTool('plugDetail', id)} tools={endmillTools} dUnit={dUnit} isInch={isInch} />
          <div style={S.grid2}>
            <F label="Diameter" unit={dUnit}>
              <Num value={d(wiz.plugDetailDiameter)} onChange={v => set('plugDetailDiameter', m(v))} min={0} step={dStep} />
            </F>
            <F label="Wall Stock" unit={dUnit}>
              <Num value={d(wiz.plugDetailWallStock)} onChange={v => set('plugDetailWallStock', m(v))} min={0} step={dStep} />
            </F>
            <F label="Spindle RPM" unit="rpm">
              <Num value={wiz.plugDetailRpm} onChange={v => set('plugDetailRpm', v)} step={100} min={100} />
            </F>
            <F label="Feed Rate" unit={fUnit}>
              <Num value={d(wiz.plugDetailFeed)} onChange={v => set('plugDetailFeed', m(v))} step={fStep} min={1} />
            </F>
            <F label="Plunge Rate" unit={fUnit}>
              <Num value={d(wiz.plugDetailPlunge)} onChange={v => set('plugDetailPlunge', m(v))} step={fStep} min={1} />
            </F>
          </div>
        </>}

        <div style={{ ...S.row, marginTop:10 }}>
          <input type="checkbox" style={{ marginRight:6, cursor:'pointer' }}
            checked={wiz.plugBulkEnabled} onChange={e => set('plugBulkEnabled', e.target.checked)} />
          <span style={{ ...S.sec, margin:0, border:'none', padding:0 }}>Bulk Endmill</span>
        </div>
        {wiz.plugBulkEnabled && <>
          <ToolSel value={wiz.plugBulkToolId} onChange={id => selectEndmillTool('plugBulk', id)} tools={endmillTools} dUnit={dUnit} isInch={isInch} />
          <div style={S.grid2}>
            <F label="Diameter" unit={dUnit}>
              <Num value={d(wiz.plugBulkDiameter)} onChange={v => set('plugBulkDiameter', m(v))} min={0} step={dStep} />
            </F>
            <F label="Wall Stock" unit={dUnit}>
              <Num value={d(wiz.plugBulkWallStock)} onChange={v => set('plugBulkWallStock', m(v))} min={0} step={dStep} />
            </F>
            <F label="Spindle RPM" unit="rpm">
              <Num value={wiz.plugBulkRpm} onChange={v => set('plugBulkRpm', v)} step={100} min={100} />
            </F>
            <F label="Feed Rate" unit={fUnit}>
              <Num value={d(wiz.plugBulkFeed)} onChange={v => set('plugBulkFeed', m(v))} step={fStep} min={1} />
            </F>
            <F label="Plunge Rate" unit={fUnit}>
              <Num value={d(wiz.plugBulkPlunge)} onChange={v => set('plugBulkPlunge', m(v))} step={fStep} min={1} />
            </F>
          </div>
        </>}

        <div style={S.sec}>Engagement Depth</div>
        <div style={{ ...S.info, fontSize:10, marginTop:-4, marginBottom:10 }}>
          How far the plug travels into the pocket before the taper walls make contact.
          Drag the slider or type a value to control press-fit tightness.
        </div>

        {/* Color zone strip with position indicator */}
        <div style={{ position:'relative', height:10, borderRadius:5, marginBottom:4, background:trackGrad }}>
          <div style={{
            position:'absolute', top:-3, width:3, height:16, background:'#ffffff',
            borderRadius:2, transform:'translateX(-50%)', left:`${engPct}%`,
            boxShadow:'0 0 4px rgba(0,0,0,0.7)',
          }} />
        </div>

        {/* Zone labels aligned to zone centers */}
        <div style={{ position:'relative', height:14, marginBottom:8, fontSize:9 }}>
          <span style={{ position:'absolute', left:0,       color:'#aa4444' }}>Too Tight</span>
          <span style={{ position:'absolute', left:'40.9%', color:'#44aa66', transform:'translateX(-50%)' }}>Ideal</span>
          <span style={{ position:'absolute', left:'72.7%', color:'#aa8833', transform:'translateX(-50%)' }}>Getting Loose</span>
          <span style={{ position:'absolute', right:0,      color:'#aa4444' }}>Too Loose</span>
        </div>

        {/* Slider + numeric input row */}
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
          <input
            type="range" min={engMin} max={engMax} step={engStp}
            value={+engVal.toFixed(isInch ? 3 : 2)}
            onChange={e => {
              const v = parseFloat(e.target.value);
              set('engagementDepth', isInch ? v * MM : v);
            }}
            style={{ flex:1, accentColor:fitColor, cursor:'pointer' }}
          />
          <input
            type="number" min={engMin} max={engMax} step={engStp}
            value={engVal.toFixed(isInch ? 3 : 2)}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) {
                const clamped = Math.max(engMinIn * MM, Math.min(engMaxIn * MM, isInch ? v * MM : v));
                set('engagementDepth', clamped);
              }
            }}
            style={{ ...S.inp, width:80, flex:'none', textAlign:'right' }}
          />
          <span style={{ ...S.unit, width:'auto' }}>{dUnit}</span>
        </div>

        {/* Read-only calculated outputs */}
        <div style={{ ...S.card, marginBottom:14 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
            <span style={S.kvK}>Plug Proud</span>
            <span style={S.kvV}>{fmt(plugProud, isInch ? 3 : 2)} {dUnit}</span>
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span style={S.kvK}>Fit Quality</span>
            <span style={{ color:fitColor, fontWeight:700, fontSize:12 }}>● {fitLabel}</span>
          </div>
          <div style={{ fontSize:9, color:'#444466', marginTop:8, lineHeight:1.5 }}>
            Plug Proud: how far the plug sits above the surface before pressing flush.
            Ideal range: {isInch ? '0.030–0.080"' : '0.76–2.03 mm'}.
          </div>
        </div>

        <div style={S.sec}>Orientation — Mirror Axis</div>
        <div style={{ display:'flex', gap:6, marginBottom:8 }}>
          {[['x','Mirror X'], ['y','Mirror Y'], ['none','None']].map(([val, label]) => (
            <button key={val}
              onClick={() => set('mirror', val)}
              style={{ ...S.btn, flex:1,
                background: wiz.mirror === val ? '#3a3aaa' : '#0d0d20',
                color:      wiz.mirror === val ? '#ffffff' : '#666688',
                border:     `1px solid ${wiz.mirror === val ? '#6666cc' : '#2a2a50'}`,
              }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ ...S.info, fontSize:10, marginTop:0 }}>
          {wiz.mirror === 'x' && 'Mirror X reflects across the horizontal axis — compensates for flipping the plug piece top-to-bottom. Recommended for most inlays.'}
          {wiz.mirror === 'y' && 'Mirror Y reflects across the vertical axis — compensates for flipping the plug piece left-to-right.'}
          {wiz.mirror === 'none' && 'No mirroring — use only if your geometry is fully symmetric or you have accounted for orientation another way.'}
        </div>

        <div style={S.sec}>Shared with Pocket</div>
        <div style={{ fontSize:11, color:'#555577', lineHeight:1.8 }}>
          Taper angle: {wiz.angle}° included ({(wiz.angle / 2).toFixed(1)}°/side) &nbsp;·&nbsp; Tip dia: {fmt(wiz.tipDia)} {dUnit} &nbsp;·&nbsp; Depth: {fmt(wiz.pocketDepth)} {dUnit}
        </div>
      </>
    );
  }

  function renderStep4() {
    const pocketPassList = [
      'Taper Contour', 'Taper Cleanup',
      wiz.detailEnabled     && 'Detail Endmill',
      wiz.bulkEnabled       && 'Bulk Endmill',
    ].filter(Boolean);
    const plugPassList = [
      'Taper Contour', 'Taper Cleanup',
      wiz.plugDetailEnabled && 'Detail Endmill',
      wiz.plugBulkEnabled   && 'Bulk Endmill',
    ].filter(Boolean);
    const mirrorLabels = { x:'Mirror X', y:'Mirror Y', none:'None' };

    return (
      <>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
          <div style={S.card}>
            <div style={S.cardT}>Pocket — {wiz.jobName}</div>
            <div style={S.kv}><span style={S.kvK}>Entities</span><span style={S.kvV}>{wiz.entityIds.length}</span></div>
            <div style={S.kv}><span style={S.kvK}>Depth</span><span style={S.kvV}>{fmt(wiz.pocketDepth)} {dUnit}</span></div>
            <div style={S.kv}><span style={S.kvK}>Top of Stock</span><span style={S.kvV}>{fmt(wiz.pocketTopZ)} {dUnit}</span></div>
            <div style={S.kv}><span style={S.kvK}>Safe Z</span><span style={S.kvV}>{fmt(wiz.pocketSafeZ)} {dUnit}</span></div>
            {(wiz.pocketStockW > 0 || wiz.pocketStockH > 0) && (
              <div style={S.kv}><span style={S.kvK}>Stock</span><span style={S.kvV}>{fmt(wiz.pocketStockW)} × {fmt(wiz.pocketStockH)} {dUnit}</span></div>
            )}
            <div style={S.kv}><span style={S.kvK}>Taper</span><span style={S.kvV}>{wiz.angle}° / ⌀{fmt(wiz.tipDia)}{dUnit} tip</span></div>
            <div style={{ marginTop:8, fontSize:10, color:'#444466', lineHeight:1.6 }}>
              Passes: {pocketPassList.join(' · ')}
            </div>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            {wiz.plugs.map(plug => (
              <div key={plug.id} style={S.card}>
                <div style={S.cardT}>{plug.name} — {wiz.jobName}</div>
                <div style={S.kv}><span style={S.kvK}>Entities</span><span style={{ ...S.kvV, color: plug.entityIds.length === 0 ? '#cc6666' : S.kvV.color }}>{plug.entityIds.length === 0 ? 'none' : plug.entityIds.length}</span></div>
                <div style={S.kv}><span style={S.kvK}>Top of Stock</span><span style={S.kvV}>{fmt(plug.topZ)} {dUnit}</span></div>
                <div style={S.kv}><span style={S.kvK}>Safe Z</span><span style={S.kvV}>{fmt(plug.safeZ)} {dUnit}</span></div>
                {(plug.stockW > 0 || plug.stockH > 0) && (
                  <div style={S.kv}><span style={S.kvK}>Stock</span><span style={S.kvV}>{fmt(plug.stockW)} × {fmt(plug.stockH)} {dUnit}</span></div>
                )}
                <div style={S.kv}><span style={S.kvK}>Mirror</span><span style={{ ...S.kvV, color: wiz.mirror === 'none' ? '#cc6666' : '#44cc88' }}>{mirrorLabels[wiz.mirror]}</span></div>
                <div style={S.kv}><span style={S.kvK}>Engagement</span><span style={{ ...S.kvV, color:fitColor }}>{fmt(plugProud, isInch ? 3 : 2)} {dUnit} ({fitLabel})</span></div>
                <div style={{ marginTop:8, fontSize:10, color:'#444466', lineHeight:1.6 }}>
                  Passes: {plugPassList.join(' · ')}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={S.fitCard}>
          <div style={S.fitTit}>Fit Preview — applies to all plugs</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, fontSize:11 }}>
            <div>
              <div style={{ color:'#444466', marginBottom:3 }}>Engagement Depth</div>
              <div style={{ color:fitColor, fontWeight:700, fontSize:15 }}>{fmt(plugProud, isInch ? 3 : 2)} {dUnit}</div>
            </div>
            <div>
              <div style={{ color:'#444466', marginBottom:3 }}>Plug Proud</div>
              <div style={{ color:'#ccccee', fontWeight:700, fontSize:15 }}>{fmt(plugProud, isInch ? 3 : 2)} {dUnit}</div>
            </div>
            <div>
              <div style={{ color:'#444466', marginBottom:3 }}>Fit Quality</div>
              <div style={{ color:fitColor, fontWeight:700, fontSize:15 }}>● {fitLabel}</div>
            </div>
          </div>
          <div style={{ fontSize:10, color:'#335533', marginTop:10 }}>
            Ideal range: {isInch ? '0.030–0.080"' : '0.76–2.03 mm'} engagement · Adjust Taper Angle to shift the range
          </div>
        </div>

        <div style={S.sec}>Save as Preset</div>
        <div style={{ display:'flex', gap:6 }}>
          <input style={{ ...S.inp, flex:1 }} placeholder="Preset name..."
            value={presetName} onChange={e => setPresetName(e.target.value)} />
          <button style={{ ...S.btn, ...S.btnSec, opacity: presetName.trim() ? 1 : 0.4 }}
            disabled={!presetName.trim()} onClick={handleSavePreset}>
            {presets.find(p => p.name === presetName.trim()) ? 'Update' : 'Save'}
          </button>
        </div>

        {wiz.entityIds.length === 0 && (
          <div style={{ ...S.warn, marginTop:12 }}>No pocket geometry selected.</div>
        )}
        {wiz.plugs.some(p => p.entityIds.length === 0) && (
          <div style={{ ...S.warn, marginTop:6 }}>
            Plugs with no geometry: {wiz.plugs.filter(p => p.entityIds.length === 0).map(p => p.name).join(', ')}
          </div>
        )}
      </>
    );
  }

  function renderStep5() {
    const plugNames = created?.plugNames || [];
    return (
      <div style={{ textAlign:'center', padding:'32px 16px' }}>
        <div style={{ fontSize:52, marginBottom:12 }}>✓</div>
        <div style={{ fontSize:18, fontWeight:700, color:'#44cc88', marginBottom:8 }}>Operations Created</div>
        <div style={{ fontSize:12, color:'#8888aa', marginBottom:18 }}>
          {1 + plugNames.length} operations added — each with its own workspace tab:
        </div>
        <div style={{ marginBottom:8 }}>
          <span style={{ display:'inline-block', background:'#1a2a1a', border:'1px solid #2a5a2a', borderRadius:4, padding:'5px 16px', fontSize:12, color:'#66cc66' }}>
            {created?.pocketName}
          </span>
        </div>
        {plugNames.map((name, i) => (
          <div key={i} style={{ marginBottom:8 }}>
            <span style={{ display:'inline-block', background:'#1a1a2a', border:'1px solid #2a2a5a', borderRadius:4, padding:'5px 16px', fontSize:12, color:'#6688cc' }}>
              {name}
            </span>
          </div>
        ))}
        <div style={{ fontSize:11, color:'#555577', lineHeight:1.8, marginTop:14 }}>
          Select each operation and click Calculate to generate toolpaths,<br />
          then export — each workspace produces its own G-code file.
        </div>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  // Picking mode: wizard shrinks to a bottom strip so the user can click entities on the canvas.
  if (picking) {
    const pickingLabel = pickingFor === 'pocket'
      ? 'Selecting pocket geometry'
      : `Selecting geometry for: ${wiz.plugs.find(p => p.id === pickingFor)?.name ?? 'Plug'}`;
    return (
      <div style={{ position:'fixed', bottom:0, left:0, right:0, zIndex:1000,
        background:'#1a1a38', borderTop:'2px solid #5555cc',
        padding:'10px 20px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ fontSize:12, color:'#aaaaff' }}>
          {pickingLabel} — click to toggle entities.
          <span style={{ color:'#6666aa', marginLeft:10 }}>
            {selectedEntityIds.length} selected
          </span>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button style={{ ...S.btn, ...S.btnSec }} onClick={() => setPickingFor(null)}>Cancel</button>
          <button style={{ ...S.btn, ...S.btnGrn }} onClick={() => {
            if (pickingFor === 'pocket') {
              set('entityIds', [...selectedEntityIds]);
            } else {
              updatePlug(pickingFor, 'entityIds', [...selectedEntityIds]);
            }
            setPickingFor(null);
          }}>
            Done — use {selectedEntityIds.length} {selectedEntityIds.length === 1 ? 'entity' : 'entities'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.wizard} onClick={e => e.stopPropagation()}>
        <div style={S.hdr}>
          <div style={S.hdrTitle}>Inlay Wizard</div>
          <StepBar current={step} />
        </div>

        <div style={S.body}>
          {step === 1 && renderStep1()}
          {step === 2 && renderStep2()}
          {step === 3 && renderStep3()}
          {step === 4 && renderStep4()}
          {step === 5 && renderStep5()}
        </div>

        <div style={S.footer}>
          {step < 5
            ? <button style={{ ...S.btn, ...S.btnRed }} onClick={onClose}>Cancel</button>
            : <div />
          }
          <div style={{ display:'flex', gap:8 }}>
            {step > 1 && step < 5 && (
              <button style={{ ...S.btn, ...S.btnSec }} onClick={() => setStep(s => s - 1)}>← Back</button>
            )}
            {step < 4 && (
              <button style={{ ...S.btn, ...S.btnPri }} onClick={() => setStep(s => s + 1)}>Next →</button>
            )}
            {step === 4 && (
              <button style={{ ...S.btn, ...S.btnGrn }} onClick={handleGenerate}>Create Operations</button>
            )}
            {step === 5 && (
              <button style={{ ...S.btn, ...S.btnPri }} onClick={onClose}>Close</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
