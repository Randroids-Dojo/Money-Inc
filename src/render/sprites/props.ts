// Props: vegetation, street furniture, signposts and the tower crane. Each prop has a
// draw function that renders into any Raster at a world position (so buildings and
// parks can include them with correct occlusion) and propSprite() wraps it into a
// standalone Sprite whose anchor is the ground contact point.

import type { PropKind, Sprite } from './types';
import { type Col, P, rgb, hex, shade, emissive, mix } from './color';
import { Raster, type Art, project } from './raster';
import { finish, art, LRU } from './sprite';
import { h01, Rng } from './rng';
import { textBitmap } from './font';

// ---------------------------------------------------------------------------
// Vegetation art (procedural blobs with banded light from the upper-left)

const TREE_PALETTES: Col[][] = [
  [hex('#3e7a3a'), hex('#549a44'), hex('#74b852'), hex('#9ed266')], // green
  [hex('#2f6636'), hex('#3f8040'), hex('#5a9e4c'), hex('#7cbc5c')], // deep green
  [hex('#5a9a3c'), hex('#74b84a'), hex('#96d060'), hex('#bfe47c')], // lime
  [hex('#9a4c26'), hex('#c46e2e'), hex('#e4983c'), hex('#f6c45a')], // autumn orange
  [hex('#843026'), hex('#b0452e'), hex('#d4683a'), hex('#ee9850')], // autumn red
  [hex('#8e7e26'), hex('#b8a434'), hex('#d8c64a'), hex('#efe07a')], // autumn yellow
  [hex('#a85a74'), hex('#cc7e96'), hex('#e6a2b6'), hex('#f8cad6')], // blossom
];

interface Blob {
  x: number;
  y: number;
  r: number;
}

/** Paint shaded blobs into a pixel buffer (back to front by y). */
function paintBlobs(data: Uint32Array, w: number, h: number, blobs: Blob[], pal: Col[], seed: number): void {
  const sorted = [...blobs].sort((a, b) => a.y - b.y);
  for (const bl of sorted) {
    for (let py = Math.floor(bl.y - bl.r); py <= Math.ceil(bl.y + bl.r); py++) {
      for (let px = Math.floor(bl.x - bl.r); px <= Math.ceil(bl.x + bl.r); px++) {
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const nx = (px + 0.5 - bl.x) / bl.r;
        const ny = (py + 0.5 - bl.y) / bl.r;
        const d2 = nx * nx + ny * ny;
        if (d2 >= 1) continue;
        const nz = Math.sqrt(1 - d2);
        let b = 0.55 * nz + 0.55 * (-0.62 * nx - 0.78 * ny);
        b += ((px + py) & 1 ? 0.06 : -0.06) + (h01(px, py, seed) - 0.5) * 0.22;
        const c = b > 0.62 ? pal[3] : b > 0.33 ? pal[2] : b > 0.02 ? pal[1] : pal[0];
        data[py * w + px] = c;
      }
    }
  }
}

const artCache = new Map<string, Art>();

/** Broadleaf tree (anchor = trunk base): a clumpy, slightly squat canopy on a short trunk. */
export function treeArt(variant: number): Art {
  const v = Math.abs(Math.floor(variant)) % 14;
  const key = `tree:${v}`;
  const hit = artCache.get(key);
  if (hit) return hit;
  const rng = new Rng(9001 + v * 131);
  const pal = TREE_PALETTES[v < 7 ? [0, 1, 2, 0, 1, 3, 0][v] : [4, 5, 0, 1, 6, 2, 3][v - 7]];
  const big = v % 3 === 0;
  const R = big ? 8.6 : 7.2;
  const w = Math.ceil(R * 2.5) + 2;
  const trunkVis = big ? 4 : 3;
  const h = Math.ceil(R * 1.8 + trunkVis + 2);
  const data = new Uint32Array(w * h);
  const cx = w / 2;
  const cy = R * 0.9 + 1;
  // trunk (left half lit, right half shaded), hidden mostly by the canopy
  const tx = Math.floor(cx) - 1;
  for (let y = Math.floor(cy); y < h; y++) {
    data[y * w + tx] = P.woodLight;
    data[y * w + tx + 1] = P.woodDark;
  }
  const blobs: Blob[] = [{ x: cx, y: cy + 0.6, r: R * 0.78 }];
  const n = 5 + rng.int(2);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng.next() * 0.7;
    blobs.push({ x: cx + Math.cos(a) * R * 0.55, y: cy + Math.sin(a) * R * 0.34, r: R * (0.46 + rng.next() * 0.14) });
  }
  paintBlobs(data, w, h, blobs, pal, v * 7 + 1);
  // a couple of branch pixels peeking out under the canopy
  const by = Math.min(h - trunkVis - 1, Math.floor(cy + R * 0.62));
  data[by * w + tx - 1] = P.woodDark;
  data[by * w + tx + 2] = P.woodDark;
  const a: Art = { w, h, ax: tx + 1, ay: h - 1, data };
  artCache.set(key, a);
  return a;
}

