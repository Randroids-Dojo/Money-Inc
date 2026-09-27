// Genesis Mode: an economy that starts with one bank, one would-be business and one worker, and
// grows transaction by transaction. This object sits beside the standard simulation: the same
// banks, firms, households and markets do the work, while Genesis
//   - turns key moments into decisions for the player (loan applications, trouble, runs, failures),
//   - records the economy's lineage (who financed, employed, housed and bought from whom),
//   - keeps the money-creation counter and the milestones of the town's history,
//   - supplies what a brand-new town needs: trade with the wider region, newcomers, charters.

import { CFG, DAYS_PER_MONTH, DAYS_PER_YEAR } from '../config';
import type { Economy } from '../economy';
import type { Household, Firm, Project, Unit, MbsPool } from '../agents';
import { netIncome, type Bank } from '../bank';
import type { Loan } from '../loan';
import type { FlowKind, LoanPurpose, Sector, EmergencyLiquidity } from '../types';
import { INSURANCE_LIMITS } from '../types';
import { FIRST_BANK_ORIGIN, ORIGIN_LEGACY, type MoneySink } from '../ledger';
import { invalidateMetrics, metrics, originate, requestLoan, shopForLoan, setStandards, type LoanApp, type LoanDecision, type LoanOffer, type LoanRequestOpts } from '../banking';
import { fire, hire } from '../markets';
import { createHousehold, departHousehold } from '../households';
import { findRental, vacantRentals } from '../housing';
import { startCompanyHomes, startProject, startSelfBuild } from '../construction';
import { Unit as UnitClass } from '../agents';
import { debtService } from '../housing';
import { firmProfit } from '../markets';
import { monthlyCosts } from '../firms';
import { fmtMoney, pct } from '../format';
import { Lineage, nodeKey, type LKind } from './lineage';
import { personName } from './names';
import { exportsDay } from './trade';
import {
  draftStartup,
  expansionFigures,
  findOpportunities,
  newTradeMonth,
  registerProspect,
  startupFigures,
  buildPrice,
  equipPrice,
  freeLots,
  pickNearLot,
  type TradeMonth,
} from './plans';
import { buildReview, decideLoan, loanLabel } from './review';
import {
  applyCharter,
  applyConstraint,
  applyFailure,
  applyRun,
  applyTrouble,
  bridgeBank,
  constraintOptions,
  draftCharter,
  failureOptions,
  overnightSupport,
  recapitaliseBridge,
  runOptions,
  troubleOptions,
} from './crisis';
import {
  ERA_INFO,
  newCounters,
  type BusinessPlan,
  type DecisionRecord,
  type Era,
  type GenesisRules,
  type Indicators,
  type LoanChoice,
  type Milestone,
  type Situation,
} from './types';

export const GENESIS_BANK_NAME = 'Genesis Bank';

const REVIEWABLE: LoanPurpose[] = ['startup', 'expansion', 'home', 'investment_property', 'development'];

export class Genesis {
  readonly eco: Economy;
  era: Era = 'transactions';
  rules: GenesisRules = {
    maxLTV: 0.8,
    maxDTI: 0.36,
    maxPD: 0.12,
    minDSCR: 1.2,
    securitization: false,
    review: 'all',
    reviewThreshold: 150_000,
    dividends: true,
  };
  lineage = new Lineage();
  counters = newCounters();
  situations: Situation[] = [];
  decisions: DecisionRecord[] = [];
  milestones: Milestone[] = [];
  /** monthly indicators (for "what happened after" a decision) */
  history: Indicators[] = [];
  trade: TradeMonth = newTradeMonth();
  recent: TradeMonth[] = [];
  /** the region's appetite for the town's goods (units a month) and its business cycle */
  exportBase = 7_000;
  regionMood = 0;
  genesisBankId = -1;
  founderId = -1;
  firstWorkerId = -1;
  firstBusinessId = -1;
  // ---- measures the player has imposed on particular banks
  freezeUntil = new Map<number, number>();
  spreadAdd = new Map<number, { add: number; until: number }>();
  retainUntil = new Map<number, number>();
  elaUntil = new Map<number, number>();
  forbearUntil = new Map<number, number>();
  allowFail = new Set<number>();
  /** public bridge banks opened by the deposit insurer (they are recapitalised, not closed) */
  bridges = new Set<number>();
  /** borrower id -> the troubled loan that a rescue loan follows on from */
  successorOf = new Map<number, number>();
  /** deposits that fled to banks elsewhere, by owner (they come home when things calm down) */
  fled = new Map<number, number>();
  nextCharterDay = 540;
  entryCooldownUntil = 0;
  nextFoundingDay = 0;
  foundingAttempts = 0;
  /** set when a blocking situation opens; the game shell pauses and clears it */
  pauseRequested = false;
  macroNews = false;
  /** businesses are hiring but newcomers have nowhere to live (updated monthly) */
  housingShortage = false;
  /** an investment fund has set up in town (it takes savings once the town is big enough) */
  fundOpen = false;
  private nextSit = 1;
  private nextDec = 1;
  private reviewed = new Set<LoanPurpose>();
  private troubleRaised = new Set<number>();
  private constraintRaised = new Map<number, number>();
  private runRaised = new Map<number, number>();
  private failureOpen = new Map<number, number>();
  private flags = new Set<string>();
  private homeOf = new Map<number, number>();
  /** months each firm has had jobs open while newcomers had nowhere to live */
  private vacMonths = new Map<number, number>();
  private homesCooldown = new Map<number, number>();
  private lastRaise = new Map<number, number>();
  /** families waiting to hear whether they can build */
  private selfBuilders = new Set<number>();
  private spendSeen = new Map<string, number>();
  /** loans that were ever in a Genesis review, and whether the player decided them */
  private streets: string[] = [];

  constructor(eco: Economy) {
    this.eco = eco;
    this.streets = streetNames(eco.city.name);
  }

  // ============================================================================ situations

  open(): Situation[] {
    return this.situations.filter((s) => s.status === 'open');
  }

  situation(id: number): Situation | undefined {
    return this.situations.find((s) => s.id === id);
  }

  private add(s: Omit<Situation, 'id' | 'day' | 'status'>): Situation {
    const sit: Situation = { ...s, id: this.nextSit++, day: this.eco.day, status: 'open' };
    this.situations.push(sit);
    if (this.situations.length > 400) {
      const i = this.situations.findIndex((x) => x.status !== 'open');
      if (i >= 0) this.situations.splice(i, 1);
    }
    if (sit.blocking) this.pauseRequested = true;
    return sit;
  }

  /** Player decision on a loan situation (approve with terms, or refuse). */
  decideLoan(id: number, c: LoanChoice): string | null {
    const s = this.situation(id);
    if (!s || s.status !== 'open' || !s.loan) return 'This application has already been decided.';
    return decideLoan(this, s, c, true);
  }

  /** Player decision on an action situation (trouble, constraint, run, failure, charter, era). */
  decideAction(id: number, action: string, byPlayer = true): string | null {
    const s = this.situation(id);
    if (!s || s.status !== 'open') return 'Already decided.';
    const opt = s.options?.find((o) => o.id === action);
    if (opt?.disabled) return opt.disabled;
    const eco = this.eco;
    let outcome = '';
    s.status = byPlayer ? 'decided' : 'expired';
    switch (s.kind) {
      case 'trouble': {
        const l = eco.loans.get(s.loanId ?? -1);
        if (!l) return null;
        outcome = applyTrouble(this, l, action as never);
        if (byPlayer && action !== 'wait') this.record(troubleText(eco, l, action), 'trouble', [nodeKey('loan', l.id), nodeKey(eco.firm(l.borrowerId) ? 'firm' : 'household', l.borrowerId)], ['defaults12', 'businessLending12', 'jobs']);
        break;
      }
      case 'constraint': {
        const b = eco.bank(s.bankId ?? -1);
        if (!b) return null;
        outcome = applyConstraint(this, b, action as never);
        if (byPlayer) this.record(`${b.name}: ${constraintText(action)}.`, 'bank', [nodeKey('bank', b.id)], ['credit', 'businessLending12', 'mortgageLending12', 'capitalRatio']);
        break;
      }
      case 'run': {
        const b = eco.bank(s.bankId ?? -1);
        if (!b) return null;
        outcome = applyRun(this, b, action as never);
        if (byPlayer) this.record(runText(b, action), 'crisis', [nodeKey('bank', b.id)], ['money', 'credit', 'unemployment', 'banks']);
        break;
      }
      case 'failure': {
        const b = eco.bank(s.bankId ?? -1);
        if (!b) return null;
        this.failureOpen.delete(b.id);
        outcome = applyFailure(this, b, action as never, s.text.includes('cash') ? 'liquidity' : 'insolvency');
        if (byPlayer) this.record(failureText(b, action), 'crisis', [nodeKey('bank', b.id)], ['money', 'credit', 'unemployment', 'firms', 'banks']);
        break;
      }
      case 'charter': {
        outcome = applyCharter(this, s, action as never);
        if (byPlayer || action !== 'reject') this.record(action === 'reject' ? `Refused a banking licence to ${s.charter!.name}.` : `Granted a banking licence to ${s.charter!.name}.`, 'charter', [], ['banks', 'credit', 'genesisShare']);
        break;
      }
      case 'era':
        outcome = 'Noted.';
        break;
      default:
        break;
    }
    s.outcome = outcome;
    return null;
  }

  // ============================================================================ loan reviews

  /** Should this application go to the player's desk? */
  private shouldReview(app: LoanApp): boolean {
    if (!REVIEWABLE.includes(app.purpose)) return false;
    switch (this.rules.review) {
      case 'all':
        return true;
      case 'large':
        return app.amount >= this.rules.reviewThreshold || !this.reviewed.has(app.purpose);
      default:
        return false;
    }
  }

  markReviewed(p: LoanPurpose): void {
    this.reviewed.add(p);
  }

  /** Is an application from this borrower waiting on the player's desk? */
  hasPendingLoan(borrowerId: number): boolean {
    return this.situations.some((s) => s.status === 'open' && s.kind === 'loan' && s.loan?.app.borrower.id === borrowerId);
  }

