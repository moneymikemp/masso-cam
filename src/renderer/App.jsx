import React, { useEffect, useCallback, useState, useRef } from 'react';
import { v4 as uuid } from 'uuid';
import { useApp } from './store/AppContext';
import CAMCanvas from './components/canvas/CAMCanvas';
import ThreeCanvas from './components/canvas/ThreeCanvas';
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
import _pkg from '../../package.json';
const appVersion = _pkg.version;

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
  const { activePanelTab, statusMessage, selectedEntityIds, entities, operations, postConfig, activeTool, cadMode, refImage, workspaces, activeWorkspaceId } = state;
  const isInch = postConfig.units === 'inch';
  const MM_PER_INCH = 25.4;
  const [modal, setModal] = useState(null); // 'profiles' | 'tool-library' | 'about' | 'inlay-wizard'
  const [view3d, setView3d] = useState(false);
  const [showArrayModal, setShowArrayModal] = useState(false);
  const [offsetModal, setOffsetModal] = useState(null); // null | { distance: '', direction: 'both' }
  const [wcsPopover, setWcsPopover] = useState(null); // workspace id whose settings are open
  const refImageElRef = useRef(null); // cached HTMLImageElement for tracing
  const [traceThreshold, setTraceThreshold] = useState(50);  // 10-90 → 0.10-0.90
  const [traceSmooth, setTraceSmooth] = useState(20);        // 1-80 → RDP tolerance
  const [traceArcFit, setTraceArcFit] = useState(50);        // 0 = lines only; 1-100 → arc tolerance
  const [tracePreview, setTracePreview] = useState(null);    // live preview: Array<Array<{type,...}>>

  useEffect(() => {
    if (window.electron) {
      window.electron.getTools().then(tools => dispatch({ type: 'SET_TOOLS', payload: tools }));
    }
  }, []);

  // Live trace preview — re-runs whenever threshold, smooth, arcFit, or the reference image changes.
  // tracePreview shape: Array<Array<{type:'line',start,end} | {type:'arc',center,radius,startAngle,endAngle}>>
  useEffect(() => {
    if (!refImage || !refImageElRef.current) { setTracePreview(null); return; }
    const timer = setTimeout(() => {
      try {
        const threshold = traceThreshold / 100;
        const simplify  = 0.05 + (traceSmooth / 80) * 2.95;
        const chains = traceImage(refImageElRef.current, refImage, threshold, simplify);
        if (!chains.length) { setTracePreview(null); return; }
        if (traceArcFit > 0) {
          // arcTolerance: 0.15mm at slider=1 (tight — only clear circles), 1.5mm at slider=100 (loose).
          // 0.15mm floor matches typical smoothing-induced vertex noise; 90° span cap prevents sweeping arcs.
          const arcTol = 0.15 + (traceArcFit / 100) * 1.35;
          setTracePreview(chains.map(verts => fitArcsToChain(verts, arcTol, 10, { maxWindow: 10, maxSpanDeg: 90 })));
        } else {
          // Pure lines: convert each consecutive pair of chain points to a line segment
          setTracePreview(chains.map(chain =>
            chain.slice(0, -1).map((pt, i) => ({ type: 'line', start: pt, end: chain[i + 1] }))
          ));
        }
      } catch { setTracePreview(null); }
    }, 60);
    return () => clearTimeout(timer);
  }, [refImage, traceThreshold, traceSmooth, traceArcFit]);

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

  function applyWCSOffset(ops, ws) {
    const ox = ws.wcsX || 0, oy = ws.wcsY || 0, oz = ws.wcsZ || 0;
    if (!ox && !oy && !oz) return ops;
    return ops.map(op => {
      if (!op.toolpath?.moves?.length) return op;
      return {
        ...op,
        toolpath: {
          ...op.toolpath,
          moves: op.toolpath.moves.map(m => ({
            ...m,
            ...(m.x !== undefined && { x: +(m.x - ox).toFixed(4) }),
            ...(m.y !== undefined && { y: +(m.y - oy).toFixed(4) }),
            ...(m.z !== undefined && { z: +(m.z - oz).toFixed(4) }),
          })),
        },
      };
    });
  }

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

    const toolsList = state.tools || [];
    const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/, '');

    // Group enabled ops by workspace, preserving workspace order.
    const wsGroups = (workspaces || []).map(ws => ({
      ws,
      name: ws.name,
      slug: slugify(ws.name),
      ops: enabled.filter(op => (op.workspaceId ?? 'default') === ws.id),
    })).filter(g => g.ops.length > 0);

    // Fall back to ungrouped if no workspace info (old projects).
    const isMultiWorkspace = wsGroups.length > 1;

    const wcsHeader = (ws) => {
      const ox = ws.wcsX || 0, oy = ws.wcsY || 0, oz = ws.wcsZ || 0;
      if (!ox && !oy && !oz) return '';
      return `; WCS Offset: X${ox.toFixed(4)} Y${oy.toFixed(4)} Z${oz.toFixed(4)}\n; Zero your machine at that canvas position before running this file.\n`;
    };

    // Build the complete list of {seg, suffix, gcode} to save.
    let fileList;
    if (isMultiWorkspace) {
      fileList = [];
      for (const { ws, slug, ops } of wsGroups) {
        const adjusted = applyWCSOffset(ops, ws);
        const groups = generateGcodeByTool(adjusted, toolsList, gcfg);
        const hdr = wcsHeader(ws);
        for (const g of groups) fileList.push({ seg: slug, suffix: g.suffix, gcode: hdr + g.gcode });
      }
    } else {
      const { ws, ops } = wsGroups[0] ?? { ws: { wcsX: 0, wcsY: 0, wcsZ: 0 }, ops: enabled };
      const adjusted = applyWCSOffset(ops, ws);
      const groups = generateGcodeByTool(adjusted, toolsList, gcfg);
      const hdr = wcsHeader(ws);
      fileList = groups.map(g => ({ seg: '', suffix: g.suffix, gcode: hdr + g.gcode }));
    }

    const isMulti = fileList.length > 1 || isMultiWorkspace;
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
      const chosenPath = await window.electron.saveGcodeInlay(isMultiWorkspace ? 'inlay.nc' : 'toolpath.nc');
      if (!chosenPath) return;
      base = chosenPath.replace(/\.[^.\\/]+$/, '');
    } else {
      base = isMultiWorkspace ? 'inlay' : 'toolpath';
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

  const runAutoTrace = useCallback(() => {
    if (!tracePreview?.length) {
      dispatch({ type: 'SET_STATUS', payload: 'No trace preview — load an image and adjust sliders first' });
      return;
    }
    // Commit exactly what the preview shows: line/arc segments from each chain.
    let lineCount = 0, arcCount = 0;
    const newEntities = [];
    for (const chain of tracePreview) {
      for (const seg of chain) {
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
    dispatch({ type: 'SET_STATUS', payload: `Traced ${tracePreview.length} outline${tracePreview.length !== 1 ? 's' : ''}: ${lineCount} lines, ${arcCount} arcs` });
  }, [tracePreview, dispatch]);

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

  function handleInlayGenerate(pocketOp, plugOps) {
    const pocketWsId = uuid();
    dispatch({ type: 'ADD_WORKSPACE', payload: { id: pocketWsId, name: pocketOp.name, color: '#1a5a2a' } });
    dispatch({ type: 'ADD_OPERATION', payload: { ...pocketOp, workspaceId: pocketWsId } });
    for (const plugOp of plugOps) {
      const plugWsId = uuid();
      dispatch({ type: 'ADD_WORKSPACE', payload: { id: plugWsId, name: plugOp.name, color: '#1a2a5a' } });
      dispatch({ type: 'ADD_OPERATION', payload: { ...plugOp, workspaceId: plugWsId } });
    }
    dispatch({ type: 'SET_ACTIVE_WORKSPACE', payload: pocketWsId });
    dispatch({ type: 'SET_PANEL_TAB', payload: 'operations' });
    dispatch({ type: 'SET_STATUS', payload: `Inlay: Pocket + ${plugOps.length} plug workspace${plugOps.length > 1 ? 's' : ''} created` });
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
          onSelectEntities={ids => dispatch({ type: 'SELECT_ENTITIES', payload: ids })}
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
              <button
                title="Apply trace to drawing — adds the cyan preview outlines as entities"
                style={{ ...S.tbBtn, borderColor:'#3a5a3a', color:'#88cc88' }}
                onClick={runAutoTrace}
              >⟳ Apply Trace</button>
              <button title="Clear reference image" style={{ ...S.tbBtn, borderColor:'#5a3a3a', color:'#cc8888' }} onClick={() => { dispatch({ type:'SET_REF_IMAGE', payload:null }); refImageElRef.current = null; setTracePreview(null); }}>✕ Img</button>
              <span style={{ fontSize:10, color:'#556688', display:'flex', alignItems:'center', gap:4 }}>
                <span>Opacity</span>
                <input type="range" min={5} max={80} value={Math.round((refImage.opacity??0.35)*100)} style={{ width:80, accentColor:'#5566aa' }}
                  onChange={e => dispatch({ type:'UPDATE_REF_IMAGE', payload:{ opacity: +e.target.value/100 } })} />
                <span>Scale</span>
                <input type="range" min={1} max={200} value={Math.round((refImage.mmPerPixel||0.1)*100)} style={{ width:80, accentColor:'#5566aa' }}
                  onChange={e => dispatch({ type:'UPDATE_REF_IMAGE', payload:{ mmPerPixel: +e.target.value/100 } })} />
                <span style={{ color:'#00ccff' }}>Threshold</span>
                <input type="range" min={10} max={90} value={traceThreshold} style={{ width:90, accentColor:'#00aacc' }}
                  onChange={e => setTraceThreshold(+e.target.value)}
                  title={`Pixel threshold: ${traceThreshold}% — lower = tighter (dark pixels only), higher = looser (includes lighter pixels)`} />
                <span style={{ color:'#00ccff', minWidth:24 }}>{traceThreshold}%</span>
                <span style={{ color:'#00ccff' }}>Smooth</span>
                <input type="range" min={1} max={80} value={traceSmooth} style={{ width:80, accentColor:'#00aacc' }}
                  onChange={e => setTraceSmooth(+e.target.value)}
                  title="Smooth — left = tight pixel-hugging outline (may staircase), right = smoother curves with more simplification" />
                <span style={{ color:'#00ccff' }}>Arc Fit</span>
                <input type="range" min={0} max={100} value={traceArcFit} style={{ width:90, accentColor:'#00aacc' }}
                  onChange={e => setTraceArcFit(+e.target.value)}
                  title={traceArcFit === 0 ? 'Arc Fit: off — straight lines only' : `Arc Fit: ${traceArcFit}% — arc tolerance ${(0.15 + traceArcFit/100*1.35).toFixed(2)} mm`} />
                <span style={{ color:'#00ccff', minWidth:20 }}>{traceArcFit === 0 ? 'off' : traceArcFit}</span>
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
          <div style={{ width:1, background:'#2a2a50', margin:'0 4px' }} />
          <button
            title="Toggle 3D toolpath view"
            style={{ ...S.tbBtn, ...(view3d ? S.tbBtnActive : {}) }}
            onClick={() => setView3d(v => !v)}
          >◈ 3D</button>
        </div>
      </div>

      {/* Workspace Tabs */}
      <div style={{ position:'relative', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'flex-end', background:'#0a0a18', borderBottom:'1px solid #2a2a50', paddingLeft:8, minHeight:28 }}>
          {(workspaces || []).map(ws => {
            const isActive = ws.id === activeWorkspaceId;
            const wsOpCount = operations.filter(op => (op.workspaceId ?? 'default') === ws.id).length;
            const hasWCS = (ws.wcsX || 0) !== 0 || (ws.wcsY || 0) !== 0 || (ws.wcsZ || 0) !== 0;
            return (
              <div key={ws.id}
                title={`${ws.name} · ${wsOpCount} operation${wsOpCount !== 1 ? 's' : ''}${hasWCS ? ` · WCS offset active` : ''}`}
                onClick={() => dispatch({ type:'SET_ACTIVE_WORKSPACE', payload:ws.id })}
                style={{
                  display:'flex', alignItems:'center', gap:5,
                  padding:'4px 10px 3px', cursor:'pointer', userSelect:'none',
                  fontSize:11, fontWeight: isActive ? 600 : 400,
                  color: isActive ? '#ccccff' : '#555577',
                  background: isActive ? '#1a1a38' : '#0d0d20',
                  borderLeft:  `1px solid ${isActive ? '#2a2a50' : '#1a1a30'}`,
                  borderRight: `1px solid ${isActive ? '#2a2a50' : '#1a1a30'}`,
                  borderTop:   `2px solid ${isActive ? (ws.color || '#5555cc') : 'transparent'}`,
                  borderBottom: isActive ? '1px solid #1a1a38' : '1px solid transparent',
                  marginBottom: isActive ? -1 : 0,
                }}>
                <span style={{ width:6, height:6, borderRadius:'50%', background: ws.color || '#5555cc', flexShrink:0 }} />
                {ws.name}
                {wsOpCount > 0 && <span style={{ fontSize:9, color: isActive ? '#5555aa' : '#333355' }}>({wsOpCount})</span>}
                {hasWCS && <span title="WCS offset active" style={{ fontSize:9, color:'#6688ff' }}>⊕</span>}
                <span
                  title="Workspace settings (WCS offset, name)"
                  style={{ color: wcsPopover === ws.id ? '#8888ff' : '#333355', fontSize:10, lineHeight:1, paddingLeft:1, cursor:'pointer' }}
                  onClick={e => { e.stopPropagation(); setWcsPopover(v => v === ws.id ? null : ws.id); }}>⚙</span>
                {(workspaces || []).length > 1 && (
                  <span style={{ color:'#333355', fontSize:13, lineHeight:1, marginLeft:1, paddingLeft:2 }}
                    onClick={e => { e.stopPropagation(); dispatch({ type:'DELETE_WORKSPACE', payload:ws.id }); }}>×</span>
                )}
              </div>
            );
          })}
          <button
            title="Add workspace"
            style={{ marginLeft:4, padding:'3px 7px', fontSize:12, background:'none', border:'none', color:'#333355', cursor:'pointer', lineHeight:1 }}
            onClick={() => dispatch({ type:'ADD_WORKSPACE', payload:{ name:`Workspace ${(workspaces||[]).length + 1}`, color:'#5555cc' } })}>
            +
          </button>
        </div>

        {/* WCS settings popover */}
        {wcsPopover && (() => {
          const ws = (workspaces || []).find(w => w.id === wcsPopover);
          if (!ws) return null;
          const d = v => isInch ? +(v / 25.4).toFixed(5) : +v.toFixed(4);
          const m = v => isInch ? v * 25.4 : v;
          const unit = isInch ? 'in' : 'mm';
          const inpS = { width:80, background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:3, padding:'3px 6px', fontSize:11 };
          const rowS = { display:'flex', alignItems:'center', gap:8, marginBottom:5 };
          const lblS = { fontSize:10, color:'#8888aa', width:50, flexShrink:0 };

          function autoCenterWCS() {
            const wsOps = operations.filter(op => (op.workspaceId ?? 'default') === ws.id);
            const ids = [...new Set(wsOps.flatMap(op => op.selectedIds || []))];
            const ents = entities.filter(e => ids.includes(e.id));
            if (!ents.length) return;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const e of ents) {
              if (e.type === 'line') {
                for (const p of [e.start, e.end]) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
              } else if (e.type === 'circle') {
                minX = Math.min(minX, e.center.x - e.radius); maxX = Math.max(maxX, e.center.x + e.radius);
                minY = Math.min(minY, e.center.y - e.radius); maxY = Math.max(maxY, e.center.y + e.radius);
              } else if (e.type === 'arc') {
                minX = Math.min(minX, e.center.x - e.radius); maxX = Math.max(maxX, e.center.x + e.radius);
                minY = Math.min(minY, e.center.y - e.radius); maxY = Math.max(maxY, e.center.y + e.radius);
              } else if (e.type === 'polyline' && e.vertices?.length) {
                for (const v of e.vertices) { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); }
              }
            }
            if (!isFinite(minX)) return;
            dispatch({ type:'UPDATE_WORKSPACE', payload:{ id:ws.id, wcsX: +((minX + maxX) / 2).toFixed(4), wcsY: +((minY + maxY) / 2).toFixed(4) } });
          }

          return (
            <div style={{ position:'absolute', top:'100%', left:0, zIndex:500, background:'#1a1a38', border:'1px solid #3a3a70', borderRadius:6, padding:'12px 14px', minWidth:300, boxShadow:'0 4px 20px rgba(0,0,0,0.6)' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                <span style={{ fontSize:11, fontWeight:700, color:'#8888cc' }}>Workspace Settings</span>
                <button style={{ background:'none', border:'none', color:'#555577', cursor:'pointer', fontSize:13 }} onClick={() => setWcsPopover(null)}>✕</button>
              </div>
              <div style={rowS}>
                <span style={lblS}>Name</span>
                <input style={{ ...inpS, flex:1, width:'auto' }} value={ws.name}
                  onChange={e => dispatch({ type:'UPDATE_WORKSPACE', payload:{ id:ws.id, name:e.target.value } })} />
              </div>
              <div style={{ fontSize:10, color:'#5555aa', textTransform:'uppercase', letterSpacing:1, margin:'10px 0 6px', borderBottom:'1px solid #1a1a38', paddingBottom:3 }}>
                WCS Offset — G-code origin
              </div>
              <div style={{ fontSize:10, color:'#555577', marginBottom:8, lineHeight:1.5 }}>
                Subtracts this point from all coordinates on export. Set to where your machine zero will be on this piece.
              </div>
              <div style={rowS}>
                <span style={lblS}>X</span>
                <input type="number" style={inpS} step={isInch ? 0.001 : 0.01} value={d(ws.wcsX || 0)}
                  onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) dispatch({ type:'UPDATE_WORKSPACE', payload:{ id:ws.id, wcsX: m(v) } }); }} />
                <span style={lblS}>Y</span>
                <input type="number" style={inpS} step={isInch ? 0.001 : 0.01} value={d(ws.wcsY || 0)}
                  onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) dispatch({ type:'UPDATE_WORKSPACE', payload:{ id:ws.id, wcsY: m(v) } }); }} />
                <span style={{ fontSize:10, color:'#555577' }}>{unit}</span>
              </div>
              <div style={rowS}>
                <span style={lblS}>Z</span>
                <input type="number" style={inpS} step={isInch ? 0.001 : 0.01} value={d(ws.wcsZ || 0)}
                  onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) dispatch({ type:'UPDATE_WORKSPACE', payload:{ id:ws.id, wcsZ: m(v) } }); }} />
                <span style={{ fontSize:10, color:'#555577' }}>{unit}</span>
              </div>
              <div style={{ display:'flex', gap:6, marginTop:10 }}>
                <button style={{ flex:1, padding:'5px 0', background:'#22224a', border:'1px solid #3a3a60', color:'#9999cc', borderRadius:3, fontSize:11, cursor:'pointer' }}
                  onClick={autoCenterWCS}>Auto-center on geometry</button>
                <button style={{ padding:'5px 10px', background:'#2a1a1a', border:'1px solid #5a2a2a', color:'#cc6666', borderRadius:3, fontSize:11, cursor:'pointer' }}
                  onClick={() => dispatch({ type:'UPDATE_WORKSPACE', payload:{ id:ws.id, wcsX:0, wcsY:0, wcsZ:0 } })}>Clear</button>
              </div>
            </div>
          );
        })()}
      </div>

      <div style={S.main}>
        <div style={S.leftPanel}>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <LayersPanel />
          </div>
          <CADToolsPanel />
        </div>
        <div style={S.canvas}>{view3d ? <ThreeCanvas /> : <CAMCanvas tracePreview={tracePreview} />}</div>
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
