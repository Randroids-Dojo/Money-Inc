// Loan trail: "every dollar has a history". Which bank created the money, who borrowed it, where
// it was spent, how much has been repaid (and destroyed), who owns the loan now, and who took the
// losses if it went bad.

import { badge, h, kv, note, openWindow, section, gauge } from '../../ui';
import { collateralNow } from '../../sim/banking';
import { fmtDate } from '../../sim/format';
import { agentLink, loanKindLabel, loanStatusLabel, money, percent, storyList } from './common';
import type { UIContext } from './context';
import { traceButton } from './genesis/trace';

export function openLoanWindow(ctx: UIContext, id: number, anchor?: { x: number; y: number }): void {
  const l0 = ctx.game.eco.loans.get(id);
  if (!l0) return;
  openWindow({
    id: `loan-${id}`,
    title: `${loanKindLabel(l0)} #${id}`,
    icon: '📜',
    accent: ctx.game.eco.bank(l0.originatorId)?.color,
    width: 400,
    anchor,
    tabs: [
      { id: 'money', label: 'Follow the Money' },
      { id: 'trail', label: 'Full Trail' },
    ],
    render: (body, wctx) => {
      const eco = ctx.game.eco;
      const l = eco.loans.get(id);
      if (!l) return;
      const bank = eco.bank(l.originatorId);
      const tone = l.status === 'performing' ? 'good' : l.status === 'repaid' ? 'muted' : l.status === 'late' ? 'warn' : 'bad';
      body.append(h('div', { class: 'mi-row gm-badges' }, badge(loanStatusLabel(l).toUpperCase(), tone), l.holder.kind !== 'bank' ? badge('SOLD ON', 'info') : null, traceButton(ctx, { kind: 'loan', id: l.id })));
      if (wctx.tab === 'trail') {
        body.append(storyList(ctx, l.trail, { newestFirst: false, max: 60 }));
        return;
      }
      // ---- creation
      body.append(
        section(
          '1. Money created',
          h(
            'div',
            { class: 'gm-flowline' },
            h('span', { class: 'gm-chip is-new' }, `+${money(l.principal0)}`),
            h(
              'span',
              `On ${fmtDate(l.day)}, `,
              bank ? agentLink(ctx, bank.id) : 'a bank',
              ' lent ',
              agentLink(ctx, l.borrowerId),
              ` ${money(l.principal0)}. No savings were handed over: the bank simply typed new deposits into the borrower’s account — brand-new money, backed by the promise to repay.`,
            ),
          ),
        ),
      );
      // ---- first uses
      if (l.spentOn.length) {
        body.append(
          section(
            '2. Where it was spent',
            h(
              'ul',
              { class: 'gm-spent' },
              l.spentOn
                .slice()
                .sort((a, b) => b.amount - a.amount)
                .slice(0, 10)
                .map((s) => {
                  const who = eco.agents.get(s.agent);
                  const bankOf = who && 'acct' in who && who.acct ? who.acct.bank : undefined;
                  return h(
                    'li',
                    h('span', { class: 'gm-chip' }, money(s.amount)),
                    ` ${s.what} → `,
                    agentLink(ctx, s.agent),
                    bankOf && bankOf.id !== l.originatorId ? h('span', { class: 'mi-muted' }, ` (deposits moved to ${bankOf.short})`) : null,
                  );
                }),
            ),
            note('When money is spent it doesn’t disappear — it becomes someone else’s deposit. If that account is at another bank, the lender must hand over reserves to settle.'),
          ),
        );
      }
      // ---- repayment
      const repaid = l.principalPaid;
      body.append(
        section(
          '3. Repayment',
          gauge({
            label: 'Principal repaid',
            value: l.principal0 > 0 ? repaid / l.principal0 : 0,
            min: 0,
            max: 1,
            format: (v) => percent(v, 0),
            color: '#63ff7e',
          }),
          kv([
            ['Still owed', money(l.balance), { strong: true }],
            ['Repaid so far (money destroyed)', money(repaid), { hint: 'Repaying principal deletes the deposit used to pay it: money leaves circulation.' }],
            ['Interest paid to date', money(l.interestPaid), { hint: 'Interest becomes bank income; what the bank pays out as wages and dividends goes back into circulation.' }],
            ['Interest rate', percent(l.rate, 2)],
            ['Payments made', `${l.monthsPaid} of ${l.termMonths}${l.amortizing ? '' : ' (interest-only)'}`],
            l.missed > 0 ? ['Missed payments', String(l.missed), { tone: 'bad' }] : null,
          ]),
        ),
      );
      // ---- ownership
      let owner: HTMLElement;
      if (l.holder.kind === 'bank') {
        owner = h('div', 'Held by ', agentLink(ctx, l.holder.id), l.holder.id !== l.originatorId ? ' (took it over when the lender failed)' : '', '.');
      } else if (l.holder.kind === 'pool') {
        const pool = eco.pools.get(l.holder.id);
        const holders: HTMLElement[] = [];
        if (pool) {
          const fh = eco.fund.mbs.get(pool.id);
          if (fh && fh.frac > 0.001) holders.push(h('li', agentLink(ctx, eco.fund.id), ` owns ${percent(fh.frac, 0)}`));
          for (const b of eco.banks) {
            const bh = b.mbs.get(pool.id);
            if (bh && bh.frac > 0.001) holders.push(h('li', agentLink(ctx, b.id), ` owns ${percent(bh.frac, 0)}`));
          }
          const ch = eco.cb.mbs.get(pool.id);
          if (ch && ch.frac > 0.001) holders.push(h('li', agentLink(ctx, eco.cb.id), ` owns ${percent(ch.frac, 0)} (bought with new reserves)`));
        }
        owner = h(
          'div',
          `Packaged into the mortgage-backed security `,
          h('strong', pool?.name ?? 'MBS'),
          pool ? ` (market price ${(pool.price * 100).toFixed(1)}¢ per $1)` : '',
          '. Payments now flow to its investors:',
          h('ul', { class: 'gm-spent' }, holders),
        );
      } else owner = h('div', 'Sold to ', agentLink(ctx, eco.fund.id), '.');
      body.append(
        section(
          '4. Who owns it now',
          owner,
          l.servicerId !== (l.holder.kind === 'bank' ? l.holder.id : -1) ? h('div', { class: 'mi-muted' }, 'Payments are collected by ', agentLink(ctx, l.servicerId), '.') : null,
        ),
      );
      // ---- collateral
      const col = l.collateral;
      if (col.kind !== 'none') {
        const now = l.active ? collateralNow(eco, l) : 0;
        body.append(
          section(
            'Security',
            kv([
              ['Pledged', col.kind === 'property' ? 'the home' : col.kind === 'business' ? 'business equipment' : 'the building project'],
              ['Value when lent', money(col.value)],
              l.active ? ['Value now', money(now), { tone: now < l.balance ? 'bad' : undefined }] : null,
              l.active && now > 0 ? ['Loan-to-value now', percent(l.balance / now, 0), { tone: l.balance > now ? 'bad' : undefined }] : null,
            ]),
          ),
        );
      }
      // ---- losses
      if (l.status === 'defaulted' || l.lossAmount > 0) {
        const absorbed =
          l.holder.kind === 'bank'
            ? h('span', agentLink(ctx, l.holder.id), '’s shareholders (its equity shrank)')
            : l.holder.kind === 'pool'
              ? h('span', 'the investors in ', eco.pools.get(l.holder.id)?.name ?? 'the MBS pool')
              : h('span', agentLink(ctx, eco.fund.id), '’s investors');
        body.append(
          section(
            '5. The default',
            kv([
              ['Loss', money(l.lossAmount), { tone: 'bad', strong: true }],
              ['Recovered (sale of collateral)', money(l.recovered)],
            ]),
            h('div', { class: 'gm-para' }, 'The loss was absorbed by ', absorbed, '. The money the borrower spent is still out there — only the bank’s claim was lost.'),
          ),
        );
      }
    },
  });
}
