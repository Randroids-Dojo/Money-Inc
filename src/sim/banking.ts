// Bank behaviour: underwriting, origination (money creation), loan servicing (money
// destruction), defaults and loss recognition, liquidity management, balance-sheet
// engineering (securitisation, loan sales, capital raising, wholesale funding), deposit runs
// and monthly strategy reviews.

import { CFG, DAYS_PER_MONTH, DAYS_PER_YEAR } from './config';
import type { Economy } from './economy';
import { Bank, RISK_WEIGHTS, netIncome, newPL, type Wholesale } from './bank';
import { Loan, annuityPayment, type Collateral } from './loan';
import { MbsPool, type Firm, type Household } from './agents';
import type { LoanKind, LoanPurpose } from './types';
import { INSURANCE_LIMITS } from './types';
import { fundCashTarget } from './fund';
import { bondPrice, mbsPrice } from './markets';
import { fmtMoney, pct } from './format';
import { closeFirm } from './firms';
import { foreclosureEviction } from './housing';
import { failBank } from './resolution';

// ============================================================================ metrics

export interface BankMetrics {
  reserves: number;
  loansGross: number;
  provisions: number;
  loansNet: number;
  mortgages: number;
  business: number;
  consumer: number;
  development: number;
  bills: number;
  bonds: number;
  mbs: number;
  interbank: number;
  reo: number;
  assets: number;
  deposits: number;
  wholesale: number;
  cbLoan: number;
  bondsIssued: number;
  liabilities: number;
  equity: number;
  rwa: number;
  capitalRatio: number;
  liquid: number;
  liquidityRatio: number;
  npl: number;
  nplRatio: number;
  late: number;
  unrealized: number;
  /** how much more lending (in RWA terms) fits before hitting the bank's own target */
  headroomRWA: number;
}

export function metrics(eco: Economy, b: Bank): BankMetrics {
  let mortgages = 0,
    business = 0,
    consumer = 0,
    development = 0,
    provisions = 0,
    npl = 0,
    late = 0;
  for (const l of b.loans) {
    if (!l.active) continue;
    if (l.kind === 'mortgage') mortgages += l.balance;
    else if (l.kind === 'business') business += l.balance;
    else if (l.kind === 'consumer') consumer += l.balance;
    else development += l.balance;
    provisions += l.provision;
    if (l.status === 'nonperforming') npl += l.balance;
    if (l.status !== 'performing') late += l.balance;
  }
  const loansGross = mortgages + business + consumer + development;
  const loansNet = loansGross - provisions;
  const bp = bondPrice(b.bondCoupon, eco.market.bondYield);
  const bonds = b.bondPar * bp;
  let mbs = 0,
    mbsBook = 0;
  for (const [pid, h] of b.mbs) {
    const p = eco.pools.get(pid);
    if (!p) continue;
    mbs += h.frac * p.balance * p.price;
    mbsBook += h.frac * p.balance * h.bookRatio;
  }
  const interbank = b.interbankAssets();
  const reo = b.reoValue();
  const assets = b.reserves + loansNet + b.bills + bonds + mbs + interbank + reo;
  const wholesale = b.wholesaleFunding();
  const liabilities = b.deposits + wholesale + b.cbLoan + b.bondsIssued;
  const equity = assets - liabilities;
  const rw = RISK_WEIGHTS;
  const rwa =
    mortgages * rw.mortgage +
    business * rw.business +
    consumer * rw.consumer +
    development * rw.development -
    provisions * 0.8 +
    mbs * rw.mbs +
    interbank * rw.interbank +
    reo * rw.reo;
  const rwaSafe = Math.max(1, rwa);
  const capitalRatio = equity / rwaSafe;
  const liquid = Math.max(0, b.reserves) + b.bills + bonds * 0.95;
  const liquidityRatio = b.deposits > 0 ? liquid / b.deposits : 1;
  const target = eco.policy.capitalRequirement + b.personality.capitalBuffer;
  const headroomRWA = equity / target - rwa;
  return {
    reserves: b.reserves,
    loansGross,
    provisions,
    loansNet,
    mortgages,
    business,
    consumer,
    development,
    bills: b.bills,
    bonds,
    mbs,
    interbank,
    reo,
    assets,
    deposits: b.deposits,
    wholesale,
    cbLoan: b.cbLoan,
    bondsIssued: b.bondsIssued,
    liabilities,
    equity,
    rwa: rwaSafe,
    capitalRatio,
    liquid,
    liquidityRatio,
    npl,
    nplRatio: loansGross > 0 ? npl / loansGross : 0,
    late,
    unrealized: bonds - b.bondBook + (mbs - mbsBook),
    headroomRWA,
  };
}

/** Accounting reconciliation used by tests and dev builds. */
export function checkBooks(eco: Economy): string[] {
  const errs: string[] = [];
  const tol = (x: number) => 1 + Math.abs(x) * 1e-7;
  // deposits == sum of accounts
  const sums = new Map<number, number>();
  const accts = allAccounts(eco);
  for (const a of accts) {
    sums.set(a.bank.id, (sums.get(a.bank.id) ?? 0) + a.balance);
    if (a.balance < -0.01) errs.push(`negative balance ${a.balance.toFixed(2)} for agent ${a.ownerId}`);
    let o = 0;
    for (let k = 0; k < a.origin.length; k++) o += a.origin[k];
    if (Math.abs(o - a.balance) > tol(a.balance) * 10) errs.push(`origin drift for ${a.ownerId}: ${o} vs ${a.balance}`);
  }
  for (const b of eco.banks) {
    const s = sums.get(b.id) ?? 0;
    if (Math.abs(s - b.deposits) > tol(s)) errs.push(`bank ${b.short} deposits ${b.deposits.toFixed(2)} != accounts ${s.toFixed(2)}`);
    const m = metrics(eco, b);
    const recon = b.paidIn + b.retained + netIncome(b.pl) + m.unrealized;
    if (Math.abs(m.equity - recon) > tol(m.assets) * 100)
      errs.push(`bank ${b.short} equity ${m.equity.toFixed(2)} != paidIn+retained+unrealized ${recon.toFixed(2)}`);
    if (!b.alive && Math.abs(m.assets) > 1) errs.push(`failed bank ${b.short} still has assets ${m.assets}`);
  }
  // loans referenced by holders
  for (const l of eco.loans.values()) {
    if (!l.active) continue;
    if (l.holder.kind === 'bank') {
      const b = eco.bank(l.holder.id);
      if (!b || !b.loans.includes(l)) errs.push(`loan ${l.id} holder bank missing it`);
    }
  }
  return errs;
}

export function allAccounts(eco: Economy) {
  const out = [];
  for (const h of eco.households) if (!h.departed || h.acct.balance > 0) out.push(h.acct);
  for (const f of eco.firms) out.push(f.acct);
  out.push(eco.fund.acct, eco.world.acct);
  return out;
}

// ============================================================================ helpers

function policyRate(eco: Economy): number {
  return eco.policy.policyRate;
}

export function unitValue(eco: Economy, unitId: number): number {
  const u = eco.units[unitId];
  if (!u) return 0;
  return u.baseValue * u.quality * eco.market.hpi;
}

/** Current estimated value of collateral backing a loan. */
export function collateralNow(eco: Economy, l: Loan): number {
  const c = l.collateral;
  switch (c.kind) {
    case 'property':
      return c.ref !== undefined ? unitValue(eco, c.ref) : c.value;
    case 'business': {
      const f = c.ref !== undefined ? eco.firm(c.ref) : undefined;
      if (!f || f.status === 'closed') return 0;
      return f.K * eco.market.factoryPrice * eco.market.commercialIndex * 0.45;
    }
    case 'project': {
      // development loan: value of the units under construction / unsold
      const p = c.ref !== undefined ? eco.projects.get(c.ref) : undefined;
      if (p && p.status !== 'complete') return c.value * (0.3 + 0.6 * p.progress) * eco.market.hpi;
      let v = 0;
      const b = eco.firm(l.borrowerId);
      if (b) for (const u of eco.units) if (u.ownerId === b.id && u.listing) v += unitValue(eco, u.id);
      return v;
    }
    default:
      return 0;
  }
}

function riskWeight(kind: LoanKind): number {
  return RISK_WEIGHTS[kind];
}

function holderBankOf(eco: Economy, l: Loan): Bank | undefined {
  return l.holder.kind === 'bank' ? eco.bank(l.holder.id) : undefined;
}

// ============================================================================ underwriting

export interface LoanApp {
  borrower: Household | Firm;
  kind: LoanKind;
  purpose: LoanPurpose;
  amount: number;
  termMonths: number;
  amortizing: boolean;
  collateral: Collateral;
  /** household: gross monthly income; firm: current monthly operating cash flow */
  income: number;
  /** firm: additional monthly cash flow the project should generate */
  projected?: number;
  existingDebtService: number;
  existingDebt: number;
  /** description for the loan trail */
  what: string;
  /** owner equity share of the project (startups/expansions) */
  equityShare?: number;
}

export interface LoanOffer {
  bank: Bank;
  spread: number;
  rate: number;
  pd: number;
}

export interface LoanDecision {
  offer?: LoanOffer;
  reason?: string;
}

/** Cached per-day bank metrics to keep underwriting cheap. */
const metricCache = new WeakMap<Bank, { day: number; m: BankMetrics }>();
function cachedMetrics(eco: Economy, b: Bank): BankMetrics {
  const c = metricCache.get(b);
  if (c && c.day === eco.day) return c.m;
  const m = metrics(eco, b);
  metricCache.set(b, { day: eco.day, m });
  return m;
}
export function invalidateMetrics(b: Bank): void {
  metricCache.delete(b);
}

function macroRisk(eco: Economy): number {
  const u = eco.market.unemployment;
  return 1 + 5 * Math.max(0, u - CFG.naturalUnemployment) + 2 * eco.market.panic;
}

