import React, { useState, useEffect } from 'react';
import { v4 as uuid } from 'uuid';
import { translateEntity, rotateEntityAround, selectionBoundingBox } from '../../cam/offsetEngine';

const MM_PER_INCH = 25.4;

const S = {
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' },
  box: { background:'#1a1a38', border:'1px solid #3a3a70', borderRadius:8, padding:'20px 24px', minWidth:380, color:'#ccc', fontFamily:'system-ui,sans-serif' },
  title: { fontSize:14, fontWeight:700, color:'#aaaaff', marginBottom:12 },
  tabs: { display:'flex', gap:2, marginBottom:14, borderBottom:'1px solid #2a2a50' },
  tab: active => ({ padding:'5px 14px', fontSize:11, cursor:'pointer', color: active ? '#aaaaff' : '#555577', background: active ? '#1a1a38' : 'transparent', borderBottom: active ? '2px solid #5555cc' : '2px solid transparent', fontWeight: active ? 600 : 400 }),
  grid: { display:'grid', gridTemplateColumns:'120px 1fr', gap:'6px 10px', alignItems:'center', marginBottom:10 },
  label: { fontSize:11, color:'#8888aa', textAlign:'right' },
  input: { background:'#0d0d20', border:'1px solid #2a2a50', color:'#ccccee', borderRadius:4, padding:'4px 8px', fontSize:12, width:'100%', boxSizing:'border-box' },
  preview: { fontSize:10, color:'#555588', background:'#0d0d22', border:'1px solid #1a1a40', borderRadius:4, padding:'6px 10px', marginBottom:10 },
  btnRow: { display:'flex', justifyContent:'flex-end', gap:8, marginTop:14 },
  btn: { padding:'6px 16px', borderRadius:4, cursor:'pointer', fontSize:12, border:'none' },
  btnPrimary: { background:'#3a3aaa', color:'#fff' },
  btnSecondary: { background:'#2a2a4a', color:'#aaa', border:'1px solid #3a3a60' },
};

export default function ArrayModal({ selectedEntityIds, entities, isInch, onClose, dispatch }) {
  const [tab, setTab] = useState('rect');

  // Rect params
  const [cols, setCols] = useState(3);
  const [rows, setRows] = useState(3);
  const [xSp, setXSp] = useState(50);
  const [ySp, setYSp] = useState(50);

  // Circular params
  const [count, setCount] = useState(6);
  const [cx, setCx] = useState(0);
  const [cy, setCy] = useState(0);
  const [startAngle, setStartAngle] = useState(0);

  const toDisp = v => isInch ? +(v / MM_PER_INCH).toFixed(4) : +v.toFixed(2);
  const toMM = v => isInch ? v * MM_PER_INCH : v;
  const unit = isInch ? 'in' : 'mm';

  const sel = entities.filter(e => selectedEntityIds.includes(e.id));

  // Auto-set circular center from bounding box centroid
  useEffect(() => {
    const bb = selectionBoundingBox(entities, selectedEntityIds);
    if (bb) {
      setCx(+(toDisp((bb.minX + bb.maxX) / 2)));
      setCy(+(toDisp((bb.minY + bb.maxY) / 2)));
    }
  }, []);

  // Compute and dispatch preview entities
  useEffect(() => {
    const preview = tab === 'rect' ? computeRect() : computeCircular();
    dispatch({ type: 'SET_PREVIEW_ENTITIES', payload: preview });
    return () => dispatch({ type: 'SET_PREVIEW_ENTITIES', payload: [] });
  }, [tab, cols, rows, xSp, ySp, count, cx, cy, startAngle]);

  function computeRect() {
    const xSpMM = toMM(xSp), ySpMM = toMM(ySp);
    const result = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === 0 && c === 0) continue;
        for (const e of sel) {
          result.push({ ...translateEntity(e, c * xSpMM, r * ySpMM), id: uuid() });
        }
      }
    }
    return result;
  }

  function computeCircular() {
    if (count < 2) return [];
    const cxMM = toMM(cx), cyMM = toMM(cy);
    const step = (2 * Math.PI) / count;
    const startRad = startAngle * Math.PI / 180;
    const result = [];
    for (let i = 1; i < count; i++) {
      const angle = startRad + i * step;
      for (const e of sel) {
        result.push({ ...rotateEntityAround(e, cxMM, cyMM, angle), id: uuid() });
      }
    }
    return result;
  }

  function commit() {
    const newEntities = tab === 'rect' ? computeRect() : computeCircular();
    if (newEntities.length > 0) dispatch({ type: 'ADD_ENTITIES', payload: newEntities });
    dispatch({ type: 'SET_PREVIEW_ENTITIES', payload: [] });
    onClose();
  }

  const previewCount = tab === 'rect' ? (cols * rows - 1) * sel.length : (count - 1) * sel.length;

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.box} onClick={e => e.stopPropagation()}>
        <div style={S.title}>Array</div>
        <div style={S.tabs}>
          <div style={S.tab(tab === 'rect')}     onClick={() => setTab('rect')}>Rectangular</div>
          <div style={S.tab(tab === 'circular')} onClick={() => setTab('circular')}>Circular</div>
        </div>

        {tab === 'rect' && (
          <div style={S.grid}>
            <span style={S.label}>Columns</span>
            <input style={S.input} type="number" min={1} max={50} value={cols} onChange={e => setCols(Math.max(1,+e.target.value))} />
            <span style={S.label}>Rows</span>
            <input style={S.input} type="number" min={1} max={50} value={rows} onChange={e => setRows(Math.max(1,+e.target.value))} />
            <span style={S.label}>X Spacing ({unit})</span>
            <input style={S.input} type="number" step={isInch?0.01:0.5} value={xSp} onChange={e => setXSp(+e.target.value)} />
            <span style={S.label}>Y Spacing ({unit})</span>
            <input style={S.input} type="number" step={isInch?0.01:0.5} value={ySp} onChange={e => setYSp(+e.target.value)} />
          </div>
        )}

        {tab === 'circular' && (
          <div style={S.grid}>
            <span style={S.label}>Count (total)</span>
            <input style={S.input} type="number" min={2} max={360} value={count} onChange={e => setCount(Math.max(2,+e.target.value))} />
            <span style={S.label}>Center X ({unit})</span>
            <input style={S.input} type="number" step={isInch?0.001:0.1} value={cx} onChange={e => setCx(+e.target.value)} />
            <span style={S.label}>Center Y ({unit})</span>
            <input style={S.input} type="number" step={isInch?0.001:0.1} value={cy} onChange={e => setCy(+e.target.value)} />
            <span style={S.label}>Start Angle (°)</span>
            <input style={S.input} type="number" step={1} value={startAngle} onChange={e => setStartAngle(+e.target.value)} />
          </div>
        )}

        <div style={S.preview}>
          Will create <strong style={{ color: '#aaaaff' }}>{previewCount}</strong> new {previewCount === 1 ? 'entity' : 'entities'} (original{sel.length > 1 ? 's' : ''} kept in place).
          {tab === 'circular' && count >= 2 && <span>  Angular step: {(360/count).toFixed(1)}°</span>}
        </div>

        <div style={S.btnRow}>
          <button style={{ ...S.btn, ...S.btnSecondary }} onClick={() => { dispatch({ type:'SET_PREVIEW_ENTITIES', payload:[] }); onClose(); }}>Cancel</button>
          <button style={{ ...S.btn, ...S.btnPrimary }} onClick={commit} disabled={previewCount === 0}>Create Array</button>
        </div>
      </div>
    </div>
  );
}
