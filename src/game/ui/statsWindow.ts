// City Statistics: the monthly record of money, the economy, housing, banks, interest rates and
// business life. Charts are memoised on the month (plus range/view), so they rebuild only when a
// new month is recorded and keep their hover crosshair through the 4 Hz window refresh. The
// headline tiles and the "this month so far" money ledger are live.

import {
  appendChildren,
  badge,
  choice,
  glyph,
  h,
  kv,
  lineChart,
  note,
  openWindow,
  section,
  sparkline,
  stat,
  table,
  type ChartMarker,
  type Child,
  type Delta,
  type KvRow,
  type LineChartOpts,
  type SectionTitle,
  type TableColumn,
  type Tone,
  type WindowCtx,
} from '../../ui';
import { COIN_COLOURS } from '../../render/effects';
import { CFG } from '../../sim/config';
import type { Economy } from '../../sim/economy';
import { fmtDate, fmtMoney, pct } from '../../sim/format';
import type { SeriesKey } from '../../sim/stats';
import type { UIContext } from './context';

type TabId = 'money' | 'economy' | 'housing' | 'banks' | 'rates' | 'business';
type View = 'charts' | 'table';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'money', label: 'Money & Credit', icon: '💵' },
  { id: 'economy', label: 'Economy', icon: '📈' },
  { id: 'housing', label: 'Housing', icon: '🏠' },
  { id: 'banks', label: 'Banks', icon: '🏦' },
  { id: 'rates', label: 'Rates', icon: '🏛️' },
  { id: 'business', label: 'Business', icon: '🏪' },
];

const RANGES: { id: string; label: string; months: number; title: string }[] = [
  { id: '2y', label: '2Y', months: 24, title: 'Last 2 years' },
  { id: '5y', label: '5Y', months: 60, title: 'Last 5 years' },
  { id: '10y', label: '10Y', months: 120, title: 'Last 10 years' },
  { id: 'all', label: 'All', months: 0, title: 'Since the city was founded' },
];

/** Rows shown in the table view (newest first). */
const TABLE_ROWS = 120;

// Remembered between openings (per session).
let rangeId = 'all';
let view: View = 'charts';
let lastTab: TabId = 'money';

const isTab = (t: string | undefined): t is TabId => !!t && TABS.some((x) => x.id === t);

/**
 * Open (or focus) the City Statistics window, optionally on a tab:
 * 'money' | 'economy' | 'housing' | 'banks' | 'rates' | 'business'.
 */
export function openStatsWindow(ctx: UIContext, tab?: string): void {
  injectStyle();
  openWindow({
    id: 'stats',
    title: 'City Statistics',
    icon: '📊',
    width: 560,
    className: 'mi-stats-win',
    tabs: TABS,
    initialTab: isTab(tab) ? tab : lastTab,
    // No custom update(): the toolkit re-renders ~4x a second (skipping while the player is
    // pressing or selecting in the window); charts and sparklines come back from the memo.
    render: (body, w) => renderStats(body, w, ctx),
  });
}

// ---------------------------------------------------------------------------------------------
// Series colours (bright traces on the dark instrument screen). Money created / destroyed use
// the same colours as the coins on the map. Adjacent series in each chart were checked for
// colour-blind separation.

const C = {
  money: COIN_COLOURS.new,
  destroyed: COIN_COLOURS.destroy,
  credit: '#ff9a3c',
  teal: '#5fd3c6',
  purple: '#c9a0ff',
  cream: '#e8e1c4',
  pink: COIN_COLOURS.property,
  blue: '#6fb4ff',
  gold: '#f2c14e',
  coral: '#ff7a5c',
  lime: '#9be07a',
  steel: '#8fb3b8',
  spend: COIN_COLOURS.spend,
  invest: COIN_COLOURS.market,
  public: COIN_COLOURS.public,
  wage: COIN_COLOURS.wage,
};

// ---------------------------------------------------------------------------------------------
// Formatting

const money = (v: number): string => (Number.isFinite(v) ? fmtMoney(v) : '—');
const moneyAbs = (v: number): string => money(Math.abs(v));
const signedMoney = (v: number): string => (Number.isFinite(v) ? `${v < 0 ? '−' : '+'}${fmtMoney(Math.abs(v))}` : '—');
const count = (v: number): string => (Number.isFinite(v) ? String(Math.round(v)) : '—');
const countAbs = (v: number): string => count(Math.abs(v));
const index = (v: number): string => (Number.isFinite(v) ? v.toFixed(0) : '—');
const pct1 = (v: number): string => pct(v, 1);
const pct2 = (v: number): string => pct(v, 2);
const price3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : '—');

type Good = 'up' | 'down' | 'none';

/** Relative change over the last 12 months (NaN until a year is recorded). */
function yoy(eco: Economy, k: SeriesKey): number {
  const st = eco.stats;
  if (st.length <= 12) return NaN;
  const a = st.last(k, 12);
  return a > 0 ? st.last(k) / a - 1 : NaN;
}

/** Absolute change over the last 12 months. */
function diff12(eco: Economy, k: SeriesKey): number {
  const st = eco.stats;
  return st.length > 12 ? st.last(k) - st.last(k, 12) : NaN;
}

