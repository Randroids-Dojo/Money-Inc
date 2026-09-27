// Construction sites (any footprint, progress + target driven, active or stalled),
// empty lots and parks.

import type { BuildingKind } from '../types';
import { type Col, P, hex, rgb, shade, mix } from '../color';
import { type WallPaint } from '../raster';
import { crate, hedge } from '../kit';
import { textBitmap } from '../font';
import { plant, treeArt, pineArt, weedArt, drawBench, drawLamp, drawFountain, drawFlowers, drawCrane, drawSign } from '../props';
import { drawVehicle } from '../vehicles';
import { type Ctx, makeCtx, lawn } from './common';
import { dirt, grass, gravel, lattice } from '../textures';
import { waterAt } from '../ground';
import { h01, hash, hashStr } from '../rng';
import { getDrawer } from './registry';
import { excavator } from './industry';

// ---------------------------------------------------------------------------
// Construction

/** Approximate finished height (px) of a target building, for frames and cranes. */
function targetHeight(kind: BuildingKind, level: number): number {
  switch (kind) {
    case 'house':
      return level >= 2 ? 40 : 26;
    case 'apartment':
      return [2, 3, 4, 6][Math.min(3, level - 1)] * 14 + 3;
    case 'shop':
      return level === 1 ? 22 : 33;
    case 'service':
      return 20 + (level - 1) * 12;
    case 'office':
      return [45, 71, 110, 162][Math.min(3, level - 1)];
    case 'factory':
      return 28;
    case 'bank':
      return 6 + (level + 1) * 13;
    case 'centralbank':
      return 60;
    case 'fund':
      return 159;
    case 'cityhall':
      return 40;
    default:
      return 24;
  }
}

function defaultTarget(c: Ctx): { kind: BuildingKind; level: number; subtype: string } {
  const big = c.s.w * c.s.d;
  if (big >= 9) return { kind: 'office', level: 3, subtype: '' };
  if (big >= 4) return { kind: 'office', level: 2, subtype: '' };
  return { kind: 'house', level: 1, subtype: '' };
}

export function construction(c: Ctx): void {
  const { r, F, s } = c;
  const p = s.progress;
  const stalled = s.state === 'stalled';
  const target = s.target ?? defaultTarget(c);
  const A = F.A;
  const B = F.B;
  const large = s.w >= 2 && s.d >= 2;
  const timber = target.kind === 'house';
  const TH = targetHeight(target.kind, target.level);

  if (p > 0.85) {
    // nearly finished: the real building, dressed with scaffolding
    const fn = getDrawer(target.kind);
    if (fn) {
      const spec = { ...s, kind: target.kind, level: target.level, subtype: target.subtype, state: 'normal' as const, lit: 0, progress: 0, target: null };
      const tc = makeCtx(spec, r, hash(hashStr(target.kind), s.variant, hashStr(target.subtype)), c.accent);
      fn(tc);
      c.an.door = tc.an.door;
    }
    const fa0 = 4, fa1 = A - 4;
    scaffold(c, fa0, fa1, B - (large ? 12 : 9), Math.round(TH * 0.75), stalled);
    fenceRow(c, B - 2, stalled);
    if (stalled) stallBoard(c);
    return;
  }

  // ground: churned dirt (weedy when stalled), gravel strip at the front
  F.ground(0, 0, A, B, (a, b) => {
    const [x, y] = F.xy(a, b);
    if (stalled && h01(Math.floor(a / 5), Math.floor(b / 5), c.seed + 9) < 0.35) return grass(x, y, c.seed, 0.95);
    if (b > B - 5) return gravel(x, y, c.seed, rgb(150, 142, 128));
    return dirt(x, y, c.seed);
  });

  const fa0 = large ? 8 : 5;
  const fa1 = A - (large ? 6 : 5);
  const fb0 = large ? 10 : 6;
  const fb1 = B - (large ? 12 : 9);

  if (p < 0.15) {
    excavation(c, fa0, fa1, fb0, fb1, stalled);
    c.an.top = F.screen((fa0 + fa1) / 2, (fb0 + fb1) / 2, 26);
  } else {
    const t = (p - 0.15) / 0.7;
    const h = Math.max(8, Math.round(TH * t));
    // icons float over the rising frame, not over the crane jib
    c.an.top = F.screen((fa0 + fa1) / 2, (fb0 + fb1) / 2, h + 10);
    frame(c, fa0, fa1, fb0, fb1, h, timber, stalled, target.kind);
    if (!timber) scaffold(c, fa0 - 1, fa1 + 1, fb1, Math.min(h + 4, TH), stalled);
    // materials
    const [mx, my] = F.xy(A - 10, B - 6);
    crate(r, mx - 3, my - 3, mx + 3, my + 3, 0, 4, P.wood, (i, j) => (j % 2 ? P.woodDark : i % 3 === 0 ? P.woodLight : P.wood));
    if (!stalled && large) drawVehicle(r, 'mixer', F.front === 'left' ? 2 : 3, '#e8b830', ...F.xy(A - 16, B - 5));
    if (large) {
      const [cx, cy] = F.xy(A / 2 + 3, 5);
      drawCrane(r, cx, cy, {
        height: Math.max(70, Math.min(170, TH + 34)),
        jib: 30 * Math.min(s.w, s.d) + 10,
        counter: 18,
        axis: F.axis('b'),
        hook: stalled ? 4 : Math.max(10, Math.min(TH + 34 - h - 8, 60)),
        load: !stalled,
        trolley: 0.55,
      });
    }
  }
  fenceRow(c, B - 2, stalled);
  if (stalled) stallBoard(c);
}

