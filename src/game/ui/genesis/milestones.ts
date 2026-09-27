// Milestones: the town's firsts. Early ones get a banner across the top of the screen (the first
// loan also shows what it did to both balance sheets); later ones a small note; once the town is
// big, only the news ticker. Nothing here stops the clock.

import { button, glyph, h, iconButton } from '../../../ui';
import { fmtMoney } from '../../../sim/format';
import type { Milestone } from '../../../sim/genesis/types';
import type { UIContext } from '../context';
import { tAccounts } from './situations';

export interface MilestoneUi {
  /** Show banners for milestones reached since the last call. */
  scan(): void;
  reset(): void;
}

export function installMilestones(ctx: UIContext, trace: (agent: number) => void): MilestoneUi {
  const game = ctx.game;
  const wrap = h('div', { class: 'gn-banners' });
  document.body.append(wrap);
  let seen = 0;
  const queue: Milestone[] = [];
  let showing: HTMLElement | null = null;

  const show = (m: Milestone) => {
    const eco = game.eco;
    const g = eco.genesis!;
    let extra: HTMLElement | null = null;
    if (m.key === 'first_loan') {
      const l = [...eco.loans.values()][0];
      if (l) extra = tAccounts(eco.nameOf(l.originatorId), eco.nameOf(l.borrowerId), l.principal0, 0);
    }
    const agent = m.agent;
    const el = h(
      'div',
      { class: 'gn-banner mi-ui' },
      h('div', { class: 'gn-banner-head' }, h('span', { class: 'gn-banner-star' }, '★'), h('span', { class: 'gn-banner-title' }, m.title), h('span', { class: 'gn-banner-star' }, '★'), iconButton(glyph('close'), 'Dismiss', () => done(), { small: true })),
      h('div', { class: 'gn-banner-text' }, m.text),
      extra,
      h(
        'div',
        { class: 'gn-banner-actions' },
        h('span', { class: 'gn-banner-date' }, `Year ${Math.floor(m.day / 360) + 1} · ${g.counters.loansMade} loan${g.counters.loansMade === 1 ? '' : 's'} · ${fmtMoney(eco.broadMoney())} in town`),
        agent !== undefined && eco.agents.has(agent) ? button('Show', () => ctx.showAgent(agent), { small: true }) : m.lot !== undefined ? button('Show', () => ctx.showOnMap({ kind: 'lot', id: m.lot! }), { small: true }) : null,
        agent !== undefined && g.lineage.nodes.size ? button('Trace', () => trace(agent), { small: true, primary: true, title: 'Follow what this is connected to' }) : null,
      ),
    );
    let timer = 0;
    const done = () => {
      window.clearTimeout(timer);
      el.classList.add('is-out');
      window.setTimeout(() => {
        el.remove();
        showing = null;
        next();
      }, 250);
    };
    const arm = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(done, ms);
    };
    el.addEventListener('pointerenter', () => window.clearTimeout(timer));
    el.addEventListener('pointerleave', () => arm(5000));
    arm(m.key === 'first_loan' ? 20000 : 11000);
    showing = el;
    wrap.append(el);
    // money appears on the map where it happened
    if (agent !== undefined) {
      const p = ctx.renderer.agentAnchor(agent);
      if (p) ctx.renderer.effects.bursts.push({ x: p.x, y: p.y, t: 0, kind: 'create', size: 3 });
    }
  };

  const next = () => {
    if (showing || !queue.length) return;
    show(queue.shift()!);
  };

  const small = (m: Milestone) => {
    const el = h('div', { class: 'gn-note mi-ui' }, h('span', { class: 'gn-note-star' }, '★'), h('span', { class: 'gn-note-title' }, m.title), h('span', { class: 'gn-note-text' }, m.text));
    wrap.append(el);
    window.setTimeout(() => el.remove(), 8000);
    while (wrap.querySelectorAll('.gn-note').length > 2) wrap.querySelector('.gn-note')?.remove();
  };

  return {
    scan() {
      const g = game.eco.genesis;
      if (!g) return;
      const big = game.eco.population() > 120;
      while (seen < g.milestones.length) {
        const m = g.milestones[seen++];
        if (m.tier === 3) queue.push(m);
        else if (m.tier === 2 && !big) small(m);
      }
      next();
    },
    reset() {
      seen = 0;
      queue.length = 0;
      wrap.replaceChildren();
      showing = null;
    },
  };
}
