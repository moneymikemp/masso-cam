import { parse as parseFont } from 'opentype.js';

function distFromLine(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(px - ax, py - ay);
  return Math.abs((px - ax) * dy - (py - ay) * dx) / len;
}

// ─── Arc-fitting helpers ───────────────────────────────────────────────────────

// Circumcircle of three points. Returns null if collinear.
function circumcircle(ax, ay, bx, by, cx, cy) {
  const D = 2 * (ax*(by-cy) + bx*(cy-ay) + cx*(ay-by));
  if (Math.abs(D) < 1e-10) return null;
  const sq1 = ax*ax+ay*ay, sq2 = bx*bx+by*by, sq3 = cx*cx+cy*cy;
  const ux = (sq1*(by-cy) + sq2*(cy-ay) + sq3*(ay-by)) / D;
  const uy = (sq1*(cx-bx) + sq2*(ax-cx) + sq3*(bx-ax)) / D;
  return { cx: ux, cy: uy, r: Math.hypot(ax-ux, ay-uy) };
}

function evalCubicPt(x0,y0,x1,y1,x2,y2,x3,y3,t) {
  const mt = 1-t;
  return { x: mt*mt*mt*x0+3*mt*mt*t*x1+3*mt*t*t*x2+t*t*t*x3,
           y: mt*mt*mt*y0+3*mt*mt*t*y1+3*mt*t*t*y2+t*t*t*y3 };
}

function evalQuadPt(x0,y0,x1,y1,x2,y2,t) {
  const mt = 1-t;
  return { x: mt*mt*x0+2*mt*t*x1+t*t*x2, y: mt*mt*y0+2*mt*t*y1+t*t*y2 };
}

// DXF bulge = tan(θ/4). Positive = CCW arc from (x0,y0) to (x3,y3) in Y-up coords.
// pm is a point known to lie on the arc (the Bezier at t=0.5).
function arcBulge(x0,y0,xm,ym,x3,y3) {
  const area = (xm-x0)*(y3-y0) - (ym-y0)*(x3-x0);
  if (Math.abs(area) < 1e-12) return 0;
  const ccw = area > 0;
  const circ = circumcircle(x0,y0,xm,ym,x3,y3);
  if (!circ) return 0;
  const a0 = Math.atan2(y0-circ.cy, x0-circ.cx);
  const a3 = Math.atan2(y3-circ.cy, x3-circ.cx);
  let sweep = ccw ? (a3-a0) : (a0-a3);
  if (sweep < 1e-10) sweep += 2*Math.PI;
  return Math.tan(sweep/4) * (ccw ? 1 : -1);
}

// Recursive cubic Bezier → arc segments. All coordinates in CNC Y-up.
// Pushes {x, y, bulge} where bulge is for the arc FROM the previous point TO (x,y).
function fitCubicArcs(x0,y0,x1,y1,x2,y2,x3,y3, tol, depth, out) {
  if (Math.hypot(x3-x0,y3-y0) < 1e-8) return;
  if (distFromLine(x1,y1,x0,y0,x3,y3)+distFromLine(x2,y2,x0,y0,x3,y3) <= tol) {
    out.push({ x:x3, y:y3, bulge:0 }); return;
  }
  const m = evalCubicPt(x0,y0,x1,y1,x2,y2,x3,y3, 0.5);
  const circ = circumcircle(x0,y0,m.x,m.y,x3,y3);
  if (circ) {
    const q = evalCubicPt(x0,y0,x1,y1,x2,y2,x3,y3, 0.25);
    const s = evalCubicPt(x0,y0,x1,y1,x2,y2,x3,y3, 0.75);
    const dq = Math.abs(Math.hypot(q.x-circ.cx,q.y-circ.cy)-circ.r);
    const ds = Math.abs(Math.hypot(s.x-circ.cx,s.y-circ.cy)-circ.r);
    if (Math.max(dq,ds) <= tol || depth >= 8) {
      out.push({ x:x3, y:y3, bulge:arcBulge(x0,y0,m.x,m.y,x3,y3) }); return;
    }
  }
  const x01=(x0+x1)/2,y01=(y0+y1)/2, x12=(x1+x2)/2,y12=(y1+y2)/2, x23=(x2+x3)/2,y23=(y2+y3)/2;
  const x012=(x01+x12)/2,y012=(y01+y12)/2, x123=(x12+x23)/2,y123=(y12+y23)/2;
  const xm=(x012+x123)/2,ym=(y012+y123)/2;
  fitCubicArcs(x0,y0,x01,y01,x012,y012,xm,ym, tol,depth+1,out);
  fitCubicArcs(xm,ym,x123,y123,x23,y23,x3,y3, tol,depth+1,out);
}

