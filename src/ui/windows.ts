// Window manager: floating, draggable, tabbed game windows over the world canvas.
// On narrow screens (< 720px) windows become bottom sheets (top one visible, the previous one
// peeking as a title strip above it).

import { accentVars } from './color';
import { h, isEditable, shieldEvents } from './dom';
import { glyph, iconEl } from './icons';
import { hideTooltip, installTooltips, refreshTooltip } from './tooltip';

export interface WindowTab {
  id: string;
  label: string;
  icon?: string;
}

/** Why render()/update() is being called. */
export type RenderReason = 'open' | 'reopen' | 'tab' | 'update' | 'rerender' | 'reveal';

export interface WindowCtx {
  tab: string;
  win: GameWindow;
  reason: RenderReason;
  /**
   * Keep a DOM subtree across re-renders while `deps` are shallow-equal (e.g. a chart that only
   * changes monthly keeps its hover crosshair between 4 Hz refreshes). Unused keys are dropped
   * after each render.
   */
  memo<T extends Node>(key: string, deps: readonly unknown[], build: () => T): T;
}

export interface WindowOptions {
  id: string;
  title: string;
  /** Emoji (rendered as a pixel sprite), short glyph, or 'px:<glyph>' for a built-in pixel glyph. */
  icon?: string;
  /** Title-bar tint (any CSS colour). Default: brass. */
  accent?: string;
  width: number;
  /** Fixed height. Omit for auto height (capped to the viewport, body scrolls). */
  height?: number;
  x?: number;
  y?: number;
  /** Screen point to open near (e.g. where the player clicked); the window avoids covering it. */
  anchor?: { x: number; y: number };
  tabs?: WindowTab[];
  initialTab?: string;
  /** Build the body. The body is emptied before each call. */
  render: (body: HTMLElement, ctx: WindowCtx) => void;
  /** Periodic refresh from updateWindows(). Receives the live body (patch in place). Defaults to render. */
  update?: (body: HTMLElement, ctx: WindowCtx) => void;
  onClose?: () => void;
  /** Pinned windows ignore closeTopWindow() (Escape), closeAllWindows() and the window limit. */
  pinned?: boolean;
  /** Extra class name(s) on the window element. */
  className?: string;
}

export interface GameWindow {
  readonly id: string;
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  readonly tab: string;
  readonly isOpen: boolean;
  readonly options: Readonly<WindowOptions>;
  setTitle(s: string): void;
  setAccent(c: string | undefined): void;
  setIcon(icon: string | undefined): void;
  close(): void;
  /** Raise to the top. */
  focus(): void;
  /** Re-render now (keeps scroll position and focus). */
  rerender(): void;
  setTab(id: string): void;
  /** Briefly flash the title bar to draw attention. */
  flash(): void;
}

export interface UiInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// ---------------------------------------------------------------------------------------------

const SHEET_BREAKPOINT = 720;
const EDGE = 2;

let mountParent: HTMLElement | null = null;
let root: HTMLElement | null = null;
const wins: Win[] = []; // bottom -> top
const byId = new Map<string, Win>();
const byEl = new WeakMap<Element, Win>();
const lastPos = new Map<string, { x: number; y: number }>();
const insets: UiInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const pointer = { x: -1, y: -1, type: '' };
let cascade = 0;
let sheetMode = false;
let maxWindows = 12;
let pressedWin: Win | null = null;
let ro: ResizeObserver | null = null;

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function ensureRoot(): HTMLElement {
  if (root) return root;
  root = h('div', { class: 'mi-root' });
  (mountParent ?? document.body).appendChild(root);
  installTooltips();
  window.addEventListener('resize', onViewportResize);
  window.visualViewport?.addEventListener('resize', onViewportResize);
  const opt = { capture: true, passive: true } as const;
  document.addEventListener('pointermove', trackPointer, opt);
  document.addEventListener('pointerdown', trackPointer, opt);
  window.addEventListener('pointerup', releasePress, true);
  window.addEventListener('pointercancel', releasePress, true);
  window.addEventListener('blur', releasePress);
  ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onWinResize) : null;
  applyInsetVars();
  sheetMode = window.innerWidth < SHEET_BREAKPOINT;
  root.classList.toggle('mi-sheet-mode', sheetMode);
  return root;
}

