// Genesis Mode data types: the situations the simulation puts in front of the player, the
// choices they can make, the rules they govern with, and the record of what they decided.

import type { LoanApp, LoanDecision, LoanOffer } from '../banking';
import type { LoanPurpose, Sector } from '../types';

/** How the player's reach changes as the economy grows: transaction -> institution -> system. */
export type Era = 'transactions' | 'institutions' | 'system';

export const ERA_INFO: Record<Era, { title: string; blurb: string }> = {
  transactions: {
    title: 'Transactions',
    blurb: 'Every loan crosses your desk. You can follow each dollar.',
  },
  institutions: {
    title: 'Institutions',
    blurb: 'Banks handle the routine loans under your rules. Big or first-of-a-kind loans still come to you.',
  },
  system: {
    title: 'System',
    blurb: 'Too many loans to review. You govern through rules, rates and what you do in a crisis.',
  },
};

/** Lending and banking rules the player sets (they bind every bank). */
export interface GenesisRules {
  /** highest loan-to-value on home loans (1 - minimum down payment) */
  maxLTV: number;
  /** highest share of income that may go to debt payments */
  maxDTI: number;
  /** minimum borrower quality: the highest default probability a bank may accept */
  maxPD: number;
  /** business loans: cash flow must cover payments this many times */
  minDSCR: number;
  /** may banks package mortgages into securities and sell them? */
  securitization: boolean;
  /** which loans still need the player's sign-off */
  review: 'all' | 'large' | 'crises';
  /** "large" loans: at or above this amount */
  reviewThreshold: number;
  /** may banks pay dividends to their owners? */
  dividends: boolean;
}

export type SituationKind = 'loan' | 'trouble' | 'constraint' | 'run' | 'failure' | 'charter' | 'era';

export interface PlanFigures {
  /** loan amount these figures assume */
  loan: number;
  equity: number;
  cost: number;
  premises: number;
  equipment: number;
  working: number;
  staff: number;
  capacity: number;
  revenue: number;
  wages: number;
  inputs: number;
  depreciation: number;
  interest: number;
  payment: number;
  profit: number;
  dscr: number;
}

export interface BusinessPlan {
  firmId: number;
  name: string;
  sector: Sector;
  subtype: string;
  ownerId: number;
  lotId: number;
  /** what the business will do, in one line */
  pitch: string;
  /** who its customers are */
  market: string;
  /** what the money buys */
  purchases: string[];
  /** people it expects to employ (names where known) */
  staffNames: string[];
  /** figures at the requested size */
  base: PlanFigures;
  /** productivity and capital intensity of this business */
  A: number;
  kappa: number;
  price: number;
  wage: number;
  /** extension: the new capital being added */
  expansion?: { addK: number; unitPrice: number; cost: number; equity: number };
}

export type CollateralChoice = 'business' | 'home' | 'none';

export interface LoanChoice {
  approve: boolean;
  /** loan amount the player approves */
  amount: number;
  /** annual interest rate */
  rate: number;
  termMonths: number;
  collateral: CollateralChoice;
}

export interface LoanReview {
  purpose: LoanPurpose;
  app: LoanApp;
  bankId: number;
  /** the bank's own underwriting view */
  offer?: LoanOffer;
  bankReason?: string;
  requested: number;
  plan?: BusinessPlan;
  /** build: the family will have the home built (unitId is -1 until it is) */
  home?: { unitId: number; lotId: number; price: number; cash: number; income: number; sellerId: number; investment: boolean; build?: boolean };
  /** homes: built for the borrower to keep and let (company housing), not to sell */
  dev?: { units: number; cost: number; saleValue: number; lotId: number; homes?: boolean };
  /** resize options (amounts) */
  sizes: number[];
  rates: number[];
  terms: number[];
  collaterals: CollateralChoice[];
  /** default choice (what the bank would do) */
  suggested: LoanChoice;
  /** continuation: the borrower's plan resumes with the final decision */
  done: (d: LoanDecision, app: LoanApp) => void;
  /** set once the continuation has run */
  settled?: boolean;
  /** the first loan of the game gets extra ceremony */
  first?: boolean;
  /** value of the business's own assets as security (for the "business assets" choice) */
  businessCollateral?: number;
}

