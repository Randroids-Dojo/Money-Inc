// Construction: building projects financed by loans, builders' capacity, small repair jobs
// and speculative housing development.

import { CFG, DAYS_PER_MONTH, SECTORS } from './config';
import type { Economy } from './economy';
import { Project, Unit, type Firm, type ProjectKind } from './agents';
import { buyGoods } from './markets';
import { openFirm, monthlyCosts } from './firms';
import { originate, requestWorkingCapital, requestLoan, unitValue, type LoanApp, type LoanOffer } from './banking';
import type { Lot } from '../world/city';
import { listUnit } from './housing';
import { fmtMoney, pct } from './format';
import { OUTSIDE_BUILD_MARKUP, outsideBuildPrice } from './genesis/trade';
import { pickNearLot } from './genesis/plans';

function openBuilders(eco: Economy): Firm[] {
  return eco.firms.filter((f) => f.status === 'open' && f.sector === 'builder');
}

function backlog(eco: Economy, b: Firm): number {
  let s = 0;
  for (const p of eco.projects.values()) if (p.builderId === b.id && (p.status === 'active' || p.status === 'stalled')) s += p.remaining;
  return s;
}

/** Genesis Mode: is this builder's order book short enough to take on `work` more (about eight months)? */
function canTakeOn(b: Firm, work: number): boolean {
  return work / Math.max(1, b.capacity / DAYS_PER_MONTH) <= 240;
}

export function chooseBuilder(eco: Economy, exclude = -1): Firm | undefined {
  const bs = openBuilders(eco).filter((b) => b.id !== exclude);
  if (!bs.length) return undefined;
  return bs.reduce((a, b) => {
    const sa = (backlog(eco, a) + 1) / Math.max(1, a.capacity) * a.price;
    const sb = (backlog(eco, b) + 1) / Math.max(1, b.capacity) * b.price;
    return sb < sa ? b : a;
  });
}

export function startProject(
  eco: Economy,
  kind: ProjectKind,
  lotId: number,
  clientId: number,
  cost: number,
  work: number,
  equipment: number,
  reason: string,
  target: Project['target'],
): Project | null {
  let builder = kind === 'housing' ? eco.firm(clientId) : chooseBuilder(eco);
  // (Genesis Mode: when the town's builders are too small or too booked up to finish in a few months, clients
  // hire crews from across the river)
  if (builder && eco.genesis && kind !== 'housing' && (!canTakeOn(builder, backlog(eco, builder) + work) || builder.price > outsideBuildPrice(eco))) builder = undefined;
  if (!builder) {
    // Genesis Mode: with no builder in town, contractors come from across the river
    if (!eco.genesis || kind === 'housing') return null;
    const p = new Project(eco.newId(), kind, lotId, clientId, eco.world.id, cost, work, equipment, reason, eco.day, target);
    eco.projects.set(p.id, p);
    (p as ProjectWithPrice).unitPrice = outsideBuildPrice(eco);
    eco.event('construction_start', clientId, cost, eco.world.id, reason);
    return p;
  }
  const p = new Project(eco.newId(), kind, lotId, clientId, builder.id, cost, work, equipment, reason, eco.day, target);
  eco.projects.set(p.id, p);
  (p as ProjectWithPrice).unitPrice = kind === 'housing' ? 0 : builder.price;
  eco.event('construction_start', clientId, cost, builder.id, reason);
  return p;
}

interface ProjectWithPrice extends Project {
  unitPrice: number;
}

