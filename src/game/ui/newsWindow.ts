// News: every headline the city has produced, newest first, with topic filters. Rows with an
// agent (or a building lot) are buttons that take you there. New headlines are prepended in
// place (rows are never rebuilt under the pointer) and the reading position is kept while you
// are scrolled down the list.

import { badge, choice, glyph, h, iconEl, isOpen, openWindow, type WindowCtx } from '../../ui';
import type { Economy } from '../../sim/economy';
import { fmtDate } from '../../sim/format';
import type { NewsItem } from '../../sim/types';
import type { Game } from '../game';
import type { UIContext } from './context';

export type NewsCategory = 'banks' | 'business' | 'housing' | 'economy' | 'policy';
type Filter = 'all' | NewsCategory;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'banks', label: 'Banks' },
  { id: 'business', label: 'Business' },
  { id: 'housing', label: 'Housing' },
  { id: 'economy', label: 'Economy' },
  { id: 'policy', label: 'Policy' },
];

const CAT: Record<NewsCategory, { label: string; icon: string }> = {
  banks: { label: 'Banks', icon: '🏦' },
  business: { label: 'Business', icon: '🏪' },
  housing: { label: 'Housing', icon: '🏠' },
  economy: { label: 'Economy', icon: '📈' },
  policy: { label: 'Policy', icon: '🏛️' },
};

/** Most rows kept in the list. */
const LIMIT = 200;
/** Alerts keep blinking for this many days. */
const BLINK_DAYS = 30;

let filter: Filter = 'all';
/** Newest headline the player has seen (per game). */
const seen: { eco: Economy | null; id: number } = { eco: null, id: 0 };

// ---------------------------------------------------------------------------------------------
// Topic heuristics

const RX_POLICY = /\b(policy rate|reserve requirement|capital requirement|liquidity requirement|deposit insurance|emergency lending|asset purchases|quantitative easing)\b/i;
const RX_HOUSING = /\b(homes?|houses?|housing|apartments?|mortgages?|property|properties|rents?|renters?|landlords?|tenants?|construction|foreclos\w*)\b/i;
const RX_BUSINESS = /\b(entrepreneurs?|grand opening|closes its doors|expan\w*|business\w*|start-?ups?|shops?|stores?|factor(y|ies)|firms?|hiring|layoffs?)\b/i;
const RX_ECONOMY = /\b(inflation|deflation|prices?|unemploy\w*|jobs?|jobless|recession|labour|labor|wages?|gdp|economy)\b/i;
const RX_BANKS = /\b(banks?|banking|lend\w*|loans?|credit|deposits?|depositors?|runs?|liquidity|bail\w*|capital|mbs|securiti\w*|money supply|reserves?)\b/i;

/** Which topic a headline belongs to (agent kind first, then keywords). */
export function newsCategory(item: NewsItem, eco: Economy): NewsCategory {
  const t = item.text;
  if (item.tone === 'policy' || RX_POLICY.test(t)) return 'policy';
  if (/^welcome\b/i.test(t)) return 'economy';
  const kind = item.agent !== undefined ? eco.agents.get(item.agent)?.kind : undefined;
  if (kind === 'bank') return 'banks';
  if (RX_HOUSING.test(t)) return 'housing';
  if (RX_BUSINESS.test(t)) return 'business';
  if (kind === 'firm') return 'business';
  if (kind === 'household') return 'housing';
  if (kind === 'fund') return 'banks';
  if (RX_ECONOMY.test(t)) return 'economy';
  if (RX_BANKS.test(t)) return 'banks';
  return 'economy';
}

/** Headlines that arrived since the player last looked at the News window (0 while it is open). */
export function unreadNewsCount(game: Game): number {
  if (isOpen('news')) return 0;
  const items = game.eco.news.items;
  const since = seen.eco === game.eco ? seen.id : 0;
  let n = 0;
  for (let i = items.length - 1; i >= 0 && items[i].id > since; i--) n++;
  return n;
}

function latestId(eco: Economy): number {
  const items = eco.news.items;
  return items.length ? items[items.length - 1].id : 0;
}

function markSeen(eco: Economy): void {
  seen.eco = eco;
  seen.id = latestId(eco);
}

// ---------------------------------------------------------------------------------------------