  /**
   * Called by the simulation when a borrower asks for credit. Returns true when Genesis has taken
   * the application to the player's desk; `done` will run once it is decided.
   */
  reviewLoan(app: LoanApp, opts: LoanRequestOpts, done: (d: LoanDecision, app: LoanApp) => void): boolean {
    const eco = this.eco;
    if (!this.shouldReview(app)) return false;
    const openLoans = this.open().filter((s) => s.kind === 'loan').length;
    if (openLoans >= 5) return false;
    const ctx = (opts.context ?? {}) as { plan?: BusinessPlan; unit?: Unit; price?: number; sellerId?: number; investment?: boolean; lotId?: number; units?: number; saleValue?: number; reason?: string; homes?: boolean; build?: boolean };
    let title = '';
    let text = '';
    let lotId = eco.lotOf(app.borrower.id);
    const extra: Parameters<typeof buildReview>[4] = {};
    const b = app.borrower;
    if (app.purpose === 'startup' && ctx.plan) {
      extra.plan = ctx.plan;
      lotId = ctx.plan.lotId;
      const owner = eco.household(ctx.plan.ownerId);
      title = `${ctx.plan.name} asks for ${fmtMoney(app.amount)}`;
      text = `${owner?.name ?? 'An entrepreneur'} wants to open ${ctx.plan.name}, which ${ctx.plan.pitch}.${ctx.reason ? ` ${ctx.reason}.` : ''}`;
    } else if (app.purpose === 'expansion' && b.kind === 'firm') {
      extra.plan = expansionPlan(eco, b, app, (opts.context as { expansion?: BusinessPlan['expansion'] } | undefined)?.expansion);
      title = `${b.name} wants to expand`;
      text = `${b.name} is running flat out and turning customers away. It asks for ${fmtMoney(app.amount)} to add capacity.`;
    } else if (app.purpose === 'home' && b.kind === 'household' && ctx.build && ctx.lotId !== undefined) {
      extra.home = { unitId: -1, lotId: ctx.lotId, price: ctx.price ?? app.amount, cash: b.acct.balance, income: app.income, sellerId: -1, investment: false, build: true };
      lotId = ctx.lotId;
      const first = !this.flags.has('first_mortgage');
      title = first ? `The town's first mortgage?` : `${b.name} wants to build a home`;
      text = `${b.name}${b.lodging ? ', who boards with a family,' : ''} wants to have a home built at ${this.lotAddress(ctx.lotId)} for ${fmtMoney(extra.home.price)}, and asks ${app.borrower.acct.bank.name} for a ${fmtMoney(app.amount)} mortgage to pay for it.`;
      b.buyPending = true;
    } else if ((app.purpose === 'home' || app.purpose === 'investment_property') && b.kind === 'household' && ctx.unit) {
      const u = ctx.unit;
      extra.home = { unitId: u.id, lotId: u.lotId, price: ctx.price ?? app.amount, cash: b.acct.balance, income: app.income, sellerId: ctx.sellerId ?? -1, investment: !!ctx.investment };
      lotId = u.lotId;
      const first = !this.flags.has('first_mortgage');
      title = first ? `The town's first mortgage?` : `${b.name} wants a mortgage`;
      text = `${b.name} wants to buy ${this.address(u.id)} for ${fmtMoney(extra.home.price)}${ctx.investment ? ' to rent it out' : ''} and asks ${app.borrower.acct.bank.name} for a ${fmtMoney(app.amount)} mortgage.`;
      if (u.listing) u.listing.pending = -1;
      b.buyPending = true;
    } else if (app.purpose === 'development' && b.kind === 'firm' && ctx.homes) {
      extra.dev = { units: ctx.units ?? 1, cost: app.amount, saleValue: ctx.saleValue ?? app.collateral.value, lotId: ctx.lotId ?? lotId, homes: true };
      lotId = extra.dev.lotId;
      title = `${b.name} wants to build a cottage for its workers`;
      text = `${b.name} has jobs it cannot fill: there is nowhere in ${eco.city.name} for newcomers to live. It asks for ${fmtMoney(app.amount)} to build a cottage it will let to a worker.`;
    } else if (app.purpose === 'development' && b.kind === 'firm') {
      extra.dev = { units: ctx.units ?? 1, cost: app.amount, saleValue: ctx.saleValue ?? app.collateral.value, lotId: ctx.lotId ?? lotId };
      lotId = extra.dev.lotId;
      title = `${b.name} wants to build ${extra.dev.units > 1 ? `${extra.dev.units} homes` : 'a house'}`;
      text = `${b.name} asks for ${fmtMoney(app.amount)} to build ${extra.dev.units > 1 ? `${extra.dev.units} apartments` : 'a house'} to sell, expecting about ${fmtMoney(extra.dev.saleValue)} for them.`;
    } else {
      title = `${b.name} asks for a ${loanLabel(app.purpose)}`;
      text = `${b.name} asks for ${fmtMoney(app.amount)}: ${app.what}.`;
    }
    const wrapped = (d: LoanDecision, a: LoanApp) => {
      if (extra.home) {
        const u = extra.home.unitId >= 0 ? eco.units[extra.home.unitId] : undefined;
        if (u?.listing && u.listing.pending === -1) u.listing.pending = undefined;
        if (b.kind === 'household') b.buyPending = false;
      }
      done(d, a);
    };
    const r = buildReview(this, app, app.purpose, wrapped, extra);
    if (!r) {
      if (extra.home) {
        const u = extra.home.unitId >= 0 ? eco.units[extra.home.unitId] : undefined;
        if (u?.listing) u.listing.pending = undefined;
        if (b.kind === 'household') b.buyPending = false;
      }
      return false;
    }
    // until the town has its first business, nothing happens without the player: the world waits
    const founding = app.purpose === 'startup' && this.firstBusinessId < 0;
    r.first = founding && this.counters.loansMade === 0;
    this.add({
      kind: 'loan',
      deadline: founding ? Infinity : eco.day + (app.purpose === 'home' || app.purpose === 'investment_property' ? 21 : 30),
      blocking: founding,
      title,
      text,
      subject: app.borrower.id,
      lotId,
      loan: r,
    });
    return true;
  }

  // ============================================================================ founding & new businesses

  /** The town's first business plan (and later attempts if the player turns it down). */
  startFounding(): void {
    const eco = this.eco;
    const founder = eco.household(this.founderId);
    const worker = eco.household(this.firstWorkerId);
    if (!founder || founder.departed) return;
    const attempt = this.foundingAttempts;
    const lot = this.firstLot();
    const ideas: { name: string; subtype: string; staff: number; owner: Household; pitch: string }[] = [
      { name: 'Foundry Works', subtype: 'steel', staff: 2, owner: founder, pitch: 'will cast iron parts and tools to sell to buyers across the river' },
      { name: 'Foundry Works', subtype: 'steel', staff: 1, owner: founder, pitch: 'will start small, casting parts and tools to sell across the river' },
      { name: 'Riverside Timber Mill', subtype: 'furniture', staff: 2, owner: worker && !worker.departed ? worker : founder, pitch: 'will saw timber and make furniture to sell across the river' },
    ];
    const idea = ideas[Math.min(attempt, ideas.length - 1)];
    const plan = draftStartup(eco, idea.owner, 'factory', {
      name: idea.name,
      subtype: idea.subtype,
      lot: lot ?? undefined,
      staff: idea.staff,
      equity: 0,
      A: 8000,
      kappa: 5.5,
      budget: [100_000, 60_000, 90_000][Math.min(attempt, 2)],
      pitch: idea.pitch,
      market: 'Buyers in the wider region (exports), later local shops and builders',
    });
    if (!plan) return;
    if (worker && idea.owner !== worker && idea.staff > 1) plan.staffNames = [idea.owner.name, worker.name];
    const f = registerProspect(eco, plan);
    eco.lotUse.set(plan.lotId, { type: 'firm', id: f.id });
    this.lineage.node('firm', f.id, f.name, eco.day, plan.lotId, 'proposed');
    const app = this.startupApp(f, plan);
    app.termMonths = 120;
    // with no savings to put in, the founder offers their own home as security
    const home = eco.units[idea.owner.homeUnit];
    if (home && home.ownerId === idea.owner.id && !home.mortgage) app.collateral = { kind: 'property', ref: home.id, value: home.baseValue * home.quality * eco.market.hpi };
    const done = (d: LoanDecision, fin: LoanApp) => {
      if (d.offer) this.launchStartup(plan, d.offer, fin);
      else this.abandonProspect(plan, true);
    };
    if (!this.reviewLoan(app, { review: 'startup', context: { plan } }, done)) done(shopForLoan(eco, app), app);
  }

  private firstLot() {
    const eco = this.eco;
    const b = eco.bank(this.genesisBankId);
    const c = eco.city.lots[b ? b.lotId : eco.cb.lotId];
    const cands = eco.city.lots.filter((l) => l.zone === 'ind' && l.w >= 2 && !l.reserved && !eco.lotUse.has(l.id));
    if (!cands.length) return null;
    return cands.reduce((a, l) => (Math.hypot(l.x - c.x, l.y - c.y) < Math.hypot(a.x - c.x, a.y - c.y) ? l : a));
  }

  startupApp(f: Firm, plan: BusinessPlan): LoanApp {
    const fig = plan.base;
    return {
      borrower: f,
      kind: 'business',
      purpose: 'startup',
      amount: fig.loan,
      termMonths: 120,
      amortizing: true,
      collateral: { kind: 'business', ref: f.id, value: fig.equipment * 0.5 + fig.premises * 0.4 },
      income: 0,
      projected: fig.revenue - fig.wages - fig.inputs,
      existingDebtService: 0,
      existingDebt: 0,
      what: `starting ${plan.name}`,
      equityShare: fig.cost > 0 ? fig.equity / fig.cost : 0,
    };
  }

  /** A start-up plan is approved: the owner puts in savings, the bank lends, building begins. */
  launchStartup(plan: BusinessPlan, offer: LoanOffer | null, fin: LoanApp | null): Firm | null {
    const eco = this.eco;
    const f = eco.firm(plan.firmId);
    const owner = eco.household(plan.ownerId);
    if (!f || !owner || owner.departed) return null;
    if (!eco.firms.includes(f)) eco.firms.push(f);
    const equity = Math.min(plan.base.equity, Math.max(0, owner.acct.balance));
    if (equity > 0) eco.ledger.transfer(owner.acct, f.acct, equity, 'capital');
    f.ownerEquity = equity;
    let loanId = -1;
    let loanAmt = 0;
    if (offer && fin && fin.amount > 0) {
      const loan = originate(eco, offer, fin);
      loanId = loan.id;
      loanAmt = fin.amount;
    }
    const fig = startupFigures(eco, { ...plan, base: { ...plan.base, equity } }, loanAmt, offer?.rate ?? eco.policy.policyRate + 0.03, fin?.termMonths ?? 96);
    const buildWork = fig.premises / buildPrice(eco);
    const equipment = fig.equipment / equipPrice(eco);
    eco.lotUse.set(plan.lotId, { type: 'firm', id: f.id });
    owner.firms.push(f.id);
    owner.note(eco.day, `Started a business: ${f.name}`, 'good', equity, f.id);
    f.note(eco.day, `Founded by ${owner.name}${loanId >= 0 ? ` with a ${fmtMoney(loanAmt)} loan from ${offer!.bank.name}` : ' with their own savings'}`, 'good', loanAmt, offer?.bank.id);
    const p = startProject(eco, 'startup', plan.lotId, f.id, fig.premises + fig.equipment, buildWork, equipment, `${owner.name} saw a chance: ${plan.pitch}`, { kind: 'firm', level: 1 });
    if (p) {
      p.loanId = loanId;
      f.project = p.id;
    }
    this.lineage.node('firm', f.id, f.name, eco.day, plan.lotId, `${f.sector} · ${f.subtype}`);
    this.hh(owner);
    this.lineage.edge('founded', nodeKey('household', owner.id), nodeKey('firm', f.id), eco.day, equity, equity > 0 ? `founded it with ${fmtMoney(equity)} of savings` : 'founded it');
    if (this.firstBusinessId < 0) {
      this.firstBusinessId = f.id;
      // the next entrepreneur waits to see how the first one does
      this.entryCooldownUntil = eco.day + 180;
    }
    eco.headline(`${owner.name} starts building ${f.name}`, 'good', f.id, plan.lotId, `found-${f.id}`, 0);
    return f;
  }

  abandonProspect(plan: BusinessPlan, founding = false): void {
    const eco = this.eco;
    const f = eco.firm(plan.firmId);
    if (f && !eco.firms.includes(f)) {
      eco.agents.delete(f.id);
      const use = eco.lotUse.get(plan.lotId);
      if (use && use.type === 'firm' && use.id === f.id) eco.lotUse.delete(plan.lotId);
      this.lineage.end(nodeKey('firm', f.id), eco.day, 'never opened: no loan');
    }
    const owner = eco.household(plan.ownerId);
    owner?.note(eco.day, `Plans for ${plan.name} fell through: no loan`, 'bad');
    if (founding || this.firstBusinessId < 0) {
      this.foundingAttempts++;
      this.nextFoundingDay = eco.day + 60 + eco.rng.int(0, 30);
    }
  }

