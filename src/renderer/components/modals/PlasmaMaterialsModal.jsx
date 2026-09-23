import React, { useEffect, useState } from 'react';
import { DEFAULT_PLASMA_MATERIALS, loadPlasmaMaterials, savePlasmaMaterials } from '../../plasma/plasmaMaterials';

// Plasma material library editor (PLASMA screen → ⚡ Materials). Kerf, cut
// feed and lead-in per material/thickness — what a Plasma Cut needs for its
// path. Stored in inches (like DMD-C3 Plasma Control's library); shown in the
// machine profile's units. Keep ids matching the Plasma app's to have it
// pick the material automatically.

const MM = 25.4;

const S = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  box: { background: '#1a1a38', border: '1px solid #3a3a70', borderRadius: 8, padding: '18px 20px', width: 760, maxWidth: '94vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column', color: '#ccc', fontFamily: 'system-ui,sans-serif' },
  title: { fontSize: 15, fontWeight: 700, color: '#aaaaff', marginBottom: 12 },
  body: { display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12, minHeight: 0, flex: 1 },
  list: { background: '#0d0d20', border: '1px solid #2a2a50', borderRadius: 4, overflowY: 'auto' },
  item: sel => ({ padding: '6px 10px', fontSize: 12, cursor: 'pointer', background: sel ? '#2a2a60' : 'transparent', color: sel ? '#fff' : '#aaaacc' }),
  input: { background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '3px 6px', fontSize: 12, width: '100%', boxSizing: 'border-box' },
  th: { fontSize: 10, color: '#8888aa', textAlign: 'left', padding: '2px 4px', fontWeight: 600 },
  td: { padding: '2px 4px' },
  link: { background: 'none', border: 'none', color: '#88aaff', cursor: 'pointer', fontSize: 12, padding: '6px 0' },
  del: armed => ({ background: armed ? '#aa3333' : '#2a2a4a', border: '1px solid #3a3a60', color: armed ? '#fff' : '#aaa', borderRadius: 3, fontSize: 11, cursor: 'pointer', padding: '2px 8px', whiteSpace: 'nowrap' }),
  btnRow: { display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 14 },
  btn: { padding: '6px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 12, border: 'none' },
  primary: { background: '#3a3aaa', color: '#fff' },
  secondary: { background: '#2a2a4a', color: '#aaa', border: '1px solid #3a3a60' },
};

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'material';
}

/** Two clicks to delete: the first arms it ("Sure?"), a second within 3 s deletes. */
function DeleteBtn({ label, onDelete }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return <button style={S.del(armed)} onClick={() => (armed ? onDelete() : setArmed(true))}>{armed ? 'Sure?' : label}</button>;
}

function Num({ value, onChange, step }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input style={S.input} type="number" step={step} value={text}
      onChange={e => { setText(e.target.value); const n = parseFloat(e.target.value); if (!isNaN(n) && n >= 0) onChange(n); }}
      onBlur={() => setText(String(value))} />
  );
}

