import React, { useEffect, useCallback, useState } from 'react';
import { useApp } from './store/AppContext';
import CAMCanvas from './components/canvas/CAMCanvas';
import OperationsPanel from './components/panels/OperationsPanel';
import ToolLibraryPanel from './components/panels/ToolLibraryPanel';
import LayersPanel from './components/panels/LayersPanel';
import GcodePanel from './components/panels/GcodePanel';
import StockPanel from './components/panels/StockPanel';
import { parseDxf, getBounds } from './dxf/parser';
import { generateGcode } from './gcode/postprocessor';

// ── Modal styles ──────────────────────────────────────────────────────────────
const MS = {
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' },
  box: { background:'#1a1a38', border:'1px solid #3a3a70', borderRadius:8, padding:'20px 24px', minWidth:420, maxWidth:560, color:'#ccc', fontFamily:'system-ui,sans-serif' },
  title: { fontSize:15, fontWeight:700, color:'#aaaaff', marginBottom:16 },
  grid: { display:'grid', gridTemplateColumns:'140px 1fr', gap:'8px 12px', alignItems:'center', marginBottom:8 },
  label: { fontSize:11, color:'#8888aa', textAlign:'right' },
  input: { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:4, padding:'4px 8px', fontSize:12, width:'100%' },
  select: { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:4, padding:'4px 6px', fontSize:12, width:'100%' },
  check: { width:16, height:16 },
  section: { fontSize:10, color:'#5555aa', textTransform:'uppercase', letterSpacing:1, marginTop:12, marginBottom:6, borderBottom:'1px solid #2a2a40', paddingBottom:3, gridColumn:'1/-1' },
  btnRow: { display:'flex', justifyContent:'flex-end', gap:8, marginTop:16 },
  btn: { padding:'6px 16px', borderRadius:4, cursor:'pointer', fontSize:12, border:'none' },
  btnPrimary: { background:'#3a3aaa', color:'#fff' },
  btnSecondary: { background:'#2a2a4a', color:'#aaa', border:'1px solid #3a3a60' },
  note: { fontSize:10, color:'#555577', fontStyle:'italic', gridColumn:'1/-1', marginTop:2 },
};

function Field({ label, children, note }) {
  return <>
    <span style={MS.label}>{label}</span>
    <div>{children}{note && <div style={MS.note}>{note}</div>}</div>
  </>;
}