/** Conifer (anchor = trunk base). */
export function pineArt(variant: number): Art {
  const v = Math.abs(Math.floor(variant)) % 6;
  const key = `pine:${v}`;
  const hit = artCache.get(key);
  if (hit) return hit;
  const tiers = 3 + (v % 2);
  const w = 15;
  const h = tiers * 5 + 7;
  const data = new Uint32Array(w * h);
  const pal = v >= 4 ? [hex('#2a5a44'), hex('#3a7456'), hex('#4f8e66'), hex('#78b08a')] : [hex('#24503a'), hex('#316a44'), hex('#438452'), hex('#64a266')];
  const cx = 7;
  for (let y = h - 4; y < h; y++) {
    data[y * w + cx - 1] = P.woodLight;
    data[y * w + cx] = P.woodDark;
  }
  for (let t = 0; t < tiers; t++) {
    const top = t * 4;
    const rows = 7;
    for (let dy = 0; dy < rows; dy++) {
      const y = top + dy;
      if (y >= h - 3) break;
      const hw = Math.min(7, 1 + dy * 0.75 + t * 0.6);
      for (let x = Math.floor(cx - hw); x <= Math.ceil(cx + hw) - 1; x++) {
        if (x < 0 || x >= w) continue;
        const rel = (x + 0.5 - cx) / hw;
        let c = rel < -0.35 ? pal[2] : rel < 0.25 ? pal[1] : pal[0];
        if (dy === rows - 1 || (dy === rows - 2 && Math.abs(rel) > 0.6)) c = pal[0];
        if (dy === 0 && rel < 0) c = pal[3];
        if (h01(x, y, v) < 0.12 && c !== pal[0]) c = pal[3];
        data[y * w + x] = c;
      }
    }
  }
  const a: Art = { w, h, ax: cx, ay: h - 1, data };
  artCache.set(key, a);
  return a;
}

/** Round shrub; odd variants carry flowers. */
export function bushArt(variant: number): Art {
  const v = Math.abs(Math.floor(variant)) % 8;
  const key = `bush:${v}`;
  const hit = artCache.get(key);
  if (hit) return hit;
  const w = 12;
  const h = 8;
  const data = new Uint32Array(w * h);
  const pal = TREE_PALETTES[[1, 0, 2, 1, 0, 2, 3, 1][v]];
  paintBlobs(
    data,
    w,
    h,
    [
      { x: 4, y: 4.8, r: 3.2 },
      { x: 7.6, y: 4.6, r: 3.4 },
      { x: 6, y: 3.4, r: 3 },
    ],
    pal,
    v + 40,
  );
  if (v % 2 === 1) {
    const fl = [rgb(248, 240, 240), rgb(240, 110, 140), rgb(250, 210, 70), rgb(190, 120, 230)][v >> 1];
    for (const [x, y] of [[3, 3], [6, 2], [8, 4], [5, 5], [9, 2]]) data[y * w + x] = fl;
  }
  const a: Art = { w, h, ax: 6, ay: 7, data };
  artCache.set(key, a);
  return a;
}

