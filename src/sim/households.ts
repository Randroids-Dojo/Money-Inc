// Households: monthly budgeting (consumption out of income and wealth), rent, home
// renovation, consumer credit, saving in the fund, house hunting and speculation,
// switching banks, and migration in and out of town.

import { CFG, DAYS_PER_MONTH } from './config';
import type { Economy } from './economy';
import { Household, type Unit } from './agents';
import { fire, pickFavourites } from './markets';
import { originate, shopForLoan, redeemFund, unitValue, defaultLoan, invalidateMetrics, type LoanApp } from './banking';
import { maxPrincipalForPayment } from './loan';
import { smallJob } from './construction';
import { debtService, findRental, listUnit, marketAsk, vacantRentals } from './housing';
import { fmtMoney } from './format';
import { familyName } from './names';
import type { Bank } from './bank';

// ============================================================================ billing day

export function billingDay(eco: Economy, dom: number): void {
  for (const h of eco.households) {
    if (h.departed || h.billingDay !== dom) continue;
    payRent(eco, h);
    if (h.departed) continue;
    // home owners keep their homes in repair
    const u = eco.units[h.homeUnit];
    if (u && u.ownerId === h.id) {
      const spend = unitValue(eco, u.id) * CFG.renovationRate * (0.5 + eco.market.consumerConfidence);
      if (h.acct.balance > spend * 4) smallJob(eco, h, spend);
    }
  }
}

function payRent(eco: Economy, h: Household): void {
  const u = eco.units[h.homeUnit];
  if (!u || u.ownerId === h.id || u.occupantId !== h.id) return;
  const owner = eco.agents.get(u.ownerId);
  if (!owner) return;
  const rent = u.rent;
  if (h.acct.balance < rent) {
    // dip into the fund first
    if (h.fundUnits > 0) redeemFund(eco, h, (rent * 1.2) / eco.fund.nav);
  }
  if (h.acct.balance < rent) {
    h.rentArrears++;
    h.note(eco.day, `Could not pay the rent`, 'bad');
    if (h.rentArrears >= 3) evict(eco, h, u);
    return;
  }
  h.rentArrears = 0;
  if (owner.kind === 'household' || owner.kind === 'firm') {
    const paid = eco.ledger.transfer(h.acct, owner.acct, rent, 'rent');
    if (owner.kind === 'household') owner.incomeThisMonth += paid;
    else owner.m.revenue += paid;
  } else if (owner.kind === 'bank') {
    const paid = eco.ledger.payBank(h.acct, owner, rent, 'rent');
    owner.pl.fees += paid;
  } else if (owner.kind === 'fund') {
    const paid = eco.ledger.transfer(h.acct, owner.acct, rent, 'rent');
    owner.incomeMonth += paid;
  }
}

function evict(eco: Economy, h: Household, u: Unit): void {
  u.occupantId = -1;
  h.homeUnit = -1;
  h.rentArrears = 0;
  h.note(eco.day, `Evicted for unpaid rent`, 'bad');
  const cheap = vacantRentals(eco).filter((x) => x.rent < u.rent * 0.9 && x.id !== u.id);
  if (cheap.length && findRental(eco, h)) return;
  departHousehold(eco, h, 'was evicted and left town');
}

// ============================================================================ monthly review

export function reviews(eco: Economy, dom: number): void {
  for (const h of eco.households) {
    if (h.departed || h.billingDay !== dom) continue;
    if (eco.day - h.lastReview < 20) continue;
    reviewHousehold(eco, h);
  }
}

function ownedHome(eco: Economy, h: Household): Unit | undefined {
  const u = eco.units[h.homeUnit];
  return u && u.ownerId === h.id ? u : undefined;
}

export function homeEquity(eco: Economy, h: Household): number {
  let eq = 0;
  for (const uid of h.ownedUnits) {
    const u = eco.units[uid];
    const v = unitValue(eco, uid);
    eq += v - (u.mortgage && u.mortgage.active ? u.mortgage.balance : 0);
  }
  return eq;
}

