import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useApp } from '../../store/AppContext';
import { circleToPoints, arcToPoints, polylineToPoints } from '../../dxf/parser';

const COLORS = {
  background: '#1a1a2e',
  grid: '#252540',
  gridMajor: '#303058',
  axis: '#404070',
  entity: '#4488ff',
  entityHover: '#88bbff',
  entitySelected: '#ffcc44',
  toolpathCut: '#00ff88',
  toolpathRapid: '#ff4444',
  toolpathPlunge: '#ff8800',
  origin: '#ff4444',
  stockFill: 'rgba(180, 140, 60, 0.06)',
  stockBorder: 'rgba(200, 160, 80, 0.45)',
};

export default function CAMCanvas() {
  const canvasRef = useRef(null);
  const { state, dispatch } = useApp();
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const { viewport, entities, layers, operations, selectedEntityIds, hoveredEntityId, showToolpaths, showRapids, bounds, stockConfig } = state;

  // World to canvas
  const w2c = useCallback((x, y) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const cx = canvas.width / 2 + viewport.panX + x * viewport.zoom;
    const cy = canvas.height / 2 + viewport.panY - y * viewport.zoom;
    return { x: cx, y: cy };
  }, [viewport]);

  // Canvas to world
  const c2w = useCallback((cx, cy) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const x = (cx - canvas.width / 2 - viewport.panX) / viewport.zoom;
    const y = -(cy - canvas.height / 2 - viewport.panY) / viewport.zoom;
    return { x, y };
  }, [viewport]);

  // Fit view to bounds
  const fitView = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bounds) return;
    const margin = 0.85;
    const scaleX = (canvas.width * margin) / Math.max(bounds.width, 1);
    const scaleY = (canvas.height * margin) / Math.max(bounds.height, 1);
    const zoom = Math.min(scaleX, scaleY);
    const panX = -((bounds.minX + bounds.maxX) / 2) * zoom;
    const panY = ((bounds.minY + bounds.maxY) / 2) * zoom;
    dispatch({ type: 'SET_VIEWPORT', payload: { zoom, panX, panY } });
  }, [bounds, dispatch]);

  // Auto-fit on load
  useEffect(() => {
    if (bounds) fitView();
  }, [bounds]);

  // Resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      draw();
    });
    ro.observe(canvas);
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    return () => ro.disconnect();
  }, []);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawGrid(ctx);
    drawStock(ctx);
    drawOrigin(ctx);
    drawEntities(ctx);
    if (showToolpaths) drawToolpaths(ctx);
    drawMouseCoords(ctx);
  }

  function drawGrid(ctx) {
    const gridSize = 10;
    const majorEvery = 10;
    const topLeft = c2w(0, 0);
    const botRight = c2w(ctx.canvas.width, ctx.canvas.height);

    const startX = Math.floor(topLeft.x / gridSize) * gridSize;
    const endX = Math.ceil(botRight.x / gridSize) * gridSize;
    const startY = Math.floor(botRight.y / gridSize) * gridSize;
    const endY = Math.ceil(topLeft.y / gridSize) * gridSize;

    for (let x = startX; x <= endX; x += gridSize) {
      const screen = w2c(x, 0);
      const isMajor = x % (gridSize * majorEvery) === 0;
      ctx.strokeStyle = isMajor ? COLORS.gridMajor : COLORS.grid;
      ctx.lineWidth = isMajor ? 0.5 : 0.3;
      ctx.beginPath();
      ctx.moveTo(screen.x, 0);
      ctx.lineTo(screen.x, ctx.canvas.height);
      ctx.stroke();
    }
    for (let y = startY; y <= endY; y += gridSize) {
      const screen = w2c(0, y);
      const isMajor = y % (gridSize * majorEvery) === 0;
      ctx.strokeStyle = isMajor ? COLORS.gridMajor : COLORS.grid;
      ctx.lineWidth = isMajor ? 0.5 : 0.3;
      ctx.beginPath();
      ctx.moveTo(0, screen.y);
      ctx.lineTo(ctx.canvas.width, screen.y);
      ctx.stroke();
    }
  }

  function drawOrigin(ctx) {
    const o = w2c(0, 0);
    const size = 12;
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(o.x, o.y - size); ctx.lineTo(o.x, o.y + size); ctx.stroke();
    ctx.strokeStyle = '#44ff44';
    ctx.beginPath(); ctx.moveTo(o.x - size, o.y); ctx.lineTo(o.x + size, o.y); ctx.stroke();
  }

  function drawStock(ctx) {
    if (!stockConfig || stockConfig.width <= 0 || stockConfig.length <= 0) return;
    const xOff = (stockConfig.datum[1] === 'l' ? 0 : stockConfig.datum[1] === 'c' ? 0.5 : 1) * stockConfig.width;
    const yOff = (stockConfig.datum[0] === 'b' ? 0 : stockConfig.datum[0] === 'm' ? 0.5 : 1) * stockConfig.length;
    const minX = -xOff, maxX = stockConfig.width - xOff;
    const minY = -yOff, maxY = stockConfig.length - yOff;
    const tl = w2c(minX, maxY);
    const br = w2c(maxX, minY);
    const w = br.x - tl.x, h = br.y - tl.y;
    ctx.fillStyle = COLORS.stockFill;
    ctx.fillRect(tl.x, tl.y, w, h);
    ctx.strokeStyle = COLORS.stockBorder;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(tl.x, tl.y, w, h);
    ctx.setLineDash([]);
  }

  function drawEntities(ctx) {
    for (const entity of entities) {
      const layer = layers[entity.layer];
      if (layer && !layer.visible) continue;

      const isSelected = selectedEntityIds.includes(entity.id);
      const isHovered = hoveredEntityId === entity.id;

      ctx.strokeStyle = isSelected ? COLORS.entitySelected : isHovered ? COLORS.entityHover : (layer?.color || COLORS.entity);
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.setLineDash([]);

      drawEntity(ctx, entity);
    }
  }

  function drawEntity(ctx, entity) {
    ctx.beginPath();
    switch (entity.type) {
      case 'line': {
        const s = w2c(entity.start.x, entity.start.y);
        const e = w2c(entity.end.x, entity.end.y);
        ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
        break;
      }
      case 'circle': {
        const c = w2c(entity.center.x, entity.center.y);
        ctx.arc(c.x, c.y, entity.radius * viewport.zoom, 0, Math.PI * 2);
        break;
      }
      case 'arc': {
        const pts = arcToPoints(entity.center, entity.radius, entity.startAngle, entity.endAngle, 48);
        if (!pts.length) break;
        const first = w2c(pts[0].x, pts[0].y);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < pts.length; i++) {
          const p = w2c(pts[i].x, pts[i].y);
          ctx.lineTo(p.x, p.y);
        }
        break;
      }
      case 'polyline': {
        if (!entity.vertices?.length) break;
        const pts = polylineToPoints(entity.vertices, false);
        if (!pts.length) break;
        const first = w2c(pts[0].x, pts[0].y);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < pts.length; i++) {
          const p = w2c(pts[i].x, pts[i].y);
          ctx.lineTo(p.x, p.y);
        }
        if (entity.closed) ctx.closePath();
        break;
      }
    }
    ctx.stroke();
  }

  function drawMoveList(ctx, moves, cutColor) {
    let prevX = 0, prevY = 0;
    for (const move of moves) {
      const x = move.x ?? prevX;
      const y = move.y ?? prevY;
      if (move.type === 'rapid') {
        if (showRapids) {
          ctx.strokeStyle = COLORS.toolpathRapid;
          ctx.lineWidth = 0.7;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          const s = w2c(prevX, prevY), e = w2c(x, y);
          ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else if (move.type === 'feed') {
        const isPlunge = (x === prevX && y === prevY);
        ctx.strokeStyle = isPlunge ? COLORS.toolpathPlunge : cutColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        const s = w2c(prevX, prevY), e = w2c(x, y);
        ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
        ctx.stroke();
      }
      if (move.x !== undefined) prevX = move.x;
      if (move.y !== undefined) prevY = move.y;
    }
  }

  function drawToolpaths(ctx) {
    for (const op of operations) {
      if (!op.enabled || !op.toolpath?.moves) continue;
      if (op.toolpath.subToolpaths?.length > 0) {
        // Draw each sub-toolpath in its own colour (tapered inlay etc.)
        for (const sub of op.toolpath.subToolpaths) {
          drawMoveList(ctx, sub.moves, sub.color || COLORS.toolpathCut);
        }
      } else {
        const cutColor = op.type === 'drill' ? COLORS.toolpathPlunge : COLORS.toolpathCut;
        drawMoveList(ctx, op.toolpath.moves, cutColor);
      }
    }
  }

  function drawMouseCoords(ctx) {
    const world = c2w(mousePos.x, mousePos.y);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(8, ctx.canvas.height - 28, 160, 20);
    ctx.fillStyle = '#aaaacc';
    ctx.font = '11px monospace';
    ctx.fillText(`X: ${world.x.toFixed(3)}  Y: ${world.y.toFixed(3)}`, 14, ctx.canvas.height - 14);
  }

  useEffect(() => { draw(); }, [entities, layers, operations, viewport, selectedEntityIds, hoveredEntityId, showToolpaths, showRapids, mousePos, stockConfig]);

  // Mouse events
  const onMouseDown = useCallback((e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - viewport.panX, y: e.clientY - viewport.panY });
    } else if (e.button === 0) {
      // Entity selection
      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const world = c2w(cx, cy);
      const hit = findEntityAt(world, 10 / viewport.zoom);
      if (hit) {
        if (e.ctrlKey || e.shiftKey) {
          dispatch({ type: 'TOGGLE_ENTITY_SELECT', payload: hit.id });
        } else {
          dispatch({ type: 'SELECT_ENTITIES', payload: [hit.id] });
        }
      } else if (!e.ctrlKey) {
        dispatch({ type: 'SELECT_ENTITIES', payload: [] });
      }
    }
  }, [viewport, c2w, dispatch]);

  const onMouseMove = useCallback((e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setMousePos({ x: cx, y: cy });

    if (isPanning) {
      dispatch({ type: 'SET_VIEWPORT', payload: { panX: e.clientX - panStart.x, panY: e.clientY - panStart.y } });
    } else {
      const world = c2w(cx, cy);
      const hit = findEntityAt(world, 8 / viewport.zoom);
      dispatch({ type: 'HOVER_ENTITY', payload: hit?.id || null });
    }
  }, [isPanning, panStart, viewport, c2w, dispatch]);

  const onMouseUp = useCallback(() => setIsPanning(false), []);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    const newZoom = Math.max(0.01, Math.min(1000, viewport.zoom * factor));
    const worldX = (mx - canvas.width / 2 - viewport.panX) / viewport.zoom;
    const worldY = (my - canvas.height / 2 - viewport.panY) / viewport.zoom;
    const newPanX = mx - canvas.width / 2 - worldX * newZoom;
    const newPanY = my - canvas.height / 2 - worldY * newZoom;
    dispatch({ type: 'SET_VIEWPORT', payload: { zoom: newZoom, panX: newPanX, panY: newPanY } });
  }, [viewport, dispatch]);

  function findEntityAt(world, tolerance) {
    for (let i = entities.length - 1; i >= 0; i--) {
      const e = entities[i];
      const layer = layers[e.layer];
      if (layer && !layer.visible) continue;
      if (entityContains(e, world, tolerance)) return e;
    }
    return null;
  }

  function entityContains(entity, pt, tol) {
    switch (entity.type) {
      case 'circle': {
        const d = Math.hypot(pt.x - entity.center.x, pt.y - entity.center.y);
        return Math.abs(d - entity.radius) < tol;
      }
      case 'line': {
        const dx = entity.end.x - entity.start.x;
        const dy = entity.end.y - entity.start.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) return false;
        const t = Math.max(0, Math.min(1, ((pt.x - entity.start.x) * dx + (pt.y - entity.start.y) * dy) / (len * len)));
        const cx = entity.start.x + t * dx;
        const cy = entity.start.y + t * dy;
        return Math.hypot(pt.x - cx, pt.y - cy) < tol;
      }
      case 'polyline': {
        const pts = polylineToPoints(entity.vertices, false);
        for (let i = 0; i < pts.length - 1; i++) {
          const dx = pts[i+1].x - pts[i].x;
          const dy = pts[i+1].y - pts[i].y;
          const len = Math.hypot(dx, dy);
          if (len < 1e-9) continue;
          const t = Math.max(0, Math.min(1, ((pt.x - pts[i].x) * dx + (pt.y - pts[i].y) * dy) / (len * len)));
          const cx = pts[i].x + t * dx;
          const cy = pts[i].y + t * dy;
          if (Math.hypot(pt.x - cx, pt.y - cy) < tol) return true;
        }
        return false;
      }
      case 'arc': {
        const d = Math.hypot(pt.x - entity.center.x, pt.y - entity.center.y);
        if (Math.abs(d - entity.radius) > tol) return false;
        const angle = Math.atan2(pt.y - entity.center.y, pt.x - entity.center.x);
        let end = entity.endAngle;
        if (end <= entity.startAngle) end += Math.PI * 2;
        let a = angle;
        if (a < entity.startAngle) a += Math.PI * 2;
        return a >= entity.startAngle && a <= end;
      }
      default: return false;
    }
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: COLORS.background }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', cursor: isPanning ? 'grabbing' : 'crosshair' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
      />
      {/* Toolbar overlays */}
      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4 }}>
        <CanvasButton title="Zoom Fit" onClick={fitView}>⊡</CanvasButton>
        <CanvasButton title="Zoom In" onClick={() => dispatch({ type: 'SET_VIEWPORT', payload: { zoom: viewport.zoom * 1.4 } })}>+</CanvasButton>
        <CanvasButton title="Zoom Out" onClick={() => dispatch({ type: 'SET_VIEWPORT', payload: { zoom: viewport.zoom / 1.4 } })}>−</CanvasButton>
      </div>
      {entities.length === 0 && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', color: '#555577', textAlign: 'center', pointerEvents: 'none' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📐</div>
          <div style={{ fontSize: 16, fontFamily: 'sans-serif' }}>Import a DXF file to begin</div>
          <div style={{ fontSize: 12, marginTop: 6, opacity: 0.6 }}>File → Import DXF  or  Ctrl+I</div>
        </div>
      )}
    </div>
  );
}

function CanvasButton({ title, onClick, children }) {
  return (
    <button onClick={onClick} title={title} style={{ width: 28, height: 28, background: 'rgba(30,30,60,0.8)', border: '1px solid #444488', color: '#aaaacc', borderRadius: 4, cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </button>
  );
}
