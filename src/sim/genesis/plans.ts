// Business plans for Genesis Mode: what a prospective business needs, what it expects to earn,
// and how its plan scales when the loan is resized. Also the search for business opportunities
// (unmet demand, goods bought from outside, nowhere for newcomers to live).

import { CFG, DAYS_PER_MONTH, SECTORS } from '../config';
import type { Economy } from '../economy';
import { Firm, type Household } from '../agents';
import type { Sector } from '../types';
import { annuityPayment } from '../loan';
import { firmColor } from '../firms';
import { firmName } from '../names';
import { vacantRentals } from '../housing';
import type { Lot } from '../../world/city';
import type { BusinessPlan, PlanFigures } from './types';
import { IMPORT_MARKUP, outsideBuildPrice, regionPrice } from './trade';

/** Small frontier businesses: lighter premises than the standard town's established firms. */
export const GENESIS_SECTOR: Record<Sector, { A: number; kappa: number; premisesShare: number; staff: number }> = {
  factory: { A: 7800, kappa: 5.5, premisesShare: 0.4, staff: 2 },
  retail: { A: 13000, kappa: 3.5, premisesShare: 0.55, staff: 2 },
  service: { A: 6600, kappa: 5, premisesShare: 0.6, staff: 2 },
  builder: { A: 8800, kappa: 2.5, premisesShare: 0.35, staff: 2 },
};

const WORKING_SHARE = 0.16;

export function hasLocalBuilder(eco: Economy): boolean {
  return eco.firms.some((f) => f.status === 'open' && f.sector === 'builder');
}

export function hasLocalFactory(eco: Economy): boolean {
  return eco.firms.some((f) => f.status === 'open' && f.sector === 'factory');
}

/** Price of a $ of real construction work: local builders, or outside contractors at a premium. */
export function buildPrice(eco: Economy): number {
  return hasLocalBuilder(eco) ? Math.min(eco.market.builderPrice, outsideBuildPrice(eco)) : outsideBuildPrice(eco);
}

/** Price of equipment: from a local factory, or imported from the region. */
export function equipPrice(eco: Economy): number {
  return hasLocalFactory(eco) ? eco.market.factoryPrice : regionPrice(eco) * IMPORT_MARKUP;
}

export function sectorPrice(eco: Economy, s: Sector): number {
  const m = eco.market;
  return s === 'retail' ? m.retailPrice : s === 'service' ? m.servicePrice : s === 'factory' ? m.factoryPrice : m.builderPrice;
}

/**
 * The figures of a start-up plan with a given budget (owner's equity + loan): what it can build,
 * how many people it can employ, and what it should earn at 85% of capacity.
 */
export function startupFigures(eco: Economy, plan: BusinessPlan, loan: number, rate: number, termMonths: number): PlanFigures {
  const gs = GENESIS_SECTOR[plan.sector];
  const cost = plan.base.equity + loan;
  const working = cost * WORKING_SHARE;
  const invest = cost - working;
  const premises = invest * gs.premisesShare;
  const equipment = invest - premises;
  const K = premises / buildPrice(eco) + equipment / equipPrice(eco);
  const capitalCap = K / plan.kappa;
  const staff = Math.max(1, Math.min(14, Math.round(capitalCap / plan.A)));
  const capacity = Math.min(capitalCap, staff * plan.A);
  return figures(eco, plan, { loan, equity: plan.base.equity, cost, premises, equipment, working, staff, capacity, K }, rate, termMonths);
}

function figures(
  eco: Economy,
  plan: BusinessPlan,
  b: { loan: number; equity: number; cost: number; premises: number; equipment: number; working: number; staff: number; capacity: number; K: number },
  rate: number,
  termMonths: number,
): PlanFigures {
  const units = b.capacity * CFG.targetUtilization;
  const revenue = units * plan.price;
  const sp = SECTORS[plan.sector];
  const inputs = plan.sector === 'retail' || plan.sector === 'builder' ? units * sp.inputShare * Math.min(eco.market.factoryPrice, regionPrice(eco) * IMPORT_MARKUP) : 0;
  const wages = b.staff * plan.wage;
  const depreciation = (b.K * CFG.depreciation * eco.market.factoryPrice) / 12;
  const interest = (b.loan * rate) / 12;
  const payment = b.loan > 0 ? annuityPayment(b.loan, rate, termMonths) : 0;
  const profit = revenue - wages - inputs - depreciation - interest;
  const cash = revenue - wages - inputs;
  return {
    loan: b.loan,
    equity: b.equity,
    cost: b.cost,
    premises: b.premises,
    equipment: b.equipment,
    working: b.working,
    staff: b.staff,
    capacity: b.capacity,
    revenue,
    wages,
    inputs,
    depreciation,
    interest,
    payment,
    profit,
    dscr: payment > 0 ? cash / payment : 9,
  };
}