// ── Machine Setup Modal ───────────────────────────────────────────────────────
function MachineSetupModal({ config, onSave, onClose }) {
  const [cfg, setCfg] = useState({ ...config });
  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }));

  return (
    <div style={MS.overlay} onClick={onClose}>
      <div style={MS.box} onClick={e => e.stopPropagation()}>
        <div style={MS.title}>⚙ Machine Setup</div>
        <div style={MS.grid}>
          <span style={{ ...MS.label, ...MS.section, textAlign:'left' }}>Identity</span>
          <Field label="Machine Name">
            <input style={MS.input} value={cfg.name} onChange={e => set('name', e.target.value)} />
          </Field>
          <span style={{ ...MS.section, gridColumn:'1/-1' }}>Work Area</span>
          <Field label="X Travel (mm)">
            <input style={MS.input} type="number" value={cfg.workAreaX} onChange={e => set('workAreaX', +e.target.value)} />
          </Field>
          <Field label="Y Travel (mm)">
            <input style={MS.input} type="number" value={cfg.workAreaY} onChange={e => set('workAreaY', +e.target.value)} />
          </Field>
          <Field label="Z Travel (mm)">
            <input style={MS.input} type="number" value={cfg.workAreaZ} onChange={e => set('workAreaZ', +e.target.value)} />
          </Field>
          <span style={{ ...MS.section, gridColumn:'1/-1' }}>Speeds</span>
          <Field label="Max Spindle (RPM)">
            <input style={MS.input} type="number" step="1000" value={cfg.maxSpindle} onChange={e => set('maxSpindle', +e.target.value)} />
          </Field>
          <Field label="Max Feed XY (mm/min)">
            <input style={MS.input} type="number" step="500" value={cfg.maxFeedXY} onChange={e => set('maxFeedXY', +e.target.value)} />
          </Field>
          <Field label="Max Feed Z (mm/min)">
            <input style={MS.input} type="number" step="100" value={cfg.maxFeedZ} onChange={e => set('maxFeedZ', +e.target.value)} />
          </Field>
          <span style={{ ...MS.section, gridColumn:'1/-1' }}>Defaults</span>
          <Field label="Safe Z (mm)">
            <input style={MS.input} type="number" value={cfg.safeZ} onChange={e => set('safeZ', +e.target.value)} />
          </Field>
        </div>
        <div style={MS.btnRow}>
          <button style={{ ...MS.btn, ...MS.btnSecondary }} onClick={onClose}>Cancel</button>
          <button style={{ ...MS.btn, ...MS.btnPrimary }} onClick={() => { onSave(cfg); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Post Processor Modal ──────────────────────────────────────────────────────
function PostSettingsModal({ config, onSave, onClose }) {
  const [cfg, setCfg] = useState({ ...config });
  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }));

  return (
    <div style={MS.overlay} onClick={onClose}>
      <div style={MS.box} onClick={e => e.stopPropagation()}>
        <div style={MS.title}>📄 Post Processor — Masso G3</div>
        <div style={MS.grid}>
          <span style={{ ...MS.section, gridColumn:'1/-1' }}>Units</span>
          <Field label="Output Units" note="All depths/feeds entered in mm — post converts automatically">
            <select style={MS.select} value={cfg.units} onChange={e => set('units', e.target.value)}>
              <option value="mm">Metric (mm) — G21</option>
              <option value="inch">Imperial (inch) — G20</option>
            </select>
          </Field>
          <span style={{ ...MS.section, gridColumn:'1/-1' }}>Masso G3 Settings</span>
          <Field label="Coolant">
            <select style={MS.select} value={cfg.coolant} onChange={e => set('coolant', e.target.value)}>
              <option value="off">Off (no M8/M9)</option>
              <option value="flood">Flood (M8)</option>
              <option value="mist">Mist (M7)</option>
            </select>
          </Field>
          <Field label="Spindle Ramp Delay" note="Seconds to dwell after M3 before moving">
            <input style={MS.input} type="number" step="0.5" min="0" value={cfg.spindleDelay} onChange={e => set('spindleDelay', +e.target.value)} />
          </Field>
          <Field label="Safe Z (mm)">
            <input style={MS.input} type="number" value={cfg.safeZ} onChange={e => set('safeZ', +e.target.value)} />
          </Field>
          <Field label="Tool Change Z (mm)">
            <input style={MS.input} type="number" value={cfg.toolChangeZ} onChange={e => set('toolChangeZ', +e.target.value)} />
          </Field>
          <span style={{ ...MS.section, gridColumn:'1/-1' }}>Output Format</span>
          <Field label="Line Numbering">
            <input type="checkbox" style={MS.check} checked={cfg.lineNumbering} onChange={e => set('lineNumbering', e.target.checked)} />
          </Field>
          <Field label="Line Increment">
            <input style={MS.input} type="number" step="5" min="1" value={cfg.lineIncrement} onChange={e => set('lineIncrement', +e.target.value)} />
          </Field>
          <span style={{ ...MS.section, gridColumn:'1/-1' }}>End of Program</span>
          <Field label="Home at End" note="Uses G28 (Masso machine home)">
            <input type="checkbox" style={MS.check} checked={cfg.homeAtEnd} onChange={e => set('homeAtEnd', e.target.checked)} />
          </Field>
          <span style={{ ...MS.section, gridColumn:'1/-1' }}>Masso G3 Notes</span>
          <div style={{ gridColumn:'1/-1', fontSize:10, color:'#555577', lineHeight:1.6 }}>
            • No G43/G49 — Masso handles tool offsets internally<br/>
            • No G40 — cutter comp via CAM only<br/>
            • Tool change format: T1 M6<br/>
            • G28 returns to machine home position
          </div>
        </div>
        <div style={MS.btnRow}>
          <button style={{ ...MS.btn, ...MS.btnSecondary }} onClick={onClose}>Cancel</button>
          <button style={{ ...MS.btn, ...MS.btnPrimary }} onClick={() => { onSave(cfg); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── About Modal ───────────────────────────────────────────────────────────────
function AboutModal({ onClose }) {
  return (
    <div style={MS.overlay} onClick={onClose}>
      <div style={{ ...MS.box, minWidth:340, textAlign:'center' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:40, marginBottom:8 }}>📐</div>
        <div style={{ fontSize:22, fontWeight:700, color:'#aaaaff', marginBottom:4 }}>MassoCAM</div>
        <div style={{ fontSize:12, color:'#666688', marginBottom:16 }}>2.5D CAM for Masso G3 CNC Router</div>
        <div style={{ fontSize:11, color:'#8888aa', lineHeight:1.8, marginBottom:16 }}>
          Operations: Contour · Pocket · Adaptive · Face<br/>
          Drill · Bore · Circular · Engrave · Trace<br/>
          Slot · Chamfer · Thread<br/><br/>
          Post Processor: Masso G3 (Fanuc dialect)<br/>
          DXF Import: R12 — 2024
        </div>
        <div style={{ fontSize:10, color:'#444466', marginBottom:16 }}>
          Built with Electron + React<br/>
          Developed by Mike Parnell<br/>
          A DMD Product
        </div>
        <button style={{ ...MS.btn, ...MS.btnPrimary, width:'100%' }} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ── Layout styles ─────────────────────────────────────────────────────────────
const S = {
  app: { display:'flex', flexDirection:'column', height:'100vh', background:'#0d0d1a', color:'#ccc', fontFamily:'system-ui,sans-serif', overflow:'hidden' },
  topbar: { height:36, display:'flex', alignItems:'center', background:'#111128', borderBottom:'1px solid #2a2a50', padding:'0 10px', gap:8, flexShrink:0 },
  logo: { fontSize:13, fontWeight:700, color:'#7777ff', letterSpacing:1, marginRight:8, flexShrink:0 },
  tbBtn: { background:'none', border:'1px solid #2a2a50', color:'#aaaacc', borderRadius:3, padding:'3px 8px', cursor:'pointer', fontSize:11, whiteSpace:'nowrap' },
  tbBtnActive: { background:'#2a2a5a', border:'1px solid #4a4aaa', color:'#ccccff' },
  statusBar: { height:22, background:'#0a0a18', borderTop:'1px solid #1a1a38', display:'flex', alignItems:'center', padding:'0 10px', fontSize:10, color:'#555577', flexShrink:0 },
  main: { flex:1, display:'flex', overflow:'hidden' },
  leftPanel: { width:200, flexShrink:0, borderRight:'1px solid #2a2a50', display:'flex', flexDirection:'column', overflow:'hidden' },
  canvas: { flex:1, overflow:'hidden' },
  rightPanel: { width:290, flexShrink:0, borderLeft:'1px solid #2a2a50', display:'flex', flexDirection:'column', overflow:'hidden' },
  tabBar: { display:'flex', borderBottom:'1px solid #2a2a50', flexShrink:0 },
  tab: (active) => ({ flex:1, padding:'5px 4px', textAlign:'center', cursor:'pointer', fontSize:10, color: active ? '#aaaaff' : '#555577', background: active ? '#1a1a38' : 'transparent', borderBottom: active ? '2px solid #5555cc' : '2px solid transparent', fontWeight: active ? 600 : 400 }),
  selInfo: { padding:'4px 8px', fontSize:10, color:'#555577', borderBottom:'1px solid #1a1a38' },
  unitBadge: { fontSize:10, color:'#5555aa', border:'1px solid #2a2a50', borderRadius:3, padding:'1px 5px', marginLeft:4 },
};

export default function App() {
  const { state, dispatch, getProject } = useApp();
  const { activePanelTab, statusMessage, selectedEntityIds, entities, operations, postConfig } = state;
  const [modal, setModal] = useState(null); // 'machine' | 'post' | 'about'

  useEffect(() => {
    if (window.electron) {
      window.electron.getTools().then(tools => dispatch({ type: 'SET_TOOLS', payload: tools }));
    }
  }, []);

  useEffect(() => {
    if (!window.electron) return;
    return window.electron.onMenu(async (event, ...args) => {
      switch (event) {
        case 'menu-import-dxf':       importDxf(); break;
        case 'menu-export-gcode':     exportGcode(); break;
        case 'menu-zoom-fit':         dispatch({ type: 'RESET_VIEWPORT' }); break;
        case 'menu-toggle-toolpaths': dispatch({ type: 'TOGGLE_TOOLPATHS' }); break;
        case 'menu-toggle-rapids':    dispatch({ type: 'TOGGLE_RAPIDS' }); break;
        case 'menu-tool-library':     dispatch({ type: 'SET_PANEL_TAB', payload: 'tools' }); break;
        case 'menu-machine-setup':    setModal('machine'); break;
        case 'menu-post-settings':    setModal('post'); break;
        case 'menu-about':            setModal('about'); break;
        case 'menu-new-project':      newProject(); break;
        case 'menu-open-project':     openProject(); break;
        case 'menu-save-project':     saveProject(false); break;
        case 'menu-save-project-as':  saveProject(true); break;
        case 'menu-select-all':       dispatch({ type: 'SELECT_ENTITIES', payload: entities.map(e => e.id) }); break;
      }
    });
  }, [state, entities, operations]);

  const importDxf = useCallback(async () => {
    try {
      let content;
      if (window.electron) {
        const result = await window.electron.openDxf();
        if (!result) return;
        content = result.content;
      } else {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.dxf';
        content = await new Promise((res, rej) => {
          input.onchange = e => { const f = e.target.files[0]; if (!f) return rej(); const r = new FileReader(); r.onload = ev => res(ev.target.result); r.readAsText(f); };
          input.click();
        });
      }
      dispatch({ type: 'SET_STATUS', payload: 'Parsing DXF...' });
      const { entities, layers, dxfUnits } = parseDxf(content);
      const bounds = getBounds(entities);
      dispatch({ type: 'SET_DXF', payload: { entities, layers, bounds } });

      const appUnits = state.postConfig?.units ?? 'mm';
      let statusMsg;
      if (dxfUnits !== 'unitless' && dxfUnits !== appUnits) {
        const dxfLabel = dxfUnits === 'inch' ? 'inches' : 'mm';
        const appLabel = appUnits === 'inch' ? 'inches' : 'mm';
        statusMsg = `DXF imported as ${dxfLabel} — your current unit setting is ${appLabel}, coordinates have been converted`;
      } else {
        const unitNote = dxfUnits === 'unitless' ? 'unitless' : dxfUnits === 'inch' ? 'inches' : 'mm';
        statusMsg = `Loaded ${entities.length} entities from ${Object.keys(layers).length} layers (DXF: ${unitNote})`;
      }
      dispatch({ type: 'SET_STATUS', payload: statusMsg });
    } catch (err) {
      dispatch({ type: 'SET_STATUS', payload: 'DXF import failed: ' + err.message });
    }
  }, [dispatch]);

  const exportGcode = useCallback(async () => {
    const enabled = operations.filter(op => op.enabled && op.toolpath?.moves?.length > 0);
    if (enabled.length === 0) {
      dispatch({ type: 'SET_STATUS', payload: 'Calculate operations first' });
      dispatch({ type: 'SET_PANEL_TAB', payload: 'gcode' });
      return;
    }
    const gcode = generateGcode(enabled, {
      ...state.postConfig,
      wcs: state.stockConfig.wcs,
      stockOriginX: state.stockConfig.stockOriginX ?? 0,
      stockOriginY: state.stockConfig.stockOriginY ?? 0,
    });
    dispatch({ type: 'SET_GCODE', payload: gcode });
    dispatch({ type: 'SET_PANEL_TAB', payload: 'gcode' });
    if (window.electron) {
      const path = await window.electron.saveGcode('toolpath.nc');
      if (path) { await window.electron.writeFile(path, gcode); dispatch({ type: 'SET_STATUS', payload: `Exported: ${path}` }); }
    }
  }, [operations, state.postConfig, dispatch]);

  const newProject = useCallback(() => {
    if (state.dirty && !window.confirm('Discard unsaved changes?')) return;
    dispatch({ type: 'LOAD_PROJECT', payload: {} });
    dispatch({ type: 'SET_STATUS', payload: 'New project' });
  }, [state.dirty, dispatch]);

  const openProject = useCallback(async () => {
    if (state.dirty && !window.confirm('Discard unsaved changes?')) return;
    if (window.electron) {
      const result = await window.electron.openProject();
      if (result) { dispatch({ type: 'LOAD_PROJECT', payload: result.data }); dispatch({ type: 'SET_PROJECT_PATH', payload: result.path }); dispatch({ type: 'SET_STATUS', payload: `Opened: ${result.path}` }); }
    }
  }, [state.dirty, dispatch]);

  const saveProject = useCallback(async (saveAs = false) => {
    const data = JSON.stringify(getProject(), null, 2);
    if (window.electron) {
      let path = saveAs ? null : state.projectPath;
      if (!path) path = await window.electron.saveProject(state.projectPath);
      if (path) { await window.electron.writeFile(path, data); dispatch({ type: 'SET_PROJECT_PATH', payload: path }); dispatch({ type: 'SET_DIRTY', payload: false }); dispatch({ type: 'SET_STATUS', payload: `Saved: ${path}` }); }
    }
  }, [getProject, state.projectPath, dispatch]);

  const enabledOpsCount = operations.filter(o => o.enabled).length;
  const calculatedCount = operations.filter(o => o.enabled && o.toolpath).length;
  const unitsLabel = postConfig.units === 'inch' ? 'INCH' : 'MM';

  return (
    <div style={S.app}>
      {/* Modals */}
      {modal === 'machine' && (
        <MachineSetupModal
          config={state.machineConfig}
          onSave={cfg => dispatch({ type: 'SET_MACHINE_CONFIG', payload: cfg })}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'post' && (
        <PostSettingsModal
          config={state.postConfig}
          onSave={cfg => {
            dispatch({ type: 'SET_POST_CONFIG', payload: cfg });
            if (window.electron) {
              window.electron.storeSet('pref.units',       cfg.units);
              window.electron.storeSet('pref.safeZ',       cfg.safeZ);
              window.electron.storeSet('pref.toolChangeZ', cfg.toolChangeZ);
            }
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'about' && <AboutModal onClose={() => setModal(null)} />}

      {/* Top Toolbar */}
      <div style={S.topbar}>
        <span style={S.logo}>MASSOCAM</span>
        <div style={{ display:'flex', gap:4, flex:1 }}>
          <button style={S.tbBtn} onClick={importDxf}>📐 Import DXF</button>
          <button style={S.tbBtn} onClick={exportGcode}>💾 Export G-code</button>
          <div style={{ width:1, background:'#2a2a50', margin:'0 4px' }} />
          <button style={{ ...S.tbBtn, ...(state.showToolpaths ? S.tbBtnActive : {}) }} onClick={() => dispatch({ type: 'TOGGLE_TOOLPATHS' })}>⬡ Paths</button>
          <button style={{ ...S.tbBtn, ...(state.showRapids ? S.tbBtnActive : {}) }} onClick={() => dispatch({ type: 'TOGGLE_RAPIDS' })}>↗ Rapids</button>
          <div style={{ width:1, background:'#2a2a50', margin:'0 4px' }} />
          <button style={S.tbBtn} onClick={() => setModal('post')} title="Post processor settings">
            Post <span style={S.unitBadge}>{unitsLabel}</span>
          </button>
          <button style={S.tbBtn} onClick={() => setModal('machine')}>Machine</button>
          <div style={{ flex:1 }} />
          <span style={{ fontSize:10, color:'#444466' }}>
            {enabledOpsCount > 0 ? `${calculatedCount}/${enabledOpsCount} ops calculated` : ''}
          </span>
        </div>
      </div>

      <div style={S.main}>
        <div style={S.leftPanel}><LayersPanel /></div>
        <div style={S.canvas}><CAMCanvas /></div>
        <div style={S.rightPanel}>
          <div style={S.tabBar}>
            {[['operations','Ops'],['tools','Tools'],['stock','Stock'],['gcode','G-code']].map(([tab, label]) => (
              <div key={tab} style={S.tab(activePanelTab === tab)} onClick={() => dispatch({ type: 'SET_PANEL_TAB', payload: tab })}>{label}</div>
            ))}
          </div>
          {selectedEntityIds.length > 0 && activePanelTab === 'operations' && (
            <div style={S.selInfo}>{selectedEntityIds.length} entities selected (Ctrl+click to add)</div>
          )}
          <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
            {activePanelTab === 'operations' && <OperationsPanel />}
            {activePanelTab === 'tools'      && <ToolLibraryPanel />}
            {activePanelTab === 'stock'      && <StockPanel />}
            {activePanelTab === 'gcode'      && <GcodePanel />}
          </div>
        </div>
      </div>

      <div style={S.statusBar}>
        <span>{statusMessage || 'Ready'}</span>
        <div style={{ flex:1 }} />
        <span>
          {entities.length > 0 && `${entities.length} entities · `}
          {operations.length > 0 && `${operations.length} operations · `}
          {unitsLabel} · Zoom: {(state.viewport.zoom * 100).toFixed(0)}%
        </span>
      </div>
    </div>
  );
}
