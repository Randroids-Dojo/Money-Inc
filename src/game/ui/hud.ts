// The game's chrome: the bottom status strip (date, speed, news ticker, key indicators, tools),
// the map-view panel (lenses, money-flow overlay and legends) and crisis alerts.

import { button, glyph, h, iconButton, lcd, stat, strip, stripGroup, ticker, setUiInsets, type TickerEl, type Tone } from '../../ui';
import { fmtMoney, pct } from '../../sim/format';
import { COIN_COLOURS, COIN_LABELS, type CoinKind } from '../../render/effects';
import type { Lens, Speed } from '../game';
import { grade } from '../mandate';
import { unreadNewsCount } from './newsWindow';
import type { UIContext } from './context';

export interface HudActions {
  openReserveBank(): void;
  openStats(): void;
  openNews(): void;
  openHelp(): void;
  newGame(): void;
}

const LENSES: { id: Lens; label: string; icon: string; tip: string }[] = [
  { id: 'none', label: 'City', icon: '🏙️', tip: 'The plain city view.' },
  { id: 'banks', label: 'Banks', icon: '🏦', tip: 'Which bank holds each building’s money (market share).' },
  { id: 'debt', label: 'Debt', icon: '📉', tip: 'Who owes money, and who is falling behind.' },
  { id: 'origin', label: 'Origin', icon: '🧬', tip: 'Which bank originally created the money now sitting in each account.' },
  { id: 'value', label: 'Property', icon: '🏠', tip: 'Home values.' },
  { id: 'jobs', label: 'Jobs', icon: '👷', tip: 'Where people are out of work, and which firms are hiring or cutting.' },
];

export interface Hud {
  update(): void;
  cycleLens(): void;
  toggleFlows(): void;
  /** Show an advisor tip (blue toast) with an optional "show me" action. */
  tip(text: string, show?: () => void): void;
  /**
   * A game mode's own tools (shown before the standard ones) and indicators (replacing the
   * standard ones). Pass nulls to restore the standard strip.
   */
  setMode(tools: HTMLElement | null, stats: (() => HTMLElement[]) | null): void;
  /** Push the top-right alert stack down (to make room for a mode's panel). */
  setAlertsTop(px: number): void;
}

