// Office buildings (2x2, level 1..4 => 3, 5, 8, 12 storeys) and the investment fund
// glass tower with its rooftop LED ticker.

import { type Col, P, hex, rgb, shade, mix, emissive, cr, cg } from '../color';
import { Face, type WallPaint } from '../raster';
import { flatRoof, drawDoor, slab, signBoard, acUnit, antenna, hedge, isLit, brick, drawWindow, cornice } from '../kit';
import { plant, treeArt, drawLamp, drawBench } from '../props';
import { type Ctx, vpick, vchance, pave, castShadow } from './common';
import { gravel, membrane } from '../textures';
import { h01 } from '../rng';
import { textBitmap, fitText } from '../font';

type Mode = 'normal' | 'closed' | 'dark';

/** Glass curtain wall: spandrel bands per floor, mullions, diagonal reflections, lit bays. */
function curtainWall(glass: Col, frame: Col, fh: number, j0: number, seed: number, lit: number, mode: Mode, axis: string, bay = 4): WallPaint {
  const spandrel = shade(frame, 0.9);
  const hi = mix(glass, rgb(220, 236, 246), 0.35);
  const hi2 = mix(glass, rgb(220, 236, 246), 0.18);
  const litC = emissive(P.glassLit);
  const litHi = emissive(P.glassLitHi);
  const dark = shade(glass, 0.6);
  return (i, j) => {
    if (j < j0) return frame;
    const jj = j - j0;
    const fl = Math.floor(jj / fh);
    const r = jj % fh;
    if (r < 2) return spandrel;
    if (i % bay === 0) return frame;
    const b = Math.floor(i / bay);
    if (mode === 'dark' || (mode === 'closed' && h01(seed, fl, b, 3) < 0.8)) return r === fh - 1 ? shade(dark, 1.1) : dark;
    if (mode === 'normal' && isLit(seed, axis, fl, b, lit)) return r === fh - 1 ? litHi : litC;
    const d = (i + jj * 2 + (seed & 7)) % 47;
    if (d < 3) return hi;
    if (d < 6) return hi2;
    return r === fh - 1 ? shade(glass, 1.08) : glass;
  };
}

/** Concrete frame grid with recessed windows. */
function gridWall(conc: Col, glass: Col, fh: number, j0: number, seed: number, lit: number, mode: Mode, axis: string): WallPaint {
  const recess = shade(conc, 0.82);
  return (i, j) => {
    if (j < j0) return conc;
    const jj = j - j0;
    const fl = Math.floor(jj / fh);
    const r = jj % fh;
    const col = i % 7;
    if (r < 3 || col < 2) return r === 3 || col === 2 ? recess : conc;
    if (col === 2 || r === 3) return recess;
    const b = Math.floor(i / 7);
    if (mode === 'dark' || (mode === 'closed' && h01(seed, fl, b) < 0.8)) return P.glassDark;
    if (mode === 'normal' && isLit(seed, axis, fl, b, lit)) return emissive(r === fh - 1 ? P.glassLitHi : P.glassLit);
    return r === fh - 1 ? P.glassDayHi : (i + r) % 6 === 0 ? mix(glass, P.glassDayHi, 0.4) : glass;
  };
}

/** Ribbon windows: horizontal concrete bands alternating with glass strips. */
function bandWall(conc: Col, glass: Col, fh: number, j0: number, seed: number, lit: number, mode: Mode, axis: string): WallPaint {
  return (i, j) => {
    if (j < j0) return conc;
    const jj = j - j0;
    const fl = Math.floor(jj / fh);
    const r = jj % fh;
    if (r < 5) return r === 4 ? shade(conc, 1.06) : conc;
    const b = Math.floor(i / 6);
    if (i % 6 === 0) return shade(glass, 0.7);
    if (mode === 'dark' || (mode === 'closed' && h01(seed, fl, b) < 0.8)) return P.glassDark;
    if (mode === 'normal' && isLit(seed, axis, fl, b, lit)) return emissive(P.glassLit);
    return r === fh - 1 ? P.glassDayHi : glass;
  };
}

const GLASS = [hex('#4f8f9e'), hex('#4a6a9e'), hex('#5a8c72'), hex('#8a7456'), hex('#3e5470'), hex('#6f8fb0')];

