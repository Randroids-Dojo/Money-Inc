// Money made visible: coins arcing between buildings for every kind of payment, green sparks where
// banks create new money by lending, red puffs where repayments destroy it, floating captions
// for notable events, and relationship lines for whatever the player has selected.

import { drawPixelText, measurePixelText } from './sprites';
import type { Economy } from '../sim/economy';
import type { FlowEvent, FlowKind, SimEvent } from '../sim/types';
import { fmtMoney } from '../sim/format';

export type CoinKind = 'new' | 'destroy' | 'spend' | 'wage' | 'income' | 'public' | 'bank' | 'property' | 'market';

export const COIN_COLOURS: Record<CoinKind, string> = {
  new: '#63ff7e',
  destroy: '#ff5a4a',
  spend: '#ffd23c',
  wage: '#5ad2ff',
  income: '#ff9a3c',
  public: '#c09cff',
  bank: '#f4f4f4',
  property: '#ff7ab8',
  market: '#3cd2b4',
};

export const COIN_LABELS: Record<CoinKind, string> = {
  new: 'New money (loans)',
  destroy: 'Repayments (money destroyed)',
  spend: 'Shopping',
  wage: 'Wages',
  income: 'Interest, rent & dividends',
  public: 'Taxes & public spending',
  bank: 'Bank & central-bank transfers',
  property: 'Property deals',
  market: 'Investors & securitisation',
};

export function coinKind(k: FlowKind): CoinKind | null {
  switch (k) {
    case 'loan':
      return 'new';
    case 'principal':
      return 'destroy';
    case 'spend':
      return 'spend';
    case 'wage':
      return 'wage';
    case 'interest':
    case 'rent':
    case 'dividend':
    case 'deposit_interest':
    case 'coupon':
      return 'income';
    case 'tax':
    case 'benefit':
      return 'public';
    case 'supply':
    case 'invest':
    case 'expense':
      return 'spend';
    case 'settle':
    case 'cb':
    case 'run':
    case 'resolution':
    case 'capital':
      return 'bank';
    case 'property':
      return 'property';
    case 'securitize':
    case 'assetsale':
    case 'fund':
      return 'market';
    default:
      return null;
  }
}

interface Coin {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t: number;
  dur: number;
  h: number;
  kind: CoinKind;
  size: number;
}

interface Burst {
  x: number;
  y: number;
  t: number;
  kind: 'create' | 'destroy' | 'dust';
  size: number;
}

interface FloatText {
  x: number;
  y: number;
  t: number;
  text: string;
  color: string;
  big: boolean;
}

export interface Link {
  a: { x: number; y: number };
  b: { x: number; y: number };
  color: string;
  width: number;
  /** marching direction: 1 = a -> b */
  flow: number;
  label?: string;
}

export type Anchor = (agentId: number) => { x: number; y: number } | null;

const coinCache = new Map<string, HTMLCanvasElement>();
/** A tiny pixel-art coin in the flow's colour: dark rim, bright face, a highlight. */
function coinCanvas(kind: CoinKind, size: number): HTMLCanvasElement {
  const key = `${kind}:${size}`;
  const hit = coinCache.get(key);
  if (hit) return hit;
  const r = size === 1 ? 1.6 : size === 2 ? 2.4 : 3.3;
  const d = Math.ceil(r * 2) + 1;
  const c = document.createElement('canvas');
  c.width = d;
  c.height = d;
  const g = c.getContext('2d')!;
  const col = COIN_COLOURS[kind];
  const cx = d / 2;
  for (let y = 0; y < d; y++)
    for (let x = 0; x < d; x++) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cx);
      if (dist > r + 0.5) continue;
      g.fillStyle = dist > r - 0.5 ? '#141620' : col;
      g.fillRect(x, y, 1, 1);
    }
  if (d >= 5) {
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(Math.floor(cx - r * 0.35), Math.floor(cx - r * 0.35), 1, 1);
  }
  coinCache.set(key, c);
  return c;
}

export class Effects {
  coins: Coin[] = [];
  bursts: Burst[] = [];
  texts: FloatText[] = [];
  links: Link[] = [];
  enabled = true;
  private clock = 0;
  /** coin counts by kind over the last few seconds (for the legend) */
  activity: Record<CoinKind, number> = { new: 0, destroy: 0, spend: 0, wage: 0, income: 0, public: 0, bank: 0, property: 0, market: 0 };

  onDay(eco: Economy, flows: FlowEvent[], events: SimEvent[], anchor: Anchor, simSpeed: number): void {
    if (this.enabled) this.spawnCoins(eco, flows, anchor, simSpeed);
    this.spawnTexts(eco, events, anchor, simSpeed);
  }

