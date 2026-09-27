// Situations that are not loan applications (Genesis Mode): a borrower falls behind, a bank hits
// its limits, depositors panic, a bank fails, investors ask for a new bank charter. Every option
// acts on real balance sheets through the simulation's own machinery — nothing here applies an
// abstract modifier or decides an outcome in advance.

import { CFG } from '../config';
import type { Economy } from '../economy';
import { Bank, RISK_WEIGHTS, type BankPersonality } from '../bank';
import type { Firm, Household } from '../agents';
import type { Loan } from '../loan';
import {
  addBonds,
  borrowFromCB,
  borrowWholesale,
  defaultLoan,
  invalidateMetrics,
  metrics,
  originate,
  payoffLoan,
  securitize,
  sellLoans,
  setStandards,
  type LoanApp,
} from '../banking';
import { bondPrice, fire } from '../markets';
import { failBank, settleWholesale, transferBook } from '../resolution';
import { fmtMoney, pct } from '../format';
import { FIRST_BANK_ORIGIN, MAX_ORIGINS } from '../ledger';
import { bankIdentity } from '../names';
import type { ActionOption, CharterAction, ConstraintAction, FailureAction, RunAction, Situation, TroubleAction } from './types';
import type { Genesis } from './state';

// ============================================================================ helpers

function borrowerOf(eco: Economy, l: Loan): Household | Firm | undefined {
  return eco.household(l.borrowerId) ?? eco.firm(l.borrowerId);
}

function holderBank(eco: Economy, l: Loan): Bank | undefined {
  return l.holder.kind === 'bank' ? eco.bank(l.holder.id) : undefined;
}

/** Treasury capital for a bank; if City Hall lacks the cash it borrows from the Reserve Bank. */
export function publicCapital(eco: Economy, b: Bank, amount: number): void {
  if (amount <= 0) return;
  const pb = eco.publicBalances;
  if (pb.treasury < amount) {
    const need = amount - pb.treasury;
    eco.cb.bills += need;
    pb.treasury += need;
    eco.treasury.bills += need;
  }
  eco.ledger.publicToBank('treasury', b, amount, 'capital');
  b.paidIn += amount;
  invalidateMetrics(b);
}

/** Emergency reserves from the Reserve Bank so a bank can finish the day. */
export function overnightSupport(eco: Economy, b: Bank): number {
  if (b.reserves >= 0) return 0;
  const need = -b.reserves + 0.02 * b.deposits;
  b.cbLoan += need;
  b.reserves += need;
  b.cbLoanEmergency = true;
  eco.cb.loansToBanks.set(b.id, b.cbLoan);
  eco.recordFlow(eco.cb.id, b.id, need, 'cb');
  invalidateMetrics(b);
  return need;
}

function capitalGap(eco: Economy, b: Bank, target: number): number {
  const m = metrics(eco, b);
  return Math.max(0, target * m.rwa - m.equity);
}

// ============================================================================ trouble

export function troubleOptions(g: Genesis, l: Loan): ActionOption<TroubleAction>[] {
  const eco = g.eco;
  const hb = holderBank(eco, l);
  const sold = !hb ? 'Investors own this loan now; only its servicer can lend more.' : undefined;
  const b = borrowerOf(eco, l);
  const costs = b && b.kind === 'firm' ? b.last.wages + b.last.inputs : (b as Household | undefined)?.income ?? 3000;
  const extra = Math.max(3000, Math.round((costs * 3) / 1000) * 1000);
  const coll =
    l.collateral.kind === 'property'
      ? 'Foreclose on the property now and sell it.'
      : l.collateral.kind === 'business'
        ? 'Take over the business premises and equipment now; the business closes.'
        : 'There is nothing to seize: this loan is unsecured.';
  return [
    { id: 'wait', label: 'Wait and see', effect: 'Nothing changes. Unpaid interest piles onto the loan; after four missed payments it defaults.' },
    {
      id: 'restructure',
      label: 'Restructure',
      effect: 'Cut the rate by 2 points and add 2 years. Payments drop; the bank earns less on it.',
      disabled: sold,
    },
    { id: 'extend', label: 'Extend the term', effect: 'Add 3 years: smaller payments now, more interest in total.', disabled: sold },
    {
      id: 'lend',
      label: 'Lend more',
      effect: `A ${fmtMoney(extra)} credit line to cover three months of costs. New money now, more debt later.`,
    },
    { id: 'writedown', label: 'Write down 30%', effect: `Forgive ${fmtMoney(l.balance * 0.3)}. The bank takes the loss now; the borrower owes less.`, disabled: sold },
    { id: 'demand', label: 'Demand full payment', effect: 'Call in the whole loan. If the borrower cannot pay, it defaults now.' },
    { id: 'seize', label: 'Seize the collateral', effect: coll, disabled: l.collateral.kind === 'none' ? 'Nothing to seize.' : undefined },
  ];
}