export type TroubleAction = 'wait' | 'restructure' | 'extend' | 'demand' | 'seize' | 'writedown' | 'lend';
export type ConstraintAction = 'stop' | 'rates' | 'sellsec' | 'sellloans' | 'securitize' | 'wholesale' | 'retain' | 'capital';
export type RunAction = 'nothing' | 'ela' | 'guarantee' | 'sell' | 'acquire' | 'recap' | 'fail';
export type FailureAction = 'fail' | 'bailout' | 'forbear' | 'acquire' | 'ela';
export type CharterAction = 'approve' | 'morecapital' | 'reject';

export interface ActionOption<A extends string> {
  id: A;
  label: string;
  /** what it does to the balance sheet / the borrower, plainly */
  effect: string;
  /** why it is unavailable right now */
  disabled?: string;
}

export interface Situation {
  id: number;
  kind: SituationKind;
  day: number;
  /** day on which the default applies if the player has not decided (Infinity = waits) */
  deadline: number;
  /** pauses the game until decided */
  blocking: boolean;
  title: string;
  /** one-paragraph description */
  text: string;
  /** agent the situation is about (for the map marker and "show") */
  subject: number;
  lotId: number;
  status: 'open' | 'decided' | 'expired' | 'void';
  /** what happened, once resolved */
  outcome?: string;
  loan?: LoanReview;
  loanId?: number;
  bankId?: number;
  options?: ActionOption<string>[];
  /** default action id for action situations */
  fallback?: string;
  charter?: { name: string; short: string; color: string; capital: number; blurb: string; lotId: number; personality: number };
  era?: Era;
}

export interface Milestone {
  key: string;
  day: number;
  title: string;
  text: string;
  agent?: number;
  lot?: number;
  /** 3 = a huge early moment, 2 = notable, 1 = routine */
  tier: 1 | 2 | 3;
}

/** Economy-wide numbers captured when a decision is made, to compare with what came after. */
export interface Indicators {
  day: number;
  money: number;
  credit: number;
  mortgages: number;
  businessLoans: number;
  population: number;
  firms: number;
  jobs: number;
  unemployment: number;
  hpi: number;
  construction: number;
  mortgageLending12: number;
  businessLending12: number;
  houseSales12: number;
  defaults12: number;
  /** household debt / annual household income */
  leverage: number;
  capitalRatio: number;
  banks: number;
  genesisShare: number;
}

export interface DecisionRecord {
  id: number;
  day: number;
  /** "Approved Genesis Bank's first $100K business loan." */
  text: string;
  category: 'loan' | 'mortgage' | 'rules' | 'bank' | 'crisis' | 'charter' | 'trouble' | 'policy';
  /** lineage keys of the entities it concerned */
  keys: string[];
  /** indicators at the time */
  before: Indicators;
  /** which indicators matter most for this kind of decision */
  watch: (keyof Indicators)[];
}

/** Running totals behind the money-creation counter. */
export interface MoneyCounters {
  originated: number;
  loansMade: number;
  principalRepaid: number;
  interestPaid: number;
  defaulted: number;
  /** banks paying non-banks for things other than loans: wages, deposit interest, purchases */
  bankSpending: number;
  /** non-banks paying banks for things other than loans: repossessed homes, rent, securities, bank shares */
  boughtFromBanks: number;
  publicIn: number;
  publicOut: number;
  tradeIn: number;
  tradeOut: number;
  /** biggest the money supply has ever been */
  peakMoney: number;
}

export function newCounters(): MoneyCounters {
  return {
    originated: 0,
    loansMade: 0,
    principalRepaid: 0,
    interestPaid: 0,
    defaulted: 0,
    bankSpending: 0,
    boughtFromBanks: 0,
    publicIn: 0,
    publicOut: 0,
    tradeIn: 0,
    tradeOut: 0,
    peakMoney: 0,
  };
}
