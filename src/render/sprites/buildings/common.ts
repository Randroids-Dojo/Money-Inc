// Shared context and helpers for building drawers.

import type { BuildingKind, BuildingState } from '../types';
import { type Col, P, hex, fade, grim } from '../color';
import { Raster } from '../raster';
import { Frame, type Front, groundShadow } from '../kit';
import { Rng, h01 } from '../rng';
import type { Anchors } from '../sprite';
import { grass, paving, concrete } from '../textures';

/** Normalised building spec (all fields resolved; used as the memo key). */
export interface Spec {
  kind: BuildingKind;
  w: number;
  d: number;
  level: number;
  variant: number;
  subtype: string;
  accent: string;
  sign: string;
  state: BuildingState;
  progress: number;
  target: { kind: BuildingKind; level: number; subtype: string } | null;
  lit: number;
  front: Front;
}

export interface Ctx {
  s: Spec;
  r: Raster;
  F: Frame;
  rng: Rng;
  an: Anchors;
  seed: number;
  /** colour filter for the building state (faded when closed/vacant, grim when distressed) */
  tone: (c: Col) => Col;
  /** accent colour (spec.accent or a default) */
  accent: Col;
}

export function makeCtx(s: Spec, r: Raster, seed: number, defaultAccent: Col): Ctx {
  const F = new Frame(r, s.w, s.d, s.front);
  const accent = s.accent ? hex(s.accent) : defaultAccent;
  let tone = (c: Col) => c;
  if (s.state === 'closed' || s.state === 'vacant') tone = (c: Col) => fade(c, 0.45);
  else if (s.state === 'failed') tone = (c: Col) => grim(fade(c, 0.35), 0.4);
  else if (s.state === 'distressed') tone = (c: Col) => grim(c, 0.28);
  return { s, r, F, rng: new Rng(seed), an: {}, seed, tone, accent };
}

/** Deterministic pick from a list using the spec variant and a salt. */
export function vpick<T>(c: Ctx, list: readonly T[], salt: number): T {
  return list[Math.floor(h01(c.seed, salt) * list.length)];
}

export function vchance(c: Ctx, p: number, salt: number): boolean {
  return h01(c.seed, salt, 77) < p;
}

/** Lot paint helpers in local coordinates. */
export function lawn(c: Ctx, shaggy = 0): (a: number, b: number) => Col {
  return (a, b) => {
    const [x, y] = c.F.xy(a, b);
    return grass(x, y, c.seed & 0xffff, shaggy);
  };
}

export function pave(c: Ctx, base: Col = P.paving, slab = 8): (a: number, b: number) => Col {
  return (a, b) => {
    const [x, y] = c.F.xy(a, b);
    return paving(x, y, c.seed & 0xff, base, slab);
  };
}

export function apron(c: Ctx, base: Col = P.concrete): (a: number, b: number) => Col {
  return (a, b) => {
    const [x, y] = c.F.xy(a, b);
    return concrete(x, y, c.seed & 0xff, base);
  };
}

export const DOOR_COLS: readonly Col[] = [hex('#a8362e'), hex('#2f6a4a'), hex('#34528c'), hex('#6a4a30'), hex('#d4a02c'), hex('#5a3a6a')];

/** Contact shadow for a local-rect mass of height h (px) onto the lot ground. */
export function castShadow(c: Ctx, a0: number, b0: number, a1: number, b1: number, h: number): void {
  const [x0, y0, x1, y1] = c.F.rect(a0, b0, a1, b1);
  groundShadow(c.r, x0, y0, x1, y1, Math.min(7, 2 + h * 0.18));
}