export function applyTrouble(g: Genesis, l: Loan, a: TroubleAction): string {
  const eco = g.eco;
  if (!l.active) return 'The loan had already been settled.';
  const hb = holderBank(eco, l);
  const b = borrowerOf(eco, l);
  const bankName = eco.nameOf(l.servicerId);
  const clearArrears = () => {
    l.missed = 0;
    l.status = 'performing';
    if (b && b.kind === 'firm') b.missed = 0;
  };
  switch (a) {
    case 'wait':
      return 'Left to run its course.';
    case 'restructure': {
      l.spread = Math.max(0.005 - eco.policy.policyRate, l.spread - 0.02);
      l.rate = Math.max(0.005, eco.policy.policyRate + l.spread);
      l.termMonths += 24;
      clearArrears();
      l.note(eco.day, `Restructured by ${bankName}: rate cut to ${pct(l.rate, 1)}, two more years to pay`, undefined, l.servicerId, 'neutral');
      if (hb) invalidateMetrics(hb);
      return `Restructured: rate now ${pct(l.rate, 1)}, ${Math.round(l.monthsLeft / 12)} years left.`;
    }
    case 'extend':
      l.termMonths += 36;
      clearArrears();
      l.note(eco.day, `${bankName} gave three more years to repay`, undefined, l.servicerId);
      return 'Term extended by three years.';
    case 'lend': {
      if (!b) return 'The borrower is gone.';
      const bank = eco.bank(l.servicerId);
      if (!bank || !bank.alive) return 'The bank is closed.';
      const costs = b.kind === 'firm' ? b.last.wages + b.last.inputs : b.income;
      const amount = Math.max(3000, Math.round((costs * 3) / 1000) * 1000);
      const app: LoanApp = {
        borrower: b,
        kind: b.kind === 'firm' ? 'business' : 'consumer',
        purpose: b.kind === 'firm' ? 'working_capital' : 'smoothing',
        amount,
        termMonths: 12,
        amortizing: b.kind !== 'firm',
        collateral: b.kind === 'firm' ? { kind: 'business', ref: b.id, value: 0 } : { kind: 'none', value: 0 },
        income: 0,
        existingDebtService: 0,
        existingDebt: 0,
        what: 'rescue credit after missed payments',
      };
      const spread = bank.spreads[app.kind] + 0.01;
      g.successorOf.set(b.id, l.id);
      const nl = originate(eco, { bank, spread, rate: eco.policy.policyRate + spread, pd: 0.1 }, app);
      nl.spend(b.id, amount, 'catching up on bills');
      return `${bank.short} lent ${fmtMoney(amount)} more to keep ${b.name} going.`;
    }
    case 'writedown': {
      if (!hb) return 'Investors own this loan.';
      const amt = l.balance * 0.3;
      const oldProv = l.provision;
      l.balance -= amt;
      hb.pl.creditLosses += amt;
      hb.lossesCum += amt;
      l.lossAmount += amt;
      l.provision = Math.min(oldProv, l.balance);
      hb.pl.provisions += l.provision - oldProv;
      clearArrears();
      g.counters.defaulted += amt;
      l.note(eco.day, `${hb.name} forgave ${fmtMoney(amt)} of the loan`, amt, hb.id, 'bad');
      invalidateMetrics(hb);
      return `Wrote off ${fmtMoney(amt)}; ${fmtMoney(l.balance)} still owed.`;
    }
    case 'demand': {
      if (b && b.acct.balance >= l.balance) {
        payoffLoan(eco, l, b);
        return `${b.name} paid the loan off in full.`;
      }
      defaultLoan(eco, l);
      return 'The borrower could not pay: the loan defaulted and the collateral was seized.';
    }
    case 'seize':
      defaultLoan(eco, l);
      return 'The collateral was seized.';
  }
}

