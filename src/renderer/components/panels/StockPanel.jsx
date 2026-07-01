import React, { useMemo } from 'react';
import { useApp } from '../../store/AppContext';
import { getBounds } from '../../dxf/parser';

const MM_PER_INCH = 25.4;

const S = {
  panel: { height: '100%', display: 'flex', flexDirection: 'column', background: '#13132a', color: '#ccc', overflow: 'hidden' },
  header: { padding: '8px 10px', borderBottom: '1px solid #2a2a50', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 },
  headerTitle: { fontSize: 12, fontWeight: 600, color: '#8888bb', textTransform: 'uppercase', letterSpacing: 1 },
  body: { flex: 1, overflow: 'auto', padding: '6px 8px' },
  section: { color: '#5555aa', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, marginTop: 8, marginBottom: 3, borderBottom: '1px solid #1a1a38', paddingBottom: 2 },
  row: { display: 'flex', alignItems: 'center', marginBottom: 5, gap: 4 },
  label: { color: '#8888aa', width: 120, flexShrink: 0, fontSize: 10 },
  input: { flex: 1, background: '#0d0d20', border: '1px solid #2a2a50', color: '#ccccee', borderRadius: 3, padding: '2px 5px', fontSize: 11, minWidth: 0 },
  unit: { color: '#555577', fontSize: 10, flexShrink: 0 },
  datumGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 3, marginTop: 4 },
  datumBtn: (active) => ({
    background: active ? '#3a3a8a' : '#1a1a38',
    border: `1px solid ${active ? '#6666cc' : '#2a2a50'}`,
    color: active ? '#ccccff' : '#555577',
    borderRadius: 3,
    padding: '5px 0',
    cursor: 'pointer',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 1,
  }),
  infoBox: { background: '#0d0d20', border: '1px solid #1a1a38', borderRadius: 3, padding: '6px 8px', marginTop: 8, fontSize: 10, color: '#555577', lineHeight: 1.7 },
  infoVal: { color: '#8888aa' },
  presetBtn: {
    flex: 1, background: '#1a1a38', border: '1px solid #2a2a50',
    color: '#8888cc', borderRadius: 3, padding: '4px 0',
    cursor: 'pointer', fontSize: 10, textAlign: 'center',
  },
  actionBtn: (enabled) => ({
    flex: 1, background: enabled ? '#1a1a3a' : '#111120', border: `1px solid ${enabled ? '#2a2a60' : '#1a1a38'}`,
    color: enabled ? '#8888cc' : '#333355', borderRadius: 3, padding: '5px 0',
    cursor: enabled ? 'pointer' : 'default', fontSize: 10, textAlign: 'center',
  }),
};

// datum[0] = Y axis: 'b'=front/min-Y  'm'=center  't'=back/max-Y
// datum[1] = X axis: 'l'=left/min-X   'c'=center  'r'=right/max-X
const DATUM_GRID = [
  ['tl', 'tc', 'tr'],
  ['ml', 'mc', 'mr'],
  ['bl', 'bc', 'br'],
];
const DATUM_ICONS = {
  tl: '↖', tc: '↑', tr: '↗',
  ml: '←', mc: '⊙', mr: '→',
  bl: '↙', bc: '↓', br: '↘',
};
const DATUM_LABELS = {
  tl: 'Back-Left',  tc: 'Back-Center',  tr: 'Back-Right',
  ml: 'Mid-Left',   mc: 'Center',       mr: 'Mid-Right',
  bl: 'Front-Left', bc: 'Front-Center', br: 'Front-Right',
};

function getXOffset(datum) {
  return datum[1] === 'l' ? 0 : datum[1] === 'c' ? 0.5 : 1;
}
function getYOffset(datum) {
  return datum[0] === 'b' ? 0 : datum[0] === 'm' ? 0.5 : 1;
}

function applyShift(entities, dx, dy) {
  return entities.map(e => {
    switch (e.type) {
      case 'line':
        return { ...e, start: { x: e.start.x + dx, y: e.start.y + dy }, end: { x: e.end.x + dx, y: e.end.y + dy } };
      case 'circle':
        return { ...e, center: { x: e.center.x + dx, y: e.center.y + dy } };
      case 'arc':
        return { ...e, center: { x: e.center.x + dx, y: e.center.y + dy } };
      case 'polyline':
        return { ...e, vertices: e.vertices.map(v => ({ ...v, x: v.x + dx, y: v.y + dy })) };
      default:
        return e;
    }
  });
}