  private entryMonthly(): void {
    const eco = this.eco;
    if (this.firstBusinessId < 0) {
      const pending = this.open().some((s) => s.kind === 'loan' && s.loan?.purpose === 'startup');
      if (!pending && eco.day >= this.nextFoundingDay) this.startFounding();
      return;
    }
    if (eco.day < this.entryCooldownUntil) return;
    const openStartups = this.open().filter((s) => s.kind === 'loan' && s.loan?.purpose === 'startup').length;
    if (openStartups >= (this.era === 'transactions' ? 1 : 2)) return;
    const opps = findOpportunities(eco, this.recent);
    if (!opps.length) return;
    const o = opps.length > 1 && eco.rng.chance(0.35) ? opps[1] : opps[0];
    const owner = this.pickEntrepreneur(o.sector) ?? this.newcomer(true, true);
    if (!owner) return;
    const plan = draftStartup(eco, owner, o.sector, { staff: o.staff });
    if (!plan) return;
    const f = registerProspect(eco, plan);
    eco.lotUse.set(plan.lotId, { type: 'firm', id: f.id });
    this.lineage.node('firm', f.id, f.name, eco.day, plan.lotId, 'proposed');
    const app = this.startupApp(f, plan);
    const done = (d: LoanDecision, fin: LoanApp) => {
      if (d.offer) this.launchStartup(plan, d.offer, fin);
      else if (plan.base.equity >= plan.base.cost * 0.6) this.launchStartup({ ...plan, base: { ...plan.base } }, null, null);
      else this.abandonProspect(plan);
    };
    if (app.amount <= 0) done({}, app);
    else if (!this.reviewLoan(app, { review: 'startup', context: { plan, reason: o.reason } }, done)) done(shopForLoan(eco, app), app);
    const pop = eco.population();
    this.entryCooldownUntil = eco.day + Math.max(25, 110 - pop * 0.8) + eco.rng.int(0, 30);
  }

  /**
   * Company housing: an employer that has had jobs open for months while newcomers have nowhere to
   * live borrows to have a cottage built, and lets it.
   */
  private companyHousing(): void {
    const eco = this.eco;
    for (const f of eco.firms) {
      if (f.status !== 'open') continue;
      this.vacMonths.set(f.id, f.vacancies > 0 && this.housingShortage ? (this.vacMonths.get(f.id) ?? 0) + 1 : 0);
    }
    if (!this.housingShortage) return;
    // a few employers can be building at once in a bigger town
    let building = 0;
    for (const p of eco.projects.values()) if (p.kind === 'homes' && (p.status === 'active' || p.status === 'stalled')) building++;
    building += this.open().filter((s) => s.kind === 'loan' && s.loan?.dev?.homes).length;
    if (building >= Math.max(1, Math.floor(eco.population() / 12))) return;
    const busy = new Set<number>();
    for (const p of eco.projects.values()) if (p.kind === 'homes' && (p.status === 'active' || p.status === 'stalled')) busy.add(p.clientId);
    // only an established employer can carry a house on its books: a few staff already, one home
    // for every three of them at most, and profits well above what the loan would cost
    const owned = new Map<number, number>();
    for (const u of eco.units) if (u.ownerId >= 0 && eco.firm(u.ownerId)) owned.set(u.ownerId, (owned.get(u.ownerId) ?? 0) + 1);
    const cottagePayment = (CFG.houseBaseValue * CFG.devCostRatio * buildPrice(eco) * 0.8 * (eco.policy.policyRate + 0.035)) / 12 + (CFG.houseBaseValue * CFG.devCostRatio * buildPrice(eco) * 0.8) / 180;
    const cands = eco.firms.filter(
      (f) =>
        f.status === 'open' &&
        f.sector !== 'builder' &&
        !busy.has(f.id) &&
        f.vacancies > 0 &&
        f.workers.length >= 2 &&
        (owned.get(f.id) ?? 0) < Math.max(1, Math.floor(f.workers.length / 2)) &&
        (this.vacMonths.get(f.id) ?? 0) >= 3 &&
        f.health === 'healthy' &&
        firmProfit(eco, f) > 1.2 * cottagePayment &&
        f.debtService() + cottagePayment < 0.5 * Math.max(1, f.last.revenue - f.last.wages - f.last.inputs) &&
        eco.day >= (this.homesCooldown.get(f.id) ?? 0) &&
        !this.hasPendingLoan(f.id),
    );
    if (!cands.length) return;
    const f = cands.reduce((a, b) => (b.vacancies > a.vacancies ? b : a));
    const lot = pickNearLot(eco, freeLots(eco, 'res', false));
    if (!lot) return;
    const cottage = eco.population() < 20 ? 0.7 : 1;
    const base = CFG.houseBaseValue * cottage;
    const quality = 1 + 0.1 * eco.rng.next();
    const workReal = base * CFG.devCostRatio;
    const cost = workReal * buildPrice(eco);
    const spare = Math.max(0, f.acct.balance - monthlyCosts(eco, f) * 2);
    const equity = Math.min(spare, cost * 0.25);
    const borrow = Math.max(0, Math.round((cost - equity) / 1000) * 1000);
    const pid = eco.newId();
    const rent = CFG.houseBaseRent * cottage * quality * eco.market.rentIndex;
    const reason = `${f.name} had ${f.vacancies} job${f.vacancies > 1 ? 's' : ''} it could not fill: newcomers had nowhere to live`;
    this.homesCooldown.set(f.id, eco.day + 120);
    const go = (loanId: number) => {
      if (eco.lotUse.has(lot.id) || f.status !== 'open') return;
      startCompanyHomes(eco, f, lot, pid, cost, workReal, base, quality, cottage, loanId, reason);
    };
    if (borrow <= 5_000) {
      go(-1);
      return;
    }
    const app: LoanApp = {
      borrower: f,
      kind: 'business',
      purpose: 'development',
      amount: borrow,
      termMonths: 180,
      amortizing: true,
      collateral: { kind: 'project', ref: pid, value: base * quality * eco.market.hpi },
      income: f.last.revenue - f.last.wages - f.last.inputs - f.last.maintenance,
      projected: rent * 0.9,
      existingDebtService: f.debtService(),
      existingDebt: f.debt(),
      what: 'building a cottage to house its workers',
    };
    requestLoan(eco, app, { review: 'development', context: { lotId: lot.id, units: 1, saleValue: base * quality * eco.market.hpi, homes: true, reason } }, (d, fin) => {
      if (!d.offer) {
        f.note(eco.day, `Loan for workers' housing refused: ${d.reason}`, 'bad');
        return;
      }
      if (eco.lotUse.has(lot.id) || f.status !== 'open') return;
      const loan = originate(eco, d.offer, fin);
      go(loan.id);
    });
  }

  /**
   * Families who have work but no home of their own (boarders and renters) and enough saved for
   * the down payment have a starter home built, with a mortgage for the rest.
   */
  private selfBuild(): void {
    const eco = this.eco;
    let active = 0;
    for (const p of eco.projects.values()) if (p.kind === 'homes' && (p.status === 'active' || p.status === 'stalled') && eco.household(p.clientId)) active++;
    active += this.selfBuilders.size;
    if (active >= Math.max(1, Math.floor(eco.population() / 8))) return;
    const lots = freeLots(eco, 'res', false);
    if (!lots.length) return;
    const starter = eco.population() < 30 ? 0.55 : 0.75;
    const base = CFG.houseBaseValue * starter;
    const workReal = base * CFG.devCostRatio;
    const cost = workReal * buildPrice(eco);
    const value = base * eco.market.hpi;
    const reserve = CFG.essentials * eco.market.cpi * 2;
    const minDown = cost * (1 - this.rules.maxLTV) + 1_000;
    const cands = eco.households.filter(
      (h) =>
        !h.departed &&
        h.employed &&
        !h.retired &&
        h.employedDays >= 180 &&
        h.ownedUnits.length === 0 &&
        !h.buyPending &&
        !h.lookingToBuy &&
        eco.day - h.lastDefaultDay > 1500 &&
        !this.selfBuilders.has(h.id) &&
        !this.hasPendingLoan(h.id) &&
        h.acct.balance - reserve >= minDown,
    );
    if (!cands.length || !eco.rng.chance(0.4)) return;
    const h = eco.rng.pick(cands);
    const down = Math.min((h.acct.balance - reserve) * 0.9, cost * 0.3);
    const amount = Math.max(0, Math.round((cost - down) / 1000) * 1000);
    const lot = pickNearLot(eco, lots);
    if (!lot) return;
    eco.lotUse.set(lot.id, { type: 'project', id: -1 }); // spoken for while the bank decides
    this.selfBuilders.add(h.id);
    const quality = 0.95 + 0.1 * eco.rng.next();
    const release = () => {
      const use = eco.lotUse.get(lot.id);
      if (use && use.type === 'project' && use.id === -1) eco.lotUse.delete(lot.id);
      this.selfBuilders.delete(h.id);
      h.buyPending = false;
    };
    const go = (loanId: number, fin?: LoanApp, offer?: LoanOffer) => {
      const u = new UnitClass(eco.units.length, lot.id, quality, base, CFG.houseBaseRent * starter);
      u.ownerId = h.id;
      u.building = true;
      eco.units.push(u);
      let id = loanId;
      if (fin && offer) {
        fin.collateral = { kind: 'property', ref: u.id, value };
        const loan = originate(eco, offer, fin);
        u.mortgage = loan;
        id = loan.id;
      }
      startSelfBuild(eco, h, lot, u, workReal, id);
    };
    if (amount <= 5_000) {
      release();
      go(-1);
      return;
    }
    const app: LoanApp = {
      borrower: h,
      kind: 'mortgage',
      purpose: 'home',
      amount,
      termMonths: CFG.mortgageTerm,
      amortizing: true,
      collateral: { kind: 'property', value },
      income: h.wage,
      existingDebtService: debtService(h),
      existingDebt: 0,
      what: `building a home (${fmtMoney(cost)})`,
    };
    requestLoan(eco, app, { review: 'mortgage', context: { build: true, lotId: lot.id, price: cost } }, (d, fin) => {
      release();
      if (!d.offer || h.departed || !h.employed || eco.lotUse.has(lot.id)) {
        if (!d.offer) h.note(eco.day, `Mortgage to build a home refused: ${d.reason}`, 'bad');
        return;
      }
      if (h.acct.balance + fin.amount < cost * 0.97) return;
      go(-1, fin, d.offer);
    });
  }

  private pickEntrepreneur(sector: Sector): Household | undefined {
    const eco = this.eco;
    const cands = eco.households.filter(
      (h) =>
        !h.departed &&
        h.homeUnit >= 0 &&
        h.firms.length === 0 &&
        !h.retired &&
        eco.day - h.lastDefaultDay > 1500 &&
        h.acct.balance > 2_500 &&
        (h.employedDays > 60 || h.skill > 1.1),
    );
    if (!cands.length) return undefined;
    void sector;
    return eco.rng.weighted(cands, (h) => (h.acct.balance + 4000) * h.skill * (h.employed ? 1 : 0.6));
  }

  // ============================================================================ migration

  /** Monthly arrivals and departures (replaces the standard migration in Genesis Mode). */
  migration(): void {
    const eco = this.eco;
    let vac = 0;
    let unemployed = 0;
    for (const f of eco.firms) if (f.status !== 'closed') vac += Math.max(0, f.vacancies);
    for (const b of eco.banks) vac += Math.max(0, this.bankStaffTarget(b) - b.employees.length);
    for (const h of eco.households) if (!h.departed && !h.employed && !h.retired && (h.homeUnit >= 0 || h.lodging)) unemployed++;
    const rentals = vacantRentals(eco).length;
    const gap = vac - unemployed;
    // people come for the jobs: to a home to rent if there is one, otherwise to lodge with a family
    let arrivals = gap > 0 ? Math.min(rentals + this.lodgingRoom(), Math.ceil(gap * 0.7), 5) : 0;
    if (arrivals === 0 && rentals > 1 && eco.market.unemployment < 0.07 && eco.rng.chance(0.25)) arrivals = 1;
    for (let i = 0; i < arrivals; i++) this.newcomer(false, true);
    this.lodgers();
    // the jobless eventually move on
    const slack = Math.max(0, eco.market.unemployment - 0.06);
    for (const h of eco.households) {
      if (h.departed || h.employed || h.retired || h.unemployedDays < 120) continue;
      if (h.id === this.founderId || h.id === this.firstWorkerId) continue;
      const renter = !h.ownedUnits.length;
      const tied = h.loans.some((l) => l.active) || h.firms.length > 0;
      if (renter && !tied && eco.rng.chance(0.05 + 0.6 * slack)) departHousehold(eco, h, 'could not find work');
    }
  }