/** Builders spread their daily capacity over their active projects. */
export function constructionDay(eco: Economy): void {
  // (Genesis Mode: when a local builder cannot keep a job on schedule, crews from across the river make up the rest)
  const before = eco.genesis ? new Map<number, number>() : null;
  if (before) for (const p of eco.projects.values()) if (p.status === 'active' && p.builderId !== eco.world.id) before.set(p.id, p.remaining);
  const byBuilder = new Map<number, Project[]>();
  for (const p of eco.projects.values()) {
    if (p.status !== 'active' && p.status !== 'stalled') continue;
    if (eco.genesis && p.builderId === eco.world.id) {
      outsideWork(eco, p);
      continue;
    }
    const b = eco.firm(p.builderId);
    if (!b || b.status !== 'open') {
      // builder gone: hand the job to someone else
      const nb = p.kind === 'housing' ? undefined : chooseBuilder(eco, p.builderId);
      if (nb) {
        p.builderId = nb.id;
        (p as ProjectWithPrice).unitPrice = nb.price;
      } else if (p.status === 'active') stall(eco, p, 'the builder went out of business');
      continue;
    }
    let arr = byBuilder.get(b.id);
    if (!arr) byBuilder.set(b.id, (arr = []));
    arr.push(p);
  }
  for (const [bid, ps] of byBuilder) {
    const b = eco.firm(bid)!;
    const active = ps.filter((p) => p.status === 'active' || p.stalledDays % 7 === 0);
    if (!active.length) continue;
    const share = b.workToday / active.length;
    for (const p of active) workOn(eco, b, p, share);
  }
  if (before) for (const [pid, rem] of before) topUp(eco, eco.projects.get(pid)!, rem);
  // abandoned-site clean up and stall counters
  for (const p of eco.projects.values()) {
    if (p.status === 'stalled') {
      p.stalledDays++;
      if (p.stalledDays > 300) abandon(eco, p);
    }
  }
}

function workOn(eco: Economy, b: Firm, p: Project, alloc: number): void {
  const client = eco.agents.get(p.clientId);
  if (!client || (client.kind !== 'firm' && client.kind !== 'household')) return;
  if (client.kind === 'firm' && client.status === 'closed') {
    abandon(eco, p);
    return;
  }
  const work = Math.min(p.remaining, alloc);
  if (work <= 0) return;
  const loan = p.loanId >= 0 ? eco.loans.get(p.loanId) : undefined;
  const unitPrice = (p as ProjectWithPrice).unitPrice;
  const sp = SECTORS.builder;
  const eqUnits = p.work > 0 ? (p.equipment * work) / p.work : 0;
  if (p.kind === 'housing') {
    // developer builds with its own crews; it needs cash for materials
    const matCost = work * sp.inputShare * eco.market.factoryPrice;
    if (b.acct.balance < matCost) {
      stall(eco, p, `${b.name} ran out of cash`);
      return;
    }
    const before = b.acct.balance;
    buyGoods(eco, b, work * sp.inputShare, 'supply');
    b.m.inputs += before - b.acct.balance;
    if (loan) loan.spend(b.id, before - b.acct.balance, 'materials');
    eco.monthCounters.housingWork += work * eco.market.builderPrice;
  } else {
    const pay = work * unitPrice;
    const eqCost = eqUnits * eco.market.factoryPrice;
    if (client.acct.balance < pay + eqCost && client.kind === 'firm' && p.status === 'active') {
      // cost overruns: ask the bank for a little more to finish the job
      requestWorkingCapital(eco, client, (pay + eqCost) * 20 - client.acct.balance);
    }
    if (client.acct.balance < pay + eqCost) {
      if (p.progress >= 0.97) {
        // all but finished: the builder hands over the keys and writes off the rest
        completeProject(eco, p);
        return;
      }
      stall(eco, p, `${client.name} could not pay the builder`);
      return;
    }
    const paid = eco.ledger.transfer(client.acct, b.acct, pay, 'invest', p.loanId >= 0 ? p.loanId : undefined);
    p.paid += paid;
    b.m.revenue += paid;
    if (loan) loan.spend(b.id, paid, 'construction work');
    if (client.kind === 'firm') client.m.investment += paid;
    eco.monthCounters.investment += paid;
    // builder buys materials
    const before = b.acct.balance;
    buyGoods(eco, b, work * sp.inputShare, 'supply');
    b.m.inputs += before - b.acct.balance;
    // equipment for the client, from factories
    if (eqUnits > 0) {
      const cb = client.acct.balance;
      const got = buyGoods(eco, client as Firm, eqUnits, 'invest', p.loanId >= 0 ? p.loanId : undefined);
      const spent = cb - client.acct.balance;
      p.equipmentDelivered += got;
      p.paid += spent;
      eco.monthCounters.investment += spent;
      if (client.kind === 'firm') client.m.investment += spent;
    }
  }
  b.m.units += work;
  b.workToday -= work;
  eco.monthCounters.constructionWork += work;
  p.remaining -= work;
  p.progress = p.work > 0 ? 1 - p.remaining / p.work : 1;
  if (p.status === 'stalled') {
    p.status = 'active';
    p.stallReason = '';
    p.stalledDays = 0;
  }
  if (p.remaining <= 0.5) completeProject(eco, p);
}

