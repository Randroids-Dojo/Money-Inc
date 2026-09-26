// Markets: securities pricing, the consumer goods market, the labour market and the
// monthly price indices (CPI, wages, confidence).

import { CFG, DAYS_PER_MONTH, SECTORS } from './config';
import type { Economy } from './economy';
import type { Firm, Household, MbsPool } from './agents';
import type { Bank } from './bank';
import { collateralNow, growth } from './banking';
import { fundExcessCash } from './fund';

// ============================================================================ securities

/** Price (per $1 of par) of a bond with an annual coupon, given a market yield. */
export function bondPrice(coupon: number, y: number, years = CFG.bondYears): number {
  const yy = Math.max(-0.009, y);
  if (Math.abs(yy) < 1e-6) return 1 + coupon * years;
  const df = Math.pow(1 + yy, -years);
  return (coupon * (1 - df)) / yy + df;
}

/** Average spread over the policy rate paid by the loans in an MBS pool (they float). */
export function poolSpread(pool: MbsPool): number {
  let s = 0,
    b = 0;
  for (const l of pool.loans) {
    if (!l.active) continue;
    s += l.spread * l.balance;
    b += l.balance;
  }
  return b > 0 ? s / b : 0.02;
}

/**
 * Expected annual loss rate on a pool: current delinquencies, the pool's track record, and how
 * far house prices would have to fall before its borrowers owe more than their homes are worth.
 */
export function poolExpectedLoss(eco: Economy, pool: MbsPool): number {
  const decline = Math.max(0, -eco.market.hpiExpect);
  const shock = 1 / Math.max(0.5, 1 - 1.5 * decline);
  let lgd = 0,
    bal = 0,
    bad = 0;
  for (const l of pool.loans) {
    if (!l.active) continue;
    const col = collateralNow(eco, l);
    const ltv = col > 0 ? l.balance / col : 1.5;
    // a foreclosure recovers ~80% of the home's value after costs
    lgd += l.balance * (0.1 + Math.max(0, ltv * shock - 0.8));
    if (l.status === 'late' || l.status === 'nonperforming') bad += l.balance;
    bal += l.balance;
  }
  if (bal <= 0) return 0;
  const pd = 0.015 + 0.6 * (bad / bal) + 0.4 * Math.max(0, eco.market.unemployment - 0.05);
  const pastLoss = pool.originalBalance > 0 ? pool.lossesCum / pool.originalBalance : 0;
  return pd * (lgd / bal) + 0.3 * pastLoss;
}

/** Market price of an MBS pool: investors demand a spread for fear and expected losses. */
export function mbsPrice(eco: Economy, pool: MbsPool): number {
  const f = eco.fund;
  // idle cash in the fund bids up MBS (lower required spread)
  const wall = Math.min(0.012, 0.03 * fundExcessCash(eco));
  const required = 0.012 + 0.03 * f.fear + poolExpectedLoss(eco, pool) + 0.01 * eco.market.panic - wall;
  const price = 1 + CFG.mbsDuration * (poolSpread(pool) - required);
  return Math.max(0.3, Math.min(1.06, price));
}

export function dailyMarkets(eco: Economy): void {
  const m = eco.market;
  const pol = eco.policy;
  m.billRate = Math.max(0, pol.policyRate - 0.001);
  m.rateExpect += (pol.policyRate - m.rateExpect) / 180;
  const t = eco.treasury;
  const cbShare = t.bondPar > 0 ? eco.cb.bondPar / t.bondPar : 0;
  const termPremium = 0.012 - 0.035 * cbShare + 0.25 * Math.max(-0.02, Math.min(0.06, m.inflationExpect - CFG.inflationTarget)) + 0.004 * m.panic;
  const target = Math.max(0.002, 0.45 * pol.policyRate + 0.55 * m.rateExpect + termPremium);
  m.bondYield += (target - m.bondYield) * 0.05;
  m.interbankStress *= 0.993;
  m.panic *= 0.993;
  m.interbankRate = pol.policyRate + 0.001 + 0.03 * m.interbankStress;
  for (const p of eco.pools.values()) {
    if (p.balance <= 0) continue;
    p.price += (mbsPrice(eco, p) - p.price) * 0.15;
  }
}

// ============================================================================ goods market

export function retailShare(): number {
  return SECTORS.retail.demandShare;
}

function lotXY(eco: Economy, lotId: number): { x: number; y: number } {
  const l = eco.city.lots[lotId];
  return l ? { x: l.x + l.w / 2, y: l.y + l.d / 2 } : { x: 0, y: 0 };
}