export function underwrite(eco: Economy, bank: Bank, app: LoanApp): LoanDecision {
  if (!bank.alive) return { reason: 'bank closed' };
  if (bank.stance === 'frozen' && app.purpose !== 'working_capital') return { reason: `${bank.short} has stopped lending` };
  const pers = bank.personality;
  const fear = bank.fear;
  const policy = policyRate(eco);
  const baseSpread = bank.spreads[app.kind];
  let pd = 0;
  let lgd = 0.6;
  const rate0 = policy + baseSpread;
  const pmt = app.amortizing ? annuityPayment(app.amount, rate0, app.termMonths) : (app.amount * rate0) / 12;
  const perception = (0.45 + 1.1 * fear) * macroRisk(eco);

  if (app.kind === 'mortgage') {
    const h = app.borrower as Household;
    if (!h.employed && app.purpose === 'home') return { reason: 'no job' };
    const income = Math.max(1, app.income);
    const dti = (app.existingDebtService + pmt) / income;
    const ltv = app.amount / Math.max(1, app.collateral.value);
    const maxLTV = bank.maxLTV - (app.purpose === 'investment_property' ? 0.12 : 0);
    const maxDTI = bank.maxDTI + (app.purpose === 'investment_property' ? 0.05 : 0);
    if (ltv > maxLTV) return { reason: `loan-to-value ${pct(ltv)} above ${bank.short}'s limit ${pct(maxLTV)}` };
    if (dti > maxDTI) return { reason: `debt payments would take ${pct(dti)} of income` };
    pd = 0.004 + 0.07 * Math.max(0, dti - 0.22) + 0.06 * Math.max(0, ltv - 0.7);
    if (h.missedTotal > 0) pd += 0.01;
    if (eco.day - h.lastDefaultDay < 3 * DAYS_PER_YEAR) pd += 0.08;
    if (app.purpose === 'investment_property') pd *= 1.3;
    lgd = Math.max(0.05, 1 - (app.collateral.value * CFG.foreclosureRecovery) / app.amount);
  } else if (app.kind === 'consumer') {
    const h = app.borrower as Household;
    if (!h.employed) return { reason: 'no job' };
    const dti = (app.existingDebtService + pmt) / Math.max(1, app.income);
    if (dti > bank.maxDTI + 0.07) return { reason: `debt payments would take ${pct(dti)} of income` };
    pd = 0.02 + 0.12 * Math.max(0, dti - 0.25);
    if (h.missedTotal > 0) pd += 0.03;
    if (eco.day - h.lastDefaultDay < 3 * DAYS_PER_YEAR) pd += 0.15;
    lgd = 0.9;
  } else if (app.kind === 'business') {
    const f = app.borrower as Firm;
    const haircut = Math.max(0.1, 0.55 - 0.35 * fear + 0.25 * pers.riskAppetite);
    const cf = app.income + haircut * (app.projected ?? 0);
    const ds = app.existingDebtService + pmt;
    const dscr = ds > 0 ? cf / ds : 9;
    const minDSCR = bank.minDSCR - (app.purpose === 'working_capital' ? 0.25 : 0);
    if (app.purpose !== 'working_capital' && dscr < minDSCR) return { reason: `cash flow covers debt only ${dscr.toFixed(2)}x` };
    if (app.purpose === 'working_capital' && cf <= 0 && pers.riskAppetite < 0.6) return { reason: 'the business is losing money' };
    const kVal = f.K * eco.market.factoryPrice * eco.market.commercialIndex;
    const lev = (app.existingDebt + app.amount) / Math.max(1, kVal + app.collateral.value);
    pd = 0.012 + 0.08 * Math.max(0, 1.7 - dscr) + 0.05 * Math.max(0, lev - 0.6);
    if (app.purpose === 'startup') pd += 0.03 * (1.2 - (app.equityShare ?? 0.2));
    if (f.missed > 0) pd += 0.05;
    const sp = eco.market.sectorPressure[f.sector] ?? 0.85;
    if (sp < 0.7) pd += 0.03;
    lgd = Math.max(0.2, 1 - (0.45 * (kVal + app.collateral.value)) / Math.max(1, app.existingDebt + app.amount));
  } else {
    // development
    const saleValue = app.collateral.value * eco.market.hpi;
    const ltc = app.amount / Math.max(1, saleValue);
    if (ltc > bank.maxLTV - 0.1) return { reason: `development leverage ${pct(ltc)} too high` };
    pd = 0.02 + 0.4 * Math.max(0, ltc - 0.55) + 0.05 * Math.max(0, -eco.market.hpiExpect * 10);
    lgd = 0.35;
  }

  const pdSeen = pd * perception;
  if (pdSeen > bank.maxPD) return { reason: `${bank.short} judges default risk too high (${pct(pdSeen)})` };

  // balance-sheet capacity
  const m = cachedMetrics(eco, bank);
  const addRWA = app.amount * riskWeight(app.kind);
  const minRatio = eco.policy.capitalRequirement + pers.capitalBuffer * (0.25 + 0.9 * fear);
  if (m.equity / (m.rwa + addRWA) < minRatio) return { reason: `${bank.short} is short of capital` };
  const liqNeed = eco.policy.liquidityRequirement + pers.liquidityBuffer * 0.3;
  if ((m.liquid - 0.5 * app.amount) / Math.max(1, m.deposits + 0.5 * app.amount) < liqNeed && app.purpose !== 'working_capital')
    return { reason: `${bank.short} is short of liquidity` };
  if (bank.originatedThisMonth + app.amount > bank.budget && app.purpose !== 'working_capital')
    return { reason: `${bank.short} has used up this month's lending budget` };

  const riskPremium = pdSeen * lgd * 1.1;
  const spread = baseSpread + riskPremium + (app.purpose === 'startup' ? 0.01 : 0);
  return { offer: { bank, spread, rate: Math.max(0.005, policy + spread), pd: pdSeen } };
}

/**
 * The borrower shops for credit: their own bank first, then up to two others.
 * Returns the best offer (lowest rate), or the reason their own bank gave for refusing.
 */
export function shopForLoan(eco: Economy, app: LoanApp, maxRate = Infinity): LoanDecision {
  const own = app.borrower.acct.bank;
  const banks = eco.aliveBanks();
  const order = [own, ...eco.rng.shuffle(banks.filter((b) => b !== own)).slice(0, 2)].filter((b) => b.alive);
  let best: LoanOffer | undefined;
  let firstReason: string | undefined;
  for (const b of order) {
    const d = underwrite(eco, b, app);
    if (d.offer) {
      if (!best || d.offer.rate < best.rate) best = d.offer;
    } else if (!firstReason) firstReason = d.reason;
  }
  if (best && best.rate <= maxRate) return { offer: best };
  if (best) return { reason: `rate ${pct(best.rate)} too expensive` };
  eco.monthCounters.loansDenied++;
  for (const b of order) b.deniedThisMonth++;
  return { reason: firstReason ?? 'no bank would lend' };
}

/** Create a loan: the bank gains a loan asset, the borrower gains a brand-new deposit. */
export function originate(eco: Economy, offer: LoanOffer, app: LoanApp): Loan {
  const b = offer.bank;
  const loan = new Loan(
    eco.newId(),
    app.kind,
    app.purpose,
    b.id,
    app.borrower.id,
    app.amount,
    offer.spread,
    policyRate(eco),
    app.termMonths,
    app.amortizing,
    eco.day,
    (eco.dom + 1) % DAYS_PER_MONTH,
    app.collateral,
  );
  eco.loans.set(loan.id, loan);
  b.loans.push(loan);
  app.borrower.loans.push(loan);
  eco.ledger.bankPay(b, app.borrower.acct, app.amount, 'loan', loan.id);
  b.originatedThisMonth += app.amount;
  b.createdCum += app.amount;
  eco.monthCounters.newLoans++;
  eco.monthCounters.newLoanValue += app.amount;
  invalidateMetrics(b);
  loan.note(
    eco.day,
    `${b.name} created ${fmtMoney(app.amount)} of new deposit money for ${app.borrower.name}: ${app.what} (${pct(loan.rate, 1)})`,
    app.amount,
    b.id,
    'good',
  );
  eco.event('loan_approved', app.borrower.id, app.amount, b.id, app.what);
  return loan;
}

// ============================================================================ servicing

export function loanPaymentsDay(eco: Economy, dom: number): void {
  const due: Loan[] = [];
  for (const l of eco.loans.values()) if (l.active && l.dueDay === dom && l.day < eco.day) due.push(l);
  for (const l of due) serviceLoan(eco, l);
}

function borrowerOf(eco: Economy, l: Loan): Household | Firm | undefined {
  return eco.household(l.borrowerId) ?? eco.firm(l.borrowerId);
}

function serviceLoan(eco: Economy, l: Loan): void {
  const borrower = borrowerOf(eco, l);
  if (!borrower) return;
  l.rate = Math.max(0.005, policyRate(eco) + l.spread);
  const interest = l.interestDue();
  const balloon = !l.amortizing && l.monthsPaid + 1 >= l.termMonths;
  let principal = 0;
  if (l.amortizing) principal = Math.max(0, l.scheduledPayment() - interest);
  else if (balloon) principal = l.balance;
  // catch up missed principal
  if (l.missed > 0 && l.amortizing) principal = Math.min(l.balance, principal * (1 + l.missed));

  if (balloon && tryRollover(eco, l, borrower)) {
    principal = 0;
  }
  let due = interest + principal;
  if (borrower.acct.balance < due) raiseCash(eco, borrower, due - borrower.acct.balance, l);
  if (borrower.acct.balance >= due - 0.01) {
    due = Math.min(due, borrower.acct.balance);
    pay(eco, l, borrower, Math.min(interest, due), Math.max(0, due - interest));
    if (l.missed > 0) {
      l.note(eco.day, `Borrower caught up on missed payments`, undefined, undefined, 'good');
      l.missed = 0;
    }
    l.status = 'performing';
    l.monthsPaid++;
    if (l.monthsPaid === 1) l.note(eco.day, `First payment made (${fmtMoney(due)} / month)`);
    if (l.balance < 1) closeRepaid(eco, l, borrower);
    return;
  }
  // missed payment
  l.missed++;
  if (borrower.kind === 'household') borrower.missedTotal++;
  else borrower.missed++;
  const hb = holderBankOf(eco, l);
  if (hb && l.missed <= 2) {
    // interest accrues onto the balance (and is booked as income until the loan stops accruing)
    l.balance += interest;
    hb.pl.interestIncome += interest;
  }
  l.status = l.missed >= 3 ? 'nonperforming' : 'late';
  l.note(eco.day, `Missed payment (${l.missed} in a row)`, due, borrower.id, 'bad');
  if (borrower.kind === 'household') borrower.note(eco.day, `Missed a ${l.kind} payment`, 'bad');
  else borrower.note(eco.day, `Missed a loan payment to ${eco.nameOf(l.servicerId)}`, 'bad');
  if (l.missed >= 4) defaultLoan(eco, l);
}