const growth = (g: number, good: Good = 'none'): Delta | null => (Number.isFinite(g) ? { value: g, text: pct(Math.abs(g)), good } : null);
const points = (d: number, good: Good = 'none'): Delta | null =>
  Number.isFinite(d) ? { value: d, text: `${(Math.abs(d) * 100).toFixed(1)}pp`, good } : null;
const countDelta = (d: number, good: Good = 'none'): Delta | null => (Number.isFinite(d) ? { value: d, text: String(Math.abs(Math.round(d))), good } : null);

const toneAbove = (v: number, warn: number, bad: number): Tone | undefined => (!Number.isFinite(v) ? undefined : v > bad ? 'bad' : v > warn ? 'warn' : undefined);

// ---------------------------------------------------------------------------------------------
// A window of the monthly statistics (the selected range)

interface Slice {
  eco: Economy;
  /** months in view */
  n: number;
  /** months recorded so far */
  total: number;
  labels: string[];
  get(k: SeriesKey): number[];
  /** memo dependencies: rebuild charts when the game, the month or the range changes */
  deps: readonly unknown[];
}

function makeSlice(eco: Economy): Slice {
  const st = eco.stats;
  const total = st.length;
  const months = RANGES.find((r) => r.id === rangeId)?.months ?? 0;
  const n = months > 0 ? Math.min(total, months) : total;
  const start = total - n;
  const cache = new Map<SeriesKey, number[]>();
  let labels: string[] | null = null;
  return {
    eco,
    n,
    total,
    get labels() {
      labels ??= st.days.slice(start).map((d) => fmtDate(d, false));
      return labels;
    },
    get(k) {
      let a = cache.get(k);
      if (!a) {
        a = st.s[k].slice(start);
        cache.set(k, a);
      }
      return a;
    },
    deps: [eco, total, total ? st.days[total - 1] : -1, rangeId],
  };
}

interface Env {
  ctx: UIContext;
  eco: Economy;
  s: Slice;
  w: WindowCtx;
  tab: TabId;
}

// ---------------------------------------------------------------------------------------------
// Building blocks

/** Section title with a small (i) that explains the chart on hover / long-press. */
function titled(title: string, tip?: string): SectionTitle {
  return tip ? { title, aside: h('span', { class: 'mi-stats-info', tip, tabindex: '0', role: 'note', 'aria-label': tip }, glyph('info')) } : title;
}

/** A chart that is rebuilt only when a new month arrives (or the range / `deps` change). */
function chart(env: Env, id: string, title: SectionTitle, build: () => Omit<LineChartOpts, 'labels'>, opts: { deps?: unknown[]; caption?: Child } = {}): HTMLElement {
  const node = env.w.memo(`${env.tab}:${id}`, [...env.s.deps, ...(opts.deps ?? [])], () => {
    const o = build();
    // The axis rounding drops an exact-zero minimum a whole step below zero (and bars always
    // include zero), so data that never goes negative is pinned to a zero floor.
    if (o.yMin === undefined) {
      let min = Infinity;
      for (const s of o.series) for (const v of s.values) if (Number.isFinite(v) && v < min) min = v;
      const bars = o.series.some((s) => s.type === 'bar');
      if (min >= 0 && Number.isFinite(min) && (min === 0 || bars || o.zeroLine)) o.yMin = 0;
    }
    return lineChart({ labels: env.s.labels, height: 116, ...o });
  });
  return section(title, node, opts.caption ? note(opts.caption) : null);
}

interface Spark {
  key: SeriesKey;
  label: string;
  color: string;
  fmt: (v: number) => string;
  hint?: string;
}

/** Secondary indicators: label ..... [sparkline] latest value. */
function sparks(env: Env, title: SectionTitle, rows: Spark[]): HTMLElement {
  const node = env.w.memo(`${env.tab}:sparks`, env.s.deps, () =>
    kv(
      rows.map((r): KvRow => {
        const vals = env.s.get(r.key);
        return [
          r.label,
          h(
            'span',
            { class: 'mi-stats-spark' },
            h('span', { class: 'mi-stats-sparkbox' }, sparkline(vals, r.color, 76, 16, { area: false })),
            h('span', { class: 'mi-stats-sparkval' }, r.fmt(vals[vals.length - 1])),
          ),
          { hint: r.hint },
        ];
      }),
    ),
  );
  return section(title, node);
}

interface Col {
  key: SeriesKey;
  label: string;
  fmt: (v: number) => string;
  tip?: string;
}

/** The numbers behind the charts, newest month first. */
function dataTable(env: Env, cols: Col[]): HTMLElement {
  return env.w.memo(`${env.tab}:table`, env.s.deps, () => {
    const { s } = env;
    const series = cols.map((c) => s.get(c.key));
    const rows: Record<string, string | number>[] = [];
    for (let i = s.n - 1; i >= 0 && rows.length < TABLE_ROWS; i--) {
      const r: Record<string, string | number> = { month: s.labels[i] };
      cols.forEach((c, j) => (r[c.key] = series[j][i]));
      rows.push(r);
    }
    const columns: TableColumn[] = [
      { key: 'month', label: 'Month', align: 'left' },
      ...cols.map((c): TableColumn => ({ key: c.key, label: c.label, align: 'right', tip: c.tip, format: (v: number) => c.fmt(v) })),
    ];
    return table({ key: `stats-${env.tab}`, rows, columns, maxRows: 15, empty: 'No months recorded yet' });
  });
}

