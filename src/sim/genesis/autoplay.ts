// A scripted player for Genesis Mode, used by the headless runner and the tests.
//   bank  = always go along with the bank's own view (and every default)
//   yes   = approve every loan as asked
//   big   = approve everything at the largest size offered
//   small = approve everything at the smallest size offered
//   no    = turn every loan down

import type { Economy } from '../economy';

export type AutoStyle = 'bank' | 'yes' | 'no' | 'big' | 'small';

/** Decide every open situation the way `style` would. Returns a line per decision. */
export function autoPlay(eco: Economy, style: AutoStyle, skip?: string): string[] {
  const g = eco.genesis!;
  const log: string[] = [];
  for (const s of g.open()) {
    if (s.kind === skip) continue;
    if (s.kind === 'loan' && s.loan) {
      const r = s.loan;
      const c = { ...r.suggested };
      if (style === 'no') c.approve = false;
      else if (style !== 'bank') {
        c.approve = true;
        if (style === 'big') c.amount = r.sizes[r.sizes.length - 1] ?? c.amount;
        if (style === 'small') c.amount = r.sizes[0] ?? c.amount;
        if (r.home) c.amount = r.requested;
      }
      let err = g.decideLoan(s.id, c);
      if (err && c.approve) {
        // fall back to the request as made, then to a refusal
        err = g.decideLoan(s.id, { ...r.suggested, approve: true, amount: r.requested });
        if (err) err = g.decideLoan(s.id, { ...r.suggested, approve: false });
      }
      log.push(`${s.title} -> ${s.outcome ?? err}${!c.approve && r.bankReason ? ` [bank: ${r.bankReason}]` : ''}`);
    } else if (s.options?.length) {
      const pick = s.fallback ?? s.options.find((o) => !o.disabled)!.id;
      g.decideAction(s.id, pick);
      log.push(`${s.title} -> ${pick}: ${s.outcome}`);
    }
  }
  return log;
}
