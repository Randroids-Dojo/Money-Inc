// Loan reviews (Genesis Mode). A borrower's application is put in front of the player; their
// choice (approve, resize, reprice, change the term or collateral, or refuse) is handed back to
// the borrower's own plan, which carries on from where it paused. If the player lets the
// deadline pass, the bank decides by its own standards, exactly as in the standard game.

import { CFG } from '../config';
import type { Economy } from '../economy';
import type { Firm, Household } from '../agents';
import { RISK_WEIGHTS } from '../bank';
import type { Bank } from '../bank';
import { metrics, underwrite, unitValue, type LoanApp, type LoanDecision, type LoanOffer } from '../banking';
import { annuityPayment } from '../loan';
import { fmtMoney, pct } from '../format';
import type { LoanPurpose } from '../types';
import type { BusinessPlan, CollateralChoice, LoanChoice, LoanReview, PlanFigures, Situation } from './types';
import { buildPrice, equipPrice, expansionFigures, hasLocalBuilder, hasLocalFactory, startupFigures } from './plans';
import type { Genesis } from './state';

export interface LoanPreview {
  amount: number;
  rate: number;
  termMonths: number;
  payment: number;
  figures?: PlanFigures;
  /** mortgages */
  downPayment?: number;
  dti?: number;
  ltv?: number;
  /** can the borrower go ahead on these terms at all? */
  feasible: boolean;
  capitalAfter: number;
  liquidityAfter: number;
  capitalReq: number;
  liquidityReq: number;
  /** money the borrower will probably spend outside town (drains the bank's reserves) */
  leak: number;
  /** estimated yearly default probability */
  pd: number;
  risk: 'low' | 'moderate' | 'high' | 'very high';
  warnings: string[];
  /** why approval is impossible (breaks a hard rule) */
  blocked?: string;
}

const purposeLabel: Record<LoanPurpose, string> = {
  home: 'mortgage',
  investment_property: 'buy-to-let mortgage',
  startup: 'start-up loan',
  expansion: 'expansion loan',
  working_capital: 'credit line',
  development: 'development loan',
  durables: 'consumer loan',
  smoothing: 'personal loan',
};

export function loanLabel(p: LoanPurpose): string {
  return purposeLabel[p];
}

/** The bank the borrower applies to: their own bank if it is open, else the healthiest one. */
export function reviewingBank(eco: Economy, app: LoanApp): Bank | undefined {
  const own = app.borrower.acct.bank;
  if (own.alive) return own;
  const alive = eco.aliveBanks();
  return alive.length ? alive.reduce((a, b) => (b.stress < a.stress ? b : a)) : undefined;
}

/** The bank's own view, without side effects: what it would offer (if anything) and why not. */
export function bankView(eco: Economy, bank: Bank, app: LoanApp): LoanDecision {
  const saved = { budget: bank.budget, orig: bank.originatedThisMonth };
  // the monthly lending budget is the bank's appetite; the player can overrule it
  bank.budget = Math.max(bank.budget, bank.originatedThisMonth + app.amount + 1);
  const d = underwrite(eco, bank, app);
  bank.budget = saved.budget;
  bank.originatedThisMonth = saved.orig;
  return d;
}

function riskLabel(pd: number): LoanPreview['risk'] {
  return pd < 0.025 ? 'low' : pd < 0.06 ? 'moderate' : pd < 0.12 ? 'high' : 'very high';
}

