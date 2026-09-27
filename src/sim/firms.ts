// Firms: production, payroll, pricing, hiring and firing, investment (borrowing to expand),
// maintenance, dividends, distress, closure and new-business entry.

import { CFG, DAYS_PER_MONTH, SECTORS } from './config';
import type { Economy } from './economy';
import { Firm, newFirmMonth, type Household } from './agents';
import type { Sector } from './types';
import { buyGoods, firmProfit, fire } from './markets';
import { originate, requestWorkingCapital, requestLoan, shopForLoan, defaultLoan, invalidateMetrics, releaseFromBank, type LoanApp } from './banking';
import { smallJob, startProject } from './construction';
import { fmtMoney, pct } from './format';
import { firmName } from './names';
import { priceCeiling, regionWage } from './genesis/trade';

// ============================================================================ daily

export function startOfDay(eco: Economy): void {
  for (const f of eco.firms) {
    if (f.status !== 'open') continue;
    const cap = f.capacity / DAYS_PER_MONTH;
    switch (f.sector) {
      case 'retail':
        f.capToday = cap * 1.15;
        break;
      case 'service':
        f.capToday = cap * 1.15;
        break;
      case 'factory': {
        // steady production: expected orders plus a slow correction toward ~3 weeks of stock
        const target = f.expDemand * 0.7;
        const produce = Math.min(cap, Math.max(0, f.expDemand / DAYS_PER_MONTH + (target - f.inventory) / 20));
        f.inventory += produce;
        break;
      }
      case 'builder':
        f.workToday = cap;
        break;
    }
  }
}

/** Retailers restock from factories to keep ~2 weeks of expected sales on the shelves. */
export function restockDay(eco: Economy): void {
  const share = SECTORS.retail.inputShare;
  for (const f of eco.firms) {
    if (f.status !== 'open' || f.sector !== 'retail') continue;
    const target = Math.max(f.expDemand, f.capacity * 0.5) * 0.5;
    const need = target - f.inventory;
    if (need <= 0) continue;
    const before = f.acct.balance;
    const units = buyGoods(eco, f, (need / 4 + f.expDemand / DAYS_PER_MONTH * 0.2) * share, 'supply');
    f.inventory += units / share;
    f.m.inputs += before - f.acct.balance;
  }
}

export function payWages(eco: Economy, dom: number): void {
  for (const f of eco.firms) {
    if (f.payday !== dom || f.status === 'closed' || !f.workers.length) continue;
    let payroll = 0;
    for (const hid of f.workers) payroll += eco.household(hid)?.wage ?? 0;
    if (f.acct.balance < payroll) {
      requestWorkingCapital(eco, f, (payroll - f.acct.balance) * 1.5 + payroll * 0.5);
    }
    if (f.acct.balance < payroll) {
      // cannot make payroll: shed workers until it can
      const ws = f.workers.slice().reverse();
      for (const hid of ws) {
        if (payroll <= f.acct.balance || f.workers.length <= 0) break;
        const h = eco.household(hid);
        if (!h) continue;
        payroll -= h.wage;
        fire(eco, h, `${f.name} could not make payroll`);
      }
      if (f.workers.length === 0) {
        f.health = 'distressed';
        f.note(eco.day, `Could not pay any wages`, 'bad');
      } else {
        f.note(eco.day, `Laid off staff: cash ran short on payday`, 'bad');
      }
      f.health = 'distressed';
    }
    for (const hid of f.workers) {
      const h = eco.household(hid);
      if (!h) continue;
      paySalary(eco, f, h);
    }
  }
}

function paySalary(eco: Economy, f: Firm, h: Household): void {
  const gross = h.wage;
  const tax = gross * CFG.taxRate;
  const net = gross - tax;
  const paidNet = eco.ledger.transfer(f.acct, h.acct, net, 'wage');
  const paidTax = eco.ledger.payPublic(f.acct, 'treasury', tax, 'tax');
  eco.treasury.taxesMonth += paidTax;
  h.incomeThisMonth += paidNet;
  h.wagesThisMonth += paidNet + paidTax;
  f.m.wages += paidNet + paidTax;
  eco.genesis?.onWage(f, h, paidNet + paidTax);
}

// ============================================================================ monthly review

