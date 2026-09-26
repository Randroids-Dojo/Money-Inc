// Commercial bank: balance-sheet state and derived metrics.
// Behaviour (underwriting, liquidity management, balance-sheet engineering) lives in banking.ts.

import type { Loan } from './loan';
import type { LoanKind } from './types';

export interface BankPersonality {
  /** 0 = very cautious, 1 = reckless */
  riskAppetite: number;
  /** capital ratio the bank aims to keep above the regulatory minimum */
  capitalBuffer: number;
  /** liquidity ratio the bank aims to keep above the regulatory minimum */
  liquidityBuffer: number;
  /** relative appetite for each loan type */
  focus: Record<'business' | 'mortgage' | 'consumer', number>;
  /** 0..1 willingness to package loans into MBS and sell them */
  securitize: number;
  /** 0..1 willingness to fund itself with short-term wholesale money */
  wholesale: number;
  /** target annual growth of the loan book */
  growth: number;
  /** share of profits paid out as dividends in good times */
  payout: number;
  /** share of the securities portfolio held in long-dated bonds (reaching for yield) */
  duration: number;
  /** how much of the policy rate is passed to depositors */
  depositBeta: number;
  blurb: string;
}

export interface PL {
  interestIncome: number;
  interestExpense: number;
  fees: number;
  opex: number;
  provisions: number;
  creditLosses: number;
  securitiesGains: number;
  dividends: number;
}

export function newPL(): PL {
  return {
    interestIncome: 0,
    interestExpense: 0,
    fees: 0,
    opex: 0,
    provisions: 0,
    creditLosses: 0,
    securitiesGains: 0,
    dividends: 0,
  };
}

export function netIncome(p: PL): number {
  return p.interestIncome - p.interestExpense + p.fees - p.opex - p.provisions - p.creditLosses + p.securitiesGains;
}

/** Short-term borrowing between institutions (interbank or repo with the fund). */
export interface Wholesale {
  id: number;
  lenderId: number;
  lenderKind: 'bank' | 'fund';
  borrowerId: number;
  amount: number;
  rate: number;
  maturity: number; // day
  started: number;
}

export interface MbsHolding {
  frac: number; // fraction of the pool owned
  bookRatio: number; // cost basis per $ of par
}

export type BankStatus = 'healthy' | 'constrained' | 'stressed' | 'run' | 'failed';
export type LendingStance = 'loosening' | 'steady' | 'tightening' | 'frozen';

export interface BankAction {
  day: number;
  text: string;
  tone: 'good' | 'bad' | 'neutral';
}

export interface BankMonth {
  day: number;
  assets: number;
  equity: number;
  deposits: number;
  loans: number;
  capitalRatio: number;
  liquidityRatio: number;
  npl: number;
  profit: number;
  fear: number;
}

export interface RiskWeights {
  mortgage: number;
  business: number;
  consumer: number;
  development: number;
  mbs: number;
  interbank: number;
  reo: number;
}

export const RISK_WEIGHTS: RiskWeights = {
  mortgage: 0.5,
  business: 1.0,
  consumer: 1.0,
  development: 1.5,
  mbs: 0.2,
  interbank: 0.2,
  reo: 1.0,
};

export class Bank {
  readonly kind = 'bank' as const;
  status: BankStatus = 'healthy';
  stance: LendingStance = 'steady';
  failedDay = -1;
  failureKind: 'insolvency' | 'liquidity' | null = null;
  acquiredBy: number | null = null;

  // ---- assets ----
  reserves = 0;
  loans: Loan[] = [];
  bills = 0;
  bondPar = 0;
  bondBook = 0;
  bondCoupon = 0.035;
  mbs = new Map<number, MbsHolding>();
  interbankLent: Wholesale[] = [];
  /** foreclosed property held for sale: unit id -> carrying value */
  reo = new Map<number, number>();
  /** foreclosed commercial property (lots): lot id -> carrying value */
  reoLots = new Map<number, number>();

  // ---- liabilities ----
  deposits = 0;
  wholesale: Wholesale[] = [];
  cbLoan = 0;
  cbLoanEmergency = false;
  bondsIssued = 0;
  bondsIssuedCoupon = 0.05;

  // ---- equity ----
  paidIn = 0;
  retained = 0;

  // ---- behaviour state ----
  fear = 0.25;
  depositRate = 0.01;
  /** spreads over the policy rate by loan kind */
  spreads: Record<LoanKind, number> = { mortgage: 0.02, business: 0.03, consumer: 0.06, development: 0.035 };
  maxLTV = 0.85;
  maxDTI = 0.35;
  minDSCR = 1.25;
  /** maximum acceptable estimated default probability */
  maxPD = 0.06;
  /** lending budget remaining this month, $ of new loans */
  budget = 0;
  budgetMonth = 0;
  originatedThisMonth = 0;
  deniedThisMonth = 0;
  /** public perception of trouble, 0..1 */
  stress = 0;
  /** deposits withdrawn in the recent run (for crowd visuals) */
  runOutflow = 0;
  runDays = 0;
  cbStigma = 0;
  dividendsSuspended = false;
  employees: number[] = [];

  pl: PL = newPL();
  plLast: PL = newPL();
  plYear: PL[] = [];
  lossesCum = 0;
  createdCum = 0;
  destroyedCum = 0;
  history: BankMonth[] = [];
  actions: BankAction[] = [];

  constructor(
    public readonly id: number,
    public name: string,
    public short: string,
    public color: string,
    public readonly originIdx: number,
    public lotId: number,
    public readonly personality: BankPersonality,
    public readonly founded: number,
  ) {}

  get alive(): boolean {
    return this.status !== 'failed';
  }

  log(day: number, text: string, tone: BankAction['tone'] = 'neutral'): void {
    this.actions.push({ day, text, tone });
    if (this.actions.length > 40) this.actions.shift();
  }

  // ---------- derived metrics (prices are supplied by the market) ----------

  loanBook(kind?: LoanKind): number {
    let s = 0;
    for (const l of this.loans) if (l.active && (!kind || l.kind === kind)) s += l.balance;
    return s;
  }

  provisions(): number {
    let s = 0;
    for (const l of this.loans) if (l.active) s += l.provision;
    return s;
  }

  nonperforming(): number {
    let s = 0;
    for (const l of this.loans) if (l.status === 'nonperforming') s += l.balance;
    return s;
  }

  lateLoans(): number {
    let s = 0;
    for (const l of this.loans) if (l.status === 'late' || l.status === 'nonperforming') s += l.balance;
    return s;
  }

  bondValue(price: number): number {
    return this.bondPar * price;
  }

  mbsValue(pools: Map<number, { balance: number; price: number }>): number {
    let s = 0;
    for (const [pid, h] of this.mbs) {
      const p = pools.get(pid);
      if (p) s += h.frac * p.balance * p.price;
    }
    return s;
  }

  mbsBook(pools: Map<number, { balance: number }>): number {
    let s = 0;
    for (const [pid, h] of this.mbs) {
      const p = pools.get(pid);
      if (p) s += h.frac * p.balance * h.bookRatio;
    }
    return s;
  }

  interbankAssets(): number {
    let s = 0;
    for (const w of this.interbankLent) s += w.amount;
    return s;
  }

  wholesaleFunding(): number {
    let s = 0;
    for (const w of this.wholesale) s += w.amount;
    return s;
  }

  reoValue(): number {
    let s = 0;
    for (const v of this.reo.values()) s += v;
    for (const v of this.reoLots.values()) s += v;
    return s;
  }
}