function trackPointer(e: PointerEvent): void {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.type = e.pointerType;
}

function releasePress(): void {
  // Let the click that follows pointerup land before periodic re-renders resume.
  if (pressedWin) window.setTimeout(() => (pressedWin = null), 0);
}

function applyInsetVars(): void {
  if (!root) return;
  root.style.setProperty('--mi-inset-top', `${insets.top}px`);
  root.style.setProperty('--mi-inset-right', `${insets.right}px`);
  root.style.setProperty('--mi-inset-bottom', `${insets.bottom}px`);
  root.style.setProperty('--mi-inset-left', `${insets.left}px`);
}

function onViewportResize(): void {
  if (!root) return;
  const was = sheetMode;
  sheetMode = window.innerWidth < SHEET_BREAKPOINT;
  root.classList.toggle('mi-sheet-mode', sheetMode);
  if (was !== sheetMode) {
    for (const w of wins) w.el.style.transform = '';
  }
  layoutSheets();
  for (const w of wins) {
    // Windows opened as sheets have never been positioned: place them now.
    if (!sheetMode && !w.placed) w.place(w.options);
    else w.clamp();
    w.fitTabs();
  }
}

function onWinResize(entries: ResizeObserverEntry[]): void {
  if (sheetMode) {
    const top = wins[wins.length - 1];
    if (top && root && entries.some((e) => e.target === top.el)) {
      root.style.setProperty('--mi-sheet-top-h', `${top.el.offsetHeight}px`);
    }
    return;
  }
  for (const e of entries) {
    const w = byEl.get(e.target);
    if (!w) continue;
    w.clamp();
    w.fitTabs();
  }
}

function restack(): void {
  const n = wins.length;
  wins.forEach((w, i) => {
    w.el.style.zIndex = String(10 + i);
    w.el.classList.toggle('is-active', i === n - 1);
  });
  layoutSheets();
}

function layoutSheets(): void {
  if (!root) return;
  const n = wins.length;
  wins.forEach((w, i) => {
    const role: SheetRole = !sheetMode ? '' : i === n - 1 ? 'top' : i === n - 2 ? 'peek' : 'stash';
    w.setSheetRole(role, Math.max(0, n - 2));
  });
  if (sheetMode && n) root.style.setProperty('--mi-sheet-top-h', `${wins[n - 1].el.offsetHeight}px`);
}

