import React, { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { useApp } from '../../store/AppContext';

// Coordinate mapping: world (X right, Y forward, Z up) → Three.js (X right, Y up, Z toward viewer)
// world X → three X
// world Y → three -Z
// world Z → three Y
function wx(x)       { return x; }
function wy(z)       { return z ?? 0; }   // world Z becomes Three Y (up)
function wz(y)       { return -(y ?? 0); } // world Y becomes Three -Z

const COLORS = {
  bg:        0x0a0a1e,
  grid1:     0x1a1a36,
  grid2:     0x141428,
  stockFace: 0x1a2a40,
  stockEdge: 0x3355aa,
  rapid:     0x2a3a5a,
  plunge:    0xcc6622,
};

// Distinct op colors — bright enough to read on the dark background
const OP_PALETTE = [
  0x22aaaa, // teal
  0x44cc55, // green
  0xdd4444, // red
  0xddcc22, // yellow
  0x4488dd, // blue
  0xcc44cc, // magenta
  0xdd8822, // amber
  0x44ccaa, // cyan-green
  0xaa55dd, // purple
  0xdd6644, // salmon
];

function buildStockMesh(stockConfig) {
  const { width, length, thickness, topZ, datum,
          stockOriginX: ox = 0, stockOriginY: oy = 0 } = stockConfig;
  if (!width || !length || !thickness) return null;

  const xFrac = datum[1] === 'l' ? 0 : datum[1] === 'c' ? 0.5 : 1;
  const yFrac = datum[0] === 'b' ? 0 : datum[0] === 'm' ? 0.5 : 1;
  const minX  = ox - xFrac * width;
  const maxX  = minX + width;
  const minY  = oy - yFrac * length;
  const maxY  = minY + length;
  const minZ  = topZ - thickness;
  const maxZ  = topZ;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  const geo  = new THREE.BoxGeometry(width, thickness, length);
  const mat  = new THREE.MeshBasicMaterial({
    color: COLORS.stockFace, opacity: 0.18, transparent: true, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(wx(cx), wy(cz), wz(cy));

  const edgesGeo = new THREE.EdgesGeometry(geo);
  const edgeMat  = new THREE.LineBasicMaterial({ color: COLORS.stockEdge, opacity: 0.6, transparent: true });
  const edges    = new THREE.LineSegments(edgesGeo, edgeMat);
  edges.position.copy(mesh.position);

  const group = new THREE.Group();
  group.add(mesh);
  group.add(edges);
  group.userData.managed = true;
  return { group, bounds: { minX, maxX, minY, maxY, minZ, maxZ } };
}

function buildToolpathLines(operations, showRapids) {
  const groups = [];
  let opIdx = 0;

  for (const op of operations) {
    if (!op.enabled || !op.toolpath) continue;

    const feedColor = OP_PALETTE[opIdx % OP_PALETTE.length];
    opIdx++;

    const moveLists = op.toolpath.subToolpaths?.length
      ? op.toolpath.subToolpaths.map(st => st.moves)
      : [op.toolpath.moves];

    for (const moves of moveLists) {
      if (!moves?.length) continue;

      const rapidVerts  = [];
      const feedVerts   = [];
      const plungeVerts = [];

      let px = 0, py = 0, pz = 0;

      for (const m of moves) {
        const x = m.x ?? px;
        const y = m.y ?? py;
        const z = m.z ?? pz;

        if (m.type === 'rapid') {
          if (showRapids) {
            rapidVerts.push(wx(px), wy(pz), wz(py), wx(x), wy(z), wz(y));
          }
        } else if (m.type === 'feed') {
          const isPlunge = (x === px && y === py && z !== pz);
          if (isPlunge) {
            plungeVerts.push(wx(px), wy(pz), wz(py), wx(x), wy(z), wz(y));
          } else {
            feedVerts.push(wx(px), wy(pz), wz(py), wx(x), wy(z), wz(y));
          }
        }

        px = x; py = y; pz = z;
      }

      const addSegs = (verts, color) => {
        if (verts.length < 6) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        const segs = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
        segs.userData.managed = true;
        groups.push(segs);
      };

      addSegs(rapidVerts,  COLORS.rapid);
      addSegs(feedVerts,   feedColor);
      addSegs(plungeVerts, COLORS.plunge);
    }
  }

  return groups;
}

export default function ThreeCanvas() {
  const { state } = useApp();
  const { operations, stockConfig, showToolpaths, showRapids } = state;

  const mountRef    = useRef(null);
  const rendererRef = useRef(null);
  const sceneRef    = useRef(null);
  const cameraRef   = useRef(null);
  const controlsRef = useRef(null);
  const frameRef    = useRef(null);
  const fittedRef   = useRef(false);

  // Fit camera to a world-space bounding box
  const fitCamera = useCallback((bounds) => {
    const camera   = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls || !bounds) return;

    const cx = wx((bounds.minX + bounds.maxX) / 2);
    const cy = wy((bounds.minZ + bounds.maxZ) / 2);
    const cz = wz((bounds.minY + bounds.maxY) / 2);
    const dx = bounds.maxX - bounds.minX;
    const dy = bounds.maxZ - bounds.minZ;
    const dz = bounds.maxY - bounds.minY;
    const size = Math.max(dx, dy, dz, 10);

    const center = new THREE.Vector3(cx, cy, cz);
    controls.target.copy(center);
    camera.position.set(cx + size * 0.9, cy + size * 0.7, cz + size * 0.9);
    controls.update();
  }, []);

  // Mount: create renderer, scene, camera, controls, grid
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.bg);
    sceneRef.current = scene;

    const w = mount.clientWidth  || 800;
    const h = mount.clientHeight || 600;
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 50000);
    camera.position.set(200, 200, 200);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping  = true;
    controls.dampingFactor  = 0.08;
    controls.screenSpacePanning = true;
    controlsRef.current = controls;

    // Grid in XZ plane (Three.js) = XY machine plane
    const grid = new THREE.GridHelper(1000, 50, COLORS.grid1, COLORS.grid2);
    scene.add(grid);

    // Axis indicator
    const axes = new THREE.AxesHelper(25);
    scene.add(axes);

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(200, 400, 200);
    scene.add(dir);

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
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
      sceneRef.current    = null;
      cameraRef.current   = null;
      controlsRef.current = null;
      rendererRef.current = null;
      fittedRef.current   = false;
    };
  }, []);

  // Rebuild scene geometry when data changes
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove old managed objects
    const toRemove = scene.children.filter(c => c.userData.managed);
    for (const obj of toRemove) {
      scene.remove(obj);
      obj.traverse(child => {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material?.dispose();
      });
    }

    let firstBounds = null;

    // Stock
    const stockResult = buildStockMesh(stockConfig);
    if (stockResult) {
      scene.add(stockResult.group);
      firstBounds = stockResult.bounds;
    }

    // Toolpaths
    if (showToolpaths) {
      const lines = buildToolpathLines(operations, showRapids);
      for (const l of lines) scene.add(l);
    }

    // Auto-fit once when geometry first appears
    if (!fittedRef.current && firstBounds) {
      fittedRef.current = true;
      fitCamera(firstBounds);
    }
  }, [operations, stockConfig, showToolpaths, showRapids, fitCamera]);

  const handleFit = () => {
    fittedRef.current = false;
    const stockResult = buildStockMesh(stockConfig);
    if (stockResult) fitCamera(stockResult.bounds);
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />

      {/* HUD buttons */}
      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button
          onClick={handleFit}
          title="Fit view to stock"
          style={{ background: '#111128', border: '1px solid #2a2a50', color: '#8888cc', borderRadius: 3, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
        >⊡ Fit</button>
      </div>

      {/* Legend */}
      <div style={{ position: 'absolute', bottom: 8, left: 8, background: 'rgba(8,8,24,0.75)', border: '1px solid #1a1a38', borderRadius: 4, padding: '5px 8px', fontSize: 10, color: '#666688', lineHeight: 1.8, maxHeight: '40vh', overflowY: 'auto' }}>
        {operations.filter(op => op.enabled && op.toolpath).map((op, i) => {
          const c = OP_PALETTE[i % OP_PALETTE.length];
          const hex = '#' + c.toString(16).padStart(6, '0');
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

      {/* Orbit hint */}
      <div style={{ position: 'absolute', bottom: 8, right: 8, fontSize: 9, color: '#333355' }}>
        Left drag: orbit · Right drag: pan · Scroll: zoom
      </div>
    </div>
  );
}
