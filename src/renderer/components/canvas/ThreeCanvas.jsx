import React, { useEffect, useRef, useCallback, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { useApp } from '../../store/AppContext';

// Coordinate mapping: world (X right, Y forward, Z up) → Three.js (X right, Y up, Z toward viewer)
function wx(x) { return x; }
function wy(z) { return z ?? 0; }
function wz(y) { return -(y ?? 0); }

const COLORS = {
  bg:        0x0a0a1e,
  grid1:     0x1a1a36,
  grid2:     0x141428,
  stockFace: 0x1a2a40,
  stockEdge: 0x3355aa,
  rapid:     0x2a3a5a,
  plunge:    0xcc6622,
};

const OP_PALETTE = [
  0x22aaaa, 0x44cc55, 0xdd4444, 0xddcc22, 0x4488dd,
  0xcc44cc, 0xdd8822, 0x44ccaa, 0xaa55dd, 0xdd6644,
];

// ── Geometry builders ────────────────────────────────────────────────────────

function buildStockMesh(stockConfig) {
  const { width, length, thickness, topZ, datum,
          stockOriginX: ox = 0, stockOriginY: oy = 0 } = stockConfig;
  if (!width || !length || !thickness) return null;

  const xFrac = datum[1] === 'l' ? 0 : datum[1] === 'c' ? 0.5 : 1;
  const yFrac = datum[0] === 'b' ? 0 : datum[0] === 'm' ? 0.5 : 1;
  const minX  = ox - xFrac * width,  maxX = minX + width;
  const minY  = oy - yFrac * length, maxY = minY + length;
  const minZ  = topZ - thickness,    maxZ = topZ;

  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const geo  = new THREE.BoxGeometry(width, thickness, length);
  const mat  = new THREE.MeshBasicMaterial({ color: COLORS.stockFace, opacity: 0.18, transparent: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(wx(cx), wy(cz), wz(cy));

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: COLORS.stockEdge, opacity: 0.6, transparent: true }),
  );
  edges.position.copy(mesh.position);

  const group = new THREE.Group();
  group.add(mesh); group.add(edges);
  group.userData.managed = true;
  return { group, bounds: { minX, maxX, minY, maxY, minZ, maxZ } };
}

function computeZLevels(operations) {
  const zSet = new Set();
  for (const op of operations) {
    if (!op.enabled || !op.toolpath) continue;
    const moveLists = op.toolpath.subToolpaths?.length
      ? op.toolpath.subToolpaths.map(st => st.moves) : [op.toolpath.moves];
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
}

function buildToolpathLines(operations, showRapids, zSliderPos) {
  const SNAP = 0.001;
  const zLevels = computeZLevels(operations);
  const filterZIndex = zSliderPos === 0 ? null : zSliderPos - 1;
  const groups = [];
  let opIdx = 0;

  for (const op of operations) {
    if (!op.enabled || !op.toolpath) continue;
    const feedColor = OP_PALETTE[opIdx % OP_PALETTE.length];
    opIdx++;

    const moveLists = op.toolpath.subToolpaths?.length
      ? op.toolpath.subToolpaths.map(st => st.moves) : [op.toolpath.moves];

    for (const moves of moveLists) {
      if (!moves?.length) continue;
      const rapidVerts = [], feedVerts = [], plungeVerts = [];
      let px = 0, py = 0, pz = 0;

      for (const m of moves) {
        const x = m.x ?? px, y = m.y ?? py, z = m.z ?? pz;
        if (m.type === 'rapid') {
          if (showRapids && filterZIndex === null)
            rapidVerts.push(wx(px), wy(pz), wz(py), wx(x), wy(z), wz(y));
        } else if (m.type === 'feed') {
          const zi = zLevels.findIndex(zl => Math.abs(zl - z) < SNAP);
          const inRange = filterZIndex === null || (zi >= 0 && zi <= filterZIndex);
          if (inRange) {
            const isPlunge = x === px && y === py && z !== pz;
            (isPlunge ? plungeVerts : feedVerts).push(wx(px), wy(pz), wz(py), wx(x), wy(z), wz(y));
          }
        }
        px = x; py = y; pz = z;
      }

      const addSegs = (verts, color) => {
        if (verts.length < 6) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        const s = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
        s.userData.managed = true;
        groups.push(s);
      };
      addSegs(rapidVerts,  COLORS.rapid);
      addSegs(feedVerts,   feedColor);
      addSegs(plungeVerts, COLORS.plunge);
    }
  }
  return groups;
}

// Build flat waypoint list for simulation — one entry per move segment
function buildWaypoints(operations) {
  const waypoints = [];
  let cumDist = 0, px = 0, py = 0, pz = 0;

  for (const op of operations) {
    if (!op.enabled || !op.toolpath) continue;
    const moveLists = op.toolpath.subToolpaths?.length
      ? op.toolpath.subToolpaths.map(st => st.moves) : [op.toolpath.moves];

    for (const moves of moveLists) {
      if (!moves?.length) continue;
      for (const m of moves) {
        const x = m.x ?? px, y = m.y ?? py, z = m.z ?? pz;
        const segDist = Math.hypot(x - px, y - py, z - pz);
        if (segDist > 0.001) {
          cumDist += segDist;
          waypoints.push({ fx: px, fy: py, fz: pz, tx: x, ty: y, tz: z, segDist, cumDist });
        }
        px = x; py = y; pz = z;
      }
    }
  }
  return { waypoints, totalDist: cumDist };
}

// Find interpolated tool position at distance `dist` along the waypoints
function interpolatePosition(dist, waypoints) {
  if (!waypoints.length) return null;
  let lo = 0, hi = waypoints.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (waypoints[mid].cumDist < dist) lo = mid + 1; else hi = mid;
  }
  const seg = waypoints[lo];
  const t = seg.segDist > 0 ? Math.max(0, Math.min(1, (dist - (seg.cumDist - seg.segDist)) / seg.segDist)) : 0;
  return {
    x: seg.fx + (seg.tx - seg.fx) * t,
    y: seg.fy + (seg.ty - seg.fy) * t,
    z: seg.fz + (seg.tz - seg.fz) * t,
  };
}

