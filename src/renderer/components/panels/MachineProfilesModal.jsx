import React, { useState, useEffect, useCallback } from 'react';
import { v4 as uuid } from 'uuid';
import { useApp } from '../../store/AppContext';
import { POST_PROCESSORS, PP_LIST } from '../../gcode/postProcessors';

function newProfile(ppId = 'massoG3') {
  const pp = POST_PROCESSORS[ppId] || POST_PROCESSORS.massoG3;
  return {
    id: uuid(),
    name: `New ${pp.label} Machine`,
    postProcessor: ppId,
    settings: { ...pp.defaultSettings },
    toolNumbers: {},
  };
}

const S = {
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center' },
  box: { display:'flex', flexDirection:'column', width:1060, maxWidth:'96vw', height:700, maxHeight:'92vh', background:'#13132a', border:'1px solid #3a3a70', borderRadius:8, color:'#ccc', fontFamily:'system-ui,sans-serif', overflow:'hidden' },
  titleBar: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 18px', borderBottom:'1px solid #2a2a50', flexShrink:0 },
  title: { fontSize:15, fontWeight:700, color:'#aaaaff' },
  closeBtn: { background:'none', border:'none', color:'#666688', fontSize:18, cursor:'pointer', lineHeight:1, padding:'0 4px' },
  body: { display:'flex', flex:1, overflow:'hidden' },

  // Left panel
  left: { width:230, flexShrink:0, borderRight:'1px solid #2a2a50', display:'flex', flexDirection:'column' },
  leftHdr: { padding:'8px 10px', borderBottom:'1px solid #1a1a3a', display:'flex', alignItems:'center', justifyContent:'space-between' },
  leftHdrLabel: { fontSize:10, color:'#5555aa', textTransform:'uppercase', letterSpacing:1 },
  addBtn: { fontSize:18, background:'none', border:'1px solid #3a3a70', color:'#6666cc', borderRadius:4, width:22, height:22, cursor:'pointer', lineHeight:1, display:'flex', alignItems:'center', justifyContent:'center' },
  profileList: { flex:1, overflow:'auto' },
  profileRow: (sel, active) => ({
    padding:'8px 10px', cursor:'pointer', display:'flex', alignItems:'center', gap:6,
    background: sel ? '#22224a' : 'transparent',
    borderLeft: `3px solid ${sel ? '#5555cc' : 'transparent'}`,
  }),
  profileRowName: { flex:1, fontSize:11, color:'#ccccdd', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  profileRowPP: { fontSize:9, color:'#555577', flexShrink:0 },
  activeBadge: { fontSize:8, background:'#2a4a2a', border:'1px solid #448844', color:'#88cc88', borderRadius:3, padding:'1px 4px', flexShrink:0 },
  delRowBtn: { background:'none', border:'none', color:'#664444', fontSize:11, cursor:'pointer', padding:'0 2px', flexShrink:0 },

  // Right panel
  right: { flex:1, display:'flex', flexDirection:'column', overflow:'hidden' },
  rightScroll: { flex:1, overflow:'auto', padding:'14px 18px' },
  emptyState: { display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color:'#444466', fontSize:13 },

  // Form
  section: { fontSize:10, color:'#5555aa', textTransform:'uppercase', letterSpacing:1, marginBottom:6, marginTop:14, borderBottom:'1px solid #1a1a38', paddingBottom:3 },
  grid: { display:'grid', gridTemplateColumns:'160px 1fr', gap:'6px 10px', alignItems:'start', marginBottom:4 },
  label: { fontSize:11, color:'#8888aa', paddingTop:4 },
  input: { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:3, padding:'3px 6px', fontSize:11, width:'100%', boxSizing:'border-box' },
  select: { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:3, padding:'3px 5px', fontSize:11, width:'100%' },
  textarea: { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:3, padding:'4px 6px', fontSize:10, width:'100%', height:52, resize:'vertical', fontFamily:'monospace', boxSizing:'border-box' },
  note: { fontSize:9, color:'#444466', marginTop:2, lineHeight:1.4 },
  checkRow: { display:'flex', alignItems:'center', gap:6, paddingTop:4 },
  unitTag: { fontSize:10, color:'#555577', marginLeft:4 },

  // Tool numbers table
  tnTable: { width:'100%', borderCollapse:'collapse', fontSize:11 },
  tnTh: { textAlign:'left', fontSize:9, color:'#5555aa', textTransform:'uppercase', letterSpacing:1, padding:'4px 6px', borderBottom:'1px solid #1a1a38' },
  tnTd: { padding:'3px 6px', borderBottom:'1px solid #111128', color:'#aaaacc', verticalAlign:'middle' },
  tnInput: { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:3, padding:'2px 5px', fontSize:11, width:60, textAlign:'center' },

  // Footer
  footer: { padding:'10px 16px', borderTop:'1px solid #2a2a50', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 },
  footLeft: { display:'flex', gap:8 },
  footRight: { display:'flex', gap:8, alignItems:'center' },
  btn: { padding:'5px 14px', borderRadius:4, cursor:'pointer', fontSize:11, border:'none' },
  btnPrimary: { background:'#3a3aaa', color:'#fff' },
  btnSecondary: { background:'#1e1e3a', border:'1px solid #3a3a60', color:'#aaa' },
  btnDanger: { background:'#3a1a1a', border:'1px solid #5a2a2a', color:'#cc7777' },
  btnActivate: { background:'#1a3a1a', border:'1px solid #2a5a2a', color:'#88cc88' },
  statusMsg: { fontSize:10, color:'#6688aa', marginRight:8 },
  dirtyDot: { width:6, height:6, borderRadius:'50%', background:'#aaaa44', flexShrink:0 },
};

function SettingField({ spec, value, onChange }) {
  const v = value ?? (spec.type === 'checkbox' ? false : spec.type === 'number' ? 0 : spec.type === 'textarea' ? '' : '');
  if (spec.type === 'select') {
    return (
      <div>
        <select style={S.select} value={v} onChange={e => onChange(e.target.value)}>
          {spec.options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
        {spec.note && <div style={S.note}>{spec.note}</div>}
      </div>
    );
  }
  if (spec.type === 'checkbox') {
    return (
      <div style={S.checkRow}>
        <input type="checkbox" checked={!!v} onChange={e => onChange(e.target.checked)} />
        {spec.note && <span style={S.note}>{spec.note}</span>}
      </div>
    );
  }
  if (spec.type === 'number') {
    return (
      <div style={{ display:'flex', alignItems:'center', gap:4 }}>
        <input style={{ ...S.input, width:90 }} type="number"
          min={spec.min} max={spec.max} step={spec.step ?? 1}
          value={v}
          onChange={e => onChange(parseFloat(e.target.value) || 0)} />
        {spec.unit && <span style={S.unitTag}>{spec.unit}</span>}
        {spec.note && <span style={S.note}>{spec.note}</span>}
      </div>
    );
  }
  if (spec.type === 'textarea') {
    return (
      <div>
        <textarea style={S.textarea} value={v} onChange={e => onChange(e.target.value)}
          placeholder={`(Optional ${spec.label.toLowerCase()})`} />
        {spec.note && <div style={S.note}>{spec.note}</div>}
      </div>
    );
  }
  return null;
}

async function persistProfiles(profiles, activeId) {
  if (!window.electron) return;
  await window.electron.storeSet('machineProfiles', profiles);
  await window.electron.storeSet('activeProfileId', activeId);
}

export default function MachineProfilesModal({ onClose }) {
  const { state, dispatch } = useApp();
  const { machineProfiles, activeProfileId, tools } = state;

  const [selectedId, setSelectedId] = useState(activeProfileId || machineProfiles[0]?.id || null);
  const [editProfile, setEditProfile] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');

  // Load selected profile into edit form
  useEffect(() => {
    if (!selectedId) { setEditProfile(null); return; }
    const p = machineProfiles.find(p => p.id === selectedId);
    if (p) { setEditProfile(JSON.parse(JSON.stringify(p))); setDirty(false); }
  }, [selectedId, machineProfiles]);

  // If no profiles exist, auto-create a default Masso G3 profile
  useEffect(() => {
    if (machineProfiles.length === 0) {
      const p = newProfile('massoG3');
      p.name = 'Masso G3 Router';
      dispatch({ type: 'ADD_MACHINE_PROFILE', payload: p });
      dispatch({ type: 'SET_ACTIVE_PROFILE', payload: p.id });
      setSelectedId(p.id);
      persistProfiles([p], p.id);
    }
  }, []);

  function setField(key, val) {
    setEditProfile(p => ({ ...p, [key]: val }));
    setDirty(true);
  }

  function setSettingField(key, val) {
    setEditProfile(p => ({ ...p, settings: { ...p.settings, [key]: val } }));
    setDirty(true);
  }

  function setToolNumber(toolId, num) {
    setEditProfile(p => ({ ...p, toolNumbers: { ...p.toolNumbers, [String(toolId)]: num } }));
    setDirty(true);
  }

  // When PP type changes: start with new PP's defaults, overlay with user's existing settings
  // so common fields (units, safeZ, etc.) are preserved, and PP-specific fields get their defaults.
  function changePostProcessor(ppId) {
    const pp = POST_PROCESSORS[ppId] || POST_PROCESSORS.massoG3;
    setEditProfile(p => ({
      ...p,
      postProcessor: ppId,
      settings: { ...pp.defaultSettings, ...p.settings },
    }));
    setDirty(true);
  }

  function saveProfile() {
    if (!editProfile) return;
    if (!editProfile.name?.trim()) { setStatus('Profile name is required'); return; }
    dispatch({ type: 'UPDATE_MACHINE_PROFILE', payload: editProfile });
    const updated = machineProfiles.map(p => p.id === editProfile.id ? editProfile : p);
    persistProfiles(updated, activeProfileId);
    setDirty(false);
    setStatus('Saved');
    setTimeout(() => setStatus(''), 2000);
  }

  function activateProfile() {
    if (!selectedId) return;
    if (dirty) saveProfile();
    dispatch({ type: 'SET_ACTIVE_PROFILE', payload: selectedId });
    persistProfiles(machineProfiles, selectedId);
    setStatus('Activated');
    setTimeout(() => setStatus(''), 2000);
  }

  function addProfile() {
    const p = newProfile('massoG3');
    dispatch({ type: 'ADD_MACHINE_PROFILE', payload: p });
    setSelectedId(p.id);
    setStatus('');
  }

  function duplicateProfile() {
    if (!editProfile) return;
    const dup = { ...JSON.parse(JSON.stringify(editProfile)), id: uuid(), name: editProfile.name + ' (copy)' };
    dispatch({ type: 'ADD_MACHINE_PROFILE', payload: dup });
    setSelectedId(dup.id);
  }

  function deleteProfile(id) {
    const profile = machineProfiles.find(p => p.id === id);
    if (!window.confirm(`Delete "${profile?.name || 'this profile'}"?`)) return;
    dispatch({ type: 'DELETE_MACHINE_PROFILE', payload: id });
    const remaining = machineProfiles.filter(p => p.id !== id);
    const newActive = id === activeProfileId ? (remaining[0]?.id || null) : activeProfileId;
    persistProfiles(remaining, newActive);
    if (id === selectedId) setSelectedId(remaining[0]?.id || null);
    setDirty(false);
  }

  function handleClose() {
    if (dirty && !window.confirm('Discard unsaved changes to this profile?')) return;
    onClose();
  }

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') handleClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty]);

  const pp = editProfile ? (POST_PROCESSORS[editProfile.postProcessor] || POST_PROCESSORS.massoG3) : null;
  const isActive = selectedId === activeProfileId;

  return (
    <div style={S.overlay} onClick={handleClose}>
      <div style={S.box} onClick={e => e.stopPropagation()}>

        {/* Title bar */}
        <div style={S.titleBar}>
          <span style={S.title}>Machine Profiles</span>
          <button style={S.closeBtn} onClick={handleClose}>✕</button>
        </div>

        <div style={S.body}>
          {/* Left panel — profile list */}
          <div style={S.left}>
            <div style={S.leftHdr}>
              <span style={S.leftHdrLabel}>Profiles</span>
              <button style={S.addBtn} onClick={addProfile} title="Add profile">+</button>
            </div>
            <div style={S.profileList}>
              {machineProfiles.map(p => (
                <div key={p.id} style={S.profileRow(p.id === selectedId, p.id === activeProfileId)}
                  onClick={() => { if (dirty && selectedId !== p.id && !window.confirm('Discard unsaved changes?')) return; setSelectedId(p.id); }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={S.profileRowName}>{p.name}</div>
                    <div style={S.profileRowPP}>{POST_PROCESSORS[p.postProcessor]?.label || p.postProcessor}</div>
                  </div>
                  {p.id === activeProfileId && <span style={S.activeBadge}>ACTIVE</span>}
                  {machineProfiles.length > 1 && (
                    <button style={S.delRowBtn} onClick={e => { e.stopPropagation(); deleteProfile(p.id); }} title="Delete">✕</button>
                  )}
                </div>
              ))}
              {machineProfiles.length === 0 && (
                <div style={{ padding:16, color:'#444466', fontSize:11 }}>No profiles yet</div>
              )}
            </div>
          </div>

          {/* Right panel — edit form */}
          <div style={S.right}>
            {!editProfile ? (
              <div style={S.emptyState}>Select a profile to edit</div>
            ) : (
              <div style={S.rightScroll}>

                {/* Identity */}
                <div style={S.section}>Profile Identity</div>
                <div style={S.grid}>
                  <span style={S.label}>Profile Name</span>
                  <input style={S.input} value={editProfile.name}
                    onChange={e => setField('name', e.target.value)} />

                  <span style={S.label}>Post Processor</span>
                  <div>
                    <select style={S.select} value={editProfile.postProcessor}
                      onChange={e => changePostProcessor(e.target.value)}>
                      {PP_LIST.map(p => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                    <div style={S.note}>{pp?.description}</div>
                  </div>
                </div>

                {/* Dynamic settings */}
                <div style={S.section}>Post-Processor Settings</div>
                <div style={S.grid}>
                  {pp?.settingsSpec.map(spec => (
                    <React.Fragment key={spec.key}>
                      <span style={S.label}>{spec.label}</span>
                      <SettingField
                        spec={spec}
                        value={editProfile.settings[spec.key]}
                        onChange={val => setSettingField(spec.key, val)}
                      />
                    </React.Fragment>
                  ))}
                </div>

                {/* Tool number assignments */}
                {tools.length > 0 && (
                  <>
                    <div style={S.section}>Tool Number Assignments</div>
                    <div style={{ fontSize:10, color:'#555577', marginBottom:8 }}>
                      Override the default tool number for each tool on this specific machine.
                    </div>
                    <table style={S.tnTable}>
                      <thead>
                        <tr>
                          <th style={S.tnTh}>Tool</th>
                          <th style={S.tnTh}>Type</th>
                          <th style={S.tnTh}>Default T#</th>
                          <th style={S.tnTh}>This Machine T#</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tools.map(tool => {
                          const defNum = tool.tool_number ?? 1;
                          const override = editProfile.toolNumbers?.[String(tool.id)];
                          const displayNum = override !== undefined ? override : defNum;
                          return (
                            <tr key={tool.id}>
                              <td style={S.tnTd}>{tool.name}</td>
                              <td style={{ ...S.tnTd, color:'#555577' }}>{tool.type}</td>
                              <td style={{ ...S.tnTd, color:'#445566' }}>T{defNum}</td>
                              <td style={S.tnTd}>
                                <input
                                  type="number" style={S.tnInput}
                                  min="1" max="99" step="1"
                                  value={displayNum}
                                  onChange={e => setToolNumber(tool.id, Math.max(1, Math.min(99, parseInt(e.target.value) || 1)))}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            )}

            {/* Footer */}
            <div style={S.footer}>
              <div style={S.footLeft}>
                {editProfile && (
                  <>
                    <button style={{ ...S.btn, ...S.btnSecondary }} onClick={duplicateProfile}>Duplicate</button>
                    {machineProfiles.length > 1 && (
                      <button style={{ ...S.btn, ...S.btnDanger }} onClick={() => deleteProfile(selectedId)}>Delete</button>
                    )}
                    {!isActive && (
                      <button style={{ ...S.btn, ...S.btnActivate }} onClick={activateProfile}>
                        Activate
                      </button>
                    )}
                    {isActive && (
                      <span style={{ fontSize:10, color:'#88cc88', padding:'5px 0' }}>✓ Active profile</span>
                    )}
                  </>
                )}
              </div>
              <div style={S.footRight}>
                {dirty && <span style={S.dirtyDot} title="Unsaved changes" />}
                {status && <span style={S.statusMsg}>{status}</span>}
                <button style={{ ...S.btn, ...S.btnSecondary }} onClick={handleClose}>Close</button>
                {editProfile && (
                  <button style={{ ...S.btn, ...S.btnPrimary }} onClick={saveProfile}>Save Profile</button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
