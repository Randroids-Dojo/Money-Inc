// Homes and the households that live in them.

import { badge, h, kv, note, openWindow, section, stat, table } from '../../ui';
import type { Household, Unit } from '../../sim/agents';
import type { Loan } from '../../sim/loan';
import { unitValue } from '../../sim/banking';
import { FIRST_BANK_ORIGIN, MAX_ORIGINS, ORIGIN_LEGACY, ORIGIN_PUBLIC } from '../../sim/ledger';
import { agentLink, loanKindLabel, loanLink, loanStatusLabel, loanStatusTone, money, percent, storyList } from './common';
import type { UIContext } from './context';

/** Bar showing which bank created the money in an account: "every dollar has a history". */
export function originBar(ctx: UIContext, origin: Float64Array, balance: number): HTMLElement {
  const eco = ctx.game.eco;
  let tot = 0;
  for (let k = 0; k < MAX_ORIGINS; k++) tot += Math.max(0, origin[k]);
  if (tot <= 0 || balance <= 0) return note('No money in the account.');
  const parts: { label: string; color: string; v: number }[] = [];
  for (let k = 0; k < MAX_ORIGINS; k++) {
    const v = Math.max(0, origin[k]);
    if (v / tot < 0.005) continue;
    if (k === ORIGIN_LEGACY) parts.push({ label: 'From before the game', color: '#8a8a96', v });
    else if (k === ORIGIN_PUBLIC) parts.push({ label: 'Public spending', color: '#a37ef0', v });
    else if (k >= FIRST_BANK_ORIGIN) {
      const b = eco.banks.find((x) => x.originIdx === k);
      parts.push({ label: b ? `Created by ${b.short}` : 'Created by a bank', color: b?.color ?? '#888', v });
    }
  }
  parts.sort((a, b) => b.v - a.v);
  return h(
    'div',
    { class: 'gm-origin' },
    h(
      'div',
      { class: 'gm-origin-bar' },
      parts.map((p) => h('span', { style: { background: p.color, width: `${(p.v / tot) * 100}%` }, title: `${p.label}: ${percent(p.v / tot, 0)}` })),
    ),
    h(
      'div',
      { class: 'gm-origin-legend' },
      parts.slice(0, 5).map((p) => h('span', h('i', { style: { background: p.color } }), `${p.label} ${percent(p.v / tot, 0)}`)),
    ),
  );
}

function statusOf(ctx: UIContext, hh: Household): HTMLElement {
  const eco = ctx.game.eco;
  if (hh.departed) return badge('MOVED AWAY', 'muted');
  if (hh.retired) return badge('RETIRED', 'info');
  if (hh.employed) return h('span', { class: 'gm-kind' }, 'Works at ', agentLink(ctx, hh.employer, eco.nameOf(hh.employer)));
  return badge(`JOBLESS ${Math.round(hh.unemployedDays / 30)} MO`, 'bad');
}

export function openHouseholdWindow(ctx: UIContext, id: number, anchor?: { x: number; y: number }): void {
  const hh0 = ctx.game.eco.household(id);
  if (!hh0) return;
  openWindow({
    id: `hh-${id}`,
    title: hh0.name,
    icon: '👪',
    width: 380,
    anchor,
    tabs: [
      { id: 'life', label: 'Life' },
      { id: 'money', label: 'Money' },
    ],
    render: (body, wctx) => {
      const eco = ctx.game.eco;
      const hh = eco.household(id);
      if (!hh) return;
      const home = eco.units[hh.homeUnit];
      const owns = home && home.ownerId === hh.id;
      body.append(
        h(
          'div',
          { class: 'mi-row gm-badges' },
          statusOf(ctx, hh),
          home ? badge(owns ? 'HOMEOWNER' : 'RENTING', owns ? 'good' : 'muted') : null,
          hh.lookingToBuy ? badge(hh.lookingToBuy === 'home' ? 'HOUSE HUNTING' : 'INVESTING', 'info') : null,
        ),
      );
      if (wctx.tab === 'life') {
        body.append(
          h(
            'div',
            { class: 'mi-grid3 gm-tiles' },
            stat('Savings', money(hh.acct.balance + hh.fundUnits * eco.fund.nav)),
            stat('Income / mo', money(hh.income)),
            stat('Spending / mo', money(hh.spentLastMonth || hh.budget)),
          ),
          section('Diary', storyList(ctx, hh.story)),
        );
        return;
      }
      const debt = hh.loans.filter((l) => l.active).reduce((s, l) => s + l.balance, 0);
      const homeValue = owns ? unitValue(eco, home.id) : 0;
      body.append(
        section(
          'Balance sheet',
          kv([
            ['Bank deposit', money(hh.acct.balance), { hint: `Held at ${hh.acct.bank.name}` }],
            hh.fundUnits > 0 ? ['Savings in Meridian Capital', money(hh.fundUnits * eco.fund.nav)] : null,
            owns ? ['Home (market value)', money(homeValue)] : null,
            hh.ownedUnits.length > (owns ? 1 : 0) ? ['Rental properties', `${hh.ownedUnits.length - (owns ? 1 : 0)}`] : null,
            ['Debts', money(-debt), { tone: debt > 0 ? 'warn' : undefined }],
            owns && home.mortgage?.active ? ['Home equity', money(homeValue - home.mortgage.balance), { tone: homeValue < home.mortgage.balance ? 'bad' : 'good' }] : null,
          ]),
        ),
        section('Where their money came from', originBar(ctx, hh.acct.origin, hh.acct.balance)),
        hh.loans.length
          ? section(
              'Loans',
              table<Loan>({
                key: `hh-loans-${id}`,
                maxRows: 6,
                columns: [
                  { key: 'what', label: 'Loan', grow: true, format: (_v, l) => loanLink(ctx, l, loanKindLabel(l)) },
                  { key: 'bank', label: 'Bank', format: (_v, l) => eco.bank(l.servicerId)?.short ?? '?' },
                  { key: 'balance', label: 'Owed', align: 'right', format: (v) => money(v) },
                  { key: 'status', label: 'Status', format: (_v, l) => loanStatusLabel(l) },
                ],
                rows: hh.loans,
                rowTone: (l) => loanStatusTone(l),
                onRowClick: (l) => ctx.open({ kind: 'loan', id: l.id }),
              }),
            )
          : '',
        home ? section('Home', h('div', owns ? 'Owns their home ' : 'Rents from ', owns ? '' : agentLink(ctx, home.ownerId), owns ? '' : ` for ${money(home.rent)} a month`, ' · ', h('a', { class: 'gm-link', href: '#', onclick: (e: MouseEvent) => (e.preventDefault(), ctx.open({ kind: 'lot', id: home.lotId })) }, 'see the building'))) : '',
      );
    },
  });
}

