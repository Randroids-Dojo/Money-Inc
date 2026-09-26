// A tiny software rasteriser for crisp isometric pixel art.
//
// WORLD SPACE (inside one sprite)
//   x, y : "units" of 1/32 tile along the iso axes (+x down-right, +y down-left)
//   z    : height in screen pixels
// A w x d footprint spans x in [0, 32w], y in [0, 32d]; its top corner is the origin.
// Projection to local screen pixels:   sx = x - y,   sy = (x + y) / 2 - z
//
// PIXEL RULE: a pixel (px, py) belongs to a shape when its centre (px+.5, py+.5)
// lies inside the projected shape (half-open). With integer unit coordinates this
// yields the classic 2:1 staircases (1px step every 2 columns) and neighbouring
// shapes/tiles meet without gaps or overlaps; a whole-tile footprint rasterises to
// exactly the renderer's 64x32 ground diamond.
//
// DEPTH: every plotted pixel stores the depth (x + y) of the surface point it shows;
// larger means nearer the viewer. Shapes can therefore be drawn in any order and
// occlusion just works (z-buffer). Each shape also carries a group id; the outline
// pass darkens pixels on the silhouette of a group (next to empty space, or next to
// a different group that lies behind it), giving the 1px darker outline.
//
// COLOUR: paint callbacks return *base* colours; the primitive shades them for the
// face orientation (top brightest, left mid, right darkest) unless the colour is
// flagged emissive (see color.ts).

import { type Col, shade, isEmissive } from './color';

export const G_EMPTY = 0;
export const G_GROUND = 1;

export const TONE_TOP = 1.1;
export const TONE_LEFT = 1.0;
export const TONE_RIGHT = 0.78;

/** Metric correction: slope in px/unit -> true-proportion slope (1 unit ~ 1.41px, 1 z px ~ 1.15px). */
const SLOPE_K = 0.8165;

/** Brightness factor for a surface normal (light from the upper-left / -x side). */
export function toneOfNormal(nx: number, ny: number, nz: number): number {
  const l = Math.hypot(nx, ny, nz) || 1;
  return 0.968 + (0.132 * nz - 0.19 * nx + 0.032 * ny) / l;
}

const toneCache = new Map<number, Map<number, number>>();

/** Shade a base colour for a face tone (cached). Emissive colours pass through. */
export function lit(c: Col, tone: number): Col {
  if (isEmissive(c)) return (c | 0xff000000) >>> 0;
  const tk = Math.round(tone * 100);
  if (tk === 100) return c;
  let m = toneCache.get(tk);
  if (!m) {
    m = new Map();
    toneCache.set(tk, m);
  }
  let v = m.get(c);
  if (v === undefined) {
    v = shade(c, tk / 100);
    m.set(c, v);
  }
  return v;
}

export type WallPaint = Col | ((i: number, j: number, f: Face) => Col);
export type FlatPaint = Col | ((x: number, y: number) => Col);
export type SurfPaint = Col | ((x: number, y: number, z: number) => Col);
export type ZProfile = number | ((t: number) => number);

/** Pixel-art stamp (hand drawn or pre-rendered), anchored at (ax, ay). */
export interface Art {
  w: number;
  h: number;
  ax: number;
  ay: number;
  data: Uint32Array;
}

/**
 * A vertical face on the plane y = c ('L', faces +y / down-left) or x = c ('R', faces
 * +x / down-right), spanning a0..a1 along its axis. Cells are addressed by (i, j):
 * i = pixel column from the face's screen-left edge, j = pixel row above zRef.
 */
export class Face {
  readonly W: number;
  readonly pxStart: number;
  /** py of row j = 0, per column */
  readonly bot: Int32Array;
  /** valid j range per column: lo <= j < hi */
  readonly lo: Int32Array;
  readonly hi: Int32Array;

