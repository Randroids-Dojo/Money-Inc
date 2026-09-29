// Genesis Mode decisions: the loan on the player's desk (with its plan, its terms and what it
// would do to the bank), the moments when a borrower, a bank or the whole system is in trouble,
// and the desk that lists everything waiting. The game never says which choice is right: it shows
// what each choice does, then lets the simulation play it out.

import { actions, badge, button, choice, gauge, getWindow, h, kv, note, openWindow, section, type Tone } from '../../../ui';
import { fmtDate, fmtMoney, pct } from '../../../sim/format';
import { metrics } from '../../../sim/banking';
import { canPledgeHome, loanLabel, previewLoan, type LoanPreview } from '../../../sim/genesis/review';
import type { Genesis } from '../../../sim/genesis/state';
import type { CollateralChoice, LoanChoice, PlanFigures, Situation, SituationKind } from '../../../sim/genesis/types';
import type { Household, Firm } from '../../../sim/agents';
import { agentLink } from '../common';
import type { UIContext } from '../context';

export const KIND_ICON: Record<SituationKind, string> = {
  loan: '📝',
  trouble: '⚠️',
  constraint: '⚖️',
  run: '🏃',
  failure: '🏚️',
  charter: '🏦',
  era: '📜',
};

const KIND_LABEL: Record<SituationKind, string> = {
  loan: 'Loan application',
  trouble: 'Missed payment',
  constraint: 'Bank at its limits',
  run: 'Bank run',
  failure: 'Bank failure',
  charter: 'Banking licence',
  era: 'A new era',
};

/** Draft terms the player is editing, per open loan situation (kept across re-renders). */
const drafts = new Map<number, LoanChoice>();

export function situationWindowId(id: number): string {
  return `gsit-${id}`;
}

/** When the default applies, in words. */
export function deadlineText(g: Genesis, s: Situation): string {
  if (s.status !== 'open') return '';
  if (s.blocking) return 'Time is stopped until you decide';
  if (!Number.isFinite(s.deadline)) return '';
  const days = Math.max(0, s.deadline - g.eco.day);
  return `Decide by ${fmtDate(s.deadline, true)} (${days} day${days === 1 ? '' : 's'})`;
}

function firmOf(g: Genesis, s: Situation): Firm | undefined {
  const b = s.loan?.app.borrower;
  return b && b.kind === 'firm' ? b : undefined;
}

// ------------------------------------------------------------------------------------ loans

function figureRows(f: PlanFigures): HTMLElement {
  const m = (x: number) => fmtMoney(x);
  return h(
    'table',
    { class: 'gn-figs' },
    h('tr', h('th', 'Each month, at 85% of capacity'), h('th', '')),
    h('tr', h('td', 'Sales'), h('td', m(f.revenue))),
    h('tr', h('td', `Wages (${f.staff} ${f.staff === 1 ? 'person' : 'people'})`), h('td', `−${m(f.wages)}`)),
    f.inputs > 1 ? h('tr', h('td', 'Stock and materials'), h('td', `−${m(f.inputs)}`)) : null,
    h('tr', h('td', 'Wear and tear'), h('td', `−${m(f.depreciation)}`)),
    h('tr', h('td', 'Interest'), h('td', `−${m(f.interest)}`)),
    h('tr', { class: 'is-total' }, h('td', 'Profit'), h('td', { class: f.profit < 0 ? 'is-bad' : '' }, m(f.profit))),
    h('tr', h('td', 'Loan payment (interest + principal)'), h('td', m(f.payment))),
    h('tr', h('td', 'Cash left to cover it'), h('td', { class: f.dscr < 1 ? 'is-bad' : f.dscr < 1.3 ? 'is-warn' : '' }, `${f.dscr.toFixed(2)}×`)),
  );
}

const riskTone: Record<LoanPreview['risk'], Tone> = { low: 'good', moderate: 'info', high: 'warn', 'very high': 'bad' };

