// The city view: draws the living town (ground, buildings, street life, money in motion and data
// lenses) and turns clicks on the map into selections.

import { Camera } from './camera';
import { buildGround, buildLotVisuals, signSprite, type Ground, type LotVisual } from './cityView';
import { Traffic, type Mover } from './traffic';
import { Effects, type Link } from './effects';
import { groundTile, iconSprite, personSprite, propSprite, shoreTile, type Sprite } from './sprites';
import { HALF_H, HALF_W, ROAD_E, screenToTile, tileToScreen, type Dir } from './iso';
import type { Game, Lens, Selection } from '../game/game';
import { FIRST_BANK_ORIGIN, ORIGIN_LEGACY, ORIGIN_PUBLIC, MAX_ORIGINS } from '../sim/ledger';
import { unitValue } from '../sim/banking';
import { isUiEvent } from '../ui';

interface Drawable {
  sort: number;
  sort2: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

export interface LensColumn {
  lot: LotVisual;
  color: string;
  height: number;
}

export interface LensLegend {
  title: string;
  items: { color: string; label: string }[];
}

const alphaMasks = new WeakMap<HTMLCanvasElement, Uint8ClampedArray>();
function alphaAt(c: HTMLCanvasElement, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return 0;
  let m = alphaMasks.get(c);
  if (!m) {
    const ctx = c.getContext('2d');
    if (!ctx) return 255;
    m = ctx.getImageData(0, 0, c.width, c.height).data;
    alphaMasks.set(c, m);
  }
  return m[(Math.floor(y) * c.width + Math.floor(x)) * 4 + 3];
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly camera = new Camera();
  private dpr = 1;
  private ground!: Ground;
  lots: LotVisual[] = [];
  private lotById = new Map<number, LotVisual>();
  readonly traffic: Traffic;
  readonly effects = new Effects();
  private dirty = true;
  private waterFrame = 0;
  private waterClock = 0;
  private hover: { lot?: LotVisual; mover?: Mover } | null = null;
  private tipEl: HTMLDivElement;
  private drag: { x: number; y: number; moved: number; id: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private time = 0;
  private lastLinkKey = '';
  private bankDoors = new Map<number, { x: number; y: number; dir: Dir }>();
  /** called when the player clicks something on the map */
  onPick: (sel: Selection, screen: { x: number; y: number }) => void = () => {};

  constructor(
    parent: HTMLElement,
    private game: Game,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'world';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.tipEl = document.createElement('div');
    this.tipEl.className = 'mi-tooltip map-tip';
    this.tipEl.style.display = 'none';
    document.body.appendChild(this.tipEl);
    this.traffic = new Traffic(game.eco.city);
    this.setupWorld();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.installInput();
    game.on.day.push(() => {
      this.dirty = true;
    });
    game.on.select.push(() => {
      this.lastLinkKey = '';
    });
    game.on.newGame.push(() => {
      this.setupWorld();
      this.traffic.reset(this.game.eco.city);
      this.effects.clear();
    });
  }

  private setupWorld(): void {
    const city = this.game.eco.city;
    this.ground = buildGround(city);
    this.dirty = true;
    this.refreshLots();
    // start centred on the Reserve Bank
    const cb = city.lots.find((l) => l.reserved === 'centralbank')!;
    const c = tileToScreen(cb.x + 1.5, cb.y + 3.5);
    this.camera.bounds = {
      x0: -city.H * HALF_W,
      y0: -100,
      x1: city.W * HALF_W,
      y1: (city.W + city.H) * HALF_H,
    };
    this.camera.centerOn(c.x, c.y, false);
  }

  resize(): void {
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.camera.w = w;
    this.camera.h = h;
    if (w < 700 && this.camera.zoom > 1) this.camera.setZoom(1);
  }

  // ---------------------------------------------------------------------------- world state

  private refreshLots(): void {
    this.lots = buildLotVisuals(this.game.eco);
    this.lotById.clear();
    for (const l of this.lots) this.lotById.set(l.lot.id, l);
    this.bankDoors.clear();
    for (const l of this.lots) {
      if (l.select?.kind !== 'bank') continue;
      const p = this.frontPoint(l);
      this.bankDoors.set(l.select.id, p);
    }
    this.dirty = false;
  }

  /** Where a queue forms: on the pavement in front of the building's (visible) door. */
  private frontPoint(l: LotVisual): { x: number; y: number; dir: Dir } {
    const lot = l.lot;
    const right = lot.facing === ROAD_E;
    if (l.sprite.door) {
      const wx = l.wx - l.sprite.ax + l.sprite.door.x;
      const wy = l.wy - l.sprite.ay + l.sprite.door.y;
      const t = screenToTile(wx, wy);
      return right ? { x: lot.x + lot.w + 0.14, y: Math.max(lot.y + 0.1, t.y - 0.1), dir: 1 } : { x: Math.max(lot.x + 0.1, t.x - 0.1), y: lot.y + lot.d + 0.14, dir: 0 };
    }
    return right ? { x: lot.x + lot.w + 0.14, y: lot.y + 0.3, dir: 1 } : { x: lot.x + 0.3, y: lot.y + lot.d + 0.14, dir: 0 };
  }

  lotVisual(lotId: number): LotVisual | undefined {
    return this.lotById.get(lotId);
  }

  /** World point above a lot's building (where money arcs start and icons float). */
  lotAnchor(lotId: number, raise = 0.55): { x: number; y: number } | null {
    const l = this.lotById.get(lotId);
    if (!l) return null;
    const c = tileToScreen(l.lot.x + l.lot.w / 2, l.lot.y + l.lot.d / 2);
    const top = l.sprite.top ? { x: l.wx - l.sprite.ax + l.sprite.top.x, y: l.wy - l.sprite.ay + l.sprite.top.y } : { x: c.x, y: c.y - 20 };
    return { x: c.x + (top.x - c.x) * raise, y: c.y + (top.y - c.y) * raise };
  }

  agentAnchor = (id: number): { x: number; y: number } | null => {
    const eco = this.game.eco;
    if (id === eco.world.id) {
      const g = eco.city.gateway;
      return tileToScreen(g.x + 0.5, g.y + 0.5);
    }
    if (id === eco.treasuryId) {
      const l = eco.city.lots.find((x) => x.reserved === 'cityhall');
      return l ? this.lotAnchor(l.id) : null;
    }
    const lot = eco.lotOf(id);
    return lot >= 0 ? this.lotAnchor(lot) : null;
  };

  /** Pan the camera to an agent or lot. */
  focusAgent(id: number): void {
    const p = this.agentAnchor(id);
    if (p) this.camera.centerOn(p.x, p.y + 20);
  }

  focusLot(lotId: number): void {
    const p = this.lotAnchor(lotId, 0.3);
    if (p) this.camera.centerOn(p.x, p.y + 10);
  }

  // ---------------------------------------------------------------------------- frame

  frame(dt: number, simSteps: number): void {
    this.time += dt;
    const g = this.game;
    if (this.dirty) this.refreshLots();
    if (simSteps > 0) {
      const flows = g.flows;
      const events = g.events;
      g.flows = [];
      g.events = [];
      this.effects.enabled = g.showFlows;
      this.effects.onDay(g.eco, flows, events, this.agentAnchor, g.speed);
      this.traffic.onDay(g.eco, flows, events);
      this.traffic.updateQueues(g.eco, this.bankDoors);
    }
    this.traffic.ambient(g.eco, dt, g.speed);
    this.traffic.update(dt, g.speed);
    this.effects.update(dt);
    this.camera.update(dt);
    this.waterClock += dt;
    if (this.waterClock > 0.45) {
      this.waterClock = 0;
      this.waterFrame = (this.waterFrame + 1) % 4;
    }
    this.updateLinks();
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const z = cam.zoom * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1d2a22';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    // snap the camera to whole device pixels so sprites stay crisp
    const tx = Math.round(this.canvas.width / 2 - cam.x * z);
    const ty = Math.round(this.canvas.height / 2 - cam.y * z);
    ctx.setTransform(z, 0, 0, z, tx, ty);
    const v = cam.view(64);
    // ground
    const gr = this.ground;
    ctx.drawImage(gr.canvas, gr.ox, gr.oy);
    // animated water
    for (const w of gr.water) {
      const p = tileToScreen(w.x, w.y);
      if (p.x < v.x0 - 40 || p.x > v.x1 + 40 || p.y < v.y0 - 40 || p.y > v.y1 + 40) continue;
      const s = w.mask ? shoreTile(w.mask, this.waterFrame) : groundTile('water', w.v, this.waterFrame);
      ctx.drawImage(s.canvas, p.x - s.ax, p.y - s.ay);
    }
    // objects in painter's order
    const items: Drawable[] = [];
    const inView = (x: number, y: number, s: Sprite) =>
      x - s.ax < v.x1 && x - s.ax + s.canvas.width > v.x0 && y - s.ay < v.y1 && y - s.ay + s.canvas.height > v.y0;
    for (const b of gr.bridges) {
      const p = tileToScreen(b.x, b.y);
      if (!inView(p.x, p.y, b.sprite)) continue;
      items.push({ sort: b.x + b.y + 2, sort2: b.x + b.y, draw: (c) => c.drawImage(b.sprite.canvas, p.x - b.sprite.ax, p.y - b.sprite.ay) });
    }
    for (const l of this.lots) {
      if (!inView(l.wx, l.wy, l.sprite)) continue;
      items.push({ sort: l.sort, sort2: l.sort2, draw: (c) => c.drawImage(l.sprite.canvas, l.wx - l.sprite.ax, l.wy - l.sprite.ay) });
      for (const s of l.signs) {
        const sp = signSprite(s.kind);
        const p = tileToScreen(s.tx, s.ty);
        items.push({ sort: s.behind ? l.sort - 0.01 : l.sort + 0.01, sort2: l.sort2, draw: (c) => c.drawImage(sp.canvas, Math.round(p.x - sp.ax), Math.round(p.y - sp.ay)) });
      }
    }
    for (const d of this.game.eco.city.decorations) {
      const sp = propSprite(d.kind, d.variant);
      const p = tileToScreen(d.x + 0.5, d.y + 0.5);
      if (!inView(p.x, p.y, sp)) continue;
      items.push({ sort: d.x + d.y + 2, sort2: d.x + d.y, draw: (c) => c.drawImage(sp.canvas, p.x - sp.ax, p.y - sp.ay) });
    }
    for (const m of this.traffic.movers) {
      const p = tileToScreen(m.px, m.py);
      const sp = this.traffic.spriteOf(m);
      if (!inView(p.x, p.y, sp)) continue;
      const mk = this.moverKey(m.px, m.py);
      items.push({
        sort: mk,
        sort2: mk,
        draw: (c) => {
          c.globalAlpha = m.alpha;
          c.drawImage(sp.canvas, Math.round(p.x - sp.ax), Math.round(p.y - sp.ay));
          c.globalAlpha = 1;
        },
      });
    }
    // bank-run queues
    const perBank = new Map<number, number>();
    for (const q of this.traffic.queues) {
      const i = perBank.get(q.bankId) ?? 0;
      perBank.set(q.bankId, i + 1);
      const dv = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ][q.dir];
      // a snaking line along the pavement: two rows once it gets long
      const row = i % 13;
      const lane = Math.floor(i / 13);
      const tx0 = q.x + dv[0] * row * 0.15 + (q.dir === 0 ? 0 : 0.2) * lane;
      const ty0 = q.y + dv[1] * row * 0.15 + (q.dir === 0 ? 0.2 : 0) * lane;
      const p = tileToScreen(tx0, ty0);
      const face = (q.dir === 0 ? 2 : 3) as Dir;
      const sp = personSprite(face, Math.floor(q.phase * 1.5 + i) % 2 === 0 ? 0 : Math.floor(this.time * 3 + i) % 2, q.color);
      const qk = this.moverKey(tx0, ty0);
      items.push({ sort: qk, sort2: qk, draw: (c) => c.drawImage(sp.canvas, Math.round(p.x - sp.ax), Math.round(p.y - sp.ay)) });
    }
    items.sort((a, b) => a.sort - b.sort || a.sort2 - b.sort2);
    for (const it of items) it.draw(ctx);

    // lens (data view)
    if (this.game.lens !== 'none') this.drawLens(ctx, this.game.lens);
    // selection & hover outlines
    this.drawHighlights(ctx);
    // money in motion and relationships
    if (this.game.showLinks) this.effects.drawLinks(ctx, cam.zoom);
    if (this.game.showFlows) this.effects.drawCoins(ctx, cam.zoom);
    this.effects.drawBursts(ctx);
    this.drawIcons(ctx);
    this.effects.drawTexts(ctx, cam.zoom);
  }

  /**
   * Painter's key for something small standing on the ground. Anything on the street just in
   * front of a building's visible faces must be drawn after that building.
   */
  private moverKey(px: number, py: number): number {
    let k = px + py + 1;
    const city = this.game.eco.city;
    const tx = Math.floor(px);
    const ty = Math.floor(py);
    for (const [nx, ny] of [
      [tx, ty - 1],
      [tx - 1, ty],
      [tx, ty],
    ]) {
      if (nx < 0 || ny < 0 || nx >= city.W || ny >= city.H) continue;
      const lid = city.lotAt[ny * city.W + nx];
      if (lid < 0) continue;
      const lv = this.lotById.get(lid);
      if (lv) k = Math.max(k, lv.sort + 0.005);
    }
    return k;
  }

  private drawIcons(ctx: CanvasRenderingContext2D): void {
    const v = this.camera.view(40);
    for (const l of this.lots) {
      if (!l.icon || !l.sprite.top) continue;
      const x = l.wx - l.sprite.ax + l.sprite.top.x;
      const y = l.wy - l.sprite.ay + l.sprite.top.y;
      if (x < v.x0 || x > v.x1 || y < v.y0 || y > v.y1) continue;
      const sp = iconSprite(l.icon);
      const bob = Math.round(Math.sin(this.time * (l.urgent ? 9 : 3) + l.lot.id) * (l.urgent ? 2 : 1));
      if (l.urgent && Math.floor(this.time * 4) % 2 === 0) ctx.globalAlpha = 0.75;
      ctx.drawImage(sp.canvas, Math.round(x - sp.ax), Math.round(y - sp.ay + bob));
      ctx.globalAlpha = 1;
    }
  }

  private footprint(ctx: CanvasRenderingContext2D, l: LotVisual): void {
    const lot = l.lot;
    const a = tileToScreen(lot.x, lot.y);
    const b = tileToScreen(lot.x + lot.w, lot.y);
    const c = tileToScreen(lot.x + lot.w, lot.y + lot.d);
    const d = tileToScreen(lot.x, lot.y + lot.d);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
  }

  private drawHighlights(ctx: CanvasRenderingContext2D): void {
    const z = this.camera.zoom;
    const sel = this.selectedLot();
    if (this.hover?.lot && this.hover.lot !== sel) {
      this.footprint(ctx, this.hover.lot);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1 / z;
      ctx.stroke();
    }
    if (sel) {
      const pulse = 0.55 + 0.45 * Math.sin(this.time * 5);
      this.footprint(ctx, sel);
      ctx.strokeStyle = `rgba(255,220,80,${pulse})`;
      ctx.lineWidth = 2 / z;
      ctx.stroke();
      // bouncing marker above the building
      const top = sel.sprite.top ?? { x: sel.sprite.ax, y: 0 };
      const x = Math.round(sel.wx - sel.sprite.ax + top.x);
      const y = Math.round(sel.wy - sel.sprite.ay + top.y - 18 - Math.abs(Math.sin(this.time * 4)) * 5);
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 1);
      ctx.lineTo(x + 6, y - 1);
      ctx.lineTo(x + 0.5, y + 7);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffd84a';
      ctx.beginPath();
      ctx.moveTo(x - 3.5, y);
      ctx.lineTo(x + 4.5, y);
      ctx.lineTo(x + 0.5, y + 5);
      ctx.closePath();
      ctx.fill();
    }
  }

