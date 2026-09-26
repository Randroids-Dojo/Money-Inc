// The Economy owns all simulation state and advances it one day at a time.

import { CFG, DAYS_PER_MONTH } from './config';
import { Account, FIRST_BANK_ORIGIN, Ledger, type LedgerHost } from './ledger';
import { Rng } from './rng';
import type { Bank } from './bank';
import {
  CentralBank,
  DepositInsurer,
  Firm,
  Fund,
  Household,
  MbsPool,
  OutsideWorld,
  Project,
  Treasury,
  Unit,
} from './agents';
import type { Loan } from './loan';
import type { City } from '../world/city';
import type { FlowEvent, FlowKind, NewsItem, NewsTone, PolicySettings, SimEvent, SimEventType } from './types';
import { Stats } from './stats';
import { News } from './news';
import * as markets from './markets';
import * as banking from './banking';
import * as households from './households';
import * as firms from './firms';
import * as housing from './housing';
import * as construction from './construction';
import * as fund from './fund';
import * as pub from './publicSector';
import * as resolution from './resolution';

export type Agent = Household | Firm | Bank | CentralBank | Treasury | Fund | DepositInsurer | OutsideWorld;

export interface MarketState {
  cpi: number;
  cpiHistory: number[]; // monthly
  inflationExpect: number; // annual
  wageIndex: number;
  hpi: number; // house price index (1.0 = base)
  hpiHistory: number[]; // monthly
  hpiExpect: number; // expected annual house price growth
  rentIndex: number;
  lastWageIndex: number;
  commercialIndex: number;
  /** long government bond yield */
  bondYield: number;
  /** smoothed policy rate the bond market extrapolates */
  rateExpect: number;
  billRate: number;
  interbankRate: number;
  /** interbank market freeze indicator 0..1 */
  interbankStress: number;
  /** recent bank failures, decays */
  panic: number;
  consumerConfidence: number;
  unemployment: number;
  vacancyRate: number;
  /** construction price index */
  builderPrice: number;
  factoryPrice: number;
  retailPrice: number;
  servicePrice: number;
  /** trailing sales-weighted demand pressure per sector */
  sectorPressure: Record<string, number>;
  sectorProfit: Record<string, number>;
}

/** Money flows by category, accumulated per month. */
export interface MoneyFlows {
  lending: number; // new loans (created)
  repayment: number; // principal repaid (destroyed)
  interest: number; // interest & fees paid to banks (destroyed)
  bankSpending: number; // bank wages, dividends, deposit interest, purchases (created)
  publicIn: number; // taxes etc paid to public sector (destroyed)
  publicOut: number; // public spending into deposits (created)
  assetSales: number; // non-banks buying assets from banks (destroyed)
  writeDowns: number; // deposits lost in bank failures (destroyed)
  settlement: number; // gross interbank settlement
}

export function newMoneyFlows(): MoneyFlows {
  return {
    lending: 0,
    repayment: 0,
    interest: 0,
    bankSpending: 0,
    publicIn: 0,
    publicOut: 0,
    assetSales: 0,
    writeDowns: 0,
    settlement: 0,
  };
}

export class Economy implements LedgerHost {
  readonly rng: Rng;
  day = 0;
  nextId = 1;
  ledger: Ledger;

  agents = new Map<number, Agent>();
  households: Household[] = [];
  firms: Firm[] = [];
  banks: Bank[] = [];
  cb!: CentralBank;
  treasury!: Treasury;
  fund!: Fund;
  dif!: DepositInsurer;
  world!: OutsideWorld;

  loans = new Map<number, Loan>();
  pools = new Map<number, MbsPool>();
  units: Unit[] = [];
  /** units per lot */
  lotUnits = new Map<number, number[]>();
  projects = new Map<number, Project>();
  /** lot id -> what occupies it */
  lotUse = new Map<number, { type: 'firm' | 'res' | 'bank' | 'cb' | 'fund' | 'cityhall' | 'park' | 'project'; id: number }>();

  market: MarketState;
  policy: PolicySettings;
  stats: Stats;
  news: News;

  flowsMonth: MoneyFlows = newMoneyFlows();
  flowsLast: MoneyFlows = newMoneyFlows();
  /** gross settlement between bank pairs today (for visuals), key "a-b" */
  settlementToday = new Map<string, number>();

  /** buffers drained by the renderer */
  recordVisuals = true;
  flowBuffer: FlowEvent[] = [];
  eventBuffer: SimEvent[] = [];

