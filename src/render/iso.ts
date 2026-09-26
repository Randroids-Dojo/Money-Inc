// Isometric projection conventions shared by the renderer and the sprite library.
//
// Tiles are 2:1 diamonds, 64x32 native pixels. Tile (tx, ty) has its TOP corner at
// screen (tx - ty) * 32, (tx + ty) * 16. +x runs down-right on screen, +y runs down-left.
//
//              top (x, y)
//               /\
//   left       /  \      right
// (x, y+d)    \    /   (x+w, y)
//               \/
//         bottom (x+w, y+d)
//
// Light comes from the upper-left: top faces are brightest, faces looking down-left
// ("left faces", the face along y = y+d) are mid-tone, faces looking down-right
// ("right faces", along x = x+w) are darkest.

export const TILE_W = 64;
export const TILE_H = 32;
export const HALF_W = TILE_W / 2;
export const HALF_H = TILE_H / 2;
/** Guideline height of one building storey in native pixels. */
export const FLOOR_H = 14;

export interface Pt {
  x: number;
  y: number;
}

export function tileToScreen(tx: number, ty: number): Pt {
  return { x: (tx - ty) * HALF_W, y: (tx + ty) * HALF_H };
}

export function screenToTile(sx: number, sy: number): Pt {
  const a = sx / HALF_W;
  const b = sy / HALF_H;
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Screen position of the centre of a tile (useful for vehicles and effects). */
export function tileCenter(tx: number, ty: number): Pt {
  const p = tileToScreen(tx, ty);
  return { x: p.x, y: p.y + HALF_H };
}

/** Road connection bits: which tile-space neighbours a road tile connects to. */
export const ROAD_N = 1; // (x, y-1)  -> up-right on screen
export const ROAD_E = 2; // (x+1, y)  -> down-right on screen
export const ROAD_S = 4; // (x, y+1)  -> down-left on screen
export const ROAD_W = 8; // (x-1, y)  -> up-left on screen

/** Vehicle / pedestrian headings in tile space. */
export type Dir = 0 | 1 | 2 | 3; // 0:+x (down-right) 1:+y (down-left) 2:-x (up-left) 3:-y (up-right)
export const DIR_VECTORS: ReadonlyArray<Pt> = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];
