// Factories (2x2, level 1..4, six subtypes) and construction-company yards (2x2).

import { type Col, P, hex, rgb, shade, mix, emissive, toCss } from '../color';
import { Raster, Face, type WallPaint, project } from '../raster';
import {
  metalWall,
  brick,
  concreteWall,
  gableRoof,
  metalRoof,
  flatRoof,
  drawWindow,
  drawDoor,
  signBoard,
  isLit,
  crate,
  type WinState,
} from '../kit';
import { plant, treeArt } from '../props';
import { drawVehicle } from '../vehicles';
import { type Ctx, vpick, vchance, apron, castShadow } from './common';
import { dirt, gravel, grass } from '../textures';
import { h01 } from '../rng';
import { closedBoard } from './commercial';
import { facePicto } from '../pictos';
import { textBitmap, fitText } from '../font';

export const FACTORY_SUBS = ['textiles', 'furniture', 'electronics', 'steel', 'food', 'chemicals'] as const;

interface FStyle {
  wall: Col;
  accent: Col;
  roof: Col;
  stack: Col;
  stackBand: Col;
}

const FSTYLE: Record<string, FStyle> = {
  textiles: { wall: hex('#c4b4d4'), accent: hex('#8a3a8a'), roof: hex('#6a6a78'), stack: hex('#9a4a3a'), stackBand: P.white },
  furniture: { wall: hex('#cfb084'), accent: hex('#7a4a24'), roof: hex('#6e5c4a'), stack: hex('#9a4a3a'), stackBand: P.white },
  electronics: { wall: hex('#e4e8ec'), accent: hex('#3a78d0'), roof: hex('#8a94a4'), stack: hex('#d0d4d8'), stackBand: hex('#3a78d0') },
  steel: { wall: hex('#7a7a82'), accent: hex('#e8792c'), roof: hex('#4e4e56'), stack: hex('#8a8a90'), stackBand: hex('#d83a2a') },
  food: { wall: hex('#f0e8d4'), accent: hex('#3a9a4a'), roof: hex('#7a8a7a'), stack: hex('#a85a44'), stackBand: P.white },
  chemicals: { wall: hex('#c8ccc0'), accent: hex('#c8b820'), roof: hex('#6a7066'), stack: hex('#d6d6ce'), stackBand: hex('#d83a2a') },
};

/** Roll-up loading door on a face. */
function rollDoor(f: Face, i: number, w: number, h: number, c: Col, hazard = false): void {
  f.rect(i - 1, 0, 1, h + 1, shade(c, 0.6));
  f.rect(i + w, 0, 1, h + 1, shade(c, 0.6));
  f.rect(i - 1, h, w + 2, 1, shade(c, 0.6));
  for (let a = 0; a < w; a++) {
    for (let b = 0; b < h; b++) {
      let col = b % 2 === 0 ? c : shade(c, 0.88);
      if (hazard && b < 2) col = ((a + b) >> 1) % 2 ? P.black : P.yellow;
      f.set(i + a, b, col);
    }
  }
}

/** Industrial smokestack; returns the local pixel of its mouth (smoke emitter). */
function smokestack(r: Raster, x: number, y: number, rad: number, h: number, c: Col, band: Col): [number, number] {
  const g = r.group();
  r.box(x - rad - 1, y - rad - 1, 0, x + rad + 1, y + rad + 1, 4, shade(c, 0.85), shade(c, 0.95), g);
  r.cylinder(x, y, rad, 4, h, (z) => (z > h - 10 && z < h - 6 ? band : z > h - 16 && z < h - 13 ? band : Math.floor(z) % 5 === 0 && c !== band ? shade(c, 0.93) : c), P.black, g, 4);
  r.cylinder(x, y, rad + 0.6, h - 1, h + 1, shade(c, 0.8), rgb(30, 28, 30), g, 3);
  const [px, py] = project(x, y, h + 1);
  return [Math.floor(px), Math.floor(py)];
}

