import React from 'react';
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
  const { stockConfig, entities, bounds, layers } = state;
  const isInch = state.postConfig?.units === 'inch';
  const hasGeometry = entities.length > 0 && bounds != null;

  const set = (key, val) => dispatch({ type: 'SET_STOCK_CONFIG', payload: { [key]: val } });

  function datumXFrac(d) { return d[1] === 'l' ? 0 : d[1] === 'c' ? 0.5 : 1; }
  function datumYFrac(d) { return d[0] === 'b' ? 0 : d[0] === 'm' ? 0.5 : 1; }

  function fitStockToPart() {
    if (!hasGeometry) return;
    const { minX: gMinX, minY: gMinY, maxX: gMaxX, maxY: gMaxY } = bounds;
    const gW = gMaxX - gMinX, gH = gMaxY - gMinY;
    if (gW < 1e-6 || gH < 1e-6) return;

    const newW = gW * 1.1, newL = gH * 1.1;
    const mX = gW * 0.05, mY = gH * 0.05;  // 5% each side → 10% total margin

    // Shift geometry so the datum-positioned stock surrounds it with equal margins
    const shiftX = -datumXFrac(stockConfig.datum) * newW + mX - gMinX;
    const shiftY = -datumYFrac(stockConfig.datum) * newL + mY - gMinY;

    const shifted = applyShift(entities, shiftX, shiftY);
    dispatch({ type: 'SET_DXF', payload: { entities: shifted, layers, bounds: getBounds(shifted) } });
    dispatch({ type: 'SET_STOCK_CONFIG', payload: { width: newW, length: newL } });
  }

  function moveToOrigin() {
    if (!hasGeometry) return;
    const { minX: gMinX, minY: gMinY, maxX: gMaxX, maxY: gMaxY } = bounds;
    const gCX = (gMinX + gMaxX) / 2, gCY = (gMinY + gMaxY) / 2;

    // Shift so the datum-appropriate reference point lands exactly at (0, 0)
    const refX = stockConfig.datum[1] === 'l' ? gMinX : stockConfig.datum[1] === 'c' ? gCX : gMaxX;
    const refY = stockConfig.datum[0] === 'b' ? gMinY : stockConfig.datum[0] === 'm' ? gCY : gMaxY;

    const shifted = applyShift(entities, -refX, -refY);
    const newBounds = getBounds(shifted);
    dispatch({ type: 'SET_DXF', payload: { entities: shifted, layers, bounds: newBounds } });

    // Size stock to cover shifted geometry with 10 % overhang beyond the datum side
    const nW = newBounds.maxX - newBounds.minX;
    const nH = newBounds.maxY - newBounds.minY;
    dispatch({ type: 'SET_STOCK_CONFIG', payload: { width: nW * 1.1, length: nH * 1.1 } });
  }

  function toDisp(v) { return isInch ? +(v / MM_PER_INCH).toFixed(4) : v; }
  function toMM(v)   { return isInch ? v * MM_PER_INCH : v; }

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
            title={`Shift geometry so the ${DATUM_LABELS[stockConfig.datum].toLowerCase()} lands at X0 Y0`}
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
          <span style={S.label}>Thickness (Z)</span>
          <NumInput value={toDisp(stockConfig.thickness)} onChange={v => set('thickness', toMM(v))} min={0} step={isInch ? 0.001 : 0.1} />
          <span style={S.unit}>{distUnit}</span>
        </div>

        <div style={S.section}>Z Reference</div>
        <div style={S.row}>
          <span style={S.label}>Top of Stock (Z0)</span>
          <NumInput value={toDisp(stockConfig.topZ)} onChange={v => set('topZ', toMM(v))} step={isInch ? 0.001 : 0.1} />
          <span style={S.unit}>{distUnit}</span>
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
                onClick={() => set('datum', pos)}
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
