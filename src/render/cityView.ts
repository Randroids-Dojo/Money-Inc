// Turns the city layout and the live economy into drawable things: a pre-rendered ground layer
// and, for every lot, the building sprite that shows what is happening there right now
// (a busy factory, a boarded-up shop, a bank under siege, a half-built apartment block...).

import {
  buildingSprite,
  groundTile,
  propSprite,
  roadTile,
  shoreTile,
  type BuildingSpriteSpec,
  type IconKind,
  type PropKind,
  type Sprite,
} from './sprites';
import { HALF_H, HALF_W, ROAD_E, ROAD_N, ROAD_S, ROAD_W, tileToScreen } from './iso';
import { Terrain, type City, type Lot } from '../world/city';
import type { Economy } from '../sim/economy';
import type { Firm } from '../sim/agents';
import type { Selection } from '../game/game';
import { SECTORS } from '../sim/config';
import { fmtMoney } from '../sim/format';
import { metrics } from '../sim/banking';

// ------------------------------------------------------------------------------------ ground

export interface Ground {
  canvas: HTMLCanvasElement;
  /** world position of the canvas's top-left pixel */
  ox: number;
  oy: number;
  water: { x: number; y: number; mask: number; v: number }[];
  bridges: { x: number; y: number; sprite: Sprite }[];
}

const hash2 = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};

export function isWater(city: City, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= city.W || y >= city.H) return false;
  const t = city.terrain[y * city.W + x];
  return t === Terrain.Water || t === Terrain.Bridge;
}

export function buildGround(city: City): Ground {
  const W = city.W;
  const H = city.H;
  const ox = -H * HALF_W - 4;
  const oy = -8;
  const cw = (W + H) * HALF_W + 8;
  const ch = (W + H) * HALF_H + 48;
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const water: Ground['water'] = [];
  const bridges: Ground['bridges'] = [];
  const isRoad = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const t = city.terrain[y * W + x];
    return t === Terrain.Road || t === Terrain.Bridge;
  };
  const degree = (x: number, y: number) => {
    const m = city.roadMask[y * W + x];
    return ((m & ROAD_N) ? 1 : 0) + ((m & ROAD_E) ? 1 : 0) + ((m & ROAD_S) ? 1 : 0) + ((m & ROAD_W) ? 1 : 0);
  };
  const put = (s: Sprite, x: number, y: number) => {
    const p = tileToScreen(x, y);
    ctx.drawImage(s.canvas, Math.round(p.x - s.ax - ox), Math.round(p.y - s.ay - oy));
  };
  // painter's order: back to front
  for (let sum = 0; sum <= W + H - 2; sum++) {
    for (let x = Math.max(0, sum - H + 1); x <= Math.min(W - 1, sum); x++) {
      const y = sum - x;
      const t = city.terrain[y * W + x];
      const v = hash2(x, y);
      switch (t) {
        case Terrain.Water:
        case Terrain.Bridge: {
          let mask = 0;
          if (y > 0 && !isWater(city, x, y - 1)) mask |= ROAD_N;
          if (x < W - 1 && !isWater(city, x + 1, y)) mask |= ROAD_E;
          if (y < H - 1 && !isWater(city, x, y + 1)) mask |= ROAD_S;
          if (x > 0 && !isWater(city, x - 1, y)) mask |= ROAD_W;
          water.push({ x, y, mask, v: v % 4 });
          put(mask ? shoreTile(mask, 0) : groundTile('water', v % 4, 0), x, y);
          if (t === Terrain.Bridge) bridges.push({ x, y, sprite: roadTile(city.roadMask[y * W + x], { bridge: true }) });
          break;
        }
        case Terrain.Road: {
          const m = city.roadMask[y * W + x];
          // zebra crossings next to junctions
          let crosswalk = false;
          if (degree(x, y) === 2) {
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
              if (isRoad(x + dx, y + dy) && degree(x + dx, y + dy) >= 3 && (v & 3) !== 0) crosswalk = true;
          }
          put(roadTile(m, { crosswalk }), x, y);
          break;
        }
        case Terrain.Plaza:
          put(groundTile('plaza', v % 16), x, y);
          break;
        case Terrain.Sand:
          put(groundTile('sand', v % 16), x, y);
          break;
        case Terrain.Parking:
          put(groundTile('parking', v % 16), x, y);
          break;
        default:
          put(groundTile('grass', v % 16), x, y);
      }
    }
  }
  return { canvas, ox, oy, water, bridges };
}

