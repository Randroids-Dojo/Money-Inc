// Shops (retail, 8 subtypes) and services (8 subtypes), all 1x1 storefronts built
// from a shared facade builder. Closed businesses get boards, torn/removed awnings,
// faded colours and a CLOSED / FOR LEASE board.

import { type Col, P, hex, rgb, shade, mix, emissive } from '../color';
import { Face, type WallPaint, project } from '../raster';
import { textBitmap, fitText } from '../font';
import {
  brick,
  plaster,
  siding,
  stone,
  concreteWall,
  drawWindow,
  drawDoor,
  awning,
  signBoard,
  flatRoof,
  acUnit,
  slab,
  column,
  isLit,
  type WinStyle,
  type WinState,
} from '../kit';
import { facePicto } from '../pictos';
import { plant, bushArt, drawLamp } from '../props';
import { type Ctx, vpick, vchance, pave, lawn, castShadow } from './common';
import { gravel } from '../textures';
import { h01 } from '../rng';

export const SHOP_SUBS = ['grocery', 'clothing', 'electronics', 'hardware', 'furniture', 'pharmacy', 'bakery', 'books'] as const;
export const SERVICE_SUBS = ['diner', 'cafe', 'clinic', 'cinema', 'gym', 'salon', 'restaurant', 'lawoffice'] as const;

type Material = 'brick' | 'plaster' | 'siding' | 'stone' | 'concrete';

function wallPaint(m: Material, c: Col, seed: number): WallPaint {
  switch (m) {
    case 'brick':
      return brick(c, seed);
    case 'siding':
      return siding(c);
    case 'stone':
      return stone(c, seed);
    case 'concrete':
      return concreteWall(c, 12, 14);
    default:
      return plaster(c, seed);
  }
}

// ---------------------------------------------------------------------------
// Display windows & goods

type Goods = (f: Face, i: number, j: number, w: number, seed: number) => void;

const fruit = [rgb(220, 50, 40), rgb(250, 150, 40), rgb(110, 190, 60), rgb(250, 220, 60)];
const GOODS: Record<string, Goods> = {
  grocery: (f, i, j, w, s) => {
    for (let a = 0; a < w; a++) {
      f.set(i + a, j, P.woodDark);
      f.set(i + a, j + 1, fruit[(a + s) % 4]);
      if (a % 2 === 0) f.set(i + a, j + 2, fruit[(a + s + 1) % 4]);
    }
  },
  clothing: (f, i, j, w) => {
    for (let a = 1; a < w - 1; a += 3) {
      f.set(i + a, j + 5, rgb(236, 200, 170));
      f.rect(i + a, j + 2, 1, 3, a % 2 ? rgb(226, 88, 150) : rgb(80, 120, 200));
      f.set(i + a, j + 1, rgb(60, 60, 70));
    }
  },
  electronics: (f, i, j, w) => {
    for (let a = 0; a + 2 < w; a += 4) {
      f.rect(i + a, j + 1, 3, 2, emissive(rgb(90, 200, 250)));
      f.set(i + a + 1, j, P.black);
    }
  },
  hardware: (f, i, j, w) => {
    for (let a = 0; a < w; a++) {
      f.set(i + a, j, a % 3 === 0 ? rgb(232, 124, 44) : rgb(120, 126, 136));
      if (a % 3 === 1) f.set(i + a, j + 1, rgb(200, 60, 40));
    }
  },
  furniture: (f, i, j, w) => {
    for (let a = 0; a + 4 < w; a += 6) {
      f.rect(i + a, j, 5, 2, rgb(150, 96, 60));
      f.rect(i + a, j + 2, 1, 1, rgb(150, 96, 60));
      f.rect(i + a + 1, j + 2, 3, 1, rgb(214, 170, 110));
    }
  },
  pharmacy: (f, i, j, w) => {
    for (let a = 0; a < w; a++) {
      f.set(i + a, j + 2, P.offwhite);
      f.set(i + a, j + 1, a % 2 ? rgb(60, 170, 100) : rgb(240, 240, 240));
      f.set(i + a, j, a % 3 ? rgb(90, 140, 220) : P.offwhite);
    }
  },
  bakery: (f, i, j, w) => {
    for (let a = 0; a < w; a++) {
      f.set(i + a, j, P.woodLight);
      f.set(i + a, j + 1, a % 3 === 2 ? rgb(236, 160, 190) : rgb(214, 150, 70));
      if (a % 3 === 0) f.set(i + a, j + 2, rgb(190, 120, 50));
    }
  },
  books: (f, i, j, w) => {
    const cs = [rgb(150, 40, 60), rgb(40, 90, 160), rgb(230, 190, 60), rgb(60, 130, 80), rgb(220, 220, 210)];
    for (let a = 0; a < w; a++) {
      const hgt = 2 + (a % 3 === 0 ? 1 : 0);
      f.rect(i + a, j, 1, hgt, cs[(a * 3) % 5]);
    }
  },
  gym: (f, i, j, w) => {
    for (let a = 1; a + 3 < w; a += 5) {
      f.rect(i + a, j, 4, 1, rgb(50, 52, 60));
      f.rect(i + a + 1, j + 1, 1, 3, rgb(50, 52, 60));
      f.set(i + a + 3, j + 3, rgb(232, 124, 44));
    }
  },
  generic: (f, i, j, w) => {
    for (let a = 0; a < w; a += 2) f.set(i + a, j, rgb(150, 140, 120));
  },
};

type Show = 'day' | 'lit' | 'dark' | 'boarded';

