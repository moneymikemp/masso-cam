import React, { useEffect, useState } from 'react';
import { POST_PROCESSORS, PLASMA_PP_LIST } from '../../gcode/postProcessors';
import { loadPlasmaMachine, savePlasmaMachine } from '../../plasma/plasmaMaterials';

// Plasma machine setup (PLASMA screen → ⚙ Machine): which plasma post the
// 💾 Plasma G-code button uses, and that post's settings. Settings are kept
// per post, so switching back and forth doesn't lose them. 'length' and
// 'feed' fields are stored in mm and shown in the app's units.

const MM = 25.4;

const S = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  box: { background: '#1a1a38', border: '1px solid #3a3a70', borderRadius: 8, padding: '18px 22px', width: 620, maxWidth: '94vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', color: '#ccc', fontFamily: 'system-ui,sans-serif' },
  title: { fontSize: 15, fontWeight: 700, color: '#ffbb66', marginBottom: 12 },
  body: { overflowY: 'auto', minHeight: 0 },
  grid: { display: 'grid', gridTemplateColumns: '180px 1fr', gap: '8px 12px', alignItems: 'center' },
  label: { fontSize: 11, color: '#8888aa', textAlign: 'right' },
  input: { background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 4, padding: '4px 8px', fontSize: 12, boxSizing: 'border-box' },
  note: { fontSize: 10, color: '#666688', marginLeft: 6 },
  desc: { fontSize: 11, color: '#666688', margin: '4px 0 12px' },
  btnRow: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  btn: { padding: '6px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 12, border: 'none' },
  primary: { background: '#aa6a2a', color: '#fff' },
  secondary: { background: '#2a2a4a', color: '#aaa', border: '1px solid #3a3a60' },
};

function Field({ spec, value, onChange, isInch }) {
  const note = spec.note && <span style={S.note}>{spec.note}</span>;
  if (spec.type === 'select') {
    return (
      <div>
        <select style={S.input} value={value ?? ''} onChange={e => onChange(e.target.value)}>
          {spec.options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
        {note}
      </div>
    );
  }
  if (spec.type === 'checkbox') {
    return <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />{note}</label>;
  }
  if (spec.type === 'textarea') {
    return <textarea style={{ ...S.input, width: '100%', minHeight: 48, fontFamily: 'monospace' }} value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder={`(Optional ${spec.label.toLowerCase()})`} />;
  }
  // number, length (mm), feed (mm/min)
  const scale = spec.type === 'length' || spec.type === 'feed' ? (isInch ? 1 / MM : 1) : 1;
  const unit = spec.type === 'length' ? (isInch ? 'in' : 'mm') : spec.type === 'feed' ? (isInch ? 'in/min' : 'mm/min') : spec.unit;
  const step = spec.type === 'length' ? (isInch ? 0.01 : 0.5) : spec.type === 'feed' ? (isInch ? 1 : 25) : spec.step ?? 1;
  const shown = value == null ? '' : +(value * scale).toFixed(spec.type === 'length' && isInch ? 4 : 2);
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <input style={{ ...S.input, width: 100 }} type="number" min={spec.min} max={spec.max} step={step} value={shown}
        onChange={e => { const n = parseFloat(e.target.value); if (!isNaN(n)) onChange(n / scale); }} />
      {unit && <span style={S.note}>{unit}</span>}
      {note}
    </div>
  );
}

export default function PlasmaMachineModal({ isInch, onClose, onSaved }) {
  const [machine, setMachine] = useState(null);
  useEffect(() => { loadPlasmaMachine().then(setMachine); }, []);
  if (!machine) return null;

  const pp = POST_PROCESSORS[machine.postProcessor] || PLASMA_PP_LIST[0];
  const settings = { ...pp.defaultSettings, ...(machine.settings[pp.id] || {}) };
  const set = (key, val) => setMachine(m => ({ ...m, settings: { ...m.settings, [pp.id]: { ...settings, [key]: val } } }));

  async function save() {
    await savePlasmaMachine({ ...machine, postProcessor: pp.id, settings: { ...machine.settings, [pp.id]: settings } });
    onSaved?.();
    onClose();
  }

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.box} onClick={e => e.stopPropagation()}>
        <div style={S.title}>⚙ Plasma Machine</div>
        <div style={S.body}>
          <div style={S.grid}>
            <span style={S.label}>Post Processor</span>
            <select style={S.input} value={pp.id} onChange={e => setMachine(m => ({ ...m, postProcessor: e.target.value }))}>
              {PLASMA_PP_LIST.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div style={{ ...S.desc, marginLeft: 192 }}>{pp.description}</div>
          <div style={S.grid}>
            {pp.settingsSpec.filter(spec => !spec.showIf || spec.showIf(settings)).map(spec => (
              <React.Fragment key={spec.key}>
                <span style={S.label}>{spec.label}</span>
                <Field spec={spec} value={settings[spec.key]} onChange={v => set(spec.key, v)} isInch={isInch} />
              </React.Fragment>
            ))}
          </div>
          {pp.id === 'commandCnc' && (
            <div style={{ ...S.desc, marginTop: 12 }}>
              Amps, arc volts, pierce delay and pierce/cut heights come from each material in ⚡ Materials.
            </div>
          )}
        </div>
        <div style={S.btnRow}>
          <button style={{ ...S.btn, ...S.secondary }} onClick={onClose}>Cancel</button>
          <button style={{ ...S.btn, ...S.primary }} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
