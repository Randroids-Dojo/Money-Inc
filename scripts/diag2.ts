// Early-period macro flow audit.
import { createEconomy } from '../src/sim/setup';
const months = Number(process.argv[2] ?? '24');
const eco = createEconomy({ seed: Number(process.argv[3] ?? '1'), banks: 4, scenario: 'classic' });
eco.recordVisuals = false;
const K = (x: number) => (x / 1000).toFixed(0).padStart(6);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
console.log(' mo    tga  procur  taxes  fundCash fundBills  hhDep  lend  repay  newLoans   cons   invest  gov  unemp  cpi   buyers listings sales');
for (let mo = 0; mo < months; mo++) {
  for (let d = 0; d < 30; d++) {
    eco.step();
    if (eco.dom === 28) {
      const c = eco.monthCounters;
      (globalThis as any).snap = { lend: eco.flowsMonth.lending, repay: eco.flowsMonth.repayment, n: c.newLoans, cons: c.consumption, inv: c.investment, gov: c.governmentSpend, tax: eco.treasury.taxesMonth, sales: c.houseSales };
    }
  }
  const s = (globalThis as any).snap;
  const hh = sum(eco.households.map((h) => h.acct.balance));
  const buyers = eco.households.filter((h) => !h.departed && h.lookingToBuy).length;
  const listings = eco.units.filter((u) => u.listing).length;
  console.log(`${String(mo).padStart(3)} ${K(eco.publicBalances.treasury)} ${K(eco.treasury.procurementLast)} ${K(s.tax)} ${K(eco.fund.acct.balance)} ${K(eco.fund.bills)} ${K(hh)} ${K(s.lend)} ${K(s.repay)} ${String(s.n).padStart(6)} ${K(s.cons)} ${K(s.inv)} ${K(s.gov)}  ${(eco.market.unemployment * 100).toFixed(1).padStart(5)} ${eco.market.cpi.toFixed(3)} ${String(buyers).padStart(5)} ${String(listings).padStart(6)} ${String(s.sales).padStart(5)}`);
}
