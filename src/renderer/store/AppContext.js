import React, { createContext, useContext, useReducer, useCallback, useEffect } from 'react';
import { v4 as uuid } from 'uuid';

const AppContext = createContext(null);

const initialState = {
  // Project
  projectPath: null,
  projectName: 'Untitled',
  dirty: false,

  // DXF geometry
  entities: [],
  layers: {},
  bounds: null,

  // Selection
  selectedEntityIds: [],
  hoveredEntityId: null,

  // Operations
  operations: [],
  selectedOperationId: null,

  // Tools
  tools: [],
  selectedToolId: null,

  // Stock
  stockConfig: {
    width: 200,
    length: 200,
    thickness: 19,
    datum: 'bl',
    topZ: 0,
    wcs: 'G54',
    stockOriginX: 0,  // world-space X of the datum point
    stockOriginY: 0,  // world-space Y of the datum point
  },

  // Machine / post config
  machineConfig: {
    name: 'My Masso G3',
    workAreaX: 1200,
    workAreaY: 900,
    workAreaZ: 150,
    maxSpindle: 24000,
    minSpindle: 1000,
    maxFeedXY: 10000,
    maxFeedZ: 3000,
    maxRapid: 10000,
    homeX: 0,
    homeY: 0,
    homeZ: 150,
    safeZ: 25,
  },

  postConfig: {
    name: 'Masso G3',
    units: 'mm',
    coolant: 'off',
    spindleDelay: 3,
    lineNumbering: true,
    lineIncrement: 10,
    decimals: 3,
    safeZ: 25,
    toolChangeZ: 50,
    homeAtEnd: false,
    homeX: 0,
    homeY: 0,
    programHeader: '',
    programFooter: '',
  },

  // UI state
  viewport: { zoom: 1, panX: 0, panY: 0 },
  showToolpaths: true,
  showRapids: true,
  tabPlacementActive: false,
  tabPlacementOpId: null,
  activePanelTab: 'operations',  // operations | tools | machine | gcode
  gcodeOutput: '',
  statusMessage: '',

  // Undo/redo
  history: [],
  historyIndex: -1,
};