/** Silo with a conical cap. */
function silo(r: Raster, x: number, y: number, rad: number, h: number, c: Col): void {
  const g = r.group();
  r.cylinder(x, y, rad, 0, h, (z, t) => (Math.floor(z) % 8 === 0 ? shade(c, 0.9) : Math.abs(t) < 0.2 ? shade(c, 1.05) : c), null, g);
  const n = 16;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    r.plane(
      [
        [x + Math.cos(a0) * (rad + 0.4), y + Math.sin(a0) * (rad + 0.4), h],
        [x + Math.cos(a1) * (rad + 0.4), y + Math.sin(a1) * (rad + 0.4), h],
        [x, y, h + rad * 0.7],
      ],
      shade(c, 0.95),
      g,
    );
  }
}

/** Sawtooth roof over a local rect: teeth rise towards the front with glazing facing front. */
function sawtooth(c: Ctx, a0: number, a1: number, b0: number, b1: number, H: number, n: number, th: number, roofC: Col, sideC: WallPaint, gWall: number): void {
  const { r, F } = c;
  const D = (b1 - b0) / n;
  const mat = metalRoof(roofC);
  const glass = c.s.state === 'closed' ? P.glassDark : mix(P.glassDay, P.glassDayHi, 0.3);
  for (let k = 0; k < n; k++) {
    const bk = b0 + k * D;
    const be = bk + D;
    const g = r.group();
    r.plane([F.pt(a0, bk, H), F.pt(a1, bk, H), F.pt(a1, be, H + th), F.pt(a0, be, H + th)], (x, y, z) => mat(F.front === 'left' ? x : y, z), g);
    // glazing (vertical, facing front)
    const [wx0, wy0, wx1, wy1] = F.rect(a0, bk, a1, be);
    const gl = F.front === 'left' ? r.vface('L', wy1, wx0, wx1, H, H, H + th, null, g) : r.vface('R', wx1, wy0, wy1, H, H, H + th, null, g);
    gl.fill((i, j) => (j === th - 1 ? shade(roofC, 0.8) : i % 4 === 0 ? P.steelDark : glass));
    // triangular end on the visible side
    if (F.front === 'left') r.vface('R', wx1, wy0, wy1, H, H, (t) => H + (th * (t - wy0)) / (wy1 - wy0), sideC, gWall);
    else r.vface('L', wy1, wx0, wx1, H, H, (t) => H + (th * (t - wx0)) / (wx1 - wx0), sideC, gWall);
  }
}

