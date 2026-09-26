// Vehicles built from small 3D boxes so they read correctly along both iso axes in
// all four headings. drawVehicle() renders into any raster (parked trucks in yards);
// vehicleSprite() wraps it with the anchor at the ground point under the centre.

import type { Dir } from '../iso';
import type { Sprite, VehicleKind } from './types';
import { type Col, P, hex, rgb, shade, emissive, mix } from './color';
import { Raster, Face, type WallPaint, type FlatPaint } from './raster';
import { finish, LRU } from './sprite';

const TYRE = rgb(34, 34, 40);
const HUB = rgb(150, 154, 160);
const GLASS = rgb(70, 96, 128);
const GLASS_HI = rgb(170, 200, 224);
const HEAD = emissive(rgb(255, 244, 190));
const TAIL = emissive(rgb(230, 40, 40));

/** Vehicle-local frame: l along the heading (front = +l), w across. */
class VF {
  constructor(
    readonly r: Raster,
    readonly x: number,
    readonly y: number,
    readonly dir: Dir,
  ) {}

  private map(l: number, w: number): [number, number] {
    switch (this.dir) {
      case 0:
        return [this.x + l, this.y + w];
      case 1:
        return [this.x - w, this.y + l];
      case 2:
        return [this.x - l, this.y - w];
      default:
        return [this.x + w, this.y - l];
    }
  }

  /** Box in local coords. Returns the visible end face, the visible side face, and helpers. */
  box(l0: number, l1: number, w0: number, w1: number, z0: number, z1: number, side: WallPaint, end: WallPaint, top: FlatPaint | null, g: number) {
    const [ax, ay] = this.map(l0, w0);
    const [bx, by] = this.map(l1, w1);
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    const alongX = this.dir === 0 || this.dir === 2;
    const f = this.r.box(x0, y0, z0, x1, y1, z1, alongX ? side : end, top, g, alongX ? end : side);
    const sideF: Face = alongX ? f.L : f.R;
    const endF: Face = alongX ? f.R : f.L;
    const front = this.dir === 0 || this.dir === 1;
    /** side-face column of local l */
    const iOfL = (l: number) => Math.floor(this.dir === 0 || this.dir === 3 ? l - l0 : l1 - l);
    return { side: sideF, end: endF, front, iOfL };
  }
}

function wheels(side: Face, iOfL: (l: number) => number, ls: number[], big = false): void {
  for (const l of ls) {
    const c = iOfL(l);
    for (let di = -1; di <= 1; di++) for (let j = 0; j < (big ? 3 : 2); j++) side.set(c + di, j, TYRE);
    side.set(c, big ? 1 : 0, HUB);
  }
}

function glassPaint(frame: Col, pillarAt: (i: number) => boolean): WallPaint {
  return (i, j, f) => {
    const H = f.hi[i];
    if (j >= H - 1 || pillarAt(i)) return frame;
    return i === 1 && j === H - 2 ? GLASS_HI : j === H - 2 ? mix(GLASS, GLASS_HI, 0.4) : GLASS;
  };
}

function lights(end: Face, front: boolean, j: number): void {
  const c = front ? HEAD : TAIL;
  end.set(0, j, c);
  end.set(end.W - 1, j, c);
}

function car(v: VF, col: Col, g: number): void {
  const dark = shade(col, 0.72);
  const b = v.box(-7, 7, -3, 3, 0, 5, (_i, j) => (j === 0 ? dark : j === 3 ? shade(col, 1.08) : col), (_i, j) => (j === 0 ? P.steelDark : col), col, g);
  wheels(b.side, b.iOfL, [-4, 4]);
  lights(b.end, b.front, 3);
  if (b.front) b.end.rect(2, 1, Math.max(1, b.end.W - 4), 1, P.steelDark);
  v.box(-4, 3, -3, 3, 5, 9, glassPaint(col, (i) => i === 0 || i === 6), glassPaint(col, (i) => i === 0), shade(col, 1.05), g);
}

function truck(v: VF, col: Col, g: number, cab: Col = rgb(236, 236, 230)): void {
  const b = v.box(-11, 11, -4, 4, 0, 3, P.steelDark, P.steelDark, P.steelDark, g);
  wheels(b.side, b.iOfL, [-8, -5, 7], true);
  const c = v.box(5, 11, -4, 4, 3, 12, (i, j) => (j >= 5 && j <= 7 && i > 0 && i < 5 ? GLASS : j === 0 ? shade(cab, 0.8) : cab), (i, j, f) => (j >= 5 && j <= 7 && i > 0 && i < f.W - 1 ? (i === 1 ? GLASS_HI : GLASS) : cab), cab, g);
  if (c.front) lights(c.end, true, 1);
  const box = v.box(-11, 4, -4, 4, 3, 15, (i, j) => (j === 0 ? shade(col, 0.7) : j === 11 ? shade(col, 1.1) : i % 8 === 0 ? shade(col, 0.93) : col), (i, j, f) => (j === 0 ? shade(col, 0.7) : i === (f.W >> 1) ? shade(col, 0.8) : col), shade(col, 1.04), g);
  if (!box.front) lights(box.end, false, 1);
}

/** Moving van: cream box body with a company-colour cab and stripe (default orange). */
function van(v: VF, col: Col, g: number): void {
  const cream = hex('#f0e8d4');
  truck(v, cream, g, col);
  // stripe along the cargo box
  v.box(-11, 4, -4, 4, 8, 10, col, col, null, g);
}