/** Foundation dig: pit with visible inner walls, stakes, spoil heap and a digger. */
function excavation(c: Ctx, a0: number, a1: number, b0: number, b1: number, stalled: boolean): void {
  const { r, F } = c;
  const depth = 7;
  const [x0, y0, x1, y1] = F.rect(a0, b0, a1, b1);
  // clear the ground inside the pit, then draw the pit floor and inner walls
  const g = r.group();
  const LX = 32 * c.s.w;
  const LY = 32 * c.s.d;
  // the floor is 'depth' px lower, so near the front it would show below the lot: skip
  // floor pixels whose screen position lies outside the lot diamond
  r.hface(x0, y0, x1, y1, -depth, (x, y) => (x + depth >= LX || y + depth >= LY ? 0 : stalled && h01(Math.floor(x / 4), Math.floor(y / 4), 5) < 0.3 ? rgb(90, 110, 60) : shade(dirt(x, y, 3), 0.8)), g, 1);
  // erase ground pixels covering the pit (they were drawn at z = 0)
  for (let px = Math.floor(x0 - y1); px <= Math.ceil(x1 - y0); px++) {
    for (let py = Math.floor((x0 + y0) / 2) - 1; py <= Math.ceil((x1 + y1) / 2) + 1; py++) {
      const gx = (px + 0.5 + 2 * (py + 0.5)) / 2;
      const gy = (2 * (py + 0.5) - (px + 0.5)) / 2;
      if (gx > x0 && gx < x1 && gy > y0 && gy < y1 && r.groupAt(px, py) === 1) {
        // reveal what lies below: pit wall or floor
        r.recolor(px, py, pitColor(gx, gy, x0, y0, depth));
      }
    }
  }
  // stakes with tape at the corners
  const stake = (a: number, b: number) => {
    const [x, y] = F.xy(a, b);
    const gg = r.group();
    r.pole(x, y, 0, 6, P.woodLight, gg, false);
    r.dot(x, y, 6, hex('#e8792c'), gg);
  };
  stake(a0 - 2, b0 - 2);
  stake(a1 + 1, b0 - 2);
  stake(a0 - 2, b1 + 1);
  stake(a1 + 1, b1 + 1);
  // spoil heap beside the pit (kept inside the lot)
  const [hx, hy] = F.xy(Math.min(a1 - 2, F.A - 9), Math.min(b1 + 3, F.B - 7));
  r.ellipsoid(hx, hy, 0, 6, 4, 6, (x, y, z) => (h01(Math.floor(x * 2), Math.floor(y * 2), Math.floor(z)) < 0.2 ? P.dirtLight : P.dirt), r.group(), 0, 4);
  if (!stalled) {
    const [ex, ey] = F.xy((a0 + a1) / 2 - 4, (b0 + b1) / 2);
    excavator(r, ex, ey, F.front === 'left');
  } else {
    // puddle in the pit
    const [px, py] = F.xy((a0 + a1) / 2, (b0 + b1) / 2);
    r.disc(px, py, 6, -depth, (x, y) => (x + depth >= LX || y + depth >= LY ? 0 : waterAt(x, y, 0)), r.group(), 1, true);
  }
}

