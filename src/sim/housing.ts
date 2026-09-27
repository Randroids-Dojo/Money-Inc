// Housing market: listings, bidding, mortgage-financed purchases, foreclosures, rentals,
// and the house-price and rent indices that emerge from those trades.

import { CFG } from './config';
import type { Economy } from './economy';
import type { Household, Unit } from './agents';
import type { Account } from './ledger';
import { originate, payoffLoan, releaseFromBank, settleShortSale, requestLoan, unitValue, invalidateMetrics, type LoanApp } from './banking';
import { fmtMoney, pct } from './format';
import { departHousehold } from './households';
import { fundCashTarget } from './fund';


export function listUnit(eco: Economy, u: Unit, sellerId: number, price: number, distressed: boolean): void {
  const seller = eco.agents.get(sellerId);
  const forced = distressed || (seller && (seller.kind === 'bank' || seller.kind === 'firm'));
  // sellers who are not forced to sell hold out near their asking price
  const floor = price * (forced ? 0.7 : 0.94);
  u.listing = { price: Math.max(1000, price), since: eco.day, seller: sellerId, distressed, floor };
}

export function marketAsk(eco: Economy, u: Unit): number {
  return u.baseValue * u.quality * eco.market.hpi * (1.01 + Math.max(-0.05, Math.min(0.1, eco.market.hpiExpect)) * 0.25);
}

/** Can this unit be rented out to a newcomer? */
function rentable(eco: Economy, u: Unit): boolean {
  if (u.building || u.occupantId >= 0) return false;
  const owner = eco.agents.get(u.ownerId);
  if (!owner) return false;
  if (owner.kind === 'household') return !owner.departed;
  if (owner.kind === 'fund') return !u.listing;
  // (Genesis Mode: in a town short of homes, unsold new homes and repossessed ones are let while they wait for a
  // buyer, and employers let the cottages they built for their workers)
  if (eco.genesis && owner.kind === 'bank') return !!u.listing && eco.day - u.listing.since > 45;
  if (eco.genesis && owner.kind === 'firm' && !u.listing) return owner.status !== 'closed';
  // banks let tenants stay but do not sign new leases; builders may rent unsold stock
  return owner.kind === 'firm' && eco.day - (u.listing?.since ?? eco.day) > (eco.genesis ? 14 : 120);
}

export function vacantRentals(eco: Economy): Unit[] {
  return eco.units.filter((u) => rentable(eco, u));
}

/** Find a rental home for a household. Returns false if none is available. */
export function findRental(eco: Economy, h: Household): boolean {
  const income = Math.max(h.income, h.wage * (1 - CFG.taxRate), eco.market.wageIndex * CFG.benefitRatio);
  const opts = vacantRentals(eco);
  if (!opts.length) return false;
  const affordable = opts.filter((u) => u.rent <= income * 0.45);
  const pool = affordable.length ? affordable : opts;
  const u = pool.reduce((a, b) => (b.rent / b.quality < a.rent / a.quality ? b : a));
  moveIn(eco, h, u);
  return true;
}

function moveIn(eco: Economy, h: Household, u: Unit): void {
  if (h.homeUnit >= 0) {
    const old = eco.units[h.homeUnit];
    if (old && old.occupantId === h.id) old.occupantId = -1;
  }
  u.occupantId = h.id;
  h.homeUnit = u.id;
  h.lodging = false;
  if (u.rent <= 0) u.rent = u.baseRent * u.quality * eco.market.rentIndex;
  // regular shops are chosen near home
  h.favs.retail = [];
  h.favs.service = [];
}

/** After a foreclosure the family must leave the unit (tenants of an investor stay). */
export function foreclosureEviction(eco: Economy, borrower: Household, unitId: number): void {
  const u = eco.units[unitId];
  if (u.occupantId === borrower.id) {
    u.occupantId = -1;
    borrower.homeUnit = -1;
    borrower.note(eco.day, `Lost their home to foreclosure`, 'bad');
    if (!findRental(eco, borrower)) departHousehold(eco, borrower, 'could not find a home after foreclosure');
  }
}

// ============================================================================ weekly market