function reducer(state, action) {
  switch (action.type) {

    case 'SET_DXF': {
      const { entities, layers, bounds } = action.payload;
      return { ...state, entities, layers, bounds, selectedEntityIds: [], dirty: true };
    }

    case 'SET_LAYERS': return { ...state, layers: action.payload };

    case 'TOGGLE_LAYER': {
      const layers = { ...state.layers };
      if (layers[action.payload]) {
        layers[action.payload] = { ...layers[action.payload], visible: !layers[action.payload].visible };
      }
      return { ...state, layers };
    }

    case 'SELECT_ENTITIES':
      return { ...state, selectedEntityIds: action.payload };

    case 'TOGGLE_ENTITY_SELECT': {
      const id = action.payload;
      const sel = state.selectedEntityIds.includes(id)
        ? state.selectedEntityIds.filter(x => x !== id)
        : [...state.selectedEntityIds, id];
      return { ...state, selectedEntityIds: sel };
    }

    case 'HOVER_ENTITY':
      return { ...state, hoveredEntityId: action.payload };

    // Operations
    case 'ADD_OPERATION': {
      const op = {
        id: uuid(),
        name: action.payload.name || `Operation ${state.operations.length + 1}`,
        type: action.payload.type || 'contour',
        enabled: true,
        toolId: null,
        selectedIds: [],
        params: action.payload.params || getDefaultParams(action.payload.type),
        toolpath: null,
        ...action.payload,
      };
      return { ...state, operations: [...state.operations, op], selectedOperationId: op.id, dirty: true };
    }

    case 'UPDATE_OPERATION': {
      const operations = state.operations.map(op =>
        op.id === action.payload.id ? { ...op, ...action.payload.changes, toolpath: null } : op
      );
      return { ...state, operations, dirty: true };
    }

    case 'SET_OPERATION_TOOLPATH': {
      const operations = state.operations.map(op =>
        op.id === action.payload.id ? { ...op, toolpath: action.payload.toolpath } : op
      );
      return { ...state, operations };
    }

    case 'DELETE_OPERATION': {
      const operations = state.operations.filter(op => op.id !== action.payload);
      const selId = state.selectedOperationId === action.payload
        ? (operations[0]?.id || null) : state.selectedOperationId;
      return { ...state, operations, selectedOperationId: selId, dirty: true };
    }

    case 'REORDER_OPERATIONS': {
      return { ...state, operations: action.payload, dirty: true };
    }

    case 'SELECT_OPERATION':
      return { ...state, selectedOperationId: action.payload };

    case 'TOGGLE_OPERATION':
      return {
        ...state,
        operations: state.operations.map(op =>
          op.id === action.payload ? { ...op, enabled: !op.enabled } : op
        ),
        dirty: true,
      };

    case 'ASSIGN_SELECTED_TO_OPERATION': {
      const operations = state.operations.map(op =>
        op.id === action.payload ? { ...op, selectedIds: [...state.selectedEntityIds], toolpath: null } : op
      );
      return { ...state, operations, dirty: true };
    }

    // Tools
    case 'SET_TOOLS': return { ...state, tools: action.payload };
    case 'SELECT_TOOL':  return { ...state, selectedToolId: action.payload };

    // Machine
    case 'SET_MACHINE_CONFIG': return { ...state, machineConfig: { ...state.machineConfig, ...action.payload }, dirty: true };
    case 'SET_POST_CONFIG':    return { ...state, postConfig: { ...state.postConfig, ...action.payload }, dirty: true };
    // Restore persisted user preferences without marking the project dirty.
    case 'APPLY_SAVED_PREFS': return { ...state, postConfig: { ...state.postConfig, ...action.payload } };
    case 'SET_STOCK_CONFIG':   return { ...state, stockConfig: { ...state.stockConfig, ...action.payload }, dirty: true };

    // Viewport
    case 'SET_VIEWPORT': return { ...state, viewport: { ...state.viewport, ...action.payload } };
    case 'RESET_VIEWPORT': return { ...state, viewport: { zoom: 1, panX: 0, panY: 0 } };

    // UI
    case 'SET_PANEL_TAB':       return { ...state, activePanelTab: action.payload };
    case 'SET_GCODE':           return { ...state, gcodeOutput: action.payload };
    case 'SET_STATUS':          return { ...state, statusMessage: action.payload };
    case 'TOGGLE_TOOLPATHS':    return { ...state, showToolpaths: !state.showToolpaths };
    case 'TOGGLE_RAPIDS':       return { ...state, showRapids: !state.showRapids };

    case 'SET_TAB_PLACEMENT':
      return { ...state, tabPlacementActive: action.payload.active, tabPlacementOpId: action.payload.opId ?? null };

    // Update tab positions WITHOUT clearing the toolpath so the contour outline
    // stays visible for snap-to during manual placement.  The G-code becomes
    // stale until the user clicks Calculate.
    case 'UPDATE_TAB_POSITIONS': {
      const operations = state.operations.map(op =>
        op.id === action.payload.opId
          ? { ...op, params: { ...op.params, tabPositions: action.payload.positions } }
          : op
      );
      return { ...state, operations, dirty: true };
    }

    // Project
    case 'SET_PROJECT_PATH': return { ...state, projectPath: action.payload };
    case 'SET_DIRTY':        return { ...state, dirty: action.payload };
    case 'LOAD_PROJECT': {
      const p = action.payload;
      return {
        ...state,
        entities:      p.entities || [],
        layers:        p.layers || {},
        bounds:        p.bounds || null,
        operations:    p.operations || [],
        postConfig:    p.postConfig || state.postConfig,
        machineConfig: p.machineConfig || state.machineConfig,
        stockConfig:   p.stockConfig || state.stockConfig,
        gcodeOutput:   '',
        selectedEntityIds: [],
        selectedOperationId: null,
        dirty: false,
      };
    }

    default:
      return state;
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Restore persisted user preferences on first mount.
  // Uses APPLY_SAVED_PREFS so the project is not marked dirty.
  useEffect(() => {
    if (!window.electron) return;
    Promise.all([
      window.electron.storeGet('pref.units'),
      window.electron.storeGet('pref.safeZ'),
      window.electron.storeGet('pref.toolChangeZ'),
    ]).then(([units, safeZ, toolChangeZ]) => {
      const overrides = {};
      if (units      != null) overrides.units       = units;
      if (safeZ      != null) overrides.safeZ       = safeZ;
      if (toolChangeZ != null) overrides.toolChangeZ = toolChangeZ;
      if (Object.keys(overrides).length > 0) {
        dispatch({ type: 'APPLY_SAVED_PREFS', payload: overrides });
      }
    });
  }, []);

  const getProject = useCallback(() => ({
    entities: state.entities,
    layers: state.layers,
    bounds: state.bounds,
    operations: state.operations,
    postConfig: state.postConfig,
    machineConfig: state.machineConfig,
    stockConfig: state.stockConfig,
  }), [state]);

  return (
    <AppContext.Provider value={{ state, dispatch, getProject }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  return useContext(AppContext);
}

// Default parameters for each operation type
export function getDefaultParams(type) {
  const base = { safeZ: 25, topZ: 0, feedRate: 1500, plungeRate: 500, spindleRpm: 18000, totalDepth: 10, depthPerPass: 3 };
  switch (type) {
    case 'contour':  return { ...base, toolDiameter: 6.35, cutSide: 'outside', stockToLeave: 0, leadInStyle: 'ramp', rampAngle: 3, leadInArcRadius: null, rampEntry: true, tabs: false, tabMode: 'auto', tabHeight: 1.5, tabWidth: 6, tabCount: 4, tabPositions: [], finishPass: false, finishStockToLeave: 0 };
    case 'pocket':   return { ...base, toolDiameter: 6.35, stepover: 0.45, leadInStyle: 'plunge', rampAngle: 3, finishPass: true, finishAllowance: 0.2, startFromCenter: false };
    case 'adaptive': return { ...base, toolDiameter: 6.35, stepover: 0.35, optimalLoad: 0.3, leadInStyle: 'ramp', rampAngle: 2, depthPerPass: 5 };
    case 'face':     return { ...base, toolDiameter: 25.4, stepover: 0.75, depthPerPass: 1, totalDepth: 3, feedRate: 3000, plungeRate: 800, angle: 0, leadInStyle: 'plunge', rampAngle: 3, stockLeft: 2, stockRight: 2, stockFront: 2, stockBack: 2 };
    case 'drill':    return { safeZ: 25, topZ: 0, feedRate: 300, spindleRpm: 3000, totalDepth: 20, peckDepth: 0, dwellTime: 0, retractHeight: 2, chipBreak: false };
    case 'bore':     return { safeZ: 25, topZ: 0, feedRate: 600, plungeRate: 200, totalDepth: 20, toolDiameter: 6.35, helicalPitch: 1.5, direction: 'climb' };
    case 'circular': return { ...base, toolDiameter: 6.35, stepover: 0.4, leadInStyle: 'ramp', helicalEntry: true };
    case 'engrave':  return { safeZ: 25, topZ: 0, feedRate: 800, plungeRate: 300, depth: 1.5 };
    case 'trace':    return { safeZ: 25, topZ: 0, feedRate: 800, plungeRate: 300, depth: 0.5 };
    case 'slot':     return { ...base, toolDiameter: 6.35, rampEntry: true, rampAngle: 3 };
    case 'chamfer':  return { toolDiameter: 6.35, chamferAngle: 45, chamferWidth: 1.0, topZ: 0, safeZ: 25, feedRate: 800, plungeRate: 300, spindleRpm: 18000, stockToLeave: 0 };
    case 'thread':        return { safeZ: 25, topZ: 0, feedRate: 400, plungeRate: 200, totalDepth: 15, toolDiameter: 6.35, pitch: 1.25, internal: true, direction: 'right', spindleRpm: 1000 };
    case 'taperedpocket': return {
      topZ: 0, safeZ: 10, pocketDepth: 5, mirrorX: false,
      passes: {
        taperContour:  { enabled: true, toolId: null, tipDia: 0.5,    angle: 10, rpm: 24000, feed: 1000, plunge: 300 },
        taperCleanup:  { enabled: true, toolId: null, tipDia: 0.5,    angle: 10, rpm: 24000, feed: 1000, plunge: 300, wallStock: 0.254 },
        detailEndmill: { enabled: true, toolId: null, diameter: 1.5875, rpm: 18000, feed: 800,  plunge: 300, wallStock: 0.254 },
        bulkEndmill:   { enabled: true, toolId: null, diameter: 6.35,  rpm: 18000, feed: 1500, plunge: 500, wallStock: 0.254 },
      },
    };
    case 'taperedplug': return {
      topZ: 0, safeZ: 10, pocketDepth: 5, mirrorX: false,
      fitTolerance: 0.127,
      passes: {
        taperContour:  { enabled: true, toolId: null, tipDia: 0.5,    angle: 10, rpm: 24000, feed: 1000, plunge: 300 },
        taperCleanup:  { enabled: true, toolId: null, tipDia: 0.5,    angle: 10, rpm: 24000, feed: 1000, plunge: 300, wallStock: 0.254 },
        detailEndmill: { enabled: true, toolId: null, diameter: 1.5875, rpm: 18000, feed: 800,  plunge: 300, wallStock: 0.254 },
        bulkEndmill:   { enabled: true, toolId: null, diameter: 6.35,  rpm: 18000, feed: 1500, plunge: 500, wallStock: 0.254 },
      },
    };
    default:         return base;
  }
}