/** Working-capital and development loans roll over if the bank is willing. */
function tryRollover(eco: Economy, l: Loan, borrower: Household | Firm): boolean {
  const bank = holderBankOf(eco, l) ?? eco.bank(l.servicerId);
  if (!bank || !bank.alive) return false;
  if (l.holder.kind !== 'bank') return false;
  if (bank.stance === 'frozen') {
    l.note(eco.day, `${bank.short} refused to roll over the loan: it is cutting credit`, undefined, bank.id, 'bad');
    return false;
  }
  if (borrower.kind === 'firm') {
    const f = borrower;
    const cf = f.last.revenue - f.last.wages - f.last.inputs - f.last.maintenance;
    const willing = cf > 0 || (bank.personality.riskAppetite > 0.6 && bank.fear < 0.4);
    if (!willing || l.missed > 0 || bank.fear > 0.75) {
      l.note(eco.day, `${bank.short} declined to renew the credit line`, undefined, bank.id, 'bad');
      return false;
    }
  } else if (l.missed > 0 || bank.fear > 0.75) return false;
  l.termMonths += 12;
  l.note(eco.day, `${bank.short} renewed the loan for another year`, undefined, bank.id);
  return true;
}

/** Borrowers short of cash try to find it before missing a payment. */
function raiseCash(eco: Economy, b: Household | Firm, need: number, forLoan: Loan): void {
  if (b.kind === 'household') {
    // sell fund units
    if (b.fundUnits > 0) {
      const nav = eco.fund.nav;
      const units = Math.min(b.fundUnits, (need * 1.05) / nav);
      redeemFund(eco, b, units);
    }
    return;
  }
  // firms ask for a working capital loan (not to refinance a working-capital loan itself)
  if (forLoan.purpose === 'working_capital') return;
  requestWorkingCapital(eco, b, need * 1.5);
}

export function redeemFund(eco: Economy, h: Household, units: number): number {
  if (units <= 0) return 0;
  const f = eco.fund;
  const amount = Math.min(units * f.nav, f.acct.balance);
  if (amount <= 0) return 0;
  const u = amount / f.nav;
  h.fundUnits -= u;
  f.units -= u;
  eco.ledger.transfer(f.acct, h.acct, amount, 'fund');
  return amount;
}

export function requestWorkingCapital(eco: Economy, f: Firm, amount: number): Loan | null {
  if (f.status !== 'open') return null;
  const cf = f.last.revenue - f.last.wages - f.last.inputs - f.last.maintenance;
  const app: LoanApp = {
    borrower: f,
    kind: 'business',
    purpose: 'working_capital',
    amount: Math.max(5000, Math.round(amount / 1000) * 1000),
    termMonths: 12,
    amortizing: false,
    collateral: { kind: 'business', ref: f.id, value: 0 },
    income: cf,
    existingDebtService: f.debtService(),
    existingDebt: f.debt(),
    what: 'a working-capital line to cover payroll and bills',
  };
  const d = shopForLoan(eco, app);
  if (!d.offer) {
    f.denials++;
    f.lastDenialReason = d.reason ?? '';
    f.note(eco.day, `Working-capital loan refused: ${d.reason}`, 'bad');
    eco.event('loan_denied', f.id, app.amount, f.acct.bank.id, d.reason);
    return null;
  }
  const loan = originate(eco, d.offer, app);
  loan.spend(f.id, app.amount, 'payroll & bills');
  f.note(eco.day, `Borrowed ${fmtMoney(app.amount)} working capital from ${d.offer.bank.name}`, 'neutral', app.amount, d.offer.bank.id);
  return loan;
}

/** Route a payment to whoever holds the loan. */
function pay(eco: Economy, l: Loan, borrower: Household | Firm, interest: number, principal: number): void {
  const acct = borrower.acct;
  principal = Math.min(principal, l.balance);
  const h = l.holder;
  if (h.kind === 'bank') {
    const bank = eco.bank(h.id)!;
    const i = eco.ledger.payBank(acct, bank, interest, 'interest', l.id);
    bank.pl.interestIncome += i;
    const p = eco.ledger.payBank(acct, bank, principal, 'principal', l.id);
    l.balance -= p;
    bank.destroyedCum += p;
    l.interestPaid += i;
    l.principalPaid += p;
  } else if (h.kind === 'pool') {
    const pool = eco.pools.get(h.id)!;
    const servicer = eco.bank(l.servicerId);
    let intLeft = interest;
    if (servicer && servicer.alive) {
      const fee = Math.min(intLeft, (l.balance * CFG.servicingFee) / 12);
      const fp = eco.ledger.payBank(acct, servicer, fee, 'interest', l.id);
      servicer.pl.fees += fp;
      intLeft -= fp;
    }
    distributeToPool(eco, pool, acct, intLeft, principal, l.id);
    l.balance -= principal;
    pool.balance = Math.max(0, pool.balance - principal);
    l.interestPaid += interest;
    l.principalPaid += principal;
  } else {
    const f = eco.fund;
    f.incomeMonth += eco.ledger.transfer(acct, f.acct, interest, 'interest', l.id);
    eco.ledger.transfer(acct, f.acct, principal, 'principal', l.id);
    l.balance -= principal;
    l.interestPaid += interest;
    l.principalPaid += principal;
  }
  if (borrower.kind === 'firm') borrower.m.interest += interest;
}

/** Pass borrower cash through an MBS pool to its investors. */
function distributeToPool(
  eco: Economy,
  pool: MbsPool,
  acct: Household['acct'],
  interest: number,
  principal: number,
  loanId: number,
): void {
  // holders: banks, the fund, the central bank
  for (const b of eco.banks) {
    const hd = b.mbs.get(pool.id);
    if (!hd || hd.frac <= 0) continue;
    const i = eco.ledger.payBank(acct, b, interest * hd.frac, 'interest', loanId);
    b.pl.interestIncome += i;
    const p = eco.ledger.payBank(acct, b, principal * hd.frac, 'principal', loanId);
    b.pl.securitiesGains += p * (1 - hd.bookRatio);
  }
  const fh = eco.fund.mbs.get(pool.id);
  if (fh && fh.frac > 0) {
    eco.fund.incomeMonth += eco.ledger.transfer(acct, eco.fund.acct, interest * fh.frac, 'interest', loanId);
    eco.ledger.transfer(acct, eco.fund.acct, principal * fh.frac, 'principal', loanId);
  }
  const ch = eco.cb.mbs.get(pool.id);
  if (ch && ch.frac > 0) {
    const i = eco.ledger.payPublic(acct, 'cb', interest * ch.frac, 'interest');
    const p = eco.ledger.payPublic(acct, 'cb', principal * ch.frac, 'principal');
    eco.cb.retained += i + p * (1 - ch.bookRatio);
  }
}

/** A repaid loan leaves the holder bank's books; any provision held against it is released. */
export function releaseFromBank(eco: Economy, l: Loan): void {
  const hb = holderBankOf(eco, l);
  if (!hb) {
    l.provision = 0;
    return;
  }
  if (l.provision) {
    hb.pl.provisions -= l.provision;
    l.provision = 0;
  }
  hb.loans = hb.loans.filter((x) => x !== l);
  invalidateMetrics(hb);
}

function closeRepaid(eco: Economy, l: Loan, borrower: Household | Firm): void {
  l.balance = 0;
  l.status = 'repaid';
  l.closedDay = eco.day;
  l.note(eco.day, `Repaid in full. Interest paid: ${fmtMoney(l.interestPaid)}. The deposits created at origination have been destroyed.`, undefined, undefined, 'good');
  borrower.loans = borrower.loans.filter((x) => x !== l);
  if (l.collateral.kind === 'property' && l.collateral.ref !== undefined) {
    const u = eco.units[l.collateral.ref];
    if (u && u.mortgage === l) u.mortgage = null;
  }
  releaseFromBank(eco, l);
  if (l.holder.kind === 'pool') eco.pools.get(l.holder.id)?.recompute();
}

/** Early payoff (e.g. when a mortgaged home is sold). Returns amount paid. */
export function payoffLoan(eco: Economy, l: Loan, payer: Household | Firm): number {
  if (!l.active) return 0;
  const bal = l.balance;
  if (payer.acct.balance < bal - 0.01) return 0;
  const interest = 0;
  pay(eco, l, payer, interest, bal);
  if (l.missed > 0) l.missed = 0;
  l.status = 'performing';
  closeRepaid(eco, l, payer);
  return bal;
}

/**
 * A mortgaged home is sold for less than the loan: the lender takes the sale proceeds
 * and writes off the remainder (a "short sale").
 */
export function settleShortSale(eco: Economy, l: Loan, seller: Household | Firm): void {
  if (!l.active) return;
  const avail = Math.min(seller.acct.balance, l.balance);
  if (avail > 0) pay(eco, l, seller, 0, avail);
  const loss = l.balance;
  if (l.holder.kind === 'bank') {
    const bank = eco.bank(l.holder.id)!;
    bank.pl.creditLosses += loss - l.provision;
    bank.lossesCum += loss;
    bank.loans = bank.loans.filter((x) => x !== l);
    invalidateMetrics(bank);
  } else if (l.holder.kind === 'pool') {
    const pool = eco.pools.get(l.holder.id)!;
    writeDownPool(eco, pool, loss);
    pool.lossesCum += loss;
  }
  l.note(eco.day, `Short sale: the home sold for less than the loan; ${fmtMoney(loss)} written off`, loss, seller.id, 'bad');
  l.balance = 0;
  l.provision = 0;
  l.lossAmount = loss;
  l.status = 'defaulted';
  l.closedDay = eco.day;
  if (l.holder.kind === 'pool') eco.pools.get(l.holder.id)?.recompute();
  seller.loans = seller.loans.filter((x) => x !== l);
  if (seller.kind === 'household') {
    seller.defaults++;
    seller.lastDefaultDay = eco.day;
  }
  if (l.collateral.kind === 'property' && l.collateral.ref !== undefined) {
    const u = eco.units[l.collateral.ref];
    if (u && u.mortgage === l) u.mortgage = null;
  }
  eco.monthCounters.defaults++;
  eco.monthCounters.defaultValue += loss;
  eco.event('default', seller.id, loss, l.holder.kind === 'bank' ? l.holder.id : eco.fund.id);
}

// ============================================================================ defaults

