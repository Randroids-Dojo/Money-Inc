// Bank failure and resolution. A failed bank is not simply deleted: its losses are
// allocated (shareholders, bondholders, uninsured depositors, the deposit insurer), its
// deposits, loans and securities move to an acquiring bank, and the shock propagates
// through fear, interbank stress and asset prices. Later, investors may charter a new bank.

import { CFG, DAYS_PER_MONTH } from './config';
import type { Economy } from './economy';
import { Bank, newPL, netIncome, type BankPersonality } from './bank';
import { allAccounts, addBonds, invalidateMetrics, metrics } from './banking';
import { INSURANCE_LIMITS } from './types';
import { fmtMoney, pct } from './format';
import { fire } from './markets';
import { bankIdentity } from './names';
import { MAX_ORIGINS, FIRST_BANK_ORIGIN } from './ledger';

export function failBank(eco: Economy, b: Bank, kind: 'insolvency' | 'liquidity'): void {
  if (!b.alive) return;
  const others = eco.aliveBanks().filter((x) => x !== b);
  if (!others.length) {
    rescueLastBank(eco, b, kind);
    return;
  }
  const m0 = metrics(eco, b);
  // --- 1. fair-value marks on the loan book
  for (const l of b.loans) {
    if (!l.active) continue;
    const mark = l.status === 'performing' ? 0.02 : l.status === 'late' ? 0.25 : 0.45;
    const target = Math.max(l.provision, l.balance * mark);
    b.pl.provisions += target - l.provision;
    l.provision = target;
  }
  let m = metrics(eco, b);
  let E = m.equity;
  // --- 2. bail in bondholders
  if (E < 0 && b.bondsIssued > 0) {
    const w = Math.min(b.bondsIssued, -E);
    b.bondsIssued -= w;
    const held = eco.fund.bankBonds.get(b.id) ?? 0;
    eco.fund.bankBonds.set(b.id, Math.max(0, held - w));
    b.pl.securitiesGains += w;
    E += w;
  }
  // --- 3. who absorbs the rest
  const limit = INSURANCE_LIMITS[eco.policy.depositInsurance];
  const accts = allAccounts(eco).filter((a) => a.bank === b);
  let insured = 0;
  for (const a of accts) insured += Math.min(Math.max(0, a.balance), limit);
  const senior = m.cbLoan + m.wholesale;
  const available = Math.max(0, m.assets - senior);
  const rr = b.deposits > 0 ? Math.max(0, Math.min(1, available / b.deposits)) : 1;
  const shortfall = Math.max(0, -E);
  const costFull = shortfall;
  const costPayout = insured * (1 - rr);
  let mode: 'full' | 'haircut' = 'full';
  if (shortfall > 0 && eco.policy.depositInsurance !== 'unlimited' && costFull > costPayout * 1.25 + 1) mode = 'haircut';
  let depositorLoss = 0;
  if (mode === 'haircut') {
    for (const a of accts) {
      const unins = Math.max(0, a.balance - limit);
      const loss = unins * (1 - rr);
      if (loss <= 0) continue;
      writeDownDeposit(eco, a, loss);
      depositorLoss += loss;
    }
    b.pl.securitiesGains += depositorLoss;
    E += depositorLoss;
  }
  let difPaid = 0;
  // the acquirer must be able to keep lending: the insurer tops the book up to a sound
  // capital level (an "assisted acquisition")
  const mAfter = metrics(eco, b);
  const soundEquity = (eco.policy.capitalRequirement + 0.02) * mAfter.rwa;
  if (E < soundEquity && shortfall > 0) E -= soundEquity;
  if (E < 0) {
    difPaid = -E;
    eco.ledger.publicToBank('dif', b, difPaid, 'resolution');
    eco.dif.paidOutCum += difPaid;
    b.paidIn += difPaid; // capital assistance so the acquirer takes a balanced book
    E = 0;
    // the deposit insurer borrows from the Treasury if its fund is exhausted
    if (eco.publicBalances.dif < 0) {
      const need = -eco.publicBalances.dif;
      eco.publicBalances.treasury -= need;
      eco.publicBalances.dif += need;
      eco.dif.borrowedFromTreasury += need;
    }
  }
  // --- 4. acquirer takes over everything
  const acq = others.reduce((a, x) => {
    const ma = metrics(eco, a);
    const mx = metrics(eco, x);
    return mx.capitalRatio - x.stress * 0.1 > ma.capitalRatio - a.stress * 0.1 ? x : a;
  });
  // short-term secured creditors are paid off at resolution rather than passed on to the
  // acquirer (where they would run immediately); the central bank funds it against the assets
  settleWholesale(eco, b);
  transferBook(eco, b, acq);
  if (E > 1) {
    // a solvent bank killed by a run: its shareholders are paid for the equity left
    const price = E * 0.8;
    eco.ledger.bankPay(acq, eco.fund.acct, price, 'capital');
    acq.retained -= price;
  }
  // --- 5. shock
  b.status = 'failed';
  b.failedDay = eco.day;
  b.failureKind = kind;
  b.acquiredBy = acq.id;
  b.stance = 'frozen';
  eco.lastFailureDay = eco.day;
  eco.monthCounters.bankFailures++;
  eco.market.panic = Math.min(1, eco.market.panic + 0.45);
  eco.market.interbankStress = Math.min(1, eco.market.interbankStress + 0.6);
  for (const o of others) o.fear = Math.min(1, o.fear + 0.25);
  eco.fund.fear = Math.min(1, eco.fund.fear + 0.2);
  for (const hid of b.employees.slice()) {
    const h = eco.household(hid);
    if (h) fire(eco, h, `${b.name} failed`);
  }
  b.employees = [];
  const why =
    kind === 'liquidity'
      ? `it ran out of cash to meet withdrawals and payments`
      : `losses wiped out its capital (capital ratio ${pct(m0.capitalRatio)})`;
  b.log(eco.day, `FAILED: ${why}`, 'bad');
  const cover =
    mode === 'haircut'
      ? `Uninsured depositors lost ${fmtMoney(depositorLoss)} (${pct(1 - rr, 0)} of balances above the insured limit).`
      : difPaid > 0
        ? `The deposit insurer paid ${fmtMoney(difPaid)} so every depositor was protected.`
        : `Its shareholders absorbed the losses.`;
  eco.headline(`${b.name} has FAILED: ${why}. ${acq.name} takes over its accounts and loans. ${cover}`, 'alert', b.id, undefined, `fail-${b.id}`, 0);
  eco.event('bank_fail', b.id, m0.assets, acq.id, kind);
  acq.log(eco.day, `Took over ${b.name}'s deposits and loans after it failed`, 'neutral');
  invalidateMetrics(b);
  invalidateMetrics(acq);
}