  publicBalances = { treasury: 0, dif: 0 };
  treasuryId = 0;
  difId = 0;
  cbId = 0;

  /** counters for this month */
  monthCounters = {
    defaults: 0,
    defaultValue: 0,
    firmOpenings: 0,
    firmClosures: 0,
    bankFailures: 0,
    arrivals: 0,
    departures: 0,
    houseSales: 0,
    newLoans: 0,
    newLoanValue: 0,
    loansDenied: 0,
    consumption: 0,
    investment: 0,
    governmentSpend: 0,
    constructionWork: 0,
    housingWork: 0,
    layoffs: 0,
    hires: 0,
    unmetDemand: 0,
  };
  /** day a new firm last entered each sector */
  lastEntry: Record<string, number> = {};
  /** MBS pools packaged so far (for pool names) */
  poolSeq = 0;
  /** this month's house sale prices relative to base value (drives the house-price index) */
  houseSaleRatios: number[] = [];
  lastFailureDay = -9999;
  lastCharterDay = -9999;
  initialBankCount = 4;
  /** invariant checking in development/test runs */
  checkInvariants = false;

  constructor(
    seed: number,
    public readonly city: City,
    policy: PolicySettings,
  ) {
    this.rng = new Rng(seed);
    this.ledger = new Ledger(this);
    this.policy = policy;
    this.market = {
      cpi: 1,
      cpiHistory: [],
      inflationExpect: CFG.inflationTarget,
      wageIndex: CFG.baseWage,
      hpi: 1,
      hpiHistory: [],
      hpiExpect: 0.025,
      rentIndex: 1,
      lastWageIndex: 0,
      commercialIndex: 1,
      bondYield: policy.policyRate + 0.01,
      rateExpect: policy.policyRate,
      billRate: policy.policyRate,
      interbankRate: policy.policyRate,
      interbankStress: 0,
      panic: 0,
      consumerConfidence: 0.7,
      unemployment: 0.05,
      vacancyRate: 0.05,
      builderPrice: 1,
      factoryPrice: 1,
      retailPrice: 1,
      servicePrice: 1,
      sectorPressure: { retail: 0.85, service: 0.85, factory: 0.85, builder: 0.85 },
      sectorProfit: { retail: 0.08, service: 0.08, factory: 0.08, builder: 0.08 },
    };
    this.stats = new Stats();
    this.news = new News();
  }

  // ------------------------------------------------------------------ ids & lookup

  newId(): number {
    return this.nextId++;
  }

  register(a: Agent): void {
    this.agents.set(a.id, a);
  }

  get dom(): number {
    return this.day % DAYS_PER_MONTH;
  }

  get month(): number {
    return Math.floor(this.day / DAYS_PER_MONTH);
  }

  household(id: number): Household | undefined {
    const a = this.agents.get(id);
    return a && a.kind === 'household' ? a : undefined;
  }

  firm(id: number): Firm | undefined {
    const a = this.agents.get(id);
    return a && a.kind === 'firm' ? a : undefined;
  }

  bank(id: number): Bank | undefined {
    const a = this.agents.get(id);
    return a && a.kind === 'bank' ? a : undefined;
  }

  aliveBanks(): Bank[] {
    return this.banks.filter((b) => b.alive);
  }

  /** Lot where an agent is physically located (for visuals). */
  lotOf(id: number): number {
    const a = this.agents.get(id);
    if (!a) return -1;
    switch (a.kind) {
      case 'household': {
        const u = this.units[a.homeUnit];
        return u ? u.lotId : -1;
      }
      case 'firm':
      case 'bank':
      case 'cb':
      case 'treasury':
      case 'fund':
        return a.lotId;
      case 'dif':
        return this.cb.lotId;
      case 'world':
        return -1;
    }
  }

  nameOf(id: number): string {
    const a = this.agents.get(id);
    if (!a) return 'Unknown';
    return a.name;
  }

  openAccount(ownerId: number, bank: Bank): Account {
    return new Account(ownerId, bank);
  }

  // ------------------------------------------------------------------ ledger host

  recordFlow(from: number, to: number, amount: number, kind: FlowKind, loan?: number): void {
    if (!this.recordVisuals) return;
    if (this.flowBuffer.length > 20000) this.flowBuffer.splice(0, 5000);
    this.flowBuffer.push({ day: this.day, from, to, amount, kind, loan });
  }