  constructor(
    readonly r: Raster,
    readonly axis: 'L' | 'R',
    readonly c: number,
    readonly a0: number,
    readonly a1: number,
    readonly zRef: number,
    zBot: ZProfile,
    zTop: ZProfile,
    readonly g: number,
    readonly tone: number,
  ) {
    this.W = Math.max(0, Math.round(a1 - a0));
    this.pxStart = axis === 'L' ? Math.round(a0 - c) : Math.round(c - a1);
    this.bot = new Int32Array(this.W);
    this.lo = new Int32Array(this.W);
    this.hi = new Int32Array(this.W);
    for (let i = 0; i < this.W; i++) {
      const px = this.pxStart + i;
      const f = axis === 'L' ? px / 2 + c - zRef - 0.25 : c - px / 2 - zRef - 0.75;
      const b = Math.floor(f);
      const fr = f - b;
      this.bot[i] = b;
      const t = this.along(i + 0.5);
      const zb = typeof zBot === 'number' ? zBot : zBot(t);
      const zt = typeof zTop === 'number' ? zTop : zTop(t);
      this.lo[i] = Math.ceil(zb - zRef - fr);
      this.hi[i] = Math.ceil(zt - zRef - fr);
    }
  }

  /** Height (rows) of column i measured from zRef. */
  get H(): number {
    let m = 0;
    for (let i = 0; i < this.W; i++) m = Math.max(m, this.hi[i]);
    return m;
  }

  /** World coordinate along the face axis at column position i (fractional ok). */
  along(i: number): number {
    return this.axis === 'L' ? this.a0 + i : this.a1 - i;
  }

  depth(i: number): number {
    const cx = this.pxStart + i + 0.5;
    return this.axis === 'L' ? cx + 2 * this.c : 2 * this.c - cx;
  }

  px(i: number): number {
    return this.pxStart + i;
  }

  py(i: number, j: number): number {
    return this.bot[Math.max(0, Math.min(this.W - 1, i))] - j;
  }

  inside(i: number, j: number): boolean {
    return i >= 0 && i < this.W && j >= this.lo[i] && j < this.hi[i];
  }

  /** Plot a base colour at cell (i, j), shaded by the face tone. Clipped to the face. */
  set(i: number, j: number, col: Col): void {
    if (!col || i < 0 || i >= this.W || j < this.lo[i] || j >= this.hi[i]) return;
    this.r.plot(this.pxStart + i, this.bot[i] - j, lit(col, this.tone), this.depth(i), this.g);
  }

  /** Like set() but only clipped to the face columns (may extend above/below). */
  setFree(i: number, j: number, col: Col, g = this.g): void {
    if (!col || i < 0 || i >= this.W) return;
    this.r.plot(this.pxStart + i, this.bot[i] - j, lit(col, this.tone), this.depth(i), g);
  }

  get(i: number, j: number): Col {
    if (i < 0 || i >= this.W) return 0;
    return this.r.get(this.pxStart + i, this.bot[i] - j);
  }

  rect(i: number, j: number, w: number, h: number, paint: WallPaint): void {
    for (let a = i; a < i + w; a++) {
      for (let b = j; b < j + h; b++) {
        this.set(a, b, typeof paint === 'number' ? paint : paint(a, b, this));
      }
    }
  }

  fill(paint: WallPaint): void {
    for (let i = 0; i < this.W; i++) {
      for (let j = this.lo[i]; j < this.hi[i]; j++) {
        this.set(i, j, typeof paint === 'number' ? paint : paint(i, j, this));
      }
    }
  }

  /** Darken/recolour existing face pixels in a rect (e.g. eave shadow). */
  tint(i: number, j: number, w: number, h: number, fn: (c: Col) => Col): void {
    for (let a = Math.max(0, i); a < Math.min(this.W, i + w); a++) {
      for (let b = j; b < j + h; b++) {
        if (b < this.lo[a] || b >= this.hi[a]) continue;
        const px = this.pxStart + a;
        const py = this.bot[a] - b;
        if (this.r.depthAt(px, py) <= this.depth(a) + 0.001 && this.r.groupAt(px, py) === this.g) {
          this.r.recolor(px, py, fn(this.r.get(px, py)));
        }
      }
    }
  }

  /**
   * Draw pixel text on the face. Each glyph is kept upright (not sheared) and glyphs
   * step along the face slope, which keeps tiny text legible. jTop = row of the cap line.
   */
  text(s: string, i: number, jTop: number, col: Col, font: (s: string) => TextBitmap): number {
    const bm = font(s);
    const c = lit(col, this.tone);
    for (const gl of bm.glyphs) {
      const mid = Math.max(0, Math.min(this.W - 1, i + gl.x + (gl.w >> 1)));
      for (const [gx, gy] of gl.px) {
        const ci = i + gl.x + gx;
        if (ci < 0 || ci >= this.W) continue;
        this.r.plot(this.pxStart + ci, this.bot[mid] - jTop + gy, c, this.depth(ci) + 0.01, this.g);
      }
    }
    return bm.w;
  }