/** T-accounts for the first loan: what it does to both balance sheets and to the money supply. */
export function tAccounts(bank: string, borrower: string, amount: number, moneyBefore: number): HTMLElement {
  const m = fmtMoney(amount);
  const side = (title: string, asset: string, liab: string) =>
    h(
      'div',
      { class: 'gn-t' },
      h('div', { class: 'gn-t-title' }, title),
      h('div', { class: 'gn-t-cols' }, h('div', h('div', { class: 'gn-t-head' }, 'Assets'), h('div', { class: 'gn-t-plus' }, `+${m}`), h('div', { class: 'gn-t-what' }, asset)), h('div', h('div', { class: 'gn-t-head' }, 'Liabilities'), h('div', { class: 'gn-t-plus' }, `+${m}`), h('div', { class: 'gn-t-what' }, liab))),
    );
  return h(
    'div',
    { class: 'gn-taccounts' },
    h('div', { class: 'gn-t-row' }, side(bank, 'loan to ' + borrower, 'deposit owed to ' + borrower), side(borrower, 'deposit at ' + bank, 'loan owed to ' + bank)),
    h('div', { class: 'gn-t-money' }, 'Money in town: ', h('b', fmtMoney(moneyBefore)), ' → ', h('b', { class: 'is-new' }, fmtMoney(moneyBefore + amount))),
  );
}

