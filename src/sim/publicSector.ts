// Public sector: the Treasury (City Hall) collects taxes, pays public wages, unemployment
// benefits and interest, and finances itself with bills. The Reserve Bank sets the policy
// rate (or follows a rule on autopilot) and conducts asset purchases.

import { CFG, DAYS_PER_MONTH } from './config';
import type { Economy } from './economy';
import { addBonds, growth, invalidateMetrics } from './banking';
import { bondPrice } from './markets';
import { fmtMoney, pct } from './format';
import type { Household } from './agents';

export function publicDaily(eco: Economy, dom: number): void {
  if (eco.genesis) {
    genesisPublicDaily(eco, dom);
    return;
  }
  if (dom === 0) payBenefits(eco);
  if (dom === 10) publicPayroll(eco);
  if (dom % 5 === 2) procurement(eco);
  treasuryFinancing(eco);
}

/**
 * Genesis Mode: the new town's council spends only what it has collected in taxes. It pays
 * benefits and its few staff first, then buys services and repairs locally — or from
 * contractors across the river while the town has no builder of its own.
 */
function genesisPublicDaily(eco: Economy, dom: number): void {
  const t = eco.treasury;
  const pb = eco.publicBalances;
  const cap = (x: number) => Math.max(0, Math.min(x, pb.treasury));
  if (dom === 0) {
    const benefit = eco.market.wageIndex * CFG.benefitRatio;
    const pension = eco.market.wageIndex * CFG.pensionRatio;
    const due: [Household, number][] = [];
    let total = 0;
    for (const h of eco.households) {
      if (h.departed || h.employed || h.homeUnit < 0 || h.firms.length > 0) continue;
      const amt = h.retired ? pension : benefit;
      due.push([h, amt]);
      total += amt;
    }
    const k = total > 0 ? cap(total) / total : 0;
    for (const [h, amt] of due) {
      const x = amt * k;
      if (x < 1) continue;
      eco.ledger.publicPay('treasury', h.acct, x, 'benefit');
      h.incomeThisMonth += x;
      t.benefitsMonth += x;
      t.spendMonth += x;
    }
  }
  if (dom === 10) {
    for (const hid of t.employees) {
      const h = eco.household(hid);
      if (!h) continue;
      const net = cap(h.wage * (1 - CFG.taxRate));
      if (net <= 0) break;
      eco.ledger.publicPay('treasury', h.acct, net, 'wage');
      h.incomeThisMonth += net;
      h.wagesThisMonth += h.wage;
      t.spendMonth += net;
      eco.monthCounters.governmentSpend += h.wage;
    }
  }
  if (dom % 5 === 2) {
    let wages = 0;
    for (const hid of t.employees) wages += eco.household(hid)?.wage ?? 0;
    const reserve = (wages + t.benefitsMonth) * 1.5;
    const monthly = Math.max(0, t.taxSmoothed - wages * (1 - CFG.taxRate) - t.benefitsMonth) + CFG.surplusRecycling * Math.max(0, pb.treasury - reserve);
    let budget = cap(monthly / 6);
    const services = eco.firms.filter((f) => f.status === 'open' && f.sector === 'service');
    const builders = eco.firms.filter((f) => f.status === 'open' && f.sector === 'builder');
    const buy = (f: (typeof services)[number], dollars: number) => {
      const units = Math.min(dollars / f.price, Math.max(0, f.capacity * 1.1 - f.m.units));
      const amt = cap(units * f.price);
      if (amt <= 0) return 0;
      eco.ledger.publicPay('treasury', f.acct, amt, 'invest');
      f.m.units += amt / f.price;
      f.m.revenue += amt;
      t.spendMonth += amt;
      eco.monthCounters.governmentSpend += amt;
      return amt;
    };
    if (builders.length) {
      const share = (budget * 0.35) / builders.length;
      for (const b of builders) budget -= buy(b, share);
    }
    if (services.length) {
      const share = budget / services.length;
      for (const s of services) budget -= buy(s, share);
    }
    if (!builders.length && budget > 1) {
      // public works by contractors from across the river: the money leaves town
      const amt = cap(budget * 0.35);
      pb.treasury -= amt;
      t.spendMonth += amt;
      eco.monthCounters.governmentSpend += amt;
      eco.recordFlow(t.id, eco.world.id, amt, 'import');
      if (eco.genesis) eco.genesis.trade.outsideBuild += amt;
    }
  }
  // an overdraft (only after a bail-out) is covered by the Reserve Bank
  if (pb.treasury < 0) {
    const need = -pb.treasury;
    eco.cb.bills += need;
    pb.treasury += need;
    t.bills += need;
  }
}

/**
 * City Hall buys services and repair work from local firms. The budget follows a simple
 * fiscal rule: spend smoothed tax revenue, minus what public wages, interest and "normal"
 * unemployment benefits already cost. The budget is therefore balanced over the cycle,
 * while benefits act as an automatic stabiliser in downturns.
 */