// Recursive quadratic Bezier → arc segments.
function fitQuadArcs(x0,y0,x1,y1,x2,y2, tol, depth, out) {
  if (Math.hypot(x2-x0,y2-y0) < 1e-8) return;
  if (distFromLine(x1,y1,x0,y0,x2,y2) <= tol) {
    out.push({ x:x2, y:y2, bulge:0 }); return;
  }
  const m = evalQuadPt(x0,y0,x1,y1,x2,y2, 0.5);
  const circ = circumcircle(x0,y0,m.x,m.y,x2,y2);
  if (circ) {
    const q = evalQuadPt(x0,y0,x1,y1,x2,y2, 0.25);
    const s = evalQuadPt(x0,y0,x1,y1,x2,y2, 0.75);
    const dq = Math.abs(Math.hypot(q.x-circ.cx,q.y-circ.cy)-circ.r);
    const ds = Math.abs(Math.hypot(s.x-circ.cx,s.y-circ.cy)-circ.r);
    if (Math.max(dq,ds) <= tol || depth >= 8) {
      out.push({ x:x2, y:y2, bulge:arcBulge(x0,y0,m.x,m.y,x2,y2) }); return;
    }
  }
  const x01=(x0+x1)/2,y01=(y0+y1)/2, x12=(x1+x2)/2,y12=(y1+y2)/2;
  const xm=(x01+x12)/2,ym=(y01+y12)/2;
  fitQuadArcs(x0,y0,x01,y01,xm,ym, tol,depth+1,out);
  fitQuadArcs(xm,ym,x12,y12,x2,y2, tol,depth+1,out);
}

// Convert one opentype.js Path to arc-polylines in CNC Y-up coords.
// Returns [{vertices:[{x,y,bulge}], closed}].
// bulge on vertex i controls the arc from vertex i to vertex i+1.
function pathToArcPolylines(path, tol) {
  const polys = [];
  let verts = null;
  let px = 0, py = 0;
  for (const cmd of path.commands) {
    if (cmd.type === 'M') {
      if (verts && verts.length >= 2) polys.push({ vertices: verts, closed: false });
      verts = [{ x: cmd.x, y: -cmd.y, bulge: 0 }];
      px = cmd.x; py = -cmd.y;
    } else if (cmd.type === 'L') {
      if (verts) {
        verts.push({ x: cmd.x, y: -cmd.y, bulge: 0 });
        px = cmd.x; py = -cmd.y;
      }
    } else if (cmd.type === 'C') {
      if (verts) {
        const x1=cmd.x1,y1=-cmd.y1,x2=cmd.x2,y2=-cmd.y2,x3=cmd.x,y3=-cmd.y;
        const segs = [];
        fitCubicArcs(px,py,x1,y1,x2,y2,x3,y3, tol,0,segs);
        for (const seg of segs) {
          verts[verts.length-1].bulge = seg.bulge;
          verts.push({ x:seg.x, y:seg.y, bulge:0 });
        }
        px = x3; py = y3;
      }
    } else if (cmd.type === 'Q') {
      if (verts) {
        const x1=cmd.x1,y1=-cmd.y1,x2=cmd.x,y2=-cmd.y;
        const segs = [];
        fitQuadArcs(px,py,x1,y1,x2,y2, tol,0,segs);
        for (const seg of segs) {
          verts[verts.length-1].bulge = seg.bulge;
          verts.push({ x:seg.x, y:seg.y, bulge:0 });
        }
        px = x2; py = y2;
      }
    } else if (cmd.type === 'Z') {
      if (verts && verts.length >= 2) polys.push({ vertices: verts, closed: true });
      verts = null;
    }
  }
  if (verts && verts.length >= 2) polys.push({ vertices: verts, closed: false });
  return polys;
}

// ─── Line-segment subdivision helpers (used by existing textToGlyphContours) ───

function subdivideCubic(x0, y0, x1, y1, x2, y2, x3, y3, tol, result) {
  if (distFromLine(x1, y1, x0, y0, x3, y3) + distFromLine(x2, y2, x0, y0, x3, y3) <= tol) {
    result.push({ x: x3, y: y3 });
    return;
  }
  const x01 = (x0+x1)/2, y01 = (y0+y1)/2;
  const x12 = (x1+x2)/2, y12 = (y1+y2)/2;
  const x23 = (x2+x3)/2, y23 = (y2+y3)/2;
  const x012 = (x01+x12)/2, y012 = (y01+y12)/2;
  const x123 = (x12+x23)/2, y123 = (y12+y23)/2;
  const xm = (x012+x123)/2, ym = (y012+y123)/2;
  subdivideCubic(x0,y0, x01,y01, x012,y012, xm,ym, tol, result);
  subdivideCubic(xm,ym, x123,y123, x23,y23, x3,y3, tol, result);
}

function subdivideQuadratic(x0, y0, x1, y1, x2, y2, tol, result) {
  if (distFromLine(x1, y1, x0, y0, x2, y2) <= tol) {
    result.push({ x: x2, y: y2 });
    return;
  }
  const x01 = (x0+x1)/2, y01 = (y0+y1)/2;
  const x12 = (x1+x2)/2, y12 = (y1+y2)/2;
  const xm = (x01+x12)/2, ym = (y01+y12)/2;
  subdivideQuadratic(x0,y0, x01,y01, xm,ym, tol, result);
  subdivideQuadratic(xm,ym, x12,y12, x2,y2, tol, result);
}