/** Shop display window with frame, glass reflections and goods. */
function displayWindow(f: Face, i: number, j: number, w: number, h: number, st: Show, goods: string, frameC: Col, seed: number): void {
  // frame
  f.rect(i - 1, j - 1, w + 2, 1, frameC);
  f.rect(i - 1, j + h, w + 2, 1, frameC);
  f.rect(i - 1, j, 1, h, frameC);
  f.rect(i + w, j, 1, h, frameC);
  if (st === 'boarded') {
    for (let a = 0; a < w; a++) {
      for (let b = 0; b < h; b++) {
        const plank = (b >> 1) % 2 === 0 ? P.plank : shade(P.plank, 0.85);
        f.set(i + a, j + b, (a + 2 * b + seed) % 11 === 0 ? shade(P.plank, 0.66) : plank);
      }
    }
    // cross battens
    for (let a = 0; a < w; a++) f.set(i + a, j + Math.round(((w - 1 - a) * (h - 1)) / Math.max(1, w - 1)), shade(P.plank, 0.7));
    return;
  }
  const inside = st === 'lit' ? emissive(rgb(255, 232, 170)) : st === 'dark' ? P.glassDark : mix(P.glassDay, P.glassDayHi, 0.25);
  const hi = st === 'lit' ? emissive(rgb(255, 246, 214)) : st === 'dark' ? shade(P.glassDark, 1.1) : P.glassDayHi;
  for (let a = 0; a < w; a++) {
    for (let b = 0; b < h; b++) {
      const refl = st === 'day' && (a + (h - b)) % 9 < 2;
      f.set(i + a, j + b, refl || b === h - 1 ? hi : inside);
    }
  }
  if (w > 9) f.rect(i + (w >> 1), j, 1, h, frameC);
  if (st !== 'dark') (GOODS[goods] ?? GOODS.generic)(f, i, j, w, seed);
}

// ---------------------------------------------------------------------------
// Storefront builder

interface FrontOpts {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  groundH: number;
  floors: number;
  upperH: number;
  wall: Col;
  material: Material;
  trim: Col;
  base: Col;
  door: Col;
  doorAt: 'left' | 'center' | 'right';
  goods: string;
  displayH?: number;
  awning?: { a: Col; b: Col | null; stripe?: number; out?: number; drop?: number } | null;
  /** awning column span [i0, i1); values <= 0 count back from the right end */
  awningSpan?: [number, number];
  sign?: { bg: Col; fg: Col; text?: string; picto?: string; border?: Col | null; w?: number } | null;
  upperWin?: WinStyle;
  roof?: Col;
  /** paint the whole ground floor as glass (gym, diner band) */
  glassFront?: boolean;
  sideDisplay?: boolean;
}

interface FrontOut {
  fr: Face;
  sd: Face;
  H: number;
  rect: [number, number, number, number];
  doorI: number;
  closed: boolean;
}

