// The city advisor: one-off tips that explain what the player is seeing the first time it
// happens (new money, securitisation, a default, a run...). Never more than one every few weeks.

import type { SimEvent } from '../../sim/types';
import { fmtMoney, pct } from '../../sim/format';
import type { UIContext } from './context';
import type { Hud } from './hud';

export class Advisor {
  private seen = new Set<string>();
  private lastDay = -999;
  enabled = true;

  constructor(
    private ctx: UIContext,
    private hud: Hud,
  ) {
    ctx.game.on.newGame.push(() => {
      this.seen.clear();
      this.lastDay = -999;
    });
  }

  private say(id: string, text: string, show?: () => void, urgent = false): boolean {
    if (!this.enabled || this.seen.has(id)) return false;
    const day = this.ctx.game.eco.day;
    if (!urgent && day - this.lastDay < 25) return false;
    this.seen.add(id);
    this.lastDay = day;
    this.hud.tip(text, show);
    return true;
  }

  /**
   * Genesis Mode: tips about where things are, never about what to do — the player finds out
   * what their choices lead to by living with them.
   */
  private genesisTips(): void {
    const eco = this.ctx.game.eco;
    const g = eco.genesis!;
    const ctx = this.ctx;
    const loans = g.counters.loansMade;
    if (loans >= 1 && eco.day >= 3)
      this.say('g-flow', `Watch the green coins: that is the loan’s new money being spent. When a borrower pays across the river, the money leaves town — and the bank must hand over reserves to settle it.`);
    if (g.hasFlag('first_business'))
      this.say('g-trace', `Press T (or the 🔍 button) to trace anything: the town dims and what it is connected to lights up — gold for direct relationships, blue for what followed further on.`, () => {
        const b = eco.bank(g.genesisBankId);
        if (b) ctx.showAgent(b.id);
      });
    if (g.decisions.length >= 3 && eco.day > 200) this.say('g-journal', `The town journal (J) keeps every decision you have made, and how the town has changed since each one.`);
    if (g.era !== 'transactions') this.say('g-rules', `The banks now decide routine loans themselves, under the lending rules at the Reserve Bank (B → Lending rules). You can change them at any time.`, () => ctx.open({ kind: 'cb' }), true);
    if (eco.households.some((h) => !h.departed && h.lodging))
      this.say('g-lodge', `Newcomers have come for jobs with nowhere to live: they board with families until homes are built. Families, employers and builders all ask for loans to build them.`);
    if (g.open().length >= 2) this.say('g-desk', `Decisions that need you wait on your desk (K). Some stop the clock; the others are decided by the bank if you leave them too long.`);
  }

  /** Called once per simulated day with that day's events. */
  onDay(events: SimEvent[]): void {
    const eco = this.ctx.game.eco;
    const ctx = this.ctx;
    if (eco.genesis) {
      this.genesisTips();
      return;
    }
    if (eco.day >= 2) this.say('welcome', `Welcome to ${eco.city.name}! Green coins are new money — banks create it when they lend. Red coins are loan repayments: money being destroyed. Click any building to look inside.`);
    for (const e of events) {
      switch (e.type) {
        case 'loan_approved':
          if ((e.amount ?? 0) >= 60_000 && eco.day > 10)
            this.say('big-loan', `${eco.nameOf(e.other ?? -1)} just lent ${fmtMoney(e.amount ?? 0)} to ${eco.nameOf(e.agent)}. That money did not exist a moment ago — the loan created it as a new deposit.`, () => ctx.showAgent(e.agent));
          break;
        case 'construction_start':
          this.say('build', `Construction is starting — paid for with borrowed money. Click the building site to see who financed it and why.`, () => ctx.showAgent(e.agent));
          break;
        case 'securitization':
          this.say('sec', `${eco.nameOf(e.agent)} bundled mortgages into a security and sold it to investors. The loans left its books, so it can lend again — but who holds the risk now? Look inside Meridian Capital.`, () => ctx.showAgent(eco.fund.id));
          break;
        case 'default':
          this.say('default', `A borrower has defaulted. The loss comes straight out of the lender’s equity — open the bank and watch its capital ratio.`, () => ctx.showAgent(e.other ?? e.agent));
          break;
        case 'bank_run':
          this.say('run', `Depositors are running on ${eco.nameOf(e.agent)}! Banks never hold enough cash for everyone at once. Without enough liquid assets or emergency loans, even a solvent bank can fail.`, () => ctx.showAgent(e.agent), true);
          break;
        case 'bank_fail':
          this.say('fail', `${eco.nameOf(e.agent)} has failed. Open it to see why, who took over its loans and deposits, and whether depositors lost money.`, () => ctx.showAgent(e.agent), true);
          break;
        case 'foreclosure':
          this.say('foreclose', `A family lost their home to foreclosure. The bank now owns it and will sell it, often at a discount — and that pulls house prices down.`, () => ctx.showAgent(e.agent));
          break;
      }
    }
    const st = eco.stats;
    if (st.length > 13) {
      const cg = st.last('creditGrowth');
      const u = st.last('unemployment');
      const infl = st.last('inflation');
      if (cg > 0.1) this.say('boom', `Credit is booming: ${pct(cg)} more lending than a year ago. Booms feel great until borrowers can’t keep up. You could raise interest rates at the Reserve Bank (B).`, () => ctx.open({ kind: 'cb' }));
      if (u > 0.1) this.say('slump', `Recession: ${pct(u)} of workers are jobless. Scared banks lend less, so repayments destroy money faster than new loans create it. Cutting rates or buying assets can help.`, () => ctx.open({ kind: 'cb' }));
      if (infl > 0.06) this.say('infl', `Inflation is ${pct(infl)}. Spending is outrunning what firms can produce. Higher rates slow borrowing and cool demand.`, () => ctx.open({ kind: 'cb' }));
    }
    if (eco.day > 75) this.say('lens', 'Try the lenses in the top-left corner (or press L). “Origin” shows which bank created the money now sitting in each building.');
  }
}
