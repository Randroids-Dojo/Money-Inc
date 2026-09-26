// Retro statistics charts on <canvas>: dark "instrument screen" look (or parchment), crisp at any
// devicePixelRatio, pixel-font axis labels, dithered area fills, hover/touch crosshair readout.

import { alpha, readableInk, SCREEN_PALETTE, PAPER_PALETTE } from './color';
import { appendChildren, h } from './dom';

export interface ChartSeries {
  label: string;
  color: string;
  values: readonly number[];
  dashed?: boolean;
  /** Fill under the line (dithered). */
  area?: boolean;
  /** Draw as bars instead of a line. */
  type?: 'line' | 'bar';
  /** Per-series value formatter for legend/readout (defaults to the chart's). */
  format?: (v: number) => string;
}

export interface ChartMarker {
  index: number;
  label: string;
  color?: string;
}

export interface ChartRefLine {
  at: number;
  label?: string;
  color?: string;
}

export interface LineChartOpts {
  series: ChartSeries[];
  /** X labels, one per index (a readable subset is drawn; all show in the hover readout). */
  labels?: readonly string[];
  /** Plot height in CSS px (default 140). */
  height?: number;
  format?: (v: number) => string;
  /** Emphasise y = 0. */
  zeroLine?: boolean;
  yMin?: number;
  yMax?: number;
  /** Vertical event markers (e.g. "Rate hike"). */
  markers?: ChartMarker[];
  /** Horizontal reference lines (e.g. a regulatory minimum). */
  refLines?: ChartRefLine[];
  /** Values are fractions (0.05) shown as percentages (5.0%). */
  percent?: boolean;
  /** 'screen' (dark instrument panel, default) or 'paper'. */
  theme?: 'screen' | 'paper';
  /** Show the legend row (default true). */
  legend?: boolean;
}

interface Theme {
  bg: string;
  scan: string | null;
  grid: string;
  gridV: string;
  text: string;
  zero: string;
  cross: string;
  outline: string;
}

const THEMES: Record<'screen' | 'paper', Theme> = {
  screen: {
    bg: '#0f2329',
    scan: 'rgba(160, 230, 240, 0.035)',
    grid: '#1f3f48',
    gridV: '#193540',
    text: '#8fb3b8',
    zero: '#6d9aa3',
    cross: '#f6e7b4',
    outline: '#071317',
  },
  paper: {
    bg: '#f7f0de',
    scan: null,
    grid: '#dccfae',
    gridV: '#e6dcc0',
    text: '#6b5d45',
    zero: '#8a7a5c',
    cross: '#2a2116',
    outline: '#fbf6e8',
  },
};

const AXIS_FONT = '8px Silkscreen, "Pixelify Sans", monospace';

// ---------------------------------------------------------------------------------------------
// Number formatting helpers

function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  let d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  while (d < 8 && Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) > 1e-6) d++;
  return d;
}

function axisFormatter(lo: number, hi: number, step: number, percent: boolean): (v: number) => string {
  if (percent) {
    const d = stepDecimals(step * 100);
    return (v) => `${(v * 100).toFixed(d)}%`;
  }
  const m = Math.max(Math.abs(lo), Math.abs(hi));
  const [div, suf] = m >= 1e9 ? [1e9, 'B'] : m >= 1e6 ? [1e6, 'M'] : m >= 1e4 ? [1e3, 'K'] : [1, ''];
  const d = stepDecimals(step / div);
  return (v) => `${(v / div).toFixed(d)}${suf}`;
}

/** Compact number: 1234 -> 1.23K, 5600000 -> 5.6M. */
export function compactNumber(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const [div, suf] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
  const x = v / div;
  const ax = Math.abs(x);
  const d = ax >= 100 ? 0 : ax >= 10 ? Math.min(1, digits) : digits;
  return `${x.toFixed(d)}${suf}`;
}

// ---------------------------------------------------------------------------------------------
// Font readiness + shared ResizeObserver

