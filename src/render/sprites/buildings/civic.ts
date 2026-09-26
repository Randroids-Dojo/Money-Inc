// Banks (2x2, level 1..3, normal / distressed / failed), the central Reserve Bank
// (3x3, the grandest building on the map) and City Hall (2x2).

import { type Col, P, hex, rgb, shade, lum } from '../color';
import { Face, type WallPaint } from '../raster';
import {
  stone,
  awning,
  drawDoor,
  gableRoof,
  hipRoof,
  flatRoof,
  plainRoof,
  shingleRoof,
  column,
  flagpole,
  signBoard,
  windowGrid,
  hedge,
  acUnit,
  type WinStyle,
} from '../kit';
import { plant, treeArt, drawLamp, drawFlowers } from '../props';
import { type Ctx, vpick, pave, lawn, castShadow } from './common';
import { gravel } from '../textures';
import { textBitmap, fitText } from '../font';

const STONES = [hex('#e6dcc2'), hex('#dcdad2'), hex('#dcc6a0'), hex('#d8bfae')];

/** Round clock face drawn upright on a face, centred at (i, j). */
function clockFace(f: Face, i: number, j: number, rad: number, hours = 10): void {
  const rim = P.gold;
  const face = rgb(250, 248, 238);
  const ink = rgb(40, 36, 44);
  const mid = f.bot[Math.max(0, Math.min(f.W - 1, i))];
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > rad + 0.3) continue;
      const ci = i + dx;
      if (ci < 0 || ci >= f.W) continue;
      const c = d > rad - 0.9 ? rim : face;
      f.r.plot(f.px(ci), mid - j + dy, c, f.depth(ci) + 0.05, f.g);
    }
  }
  // hands: minute straight up, hour towards `hours`
  for (let k = 1; k < rad; k++) f.r.plot(f.px(i), mid - j - k, ink, f.depth(i) + 0.06, f.g);
  const ang = (hours / 12) * Math.PI * 2;
  for (let k = 1; k < rad - 1; k++) {
    const ci = i + Math.round(Math.sin(ang) * k);
    f.r.plot(f.px(ci), mid - j - Math.round(Math.cos(ang) * k), ink, f.depth(ci) + 0.06, f.g);
  }
}

/** Vertical banner hanging on a face (accent colour with a notched tail). */
function banner(f: Face, i: number, jTop: number, len: number, col: Col): void {
  for (let j = jTop - len; j <= jTop; j++) {
    for (let a = 0; a < 3; a++) {
      if (j === jTop - len && a === 1) continue;
      f.set(i + a, j, a === 0 ? shade(col, 1.1) : a === 2 ? shade(col, 0.85) : col);
    }
  }
  f.set(i + 1, jTop - 3, P.gold);
}

/** Roll-down metal shutter over a face rect (failed banks). */
function shutter(f: Face, i: number, j: number, w: number, h: number): void {
  for (let a = 0; a < w; a++) {
    for (let b = 0; b < h; b++) f.set(i + a, j + b, b % 2 === 0 ? rgb(150, 154, 160) : rgb(118, 122, 130));
  }
  f.rect(i, j + h, w, 1, rgb(80, 84, 92));
}

// ---------------------------------------------------------------------------
// Commercial bank

