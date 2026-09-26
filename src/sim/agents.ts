// Agent state. Behaviour lives in the per-domain modules (households.ts, firms.ts, ...).

import type { Account } from './ledger';
import type { Loan } from './loan';
import type { MbsHolding, Wholesale } from './bank';
import type { Sector, TrailEvent } from './types';

export class Household {
  readonly kind = 'household' as const;
  acct!: Account;
  /** residential unit the household lives in (-1 = none, e.g. just left) */
  homeUnit = -1;
  /** agent id of the employer (firm, bank or treasury), -1 = unemployed */
  employer = -1;
  wage = 0;
  unemployedDays = 0;
  employedDays = 0;
  ownedUnits: number[] = [];
  loans: Loan[] = [];
  fundUnits = 0;
  firms: number[] = [];
  /** smoothed monthly disposable income */
  income = 0;
  incomeThisMonth = 0;
  /** gross labour income received this month */
  wagesThisMonth = 0;
  /** monthly consumption plan */
  budget = 0;
  spentThisMonth = 0;
  spentLastMonth = 0;
  /** expected annual house-price growth (extrapolative) */
  houseExpect = 0.02;
  confidence = 0.7;
  lookingToBuy: 'home' | 'investment' | null = null;
  buyBudget = 0;
  buyPreapprovedBank = -1;
  missedTotal = 0;
  defaults = 0;
  lastDefaultDay = -9999;
  departed = false;
  story: TrailEvent[] = [];
  /** shortfall of desired spending that could not be met (shops full / sold out) */
  unmetThisMonth = 0;
  /** regular shops */
  favs: { retail: number[]; service: number[] } = { retail: [], service: [] };
  /** consecutive months behind on rent */
  rentArrears = 0;
  /** remaining consumer-credit spending to do (durables bought with a loan) */
  durablesToBuy = 0;
  durablesLoan = -1;
  lastReview = 0;
  /** sold their home and plans to buy another */
  movingUp = false;
  /** target liquid wealth (deposits + fund savings) in months of income */
  wealthMonths = 6;
  /** retired: out of the labour force, living on a public pension and savings */
  retired = false;

  constructor(
    public readonly id: number,
    public name: string,
    public readonly skill: number,
    public readonly mpc: number,
    public readonly bufferMonths: number,
    public readonly speculator: number,
    public readonly billingDay: number,
    public readonly arrived: number,
  ) {}

  note(day: number, text: string, tone: TrailEvent['tone'] = 'neutral', amount?: number, agent?: number): void {
    this.story.push({ day, text, tone, amount, agent });
    if (this.story.length > 30) this.story.shift();
  }

  get employed(): boolean {
    return this.employer >= 0;
  }
}

export interface FirmMonth {
  units: number; // units sold (or construction value delivered)
  revenue: number;
  unmet: number; // units of demand turned away
  wages: number;
  inputs: number; // goods / materials bought
  interest: number;
  maintenance: number;
  investment: number;
  dividends: number;
  taxes: number;
}

export function newFirmMonth(): FirmMonth {
  return { units: 0, revenue: 0, unmet: 0, wages: 0, inputs: 0, interest: 0, maintenance: 0, investment: 0, dividends: 0, taxes: 0 };
}

export type FirmStatus = 'planned' | 'open' | 'closed';
export type FirmHealth = 'healthy' | 'strained' | 'distressed';

export class Firm {
  readonly kind = 'firm' as const;
  acct!: Account;
  status: FirmStatus = 'planned';
  health: FirmHealth = 'healthy';
  closedDay = -1;
  openedDay = -1;
  workers: number[] = [];
  /** wage offered/paid per worker per month */
  wage = 4000;
  /** workers the firm wants to hire (positive) or shed (negative) */
  vacancies = 0;
  /** real capital stock, in base-price dollars */
  K = 0;
  /** units of output per worker per month */
  A = 1;
  /** capital per unit of monthly output capacity */
  kappa = 1;
  price = 1;
  inventory = 0;
  expDemand = 0;
  m: FirmMonth = newFirmMonth();
  last: FirmMonth = newFirmMonth();
  /** trailing months, most recent last */
  months: FirmMonth[] = [];
  loans: Loan[] = [];
  project = -1;
  missed = 0;
  story: TrailEvent[] = [];
  hiredCum = 0;
  firedCum = 0;
  /** true while the firm is cutting prices to shift stock */
  discounting = false;
  /** consecutive months with capacity nearly exhausted */
  hotMonths = 0;
  /** consecutive months with losses */
  lossMonths = 0;
  /** today's remaining capacity for sales (retail/service) */
  capToday = 0;
  /** factory: orders received today (units) */
  ordersToday = 0;
  /** builder: construction value delivered today */
  workToday = 0;
  denials = 0;
  lastDenialReason = '';
  /** equity the owner put in */
  ownerEquity = 0;
  /** day of the last monthly review (reviews normalise to a 30-day month) */
  lastReview = 0;

  constructor(
    public readonly id: number,
    public name: string,
    public readonly sector: Sector,
    public readonly subtype: string,
    public lotId: number,
    public ownerId: number,
    public readonly color: string,
    public readonly payday: number,
    public readonly reviewDay: number,
    public readonly founded: number,
  ) {}

  note(day: number, text: string, tone: TrailEvent['tone'] = 'neutral', amount?: number, agent?: number): void {
    this.story.push({ day, text, tone, amount, agent });
    if (this.story.length > 30) this.story.shift();
  }

  get laborCap(): number {
    return this.A * this.workers.length;
  }

  get capitalCap(): number {
    return this.K / this.kappa;
  }

  /** output capacity per month (units, or construction value for builders) */
  get capacity(): number {
    return Math.min(this.laborCap, this.capitalCap);
  }