function procurement(eco: Economy): void {
  const t = eco.treasury;
  let retirees = 0;
  for (const h of eco.households) if (!h.departed && h.retired) retirees++;
  const benefitNormal =
    eco.market.wageIndex * CFG.benefitRatio * eco.population() * CFG.naturalUnemployment + eco.market.wageIndex * CFG.pensionRatio * retirees;
  let wages = 0;
  for (const hid of t.employees) wages += eco.household(hid)?.wage ?? 0;
  const floor = treasuryFloor(eco);
  const spare = Math.max(0, eco.publicBalances.treasury - floor * 3);
  const gdp = eco.stats.length ? eco.stats.last('gdp') : eco.population() * 5000;
  const cyclical = CFG.stabiliser * Math.max(0, eco.market.unemployment - CFG.naturalUnemployment) * gdp;
  const monthly =
    Math.max(0, t.taxSmoothed - wages * (1 - CFG.taxRate) - t.interestSmoothed - benefitNormal) +
    CFG.structuralDeficit * gdp +
    CFG.surplusRecycling * spare +
    cyclical;
  t.procurementLast = monthly;
  let budget = monthly / 6;
  const services = eco.firms.filter((f) => f.status === 'open' && f.sector === 'service');
  const builders = eco.firms.filter((f) => f.status === 'open' && f.sector === 'builder');
  const buy = (f: (typeof services)[number], dollars: number) => {
    const units = Math.min(dollars / f.price, Math.max(0, f.capacity * 1.1 - f.m.units));
    const amt = units * f.price;
    if (amt <= 0) return 0;
    eco.ledger.publicPay('treasury', f.acct, amt, 'invest');
    f.m.units += units;
    f.m.revenue += amt;
    t.spendMonth += amt;
    eco.monthCounters.governmentSpend += amt;
    return amt;
  };
  if (builders.length) {
    const share = (budget * 0.35) / builders.length;
    for (const b of builders) budget -= buy(b, share);
  }
  if (services.length) {
    const share = budget / services.length;
    for (const s of services) buy(s, share);
  }
}

function payBenefits(eco: Economy): void {
  const t = eco.treasury;
  const benefit = eco.market.wageIndex * CFG.benefitRatio;
  const pension = eco.market.wageIndex * CFG.pensionRatio;
  for (const h of eco.households) {
    if (h.departed || h.employed || h.homeUnit < 0) continue;
    const amt = h.retired ? pension : benefit;
    eco.ledger.publicPay('treasury', h.acct, amt, 'benefit');
    h.incomeThisMonth += amt;
    t.benefitsMonth += amt;
    t.spendMonth += amt;
  }
}

function publicPayroll(eco: Economy): void {
  const t = eco.treasury;
  for (const hid of t.employees) {
    const h = eco.household(hid);
    if (!h) continue;
    const gross = h.wage;
    const net = gross * (1 - CFG.taxRate);
    eco.ledger.publicPay('treasury', h.acct, net, 'wage');
    h.incomeThisMonth += net;
    h.wagesThisMonth += gross;
    t.spendMonth += net;
    eco.monthCounters.governmentSpend += gross;
  }
}

function treasuryFloor(eco: Economy): number {
  return Math.max(150_000, eco.population() * 1500);
}

/** Keep the Treasury's account topped up by selling bills; redeem bills when flush. */
function treasuryFinancing(eco: Economy): void {
  const t = eco.treasury;
  const pb = eco.publicBalances;
  const floor = treasuryFloor(eco);
  if (pb.treasury < floor) {
    let need = floor * 2 - pb.treasury;
    // banks with spare reserves buy first
    for (const b of eco.aliveBanks()) {
      if (need <= 0) break;
      const spare = b.reserves - (0.04 + b.personality.liquidityBuffer * 0.3) * b.deposits;
      if (spare <= 10_000) continue;
      const amt = Math.min(need, spare * 0.7);
      eco.ledger.bankToPublic(b, 'treasury', amt, 'assetsale');
      b.bills += amt;
      t.bills += amt;
      need -= amt;
      invalidateMetrics(b);
    }
    // then the fund
    const f = eco.fund;
    const fSpare = f.acct.balance - 0.05 * f.nav * f.units;
    if (need > 0 && fSpare > 10_000) {
      const amt = Math.min(need, fSpare * 0.6);
      eco.ledger.payPublic(f.acct, 'treasury', amt, 'assetsale');
      f.bills += amt;
      t.bills += amt;
      need -= amt;
    }
    // the rest is bought by the central bank (monetary financing)
    if (need > 0) {
      eco.cb.bills += need;
      pb.treasury += need;
      t.bills += need;
    }
  } else if (pb.treasury > floor * 4 && t.bills > 0) {
    let amt = Math.min(pb.treasury - floor * 2, t.bills);
    // redeem the central bank's bills first, then banks', then the fund's
    const fromCb = Math.min(amt, eco.cb.bills);
    eco.cb.bills -= fromCb;
    pb.treasury -= fromCb;
    t.bills -= fromCb;
    amt -= fromCb;
    for (const b of eco.banks) {
      if (amt <= 0) break;
      const x = Math.min(amt, b.bills);
      if (x <= 0) continue;
      eco.ledger.publicToBank('treasury', b, x, 'assetsale');
      b.bills -= x;
      t.bills -= x;
      amt -= x;
      invalidateMetrics(b);
    }
    if (amt > 0 && eco.fund.bills > 0) {
      const x = Math.min(amt, eco.fund.bills);
      eco.ledger.publicPay('treasury', eco.fund.acct, x, 'assetsale');
      eco.fund.bills -= x;
      t.bills -= x;
    }
  }
}

