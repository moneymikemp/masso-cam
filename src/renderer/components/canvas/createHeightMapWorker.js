// Creates the height-map worker via a Blob URL so it works regardless of
// webpack / Electron URL resolution behaviour (no import.meta.url dependency).
const WORKER_SRC = `
self.onmessage = function(e) {
  var d = e.data;
  var segs = d.segs, minX = d.minX, maxX = d.maxX, minY = d.minY, maxY = d.maxY;
  var topZ = d.topZ, gridW = d.gridW, gridH = d.gridH;
  var cellW = (maxX - minX) / (gridW - 1);
  var cellH = (maxY - minY) / (gridH - 1);
  var heights = new Float32Array(gridW * gridH);
  heights.fill(topZ);
  var n = segs.length / 7;
  for (var s = 0; s < n; s++) {
    var b = s * 7;
    var fx = segs[b], fy = segs[b+1], fz = segs[b+2];
    var tx = segs[b+3], ty = segs[b+4], tz = segs[b+5];
    var toolR = segs[b+6], toolR2 = toolR * toolR;
    var dx = tx - fx, dy = ty - fy;
    var len2 = dx*dx + dy*dy;
    var i0 = Math.max(0,         Math.floor((Math.min(fx,tx) - toolR - minX) / cellW));
    var i1 = Math.min(gridW - 1, Math.ceil( (Math.max(fx,tx) + toolR - minX) / cellW));
    var j0 = Math.max(0,         Math.floor((Math.min(fy,ty) - toolR - minY) / cellH));
    var j1 = Math.min(gridH - 1, Math.ceil( (Math.max(fy,ty) + toolR - minY) / cellH));
    for (var j = j0; j <= j1; j++) {
      var cy = minY + j * cellH;
      for (var i = i0; i <= i1; i++) {
        var cx = minX + i * cellW;
        var t;
        if (len2 < 1e-10) {
          var ex = cx - fx, ey = cy - fy;
          if (ex*ex + ey*ey > toolR2) continue;
          t = 0;
        } else {
          t = Math.max(0, Math.min(1, ((cx-fx)*dx + (cy-fy)*dy) / len2));
          var qx = fx + t*dx - cx, qy = fy + t*dy - cy;
          if (qx*qx + qy*qy > toolR2) continue;
        }
        var segZ = fz + t * (tz - fz);
        var idx = j * gridW + i;
        if (segZ < heights[idx]) heights[idx] = segZ;
      }
    }
  }
  self.postMessage(
    { heights: heights, gridW: gridW, gridH: gridH,
      minX: minX, maxX: maxX, minY: minY, maxY: maxY, topZ: topZ },
    [heights.buffer]
  );
};
`;

export function createHeightMapWorker() {
  const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
  const url  = URL.createObjectURL(blob);
  const w    = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}
