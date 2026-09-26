import { DAYS_PER_MONTH, DAYS_PER_YEAR } from './config';

export function fmtMoney(x: number, digits?: number): string {
  const s = x < 0 ? '-' : '';
  const a = Math.abs(x);
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(digits ?? 2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(digits ?? (a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2))}M`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(digits ?? 0)}K`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(digits ?? 1)}K`;
  return `${s}$${a.toFixed(0)}`;
}

export function pct(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export function signedPct(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '—';
  const v = (x * 100).toFixed(digits);
  return x > 0 ? `+${v}%` : `${v}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(day: number, withDay = true): string {
  const y = Math.floor(day / DAYS_PER_YEAR) + 1;
  const m = Math.floor((day % DAYS_PER_YEAR) / DAYS_PER_MONTH);
  const d = (day % DAYS_PER_MONTH) + 1;
  return withDay ? `${MONTHS[m]} ${d}, Y${y}` : `${MONTHS[m]} Y${y}`;
}

export function monthName(day: number): string {
  return MONTHS[Math.floor((day % DAYS_PER_YEAR) / DAYS_PER_MONTH)];
}
