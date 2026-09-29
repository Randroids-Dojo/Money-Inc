// Genesis Mode: the town's books balance, the money story adds up, the first loan creates the
// first money, and a run is reproducible from its seed.
import { describe, expect, it } from 'vitest';
import { createEconomy } from '../src/sim/setup';
import { checkBooks } from '../src/sim/banking';
import { autoPlay, type AutoStyle } from '../src/sim/genesis/autoplay';
import { PAUSE_KINDS } from '../src/sim/genesis/types';
import { Game } from '../src/game/game';

const genesis = (seed: number) => {
  const eco = createEconomy({ seed, banks: 1, scenario: 'genesis' });
  eco.recordVisuals = false;
  return eco;
};

const play = (seed: number, days: number, style: AutoStyle, check = false) => {
  const eco = genesis(seed);
  eco.checkInvariants = check;
  for (let d = 0; d < days; d++) {
    autoPlay(eco, style);
    eco.step();
  }
  return eco;
};

describe('Genesis Mode start', () => {
  it('starts with one bank, one business plan, one worker and no money', () => {
    const eco = genesis(3);
    const g = eco.genesis!;
    expect(eco.aliveBanks().length).toBe(1);
    expect(eco.broadMoney()).toBe(0);
    expect([...eco.loans.values()].length).toBe(0);
    expect(eco.households.filter((h) => !h.departed).length).toBe(2);
    const first = g.open().find((s) => s.kind === 'loan');
    expect(first?.blocking).toBe(true);
    expect(first?.loan?.requested).toBe(100_000);
  });

  it('the first loan creates the first money: a loan asset and a deposit of the same size', () => {
    const eco = genesis(3);
    const g = eco.genesis!;
    const s = g.open().find((x) => x.kind === 'loan')!;
    const bank = eco.bank(g.genesisBankId)!;
    const err = g.decideLoan(s.id, { ...s.loan!.suggested, approve: true, amount: 100_000 });
    expect(err).toBeNull();
    expect(bank.loanBook()).toBeCloseTo(100_000, 0);
    expect(bank.deposits).toBeCloseTo(100_000, 0);
    expect(eco.broadMoney()).toBeCloseTo(100_000, 0);
    expect(g.counters.originated).toBeCloseTo(100_000, 0);
    expect(g.milestones.some((m) => m.key === 'first_loan')).toBe(true);
  });

  it('turning the first plan down leaves the town without money, and a smaller plan follows', () => {
    const eco = genesis(3);
    const g = eco.genesis!;
    const s = g.open().find((x) => x.kind === 'loan')!;
    g.decideLoan(s.id, { ...s.loan!.suggested, approve: false });
    let next;
    for (let d = 0; d < 200 && !next; d++) {
      eco.step();
      next = g.open().find((x) => x.kind === 'loan');
    }
    expect(eco.broadMoney()).toBe(0);
    expect(next).toBeDefined();
    expect(next!.blocking).toBe(true);
    expect(next!.loan!.requested).toBeLessThan(100_000);
  });
});

describe('Genesis Mode pauses', () => {
  it('stops the clock for every major event: the big firsts, new eras, licences, banks at their limits', () => {
    const eco = genesis(3);
    const g = eco.genesis!;
    const pausedFor = new Set<string>();
    let milestones = 0;
    let situations = g.situations.length;
    g.pauseRequested = false;
    for (let d = 0; d < 8 * 360; d++) {
      autoPlay(eco, 'yes');
      eco.step();
      const fresh = g.milestones.slice(milestones).filter((m) => m.tier === 3);
      const major = g.situations.slice(situations).filter((s) => PAUSE_KINDS.includes(s.kind) || s.blocking);
      if (fresh.length || major.length) expect(g.pauseRequested).toBe(true);
      for (const s of major) pausedFor.add(s.kind);
      if (major.length) expect(g.situation(g.pauseFor)).toBeDefined();
      milestones = g.milestones.length;
      situations = g.situations.length;
      g.pauseRequested = false;
    }
    expect(pausedFor.has('era')).toBe(true);
  });

  it('carries on once the player has dealt with what stopped the clock, but not after a pause of their own', () => {
    const game = new Game(3, 'genesis');
    game.eco.recordVisuals = false;
    game.setSpeed(2);
    game.tick(0.1);
    // the founding loan stops the clock and holds it
    expect(game.speed).toBe(0);
    expect(game.autoPaused).toBe(true);
    game.resumeAfterEvent();
    expect(game.speed).toBe(0);
    const g = game.eco.genesis!;
    const s = g.open().find((x) => x.blocking)!;
    g.decideLoan(s.id, { ...s.loan!.suggested, approve: true });
    game.resumeAfterEvent();
    expect(game.speed).toBe(2);
    // the first loan is a big first: the clock stops again for its banner, and dismissing it resumes
    game.tick(0.1);
    expect(game.speed).toBe(0);
    game.resumeAfterEvent();
    expect(game.speed).toBe(2);
    // a pause the player made stays a pause
    game.togglePause();
    game.resumeAfterEvent();
    expect(game.speed).toBe(0);
  });
});

describe('Genesis Mode accounting', () => {
  it('balance sheets reconcile every day for six years (bank player)', () => {
    const eco = play(7, 6 * 360, 'bank', true);
    expect(checkBooks(eco)).toEqual([]);
  });

  it('balance sheets reconcile through failures and rescues (approve everything)', () => {
    const eco = play(3, 8 * 360, 'yes', true);
    expect(checkBooks(eco)).toEqual([]);
  });

  it('money = lending - repayment - interest + bank and public spending + trade, exactly', () => {
    for (const style of ['bank', 'yes'] as AutoStyle[]) {
      const eco = play(11, 6 * 360, style);
      const c = eco.genesis!.counters;
      const identity = c.originated - c.principalRepaid - c.interestPaid + c.bankSpending - c.boughtFromBanks + c.publicOut - c.publicIn + c.tradeIn - c.tradeOut;
      expect(identity).toBeCloseTo(eco.broadMoney(), 0);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = play(5, 3 * 360, 'bank');
    const b = play(5, 3 * 360, 'bank');
    expect(a.broadMoney()).toBe(b.broadMoney());
    expect(a.genesis!.lineage.edges.length).toBe(b.genesis!.lineage.edges.length);
    expect(a.genesis!.decisions.map((d) => d.text)).toEqual(b.genesis!.decisions.map((d) => d.text));
  });
});

describe('Genesis Mode growth', () => {
  it('the town grows from its first loan', () => {
    const eco = play(7, 10 * 360, 'bank');
    expect(eco.population()).toBeGreaterThan(10);
    expect(eco.firms.filter((f) => f.status === 'open').length).toBeGreaterThan(1);
    expect(eco.genesis!.counters.loansMade).toBeGreaterThan(10);
  });
});