export function reviews(eco: Economy, dom: number): void {
  for (const f of eco.firms) {
    if (f.reviewDay !== dom || f.status !== 'open') continue;
    if (eco.day - f.lastReview < 20) continue;
    reviewFirm(eco, f);
  }
}

export function monthlyCosts(eco: Economy, f: Firm): number {
  return f.last.wages + f.last.inputs + f.debtService() + (f.K * CFG.depreciation * eco.market.factoryPrice) / 12;
}

function reviewFirm(eco: Economy, f: Firm): void {
  const sp = SECTORS[f.sector];
  const mk = eco.market;
  // ---- close the month (normalised to 30 days)
  const span = Math.max(1, eco.day - f.lastReview);
  f.lastReview = eco.day;
  const k = DAYS_PER_MONTH / span;
  const mm = f.m;
  mm.units *= k;
  mm.revenue *= k;
  mm.unmet *= k;
  mm.wages *= k;
  mm.inputs *= k;
  mm.interest *= k;
  mm.maintenance *= k;
  mm.investment *= k;
  mm.dividends *= k;
  f.last = f.m;
  f.months.push(f.m);
  if (f.months.length > 24) f.months.shift();
  f.m = newFirmMonth();
  const demand = f.last.units + f.last.unmet;
  f.expDemand = f.expDemand <= 0 ? demand : 0.7 * f.expDemand + 0.3 * demand;
  const cap = Math.max(1, f.capacity);
  const u = demand / cap;

  // ---- pricing: demand pressure, expected inflation and cost pass-through
  const pressure = Math.max(-CFG.maxPriceStep, Math.min(CFG.maxPriceStep, CFG.priceAdjust * (u - CFG.targetUtilization)));
  // unit cost at normal volume: fixed costs spread over normal output plus materials
  const normal = cap * CFG.targetUtilization;
  const dep = (f.K * CFG.depreciation * mk.factoryPrice) / 12;
  const wageBill = f.workers.reduce((s, id) => s + (eco.household(id)?.wage ?? 0), 0);
  const unitInput = f.sector === 'retail' || f.sector === 'builder' ? sp.inputShare * mk.factoryPrice : 0;
  const unitCost = (wageBill + f.last.interest + dep) / Math.max(1, normal) + unitInput;
  const target = unitCost * (1 + sp.markup);
  const pull = Math.max(-0.03, Math.min(0.03, CFG.costPull * (target / f.price - 1)));
  const drift = mk.inflationExpect / 12;
  f.price *= 1 + drift + pressure + pull;
  f.price = Math.max(0.05, f.price);
  // (Genesis Mode: a small town's businesses compete with the whole region: they cannot charge more)
  if (eco.genesis) f.price = Math.min(f.price, priceCeiling(eco, f.sector));
  f.discounting = pressure + pull < -0.004;

  // ---- productivity creeps up; wages share in it
  f.A *= 1 + CFG.productivityGrowth / 12;
  // ---- wages
  let gw = mk.inflationExpect + CFG.productivityGrowth + CFG.wageAdjust * (CFG.naturalUnemployment - mk.unemployment);
  if (f.hotMonths > 0 && f.vacancies > 0) gw += 0.015;
  // (Genesis Mode: people can move between the town and the region, so local wages cannot drift far from the region's)
  if (eco.genesis) gw += Math.max(-0.08, Math.min(0.08, 0.35 * Math.log(regionWage(eco) / Math.max(1, f.wage))));
  if (f.health === 'distressed') gw = Math.min(gw, mk.unemployment > 0.1 ? -0.06 : 0);
  gw = Math.max(-0.06, Math.min(0.2, gw));
  f.wage *= 1 + gw / 12;
  for (const hid of f.workers) {
    const h = eco.household(hid);
    if (h) h.wage = f.wage * h.skill;
  }

  // ---- employment
  const capCap = f.capitalCap;
  let targetOut: number;
  if (f.sector === 'builder') targetOut = Math.min(capCap, builderDemand(eco, f));
  else targetOut = Math.min(capCap, f.expDemand / CFG.targetUtilization);
  // staff for expected demand with the usual slack for busy days
  const targetWorkers = Math.max(1, Math.round(targetOut / f.A + 0.2));
  const n = f.workers.length;
  if (targetWorkers > n) {
    // hiring is gradual
    f.vacancies = Math.min(targetWorkers - n, Math.max(1, Math.ceil(n * 0.3)));
  } else {
    f.vacancies = 0;
    const excess = n - targetWorkers;
    // firms hoard labour through small dips; they cut when demand clearly falls away
    if (excess >= Math.max(2, n * 0.2) || (excess >= 1 && u < 0.5)) {
      const cut = Math.max(1, Math.round(excess * 0.3));
      const victims = f.workers.slice(-cut);
      for (const hid of victims) {
        const h = eco.household(hid);
        if (h) fire(eco, h, `${f.name} cut staff: sales too weak`);
      }
      f.note(eco.day, `Laid off ${victims.length} worker${victims.length > 1 ? 's' : ''} (demand ${pct(u, 0)} of capacity)`, 'bad');
    }
  }
  f.hotMonths = demand > 0.9 * capCap ? f.hotMonths + 1 : 0;

  // ---- depreciation and maintenance
  const decay = (f.K * CFG.depreciation) / 12;
  f.K -= decay;
  const costs = monthlyCosts(eco, f);
  if (f.acct.balance > costs * 0.5 && f.health !== 'distressed') {
    const before = f.acct.balance;
    const eq = buyGoods(eco, f, decay * 0.5, 'invest');
    const st = smallJob(eco, f, decay * 0.5 * mk.builderPrice);
    f.K += eq + st / Math.max(0.2, mk.builderPrice);
    f.m.maintenance += before - f.acct.balance;
  }

  // ---- investment
  if (f.project < 0 && f.hotMonths >= 2 && f.health === 'healthy' && eco.rng.chance(0.6)) planExpansion(eco, f);

  // ---- health
  const profit = firmProfit(eco, f);
  f.lossMonths = profit < 0 ? f.lossMonths + 1 : 0;
  const cash = f.acct.balance;
  if (f.missed > 0 || (cash < costs * 0.3 && f.lossMonths >= 2)) f.health = 'distressed';
  else if (f.lossMonths >= 2 || cash < costs * 0.6) f.health = 'strained';
  else f.health = 'healthy';
  // repay working capital when flush
  for (const l of f.loans) {
    if (!l.active || l.purpose !== 'working_capital') continue;
    if (f.acct.balance > costs * (CFG.cashBufferMonths + 1) + l.balance) {
      const bank = eco.bank(l.servicerId);
      if (bank && l.holder.kind === 'bank') {
        const paid = eco.ledger.payBank(f.acct, bank, l.balance, 'principal', l.id);
        l.balance -= paid;
        l.principalPaid += paid;
        bank.destroyedCum += paid;
        invalidateMetrics(bank);
        if (l.balance < 1) {
          l.balance = 0;
          l.status = 'repaid';
          l.closedDay = eco.day;
          l.note(eco.day, `Credit line paid off early`, paid, bank.id, 'good');
          releaseFromBank(eco, l);
        }
      }
    }
  }
  f.loans = f.loans.filter((l) => l.active);

  // ---- dividends to the owner
  const buffer = costs * CFG.cashBufferMonths;
  const reserved = f.project >= 0 ? projectReserve(eco, f) : 0;
  const excess = f.acct.balance - buffer - reserved;
  if (excess > 0 && profit > 0 && f.health === 'healthy') {
    const owner = eco.household(f.ownerId);
    if (owner && !owner.departed) {
      const hoard = Math.max(0, excess - buffer * 2);
      const div = Math.min(excess, Math.min(excess * CFG.payoutShare, Math.max(profit, excess * 0.2)) + hoard * 0.5);
      // dividend tax is withheld at source
      const tax = eco.ledger.payPublic(f.acct, 'treasury', div * CFG.dividendTax, 'tax');
      eco.treasury.taxesMonth += tax;
      f.m.taxes += tax;
      const paid = eco.ledger.transfer(f.acct, owner.acct, div - tax, 'dividend');
      owner.incomeThisMonth += paid;
      f.m.dividends += paid + tax;
    }
  }

  // ---- give up?
  const debt = f.debt();
  if ((f.lossMonths >= 9 && debt <= 0 && f.acct.balance < costs * 2) || (f.workers.length === 0 && demand < cap * 0.05 && f.lossMonths >= 3)) {
    closeFirm(eco, f, 'kept losing money and the owner shut it down');
  }
}