// ============================================================================ constraint

function securitizable(eco: Economy, b: Bank): number {
  return b.loans.filter((l) => l.kind === 'mortgage' && l.status === 'performing' && l.missed === 0 && eco.day - l.day > 60).length;
}

function fundSpare(eco: Economy): number {
  const f = eco.fund;
  return Math.max(0, f.acct.balance - 0.04 * f.nav * f.units);
}

export function constraintOptions(g: Genesis, b: Bank): ActionOption<ConstraintAction>[] {
  const eco = g.eco;
  const m = metrics(eco, b);
  const noSec = b.bills + b.bondPar < 1000 ? `${b.short} holds no government securities.` : undefined;
  const fund = fundSpare(eco);
  const investors = fund < 30_000 ? `No investor in town has the cash yet (${eco.fund.name} holds ${fmtMoney(eco.fund.acct.balance)}).` : undefined;
  const mort = securitizable(eco, b);
  return [
    { id: 'stop', label: 'Stop lending for 6 months', effect: 'No new loans. Existing ones keep paying down, so deposits shrink and ratios recover.' },
    { id: 'rates', label: 'Raise loan rates 1.5 points', effect: 'Fewer borrowers qualify; each loan earns more. Lasts a year.' },
    {
      id: 'sellsec',
      label: 'Sell securities',
      effect: `Sell ${fmtMoney(b.bills + b.bondPar * bondPrice(b.bondCoupon, eco.market.bondYield))} of government bills and bonds for reserves. Helps liquidity, not capital.`,
      disabled: noSec,
    },
    { id: 'sellloans', label: 'Sell loans', effect: 'Sell business loans to investors at a discount: frees capital, books a loss.', disabled: investors },
    {
      id: 'securitize',
      label: 'Securitise mortgages',
      effect: `Package mortgages into a security and sell it${g.rules.securitization ? '' : ' (and allow securitisation from now on)'}.`,
      disabled: mort < 3 ? `${b.short} has only ${mort} mortgage${mort === 1 ? '' : 's'} it could package.` : investors,
    },
    {
      id: 'wholesale',
      label: 'Borrow wholesale funding',
      effect: `Borrow short-term from ${eco.aliveBanks().length > 1 ? 'other banks or investors' : 'investors'}, or the Reserve Bank's lending window. Liquidity now, a bill later.`,
      disabled: eco.policy.emergencyLiquidity === 'none' && investors && eco.aliveBanks().length < 2 ? 'Nobody can lend: no other bank, no investor cash and your lending window is shut.' : undefined,
    },
    { id: 'retain', label: 'Retain all earnings', effect: 'No dividends for a year: every dollar of profit becomes capital.' },
    {
      id: 'capital',
      label: 'Raise new capital',
      effect: `Sell ${fmtMoney(capitalGap(eco, b, eco.policy.capitalRequirement + b.personality.capitalBuffer + 0.02))} of new shares to investors across the river.`,
      disabled: m.equity <= 0 || b.stress > 0.6 ? 'Investors will not buy shares in a bank in this state.' : undefined,
    },
  ];
}

