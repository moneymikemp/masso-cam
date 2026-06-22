/* eslint-disable no-restricted-globals */
// Height-map material removal worker.
// Input:  { segs: Float64Array (7 floats/seg: fx,fy,fz,tx,ty,tz,toolR),
//           minX, maxX, minY, maxY, topZ, gridW, gridH }
// Output: { heights: Float32Array, gridW, gridH, minX, maxX, minY, maxY, topZ }
self.onmessage = function (e) {
  const { segs, minX, maxX, minY, maxY, topZ, gridW, gridH } = e.data;
  const cellW = (maxX - minX) / (gridW - 1);
  const cellH = (maxY - minY) / (gridH - 1);

  const heights = new Float32Array(gridW * gridH);
  heights.fill(topZ);

  const n = segs.length / 7;

  for (let s = 0; s < n; s++) {
    const b    = s * 7;
    const fx   = segs[b],     fy = segs[b + 1], fz = segs[b + 2];
    const tx   = segs[b + 3], ty = segs[b + 4], tz = segs[b + 5];
    const toolR  = segs[b + 6];
    const toolR2 = toolR * toolR;

    const dx = tx - fx, dy = ty - fy;
    const len2 = dx * dx + dy * dy;

    const i0 = Math.max(0,         Math.floor((Math.min(fx, tx) - toolR - minX) / cellW));
    const i1 = Math.min(gridW - 1, Math.ceil( (Math.max(fx, tx) + toolR - minX) / cellW));
    const j0 = Math.max(0,         Math.floor((Math.min(fy, ty) - toolR - minY) / cellH));
    const j1 = Math.min(gridH - 1, Math.ceil( (Math.max(fy, ty) + toolR - minY) / cellH));

    for (let j = j0; j <= j1; j++) {
      const cy = minY + j * cellH;
      for (let i = i0; i <= i1; i++) {
        const cx = minX + i * cellW;
        let t;
        if (len2 < 1e-10) {
          const ex = cx - fx, ey = cy - fy;
          if (ex * ex + ey * ey > toolR2) continue;
          t = 0;
        } else {
          t = Math.max(0, Math.min(1, ((cx - fx) * dx + (cy - fy) * dy) / len2));
          const qx = fx + t * dx - cx, qy = fy + t * dy - cy;
          if (qx * qx + qy * qy > toolR2) continue;
        }
        const segZ = fz + t * (tz - fz);
        const idx  = j * gridW + i;
        if (segZ < heights[idx]) heights[idx] = segZ;
      }
    }
  }

  self.postMessage(
    { heights, gridW, gridH, minX, maxX, minY, maxY, topZ },
    [heights.buffer],
  );
};
