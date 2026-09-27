// The town journal: every decision the player made (with how the town has changed since — not
// claiming the decision caused it), the town's firsts, and the life story of the first bank:
// what it financed, what became of its loans, and who ended up with them.

import { badge, button, h, kv, note, openWindow, section } from '../../../ui';
import { fmtDate, fmtMoney, pct } from '../../../sim/format';
import { metrics } from '../../../sim/banking';
import { GENESIS_BANK_NAME, type Genesis } from '../../../sim/genesis/state';
import { nodeKey } from '../../../sim/genesis/lineage';
import type { DecisionRecord, Indicators } from '../../../sim/genesis/types';
import { agentLink } from '../common';
import type { UIContext } from '../context';

const IND_LABEL: Record<keyof Indicators, string> = {
  day: 'day',
  money: 'money in town',
  credit: 'loans outstanding',
  mortgages: 'mortgages outstanding',
  businessLoans: 'business loans outstanding',
  population: 'households',
  firms: 'businesses',
  jobs: 'jobs',
  unemployment: 'unemployment',
  hpi: 'house prices',
  construction: 'building sites',
  mortgageLending12: 'mortgage lending (a year)',
  businessLending12: 'business lending (a year)',
  houseSales12: 'home sales (a year)',
  defaults12: 'defaults (a year)',
  leverage: 'household debt / income',
  capitalRatio: 'banks’ capital ratio',
  banks: 'banks',
  genesisShare: `${GENESIS_BANK_NAME}'s share of lending`,
};

function fmtInd(k: keyof Indicators, v: number): string {
  switch (k) {
    case 'money':
    case 'credit':
    case 'mortgages':
    case 'businessLoans':
    case 'mortgageLending12':
    case 'businessLending12':
      return fmtMoney(v);
    case 'unemployment':
    case 'capitalRatio':
    case 'genesisShare':
      return pct(v, 0);
    case 'hpi':
      return `${(v * 100).toFixed(0)}`;
    case 'leverage':
      return `${v.toFixed(2)}×`;
    default:
      return String(Math.round(v));
  }
}

/** "since then" chips: the indicators this kind of decision is about, then vs now. */
function sinceThen(g: Genesis, d: DecisionRecord): HTMLElement | null {
  if (g.eco.day - d.day < 30) return h('div', { class: 'gn-since is-fresh' }, 'Too soon to see what followed.');
  const now = g.indicators();
  const chips = d.watch.map((k) => {
    const a = d.before[k];
    const b = now[k];
    const up = b > a * 1.001;
    const down = b < a * 0.999;
    const text = k === 'hpi' ? `house prices ${a > 0 ? `${b / a >= 1 ? '+' : ''}${pct(b / a - 1, 0)}` : '—'}` : `${IND_LABEL[k]} ${fmtInd(k, a)} → ${fmtInd(k, b)}`;
    return h('span', { class: ['gn-chip', up && 'is-up', down && 'is-down'] }, text);
  });
  return h('div', { class: 'gn-since' }, h('span', { class: 'gn-since-label' }, `${Math.floor((g.eco.day - d.day) / 360) > 0 ? `${Math.floor((g.eco.day - d.day) / 360)} yr` : `${Math.floor((g.eco.day - d.day) / 30)} mo`} since:`), chips);
}

export interface JournalHooks {
  trace(key: string): void;
}

export function openJournal(ctx: UIContext, hooks: JournalHooks, tab = 'decisions'): void {
  openWindow({
    id: 'gjournal',
    title: 'Town journal',
    icon: '📜',
    width: 520,
    tabs: [
      { id: 'decisions', label: 'Your decisions' },
      { id: 'firsts', label: 'Firsts' },
      { id: 'bank', label: 'The first bank' },
    ],
    initialTab: tab,
    render: (body, wctx) => {
      const g = ctx.game.eco.genesis;
      if (!g) return;
      if (wctx.tab === 'decisions') decisions(ctx, g, hooks, body);
      else if (wctx.tab === 'firsts') firsts(ctx, g, body);
      else firstBank(ctx, g, hooks, body);
    },
  });
}

