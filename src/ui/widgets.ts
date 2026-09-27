// Reusable game-UI widgets. Every function returns a plain HTMLElement that can be dropped into a
// window body. They are cheap to rebuild, so windows can simply re-render them on every update.

import { alpha, parseColor, readableInk, shade } from './color';
import { h, shieldEvents, type Child } from './dom';
import { glyph, iconEl } from './icons';
import { tooltip } from './tooltip';

export { tooltip };

export type Tone = 'good' | 'bad' | 'warn' | 'muted' | 'info' | 'accent';

const toneClass = (t: Tone | undefined | null): string => (t ? `is-${t}` : '');

// ---------------------------------------------------------------------------------------------
// Buttons

export interface ButtonOpts {
  /** Emoji (pixel sprite), short text glyph, 'px:<glyph>' or a Node. */
  icon?: string | Node;
  /** Game tooltip. */
  title?: string;
  /** Toggle state: pressed-in and brass-lit. */
  active?: boolean;
  small?: boolean;
  danger?: boolean;
  /** Brass "call to action" face. */
  primary?: boolean;
  disabled?: boolean;
  className?: string;
}

export function button(label: string, onClick: (e: MouseEvent) => void, opts: ButtonOpts = {}): HTMLButtonElement {
  const b = h(
    'button',
    {
      type: 'button',
      class: [
        'mi-btn',
        opts.small && 'mi-btn-sm',
        opts.danger && 'mi-btn-danger',
        opts.primary && 'mi-btn-primary',
        opts.active && 'is-active',
        !label && 'mi-btn-icon',
        opts.className,
      ],
      'aria-pressed': opts.active === undefined ? undefined : String(opts.active),
      disabled: opts.disabled,
      tip: opts.title,
      onclick: (e: MouseEvent) => {
        if (!b.disabled) onClick(e);
      },
    },
    iconEl(opts.icon, { px: opts.small ? 10 : 12 }),
    label ? h('span', { class: 'mi-btn-label' }, label) : null,
  );
  return b;
}

/** Square icon-only button; `title` becomes its tooltip and accessible name. */
export function iconButton(icon: string | Node, title: string, onClick: (e: MouseEvent) => void, opts: ButtonOpts = {}): HTMLButtonElement {
  const b = button('', onClick, { ...opts, icon, title });
  b.setAttribute('aria-label', title);
  return b;
}

// ---------------------------------------------------------------------------------------------
// Spinner  [◀] value [▶]

export interface SpinnerOpts {
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  label?: string;
  /** Step multiplier used with Shift / PageUp / PageDown (default 10). */
  bigStep?: number;
  tip?: string;
  disabled?: boolean;
}

function decimals(n: number): number {
  const s = String(n);
  const e = s.indexOf('e-');
  if (e >= 0) return +s.slice(e + 2);
  const d = s.indexOf('.');
  return d < 0 ? 0 : s.length - d - 1;
}

