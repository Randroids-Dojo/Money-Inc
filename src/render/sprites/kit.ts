// Building construction kit: an orientation frame, wall/roof materials, windows,
// doors, roofs, awnings, signs and small rooftop / yard structures. Buildings are
// composed from these on top of the Raster primitives.

import { type Col, P, shade, mix, emissive, rgb } from './color';
import { Raster, Face, type WallPaint, type FlatPaint, type SurfPaint, project } from './raster';
import { h01 } from './rng';
import { textBitmap } from './font';

export type Front = 'left' | 'right';

// ---------------------------------------------------------------------------
// Frame: building-local coordinates.
//
// Local a runs along the building front (screen left -> right), local b runs from the
// back (0) to the front (B). front='left' puts the facade on the left (down-left
// facing) face, 'right' on the right face; it is a 90 degree rotation, so lighting
// stays correct. Units are 1/32 tile, like world space.

export class Frame {
  readonly A: number;
  readonly B: number;
  constructor(
    readonly r: Raster,
    readonly w: number,
    readonly d: number,
    readonly front: Front,
  ) {
    this.A = front === 'left' ? 32 * w : 32 * d;
    this.B = front === 'left' ? 32 * d : 32 * w;
  }

  xy(a: number, b: number): [number, number] {
    return this.front === 'left' ? [a, b] : [b, 32 * this.d - a];
  }

  pt(a: number, b: number, z: number): [number, number, number] {
    const [x, y] = this.xy(a, b);
    return [x, y, z];
  }

  /** local rect -> world [x0, y0, x1, y1] */
  rect(a0: number, b0: number, a1: number, b1: number): [number, number, number, number] {
    if (this.front === 'left') return [a0, b0, a1, b1];
    return [b0, 32 * this.d - a1, b1, 32 * this.d - a0];
  }

  /** world axis that corresponds to local axis a (along front) or b (depth) */
  axis(local: 'a' | 'b'): 'x' | 'y' {
    return (local === 'a') === (this.front === 'left') ? 'x' : 'y';
  }

  box(
    a0: number,
    b0: number,
    z0: number,
    a1: number,
    b1: number,
    z1: number,
    side: WallPaint,
    top: FlatPaint | null,
    g?: number,
  ): { front: Face; side: Face; g: number } {
    const [x0, y0, x1, y1] = this.rect(a0, b0, a1, b1);
    const f = this.r.box(x0, y0, z0, x1, y1, z1, side, top, g);
    return this.front === 'left' ? { front: f.L, side: f.R, g: f.g } : { front: f.R, side: f.L, g: f.g };
  }

  /** ground paint in local coordinates over a local rect */
  ground(a0: number, b0: number, a1: number, b1: number, paint: (a: number, b: number) => Col): void {
    const [x0, y0, x1, y1] = this.rect(a0, b0, a1, b1);
    const D = 32 * this.d;
    this.r.ground(x0, y0, x1, y1, this.front === 'left' ? paint : (x, y) => paint(D - y, x));
  }

  /** local screen pixel of a local world point */
  screen(a: number, b: number, z: number): [number, number] {
    const [x, y] = this.xy(a, b);
    const [sx, sy] = project(x, y, z);
    return [Math.floor(sx), Math.floor(sy)];
  }

  /** side-face column for a distance k (units) from the building's front edge */
  sideCol(f: Face, k: number): number {
    return this.front === 'left' ? k : f.W - 1 - k;
  }
}

// ---------------------------------------------------------------------------
// Wall materials (base colours; faces apply their own shading)

export function brick(c: Col, seed = 0): WallPaint {
  const mortar = shade(c, 0.9);
  const dark = shade(c, 0.95);
  const light = shade(c, 1.04);
  return (i, j) => {
    const course = Math.floor(j / 3);
    if (j % 3 === 2) return mortar;
    const off = course % 2 ? 3 : 0;
    const k = h01(Math.floor((i + off) / 6), course, seed);
    return k < 0.22 ? dark : k > 0.86 ? light : c;
  };
}

export function siding(c: Col): WallPaint {
  const line = shade(c, 0.9);
  return (_i, j) => (j % 3 === 2 ? line : c);
}