function NumInput({ value, onChange, min, step = 0.1 }) {
  const [text, setText] = React.useState(value == null ? '' : String(value));
  const prevValue = React.useRef(value);

  if (prevValue.current !== value) {
    prevValue.current = value;
    setText(value == null ? '' : String(value));
  }

  return (
    <input
      type="number"
      style={S.input}
      value={text}
      min={min}
      step={step}
      onChange={e => {
        setText(e.target.value);
        const n = parseFloat(e.target.value);
        if (!isNaN(n)) onChange(n);
      }}
      onBlur={() => {
        if (isNaN(parseFloat(text))) setText(value == null ? '' : String(value));
      }}
    />
  );
}

export default function StockPanel() {
  const { state, dispatch } = useApp();
  const { stockConfig, entities, layers, operations, stlBounds } = state;
  const isInch = state.postConfig?.units === 'inch';

  // Compute bounds from DXF entities (for moveToOrigin and DXF-based fitStockToPart).
  const bounds = useMemo(() => entities.length > 0 ? getBounds(entities) : null, [entities]);
  const hasDXF = bounds != null;
  // "Fit Stock to Part" also works when an STL is loaded (uses stored footprint dimensions).
  const hasGeometry = hasDXF || stlBounds != null;

  const set = (key, val) => dispatch({ type: 'SET_STOCK_CONFIG', payload: { [key]: val } });

  function datumXFrac(d) { return d[1] === 'l' ? 0 : d[1] === 'c' ? 0.5 : 1; }
  function datumYFrac(d) { return d[0] === 'b' ? 0 : d[0] === 'm' ? 0.5 : 1; }

  function fitStockToPart() {
    if (!hasGeometry) return;

    let gMinX, gMinY, gMaxX, gMaxY;

    if (hasDXF) {
      // DXF entities: fit stock tightly around their world-space bounds.
      ({ minX: gMinX, minY: gMinY, maxX: gMaxX, maxY: gMaxY } = bounds);
    } else {
      // STL only: the model is centred on the current stock centre.
      // Use the stored Fusion XY footprint, centred on the current stock centre.
      const xFrac = datumXFrac(stockConfig.datum);
      const yFrac = datumYFrac(stockConfig.datum);
      const ox = stockConfig.stockOriginX ?? 0;
      const oy = stockConfig.stockOriginY ?? 0;
      const w  = stockConfig.width  ?? 0;
      const l  = stockConfig.length ?? 0;
      const stockCX = ox - xFrac * w + w / 2;
      const stockCY = oy - yFrac * l + l / 2;
      const halfW = stlBounds.partW / 2;
      const halfH = stlBounds.partH / 2;
      gMinX = stockCX - halfW;  gMaxX = stockCX + halfW;
      gMinY = stockCY - halfH;  gMaxY = stockCY + halfH;
    }

    const gW = gMaxX - gMinX, gH = gMaxY - gMinY;
    if (gW < 1e-6 || gH < 1e-6) return;

    const offset = toMM(stockConfig.stockOffset ?? 0) || gW * 0.05;
    const newW = gW + 2 * offset;
    const newL = gH + 2 * offset;

    // Datum point is at stock lower-left + (xFrac * newW, yFrac * newL).
    const stockOriginX = gMinX - offset + datumXFrac(stockConfig.datum) * newW;
    const stockOriginY = gMinY - offset + datumYFrac(stockConfig.datum) * newL;

    dispatch({ type: 'SET_STOCK_CONFIG', payload: { width: newW, length: newL, stockOriginX, stockOriginY } });
  }

  function moveToOrigin() {
    if (!hasGeometry) return;

    if (!hasDXF) {
      // STL-only: place the stock datum at machine (0, 0) by zeroing stockOriginX/Y.
      // The STL mesh follows via the useEffect in ThreeCanvas.
      dispatch({ type: 'SET_STOCK_CONFIG', payload: { stockOriginX: 0, stockOriginY: 0 } });
      return;
    }

    const { minX: gMinX, minY: gMinY, maxX: gMaxX, maxY: gMaxY } = bounds;
    const gCX = (gMinX + gMaxX) / 2, gCY = (gMinY + gMaxY) / 2;

    // Which point on the geometry should land at machine (0, 0)?
    const refX = stockConfig.datum[1] === 'l' ? gMinX : stockConfig.datum[1] === 'c' ? gCX : gMaxX;
    const refY = stockConfig.datum[0] === 'b' ? gMinY : stockConfig.datum[0] === 'm' ? gCY : gMaxY;

    const shifted   = applyShift(entities, -refX, -refY);
    const newBounds = getBounds(shifted);

    // Entities have moved — toolpaths are now stale
    const clearedOps = operations.map(op => ({ ...op, toolpath: null }));
    dispatch({ type: 'SET_DXF', payload: { entities: shifted, layers, bounds: newBounds } });
    dispatch({ type: 'REORDER_OPERATIONS', payload: clearedOps });

    const nW = newBounds.maxX - newBounds.minX;
    const nH = newBounds.maxY - newBounds.minY;
    const offset = toMM(stockConfig.stockOffset ?? 0) || nW * 0.05; // stored offset or 5 % default
    const padW = nW + 2 * offset;
    const padH = nH + 2 * offset;

    // Stock wraps the shifted geometry with `offset` margin on all sides.
    // newBounds.minX is the geometry left after shifting (0 for 'bl', -nW for 'tr', etc.)
    const stockOriginX = newBounds.minX - offset + datumXFrac(stockConfig.datum) * padW;
    const stockOriginY = newBounds.minY - offset + datumYFrac(stockConfig.datum) * padH;

    dispatch({ type: 'SET_STOCK_CONFIG', payload: {
      width: padW, length: padH, stockOriginX, stockOriginY,
    }});
  }

  // Change the datum (reference corner/edge/centre) without moving the stock rectangle.
  // Only stockOriginX/Y needs to change — it shifts to point to the new datum on the
  // same stock box.
  function changeDatum(newDatum) {
    const { datum, stockOriginX: ox, stockOriginY: oy, width, length } = stockConfig;
    const stockMinX = ox - datumXFrac(datum) * width;
    const stockMinY = oy - datumYFrac(datum) * length;
    dispatch({ type: 'SET_STOCK_CONFIG', payload: {
      datum:        newDatum,
      stockOriginX: stockMinX + datumXFrac(newDatum) * width,
      stockOriginY: stockMinY + datumYFrac(newDatum) * length,
    }});
  }

  function toDisp(v) { return isInch ? +(v / MM_PER_INCH).toFixed(4) : v; }
  function toMM(v)   { return isInch ? v * MM_PER_INCH : v; }

  // Apply a uniform per-side offset around the current part bounds.
  // Updates width, length, and the stock origin so the geometry stays centred.
  // If no geometry is loaded, only the stored offset value is updated.
  function applyStockOffset(dispVal) {
    const offMM = toMM(dispVal);
    const updates = { stockOffset: offMM };
    if (hasDXF) {
      const { minX: gMinX, minY: gMinY, maxX: gMaxX, maxY: gMaxY } = bounds;
      const gW = gMaxX - gMinX, gH = gMaxY - gMinY;
      const newW = gW + 2 * offMM;
      const newL = gH + 2 * offMM;
      updates.width  = newW;
      updates.length = newL;
      updates.stockOriginX = gMinX - offMM + datumXFrac(stockConfig.datum) * newW;
      updates.stockOriginY = gMinY - offMM + datumYFrac(stockConfig.datum) * newL;
    }
    dispatch({ type: 'SET_STOCK_CONFIG', payload: updates });
  }

  const distUnit = isInch ? 'in' : 'mm';
  const dStep    = isInch ? 0.01 : 1;

  // Compute stock bounds in world space for the info display
  const xOff = getXOffset(stockConfig.datum) * stockConfig.width;
  const yOff = getYOffset(stockConfig.datum) * stockConfig.length;
  const stockBounds = {
    minX: -xOff,
    maxX: stockConfig.width - xOff,
    minY: -yOff,
    maxY: stockConfig.length - yOff,
  };

  const fmt = v => isInch ? (v / MM_PER_INCH).toFixed(4) : v.toFixed(1);

  return (
    <div style={S.panel}>
      <div style={S.header}>
        <span style={S.headerTitle}>Stock</span>
      </div>
      <div style={S.body}>

        <div style={S.section}>Setup</div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <button
            style={S.actionBtn(hasGeometry)}
            onClick={fitStockToPart}
            title="Size stock to geometry bounds + 10% margin and centre geometry within stock"
          >
            Fit Stock to Part
          </button>
          <button
            style={S.actionBtn(hasGeometry)}
            onClick={moveToOrigin}
            title={hasDXF
              ? `Shift geometry so the ${DATUM_LABELS[stockConfig.datum].toLowerCase()} lands at X0 Y0`
              : `Place stock ${DATUM_LABELS[stockConfig.datum].toLowerCase()} at machine (0, 0)`}
          >
            Move to Origin
          </button>
        </div>

        <div style={S.section}>Dimensions</div>
        <div style={S.row}>
          <span style={S.label}>Width (X)</span>
          <NumInput value={toDisp(stockConfig.width)} onChange={v => set('width', toMM(v))} min={0} step={dStep} />
          <span style={S.unit}>{distUnit}</span>
        </div>
        <div style={S.row}>
          <span style={S.label}>Length (Y)</span>
          <NumInput value={toDisp(stockConfig.length)} onChange={v => set('length', toMM(v))} min={0} step={dStep} />
          <span style={S.unit}>{distUnit}</span>
        </div>
        <div style={S.row}>
          <span style={S.label} title="Uniform margin added to each side of the part bounds. Updates Width and Length automatically. Edit Width / Length directly to override.">Stock Offset</span>
          <NumInput value={toDisp(stockConfig.stockOffset ?? 0)} onChange={applyStockOffset} min={0} step={dStep} />
          <span style={S.unit}>{distUnit}</span>
        </div>
        <div style={S.row}>
          <span style={S.label}>Thickness (Z)</span>
          <NumInput value={toDisp(stockConfig.thickness)} onChange={v => set('thickness', toMM(v))} min={0} step={isInch ? 0.001 : 0.1} />
          <span style={S.unit}>{distUnit}</span>
        </div>

        <div style={S.section}>Z Reference</div>
        <div style={S.row}>
          <span style={S.label}>Work Zero (Z0)</span>
          <NumInput value={toDisp(stockConfig.topZ)} onChange={v => set('topZ', toMM(v))} step={isInch ? 0.001 : 0.1} />
          <span style={S.unit}>{distUnit}</span>
        </div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <div style={{ width: 120, flexShrink: 0 }} />
          <button
            style={S.presetBtn}
            onClick={() => set('topZ', stockConfig.thickness)}
            title={`Set Z0 to ${toDisp(stockConfig.thickness)} ${distUnit} — work zero at top surface of stock`}
          >
            Stock Top
          </button>
          <button
            style={S.presetBtn}
            onClick={() => set('topZ', 0)}
            title="Set Z0 to 0 — work zero at bottom of stock"
          >
            Stock Bottom
          </button>
        </div>

        <div style={S.section}>Datum / Origin</div>
        <div style={{ fontSize: 10, color: '#555577', marginBottom: 6 }}>
          Select which point on the stock is at X0 Y0
        </div>
        <div style={S.datumGrid}>
          {DATUM_GRID.map((row, ri) =>
            row.map(pos => (
              <button
                key={pos}
                title={DATUM_LABELS[pos]}
                style={S.datumBtn(stockConfig.datum === pos)}
                onClick={() => changeDatum(pos)}
              >
                {DATUM_ICONS[pos]}
              </button>
            ))
          )}
        </div>
        <div style={{ fontSize: 10, color: '#7777aa', marginTop: 5, textAlign: 'center' }}>
          {DATUM_LABELS[stockConfig.datum]}
        </div>

        <div style={S.infoBox}>
          <div style={{ color: '#3b3b66', marginBottom: 2, fontSize: 9 }}>machine coords (from datum)</div>
          <div>X: <span style={S.infoVal}>{fmt(stockBounds.minX)}</span> → <span style={S.infoVal}>{fmt(stockBounds.maxX)}</span> {distUnit}</div>
          <div>Y: <span style={S.infoVal}>{fmt(stockBounds.minY)}</span> → <span style={S.infoVal}>{fmt(stockBounds.maxY)}</span> {distUnit}</div>
          <div>Z: <span style={S.infoVal}>{fmt(stockConfig.topZ - stockConfig.thickness)}</span> → <span style={S.infoVal}>{fmt(stockConfig.topZ)}</span> {distUnit}</div>
        </div>

        <div style={S.section}>WCS / Work Offset</div>
        <div style={S.row}>
          <span style={S.label}>Work Offset</span>
          <select
            style={{ ...S.input, padding: '2px 4px' }}
            value={stockConfig.wcs}
            onChange={e => set('wcs', e.target.value)}
          >
            {['G54','G55','G56','G57','G58','G59'].map(g => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </div>
        <div style={{ ...S.infoBox, marginTop: 4 }}>
          On your Masso, touch off the {DATUM_LABELS[stockConfig.datum].toLowerCase()} of the
          stock and zero X, Y, and Z in <strong style={{ color: '#8888aa' }}>{stockConfig.wcs}</strong>.
          The post-processor will output <strong style={{ color: '#8888aa' }}>{stockConfig.wcs}</strong> at
          the start of the program to activate that offset.
        </div>

      </div>
    </div>
  );
}