export function spinner(o: SpinnerOpts): HTMLElement {
  const step = o.step > 0 ? o.step : 1;
  const dp = Math.max(decimals(step), decimals(o.min));
  const snap = (v: number): number => {
    let n = o.min + Math.round((v - o.min) / step) * step;
    n = Math.min(o.max, Math.max(o.min, n));
    return Number(n.toFixed(Math.min(12, dp)));
  };
  const fmt = o.format ?? ((v: number) => v.toFixed(dp));
  let value = snap(o.value);

  const valEl = h('span', { class: 'mi-spinner-value' }, fmt(value));
  valEl.style.minWidth = `${Math.max(fmt(o.min).length, fmt(o.max).length, fmt(value).length) + 1}ch`;
  const dec = h('button', { type: 'button', class: 'mi-spin-btn is-dec', tabindex: '-1', 'aria-label': 'Decrease' }, glyph('left'));
  const inc = h('button', { type: 'button', class: 'mi-spin-btn is-inc', tabindex: '-1', 'aria-label': 'Increase' }, glyph('right'));
  const ctl = h(
    'span',
    {
      class: ['mi-spinner', o.disabled && 'is-disabled'],
      role: 'spinbutton',
      tabindex: o.disabled ? undefined : '0',
      'aria-label': o.label,
      'aria-valuemin': String(o.min),
      'aria-valuemax': String(o.max),
      tip: o.tip,
    },
    dec,
    valEl,
    inc,
  );

  const sync = () => {
    valEl.textContent = fmt(value);
    ctl.setAttribute('aria-valuenow', String(value));
    ctl.setAttribute('aria-valuetext', fmt(value));
    dec.disabled = !!o.disabled || value <= o.min;
    inc.disabled = !!o.disabled || value >= o.max;
  };
  const set = (v: number): boolean => {
    const nv = snap(v);
    if (nv === value) return false;
    value = nv;
    sync();
    o.onChange(value);
    return true;
  };
  sync();

  const hold = (btn: HTMLButtonElement, dir: 1 | -1) => {
    let timer = 0;
    let count = 0;
    let mult = 1;
    const stop = () => {
      clearTimeout(timer);
      ctl.removeAttribute('data-mi-busy');
      btn.classList.remove('is-pressed');
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      window.removeEventListener('blur', stop);
    };
    const repeat = () => {
      count++;
      if (!btn.isConnected || !set(value + dir * step * mult)) return stop();
      timer = window.setTimeout(repeat, count < 4 ? 120 : count < 14 ? 70 : 35);
    };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || o.disabled) return;
      e.preventDefault();
      mult = e.shiftKey ? (o.bigStep ?? 10) : 1;
      if (!set(value + dir * step * mult)) return;
      count = 0;
      ctl.setAttribute('data-mi-busy', '');
      btn.classList.add('is-pressed');
      window.addEventListener('pointerup', stop, true);
      window.addEventListener('pointercancel', stop, true);
      window.addEventListener('blur', stop);
      timer = window.setTimeout(repeat, 400);
    });
    // Keyboard activation (pointer presses are handled above).
    btn.addEventListener('click', (e) => {
      if (e.detail === 0) set(value + dir * step);
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  };
  hold(dec, -1);
  hold(inc, 1);

  ctl.addEventListener('keydown', (e) => {
    const big = o.bigStep ?? 10;
    const map: Record<string, number> = {
      ArrowUp: step,
      ArrowRight: step,
      ArrowDown: -step,
      ArrowLeft: -step,
      PageUp: step * big,
      PageDown: -step * big,
    };
    if (o.disabled) return;
    if (e.key in map) set(value + map[e.key] * (e.shiftKey ? big : 1));
    else if (e.key === 'Home') set(o.min);
    else if (e.key === 'End') set(o.max);
    else return;
    e.preventDefault();
  });

  return o.label ? field(o.label, ctl) : ctl;
}

// ---------------------------------------------------------------------------------------------
// Choice (segmented radio buttons)

export interface ChoiceOption {
  id: string;
  label: string;
  title?: string;
  icon?: string;
}

