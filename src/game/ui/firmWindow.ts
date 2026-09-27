// Business window: the firm's story in plain words, its finances, its loans and its staff.

import { badge, gauge, h, kv, lineChart, note, openWindow, section, stat, table, type Tone } from '../../ui';
import type { Firm } from '../../sim/agents';
import type { Loan } from '../../sim/loan';
import { fmtDate } from '../../sim/format';
import { agentLink, loanKindLabel, loanLink, loanStatusLabel, loanStatusTone, money, percent, storyList } from './common';
import type { UIContext } from './context';
import { traceButton } from './genesis/trace';

const SECTOR_LABEL: Record<Firm['sector'], string> = {
  retail: 'Shop',
  service: 'Services',
  factory: 'Factory',
  builder: 'Construction company',
};

const HEALTH: Record<Firm['health'], [string, Tone]> = {
  healthy: ['HEALTHY', 'good'],
  strained: ['STRAINED', 'warn'],
  distressed: ['IN TROUBLE', 'bad'],
};

function subtypeLabel(f: Firm): string {
  const s = f.subtype;
  const map: Record<string, string> = {
    lawoffice: 'law office',
    tech: 'tech company',
    agency: 'agency',
    insurance: 'insurance company',
    department: 'department store',
    supermarket: 'supermarket',
    builder: 'builder',
  };
  return map[s] ?? s;
}