/** Monthly consumption plan out of income, the wealth buffer, fund savings and home equity. */
export function planBudget(eco: Economy, h: Household): number {
  const mk = eco.market;
  const P = mk.cpi;
  const u = eco.units[h.homeUnit];
  const rent = u && u.ownerId !== h.id ? u.rent : 0;
  const ds = debtService(h);
  const essentials = CFG.essentials * P;
  const income = Math.max(0, h.income);
  const disc = Math.max(0, income - rent - ds - essentials);
  // households aim for a stable stock of liquid wealth (deposits + fund savings) relative
  // to income: extra money gets spent, shortfalls are rebuilt by cutting back
  const deposits = h.acct.balance;
  const fundWealth = h.fundUnits * eco.fund.nav;
  const target = h.wealthMonths * Math.max(income, essentials);
  const excess = deposits + fundWealth - target;
  let wealthTerm = excess > 0 ? CFG.wealthSpend * excess : CFG.rebuildRate * excess;
  const eq = homeEquity(eco, h);
  if (eq > 0) wealthTerm += CFG.homeEquityMpc * eq * (0.5 + mk.consumerConfidence);
  const conf = mk.consumerConfidence;
  const depRate = h.acct.bank.depositRate;
  // saving is mostly about reaching the wealth target (the wealth term); on top of that a
  // small permanent saving habit, more when nervous or when deposits pay well
  const saveRate = (1 - h.mpc) * 0.4 + 0.1 * Math.max(0, 0.7 - conf) + 0.5 * Math.max(0, depRate - 0.02);
  const spendable = Math.max(0, income - rent - ds);
  let budget = Math.max(essentials * 0.8, spendable * (1 - saveRate)) + wealthTerm;
  if (!h.employed && !h.retired) budget = Math.min(budget, essentials + 0.4 * disc + Math.max(0, wealthTerm) * 0.5);
  budget = Math.max(budget, Math.min(essentials * 0.6, (deposits + fundWealth) * 0.5));
  budget = Math.min(budget, deposits * 0.7 + income * 0.95 + fundWealth * 0.05);
  return Math.max(0, budget);
}

function reviewHousehold(eco: Economy, h: Household): void {
  // ---- close the month (normalised to 30 days)
  const span = Math.max(1, eco.day - h.lastReview);
  h.lastReview = eco.day;
  const inc = (h.incomeThisMonth * DAYS_PER_MONTH) / span;
  h.income = h.income <= 0 ? inc : 0.7 * h.income + 0.3 * inc;
  h.incomeThisMonth = 0;
  h.wagesThisMonth = 0;
  h.spentLastMonth = h.spentThisMonth;
  h.spentThisMonth = 0;
  h.unmetThisMonth = 0;
  if (h.employed) h.employedDays += DAYS_PER_MONTH;
  else h.unemployedDays += DAYS_PER_MONTH;
  // job churn: a few people leave their jobs each month to look for something better,
  // more of them when jobs are easy to find
  if (h.employed && h.firms.length === 0) {
    const emp = eco.agents.get(h.employer);
    const tight = Math.max(0, 0.06 - eco.market.unemployment);
    if (emp && emp.kind === 'firm' && eco.rng.chance(0.006 + 0.15 * tight)) fire(eco, h, 'left to look for a better-paid job', true);
  }

  // ---- consumption plan
  h.budget = planBudget(eco, h);
  const income = Math.max(0, h.income);
  const essentials = CFG.essentials * eco.market.cpi;
  const buffer = h.bufferMonths * Math.max(income, essentials);
  const deposits = h.acct.balance;
  const nav = eco.fund.nav;
  const ds = debtService(h);

  // ---- surplus savings go into the fund; savings are drawn down when the account runs low
  if (deposits > buffer * 1.4 && deposits > 15_000 && eco.fund.fear < 0.8) {
    const amt = CFG.fundInvestShare * (deposits - buffer * 1.2);
    const paid = eco.ledger.transfer(h.acct, eco.fund.acct, amt, 'fund');
    const units = paid / nav;
    h.fundUnits += units;
    eco.fund.units += units;
  } else if (deposits < buffer * 0.5 && h.fundUnits > 0) {
    redeemFund(eco, h, Math.min(h.fundUnits, (buffer * 0.8 - deposits) / nav));
  }
  // ---- consumer credit
  consumerCredit(eco, h, essentials, income, ds);

  // ---- housing
  housingDecisions(eco, h, income, ds);

  // ---- regular shops: occasionally shop around
  for (const s of ['retail', 'service'] as const) {
    const favs = h.favs[s];
    if (!favs.length || eco.rng.chance(0.12)) {
      const open = eco.firms.filter((f) => f.status === 'open' && f.sector === s);
      h.favs[s] = pickFavourites(eco, h, s, open);
    }
  }

  // ---- switching banks for a better rate or a safer home for savings
  if (eco.rng.chance(0.025)) considerSwitchingBank(eco, h.acct, 0.004);
}