  private spawnCoins(eco: Economy, flows: FlowEvent[], anchor: Anchor, simSpeed: number): void {
    // aggregate the day's payments by building pair and kind
    const agg = new Map<string, { from: number; to: number; kind: CoinKind; amount: number }>();
    for (const f of flows) {
      const k = coinKind(f.kind);
      if (!k) continue;
      const la = eco.lotOf(f.from);
      const lb = eco.lotOf(f.to);
      if (la === lb && la >= 0) continue;
      const key = `${la}|${lb}|${k}`;
      const g = agg.get(key);
      if (g) g.amount += f.amount;
      else agg.set(key, { from: f.from, to: f.to, kind: k, amount: f.amount });
    }
    const list = [...agg.values()];
    // always show money creation and destruction; sample the rest, biggest first
    const budget = Math.max(6, Math.round(42 / Math.sqrt(Math.max(1, simSpeed))));
    const special = list.filter((g) => g.kind === 'new' || g.kind === 'destroy').sort((a, b) => b.amount - a.amount);
    const rest = list.filter((g) => g.kind !== 'new' && g.kind !== 'destroy');
    rest.sort((a, b) => b.amount - a.amount);
    const chosen = [...special.slice(0, Math.ceil(budget * 0.4)), ...rest.slice(0, Math.floor(budget * 0.35))];
    const tail = rest.slice(Math.floor(budget * 0.35));
    for (let i = 0; i < Math.floor(budget * 0.25) && tail.length; i++) chosen.push(tail.splice(Math.floor(Math.random() * tail.length), 1)[0]);
    for (const g of chosen) {
      if (this.coins.length > 700) break;
      const a = anchor(g.from);
      const b = anchor(g.to);
      if (!a || !b) continue;
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const size = g.amount > 100_000 ? 3 : g.amount > 10_000 ? 2 : 1;
      this.coins.push({
        x0: a.x,
        y0: a.y,
        x1: b.x,
        y1: b.y,
        t: -Math.random() * 0.6,
        dur: 0.7 + Math.min(1.4, dist / 500),
        h: 16 + Math.min(90, dist * 0.18),
        kind: g.kind,
        size,
      });
      this.activity[g.kind] += 1;
      if (g.kind === 'new' && g.amount >= 20_000) this.bursts.push({ x: a.x, y: a.y, t: 0, kind: 'create', size: Math.min(3, 1 + g.amount / 150_000) });
    }
  }

  private spawnTexts(eco: Economy, events: SimEvent[], anchor: Anchor, simSpeed: number): void {
    let n = 0;
    const cap = simSpeed >= 5 ? 3 : 6;
    for (const e of events) {
      if (n >= cap || this.texts.length > 30) break;
      let text = '';
      let color = '#ffffff';
      let big = false;
      switch (e.type) {
        case 'loan_approved':
          if ((e.amount ?? 0) < 25_000) continue;
          text = `+${fmtMoney(e.amount ?? 0)} LOAN`;
          color = '#63ff7e';
          break;
        case 'default':
          text = `DEFAULT ${fmtMoney(e.amount ?? 0)}`;
          color = '#ff5a4a';
          break;
        case 'foreclosure':
          text = 'FORECLOSED';
          color = '#ff7a4a';
          break;
        case 'firm_open':
          text = 'GRAND OPENING!';
          color = '#ffd23c';
          break;
        case 'firm_close':
          text = 'CLOSED';
          color = '#ff8a7a';
          break;
        case 'bank_run':
          if (Math.random() > 0.3) continue;
          text = 'BANK RUN!';
          color = '#ff4040';
          big = true;
          break;
        case 'bank_fail':
          text = 'BANK FAILED!';
          color = '#ff4040';
          big = true;
          break;
        case 'house_sold':
          text = `SOLD ${fmtMoney(e.amount ?? 0)}`;
          color = '#ff9ad0';
          break;
        case 'construction_start':
          text = 'BUILDING!';
          color = '#ffd23c';
          break;
        case 'construction_done':
          text = 'COMPLETED';
          color = '#63ff7e';
          break;
        case 'securitization':
          text = `PACKAGED ${fmtMoney(e.amount ?? 0)}`;
          color = '#3cd2b4';
          break;
        case 'capital_raise':
          text = `+${fmtMoney(e.amount ?? 0)} CAPITAL`;
          color = '#c09cff';
          break;
        case 'cb_loan':
          text = `RESERVE BANK LOAN ${fmtMoney(e.amount ?? 0)}`;
          color = '#f4f4f4';
          break;
        default:
          continue;
      }
      const p = anchor(e.agent);
      if (!p) continue;
      this.texts.push({ x: p.x, y: p.y - 6, t: 0, text, color, big });
      n++;
      if (e.type === 'bank_fail' || e.type === 'firm_close' || e.type === 'default') this.bursts.push({ x: p.x, y: p.y, t: 0, kind: 'dust', size: 2 });
    }
  }

