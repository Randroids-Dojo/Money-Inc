// Bank window: health at a glance, the full balance sheet, its loan book, profit and history.

import {
  badge,
  balanceSheet,
  gauge,
  h,
  kv,
  lineChart,
  note,
  openWindow,
  section,
  stat,
  table,
  type Tone,
} from '../../ui';
import { metrics } from '../../sim/banking';
import { netIncome, type Bank, type PL } from '../../sim/bank';
import { fmtDate } from '../../sim/format';
import { agentLink, loanKindLabel, loanStatusLabel, loanStatusTone, money, percent } from './common';
import type { UIContext } from './context';
import type { Loan } from '../../sim/loan';

const STATUS: Record<Bank['status'], [string, Tone]> = {
  healthy: ['HEALTHY', 'good'],
  constrained: ['CONSTRAINED', 'warn'],
  stressed: ['STRESSED', 'bad'],
  run: ['BANK RUN', 'bad'],
  failed: ['FAILED', 'bad'],
};

const STANCE: Record<Bank['stance'], [string, Tone]> = {
  loosening: ['LENDING FREELY', 'good'],
  steady: ['LENDING NORMALLY', 'info'],
  tightening: ['TIGHTENING', 'warn'],
  frozen: ['NOT LENDING', 'bad'],
};