function armored(v: VF, _col: Col, g: number): void {
  const body = hex('#4f5e52');
  const dark = shade(body, 0.75);
  const gold = P.gold;
  const b = v.box(-9, 9, -4, 4, 0, 3, P.steelDark, P.steelDark, null, g);
  wheels(b.side, b.iOfL, [-6, 6], true);
  v.box(5, 9, -4, 4, 3, 8, (_i, j) => (j === 4 ? gold : body), (i, j, f) => (j === 1 && (i === 0 || i === f.W - 1) ? HEAD : body), shade(body, 1.05), g);
  const main = v.box(-9, 5, -4, 4, 3, 13, (i, j) => (j === 4 ? gold : j === 7 && i % 4 === 1 ? P.black : j === 0 ? dark : body), (i, j, f) => (j >= 6 && j <= 7 && i > 1 && i < f.W - 2 ? GLASS : j === 4 ? gold : body), shade(body, 1.08), g);
  if (!main.front) {
    main.end.rect(main.end.W >> 1, 0, 1, 10, dark);
    lights(main.end, false, 2);
  }
}

function mixer(v: VF, col: Col, g: number): void {
  const b = v.box(-11, 11, -4, 4, 0, 3, P.steelDark, P.steelDark, P.steelDark, g);
  wheels(b.side, b.iOfL, [-8, -5, 7], true);
  const cab = col;
  const c = v.box(6, 11, -4, 4, 3, 12, (i, j) => (j >= 5 && j <= 7 && i > 0 && i < 4 ? GLASS : cab), (i, j, f) => (j >= 5 && j <= 7 && i > 0 && i < f.W - 1 ? GLASS : cab), cab, g);
  if (c.front) lights(c.end, true, 1);
  // rotating drum as an ellipsoid with spiral stripes
  const along = v.dir === 0 || v.dir === 2;
  const sgn = v.dir === 0 || v.dir === 1 ? 1 : -1;
  const cx = v.x + (along ? -3 * sgn : 0);
  const cy = v.y + (along ? 0 : -3 * sgn);
  const white = rgb(238, 236, 230);
  const orange = hex('#e8792c');
  v.r.ellipsoid(cx, cy, 10, along ? 9 : 4.2, along ? 4.2 : 9, 5.5, (x, y, z) => ((Math.floor((along ? x : y) * 0.5 + z * 0.6) & 1) === 0 ? white : orange), g, -1e9, 4);
}

function bus(v: VF, col: Col, g: number): void {
  const dark = shade(col, 0.72);
  const b = v.box(-15, 15, -4, 4, 0, 14, (i, j) => {
    if (j === 0) return dark;
    if (j >= 6 && j <= 10) return i % 5 === 0 ? col : j === 10 ? mix(GLASS, GLASS_HI, 0.5) : GLASS;
    if (j === 4) return P.white;
    return col;
  }, (i, j, f) => {
    if (j === 0) return P.steelDark;
    if (j >= 5 && j <= 10 && i > 0 && i < f.W - 1) return i === 1 && j === 10 ? GLASS_HI : GLASS;
    if (j === 12 && i > 1 && i < f.W - 2) return emissive(rgb(255, 170, 40));
    return col;
  }, rgb(220, 222, 226), g);
  wheels(b.side, b.iOfL, [-10, 10], true);
  lights(b.end, b.front, 2);
  // roof AC unit
  v.box(-5, 3, -2, 2, 14, 16, rgb(200, 204, 208), rgb(190, 194, 198), rgb(220, 222, 226), g);
}

const DEFAULTS: Record<VehicleKind, string> = {
  car: '#c83a3a',
  truck: '#3a78c8',
  van: '#e8792c',
  armored: '#4f5e52',
  mixer: '#e8b830',
  bus: '#e8b830',
};

/** Draw a vehicle centred at world (x, y) into a raster. */
export function drawVehicle(r: Raster, kind: VehicleKind, dir: Dir, color: string | undefined, x: number, y: number, shadow = true): void {
  const col = hex(color ?? DEFAULTS[kind]);
  const v = new VF(r, x, y, dir);
  const g = r.group();
  const half = kind === 'bus' ? 15 : kind === 'car' ? 7 : kind === 'van' || kind === 'truck' || kind === 'mixer' ? 11 : 9;
  const wd = kind === 'car' ? 3 : 4;
  const along = dir === 0 || dir === 2;
  switch (kind) {
    case 'car':
      car(v, col, g);
      break;
    case 'truck':
      truck(v, col, g);
      break;
    case 'van':
      van(v, col, g);
      break;
    case 'armored':
      armored(v, col, g);
      break;
    case 'mixer':
      mixer(v, col, g);
      break;
    default:
      bus(v, col, g);
  }
  if (shadow) {
    // 1px contact shadow hugging the lower-right of the footprint
    const hx = along ? half : wd;
    const hy = along ? wd : half;
    for (let px = Math.floor(x - y - hx - hy) - 2; px <= Math.ceil(x - y + hx + hy) + 3; px++) {
      for (let py = Math.floor((x + y - hx - hy) / 2) - 2; py <= Math.ceil((x + y + hx + hy) / 2) + 3; py++) {
        const gx = (px + 0.5 + 2 * (py + 0.5)) / 2;
        const gy = (2 * (py + 0.5) - (px + 0.5)) / 2;
        if (gx >= x - hx && gx < x + hx + 1.5 && gy >= y - hy && gy < y + hy + 1.5) r.shadow(px, py, 90);
      }
    }
  }
}

const cache = new LRU<Sprite>(512);

export function vehicleSprite(kind: VehicleKind, dir: Dir, color?: string): Sprite {
  const key = `${kind}:${dir}:${color ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = new Raster(64, 64, 32, 44);
  drawVehicle(r, kind, dir, color, 0, 0);
  const s = finish(r, {}, { outlineFactor: 0.6 });
  cache.set(key, s);
  return s;
}