/** Figures for an expansion of an existing business, scaled to the loan finally approved. */
export function expansionFigures(eco: Economy, f: Firm, plan: BusinessPlan, loan: number, rate: number, termMonths: number): PlanFigures {
  const x = plan.expansion!;
  const cost = x.equity + loan;
  const addK = (x.addK * cost) / Math.max(1, x.cost);
  const K = f.K + addK;
  const capitalCap = K / f.kappa;
  const staff = Math.max(f.workers.length, Math.round(Math.min(capitalCap, Math.max(f.expDemand * 1.1, f.capacity)) / f.A + 0.2));
  const capacity = Math.min(capitalCap, staff * f.A);
  const debtOther = f.debtService();
  const fig = figures(eco, plan, { loan, equity: x.equity, cost, premises: cost * 0.5, equipment: cost * 0.5, working: 0, staff, capacity, K }, rate, termMonths);
  // the business keeps paying its existing loans too
  const cash = fig.revenue - fig.wages - fig.inputs;
  fig.payment += debtOther;
  fig.dscr = fig.payment > 0 ? cash / fig.payment : 9;
  return fig;
}

// ---------------------------------------------------------------------------------- lots

/** Middle of the developed part of town (where new businesses and homes want to be). */
export function townCentre(eco: Economy): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const [lid, use] of eco.lotUse) {
    if (use.type === 'cb' || use.type === 'cityhall' || use.type === 'park') continue;
    const l = eco.city.lots[lid];
    sx += l.x + l.w / 2;
    sy += l.y + l.d / 2;
    n++;
  }
  if (!n) {
    const cb = eco.city.lots[eco.cb.lotId];
    return { x: cb.x + cb.w / 2, y: cb.y + cb.d / 2 };
  }
  return { x: sx / n, y: sy / n };
}

/** Pick a free lot close to town: the settlement grows outward from where people already are. */
export function pickNearLot(eco: Economy, cands: Lot[]): Lot | undefined {
  if (!cands.length) return undefined;
  const c = townCentre(eco);
  return eco.rng.weighted(cands, (l) => {
    const dx = l.x + l.w / 2 - c.x;
    const dy = l.y + l.d / 2 - c.y;
    const d2 = dx * dx + dy * dy;
    return 1 / (1 + d2 / 12) ** 2;
  });
}

export function freeLots(eco: Economy, zone: 'com' | 'ind' | 'res', big: boolean): Lot[] {
  return eco.city.lots.filter((l) => {
    if (l.reserved || eco.lotUse.has(l.id)) return false;
    if ((l.w >= 2) !== big) return false;
    if (zone === 'com') return l.zone === 'com' || (l.zone === 'civic' && big);
    return l.zone === zone;
  });
}

// ---------------------------------------------------------------------------------- plans

const SUBTYPES: Record<Sector, string[]> = {
  retail: ['grocery', 'hardware', 'clothing', 'bakery', 'pharmacy', 'furniture', 'books', 'electronics'],
  service: ['diner', 'cafe', 'salon', 'clinic', 'restaurant', 'gym', 'cinema', 'lawoffice'],
  factory: ['steel', 'furniture', 'textiles', 'food', 'electronics', 'chemicals'],
  builder: ['builder'],
};

const PITCH: Record<Sector, string> = {
  factory: 'makes goods to sell across the river and to local businesses',
  retail: 'sells everyday goods so people stop shopping across the river',
  service: 'serves locals who currently go without',
  builder: 'builds homes and premises so the town stops relying on outside contractors',
};

const MARKET: Record<Sector, string> = {
  factory: 'Buyers in the wider region, and local shops and builders',
  retail: 'Local households (who now buy their goods across the river)',
  service: 'Local households and City Hall',
  builder: 'New homes, business premises and repairs',
};

