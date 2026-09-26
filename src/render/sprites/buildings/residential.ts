// Houses (1x1) and apartment blocks (2x2).

import { P, WALLS, ROOFS, hex, rgb, shade } from '../color';
import {
  brick,
  siding,
  plaster,
  concreteWall,
  drawWindow,
  drawDoor,
  gableRoof,
  hipRoof,
  flatRoof,
  shingleRoof,
  tileRoof,
  chimney,
  fence,
  windowGrid,
  isLit,
  awning,
  slab,
  balcony,
  acUnit,
  waterTank,
  roofHousing,
  type WinStyle,
  type WinState,
  type RoofMat,
} from '../kit';
import { plant, treeArt, bushArt, pineArt, drawBench } from '../props';
import { type Ctx, vpick, vchance, lawn, pave, castShadow, DOOR_COLS } from './common';
import { membrane } from '../textures';
import { h01 } from '../rng';

// ---------------------------------------------------------------------------
// House

export function house(c: Ctx): void {
  const { r, F, s } = c;
  const vacant = s.state === 'vacant';
  const lvl = Math.min(2, Math.max(1, s.level));
  const A = F.A;
  const B = F.B;
  const T = c.tone;
  const cx = A / 2;

  const material = vpick(c, ['siding', 'plaster', 'brick', 'siding', 'plaster'] as const, 5);
  let wallBase = vpick(c, WALLS, 1);
  if (material === 'brick') wallBase = vpick(c, [hex('#b35a40'), hex('#a8604a'), hex('#c07a52'), hex('#9c4c3c')], 6);
  const wall = T(wallBase);
  const roofC = T(vpick(c, ROOFS, 2));
  const trim = T(P.white);
  const doorC = T(vpick(c, DOOR_COLS, 3));
  const roofType = vpick(c, ['gableA', 'gableB', 'hip', 'gableA', 'gableB'] as const, 4);
  const wallPaint = material === 'siding' ? siding(wall) : material === 'brick' ? brick(wall, c.seed) : plaster(wall, c.seed);
  const roofMat: RoofMat = vchance(c, 0.35, 8) ? tileRoof(roofC) : shingleRoof(roofC, c.seed);

  const garage = lvl === 2 && vchance(c, 0.5, 9) && A >= 32;
  const porch = vchance(c, 0.55, 10);
  const hasFence = vchance(c, 0.55, 11);
  const shutters = vchance(c, 0.4, 12) ? T(vpick(c, [hex('#3f6b4a'), hex('#2f4a6a'), hex('#7a3a32'), hex('#4a4a52')], 13)) : null;

  // body layout (local units)
  const wallH = lvl === 1 ? 14 : 27;
  const ha0 = garage ? cx - 12 : cx - 11;
  const ha1 = garage ? cx + 5 : cx + 11;
  const hb0 = Math.max(4, B / 2 - 11);
  const hb1 = hb0 + (lvl === 1 ? 16 : 15);
  const ga0 = ha1;
  const ga1 = ha1 + 10;

  // door column choice
  const W = ha1 - ha0;
  const bay = vpick(c, [0, 1, 1, 2], 14);
  const bays = [Math.round(W / 6), Math.round(W / 2), Math.round((5 * W) / 6)];
  const dA = ha0 + bays[bay];

  // --- lot
  const pathA0 = dA - 2;
  const pathA1 = dA + 2;
  const grassPaint = lawn(c, vacant ? 0.85 : 0);
  const pathPaint = pave(c, T(rgb(200, 192, 176)), 4);
  const drivePaint = pave(c, T(rgb(176, 172, 164)), 16);
  F.ground(0, 0, A, B, (a, b) => {
    if (b >= hb1 && a >= pathA0 && a < pathA1) return pathPaint(a, b);
    if (garage && b >= hb1 - 1 && a >= ga0 + 1 && a < ga1 - 1) return drivePaint(a, b);
    return grassPaint(a, b);
  });

  castShadow(c, ha0, hb0, ha1, hb1, wallH + 10);
  if (garage) castShadow(c, ga0, hb0 + 3, ga1, hb1, 13);

  // --- main body
  const body = F.box(ha0, hb0, 0, ha1, hb1, wallH, (i, j, f) => (j <= 1 ? shade(T(rgb(150, 144, 136)), 1) : typeof wallPaint === 'number' ? wallPaint : wallPaint(i, j, f)), null);
  const [x0, y0, x1, y1] = F.rect(ha0, hb0, ha1, hb1);

  // --- roof
  let ridgeZ = wallH;
  const bargeC = roofType === 'gableB' ? trim : shade(roofC, 0.8);
  if (roofType === 'hip') {
    const h = 10;
    hipRoof(r, x0, y0, x1, y1, wallH, h, roofMat, { ov: 2 });
    ridgeZ += h;
  } else {
    const axis = roofType === 'gableA' ? F.axis('a') : F.axis('b');
    const half = axis === 'x' ? (y1 - y0) / 2 : (x1 - x0) / 2;
    const h = Math.round(half * 1.3);
    const res = gableRoof(r, x0, y0, x1, y1, wallH, h, axis, roofMat, { ov: 2, barge: bargeC, gable: wallPaint, gWall: body.g });
    ridgeZ += h;
    // attic window in the visible gable
    if (res.gable) {
      const gi = Math.floor(res.gable.W / 2) - 1;
      drawWindow(res.gable, gi, 3, { w: 3, h: 3, sill: trim }, vacant ? 'dark' : isLit(c.seed, 'G', 9, 0, s.lit) ? 'lit' : 'day');
    }
  }

  // --- windows & door
  const winState = (fl: number, k: number, face: string): WinState =>
    vacant ? 'dark' : isLit(c.seed, face, fl, k, s.lit) ? 'lit' : 'day';
  const st: WinStyle = { w: 3, h: 5, sill: trim, shutters };
  const fr = body.front;
  const doorI = dA - ha0 - 2;
  c.an.door = drawDoor(fr, doorI, 4, 8, doorC, { frame: trim, lit: !vacant && s.lit >= 0.5 });
  bays.forEach((bi, k) => {
    if (k !== bay) drawWindow(fr, bi - 1, 4, st, winState(0, k, 'L'));
    if (lvl === 2) drawWindow(fr, bi - 1, 17, st, winState(1, k, 'L'));
  });
  const sd = body.side;
  const sideBays = sd.W >= 14 ? [Math.round(sd.W / 3) - 1, Math.round((2 * sd.W) / 3) - 2] : [Math.round(sd.W / 2) - 1];
  sideBays.forEach((bi, k) => {
    drawWindow(sd, bi, 4, st, winState(0, k + 5, 'R'));
    if (lvl === 2) drawWindow(sd, bi, 17, st, winState(1, k + 5, 'R'));
  });

  // --- garage
  if (garage) {
    const gH = 13;
    const gw = F.box(ga0, hb0 + 3, 0, ga1, hb1, gH, (i, j, f) => (j <= 1 ? T(rgb(150, 144, 136)) : typeof wallPaint === 'number' ? wallPaint : wallPaint(i, j, f)), null);
    const [gx0, gy0, gx1, gy1] = F.rect(ga0, hb0 + 3, ga1, hb1);
    flatRoof(r, gx0, gy0, gx1, gy1, gH, T(shade(roofC, 0.9)), trim, 1);
    const gf = gw.front;
    const gdw = gf.W - 3;
    for (let a = 0; a < gdw; a++) for (let b = 0; b < 9; b++) gf.set(1 + a + 0, b, b % 2 === 1 ? T(rgb(214, 210, 200)) : T(rgb(236, 232, 222)));
    gf.rect(1, 9, gdw, 1, trim);
  }

  // --- porch
  if (porch) {
    const pa0 = dA - 6;
    const pa1 = dA + 6;
    const pd = 5;
    const g = r.group();
    F.box(pa0, hb1, 0, pa1, hb1 + pd, 2, T(rgb(170, 160, 150)), T(P.woodLight), g);
    for (const pa of [pa0, pa1 - 1]) F.box(pa, hb1 + pd - 1, 2, pa + 1, hb1 + pd, 11, trim, trim, g);
    const pz = lvl === 1 ? 13 : 13;
    const P1 = F.pt(pa0 - 1, hb1, pz + 1);
    const P2 = F.pt(pa1 + 1, hb1, pz + 1);
    const P3 = F.pt(pa1 + 1, hb1 + pd + 1, pz - 2);
    const P4 = F.pt(pa0 - 1, hb1 + pd + 1, pz - 2);
    r.plane([P1, P2, P3, P4], (x, y, z) => roofMat(F.front === 'left' ? x : y, z + 1), r.group());
  }

  // --- chimney (a 4x4 unit stack on the back half of the roof)
  if (vchance(c, 0.6, 15)) {
    const ca = vchance(c, 0.5, 16) ? ha0 + 3 : ha1 - 7;
    const [cx0, cy0] = F.rect(ca, hb0 + 4, ca + 4, hb0 + 8);
    chimney(r, cx0, cy0, wallH, ridgeZ + 3, T(rgb(150, 80, 64)));
  }

  // --- garden
  const sideA = F.front === 'left' ? A - 4 : 4;
  if (!vacant) {
    if (vchance(c, 0.8, 17)) {
      const [bx, by] = F.xy(ha0 + 2, hb1 + 2);
      if (Math.abs(ha0 + 2 - dA) > 7) plant(r, bushArt(c.seed % 8), bx, by);
    }
    if (vchance(c, 0.8, 18)) {
      const [bx, by] = F.xy(ha1 - 3, hb1 + 2);
      if (Math.abs(ha1 - 3 - dA) > 7 && !garage) plant(r, bushArt((c.seed >> 3) % 8), bx, by);
    }
  }
  const treeSpot = vpick(c, ['back', 'side', 'none', 'side', 'back'] as const, 19);
  if (treeSpot === 'back') {
    const [tx, ty] = F.xy(F.front === 'left' ? 5 : A - 5, 4);
    plant(r, vacant ? treeArt(5) : treeArt(c.seed % 14), tx, ty);
  } else if (treeSpot === 'side' && !garage) {
    const [tx, ty] = F.xy(sideA, hb0 + 4);
    plant(r, vchance(c, 0.3, 20) ? pineArt(c.seed % 6) : treeArt((c.seed >> 2) % 14), tx, ty);
  }
  // fence along the front edge with gaps for path/driveway
  if (hasFence) {
    const fc = T(vchance(c, 0.6, 21) ? P.white : P.woodLight);
    const segs: [number, number][] = [];
    let start = 1;
    const gaps: [number, number][] = [[pathA0 - 1, pathA1 + 1]];
    if (garage) gaps.push([ga0, ga1]);
    gaps.sort((p, q) => p[0] - q[0]);
    for (const [g0, g1] of gaps) {
      if (g0 > start) segs.push([start, g0]);
      start = Math.max(start, g1);
    }
    if (start < A - 1) segs.push([start, A - 1]);
    for (const [s0, s1] of segs) {
      if (vacant && h01(c.seed, s0) < 0.5) continue;
      const [fx0, fy0] = F.xy(s0, B - 1.5);
      const [fx1, fy1] = F.xy(s1, B - 1.5);
      fence(r, Math.min(fx0, fx1), Math.min(fy0, fy1), Math.max(fx0, fx1), Math.max(fy0, fy1), fc);
    }
  }
  // mailbox by the path
  {
    const [mx, my] = F.xy(pathA1 + 2, B - 3);
    const g = r.group();
    r.pole(mx, my, 0, 5, P.woodDark, g, false);
    r.box(mx - 1, my - 1.5, 5, mx + 1, my + 1.5, 7, T(vpick(c, [P.steel, hex('#3a5a8a'), hex('#8a3a32')], 22)), T(P.steelLight), g);
  }
}

