// Marching-squares auto-trace: converts a reference image to polyline entities.
// Also exports fitArcsToChain() which post-processes vertex chains into line/arc segments.

// ── Kasa least-squares circle fit ────────────────────────────────────────────

function solve3x3(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let maxRow = col;
    for (let row = col + 1; row < 3; row++) if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) return null;
    for (let row = col + 1; row < 3; row++) {
      const f = M[row][col] / M[col][col];
      for (let j = col; j <= 3; j++) M[row][j] -= f * M[col][j];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    x[i] = M[i][3];
    for (let j = i + 1; j < 3; j++) x[i] -= M[i][j] * x[j];
    x[i] /= M[i][i];
  }
  return x;
}

function fitCircleLS(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let sxx=0, sxy=0, sx=0, syy=0, sy=0;
  let sx3=0, sxy2=0, sx2y=0, sy3=0;
  for (const { x, y } of pts) {
    const x2 = x*x, y2 = y*y;
    sxx+=x2; sxy+=x*y; sx+=x; syy+=y2; sy+=y;
    sx3+=x2*x; sxy2+=x*y2; sx2y+=x2*y; sy3+=y2*y;
  }
  const sol = solve3x3([[sxx,sxy,sx],[sxy,syy,sy],[sx,sy,n]], [sx3+sxy2, sx2y+sy3, sxx+syy]);
  if (!sol) return null;
  const [B, C, D] = sol;
  const cx = B/2, cy = C/2;
  const r2 = cx*cx + cy*cy + D;
  if (r2 <= 0) return null;
  const r = Math.sqrt(r2);
  let rms = 0;
  for (const { x, y } of pts) { const d = Math.hypot(x-cx, y-cy) - r; rms += d*d; }
  return { cx, cy, r, residual: Math.sqrt(rms / n) };
}

// Unwrap atan2 angles so consecutive values differ by at most π (handles 0/2π crossings).
function unwrapAngles(angles) {
  const out = [angles[0]];
  for (let k = 1; k < angles.length; k++) {
    let diff = angles[k] - out[k - 1];
    while (diff >  Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    out.push(out[k - 1] + diff);
  }
  return out;
}

// Convert an array of {x,y} vertices (world mm) into a mix of line and arc segments.
// arcTolerance: max RMS deviation (mm) from a fitted circle to consider the segment an arc.
// minArcDeg: minimum arc span in degrees to emit an arc entity (avoids trivial arcs).
export function fitArcsToChain(vertices, arcTolerance = 1.0, minArcDeg = 15) {
  const n = vertices.length;
  if (n < 2) return [];
  const result = [];
  const MAX_WINDOW  = 14;  // max vertices in one arc window (prevents spanning concave features)
  const MAX_SPAN_DEG = 150; // cap arc span — wider arcs are almost always fitting artifacts
  let i = 0;

  while (i < n - 1) {
    let arcEmitted = false;

    if (i + 3 < n) {
      // Need >=4 points — 3 always define a circle, so residual is meaningless with exactly 3
      const initFit = fitCircleLS(vertices.slice(i, i + 4));
      if (initFit && initFit.residual < arcTolerance) {
        let arcEnd = i + 3;
        let bestFit = initFit;
        while (arcEnd + 1 < n && (arcEnd - i) < MAX_WINDOW) {
          const extFit = fitCircleLS(vertices.slice(i, arcEnd + 2));
          if (!extFit || extFit.residual >= arcTolerance) break;
          bestFit = extFit;
          arcEnd++;
        }

        // Phase-unwrap the angle of each vertex around the fitted center.
        // This reliably gives the true CW/CCW direction and span without
        // the midpoint heuristic that misfires on near-full-circle windows.
        const rawAngles = [];
        for (let k = i; k <= arcEnd; k++) {
          rawAngles.push(Math.atan2(vertices[k].y - bestFit.cy, vertices[k].x - bestFit.cx));
        }
        const unwrapped = unwrapAngles(rawAngles);
        const totalAngle = unwrapped[unwrapped.length - 1] - unwrapped[0]; // + = CCW, - = CW
        const spanDeg = Math.abs(totalAngle) * 180 / Math.PI;

        // Reject if the angular sequence reverses direction (3 deg slack per step)
        const dir = totalAngle >= 0 ? 1 : -1;
        const isMonotone = unwrapped.every((v, idx) =>
          idx === 0 || dir * (v - unwrapped[idx - 1]) >= -0.052);

        if (isMonotone && spanDeg >= minArcDeg && spanDeg <= MAX_SPAN_DEG) {
          // Verify the arc actually passes near the geometric midpoint of the data.
          // If it doesn't, the fitted circle is concave-side-up and the arc would
          // cut through the interior of the shape instead of following the boundary.
          const midAngle = rawAngles[0] + totalAngle / 2;
          const arcMidX  = bestFit.cx + bestFit.r * Math.cos(midAngle);
          const arcMidY  = bestFit.cy + bestFit.r * Math.sin(midAngle);
          const midIdx   = Math.round((i + arcEnd) / 2);
          const midDist  = Math.hypot(vertices[midIdx].x - arcMidX, vertices[midIdx].y - arcMidY);

          if (midDist <= arcTolerance * 4) {
            let startAngle, endAngle;
            if (totalAngle >= 0) {
              startAngle = rawAngles[0];
              endAngle   = startAngle + totalAngle;
            } else {
              // CW arc — flip to CCW representation (swap and ensure endAngle > startAngle)
              startAngle = rawAngles[rawAngles.length - 1];
              endAngle   = rawAngles[0];
              while (endAngle < startAngle) endAngle += 2 * Math.PI;
            }
            result.push({ type: 'arc', center: { x: bestFit.cx, y: bestFit.cy }, radius: bestFit.r, startAngle, endAngle });
            i = arcEnd;
            arcEmitted = true;
          }
        }
      }
    }

    if (!arcEmitted) {
      result.push({ type: 'line', start: vertices[i], end: vertices[i + 1] });
      i++;
    }
  }

  return result;
}

// Weighted moving-average smooth: blurs pixel-grid staircase artifacts before RDP.
// Endpoints are held fixed so chain start/end don't drift.
function smoothChain(pts, passes = 3) {
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    const out = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      out.push({
        x: (cur[i - 1].x + cur[i].x * 2 + cur[i + 1].x) / 4,
        y: (cur[i - 1].y + cur[i].y * 2 + cur[i + 1].y) / 4,
      });
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

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
    const simplified = rdp(smoothChain(chain, 3), simplifyTolerance);
    if (simplified.length < 2) continue;
    result.push(simplified.map(pt => ({
      x: ox + pt.x * mmPP,
      y: oy + (ph - pt.y) * mmPP,
    })));
  }
  return result;
}