function builderDemand(eco: Economy, f: Firm): number {
  // monthly work wanted: active projects' remaining work spread over ~4 months + small jobs
  let backlog = 0;
  for (const p of eco.projects.values()) if (p.builderId === f.id && p.status === 'active') backlog += p.remaining;
  return backlog / 4 + (f.last.units + f.last.unmet) * 0.5;
}

function projectReserve(eco: Economy, f: Firm): number {
  const p = eco.projects.get(f.project);
  if (!p || p.status === 'complete') return 0;
  return Math.max(0, p.cost - p.paid);
}

// ============================================================================ investment

function planExpansion(eco: Economy, f: Firm): void {
  if (eco.genesis?.hasPendingLoan(f.id)) return;
  const sp = SECTORS[f.sector];
  const mk = eco.market;
  const capCap = f.capitalCap;
  // expand in modest steps
  const addCap = Math.max(capCap * 0.15, Math.min(capCap * 0.4, f.expDemand * 1.15 - capCap));
  const addK = Math.min(f.K * 1.0, addCap * sp.kappa);
  if (addK <= 0) return;
  const unitPrice = 0.5 * mk.factoryPrice + 0.5 * mk.builderPrice;
  const cost = addK * unitPrice;
  // incremental variable margin per unit
  const unitLabour = f.wage / f.A;
  const unitInput = f.sector === 'retail' ? sp.inputShare * mk.factoryPrice : f.sector === 'builder' ? sp.inputShare * mk.factoryPrice : 0;
  const margin = f.price - unitLabour - unitInput;
  const extraUnits = Math.min(addK / sp.kappa, Math.max(0, f.expDemand * 1.1 - capCap)) * 0.9;
  const incr = extraUnits * margin - ((addK * CFG.depreciation) / 12) * mk.factoryPrice;
  const roi = (incr * 12) / cost;
  const borrowCost = eco.policy.policyRate + 0.035;
  if (roi < borrowCost + CFG.expansionHurdle) {
    f.note(eco.day, `Considered expanding but the return (${pct(roi)}) did not beat borrowing costs (${pct(borrowCost)})`);
    return;
  }
  const costs = monthlyCosts(eco, f);
  const spare = Math.max(0, f.acct.balance - costs * CFG.cashBufferMonths);
  // pay cash if the firm can afford it outright, otherwise put in some equity and borrow
  const equity = spare >= cost ? cost : Math.min(spare, cost * 0.35);
  const borrow = cost - equity;
  const reason = `${f.name} was running at ${pct(Math.min(1.5, f.last.units / Math.max(1, capCap)), 0)} of capacity and turning customers away`;
  const launch = (loanId: number, k: number) => {
    const c = cost * k;
    const x = addK * k;
    const p = startProject(eco, 'expansion', f.lotId, f.id, c, x * 0.5, x * 0.5, reason, { kind: 'firm', level: levelFor(f.sector, f.K + x) });
    if (!p) return;
    p.loanId = loanId;
    f.project = p.id;
  };
  if (borrow > 5000) {
    const cf = f.last.revenue - f.last.wages - f.last.inputs - f.last.maintenance;
    const app: LoanApp = {
      borrower: f,
      kind: 'business',
      purpose: 'expansion',
      amount: Math.round(borrow / 1000) * 1000,
      termMonths: 96,
      amortizing: true,
      collateral: { kind: 'business', ref: f.id, value: addK * unitPrice * 0.5 },
      income: cf,
      projected: incr + (addK * CFG.depreciation * mk.factoryPrice) / 12,
      existingDebtService: f.debtService(),
      existingDebt: f.debt(),
      what: `expanding ${f.name}`,
    };
    const context = { expansion: { addK, unitPrice, cost, equity } };
    requestLoan(eco, app, { maxRate: roi - CFG.expansionHurdle * 0.5, review: 'expansion', context }, (d, fin) => {
      if (!d.offer) {
        f.denials++;
        f.lastDenialReason = d.reason ?? '';
        f.note(eco.day, `Expansion loan refused: ${d.reason}`, 'bad');
        eco.event('loan_denied', f.id, app.amount, f.acct.bank.id, d.reason);
        if (app.amount > 100_000) eco.headline(`${f.name} is turned down for a ${fmtMoney(app.amount)} expansion loan (${d.reason})`, 'bad', f.id, undefined, `deny-${f.id}`, 120);
        // without credit, grow more slowly out of retained profits
        if (spare > cost * 0.25 && f.status === 'open' && f.project < 0) selfFundedExpansion(eco, f, spare * 0.9, unitPrice, reason);
        return;
      }
      // (in Genesis Mode the decision may come days later: make sure the plan still makes sense)
      if (f.status !== 'open' || f.project >= 0) return;
      const loan = originate(eco, d.offer, fin);
      f.note(eco.day, `Borrowed ${fmtMoney(fin.amount)} from ${d.offer.bank.name} to expand`, 'good', fin.amount, d.offer.bank.id);
      if (fin.amount > 60_000)
        eco.headline(`${d.offer.bank.name} lends ${fmtMoney(fin.amount)} to ${f.name} to expand`, 'good', f.id, undefined, `exp-${f.id}`, 60);
      // a resized loan scales the project (the owner's own contribution stays the same)
      launch(loan.id, fin.amount === app.amount ? 1 : (equity + fin.amount) / cost);
    });
    return;
  }
  launch(-1, 1);
}