export function pickSubtype(eco: Economy, sector: Sector): string {
  const have = new Map<string, number>();
  for (const f of eco.firms) if (f.sector === sector && f.status !== 'closed') have.set(f.subtype, (have.get(f.subtype) ?? 0) + 1);
  const opts = SUBTYPES[sector];
  return eco.rng.weighted(opts, (s) => 1 / (1 + (have.get(s) ?? 0) * 3)) ?? opts[0];
}

/**
 * Draft a start-up: a new (not yet registered) firm on a free lot, its owner and the plan the
 * bank will be asked to finance. `staff` sets the size the entrepreneur has in mind.
 */
export function draftStartup(
  eco: Economy,
  owner: Household,
  sector: Sector,
  opts: { name?: string; subtype?: string; lot?: Lot; staff?: number; equity?: number; A?: number; kappa?: number; pitch?: string; market?: string; budget?: number } = {},
): BusinessPlan | null {
  const gs = GENESIS_SECTOR[sector];
  const big = sector === 'factory' || sector === 'builder';
  const lot = opts.lot ?? pickNearLot(eco, freeLots(eco, big ? 'ind' : 'com', big));
  if (!lot) return null;
  const subtype = opts.subtype ?? pickSubtype(eco, sector);
  const name = opts.name ?? firmName(eco.rng, sector, subtype, eco.city.name);
  const A = opts.A ?? gs.A * (0.97 + 0.06 * eco.rng.next());
  const kappa = opts.kappa ?? gs.kappa;
  const staff = opts.staff ?? gs.staff;
  const wage = eco.market.wageIndex * 1.02;
  const price = sectorPrice(eco, sector);
  // budget for `staff` people at ~95% of capital capacity, plus working capital
  const K = (staff * A * kappa) / 0.95;
  const invest = K * (gs.premisesShare * buildPrice(eco) + (1 - gs.premisesShare) * equipPrice(eco));
  const total = opts.budget ?? invest / (1 - WORKING_SHARE);
  const savings = Math.max(0, owner.acct.balance - CFG.essentials * eco.market.cpi * 2);
  const equity = Math.max(0, Math.min(opts.equity ?? savings * 0.6, total * 0.3));
  const loan = Math.max(0, Math.round((total - equity) / 1000) * 1000);
  const plan: BusinessPlan = {
    firmId: -1,
    name,
    sector,
    subtype,
    ownerId: owner.id,
    lotId: lot.id,
    pitch: opts.pitch ?? PITCH[sector],
    market: opts.market ?? MARKET[sector],
    purchases: [],
    staffNames: [owner.name],
    base: null as unknown as PlanFigures,
    A,
    kappa,
    price,
    wage,
  };
  plan.base = { ...startupFigures(eco, { ...plan, base: { equity } as PlanFigures }, loan, eco.policy.policyRate + 0.03, 96) };
  plan.base.equity = equity;
  plan.purchases = [
    `Premises: ${hasLocalBuilder(eco) ? 'built by a local builder' : 'built by contractors from across the river'}`,
    `Equipment: ${hasLocalFactory(eco) && sector !== 'factory' ? 'from local workshops' : 'imported from the region'}`,
    'Working capital: wages and supplies until sales come in',
  ];
  return plan;
}

/** Register the prospective firm (not yet trading) so it can be shown and referred to. */
export function registerProspect(eco: Economy, plan: BusinessPlan): Firm {
  const f = new Firm(
    eco.newId(),
    plan.name,
    plan.sector,
    plan.subtype,
    plan.lotId,
    plan.ownerId,
    firmColor(eco.rng),
    eco.rng.int(0, DAYS_PER_MONTH - 1),
    eco.rng.int(0, DAYS_PER_MONTH - 1),
    eco.day,
  );
  f.acct = eco.openAccount(f.id, eco.household(plan.ownerId)!.acct.bank);
  f.A = plan.A;
  f.kappa = plan.kappa;
  f.K = 0;
  f.price = plan.price;
  f.wage = plan.wage;
  f.status = 'planned';
  eco.register(f);
  plan.firmId = f.id;
  return f;
}

// ---------------------------------------------------------------------------------- opportunities

export interface Opportunity {
  sector: Sector;
  reason: string;
  /** rough monthly market in $ */
  market: number;
  staff: number;
}