export function office(c: Ctx): void {
  const { r, F, s } = c;
  const T = c.tone;
  const lvl = s.level;
  const floors = [3, 5, 8, 12][lvl - 1];
  const fh = 13;
  const A = F.A;
  const B = F.B;
  const closed = s.state === 'closed';
  const mode: Mode = closed ? 'closed' : 'normal';
  const style = lvl <= 2 ? vpick(c, ['glass', 'grid', 'brick', 'bands'] as const, 1) : vpick(c, ['glass', 'grid', 'glass', 'bands'] as const, 1);
  const glass = T(vpick(c, GLASS, 2));
  const conc = T(vpick(c, [hex('#d8d4ca'), hex('#c4c8cc'), hex('#e0d6c0'), hex('#b8b4ac')], 3));
  const frame = T(vpick(c, [hex('#3a4450'), hex('#5a646e'), hex('#d0d0d4'), hex('#2e3a34')], 4));
  const lobbyH = 16;

  // plaza lot with planters
  const pv = pave(c, T(hex('#cfc6b4')), 8);
  F.ground(0, 0, A, B, pv);

  const makePaint = (j0: number): WallPaint => {
    if (style === 'glass') return curtainWall(glass, frame, fh, j0, c.seed, s.lit, mode, 'x');
    if (style === 'grid') return gridWall(conc, glass, fh, j0, c.seed, s.lit, mode, 'x');
    if (style === 'bands') return bandWall(conc, glass, fh, j0, c.seed, s.lit, mode, 'x');
    return brick(T(vpick(c, [hex('#a8604a'), hex('#8e4636'), hex('#b8784a')], 5)), c.seed);
  };

  const tall = lvl >= 3;
  // podium (lobby) for all: glass-fronted ground floor
  const pa0 = tall ? 4 : 6;
  const pa1 = A - (tall ? 4 : 6);
  const pb0 = tall ? 4 : 6;
  const pb1 = B - (tall ? 10 : 12);
  const podiumFloors = tall ? 2 : 0;
  const lobbyTop = lobbyH + podiumFloors * fh;
  const upper = makePaint(lobbyH);
  const lobbyPaint: WallPaint = (i, j, f) => {
    if (j < 2) return T(rgb(90, 90, 96));
    if (j >= lobbyH - 2 && j < lobbyH) return frame;
    if (j >= lobbyH) return typeof upper === 'number' ? upper : upper(i, j, f);
    if (i % 6 === 0) return frame;
    if (closed) return j < 11 ? ((j >> 1) % 2 ? shade(P.plank, 0.85) : P.plank) : P.glassDark;
    if (s.lit > 0) return emissive(j > 11 ? P.glassLitHi : rgb(250, 226, 160));
    return j > 11 ? P.glassDayHi : mix(glass, P.glassDayHi, 0.3);
  };
  castShadow(c, pa0, pb0, pa1, pb1, 40);
  const base = F.box(pa0, pb0, 0, pa1, pb1, tall ? lobbyTop : lobbyH, lobbyPaint, null);
  let topZ: number;
  let roofRect: [number, number, number, number];
  let towerFaces: { front: Face; side: Face };
  if (tall) {
    const pr = F.rect(pa0, pb0, pa1, pb1);
    flatRoof(r, pr[0], pr[1], pr[2], pr[3], lobbyTop, (x, y) => gravel(x, y, c.seed, T(rgb(126, 124, 120))), frame, 2);
    // tower
    const ta0 = 12, ta1 = A - 12, tb0 = 9, tb1 = B - 18;
    const H = lobbyTop + (floors - podiumFloors - 1) * fh + 3;
    const paint = makePaint(lobbyTop);
    const t = F.box(ta0, tb0, lobbyTop, ta1, tb1, H, (i, j, f) => (j >= f.hi[i] - 2 ? frame : typeof paint === 'number' ? paint : paint(i, j + lobbyTop, f)), null);
    towerFaces = t;
    topZ = H;
    roofRect = F.rect(ta0, tb0, ta1, tb1);
  } else {
    const H = lobbyH + (floors - 1) * fh + 3;
    const paint = makePaint(lobbyH);
    // re-draw the upper part of the same box with the office wall paint
    const t = F.box(pa0, pb0, lobbyH, pa1, pb1, H, (i, j, f) => (j >= f.hi[i] - 2 ? (style === 'brick' ? T(rgb(226, 220, 204)) : frame) : typeof paint === 'number' ? paint : paint(i, j + lobbyH, f)), null, base.g);
    towerFaces = t;
    topZ = H;
    roofRect = F.rect(pa0, pb0, pa1, pb1);
    if (style === 'brick') {
      // punched windows for brick offices
      for (const f of [t.front, t.side]) {
        for (let fl = 0; fl < floors - 1; fl++) {
          for (let i = 3; i + 4 < f.W - 1; i += 7) {
            const st = closed ? 'dark' : isLit(c.seed, f.axis, fl, i, s.lit) ? 'lit' : 'day';
            drawWindow(f, i, 4 + fl * fh, { w: 4, h: 7, sill: T(rgb(226, 220, 204)), mullion: true, frame: T(rgb(236, 232, 222)) }, st);
          }
        }
      }
      cornice(r, roofRect[0], roofRect[1], roofRect[2], roofRect[3], topZ - 2, 2, T(rgb(226, 220, 204)));
    }
  }
  flatRoof(r, roofRect[0], roofRect[1], roofRect[2], roofRect[3], topZ, (x, y) => membrane(x, y, c.seed + 1, T(rgb(122, 120, 118))), frame, 2);

  // lobby entrance & canopy on the front
  const fr = base.front;
  const mid = Math.floor(fr.W / 2);
  c.an.door = drawDoor(fr, mid - 4, 8, 11, T(rgb(70, 76, 84)), { glass: !closed, double: true, frame, boarded: closed, lit: !closed && s.lit > 0 });
  slab(fr, mid - 8, mid + 8, 7, 12, 2, T(frame));
  if (s.sign && !closed) {
    const txt = fitText(s.sign, fr.W - 8);
    const w = textBitmap(txt).w + 5;
    signBoard(fr, Math.floor((fr.W - w) / 2), w, lobbyH - 2, 7, T(rgb(40, 44, 52)), txt, P.white, 1, frame);
  }

  // rooftop details
  const [rx0, ry0, rx1, ry1] = roofRect;
  const g = r.group();
  const pw = Math.min(16, (rx1 - rx0) / 2);
  r.box(rx0 + 5, ry0 + 5, topZ, rx0 + 5 + pw, ry0 + 5 + pw * 0.7, topZ + 9, T(shade(conc, 0.95)), T(rgb(140, 138, 134)), g);
  acUnit(r, rx1 - 12, ry1 - 12, topZ, 6);
  acUnit(r, rx1 - 20, ry1 - 10, topZ, 6);
  if (lvl >= 2) antenna(r, rx0 + 8, ry0 + 8, topZ + 9, lvl === 4 ? 26 : 14);
  if (lvl === 4 && vchance(c, 0.5, 9)) {
    // helipad
    const cx = (rx0 + rx1) / 2 + 4;
    const cy = (ry0 + ry1) / 2 + 4;
    r.disc(cx, cy, 8, topZ + 1, (x, y) => {
      const d = Math.hypot(x - cx, y - cy);
      if (d > 6.8) return T(P.yellow);
      const u = x - cx;
      const v = y - cy;
      const onH = (Math.abs(u) < 3.5 && Math.abs(Math.abs(v) - 2.5) < 0.7) || (Math.abs(v) < 0.7 && Math.abs(u) < 3.5);
      return onH ? P.white : rgb(70, 74, 80);
    }, r.group());
  }

  // closed: FOR LEASE banner across an upper floor
  if (closed) {
    const f = towerFaces.front;
    const w = Math.min(f.W - 4, 39);
    const j = (tall ? lobbyTop : lobbyH) + 6;
    signBoard(f, Math.floor((f.W - w) / 2), w, j, 7, P.white, 'FOR LEASE', rgb(200, 40, 40), 1, rgb(200, 40, 40));
  }

  // plaza dressing: planters and trees at the front corners
  const [t1x, t1y] = F.xy(4, B - 5);
  const [t2x, t2y] = F.xy(A - 5, B - 5);
  if (!closed) {
    plant(r, treeArt(c.seed % 3), t1x, t1y);
    plant(r, treeArt(1 + (c.seed % 2)), t2x, t2y);
    const [hx0, hy0, hx1, hy1] = F.rect(12, B - 7, 22, B - 4);
    hedge(r, hx0, hy0, hx1, hy1, 3);
    const [bx, by] = F.xy(A - 18, B - 4);
    drawBench(r, bx, by, F.front === 'right');
  }
  const [lx, ly] = F.xy(A - 2, B - 2);
  drawLamp(r, lx, ly);
}