/** Recognise a default: the holder takes the loss, collateral is seized. */
export function defaultLoan(eco: Economy, l: Loan): void {
  if (!l.active) return;
  const borrower = borrowerOf(eco, l);
  const servicer = eco.bank(l.servicerId);
  const bal = l.balance;
  let recovery = 0;
  let seizedUnits: number[] = [];

  if (l.collateral.kind === 'property' && l.collateral.ref !== undefined) {
    const u = eco.units[l.collateral.ref];
    recovery = Math.min(bal, unitValue(eco, u.id) * CFG.foreclosureRecovery);
    seizedUnits = [u.id];
  } else if (l.collateral.kind === 'project') {
    const b = eco.firm(l.borrowerId);
    let v = 0;
    if (b) {
      for (const u of eco.units) {
        if (u.ownerId === b.id) {
          seizedUnits.push(u.id);
          v += unitValue(eco, u.id) * CFG.foreclosureRecovery * (u.building ? 0.5 : 1);
        }
      }
    }
    recovery = Math.min(bal, v);
  }
  // cash sweep for firms
  let cashSwept = 0;
  if (borrower && borrower.kind === 'firm' && borrower.acct.balance > 0 && l.holder.kind === 'bank') {
    const bank = eco.bank(l.holder.id)!;
    cashSwept = eco.ledger.payBank(borrower.acct, bank, Math.min(borrower.acct.balance, bal), 'principal', l.id);
  }
  const remaining = bal - cashSwept;
  recovery = Math.min(recovery, remaining);
  const loss = Math.max(0, remaining - recovery);

  // --- the holder's side
  if (l.holder.kind === 'bank') {
    const bank = eco.bank(l.holder.id)!;
    // loan asset leaves; REO (collateral) enters at recovery value
    bank.pl.creditLosses += loss - l.provision;
    bank.lossesCum += loss;
    if (seizedUnits.length && recovery > 0) {
      const each = recovery / seizedUnits.length;
      for (const uid of seizedUnits) takeUnit(eco, bank, uid, each);
    } else if (recovery > 0) {
      // nothing to seize after all
      bank.pl.creditLosses += recovery;
      bank.lossesCum += recovery;
    }
    bank.loans = bank.loans.filter((x) => x !== l);
    invalidateMetrics(bank);
    l.note(eco.day, `DEFAULT: ${bank.name} wrote off ${fmtMoney(loss)}${recovery > 0 ? `, took collateral worth ${fmtMoney(recovery)}` : ''}${cashSwept > 0 ? `, seized ${fmtMoney(cashSwept)} cash` : ''}`, loss, bank.id, 'bad');
  } else {
    // pool or fund: the servicer buys the collateral at its recovery value, investors bear the loss
    if (servicer && servicer.alive && seizedUnits.length && recovery > 0) {
      const each = recovery / seizedUnits.length;
      for (const uid of seizedUnits) takeUnit(eco, servicer, uid, each);
      passRecovery(eco, l, servicer, recovery);
    } else if (seizedUnits.length) {
      recovery = 0;
    }
    if (l.holder.kind === 'pool') {
      const pool = eco.pools.get(l.holder.id)!;
      writeDownPool(eco, pool, loss);
      pool.lossesCum += loss;
    }
    // fund-held whole loans: the loss simply lowers the fund's NAV
    l.note(eco.day, `DEFAULT: investors in ${l.holder.kind === 'pool' ? eco.pools.get(l.holder.id)!.name : eco.fund.name} lost ${fmtMoney(loss)}`, loss, l.holder.kind === 'fund' ? eco.fund.id : undefined, 'bad');
  }
  l.balance = 0;
  l.provision = 0;
  l.lossAmount = loss;
  l.recovered = recovery + cashSwept;
  l.status = 'defaulted';
  l.closedDay = eco.day;
  if (l.holder.kind === 'pool') eco.pools.get(l.holder.id)?.recompute();
  eco.monthCounters.defaults++;
  eco.monthCounters.defaultValue += bal;

  if (borrower) {
    borrower.loans = borrower.loans.filter((x) => x !== l);
    if (borrower.kind === 'household') {
      borrower.defaults++;
      borrower.lastDefaultDay = eco.day;
      borrower.note(eco.day, `Defaulted on a ${l.kind} loan (${fmtMoney(bal)})`, 'bad', bal, l.servicerId);
      for (const uid of seizedUnits) foreclosureEviction(eco, borrower, uid);
      if (seizedUnits.length) eco.event('foreclosure', borrower.id, bal, l.servicerId);
    } else {
      borrower.note(eco.day, `Defaulted on its loan from ${eco.nameOf(l.originatorId)}`, 'bad', bal, l.servicerId);
    }
    eco.event('default', borrower.id, loss, l.holder.kind === 'bank' ? l.holder.id : eco.fund.id);
    if (bal > 150_000) eco.headline(`${borrower.name} defaults on a ${fmtMoney(bal)} loan from ${eco.nameOf(l.originatorId)}`, 'bad', borrower.id, undefined, `def-${borrower.id}`, 60);
    if (borrower.kind === 'firm' && borrower.status === 'open') {
      closeFirm(eco, borrower, `defaulted on its ${fmtMoney(bal)} loan`);
    }
  }
}

/** A bank takes ownership of a foreclosed unit as REO at a carrying value. */
function takeUnit(eco: Economy, bank: Bank, unitId: number, carrying: number): void {
  const u = eco.units[unitId];
  const prevOwner = eco.household(u.ownerId);
  if (prevOwner) prevOwner.ownedUnits = prevOwner.ownedUnits.filter((x) => x !== unitId);
  u.ownerId = bank.id;
  u.mortgage = null;
  u.listing = null;
  u.forRent = false;
  bank.reo.set(unitId, carrying);
}

/** Servicer pays the recovery value of seized collateral to the investors holding the loan. */
function passRecovery(eco: Economy, l: Loan, servicer: Bank, amount: number): void {
  if (l.holder.kind === 'fund') {
    eco.ledger.bankPay(servicer, eco.fund.acct, amount, 'securitize', l.id);
    return;
  }
  const pool = eco.pools.get(l.holder.id)!;
  // principal recovered is distributed like a prepayment
  for (const b of eco.banks) {
    const hd = b.mbs.get(pool.id);
    if (!hd || hd.frac <= 0) continue;
    const amt = amount * hd.frac;
    if (b === servicer) {
      b.pl.securitiesGains += amt * (1 - hd.bookRatio);
      // internal: servicer pays itself - reserves unchanged, REO replaces MBS par
      continue;
    }
    eco.ledger.interbank(servicer, b, amt, 'securitize');
    b.pl.securitiesGains += amt * (1 - hd.bookRatio);
  }
  const fh = eco.fund.mbs.get(pool.id);
  if (fh && fh.frac > 0) eco.ledger.bankPay(servicer, eco.fund.acct, amount * fh.frac, 'securitize', l.id);
  const ch = eco.cb.mbs.get(pool.id);
  if (ch && ch.frac > 0) {
    eco.ledger.bankToPublic(servicer, 'cb', amount * ch.frac, 'securitize');
    eco.cb.retained += amount * ch.frac * (1 - ch.bookRatio);
  }
  // servicer's own reserves paid for the REO it now holds (for its own slice it simply swaps MBS for REO)
  const own = servicer.mbs.get(pool.id);
  if (own && own.frac > 0) {
    // the servicer's MBS par falls by amount*frac (via pool balance), REO rises by the same amount it already added
    // -> net effect handled: REO added for full recovery, but it only paid (1-frac)*amount in cash.
    // Book the difference as the value of its own claim: no P&L beyond the gain above.
  }
  // pool par falls by the recovered principal
}

/** Losses in an MBS pool reduce every holder's par. */
function writeDownPool(eco: Economy, pool: MbsPool, loss: number): void {
  if (loss <= 0) return;
  for (const b of eco.banks) {
    const hd = b.mbs.get(pool.id);
    if (!hd || hd.frac <= 0) continue;
    const l = loss * hd.frac * hd.bookRatio;
    b.pl.creditLosses += l;
    b.lossesCum += l;
    invalidateMetrics(b);
  }
  const ch = eco.cb.mbs.get(pool.id);
  if (ch && ch.frac > 0) eco.cb.retained -= loss * ch.frac * ch.bookRatio;
}

// ============================================================================ provisioning

function updateProvisions(eco: Economy, b: Bank): void {
  let delta = 0;
  for (const l of b.loans) {
    if (!l.active) continue;
    let target = 0;
    if (l.status !== 'performing') {
      const coll = l.collateral.kind === 'none' ? 0 : collateralNow(eco, l) * CFG.foreclosureRecovery;
      const lossGiven = Math.max(0, l.balance - coll);
      const prob = l.status === 'late' ? 0.3 : 0.75;
      target = prob * lossGiven;
    } else if (l.kind === 'mortgage') {
      // negative equity on performing mortgages earns a small general provision
      const coll = collateralNow(eco, l);
      if (coll < l.balance) target = 0.03 * (l.balance - coll);
    }
    delta += target - l.provision;
    l.provision = target;
  }
  b.pl.provisions += delta;
}

// ============================================================================ monthly interest & costs

export function monthlyInterest(eco: Economy): void {
  const policy = policyRate(eco);
  // deposit interest
  for (const a of allAccounts(eco)) {
    const b = a.bank;
    if (!b.alive || a.balance <= 0 || b.depositRate <= 0) continue;
    const i = (a.balance * b.depositRate) / 12;
    eco.ledger.bankPay(b, a, i, 'deposit_interest');
    b.pl.interestExpense += i;
  }
  for (const b of eco.banks) {
    if (!b.alive) continue;
    // interest on reserves
    if (b.reserves > 0) {
      const ior = (b.reserves * Math.max(0, policy - 0.0025)) / 12;
      eco.ledger.publicToBank('cb', b, ior, 'cb');
      eco.cb.retained -= ior;
      b.pl.interestIncome += ior;
    }
    // central bank borrowing
    if (b.cbLoan > 0) {
      const r = policy + (b.cbLoanEmergency ? 0.02 : 0.01);
      const i = (b.cbLoan * r) / 12;
      eco.ledger.bankToPublic(b, 'cb', i, 'cb');
      eco.cb.retained += i;
      b.pl.interestExpense += i;
    }
    // wholesale funding interest
    for (const w of b.wholesale) {
      const i = (w.amount * w.rate) / 12;
      if (w.lenderKind === 'bank') {
        const lender = eco.bank(w.lenderId)!;
        eco.ledger.interbank(b, lender, i, 'interest');
        lender.pl.interestIncome += i;
      } else {
        eco.ledger.bankPay(b, eco.fund.acct, i, 'interest');
        eco.fund.incomeMonth += i;
      }
      b.pl.interestExpense += i;
    }
    // bonds issued
    if (b.bondsIssued > 0) {
      const i = (b.bondsIssued * b.bondsIssuedCoupon) / 12;
      eco.ledger.bankPay(b, eco.fund.acct, i, 'interest');
      eco.fund.incomeMonth += i;
      b.pl.interestExpense += i;
    }
    // staff wages
    let wages = 0;
    for (const hid of b.employees) {
      const h = eco.household(hid);
      if (!h) continue;
      const tax = h.wage * CFG.taxRate;
      eco.ledger.bankToPublic(b, 'treasury', tax, 'tax');
      eco.treasury.taxesMonth += tax;
      eco.ledger.bankPay(b, h.acct, h.wage - tax, 'wage');
      h.incomeThisMonth += h.wage - tax;
      h.wagesThisMonth += h.wage;
      wages += h.wage;
    }
    // other operating costs are bought from local service firms
    const m = metrics(eco, b);
    const opex = (m.assets * CFG.opexPerAsset) / 12;
    const vendors = eco.firms.filter((f) => f.status === 'open' && f.sector === 'service');
    if (vendors.length) {
      const per = opex / Math.min(3, vendors.length);
      for (let i = 0; i < Math.min(3, vendors.length); i++) {
        const v = vendors[(eco.month * 7 + b.id + i) % vendors.length];
        eco.ledger.bankPay(b, v.acct, per, 'expense');
        v.m.revenue += per;
        v.m.units += per / Math.max(0.2, v.price);
      }
    }
    // deposit insurance premium
    const prem = (b.deposits * CFG.depositInsurancePremium) / 12;
    eco.ledger.bankToPublic(b, 'dif', prem, 'resolution');
    eco.dif.premiumsCum += prem;
    b.pl.opex += wages + opex + prem;
  }
}

