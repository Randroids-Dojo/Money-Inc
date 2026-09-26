// Headless simulation runner for calibration and debugging.
//   npx tsx scripts/simulate.ts --years 20 --seed 7 --banks 4 --scenario classic [--check] [--every 3] [--csv out.csv]
//   Policy overrides: --rate 0.01 --capreq 0.06 --liqreq 0.05 --insurance none --ela none --qe 20000

import { writeFileSync } from 'node:fs';
import { createEconomy, type Scenario } from '../src/sim/setup';
import { metrics } from '../src/sim/banking';
import { SERIES } from '../src/sim/stats';
import type { DepositInsurance, EmergencyLiquidity } from '../src/sim/types';

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const flag = (k: string) => args.includes(`--${k}`);

const years = Number(arg('years', '15'));
const seed = Number(arg('seed', '1'));
const banks = Number(arg('banks', '4'));
const scenario = (arg('scenario', 'classic') as Scenario) ?? 'classic';
const every = Number(arg('every', '6'));

const t0 = Date.now();
const eco = createEconomy({ seed, banks, scenario });
eco.recordVisuals = false;
eco.checkInvariants = flag('check');
if (arg('rate')) eco.policy.policyRate = Number(arg('rate'));
if (arg('capreq')) eco.policy.capitalRequirement = Number(arg('capreq'));
if (arg('liqreq')) eco.policy.liquidityRequirement = Number(arg('liqreq'));
if (arg('insurance')) eco.policy.depositInsurance = arg('insurance') as DepositInsurance;
if (arg('ela')) eco.policy.emergencyLiquidity = arg('ela') as EmergencyLiquidity;
if (arg('qe')) eco.policy.qePerMonth = Number(arg('qe'));
if (flag('autopilot')) eco.policy.autopilot = true;
const shockDay = Number(arg('shockday', '-1'));
const shockRate = Number(arg('shockrate', '0'));

const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const M = (x: number) => f(x / 1e6, 2);
const P = (x: number) => f(x * 100, 1);

console.log(
  'month  M($M)  cred  mort  bus   cpi   infl  hpi   hpiG  unemp  wage  firms pop  gdp(K) defs  banks capR  npl  fear  fundNav sec%  cons  stall  lendK  repayK  rate sales list',
);
const days = years * 360;
let lastLog = '';
for (let d = 0; d < days; d++) {
  if (d === shockDay) eco.policy.policyRate = shockRate;
  try {
    eco.step();
  } catch (e) {
    console.error(String(e));
    process.exit(1);
  }
  if (eco.dom === 29 && eco.month % every === every - 1) {
    const s = eco.stats;
    const L = (k: (typeof SERIES)[number]) => s.last(k);
    const line = [
      String(eco.month + 1).padStart(5),
      M(L('money')).padStart(6),
      M(L('credit')).padStart(5),
      M(L('mortgages')).padStart(5),
      M(L('businessLoans')).padStart(5),
      f(L('cpi'), 1).padStart(6),
      P(L('inflation')).padStart(5),
      f(L('hpi'), 0).padStart(5),
      P(L('hpiGrowth')).padStart(5),
      P(L('unemployment')).padStart(6),
      f(L('wage'), 0).padStart(5),
      String(L('firms')).padStart(5),
      String(L('population')).padStart(4),
      f(L('gdp') / 1000, 0).padStart(6),
      String(L('defaults')).padStart(5),
      String(L('banksAlive')).padStart(5),
      P(L('capitalRatio')).padStart(5),
      P(L('npl')).padStart(5),
      f(L('bankFear'), 2).padStart(5),
      f(L('fundNav'), 3).padStart(7),
      P(L('securitised') / Math.max(1, L('credit'))).padStart(5),
      String(L('construction')).padStart(5),
      String(L('stalled')).padStart(6),
      f(L('lending') / 1000, 0).padStart(6),
      f(L('repayment') / 1000, 0).padStart(7),
      P(eco.policy.policyRate).padStart(5),
      String(L('houseSales')).padStart(4),
      String(L('listings')).padStart(4),
    ].join(' ');
    console.log(line);
    lastLog = line;
  }
}
void lastLog;
console.log(`\n${years} years in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const b of eco.banks) {
  const m = metrics(eco, b);
  console.log(
    `${b.short.padEnd(9)} ${b.status.padEnd(11)} assets ${M(m.assets)}M eq ${M(m.equity)}M cap ${P(m.capitalRatio)}% liq ${P(m.liquidityRatio)}% npl ${P(m.nplRatio)}% fear ${f(b.fear, 2)} stance ${b.stance} loans ${b.loans.length} cb ${M(b.cbLoan)} whs ${M(m.wholesale)} mbs ${M(m.mbs)}`,
  );
}
console.log('\nHeadlines (last 40):');
for (const n of eco.news.items.slice(-40)) console.log(`  [${Math.floor(n.day / 360) + 1}-${String(Math.floor((n.day % 360) / 30) + 1).padStart(2, '0')}] ${n.text}`);
const csv = arg('csv');
if (csv) {
  const s = eco.stats;
  const rows = [['day', ...SERIES].join(',')];
  for (let i = 0; i < s.days.length; i++) rows.push([s.days[i], ...SERIES.map((k) => s.s[k][i])].join(','));
  writeFileSync(csv, rows.join('\n'));
  console.log(`wrote ${csv}`);
}
