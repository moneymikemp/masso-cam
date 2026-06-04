import React, { useEffect, useCallback } from 'react';
import { useApp } from './store/AppContext';
import CAMCanvas from './components/canvas/CAMCanvas';
import OperationsPanel from './components/panels/OperationsPanel';
import ToolLibraryPanel from './components/panels/ToolLibraryPanel';
import LayersPanel from './components/panels/LayersPanel';
import GcodePanel from './components/panels/GcodePanel';
import { parseDxf, getBounds } from './dxf/parser';
import { generateGcode } from './gcode/postprocessor';

const S = {
  app: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#0d0d1a', color: '#ccc', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' },
  topbar: { height: 36, display: 'flex', alignItems: 'center', background: '#111128', borderBottom: '1px solid #2a2a50', padding: '0 10px', gap: 8, flexShrink: 0 },
  logo: { fontSize: 13, fontWeight: 700, color: '#7777ff', letterSpacing: 1, marginRight: 8, flexShrink: 0 },
  toolbar: { display: 'flex', gap: 4, flex: 1 },
  tbBtn: { background: 'none', border: '1px solid #2a2a50', color: '#aaaacc', borderRadius: 3, padding: '3px 8px', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' },
  tbBtnActive: { background: '#2a2a5a', border: '1px solid #4a4aaa', color: '#ccccff' },
  statusBar: { height: 22, background: '#0a0a18', borderTop: '1px solid #1a1a38', display: 'flex', alignItems: 'center', padding: '0 10px', fontSize: 10, color: '#555577', flexShrink: 0 },
  main: { flex: 1, display: 'flex', overflow: 'hidden' },
  leftPanel: { width: 200, flexShrink: 0, borderRight: '1px solid #2a2a50', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  canvas: { flex: 1, overflow: 'hidden' },
  rightPanel: { width: 280, flexShrink: 0, borderLeft: '1px solid #2a2a50', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  tabBar: { display: 'flex', borderBottom: '1px solid #2a2a50', flexShrink: 0 },
  tab: (active) => ({ flex: 1, padding: '5px 4px', textAlign: 'center', cursor: 'pointer', fontSize: 10, color: active ? '#aaaaff' : '#555577', background: active ? '#1a1a38' : 'transparent', borderBottom: active ? '2px solid #5555cc' : '2px solid transparent', fontWeight: active ? 600 : 400 }),
  selInfo: { padding: '4px 8px', fontSize: 10, color: '#555577', borderBottom: '1px solid #1a1a38' },
};

export default function App() {
  const { state, dispatch, getProject } = useApp();
  const { activePanelTab, statusMessage, selectedEntityIds, entities, operations } = state;

  // Load tools on mount
  useEffect(() => {
    if (window.electron) {
      window.electron.getTools().then(tools => dispatch({ type: 'SET_TOOLS', payload: tools }));
    }
  }, []);

  // Menu event wiring
  useEffect(() => {
    if (!window.electron) return;
    return window.electron.onMenu(async (event, ...args) => {
      switch (event) {
        case 'menu-import-dxf': importDxf(); break;
        case 'menu-export-gcode': exportGcode(); break;
        case 'menu-zoom-fit': dispatch({ type: 'RESET_VIEWPORT' }); break;
        case 'menu-zoom-in': dispatch({ type: 'SET_VIEWPORT', payload: { zoom: state.viewport.zoom * 1.4 } }); break;
        case 'menu-zoom-out': dispatch({ type: 'SET_VIEWPORT', payload: { zoom: state.viewport.zoom / 1.4 } }); break;
        case 'menu-toggle-toolpaths': dispatch({ type: 'TOGGLE_TOOLPATHS' }); break;
        case 'menu-toggle-rapids': dispatch({ type: 'TOGGLE_RAPIDS' }); break;
        case 'menu-tool-library': dispatch({ type: 'SET_PANEL_TAB', payload: 'tools' }); break;
        case 'menu-new-project': newProject(); break;
        case 'menu-open-project': openProject(); break;
        case 'menu-save-project': saveProject(false); break;
        case 'menu-save-project-as': saveProject(true); break;
        case 'menu-delete-selected':
          dispatch({ type: 'SELECT_ENTITIES', payload: [] });
          break;
        case 'menu-select-all':
          dispatch({ type: 'SELECT_ENTITIES', payload: entities.map(e => e.id) });
          break;
      }
    });
  }, [state, entities, operations]);

  const importDxf = useCallback(async () => {
    try {
      let content, path;
      if (window.electron) {
        const result = await window.electron.openDxf();
        if (!result) return;
        content = result.content;
        path = result.path;
      } else {
        // Browser fallback
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.dxf';
        content = await new Promise((res, rej) => {
          input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return rej();
            const reader = new FileReader();
            reader.onload = ev => res(ev.target.result);
            reader.readAsText(file);
          };
          input.click();
        });
      }
      dispatch({ type: 'SET_STATUS', payload: 'Parsing DXF...' });
      const { entities, layers } = parseDxf(content);
      const bounds = getBounds(entities);
      dispatch({ type: 'SET_DXF', payload: { entities, layers, bounds } });
      dispatch({ type: 'SET_STATUS', payload: `Loaded ${entities.length} entities from ${Object.keys(layers).length} layers` });
    } catch (err) {
      console.error(err);
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
    const gcode = generateGcode(enabled, state.postConfig);
    dispatch({ type: 'SET_GCODE', payload: gcode });
    dispatch({ type: 'SET_PANEL_TAB', payload: 'gcode' });

    if (window.electron) {
      const path = await window.electron.saveGcode('toolpath.nc');
      if (path) {
        await window.electron.writeFile(path, gcode);
        dispatch({ type: 'SET_STATUS', payload: `Exported: ${path}` });
      }
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
      if (result) {
        dispatch({ type: 'LOAD_PROJECT', payload: result.data });
        dispatch({ type: 'SET_PROJECT_PATH', payload: result.path });
        dispatch({ type: 'SET_STATUS', payload: `Opened: ${result.path}` });
      }
    }
  }, [state.dirty, dispatch]);

  const saveProject = useCallback(async (saveAs = false) => {
    const data = JSON.stringify(getProject(), null, 2);
    if (window.electron) {
      let path = saveAs ? null : state.projectPath;
      if (!path) {
        path = await window.electron.saveProject(state.projectPath);
      }
      if (path) {
        await window.electron.writeFile(path, data);
        dispatch({ type: 'SET_PROJECT_PATH', payload: path });
        dispatch({ type: 'SET_DIRTY', payload: false });
        dispatch({ type: 'SET_STATUS', payload: `Saved: ${path}` });
      }
    }
  }, [getProject, state.projectPath, dispatch]);

  const enabledOpsCount = operations.filter(o => o.enabled).length;
  const calculatedCount = operations.filter(o => o.enabled && o.toolpath).length;

  return (
    <div style={S.app}>
      {/* Top Toolbar */}
      <div style={S.topbar}>
        <span style={S.logo}>MASSOCAM</span>
        <div style={S.toolbar}>
          <button style={S.tbBtn} onClick={importDxf} title="Ctrl+I">📐 Import DXF</button>
          <button style={S.tbBtn} onClick={exportGcode} title="Ctrl+E">💾 Export G-code</button>
          <div style={{ width: 1, background: '#2a2a50', margin: '0 4px' }} />
          <button
            style={{ ...S.tbBtn, ...(state.showToolpaths ? S.tbBtnActive : {}) }}
            onClick={() => dispatch({ type: 'TOGGLE_TOOLPATHS' })}
          >⬡ Paths</button>
          <button
            style={{ ...S.tbBtn, ...(state.showRapids ? S.tbBtnActive : {}) }}
            onClick={() => dispatch({ type: 'TOGGLE_RAPIDS' })}
          >↗ Rapids</button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: '#444466' }}>
            {enabledOpsCount > 0 ? `${calculatedCount}/${enabledOpsCount} ops calculated` : ''}
          </span>
        </div>
      </div>

      <div style={S.main}>
        {/* Left: Layers */}
        <div style={S.leftPanel}>
          <LayersPanel />
        </div>

        {/* Center: Canvas */}
        <div style={S.canvas}>
          <CAMCanvas />
        </div>

        {/* Right: Operations / Tools / G-code */}
        <div style={S.rightPanel}>
          <div style={S.tabBar}>
            {[['operations','Ops'],['tools','Tools'],['gcode','G-code']].map(([tab, label]) => (
              <div key={tab} style={S.tab(activePanelTab === tab)} onClick={() => dispatch({ type: 'SET_PANEL_TAB', payload: tab })}>
                {label}
              </div>
            ))}
          </div>

          {selectedEntityIds.length > 0 && activePanelTab === 'operations' && (
            <div style={S.selInfo}>{selectedEntityIds.length} entities selected (Ctrl+click to add)</div>
          )}

          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {activePanelTab === 'operations' && <OperationsPanel />}
            {activePanelTab === 'tools'      && <ToolLibraryPanel />}
            {activePanelTab === 'gcode'      && <GcodePanel />}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div style={S.statusBar}>
        <span>{statusMessage || 'Ready'}</span>
        <div style={{ flex: 1 }} />
        <span>
          {entities.length > 0 && `${entities.length} entities · `}
          {operations.length > 0 && `${operations.length} operations · `}
          Zoom: {(state.viewport.zoom * 100).toFixed(0)}%
        </span>
      </div>
    </div>
  );
}
