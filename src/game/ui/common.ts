// Small helpers shared by the game windows.

import { h, type Child, type Tone } from '../../ui';
import type { TrailEvent } from '../../sim/types';
import { fmtDate, fmtMoney, pct } from '../../sim/format';
import type { UIContext } from './context';
import type { Economy } from '../../sim/economy';
import type { Loan } from '../../sim/loan';

export const money = (x: number) => fmtMoney(x);
export const percent = (x: number, d = 1) => pct(x, d);

/** A clickable name that selects the agent and pans the map to it. */
export function agentLink(ctx: UIContext, id: number, label?: string): HTMLElement {
  const eco = ctx.game.eco;
  const name = label ?? eco.nameOf(id);
  const a = eco.agents.get(id);
  if (!a || a.kind === 'world' || a.kind === 'dif') return h('span', name);
  return h(
    'a',
    {
      class: 'gm-link',
      href: '#',
      title: 'Open',
      onclick: (e: MouseEvent) => {
        e.preventDefault();
        ctx.showAgent(id);
      },
    },
    name,
  );
}

export function loanLink(ctx: UIContext, l: Loan, label?: string): HTMLElement {
  return h(
    'a',
    {
      class: 'gm-link',
      href: '#',
      onclick: (e: MouseEvent) => {
        e.preventDefault();
        ctx.open({ kind: 'loan', id: l.id });
      },
    },
    label ?? `${loanKindLabel(l)} #${l.id}`,
  );
}

export function loanKindLabel(l: Loan): string {
  switch (l.purpose) {
    case 'home':
      return 'Mortgage';
    case 'investment_property':
      return 'Buy-to-let mortgage';
    case 'startup':
      return 'Start-up loan';
    case 'expansion':
      return 'Expansion loan';
    case 'working_capital':
      return 'Credit line';
    case 'development':
      return 'Development loan';
    case 'durables':
      return 'Consumer loan';
    case 'smoothing':
      return 'Personal loan';
  }
}

export function loanStatusTone(l: Loan): Tone | undefined {
  switch (l.status) {
    case 'late':
      return 'warn';
    case 'nonperforming':
    case 'defaulted':
      return 'bad';
    case 'repaid':
      return 'muted';
    default:
      return undefined;
  }
}

export function loanStatusLabel(l: Loan): string {
  switch (l.status) {
    case 'performing':
      return 'Paying';
    case 'late':
      return `Late (${l.missed} missed)`;
    case 'nonperforming':
      return 'Non-performing';
    case 'repaid':
      return 'Repaid';
    case 'defaulted':
      return 'Defaulted';
  }
}

/** A story: dated entries, newest first, with links to counterparties. */
export function storyList(ctx: UIContext, items: readonly TrailEvent[], opts: { newestFirst?: boolean; max?: number } = {}): HTMLElement {
  const list = opts.newestFirst === false ? items.slice() : items.slice().reverse();
  const shown = list.slice(0, opts.max ?? 40);
  if (!shown.length) return h('div', { class: 'mi-note' }, 'Nothing has happened yet.');
  return h(
    'ol',
    { class: 'gm-story mi-scroll', dataset: { scrollKey: 'story' } },
    shown.map((e) =>
      h(
        'li',
        { class: ['gm-story-item', e.tone ? `is-${e.tone}` : ''] },
        h('span', { class: 'gm-story-date' }, fmtDate(e.day, false)),
        h(
          'span',
          { class: 'gm-story-text' },
          e.text,
          e.agent !== undefined && ctx.game.eco.agents.has(e.agent) ? [' ', agentLink(ctx, e.agent, '→')] : null,
        ),
      ),
    ),
  );
}

export function para(...children: Child[]): HTMLElement {
  return h('p', { class: 'gm-para' }, ...children);
}

/** Month labels for a stats-style series that ends at the current month. */
export function monthLabels(eco: Economy, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(fmtDate(Math.max(0, eco.day - i * 30), false));
  return out;
}

export function trendArrow(now: number, before: number): string {
  if (!Number.isFinite(now) || !Number.isFinite(before) || before === 0) return '';
  const g = now / before - 1;
  if (Math.abs(g) < 0.005) return '→';
  return g > 0 ? '▲' : '▼';
}
