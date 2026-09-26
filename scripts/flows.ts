// Sectoral flow-of-funds audit built from the ledger's flow records.
import { createEconomy } from '../src/sim/setup';
const months = Number(process.argv[2] ?? '12');
const eco = createEconomy({ seed: Number(process.argv[3] ?? '1'), banks: 4, scenario: 'classic' });
eco.recordVisuals = true;
const sectorOf = (id: number): string => {
  const a = eco.agents.get(id);
  if (!a) return 'cb';
  return a.kind === 'household' ? 'HH' : a.kind === 'firm' ? 'FIRM' : a.kind === 'bank' ? 'BANK' : a.kind === 'treasury' ? 'GOV' : a.kind === 'fund' ? 'FUND' : a.kind === 'world' ? 'WORLD' : a.kind === 'dif' ? 'DIF' : 'CB';
};
const K = (x: number) => (x / 1000).toFixed(0);
for (let mo = 0; mo < months; mo++) {
  eco.flowBuffer.length = 0;
  for (let d = 0; d < 30; d++) {
    eco.step();
    eco.eventBuffer.length = 0;
  }
  const inflow = new Map<string, number>();
  const outflow = new Map<string, number>();
  const hhIn = new Map<string, number>();
  const hhOut = new Map<string, number>();
  for (const f of eco.flowBuffer) {
    const a = sectorOf(f.from), b = sectorOf(f.to);
    if (a === b) continue;
    outflow.set(a, (outflow.get(a) ?? 0) + f.amount);
    inflow.set(b, (inflow.get(b) ?? 0) + f.amount);
    if (b === 'HH') hhIn.set(`${f.kind}<${a}`, (hhIn.get(`${f.kind}<${a}`) ?? 0) + f.amount);
    if (a === 'HH') hhOut.set(`${f.kind}>${b}`, (hhOut.get(`${f.kind}>${b}`) ?? 0) + f.amount);
  }
  const net = (s: string) => (inflow.get(s) ?? 0) - (outflow.get(s) ?? 0);
  console.log(`m${mo} unemp ${(eco.market.unemployment * 100).toFixed(1)}%  NET: HH ${K(net('HH'))} FIRM ${K(net('FIRM'))} BANK ${K(net('BANK'))} GOV ${K(net('GOV'))} FUND ${K(net('FUND'))} WORLD ${K(net('WORLD'))} CB ${K(net('CB'))}`);
  console.log('   HH in : ' + [...hhIn.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${K(v)}`).join(', '));
  console.log('   HH out: ' + [...hhOut.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${K(v)}`).join(', '));
}
