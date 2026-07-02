import React, { useState, useEffect } from 'react';
import { useApp } from '../../store/AppContext';
import { loadFontFromArrayBuffer, textToArcPolylines } from '../../cam/textEngine';

const MM = 25.4;

const S = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  box:     { background: '#1a1a38', border: '1px solid #3a3a70', borderRadius: 8, width: 420, padding: '20px 24px', color: '#ccc', fontFamily: 'system-ui,sans-serif' },
  title:   { fontSize: 14, fontWeight: 700, color: '#aaaaff', marginBottom: 16 },
  sec:     { fontSize: 10, color: '#5555aa', textTransform: 'uppercase', letterSpacing: 1, marginTop: 12, marginBottom: 5, borderBottom: '1px solid #1a1a38', paddingBottom: 3 },
  label:   { fontSize: 10, color: '#555577', marginBottom: 3 },
  input:   { width: '100%', boxSizing: 'border-box', background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '4px 7px', fontSize: 11 },
  select:  { width: '100%', background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '4px 5px', fontSize: 11 },
  grid3:   { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 },
  info:    { fontSize: 10, color: '#444466', background: '#0d0d20', border: '1px solid #1a1a40', borderRadius: 4, padding: '6px 10px', marginTop: 10 },
  btnRow:  { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 },
  btn:     { padding: '7px 18px', borderRadius: 4, cursor: 'pointer', fontSize: 12, border: 'none', fontWeight: 600 },
};

export default function CadTextPanel() {
  const { state, dispatch } = useApp();
  const isInch = state.postConfig?.units === 'inch';
  const dUnit = isInch ? 'in' : 'mm';
  const dStep = isInch ? 0.01 : 0.25;

  const [text, setText]           = useState('');
  const [fontList, setFontList]   = useState([]);
  const [fontPath, setFontPath]   = useState('');
  const [capHeight, setCapHeight] = useState(isInch ? 0.5 : 12.7);
  const [posX, setPosX]           = useState(0);
  const [posY, setPosY]           = useState(0);
  const [loadingFonts, setLoadingFonts] = useState(false);
  const [placing, setPlacing]     = useState(false);
  const [result, setResult]       = useState(null); // { count } after placement

  useEffect(() => {
    setLoadingFonts(true);
    window.electron?.listSystemFonts?.()
      .then(fonts => setFontList(fonts || []))
      .catch(() => {})
      .finally(() => setLoadingFonts(false));
  }, []);

  function close() {
    dispatch({ type: 'SET_ACTIVE_TOOL', payload: 'select' });
  }

  async function handlePlace() {
    if (!fontPath || !text.trim()) return;
    setPlacing(true);
    try {
      const fontBytes = await window.electron.readFontFile(fontPath);
      if (!fontBytes) { setPlacing(false); return; }
      const ab = fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength);
      const font = loadFontFromArrayBuffer(ab);
      const capHeightMm = isInch ? capHeight * MM : capHeight;
      const oxMm = isInch ? posX * MM : posX;
      const oyMm = isInch ? posY * MM : posY;
      const polylines = textToArcPolylines(font, text.trim(), capHeightMm);
      const now = Date.now();
      const entities = polylines.map((pl, i) => ({
        id: `cadtext-${now}-${i}`,
        type: 'polyline',
        vertices: pl.vertices.map(v => ({ x: v.x + oxMm, y: v.y + oyMm, bulge: v.bulge ?? 0 })),
        closed: pl.closed,
      }));
      dispatch({ type: 'ADD_ENTITIES', payload: entities });
      setResult({ count: entities.length });
    } catch (e) {
      console.error('CAD text placement failed:', e);
    }
    setPlacing(false);
  }

  const canPlace = fontPath && text.trim() && !placing;

  return (
    <div style={S.overlay}>
      <div style={S.box}>
        <div style={S.title}>Add Text</div>

        <div style={S.sec}>Text</div>
        <textarea
          style={{ ...S.input, resize: 'vertical', minHeight: 52, fontFamily: 'monospace', lineHeight: 1.4 }}
          value={text}
          onChange={e => { setText(e.target.value); setResult(null); }}
          placeholder="Enter text (Enter for new line)…"
          rows={2}
          autoFocus
        />

        <div style={S.sec}>Font</div>
        {loadingFonts
          ? <span style={{ color: '#555577', fontSize: 10 }}>Loading fonts…</span>
          : <select style={S.select} value={fontPath}
              onChange={e => { setFontPath(e.target.value); setResult(null); }}>
              <option value="">Select a font…</option>
              {fontList.map(f => <option key={f.path} value={f.path}>{f.family}</option>)}
            </select>
        }

        <div style={S.grid3}>
          <div>
            <div style={S.label}>Cap Height ({dUnit})</div>
            <input type="number" style={S.input} value={capHeight} step={dStep} min={dStep}
              onChange={e => { setCapHeight(parseFloat(e.target.value) || 0); setResult(null); }} />
          </div>
          <div>
            <div style={S.label}>Position X ({dUnit})</div>
            <input type="number" style={S.input} value={posX} step={dStep}
              onChange={e => setPosX(parseFloat(e.target.value) || 0)} />
          </div>
          <div>
            <div style={S.label}>Position Y ({dUnit})</div>
            <input type="number" style={S.input} value={posY} step={dStep}
              onChange={e => setPosY(parseFloat(e.target.value) || 0)} />
          </div>
        </div>

        {result
          ? <div style={{ ...S.info, color: '#44cc88', borderColor: '#1a3a1a', background: '#081408', marginTop: 10 }}>
              ✓ Placed {result.count} contour{result.count !== 1 ? 's' : ''} — use the Select tool to move or scale
            </div>
          : <div style={S.info}>
              Curves are fitted as circular arcs (G2/G3) for smooth CNC motion.
              Use Select tool to reposition after placing.
            </div>
        }

        <div style={S.btnRow}>
          <button style={{ ...S.btn, background: '#22224a', color: '#9999cc', border: '1px solid #3a3a60' }}
            onClick={close}>
            {result ? 'Done' : 'Cancel'}
          </button>
          <button
            disabled={!canPlace}
            style={{ ...S.btn, background: canPlace ? '#3a3aaa' : '#1a1a3a', color: canPlace ? '#fff' : '#555577', cursor: canPlace ? 'pointer' : 'default' }}
            onClick={handlePlace}>
            {placing ? 'Placing…' : result ? 'Place Again' : 'Place Text'}
          </button>
        </div>
      </div>
    </div>
  );
}