let fontPromise: Promise<unknown> | null = null;
function fontsReady(): Promise<unknown> | null {
  if (typeof document === 'undefined' || !document.fonts) return null;
  try {
    if (document.fonts.check(AXIS_FONT)) return null;
  } catch {
    return null;
  }
  fontPromise ??= document.fonts.load(AXIS_FONT).catch(() => undefined);
  return fontPromise;
}

let ro: ResizeObserver | null = null;
function observer(): ResizeObserver | null {
  if (!ro && typeof ResizeObserver === 'function') {
    ro = new ResizeObserver((entries) => {
      for (const e of entries) if (e.target instanceof ChartHost) e.target.onResize();
    });
  }
  return ro;
}

const ditherCache = new Map<string, HTMLCanvasElement>();
function ditherTile(color: string): HTMLCanvasElement {
  let c = ditherCache.get(color);
  if (!c) {
    c = document.createElement('canvas');
    c.width = 2;
    c.height = 2;
    const x = c.getContext('2d');
    if (x) {
      x.fillStyle = alpha(color, 0.5);
      x.fillRect(0, 0, 1, 1);
      x.fillRect(1, 1, 1, 1);
    }
    ditherCache.set(color, c);
  }
  return c;
}

// ---------------------------------------------------------------------------------------------

interface Geometry {
  L: number;
  T: number;
  R: number;
  B: number;
  n: number;
  band: boolean;
  lo: number;
  hi: number;
  x: (i: number) => number;
  y: (v: number) => number;
}

class ChartHost extends HTMLElement {
  private opts: LineChartOpts = { series: [] };
  private plot!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private readout!: HTMLElement;
  private geom: Geometry | null = null;
  private hover = -1;
  private lastW = -1;
  private hideTimer = 0;
  private built = false;

  init(opts: LineChartOpts): this {
    this.opts = opts;
    const theme = opts.theme ?? 'screen';
    this.className = `mi-chart is-${theme}`;
    this.canvas = h('canvas', { class: 'mi-chart-canvas' });
    this.readout = h('div', { class: 'mi-chart-readout', 'aria-hidden': 'true' });
    this.plot = h('div', { class: 'mi-chart-plot', style: { height: `${opts.height ?? 140}px` } }, this.canvas, this.readout);
    this.replaceChildren(this.plot);
    if (opts.legend !== false && opts.series.length) this.appendChild(this.buildLegend());
    this.setAttribute('role', 'img');
    this.setAttribute('aria-label', opts.series.map((s) => `${s.label}: ${this.fmtFor(s)(s.values[s.values.length - 1] ?? NaN)}`).join(', '));
    if (!this.built) {
      this.built = true;
      this.addEventListener('pointermove', (e) => this.onPointer(e));
      this.addEventListener('pointerdown', (e) => this.onPointer(e));
      this.addEventListener('pointerleave', (e) => {
        if (e.pointerType !== 'touch') this.setHover(-1);
      });
      this.addEventListener('pointerup', (e) => {
        if (e.pointerType !== 'touch') return;
        clearTimeout(this.hideTimer);
        this.hideTimer = window.setTimeout(() => this.setHover(-1), 2200);
      });
    }
    return this;
  }

  connectedCallback(): void {
    if (!this.plot) return;
    observer()?.observe(this);
    // Draw right away so a chart rebuilt by a window update is immediately hoverable.
    this.draw();
    const p = fontsReady();
    if (p) void p.then(() => this.isConnected && this.draw());
  }

  disconnectedCallback(): void {
    observer()?.unobserve(this);
    clearTimeout(this.hideTimer);
  }

  onResize(): void {
    const w = this.plot.clientWidth;
    if (w !== this.lastW) {
      this.lastW = w;
      this.draw();
    }
  }

