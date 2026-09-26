// The player's report card: how well the Reserve Bank is meeting its mandate of stable prices,
// high employment and a sound banking system. Public approval drifts toward a monthly score.

import type { Economy } from '../sim/economy';

export interface MandateState {
  approval: number;
  /** last month's target score and what drove it */
  score: number;
  reasons: { label: string; delta: number }[];
  history: number[];
}

export function newMandate(): MandateState {
  return { approval: 76, score: 76, reasons: [], history: [] };
}

export function updateMandate(m: MandateState, eco: Economy): void {
  const st = eco.stats;
  if (!st.length) return;
  const infl = st.length > 12 ? st.last('inflation') : 0.02;
  const u = st.last('unemployment');
  const hpg = st.length > 12 ? st.last('hpiGrowth') : 0;
  let fails = 0;
  for (let i = 0; i < 12; i++) fails += st.last('bankFailures', i) || 0;
  const reasons: { label: string; delta: number }[] = [];
  const add = (label: string, delta: number) => {
    if (Math.abs(delta) >= 0.5) reasons.push({ label, delta });
    return delta;
  };
  let score = 85;
  score += add(infl > 0.02 ? 'Inflation above 2%' : 'Inflation below 2%', -Math.min(40, 700 * Math.max(0, Math.abs(infl - 0.02) - 0.005)));
  score += add('Unemployment', -Math.min(40, 450 * Math.max(0, u - 0.055)));
  score += add('Bank failures this year', -Math.min(40, 14 * fails));
  score += add(hpg > 0 ? 'House-price bubble' : 'House-price slump', -Math.min(20, 120 * Math.max(0, Math.abs(hpg) - 0.1)));
  if (fails === 0 && Math.abs(infl - 0.02) < 0.01 && u < 0.065) score += add('Steady growth, stable prices', 10);
  m.score = Math.max(0, Math.min(100, score));
  m.reasons = reasons.sort((a, b) => a.delta - b.delta);
  m.approval += (m.score - m.approval) * 0.2;
  m.history.push(m.approval);
  if (m.history.length > 600) m.history.shift();
}

export function grade(approval: number): string {
  return approval >= 85 ? 'A' : approval >= 72 ? 'B' : approval >= 58 ? 'C' : approval >= 45 ? 'D' : 'F';
}