function settleWholesale(eco: Economy, b: Bank): void {
  const total = b.wholesale.reduce((x, w) => x + w.amount, 0);
  if (total <= 0) return;
  const need = total - Math.max(0, b.reserves);
  if (need > 0) {
    b.cbLoan += need;
    b.reserves += need;
    b.cbLoanEmergency = true;
    eco.cb.loansToBanks.set(b.id, b.cbLoan);
  }
  for (const w of b.wholesale.slice()) {
    if (w.lenderKind === 'bank') {
      const lender = eco.bank(w.lenderId);
      if (lender) {
        eco.ledger.interbank(b, lender, w.amount, 'resolution');
        lender.interbankLent = lender.interbankLent.filter((x) => x !== w);
      }
    } else {
      eco.ledger.bankPay(b, eco.fund.acct, w.amount, 'resolution');
      eco.fund.repos = eco.fund.repos.filter((x) => x !== w);
    }
  }
  b.wholesale = [];
}

/** Destroy part of a deposit (uninsured depositors' loss in a failure). */
function writeDownDeposit(eco: Economy, a: ReturnType<typeof allAccounts>[number], loss: number): void {
  const amt = Math.min(loss, a.balance);
  if (amt <= 0) return;
  const f = amt / a.balance;
  for (let k = 0; k < MAX_ORIGINS; k++) a.origin[k] -= a.origin[k] * f;
  a.balance -= amt;
  a.bank.deposits -= amt;
  eco.flowsMonth.writeDowns += amt;
  const owner = eco.agents.get(a.ownerId);
  if (owner && (owner.kind === 'household' || owner.kind === 'firm')) owner.note(eco.day, `Lost ${fmtMoney(amt)} of uninsured deposits when ${a.bank.name} failed`, 'bad', amt, a.bank.id);
}