export interface ChoiceOpts {
  options: ChoiceOption[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  small?: boolean;
  disabled?: boolean;
}

export function choice(o: ChoiceOpts): HTMLElement {
  let cur = o.value;
  const btns: HTMLButtonElement[] = [];
  const pick = (id: string, focus = false) => {
    if (o.disabled) return;
    const i = o.options.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (focus) btns[i].focus();
    if (id === cur) return;
    cur = id;
    btns.forEach((b, j) => {
      const on = j === i;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    o.onChange(id);
  };
  for (const opt of o.options) {
    const on = opt.id === cur;
    btns.push(
      h(
        'button',
        {
          type: 'button',
          role: 'radio',
          class: ['mi-choice-opt', on && 'is-on'],
          'aria-checked': String(on),
          tabindex: on ? '0' : '-1',
          disabled: o.disabled,
          tip: opt.title,
          onclick: () => pick(opt.id),
        },
        iconEl(opt.icon, { px: 10 }),
        h('span', null, opt.label),
      ),
    );
  }
  const group = h('div', { class: ['mi-choice', o.small && 'is-small'], role: 'radiogroup', 'aria-label': o.label }, btns);
  group.addEventListener('keydown', (e) => {
    const i = o.options.findIndex((x) => x.id === cur);
    const n = o.options.length;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') pick(o.options[(i + 1) % n].id, true);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') pick(o.options[(i + n - 1) % n].id, true);
    else return;
    e.preventDefault();
  });
  return o.label ? field(o.label, group) : group;
}

// ---------------------------------------------------------------------------------------------
// Gauge: horizontal bar with threshold marks

export interface GaugeMark {
  at: number;
  label?: string;
  color?: string;
}

export interface GaugeOpts {
  value: number;
  min: number;
  max: number;
  marks?: GaugeMark[];
  format?: (v: number) => string;
  /** Fixed fill colour (overrides the tone colours). */
  color?: string;
  warnBelow?: number;
  dangerBelow?: number;
  warnAbove?: number;
  dangerAbove?: number;
  /** Label shown above the bar (with the value on the right). Without it the value sits beside the bar. */
  label?: string;
  tip?: string;
}

export function gauge(o: GaugeOpts): HTMLElement {
  const span = o.max - o.min || 1;
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - o.min) / span) * 100));
  const fmt = o.format ?? ((v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)));
  let tone: Tone = 'good';
  const v = o.value;
  if ((o.dangerBelow !== undefined && v < o.dangerBelow) || (o.dangerAbove !== undefined && v > o.dangerAbove)) tone = 'bad';
  else if ((o.warnBelow !== undefined && v < o.warnBelow) || (o.warnAbove !== undefined && v > o.warnAbove)) tone = 'warn';

  const fill = h('div', { class: 'mi-gauge-fill', style: { width: `${pct(v)}%` } });
  if (o.color) {
    fill.style.setProperty('--fill', o.color);
    fill.style.setProperty('--fill-hi', shade(o.color, 0.35));
    fill.style.setProperty('--fill-lo', shade(o.color, -0.35));
  }
  const marks = (o.marks ?? []).slice().sort((a, b) => a.at - b.at);
  const track = h(
    'div',
    { class: ['mi-gauge-track', v > o.max && 'is-over', v < o.min && 'is-under'] },
    fill,
    marks.map((m) =>
      h('div', {
        class: 'mi-gauge-mark',
        style: { left: `${pct(m.at)}%`, '--mark': m.color },
        tip: m.label ? `${m.label} (${fmt(m.at)})` : fmt(m.at),
      }),
    ),
  );
  const valueEl = h('span', { class: 'mi-gauge-value' }, fmt(v));
  const labelled = marks.filter((m) => m.label);
  let scale: HTMLElement | null = null;
  if (labelled.length) {
    scale = h('div', { class: 'mi-gauge-scale' });
    let prev: { el: HTMLElement; p: number } | null = null;
    for (const m of labelled) {
      const p = pct(m.at);
      const el = h('span', { style: { left: `${p}%`, '--mark': m.color } }, m.label);
      let align = p < 10 ? 'start' : p > 90 ? 'end' : 'mid';
      if (prev && p - prev.p < 22) {
        prev.el.dataset.align = 'end';
        align = 'start';
      }
      el.dataset.align = align;
      scale.appendChild(el);
      prev = { el, p };
    }
  }
  return h(
    'div',
    { class: ['mi-gauge', toneClass(tone), !o.label && 'is-inline'], tip: o.tip },
    o.label ? h('div', { class: 'mi-gauge-head' }, h('span', { class: 'mi-gauge-label' }, o.label), valueEl) : null,
    h('div', { class: 'mi-gauge-row' }, track, o.label ? null : valueEl),
    scale,
  );
}

// ---------------------------------------------------------------------------------------------
// Key/value rows with ledger dot leaders

export interface KvOpts {
  tone?: Tone;
  /** Tooltip explaining the figure (label gets a dotted underline). */
  hint?: string;
  strong?: boolean;
  /** Indented sub-row. */
  sub?: boolean;
  onClick?: () => void;
}

export type KvRow = readonly [label: string | Node, value: string | number | Node, opts?: KvOpts];