export function bank(c: Ctx): void {
  const { r, F, s } = c;
  const T = c.tone;
  const lvl = s.level;
  const A = F.A;
  const B = F.B;
  const failed = s.state === 'failed';
  const distressed = s.state === 'distressed';
  const floors = lvl + 1;
  const fh = 13;
  const H = 6 + floors * fh;
  const stoneC = T(vpick(c, STONES, 1));
  const accent = failed ? T(rgb(120, 120, 124)) : T(c.accent);
  const trim = T(shade(vpick(c, STONES, 1), 1.08));
  const roofC = T(vpick(c, [hex('#4a5a6a'), hex('#45704f'), hex('#5c6676')], 2));

  // plaza lot with lawn strips
  const pv = pave(c, T(hex('#d4ccbc')), 8);
  const gr = lawn(c, failed ? 0.7 : 0);
  F.ground(0, 0, A, B, (a, b) => ((a < 6 || a > A - 6) && b < B - 8 ? gr(a, b) : pv(a, b)));

  const a0 = 6, a1 = A - 6, b0 = 6, b1 = B - 18;
  castShadow(c, a0, b0, a1, b1, H);
  const rust: WallPaint = stone(stoneC, c.seed, 4, 10);
  const smooth: WallPaint = stone(stoneC, c.seed + 1, 3, 12);
  const body = F.box(a0, b0, 0, a1, b1, H, (i, j, f) => {
    if (j < 2) return T(shade(vpick(c, STONES, 1), 0.8));
    if (j >= H - 3) return trim;
    if (j === 6 + fh - 1 || j === 6) return trim;
    const p = j < 6 + fh ? rust : smooth;
    return typeof p === 'number' ? p : p(i, j, f);
  }, null);
  const rr = F.rect(a0, b0, a1, b1);
  flatRoof(r, rr[0], rr[1], rr[2], rr[3], H, (x, y) => gravel(x, y, c.seed, T(rgb(130, 126, 120))), trim, 3);
  // balustrade dots
  const fr = body.front;
  const sd = body.side;
  const W = fr.W;
  const mid = Math.floor(W / 2);

  // portico geometry (local): wide enough for the name plate
  const txt = fitText(s.sign || 'BANK', A - 22);
  const tw = textBitmap(txt).w;
  const pw = Math.max(lvl === 3 ? 38 : 28, Math.min(A - 18, tw + 8));
  const ncol = pw >= 36 ? 6 : 4;
  const pa0 = Math.floor(A / 2 - pw / 2);
  const pa1 = pa0 + pw;
  const colTop = Math.min(H - 4, 24 + lvl * 4);
  const pb1 = b1 + 8;

  // windows (tall, arched) on both faces, skipping the portico zone on the front
  const ws: WinStyle = { w: 4, h: 8, arch: true, sill: trim, frame: null };
  const mode = failed ? 'boarded' : distressed ? 'distressed' : 'normal';
  const skipFront = (fl: number, _b: number, i: number) => i + 5 > pa0 - a0 - 1 && i < pa1 - a0 + 1 && fl * fh < colTop + 4;
  windowGrid(fr, { floors, floorH: fh, j0: 6, sill: 3, pitch: 7, style: ws, lit: s.lit, seed: c.seed, mode: failed ? 'dark' : mode, skip: skipFront });
  windowGrid(sd, { floors, floorH: fh, j0: 6, sill: 3, pitch: 7, style: ws, lit: s.lit, seed: c.seed + 5, mode: failed ? 'dark' : mode });
  if (failed) {
    // shutters over the ground floor openings
    for (const f of [fr, sd]) {
      const n = Math.max(1, Math.floor((f.W - 4) / 7) + 1);
      const tot = (n - 1) * 7 + 4;
      const i0 = Math.floor((f.W - tot) / 2);
      for (let k = 0; k < n; k++) {
        const i = i0 + k * 7;
        if (f === fr && i + 5 > pa0 - a0 - 1 && i < pa1 - a0 + 1) continue;
        shutter(f, i, 9, 4, 8);
      }
    }
  }
  // door (bronze) behind the portico
  if (failed) shutter(fr, mid - 5, 0, 10, 12);
  else c.an.door = drawDoor(fr, mid - 4, 8, 12, T(hex('#8a6a3a')), { double: true, frame: P.gold, glass: false, knob: true });
  if (!c.an.door) c.an.door = fr.pt(mid, 0);

  // steps + stylobate
  const g = r.group();
  const stoneBase = vpick(c, STONES, 1);
  for (let k = 0; k < 3; k++) {
    F.box(pa0 - 6 + k * 2, b1, 0, pa1 + 6 - k * 2, pb1 + 6 - k * 3, 2 * (k + 1), (_i, j) => (j === 2 * (k + 1) - 1 ? T(shade(stoneBase, 1.05)) : T(shade(stoneBase, 0.92))), T(shade(stoneBase, 1.02)), g);
  }
  // columns
  const colC = T(rgb(240, 236, 226));
  for (let k = 0; k < ncol; k++) {
    const a = pa0 + 3 + ((pw - 6) * k) / (ncol - 1);
    const [x, y] = F.xy(Math.round(a), pb1 - 2);
    column(r, x, y, 1.6, 6, colTop, colC);
  }
  // entablature with the name plate
  const ent = F.box(pa0 - 1, b1, colTop, pa1 + 1, pb1 + 1, colTop + 8, (_i, j) => (j === 7 ? trim : j === 0 ? T(shade(vpick(c, STONES, 1), 0.9)) : trim), trim);
  const ef = ent.front;
  const plateW = Math.min(ef.W - 2, Math.max(tw + 5, 17));
  const pi0 = Math.floor((ef.W - plateW) / 2);
  const plateBg = failed ? rgb(96, 96, 100) : accent;
  const fg = failed ? rgb(150, 150, 150) : lum(accent) > 150 ? rgb(30, 30, 36) : P.white;
  const plate = signBoard(ef, pi0, plateW, 0, 8, plateBg, undefined, fg, 1, failed ? rgb(70, 70, 74) : P.gold);
  plate.text(txt, Math.floor((plateW - (textBitmap(txt).w)) / 2), 6, fg, textBitmap);
  // pediment
  const [px0, py0, px1, py1] = F.rect(pa0 - 1, b1, pa1 + 1, pb1 + 1);
  const ph = Math.round(pw * 0.22);
  const ped = gableRoof(r, px0, py0, px1, py1, colTop + 8, ph, F.axis('b'), plainRoof(roofC), { ov: 1, gable: (_i, j) => (j < 1 ? trim : T(stoneC)), gWall: ent.g, barge: trim });
  if (ped.gable && lvl >= 2) clockFace(ped.gable, Math.floor(ped.gable.W / 2), 5, 3, 10);
  else if (ped.gable) {
    // coin emblem
    const gi = Math.floor(ped.gable.W / 2);
    ped.gable.rect(gi - 1, 3, 3, 3, P.gold);
    ped.gable.set(gi, 4, shade(P.gold, 0.7));
  }
  // accent banners either side of the portico, accent awnings over ground windows
  if (!failed) {
    const bi0 = pa0 - a0 - 5;
    const bi1 = pa1 - a0 + 2;
    if (bi0 > 1) banner(fr, bi0, colTop + 3, 16, accent);
    if (bi1 + 3 < W - 1) banner(fr, bi1, colTop + 3, 16, accent);
    for (const f of [fr, sd]) {
      const n = Math.max(1, Math.floor((f.W - 4) / 7) + 1);
      const tot = (n - 1) * 7 + 4;
      const i0 = Math.floor((f.W - tot) / 2);
      for (let k = 0; k < n; k++) {
        const i = i0 + k * 7;
        if (f === fr && i + 5 > pa0 - a0 - 1 && i < pa1 - a0 + 1) continue;
        awning(f, i - 1, i + 5, 18, 3, 3, accent, distressed ? null : shade(accent, 1.25), 2, distressed && k % 2 === 0);
      }
    }
  }
  // failed: CLOSED plate on the door shutter + police tape
  if (failed) {
    signBoard(fr, mid - 12, 25, 13, 7, P.white, 'CLOSED', rgb(200, 30, 30), 1, rgb(200, 30, 30));
    const tape = (k: number) => ((k >> 1) % 2 ? P.black : P.yellow);
    for (let k = 0; k < pw + 8; k++) {
      const [x, y] = F.xy(pa0 - 4 + k, pb1 + 5);
      r.dot(x, y, 3, tape(k), r.group());
    }
  }
  // rooftop: skylight lantern and plant, then the flag
  {
    const [kx0, ky0, kx1, ky1] = F.rect(A / 2 - 8, b0 + 10, A / 2 + 8, b0 + 22);
    const gk = r.group();
    r.box(kx0, ky0, H, kx1, ky1, H + 3, trim, null, gk);
    hipRoof(r, kx0, ky0, kx1, ky1, H + 3, 5, (a) => (Math.floor(a) % 3 === 0 ? T(rgb(120, 150, 170)) : T(rgb(160, 196, 214))), { ov: 0 });
    const [ax, ay] = F.xy(a1 - 10, b0 + 8);
    acUnit(r, ax, ay, H, 5);
  }
  // rooftop flag
  const [fx, fy] = F.xy(A / 2, b0 + 6);
  flagpole(r, fx, fy, H, 22, failed ? rgb(110, 110, 114) : accent, failed ? null : P.white);
  // lamps & shrubs
  const [l1x, l1y] = F.xy(pa0 - 8, B - 4);
  const [l2x, l2y] = F.xy(pa1 + 8, B - 4);
  drawLamp(r, l1x, l1y);
  drawLamp(r, l2x, l2y);
  if (!failed) {
    const [hx0, hy0, hx1, hy1] = F.rect(a0, b1 + 1, pa0 - 8, b1 + 4);
    hedge(r, hx0, hy0, hx1, hy1, 3);
    const [gx0, gy0, gx1, gy1] = F.rect(pa1 + 8, b1 + 1, a1, b1 + 4);
    hedge(r, gx0, gy0, gx1, gy1, 3);
  }
}

