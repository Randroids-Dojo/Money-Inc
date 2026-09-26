// buildingSprite(): spec normalisation, memoisation and dispatch to the per-kind
// drawers. Every building sprite includes its own lot ground covering exactly the
// w x d footprint diamond; (ax, ay) is the footprint's top corner.

import type { BuildingKind, BuildingSpriteSpec, BuildingState, Sprite } from '../types';
import { P } from '../color';
import { Raster } from '../raster';
import { finish, LRU } from '../sprite';
import { hash, hashStr } from '../rng';
import { makeCtx, type Ctx, type Spec } from './common';
import { house, apartment } from './residential';
import { shop, service } from './commercial';
import { office, fund } from './office';
import { factory, builder } from './industry';
import { bank, centralbank, cityhall } from './civic';
import { construction, emptylot, park } from './sites';
import { registerDrawer, getDrawer, type Drawer } from './registry';

const MAX_LEVEL: Record<BuildingKind, number> = {
  house: 2,
  apartment: 4,
  shop: 3,
  service: 3,
  office: 4,
  factory: 4,
  builder: 3,
  bank: 3,
  centralbank: 1,
  fund: 1,
  cityhall: 1,
  construction: 1,
  emptylot: 1,
  park: 1,
};

const STATES: readonly BuildingState[] = ['normal', 'closed', 'failed', 'distressed', 'stalled', 'vacant'];

/** Characters the pixel font can draw on signs. */
const SIGN_OK = /[A-Z0-9 &.\-!$%',?:/()#+]/;

function cleanSign(s: string | undefined): string {
  if (!s) return '';
  let out = '';
  for (const ch of s.toUpperCase()) if (SIGN_OK.test(ch)) out += ch;
  return out.trim().slice(0, 12);
}

function cleanHex(s: string | undefined): string {
  if (!s) return '';
  let h = s.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(h)) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return /^[0-9a-f]{6}$/.test(h) ? '#' + h : '';
}

const clampInt = (v: number | undefined, lo: number, hi: number, def: number) =>
  Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? (v as number) : def)));

export function normalizeSpec(spec: BuildingSpriteSpec): Spec {
  const kind = spec.kind;
  const state = STATES.includes(spec.state as BuildingState) ? (spec.state as BuildingState) : 'normal';
  const target =
    kind === 'construction' && spec.target
      ? {
          kind: spec.target.kind,
          level: clampInt(spec.target.level, 1, MAX_LEVEL[spec.target.kind] ?? 1, 1),
          subtype: spec.target.subtype ?? '',
        }
      : null;
  return {
    kind,
    w: clampInt(spec.w, 1, 4, 1),
    d: clampInt(spec.d, 1, 4, 1),
    level: clampInt(spec.level, 1, MAX_LEVEL[kind] ?? 1, 1),
    variant: Math.abs(Math.floor(Number.isFinite(spec.variant) ? spec.variant : 0)) % 4096,
    subtype: spec.subtype ?? '',
    accent: cleanHex(spec.accent),
    sign: cleanSign(spec.sign),
    state,
    progress: kind === 'construction' ? Math.round(Math.min(1, Math.max(0, spec.progress ?? 0)) * 20) / 20 : 0,
    target,
    lit: Math.round(Math.min(1, Math.max(0, spec.lit ?? 0)) * 4) / 4,
    front: spec.front === 'right' ? 'right' : 'left',
  };
}

const ALL: Record<BuildingKind, Drawer> = {
  house,
  apartment,
  shop,
  service,
  office,
  factory,
  builder,
  bank,
  centralbank,
  fund,
  cityhall,
  construction,
  emptylot,
  park,
};
for (const k of Object.keys(ALL) as BuildingKind[]) registerDrawer(k, ALL[k]);

/** Head-room (px above the footprint's top corner) needed by each kind. */
function headroom(kind: BuildingKind, level: number): number {
  switch (kind) {
    case 'house':
      return 72;
    case 'apartment':
      return 140;
    case 'shop':
    case 'service':
      return 100;
    case 'office':
      return [95, 125, 165, 222][level - 1] ?? 222;
    case 'factory':
      return 110;
    case 'builder':
      return 70;
    case 'bank':
      return 116;
    case 'centralbank':
      return 160;
    case 'fund':
      return 216;
    case 'cityhall':
      return 146;
    case 'construction':
      return 236;
    case 'emptylot':
      return 40;
    default:
      return 64;
  }
}

/** Build a raster sized for a footprint (origin = footprint top corner). */
export function buildingRaster(w: number, d: number, kind: BuildingKind = 'construction', level = 4): Raster {
  const padX = kind === 'construction' ? 64 : 32;
  const top = headroom(kind, level);
  const r = new Raster(32 * (w + d) + 2 * padX, 16 * (w + d) + top + 12, 32 * d + padX, top);
  r.emptyShadows = false;
  return r;
}

export function drawBuilding(s: Spec, r: Raster): Ctx {
  const seed = hash(hashStr(s.kind), s.variant, hashStr(s.subtype));
  const c = makeCtx(s, r, seed, P.blue);
  const fn = getDrawer(s.kind) ?? emptylot;
  fn(c);
  return c;
}

/** Memo of generated sprites keyed by the normalised spec (LRU, bounded memory). */
const cache = new LRU<Sprite>(1500);

/** Dev/QA switches (used by the gallery's verify page). */
export const buildingDebug = { clip: true, noCache: false };

export function buildingSprite(spec: BuildingSpriteSpec): Sprite {
  const s = normalizeSpec(spec);
  const key = JSON.stringify(s);
  const hit = buildingDebug.noCache ? undefined : cache.get(key);
  if (hit) return hit;
  const r = buildingRaster(s.w, s.d, s.kind, s.level);
  const c = drawBuilding(s, r);
  // icon anchor: just above the highest point near the footprint centre
  const cx = 16 * (s.w - s.d);
  const cy = 8 * (s.w + s.d);
  if (!c.an.top) {
    const top = Math.min(r.topRow(cx - 3, cx + 3) - 3, cy - 12);
    c.an.top = [cx, top];
  }
  const sp = finish(r, c.an, buildingDebug.clip ? { footprint: { w: s.w, d: s.d } } : {});
  if (!buildingDebug.noCache) cache.set(key, sp);
  return sp;
}