/** The headline facts of the firm's life, the way a newspaper profile would put them. */
function storySummary(ctx: UIContext, f: Firm): HTMLElement {
  const eco = ctx.game.eco;
  const lines: (HTMLElement | null)[] = [];
  const all = [...eco.loans.values()].filter((l) => l.borrowerId === f.id);
  const byBank = new Map<number, number>();
  for (const l of all) byBank.set(l.originatorId, (byBank.get(l.originatorId) ?? 0) + l.principal0);
  const owner = eco.household(f.ownerId);
  lines.push(
    h('li', `Opened ${f.founded < 0 && f.openedDay <= 0 ? 'before the game began' : fmtDate(f.openedDay >= 0 ? f.openedDay : f.founded, false)}`, owner ? [' by ', agentLink(ctx, owner.id)] : null, f.ownerEquity > 0 ? ` with ${money(f.ownerEquity)} of the owner’s savings` : null),
  );
  for (const [bankId, amt] of byBank) lines.push(h('li', { class: 'is-good' }, `Borrowed ${money(amt)} from `, agentLink(ctx, bankId), ' — new money created for the business'));
  const spent = new Map<string, number>();
  for (const l of all) for (const s of l.spentOn) spent.set(s.what, (spent.get(s.what) ?? 0) + s.amount);
  for (const [what, amt] of [...spent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) lines.push(h('li', `Spent ${money(amt)} of borrowed money on ${what}`));
  if (f.hiredCum > 0) lines.push(h('li', `Hired ${f.hiredCum} worker${f.hiredCum === 1 ? '' : 's'}${f.firedCum ? `, let ${f.firedCum} go` : ''}`));
  else if (f.firedCum > 0) lines.push(h('li', { class: 'is-bad' }, `Let ${f.firedCum} worker${f.firedCum === 1 ? '' : 's'} go`));
  if (f.status !== 'closed') {
    lines.push(h('li', `Monthly revenue ${money(f.last.revenue)}`, f.last.revenue > 0 ? ` · ${f.workers.length} staff` : null));
    const debt = f.debt();
    if (debt > 0) lines.push(h('li', `Loans still owed: ${money(debt)}`));
    else if (all.length) lines.push(h('li', { class: 'is-good' }, 'Debt-free: all loans repaid'));
  } else lines.push(h('li', { class: 'is-bad' }, `Closed ${fmtDate(f.closedDay, false)}`));
  return h('ul', { class: 'gm-summary' }, lines);
}

export function openFirmWindow(ctx: UIContext, id: number, anchor?: { x: number; y: number }): void {
  const f0 = ctx.game.eco.firm(id);
  if (!f0) return;
  openWindow({
    id: `firm-${id}`,
    title: f0.name,
    icon: f0.sector === 'factory' ? '🏭' : f0.sector === 'builder' ? '🏗️' : f0.sector === 'retail' ? '🛒' : '💼',
    accent: f0.color,
    width: 400,
    anchor,
    tabs: [
      { id: 'story', label: 'Story' },
      { id: 'money', label: 'Finances' },
      { id: 'loans', label: 'Loans' },
      { id: 'staff', label: 'Staff' },
    ],
    render: (body, wctx) => {
      const eco = ctx.game.eco;
      const f = eco.firm(id);
      if (!f) return;
      const [hl, ht] = HEALTH[f.health];
      body.append(
        h(
          'div',
          { class: 'mi-row gm-badges' },
          h('span', { class: 'gm-kind' }, `${SECTOR_LABEL[f.sector]} · ${subtypeLabel(f)}`),
          f.status === 'closed' ? badge('CLOSED', 'bad') : f.status === 'planned' ? badge('BEING BUILT', 'info') : badge(hl, ht),
          f.status === 'open' && f.vacancies > 0 ? badge('HIRING', 'good') : null,
          f.project >= 0 ? badge('EXPANDING', 'info') : null,
          traceButton(ctx, { kind: 'firm', id: f.id }),
        ),
      );
      switch (wctx.tab) {
        case 'story': {
          body.append(section('The story so far', storySummary(ctx, f)), section('Diary', storyList(ctx, f.story)));
          break;
        }
        case 'money': {
          const l = f.last;
          const profit = l.revenue - l.wages - l.inputs - l.interest - l.maintenance - l.taxes;
          const util = f.capacity > 0 ? (l.units + l.unmet) / f.capacity : 0;
          body.append(
            h(
              'div',
              { class: 'mi-grid3 gm-tiles' },
              stat('Cash', money(f.acct.balance), null, { tip: `Held at ${f.acct.bank.name}` }),
              stat('Revenue / mo', money(l.revenue)),
              stat('Profit / mo', money(profit), null, { tone: profit < 0 ? 'bad' : 'good' }),
            ),
            section(
              'Last month',
              kv([
                ['Sales', money(l.revenue)],
                ['Wages', money(-l.wages), { sub: true }],
                ['Goods & materials', money(-l.inputs), { sub: true }],
                ['Loan interest', money(-l.interest), { sub: true }],
                ['Upkeep & repairs', money(-l.maintenance), { sub: true }],
                ['Investment', money(-l.investment), { sub: true }],
                ['Paid to the owner', money(-l.dividends), { sub: true }],
              ]),
            ),
            section(
              'Operations',
              gauge({
                label: 'Demand vs capacity',
                value: util,
                min: 0,
                max: 1.4,
                format: (v) => percent(v, 0),
                warnBelow: 0.6,
                dangerBelow: 0.4,
                warnAbove: 1.0,
                marks: [{ at: 1, label: 'FULL' }],
                tip: 'Above 100% the business turns customers away — it may borrow to expand. Far below, it lays people off.',
              }),
              kv([
                ['Price level', f.price.toFixed(2), { hint: 'Relative to the starting price of 1.00.' }],
                ['Staff', `${f.workers.length}${f.vacancies > 0 ? ` (+${f.vacancies} wanted)` : ''}`],
                ['Wage per worker', money(f.wage)],
                ['Capital (equipment & premises)', money(f.K * eco.market.factoryPrice)],
                ['Deposit bank', agentLink(ctx, f.acct.bank.id)],
              ]),
            ),
            f.months.length > 2
              ? wctx.memo('rev', [f.months.length, f.lastReview], () =>
                  lineChart({
                    height: 90,
                    format: money,
                    labels: f.months.map((_, i) => fmtDate(eco.day - (f.months.length - 1 - i) * 30, false)),
                    series: [
                      { label: 'Revenue', color: '#ffd23c', values: f.months.map((x) => x.revenue) },
                      { label: 'Wages', color: '#5ad2ff', values: f.months.map((x) => x.wages) },
                    ],
                  }),
                )
              : '',
          );
          break;
        }
        case 'loans': {
          const loans = [...eco.loans.values()].filter((l) => l.borrowerId === f.id);
          if (!loans.length) {
            body.append(note('This business has never borrowed — it runs on its own money.'));
            break;
          }
          body.append(
            table<Loan>({
              key: `firm-loans-${id}`,
              maxRows: 10,
              columns: [
                { key: 'what', label: 'Loan', grow: true, format: (_v, l) => loanLink(ctx, l, loanKindLabel(l)) },
                { key: 'bank', label: 'From', format: (_v, l) => eco.bank(l.originatorId)?.short ?? '?' },
                { key: 'principal0', label: 'Borrowed', align: 'right', format: (v) => money(v) },
                { key: 'balance', label: 'Owed', align: 'right', format: (v) => money(v) },
                { key: 'status', label: 'Status', format: (_v, l) => loanStatusLabel(l) },
              ],
              rows: loans.sort((a, b) => b.day - a.day),
              rowTone: (l) => loanStatusTone(l),
              onRowClick: (l) => ctx.open({ kind: 'loan', id: l.id }),
            }),
            note('Click a loan to follow its money: which bank created it, where it was spent and who holds it now.'),
          );
          break;
        }
        case 'staff': {
          const rows = f.workers.map((wid) => eco.household(wid)).filter((x) => !!x);
          body.append(
            table({
              key: `firm-staff-${id}`,
              maxRows: 12,
              empty: 'No staff.',
              columns: [
                { key: 'name', label: 'Worker', grow: true },
                { key: 'wage', label: 'Wage', align: 'right', format: (v) => money(v) },
                { key: 'employedDays', label: 'Tenure', align: 'right', format: (v) => `${Math.round(v / 30)} mo` },
              ],
              rows,
              onRowClick: (hh) => ctx.showAgent(hh.id),
            }),
          );
          break;
        }
      }
    },
  });
}
