// Meridian Capital: an investment fund owned by households through fund units. It owns
// the banks' shares, buys mortgage-backed securities and loans from banks, lends them
// wholesale funding, and holds government debt. Its appetite rises with returns and
// collapses with losses — which is what opens and shuts the securitisation market.

import type { Economy } from './economy';
import { metrics, growth, invalidateMetrics, treasuryTarget, unitValue } from './banking';
import { bondPrice } from './markets';
import { CFG } from './config';
import { netIncome } from './bank';

export interface FundBreakdown {
  cash: number;
  bills: number;
  bonds: number;
  mbs: number;
  loans: number;
  repos: number;
  bankShares: number;
  bankBonds: number;
  property: number;
  total: number;
}

export function bankPriceToBook(eco: Economy, b: import('./bank').Bank): number {
  const m = metrics(eco, b);
  if (m.equity <= 0) return 0;
  let ni = 0;
  for (const p of b.plYear) ni += netIncome(p);
  const months = Math.max(1, b.plYear.length);
  const roe = ((ni / months) * 12) / m.equity;
  return Math.max(0.2, Math.min(1.8, 1 + 4 * (roe - 0.08) - 1.5 * b.stress));
}

export function fundBreakdown(eco: Economy): FundBreakdown {
  const f = eco.fund;
  const cash = f.acct.balance;
  const bills = f.bills;
  const bonds = f.bondPar * bondPrice(f.bondCoupon, eco.market.bondYield);
  let mbs = 0;
  for (const [pid, h] of f.mbs) {
    const p = eco.pools.get(pid);
    if (p) mbs += h.frac * p.balance * p.price;
  }
  let loans = 0;
  for (const l of f.loans) if (l.active) loans += l.balance * (l.status === 'performing' ? 0.97 : l.status === 'late' ? 0.7 : 0.4);
  let repos = 0;
  for (const r of f.repos) repos += r.amount;
  let bankShares = 0;
  let bankBonds = 0;
  for (const b of eco.banks) {
    if (!b.alive) continue;
    const m = metrics(eco, b);
    bankShares += Math.max(0, m.equity) * bankPriceToBook(eco, b);
    bankBonds += f.bankBonds.get(b.id) ?? 0;
  }
  let property = 0;
  for (const uid of f.homeCost.keys()) property += unitValue(eco, uid) * 0.95;
  const total = cash + bills + bonds + mbs + loans + repos + bankShares + bankBonds + property;
  return { cash, bills, bonds, mbs, loans, repos, bankShares, bankBonds, property, total };
}

/** Cash the fund likes to keep on hand for redemptions (more when it is nervous). */
export function fundCashTarget(eco: Economy): number {
  const f = eco.fund;
  return (0.05 + 0.08 * f.fear) * Math.max(0, f.nav * f.units) + f.homeBudget;
}

/** Cash above the fund's needs, as a share of its size: a "wall of money" looking for yield. */
export function fundExcessCash(eco: Economy): number {
  const f = eco.fund;
  const total = Math.max(1, f.nav * f.units);
  return Math.max(0, f.acct.balance / total - 0.08);
}

export function fundDaily(eco: Economy): void {
  const f = eco.fund;
  if (eco.day % 3 === 0 || f.nav <= 0) {
    const v = fundBreakdown(eco).total;
    f.nav = f.units > 0 ? v / f.units : 1;
  }
  f.loans = f.loans.filter((l) => l.active);
  if (eco.day % 7 === 3) rebalance(eco);
}

/** When cash runs low (redemptions), the fund sells liquid assets to banks. */
function rebalance(eco: Economy): void {
  const f = eco.fund;
  const target = fundCashTarget(eco);
  let need = target - f.acct.balance;
  if (need < -target * 0.5) {
    // idle cash is lent to the government when the Treasury is borrowing
    const room = treasuryTarget(eco) - eco.publicBalances.treasury;
    if (room > 0) {
      const paid = eco.ledger.payPublic(f.acct, 'treasury', Math.min(room, -need - target * 0.25), 'assetsale');
      f.bills += paid;
      eco.treasury.bills += paid;
    }
    return;
  }
  if (need <= 0) return;
  // sell bills and bonds to banks that have spare reserves
  for (const b of eco.aliveBanks()) {
    if (need <= 0) break;
    const spare = b.reserves - (0.05 + b.personality.liquidityBuffer * 0.3) * b.deposits;
    if (spare <= 10_000) continue;
    let amt = Math.min(need, spare * 0.5, f.bills);
    if (amt > 0) {
      eco.ledger.bankPay(b, f.acct, amt, 'assetsale');
      f.bills -= amt;
      b.bills += amt;
      need -= amt;
    }
    if (need > 0 && f.bondPar > 0) {
      const price = bondPrice(f.bondCoupon, eco.market.bondYield);
      amt = Math.min(need, spare * 0.4, f.bondPar * price);
      if (amt > 0) {
        const par = amt / price;
        const bookPer = f.bondBook / f.bondPar;
        eco.ledger.bankPay(b, f.acct, amt, 'assetsale');
        f.bondPar -= par;
        f.bondBook -= par * bookPer;
        const np = b.bondPar + par;
        b.bondCoupon = (b.bondCoupon * b.bondPar + f.bondCoupon * par) / np;
        b.bondPar = np;
        b.bondBook += amt;
        need -= amt;
      }
    }
    invalidateMetrics(b);
  }
}

/** The fund passes its income (interest, coupons, bank dividends) on to its unitholders. */
function distributeIncome(eco: Economy): void {
  const f = eco.fund;
  const total = f.nav * f.units;
  let pay = Math.max(0, Math.min(f.incomeMonth * 0.9, f.acct.balance - 0.03 * total));
  f.distributedLast = pay;
  f.incomeMonth = 0;
  if (pay <= 0 || f.units <= 0) return;
  // tax on investment income is withheld before distribution
  const tax = eco.ledger.payPublic(f.acct, 'treasury', pay * CFG.dividendTax, 'tax');
  eco.treasury.taxesMonth += tax;
  pay -= tax;
  for (const h of eco.households) {
    if (h.fundUnits <= 0) continue;
    const share = (pay * h.fundUnits) / f.units;
    const paid = eco.ledger.transfer(f.acct, h.acct, share, 'dividend');
    h.incomeThisMonth += paid;
  }
}

export function fundMonthly(eco: Economy): void {
  const f = eco.fund;
  distributeIncome(eco);
  const v = fundBreakdown(eco).total;
  f.lastNav = f.nav;
  f.nav = f.units > 0 ? v / f.units : 1;
  f.navHistory.push(f.nav);
  if (f.navHistory.length > 1200) f.navHistory.shift();
  // sentiment
  let bad = 0,
    tot = 0;
  for (const p of eco.pools.values()) {
    if (p.balance <= 0) continue;
    bad += p.delinquency() * p.balance;
    tot += p.balance;
  }
  const delinq = tot > 0 ? bad / tot : 0;
  const ret3 = growth(f.navHistory, 3);
  const hp6 = growth(eco.market.hpiHistory, 6);
  const hp12 = growth(eco.market.hpiHistory, 12);
  const target = Math.max(
    0,
    Math.min(
      1,
      0.12 + 5 * delinq + 0.5 * eco.market.panic + 3 * Math.max(0, -ret3) + 1.5 * Math.max(0, -hp6) - 0.6 * Math.max(0, hp12),
    ),
  );
  f.fear += (target - f.fear) * (target > f.fear ? 0.4 : 0.06);
  f.boughtThisMonth = 0;
}