function loanBody(ctx: UIContext, g: Genesis, s: Situation, body: HTMLElement, rerender: () => void): void {
  const eco = g.eco;
  const r = s.loan!;
  const bank = eco.bank(r.bankId);
  let c = drafts.get(s.id);
  if (!c) {
    c = { ...r.suggested, approve: true };
    drafts.set(s.id, c);
  }
  const pv = previewLoan(g, s, c);
  const b = r.app.borrower;
  const left = h('div', { class: 'gn-col' });
  const right = h('div', { class: 'gn-col' });
  body.append(h('div', { class: 'gn-cols' }, left, right));

  // ---- badges
  left.append(
    h(
      'div',
      { class: 'mi-row gm-badges' },
      badge(loanLabel(r.purpose).toUpperCase(), 'accent'),
      r.first ? badge("THE TOWN'S FIRST LOAN", 'info') : null,
      s.status === 'open' ? badge(deadlineText(g, s), s.blocking ? 'bad' : 'muted') : badge(s.status === 'decided' ? 'DECIDED' : 'DECIDED BY THE BANK', 'muted'),
    ),
    h('p', { class: 'gm-para' }, s.text),
  );

  // ---- the plan
  const fig = pv.figures;
  if (r.plan) {
    const p = r.plan;
    const owner = eco.household(p.ownerId);
    left.append(
      section(
        r.purpose === 'expansion' ? 'The expansion' : 'The business plan',
        h('p', { class: 'gm-para' }, h('b', 'Customers: '), p.market, '.'),
        kv([
          owner ? ['Owner', agentLink(ctx, owner.id)] : null,
          ['Staff', fig ? `${fig.staff}: ${[...p.staffNames, ...Array(Math.max(0, fig.staff - p.staffNames.length)).fill('someone new to hire')].slice(0, fig.staff).join(', ')}` : p.staffNames.join(', ')],
        ]),
        fig
          ? h(
              'div',
              { class: 'gn-buys' },
              h('div', { class: 'gn-sub' }, 'What the money buys'),
              h('ul', null, fig.premises > 1 ? h('li', `${fmtMoney(fig.premises)} premises — ${p.purchases[0]?.replace(/^Premises: /, '') ?? ''}`) : null, fig.equipment > 1 ? h('li', `${fmtMoney(fig.equipment)} equipment — ${p.purchases[1]?.replace(/^Equipment: /, '') ?? ''}`) : null, fig.working > 1 ? h('li', `${fmtMoney(fig.working)} working capital: wages and stock until sales come in`) : null),
              fig.equity > 1 ? note(`${owner?.name ?? 'The owner'} puts in ${fmtMoney(fig.equity)} of savings; the rest is the loan.`) : note(`${owner?.name ?? 'The owner'} has no savings to put in: all of it would be borrowed.`),
            )
          : null,
        fig ? figureRows(fig) : null,
      ),
    );
  } else if (r.home) {
    const hh = b as Household;
    const hm = r.home;
    left.append(
      section(
        hm.build ? 'The home they want to build' : hm.investment ? 'The purchase (to rent out)' : 'The home',
        kv([
          [hm.build ? 'Family' : 'Buyer', agentLink(ctx, hh.id)],
          ['Home', hm.build ? `${g.lotAddress(hm.lotId)} (a starter home, still to be built)` : g.address(hm.unitId)],
          [hm.build ? 'Cost to build' : 'Price', fmtMoney(hm.price)],
          hm.build ? ['Lives', hh.lodging ? 'boarding with a family' : 'in a rented home'] : ['Seller', agentLink(ctx, hm.sellerId)],
          ['Buyer’s savings', fmtMoney(hm.cash)],
          ['Buyer’s income', `${fmtMoney(hm.income)} a month`],
          ['Down payment', `${fmtMoney(pv.downPayment ?? 0)} (${pct(1 - (pv.ltv ?? 0), 0)})`, { tone: pv.feasible ? undefined : 'bad' }],
          ['Monthly payment', `${fmtMoney(pv.payment)} (${pct(pv.dti ?? 0, 0)} of income)`, { tone: (pv.dti ?? 0) > g.rules.maxDTI ? 'warn' : undefined }],
        ]),
      ),
    );
  } else if (r.dev) {
    const d = r.dev;
    left.append(
      section(
        d.homes ? 'Workers’ housing' : 'The development',
        kv([
          ['Builds', d.units > 1 ? `${d.units} apartments` : 'one house'],
          ['Where', d.lotId >= 0 ? 'the lot marked on the map' : '—'],
          ['Expected value when finished', fmtMoney(d.saleValue)],
          [d.homes ? 'Paid back from' : 'Paid back from', d.homes ? `rent and ${b.name}’s own profits, over ${Math.round(c.termMonths / 12)} years` : 'selling the homes'],
          ['Loan-to-value', pct(pv.amount / Math.max(1, d.saleValue), 0), { tone: pv.amount / Math.max(1, d.saleValue) > 0.85 ? 'warn' : undefined }],
          ['Monthly payment', fmtMoney(pv.payment)],
        ]),
      ),
    );
  } else {
    left.append(section('The request', kv([['Borrower', agentLink(ctx, b.id)], ['For', r.app.what], ['Amount', fmtMoney(r.requested)]])));
  }

  // ---- terms
  const set = (patch: Partial<LoanChoice>) => {
    drafts.set(s.id, { ...c!, ...patch });
    rerender();
  };
  const open = s.status === 'open';
  const sizeLabel = (x: number) => (x === r.requested ? `${fmtMoney(x)} (asked)` : fmtMoney(x));
  const collLabel: Record<CollateralChoice, string> = { business: r.home ? 'The home' : 'The business', home: 'Owner’s home', none: 'Nothing' };
  const colls = r.collaterals.filter((x) => x !== 'home' || canPledgeHome(eco, r) || c!.collateral === 'home');
  right.append(
    section(
      'Terms',
      choice({ label: r.home ? 'Mortgage' : 'Amount', options: r.sizes.map((x) => ({ id: String(x), label: sizeLabel(x) })), value: String(c.amount), onChange: (v) => set({ amount: Number(v) }), small: true, disabled: !open }),
      choice({ label: 'Interest rate', options: r.rates.map((x) => ({ id: String(x), label: pct(x, 2) })), value: String(c.rate), onChange: (v) => set({ rate: Number(v) }), small: true, disabled: !open }),
      choice({ label: 'Repay over', options: r.terms.map((x) => ({ id: String(x), label: x % 12 === 0 ? `${x / 12} years` : `${x} months` })), value: String(c.termMonths), onChange: (v) => set({ termMonths: Number(v) }), small: true, disabled: !open }),
      colls.length > 1
        ? choice({ label: 'Security', options: colls.map((x) => ({ id: x, label: collLabel[x], title: x === 'home' ? 'If the business fails, the bank can take the owner’s home.' : x === 'none' ? 'An unsecured loan: nothing to seize if it goes wrong.' : 'The bank can seize the business’s premises and equipment.' })), value: c.collateral, onChange: (v) => set({ collateral: v as CollateralChoice }), small: true, disabled: !open })
        : null,
    ),
  );

  // ---- consequences for the bank
  const m = bank ? metrics(eco, bank) : undefined;
  right.append(
    section(
      bank ? `What it does to ${bank.name}` : 'Risk',
      kv([
        ['Estimated default risk', h('span', badge(pv.risk.toUpperCase(), riskTone[pv.risk]), ` ${pct(pv.pd, 1)} a year`)],
        pv.leak > 1 ? ['Likely spent outside town', fmtMoney(Math.min(pv.leak, pv.amount)), { hint: 'Money paid to contractors or suppliers across the river leaves the town’s banks: the bank must hand over reserves to settle it.', tone: 'warn' }] : null,
      ]),
      m
        ? gauge({
            label: 'Capital ratio after',
            value: pv.capitalAfter,
            min: 0,
            max: Math.max(0.3, pv.capitalAfter * 1.15),
            format: (v) => pct(v, 1),
            marks: [{ at: pv.capitalReq, label: 'minimum' }],
            dangerBelow: pv.capitalReq,
            warnBelow: pv.capitalReq + 0.03,
          })
        : null,
      m
        ? gauge({
            label: 'Liquid funds after (of deposits)',
            value: Math.max(0, pv.liquidityAfter),
            min: 0,
            max: Math.max(0.5, Math.min(12, pv.liquidityAfter * 1.15)),
            format: (v) => pct(v, 0),
            marks: [{ at: pv.liquidityReq, label: 'minimum' }],
            dangerBelow: pv.liquidityReq,
          })
        : null,
      pv.warnings.length ? h('ul', { class: 'gn-warn' }, pv.warnings.map((w) => h('li', w))) : null,
      pv.blocked ? note(`Not possible: ${pv.blocked}`, 'bad') : null,
    ),
  );

  // ---- the bank's own view
  if (bank) {
    left.append(
      section(
        `${bank.short}'s loan officers`,
        h('p', { class: 'gm-para' }, r.offer ? `Would approve it at ${pct(r.offer.rate, 1)} (they put the default risk at ${pct(r.offer.pd, 1)} a year).` : `Would turn it down: ${r.bankReason ?? 'too risky'}.`),
        s.status === 'open' && !s.blocking ? note(`If you have not decided by ${fmtDate(s.deadline, true)}, they decide.`, 'muted') : null,
      ),
    );
  }

  // ---- the first loan: what approval does to the books
  if (r.first && open && bank) right.append(section('If you approve', tAccounts(bank.name, b.name, pv.amount, eco.broadMoney())));

  // ---- decide: the buttons sit above everything else (and stay in view while the terms scroll)
  if (open) {
    const err = h('div', { class: 'gn-err' });
    const approve = button(
      `Approve ${fmtMoney(pv.amount)} at ${pct(c.rate, 1)}`,
      () => {
        const e = g.decideLoan(s.id, { ...c!, approve: true });
        if (e) err.textContent = e;
        else finish();
      },
      { primary: true, disabled: !!pv.blocked || !pv.feasible, icon: '✅' },
    );
    const refuse = button(
      'Turn it down',
      () => {
        g.decideLoan(s.id, { ...c!, approve: false });
        finish();
      },
      { danger: true },
    );
    body.prepend(h('div', { class: 'gn-decide is-sticky' }, actions(refuse, approve), err));
  } else if (s.outcome) body.prepend(h('div', { class: 'gn-decide' }, note(s.outcome, 'info')));

  function finish(): void {
    drafts.delete(s.id);
    afterDecision(ctx, s);
  }
}

