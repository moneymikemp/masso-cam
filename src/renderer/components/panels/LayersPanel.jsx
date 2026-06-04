import React from 'react';
import { useApp } from '../../store/AppContext';

const S = {
  panel: { height: '100%', display: 'flex', flexDirection: 'column', background: '#13132a', color: '#ccc' },
  header: { padding: '8px 10px', borderBottom: '1px solid #2a2a50', fontSize: 12, fontWeight: 600, color: '#8888bb', textTransform: 'uppercase', letterSpacing: 1 },
  list: { flex: 1, overflow: 'auto' },
  row: { padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' },
  swatch: (color) => ({ width: 12, height: 12, borderRadius: 2, background: color, flexShrink: 0, border: '1px solid rgba(255,255,255,0.2)' }),
  name: { flex: 1, fontSize: 11, color: '#ccccdd' },
  count: { fontSize: 10, color: '#555577' },
  eyeBtn: { background: 'none', border: 'none', cursor: 'pointer', color: '#666688', fontSize: 12, padding: '1px 2px' },
  empty: { padding: 16, color: '#444466', fontSize: 11, textAlign: 'center' },
};

export default function LayersPanel() {
  const { state, dispatch } = useApp();
  const { layers, entities } = state;

  const layerList = Object.values(layers);

  function toggleLayer(name) {
    dispatch({ type: 'TOGGLE_LAYER', payload: name });
  }

  function selectByLayer(name) {
    const ids = entities.filter(e => e.layer === name).map(e => e.id);
    dispatch({ type: 'SELECT_ENTITIES', payload: ids });
  }

  return (
    <div style={S.panel}>
      <div style={S.header}>Layers</div>
      <div style={S.list}>
        {layerList.length === 0 && <div style={S.empty}>No layers loaded</div>}
        {layerList.map(layer => (
          <div key={layer.name} style={{ ...S.row, opacity: layer.visible ? 1 : 0.4 }}>
            <button style={S.eyeBtn} onClick={() => toggleLayer(layer.name)} title={layer.visible ? 'Hide' : 'Show'}>
              {layer.visible ? '👁' : '○'}
            </button>
            <div style={S.swatch(layer.color)} />
            <span style={S.name} onClick={() => selectByLayer(layer.name)} title="Click to select all on this layer">
              {layer.name}
            </span>
            <span style={S.count}>{layer.entityCount}</span>
          </div>
        ))}
      </div>
      {layerList.length > 0 && (
        <div style={{ padding: '6px 10px', borderTop: '1px solid #2a2a50', fontSize: 10, color: '#555577' }}>
          Click layer name to select all entities
        </div>
      )}
    </div>
  );
}