export function plaster(c: Col, seed = 0): WallPaint {
  const sp = shade(c, 0.95);
  return (i, j) => (h01(i, j, seed) < 0.03 ? sp : c);
}

export function stone(c: Col, seed = 0, course = 4, block = 8): WallPaint {
  const joint = shade(c, 0.88);
  const alt = shade(c, 0.96);
  return (i, j) => {
    const row = Math.floor(j / course);
    if (j % course === course - 1) return joint;
    const off = row % 2 ? block >> 1 : 0;
    if ((i + off) % block === 0) return joint;
    return h01(Math.floor((i + off) / block), row, seed) < 0.3 ? alt : c;
  };
}

export function concreteWall(c: Col, panelW = 16, panelH = 14, j0 = 0): WallPaint {
  const joint = shade(c, 0.91);
  return (i, j) => ((j - j0) % panelH === panelH - 1 || i % panelW === panelW - 1 ? joint : c);
}

/** corrugated metal cladding (vertical ribs) */
export function metalWall(c: Col): WallPaint {
  const rib = shade(c, 0.88);
  const hi = shade(c, 1.05);
  return (i) => (i % 3 === 0 ? rib : i % 3 === 1 ? hi : c);
}


// ---------------------------------------------------------------------------
// Windows & doors

export type WinState = 'day' | 'lit' | 'dark' | 'boarded' | 'broken';

export interface WinStyle {
  w: number;
  h: number;
  sill?: Col | null;
  lintel?: Col | null;
  frame?: Col | null;
  mullion?: boolean;
  shutters?: Col | null;
  arch?: boolean;
  /** glass tint override (day state) */
  glass?: Col;
}

const LIT = emissive(P.glassLit);
const LIT_HI = emissive(P.glassLitHi);
const LIT_WARM = emissive(rgb(236, 168, 76));

/** Draw one window with its bottom-left glass cell at face cell (i, j). */
export function drawWindow(f: Face, i: number, j: number, st: WinStyle, state: WinState, seed = 0): void {
  const { w, h } = st;
  if (st.sill) f.rect(i, j - 1, w, 1, st.sill);
  if (st.lintel) f.rect(i, j + h, w, 1, st.lintel);
  if (st.shutters && state !== 'boarded') {
    f.rect(i - 1, j, 1, h, st.shutters);
    f.rect(i + w, j, 1, h, st.shutters);
  }
  const glass = st.glass ?? P.glassDay;
  for (let a = 0; a < w; a++) {
    for (let b = 0; b < h; b++) {
      if (st.arch && b === h - 1 && (a === 0 || a === w - 1)) continue;
      const top = b === h - 1 || (st.arch && b === h - 2 && (a === 0 || a === w - 1));
      let c: Col;
      if (state === 'boarded') {
        const plank = (b >> 1) % 2 === 0 ? P.plank : shade(P.plank, 0.86);
        c = (a + b + seed) % 7 === 0 ? shade(P.plank, 0.7) : plank;
      } else if (st.frame && (a === 0 || a === w - 1 || b === 0 || top)) {
        c = st.frame;
      } else if (st.mullion && ((w >= 4 && a === w >> 1) || (h >= 6 && b === h >> 1))) {
        c = st.frame ?? shade(glass, 0.7);
      } else if (state === 'lit') {
        c = top ? LIT_HI : a === 0 && h01(seed, i, j) < 0.5 ? LIT_WARM : LIT;
      } else if (state === 'dark') {
        c = P.glassDark;
      } else if (state === 'broken') {
        c = (a + b) % 3 === 0 ? rgb(90, 96, 110) : P.glassDark;
      } else {
        const fi = st.frame ? 1 : 0;
        const ai = a - fi;
        const bi = h - 1 - fi - b;
        c = (ai === 0 && bi === 0) || (ai === 1 && bi === 1) ? P.glassDayHi : b === fi ? shade(glass, 0.85) : glass;
      }
      f.set(i + a, j + b, c);
    }
  }
}