export interface TradeMonth {
  exports: number;
  importsConsumer: number;
  importsServices: number;
  importsGoods: number;
  importsBuild: number;
  outsideBuild: number;
}

export function newTradeMonth(): TradeMonth {
  return { exports: 0, importsConsumer: 0, importsServices: 0, importsGoods: 0, importsBuild: 0, outsideBuild: 0 };
}

/** Where a new business would make sense right now. */
export function findOpportunities(eco: Economy, recent: TradeMonth[]): Opportunity[] {
  const out: Opportunity[] = [];
  const avg = (k: keyof TradeMonth, n = 4) => {
    const xs = recent.slice(-n);
    return xs.length ? xs.reduce((s, x) => s + x[k], 0) / xs.length : 0;
  };
  const alive = (s: Sector) => eco.firms.filter((f) => f.status !== 'closed' && f.sector === s);
  let vac = 0;
  let unemployed = 0;
  for (const f of eco.firms) if (f.status !== 'closed') vac += Math.max(0, f.vacancies);
  for (const h of eco.households) if (!h.departed && !h.employed && !h.retired && (h.homeUnit >= 0 || h.lodging)) unemployed++;
  const rentals = vacantRentals(eco).length;
  const builders = alive('builder').length;
  // monthly sales one worker brings in at 85% of capacity, by sector
  const perWorker = (s: Sector) => GENESIS_SECTOR[s].A * CFG.targetUtilization * sectorPrice(eco, s);
  const staffFor = (s: Sector, market: number) => Math.max(1, Math.min(4, Math.floor((market * 0.8) / perWorker(s))));
  // 1. jobs but no homes: somebody has to build
  if (builders === 0 && vac > unemployed && rentals === 0) {
    out.push({ sector: 'builder', reason: `Businesses want to hire ${vac - unemployed} more people, but there is nowhere for newcomers to live`, market: 30_000, staff: 2 });
  } else if (builders === 0 && avg('outsideBuild', 6) > 6_000) {
    out.push({ sector: 'builder', reason: `The town pays outside contractors about ${Math.round(avg('outsideBuild', 6) / 1000)}K a month to build`, market: avg('outsideBuild', 6), staff: staffFor('builder', avg('outsideBuild', 6)) });
  } else if (builders > 0 && vac > unemployed + 2 && rentals === 0 && builders < 1 + Math.floor(eco.population() / 60)) {
    out.push({ sector: 'builder', reason: 'Homes cannot be built fast enough for the people businesses want to hire', market: 40_000, staff: 2 });
  }
  // how busy the town's existing shops and services already are (no point opening another beside idle ones)
  const busy = (s: Sector) => {
    let u = 0;
    let cap = 0;
    for (const f of alive(s)) {
      if (f.status !== 'open') return 0; // one is still opening: wait and see
      u += f.last.units + f.last.unmet;
      cap += Math.max(1, f.capacity);
    }
    return cap > 0 ? u / cap : 1;
  };
  // 2. goods bought across the river (a shop needs enough customers to keep one person busy)
  const goods = avg('importsConsumer');
  if (goods > perWorker('retail') * 0.9 && busy('retail') > 0.75) {
    out.push({ sector: 'retail', reason: `Locals spend about ${Math.round(goods / 1000)}K a month on goods bought across the river`, market: goods, staff: staffFor('retail', goods) });
  }
  // 3. services people go without
  const svc = avg('importsServices');
  if (svc > perWorker('service') * 0.9 && busy('service') > 0.75) {
    out.push({ sector: 'service', reason: `People travel out of town for about ${Math.round(svc / 1000)}K a month of services, or go without`, market: svc, staff: staffFor('service', svc) });
  }
  // 4. factories turning away orders
  const factories = alive('factory');
  let unmet = 0;
  let cap = 0;
  for (const f of factories) {
    unmet += f.last.unmet;
    cap += f.capacity;
  }
  if (factories.length && cap > 0 && unmet > cap * 0.35 && factories.every((f) => f.project >= 0 || f.health !== 'healthy' || f.hotMonths >= 2)) {
    out.push({ sector: 'factory', reason: `Local workshops are turning away orders worth ${Math.round((unmet * eco.market.factoryPrice) / 1000)}K a month`, market: unmet, staff: 2 });
  }
  return out;
}