  /** Room for more lodgers: families in town with a spare room take in boarders. */
  lodgingRoom(): number {
    const eco = this.eco;
    let lodgers = 0;
    for (const h of eco.households) if (!h.departed && h.lodging) lodgers++;
    return Math.max(0, 2 + Math.floor(eco.population() * 0.12) - lodgers);
  }

  /**
   * Someone moves to town from the wider region: into a home to rent, or (if `lodge` and there is
   * nothing to rent) as a boarder with a family until a home can be found.
   */
  newcomer(entrepreneur: boolean, lodge = false): Household | null {
    const eco = this.eco;
    const banks = eco.aliveBanks();
    const rentals = vacantRentals(eco).length;
    if (!banks.length || (!rentals && !(lodge && this.lodgingRoom() > 0))) return null;
    const bank = eco.rng.weighted(banks, (b) => b.deposits * (1 - b.stress) + 50_000)!;
    const h = createHousehold(eco, bank, eco.day);
    h.name = personName(eco.rng, new Set(eco.households.map((x) => x.name)));
    if (!findRental(eco, h)) {
      h.lodging = true;
      h.lodgingSince = eco.day;
    }
    const wage = eco.market.wageIndex;
    const savings = entrepreneur ? wage * (4 + 5 * eco.rng.next()) : wage * (0.5 + 2.5 * eco.rng.next() ** 2);
    eco.ledger.fromOutside(h.acct, savings, 'migrate', eco.world.id);
    h.income = wage * (1 - CFG.taxRate) * 0.7;
    h.budget = CFG.essentials * eco.market.cpi;
    h.wealthMonths = h.bufferMonths;
    h.note(
      eco.day,
      `${entrepreneur ? `Moved to ${eco.city.name} with savings and a business idea` : `Moved to ${eco.city.name} for work`}${h.lodging ? ', boarding with a family until a home can be found' : ''}`,
      'good',
      savings,
    );
    eco.event('arrival', h.id);
    eco.monthCounters.arrivals++;
    this.hh(h);
    const n = eco.population();
    if (n >= 10) this.milestone('pop10', 2, 'TEN HOUSEHOLDS', `${eco.city.name} is home to ten households.`, h.id);
    if (n >= 25) this.milestone('pop25', 2, 'A VILLAGE', `Twenty-five households now live in ${eco.city.name}.`, h.id);
    if (n >= 50) this.milestone('pop50', 2, 'A TOWN', `Fifty households live in ${eco.city.name}.`, h.id);
    if (n >= 100) this.milestone('pop100', 1, 'A HUNDRED HOUSEHOLDS', `${eco.city.name} passes a hundred households.`, h.id);
    if (n >= 200) this.milestone('pop200', 1, 'A CITY', `Two hundred households: ${eco.city.name} is a city.`, h.id);
    return h;
  }

  /** Boarders pay their hosts, move into a home when one comes free, and some give up waiting. */
  private lodgers(): void {
    const eco = this.eco;
    const hosts = eco.households.filter((h) => !h.departed && h.homeUnit >= 0 && eco.units[h.homeUnit]?.ownerId === h.id);
    for (const h of eco.households) {
      if (h.departed || !h.lodging) continue;
      if (findRental(eco, h)) {
        h.note(eco.day, `Moved out of lodgings into ${this.address(h.homeUnit)}`, 'good');
        continue;
      }
      const board = CFG.houseBaseRent * 0.45 * eco.market.rentIndex;
      const host = hosts.length ? hosts[h.id % hosts.length] : undefined;
      if (host) {
        const paid = eco.ledger.transfer(h.acct, host.acct, Math.min(board, Math.max(0, h.acct.balance)), 'rent');
        host.incomeThisMonth += paid;
      } else eco.ledger.toOutside(h.acct, Math.min(board, Math.max(0, h.acct.balance)), 'import', eco.world.id);
      if (eco.day - h.lodgingSince > 720 && !h.buyPending && eco.rng.chance(0.08)) departHousehold(eco, h, 'gave up waiting for a home');
    }
  }

  // ============================================================================ banks

  /**
   * Unemployment as the labour market feels it: in a tiny town the region's jobs and jobless
   * matter as much as the town's own (one person out of work is not a 50% recession).
   */
  labourSignal(): number {
    let lf = 0;
    let u = 0;
    for (const h of this.eco.households) {
      if (h.departed || h.retired) continue;
      lf++;
      if (!h.employed) u++;
    }
    const region = 20;
    return (u + 0.055 * region) / (lf + region);
  }

  bankStaffTarget(b: Bank): number {
    if (!b.alive) return 0;
    const book = b.loanBook();
    if (book < 400_000) return 0;
    return Math.max(1, Math.min(5, Math.round((b.deposits + book) / 3_000_000)));
  }

  /** The player's rules bind every bank's own lending standards. */
  applyStandards(b: Bank): void {
    const r = this.rules;
    b.maxLTV = Math.min(b.maxLTV, r.maxLTV);
    b.maxDTI = Math.min(b.maxDTI, r.maxDTI);
    b.maxPD = Math.min(b.maxPD, r.maxPD);
    b.minDSCR = Math.max(b.minDSCR, r.minDSCR);
    const add = this.spreadAdd.get(b.id);
    if (add && add.until > this.eco.day) {
      b.spreads.mortgage += add.add;
      b.spreads.business += add.add;
      b.spreads.consumer += add.add;
      b.spreads.development += add.add;
    }
  }

  /** May the bank run its own balance-sheet engineering this month, or does the player decide? */
  autoEngineering(b: Bank, capShort: boolean, liqShort: boolean): boolean {
    const eco = this.eco;
    if (!capShort && !liqShort && b.cbLoan <= 0) return true;
    if (this.rules.review === 'crises' || this.bridges.has(b.id)) return true;
    // while the player is deciding, the bank waits; otherwise it manages its own balance sheet
    if (this.open().some((s) => s.kind === 'constraint' && s.bankId === b.id)) return false;
    const last = this.constraintRaised.get(b.id) ?? -9999;
    if (eco.day - last > 240) {
      this.constraintRaised.set(b.id, eco.day);
      const m = metrics(eco, b);
      const why: string[] = [];
      if (capShort) why.push(`its capital is down to ${pct(m.capitalRatio, 1)} of risk-weighted assets (it aims for ${pct(eco.policy.capitalRequirement + b.personality.capitalBuffer, 0)})`);
      if (liqShort) why.push(`its liquid funds are only ${pct(m.liquidityRatio, 0)} of deposits`);
      if (b.cbLoan > 0) why.push(`it is borrowing ${fmtMoney(b.cbLoan)} from the Reserve Bank`);
      const opts = constraintOptions(this, b);
      this.add({
        kind: 'constraint',
        deadline: eco.day + 45,
        blocking: false,
        title: `${b.name} is reaching its limits`,
        text: `${b.name} wants to keep lending, but ${why.join(' and ')}. How should it respond?`,
        subject: b.id,
        lotId: b.lotId,
        bankId: b.id,
        options: opts,
        // what the bank would do on its own
        fallback: capShort ? 'retain' : opts.find((o) => o.id === 'wholesale' && !o.disabled) ? 'wholesale' : 'rates',
      });
      this.milestone('first_constraint', 2, 'A BANK AT ITS LIMITS', `${b.name} can no longer lend freely.`, b.id);
      return false;
    }
    return true;
  }

  /** Called at the end of each bank's monthly review. */
  afterBankMonthly(b: Bank): void {
    const eco = this.eco;
    const until = this.freezeUntil.get(b.id) ?? -1;
    if (until > eco.day) {
      b.stance = 'frozen';
      b.budget = 0;
    }
    if ((this.retainUntil.get(b.id) ?? -1) > eco.day) b.dividendsSuspended = true;
    this.growCapital(b);
  }

  /**
   * Once the town has outgrown your desk, a profitable bank that has used up its credit with the
   * region's banks sells new shares to investors across the river (at most once a year).
   */
  private growCapital(b: Bank): void {
    const eco = this.eco;
    if (this.era === 'transactions' || this.bridges.has(b.id) || !b.alive) return;
    if (eco.day - (this.lastRaise.get(b.id) ?? -9999) < 360) return;
    const m = metrics(eco, b);
    if (m.equity <= 0 || b.stress > 0.2) return;
    if (this.regionCredit(b) > 0.5 * m.equity) return;
    let profit = 0;
    for (const pl of b.plYear) profit += netIncome(pl);
    if (b.plYear.length < 12 || profit / m.equity < 0.1) return;
    const amt = Math.round((m.equity * 0.25) / 10_000) * 10_000;
    if (amt < 20_000) return;
    this.lastRaise.set(b.id, eco.day);
    eco.ledger.outsideToBank(b, amt, 'capital', eco.world.id);
    b.paidIn += amt;
    invalidateMetrics(b);
    b.log(eco.day, `Sold ${fmtMoney(amt)} of new shares to investors across the river`, 'good');
    eco.headline(`${b.name} raises ${fmtMoney(amt)} of new capital from investors across the river`, 'good', b.id, undefined, `raise-${b.id}`, 60);
    eco.event('capital_raise', b.id, amt, eco.world.id);
  }

  /** Bank dividends go to its owners across the river (unless the rules or the player say retain). */
  bankDividend(b: Bank, amount: number): number {
    const eco = this.eco;
    if (!this.rules.dividends || (this.retainUntil.get(b.id) ?? -1) > eco.day) return 0;
    const amt = Math.min(amount, Math.max(0, b.reserves - 0.05 * b.deposits));
    if (amt <= 0) return 0;
    eco.ledger.bankToOutside(b, amt, 'dividend', eco.world.id);
    return amt;
  }

  /** How much more banks across the river would lend this bank (about twice its capital, while it looks sound). */
  regionCredit(b: Bank): number {
    const eco = this.eco;
    const m = metrics(eco, b);
    if (m.equity <= 0 || b.stress > 0.3 || m.capitalRatio < eco.policy.capitalRequirement + 0.02) return 0;
    let owed = 0;
    for (const w of b.wholesale) if (w.lenderKind === 'region') owed += w.amount;
    return Math.max(0, 2 * m.equity - owed);
  }

  elaFor(b: Bank): EmergencyLiquidity | undefined {
    return (this.elaUntil.get(b.id) ?? -1) > this.eco.day ? 'broad' : undefined;
  }

  canSecuritize(): boolean {
    return this.rules.securitization;
  }

  /**
   * A bank is about to fail. Unless the player has already chosen to let it go, stop and ask.
   * Returns true when the failure is on hold.
   */
  interceptFailure(b: Bank, kind: 'insolvency' | 'liquidity'): boolean {
    const eco = this.eco;
    if (this.allowFail.has(b.id)) {
      this.allowFail.delete(b.id);
      return false;
    }
    if (kind === 'liquidity') overnightSupport(eco, b);
    // (the player already chose to keep it supplied with cash)
    if (kind === 'liquidity' && (this.elaUntil.get(b.id) ?? -1) > eco.day) return true;
    if (this.bridges.has(b.id)) {
      recapitaliseBridge(eco, b);
      return true;
    }
    if (kind === 'insolvency' && (this.forbearUntil.get(b.id) ?? -1) > eco.day) return true;
    if (this.failureOpen.has(b.id)) return true;
    const m = metrics(eco, b);
    const others = eco.aliveBanks().filter((x) => x !== b);
    const text =
      kind === 'liquidity'
        ? `${b.name} has run out of cash to pay depositors and settle payments. The Reserve Bank has lent it ${fmtMoney(b.cbLoan)} overnight so the day can close.`
        : `Losses have wiped out ${b.name}'s capital (capital ratio ${pct(m.capitalRatio, 1)}, equity ${fmtMoney(m.equity)}). By law it must be closed — unless you intervene.`;
    const sit = this.add({
      kind: 'failure',
      deadline: Infinity,
      blocking: true,
      title: `${b.name} is failing`,
      text: `${text} It holds ${fmtMoney(m.deposits)} of deposits and ${fmtMoney(m.loansGross)} of loans. ${others.length ? '' : 'It is the only bank in town.'}`,
      subject: b.id,
      lotId: b.lotId,
      bankId: b.id,
      options: failureOptions(this, b, kind),
      fallback: kind === 'liquidity' && m.equity > 0 ? 'ela' : 'fail',
    });
    this.failureOpen.set(b.id, sit.id);
    return true;
  }

