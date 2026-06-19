import React, { useEffect, useCallback, useState, useRef } from 'react';
import { v4 as uuid } from 'uuid';
import { useApp } from './store/AppContext';
import CAMCanvas from './components/canvas/CAMCanvas';
import OperationsPanel from './components/panels/OperationsPanel';
import ToolLibraryPanel from './components/panels/ToolLibraryPanel';
import LayersPanel from './components/panels/LayersPanel';
import GcodePanel from './components/panels/GcodePanel';
import StockPanel from './components/panels/StockPanel';
import CADPropertiesPanel from './components/panels/CADPropertiesPanel';
import ArrayModal from './components/modals/ArrayModal';
import { parseDxf, getBounds } from './dxf/parser';
import { exportDxf as generateDxf } from './dxf/exporter';
import { generateGcode, generateGcodeByTool } from './gcode/postprocessor';
import { offsetEntity } from './cam/offsetEngine';
import { traceImage, fitArcsToChain } from './cam/traceEngine';
import InlayWizard from './components/panels/InlayWizard';
import ToolLibraryModal from './components/panels/ToolLibraryModal';
import MachineProfilesModal from './components/panels/MachineProfilesModal';
import CADToolsPanel from './components/panels/CADToolsPanel';
import { version as appVersion } from '../../package.json';

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
        <img src={`${process.env.PUBLIC_URL}/dmdcam-logo.png`} alt="DMDCAM" style={{ height:80, marginBottom:12, objectFit:'contain' }} />
        <div style={{ fontSize:22, fontWeight:700, color:'#aaaaff', marginBottom:2 }}>DMDCAM</div>
        <div style={{ fontSize:11, color:'#5555aa', marginBottom:4, fontFamily:'monospace' }}>v{appVersion}</div>
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
  const { activePanelTab, statusMessage, selectedEntityIds, entities, operations, postConfig, activeTool, cadMode, refImage } = state;
  const isInch = postConfig.units === 'inch';
  const MM_PER_INCH = 25.4;
  const [modal, setModal] = useState(null); // 'profiles' | 'tool-library' | 'about' | 'inlay-wizard'
  const [showArrayModal, setShowArrayModal] = useState(false);
  const [offsetModal, setOffsetModal] = useState(null); // null | { distance: '', direction: 'both' }
  const refImageElRef = useRef(null); // cached HTMLImageElement for tracing

  useEffect(() => {
    if (window.electron) {
      window.electron.getTools().then(tools => dispatch({ type: 'SET_TOOLS', payload: tools }));
    }
  }, []);

  // Load a project file passed as CLI argument (file association double-click at launch)
  useEffect(() => {
    if (!window.electron?.getInitialFile) return;
    window.electron.getInitialFile().then(result => {
      if (result) {
        dispatch({ type: 'LOAD_PROJECT', payload: result.data });
        dispatch({ type: 'SET_PROJECT_PATH', payload: result.path });
        dispatch({ type: 'SET_STATUS', payload: `Opened: ${result.path}` });
      }
    });
  }, []);

  // Load a project file when the app is already running and a second .dmdcam is double-clicked
  useEffect(() => {
    if (!window.electron?.onOpenFile) return;
    return window.electron.onOpenFile((result) => {
      if (result) {
        dispatch({ type: 'LOAD_PROJECT', payload: result.data });
        dispatch({ type: 'SET_PROJECT_PATH', payload: result.path });
        dispatch({ type: 'SET_STATUS', payload: `Opened: ${result.path}` });
      }
    });
  }, [dispatch]);

  useEffect(() => {
    if (!window.electron) return;
    return window.electron.onMenu(async (event, ...args) => {
      switch (event) {
        case 'menu-import-dxf':       importDxf(); break;
        case 'menu-export-dxf':       exportDxfFile(); break;
        case 'menu-export-gcode':     exportGcode(); break;
        case 'menu-zoom-fit':         dispatch({ type: 'RESET_VIEWPORT' }); break;
        case 'menu-toggle-toolpaths': dispatch({ type: 'TOGGLE_TOOLPATHS' }); break;
        case 'menu-toggle-rapids':    dispatch({ type: 'TOGGLE_RAPIDS' }); break;
        case 'menu-tool-library':     setModal('tool-library'); break;
        case 'menu-machine-setup':    setModal('profiles'); break;
        case 'menu-post-settings':    setModal('profiles'); break;
        case 'menu-about':            setModal('about'); break;
        case 'menu-inlay-wizard':    setModal('inlay-wizard'); break;
        case 'menu-new-project':      newProject(); break;
        case 'menu-open-project':     openProject(); break;
        case 'menu-save-project':     saveProject(false); break;
        case 'menu-save-project-as':  saveProject(true); break;
        case 'menu-select-all':       dispatch({ type: 'SELECT_ENTITIES', payload: entities.map(e => e.id) }); break;
        case 'menu-import-image':     importRefImage(); break;
      }
    });
  }, [state, entities, operations]);

  // CAD tool keyboard shortcuts
  useEffect(() => {
    const TOOL_KEYS = {
      s: 'select', l: 'line', c: 'circle', a: 'arc',
      r: 'rect',   p: 'polyline', m: 'mirror',
      t: 'trim',   e: 'extend',   f: 'fillet', h: 'chamfer',
    };
    const onKey = (ev) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!cadMode || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      // A / L / C / 3 are handled inside the polyline tool itself — don't intercept them here
      if (activeTool === 'polyline') return;
      const tool = TOOL_KEYS[ev.key.toLowerCase()];
      if (tool) { ev.preventDefault(); dispatch({ type: 'SET_ACTIVE_TOOL', payload: tool }); return; }
      if (ev.key.toLowerCase() === 'o' && selectedEntityIds.length > 0) {
        ev.preventDefault();
        setOffsetModal({ distance: isInch ? '0.1' : '2', direction: 'expand' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cadMode, activeTool, selectedEntityIds, dispatch, isInch]);

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

  const exportDxfFile = useCallback(async () => {
    if (entities.length === 0) {
      dispatch({ type: 'SET_STATUS', payload: 'No entities to export' });
      return;
    }
    const dxfContent = generateDxf(entities, state.layers, operations);
    if (window.electron) {
      const savePath = await window.electron.saveDxf('export.dxf');
      if (savePath) {
        await window.electron.writeFile(savePath, dxfContent);
        dispatch({ type: 'SET_STATUS', payload: `DXF exported: ${savePath.split(/[\\/]/).pop()}` });
      }
    } else {
      const blob = new Blob([dxfContent], { type: 'application/dxf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'export.dxf';
      a.click();
      URL.revokeObjectURL(a.href);
      dispatch({ type: 'SET_STATUS', payload: 'DXF exported' });
    }
  }, [entities, state.layers, operations, dispatch]);

  const exportGcode = useCallback(async () => {
    const enabled = operations.filter(op => op.enabled && op.toolpath?.moves?.length > 0);
    if (enabled.length === 0) {
      dispatch({ type: 'SET_STATUS', payload: 'Calculate operations first' });
      dispatch({ type: 'SET_PANEL_TAB', payload: 'gcode' });
      return;
    }
    const gcfg = {
      ...state.postConfig,
      wcs: state.stockConfig.wcs,
      stockOriginX: state.stockConfig.stockOriginX ?? 0,
      stockOriginY: state.stockConfig.stockOriginY ?? 0,
    };

    const pocketOps = enabled.filter(op => op.type === 'taperedpocket');
    const plugOps   = enabled.filter(op => op.type === 'taperedplug');
    const isInlay   = pocketOps.length > 0 && plugOps.length > 0;
    const toolsList = state.tools || [];

    // Build the complete list of {seg, suffix, gcode} to save.
    // seg = '' | 'pocket' | 'plug';  suffix = '' | '_T1' | '_T2' ...
    let fileList;
    if (isInlay) {
      const pocketGroups = generateGcodeByTool(pocketOps, toolsList, gcfg);
      const plugGroups   = generateGcodeByTool(plugOps,   toolsList, gcfg);
      fileList = [
        ...pocketGroups.map(g => ({ seg: 'pocket', suffix: g.suffix, gcode: g.gcode })),
        ...plugGroups.map(g =>   ({ seg: 'plug',   suffix: g.suffix, gcode: g.gcode })),
      ];
    } else {
      const groups = generateGcodeByTool(enabled, toolsList, gcfg);
      fileList = groups.map(g => ({ seg: '', suffix: g.suffix, gcode: g.gcode }));
    }

    const isMulti = fileList.length > 1 || isInlay;
    dispatch({ type: 'SET_PANEL_TAB', payload: 'gcode' });

    if (!isMulti) {
      // Single file — update panel preview, then save directly.
      dispatch({ type: 'SET_GCODE', payload: fileList[0].gcode });
      if (window.electron) {
        const path = await window.electron.saveGcode('toolpath.nc');
        if (path) {
          await window.electron.writeFile(path, fileList[0].gcode);
          dispatch({ type: 'SET_STATUS', payload: `Exported: ${path.split(/[\\/]/).pop()}` });
        }
      }
      return;
    }

    // Multi-file — ask for base filename once, derive all paths from it.
    let base;
    if (window.electron) {
      const chosenPath = await window.electron.saveGcodeInlay(isInlay ? 'inlay.nc' : 'toolpath.nc');
      if (!chosenPath) return;
      base = chosenPath.replace(/\.[^.\\/]+$/, '');
    } else {
      base = isInlay ? 'inlay' : 'toolpath';
    }

    const saved = [];
    for (const { seg, suffix, gcode } of fileList) {
      const segPart  = seg ? `_${seg}` : '';
      const filename = `${base}${segPart}${suffix}.nc`;
      if (window.electron) {
        await window.electron.writeFile(filename, gcode);
      } else {
        const blob = new Blob([gcode], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${base.split(/[\\/]/).pop()}${segPart}${suffix}.nc`;
        a.click();
        URL.revokeObjectURL(a.href);
      }
      saved.push(filename.split(/[\\/]/).pop());
    }
    dispatch({ type: 'SET_STATUS', payload: `Exported: ${saved.join(', ')}` });
  }, [operations, state.postConfig, state.stockConfig, state.tools, dispatch]);

  const importRefImage = useCallback(async () => {
    let dataUrl;
    if (window.electron) {
      dataUrl = await window.electron.openImage();
    } else {
      dataUrl = await new Promise((res, rej) => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = ev => {
          const f = ev.target.files[0]; if (!f) return rej();
          const r = new FileReader();
          r.onload = e => res(e.target.result);
          r.readAsDataURL(f);
        };
        inp.click();
      });
    }
    if (!dataUrl) return;
    // Load the image to get natural dimensions
    const img = new Image();
    img.onload = () => {
      refImageElRef.current = img;
      // Default scale: fit the image into ~200mm wide area
      const mmPerPixel = Math.min(0.5, 200 / (img.naturalWidth || 1));
      dispatch({ type: 'SET_REF_IMAGE', payload: { dataUrl, x: 0, y: 0, mmPerPixel, opacity: 0.35 } });
      dispatch({ type: 'SET_STATUS', payload: `Reference image loaded (${img.naturalWidth}×${img.naturalHeight}px)` });
    };
    img.src = dataUrl;
  }, [dispatch]);

  const runAutoTrace = useCallback(async () => {
    if (!refImage || !refImageElRef.current) {
      dispatch({ type: 'SET_STATUS', payload: 'Load a reference image first' });
      return;
    }
    dispatch({ type: 'SET_STATUS', payload: 'Tracing…' });
    try {
      const chains = traceImage(refImageElRef.current, refImage, 0.5, 0.5);
      if (!chains.length) { dispatch({ type: 'SET_STATUS', payload: 'Trace found no outlines (try adjusting threshold)' }); return; }
      const newEntities = [];
      let lineCount = 0, arcCount = 0;
      for (const verts of chains) {
        const segs = fitArcsToChain(verts, 0.35, 15);
        for (const seg of segs) {
          if (seg.type === 'line') {
            newEntities.push({ id: uuid(), type: 'line', layer: '0', start: seg.start, end: seg.end });
            lineCount++;
          } else if (seg.type === 'arc') {
            newEntities.push({ id: uuid(), type: 'arc', layer: '0', center: seg.center, radius: seg.radius, startAngle: seg.startAngle, endAngle: seg.endAngle });
            arcCount++;
          }
        }
      }
      dispatch({ type: 'ADD_ENTITIES', payload: newEntities });
      dispatch({ type: 'SET_STATUS', payload: `Traced ${chains.length} outline${chains.length > 1 ? 's' : ''}: ${lineCount} lines, ${arcCount} arcs` });
    } catch (err) {
      dispatch({ type: 'SET_STATUS', payload: 'Trace failed: ' + err.message });
    }
  }, [refImage, dispatch]);

  function runOffset(distance, direction) {
    const sel = entities.filter(e => selectedEntityIds.includes(e.id));
    if (!sel.length) return;
    const newEnts = [];
    const dirs = direction === 'both' ? [distance, -distance] : direction === 'expand' ? [distance] : [-distance];
    for (const d of dirs) {
      for (const e of sel) {
        const o = offsetEntity(e, d);
        if (o) newEnts.push({ ...o, id: uuid() });
      }
    }
    if (newEnts.length) {
      dispatch({ type: 'ADD_ENTITIES', payload: newEnts });
      dispatch({ type: 'SET_STATUS', payload: `Offset created ${newEnts.length} entit${newEnts.length > 1 ? 'ies' : 'y'}` });
    }
    setOffsetModal(null);
  }

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

  function handleInlayGenerate(pocketOp, plugOp) {
    dispatch({ type: 'ADD_OPERATION', payload: pocketOp });
    dispatch({ type: 'ADD_OPERATION', payload: plugOp });
    dispatch({ type: 'SET_PANEL_TAB', payload: 'operations' });
    dispatch({ type: 'SET_STATUS', payload: `Inlay wizard: created "${pocketOp.name}" and "${plugOp.name}"` });
  }

  const enabledOpsCount = operations.filter(o => o.enabled).length;
  const calculatedCount = operations.filter(o => o.enabled && o.toolpath).length;
  const unitsLabel = postConfig.units === 'inch' ? 'INCH' : 'MM';

  return (
    <div style={S.app}>
      {/* Modals */}
      {modal === 'profiles' && <MachineProfilesModal onClose={() => setModal(null)} />}
      {modal === 'about' && <AboutModal onClose={() => setModal(null)} />}
      {modal === 'tool-library' && <ToolLibraryModal onClose={() => setModal(null)} />}
      {showArrayModal && selectedEntityIds.length > 0 && (
        <ArrayModal
          selectedEntityIds={selectedEntityIds}
          entities={entities}
          isInch={isInch}
          dispatch={dispatch}
          onClose={() => setShowArrayModal(false)}
        />
      )}
      {offsetModal && (
        <div style={MS.overlay} onClick={() => { dispatch({ type:'SET_PREVIEW_ENTITIES', payload:[] }); setOffsetModal(null); }}>
          <div style={{ ...MS.box, minWidth:320 }} onClick={e => e.stopPropagation()}>
            <div style={MS.title}>Offset Entities</div>
            <div style={MS.grid}>
              <Field label={`Distance (${isInch?'in':'mm'})`}>
                <input style={MS.input} type="number" step={isInch?0.001:0.1} min={0} value={offsetModal.distance}
                  onChange={e => setOffsetModal(m => ({ ...m, distance: e.target.value }))} />
              </Field>
              <Field label="Direction">
                <select style={MS.select} value={offsetModal.direction} onChange={e => setOffsetModal(m => ({ ...m, direction: e.target.value }))}>
                  <option value="expand">Expand (+)</option>
                  <option value="shrink">Shrink (−)</option>
                  <option value="both">Both sides</option>
                </select>
              </Field>
            </div>
            <div style={{ fontSize:10, color:'#555577', marginBottom:10 }}>
              {selectedEntityIds.length} entit{selectedEntityIds.length>1?'ies':'y'} selected.
              Lines offset perpendicular; circles/arcs offset radially.
            </div>
            <div style={MS.btnRow}>
              <button style={{ ...MS.btn, ...MS.btnSecondary }} onClick={() => { dispatch({ type:'SET_PREVIEW_ENTITIES', payload:[] }); setOffsetModal(null); }}>Cancel</button>
              <button style={{ ...MS.btn, ...MS.btnPrimary }} onClick={() => runOffset(isInch ? parseFloat(offsetModal.distance)*MM_PER_INCH : parseFloat(offsetModal.distance), offsetModal.direction)}>Apply</button>
            </div>
          </div>
        </div>
      )}
      {modal === 'inlay-wizard' && (
        <InlayWizard
          onClose={() => setModal(null)}
          onGenerate={handleInlayGenerate}
          selectedEntityIds={selectedEntityIds}
          entities={entities}
          tools={state.tools || []}
          isInch={postConfig.units === 'inch'}
        />
      )}

      {/* Top Toolbar */}
      <div style={S.topbar}>
        <img src={`${process.env.PUBLIC_URL}/dmdcam-logo.png`} alt="DMDCAM" style={{ height:22, objectFit:'contain', marginRight:4, flexShrink:0 }} />
        {/* CAD / CAM mode toggle */}
        <button
          title="Toggle CAD / CAM mode"
          style={{ ...S.tbBtn, ...(cadMode ? { background:'#1a2a3a', border:'1px solid #4488cc', color:'#88ccff', fontWeight:700 } : { border:'1px solid #2a4a2a', color:'#88aa88' }) }}
          onClick={() => dispatch({ type: 'TOGGLE_CAD_MODE' })}
        >{cadMode ? '✏ CAD' : '⚙ CAM'}</button>
        <div style={{ width:1, background:'#2a2a50', margin:'0 4px' }} />
        <div style={{ display:'flex', gap:4, flex:1, overflow:'hidden' }}>
          {/* CAD-mode-only tools */}
          {cadMode && <>
            <div style={{ width:1, background:'#2a2a50', margin:'0 2px' }} />
            <button title="Offset selected entities (O)" style={{ ...S.tbBtn, ...(selectedEntityIds.length === 0 ? { opacity:0.4 } : {}) }}
              onClick={() => selectedEntityIds.length > 0 && setOffsetModal({ distance: isInch ? '0.1' : '2', direction: 'expand' })}>± Offset</button>
            <button title="Array (rectangular or circular)" style={{ ...S.tbBtn, ...(selectedEntityIds.length === 0 ? { opacity:0.4 } : {}) }}
              onClick={() => selectedEntityIds.length > 0 && setShowArrayModal(true)}>⊞ Array</button>
            <div style={{ width:1, background:'#2a2a50', margin:'0 2px' }} />
            <button title="Import reference image (JPG/PNG)" style={S.tbBtn} onClick={importRefImage}>🖼 Ref Img</button>
            {refImage && <>
              <button title="Auto-trace reference image to polylines" style={{ ...S.tbBtn, borderColor:'#3a5a3a', color:'#88cc88' }} onClick={runAutoTrace}>⟳ Trace</button>
              <button title="Clear reference image" style={{ ...S.tbBtn, borderColor:'#5a3a3a', color:'#cc8888' }} onClick={() => { dispatch({ type:'SET_REF_IMAGE', payload:null }); refImageElRef.current = null; }}>✕ Img</button>
              <span style={{ fontSize:10, color:'#556688', display:'flex', alignItems:'center', gap:4 }}>
                <span>Opacity</span>
                <input type="range" min={5} max={80} value={Math.round((refImage.opacity??0.35)*100)} style={{ width:60, accentColor:'#5566aa' }}
                  onChange={e => dispatch({ type:'UPDATE_REF_IMAGE', payload:{ opacity: +e.target.value/100 } })} />
                <span>Scale</span>
                <input type="range" min={1} max={200} value={Math.round((refImage.mmPerPixel||0.1)*100)} style={{ width:60, accentColor:'#5566aa' }}
                  onChange={e => dispatch({ type:'UPDATE_REF_IMAGE', payload:{ mmPerPixel: +e.target.value/100 } })} />
              </span>
            </>}
          </>}

          {/* CAM-mode-only tools */}
          {!cadMode && <>
            <div style={{ width:1, background:'#2a2a50', margin:'0 4px' }} />
            <button style={S.tbBtn} onClick={importDxf}>📐 Import DXF</button>
            <button style={S.tbBtn} onClick={exportDxfFile} title="Export all entities as DXF (Ctrl+Shift+D)">⬡ Export DXF</button>
            <button style={S.tbBtn} onClick={exportGcode}>💾 G-code</button>
            <button style={{ ...S.tbBtn, borderColor:'#3a4a2a', color:'#99cc88' }} onClick={() => setModal('inlay-wizard')}>⬡ Inlay</button>
            <div style={{ width:1, background:'#2a2a50', margin:'0 4px' }} />
            <button style={{ ...S.tbBtn, ...(state.showToolpaths ? S.tbBtnActive : {}) }} onClick={() => dispatch({ type: 'TOGGLE_TOOLPATHS' })}>⬡ Paths</button>
            <button style={{ ...S.tbBtn, ...(state.showRapids ? S.tbBtnActive : {}) }} onClick={() => dispatch({ type: 'TOGGLE_RAPIDS' })}>↗ Rapids</button>
            <div style={{ width:1, background:'#2a2a50', margin:'0 4px' }} />
            <button style={S.tbBtn} onClick={() => setModal('profiles')} title="Machine profiles &amp; post processor settings">
              Post <span style={S.unitBadge}>{unitsLabel}</span>
            </button>
            <button style={S.tbBtn} onClick={() => setModal('profiles')}>Machine</button>
          </>}

          <div style={{ flex:1 }} />
          <span style={{ fontSize:10, color:'#444466', flexShrink:0 }}>
            {!cadMode && enabledOpsCount > 0 ? `${calculatedCount}/${enabledOpsCount} ops` : ''}
          </span>
        </div>
      </div>

      <div style={S.main}>
        <div style={S.leftPanel}>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <LayersPanel />
          </div>
          <CADToolsPanel />
        </div>
        <div style={S.canvas}><CAMCanvas /></div>
        <div style={S.rightPanel}>
          <div style={S.tabBar}>
            {cadMode && <div style={S.tab(activePanelTab === 'props')} onClick={() => dispatch({ type: 'SET_PANEL_TAB', payload: 'props' })}>Props</div>}
            {[['operations','Ops'],['tools','Tools'],['stock','Stock'],['gcode','G-code']].map(([tab, label]) => (
              <div key={tab} style={S.tab(activePanelTab === tab)} onClick={() => dispatch({ type: 'SET_PANEL_TAB', payload: tab })}>{label}</div>
            ))}
          </div>
          {selectedEntityIds.length > 0 && activePanelTab === 'operations' && (
            <div style={S.selInfo}>{selectedEntityIds.length} entities selected (Ctrl+click to add)</div>
          )}
          <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
            {activePanelTab === 'props'      && <CADPropertiesPanel />}
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