/** Households pick a few regular shops: cheap and close by. */
export function pickFavourites(eco: Economy, h: Household, sector: 'retail' | 'service', open: Firm[]): number[] {
  if (!open.length) return [];
  const home = lotXY(eco, eco.lotOf(h.id));
  const chosen: number[] = [];
  const pool = open.slice();
  for (let i = 0; i < 3 && pool.length; i++) {
    const f = eco.rng.weighted(pool, (x) => {
      const p = lotXY(eco, x.lotId);
      const dist = Math.abs(p.x - home.x) + Math.abs(p.y - home.y);
      // bigger shops serve more customers: pick in proportion to capacity
      return (Math.pow(1 / Math.max(0.2, x.price), 3) / (1 + dist / 10)) * (0.15 + Math.max(1, x.capacity) / 20000);
    });
    if (!f) break;
    chosen.push(f.id);
    pool.splice(pool.indexOf(f), 1);
  }
  return chosen;
}

export function shoppingDay(eco: Economy): void {
  const openRetail: Firm[] = [];
  const openService: Firm[] = [];
  for (const f of eco.firms) {
    if (f.status !== 'open') continue;
    if (f.sector === 'retail') openRetail.push(f);
    else if (f.sector === 'service') openService.push(f);
  }
  const rs = retailShare();
  for (const h of eco.households) {
    if (h.departed || h.budget <= 0) continue;
    const daily = (h.budget / DAYS_PER_MONTH) * (0.75 + 0.5 * eco.rng.next());
    const avail = h.acct.balance - 25;
    const spend = Math.min(daily, avail);
    if (spend < 5) {
      if (daily > 5) h.unmetThisMonth += 0; // could not afford: not "unmet" demand, just poverty
      continue;
    }
    const goods = spend * rs;
    buyFrom(eco, h, 'retail', goods, openRetail);
    buyFrom(eco, h, 'service', spend - goods, openService);
  }
}