/** Rough yearly default probability for the preview (the same drivers the banks use). */
function estimatePD(eco: Economy, r: LoanReview, pv: LoanPreview): number {
  const u = eco.market.unemployment;
  const macro = 1 + 5 * Math.max(0, u - CFG.naturalUnemployment) + 2 * eco.market.panic;
  let pd: number;
  if (r.purpose === 'home' || r.purpose === 'investment_property') {
    pd = 0.004 + 0.07 * Math.max(0, (pv.dti ?? 0.3) - 0.22) + 0.06 * Math.max(0, (pv.ltv ?? 0.8) - 0.7);
    if (r.purpose === 'investment_property') pd *= 1.3;
  } else if (r.purpose === 'development') {
    const ltc = pv.amount / Math.max(1, r.dev?.saleValue ?? pv.amount);
    pd = 0.02 + 0.4 * Math.max(0, ltc - 0.55);
  } else {
    const dscr = pv.figures?.dscr ?? 1.5;
    pd = 0.012 + 0.08 * Math.max(0, 1.7 - dscr) + (r.purpose === 'startup' ? 0.02 : 0);
    const borrower = r.app.borrower;
    if (borrower.kind === 'firm' && borrower.missed > 0) pd += 0.05;
  }
  return Math.min(0.6, pd * macro);
}

function collateralFor(eco: Economy, r: LoanReview, c: CollateralChoice, amount: number): LoanApp['collateral'] {
  const app = r.app;
  if (c === 'none') return { kind: 'none', value: 0 };
  if (c === 'home') {
    const owner = ownerOf(eco, app.borrower);
    const home = owner ? eco.units[owner.homeUnit] : undefined;
    if (home && home.ownerId === owner!.id) return { kind: 'property', ref: home.id, value: unitValue(eco, home.id) };
  }
  if (app.kind === 'business') {
    const base = r.businessCollateral ?? (app.collateral.kind === 'business' ? app.collateral.value : 0);
    return { kind: 'business', ref: app.borrower.id, value: base * (amount / Math.max(1, r.requested)) };
  }
  return app.collateral;
}

function ownerOf(eco: Economy, b: Household | Firm): Household | undefined {
  return b.kind === 'household' ? b : eco.household(b.ownerId);
}

/** Can the borrower pledge their home as extra security? */
export function canPledgeHome(eco: Economy, r: LoanReview): boolean {
  if (r.app.borrower.kind !== 'firm') return false;
  const owner = ownerOf(eco, r.app.borrower);
  const home = owner ? eco.units[owner.homeUnit] : undefined;
  return !!home && home.ownerId === owner!.id && !home.mortgage;
}