export function treasuryMonthly(eco: Economy): void {
  const t = eco.treasury;
  const billR = eco.market.billRate / 12;
  let interest = 0;
  // coupons on bills and bonds, to every holder
  for (const b of eco.banks) {
    if (!b.alive) continue;
    const c = b.bills * billR + (b.bondPar * b.bondCoupon) / 12;
    if (c <= 0) continue;
    eco.ledger.publicToBank('treasury', b, c, 'coupon');
    b.pl.interestIncome += c;
    interest += c;
  }
  const f = eco.fund;
  const fc = f.bills * billR + (f.bondPar * f.bondCoupon) / 12;
  if (fc > 0) {
    eco.ledger.publicPay('treasury', f.acct, fc, 'coupon');
    f.incomeMonth += fc;
    interest += fc;
  }
  const cbc = eco.cb.bills * billR + (eco.cb.bondPar * eco.cb.bondCoupon) / 12;
  if (cbc > 0) {
    eco.publicBalances.treasury -= cbc;
    eco.cb.retained += cbc;
    interest += cbc;
  }
  // the central bank hands its profits back to the Treasury
  if (eco.cb.retained > 0) {
    eco.publicBalances.treasury += eco.cb.retained;
    t.spendMonth -= 0;
    eco.cb.retained = 0;
  }
  t.interestMonth = interest;
  t.taxSmoothed = t.taxSmoothed <= 0 ? t.taxesMonth : 0.85 * t.taxSmoothed + 0.15 * t.taxesMonth;
  t.interestSmoothed = 0.85 * t.interestSmoothed + 0.15 * interest;
  const deficit = t.spendMonth + interest - t.taxesMonth;
  t.deficitHistory.push(deficit);
  if (t.deficitHistory.length > 600) t.deficitHistory.shift();
  t.taxesMonth = 0;
  t.spendMonth = 0;
  t.benefitsMonth = 0;
  // deposit insurer repays the Treasury when it can
  const dif = eco.dif;
  if (dif.borrowedFromTreasury > 0 && eco.publicBalances.dif > 200_000) {
    const x = Math.min(dif.borrowedFromTreasury, eco.publicBalances.dif - 200_000);
    eco.publicBalances.dif -= x;
    eco.publicBalances.treasury += x;
    dif.borrowedFromTreasury -= x;
  }
}

// ============================================================================ Reserve Bank

export function cbDaily(eco: Economy): void {
  const q = eco.policy.qePerMonth / DAYS_PER_MONTH;
  if (q > 0) buyAssets(eco, q);
  else if (q < 0) sellAssets(eco, -q);
}