export function openBankWindow(ctx: UIContext, id: number, anchor?: { x: number; y: number }): void {
  const eco0 = ctx.game.eco;
  const b0 = eco0.bank(id);
  if (!b0) return;
  openWindow({
    id: `bank-${id}`,
    title: b0.name,
    icon: '🏦',
    accent: b0.color,
    width: 430,
    anchor,
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'sheet', label: 'Balance Sheet' },
      { id: 'loans', label: 'Loans' },
      { id: 'profit', label: 'Profit' },
      { id: 'history', label: 'History' },
    ],
    render: (body, wctx) => {
      const eco = ctx.game.eco;
      const b = eco.bank(id);
      if (!b) {
        body.append(note('This bank no longer exists.'));
        return;
      }
      const m = metrics(eco, b);
      const req = eco.policy.capitalRequirement;
      const target = req + b.personality.capitalBuffer;
      switch (wctx.tab) {
        case 'overview': {
          const [st, stTone] = STATUS[b.status];
          const [sn, snTone] = STANCE[b.stance];
          body.append(
            h(
              'div',
              { class: 'mi-row gm-badges' },
              badge(st, stTone, { blink: b.status === 'run' }),
              b.alive ? badge(sn, snTone) : null,
              b.cbLoanEmergency ? badge('EMERGENCY LOAN', 'bad') : null,
              b.dividendsSuspended && b.alive ? badge('NO DIVIDENDS', 'warn') : null,
            ),
          );
          if (!b.alive) {
            const acq = b.acquiredBy !== null ? eco.bank(b.acquiredBy) : undefined;
            body.append(
              note(
                h(
                  'span',
                  `Closed by the regulator on ${fmtDate(b.failedDay)} — ${b.failureKind === 'liquidity' ? 'it ran out of cash to pay depositors and creditors (illiquid)' : 'its losses wiped out its capital (insolvent)'}.`,
                  acq ? [' Its accounts and loans were taken over by ', agentLink(ctx, acq.id), '.'] : null,
                ),
                'bad',
              ),
            );
          }
          body.append(
            h('div', { class: 'gm-blurb' }, b.personality.blurb),
            h(
              'div',
              { class: 'mi-grid3 gm-tiles' },
              stat('Deposits', money(m.deposits), null, { tip: 'Money its customers hold with it — its biggest debt.' }),
              stat('Loans', money(m.loansGross), null, { tip: 'Loans it currently holds (loans it sold on are not counted).' }),
              stat('Equity', money(m.equity), null, { tone: m.equity < 0 ? 'bad' : undefined, tip: 'Assets minus liabilities: the cushion that absorbs losses.' }),
            ),
            section(
              'Health',
              gauge({
                label: 'Capital ratio',
                value: m.capitalRatio,
                min: 0,
                max: Math.max(0.25, target * 2),
                format: (v) => percent(v),
                marks: [
                  { at: req, label: `MIN ${percent(req, 0)}`, color: '#c0392b' },
                  { at: target, label: 'OWN TARGET', color: '#d4af37' },
                ],
                dangerBelow: req,
                warnBelow: target,
                tip: 'Equity divided by risk-weighted assets. Below the minimum the bank must stop lending; near zero it is closed.',
              }),
              gauge({
                label: 'Liquidity (cash & bonds / deposits)',
                value: m.liquidityRatio,
                min: 0,
                max: Math.max(0.5, eco.policy.liquidityRequirement * 3),
                format: (v) => percent(v),
                marks: [{ at: eco.policy.liquidityRequirement, label: 'RULE', color: '#c0392b' }],
                dangerBelow: eco.policy.liquidityRequirement * 0.5,
                warnBelow: eco.policy.liquidityRequirement,
                tip: 'Cash and government securities it could use to pay depositors who withdraw.',
              }),
              gauge({
                label: 'Bad loans (non-performing)',
                value: m.nplRatio,
                min: 0,
                max: 0.2,
                format: (v) => percent(v),
                warnAbove: 0.03,
                dangerAbove: 0.08,
              }),
              gauge({
                label: 'Fear',
                value: b.fear,
                min: 0,
                max: 1,
                format: (v) => (v < 0.25 ? 'Confident' : v < 0.45 ? 'Calm' : v < 0.65 ? 'Nervous' : v < 0.85 ? 'Scared' : 'Panicking'),
                warnAbove: 0.45,
                dangerAbove: 0.7,
                tip: 'Bankers get bolder after good years and scared after losses. Fear tightens lending standards.',
              }),
            ),
            section(
              'Lending power',
              kv([
                [
                  'More it could lend',
                  money(Math.max(0, m.headroomRWA / 0.75)),
                  { hint: 'Extra loans (at a typical risk weight) before capital falls to its own target. Reserves do not limit lending — capital does.' },
                ],
                ['Budget left this month', money(b.budget), { hint: 'How much new lending its managers are willing to do this month.' }],
                ['New loans this month', money(b.originatedThisMonth)],
                ['Applications refused', String(b.deniedThisMonth)],
                ['Money created by its lending (all time)', money(b.createdCum), { tone: 'good', hint: 'Each loan it makes creates brand-new deposit money.' }],
                ['Money destroyed by repayments', money(b.destroyedCum), { hint: 'Repaying a loan deletes the deposit money used to pay it.' }],
              ]),
            ),
            section(
              'Recent decisions',
              b.actions.length
                ? h(
                    'ol',
                    { class: 'gm-story mi-scroll', dataset: { scrollKey: 'actions' } },
                    b.actions
                      .slice()
                      .reverse()
                      .slice(0, 12)
                      .map((a) =>
                        h('li', { class: ['gm-story-item', `is-${a.tone}`] }, h('span', { class: 'gm-story-date' }, fmtDate(a.day, false)), h('span', { class: 'gm-story-text' }, a.text)),
                      ),
                  )
                : note('No decisions yet.'),
            ),
          );
          break;
        }
        case 'sheet': {
          const retained = b.retained + netIncome(b.pl);
          body.append(
            balanceSheet({
              format: money,
              assets: [
                { label: 'Reserves at Reserve Bank', value: Math.max(0, m.reserves), hint: 'Central-bank money used to settle payments with other banks.' },
                { label: 'Business loans', value: m.business },
                { label: 'Mortgages', value: m.mortgages },
                { label: 'Consumer loans', value: m.consumer },
                { label: 'Development loans', value: m.development },
                { label: 'Government bills', value: m.bills },
                { label: 'Government bonds', value: m.bonds },
                { label: 'Mortgage-backed securities', value: m.mbs },
                { label: 'Loans to other banks', value: m.interbank },
                { label: 'Repossessed property', value: m.reo },
              ].filter((x) => x.value > 0.5),
              liabilities: [
                { label: 'Customer deposits', value: m.deposits, hint: 'Money in customers’ accounts. Most of it was created by banks’ own lending.' },
                { label: 'Wholesale funding', value: m.wholesale, hint: 'Short-term borrowing from other banks and Meridian Capital. It can vanish overnight.' },
                { label: 'Reserve Bank loans', value: m.cbLoan },
                { label: 'Bonds issued', value: m.bondsIssued },
              ].filter((x) => x.value > 0.5),
              equity: [
                { label: 'Paid-in capital', value: b.paidIn },
                { label: retained >= 0 ? 'Retained earnings' : 'Accumulated losses', value: retained },
                { label: 'Market value changes', value: m.unrealized },
              ].filter((x) => Math.abs(x.value) > 0.5),
            }),
            kv([
              ['Loan-loss provisions (deducted)', money(-m.provisions), { hint: 'Money set aside for loans it expects to go bad.' }],
              ['Risk-weighted assets', money(m.rwa), { hint: 'Assets weighted by riskiness: mortgages count half, business loans in full.' }],
              ['Capital ratio', percent(m.capitalRatio), { tone: m.capitalRatio < req ? 'bad' : m.capitalRatio < target ? 'warn' : 'good', strong: true }],
              ['Liquid assets', money(m.liquid)],
              ['Deposit rate paid', percent(b.depositRate, 2)],
            ]),
          );
          break;
        }
        case 'loans': {
          const loans = b.loans.filter((l) => l.active);
          const serviced = [...eco.loans.values()].filter((l) => l.active && l.servicerId === b.id && l.holder.kind !== 'bank');
          body.append(
            kv([
              ['Mortgage rate', percent(eco.policy.policyRate + b.spreads.mortgage, 2)],
              ['Business rate', percent(eco.policy.policyRate + b.spreads.business, 2)],
              ['Max loan-to-value', percent(b.maxLTV, 0), { hint: 'Largest mortgage as a share of the home’s value.' }],
              ['Max debt-to-income', percent(b.maxDTI, 0)],
            ]),
            section(
              `Loans on its books (${loans.length})`,
              table<Loan>({
                key: `bank-loans-${id}`,
                sortable: true,
                maxRows: 11,
                limit: 200,
                empty: 'No loans.',
                columns: [
                  { key: 'borrower', label: 'Borrower', grow: true, format: (_v, l) => eco.nameOf(l.borrowerId), sortValue: (l) => eco.nameOf(l.borrowerId) },
                  { key: 'kind', label: 'Type', format: (_v, l) => loanKindLabel(l), sortValue: (l) => l.purpose },
                  { key: 'balance', label: 'Owed', align: 'right', format: (v) => money(v) },
                  { key: 'rate', label: 'Rate', align: 'right', format: (v) => percent(v, 1) },
                  { key: 'status', label: 'Status', format: (_v, l) => loanStatusLabel(l) },
                ],
                rows: loans.sort((a, c) => c.balance - a.balance),
                rowTone: (l) => loanStatusTone(l),
                onRowClick: (l) => ctx.open({ kind: 'loan', id: l.id }),
              }),
            ),
            serviced.length
              ? section(
                  `Sold to investors, still collected by ${b.short} (${serviced.length})`,
                  table<Loan>({
                    key: `bank-sold-${id}`,
                    maxRows: 6,
                    limit: 100,
                    columns: [
                      { key: 'borrower', label: 'Borrower', grow: true, format: (_v, l) => eco.nameOf(l.borrowerId) },
                      { key: 'holder', label: 'Owned by', format: (_v, l) => (l.holder.kind === 'pool' ? eco.pools.get(l.holder.id)?.name ?? 'MBS pool' : eco.fund.name) },
                      { key: 'balance', label: 'Owed', align: 'right', format: (v) => money(v) },
                    ],
                    rows: serviced.sort((a, c) => c.balance - a.balance),
                    rowTone: (l) => loanStatusTone(l),
                    onRowClick: (l) => ctx.open({ kind: 'loan', id: l.id }),
                  }),
                )
              : '',
          );
          break;
        }
        case 'profit': {
          const sum = (pls: PL[]): PL => {
            const o: PL = { interestIncome: 0, interestExpense: 0, fees: 0, opex: 0, provisions: 0, creditLosses: 0, securitiesGains: 0, dividends: 0 };
            for (const p of pls) for (const k of Object.keys(o) as (keyof PL)[]) o[k] += p[k];
            return o;
          };
          const cols: [string, PL][] = [
            ['This month', b.pl],
            ['Last month', b.plLast],
            ['Last 12 months', sum(b.plYear)],
          ];
          const rows: [string, (p: PL) => number, string?][] = [
            ['Interest earned', (p) => p.interestIncome],
            ['Interest paid', (p) => -p.interestExpense],
            ['Fees & rents', (p) => p.fees],
            ['Staff & running costs', (p) => -p.opex],
            ['Provisions for bad loans', (p) => -p.provisions],
            ['Loan losses', (p) => -p.creditLosses],
            ['Gains on asset sales', (p) => p.securitiesGains],
          ];
          body.append(
            h(
              'table',
              { class: 'mi-table gm-pl' },
              h('thead', h('tr', h('th', ''), cols.map(([t]) => h('th', { style: { textAlign: 'right' } }, t)))),
              h(
                'tbody',
                rows.map(([label, f]) =>
                  h(
                    'tr',
                    h('td', label),
                    cols.map(([, p]) => {
                      const v = f(p);
                      return h('td', { class: ['mi-num', v < 0 ? 'mi-bad' : ''], style: { textAlign: 'right' } }, money(v));
                    }),
                  ),
                ),
                h(
                  'tr',
                  { class: 'gm-pl-total' },
                  h('td', h('strong', 'Net profit')),
                  cols.map(([, p]) => {
                    const v = netIncome(p);
                    return h('td', { class: ['mi-num', v < 0 ? 'mi-bad' : 'mi-good'], style: { textAlign: 'right' } }, h('strong', money(v)));
                  }),
                ),
                h(
                  'tr',
                  h('td', 'Dividends to shareholders'),
                  cols.map(([, p]) => h('td', { class: 'mi-num', style: { textAlign: 'right' } }, money(p.dividends))),
                ),
              ),
            ),
            note('Banks earn the gap between what borrowers pay and what depositors get. Losses on bad loans eat straight into equity.'),
          );
          break;
        }
        case 'history': {
          const hist = b.history;
          if (hist.length < 2) {
            body.append(note('History appears after the first month.'));
            break;
          }
          const labels = hist.map((x) => fmtDate(x.day, false));
          body.append(
            wctx.memo('cap', [hist.length], () =>
              lineChart({
                labels,
                height: 120,
                percent: true,
                series: [
                  { label: 'Capital ratio', color: '#63ff7e', values: hist.map((x) => x.capitalRatio) },
                  { label: 'Liquidity', color: '#5ad2ff', values: hist.map((x) => Math.min(1, x.liquidityRatio)) },
                  { label: 'Bad loans', color: '#ff5a4a', values: hist.map((x) => x.npl) },
                ],
                refLines: [{ at: req, label: 'min capital', color: '#c0392b' }],
              }),
            ),
            wctx.memo('bal', [hist.length], () =>
              lineChart({
                labels,
                height: 120,
                format: money,
                series: [
                  { label: 'Loans', color: '#ffd23c', values: hist.map((x) => x.loans) },
                  { label: 'Deposits', color: '#5ad2ff', values: hist.map((x) => x.deposits) },
                  { label: 'Equity', color: '#63ff7e', values: hist.map((x) => x.equity) },
                ],
              }),
            ),
            wctx.memo('fear', [hist.length], () =>
              lineChart({
                labels,
                height: 90,
                series: [
                  { label: 'Monthly profit', color: '#ffd23c', values: hist.map((x) => x.profit), type: 'bar', format: money },
                ],
                format: money,
                zeroLine: true,
              }),
            ),
          );
          break;
        }
      }
    },
  });
}
