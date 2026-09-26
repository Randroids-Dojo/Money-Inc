// The Reserve Bank: the player's control room. Every lever here is a simulation parameter that
// banks, firms and households react to — nothing is scripted.

import { badge, balanceSheet, choice, h, kv, note, openWindow, section, spinner, stat, table } from '../../ui';
import { metrics } from '../../sim/banking';
import { bondPrice } from '../../sim/markets';
import type { DepositInsurance, EmergencyLiquidity, QeTarget } from '../../sim/types';
import type { Bank } from '../../sim/bank';
import { money, percent } from './common';
import { grade } from '../mandate';
import type { UIContext } from './context';

const pending = new Map<string, number>();

/** Announce a policy change in the news once the player stops fiddling with the control. */
function announce(ctx: UIContext, key: string, text: () => string): void {
  const t = pending.get(key);
  if (t) window.clearTimeout(t);
  pending.set(
    key,
    window.setTimeout(() => {
      pending.delete(key);
      const eco = ctx.game.eco;
      eco.headline(text(), 'policy', eco.cb.id, undefined, `policy-${key}-${eco.day}`, 0);
    }, 1200),
  );
}

export function openCentralBankWindow(ctx: UIContext, anchor?: { x: number; y: number }, tab = 'controls'): void {
  const eco0 = ctx.game.eco;
  openWindow({
    id: 'cb',
    title: eco0.cb.name,
    icon: '🏛️',
    accent: '#3f6f5f',
    width: 440,
    anchor,
    initialTab: tab,
    tabs: [
      { id: 'controls', label: 'Controls' },
      { id: 'banks', label: 'Supervision' },
      { id: 'sheet', label: 'Balance Sheet' },
    ],
    render: (body, wctx) => {
      const eco = ctx.game.eco;
      const p = eco.policy;
      const st = eco.stats;
      const last = (k: Parameters<typeof st.last>[0]) => (st.length ? st.last(k) : NaN);
      if (wctx.tab === 'controls') {
        const md = ctx.game.mandate;
        body.append(
          h(
            'div',
            { class: 'gm-mandate' },
            h('span', { class: ['gm-grade', `is-${grade(md.approval)}`] }, grade(md.approval)),
            h(
              'div',
              h('strong', `Public approval ${Math.round(md.approval)}%`),
              h(
                'div',
                { class: 'mi-muted' },
                md.reasons.length ? md.reasons.slice(0, 3).map((r) => `${r.label} (${r.delta > 0 ? '+' : ''}${Math.round(r.delta)})`).join(' · ') : 'Your mandate: 2% inflation, plenty of jobs, no bank failures.',
              ),
            ),
          ),
          h(
            'div',
            { class: 'mi-grid3 gm-tiles' },
            stat('Inflation', percent(last('inflation')), null, { tone: last('inflation') > 0.05 ? 'bad' : last('inflation') < 0 ? 'warn' : undefined, tip: 'Consumer prices vs a year ago. Target: 2%.' }),
            stat('Jobless', percent(last('unemployment')), null, { tone: last('unemployment') > 0.09 ? 'bad' : undefined }),
            stat('Credit growth', percent(last('creditGrowth')), null, { tip: 'Total loans outstanding vs a year ago.' }),
          ),
          section(
            'Interest rates',
            h(
              'div',
              { class: 'gm-control' },
              spinner({
                label: 'Policy rate',
                value: p.policyRate,
                min: 0,
                max: 0.15,
                step: 0.0025,
                bigStep: 4,
                disabled: p.autopilot,
                format: (v) => percent(v, 2),
                tip: 'The rate banks pay to borrow reserves overnight. Loan and deposit rates float on top of it. Higher rates cool borrowing, spending and house prices; lower rates do the opposite.',
                onChange: (v) => {
                  const before = p.policyRate;
                  p.policyRate = Math.round(v * 400) / 400;
                  announce(ctx, 'rate', () => `Reserve Bank ${p.policyRate > before ? 'raises' : 'cuts'} its policy rate to ${percent(p.policyRate, 2)}`);
                },
              }),
              choice({
                small: true,
                value: p.autopilot ? 'auto' : 'manual',
                options: [
                  { id: 'manual', label: 'Manual', title: 'You set the policy rate.' },
                  { id: 'auto', label: 'Autopilot', title: 'The rate follows a simple rule: up when inflation is high, down when unemployment is high.' },
                ],
                onChange: (id) => {
                  p.autopilot = id === 'auto';
                  eco.headline(p.autopilot ? 'Reserve Bank puts interest rates on autopilot (a Taylor rule)' : 'Reserve Bank takes manual control of interest rates', 'policy', eco.cb.id);
                  wctx.win.rerender();
                },
              }),
            ),
            kv([
              ['Typical mortgage rate', percent(last('mortgageRate'), 2)],
              ['Typical business loan rate', percent(last('businessRate'), 2)],
              ['10-year bond yield', percent(eco.market.bondYield, 2)],
            ]),
          ),
          section(
            'Bank rules',
            spinner({
              label: 'Capital requirement',
              value: p.capitalRequirement,
              min: 0.02,
              max: 0.25,
              step: 0.005,
              format: (v) => percent(v, 1),
              tip: 'Minimum equity per $ of risk-weighted loans. This is what really limits how much money banks can create. Raising it forces banks to lend less (or raise capital); lowering it lets them lend more on the same cushion.',
              onChange: (v) => {
                p.capitalRequirement = v;
                announce(ctx, 'cap', () => `New rule: banks must hold capital of at least ${percent(p.capitalRequirement, 1)} of risky assets`);
              },
            }),
            spinner({
              label: 'Liquidity requirement',
              value: p.liquidityRequirement,
              min: 0,
              max: 0.4,
              step: 0.01,
              format: (v) => percent(v, 0),
              tip: 'Cash and government securities banks must hold against deposits, so they can survive withdrawals.',
              onChange: (v) => {
                p.liquidityRequirement = v;
                announce(ctx, 'liq', () => `New rule: banks must hold liquid assets of ${percent(p.liquidityRequirement, 0)} of deposits`);
              },
            }),
          ),
          section(
            'Safety nets',
            choice({
              label: 'Deposit insurance',
              value: p.depositInsurance,
              options: [
                { id: 'none', label: 'None', title: 'Depositors lose money when a bank fails — and they know it. Runs are likely.' },
                { id: 'basic', label: '$50K', title: 'Deposits up to $50K are guaranteed.' },
                { id: 'standard', label: '$250K', title: 'Deposits up to $250K are guaranteed.' },
                { id: 'unlimited', label: 'All', title: 'Every deposit is guaranteed. No runs — but banks may take more risk.' },
              ],
              onChange: (id) => {
                p.depositInsurance = id as DepositInsurance;
                eco.headline(`Deposit insurance now covers ${id === 'none' ? 'nothing' : id === 'basic' ? 'up to $50K' : id === 'standard' ? 'up to $250K' : 'every deposit'}`, 'policy', eco.cb.id);
              },
            }),
            choice({
              label: 'Lender of last resort',
              value: p.emergencyLiquidity,
              options: [
                { id: 'none', label: 'Off', title: 'No emergency loans: a bank that runs out of cash fails, even if it is solvent.' },
                { id: 'standard', label: 'Penalty', title: 'Emergency loans at a penalty rate against good collateral.' },
                { id: 'broad', label: 'Generous', title: 'Cheap emergency loans against almost any collateral.' },
              ],
              onChange: (id) => {
                p.emergencyLiquidity = id as EmergencyLiquidity;
                eco.headline(`Reserve Bank emergency lending: ${id === 'none' ? 'switched off' : id === 'standard' ? 'available at a penalty rate' : 'generous'}`, 'policy', eco.cb.id);
              },
            }),
          ),
          section(
            'Asset purchases (QE)',
            h(
              'div',
              { class: 'gm-control' },
              spinner({
                label: 'Per month',
                value: p.qePerMonth,
                min: -300_000,
                max: 600_000,
                step: 25_000,
                format: (v) => (v === 0 ? 'Off' : `${v > 0 ? 'Buy' : 'Sell'} ${money(Math.abs(v))}`),
                tip: 'Buy securities with newly created reserves (pushing down long-term rates and adding deposits when bought from non-banks), or sell them to drain money (QT).',
                onChange: (v) => {
                  p.qePerMonth = v;
                  announce(ctx, 'qe', () => (p.qePerMonth === 0 ? 'Reserve Bank ends its asset purchases' : p.qePerMonth > 0 ? `Reserve Bank starts buying ${money(p.qePerMonth)} of securities a month` : `Reserve Bank starts selling ${money(-p.qePerMonth)} of bonds a month`));
                },
              }),
              choice({
                small: true,
                value: p.qeTarget,
                options: [
                  { id: 'govt', label: 'Bonds', title: 'Government bonds only.' },
                  { id: 'govt_mbs', label: '+ MBS', title: 'Also buy mortgage-backed securities — supports the housing market and banks.' },
                ],
                onChange: (id) => {
                  p.qeTarget = id as QeTarget;
                },
              }),
            ),
            eco.cb.qeCum > 0 ? kv([['Bought so far', money(eco.cb.qeCum)]]) : '',
          ),
        );
        return;
      }
      if (wctx.tab === 'banks') {
        const banks = eco.banks.slice();
        body.append(
          table<Bank>({
            key: 'cb-banks',
            columns: [
              { key: 'name', label: 'Bank', grow: true },
              { key: 'cap', label: 'Capital', align: 'right', format: (_v, b) => (b.alive ? percent(metrics(eco, b).capitalRatio) : '—'), sortValue: (b) => (b.alive ? metrics(eco, b).capitalRatio : -1) },
              { key: 'liq', label: 'Liquid', align: 'right', format: (_v, b) => (b.alive ? percent(metrics(eco, b).liquidityRatio, 0) : '—') },
              { key: 'npl', label: 'Bad', align: 'right', format: (_v, b) => (b.alive ? percent(metrics(eco, b).nplRatio) : '—') },
              { key: 'cbLoan', label: 'Our loans', align: 'right', format: (v) => (v > 0 ? money(v) : '') },
              { key: 'status', label: 'Status', format: (v) => String(v).toUpperCase() },
            ],
            rows: banks,
            sortable: true,
            rowTone: (b) => (!b.alive || b.status === 'run' ? 'bad' : b.status === 'stressed' ? 'warn' : undefined),
            onRowClick: (b) => ctx.open({ kind: 'bank', id: b.id }),
          }),
          kv([
            ['Bank failures so far', String(eco.banks.filter((b) => !b.alive).length), { tone: eco.banks.some((b) => !b.alive) ? 'bad' : undefined }],
            ['Deposit insurance fund', money(eco.publicBalances.dif), { hint: 'Pays depositors of failed banks, funded by premiums on deposits.' }],
            eco.dif.borrowedFromTreasury > 0 ? ['Insurance fund borrowed from City Hall', money(eco.dif.borrowedFromTreasury), { tone: 'bad' }] : null,
          ]),
          note('Watch capital: banks below the minimum must stop lending. Near zero, the regulator closes them. Liquidity problems come first in a run.'),
        );
        return;
      }
      // balance sheet
      const cb = eco.cb;
      let mbs = 0;
      for (const [pid, hd] of cb.mbs) {
        const pool = eco.pools.get(pid);
        if (pool) mbs += hd.frac * pool.balance * pool.price;
      }
      let loans = 0;
      for (const v of cb.loansToBanks.values()) loans += v;
      let reserves = 0;
      for (const b of eco.banks) reserves += Math.max(0, b.reserves);
      const bonds = cb.bondPar * bondPrice(cb.bondCoupon, eco.market.bondYield);
      const assets = bonds + cb.bills + mbs + loans;
      const liabs = reserves + eco.publicBalances.treasury + eco.publicBalances.dif;
      body.append(
        balanceSheet({
          format: money,
          assets: [
            { label: 'Government bonds', value: bonds },
            { label: 'Government bills', value: cb.bills },
            { label: 'Mortgage-backed securities', value: mbs },
            { label: 'Loans to banks', value: loans },
          ].filter((x) => x.value > 0.5),
          liabilities: [
            { label: 'Bank reserves', value: reserves, hint: 'Central-bank money. Banks use it to settle payments between each other — the public never holds it.' },
            { label: 'City Hall’s account', value: Math.max(0, eco.publicBalances.treasury) },
            { label: 'Deposit insurance fund', value: Math.max(0, eco.publicBalances.dif) },
          ].filter((x) => x.value > 0.5),
          equity: [{ label: 'Valuation gains/losses', value: assets - liabs }],
        }),
        h('div', { class: 'mi-row gm-badges' }, badge(`BASE MONEY ${money(eco.baseMoney())}`, 'info'), badge(`BROAD MONEY ${money(eco.broadMoney())}`, 'good')),
        note('Broad money (bank deposits) is many times base money — and no multiplier governs the ratio. Deposits appear when banks lend; reserves only settle payments between banks.'),
      );
    },
  });
}