export function applyConstraint(g: Genesis, b: Bank, a: ConstraintAction): string {
  const eco = g.eco;
  const m = metrics(eco, b);
  const capTarget = eco.policy.capitalRequirement + b.personality.capitalBuffer;
  const liqTarget = eco.policy.liquidityRequirement + b.personality.liquidityBuffer;
  const liqGap = Math.max(20_000, (liqTarget + 0.02 - m.liquidityRatio) * m.deposits);
  switch (a) {
    case 'stop':
      g.freezeUntil.set(b.id, eco.day + 180);
      b.stance = 'frozen';
      b.budget = 0;
      b.log(eco.day, 'Stopped new lending for six months', 'bad');
      return `${b.name} stops lending until ${Math.round((eco.day + 180) / 30)}`;
    case 'rates':
      g.spreadAdd.set(b.id, { add: 0.015, until: eco.day + 360 });
      setStandards(eco, b);
      b.log(eco.day, 'Raised loan rates by 1.5 points', 'neutral');
      return `${b.short}'s loan rates rise 1.5 points for a year.`;
    case 'sellsec': {
      let got = 0;
      if (b.bills > 0) {
        const x = b.bills;
        b.bills = 0;
        eco.cb.bills += x;
        b.reserves += x;
        got += x;
      }
      if (b.bondPar > 0) {
        const price = bondPrice(b.bondCoupon, eco.market.bondYield);
        const par = b.bondPar;
        const bookPer = b.bondBook / par;
        const proceeds = par * price;
        b.pl.securitiesGains += proceeds - par * bookPer;
        addBonds(eco.cb, par, proceeds, b.bondCoupon);
        b.bondPar = 0;
        b.bondBook = 0;
        b.reserves += proceeds;
        got += proceeds;
      }
      invalidateMetrics(b);
      b.log(eco.day, `Sold ${fmtMoney(got)} of government securities`, 'neutral');
      return `Sold ${fmtMoney(got)} of securities for reserves.`;
    }
    case 'sellloans': {
      const need = Math.max(50_000, (m.rwa - m.equity / (capTarget + 0.01)) / RISK_WEIGHTS.business);
      const sold = sellLoans(eco, b, need);
      return sold > 0 ? `Sold ${fmtMoney(sold)} of loans to investors.` : 'No buyer would pay a price the bank could accept.';
    }
    case 'securitize': {
      if (!g.rules.securitization) g.setRule('securitization', true, false);
      const sold = securitize(eco, b, Math.max(100_000, m.mortgages * 0.4));
      return sold > 0 ? `Packaged ${fmtMoney(sold)} of mortgages into a security.` : 'Investors would not buy the security at an acceptable price.';
    }
    case 'wholesale': {
      let got = borrowWholesale(eco, b, liqGap, 90);
      if (got < liqGap) got += borrowFromCB(eco, b, liqGap - got);
      return got > 0 ? `Borrowed ${fmtMoney(got)} of short-term funding.` : 'Nobody would lend.';
    }
    case 'retain':
      g.retainUntil.set(b.id, eco.day + 360);
      b.dividendsSuspended = true;
      b.log(eco.day, 'Stopped paying dividends to rebuild capital', 'neutral');
      return 'No dividends for a year.';
    case 'capital': {
      const amt = Math.max(25_000, capitalGap(eco, b, capTarget + 0.02));
      eco.ledger.outsideToBank(b, amt, 'capital', eco.world.id);
      b.paidIn += amt;
      invalidateMetrics(b);
      b.log(eco.day, `Raised ${fmtMoney(amt)} of new capital from outside investors`, 'good');
      eco.event('capital_raise', b.id, amt, eco.world.id);
      return `Raised ${fmtMoney(amt)} of new capital.`;
    }
  }
}

// ============================================================================ run

