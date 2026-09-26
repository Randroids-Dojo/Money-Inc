// Monthly diagnostic of bank P&L and sector balances.
import { createEconomy } from '../src/sim/setup';
import { metrics } from '../src/sim/banking';
import { netIncome } from '../src/sim/bank';
const months = Number(process.argv[2] ?? '8');
const eco = createEconomy({ seed: Number(process.argv[3] ?? '1'), banks: 4, scenario: 'classic' });
eco.recordVisuals = false;
const K = (x: number) => (x / 1000).toFixed(0).padStart(6);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
function macro(tag: string) {
  const hh = sum(eco.households.map((h) => h.acct.balance));
  const fi = sum(eco.firms.map((f) => f.acct.balance));
  const emp = eco.households.filter((h) => !h.departed && h.employed).length;
  const pop = eco.population();
  const budgets = sum(eco.households.filter((h) => !h.departed).map((h) => h.budget));
  const incomes = sum(eco.households.filter((h) => !h.departed).map((h) => h.income));
  console.log(`${tag} M ${K(eco.broadMoney())} hh ${K(hh)} firms ${K(fi)} fund ${K(eco.fund.acct.balance)} world ${K(eco.world.acct.balance)} tga ${K(eco.publicBalances.treasury)} emp ${emp}/${pop} budgets ${K(budgets)} incomes ${K(incomes)} cpi ${eco.market.cpi.toFixed(3)}`);
  const vac = sum(eco.firms.map((f) => Math.max(0, f.vacancies)));
  const open = eco.firms.filter((f) => f.status === 'open');
  const bySec: Record<string, string> = {};
  for (const s of ['retail', 'service', 'factory', 'builder']) {
    const fs = open.filter((f) => f.sector === s);
    const cap = sum(fs.map((f) => f.capacity));
    const lab = sum(fs.map((f) => f.laborCap));
    const kc = sum(fs.map((f) => f.capitalCap));
    const units = sum(fs.map((f) => f.last.units));
    const unmet = sum(fs.map((f) => f.last.unmet));
    const w = sum(fs.map((f) => f.workers.length));
    const price = fs.length ? sum(fs.map((f) => f.price)) / fs.length : 0;
    const cash = sum(fs.map((f) => f.acct.balance));
    const rev = sum(fs.map((f) => f.last.revenue));
    bySec[s] = `${fs.length}f w${w} cap${K(cap)} lab${K(lab)} kc${K(kc)} sold${K(units)} unmet${K(unmet)} p${price.toFixed(2)} rev${K(rev)} cash${K(cash)}`;
  }
  console.log(`   vacancies ${vac}`);
  for (const [k, v] of Object.entries(bySec)) console.log(`   ${k.padEnd(8)} ${v}`);
}
macro('start');
for (const b of eco.banks) {
  const m = metrics(eco, b);
  console.log(`  ${b.short.padEnd(8)} assets ${K(m.assets)} loans ${K(m.loansGross)} dep ${K(m.deposits)} eq ${K(m.equity)} rwa ${K(m.rwa)} cap ${(m.capitalRatio * 100).toFixed(1)} liq ${(m.liquidityRatio * 100).toFixed(1)} res ${K(m.reserves)} bills ${K(m.bills)} bonds ${K(m.bonds)} whs ${K(m.wholesale)}`);
}
for (let mo = 0; mo < months; mo++) {
  for (let d = 0; d < 30; d++) {
    eco.step();
    if (eco.dom === 28) {
      for (const b of eco.banks) {
        if (!b.alive) continue;
        const p = b.pl;
        console.log(`  m${mo} ${b.short.padEnd(8)} II ${K(p.interestIncome)} IE ${K(p.interestExpense)} fee ${K(p.fees)} opex ${K(p.opex)} prov ${K(p.provisions)} loss ${K(p.creditLosses)} sec ${K(p.securitiesGains)} NI ${K(netIncome(p))}`);
      }
    }
  }
  macro(`m${mo}`);
  for (const b of eco.banks) {
    const m = metrics(eco, b);
    console.log(`  ${b.short.padEnd(8)} ${b.status.padEnd(10)} assets ${K(m.assets)} loans ${K(m.loansGross)} dep ${K(m.deposits)} eq ${K(m.equity)} cap ${(m.capitalRatio * 100).toFixed(1)} liq ${(m.liquidityRatio * 100).toFixed(1)} res ${K(m.reserves)} cb ${K(m.cbLoan)} whs ${K(m.wholesale)} unrl ${K(m.unrealized)} fear ${b.fear.toFixed(2)} stress ${b.stress.toFixed(2)} dep% ${(b.depositRate*100).toFixed(2)}`);
  }
}
for (const n of eco.news.items.slice(-25)) console.log('  NEWS', n.day, n.text);