function selfFundedExpansion(eco: Economy, f: Firm, budget: number, unitPrice: number, reason: string): void {
  const addK = budget / unitPrice;
  const p = startProject(eco, 'expansion', f.lotId, f.id, budget, addK * 0.5, addK * 0.5, `${reason} (paid from its own cash: the banks said no)`, {
    kind: 'firm',
    level: levelFor(f.sector, f.K + addK),
  });
  if (!p) return;
  f.project = p.id;
  f.note(eco.day, `Expanding with ${fmtMoney(budget)} of its own cash`, 'neutral', budget);
}

/** Visual size tier for a given capital stock. */
export function levelFor(sector: Sector, K: number): number {
  const sp = SECTORS[sector];
  const base = sp.startWorkers * sp.A * sp.kappa;
  const r = K / base;
  const max = sector === 'retail' || sector === 'service' || sector === 'builder' ? 3 : 4;
  const lvl = r < 1.45 ? 1 : r < 2.3 ? 2 : r < 3.6 ? 3 : 4;
  return Math.min(max, lvl);
}

export function firmLevel(f: Firm): number {
  return levelFor(f.sector, f.K);
}

// ============================================================================ open / close

export function openFirm(eco: Economy, f: Firm): void {
  f.status = 'open';
  f.openedDay = eco.day;
  f.lastReview = eco.day;
  f.m = newFirmMonth();
  const sp = SECTORS[f.sector];
  f.vacancies = Math.max(1, Math.round(sp.startWorkers * (f.K / (sp.startWorkers * sp.A * sp.kappa))));
  f.expDemand = f.capitalCap * 0.7;
  f.note(eco.day, `Opened for business`, 'good');
  eco.event('firm_open', f.id);
  eco.monthCounters.firmOpenings++;
  eco.headline(`Grand opening: ${f.name}`, 'good', f.id, undefined, `open-${f.id}`, 0);
  eco.genesis?.onFirmOpened(f);
}

