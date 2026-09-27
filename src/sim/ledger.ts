// The ledger moves money between accounts while keeping every balance sheet consistent.
//
// Money in this economy is (a) deposits: liabilities of commercial banks owed to households,
// firms and the fund, and (b) reserves: liabilities of the central bank owed to commercial
// banks, the Treasury and the deposit insurer. Every movement below is a matched pair of
// entries, so the invariants checked in tests hold at all times:
//   sum(accounts at bank B) == B.deposits
//   CB reserve liabilities == sum(bank reserves) + Treasury account + DIF account
//
// Each deposit account also carries a provenance vector: how much of its balance was
// created by each bank's lending/spending, by the public sector, or pre-dates the game.

import type { Bank } from './bank';
import type { FlowKind } from './types';

export const MAX_ORIGINS = 16;
export const ORIGIN_LEGACY = 0;
export const ORIGIN_PUBLIC = 1;
export const FIRST_BANK_ORIGIN = 2;

export class Account {
  balance = 0;
  readonly origin = new Float64Array(MAX_ORIGINS);
  constructor(
    public readonly ownerId: number,
    public bank: Bank,
  ) {}
}

/** Hooks the ledger calls so the economy can record flows and statistics. */
export interface LedgerHost {
  recordFlow(from: number, to: number, amount: number, kind: FlowKind, loan?: number): void;
  recordSettlement(from: Bank, to: Bank, amount: number): void;
  recordCreation(amount: number, kind: FlowKind, origin: number): void;
  /** `sink`: who received the payment that extinguished the deposit */
  recordDestruction(amount: number, kind: FlowKind, origins: Float64Array | null, sink: MoneySink): void;
  treasuryId: number;
  difId: number;
  cbId: number;
  /** central-bank account balances of the Treasury and the deposit insurer */
  publicBalances: { treasury: number; dif: number };
}

export type PublicEntity = 'treasury' | 'dif' | 'cb';
/** Where destroyed deposit money went: a bank, the public sector, or out of town (Genesis Mode). */
export type MoneySink = 'bank' | 'public' | 'outside';

const scratch = new Float64Array(MAX_ORIGINS);

export class Ledger {
  constructor(private host: LedgerHost) {}

  private publicId(p: PublicEntity): number {
    return p === 'treasury' ? this.host.treasuryId : p === 'dif' ? this.host.difId : this.host.cbId;
  }

  /** Remove `amt` from an account's provenance vector proportionally; result left in `scratch`. */
  private debitOrigin(acct: Account, amt: number): Float64Array {
    const bal = acct.balance;
    const o = acct.origin;
    if (bal <= 0) {
      scratch.fill(0);
      scratch[ORIGIN_LEGACY] = amt;
      return scratch;
    }
    const f = Math.min(1, amt / bal);
    for (let k = 0; k < MAX_ORIGINS; k++) {
      const v = o[k] * f;
      scratch[k] = v;
      o[k] -= v;
    }
    return scratch;
  }

  /** Deposit money moves between two non-bank accounts (possibly at different banks). */
  transfer(from: Account, to: Account, amount: number, kind: FlowKind, loan?: number): number {
    const amt = Math.min(amount, from.balance);
    if (!(amt > 0) || from === to) return 0;
    const moved = this.debitOrigin(from, amt);
    const o = to.origin;
    for (let k = 0; k < MAX_ORIGINS; k++) o[k] += moved[k];
    from.balance -= amt;
    to.balance += amt;
    if (from.bank !== to.bank) {
      from.bank.deposits -= amt;
      to.bank.deposits += amt;
      from.bank.reserves -= amt;
      to.bank.reserves += amt;
      this.host.recordSettlement(from.bank, to.bank, amt);
    }
    this.host.recordFlow(from.ownerId, to.ownerId, amt, kind, loan);
    return amt;
  }

  /**
   * A non-bank pays a bank (loan principal, interest, fees, or buying an asset from it).
   * The deposit is extinguished: broad money shrinks. The caller books the bank's side
   * (income, or the reduction of a loan/securities asset).
   */
  payBank(from: Account, bank: Bank, amount: number, kind: FlowKind, loan?: number): number {
    const amt = Math.min(amount, from.balance);
    if (!(amt > 0)) return 0;
    const destroyed = this.debitOrigin(from, amt);
    this.host.recordDestruction(amt, kind, destroyed, 'bank');
    from.balance -= amt;
    from.bank.deposits -= amt;
    if (from.bank !== bank) {
      from.bank.reserves -= amt;
      bank.reserves += amt;
      this.host.recordSettlement(from.bank, bank, amt);
    }
    this.host.recordFlow(from.ownerId, bank.id, amt, kind, loan);
    return amt;
  }

  /**
   * A bank pays a non-bank (loan disbursement, wages, deposit interest, dividends, or
   * buying an asset from a non-bank). New deposit money is created. The caller books the
   * bank's side (new loan asset, expense, or acquired asset).
   */
  bankPay(bank: Bank, to: Account, amount: number, kind: FlowKind, loan?: number): void {
    if (!(amount > 0)) return;
    to.origin[bank.originIdx] += amount;
    to.balance += amount;
    to.bank.deposits += amount;
    if (to.bank !== bank) {
      bank.reserves -= amount;
      to.bank.reserves += amount;
      this.host.recordSettlement(bank, to.bank, amount);
    }
    this.host.recordCreation(amount, kind, bank.originIdx);
    this.host.recordFlow(bank.id, to.ownerId, amount, kind, loan);
  }

