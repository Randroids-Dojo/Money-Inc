// Genesis Mode UI: the desk of decisions, the money ledger, milestone banners, the journal and
// trace mode. Installed once; it switches itself on and off with the scenario of the city.

import './genesis.css';
import { button, h, iconButton, stat } from '../../../ui';
import { fmtMoney } from '../../../sim/format';
import { ERA_INFO, type Situation } from '../../../sim/genesis/types';
import type { UIContext } from '../context';
import type { Hud } from '../hud';
import { deadlineText, KIND_ICON, openDesk, openSituation, setDecisionListener } from './situations';
import { installMilestones } from './milestones';
import { createLedger } from './ledger';
import { createTrace, type TraceController } from './trace';
import { openJournal } from './journal';

export interface GenesisUi {
  openDesk(): void;
  openJournal(): void;
  trace: TraceController;
  /** true when the current city is a Genesis city */
  active(): boolean;
}

export function installGenesisUi(ctx: UIContext, hud: Hud): GenesisUi {
  const game = ctx.game;
  let seenSit = 0;
  let wasActive = false;
  const ledger = createLedger(ctx, (px) => hud.setAlertsTop(px ? px + 16 : 0));
  const trace = createTrace(ctx);
  const milestones = installMilestones(ctx, (agent) => trace.openAgent(agent));
  const journal = (tab?: string) => openJournal(ctx, { trace: (k) => trace.open(k) }, tab);

  // ---- HUD: the desk (with a count of what is waiting), then the mode's own indicators
  const deskBadge = h('span', { class: 'gm-count' });
  deskBadge.hidden = true;
  const deskBtn = iconButton('🗂️', 'Your desk: decisions waiting for you (K)', () => openDesk(ctx), { small: true });
  deskBtn.classList.add('gm-has-badge');
  deskBtn.append(deskBadge);
  const tools = h(
    'div',
    { class: 'mi-row gn-tools' },
    deskBtn,
    iconButton('📜', 'Town journal: your decisions, the firsts, the first bank (J)', () => journal(), { small: true }),
    iconButton('🔍', 'Trace mode: follow what anything is connected to (T)', () => trace.toggle(), { small: true }),
  );

  const stats = (): HTMLElement[] => {
    const eco = game.eco;
    const g = eco.genesis!;
    const open = g.open();
    const n = open.length;
    deskBadge.hidden = n === 0;
    const label = String(n);
    if (deskBadge.textContent !== label) deskBadge.textContent = label;
    deskBtn.classList.toggle('gn-urgent', open.some((s) => s.blocking));
    ledger.update();
    const firms = eco.firms.filter((f) => f.status === 'open').length;
    return [
      stat('Money', fmtMoney(eco.broadMoney()), null, { tip: 'All the deposits in town. It only exists because banks lent it into being — or because it arrived from outside.' }),
      stat('Lent', fmtMoney(g.counters.originated), null, { tip: `Every loan the town's banks have ever made: ${g.counters.loansMade}.` }),
      stat('Households', String(eco.population()), null, { tip: 'Households living in town (including newcomers boarding with families).' }),
      stat('Businesses', String(firms), null, { tip: 'Businesses open for trade.' }),
      stat('Era', ERA_INFO[g.era].title, null, { tip: ERA_INFO[g.era].blurb }),
    ];
  };

  // ---- non-blocking decisions arrive as a small note, never as a modal
  const toasts = h('div', { class: 'gn-toasts' });
  document.body.append(toasts);
  const toast = (s: Situation) => {
    const g = game.eco.genesis!;
    const el = h(
      'div',
      { class: 'gn-toast mi-ui' },
      h('span', { class: 'gn-toast-icon' }, KIND_ICON[s.kind]),
      h('div', { class: 'gn-toast-main' }, h('div', { class: 'gn-toast-title' }, s.title), h('div', { class: 'gn-toast-sub' }, deadlineText(g, s))),
      s.lotId >= 0 ? button('Show', () => ctx.showOnMap({ kind: 'lot', id: s.lotId }), { small: true }) : null,
      button('Decide', () => {
        openSituation(ctx, s.id);
        el.remove();
      }, { small: true, primary: true }),
    );
    toasts.prepend(el);
    while (toasts.children.length > 3) toasts.lastElementChild?.remove();
    window.setTimeout(() => el.remove(), 14000);
  };

  const scan = () => {
    const g = game.eco.genesis;
    if (!g) return;
    for (const s of g.situations) {
      if (s.id <= seenSit) continue;
      seenSit = Math.max(seenSit, s.id);
      if (s.status !== 'open') continue;
      if (!s.blocking) toast(s);
      ctx.renderer.invalidate();
    }
  };

  // ---- a decision that stops the clock opens by itself
  const attend = () => {
    const g = game.eco.genesis;
    if (!g) return;
    scan();
    const s = g.open().find((x) => x.blocking);
    if (!s) return;
    if (s.lotId >= 0) ctx.showOnMap({ kind: 'lot', id: s.lotId });
    openSituation(ctx, s.id);
  };

  setDecisionListener(() => {
    ctx.renderer.invalidate();
    milestones.scan();
    ledger.update();
    trace.refresh();
    // another decision may be holding up time
    const g = game.eco.genesis;
    if (g && g.open().some((x) => x.blocking)) window.setTimeout(attend, 50);
  });

  const sync = () => {
    const on = !!game.eco.genesis;
    if (on === wasActive) return;
    wasActive = on;
    hud.setMode(on ? tools : null, on ? stats : null);
    toasts.replaceChildren();
    seenSit = 0;
    milestones.reset();
    ledger.setVisible(on);
  };

  game.on.newGame.push(() => {
    wasActive = !game.eco.genesis;
    sync();
    if (game.eco.genesis) window.setTimeout(attend, 400);
  });
  game.on.day.push(() => {
    if (!game.eco.genesis) return;
    scan();
    milestones.scan();
  });
  game.on.attention.push(attend);
  game.on.month.push(() => trace.refresh());
  wasActive = !game.eco.genesis;
  sync();

  return {
    trace,
    openJournal: () => {
      if (game.eco.genesis) journal();
    },
    openDesk: () => {
      if (game.eco.genesis) openDesk(ctx);
    },
    active: () => !!game.eco.genesis,
  };
}