export function closeFirm(eco: Economy, f: Firm, reason: string): void {
  if (f.status === 'closed') return;
  const wasPlanned = f.status === 'planned';
  f.status = 'closed';
  f.closedDay = eco.day;
  f.health = 'distressed';
  for (const hid of f.workers.slice()) {
    const h = eco.household(hid);
    if (h) fire(eco, h, `${f.name} closed down`);
  }
  f.workers = [];
  f.vacancies = 0;
  // stop any construction it was paying for
  const p = eco.projects.get(f.project);
  if (p && (p.status === 'active' || p.status === 'stalled')) {
    p.status = 'abandoned';
    p.stallReason = `${f.name} closed`;
  }
  f.project = -1;
  // liquidation: the lead lender takes the premises
  const active = f.loans.filter((l) => l.active);
  if (active.length) {
    const lead = active.reduce((a, b) => (b.balance > a.balance ? b : a));
    const bank = lead.holder.kind === 'bank' ? eco.bank(lead.holder.id) : eco.bank(lead.servicerId);
    const premises = f.K * eco.market.factoryPrice * eco.market.commercialIndex * 0.35;
    if (bank && bank.alive && premises > 0 && lead.holder.kind === 'bank') {
      const take = Math.min(premises, lead.balance);
      bank.reoLots.set(f.lotId, take);
      lead.balance -= take; // asset swap: loan claim -> foreclosed premises
      lead.recovered += take;
      lead.note(eco.day, `${bank.short} took over the premises (${fmtMoney(take)})`, take, bank.id);
      invalidateMetrics(bank);
    }
    for (const l of active) {
      if (l.balance <= 0.5) {
        l.balance = 0;
        l.status = 'repaid';
        l.closedDay = eco.day;
        releaseFromBank(eco, l);
        continue;
      }
      defaultLoan(eco, l);
    }
  } else {
    // no debt: the owner keeps what is left
    const owner = eco.household(f.ownerId);
    if (owner && f.acct.balance > 0) {
      const paid = eco.ledger.transfer(f.acct, owner.acct, f.acct.balance, 'dividend');
      owner.incomeThisMonth += paid;
    }
  }
  const owner = eco.household(f.ownerId);
  if (owner) {
    owner.firms = owner.firms.filter((x) => x !== f.id);
    owner.note(eco.day, `${f.name} closed: ${reason}`, 'bad', undefined, f.id);
  }
  f.note(eco.day, `Closed: ${reason}`, 'bad');
  if (!wasPlanned) {
    eco.event('firm_close', f.id, undefined, undefined, reason);
    eco.monthCounters.firmClosures++;
    eco.headline(`${f.name} closes its doors: ${reason}`, 'bad', f.id, undefined, `close-${f.id}`, 0);
  }
  eco.genesis?.onFirmClosed(f, reason);
}