export interface GridOpts {
  floors: number;
  floorH: number;
  /** j of the first floor's base */
  j0: number;
  /** window bottom offset inside a floor */
  sill: number;
  pitch: number;
  bays?: number;
  margin?: number;
  /** column where the first window starts (overrides centring) */
  i0?: number;
  style: WinStyle;
  lit: number;
  seed: number;
  /** 'normal' day/lit mix, 'dark' all dark, 'boarded' all boarded, 'closed' boarded low + dark high */
  mode?: 'normal' | 'dark' | 'boarded' | 'closed' | 'distressed';
  skip?: (floor: number, bay: number, i: number) => boolean;
}

/** Deterministic "is this window lit" test; monotonic in `lit`. */
export function isLit(seed: number, axis: string, floor: number, bay: number, lit: number): boolean {
  return h01(seed, axis === 'L' ? 1 : 2, floor, bay) < lit - 1e-6;
}

/** Regular grid of windows on a face. Returns the first window column and bay count. */
export function windowGrid(f: Face, o: GridOpts): { i0: number; bays: number } {
  const margin = o.margin ?? 2;
  const bays = o.bays ?? Math.max(1, Math.floor((f.W - 2 * margin - o.style.w) / o.pitch) + 1);
  const total = (bays - 1) * o.pitch + o.style.w;
  const i0 = o.i0 ?? Math.floor((f.W - total) / 2);
  for (let fl = 0; fl < o.floors; fl++) {
    for (let b = 0; b < bays; b++) {
      const i = i0 + b * o.pitch;
      if (o.skip && o.skip(fl, b, i)) continue;
      const j = o.j0 + fl * o.floorH + o.sill;
      let st: WinState = isLit(o.seed, f.axis, fl, b, o.lit) ? 'lit' : 'day';
      const mode = o.mode ?? 'normal';
      if (mode === 'dark') st = 'dark';
      else if (mode === 'boarded') st = 'boarded';
      else if (mode === 'closed') st = fl === 0 || h01(o.seed, fl, b, 5) < 0.3 ? 'boarded' : h01(o.seed, fl, b, 9) < 0.15 ? 'broken' : 'dark';
      else if (mode === 'distressed') {
        const k = h01(o.seed, fl, b, 7);
        st = k < 0.18 ? 'broken' : k < 0.45 ? 'dark' : st;
      }
      drawWindow(f, i, j, o.style, st, o.seed + fl * 31 + b);
    }
  }
  return { i0, bays };
}

export interface DoorOpts {
  frame?: Col | null;
  glass?: boolean;
  double?: boolean;
  knob?: boolean;
  boarded?: boolean;
  lit?: boolean;
}

/** Door with bottom-left at column i (ground row j = 0). Returns local pixel of its sill centre. */
export function drawDoor(f: Face, i: number, w: number, h: number, c: Col, o: DoorOpts = {}): [number, number] {
  if (o.frame) {
    f.rect(i - 1, 0, 1, h + 1, o.frame);
    f.rect(i + w, 0, 1, h + 1, o.frame);
    f.rect(i - 1, h, w + 2, 1, o.frame);
  }
  for (let a = 0; a < w; a++) {
    for (let b = 0; b < h; b++) {
      let col = c;
      if (o.boarded) col = (b >> 1) % 2 === 0 ? P.plank : shade(P.plank, 0.85);
      else if (o.glass && b >= 2 && b < h - 1 && a > 0 && a < w - 1 - (o.double ? 0 : 0)) {
        col = o.lit ? emissive(P.glassLit) : a === 1 && b === h - 2 ? P.glassDayHi : P.glassDay;
      } else if (o.double && a === w >> 1) col = shade(c, 0.75);
      f.set(i + a, b, col);
    }
  }
  if (o.boarded) {
    // diagonal cross plank
    for (let a = 0; a < w; a++) f.set(i + a, Math.round((a * (h - 1)) / Math.max(1, w - 1)), shade(P.plank, 0.7));
  } else if (o.knob !== false && !o.glass) f.set(i + w - 2, h >> 1, P.gold);
  return f.pt(i + (w >> 1), 0);
}

// ---------------------------------------------------------------------------
// Roofs

/** Roof surface paint in slope coordinates: a = along the ridge (px), z = height. */
export type RoofMat = (a: number, z: number) => Col;