function storefront(c: Ctx, o: FrontOpts): FrontOut {
  const { r, F, s } = c;
  const T = c.tone;
  const closed = s.state === 'closed';
  const litOn = !closed && s.lit > 0;
  const H = o.groundH + (o.floors - 1) * o.upperH;
  const paint = wallPaint(o.material, T(o.wall), c.seed);
  const base = T(o.base);
  const trim = T(o.trim);
  castShadow(c, o.a0, o.b0, o.a1, o.b1, H);
  const body = F.box(o.a0, o.b0, 0, o.a1, o.b1, H, (i, j, f) => {
    if (j < 2) return base;
    if (j >= H - 2) return trim;
    if (o.floors > 1 && j === o.groundH - 1) return trim;
    return typeof paint === 'number' ? paint : paint(i, j, f);
  }, null);
  const rect = F.rect(o.a0, o.b0, o.a1, o.b1);
  flatRoof(r, rect[0], rect[1], rect[2], rect[3], H, (x, y) => gravel(x, y, c.seed, T(o.roof ?? rgb(128, 122, 116))), trim, 2);

  const fr = body.front;
  const sd = body.side;
  const W = fr.W;
  // door
  const dw = 4;
  const doorI = o.doorAt === 'left' ? 2 : o.doorAt === 'right' ? W - dw - 2 : Math.floor((W - dw) / 2);
  c.an.door = drawDoor(fr, doorI, dw, 9, T(o.door), { glass: !closed, frame: trim, boarded: closed, lit: litOn });
  // display windows fill the remaining ground-floor width
  const dh = o.displayH ?? 7;
  const show: Show = closed ? 'boarded' : litOn ? 'lit' : 'day';
  const frameC = T(shade(o.trim, 0.55));
  const segs: [number, number][] = [];
  if (doorI - 2 >= 4) segs.push([2, doorI - 2]);
  if (W - 2 - (doorI + dw + 2) >= 4) segs.push([doorI + dw + 2, W - 2]);
  const winH = o.glassFront ? o.groundH - 7 : dh;
  for (const [s0, s1] of segs) displayWindow(fr, s0, 3, s1 - s0, winH, show, o.goods, frameC, c.seed);
  // side: a display window near the front, windows above
  const sw = sd.W;
  if (o.sideDisplay !== false && sw >= 12) {
    const k = F.sideCol(sd, 3);
    const i0 = F.front === 'left' ? k : k - 7;
    displayWindow(sd, i0, 3, 7, dh, show, o.goods, frameC, c.seed + 3);
  }
  // upper floors
  if (o.floors > 1) {
    const ws: WinStyle = o.upperWin ?? { w: 3, h: 6, sill: trim, lintel: null };
    for (let fl = 1; fl < o.floors; fl++) {
      const j = o.groundH + (fl - 1) * o.upperH + 4;
      for (const f of [fr, sd]) {
        const n = Math.max(1, Math.floor((f.W - 4) / 7));
        const tot = (n - 1) * 7 + ws.w;
        const i0 = Math.floor((f.W - tot) / 2);
        for (let k = 0; k < n; k++) {
          const stt: WinState = closed ? (fl === 1 && k % 2 === 0 ? 'boarded' : 'dark') : isLit(c.seed, f.axis, fl, k, s.lit) ? 'lit' : 'day';
          drawWindow(f, i0 + k * 7, j, ws, stt, c.seed + k);
        }
      }
    }
  }
  // awning (removed or torn when closed)
  if (o.awning) {
    const aw = o.awning;
    const j = o.groundH - 8;
    const sp = o.awningSpan ?? [1, -1];
    const ai0 = sp[0] <= 0 ? W + sp[0] : sp[0];
    const ai1 = sp[1] <= 0 ? W + sp[1] : sp[1];
    if (!closed) awning(fr, ai0, ai1, j, aw.out ?? 5, aw.drop ?? 4, T(aw.a), aw.b === null ? null : T(aw.b), aw.stripe ?? 2);
    else if (vchance(c, 0.5, 91)) awning(fr, ai0, ai1, j, aw.out ?? 5, aw.drop ?? 4, T(aw.a), aw.b === null ? null : T(aw.b), aw.stripe ?? 2, true);
    else {
      // bare awning frame left behind
      fr.rect(ai0, j, ai1 - ai0, 1, T(P.steelDark));
      for (let i = ai0; i < ai1; i += 6) fr.set(i, j - 1, T(P.steelDark));
    }
  }
  // sign
  if (closed) {
    closedBoard(c, fr, o.groundH - 7);
  } else if (o.sign) {
    const sg = o.sign;
    const text = sg.text ? fitText(sg.text, W - (sg.picto ? 13 : 5)) : undefined;
    const tw = text ? textBitmap(text).w + 4 : 0;
    const w = Math.min(W - 2, sg.w ?? Math.max(11, (sg.picto ? 9 : 0) + tw));
    const i0 = Math.floor((W - w) / 2);
    const board = signBoard(fr, i0, w, o.groundH - 7, 7, T(sg.bg), undefined, sg.fg, 1, sg.border === undefined ? T(shade(sg.bg, 0.7)) : sg.border);
    let ti = 2;
    if (sg.picto) {
      board.rect(1, 1, 7, 5, T(P.white));
      facePicto(board, sg.picto, 2, 5);
      ti = 9;
    }
    if (text) board.text(text, ti + Math.max(0, Math.floor((w - ti - 1 - textBitmap(text).w) / 2)), 5, sg.fg, textBitmap);
  }
  return { fr, sd, H, rect, doorI, closed };
}

/** "CLOSED" / "FOR LEASE" board used by failed businesses. */
export function closedBoard(c: Ctx, f: Face, j0: number): void {
  const lease = vchance(c, 0.5, 92);
  if (lease && f.W >= 22) {
    const w = Math.min(f.W - 2, 23);
    const b = signBoard(f, Math.floor((f.W - w) / 2), w, j0 - 5, 13, P.white, undefined, P.red, 1, rgb(200, 40, 40));
    b.text('FOR', Math.floor((w - 11) / 2), 11, rgb(200, 40, 40), textBitmap);
    b.text('LEASE', Math.floor((w - 19) / 2), 5, rgb(200, 40, 40), textBitmap);
  } else {
    const w = Math.min(f.W - 2, 27);
    signBoard(f, Math.floor((f.W - w) / 2), w, j0, 7, rgb(236, 232, 222), 'CLOSED', rgb(200, 40, 40), 1, rgb(120, 110, 100));
  }
}

/** Sidewalk in front, service strip behind. */
function commercialLot(c: Ctx, b1: number, grassBack = true): void {
  const { F } = c;
  const pv = pave(c, c.tone(P.paving), 8);
  const gr = lawn(c, c.s.state === 'closed' ? 0.8 : 0);
  F.ground(0, 0, F.A, F.B, (a, b) => (b >= b1 - 1 || !grassBack || a < 2 || a > F.A - 2 ? pv(a, b) : gr(a, b)));
}

/** Trash bags / weeds for closed lots. */
function neglect(c: Ctx, b: number): void {
  const { r, F } = c;
  for (let k = 0; k < 3; k++) {
    const a = 4 + h01(c.seed, k) * (F.A - 8);
    const [x, y] = F.xy(a, b + 2 + k);
    const g = r.group();
    r.box(x - 1, y - 1, 0, x + 1.5, y + 1.5, 2, rgb(40, 50, 44), rgb(56, 70, 60), g);
  }
}

// ---------------------------------------------------------------------------
// Shops

interface SubStyle {
  awnA: Col;
  awnB: Col | null;
  sign: Col;
  walls: Col[];
  material: Material[];
}