export function considerSwitchingBank(eco: Economy, acct: Household['acct'], minGain: number): void {
  const cur = acct.bank;
  let best: Bank | undefined;
  let bestScore = cur.alive ? cur.depositRate - 0.05 * cur.stress : -1;
  for (const b of eco.aliveBanks()) {
    const score = b.depositRate - 0.05 * b.stress;
    if (score > bestScore + minGain) {
      best = b;
      bestScore = score;
    }
  }
  if (best) {
    eco.ledger.moveAccount(acct, best, 'transfer');
    invalidateMetrics(cur);
    invalidateMetrics(best);
  }
}

function consumerCredit(eco: Economy, h: Household, essentials: number, income: number, ds: number): void {
  if (!h.employed || h.durablesToBuy > 0) return;
  const hasConsumer = h.loans.some((l) => l.active && l.kind === 'consumer');
  if (hasConsumer) return;
  const conf = eco.market.consumerConfidence;
  let purpose: 'durables' | 'smoothing' | null = null;
  let amount = 0;
  if (h.acct.balance < essentials * 0.6 && eco.rng.chance(0.5)) {
    purpose = 'smoothing';
    amount = essentials * 1.5;
  } else if (eco.rng.chance(0.022 * (0.4 + conf) * (1 + 1.5 * Math.max(0, 0.35 - avgFear(eco))))) {
    purpose = 'durables';
    amount = income * (1.5 + 2.5 * eco.rng.next());
  }
  if (!purpose || amount < 1000) return;
  const app: LoanApp = {
    borrower: h,
    kind: 'consumer',
    purpose,
    amount: Math.round(amount / 100) * 100,
    termMonths: 36,
    amortizing: true,
    collateral: { kind: 'none', value: 0 },
    income: h.wage,
    existingDebtService: ds,
    existingDebt: 0,
    what: purpose === 'durables' ? 'a car / furniture / appliances' : 'covering bills until payday',
  };
  const d = shopForLoan(eco, app);
  if (!d.offer) return;
  const loan = originate(eco, d.offer, app);
  if (purpose === 'durables') {
    h.durablesToBuy = app.amount;
    h.durablesLoan = loan.id;
    h.note(eco.day, `Borrowed ${fmtMoney(app.amount)} from ${d.offer.bank.name} for a big purchase`, 'neutral', app.amount, d.offer.bank.id);
  } else {
    h.note(eco.day, `Borrowed ${fmtMoney(app.amount)} from ${d.offer.bank.name} to cover bills`, 'bad', app.amount, d.offer.bank.id);
  }
}

function avgFear(eco: Economy): number {
  const bs = eco.aliveBanks();
  return bs.length ? bs.reduce((s, b) => s + b.fear, 0) / bs.length : 1;
}

/** Most generous terms any bank currently offers (for pre-approval). */
function loosestTerms(eco: Economy): { ltv: number; dti: number; rate: number } {
  let ltv = 0.5,
    dti = 0.25,
    rate = 0.2;
  for (const b of eco.aliveBanks()) {
    if (b.stance === 'frozen') continue;
    ltv = Math.max(ltv, b.maxLTV);
    dti = Math.max(dti, b.maxDTI);
    rate = Math.min(rate, eco.policy.policyRate + b.spreads.mortgage);
  }
  return { ltv, dti, rate };
}