export function createHud(ctx: UIContext, act: HudActions): Hud {
  const game = ctx.game;
  const dateEl = lcd('');
  const speedGroup = stripGroup();
  const news: TickerEl = ticker([], { max: 6, speed: 45 });
  news.classList.add('gm-ticker');
  news.addEventListener('click', () => act.openNews());
  const statsGroup = h('div', { class: 'gm-hud-stats' });
  const newsBtn = iconButton('📰', 'News (N)', () => act.openNews(), { small: true });
  newsBtn.classList.add('gm-has-badge');
  const newsBadge = h('span', { class: 'gm-count' });
  newsBadge.hidden = true;
  newsBtn.append(newsBadge);
  const tools = stripGroup(
    iconButton('🏛️', 'Reserve Bank — your controls (B)', () => act.openReserveBank(), { small: true }),
    iconButton('📊', 'Statistics (G)', () => act.openStats(), { small: true }),
    newsBtn,
    iconButton('❓', 'How it works (H)', () => act.openHelp(), { small: true }),
    iconButton('🎲', 'New city', () => act.newGame(), { small: true }),
  );
  tools.classList.add('gm-hud-tools');
  const modeTools = stripGroup();
  modeTools.classList.add('gm-hud-tools');
  modeTools.hidden = true;
  let modeStats: (() => HTMLElement[]) | null = null;
  const hud = strip(stripGroup(dateEl), speedGroup, news, statsGroup, modeTools, tools);
  hud.classList.add('gm-hud');
  document.body.appendChild(hud);

  // ---- map view panel (top-left)
  const lensRow = h('div', { class: 'gm-lens-row' });
  const legend = h('div', { class: 'gm-legend' });
  const panel = h('div', { class: 'gm-mapbar mi-ui' }, lensRow);
  document.body.appendChild(panel);
  legend.classList.add('mi-ui');
  document.body.appendChild(legend);

  // ---- alerts (top-right) and the pause banner
  const alerts = h('div', { class: 'gm-alerts' });
  document.body.appendChild(alerts);
  const paused = h('button', { class: 'gm-paused mi-ui', title: 'Resume (Space)', onclick: () => game.togglePause() }, 'PAUSED');
  paused.hidden = true;
  document.body.appendChild(paused);

  let lastNewsId = 0;
  let lastLens: Lens | null = null;
  let lastFlows: boolean | null = null;
  let lastSpeed: Speed | -1 = -1;

  const renderSpeed = () => {
    const speeds: Speed[] = [1, 2, 5, 10];
    speedGroup.replaceChildren(
      iconButton(glyph('pause'), 'Pause (Space)', () => game.togglePause(), { small: true, active: game.speed === 0 }),
      ...speeds.map((s) => button(`${s}×`, () => game.setSpeed(s), { small: true, active: game.speed === s, title: `Speed ${s}× (${speeds.indexOf(s) + 1})` })),
    );
  };

  const renderLens = () => {
    lensRow.replaceChildren(
      ...LENSES.map((l) =>
        button(l.label, () => {
          game.lens = l.id;
          renderLens();
        }, { small: true, icon: l.icon, active: game.lens === l.id, title: l.tip }),
      ),
      h('span', { class: 'gm-lens-sep' }),
      button('Money', () => {
        game.showFlows = !game.showFlows;
        renderLens();
      }, { small: true, icon: '💸', active: game.showFlows, title: 'Show money moving around the city (F)' }),
    );
    const lg = ctx.renderer.lensLegend(game.lens);
    if (lg) {
      legend.replaceChildren(
        h('div', { class: 'gm-legend-title' }, lg.title),
        ...lg.items.map((it) => h('div', { class: 'gm-legend-item' }, h('i', { style: { background: it.color } }), it.label)),
        h('div', { class: 'gm-legend-note' }, 'Column height = size'),
      );
      legend.style.display = '';
    } else if (game.showFlows) {
      const kinds: CoinKind[] = ['new', 'destroy', 'spend', 'wage', 'income', 'public', 'property', 'market', 'bank'];
      legend.replaceChildren(
        h('div', { class: 'gm-legend-title' }, 'Money on the move'),
        ...kinds.map((k) => h('div', { class: 'gm-legend-item', dataset: { kind: k } }, h('i', { style: { background: COIN_COLOURS[k] } }), COIN_LABELS[k])),
      );
      legend.style.display = '';
    } else legend.style.display = 'none';
    lastLens = game.lens;
    lastFlows = game.showFlows;
  };

  const tone = (v: number, bad: number, warn: number, invert = false): Tone | undefined => {
    if (!Number.isFinite(v)) return undefined;
    if (invert) return v < bad ? 'bad' : v < warn ? 'warn' : undefined;
    return v > bad ? 'bad' : v > warn ? 'warn' : undefined;
  };

  const renderStats = () => {
    if (modeStats) {
      statsGroup.replaceChildren(...modeStats());
      return;
    }
    const eco = game.eco;
    const st = eco.stats;
    const has = st.length > 0;
    const L = (k: Parameters<typeof st.last>[0]) => (has ? st.last(k) : NaN);
    const infl = L('inflation');
    const u = has ? L('unemployment') : eco.unemploymentRate();
    const yearOld = st.length > 12;
    const mg = yearOld ? L('moneyGrowth') : NaN;
    const cg = yearOld ? L('creditGrowth') : NaN;
    const hg = yearOld ? L('hpiGrowth') : NaN;
    statsGroup.replaceChildren(
      stat('Money', fmtMoney(eco.broadMoney()), Number.isFinite(mg) ? { value: mg, text: pct(Math.abs(mg), 1), good: 'none' } : null, {
        tip: 'Broad money: all bank deposits. It grows when banks lend and shrinks when loans are repaid.',
      }),
      stat('Credit', fmtMoney(eco.totalCredit()), Number.isFinite(cg) ? { value: cg, text: pct(Math.abs(cg), 1), good: 'none' } : null, { tip: 'All loans outstanding (12-month change).' }),
      stat('Inflation', Number.isFinite(infl) && yearOld ? pct(infl) : '—', null, { tone: tone(infl, 0.06, 0.035) ?? (infl < 0 ? 'warn' : undefined), tip: 'Consumer prices vs a year ago.' }),
      stat('Jobless', pct(u), null, { tone: tone(u, 0.1, 0.07), tip: 'Unemployment rate.' }),
      stat('Homes', Number.isFinite(hg) ? `${hg >= 0 ? '+' : ''}${pct(hg)}` : '—', null, { tone: tone(Math.abs(hg), 0.15, 0.08), tip: 'House prices vs a year ago.' }),
      stat('Rate', pct(eco.policy.policyRate, 2), null, { tip: eco.policy.autopilot ? 'Policy rate (on autopilot)' : 'Policy rate — you set it at the Reserve Bank.' }),
      stat('Approval', `${Math.round(game.mandate.approval)}% ${grade(game.mandate.approval)}`, null, {
        tone: game.mandate.approval < 45 ? 'bad' : game.mandate.approval < 58 ? 'warn' : undefined,
        tip: 'How the public rates you, the Reserve Bank: stable prices (2% inflation), jobs, and no bank failures.',
      }),
    );
  };

  const pushNews = () => {
    const items = game.eco.news.items;
    for (const n of items) {
      if (n.id <= lastNewsId) continue;
      lastNewsId = n.id;
      const t: Tone = n.tone === 'good' ? 'good' : n.tone === 'bad' ? 'bad' : n.tone === 'alert' ? 'bad' : n.tone === 'policy' ? 'info' : 'muted';
      news.push(n.text, t);
      if (n.tone === 'alert') showAlert(n.text, n.agent, n.lot);
    }
  };

  const showAlert = (text: string, agent?: number, lot?: number) => {
    const el = h(
      'div',
      { class: 'gm-alert mi-ui' },
      h('span', { class: 'gm-alert-icon' }, '⚠'),
      h('span', { class: 'gm-alert-text' }, text),
      agent !== undefined || lot !== undefined
        ? button('Show', () => {
            if (agent !== undefined) ctx.showAgent(agent);
            else if (lot !== undefined) ctx.showOnMap({ kind: 'lot', id: lot });
            el.remove();
          }, { small: true, primary: true })
        : '',
      iconButton(glyph('close'), 'Dismiss', () => el.remove(), { small: true }),
    );
    alerts.prepend(el);
    while (alerts.children.length > 3) alerts.lastElementChild?.remove();
    window.setTimeout(() => el.remove(), 12000);
  };

  const showTip = (text: string, show?: () => void) => {
    const el = h(
      'div',
      { class: 'gm-alert gm-tip mi-ui' },
      h('span', { class: 'gm-alert-icon' }, '💡'),
      h('span', { class: 'gm-alert-text' }, text),
      show
        ? button('Show me', () => {
            show();
            el.remove();
          }, { small: true, primary: true })
        : '',
      iconButton(glyph('close'), 'Got it', () => el.remove(), { small: true }),
    );
    alerts.append(el);
    while (alerts.children.length > 3) alerts.firstElementChild?.remove();
    window.setTimeout(() => el.remove(), 20000);
  };

  const syncInsets = () => {
    setUiInsets({ bottom: hud.offsetHeight, top: lensRow.offsetHeight + 12 });
    legend.style.bottom = `${hud.offsetHeight + 8}px`;
  };
  window.addEventListener('resize', syncInsets);
  game.on.newGame.push(() => {
    // headlines belong to the town they happened in, not the one behind the title screen
    lastNewsId = 0;
    news.clear();
    alerts.replaceChildren();
  });

  const update = () => {
    const d = game.eco.day;
    const y = Math.floor(d / 360) + 1;
    const mo = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Math.floor((d % 360) / 30)];
    const t = `${mo} ${String((d % 30) + 1).padStart(2, '0')} Y${y}`;
    if (dateEl.textContent !== t) dateEl.textContent = t;
    if (game.speed !== lastSpeed) {
      renderSpeed();
      lastSpeed = game.speed;
    }
    paused.hidden = game.speed !== 0 || !!document.querySelector('.mi-intro-root, .mi-intro');
    if (game.lens !== lastLens || game.showFlows !== lastFlows) renderLens();
    renderStats();
    pushNews();
    const unread = unreadNewsCount(game);
    newsBadge.hidden = unread === 0;
    const label = unread > 99 ? '99+' : String(unread);
    if (newsBadge.textContent !== label) newsBadge.textContent = label;
    syncInsets();
  };

  renderSpeed();
  renderLens();
  update();
  return {
    update,
    cycleLens() {
      const i = LENSES.findIndex((l) => l.id === game.lens);
      game.lens = LENSES[(i + 1) % LENSES.length].id;
      renderLens();
    },
    toggleFlows() {
      game.showFlows = !game.showFlows;
      renderLens();
    },
    tip: showTip,
    setMode(t, s) {
      modeTools.replaceChildren(...(t ? [t] : []));
      modeTools.hidden = !t;
      modeStats = s;
      renderStats();
    },
    setAlertsTop(px) {
      alerts.style.top = px > 0 ? `calc(${px}px + env(safe-area-inset-top, 0px))` : '';
    },
  };
}