// ------------------------------------------------------------------------------------ other situations

function bankSummary(ctx: UIContext, g: Genesis, bankId: number): HTMLElement | null {
  const eco = g.eco;
  const b = eco.bank(bankId);
  if (!b) return null;
  const m = metrics(eco, b);
  return kv([
    ['Bank', agentLink(ctx, b.id)],
    ['Capital ratio', `${pct(m.capitalRatio, 1)} (minimum ${pct(eco.policy.capitalRequirement, 0)})`, { tone: m.capitalRatio < eco.policy.capitalRequirement ? 'bad' : m.capitalRatio < eco.policy.capitalRequirement + 0.03 ? 'warn' : undefined }],
    ['Liquid funds', `${pct(m.liquidityRatio, 0)} of deposits`, { tone: m.liquidityRatio < eco.policy.liquidityRequirement ? 'bad' : undefined }],
    ['Deposits', fmtMoney(m.deposits)],
    ['Loans', fmtMoney(m.loansGross)],
    ['Reserves', fmtMoney(b.reserves)],
    b.cbLoan > 0 ? ['Owes the Reserve Bank', fmtMoney(b.cbLoan), { tone: 'warn' }] : null,
    b.wholesaleFunding() > 0 ? ['Short-term borrowing', fmtMoney(b.wholesaleFunding())] : null,
  ]);
}

