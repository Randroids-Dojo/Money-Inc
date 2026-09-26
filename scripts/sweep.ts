// Parameter sweep: average unemployment / inflation / hpi growth over years 1-8 for several seeds.
import { createEconomy } from '../src/sim/setup';
import { CFG, SECTORS } from '../src/sim/config';

type Tweak = { name: string; apply: () => void };
const base = JSON.parse(JSON.stringify({ CFG, SECTORS }));
const reset = () => {
  Object.assign(CFG, JSON.parse(JSON.stringify(base.CFG)));
  for (const k of Object.keys(SECTORS) as (keyof typeof SECTORS)[]) Object.assign(SECTORS[k], base.SECTORS[k]);
};
const tweaks: Tweak[] = [
  { name: 'baseline', apply: () => {} },
];
const years = Number(process.argv[2] ?? '8');
const seeds = (process.argv[3] ?? '1,2,3,4,5,6').split(',').map(Number);
for (const t of tweaks) {
  const rows: string[] = [];
  let U = 0, I = 0, H = 0, n = 0, U0 = 0;
  for (const seed of seeds) {
    reset();
    t.apply();
    const eco = createEconomy({ seed, banks: 4, scenario: 'classic' });
    eco.recordVisuals = false;
    if (process.argv.includes('--autopilot')) eco.policy.autopilot = true;
    let u0 = 0;
    for (let d = 0; d < years * 360; d++) {
      eco.step();
      if (eco.dom === 29 && eco.month >= 12) {
        U += eco.market.unemployment;
        I += eco.stats.last('inflation');
        H += eco.stats.last('hpiGrowth');
        n++;
      }
      if (d === 60) u0 = eco.unemploymentRate();
    }
    U0 += u0;
    rows.push(`s${seed}:u${(eco.market.unemployment * 100).toFixed(0)} bk${eco.aliveBanks().length} fail${eco.news.items.filter((n) => n.text.includes('has FAILED')).length} hpi${eco.market.hpi.toFixed(2)} cpi${eco.market.cpi.toFixed(2)}`);
  }
  console.log(`${t.name.padEnd(16)} avgU ${(100 * U / n).toFixed(1)}%  u@2mo ${(100 * U0 / seeds.length).toFixed(1)}%  avgInfl ${(100 * I / n).toFixed(1)}%  avgHpiG ${(100 * H / n).toFixed(1)}%   ${rows.join(' ')}`);
}
reset();