function enforceMax(keep: Win): void {
  while (wins.length > maxWindows) {
    const victim = wins.find((w) => w !== keep && !w.options.pinned);
    if (!victim) break;
    victim.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Scroll / focus preservation across re-renders

interface Snapshot {
  top: number;
  left: number;
  nested: Map<string, [number, number]>;
  focusPath: number[] | null;
  focusTag: string;
  sel: [number | null, number | null] | null;
}

const SCROLLERS = '.mi-scroll, [data-scroll-key]';

function pathOf(rootEl: Element, el: Element): number[] {
  const path: number[] = [];
  let cur: Element | null = el;
  while (cur && cur !== rootEl) {
    const parent: Element | null = cur.parentElement;
    if (!parent) break;
    path.unshift(Array.prototype.indexOf.call(parent.children, cur));
    cur = parent;
  }
  return path;
}

function nodeAt(rootEl: Element, path: readonly number[]): Element | null {
  let cur: Element | null = rootEl;
  for (const i of path) {
    cur = cur?.children[i] ?? null;
    if (!cur) return null;
  }
  return cur;
}

function takeSnapshot(body: HTMLElement): Snapshot {
  const nested = new Map<string, [number, number]>();
  body.querySelectorAll<HTMLElement>(SCROLLERS).forEach((el, i) => {
    if (el.scrollTop || el.scrollLeft) nested.set(el.dataset.scrollKey ?? `#${i}`, [el.scrollTop, el.scrollLeft]);
  });
  let focusPath: number[] | null = null;
  let focusTag = '';
  let sel: Snapshot['sel'] = null;
  const ae = document.activeElement;
  if (ae instanceof HTMLElement && ae !== body && body.contains(ae)) {
    focusPath = pathOf(body, ae);
    focusTag = ae.tagName;
    if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) {
      try {
        sel = [ae.selectionStart, ae.selectionEnd];
      } catch {
        sel = null;
      }
    }
  }
  return { top: body.scrollTop, left: body.scrollLeft, nested, focusPath, focusTag, sel };
}

function restoreSnapshot(body: HTMLElement, s: Snapshot): void {
  if (s.nested.size) {
    body.querySelectorAll<HTMLElement>(SCROLLERS).forEach((el, i) => {
      const v = s.nested.get(el.dataset.scrollKey ?? `#${i}`);
      if (v) {
        el.scrollTop = v[0];
        el.scrollLeft = v[1];
      }
    });
  }
  if (s.top && body.scrollTop !== s.top) body.scrollTop = s.top;
  if (s.left && body.scrollLeft !== s.left) body.scrollLeft = s.left;
  if (s.focusPath) {
    const el = nodeAt(body, s.focusPath);
    if (el instanceof HTMLElement && el.tagName === s.focusTag && document.activeElement !== el) {
      el.focus({ preventScroll: true });
      if (s.sel && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        try {
          el.setSelectionRange(s.sel[0], s.sel[1]);
        } catch {
          /* input type without selection */
        }
      }
    }
  }
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------

type SheetRole = '' | 'top' | 'peek' | 'stash';

class Win implements GameWindow {
  readonly id: string;
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  private readonly titleBar: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly iconSlot: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly moreEl: HTMLElement;
  private opts: WindowOptions;
  private _tab = '';
  x = 0;
  y = 0;
  private closed = false;
  private collapsed = false;
  sheetRole: SheetRole = '';
  private lastError = '';
  private extraClass = '';
  placed = false;
  private readonly memoMap = new Map<string, { deps: readonly unknown[]; node: Node }>();
  private readonly memoUsed = new Set<string>();

  constructor(opts: WindowOptions) {
    this.id = opts.id;
    this.opts = { ...opts };
    const closeBtn = h(
      'button',
      { type: 'button', class: 'mi-win-btn mi-win-close', 'aria-label': 'Close', tip: 'Close', onclick: () => this.close() },
      glyph('close'),
    );
    this.iconSlot = h('span', { class: 'mi-win-iconslot' });
    this.nameEl = h('span', { class: 'mi-win-name' });
    this.moreEl = h('span', { class: 'mi-win-more' });
    this.titleBar = h(
      'div',
      { class: 'mi-win-title' },
      this.iconSlot,
      h('span', { class: 'mi-win-plaque' }, this.nameEl, this.moreEl),
      closeBtn,
    );
    this.tabsEl = h('div', { class: 'mi-win-tabs', role: 'tablist' });
    this.body = h('div', { class: 'mi-win-body mi-scroll' });
    this.el = h('section', { class: 'mi-win', role: 'dialog', dataset: { win: opts.id } }, this.titleBar, this.tabsEl, this.body);
    byEl.set(this.el, this);
    shieldEvents(this.el);

    this.el.addEventListener(
      'pointerdown',
      (e) => {
        pressedWin = this;
        // Closing a background (or peeking) window should not raise it first.
        if (!(e.target instanceof Element && e.target.closest('.mi-win-close'))) this.focus();
      },
      true,
    );
    this.titleBar.addEventListener('pointerdown', this.onTitleDown);
    this.titleBar.addEventListener('dblclick', (e) => {
      if (sheetMode || (e.target as Element).closest('.mi-win-btn')) return;
      this.setCollapsed(!this.collapsed);
    });
    this.tabsEl.addEventListener('keydown', (e) => {
      const tabs = this.opts.tabs ?? [];
      const i = tabs.findIndex((t) => t.id === this._tab);
      if (i < 0 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      this.setTab(next.id);
      (this.tabsEl.querySelector('.mi-tab.is-active') as HTMLElement | null)?.focus();
    });
  }

  // --- GameWindow ---------------------------------------------------------------------------

  get tab(): string {
    return this._tab;
  }
  get isOpen(): boolean {
    return !this.closed;
  }
  get options(): Readonly<WindowOptions> {
    return this.opts;
  }

  setTitle(s: string): void {
    this.opts.title = s;
    if (this.nameEl.textContent !== s) this.nameEl.textContent = s;
    this.el.setAttribute('aria-label', s);
  }

  setAccent(c: string | undefined): void {
    this.opts.accent = c;
    for (const k of ['--mi-accent', '--mi-accent-hi', '--mi-accent-lo', '--mi-accent-deep', '--mi-accent-ink', '--mi-accent-emboss']) {
      this.el.style.removeProperty(k);
    }
    if (c) for (const [k, v] of Object.entries(accentVars(c))) this.el.style.setProperty(k, v);
  }

  setIcon(icon: string | undefined): void {
    this.opts.icon = icon;
    const el = iconEl(icon, { px: 9, scale: 2 });
    this.iconSlot.replaceChildren(...(el ? [el] : []));
    this.el.classList.toggle('has-icon', !!el);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!sheetMode && this.placed) lastPos.set(this.id, { x: this.x, y: this.y });
    const i = wins.indexOf(this);
    if (i >= 0) wins.splice(i, 1);
    if (byId.get(this.id) === this) byId.delete(this.id);
    if (pressedWin === this) pressedWin = null;
    ro?.unobserve(this.el);
    this.el.remove();
    this.memoMap.clear();
    hideTooltip();
    restack();
    try {
      this.opts.onClose?.();
    } catch (err) {
      console.error(`[ui] onClose of window "${this.id}" threw`, err);
    }
  }

  focus(): void {
    if (this.closed) return;
    const i = wins.indexOf(this);
    if (i < 0) return;
    if (i !== wins.length - 1) {
      wins.splice(i, 1);
      wins.push(this);
      restack();
    }
  }

  rerender(): void {
    if (this.closed) return;
    this.renderBody('rerender', true);
  }

  setTab(id: string): void {
    if (this.closed || id === this._tab) return;
    if (!(this.opts.tabs ?? []).some((t) => t.id === id)) return;
    this._tab = id;
    this.renderTabs();
    this.fitTabs();
    this.body.scrollTop = 0;
    this.renderBody('tab', false);
    if (this.collapsed) this.setCollapsed(false);
  }

  flash(): void {
    if (reducedMotion() || typeof this.titleBar.animate !== 'function') return;
    this.titleBar.animate([{ filter: 'brightness(1.5) saturate(1.2)' }, { filter: 'none' }, { filter: 'brightness(1.5) saturate(1.2)' }, { filter: 'none' }], {
      duration: 420,
      easing: 'steps(4, end)',
    });
  }

  // --- internals ------------------------------------------------------------------------------

  open(): void {
    const tabs = this.opts.tabs ?? [];
    this._tab = tabs.find((t) => t.id === this.opts.initialTab)?.id ?? tabs[0]?.id ?? '';
    this.applyChrome();
    ensureRoot().appendChild(this.el);
    this.renderTabs();
    this.renderBody('open', false);
    wins.push(this);
    byId.set(this.id, this);
    restack();
    if (!sheetMode) this.place(this.opts);
    ro?.observe(this.el);
    this.fitTabs();
    this.animateIn(this.opts.anchor);
    enforceMax(this);
  }

  reopen(opts: WindowOptions): void {
    const prevTab = this._tab;
    this.opts = { ...opts };
    const tabs = this.opts.tabs ?? [];
    if (opts.initialTab && tabs.some((t) => t.id === opts.initialTab)) this._tab = opts.initialTab;
    else if (!tabs.some((t) => t.id === prevTab)) this._tab = tabs[0]?.id ?? '';
    this.applyChrome();
    this.renderTabs();
    if (opts.x !== undefined) this.x = opts.x;
    if (opts.y !== undefined) this.y = opts.y;
    if (this.collapsed) this.setCollapsed(false);
    this.focus();
    const sameTab = prevTab === this._tab;
    if (!sameTab) this.body.scrollTop = 0;
    this.renderBody('reopen', sameTab);
    this.clamp();
    this.fitTabs();
    this.flash();
  }

  private applyChrome(): void {
    const o = this.opts;
    this.setTitle(o.title);
    this.setIcon(o.icon);
    this.setAccent(o.accent);
    const split = (s: string) => s.split(/\s+/).filter(Boolean);
    if (this.extraClass) this.el.classList.remove(...split(this.extraClass));
    this.extraClass = o.className ?? '';
    if (this.extraClass) this.el.classList.add(...split(this.extraClass));
    this.el.classList.toggle('is-pinned', !!o.pinned);
    this.el.style.setProperty('--w', `${Math.round(o.width)}px`);
    if (o.height) this.el.style.setProperty('--h', `${Math.round(o.height)}px`);
    else this.el.style.removeProperty('--h');
    this.el.classList.toggle('has-height', !!o.height);
    this.applyPos();
  }

  private applyPos(): void {
    this.el.style.setProperty('--x', `${this.x}px`);
    this.el.style.setProperty('--y', `${this.y}px`);
  }

  private renderTabs(): void {
    const tabs = this.opts.tabs ?? [];
    this.el.classList.toggle('has-tabs', tabs.length > 0);
    this.tabsEl.replaceChildren(
      ...tabs.map((t) => {
        const on = t.id === this._tab;
        return h(
          'button',
          {
            type: 'button',
            class: ['mi-tab', on && 'is-active', !!t.icon && 'has-icon'],
            role: 'tab',
            'aria-selected': on ? 'true' : 'false',
            tabindex: on ? '0' : '-1',
            'aria-label': t.label,
            onclick: () => this.setTab(t.id),
          },
          iconEl(t.icon, { px: 12 }),
          h('span', { class: 'mi-tab-label' }, t.label),
        );
      }),
    );
  }

  fitTabs(): void {
    if (this.closed || !(this.opts.tabs ?? []).length) return;
    const t = this.tabsEl;
    t.classList.remove('is-compact');
    const compact = t.scrollWidth > t.clientWidth + 1 && (this.opts.tabs ?? []).every((x) => !!x.icon);
    t.classList.toggle('is-compact', compact);
    // Icon-only tabs explain themselves with a tooltip.
    for (const b of Array.from(t.children)) {
      const label = b.getAttribute('aria-label') ?? '';
      if (compact && !b.classList.contains('is-active')) b.setAttribute('data-tip', label);
      else b.removeAttribute('data-tip');
    }
  }

  private makeCtx(reason: RenderReason): WindowCtx {
    return { tab: this._tab, win: this, reason, memo: this.memo };
  }

  private readonly memo = <T extends Node>(key: string, deps: readonly unknown[], build: () => T): T => {
    this.memoUsed.add(key);
    const hit = this.memoMap.get(key);
    if (hit && sameDeps(hit.deps, deps)) return hit.node as T;
    const node = build();
    this.memoMap.set(key, { deps: [...deps], node });
    return node;
  };

  private reportError(err: unknown, inBody: boolean): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== this.lastError) {
      console.error(`[ui] window "${this.id}" failed to render:`, err);
      this.lastError = msg;
    }
    if (inBody) this.body.append(h('div', { class: 'mi-error' }, glyph('warn'), h('span', null, msg)));
  }

  renderBody(reason: RenderReason, preserve: boolean): void {
    const body = this.body;
    const snap = preserve ? takeSnapshot(body) : null;
    body.replaceChildren();
    this.memoUsed.clear();
    try {
      this.opts.render(body, this.makeCtx(reason));
      this.lastError = '';
    } catch (err) {
      this.reportError(err, true);
    }
    for (const k of [...this.memoMap.keys()]) if (!this.memoUsed.has(k)) this.memoMap.delete(k);
    if (snap) restoreSnapshot(body, snap);
  }

  private isBusy(): boolean {
    if (pressedWin === this) return true;
    const ae = document.activeElement;
    if (ae && ae !== this.body && this.body.contains(ae) && isEditable(ae)) return true;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && this.body.contains(sel.anchorNode)) return true;
    return this.body.querySelector('[data-mi-busy]') !== null;
  }

  tick(): void {
    if (this.closed || this.collapsed || this.sheetRole === 'peek' || this.sheetRole === 'stash') return;
    if (this.opts.update) {
      try {
        this.opts.update(this.body, this.makeCtx('update'));
      } catch (err) {
        this.reportError(err, false);
      }
      return;
    }
    if (this.isBusy()) return;
    this.renderBody('update', true);
    this.refreshHover();
  }

  /** Re-deliver the pointer position so hover-driven widgets (chart crosshair, tooltips) survive. */
  private refreshHover(): void {
    refreshTooltip();
    if (pointer.type !== 'mouse') return;
    const r = this.body.getBoundingClientRect();
    if (pointer.x < r.left || pointer.x >= r.right || pointer.y < r.top || pointer.y >= r.bottom) return;
    const t = document.elementFromPoint(pointer.x, pointer.y);
    if (!t || !this.body.contains(t)) return;
    const init: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: pointer.x,
      clientY: pointer.y,
      pointerType: 'mouse',
      isPrimary: true,
      pointerId: 1,
    };
    t.dispatchEvent(new PointerEvent('pointerover', init));
    t.dispatchEvent(new PointerEvent('pointermove', init));
  }

  setSheetRole(role: SheetRole, more: number): void {
    const was = this.sheetRole;
    if (was === role) {
      if (role === 'peek') this.moreEl.textContent = more > 0 ? `+${more}` : '';
      return;
    }
    this.sheetRole = role;
    this.el.classList.toggle('is-sheet-peek', role === 'peek');
    this.el.classList.toggle('is-sheet-stash', role === 'stash');
    this.moreEl.textContent = role === 'peek' && more > 0 ? `+${more}` : '';
    if (role === 'top' && (was === 'peek' || was === 'stash')) this.renderBody('reveal', true);
  }

  private setCollapsed(on: boolean): void {
    this.collapsed = on;
    this.el.classList.toggle('is-collapsed', on);
    if (!on) this.renderBody('reveal', true);
  }

  clamp(): void {
    if (sheetMode || this.closed) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = this.el.offsetWidth;
    const hh = this.el.offsetHeight;
    const minX = insets.left + EDGE;
    const minY = insets.top + EDGE;
    const maxX = Math.max(minX, vw - insets.right - EDGE - w);
    const maxY = Math.max(minY, vh - insets.bottom - EDGE - hh);
    const nx = Math.round(Math.min(Math.max(this.x, minX), maxX));
    const ny = Math.round(Math.min(Math.max(this.y, minY), maxY));
    this.x = nx;
    this.y = ny;
    this.applyPos();
  }

  private moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.clamp();
  }

  place(o: Readonly<WindowOptions>): void {
    this.placed = true;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = this.el.offsetWidth;
    const hh = this.el.offsetHeight;
    const L = insets.left + EDGE;
    const T = insets.top + EDGE;
    const R = vw - insets.right - EDGE;
    const B = vh - insets.bottom - EDGE;
    let x: number;
    let y: number;
    if (o.x !== undefined || o.y !== undefined) {
      x = o.x ?? L + (R - L - w) / 2;
      y = o.y ?? T + (B - T - hh) / 3;
    } else if (o.anchor) {
      const a = o.anchor;
      const gap = 28;
      y = a.y - Math.min(64, hh / 3);
      if (a.x + gap + w <= R) x = a.x + gap;
      else if (a.x - gap - w >= L) x = a.x - gap - w;
      else {
        // Not enough room beside the point: centre on it and sit above or below instead.
        x = a.x - w / 2;
        y = a.y + gap + hh <= B ? a.y + gap : a.y - gap - hh;
      }
    } else {
      const remembered = lastPos.get(this.id);
      if (remembered) {
        x = remembered.x;
        y = remembered.y;
      } else {
        const step = 26;
        const k = cascade++ % 8;
        x = L + 36 + k * step;
        y = T + 28 + k * step;
        for (let guard = 0; guard < 8; guard++) {
          const hit = wins.some((o2) => o2 !== this && Math.abs(o2.x - x) < 10 && Math.abs(o2.y - y) < 10);
          if (!hit) break;
          x += step;
          y += step;
        }
      }
    }
    this.x = x;
    this.y = y;
    this.clamp();
  }

  private animateIn(anchor?: { x: number; y: number }): void {
    if (reducedMotion() || typeof this.el.animate !== 'function') return;
    if (sheetMode) {
      this.el.animate([{ transform: 'translateY(32px)', opacity: 0 }, { transform: 'none', opacity: 1 }], {
        duration: 150,
        easing: 'cubic-bezier(.2,.8,.3,1)',
      });
      return;
    }
    if (anchor && root) {
      const to = this.el.getBoundingClientRect();
      const z = h('div', { class: 'mi-zoomrect' });
      root.appendChild(z);
      const a = z.animate(
        [
          { left: `${anchor.x}px`, top: `${anchor.y}px`, width: '0px', height: '0px' },
          { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` },
        ],
        { duration: 170, easing: 'steps(5, end)', fill: 'forwards' },
      );
      const done = () => z.remove();
      a.onfinish = done;
      a.oncancel = done;
      this.el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.75 }, { opacity: 1 }], { duration: 210 });
      return;
    }
    this.el.animate([{ transform: 'translateY(6px)', opacity: 0 }, { transform: 'none', opacity: 1 }], {
      duration: 120,
      easing: 'steps(3, end)',
    });
  }

  private readonly onTitleDown = (e: PointerEvent): void => {
    if (e.button !== 0 || (e.target as Element).closest('.mi-win-btn')) return;
    const bar = this.titleBar;
    const sheet = sheetMode;
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = this.x;
    const oy = this.y;
    let moved = false;
    if (!sheet) e.preventDefault();
    try {
      bar.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved) hideTooltip();
      moved = true;
      if (sheet) {
        if (this.sheetRole === 'top') this.el.style.transform = `translateY(${Math.max(0, dy)}px)`;
        return;
      }
      this.el.classList.add('is-dragging');
      this.moveTo(ox + dx, oy + dy);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
      this.el.classList.remove('is-dragging');
      if (sheet) {
        this.el.style.transform = '';
        if (moved && ev.type === 'pointerup' && ev.clientY - sy > 90 && this.sheetRole === 'top') this.close();
      } else if (moved) {
        lastPos.set(this.id, { x: this.x, y: this.y });
      }
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  };
}

// ---------------------------------------------------------------------------------------------
// Public API

/**
 * Open a window, or focus + re-render the existing one with the same id (with the new options;
 * position and current tab are kept unless x/y or initialTab are given).
 */
export function openWindow(opts: WindowOptions): GameWindow {
  ensureRoot();
  const existing = byId.get(opts.id);
  if (existing && existing.isOpen) {
    existing.reopen(opts);
    return existing;
  }
  const w = new Win(opts);
  w.open();
  return w;
}

/**
 * Call periodically (e.g. 4x/second). Each visible window runs its update() or re-renders.
 * Re-renders keep scroll positions (body and nested .mi-scroll / [data-scroll-key] elements) and
 * button focus, and are skipped while the player is typing in the window, pressing a pointer in
 * it, selecting text in it, or while any element inside carries [data-mi-busy].
 */
export function updateWindows(): void {
  for (const w of wins.slice()) w.tick();
}

/** Close the topmost non-pinned window. Returns false when nothing was closed (use Escape for something else). */
export function closeTopWindow(): boolean {
  for (let i = wins.length - 1; i >= 0; i--) {
    if (!wins[i].options.pinned) {
      wins[i].close();
      return true;
    }
  }
  return false;
}

/** Close all windows (pinned ones only with includePinned). */
export function closeAllWindows(opts: { includePinned?: boolean } = {}): void {
  for (const w of wins.slice().reverse()) if (opts.includePinned || !w.options.pinned) w.close();
}

export function closeWindow(id: string): void {
  byId.get(id)?.close();
}

export function isOpen(id: string): boolean {
  return !!byId.get(id)?.isOpen;
}

export function getWindow(id: string): GameWindow | undefined {
  const w = byId.get(id);
  return w && w.isOpen ? w : undefined;
}

/** Open windows, bottom to top. */
export function listWindows(): GameWindow[] {
  return wins.slice();
}

/** The topmost window, if any. */
export function topWindow(): GameWindow | undefined {
  return wins[wins.length - 1];
}

/**
 * Keep windows clear of screen furniture (e.g. a bottom HUD strip): windows are clamped inside the
 * viewport minus these insets, and bottom sheets sit above `bottom`.
 */
export function setUiInsets(next: Partial<UiInsets>): void {
  Object.assign(insets, next);
  applyInsetVars();
  layoutSheets();
  for (const w of wins) w.clamp();
}

/** Where the window layer lives (default document.body). Call before opening windows, or to move it. */
export function mountUI(parent: HTMLElement = document.body): HTMLElement {
  mountParent = parent;
  if (root && root.parentElement !== parent) parent.appendChild(root);
  return ensureRoot();
}

/** Oldest non-pinned windows are closed when more than `n` are open (default 12). */
export function setMaxWindows(n: number): void {
  maxWindows = Math.max(1, Math.floor(n));
}

/** True when windows are laid out as bottom sheets (narrow viewport). */
export function isSheetMode(): boolean {
  return sheetMode;
}
