// Title screen / new-game picker, shown over the (paused) city: a brass-and-teal marquee with
// the game's name, a three-line primer, the four scenarios as selectable cards, a city seed
// with a dice roll (and a preview of the town it produces), and a big "Open the city" button.
// Keyboard: Enter starts, arrow keys choose a scenario, Tab stays inside the screen. While it is
// up, game hotkeys (Space, 1–4, WASD…) are held back.

import { glyph, h, iconEl, shieldEvents, badge } from '../../ui';
import { drawPixelText, measurePixelText } from '../../render/sprites';
import { pct } from '../../sim/format';
import { defaultPolicy, SCENARIOS, type Scenario } from '../../sim/setup';
import { generateCity } from '../../world/city';
import type { UIContext } from './context';

const ORDER: Scenario[] = ['classic', 'easy', 'fragile', 'tight', 'genesis'];

const ICONS: Record<Scenario, string> = {
  classic: '🏘️',
  easy: '💸',
  fragile: '⚠️',
  tight: '🛡️',
  genesis: '🌱',
};

const MAX_SEED = 999_999;

/** The intro currently on screen (showing a new one replaces it). */
let current: { dismiss(): void } | null = null;

const randomSeed = (): number => 1 + Math.floor(Math.random() * 9999);

function townName(seed: number): string {
  try {
    return generateCity(seed).name;
  } catch {
    return '';
  }
}

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface PixelTitle {
  el: HTMLCanvasElement;
  /** canvas size in units (one unit = half a font pixel) */
  w: number;
  h: number;
  stop(): void;
}

/**
 * The title drawn with the city's own sign lettering (3x5 bitmap font): banded gold face, dark
 * outline, a two-step extrusion and a shine that sweeps across every few seconds. The canvas
 * is drawn at 1 px per unit and scaled up by an integer in CSS (see fitTitle).
 */
function pixelTitle(text: string): PixelTitle | null {
  const K = 2; // units per font pixel
  const EXT = 2; // extrusion depth in units
  const m = measurePixelText(text, K);
  const W = m.w + 2;
  const H = m.h + 2 + EXT;
  const out = document.createElement('canvas');
  const base = document.createElement('canvas');
  const face = document.createElement('canvas');
  out.width = base.width = W;
  out.height = base.height = H;
  face.width = m.w;
  face.height = m.h;
  const og = out.getContext('2d');
  const bg = base.getContext('2d');
  const fg = face.getContext('2d');
  if (!og || !bg || !fg) return null;

  // outline + extrusion (static)
  for (let e = 0; e <= EXT; e++) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) drawPixelText(bg, text, 1 + dx, 1 + dy + e, '#1f1402', { scale: K });
  }
  for (let e = EXT; e >= 1; e--) drawPixelText(bg, text, 1, 1 + e, e === EXT ? '#6b4503' : '#a06d08', { scale: K });

  const BANDS: [string, number, number][] = [
    ['#fff4b8', 0, 2],
    ['#ffdc55', 2, 4],
    ['#f5b823', 6, 2],
    ['#cf8a10', 8, 2],
  ];
  const draw = (shine: number | null) => {
    fg.globalCompositeOperation = 'source-over';
    fg.clearRect(0, 0, m.w, m.h);
    drawPixelText(fg, text, 0, 0, '#ffdc55', { scale: K });
    fg.globalCompositeOperation = 'source-atop';
    for (const [c, y, hh] of BANDS) {
      fg.fillStyle = c;
      fg.fillRect(0, y, m.w, hh);
    }
    if (shine !== null) {
      // a soft glint: pale gold, two units wide, leaning right
      fg.fillStyle = 'rgba(255, 252, 226, 0.7)';
      for (let y = 0; y < m.h; y++) fg.fillRect(Math.round(shine - y * 0.5), y, 2, 1);
    }
    og.clearRect(0, 0, W, H);
    og.drawImage(base, 0, 0);
    og.drawImage(face, 1, 1);
  };
  draw(null);

  // Shine: one sweep every few seconds.
  let raf = 0;
  const t0 = performance.now();
  let last = '';
  const tick = (now: number) => {
    const t = ((now - t0) / 1000 + 4.5) % 5.2; // seconds into the cycle
    const x = t < 0.7 ? -8 + (t / 0.7) * (m.w + 16) : null;
    const key = x === null ? '' : String(Math.round(x));
    if (key !== last) {
      last = key;
      draw(x === null ? null : Math.round(x));
    }
    raf = requestAnimationFrame(tick);
  };
  if (!reducedMotion() && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick);

  out.className = 'mi-intro-title-canvas';
  out.setAttribute('aria-hidden', 'true');
  return { el: out, w: W, h: H, stop: () => cancelAnimationFrame(raf) };
}