// ============================================================================ daily bank operations

export function banksDaily(eco: Economy): void {
  updateStress(eco);
  runsDaily(eco);
  wholesaleMaturities(eco);
  for (const b of eco.banks) if (b.alive) liquidityEndOfDay(eco, b);
  for (const b of eco.banks) if (b.alive) checkSolvency(eco, b);
  // decay run counters
  for (const b of eco.banks) {
    b.runOutflow *= 0.85;
    b.cbStigma *= 0.995;
    if (b.runOutflow < 1000) b.runDays = 0;
  }
}

/** Public perception of each bank's trouble. */
function updateStress(eco: Economy): void {
  const req = eco.policy.capitalRequirement;
  for (const b of eco.banks) {
    if (!b.alive) continue;
    const m = cachedMetrics(eco, b);
    const capStress = clamp01((req + 0.03 - m.capitalRatio) / 0.05);
    const nplStress = clamp01((m.nplRatio - 0.02) / 0.08);
    const mtm = clamp01(-m.unrealized / Math.max(1, m.equity + Math.max(0, -m.unrealized)));
    const insolvent = m.equity <= 0 ? 1 : 0;
    const target = clamp01(
      0.5 * capStress + 0.3 * nplStress + 0.35 * mtm + 0.2 * b.cbStigma + 0.15 * eco.market.panic + insolvent,
    );
    b.stress += (target - b.stress) * (target > b.stress ? 0.25 : 0.05);
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Depositors flee banks they believe are in trouble. */
function runsDaily(eco: Economy): void {
  const banks = eco.aliveBanks();
  if (banks.length < 2) return;
  const safest = banks.reduce((a, b) => (b.stress < a.stress ? b : a));
  const limit = INSURANCE_LIMITS[eco.policy.depositInsurance];
  for (const b of banks) {
    if (b === safest || b.stress < 0.3 || b.stress - safest.stress < 0.15) continue;
    let outflow = 0;
    const accts = allAccounts(eco).filter((a) => a.bank === b && a.balance > 0);
    for (const a of accts) {
      const uninsured = Math.max(0, a.balance - limit);
      const insuredShare = a.balance > 0 ? 1 - uninsured / a.balance : 1;
      // each depositor has a personal panic threshold
      const theta = 0.3 + 0.45 * frac(a.ownerId * 0.61803);
      const excess = b.stress * CFG.runSensitivity - theta;
      if (excess <= 0) continue;
      const pUninsured = Math.min(0.5, excess * 1.5);
      const pInsured = Math.min(0.05, excess * 0.03);
      const p = pUninsured * (1 - insuredShare) + pInsured * insuredShare;
      if (eco.rng.chance(p)) {
        outflow += a.balance;
        eco.ledger.moveAccount(a, safest, 'run');
      }
    }
    if (outflow > 0) {
      b.runOutflow += outflow;
      b.runDays++;
      invalidateMetrics(b);
      invalidateMetrics(safest);
      eco.event('bank_run', b.id, outflow, safest.id);
      if (b.runOutflow > 0.04 * (b.deposits + b.runOutflow)) {
        if (b.status !== 'run') {
          b.status = 'run';
          b.log(eco.day, `Depositors are queuing to withdraw: ${fmtMoney(outflow)} left today`, 'bad');
          eco.headline(`Run on ${b.name}! Depositors pull ${fmtMoney(b.runOutflow)}`, 'alert', b.id, undefined, `run-${b.id}`, 45);
        }
      }
    }
  }
}

function frac(x: number): number {
  return x - Math.floor(x);
}

/** Wholesale loans that mature are rolled over only if the lender still trusts the borrower. */
function wholesaleMaturities(eco: Economy): void {
  for (const b of eco.banks) {
    if (!b.alive) continue;
    const matured = b.wholesale.filter((w) => w.maturity <= eco.day);
    for (const w of matured) {
      const lenderFear = w.lenderKind === 'fund' ? eco.fund.fear : eco.bank(w.lenderId)?.fear ?? 1;
      const trust = b.stress < 0.35 - 0.2 * lenderFear && eco.market.interbankStress < 0.6;
      const lenderOk = w.lenderKind === 'fund' ? eco.fund.acct.balance >= 0 : eco.bank(w.lenderId)?.alive;
      if (trust && lenderOk && b.personality.wholesale > 0.1) {
        w.maturity = eco.day + 30;
        w.rate = eco.market.interbankRate + 0.01 * b.stress + 0.003;
        continue;
      }
      repayWholesale(eco, b, w);
      if (!trust) b.log(eco.day, `${w.lenderKind === 'fund' ? eco.fund.name : eco.nameOf(w.lenderId)} refused to roll over ${fmtMoney(w.amount)} of funding`, 'bad');
    }
  }
}

function repayWholesale(eco: Economy, b: Bank, w: Wholesale): void {
  if (w.lenderKind === 'bank') {
    const lender = eco.bank(w.lenderId);
    if (lender) {
      eco.ledger.interbank(b, lender, w.amount, 'settle');
      lender.interbankLent = lender.interbankLent.filter((x) => x !== w);
      invalidateMetrics(lender);
    }
  } else {
    eco.ledger.bankPay(b, eco.fund.acct, w.amount, 'assetsale');
    eco.fund.repos = eco.fund.repos.filter((x) => x !== w);
  }
  b.wholesale = b.wholesale.filter((x) => x !== w);
  invalidateMetrics(b);
}

/** Try to borrow short-term funding from other banks, then from the fund. */
export function borrowWholesale(eco: Economy, b: Bank, amount: number, days: number): number {
  let got = 0;
  const rate = eco.market.interbankRate + 0.01 * b.stress + 0.003;
  for (const lender of eco.aliveBanks()) {
    if (lender === b || got >= amount) continue;
    const lm = cachedMetrics(eco, lender);
    const spare = lender.reserves - 0.03 * lender.deposits - Math.max(0, eco.policy.liquidityRequirement - lm.liquidityRatio + 0.02) * lender.deposits;
    if (spare <= 10_000) continue;
    if (b.stress > 0.45 - 0.3 * lender.fear || eco.market.interbankStress > 0.7) continue;
    const amt = Math.min(spare * 0.6, amount - got);
    const w: Wholesale = { id: eco.newId(), lenderId: lender.id, lenderKind: 'bank', borrowerId: b.id, amount: amt, rate, maturity: eco.day + days, started: eco.day };
    eco.ledger.interbank(lender, b, amt, 'settle');
    lender.interbankLent.push(w);
    b.wholesale.push(w);
    got += amt;
    invalidateMetrics(lender);
  }
  if (got < amount) {
    const f = eco.fund;
    const spare = f.acct.bank === b ? 0 : f.acct.balance - 0.04 * fundNavValue(eco);
    if (spare > 10_000 && b.stress < 0.45 - 0.3 * f.fear) {
      const amt = Math.min(spare * 0.5, amount - got);
      const w: Wholesale = { id: eco.newId(), lenderId: f.id, lenderKind: 'fund', borrowerId: b.id, amount: amt, rate: rate + 0.002, maturity: eco.day + days, started: eco.day };
      eco.ledger.payBank(f.acct, b, amt, 'assetsale');
      f.repos.push(w);
      b.wholesale.push(w);
      got += amt;
    }
  }
  if (got > 0) invalidateMetrics(b);
  return got;
}

function fundNavValue(eco: Economy): number {
  return eco.fund.nav * eco.fund.units;
}

/** Central bank lending facility, limited by eligible collateral. */
export function borrowFromCB(eco: Economy, b: Bank, amount: number): number {
  const mode = eco.policy.emergencyLiquidity;
  if (mode === 'none') return 0;
  const bp = bondPrice(b.bondCoupon, eco.market.bondYield);
  const securities = b.bills * 0.99 + b.bondPar * bp * 0.95;
  let collateral = securities;
  // Bagehot: lend to solvent banks against good collateral (with haircuts). The generous
  // regime takes almost anything and does not ask about solvency.
  const solvent = cachedMetrics(eco, b).equity > 0;
  if (mode === 'broad' || solvent) {
    const k = mode === 'broad' ? 1 : 0.8;
    for (const [pid, h] of b.mbs) {
      const p = eco.pools.get(pid);
      if (p) collateral += h.frac * p.balance * p.price * 0.8 * k;
    }
    for (const l of b.loans) {
      if (l.status === 'performing') collateral += l.balance * (l.kind === 'mortgage' ? 0.7 : 0.5) * k;
      else if (mode === 'broad' && l.status === 'late') collateral += l.balance * 0.3;
    }
  }
  const room = Math.max(0, collateral - b.cbLoan);
  const amt = Math.min(room, amount);
  if (amt <= 0) return 0;
  const wasEmergency = b.cbLoanEmergency;
  b.cbLoan += amt;
  b.reserves += amt; // new central bank reserves
  eco.cb.loansToBanks.set(b.id, b.cbLoan);
  const emergency = b.cbLoan > securities;
  b.cbLoanEmergency = b.cbLoanEmergency || emergency;
  eco.recordFlow(eco.cb.id, b.id, amt, 'cb');
  if (amt > 0.03 * b.deposits) {
    b.cbStigma = Math.min(1, b.cbStigma + 0.4);
    if (!wasEmergency && b.cbLoanEmergency) {
      b.log(eco.day, `Took ${fmtMoney(amt)} of EMERGENCY liquidity from the Reserve Bank`, 'bad');
      eco.headline(`${b.name} receives emergency liquidity from the Reserve Bank`, 'alert', b.id, undefined, `ela-${b.id}`, 60);
    } else {
      b.log(eco.day, `Borrowed ${fmtMoney(amt)} from the Reserve Bank's lending window`, 'bad');
      eco.headline(`${b.name} taps the Reserve Bank for ${fmtMoney(amt)}`, 'bad', b.id, undefined, `cbl-${b.id}`, 45);
    }
    eco.event('cb_loan', b.id, amt, eco.cb.id);
  }
  invalidateMetrics(b);
  return amt;
}

function repayCB(eco: Economy, b: Bank, amount: number): void {
  const amt = Math.min(amount, b.cbLoan);
  if (amt <= 0) return;
  b.cbLoan -= amt;
  b.reserves -= amt;
  if (b.cbLoan < 1) {
    b.cbLoan = 0;
    b.cbLoanEmergency = false;
  }
  eco.cb.loansToBanks.set(b.id, b.cbLoan);
  eco.recordFlow(b.id, eco.cb.id, amt, 'cb');
  invalidateMetrics(b);
}

/** Sell treasury bills for reserves: to the fund, other banks or (as a repo) the central bank. */
function sellBills(eco: Economy, b: Bank, amount: number): number {
  let got = 0;
  const f = eco.fund;
  const fundSpare = f.acct.bank === b ? 0 : f.acct.balance - 0.03 * fundNavValue(eco);
  if (fundSpare > 0) {
    const amt = Math.min(amount, b.bills, fundSpare);
    if (amt > 0) {
      eco.ledger.payBank(f.acct, b, amt, 'assetsale');
      b.bills -= amt;
      f.bills += amt;
      got += amt;
    }
  }
  for (const o of eco.aliveBanks()) {
    if (got >= amount || o === b) continue;
    const spare = o.reserves - 0.05 * o.deposits;
    if (spare <= 0) continue;
    const amt = Math.min(amount - got, b.bills, spare * 0.5);
    if (amt <= 0) continue;
    eco.ledger.interbank(o, b, amt, 'assetsale');
    b.bills -= amt;
    o.bills += amt;
    got += amt;
    invalidateMetrics(o);
  }
  if (got > 0) invalidateMetrics(b);
  return got;
}

/** End of day: make sure reserves are not negative; park surpluses. */
export function liquidityEndOfDay(eco: Economy, b: Bank): void {
  const floor = 0.01 * b.deposits;
  if (b.reserves < floor) {
    // each step is judged by the reserves it actually brings in (selling to one's own
    // depositors, for example, only shrinks deposits)
    if (b.reserves < floor) sellBills(eco, b, floor - b.reserves);
    if (b.reserves < floor) borrowWholesale(eco, b, floor - b.reserves, 7);
    if (b.reserves < floor) borrowFromCB(eco, b, floor - b.reserves);
    if (b.reserves < 0) {
      // Could not meet payments: a liquidity failure
      failBank(eco, b, 'liquidity');
      return;
    }
  } else {
    const surplus = b.reserves - (0.03 + b.personality.liquidityBuffer * 0.3) * b.deposits;
    if (surplus > 0 && b.cbLoan > 0) repayCB(eco, b, surplus);
    const s2 = b.reserves - (0.04 + b.personality.liquidityBuffer * 0.3) * b.deposits;
    if (s2 > 0 && b.wholesale.length) {
      const w = b.wholesale.reduce((a, x) => (x.maturity < a.maturity ? x : a));
      if (w.amount <= s2) repayWholesale(eco, b, w);
    }
  }
}

/** Final pass after month-end operations, which can move large sums. */
export function liquiditySweep(eco: Economy): void {
  for (const b of eco.banks) if (b.alive) liquidityEndOfDay(eco, b);
}

function checkSolvency(eco: Economy, b: Bank): void {
  if (eco.day % 5 !== b.id % 5) return;
  const m = metrics(eco, b);
  if (m.capitalRatio < CFG.resolutionThreshold || m.equity < 0) failBank(eco, b, 'insolvency');
}

// ============================================================================ balance-sheet engineering

/**
 * Would a sale that books `gain` (negative = loss) and removes `rwaOut` of risk-weighted assets
 * leave the bank no worse off? A sale is fine if it lifts the capital ratio, or keeps it above
 * the bank's own target. Fire sales that eat more capital than they free are refused.
 */
function saleHelpsCapital(eco: Economy, b: Bank, gain: number, rwaOut: number): boolean {
  const m = cachedMetrics(eco, b);
  const eq = m.equity + gain;
  const rwa = Math.max(1, m.rwa - rwaOut);
  const after = eq / rwa;
  const target = eco.policy.capitalRequirement + b.personality.capitalBuffer;
  return after >= m.capitalRatio - 1e-9 || after >= target;
}


/** Rough price investors would pay today for a fresh pool of this bank's mortgages. */
function expectedPoolPrice(eco: Economy, b: Bank): number {
  const probe = new MbsPool(-1, 'probe', b.id, eco.day);
  probe.loans = b.loans.filter((l) => l.kind === 'mortgage' && l.status === 'performing').slice(0, 12);
  probe.recompute();
  probe.originalBalance = probe.balance;
  return probe.balance > 0 ? mbsPrice(eco, probe) : 0;
}

/** Package performing mortgages into an MBS pool and sell it to investors. */
export function securitize(eco: Economy, b: Bank, target: number): number {
  const f = eco.fund;
  const fundBid = Math.max(0, f.acct.balance - 0.04 * fundNavValue(eco)) * (1 - f.fear) * 0.8;
  // other banks with an MBS appetite
  const bankBuyers: { bank: Bank; cap: number }[] = [];
  for (const o of eco.aliveBanks()) {
    if (o === b || o.personality.securitize < 0.3 || o.fear > 0.5) continue;
    const om = cachedMetrics(eco, o);
    const cap = Math.min(om.headroomRWA / RISK_WEIGHTS.mbs, o.reserves - 0.05 * o.deposits) * 0.3;
    if (cap > 20_000) bankBuyers.push({ bank: o, cap });
  }
  const demand = fundBid + bankBuyers.reduce((s, x) => s + x.cap, 0);
  if (demand < 50_000) return 0;
  const sellable = b.loans
    .filter((l) => l.kind === 'mortgage' && l.status === 'performing' && l.missed === 0 && eco.day - l.day > 60)
    .sort((a, c) => a.day - c.day);
  const size = Math.min(target, demand / 0.95);
  const chosen: Loan[] = [];
  let bal = 0;
  for (const l of sellable) {
    if (bal >= size) break;
    chosen.push(l);
    bal += l.balance;
  }
  if (bal < 50_000 || chosen.length < 3) return 0;
  const year = Math.floor(eco.day / DAYS_PER_YEAR) + 1;
  const pool = new MbsPool(eco.newId(), `${b.short} MBS Y${year}-${eco.poolSeq + 1}`, b.id, eco.day);
  pool.loans = chosen;
  pool.recompute();
  pool.originalBalance = pool.balance;
  const price = mbsPrice(eco, pool);
  let released = 0;
  for (const l of chosen) released += l.provision;
  // what the bank keeps (5% plus whatever investors will not take) stays on its books as MBS
  const keepFrac = Math.max(0.05, 1 - demand / (bal * price));
  if (!saleHelpsCapital(eco, b, bal * (price - 1) + released, bal * (RISK_WEIGHTS.mortgage - RISK_WEIGHTS.mbs * keepFrac * price))) return 0;
  eco.poolSeq++;
  let wr = 0;
  for (const l of chosen) {
    wr += l.spread * l.balance;
    l.provision = 0;
    l.holder = { kind: 'pool', id: pool.id };
  }
  pool.coupon = policyRate(eco) + wr / bal;
  pool.price = price;
  eco.pools.set(pool.id, pool);
  b.loans = b.loans.filter((l) => l.holder.kind === 'bank');
  // the originator keeps a 5% slice ("skin in the game")
  const keep = 0.05;
  b.mbs.set(pool.id, { frac: keep, bookRatio: price });
  let sold = keep;
  const buyers: string[] = [];
  // fund takes as much as it wants
  const fundFrac = Math.min(1 - sold, fundBid / (bal * price));
  if (fundFrac > 0.01) {
    eco.ledger.payBank(f.acct, b, fundFrac * bal * price, 'securitize');
    f.mbs.set(pool.id, { frac: fundFrac, bookRatio: price });
    sold += fundFrac;
    buyers.push(`${f.name} ${pct(fundFrac, 0)}`);
  }
  for (const bb of bankBuyers) {
    if (sold >= 0.999) break;
    const fr = Math.min(1 - sold, bb.cap / (bal * price));
    if (fr < 0.01) continue;
    eco.ledger.interbank(bb.bank, b, fr * bal * price, 'securitize');
    bb.bank.mbs.set(pool.id, { frac: fr, bookRatio: price });
    sold += fr;
    buyers.push(`${bb.bank.short} ${pct(fr, 0)}`);
    invalidateMetrics(bb.bank);
  }
  if (sold < 0.999) {
    // unsold remainder stays with the originator
    const h = b.mbs.get(pool.id)!;
    h.frac += 1 - sold;
  }
  // gain on sale: loans (net book = par - provisions) exchanged for cash + MBS at market price
  const gain = bal * (price - 1) + released;
  b.pl.securitiesGains += gain;
  for (const l of chosen) {
    l.note(eco.day, `Packaged into ${pool.name} and sold to investors (${buyers.join(', ')}). Payments now flow through ${b.short} to them.`, l.balance, f.id);
  }
  invalidateMetrics(b);
  b.log(eco.day, `Securitised ${fmtMoney(bal)} of mortgages as ${pool.name}${gain > 1000 ? `, booking a ${fmtMoney(gain)} gain` : ''}`, 'neutral');
  eco.headline(`${b.name} packages ${chosen.length} mortgages (${fmtMoney(bal)}) into ${pool.name} and sells them to investors`, 'neutral', b.id, undefined, `sec-${b.id}`, 25);
  eco.event('securitization', b.id, bal, f.id, pool.name);
  return bal;
}

/** Sell whole business/consumer loans to the fund at a discount. */
export function sellLoans(eco: Economy, b: Bank, target: number): number {
  const f = eco.fund;
  const bid = Math.max(0, f.acct.balance - 0.04 * fundNavValue(eco)) * (1 - f.fear) * 0.6;
  if (bid < 30_000) return 0;
  const price = Math.max(0.6, 0.99 - 0.12 * f.fear - 0.5 * Math.max(0, eco.market.unemployment - 0.05));
  const candidates = b.loans
    .filter((l) => (l.kind === 'business' || l.kind === 'consumer') && l.status === 'performing' && l.purpose !== 'working_capital')
    .sort((a, c) => c.balance - a.balance);
  const chosen: Loan[] = [];
  let sold = 0;
  let loss = 0;
  for (const l of candidates) {
    if (sold >= target || (sold + l.balance) * price > bid) break;
    chosen.push(l);
    sold += l.balance;
    loss += l.balance - l.provision - l.balance * price;
  }
  if (sold <= 0 || !saleHelpsCapital(eco, b, -loss, sold * RISK_WEIGHTS.business)) return 0;
  for (const l of chosen) {
    const proceeds = l.balance * price;
    eco.ledger.payBank(f.acct, b, proceeds, 'securitize', l.id);
    l.provision = 0;
    l.holder = { kind: 'fund', id: f.id };
    l.soldCount++;
    f.loans.push(l);
    l.note(eco.day, `${b.short} sold this loan to ${f.name} for ${pct(price, 0)} of face value`, proceeds, f.id);
  }
  b.loans = b.loans.filter((l) => l.holder.kind === 'bank');
  b.pl.securitiesGains -= loss;
  invalidateMetrics(b);
  b.log(eco.day, `Sold ${fmtMoney(sold)} of loans to ${f.name}${loss > 1000 ? ` at a ${fmtMoney(loss)} loss` : ''}`, 'neutral');
  eco.headline(`${b.name} sells ${fmtMoney(sold)} of business loans to ${f.name}`, 'neutral', b.id, undefined, `ls-${b.id}`, 40);
  eco.event('loan_sale', b.id, sold, f.id);
  return sold;
}

function sellMbs(eco: Economy, b: Bank, target: number): number {
  const f = eco.fund;
  let got = 0;
  for (const [pid, h] of b.mbs) {
    if (got >= target) break;
    const p = eco.pools.get(pid);
    if (!p || p.balance <= 0) continue;
    const spare = Math.max(0, f.acct.balance - 0.03 * fundNavValue(eco)) * (1 - f.fear * 0.7);
    if (spare < 10_000) break;
    const firePrice = p.price * (1 - 0.05 - 0.15 * f.fear);
    const par = Math.min(h.frac * p.balance, (target - got) / firePrice, spare / firePrice);
    if (par <= 0) continue;
    const frac = par / p.balance;
    const proceeds = par * firePrice;
    eco.ledger.payBank(f.acct, b, proceeds, 'assetsale');
    b.pl.securitiesGains += proceeds - par * h.bookRatio;
    h.frac -= frac;
    const fh = f.mbs.get(pid);
    if (fh) {
      const nf = fh.frac + frac;
      fh.bookRatio = (fh.bookRatio * fh.frac + firePrice * frac) / nf;
      fh.frac = nf;
    } else f.mbs.set(pid, { frac, bookRatio: firePrice });
    got += proceeds;
    // fire sales depress the market price
    p.price *= 1 - Math.min(0.08, (proceeds / Math.max(1, p.balance)) * 0.15);
  }
  for (const [pid, h] of b.mbs) if (h.frac <= 1e-6) b.mbs.delete(pid);
  if (got > 0) {
    invalidateMetrics(b);
    b.log(eco.day, `Sold ${fmtMoney(got)} of mortgage-backed securities`, 'neutral');
  }
  return got;
}

/** Retire bank bonds held by the fund (at par). */
function buyBackBonds(eco: Economy, b: Bank, amount: number): number {
  const amt = Math.min(amount, b.bondsIssued, eco.fund.bankBonds.get(b.id) ?? 0);
  if (amt <= 0) return 0;
  eco.ledger.bankPay(b, eco.fund.acct, amt, 'assetsale');
  b.bondsIssued -= amt;
  eco.fund.bankBonds.set(b.id, (eco.fund.bankBonds.get(b.id) ?? 0) - amt);
  invalidateMetrics(b);
  b.log(eco.day, `Repaid ${fmtMoney(amt)} of its bonds early`, 'neutral');
  return amt;
}

function raiseCapital(eco: Economy, b: Bank, amount: number): number {
  const f = eco.fund;
  const spare = f.acct.balance - 0.05 * fundNavValue(eco);
  if (spare < amount * 0.5 || f.fear > 0.6) return 0;
  const m = cachedMetrics(eco, b);
  if (m.equity <= 0) return 0;
  const amt = Math.min(amount, spare * 0.5);
  eco.ledger.payBank(f.acct, b, amt, 'capital');
  b.paidIn += amt;
  invalidateMetrics(b);
  b.log(eco.day, `Raised ${fmtMoney(amt)} of new capital from ${f.name}`, 'good');
  if (amt >= 20_000) eco.headline(`${b.name} raises ${fmtMoney(amt)} of fresh capital`, 'neutral', b.id, undefined, `cap-${b.id}`, 60);
  eco.event('capital_raise', b.id, amt, f.id);
  return amt;
}

function issueBonds(eco: Economy, b: Bank, amount: number): number {
  const f = eco.fund;
  const spare = f.acct.balance - 0.05 * fundNavValue(eco);
  if (spare < amount * 0.5 || b.stress > 0.35 || f.fear > 0.55) return 0;
  const amt = Math.min(amount, spare * 0.4);
  const coupon = policyRate(eco) + 0.015 + 0.04 * b.stress;
  eco.ledger.payBank(f.acct, b, amt, 'assetsale');
  b.bondsIssuedCoupon = (b.bondsIssuedCoupon * b.bondsIssued + coupon * amt) / (b.bondsIssued + amt);
  b.bondsIssued += amt;
  f.bankBonds.set(b.id, (f.bankBonds.get(b.id) ?? 0) + amt);
  invalidateMetrics(b);
  b.log(eco.day, `Issued ${fmtMoney(amt)} of bonds to ${f.name} at ${pct(coupon, 1)}`, 'neutral');
  return amt;
}

// ============================================================================ monthly review

export function bankMonthly(eco: Economy, b: Bank): void {
  const pers = b.personality;
  const req = eco.policy.capitalRequirement;
  const liqReq = eco.policy.liquidityRequirement;
  updateProvisions(eco, b);
  // sell some REO each month (handled by housing market listings); drop cleared entries
  let m = metrics(eco, b);

  // ---------- sentiment: fear rises fast after losses, fades slowly in good times
  const loans = Math.max(1, m.loansGross);
  const lossRate = (b.pl.creditLosses + b.pl.provisions) / loans * 12;
  const sys = systemLossRate(eco);
  const hpiGrowth = growth(eco.market.hpiHistory, 12);
  const hpi6 = growth(eco.market.hpiHistory, 6);
  let target =
    0.12 +
    3.5 * Math.max(0, lossRate) +
    2.5 * Math.max(0, sys) +
    2.5 * Math.max(0, m.nplRatio - 0.015) +
    0.5 * eco.market.panic +
    1.5 * Math.min(0.15, Math.max(0, -hpi6 * 2)) +
    2.0 * Math.max(0, eco.market.unemployment - 0.06) -
    0.9 * Math.max(0, hpiGrowth) * (0.5 + pers.riskAppetite);
  target += 0.25 * clamp01((req + pers.capitalBuffer - m.capitalRatio) / 0.03);
  target = clamp01(target);
  b.fear += (target - b.fear) * (target > b.fear ? 0.4 : 0.045);

  setStandards(eco, b);

  // ---------- capital position and balance-sheet engineering
  const capTarget = req + pers.capitalBuffer;
  const liqTarget = liqReq + pers.liquidityBuffer;
  const profit = netIncome(b.pl);
  let capShort = m.capitalRatio < capTarget;
  let liqShort = m.liquidityRatio < liqTarget;

  if (capShort) {
    if (!b.dividendsSuspended) {
      b.dividendsSuspended = true;
      b.log(eco.day, `Suspended dividends to rebuild capital`, 'bad');
    }
    const neededRWA = m.rwa - m.equity / capTarget; // RWA to shed
    if (neededRWA > 0) {
      let freed = 0;
      if (pers.securitize > 0.2 && eco.rng.chance(0.3 + 0.7 * pers.securitize)) {
        freed += securitize(eco, b, (neededRWA / RISK_WEIGHTS.mortgage) * 1.2) * RISK_WEIGHTS.mortgage;
      }
      if (freed < neededRWA && eco.rng.chance(0.25 + 0.5 * pers.riskAppetite)) freed += sellLoans(eco, b, neededRWA - freed);
      if (freed < neededRWA && m.capitalRatio < req + 0.01) raiseCapital(eco, b, (neededRWA - freed) * capTarget);
    }
    m = metrics(eco, b);
    capShort = m.capitalRatio < capTarget;
  } else if (b.dividendsSuspended && m.capitalRatio > capTarget + 0.01) {
    b.dividendsSuspended = false;
    b.log(eco.day, `Resumed dividends`, 'good');
  }

  // securitisation as a growth strategy: free capacity to keep originating
  if (!capShort && pers.securitize > 0.5 && b.fear < 0.45 && m.mortgages > 300_000) {
    const nearLimit = m.capitalRatio < capTarget + 0.02;
    // when investors pay a premium, selling loans books an immediate "gain on sale"
    const px = expectedPoolPrice(eco, b);
    if ((nearLimit && px > 0.985) || (px > 1.01 && eco.rng.chance(0.5))) securitize(eco, b, m.mortgages * 0.25 * pers.securitize);
    m = metrics(eco, b);
  }

  if (liqShort) {
    const gap = (liqTarget - m.liquidityRatio) * m.deposits;
    // pay up for deposits, but never so much that lending stops paying for them
    let yieldSum = 0,
      bal = 0;
    for (const l of b.loans) {
      if (!l.active) continue;
      yieldSum += l.rate * l.balance;
      bal += l.balance;
    }
    const loanYield = bal > 0 ? yieldSum / bal : policyRate(eco) + 0.03;
    const ceiling = Math.max(policyRate(eco) * pers.depositBeta, Math.min(policyRate(eco) + 0.01, loanYield - 0.028));
    b.depositRate = Math.min(ceiling, b.depositRate + 0.0025);
    let got = 0;
    if (pers.wholesale > 0.2) got += borrowWholesale(eco, b, gap * pers.wholesale, 30);
    if (got < gap && pers.wholesale > 0.3) got += issueBonds(eco, b, (gap - got) * 0.5);
    if (got < gap && m.mbs > 0) got += sellMbs(eco, b, (gap - got) * 0.5);
    if (got < gap && pers.securitize > 0.3) got += securitize(eco, b, gap - got);
    if (got < gap * 0.5) {
      // buy bills with whatever surplus exists later; tighten meanwhile
    }
    m = metrics(eco, b);
    liqShort = m.liquidityRatio < liqTarget;
  } else {
    // a bank with more deposits than it can lend out stops competing for them
    const ldr = m.deposits > 0 ? m.loansGross / m.deposits : 1;
    const base = Math.max(0, policyRate(eco) * pers.depositBeta * Math.max(0.35, Math.min(1.1, ldr / 0.85)));
    b.depositRate += (base - b.depositRate) * 0.3;
    // surplus cash first pays down expensive funding, then goes into government securities
    let surplus = b.reserves - (0.04 + pers.liquidityBuffer * 0.4) * b.deposits;
    const excessLiquid = m.liquidityRatio - liqTarget;
    if (surplus > 0 && b.cbLoan > 0) {
      const x = Math.min(surplus, b.cbLoan);
      repayCB(eco, b, x);
      surplus -= x;
    }
    for (const w of b.wholesale.slice().sort((a, c) => c.rate - a.rate)) {
      if (surplus < w.amount || excessLiquid * b.deposits < w.amount * 0.5) break;
      repayWholesale(eco, b, w);
      surplus -= w.amount;
    }
    if (surplus > 20_000 && b.bondsIssued > 0 && b.bondsIssuedCoupon > eco.market.billRate + 0.004) {
      surplus -= buyBackBonds(eco, b, Math.min(surplus * 0.7, b.bondsIssued));
    }
    if (surplus > 20_000) buyGovtSecurities(eco, b, surplus * 0.5);
  }

  // ---------- lending stance and budget
  const headroom = Math.max(0, m.headroomRWA);
  if (m.capitalRatio < req || b.status === 'run') b.stance = 'frozen';
  else if (capShort || liqShort || b.fear > 0.6) b.stance = 'tightening';
  else if (b.fear < 0.3 && m.capitalRatio > capTarget + 0.02) b.stance = 'loosening';
  else b.stance = 'steady';
  // monthly lending budget: growth ambition on the balance sheet, capped by capital headroom
  const growthBudget = Math.max(m.loansGross * (pers.growth / 12 + 0.025), m.assets * 0.02) + 50_000;
  const capBudget = headroom * 0.6;
  let budget = Math.min(growthBudget * (1.4 - b.fear), capBudget * 1.6);
  if (b.stance === 'frozen') budget = 0;
  else if (b.stance === 'tightening') budget *= 0.4;
  b.budget = Math.max(0, budget);
  b.originatedThisMonth = 0;
  b.deniedThisMonth = 0;

  // ---------- status
  if (b.status !== 'failed') {
    if (b.status === 'run' && b.runOutflow < 0.01 * b.deposits) b.status = 'stressed';
    if (b.status !== 'run') {
      if (m.capitalRatio < req || b.cbLoanEmergency || b.stress > 0.45) b.status = 'stressed';
      else if (capShort || liqShort) b.status = 'constrained';
      else b.status = 'healthy';
    }
  }
  if (b.stance === 'tightening' && eco.rng.chance(0.15))
    eco.headline(`${b.name} tightens lending standards`, 'bad', b.id, undefined, `tight-${b.id}`, 120);
  if (b.stance === 'loosening' && b.fear < 0.18 && eco.rng.chance(0.1))
    eco.headline(`${b.name} eases lending standards to win customers`, 'neutral', b.id, undefined, `loose-${b.id}`, 180);

  // ---------- dividends
  if (!b.dividendsSuspended && profit > 0 && m.capitalRatio > capTarget + 0.005) {
    let div = profit * pers.payout;
    // capital well beyond what the bank needs is handed back to its shareholders
    const excess = m.equity - (capTarget + 0.05) * m.rwa;
    if (excess > 0 && b.fear < 0.5) div += excess * 0.15;
    eco.ledger.bankPay(b, eco.fund.acct, div, 'dividend');
    eco.fund.incomeMonth += div;
    b.retained -= div;
    b.pl.dividends += div;
  }

  // ---------- close the books for the month
  b.retained += netIncome(b.pl);
  b.plLast = b.pl;
  b.plYear.push(b.pl);
  if (b.plYear.length > 12) b.plYear.shift();
  b.pl = newPL();
  m = metrics(eco, b);
  b.history.push({
    day: eco.day,
    assets: m.assets,
    equity: m.equity,
    deposits: m.deposits,
    loans: m.loansGross,
    capitalRatio: m.capitalRatio,
    liquidityRatio: m.liquidityRatio,
    npl: m.nplRatio,
    profit: netIncome(b.plLast),
    fear: b.fear,
  });
  if (b.history.length > 600) b.history.shift();
  invalidateMetrics(b);
}

/** Lending standards and pricing follow the bank's sentiment and personality. */
export function setStandards(eco: Economy, b: Bank): void {
  const pers = b.personality;
  const f = b.fear;
  const ra = pers.riskAppetite;
  b.maxLTV = clamp(0.6, 0.98, 0.8 + 0.12 * ra + 0.14 * (0.4 - f));
  b.maxDTI = clamp(0.24, 0.55, 0.33 + 0.08 * ra + 0.12 * (0.4 - f));
  b.minDSCR = clamp(1.05, 2.0, 1.35 - 0.25 * ra + 0.6 * (f - 0.3));
  b.maxPD = clamp(0.01, 0.2, (0.03 + 0.09 * ra) * (1.3 - f));
  // banks price their favourite business more keenly
  const tilt = (w: number) => 1.2 - 0.45 * w;
  b.spreads.mortgage = (0.019 + 0.004 * (1 - ra) + 0.025 * f) * tilt(pers.focus.mortgage);
  b.spreads.business = (0.027 + 0.006 * (1 - ra) + 0.035 * f) * tilt(pers.focus.business);
  b.spreads.consumer = (0.05 + 0.01 * (1 - ra) + 0.05 * f) * tilt(pers.focus.consumer);
  b.spreads.development = (0.028 + 0.005 * (1 - ra) + 0.04 * f) * tilt(pers.focus.mortgage);
  void eco;
}

/** Retained earnings are booked from the P&L at month end; dividends are part of the P&L record. */
function systemLossRate(eco: Economy): number {
  let losses = 0,
    loans = 0;
  for (const b of eco.banks) {
    if (!b.alive) continue;
    losses += b.pl.creditLosses + b.pl.provisions;
    loans += b.loanBook();
  }
  return loans > 0 ? (losses / loans) * 12 : 0;
}

export function growth(series: number[], months: number): number {
  const n = series.length;
  if (n < 2) return 0;
  const k = Math.min(months, n - 1);
  const a = series[n - 1 - k];
  return a > 0 ? series[n - 1] / a - 1 : 0;
}

function clamp(lo: number, hi: number, x: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Banks park spare reserves in government securities (reaching for yield with bonds).
 * They buy from the fund's holdings, or new issues only when the Treasury is borrowing.
 */
export function buyGovtSecurities(eco: Economy, b: Bank, amount: number): void {
  const t = eco.treasury;
  const f = eco.fund;
  const issuing = eco.publicBalances.treasury < treasuryTarget(eco);
  const longShare = b.personality.duration * (eco.market.bondYield > eco.market.billRate + 0.005 ? 1 : 0.4);
  const bondAmt = amount * longShare;
  let billAmt = amount - bondAmt;
  // bills: from the fund (only as much as it wants to sell), then at auction if the Treasury needs cash
  let fundSells = Math.max(0, fundCashTarget(eco) * 1.3 - f.acct.balance);
  const fromFund = Math.min(billAmt, f.bills * 0.5, fundSells);
  fundSells -= Math.max(0, fromFund);
  if (fromFund > 1000) {
    eco.ledger.bankPay(b, f.acct, fromFund, 'assetsale');
    f.bills -= fromFund;
    b.bills += fromFund;
    billAmt -= fromFund;
  }
  if (billAmt > 0 && issuing) {
    const x = Math.min(billAmt, treasuryTarget(eco) - eco.publicBalances.treasury);
    if (x > 0) {
      eco.ledger.bankToPublic(b, 'treasury', x, 'assetsale');
      b.bills += x;
      t.bills += x;
    }
  }
  if (bondAmt > 0) {
    const price = bondPrice(f.bondCoupon, eco.market.bondYield);
    const fromFundB = Math.min(bondAmt, f.bondPar * price * 0.5, fundSells);
    if (fromFundB > 1000) {
      const par = fromFundB / price;
      eco.ledger.bankPay(b, f.acct, fromFundB, 'assetsale');
      const fundBookPerPar = f.bondPar > 0 ? f.bondBook / f.bondPar : 1;
      f.bondBook -= par * fundBookPerPar;
      f.bondPar -= par;
      addBonds(b, par, fromFundB, f.bondCoupon);
    }
    const fresh = issuing ? Math.min(bondAmt - fromFundB, Math.max(0, treasuryTarget(eco) - eco.publicBalances.treasury)) : 0;
    if (fresh > 0) {
      eco.ledger.bankToPublic(b, 'treasury', fresh, 'assetsale');
      addBonds(b, fresh, fresh, Math.max(0.001, eco.market.bondYield));
      t.bondPar += fresh;
    }
  }
  invalidateMetrics(b);
}

/** Cash balance the Treasury likes to hold at the central bank. */
export function treasuryTarget(eco: Economy): number {
  return Math.max(150_000, eco.population() * 1500) * 2;
}

/** Add bonds to a holder, keeping a blended coupon and book value. */
export function addBonds(h: { bondPar: number; bondBook: number; bondCoupon: number }, par: number, cost: number, coupon: number): void {
  const np = h.bondPar + par;
  h.bondCoupon = np > 0 ? (h.bondCoupon * h.bondPar + coupon * par) / np : coupon;
  h.bondPar = np;
  h.bondBook += cost;
}

export const _test = { serviceLoan, defaultLoan, DAYS_PER_MONTH };