// ── Component ────────────────────────────────────────────────────────────────

const BTN = {
  background: '#111128', border: '1px solid #2a2a50', color: '#8888cc',
  borderRadius: 3, padding: '4px 8px', fontSize: 11, cursor: 'pointer',
};
const BTN_ACTIVE = { ...BTN, background: '#1a1a48', borderColor: '#5555cc', color: '#bbbbff' };

export default function ThreeCanvas() {
  const { state } = useApp();
  const { operations, stockConfig, showToolpaths, showRapids, zSliderPos } = state;

  const mountRef    = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef    = useRef(null);
  const cameraRef   = useRef(null);
  const controlsRef = useRef(null);
  const frameRef    = useRef(null);
  const fittedRef   = useRef(false);

  // Simulation — all mutable state lives in a ref so the RAF loop never has stale closures
  const waypointsRef = useRef({ waypoints: [], totalDist: 0 });
  const simRef       = useRef({ playing: false, dist: 0, speed: 500 }); // speed = mm/s
  const toolSphereRef    = useRef(null);
  const lastTimeRef      = useRef(null);
  const progressBarRef   = useRef(null); // container for pointer events
  const progressFillRef  = useRef(null); // fill div — updated directly from RAF
  const progressLabelRef = useRef(null); // text label — updated directly from RAF
  const isDraggingRef    = useRef(false);

  // React state only for UI re-renders
  const [simPlaying, setSimPlaying] = useState(false);
  const [simSpeed,   setSimSpeed]   = useState(500); // mm/s

  // Keep simRef.speed in sync with slider
  useEffect(() => { simRef.current.speed = simSpeed; }, [simSpeed]);

  const fitCamera = useCallback((bounds) => {
    const camera = cameraRef.current, controls = controlsRef.current;
    if (!camera || !controls || !bounds) return;
    const cx = wx((bounds.minX + bounds.maxX) / 2);
    const cy = wy((bounds.minZ + bounds.maxZ) / 2);
    const cz = wz((bounds.minY + bounds.maxY) / 2);
    const size = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ, bounds.maxY - bounds.minY, 10);
    controls.target.set(cx, cy, cz);
    camera.position.set(cx + size * 0.9, cy + size * 0.7, cz + size * 0.9);
    controls.update();
  }, []);

  // Mount: renderer, scene, camera, controls, grid, tool sphere
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.bg);
    sceneRef.current = scene;

    const w = mount.clientWidth || 800, h = mount.clientHeight || 600;
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 50000);
    camera.position.set(200, 200, 200);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controlsRef.current = controls;

    scene.add(new THREE.GridHelper(1000, 50, COLORS.grid1, COLORS.grid2));
    scene.add(new THREE.AxesHelper(25));
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(200, 400, 200);
    scene.add(dir);

    // Tool sphere — persistent, repositioned each frame during simulation
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(4, 16, 12),
      new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: 0x888800, shininess: 80 }),
    );
    sphere.visible = false;
    scene.add(sphere);
    toolSphereRef.current = sphere;

    lastTimeRef.current = performance.now();

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);

      const now = performance.now();
      const dt  = Math.min((now - lastTimeRef.current) / 1000, 0.1); // cap at 100ms
      lastTimeRef.current = now;

      // Advance simulation
      const sim = simRef.current;
      const { waypoints, totalDist } = waypointsRef.current;
      if (sim.playing && waypoints.length > 0) {
        sim.dist = Math.min(sim.dist + sim.speed * dt, totalDist);
        const pos = interpolatePosition(sim.dist, waypoints);
        if (pos && toolSphereRef.current) {
          toolSphereRef.current.position.set(wx(pos.x), wy(pos.z), wz(pos.y));
          toolSphereRef.current.visible = true;
        }
        if (sim.dist >= totalDist) {
          sim.playing = false;
          setSimPlaying(false);
        }
      }

      // Update progress bar DOM directly — avoid triggering React re-renders
      if (totalDist > 0) {
        const pct = Math.min(sim.dist / totalDist, 1);
        if (progressFillRef.current)
          progressFillRef.current.style.width = `${(pct * 100).toFixed(1)}%`;
        if (progressLabelRef.current) {
          const d = sim.dist, td = totalDist;
          const fmt = v => v >= 1000 ? `${(v / 1000).toFixed(2)}m` : `${v.toFixed(0)}mm`;
          progressLabelRef.current.textContent = `${(pct * 100).toFixed(0)}%  ·  ${fmt(d)} / ${fmt(td)}`;
        }
      }

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const ro = new ResizeObserver(() => {
      const nw = mount.clientWidth, nh = mount.clientHeight;
      if (!nw || !nh) return;
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    });
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      sceneRef.current = cameraRef.current = controlsRef.current = rendererRef.current = null;
      fittedRef.current = false;
    };
  }, []);

  // Rebuild geometry + waypoints when data changes
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove old managed objects
    const toRemove = scene.children.filter(c => c.userData.managed);
    for (const obj of toRemove) {
      scene.remove(obj);
      obj.traverse(child => {
        child.geometry?.dispose();
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(m => m?.dispose());
      });
    }

    let firstBounds = null;
    const stockResult = buildStockMesh(stockConfig);
    if (stockResult) { scene.add(stockResult.group); firstBounds = stockResult.bounds; }

    if (showToolpaths) {
      buildToolpathLines(operations, showRapids, zSliderPos).forEach(l => scene.add(l));
    }

    // Rebuild waypoints and reset simulation position
    waypointsRef.current = buildWaypoints(operations);
    simRef.current.dist    = 0;
    simRef.current.playing = false;
    setSimPlaying(false);
    if (toolSphereRef.current) toolSphereRef.current.visible = false;

    if (!fittedRef.current && firstBounds) {
      fittedRef.current = true;
      fitCamera(firstBounds);
    }
  }, [operations, stockConfig, showToolpaths, showRapids, zSliderPos, fitCamera]);

  // Simulation controls
  const handlePlayPause = () => {
    const sim = simRef.current;
    const { totalDist } = waypointsRef.current;
    if (!totalDist) return;
    if (sim.dist >= totalDist) { sim.dist = 0; } // auto-rewind at end
    sim.playing = !sim.playing;
    setSimPlaying(sim.playing);
    if (sim.playing && toolSphereRef.current) toolSphereRef.current.visible = true;
  };

  const handleReset = () => {
    simRef.current.dist    = 0;
    simRef.current.playing = false;
    setSimPlaying(false);
    if (toolSphereRef.current) {
      const { waypoints } = waypointsRef.current;
      if (waypoints.length) {
        const p = waypoints[0];
        toolSphereRef.current.position.set(wx(p.fx), wy(p.fz), wz(p.fy));
        toolSphereRef.current.visible = true;
      } else {
        toolSphereRef.current.visible = false;
      }
    }
  };

  const seekTo = useCallback((clientX) => {
    if (!progressBarRef.current) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const { waypoints, totalDist } = waypointsRef.current;
    if (!totalDist) return;
    simRef.current.dist = pct * totalDist;
    const pos = interpolatePosition(simRef.current.dist, waypoints);
    if (pos && toolSphereRef.current) {
      toolSphereRef.current.position.set(wx(pos.x), wy(pos.z), wz(pos.y));
      toolSphereRef.current.visible = true;
    }
  }, []);

  const handleProgressPointerDown = useCallback((e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    isDraggingRef.current = true;
    seekTo(e.clientX);
  }, [seekTo]);

  const handleProgressPointerMove = useCallback((e) => {
    if (!isDraggingRef.current) return;
    seekTo(e.clientX);
  }, [seekTo]);

  const handleProgressPointerUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  const handleFit = () => {
    fittedRef.current = false;
    const r = buildStockMesh(stockConfig);
    if (r) fitCamera(r.bounds);
  };

  const hasToolpath = waypointsRef.current.totalDist > 0;
  const speedLabel  = simSpeed >= 1000 ? `${(simSpeed / 1000).toFixed(1)}m/s` : `${simSpeed}mm/s`;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />

      {/* HUD — top right */}
      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
        <button onClick={handleFit} style={BTN} title="Fit view to stock">⊡ Fit</button>

        {/* Simulation controls */}
        <div style={{ background: 'rgba(8,8,28,0.92)', border: '1px solid #2a2a50', borderRadius: 4, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={handlePlayPause}
              style={simPlaying ? BTN_ACTIVE : BTN}
              title={simPlaying ? 'Pause simulation' : 'Play simulation'}
              disabled={!hasToolpath}
            >{simPlaying ? '⏸ Pause' : '▶ Play'}</button>
            <button onClick={handleReset} style={BTN} title="Reset to start" disabled={!hasToolpath}>⏹</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 9, color: '#555577', width: 36 }}>Speed</span>
            <input
              type="range" min={50} max={5000} step={50}
              value={simSpeed}
              onChange={e => setSimSpeed(Number(e.target.value))}
              style={{ width: 80, accentColor: '#5566aa' }}
            />
            <span style={{ fontSize: 9, color: '#8888aa', width: 40, textAlign: 'right' }}>{speedLabel}</span>
          </div>

          {/* Scrubable progress bar */}
          {hasToolpath && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div
                ref={progressBarRef}
                onPointerDown={handleProgressPointerDown}
                onPointerMove={handleProgressPointerMove}
                onPointerUp={handleProgressPointerUp}
                style={{ position: 'relative', width: '100%', height: 8, background: '#111130', borderRadius: 4, cursor: 'pointer', overflow: 'hidden' }}
              >
                <div
                  ref={progressFillRef}
                  style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: '0%', background: '#4455cc', borderRadius: 4, pointerEvents: 'none' }}
                />
              </div>
              <div ref={progressLabelRef} style={{ fontSize: 9, color: '#555577', textAlign: 'center' }}>
                0%  ·  0mm / 0mm
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Legend — bottom left */}
      <div style={{ position: 'absolute', bottom: 8, left: 8, background: 'rgba(8,8,24,0.75)', border: '1px solid #1a1a38', borderRadius: 4, padding: '5px 8px', fontSize: 10, color: '#666688', lineHeight: 1.8, maxHeight: '40vh', overflowY: 'auto' }}>
        {operations.filter(op => op.enabled && op.toolpath).map((op, i) => {
          const hex = '#' + OP_PALETTE[i % OP_PALETTE.length].toString(16).padStart(6, '0');
          return (
            <div key={op.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ color: hex, fontSize: 13, lineHeight: 1 }}>■</span>
              <span style={{ color: '#8888aa' }}>{op.name || `Op ${i + 1}`}</span>
            </div>
          );
        })}
        <div style={{ borderTop: '1px solid #1a1a38', marginTop: 3, paddingTop: 3 }}>
          <div><span style={{ color: '#cc6622' }}>■</span> Plunge</div>
          <div><span style={{ color: '#2a3a5a' }}>■</span> Rapid</div>
        </div>
      </div>

      <div style={{ position: 'absolute', bottom: 8, right: 8, fontSize: 9, color: '#333355' }}>
        Left drag: orbit · Right drag: pan · Scroll: zoom
      </div>
    </div>
  );
}