export function factory(c: Ctx): void {
  const { r, F, s } = c;
  const T = c.tone;
  const lvl = s.level;
  const A = F.A;
  const B = F.B;
  const sub = (FACTORY_SUBS as readonly string[]).includes(s.subtype) ? s.subtype : vpick(c, FACTORY_SUBS, 1);
  const st = FSTYLE[sub];
  const closed = s.state === 'closed';
  const wall = T(st.wall);
  const accent = T(st.accent);
  const roofC = T(st.roof);
  const chimneys: [number, number][] = [];

  // yard: concrete with painted walkway lines; weeds when closed
  const ap = apron(c, T(rgb(170, 166, 158)));
  const gr = (a: number, b: number) => {
    const [x, y] = F.xy(a, b);
    return grass(x, y, c.seed, closed ? 0.9 : 0.1);
  };
  F.ground(0, 0, A, B, (a, b) => {
    if (a < 2 || b < 2) return gr(a, b);
    if (closed && h01(Math.floor(a / 3), Math.floor(b / 3), c.seed) < 0.12) return gr(a, b);
    if (Math.abs(b - (B - 5)) < 0.6 && Math.floor(a) % 6 < 4) return T(P.yellow);
    return ap(a, b);
  });

  const wp = sub === 'steel' || sub === 'chemicals' ? metalWall(wall) : sub === 'food' || sub === 'electronics' ? concreteWall(wall, 16, 40) : brick(wall, c.seed);

  // --- main hall
  const big = lvl >= 2;
  const ha0 = big ? 4 : 10;
  const ha1 = big ? 42 : 44;
  const hb0 = big ? 6 : 10;
  const hb1 = big ? 46 : 44;
  const H = big ? 20 : 18;
  castShadow(c, ha0, hb0, ha1, hb1, H + 8);
  const hall = F.box(ha0, hb0, 0, ha1, hb1, H, (i, j, f) => (j < 2 ? T(rgb(96, 92, 90)) : j >= f.hi[i] - 2 ? accent : typeof wp === 'number' ? wp : wp(i, j, f)), null);
  const [hx0, hy0, hx1, hy1] = F.rect(ha0, hb0, ha1, hb1);
  if (big) {
    sawtooth(c, ha0, ha1, hb0, hb1, H, lvl >= 3 ? 4 : 3, 8, roofC, wp, hall.g);
  } else {
    gableRoof(r, hx0, hy0, hx1, hy1, H, 12, F.axis('b'), metalRoof(roofC), { ov: 1, gable: wp, gWall: hall.g, barge: accent });
  }
  // front: big roll-up door + personnel door + sign
  const fr = hall.front;
  const dW = big ? 12 : 10;
  const di = Math.floor(fr.W / 2) - (big ? 2 : Math.floor(dW / 2));
  rollDoor(fr, di, dW, 12, T(rgb(150, 154, 160)), sub === 'chemicals');
  if (sub === 'steel' && !closed) {
    // furnace glow through a half-open door
    for (let a = 1; a < dW - 1; a++) for (let b = 0; b < 4; b++) fr.set(di + a, b, emissive(b < 2 ? rgb(255, 170, 60) : rgb(255, 110, 40)));
  }
  c.an.door = drawDoor(fr, di - 7, 4, 9, accent, { boarded: closed, frame: T(P.white) });
  // clerestory windows along the hall sides
  const winSt = { w: 4, h: 4, sill: null, frame: T(shade(st.wall, 0.7)) };
  for (const f of [fr, hall.side]) {
    for (let i = 3; i + 4 < f.W - 2; i += 7) {
      if (f === fr && i + 5 > di - 8 && i < di + dW + 2) continue;
      const stt: WinState = closed ? (h01(c.seed, i) < 0.4 ? 'broken' : 'dark') : isLit(c.seed, f.axis, 0, i, s.lit) ? 'lit' : 'day';
      drawWindow(f, i, 12, winSt, stt);
    }
  }
  // company sign
  if (!closed) {
    const txt = s.sign ? fitText(s.sign, fr.W - 14) : '';
    const w = txt ? textBitmap(txt).w + 10 : 13;
    const b = signBoard(fr, Math.max(1, di + Math.floor(dW / 2) - Math.floor(w / 2)), w, 13, 7, accent, undefined, P.white, 1, T(P.white));
    facePicto(b, 'factory', 2, 5);
    if (txt) b.text(txt, 8, 5, P.white, textBitmap);
  } else {
    closedBoard(c, fr, 13);
  }
  // side loading bay
  const sd = hall.side;
  if (big) {
    const k = F.sideCol(sd, 10);
    const i0 = F.front === 'left' ? k : k - 10;
    rollDoor(sd, i0, 9, 10, T(rgb(150, 154, 160)));
    rollDoor(sd, i0 + 13, 9, 10, T(rgb(150, 154, 160)));
  }

  // --- office annex (level 2+)
  if (big) {
    const oa0 = 6, oa1 = 24, ob0 = 48, ob1 = 58;
    const ob = F.box(oa0, ob0, 0, oa1, ob1, 20, (i, j, f) => (j < 2 ? T(rgb(96, 92, 90)) : j >= f.hi[i] - 2 ? accent : T(shade(st.wall, 1.04))), null);
    const orr = F.rect(oa0, ob0, oa1, ob1);
    flatRoof(r, orr[0], orr[1], orr[2], orr[3], 20, (x, y) => gravel(x, y, 5, T(rgb(120, 116, 110))), accent, 1);
    for (const f of [ob.front, ob.side]) {
      for (let fl = 0; fl < 2; fl++) {
        for (let i = 2; i + 3 < f.W - 1; i += 5) {
          const stt: WinState = closed ? 'dark' : isLit(c.seed, f.axis, fl + 3, i, s.lit) ? 'lit' : 'day';
          drawWindow(f, i, 3 + fl * 9, { w: 3, h: 4, sill: null }, stt);
        }
      }
    }
    if (sub === 'electronics' && !closed) {
      // solar panels
      const g = r.group();
      for (let k = 0; k < 3; k++) {
        const [x, y] = F.xy(oa0 + 3 + k * 5, ob0 + 3);
        r.plane([[x, y, 21], [x + 4, y, 21], [x + 4, y + 5, 24], [x, y + 5, 24]], (xx, yy) => ((Math.floor(xx) + Math.floor(yy)) % 2 ? rgb(40, 60, 120) : rgb(60, 90, 160)), g);
      }
    }
  }

  // --- stacks
  const stackC = T(st.stack);
  const band = T(st.stackBand);
  const stackSpots: [number, number, number][] = [
    [54, 14, 62],
    [60, 30, 52],
    [48, 6, 46],
  ];
  const nStacks = lvl === 1 ? 0 : Math.min(3, lvl - 1);
  for (let k = 0; k < nStacks; k++) {
    const [a, b, h] = stackSpots[k];
    const [x, y] = F.xy(a, b);
    const mouth = smokestack(r, x, y, k === 0 ? 3.4 : 2.8, h + (sub === 'steel' ? 8 : 0), stackC, band);
    chimneys.push(mouth);
  }
  if (lvl === 1) {
    // flue pipe on the shed roof
    const [x, y] = F.xy(ha0 + 8, hb0 + 8);
    const g = r.group();
    r.cylinder(x, y, 1.6, H, H + 20, T(P.steel), P.black, g, 3);
    r.cylinder(x, y, 2.3, H + 19, H + 21, T(P.steelDark), P.black, g, 3);
    const [px, py] = project(x, y, H + 21);
    chimneys.push([Math.floor(px), Math.floor(py)]);
  }

  // --- silos / tanks (level 3+)
  if (lvl >= 3) {
    const siloC = T(sub === 'chemicals' ? hex('#e8ecee') : sub === 'food' ? hex('#f4f2ea') : hex('#c8ccd0'));
    const spots: [number, number][] = [[52, 42], [52, 54]];
    for (const [a, b] of spots) {
      const [x, y] = F.xy(a, b);
      if (sub === 'chemicals') {
        const g = r.group();
        r.ellipsoid(x, y, 10, 6, 6, 10, (_x, _y, z) => (Math.abs(z - 10) < 1 ? T(hex('#3a9a4a')) : siloC), g);
        r.box(x - 1, y - 1, 0, x + 1, y + 1, 4, P.steelDark, P.steelDark, g);
      } else silo(r, x, y, 5.5, 34, siloC);
    }
  }
  // --- second wing + conveyor (level 4)
  if (lvl >= 4) {
    const wb = F.box(27, 49, 0, 42, 61, 14, (i, j, f) => (j >= f.hi[i] - 1 ? accent : typeof wp === 'number' ? wp : wp(i, j, f)), null);
    const wr = F.rect(27, 49, 42, 61);
    gableRoof(r, wr[0], wr[1], wr[2], wr[3], 14, 7, F.axis('a'), metalRoof(roofC), { ov: 1, gable: wp, gWall: wb.g });
    rollDoor(wb.front, 3, 8, 9, T(rgb(150, 154, 160)));
    const g = r.group();
    const [cx0, cy0, cx1, cy1] = F.rect(42, 36, 49, 40);
    r.box(cx0, cy0, 24, cx1, cy1, 28, T(shade(st.wall, 0.9)), T(roofC), g);
    for (const a of [44, 47]) {
      const [x, y] = F.xy(a, 38);
      r.box(x - 0.5, y - 0.5, 0, x + 0.5, y + 0.5, 24, P.steelDark, P.steelDark, g);
    }
  }

  // --- yard dressing (kept clear of annex, silos and wing)
  if (!closed) {
    if (lvl === 2) {
      const [px, py] = F.xy(53, 49);
      drawVehicle(r, 'truck', F.front === 'left' ? 1 : 0, sub === 'food' ? '#3a9a4a' : '#e8e4da', px, py);
    }
    if (lvl <= 3) {
      const mat = sub === 'furniture' ? P.woodLight : sub === 'textiles' ? hex('#b05ab0') : sub === 'steel' ? rgb(90, 90, 96) : sub === 'food' ? hex('#e8c060') : sub === 'chemicals' ? hex('#3a7ac8') : hex('#d8d8dc');
      const pa = big ? 27 : ha0 + 2;
      const pb = big ? 50 : B - 13;
      for (let k = 0; k < 2; k++) {
        const [x0, y0, x1, y1] = F.rect(pa + k * 7, pb, pa + k * 7 + 5, pb + 5);
        const g = r.group();
        r.box(x0, y0, 0, x1, y1, 1, P.wood, P.woodLight, g);
        if (sub === 'chemicals') r.cylinder((x0 + x1) / 2, (y0 + y1) / 2, 2, 1, 7, T(mat), T(shade(mat, 1.1)));
        else crate(r, x0 + 0.5, y0 + 0.5, x1 - 0.5, y1 - 0.5, 1, 5 + k * 2, T(mat));
      }
    }
  } else {
    plant(r, treeArt(5), ...F.xy(A - 8, B - 9));
  }
  c.an.chimneys = closed ? [] : chimneys;
}