export function runOptions(g: Genesis, b: Bank): ActionOption<RunAction>[] {
  const eco = g.eco;
  const others = eco.aliveBanks().filter((x) => x !== b);
  const m = metrics(eco, b);
  const acq = others.length ? others.reduce((a, x) => (metrics(eco, x).capitalRatio > metrics(eco, a).capitalRatio ? x : a)) : undefined;
  return [
    { id: 'nothing', label: 'Do nothing', effect: 'Let depositors decide. The bank sells what it can and borrows where it can.' },
    { id: 'ela', label: 'Emergency liquidity', effect: `The Reserve Bank lends ${b.short} whatever its loans can secure, for six months.` },
    {
      id: 'guarantee',
      label: 'Guarantee all deposits',
      effect: 'Promise every depositor full protection (unlimited deposit insurance for all banks).',
      disabled: eco.policy.depositInsurance === 'unlimited' ? 'Deposits are already fully guaranteed.' : undefined,
    },
    { id: 'sell', label: 'Force asset sales', effect: 'Sell securities and loans now to pay depositors, at whatever price they fetch.' },
    {
      id: 'acquire',
      label: acq ? `Arrange a takeover by ${acq.short}` : 'Arrange a takeover',
      effect: acq ? `${acq.name} takes over all deposits and loans; ${b.short} ceases to exist.` : '',
      disabled: acq ? (m.equity <= 0 ? 'No bank will take on a bank with negative capital without public money.' : undefined) : 'There is no other bank in town.',
    },
    { id: 'recap', label: 'Recapitalise with public money', effect: `City Hall puts in ${fmtMoney(Math.max(25_000, capitalGap(eco, b, eco.policy.capitalRequirement + 0.05)))} of capital.` },
    { id: 'fail', label: 'Let it fail', effect: others.length ? 'Close it: another bank takes over its accounts; insurance covers depositors up to the limit.' : 'Close it: a public bridge bank takes over its accounts.' },
  ];
}

export function applyRun(g: Genesis, b: Bank, a: RunAction): string {
  const eco = g.eco;
  const m = metrics(eco, b);
  switch (a) {
    case 'nothing':
      return 'Left to the market.';
    case 'ela': {
      g.elaUntil.set(b.id, eco.day + 180);
      const got = borrowFromCB(eco, b, Math.max(10_000, 0.1 * m.deposits));
      return `Emergency liquidity opened: ${fmtMoney(got)} lent at once.`;
    }
    case 'guarantee':
      eco.policy.depositInsurance = 'unlimited';
      for (const x of eco.aliveBanks()) x.stress *= 0.7;
      return 'Every deposit in town is now fully guaranteed.';
    case 'sell': {
      let got = applyConstraint(g, b, 'sellsec');
      if (fundSpare(eco) > 30_000) got += ' ' + applyConstraint(g, b, 'sellloans');
      return got;
    }
    case 'acquire': {
      const acq = eco.aliveBanks().filter((x) => x !== b).reduce((x, y) => (metrics(eco, y).capitalRatio > metrics(eco, x).capitalRatio ? y : x));
      mergeBanks(g, b, acq);
      return `${acq.name} took over ${b.name}.`;
    }
    case 'recap': {
      const amt = Math.max(25_000, capitalGap(eco, b, eco.policy.capitalRequirement + 0.05));
      publicCapital(eco, b, amt);
      b.stress *= 0.6;
      b.log(eco.day, `Recapitalised with ${fmtMoney(amt)} of public money`, 'bad');
      eco.headline(`City Hall puts ${fmtMoney(amt)} of public money into ${b.name}`, 'alert', b.id, undefined, `recap-${b.id}`, 0);
      return `City Hall put in ${fmtMoney(amt)} of capital.`;
    }
    case 'fail':
      g.allowFail.add(b.id);
      failBank(eco, b, 'liquidity');
      return `${b.name} was closed.`;
  }
}

/** A solvent bank is taken over whole: its owners are paid, nothing is lost. */
export function mergeBanks(g: Genesis, b: Bank, acq: Bank): void {
  const eco = g.eco;
  const m = metrics(eco, b);
  const equity = Math.max(0, m.equity);
  settleWholesale(eco, b);
  transferBook(eco, b, acq);
  if (equity > 1) {
    // the acquirer pays the old owners (outside investors) for the business
    eco.ledger.bankToOutside(acq, equity * 0.9, 'capital', eco.world.id);
    acq.retained -= equity * 0.9;
  }
  b.status = 'failed';
  b.failedDay = eco.day;
  b.failureKind = null;
  b.acquiredBy = acq.id;
  b.stance = 'frozen';
  for (const hid of b.employees.slice()) {
    const h = eco.household(hid);
    if (h) fire(eco, h, `${b.name} was taken over`);
  }
  b.employees = [];
  b.log(eco.day, `Taken over by ${acq.name}`, 'neutral');
  acq.log(eco.day, `Took over ${b.name}`, 'neutral');
  eco.headline(`${acq.name} takes over ${b.name}`, 'alert', acq.id, undefined, `merge-${b.id}`, 0);
  eco.event('bank_rescue', b.id, m.assets, acq.id);
  g.onBankFailed(b, acq, 'merger');
  invalidateMetrics(b);
  invalidateMetrics(acq);
}

