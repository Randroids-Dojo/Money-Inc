// Headless Genesis Mode runs with a scripted player, for tuning and testing.
//   npx tsx scripts/genesis.ts --seed 3 --years 30 --player bank|yes|no|big|small [--check] [--quiet]
//   player: bank  = always follow the bank's own recommendation (and every default)
//           yes   = approve every loan as asked
//           big   = approve everything at double the size asked
//           small = approve everything at half the size asked
//           no    = turn every loan down

import { createEconomy } from '../src/sim/setup';
import type { Economy } from '../src/sim/economy';
import { fmtMoney, pct } from '../src/sim/format';
import { metrics } from '../src/sim/banking';
import { firmProfit } from '../src/sim/markets';
import { autoPlay } from '../src/sim/genesis/autoplay';

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const flag = (k: string) => args.includes(`--${k}`);

const seed = Number(arg('seed', '3'));
const years = Number(arg('years', '20'));
const player = arg('player', 'bank') as 'bank' | 'yes' | 'no' | 'big' | 'small';
const quiet = flag('quiet');

function main(): void {
  const t0 = Date.now();
  const eco = createEconomy({ seed, banks: 1, scenario: 'genesis' });
  eco.recordVisuals = false;
  eco.checkInvariants = flag('check');
  const g = eco.genesis!;
  let ms = 0;
  console.log(`Genesis seed ${seed}, player "${player}", town ${eco.city.name}`);
  console.log('year  pop  firms  jobs   unemp   money     credit    loans  hpi   banks  era           gen%  capR   liqR  exports/mo  imports/mo');
  for (let d = 0; d < years * 360; d++) {
    const log = autoPlay(eco, player);
    if (!quiet) for (const l of log) console.log(`   ${String(eco.day).padStart(5)} ${l}`);
    try {
      eco.step();
    } catch (e) {
      console.error(String(e));
      process.exit(1);
    }
    if (!quiet)
      while (ms < g.milestones.length) {
        const m = g.milestones[ms++];
        console.log(`   ${String(m.day).padStart(5)} ★ ${m.title}: ${m.text}`);
      }
    if (eco.day % 360 === 359) {
      const ind = g.indicators();
      const b = eco.bank(g.genesisBankId)!;
      const m = metrics(eco, b);
      const tr = g.recent.slice(-12);
      const ex = tr.reduce((s, x) => s + x.exports, 0) / Math.max(1, tr.length);
      const im = tr.reduce((s, x) => s + x.importsConsumer + x.importsGoods + x.importsBuild + x.outsideBuild, 0) / Math.max(1, tr.length);
      console.log(
        [
          String(Math.floor(eco.day / 360) + 1).padStart(4),
          String(ind.population).padStart(4),
          String(ind.firms).padStart(6),
          String(ind.jobs).padStart(5),
          pct(eco.unemploymentRate()).padStart(7),
          fmtMoney(ind.money).padStart(9),
          fmtMoney(ind.credit).padStart(9),
          String(g.counters.loansMade).padStart(6),
          ind.hpi.toFixed(2).padStart(5),
          String(ind.banks).padStart(6),
          g.era.padEnd(13),
          pct(ind.genesisShare, 0).padStart(5),
          (b.alive ? pct(m.capitalRatio, 0) : 'dead').padStart(6),
          (b.alive ? pct(m.liquidityRatio, 0) : '').padStart(6),
          fmtMoney(ex).padStart(10),
          fmtMoney(im).padStart(10),
        ].join(' '),
      );
      if (flag('detail')) detail(eco);
    }
  }
  const c = g.counters;
  console.log(`\nMoney now ${fmtMoney(eco.broadMoney())}: lent ${fmtMoney(c.originated)} (${c.loansMade} loans), repaid ${fmtMoney(c.principalRepaid)}, interest ${fmtMoney(c.interestPaid)}, defaulted ${fmtMoney(c.defaulted)}`);
  console.log(`bank spending +${fmtMoney(c.bankSpending)} -${fmtMoney(c.boughtFromBanks)}, public +${fmtMoney(c.publicOut)} -${fmtMoney(c.publicIn)}, trade +${fmtMoney(c.tradeIn)} -${fmtMoney(c.tradeOut)}`);
  const identity = c.originated - c.principalRepaid - c.interestPaid + c.bankSpending - c.boughtFromBanks + c.publicOut - c.publicIn + c.tradeIn - c.tradeOut;
  console.log(`identity check: ${fmtMoney(identity)} vs ${fmtMoney(eco.broadMoney())}`);
  console.log(`decisions ${g.decisions.length}, milestones ${g.milestones.length}, lineage ${g.lineage.nodes.size} nodes / ${g.lineage.edges.length} edges, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function detail(eco: Economy): void {
  const g = eco.genesis!;
  for (const f of eco.firms) {
    if (f.status === 'closed') continue;
    console.log(
      `      ${f.name.padEnd(26)} ${f.sector.padEnd(8)} ${f.status.padEnd(8)} staff ${f.workers.length}/${f.workers.length + f.vacancies} cap ${f.capacity.toFixed(0).padStart(5)} p ${f.price.toFixed(2)} w ${fmtMoney(f.wage)} rev ${fmtMoney(f.last.revenue)} prof ${fmtMoney(firmProfit(eco, f))} cash ${fmtMoney(f.acct.balance)} inv ${f.inventory.toFixed(0)} unmet ${f.last.unmet.toFixed(0)} debt ${fmtMoney(f.loans.reduce((s, l) => s + (l.active ? l.balance : 0), 0))}`,
    );
  }
  let units = 0;
  let occ = 0;
  let forSale = 0;
  let building = 0;
  for (const u of eco.units) {
    units++;
    if (u.building) building++;
    else if (u.occupantId >= 0) occ++;
    if (u.listing) forSale++;
  }
  let projects = 0;
  for (const p of eco.projects.values()) if (p.status === 'active' || p.status === 'stalled') projects++;
  const hh = eco.households.filter((h) => !h.departed);
  const unemployed = hh.filter((h) => !h.employed && !h.retired).length;
  const avgBal = hh.reduce((s, h) => s + h.acct.balance, 0) / Math.max(1, hh.length);
  const tr = g.recent[g.recent.length - 1];
  console.log(
    `      homes ${units} (occupied ${occ}, building ${building}, listed ${forSale}, vacant rentals ${vacantRentalsCount(eco)}) projects ${projects} shortage ${g.housingShortage} | hh ${hh.length} unemployed ${unemployed} avg savings ${fmtMoney(avgBal)} wage ${fmtMoney(eco.market.wageIndex)} cpi ${eco.market.cpi.toFixed(2)} | month: exports ${fmtMoney(tr?.exports ?? 0)} imports cons ${fmtMoney(tr?.importsConsumer ?? 0)} goods ${fmtMoney(tr?.importsGoods ?? 0)} svc-unmet ${fmtMoney(tr?.importsServices ?? 0)}`,
  );
}

function vacantRentalsCount(eco: Economy): number {
  let n = 0;
  for (const u of eco.units) if (!u.building && u.occupantId < 0 && !u.listing) n++;
  return n;
}

main();
