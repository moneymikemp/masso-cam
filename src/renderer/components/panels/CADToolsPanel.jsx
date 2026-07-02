import React, { useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useApp } from '../../store/AppContext';
import { circleToPoints, arcToPoints, polylineToPoints } from '../../dxf/parser';
import { unionPolygons, differencePolygons, intersectPolygons, stripClose, offsetPolyline, roundedOffsetPolyline, isClockwise, pointInPolygon, polygonArea } from '../../cam/offset';

const TOOL_GROUPS = [
  {
    tools: [
      { key: 'select',   label: '▲',  title: 'Select / Move / Rotate  [S]' },
    ],
  },
  {
    label: 'Draw',
    tools: [
      { key: 'line',     label: '╱',   title: 'Line — click start, click end  [L]' },
      { key: 'circle',   label: '○',   title: 'Circle — click center, click radius  [C]' },
      { key: 'arc',      label: '⌒',  title: 'Arc — start, midpoint, end  [A]' },
      { key: 'ellipse',  label: '⬭',  title: 'Ellipse — click center, major-axis end, minor-axis end' },
      { key: 'rect',     label: '□',   title: 'Rectangle — click corner, click opposite  [R]' },
      { key: 'polyline', label: '⌒╱', title: 'Polyline — A=arc · L=line · C=close · Enter=finish  [P]' },
      { key: 'bezier',   label: '∿',  title: 'Bezier — 4 clicks: start · ctrl 1 · ctrl 2 · end' },
      { key: 'polygon',  label: '⬡',  title: 'Polygon — click center, set sides, click radius' },
      { key: 'mirror',   label: '⇔',  title: 'Mirror — select entities, click two axis points  [M]' },
      { key: 'text',     label: 'T',   title: 'Add Text — place arc-fitted text as CAD geometry' },
    ],
  },
  {
    label: 'Edit',
    tools: [
      { key: 'trim',    label: '✂',  title: 'Trim — click a segment to trim at intersecting edges  [T]' },
      { key: 'extend',  label: '→|', title: 'Extend — click near an end to extend to nearest boundary  [E]' },
      { key: 'fillet',  label: '╭',  title: 'Fillet — click two lines to round the corner  [F]' },
      { key: 'chamfer', label: '⌐',  title: 'Chamfer — click two lines to cut the corner at an angle  [H]' },
    ],
  },
  {
    label: 'Measure',
    tools: [
      { key: 'measure', label: '⊢→', title: 'Measure — click two points for distance, third for angle' },
    ],
  },
];

const btn = (active) => ({
  background: active ? '#1a3a1a' : '#111128',
  border: `1px solid ${active ? '#44aa44' : '#2a2a50'}`,
  color: active ? '#88ff88' : '#aaaacc',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 14,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 28,
  padding: 0,
  flexShrink: 0,
  userSelect: 'none',
});

const actionBtn = (disabled) => ({
  ...btn(false),
  opacity: disabled ? 0.35 : 1,
  cursor: disabled ? 'default' : 'pointer',
  fontSize: 13,
});

const snapBtn = (active) => ({
  ...btn(false),
  background: active ? '#1a2a3a' : '#111128',
  border: `1px solid ${active ? '#4488aa' : '#2a2a50'}`,
  color: active ? '#88ccff' : '#aaaacc',
  fontSize: 12,
  width: 'auto',
  padding: '0 8px',
  gap: 4,
});

function entityToPts(e) {
  switch (e.type) {
    case 'circle':   return circleToPoints(e.center, e.radius, 64);
    case 'arc':      return arcToPoints(e.center, e.radius, e.startAngle, e.endAngle, 48);
    case 'polyline': return polylineToPoints(e.vertices, e.closed);
    case 'ellipse': {
      const { center, rx, ry, rotation = 0 } = e;
      const cos = Math.cos(rotation), sin = Math.sin(rotation);
      return Array.from({ length: 64 }, (_, i) => {
        const t = (i / 64) * 2 * Math.PI;
        const lx = rx * Math.cos(t), ly = ry * Math.sin(t);
        return { x: center.x + lx * cos - ly * sin, y: center.y + lx * sin + ly * cos };
      });
    }
    default: return null;
  }
}

