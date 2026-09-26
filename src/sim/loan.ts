import type { LoanKind, LoanPurpose, TrailEvent } from './types';

export type LoanStatus =
  | 'performing'
  | 'late' // 1-2 payments missed
  | 'nonperforming' // 90+ days past due
  | 'repaid'
  | 'defaulted'; // charged off / foreclosed

/** Who currently owns the loan asset. */
export type LoanHolder =
  | { kind: 'bank'; id: number }
  | { kind: 'pool'; id: number } // securitised into an MBS pool
  | { kind: 'fund'; id: number }; // sold to the investment fund

export interface Collateral {
  kind: 'property' | 'business' | 'project' | 'none';
  /** residential unit id, firm id or project id */
  ref?: number;
  /** estimated value at origination */
  value: number;
}

const MAX_TRAIL = 60;

export class Loan {
  status: LoanStatus = 'performing';
  balance: number;
  /** floating: rate = policy rate + spread */
  rate: number;
  monthsPaid = 0;
  missed = 0;
  arrears = 0;
  interestPaid = 0;
  principalPaid = 0;
  lossAmount = 0;
  recovered = 0;
  provision = 0;
  closedDay = -1;
  holder: LoanHolder;
  /** bank collecting payments (originator, or an acquirer after a failure) */
  servicerId: number;
  /** first-hop uses of the loan proceeds */
  spentOn: { agent: number; amount: number; what: string }[] = [];
  trail: TrailEvent[] = [];
  /** days on which this loan has been noted as moving between holders */
  soldCount = 0;

  constructor(
    public readonly id: number,
    public readonly kind: LoanKind,
    public readonly purpose: LoanPurpose,
    public readonly originatorId: number,
    public readonly borrowerId: number,
    public readonly principal0: number,
    public spread: number,
    policyRate: number,
    public termMonths: number,
    public readonly amortizing: boolean,
    public readonly day: number,
    public dueDay: number,
    public collateral: Collateral,
  ) {
    this.balance = principal0;
    this.rate = Math.max(0.005, policyRate + spread);
    this.holder = { kind: 'bank', id: originatorId };
    this.servicerId = originatorId;
  }

  get active(): boolean {
    return this.status === 'performing' || this.status === 'late' || this.status === 'nonperforming';
  }

  get monthsLeft(): number {
    return Math.max(1, this.termMonths - this.monthsPaid);
  }

  /** Amount due this month (interest + scheduled principal), excluding arrears. */
  scheduledPayment(): number {
    const r = this.rate / 12;
    if (!this.amortizing) return this.balance * r;
    const n = this.monthsLeft;
    if (n <= 1) return this.balance * (1 + r);
    const pmt = (this.balance * r) / (1 - Math.pow(1 + r, -n));
    return Math.min(pmt, this.balance * (1 + r));
  }

  interestDue(): number {
    return (this.balance * this.rate) / 12;
  }

  note(day: number, text: string, amount?: number, agent?: number, tone?: TrailEvent['tone']): void {
    this.trail.push({ day, text, amount, agent, tone });
    if (this.trail.length > MAX_TRAIL) this.trail.splice(1, 1); // keep the origination entry
  }

  spend(agent: number, amount: number, what: string): void {
    const last = this.spentOn.find((s) => s.agent === agent && s.what === what);
    if (last) last.amount += amount;
    else if (this.spentOn.length < 24) this.spentOn.push({ agent, amount, what });
  }

  dpd(): number {
    return this.missed * 30;
  }
}

/** Monthly payment for a new amortising loan. */
export function annuityPayment(principal: number, annualRate: number, months: number): number {
  const r = annualRate / 12;
  if (r <= 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

/** Largest principal whose annuity payment fits the given monthly budget. */
export function maxPrincipalForPayment(payment: number, annualRate: number, months: number): number {
  const r = annualRate / 12;
  if (payment <= 0) return 0;
  if (r <= 0) return payment * months;
  return (payment * (1 - Math.pow(1 + r, -months))) / r;
}