/** Small tuft of dry weeds (empty lots, neglected sites). */
export function weedArt(variant: number): Art {
  const v = Math.abs(Math.floor(variant)) % 6;
  const key = `weed:${v}`;
  const hit = artCache.get(key);
  if (hit) return hit;
  const w = 7;
  const h = 6;
  const data = new Uint32Array(w * h);
  const cols = [hex('#8a9a48'), hex('#a8a858'), hex('#6a7a3a'), hex('#c8b870'), hex('#7a8a40')];
  const blades = 3 + (v % 3);
  for (let k = 0; k < blades; k++) {
    const x = 1 + ((k * 5 + v * 3) % 5);
    const ht = 2 + ((k + v) % 3) + (k === 1 ? 1 : 0);
    const c = cols[(k + v) % cols.length];
    for (let y = h - 1; y >= h - ht; y--) {
      const lean = y < h - 2 ? (k % 2 ? 1 : -1) * (y < h - 3 ? 1 : 0) : 0;
      const xx = Math.max(0, Math.min(w - 1, x + lean));
      data[y * w + xx] = y === h - ht ? shade(c, 1.12) : c;
    }
  }
  const a: Art = { w, h, ax: 3, ay: h - 1, data };
  artCache.set(key, a);
  return a;
}

/** Stamp vegetation art at a world point, with a soft shadow on the ground. */
export function plant(r: Raster, a: Art, x: number, y: number, shadow = true): void {
  const [sx, sy] = project(x, y, 0);
  if (shadow) r.shadowEllipse(Math.floor(sx) + 3, Math.floor(sy) + 0.5, a.w * 0.36, 2.4, 70);
  r.stampAt(a, x, y, 0);
}


// ---------------------------------------------------------------------------
// Street furniture

const LAMP = art(
  ['.kkk.', 'kwwyk', 'kwyyk', '.kkk.', '..k..', '..k..', '..k..', '..k..', '..k..', '..k..', '..k..', '..k..', '..k..', '..k..', '.kkk.', '.kkk.'],
  { k: rgb(52, 56, 66), w: emissive(rgb(255, 250, 220)), y: emissive(rgb(255, 222, 130)) },
  2,
  15,
);

export function drawLamp(r: Raster, x: number, y: number): void {
  r.stampAt(LAMP, x, y, 0);
}

export function drawBench(r: Raster, x: number, y: number, alongY = false): void {
  const g = r.group();
  const wood = P.woodLight;
  const leg = rgb(60, 62, 70);
  const L = 5;
  if (!alongY) {
    for (const dx of [-L + 1, L - 1]) r.box(x + dx - 0.5, y - 1, 0, x + dx + 0.5, y + 1, 3, leg, leg, g);
    r.box(x - L, y - 1.5, 3, x + L, y + 1.5, 4, (i) => (i % 3 === 0 ? shade(wood, 0.85) : wood), wood, g);
    r.box(x - L, y - 2.5, 4, x + L, y - 1.5, 7, (_i, j) => (j === 1 ? shade(wood, 0.8) : wood), wood, g);
  } else {
    for (const dy of [-L + 1, L - 1]) r.box(x - 1, y + dy - 0.5, 0, x + 1, y + dy + 0.5, 3, leg, leg, g);
    r.box(x - 1.5, y - L, 3, x + 1.5, y + L, 4, (i) => (i % 3 === 0 ? shade(wood, 0.85) : wood), wood, g);
    r.box(x - 2.5, y - L, 4, x - 1.5, y + L, 7, (_i, j) => (j === 1 ? shade(wood, 0.8) : wood), wood, g);
  }
}

