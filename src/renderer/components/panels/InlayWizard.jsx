import React, { useState } from 'react';

const MM = 25.4;

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

export default function InlayWizard({ onClose, onGenerate, selectedEntityIds = [], entities = [], tools = [], isInch = false }) {
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
    topZ:             0,
    safeZ:            10,
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
    mirrorX:          true,
  }));

  function set(key, val) { setWiz(w => ({ ...w, [key]: val })); }

  function selectTaperTool(id) {
    const t = id ? tools.find(t => String(t.id) === id) : null;
    setWiz(w => ({
      ...w,
      taperToolId: id || null,
      ...(t?.tipDiameter != null ? { tipDia: t.tipDiameter } : {}),
      ...(t?.taperAngle  != null ? { angle:  t.taperAngle  } : {}),
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

  // Fit calculations — fitTolerance is derived, never stored directly
  const taperRad     = Math.max(0.5, wiz.angle / 2) * Math.PI / 180;
  const fitTolerance = wiz.engagementDepth * Math.tan(taperRad);  // mm, back-calculated
  const plugProud    = wiz.engagementDepth;                        // mm — same value, different framing
  const engDepthIn   = wiz.engagementDepth / MM;
  const fitQuality   = engDepthIn < 0.030 ? 'tight' : engDepthIn > 0.100 ? 'loose' : engDepthIn > 0.080 ? 'getting_loose' : 'ideal';
  const fitColor     = { tight:'#ff4444', ideal:'#44cc88', getting_loose:'#ffaa33', loose:'#ff4444' }[fitQuality];
  const fitLabel     = { tight:'Too Tight', ideal:'Ideal', getting_loose:'Getting Loose', loose:'Too Loose' }[fitQuality];

  function buildPasses() {
    return {
      taperContour:  { enabled: true, toolId: wiz.taperToolId, angle: wiz.angle, tipDia: wiz.tipDia, rpm: wiz.taperRpm, feed: wiz.taperFeed, plunge: wiz.taperPlunge },
      taperCleanup:  { enabled: true, toolId: wiz.taperToolId, angle: wiz.angle, tipDia: wiz.tipDia, rpm: wiz.taperRpm, feed: wiz.taperFeed, plunge: wiz.taperPlunge, wallStock: wiz.cleanupWallStock },
      detailEndmill: { enabled: wiz.detailEnabled, toolId: wiz.detailToolId, diameter: wiz.detailDiameter, rpm: wiz.detailRpm, feed: wiz.detailFeed, plunge: wiz.detailPlunge, wallStock: wiz.detailWallStock },
      bulkEndmill:   { enabled: wiz.bulkEnabled,   toolId: wiz.bulkToolId,   diameter: wiz.bulkDiameter,   rpm: wiz.bulkRpm,   feed: wiz.bulkFeed,   plunge: wiz.bulkPlunge,   wallStock: wiz.bulkWallStock },
    };
  }

  function handleGenerate() {
    const passes = buildPasses();
    const base   = { topZ: wiz.topZ, safeZ: wiz.safeZ, pocketDepth: wiz.pocketDepth, passes };
    const pocketOp = {
      type: 'taperedpocket',
      name: `${wiz.jobName} — Pocket`,
      selectedIds: wiz.entityIds,
      params: { ...base, mirrorX: false, cutSide: 'inside' },
    };
    const plugOp = {
      type: 'taperedplug',
      name: `${wiz.jobName} — Plug`,
      selectedIds: wiz.entityIds,
      params: { ...base, mirrorX: wiz.mirrorX, fitTolerance, cutSide: 'outside' },
    };
    onGenerate(pocketOp, plugOp);
    setCreated({ pocketName: pocketOp.name, plugName: plugOp.name });
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
        {nSel === 0 ? (
          <div style={S.warn}>
            No entities selected. Close this wizard, select the inlay geometry on the canvas (click or Ctrl+click entities), then reopen the wizard.
          </div>
        ) : (
          <div style={S.info}>
            {nSel} {nSel === 1 ? 'entity' : 'entities'} selected{typeSummary ? `: ${typeSummary}` : ''}
          </div>
        )}

        <div style={S.sec}>Job</div>
        <F label="Job Name">
          <input style={S.inp} type="text" value={wiz.jobName} maxLength={60}
            onChange={e => set('jobName', e.target.value)} />
        </F>

        <div style={{ ...S.info, marginTop:12, marginBottom:0, fontSize:10 }}>
          Both the Pocket and Plug operations will use the currently selected entities as their geometry. You can reassign geometry from the Operations panel afterwards.
        </div>
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
            <Num value={d(wiz.topZ)} onChange={v => set('topZ', m(v))} step={dStep} />
          </F>
          <F label="Safe Z" unit={dUnit}>
            <Num value={d(wiz.safeZ)} onChange={v => set('safeZ', m(v))} min={0} step={dStep} />
          </F>
        </div>

        <div style={S.sec}>Taper Bit (Contour + Cleanup)</div>
        <ToolSel value={wiz.taperToolId} onChange={selectTaperTool} tools={taperTools} dUnit={dUnit} isInch={isInch} />
        <div style={S.grid2}>
          <F label="Taper Angle" unit="°">
            <Num value={wiz.angle} onChange={v => set('angle', v)} min={1} max={60} step={0.5} />
          </F>
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

        <div style={S.sec}>Orientation</div>
        <div style={{ ...S.row, marginBottom:6 }}>
          <input type="checkbox" style={{ marginRight:8, cursor:'pointer', width:15, height:15 }}
            checked={wiz.mirrorX} onChange={e => set('mirrorX', e.target.checked)} />
          <span style={{ fontSize:12, color:'#ccccee' }}>Mirror X</span>
          <span style={{ fontSize:10, color:'#555577', marginLeft:8 }}>(recommended for inlays)</span>
        </div>
        <div style={{ ...S.info, fontSize:10, marginTop:0 }}>
          Mirror X reflects the plug geometry across the horizontal axis, compensating for the physical flip of the plug piece when pressing into the pocket. Disable only if your geometry is symmetric.
        </div>

        <div style={S.sec}>Shared with Pocket</div>
        <div style={{ fontSize:11, color:'#555577', lineHeight:1.8 }}>
          Taper angle: {wiz.angle}° &nbsp;·&nbsp; Tip dia: {fmt(wiz.tipDia)} {dUnit} &nbsp;·&nbsp; Depth: {fmt(wiz.pocketDepth)} {dUnit}
        </div>
      </>
    );
  }

  function renderStep4() {
    const passList = [
      'Taper Contour',
      'Taper Cleanup',
      wiz.detailEnabled && 'Detail Endmill',
      wiz.bulkEnabled   && 'Bulk Endmill',
    ].filter(Boolean);

    return (
      <>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
          <div style={S.card}>
            <div style={S.cardT}>Pocket — {wiz.jobName}</div>
            <div style={S.kv}><span style={S.kvK}>Depth</span><span style={S.kvV}>{fmt(wiz.pocketDepth)} {dUnit}</span></div>
            <div style={S.kv}><span style={S.kvK}>Top of Stock</span><span style={S.kvV}>{fmt(wiz.topZ)} {dUnit}</span></div>
            <div style={S.kv}><span style={S.kvK}>Taper</span><span style={S.kvV}>{wiz.angle}° / ⌀{fmt(wiz.tipDia)}{dUnit} tip</span></div>
            <div style={S.kv}><span style={S.kvK}>Feed</span><span style={S.kvV}>{fmt(wiz.taperFeed, isInch ? 2 : 0)} {fUnit}</span></div>
            <div style={S.kv}><span style={S.kvK}>Plunge</span><span style={S.kvV}>{fmt(wiz.taperPlunge, isInch ? 2 : 0)} {fUnit}</span></div>
            <div style={{ marginTop:8, fontSize:10, color:'#444466', lineHeight:1.6 }}>
              Passes: {passList.join(' · ')}
            </div>
          </div>
          <div style={S.card}>
            <div style={S.cardT}>Plug — {wiz.jobName}</div>
            <div style={S.kv}><span style={S.kvK}>Engagement Depth</span><span style={{ ...S.kvV, color:fitColor }}>{fmt(plugProud, isInch ? 3 : 2)} {dUnit}</span></div>
            <div style={S.kv}><span style={S.kvK}>Fit Quality</span><span style={{ color:fitColor, fontWeight:700 }}>● {fitLabel}</span></div>
            <div style={S.kv}><span style={S.kvK}>Mirror X</span><span style={{ ...S.kvV, color: wiz.mirrorX ? '#44cc88' : '#cc6666' }}>{wiz.mirrorX ? 'Yes' : 'No'}</span></div>
            <div style={S.kv}><span style={S.kvK}>Taper</span><span style={S.kvV}>{wiz.angle}° / ⌀{fmt(wiz.tipDia)}{dUnit} tip</span></div>
            <div style={S.kv}><span style={S.kvK}>Depth</span><span style={S.kvV}>{fmt(wiz.pocketDepth)} {dUnit}</span></div>
          </div>
        </div>

        <div style={S.fitCard}>
          <div style={S.fitTit}>Fit Preview</div>
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
            Ideal range: {isInch ? '0.030–0.080"' : '0.76–2.03 mm'} engagement · Adjust Taper Angle to shift the range for your material
          </div>
        </div>

        {wiz.entityIds.length === 0 && (
          <div style={{ ...S.warn, marginTop:12 }}>
            No geometry selected — operations will be created without entity assignments. You can assign geometry from the Operations panel.
          </div>
        )}
      </>
    );
  }

  function renderStep5() {
    return (
      <div style={{ textAlign:'center', padding:'32px 16px' }}>
        <div style={{ fontSize:52, marginBottom:12 }}>✓</div>
        <div style={{ fontSize:18, fontWeight:700, color:'#44cc88', marginBottom:8 }}>Operations Created</div>
        <div style={{ fontSize:12, color:'#8888aa', marginBottom:18 }}>
          Two operations have been added to the Operations panel:
        </div>
        <div style={{ marginBottom:6 }}>
          <span style={{ display:'inline-block', background:'#1a2a1a', border:'1px solid #2a5a2a', borderRadius:4, padding:'5px 16px', fontSize:12, color:'#66cc66' }}>
            {created?.pocketName}
          </span>
        </div>
        <div style={{ marginBottom:22 }}>
          <span style={{ display:'inline-block', background:'#1a1a2a', border:'1px solid #2a2a5a', borderRadius:4, padding:'5px 16px', fontSize:12, color:'#6688cc' }}>
            {created?.plugName}
          </span>
        </div>
        <div style={{ fontSize:11, color:'#555577', lineHeight:1.8 }}>
          Select each operation and click Calculate to generate toolpaths,<br />
          then use Export G-code for inlay two-file output.
        </div>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

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