  private fmtFor(s?: ChartSeries): (v: number) => string {
    if (s?.format) return s.format;
    if (this.opts.format) return this.opts.format;
    if (this.opts.percent) return (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(Math.abs(v) < 0.1 ? 2 : 1)}%` : '—');
    return (v) => compactNumber(v);
  }

  private buildLegend(): HTMLElement {
    return h(
      'div',
      { class: 'mi-chart-legend' },
      this.opts.series.map((s) => {
        const last = [...s.values].reverse().find((v) => Number.isFinite(v));
        return h(
          'span',
          { class: 'mi-chart-key' },
          h('i', { class: ['mi-chart-swatch', s.dashed && 'is-dashed', s.type === 'bar' && 'is-bar'], style: { '--c': s.color } }),
          h('span', { class: 'mi-chart-key-label' }, s.label),
          last !== undefined ? h('b', null, this.fmtFor(s)(last)) : null,
        );
      }),
    );
  }

  private onPointer(e: PointerEvent): void {
    const g = this.geom;
    if (!g || g.n === 0) return;
    if (e.target !== this.canvas && !(e.target instanceof Node && this.plot.contains(e.target))) return;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return this.setHover(-1);
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < g.n; i++) {
      const d = Math.abs(g.x(i) - x);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (e.pointerType === 'touch') clearTimeout(this.hideTimer);
    this.setHover(best);
  }

  private setHover(i: number): void {
    if (i === this.hover) return;
    this.hover = i;
    this.draw();
    this.updateReadout();
  }

  private updateReadout(): void {
    const g = this.geom;
    const ro = this.readout;
    if (!g || this.hover < 0) {
      ro.classList.remove('is-visible');
      return;
    }
    const i = this.hover;
    const title = this.opts.labels?.[i] ?? `#${i + 1}`;
    ro.replaceChildren();
    appendChildren(ro, [
      h('div', { class: 'mi-chart-readout-title' }, title),
      this.opts.series.map((s) =>
        h(
          'div',
          { class: 'mi-chart-readout-row' },
          h('i', { style: { background: s.color } }),
          h('span', null, s.label),
          h('b', null, this.fmtFor(s)(s.values[i] ?? NaN)),
        ),
      ),
      (this.opts.markers ?? [])
        .filter((m) => m.index === i)
        .map((m) => h('div', { class: 'mi-chart-readout-event', style: { color: m.color } }, m.label)),
    ]);
    ro.classList.add('is-visible');
    const pw = this.plot.clientWidth;
    const rw = ro.offsetWidth;
    const cx = g.x(i);
    const left = cx + 10 + rw <= pw - 2 ? cx + 10 : Math.max(2, cx - 10 - rw);
    ro.style.transform = `translate(${Math.round(left)}px, ${Math.round(g.T + 2)}px)`;
  }

  draw(): void {
    const o = this.opts;
    const W = Math.floor(this.plot.clientWidth);
    const H = o.height ?? 140;
    this.lastW = this.plot.clientWidth;
    if (W <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const cv = this.canvas;
    const bw = Math.round(W * dpr);
    const bh = Math.round(H * dpr);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw;
      cv.height = bh;
    }
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const th = THEMES[o.theme ?? 'screen'];
    const px = (v: number, lw = 1) => {
      const odd = Math.round(lw * dpr) % 2 === 1;
      return (Math.round(v * dpr - (odd ? 0.5 : 0)) + (odd ? 0.5 : 0)) / dpr;
    };

    // Background + scanlines
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, W, H);
    if (th.scan) {
      ctx.fillStyle = th.scan;
      for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    }