export function previewLoan(g: Genesis, sit: Situation, c: LoanChoice): LoanPreview {
  const eco = g.eco;
  const r = sit.loan!;
  const bank = eco.bank(r.bankId) ?? eco.aliveBanks()[0];
  const amount = Math.max(0, c.amount);
  const payment = amount > 0 ? annuityPayment(amount, c.rate, c.termMonths) : 0;
  const pv: LoanPreview = {
    amount,
    rate: c.rate,
    termMonths: c.termMonths,
    payment,
    feasible: true,
    capitalAfter: 0,
    liquidityAfter: 0,
    capitalReq: eco.policy.capitalRequirement,
    liquidityReq: eco.policy.liquidityRequirement,
    leak: 0,
    pd: 0,
    risk: 'low',
    warnings: [],
  };
  const warn = (s: string) => pv.warnings.push(s);
  if (r.plan && r.purpose === 'startup') {
    pv.figures = startupFigures(eco, r.plan, amount, c.rate, c.termMonths);
    const f = pv.figures;
    pv.leak = (hasLocalBuilder(eco) ? 0 : f.premises) + (hasLocalFactory(eco) && r.plan.sector !== 'factory' ? 0 : f.equipment);
    if (f.dscr < 1.2) warn(`Expected cash flow covers the loan payments only ${f.dscr.toFixed(2)} times.`);
    if (f.profit < 0) warn(`At 85% of capacity the business would lose ${fmtMoney(-f.profit)} a month.`);
  } else if (r.plan && r.purpose === 'expansion') {
    const f = r.app.borrower as Firm;
    pv.figures = expansionFigures(eco, f, r.plan, amount, c.rate, c.termMonths);
    pv.leak = (hasLocalBuilder(eco) ? 0 : (r.plan.expansion!.cost + amount - r.requested) * 0.5) + (hasLocalFactory(eco) && f.sector !== 'factory' ? 0 : (r.plan.expansion!.cost + amount - r.requested) * 0.5);
    if (pv.figures.dscr < 1.2) warn(`Cash flow would cover all its loan payments only ${pv.figures.dscr.toFixed(2)} times.`);
  } else if (r.home) {
    const h = r.app.borrower as Household;
    const down = r.home.price - amount;
    pv.downPayment = down;
    pv.ltv = amount / Math.max(1, r.home.price);
    const income = Math.max(1, r.app.income);
    pv.dti = (r.app.existingDebtService + payment) / income;
    const cash = Math.max(0, h.acct.balance - CFG.essentials * eco.market.cpi);
    if (down > cash + 1) {
      pv.feasible = false;
      warn(`${h.name} has only ${fmtMoney(cash)} for the ${fmtMoney(down)} down payment.`);
    }
    if (pv.ltv > g.rules.maxLTV + 1e-9) warn(`Above your ${pct(g.rules.maxLTV, 0)} loan-to-value limit.`);
    if (pv.dti > g.rules.maxDTI + 1e-9) warn(`Payments would take ${pct(pv.dti, 0)} of income (your limit is ${pct(g.rules.maxDTI, 0)}).`);
  } else if (r.dev) {
    const ltc = amount / Math.max(1, r.dev.saleValue);
    if (ltc > 0.85) warn(`The loan is ${pct(ltc, 0)} of what the homes should sell for.`);
    pv.leak = amount * 0.2;
  }
  pv.pd = estimatePD(eco, r, pv);
  pv.risk = riskLabel(pv.pd);
  // balance-sheet effect on the lending bank
  const m = metrics(eco, bank);
  const rw = RISK_WEIGHTS[r.app.kind];
  const rwa = Math.max(1, m.rwa + amount * rw);
  pv.capitalAfter = m.equity / rwa;
  const leak = Math.min(pv.leak, amount);
  pv.liquidityAfter = (m.liquid - leak) / Math.max(1, m.deposits + amount - leak);
  if (amount > 0 && pv.capitalAfter < eco.policy.capitalRequirement) {
    pv.blocked = `${bank.name} would fall below your ${pct(eco.policy.capitalRequirement, 0)} capital requirement (to ${pct(pv.capitalAfter, 1)}).`;
  }
  if (amount > 0 && pv.liquidityAfter < eco.policy.liquidityRequirement) warn(`${bank.short} would be short of liquid funds (${pct(pv.liquidityAfter, 0)} of deposits).`);
  if (pv.pd > g.rules.maxPD * 1.5) warn(`Risk is well above your minimum borrower quality rule.`);
  return pv;
}

/**
 * Decide an open loan situation. Returns an error message when the choice is impossible
 * (e.g. it would break the capital requirement), or null once the decision has been made.
 */
export function decideLoan(g: Genesis, sit: Situation, c: LoanChoice, byPlayer = true): string | null {
  const eco = g.eco;
  const r = sit.loan!;
  if (r.settled) return null;
  const bank = eco.bank(r.bankId);
  if (c.approve) {
    if (!bank || !bank.alive) return 'The bank is no longer open.';
    const pv = previewLoan(g, sit, c);
    if (pv.blocked) return pv.blocked;
    if (!pv.feasible) return pv.warnings[0] ?? 'The borrower cannot go ahead on these terms.';
  }
  r.settled = true;
  sit.status = byPlayer ? 'decided' : 'expired';
  if (!c.approve) {
    sit.outcome = byPlayer ? 'Turned down.' : `${bank?.short ?? 'The bank'} turned it down.`;
    if (byPlayer) g.recordLoanDecision(sit, c);
    r.done({ reason: byPlayer ? 'the application was turned down' : (r.bankReason ?? 'turned down') }, r.app);
    return null;
  }
  const app: LoanApp = {
    ...r.app,
    amount: c.amount,
    termMonths: c.termMonths,
    collateral: collateralFor(eco, r, c.collateral, c.amount),
  };
  const offer: LoanOffer = { bank: bank!, spread: c.rate - eco.policy.policyRate, rate: c.rate, pd: previewLoan(g, sit, c).pd };
  sit.outcome = `Approved: ${fmtMoney(c.amount)} at ${pct(c.rate, 1)} over ${Math.round(c.termMonths / 12)} years.`;
  if (byPlayer) g.recordLoanDecision(sit, c);
  g.markReviewed(r.purpose);
  r.done({ offer }, app);
  return null;
}

