// Trace mode on the map (Genesis Mode): the town dims, and what the traced entity is connected to
// lights up — its direct relationships in gold, what followed further downstream in blue, where
// it came from in teal — joined by lines drawn between the buildings themselves.

import { drawPixelText, measurePixelText } from './sprites';
import type { LotVisual } from './cityView';
import { tileToScreen } from './iso';

export type TraceRole = 'root' | 'direct' | 'downstream' | 'upstream';

/** A lot to light up. */
export interface TraceSpot {
  lotId: number;
  role: TraceRole;
  depth: number;
  /** the entity or the relationship has ended (repaid, closed, left town...) */
  ended?: boolean;
  label?: string;
}

/** A place a trace line can start or end: a lot, or an agent without a lot of its own. */
export type TraceEnd = { lot: number } | { agent: number };

export interface TraceLine {
  a: TraceEnd;
  b: TraceEnd;
  role: TraceRole | 'chain';
  depth: number;
  ended?: boolean;
}

export interface TraceView {
  spots: TraceSpot[];
  lines: TraceLine[];
  /** lot of the entity the player is looking at (chain end) */
  focusLot?: number;
}

export interface TraceHost {
  lot(id: number): LotVisual | undefined;
  lotAnchor(id: number, raise?: number): { x: number; y: number } | null;
  agentAnchor(id: number): { x: number; y: number } | null;
  view(margin: number): { x0: number; y0: number; x1: number; y1: number };
}

const COLORS: Record<TraceRole | 'chain', string> = {
  root: '#ffd84a',
  direct: '#ffc93c',
  downstream: '#6fc3ff',
  upstream: '#3cd2b4',
  chain: '#ffffff',
};

function footprint(ctx: CanvasRenderingContext2D, l: LotVisual): void {
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

export function drawTrace(ctx: CanvasRenderingContext2D, host: TraceHost, view: TraceView, zoom: number, time: number): void {
  const v = host.view(200);
  // 1. the town recedes
  ctx.fillStyle = 'rgba(6, 10, 16, 0.68)';
  ctx.fillRect(v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0);

  // 2. the connected buildings come forward (back to front)
  const spots = view.spots
    .map((s) => ({ s, l: host.lot(s.lotId) }))
    .filter((x): x is { s: TraceSpot; l: LotVisual } => !!x.l)
    .sort((a, b) => a.l.sort - b.l.sort || a.l.sort2 - b.l.sort2);
  for (const { s, l } of spots) {
    ctx.globalAlpha = s.ended && s.role !== 'root' ? 0.55 : 1;
    ctx.drawImage(l.sprite.canvas, l.wx - l.sprite.ax, l.wy - l.sprite.ay);
  }
  ctx.globalAlpha = 1;
  for (const { s, l } of spots) {
    footprint(ctx, l);
    const pulse = s.role === 'root' ? 0.6 + 0.4 * Math.sin(time * 5) : 1;
    ctx.strokeStyle = COLORS[s.role];
    ctx.globalAlpha = (s.ended ? 0.5 : s.role === 'downstream' ? Math.max(0.45, 1 - 0.18 * (s.depth - 2)) : 1) * pulse;
    ctx.lineWidth = (s.role === 'root' ? 2.5 : s.role === 'downstream' ? 1 : 1.6) / zoom;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 3. the relationships between them
  const at = (e: TraceEnd) => ('lot' in e ? host.lotAnchor(e.lot) : host.agentAnchor(e.agent));
  const march = (time * 18) % 12;
  const lines = view.lines.slice().sort((a, b) => order(b.role) - order(a.role));
  for (const ln of lines) {
    const a = at(ln.a);
    const b = at(ln.b);
    if (!a || !b || (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1)) continue;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 - 14 - dist * 0.2;
    const col = COLORS[ln.role];
    const w = ln.role === 'chain' ? 3 : ln.role === 'direct' || ln.role === 'upstream' ? 2 : 1;
    const alpha = ln.ended ? 0.4 : ln.role === 'downstream' ? Math.max(0.35, 0.85 - 0.15 * (ln.depth - 2)) : 1;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = (w + 2) / zoom;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx, my, b.x, b.y);
    ctx.stroke();
    ctx.lineWidth = w / zoom;
    ctx.strokeStyle = col;
    if (ln.role === 'downstream' || ln.ended) ctx.setLineDash([5 / zoom, 4 / zoom]);
    else if (ln.role === 'chain') {
      ctx.setLineDash([8 / zoom, 5 / zoom]);
      ctx.lineDashOffset = -march / zoom;
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx, my, b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    // arrowhead at b, along the curve's tangent
    const tx = b.x - mx;
    const ty = b.y - my;
    const tl = Math.hypot(tx, ty) || 1;
    const ux = tx / tl;
    const uy = ty / tl;
    const s = (w + 3) / Math.max(0.6, zoom);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - ux * s * 1.6 - uy * s, b.y - uy * s * 1.6 + ux * s);
    ctx.lineTo(b.x - ux * s * 1.6 + uy * s, b.y - uy * s * 1.6 - ux * s);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 4. names: the root, its direct relationships and the chain being examined
  const zk = Math.max(1, Math.round(2 / zoom));
  const labelled = spots.filter(({ s }) => s.label).slice(0, 40);
  for (const { s, l } of labelled) {
    const p = host.lotAnchor(l.lot.id, 1.05);
    if (!p) continue;
    const text = s.label!;
    const m = measurePixelText(text, zk);
    const y = p.y - 8 * zk - (s.role === 'root' ? 4 * zk : 0);
    ctx.fillStyle = s.role === 'root' ? 'rgba(60,44,4,0.92)' : 'rgba(10,14,22,0.82)';
    ctx.fillRect(Math.round(p.x - m.w / 2) - 2, Math.round(y) - 2, m.w + 4, m.h + 4);
    drawPixelText(ctx, text, p.x, y, s.role === 'root' ? '#ffe68a' : COLORS[s.role], { align: 'center', scale: zk, shadow: '#000000' });
  }
}

function order(r: TraceRole | 'chain'): number {
  return r === 'chain' ? 0 : r === 'root' ? 1 : r === 'direct' || r === 'upstream' ? 2 : 3;
}