/** Compact label ....... value rows. Falsy rows are skipped (handy for conditional rows). */
export function kv(rows: readonly (KvRow | null | undefined | false)[]): HTMLElement {
  return h(
    'div',
    { class: 'mi-kv' },
    rows
      .filter((r): r is KvRow => !!r)
      .map(([k, v, opt = {}]) =>
        h(
          'div',
          {
            class: ['mi-kv-row', toneClass(opt.tone), opt.strong && 'is-strong', opt.sub && 'is-sub', opt.onClick && 'is-clickable'],
            tip: opt.hint,
            onclick: opt.onClick,
          },
          h('span', { class: ['mi-kv-k', opt.hint && 'has-hint'] }, k),
          h('span', { class: 'mi-kv-dots' }),
          h('span', { class: 'mi-kv-v' }, typeof v === 'number' ? String(v) : v),
        ),
      ),
  );
}

// ---------------------------------------------------------------------------------------------
// Table

export interface TableColumn<R = any> {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  /** Cell content from the raw value (row[key]). */
  format?: (value: any, row: R, index: number) => string | number | Node | null | undefined;
  /** Value used for sorting (default row[key]). */
  sortValue?: (row: R) => number | string;
  /** This column absorbs spare width and truncates long text with an ellipsis (use for names). */
  grow?: boolean;
  tip?: string;
}

export interface TableOpts<R = any> {
  columns: TableColumn<R>[];
  rows: readonly R[];
  onRowClick?: (row: R, index: number, e: MouseEvent | KeyboardEvent) => void;
  /** Visible rows before the table scrolls (sticky header). */
  maxRows?: number;
  /** Hard cap on rendered rows; the rest is summarised in a footer ("+ 12 more"). */
  limit?: number;
  /** Message when there are no rows. */
  empty?: string;
  /** Stable key: enables persistent header-click sorting (with sortable) and scroll restore. */
  key?: string;
  sortable?: boolean;
  rowTone?: (row: R) => Tone | undefined | null;
  selected?: (row: R) => boolean;
}

const ROW_H = 19;
const HEAD_H = 19;
const tableSort = new Map<string, { col: string; dir: 1 | -1 }>();

export function table<R = any>(o: TableOpts<R>): HTMLElement {
  const sort = o.key && o.sortable ? tableSort.get(o.key) : undefined;
  const indexed = o.rows.map((row, i) => ({ row, i }));
  if (sort) {
    const col = o.columns.find((c) => c.key === sort.col);
    if (col) {
      const val = (r: R): unknown => (col.sortValue ? col.sortValue(r) : (r as Record<string, unknown>)[col.key]);
      indexed.sort((a, b) => {
        const x = val(a.row);
        const y = val(b.row);
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });
        return c * sort.dir || a.i - b.i;
      });
    }
  }
  const align = (c: TableColumn<R>): string => {
    if (c.align) return c.align;
    const sample = o.rows.find((r) => (r as Record<string, unknown>)[c.key] != null);
    return sample && typeof (sample as Record<string, unknown>)[c.key] === 'number' ? 'right' : 'left';
  };
  const aligns = o.columns.map(align);
  const limit = o.limit ?? Infinity;
  const shown = indexed.slice(0, limit);

  const wrap = h('div', {
    class: ['mi-table-wrap', 'mi-scroll', o.maxRows && 'is-capped'],
    dataset: { scrollKey: o.key ? `table:${o.key}` : undefined },
  });

  const rebuild = () => wrap.replaceWith(table(o));
  const head = h(
    'tr',
    null,
    o.columns.map((c, ci) => {
      const sorted = sort?.col === c.key;
      return h(
        'th',
        {
          class: [`is-${aligns[ci]}`, o.sortable && o.key && 'is-sortable', sorted && 'is-sorted', c.grow && 'is-grow'],
          style: { width: c.width },
          tip: c.tip,
          onclick:
            o.sortable && o.key
              ? () => {
                  const cur = tableSort.get(o.key!);
                  tableSort.set(o.key!, { col: c.key, dir: cur?.col === c.key ? (cur.dir === 1 ? -1 : 1) : typeof (o.rows[0] as Record<string, unknown> | undefined)?.[c.key] === 'number' ? -1 : 1 });
                  rebuild();
                }
              : undefined,
        },
        c.label,
        sorted ? glyph(sort!.dir > 0 ? 'sortUp' : 'sortDown') : null,
      );
    }),
  );

  const body = h('tbody');
  if (!shown.length) {
    body.appendChild(h('tr', { class: 'mi-table-empty' }, h('td', { colspan: String(o.columns.length) }, o.empty ?? 'Nothing to show')));
  }
  for (const { row, i } of shown) {
    const tone = o.rowTone?.(row);
    const tr = h(
      'tr',
      {
        class: [o.onRowClick && 'is-clickable', toneClass(tone), o.selected?.(row) && 'is-selected'],
        tabindex: o.onRowClick ? '0' : undefined,
        onclick: o.onRowClick ? (e: MouseEvent) => o.onRowClick!(row, i, e) : undefined,
        onkeydown: o.onRowClick
          ? (e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                o.onRowClick!(row, i, e);
              }
            }
          : undefined,
      },
      o.columns.map((c, ci) => {
        const raw = (row as Record<string, unknown>)[c.key];
        const val = c.format ? c.format(raw, row, i) : raw;
        const content = val instanceof Node ? val : val === null || val === undefined ? '' : String(val);
        return h('td', { class: [`is-${aligns[ci]}`, c.grow && 'is-grow'] }, content);
      }),
    );
    body.appendChild(tr);
  }
  const more = indexed.length - shown.length;
  const foot =
    more > 0 ? h('tfoot', null, h('tr', null, h('td', { colspan: String(o.columns.length) }, `+ ${more} more`))) : null;

  wrap.appendChild(h('table', { class: ['mi-table', o.onRowClick && 'is-clickable'] }, h('thead', null, head), body, foot));
  if (o.maxRows && o.maxRows > 0) wrap.style.maxHeight = `${HEAD_H + o.maxRows * ROW_H + 2}px`;
  return wrap;
}