/** The bank's own decision, used when the player lets a deadline pass. */
export function defaultChoice(r: LoanReview): LoanChoice {
  return r.suggested;
}

/** Build the options for a review: sizes, rates, terms and the bank's own suggestion. */
export function buildReview(
  g: Genesis,
  app: LoanApp,
  purpose: LoanPurpose,
  done: LoanReview['done'],
  extra: Partial<LoanReview> = {},
): LoanReview | null {
  const eco = g.eco;
  const bank = reviewingBank(eco, app);
  if (!bank) return null;
  const view = bankView(eco, bank, app);
  const policy = eco.policy.policyRate;
  const baseRate = view.offer ? view.offer.rate : policy + bank.spreads[app.kind] + 0.02;
  const round = (x: number) => Math.round(x * 400) / 400;
  const req = app.amount;
  let sizes: number[];
  let terms: number[];
  if (purpose === 'home' || purpose === 'investment_property') {
    const price = extra.home?.price ?? req;
    sizes = [0.95, 0.9, 0.8, 0.7].map((ltv) => Math.round((price * ltv) / 1000) * 1000);
    if (!sizes.includes(req)) sizes.push(req);
    sizes = [...new Set(sizes)].sort((a, b) => b - a);
    terms = [180, 300, 360];
  } else if (purpose === 'development') {
    sizes = [req * 0.75, req].map((x) => Math.round(x / 1000) * 1000);
    terms = [app.termMonths, app.termMonths + 12];
  } else {
    sizes = [0.5, 1, 2].map((k) => Math.round((req * k) / 1000) * 1000);
    terms = [...new Set([60, app.termMonths, 144])].sort((a, b) => a - b);
  }
  const rates = [round(Math.max(0.005, baseRate - 0.01)), round(baseRate), round(baseRate + 0.02)];
  const collaterals: CollateralChoice[] = app.kind === 'business' ? ['business', 'home', 'none'] : ['business'];
  const pledged = app.kind === 'business' && app.collateral.kind === 'property';
  const businessCollateral = extra.plan ? extra.plan.base.equipment * 0.5 + extra.plan.base.premises * 0.4 : app.collateral.kind === 'business' ? app.collateral.value : 0;
  const suggested: LoanChoice = {
    approve: !!view.offer,
    amount: req,
    rate: round(baseRate),
    termMonths: app.termMonths,
    collateral: pledged ? 'home' : 'business',
  };
  return {
    purpose,
    app,
    bankId: bank.id,
    offer: view.offer,
    bankReason: view.reason,
    requested: req,
    sizes,
    rates,
    terms,
    collaterals,
    suggested,
    done,
    businessCollateral,
    ...extra,
  };
}

/** A one-line summary of what the bank's own loan officers think. */
export function bankOpinion(eco: Economy, r: LoanReview): string {
  const b = eco.bank(r.bankId);
  const name = b?.name ?? 'The bank';
  if (r.offer) return `${name}'s loan officers would approve it at ${pct(r.offer.rate, 1)} (estimated default risk ${pct(r.offer.pd, 1)} a year).`;
  return `${name}'s loan officers would turn it down: ${r.bankReason ?? 'too risky'}.`;
}

export function planOf(r: LoanReview): BusinessPlan | undefined {
  return r.plan;
}

export { buildPrice, equipPrice };