// ---------------------------------------------------------------------------
// Builder yard

/** Chain-link fence panel along a world line (axis aligned). */
function chainFence(r: Raster, x0: number, y0: number, x1: number, y1: number, h = 8): void {
  const g = r.group();
  const post = rgb(120, 124, 132);
  const mesh = rgb(170, 174, 182);
  const alongX = y0 === y1;
  const paint: WallPaint = (i, j) => (j === h - 1 ? post : (i + j) % 3 === 0 || (i - j + 99) % 3 === 0 ? mesh : 0);
  if (alongX) r.vface('L', y0, x0, x1, 0, 0, h, paint, g);
  else r.vface('R', x0, y0, y1, 0, 0, h, paint, g);
  const len = alongX ? x1 - x0 : y1 - y0;
  for (let k = 0; k <= len; k += 8) r.pole(alongX ? x0 + k : x0, alongX ? y0 : y0 + k, 0, h + 1, post, g, false);
}

/** Chunky beam made of small boxes stepping from p to q (excavator arms). */
function beam(r: Raster, p: [number, number, number], q: [number, number, number], th: number, col: Col, g: number): void {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1], (q[2] - p[2]) / 2);
  const n = Math.max(2, Math.ceil(len));
  const e = th / 2;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const x = Math.round(p[0] + (q[0] - p[0]) * t);
    const y = Math.round(p[1] + (q[1] - p[1]) * t);
    const z = Math.round(p[2] + (q[2] - p[2]) * t);
    r.box(x - e, y - e, z - th, x + e, y + e, z + 1, col, shade(col, 1.05), g);
  }
}

