// Invariant tests for the simulation core: the books always balance, money is created by
// lending and destroyed by repayment, and runs are deterministic for a given seed.
import { describe, expect, it } from 'vitest';
import { createEconomy } from '../src/sim/setup';
import { checkBooks, originate, payoffLoan, shopForLoan, type LoanApp } from '../src/sim/banking';

const run = (seed: number, days: number, tweak?: (e: ReturnType<typeof createEconomy>) => void) => {
  const eco = createEconomy({ seed, banks: 4, scenario: 'classic' });
  eco.recordVisuals = false;
  tweak?.(eco);
  for (let d = 0; d < days; d++) eco.step();
  return eco;
};

describe('accounting', () => {
  it('balance sheets reconcile every day for three years', () => {
    const eco = createEconomy({ seed: 11, banks: 4, scenario: 'classic' });
    eco.recordVisuals = false;
    eco.checkInvariants = true; // throws on the first violation
    for (let d = 0; d < 3 * 360; d++) eco.step();
    expect(checkBooks(eco)).toEqual([]);
  });

  it('books survive a crisis (rate shock, fragile banks, no deposit insurance)', () => {
    const eco = createEconomy({ seed: 5, banks: 4, scenario: 'fragile' });
    eco.recordVisuals = false;
    eco.checkInvariants = true;
    eco.policy.depositInsurance = 'none';
    for (let d = 0; d < 4 * 360; d++) {
      if (d === 400) eco.policy.policyRate = 0.1;
      eco.step();
    }
    expect(checkBooks(eco)).toEqual([]);
  });

  it('broad money equals the sum of all deposit accounts', () => {
    const eco = run(3, 500);
    let sum = 0;
    for (const b of eco.banks) sum += b.deposits;
    expect(eco.broadMoney()).toBeCloseTo(sum, 2);
  });
});

describe('endogenous money', () => {
  it('a new loan creates a deposit; repaying it destroys the money', () => {
    const eco = run(2, 30);
    const h = eco.households.find((x) => !x.departed && x.employed && x.acct.balance > 2000)!;
    const app: LoanApp = {
      borrower: h,
      kind: 'consumer',
      purpose: 'durables',
      amount: 5000,
      termMonths: 24,
      amortizing: true,
      collateral: { kind: 'none', value: 0 },
      income: h.wage,
      existingDebtService: 0,
      existingDebt: 0,
      what: 'test loan',
    };
    const d = shopForLoan(eco, app);
    expect(d.offer).toBeDefined();
    const m0 = eco.broadMoney();
    const dep0 = h.acct.balance;
    const loan = originate(eco, d.offer!, app);
    expect(h.acct.balance - dep0).toBeCloseTo(5000, 6);
    expect(eco.broadMoney() - m0).toBeCloseTo(5000, 6);
    const m1 = eco.broadMoney();
    payoffLoan(eco, loan, h);
    expect(m1 - eco.broadMoney()).toBeCloseTo(5000, 6);
    expect(checkBooks(eco)).toEqual([]);
  });
});

describe('behaviour', () => {
  it('is deterministic for a given seed', () => {
    const a = run(7, 400);
    const b = run(7, 400);
    expect(a.broadMoney()).toBe(b.broadMoney());
    expect(a.totalCredit()).toBe(b.totalCredit());
    expect(a.market.cpi).toBe(b.market.cpi);
  });

  it('monetary policy changes how the economy evolves', () => {
    const easy = run(4, 3 * 360, (e) => (e.policy.policyRate = 0.01));
    const tight = run(4, 3 * 360, (e) => (e.policy.policyRate = 0.09));
    expect(easy.totalCredit()).toBeGreaterThan(tight.totalCredit());
  });
});