const SHOP_STYLE: Record<string, SubStyle> = {
  grocery: { awnA: hex('#3f9a4a'), awnB: hex('#f4f0e6'), sign: hex('#2f7a3a'), walls: [hex('#e8dcb8'), hex('#b75a3e'), hex('#d9b77e')], material: ['brick', 'plaster'] },
  clothing: { awnA: hex('#e0609a'), awnB: hex('#f8f0f4'), sign: hex('#c84a86'), walls: [hex('#f2e8ec'), hex('#b6a9cb'), hex('#efebe0')], material: ['plaster', 'stone'] },
  electronics: { awnA: hex('#3a78d0'), awnB: hex('#9cc8f0'), sign: hex('#2a5aa8'), walls: [hex('#d8dce0'), hex('#9fc0da'), hex('#c8c8cc')], material: ['concrete', 'plaster'] },
  hardware: { awnA: hex('#e8792c'), awnB: null, sign: hex('#c85a1c'), walls: [hex('#a86a4c'), hex('#d9b77e'), hex('#9fb784')], material: ['brick', 'siding'] },
  furniture: { awnA: hex('#8a5a34'), awnB: hex('#e0c49a'), sign: hex('#6a4024'), walls: [hex('#ecdcae'), hex('#b75a3e'), hex('#e2a18b')], material: ['brick', 'plaster'] },
  pharmacy: { awnA: hex('#2fa060'), awnB: null, sign: hex('#1f8048'), walls: [hex('#f4f2ec'), hex('#e4ecea')], material: ['plaster', 'concrete'] },
  bakery: { awnA: hex('#9a6a3a'), awnB: hex('#f4e4b8'), sign: hex('#7a4a24'), walls: [hex('#f0e2b4'), hex('#e2b8a0'), hex('#efe29c')], material: ['plaster', 'siding'] },
  books: { awnA: hex('#8a2a3a'), awnB: null, sign: hex('#6a1a2a'), walls: [hex('#5fa39a'), hex('#b75a3e'), hex('#ecdcae')], material: ['brick', 'stone'] },
};

export function shop(c: Ctx): void {
  const { r, F, s } = c;
  const sub = (SHOP_SUBS as readonly string[]).includes(s.subtype) ? s.subtype : vpick(c, SHOP_SUBS, 1);
  const st = SHOP_STYLE[sub];
  const lvl = s.level;
  const A = F.A;
  const B = F.B;
  const big = lvl >= 3;
  const a0 = big ? 2 : 3;
  const a1 = A - (big ? 2 : 3);
  const b0 = big ? 3 : 6;
  const b1 = B - (big ? 8 : 10);
  commercialLot(c, b1);
  const wall = vpick(c, st.walls, 2);
  const out = storefront(c, {
    a0,
    a1,
    b0,
    b1,
    groundH: 20,
    floors: lvl === 1 ? 1 : 2,
    upperH: lvl === 3 ? 12 : 13,
    wall,
    material: vpick(c, st.material, 3),
    trim: P.white,
    base: rgb(120, 112, 106),
    door: shade(st.sign, 0.8),
    doorAt: vpick(c, ['left', 'center', 'right', 'left'] as const, 4),
    goods: sub,
    awning: { a: st.awnA, b: st.awnB, stripe: 2 },
    sign: { bg: st.sign, fg: P.white, picto: sub, text: s.sign || undefined, border: null, w: s.sign ? undefined : 13 },
    upperWin: lvl === 3 ? { w: 5, h: 6, frame: shade(P.white, 0.9), mullion: true } : undefined,
  });
  // sidewalk dressing
  if (!out.closed) {
    if (sub === 'grocery') {
      // fruit stand under the awning
      const [x, y] = F.xy(A - 9, b1 + 3);
      const g = r.group();
      if (F.front === 'left') r.box(x - 5, y - 1.5, 0, x + 5, y + 1.5, 4, P.woodDark, (xx) => fruit[Math.floor(xx) % 4], g);
      else r.box(x - 1.5, y - 5, 0, x + 1.5, y + 5, 4, P.woodDark, (_xx, yy) => fruit[Math.floor(yy) % 4], g);
    } else if (sub === 'bakery' || sub === 'books') {
      // A-frame chalkboard
      const [x, y] = F.xy(out.doorI + a0 + 8, b1 + 4);
      const g = r.group();
      r.box(x - 1.5, y - 1.5, 0, x + 1.5, y + 1.5, 6, rgb(50, 56, 52), P.woodDark, g);
    }
    const [lx, ly] = F.xy(A - 2, B - 2);
    drawLamp(r, lx, ly);
  } else {
    neglect(c, b1);
  }
  // rooftop: AC, and a billboard on big stores
  const [rx0, ry0] = out.rect;
  acUnit(r, rx0 + 4, ry0 + 4, out.H, 5);
  if (big) billboard(c, out, sub, st.sign, out.closed);
}

/** Rooftop billboard facing the front with a big pictogram. */
function billboard(c: Ctx, out: FrontOut, picto: string, col: Col, closed: boolean): void {
  const { r, F } = c;
  const T = c.tone;
  const A = F.A;
  const w = 22;
  const a0 = Math.floor((A - w) / 2);
  const bb = 10; // depth position (local b) near the back of the roof
  const z0 = out.H + 6;
  const legs = r.group();
  for (const a of [a0 + 3, a0 + w - 4]) {
    const [x, y] = F.xy(a, bb);
    r.box(x - 0.5, y - 0.5, out.H, x + 0.5, y + 0.5, z0, P.steelDark, P.steelDark, legs);
  }
  const b = F.box(a0, bb, z0, a0 + w, bb + 1, z0 + 13, T(col), T(shade(col, 1.1)));
  const f = b.front;
  if (closed) {
    f.fill((i, j) => (h01(i, j, 3) < 0.3 ? rgb(170, 160, 150) : rgb(200, 196, 188)));
    return;
  }
  f.rect(1, 1, w - 2, 11, T(P.white));
  f.rect(2, 2, w - 4, 9, T(col));
  f.rect(3, 2, 12, 9, T(P.white));
  facePicto(f, picto, 4, 10, 2);
  f.rect(16, 4, 3, 1, T(P.white));
  f.rect(16, 6, 3, 1, T(P.white));
  f.rect(16, 8, 2, 1, T(P.white));
  // spot lights
  f.set(4, 12, emissive(rgb(255, 240, 180)));
  f.set(w - 5, 12, emissive(rgb(255, 240, 180)));
}

