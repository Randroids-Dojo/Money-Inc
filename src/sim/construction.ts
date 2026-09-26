// Construction: building projects financed by loans, builders' capacity, small repair jobs
// and speculative housing development.

import { CFG, DAYS_PER_MONTH, SECTORS } from './config';
import type { Economy } from './economy';
import { Project, Unit, type Firm, type ProjectKind } from './agents';
import { buyGoods } from './markets';
import { openFirm, monthlyCosts } from './firms';
import { originate, shopForLoan, type LoanApp } from './banking';
import { listUnit } from './housing';
import { fmtMoney, pct } from './format';

function openBuilders(eco: Economy): Firm[] {
  return eco.firms.filter((f) => f.status === 'open' && f.sector === 'builder');
}

function backlog(eco: Economy, b: Firm): number {
  let s = 0;
  for (const p of eco.projects.values()) if (p.builderId === b.id && (p.status === 'active' || p.status === 'stalled')) s += p.remaining;
  return s;
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
  const builder = kind === 'housing' ? eco.firm(clientId) : chooseBuilder(eco);
  if (!builder) return null;
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
  const byBuilder = new Map<number, Project[]>();
  for (const p of eco.projects.values()) {
    if (p.status !== 'active' && p.status !== 'stalled') continue;
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
    if (client.acct.balance < pay + eqCost) {
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
      if (loan && spent > 0) loan.spend(-1, spent, 'equipment from local factories');
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
  if (p.kind === 'housing') {
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
  if (!bs.length) return 0;
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
  for (const b of openBuilders(eco)) {
    let active = 0;
    for (const p of eco.projects.values()) if (p.clientId === b.id && p.kind === 'housing' && (p.status === 'active' || p.status === 'stalled')) active++;
    if (active >= 2 || b.health !== 'healthy') continue;
    // unsold stock discourages new starts
    let unsold = 0;
    for (const u of eco.units) if (u.ownerId === b.id) unsold++;
    if (unsold >= 3) continue;
    if (!eco.rng.chance(0.45)) continue;
    const lots = eco.city.lots.filter((l) => l.zone === 'res' && !eco.lotUse.has(l.id));
    if (!lots.length) continue;
    const lot = eco.rng.pick(lots);
    const isApt = lot.w >= 2;
    const nUnits = isApt ? eco.rng.int(4, 8) : 1;
    const base = isApt ? CFG.aptUnitBaseValue : CFG.houseBaseValue;
    const quality = 1.05 + 0.15 * eco.rng.next();
    const buildMonths = isApt ? 9 : 4;
    const saleValue = nUnits * base * quality * mk.hpi * (1 + Math.max(-0.1, Math.min(0.15, mk.hpiExpect)) * (buildMonths / 12));
    const workReal = nUnits * base * CFG.devCostRatio;
    const cost = workReal * mk.builderPrice;
    const margin = saleValue / cost - 1;
    if (margin < CFG.devMargin) continue;
    const costs = monthlyCosts(eco, b);
    // the developer's own cash plus what its owner is willing to put in
    const owner = eco.household(b.ownerId);
    const ownerCash = owner ? Math.max(0, owner.acct.balance - CFG.essentials * eco.market.cpi * 4) * 0.5 : 0;
    const firmCash = Math.max(0, b.acct.balance - costs * 1.5);
    const equity = Math.min(cost * 0.3, firmCash + ownerCash);
    if (equity < cost * 0.12) continue;
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
      termMonths: buildMonths + 12,
      amortizing: false,
      collateral: { kind: 'project', ref: pid, value: nUnits * base * quality },
      income: b.last.revenue - b.last.wages - b.last.inputs,
      existingDebtService: b.debtService(),
      existingDebt: b.debt(),
      what: `building ${nUnits > 1 ? `${nUnits} apartments` : 'a house'} to sell`,
    };
    const d = shopForLoan(eco, app);
    if (!d.offer) {
      b.note(eco.day, `Development loan refused: ${d.reason}`, 'bad');
      continue;
    }
    const loan = originate(eco, d.offer, app);
    const reason = `house prices (${mk.hpi.toFixed(2)}x base) are ${pct(margin, 0)} above the cost of building`;
    const p = new Project(pid, 'housing', lot.id, b.id, b.id, cost, workReal, 0, reason, eco.day, { kind: isApt ? 'apartment' : 'house', level: isApt ? Math.min(4, Math.ceil(nUnits / 3)) : 1, units: nUnits });
    (p as ProjectWithPrice).unitPrice = 0;
    p.loanId = loan.id;
    eco.projects.set(p.id, p);
    eco.lotUse.set(lot.id, { type: 'project', id: p.id });
    // create the units now (under construction)
    const ids: number[] = [];
    for (let i = 0; i < nUnits; i++) {
      const u = new Unit(eco.units.length, lot.id, quality * (0.95 + 0.1 * eco.rng.next()), base, isApt ? CFG.aptBaseRent : CFG.houseBaseRent);
      u.ownerId = b.id;
      u.building = true;
      eco.units.push(u);
      ids.push(u.id);
    }
    eco.lotUnits.set(lot.id, ids);
    b.note(eco.day, `Started building ${nUnits > 1 ? `${nUnits} apartments` : 'a house'} with a ${fmtMoney(app.amount)} loan from ${d.offer.bank.name}`, 'good', app.amount, d.offer.bank.id);
    eco.event('construction_start', b.id, cost, b.id, reason);
    if (eco.rng.chance(0.5)) eco.headline(`${d.offer.bank.name} finances ${nUnits > 1 ? `a ${nUnits}-unit apartment block` : 'a new house'} by ${b.name}`, 'neutral', b.id, lot.id, `dev-${b.id}`, 60);
  }
}

export const DEV_DAYS = DAYS_PER_MONTH;