// ============================================================================ failure

export function failureOptions(g: Genesis, b: Bank, kind: 'insolvency' | 'liquidity' = 'insolvency'): ActionOption<FailureAction>[] {
  const eco = g.eco;
  const others = eco.aliveBanks().filter((x) => x !== b);
  const m = metrics(eco, b);
  const need = Math.max(25_000, -m.equity + (eco.policy.capitalRequirement + 0.03) * m.rwa);
  const ela: ActionOption<FailureAction>[] =
    kind === 'liquidity'
      ? [
          {
            id: 'ela',
            label: 'Lend it the cash (emergency liquidity)',
            effect: `The Reserve Bank lends ${b.short} whatever reserves it needs for a year, against all of its loans, at a penalty rate. Its capital (${fmtMoney(m.equity)}) is untouched; its debt to the Reserve Bank grows.`,
            disabled: m.equity <= 0 ? 'It is insolvent as well as out of cash: lending to it would only delay the losses.' : undefined,
          },
        ]
      : [];
  return [
    ...ela,
    {
      id: 'fail',
      label: 'Let it fail',
      effect: others.length
        ? `Close it. ${others.length > 1 ? 'The strongest remaining bank' : others[0].name} takes over its deposits and loans; deposit insurance covers depositors up to the limit.`
        : 'Close it. A public bridge bank takes over its deposits and loans; deposit insurance covers depositors up to the limit.',
    },
    { id: 'bailout', label: 'Bail it out', effect: `City Hall puts in ${fmtMoney(need)} of public money and the bank carries on.` },
    { id: 'forbear', label: 'Look the other way', effect: 'Let it keep operating for 3 months and hope earnings or recoveries rebuild capital. The Reserve Bank covers any cash shortfall.' },
  ];
}

export function applyFailure(g: Genesis, b: Bank, a: FailureAction, kind: 'insolvency' | 'liquidity'): string {
  const eco = g.eco;
  const m = metrics(eco, b);
  switch (a) {
    case 'fail':
    case 'acquire':
      g.allowFail.add(b.id);
      failBank(eco, b, kind);
      return `${b.name} was closed.`;
    case 'bailout': {
      const need = Math.max(25_000, -m.equity + (eco.policy.capitalRequirement + 0.03) * m.rwa);
      publicCapital(eco, b, need);
      b.stress *= 0.5;
      b.log(eco.day, `Bailed out with ${fmtMoney(need)} of public money`, 'bad');
      eco.headline(`Bailout: City Hall puts ${fmtMoney(need)} into ${b.name}`, 'alert', b.id, undefined, `bail-${b.id}`, 0);
      eco.event('bank_rescue', b.id, need, eco.treasury.id);
      return `Bailed out with ${fmtMoney(need)}.`;
    }
    case 'forbear':
      g.forbearUntil.set(b.id, eco.day + 90);
      g.elaUntil.set(b.id, eco.day + 90);
      return 'Allowed to keep operating for three months.';
    case 'ela': {
      g.elaUntil.set(b.id, eco.day + 360);
      b.cbLoanEmergency = true;
      b.log(eco.day, `Kept open with emergency liquidity from the Reserve Bank`, 'bad');
      eco.headline(`The Reserve Bank lends ${b.name} the cash it needs to stay open`, 'alert', b.id, undefined, `ela-${b.id}`, 0);
      void kind;
      return `The Reserve Bank lends ${b.short} what it needs, against its loans, for a year.`;
    }
  }
}

