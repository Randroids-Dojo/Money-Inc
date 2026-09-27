// Builds the starting economy. Balance sheets are consistent by construction: households'
// and firms' deposits, the loan book and bank equity are chosen first, then each bank's
// securities and reserves are the balancing items, and the central bank's assets match
// the reserves it has issued.

import { CFG, SECTORS, DAYS_PER_MONTH } from './config';
import { Economy } from './economy';
import { generateCity, type Lot } from '../world/city';
import { Bank, type BankPersonality } from './bank';
import { CentralBank, DepositInsurer, Firm, Fund, OutsideWorld, Treasury, Unit, type Household } from './agents';
import type { Economy as EconomyT } from './economy';
import { Loan } from './loan';
import { FIRST_BANK_ORIGIN, ORIGIN_LEGACY } from './ledger';
import type { PolicySettings, Sector } from './types';
import { bankIdentities, firmName } from './names';
import { createHousehold, planBudget } from './households';
import { firmColor } from './firms';
import { bankStaffTarget, publicStaffTarget, pickFavourites } from './markets';
import { metrics, setStandards } from './banking';
import { fundBreakdown } from './fund';
import { createGenesisEconomy } from './genesis/setup';

export type Scenario = 'classic' | 'easy' | 'fragile' | 'tight' | 'genesis';

export interface GameOptions {
  seed: number;
  banks: number;
  scenario: Scenario;
}

export const SCENARIOS: Record<Scenario, { title: string; blurb: string }> = {
  classic: { title: 'Steady Town', blurb: 'A calm economy with sensible rules. Watch how booms and busts emerge on their own.' },
  easy: { title: 'Easy Money', blurb: 'Cheap credit, thin capital rules and hungry banks. How long can the party last?' },
  fragile: { title: 'No Safety Net', blurb: 'No deposit insurance and no lender of last resort. Bank runs are real.' },
  tight: { title: 'Prudent Regime', blurb: 'High capital and liquidity requirements. Safer banks — but slower growth?' },
  genesis: {
    title: 'Genesis',
    blurb: 'One bank, one would-be business, one worker — and not a dollar of bank money. Make the first loan and grow an economy you can trace back to it.',
  },
};

export function defaultPolicy(s: Scenario = 'classic'): PolicySettings {
  const p: PolicySettings = {
    policyRate: CFG.policyRate,
    capitalRequirement: CFG.capitalRequirement,
    liquidityRequirement: CFG.liquidityRequirement,
    depositInsurance: 'standard',
    emergencyLiquidity: 'standard',
    qePerMonth: 0,
    qeTarget: 'govt',
    autopilot: false,
  };
  if (s === 'easy') {
    p.policyRate = 0.01;
    p.capitalRequirement = 0.05;
    p.liquidityRequirement = 0.05;
  } else if (s === 'fragile') {
    p.depositInsurance = 'none';
    p.emergencyLiquidity = 'none';
    p.liquidityRequirement = 0.04;
  } else if (s === 'tight') {
    p.policyRate = 0.04;
    p.capitalRequirement = 0.12;
    p.liquidityRequirement = 0.2;
  }
  return p;
}

const PERSONALITIES: BankPersonality[] = [
  {
    riskAppetite: 0.2,
    capitalBuffer: 0.05,
    liquidityBuffer: 0.1,
    focus: { business: 0.45, mortgage: 0.45, consumer: 0.1 },
    securitize: 0.05,
    wholesale: 0.05,
    growth: 0.05,
    payout: 0.4,
    duration: 0.3,
    depositBeta: 0.45,
    blurb: 'Old money. Keeps thick capital and liquidity buffers and lends cautiously.',
  },
  {
    riskAppetite: 0.45,
    capitalBuffer: 0.03,
    liquidityBuffer: 0.05,
    focus: { business: 0.7, mortgage: 0.2, consumer: 0.1 },
    securitize: 0.15,
    wholesale: 0.3,
    growth: 0.09,
    payout: 0.5,
    duration: 0.55,
    depositBeta: 0.5,
    blurb: "The businessman's bank. Lends to local firms for expansion and working capital.",
  },
  {
    riskAppetite: 0.7,
    capitalBuffer: 0.015,
    liquidityBuffer: 0.02,
    focus: { business: 0.15, mortgage: 0.75, consumer: 0.1 },
    securitize: 0.9,
    wholesale: 0.5,
    growth: 0.18,
    payout: 0.6,
    duration: 0.4,
    depositBeta: 0.6,
    blurb: 'Originate-to-distribute: writes mortgages aggressively, packages them into MBS and sells them on.',
  },
  {
    riskAppetite: 0.8,
    capitalBuffer: 0.012,
    liquidityBuffer: 0.01,
    focus: { business: 0.35, mortgage: 0.35, consumer: 0.3 },
    securitize: 0.4,
    wholesale: 0.85,
    growth: 0.25,
    payout: 0.7,
    duration: 0.7,
    depositBeta: 0.75,
    blurb: 'Fast-growing and hungry. Funds itself with hot wholesale money and pays top rates for deposits.',
  },
  {
    riskAppetite: 0.5,
    capitalBuffer: 0.03,
    liquidityBuffer: 0.05,
    focus: { business: 0.4, mortgage: 0.45, consumer: 0.15 },
    securitize: 0.3,
    wholesale: 0.3,
    growth: 0.1,
    payout: 0.5,
    duration: 0.5,
    depositBeta: 0.5,
    blurb: 'A steady regional lender with a balanced book.',
  },
];

