// Tiny DOM helpers: element builder, clearing, cheap text updates, event shielding.

export type Child = Node | string | number | bigint | boolean | null | undefined | readonly Child[];

export type ClassValue = string | number | boolean | null | undefined | readonly ClassValue[] | Record<string, unknown>;

export type StyleValue = string | Record<string, string | number | null | undefined | false>;

type LowerEvents = {
  [K in keyof HTMLElementEventMap as `on${K}`]?: (e: HTMLElementEventMap[K]) => void;
};

/** React-style camelCase aliases for the handlers people reach for most. */
interface CamelEvents {
  onClick?: (e: MouseEvent) => void;
  onDblClick?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  onPointerDown?: (e: PointerEvent) => void;
  onPointerUp?: (e: PointerEvent) => void;
  onPointerMove?: (e: PointerEvent) => void;
  onPointerEnter?: (e: PointerEvent) => void;
  onPointerLeave?: (e: PointerEvent) => void;
  onPointerOver?: (e: PointerEvent) => void;
  onPointerOut?: (e: PointerEvent) => void;
  onMouseEnter?: (e: MouseEvent) => void;
  onMouseLeave?: (e: MouseEvent) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onKeyUp?: (e: KeyboardEvent) => void;
  onInput?: (e: Event) => void;
  onChange?: (e: Event) => void;
  onFocus?: (e: FocusEvent) => void;
  onBlur?: (e: FocusEvent) => void;
  onWheel?: (e: WheelEvent) => void;
}

export type Attrs = LowerEvents &
  CamelEvents & {
    class?: ClassValue;
    className?: ClassValue;
    style?: StyleValue;
    dataset?: Record<string, string | number | boolean | null | undefined>;
    /** Native browser tooltip. Prefer `tip` for the game-styled tooltip. */
    title?: string;
    /** Game-styled tooltip text (see tooltip()). */
    tip?: string;
    /** Called with the element once it is built. */
    ref?: (el: HTMLElement) => void;
    [attr: string]: unknown;
  };

const UNITLESS = new Set([
  'opacity',
  'zIndex',
  'z-index',
  'flex',
  'flexGrow',
  'flex-grow',
  'flexShrink',
  'flex-shrink',
  'fontWeight',
  'font-weight',
  'lineHeight',
  'line-height',
  'order',
  'zoom',
]);

export function cls(v: ClassValue): string {
  if (!v || v === true || typeof v === 'number') return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(cls).filter(Boolean).join(' ');
  return Object.entries(v as Record<string, unknown>)
    .filter(([, on]) => !!on)
    .map(([k]) => k)
    .join(' ');
}

const kebab = (k: string): string => (k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));

export function applyStyle(el: HTMLElement | SVGElement, style: StyleValue): void {
  if (typeof style === 'string') {
    el.style.cssText = style;
    return;
  }
  for (const [k, v] of Object.entries(style)) {
    if (v === null || v === undefined || v === false) continue;
    const val = typeof v === 'number' && !UNITLESS.has(k) && !k.startsWith('--') ? `${v}px` : String(v);
    el.style.setProperty(kebab(k), val);
  }
}

function isAttrs(x: unknown): x is Attrs {
  return !!x && typeof x === 'object' && !(x instanceof Node) && !Array.isArray(x);
}

export function appendChildren(el: Element | DocumentFragment, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/**
 * Element builder.
 *   h('div', { class: 'mi-row', style: { gap: 4 }, onclick: () => ... }, 'text', child)
 *   h('span', 'just text')            // attrs may be omitted
 * Attrs: class/className (string | array | {name: bool}), style (string | object; numbers get px),
 * dataset, title, tip (game tooltip), ref, on* handlers (onclick / onClick), aria-* and any other
 * attribute or property (true -> empty attribute, false/null/undefined -> skipped).
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | Child | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, attrs?: Attrs | Child | null, ...children: Child[]): HTMLElement;
export function h(tag: string, attrs?: Attrs | Child | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  let ref: ((el: HTMLElement) => void) | undefined;
  if (isAttrs(attrs)) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class' || key === 'className') {
        const c = cls(value as ClassValue);
        if (c) el.className = el.className ? `${el.className} ${c}` : c;
      } else if (key === 'style') {
        applyStyle(el, value as StyleValue);
      } else if (key === 'dataset') {
        for (const [dk, dv] of Object.entries(value as Record<string, unknown>)) {
          if (dv !== undefined && dv !== null && dv !== false) el.dataset[dk] = String(dv);
        }
      } else if (key === 'tip') {
        el.setAttribute('data-tip', String(value));
      } else if (key === 'ref') {
        ref = value as (el: HTMLElement) => void;
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (!key.includes('-') && key in el) {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  } else if (attrs !== undefined && attrs !== null) {
    children.unshift(attrs as Child);
  }
  appendChildren(el, children);
  if (ref) ref(el);
  return el;
}

/** Remove all children. */
export function clear<T extends Element>(el: T): T {
  el.replaceChildren();
  return el;
}

/** Set text content only when it changed (cheap to call every frame). */
export function text<T extends Element>(el: T, s: string | number): T {
  const v = String(s);
  if (el.textContent !== v) el.textContent = v;
  return el;
}

/** Replace `el` in the DOM with `next` (handy inside keyed update functions). Returns `next`. */
export function swap<T extends Node>(el: ChildNode, next: T): T {
  if (el !== (next as unknown)) el.replaceWith(next);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Event shielding: UI surfaces swallow the events that would start map interactions.

const SHIELDED = ['pointerdown', 'mousedown', 'touchstart', 'wheel', 'click', 'dblclick', 'auxclick', 'contextmenu'];
const stop = (e: Event): void => e.stopPropagation();

function isEditable(t: EventTarget | null): t is HTMLElement {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(t.type);
  return false;
}

function keyGuard(e: KeyboardEvent): void {
  if (!isEditable(e.target)) return;
  // Typing into a field must not trigger game hotkeys. Escape leaves the field first.
  if (e.type === 'keydown' && e.key === 'Escape') (e.target as HTMLElement).blur();
  e.stopPropagation();
}

/**
 * Make `el` a UI surface: pointer-down / wheel / click / touchstart events that start inside it do
 * not bubble to document/window listeners (so dragging a window never pans the map), and keys
 * typed into inputs inside it do not reach game hotkeys. Move/up events still bubble, so a map
 * drag that wanders over a window keeps working. Use isUiEvent() in game handlers for the rest.
 */
export function shieldEvents<T extends HTMLElement>(el: T): T {
  if (el.hasAttribute('data-mi-ui')) return el;
  el.setAttribute('data-mi-ui', '');
  for (const t of SHIELDED) el.addEventListener(t, stop, { passive: true });
  el.addEventListener('keydown', keyGuard);
  el.addEventListener('keyup', keyGuard);
  return el;
}

/** True when the event started on a UI surface (window, HUD strip... anything shielded). */
export function isUiEvent(e: Event): boolean {
  const t = e.target;
  return t instanceof Element && t.closest('[data-mi-ui]') !== null;
}

export { isEditable };
