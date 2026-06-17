import { parse as parseFont } from 'opentype.js';

function distFromLine(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(px - ax, py - ay);
  return Math.abs((px - ax) * dy - (py - ay) * dx) / len;
}

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