function loanSummary(ctx: UIContext, g: Genesis, loanId: number): HTMLElement | null {
  const eco = g.eco;
  const l = eco.loans.get(loanId);
  if (!l) return null;
  return kv([
    ['Borrower', agentLink(ctx, l.borrowerId)],
    ['Lender', agentLink(ctx, l.servicerId)],
    ['Loan', `${fmtMoney(l.principal0)} ${loanLabel(l.purpose)} at ${pct(l.rate, 1)}`],
    ['Still owed', fmtMoney(l.balance)],
    ['Missed payments', String(l.missed), { tone: 'bad' }],
    ['Monthly payment', fmtMoney(l.scheduledPayment())],
  ]);
}

function actionBody(ctx: UIContext, g: Genesis, s: Situation, body: HTMLElement): void {
  // the choice comes first; what it is about follows underneath
  body.append(decisionArea(ctx, g, s));
  body.append(
    h('div', { class: 'mi-row gm-badges' }, badge(KIND_LABEL[s.kind].toUpperCase(), s.kind === 'run' || s.kind === 'failure' ? 'bad' : s.kind === 'era' ? 'info' : 'warn'), s.status === 'open' ? badge(deadlineText(g, s), s.blocking ? 'bad' : 'muted') : badge('DECIDED', 'muted')),
    h('p', { class: 'gm-para' }, s.text),
  );
  const facts = s.bankId !== undefined ? bankSummary(ctx, g, s.bankId) : s.loanId !== undefined ? loanSummary(ctx, g, s.loanId) : null;
  if (facts) body.append(section('Where things stand', facts));
  const opts = s.options ?? [];
  if (s.status === 'open' && s.kind !== 'era' && !s.blocking && s.fallback) body.append(note(`If you have not decided by ${fmtDate(s.deadline, true)}: ${opts.find((o) => o.id === s.fallback)?.label.toLowerCase() ?? s.fallback}.`, 'muted'));
}