/** Open (or focus) the News window. */
export function openNewsWindow(ctx: UIContext): void {
  injectStyle();
  const eco0 = ctx.game.eco;
  if (isOpen('news')) markSeen(eco0); // already reading: nothing is "new" on refocus
  const st = {
    eco: null as Economy | null,
    lastId: 0,
    /** headlines newer than this were unread when the window opened */
    since: seen.eco === eco0 ? seen.id : 0,
    list: null as HTMLElement | null,
    count: null as HTMLElement | null,
  };

  const matches = (it: NewsItem, eco: Economy) => filter === 'all' || newsCategory(it, eco) === filter;

  const countText = (eco: Economy, shown: number) => {
    const total = eco.news.items.length;
    if (!total) return '';
    return filter === 'all' ? `${total} headline${total === 1 ? '' : 's'}` : `${shown} of ${total}`;
  };

  const emptyRow = () =>
    h(
      'div',
      { class: 'mi-news-empty' },
      filter === 'all' ? 'No news yet. The town is quiet… for now.' : `No ${CAT[filter].label.toLowerCase()} news yet.`,
    );

  const go = (it: NewsItem) => {
    if (it.agent !== undefined) ctx.showAgent(it.agent);
    else if (it.lot !== undefined) ctx.showOnMap({ kind: 'lot', id: it.lot });
  };

  const row = (it: NewsItem, eco: Economy, fresh: boolean): HTMLElement => {
    const cat = newsCategory(it, eco);
    const clickable = it.agent !== undefined || it.lot !== undefined;
    const live = it.tone === 'alert' && eco.day - it.day <= BLINK_DAYS;
    const tag =
      it.tone === 'alert'
        ? badge('Alert', 'bad', { blink: live })
        : it.tone === 'policy'
          ? badge('Policy', 'info')
          : null;
    const content = [
      iconEl(CAT[cat].icon, { px: 12, className: 'mi-news-ico' }),
      h(
        'span',
        { class: 'mi-news-main' },
        h(
          'span',
          { class: 'mi-news-meta' },
          it.id > st.since ? h('i', { class: 'mi-news-dot', title: 'New' }) : null,
          h('span', { class: 'mi-news-date' }, fmtDate(it.day)),
          h('span', { class: 'mi-news-cat' }, CAT[cat].label),
          tag,
        ),
        h('span', { class: 'mi-news-text' }, it.text),
      ),
      clickable ? h('span', { class: 'mi-news-go', 'aria-hidden': 'true' }, glyph('right')) : null,
    ];
    const cls = ['mi-news-row', `is-${it.tone}`, clickable && 'is-clickable', live && 'is-live', fresh && 'is-fresh'];
    const data = { day: it.day, id: it.id };
    if (!clickable) return h('div', { class: cls, dataset: data }, content);
    return h(
      'button',
      {
        type: 'button',
        class: cls,
        dataset: data,
        tip: it.agent !== undefined ? 'Show on the map' : 'Show this place on the map',
        onclick: () => go(it),
      },
      content,
    );
  };

  const render = (body: HTMLElement, w: WindowCtx) => {
    const eco = ctx.game.eco;
    if (st.eco && st.eco !== eco) st.since = 0; // a new city: everything is news
    st.eco = eco;
    st.lastId = latestId(eco);
    const items = eco.news.items;
    const rows: HTMLElement[] = [];
    for (let i = items.length - 1; i >= 0 && rows.length < LIMIT; i--) {
      const it = items[i];
      if (matches(it, eco)) rows.push(row(it, eco, false));
    }
    st.list = h('div', { class: 'mi-news-list' }, rows.length ? rows : emptyRow());
    st.count = h('span', { class: 'mi-news-count' }, countText(eco, rows.length));
    body.append(
      h(
        'div',
        { class: 'mi-news-head' },
        choice({
          small: true,
          value: filter,
          options: FILTERS.map((f) => ({ id: f.id, label: f.label, title: f.id === 'all' ? 'Every headline' : `${f.label} news only` })),
          onChange: (id) => {
            filter = (FILTERS.find((f) => f.id === id)?.id ?? 'all') as Filter;
            w.win.rerender();
            w.win.body.scrollTop = 0;
          },
        }),
        st.count,
      ),
      st.list,
    );
  };

  const update = (body: HTMLElement, w: WindowCtx) => {
    const eco = ctx.game.eco;
    const list = st.list;
    if (eco !== st.eco || !list || !list.isConnected) {
      w.win.rerender();
      return;
    }
    // Stop blinking alerts once they are old news.
    for (const el of list.querySelectorAll<HTMLElement>('.mi-news-row.is-live')) {
      if (eco.day - Number(el.dataset.day) > BLINK_DAYS) {
        el.classList.remove('is-live');
        el.querySelector('.mi-blink')?.classList.remove('mi-blink');
      }
    }
    const latest = latestId(eco);
    if (latest === st.lastId) return;
    const items = eco.news.items;
    const fresh: HTMLElement[] = [];
    for (let i = items.length - 1; i >= 0 && items[i].id > st.lastId; i--) {
      if (matches(items[i], eco)) fresh.push(row(items[i], eco, true));
    }
    st.lastId = latest;
    if (fresh.length) {
      const atTop = body.scrollTop < 4;
      const before = body.scrollHeight;
      list.querySelector('.mi-news-empty')?.remove();
      list.prepend(...fresh);
      // Reading further down? Keep the same headlines under the eyes.
      if (!atTop) body.scrollTop += body.scrollHeight - before;
      while (list.children.length > LIMIT) list.lastElementChild?.remove();
    }
    if (st.count) st.count.textContent = countText(eco, list.querySelectorAll('.mi-news-row').length);
  };

  openWindow({
    id: 'news',
    title: 'News',
    icon: '📰',
    width: 420,
    height: 500,
    className: 'mi-news-win',
    render,
    update,
    onClose: () => markSeen(ctx.game.eco),
  });
}