// ============================================================================ entry

const ENTRY_SECTORS: Sector[] = ['retail', 'service', 'factory', 'builder'];

export function entryMonthly(eco: Economy): void {
  if (eco.genesis) return; // Genesis Mode drafts its own business plans
  const mk = eco.market;
  for (const s of ENTRY_SECTORS) {
    if (eco.day - (eco.lastEntry[s] ?? -9999) < 90) continue;
    let open = 0;
    for (const f of eco.firms) if (f.sector === s && f.status !== 'closed') open++;
    const minCount = s === 'retail' || s === 'service' ? 6 : 2;
    const pressure = mk.sectorPressure[s] ?? 0.85;
    const profit = mk.sectorProfit[s] ?? 0.05;
    let p = CFG.entryBase * (open < minCount ? 4 : 1) + 1.2 * Math.max(0, pressure - 0.92) + 1.5 * Math.max(0, profit - 0.1);
    p *= 0.5 + mk.consumerConfidence;
    if (eco.rng.chance(Math.min(0.6, p)) && tryStartFirm(eco, s)) eco.lastEntry[s] = eco.day;
  }
}

export function tryStartFirm(eco: Economy, sector: Sector): Firm | null {
  const mk = eco.market;
  const sp = SECTORS[sector];
  const big = sector === 'factory' || sector === 'builder' || ((sector === 'service' || sector === 'retail') && eco.rng.chance(0.15));
  const zone = sector === 'factory' || sector === 'builder' ? 'ind' : 'com';
  // prefer re-using a vacant building of a closed firm
  let lotId = -1;
  let refit = false;
  const closedLots: number[] = [];
  for (const [lid, use] of eco.lotUse) {
    if (use.type !== 'firm') continue;
    const old = eco.firm(use.id);
    if (!old || old.status !== 'closed') continue;
    const lot = eco.city.lots[lid];
    if (lot.zone !== zone && !(zone === 'com' && lot.zone === 'civic')) continue;
    if ((lot.w >= 2) !== big) continue;
    closedLots.push(lid);
  }
  if (closedLots.length && eco.rng.chance(0.7)) {
    lotId = eco.rng.pick(closedLots);
    refit = true;
  } else {
    const empty = eco.city.lots.filter((l) => l.zone === zone && !l.reserved && !eco.lotUse.has(l.id) && (l.w >= 2) === big);
    if (!empty.length) {
      if (!closedLots.length) return null;
      lotId = eco.rng.pick(closedLots);
      refit = true;
    } else lotId = eco.rng.pick(empty).id;
  }
  const scale = big && (sector === 'service' || sector === 'retail') ? 3 : 1;
  const workers = sp.startWorkers * scale;
  const K = workers * sp.A * sp.kappa;
  const buildWork = refit ? K * 0.15 : K * 0.5;
  const equipment = K * 0.5;
  const building = buildWork * mk.builderPrice;
  const equipCost = equipment * mk.factoryPrice;
  const reoPrice = refit ? eco.banks.reduce((s, b) => s + (b.reoLots.get(lotId) ?? 0), 0) : 0;
  const working = workers * mk.wageIndex * 2;
  const cost = building + equipCost + reoPrice + working;
  // an entrepreneur with savings
  const cands = eco.households.filter(
    (h) => !h.departed && h.homeUnit >= 0 && h.firms.length < 2 && h.acct.balance > cost * CFG.startupEquityShare && eco.day - h.lastDefaultDay > 1500,
  );
  if (!cands.length) return null;
  const owner = eco.rng.weighted(cands, (h) => h.acct.balance);
  if (!owner) return null;
  const equity = Math.min(owner.acct.balance * 0.6, cost * 0.4);
  const borrow = cost - equity;
  const subtype = pickSubtype(eco, sector, big);
  const bank = owner.acct.bank;
  const f = new Firm(
    eco.newId(),
    firmName(eco.rng, sector, subtype, eco.city.name),
    sector,
    subtype,
    lotId,
    owner.id,
    firmColor(eco.rng),
    eco.rng.int(0, DAYS_PER_MONTH - 1),
    eco.rng.int(0, DAYS_PER_MONTH - 1),
    eco.day,
  );
  f.acct = eco.openAccount(f.id, bank);
  f.A = sp.A * (0.95 + 0.1 * eco.rng.next()) * (1 + 0.004 * (eco.day / 360));
  f.kappa = sp.kappa;
  f.K = 0;
  f.price = sector === 'retail' ? mk.retailPrice : sector === 'service' ? mk.servicePrice : sector === 'factory' ? mk.factoryPrice : mk.builderPrice;
  f.wage = mk.wageIndex * 1.02;
  // expected monthly profit at normal utilisation, for the bank
  const q = (K / sp.kappa) * CFG.targetUtilization;
  const unitInput = sector === 'retail' || sector === 'builder' ? sp.inputShare * mk.factoryPrice : 0;
  const monthlyProfit = q * (f.price - unitInput) - workers * f.wage - (K * CFG.depreciation * mk.factoryPrice) / 12;
  eco.register(f);
  let loanId = -1;
  if (borrow > 5000) {
    const app: LoanApp = {
      borrower: f,
      kind: 'business',
      purpose: 'startup',
      amount: Math.round(borrow / 1000) * 1000,
      termMonths: 96,
      amortizing: true,
      collateral: { kind: 'business', ref: f.id, value: K * 0.5 * mk.factoryPrice },
      income: 0,
      projected: monthlyProfit + (K * CFG.depreciation * mk.factoryPrice) / 12,
      existingDebtService: 0,
      existingDebt: 0,
      what: `starting ${f.name}`,
      equityShare: equity / cost,
    };
    // the owner puts in equity only if the bank says yes
    const d = shopForLoan(eco, app);
    if (!d.offer) {
      const selfFund = owner.acct.balance * 0.8;
      if (selfFund < cost * (refit ? 0.5 : 0.6)) {
        eco.agents.delete(f.id);
        owner.note(eco.day, `Wanted to open a ${subtype} but the bank said no: ${d.reason}`, 'bad');
        if (eco.rng.chance(0.3)) eco.headline(`An entrepreneur's plan for a new ${subtype} is rejected by the banks (${d.reason})`, 'bad', owner.id, lotId, `denystart`, 90);
        return null;
      }
      // a smaller shop, paid for out of savings
      const scaleDown = Math.min(1, selfFund / cost);
      eco.firms.push(f);
      eco.ledger.transfer(owner.acct, f.acct, selfFund, 'capital');
      f.ownerEquity = selfFund;
      f.note(eco.day, `Founded by ${owner.name} with ${fmtMoney(selfFund)} of savings (no bank would lend)`, 'good', selfFund);
      return finishStart(eco, f, owner, lotId, refit, sector, building * scaleDown, equipCost * scaleDown, buildWork * scaleDown, equipment * scaleDown, -1);
    }
    eco.firms.push(f);
    eco.ledger.transfer(owner.acct, f.acct, equity, 'capital');
    f.ownerEquity = equity;
    const loan = originate(eco, d.offer, app);
    loanId = loan.id;
    f.note(eco.day, `Founded by ${owner.name} with ${fmtMoney(equity)} of savings and a ${fmtMoney(app.amount)} loan from ${d.offer.bank.name}`, 'good', app.amount, d.offer.bank.id);
  } else {
    eco.firms.push(f);
    eco.ledger.transfer(owner.acct, f.acct, equity, 'capital');
    f.ownerEquity = equity;
    f.note(eco.day, `Founded by ${owner.name} with ${fmtMoney(equity)} of savings`, 'good');
  }
  return finishStart(eco, f, owner, lotId, refit, sector, building, equipCost, buildWork, equipment, loanId);
}