// ---------------------------------------------------------------------------------------------
// Section, stat, badge, delta

export type SectionTitle = string | Node | { title: string | Node; aside?: Child };

/** Small-caps section header with a ledger rule, followed by its children. */
export function section(title: SectionTitle, ...children: Child[]): HTMLElement {
  const t = typeof title === 'object' && title !== null && !(title instanceof Node) ? title : { title, aside: null };
  return h(
    'section',
    { class: 'mi-section' },
    h(
      'div',
      { class: 'mi-section-head' },
      h('span', { class: 'mi-section-title' }, t.title),
      h('span', { class: 'mi-section-rule' }),
      t.aside ? h('span', { class: 'mi-section-aside' }, t.aside) : null,
    ),
    ...children,
  );
}

export type Delta = number | string | { value: number; text?: string; good?: 'up' | 'down' | 'none' };

/** ▲/▼ coloured change indicator. Numbers/strings use their sign; up is good unless good: 'down'. */
export function delta(d: Delta): HTMLElement {
  let n: number;
  let txt: string;
  let good: 'up' | 'down' | 'none' = 'up';
  if (typeof d === 'number') {
    n = d;
    txt = Math.abs(d).toLocaleString(undefined, { maximumFractionDigits: 2 });
  } else if (typeof d === 'string') {
    const s = d.trim();
    n = /^[-−–]/.test(s) ? -1 : /^\+/.test(s) ? 1 : parseFloat(s) || 0;
    if (n === 0 && /[1-9]/.test(s) && !/^[-−–+]/.test(s)) n = 1;
    txt = s.replace(/^[-−–+]\s*/, '');
  } else {
    n = d.value;
    txt = d.text ?? Math.abs(d.value).toLocaleString(undefined, { maximumFractionDigits: 2 });
    good = d.good ?? 'up';
  }
  const dir = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  const quality = dir === 'flat' || good === 'none' ? 'is-neutral' : dir === good ? 'is-good' : 'is-bad';
  return h(
    'span',
    { class: ['mi-delta', `is-${dir}`, quality] },
    dir === 'flat' ? h('span', { class: 'mi-delta-flat' }, '–') : glyph(dir === 'up' ? 'up' : 'down'),
    txt,
  );
}