  /** The last bank is being closed: the deposit insurer opens a bridge bank to take its book. */
  charterBridgeBank(failed: Bank): Bank | null {
    return bridgeBank(this, failed);
  }

  /** With a single bank, frightened depositors move their money to banks in the city. */
  flightDaily(): void {
    const eco = this.eco;
    const banks = eco.aliveBanks();
    if (banks.length !== 1) return;
    const b = banks[0];
    if (b.stress < 0.3) {
      if (b.runOutflow < 1000 && b.status === 'run') b.status = 'stressed';
      return;
    }
    const limit = INSURANCE_LIMITS[eco.policy.depositInsurance];
    let outflow = 0;
    const accts = [...eco.households.filter((h) => !h.departed).map((h) => h.acct), ...eco.firms.filter((f) => f.status !== 'closed').map((f) => f.acct)];
    for (const a of accts) {
      if (a.bank !== b || a.balance <= 100) continue;
      const uninsured = Math.max(0, a.balance - limit);
      const insuredShare = 1 - uninsured / a.balance;
      const theta = 0.3 + 0.45 * frac(a.ownerId * 0.61803);
      const excess = b.stress * CFG.runSensitivity - theta - 0.05;
      if (excess <= 0) continue;
      const p = Math.min(0.4, excess * 1.2) * (1 - insuredShare) + Math.min(0.04, excess * 0.03) * insuredShare;
      if (!eco.rng.chance(p)) continue;
      const amt = eco.ledger.toOutside(a, a.balance * 0.8, 'flight', eco.world.id);
      this.fled.set(a.ownerId, (this.fled.get(a.ownerId) ?? 0) + amt);
      outflow += amt;
    }
    if (outflow > 0) {
      b.runOutflow += outflow;
      b.runDays++;
      eco.event('bank_run', b.id, outflow, eco.world.id);
      if (b.runOutflow > 0.04 * (b.deposits + b.runOutflow) && b.status !== 'run') {
        b.status = 'run';
        b.log(eco.day, `Depositors are moving their money to banks in the city: ${fmtMoney(outflow)} left today`, 'bad');
        eco.headline(`Run on ${b.name}! Depositors move ${fmtMoney(b.runOutflow)} to banks in the city`, 'alert', b.id, undefined, `run-${b.id}`, 45);
      }
    }
  }

  // ============================================================================ hooks from the simulation

  /** New deposit money: lent into existence, spent by a bank or the public sector, or arriving from outside town. */
  onCreated(amount: number, kind: FlowKind, origin: number): void {
    const c = this.counters;
    if (kind === 'loan') c.originated += amount;
    else if (origin === ORIGIN_LEGACY) c.tradeIn += amount;
    else if (origin >= FIRST_BANK_ORIGIN) c.bankSpending += amount;
    else c.publicOut += amount;
  }

  /** Deposit money extinguished: paid to a bank, to the public sector, or out of town. */
  onDestroyed(amount: number, kind: FlowKind, sink: MoneySink): void {
    const c = this.counters;
    if (sink === 'outside') c.tradeOut += amount;
    else if (sink === 'public') c.publicIn += amount;
    else if (kind === 'principal') {
      c.principalRepaid += amount;
      this.milestone('first_payment', 3, 'FIRST LOAN PAYMENT', 'A borrower pays back part of a loan. The deposits used to pay it are destroyed: money shrinks as debt is repaid.');
    } else if (kind === 'interest') c.interestPaid += amount;
    else c.boughtFromBanks += amount;
  }

  onOriginate(l: Loan, app: LoanApp): void {
    const eco = this.eco;
    const c = this.counters;
    c.loansMade++;
    const bank = eco.bank(l.originatorId);
    const bk = nodeKey('bank', l.originatorId);
    const borrower = app.borrower;
    const bKind: LKind = borrower.kind === 'firm' ? 'firm' : 'household';
    const lk = nodeKey('loan', l.id);
    const label = `${fmtMoney(l.principal0)} ${loanLabel(l.purpose)}`;
    this.lineage.node('loan', l.id, label, eco.day, eco.lotOf(borrower.id), l.purpose);
    if (borrower.kind === 'firm') this.lineage.node('firm', borrower.id, borrower.name, borrower.founded, borrower.lotId, `${borrower.sector} · ${borrower.subtype}`);
    else this.hh(borrower);
    const first = c.loansMade === 1;
    this.lineage.edge('lent', bk, lk, eco.day, l.principal0, `${first ? 'the first loan: ' : ''}lent ${fmtMoney(l.principal0)}`);
    this.lineage.edge('financed', lk, nodeKey(bKind, borrower.id), eco.day, l.principal0, `+${fmtMoney(l.principal0)} of new deposit money`);
    if (l.collateral.kind === 'property' && l.collateral.ref !== undefined) {
      const u = eco.units[l.collateral.ref];
      if (u) {
        this.unitNode(u);
        this.lineage.edge('secured', lk, nodeKey('unit', u.id), eco.day, l.principal0, borrower.kind === 'household' ? 'mortgage on' : 'secured on');
      }
    }
    const prev = this.successorOf.get(borrower.id);
    if (prev !== undefined) {
      this.successorOf.delete(borrower.id);
      this.lineage.edge('successor', nodeKey('loan', prev), lk, eco.day, l.principal0, 'rescue credit after missed payments');
    }
    // milestones
    if (first) {
      this.milestone('first_loan', 3, 'FIRST LOAN ISSUED', `${bank?.name ?? 'The bank'} lends ${fmtMoney(l.principal0)} to ${borrower.name}. The loan did not come from anyone's savings: the bank simply created a deposit of ${fmtMoney(l.principal0)}. Money in town: $0 → ${fmtMoney(eco.broadMoney())}.`, borrower.id);
    }
    if (l.purpose === 'home') this.milestone('first_mortgage', 3, 'FIRST MORTGAGE', `${borrower.name} borrows ${fmtMoney(l.principal0)} from ${bank?.name ?? 'the bank'} to buy a home.`, borrower.id);
    if (l.purpose === 'development') this.milestone('first_dev', 2, 'FIRST DEVELOPMENT LOAN', `${borrower.name} borrows to build homes to sell.`, borrower.id);
    if (l.purpose === 'investment_property') this.milestone('first_btl', 2, 'FIRST LANDLORD LOAN', `${borrower.name} borrows to buy a home to rent out.`, borrower.id);
    if (l.purpose === 'durables') this.milestone('first_consumer', 1, 'FIRST CONSUMER LOAN', `${borrower.name} borrows to buy furniture and a car.`, borrower.id);
    if (c.loansMade === 100) this.milestone('loans100', 2, 'A HUNDRED LOANS', `The town's banks have made a hundred loans, worth ${fmtMoney(c.originated)} in all.`);
    if (bank && bank.id !== this.genesisBankId && !this.flags.has(`bank_first_${bank.id}`)) {
      this.flags.add(`bank_first_${bank.id}`);
    }
  }

  onMissed(l: Loan): void {
    const eco = this.eco;
    if (l.missed !== 1 || this.troubleRaised.has(l.id)) return;
    const borrower = eco.firm(l.borrowerId) ?? eco.household(l.borrowerId);
    if (!borrower) return;
    this.milestone('first_missed', 3, 'FIRST MISSED PAYMENT', `${borrower.name} cannot make a payment on its ${loanLabel(l.purpose)}.`, borrower.id);
    if (l.purpose === 'working_capital' || l.purpose === 'durables' || l.purpose === 'smoothing') return;
    const review = this.rules.review;
    if (review === 'crises') return;
    if (review === 'large' && l.balance < this.rules.reviewThreshold * 0.5 && this.flags.has('trouble_seen')) return;
    if (this.open().filter((s) => s.kind === 'trouble').length >= 4) return;
    this.troubleRaised.add(l.id);
    this.flags.add('trouble_seen');
    const lender = eco.nameOf(l.servicerId);
    let situationText = '';
    if (borrower.kind === 'firm') {
      const f = borrower;
      situationText = `It has ${fmtMoney(f.acct.balance)} in the bank, ${f.workers.length} staff and sold ${fmtMoney(f.last.revenue)} last month${f.lossMonths > 0 ? `, losing money for ${f.lossMonths} month${f.lossMonths > 1 ? 's' : ''}` : ''}.`;
    } else {
      const h = borrower;
      situationText = `${h.employed ? `${h.name.split(' ')[0]} still has a job` : `${h.name.split(' ')[0]} has lost their job`} and ${fmtMoney(h.acct.balance)} in savings.`;
    }
    this.add({
      kind: 'trouble',
      deadline: eco.day + 25,
      blocking: false,
      title: `${borrower.name} missed a payment`,
      text: `${borrower.name} missed a payment on its ${fmtMoney(l.principal0)} ${loanLabel(l.purpose)} from ${lender} (${fmtMoney(l.balance)} still owed). ${situationText} What should ${lender} do?`,
      subject: borrower.id,
      lotId: eco.lotOf(borrower.id),
      loanId: l.id,
      options: troubleOptions(this, l),
      fallback: 'wait',
    });
  }

  onLoanClosed(l: Loan): void {
    this.lineage.end(nodeKey('loan', l.id), this.eco.day, `repaid in full (interest paid ${fmtMoney(l.interestPaid)})`);
    this.milestone('first_repaid', 2, 'A LOAN REPAID IN FULL', `${this.eco.nameOf(l.borrowerId)} pays off a ${fmtMoney(l.principal0)} loan. The money it created has been destroyed again.`, l.borrowerId);
  }

  onDefault(l: Loan, balance: number, loss: number, seized: number[]): void {
    const eco = this.eco;
    this.counters.defaulted += balance;
    this.lineage.end(nodeKey('loan', l.id), eco.day, `defaulted: ${fmtMoney(loss)} lost`);
    for (const uid of seized) {
      const u = eco.units[uid];
      if (!u) continue;
      this.unitNode(u);
      this.lineage.edge('seized', nodeKey('bank', l.servicerId), nodeKey('unit', uid), eco.day, balance, 'repossessed');
    }
    const who = eco.nameOf(l.borrowerId);
    this.milestone('first_default', 3, 'FIRST DEFAULT', `${who} defaults on a ${fmtMoney(balance)} loan. ${fmtMoney(loss)} is written off — but the money the loan created stays in circulation.`, l.borrowerId);
  }

  onSecuritize(b: Bank, pool: MbsPool, loans: Loan[], buyers: { id: number; kind: 'bank' | 'fund' }[]): void {
    const eco = this.eco;
    const pk = nodeKey('pool', pool.id);
    this.lineage.node('pool', pool.id, pool.name, eco.day, b.lotId, 'mortgage-backed security');
    for (const l of loans) this.lineage.edge('packaged', nodeKey('loan', l.id), pk, eco.day, l.balance, `packaged into ${pool.name}`);
    for (const x of buyers) this.lineage.edge('sold', pk, nodeKey(x.kind === 'bank' ? 'bank' : 'public', x.id), eco.day, pool.balance, 'bought a slice');
    this.milestone('first_mbs', 2, 'FIRST SECURITISATION', `${b.name} bundles ${loans.length} mortgages into ${pool.name} and sells them to investors.`, b.id);
  }

  onLoansSold(b: Bank, loans: Loan[]): void {
    const eco = this.eco;
    for (const l of loans) this.lineage.edge('sold', nodeKey('loan', l.id), nodeKey('public', eco.fund.id), eco.day, l.balance, `sold to ${eco.fund.name}`);
    this.milestone('first_loansale', 2, 'LOANS SOLD ON', `${b.name} sells loans to ${eco.fund.name}.`, b.id);
  }

