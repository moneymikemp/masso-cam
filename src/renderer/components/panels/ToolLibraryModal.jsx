import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../../store/AppContext';

const MM_PER_INCH = 25.4;
const TOOL_TYPES   = ['flat','ball','tapered','upcut','downcut','compression','diamond'];
const TOOL_MATS    = ['Carbide','HSS','Cobalt','Ceramic','Diamond PCD'];
const FEED_MATS    = ['MDF','Plywood','Softwood','Hardwood','Aluminum','HDPE','Acrylic','Foam','Brass','Steel','Copper'];
const CATEGORIES   = ['End Mill','V-Bit','Ball Nose','Tapered Bit','Engraving','Other'];
const TYPE_ICON    = { flat:'⬛',ball:'⬤',tapered:'▼',upcut:'↑',downcut:'↓',compression:'⇅',diamond:'◆' };

function getCategory(t) {
  switch (t.type) {
    case 'flat': case 'upcut': case 'downcut': case 'compression': return 'End Mill';
    case 'ball': return 'Ball Nose';
    case 'tapered': return (t.tipDiameter ?? 0) < 0.1 ? 'V-Bit' : 'Tapered Bit';
    case 'diamond': return 'Engraving';
    default: return 'Other';
  }
}

const newTool = () => ({
  name:'', type:'flat', tool_number:1, diameter:6.35,
  tipDiameter:0, taperAngle:0, flutes:2, material:'Carbide', notes:'', feeds:[],
});
const newFeedRow = () => ({
  material:'MDF', spindle_rpm:18000, feed_rate:2500,
  plunge_rate:800, depth_per_pass:3.0, stepover:0.45,
});

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  overlay:  { position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' },
  modal:    { background:'#13132a', border:'1px solid #3a3a70', borderRadius:8, display:'flex', flexDirection:'column', width:'min(95vw,1140px)', height:'min(90vh,760px)', color:'#ccc', fontFamily:'system-ui,sans-serif', overflow:'hidden', boxShadow:'0 8px 40px rgba(0,0,0,0.6)' },
  header:   { display:'flex', alignItems:'center', gap:8, padding:'10px 16px', borderBottom:'1px solid #2a2a50', flexShrink:0, background:'#1a1a38' },
  title:    { fontSize:14, fontWeight:700, color:'#aaaaff', flex:1 },
  iconBtn:  { background:'none', border:'1px solid #2a2a50', color:'#8888aa', borderRadius:3, padding:'3px 10px', cursor:'pointer', fontSize:11 },
  body:     { display:'flex', flex:1, overflow:'hidden' },

  // Left panel
  left:     { width:240, flexShrink:0, display:'flex', flexDirection:'column', borderRight:'1px solid #2a2a50', background:'#0f0f22' },
  searchWrap:{ padding:'8px', borderBottom:'1px solid #1a1a38' },
  search:   { width:'100%', background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:4, padding:'4px 8px', fontSize:11, boxSizing:'border-box' },
  listBody: { flex:1, overflow:'auto' },
  catHdr:   { display:'flex', alignItems:'center', gap:4, padding:'5px 8px 3px', fontSize:9, color:'#5555aa', textTransform:'uppercase', letterSpacing:1, cursor:'pointer', userSelect:'none', borderBottom:'1px solid #1a1a38' },
  toolRow:  (sel) => ({ display:'flex', alignItems:'center', gap:5, padding:'5px 10px', cursor:'pointer', background: sel ? '#22224a' : 'transparent', borderLeft:`3px solid ${sel ? '#5555cc' : 'transparent'}` }),
  toolName: { flex:1, fontSize:11, color:'#ccccdd', overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis' },
  toolDia:  { fontSize:10, color:'#555577', flexShrink:0 },
  addBtn:   { margin:'8px', padding:'5px', background:'#1a1a3a', border:'1px solid #2a2a50', color:'#6666cc', borderRadius:4, cursor:'pointer', fontSize:11, textAlign:'center' },

  // Right panel
  right:    { flex:1, display:'flex', flexDirection:'column', overflow:'hidden' },
  empty:    { flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:'#333355', fontSize:13 },
  formWrap: { flex:1, overflow:'auto', padding:'12px 16px' },
  section:  { fontSize:9, color:'#5555aa', textTransform:'uppercase', letterSpacing:1, marginTop:14, marginBottom:6, borderBottom:'1px solid #1a1a38', paddingBottom:3 },
  grid:     { display:'grid', gridTemplateColumns:'120px 1fr', gap:'6px 10px', alignItems:'center' },
  label:    { fontSize:10, color:'#8888aa', textAlign:'right' },
  input:    { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:3, padding:'3px 7px', fontSize:11, width:'100%', boxSizing:'border-box' },
  select:   { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:3, padding:'3px 5px', fontSize:11, width:'100%' },
  textarea: { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:3, padding:'3px 7px', fontSize:11, width:'100%', resize:'vertical', minHeight:36, boxSizing:'border-box', fontFamily:'inherit' },
  inlineRow:{ display:'flex', alignItems:'center', gap:6 },
  unitTag:  { fontSize:10, color:'#555577', flexShrink:0 },

  // Feeds table
  feedsWrap:{ overflowX:'auto', marginTop:4 },
  feedTable:{ width:'100%', borderCollapse:'collapse', fontSize:10 },
  thCell:   { padding:'4px 6px', color:'#555577', textAlign:'left', borderBottom:'1px solid #1a1a38', whiteSpace:'nowrap' },
  tdCell:   { padding:'2px 4px', verticalAlign:'middle' },
  feedInput:{ background:'#0d0d1e', border:'1px solid #1a1a38', color:'#aaaacc', borderRadius:2, padding:'2px 4px', fontSize:10, width:'100%', boxSizing:'border-box' },
  feedSelect:{ background:'#0d0d1e', border:'1px solid #1a1a38', color:'#aaaacc', borderRadius:2, padding:'2px 3px', fontSize:10, width:'100%' },
  addFeedBtn:{ marginTop:4, background:'none', border:'1px solid #2a2a50', color:'#5555aa', borderRadius:3, padding:'3px 10px', cursor:'pointer', fontSize:10 },
  delFeedBtn:{ background:'none', border:'none', color:'#884444', cursor:'pointer', fontSize:12, padding:'0 4px' },

  // Footer
  footer:   { display:'flex', alignItems:'center', gap:8, padding:'10px 16px', borderTop:'1px solid #2a2a50', flexShrink:0, background:'#1a1a38' },
  saveMsg:  { fontSize:10, color:'#44cc88', flex:1 },
  errMsg:   { fontSize:10, color:'#ff8888', flex:1 },
  btn:      { padding:'5px 14px', borderRadius:4, cursor:'pointer', fontSize:11, border:'none' },
  btnPrim:  { background:'#3a3aaa', color:'#fff' },
  btnSec:   { background:'#2a2a4a', color:'#aaa', border:'1px solid #3a3a60' },
  btnDang:  { background:'#4a1a1a', color:'#ff8888', border:'1px solid #6a2a2a' },
};

function fmtDia(t, isInch) {
  const v = isInch ? (t.diameter / MM_PER_INCH).toFixed(4) : t.diameter.toFixed(2);
  return `⌀${v}${isInch ? '"' : 'mm'}`;
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function ToolLibraryModal({ onClose }) {
  const { state, dispatch } = useApp();
  const isInch     = state.postConfig?.units === 'inch';
  const machineName = state.machineConfig?.name || 'Masso G3';

  const [tools,       setTools]      = useState([]);
  const [selectedId,  setSelectedId] = useState(null);
  const [editTool,    setEditTool]   = useState(null);
  const [dirty,       setDirty]      = useState(false);
  const [search,      setSearch]     = useState('');
  const [collapsed,   setCollapsed]  = useState({});
  const [msg,         setMsg]        = useState({ text:'', isErr:false });
  const importRef = useRef(null);

  useEffect(() => { loadTools(); }, []);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') { if (!dirty || window.confirm('Discard unsaved changes?')) onClose(); } }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, onClose]);

  async function loadTools() {
    if (!window.electron) return;
    const t = await window.electron.getTools();
    setTools(t || []);
    return t || [];
  }

  async function refreshAndDispatch() {
    const t = await loadTools();
    dispatch({ type: 'SET_TOOLS', payload: t });
  }

  function confirmDirty() {
    return !dirty || window.confirm('Discard unsaved changes?');
  }

  function selectTool(tool) {
    if (!confirmDirty()) return;
    setSelectedId(tool.id);
    setEditTool(JSON.parse(JSON.stringify(tool)));
    setDirty(false);
    setMsg({ text:'', isErr:false });
  }

  function handleAddTool() {
    if (!confirmDirty()) return;
    setSelectedId('__new__');
    setEditTool(newTool());
    setDirty(false);
    setMsg({ text:'', isErr:false });
  }

  function handleDuplicate() {
    if (!editTool || !confirmDirty()) return;
    const dup = { ...JSON.parse(JSON.stringify(editTool)), id: undefined, name: editTool.name + ' (copy)' };
    setSelectedId('__new__');
    setEditTool(dup);
    setDirty(true);
    setMsg({ text:'', isErr:false });
  }

  async function handleSave() {
    if (!editTool) return;
    if (!editTool.name?.trim()) { setMsg({ text:'Name is required.', isErr:true }); return; }
    const saved = await window.electron.saveTool(editTool);
    if (!saved) { setMsg({ text:'Save failed — check console.', isErr:true }); return; }
    await refreshAndDispatch();
    setSelectedId(saved.id);
    setEditTool(JSON.parse(JSON.stringify(saved)));
    setDirty(false);
    setMsg({ text:'Saved ✓', isErr:false });
    setTimeout(() => setMsg(m => m.text === 'Saved ✓' ? { text:'', isErr:false } : m), 2000);
  }

  async function handleDelete() {
    if (!editTool || selectedId === '__new__') return;
    if (!window.confirm(`Delete "${editTool.name}"?`)) return;
    await window.electron.deleteTool(selectedId);
    await refreshAndDispatch();
    setSelectedId(null);
    setEditTool(null);
    setDirty(false);
    setMsg({ text:'', isErr:false });
  }

  function set(key, val) {
    setEditTool(t => ({ ...t, [key]: val }));
    setDirty(true);
    setMsg({ text:'', isErr:false });
  }

  function setFeed(i, key, val) {
    setEditTool(t => {
      const feeds = [...t.feeds];
      feeds[i] = { ...feeds[i], [key]: val };
      return { ...t, feeds };
    });
    setDirty(true);
  }

  // ── Import / Export ────────────────────────────────────────────────────────
  function handleExport() {
    const json = JSON.stringify(tools, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'tool-library.json'; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    e.target.value = '';
    try {
      const imported = JSON.parse(text);
      if (!Array.isArray(imported)) throw new Error('Not an array');
      if (!window.confirm(`Import ${imported.length} tools? This will REPLACE your current library.`)) return;
      for (const t of tools) await window.electron.deleteTool(t.id);
      for (const t of imported) {
        const { id, ...rest } = t;
        await window.electron.saveTool(rest);
      }
      await refreshAndDispatch();
      setSelectedId(null); setEditTool(null); setDirty(false);
      setMsg({ text:`Imported ${imported.length} tools.`, isErr:false });
    } catch {
      setMsg({ text:'Import failed — invalid JSON.', isErr:true });
    }
  }

  // ── Unit helpers ───────────────────────────────────────────────────────────
  const toDisp = (mm) => isInch ? +(mm / MM_PER_INCH).toFixed(4) : +mm.toFixed(3);
  const toMM   = (v)  => isInch ? v * MM_PER_INCH : v;
  const dUnit  = isInch ? 'in' : 'mm';
  const fUnit  = isInch ? 'in/min' : 'mm/min';
  const dStep  = isInch ? 0.0001 : 0.01;
  const fStep  = isInch ? 0.1 : 25;

  // ── Group tools ────────────────────────────────────────────────────────────
  const q = search.toLowerCase();
  const filtered = tools.filter(t =>
    !q || t.name.toLowerCase().includes(q) || t.type.toLowerCase().includes(q)
  );
  const grouped = Object.fromEntries(CATEGORIES.map(c => [c, []]));
  for (const t of filtered) {
    const cat = getCategory(t);
    (grouped[cat] ?? grouped['Other']).push(t);
  }

  const isTapered = editTool?.type === 'tapered';
  const isVBit    = isTapered && (editTool?.tipDiameter ?? 0) < 0.1;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={S.header}>
          <span style={S.title}>🔧 Tool Library</span>
          <input ref={importRef} type="file" accept=".json" style={{ display:'none' }} onChange={handleImport} />
          <button style={S.iconBtn} onClick={() => importRef.current?.click()}>⬆ Import JSON</button>
          <button style={S.iconBtn} onClick={handleExport}>⬇ Export JSON</button>
          <button style={{ ...S.iconBtn, marginLeft:8, fontSize:14, padding:'2px 9px' }} onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div style={S.body}>

          {/* Left — tool list */}
          <div style={S.left}>
            <div style={S.searchWrap}>
              <input
                style={S.search}
                placeholder="Search tools…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div style={S.listBody}>
              {CATEGORIES.map(cat => {
                const catTools = grouped[cat];
                if (catTools.length === 0) return null;
                const open = !collapsed[cat];
                return (
                  <div key={cat}>
                    <div style={S.catHdr} onClick={() => setCollapsed(c => ({ ...c, [cat]: !c[cat] }))}>
                      <span style={{ fontSize:8 }}>{open ? '▼' : '▶'}</span>
                      <span>{cat}</span>
                      <span style={{ marginLeft:'auto', opacity:0.6 }}>{catTools.length}</span>
                    </div>
                    {open && catTools.map(t => (
                      <div key={t.id} style={S.toolRow(t.id === selectedId)} onClick={() => selectTool(t)}>
                        <span style={{ fontSize:12, flexShrink:0 }}>{TYPE_ICON[t.type] || '⚙'}</span>
                        <span style={S.toolName} title={t.name}>{t.name}</span>
                        <span style={S.toolDia}>{fmtDia(t, isInch)}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div style={{ padding:20, textAlign:'center', color:'#333355', fontSize:11 }}>No tools found</div>
              )}
            </div>
            <button style={S.addBtn} onClick={handleAddTool}>+ New Tool</button>
          </div>

          {/* Right — edit form */}
          <div style={S.right}>
            {!editTool ? (
              <div style={S.empty}>Select a tool to edit, or add a new one.</div>
            ) : (
              <>
                <div style={S.formWrap}>

                  {/* ── Tool Properties ── */}
                  <div style={S.section}>Tool Properties</div>
                  <div style={S.grid}>
                    <span style={S.label}>Name</span>
                    <input style={S.input} value={editTool.name}
                      onChange={e => set('name', e.target.value)} />

                    <span style={S.label}>Type</span>
                    <select style={S.select} value={editTool.type}
                      onChange={e => set('type', e.target.value)}>
                      {TOOL_TYPES.map(t => <option key={t} value={t}>{TYPE_ICON[t]} {t}</option>)}
                    </select>

                    <span style={S.label}>Tool Material</span>
                    <select style={S.select} value={editTool.material}
                      onChange={e => set('material', e.target.value)}>
                      {TOOL_MATS.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>

                    <span style={S.label}>Flutes</span>
                    <input style={{ ...S.input }} type="number" min="1" max="12" step="1"
                      value={editTool.flutes}
                      onChange={e => set('flutes', parseInt(e.target.value) || 2)} />

                    <span style={S.label}>Notes</span>
                    <textarea style={S.textarea} value={editTool.notes || ''}
                      rows={2} onChange={e => set('notes', e.target.value)} />
                  </div>

                  {/* ── Geometry ── */}
                  <div style={S.section}>Geometry</div>
                  <div style={S.grid}>
                    <span style={S.label}>Diameter</span>
                    <div style={S.inlineRow}>
                      <input style={{ ...S.input, flex:1 }} type="number" min="0.001" step={dStep}
                        value={toDisp(editTool.diameter || 0)}
                        onChange={e => set('diameter', toMM(parseFloat(e.target.value) || 0))} />
                      <span style={S.unitTag}>{dUnit}</span>
                    </div>

                    {isTapered && <>
                      <span style={S.label}>Tip Diameter</span>
                      <div style={S.inlineRow}>
                        <input style={{ ...S.input, flex:1 }} type="number" min="0" step={dStep}
                          value={toDisp(editTool.tipDiameter ?? 0)}
                          onChange={e => set('tipDiameter', toMM(parseFloat(e.target.value) || 0))} />
                        <span style={S.unitTag}>{dUnit}</span>
                      </div>

                      <span style={S.label}>{isVBit ? 'V-Angle (half °)' : 'Taper Angle (°)'}</span>
                      <div style={S.inlineRow}>
                        <input style={{ ...S.input, flex:1 }} type="number" min="0.5" max="89" step="0.5"
                          value={editTool.taperAngle ?? 0}
                          onChange={e => set('taperAngle', parseFloat(e.target.value) || 0)} />
                        <span style={S.unitTag}>° half-angle{isVBit ? ` (${((editTool.taperAngle ?? 0) * 2).toFixed(0)}° included)` : ''}</span>
                      </div>
                    </>}
                  </div>

                  {/* ── Tool Numbering ── */}
                  <div style={S.section}>Tool Numbering</div>
                  <div style={S.grid}>
                    <span style={S.label}>Default T#</span>
                    <input style={{ ...S.input }} type="number" min="1" max="99" step="1"
                      value={editTool.tool_number ?? 1}
                      onChange={e => set('tool_number', parseInt(e.target.value) || 1)} />

                    <span style={S.label}>{machineName}</span>
                    <div style={S.inlineRow}>
                      <input style={{ ...S.input, flex:1 }} type="number" min="1" max="99" step="1"
                        value={editTool.machineNumbers?.[machineName] ?? editTool.tool_number ?? 1}
                        onChange={e => set('machineNumbers', {
                          ...(editTool.machineNumbers || {}),
                          [machineName]: parseInt(e.target.value) || 1,
                        })} />
                      <span style={S.unitTag}>T# on this machine</span>
                    </div>
                  </div>

                  {/* ── Feeds & Speeds ── */}
                  <div style={{ display:'flex', alignItems:'baseline', gap:8, marginTop:14 }}>
                    <div style={{ ...S.section, margin:0, flex:1 }}>Feeds &amp; Speeds</div>
                    <button style={S.addFeedBtn} onClick={() => { setEditTool(t => ({ ...t, feeds:[...t.feeds, newFeedRow()] })); setDirty(true); }}>
                      + Add Material
                    </button>
                  </div>
                  {editTool.feeds.length === 0 ? (
                    <div style={{ padding:'8px 0', fontSize:10, color:'#333355' }}>No feed profiles yet — click + Add Material.</div>
                  ) : (
                    <div style={S.feedsWrap}>
                      <table style={S.feedTable}>
                        <thead>
                          <tr>
                            {['Material','RPM',`Feed (${fUnit})`,`Plunge (${fUnit})`,`Doc (${dUnit})`,'SO %',''].map((h,i) => (
                              <th key={i} style={S.thCell}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {editTool.feeds.map((f, i) => (
                            <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                              <td style={S.tdCell}>
                                <select style={{ ...S.feedSelect, minWidth:90 }}
                                  value={f.material}
                                  onChange={e => setFeed(i, 'material', e.target.value)}>
                                  {FEED_MATS.map(m => <option key={m} value={m}>{m}</option>)}
                                  {!FEED_MATS.includes(f.material) && <option value={f.material}>{f.material}</option>}
                                </select>
                              </td>
                              <td style={S.tdCell}>
                                <input style={{ ...S.feedInput, width:70 }} type="number" step="100" min="100"
                                  value={f.spindle_rpm}
                                  onChange={e => setFeed(i, 'spindle_rpm', +e.target.value)} />
                              </td>
                              <td style={S.tdCell}>
                                <input style={{ ...S.feedInput, width:80 }} type="number" step={fStep} min="1"
                                  value={isInch ? +(f.feed_rate / MM_PER_INCH).toFixed(2) : f.feed_rate}
                                  onChange={e => setFeed(i, 'feed_rate', isInch ? +e.target.value * MM_PER_INCH : +e.target.value)} />
                              </td>
                              <td style={S.tdCell}>
                                <input style={{ ...S.feedInput, width:80 }} type="number" step={fStep} min="1"
                                  value={isInch ? +(f.plunge_rate / MM_PER_INCH).toFixed(2) : f.plunge_rate}
                                  onChange={e => setFeed(i, 'plunge_rate', isInch ? +e.target.value * MM_PER_INCH : +e.target.value)} />
                              </td>
                              <td style={S.tdCell}>
                                <input style={{ ...S.feedInput, width:68 }} type="number" step={dStep} min="0.001"
                                  value={toDisp(f.depth_per_pass)}
                                  onChange={e => setFeed(i, 'depth_per_pass', toMM(+e.target.value))} />
                              </td>
                              <td style={S.tdCell}>
                                <input style={{ ...S.feedInput, width:52 }} type="number" step="1" min="1" max="100"
                                  value={Math.round((f.stepover ?? 0.45) * 100)}
                                  onChange={e => setFeed(i, 'stepover', (+e.target.value) / 100)} />
                              </td>
                              <td style={S.tdCell}>
                                <button style={S.delFeedBtn}
                                  onClick={() => { setEditTool(t => ({ ...t, feeds: t.feeds.filter((_,j) => j !== i) })); setDirty(true); }}>
                                  ✕
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div style={S.footer}>
                  {msg.text
                    ? <span style={msg.isErr ? S.errMsg : S.saveMsg}>{msg.text}</span>
                    : <span style={{ flex:1 }} />}
                  <button style={{ ...S.btn, ...S.btnSec }} onClick={handleDuplicate} disabled={!editTool}>
                    ⧉ Duplicate
                  </button>
                  {selectedId !== '__new__' && (
                    <button style={{ ...S.btn, ...S.btnDang }} onClick={handleDelete}>
                      ✕ Delete
                    </button>
                  )}
                  <button style={{ ...S.btn, ...S.btnPrim }} onClick={handleSave}>
                    {dirty ? '● ' : ''}Save Tool
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