/** A tiny labelled number (HUD-style readout) with an optional delta. */
export function stat(label: string, value: string | number | Node, d?: Delta | null, opts: { tip?: string; tone?: Tone } = {}): HTMLElement {
  return h(
    'div',
    { class: ['mi-stat', toneClass(opts.tone)], tip: opts.tip },
    h('span', { class: 'mi-stat-label' }, label),
    h('span', { class: 'mi-stat-line' }, h('span', { class: 'mi-stat-value' }, typeof value === 'number' ? String(value) : value), d !== undefined && d !== null ? delta(d) : null),
  );
}

export function badge(text: string, tone: Tone = 'muted', opts: { blink?: boolean; tip?: string } = {}): HTMLElement {
  const el = h('span', { class: ['mi-badge', toneClass(tone)], tip: opts.tip }, text);
  return opts.blink ? blink(el) : el;
}

let blinkClock = 0;
/**
 * Make `el` blink (RCT-style alert). Uses one shared 2 Hz clock on <html data-mi-blink>, so the
 * rhythm is steady even when the element is rebuilt every update. Off with reduced motion.
 */
export function blink<T extends Element>(el: T): T {
  el.classList.add('mi-blink');
  if (!blinkClock && typeof window !== 'undefined') {
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) blinkClock = window.setInterval(() => document.documentElement.toggleAttribute('data-mi-blink'), 500);
  }
  return el;
}

// ---------------------------------------------------------------------------------------------
// Balance sheet (T-account)

export interface BsItem {
  label: string;
  value: number;
  color?: string;
  onClick?: () => void;
  hint?: string;
}

export interface BalanceSheetOpts {
  assets: BsItem[];
  liabilities: BsItem[];
  equity: BsItem[];
  format: (v: number) => string;
  /** Column titles (default "Assets", "Liabilities + Equity"). */
  titles?: [string, string];
  /** Show each item's share of its side (default true). */
  shares?: boolean;
}

const ASSET_COLORS = ['#4f9d69', '#2f7f8f', '#9ccf7f', '#5fb3b3', '#3c6e47', '#c3e3a0', '#1f5d6b'];
const LIAB_COLORS = ['#c0583f', '#dc9447', '#8e3b46', '#e8b86a', '#a0522d', '#d27b7b'];
const EQUITY_COLORS = ['#d4af37', '#a8841f', '#f0d27a', '#8a6a12'];