/** Round fountain with a pedestal and animated-looking spray (static). */
export function drawFountain(r: Raster, x: number, y: number, big = false): void {
  const rad = big ? 13 : 10;
  const stoneC = rgb(206, 200, 186);
  const g = r.group();
  r.cylinder(x, y, rad, 0, 3, (_z, t) => (Math.abs(t) > 0.85 ? shade(stoneC, 0.9) : stoneC), stoneC, g);
  const water = rgb(88, 160, 214);
  r.disc(x, y, rad - 1.6, 3, (xx, yy) => {
    const d = Math.hypot(xx - x, yy - y);
    if (d > rad - 2.4 && d < rad - 1.6) return shade(water, 0.8);
    return (Math.floor(d * 1.5) % 3 === 0 ? mix(water, P.foam, 0.4) : water);
  }, g);
  const gp = r.group();
  r.cylinder(x, y, 2, 3, 10, stoneC, stoneC, gp);
  r.cylinder(x, y, big ? 5 : 4, 10, 12, stoneC, (xx, yy) => (Math.hypot(xx - x, yy - y) < (big ? 3.8 : 2.8) ? water : stoneC), gp);
  // spray
  const [sx, sy] = project(x, y, 12);
  const px = Math.floor(sx);
  const py = Math.floor(sy);
  const spray = emissive(rgb(214, 238, 252));
  const spray2 = emissive(rgb(160, 208, 240));
  const gs = r.group();
  for (let k = 1; k <= 6; k++) r.plot(px, py - k, k > 4 ? spray : spray2, x + y + 1, gs, true);
  const drops: [number, number][] = [[-1, -7], [1, -7], [-2, -6], [2, -6], [-3, -4], [3, -4], [-4, -2], [4, -2], [-4, 0], [4, 0], [-5, 2], [5, 2]];
  for (const [dx, dy] of drops) r.plot(px + dx, py + dy, (dx + dy) & 1 ? spray : spray2, x + y + 1, gs, true);
}

export function drawFlowers(r: Raster, x: number, y: number, variant: number): void {
  const g = r.group();
  const soil = rgb(110, 78, 54);
  const leaf = rgb(70, 130, 60);
  const cols = [rgb(236, 90, 110), rgb(250, 214, 70), rgb(246, 244, 240), rgb(170, 110, 220), rgb(250, 150, 60)];
  const c1 = cols[Math.abs(variant) % cols.length];
  const c2 = cols[(Math.abs(variant) + 2) % cols.length];
  r.box(x - 7, y - 4, 0, x + 7, y + 4, 2, (i) => (i % 4 === 0 ? shade(soil, 0.9) : soil), (xx, yy) => {
    const k = h01(Math.floor(xx * 2), Math.floor(yy * 2), variant);
    return k < 0.3 ? c1 : k < 0.5 ? c2 : k < 0.62 ? shade(leaf, 1.2) : leaf;
  }, g);
}

// ---------------------------------------------------------------------------
// Sign posts (flat boards that face the viewer for legibility)

interface SignSpec {
  lines: string[];
  bg: Col;
  fg: Col;
  border: Col;
  rider?: { text: string; bg: Col; fg: Col };
  style: 'hang' | 'stakes' | 'banner' | 'post';
  post?: Col;
  stripe?: Col;
}

const SIGNS: Partial<Record<PropKind, SignSpec>> = {
  sign_forsale: { lines: ['FOR', 'SALE'], bg: P.white, fg: rgb(200, 40, 40), border: rgb(200, 40, 40), style: 'hang' },
  sign_sold: {
    lines: ['FOR', 'SALE'],
    bg: P.white,
    fg: rgb(200, 40, 40),
    border: rgb(200, 40, 40),
    style: 'hang',
    rider: { text: 'SOLD', bg: rgb(214, 40, 40), fg: P.white },
  },
  sign_foreclosed: { lines: ['FORE', 'CLOSED'], bg: rgb(128, 24, 28), fg: P.white, border: rgb(40, 14, 16), style: 'stakes', stripe: P.yellow },
  sign_forrent: { lines: ['FOR', 'RENT'], bg: P.white, fg: rgb(40, 90, 190), border: rgb(40, 90, 190), style: 'hang' },
  sign_hiring: { lines: ['NOW', 'HIRING'], bg: rgb(250, 208, 60), fg: rgb(40, 36, 48), border: rgb(120, 90, 20), style: 'post' },
  sign_sale: { lines: ['SALE!'], bg: rgb(222, 38, 44), fg: rgb(255, 232, 90), border: rgb(130, 16, 22), style: 'banner' },
  sign_lot: { lines: ['LOT'], bg: rgb(236, 226, 196), fg: rgb(70, 60, 50), border: rgb(120, 96, 64), style: 'stakes' },
};