export function shingleRoof(base: Col, seed = 0): RoofMat {
  const dk = shade(base, 0.84);
  const md = shade(base, 0.93);
  const lt = shade(base, 1.07);
  return (a, z) => {
    const row = Math.floor(z / 2.2);
    const fz = z / 2.2 - row;
    if (fz < 0.34) return dk;
    const off = row % 2 ? 2 : 0;
    const col = Math.floor((a + off) / 4);
    if (Math.floor(a + off) % 4 === 0) return md;
    const k = h01(col, row, seed);
    return k < 0.12 ? md : k > 0.9 ? lt : base;
  };
}

export function tileRoof(base: Col): RoofMat {
  const dk = shade(base, 0.82);
  const lt = shade(base, 1.1);
  return (a, z) => {
    const fz = z / 2.4 - Math.floor(z / 2.4);
    if (fz < 0.3) return dk;
    const k = Math.floor(a) % 3;
    return k === 0 ? lt : k === 2 ? shade(base, 0.92) : base;
  };
}

export function metalRoof(base: Col): RoofMat {
  const dk = shade(base, 0.86);
  const lt = shade(base, 1.06);
  return (a) => {
    const k = Math.floor(a) % 3;
    return k === 0 ? dk : k === 1 ? lt : base;
  };
}

export function plainRoof(base: Col): RoofMat {
  return () => base;
}

export interface RoofOpts {
  /** eave overhang, units */
  ov?: number;
  /** rake/barge board colour (null = none) */
  barge?: Col | null;
  /** paint for the visible gable-end wall triangle */
  gable?: WallPaint | null;
  /** group of the walls (gable joins the wall silhouette) */
  gWall?: number;
}

/**
 * Gable roof over [x0,x1]x[y0,y1] with eaves at z and ridge h px higher, ridge
 * parallel to `axis`. Returns the roof group and the visible gable-end face.
 */
export function gableRoof(
  r: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z: number,
  h: number,
  axis: 'x' | 'y',
  mat: RoofMat,
  o: RoofOpts = {},
): { g: number; gable: Face | null } {
  // eaves overhang by `ov`; rakes are flush with the gable walls so the (undrawn)
  // underside of the hidden slope never shows as a see-through gap.
  const ov = o.ov ?? 2;
  const g = r.group();
  const zt = z + h;
  let gable: Face | null = null;
  if (axis === 'x') {
    const Y0 = y0 - ov, Y1 = y1 + ov;
    const ym = (y0 + y1) / 2;
    const half = (y1 - y0) / 2;
    const k = h / half;
    const ze = z - k * ov;
    const paint: SurfPaint = (x, _y, zz) => mat(x, zz);
    r.plane([[x0, Y1, ze], [x1, Y1, ze], [x1, ym, zt], [x0, ym, zt]], paint, g);
    r.plane([[x0, ym, zt], [x1, ym, zt], [x1, Y0, ze], [x0, Y0, ze]], paint, g);
    const rz = (t: number) => zt - k * Math.abs(t - ym);
    if (o.gable) gable = r.vface('R', x1, y0, y1, z, z, (t) => z + h * (1 - Math.abs(t - ym) / half), o.gable, o.gWall ?? g);
    if (o.barge) r.vface('R', x1, Y0, Y1, Math.floor(ze) - 3, (t) => rz(t) - 2, (t) => rz(t) + 0.3, o.barge, g);
  } else {
    const X0 = x0 - ov, X1 = x1 + ov;
    const xm = (x0 + x1) / 2;
    const half = (x1 - x0) / 2;
    const k = h / half;
    const ze = z - k * ov;
    const paint: SurfPaint = (_x, y, zz) => mat(y, zz);
    r.plane([[X1, y0, ze], [X1, y1, ze], [xm, y1, zt], [xm, y0, zt]], paint, g);
    r.plane([[X0, y1, ze], [X0, y0, ze], [xm, y0, zt], [xm, y1, zt]], paint, g);
    const rz = (t: number) => zt - k * Math.abs(t - xm);
    if (o.gable) gable = r.vface('L', y1, x0, x1, z, z, (t) => z + h * (1 - Math.abs(t - xm) / half), o.gable, o.gWall ?? g);
    if (o.barge) r.vface('L', y1, X0, X1, Math.floor(ze) - 3, (t) => rz(t) - 2, (t) => rz(t) + 0.3, o.barge, g);
  }
  return { g, gable };
}