    // Data range
    const series = o.series;
    const n = Math.max(0, ...series.map((s) => s.values.length));
    const hasBars = series.some((s) => s.type === 'bar');
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      for (const v of s.values) {
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    for (const r of o.refLines ?? []) {
      lo = Math.min(lo, r.at);
      hi = Math.max(hi, r.at);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    if (o.zeroLine || hasBars) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (o.yMin !== undefined) lo = o.yMin;
    if (o.yMax !== undefined) hi = o.yMax;
    if (hi - lo < 1e-12) {
      const pad = Math.abs(hi) * 0.1 || (o.percent ? 0.01 : 1);
      lo -= pad;
      hi += pad;
    }

    ctx.font = AXIS_FONT;
    ctx.textBaseline = 'middle';
    const markerSpace = (o.markers ?? []).length ? 12 : 0;
    const T = 7 + markerSpace;
    const B = H - (o.labels?.length ? 14 : 7);
    const approxTicks = Math.max(2, Math.min(6, Math.floor((B - T) / 26)));
    let step = niceStep((hi - lo) / approxTicks);
    // snap to whole steps; a bound that already sits on a step (e.g. 0) stays put
    if (o.yMin === undefined) lo = Math.floor(lo / step + 1e-9) * step;
    if (o.yMax === undefined) hi = Math.ceil(hi / step - 1e-9) * step;
    if ((hi - lo) / step > 8) step = niceStep((hi - lo) / approxTicks);
    const ticks: number[] = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    const axisFmt = o.format && !o.percent ? o.format : axisFormatter(lo, hi, step, !!o.percent);
    const tickLabels = ticks.map(axisFmt);
    const gutter = Math.ceil(Math.max(12, ...tickLabels.map((t) => ctx.measureText(t).width))) + 8;
    const L = gutter;
    const R = W - 8;
    const band = hasBars;
    const x = (i: number) => (band ? L + ((i + 0.5) * (R - L)) / Math.max(1, n) : n <= 1 ? (L + R) / 2 : L + (i * (R - L)) / (n - 1));
    const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (B - T);
    this.geom = { L, T, R, B, n, band, lo, hi, x, y };

    // Horizontal grid + y labels
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ticks.forEach((v, k) => {
      const yy = px(y(v));
      ctx.strokeStyle = th.grid;
      ctx.beginPath();
      ctx.moveTo(L, yy);
      ctx.lineTo(R, yy);
      ctx.stroke();
      ctx.fillStyle = th.text;
      ctx.fillText(tickLabels[k], Math.round(L - 5), Math.round(y(v)));
    });

    // X labels + vertical dotted grid
    const labels = o.labels ?? [];
    if (labels.length && n > 0) {
      const lw = Math.max(...labels.map((s) => ctx.measureText(s).width)) + 10;
      const slot = n <= 1 ? R - L : (R - L) / (band ? n : n - 1);
      const stride = Math.max(1, Math.ceil(lw / Math.max(1, slot)));
      ctx.textAlign = 'center';
      ctx.fillStyle = th.text;
      for (let i = 0; i < n; i += stride) {
        const xx = x(i);
        ctx.fillStyle = th.gridV;
        for (let yy = T; yy < B; yy += 3) ctx.fillRect(px(xx) - 0.5, yy, 1, 1);
        const s = labels[i] ?? '';
        const w = ctx.measureText(s).width;
        const cx = Math.min(W - w / 2 - 1, Math.max(w / 2 + 1, xx));
        ctx.fillStyle = th.text;
        ctx.fillText(s, Math.round(cx), Math.round(H - 7));
      }
    }

    // Zero line
    if ((o.zeroLine || hasBars) && lo < 0 && hi > 0) {
      ctx.strokeStyle = th.zero;
      ctx.beginPath();
      ctx.moveTo(L, px(y(0)));
      ctx.lineTo(R, px(y(0)));
      ctx.stroke();
    }

    // Reference lines
    for (const r of o.refLines ?? []) {
      const c = r.color ?? '#ff7a5c';
      const yy = px(y(r.at));
      ctx.strokeStyle = c;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(L, yy);
      ctx.lineTo(R, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      if (r.label) {
        ctx.textAlign = 'right';
        const tw = ctx.measureText(r.label).width;
        const ly = Math.round(yy - 6 < T ? yy + 6 : yy - 6);
        ctx.fillStyle = th.bg;
        ctx.fillRect(Math.round(R - tw - 4), ly - 5, Math.ceil(tw) + 4, 10);
        ctx.fillStyle = c;
        ctx.fillText(r.label, Math.round(R - 2), ly);
      }
    }

    // Markers
    for (const m of o.markers ?? []) {
      if (m.index < 0 || m.index >= n) continue;
      const c = m.color ?? '#f2c14e';
      const xx = px(x(m.index));
      ctx.strokeStyle = c;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(xx, T - 2);
      ctx.lineTo(xx, B);
      ctx.stroke();
      ctx.setLineDash([]);
      const tw = Math.ceil(ctx.measureText(m.label).width) + 6;
      const fx = xx + tw + 1 > W ? Math.round(xx - tw) : Math.round(xx);
      ctx.fillStyle = c;
      ctx.fillRect(fx, 1, tw, 10);
      ctx.fillStyle = readableInk(c, '#10181b', '#fff8e6');
      ctx.textAlign = 'left';
      ctx.fillText(m.label, fx + 3, 6);
    }

    const baseV = lo <= 0 && hi >= 0 ? 0 : lo > 0 ? lo : hi;

    // Areas
    for (const s of series) {
      if (!s.area || s.type === 'bar') continue;
      const pts = s.values.map((v, i) => [x(i), v] as const).filter(([, v]) => Number.isFinite(v));
      if (pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], y(baseV));
      for (const [xx, v] of pts) ctx.lineTo(xx, y(v));
      ctx.lineTo(pts[pts.length - 1][0], y(baseV));
      ctx.closePath();
      ctx.fillStyle = alpha(s.color, 0.1);
      ctx.fill();
      const pat = ctx.createPattern(ditherTile(s.color), 'repeat');
      if (pat) {
        ctx.fillStyle = pat;
        ctx.fill();
      }
    }

    // Bars
    const barSeries = series.filter((s) => s.type === 'bar');
    if (barSeries.length && n) {
      const slot = (R - L) / n;
      const groupW = Math.max(1, slot * 0.74);
      const bwid = Math.max(1, Math.floor(groupW / barSeries.length));
      barSeries.forEach((s, k) => {
        for (let i = 0; i < s.values.length; i++) {
          const v = s.values[i];
          if (!Number.isFinite(v)) continue;
          const x0 = Math.round(x(i) - groupW / 2 + k * bwid);
          const y0 = Math.round(y(baseV));
          const y1 = Math.round(y(v));
          const top = Math.min(y0, y1);
          const hh = Math.max(1, Math.abs(y1 - y0));
          const hovered = i === this.hover;
          ctx.fillStyle = hovered ? alpha(s.color, 1) : alpha(s.color, 0.88);
          ctx.fillRect(x0, top, Math.max(1, bwid - 1), hh);
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(x0, v >= baseV ? top : top + hh - 1, Math.max(1, bwid - 1), 1);
        }
      });
    }

    // Lines
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of series) {
      if (s.type === 'bar') continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(s.dashed ? [5, 4] : []);
      ctx.beginPath();
      let pen = false;
      let count = 0;
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) {
          pen = false;
          return;
        }
        const xx = x(i);
        const yy = y(v);
        if (pen) ctx.lineTo(xx, yy);
        else ctx.moveTo(xx, yy);
        pen = true;
        count++;
      });
      if (count > 1) ctx.stroke();
      ctx.setLineDash([]);
      // End point: a little pixel square.
      for (let i = s.values.length - 1; i >= 0; i--) {
        const v = s.values[i];
        if (!Number.isFinite(v)) continue;
        const xx = Math.round(x(i));
        const yy = Math.round(y(v));
        ctx.fillStyle = th.outline;
        ctx.fillRect(xx - 3, yy - 3, 6, 6);
        ctx.fillStyle = s.color;
        ctx.fillRect(xx - 2, yy - 2, 4, 4);
        break;
      }
    }
    ctx.lineWidth = 1;

    // Hover crosshair
    if (this.hover >= 0 && this.hover < n) {
      const i = this.hover;
      const xx = px(x(i));
      ctx.fillStyle = th.cross;
      for (let yy = T; yy < B; yy += 2) ctx.fillRect(xx - 0.5, yy, 1, 1);
      for (const s of series) {
        const v = s.values[i];
        if (!Number.isFinite(v) || s.type === 'bar') continue;
        const cx = Math.round(x(i));
        const cy = Math.round(y(v));
        ctx.fillStyle = th.outline;
        ctx.fillRect(cx - 4, cy - 4, 8, 8);
        ctx.fillStyle = th.cross;
        ctx.fillRect(cx - 3, cy - 3, 6, 6);
        ctx.fillStyle = s.color;
        ctx.fillRect(cx - 2, cy - 2, 4, 4);
      }
    }
  }
}

