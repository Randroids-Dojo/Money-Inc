// Street life that is driven by the economy: commuter traffic scales with employment, delivery
// trucks carry the goods firms actually bought, cement mixers serve live construction sites,
// armoured vans move reserves between banks, removal vans bring newcomers and take leavers away,
// and the pedestrians are real households out shopping (click one to meet them).

import { personSprite, vehicleSprite, type Sprite, type VehicleKind } from './sprites';
import { ROAD_E, ROAD_N, ROAD_S, ROAD_W, tileToScreen, type Dir } from './iso';
import { Terrain, type City } from '../world/city';
import type { Economy } from '../sim/economy';
import type { FlowEvent, SimEvent } from '../sim/types';
import { fmtMoney } from '../sim/format';

export type MoverKind = VehicleKind | 'person';

export interface Mover {
  id: number;
  kind: MoverKind;
  path: number[];
  seg: number;
  t: number;
  /** tiles per second */
  speed: number;
  color: string;
  /** lateral offset from the road centre line, in tiles (+ = right of travel) */
  lane: number;
  /** seconds to linger at the destination */
  linger: number;
  alpha: number;
  info?: string;
  household?: number;
  focus?: number;
  frame: number;
  done: boolean;
  /** world position and draw data, filled by update() */
  px: number;
  py: number;
  dir: Dir;
}

export interface Queuer {
  bankId: number;
  x: number;
  y: number;
  dir: Dir;
  color: string;
  household: number;
  phase: number;
}

const CAR_COLOURS = ['#c83c32', '#3060b0', '#e8c040', '#f0f0e8', '#40a060', '#303038', '#8a5ab0', '#d87830', '#78b8d8'];
const SHIRTS = ['#d04040', '#3070c0', '#40a050', '#e0b030', '#9050b0', '#e07030', '#30a0a0', '#e8e8e8', '#505a70'];

export class Traffic {
  movers: Mover[] = [];
  queues: Queuer[] = [];
  private seq = 1;
  private roadIdx: number[] = [];
  private pathCache = new Map<number, number[] | null>();
  private resRoads: number[] = [];
  private workRoads: number[] = [];
  private spawnAcc = 0;

  constructor(private city: City) {
    const W = city.W;
    for (let i = 0; i < city.terrain.length; i++) {
      const t = city.terrain[i];
      if (t === Terrain.Road || t === Terrain.Bridge) this.roadIdx.push(i);
    }
    for (const lot of city.lots) {
      const i = lot.road.y * W + lot.road.x;
      if (lot.zone === 'res') this.resRoads.push(i);
      else if (lot.zone === 'com' || lot.zone === 'ind' || lot.zone === 'civic') this.workRoads.push(i);
    }
  }

  reset(city: City): void {
    this.city = city;
    this.movers = [];
    this.queues = [];
    this.pathCache.clear();
    this.roadIdx = [];
    this.resRoads = [];
    this.workRoads = [];
    const W = city.W;
    for (let i = 0; i < city.terrain.length; i++) {
      const t = city.terrain[i];
      if (t === Terrain.Road || t === Terrain.Bridge) this.roadIdx.push(i);
    }
    for (const lot of city.lots) {
      const i = lot.road.y * W + lot.road.x;
      if (lot.zone === 'res') this.resRoads.push(i);
      else this.workRoads.push(i);
    }
  }

  // ---------------------------------------------------------------------------- paths

