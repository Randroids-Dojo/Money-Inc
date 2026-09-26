// Shared simulation types.

export type AgentKind = 'household' | 'firm' | 'bank' | 'cb' | 'treasury' | 'fund' | 'dif' | 'world';

export type Sector = 'retail' | 'service' | 'factory' | 'builder';

export type LoanKind = 'mortgage' | 'business' | 'consumer' | 'development';

export type LoanPurpose =
  | 'home' // owner-occupied home purchase
  | 'investment_property' // buy-to-let / speculative purchase
  | 'startup' // new business
  | 'expansion' // business capacity expansion (construction + equipment)
  | 'working_capital' // short-term cash-flow loan
  | 'development' // speculative housing development by a builder
  | 'durables' // consumer credit for big purchases
  | 'smoothing'; // consumer credit to cover a cash shortfall

/** Kinds of money movement, used for visualisation and statistics. */
export type FlowKind =
  | 'loan' // bank disburses a loan: new deposit money
  | 'principal' // principal repayment: deposit money destroyed
  | 'interest' // interest paid to a bank / loan holder
  | 'spend' // household consumption
  | 'wage' // wages (net of tax)
  | 'supply' // firm-to-firm purchases (inventory, materials)
  | 'invest' // investment spending (construction, equipment)
  | 'rent'
  | 'tax'
  | 'benefit' // unemployment benefit
  | 'dividend'
  | 'settle' // interbank settlement of reserves
  | 'property' // property purchase payment
  | 'securitize' // investor pays a bank for MBS / loans
  | 'assetsale' // other securities sales between institutions
  | 'cb' // central bank operations with banks (lending, QE, interest on reserves)
  | 'fund' // household investing / redeeming with the fund
  | 'run' // deposits fleeing a bank
  | 'deposit_interest'
  | 'capital' // equity injections / bail-outs
  | 'resolution' // deposit insurance payouts etc.
  | 'expense' // bank operating costs paid to firms
  | 'coupon' // government bond interest
  | 'transfer'; // other transfers (bank switching, migration savings)

export interface FlowEvent {
  day: number;
  from: number; // agent id
  to: number; // agent id
  amount: number;
  kind: FlowKind;
  /** loan id when the flow is connected to a specific loan */
  loan?: number;
}

/** Discrete happenings the renderer can dramatise (icons, floating text, crowds). */
export type SimEventType =
  | 'loan_approved'
  | 'loan_denied'
  | 'default'
  | 'foreclosure'
  | 'firm_open'
  | 'firm_close'
  | 'hire'
  | 'layoff'
  | 'construction_start'
  | 'construction_done'
  | 'construction_stalled'
  | 'house_sold'
  | 'securitization'
  | 'loan_sale'
  | 'bank_run'
  | 'bank_fail'
  | 'bank_rescue'
  | 'cb_loan'
  | 'capital_raise'
  | 'arrival'
  | 'departure';

export interface SimEvent {
  day: number;
  type: SimEventType;
  agent: number; // primary agent id
  other?: number; // secondary agent id (e.g., lender)
  amount?: number;
  text?: string;
}

export type NewsTone = 'good' | 'bad' | 'neutral' | 'alert' | 'policy';

export interface NewsItem {
  id: number;
  day: number;
  text: string;
  tone: NewsTone;
  /** agent id to focus when clicked */
  agent?: number;
  /** lot id to focus when clicked (for things like construction sites) */
  lot?: number;
}

export interface TrailEvent {
  day: number;
  text: string;
  amount?: number;
  /** counterparty agent id for "show on map" */
  agent?: number;
  tone?: 'good' | 'bad' | 'neutral';
}

export type DepositInsurance = 'none' | 'basic' | 'standard' | 'unlimited';
export type EmergencyLiquidity = 'none' | 'standard' | 'broad';
export type QeTarget = 'govt' | 'govt_mbs';

export interface PolicySettings {
  policyRate: number; // annual, e.g. 0.03
  capitalRequirement: number; // equity / risk-weighted assets
  liquidityRequirement: number; // liquid assets / deposits
  depositInsurance: DepositInsurance;
  emergencyLiquidity: EmergencyLiquidity;
  /** monthly asset purchases (+) or sales (-), in dollars */
  qePerMonth: number;
  qeTarget: QeTarget;
  /** if true the policy rate follows a simple rule instead of the player's setting */
  autopilot: boolean;
}

export const INSURANCE_LIMITS: Record<DepositInsurance, number> = {
  none: 0,
  basic: 50_000,
  standard: 250_000,
  unlimited: Number.POSITIVE_INFINITY,
};