/** Colour for a pit pixel seen from above: inner walls near the far edges, floor elsewhere. */
function pitColor(gx: number, gy: number, x0: number, y0: number, depth: number): Col {
  // a ground pixel at (gx, gy) looks down into the pit; the far walls occupy a band of
  // width ~2*depth units along the back edges (screen-space projection of the walls)
  const dx = gx - x0;
  const dy = gy - y0;
  if (dy < depth * 1.2 && dy <= dx) return shade(P.dirt, 1.0);
  if (dx < depth * 0.9) return shade(P.dirt, 0.82);
  return shade(P.dirtDark, 0.95);
}

/** Structural frame rising to height h with partial walls on lower floors. */
function frame(c: Ctx, a0: number, a1: number, b0: number, b1: number, h: number, timber: boolean, stalled: boolean, kind: BuildingKind): void {
  const { r, F } = c;
  const fh = 14;
  // timber studs for houses, red-oxide primed steel for everything else
  const post = timber ? P.woodLight : stalled ? hex('#8e5a4c') : hex('#b04a38');
  const beamC = timber ? P.wood : stalled ? hex('#9a6a5a') : hex('#c25a40');
  const slabC = rgb(176, 172, 164);
  const g = r.group();
  // foundation slab
  const [sx0, sy0, sx1, sy1] = F.rect(a0 - 1, b0 - 1, a1 + 1, b1 + 1);
  r.box(sx0, sy0, 0, sx1, sy1, 2, rgb(150, 146, 138), slabC, g);
  const floors = Math.max(1, Math.floor(h / fh));
  const top = Math.min(h, floors * fh + (h % fh > 6 ? fh : 0));
  const step = timber ? 5 : 10;
  // walls on the lower floors (building up behind the frame)
  const wallFloors = Math.max(0, Math.floor(floors * 0.6));
  const wallC = kind === 'house' ? hex('#d9b77e') : kind === 'apartment' ? hex('#a84e3a') : kind === 'bank' || kind === 'cityhall' || kind === 'centralbank' ? hex('#e6dcc2') : hex('#c8c4bc');
  if (wallFloors > 0) {
    const wz = 2 + wallFloors * fh;
    const wp: WallPaint = (i, j) => {
      const r2 = (j - 2) % fh;
      if (r2 >= 4 && r2 <= 10 && i % 7 >= 2 && i % 7 <= 4) return rgb(40, 44, 54);
      return wallC;
    };
    const [wx0, wy0, wx1, wy1] = F.rect(a0 + 1, b0 + 1, a1 - 1, b1 - 1);
    r.box(wx0, wy0, 2, wx1, wy1, wz, wp, slabC, r.group());
  }
  // columns along the perimeter
  const gc = r.group();
  const col = (a: number, b: number) => {
    const [x, y] = F.xy(a, b);
    r.box(x - 1, y - 1, 2, x + 1, y + 1, top + 2, timber ? post : (_i, j) => (j % 7 === 0 ? shade(post, 0.85) : post), shade(post, 1.1), gc);
  };
  const colsA: number[] = [];
  for (let a = a0; a <= a1; a += step) colsA.push(Math.min(a, a1 - 1));
  const colsB: number[] = [];
  for (let b = b0; b <= b1; b += step) colsB.push(Math.min(b, b1 - 1));
  for (const a of colsA) {
    col(a, b0);
    col(a, b1 - 1);
  }
  for (const b of colsB) {
    col(a0, b);
    col(a1 - 1, b);
  }
  // floor beams / slabs at each level
  for (let k = 1; k * fh <= top; k++) {
    const z = 2 + k * fh;
    const gb = r.group();
    const [bx0, by0, bx1, by1] = F.rect(a0, b0, a1, b1);
    if (k * fh < top - 2 && !timber) {
      r.box(bx0, by0, z - 2, bx1, by1, z, (_i, j) => (j === 0 ? shade(slabC, 0.85) : slabC), slabC, gb);
    } else {
      // perimeter beams only (top level)
      r.box(bx0, by0, z - 2, bx1, by0 + 1, z, beamC, beamC, gb);
      r.box(bx0, by1 - 1, z - 2, bx1, by1, z, beamC, beamC, gb);
      r.box(bx0, by0, z - 2, bx0 + 1, by1, z, beamC, beamC, gb);
      r.box(bx1 - 1, by0, z - 2, bx1, by1, z, beamC, beamC, gb);
    }
  }
  // cross-bracing in the end bays of the two visible faces
  if (!timber && colsA.length > 1) {
    const gx = r.group();
    for (let k = 0; k * fh < top; k++) {
      const z0 = 2 + k * fh;
      const z1 = Math.min(top + 2, z0 + fh);
      const fa0 = colsA[colsA.length - 2] + 1;
      const fa1 = colsA[colsA.length - 1];
      r.line(F.pt(fa0, b1 - 0.5, z0), F.pt(fa1, b1 - 0.5, z1), beamC, gx);
      r.line(F.pt(fa0, b1 - 0.5, z1), F.pt(fa1, b1 - 0.5, z0), beamC, gx);
      const sa = F.front === 'left' ? a1 - 0.5 : a0 + 0.5;
      r.line(F.pt(sa, colsB[0] + 1, z0), F.pt(sa, colsB[1] ?? b1, z1), beamC, gx);
    }
  }
  // stalled: weathered tarps draped over the frame faces, torn in places
  if (stalled) {
    const tarp = rgb(138, 156, 170);
    const fold = shade(tarp, 0.82);
    const tz = Math.max(10, Math.floor(top * 0.85));
    const tp: WallPaint = (i, j, f) => {
      const hang = f.hi[i] - j; // distance below the tarp's top edge
      if (h01(i >> 2, j >> 2, 7) < 0.12 && hang > 3) return 0; // holes
      if (hang <= 1) return shade(tarp, 1.12);
      if (i % 6 === 0) return fold;
      return (i + (j >> 1)) % 9 === 0 ? shade(tarp, 0.9) : tarp;
    };
    const [tx0, ty0, tx1, ty1] = F.rect(a0 - 1, b0 - 1, a1 + 1, b1 + 1);
    const bottom = (t: number) => 3 + Math.floor(h01(Math.floor(t / 3), 5) * 6);
    r.vface('L', ty1 + 0.0, tx0, tx1, 2, bottom, tz, tp, r.group());
    r.vface('R', tx1, ty0, ty1, 2, bottom, tz - 4, tp, r.group());
  }
}