export function excavator(r: Raster, x: number, y: number, alongX: boolean, col: Col = P.yellow): void {
  const g = r.group();
  const track = rgb(52, 52, 58);
  const tpaint: WallPaint = (i, j) => (j === 1 && i % 2 === 0 ? rgb(90, 90, 96) : track);
  const P2 = (dx: number, dy: number): [number, number] => (alongX ? [x + dx, y + dy] : [x - dy, y + dx]);
  const bx = (a0: number, b0: number, a1: number, b1: number, z0: number, z1: number, side: WallPaint, top: Col, gg = g) => {
    const [p0x, p0y] = P2(a0, b0);
    const [p1x, p1y] = P2(a1, b1);
    return r.box(Math.min(p0x, p1x), Math.min(p0y, p1y), z0, Math.max(p0x, p1x), Math.max(p0y, p1y), z1, side, top, gg);
  };
  bx(-8, -6, 8, -3, 0, 4, tpaint, track);
  bx(-8, 3, 8, 6, 0, 4, tpaint, track);
  bx(-3, -3, 3, 3, 0, 4, track, track);
  bx(-6, -5, 5, 5, 4, 10, (_i, j) => (j === 0 ? shade(col, 0.8) : col), col);
  bx(-8, -5, -5, 5, 4, 10, rgb(70, 70, 76), rgb(90, 90, 96));
  bx(0, -5, 5, 0, 10, 18, (i, j, f) => (j >= 2 && j <= 6 && i > 0 && i < f.W - 1 ? (j === 6 ? P.glassDayHi : P.glassDay) : col), col);
  const gb = r.group();
  const q = (dx: number, dy: number, z: number): [number, number, number] => {
    const [a, b] = P2(dx, dy);
    return [a, b, z];
  };
  beam(r, q(4, 2, 11), q(13, 2, 24), 2, col, gb);
  beam(r, q(13, 2, 24), q(19, 2, 9), 2, col, gb);
  bx(17, 0, 22, 4, 2, 8, rgb(70, 70, 76), rgb(90, 90, 96), gb);
}

