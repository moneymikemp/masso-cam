import React, { useState } from 'react';
import { useApp } from '../../store/AppContext';

const MM_PER_INCH = 25.4;

const S = {
  wrap: { flex: 1, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 6 },
  empty: { padding: 16, color: '#555577', fontSize: 11, lineHeight: 1.6 },
  entityType: { fontSize: 10, fontWeight: 700, color: '#7777ff', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
  grid: { display: 'grid', gridTemplateColumns: '90px 1fr', gap: '4px 8px', alignItems: 'center' },
  label: { fontSize: 10, color: '#7788aa', textAlign: 'right', paddingRight: 4 },
  input: { background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '3px 6px', fontSize: 11, width: '100%', fontFamily: 'monospace', boxSizing: 'border-box' },
  readOnly: { background: 'transparent', border: '1px solid #1a1a30', color: '#6677aa', borderRadius: 3, padding: '3px 6px', fontSize: 11, width: '100%', fontFamily: 'monospace', boxSizing: 'border-box' },
  section: { fontSize: 9, color: '#4455aa', textTransform: 'uppercase', letterSpacing: 1, gridColumn: '1/-1', marginTop: 6, paddingTop: 4, borderTop: '1px solid #1a1a38' },
  multiInfo: { fontSize: 11, color: '#888899', lineHeight: 1.8, padding: 4 },
};

function NumField({ label, value, readOnly, onChange, unit }) {
  const [local, setLocal] = useState('');
  const [focused, setFocused] = useState(false);
  const displayVal = focused ? local : (typeof value === 'number' ? value : '');

  if (readOnly) {
    return (
      <>
        <span style={S.label}>{label}</span>
        <input style={S.readOnly} readOnly value={typeof value === 'number' ? value.toFixed(3) + (unit ? ` ${unit}` : '') : value} />
      </>
    );
  }

  return (
    <>
      <span style={S.label}>{label}</span>
      <input
        style={S.input}
        type="text"
        value={displayVal}
        onChange={e => setLocal(e.target.value)}
        onFocus={() => { setLocal(typeof value === 'number' ? String(value) : ''); setFocused(true); }}
        onBlur={() => {
          setFocused(false);
          const v = parseFloat(local);
          if (!isNaN(v)) onChange(v);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') { const v = parseFloat(local); if (!isNaN(v)) onChange(v); e.target.blur(); }
        }}
      />
    </>
  );
}

export default function CADPropertiesPanel() {
  const { state, dispatch } = useApp();
  const { entities, selectedEntityIds, postConfig } = state;
  const isInch = postConfig?.units === 'inch';
  const toDisp = v => isInch ? +(v / MM_PER_INCH).toFixed(4) : +v.toFixed(3);
  const toMM = v => isInch ? v * MM_PER_INCH : v;
  const unit = isInch ? 'in' : 'mm';

  const sel = entities.filter(e => selectedEntityIds.includes(e.id));

  function update(e, changes) {
    dispatch({ type: 'TRANSFORM_ENTITIES', payload: [{ ...e, ...changes }] });
  }

  if (sel.length === 0) {
    return <div style={S.empty}>No entity selected.<br />Use the Select tool (▲) and click an entity to view and edit its properties.</div>;
  }

  if (sel.length > 1) {
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    const types = new Set(sel.map(e => e.type));
    return (
      <div style={S.wrap}>
        <div style={S.entityType}>{sel.length} Entities Selected</div>
        <div style={S.multiInfo}>
          Types: {[...types].join(', ')}<br />
          Use individual selection to edit properties.
        </div>
      </div>
    );
  }

  const e = sel[0];

  switch (e.type) {
    case 'line': {
      const len = Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y);
      const angle = Math.atan2(e.end.y - e.start.y, e.end.x - e.start.x) * 180 / Math.PI;
      return (
        <div style={S.wrap}>
          <div style={S.entityType}>Line</div>
          <div style={S.grid}>
            <span style={{ ...S.section }}>Start Point</span>
            <NumField label={`Start X (${unit})`} value={toDisp(e.start.x)} onChange={v => update(e, { start: { ...e.start, x: toMM(v) } })} />
            <NumField label={`Start Y (${unit})`} value={toDisp(e.start.y)} onChange={v => update(e, { start: { ...e.start, y: toMM(v) } })} />
            <span style={{ ...S.section }}>End Point</span>
            <NumField label={`End X (${unit})`} value={toDisp(e.end.x)} onChange={v => update(e, { end: { ...e.end, x: toMM(v) } })} />
            <NumField label={`End Y (${unit})`} value={toDisp(e.end.y)} onChange={v => update(e, { end: { ...e.end, y: toMM(v) } })} />
            <span style={{ ...S.section }}>Computed</span>
            <NumField label={`Length (${unit})`} value={toDisp(len)} readOnly />
            <NumField label="Angle (°)" value={+angle.toFixed(2)} readOnly />
          </div>
        </div>
      );
    }
    case 'circle': {
      return (
        <div style={S.wrap}>
          <div style={S.entityType}>Circle</div>
          <div style={S.grid}>
            <span style={{ ...S.section }}>Center</span>
            <NumField label={`Center X (${unit})`} value={toDisp(e.center.x)} onChange={v => update(e, { center: { ...e.center, x: toMM(v) } })} />
            <NumField label={`Center Y (${unit})`} value={toDisp(e.center.y)} onChange={v => update(e, { center: { ...e.center, y: toMM(v) } })} />
            <span style={{ ...S.section }}>Size</span>
            <NumField label={`Radius (${unit})`} value={toDisp(e.radius)} onChange={v => update(e, { radius: toMM(v) })} />
            <NumField label={`Diameter (${unit})`} value={toDisp(e.radius * 2)} onChange={v => update(e, { radius: toMM(v) / 2 })} />
          </div>
        </div>
      );
    }
    case 'arc': {
      const startDeg = e.startAngle * 180 / Math.PI;
      const endDeg   = e.endAngle   * 180 / Math.PI;
      let span = e.endAngle - e.startAngle;
      while (span < 0) span += Math.PI * 2;
      return (
        <div style={S.wrap}>
          <div style={S.entityType}>Arc</div>
          <div style={S.grid}>
            <span style={{ ...S.section }}>Center</span>
            <NumField label={`Center X (${unit})`} value={toDisp(e.center.x)} onChange={v => update(e, { center: { ...e.center, x: toMM(v) } })} />
            <NumField label={`Center Y (${unit})`} value={toDisp(e.center.y)} onChange={v => update(e, { center: { ...e.center, y: toMM(v) } })} />
            <span style={{ ...S.section }}>Size</span>
            <NumField label={`Radius (${unit})`} value={toDisp(e.radius)} onChange={v => update(e, { radius: toMM(v) })} />
            <span style={{ ...S.section }}>Angles</span>
            <NumField label="Start (°)" value={+startDeg.toFixed(2)} onChange={v => update(e, { startAngle: v * Math.PI / 180 })} />
            <NumField label="End (°)" value={+endDeg.toFixed(2)} onChange={v => update(e, { endAngle: v * Math.PI / 180 })} />
            <NumField label="Span (°)" value={+(span * 180 / Math.PI).toFixed(2)} readOnly />
          </div>
        </div>
      );
    }
    case 'polyline': {
      const verts = e.vertices || [];
      return (
        <div style={S.wrap}>
          <div style={S.entityType}>Polyline</div>
          <div style={S.grid}>
            <span style={{ ...S.section }}>Info</span>
            <NumField label="Vertices" value={verts.length} readOnly />
            <span style={S.label}>Closed</span>
            <input
              type="checkbox"
              checked={!!e.closed}
              onChange={ev => update(e, { closed: ev.target.checked })}
              style={{ width: 16, height: 16 }}
            />
          </div>
          {verts.slice(0, 8).map((v, i) => (
            <div key={i} style={S.grid}>
              <span style={{ ...S.section }}>Vertex {i+1}</span>
              <NumField label={`X (${unit})`} value={toDisp(v.x)} onChange={val => {
                const newVerts = [...verts]; newVerts[i] = { ...v, x: toMM(val) };
                update(e, { vertices: newVerts });
              }} />
              <NumField label={`Y (${unit})`} value={toDisp(v.y)} onChange={val => {
                const newVerts = [...verts]; newVerts[i] = { ...v, y: toMM(val) };
                update(e, { vertices: newVerts });
              }} />
            </div>
          ))}
          {verts.length > 8 && <div style={{ fontSize: 10, color: '#555577', textAlign: 'center' }}>…{verts.length - 8} more vertices</div>}
        </div>
      );
    }
    default:
      return <div style={S.empty}>Unsupported entity type: {e.type}</div>;
  }
}