/**
 * Genesis Mode: when a local builder's crew cannot keep a job on a normal schedule (a house in
 * about four months, a business's premises in five), whoever pays for the work hires crews from
 * across the river for the rest, at their higher price. As local builders grow, they need less help.
 */
function topUp(eco: Economy, p: Project, remainingBefore: number): void {
  if (!p || p.status !== 'active' || p.remaining <= 0.5) return;
  const payer = eco.firm(p.clientId) ?? eco.household(p.clientId);
  if (!payer || (payer.kind === 'firm' && payer.status === 'closed')) return;
  const days = p.target.kind === 'apartment' ? 240 : p.kind === 'housing' || p.kind === 'homes' ? 115 : 150;
  const pace = p.work / days;
  const need = Math.min(p.remaining, pace - (remainingBefore - p.remaining));
  if (need <= 0.5) return;
  const price = outsideBuildPrice(eco);
  // (a firm keeps enough back to pay its staff and the interest on its loans for a while)
  const keep = payer.kind === 'firm' ? payer.last.wages + payer.debtService() * 6 : 0;
  const work = Math.min(need, Math.max(0, payer.acct.balance - keep) / price);
  if (work <= 0.5) return;
  const paid = eco.ledger.toOutside(payer.acct, work * price, 'import', eco.world.id);
  if (paid <= 0) return;
  if (p.loanId >= 0) eco.loans.get(p.loanId)?.spend(eco.world.id, paid, 'crews from across the river');
  if (payer.kind === 'firm') {
    if (p.kind === 'housing') payer.m.inputs += paid;
    else payer.m.investment += paid;
  }
  if (p.kind !== 'housing') p.paid += paid;
  eco.genesis!.trade.outsideBuild += paid;
  eco.monthCounters.constructionWork += paid / price;
  p.remaining -= paid / price;
  p.progress = p.work > 0 ? 1 - p.remaining / p.work : 1;
  if (p.remaining <= 0.5) completeProject(eco, p);
}

/** Genesis Mode: outside contractors work through a job at their own pace, paid from the client's account. */
function outsideWork(eco: Economy, p: Project): void {
  const client = eco.agents.get(p.clientId);
  if (!client || (client.kind !== 'firm' && client.kind !== 'household')) return;
  if (client.kind === 'firm' && client.status === 'closed') {
    abandon(eco, p);
    return;
  }
  if (p.status === 'stalled' && p.stalledDays % 7 !== 0) return;
  const days = 35 + Math.min(80, p.work / 2500);
  const work = Math.min(p.remaining, p.work / days);
  if (work <= 0) return;
  const unitPrice = (p as ProjectWithPrice).unitPrice;
  const pay = work * unitPrice;
  const eqUnits = p.work > 0 ? (p.equipment * work) / p.work : 0;
  const eqCost = eqUnits * eco.market.factoryPrice * 1.1;
  if (client.acct.balance < pay + eqCost && client.kind === 'firm' && p.status === 'active') {
    requestWorkingCapital(eco, client, (pay + eqCost) * 20 - client.acct.balance);
  }
  if (client.acct.balance < pay + eqCost) {
    if (p.progress >= 0.97) {
      completeProject(eco, p);
      return;
    }
    stall(eco, p, `${client.name} could not pay the contractors`);
    return;
  }
  const loanId = p.loanId >= 0 ? p.loanId : undefined;
  const paid = eco.ledger.toOutside(client.acct, pay, 'import', eco.world.id);
  p.paid += paid;
  if (loanId !== undefined) eco.loans.get(loanId)?.spend(eco.world.id, paid, 'contractors from across the river');
  if (client.kind === 'firm') client.m.investment += paid;
  if (eco.genesis) eco.genesis.trade.outsideBuild += paid;
  if (eqUnits > 0) {
    const cb = client.acct.balance;
    const got = buyGoods(eco, client as Firm, eqUnits, 'invest', loanId);
    const spent = cb - client.acct.balance;
    p.equipmentDelivered += got;
    p.paid += spent;
    if (client.kind === 'firm') client.m.investment += spent;
  }
  p.remaining -= work;
  p.progress = p.work > 0 ? 1 - p.remaining / p.work : 1;
  if (p.status === 'stalled') {
    p.status = 'active';
    p.stallReason = '';
    p.stalledDays = 0;
  }
  if (p.remaining <= 0.5) completeProject(eco, p);
}

