// Marching-squares auto-trace: converts a reference image to polyline entities.

// Edge midpoints in cell-local coords (x: 0=left 1=right, y: 0=top 1=bottom)
const EDGE_MID = [[0.5,0],[1,0.5],[0.5,1],[0,0.5]];

// Marching squares lookup: idx = (TL<<3)|(TR<<2)|(BR<<1)|BL
// Each entry is a list of [e1,e2] pairs indicating which edge midpoints to connect.
const MS_SEGS = [
  [],              // 0  0000
  [[2, 3]],        // 1  0001 BL
  [[1, 2]],        // 2  0010 BR
  [[1, 3]],        // 3  0011 BR,BL
  [[0, 1]],        // 4  0100 TR
  [[0, 1],[2, 3]], // 5  0101 TR,BL saddle
  [[0, 2]],        // 6  0110 TR,BR
  [[0, 3]],        // 7  0111 TR,BR,BL
  [[0, 3]],        // 8  1000 TL
  [[0, 2]],        // 9  1001 TL,BL
  [[0, 3],[1, 2]], // 10 1010 TL,BR saddle
  [[0, 1]],        // 11 1011 TL,BR,BL
  [[1, 3]],        // 12 1100 TL,TR
  [[1, 2]],        // 13 1101 TL,TR,BL
  [[2, 3]],        // 14 1110 TL,TR,BR
  [],              // 15 1111
];

function rdp(pts, tol) {
  if (pts.length < 3) return pts;
  const s = pts[0], e = pts[pts.length - 1];
  const dx = e.x - s.x, dy = e.y - s.y, len = Math.hypot(dx, dy);
  let maxDist = 0, maxIdx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = len < 1e-9
      ? Math.hypot(pts[i].x - s.x, pts[i].y - s.y)
      : Math.abs((pts[i].x - s.x) * dy - (pts[i].y - s.y) * dx) / len;
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > tol) {
    const L = rdp(pts.slice(0, maxIdx + 1), tol);
    const R = rdp(pts.slice(maxIdx), tol);
    return [...L.slice(0, -1), ...R];
  }
  return [s, e];
}

export function traceImage(imgEl, refImage, threshold = 0.5, simplifyTolerance = 1.5) {
  const MAX_DIM = 600;
  const sd = Math.min(1, MAX_DIM / Math.max(imgEl.naturalWidth || 1, imgEl.naturalHeight || 1));
  const pw = Math.max(2, Math.round(imgEl.naturalWidth * sd));
  const ph = Math.max(2, Math.round(imgEl.naturalHeight * sd));

  const oc = document.createElement('canvas');
  oc.width = pw; oc.height = ph;
  const ctx = oc.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, pw, ph);
  const { data } = ctx.getImageData(0, 0, pw, ph);

  const binary = new Uint8Array(pw * ph);
  for (let i = 0; i < pw * ph; i++) {
    const lum = (data[i*4]*0.299 + data[i*4+1]*0.587 + data[i*4+2]*0.114) / 255;
    binary[i] = lum < threshold ? 1 : 0;
  }

  // Generate marching-squares segments (pixel coords)
  const segs = [];
  for (let y = 0; y < ph - 1; y++) {
    for (let x = 0; x < pw - 1; x++) {
      const TL = binary[y * pw + x];
      const TR = binary[y * pw + x + 1];
      const BR = binary[(y+1) * pw + x + 1];
      const BL = binary[(y+1) * pw + x];
      const idx = (TL<<3)|(TR<<2)|(BR<<1)|BL;
      for (const [e1, e2] of MS_SEGS[idx]) {
        segs.push({ x1: x+EDGE_MID[e1][0], y1: y+EDGE_MID[e1][1], x2: x+EDGE_MID[e2][0], y2: y+EDGE_MID[e2][1] });
      }
    }
  }
  if (!segs.length) return [];

  // Build endpoint adjacency map for chain connection
  const PREC = 100;
  const key = (x, y) => `${Math.round(x*PREC)},${Math.round(y*PREC)}`;
  const adjMap = new Map(); // endpoint key → [{idx, thisEnd: 0=start 1=end}]
  for (let i = 0; i < segs.length; i++) {
    const k1 = key(segs[i].x1, segs[i].y1);
    const k2 = key(segs[i].x2, segs[i].y2);
    if (!adjMap.has(k1)) adjMap.set(k1, []);
    if (!adjMap.has(k2)) adjMap.set(k2, []);
    adjMap.get(k1).push({ idx: i, thisEnd: 0 });
    adjMap.get(k2).push({ idx: i, thisEnd: 1 });
  }

  const used = new Uint8Array(segs.length);
  const chains = [];

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const s = segs[i];
    const chain = [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }];

    let ext = true;
    while (ext) {
      ext = false;
      const last = chain[chain.length - 1];
      const k = key(last.x, last.y);
      for (const { idx, thisEnd } of (adjMap.get(k) || [])) {
        if (used[idx]) continue;
        used[idx] = 1;
        chain.push(thisEnd === 0 ? { x: segs[idx].x2, y: segs[idx].y2 } : { x: segs[idx].x1, y: segs[idx].y1 });
        ext = true;
        break;
      }
    }

    if (chain.length >= 3) chains.push(chain);
  }

  // Scale to world coords and simplify
  const mmPP = (refImage.mmPerPixel || 0.1) / sd;
  const ox = refImage.x || 0;
  const oy = refImage.y || 0;
  const result = [];
  for (const chain of chains) {
    const simplified = rdp(chain, simplifyTolerance);
    if (simplified.length < 2) continue;
    result.push(simplified.map(pt => ({
      x: ox + pt.x * mmPP,
      y: oy + (ph - pt.y) * mmPP,
    })));
  }
  return result;
}
