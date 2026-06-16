import React, { useState, useEffect } from 'react';
import { useApp } from '../../store/AppContext';

const TOOL_TYPES = ['flat','ball','tapered','upcut','downcut','compression','diamond'];
const MATERIALS = ['MDF','Plywood','Softwood','Hardwood','Aluminum','HDPE','Acrylic','Foam','Brass','Steel'];

const MM_PER_INCH = 25.4;
const toDisp = (mm, units) => units === 'inch' ? mm / MM_PER_INCH : mm;
const toMM = (val, units) => units === 'inch' ? val * MM_PER_INCH : val;
const uLabel = (units) => units === 'inch' ? 'in' : 'mm';
const fmtDia = (t) => {
  const u = t.units || 'mm';
  const lbl = uLabel(u);
  if (t.type === 'tapered') {
    return `⌀${+toDisp(t.tipDiameter ?? 0, u).toFixed(u === 'inch' ? 4 : 2)}${lbl} tip ${t.taperAngle ?? 0}°`;
  }
  return `⌀${+toDisp(t.diameter ?? 0, u).toFixed(u === 'inch' ? 4 : 2)}${lbl}`;
};

const S = {
  panel: { height: '100%', display: 'flex', flexDirection: 'column', background: '#13132a', color: '#ccc', overflow: 'hidden' },
  header: { padding: '8px 10px', borderBottom: '1px solid #2a2a50', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 },
  title: { fontSize: 12, fontWeight: 600, color: '#8888bb', textTransform: 'uppercase', letterSpacing: 1 },
  list: { flex: 1, overflow: 'auto' },
  row: (sel) => ({ padding: '6px 10px', cursor: 'pointer', background: sel ? '#22224a' : 'transparent', borderLeft: `3px solid ${sel ? '#5555cc' : 'transparent'}`, display: 'flex', alignItems: 'center', gap: 6 }),
  name: { flex: 1, fontSize: 11, color: '#ccccdd' },
  dia: { fontSize: 10, color: '#666688', flexShrink: 0 },
  iconBtn: { background: 'none', border: 'none', color: '#666688', cursor: 'pointer', fontSize: 12, padding: '1px 4px' },
  addBtn: { fontSize: 18, background: 'none', border: '1px solid #3a3a70', color: '#6666cc', borderRadius: 4, width: 24, height: 24, cursor: 'pointer' },
  form: { borderTop: '1px solid #2a2a50', padding: '8px 10px', overflow: 'auto', fontSize: 11 },
  row2: { display: 'flex', alignItems: 'center', marginBottom: 5, gap: 4 },
  label: { color: '#8888aa', width: 110, flexShrink: 0, fontSize: 10 },
  input: { flex: 1, background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '2px 5px', fontSize: 11, minWidth: 0 },
  select: { flex: 1, background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '2px 4px', fontSize: 11 },
  unitSel: { background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '2px 4px', fontSize: 10, width: 46, flexShrink: 0 },
  unitTag: { color: '#666688', fontSize: 10, flexShrink: 0 },
  section: { color: '#5555aa', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, marginTop: 8, marginBottom: 3, borderBottom: '1px solid #1a1a38', paddingBottom: 2 },
  saveBtn: { background: '#2a2a5a', border: '1px solid #3a3aaa', color: '#8888ff', cursor: 'pointer', fontSize: 10, padding: '4px 12px', borderRadius: 3, marginTop: 8, width: '100%' },
  dupWarn: { fontSize: 10, color: '#ffaa44', background: '#2a1a00', border: '1px solid #554400', borderRadius: 3, padding: '4px 6px', marginTop: 4 },
  feedRow: { background: '#0d0d20', borderRadius: 3, padding: '4px 6px', marginBottom: 4 },
  feedLabel: { color: '#7777aa', fontSize: 9, marginBottom: 2 },
  feedGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 3 },
  feedInput: { background: '#151528', border: '1px solid #222244', color: '#aaaacc', borderRadius: 2, padding: '2px 4px', fontSize: 10, width: '100%' },
  delFeed: { background: 'none', border: 'none', color: '#884444', cursor: 'pointer', fontSize: 10, padding: 0 },
};