function decisions(ctx: UIContext, g: Genesis, hooks: JournalHooks, body: HTMLElement): void {
  const list = g.decisions.slice().reverse();
  if (!list.length) {
    body.append(note('You have not made any decisions yet. Loans you approve or refuse, rules you change and what you do in a crisis will be recorded here.'));
    return;
  }
  body.append(note('What changed after each decision. Plenty else happened too: these are not claims about cause and effect.', 'muted'));
  let year = -1;
  const wrap = h('div', { class: 'gn-journal mi-scroll', dataset: { scrollKey: 'journal' } });
  for (const d of list) {
    const y = Math.floor(d.day / 360) + 1;
    if (y !== year) {
      year = y;
      wrap.append(h('div', { class: 'gn-year' }, `Year ${y}`));
    }
    const target = d.keys.find((k) => g.lineage.get(k));
    wrap.append(
      h(
        'div',
        { class: 'gn-entry' },
        h('div', { class: 'gn-entry-head' }, h('span', { class: 'gn-entry-date' }, fmtDate(d.day, false)), h('span', { class: 'gn-entry-text' }, d.text), target ? button('Trace', () => hooks.trace(nodeKey('decision', d.id)), { small: true, title: 'See what this decision touched, and what grew from it' }) : null),
        sinceThen(g, d),
      ),
    );
  }
  body.append(wrap);
  void ctx;
}

function firsts(ctx: UIContext, g: Genesis, body: HTMLElement): void {
  const ms = g.milestones.slice().reverse();
  if (!ms.length) {
    body.append(note('Nothing has happened yet. The town is waiting for its first loan.'));
    return;
  }
  body.append(
    h(
      'div',
      { class: 'gn-journal mi-scroll', dataset: { scrollKey: 'firsts' } },
      ms.map((m) =>
        h(
          'div',
          { class: ['gn-entry', `tier-${m.tier}`] },
          h(
            'div',
            { class: 'gn-entry-head' },
            h('span', { class: 'gn-entry-date' }, fmtDate(m.day, false)),
            h('span', { class: 'gn-entry-title' }, m.title),
            m.agent !== undefined && ctx.game.eco.agents.has(m.agent)
              ? button('Show', () => ctx.showAgent(m.agent!), { small: true })
              : m.lot !== undefined
                ? button('Show', () => ctx.showOnMap({ kind: 'lot', id: m.lot! }), { small: true })
                : null,
          ),
          h('div', { class: 'gn-entry-body' }, m.text),
        ),
      ),
    ),
  );
}

/** Everything the town's first bank did, and what became of it. */
export function firstBankFacts(g: Genesis) {
  const eco = g.eco;
  const id = g.genesisBankId;
  const loans = [...eco.loans.values()].filter((l) => l.originatorId === id);
  const sum = (xs: typeof loans) => xs.reduce((s, l) => s + l.principal0, 0);
  const active = loans.filter((l) => l.active);
  const repaid = loans.filter((l) => l.status === 'repaid');
  const defaulted = loans.filter((l) => l.status === 'defaulted');
  const sold = loans.filter((l) => l.holder.kind !== 'bank' || (l.holder.kind === 'bank' && l.holder.id !== id));
  const firms = new Map<number, number>();
  for (const l of loans) if (eco.firm(l.borrowerId)) firms.set(l.borrowerId, (firms.get(l.borrowerId) ?? 0) + l.principal0);
  let jobs = 0;
  for (const fid of firms.keys()) {
    const f = eco.firm(fid);
    if (f && f.status === 'open') jobs += f.workers.length;
  }
  const mortgages = loans.filter((l) => l.kind === 'mortgage');
  const homes = new Set<number>();
  for (const l of loans) if (l.collateral.kind === 'property' && l.collateral.ref !== undefined) homes.add(l.collateral.ref);
  const trace = g.lineage.trace(nodeKey('bank', id), 3);
  let downstreamHouseholds = 0;
  let downstreamFirms = 0;
  for (const t of trace.values()) {
    if (t.upstream || t.depth < 2) continue;
    if (t.key.startsWith('household:')) downstreamHouseholds++;
    else if (t.key.startsWith('firm:')) downstreamFirms++;
  }
  return { loans, active, repaid, defaulted, sold, firms, jobs, mortgages, homes, sum, downstreamHouseholds, downstreamFirms };
}