const MM = 25.4;

const numInp = {
  width: 56, background: '#0d0d20', border: '1px solid #2a2a50',
  color: '#ccccee', borderRadius: 3, padding: '2px 5px',
  fontSize: 11, fontFamily: 'monospace',
};

export default function CADToolsPanel() {
  const { state, dispatch } = useApp();
  const { activeTool, gridSnap, entities, selectedEntityIds } = state;
  const isInch = state.postConfig?.units === 'inch';
  const unit = isInch ? 'in' : 'mm';

  // Offset state — distance stored in mm, displayed in current unit
  const [offsetDistMM, setOffsetDistMM] = useState(5);
  const [offsetInward, setOffsetInward]  = useState(false);

  const offsetDisp = isInch ? +(offsetDistMM / MM).toFixed(4) : +offsetDistMM.toFixed(3);

  const setTool = (key) => dispatch({ type: 'SET_ACTIVE_TOOL', payload: key });

  const selEnts = entities.filter(e => selectedEntityIds.includes(e.id));
  const canBoolean = selEnts.length >= 2;
  const canOffset  = selEnts.length >= 1;

  // ── helpers ────────────────────────────────────────────────────────────────

  function toCCW(pts) {
    const s = stripClose([...pts]);
    return isClockwise(s) ? [...s].reverse() : s;
  }

  // sign: negative = expand outward, positive = shrink inward (matches offsetPolyline convention)
  function offsetSign() { return offsetInward ? offsetDistMM : -offsetDistMM; }

  function doBoolean(op) {
    const polys = selEnts.map(entityToPts).filter(p => p && p.length >= 3).map(p => stripClose([...p]));
    if (polys.length < 2) return;
    let results;
    if (op === 'union')     results = unionPolygons(polys);
    if (op === 'subtract')  results = differencePolygons(polys[0], polys.slice(1));
    if (op === 'intersect') results = intersectPolygons(polys);
    if (!results?.length) return;
    dispatch({ type: 'DELETE_ENTITIES', payload: selEnts.map(e => e.id) });
    dispatch({ type: 'ADD_ENTITIES', payload: results.map(pts => ({
      id: uuid(), type: 'polyline', layer: '0',
      vertices: pts.map(p => ({ x: p.x, y: p.y })),
      closed: true,
    })) });
  }

  // Offset each selected entity individually — adds new polylines, keeps originals.
  // Inner contours (holes) are skipped using the same containment check as Union.
  function doOffsetEach() {
    const sign = offsetSign();
    const allPtsSets = selEnts
      .map(e => ({ e, pts: entityToPts(e) }))
      .filter(({ pts }) => pts && pts.length >= 3)
      .map(({ e, pts }) => ({ e, pts: stripClose([...pts]) }));

    const newEnts = allPtsSets.flatMap(({ e, pts }) => {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const isHole = allPtsSets.some(({ pts: other }) => other !== pts && pointInPolygon({ x: cx, y: cy }, other));
      if (isHole) return [];
      return roundedOffsetPolyline(toCCW(pts), sign, true)
        .filter(r => r?.length >= 3)
        .map(r => ({
          id: uuid(), type: 'polyline', layer: e.layer || '0',
          vertices: r.map(p => ({ x: p.x, y: p.y })), closed: true,
        }));
    });
    if (newEnts.length > 0) dispatch({ type: 'ADD_ENTITIES', payload: newEnts });
  }

  // Offset each entity, then union all results into a single perimeter — adds new polyline(s).
  // Inner contours (holes, like the counter inside a D) are detected by containment and skipped
  // so they don't produce artifacts in the outer boundary.
  function doOffsetUnion() {
    const sign = offsetSign();

    // Build all point sets first so we can test containment between them.
    const allPtsSets = selEnts
      .map(e => entityToPts(e))
      .filter(p => p && p.length >= 3)
      .map(p => stripClose([...p]));

    // An inner contour's centroid is inside one of the other selected contours.
    // Keep only the outer (non-contained) contours for the perimeter expansion.
    const outerPtsSets = allPtsSets.filter(pts => {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      return !allPtsSets.some(other => other !== pts && pointInPolygon({ x: cx, y: cy }, other));
    });

    if (!outerPtsSets.length) return;

    const expanded = outerPtsSets.flatMap(pts => {
      return roundedOffsetPolyline(toCCW(pts), sign, true)
        .filter(r => r?.length >= 3)
        .map(r => toCCW(r));
    });
    if (!expanded.length) return;
    const unioned = unionPolygons(expanded.map(r => stripClose([...r])));
    if (!unioned?.length) return;
    dispatch({ type: 'ADD_ENTITIES', payload: unioned.map(pts => ({
      id: uuid(), type: 'polyline', layer: '0',
      vertices: pts.map(p => ({ x: p.x, y: p.y })), closed: true,
    })) });
  }

  // ── render ─────────────────────────────────────────────────────────────────

  const dirBtnStyle = {
    ...btn(false),
    fontSize: 11, width: 'auto', padding: '0 7px',
    background: '#111128', color: offsetInward ? '#88aaff' : '#88ffcc',
    border: `1px solid ${offsetInward ? '#3344aa' : '#226644'}`,
  };

  return (
    <div style={{ borderTop: '1px solid #2a2a50', background: '#13132a', flexShrink: 0, padding: '6px 8px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 10, color: '#444466', textTransform: 'uppercase', letterSpacing: 1 }}>CAD Tools</div>

      {TOOL_GROUPS.map((group, gi) => (
        <div key={gi}>
          {group.label && (
            <div style={{ fontSize: 9, color: '#333355', marginBottom: 3 }}>{group.label}</div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {group.tools.map(({ key, label, title }) => (
              <button key={key} title={title} style={btn(activeTool === key)} onClick={() => setTool(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div>
        <div style={{ fontSize: 9, color: '#333355', marginBottom: 3 }}>Boolean</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          <button title="Weld — union of selected shapes (need ≥2 selected)" style={actionBtn(!canBoolean)} disabled={!canBoolean} onClick={() => doBoolean('union')}>∪</button>
          <button title="Subtract — first selected minus the rest (need ≥2 selected)" style={actionBtn(!canBoolean)} disabled={!canBoolean} onClick={() => doBoolean('subtract')}>∖</button>
          <button title="Intersect — common area of selected shapes (need ≥2 selected)" style={actionBtn(!canBoolean)} disabled={!canBoolean} onClick={() => doBoolean('intersect')}>∩</button>
        </div>
      </div>

      <div>
        <div style={{ fontSize: 9, color: '#333355', marginBottom: 4 }}>Offset</div>
        {/* Distance + direction row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
          <input
            type="number" min={0} step={isInch ? 0.001 : 0.1}
            value={offsetDisp}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v >= 0) setOffsetDistMM(isInch ? v * MM : v);
            }}
            style={numInp}
          />
          <span style={{ fontSize: 10, color: '#555577' }}>{unit}</span>
          <button
            title={offsetInward ? 'Offset direction: Inward — click to switch to Outward' : 'Offset direction: Outward — click to switch to Inward'}
            style={dirBtnStyle}
            onClick={() => setOffsetInward(v => !v)}>
            {offsetInward ? '◀ In' : 'Out ▶'}
          </button>
        </div>
        {/* Action buttons row */}
        <div style={{ display: 'flex', gap: 3 }}>
          <button
            title="Offset Each — offset every selected entity individually, keep originals (need ≥1 selected)"
            style={{ ...actionBtn(!canOffset), fontSize: 11, width: 'auto', padding: '0 7px' }}
            disabled={!canOffset}
            onClick={doOffsetEach}>
            Each
          </button>
          <button
            title="Offset & Union — offset all selected entities, then merge overlapping results into one perimeter (need ≥1 selected)"
            style={{ ...actionBtn(!canOffset), fontSize: 11, width: 'auto', padding: '0 7px', flexShrink: 0 }}
            disabled={!canOffset}
            onClick={doOffsetUnion}>
            Union
          </button>
        </div>
      </div>

      <button title="Grid snap — snaps to 10 mm grid" style={snapBtn(gridSnap)} onClick={() => dispatch({ type: 'TOGGLE_GRID_SNAP' })}>
        ⊞ <span style={{ fontSize: 10 }}>Grid Snap</span>
      </button>
    </div>
  );
}