/** Hip roof (pyramid when square). Ridge runs along the longer side. */
export function hipRoof(
  r: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z: number,
  h: number,
  mat: RoofMat,
  o: RoofOpts = {},
): number {
  const ov = o.ov ?? 2;
  const g = r.group();
  const X0 = x0 - ov, X1 = x1 + ov, Y0 = y0 - ov, Y1 = y1 + ov;
  const lx = x1 - x0, ly = y1 - y0;
  const half = Math.min(lx, ly) / 2;
  const k = h / half;
  const ze = z - k * ov;
  const zt = z + h;
  const H = half + ov;
  const px: SurfPaint = (x, _y, zz) => mat(x, zz);
  const py: SurfPaint = (_x, y, zz) => mat(y, zz);
  if (lx >= ly) {
    const ym = (y0 + y1) / 2;
    const ra = X0 + H, rb = X1 - H;
    r.plane([[X0, Y1, ze], [X1, Y1, ze], [rb, ym, zt], [ra, ym, zt]], px, g);
    r.plane([[X1, Y0, ze], [X0, Y0, ze], [ra, ym, zt], [rb, ym, zt]], px, g);
    r.plane([[X1, Y1, ze], [X1, Y0, ze], [rb, ym, zt]], py, g);
    r.plane([[X0, Y0, ze], [X0, Y1, ze], [ra, ym, zt]], py, g);
  } else {
    const xm = (x0 + x1) / 2;
    const ra = Y0 + H, rb = Y1 - H;
    r.plane([[X1, Y1, ze], [X1, Y0, ze], [xm, ra, zt], [xm, rb, zt]], py, g);
    r.plane([[X0, Y0, ze], [X0, Y1, ze], [xm, rb, zt], [xm, ra, zt]], py, g);
    r.plane([[X0, Y1, ze], [X1, Y1, ze], [xm, rb, zt]], px, g);
    r.plane([[X1, Y0, ze], [X0, Y0, ze], [xm, ra, zt]], px, g);
  }
  return g;
}

/** Flat roof surface plus optional parapet rim. */
export function flatRoof(
  r: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z: number,
  roof: FlatPaint,
  parapet: Col | null,
  ph = 2,
  g = r.group(),
): void {
  r.hface(x0, y0, x1, y1, z, roof, g);
  if (!parapet) return;
  // 2-unit thick rim: reads as a clean lit cap line instead of a dotted 1px ridge
  const gp = r.group();
  const t = 2;
  r.box(x0, y0, z, x1, y0 + t, z + ph, parapet, parapet, gp);
  r.box(x0, y0, z, x0 + t, y1, z + ph, parapet, parapet, gp);
  r.box(x0, y1 - t, z, x1, y1, z + ph, parapet, parapet, gp);
  r.box(x1 - t, y0, z, x1, y1, z + ph, parapet, parapet, gp);
}

/** Roofed parapet cap/cornice band running around the top of a box. */
export function cornice(r: Raster, x0: number, y0: number, x1: number, y1: number, z: number, h: number, c: Col, ov = 1): number {
  const g = r.group();
  r.box(x0 - ov, y0 - ov, z, x1 + ov, y1 + ov, z + h, c, c, g);
  return g;
}

// ---------------------------------------------------------------------------
// Facade add-ons

/** World-space face parallel to f, `out` units in front of it, covering columns [i0, i1). */
function parallel(f: Face, out: number, i0: number, i1: number): ['L' | 'R', number, number, number] {
  if (f.axis === 'L') return ['L', f.c + out, f.a0 + i0, f.a0 + i1];
  return ['R', f.c + out, f.a1 - i1, f.a1 - i0];
}


/**
 * Sloped fabric awning from the wall (height j) out to `out` units, dropping `drop`
 * px, with a 2px valance. Colours alternate every `stripe` columns (colB null = plain).
 */