/** A public bridge bank is never closed: the deposit insurer puts in whatever capital it lacks. */
export function recapitaliseBridge(eco: Economy, b: Bank): number {
  const m = metrics(eco, b);
  const need = Math.max(10_000, (eco.policy.capitalRequirement + 0.04) * m.rwa - m.equity);
  eco.ledger.publicToBank('dif', b, need, 'resolution');
  b.paidIn += need;
  eco.dif.paidOutCum += need;
  if (eco.publicBalances.dif < 0) {
    const short = -eco.publicBalances.dif;
    eco.publicBalances.treasury -= short;
    eco.publicBalances.dif += short;
    eco.dif.borrowedFromTreasury += short;
  }
  if (b.reserves < 0) overnightSupport(eco, b);
  invalidateMetrics(b);
  b.log(eco.day, `The deposit insurer put in ${fmtMoney(need)} of new capital`, 'neutral');
  eco.headline(`The deposit insurer puts ${fmtMoney(need)} more into ${b.name}`, 'bad', b.id, undefined, `recap-${b.id}`, 60);
  return need;
}

// ============================================================================ charters

const NEW_BANK_STYLES: { personality: BankPersonality; blurb: string }[] = [
  {
    personality: {
      riskAppetite: 0.6,
      capitalBuffer: 0.02,
      liquidityBuffer: 0.03,
      focus: { business: 0.2, mortgage: 0.7, consumer: 0.1 },
      securitize: 0.7,
      wholesale: 0.5,
      growth: 0.18,
      payout: 0.6,
      duration: 0.4,
      depositBeta: 0.65,
      blurb: 'A mortgage lender from the city: grows fast, pays well for deposits, likes to sell its loans on.',
    },
    blurb: 'wants to write mortgages for the growing town',
  },
  {
    personality: {
      riskAppetite: 0.4,
      capitalBuffer: 0.03,
      liquidityBuffer: 0.05,
      focus: { business: 0.65, mortgage: 0.25, consumer: 0.1 },
      securitize: 0.15,
      wholesale: 0.3,
      growth: 0.1,
      payout: 0.5,
      duration: 0.5,
      depositBeta: 0.5,
      blurb: "A businessman's bank: lends to local firms for premises and equipment.",
    },
    blurb: 'wants to lend to local businesses',
  },
  {
    personality: {
      riskAppetite: 0.25,
      capitalBuffer: 0.05,
      liquidityBuffer: 0.08,
      focus: { business: 0.4, mortgage: 0.5, consumer: 0.1 },
      securitize: 0.05,
      wholesale: 0.1,
      growth: 0.06,
      payout: 0.4,
      duration: 0.3,
      depositBeta: 0.4,
      blurb: 'A cautious savings bank: thick buffers, slow growth.',
    },
    blurb: 'wants to offer a safe home for savings',
  },
];

export function draftCharter(g: Genesis): Situation['charter'] | null {
  const eco = g.eco;
  const origin = FIRST_BANK_ORIGIN + eco.banks.length;
  if (origin >= MAX_ORIGINS) return null;
  const used = new Set(eco.banks.map((x) => x.lotId));
  const lots = eco.city.lots.filter((l) => l.reserved === 'bank' && !used.has(l.id) && !eco.lotUse.has(l.id));
  if (!lots.length) return null;
  const c = eco.city.lots[eco.cb.lotId];
  const lot = lots.reduce((a, l) => (Math.hypot(l.x - c.x, l.y - c.y) < Math.hypot(a.x - c.x, a.y - c.y) ? l : a));
  const ident = bankIdentity(eco.rng, eco.banks.map((x) => x.name));
  const style = eco.rng.int(0, NEW_BANK_STYLES.length - 1);
  let assets = 0;
  for (const x of eco.aliveBanks()) assets += metrics(eco, x).assets;
  const capital = Math.max(200_000, Math.round((assets * 0.06) / 10_000) * 10_000);
  return { name: ident.name, short: ident.short, color: ident.color, capital, blurb: NEW_BANK_STYLES[style].blurb, lotId: lot.id, personality: style };
}