/** Scaffolding in front of a facade (local b = bFront), poles and planks. */
function scaffold(c: Ctx, a0: number, a1: number, bFront: number, h: number, stalled: boolean): void {
  const { r, F } = c;
  const g = r.group();
  const pole = stalled ? rgb(120, 124, 130) : hex('#4a78b8');
  const plank = stalled ? rgb(140, 120, 90) : P.woodLight;
  const out = 4;
  for (let a = a0; a <= a1; a += 8) {
    for (const bb of [bFront + 1, bFront + out]) {
      const [x, y] = F.xy(Math.min(a, a1), bb);
      r.pole(x, y, 0, h, pole, g, false);
    }
  }
  for (let z = 7; z < h; z += 7) {
    const [x0, y0, x1, y1] = F.rect(a0, bFront + 1, a1, bFront + out + 1);
    r.box(x0, y0, z, x1, y1, z + 1, plank, plank, g);
    if (stalled && z > h / 2) {
      // torn tarp hanging from the scaffold
      const [ax, ay, bx, by] = F.rect(a0 + 3, bFront + out, a1 - 6, bFront + out + 1);
      r.box(ax, ay, z - 6, bx, by, z, (i, j) => (h01(i >> 2, j, 5) < 0.3 ? 0 : rgb(150, 156, 160)), null, r.group());
    }
  }
}

