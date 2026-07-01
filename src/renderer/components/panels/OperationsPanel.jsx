import React, { useState, useEffect } from 'react';
import { useApp, getDefaultParams } from '../../store/AppContext';
import { generateToolpath, computeVCarveMedialAxis } from '../../cam/toolpath';
import OperationParams from './OperationParams';

const OP_TYPES = [
  { type: 'contour',  label: '2D Contour',          icon: '⬡', desc: 'Profile cut, inside/outside/on' },
  { type: 'pocket',   label: '2D Pocket',            icon: '◻', desc: 'Pocket clearing with finish pass' },
  { type: 'adaptive', label: '2D Adaptive',          icon: '↺', desc: 'Trochoidal pocket clearing' },
  { type: 'face',     label: 'Face',                 icon: '▬', desc: 'Surface facing passes' },
  { type: 'drill',    label: 'Drill',                icon: '⦿', desc: 'Drilling with optional peck' },
  { type: 'bore',     label: 'Bore',                 icon: '◎', desc: 'Helical bore interpolation' },
  { type: 'circular', label: 'Circular',             icon: '◉', desc: 'Circular pocket from center' },
  { type: 'engrave',  label: 'Engrave',              icon: '✒', desc: 'Follow curves at depth' },
  { type: 'trace',    label: 'Trace',                icon: '〜', desc: 'Trace open curves' },
  { type: 'slot',     label: 'Slot',                 icon: '▭', desc: 'Slot with ramp entry' },
  { type: 'chamfer',      label: '2D Chamfer',    icon: '◤', desc: 'Chamfer mill along contour' },
  { type: 'thread',       label: 'Thread',        icon: '⌀', desc: 'Thread milling (helical)' },
  { type: 'taperedpocket', label: 'Tapered Pocket', icon: '◈', desc: 'V-bit profile + endmill cleanup — pocket half' },
  { type: 'taperedplug',   label: 'Tapered Plug',   icon: '◇', desc: 'V-bit profile + endmill cleanup — plug half, fit raised' },
  { type: 'vcarve',        label: 'V-Carve',        icon: '◆', desc: 'Variable-depth V-bit carving for closed shapes' },
  { type: 'dogbone',       label: 'Dogbone Fillets', icon: '⊕', desc: 'Drill internal corners for square-fit pockets' },
  { type: 'text',          label: 'Text Engraving',  icon: 'T',  desc: 'Engrave, outline, or pocket lettering' },
  { type: 'stlraster',     label: '3D Raster (STL)', icon: '▦',  desc: 'Ball-nose raster over loaded STL model' },
];