export function balanceSheet(o: BalanceSheetOpts): HTMLElement {
  const fmt = o.format;
  const sum = (a: BsItem[]) => a.reduce((s, x) => s + x.value, 0);
  const pos = (a: BsItem[]) => a.reduce((s, x) => s + Math.max(0, x.value), 0);
  const A = sum(o.assets);
  const LE = sum(o.liabilities) + sum(o.equity);
  const left = pos(o.assets);
  const right = pos(o.liabilities) + pos(o.equity);
  const scale = Math.max(left, right, 1e-9);
  const hole = right - left > scale * 0.002 ? right - left : 0; // assets don't cover claims
  const gap = left - right > scale * 0.002 ? left - right : 0;
  const showShares = o.shares ?? true;
  const [tA, tL] = o.titles ?? ['Assets', 'Liabilities + Equity'];

  const color = (it: BsItem, pal: string[], i: number) => it.color ?? pal[i % pal.length];
  const pctOf = (v: number, tot: number) => (tot > 0 ? (v / tot) * 100 : 0);

  const seg = (it: BsItem, key: string, c: string, tot: number) => {
    const share = it.value / scale;
    const p = pctOf(it.value, tot);
    return h(
      'div',
      {
        class: ['mi-bs-seg', it.onClick && 'is-clickable'],
        style: { width: `${share * 100}%`, background: c, color: readableInk(c) },
        dataset: { k: key },
        tip: `${it.label}\n${fmt(it.value)} · ${p.toFixed(1)}%`,
        onclick: it.onClick,
      },
      share >= 0.16 ? `${Math.round(p)}%` : '',
    );
  };
  const strip = (items: [BsItem, string, string][], tot: number, filler: HTMLElement | null) =>
    h('div', { class: 'mi-bs-strip' }, items.filter(([it]) => it.value > 0).map(([it, k, c]) => seg(it, k, c, tot)), filler);

  const row = (it: BsItem, key: string, c: string, tot: number) =>
    h(
      'div',
      {
        class: ['mi-bs-row', it.onClick && 'is-clickable', it.value < 0 && 'is-neg'],
        dataset: { k: key },
        tip: it.hint,
        onclick: it.onClick,
        tabindex: it.onClick ? '0' : undefined,
      },
      h('span', { class: 'mi-bs-sw', style: { background: c } }),
      h('span', { class: 'mi-bs-label' }, it.label),
      showShares && it.value > 0 ? h('span', { class: 'mi-bs-share' }, `${Math.round(pctOf(it.value, tot))}%`) : null,
      h('span', { class: 'mi-bs-val' }, fmt(it.value)),
    );

  const aItems = o.assets.map((it, i): [BsItem, string, string] => [it, `a${i}`, color(it, ASSET_COLORS, i)]);
  const lItems = o.liabilities.map((it, i): [BsItem, string, string] => [it, `l${i}`, color(it, LIAB_COLORS, i)]);
  const eItems = o.equity.map((it, i): [BsItem, string, string] => [it, `e${i}`, color(it, EQUITY_COLORS, i)]);

  const holeSeg = hole
    ? h('div', { class: 'mi-bs-seg is-hole', style: { width: `${(hole / scale) * 100}%` }, dataset: { k: 'hole' }, tip: `Shortfall\nAssets do not cover liabilities by ${fmt(hole)}` }, hole / scale >= 0.16 ? 'HOLE' : '')
    : null;
  const gapSeg = gap
    ? h('div', { class: 'mi-bs-seg is-gap', style: { width: `${(gap / scale) * 100}%` }, dataset: { k: 'gap' }, tip: `Unbalanced by ${fmt(gap)}` })
    : null;

  const total = (label: string, v: number) =>
    h('div', { class: 'mi-bs-total' }, h('span', { class: 'mi-bs-label' }, label), h('span', { class: 'mi-bs-val' }, fmt(v)));

  const assetsCol = h(
    'div',
    { class: 'mi-bs-col is-assets' },
    strip(aItems, left, holeSeg),
    h(
      'div',
      { class: 'mi-bs-rows' },
      aItems.map(([it, k, c]) => row(it, k, c, left)),
      hole
        ? h(
            'div',
            { class: 'mi-bs-row is-hole', dataset: { k: 'hole' }, tip: 'Negative equity: the bank owes more than it owns.' },
            h('span', { class: 'mi-bs-sw is-hole' }),
            h('span', { class: 'mi-bs-label' }, 'Shortfall'),
            h('span', { class: 'mi-bs-val' }, fmt(hole)),
          )
        : null,
    ),
    total('Total', A),
  );
  const liabCol = h(
    'div',
    { class: 'mi-bs-col is-liab' },
    strip([...lItems, ...eItems], right, gapSeg),
    h(
      'div',
      { class: 'mi-bs-rows' },
      lItems.map(([it, k, c]) => row(it, k, c, right)),
      eItems.length ? h('div', { class: 'mi-bs-sub' }, h('span', null, 'Equity'), h('span', { class: 'mi-bs-val' }, fmt(sum(o.equity)))) : null,
      eItems.map(([it, k, c]) => row(it, k, c, right)),
    ),
    total('Total', LE),
  );

  const el = h(
    'div',
    { class: ['mi-bs', hole && 'is-insolvent'] },
    h('div', { class: 'mi-bs-head' }, h('span', null, tA), h('span', null, tL)),
    h('div', { class: 'mi-bs-cols' }, assetsCol, liabCol),
  );

  // Hover linking between strip segments and rows.
  let hot = '';
  const setHot = (k: string) => {
    if (k === hot) return;
    hot = k;
    el.querySelectorAll('.is-hot').forEach((n) => n.classList.remove('is-hot'));
    if (k) el.querySelectorAll(`[data-k="${k}"]`).forEach((n) => n.classList.add('is-hot'));
    el.classList.toggle('has-hot', !!k);
  };
  el.addEventListener('pointerover', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-k]') : null;
    setHot(t?.getAttribute('data-k') ?? '');
  });
  el.addEventListener('pointerleave', () => setHot(''));
  el.addEventListener('keydown', (e) => {
    const t = e.target instanceof Element ? e.target.closest('.mi-bs-row.is-clickable') : null;
    if (t && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      (t as HTMLElement).click();
    }
  });
  return el;
}