const newTool = () => ({ name: '', type: 'flat', diameter: 6.35, flutes: 2, material: 'Carbide', notes: '', tool_number: 1, units: 'mm', feeds: [] });
const newFeed = () => ({ material: 'MDF', spindle_rpm: 18000, feed_rate: 1500, plunge_rate: 500, depth_per_pass: 3, stepover: 0.45 });

export default function ToolLibraryPanel() {
  const { state, dispatch } = useApp();
  const { tools } = state;
  const [selected, setSelected] = useState(null);
  const [editTool, setEditTool] = useState(null);

  const u = editTool?.units || 'mm';
  const ul = uLabel(u);

  const feedFields = [
    { lbl: 'RPM',                    key: 'spindle_rpm',  step: 100,                    linear: false, isStepover: false },
    { lbl: `Feed (${ul}/min)`,       key: 'feed_rate',    step: u === 'inch' ? 0.1 : 50,  linear: true,  isStepover: false },
    { lbl: `Plunge (${ul}/min)`,     key: 'plunge_rate',  step: u === 'inch' ? 0.1 : 25,  linear: true,  isStepover: false },
    { lbl: `Depth/pass (${ul})`,     key: 'depth_per_pass', step: u === 'inch' ? 0.001 : 0.1, linear: true, isStepover: false },
    { lbl: 'Stepover %',             key: 'stepover_pct', step: 5,                       linear: false, isStepover: true  },
  ];

  useEffect(() => { loadTools(); }, []);

  async function loadTools() {
    if (window.electron) {
      const t = await window.electron.getTools();
      dispatch({ type: 'SET_TOOLS', payload: t });
    }
  }

  function selectTool(tool) {
    setSelected(tool.id);
    setEditTool(JSON.parse(JSON.stringify(tool)));
  }

  function newToolForm() {
    const t = newTool();
    setSelected('__new__');
    setEditTool(t);
  }

  async function saveTool() {
    if (!editTool) return;
    if (window.electron) {
      const saved = await window.electron.saveTool(editTool);
      if (saved) {
        await loadTools();
        setSelected(saved.id);
        setEditTool(saved);
      }
    }
  }

  async function deleteTool(id, e) {
    e.stopPropagation();
    if (!window.confirm('Delete this tool?')) return;
    if (window.electron) {
      await window.electron.deleteTool(id);
      await loadTools();
      setSelected(null); setEditTool(null);
    }
  }

  function setField(key, val) { setEditTool(t => ({ ...t, [key]: val })); }

  function setFeedField(i, key, val) {
    setEditTool(t => {
      const feeds = [...t.feeds];
      feeds[i] = { ...feeds[i], [key]: val };
      return { ...t, feeds };
    });
  }

  function addFeed() { setEditTool(t => ({ ...t, feeds: [...t.feeds, newFeed()] })); }
  function removeFeed(i) { setEditTool(t => ({ ...t, feeds: t.feeds.filter((_, j) => j !== i) })); }

  const typeIcon = { flat:'⬛',ball:'⬤',tapered:'▼',upcut:'↑',downcut:'↓',compression:'⇅',diamond:'◆' };

  return (
    <div style={S.panel}>
      <div style={S.header}>
        <span style={S.title}>Tool Library</span>
        <button style={S.addBtn} onClick={newToolForm} title="Add tool">+</button>
      </div>
      <div style={S.list}>
        {tools.map(t => (
          <div key={t.id} style={S.row(t.id === selected)} onClick={() => selectTool(t)}>
            <span style={{ fontSize: 12 }}>{typeIcon[t.type] || '⚙'}</span>
            <span style={S.name}>{t.name}</span>
            <span style={S.dia}>{fmtDia(t)}</span>
            {t.id === selected && (
              <button style={{ ...S.iconBtn, color: '#884444' }} onClick={(e) => deleteTool(t.id, e)}>✕</button>
            )}
          </div>
        ))}
        {tools.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: '#444466', fontSize: 12 }}>No tools yet</div>}
      </div>

      {editTool && (
        <div style={S.form}>
          <div style={S.section}>Tool Properties</div>
          <div style={S.row2}><span style={S.label}>Name</span><input style={S.input} value={editTool.name} onChange={e => setField('name', e.target.value)} /></div>
          <div style={S.row2}>
            <span style={S.label}>Type</span>
            <select style={S.select} value={editTool.type} onChange={e => setField('type', e.target.value)}>
              {TOOL_TYPES.map(t => <option key={t} value={t}>{typeIcon[t]} {t}</option>)}
            </select>
          </div>
          <div style={S.row2}>
            <span style={S.label}>Tool Number</span>
            <input style={{ ...S.input, width: 60, flex: 'none' }} type="number" step="1" min="1" max="99"
              value={editTool.tool_number ?? 1}
              onChange={e => setField('tool_number', Math.max(1, Math.min(99, parseInt(e.target.value) || 1)))} />
          </div>
          {(() => {
            const num = editTool.tool_number ?? 1;
            const dup = tools.find(t => t.id !== editTool.id && (t.tool_number ?? 1) === num);
            return dup ? <div style={S.dupWarn}>⚠ Tool number {num} is already used by "{dup.name}"</div> : null;
          })()}
          <div style={S.row2}>
            <span style={S.label}>Diameter</span>
            <select style={S.unitSel} value={editTool.units || 'mm'} onChange={e => setField('units', e.target.value)}>
              <option value="mm">mm</option>
              <option value="inch">in</option>
            </select>
            <input style={S.input} type="number" step={u === 'inch' ? 0.0001 : 0.01} min="0.001"
              value={+toDisp(editTool.diameter, u).toFixed(u === 'inch' ? 4 : 2)}
              onChange={e => setField('diameter', toMM(parseFloat(e.target.value) || 0, u))} />
            <span style={S.unitTag}>{ul}</span>
          </div>
          {editTool.type === 'tapered' && <>
            <div style={S.row2}>
              <span style={S.label}>Tip Dia</span>
              <input style={S.input} type="number" step={u === 'inch' ? 0.0001 : 0.01} min="0"
                value={+toDisp(editTool.tipDiameter ?? 0.5, u).toFixed(u === 'inch' ? 4 : 2)}
                onChange={e => setField('tipDiameter', toMM(parseFloat(e.target.value) || 0, u))} />
              <span style={S.unitTag}>{ul}</span>
            </div>
            <div style={S.row2}>
              <span style={S.label}>Taper Angle (°)</span>
              <input style={S.input} type="number" step="0.5" min="1" max="60"
                value={editTool.taperAngle ?? 10}
                onChange={e => setField('taperAngle', parseFloat(e.target.value) || 10)} />
            </div>
          </>}
          <div style={S.row2}><span style={S.label}>Flutes</span><input style={S.input} type="number" step="1" min="1" max="8" value={editTool.flutes} onChange={e => setField('flutes', parseInt(e.target.value) || 2)} /></div>
          <div style={S.row2}><span style={S.label}>Material</span><input style={S.input} value={editTool.material} onChange={e => setField('material', e.target.value)} /></div>
          <div style={S.row2}><span style={S.label}>Notes</span><input style={S.input} value={editTool.notes} onChange={e => setField('notes', e.target.value)} /></div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, marginBottom: 4 }}>
            <span style={{ ...S.section, margin: 0 }}>Feeds & Speeds</span>
            <button style={{ ...S.iconBtn, color: '#44aa88', fontSize: 14 }} onClick={addFeed}>+ Add Material</button>
          </div>

          {editTool.feeds.map((f, i) => (
            <div key={i} style={S.feedRow}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <select style={{ ...S.select, fontSize: 10 }} value={f.material} onChange={e => setFeedField(i, 'material', e.target.value)}>
                  {MATERIALS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <button style={S.delFeed} onClick={() => removeFeed(i)}>✕</button>
              </div>
              <div style={S.feedGrid}>
                {feedFields.map(({ lbl, key, step, linear, isStepover }) => {
                  const rawKey = isStepover ? 'stepover' : key;
                  const rawVal = f[rawKey] ?? 0;
                  const dispVal = isStepover
                    ? Math.round(rawVal * 100)
                    : (linear ? +toDisp(rawVal, u).toFixed(u === 'inch' ? 4 : 2) : rawVal);
                  return (
                    <div key={key}>
                      <div style={S.feedLabel}>{lbl}</div>
                      <input
                        type="number"
                        style={S.feedInput}
                        step={step}
                        value={dispVal}
                        onChange={e => {
                          const v = parseFloat(e.target.value) || 0;
                          setFeedField(i, rawKey, isStepover ? v / 100 : (linear ? toMM(v, u) : v));
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <button style={S.saveBtn} onClick={saveTool}>💾 Save Tool</button>
        </div>
      )}
    </div>
  );
}