// ---------------------------------------------------------------------------
// Services

export function service(c: Ctx): void {
  const sub = (SERVICE_SUBS as readonly string[]).includes(c.s.subtype) ? c.s.subtype : vpick(c, SERVICE_SUBS, 1);
  switch (sub) {
    case 'diner':
      return diner(c);
    case 'cafe':
      return cafe(c, false);
    case 'restaurant':
      return cafe(c, true);
    case 'clinic':
      return clinic(c);
    case 'cinema':
      return cinema(c);
    case 'gym':
      return gym(c);
    case 'salon':
      return salon(c);
    default:
      return lawoffice(c);
  }
}

function levelFloors(c: Ctx): number {
  return Math.min(3, Math.max(1, c.s.level));
}

function diner(c: Ctx): void {
  const { r, F, s } = c;
  const T = c.tone;
  const A = F.A;
  const B = F.B;
  const b1 = B - 10;
  commercialLot(c, b1, false);
  const floors = levelFloors(c);
  const chrome = rgb(214, 218, 224);
  const red = hex('#c83a3a');
  const H = floors === 1 ? 16 : 16 + (floors - 1) * 12;
  const closed = s.state === 'closed';
  castShadow(c, 4, 8, A - 4, b1, H);
  const body = F.box(4, 8, 0, A - 4, b1, H, (_i, j) => {
    if (j < 2) return T(red);
    if (j === 2 || j === 12) return T(shade(chrome, 1.1));
    if (j < 4 || (j > 11 && j < 12)) return T(chrome);
    if (j >= 13 && j < 15) return T(red);
    if (j >= 15) return T(floors > 1 ? hex('#efe6d0') : chrome);
    return T(chrome);
  }, null);
  const rect = F.rect(4, 8, A - 4, b1);
  flatRoof(r, rect[0], rect[1], rect[2], rect[3], H, T(rgb(140, 140, 146)), T(chrome), 1);
  const fr = body.front;
  const sd = body.side;
  const show: Show = closed ? 'boarded' : s.lit > 0 ? 'lit' : 'day';
  // continuous window band with booths
  for (const f of [fr, sd]) {
    const w = f.W - 4;
    displayWindow(f, 2, 4, w, 7, show, 'generic', T(shade(chrome, 0.7)), c.seed);
    if (!closed) for (let i = 3; i < w; i += 4) f.rect(2 + i, 4, 2, 2, T(red));
  }
  c.an.door = drawDoor(fr, 2, 4, 10, T(shade(chrome, 0.8)), { glass: !closed, boarded: closed, lit: s.lit > 0 && !closed });
  for (let fl = 1; fl < floors; fl++) {
    for (const f of [fr, sd]) {
      for (let i = 4; i + 3 < f.W - 2; i += 7) drawWindow(f, i, 16 + (fl - 1) * 12 + 3, { w: 3, h: 5, sill: T(P.white) }, closed ? 'dark' : isLit(c.seed, f.axis, fl, i, s.lit) ? 'lit' : 'day');
    }
  }
  // rooftop neon sign
  const signA0 = Math.floor(A / 2) - 11;
  const legsG = r.group();
  for (const a of [signA0 + 3, signA0 + 18]) {
    const [x, y] = F.xy(a, b1 - 5);
    r.box(x - 0.5, y - 0.5, H, x + 0.5, y + 0.5, H + 3, P.steelDark, P.steelDark, legsG);
  }
  const board = F.box(signA0, b1 - 6, H + 3, signA0 + 22, b1 - 5, H + 12, T(rgb(40, 36, 54)), T(rgb(60, 56, 74)));
  const nf = board.front;
  if (closed) {
    nf.text('DINER', 3, 7, rgb(90, 86, 100), textBitmap);
  } else {
    const neon = emissive(rgb(255, 90, 170));
    const neon2 = emissive(rgb(90, 230, 255));
    for (let i = 0; i < nf.W; i++) {
      nf.set(i, 0, neon2);
      nf.set(i, 8, neon2);
    }
    const title = fitText(s.sign || 'DINER', nf.W - 2);
    nf.text(title, Math.max(1, Math.floor((nf.W - textBitmap(title).w) / 2)), 6, neon, textBitmap);
  }
  // pole sign on the lot corner
  const [px, py] = F.xy(A - 3, B - 3);
  const gp = r.group();
  r.pole(px, py, 0, 22, T(P.steelDark), gp, false);
  r.box(px - 3, py - 1, 18, px + 3, py + 1, 25, T(red), T(red), gp);
  const [lx, ly] = F.xy(3, B - 3);
  drawLamp(r, lx, ly);
}