  onFirmOpened(f: Firm): void {
    const eco = this.eco;
    const owner = eco.household(f.ownerId);
    // owner-operators: the founder works in the business
    if (owner && !owner.departed && owner.employer !== f.id) {
      if (owner.employed) fire(eco, owner, `left to run ${f.name}`, true);
      hire(eco, f.id, owner);
    }
    const target = Math.max(1, Math.round(f.capitalCap / f.A));
    f.vacancies = Math.max(0, target - f.workers.length);
    this.lineage.node('firm', f.id, f.name, f.founded, f.lotId, `${f.sector} · ${f.subtype}`);
    const opened = eco.firms.filter((x) => x.openedDay >= 0).length;
    if (opened === 1) this.milestone('first_business', 3, 'FIRST BUSINESS OPENS', `${f.name} opens its doors. Everything it owns was paid for with money the bank created.`, f.id);
    else if (opened === 2) this.milestone('second_business', 3, 'FIRST NEW BUSINESS', `${f.name} opens: the town's second business.`, f.id);
    else if (opened === 5) this.milestone('five_business', 2, 'FIVE BUSINESSES', `${f.name} is the town's fifth business.`, f.id);
    else if (opened === 10) this.milestone('ten_business', 2, 'TEN BUSINESSES', `${f.name} is the town's tenth business.`, f.id);
    else if (opened === 25) this.milestone('25_business', 1, 'TWENTY-FIVE BUSINESSES', `${f.name} makes twenty-five.`, f.id);
    if (f.sector === 'retail') this.milestone('first_shop', 2, 'FIRST SHOP', `${f.name} opens: locals no longer have to cross the river for everything.`, f.id);
    if (f.sector === 'service') this.milestone('first_service', 2, 'FIRST CAFÉ & SERVICES', `${f.name} opens for business.`, f.id);
    if (f.sector === 'builder') this.milestone('first_builder', 2, 'FIRST BUILDER', `${f.name} opens: the town can now build its own homes.`, f.id);
  }

  onFirmClosed(f: Firm, reason: string): void {
    this.lineage.end(nodeKey('firm', f.id), this.eco.day, `closed: ${reason}`);
    if (f.openedDay >= 0) this.milestone('first_closure', 2, 'FIRST BUSINESS CLOSES', `${f.name} shuts down: ${reason}.`, f.id);
  }

  onWage(f: Firm, h: Household, gross: number): void {
    const e = this.lineage.findOpen('employed', nodeKey('firm', f.id), nodeKey('household', h.id));
    if (e) e.amount += gross;
    this.milestone('first_paycheck', 3, 'FIRST PAYCHECK', `${f.name} pays ${h.name} ${fmtMoney(gross)}. Money created by a loan is now someone's income.`, h.id);
  }

  onHire(employerId: number, h: Household): void {
    const eco = this.eco;
    const emp = eco.agents.get(employerId);
    if (!emp) return;
    this.hh(h);
    const kind: LKind = emp.kind === 'firm' ? 'firm' : emp.kind === 'bank' ? 'bank' : 'public';
    const owner = emp.kind === 'firm' && emp.ownerId === h.id;
    if (kind === 'public') this.lineage.node('public', emp.id, emp.name, 0, eco.lotOf(emp.id));
    this.lineage.openEdge('employed', nodeKey(kind, employerId), nodeKey('household', h.id), eco.day, owner ? 'runs it' : 'employs');
    if (emp.kind === 'firm' && !owner) {
      if (this.firstWorkerId < 0) this.firstWorkerId = h.id;
      this.milestone('first_hire', 3, 'FIRST EMPLOYEE HIRED', `${emp.name} hires ${h.name}.`, h.id);
    }
    if (emp.kind === 'treasury') this.milestone('first_public', 2, 'FIRST PUBLIC SERVANT', `City Hall hires ${h.name}, paid from the taxes the town now collects.`, h.id);
  }

  onFire(h: Household, prevEmployer: number, quit: boolean): void {
    const eco = this.eco;
    const emp = eco.agents.get(prevEmployer);
    if (!emp) return;
    const kind: LKind = emp.kind === 'firm' ? 'firm' : emp.kind === 'bank' ? 'bank' : 'public';
    this.lineage.closeEdge('employed', nodeKey(kind, prevEmployer), nodeKey('household', h.id), eco.day);
    if (!quit && emp.kind === 'firm') this.milestone('first_layoff', 2, 'FIRST LAYOFF', `${emp.name} lets ${h.name} go.`, h.id);
  }

  onHouseSold(u: Unit, buyer: Household, sellerId: number, price: number, loanId: number): void {
    const eco = this.eco;
    this.unitNode(u);
    this.hh(buyer);
    const loan = loanId >= 0 ? eco.loans.get(loanId) : undefined;
    const label = loan ? `bought for ${fmtMoney(price)} with a ${fmtMoney(loan.principal0)} mortgage from ${eco.nameOf(loan.originatorId)}` : `bought for ${fmtMoney(price)}`;
    const seller = eco.agents.get(sellerId);
    if (seller && (seller.kind === 'household' || seller.kind === 'firm')) {
      this.lineage.closeEdge('bought', nodeKey('household', sellerId), nodeKey('unit', u.id), eco.day);
      this.lineage.closeEdge('built', nodeKey('firm', sellerId), nodeKey('unit', u.id), eco.day);
    }
    this.lineage.openEdge('bought', nodeKey('household', buyer.id), nodeKey('unit', u.id), eco.day, label, price);
    this.milestone('first_home', 3, 'FIRST HOME PURCHASED', `${buyer.name} buys ${this.address(u.id)} for ${fmtMoney(price)}.`, buyer.id, u.lotId);
  }

  onProjectComplete(p: Project): void {
    const eco = this.eco;
    const family = p.kind === 'homes' ? eco.household(p.clientId) : undefined;
    if (family) {
      for (const uid of eco.lotUnits.get(p.lotId) ?? []) {
        const u = eco.units[uid];
        this.unitNode(u);
        this.hh(family);
        this.lineage.openEdge('bought', nodeKey('household', family.id), nodeKey('unit', uid), eco.day, `had it built for ${fmtMoney(p.paid)}`, p.paid);
        const builder = eco.firm(p.builderId);
        if (builder) this.lineage.edge('built', nodeKey('firm', builder.id), nodeKey('unit', uid), eco.day, p.paid, 'built it');
        const loan = p.loanId >= 0 ? eco.loans.get(p.loanId) : undefined;
        if (loan) this.lineage.edge('secured', nodeKey('loan', loan.id), nodeKey('unit', uid), eco.day, loan.principal0, 'mortgage on');
      }
      this.milestone('first_self_build', 3, 'FIRST FAMILY HOME', `${family.name} move into the home they had built${p.loanId >= 0 ? ` with a mortgage from ${eco.nameOf(eco.loans.get(p.loanId)?.originatorId ?? -1)}` : ''}.`, family.id, p.lotId);
      return;
    }
    if (p.kind === 'homes') {
      for (const uid of eco.lotUnits.get(p.lotId) ?? []) {
        const u = eco.units[uid];
        this.unitNode(u);
        this.lineage.openEdge('built', nodeKey('firm', p.clientId), nodeKey('unit', uid), eco.day, 'had it built to house its workers', p.cost);
        const builder = eco.firm(p.builderId);
        if (builder) this.lineage.edge('built', nodeKey('firm', builder.id), nodeKey('unit', uid), eco.day, p.paid, 'built it');
      }
      this.milestone('first_company_home', 2, 'FIRST COMPANY HOUSING', `${eco.nameOf(p.clientId)} finishes a cottage for the workers it could not otherwise hire.`, p.clientId, p.lotId);
    } else if (p.kind === 'housing') {
      for (const uid of eco.lotUnits.get(p.lotId) ?? []) {
        const u = eco.units[uid];
        this.unitNode(u);
        this.lineage.openEdge('built', nodeKey('firm', p.clientId), nodeKey('unit', uid), eco.day, 'built', p.cost / Math.max(1, (eco.lotUnits.get(p.lotId) ?? []).length));
      }
      this.milestone('first_built', 3, 'FIRST NEW HOME BUILT', `${eco.nameOf(p.clientId)} finishes the town's first new ${p.target.kind === 'apartment' ? 'apartment block' : 'house'}.`, p.clientId, p.lotId);
    } else {
      const builder = eco.firm(p.builderId);
      if (builder) this.lineage.edge('built', nodeKey('firm', builder.id), nodeKey('firm', p.clientId), eco.day, p.paid, p.kind === 'expansion' ? 'built its extension' : 'built its premises');
    }
  }

  onBankOpened(b: Bank, bridge = false): void {
    const eco = this.eco;
    this.lineage.node('bank', b.id, b.name, eco.day, b.lotId, bridge ? 'bridge bank' : 'bank');
    const n = eco.banks.length;
    if (!bridge && n === 2) this.milestone('second_bank', 3, 'SECOND BANK OPENS', `${b.name} opens. ${eco.bank(this.genesisBankId)?.name ?? 'Genesis Bank'} has a competitor.`, b.id);
    if (bridge) this.milestone(`bridge_${b.id}`, 2, 'A BRIDGE BANK OPENS', `The deposit insurer opens ${b.name} to keep accounts running.`, b.id);
  }

  onBankFailed(b: Bank, acq: Bank, how: 'failure' | 'merger' = 'failure'): void {
    const eco = this.eco;
    this.lineage.end(nodeKey('bank', b.id), eco.day, how === 'merger' ? `taken over by ${acq.name}` : `failed (${b.failureKind ?? 'closed'})`);
    this.lineage.edge('acquired', nodeKey('bank', b.id), nodeKey('bank', acq.id), eco.day, 0, how === 'merger' ? 'taken over by' : 'its accounts and loans passed to');
    this.failureOpen.delete(b.id);
    if (b.id === this.genesisBankId) {
      this.milestone('genesis_gone', 3, how === 'merger' ? 'GENESIS BANK IS TAKEN OVER' : 'GENESIS BANK FAILS', `${b.name}, the town's first bank, is gone after ${Math.floor((eco.day - b.founded) / DAYS_PER_YEAR)} years. Its loans, and everything they financed, live on.`, acq.id);
    } else this.milestone('first_failure', 2, 'A BANK FAILS', `${b.name} is closed.`, acq.id);
  }

  // ============================================================================ daily & monthly

  tradeDay(): void {
    exportsDay(this.eco, this);
  }

  endOfDay(): void {
    const eco = this.eco;
    // deadlines: the default applies
    for (const s of this.situations) {
      if (s.status !== 'open' || eco.day < s.deadline) continue;
      if (s.kind === 'loan' && s.loan) decideLoan(this, s, s.loan.suggested, false);
      else if (s.fallback) this.decideAction(s.id, s.fallback, false);
      else s.status = 'expired';
    }
    // runs need an answer
    for (const b of eco.aliveBanks()) {
      if (b.status !== 'run') continue;
      const last = this.runRaised.get(b.id) ?? -9999;
      if (eco.day - last < 120) continue;
      this.runRaised.set(b.id, eco.day);
      const m = metrics(eco, b);
      this.add({
        kind: 'run',
        deadline: Infinity,
        blocking: true,
        title: `Run on ${b.name}!`,
        text: `Depositors are pulling their money out of ${b.name}: ${fmtMoney(b.runOutflow)} in the last few days. It has ${fmtMoney(Math.max(0, m.reserves))} of reserves left against ${fmtMoney(m.deposits)} of deposits (capital ratio ${pct(m.capitalRatio, 1)}).`,
        subject: b.id,
        lotId: b.lotId,
        bankId: b.id,
        options: runOptions(this, b),
        fallback: 'nothing',
      });
      this.milestone('first_run', 3, 'FIRST BANK RUN', `Depositors queue to take their money out of ${b.name}.`, b.id);
    }
  }