  recordSettlement(from: Bank, to: Bank, amount: number): void {
    this.flowsMonth.settlement += amount;
    if (!this.recordVisuals) return;
    const key = from.id < to.id ? `${from.id}-${to.id}` : `${to.id}-${from.id}`;
    const sign = from.id < to.id ? 1 : -1;
    this.settlementToday.set(key, (this.settlementToday.get(key) ?? 0) + sign * amount);
  }

  recordCreation(amount: number, kind: FlowKind, _origin: number): void {
    const f = this.flowsMonth;
    if (kind === 'loan') f.lending += amount;
    else if (_origin >= FIRST_BANK_ORIGIN) f.bankSpending += amount;
    else f.publicOut += amount;
  }

  recordDestruction(amount: number, kind: FlowKind, _origins: Float64Array | null): void {
    const f = this.flowsMonth;
    if (kind === 'principal') f.repayment += amount;
    else if (kind === 'interest' || kind === 'rent') f.interest += amount;
    else if (kind === 'tax' || kind === 'resolution') f.publicIn += amount;
    else f.assetSales += amount;
  }

  event(type: SimEventType, agent: number, amount?: number, other?: number, text?: string): void {
    if (!this.recordVisuals) return;
    if (this.eventBuffer.length > 5000) this.eventBuffer.splice(0, 1000);
    this.eventBuffer.push({ day: this.day, type, agent, amount, other, text });
  }

  headline(text: string, tone: NewsTone, agent?: number, lot?: number, key?: string, cooldownDays = 0): NewsItem | null {
    return this.news.add(this.day, text, tone, agent, lot, key, cooldownDays);
  }

  // ------------------------------------------------------------------ simulation step

  step(): void {
    this.day++;
    const dom = this.dom;
    if (this.recordVisuals) this.settlementToday.clear();

    markets.dailyMarkets(this);

    // production & trade
    firms.startOfDay(this);
    markets.shoppingDay(this);
    firms.restockDay(this);
    construction.constructionDay(this);

    // incomes
    firms.payWages(this, dom);
    pub.publicDaily(this, dom);
    households.billingDay(this, dom);

    // debt service
    banking.loanPaymentsDay(this, dom);

    // staggered decisions
    firms.reviews(this, dom);
    households.reviews(this, dom);
    markets.labourMarketDay(this);
    if (this.day % 7 === 0) housing.housingMarketWeek(this);

    // finance
    fund.fundDaily(this);
    banking.banksDaily(this);
    pub.cbDaily(this);

    if (dom === DAYS_PER_MONTH - 1) {
      this.endOfMonth();
      banking.liquiditySweep(this);
    }
    if (this.checkInvariants) this.assertInvariants();
  }

  private endOfMonth(): void {
    banking.monthlyInterest(this);
    pub.treasuryMonthly(this);
    pub.cbMonthly(this);
    markets.monthlyIndices(this);
    for (const b of this.banks) if (b.alive) banking.bankMonthly(this, b);
    fund.fundMonthly(this);
    firms.entryMonthly(this);
    construction.developmentMonthly(this);
    households.migrationMonthly(this);
    resolution.charterMonthly(this);
    housing.housingMonthly(this);
    this.stats.snapshot(this);
    this.news.macro(this);
    this.flowsLast = this.flowsMonth;
    this.flowsMonth = newMoneyFlows();
    for (const k of Object.keys(this.monthCounters) as (keyof Economy['monthCounters'])[]) this.monthCounters[k] = 0;
  }

  // ------------------------------------------------------------------ aggregates

  broadMoney(): number {
    let s = 0;
    for (const b of this.banks) s += b.deposits;
    return s;
  }

  baseMoney(): number {
    let s = this.publicBalances.treasury + this.publicBalances.dif;
    for (const b of this.banks) s += b.reserves;
    return s;
  }

  totalCredit(): number {
    let s = 0;
    for (const l of this.loans.values()) if (l.active) s += l.balance;
    return s;
  }

  unemploymentRate(): number {
    let lf = 0;
    let u = 0;
    for (const h of this.households) {
      if (h.departed || h.retired) continue;
      lf++;
      if (!h.employed) u++;
    }
    return lf ? u / lf : 0;
  }

  population(): number {
    let n = 0;
    for (const h of this.households) if (!h.departed) n++;
    return n;
  }

  // ------------------------------------------------------------------ invariants

  assertInvariants(): void {
    const errs = banking.checkBooks(this);
    if (errs.length) throw new Error(`Invariant violation on day ${this.day}:\n${errs.join('\n')}`);
  }
}