function firstBank(ctx: UIContext, g: Genesis, hooks: JournalHooks, body: HTMLElement): void {
  const eco = g.eco;
  const b = eco.bank(g.genesisBankId);
  if (!b) return;
  const f = firstBankFacts(g);
  const acquirer = b.acquiredBy !== null && b.acquiredBy >= 0 ? eco.bank(b.acquiredBy) : undefined;
  const status = b.alive
    ? badge('OPEN', 'good')
    : badge(b.failureKind ? 'FAILED' : 'TAKEN OVER', 'bad');
  body.append(
    h('div', { class: 'mi-row gm-badges' }, status, badge(`FOUNDED ${fmtDate(b.founded, false).toUpperCase()}`, 'muted'), button(`Trace ${b.name}`, () => hooks.trace(nodeKey('bank', b.id)), { small: true, primary: true })),
    b.alive
      ? note(`${b.name} made the town's first loan. It has made ${f.loans.length} loans since; ${pct(g.genesisShare(), 0)} of all the money ever lent in ${eco.city.name} was first lent by it.`)
      : note(`${b.name} made the town's first loan and ${f.loans.length} in all. ${b.failedDay >= 0 ? `It was closed in ${fmtDate(b.failedDay, false)}` : 'It is gone'}${acquirer ? `; ${acquirer.name} took over its accounts and loans` : ''}. Its history — and everything it financed — remains.`),
  );
  const m = b.alive ? metrics(eco, b) : undefined;
  const today = m
    ? section(
        'Today',
        kv([
          ['Deposits it holds', fmtMoney(m.deposits)],
          ['Loans on its books', fmtMoney(m.loansGross)],
          ['Capital ratio', pct(m.capitalRatio, 1)],
          ['Banks in town', String(eco.aliveBanks().length)],
        ]),
      )
    : '';
  body.append(
    section(
      'Its loans',
      kv([
        ['Made', `${f.loans.length} · ${fmtMoney(f.sum(f.loans))}`],
        ['Still being repaid', `${f.active.length} · ${fmtMoney(f.active.reduce((s, l) => s + l.balance, 0))} owed`],
        ['Repaid in full', `${f.repaid.length} · ${fmtMoney(f.sum(f.repaid))}`],
        ['Defaulted', `${f.defaulted.length} · ${fmtMoney(f.sum(f.defaulted))}`, { tone: f.defaulted.length ? 'bad' : undefined }],
        ['Sold on or packaged into securities', String(f.sold.length)],
        ['Mortgages', `${f.mortgages.length} · on ${f.homes.size} home${f.homes.size === 1 ? '' : 's'}`],
      ]),
    ),
    section(
      'What it financed',
      f.firms.size
        ? h(
            'ul',
            { class: 'gn-list' },
            [...f.firms.entries()].map(([fid, amt]) => {
              const firm = eco.firm(fid);
              return h('li', agentLink(ctx, fid), ` — ${fmtMoney(amt)} lent`, firm ? h('span', { class: 'mi-muted' }, firm.status === 'open' ? ` · open, ${firm.workers.length} staff` : firm.status === 'closed' ? ' · closed' : ' · not open yet') : null);
            }),
          )
        : note('No businesses yet.'),
      kv([
        ['People working at businesses it lent to', String(f.jobs)],
        ['Further households connected through them', String(f.downstreamHouseholds), { hint: 'Households two or more steps away: employed by, housed by or buying from people and businesses it financed. Connected, not caused.' }],
      ]),
    ),
    today,
  );
}