// ---------------------------------------------------------------------------
// Central bank

export function centralbank(c: Ctx): void {
  const { r, F, s } = c;
  const T = c.tone;
  const A = F.A;
  const B = F.B;
  const sc = A / 96; // scale factor if drawn on a smaller footprint
  const S = (v: number) => Math.round(v * sc);
  const marble = T(hex('#ece6d6'));
  const marbleD = T(hex('#d6ceba'));
  const trim = T(hex('#f6f2e6'));
  const copper = T(hex('#5fae90'));
  const copperD = T(hex('#3f8a70'));

  // plaza: paving, lawns at the front corners
  const pv = pave(c, T(hex('#d8cfbe')), 8);
  const gr = lawn(c);
  F.ground(0, 0, A, B, (a, b) => {
    if (b > S(78) && (a < S(18) || a > A - S(18))) return gr(a, b);
    if (b < S(8) || a < S(5) || a > A - S(5)) return gr(a, b);
    return pv(a, b);
  });

  // podium
  const pa0 = S(8), pa1 = A - S(8), pb0 = S(8), pb1 = S(80);
  castShadow(c, S(12), S(12), A - S(12), S(66), 50);
  F.box(pa0, pb0, 0, pa1, pb1, 6, (_i, j) => (j === 5 ? trim : marbleD), T(shade(hex('#d6ceba'), 1.02)));
  // main block
  const ma0 = S(12), ma1 = A - S(12), mb0 = S(12), mb1 = S(66);
  const H = 52;
  const wall = stone(marble, c.seed, 4, 12);
  const body = F.box(ma0, mb0, 6, ma1, mb1, H, (i, j, f) => (j >= f.hi[i] - 3 ? trim : j < 3 ? marbleD : typeof wall === 'number' ? wall : wall(i, j, f)), null);
  const mr = F.rect(ma0, mb0, ma1, mb1);
  flatRoof(r, mr[0], mr[1], mr[2], mr[3], H, T(rgb(140, 136, 128)), trim, 3);
  // windows: two storeys of tall arched windows
  const ws: WinStyle = { w: 4, h: 10, arch: true, sill: trim };
  const porticoA0 = S(22), porticoA1 = A - S(22);
  windowGrid(body.front, {
    floors: 2,
    floorH: 20,
    j0: 4,
    sill: 4,
    pitch: 8,
    style: ws,
    lit: s.lit,
    seed: c.seed,
    skip: (_f, _b, i) => i + 5 > porticoA0 - ma0 && i < porticoA1 - ma0,
  });
  windowGrid(body.side, { floors: 2, floorH: 20, j0: 4, sill: 4, pitch: 8, style: ws, lit: s.lit, seed: c.seed + 3 });
  // bronze doors behind the colonnade
  const fr = body.front;
  const mid = Math.floor(fr.W / 2);
  c.an.door = drawDoor(fr, mid - 5, 10, 16, T(hex('#8a6a3a')), { double: true, frame: P.gold, knob: true });
  for (const k of [-16, 12]) drawDoor(fr, mid + k, 4, 12, T(hex('#8a6a3a')), { frame: P.gold });

  // portico: 8 columns on the podium, entablature with RESERVE BANK, pediment
  const cb = S(74);
  const colTop = 40;
  const n = 8;
  for (let k = 0; k < n; k++) {
    const a = porticoA0 + 3 + ((porticoA1 - porticoA0 - 6) * k) / (n - 1);
    const [x, y] = F.xy(Math.round(a), cb);
    column(r, x, y, 2, 6, colTop, T(rgb(246, 242, 232)));
  }
  const ent = F.box(porticoA0 - 1, mb1, colTop, porticoA1 + 1, cb + 3, colTop + 10, (_i, j) => (j === 9 ? trim : j === 0 ? marbleD : marble), trim);
  const ef = ent.front;
  const title = 'RESERVE BANK';
  const tw = textBitmap(title).w;
  ef.rect(Math.floor((ef.W - tw) / 2) - 3, 2, tw + 6, 7, T(hex('#e2d8c0')));
  ef.text(title, Math.floor((ef.W - tw) / 2), 7, T(rgb(70, 60, 44)), textBitmap);
  const [ex0, ey0, ex1, ey1] = F.rect(porticoA0 - 1, mb1, porticoA1 + 1, cb + 3);
  const ped = gableRoof(r, ex0, ey0, ex1, ey1, colTop + 10, 14, F.axis('b'), plainRoof(T(rgb(120, 128, 130))), { ov: 1, gable: (_i, j) => (j < 1 ? trim : marble), gWall: ent.g, barge: trim });
  if (ped.gable) {
    // gold coin emblem in the tympanum
    const gf = ped.gable;
    const gi = Math.floor(gf.W / 2);
    const m = gf.bot[gi];
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > 3.3) continue;
        const col = d > 2.4 ? P.goldDark : dx + dy < -1 ? rgb(255, 230, 140) : P.gold;
        gf.r.plot(gf.px(gi + dx), m - 6 + dy, col, gf.depth(gi + dx) + 0.05, gf.g);
      }
    }
    gf.r.plot(gf.px(gi), m - 6, P.goldDark, gf.depth(gi) + 0.06, gf.g);
  }
  // grand steps down from the podium
  const gs = r.group();
  for (let k = 0; k < 3; k++) {
    F.box(porticoA0 - 2 - k * 2, cb + 3, 0, porticoA1 + 2 + k * 2, cb + 3 + (3 - k) * 3 + 1, 6 - k * 2, (_i, j, f) => (j === f.hi[0] - 1 ? trim : marbleD), trim, gs);
  }

  // drum + dome + lantern + flag
  const [dx, dy] = F.xy(A / 2, (mb0 + mb1) / 2 - S(4));
  const R = 15 * sc;
  const gd = r.group();
  r.cylinder(dx, dy, R + 1.5, H, H + 3, trim, trim, gd, 5);
  r.cylinder(dx, dy, R, H + 3, H + 17, (z, t) => {
    const col = Math.round(t * 9);
    if (z > H + 14) return trim;
    if (col % 2 === 0 && z > H + 5 && z < H + 13) return T(rgb(70, 86, 110));
    return col % 2 === 0 ? marble : T(shade(hex('#ece6d6'), 1.05));
  }, null, gd, 5);
  r.ellipsoid(dx, dy, H + 17, R + 1, R + 1, 20 * sc + 4, (x, y) => {
    const ang = Math.atan2(y - dy, x - dx);
    const k = ((ang / (Math.PI * 2)) * 16 + 16) % 1;
    return k < 0.14 ? copperD : copper;
  }, gd, H + 17, 6);
  const topZ = H + 17 + Math.round(20 * sc + 4);
  const gl = r.group();
  r.cylinder(dx, dy, 3, topZ - 2, topZ + 5, (_z, t) => (Math.abs(t) < 0.3 ? T(rgb(70, 86, 110)) : trim), null, gl, 3);
  r.ellipsoid(dx, dy, topZ + 5, 3.5, 3.5, 4, copper, gl, topZ + 5, 4);
  flagpole(r, dx, dy, topZ + 9, 18, hex('#2f7a4a'), P.white);

  // plaza dressing: flagpoles, fountains, lamps, trees
  const [f1x, f1y] = F.xy(S(8), S(84));
  const [f2x, f2y] = F.xy(A - S(8), S(84));
  plant(r, treeArt(1), f1x, f1y);
  plant(r, treeArt(2), f2x, f2y);
  if (A >= 90) {
    const [l1x, l1y] = F.xy(porticoA0 - 6, B - 4);
    const [l2x, l2y] = F.xy(porticoA1 + 6, B - 4);
    drawLamp(r, l1x, l1y);
    drawLamp(r, l2x, l2y);
    const [fl1x, fl1y] = F.xy(S(24), B - 6);
    const [fl2x, fl2y] = F.xy(A - S(24), B - 6);
    flagpole(r, fl1x, fl1y, 0, 30, hex('#2f7a4a'), P.white);
    flagpole(r, fl2x, fl2y, 0, 30, hex('#2f7a4a'), P.white);
    drawFlowers(r, ...F.xy(S(10), B - 10), 2);
    drawFlowers(r, ...F.xy(A - S(10), B - 10), 4);
  }
}

