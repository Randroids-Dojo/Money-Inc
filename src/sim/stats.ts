// Monthly statistics: the numbers behind the statistics window and the HUD.

import type { Economy } from './economy';
import { metrics, growth } from './banking';
import { fundBreakdown } from './fund';

export const SERIES = [
  'money',
  'base',
  'credit',
  'mortgages',
  'businessLoans',
  'consumerLoans',
  'devLoans',
  'securitised',
  'bankAssets',
  'bankEquity',
  'capitalRatio',
  'npl',
  'gdp',
  'realGdp',
  'cpi',
  'inflation',
  'hpi',
  'hpiGrowth',
  'rentIndex',
  'unemployment',
  'wage',
  'firms',
  'openings',
  'closures',
  'bankFailures',
  'banksAlive',
  'defaults',
  'defaultValue',
  'population',
  'policyRate',
  'mortgageRate',
  'businessRate',
  'depositRate',
  'bondYield',
  'fundNav',
  'mbsPrice',
  'lending',
  'repayment',
  'interestPaid',
  'bankSpending',
  'publicNet',
  'writeDowns',
  'confidence',
  'bankFear',
  'construction',
  'stalled',
  'deficit',
  'govDebt',
  'creditGrowth',
  'moneyGrowth',
  'utilization',
  'houseSales',
  'listings',
  'vacancy',
  'consumption',
  'investment',
  'unmet',
] as const;

export type SeriesKey = (typeof SERIES)[number];

export class Stats {
  days: number[] = [];
  s = {} as Record<SeriesKey, number[]>;
  constructor() {
    for (const k of SERIES) this.s[k] = [];
  }

  last(k: SeriesKey, back = 0): number {
    const a = this.s[k];
    return a.length > back ? a[a.length - 1 - back] : NaN;
  }

  get length(): number {
    return this.days.length;
  }

  snapshot(eco: Economy): void {
    const push = (k: SeriesKey, v: number) => {
      const a = this.s[k];
      a.push(Number.isFinite(v) ? v : 0);
      if (a.length > 1200) a.shift();
    };
    this.days.push(eco.day);
    if (this.days.length > 1200) this.days.shift();
    const mk = eco.market;
    let mort = 0,
      bus = 0,
      cons = 0,
      dev = 0,
      sec = 0;
    for (const l of eco.loans.values()) {
      if (!l.active) continue;
      if (l.kind === 'mortgage') mort += l.balance;
      else if (l.kind === 'business') bus += l.balance;
      else if (l.kind === 'consumer') cons += l.balance;
      else dev += l.balance;
      if (l.holder.kind !== 'bank') sec += l.balance;
    }
    let assets = 0,
      equity = 0,
      rwa = 0,
      npl = 0,
      loans = 0,
      fear = 0,
      nb = 0,
      mRate = 0,
      bRate = 0,
      dRate = 0,
      dep = 0;
    for (const b of eco.banks) {
      if (!b.alive) continue;
      const m = metrics(eco, b);
      assets += m.assets;
      equity += m.equity;
      rwa += m.rwa;
      npl += m.npl;
      loans += m.loansGross;
      fear += b.fear;
      nb++;
      mRate += (eco.policy.policyRate + b.spreads.mortgage) * m.deposits;
      bRate += (eco.policy.policyRate + b.spreads.business) * m.deposits;
      dRate += b.depositRate * m.deposits;
      dep += m.deposits;
    }
    const money = eco.broadMoney();
    const credit = mort + bus + cons + dev;
    const c = eco.monthCounters;
    push('money', money);
    push('base', eco.baseMoney());
    push('credit', credit);
    push('mortgages', mort);
    push('businessLoans', bus);
    push('consumerLoans', cons);
    push('devLoans', dev);
    push('securitised', sec);
    push('bankAssets', assets);
    push('bankEquity', equity);
    push('capitalRatio', rwa > 0 ? equity / rwa : 0);
    push('npl', loans > 0 ? npl / loans : 0);
    const gdp = c.consumption + c.investment + c.governmentSpend + c.housingWork;
    push('gdp', gdp);
    push('realGdp', gdp / Math.max(0.1, mk.cpi));
    push('cpi', mk.cpi * 100);
    push('inflation', mk.cpiHistory.length > 12 ? growth(mk.cpiHistory, 12) : 0.02);
    push('hpi', mk.hpi * 100);
    push('hpiGrowth', mk.hpiHistory.length > 12 ? growth(mk.hpiHistory, 12) : 0);
    push('rentIndex', mk.rentIndex * 100);
    push('unemployment', mk.unemployment);
    push('wage', mk.wageIndex);
    push('firms', eco.firms.filter((f) => f.status === 'open').length);
    push('openings', c.firmOpenings);
    push('closures', c.firmClosures);
    push('bankFailures', c.bankFailures);
    push('banksAlive', nb);
    push('defaults', c.defaults);
    push('defaultValue', c.defaultValue);
    push('population', eco.population());
    push('policyRate', eco.policy.policyRate);
    push('mortgageRate', dep > 0 ? mRate / dep : 0);
    push('businessRate', dep > 0 ? bRate / dep : 0);
    push('depositRate', dep > 0 ? dRate / dep : 0);
    push('bondYield', mk.bondYield);
    push('fundNav', eco.fund.nav);
    let pp = 0,
      pb = 0;
    for (const p of eco.pools.values()) {
      if (p.balance <= 0) continue;
      pp += p.price * p.balance;
      pb += p.balance;
    }
    push('mbsPrice', pb > 0 ? pp / pb : 1);
    const fl = eco.flowsMonth;
    push('lending', fl.lending);
    push('repayment', fl.repayment);
    push('interestPaid', fl.interest);
    push('bankSpending', fl.bankSpending);
    push('publicNet', fl.publicOut - fl.publicIn);
    push('writeDowns', fl.writeDowns);
    push('confidence', mk.consumerConfidence);
    push('bankFear', nb ? fear / nb : 1);
    let act = 0,
      st = 0;
    for (const p of eco.projects.values()) {
      if (p.status === 'active') act++;
      else if (p.status === 'stalled') st++;
    }
    push('construction', act);
    push('stalled', st);
    const dh = eco.treasury.deficitHistory;
    push('deficit', dh.length ? dh[dh.length - 1] : 0);
    push('govDebt', eco.treasury.bills + eco.treasury.bondPar);
    const cr = this.s.credit;
    push('creditGrowth', cr.length > 12 ? cr[cr.length - 1] / cr[cr.length - 13] - 1 : 0);
    const mo = this.s.money;
    push('moneyGrowth', mo.length > 12 ? mo[mo.length - 1] / mo[mo.length - 13] - 1 : 0);
    let dem = 0,
      cap = 0;
    for (const f of eco.firms) {
      if (f.status !== 'open') continue;
      dem += f.last.units;
      cap += f.capacity;
    }
    push('utilization', cap > 0 ? dem / cap : 0);
    push('houseSales', c.houseSales);
    let listings = 0;
    for (const u of eco.units) if (u.listing) listings++;
    push('listings', listings);
    push('vacancy', mk.vacancyRate);
    push('consumption', c.consumption);
    push('investment', c.investment);
    push('unmet', c.unmetDemand);
    void fundBreakdown;
  }
}