const FIRM_PLAN: { sector: Sector; subtype: string; big: boolean; workers: number }[] = [
  { sector: 'retail', subtype: 'grocery', big: false, workers: 3 },
  { sector: 'retail', subtype: 'grocery', big: false, workers: 3 },
  { sector: 'retail', subtype: 'clothing', big: false, workers: 3 },
  { sector: 'retail', subtype: 'electronics', big: false, workers: 3 },
  { sector: 'retail', subtype: 'hardware', big: false, workers: 3 },
  { sector: 'retail', subtype: 'furniture', big: false, workers: 3 },
  { sector: 'retail', subtype: 'pharmacy', big: false, workers: 3 },
  { sector: 'retail', subtype: 'bakery', big: false, workers: 3 },
  { sector: 'retail', subtype: 'books', big: false, workers: 2 },
  { sector: 'retail', subtype: 'supermarket', big: true, workers: 7 },
  { sector: 'service', subtype: 'diner', big: false, workers: 4 },
  { sector: 'service', subtype: 'cafe', big: false, workers: 3 },
  { sector: 'service', subtype: 'clinic', big: false, workers: 4 },
  { sector: 'service', subtype: 'cinema', big: false, workers: 4 },
  { sector: 'service', subtype: 'gym', big: false, workers: 3 },
  { sector: 'service', subtype: 'salon', big: false, workers: 3 },
  { sector: 'service', subtype: 'restaurant', big: false, workers: 4 },
  { sector: 'service', subtype: 'lawoffice', big: false, workers: 3 },
  { sector: 'service', subtype: 'diner', big: false, workers: 3 },
  { sector: 'service', subtype: 'cafe', big: false, workers: 3 },
  { sector: 'service', subtype: 'insurance', big: true, workers: 9 },
  { sector: 'service', subtype: 'tech', big: true, workers: 9 },
  { sector: 'service', subtype: 'agency', big: true, workers: 8 },
  { sector: 'factory', subtype: 'food', big: true, workers: 7 },
  { sector: 'factory', subtype: 'textiles', big: true, workers: 6 },
  { sector: 'factory', subtype: 'furniture', big: true, workers: 6 },
  { sector: 'factory', subtype: 'electronics', big: true, workers: 6 },
  { sector: 'factory', subtype: 'steel', big: true, workers: 6 },
  { sector: 'builder', subtype: 'builder', big: true, workers: 4 },
  { sector: 'builder', subtype: 'builder', big: true, workers: 4 },
  { sector: 'builder', subtype: 'builder', big: true, workers: 3 },
];

