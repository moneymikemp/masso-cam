import React from 'react';
import { useApp } from '../../store/AppContext';

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
      { key: 'rect',     label: '□',   title: 'Rectangle — click corner, click opposite  [R]' },
      { key: 'polyline', label: '⌒╱', title: 'Polyline — A=arc · L=line · C=close · Enter=finish  [P]' },
      { key: 'polygon',  label: '⬡',  title: 'Polygon — click center, set sides, click radius' },
      { key: 'mirror',   label: '⇔',  title: 'Mirror — select entities, click two axis points  [M]' },
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

export default function CADToolsPanel() {
  const { state, dispatch } = useApp();
  const { activeTool, gridSnap } = state;

  const setTool = (key) => dispatch({ type: 'SET_ACTIVE_TOOL', payload: key });

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
              <button
                key={key}
                title={title}
                style={btn(activeTool === key)}
                onClick={() => setTool(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ))}

      <button
        title="Grid snap — snaps to 10 mm grid"
        style={snapBtn(gridSnap)}
        onClick={() => dispatch({ type: 'TOGGLE_GRID_SNAP' })}
      >
        ⊞ <span style={{ fontSize: 10 }}>Grid Snap</span>
      </button>
    </div>
  );
}