export function housingMarketWeek(eco: Economy): void {
  // stale listings get cheaper; sellers who are not forced to sell eventually give up
  for (const u of eco.units) {
    const l = u.listing;
    if (!l) continue;
    const weeks = (eco.day - l.since) / 7;
    const seller = eco.agents.get(l.seller);
    const eager = l.distressed || (seller && (seller.kind === 'bank' || seller.kind === 'firm'));
    if (!eager && weeks > 26) {
      u.listing = null;
      if (seller && seller.kind === 'household') {
        seller.movingUp = false;
        seller.note(eco.day, `Took their property off the market: no buyers at a fair price`, 'neutral');
      }
      continue;
    }
    const floor = l.floor ?? l.price * 0.8;
    if (weeks > 3 && l.price > floor) l.price = Math.max(floor, l.price * (eager ? 0.985 : 0.992));
  }
  const listed = eco.units.filter((u) => u.listing && !u.building && u.listing.pending === undefined);
  const buyers = eco.households.filter((h) => !h.departed && h.lookingToBuy && !h.buyPending);
  if (!listed.length || !buyers.length) {
    return;
  }
  eco.rng.shuffle(buyers);
  const interest = new Map<number, Household[]>();
  for (const h of buyers) {
    const home = h.lookingToBuy === 'home';
    const cands = listed.filter(
      (u) =>
        u.listing!.price <= h.buyBudget &&
        u.listing!.seller !== h.id &&
        (!home || u.occupantId < 0 || u.occupantId === u.listing!.seller || (!!eco.genesis && u.occupantId === h.id)),
    );
    if (!cands.length) continue;
    const pick = cands.reduce((a, b) => {
      const sa = (a.quality / a.listing!.price) * (0.85 + 0.3 * eco.rng.next());
      const sb = (b.quality / b.listing!.price) * (0.85 + 0.3 * eco.rng.next());
      return sb > sa ? b : a;
    });
    let arr = interest.get(pick.id);
    if (!arr) interest.set(pick.id, (arr = []));
    arr.push(h);
  }
  for (const [uid, bidders] of interest) {
    const u = eco.units[uid];
    if (!u.listing) continue;
    const n = bidders.length;
    bidders.sort((a, b) => b.buyBudget - a.buyBudget);
    // bidding wars push the price up, but lenders only finance up to the appraised value
    let price = u.listing.price * (1 + Math.min(0.08, 0.02 * (n - 1)));
    for (const w of bidders) {
      const p = Math.min(price, w.buyBudget);
      if (p < u.listing.price * 0.98) continue;
      if (executeSale(eco, u, w, p)) break;
      // Genesis Mode: an offer waiting on a mortgage decision takes the home off the market
      if (!u.listing || u.listing.pending !== undefined) break;
      price = u.listing.price;
    }
  }
  fundBuysHomes(eco);
  // buyers who have looked for too long give up
  for (const h of buyers) {
    if (h.lookingToBuy && eco.rng.chance(0.06)) {
      h.lookingToBuy = null;
    }
  }
}

function executeSale(eco: Economy, u: Unit, h: Household, price: number): boolean {
  const listing = u.listing!;
  const seller = eco.agents.get(listing.seller);
  if (!seller) return false;
  const investment = h.lookingToBuy === 'investment';
  const reserve = CFG.essentials * eco.market.cpi * 2;
  const cash = Math.max(0, h.acct.balance - reserve);
  let loanAmt = Math.max(0, price - cash * 0.95);
  loanAmt = Math.ceil(loanAmt / 1000) * 1000;
  if (h.acct.balance + loanAmt < price) return false;
  if (loanAmt > 5000) {
    const income = h.employed ? h.wage : 0;
    const rentIncome = investment ? u.baseRent * u.quality * eco.market.rentIndex * 0.75 : 0;
    const app: LoanApp = {
      borrower: h,
      kind: 'mortgage',
      purpose: investment ? 'investment_property' : 'home',
      amount: loanAmt,
      termMonths: CFG.mortgageTerm,
      amortizing: true,
      collateral: { kind: 'property', ref: u.id, value: price },
      income: income + rentIncome + (h.income - h.wage * (1 - CFG.taxRate)) * 0.5,
      existingDebtService: debtService(h),
      existingDebt: 0,
      what: `${investment ? 'buying an investment property' : 'buying a home'} (${fmtMoney(price)})`,
    };
    let sold = false;
    requestLoan(eco, app, { review: 'mortgage', context: { unit: u, price, sellerId: seller.id, investment } }, (d, fin) => {
      if (!d.offer) {
        h.note(eco.day, `Mortgage refused: ${d.reason}`, 'bad');
        h.lookingToBuy = null;
        eco.event('loan_denied', h.id, loanAmt, h.acct.bank.id, d.reason);
        return;
      }
      // (in Genesis Mode the decision may come later: the home must still be for sale and affordable)
      if (!u.listing || u.listing.seller !== seller.id || h.departed || h.acct.balance + fin.amount < price) return;
      const loan = originate(eco, d.offer, fin);
      u.mortgage = loan;
      loan.spend(seller.id, Math.min(price, fin.amount), 'property purchase');
      sold = completeSale(eco, u, h, seller, price, loan.id, investment);
    });
    return sold;
  }
  return completeSale(eco, u, h, seller, price, -1, investment);
}