// ---------------------------------------------------------------------------------------------
// Layout helpers

/** Label on the left, control on the right. */
export function field(label: string | Node, control: Child, opts: { hint?: string } = {}): HTMLElement {
  return h(
    'div',
    { class: 'mi-field' },
    h('span', { class: ['mi-field-label', opts.hint && 'has-hint'], tip: opts.hint }, label),
    h('span', { class: 'mi-field-ctl' }, control),
  );
}

/** Horizontal group with 4px gaps. */
export function row(...children: Child[]): HTMLElement {
  return h('div', { class: 'mi-row' }, ...children);
}

/** Right-aligned row of buttons (window footer actions). */
export function actions(...children: Child[]): HTMLElement {
  return h('div', { class: 'mi-actions' }, ...children);
}

/** Inset "sunken" sub-panel for a block of data. */
export function panel(...children: Child[]): HTMLElement {
  return h('div', { class: 'mi-sunken' }, ...children);
}

/** Small explanatory text. */
export function note(text: Child, tone?: Tone): HTMLElement {
  return h('p', { class: ['mi-note', toneClass(tone)] }, text);
}

/** Dark LCD-style readout (dates, cash counters). */
export function lcd(text: string, opts: { tip?: string; tone?: Tone } = {}): HTMLElement {
  return h('span', { class: ['mi-lcd', toneClass(opts.tone)], tip: opts.tip }, text);
}

// ---------------------------------------------------------------------------------------------
// Strips (HUD bars / toolbars) — same frame material as windows

/** A framed horizontal bar (HUD, toolbar). Shielded: events on it never reach the map. */
export function strip(...children: Child[]): HTMLElement {
  return shieldEvents(h('div', { class: 'mi-strip' }, ...children));
}

/** A sunken group inside a strip (e.g. the speed buttons). */
export function stripGroup(...children: Child[]): HTMLElement {
  return h('div', { class: 'mi-strip-group' }, ...children);
}

/** A grooved vertical separator for strips. */
export function stripSep(): HTMLElement {
  return h('span', { class: 'mi-strip-sep', 'aria-hidden': 'true' });
}

// ---------------------------------------------------------------------------------------------
// Ticker (news crawl for HUD strips)

export interface TickerEl extends HTMLElement {
  /** Queue a message (most recent first). Keeps the last `max` messages. */
  push(msg: string, tone?: Tone): void;
  /** Drop every message. */
  clear(): void;
}

export function ticker(messages: readonly string[] = [], opts: { max?: number; speed?: number } = {}): TickerEl {
  const max = opts.max ?? 6;
  const speed = opts.speed ?? 40; // px per second
  const track = h('div', { class: 'mi-ticker-track' });
  const el = h('div', { class: 'mi-ticker', role: 'marquee', 'aria-live': 'polite' }, track) as unknown as TickerEl;
  const items: { msg: string; tone?: Tone }[] = messages.map((msg) => ({ msg }));
  let anim: Animation | null = null;
  const build = () => {
    const make = () =>
      h(
        'span',
        { class: 'mi-ticker-run' },
        items.map((it) => h('span', { class: ['mi-ticker-item', toneClass(it.tone)] }, h('i', { class: 'mi-ticker-dot' }), it.msg)),
      );
    track.replaceChildren(make(), make());
    anim?.cancel();
    anim = null;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof track.animate !== 'function' || !items.length) return;
    requestAnimationFrame(() => {
      const w = (track.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0;
      if (!w) return;
      anim = track.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-w}px)` }], {
        duration: (w / speed) * 1000,
        iterations: Infinity,
      });
    });
  };
  el.push = (msg: string, tone?: Tone) => {
    items.unshift({ msg, tone });
    items.length = Math.min(items.length, max);
    build();
  };
  el.clear = () => {
    items.length = 0;
    build();
  };
  build();
  return el;
}

// Re-exported for convenience when building custom widgets.
export { alpha, parseColor, readableInk, shade };
