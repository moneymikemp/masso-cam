// Moving parts from their own frame to a nest placement, for ▦ Nest
// (the part list). A placement { angle, x, y } (from plasma/nesting.js)
// rotates the part about its frame centre (cx, cy) and moves that centre
// to (x, y).

import { v4 as uuid } from 'uuid';
import { translateEntity, rotateEntityAround } from '../cam/offsetEngine';

/** A point moved from the part's frame (centre cx, cy) to a placement. */
export function placePoint(p, part, pl) {
  const x = p.x - part.cx, y = p.y - part.cy, c = Math.cos(pl.angle), s = Math.sin(pl.angle);
  return { x: x * c - y * s + pl.x, y: x * s + y * c + pl.y };
}

/** Entity moved from the part's frame (centre cx, cy) to a placement, with a new id. */
export function placeEntity(e, part, pl) {
  const local = translateEntity(e, -part.cx, -part.cy);
  const turned = pl.angle ? rotateEntityAround(local, 0, 0, pl.angle) : local;
  return { ...translateEntity(turned, pl.x, pl.y), id: uuid() };
}