/** Temporary site fence panels along the front edge (b). */
function fenceRow(c: Ctx, b: number, stalled: boolean): void {
  const { r, F } = c;
  const g = r.group();
  const col = stalled ? rgb(170, 160, 140) : hex('#e8792c');
  const [x0, y0, x1, y1] = F.rect(3, b - 1, F.A / 2 - 5, b);
  const [x2, y2, x3, y3] = F.rect(F.A / 2 + 5, b - 1, F.A - 3, b);
  const pp: WallPaint = (i, j) => (j === 0 || j === 5 ? shade(col, 0.8) : (i + j) % 3 === 0 ? col : (i - j + 30) % 3 === 0 ? col : 0);
  r.box(x0, y0, 0, x1, y1, 6, pp, null, g, pp);
  r.box(x2, y2, 0, x3, y3, 6, pp, null, g, pp);
}

function stallBoard(c: Ctx): void {
  const { r, F } = c;
  const small = F.A < 64;
  const text = small ? 'STOP' : 'STALLED';
  const half = small ? 9 : 16;
  const g = r.group();
  const [p1x, p1y] = F.xy(F.A / 2 - half + 3, F.B - 4.5);
  const [p2x, p2y] = F.xy(F.A / 2 + half - 3, F.B - 4.5);
  r.pole(p1x, p1y, 0, 8, P.woodDark, g, false);
  r.pole(p2x, p2y, 0, 8, P.woodDark, g, false);
  // weathered board on two posts
  const [sx0, sy0, sx1, sy1] = F.rect(F.A / 2 - half, F.B - 5, F.A / 2 + half, F.B - 4);
  const b = r.box(sx0, sy0, 6, sx1, sy1, 15, rgb(226, 216, 188), rgb(226, 216, 188));
  const f = F.front === 'left' ? b.L : b.R;
  f.rect(0, 0, f.W, 1, rgb(120, 96, 64));
  f.rect(0, 8, f.W, 1, rgb(120, 96, 64));
  f.set(1, 7, rgb(90, 80, 70));
  f.set(f.W - 2, 1, rgb(90, 80, 70));
  f.text(text, Math.floor((f.W - textBitmap(text).w) / 2), 6, rgb(190, 40, 30), textBitmap);
}

// ---------------------------------------------------------------------------
// Empty lot

export function emptylot(c: Ctx): void {
  const { r, F, s } = c;
  const A = F.A;
  const B = F.B;
  const wild = s.state === 'wild';
  F.ground(0, 0, A, B, (a, b) => {
    const [x, y] = F.xy(a, b);
    const n = h01(Math.floor(a / 6), Math.floor(b / 6), c.seed) * 0.6 + h01(Math.floor(a / 3), Math.floor(b / 3), c.seed + 1) * 0.4;
    if (wild) return n < 0.18 ? mix(dirt(x, y, c.seed), grass(x, y, c.seed, 0.9), 0.6) : grass(x, y, c.seed, 1);
    if (n < 0.33) return dirt(x, y, c.seed);
    if (n < 0.4) return mix(dirt(x, y, c.seed), grass(x, y, c.seed, 0.9), 0.5);
    return grass(x, y, c.seed, 0.9);
  });
  // weeds and rubble
  const n = 5 * s.w * s.d;
  for (let k = 0; k < n; k++) {
    const a = 3 + h01(c.seed, k, 1) * (A - 6);
    const b = 3 + h01(c.seed, k, 2) * (B - 6);
    const [x, y] = F.xy(a, b);
    if (k % 3 === 0 && !wild) {
      const g = r.group();
      r.box(x, y, 0, x + 2, y + 2, 1 + (k % 2), rgb(150, 146, 138), rgb(170, 166, 158), g);
    } else r.stampAt(weedArt(k), x, y, 0, r.group(), true);
  }
  if (s.variant % 3 === 0 && !wild) drawSign(r, 'sign_lot', ...F.xy(A / 2 + 6, B - 4));
}

// ---------------------------------------------------------------------------
// Park