function cafe(c: Ctx, restaurant: boolean): void {
  const { r, F, s } = c;
  const A = F.A;
  const B = F.B;
  const b1 = B - 14;
  commercialLot(c, b1);
  const floors = levelFloors(c);
  const awnA = restaurant ? hex('#7a2434') : hex('#2f7a4a');
  const awnB = restaurant ? null : hex('#f4f0e6');
  const out = storefront(c, {
    a0: 3,
    a1: A - 3,
    b0: 3,
    b1,
    groundH: 19,
    floors,
    upperH: 12,
    wall: restaurant ? vpick(c, [hex('#a8453a'), hex('#8e4636'), hex('#d9b77e')], 2) : vpick(c, [hex('#ecdcae'), hex('#e2a18b'), hex('#9fc0da'), hex('#efe29c')], 2),
    material: restaurant ? 'brick' : 'plaster',
    trim: restaurant ? rgb(236, 226, 200) : P.white,
    base: rgb(110, 100, 94),
    door: restaurant ? hex('#5a2a24') : hex('#2f5a3a'),
    doorAt: 'center',
    goods: restaurant ? 'generic' : 'bakery',
    awning: { a: awnA, b: awnB, stripe: 2, out: 4, drop: 3 },
    sign: { bg: restaurant ? hex('#2a2a2e') : hex('#f4f0e6'), fg: restaurant ? P.gold : hex('#2f5a3a'), picto: restaurant ? 'restaurant' : 'cafe', border: restaurant ? P.gold : hex('#2f7a4a'), text: s.sign || undefined, w: s.sign ? undefined : 11 },
  });
  if (out.closed) {
    neglect(c, b1);
    return;
  }
  // outdoor tables on the sidewalk
  const n = Math.max(2, Math.floor((A - 8) / 11));
  for (let k = 0; k < n; k++) {
    const a = 7 + k * 11;
    if (Math.abs(a - A / 2) < 4) continue;
    const [x, y] = F.xy(a, b1 + 8);
    const g = r.group();
    const top = restaurant ? P.white : rgb(236, 232, 222);
    r.box(x - 0.5, y - 0.5, 0, x + 0.5, y + 0.5, 4, P.steelDark, P.steelDark, g);
    r.disc(x, y, 2.4, 4, top, g);
    // chairs
    for (const [dx, dy] of [[-3, 0], [3, 0]]) {
      const [qx, qy] = F.front === 'left' ? [x + dx, y + dy] : [x + dy, y + dx];
      r.box(qx - 0.8, qy - 0.8, 0, qx + 0.8, qy + 0.8, 3, P.woodDark, P.wood, r.group());
    }
    if (!restaurant) {
      // parasol
      const gu = r.group();
      r.pole(x, y, 4, 14, P.white, gu, false);
      const col1 = k % 2 ? hex('#e05a4a') : hex('#f4f0e6');
      const col2 = hex('#2f7a4a');
      const N = 8;
      for (let q = 0; q < N; q++) {
        const t0 = (q / N) * Math.PI * 2;
        const t1 = ((q + 1) / N) * Math.PI * 2;
        r.plane(
          [
            [x + Math.cos(t0) * 4.6, y + Math.sin(t0) * 4.6, 11],
            [x + Math.cos(t1) * 4.6, y + Math.sin(t1) * 4.6, 11],
            [x, y, 14],
          ],
          q % 2 ? col1 : col2,
          gu,
        );
      }
    } else {
      // warm table lantern
      const [lx, ly] = project2(x, y, 5);
      r.plot(lx, ly, emissive(rgb(255, 200, 90)), x + y + 0.3, g, true);
    }
  }
  if (restaurant && s.lit > 0) {
    // string lights along the awning edge
    const f = out.fr;
    for (let i = 1; i < f.W - 1; i += 3) f.setFree(i, 20 - 8 + 1, emissive(rgb(255, 214, 120)));
  }
  plant(r, bushArt(3), ...F.xy(6, b1 + 3));
}

function project2(x: number, y: number, z: number): [number, number] {
  const [a, b] = project(x, y, z);
  return [Math.floor(a), Math.floor(b)];
}

function clinic(c: Ctx): void {
  const { F } = c;
  const A = F.A;
  const B = F.B;
  const b1 = B - 9;
  commercialLot(c, b1);
  const floors = levelFloors(c);
  const out = storefront(c, {
    a0: 3,
    a1: A - 3,
    b0: 4,
    b1,
    groundH: 18,
    floors: floors,
    upperH: 12,
    wall: rgb(242, 242, 238),
    material: 'plaster',
    trim: hex('#3a78c8'),
    base: rgb(150, 160, 170),
    door: rgb(200, 210, 220),
    doorAt: 'center',
    goods: 'pharmacy',
    awning: null,
    sign: null,
    upperWin: { w: 4, h: 5, frame: null, sill: hex('#3a78c8') },
  });
  if (out.closed) {
    neglect(c, b1);
    return;
  }
  const f = out.fr;
  // blue stripe + canopy + big red cross sign
  f.rect(0, 12, f.W, 1, c.tone(hex('#3a78c8')));
  slab(f, out.doorI - 3, out.doorI + 7, 5, 11, 1, c.tone(P.white));
  const bw = 9;
  const board = signBoard(f, Math.floor((f.W - bw) / 2), bw, 13, 7, c.tone(P.white), undefined, P.red, 1, c.tone(hex('#c83030')));
  facePicto(board, 'clinic', 2, 5);
  // small side cross sign
  const sd = out.sd;
  const sb = signBoard(sd, F.front === 'left' ? 3 : sd.W - 10, 7, 12, 7, c.tone(P.white), undefined, P.red, 1, c.tone(hex('#c83030')));
  facePicto(sb, 'clinic', 1, 5);
}