// ---------------------------------------------------------------------------
// City hall

export function cityhall(c: Ctx): void {
  const { r, F, s } = c;
  const T = c.tone;
  const A = F.A;
  const B = F.B;
  const stoneC = T(hex('#ece2c8'));
  const trim = T(hex('#f8f4e8'));
  const roofC = T(hex('#4f6e8a'));
  const pv = pave(c, T(hex('#d6cdbb')), 8);
  const gr = lawn(c);
  F.ground(0, 0, A, B, (a, b) => (b > B - 12 && (a < A / 2 - 12 || a > A / 2 + 12) ? gr(a, b) : b < 6 || a < 4 || a > A - 4 ? gr(a, b) : pv(a, b)));

  const a0 = 6, a1 = A - 6, b0 = 10, b1 = B - 20;
  const H = 32;
  castShadow(c, a0, b0, a1, b1, H);
  const wall = stone(stoneC, c.seed, 4, 10);
  const body = F.box(a0, b0, 0, a1, b1, H, (i, j, f) => (j < 3 ? T(hex('#cfc4a8')) : j >= f.hi[i] - 2 ? trim : j === 15 ? trim : typeof wall === 'number' ? wall : wall(i, j, f)), null);
  const rr = F.rect(a0, b0, a1, b1);
  hipRoof(r, rr[0], rr[1], rr[2], rr[3], H, 10, shingleRoof(roofC, c.seed), { ov: 2 });
  const fr = body.front;
  const mid = Math.floor(fr.W / 2);
  const ws: WinStyle = { w: 3, h: 8, arch: true, sill: trim };
  const porticoW = 38;
  windowGrid(fr, { floors: 2, floorH: 14, j0: 3, sill: 3, pitch: 6, style: ws, lit: s.lit, seed: c.seed, skip: (_f, _b, i) => Math.abs(i + 1 - mid) < porticoW / 2 + 2 });
  windowGrid(body.side, { floors: 2, floorH: 14, j0: 3, sill: 3, pitch: 6, style: ws, lit: s.lit, seed: c.seed + 1 });
  c.an.door = drawDoor(fr, mid - 3, 6, 11, T(hex('#6a4a2a')), { double: true, frame: P.gold });

  // portico with 4 columns and pediment + steps
  const pa0 = Math.floor(A / 2 - porticoW / 2);
  const pa1 = pa0 + porticoW;
  const pb1 = b1 + 7;
  const gsteps = r.group();
  for (let k = 0; k < 2; k++) F.box(pa0 - 4 + k * 2, b1, 0, pa1 + 4 - k * 2, pb1 + 5 - k * 3, 2 * (k + 1), (_i, j, f) => (j === f.hi[0] - 1 ? trim : T(hex('#d8ceb4'))), trim, gsteps);
  for (let k = 0; k < 6; k++) {
    const a = pa0 + 2 + ((porticoW - 4) * k) / 5;
    const [x, y] = F.xy(Math.round(a), pb1 - 2);
    column(r, x, y, 1.3, 4, 24, T(rgb(246, 242, 232)));
  }
  const ent = F.box(pa0 - 1, b1, 24, pa1 + 1, pb1, 29, trim, trim);
  ent.front.text('CITY HALL', Math.floor((ent.front.W - textBitmap('CITY HALL').w) / 2), 5, T(rgb(80, 70, 50)), textBitmap);
  const [ex0, ey0, ex1, ey1] = F.rect(pa0 - 1, b1, pa1 + 1, pb1);
  const cg = gableRoof(r, ex0, ey0, ex1, ey1, 29, 9, F.axis('b'), plainRoof(roofC), { ov: 1, gable: trim, gWall: ent.g, barge: trim });
  if (cg.gable) {
    // city crest in the pediment
    const gi = Math.floor(cg.gable.W / 2);
    cg.gable.rect(gi - 2, 2, 5, 4, T(hex('#3a5aa8')));
    cg.gable.rect(gi - 1, 3, 3, 2, P.gold);
  }

  // clock tower
  const ta0 = A / 2 - 6, ta1 = A / 2 + 6, tb0 = b0 + 8, tb1 = b0 + 20;
  const TH = 76;
  const tw = F.box(ta0, tb0, 0, ta1, tb1, TH, (i, j, f) => {
    if (j >= f.hi[i] - 2 || j === 59 || j === 60) return trim;
    if (j > 60 && j < 70 && i > 2 && i < f.W - 3) return rgb(40, 40, 52); // belfry openings
    return typeof wall === 'number' ? wall : wall(i, j, f);
  }, null);
  for (const f of [tw.front, tw.side]) {
    clockFace(f, Math.floor(f.W / 2), 52, 4, s.variant % 12);
    // belfry arch tops
    f.set(3, 69, trim);
    f.set(f.W - 4, 69, trim);
  }
  const tr = F.rect(ta0, tb0, ta1, tb1);
  flatRoof(r, tr[0] - 1, tr[1] - 1, tr[2] + 1, tr[3] + 1, TH, trim, null);
  const [cx, cy] = F.xy(A / 2, (tb0 + tb1) / 2);
  const gd = r.group();
  r.ellipsoid(cx, cy, TH, 6, 6, 9, (x, y) => (Math.floor((Math.atan2(y - cy, x - cx) / Math.PI) * 6 + 12) % 2 ? T(hex('#5fae90')) : T(hex('#4f9a7e'))), gd, TH, 5);
  r.pole(cx, cy, TH + 9, TH + 14, P.gold, gd);
  flagpole(r, cx, cy, TH + 13, 12, hex('#c83a3a'), P.white);
  // plaza: flagpoles and trees
  const [q1x, q1y] = F.xy(pa0 - 8, B - 5);
  const [q2x, q2y] = F.xy(pa1 + 8, B - 5);
  flagpole(r, q1x, q1y, 0, 26, hex('#3a5aa8'), P.white);
  flagpole(r, q2x, q2y, 0, 26, hex('#3a5aa8'), P.white);
  plant(r, treeArt(1), ...F.xy(4, B - 5));
  plant(r, treeArt(0), ...F.xy(A - 4, B - 5));
}