function finishStart(
  eco: Economy,
  f: Firm,
  owner: Household,
  lotId: number,
  refit: boolean,
  sector: Sector,
  building: number,
  equipCost: number,
  buildWork: number,
  equipment: number,
  loanId: number,
): Firm {
  const mk = eco.market;
  owner.firms.push(f.id);
  owner.note(eco.day, `Started a business: ${f.name}`, 'good', f.ownerEquity, f.id);
  // the old closed firm on this lot is gone for good; the bank sells the premises
  if (refit) {
    const old = eco.lotUse.get(lotId);
    const oldFirm = old ? eco.firm(old.id) : undefined;
    if (oldFirm && oldFirm.acct.balance > 0) {
      const prevOwner = eco.household(oldFirm.ownerId);
      if (prevOwner) eco.ledger.transfer(oldFirm.acct, prevOwner.acct, oldFirm.acct.balance, 'dividend');
    }
    eco.firms = eco.firms.filter((x) => x.id !== old?.id || x === f);
    for (const b of eco.banks) {
      const v = b.reoLots.get(lotId);
      if (v !== undefined) {
        // the startup buys the premises from the bank
        const paid = eco.ledger.payBank(f.acct, b, Math.min(v, f.acct.balance), 'property');
        b.reoLots.delete(lotId);
        b.pl.securitiesGains += paid - v;
        invalidateMetrics(b);
      }
    }
  }
  eco.lotUse.set(lotId, { type: 'firm', id: f.id });
  const reason = `${owner.name} saw unmet demand for ${sector === 'retail' ? 'goods' : sector === 'service' ? 'services' : sector === 'factory' ? 'manufactured goods' : 'construction'} (${pct(Math.min(2, mk.sectorPressure[sector] ?? 0), 0)} of capacity in use)`;
  const p = startProject(eco, refit ? 'refit' : 'startup', lotId, f.id, building + equipCost, buildWork, equipment, reason, { kind: 'firm', level: 1 });
  if (p) {
    p.loanId = loanId;
    f.project = p.id;
  }
  return f;
}

