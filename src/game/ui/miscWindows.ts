// Construction sites, the investment fund, City Hall and empty land.

import { badge, balanceSheet, gauge, h, kv, lineChart, note, openWindow, section, stat, table } from '../../ui';
import { fundBreakdown } from '../../sim/fund';
import { fmtDate } from '../../sim/format';
import type { MbsPool } from '../../sim/agents';
import { agentLink, loanLink, money, percent } from './common';
import { CFG } from '../../sim/config';
import type { UIContext } from './context';

export function openProjectWindow(ctx: UIContext, id: number, anchor?: { x: number; y: number }): void {
  const p0 = ctx.game.eco.projects.get(id);
  if (!p0) return;
  openWindow({
    id: `proj-${id}`,
    title: 'Construction Site',
    icon: '🏗️',
    width: 380,
    anchor,
    render: (body) => {
      const eco = ctx.game.eco;
      const p = eco.projects.get(id);
      if (!p) return;
      const loan = eco.loans.get(p.loanId);
      const client = eco.firm(p.clientId);
      const builder = eco.firm(p.builderId);
      const what =
        p.target.kind === 'house'
          ? 'a new house'
          : p.target.kind === 'apartment'
            ? `an apartment block with ${p.target.units ?? 'several'} flats`
            : p.kind === 'startup'
              ? `premises for a new business, ${client?.name ?? ''}`
              : `an expansion of ${client?.name ?? 'a business'}`;
      const progress = p.work > 0 ? 1 - p.remaining / p.work : 0;
      body.append(
        h('div', { class: 'mi-row gm-badges' }, p.status === 'stalled' ? badge('STALLED', 'bad', { blink: true }) : p.status === 'complete' ? badge('COMPLETE', 'good') : badge('UNDER CONSTRUCTION', 'info')),
        h('div', { class: 'gm-para' }, h('strong', `Building ${what}.`), ' ', p.reason ? `Why: ${p.reason}.` : ''),
        gauge({ label: 'Progress', value: progress, min: 0, max: 1, format: (v) => percent(v, 0), color: '#ffd23c' }),
        section(
          'Who and how',
          kv([
            ['Built by', builder ? agentLink(ctx, builder.id) : '—'],
            client && client.id !== p.builderId ? ['For', agentLink(ctx, client.id)] : null,
            ['Total cost', money(p.cost)],
            ['Paid so far', money(p.paid)],
            loan ? ['Financed by', h('span', agentLink(ctx, loan.originatorId), ' — ', loanLink(ctx, loan, `${money(loan.principal0)} loan`))] : ['Financed by', 'the owner’s own money'],
            ['Started', fmtDate(p.started)],
            p.status === 'stalled' ? ['Why it stopped', p.stallReason || 'money ran out', { tone: 'bad' }] : null,
          ]),
        ),
        loan ? note('The loan created new money that pays the builders’ wages and buys materials — spending that ripples through the town.') : '',
      );
    },
  });
}

export function openFundWindow(ctx: UIContext, anchor?: { x: number; y: number }): void {
  openWindow({
    id: 'fund',
    title: ctx.game.eco.fund.name,
    icon: '📈',
    accent: '#2a5d8a',
    width: 420,
    anchor,
    tabs: [
      { id: 'overview', label: 'Overview' },
      { id: 'mbs', label: 'Securities' },
    ],
    render: (body, wctx) => {
      const eco = ctx.game.eco;
      const f = eco.fund;
      const br = fundBreakdown(eco);
      if (wctx.tab === 'overview') {
        const holders = eco.households.filter((x) => !x.departed && x.fundUnits > 0).length;
        body.append(
          h(
            'div',
            { class: 'mi-grid3 gm-tiles' },
            stat('Unit price', f.nav.toFixed(3), null, { tone: f.nav < f.lastNav ? 'bad' : 'good' }),
            stat('Assets', money(br.total)),
            stat('Investors', String(holders)),
          ),
          h('div', { class: 'gm-para' }, 'Households’ savings pool, managed for them. It owns the banks’ shares, buys mortgage-backed securities and loans from banks, lends them short-term money, holds government debt and — when homes look cheap next to rents — buys houses to let.'),
          gauge({
            label: 'Mood',
            value: f.fear,
            min: 0,
            max: 1,
            format: (v) => (v < 0.2 ? 'Greedy' : v < 0.4 ? 'Calm' : v < 0.6 ? 'Worried' : 'Fearful'),
            warnAbove: 0.4,
            dangerAbove: 0.65,
            tip: 'When the fund is fearful it stops buying securitised loans and refuses to roll over banks’ short-term funding.',
          }),
          balanceSheet({
            format: money,
            titles: ['Holdings', 'Owned by'],
            assets: [
              { label: 'Cash (deposits)', value: br.cash },
              { label: 'Government bills', value: br.bills },
              { label: 'Government bonds', value: br.bonds },
              { label: 'Mortgage-backed securities', value: br.mbs },
              { label: 'Loans bought from banks', value: br.loans },
              { label: 'Short-term loans to banks', value: br.repos },
              { label: 'Bank shares', value: br.bankShares },
              { label: 'Bank bonds', value: br.bankBonds },
              { label: 'Rental homes', value: br.property },
            ].filter((x) => x.value > 0.5),
            liabilities: [],
            equity: [{ label: 'Households’ fund units', value: br.total }],
          }),
          f.navHistory.length > 2
            ? wctx.memo('nav', [f.navHistory.length], () =>
                lineChart({
                  height: 90,
                  labels: f.navHistory.map((_, i) => fmtDate(Math.max(0, eco.day - (f.navHistory.length - 1 - i) * 30), false)),
                  series: [{ label: 'Unit price', color: '#5ad2ff', values: f.navHistory }],
                  format: (v) => v.toFixed(3),
                }),
              )
            : '',
        );
        return;
      }
      const pools = [...eco.pools.values()].filter((p) => p.balance > 1);
      body.append(
        table<MbsPool>({
          key: 'fund-pools',
          maxRows: 12,
          empty: 'No mortgage-backed securities yet.',
          columns: [
            { key: 'name', label: 'Security', grow: true },
            { key: 'balance', label: 'Owed', align: 'right', format: (v) => money(v) },
            { key: 'price', label: 'Price', align: 'right', format: (v) => `${(v * 100).toFixed(1)}¢` },
            { key: 'delinq', label: 'Late', align: 'right', format: (_v, p) => percent(p.delinquency()) },
            { key: 'own', label: 'Fund owns', align: 'right', format: (_v, p) => percent(eco.fund.mbs.get(p.id)?.frac ?? 0, 0) },
          ],
          rows: pools,
          rowTone: (p) => (p.delinquency() > 0.08 ? 'bad' : p.price < 0.9 ? 'warn' : undefined),
          onRowClick: (p) => {
            const l = p.loans.find((x) => x.active);
            if (l) ctx.open({ kind: 'loan', id: l.id });
          },
        }),
        note('Banks bundle mortgages into these securities and sell them, freeing capital to lend again. If borrowers fall behind, prices fall — and whoever holds them takes the loss.'),
      );
    },
  });
}