export function createEconomy(opts: GameOptions): Economy {
  if (opts.scenario === 'genesis') return createGenesisEconomy(opts.seed, defaultPolicy('classic'));
  const city = generateCity(opts.seed);
  const policy = defaultPolicy(opts.scenario);
  const eco = new Economy(opts.seed, city, policy);
  const rng = eco.rng;
  const lotBy = (r: Lot['reserved']) => city.lots.find((l) => l.reserved === r)!;

  // ---------------------------------------------------------------- public entities
  const cb = new CentralBank(eco.newId(), `Reserve Bank of ${city.name}`, lotBy('centralbank').id);
  eco.cb = cb;
  eco.cbId = cb.id;
  eco.register(cb);
  const t = new Treasury(eco.newId(), `${city.name} City Hall`, lotBy('cityhall').id);
  eco.treasury = t;
  eco.treasuryId = t.id;
  eco.register(t);
  const dif = new DepositInsurer(eco.newId(), 'Deposit Insurance Fund');
  eco.dif = dif;
  eco.difId = dif.id;
  eco.register(dif);
  eco.lotUse.set(cb.lotId, { type: 'cb', id: cb.id });
  eco.lotUse.set(t.lotId, { type: 'cityhall', id: t.id });

  // ---------------------------------------------------------------- banks
  const nBanks = Math.max(3, Math.min(5, opts.banks));
  eco.initialBankCount = nBanks;
  const idents = bankIdentities();
  const bankLots = city.lots.filter((l) => l.reserved === 'bank');
  const shares = [0.3, 0.26, 0.24, 0.2, 0.18];
  for (let i = 0; i < nBanks; i++) {
    const pers = { ...PERSONALITIES[i], focus: { ...PERSONALITIES[i].focus } };
    if (opts.scenario === 'easy') pers.riskAppetite = Math.min(0.95, pers.riskAppetite + 0.15);
    const b = new Bank(eco.newId(), idents[i].name, idents[i].short, idents[i].color, FIRST_BANK_ORIGIN + i, bankLots[i].id, pers, 0);
    b.fear = 0.22;
    b.depositRate = policy.policyRate * pers.depositBeta;
    eco.register(b);
    eco.banks.push(b);
    eco.lotUse.set(b.lotId, { type: 'bank', id: b.id });
  }
  const pickBank = (w?: (b: Bank) => number) => rng.weighted(eco.banks, (b) => shares[eco.banks.indexOf(b)] * (w ? w(b) : 1))!;

  const fund = new Fund(eco.newId(), 'Meridian Capital', lotBy('fund').id);
  fund.acct = eco.openAccount(fund.id, eco.banks[0]);
  eco.fund = fund;
  eco.register(fund);
  eco.lotUse.set(fund.lotId, { type: 'fund', id: fund.id });
  const world = new OutsideWorld(eco.newId(), 'The wider world');
  world.acct = eco.openAccount(world.id, eco.banks[1 % nBanks]);
  eco.world = world;
  eco.register(world);

  // ---------------------------------------------------------------- housing stock
  const targetUnits = Math.round(CFG.initialHouseholds * (1 + CFG.initialVacancy));
  const resLots = rng.shuffle(city.lots.filter((l) => l.zone === 'res'));
  let nUnits = 0;
  // fill roughly two thirds of residential land, leaving room to build
  for (const lot of resLots) {
    if (nUnits >= targetUnits) break;
    const isApt = lot.w >= 2;
    const n = isApt ? rng.int(6, 10) : 1;
    const q = 0.82 + 0.4 * rng.next();
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const u = new Unit(eco.units.length, lot.id, q * (0.95 + 0.1 * rng.next()), isApt ? CFG.aptUnitBaseValue : CFG.houseBaseValue, isApt ? CFG.aptBaseRent : CFG.houseBaseRent);
      u.rent = u.baseRent * u.quality;
      eco.units.push(u);
      ids.push(u.id);
    }
    nUnits += n;
    eco.lotUnits.set(lot.id, ids);
    eco.lotUse.set(lot.id, { type: 'res', id: lot.id });
  }

  // ---------------------------------------------------------------- households
  for (let i = 0; i < CFG.initialHouseholds; i++) createHousehold(eco, pickBank(), -1);
  const hhs = eco.households.slice().sort((a, b) => b.skill - a.skill);
  const units = rng.shuffle(eco.units.slice());
  const houses = units.filter((u) => city.lots[u.lotId].w === 1);
  const apts = units.filter((u) => city.lots[u.lotId].w > 1);
  // owner-occupiers: richer households more likely; the best-off get houses
  const owners: Household[] = [];
  for (const h of hhs) if (rng.chance(0.25 + 0.45 * Math.min(1, (h.skill - 0.6) / 1.0))) owners.push(h);
  const ownerSet = new Set(owners);
  const free: Unit[] = [];
  for (const h of owners) {
    const u = houses.length && (h.skill > 1.0 || !apts.length) ? houses.pop()! : apts.pop();
    if (!u) break;
    u.ownerId = h.id;
    u.occupantId = h.id;
    h.ownedUnits.push(u.id);
    h.homeUnit = u.id;
  }
  free.push(...houses, ...apts);
  // landlords: affluent owners, speculators first
  const landlordCands = owners.filter((h) => h.homeUnit >= 0).sort((a, b) => b.skill + b.speculator - (a.skill + a.speculator));
  const landlords = landlordCands.slice(0, Math.max(8, Math.round(free.length / 5)));
  free.forEach((u, i) => {
    const l = landlords[i % landlords.length];
    u.ownerId = l.id;
    l.ownedUnits.push(u.id);
  });
  // renters take the landlords' units
  const renters = eco.households.filter((h) => !ownerSet.has(h) || h.homeUnit < 0);
  const rentals = rng.shuffle(free.slice());
  for (const h of renters) {
    const u = rentals.pop();
    if (!u) break;
    u.occupantId = h.id;
    h.homeUnit = u.id;
  }
  // anyone left without a home did not really live here
  for (const h of eco.households) if (h.homeUnit < 0) h.departed = true;

  // ---------------------------------------------------------------- firms
  const comSmall = rng.shuffle(city.lots.filter((l) => l.zone === 'com' && l.w === 1));
  const comBig = rng.shuffle(city.lots.filter((l) => (l.zone === 'com' || (l.zone === 'civic' && !l.reserved)) && l.w >= 2));
  const indLots = rng.shuffle(city.lots.filter((l) => l.zone === 'ind'));
  const ownerPool = eco.households.filter((h) => !h.departed).sort((a, b) => b.skill - a.skill).slice(0, 70);
  const pendingWorkers: { f: Firm; n: number }[] = [];
  const residents = eco.households.filter((h) => !h.departed).length;
  const planned = FIRM_PLAN.reduce((s, p) => s + p.workers, 0);
  const firmJobs = residents * 0.94 - Math.round(residents * 0.075) - nBanks * 1.5;
  const scaleJobs = firmJobs / planned;
  for (const plan0 of FIRM_PLAN) {
    const plan = { ...plan0, workers: Math.max(2, Math.round(plan0.workers * scaleJobs + (rng.next() - 0.5))) };
    const sp = SECTORS[plan.sector];
    const lot = plan.sector === 'factory' || plan.sector === 'builder' ? indLots.pop() : plan.big ? comBig.pop() : comSmall.pop();
    if (!lot) continue;
    const owner = rng.pick(ownerPool.filter((h) => h.firms.length < 2));
    const f = new Firm(
      eco.newId(),
      firmName(rng, plan.sector, plan.subtype, city.name),
      plan.sector,
      plan.subtype,
      lot.id,
      owner.id,
      firmColor(rng),
      rng.int(0, DAYS_PER_MONTH - 1),
      rng.int(0, DAYS_PER_MONTH - 1),
      -rng.int(200, 4000),
    );
    f.acct = eco.openAccount(f.id, pickBank((b) => 0.5 + b.personality.focus.business));
    f.A = sp.A * (0.93 + 0.14 * rng.next());
    f.kappa = sp.kappa;
    f.K = plan.workers * sp.A * sp.kappa * (1.08 + 0.3 * rng.next());
    f.price = 1;
    f.wage = CFG.baseWage * (0.97 + 0.06 * rng.next());
    f.status = 'open';
    f.openedDay = -365;
    owner.firms.push(f.id);
    eco.register(f);
    eco.firms.push(f);
    eco.lotUse.set(lot.id, { type: 'firm', id: f.id });
    pendingWorkers.push({ f, n: plan.workers });
  }

  // ---------------------------------------------------------------- jobs
  const jobless = rng.shuffle(eco.households.filter((h) => !h.departed));
  const give = (employer: { id: number }, list: number[], wage: number) => {
    const h = jobless.pop();
    if (!h) return;
    h.employer = employer.id;
    h.wage = wage * h.skill;
    h.employedDays = rng.int(200, 3000);
    list.push(h.id);
  };
  for (const b of eco.banks) for (let i = 0; i < Math.max(1, bankStaffTarget(eco, b)); i++) give(b, b.employees, CFG.baseWage * 1.15);
  const pubN = publicStaffTarget(eco);
  for (let i = 0; i < pubN; i++) give(t, t.employees, CFG.baseWage);
  for (const { f, n } of pendingWorkers) for (let i = 0; i < n; i++) give(f, f.workers, f.wage);
  for (const h of jobless) h.unemployedDays = rng.int(10, 120);

  // ---------------------------------------------------------------- loans (history)
  const policyRate = policy.policyRate;
  for (const b of eco.banks) setStandards(eco, b);
  const lender = (kind: 'mortgage' | 'business' | 'consumer', own?: Bank) =>
    own && rng.chance(0.55) ? own : pickBank((b) => 0.2 + b.personality.focus[kind] * (0.5 + b.personality.riskAppetite));
  const addLoan = (bank: Bank, borrower: Household | Firm, kind: Loan['kind'], purpose: Loan['purpose'], bal: number, term: number, paid: number, coll: Loan['collateral']) => {
    const spread = bank.spreads[kind] + 0.002 * rng.next();
    const l = new Loan(eco.newId(), kind, purpose, bank.id, borrower.id, bal, spread, policyRate, term, true, -paid * DAYS_PER_MONTH, rng.int(0, DAYS_PER_MONTH - 1), coll);
    l.monthsPaid = paid;
    l.note(-paid * DAYS_PER_MONTH, `Originated by ${bank.name} before the story begins`, bal, bank.id);
    eco.loans.set(l.id, l);
    bank.loans.push(l);
    borrower.loans.push(l);
    return l;
  };
  for (const h of eco.households) {
    if (h.departed) continue;
    const firstLoans = h.loans.length;
    void firstLoans;
    for (const uid of h.ownedUnits) {
      const u = eco.units[uid];
      const home = u.occupantId === h.id;
      if (!rng.chance(home ? 0.62 : 0.45)) continue;
      const value = u.baseValue * u.quality;
      const ltv = home ? 0.25 + 0.5 * rng.next() : 0.3 + 0.35 * rng.next();
      const paid = rng.int(12, 180);
      const l = addLoan(lender('mortgage', h.acct.bank), h, 'mortgage', home ? 'home' : 'investment_property', value * ltv, CFG.mortgageTerm, paid, { kind: 'property', ref: uid, value });
      u.mortgage = l;
    }
    if (h.employed && rng.chance(0.18)) {
      addLoan(lender('consumer'), h, 'consumer', 'durables', h.wage * (0.5 + 1.5 * rng.next()), 36, rng.int(3, 24), { kind: 'none', value: 0 });
    }
  }
  for (const f of eco.firms) {
    if (!rng.chance(0.72)) continue;
    const bal = f.K * (0.15 + 0.3 * rng.next());
    const lb = lender('business', f.acct.bank);
    addLoan(lb, f, 'business', 'expansion', bal, 96, rng.int(6, 60), { kind: 'business', ref: f.id, value: f.K * 0.5 });
    if (rng.chance(0.7)) f.acct.bank = lb;
  }

  for (const h of eco.households) {
    const m = h.loans.find((l) => l.kind === 'mortgage');
    if (m && rng.chance(0.6)) h.acct.bank = eco.bank(m.originatorId)!;
  }

  // ---------------------------------------------------------------- incomes & deposits
  const benefit = CFG.baseWage * CFG.benefitRatio;
  for (const h of eco.households) {
    if (h.departed) continue;
    let inc = h.employed ? h.wage * (1 - CFG.taxRate) : benefit;
    for (const uid of h.ownedUnits) {
      const u = eco.units[uid];
      if (u.occupantId !== h.id && u.occupantId >= 0) inc += u.rent;
    }
    h.income = inc;
    const months = h.bufferMonths * (0.9 + 0.2 * rng.next());
    const bal = inc * months + (h.firms.length ? 10_000 : 0);
    setBalance(h.acct, bal);
  }
  for (const f of eco.firms) {
    const sp = SECTORS[f.sector];
    const cap = Math.min(f.laborCap, f.capitalCap);
    f.expDemand = cap * 0.86;
    f.inventory = f.sector === 'retail' || f.sector === 'factory' ? f.expDemand * 0.5 : 0;
    const wages = f.workers.reduce((s, id) => s + (eco.household(id)?.wage ?? 0), 0);
    const inputs = f.sector === 'retail' || f.sector === 'builder' ? f.expDemand * sp.inputShare : 0;
    f.last.units = f.expDemand;
    f.last.revenue = f.expDemand * f.price;
    f.last.wages = wages;
    f.last.inputs = inputs;
    f.last.maintenance = (f.K * CFG.depreciation) / 12;
    f.months.push({ ...f.last });
    setBalance(f.acct, (wages + inputs + f.debtService()) * 1.6);
  }
  setBalance(world.acct, 350_000);

  // ---------------------------------------------------------------- fund units (affluent households)
  const investors = eco.households.filter((h) => !h.departed && (h.skill > 1.1 || h.bufferMonths > 7 || h.ownedUnits.length > 1));
  let unitWeights = 0;
  const w = new Map<number, number>();
  for (const h of investors) {
    const x = h.income * 12 * (0.4 + 1.6 * rng.next()) * Math.max(0.5, h.skill);
    w.set(h.id, x);
    unitWeights += x;
  }

  // ---------------------------------------------------------------- deposits follow the loan books
  {
    const loansOf = (b: Bank) => b.loans.reduce((x, l) => x + l.balance, 0);
    const depOf = (b: Bank) => eco.households.reduce((x, h) => x + (h.acct.bank === b ? h.acct.balance : 0), 0) + eco.firms.reduce((x, f) => x + (f.acct.bank === b ? f.acct.balance : 0), 0);
    const totalLoans = eco.banks.reduce((x, b) => x + loansOf(b), 0);
    const totalDep = eco.banks.reduce((x, b) => x + depOf(b), 0);
    for (let pass = 0; pass < 200; pass++) {
      // most over-funded bank gives a depositor to the most under-funded one
      const gap = (b: Bank) => depOf(b) - (loansOf(b) / totalLoans) * totalDep;
      const rich = eco.banks.reduce((a, b) => (gap(b) > gap(a) ? b : a));
      const poor = eco.banks.reduce((a, b) => (gap(b) < gap(a) ? b : a));
      if (gap(rich) < 0.08 * totalDep / eco.banks.length) break;
      const movers = eco.households.filter((h) => h.acct.bank === rich && !h.loans.length && h.acct.balance < gap(rich));
      if (!movers.length) break;
      rng.pick(movers).acct.bank = poor;
    }
  }

  // ---------------------------------------------------------------- bank balance sheets
  const deposits = new Map<number, number>();
  const fundCashGuess = 0; // set below
  void fundCashGuess;
  for (const a of [...eco.households.map((h) => h.acct), ...eco.firms.map((f) => f.acct), world.acct]) {
    deposits.set(a.bank.id, (deposits.get(a.bank.id) ?? 0) + a.balance);
  }
  let totalRepos = 0;
  let totalBankBonds = 0;
  let totalEquity = 0;
  const reservesTotal: number[] = [];
  for (const b of eco.banks) {
    const pers = b.personality;
    let mort = 0,
      bus = 0,
      con = 0;
    for (const l of b.loans) {
      if (l.kind === 'mortgage') mort += l.balance;
      else if (l.kind === 'business') bus += l.balance;
      else con += l.balance;
    }
    const loans = mort + bus + con;
    const rwa = mort * 0.5 + bus + con;
    const dep = deposits.get(b.id) ?? 0;
    const equity = (policy.capitalRequirement + pers.capitalBuffer + 0.012) * rwa + 20_000;
    let wholesale = pers.wholesale * 0.06 * dep;
    let bonds = pers.wholesale > 0.5 ? 0.03 * dep : 0;
    const reserves = 0.035 * dep + 10_000;
    let sec = dep + wholesale + bonds + equity - loans - reserves;
    const minLiquid = (policy.liquidityRequirement + pers.liquidityBuffer + 0.02) * dep;
    if (sec + reserves < minLiquid) {
      // funding gap: flighty banks use short-term wholesale money, prudent ones term bonds
      const gap = minLiquid - (sec + reserves);
      wholesale += gap * pers.wholesale;
      bonds += gap * (1 - pers.wholesale);
      sec = minLiquid - reserves;
    }
    b.reserves = reserves;
    b.bills = sec * (1 - pers.duration);
    b.bondPar = sec * pers.duration;
    b.bondBook = b.bondPar;
    b.bondCoupon = 0.035;
    b.paidIn = equity;
    b.bondsIssued = bonds;
    b.bondsIssuedCoupon = policyRate + 0.015;
    if (wholesale > 0) {
      b.wholesale.push({ id: eco.newId(), lenderId: fund.id, lenderKind: 'fund', borrowerId: b.id, amount: wholesale, rate: policyRate + 0.004, maturity: rng.int(360, 900), started: -30 });
      fund.repos.push(b.wholesale[b.wholesale.length - 1]);
    }
    fund.bankBonds.set(b.id, bonds);
    totalRepos += wholesale;
    totalBankBonds += bonds;
    totalEquity += equity;
    reservesTotal.push(reserves);
    b.budget = loans * (pers.growth / 12 + 0.02) + 60_000;
  }
  // fund: cash is a deposit at bank 0, so it must be added to that bank's deposits and reserves
  const fundSecShare = 0.18;
  const fundCash = 0.07;
  const nonSec = totalRepos + totalBankBonds + totalEquity;
  const fundTotal = nonSec / (1 - fundSecShare - fundCash);
  const fundCashAmt = fundTotal * fundCash;
  setBalance(fund.acct, fundCashAmt);
  // the fund's deposit sits at bank 0 (liability) backed by extra reserves
  eco.banks[0].reserves += fundCashAmt;
  // recompute each bank's deposits from the accounts
  for (const b of eco.banks) b.deposits = 0;
  for (const a of [...eco.households.map((h) => h.acct), ...eco.firms.map((f) => f.acct), world.acct, fund.acct]) a.bank.deposits += a.balance;
  fund.bills = fundTotal * fundSecShare * 0.5;
  fund.bondPar = fundTotal * fundSecShare * 0.5;
  fund.bondBook = fund.bondPar;
  fund.bondCoupon = 0.035;
  // distribute fund units
  for (const h of investors) {
    const u = (w.get(h.id)! / unitWeights) * fundTotal;
    h.fundUnits = u;
  }
  fund.units = fundTotal;
  fund.nav = 1;
  fund.navHistory = [1, 1, 1];

  // ---------------------------------------------------------------- public balance sheets
  const tga = Math.max(150_000, eco.population() * 1500) * 2.5;
  const difBal = 0.006 * eco.broadMoney();
  eco.publicBalances.treasury = tga;
  eco.publicBalances.dif = difBal;
  let R = 0;
  for (const b of eco.banks) R += b.reserves;
  cb.bondPar = R + tga + difBal;
  cb.bondBook = cb.bondPar;
  cb.bondCoupon = 0.035;
  t.bills = eco.banks.reduce((s, b) => s + b.bills, 0) + fund.bills;
  t.bondPar = eco.banks.reduce((s, b) => s + b.bondPar, 0) + fund.bondPar + cb.bondPar;
  t.bondCoupon = 0.035;

  // ---------------------------------------------------------------- behaviour state
  const mk = eco.market;
  for (let i = 12; i >= 0; i--) {
    mk.cpiHistory.push(Math.pow(1.02, -i / 12));
    mk.hpiHistory.push(Math.pow(1.03, -i / 12));
  }
  mk.hpiExpect = 0.03;
  mk.unemployment = eco.unemploymentRate();
  mk.bondYield = policy.policyRate + 0.012;
  // everyone starts at their own wealth target
  for (const h of eco.households) {
    if (h.departed) continue;
    const inc = Math.max(h.income, CFG.essentials);
    h.wealthMonths = Math.max(1, (h.acct.balance + h.fundUnits * fund.nav) / inc);
  }
  for (const h of eco.households) {
    if (h.departed) continue;
    h.houseExpect = 0.03;
    h.lastReview = 0;
    h.budget = planBudget(eco, h);
    for (const s of ['retail', 'service'] as const) {
      h.favs[s] = pickFavourites(eco, h, s, eco.firms.filter((f) => f.status === 'open' && f.sector === s));
    }
  }
  // settle the circular flow: jobs -> incomes -> spending -> demand -> jobs
  settleWorkforce(eco);
  // beyond normal frictional unemployment, the jobless are retirees living on a pension
  // and their savings (the wealthiest of them first)
  {
    const residents = eco.households.filter((h) => !h.departed);
    const jobless = residents
      .filter((h) => !h.employed && h.firms.length === 0)
      .sort((a, b) => b.acct.balance + b.fundUnits - (a.acct.balance + a.fundUnits));
    let excess = residents.filter((h) => !h.employed).length - Math.round(residents.length * 0.045);
    for (const h of jobless) {
      if (excess-- <= 0) break;
      h.retired = true;
      h.income = CFG.baseWage * CFG.pensionRatio + rentIncome(eco, h);
      const inc = Math.max(h.income, CFG.essentials);
      h.wealthMonths = Math.max(1, (h.acct.balance + h.fundUnits * fund.nav) / inc);
    }
    for (const h of eco.households) if (!h.departed) h.budget = planBudget(eco, h);
  }
  // size expected demand to the households' actual spending plans
  const plannedSpend = eco.households.reduce((s, h) => s + (h.departed ? 0 : h.budget), 0);
  for (const sector of ['retail', 'service'] as const) {
    const fs = eco.firms.filter((f) => f.sector === sector);
    const cap = fs.reduce((s, f) => s + f.capacity, 0);
    const demand = plannedSpend * SECTORS[sector].demandShare;
    for (const f of fs) {
      f.expDemand = (demand * f.capacity) / Math.max(1, cap);
      f.last.units = f.expDemand;
      f.last.revenue = f.expDemand * f.price;
    }
  }
  // shelves and warehouses start at the stock levels firms aim for
  for (const f of eco.firms) {
    if (f.sector === 'retail') f.inventory = Math.max(f.expDemand, f.capacity * 0.5) * 0.5;
    else if (f.sector === 'factory') f.inventory = f.expDemand * 0.7;
  }
  for (const b of eco.banks) {
    setStandards(eco, b);
    const m = metrics(eco, b);
    b.history.push({ day: 0, assets: m.assets, equity: m.equity, deposits: m.deposits, loans: m.loansGross, capitalRatio: m.capitalRatio, liquidityRatio: m.liquidityRatio, npl: m.nplRatio, profit: 0, fear: b.fear });
  }
  fund.nav = fundBreakdown(eco).total / fund.units;
  // normal turnover: a handful of homes are already for sale
  for (const h of eco.households) {
    if (h.departed || !rng.chance(0.06)) continue;
    const u = eco.units[h.homeUnit];
    if (u && u.ownerId === h.id) {
      u.listing = { price: u.baseValue * u.quality * 1.02, since: -rng.int(0, 60), seller: h.id, distressed: false };
      h.movingUp = rng.chance(0.6);
    }
  }
  // a first line in every family's diary
  for (const h of eco.households) {
    if (h.departed) continue;
    const home = eco.units[h.homeUnit];
    const parts: string[] = [];
    if (h.retired) parts.push('Retired');
    else if (h.employed) parts.push(`Works at ${eco.nameOf(h.employer)}`);
    else parts.push('Looking for work');
    if (home && home.ownerId === h.id) {
      const m = home.mortgage && home.mortgage.active ? home.mortgage : null;
      parts.push(m ? `owns their home with a mortgage from ${eco.nameOf(m.originatorId)}` : 'owns their home outright');
    } else if (home) parts.push(`rents from ${eco.nameOf(home.ownerId)}`);
    if (h.ownedUnits.length > (home && home.ownerId === h.id ? 1 : 0)) parts.push('and lets out property');
    h.note(0, `${parts.join(', ')}.`, 'neutral', undefined, h.employed ? h.employer : undefined);
  }
  // origin: everything that exists at the start is "legacy" money
  for (const a of [...eco.households.map((h) => h.acct), ...eco.firms.map((f) => f.acct), world.acct, fund.acct]) {
    a.origin.fill(0);
    a.origin[ORIGIN_LEGACY] = a.balance;
  }
  eco.news.add(0, `Welcome to ${city.name}! ${eco.banks.length} banks, ${eco.firms.length} businesses and ${eco.population()} households call it home.`, 'good', cb.id);
  return eco;
}