export function builder(c: Ctx): void {
  const { r, F, s } = c;
  const T = c.tone;
  const lvl = s.level;
  const A = F.A;
  const B = F.B;
  const closed = s.state === 'closed';
  const accent = T(c.s.accent ? c.accent : vpick(c, [hex('#e8792c'), hex('#3a78c8'), hex('#3a9a4a'), hex('#c83a3a')], 1));

  // yard ground: dirt + gravel patches, weeds when closed
  F.ground(0, 0, A, B, (a, b) => {
    const [x, y] = F.xy(a, b);
    if (closed && h01(Math.floor(a / 4), Math.floor(b / 4), c.seed) < 0.3) return grass(x, y, c.seed, 0.9);
    const k = h01(Math.floor(a / 10), Math.floor(b / 10), c.seed + 3);
    return k < 0.45 ? gravel(x, y, c.seed, T(rgb(160, 150, 132))) : dirt(x, y, c.seed);
  });

  // fences along back edges (visible behind) and the sides, gate gap at the front
  chainFence(r, 1, 1, 32 * s.w - 1, 1);
  chainFence(r, 1, 1, 1, 32 * s.d - 1);

  // site office (portacabin)
  const oa0 = 5, oa1 = 27, ob0 = 5, ob1 = 18;
  castShadow(c, oa0, ob0, oa1, ob1, 13);
  const ob = F.box(oa0, ob0, 0, oa1, ob1, 13, (i, j, f) => (j < 1 ? T(rgb(80, 80, 86)) : j >= f.hi[i] - 1 ? T(P.white) : i % 6 === 5 ? shade(accent, 0.9) : accent), T(rgb(200, 200, 196)));
  const fr = ob.front;
  c.an.door = drawDoor(fr, 3, 4, 9, T(P.white), { boarded: closed });
  for (let i = 10; i + 4 < fr.W; i += 6) drawWindow(fr, i, 5, { w: 4, h: 4, frame: T(P.white) }, closed ? 'boarded' : isLit(c.seed, 'L', 0, i, s.lit) ? 'lit' : 'day');
  drawWindow(ob.side, Math.floor(ob.side.W / 2) - 2, 5, { w: 4, h: 4, frame: T(P.white) }, closed ? 'boarded' : 'day');
  if (closed) closedBoard(c, fr, 13);
  else {
    const txt = fitText(s.sign || 'BUILD', fr.W - 4);
    const w = textBitmap(txt).w + 4;
    signBoard(fr, Math.floor((fr.W - w) / 2), w, 13, 7, T(P.white), txt, accent, 1, accent);
  }

  // materials: lumber, steel beams, bricks, sand
  const lumber = (a: number, b: number, n: number) => {
    const [x, y] = F.xy(a, b);
    const g = r.group();
    for (let k = 0; k < n; k++) {
      const z = k * 2;
      const L = 14;
      const paint: WallPaint = (i, j) => (j === 0 ? P.woodDark : i % 3 === 0 ? P.woodLight : P.wood);
      if (F.front === 'left') r.box(x, y, z, x + L, y + 6, z + 2, paint, P.woodLight, g);
      else r.box(x, y - L, z, x + 6, y, z + 2, paint, P.woodLight, g);
    }
  };
  const beams = (a: number, b: number, n: number) => {
    const [x, y] = F.xy(a, b);
    const g = r.group();
    const blue = T(hex('#4a5a7a'));
    for (let k = 0; k < n; k++) {
      const off = k * 3;
      const paint: WallPaint = (_i, j) => (j === 1 ? shade(blue, 0.7) : blue);
      if (F.front === 'left') r.box(x, y + off, 0, x + 22, y + off + 2, 3, paint, shade(blue, 1.1), g);
      else r.box(x + off, y - 22, 0, x + off + 2, y, 3, paint, shade(blue, 1.1), g);
    }
    if (n > 2) {
      if (F.front === 'left') r.box(x + 2, y + 1, 3, x + 20, y + 3, 6, (_i, j) => (j === 1 ? shade(blue, 0.7) : blue), shade(blue, 1.1), g);
      else r.box(x + 1, y - 20, 3, x + 3, y - 2, 6, (_i, j) => (j === 1 ? shade(blue, 0.7) : blue), shade(blue, 1.1), g);
    }
  };
  const bricks = (a: number, b: number) => {
    const [x, y] = F.xy(a, b);
    const g = r.group();
    r.box(x, y, 0, x + 7, y + 7, 1, P.wood, P.woodLight, g);
    r.box(x + 0.5, y + 0.5, 1, x + 6.5, y + 6.5, 6, (i, j) => (j % 2 === 1 ? rgb(170, 80, 60) : (i + j) % 4 === 0 ? rgb(150, 66, 50) : rgb(196, 96, 70)), rgb(200, 104, 76), g);
  };
  if (!closed || vchance(c, 0.5, 5)) lumber(34, 6, lvl + 1);
  if (!closed) {
    beams(32, 22, lvl >= 2 ? 3 : 2);
    bricks(8, 26);
    bricks(8, 35);
    // sand pile
    const [sx, sy] = F.xy(52, 42);
    r.ellipsoid(sx, sy, 0, 8, 8, 8, (x, y, z) => (h01(Math.floor(x * 2), Math.floor(y * 2), Math.floor(z)) < 0.15 ? P.sandDark : P.sand), r.group(), 0, 4);
  }
  // equipment
  if (!closed) {
    const [ex, ey] = F.xy(22, 44);
    excavator(r, ex, ey, F.front === 'left');
    if (lvl >= 2) {
      const [mx, my] = F.xy(44, 54);
      drawVehicle(r, 'mixer', F.front === 'left' ? 2 : 3, toCss(accent), mx, my);
    }
    if (lvl >= 3) {
      // equipment shed with roll-up doors
      const sb = F.box(38, 26, 0, 60, 38, 16, (i, j, f) => (j >= f.hi[i] - 1 ? accent : metalWallPaint(i, j)), null);
      const sr = F.rect(38, 26, 60, 38);
      flatRoof(r, sr[0], sr[1], sr[2], sr[3], 16, T(rgb(120, 124, 130)), accent, 1);
      rollDoor(sb.front, 2, 8, 11, T(rgb(160, 164, 170)));
      rollDoor(sb.front, 12, 8, 11, T(rgb(160, 164, 170)));
    }
  } else {
    // one rusty machine left behind
    const [ex, ey] = F.xy(22, 44);
    excavator(r, ex, ey, F.front === 'left', rgb(150, 110, 60));
  }
}

const metalWallPaint = (i: number, _j: number): Col => (i % 3 === 0 ? rgb(150, 154, 160) : rgb(176, 180, 186));