  /** World point at the centre of column i, `out` units in front of the face, height zRef + j. */
  world(i: number, out: number, j: number): [number, number, number] {
    return this.axis === 'L'
      ? [this.a0 + i + 0.5, this.c + out, this.zRef + j]
      : [this.c + out, this.a1 - i - 0.5, this.zRef + j];
  }

  /**
   * World-space box protruding from the face: columns [i0, i1), `out0..out1` units in
   * front of the face, heights zRef + j0 .. zRef + j1.
   */
  boxOut(i0: number, i1: number, out0: number, out1: number, j0: number, j1: number): [number, number, number, number, number, number] {
    if (this.axis === 'L') {
      return [this.a0 + i0, this.c + out0, this.zRef + j0, this.a0 + i1, this.c + out1, this.zRef + j1];
    }
    return [this.c + out0, this.a1 - i1, this.zRef + j0, this.c + out1, this.a1 - i0, this.zRef + j1];
  }

  /** Local screen pixel of face cell (i, j). */
  pt(i: number, j: number): [number, number] {
    return [this.pxStart + i, this.py(i, j)];
  }
}

export interface TextBitmap {
  w: number;
  h: number;
  glyphs: { x: number; w: number; px: [number, number][] }[];
}

export interface BoxFaces {
  L: Face;
  R: Face;
  g: number;
}

