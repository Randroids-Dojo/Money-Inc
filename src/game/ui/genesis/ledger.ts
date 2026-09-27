// The money ledger: a small brass counter in the corner that keeps the town's money story. How
// much money exists, how much the banks have lent into existence, how much has been repaid (and
// destroyed), paid as interest or written off — and, folded away, the other ways money enters and
// leaves a small town.

import { h, sparkline } from '../../../ui';
import { fmtMoney } from '../../../sim/format';
import type { UIContext } from '../context';

export interface Ledger {
  el: HTMLElement;
  update(): void;
  setVisible(on: boolean): void;
}

export function createLedger(ctx: UIContext, onSize: (h: number) => void): Ledger {
  const game = ctx.game;
  let collapsed = false;
  let details = false;
  let lastMoney = 0;
  const lcd = h('div', { class: 'gn-ledger-lcd' });
  const rows = h('div', { class: 'gn-ledger-rows' });
  const spark = h('div', { class: 'gn-ledger-spark' });
  const more = h('div', { class: 'gn-ledger-more' });
  const toggle = h('button', { type: 'button', class: 'gn-ledger-toggle', onclick: () => {
    details = !details;
    update();
  } });
  const head = h(
    'button',
    {
      type: 'button',
      class: 'gn-ledger-head',
      onclick: () => {
        collapsed = !collapsed;
        el.classList.toggle('is-collapsed', collapsed);
        update();
      },
      tip: 'Click to fold the ledger away',
    },
    'MONEY IN TOWN',
  );
  const el = h('div', { class: 'gn-ledger mi-ui' }, head, lcd, spark, rows, toggle, more);
  document.body.append(el);

  const line = (label: string, value: string, cls: string, tip: string) => h('div', { class: ['gn-ledger-row', cls], tip }, h('span', label), h('b', value));

  function update(): void {
    const eco = game.eco;
    const g = eco.genesis;
    if (!g) return;
    const c = g.counters;
    const money = eco.broadMoney();
    const t = fmtMoney(money, money >= 1e6 ? 2 : undefined).replace('$', '$ ');
    if (lcd.textContent !== t) {
      lcd.textContent = t;
      if (money > lastMoney + 1) lcd.classList.remove('is-down'), lcd.classList.add('is-up');
      else if (money < lastMoney - 1) lcd.classList.remove('is-up'), lcd.classList.add('is-down');
      lastMoney = money;
    }
    let outstanding = 0;
    for (const l of eco.loans.values()) if (l.active) outstanding += l.balance;
    if (collapsed) {
      rows.replaceChildren();
      more.replaceChildren();
      spark.replaceChildren();
      toggle.hidden = true;
      onSize(el.offsetHeight);
      return;
    }
    rows.replaceChildren(
      line('Lent into existence', fmtMoney(c.originated), 'is-in', `Every loan creates a deposit: ${c.loansMade} loan${c.loansMade === 1 ? '' : 's'} so far, ${fmtMoney(c.originated)} of new money.`),
      line('Still owed', fmtMoney(outstanding), '', 'Loans outstanding today (credit).'),
      line('Repaid — destroyed', fmtMoney(c.principalRepaid), 'is-out', 'Repaying principal cancels the deposit used to pay it: that money no longer exists.'),
      line('Paid as interest', fmtMoney(c.interestPaid), 'is-out', 'Interest paid to banks also leaves circulation — until the banks spend it on wages, interest to savers or dividends.'),
      line('Written off', fmtMoney(c.defaulted), 'is-bad', 'Loans that went bad. The money they created is still out there; only the bank’s claim was lost.'),
    );
    const hist = g.history.slice(-120).map((x) => x.money);
    if (hist.length > 2) spark.replaceChildren(sparkline(hist, '#ffd97a', 176, 22, { area: true, min: 0, title: 'Money in town, month by month' }));
    toggle.textContent = details ? '▾ other ways money comes and goes' : '▸ other ways money comes and goes';
    toggle.hidden = false;
    if (details) {
      const pair = (label: string, plus: number, minus: number, tip: string) => h('div', { class: 'gn-ledger-row is-small', tip }, h('span', label), h('b', `+${fmtMoney(plus)} / −${fmtMoney(minus)}`));
      more.replaceChildren(
        pair('Banks’ own spending', c.bankSpending, c.boughtFromBanks, 'Banks create money when they pay wages, interest to savers or buy things; money is destroyed when people pay banks for homes they repossessed, rent or shares.'),
        pair('City Hall', c.publicOut, c.publicIn, 'Public spending adds deposits; taxes remove them.'),
        pair('Across the river', c.tradeIn, c.tradeOut, 'Exports, newcomers’ savings and money coming home add deposits; imports, outside contractors and people leaving take them away.'),
        h('div', { class: 'gn-ledger-sum', tip: 'The books balance to the dollar.' }, `= ${fmtMoney(c.originated - c.principalRepaid - c.interestPaid + c.bankSpending - c.boughtFromBanks + c.publicOut - c.publicIn + c.tradeIn - c.tradeOut)} in town`),
      );
    } else more.replaceChildren();
    onSize(el.offsetHeight);
  }

  return {
    el,
    update,
    setVisible(on: boolean) {
      el.hidden = !on;
      if (!on) onSize(0);
      else update();
    },
  };
}