function buyAssets(eco: Economy, amount: number): void {
  const cb = eco.cb;
  const y = eco.market.bondYield;
  const mbsShare = eco.policy.qeTarget === 'govt_mbs' ? 0.5 : 0;
  let bondBudget = amount * (1 - mbsShare);
  // government bonds from banks and the fund, in proportion to holdings
  const holders: { kind: 'bank' | 'fund'; h: { bondPar: number; bondBook: number; bondCoupon: number }; id: number }[] = [];
  for (const b of eco.aliveBanks()) if (b.bondPar > 1000) holders.push({ kind: 'bank', h: b, id: b.id });
  if (eco.fund.bondPar > 1000) holders.push({ kind: 'fund', h: eco.fund, id: eco.fund.id });
  const totalPar = holders.reduce((s, x) => s + x.h.bondPar, 0);
  if (totalPar > 0) {
    for (const x of holders) {
      const price = bondPrice(x.h.bondCoupon, y) * 1.002;
      const cost = Math.min(bondBudget * (x.h.bondPar / totalPar), x.h.bondPar * price);
      const par = cost / price;
      const bookPer = x.h.bondPar > 0 ? x.h.bondBook / x.h.bondPar : 1;
      if (x.kind === 'bank') {
        const b = eco.bank(x.id)!;
        eco.ledger.publicToBank('cb', b, cost, 'cb');
        b.pl.securitiesGains += cost - par * bookPer;
        invalidateMetrics(b);
      } else {
        eco.ledger.publicPay('cb', eco.fund.acct, cost, 'cb');
      }
      x.h.bondBook -= par * bookPer;
      x.h.bondPar -= par;
      addBonds(cb, par, cost, x.h.bondCoupon);
      cb.qeCum += cost;
    }
  } else bondBudget = 0;
  if (mbsShare > 0) {
    let budget = amount * mbsShare;
    for (const pool of eco.pools.values()) {
      if (budget <= 0 || pool.balance <= 0) continue;
      const price = pool.price * 1.005;
      // buy from the fund first, then banks
      const fh = eco.fund.mbs.get(pool.id);
      if (fh && fh.frac > 0.001) {
        const par = Math.min(fh.frac * pool.balance, budget / price);
        const frac = par / pool.balance;
        eco.ledger.publicPay('cb', eco.fund.acct, par * price, 'cb');
        fh.frac -= frac;
        addMbs(cb.mbs, pool.id, frac, price);
        budget -= par * price;
        cb.qeCum += par * price;
      }
      for (const b of eco.aliveBanks()) {
        if (budget <= 0) break;
        const h = b.mbs.get(pool.id);
        if (!h || h.frac <= 0.001) continue;
        const par = Math.min(h.frac * pool.balance, budget / price);
        const frac = par / pool.balance;
        eco.ledger.publicToBank('cb', b, par * price, 'cb');
        b.pl.securitiesGains += par * (price - h.bookRatio);
        h.frac -= frac;
        addMbs(cb.mbs, pool.id, frac, price);
        budget -= par * price;
        cb.qeCum += par * price;
        invalidateMetrics(b);
      }
      pool.price = Math.min(1.06, pool.price * 1.002);
    }
  }
}

function addMbs(map: Map<number, { frac: number; bookRatio: number }>, pid: number, frac: number, price: number): void {
  const e = map.get(pid);
  if (e) {
    const nf = e.frac + frac;
    e.bookRatio = (e.bookRatio * e.frac + price * frac) / nf;
    e.frac = nf;
  } else map.set(pid, { frac, bookRatio: price });
}

/** Quantitative tightening: the central bank sells bonds back to banks and the fund. */
function sellAssets(eco: Economy, amount: number): void {
  const cb = eco.cb;
  if (cb.bondPar <= 1000) return;
  const price = bondPrice(cb.bondCoupon, eco.market.bondYield) * 0.998;
  let left = Math.min(amount, cb.bondPar * price);
  const bookPer = cb.bondBook / cb.bondPar;
  for (const b of eco.aliveBanks()) {
    if (left <= 0) break;
    const spare = b.reserves - 0.05 * b.deposits;
    if (spare <= 0) continue;
    const cost = Math.min(left, spare * 0.5);
    const par = cost / price;
    eco.ledger.bankToPublic(b, 'cb', cost, 'cb');
    addBonds(b, par, cost, cb.bondCoupon);
    cb.bondPar -= par;
    cb.bondBook -= par * bookPer;
    left -= cost;
    invalidateMetrics(b);
  }
  if (left > 0) {
    const f = eco.fund;
    const spare = f.acct.balance - 0.05 * f.nav * f.units;
    if (spare > 0) {
      const cost = Math.min(left, spare * 0.5);
      const par = cost / price;
      eco.ledger.payPublic(f.acct, 'cb', cost, 'cb');
      addBonds(f, par, cost, cb.bondCoupon);
      cb.bondPar -= par;
      cb.bondBook -= par * bookPer;
    }
  }
}

export function cbMonthly(eco: Economy): void {
  if (!eco.policy.autopilot) return;
  const m = eco.market;
  const infl = m.cpiHistory.length > 12 ? growth(m.cpiHistory, 12) : CFG.inflationTarget;
  const target = 0.01 + infl + 0.5 * (infl - CFG.inflationTarget) - 1.0 * (m.unemployment - CFG.naturalUnemployment) - 0.5 * m.panic;
  const clamped = Math.max(0, Math.min(0.12, target));
  const cur = eco.policy.policyRate;
  let next = cur + Math.max(-0.0025, Math.min(0.0025, clamped - cur));
  next = Math.round(next * 400) / 400;
  if (Math.abs(next - cur) > 1e-6) {
    eco.policy.policyRate = next;
    eco.headline(`Reserve Bank (autopilot) ${next > cur ? 'raises' : 'cuts'} the policy rate to ${pct(next, 2)}`, 'policy', eco.cb.id, undefined, 'autorate', 0);
  }
  void fmtMoney;
}