function housingDecisions(eco: Economy, h: Household, income: number, ds: number): void {
  const mk = eco.market;
  const home = ownedHome(eco, h);
  const terms = loosestTerms(eco);
  const typical = (CFG.houseBaseValue * 0.55 + CFG.aptUnitBaseValue * 0.45) * mk.hpi;
  // --- sell?
  if (home && !home.listing) {
    const mort = home.mortgage && home.mortgage.active ? home.mortgage : null;
    const behind = mort && mort.missed > 0;
    const equity = unitValue(eco, home.id) - (mort ? mort.balance : 0);
    if (behind && equity > 0) {
      listUnit(eco, home, h.id, marketAsk(eco, home) * 0.95, true);
      h.note(eco.day, `Put their home up for sale to escape the mortgage`, 'bad');
      return;
    }
    if (eco.rng.chance(CFG.relocationRate) && (!mort || equity > 0)) {
      listUnit(eco, home, h.id, marketAsk(eco, home), false);
      h.note(eco.day, `Put their home up for sale to move`, 'neutral');
      h.movingUp = eco.rng.chance(0.65);
    }
  }
  // investors sell when the expected total return on a rental turns negative, or when they need cash
  for (const uid of h.ownedUnits) {
    const u = eco.units[uid];
    if (u === home || u.listing) continue;
    const value = unitValue(eco, uid);
    const rentYield = (u.rent * 12) / Math.max(1, value);
    const mort = u.mortgage && u.mortgage.active ? u.mortgage : null;
    const financing = mort ? (mort.rate * mort.balance) / Math.max(1, value) : 0;
    const expected = rentYield - financing - 0.015 + expectedAppreciation(eco, h.speculator);
    const vacantRich = u.occupantId < 0 && expected < 0.02 && eco.rng.chance(0.35);
    const bearish = vacantRich || (expected < -0.01 && eco.rng.chance(Math.min(0.4, (-expected - 0.01) * 6) * (0.4 + h.speculator)));
    const squeezed = h.acct.balance < ds * 0.5 && eco.rng.chance(0.5);
    if (bearish || squeezed) {
      listUnit(eco, u, h.id, marketAsk(eco, u) * (squeezed ? 0.95 : 1), squeezed);
      h.note(eco.day, squeezed ? `Selling a rental property to raise cash` : `Selling a rental property before prices fall further`, 'neutral');
      break;
    }
  }
  if (h.lookingToBuy) return;
  const cash = Math.max(0, h.acct.balance - CFG.essentials * mk.cpi * 2);
  // --- movers who sold their home look for the next one
  if (!home && h.movingUp && h.employed) {
    const maxPmt = terms.dti * h.wage - ds;
    const maxLoan = maxPrincipalForPayment(maxPmt, terms.rate, CFG.mortgageTerm);
    h.lookingToBuy = 'home';
    h.buyBudget = Math.min(maxLoan + cash * 0.95, (cash * 0.95) / Math.max(0.05, 1 - terms.ltv + 0.03));
    h.movingUp = false;
    return;
  }
  // --- renters buying a home: compare the cost of owning with the rent they pay
  if (!home && h.employed && h.employedDays >= 180 && eco.day - h.lastDefaultDay > 1500) {
    const appreciation = expectedAppreciation(eco, 0);
    const ltv = terms.ltv;
    const userCost = terms.rate * ltv + h.acct.bank.depositRate * (1 - ltv) + 0.015 - appreciation;
    const rentNow = (CFG.houseBaseRent * 0.55 + CFG.aptBaseRent * 0.45) * mk.rentIndex * 12;
    const appeal = Math.max(0.3, Math.min(3, rentNow / Math.max(1, typical * Math.max(0.01, userCost))));
    const fomo = 1 + 3 * Math.max(0, mk.hpiExpect - 0.03);
    const drive = CFG.ownershipDrive * (0.4 + mk.consumerConfidence) * Math.pow(appeal, 1.5) * fomo;
    if (cash > typical * (1 - terms.ltv) + 2000 && eco.rng.chance(Math.min(0.5, drive))) {
      const maxPmt = terms.dti * h.wage - ds;
      const maxLoan = maxPrincipalForPayment(maxPmt, terms.rate, CFG.mortgageTerm);
      const budget = Math.min(maxLoan + cash * 0.95, (cash * 0.95) / Math.max(0.05, 1 - terms.ltv + 0.03));
      if (budget > typical * 0.6) {
        h.lookingToBuy = 'home';
        h.buyBudget = budget;
      }
    }
    return;
  }
  // --- investors buying rental property: rent yield + expected gains (momentum and value)
  const investable = cash + h.fundUnits * eco.fund.nav * 0.6;
  if (h.speculator > 0.35 && h.ownedUnits.length < 5 && investable > 20_000) {
    const value = CFG.houseBaseValue * mk.hpi;
    const rentYield = (CFG.houseBaseRent * 12 * mk.rentIndex) / value;
    const expectGain = expectedAppreciation(eco, h.speculator);
    const ltv = terms.ltv - 0.12;
    const cost = terms.rate * ltv + 0.03 * (1 - ltv) + 0.015;
    const expected = rentYield + expectGain - cost;
    if (expected > 0.012 && eco.rng.chance(Math.min(0.4, 0.12 * h.speculator + (expected - 0.012) * 3))) {
      const rentIncome = CFG.houseBaseRent * mk.rentIndex * 0.75;
      const maxPmt = (terms.dti + 0.05) * (h.wage + rentIncome) - ds;
      const maxLoan = maxPrincipalForPayment(maxPmt, terms.rate + 0.005, CFG.mortgageTerm);
      // with enough savings they can buy outright, whatever the banks think
      const budget = Math.max(investable * 0.9, Math.min(maxLoan + investable * 0.9, (investable * 0.9) / Math.max(0.05, 1 - ltv)));
      if (budget > typical * 0.5) {
        if (h.acct.balance < budget * 0.5 && h.fundUnits > 0) redeemFund(eco, h, Math.min(h.fundUnits, (budget * 0.5 - h.acct.balance) / eco.fund.nav));
        h.lookingToBuy = 'investment';
        h.buyBudget = budget;
      }
    }
  }
}

