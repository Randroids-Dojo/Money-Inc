// Colour helpers for the UI skin (accent tinting, readable ink, chart palettes).

export type RGB = readonly [number, number, number];

let probe: CanvasRenderingContext2D | null | undefined;

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Parse any CSS colour (hex, rgb(), named, hsl()...) to RGB. Returns null when unparseable. */
export function parseColor(input: string): RGB | null {
  const s = input.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let hx = m[1];
    if (hx.length === 3 || hx.length === 4) hx = [...hx.slice(0, 3)].map((c) => c + c).join('');
    if (hx.length !== 6 && hx.length !== 8) return null;
    const n = parseInt(hx.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [clamp255(+m[1]), clamp255(+m[2]), clamp255(+m[3])];
  // Fall back to the browser's colour parser.
  if (probe === undefined) probe = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (!probe) return null;
  probe.fillStyle = '#010203';
  probe.fillStyle = s;
  const out = String(probe.fillStyle);
  if (out === '#010203' && s.toLowerCase() !== '#010203') return null;
  return out.startsWith('#') ? parseColor(out) : parseColor(out.replace(/^rgba/, 'rgb'));
}

export function toHex(c: RGB): string {
  return '#' + c.map((v) => clamp255(v).toString(16).padStart(2, '0')).join('');
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Relative luminance (WCAG). */
export function luminance(c: RGB): number {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

const WARM_LIGHT: RGB = [255, 246, 214];
const COOL_DARK: RGB = [10, 16, 34];

/**
 * Painterly shade: amount > 0 lightens towards warm cream, amount < 0 darkens towards
 * cool navy (matches the sprite library's lighting so UI and world feel related).
 */
export function shade(color: string | RGB, amount: number): string {
  const c = typeof color === 'string' ? parseColor(color) : color;
  if (!c) return typeof color === 'string' ? color : '#888888';
  return toHex(amount >= 0 ? mixRgb(c, WARM_LIGHT, Math.min(1, amount)) : mixRgb(c, COOL_DARK, Math.min(1, -amount)));
}

/** Dark ink or light ink, whichever reads better on `bg`. */
export function readableInk(bg: string | RGB, dark = '#1d1406', light = '#fff8e6'): string {
  const c = typeof bg === 'string' ? parseColor(bg) : bg;
  if (!c) return dark;
  return luminance(c) > 0.3 ? dark : light;
}

/** CSS custom properties that tint a window's title bar with `accent`. */
export function accentVars(accent: string): Record<string, string> {
  const c = parseColor(accent);
  if (!c) return {};
  const ink = readableInk(c);
  const darkInk = ink !== '#fff8e6';
  return {
    '--mi-accent': toHex(c),
    '--mi-accent-hi': shade(c, 0.42),
    '--mi-accent-lo': shade(c, -0.45),
    '--mi-accent-deep': shade(c, -0.62),
    '--mi-accent-ink': ink,
    '--mi-accent-emboss': darkInk ? 'rgba(255,248,220,.45)' : 'rgba(0,0,0,.55)',
  };
}

export function alpha(color: string, a: number): string {
  const c = parseColor(color);
  if (!c) return color;
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** Default series palette tuned for the dark "screen" charts. */
export const SCREEN_PALETTE = ['#f2c14e', '#5fd3c6', '#ff7a5c', '#9be07a', '#c9a0ff', '#6fb4ff', '#ff9ecb', '#e8e1c4'];
/** Default palette for data drawn on parchment. */
export const PAPER_PALETTE = ['#1f7a8c', '#b5533c', '#b8860b', '#3b8d3b', '#7b4ea3', '#2c4a7a', '#c0587e', '#5c4e38'];