// ---------------------------------------------------------------------------
// Apartment block

export function apartment(c: Ctx): void {
  const { r, F, s } = c;
  const T = c.tone;
  const lvl = Math.min(4, Math.max(1, s.level));
  const floors = [2, 3, 4, 6][lvl - 1];
  const fh = 14;
  const A = F.A;
  const B = F.B;
  const style = vpick(c, ['brick', 'concrete', 'stucco', 'brick'] as const, 1);
  const wallBase =
    style === 'brick'
      ? vpick(c, [hex('#a84e3a'), hex('#b8664a'), hex('#8e4636'), hex('#c07850')], 2)
      : style === 'concrete'
        ? vpick(c, [hex('#cfcbc0'), hex('#bfc4c6'), hex('#d8d0c0')], 2)
        : vpick(c, [hex('#e8d4a8'), hex('#e2b8a0'), hex('#c8d8c0'), hex('#b8cce0')], 2);
  const wall = T(wallBase);
  const trim = T(style === 'brick' ? rgb(232, 226, 210) : style === 'concrete' ? rgb(150, 150, 146) : rgb(246, 242, 232));
  const accent = T(vpick(c, [hex('#d8703c'), hex('#3c8ab8'), hex('#5aa060'), hex('#c85a6a'), hex('#e0b040')], 3));
  const base = T(style === 'brick' ? rgb(120, 110, 104) : rgb(140, 136, 128));

  const a0 = 6, a1 = A - 6, b0 = 8, b1 = B - 10;
  const H = floors * fh + 3;
  const paint =
    style === 'brick' ? brick(wall, c.seed) : style === 'concrete' ? concreteWall(wall, 18, fh, 0) : plaster(wall, c.seed);

  // lot: paved forecourt, lawn strips at the back/sides
  const pv = pave(c, T(P.paving));
  const gr = lawn(c, s.state === 'vacant' ? 0.8 : 0);
  F.ground(0, 0, A, B, (a, b) => (b > b1 - 2 || a < 3 || a > A - 3 ? pv(a, b) : gr(a, b)));
  castShadow(c, a0, b0, a1, b1, H);

  const body = F.box(a0, b0, 0, a1, b1, H, (i, j, f) => {
    if (j < 3) return base;
    if (j >= H - 2) return trim;
    if (style === 'brick' && (j - 3) % fh === fh - 1) return trim; // floor bands
    return typeof paint === 'number' ? paint : paint(i, j, f);
  }, null);
  const [x0, y0, x1, y1] = F.rect(a0, b0, a1, b1);
  flatRoof(r, x0, y0, x1, y1, H, (x, y) => membrane(x, y, c.seed, T(rgb(124, 118, 112))), trim, 2);

  const vacantish = s.state === 'vacant';
  const winSt: WinStyle =
    style === 'concrete' ? { w: 4, h: 6, frame: null, sill: null, glass: P.glassDay } : { w: 3, h: 6, sill: trim, lintel: style === 'brick' ? T(rgb(214, 204, 186)) : null };
  const pitch = style === 'concrete' ? 7 : 6;
  // front: entrance in the middle bay
  const fr = body.front;
  const mid = Math.floor(fr.W / 2);
  windowGrid(fr, {
    floors,
    floorH: fh,
    j0: 3,
    sill: 4,
    pitch,
    style: winSt,
    lit: s.lit,
    seed: c.seed,
    mode: vacantish ? 'dark' : 'normal',
    skip: (fl, _b, i) => fl === 0 && i + winSt.w > mid - 8 && i < mid + 8,
  });
  windowGrid(body.side, { floors, floorH: fh, j0: 3, sill: 4, pitch, style: winSt, lit: s.lit, seed: c.seed + 1, mode: vacantish ? 'dark' : 'normal' });

  // entrance: glass double door + canopy
  c.an.door = drawDoor(fr, mid - 3, 6, 10, T(rgb(80, 70, 60)), { glass: true, double: true, frame: trim, lit: s.lit > 0.4 && !vacantish });
  slab(fr, mid - 6, mid + 6, 5, 12, 2, accent);
  // balconies on concrete/stucco blocks
  if (style !== 'brick' && floors >= 3) {
    const bays = Math.floor((fr.W - 6) / (pitch * 2));
    for (let fl = 1; fl < floors; fl++) {
      for (let k = 0; k < bays; k++) {
        const i0 = 4 + k * pitch * 2;
        if (Math.abs(i0 + pitch - mid) < 4) continue;
        balcony(fr, i0 - 1, i0 + pitch + 1, 3 + fl * fh, 4, T(rgb(200, 196, 188)), style === 'concrete' ? accent : T(rgb(236, 232, 224)));
      }
    }
  }
  // brick blocks: fire escape-ish awnings over ground windows and a name band
  if (style === 'brick') {
    awning(fr, mid - 7, mid + 7, 13, 4, 3, accent, T(P.white), 2);
  }
  // rooftop
  const [rx, ry] = F.xy(a0 + 12, b0 + 12);
  if (style === 'brick' || vchance(c, 0.4, 7)) waterTank(r, rx, ry, H, 5, 8);
  else roofHousing(r, rx - 6, ry - 5, rx + 5, ry + 5, H, 9, T(rgb(176, 172, 164)), T(rgb(140, 136, 130)));
  const [qx, qy] = F.xy(a1 - 14, b0 + 20);
  acUnit(r, qx, qy, H, 6);
  const [q2x, q2y] = F.xy(a1 - 24, b0 + 10);
  acUnit(r, q2x, q2y, H, 5);
  // forecourt dressing
  if (s.state !== 'vacant') {
    const [t1x, t1y] = F.xy(3, B - 5);
    plant(r, treeArt(c.seed % 14), t1x, t1y);
    const [bx, by] = F.xy(A - 12, B - 4);
    drawBench(r, bx, by, F.front === 'right');
  }
}
