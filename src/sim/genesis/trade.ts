// Trade with the wider region (Genesis Mode). The new town is a small open economy: its first
// workshop sells across the river, and whatever the town cannot yet make or build for itself
// is bought from the region. Money that arrives from outside is new to the town's banks;
// money spent outside leaves them. Both are counted separately from money created by lending,
// so the money-creation story stays legible.

import { CFG, DAYS_PER_MONTH, DAYS_PER_YEAR } from '../config';
import type { Economy } from '../economy';
import type { Household } from '../agents';
import type { Genesis } from './state';

/** Outside contractors charge more than a local builder would. */
export const OUTSIDE_BUILD_MARKUP = 1.15;

/** What crews from across the river charge for a unit of construction work (travel and lodging included). */
export function outsideBuildPrice(eco: Economy): number {
  return regionPrice(eco) * OUTSIDE_BUILD_MARKUP;
}
/** Imported goods cost more than local ones (transport, the merchant's cut). */
export const IMPORT_MARKUP = 1.1;
/** Share of unmet local demand for services that people travel out of town for. */
export const SERVICE_IMPORT_SHARE = 0.35;

/** Price level in the wider region (grows with steady 2% inflation). */
export function regionPrice(eco: Economy): number {
  return Math.pow(1.02, eco.day / DAYS_PER_YEAR);
}

/** What a worker earns across the river: the wage that anchors the town's own (people can move). */
export function regionWage(eco: Economy): number {
  return CFG.baseWage * regionPrice(eco) * Math.pow(1 + CFG.productivityGrowth, eco.day / DAYS_PER_YEAR);
}

/**
 * Share of their spending locals still bring to a shop whose price has climbed above what the same
 * thing costs across the river (imported goods carry the merchant's markup; services mean a trip).
 */
export function localShare(eco: Economy, sector: 'retail' | 'service', price: number): number {
  const cap = regionPrice(eco) * (sector === 'retail' ? IMPORT_MARKUP : 1.3);
  return price <= cap ? 1 : Math.pow(cap / price, 6);
}

/**
 * The region is big and the town is small: at the region's own price it would take a little more
 * than everything the town's workshops can make (plus a steady trickle of orders). Dearer goods
 * sell less, and the region's own business cycle (`regionMood`) moves the whole market.
 */
export function exportDemand(eco: Economy, g: Genesis, capacity: number): number {
  // (the region itself grows about 3% a year)
  const base = g.exportBase * Math.pow(1.03, eco.day / DAYS_PER_YEAR);
  return (base + capacity * 1.08) * (1 + g.regionMood);
}

/** The region buys from the town's workshops (after local customers have been served). */
export function exportsDay(eco: Economy, g: Genesis): void {
  const factories = eco.firms.filter((f) => f.status === 'open' && f.sector === 'factory');
  if (!factories.length) return;
  const rp = regionPrice(eco);
  let cap = 0;
  for (const f of factories) cap += f.capacity;
  const daily = exportDemand(eco, g, cap) / DAYS_PER_MONTH;
  const w = factories.map((f) => Math.max(1, f.capacity) * Math.pow(Math.max(0.2, f.price / rp), -3));
  const tot = w.reduce((a, b) => a + b, 0);
  factories.forEach((f, i) => {
    const want = daily * (w[i] / tot) * Math.pow(Math.max(0.2, f.price / rp), -2);
    const units = Math.min(want, Math.max(0, f.inventory));
    if (units > 0.01) {
      const money = units * f.price;
      eco.ledger.fromOutside(f.acct, money, 'export', eco.world.id);
      f.inventory -= units;
      f.m.units += units;
      f.m.revenue += money;
      g.trade.exports += money;
    }
    if (want > units + 0.01) f.m.unmet += want - units;
  });
}

/** Goods no local workshop could supply are imported (equipment, materials, shop stock). */
export function importGoods(eco: Economy, g: Genesis, buyer: { acct: Household['acct']; id: number }, units: number, kind: 'supply' | 'invest', loan?: number): number {
  if (units <= 0.01) return 0;
  const price = regionPrice(eco) * IMPORT_MARKUP;
  const u = Math.min(units, buyer.acct.balance / price);
  if (u <= 0.01) return 0;
  const paid = eco.ledger.toOutside(buyer.acct, u * price, 'import', eco.world.id);
  if (loan !== undefined && paid > 0) eco.loans.get(loan)?.spend(eco.world.id, paid, kind === 'invest' ? 'equipment from the region' : 'supplies from the region');
  g.trade.importsGoods += paid;
  return paid / price;
}

/** Household spending that local shops could not absorb goes across the river. */
export function importConsumption(eco: Economy, g: Genesis, h: Household, goods: number, services: number): void {
  let paid = 0;
  if (goods > 1) {
    const x = eco.ledger.toOutside(h.acct, goods, 'import', eco.world.id);
    g.trade.importsConsumer += x;
    paid += x;
  }
  const s = services * SERVICE_IMPORT_SHARE;
  if (s > 1) {
    const x = eco.ledger.toOutside(h.acct, s, 'import', eco.world.id);
    g.trade.importsServices += x;
    paid += x;
  }
  // services nobody could provide are unmet demand the town could serve
  if (services > 1) g.trade.importsServices += services * (1 - SERVICE_IMPORT_SHARE) * 0.5;
  h.spentThisMonth += paid;
}