function stall(eco: Economy, p: Project, reason: string): void {
  if (p.status === 'stalled') return;
  p.status = 'stalled';
  p.stallReason = reason;
  eco.event('construction_stalled', p.clientId, undefined, p.builderId, reason);
  if (p.cost > 100_000) eco.headline(`Construction halted on ${eco.nameOf(p.clientId)}'s project: ${reason}`, 'bad', p.clientId, p.lotId, `stall-${p.id}`, 90);
}

function abandon(eco: Economy, p: Project): void {
  if (p.status === 'abandoned' || p.status === 'complete') return;
  p.status = 'abandoned';
  p.finished = eco.day;
  const f = eco.firm(p.clientId);
  if (f && f.project === p.id) f.project = -1;
  // a half-built startup never opens
  if (f && f.status === 'planned' && (p.kind === 'startup' || p.kind === 'refit')) {
    f.status = 'closed';
    f.closedDay = eco.day;
    f.note(eco.day, `Never opened: construction was abandoned`, 'bad');
  }
  if (p.kind === 'housing' || p.kind === 'homes') {
    // unfinished homes stay as a derelict site until someone takes the lot
    const use = eco.lotUse.get(p.lotId);
    if (use && use.type === 'project' && use.id === p.id) eco.lotUse.delete(p.lotId);
    for (const u of eco.units) if (u.lotId === p.lotId && u.building) u.building = false;
  }
}

function completeProject(eco: Economy, p: Project): void {
  p.status = 'complete';
  p.progress = 1;
  p.remaining = 0;
  p.finished = eco.day;
  const loan = p.loanId >= 0 ? eco.loans.get(p.loanId) : undefined;
  eco.event('construction_done', p.clientId, p.cost, p.builderId);
  if (p.kind === 'expansion' || p.kind === 'startup' || p.kind === 'refit') {
    const f = eco.firm(p.clientId);
    if (!f) return;
    const before = f.capacity;
    f.K += p.work + p.equipmentDelivered;
    f.project = -1;
    if (p.kind === 'expansion') {
      const grow = f.capitalCap / Math.max(1, before) - 1;
      f.note(eco.day, `Finished expanding: capital capacity up ${pct(Math.max(0, grow), 0)}`, 'good', p.cost);
      if (loan) loan.note(eco.day, `Project finished: ${f.name}'s capacity rose ${pct(Math.max(0, grow), 0)}`, undefined, f.id, 'good');
      eco.headline(`${f.name} completes its expansion`, 'good', f.id, undefined, `done-${f.id}`, 90);
    } else {
      openFirm(eco, f);
      if (loan) loan.note(eco.day, `${f.name} opened its doors`, undefined, f.id, 'good');
    }
  } else if (p.kind === 'homes') {
    // company housing: the client keeps the homes and lets them
    const units = eco.lotUnits.get(p.lotId) ?? [];
    for (const uid of units) {
      const u = eco.units[uid];
      u.building = false;
      u.rent = u.baseRent * u.quality * eco.market.rentIndex;
    }
    eco.lotUse.set(p.lotId, { type: 'res', id: p.lotId });
    if (loan && units.length) {
      // the loan is now secured on the finished home
      loan.collateral = { kind: 'property', ref: units[0], value: unitValue(eco, units[0]) };
      loan.note(eco.day, `The ${units.length > 1 ? 'homes are' : 'home is'} finished and ready to let`, undefined, p.clientId, 'good');
    }
    eco.headline(`${eco.nameOf(p.clientId)} finishes a cottage to house its workers`, 'good', p.clientId, p.lotId, `cdone-${p.lotId}`, 0);
  } else if (p.kind === 'housing') {
    const units = eco.lotUnits.get(p.lotId) ?? [];
    for (const uid of units) {
      const u = eco.units[uid];
      u.building = false;
      listUnit(eco, u, p.clientId, unitAsk(eco, u), false);
    }
    eco.lotUse.set(p.lotId, { type: 'res', id: p.lotId });
    if (loan) loan.note(eco.day, `${units.length} new home${units.length > 1 ? 's' : ''} finished and listed for sale`, undefined, p.clientId, 'good');
    eco.headline(`${units.length > 1 ? `${units.length} new apartments` : 'A new house'} completed by ${eco.nameOf(p.clientId)}`, 'good', p.clientId, p.lotId, `hdone-${p.lotId}`, 0);
  }
  eco.genesis?.onProjectComplete(p);
}