// Convert one opentype.js Path to closed contours in CNC coordinates (Y-up).
// opentype uses Y-down screen coordinates; negating Y converts to CNC Y-up.
function pathToContours(path, tol) {
  const contours = [];
  let current = null;
  let px = 0, py = 0;

  for (const cmd of path.commands) {
    if (cmd.type === 'M') {
      if (current && current.length >= 3) contours.push(current);
      current = [{ x: cmd.x, y: -cmd.y }];
      px = cmd.x; py = cmd.y;
    } else if (cmd.type === 'L') {
      if (current) current.push({ x: cmd.x, y: -cmd.y });
      px = cmd.x; py = cmd.y;
    } else if (cmd.type === 'C') {
      if (current) {
        const pts = [];
        subdivideCubic(px, py, cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y, tol, pts);
        for (const pt of pts) current.push({ x: pt.x, y: -pt.y });
      }
      px = cmd.x; py = cmd.y;
    } else if (cmd.type === 'Q') {
      if (current) {
        const pts = [];
        subdivideQuadratic(px, py, cmd.x1, cmd.y1, cmd.x, cmd.y, tol, pts);
        for (const pt of pts) current.push({ x: pt.x, y: -pt.y });
      }
      px = cmd.x; py = cmd.y;
    } else if (cmd.type === 'Z') {
      if (current && current.length >= 3) contours.push(current);
      current = null;
    }
  }
  if (current && current.length >= 3) contours.push(current);
  return contours;
}

export function loadFontFromArrayBuffer(buffer) {
  return parseFont(buffer);
}

// Convert text to per-glyph contour groups relative to origin (0,0).
// Origin is the baseline of the first line; Y-up, so glyphs extend upward.
// capHeightMm: desired cap-height in mm (height of uppercase letters above baseline).
// Returns array of glyph-groups; each group is an array of closed contours [{x,y},...].
export function textToGlyphContours(font, text, capHeightMm, tolerance = 0.1) {
  const capHeight = font.tables?.os2?.sCapHeight || Math.round(font.unitsPerEm * 0.7);
  const fontSizeMm = capHeightMm * font.unitsPerEm / capHeight;

  const ascender  = font.tables?.os2?.sTypoAscender  ?? font.ascender  ?? font.unitsPerEm;
  const descender = font.tables?.os2?.sTypoDescender ?? font.descender ?? 0;
  const lineGap   = font.tables?.os2?.sTypoLineGap   ?? 0;
  const lineHeightMm = (ascender - descender + lineGap) / font.unitsPerEm * fontSizeMm;

  const lines = text.split('\n');
  const glyphGroups = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    // opentype baseline Y = li * lineHeightMm (downward in screen coords).
    // After Y-flip, subsequent lines appear below the first (negative CNC Y).
    const paths = font.getPaths(line, 0, li * lineHeightMm, fontSizeMm);
    for (const path of paths) {
      if (!path.commands?.length) continue;
      const contours = pathToContours(path, tolerance);
      if (contours.length > 0) glyphGroups.push(contours);
    }
  }

  return glyphGroups;
}

// Convert a single cubic Bezier into arc-fitted polyline vertices.
// Returns [{x,y,bulge}] starting from p0, suitable for a polyline entity.
export function cubicBezierToPolyline(p0, p1, p2, p3, tolerance = 0.05) {
  const verts = [{ x: p0.x, y: p0.y, bulge: 0 }];
  const segs = [];
  fitCubicArcs(p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, tolerance, 0, segs);
  for (const seg of segs) {
    verts[verts.length - 1].bulge = seg.bulge;
    verts.push({ x: seg.x, y: seg.y, bulge: 0 });
  }
  return verts;
}

// Convert text to arc-fitted polylines for use as CAD entities.
// Returns [{vertices:[{x,y,bulge}], closed}] — one entry per glyph contour.
// Coordinates are in mm, Y-up (CNC), relative to baseline start at (0,0).
// tolerance: max deviation from true curve in mm (default 0.05 mm ≈ 2 thou).
export function textToArcPolylines(font, text, capHeightMm, tolerance = 0.05) {
  const capHeight = font.tables?.os2?.sCapHeight || Math.round(font.unitsPerEm * 0.7);
  const fontSizeMm = capHeightMm * font.unitsPerEm / capHeight;
  const ascender  = font.tables?.os2?.sTypoAscender  ?? font.ascender  ?? font.unitsPerEm;
  const descender = font.tables?.os2?.sTypoDescender ?? font.descender ?? 0;
  const lineGap   = font.tables?.os2?.sTypoLineGap   ?? 0;
  const lineHeightMm = (ascender - descender + lineGap) / font.unitsPerEm * fontSizeMm;

  const lines = text.split('\n');
  const all = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    const paths = font.getPaths(line, 0, li * lineHeightMm, fontSizeMm);
    for (const path of paths) {
      if (!path.commands?.length) continue;
      all.push(...pathToArcPolylines(path, tolerance));
    }
  }
  return all;
}

export function getTextBounds(glyphGroups) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const group of glyphGroups) {
    for (const contour of group) {
      for (const pt of contour) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      }
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
