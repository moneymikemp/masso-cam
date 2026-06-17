import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useApp } from '../../store/AppContext';
import { circleToPoints, arcToPoints, polylineToPoints } from '../../dxf/parser';
import { computeAutoTabPositions } from '../../cam/toolpath';

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
  medialAxis: '#ff00ff',
};

export default function CAMCanvas() {
  const canvasRef = useRef(null);
  const { state, dispatch } = useApp();
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [statusMsg, setStatusMsg] = useState('');
  const statusTimerRef = useRef(null);

  function showStatus(msg) {
    setStatusMsg(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatusMsg(''), 2000);
  }

  const { viewport, entities, layers, operations, selectedEntityIds, hoveredEntityId, showToolpaths, showRapids, bounds, stockConfig, tabPlacementActive, tabPlacementOpId, dogboneSelectionActive, dogboneSelectionOpId, textPlacementActive, textPlacementOpId, medialAxisPolylines } = state;

  const [zSliderPos, setZSliderPos] = useState(0); // 0 = all passes; 1..N = pass index
  const [isAnimating, setIsAnimating] = useState(false);
  const draggingTabRef = useRef(null); // { opId, tabIdx } when dragging a manual tab marker

  // Unique Z levels where cutting happens, sorted shallowest → deepest.
  const zLevels = useMemo(() => {
    const zSet = new Set();
    for (const op of operations) {
      if (!op.enabled || !op.toolpath) continue;
      const moveLists = op.toolpath.subToolpaths?.length > 0
        ? op.toolpath.subToolpaths.map(st => st.moves)
        : [op.toolpath.moves];
      for (const moves of moveLists) {
        if (!moves) continue;
        let curZ = 0;
        for (const m of moves) {
          if (m.z !== undefined) curZ = m.z;
          if (m.type === 'feed') zSet.add(Math.round(curZ * 1000) / 1000);
        }
      }
    }
    return [...zSet].sort((a, b) => b - a);
  }, [operations]);

  // Resolved index into zLevels (null = show all).
  const filterZIndex = zSliderPos === 0 ? null : zSliderPos - 1;

  // Reset slider whenever the toolpath depth structure changes.
  useEffect(() => {
    setZSliderPos(0);
    setIsAnimating(false);
  }, [zLevels.length]);

  // Step-by-step animation: advance one pass every 700 ms.
  useEffect(() => {
    if (!isAnimating) return;
    if (zSliderPos >= zLevels.length) { setIsAnimating(false); return; }
    const t = setTimeout(() => setZSliderPos(p => p + 1), 700);
    return () => clearTimeout(t);
  }, [isAnimating, zSliderPos, zLevels.length]);

  function togglePlay() {
    if (isAnimating) { setIsAnimating(false); }
    else { setZSliderPos(1); setIsAnimating(true); }
  }

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
    if (showToolpaths) {
      drawToolpaths(ctx);
      drawTextPreviews(ctx);
    }
    if (medialAxisPolylines?.length) drawMedialAxis(ctx);
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
    // Crosshair sits at the datum point, which may not be world (0,0) when
    // the stock has been fitted to the part without moving geometry.
    const ox = stockConfig?.stockOriginX ?? 0;
    const oy = stockConfig?.stockOriginY ?? 0;
    const o = w2c(ox, oy);
    const size = 12;
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(o.x, o.y - size); ctx.lineTo(o.x, o.y + size); ctx.stroke();
    ctx.strokeStyle = '#44ff44';
    ctx.beginPath(); ctx.moveTo(o.x - size, o.y); ctx.lineTo(o.x + size, o.y); ctx.stroke();
  }

  function drawStock(ctx) {
    if (!stockConfig || stockConfig.width <= 0 || stockConfig.length <= 0) return;
    // stockOriginX/Y is the world position of the datum point.
    // The stock rectangle is offset from it based on the datum fraction.
    const ox   = stockConfig.stockOriginX ?? 0;
    const oy   = stockConfig.stockOriginY ?? 0;
    const xOff = (stockConfig.datum[1] === 'l' ? 0 : stockConfig.datum[1] === 'c' ? 0.5 : 1) * stockConfig.width;
    const yOff = (stockConfig.datum[0] === 'b' ? 0 : stockConfig.datum[0] === 'm' ? 0.5 : 1) * stockConfig.length;
    const minX = ox - xOff,                    maxX = ox + stockConfig.width  - xOff;
    const minY = oy - yOff,                    maxY = oy + stockConfig.length - yOff;
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

  function drawMoveList(ctx, moves, baseCutColor) {
    const SNAP = 0.001;
    let prevX = 0, prevY = 0, curZ = 0;
    for (const move of moves) {
      const x = move.x ?? prevX;
      const y = move.y ?? prevY;
      if (move.z !== undefined) curZ = move.z;

      if (move.type === 'rapid') {
        // Hide rapid air-moves when a specific pass is selected — they're distracting.
        if (showRapids && filterZIndex === null) {
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
        const targetZ = filterZIndex !== null ? zLevels[filterZIndex] : null;
        const atTarget = targetZ === null || Math.abs(curZ - targetZ) <= SNAP;
        if (atTarget) {
          const isPlunge = (x === prevX && y === prevY);
          // Color each Z-level pass distinctly; plunges keep their orange marker.
          let cutColor = baseCutColor;
          if (!isPlunge && zLevels.length > 0) {
            const zi = zLevels.findIndex(zl => Math.abs(zl - curZ) < SNAP);
            if (zi >= 0) cutColor = passColor(zi, zLevels.length);
          }
          ctx.strokeStyle = isPlunge ? COLORS.toolpathPlunge : cutColor;
          ctx.lineWidth = filterZIndex !== null ? 1.5 : 1;
          ctx.setLineDash([]);
          ctx.beginPath();
          const s = w2c(prevX, prevY), e = w2c(x, y);
          ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
          ctx.stroke();
        }
      }
      // Always advance position so skipped moves don't corrupt subsequent start points.
      if (move.x !== undefined) prevX = x;
      if (move.y !== undefined) prevY = y;
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
      // Tab markers — drawn for ops that have tab params set, regardless of mode
      if (op.params?.tabs && op.toolpath.contours?.length) {
        drawTabMarkers(ctx, op);
      }
      // Dogbone corner markers — always shown when toolpath has candidate corners
      if (op.type === 'dogbone' && op.toolpath.candidateCorners?.length) {
        drawDogboneCorners(ctx, op);
      }
    }
    // When in manual placement mode, draw the active contour highlight even if
    // no tab markers exist yet (so the user can see what they're snapping to).
    if (tabPlacementActive && tabPlacementOpId) {
      const op = operations.find(o => o.id === tabPlacementOpId);
      if (op?.toolpath?.contours?.length) drawContourHighlight(ctx, op.toolpath.contours);
    }
  }

  // Draws orange tab markers (span + end-caps + centre crossbar) for one operation.
  function drawTabMarkers(ctx, op) {
    const p = op.params;
    const tValues = (p.tabMode === 'manual')
      ? (p.tabPositions || [])
      : computeAutoTabPositions(p.tabCount || 4);
    if (!tValues.length) return;

    for (const contour of op.toolpath.contours) {
      if (!contour || contour.length < 2) continue;

      // Arc-length table for this contour
      const n = contour.length;
      const cumLen = [0];
      for (let i = 0; i < n; i++) {
        const a = contour[i], b = contour[(i + 1) % n];
        cumLen.push(cumLen[i] + Math.hypot(b.x - a.x, b.y - a.y));
      }
      const totalLen = cumLen[n];
      if (totalLen < 1e-6) continue;

      function ptAndTangentAtT(t) {
        const s = ((t % 1) + 1) % 1 * totalLen;
        for (let i = 0; i < n; i++) {
          if (s <= cumLen[i + 1] + 1e-9) {
            const d = cumLen[i + 1] - cumLen[i];
            const frac = d > 1e-9 ? (s - cumLen[i]) / d : 0;
            const a = contour[i], b = contour[(i + 1) % n];
            return {
              x: a.x + frac * (b.x - a.x),
              y: a.y + frac * (b.y - a.y),
              tx: d > 1e-9 ? (b.x - a.x) / d : 1,
              ty: d > 1e-9 ? (b.y - a.y) / d : 0,
            };
          }
        }
        return { x: contour[0].x, y: contour[0].y, tx: 1, ty: 0 };
      }

      const tabWidth = p.tabWidth || 6;

      for (const t of tValues) {
        const { x, y, tx, ty } = ptAndTangentAtT(t);
        const halfW = Math.min(tabWidth / 2, totalLen / 4);

        // World-space tab span endpoints
        const s0w = { x: x - tx * halfW, y: y - ty * halfW };
        const s1w = { x: x + tx * halfW, y: y + ty * halfW };

        const cs0 = w2c(s0w.x, s0w.y);
        const cs1 = w2c(s1w.x, s1w.y);
        const cc  = w2c(x, y);

        // Screen-space normal (perpendicular to span, for end-caps and crossbar)
        const sdx = cs1.x - cs0.x, sdy = cs1.y - cs0.y;
        const slen = Math.hypot(sdx, sdy);
        const snx = slen > 1e-9 ? -sdy / slen : 0;
        const sny = slen > 1e-9 ?  sdx / slen : 1;

        const CAP = 5, BAR = 6; // pixels

        // Span line
        ctx.strokeStyle = '#ff8844';
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(cs0.x, cs0.y);
        ctx.lineTo(cs1.x, cs1.y);
        ctx.stroke();

        // End caps
        ctx.strokeStyle = '#ffaa66';
        ctx.lineWidth = 1.5;
        for (const c of [cs0, cs1]) {
          ctx.beginPath();
          ctx.moveTo(c.x + snx * CAP, c.y + sny * CAP);
          ctx.lineTo(c.x - snx * CAP, c.y - sny * CAP);
          ctx.stroke();
        }

        // Centre crossbar
        ctx.beginPath();
        ctx.moveTo(cc.x + snx * BAR, cc.y + sny * BAR);
        ctx.lineTo(cc.x - snx * BAR, cc.y - sny * BAR);
        ctx.stroke();
      }
    }
  }

  // Draws a soft highlight around the contour(s) of the active placement operation.
  function drawContourHighlight(ctx, contours) {
    ctx.strokeStyle = 'rgba(153, 68, 255, 0.45)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    for (const contour of contours) {
      if (!contour.length) continue;
      ctx.beginPath();
      const first = w2c(contour[0].x, contour[0].y);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < contour.length; i++) {
        const p = w2c(contour[i].x, contour[i].y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function drawDogboneCorners(ctx, op) {
    const candidates = op.toolpath?.candidateCorners;
    if (!candidates?.length) return;
    const p = op.params || {};
    const autoMode = (p.cornerMode || 'auto') === 'auto';
    const selected = p.selectedCorners || [];
    const toolR = (p.toolDiameter || 6.35) / 2;

    if ((dogboneSelectionActive && dogboneSelectionOpId === op.id) || autoMode) {
      if (op.toolpath?.contours?.length) drawContourHighlight(ctx, op.toolpath.contours);
    }

    for (const c of candidates) {
      const sc = w2c(c.x, c.y);
      const isActive = autoMode || selected.some(s => Math.hypot(s.x - c.x, s.y - c.y) < 0.1);

      ctx.beginPath();
      ctx.arc(sc.x, sc.y, 4, 0, Math.PI * 2);
      if (isActive) {
        ctx.fillStyle = '#44ff88';
        ctx.fill();
      } else {
        ctx.strokeStyle = '#778899';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (isActive) {
        const dc = w2c(c.x + toolR * c.bisX, c.y + toolR * c.bisY);
        const screenR = Math.max(2, toolR * viewport.zoom);
        ctx.strokeStyle = 'rgba(68, 255, 136, 0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(dc.x, dc.y, screenR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(68, 255, 136, 0.6)';
        ctx.beginPath();
        ctx.arc(dc.x, dc.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawTextPreviews(ctx) {
    for (const op of operations) {
      if (op.type !== 'text' || !op.enabled) continue;
      const tp = op.params;
      if (!tp.textContoursRel?.length) continue;
      const tx = tp.textX || 0, ty = tp.textY || 0;
      const isActive = textPlacementActive && textPlacementOpId === op.id;

      ctx.strokeStyle = isActive ? 'rgba(68,255,136,0.85)' : 'rgba(80,160,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);

      for (const group of tp.textContoursRel) {
        for (const contour of group) {
          if (contour.length < 2) continue;
          ctx.beginPath();
          const f = w2c(contour[0].x + tx, contour[0].y + ty);
          ctx.moveTo(f.x, f.y);
          for (let i = 1; i < contour.length; i++) {
            const pt = w2c(contour[i].x + tx, contour[i].y + ty);
            ctx.lineTo(pt.x, pt.y);
          }
          ctx.closePath();
          ctx.stroke();
        }
      }

      if (tp.textBoundsRel) {
        const b = tp.textBoundsRel;
        const tl = w2c(b.minX + tx, b.maxY + ty);
        const br = w2c(b.maxX + tx, b.minY + ty);
        ctx.strokeStyle = isActive ? 'rgba(68,255,136,0.35)' : 'rgba(80,160,255,0.25)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        ctx.setLineDash([]);
      }
    }
  }

  function drawMedialAxis(ctx) {
    if (!medialAxisPolylines?.length) return;
    ctx.setLineDash([]);
    for (let pi = 0; pi < medialAxisPolylines.length; pi++) {
      const poly = medialAxisPolylines[pi];
      if (!poly || poly.length < 2) continue;
      // Fade from semi-transparent (outermost, earliest fractions) to opaque (innermost)
      const alpha = 0.35 + 0.65 * (pi / Math.max(medialAxisPolylines.length - 1, 1));
      ctx.strokeStyle = `rgba(255,0,255,${alpha.toFixed(2)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const f = w2c(poly[0].x, poly[0].y);
      ctx.moveTo(f.x, f.y);
      for (let i = 1; i < poly.length; i++) {
        const p = w2c(poly[i].x, poly[i].y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
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

  useEffect(() => { draw(); }, [entities, layers, operations, viewport, selectedEntityIds, hoveredEntityId, showToolpaths, showRapids, mousePos, stockConfig, zSliderPos, zLevels, tabPlacementActive, tabPlacementOpId, dogboneSelectionActive, dogboneSelectionOpId, textPlacementActive, textPlacementOpId, medialAxisPolylines]);

  // Mouse events
  const onMouseDown = useCallback((e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - viewport.panX, y: e.clientY - viewport.panY });
      return;
    }

    const canvas = canvasRef.current;
    const rect   = canvas.getBoundingClientRect();
    const cx     = e.clientX - rect.left;
    const cy     = e.clientY - rect.top;
    const world  = c2w(cx, cy);

    // ── Tab placement / drag mode ──────────────────────────────────────────
    if (tabPlacementActive && tabPlacementOpId) {
      const op = operations.find(o => o.id === tabPlacementOpId);
      if (op?.toolpath?.contours?.length) {
        const snapR = 20 / viewport.zoom; // world-space snap radius
        const { t, x: sx, y: sy } = snapToContour(world, op.toolpath.contours);

        if (e.button === 0) {
          const existing = (op.params.tabPositions || []);
          // Check if click is near an existing tab marker (for drag or remove)
          let nearestIdx = -1, nearestDist = Infinity;
          for (let i = 0; i < existing.length; i++) {
            const ep = tabWorldPosForT(existing[i], op.toolpath.contours);
            const d  = ep ? Math.hypot(ep.x - world.x, ep.y - world.y) : Infinity;
            if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
          }
          if (nearestIdx >= 0 && nearestDist < snapR) {
            // Start dragging existing tab
            draggingTabRef.current = { opId: tabPlacementOpId, tabIdx: nearestIdx };
          } else {
            // Place new tab
            dispatch({ type: 'UPDATE_TAB_POSITIONS', payload: { opId: tabPlacementOpId, positions: [...existing, t] } });
            showStatus(`Tab placed (${existing.length + 1} total)`);
          }
        } else if (e.button === 2) {
          // Right-click: remove nearest tab
          const existing = (op.params.tabPositions || []);
          let nearestIdx = -1, nearestDist = Infinity;
          for (let i = 0; i < existing.length; i++) {
            const ep = tabWorldPosForT(existing[i], op.toolpath.contours);
            const d  = ep ? Math.hypot(ep.x - world.x, ep.y - world.y) : Infinity;
            if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
          }
          if (nearestIdx >= 0 && nearestDist < snapR) {
            const updated = existing.filter((_, i) => i !== nearestIdx);
            dispatch({ type: 'UPDATE_TAB_POSITIONS', payload: { opId: tabPlacementOpId, positions: updated } });
            showStatus(`Tab removed (${updated.length} remaining)`);
          }
        }
        return; // don't fall through to entity selection
      }
    }

    // ── Dogbone corner selection ───────────────────────────────────────────
    if (dogboneSelectionActive && dogboneSelectionOpId && e.button === 0) {
      const op = operations.find(o => o.id === dogboneSelectionOpId);
      const candidates = op?.toolpath?.candidateCorners;
      if (candidates?.length) {
        const snapR = 15 / viewport.zoom;
        let nearestIdx = -1, nearestDist = Infinity;
        for (let i = 0; i < candidates.length; i++) {
          const d = Math.hypot(candidates[i].x - world.x, candidates[i].y - world.y);
          if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
        }
        if (nearestIdx >= 0 && nearestDist < snapR) {
          const clicked = candidates[nearestIdx];
          const existing = op.params.selectedCorners || [];
          const alreadyIdx = existing.findIndex(s => Math.hypot(s.x - clicked.x, s.y - clicked.y) < 0.1);
          let updated;
          if (alreadyIdx >= 0) {
            updated = existing.filter((_, i) => i !== alreadyIdx);
            showStatus(`Corner deselected (${updated.length} selected)`);
          } else {
            updated = [...existing, { x: clicked.x, y: clicked.y, bisX: clicked.bisX, bisY: clicked.bisY }];
            showStatus(`Corner selected (${updated.length} selected)`);
          }
          dispatch({ type: 'UPDATE_DOGBONE_CORNERS', payload: { opId: dogboneSelectionOpId, corners: updated } });
        }
        return;
      }
    }

    // ── Text placement ─────────────────────────────────────────────────────
    if (textPlacementActive && textPlacementOpId && e.button === 0) {
      const textOp = operations.find(o => o.id === textPlacementOpId);
      if (textOp) {
        dispatch({ type: 'UPDATE_OPERATION', payload: {
          id: textPlacementOpId,
          changes: { params: { ...textOp.params, textX: world.x, textY: world.y } },
        }});
        dispatch({ type: 'SET_TEXT_PLACEMENT', payload: { active: false, opId: null } });
        showStatus(`Text placed at (${world.x.toFixed(1)}, ${world.y.toFixed(1)})`);
      }
      return;
    }

    // ── Normal entity selection ────────────────────────────────────────────
    if (e.button === 0) {
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
  }, [viewport, c2w, dispatch, tabPlacementActive, tabPlacementOpId, dogboneSelectionActive, dogboneSelectionOpId, textPlacementActive, textPlacementOpId, operations]);

  const onMouseMove = useCallback((e) => {
    const canvas = canvasRef.current;
    const rect   = canvas.getBoundingClientRect();
    const cx     = e.clientX - rect.left;
    const cy     = e.clientY - rect.top;
    setMousePos({ x: cx, y: cy });

    if (isPanning) {
      dispatch({ type: 'SET_VIEWPORT', payload: { panX: e.clientX - panStart.x, panY: e.clientY - panStart.y } });
      return;
    }

    // Drag an existing tab marker
    if (draggingTabRef.current) {
      const { opId, tabIdx } = draggingTabRef.current;
      const op = operations.find(o => o.id === opId);
      if (op?.toolpath?.contours?.length) {
        const world = c2w(cx, cy);
        const { t } = snapToContour(world, op.toolpath.contours);
        const updated = [...(op.params.tabPositions || [])];
        updated[tabIdx] = t;
        dispatch({ type: 'UPDATE_TAB_POSITIONS', payload: { opId, positions: updated } });
      }
      return;
    }

    const world = c2w(cx, cy);
    const hit = findEntityAt(world, 8 / viewport.zoom);
    dispatch({ type: 'HOVER_ENTITY', payload: hit?.id || null });
  }, [isPanning, panStart, viewport, c2w, dispatch, operations]);

  const onMouseUp = useCallback(() => {
    setIsPanning(false);
    draggingTabRef.current = null;
  }, []);

  const onDoubleClick = useCallback((e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const world = c2w(e.clientX - rect.left, e.clientY - rect.top);
    const hit = findEntityAt(world, 10 / viewport.zoom);
    if (!hit || !['line', 'arc', 'polyline'].includes(hit.type)) return;

    const connectedIds = findConnectedEntities(hit, entities, layers);
    dispatch({ type: 'SELECT_ENTITIES', payload: connectedIds });
    if (connectedIds.length > 1) {
      showStatus(`Selected ${connectedIds.length} connected entities`);
    }
  }, [viewport, c2w, entities, layers, dispatch]);

  const onWheelRef = useRef(null);
  onWheelRef.current = (e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
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
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e) => onWheelRef.current(e);
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, []);

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
        style={{ width: '100%', height: '100%', display: 'block',
          cursor: isPanning ? 'grabbing' : (tabPlacementActive || dogboneSelectionActive || textPlacementActive) ? 'cell' : 'crosshair' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={e => { if (tabPlacementActive || dogboneSelectionActive || textPlacementActive) e.preventDefault(); }}
      />
      {/* Toolbar overlays */}
      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4 }}>
        <CanvasButton title="Zoom Fit" onClick={fitView}>⊡</CanvasButton>
        <CanvasButton title="Zoom In" onClick={() => dispatch({ type: 'SET_VIEWPORT', payload: { zoom: viewport.zoom * 1.4 } })}>+</CanvasButton>
        <CanvasButton title="Zoom Out" onClick={() => dispatch({ type: 'SET_VIEWPORT', payload: { zoom: viewport.zoom / 1.4 } })}>−</CanvasButton>
      </div>
      {showToolpaths && zLevels.length > 0 && (
        <div style={{ position: 'absolute', bottom: 32, left: '50%', transform: 'translateX(-50%)', background: 'rgba(10,10,30,0.88)', border: '1px solid #2a2a50', borderRadius: 6, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'all', userSelect: 'none' }}>
          <button
            onClick={togglePlay}
            title={isAnimating ? 'Stop' : 'Play through passes'}
            style={{ width: 22, height: 22, background: '#111128', border: '1px solid #4444aa', color: '#aaaacc', borderRadius: 3, cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0 }}
          >
            {isAnimating ? '⏹' : '▶'}
          </button>
          <input
            type="range" min={0} max={zLevels.length} value={Math.min(zSliderPos, zLevels.length)}
            style={{ width: 160, cursor: 'pointer', accentColor: filterZIndex !== null ? passColor(filterZIndex, zLevels.length) : '#5566ff' }}
            onChange={e => { setIsAnimating(false); setZSliderPos(Number(e.target.value)); }}
          />
          {zSliderPos === 0
            ? <span style={{ color: '#666688', fontSize: 11, fontFamily: 'monospace', minWidth: 112 }}>all passes</span>
            : <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#ccccee', minWidth: 112, display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 9, height: 9, borderRadius: 2, background: passColor(filterZIndex, zLevels.length), flexShrink: 0 }} />
                {`Z${(zLevels[filterZIndex] ?? 0).toFixed(2)}  ${zSliderPos}/${zLevels.length}`}
              </div>}
        </div>
      )}
      {statusMsg && (
        <div style={{ position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.75)', color: '#ffcc44', padding: '5px 14px', borderRadius: 4, fontSize: 12, pointerEvents: 'none', whiteSpace: 'nowrap', border: '1px solid rgba(255,204,68,0.3)' }}>
          {statusMsg}
        </div>
      )}
      {entities.length === 0 && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', color: '#555577', textAlign: 'center', pointerEvents: 'none' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📐</div>
          <div style={{ fontSize: 16, fontFamily: 'sans-serif' }}>Import a DXF file to begin</div>
          <div style={{ fontSize: 12, marginTop: 6, opacity: 0.6 }}>File → Import DXF  or  Ctrl+I</div>
        </div>
      )}
      {tabPlacementActive && (
        <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', background: 'rgba(80,20,120,0.88)', color: '#cc88ff', padding: '4px 14px', borderRadius: 4, fontSize: 11, pointerEvents: 'none', border: '1px solid rgba(153,68,255,0.5)', whiteSpace: 'nowrap' }}>
          Left-click to place tab · Right-click to remove · Drag to reposition
        </div>
      )}
      {dogboneSelectionActive && (
        <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', background: 'rgba(10,50,30,0.88)', color: '#44ff88', padding: '4px 14px', borderRadius: 4, fontSize: 11, pointerEvents: 'none', border: '1px solid rgba(68,255,136,0.4)', whiteSpace: 'nowrap' }}>
          Click corners to toggle dogbone fillets
        </div>
      )}
      {textPlacementActive && (
        <div style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', background: 'rgba(10,30,60,0.88)', color: '#88ccff', padding: '4px 14px', borderRadius: 4, fontSize: 11, pointerEvents: 'none', border: '1px solid rgba(80,160,255,0.4)', whiteSpace: 'nowrap' }}>
          Click to place text origin (baseline of first line)
        </div>
      )}
    </div>
  );
}

// Snap world-point to the nearest point on any of the given closed contour polygons.
// Returns { t: 0..1, x, y } where t is the arc-fraction along the closest contour.
function snapToContour(worldPt, contours) {
  let bestDist = Infinity, bestT = 0, bestX = 0, bestY = 0;
  for (const contour of contours) {
    if (!contour || contour.length < 2) continue;
    const n = contour.length;
    const cumLen = [0];
    for (let i = 0; i < n; i++) {
      const a = contour[i], b = contour[(i + 1) % n];
      cumLen.push(cumLen[i] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const totalLen = cumLen[n];
    if (totalLen < 1e-6) continue;
    for (let i = 0; i < n; i++) {
      const a = contour[i], b = contour[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const t  = Math.max(0, Math.min(1, ((worldPt.x - a.x) * dx + (worldPt.y - a.y) * dy) / (len * len)));
      const cx = a.x + t * dx, cy = a.y + t * dy;
      const d  = Math.hypot(worldPt.x - cx, worldPt.y - cy);
      if (d < bestDist) {
        bestDist = d;
        bestX = cx; bestY = cy;
        bestT = (cumLen[i] + t * len) / totalLen;
      }
    }
  }
  return { t: bestT, x: bestX, y: bestY };
}

// Return the world-space XY of a tab at arc-fraction t on the given contours.
function tabWorldPosForT(t, contours) {
  for (const contour of contours) {
    if (!contour || contour.length < 2) continue;
    const n = contour.length;
    const cumLen = [0];
    for (let i = 0; i < n; i++) {
      const a = contour[i], b = contour[(i + 1) % n];
      cumLen.push(cumLen[i] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    const totalLen = cumLen[n];
    if (totalLen < 1e-6) continue;
    const s = ((t % 1) + 1) % 1 * totalLen;
    for (let i = 0; i < n; i++) {
      if (s <= cumLen[i + 1] + 1e-9) {
        const d    = cumLen[i + 1] - cumLen[i];
        const frac = d > 1e-9 ? (s - cumLen[i]) / d : 0;
        const a    = contour[i], b = contour[(i + 1) % n];
        return { x: a.x + frac * (b.x - a.x), y: a.y + frac * (b.y - a.y) };
      }
    }
  }
  return null;
}

// Maps a pass index to a distinct hue: red (shallow) → blue (deep).
function passColor(index, total) {
  const hue = Math.round((index / Math.max(total - 1, 1)) * 270);
  return `hsl(${hue}, 85%, 55%)`;
}

// Returns the two connectable endpoint positions for line/arc/polyline.
// Circles have no endpoints and return [].
function getEndpoints(entity) {
  switch (entity.type) {
    case 'line':
      return [entity.start, entity.end];
    case 'arc': {
      const { center, radius, startAngle, endAngle } = entity;
      return [
        { x: center.x + radius * Math.cos(startAngle), y: center.y + radius * Math.sin(startAngle) },
        { x: center.x + radius * Math.cos(endAngle),   y: center.y + radius * Math.sin(endAngle)   },
      ];
    }
    case 'polyline': {
      if (!entity.vertices?.length) return [];
      const first = entity.vertices[0];
      const last  = entity.vertices[entity.vertices.length - 1];
      return [{ x: first.x, y: first.y }, { x: last.x, y: last.y }];
    }
    default:
      return [];
  }
}

// BFS walk: starting from startEntity, follow endpoint connections (within 0.01 mm)
// through all visible line/arc/polyline entities and return the complete set of IDs.
function findConnectedEntities(startEntity, allEntities, allLayers) {
  const SNAP = 0.01;
  function ptDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // Pre-compute endpoints for every chainable, visible entity.
  const candidates = allEntities
    .filter(e => {
      if (!['line', 'arc', 'polyline'].includes(e.type)) return false;
      const layer = allLayers[e.layer];
      return !(layer && !layer.visible);
    })
    .map(e => ({ id: e.id, pts: getEndpoints(e) }))
    .filter(c => c.pts.length > 0);

  const selected = new Set([startEntity.id]);
  // The frontier is the set of open endpoints we still need to match against.
  let searchPts = getEndpoints(startEntity);

  while (searchPts.length > 0) {
    const nextPts = [];
    for (const sp of searchPts) {
      for (const cand of candidates) {
        if (selected.has(cand.id)) continue;
        for (const cp of cand.pts) {
          if (ptDist(sp, cp) <= SNAP) {
            selected.add(cand.id);
            // The other endpoint(s) of the newly added segment become new search points.
            nextPts.push(...cand.pts.filter(p => ptDist(p, sp) > SNAP));
            break;
          }
        }
      }
    }
    searchPts = nextPts;
  }

  return [...selected];
}

function CanvasButton({ title, onClick, children }) {
  return (
    <button onClick={onClick} title={title} style={{ width: 28, height: 28, background: 'rgba(30,30,60,0.8)', border: '1px solid #444488', color: '#aaaacc', borderRadius: 4, cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </button>
  );
}