/**
 * What an investor expects house prices to do next year: part extrapolation of recent
 * gains (stronger for speculators), part general inflation, part "value" — houses that
 * look cheap relative to rents are expected to recover.
 */
export function expectedAppreciation(eco: Economy, speculator: number): number {
  const mk = eco.market;
  const momentumWeight = 0.3 + 0.6 * speculator;
  const pr0 = CFG.houseBaseValue / (CFG.houseBaseRent * 12);
  const prNow = (CFG.houseBaseValue * mk.hpi) / (CFG.houseBaseRent * 12 * mk.rentIndex);
  const value = Math.max(-0.08, Math.min(0.1, 0.12 * (pr0 / prNow - 1)));
  return momentumWeight * mk.hpiExpect + (1 - momentumWeight) * mk.inflationExpect + value;
}

// ============================================================================ migration

export function migrationMonthly(eco: Economy): void {
  if (eco.genesis) {
    eco.genesis.migration();
    return;
  }
  let vac = 0,
    unemployed = 0;
  for (const f of eco.firms) if (f.status !== 'closed') vac += Math.max(0, f.vacancies);
  for (const h of eco.households) if (!h.departed && !h.employed && !h.retired) unemployed++;
  const rentals = vacantRentals(eco).length;
  const gap = vac - unemployed;
  let arrivals = 0;
  if (gap > 0 && rentals > 1) arrivals = Math.min(rentals - 1, Math.ceil(gap * 0.5), 6);
  // empty flats and a decent job market attract newcomers
  else if (eco.market.unemployment < 0.08 && rentals > 2) arrivals = Math.min(3, Math.floor((rentals - 2) * 0.25 * (0.08 - eco.market.unemployment) / 0.08) + (eco.rng.chance(0.4) ? 1 : 0));
  for (let i = 0; i < arrivals; i++) arrive(eco);
  // cheap, empty flats draw retirees from elsewhere (they bring savings and a pension)
  const vr = eco.market.vacancyRate;
  if (arrivals === 0 && vr > 0.07 && rentals > 2 && eco.rng.chance(Math.min(0.9, (vr - 0.07) * 8))) arrive(eco, true);
  // the unemployed eventually move away to look for work elsewhere
  const slack = Math.max(0, eco.market.unemployment - 0.05);
  for (const h of eco.households) {
    if (h.departed || h.employed || h.retired || h.unemployedDays < 90) continue;
    const renter = !h.ownedUnits.length;
    const mortgaged = h.loans.some((l) => l.active && l.kind === 'mortgage');
    if (renter && !mortgaged && h.firms.length === 0 && eco.rng.chance(0.04 + 0.8 * slack)) departHousehold(eco, h, 'could not find work');
  }
}