  update(dt: number): void {
    this.clock += dt;
    for (const c of this.coins) c.t += dt / c.dur;
    const arrived = this.coins.filter((c) => c.t >= 1);
    for (const c of arrived) if (c.kind === 'destroy' && c.size >= 2) this.bursts.push({ x: c.x1, y: c.y1, t: 0, kind: 'destroy', size: c.size });
    this.coins = this.coins.filter((c) => c.t < 1);
    for (const b of this.bursts) b.t += dt;
    this.bursts = this.bursts.filter((b) => b.t < 0.9);
    for (const t of this.texts) t.t += dt;
    this.texts = this.texts.filter((t) => t.t < 2.6);
    for (const k of Object.keys(this.activity) as CoinKind[]) this.activity[k] *= Math.exp(-dt / 3);
  }

  clear(): void {
    this.coins = [];
    this.bursts = [];
    this.texts = [];
    this.links = [];
  }

  // ---------------------------------------------------------------------------- drawing (world space)

  drawLinks(ctx: CanvasRenderingContext2D, zoom: number): void {
    const march = (this.clock * 18) % 12;
    for (const l of this.links) {
      const mx = (l.a.x + l.b.x) / 2;
      const dist = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
      const my = (l.a.y + l.b.y) / 2 - 18 - dist * 0.22;
      ctx.lineWidth = (l.width + 2) / zoom;
      ctx.strokeStyle = 'rgba(10,12,20,0.55)';
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(l.a.x, l.a.y);
      ctx.quadraticCurveTo(mx, my, l.b.x, l.b.y);
      ctx.stroke();
      ctx.lineWidth = l.width / zoom;
      ctx.strokeStyle = l.color;
      ctx.setLineDash([6 / zoom, 6 / zoom]);
      ctx.lineDashOffset = (-march * l.flow) / zoom;
      ctx.beginPath();
      ctx.moveTo(l.a.x, l.a.y);
      ctx.quadraticCurveTo(mx, my, l.b.x, l.b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // end dots
      ctx.fillStyle = l.color;
      ctx.fillRect(Math.round(l.b.x) - 1, Math.round(l.b.y) - 1, 3, 3);
    }
  }

  drawCoins(ctx: CanvasRenderingContext2D, zoom = 2): void {
    // keep coins readable when zoomed out
    const k = Math.max(1, Math.round(2 / zoom));
    for (const c of this.coins) {
      if (c.t < 0) continue;
      const e = c.t;
      const x = c.x0 + (c.x1 - c.x0) * e;
      const y = c.y0 + (c.y1 - c.y0) * e - Math.sin(Math.PI * e) * c.h;
      const fade = c.kind === 'destroy' ? 1 - Math.max(0, e - 0.7) / 0.3 : 1;
      ctx.globalAlpha = Math.max(0, Math.min(1, fade));
      const sp = coinCanvas(c.kind, c.size);
      const w = sp.width * k;
      const hgt = sp.height * k;
      ctx.drawImage(sp, Math.round(x - w / 2), Math.round(y - hgt / 2), w, hgt);
      if (c.kind === 'new' && Math.floor(e * 12) % 2 === 0) {
        // sparkle on freshly created money
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Math.round(x + w / 2), Math.round(y - hgt / 2) - k, k, k);
      }
    }
    ctx.globalAlpha = 1;
  }

  drawBursts(ctx: CanvasRenderingContext2D): void {
    for (const b of this.bursts) {
      const k = b.t / 0.9;
      const r = (4 + 10 * k) * b.size;
      ctx.globalAlpha = 1 - k;
      if (b.kind === 'create') {
        ctx.fillStyle = '#b8ffc4';
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + b.t;
          ctx.fillRect(Math.round(b.x + Math.cos(a) * r), Math.round(b.y + Math.sin(a) * r * 0.6), 2, 2);
        }
        ctx.fillStyle = '#63ff7e';
        ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y - r * 0.5), 3, 3);
      } else if (b.kind === 'destroy') {
        ctx.fillStyle = '#8a8a96';
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          ctx.fillRect(Math.round(b.x + Math.cos(a) * r * 0.6), Math.round(b.y + Math.sin(a) * r * 0.4 - r * 0.5), 3, 3);
        }
        ctx.fillStyle = '#ff5a4a';
        ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y) - 1, 2, 2);
      } else {
        ctx.fillStyle = '#b0a898';
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          ctx.fillRect(Math.round(b.x + Math.cos(a) * r * 1.2), Math.round(b.y + Math.sin(a) * r * 0.5), 3, 2);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  drawTexts(ctx: CanvasRenderingContext2D, zoom = 2): void {
    const zk = Math.max(1, Math.round(2 / zoom));
    for (const t of this.texts) {
      const k = t.t / 2.6;
      const y = t.y - 10 - k * 26 * zk;
      ctx.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
      const scale = (t.big ? 2 : 1) * zk;
      const m = measurePixelText(t.text, scale);
      ctx.fillStyle = 'rgba(12,14,22,0.7)';
      ctx.fillRect(Math.round(t.x - m.w / 2) - 2, Math.round(y) - 2, m.w + 4, m.h + 4);
      drawPixelText(ctx, t.text, t.x, y, t.color, { align: 'center', scale, shadow: '#000000' });
    }
    ctx.globalAlpha = 1;
  }
}
