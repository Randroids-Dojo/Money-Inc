// Prints a fingerprint of standard-mode runs, to prove changes leave the classic simulation untouched.
//   npx tsx scripts/fingerprint.ts
import { createHash } from 'node:crypto';
import { createEconomy, type Scenario } from '../src/sim/setup';

const cases: [number, Scenario, number][] = [
  [7, 'classic', 900],
  [3, 'fragile', 900],
  [11, 'easy', 600],
  [5, 'tight', 600],
];
for (const [seed, scenario, days] of cases) {
  const eco = createEconomy({ seed, banks: 4, scenario });
  eco.recordVisuals = false;
  for (let d = 0; d < days; d++) eco.step();
  const parts = [
    eco.broadMoney(),
    eco.totalCredit(),
    eco.market.cpi,
    eco.market.hpi,
    eco.population(),
    eco.firms.length,
    eco.loans.size,
    eco.nextId,
    ...eco.banks.map((b) => b.reserves + b.deposits * 3 + b.retained),
  ].map((x) => x.toPrecision(15));
  const h = createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
  console.log(`${scenario.padEnd(8)} seed ${seed} day ${days}: ${h}  money=${eco.broadMoney().toFixed(2)} credit=${eco.totalCredit().toFixed(2)} ids=${eco.nextId}`);
}