function signArt(kind: PropKind): Art {
  const key = `sign:${kind}`;
  const hit = artCache.get(key);
  if (hit) return hit;
  const sp = SIGNS[kind]!;
  const bms = sp.lines.map((l) => textBitmap(l));
  const tw = Math.max(...bms.map((b) => b.w));
  const bw = tw + 4 + (sp.style === 'banner' ? 4 : 0);
  const bh = sp.lines.length * 6 + 3 + (sp.stripe ? 2 : 0);
  const W = bw + 8;
  const postH = sp.style === 'banner' ? 7 : sp.style === 'hang' ? 5 : 6;
  const riderH = sp.rider ? 7 : 0;
  const H = riderH + bh + postH + (sp.style === 'hang' ? 3 : 0);
  const data = new Uint32Array(W * H);
  const set = (x: number, y: number, c: Col) => {
    if (x >= 0 && y >= 0 && x < W && y < H) data[y * W + x] = c;
  };
  const postC = sp.post ?? (sp.style === 'hang' ? rgb(240, 238, 232) : P.woodDark);
  const bx = sp.style === 'hang' ? 4 : 4;
  const by = riderH + (sp.style === 'hang' ? 3 : 0);
  // board
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const edge = x === 0 || y === 0 || x === bw - 1 || y === bh - 1;
      let c = edge ? sp.border : sp.bg;
      if (!edge && y === 1) c = shade(sp.bg, 1.08);
      if (!edge && y === bh - 2) c = shade(sp.bg, 0.92);
      if (sp.stripe && !edge && (y === 1 || y === 2)) c = (x >> 1) % 2 === 0 ? sp.stripe : P.black;
      set(bx + x, by + y, c);
    }
  }
  // text lines
  bms.forEach((bm, li) => {
    const ox = bx + Math.floor((bw - bm.w) / 2);
    const oy = by + 2 + (sp.stripe ? 2 : 0) + li * 6;
    for (const gl of bm.glyphs) for (const [gx, gy] of gl.px) set(ox + gl.x + gx, oy + gy, sp.fg);
  });
  const baseY = H - 1;
  if (sp.style === 'hang') {
    // post on the left, arm across the top, board hanging on two links
    for (let y = riderH; y <= baseY; y++) {
      set(1, y, postC);
      set(2, y, shade(postC, 0.8));
    }
    for (let x = 1; x < bx + bw; x++) set(x, riderH, postC);
    set(bx + 2, riderH + 1, P.steelDark);
    set(bx + bw - 3, riderH + 1, P.steelDark);
    set(bx + 2, riderH + 2, P.steelDark);
    set(bx + bw - 3, riderH + 2, P.steelDark);
  } else if (sp.style === 'stakes' || sp.style === 'post') {
    const xs = sp.style === 'post' ? [bx + (bw >> 1) - 1] : [bx + 2, bx + bw - 4];
    for (const x of xs) {
      for (let y = by + bh; y <= baseY; y++) {
        set(x, y, postC);
        set(x + 1, y, shade(postC, 0.75));
      }
    }
  } else {
    // banner between two poles
    for (let y = by - 2; y <= baseY; y++) {
      set(bx - 1, y, P.steelLight);
      set(bx + bw, y, P.steelDark);
    }
    set(bx - 1, by - 3, P.gold);
    set(bx + bw, by - 3, P.gold);
    // scalloped bottom
    for (let x = 1; x < bw - 1; x += 2) set(bx + x, by + bh, sp.border);
  }
  if (sp.rider) {
    const rb = textBitmap(sp.rider.text);
    const rw = rb.w + 4;
    const rx = bx + Math.floor((bw - rw) / 2);
    for (let y = 0; y < 7; y++) for (let x = 0; x < rw; x++) set(rx + x, y, y === 0 || y === 6 || x === 0 || x === rw - 1 ? shade(sp.rider.bg, 0.7) : sp.rider.bg);
    for (const gl of rb.glyphs) for (const [gx, gy] of gl.px) set(rx + 2 + gl.x + gx, 1 + gy, sp.rider.fg);
  }
  const ax = sp.style === 'hang' ? 1 : bx + (bw >> 1);
  const a: Art = { w: W, h: H, ax, ay: baseY, data };
  artCache.set(key, a);
  return a;
}