// ------------------------------------------------------------------------------------ lots

export interface Sign {
  kind: PropKind;
  /** tile-space ground point */
  tx: number;
  ty: number;
  /** drawn behind the building (e.g. a crane over an expansion) */
  behind?: boolean;
}

export interface LotVisual {
  lot: Lot;
  sprite: Sprite;
  /** world position of the footprint's top corner */
  wx: number;
  wy: number;
  sort: number;
  sort2: number;
  select: Selection;
  label: string;
  /** second line for the hover tooltip */
  detail?: string;
  icon?: IconKind;
  /** make the icon pulse (crisis) */
  urgent?: boolean;
  signs: Sign[];
  /** accent colour for highlights (bank brand, firm colour) */
  color?: string;
}

function frontOf(lot: Lot): 'left' | 'right' {
  return lot.facing === ROAD_E ? 'right' : 'left';
}

/** Where a sign stands on a lot: near the front edge, off to one side. */
function signSpot(lot: Lot): { tx: number; ty: number } {
  switch (lot.facing) {
    case ROAD_E:
      return { tx: lot.x + lot.w - 0.12, ty: lot.y + 0.22 };
    case ROAD_N:
      return { tx: lot.x + lot.w - 0.22, ty: lot.y + 0.12 };
    case ROAD_W:
      return { tx: lot.x + 0.12, ty: lot.y + lot.d - 0.22 };
    default:
      return { tx: lot.x + 0.22, ty: lot.y + lot.d - 0.12 };
  }
}

/** Physical size of a firm's premises follows its capital stock, not its current staff. */
function firmLevel(f: Firm, big: boolean): number {
  const sp = SECTORS[f.sector];
  const slots = f.K / (sp.kappa * sp.A); // workers the premises can hold
  switch (f.sector) {
    case 'factory':
      return slots < 5.5 ? 1 : slots < 8.5 ? 2 : slots < 12.5 ? 3 : 4;
    case 'builder':
      return slots < 2.8 ? 1 : slots < 5 ? 2 : 3;
    case 'service':
      if (big) return slots < 7 ? 1 : slots < 11 ? 2 : slots < 16 ? 3 : 4;
      return slots < 2.8 ? 1 : slots < 4.8 ? 2 : 3;
    default:
      if (big) return slots < 7 ? 1 : slots < 11 ? 2 : 3;
      return slots < 2.8 ? 1 : slots < 4.8 ? 2 : 3;
  }
}

function firmSpec(eco: Economy, f: Firm, lot: Lot): BuildingSpriteSpec {
  const big = lot.w >= 2;
  const state = f.status === 'closed' ? 'closed' : f.health === 'distressed' ? 'distressed' : 'normal';
  const base = { w: lot.w, d: lot.d, variant: f.id, state, front: frontOf(lot), accent: f.color } as const;
  switch (f.sector) {
    case 'retail':
      return { ...base, kind: 'shop', level: firmLevel(f, big), subtype: f.subtype === 'supermarket' ? 'grocery' : f.subtype === 'department' ? 'clothing' : f.subtype, sign: big ? shortSign(f.name) : undefined };
    case 'service':
      if (big) return { ...base, kind: 'office', level: firmLevel(f, big), subtype: f.subtype, sign: shortSign(f.name) };
      return { ...base, kind: 'service', level: firmLevel(f, big), subtype: f.subtype };
    case 'factory':
      return { ...base, kind: 'factory', level: firmLevel(f, big), subtype: f.subtype };
    case 'builder':
      return { ...base, kind: 'builder', level: firmLevel(f, big), sign: shortSign(f.name) };
  }
  void eco;
}

