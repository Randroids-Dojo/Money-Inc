// Game-styled tooltips. One floating element, driven by delegation on [data-tip] so tooltips keep
// working when window contents are re-rendered (elements are replaced 4x a second).

let tipEl: HTMLDivElement | null = null;
let target: Element | null = null;
let visible = false;
let lastHideAt = 0;
let showTimer = 0;
let hideTimer = 0;
let px = -1;
let py = -1;
let installed = false;
const fnTips = new WeakMap<Element, () => string>();

const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [role="tab"], [role="radio"], [tabindex]';

/**
 * Attach a game-styled tooltip to `el` (replaces any previous one). `text` may be a function,
 * evaluated each time the tooltip shows. Pass null/'' to remove. Newlines are kept.
 */
export function tooltip<T extends Element>(el: T, text: string | (() => string) | null | undefined): T {
  if (text === null || text === undefined || text === '') {
    el.removeAttribute('data-tip');
    fnTips.delete(el);
  } else if (typeof text === 'function') {
    fnTips.set(el, text);
    el.setAttribute('data-tip', '');
  } else {
    fnTips.delete(el);
    el.setAttribute('data-tip', text);
  }
  installTooltips();
  return el;
}

function tipText(el: Element): string {
  const f = fnTips.get(el);
  if (f) {
    try {
      return f();
    } catch {
      return '';
    }
  }
  return el.getAttribute('data-tip') ?? '';
}

function ensureEl(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'mi-tooltip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function place(): void {
  if (!tipEl) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = tipEl.offsetWidth;
  const hh = tipEl.offsetHeight;
  let x = px + 12;
  let y = py + 18;
  if (x + w > vw - 4) x = Math.max(4, vw - w - 4);
  if (y + hh > vh - 4) y = Math.max(4, py - hh - 10);
  tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function resolveAtPointer(): Element | null {
  const at = px >= 0 ? document.elementFromPoint(px, py) : null;
  return at ? at.closest('[data-tip]') : null;
}

function show(): void {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  // The element may have been rebuilt by a window re-render while we waited: use its successor.
  if (target && !target.isConnected) target = resolveAtPointer();
  if (!target) return hideTooltip();
  const s = tipText(target);
  if (!s) return hideTooltip();
  const el = ensureEl();
  if (el.textContent !== s) el.textContent = s;
  el.classList.toggle('is-multi', s.includes('\n'));
  el.classList.add('is-visible');
  visible = true;
  place();
}

/** Hide the tooltip immediately. */
export function hideTooltip(): void {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  if (visible) lastHideAt = performance.now();
  visible = false;
  tipEl?.classList.remove('is-visible');
}

function retarget(t: Element | null, immediate: boolean): void {
  if (t === target) return;
  if (t && target && !target.isConnected) {
    // Same spot, freshly re-rendered element: adopt it without restarting the delay.
    target = t;
    if (visible) show();
    return;
  }
  target = t;
  clearTimeout(showTimer);
  if (!t) return hideTooltip();
  const warm = visible || performance.now() - lastHideAt < 500;
  if (warm || immediate) show();
  else showTimer = window.setTimeout(show, 420);
}

function onMove(e: PointerEvent): void {
  if (e.pointerType === 'touch') return;
  px = e.clientX;
  py = e.clientY;
  const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
  retarget(t, false);
}

function onOut(e: PointerEvent): void {
  if (!e.relatedTarget && e.pointerType !== 'touch') {
    target = null;
    hideTooltip();
  }
}

let touchTarget: Element | null = null;
function onDown(e: PointerEvent): void {
  if (e.pointerType !== 'touch') {
    // Clicking dismisses; the tip comes back once the pointer moves to another element.
    target = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    hideTooltip();
    return;
  }
  px = e.clientX;
  py = e.clientY;
  touchTarget = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
  hideTooltip();
  target = touchTarget;
  if (touchTarget) showTimer = window.setTimeout(show, 450); // long-press
}

function onUp(e: PointerEvent): void {
  if (e.pointerType !== 'touch' || !touchTarget) return;
  if (visible) {
    hideTimer = window.setTimeout(hideTooltip, 1600);
  } else {
    clearTimeout(showTimer);
    // A tap on something that is not itself interactive (a label, a gauge mark) shows its tip.
    if (!touchTarget.closest(INTERACTIVE)) {
      target = touchTarget;
      show();
      hideTimer = window.setTimeout(hideTooltip, 2200);
    }
  }
  touchTarget = null;
}

/**
 * Re-resolve the tooltip after content under the pointer was replaced (the window manager calls
 * this after each re-render). Keeps a visible tooltip alive on the equivalent new element.
 */
export function refreshTooltip(): void {
  if (!target || target.isConnected) return;
  const t = resolveAtPointer();
  if (!visible) {
    if (t) target = t; // keep a pending show alive
    return;
  }
  target = t;
  if (t) show();
  else hideTooltip();
}

export function installTooltips(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const opt = { capture: true, passive: true } as const;
  document.addEventListener('pointermove', onMove, opt);
  document.addEventListener('pointerover', onMove, opt);
  document.addEventListener('pointerout', onOut, opt);
  document.addEventListener('pointerdown', onDown, opt);
  document.addEventListener('pointerup', onUp, opt);
  document.addEventListener('pointercancel', () => hideTooltip(), opt);
  document.addEventListener('wheel', () => hideTooltip(), opt);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') hideTooltip();
    },
    true,
  );
  window.addEventListener('blur', () => hideTooltip());
}