// ---------------------------------------------------------------------------
// Investment fund tower

export function fund(c: Ctx): void {
  const { r, F, s } = c;
  const T = c.tone;
  const A = F.A;
  const B = F.B;
  const closed = s.state === 'closed' || s.state === 'failed';
  const floors = 11;
  const fh = 13;
  const glass = T(hex('#243650'));
  const frame = T(hex('#46566e'));
  const accent = c.accent;
  const pv = pave(c, T(hex('#bdb6aa')), 8);
  const dark = T(hex('#9a948a'));
  F.ground(0, 0, A, B, (a, b) => {
    const d = Math.max(Math.abs(a - A / 2), Math.abs(b - B / 2 + 3));
    return d > 24 && d < 26 ? dark : pv(a, b);
  });
  // lobby podium
  castShadow(c, 8, 8, A - 8, B - 12, 40);
  const lobby = F.box(8, 8, 0, A - 8, B - 12, 16, (i, j) => {
    if (j < 2) return T(rgb(60, 62, 70));
    if (j >= 14) return frame;
    if (i % 5 === 0) return frame;
    if (closed) return P.glassDark;
    return s.lit > 0 ? emissive(rgb(250, 230, 170)) : j > 10 ? mix(glass, P.glassDayHi, 0.6) : mix(glass, P.glassDayHi, 0.35);
  }, null);
  const pr = F.rect(8, 8, A - 8, B - 12);
  flatRoof(r, pr[0], pr[1], pr[2], pr[3], 16, T(rgb(90, 92, 100)), frame, 1);
  const fr = lobby.front;
  const mid = Math.floor(fr.W / 2);
  c.an.door = drawDoor(fr, mid - 4, 8, 11, T(rgb(40, 44, 52)), { glass: !closed, double: true, frame, lit: !closed && s.lit > 0, boarded: false });
  slab(fr, mid - 9, mid + 9, 6, 13, 1, T(rgb(40, 44, 52)));
  if (s.sign) {
    const txt = fitText(s.sign, fr.W - 8);
    const w = textBitmap(txt).w + 5;
    signBoard(fr, Math.floor((fr.W - w) / 2), w, 14, 7, T(rgb(24, 26, 32)), txt, closed ? rgb(120, 120, 120) : P.gold, 1, T(frame));
  }
  // tower shaft
  const ta0 = 14, ta1 = A - 14, tb0 = 12, tb1 = B - 18;
  const z0 = 16;
  const H = z0 + floors * fh;
  const tickerJ = floors * fh - 12;
  const cw = curtainWall(glass, frame, fh, 0, c.seed, s.lit * 0.8, closed ? 'dark' : 'normal', 'x', 3);
  const shaft = F.box(ta0, tb0, z0, ta1, tb1, H, (i, j, f) => {
    if (j >= tickerJ - 1 && j < tickerJ + 9) return T(rgb(20, 22, 28));
    // mechanical floors every fourth storey: lighter louvre band
    if (Math.floor(j / fh) % 4 === 3 && j % fh < 3) return (i & 1) === 0 ? shade(frame, 1.25) : shade(frame, 1.1);
    // vertical fins at the corners
    if (i < 2 || i >= f.W - 2) return shade(frame, 1.15);
    return typeof cw === 'number' ? cw : cw(i, j, f);
  }, null);
  // LED ticker band (accent colour) wrapping both faces: index moves + arrows
  const up = cr(accent) <= cg(accent);
  const ledOn = emissive(accent);
  const ledDim = shade(accent, 0.35);
  const figs = up ? ['+2.4%', '+1.1%'] : ['-3.2%', '-1.7%'];
  ([[shaft.front, figs[0]], [shaft.side, figs[1]]] as [Face, string][]).forEach(([f, msg]) => {
    for (let i = 2; i < f.W - 2; i++) {
      f.set(i, tickerJ + 8, ledDim);
      f.set(i, tickerJ, ledDim);
    }
    if (closed) return;
    const tw = textBitmap(msg).w;
    const total = tw + 7;
    const i0 = Math.max(2, Math.floor((f.W - total) / 2));
    f.text(msg, i0, tickerJ + 6, ledOn, textBitmap);
    // arrow glyph after the figure
    const ai = i0 + tw + 4;
    for (let k = 0; k < 3; k++) {
      const jj = up ? tickerJ + 6 - k : tickerJ + 2 + k;
      for (let q = -(2 - k); q <= 2 - k; q++) f.set(ai + q, jj, ledOn);
    }
    f.set(ai, up ? tickerJ + 2 : tickerJ + 6, ledOn);
  });
  // crown: stepped top, spire and beacon
  const rr = F.rect(ta0, tb0, ta1, tb1);
  flatRoof(r, rr[0], rr[1], rr[2], rr[3], H, T(rgb(70, 74, 84)), frame, 2);
  const cr0 = F.rect(ta0 + 6, tb0 + 6, ta1 - 6, tb1 - 6);
  r.box(cr0[0], cr0[1], H, cr0[2], cr0[3], H + 10, (_i, j) => (j % 4 === 3 ? shade(frame, 1.15) : T(hex('#1c2a40'))), T(rgb(60, 64, 76)));
  const cx = (rr[0] + rr[2]) / 2;
  const cy = (rr[1] + rr[3]) / 2;
  const gs = r.group();
  r.box(cx - 1, cy - 1, H + 10, cx + 1, cy + 1, H + 30, T(rgb(190, 196, 206)), T(rgb(220, 224, 230)), gs);
  r.dot(cx, cy, H + 31, emissive(rgb(255, 60, 50)), gs);
  // plaza
  if (!closed) {
    const [t1x, t1y] = F.xy(4, B - 4);
    plant(r, treeArt(1), t1x, t1y);
    const [t2x, t2y] = F.xy(A - 4, B - 4);
    plant(r, treeArt(2), t2x, t2y);
  }
  const [lx, ly] = F.xy(A / 2 + 14, B - 3);
  drawLamp(r, lx, ly);
}
