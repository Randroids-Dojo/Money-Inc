// Debug helper: runs the daily step phase by phase and reports the first phase that breaks the books.
import { createEconomy } from '../src/sim/setup';
import * as markets from '../src/sim/markets';
import * as banking from '../src/sim/banking';
import * as households from '../src/sim/households';
import * as firms from '../src/sim/firms';
import * as housing from '../src/sim/housing';
import * as construction from '../src/sim/construction';
import * as fund from '../src/sim/fund';
import * as pub from '../src/sim/publicSector';

const seed = Number(process.argv[2] ?? '1');
const days = Number(process.argv[3] ?? '400');
const eco = createEconomy({ seed, banks: 4, scenario: 'classic' });
eco.recordVisuals = false;
const check = (phase: string) => {
  const e = banking.checkBooks(eco);
  if (e.length) {
    console.log(`day ${eco.day} after ${phase}:\n  ${e.join('\n  ')}`);
    process.exit(1);
  }
};
check('setup');
for (let i = 0; i < days; i++) {
  eco.day++;
  const dom = eco.dom;
  markets.dailyMarkets(eco); check('dailyMarkets');
  firms.startOfDay(eco); check('startOfDay');
  markets.shoppingDay(eco); check('shopping');
  firms.restockDay(eco); check('restock');
  construction.constructionDay(eco); check('construction');
  firms.payWages(eco, dom); check('wages');
  pub.publicDaily(eco, dom); check('publicDaily');
  households.billingDay(eco, dom); check('billing');
  banking.loanPaymentsDay(eco, dom); check('loanPayments');
  firms.reviews(eco, dom); check('firmReviews');
  households.reviews(eco, dom); check('hhReviews');
  markets.labourMarketDay(eco); check('labour');
  if (eco.day % 7 === 0) { housing.housingMarketWeek(eco); check('housingWeek'); }
  fund.fundDaily(eco); check('fundDaily');
  banking.banksDaily(eco); check('banksDaily');
  pub.cbDaily(eco); check('cbDaily');
  if (dom === 29) {
    banking.monthlyInterest(eco); check('monthlyInterest');
    pub.treasuryMonthly(eco); check('treasuryMonthly');
    pub.cbMonthly(eco); check('cbMonthly');
    markets.monthlyIndices(eco); check('indices');
    for (const b of eco.banks) if (b.alive) { banking.bankMonthly(eco, b); check('bankMonthly ' + b.short); }
    fund.fundMonthly(eco); check('fundMonthly');
    firms.entryMonthly(eco); check('entry');
    construction.developmentMonthly(eco); check('development');
    households.migrationMonthly(eco); check('migration');
    housing.housingMonthly(eco); check('housingMonthly');
    eco.stats.snapshot(eco);
    eco.news.macro(eco);
    for (const k of Object.keys(eco.monthCounters) as (keyof typeof eco.monthCounters)[]) eco.monthCounters[k] = 0;
  }
}
console.log('books OK for', days, 'days');