/**
 * Resize firms' workforces to the demand that households' incomes generate, hiring from or
 * releasing to the pool of residents. Run a few times to reach a consistent starting point.
 */
function settleWorkforce(eco: EconomyT): void {
  // owners live off their firms' profits (paid out as dividends)
  const baseIncome = (h: Household) => (h.employed ? h.wage * (1 - CFG.taxRate) : CFG.baseWage * CFG.benefitRatio) + rentIncome(eco, h);
  for (const h of eco.households) if (!h.departed) h.income = baseIncome(h);
  for (const f of eco.firms) {
    const owner = eco.household(f.ownerId);
    if (!owner) continue;
    const sp = SECTORS[f.sector];
    const units = f.expDemand > 0 ? f.expDemand : f.capacity * 0.85;
    const wages = f.workers.reduce((x, id) => x + (eco.household(id)?.wage ?? 0), 0);
    const inputs = f.sector === 'retail' || f.sector === 'builder' ? units * sp.inputShare : 0;
    const profit = units * f.price - wages - inputs - (f.K * CFG.depreciation) / 12 - f.debtService() * 0.6;
    owner.income += Math.max(0, profit) * 0.85;
  }
  for (const h of eco.households) if (!h.departed) h.budget = planBudget(eco, h);
  const spend = eco.households.reduce((s, h) => s + (h.departed ? 0 : h.budget), 0);
  const retail = spend * SECTORS.retail.demandShare;
  const service = spend * SECTORS.service.demandShare * 1.08;
  let kTotal = 0;
  for (const f of eco.firms) kTotal += f.K;
  const maint = (kTotal * CFG.depreciation) / 12;
  const builder = maint * 0.5 + eco.units.length * CFG.houseBaseValue * CFG.renovationRate * 0.8;
  const factory = retail * SECTORS.retail.inputShare + maint * 0.5 + builder * SECTORS.builder.inputShare;
  const demand: Record<string, number> = { retail, service, factory, builder };
  const tied = (h: Household) => h.loans.length > 0 || h.ownedUnits.length > 0 || h.firms.length > 0;
  // people tied to the town (owners, borrowers) are hired first and let go last
  const pool = eco.households.filter((h) => !h.departed && !h.employed).sort((a, b) => Number(tied(b)) - Number(tied(a)));
  const rng = eco.rng;
  for (const sector of ['retail', 'service', 'factory', 'builder'] as const) {
    const fs = eco.firms.filter((f) => f.sector === sector);
    const cap = fs.reduce((x, f) => x + f.capitalCap, 0);
    for (const f of fs) {
      const d = (demand[sector] * f.capitalCap) / Math.max(1, cap);
      const want = Math.max(1, Math.round(Math.min(f.capitalCap * 1.5, d / CFG.targetUtilization) / f.A + 0.2));
      while (f.workers.length < want && pool.length) {
        const h = pool.shift()!;
        h.employer = f.id;
        h.wage = f.wage * h.skill;
        h.employedDays = rng.int(200, 3000);
        f.workers.push(h.id);
        h.income = h.wage * (1 - CFG.taxRate);
      }
      while (f.workers.length > want) {
        const idx = f.workers.findIndex((id) => !tied(eco.household(id)!));
        const hid = idx >= 0 ? f.workers.splice(idx, 1)[0] : f.workers.pop()!;
        const h = eco.household(hid)!;
        h.employer = -1;
        h.wage = 0;
        h.income = CFG.baseWage * CFG.benefitRatio;
        pool.push(h);
      }
      // make sure capital can support the workforce
      f.K = Math.max(f.K, f.workers.length * f.A * f.kappa * 1.08);
      f.expDemand = d;
    }
  }
}

function rentIncome(eco: EconomyT, h: Household): number {
  let r = 0;
  for (const uid of h.ownedUnits) {
    const u = eco.units[uid];
    if (u.occupantId >= 0 && u.occupantId !== h.id) r += u.rent;
  }
  return r;
}

function setBalance(a: { balance: number; bank: Bank }, bal: number): void {
  a.balance = Math.max(0, bal);
}