export function openResidenceWindow(ctx: UIContext, lotId: number, anchor?: { x: number; y: number }): void {
  const eco0 = ctx.game.eco;
  const units0 = eco0.lotUnits.get(lotId) ?? [];
  const lot = eco0.city.lots[lotId];
  openWindow({
    id: `lot-${lotId}`,
    title: lot.w >= 2 ? 'Apartment Building' : 'House',
    icon: lot.w >= 2 ? '🏢' : '🏠',
    width: 400,
    anchor,
    render: (body) => {
      const eco = ctx.game.eco;
      const units = (eco.lotUnits.get(lotId) ?? units0).map((u) => eco.units[u]);
      if (!units.length) {
        body.append(note('Nobody lives here.'));
        return;
      }
      const occupied = units.filter((u) => u.occupantId >= 0).length;
      const value = units.reduce((s, u) => s + unitValue(eco, u.id), 0);
      body.append(
        h(
          'div',
          { class: 'mi-grid3 gm-tiles' },
          stat('Homes', `${occupied}/${units.length}`, null, { tip: 'Occupied / total' }),
          stat('Value', money(value)),
          stat('Rent', money(units[0].rent)),
        ),
      );
      if (units.length === 1) {
        const u = units[0];
        body.append(unitDetails(ctx, u));
        const occ = eco.household(u.occupantId);
        if (occ) body.append(section('Who lives here', h('div', agentLink(ctx, occ.id), ' — ', statusOf(ctx, occ))));
        return;
      }
      body.append(
        table<Unit>({
          key: `lot-units-${lotId}`,
          maxRows: 10,
          columns: [
            { key: 'occupant', label: 'Resident', grow: true, format: (_v, u) => (u.occupantId >= 0 ? eco.nameOf(u.occupantId) : u.building ? '(being built)' : '— empty —') },
            { key: 'owner', label: 'Owner', format: (_v, u) => (u.ownerId === u.occupantId ? 'owns it' : shortName(eco.nameOf(u.ownerId))) },
            { key: 'rent', label: 'Rent', align: 'right', format: (v, u) => (u.ownerId === u.occupantId ? '' : money(v)) },
            { key: 'listing', label: '', format: (_v, u) => (u.listing ? 'FOR SALE' : u.mortgage?.active ? 'mortgaged' : '') },
          ],
          rows: units,
          onRowClick: (u) => {
            if (u.occupantId >= 0) ctx.showAgent(u.occupantId);
            else if (u.ownerId >= 0) ctx.showAgent(u.ownerId);
          },
        }),
      );
    },
  });
}

function shortName(s: string): string {
  return s.length > 16 ? `${s.slice(0, 15)}…` : s;
}

function unitDetails(ctx: UIContext, u: Unit): HTMLElement {
  const eco = ctx.game.eco;
  const m = u.mortgage && u.mortgage.active ? u.mortgage : null;
  return section(
    'This home',
    kv([
      ['Owner', agentLink(ctx, u.ownerId)],
      ['Market value', money(unitValue(eco, u.id))],
      u.lastSale.day >= 0 ? ['Last sold', `${money(u.lastSale.price)}`] : null,
      m ? ['Mortgage', loanLink(ctx, m, `${money(m.balance)} owed to ${eco.bank(m.servicerId)?.short ?? '?'}`)] : null,
      u.listing ? ['For sale at', money(u.listing.price), { tone: u.listing.distressed ? 'bad' : undefined }] : null,
    ]),
  );
}