export function park(c: Ctx): void {
  const { r, F, s } = c;
  const A = F.A;
  const B = F.B;
  const layout = s.variant % 3;
  const big = s.w >= 2 && s.d >= 2;
  const cx = A / 2;
  const cy = B / 2;
  const pw = big ? 4 : 3;
  const ringR = Math.min(A, B) * 0.3;
  const onPath = (a: number, b: number): boolean => {
    if (layout === 0) return Math.abs(a - cx) < pw || Math.abs(b - cy) < pw;
    if (layout === 1) {
      const u = a / A;
      const v = b / B;
      return Math.abs(u - v) * Math.min(A, B) < pw || Math.abs(u + v - 1) * Math.min(A, B) < pw;
    }
    const d = Math.hypot(a - cx, b - cy);
    return Math.abs(d - ringR) < pw || (Math.abs(b - cy) < pw && Math.abs(a - cx) > ringR) || (Math.abs(a - cx) < pw && b > cy + ringR);
  };
  const pond = layout === 2 && s.w >= 3 && s.d >= 3;
  const gr = lawn(c);
  const pathC = rgb(214, 198, 160);
  F.ground(0, 0, A, B, (a, b) => {
    const [x, y] = F.xy(a, b);
    if (pond) {
      const d = Math.hypot((a - cx) / 1.1, b - cy);
      if (d < ringR * 0.62) return waterAt(x, y, 0);
      if (d < ringR * 0.7) return rgb(170, 160, 140);
    }
    if (onPath(a, b)) {
      const [U, V] = lattice(x, y);
      const k = h01(U, V, 44);
      return k < 0.1 ? shade(pathC, 0.92) : k > 0.95 ? shade(pathC, 1.05) : pathC;
    }
    if (layout !== 2 && big && Math.hypot(a - cx, b - cy) < 9) return pathC;
    return gr(a, b);
  });
  // centre feature
  const [mx, my] = F.xy(cx, cy);
  if (pond) plant(r, treeArt(2), mx, my);
  else if (big) drawFountain(r, mx, my, s.w >= 3);
  else drawFlowers(r, mx, my, s.variant);
  // trees: scattered away from paths
  const nTrees = big ? 6 * Math.max(s.w, s.d) - 4 : 3;
  let placed = 0;
  for (let k = 0; k < nTrees * 6 && placed < nTrees; k++) {
    const a = 4 + h01(c.seed, k, 11) * (A - 11);
    const b = 4 + h01(c.seed, k, 12) * (B - 11);
    if (onPath(a, b) || onPath(a + 3, b) || onPath(a - 3, b) || onPath(a, b + 3) || onPath(a, b - 3)) continue;
    if (Math.hypot(a - cx, b - cy) < (big ? 14 : 8)) continue;
    if (pond && Math.hypot((a - cx) / 1.1, b - cy) < ringR * 0.8) continue;
    const [x, y] = F.xy(a, b);
    const v = h01(c.seed, k, 13);
    plant(r, v < 0.2 ? pineArt(k) : treeArt(v < 0.3 ? 3 + (k % 2) : k % 3), x, y);
    placed++;
  }
  // benches beside the paths
  const benches: [number, number, boolean][] =
    layout === 0
      ? [[cx + pw + 2, cy - 8, true], [cx - 8, cy + pw + 2, false]]
      : layout === 1
        ? [[cx + 8, cy + 3, false], [cx - 3, cy - 9, true]]
        : [[cx, cy + ringR + pw + 2, false], [cx + ringR + pw + 2, cy, true]];
  for (const [a, b, alongB] of benches) {
    const [x, y] = F.xy(a, b);
    drawBench(r, x, y, alongB === (F.front === 'left'));
  }
  if (big) {
    for (const [a, b] of [[cx + pw + 3, cy + pw + 3], [cx - pw - 3, cy - pw - 3]]) {
      const [x, y] = F.xy(a, b);
      drawLamp(r, x, y);
    }
    const [fx, fy] = F.xy(A - 7, 7);
    drawFlowers(r, fx, fy, s.variant + 1);
  }
  // low hedge along the back edges
  hedge(r, 1, 0, 32 * s.w - 1, 2, 3);
  hedge(r, 0, 1, 2, 32 * s.d - 1, 3);
}