  /** The Treasury, deposit insurer or central bank pays a non-bank: reserves and deposits rise. */
  publicPay(payer: PublicEntity, to: Account, amount: number, kind: FlowKind): void {
    if (!(amount > 0)) return;
    if (payer === 'treasury') this.host.publicBalances.treasury -= amount;
    else if (payer === 'dif') this.host.publicBalances.dif -= amount;
    to.bank.reserves += amount;
    to.bank.deposits += amount;
    to.balance += amount;
    to.origin[ORIGIN_PUBLIC] += amount;
    this.host.recordCreation(amount, kind, ORIGIN_PUBLIC);
    this.host.recordFlow(this.publicId(payer), to.ownerId, amount, kind);
  }

  /** A non-bank pays the Treasury / deposit insurer / central bank: deposits and reserves fall. */
  payPublic(from: Account, payee: PublicEntity, amount: number, kind: FlowKind): number {
    const amt = Math.min(amount, from.balance);
    if (!(amt > 0)) return 0;
    const destroyed = this.debitOrigin(from, amt);
    this.host.recordDestruction(amt, kind, destroyed, 'public');
    from.balance -= amt;
    from.bank.deposits -= amt;
    from.bank.reserves -= amt;
    if (payee === 'treasury') this.host.publicBalances.treasury += amt;
    else if (payee === 'dif') this.host.publicBalances.dif += amt;
    this.host.recordFlow(from.ownerId, this.publicId(payee), amt, kind);
    return amt;
  }

  /** Reserves move between two banks (interbank loans, securities trades between banks). */
  interbank(from: Bank, to: Bank, amount: number, kind: FlowKind): void {
    if (!(amount > 0) || from === to) return;
    from.reserves -= amount;
    to.reserves += amount;
    this.host.recordSettlement(from, to, amount);
    this.host.recordFlow(from.id, to.id, amount, kind);
  }

  /** Bank pays a public entity from its reserves (taxes, insurance premiums, CB loan repayment). */
  bankToPublic(bank: Bank, payee: PublicEntity, amount: number, kind: FlowKind): void {
    if (!(amount > 0)) return;
    bank.reserves -= amount;
    if (payee === 'treasury') this.host.publicBalances.treasury += amount;
    else if (payee === 'dif') this.host.publicBalances.dif += amount;
    this.host.recordFlow(bank.id, this.publicId(payee), amount, kind);
  }

  /** Public entity credits a bank's reserves (coupons, CB lending, QE purchases, DIF payments). */
  publicToBank(payer: PublicEntity, bank: Bank, amount: number, kind: FlowKind): void {
    if (!(amount > 0)) return;
    bank.reserves += amount;
    if (payer === 'treasury') this.host.publicBalances.treasury -= amount;
    else if (payer === 'dif') this.host.publicBalances.dif -= amount;
    this.host.recordFlow(this.publicId(payer), bank.id, amount, kind);
  }

  /**
   * Genesis Mode: money arrives from banks outside town (export sales, newcomers' savings).
   * The receiving bank gains the reserves that settle the payment and owes a new deposit.
   */
  fromOutside(to: Account, amount: number, kind: FlowKind, fromId: number): void {
    if (!(amount > 0)) return;
    to.bank.reserves += amount;
    to.bank.deposits += amount;
    to.balance += amount;
    to.origin[ORIGIN_LEGACY] += amount;
    this.host.recordCreation(amount, kind, ORIGIN_LEGACY);
    this.host.recordFlow(fromId, to.ownerId, amount, kind);
  }

  /**
   * Genesis Mode: money leaves town (imports, outside contractors, departing savings, deposit
   * flight). The deposit disappears from the town's banks, and so do the reserves that settle it.
   */
  toOutside(from: Account, amount: number, kind: FlowKind, toId: number): number {
    const amt = Math.min(amount, from.balance);
    if (!(amt > 0)) return 0;
    const destroyed = this.debitOrigin(from, amt);
    this.host.recordDestruction(amt, kind, destroyed, 'outside');
    from.balance -= amt;
    from.bank.deposits -= amt;
    from.bank.reserves -= amt;
    this.host.recordFlow(from.ownerId, toId, amt, kind);
    return amt;
  }

  /** Genesis Mode: a bank pays someone outside town out of its reserves (e.g. dividends to its owners). */
  bankToOutside(bank: Bank, amount: number, kind: FlowKind, toId: number): void {
    if (!(amount > 0)) return;
    bank.reserves -= amount;
    this.host.recordFlow(bank.id, toId, amount, kind);
  }

  /** Genesis Mode: reserves arrive at a bank from outside (capital from investors elsewhere). */
  outsideToBank(bank: Bank, amount: number, kind: FlowKind, fromId: number): void {
    if (!(amount > 0)) return;
    bank.reserves += amount;
    this.host.recordFlow(fromId, bank.id, amount, kind);
  }

  /** Move an account to a different bank (depositor switching banks, or a failed bank's book transferring). */
  moveAccount(acct: Account, to: Bank, kind: FlowKind = 'run'): void {
    const from = acct.bank;
    if (from === to) return;
    const amt = acct.balance;
    from.deposits -= amt;
    to.deposits += amt;
    from.reserves -= amt;
    to.reserves += amt;
    acct.bank = to;
    if (amt > 0) {
      this.host.recordSettlement(from, to, amt);
      this.host.recordFlow(from.id, to.id, amt, kind);
    }
  }
}