const SUBTYPES: Record<Sector, string[]> = {
  retail: ['grocery', 'clothing', 'electronics', 'hardware', 'furniture', 'pharmacy', 'bakery', 'books'],
  service: ['diner', 'cafe', 'clinic', 'cinema', 'gym', 'salon', 'restaurant', 'lawoffice'],
  factory: ['textiles', 'furniture', 'electronics', 'steel', 'food', 'chemicals'],
  builder: ['builder'],
};

function pickSubtype(eco: Economy, sector: Sector, big: boolean): string {
  if (sector === 'service' && big) return eco.rng.pick(['insurance', 'agency', 'tech', 'lawoffice']);
  if (sector === 'retail' && big) return eco.rng.pick(['department', 'supermarket']);
  // prefer subtypes the town lacks
  const have = new Map<string, number>();
  for (const f of eco.firms) if (f.sector === sector && f.status !== 'closed') have.set(f.subtype, (have.get(f.subtype) ?? 0) + 1);
  const opts = SUBTYPES[sector];
  return eco.rng.weighted(opts, (s) => 1 / (1 + (have.get(s) ?? 0) * 2)) ?? opts[0];
}

const COLORS = ['#c0392b', '#2e86c1', '#28b463', '#d68910', '#8e44ad', '#17a589', '#cb4335', '#2471a3', '#b7950b', '#7d3c98', '#a04000', '#1e8449'];
export function firmColor(rng: Economy['rng']): string {
  return rng.pick(COLORS);
}
