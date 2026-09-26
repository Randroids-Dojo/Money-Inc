// Ground, shore and road tiles. Every tile is one 64x32 diamond drawn with the same
// pixel rule as buildings (ax = 32, ay = 0), except bridges which extend above/below.

import type { Sprite } from './types';
import { ROAD_N, ROAD_E, ROAD_S, ROAD_W } from '../iso';
import { type Col, P, mix, shade, rgb } from './color';
import { Raster, G_GROUND } from './raster';
import { finish } from './sprite';
import { h01 } from './rng';
import { grass, dirt, sand, paving, asphalt, lattice, meadow } from './textures';

export type GroundKind = 'grass' | 'dirt' | 'plaza' | 'parking' | 'sand' | 'water';

const T = 32; // units per tile

function tileRaster(top = 0, bottom = 0): Raster {
  return new Raster(64, 32 + top + bottom, 32, top);
}

function tileSprite(r: Raster): Sprite {
  return finish(r, {}, { outline: false, crop: false });
}

// ---------------------------------------------------------------------------
// Water

interface Glint {
  px: number;
  py: number;
  len: number;
  phase: number;
}

let glintCache: Glint[] | null = null;

/** Fixed set of ripple marks inside the tile interior (identical for every water tile). */
function glints(): Glint[] {
  if (glintCache) return glintCache;
  const out: Glint[] = [];
  const spots: [number, number][] = [
    [0.22, 0.3], [0.5, 0.2], [0.75, 0.42], [0.35, 0.62], [0.62, 0.7],
    [0.2, 0.8], [0.82, 0.78], [0.48, 0.45], [0.3, 0.18], [0.7, 0.24],
  ];
  spots.forEach(([u, v], k) => {
    const x = u * T;
    const y = v * T;
    out.push({ px: Math.round(x - y), py: Math.round((x + y) / 2), len: 2 + (k % 3), phase: (k * 3) % 4 });
  });
  glintCache = out;
  return out;
}

/**
 * Water colour at world (x, y) for animation frame f (0..3). The pattern is periodic
 * in screen space (32 x 16 px), so neighbouring water tiles join seamlessly: staggered
 * wave dashes (dark trough over a lit crest) drift sideways, plus twinkling glints.
 */