const S = {
  panel: { height: '100%', display: 'flex', flexDirection: 'column', background: '#13132a', color: '#ccc', overflow: 'hidden' },
  header: { padding: '8px 10px', borderBottom: '1px solid #2a2a50', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 },
  headerTitle: { fontSize: 12, fontWeight: 600, color: '#8888bb', textTransform: 'uppercase', letterSpacing: 1 },
  addBtn: { fontSize: 18, background: 'none', border: '1px solid #3a3a70', color: '#6666cc', borderRadius: 4, width: 24, height: 24, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
  opList: { flex: 1, overflow: 'auto', padding: '4px 0' },
  opRow: (selected, enabled) => ({
    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', cursor: 'pointer',
    background: selected ? '#22224a' : 'transparent',
    borderLeft: `3px solid ${selected ? '#5555cc' : 'transparent'}`,
    opacity: enabled ? 1 : 0.45,
  }),
  opIcon: { fontSize: 14, width: 20, textAlign: 'center', color: '#7777cc' },
  opName: { flex: 1, fontSize: 12, color: '#ccccdd', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  opStatus: (hasPath) => ({ width: 8, height: 8, borderRadius: '50%', background: hasPath ? '#44cc88' : '#665544', flexShrink: 0 }),
  opActions: { display: 'flex', gap: 2, flexShrink: 0 },
  iconBtn: { background: 'none', border: 'none', color: '#666688', cursor: 'pointer', fontSize: 12, padding: '2px 3px', borderRadius: 2 },
  calcBtn: { background: '#2a2a5a', border: '1px solid #3a3aaa', color: '#8888ff', cursor: 'pointer', fontSize: 10, padding: '3px 8px', borderRadius: 3, marginLeft: 4 },
  divider: { borderTop: '1px solid #22224a', margin: '4px 0' },
  paramsArea: { borderTop: '1px solid #2a2a50', overflow: 'auto', maxHeight: '55%', flexShrink: 0 },
  noOps: { padding: 20, textAlign: 'center', color: '#444466', fontSize: 12 },
  typeGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 8 },
  typeBtn: { background: '#1a1a3a', border: '1px solid #2a2a50', color: '#9999cc', borderRadius: 4, padding: '6px 8px', cursor: 'pointer', textAlign: 'left', fontSize: 11 },
  typeBtnLabel: { fontWeight: 600, display: 'block', marginBottom: 1 },
  typeBtnDesc: { fontSize: 9, color: '#555577', display: 'block' },
  assignBtn: { background: '#1a3a2a', border: '1px solid #2a5a3a', color: '#44cc88', borderRadius: 3, fontSize: 10, padding: '3px 8px', cursor: 'pointer', width: '100%' },
  warnings: { background: '#3a1a1a', borderTop: '1px solid #5a2a2a', padding: '4px 8px', fontSize: 10, color: '#cc8888' },
};

export default function OperationsPanel() {
  const { state, dispatch } = useApp();
  const { operations: allOperations, selectedOperationId, entities, tools, selectedEntityIds, activeWorkspaceId } = state;
  const operations = allOperations.filter(op => (op.workspaceId ?? 'default') === activeWorkspaceId);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);

  // Clear the skeleton overlay whenever the selected operation changes.
  useEffect(() => {
    setShowSkeleton(false);
    dispatch({ type: 'SET_MEDIAL_AXIS', payload: null });
  }, [selectedOperationId]);

  const selectedOp = operations.find(o => o.id === selectedOperationId);

  function addOperation(type) {
    const info = OP_TYPES.find(t => t.type === type);
    dispatch({
      type: 'ADD_OPERATION',
      payload: {
        type,
        name: info?.label || type,
        params: getDefaultParams(type),
        selectedIds: [...selectedEntityIds],
      }
    });
    setShowAddMenu(false);
  }

  function deleteOp(id, e) {
    e.stopPropagation();
    dispatch({ type: 'DELETE_OPERATION', payload: id });
  }

  function toggleOp(id, e) {
    e.stopPropagation();
    dispatch({ type: 'TOGGLE_OPERATION', payload: id });
  }

  function duplicateOp(id, e) {
    e.stopPropagation();
    const op = allOperations.find(o => o.id === id);
    if (!op) return;
    dispatch({ type: 'ADD_OPERATION', payload: { ...op, id: undefined, name: op.name + ' (copy)', toolpath: null } });
  }

  function calculateToolpath(op) {
    if (!op) return;
    const tool = tools.find(t => t.id === op.toolId);
    const toolDiameter = tool?.diameter || op.params.toolDiameter || 6.35;
    // Effective stepover: operation's "Max Stepover" is an upper bound;
    // tool DB's stepover is also an upper bound — whichever is lower wins.
    const toolDbStepover = tool?.feeds?.[0]?.stepover;
    const opStepover = op.params.stepover;
    let resolvedStepover;
    if (opStepover != null && toolDbStepover != null) {
      resolvedStepover = Math.min(opStepover, toolDbStepover);
    } else {
      resolvedStepover = opStepover ?? toolDbStepover;
    }
    const entitiesToUse = op.selectedIds?.length > 0
      ? entities.filter(e => op.selectedIds.includes(e.id))
      : entities;
    const injectedParams = { ...op.params, toolDiameter };
    if (resolvedStepover != null) injectedParams.stepover = resolvedStepover;
    // For stlraster: resolve the separate finish-pass tool diameter if one is selected.
    if (op.type === 'stlraster' && injectedParams.finishToolId) {
      const finishTool = tools.find(t => t.id === injectedParams.finishToolId);
      if (finishTool) injectedParams.finishToolDiameter = finishTool.diameter;
    }
    const toolpath = generateToolpath(
      { ...op, params: injectedParams },
      entitiesToUse,
      { stockConfig: state.stockConfig, allEntities: entities, stlHeightmap: state.stlHeightmap }
    );
    dispatch({ type: 'SET_OPERATION_TOOLPATH', payload: { id: op.id, toolpath } });
    dispatch({ type: 'SET_STATUS', payload: `Calculated: ${toolpath.moves.length} moves` });
  }

  function calculateAll() {
    for (const op of operations) {
      if (op.enabled) calculateToolpath(op);
    }
  }

  function toggleSkeleton(op) {
    if (showSkeleton) {
      setShowSkeleton(false);
      dispatch({ type: 'SET_MEDIAL_AXIS', payload: null });
    } else {
      const result = computeVCarveMedialAxis(op, entities);
      if (result.polylines.length > 0) {
        setShowSkeleton(true);
        dispatch({ type: 'SET_MEDIAL_AXIS', payload: result.polylines });
      }
    }
  }

  function moveOp(index, dir) {
    const newOps = [...operations];
    const to = index + dir;
    if (to < 0 || to >= newOps.length) return;
    [newOps[index], newOps[to]] = [newOps[to], newOps[index]];
    dispatch({ type: 'REORDER_OPERATIONS', payload: newOps });
  }

  if (showAddMenu) {
    return (
      <div style={S.panel}>
        <div style={S.header}>
          <span style={S.headerTitle}>Add Operation</span>
          <button style={S.iconBtn} onClick={() => setShowAddMenu(false)}>✕</button>
        </div>
        <div style={S.typeGrid}>
          {OP_TYPES.map(({ type, label, icon, desc }) => (
            <button key={type} style={S.typeBtn} onClick={() => addOperation(type)}>
              <span style={{ fontSize: 16, marginRight: 4 }}>{icon}</span>
              <span style={S.typeBtnLabel}>{label}</span>
              <span style={S.typeBtnDesc}>{desc}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={S.panel}>
      <div style={S.header}>
        <span style={S.headerTitle}>Operations</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {operations.length > 0 && (
            <button style={{ ...S.calcBtn, fontSize: 9 }} onClick={calculateAll} title="Recalculate all">⟳ All</button>
          )}
          <button style={S.addBtn} onClick={() => setShowAddMenu(true)} title="Add operation">+</button>
        </div>
      </div>

      <div style={S.opList}>
        {operations.length === 0 && (
          <div style={S.noOps}>
            <div style={{ fontSize: 24, marginBottom: 6 }}>⚙️</div>
            No operations yet.<br />Click + to add one.
          </div>
        )}
        {operations.map((op, i) => {
          const info = OP_TYPES.find(t => t.type === op.type);
          const isSelected = op.id === selectedOperationId;
          return (
            <div key={op.id}>
              <div style={S.opRow(isSelected, op.enabled)} onClick={() => dispatch({ type: 'SELECT_OPERATION', payload: op.id })}>
                <span style={S.opIcon}>{info?.icon || '⚙'}</span>
                <span style={S.opName} title={op.name}>{op.name}</span>
                {(() => {
                  const lid = op.params?.linkedOpId;
                  const partner = lid && operations.find(o => o.id === lid);
                  return partner ? <span style={{ fontSize: 9, color: '#9966ff', flexShrink: 0 }} title={`Linked to "${partner.name}"`}>⛓</span> : null;
                })()}
                <span style={{ fontSize: 9, color: '#555577', flexShrink: 0 }}>{op.selectedIds?.length > 0 ? `${op.selectedIds.length}sel` : 'all'}</span>
                <div style={S.opStatus(!!op.toolpath)} title={op.toolpath ? `${op.toolpath.moves.length} moves` : 'Not calculated'} />
                <div style={S.opActions}>
                  {isSelected && (
                    <>
                      <button style={S.iconBtn} onClick={(e) => { e.stopPropagation(); moveOp(i, -1); }} title="Move up">↑</button>
                      <button style={S.iconBtn} onClick={(e) => { e.stopPropagation(); moveOp(i, 1); }} title="Move down">↓</button>
                      <button style={S.iconBtn} onClick={(e) => duplicateOp(op.id, e)} title="Duplicate">⧉</button>
                    </>
                  )}
                  <button style={S.iconBtn} onClick={(e) => toggleOp(op.id, e)} title={op.enabled ? 'Disable' : 'Enable'}>{op.enabled ? '●' : '○'}</button>
                  <button style={{ ...S.iconBtn, color: '#884444' }} onClick={(e) => deleteOp(op.id, e)} title="Delete">✕</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {selectedOp && (
        <div style={S.paramsArea}>
          <div style={{ padding: '6px 8px', borderBottom: '1px solid #2a2a50', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ flex: 1, fontSize: 11, color: '#8888bb', fontWeight: 600 }}>{selectedOp.name}</span>
            {selectedEntityIds.length > 0 && (
              <button style={S.assignBtn} onClick={() => dispatch({ type: 'ASSIGN_SELECTED_TO_OPERATION', payload: selectedOp.id })}>
                ← Assign {selectedEntityIds.length} selected
              </button>
            )}
            {selectedOp.type === 'vcarve' && (
              <button
                style={{ ...S.calcBtn, background: showSkeleton ? '#2a1a5a' : '#2a2a5a', color: showSkeleton ? '#cc44ff' : '#8888ff', borderColor: showSkeleton ? '#9933ff' : '#3a3aaa' }}
                onClick={() => toggleSkeleton(selectedOp)}
                title="Show medial axis (skeleton) overlay on canvas"
              >
                {showSkeleton ? '◈ Hide Skeleton' : '◈ Show Skeleton'}
              </button>
            )}
            <button style={S.calcBtn} onClick={() => calculateToolpath(selectedOp)}>⟳ Calculate</button>
          </div>
          {selectedOp.toolpath?.warnings?.length > 0 && (
            <div style={S.warnings}>
              {selectedOp.toolpath.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
          <OperationParams
            op={selectedOp}
            tools={tools}
            operations={operations}
            onChange={(changes) => dispatch({ type: 'UPDATE_OPERATION', payload: { id: selectedOp.id, changes } })}
          />
        </div>
      )}
    </div>
  );
}