export function openCityHallWindow(ctx: UIContext, anchor?: { x: number; y: number }): void {
  openWindow({
    id: 'cityhall',
    title: 'City Hall',
    icon: '🏛️',
    accent: '#6a5a8a',
    width: 380,
    anchor,
    render: (body, wctx) => {
      const eco = ctx.game.eco;
      const t = eco.treasury;
      const st = eco.stats;
      const deficit = st.length ? st.last('deficit') : 0;
      const debt = t.bills + t.bondPar;
      const gdp = st.length ? st.last('gdp') * 12 : 1;
      body.append(
        h(
          'div',
          { class: 'mi-grid3 gm-tiles' },
          stat('Public staff', String(t.employees.length)),
          stat('Deficit / mo', money(deficit), null, { tone: deficit > 0 ? 'warn' : 'good' }),
          stat('Debt', money(debt), null, { tip: `${percent(debt / Math.max(1, gdp), 0)} of a year’s GDP` }),
        ),
        h('div', { class: 'gm-para' }, 'City Hall collects taxes on wages and dividends, employs teachers, nurses and clerks, pays unemployment benefits and pensions, and hires local firms for public works. When it spends more than it taxes, it borrows by selling bills and bonds — and its spending adds new deposits to the economy.'),
        kv([
          ['Cash at the Reserve Bank', money(eco.publicBalances.treasury)],
          ['Public works last month', money(t.procurementLast)],
          ['Tax on wages / dividends', `${percent(CFG.taxRate, 0)} / ${percent(CFG.dividendTax, 0)}`],
          ['Unemployment benefit', money(eco.market.wageIndex * CFG.benefitRatio)],
          ['State pension', money(eco.market.wageIndex * CFG.pensionRatio)],
          ['Bills outstanding', money(t.bills)],
          ['Bonds outstanding', money(t.bondPar)],
        ]),
        t.deficitHistory.length > 2
          ? wctx.memo('def', [t.deficitHistory.length], () =>
              lineChart({
                height: 90,
                format: money,
                zeroLine: true,
                labels: t.deficitHistory.map((_, i) => fmtDate(Math.max(0, eco.day - (t.deficitHistory.length - 1 - i) * 30), false)),
                series: [{ label: 'Monthly deficit', color: '#c09cff', values: t.deficitHistory, type: 'bar' }],
              }),
            )
          : '',
      );
    },
  });
}

export function openLandWindow(ctx: UIContext, lotId: number, anchor?: { x: number; y: number }): void {
  const lot = ctx.game.eco.city.lots[lotId];
  openWindow({
    id: `land-${lotId}`,
    title: lot.zone === 'park' ? 'Park' : 'Vacant Lot',
    icon: lot.zone === 'park' ? '🌳' : '🚧',
    width: 320,
    anchor,
    render: (body) => {
      const eco = ctx.game.eco;
      if (lot.zone === 'park') {
        body.append(h('div', { class: 'gm-para' }, 'A public park. Nobody makes money here — which is exactly the point.'));
        return;
      }
      const reo = eco.banks.find((b) => b.reoLots.has(lotId));
      const kind = lot.zone === 'res' ? 'homes' : lot.zone === 'ind' ? 'a factory or builder’s yard' : 'shops and offices';
      body.append(
        h('div', { class: 'gm-para' }, `Zoned for ${kind}. Builders and entrepreneurs will build here when they think it will pay — and when a bank agrees to finance it.`),
        reo ? note(h('span', 'Repossessed by ', agentLink(ctx, reo.id), ' after a business failed. It is waiting for a buyer.'), 'warn') : '',
        kv([
          ['Size', `${lot.w}×${lot.d} tiles`],
          ['Zone', lot.zone === 'res' ? 'Residential' : lot.zone === 'ind' ? 'Industrial' : 'Commercial'],
        ]),
      );
    },
  });
}