function shortSign(name: string): string {
  const w = name.replace(/['’]s\b/g, '').split(/\s+/).filter((x) => !/^(the|&|and|inc\.?|co\.?|ltd\.?)$/i.test(x));
  let s = w[0] ?? name;
  if (s.length <= 5 && w[1]) s = `${s} ${w[1]}`;
  return s.slice(0, 10).toUpperCase();
}

export function buildLotVisuals(eco: Economy): LotVisual[] {
  const out: LotVisual[] = [];
  const city = eco.city;
  // Genesis Mode: lots where a decision is waiting for the player (true = it stops the clock)
  const decisions = new Map<number, boolean>();
  if (eco.genesis) for (const s of eco.genesis.open()) if (s.lotId >= 0) decisions.set(s.lotId, (decisions.get(s.lotId) ?? false) || s.blocking);
  // Genesis Mode: land well away from the settlement is still wild (no plots marked out for sale)
  const settled: { x: number; y: number }[] = [];
  if (eco.genesis) for (const lid of eco.lotUse.keys()) settled.push({ x: city.lots[lid].x, y: city.lots[lid].y });
  const reach = eco.genesis ? 6 + Math.sqrt(eco.population()) * 1.2 : 0;
  const wild = (lot: Lot) => !!eco.genesis && !settled.some((p) => Math.abs(p.x - lot.x) + Math.abs(p.y - lot.y) <= reach);
  for (const lot of city.lots) {
    const use = eco.lotUse.get(lot.id);
    let spec: BuildingSpriteSpec;
    let select: Selection = { kind: 'lot', id: lot.id };
    let label = 'Empty lot';
    let detail: string | undefined;
    let icon: IconKind | undefined;
    let urgent = false;
    let color: string | undefined;
    const signs: Sign[] = [];
    const base = { w: lot.w, d: lot.d, variant: lot.id, front: frontOf(lot) };
    if (!use) {
      spec = lot.zone === 'park' ? { ...base, kind: 'park', level: 1 } : { ...base, kind: 'emptylot', level: 1, state: wild(lot) ? 'wild' : undefined };
      if (lot.zone === 'park') label = 'Park';
      else label = lot.zone === 'res' ? 'Vacant residential lot' : lot.zone === 'ind' ? 'Vacant industrial lot' : 'Vacant commercial lot';
    } else {
      switch (use.type) {
        case 'cb':
          spec = { ...base, kind: 'centralbank', level: 1, sign: 'RESERVE BANK' };
          select = { kind: 'cb' };
          label = eco.cb.name;
          break;
        case 'cityhall':
          spec = { ...base, kind: 'cityhall', level: 1 };
          select = { kind: 'cityhall' };
          label = 'City Hall';
          break;
        case 'fund': {
          const f = eco.fund;
          const up = f.nav >= f.lastNav;
          spec = { ...base, kind: 'fund', level: 1, accent: up ? '#3fbf6a' : '#d9534f', sign: 'MERIDIAN' };
          select = { kind: 'fund' };
          label = f.name;
          break;
        }
        case 'park':
          spec = { ...base, kind: 'park', level: 1 };
          label = 'Park';
          break;
        case 'bank': {
          const b = eco.bank(use.id);
          if (!b) {
            spec = { ...base, kind: 'emptylot', level: 1 };
            break;
          }
          let assets = b.reserves + b.bills + b.bondBook;
          for (const l of b.loans) if (l.active) assets += l.balance;
          const level = assets < 4e6 ? 1 : assets < 8e6 ? 2 : 3;
          const state = !b.alive ? 'failed' : b.status === 'run' || b.stress > 0.45 ? 'distressed' : 'normal';
          spec = { ...base, kind: 'bank', level, accent: b.color, sign: b.short, state };
          select = { kind: 'bank', id: b.id };
          label = b.alive ? b.name : `${b.name} (failed)`;
          color = b.color;
          if (b.alive) {
            const m = metrics(eco, b);
            detail = `${b.status === 'run' ? 'BANK RUN · ' : ''}${b.stance === 'frozen' ? 'not lending' : b.stance === 'tightening' ? 'tightening credit' : b.stance === 'loosening' ? 'lending freely' : 'lending normally'} · capital ${(m.capitalRatio * 100).toFixed(1)}%`;
          }
          if (!b.alive) icon = 'lock';
          else if (b.status === 'run') {
            icon = 'alarm';
            urgent = true;
          } else if (b.cbLoanEmergency || b.stress > 0.45) icon = 'warning';
          break;
        }
        case 'firm': {
          const f = eco.firm(use.id);
          if (!f) {
            spec = { ...base, kind: 'emptylot', level: 1 };
            break;
          }
          spec = firmSpec(eco, f, lot);
          const proj = f.project >= 0 ? eco.projects.get(f.project) : undefined;
          if (f.status === 'planned' && !proj) {
            // a business that so far exists only on paper (Genesis Mode): pegged-out land and a plan
            spec = { ...base, kind: 'emptylot', level: 1 };
            signs.push({ kind: 'sign_lot', ...signSpot(lot) });
            select = { kind: 'firm', id: f.id };
            label = `${f.name} (proposed)`;
            detail = 'Plans drawn up — waiting for a loan';
            icon = 'plan';
            color = f.color;
            break;
          }
          if (f.status === 'planned' && proj && proj.status !== 'complete') {
            // a new business: its premises are still a building site
            const progress = proj.work > 0 ? 1 - proj.remaining / proj.work : 0;
            spec = {
              ...base,
              kind: 'construction',
              level: 1,
              progress: Math.max(0.05, Math.min(1, progress)),
              target: { kind: spec.kind, level: spec.level, subtype: f.subtype },
              state: proj.status === 'stalled' ? 'stalled' : 'normal',
            };
          } else if (f.status === 'open' && proj && proj.status === 'active') {
            // expanding: a crane rises behind the building
            signs.push({ kind: 'crane', tx: lot.x + 0.35, ty: lot.y + 0.35, behind: true });
          }
          select = { kind: 'firm', id: f.id };
          label = f.status === 'closed' ? `${f.name} (closed)` : f.name;
          color = f.color;
          if (f.status === 'open')
            detail = `${f.workers.length} staff${f.vacancies > 0 ? ' · hiring' : ''} · sales ${fmtMoney(f.last.revenue)}/mo${f.health === 'distressed' ? ' · in trouble' : f.debt() > 0 ? ` · owes ${fmtMoney(f.debt())}` : ''}`;
          else if (f.status === 'planned') detail = 'Opening soon';
          if (f.status === 'closed') {
            if (eco.day - f.closedDay < 45) icon = 'zzz';
          } else if (f.health === 'distressed') icon = 'warning';
          else if (f.project >= 0) icon = 'hammer';
          if (f.status === 'open') {
            const sp = signSpot(lot);
            if (f.vacancies > 0 && f.sector !== 'builder') signs.push({ kind: 'sign_hiring', ...sp });
            else if (f.discounting && f.sector === 'retail') signs.push({ kind: 'sign_sale', ...sp });
          }
          break;
        }
        case 'project': {
          const p = eco.projects.get(use.id);
          if (!p) {
            spec = { ...base, kind: 'emptylot', level: 1 };
            break;
          }
          const tgt = p.target;
          const client = eco.firm(p.clientId);
          const targetKind = tgt.kind === 'house' ? 'house' : tgt.kind === 'apartment' ? 'apartment' : client ? firmSpec(eco, client, lot).kind : 'office';
          const progress = p.work > 0 ? 1 - p.remaining / p.work : 0;
          spec = {
            ...base,
            kind: 'construction',
            level: 1,
            progress: Math.max(0.05, Math.min(1, progress)),
            target: { kind: targetKind, level: Math.max(1, Math.min(4, tgt.level)), subtype: client?.subtype },
            state: p.status === 'stalled' ? 'stalled' : 'normal',
            accent: eco.firm(p.builderId)?.color,
          };
          select = { kind: 'project', id: p.id };
          label = p.status === 'stalled' ? 'Stalled construction site' : 'Construction site';
          detail = `${Math.round(progress * 100)}% built · ${fmtMoney(p.cost)}${client ? ` · for ${client.name}` : ''}`;
          icon = p.status === 'stalled' ? 'warning' : 'hammer';
          break;
        }
        case 'res':
        default: {
          const units = eco.lotUnits.get(lot.id) ?? [];
          let occupied = 0;
          let listed: 'sale' | 'foreclosed' | null = null;
          let sold = false;
          let forRent = false;
          let q = 0;
          for (const uid of units) {
            const u = eco.units[uid];
            q += u.quality;
            if (u.occupantId >= 0) occupied++;
            if (u.listing) {
              const seller = eco.agents.get(u.listing.seller);
              if (seller && seller.kind === 'bank') listed = 'foreclosed';
              else if (!listed) listed = 'sale';
            } else if (u.occupantId < 0 && u.ownerId >= 0) {
              const owner = eco.agents.get(u.ownerId);
              if (owner && (owner.kind === 'household' || owner.kind === 'fund')) forRent = true;
            }
            if (u.lastSale.day >= 0 && eco.day - u.lastSale.day < 20) sold = true;
          }
          q = units.length ? q / units.length : 1;
          const n = units.length;
          if (lot.w >= 2) spec = { ...base, kind: 'apartment', level: n <= 4 ? 1 : n <= 6 ? 2 : n <= 8 ? 3 : 4 };
          else spec = { ...base, kind: 'house', level: q > 1.02 ? 2 : 1 };
          if (n > 0 && occupied === 0) spec.state = 'vacant';
          label = lot.w >= 2 ? `Apartments (${occupied}/${n} occupied)` : occupied ? 'House' : 'Empty house';
          if (units.length) {
            const u0 = eco.units[units[0]];
            detail = `${lot.w >= 2 ? 'Flats' : 'Home'} worth ~${fmtMoney(u0.baseValue * q * eco.market.hpi)} · rent ${fmtMoney(u0.rent)}${listed ? ' · FOR SALE' : ''}`;
          }
          const sp = signSpot(lot);
          if (listed === 'foreclosed') signs.push({ kind: 'sign_foreclosed', ...sp });
          else if (listed) signs.push({ kind: 'sign_forsale', ...sp });
          else if (sold) signs.push({ kind: 'sign_sold', ...sp });
          else if (forRent) signs.push({ kind: 'sign_forrent', ...sp });
          break;
        }
      }
    }
    const waiting = decisions.get(lot.id);
    if (waiting !== undefined && icon !== 'alarm') {
      icon = 'decision';
      urgent = waiting;
      detail = detail ? `${detail} · a decision is waiting for you` : 'A decision is waiting for you';
    }
    const sprite = buildingSprite(spec);
    const p = tileToScreen(lot.x, lot.y);
    out.push({
      lot,
      sprite,
      wx: p.x,
      wy: p.y,
      sort: lot.x + lot.w + lot.y + lot.d,
      sort2: lot.x + lot.y,
      select,
      label,
      detail,
      icon,
      urgent,
      signs,
      color,
    });
  }
  return out;
}

/** Sprite for a sign prop (memoised by the sprite library). */
export function signSprite(kind: PropKind): Sprite {
  return propSprite(kind, 0);
}
