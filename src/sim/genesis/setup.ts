// The Genesis starting state: almost nothing. A Reserve Bank, a council with an empty purse,
// one newly founded bank holding nothing but its owners' capital, a would-be entrepreneur,
// one person looking for work, a few cottages — and not a single dollar of deposits.

import { DAYS_PER_MONTH } from '../config';
import { Economy } from '../economy';
import { generateCity, Terrain } from '../../world/city';
import { Bank, type BankPersonality } from '../bank';
import { CentralBank, DepositInsurer, Fund, Household, OutsideWorld, Treasury, Unit } from '../agents';
import { FIRST_BANK_ORIGIN } from '../ledger';
import { metrics, setStandards } from '../banking';
import type { PolicySettings } from '../types';
import { CFG } from '../config';
import { Genesis, GENESIS_BANK_NAME } from './state';
import { nodeKey } from './lineage';

export const GENESIS_BANK_COLOR = '#d9a520';
export const GENESIS_CAPITAL = 250_000;

const GENESIS_PERSONALITY: BankPersonality = {
  riskAppetite: 0.6,
  capitalBuffer: 0.03,
  liquidityBuffer: 0.05,
  focus: { business: 0.5, mortgage: 0.4, consumer: 0.1 },
  securitize: 0.4,
  wholesale: 0.35,
  growth: 0.12,
  payout: 0.35,
  duration: 0.3,
  depositBeta: 0.4,
  blurb: 'The town’s first bank, founded by investors from across the river to finance the new settlement.',
};

function person(eco: Economy, name: string, skill: number, bank: Bank): Household {
  const rng = eco.rng;
  const h = new Household(eco.newId(), name, skill, 0.93, 4 + 2 * rng.next(), 0.2, rng.int(0, DAYS_PER_MONTH - 1), 0);
  h.acct = eco.openAccount(h.id, bank);
  h.wealthMonths = h.bufferMonths;
  eco.register(h);
  eco.households.push(h);
  return h;
}