const TAG = 'mi-chart';
function defineHost(): void {
  if (typeof customElements !== 'undefined' && !customElements.get(TAG)) customElements.define(TAG, ChartHost);
}

/**
 * Management-game statistics chart. Returns an element that sizes itself to its container width
 * (redraws on resize) and shows a crosshair readout on hover / touch-scrub.
 */
export function lineChart(opts: LineChartOpts): HTMLElement {
  defineHost();
  const palette = (opts.theme ?? 'screen') === 'screen' ? SCREEN_PALETTE : PAPER_PALETTE;
  const series = opts.series.map((s, i) => ({ ...s, color: s.color || palette[i % palette.length] }));
  return (document.createElement(TAG) as ChartHost).init({ ...opts, series });
}

/** Same as lineChart with every series drawn as bars. */
export function barChart(opts: LineChartOpts): HTMLElement {
  return lineChart({ ...opts, series: opts.series.map((s) => ({ ...s, type: 'bar' as const })) });
}

/** Tiny inline trend line (canvas, DPR-aware). Last point gets a dot. */
export function sparkline(
  values: readonly number[],
  color = '#1f7a8c',
  w = 80,
  hgt = 20,
  opts: { area?: boolean; min?: number; max?: number; title?: string } = {},
): HTMLCanvasElement {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const c = h('canvas', { class: 'mi-spark', width: Math.round(w * dpr), height: Math.round(hgt * dpr) });
  c.style.width = `${w}px`;
  c.style.height = `${hgt}px`;
  if (opts.title) c.setAttribute('data-tip', opts.title);
  const ctx = c.getContext('2d');
  const pts = values.filter((v) => Number.isFinite(v));
  if (!ctx || !pts.length) return c;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  let lo = opts.min ?? Math.min(...pts);
  let hi = opts.max ?? Math.max(...pts);
  if (hi - lo < 1e-12) {
    lo -= 1;
    hi += 1;
  }
  const pad = 3;
  const x = (i: number) => (values.length <= 1 ? w / 2 : pad + (i * (w - pad * 2)) / (values.length - 1));
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (hgt - pad * 2);
  if (opts.area !== false) {
    ctx.beginPath();
    let first = -1;
    let last = -1;
    values.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      if (first < 0) {
        first = i;
        ctx.moveTo(x(i), hgt);
      }
      ctx.lineTo(x(i), y(v));
      last = i;
    });
    if (first >= 0) {
      ctx.lineTo(x(last), hgt);
      ctx.closePath();
      ctx.fillStyle = alpha(color, 0.16);
      ctx.fill();
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let pen = false;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) {
      pen = false;
      return;
    }
    if (pen) ctx.lineTo(x(i), y(v));
    else ctx.moveTo(x(i), y(v));
    pen = true;
  });
  ctx.stroke();
  for (let i = values.length - 1; i >= 0; i--) {
    if (!Number.isFinite(values[i])) continue;
    const cx = Math.round(x(i));
    const cy = Math.round(y(values[i]));
    ctx.fillStyle = color;
    ctx.fillRect(cx - 2, cy - 2, 4, 4);
    break;
  }
  return c;
}