export default function PlasmaMaterialsModal({ isInch, onClose, onSaved }) {
  const [materials, setMaterials] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    loadPlasmaMaterials().then(m => {
      setMaterials(JSON.parse(JSON.stringify(m)));
      setSelectedId(m[0]?.id ?? null);
    });
  }, []);

  if (!materials) return null;
  const selected = materials.find(m => m.id === selectedId) || null;
  const len = v => (isInch ? +v.toFixed(4) : +(v * MM).toFixed(3));
  const lenIn = v => (isInch ? v : v / MM);
  const feed = v => (isInch ? +v.toFixed(1) : Math.round(v * MM));
  const feedIn = v => (isInch ? v : v / MM);

  const update = fn => setMaterials(ms => ms.map(m => (m.id === selectedId ? fn(m) : m)));
  const setRow = (tid, key, val) => update(m => ({ ...m, thicknesses: m.thicknesses.map(t => (t.id === tid ? { ...t, [key]: val } : t)) }));

  function addMaterial() {
    const id = `${slug('new material')}-${Date.now()}`;
    setMaterials(ms => [...ms, { id, name: 'New Material', thicknesses: [] }]);
    setSelectedId(id);
  }
  function addThickness() {
    update(m => ({ ...m, thicknesses: [...m.thicknesses, { id: `t-${Date.now()}`, label: 'new', kerfIn: 0.045, feedInMin: 100, leadInLengthIn: 0.14, leadStyle: 'arc' }] }));
  }
  async function save() {
    await savePlasmaMaterials(materials);
    onSaved?.();
    onClose();
  }

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.box} onClick={e => e.stopPropagation()}>
        <div style={S.title}>⚡ Plasma Materials</div>
        <div style={S.body}>
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={S.list}>
              {materials.map(m => (
                <div key={m.id} style={S.item(m.id === selectedId)} onClick={() => setSelectedId(m.id)}>{m.name || '(no name)'}</div>
              ))}
            </div>
            <button style={S.link} onClick={addMaterial}>+ Add Material</button>
          </div>
          <div style={{ overflowY: 'auto', minHeight: 0 }}>
            {selected && <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: '#8888aa' }}>Name</span>
                <input style={{ ...S.input, width: 260 }} value={selected.name} onChange={e => update(m => ({ ...m, name: e.target.value }))} />
                <div style={{ flex: 1 }} />
                <DeleteBtn label="Delete Material" onDelete={() => { setMaterials(ms => ms.filter(m => m.id !== selectedId)); setSelectedId(materials.find(m => m.id !== selectedId)?.id ?? null); }} />
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={S.th}>Thickness</th>
                    <th style={S.th}>Kerf ({isInch ? 'in' : 'mm'})</th>
                    <th style={S.th}>Cut Feed ({isInch ? 'in/min' : 'mm/min'})</th>
                    <th style={S.th}>Lead-in ({isInch ? 'in' : 'mm'})</th>
                    <th style={S.th}>Lead Style</th>
                    <th style={S.th} />
                  </tr>
                </thead>
                <tbody>
                  {selected.thicknesses.map(t => (
                    <tr key={t.id}>
                      <td style={S.td}><input style={S.input} value={t.label} onChange={e => setRow(t.id, 'label', e.target.value)} /></td>
                      <td style={S.td}><Num value={len(t.kerfIn)} step={isInch ? 0.001 : 0.02} onChange={v => setRow(t.id, 'kerfIn', lenIn(v))} /></td>
                      <td style={S.td}><Num value={feed(t.feedInMin)} step={isInch ? 5 : 100} onChange={v => setRow(t.id, 'feedInMin', feedIn(v))} /></td>
                      <td style={S.td}><Num value={len(t.leadInLengthIn)} step={isInch ? 0.01 : 0.2} onChange={v => setRow(t.id, 'leadInLengthIn', lenIn(v))} /></td>
                      <td style={S.td}>
                        <select style={S.input} value={t.leadStyle || 'arc'} onChange={e => setRow(t.id, 'leadStyle', e.target.value)}>
                          <option value="arc">Arc</option>
                          <option value="line">Line</option>
                        </select>
                      </td>
                      <td style={S.td}><DeleteBtn label="Delete" onDelete={() => update(m => ({ ...m, thicknesses: m.thicknesses.filter(x => x.id !== t.id) }))} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button style={S.link} onClick={addThickness}>+ Add Thickness</button>
            </>}
          </div>
        </div>
        <div style={S.btnRow}>
          <button style={{ ...S.btn, ...S.secondary }} onClick={() => setMaterials(JSON.parse(JSON.stringify(DEFAULT_PLASMA_MATERIALS)))} title="Put the default materials back (not saved until you click Save)">Reset to Defaults</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...S.btn, ...S.secondary }} onClick={onClose}>Cancel</button>
            <button style={{ ...S.btn, ...S.primary }} onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