function unitAsk(eco: Economy, u: Unit): number {
  return u.baseValue * u.quality * eco.market.hpi * (1.02 + Math.max(0, eco.market.hpiExpect) * 0.3);
}

/**
 * Small repair / renovation jobs bought on the spot (maintenance of buildings, home
 * renovations). Uses builders' spare capacity; returns the $ spent.
 */
export function smallJob(eco: Economy, buyer: { acct: Firm['acct']; id: number }, dollars: number): number {
  if (dollars <= 1) return 0;
  const bs = openBuilders(eco);
  if (!bs.length) {
    if (!eco.genesis) return 0;
    // Genesis Mode: repairs are done by contractors from across the river
    const paid = eco.ledger.toOutside(buyer.acct, dollars * OUTSIDE_BUILD_MARKUP, 'import', eco.world.id);
    eco.genesis.trade.outsideBuild += paid;
    return paid / OUTSIDE_BUILD_MARKUP;
  }
  let left = dollars;
  for (const b of eco.rng.shuffle(bs.slice())) {
    if (left <= 1) break;
    const spare = Math.max(0, b.capacity * 1.05 - b.m.units);
    const work = Math.min(left / b.price, spare);
    if (work <= 0) {
      b.m.unmet += left / b.price;
      continue;
    }
    const paid = eco.ledger.transfer(buyer.acct, b.acct, work * b.price, 'invest');
    b.m.units += paid / b.price;
    b.m.revenue += paid;
    const before = b.acct.balance;
    buyGoods(eco, b, (paid / b.price) * SECTORS.builder.inputShare, 'supply');
    b.m.inputs += before - b.acct.balance;
    left -= paid;
    eco.monthCounters.investment += paid;
  }
  return dollars - left;
}

// ============================================================================ housing development