  monthly(): void {
    const eco = this.eco;
    // trade month closes
    this.recent.push(this.trade);
    if (this.recent.length > 24) this.recent.shift();
    this.trade = newTradeMonth();
    this.regionMood = Math.max(-0.35, Math.min(0.3, this.regionMood * 0.93 + eco.rng.normal() * 0.035));
    this.counters.peakMoney = Math.max(this.counters.peakMoney, eco.broadMoney());
    // failed banks' deposit write-downs are part of the money story too
    this.entryMonthly();
    this.companyHousing();
    this.selfBuild();
    this.chartersMonthly();
    this.eraCheck();
    this.syncLineage();
    this.fundCheck();
    this.returnFled();
    this.macroNews = eco.population() >= 20;
    if (!this.fundOpen && eco.population() >= 40) this.fundOpen = true;
    {
      let vac = 0;
      let unemployed = 0;
      for (const f of eco.firms) if (f.status !== 'closed') vac += Math.max(0, f.vacancies);
      for (const h of eco.households) if (!h.departed && !h.employed && !h.retired && (h.homeUnit >= 0 || h.lodging)) unemployed++;
      let lodgers = 0;
      for (const h of eco.households) if (!h.departed && h.lodging) lodgers++;
      this.housingShortage = vacantRentals(eco).length === 0 && (vac > unemployed || lodgers > 0);
    }
    const ind = this.indicators();
    this.history.push(ind);
    if (this.history.length > 1200) this.history.shift();
    if (eco.broadMoney() >= 1e6) this.milestone('money1m', 2, 'A MILLION DOLLARS', `There are now ${fmtMoney(eco.broadMoney())} of deposits in town — all of it created by lending, spending or trade since the first loan.`);
    if (eco.broadMoney() >= 1e7) this.milestone('money10m', 1, 'TEN MILLION', `${fmtMoney(eco.broadMoney())} of deposits in town.`);
    const y = Math.floor(eco.day / DAYS_PER_YEAR);
    if (eco.month % 12 === 11 && y >= 0 && this.firstBusinessId >= 0) {
      const g = this.genesisShare();
      if (y === 9) this.milestone('decade', 2, 'TEN YEARS ON', `Ten years after the first loan: ${eco.population()} households, ${eco.firms.filter((f) => f.status === 'open').length} businesses, ${fmtMoney(eco.broadMoney())} of money. ${pct(g, 0)} of all loans in town were first made by ${GENESIS_BANK_NAME}.`);
    }
  }

  private chartersMonthly(): void {
    const eco = this.eco;
    if (eco.day < this.nextCharterDay) return;
    if (this.open().some((s) => s.kind === 'charter')) return;
    const alive = eco.aliveBanks();
    if (alive.length >= 4) return;
    let deposits = 0;
    for (const b of alive) deposits += b.deposits;
    const squeezed = alive.every((b) => b.stance === 'tightening' || b.stance === 'frozen');
    if (deposits < 1_200_000 * alive.length && !(squeezed && deposits > 500_000) && alive.length > 0) return;
    const c = draftCharter(this);
    if (!c) {
      this.nextCharterDay = eco.day + 720;
      return;
    }
    this.add({
      kind: 'charter',
      deadline: eco.day + 60,
      blocking: false,
      title: `${c.name} applies for a banking licence`,
      text: `Investors from across the river want to open ${c.name} in ${eco.city.name} with ${fmtMoney(c.capital)} of capital. It ${c.blurb}. More banks mean competition for deposits and borrowers — and more places for trouble to start.`,
      subject: eco.cb.id,
      lotId: c.lotId,
      charter: c,
      options: [
        { id: 'approve', label: 'Grant the licence', effect: `${c.name} opens with ${fmtMoney(c.capital)} of capital.` },
        { id: 'morecapital', label: 'Grant it, but demand 50% more capital', effect: `It opens with ${fmtMoney(Math.round((c.capital * 1.5) / 10_000) * 10_000)}: safer, but its owners expect less return.` },
        { id: 'reject', label: 'Refuse', effect: 'Nothing changes. The investors may try again in a few years.' },
      ],
      fallback: 'approve',
    });
    this.nextCharterDay = eco.day + 90;
  }

  private eraCheck(): void {
    const eco = this.eco;
    const years = eco.day / DAYS_PER_YEAR;
    let active = 0;
    for (const l of eco.loans.values()) if (l.active) active++;
    const pop = eco.population();
    let next: Era | null = null;
    if (this.era === 'transactions' && (this.counters.loansMade >= 14 || pop >= 16 || years >= 5)) next = 'institutions';
    else if (this.era === 'institutions' && (active >= 50 || pop >= 55 || years >= 14)) next = 'system';
    if (!next) return;
    this.era = next;
    const prevReview = this.rules.review;
    this.rules.review = next === 'institutions' ? 'large' : 'crises';
    const info = ERA_INFO[next];
    this.add({
      kind: 'era',
      deadline: eco.day + 60,
      blocking: false,
      title: `A new era: ${info.title}`,
      text:
        next === 'institutions'
          ? `${eco.city.name} has outgrown your desk: ${this.counters.loansMade} loans so far and more every month. From now on the banks decide routine loans themselves, within your rules. Only loans of ${fmtMoney(this.rules.reviewThreshold)} or more, and the first of each kind, still come to you. You can change this in the Reserve Bank's rules.`
          : `With ${active} loans outstanding and ${pop} households, no one can review individual loans any more. You now govern the economy through rules and rates — and through what you do when a bank gets into trouble.`,
      subject: eco.cb.id,
      lotId: eco.cb.lotId,
      era: next,
      options: [{ id: 'ok', label: 'Understood', effect: '' }],
      fallback: 'ok',
    });
    void prevReview;
    this.milestone(`era_${next}`, 2, `THE ERA OF ${info.title.toUpperCase()}`, info.blurb);
  }

  private fundCheck(): void {
    const eco = this.eco;
    const f = eco.fund;
    if (f.units > 0 && !eco.lotUse.has(f.lotId)) {
      eco.lotUse.set(f.lotId, { type: 'fund', id: f.id });
      this.lineage.node('public', f.id, f.name, eco.day, f.lotId, 'investment fund');
      this.milestone('fund', 2, 'AN INVESTMENT FUND OPENS', `${f.name} opens an office: households now have savings to invest.`, f.id);
    }
  }

  /** Deposits that fled to the city come back once the local banks look safe again. */
  private returnFled(): void {
    const eco = this.eco;
    if (!this.fled.size) return;
    const alive = eco.aliveBanks();
    const calm = alive.length && alive.every((b) => b.stress < 0.2);
    if (!calm) return;
    for (const [id, amt] of [...this.fled]) {
      const a = eco.household(id) ?? eco.firm(id);
      if (!a || (a.kind === 'household' && a.departed) || (a.kind === 'firm' && a.status === 'closed')) {
        this.fled.delete(id);
        continue;
      }
      const back = amt * 0.25;
      if (!a.acct.bank.alive) continue;
      eco.ledger.fromOutside(a.acct, back, 'flight', eco.world.id);
      if (amt - back < 100) this.fled.delete(id);
      else this.fled.set(id, amt - back);
    }
  }

  /** Bring homes, ownership and first-hop spending into the lineage record. */
  private syncLineage(): void {
    const eco = this.eco;
    for (const u of eco.units) {
      if (u.building) continue;
      const occ = u.occupantId;
      const prev = this.homeOf.get(u.id) ?? -1;
      if (occ === prev) continue;
      const uk = nodeKey('unit', u.id);
      this.unitNode(u);
      if (prev >= 0) this.lineage.closeEdge('home', uk, nodeKey('household', prev), eco.day);
      if (occ >= 0) {
        const h = eco.household(occ);
        if (h) {
          this.hh(h);
          this.lineage.openEdge('home', uk, nodeKey('household', occ), eco.day, u.ownerId === occ ? 'their own home' : `rents from ${eco.nameOf(u.ownerId)}`);
        }
        this.homeOf.set(u.id, occ);
      } else this.homeOf.delete(u.id);
    }
    for (const l of eco.loans.values()) {
      if (!l.spentOn.length) continue;
      if (!l.active && l.closedDay >= 0 && eco.day - l.closedDay > 60) continue;
      const bKind: LKind = eco.firm(l.borrowerId) ? 'firm' : 'household';
      for (const s of l.spentOn) {
        const k = `${l.id}|${s.agent}|${s.what}`;
        const seen = this.spendSeen.get(k);
        if (seen === s.amount) continue;
        const to = eco.agents.get(s.agent);
        if (!to) continue;
        const toKind: LKind = to.kind === 'firm' ? 'firm' : to.kind === 'household' ? 'household' : to.kind === 'bank' ? 'bank' : 'public';
        if (toKind === 'public') this.lineage.node('public', to.id, to.kind === 'world' ? 'The wider region' : to.name, 0, eco.lotOf(to.id));
        if (seen === undefined) {
          this.lineage.edge('paid', nodeKey(bKind, l.borrowerId), nodeKey(toKind, s.agent), eco.day, s.amount, `paid for ${s.what} with the ${fmtMoney(l.principal0)} ${loanLabel(l.purpose)}`);
        } else {
          const e = this.lineage.outOf(nodeKey(bKind, l.borrowerId)).find((x) => x.kind === 'paid' && x.to === nodeKey(toKind, s.agent) && x.label.includes(s.what));
          if (e) e.amount = s.amount;
        }
        this.spendSeen.set(k, s.amount);
      }
    }
    // households who left town
    for (const h of eco.households) {
      if (!h.departed) continue;
      const n = this.lineage.get(nodeKey('household', h.id));
      if (n && n.end === undefined) this.lineage.end(n.key, eco.day, 'left town');
    }
  }

  // ============================================================================ records

  milestone(key: string, tier: 1 | 2 | 3, title: string, text: string, agent?: number, lot?: number): void {
    if (this.flags.has(key)) return;
    this.flags.add(key);
    const eco = this.eco;
    // as the town grows, even "firsts" become less of an event
    const pop = eco.population();
    const t = (pop > 60 && tier === 3 ? 2 : tier) as 1 | 2 | 3;
    this.milestones.push({ key, day: eco.day, title, text, agent, lot: lot ?? (agent !== undefined ? eco.lotOf(agent) : undefined), tier: t });
    eco.headline(`${title.charAt(0)}${title.slice(1).toLowerCase()}: ${text}`, 'good', agent, lot, `ms-${key}`, 0);
  }

  hasFlag(key: string): boolean {
    return this.flags.has(key);
  }

  record(text: string, category: DecisionRecord['category'], keys: string[], watch: DecisionRecord['watch']): DecisionRecord {
    const eco = this.eco;
    const d: DecisionRecord = { id: this.nextDec++, day: eco.day, text, category, keys, before: this.indicators(), watch };
    this.decisions.push(d);
    this.lineage.node('decision', d.id, text, eco.day);
    for (const k of keys) if (this.lineage.get(k)) this.lineage.edge('decided', nodeKey('decision', d.id), k, eco.day, 0, 'concerned');
    return d;
  }