/** Move a failed bank's entire book to the acquirer. */
function transferBook(eco: Economy, b: Bank, acq: Bank): void {
  const mB = metrics(eco, b);
  const unrealizedB = mB.unrealized;
  const carriedEquity = b.paidIn + b.retained + netIncome(b.pl);
  // deposits (and matching reserves)
  for (const a of allAccounts(eco)) if (a.bank === b) eco.ledger.moveAccount(a, acq, 'resolution');
  acq.reserves += b.reserves;
  b.reserves = 0;
  // loans held
  for (const l of b.loans) {
    if (!l.active) continue;
    l.holder = { kind: 'bank', id: acq.id };
    l.servicerId = acq.id;
    acq.loans.push(l);
    l.note(eco.day, `${b.name} failed; the loan now belongs to ${acq.name}`, l.balance, acq.id, 'bad');
  }
  b.loans = [];
  // loans serviced for others
  for (const l of eco.loans.values()) if (l.active && l.servicerId === b.id) l.servicerId = acq.id;
  // securities
  acq.bills += b.bills;
  b.bills = 0;
  if (b.bondPar > 0) addBonds(acq, b.bondPar, b.bondBook, b.bondCoupon);
  b.bondPar = 0;
  b.bondBook = 0;
  for (const [pid, h] of b.mbs) {
    const e = acq.mbs.get(pid);
    if (e) {
      const nf = e.frac + h.frac;
      e.bookRatio = (e.bookRatio * e.frac + h.bookRatio * h.frac) / nf;
      e.frac = nf;
    } else acq.mbs.set(pid, { ...h });
  }
  b.mbs.clear();
  for (const [k, v] of b.reo) acq.reo.set(k, v);
  for (const [k, v] of b.reoLots) acq.reoLots.set(k, v);
  for (const u of eco.units) if (u.ownerId === b.id) u.ownerId = acq.id;
  for (const u of eco.units) if (u.listing && u.listing.seller === b.id) u.listing.seller = acq.id;
  b.reo.clear();
  b.reoLots.clear();
  // interbank positions
  for (const w of b.interbankLent) {
    if (w.borrowerId === acq.id) {
      // acquirer owed the failed bank: the claim cancels out
      acq.wholesale = acq.wholesale.filter((x) => x !== w);
      continue;
    }
    w.lenderId = acq.id;
    acq.interbankLent.push(w);
  }
  b.interbankLent = [];
  for (const w of b.wholesale) {
    if (w.lenderId === acq.id) {
      acq.interbankLent = acq.interbankLent.filter((x) => x !== w);
      continue;
    }
    w.borrowerId = acq.id;
    acq.wholesale.push(w);
  }
  b.wholesale = [];
  // wholesale claims between acq and b cancel: fix any residual in lender lists of others
  for (const o of eco.banks) for (const w of o.interbankLent) if (w.borrowerId === b.id) w.borrowerId = acq.id;
  for (const w of eco.fund.repos) if (w.borrowerId === b.id) w.borrowerId = acq.id;
  // central bank borrowing
  if (b.cbLoan > 0) {
    acq.cbLoan += b.cbLoan;
    acq.cbLoanEmergency = acq.cbLoanEmergency || b.cbLoanEmergency;
    eco.cb.loansToBanks.set(acq.id, acq.cbLoan);
    eco.cb.loansToBanks.delete(b.id);
    b.cbLoan = 0;
  }
  if (b.bondsIssued > 0) {
    acq.bondsIssuedCoupon = (acq.bondsIssuedCoupon * acq.bondsIssued + b.bondsIssuedCoupon * b.bondsIssued) / (acq.bondsIssued + b.bondsIssued);
    acq.bondsIssued += b.bondsIssued;
    eco.fund.bankBonds.set(acq.id, (eco.fund.bankBonds.get(acq.id) ?? 0) + (eco.fund.bankBonds.get(b.id) ?? 0));
    eco.fund.bankBonds.delete(b.id);
    b.bondsIssued = 0;
  }
  // equity bookkeeping: the acquirer's equity rises by the carried equity (≈0 after assistance)
  acq.retained += carriedEquity;
  b.paidIn = 0;
  b.retained = 0;
  b.pl = newPL();
  void unrealizedB;
  invalidateMetrics(acq);
}