  private selectedLot(): LotVisual | undefined {
    const s = this.game.selection;
    if (!s) return undefined;
    const eco = this.game.eco;
    switch (s.kind) {
      case 'firm':
        return this.lotById.get(eco.firm(s.id)?.lotId ?? -1);
      case 'bank':
        return this.lotById.get(eco.bank(s.id)?.lotId ?? -1);
      case 'household':
        return this.lotById.get(eco.lotOf(s.id));
      case 'lot':
        return this.lotById.get(s.id);
      case 'project':
        return this.lotById.get(eco.projects.get(s.id)?.lotId ?? -1);
      case 'cb':
        return this.lotById.get(eco.cb.lotId);
      case 'fund':
        return this.lotById.get(eco.fund.lotId);
      case 'cityhall':
        return this.lots.find((l) => l.select?.kind === 'cityhall');
      case 'loan': {
        const l = eco.loans.get(s.id);
        return l ? this.lotById.get(eco.lotOf(l.borrowerId)) : undefined;
      }
    }
  }

  // ---------------------------------------------------------------------------- lenses

  lensLegend(lens: Lens): LensLegend | null {
    const eco = this.game.eco;
    switch (lens) {
      case 'banks':
        return { title: 'Where deposits are held', items: eco.banks.filter((b) => b.alive).map((b) => ({ color: b.color, label: b.name })) };
      case 'debt':
        return {
          title: 'Debt and arrears',
          items: [
            { color: '#4caf50', label: 'No debt' },
            { color: '#e8d24a', label: 'Paying on time' },
            { color: '#ff9a3c', label: 'Behind on payments' },
            { color: '#ff4040', label: 'Non-performing' },
            { color: '#b070ff', label: 'Repossessed / closed' },
          ],
        };
      case 'origin':
        return {
          title: 'Which bank created this money?',
          items: [
            { color: '#8a8a96', label: 'Money from before the game' },
            { color: '#c09cff', label: 'Public spending (City Hall)' },
            ...eco.banks.map((b) => ({ color: b.color, label: `Created by ${b.short}` })),
          ],
        };
      case 'value':
        return {
          title: 'Property value (per home)',
          items: [
            { color: '#3a6ea5', label: 'Cheap' },
            { color: '#4caf50', label: 'Average' },
            { color: '#e8d24a', label: 'Pricey' },
            { color: '#ff4040', label: 'Very expensive' },
          ],
        };
      case 'jobs':
        return {
          title: 'Jobs',
          items: [
            { color: '#4caf50', label: 'Everyone employed / hiring' },
            { color: '#e8d24a', label: 'Some jobless / steady' },
            { color: '#ff4040', label: 'Many jobless / cutting' },
            { color: '#8a8a96', label: 'Closed' },
          ],
        };
    }
    return null;
  }

