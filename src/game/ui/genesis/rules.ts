// Lending rules (Genesis Mode): the levers you govern with once the town is too big to review
// every loan. Each change takes effect at once — every bank's own standards are capped by them —
// and goes into the journal when you settle on a value.

import { choice, h, note, section, spinner } from '../../../ui';
import { fmtMoney, pct } from '../../../sim/format';
import { ERA_INFO, type GenesisRules } from '../../../sim/genesis/types';
import type { UIContext } from '../context';

const pending = new Map<keyof GenesisRules, { from: GenesisRules[keyof GenesisRules]; timer: number }>();

function change<K extends keyof GenesisRules>(ctx: UIContext, key: K, value: GenesisRules[K], immediate = false): void {
  const g = ctx.game.eco.genesis;
  if (!g) return;
  const cur = pending.get(key);
  const from = cur ? (cur.from as GenesisRules[K]) : g.rules[key];
  if (cur) window.clearTimeout(cur.timer);
  g.applyRule(key, value);
  const settle = () => {
    pending.delete(key);
    ctx.game.eco.genesis?.recordRule(key, from, ctx.game.eco.genesis.rules[key]);
  };
  if (immediate) settle();
  else pending.set(key, { from, timer: window.setTimeout(settle, 1200) });
}

export function rulesTab(ctx: UIContext, body: HTMLElement, rerender: () => void): void {
  const g = ctx.game.eco.genesis;
  if (!g) return;
  const r = g.rules;
  body.append(
    h('p', { class: 'gm-para' }, h('b', `Era of ${ERA_INFO[g.era].title}. `), ERA_INFO[g.era].blurb),
    section(
      'Which loans come to your desk',
      choice({
        value: r.review,
        options: [
          { id: 'all', label: 'Every loan', title: 'Every business loan, mortgage and development loan waits for you.' },
          { id: 'large', label: 'Big and new kinds', title: 'Loans at or above the threshold, and the first of each kind. The banks decide the rest under these rules.' },
          { id: 'crises', label: 'Crises only', title: 'The banks decide every loan under these rules; you are called for runs, failures and charters.' },
        ],
        onChange: (id) => {
          change(ctx, 'review', id as GenesisRules['review'], true);
          rerender();
        },
      }),
      r.review === 'large'
        ? spinner({
            label: '“Big” means at least',
            value: r.reviewThreshold,
            min: 50_000,
            max: 1_000_000,
            step: 25_000,
            format: (v) => fmtMoney(v),
            onChange: (v) => change(ctx, 'reviewThreshold', v),
          })
        : null,
    ),
    section(
      'Home loans',
      spinner({
        label: 'Minimum down payment',
        value: Math.round((1 - r.maxLTV) * 100) / 100,
        min: 0,
        max: 0.5,
        step: 0.01,
        format: (v) => pct(v, 0),
        tip: 'The smallest share of a home’s price a buyer must pay from savings. Smaller down payments let more families buy or build sooner, with bigger loans and less of a cushion if prices fall.',
        onChange: (v) => change(ctx, 'maxLTV', Math.round((1 - v) * 100) / 100),
      }),
      spinner({
        label: 'Most of income on debt',
        value: r.maxDTI,
        min: 0.15,
        max: 0.7,
        step: 0.01,
        format: (v) => pct(v, 0),
        tip: 'Loan payments (all loans) may not take more than this share of a borrower’s income.',
        onChange: (v) => change(ctx, 'maxDTI', Math.round(v * 100) / 100),
      }),
    ),
    section(
      'Business loans',
      spinner({
        label: 'Cash-flow cover required',
        value: r.minDSCR,
        min: 0.8,
        max: 2.5,
        step: 0.05,
        format: (v) => `${v.toFixed(2)}×`,
        tip: 'A business’s expected cash flow must cover its loan payments this many times over.',
        onChange: (v) => change(ctx, 'minDSCR', Math.round(v * 100) / 100),
      }),
    ),
    section(
      'All borrowers',
      spinner({
        label: 'Riskiest borrower allowed',
        value: r.maxPD,
        min: 0.01,
        max: 0.3,
        step: 0.01,
        format: (v) => `${pct(v, 0)} a year`,
        tip: 'The highest yearly chance of default a bank may accept (as its loan officers estimate it). Lower means only safe borrowers; higher means more businesses and families get a chance — and more defaults.',
        onChange: (v) => change(ctx, 'maxPD', Math.round(v * 100) / 100),
      }),
    ),
    section(
      'Banks',
      choice({
        label: 'Securitisation',
        value: r.securitization ? 'yes' : 'no',
        options: [
          { id: 'no', label: 'Not allowed', title: 'Banks keep the mortgages they make.' },
          { id: 'yes', label: 'Allowed', title: 'Banks may package mortgages into securities and sell them, freeing capital to lend again.' },
        ],
        onChange: (id) => change(ctx, 'securitization', id === 'yes', true),
      }),
      choice({
        label: 'Dividends',
        value: r.dividends ? 'yes' : 'no',
        options: [
          { id: 'yes', label: 'Allowed', title: 'Banks may pay out profits to their owners (across the river).' },
          { id: 'no', label: 'Retain all', title: 'Every dollar of profit stays in the bank as capital.' },
        ],
        onChange: (id) => change(ctx, 'dividends', id === 'yes', true),
      }),
      note('Capital and liquidity requirements, the policy rate, deposit insurance and emergency lending are on the Controls tab.', 'muted'),
    ),
  );
}