export function developmentMonthly(eco: Economy): void {
  const mk = eco.market;
  // Genesis Mode: when businesses are hiring and there is nowhere for newcomers to live, builders
  // will build on thinner margins and with less of their own money
  const shortage = !!eco.genesis?.housingShortage;
  for (const b of openBuilders(eco)) {
    let active = 0;
    for (const p of eco.projects.values()) if (p.clientId === b.id && p.kind === 'housing' && (p.status === 'active' || p.status === 'stalled')) active++;
    // (Genesis Mode: a builder with a crew of one or two takes on one home at a time)
    if (active >= (eco.genesis && b.workers.length <= 2 ? 1 : 2) || (shortage ? b.health === 'distressed' : b.health !== 'healthy')) continue;
    if (eco.genesis?.hasPendingLoan(b.id)) continue;
    // unsold stock discourages new starts
    let unsold = 0;
    for (const u of eco.units) if (u.ownerId === b.id && u.occupantId < 0) unsold++;
    if (unsold >= 3) continue;
    if (!eco.rng.chance(shortage ? 0.9 : 0.45)) continue;
    let lots = eco.city.lots.filter((l) => l.zone === 'res' && !eco.lotUse.has(l.id));
    // (a young Genesis town builds houses before it builds apartment blocks)
    if (eco.genesis && eco.population() < 25) {
      const houses = lots.filter((l) => l.w === 1);
      if (houses.length) lots = houses;
    }
    if (!lots.length) continue;
    // (Genesis Mode: new homes go up next to the existing town)
    const lot = eco.genesis ? pickNearLot(eco, lots)! : eco.rng.pick(lots);
    const isApt = lot.w >= 2;
    const nUnits = isApt ? eco.rng.int(4, 8) : 1;
    // (Genesis Mode: the first homes of a new town are small cottages)
    const cottage = !isApt && !!eco.genesis && eco.population() < 20 ? 0.7 : 1;
    const base = isApt ? CFG.aptUnitBaseValue : CFG.houseBaseValue * cottage;
    const quality = 1.05 + 0.15 * eco.rng.next();
    const buildMonths = isApt ? 9 : 4;
    const saleValue = nUnits * base * quality * mk.hpi * (1 + Math.max(-0.1, Math.min(0.15, mk.hpiExpect)) * (buildMonths / 12));
    const workReal = nUnits * base * CFG.devCostRatio;
    // (Genesis Mode: a small builder will need outside crews for part of the job, at their higher price)
    const cost = workReal * mk.builderPrice * (eco.genesis && b.capacity * (buildMonths + 1) < workReal ? 1.08 : 1);
    const margin = saleValue / cost - 1;
    if (margin < (shortage ? 0.04 : CFG.devMargin)) continue;
    const costs = monthlyCosts(eco, b);
    // the developer's own cash plus what its owner is willing to put in
    const owner = eco.household(b.ownerId);
    const ownerCash = owner ? Math.max(0, owner.acct.balance - CFG.essentials * eco.market.cpi * 4) * 0.5 : 0;
    const firmCash = Math.max(0, b.acct.balance - costs * 1.5);
    const equity = Math.min(cost * 0.3, firmCash + ownerCash);
    if (equity < cost * (shortage ? 0.02 : eco.genesis ? 0.08 : 0.12)) continue;
    const fromOwner = Math.max(0, equity - firmCash);
    if (owner && fromOwner > 0) {
      eco.ledger.transfer(owner.acct, b.acct, fromOwner, 'capital');
      b.ownerEquity += fromOwner;
      owner.note(eco.day, `Put ${fmtMoney(fromOwner)} into ${b.name}'s new housing development`, 'neutral', fromOwner, b.id);
    }
    const borrow = cost - equity;
    const pid = eco.newId();
    const app: LoanApp = {
      borrower: b,
      kind: 'development',
      purpose: 'development',
      amount: Math.round(borrow / 1000) * 1000,
      // (Genesis Mode: in a thin market it can take a while to find buyers; the homes are let meanwhile)
      termMonths: buildMonths + (eco.genesis ? 36 : 12),
      amortizing: false,
      collateral: { kind: 'project', ref: pid, value: nUnits * base * quality },
      income: b.last.revenue - b.last.wages - b.last.inputs,
      existingDebtService: b.debtService(),
      existingDebt: b.debt(),
      what: `building ${nUnits > 1 ? `${nUnits} apartments` : 'a house'} to sell`,
    };
    requestLoan(eco, app, { review: 'development', context: { lotId: lot.id, units: nUnits, saleValue } }, (d, fin) => {
      if (!d.offer) {
        b.note(eco.day, `Development loan refused: ${d.reason}`, 'bad');
        return;
      }
      // (in Genesis Mode the decision may come later: the lot must still be free)
      if (eco.lotUse.has(lot.id) || b.status !== 'open') return;
      startDevelopment(eco, b, d.offer, fin, lot, pid, nUnits, isApt, base, quality, cost, workReal, margin, cottage);
    });
  }
}