  recordLoanDecision(sit: Situation, c: LoanChoice): void {
    const eco = this.eco;
    const r = sit.loan!;
    const b = r.app.borrower;
    const bank = eco.bank(r.bankId);
    const bname = bank?.name ?? 'the bank';
    const first = r.first;
    const kind = loanLabel(r.purpose);
    let text: string;
    const terms: string[] = [];
    if (c.approve) {
      if (c.amount !== r.requested) terms.push(`${fmtMoney(c.amount)} instead of the ${fmtMoney(r.requested)} asked for`);
      if (r.offer && Math.abs(c.rate - r.offer.rate) > 0.0009) terms.push(`at ${pct(c.rate, 1)}`);
      if (c.termMonths !== r.app.termMonths) terms.push(`over ${Math.round(c.termMonths / 12)} years`);
      if (c.collateral === 'home') terms.push("secured on the owner's home");
      if (c.collateral === 'none') terms.push('unsecured');
      if (r.home) {
        const dp = 1 - c.amount / Math.max(1, r.home.price);
        const what = r.home.build ? `build a home at ${this.lotAddress(r.home.lotId)}` : `buy ${this.address(r.home.unitId)}`;
        text = `Approved ${bname}'s ${first ? 'first ' : ''}${fmtMoney(c.amount)} mortgage for ${b.name} to ${what} (${pct(dp, 0)} down)${terms.length > 1 ? ` — ${terms.slice(1).join(', ')}` : ''}.`;
      } else text = `Approved ${bname}'s ${first ? 'first ' : ''}${fmtMoney(c.amount)} ${kind} to ${b.name}${terms.length ? ` — ${terms.join(', ')}` : ''}.`;
    } else text = `Turned down ${b.name}'s ${fmtMoney(r.requested)} ${kind}${r.offer ? ` (${bank?.short ?? 'the bank'} would have lent)` : ''}.`;
    const keys = [nodeKey('bank', r.bankId), nodeKey(b.kind === 'firm' ? 'firm' : 'household', b.id)];
    if (r.home && r.home.unitId >= 0) keys.push(nodeKey('unit', r.home.unitId));
    const watch: DecisionRecord['watch'] =
      r.purpose === 'home' || r.purpose === 'investment_property'
        ? ['mortgageLending12', 'hpi', 'construction', 'leverage']
        : r.purpose === 'development'
          ? ['construction', 'hpi', 'population']
          : ['firms', 'jobs', 'businessLending12', 'money'];
    const d = this.record(text, r.home ? 'mortgage' : 'loan', keys, watch);
    // link the decision to the loan once it exists (next origination for this borrower)
    void d;
  }

  /** A rule change by the player (or by a decision that implies it). */
  setRule<K extends keyof GenesisRules>(key: K, value: GenesisRules[K], byPlayer = true): void {
    const old = this.rules[key];
    if (old === value) return;
    this.rules[key] = value;
    for (const b of this.eco.banks) if (b.alive) setStandards(this.eco, b);
    const text = ruleText(key, old, value);
    if (text) this.record(text, 'rules', [], ruleWatch(key));
    void byPlayer;
  }

  // ============================================================================ indicators

  genesisShare(): number {
    let all = 0;
    let gen = 0;
    for (const l of this.eco.loans.values()) {
      all += l.principal0;
      if (l.originatorId === this.genesisBankId) gen += l.principal0;
    }
    return all > 0 ? gen / all : 1;
  }

  indicators(): Indicators {
    const eco = this.eco;
    let mort = 0;
    let bus = 0;
    let credit = 0;
    let hhDebt = 0;
    for (const l of eco.loans.values()) {
      if (!l.active) continue;
      credit += l.balance;
      if (l.kind === 'mortgage') mort += l.balance;
      if (l.kind === 'business') bus += l.balance;
      if (eco.household(l.borrowerId)) hhDebt += l.balance;
    }
    let income = 0;
    let jobs = 0;
    for (const h of eco.households) {
      if (h.departed) continue;
      income += Math.max(0, h.income) * 12;
      if (h.employed) jobs++;
    }
    const since = eco.day - DAYS_PER_YEAR;
    let ml = 0;
    let bl = 0;
    let defs = 0;
    for (const l of eco.loans.values()) {
      if (l.day >= since) {
        if (l.kind === 'mortgage') ml += l.principal0;
        else if (l.kind === 'business') bl += l.principal0;
      }
      if (l.status === 'defaulted' && l.closedDay >= since) defs++;
    }
    let sales = 0;
    for (const u of eco.units) if (u.lastSale.day >= since) sales++;
    let active = 0;
    for (const p of eco.projects.values()) if (p.status === 'active') active++;
    let eq = 0;
    let rwa = 0;
    for (const b of eco.aliveBanks()) {
      const m = metrics(eco, b);
      eq += m.equity;
      rwa += m.rwa;
    }
    return {
      day: eco.day,
      money: eco.broadMoney(),
      credit,
      mortgages: mort,
      businessLoans: bus,
      population: eco.population(),
      firms: eco.firms.filter((f) => f.status === 'open').length,
      jobs,
      unemployment: eco.unemploymentRate(),
      hpi: eco.market.hpi,
      construction: active,
      mortgageLending12: ml,
      businessLending12: bl,
      houseSales12: sales,
      defaults12: defs,
      leverage: income > 0 ? hhDebt / income : 0,
      capitalRatio: rwa > 0 ? eq / rwa : 0,
      banks: eco.aliveBanks().length,
      genesisShare: this.genesisShare(),
    };
  }

  // ============================================================================ helpers

  hh(h: Household): void {
    this.lineage.node('household', h.id, h.name, h.arrived < 0 ? 0 : h.arrived, this.eco.lotOf(h.id));
  }

  unitNode(u: Unit): void {
    this.lineage.node('unit', u.id, this.address(u.id), 0, u.lotId, this.eco.city.lots[u.lotId]?.w > 1 ? 'apartment' : 'house');
  }

  /** A street address for a home ("12 Oak Street", "Flat 3, 18 Elm Avenue"). */
  address(unitId: number): string {
    const eco = this.eco;
    const u = eco.units[unitId];
    if (!u) return 'a home';
    const units = eco.lotUnits.get(u.lotId) ?? [];
    const street = this.lotAddress(u.lotId);
    if (units.length > 1) return `Flat ${units.indexOf(unitId) + 1}, ${street}`;
    return street;
  }

  /** Street address of a lot ("12 Oak Street"). */
  lotAddress(lotId: number): string {
    const lot = this.eco.city.lots[lotId];
    if (!lot) return 'a lot in town';
    const vertical = lot.facing === 2 || lot.facing === 8;
    const road = lot.road;
    const streetIdx = vertical ? road.x : road.y;
    const along = vertical ? lot.y : lot.x;
    const name = this.streets[Math.floor(streetIdx / 5) % this.streets.length] + (vertical ? ' Avenue' : ' Street');
    const number = along * 2 + (vertical ? 1 : 2);
    return `${number} ${name}`;
  }
}

// ============================================================================ text helpers

function frac(x: number): number {
  return x - Math.floor(x);
}

function streetNames(city: string): string[] {
  const base = ['Oak', 'Elm', 'Mill', 'River', 'Church', 'Station', 'Maple', 'Cedar', 'Bridge', 'Market', 'Orchard', 'Chapel'];
  let h = 0;
  for (let i = 0; i < city.length; i++) h = (h * 31 + city.charCodeAt(i)) | 0;
  const k = Math.abs(h) % base.length;
  return [...base.slice(k), ...base.slice(0, k)];
}

function expansionPlan(eco: Economy, f: Firm, app: LoanApp, exp?: BusinessPlan['expansion']): BusinessPlan {
  const x = exp ?? { addK: app.amount / 1.05, unitPrice: 1, cost: app.amount, equity: 0 };
  const plan: BusinessPlan = {
    firmId: f.id,
    name: f.name,
    sector: f.sector,
    subtype: f.subtype,
    ownerId: f.ownerId,
    lotId: f.lotId,
    pitch: 'wants to add capacity',
    market: 'Its existing customers, and the orders it now turns away',
    purchases: ['New premises space', 'Equipment'],
    staffNames: f.workers.map((id) => eco.nameOf(id)),
    base: null as never,
    A: f.A,
    kappa: f.kappa,
    price: f.price,
    wage: f.wage,
    expansion: x,
  };
  plan.base = expansionFigures(eco, f, plan, app.amount, eco.policy.policyRate + f.acct.bank.spreads.business, app.termMonths);
  return plan;
}

function troubleText(eco: Economy, l: Loan, a: string): string {
  const who = eco.nameOf(l.borrowerId);
  const lender = eco.nameOf(l.servicerId);
  switch (a) {
    case 'restructure':
      return `Had ${lender} restructure ${who}'s loan after a missed payment.`;
    case 'extend':
      return `Gave ${who} three more years to repay ${lender}.`;
    case 'lend':
      return `Had ${lender} lend more to ${who} after a missed payment.`;
    case 'writedown':
      return `Had ${lender} forgive 30% of ${who}'s loan.`;
    case 'demand':
      return `Had ${lender} call in ${who}'s loan.`;
    case 'seize':
      return `Had ${lender} seize ${who}'s collateral.`;
    default:
      return `Let ${who}'s missed payment run its course.`;
  }
}

function constraintText(a: string): string {
  switch (a) {
    case 'stop':
      return 'stopped lending for six months';
    case 'rates':
      return 'raised loan rates to ration credit';
    case 'sellsec':
      return 'sold its government securities';
    case 'sellloans':
      return 'sold loans to investors';
    case 'securitize':
      return 'securitised mortgages';
    case 'wholesale':
      return 'took on short-term wholesale funding';
    case 'retain':
      return 'retained all its earnings';
    case 'capital':
      return 'raised new capital from investors';
    default:
      return a;
  }
}

function runText(b: Bank, a: string): string {
  switch (a) {
    case 'ela':
      return `Provided emergency liquidity to ${b.name} during a run.`;
    case 'guarantee':
      return `Guaranteed every deposit in town during a run on ${b.name}.`;
    case 'sell':
      return `Forced ${b.name} to sell assets during a run.`;
    case 'acquire':
      return `Arranged a takeover of ${b.name} during a run.`;
    case 'recap':
      return `Recapitalised ${b.name} with public money during a run.`;
    case 'fail':
      return `Let ${b.name} fail during a run.`;
    default:
      return `Stood back during a run on ${b.name}.`;
  }
}

function failureText(b: Bank, a: string): string {
  switch (a) {
    case 'bailout':
      return `Bailed out ${b.name} with public money.`;
    case 'forbear':
      return `Let ${b.name} keep operating despite its losses.`;
    case 'ela':
      return `Provided emergency liquidity to ${b.name}.`;
    default:
      return `Allowed ${b.name} to fail.`;
  }
}

function ruleText(key: keyof GenesisRules, old: unknown, value: unknown): string | null {
  const p = (x: unknown) => pct(Number(x), 0);
  const dir = (a: unknown, b: unknown) => (Number(b) > Number(a) ? 'Raised' : 'Reduced');
  switch (key) {
    case 'maxLTV':
      return `${Number(value) > Number(old) ? 'Reduced' : 'Raised'} the mortgage down-payment requirement from ${p(1 - Number(old))} to ${p(1 - Number(value))}.`;
    case 'maxDTI':
      return `${dir(old, value)} the limit on debt payments from ${p(old)} to ${p(value)} of income.`;
    case 'maxPD':
      return `${Number(value) > Number(old) ? 'Loosened' : 'Tightened'} the minimum borrower quality (highest accepted default risk ${p(old)} → ${p(value)}).`;
    case 'minDSCR':
      return `${dir(old, value)} the cash-flow cover required of businesses from ${Number(old).toFixed(2)}x to ${Number(value).toFixed(2)}x.`;
    case 'securitization':
      return value ? 'Allowed banks to securitise mortgages.' : 'Banned the securitisation of mortgages.';
    case 'dividends':
      return value ? 'Allowed banks to pay dividends again.' : 'Barred banks from paying dividends.';
    case 'review':
      return value === 'all' ? 'Took every loan back onto your desk.' : value === 'large' ? 'Delegated routine loans to the banks.' : 'Stopped reviewing individual loans.';
    case 'reviewThreshold':
      return null;
  }
  return null;
}

function ruleWatch(key: keyof GenesisRules): DecisionRecord['watch'] {
  switch (key) {
    case 'maxLTV':
    case 'maxDTI':
      return ['mortgageLending12', 'hpi', 'construction', 'leverage'];
    case 'securitization':
      return ['mortgageLending12', 'mortgages', 'capitalRatio', 'hpi'];
    case 'maxPD':
    case 'minDSCR':
      return ['businessLending12', 'firms', 'defaults12'];
    default:
      return ['credit', 'capitalRatio'];
  }
}

export { DAYS_PER_MONTH };
