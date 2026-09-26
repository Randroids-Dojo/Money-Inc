// Turning rasters into Sprites, plus small pixel-art helpers.

import type { Sprite } from './types';
import type { Col } from './color';
import { Raster, type Art } from './raster';

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/** Local-pixel anchor points collected while drawing. */
export interface Anchors {
  door?: [number, number];
  top?: [number, number];
  chimneys?: [number, number][];
}

export interface FinishOpts {
  outline?: boolean;
  outlineFactor?: number;
  /** crop to the opaque bounding box (default true) */
  crop?: boolean;
  /** clip anything below the lower edges of this footprint (buildings) */
  footprint?: { w: number; d: number };
}

/** Run the outline pass, crop, and wrap a raster into a Sprite. */
export function finish(r: Raster, anchors: Anchors = {}, opts: FinishOpts = {}): Sprite {
  if (opts.footprint) r.clipFootprint(opts.footprint.w, opts.footprint.d);
  if (opts.outline !== false) r.outline(opts.outlineFactor ?? 0.62);
  let x0 = 0;
  let y0 = 0;
  let x1 = r.W;
  let y1 = r.H;
  if (opts.crop !== false) {
    const bb = r.bbox();
    if (bb) [x0, y0, x1, y1] = bb;
    else [x0, y0, x1, y1] = [0, 0, 1, 1];
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const img = ctx.createImageData(w, h);
    const dst = new Uint32Array(img.data.buffer);
    for (let y = 0; y < h; y++) {
      const src = (y + y0) * r.W + x0;
      dst.set(r.col.subarray(src, src + w), y * w);
      // semi-transparent shadows on otherwise empty pixels
      for (let x = 0; x < w; x++) {
        const k = src + x;
        if (r.grp[k] === 0 && r.sh[k] > 0) dst[y * w + x] = ((r.sh[k] << 24) | (40 << 16) | (26 << 8) | 16) >>> 0;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  const ox = r.ox - x0;
  const oy = r.oy - y0;
  const sp: Sprite = { canvas, ax: ox, ay: oy };
  const conv = (p: [number, number]) => ({ x: p[0] + ox, y: p[1] + oy });
  if (anchors.door) sp.door = conv(anchors.door);
  if (anchors.top) sp.top = conv(anchors.top);
  if (anchors.chimneys && anchors.chimneys.length) sp.chimneys = anchors.chimneys.map(conv);
  return sp;
}

/**
 * Parse ASCII pixel art. Each char maps through `pal` to a colour ('.' and ' ' are
 * transparent). Anchor defaults to bottom-centre.
 */
export function art(rows: readonly string[], pal: Record<string, Col>, ax?: number, ay?: number): Art {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const data = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      const c = pal[ch];
      if (c !== undefined) data[y * w + x] = c;
    }
  }
  return { w, h, ax: ax ?? Math.floor(w / 2), ay: ay ?? h - 1, data };
}

/** Horizontally mirror an Art (anchor mirrored too). */
export function mirrorArt(a: Art): Art {
  const data = new Uint32Array(a.w * a.h);
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) data[y * a.w + (a.w - 1 - x)] = a.data[y * a.w + x];
  return { w: a.w, h: a.h, ax: a.w - 1 - a.ax, ay: a.ay, data };
}

/** Render an Art into a standalone Sprite (anchor = art anchor). */
export function artSprite(a: Art): Sprite {
  const r = new Raster(a.w, a.h, a.ax, a.ay);
  r.stamp(a, 0, 0, 0, 2, true);
  return finish(r, {}, { outline: false, crop: false });
}

/** Tiny LRU map used by the sprite caches (keeps memory bounded for open-ended keys). */
export class LRU<V> {
  private m = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.m.set(k, v);
    if (this.m.size > this.max) {
      const oldest = this.m.keys().next().value;
      if (oldest !== undefined) this.m.delete(oldest);
    }
  }
}