// ---------------------------------------------------------------------------
// Tower crane

export interface CraneOpts {
  /** mast height in px (from z0) */
  height: number;
  /** jib length (units) along +axis, counter-jib along -axis */
  jib: number;
  counter?: number;
  axis?: 'x' | 'y';
  /** hook drop below the jib (px) and load flag */
  hook?: number;
  load?: boolean;
  /** trolley position along the jib (0..1) */
  trolley?: number;
  color?: Col;
  z0?: number;
}

/** Lattice paint: frame edges and X bracing; the rest is see-through. */
function lattice(c: Col, dark: Col, period: number): (i: number, j: number) => Col {
  return (i, j) => {
    const W = 4;
    if (i === 0 || i === W - 1 || j % period === 0) return i === W - 1 ? dark : c;
    const k = j % period;
    return k === i || period - k === i ? c : 0;
  };
}

export function drawCrane(r: Raster, x: number, y: number, o: CraneOpts): void {
  const c = o.color ?? P.yellow;
  const dark = shade(c, 0.72);
  const z0 = o.z0 ?? 0;
  const H = o.height;
  const axis = o.axis ?? 'x';
  const cj = o.counter ?? Math.round(o.jib * 0.35);
  // footing
  const gb = r.group();
  r.box(x - 5, y - 5, z0, x + 5, y + 5, z0 + 3, rgb(160, 156, 148), rgb(176, 172, 164), gb);
  // mast (4x4 units lattice)
  const gm = r.group();
  r.box(x - 2, y - 2, z0 + 3, x + 2, y + 2, z0 + H, lattice(c, dark, 4), null, gm);
  // slewing unit + cab
  const zc = z0 + H;
  const gc = r.group();
  r.box(x - 3, y - 3, zc, x + 3, y + 3, zc + 3, dark, c, gc);
  const cab = axis === 'x' ? r.box(x + 1, y + 2, zc - 5, x + 5, y + 6, zc + 1, c, c, gc) : r.box(x + 2, y + 1, zc - 5, x + 6, y + 5, zc + 1, c, c, gc);
  (axis === 'x' ? cab.L : cab.R).rect(0, 2, 4, 3, rgb(120, 170, 210));
  // apex
  const gt = r.group();
  r.box(x - 1, y - 1, zc + 3, x + 1, y + 1, zc + 14, c, c, gt);
  // jib & counter-jib (lattice beams 3 px tall)
  const gj = r.group();
  const jl = (i: number, j: number) => (j === 0 || j === 3 || i % 4 === j % 4 ? c : 0);
  if (axis === 'x') {
    r.box(x + 2, y - 1.5, zc + 3, x + 2 + o.jib, y + 1.5, zc + 7, jl, c, gj, dark);
    r.box(x - 2 - cj, y - 1.5, zc + 3, x - 2, y + 1.5, zc + 7, jl, c, gj, dark);
    r.box(x - 2 - cj, y - 3, zc + 1, x - 2 - cj + 7, y + 3, zc + 7, rgb(150, 150, 146), rgb(170, 170, 166), r.group());
  } else {
    r.box(x - 1.5, y + 2, zc + 3, x + 1.5, y + 2 + o.jib, zc + 7, jl, c, gj, dark);
    r.box(x - 1.5, y - 2 - cj, zc + 3, x + 1.5, y - 2, zc + 7, jl, c, gj, dark);
    r.box(x - 3, y - 2 - cj, zc + 1, x + 3, y - 2 - cj + 7, zc + 7, rgb(150, 150, 146), rgb(170, 170, 166), r.group());
  }
  // tie cables from apex
  const apex: [number, number, number] = [x, y, zc + 14];
  const tipF: [number, number, number] = axis === 'x' ? [x + o.jib * 0.8, y, zc + 7] : [x, y + o.jib * 0.8, zc + 7];
  const tipB: [number, number, number] = axis === 'x' ? [x - cj, y, zc + 7] : [x, y - cj, zc + 7];
  r.line(apex, tipF, dark, gt);
  r.line(apex, tipB, dark, gt);
  // trolley + hook
  const tp = o.trolley ?? 0.6;
  const hx = axis === 'x' ? x + 2 + o.jib * tp : x;
  const hy = axis === 'x' ? y : y + 2 + o.jib * tp;
  const drop = o.hook ?? 20;
  const gh = r.group();
  r.box(hx - 1.5, hy - 1.5, zc + 1, hx + 1.5, hy + 1.5, zc + 3, dark, dark, gh);
  r.pole(hx, hy, zc + 1 - drop, zc + 1, rgb(50, 50, 56), gh);
  r.box(hx - 1, hy - 1, zc - drop - 2, hx + 1, hy + 1, zc - drop + 1, rgb(214, 60, 44), rgb(230, 80, 60), gh);
  if (o.load) {
    const gl = r.group();
    const zl = zc - drop - 8;
    if (axis === 'x') r.box(hx - 7, hy - 2, zl, hx + 7, hy + 2, zl + 4, (i, j) => (j === 1 || i % 7 === 0 ? P.steelDark : rgb(170, 90, 60)), rgb(190, 110, 70), gl);
    else r.box(hx - 2, hy - 7, zl, hx + 2, hy + 7, zl + 4, (i, j) => (j === 1 || i % 7 === 0 ? P.steelDark : rgb(170, 90, 60)), rgb(190, 110, 70), gl);
    r.line([hx, hy, zl + 4], [hx, hy, zc - drop - 2], rgb(50, 50, 56), gl);
  }
}