export function createGenesisEconomy(seed: number, policy: PolicySettings): Economy {
  const city = generateCity(seed);
  // a new settlement: no car parks yet, and the gaps between plots are still wild
  for (let i = 0; i < city.terrain.length; i++) {
    if (city.terrain[i] !== Terrain.Parking) continue;
    city.terrain[i] = Terrain.Grass;
    const n = (i * 2654435761) >>> 0;
    if (n % 10 < 7) city.decorations.push({ x: i % city.W, y: Math.floor(i / city.W), kind: n % 3 === 0 ? 'pine' : 'tree', variant: n % 8 });
  }
  const eco = new Economy(seed, city, policy);
  const g = new Genesis(eco);
  eco.genesis = g;
  const lotBy = (r: 'centralbank' | 'cityhall' | 'fund') => city.lots.find((l) => l.reserved === r)!;

  // ---------------------------------------------------------------- public entities
  const cb = new CentralBank(eco.newId(), `Reserve Bank of ${city.name}`, lotBy('centralbank').id);
  eco.cb = cb;
  eco.cbId = cb.id;
  eco.register(cb);
  const t = new Treasury(eco.newId(), `${city.name} City Hall`, lotBy('cityhall').id);
  eco.treasury = t;
  eco.treasuryId = t.id;
  eco.register(t);
  const dif = new DepositInsurer(eco.newId(), 'Deposit Insurance Fund');
  eco.dif = dif;
  eco.difId = dif.id;
  eco.register(dif);
  eco.lotUse.set(cb.lotId, { type: 'cb', id: cb.id });
  eco.lotUse.set(t.lotId, { type: 'cityhall', id: t.id });

  // ---------------------------------------------------------------- the first bank
  const cbLot = city.lots[cb.lotId];
  const bankLot = city.lots
    .filter((l) => l.reserved === 'bank')
    .reduce((a, l) => (Math.hypot(l.x - cbLot.x, l.y - cbLot.y) < Math.hypot(a.x - cbLot.x, a.y - cbLot.y) ? l : a));
  const b = new Bank(eco.newId(), GENESIS_BANK_NAME, 'GENESIS', GENESIS_BANK_COLOR, FIRST_BANK_ORIGIN, bankLot.id, { ...GENESIS_PERSONALITY, focus: { ...GENESIS_PERSONALITY.focus } }, 0);
  // its owners' capital arrived as reserves: the bank's only asset, matched by its equity
  b.paidIn = GENESIS_CAPITAL;
  b.reserves = GENESIS_CAPITAL;
  b.fear = 0.25;
  b.depositRate = policy.policyRate * GENESIS_PERSONALITY.depositBeta;
  b.budget = 300_000;
  eco.register(b);
  eco.banks.push(b);
  eco.lotUse.set(b.lotId, { type: 'bank', id: b.id });
  eco.initialBankCount = 1;
  g.genesisBankId = b.id;

  // the investment fund exists on paper; it has no office until townspeople have savings to invest
  const fund = new Fund(eco.newId(), 'Meridian Capital', lotBy('fund').id);
  fund.acct = eco.openAccount(fund.id, b);
  fund.nav = 1;
  fund.navHistory = [1, 1, 1];
  eco.fund = fund;
  eco.register(fund);
  const world = new OutsideWorld(eco.newId(), 'The wider region');
  world.acct = eco.openAccount(world.id, b);
  eco.world = world;
  eco.register(world);

  // ---------------------------------------------------------------- two people and a few cottages
  const centre = { x: bankLot.x + bankLot.w / 2, y: bankLot.y + bankLot.d / 2 };
  const homes = city.lots
    .filter((l) => l.zone === 'res' && l.w === 1 && !l.reserved)
    .sort((a, c) => Math.hypot(a.x - centre.x, a.y - centre.y) - Math.hypot(c.x - centre.x, c.y - centre.y))
    .slice(0, 4);
  const founder = person(eco, 'Mara Okafor', 1.1, b);
  const worker = person(eco, 'Alex Moreno', 1.0, b);
  g.founderId = founder.id;
  g.firstWorkerId = worker.id;
  const mkUnit = (lotIdx: number, quality: number, owner: Household, occupant: Household | null) => {
    const lot = homes[lotIdx];
    const u = new Unit(eco.units.length, lot.id, quality, CFG.houseBaseValue, CFG.houseBaseRent);
    u.rent = u.baseRent * u.quality;
    u.ownerId = owner.id;
    owner.ownedUnits.push(u.id);
    if (occupant) {
      u.occupantId = occupant.id;
      occupant.homeUnit = u.id;
    }
    eco.units.push(u);
    eco.lotUnits.set(lot.id, [u.id]);
    eco.lotUse.set(lot.id, { type: 'res', id: lot.id });
    return u;
  };
  const farmhouse = mkUnit(0, 1.0, founder, founder);
  const cottage = mkUnit(1, 0.85, worker, worker);
  const cabins = homes.length >= 4 ? [mkUnit(2, 0.72, founder, null), mkUnit(3, 0.72, founder, null)] : [];
  founder.note(0, `Owns the old farmhouse and ${cabins.length} empty cabins, and has a plan for a foundry.`, 'neutral');
  worker.note(0, 'Lives in a small cottage and is looking for work. There is none yet.', 'neutral');

  // ---------------------------------------------------------------- markets at rest
  const mk = eco.market;
  for (let i = 12; i >= 0; i--) {
    mk.cpiHistory.push(Math.pow(1.02, -i / 12));
    mk.hpiHistory.push(Math.pow(1.02, -i / 12));
  }
  mk.hpiExpect = 0.02;
  mk.unemployment = g.labourSignal();
  for (const h of [founder, worker]) {
    h.houseExpect = 0.02;
    h.budget = 0;
  }
  setStandards(eco, b);
  const m = metrics(eco, b);
  b.history.push({ day: 0, assets: m.assets, equity: m.equity, deposits: 0, loans: 0, capitalRatio: m.capitalRatio, liquidityRatio: 1, npl: 0, profit: 0, fear: b.fear });

  // ---------------------------------------------------------------- the record begins
  const L = g.lineage;
  L.node('public', cb.id, cb.name, 0, cb.lotId, 'central bank');
  L.node('public', t.id, t.name, 0, t.lotId, 'council');
  L.node('public', world.id, 'The wider region', 0, undefined, 'outside town');
  L.node('bank', b.id, b.name, 0, b.lotId, 'the first bank');
  g.hh(founder);
  g.hh(worker);
  for (const u of [farmhouse, cottage, ...cabins]) {
    g.unitNode(u);
    L.openEdge('bought', nodeKey('household', u.ownerId), nodeKey('unit', u.id), 0, 'owned outright since before the town began', 0);
  }
  eco.news.add(0, `${city.name}: one bank, one idea, two people — and not a single dollar of bank money yet.`, 'good', b.id);
  g.startFounding();
  return eco;
}