export function createHousehold(eco: Economy, bank: Bank, arrived: number): Household {
  const rng = eco.rng;
  const skill = Math.max(0.6, Math.min(1.9, Math.exp(rng.normal() * 0.28)));
  const [lo, hi] = CFG.bufferRange;
  const h = new Household(
    eco.newId(),
    familyName(rng),
    skill,
    rng.range(CFG.mpcRange[0], CFG.mpcRange[1]),
    lo + (hi - lo) * Math.pow(rng.next(), 1.3) * (0.7 + 0.3 * skill),
    rng.chance(CFG.speculatorShare) ? 0.5 + 0.5 * rng.next() : 0.3 * rng.next(),
    rng.int(0, DAYS_PER_MONTH - 1),
    arrived,
  );
  h.acct = eco.openAccount(h.id, bank);
  h.wealthMonths = h.bufferMonths;
  eco.register(h);
  eco.households.push(h);
  return h;
}

function arrive(eco: Economy, retiree = false): void {
  const banks = eco.aliveBanks();
  if (!banks.length) return;
  const bank = eco.rng.weighted(banks, (b) => b.deposits * (1 - b.stress) + 1)!;
  const h = createHousehold(eco, bank, eco.day);
  if (!findRental(eco, h)) {
    // no home after all: they never arrive
    h.departed = true;
    return;
  }
  h.retired = retiree;
  const wage = eco.market.wageIndex;
  const savings = Math.min(eco.world.acct.balance, retiree ? wage * (8 + 16 * eco.rng.next()) : 3000 + 9000 * eco.rng.next());
  eco.ledger.transfer(eco.world.acct, h.acct, savings, 'transfer');
  h.income = retiree ? wage * CFG.pensionRatio : wage * (1 - CFG.taxRate) * 0.7;
  h.wealthMonths = retiree ? Math.max(4, savings / h.income) : h.wealthMonths;
  h.budget = CFG.essentials * eco.market.cpi;
  h.note(eco.day, retiree ? `Retired to ${eco.city.name}, drawn by affordable rents` : `Moved to ${eco.city.name} looking for work`, 'good', savings);
  eco.event('arrival', h.id);
  eco.monthCounters.arrivals++;
}

export function departHousehold(eco: Economy, h: Household, reason: string): void {
  if (h.departed) return;
  if (h.employed) fire(eco, h, 'moved away', true);
  if (h.fundUnits > 0) redeemFund(eco, h, h.fundUnits);
  const home = eco.units[h.homeUnit];
  if (home && home.occupantId === h.id) home.occupantId = -1;
  h.homeUnit = -1;
  for (const l of h.loans.slice()) if (l.active) defaultLoan(eco, l);
  // any property they still own is put up for sale by... nobody: keep as is, list it
  for (const uid of h.ownedUnits) {
    const u = eco.units[uid];
    if (!u.listing) listUnit(eco, u, h.id, marketAsk(eco, u) * 0.9, true);
  }
  h.lookingToBuy = null;
  if (h.acct.balance > 0) {
    // Genesis Mode: their savings leave the town's banks with them
    if (eco.genesis) eco.ledger.toOutside(h.acct, h.acct.balance, 'migrate', eco.world.id);
    else eco.ledger.transfer(h.acct, eco.world.acct, h.acct.balance, 'transfer');
  }
  h.departed = true;
  h.note(eco.day, `Left town: ${reason}`, 'bad');
  eco.event('departure', h.id, undefined, undefined, reason);
  eco.monthCounters.departures++;
}
