import React from 'react';

const S = {
  form: { padding: '6px 8px', fontSize: 11 },
  row: { display: 'flex', alignItems: 'center', marginBottom: 5, gap: 4 },
  label: { color: '#8888aa', width: 120, flexShrink: 0, fontSize: 10 },
  input: { flex: 1, background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '2px 5px', fontSize: 11, minWidth: 0 },
  select: { flex: 1, background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '2px 4px', fontSize: 11 },
  check: { marginRight: 4 },
  section: { color: '#5555aa', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, marginTop: 8, marginBottom: 3, borderBottom: '1px solid #1a1a38', paddingBottom: 2 },
  unit: { color: '#555577', fontSize: 10, flexShrink: 0 },
};

function Field({ label, unit, children }) {
  return (
    <div style={S.row}>
      <span style={S.label}>{label}</span>
      {children}
      {unit && <span style={S.unit}>{unit}</span>}
    </div>
  );
}

function NumInput({ value, onChange, min, max, step = 0.1 }) {
  return (
    <input
      type="number"
      style={S.input}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={e => onChange(parseFloat(e.target.value) || 0)}
    />
  );
}

function Sel({ value, onChange, options }) {
  return (
    <select style={S.select} value={value} onChange={e => onChange(e.target.value)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function CheckField({ label, value, onChange }) {
  return (
    <div style={S.row}>
      <span style={S.label}>{label}</span>
      <input type="checkbox" style={S.check} checked={value} onChange={e => onChange(e.target.checked)} />
    </div>
  );
}

export default function OperationParams({ op, tools, onChange }) {
  const p = op.params || {};

  function set(key, val) {
    onChange({ params: { ...p, [key]: val } });
  }

  function setName(name) {
    onChange({ name });
  }

  const commonDepth = (
    <>
      <div style={S.section}>Depth</div>
      <Field label="Total Depth" unit="mm"><NumInput value={p.totalDepth || 10} onChange={v => set('totalDepth', v)} min={0.1} /></Field>
      <Field label="Top of Stock" unit="mm"><NumInput value={p.topZ ?? 0} onChange={v => set('topZ', v)} step={0.5} /></Field>
      <Field label="Depth/Pass" unit="mm"><NumInput value={p.depthPerPass || 3} onChange={v => set('depthPerPass', v)} min={0.01} /></Field>
    </>
  );

  const commonSpeeds = (
    <>
      <div style={S.section}>Feeds & Speeds</div>
      <Field label="Spindle RPM" unit="rpm"><NumInput value={p.spindleRpm || 18000} onChange={v => set('spindleRpm', v)} step={100} min={100} /></Field>
      <Field label="Feed Rate" unit="mm/min"><NumInput value={p.feedRate || 1500} onChange={v => set('feedRate', v)} step={50} min={1} /></Field>
      <Field label="Plunge Rate" unit="mm/min"><NumInput value={p.plungeRate || 500} onChange={v => set('plungeRate', v)} step={25} min={1} /></Field>
      <Field label="Safe Z" unit="mm"><NumInput value={p.safeZ || 25} onChange={v => set('safeZ', v)} step={1} /></Field>
    </>
  );

  const toolSelect = (
    <>
      <div style={S.section}>Tool</div>
      <Field label="Tool">
        <select style={S.select} value={op.toolId || ''} onChange={e => onChange({ toolId: e.target.value || null })}>
          <option value="">Manual diameter...</option>
          {tools.map(t => <option key={t.id} value={t.id}>{t.name} (⌀{t.diameter}mm)</option>)}
        </select>
      </Field>
      {!op.toolId && (
        <Field label="Tool Diameter" unit="mm">
          <NumInput value={p.toolDiameter || 6.35} onChange={v => set('toolDiameter', v)} min={0.1} step={0.01} />
        </Field>
      )}
    </>
  );

  return (
    <div style={S.form}>
      <Field label="Name">
        <input style={S.input} type="text" value={op.name} onChange={e => setName(e.target.value)} />
      </Field>

      {/* ── Contour ── */}
      {op.type === 'contour' && <>
        {toolSelect}
        <div style={S.section}>Compensation</div>
        <Field label="Side">
          <Sel value={p.compensation || 'left'} onChange={v => set('compensation', v)} options={[['left','Left (outside CW)'],['right','Right (inside CW)'],['center','On line']]} />
        </Field>
        <Field label="Stock to Leave" unit="mm"><NumInput value={p.stockToLeave || 0} onChange={v => set('stockToLeave', v)} step={0.05} /></Field>
        {commonDepth}
        <div style={S.section}>Entry</div>
        <CheckField label="Ramp Entry" value={p.rampEntry} onChange={v => set('rampEntry', v)} />
        {p.rampEntry && <Field label="Ramp Angle" unit="°"><NumInput value={p.rampAngle || 3} onChange={v => set('rampAngle', v)} min={0.5} max={30} /></Field>}
        <div style={S.section}>Tabs</div>
        <CheckField label="Hold-down Tabs" value={p.tabs} onChange={v => set('tabs', v)} />
        {p.tabs && <>
          <Field label="Tab Count"><NumInput value={p.tabCount || 4} onChange={v => set('tabCount', v)} step={1} min={2} /></Field>
          <Field label="Tab Width" unit="mm"><NumInput value={p.tabWidth || 6} onChange={v => set('tabWidth', v)} min={1} /></Field>
          <Field label="Tab Height" unit="mm"><NumInput value={p.tabHeight || 3} onChange={v => set('tabHeight', v)} min={0.5} /></Field>
        </>}
        <div style={S.section}>Finish</div>
        <CheckField label="Finish Pass" value={p.finishPass} onChange={v => set('finishPass', v)} />
        {commonSpeeds}
      </>}

      {/* ── Pocket ── */}
      {op.type === 'pocket' && <>
        {toolSelect}
        <div style={S.section}>Clearing</div>
        <Field label="Stepover %"><NumInput value={Math.round((p.stepover || 0.45) * 100)} onChange={v => set('stepover', v / 100)} step={5} min={5} max={95} /></Field>
        <CheckField label="Start from Center" value={p.startFromCenter} onChange={v => set('startFromCenter', v)} />
        {commonDepth}
        <div style={S.section}>Finish</div>
        <CheckField label="Finish Pass" value={p.finishPass} onChange={v => set('finishPass', v)} />
        {p.finishPass && <Field label="Finish Allowance" unit="mm"><NumInput value={p.finishAllowance || 0.2} onChange={v => set('finishAllowance', v)} step={0.05} /></Field>}
        {commonSpeeds}
      </>}

      {/* ── Adaptive ── */}
      {op.type === 'adaptive' && <>
        {toolSelect}
        <div style={S.section}>Clearing</div>
        <Field label="Stepover %"><NumInput value={Math.round((p.stepover || 0.35) * 100)} onChange={v => set('stepover', v / 100)} step={5} min={5} max={60} /></Field>
        <Field label="Optimal Load %"><NumInput value={Math.round((p.optimalLoad || 0.3) * 100)} onChange={v => set('optimalLoad', v / 100)} step={5} min={5} max={50} /></Field>
        {commonDepth}
        <div style={S.section}>Entry</div>
        <Field label="Ramp Angle" unit="°"><NumInput value={p.rampAngle || 2} onChange={v => set('rampAngle', v)} min={0.5} max={15} /></Field>
        {commonSpeeds}
      </>}

      {/* ── Face ── */}
      {op.type === 'face' && <>
        {toolSelect}
        <div style={S.section}>Pass</div>
        <Field label="Stepover %"><NumInput value={Math.round((p.stepover || 0.75) * 100)} onChange={v => set('stepover', v / 100)} step={5} min={10} max={95} /></Field>
        <Field label="Angle" unit="°"><NumInput value={p.angle || 0} onChange={v => set('angle', v)} step={5} /></Field>
        <Field label="Stock Top" unit="mm"><NumInput value={p.topZ ?? 0} onChange={v => set('topZ', v)} step={0.5} /></Field>
        <Field label="Total Depth" unit="mm"><NumInput value={p.totalDepth || 3} onChange={v => set('totalDepth', v)} min={0.1} /></Field>
        <Field label="Depth/Pass" unit="mm"><NumInput value={p.depthPerPass || 1} onChange={v => set('depthPerPass', v)} min={0.1} /></Field>
        <div style={S.section}>Extension</div>
        <Field label="X+/-" unit="mm"><NumInput value={p.stockLeft || 2} onChange={v => set('stockLeft', v)} /></Field>
        <Field label="Y+/-" unit="mm"><NumInput value={p.stockFront || 2} onChange={v => set('stockFront', v)} /></Field>
        {commonSpeeds}
      </>}

      {/* ── Drill ── */}
      {op.type === 'drill' && <>
        <div style={S.section}>Depth</div>
        <Field label="Total Depth" unit="mm"><NumInput value={p.totalDepth || 20} onChange={v => set('totalDepth', v)} /></Field>
        <Field label="Top of Stock" unit="mm"><NumInput value={p.topZ ?? 0} onChange={v => set('topZ', v)} step={0.5} /></Field>
        <Field label="Safe Z" unit="mm"><NumInput value={p.safeZ || 25} onChange={v => set('safeZ', v)} /></Field>
        <div style={S.section}>Peck</div>
        <Field label="Peck Depth" unit="mm"><NumInput value={p.peckDepth || 0} onChange={v => set('peckDepth', v)} /></Field>
        <CheckField label="Chip Break Only" value={p.chipBreak} onChange={v => set('chipBreak', v)} />
        <div style={S.section}>Feeds & Speeds</div>
        <Field label="Spindle RPM" unit="rpm"><NumInput value={p.spindleRpm || 3000} onChange={v => set('spindleRpm', v)} step={100} /></Field>
        <Field label="Drill Rate" unit="mm/min"><NumInput value={p.feedRate || 300} onChange={v => set('feedRate', v)} step={25} /></Field>
        <Field label="Dwell (bottom)" unit="s"><NumInput value={p.dwellTime || 0} onChange={v => set('dwellTime', v)} step={0.1} /></Field>
      </>}

      {/* ── Bore ── */}
      {op.type === 'bore' && <>
        {toolSelect}
        <div style={S.section}>Bore</div>
        <Field label="Total Depth" unit="mm"><NumInput value={p.totalDepth || 20} onChange={v => set('totalDepth', v)} /></Field>
        <Field label="Top of Stock" unit="mm"><NumInput value={p.topZ ?? 0} onChange={v => set('topZ', v)} /></Field>
        <Field label="Helix Pitch" unit="mm"><NumInput value={p.helicalPitch || 1.5} onChange={v => set('helicalPitch', v)} step={0.25} min={0.1} /></Field>
        <Field label="Direction"><Sel value={p.direction || 'climb'} onChange={v => set('direction', v)} options={[['climb','Climb (CCW)'],['conventional','Conventional (CW)']]} /></Field>
        {commonSpeeds}
      </>}

      {/* ── Circular ── */}
      {op.type === 'circular' && <>
        {toolSelect}
        <Field label="Stepover %"><NumInput value={Math.round((p.stepover || 0.4) * 100)} onChange={v => set('stepover', v / 100)} step={5} /></Field>
        <CheckField label="Helical Entry" value={p.helicalEntry} onChange={v => set('helicalEntry', v)} />
        {commonDepth}
        {commonSpeeds}
      </>}

      {/* ── Engrave / Trace ── */}
      {(op.type === 'engrave' || op.type === 'trace') && <>
        <div style={S.section}>Depth</div>
        <Field label="Depth" unit="mm"><NumInput value={p.depth || 1.5} onChange={v => set('depth', v)} step={0.1} min={0.01} /></Field>
        <Field label="Top of Stock" unit="mm"><NumInput value={p.topZ ?? 0} onChange={v => set('topZ', v)} /></Field>
        <Field label="Safe Z" unit="mm"><NumInput value={p.safeZ || 25} onChange={v => set('safeZ', v)} /></Field>
        <div style={S.section}>Feeds & Speeds</div>
        <Field label="Spindle RPM" unit="rpm"><NumInput value={p.spindleRpm || 18000} onChange={v => set('spindleRpm', v)} step={100} /></Field>
        <Field label="Feed Rate" unit="mm/min"><NumInput value={p.feedRate || 800} onChange={v => set('feedRate', v)} step={50} /></Field>
        <Field label="Plunge Rate" unit="mm/min"><NumInput value={p.plungeRate || 300} onChange={v => set('plungeRate', v)} step={25} /></Field>
      </>}

      {/* ── Slot ── */}
      {op.type === 'slot' && <>
        {toolSelect}
        <CheckField label="Ramp Entry" value={p.rampEntry} onChange={v => set('rampEntry', v)} />
        {p.rampEntry && <Field label="Ramp Angle" unit="°"><NumInput value={p.rampAngle || 3} onChange={v => set('rampAngle', v)} min={0.5} max={30} /></Field>}
        {commonDepth}
        {commonSpeeds}
      </>}

      {/* ── Chamfer ── */}
      {op.type === 'chamfer' && <>
        {toolSelect}
        <div style={S.section}>Chamfer</div>
        <Field label="Chamfer Angle" unit="°"><NumInput value={p.chamferAngle || 45} onChange={v => set('chamferAngle', v)} step={5} min={10} max={80} /></Field>
        <Field label="Chamfer Width" unit="mm"><NumInput value={p.chamferWidth || 1.0} onChange={v => set('chamferWidth', v)} step={0.1} min={0.1} /></Field>
        <Field label="Top Z" unit="mm"><NumInput value={p.topZ ?? 0} onChange={v => set('topZ', v)} /></Field>
        <Field label="Safe Z" unit="mm"><NumInput value={p.safeZ || 25} onChange={v => set('safeZ', v)} /></Field>
        {commonSpeeds}
      </>}

      {/* ── Thread ── */}
      {op.type === 'thread' && <>
        {toolSelect}
        <div style={S.section}>Thread</div>
        <Field label="Thread Pitch" unit="mm"><NumInput value={p.pitch || 1.25} onChange={v => set('pitch', v)} step={0.25} min={0.1} /></Field>
        <Field label="Total Depth" unit="mm"><NumInput value={p.totalDepth || 15} onChange={v => set('totalDepth', v)} /></Field>
        <Field label="Top Z" unit="mm"><NumInput value={p.topZ ?? 0} onChange={v => set('topZ', v)} /></Field>
        <Field label="Direction">
          <Sel value={p.direction || 'right'} onChange={v => set('direction', v)} options={[['right','Right-hand'],['left','Left-hand']]} />
        </Field>
        <Field label="Type">
          <Sel value={p.internal ? 'internal' : 'external'} onChange={v => set('internal', v === 'internal')} options={[['internal','Internal'],['external','External']]} />
        </Field>
        <div style={S.section}>Feeds & Speeds</div>
        <Field label="Spindle RPM" unit="rpm"><NumInput value={p.spindleRpm || 1000} onChange={v => set('spindleRpm', v)} step={100} /></Field>
        <Field label="Feed Rate" unit="mm/min"><NumInput value={p.feedRate || 400} onChange={v => set('feedRate', v)} step={25} /></Field>
        <Field label="Safe Z" unit="mm"><NumInput value={p.safeZ || 25} onChange={v => set('safeZ', v)} /></Field>
      </>}
    </div>
  );
}