function startDevelopment(
  eco: Economy,
  b: Firm,
  offer: LoanOffer,
  app: LoanApp,
  lot: Lot,
  pid: number,
  nUnits: number,
  isApt: boolean,
  base: number,
  quality: number,
  cost: number,
  workReal: number,
  margin: number,
  rentScale = 1,
): void {
  const loan = originate(eco, offer, app);
  const reason = `house prices (${eco.market.hpi.toFixed(2)}x base) are ${pct(margin, 0)} above the cost of building`;
  const p = new Project(pid, 'housing', lot.id, b.id, b.id, cost, workReal, 0, reason, eco.day, { kind: isApt ? 'apartment' : 'house', level: isApt ? Math.min(4, Math.ceil(nUnits / 3)) : 1, units: nUnits });
  (p as ProjectWithPrice).unitPrice = 0;
  p.loanId = loan.id;
  eco.projects.set(p.id, p);
  eco.lotUse.set(lot.id, { type: 'project', id: p.id });
  // create the units now (under construction)
  const ids: number[] = [];
  for (let i = 0; i < nUnits; i++) {
    const u = new Unit(eco.units.length, lot.id, quality * (0.95 + 0.1 * eco.rng.next()), base, isApt ? CFG.aptBaseRent : CFG.houseBaseRent * rentScale);
    u.ownerId = b.id;
    u.building = true;
    eco.units.push(u);
    ids.push(u.id);
  }
  eco.lotUnits.set(lot.id, ids);
  b.note(eco.day, `Started building ${nUnits > 1 ? `${nUnits} apartments` : 'a house'} with a ${fmtMoney(app.amount)} loan from ${offer.bank.name}`, 'good', app.amount, offer.bank.id);
  eco.event('construction_start', b.id, cost, b.id, reason);
  if (eco.rng.chance(0.5)) eco.headline(`${offer.bank.name} finances ${nUnits > 1 ? `a ${nUnits}-unit apartment block` : 'a new house'} by ${b.name}`, 'neutral', b.id, lot.id, `dev-${b.id}`, 60);
}

/**
 * Genesis Mode: an employer that cannot hire because newcomers have nowhere to live has a home
 * built on a lot near town and lets it (company housing). A local builder does the work if it
 * has room in its schedule; otherwise crews come from across the river.
 */
export function startCompanyHomes(
  eco: Economy,
  f: Firm,
  lot: Lot,
  pid: number,
  cost: number,
  workReal: number,
  base: number,
  quality: number,
  rentScale: number,
  loanId: number,
  reason: string,
): Project {
  let builder = chooseBuilder(eco);
  if (builder && (!canTakeOn(builder, backlog(eco, builder) + workReal) || builder.price > outsideBuildPrice(eco))) builder = undefined;
  const p = new Project(pid, 'homes', lot.id, f.id, builder ? builder.id : eco.world.id, cost, workReal, 0, reason, eco.day, { kind: 'house', level: 1, units: 1 });
  (p as ProjectWithPrice).unitPrice = builder ? builder.price : outsideBuildPrice(eco);
  p.loanId = loanId;
  eco.projects.set(p.id, p);
  eco.lotUse.set(lot.id, { type: 'project', id: p.id });
  const u = new Unit(eco.units.length, lot.id, quality, base, CFG.houseBaseRent * rentScale);
  u.ownerId = f.id;
  u.building = true;
  eco.units.push(u);
  eco.lotUnits.set(lot.id, [u.id]);
  f.note(eco.day, `Started building a cottage for its workers${loanId >= 0 ? ` with a ${fmtMoney(eco.loans.get(loanId)?.principal0 ?? 0)} loan` : ''}`, 'good', cost);
  eco.event('construction_start', f.id, cost, p.builderId, reason);
  return p;
}

export const DEV_DAYS = DAYS_PER_MONTH;