export function awning(
  f: Face,
  i0: number,
  i1: number,
  j: number,
  out: number,
  drop: number,
  colA: Col,
  colB: Col | null,
  stripe = 2,
  torn = false,
): number {
  const r = f.r;
  const g = r.group();
  const colAt = (i: number) => (colB !== null && Math.floor((i - i0) / stripe) % 2 === 1 ? colB : colA);
  const P1 = f.world(i0 - 0.5, 0, j);
  const P2 = f.world(i1 - 0.5, 0, j);
  const P3 = f.world(i1 - 0.5, out, j - drop);
  const P4 = f.world(i0 - 0.5, out, j - drop);
  const idx = (x: number, y: number) => Math.floor(f.axis === 'L' ? x - f.a0 : f.a1 - y);
  r.plane(
    [P1, P2, P3, P4],
    (x, y, z) => {
      const i = idx(x, y);
      if (torn && h01(i, Math.floor(z), 3) < 0.35 && (i + Math.floor(z)) % 3 !== 0) return 0;
      return colAt(i);
    },
    g,
  );
  // valance: a 2px hem along the outer edge (ragged when torn)
  const zb = f.zRef + j - drop;
  const [ax, c, a0, a1] = parallel(f, out, i0, i1);
  const hem = (t: number) => {
    if (!torn) return zb - 2;
    const i = Math.floor(f.axis === 'L' ? t - f.a0 : f.a1 - t);
    return zb - (h01(i, 7) < 0.5 ? 0 : 1);
  };
  r.vface(ax, c, a0, a1, zb - 2, hem, zb, (i) => (torn && i % 4 === 1 ? 0 : shade(colAt(i + i0), 0.92)), g);
  return g;
}

/**
 * Sign board mounted on a face (thin protruding box) with optional centred text.
 * Returns the board's front face.
 */
export function signBoard(
  f: Face,
  i0: number,
  w: number,
  j0: number,
  h: number,
  bg: Col,
  text?: string,
  fg: Col = P.white,
  out = 1,
  border: Col | null = null,
): Face {
  const [x0, y0, z0, x1, y1, z1] = f.boxOut(i0, i0 + w, 0, out, j0, j0 + h);
  const b = f.r.box(x0, y0, z0, x1, y1, z1, bg, bg);
  const front = f.axis === 'L' ? b.L : b.R;
  if (border) {
    front.rect(0, 0, w, 1, border);
    front.rect(0, h - 1, w, 1, border);
    front.rect(0, 0, 1, h, border);
    front.rect(w - 1, 0, 1, h, border);
  }
  if (text) {
    const tw = textBitmap(text).w;
    front.text(text, Math.floor((w - tw) / 2), Math.floor((h - 5) / 2) + 4, fg, textBitmap);
  }
  return front;
}

/** Horizontal slab protruding from a face (canopy / balcony floor). */
export function slab(f: Face, i0: number, i1: number, out: number, j: number, th: number, c: Col, g = f.r.group()): number {
  const [x0, y0, z0, x1, y1, z1] = f.boxOut(i0, i1, 0, out, j, j + th);
  f.r.box(x0, y0, z0, x1, y1, z1, c, c, g);
  return g;
}

/** Balcony: slab + railing along its front and ends. */
export function balcony(f: Face, i0: number, i1: number, j: number, out: number, floor: Col, rail: Col): void {
  const r = f.r;
  slab(f, i0, i1, out, j, 1, floor);
  const gr = r.group();
  // front railing panel (solid lower part + top rail)
  const [ax, c, a0, a1] = parallel(f, out, i0, i1);
  r.vface(ax, c - 0.01, a0, a1, f.zRef + j + 1, f.zRef + j + 1, f.zRef + j + 4, (_i, jj) => (jj === 2 ? shade(rail, 1.1) : rail), gr);
  // end railings
  if (f.axis === 'L') {
    r.vface('R', f.a0 + i1, f.c, f.c + out, f.zRef + j + 1, f.zRef + j + 1, f.zRef + j + 4, rail, gr);
  } else {
    r.vface('L', f.a1 - i0, f.c, f.c + out, f.zRef + j + 1, f.zRef + j + 1, f.zRef + j + 4, rail, gr);
  }
}