function completeSale(
  eco: Economy,
  u: Unit,
  h: Household,
  seller: NonNullable<ReturnType<Economy['agents']['get']>>,
  price: number,
  loanId: number,
  investment: boolean,
): boolean {
  if (h.acct.balance < price) {
    // should not happen, but never let a sale overdraw
    return false;
  }
  settleWithSeller(eco, u, seller, h.acct, price, loanId);
  // --- ownership and occupancy
  if (seller.kind === 'household') {
    seller.ownedUnits = seller.ownedUnits.filter((x) => x !== u.id);
    seller.note(eco.day, `Sold ${u.occupantId === seller.id ? 'their home' : 'a property'} for ${fmtMoney(price)}`, 'neutral', price, h.id);
  }
  const prevOccupant = eco.household(u.occupantId);
  u.ownerId = h.id;
  u.listing = null;
  u.lastSale = { day: eco.day, price };
  h.ownedUnits.push(u.id);
  if (!investment) {
    if (prevOccupant && prevOccupant !== h) {
      u.occupantId = -1;
      prevOccupant.homeUnit = -1;
      if (!findRental(eco, prevOccupant)) departHousehold(eco, prevOccupant, 'had to move out and found nothing to rent');
    }
    moveIn(eco, h, u);
    h.note(eco.day, `Bought a home for ${fmtMoney(price)}${loanId >= 0 ? ` with a mortgage from ${eco.nameOf(eco.loans.get(loanId)!.originatorId)}` : ''}`, 'good', price, seller.id);
  } else {
    u.rent = u.baseRent * u.quality * eco.market.rentIndex;
    if (prevOccupant === (seller as unknown)) {
      // seller lived there: they move out
      u.occupantId = -1;
      if (prevOccupant) {
        prevOccupant.homeUnit = -1;
        if (!findRental(eco, prevOccupant)) departHousehold(eco, prevOccupant, 'sold their home and left town');
      }
    }
    h.note(eco.day, `Bought an investment property for ${fmtMoney(price)}`, 'neutral', price, seller.id);
  }
  h.lookingToBuy = null;
  eco.houseSaleRatios.push(price / (u.baseValue * u.quality));
  eco.monthCounters.houseSales++;
  eco.event('house_sold', h.id, price, seller.id);
  eco.genesis?.onHouseSold(u, h, seller.id, price, loanId);
  return true;
}

/** Pay the seller of a unit and settle any debt secured on it (mortgage, development loan, REO). */
function settleWithSeller(eco: Economy, u: Unit, seller: NonNullable<ReturnType<Economy['agents']['get']>>, buyer: Account, price: number, loanId: number): void {
  if (seller.kind === 'bank') {
    const paid = eco.ledger.payBank(buyer, seller, price, 'property', loanId >= 0 ? loanId : undefined);
    const carrying = seller.reo.get(u.id) ?? 0;
    seller.reo.delete(u.id);
    seller.pl.securitiesGains += paid - carrying;
    invalidateMetrics(seller);
    seller.log(eco.day, `Sold a foreclosed home for ${fmtMoney(paid)} (${paid >= carrying ? 'gain' : 'loss'} of ${fmtMoney(Math.abs(paid - carrying))})`, paid >= carrying ? 'neutral' : 'bad');
  } else if (seller.kind === 'household' || seller.kind === 'firm') {
    eco.ledger.transfer(buyer, seller.acct, price, 'property', loanId >= 0 ? loanId : undefined);
    // the seller's own mortgage on this unit is settled from the proceeds
    const old = seller.loans.find((l) => l.active && l.collateral.kind === 'property' && l.collateral.ref === u.id && l.id !== loanId);
    if (old) {
      if (seller.acct.balance >= old.balance) payoffLoan(eco, old, seller);
      else settleShortSale(eco, old, seller);
    }
    if (seller.kind === 'firm') {
      // developers repay their development loan as units sell
      const dev = seller.loans.find((l) => l.active && l.kind === 'development');
      if (dev) {
        const bank = eco.bank(dev.servicerId);
        if (bank && dev.holder.kind === 'bank') {
          const amt = Math.min(dev.balance, price * 0.9, seller.acct.balance);
          const paid = eco.ledger.payBank(seller.acct, bank, amt, 'principal', dev.id);
          dev.balance -= paid;
          dev.principalPaid += paid;
          bank.destroyedCum += paid;
          invalidateMetrics(bank);
          dev.note(eco.day, `Home sold for ${fmtMoney(price)}: ${fmtMoney(paid)} repaid`, paid, buyer.ownerId, 'good');
          if (dev.balance < 1) {
            dev.balance = 0;
            dev.status = 'repaid';
            dev.closedDay = eco.day;
            releaseFromBank(eco, dev);
            dev.note(eco.day, `Development loan repaid in full`, undefined, undefined, 'good');
            seller.loans = seller.loans.filter((x) => x !== dev);
          }
        }
      }
      seller.m.revenue += price;
      seller.m.units += 0;
    }
  }
  if (seller.kind === 'fund') {
    eco.ledger.transfer(buyer, seller.acct, price, 'property', loanId >= 0 ? loanId : undefined);
    eco.fund.propertyGains += price - (eco.fund.homeCost.get(u.id) ?? price);
    eco.fund.homeCost.delete(u.id);
  }
}

