import React from 'react';
import { v4 as uuid } from 'uuid';
import { useApp } from '../../store/AppContext';
import { circleToPoints, arcToPoints, polylineToPoints } from '../../dxf/parser';
import { unionPolygons, differencePolygons, intersectPolygons, stripClose } from '../../cam/offset';

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

export default function CADToolsPanel() {
  const { state, dispatch } = useApp();
  const { activeTool, gridSnap, entities, selectedEntityIds } = state;

  const setTool = (key) => dispatch({ type: 'SET_ACTIVE_TOOL', payload: key });

  const selEnts = entities.filter(e => selectedEntityIds.includes(e.id));
  const canBoolean = selEnts.length >= 2;

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

      <button title="Grid snap — snaps to 10 mm grid" style={snapBtn(gridSnap)} onClick={() => dispatch({ type: 'TOGGLE_GRID_SNAP' })}>
        ⊞ <span style={{ fontSize: 10 }}>Grid Snap</span>
      </button>
    </div>
  );
}