/** The buttons for an action situation (or, once it is settled, what came of it). */
function decisionArea(ctx: UIContext, g: Genesis, s: Situation): HTMLElement {
  if (s.status !== 'open') return h('div', { class: 'gn-decide' }, s.outcome ? note(s.outcome, 'info') : null);
  if (s.kind === 'era') {
    return h(
      'div',
      { class: 'gn-decide' },
      actions(button('Understood', () => {
        g.decideAction(s.id, 'ok');
        afterDecision(ctx, s);
      }, { primary: true })),
    );
  }
  const opts = s.options ?? [];
  return h(
    'div',
    { class: 'gn-decide' },
    section(
      'Your options',
      h(
        'div',
        { class: 'gn-options' },
        opts.map((o) =>
          h(
            'div',
            { class: ['gn-option', o.disabled && 'is-disabled'] },
            h('div', { class: 'gn-option-main' }, h('div', { class: 'gn-option-label' }, o.label), h('div', { class: 'gn-option-effect' }, o.disabled ?? o.effect)),
            button('Choose', () => {
              const e = g.decideAction(s.id, o.id);
              if (!e) afterDecision(ctx, s);
            }, { small: true, disabled: !!o.disabled, primary: !o.disabled }),
          ),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------------------------ windows

let onDecided: (s: Situation) => void = () => {};

/** The Genesis UI is told when a decision has been made (to refresh the map, show outcomes...). */
export function setDecisionListener(fn: (s: Situation) => void): void {
  onDecided = fn;
}

function afterDecision(ctx: UIContext, s: Situation): void {
  getWindow(situationWindowId(s.id))?.close();
  ctx.renderer.invalidate();
  onDecided(s);
}

export function openSituation(ctx: UIContext, id: number, anchor?: { x: number; y: number }): void {
  const g = ctx.game.eco.genesis;
  if (!g) return;
  const s0 = g.situation(id);
  if (!s0) return;
  const win = openWindow({
    id: situationWindowId(id),
    title: s0.title,
    icon: KIND_ICON[s0.kind],
    accent: s0.kind === 'run' || s0.kind === 'failure' ? '#b8432f' : s0.kind === 'loan' ? '#d9a520' : undefined,
    width: s0.kind === 'loan' ? 780 : 440,
    anchor,
    className: 'gn-sit',
    render: (body) => {
      const gg = ctx.game.eco.genesis;
      const s = gg?.situation(id);
      if (!gg || !s) {
        body.append(note('This matter has been dealt with.'));
        return;
      }
      if (s.kind === 'loan' && s.loan) loanBody(ctx, gg, s, body, () => win.rerender());
      else actionBody(ctx, gg, s, body);
    },
    // decisions are made while the player reads: only re-render on their own changes
    update: () => {},
    // a new era is only an announcement: closing it carries on with the game
    onClose: s0.kind === 'era' ? () => ctx.game.resumeAfterEvent() : undefined,
  });
  win.focus();
}

export function openDesk(ctx: UIContext, anchor?: { x: number; y: number }): void {
  openWindow({
    id: 'gdesk',
    title: 'Your desk',
    icon: '🗂️',
    width: 440,
    anchor,
    render: (body) => {
      const g = ctx.game.eco.genesis;
      if (!g) return;
      const open = g.open().sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.deadline - b.deadline);
      body.append(
        section(
          `Waiting for you (${open.length})`,
          open.length
            ? h(
                'div',
                { class: 'gn-desk' },
                open.map((s) =>
                  h(
                    'div',
                    { class: ['gn-desk-row', s.blocking && 'is-blocking'] },
                    h('span', { class: 'gn-desk-icon' }, KIND_ICON[s.kind]),
                    h('div', { class: 'gn-desk-main' }, h('div', { class: 'gn-desk-title' }, s.title), h('div', { class: 'gn-desk-sub' }, deadlineText(g, s))),
                    button('Show', () => {
                      if (s.lotId >= 0) ctx.showOnMap({ kind: 'lot', id: s.lotId });
                    }, { small: true }),
                    button('Decide', () => openSituation(ctx, s.id), { small: true, primary: true }),
                  ),
                ),
              )
            : note(g.era === 'transactions' ? 'Nothing needs you right now. Loan applications, trouble and crises will appear here.' : 'Nothing needs you right now. The banks are deciding routine loans under your rules.'),
        ),
      );
      const done = g.situations.filter((s) => s.status !== 'open' && s.status !== 'void').slice(-10).reverse();
      if (done.length)
        body.append(
          section(
            'Recently settled',
            h(
              'div',
              { class: 'gn-desk' },
              done.map((s) =>
                h(
                  'div',
                  { class: 'gn-desk-row is-done' },
                  h('span', { class: 'gn-desk-icon' }, KIND_ICON[s.kind]),
                  h('div', { class: 'gn-desk-main' }, h('div', { class: 'gn-desk-title' }, s.title), h('div', { class: 'gn-desk-sub' }, `${s.status === 'expired' ? 'Left to the bank: ' : ''}${s.outcome ?? ''}`)),
                ),
              ),
            ),
          ),
        );
      void firmOf;
    },
  });
}
