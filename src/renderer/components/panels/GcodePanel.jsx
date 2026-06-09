import React, { useState } from 'react';
import { useApp } from '../../store/AppContext';
import { generateGcode, generateGcodeByTool, estimateCycleTime, formatTime } from '../../gcode/postprocessor';

const S = {
  panel: { height: '100%', display: 'flex', flexDirection: 'column', background: '#0d0d1a', color: '#ccc' },
  header: { padding: '8px 10px', borderBottom: '1px solid #2a2a50', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  title: { fontSize: 12, fontWeight: 600, color: '#8888bb', textTransform: 'uppercase', letterSpacing: 1, flex: 1 },
  genBtn: { background: '#2a2a5a', border: '1px solid #3a3aaa', color: '#8888ff', cursor: 'pointer', fontSize: 11, padding: '4px 10px', borderRadius: 3 },
  exportBtn: { background: '#1a3a2a', border: '1px solid #2a5a3a', color: '#44cc88', cursor: 'pointer', fontSize: 11, padding: '4px 10px', borderRadius: 3 },
  stats: { padding: '6px 10px', borderBottom: '1px solid #1a1a38', display: 'flex', gap: 16, fontSize: 10, flexShrink: 0 },
  stat: { color: '#555577' },
  statVal: { color: '#8888cc', marginLeft: 4 },
  pre: { flex: 1, overflow: 'auto', padding: '8px 10px', fontFamily: 'monospace', fontSize: 10.5, lineHeight: 1.5, color: '#8888aa', whiteSpace: 'pre', background: '#080810' },
  empty: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333355', fontSize: 12, flexDirection: 'column', gap: 8 },
  postSection: { borderTop: '1px solid #2a2a50', padding: '8px 10px', flexShrink: 0 },
  postTitle: { fontSize: 10, color: '#5555aa', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  postGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 },
  postRow: { display: 'flex', alignItems: 'center', gap: 4 },
  postLabel: { fontSize: 10, color: '#666688', width: 80, flexShrink: 0 },
  postInput: { flex: 1, background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '2px 4px', fontSize: 10 },
};

export default function GcodePanel() {
  const { state, dispatch } = useApp();
  const { operations, tools, postConfig, stockConfig, gcodeOutput } = state;
  const [showPost, setShowPost] = useState(false);

  function generate() {
    const enabled = operations.filter(op => op.enabled && op.toolpath?.moves?.length > 0);
    if (enabled.length === 0) {
      dispatch({ type: 'SET_STATUS', payload: 'No calculated operations to export' });
      return;
    }
    const gcode = generateGcode(enabled, {
      ...postConfig,
      wcs: stockConfig.wcs,
      stockOriginX: stockConfig.stockOriginX ?? 0,
      stockOriginY: stockConfig.stockOriginY ?? 0,
    });
    dispatch({ type: 'SET_GCODE', payload: gcode });
  }

  function downloadBlob(content, filename) {
    const blob = new Blob([content], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function exportGcode() {
    if (!gcodeOutput) { generate(); return; }

    const enabledOps = operations.filter(op => op.enabled && op.toolpath?.moves?.length > 0);
    const gcfg = {
      ...postConfig,
      wcs: stockConfig.wcs,
      stockOriginX: stockConfig.stockOriginX ?? 0,
      stockOriginY: stockConfig.stockOriginY ?? 0,
    };

    const pocketOps = enabledOps.filter(op => op.type === 'taperedpocket');
    const plugOps   = enabledOps.filter(op => op.type === 'taperedplug');
    const isInlay   = pocketOps.length > 0 && plugOps.length > 0;

    // Build the complete list of {seg, suffix, gcode} to save.
    // seg = '' | 'pocket' | 'plug';  suffix = '' | '_T1' | '_T2' ...
    let fileList;
    if (isInlay) {
      const pocketGroups = generateGcodeByTool(pocketOps, tools || [], gcfg);
      const plugGroups   = generateGcodeByTool(plugOps,   tools || [], gcfg);
      fileList = [
        ...pocketGroups.map(g => ({ seg: 'pocket', suffix: g.suffix, gcode: g.gcode })),
        ...plugGroups.map(g =>   ({ seg: 'plug',   suffix: g.suffix, gcode: g.gcode })),
      ];
    } else {
      const groups = generateGcodeByTool(enabledOps, tools || [], gcfg);
      fileList = groups.map(g => ({ seg: '', suffix: g.suffix, gcode: g.gcode }));
    }

    const isMulti = fileList.length > 1 || isInlay;

    if (!isMulti) {
      // Single file — save directly to the user-chosen path.
      if (window.electron) {
        const path = await window.electron.saveGcode('toolpath.nc');
        if (!path) return;
        await window.electron.writeFile(path, fileList[0].gcode);
        dispatch({ type: 'SET_STATUS', payload: `Exported: ${path.split(/[\\/]/).pop()}` });
      } else {
        downloadBlob(fileList[0].gcode, 'toolpath.nc');
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
        downloadBlob(gcode, `${base.split(/[\\/]/).pop()}${segPart}${suffix}.nc`);
      }
      saved.push(filename.split(/[\\/]/).pop());
    }
    dispatch({ type: 'SET_STATUS', payload: `Exported: ${saved.join(', ')}` });
  }

  function updatePost(key, val) {
    dispatch({ type: 'SET_POST_CONFIG', payload: { [key]: val } });
  }

  const lineCount = gcodeOutput ? gcodeOutput.split('\n').length : 0;
  const enabledOps = operations.filter(o => o.enabled && o.toolpath?.moves?.length > 0);
  const cycleTime = enabledOps.length > 0 ? estimateCycleTime(enabledOps) : 0;
  const totalMoves = enabledOps.reduce((s, o) => s + (o.toolpath?.moves?.length || 0), 0);

  return (
    <div style={S.panel}>
      <div style={S.header}>
        <span style={S.title}>G-code</span>
        <button style={S.genBtn} onClick={generate}>⟳ Generate</button>
        <button style={S.exportBtn} onClick={exportGcode} disabled={!gcodeOutput}>
          ↓ Export .nc
        </button>
      </div>

      {enabledOps.length > 0 && (
        <div style={S.stats}>
          <span style={S.stat}>Operations: <span style={S.statVal}>{enabledOps.length}</span></span>
          <span style={S.stat}>Moves: <span style={S.statVal}>{totalMoves.toLocaleString()}</span></span>
          <span style={S.stat}>Est. Time: <span style={S.statVal}>{formatTime(cycleTime)}</span></span>
          {gcodeOutput && <span style={S.stat}>Lines: <span style={S.statVal}>{lineCount.toLocaleString()}</span></span>}
        </div>
      )}

      {!gcodeOutput ? (
        <div style={S.empty}>
          <div style={{ fontSize: 32 }}>📄</div>
          <div>Click Generate to preview G-code</div>
          {enabledOps.length === 0 && <div style={{ fontSize: 11, color: '#222244' }}>Add and calculate operations first</div>}
        </div>
      ) : (
        <pre style={S.pre}>
          {gcodeOutput.split('\n').map((line, i) => {
            let color = '#8888aa';
            if (line.startsWith('(')) color = '#555577';
            else if (line.startsWith('G0')) color = '#cc4444';
            else if (line.startsWith('G1')) color = '#44cc88';
            else if (line.startsWith('G2') || line.startsWith('G3')) color = '#44aacc';
            else if (line.startsWith('M')) color = '#ccaa44';
            else if (line.startsWith('N')) color = '#666688';
            else if (line === '%') color = '#884488';
            return <span key={i} style={{ color, display: 'block' }}>{line}</span>;
          })}
        </pre>
      )}

      <div style={S.postSection}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setShowPost(!showPost)}>
          <span style={S.postTitle}>Post Processor Settings</span>
          <span style={{ fontSize: 10, color: '#555577' }}>{showPost ? '▲' : '▼'}</span>
        </div>
        {showPost && (
          <div style={S.postGrid}>
            {[
              ['Units', 'units', 'select', [['mm','Metric (mm)'],['inch','Imperial (inch)']]],
              ['Coolant', 'coolant', 'select', [['off','Off'],['flood','Flood'],['mist','Mist']]],
              ['Spindle Delay', 'spindleDelay', 'number', null],
              ['Safe Z', 'safeZ', 'number', null],
              ['Tool Change Z', 'toolChangeZ', 'number', null],
              ['Line Numbering', 'lineNumbering', 'checkbox', null],
              ['Home at End', 'homeAtEnd', 'checkbox', null],
            ].map(([label, key, type, opts]) => (
              <div key={key} style={S.postRow}>
                <span style={S.postLabel}>{label}</span>
                {type === 'select' ? (
                  <select style={S.postInput} value={postConfig[key]} onChange={e => updatePost(key, e.target.value)}>
                    {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                ) : type === 'checkbox' ? (
                  <input type="checkbox" checked={postConfig[key]} onChange={e => updatePost(key, e.target.checked)} />
                ) : (
                  <input style={S.postInput} type="number" value={postConfig[key]} onChange={e => updatePost(key, parseFloat(e.target.value) || 0)} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