/** House-price index that rents justify at today's interest rates (an anchor, not a forecast). */
export function fundamentalHpi(eco: Economy): number {
  const y = eco.market.bondYield + 0.045;
  return (CFG.houseBaseRent * 12 * eco.market.rentIndex) / y / CFG.houseBaseValue;
}

/** Gross rental yield the fund demands before it buys homes to let (rises with its fear). */
export function fundRequiredYield(eco: Economy): number {
  return eco.market.bondYield + 0.025 + 0.035 * eco.fund.fear;
}

/**
 * Meridian Capital buys homes whose asking price makes them cheap relative to the rent they
 * earn — a floor under house prices in a slump — and lets them out.
 */
function fundBuysHomes(eco: Economy): void {
  const f = eco.fund;
  if (f.fear > 0.85) return;
  const owned = eco.units.filter((u) => u.ownerId === f.id).length;
  if (owned >= Math.max(4, eco.units.length * 0.18)) return;
  const need = fundRequiredYield(eco);
  let bought = 0;
  const cands = eco.units
    .filter((u) => u.listing && !u.building && u.listing.seller !== f.id && u.listing.pending === undefined)
    .map((u) => ({ u, y: (u.baseRent * u.quality * eco.market.rentIndex * 12) / u.listing!.price }))
    .filter((c) => c.y >= need)
    .sort((a, b) => b.y - a.y);
  // set cash aside for the bargains on offer (the fund sells bills to raise it)
  f.homeBudget = cands.slice(0, 3).reduce((s, c) => s + c.u.listing!.price, 0);
  let spare = f.acct.balance - (fundCashTarget(eco) - f.homeBudget) * 1.1;
  for (const { u } of cands) {
    if (bought >= 3) break;
    const price = u.listing!.price;
    if (spare < price) break;
    const seller = eco.agents.get(u.listing!.seller);
    if (!seller) continue;
    settleWithSeller(eco, u, seller, f.acct, price, -1);
    if (seller.kind === 'household') {
      seller.ownedUnits = seller.ownedUnits.filter((x) => x !== u.id);
      seller.note(eco.day, `Sold ${u.occupantId === seller.id ? 'their home' : 'a property'} to ${f.name} for ${fmtMoney(price)}`, 'neutral', price, f.id);
    }
    const prev = eco.household(u.occupantId);
    u.ownerId = f.id;
    u.listing = null;
    u.lastSale = { day: eco.day, price };
    u.rent = u.baseRent * u.quality * eco.market.rentIndex;
    f.homeCost.set(u.id, price);
    if (prev && prev.id === seller.id) {
      // the seller lived there: they move out
      u.occupantId = -1;
      prev.homeUnit = -1;
      if (!findRental(eco, prev)) departHousehold(eco, prev, 'sold their home and left town');
    }
    eco.houseSaleRatios.push(price / (u.baseValue * u.quality));
    eco.monthCounters.houseSales++;
    eco.event('house_sold', f.id, price, seller.id);
    spare -= price;
    bought++;
  }
  if (bought > 0)
    eco.headline(`${f.name} snaps up ${bought} cheap home${bought > 1 ? 's' : ''} to rent out`, 'neutral', f.id, undefined, 'fund-homes', 60);
}