// ---------------------------------------------------------------------------
// Standalone prop sprites

const propCache = new LRU<Sprite>(512);

export function propSprite(kind: PropKind, variant = 0): Sprite {
  const v = Math.abs(Math.floor(variant));
  const key = `${kind}:${v}`;
  const hit = propCache.get(key);
  if (hit) return hit;
  let r: Raster;
  switch (kind) {
    case 'crane':
      r = new Raster(240, 240, 120, 200);
      drawCrane(r, 0, 0, { height: 110 + (v % 3) * 12, jib: 64, axis: v % 2 ? 'y' : 'x', hook: 30 + (v % 4) * 8, load: v % 2 === 0 });
      break;
    case 'tree':
    case 'pine':
    case 'bush': {
      r = new Raster(48, 48, 24, 40);
      const a = kind === 'tree' ? treeArt(v) : kind === 'pine' ? pineArt(v) : bushArt(v);
      plant(r, a, 0, 0);
      break;
    }
    case 'lamp':
      r = new Raster(24, 32, 12, 26);
      r.shadowEllipse(2, 0.5, 3, 1.2, 60);
      drawLamp(r, 0, 0);
      break;
    case 'bench':
      r = new Raster(32, 24, 16, 16);
      drawBench(r, 0, 0, v % 2 === 1);
      break;
    case 'fountain':
      r = new Raster(64, 48, 32, 30);
      drawFountain(r, 0, 0, v % 2 === 1);
      break;
    case 'flowers':
      r = new Raster(32, 24, 16, 14);
      drawFlowers(r, 0, 0, v);
      break;
    default: {
      const a = signArt(kind);
      r = new Raster(a.w + 16, a.h + 8, a.ax + 8, a.ay + 2);
      r.shadowEllipse(3, 0.5, 4, 1.3, 60);
      r.stamp(a, 0, 0, 0, r.group(), true);
      break;
    }
  }
  const outline = kind !== 'lamp' && !kind.startsWith('sign_');
  const s = finish(r, {}, { outline });
  propCache.set(key, s);
  return s;
}

/** Draw a sign prop into a raster at a world point (used inside lots). */
export function drawSign(r: Raster, kind: PropKind, x: number, y: number): void {
  if (!SIGNS[kind]) return;
  r.stampAt(signArt(kind), x, y, 0, r.group(), true);
}