function cinema(c: Ctx): void {
  const { r, F, s } = c;
  const T = c.tone;
  const A = F.A;
  const B = F.B;
  const b1 = B - 10;
  commercialLot(c, b1);
  const lvl = levelFloors(c);
  const H = [28, 36, 44][lvl - 1];
  const closed = s.state === 'closed';
  const wall = T(vpick(c, [hex('#8e2a3a'), hex('#5a3a6a'), hex('#2f4a6a')], 2));
  const trim = T(P.gold);
  castShadow(c, 3, 4, A - 3, b1, H);
  const body = F.box(3, 4, 0, A - 3, b1, H, (i, j) => (j < 2 ? T(rgb(60, 50, 56)) : j >= H - 3 ? trim : j % 8 === 0 && j > 20 ? shade(wall, 0.9) : i % 10 === 0 && j > 20 ? shade(wall, 1.08) : wall), null);
  const rect = F.rect(3, 4, A - 3, b1);
  flatRoof(r, rect[0], rect[1], rect[2], rect[3], H, T(rgb(110, 104, 110)), trim, 2);
  const fr = body.front;
  const W = fr.W;
  // doors (double, glass) and poster cases
  c.an.door = drawDoor(fr, Math.floor(W / 2) - 4, 8, 10, T(rgb(60, 40, 30)), { glass: !closed, double: true, frame: trim, boarded: closed, lit: !closed && s.lit > 0 });
  for (const i of [2, W - 6]) {
    fr.rect(i - 1, 2, 6, 9, trim);
    fr.rect(i, 3, 4, 7, closed ? T(P.plank) : vpick(c, [hex('#e05a4a'), hex('#3a78c8'), hex('#e0b040')], i));
    if (!closed) fr.rect(i + 1, 5, 2, 2, P.white);
  }
  // marquee: protruding box with bulb border and title
  const mj = 12;
  const [x0, y0, z0, x1, y1, z1] = fr.boxOut(-1, W + 1, 0, 6, mj, mj + 7);
  const m = r.box(x0, y0, z0, x1, y1, z1, T(P.white), T(rgb(60, 50, 56)));
  const mf = fr.axis === 'L' ? m.L : m.R;
  const bulbOn = emissive(rgb(255, 236, 140));
  const bulbOff = rgb(170, 150, 90);
  for (let i = 0; i < mf.W; i++) {
    mf.set(i, 0, closed ? bulbOff : i % 2 === 0 ? bulbOn : T(rgb(200, 60, 60)));
    mf.set(i, 6, closed ? bulbOff : i % 2 === 1 ? bulbOn : T(rgb(200, 60, 60)));
  }
  const title = fitText(closed ? 'CLOSED' : s.sign || 'CINEMA', W);
  mf.text(title, Math.max(1, Math.floor((mf.W - textBitmap(title).w) / 2)), 5, closed ? rgb(170, 40, 40) : rgb(40, 36, 48), textBitmap);
  const side = fr.axis === 'L' ? m.R : m.L;
  side.fill((i) => (i % 2 === 0 && !closed ? bulbOn : T(rgb(200, 60, 60))));
  // vertical blade sign above the marquee
  const bladeI = Math.floor(W / 2) - 1;
  const [bx0, by0, bz0, bx1, by1, bz1] = fr.boxOut(bladeI, bladeI + 1, 0, 7, mj + 8, H + 6);
  const bl = r.box(bx0, by0, bz0, bx1, by1, bz1, T(rgb(200, 50, 60)), T(rgb(220, 70, 70)));
  const bf = fr.axis === 'L' ? bl.R : bl.L;
  const letters = closed ? '' : 'FILM';
  const n = letters.length;
  const top = bf.hi[Math.floor(bf.W / 2)] - 2;
  for (let k = 0; k < n; k++) bf.text(letters[k], 2, top - k * 6, closed ? rgb(120, 110, 100) : emissive(rgb(255, 240, 160)), textBitmap);
  for (let j = 0; j < bf.hi[0]; j += 2) {
    bf.set(0, j, closed ? bulbOff : bulbOn);
    bf.set(bf.W - 1, j + 1, closed ? bulbOff : bulbOn);
  }
  // side facade: poster and exit door
  const sd = body.side;
  const si = F.sideCol(sd, 8);
  const pi = F.front === 'left' ? si : si - 5;
  sd.rect(pi, 4, 6, 9, trim);
  sd.rect(pi + 1, 5, 4, 7, closed ? T(P.plank) : T(hex('#3a78c8')));
  if (closed) neglect(c, b1);
  else {
    const [lx, ly] = F.xy(A - 2, B - 2);
    drawLamp(r, lx, ly);
  }
}

function gym(c: Ctx): void {
  const { F, s } = c;
  const A = F.A;
  const B = F.B;
  const b1 = B - 9;
  commercialLot(c, b1);
  const floors = levelFloors(c);
  const orange = hex('#e8792c');
  const out = storefront(c, {
    a0: 3,
    a1: A - 3,
    b0: 4,
    b1,
    groundH: 19,
    floors,
    upperH: 13,
    wall: rgb(88, 92, 102),
    material: 'concrete',
    trim: orange,
    base: rgb(60, 62, 70),
    door: rgb(60, 62, 70),
    doorAt: 'left',
    goods: 'gym',
    glassFront: true,
    awning: null,
    sign: { bg: rgb(40, 42, 50), fg: P.white, picto: 'gym', border: orange, text: s.sign || undefined, w: s.sign ? undefined : 11 },
    upperWin: { w: 5, h: 7, frame: rgb(60, 62, 70), mullion: true },
  });
  if (out.closed) {
    neglect(c, b1);
    return;
  }
  // equipment silhouettes in the glass front
  const f = out.fr;
  for (let i = out.doorI + 8; i < f.W - 4; i += 5) {
    f.rect(i, 3, 3, 1, rgb(40, 42, 50));
    f.rect(i + 1, 4, 1, 3, rgb(40, 42, 50));
  }
  f.rect(0, 11, f.W, 1, c.tone(orange));
}