/** Spend `dollars` at the household's regular shops; spill over to others if they are full. */
export function buyFrom(eco: Economy, h: Household, sector: 'retail' | 'service', dollars: number, open: Firm[], loan?: number): number {
  if (dollars <= 0 || !open.length) return 0;
  let favs = h.favs[sector].map((id) => eco.firm(id)).filter((f): f is Firm => !!f && f.status === 'open');
  if (favs.length < h.favs[sector].length || !favs.length) {
    h.favs[sector] = pickFavourites(eco, h, sector, open);
    favs = h.favs[sector].map((id) => eco.firm(id)!).filter(Boolean);
  }
  // order: weighted by price, random tie-breaks
  const order = favs
    .map((f) => ({ f, k: Math.pow(f.price, 3) * (0.6 + 0.8 * eco.rng.next()) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.f);
  // one extra random shop with spare capacity as a fallback
  const extra = open[Math.floor(eco.rng.next() * open.length)];
  if (extra && !order.includes(extra)) order.push(extra);
  let left = dollars;
  for (const f of order) {
    const units = left / f.price;
    let can = Math.min(units, Math.max(0, f.capToday));
    if (sector === 'retail') can = Math.min(can, Math.max(0, f.inventory));
    if (can > 0.01) {
      const moved = eco.ledger.transfer(h.acct, f.acct, can * f.price, 'spend', loan);
      if (loan !== undefined && moved > 0) eco.loans.get(loan)?.spend(f.id, moved, sector === 'retail' ? 'shopping' : 'services');
      const u = moved / f.price;
      f.capToday -= u;
      if (sector === 'retail') f.inventory -= u;
      f.m.units += u;
      f.m.revenue += moved;
      left -= moved;
    }
    if (units > can + 0.01) f.m.unmet += Math.min(units - can, units);
    if (left < 1) break;
  }
  const spent = dollars - left;
  h.spentThisMonth += spent;
  if (left > 1) h.unmetThisMonth += left;
  eco.monthCounters.consumption += spent;
  eco.monthCounters.unmetDemand += Math.max(0, left);
  return spent;
}

/**
 * Buy factory goods (inventory restocking, equipment, construction materials).
 * Returns units obtained. Unfilled orders are recorded as unmet demand at factories.
 */
export function buyGoods(
  eco: Economy,
  buyer: { acct: Household['acct']; id: number },
  units: number,
  kind: 'supply' | 'invest',
  loan?: number,
): number {
  if (units <= 0) return 0;
  const factories = eco.firms.filter((f) => f.status === 'open' && f.sector === 'factory');
  if (!factories.length) return 0;
  let left = units;
  // orders are split across suppliers by market share (capacity, cheaper is better);
  // whatever a supplier cannot deliver spills over to the others
  const share = factories.map((f) => Math.max(1, f.capacity) * Math.pow(Math.max(0.2, f.price), -4));
  const total = share.reduce((a, b) => a + b, 0);
  const order = factories.map((f, i) => ({ f, want: (units * share[i]) / total })).sort((a, b) => a.f.price - b.f.price);
  const deliver = (f: Firm, want: number) => {
    const afford = buyer.acct.balance / f.price;
    const can = Math.min(want, Math.max(0, f.inventory), afford);
    if (can <= 0.01) return;
    const moved = eco.ledger.transfer(buyer.acct, f.acct, can * f.price, kind, loan);
    if (loan !== undefined && moved > 0) eco.loans.get(loan)?.spend(f.id, moved, kind === 'invest' ? 'equipment' : 'supplies');
    const u = moved / f.price;
    f.inventory -= u;
    f.m.units += u;
    f.m.revenue += moved;
    left -= u;
  };
  for (const o of order) deliver(o.f, o.want);
  for (const o of order) {
    if (left <= 0.01) break;
    deliver(o.f, left);
  }
  if (left > 0.01) {
    // spread the unmet order across factories (shortage signal)
    const per = left / order.length;
    for (const o of order) o.f.m.unmet += per;
  }
  return units - left;
}

// ============================================================================ labour market

export function publicStaffTarget(eco: Economy): number {
  return Math.round(eco.population() * 0.1);
}

export function bankStaffTarget(eco: Economy, b: Bank): number {
  if (!b.alive) return 0;
  return Math.max(1, Math.min(5, Math.round((b.deposits + b.loanBook()) / 5_000_000)));
}

export function labourMarketDay(eco: Economy): void {
  const unemployed: Household[] = [];
  for (const h of eco.households) if (!h.departed && !h.employed && !h.retired && h.homeUnit >= 0 && eco.day >= h.searchUntil) unemployed.push(h);
  eco.rng.shuffle(unemployed);
  const employers: { id: number; vac: number }[] = [];
  for (const f of eco.firms) if ((f.status === 'open' || f.status === 'planned') && f.vacancies > 0) employers.push({ id: f.id, vac: f.vacancies });
  for (const b of eco.banks) {
    const v = bankStaffTarget(eco, b) - b.employees.length;
    if (v > 0) employers.push({ id: b.id, vac: v });
  }
  const tv = publicStaffTarget(eco) - eco.treasury.employees.length;
  if (tv > 0) employers.push({ id: eco.treasury.id, vac: tv });
  eco.rng.shuffle(employers);
  for (const e of employers) {
    for (let i = 0; i < e.vac; i++) {
      if (!eco.rng.chance(0.3)) continue;
      const h = unemployed.pop();
      if (h) {
        hire(eco, e.id, h);
        continue;
      }
      // no one unemployed: firms may poach by paying more
      const f = eco.firm(e.id);
      if (f && eco.rng.chance(0.15)) poach(eco, f);
    }
  }
}

function poach(eco: Economy, f: Firm): void {
  const cand = eco.households[Math.floor(eco.rng.next() * eco.households.length)];
  if (!cand || cand.departed || !cand.employed || cand.employer === f.id) return;
  const offer = f.wage * cand.skill;
  if (offer < cand.wage * 1.06) {
    // bid up wages next review
    f.hotMonths = Math.max(f.hotMonths, 1);
    return;
  }
  const prev = eco.firm(cand.employer);
  if (!prev) return; // public & bank staff are not poached
  fire(eco, cand, `left ${prev.name} for a better-paid job`, true);
  prev.vacancies++;
  hire(eco, f.id, cand);
}

export function hire(eco: Economy, employerId: number, h: Household): void {
  const emp = eco.agents.get(employerId);
  if (!emp) return;
  if (emp.kind === 'firm') {
    emp.workers.push(h.id);
    emp.vacancies = Math.max(0, emp.vacancies - 1);
    emp.hiredCum++;
    h.wage = emp.wage * h.skill;
  } else if (emp.kind === 'bank') {
    emp.employees.push(h.id);
    h.wage = eco.market.wageIndex * 1.15 * h.skill;
  } else if (emp.kind === 'treasury') {
    emp.employees.push(h.id);
    h.wage = eco.market.wageIndex * h.skill;
  } else return;
  h.employer = employerId;
  h.unemployedDays = 0;
  h.employedDays = 0;
  h.note(eco.day, `Hired by ${emp.name}`, 'good', undefined, employerId);
  eco.event('hire', employerId, undefined, h.id);
  eco.monthCounters.hires++;
}

export function fire(eco: Economy, h: Household, reason: string, quit = false): void {
  const emp = eco.agents.get(h.employer);
  if (emp) {
    if (emp.kind === 'firm') {
      emp.workers = emp.workers.filter((x) => x !== h.id);
      if (!quit) emp.firedCum++;
    } else if (emp.kind === 'bank' || emp.kind === 'treasury') emp.employees = emp.employees.filter((x) => x !== h.id);
  }
  const prev = h.employer;
  h.employer = -1;
  h.wage = 0;
  // finding the next job takes a few weeks
  h.searchUntil = eco.day + eco.rng.int(8, 28);
  h.note(eco.day, quit ? `Quit: ${reason}` : `Laid off: ${reason}`, quit ? 'neutral' : 'bad', undefined, prev);
  if (!quit) {
    eco.event('layoff', prev, undefined, h.id);
    eco.monthCounters.layoffs++;
  }
}

// ============================================================================ monthly indices

function sectorAvgPrice(eco: Economy, sector: string, prev: number): number {
  let pu = 0,
    u = 0,
    ps = 0,
    n = 0;
  for (const f of eco.firms) {
    if (f.status !== 'open' || f.sector !== sector) continue;
    pu += f.price * f.last.units;
    u += f.last.units;
    ps += f.price;
    n++;
  }
  if (u > 0) return pu / u;
  if (n > 0) return ps / n;
  return prev;
}

export function monthlyIndices(eco: Economy): void {
  const m = eco.market;
  m.retailPrice = sectorAvgPrice(eco, 'retail', m.retailPrice);
  m.servicePrice = sectorAvgPrice(eco, 'service', m.servicePrice);
  m.factoryPrice = sectorAvgPrice(eco, 'factory', m.factoryPrice);
  m.builderPrice = sectorAvgPrice(eco, 'builder', m.builderPrice);
  m.cpi = SECTORS.retail.demandShare * m.retailPrice + SECTORS.service.demandShare * m.servicePrice;
  m.cpiHistory.push(m.cpi);
  if (m.cpiHistory.length > 1200) m.cpiHistory.shift();
  const infl = m.cpiHistory.length > 12 ? growth(m.cpiHistory, 12) : CFG.inflationTarget;
  m.inflationExpect += 0.06 * (infl - m.inflationExpect) + 0.015 * (CFG.inflationTarget - m.inflationExpect);

  let w = 0,
    n = 0;
  for (const h of eco.households) {
    if (h.departed || !h.employed) continue;
    w += h.wage / h.skill;
    n++;
  }
  if (n > 0) m.wageIndex = w / n;
  m.unemployment = eco.unemploymentRate();

  let totRev = 0,
    totProfit = 0;
  for (const s of ['retail', 'service', 'factory', 'builder'] as const) {
    let dem = 0,
      cap = 0,
      rev = 0,
      profit = 0;
    for (const f of eco.firms) {
      if (f.status !== 'open' || f.sector !== s) continue;
      dem += f.last.units + f.last.unmet;
      cap += Math.max(1, f.capacity);
      rev += f.last.revenue;
      profit += firmProfit(eco, f);
    }
    m.sectorPressure[s] = cap > 0 ? dem / cap : 1;
    m.sectorProfit[s] = rev > 0 ? profit / rev : 0;
    totRev += rev;
    totProfit += profit;
  }
  const hpi12 = growth(m.hpiHistory, 12);
  const conf =
    0.72 -
    3 * (m.unemployment - CFG.naturalUnemployment) -
    2.5 * Math.max(0, infl - 0.04) +
    0.6 * Math.max(-0.2, Math.min(0.2, hpi12)) -
    0.4 * m.panic;
  m.consumerConfidence += 0.25 * (Math.max(0.05, Math.min(1, conf)) - m.consumerConfidence);
  const margin = totRev > 0 ? totProfit / totRev : 0.06;
  m.commercialIndex += 0.1 * (Math.max(0.4, Math.min(1.8, 1 + 4 * (margin - 0.06))) - m.commercialIndex);
}

/** Last month's accounting profit (after depreciation and interest). */
export function firmProfit(eco: Economy, f: Firm): number {
  const dep = ((f.K * CFG.depreciation) / 12) * eco.market.factoryPrice;
  return f.last.revenue - f.last.wages - f.last.inputs - f.last.interest - dep;
}