/**
 * Show the title / new-game screen. `onStart(seed, scenario)` is called once, when the player
 * opens the city; the screen then fades away.
 */
export function showIntro(ctx: UIContext, onStart: (seed: number, scenario: Scenario) => void): void {
  injectStyle();
  current?.dismiss();

  // Start from the city already running behind the screen: "Open the city" keeps it.
  let scenario: Scenario = ORDER.includes(ctx.game.scenario) ? ctx.game.scenario : 'classic';
  const current0 = Math.floor(ctx.game.seed);
  let seed = current0 >= 1 && current0 <= MAX_SEED ? current0 : randomSeed();
  let closed = false;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // ---- scenario cards
  const cards = ORDER.map((id) => {
    const sc = SCENARIOS[id];
    const pol = defaultPolicy(id);
    return h(
      'button',
      {
        type: 'button',
        role: 'radio',
        class: ['mi-intro-card', id === 'genesis' && 'is-wide'],
        dataset: { scenario: id },
        onclick: () => select(id),
      },
      h('span', { class: 'mi-intro-card-icon' }, iconEl(ICONS[id], { px: 14, scale: 2 })),
      h(
        'span',
        { class: 'mi-intro-card-main' },
        h('span', { class: 'mi-intro-card-title' }, sc.title),
        h('span', { class: 'mi-intro-card-blurb' }, sc.blurb),
        id === 'genesis'
          ? h('span', { class: 'mi-intro-card-tags' }, badge('New mode', 'info'), badge('Starts from $0', 'muted'), badge('You approve the loans', 'muted'), badge('Trace every loan', 'muted'))
          : h(
              'span',
              { class: 'mi-intro-card-tags' },
              badge(`Rate ${pct(pol.policyRate, 0)}`, 'muted'),
              badge(`Capital ${pct(pol.capitalRequirement, 0)}`, 'muted'),
              pol.depositInsurance === 'none' ? badge('No deposit insurance', 'bad') : null,
              pol.emergencyLiquidity === 'none' ? badge('No rescue loans', 'bad') : null,
            ),
      ),
      h('span', { class: 'mi-intro-card-check', 'aria-hidden': 'true' }, glyph('check', 2)),
    );
  });

  const select = (id: Scenario, focus = false) => {
    scenario = id;
    cards.forEach((c, i) => {
      const on = ORDER[i] === id;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
      if (on && focus) c.focus();
    });
  };

  const group = h('div', { class: 'mi-intro-cards', role: 'radiogroup', 'aria-labelledby': 'mi-intro-pick' }, cards);
  group.addEventListener('keydown', (e) => {
    const i = ORDER.indexOf(scenario);
    const n = ORDER.length;
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % n;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i + n - 1) % n;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    if (j < 0) return;
    e.preventDefault();
    select(ORDER[j], true);
  });

  // ---- seed
  const town = h('span', { class: 'mi-intro-town', 'aria-live': 'polite' });
  const showTown = () => {
    const name = townName(seed);
    town.replaceChildren(...(name ? ['Your town: ', h('b', null, name)] : []));
  };
  let townTimer = 0;
  const seedInput = h('input', {
    type: 'number',
    class: 'mi-intro-seed-input',
    min: '1',
    max: String(MAX_SEED),
    step: '1',
    inputmode: 'numeric',
    value: String(seed),
    'aria-label': 'City seed',
    oninput: () => {
      const v = Math.floor(Number(seedInput.value));
      if (!(v >= 1)) return;
      seed = Math.min(v, MAX_SEED);
      clearTimeout(townTimer);
      townTimer = window.setTimeout(showTown, 120);
    },
    onblur: () => {
      seedInput.value = String(seed);
    },
  }) as HTMLInputElement;
  const dice = h(
    'button',
    {
      type: 'button',
      class: 'mi-btn mi-btn-icon mi-intro-dice',
      'aria-label': 'Roll a random seed',
      tip: 'Roll a new city',
      onclick: () => {
        seed = randomSeed();
        seedInput.value = String(seed);
        dice.classList.remove('is-rolling');
        void dice.offsetWidth; // restart the roll animation
        dice.classList.add('is-rolling');
        showTown();
      },
    },
    iconEl('🎲', { px: 14 }),
  );

  const go = h(
    'button',
    { type: 'button', class: 'mi-btn mi-btn-primary mi-intro-go', onclick: () => start() },
    h('span', { class: 'mi-btn-label' }, 'Open the city'),
    glyph('play', 2),
  );

  // ---- layout
  const bulbs = (where: string) => h('div', { class: ['mi-intro-bulbs', where], 'aria-hidden': 'true' });
  const rivets = ['tl', 'tr', 'bl', 'br'].map((c) => h('i', { class: ['mi-intro-rivet', `is-${c}`], 'aria-hidden': 'true' }));
  const primerItem = (icon: string, ...text: (string | Node)[]) => h('li', null, iconEl(icon, { px: 14, scale: 2 }), h('span', null, ...text));
  const b = (s: string) => h('b', null, s);

  let title: PixelTitle | null = null;
  try {
    title = pixelTitle('MONEY INC.');
  } catch {
    title = null;
  }
  const coinL = h('span', { class: 'mi-intro-coin', 'aria-hidden': 'true' }, glyph('coin', 5));
  const coinR = h('span', { class: 'mi-intro-coin is-late', 'aria-hidden': 'true' }, glyph('coin', 5));
  const titleRow = h(
    'div',
    { class: 'mi-intro-titlerow' },
    coinL,
    title
      ? h('h1', { id: 'mi-intro-title', class: 'mi-intro-title is-pixel' }, title.el, h('span', { class: 'mi-intro-sr' }, 'Money Inc.'))
      : h('h1', { id: 'mi-intro-title', class: 'mi-intro-title' }, 'MONEY INC.'),
    coinR,
  );
  /** Scale the pixel title (and its coins) by the largest whole number that fits. */
  const fitTitle = () => {
    if (!title) return;
    const avail = titleRow.clientWidth;
    if (!avail) return;
    // title + two coins (5 units wide) + two gaps (3 units)
    const u = Math.max(2, Math.min(6, Math.floor(avail / (title.w + 16))));
    title.el.style.width = `${title.w * u}px`;
    title.el.style.height = `${title.h * u}px`;
    titleRow.style.gap = `${3 * u}px`;
    for (const c of [coinL, coinR]) {
      const svg = c.firstElementChild as SVGElement | null;
      if (!svg) continue;
      svg.setAttribute('width', String(5 * u));
      svg.setAttribute('height', String(7 * u));
    }
  };

  const panel = h(
    'div',
    { class: 'mi-intro-panel' },
    rivets,
    h(
      'header',
      { class: 'mi-intro-marquee' },
      bulbs('is-top'),
      titleRow,
      h('p', { id: 'mi-intro-sub', class: 'mi-intro-sub' }, 'A city where every dollar has a history'),
      bulbs('is-bottom'),
    ),
    h(
      'div',
      { class: 'mi-intro-body' },
      h(
        'ul',
        { class: 'mi-intro-primer' },
        primerItem('🏦', b('Banks create money'), ' when they lend — and destroy it when loans are repaid.'),
        primerItem('🔍', b('Click anything'), ' to see its finances: homes, shops, banks, even a single loan.'),
        primerItem('🏛️', 'You run the ', b('Reserve Bank'), ': set rates and rules, then watch the city boom — or bust.'),
      ),
      h('div', { id: 'mi-intro-pick', class: 'mi-intro-label' }, 'Choose your town'),
      group,
      h(
        'div',
        { class: 'mi-intro-foot' },
        h(
          'div',
          { class: 'mi-intro-seed' },
          h('span', { class: 'mi-intro-seed-label' }, 'City seed'),
          seedInput,
          dice,
          town,
        ),
        h('span', { class: 'mi-intro-gowrap' }, go),
      ),
      h('div', { class: 'mi-intro-hint', 'aria-hidden': 'true' }, 'Enter ↵ open the city  ·  ← → choose a town'),
    ),
  );

  const coins = h(
    'div',
    { class: 'mi-intro-coins', 'aria-hidden': 'true' },
    Array.from({ length: 9 }, (_, i) =>
      h(
        'span',
        {
          class: 'mi-intro-fcoin',
          style: {
            left: `${(i * 11.3 + (i % 3) * 4 + 3) % 97}%`,
            '--d': `${11 + (i % 4) * 3}s`,
            '--delay': `${-(i * 2.3)}s`,
            '--c': i % 3 === 1 ? '#63ff7e' : '#ffd84d',
          },
        },
        h('span', { class: 'mi-intro-fcoin-spin' }, glyph('coin', 3)),
      ),
    ),
  );

  const root = h(
    'div',
    {
      class: 'mi-intro mi-ui',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'mi-intro-title',
      'aria-describedby': 'mi-intro-sub',
    },
    coins,
    panel,
  );
  shieldEvents(root);

  // ---- keyboard
  const focusables = () =>
    Array.from(root.querySelectorAll<HTMLElement>('button, input')).filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.offsetParent !== null);

  const onRootKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.isComposing) {
      // The dice keeps its own Enter (roll); everywhere else Enter opens the city.
      if (!(e.target instanceof Element && e.target.closest('.mi-intro-dice'))) {
        e.preventDefault();
        start();
      }
    } else if (e.key === 'Tab') {
      const f = focusables();
      if (f.length) {
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    // Keep game hotkeys (Space = pause, 1–4 = speed, …) away from the city behind.
    e.stopPropagation();
  };
  const stopKey = (e: KeyboardEvent) => e.stopPropagation();
  root.addEventListener('keydown', onRootKey);
  root.addEventListener('keyup', stopKey);

  // Keys aimed at the page itself (focus outside the screen) are caught before the game sees them.
  const onWindowKey = (e: KeyboardEvent) => {
    if (e.target instanceof Node && root.contains(e.target)) return;
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      start();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      go.focus();
    } else if (e.key === ' ' || e.key.startsWith('Arrow')) {
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', onWindowKey, true);

  // ---- lifecycle
  window.addEventListener('resize', fitTitle);
  const teardown = () => {
    closed = true;
    clearTimeout(townTimer);
    window.removeEventListener('keydown', onWindowKey, true);
    window.removeEventListener('resize', fitTitle);
    title?.stop();
    if (current === handle) current = null;
  };

  const fadeOut = () => {
    if (reducedMotion()) {
      root.remove();
      return;
    }
    root.classList.add('is-leaving');
    window.setTimeout(() => root.remove(), 320);
  };

  function start(): void {
    if (closed) return;
    const v = Math.floor(Number(seedInput.value));
    if (v >= 1) seed = Math.min(v, MAX_SEED);
    teardown();
    try {
      onStart(seed, scenario);
    } finally {
      fadeOut();
      if (returnFocus && returnFocus.isConnected && returnFocus !== document.body) returnFocus.focus({ preventScroll: true });
      else if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement)) document.activeElement.blur();
    }
  }

  const handle = {
    dismiss() {
      if (closed) return;
      teardown();
      root.remove();
    },
  };
  current = handle;

  select(scenario);
  showTown();
  document.body.appendChild(root);
  fitTitle();
  go.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------------------------