/** The last bank standing is never allowed to disappear: the Treasury recapitalises it. */
function rescueLastBank(eco: Economy, b: Bank, kind: 'insolvency' | 'liquidity'): void {
  const m = metrics(eco, b);
  if (kind === 'insolvency' || m.equity < 0) {
    const need = Math.max(0, -m.equity) + (eco.policy.capitalRequirement + 0.03) * m.rwa;
    eco.ledger.publicToBank('treasury', b, need, 'capital');
    b.paidIn += need;
    b.log(eco.day, `Rescued by the Treasury with ${fmtMoney(need)} of public capital`, 'bad');
    eco.headline(`Bailout! The Treasury injects ${fmtMoney(need)} into ${b.name}, the last bank in town`, 'alert', b.id, undefined, `bailout-${b.id}`, 0);
  }
  if (b.reserves < 0) {
    const need = -b.reserves + 0.02 * b.deposits;
    b.cbLoan += need;
    b.reserves += need;
    b.cbLoanEmergency = true;
    eco.cb.loansToBanks.set(b.id, b.cbLoan);
    b.log(eco.day, `The Reserve Bank lent ${fmtMoney(need)} to keep the last bank open`, 'bad');
  }
  eco.market.panic = Math.min(1, eco.market.panic + 0.3);
  invalidateMetrics(b);
}

// ============================================================================ new banks

const PERSONALITIES: BankPersonality[] = [
  {
    riskAppetite: 0.45,
    capitalBuffer: 0.03,
    liquidityBuffer: 0.06,
    focus: { business: 0.4, mortgage: 0.45, consumer: 0.15 },
    securitize: 0.3,
    wholesale: 0.3,
    growth: 0.1,
    payout: 0.5,
    duration: 0.4,
    depositBeta: 0.55,
    blurb: 'A newly chartered bank backed by Meridian money, keen to win customers.',
  },
];

export function charterMonthly(eco: Economy): void {
  const alive = eco.aliveBanks();
  if (alive.length >= eco.initialBankCount) return;
  if (eco.day - eco.lastFailureDay < DAYS_PER_MONTH * 18 || eco.day - eco.lastCharterDay < DAYS_PER_MONTH * 12) return;
  const f = eco.fund;
  const sysAssets = alive.reduce((s, x) => s + metrics(eco, x).assets, 0);
  const capital = Math.max(400_000, sysAssets * 0.035);
  if (f.acct.balance < capital * 1.3 || f.fear > 0.45 || eco.market.panic > 0.2) return;
  // a free bank lot: a failed bank's old building or an unused reserved lot
  const failed = eco.banks.find((x) => !x.alive && !eco.banks.some((y) => y.alive && y.lotId === x.lotId));
  let lotId = failed ? failed.lotId : -1;
  if (lotId < 0) {
    const used = new Set(eco.banks.map((x) => x.lotId));
    const lot = eco.city.lots.find((l) => l.reserved === 'bank' && !used.has(l.id));
    if (!lot) return;
    lotId = lot.id;
  }
  const origin = FIRST_BANK_ORIGIN + eco.banks.length;
  if (origin >= MAX_ORIGINS) return;
  const ident = bankIdentity(eco.rng, eco.banks.map((x) => x.name));
  const pers = { ...PERSONALITIES[0], riskAppetite: 0.3 + 0.4 * eco.rng.next() };
  const nb = new Bank(eco.newId(), ident.name, ident.short, ident.color, origin, lotId, pers, eco.day);
  nb.depositRate = eco.policy.policyRate * 0.8;
  eco.register(nb);
  eco.banks.push(nb);
  eco.lotUse.set(lotId, { type: 'bank', id: nb.id });
  eco.ledger.payBank(f.acct, nb, capital, 'capital');
  nb.paidIn += capital;
  nb.budget = capital * 2;
  nb.fear = 0.3;
  eco.lastCharterDay = eco.day;
  nb.log(eco.day, `Chartered with ${fmtMoney(capital)} of capital from ${f.name}`, 'good');
  eco.headline(`A new bank opens: ${nb.name}, capitalised with ${fmtMoney(capital)}`, 'good', nb.id, undefined, `charter-${nb.id}`, 0);
  void CFG;
}