// ---------------------------------------------------------------------------------------------
// Styles (injected once)

const STYLE_ID = 'mi-news-style';

function injectStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
.mi-news-win .mi-win-body {
  padding-top: 0;
}
.mi-news-head {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 8px;
  margin: 0 -8px 6px;
  padding: 7px 8px 6px;
  background: var(--mi-paper);
  border-bottom: 1px solid var(--mi-rule-2);
  box-shadow: 0 1px 0 var(--mi-paper-hi), 0 3px 4px -2px rgba(60, 40, 10, 0.18);
}
.mi-news-count {
  font: 8px/1 var(--mi-font-pixel);
  text-transform: uppercase;
  color: var(--mi-ink-3);
  white-space: nowrap;
  -webkit-font-smoothing: none;
}
.mi-news-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.mi-news-row {
  --bar: #a8946a;
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  width: 100%;
  margin: 0;
  padding: 5px 7px 6px 9px;
  font: 12px/1.35 var(--mi-font-ui);
  color: var(--mi-ink);
  text-align: left;
  background: rgba(251, 246, 232, 0.55);
  border: 1px solid;
  border-color: var(--mi-paper-hi) var(--mi-paper-lo) var(--mi-paper-lo) var(--mi-paper-hi);
  box-shadow: inset 3px 0 0 var(--bar);
}
.mi-news-row.is-good { --bar: #3d8a43; }
.mi-news-row.is-bad { --bar: #c0392b; }
.mi-news-row.is-policy { --bar: #2f72b3; }
.mi-news-row.is-alert {
  --bar: #c0392b;
  background: rgba(214, 86, 64, 0.13);
}
html[data-mi-blink] .mi-news-row.is-live {
  --bar: #fff1c2;
}
.mi-news-row.is-clickable {
  cursor: pointer;
}
.mi-news-row.is-clickable:hover {
  background: #f1dc94;
}
.mi-news-row.is-clickable:active {
  background: #e8cc6e;
}
.mi-news-row:focus-visible {
  outline: 1px dotted var(--mi-ink);
  outline-offset: -3px;
}
.mi-news-row.is-fresh {
  animation: mi-news-in 1.2s steps(6, end);
}
@keyframes mi-news-in {
  from { background: #f6e08f; }
}
.mi-news-ico {
  flex: none;
  margin-top: 1px;
}
.mi-news-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mi-news-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  font: 8px/10px var(--mi-font-pixel);
  text-transform: uppercase;
  color: var(--mi-ink-3);
  -webkit-font-smoothing: none;
}
.mi-news-date {
  color: var(--mi-ink-2);
}
.mi-news-cat::before {
  content: '·';
  margin-right: 5px;
}
.mi-news-dot {
  width: 5px;
  height: 5px;
  background: var(--mi-brass);
  box-shadow: 0 0 0 1px var(--mi-brass-lo);
}
.mi-news-meta .mi-badge {
  height: 12px;
}
.mi-news-text {
  overflow-wrap: anywhere;
}
.mi-news-row.is-alert .mi-news-text {
  font-weight: 700;
}
.mi-news-go {
  flex: none;
  align-self: center;
  color: var(--mi-ink-3);
  opacity: 0.55;
}
.mi-news-row.is-clickable:hover .mi-news-go {
  color: var(--mi-ink);
  opacity: 1;
}
.mi-news-empty {
  padding: 28px 8px;
  font-style: italic;
  text-align: center;
  color: var(--mi-ink-3);
}
@media (prefers-reduced-motion: reduce) {
  .mi-news-row.is-fresh {
    animation: none;
  }
}
`;
  document.head.appendChild(el);
}