export function charterBank(g: Genesis, c: NonNullable<Situation['charter']>, capital: number): Bank {
  const eco = g.eco;
  const style = NEW_BANK_STYLES[c.personality] ?? NEW_BANK_STYLES[0];
  const pers = { ...style.personality, focus: { ...style.personality.focus } };
  const b = new Bank(eco.newId(), c.name, c.short, c.color, FIRST_BANK_ORIGIN + eco.banks.length, c.lotId, pers, eco.day);
  b.depositRate = eco.policy.policyRate * pers.depositBeta;
  b.fear = 0.3;
  eco.register(b);
  eco.banks.push(b);
  eco.lotUse.set(c.lotId, { type: 'bank', id: b.id });
  eco.ledger.outsideToBank(b, capital, 'capital', eco.world.id);
  b.paidIn = capital;
  b.budget = capital * 1.5;
  setStandards(eco, b);
  eco.lastCharterDay = eco.day;
  b.log(eco.day, `Opened with ${fmtMoney(capital)} of capital from investors across the river`, 'good');
  eco.headline(`A new bank opens: ${b.name}, with ${fmtMoney(capital)} of capital`, 'good', b.id, undefined, `charter-${b.id}`, 0);
  g.onBankOpened(b);
  return b;
}

/** When the last bank fails, the deposit insurer opens a public bridge bank to take over its book. */
export function bridgeBank(g: Genesis, failed: Bank): Bank | null {
  const eco = g.eco;
  const origin = FIRST_BANK_ORIGIN + eco.banks.length;
  if (origin >= MAX_ORIGINS) return null;
  const used = new Set(eco.banks.map((x) => x.lotId));
  const lot = eco.city.lots.find((l) => l.reserved === 'bank' && !used.has(l.id) && !eco.lotUse.has(l.id));
  const pers: BankPersonality = {
    riskAppetite: 0.2,
    capitalBuffer: 0.05,
    liquidityBuffer: 0.08,
    focus: { business: 0.45, mortgage: 0.45, consumer: 0.1 },
    securitize: 0.05,
    wholesale: 0.05,
    growth: 0.04,
    payout: 0.2,
    duration: 0.3,
    depositBeta: 0.4,
    blurb: 'A public bridge bank set up by the deposit insurer to keep accounts open after a failure.',
  };
  const b = new Bank(eco.newId(), `${eco.city.name} Bridge Bank`, 'BRIDGE', '#6f8fa8', origin, lot ? lot.id : failed.lotId, pers, eco.day);
  b.fear = 0.5;
  b.depositRate = eco.policy.policyRate * 0.3;
  eco.register(b);
  eco.banks.push(b);
  if (lot) eco.lotUse.set(lot.id, { type: 'bank', id: b.id });
  else eco.lotUse.set(failed.lotId, { type: 'bank', id: b.id });
  const capital = 50_000;
  eco.ledger.publicToBank('dif', b, capital, 'resolution');
  b.paidIn = capital;
  if (eco.publicBalances.dif < 0) {
    const need = -eco.publicBalances.dif;
    eco.publicBalances.treasury -= need;
    eco.publicBalances.dif += need;
    eco.dif.borrowedFromTreasury += need;
  }
  setStandards(eco, b);
  // a public bank can always borrow from the Reserve Bank against its loans
  g.elaUntil.set(b.id, eco.day + 720);
  g.bridges.add(b.id);
  b.log(eco.day, `Opened by the deposit insurer to take over ${failed.name}'s accounts`, 'neutral');
  g.onBankOpened(b, true);
  void CFG;
  return b;
}

export function applyCharter(g: Genesis, sit: Situation, a: CharterAction): string {
  const c = sit.charter!;
  if (a === 'reject') {
    g.nextCharterDay = g.eco.day + 720;
    return 'Charter refused.';
  }
  const capital = a === 'morecapital' ? Math.round((c.capital * 1.5) / 10_000) * 10_000 : c.capital;
  const b = charterBank(g, c, capital);
  g.nextCharterDay = g.eco.day + 1080;
  return `${b.name} opened with ${fmtMoney(capital)} of capital.`;
}