/** When house prices run well ahead of rents the fund sells its rentals. */
export function fundSellsHomes(eco: Economy): void {
  const f = eco.fund;
  const need = fundRequiredYield(eco);
  const short = f.acct.balance < fundCashTarget(eco) * 0.5;
  let listed = 0;
  for (const u of eco.units) {
    if (u.ownerId !== f.id || u.listing || listed >= 2) continue;
    const y = (u.rent * 12) / Math.max(1, unitValue(eco, u.id));
    if (y < need - 0.015 || (short && eco.rng.chance(0.3))) {
      listUnit(eco, u, f.id, marketAsk(eco, u), false);
      listed++;
    }
  }
}

export function debtService(h: Household): number {
  let s = 0;
  for (const l of h.loans) if (l.active) s += l.scheduledPayment();
  return s;
}

// ============================================================================ monthly

export function housingMonthly(eco: Economy): void {
  const m = eco.market;
  // house prices follow transactions; with no sales, stale listings drag them down
  // excess demand or supply in the market this month
  let listings = 0,
    distressed = 0;
  for (const u of eco.units) {
    if (!u.listing || u.building) continue;
    listings++;
    const seller = eco.agents.get(u.listing.seller);
    if (u.listing.distressed || (seller && seller.kind === 'bank')) distressed++;
  }
  const buyers = eco.households.filter((h) => !h.departed && h.lookingToBuy).length;
  let move = 0;
  if (eco.houseSaleRatios.length >= 1) {
    const s = eco.houseSaleRatios.slice().sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    move = (0.15 + 0.1 * Math.min(3, s.length)) * (med / m.hpi - 1);
  }
  // unmet buyers push the index up; unsold stock that sellers keep marking down pulls it down
  if (buyers > listings) move += 0.004 * Math.min(1, (buyers - listings) / 10);
  else if (eco.houseSaleRatios.length < 2 && listings > buyers && listings >= 3) {
    const asks: number[] = [];
    for (const u of eco.units) if (u.listing && !u.building && eco.day - u.listing.since > 42) asks.push(u.listing.price / (u.baseValue * u.quality));
    if (asks.length >= 2) {
      asks.sort((a, b) => a - b);
      const signal = asks[Math.floor(asks.length / 2)] * 0.98;
      move += Math.max(-0.004, 0.15 * (signal / m.hpi - 1));
    }
  }
  void distressed;
  m.hpi *= 1 + Math.max(-0.01, Math.min(0.015, move));
  eco.houseSaleRatios.length = 0;
  m.hpi = Math.max(0.2, m.hpi);
  m.hpiHistory.push(m.hpi);
  if (m.hpiHistory.length > 1200) m.hpiHistory.shift();
  // expectations extrapolate recent price moves, pulled toward what rents say homes are worth
  const n = m.hpiHistory.length;
  const g12 = n > 12 ? m.hpiHistory[n - 1] / m.hpiHistory[n - 13] - 1 : 0.02;
  const g3 = n > 3 ? (m.hpiHistory[n - 1] / m.hpiHistory[n - 4]) ** 4 - 1 : 0.02;
  const valueGap = Math.max(-0.3, Math.min(0.3, fundamentalHpi(eco) / m.hpi - 1));
  m.hpiExpect += 0.2 * (0.6 * g12 + 0.4 * g3 + 0.25 * valueGap - m.hpiExpect);

  // rents follow vacancies among rental units
  let rentals = 0,
    vacant = 0;
  for (const u of eco.units) {
    if (u.building || u.listing) continue;
    const owner = eco.agents.get(u.ownerId);
    const isRental = owner && owner.kind === 'household' ? u.occupantId !== owner.id : !!owner && owner.kind === 'fund';
    if (isRental) {
      rentals++;
      if (u.occupantId < 0) vacant++;
    }
  }
  const vr = rentals > 0 ? vacant / rentals : 0.05;
  m.vacancyRate = vr;
  // rents are sticky: they drift with wages and move a little with vacancies
  const wageDrift = m.wageIndex / Math.max(1, m.lastWageIndex || m.wageIndex) - 1;
  m.lastWageIndex = m.wageIndex;
  m.rentIndex *= 1 + Math.max(-0.006, Math.min(0.008, 0.05 * (0.05 - vr) + 0.7 * wageDrift));
  for (const u of eco.units) {
    const target = u.baseRent * u.quality * m.rentIndex;
    u.rent = u.rent <= 0 ? target : u.rent + 0.1 * (target - u.rent);
  }

  fundSellsHomes(eco);
  // banks list foreclosed homes; the longer they sit, the cheaper
  for (const b of eco.banks) {
    if (!b.alive) continue;
    for (const [uid] of b.reo) {
      const u = eco.units[uid];
      if (!u.listing) listUnit(eco, u, b.id, unitValue(eco, uid) * 0.92, true);
    }
  }
}

export { pct };