// Styles (injected once)

const STYLE_ID = 'mi-intro-style';

const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .38 0 0 0 0 .3 0 0 0 0 .16 .16 0 0 0 -.03'/%3E%3C/filter%3E%3Crect width='96' height='96' filter='url(%23n)'/%3E%3C/svg%3E\")";

function injectStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
.mi-intro {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 18px 16px;
  background: radial-gradient(ellipse 120% 95% at 50% 42%, rgba(6, 18, 26, 0.22) 0%, rgba(6, 18, 26, 0.7) 68%, rgba(3, 9, 14, 0.9) 100%);
  touch-action: manipulation;
  animation: mi-intro-in 0.25s ease-out;
}
.mi-intro::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  background: repeating-conic-gradient(rgba(2, 8, 12, 0.2) 0 25%, transparent 0 50%) 0 0 / 4px 4px;
}
.mi-intro.is-leaving {
  pointer-events: none;
  animation: mi-intro-out 0.3s ease-in forwards;
}
@keyframes mi-intro-in {
  from { opacity: 0; }
}
@keyframes mi-intro-out {
  to { opacity: 0; }
}

/* drifting coins behind the panel */
.mi-intro-coins {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.mi-intro-fcoin {
  position: absolute;
  bottom: -40px;
  color: var(--c);
  opacity: 0.42;
  filter: drop-shadow(2px 2px 0 rgba(0, 0, 0, 0.55));
  animation: mi-intro-rise var(--d) linear var(--delay) infinite;
}
.mi-intro-fcoin-spin {
  display: block;
  animation: mi-intro-spin 1.8s steps(8, end) infinite;
}
@keyframes mi-intro-rise {
  to { transform: translateY(calc(-100vh - 80px)); }
}
@keyframes mi-intro-spin {
  0%, 100% { transform: scaleX(1); }
  50% { transform: scaleX(0.15); }
}

/* the frame */
.mi-intro-panel {
  position: relative;
  z-index: 1;
  width: min(760px, 100%);
  margin: auto;
  padding: 5px;
  background: var(--mi-frame);
  border: 1px solid var(--mi-outline);
  box-shadow:
    inset 1px 1px 0 var(--mi-frame-hi),
    inset -1px -1px 0 var(--mi-frame-lo),
    inset 2px 2px 0 var(--mi-frame-hi2),
    inset -2px -2px 0 var(--mi-frame-lo2),
    6px 8px 0 rgba(4, 12, 18, 0.45),
    0 26px 60px rgba(0, 0, 0, 0.55);
  animation: mi-intro-drop 0.42s steps(6, end);
}
@keyframes mi-intro-drop {
  from { transform: translateY(-28px); opacity: 0; }
}
.mi-intro-rivet {
  position: absolute;
  z-index: 2;
  width: 6px;
  height: 6px;
  background: var(--mi-brass);
  border: 1px solid var(--mi-outline);
  box-shadow: inset 1px 1px 0 var(--mi-brass-hi), inset -1px -1px 0 var(--mi-brass-lo);
}
.mi-intro-rivet.is-tl { left: 1px; top: 1px; }
.mi-intro-rivet.is-tr { right: 1px; top: 1px; }
.mi-intro-rivet.is-bl { left: 1px; bottom: 1px; }
.mi-intro-rivet.is-br { right: 1px; bottom: 1px; }

/* marquee */
.mi-intro-marquee {
  position: relative;
  padding: 7px 12px 9px;
  text-align: center;
  background:
    radial-gradient(ellipse 70% 90% at 50% 0%, rgba(120, 190, 205, 0.22), transparent 70%),
    repeating-linear-gradient(180deg, rgba(255, 255, 255, 0.025) 0 1px, transparent 1px 3px),
    var(--mi-frame-deep);
  border: 1px solid var(--mi-outline);
  box-shadow:
    inset 1px 1px 0 var(--mi-frame-lo),
    inset -1px -1px 0 var(--mi-frame-hi2),
    inset 0 0 0 3px rgba(201, 162, 39, 0.28);
}
.mi-intro-bulbs {
  height: 4px;
  margin: 0 8px;
  background: repeating-linear-gradient(90deg, #fff0a8 0 4px, transparent 4px 8px, #6f5212 8px 12px, transparent 12px 16px);
  filter: drop-shadow(0 0 3px rgba(255, 206, 90, 0.55));
  animation: mi-intro-chase 0.9s steps(1, end) infinite;
}
.mi-intro-bulbs.is-bottom {
  animation-delay: -0.45s;
}
@keyframes mi-intro-chase {
  50% { background-position: 8px 0; }
}
.mi-intro-titlerow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(10px, 3vw, 24px);
  margin: 14px 0 16px;
}
.mi-intro-title {
  margin: 0;
  font: 700 clamp(30px, 8vw, 58px)/1 var(--mi-font-pixel);
  letter-spacing: 0.04em;
  white-space: nowrap;
  color: #ffd84d;
  text-shadow: 3px 3px 0 #1f1402;
}
.mi-intro-title.is-pixel {
  line-height: 0;
}
.mi-intro-title-canvas {
  display: block;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  filter: drop-shadow(0 8px 10px rgba(0, 0, 0, 0.45));
}
.mi-intro-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.mi-intro-coin {
  flex: none;
  display: block;
  color: #ffd84d;
  filter: drop-shadow(2px 2px 0 #1f1402) drop-shadow(0 0 6px rgba(255, 200, 70, 0.35));
  animation: mi-intro-spin 1.6s steps(8, end) infinite;
}
.mi-intro-coin.is-late {
  animation-delay: -0.8s;
}
.mi-intro-sub {
  display: inline-block;
  margin: 0 0 10px;
  padding: 6px 12px 5px;
  font: 400 clamp(8px, 2.3vw, 12px)/1.1 var(--mi-font-pixel);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--mi-lcd-ink);
  text-shadow: 0 0 6px rgba(255, 190, 60, 0.5);
  background:
    repeating-linear-gradient(180deg, rgba(255, 255, 255, 0.04) 0 1px, transparent 1px 3px),
    var(--mi-screen);
  border: 1px solid;
  border-color: var(--mi-screen-lo) var(--mi-screen-hi) var(--mi-screen-hi) var(--mi-screen-lo);
  -webkit-font-smoothing: none;
}

/* parchment */
.mi-intro-body {
  margin-top: 5px;
  padding: 14px 16px 12px;
  background-color: var(--mi-paper);
  background-image: ${NOISE};
  border: 1px solid;
  border-color: var(--mi-outline) var(--mi-frame-hi) var(--mi-frame-hi) var(--mi-outline);
  box-shadow: inset 1px 1px 0 rgba(120, 96, 50, 0.28);
}
.mi-intro-primer {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
}
.mi-intro-primer li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--mi-ink-2);
}
.mi-intro-primer b {
  color: var(--mi-ink);
}
.mi-intro-primer .mi-icon {
  flex: none;
}
.mi-intro-label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font: 700 8px/1 var(--mi-font-pixel);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: #3b3020;
  -webkit-font-smoothing: none;
}
.mi-intro-label::after {
  content: '';
  flex: 1;
  height: 3px;
  border-top: 1px solid var(--mi-rule-2);
  border-bottom: 1px solid var(--mi-paper-hi);
}