/** Round column (cylinder) with base and capital blocks. */
export function column(r: Raster, x: number, y: number, rad: number, z0: number, z1: number, c: Col): void {
  const g = r.group();
  const e = rad + 1;
  r.box(x - e, y - e, z0, x + e, y + e, z0 + 2, shade(c, 0.95), c, g);
  r.cylinder(x, y, rad, z0 + 2, z1 - 2, (_z, t) => (Math.abs(t) < 0.25 ? shade(c, 1.04) : c), null, g, 3);
  r.box(x - e, y - e, z1 - 2, x + e, y + e, z1, shade(c, 0.95), c, g);
}

// ---------------------------------------------------------------------------
// Small structures

export function chimney(r: Raster, x: number, y: number, z0: number, z1: number, c: Col, s = 4): void {
  const g = r.group();
  r.box(x, y, z0, x + s, y + s, z1, brick(c, 5), shade(P.black, 1.4), g);
  r.box(x - 1, y - 1, z1, x + s + 1, y + s + 1, z1 + 1, shade(c, 0.8), shade(c, 0.85), g);
  r.hface(x, y, x + s, y + s, z1 + 1, P.black, g);
}

export function acUnit(r: Raster, x: number, y: number, z: number, s = 5): void {
  const g = r.group();
  const body = rgb(196, 198, 196);
  r.box(x, y, z, x + s, y + s - 1, z + 3, (i, j) => (j === 1 && i % 2 === 0 ? shade(body, 0.8) : body), body, g);
  r.disc(x + s / 2, y + (s - 1) / 2, 1.6, z + 3, rgb(90, 94, 100), g);
}

export function waterTank(r: Raster, x: number, y: number, z: number, rad = 5, h = 9): void {
  const g = r.group();
  const leg = P.woodDark;
  for (const [dx, dy] of [[-rad + 1, 0], [rad - 1, 0], [0, -rad + 1], [0, rad - 1]]) r.pole(x + dx, y + dy, z, z + 4, leg, g, false);
  r.cylinder(x, y, rad, z + 4, z + 4 + h, (zz) => (Math.floor(zz) % 3 === 0 ? P.woodDark : P.wood), null, g);
  // conical cap
  const tip: [number, number, number] = [x, y, z + 4 + h + 4];
  const n = 12;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    r.plane(
      [
        [x + Math.cos(a0) * (rad + 0.5), y + Math.sin(a0) * (rad + 0.5), z + 4 + h],
        [x + Math.cos(a1) * (rad + 0.5), y + Math.sin(a1) * (rad + 0.5), z + 4 + h],
        tip,
      ],
      rgb(92, 84, 80),
      g,
    );
  }
}

/** Roof stair housing with a door and a vent pipe (big flat roofs). */
export function roofHousing(r: Raster, x0: number, y0: number, x1: number, y1: number, z: number, h: number, wall: Col, roof: Col): void {
  const g = r.group();
  const b = r.box(x0, y0, z, x1, y1, z + h, (_i, j) => (j === h - 1 ? shade(wall, 1.08) : wall), roof, g);
  // door on the left (down-left facing) side
  const f = b.L;
  const di = Math.max(1, Math.floor(f.W / 2) - 1);
  f.rect(di, 0, 3, Math.min(6, h - 2), rgb(92, 84, 80));
  // vent pipe beside it
  const gv = r.group();
  r.cylinder(x1 + 3, y0 + 2, 1.2, z, z + 5, P.steelLight, P.steelDark, gv, 3);
}

export function antenna(r: Raster, x: number, y: number, z: number, h: number, blink = true): void {
  const g = r.group();
  r.pole(x, y, z, z + h, rgb(150, 154, 160), g);
  r.pole(x - 2, y, z + h - 6, z + h - 5, rgb(150, 154, 160), g);
  if (blink) r.dot(x, y, z + h, emissive(rgb(255, 70, 60)), g);
}