  private path(a: number, b: number): number[] | null {
    if (a === b) return null;
    const key = a * 65536 + b;
    const hit = this.pathCache.get(key);
    if (hit !== undefined) return hit;
    const { W, roadMask } = this.city;
    const prev = new Int32Array(roadMask.length).fill(-1);
    prev[a] = a;
    const q = [a];
    let found = false;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      if (c === b) {
        found = true;
        break;
      }
      const m = roadMask[c];
      const x = c % W;
      const nbrs = [m & ROAD_N ? c - W : -1, m & ROAD_E ? c + 1 : -1, m & ROAD_S ? c + W : -1, m & ROAD_W ? c - 1 : -1];
      void x;
      for (const n of nbrs) {
        if (n < 0 || prev[n] >= 0) continue;
        prev[n] = c;
        q.push(n);
      }
    }
    let res: number[] | null = null;
    if (found) {
      res = [];
      for (let c = b; c !== a; c = prev[c]) res.push(c);
      res.push(a);
      res.reverse();
    }
    if (this.pathCache.size > 4000) this.pathCache.clear();
    this.pathCache.set(key, res);
    return res;
  }

  private roadOfLot(lotId: number): number {
    const lot = this.city.lots[lotId];
    return lot ? lot.road.y * this.city.W + lot.road.x : -1;
  }

  private gatewayRoad(): number {
    return this.city.gateway.y * this.city.W + this.city.gateway.x;
  }

  spawn(kind: MoverKind, from: number, to: number, opts: Partial<Mover> = {}): Mover | null {
    if (from < 0 || to < 0) return null;
    const p = this.path(from, to);
    if (!p || p.length < 2) return null;
    const person = kind === 'person';
    const m: Mover = {
      id: this.seq++,
      kind,
      path: p,
      seg: 0,
      t: 0,
      speed: person ? 0.55 + Math.random() * 0.2 : kind === 'bus' ? 1.1 : kind === 'truck' || kind === 'mixer' ? 1.25 : 1.6 + Math.random() * 0.4,
      color: person ? SHIRTS[Math.floor(Math.random() * SHIRTS.length)] : CAR_COLOURS[Math.floor(Math.random() * CAR_COLOURS.length)],
      lane: person ? (Math.random() < 0.5 ? -0.4 : 0.4) : 0.17,
      linger: person ? 0.5 : 0.8,
      alpha: 0,
      frame: Math.random() * 2,
      done: false,
      px: 0,
      py: 0,
      dir: 0,
      ...opts,
    };
    this.movers.push(m);
    return m;
  }

  // ---------------------------------------------------------------------------- economy hooks

  /** Called once per simulated day with that day's flows and events. */
  onDay(eco: Economy, flows: FlowEvent[], events: SimEvent[]): void {
    const count = (k: MoverKind) => this.movers.reduce((s, m) => s + (m.kind === k ? 1 : 0), 0);
    // goods deliveries: the biggest factory -> buyer shipments of the day
    const ship = new Map<string, { from: number; to: number; amount: number }>();
    for (const f of flows) {
      if (f.kind !== 'supply') continue;
      const key = `${f.to}>${f.from}`;
      const s = ship.get(key);
      if (s) s.amount += f.amount;
      else ship.set(key, { from: f.to, to: f.from, amount: f.amount });
    }
    const trucks = [...ship.values()].sort((a, b) => b.amount - a.amount).slice(0, 3);
    for (const s of trucks) {
      if (count('truck') >= 10) break;
      const a = this.roadOfLot(eco.lotOf(s.from));
      const b = this.roadOfLot(eco.lotOf(s.to));
      this.spawn('truck', a, b, {
        info: `Delivery: ${fmtMoney(s.amount)} of goods from ${eco.nameOf(s.from)} to ${eco.nameOf(s.to)}`,
        focus: s.to,
        color: '#f0f0e8',
      });
    }
    // cement mixers to live construction sites
    if (count('mixer') < 6) {
      for (const p of eco.projects.values()) {
        if (p.status !== 'active' || Math.random() > 0.35) continue;
        const builder = eco.firm(p.builderId);
        const a = builder ? this.roadOfLot(builder.lotId) : -1;
        const b = this.roadOfLot(p.lotId);
        this.spawn('mixer', a >= 0 ? a : this.randomOf(this.workRoads), b, {
          info: `Cement mixer from ${builder?.name ?? 'a builder'} to a construction site`,
          focus: p.clientId,
        });
      }
    }
    // armoured vans settle reserves between banks, and bring central-bank cash
    let best: { a: number; b: number; amt: number } | null = null;
    for (const [key, amt] of eco.settlementToday) {
      if (!best || Math.abs(amt) > Math.abs(best.amt)) {
        const [a, b] = key.split('-').map(Number);
        best = amt > 0 ? { a, b, amt } : { a: b, b: a, amt: -amt };
      }
    }
    if (best && best.amt > 20_000 && count('armored') < 3 && Math.random() < 0.5) {
      const A = eco.bank(best.a);
      const B = eco.bank(best.b);
      if (A && B)
        this.spawn('armored', this.roadOfLot(A.lotId), this.roadOfLot(B.lotId), {
          info: `Interbank settlement: ${A.short} owes ${B.short} ${fmtMoney(best.amt)} of reserves today`,
          focus: B.id,
        });
    }
    for (const e of events) {
      switch (e.type) {
        case 'cb_loan': {
          const b = eco.bank(e.agent);
          if (b) this.spawn('armored', this.roadOfLot(eco.cb.lotId), this.roadOfLot(b.lotId), { info: `Reserve Bank lends ${fmtMoney(e.amount ?? 0)} to ${b.name}`, focus: b.id });
          break;
        }
        case 'arrival': {
          const lot = eco.lotOf(e.agent);
          this.spawn('van', this.gatewayRoad(), this.roadOfLot(lot), { info: `${eco.nameOf(e.agent)} moving into town`, household: e.agent, color: '#e0a040' });
          break;
        }
        case 'departure': {
          const h = eco.household(e.agent);
          const lot = h ? eco.city.lots.find((l) => l.id === (eco.units[h.homeUnit]?.lotId ?? -1)) : undefined;
          const from = lot ? this.roadOfLot(lot.id) : this.randomOf(this.resRoads);
          this.spawn('van', from, this.gatewayRoad(), { info: `${eco.nameOf(e.agent)} leaving town: ${e.text ?? ''}`, household: e.agent, color: '#a0a0a8' });
          break;
        }
      }
    }
  }

  private randomOf(a: number[]): number {
    return a.length ? a[Math.floor(Math.random() * a.length)] : -1;
  }

  /** Keep ambient traffic and shoppers at levels that follow the economy. */
  ambient(eco: Economy, dt: number, simSpeed: number): void {
    this.spawnAcc += dt;
    if (this.spawnAcc < 0.25) return;
    this.spawnAcc = 0;
    let employed = 0;
    for (const h of eco.households) if (!h.departed && h.employed) employed++;
    const cars = this.movers.filter((m) => m.kind === 'car').length;
    const carTarget = Math.round(4 + employed * 0.14);
    if (cars < carTarget) this.spawn('car', this.randomOf(this.resRoads), this.randomOf(this.workRoads));
    const buses = this.movers.filter((m) => m.kind === 'bus').length;
    if (buses < 2) this.spawn('bus', this.randomOf(this.roadIdx), this.randomOf(this.roadIdx), { color: '#e8b030', info: 'City bus' });
    // shoppers: busier when households are spending
    const spend = eco.flowsLast.lending >= 0 ? eco.monthCounters.consumption / Math.max(1, eco.dom + 1) : 0;
    const perHh = spend / Math.max(1, eco.population());
    const shopTarget = Math.round(Math.min(70, 6 + eco.population() * 0.22 * Math.min(1.6, perHh / 100)));
    const people = this.movers.filter((m) => m.kind === 'person').length;
    if (people < shopTarget) {
      const hh = eco.households[Math.floor(Math.random() * eco.households.length)];
      if (hh && !hh.departed && hh.homeUnit >= 0) {
        const favs = [...hh.favs.retail, ...hh.favs.service];
        const shopId = favs[Math.floor(Math.random() * favs.length)];
        const shop = shopId !== undefined ? eco.firm(shopId) : undefined;
        const home = eco.units[hh.homeUnit];
        if (shop && home) {
          const out = Math.random() < 0.5;
          const a = this.roadOfLot(home.lotId);
          const b = this.roadOfLot(shop.lotId);
          this.spawn('person', out ? a : b, out ? b : a, {
            household: hh.id,
            info: `${hh.name} ${out ? 'heading to' : 'coming back from'} ${shop.name}`,
            color: SHIRTS[hh.id % SHIRTS.length],
          });
        }
      }
    }
    void simSpeed;
  }

  /** People queueing outside banks that are suffering a run. */
  updateQueues(eco: Economy, doors: Map<number, { x: number; y: number; dir: Dir }>): void {
    const want = new Map<number, number>();
    for (const b of eco.banks) {
      if (b.status !== 'run') continue;
      const d = doors.get(b.id);
      if (!d) continue;
      want.set(b.id, Math.max(8, Math.min(26, Math.round(8 + (b.runOutflow / Math.max(1, b.deposits + b.runOutflow)) * 60))));
    }
    this.queues = this.queues.filter((q) => want.has(q.bankId));
    for (const [bankId, n] of want) {
      const have = this.queues.filter((q) => q.bankId === bankId);
      const d = doors.get(bankId)!;
      for (let i = have.length; i < n; i++) {
        const hh = eco.households[Math.floor(Math.random() * eco.households.length)];
        this.queues.push({
          bankId,
          x: d.x,
          y: d.y,
          dir: d.dir,
          color: SHIRTS[(hh?.id ?? i) % SHIRTS.length],
          household: hh?.id ?? -1,
          phase: i,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------- motion

  update(dt: number, simSpeed: number): void {
    const W = this.city.W;
    const pace = simSpeed === 0 ? 0 : 0.8 + 0.2 * Math.sqrt(simSpeed);
    for (const m of this.movers) {
      m.frame += dt * (m.kind === 'person' ? 6 : 0) * (pace > 0 ? 1 : 0);
      if (m.seg >= m.path.length - 1) {
        m.linger -= dt;
        m.alpha = Math.max(0, Math.min(1, m.linger * 2));
        if (m.linger <= 0) m.done = true;
      } else {
        m.alpha = Math.min(1, m.alpha + dt * 3);
        m.t += m.speed * pace * dt;
        while (m.t >= 1 && m.seg < m.path.length - 1) {
          m.t -= 1;
          m.seg++;
        }
        if (m.seg >= m.path.length - 1) m.t = 0;
      }
      // position: centre of the current tile toward the next, offset into its lane
      const a = m.path[Math.min(m.seg, m.path.length - 1)];
      const b = m.path[Math.min(m.seg + 1, m.path.length - 1)];
      const ax = (a % W) + 0.5;
      const ay = Math.floor(a / W) + 0.5;
      let dx = (b % W) + 0.5 - ax;
      let dy = Math.floor(b / W) + 0.5 - ay;
      if (dx === 0 && dy === 0) {
        const p = m.path[Math.max(0, m.path.length - 2)];
        dx = ax - ((p % W) + 0.5);
        dy = ay - (Math.floor(p / W) + 0.5);
      }
      m.dir = (dx > 0 ? 0 : dx < 0 ? 2 : dy > 0 ? 1 : 3) as Dir;
      const t = m.seg >= m.path.length - 1 ? 0 : m.t;
      m.px = ax + dx * t + -dy * m.lane;
      m.py = ay + dy * t + dx * m.lane;
    }
    this.movers = this.movers.filter((m) => !m.done);
    for (const q of this.queues) q.phase += dt;
  }

  spriteOf(m: Mover): Sprite {
    if (m.kind === 'person') return personSprite(m.dir, Math.floor(m.frame) % 2, m.color);
    return vehicleSprite(m.kind, m.dir, m.kind === 'car' || m.kind === 'van' ? m.color : undefined);
  }

  worldPos(m: { px: number; py: number }): { x: number; y: number } {
    return tileToScreen(m.px, m.py);
  }
}

export const ROAD_DIRS = { ROAD_N, ROAD_E, ROAD_S, ROAD_W };