export function waterAt(x: number, y: number, f: number, variant = 0): Col {
  const [U, V] = lattice(x, y);
  const px = (U - V - 1) / 2;
  const py = (U + V - 1) / 4;
  const X = ((px % 32) + 32) % 32;
  const Y = ((py % 16) + 16) % 16;
  const row = (Y + (X >= 16 ? 4 : 0)) % 8;
  const phase = (X + f * 2 + (Y >= 8 ? 7 : 0)) % 16;
  let c: Col = P.water;
  if (row === 0 && phase < 5) c = P.waterDark;
  else if (row === 1 && phase >= 1 && phase < 4) c = mix(P.water, P.waterLight, 0.55);
  for (const g of glints()) {
    // glints are per-tile sparkles: the variant desynchronises neighbouring tiles
    const t = (f + g.phase + variant) % 4;
    if (t === 3) continue;
    const len = t === 1 ? g.len : Math.max(1, g.len - 2);
    const x0 = g.px + (t === 2 ? 1 : 0);
    if (py === g.py && px >= x0 && px < x0 + len) c = t === 1 ? P.foam : P.waterLight;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Ground tiles

const groundCache = new Map<string, Sprite>();

export function groundTile(kind: GroundKind, variant: number, frame = 0): Sprite {
  const v0 = Math.abs(Math.floor(variant)) % 16;
  const v = kind === 'water' ? v0 % 4 : v0;
  const f = kind === 'water' ? ((Math.floor(frame) % 4) + 4) % 4 : 0;
  const key = `${kind}:${v}:${f}`;
  const hit = groundCache.get(key);
  if (hit) return hit;
  const r = tileRaster();
  const seed = 1000 + v * 7919;
  let paint: (x: number, y: number) => Col;
  switch (kind) {
    case 'grass':
      paint = v % 4 === 3 ? (x, y) => meadow(x, y, seed, 0.008) : (x, y) => grass(x, y, seed);
      break;
    case 'dirt':
      paint = (x, y) => dirt(x, y, seed);
      break;
    case 'plaza':
      paint = (x, y) => paving(x, y, seed);
      break;
    case 'parking':
      paint = (x, y) => parkingAt(x, y, seed);
      break;
    case 'sand':
      paint = (x, y) => sand(x, y, seed);
      break;
    case 'water':
    default:
      paint = (x, y) => waterAt(x, y, f, v);
      break;
  }
  r.ground(0, 0, T, T, paint);
  const s = tileSprite(r);
  groundCache.set(key, s);
  return s;
}

/** Parking lot: asphalt, two rows of bays with white lines, aisle in the middle. */
function parkingAt(x: number, y: number, seed: number): Col {
  const onBayLine = Math.abs((x % 8) - 0) < 0.6 || Math.abs((x % 8) - 8) < 0.6;
  if (onBayLine && ((y > 1.5 && y < 11) || (y > 21 && y < 30.5))) return P.paint;
  if ((y > 10.5 && y < 11.5) || (y > 20.5 && y < 21.5)) return P.paint;
  // faint oil stains in the middle of bays
  const [U, V] = lattice(x, y);
  if ((y > 4 && y < 8) || (y > 24 && y < 28)) {
    const bx = Math.floor(x / 8);
    if (h01(bx, y > 16 ? 1 : 0, seed) < 0.5 && Math.abs((x % 8) - 4) < 1.6 && h01(U, V, seed) < 0.5) return P.asphaltDark;
  }
  return asphalt(x, y, seed);
}

// ---------------------------------------------------------------------------
// Shore tiles

const shoreCache = new Map<string, Sprite>();

/** Smooth, tile-periodic wobble for coastlines (matches between neighbouring tiles). */
function wobble(t: number, k: number): number {
  return 0.022 * Math.sin(2 * Math.PI * (2 * t) + k) + 0.012 * Math.sin(2 * Math.PI * (5 * t) + 2 * k);
}

export function shoreTile(landMask: number, frame = 0): Sprite {
  const m = landMask & 15;
  const f = ((Math.floor(frame) % 4) + 4) % 4;
  const key = `${m}:${f}`;
  const hit = shoreCache.get(key);
  if (hit) return hit;
  const r = tileRaster();
  r.ground(0, 0, T, T, (x, y) => {
    const u = x / T;
    const v = y / T;
    let d = 9;
    if (m & ROAD_N) d = Math.min(d, v - wobble(u, 0.3));
    if (m & ROAD_E) d = Math.min(d, 1 - u - wobble(v, 1.1));
    if (m & ROAD_S) d = Math.min(d, 1 - v - wobble(u, 2.3));
    if (m & ROAD_W) d = Math.min(d, u - wobble(v, 0.7));
    if (d < 0.13) return grass(x, y, 4242);
    if (d < 0.145) return mix(P.grassDark, P.sandDark, 0.4);
    if (d < 0.225) return sand(x, y, 77);
    if (d < 0.25) return P.sandDark;
    if (d < 0.265) return rgb(150, 134, 100); // wet bank edge
    const foamW = f % 2 === 0 ? 0.3 : 0.29;
    if (d < foamW) {
      const [U, V] = lattice(x, y);
      return (U + V + f * 2) % 8 < 5 ? P.foam : mix(P.foam, P.waterLight, 0.5);
    }
    if (d < 0.4) return mix(P.waterLight, waterAt(x, y, f), 0.55);
    return waterAt(x, y, f);
  });
  const s = tileSprite(r);
  shoreCache.set(key, s);
  return s;
}

// ---------------------------------------------------------------------------
// Roads

const roadCache = new Map<string, Sprite>();
const SW = 6; // sidewalk width, units

export function roadTile(mask: number, opts: { crosswalk?: boolean; bridge?: boolean } = {}): Sprite {
  const m = mask & 15;
  const cw = !!opts.crosswalk;
  const br = !!opts.bridge;
  const key = `${m}:${cw ? 1 : 0}:${br ? 1 : 0}`;
  const hit = roadCache.get(key);
  if (hit) return hit;

  const n = !!(m & ROAD_N), e = !!(m & ROAD_E), s = !!(m & ROAD_S), w = !!(m & ROAD_W);
  const count = +n + +e + +s + +w;
  const straight = count === 2 && ((n && s) || (e && w));

  const isWalk = (xx: number, yy: number): boolean => {
    // samples beyond the tile edge continue the tile (connected edges have no gutter)
    const x = Math.min(T - 0.01, Math.max(0.01, xx));
    const y = Math.min(T - 0.01, Math.max(0.01, yy));
    const dN = y, dE = T - x, dS = T - y, dW = x;
    if ((!n && dN < SW) || (!e && dE < SW) || (!s && dS < SW) || (!w && dW < SW)) return true;
    if (n && w && dN < SW && dW < SW) return true;
    if (n && e && dN < SW && dE < SW) return true;
    if (s && e && dS < SW && dE < SW) return true;
    if (s && w && dS < SW && dW < SW) return true;
    return false;
  };

  // centre line: from each connected edge towards the middle
  const junction = count >= 3;
  const stop = junction ? SW + 1 : 16.5;
  const isLane = (x: number, y: number): boolean => {
    const onV = Math.abs(x - 16) < 0.6; // line running along y
    const onU = Math.abs(y - 16) < 0.6; // line running along x
    const dashY = Math.floor(y) % 8 < 5;
    const dashX = Math.floor(x) % 8 < 5;
    if (onV && dashY) {
      if (n && y < stop) return true;
      if (s && y > T - stop) return true;
    }
    if (onU && dashX) {
      if (w && x < stop) return true;
      if (e && x > T - stop) return true;
    }
    return false;
  };

  // zebra crossings: straight roads get one across the middle; junction arms get one each
  const isZebra = (x: number, y: number): boolean => {
    if (!cw) return false;
    const inRoadX = x > SW + 1 && x < T - SW - 1;
    const inRoadY = y > SW + 1 && y < T - SW - 1;
    const barX = Math.floor(x) % 4 < 2;
    const barY = Math.floor(y) % 4 < 2;
    if (straight) {
      if (n && s) return inRoadX && y > 12 && y < 20 && barX;
      return inRoadY && x > 12 && x < 20 && barY;
    }
    if (n && y > 0.5 && y < SW - 0.5 && inRoadX && barX) return true;
    if (s && y > T - SW + 0.5 && y < T - 0.5 && inRoadX && barX) return true;
    if (w && x > 0.5 && x < SW - 0.5 && inRoadY && barY) return true;
    if (e && x > T - SW + 0.5 && x < T - 0.5 && inRoadY && barY) return true;
    return false;
  };

  const seed = 555;
  const paint = (x: number, y: number): Col => {
    if (isWalk(x, y)) {
      // curb: sidewalk pixel next to asphalt
      if (!isWalk(x + 1, y) || !isWalk(x - 1, y) || !isWalk(x, y + 1) || !isWalk(x, y - 1)) return P.curb;
      const gx = Math.floor(x), gy = Math.floor(y);
      if ((gx % 8 === 0 && (y < SW || y > T - SW)) || (gy % 8 === 0 && (x < SW || x > T - SW))) return shade(P.sidewalk, 0.93);
      return br ? mix(P.sidewalk, P.wood, 0.25) : P.sidewalk;
    }
    // asphalt: slightly darker gutter next to the curb
    if (isWalk(x + 1.2, y) || isWalk(x - 1.2, y) || isWalk(x, y + 1.2) || isWalk(x, y - 1.2)) return P.asphaltDark;
    if (isZebra(x, y)) return P.paint;
    if (isLane(x, y)) return P.lane;
    return asphalt(x, y, seed);
  };

  let r: Raster;
  if (!br) {
    r = tileRaster();
    r.ground(0, 0, T, T, paint);
  } else {
    r = tileRaster(10, 22);
    drawBridge(r, n, e, s, w);
    r.hface(0, 0, T, T, 0, paint, G_GROUND, 1, true);
  }
  const sp = br ? finish(r, {}, { outline: true, crop: false }) : tileSprite(r);
  roadCache.set(key, sp);
  return sp;
}

/** Bridge structure: deck edges, pier and railings (deck surface is drawn by the caller). */
function drawBridge(r: Raster, n: boolean, e: boolean, s: boolean, w: boolean): void {
  const deck = rgb(170, 164, 150);
  const deckDark = rgb(120, 116, 108);
  const g = r.group();
  const deckPaint = (_i: number, j: number) => (j <= 1 ? deckDark : j >= 6 ? shade(deck, 1.05) : deck);
  // visible deck side faces (below the road surface) on the open (non-connected) sides
  if (!e) r.vface('R', T, 0, T, -8, -8, 0, deckPaint, g);
  if (!s) r.vface('L', T, 0, T, -8, -8, 0, deckPaint, g);
  // pier under the middle
  const pier = rgb(150, 146, 138);
  r.box(11, 11, -26, 21, 21, -8, (i, j) => (j % 6 === 0 ? shade(pier, 0.9) : i % 5 === 0 ? shade(pier, 0.95) : pier), null);
  // railings on open sides
  const rail = rgb(236, 232, 222);
  const post = rgb(200, 196, 186);
  const railing = (along: 'x' | 'y', at: number) => {
    const gr = r.group();
    for (let k = 1; k < T; k += 5) {
      if (along === 'x') r.box(k, at - 1, 0, k + 1, at, 5, post, rail, gr);
      else r.box(at - 1, k, 0, at, k + 1, 5, post, rail, gr);
    }
    if (along === 'x') r.box(0, at - 1, 5, T, at, 6, rail, rail, gr);
    else r.box(at - 1, 0, 5, at, T, 6, rail, rail, gr);
  };
  if (!n) railing('x', 1);
  if (!w) railing('y', 1);
  if (!s) railing('x', T);
  if (!e) railing('y', T);
}