/* scenario cards */
.mi-intro-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.mi-intro-card.is-wide {
  grid-column: 1 / -1;
  min-height: 0;
}
.mi-intro-card {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 96px;
  margin: 0;
  padding: 9px 26px 9px 9px;
  font: 12px/1.35 var(--mi-font-ui);
  color: var(--mi-ink);
  text-align: left;
  background: linear-gradient(180deg, #f7efda 0%, var(--mi-key) 55%, var(--mi-key-2) 100%);
  border: 1px solid var(--mi-key-edge);
  box-shadow:
    inset 1px 1px 0 var(--mi-key-hi),
    inset -1px -1px 0 var(--mi-key-lo);
  clip-path: var(--mi-notch);
  cursor: pointer;
}
.mi-intro-card:hover {
  background: linear-gradient(180deg, #fcf6e6 0%, #f3e9cd 55%, #e7dab6 100%);
}
.mi-intro-card.is-on {
  color: var(--mi-brass-ink);
  background: linear-gradient(180deg, #f4dc86 0%, #e3c257 55%, #d5ad37 100%);
  box-shadow:
    inset 1px 1px 0 var(--mi-brass-lo),
    inset 2px 2px 0 rgba(124, 95, 16, 0.35),
    inset -1px -1px 0 var(--mi-brass-hi);
  cursor: default;
}
.mi-intro-card.is-on > * {
  transform: translate(1px, 1px);
}
.mi-intro-card:focus-visible {
  outline: 2px dotted var(--mi-ink);
  outline-offset: -6px;
}
.mi-intro-card-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  background: var(--mi-frame-deep);
  border: 1px solid var(--mi-outline);
  box-shadow:
    inset 1px 1px 0 var(--mi-frame-hi2),
    inset -1px -1px 0 var(--mi-frame-lo);
}
.mi-intro-card-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.mi-intro-card-title {
  font: 600 18px/1.1 var(--mi-font-title);
}
.mi-intro-card-blurb {
  font-size: 11.5px;
  line-height: 1.35;
  color: var(--mi-ink-2);
}
.mi-intro-card.is-on .mi-intro-card-blurb {
  color: #3d2c07;
}
.mi-intro-card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 3px;
}
.mi-intro-card-check {
  position: absolute;
  top: 8px;
  right: 8px;
  color: var(--mi-brass-ink);
  visibility: hidden;
}
.mi-intro-card.is-on .mi-intro-card-check {
  visibility: visible;
}

/* seed + start */
.mi-intro-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 16px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--mi-rule);
  box-shadow: inset 0 1px 0 var(--mi-paper-hi);
}
.mi-intro-seed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 7px;
}
.mi-intro-seed-label {
  font: 700 8px/1 var(--mi-font-pixel);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--mi-ink-2);
  -webkit-font-smoothing: none;
}
.mi-intro-seed-input {
  width: 92px;
  height: 30px;
  margin: 0;
  padding: 1px 8px 0;
  font: 400 16px/1 var(--mi-font-pixel);
  color: var(--mi-lcd-ink);
  text-shadow: 0 0 6px rgba(255, 190, 60, 0.45);
  caret-color: var(--mi-lcd-ink);
  background:
    repeating-linear-gradient(180deg, rgba(255, 255, 255, 0.035) 0 1px, transparent 1px 3px),
    var(--mi-screen);
  border: 1px solid;
  border-color: var(--mi-screen-lo) var(--mi-screen-hi) var(--mi-screen-hi) var(--mi-screen-lo);
  border-radius: 0;
  outline: none;
  -moz-appearance: textfield;
  appearance: textfield;
  user-select: text;
  -webkit-user-select: text;
}
.mi-intro-seed-input::-webkit-inner-spin-button,
.mi-intro-seed-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.mi-intro-seed-input:focus-visible {
  box-shadow: 0 0 0 2px var(--mi-brass-hi);
}
.mi-intro-dice.mi-btn {
  width: 32px;
  height: 30px;
}
.mi-intro-dice.is-rolling .mi-icon {
  animation: mi-intro-roll 0.45s steps(6, end);
}
@keyframes mi-intro-roll {
  from { transform: rotate(-360deg) scale(1.25); }
}
.mi-intro-town {
  font-size: 12px;
  color: var(--mi-ink-2);
  white-space: nowrap;
}
.mi-intro-town b {
  font: 600 15px/1 var(--mi-font-title);
  color: var(--mi-ink);
}
.mi-intro-gowrap {
  display: inline-flex;
  filter: drop-shadow(0 0 0 rgba(255, 214, 90, 0));
  animation: mi-intro-glow 1.4s steps(2, end) infinite;
}
@keyframes mi-intro-glow {
  50% { filter: drop-shadow(0 0 7px rgba(255, 214, 90, 0.75)); }
}
.mi-intro-go.mi-btn {
  height: 44px;
  min-width: 230px;
  gap: 12px;
  padding: 0 22px 0 26px;
  font: 600 21px/1 var(--mi-font-title);
  letter-spacing: 0.02em;
}
.mi-intro-go:focus-visible {
  outline: 2px dotted var(--mi-brass-ink);
  outline-offset: -7px;
}
.mi-intro-hint {
  margin-top: 11px;
  font: 8px/1 var(--mi-font-pixel);
  letter-spacing: 0.5px;
  text-align: center;
  text-transform: uppercase;
  color: var(--mi-ink-3);
  white-space: pre;
  -webkit-font-smoothing: none;
}
@media (hover: none) {
  .mi-intro-hint {
    display: none;
  }
}
@media (max-width: 640px) {
  .mi-intro {
    padding: 8px;
  }
  .mi-intro-marquee {
    padding: 6px 6px 8px;
  }
  .mi-intro-titlerow {
    margin: 10px 0 12px;
  }
  .mi-intro-body {
    padding: 11px 10px 10px;
  }
  .mi-intro-primer {
    grid-template-columns: 1fr;
    gap: 7px;
    margin-bottom: 12px;
  }
  .mi-intro-primer .mi-icon img {
    width: 24px;
    height: 24px;
  }
  .mi-intro-cards {
    grid-template-columns: 1fr;
  }
  .mi-intro-card {
    min-height: 0;
  }
  .mi-intro-foot {
    flex-direction: column;
    align-items: stretch;
  }
  .mi-intro-gowrap,
  .mi-intro-go.mi-btn {
    width: 100%;
    min-width: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .mi-intro,
  .mi-intro * {
    animation: none !important;
  }
  .mi-intro-coins {
    display: none;
  }
}
`;
  document.head.appendChild(el);
}