  debt(): number {
    let s = 0;
    for (const l of this.loans) if (l.active) s += l.balance;
    return s;
  }

  debtService(): number {
    let s = 0;
    for (const l of this.loans) if (l.active) s += l.scheduledPayment();
    return s;
  }
}

/** Investment fund: the city's asset market participant (owned by households via fund units). */
export class Fund {
  readonly kind = 'fund' as const;
  acct!: Account;
  units = 0;
  bills = 0;
  bondPar = 0;
  bondBook = 0;
  bondCoupon = 0.035;
  mbs = new Map<number, MbsHolding>();
  loans: Loan[] = [];
  repos: Wholesale[] = [];
  /** bank shares: the fund owns the equity of every bank */
  bankBonds = new Map<number, number>();
  fear = 0.25;
  navHistory: number[] = [];
  nav = 1;
  lastNav = 1;
  /** $ the fund has bid for MBS/loans this month (limits appetite) */
  boughtThisMonth = 0;
  /** cash income received this month (interest, coupons, dividends) — distributed to unitholders */
  incomeMonth = 0;
  distributedLast = 0;
  /** price paid for each home the fund owns (unit id -> $) */
  homeCost = new Map<number, number>();
  /** extra cash set aside to buy homes that look cheap */
  homeBudget = 0;
  propertyGains = 0;
  constructor(
    public readonly id: number,
    public name: string,
    public lotId: number,
  ) {}
}

export class CentralBank {
  readonly kind = 'cb' as const;
  bills = 0;
  bondPar = 0;
  bondBook = 0;
  bondCoupon = 0.035;
  mbs = new Map<number, MbsHolding>();
  /** loans to banks: bank id -> amount */
  loansToBanks = new Map<number, number>();
  retained = 0;
  qeCum = 0;
  constructor(
    public readonly id: number,
    public name: string,
    public lotId: number,
  ) {}
}

export class Treasury {
  readonly kind = 'treasury' as const;
  /** account at the central bank */
  tga = 0;
  bills = 0; // bills outstanding (liability)
  bondPar = 0; // bonds outstanding (liability)
  bondCoupon = 0.035;
  employees: number[] = [];
  taxesMonth = 0;
  spendMonth = 0;
  interestMonth = 0;
  benefitsMonth = 0;
  taxSmoothed = 0;
  interestSmoothed = 0;
  procurementLast = 0;
  deficitHistory: number[] = [];
  constructor(
    public readonly id: number,
    public name: string,
    public lotId: number,
  ) {}
}

export class DepositInsurer {
  readonly kind = 'dif' as const;
  balance = 0; // account at the central bank
  paidOutCum = 0;
  premiumsCum = 0;
  borrowedFromTreasury = 0;
  constructor(
    public readonly id: number,
    public name: string,
  ) {}
}

/** The world beyond the river: newcomers bring savings from it, leavers take savings to it. */
export class OutsideWorld {
  readonly kind = 'world' as const;
  acct!: Account;
  constructor(
    public readonly id: number,
    public name: string,
  ) {}
}

export class MbsPool {
  loans: Loan[] = [];
  /** outstanding principal of loans still in the pool */
  balance = 0;
  originalBalance = 0;
  /** market price per $ of par */
  price = 1;
  coupon = 0.05;
  lossesCum = 0;
  constructor(
    public readonly id: number,
    public readonly name: string,
    public readonly originatorId: number,
    public readonly day: number,
  ) {}

  recompute(): void {
    let b = 0;
    for (const l of this.loans) if (l.active) b += l.balance;
    this.balance = b;
  }

  delinquency(): number {
    let bad = 0;
    for (const l of this.loans) if (l.status === 'late' || l.status === 'nonperforming') bad += l.balance;
    return this.balance > 0 ? bad / this.balance : 0;
  }
}

export interface UnitListing {
  price: number;
  since: number;
  seller: number; // agent id (household, bank or firm)
  distressed: boolean;
  /** lowest price the seller will accept */
  floor?: number;
}

export class Unit {
  ownerId = -1;
  occupantId = -1;
  rent = 0;
  listing: UnitListing | null = null;
  mortgage: Loan | null = null;
  forRent = false;
  lastSale = { day: -1, price: 0 };
  /** true while the unit is still being built */
  building = false;
  constructor(
    public readonly id: number,
    public readonly lotId: number,
    public readonly quality: number,
    /** value at a house-price index of 1.0 */
    public readonly baseValue: number,
    public readonly baseRent: number,
  ) {}
}

export type ProjectKind = 'expansion' | 'startup' | 'housing' | 'refit';

export class Project {
  progress = 0;
  paid = 0;
  status: 'active' | 'stalled' | 'complete' | 'abandoned' = 'active';
  stalledDays = 0;
  stallReason = '';
  loanId = -1;
  started: number;
  finished = -1;
  /** real construction work (base $) still to do */
  remaining: number;
  /** portion of cost that is equipment bought from factories instead of construction work */
  equipment: number;
  equipmentDelivered = 0;
  constructor(
    public readonly id: number,
    public readonly kind: ProjectKind,
    public readonly lotId: number,
    public readonly clientId: number,
    public builderId: number,
    /** total contract value in $ (nominal at signing) */
    public readonly cost: number,
    /** real construction work in base $ */
    public readonly work: number,
    equipment: number,
    public readonly reason: string,
    day: number,
    /** what gets built: for firms target level; for housing the building type */
    public readonly target: { kind: 'house' | 'apartment' | 'firm'; level: number; units?: number },
  ) {
    this.started = day;
    this.remaining = work;
    this.equipment = equipment;
  }
}