/** Scanline-fill a 2D polygon with the half-open pixel-centre rule. */
export function fillPolygon(pts: ReadonlyArray<readonly [number, number]>, cb: (px: number, py: number) => void): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const n = pts.length;
  const xs: number[] = [];
  for (let py = Math.floor(minY - 0.5); py <= Math.ceil(maxY); py++) {
    const cy = py + 0.5;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if ((a[1] <= cy && cy < b[1]) || (b[1] <= cy && cy < a[1])) {
        xs.push(a[0] + ((cy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.ceil(xs[k] - 0.5 - 1e-9);
      const xb = Math.ceil(xs[k + 1] - 0.5 - 1e-9) - 1;
      for (let px = xa; px <= xb; px++) cb(px, py);
    }
  }
}

export class Raster {
  readonly col: Uint32Array;
  readonly dep: Float32Array;
  readonly grp: Uint16Array;
  readonly nol: Uint8Array;
  /** shadow alpha for pixels that are otherwise empty (rendered semi-transparent) */
  readonly sh: Uint8Array;
  /**
   * Whether shadows may be cast onto empty pixels (semi-transparent). True for
   * standalone props/vehicles; building rasters turn it off so shadows never leave
   * their own lot.
   */
  emptyShadows = true;
  private gNext = 2;

  /** W x H canvas; (ox, oy) = canvas pixel of the world origin (footprint top corner). */
  constructor(
    readonly W: number,
    readonly H: number,
    readonly ox: number,
    readonly oy: number,
  ) {
    const n = W * H;
    this.col = new Uint32Array(n);
    this.dep = new Float32Array(n).fill(-1e9);
    this.grp = new Uint16Array(n);
    this.nol = new Uint8Array(n);
    this.sh = new Uint8Array(n);
  }

  /**
   * Cast a shadow on a pixel: ground pixels are darkened, empty pixels get a
   * semi-transparent shadow (so standalone props carry their own soft shadow).
   */
  shadow(px: number, py: number, alpha = 64): void {
    const k = this.idx(px, py);
    if (k < 0) return;
    if (this.grp[k] === G_GROUND) {
      if (this.sh[k] === 0) this.col[k] = mixDark(this.col[k], alpha / 255);
      this.sh[k] = 255;
    } else if (this.grp[k] === G_EMPTY && this.emptyShadows) this.sh[k] = Math.max(this.sh[k], alpha);
  }

  /**
   * Remove everything below the lower edges of a w x d footprint diamond (ground-level
   * spill into the tiles in front). Keeps sprites strictly inside their lot.
   */
  clipFootprint(w: number, d: number): void {
    const { W, H } = this;
    for (let Y = 0; Y < H; Y++) {
      const py = Y - this.oy;
      for (let X = 0; X < W; X++) {
        const px = X - this.ox;
        const U = px + 2 * py + 1;
        const V = 2 * py - px;
        if (U >= 64 * w || V >= 64 * d) {
          const k = Y * W + X;
          this.grp[k] = G_EMPTY;
          this.col[k] = 0;
          this.sh[k] = 0;
          this.dep[k] = -1e9;
        }
      }
    }
  }

  /** Soft elliptical shadow centred at local pixel (cx, cy). */
  shadowEllipse(cx: number, cy: number, rx: number, ry: number, alpha = 64): void {
    for (let py = Math.floor(cy - ry); py <= Math.ceil(cy + ry); py++) {
      for (let px = Math.floor(cx - rx); px <= Math.ceil(cx + rx); px++) {
        const dx = (px + 0.5 - cx) / rx;
        const dy = (py + 0.5 - cy) / ry;
        if (dx * dx + dy * dy < 1) this.shadow(px, py, alpha);
      }
    }
  }

  /** Allocate a fresh outline group id. */
  group(): number {
    return this.gNext++;
  }

  private idx(px: number, py: number): number {
    const X = px + this.ox;
    const Y = py + this.oy;
    if (X < 0 || Y < 0 || X >= this.W || Y >= this.H) return -1;
    return Y * this.W + X;
  }

  /** Depth-tested plot of an already-shaded colour. */
  plot(px: number, py: number, c: Col, d: number, g: number, noOutline = false): void {
    if (!c) return;
    const k = this.idx(px, py);
    if (k < 0 || d < this.dep[k] - 0.001) return;
    this.col[k] = (c | 0xff000000) >>> 0;
    this.dep[k] = d;
    this.grp[k] = g;
    this.nol[k] = noOutline ? 1 : 0;
  }

  get(px: number, py: number): Col {
    const k = this.idx(px, py);
    return k < 0 ? 0 : this.col[k];
  }

  depthAt(px: number, py: number): number {
    const k = this.idx(px, py);
    return k < 0 ? -1e9 : this.dep[k];
  }

  groupAt(px: number, py: number): number {
    const k = this.idx(px, py);
    return k < 0 ? 0 : this.grp[k];
  }

  /** Replace the colour of an existing pixel (no depth change). */
  recolor(px: number, py: number, c: Col): void {
    const k = this.idx(px, py);
    if (k >= 0 && this.grp[k] !== G_EMPTY) this.col[k] = (c | 0xff000000) >>> 0;
  }

  /** Apply fn to an existing pixel's colour (e.g. a drop shadow). */
  tint(px: number, py: number, fn: (c: Col) => Col): void {
    const k = this.idx(px, py);
    if (k >= 0 && this.grp[k] !== G_EMPTY) this.col[k] = (fn(this.col[k]) | 0xff000000) >>> 0;
  }

  /** Vertical face. zBot/zTop may vary along the face (gables, barge boards). */
  vface(
    axis: 'L' | 'R',
    c: number,
    a0: number,
    a1: number,
    zRef: number,
    zBot: ZProfile,
    zTop: ZProfile,
    paint: WallPaint | null,
    g: number,
    tone = axis === 'L' ? TONE_LEFT : TONE_RIGHT,
  ): Face {
    const f = new Face(this, axis, c, a0, a1, zRef, zBot, zTop, g, tone);
    if (paint !== null) f.fill(paint);
    return f;
  }

  /** Horizontal rectangle x0..x1, y0..y1 at integer height z. */
  hface(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z: number,
    paint: FlatPaint,
    g: number,
    tone = TONE_TOP,
    noOutline = false,
  ): void {
    const zi = Math.round(z);
    const Umin = Math.ceil(2 * x0 - 0.5);
    const Umax = Math.ceil(2 * x1 - 0.5) - 1;
    const Vmin = Math.ceil(2 * y0 - 0.5);
    const Vmax = Math.ceil(2 * y1 - 0.5) - 1;
    const pxa = Math.floor(x0 - y1) - 1;
    const pxb = Math.ceil(x1 - y0) + 1;
    for (let px = pxa; px <= pxb; px++) {
      // lattice: U = px + 2Y + 1, V = 2Y - px, Y = py + z
      const ya = Math.max(Math.ceil((Umin - px - 1) / 2), Math.ceil((Vmin + px) / 2));
      const yb = Math.min(Math.floor((Umax - px - 1) / 2), Math.floor((Vmax + px) / 2));
      for (let Y = ya; Y <= yb; Y++) {
        const x = (px + 2 * Y + 1.5) / 2;
        const y = (2 * Y - px + 0.5) / 2;
        const c = typeof paint === 'number' ? paint : paint(x, y);
        if (c) this.plot(px, Y - zi, lit(c, tone), x + y, g, noOutline);
      }
    }
  }

  /** Ground-level decal / lot surface: never outlined, not shaded. */
  ground(x0: number, y0: number, x1: number, y1: number, paint: FlatPaint): void {
    this.hface(x0, y0, x1, y1, 0, paint, G_GROUND, 1, true);
  }

  /** Axis-aligned box. `top` null skips the top face (e.g. when a roof covers it). */
  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    side: WallPaint,
    top: FlatPaint | null,
    g = this.group(),
    sideR: WallPaint = side,
  ): BoxFaces {
    const L = this.vface('L', y1, x0, x1, z0, z0, z1, side, g);
    const R = this.vface('R', x1, y0, y1, z0, z0, z1, sideR, g);
    if (top !== null) this.hface(x0, y0, x1, y1, z1, top, g);
    return { L, R, g };
  }

  /**
   * Arbitrary planar (non-vertical) polygon in world space; used for roof slopes,
   * awnings, ramps. Back-facing planes are skipped. Tone is derived from the normal.
   */
  plane(
    pts: ReadonlyArray<readonly [number, number, number]>,
    paint: SurfPaint,
    g: number,
    toneOverride?: number,
    noOutline = false,
  ): void {
    if (pts.length < 3) return;
    const p0 = pts[0];
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let k = 1; k + 1 < pts.length && Math.abs(nz) < 1e-9; k++) {
      const p1 = pts[k];
      const p2 = pts[k + 1];
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
      nx = uy * vz - uz * vy;
      ny = uz * vx - ux * vz;
      nz = ux * vy - uy * vx;
    }
    if (Math.abs(nz) < 1e-9) return;
    const a = -nx / nz;
    const b = -ny / nz;
    const c = p0[2] - a * p0[0] - b * p0[1];
    const den = 1 - a - b;
    if (den <= 1e-6) return;
    const tone = toneOverride ?? toneOfNormal(-a * SLOPE_K, -b * SLOPE_K, 1);
    const sp = pts.map((p) => [p[0] - p[1], (p[0] + p[1]) / 2 - p[2]] as const);
    fillPolygon(sp, (px, py) => {
      const cx = px + 0.5;
      const cy = py + 0.5;
      const s = (2 * cy + 2 * c + cx * (a - b)) / den;
      const x = (s + cx) / 2;
      const y = (s - cx) / 2;
      const z = a * x + b * y + c;
      const col = typeof paint === 'number' ? paint : paint(x, y, z);
      if (col) this.plot(px, py, lit(col, tone), s, g, noOutline);
    });
  }

  /**
   * Vertical cylinder (tanks, silos, stacks). `side(z, t)` returns the base colour at
   * height z and horizontal position t in (-1, 1); shading is banded for a pixel look.
   */
  cylinder(
    xc: number,
    yc: number,
    rad: number,
    z0: number,
    z1: number,
    side: Col | ((z: number, t: number) => Col),
    top: FlatPaint | null,
    g = this.group(),
    bands = 5,
  ): number {
    const R2 = Math.SQRT2 * rad;
    const sc = xc - yc;
    for (let px = Math.floor(sc - R2) - 1; px <= Math.ceil(sc + R2) + 1; px++) {
      const t = (px + 0.5 - sc) / R2;
      if (t <= -1 || t >= 1) continue;
      const sn = Math.sqrt(1 - t * t);
      const s = xc + yc + R2 * sn;
      const nx = (t + sn) / Math.SQRT2;
      const ny = (sn - t) / Math.SQRT2;
      let tone = toneOfNormal(nx, ny, 0);
      tone = Math.round(tone * bands * 4) / (bands * 4);
      const base = s / 2;
      const ya = Math.ceil(base - z1 - 0.5);
      const yb = Math.ceil(base - z0 - 0.5) - 1;
      for (let py = ya; py <= yb; py++) {
        const z = base - py - 0.5;
        const c = typeof side === 'number' ? side : side(z, t);
        if (c) this.plot(px, py, lit(c, tone), s, g);
      }
    }
    if (top !== null) this.disc(xc, yc, rad, z1, top, g);
    return g;
  }

  /**
   * Axis-aligned ellipsoid (radii rx, ry in units, rz in px) centred at (xc, yc, zc),
   * ray-cast per pixel. Parts below zMin are cut away (domes). paint(x, y, z, nz)
   * returns a base colour; shading comes from the surface normal, banded.
   */
  ellipsoid(
    xc: number,
    yc: number,
    zc: number,
    rx: number,
    ry: number,
    rz: number,
    paint: Col | ((x: number, y: number, z: number) => Col),
    g = this.group(),
    zMin = -1e9,
    bands = 6,
  ): number {
    const sc = xc - yc;
    const ext = Math.SQRT2 * Math.max(rx, ry) + 1;
    const [, cyc] = project(xc, yc, zc);
    const vext = Math.max(rx, ry) / 1.2 + rz + 2;
    const au = 1 / (2 * rx), av = 1 / (2 * ry), aw = 1 / (2 * rz);
    const A2 = au * au + av * av + aw * aw;
    for (let px = Math.floor(sc - ext); px <= Math.ceil(sc + ext); px++) {
      const cx = px + 0.5;
      for (let py = Math.floor(cyc - vext); py <= Math.ceil(cyc + vext); py++) {
        const cy = py + 0.5;
        const bu = (cx / 2 - xc) / rx;
        const bv = (-cx / 2 - yc) / ry;
        const bw = (-cy - zc) / rz;
        const B2 = 2 * (au * bu + av * bv + aw * bw);
        const C2 = bu * bu + bv * bv + bw * bw - 1;
        const disc = B2 * B2 - 4 * A2 * C2;
        if (disc < 0) continue;
        const s = (-B2 + Math.sqrt(disc)) / (2 * A2);
        const x = (s + cx) / 2;
        const y = (s - cx) / 2;
        const z = s / 2 - cy;
        if (z < zMin) continue;
        const u = (x - xc) / rx, v = (y - yc) / ry, w = (z - zc) / rz;
        let tone = toneOfNormal(u / (rx * 1.414), v / (ry * 1.414), w / (rz * 1.155));
        tone = Math.round(tone * bands * 4) / (bands * 4);
        const c = typeof paint === 'number' ? paint : paint(x, y, z);
        if (c) this.plot(px, py, lit(c, tone), s, g);
      }
    }
    return g;
  }

  /** Horizontal disc (cylinder cap, basin, round plaza). */
  disc(xc: number, yc: number, rad: number, z: number, paint: FlatPaint, g: number, tone = TONE_TOP, noOutline = false): void {
    const r2 = rad * rad;
    this.hface(
      xc - rad,
      yc - rad,
      xc + rad,
      yc + rad,
      z,
      (x, y) => {
        const dx = x - xc;
        const dy = y - yc;
        if (dx * dx + dy * dy >= r2) return 0;
        return typeof paint === 'number' ? paint : paint(x, y);
      },
      g,
      tone,
      noOutline,
    );
  }

  /** Stamp a pixel-art image with its anchor at local pixel (px, py) and a fixed depth. */
  stamp(art: Art, px: number, py: number, depth: number, g = this.group(), noOutline = false): void {
    for (let j = 0; j < art.h; j++) {
      for (let i = 0; i < art.w; i++) {
        const c = art.data[j * art.w + i];
        if (c) this.plot(px - art.ax + i, py - art.ay + j, c, depth, g, noOutline);
      }
    }
  }

  /** Stamp art standing at world point (x, y, z) (anchor = ground contact point). */
  stampAt(art: Art, x: number, y: number, z: number, g = this.group(), noOutline = false): void {
    const [px, py] = project(x, y, z);
    this.stamp(art, Math.round(px), Math.round(py), x + y + 0.5, g, noOutline);
  }

  /** Axis-free pixel plot at a world point (thin poles, wires); depth from the point. */
  dot(x: number, y: number, z: number, c: Col, g: number, noOutline = true): void {
    const [sx, sy] = project(x, y, z);
    this.plot(Math.floor(sx), Math.floor(sy), c, x + y, g, noOutline);
  }

  /** Vertical 1px pole from z0 to z1 at world (x, y). */
  pole(x: number, y: number, z0: number, z1: number, c: Col, g = this.group(), noOutline = true): void {
    const [sx, sy] = project(x, y, 0);
    const px = Math.floor(sx);
    for (let z = z0; z < z1; z++) this.plot(px, Math.floor(sy - z - 0.5), c, x + y, g, noOutline);
  }

  /** 1px line between two world points (Bresenham in screen space, depth interpolated). */
  line(p: readonly [number, number, number], q: readonly [number, number, number], c: Col, g: number, noOutline = true): void {
    const [x0, y0] = project(p[0], p[1], p[2]);
    const [x1, y1] = project(q[0], q[1], q[2]);
    let ax = Math.floor(x0);
    let ay = Math.floor(y0);
    const bx = Math.floor(x1);
    const by = Math.floor(y1);
    const dx = Math.abs(bx - ax);
    const dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx + dy;
    const n = Math.max(dx, -dy) || 1;
    const d0 = p[0] + p[1];
    const d1 = q[0] + q[1];
    for (let k = 0; ; k++) {
      this.plot(ax, ay, c, d0 + ((d1 - d0) * k) / n + 0.05, g, noOutline);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ax += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ay += sy;
      }
    }
  }

  /** Flat (unsheared) pixel text at local pixel (px, py) = top-left, at a fixed depth. */
  text2d(bm: TextBitmap, px: number, py: number, c: Col, depth: number, g: number): void {
    for (const gl of bm.glyphs) {
      for (const [gx, gy] of gl.px) this.plot(px + gl.x + gx, py + gy, c, depth, g, true);
    }
  }

  /**
   * Outline pass: darken pixels on a group's silhouette (next to empty space, or next
   * to a different group that is behind). Ground and flagged pixels are never darkened.
   */
  outline(f = 0.62, eps = 0.75): void {
    const { W, H, col, dep, grp, nol } = this;
    const out = col.slice();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        const g = grp[k];
        if (g < 2 || nol[k]) continue;
        const d = dep[k] - eps;
        let edge = false;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
        else {
          const n1 = k - 1, n2 = k + 1, n3 = k - W, n4 = k + W;
          if (grp[n1] === 0 || (grp[n1] !== g && dep[n1] < d)) edge = true;
          else if (grp[n2] === 0 || (grp[n2] !== g && dep[n2] < d)) edge = true;
          else if (grp[n3] === 0 || (grp[n3] !== g && dep[n3] < d)) edge = true;
          else if (grp[n4] === 0 || (grp[n4] !== g && dep[n4] < d)) edge = true;
        }
        if (edge) out[k] = shade(col[k], f);
      }
    }
    col.set(out);
  }

  /** Bounding box (canvas coords, [x0, y0, x1, y1) ) of all non-empty pixels. */
  bbox(): [number, number, number, number] | null {
    const { W, H, grp } = this;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (grp[y * W + x] === G_EMPTY && this.sh[y * W + x] === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
  }

  /** Topmost opaque local row within local columns [pxa, pxb]. */
  topRow(pxa: number, pxb: number): number {
    for (let Y = 0; Y < this.H; Y++) {
      for (let px = pxa; px <= pxb; px++) {
        const X = px + this.ox;
        if (X >= 0 && X < this.W && this.grp[Y * this.W + X] !== G_EMPTY) return Y - this.oy;
      }
    }
    return 0;
  }
}

function mixDark(c: Col, t: number): Col {
  const r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
  const k = 1 - t;
  return ((255 << 24) | (Math.round(b * k + 48 * t) << 16) | (Math.round(g * k + 30 * t) << 8) | Math.round(r * k + 20 * t)) >>> 0;
}

/** World (units, units, px) -> local screen (px). */
export function project(x: number, y: number, z: number): [number, number] {
  return [x - y, (x + y) / 2 - z];
}