  private lensColumns(lens: Lens): LensColumn[] {
    const eco = this.game.eco;
    const cols: LensColumn[] = [];
    const bankColor = (id: number) => eco.bank(id)?.color ?? '#888';
    for (const l of this.lots) {
      const use = eco.lotUse.get(l.lot.id);
      if (!use) continue;
      const accts: { acct: import('../sim/ledger').Account; loans: import('../sim/loan').Loan[] }[] = [];
      let residents = 0;
      let jobless = 0;
      if (use.type === 'res') {
        for (const uid of eco.lotUnits.get(l.lot.id) ?? []) {
          const u = eco.units[uid];
          const h = eco.household(u.occupantId);
          if (!h) continue;
          accts.push({ acct: h.acct, loans: h.loans });
          residents++;
          if (!h.employed && !h.retired) jobless++;
        }
      } else if (use.type === 'firm') {
        const f = eco.firm(use.id);
        if (f) accts.push({ acct: f.acct, loans: f.loans });
      }
      switch (lens) {
        case 'banks': {
          if (!accts.length) continue;
          const by = new Map<number, number>();
          let tot = 0;
          for (const a of accts) {
            by.set(a.acct.bank.id, (by.get(a.acct.bank.id) ?? 0) + Math.max(1, a.acct.balance));
            tot += a.acct.balance;
          }
          const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0][0];
          cols.push({ lot: l, color: bankColor(top), height: 6 + Math.min(60, Math.sqrt(Math.max(0, tot)) / 12) });
          break;
        }
        case 'debt': {
          if (use.type === 'firm' && eco.firm(use.id)?.status === 'closed') {
            cols.push({ lot: l, color: '#b070ff', height: 8 });
            break;
          }
          let debt = 0;
          let worst = 0;
          let reo = false;
          for (const uid of eco.lotUnits.get(l.lot.id) ?? []) {
            const owner = eco.agents.get(eco.units[uid].ownerId);
            if (owner && owner.kind === 'bank') reo = true;
          }
          for (const a of accts)
            for (const ln of a.loans) {
              if (!ln.active) continue;
              debt += ln.balance;
              worst = Math.max(worst, ln.status === 'nonperforming' ? 3 : ln.status === 'late' ? 2 : 1);
            }
          if (!accts.length && !reo) continue;
          const color = reo ? '#b070ff' : ['#4caf50', '#e8d24a', '#ff9a3c', '#ff4040'][worst];
          cols.push({ lot: l, color, height: 5 + Math.min(70, Math.sqrt(debt) / 8) });
          break;
        }
        case 'origin': {
          if (!accts.length) continue;
          const o = new Float64Array(MAX_ORIGINS);
          let tot = 0;
          for (const a of accts) for (let k = 0; k < MAX_ORIGINS; k++) o[k] += a.acct.origin[k];
          for (let k = 0; k < MAX_ORIGINS; k++) tot += o[k];
          let best = 0;
          for (let k = 1; k < MAX_ORIGINS; k++) if (o[k] > o[best]) best = k;
          let color = '#8a8a96';
          if (best === ORIGIN_PUBLIC) color = '#c09cff';
          else if (best >= FIRST_BANK_ORIGIN) color = eco.banks.find((b) => b.originIdx === best)?.color ?? '#888';
          else if (best === ORIGIN_LEGACY) color = '#8a8a96';
          cols.push({ lot: l, color, height: 6 + Math.min(60, Math.sqrt(Math.max(0, tot)) / 12) });
          break;
        }
        case 'value': {
          if (use.type !== 'res') continue;
          const units = eco.lotUnits.get(l.lot.id) ?? [];
          if (!units.length) continue;
          let v = 0;
          for (const uid of units) v += unitValue(eco, uid);
          v /= units.length;
          const r = v / 185_000;
          const color = r < 0.75 ? '#3a6ea5' : r < 1.05 ? '#4caf50' : r < 1.35 ? '#e8d24a' : '#ff4040';
          cols.push({ lot: l, color, height: 6 + Math.min(80, r * 30) });
          break;
        }
        case 'jobs': {
          if (use.type === 'res') {
            if (!residents) continue;
            const share = jobless / residents;
            cols.push({ lot: l, color: share === 0 ? '#4caf50' : share < 0.34 ? '#e8d24a' : '#ff4040', height: 6 + residents * 5 });
          } else if (use.type === 'firm') {
            const f = eco.firm(use.id)!;
            const color = f.status === 'closed' ? '#8a8a96' : f.vacancies > 0 ? '#4caf50' : f.health === 'distressed' || f.lossMonths > 1 ? '#ff4040' : '#e8d24a';
            cols.push({ lot: l, color, height: 6 + f.workers.length * 5 });
          }
          break;
        }
      }
    }
    return cols;
  }

  private drawLens(ctx: CanvasRenderingContext2D, lens: Lens): void {
    // dim the city, then raise a coloured column on each lot
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(8,14,30,0.55)';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    const cols = this.lensColumns(lens).sort((a, b) => a.lot.sort - b.lot.sort || a.lot.sort2 - b.lot.sort2);
    for (const c of cols) {
      const lot = c.lot.lot;
      const cx = lot.x + lot.w / 2;
      const cy = lot.y + lot.d / 2;
      const r = Math.min(lot.w, lot.d) * 0.28;
      const top = tileToScreen(cx - r, cy - r);
      const right = tileToScreen(cx + r, cy - r);
      const bottom = tileToScreen(cx + r, cy + r);
      const left = tileToScreen(cx - r, cy + r);
      const h = Math.round(c.height);
      const face = (pts: { x: number; y: number }[], col: string) => {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.closePath();
        ctx.fill();
      };
      const up = (p: { x: number; y: number }) => ({ x: p.x, y: p.y - h });
      face([left, bottom, up(bottom), up(left)], shadeHex(c.color, 0.8));
      face([bottom, right, up(right), up(bottom)], shadeHex(c.color, 0.62));
      face([up(top), up(right), up(bottom), up(left)], c.color);
      // footprint tint
      this.footprint(ctx, c.lot);
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1 / this.camera.zoom;
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------------- relationships

  private updateLinks(): void {
    const g = this.game;
    const s = g.selection;
    const key = s ? `${JSON.stringify(s)}@${g.eco.day}` : '';
    if (key === this.lastLinkKey) return;
    this.lastLinkKey = key;
    this.effects.links = s ? this.linksFor(s) : [];
  }

  private linksFor(s: NonNullable<Selection>): Link[] {
    const eco = this.game.eco;
    const out: Link[] = [];
    const A = this.agentAnchor;
    const statusColor = (st: string, base: string) => (st === 'nonperforming' ? '#ff4040' : st === 'late' ? '#ff9a3c' : base);
    const add = (from: number, to: number, color: string, width = 1, flow = 1, label?: string) => {
      const a = A(from);
      const b = A(to);
      if (!a || !b || (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1)) return;
      out.push({ a, b, color, width, flow, label });
    };
    switch (s.kind) {
      case 'bank': {
        const b = eco.bank(s.id);
        if (!b) break;
        const byLot = new Map<number, { borrower: number; bal: number; worst: string }>();
        for (const l of eco.loans.values()) {
          if (!l.active || l.servicerId !== b.id) continue;
          const lot = eco.lotOf(l.borrowerId);
          const e = byLot.get(lot);
          const rank = (st: string) => (st === 'nonperforming' ? 2 : st === 'late' ? 1 : 0);
          if (e) {
            e.bal += l.balance;
            if (rank(l.status) > rank(e.worst)) e.worst = l.status;
          } else byLot.set(lot, { borrower: l.borrowerId, bal: l.balance, worst: l.status });
        }
        const top = [...byLot.values()].sort((a, c) => c.bal - a.bal).slice(0, 30);
        for (const e of top) add(e.borrower, b.id, statusColor(e.worst, b.color), e.bal > 150_000 ? 2 : 1, 1);
        for (const w of b.wholesale) if (w.lenderKind !== 'region') add(w.lenderKind === 'bank' ? w.lenderId : eco.fund.id, b.id, '#f4f4f4', 1, 1);
        if (b.cbLoan > 0) add(eco.cb.id, b.id, '#ffffff', 2, 1);
        break;
      }
      case 'firm': {
        const f = eco.firm(s.id);
        if (!f) break;
        for (const l of f.loans) if (l.active) add(f.id, l.servicerId, statusColor(l.status, '#63ff7e'), 2, 1);
        add(f.id, f.acct.bank.id, '#9aa0b0', 1, 1);
        add(f.ownerId, f.id, '#ffd23c', 1, -1);
        for (const w of f.workers.slice(0, 24)) add(f.id, w, '#5ad2ff', 1, 1);
        break;
      }
      case 'household': {
        const h = eco.household(s.id);
        if (!h) break;
        if (h.employer >= 0) add(h.employer, h.id, '#5ad2ff', 2, 1);
        add(h.id, h.acct.bank.id, '#9aa0b0', 1, 1);
        for (const l of h.loans) if (l.active) add(h.id, l.servicerId, statusColor(l.status, '#63ff7e'), 2, 1);
        const home = eco.units[h.homeUnit];
        if (home && home.ownerId !== h.id && home.ownerId >= 0) add(h.id, home.ownerId, '#ff7ab8', 1, 1);
        for (const uid of h.ownedUnits) {
          const u = eco.units[uid];
          if (u.occupantId >= 0 && u.occupantId !== h.id) add(u.occupantId, h.id, '#ff7ab8', 1, 1);
        }
        if (h.fundUnits > 0) add(h.id, eco.fund.id, '#3cd2b4', 1, 1);
        for (const fid of h.firms) add(fid, h.id, '#ffd23c', 2, 1);
        break;
      }
      case 'fund': {
        for (const b of eco.banks) if (b.alive) add(b.id, eco.fund.id, '#3cd2b4', 2, 1);
        for (const uid of eco.fund.homeCost.keys()) {
          const u = eco.units[uid];
          const a = this.lotAnchor(u.lotId);
          const b = A(eco.fund.id);
          if (a && b) out.push({ a, b, color: '#ff7ab8', width: 1, flow: 1 });
        }
        break;
      }
      case 'cb': {
        for (const b of eco.banks) {
          if (!b.alive) continue;
          add(eco.cb.id, b.id, b.cbLoan > 0 ? '#ffffff' : '#7a8090', b.cbLoan > 0 ? 2 : 1, b.cbLoan > 0 ? 1 : 0);
        }
        break;
      }
      case 'project': {
        const p = eco.projects.get(s.id);
        if (!p) break;
        const site = this.lotAnchor(p.lotId);
        const link = (id: number, color: string) => {
          const a = A(id);
          if (a && site) out.push({ a, b: site, color, width: 2, flow: 1 });
        };
        link(p.builderId, '#ffd23c');
        const loan = eco.loans.get(p.loanId);
        if (loan) link(loan.servicerId, '#63ff7e');
        if (p.clientId !== p.builderId) link(p.clientId, '#5ad2ff');
        break;
      }
      case 'loan': {
        const l = eco.loans.get(s.id);
        if (!l) break;
        add(l.originatorId, l.borrowerId, '#63ff7e', 2, 1, 'new money');
        for (const sp of l.spentOn.slice(0, 12)) add(l.borrowerId, sp.agent, '#ffd23c', 1, 1);
        if (l.holder.kind === 'pool' || l.holder.kind === 'fund') add(l.servicerId, eco.fund.id, '#3cd2b4', 1, 1);
        break;
      }
      default:
        break;
    }
    return out;
  }

  // ---------------------------------------------------------------------------- input & picking

  pickAt(sx: number, sy: number): { lot?: LotVisual; mover?: Mover } | null {
    const w = this.camera.screenToWorld(sx, sy);
    // people and vehicles first (they are small and on top of the street)
    let best: Mover | undefined;
    let bestD = 7 / Math.max(0.5, this.camera.zoom) + 4;
    for (const m of this.traffic.movers) {
      if (!m.info && m.household === undefined) continue;
      const p = tileToScreen(m.px, m.py);
      const d = Math.hypot(p.x - w.x, p.y - 5 - w.y);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (best) return { mover: best };
    // buildings, front to back, pixel-accurate
    const sorted = this.lots.slice().sort((a, b) => b.sort - a.sort || b.sort2 - a.sort2);
    for (const l of sorted) {
      const x = w.x - (l.wx - l.sprite.ax);
      const y = w.y - (l.wy - l.sprite.ay);
      if (x < 0 || y < 0 || x >= l.sprite.canvas.width || y >= l.sprite.canvas.height) continue;
      if (alphaAt(l.sprite.canvas, x, y) > 40) return { lot: l };
    }
    return null;
  }

  private installInput(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [p1, p2] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      }
      this.drag = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId };
    });
    c.addEventListener('pointermove', (e) => {
      if (isUiEvent(e)) return;
      const prev = this.pointers.get(e.pointerId);
      if (prev) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2 && prev) {
        const [p1, p2] = [...this.pointers.values()];
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (this.pinchDist > 0 && Math.abs(d / this.pinchDist - 1) > 0.35) {
          this.camera.zoomStep(d > this.pinchDist ? 1 : -1, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
          this.pinchDist = d;
        }
        if (this.drag) this.drag.moved = 99;
        return;
      }
      if (this.drag && this.drag.id === e.pointerId) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        this.drag.moved += Math.abs(dx) + Math.abs(dy);
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
        if (this.drag.moved > 4) {
          this.camera.panBy(dx, dy);
          this.hideTip();
          c.style.cursor = 'grabbing';
        }
        return;
      }
      this.updateHover(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      c.style.cursor = '';
      if (d.moved <= 4 && e.type === 'pointerup' && e.button !== 2) this.click(e.clientX, e.clientY);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => this.hideTip());
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.camera.zoomStep(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
      },
      { passive: false },
    );
  }

  private click(sx: number, sy: number): void {
    const hit = this.pickAt(sx, sy);
    if (!hit) {
      this.game.select(null);
      this.onPick(null, { x: sx, y: sy });
      return;
    }
    if (hit.mover) {
      const m = hit.mover;
      if (m.household !== undefined && this.game.eco.household(m.household)) {
        this.onPick({ kind: 'household', id: m.household }, { x: sx, y: sy });
        return;
      }
      if (m.focus !== undefined) {
        const a = this.game.eco.agents.get(m.focus);
        if (a?.kind === 'bank') this.onPick({ kind: 'bank', id: a.id }, { x: sx, y: sy });
        else if (a?.kind === 'firm') this.onPick({ kind: 'firm', id: a.id }, { x: sx, y: sy });
        return;
      }
      return;
    }
    if (hit.lot) this.onPick(hit.lot.select, { x: sx, y: sy });
  }

  private updateHover(sx: number, sy: number): void {
    const hit = this.pickAt(sx, sy);
    this.hover = hit;
    if (!hit) {
      this.hideTip();
      this.canvas.style.cursor = '';
      return;
    }
    this.canvas.style.cursor = 'pointer';
    let text = '';
    if (hit.mover) {
      const m = hit.mover;
      text = m.info ?? '';
      if (m.household !== undefined) {
        const h = this.game.eco.household(m.household);
        if (h) text = m.info ?? h.name;
      }
    } else if (hit.lot) text = hit.lot.detail ? `${hit.lot.label}\n${hit.lot.detail}` : hit.lot.label;
    if (!text) return this.hideTip();
    this.tipEl.textContent = text;
    this.tipEl.style.display = 'block';
    const r = this.tipEl.getBoundingClientRect();
    const x = Math.min(window.innerWidth - r.width - 6, sx + 14);
    const y = Math.max(4, sy - r.height - 10);
    this.tipEl.style.left = `${x}px`;
    this.tipEl.style.top = `${y}px`;
  }

  private hideTip(): void {
    this.tipEl.style.display = 'none';
    this.hover = null;
  }
}

function shadeHex(hex: string, k: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `rgb(${r},${g},${b})`;
}