/** Flagpole with a small waving flag (flag faces the viewer). */
export function flagpole(r: Raster, x: number, y: number, z: number, h: number, flag: Col, flag2: Col | null = null): void {
  const g = r.group();
  r.pole(x, y, z, z + h, rgb(210, 210, 214), g);
  r.dot(x, y, z + h, P.gold, g);
  const [sx, sy] = project(x, y, z + h - 1);
  const px0 = Math.floor(sx) + 1;
  const py0 = Math.floor(sy);
  const fw = 9;
  const fh = 6;
  for (let a = 0; a < fw; a++) {
    const wave = Math.round(Math.sin((a / fw) * Math.PI * 1.6) * 0.8);
    for (let b = 0; b < fh; b++) {
      let c = flag;
      if (flag2 !== null && b >= fh / 2) c = flag2;
      if (b === 0) c = shade(c, 1.1);
      if (a === fw - 1 || b === fh - 1) c = shade(c, 0.85);
      r.plot(px0 + a, py0 + b + wave, c, x + y + 0.2, g, false);
    }
  }
}

/** Picket fence along a straight world line from (x0,y0) to (x1,y1) (axis aligned). */
export function fence(r: Raster, x0: number, y0: number, x1: number, y1: number, c: Col, h = 4, spacing = 2): void {
  const g = r.group();
  const alongX = y0 === y1;
  const len = alongX ? x1 - x0 : y1 - y0;
  for (let k = 0; k <= len; k += spacing) {
    const x = alongX ? x0 + k : x0;
    const y = alongX ? y0 : y0 + k;
    r.pole(x, y, 0, h, c, g, false);
  }
  const dark = shade(c, 0.85);
  for (let k = 0; k < len; k++) {
    const x = alongX ? x0 + k + 0.5 : x0;
    const y = alongX ? y0 : y0 + k + 0.5;
    r.dot(x, y, h - 1, dark, g, false);
    r.dot(x, y, 1, dark, g, false);
  }
}

/** Low hedge along an axis-aligned rectangle. */
export function hedge(r: Raster, x0: number, y0: number, x1: number, y1: number, h = 4): void {
  const base = rgb(64, 124, 56);
  r.box(
    x0,
    y0,
    0,
    x1,
    y1,
    h,
    (i, j) => (h01(i, j, 17) < 0.25 ? shade(base, 0.85) : h01(i, j, 18) < 0.15 ? shade(base, 1.15) : base),
    (x, y) => (h01(Math.floor(x * 2), Math.floor(y * 2), 3) < 0.3 ? shade(base, 1.18) : shade(base, 1.05)),
  );
}

/** Stack of boxes (lumber, bricks, crates) — simple helper returning the group. */
export function crate(r: Raster, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, c: Col, paint?: WallPaint): number {
  const g = r.group();
  r.box(x0, y0, z0, x1, y1, z1, paint ?? c, shade(c, 1.05), g);
  return g;
}

// ---------------------------------------------------------------------------
// Shading helpers

/**
 * Soft contact shadow on the lot ground, cast away from the light (towards +x and a
 * little +y) by a box footprint. Kept short so it never reaches the lot edge on
 * typical layouts; only ground pixels are darkened.
 */
export function groundShadow(r: Raster, x0: number, y0: number, x1: number, y1: number, len: number): void {
  const ox = len;
  const oy = len * 0.35;
  const pxa = Math.floor(x0 - (y1 + oy)) - 1;
  const pxb = Math.ceil(x1 + ox - y0) + 1;
  const pya = Math.floor((x0 + y0) / 2) - 1;
  const pyb = Math.ceil((x1 + ox + y1 + oy) / 2) + 1;
  const dark = rgb(34, 44, 66);
  for (let py = pya; py <= pyb; py++) {
    for (let px = pxa; px <= pxb; px++) {
      if (r.groupAt(px, py) !== 1) continue;
      const x = (px + 0.5 + 2 * (py + 0.5)) / 2;
      const y = (2 * (py + 0.5) - (px + 0.5)) / 2;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      let hit = false;
      for (let k = 1; k <= 6 && !hit; k++) {
        const t = k / 6;
        const sx = x - ox * t;
        const sy = y - oy * t;
        hit = sx >= x0 && sx < x1 && sy >= y0 && sy < y1;
      }
      if (hit) r.tint(px, py, (c) => mix(c, dark, 0.2));
    }
  }
}