function salon(c: Ctx): void {
  const { r, F, s } = c;
  const A = F.A;
  const B = F.B;
  const b1 = B - 10;
  commercialLot(c, b1);
  const floors = levelFloors(c);
  const out = storefront(c, {
    a0: 4,
    a1: A - 4,
    b0: 6,
    b1,
    groundH: 19,
    floors,
    upperH: 12,
    wall: vpick(c, [hex('#e8b4c8'), hex('#b6a9cb'), hex('#f2e8ec')], 2),
    material: 'plaster',
    trim: P.white,
    base: rgb(120, 100, 110),
    door: hex('#8a3a6a'),
    doorAt: 'right',
    goods: 'generic',
    awning: { a: hex('#d85a96'), b: P.white, stripe: 1, out: 4, drop: 3 },
    awningSpan: [1, -9],
    sign: { bg: rgb(250, 244, 248), fg: hex('#b03a7a'), picto: 'salon', border: hex('#d85a96'), text: s.sign || undefined, w: s.sign ? undefined : 11 },
  });
  if (out.closed) {
    neglect(c, b1);
    return;
  }
  // barber pole on its bracket between the awning and the door
  const f = out.fr;
  const [x, y] = f.world(out.doorI - 3, 2, 0);
  const g = r.group();
  r.box(x - 1.5, y - 1.5, 3, x + 1.5, y + 1.5, 5, P.steelLight, P.steelLight, g);
  r.cylinder(x, y, 1.6, 5, 16, (z, t) => {
    const k = Math.floor(z * 0.7 + t * 1.6 + 8) % 4;
    return k === 0 ? P.white : k === 1 ? rgb(220, 40, 40) : k === 2 ? P.white : rgb(40, 80, 200);
  }, P.steelLight, g, 2);
  r.ellipsoid(x, y, 16, 1.8, 1.8, 2, P.steelLight, g, 16, 3);
}

function lawoffice(c: Ctx): void {
  const { r, F, s } = c;
  const T = c.tone;
  const A = F.A;
  const B = F.B;
  const b1 = B - 9;
  commercialLot(c, b1);
  const floors = Math.max(2, levelFloors(c));
  const closed = s.state === 'closed';
  const H = 16 + (floors - 1) * 13;
  const wall = T(vpick(c, [hex('#9c4c3c'), hex('#a8604a'), hex('#8a4a3a')], 2));
  const trim = T(rgb(236, 230, 214));
  castShadow(c, 4, 5, A - 4, b1, H);
  const body = F.box(4, 5, 0, A - 4, b1, H, (i, j, f) => (j < 2 ? T(rgb(130, 124, 116)) : j >= H - 2 ? trim : (brick(wall, c.seed) as (i: number, j: number, f: Face) => Col)(i, j, f)), null);
  const rect = F.rect(4, 5, A - 4, b1);
  flatRoof(r, rect[0], rect[1], rect[2], rect[3], H, T(rgb(90, 96, 92)), trim, 2);
  const fr = body.front;
  const W = fr.W;
  const mid = Math.floor(W / 2);
  c.an.door = drawDoor(fr, mid - 2, 4, 9, T(hex('#2f4a3a')), { frame: trim, boarded: closed });
  // columns flanking the entrance + small pediment
  if (!closed) {
    for (const k of [mid - 4, mid + 3]) {
      const [x, y] = fr.world(k, 2, 0);
      column(r, x, y, 1, 0, 13, T(P.white));
    }
    const [x0, y0, z0, x1, y1, z1] = fr.boxOut(mid - 6, mid + 6, 0, 4, 13, 15);
    r.box(x0, y0, z0, x1, y1, z1, trim, trim);
  }
  const ws: WinStyle = { w: 3, h: 6, sill: trim, lintel: trim, shutters: T(hex('#2f4a3a')) };
  for (let fl = 0; fl < floors; fl++) {
    for (const f of [fr, body.side]) {
      const n = Math.max(1, Math.floor((f.W - 4) / 8));
      const tot = (n - 1) * 8 + 3;
      const i0 = Math.floor((f.W - tot) / 2);
      for (let k = 0; k < n; k++) {
        const i = i0 + k * 8;
        if (fl === 0 && f === fr && Math.abs(i + 1 - mid) < 7) continue;
        const stt: WinState = closed ? (fl === 0 ? 'boarded' : 'dark') : isLit(c.seed, f.axis, fl, k, s.lit) ? 'lit' : 'day';
        drawWindow(f, i, 3 + fl * 13, ws, stt);
      }
    }
  }
  if (closed) {
    closedBoard(c, fr, 9);
    neglect(c, b1);
  } else {
    // brass name plate
    const plate = s.sign ? fitText(s.sign, W - 6) : '';
    const pw = plate ? textBitmap(plate).w + 4 : 13;
    const b = signBoard(fr, Math.floor((W - pw) / 2), pw, H - 10, 7, T(hex('#1f3a2c')), plate || undefined, P.gold, 1, P.gold);
    if (!s.sign) facePicto(b, 'lawoffice', 4, 5);
    plant(r, bushArt(0), ...F.xy(5, b1 + 2));
    plant(r, bushArt(2), ...F.xy(A - 5, b1 + 2));
  }
}