function tiles(cols: number, ...els: (HTMLElement | null | false)[]): HTMLElement {
  return h('div', { class: 'mi-sunken mi-stats-tiles', style: { '--cols': cols, '--cols-sm': cols > 4 ? 3 : 2 } }, els);
}

/** Append a small grey caption under a stat tile. */
function withSub(el: HTMLElement, text: string): HTMLElement {
  el.append(h('span', { class: 'mi-stats-sub' }, text));
  return el;
}

function failMarkers(s: Slice): ChartMarker[] {
  const f = s.get('bankFailures');
  const out: ChartMarker[] = [];
  f.forEach((v, i) => {
    if (v > 0) out.push({ index: i, label: v > 1 ? `${v} BANKS FAIL` : 'BANK FAILS', color: C.destroyed });
  });
  return out.slice(-5);
}

function emptyNote(s: Slice): HTMLElement {
  return h(
    'div',
    { class: 'mi-stats-empty' },
    glyph('info', 2),
    h('span', null, s.total === 0 ? 'Statistics appear after the first month.' : 'One month on the books — the charts appear after the next one.'),
  );
}

function toolbar(env: Env): HTMLElement {
  const { s, w } = env;
  const span = s.total === 0 ? 'Waiting for month one' : s.n > 1 ? `${s.labels[0]} – ${s.labels[s.n - 1]}` : s.labels[0];
  return h(
    'div',
    { class: 'mi-stats-bar' },
    choice({
      small: true,
      value: view,
      options: [
        { id: 'charts', label: 'Charts', title: 'Monthly charts' },
        { id: 'table', label: 'Table', title: 'The same figures, month by month' },
      ],
      onChange: (id) => {
        view = id === 'table' ? 'table' : 'charts';
        w.win.rerender();
      },
    }),
    h('span', { class: 'mi-stats-span' }, span),
    choice({
      small: true,
      value: rangeId,
      options: RANGES.map((r) => ({ id: r.id, label: r.label, title: r.title })),
      onChange: (id) => {
        rangeId = id;
        w.win.rerender();
      },
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Live helpers

function loanTotals(eco: Economy): { credit: number; securitised: number } {
  let credit = 0;
  let securitised = 0;
  for (const l of eco.loans.values()) {
    if (!l.active) continue;
    credit += l.balance;
    if (l.holder.kind !== 'bank') securitised += l.balance;
  }
  return { credit, securitised };
}

/** Where this month's money came from and where it went (deposits created vs destroyed). */
function moneyLedger(eco: Economy): HTMLElement {
  const f = eco.flowsMonth;
  const created = f.lending + f.bankSpending + f.publicOut;
  const destroyed = f.repayment + f.interest + f.publicIn + f.assetSales + f.writeDowns;
  const net = created - destroyed;
  const plus = (v: number) => (v >= 0.5 ? `+${fmtMoney(v)}` : '$0');
  const minus = (v: number) => (v >= 0.5 ? `−${fmtMoney(v)}` : '$0');
  return section(
    { title: 'This month so far', aside: h('span', { class: 'mi-stats-aside' }, `Day ${eco.dom + 1} of 30`) },
    kv([
      ['New loans', plus(f.lending), { tone: 'good', hint: 'A bank lends by typing a new deposit into the borrower’s account: brand-new money.' }],
      ['Bank spending', plus(f.bankSpending), { hint: 'Banks pay staff, dividends and deposit interest with newly created deposits too.' }],
      ['Public spending', plus(f.publicOut), { hint: 'City Hall pays wages, benefits and pensions from its account at the Reserve Bank, adding deposits.' }],
      ['Loan repayments', minus(f.repayment), { tone: 'bad', hint: 'Repaying a loan cancels the deposit against the debt: the money disappears.' }],
      ['Interest & fees to banks', minus(f.interest), { hint: 'Interest paid to a bank leaves the money supply and becomes bank income.' }],
      ['Taxes', minus(f.publicIn), { hint: 'Taxes move deposits into City Hall’s account at the Reserve Bank, out of circulation.' }],
      f.assetSales > 0 && ['Assets bought from banks', minus(f.assetSales), { hint: 'When investors buy bonds, mortgage bonds or foreclosed homes from a bank, their deposits vanish.' }],
      f.writeDowns > 0 && ['Lost in bank failures', minus(f.writeDowns), { tone: 'bad', hint: 'Uninsured deposits wiped out when a bank failed.' }],
      ['Change in the money supply', net >= 0 ? plus(net) : minus(-net), { strong: true, tone: net >= 0 ? 'good' : 'bad' }],
    ]),
  );
}

// ---------------------------------------------------------------------------------------------
// Tabs

interface TabSpec {
  tiles(env: Env): HTMLElement;
  /** Chart view (only called once at least two months are recorded). */
  charts(env: Env): Child[];
  /** Live blocks shown below the table view and while there is no history yet. */
  live?(env: Env): Child[];
  /** Table view columns. */
  cols: Col[];
}

const SPECS: Record<TabId, TabSpec> = {
  money: {
    tiles({ eco }) {
      const { credit, securitised } = loanTotals(eco);
      const st = eco.stats;
      const year = st.length > 12;
      return tiles(
        4,
        stat('Broad money', money(eco.broadMoney()), year ? growth(st.last('moneyGrowth')) : null, {
          tip: 'Broad money\nEvery bank deposit in town: the money people and firms spend. ▲▼ = change over 12 months.',
        }),
        stat('Bank credit', money(credit), year ? growth(st.last('creditGrowth')) : null, {
          tip: 'Bank credit\nAll loans still being repaid, including those sold on to investors. ▲▼ = change over 12 months.',
        }),
        stat('Base money', money(eco.baseMoney()), null, {
          tip: 'Base money\nReserves: the Reserve Bank’s own money. Banks settle payments with it; it never reaches a shop till.',
        }),
        withSub(
          stat('Securitised', money(securitised), null, {
            tip: 'Securitised\nLoans packaged into mortgage bonds or sold to investors. The money they created is still out there.',
          }),
          credit > 0 ? `${pct(securitised / credit, 0)} of all loans` : '',
        ),
      );
    },
    charts(env) {
      const { s } = env;
      return [
        chart(
          env,
          'stock',
          titled('Money & credit', 'Deposits (money) and loans (credit) rise and fall together: almost all money starts life as a bank loan.'),
          () => ({
            height: 132,
            series: [
              { label: 'Money (deposits)', color: C.money, values: s.get('money'), area: true, format: money },
              { label: 'Credit (loans)', color: C.credit, values: s.get('credit'), format: money },
              { label: 'Securitised', color: C.teal, values: s.get('securitised'), dashed: true, format: money },
              { label: 'Base money', color: C.purple, values: s.get('base'), dashed: true, format: money },
            ],
            markers: failMarkers(s),
          }),
        ),
        chart(
          env,
          'flow',
          titled('Money created & destroyed', 'Above zero: new deposits created by lending each month. Below zero: deposits destroyed by repayments. The line is the difference.'),
          () => {
            const lend = s.get('lending');
            const repay = s.get('repayment');
            return {
              height: 116,
              zeroLine: true,
              series: [
                { label: 'Created by loans', color: C.money, values: lend, area: true, format: money },
                { label: 'Destroyed by repayments', color: C.destroyed, values: repay.map((v) => -v), area: true, format: moneyAbs },
                { label: 'Net', color: C.cream, values: lend.map((v, i) => v - repay[i]), format: signedMoney },
              ],
            };
          },
          { caption: 'Every loan creates new deposits; every repayment destroys them.' },
        ),
        moneyLedger(env.eco),
        chart(env, 'owers', titled('Who owes the banks', 'Loans outstanding by type, including loans sold to investors.'), () => ({
          height: 104,
          series: [
            { label: 'Mortgages', color: C.pink, values: s.get('mortgages'), format: money },
            { label: 'Business', color: C.blue, values: s.get('businessLoans'), format: money },
            { label: 'Consumer', color: C.gold, values: s.get('consumerLoans'), format: money },
            { label: 'Development', color: C.purple, values: s.get('devLoans'), format: money },
          ],
        })),
      ];
    },
    live: ({ eco }) => [moneyLedger(eco)],
    cols: [
      { key: 'money', label: 'Money', fmt: money },
      { key: 'credit', label: 'Credit', fmt: money },
      { key: 'base', label: 'Base', fmt: money },
      { key: 'securitised', label: 'Securit.', fmt: money, tip: 'Securitised or sold loans' },
      { key: 'lending', label: 'Created', fmt: money, tip: 'Money created by new loans' },
      { key: 'repayment', label: 'Destroyed', fmt: money, tip: 'Money destroyed by repayments' },
      { key: 'moneyGrowth', label: 'M 12m', fmt: pct1, tip: 'Money growth over 12 months' },
    ],
  },

  economy: {
    tiles({ eco }) {
      const st = eco.stats;
      const infl = st.length ? st.last('inflation') : NaN;
      const u = eco.market.unemployment;
      return tiles(
        4,
        stat('Inflation', pct1(infl), null, {
          tone: infl < 0 ? 'warn' : toneAbove(infl, 0.035, 0.06),
          tip: `Inflation\nConsumer prices compared with a year ago. The Reserve Bank aims for ${pct(CFG.inflationTarget, 0)}.`,
        }),
        stat('Jobless', pct1(u), points(u - (st.length > 12 ? st.last('unemployment', 12) : NaN), 'down'), {
          tone: toneAbove(u, 0.07, 0.1),
          tip: 'Unemployment\nShare of workers without a job. ▲▼ = change over 12 months.',
        }),
        stat('GDP / month', money(st.length ? st.last('gdp') : NaN), growth(yoy(eco, 'realGdp'), 'up'), {
          tip: 'GDP\nEverything bought in town last month. ▲▼ = real growth (after inflation) over 12 months.',
        }),
        stat('Avg wage', money(eco.market.wageIndex), growth(yoy(eco, 'wage'), 'up'), { tip: 'Average monthly wage. ▲▼ = change over 12 months.' }),
      );
    },
    charts(env) {
      const { s } = env;
      return [
        chart(
          env,
          'prices-jobs',
          titled('Inflation & unemployment', `Inflation is the 12-month rise in consumer prices; the dashed line is the ${pct(CFG.inflationTarget, 0)} target.`),
          () => ({
            height: 124,
            percent: true,
            zeroLine: true,
            series: [
              { label: 'Inflation', color: C.coral, values: s.get('inflation') },
              { label: 'Unemployment', color: C.blue, values: s.get('unemployment') },
            ],
            refLines: [{ at: CFG.inflationTarget, label: `TARGET ${pct(CFG.inflationTarget, 0)}`, color: C.gold }],
          }),
        ),
        chart(
          env,
          'gdp',
          titled('Output (GDP)', 'Everything bought in town each month: shopping, business investment, public works and home building. "Real" strips out inflation (Year 1 prices).'),
          () => ({
            height: 108,
            series: [
              { label: 'GDP', color: C.gold, values: s.get('gdp'), format: money },
              { label: 'Real GDP (Y1 prices)', color: C.teal, values: s.get('realGdp'), dashed: true, format: money },
            ],
          }),
        ),
        chart(env, 'spend', titled('Spending', 'Household shopping and business investment (new equipment and buildings), per month.'), () => ({
          height: 100,
          series: [
            { label: 'Household shopping', color: C.spend, values: s.get('consumption'), format: money },
            { label: 'Business investment', color: C.invest, values: s.get('investment'), format: money },
          ],
        })),
        sparks(env, 'More indicators', [
          { key: 'utilization', label: 'Capacity in use', color: C.gold, fmt: pct1, hint: 'How busy shops and factories are. Near 100% prices tend to rise.' },
          { key: 'confidence', label: 'Consumer confidence', color: C.lime, fmt: (v) => count(v * 100), hint: 'How upbeat households feel (0–100). Gloomy households save more and spend less.' },
          { key: 'unmet', label: 'Unmet demand', color: C.coral, fmt: money, hint: 'Shopping that could not happen: empty shelves or fully booked firms.' },
          { key: 'cpi', label: 'Price level', color: C.cream, fmt: index, hint: 'Consumer price index (Year 1 = 100).' },
          { key: 'wage', label: 'Average wage', color: C.wage, fmt: money },
        ]),
      ];
    },
    cols: [
      { key: 'inflation', label: 'Inflation', fmt: pct1 },
      { key: 'unemployment', label: 'Jobless', fmt: pct1 },
      { key: 'gdp', label: 'GDP', fmt: money },
      { key: 'realGdp', label: 'Real GDP', fmt: money },
      { key: 'consumption', label: 'Shopping', fmt: money },
      { key: 'investment', label: 'Invest.', fmt: money },
      { key: 'wage', label: 'Wage', fmt: money },
    ],
  },

  housing: {
    tiles({ eco }) {
      const st = eco.stats;
      let listings = 0;
      for (const u of eco.units) if (u.listing) listings++;
      return tiles(
        4,
        stat('House prices', index(eco.market.hpi * 100), st.length > 12 ? growth(st.last('hpiGrowth')) : null, {
          tip: 'House price index\nYear 1 = 100. ▲▼ = change over 12 months.',
        }),
        stat('Rents', index(eco.market.rentIndex * 100), growth(yoy(eco, 'rentIndex')), { tip: 'Rent index\nYear 1 = 100. ▲▼ = change over 12 months.' }),
        stat('For sale', count(listings), null, { tip: 'Homes on the market right now.' }),
        stat('Sold last month', count(st.length ? st.last('houseSales') : NaN), null, { tip: 'Homes that changed hands last month.' }),
      );
    },
    charts(env) {
      const { s } = env;
      return [
        chart(
          env,
          'prices',
          titled('House prices, rents & consumer prices', 'All three as indexes (Year 1 = 100). When homes outrun everything else, buyers need ever-bigger loans.'),
          () => ({
            height: 124,
            series: [
              { label: 'House prices', color: C.pink, values: s.get('hpi'), area: true, format: index },
              { label: 'Rents', color: C.gold, values: s.get('rentIndex'), format: index },
              { label: 'Consumer prices', color: C.steel, values: s.get('cpi'), dashed: true, format: index },
            ],
          }),
        ),
        chart(
          env,
          'growth',
          titled('House prices vs credit', '12-month growth of house prices and of bank credit.'),
          () => ({
            height: 112,
            percent: true,
            zeroLine: true,
            series: [
              { label: 'House prices', color: C.pink, values: s.get('hpiGrowth') },
              { label: 'Bank credit', color: C.money, values: s.get('creditGrowth'), dashed: true },
            ],
          }),
          { caption: 'Credit and house prices feed each other: more lending pushes prices up, and pricier homes need (and secure) bigger loans.' },
        ),
        chart(env, 'market', titled('Homes sold & for sale', 'Sales per month (bars) and homes listed for sale at month end (line).'), () => ({
          height: 100,
          series: [
            { label: 'Sold', color: C.pink, values: s.get('houseSales'), type: 'bar', format: count },
            { label: 'For sale', color: C.cream, values: s.get('listings'), format: count },
          ],
        })),
        chart(env, 'building', titled('Building sites', 'Construction projects under way, and those halted because the money ran out.'), () => ({
          height: 96,
          series: [
            { label: 'Active', color: C.gold, values: s.get('construction'), type: 'bar', format: count },
            { label: 'Stalled', color: C.destroyed, values: s.get('stalled'), type: 'bar', format: count },
          ],
        })),
        sparks(env, 'Home loans', [
          { key: 'mortgages', label: 'Mortgage debt', color: C.pink, fmt: money },
          { key: 'devLoans', label: 'Development loans', color: C.purple, fmt: money, hint: 'Loans to builders putting up new homes.' },
          { key: 'mortgageRate', label: 'Mortgage rate', color: C.gold, fmt: pct2 },
          { key: 'vacancy', label: 'Empty homes', color: C.blue, fmt: pct1 },
        ]),
      ];
    },
    cols: [
      { key: 'hpi', label: 'Prices', fmt: index, tip: 'House price index (Y1 = 100)' },
      { key: 'hpiGrowth', label: '12m', fmt: pct1, tip: 'House price growth over 12 months' },
      { key: 'rentIndex', label: 'Rents', fmt: index },
      { key: 'houseSales', label: 'Sold', fmt: count },
      { key: 'listings', label: 'For sale', fmt: count },
      { key: 'construction', label: 'Sites', fmt: count },
      { key: 'mortgages', label: 'Mortgages', fmt: money },
    ],
  },

  banks: {
    tiles({ eco }) {
      const st = eco.stats;
      const alive = eco.aliveBanks();
      const failed = eco.banks.length - alive.length;
      const req = eco.policy.capitalRequirement;
      const cr = st.length ? st.last('capitalRatio') : NaN;
      const npl = st.length ? st.last('npl') : NaN;
      const fear = alive.length ? alive.reduce((a, b) => a + b.fear, 0) / alive.length : NaN;
      return tiles(
        4,
        withSub(
          stat('Banks open', count(alive.length), null, { tone: alive.length <= 1 ? 'bad' : undefined, tip: 'Banks still trading.' }),
          failed > 0 ? `${failed} failed so far` : 'none failed yet',
        ),
        stat('Capital ratio', pct1(cr), null, {
          tone: !Number.isFinite(cr) ? undefined : cr < req ? 'bad' : cr < req + 0.02 ? 'warn' : undefined,
          tip: `Capital ratio\nBank equity ÷ risk-weighted loans, all banks together. Your rule: at least ${pct(req, 0)}.`,
        }),
        stat('Bad loans', pct1(npl), null, { tone: toneAbove(npl, 0.03, 0.06), tip: 'Non-performing loans\nShare of loans 90+ days behind on payments.' }),
        stat('Bank fear', Number.isFinite(fear) ? String(Math.round(fear * 100)) : '—', null, {
          tone: toneAbove(fear, 0.5, 0.75),
          tip: 'Bank fear (0–100)\nHow nervous bankers are. Frightened banks lend less and hoard reserves.',
        }),
      );
    },
    charts(env) {
      const { s, eco } = env;
      const req = eco.policy.capitalRequirement;
      return [
        chart(
          env,
          'health',
          titled('Capital & bad loans', 'Equity cushion vs risk-weighted loans, and the share of loans gone bad. The dashed line is your minimum capital rule.'),
          () => ({
            height: 124,
            percent: true,
            series: [
              { label: 'Capital ratio', color: C.gold, values: s.get('capitalRatio') },
              { label: 'Bad loans', color: C.destroyed, values: s.get('npl') },
            ],
            refLines: [{ at: req, label: `MIN ${pct(req, 0)}`, color: C.cream }],
            markers: failMarkers(s),
          }),
          { deps: [req] },
        ),
        chart(env, 'mood', titled('Fear & confidence', 'Both on a 0–100 scale. Bank fear rises after losses and runs; confidence is how upbeat households feel.'), () => ({
          height: 104,
          yMin: 0,
          yMax: 100,
          series: [
            { label: 'Bank fear', color: C.destroyed, values: s.get('bankFear').map((v) => v * 100), format: count },
            { label: 'Consumer confidence', color: C.money, values: s.get('confidence').map((v) => v * 100), format: count },
          ],
        })),
        chart(env, 'trouble', titled('Defaults & failures', 'Loans that defaulted each month (bars), banks still open (line) and bank failures (markers).'), () => ({
          height: 104,
          series: [
            { label: 'Loan defaults', color: C.gold, values: s.get('defaults'), type: 'bar', format: count },
            { label: 'Banks open', color: C.cream, values: s.get('banksAlive'), format: count },
          ],
          markers: failMarkers(s),
        })),
        sparks(env, 'Balance sheets & markets', [
          { key: 'bankAssets', label: 'Bank assets', color: C.blue, fmt: money },
          { key: 'bankEquity', label: 'Bank equity', color: C.gold, fmt: money, hint: 'The owners’ stake: what absorbs losses before depositors do.' },
          { key: 'defaultValue', label: 'Loans defaulted', color: C.coral, fmt: money, hint: 'Value of loans that defaulted last month.' },
          { key: 'writeDowns', label: 'Deposits lost', color: C.destroyed, fmt: money, hint: 'Uninsured deposits wiped out in bank failures last month.' },
          { key: 'mbsPrice', label: 'Mortgage-bond price', color: C.teal, fmt: price3, hint: 'Price per $1 of mortgage-backed securities. Below 1.000 means investors expect losses.' },
          { key: 'fundNav', label: `${env.eco.fund.name} unit`, color: C.purple, fmt: price3, hint: 'Value of one unit of the investment fund (started at 1.000).' },
        ]),
      ];
    },
    cols: [
      { key: 'capitalRatio', label: 'Capital', fmt: pct1 },
      { key: 'npl', label: 'Bad loans', fmt: pct1 },
      { key: 'bankFear', label: 'Fear', fmt: (v) => count(v * 100) },
      { key: 'banksAlive', label: 'Banks', fmt: count },
      { key: 'bankFailures', label: 'Failed', fmt: count },
      { key: 'defaults', label: 'Defaults', fmt: count },
      { key: 'mbsPrice', label: 'MBS', fmt: price3 },
    ],
  },

  rates: {
    tiles({ eco }) {
      const st = eco.stats;
      const L = (k: SeriesKey) => (st.length ? st.last(k) : NaN);
      const p = eco.policy;
      return tiles(
        5,
        stat('Policy rate', h('span', { class: 'mi-stats-inline' }, pct2(p.policyRate), p.autopilot ? badge('Auto', 'info', { tip: 'The rate is on autopilot.' }) : null), null, {
          tip: 'Policy rate\nWhat banks pay to borrow reserves overnight. You set it at the Reserve Bank.',
        }),
        stat('Mortgages', pct2(L('mortgageRate')), null, { tip: 'Average mortgage rate last month.' }),
        stat('Business', pct2(L('businessRate')), null, { tip: 'Average business-loan rate last month.' }),
        stat('Deposits', pct2(L('depositRate')), null, { tip: 'Average interest banks paid on deposits last month.' }),
        stat('Bond yield', pct2(eco.market.bondYield), null, { tip: 'Yield on long government bonds.' }),
      );
    },
    charts(env) {
      const { s } = env;
      return [
        chart(
          env,
          'rates',
          titled('Interest rates', 'Banks price loans at the policy rate plus a margin for risk (and a little extra when they are scared).'),
          () => ({
            height: 132,
            percent: true,
            zeroLine: true,
            series: [
              { label: 'Policy rate', color: C.gold, values: s.get('policyRate'), format: pct2 },
              { label: 'Mortgages', color: C.pink, values: s.get('mortgageRate'), format: pct2 },
              { label: 'Business loans', color: C.blue, values: s.get('businessRate'), format: pct2 },
              { label: 'Deposits', color: C.lime, values: s.get('depositRate'), format: pct2 },
              { label: 'Gov. bonds', color: C.purple, values: s.get('bondYield'), dashed: true, format: pct2 },
            ],
          }),
        ),
        chart(env, 'debt', titled('Government debt', 'Bills and bonds City Hall owes to banks, the fund and the Reserve Bank.'), () => ({
          height: 96,
          series: [{ label: 'Government debt', color: C.public, values: s.get('govDebt'), area: true, format: money }],
        })),
        chart(
          env,
          'deficit',
          titled('Budget deficit', 'Public spending plus interest, minus taxes, each month. Bars below zero are surpluses.'),
          () => ({
            height: 96,
            zeroLine: true,
            series: [{ label: 'Deficit', color: C.public, values: s.get('deficit'), type: 'bar', format: money }],
          }),
          { caption: 'Deficits add deposits to the economy; surpluses drain them.' },
        ),
      ];
    },
    cols: [
      { key: 'policyRate', label: 'Policy', fmt: pct2 },
      { key: 'mortgageRate', label: 'Mortgage', fmt: pct2 },
      { key: 'businessRate', label: 'Business', fmt: pct2 },
      { key: 'depositRate', label: 'Deposit', fmt: pct2 },
      { key: 'bondYield', label: 'Bonds', fmt: pct2 },
      { key: 'deficit', label: 'Deficit', fmt: money },
      { key: 'govDebt', label: 'Gov. debt', fmt: money },
    ],
  },

  business: {
    tiles({ eco }) {
      const st = eco.stats;
      const open = eco.firms.reduce((n, f) => n + (f.status === 'open' ? 1 : 0), 0);
      const pop = eco.population();
      return tiles(
        4,
        stat('Businesses', count(open), countDelta(diff12(eco, 'firms'), 'up'), { tip: 'Businesses open now. ▲▼ = change over 12 months.' }),
        stat('Opened', count(st.length ? st.last('openings') : NaN), null, { tone: 'good', tip: 'New businesses last month.' }),
        stat('Closed', count(st.length ? st.last('closures') : NaN), null, {
          tone: st.length && st.last('closures') > 0 ? 'bad' : undefined,
          tip: 'Businesses that shut down last month.',
        }),
        stat('Residents', count(pop), countDelta(diff12(eco, 'population'), 'up'), { tip: 'Households living in town. ▲▼ = change over 12 months.' }),
      );
    },
    charts(env) {
      const { s } = env;
      return [
        chart(env, 'firms', titled('Businesses open', 'Shops, services, factories and builders trading at month end.'), () => ({
          height: 104,
          series: [{ label: 'Businesses', color: C.spend, values: s.get('firms'), area: true, format: count }],
        })),
        chart(
          env,
          'churn',
          titled('Openings & closures', 'New businesses (up) and closures (down) each month.'),
          () => ({
            height: 100,
            zeroLine: true,
            series: [
              { label: 'Openings', color: C.money, values: s.get('openings'), type: 'bar', format: count },
              { label: 'Closures', color: C.destroyed, values: s.get('closures').map((v) => -v), type: 'bar', format: countAbs },
            ],
          }),
          { caption: 'New firms usually start with a bank loan — when banks turn cautious, openings dry up.' },
        ),
        chart(env, 'people', titled('Residents', 'Households living in town. People move in when there are jobs and homes, and leave when times are hard.'), () => ({
          height: 96,
          series: [{ label: 'Households', color: C.wage, values: s.get('population'), area: true, format: count }],
        })),
        sparks(env, 'Work & demand', [
          { key: 'unemployment', label: 'Jobless', color: C.blue, fmt: pct1 },
          { key: 'utilization', label: 'Capacity in use', color: C.gold, fmt: pct1 },
          { key: 'unmet', label: 'Unmet demand', color: C.coral, fmt: money, hint: 'Shopping that could not happen: empty shelves or fully booked firms.' },
          { key: 'businessLoans', label: 'Business loans', color: C.blue, fmt: money },
        ]),
      ];
    },
    cols: [
      { key: 'firms', label: 'Open', fmt: count },
      { key: 'openings', label: 'Opened', fmt: count },
      { key: 'closures', label: 'Closed', fmt: count },
      { key: 'population', label: 'Residents', fmt: count },
      { key: 'unemployment', label: 'Jobless', fmt: pct1 },
      { key: 'businessLoans', label: 'Bus. loans', fmt: money },
    ],
  },
};

// ---------------------------------------------------------------------------------------------

function renderStats(body: HTMLElement, w: WindowCtx, ctx: UIContext): void {
  const tab: TabId = isTab(w.tab) ? w.tab : 'money';
  lastTab = tab;
  const eco = ctx.game.eco;
  const s = makeSlice(eco);
  const env: Env = { ctx, eco, s, w, tab };
  const spec = SPECS[tab];
  const blocks: Child[] = [toolbar(env), spec.tiles(env)];
  if (view === 'table') {
    blocks.push(s.total ? dataTable(env, spec.cols) : emptyNote(s), spec.live?.(env));
  } else if (s.total < 2) {
    blocks.push(emptyNote(s), spec.live?.(env));
  } else {
    blocks.push(spec.charts(env));
  }
  appendChildren(body, blocks);
}

// ---------------------------------------------------------------------------------------------
// Styles (injected once)

const STYLE_ID = 'mi-stats-style';

function injectStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
.mi-stats-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
}
.mi-stats-span {
  flex: 1 1 90px;
  min-width: 0;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 8px/1 var(--mi-font-pixel);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--mi-ink-3);
  -webkit-font-smoothing: none;
}
.mi-stats-tiles {
  display: grid;
  grid-template-columns: repeat(var(--cols, 4), minmax(0, 1fr));
  gap: 8px 10px;
  margin-bottom: 10px;
}
.mi-stats-tiles .mi-stat {
  min-width: 0;
}
.mi-stats-tiles .mi-stat-line {
  flex-wrap: wrap;
  row-gap: 2px;
}
.mi-stats-sub {
  overflow: hidden;
  font-size: 10px;
  line-height: 1.2;
  color: var(--mi-ink-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mi-stats-inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.mi-stats-info {
  display: inline-grid;
  place-items: center;
  width: 12px;
  height: 12px;
  color: var(--mi-ink-3);
  cursor: help;
}
.mi-stats-info:hover,
.mi-stats-info:focus-visible {
  color: var(--mi-info);
}
.mi-stats-aside {
  font: 8px/1 var(--mi-font-pixel);
  text-transform: uppercase;
  color: var(--mi-ink-3);
  -webkit-font-smoothing: none;
}
.mi-stats-win .mi-chart + .mi-note {
  margin: 5px 0 0;
}
.mi-stats-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0 0 10px;
  padding: 18px 10px;
  font-size: 12px;
  text-align: center;
  color: var(--mi-ink-2);
  background: repeating-linear-gradient(135deg, rgba(168, 148, 106, 0.1) 0 6px, transparent 6px 12px);
  border: 1px dashed var(--mi-rule-2);
}
.mi-stats-empty .mi-glyph {
  flex: none;
  color: var(--mi-info);
}
.mi-stats-spark {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.mi-stats-sparkbox {
  display: inline-flex;
  padding: 1px 2px;
  background: var(--mi-screen);
  border: 1px solid;
  border-color: var(--mi-paper-lo) var(--mi-paper-hi) var(--mi-paper-hi) var(--mi-paper-lo);
  box-shadow: inset 1px 1px 0 var(--mi-screen-lo);
}
.mi-stats-sparkval {
  min-width: 56px;
  text-align: right;
}
@media (max-width: 719px) {
  .mi-stats-tiles {
    grid-template-columns: repeat(var(--cols-sm, 2), minmax(0, 1fr));
  }
}
`;
  document.head.appendChild(el);
}
