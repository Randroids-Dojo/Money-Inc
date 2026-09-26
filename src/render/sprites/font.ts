// Tiny hand-made bitmap font: 3x5 glyphs (M, N, W, & are wider), cap height 5.
// Lowercase maps to uppercase; unknown characters render as '?'.

import type { TextBitmap } from './raster';

// '#' = ink. Rows top to bottom. A glyph may have 7 rows, in which case it starts one
// row above the cap line (used by '$').
const G: Record<string, string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  $: ['.#.', '###', '#..', '###', '..#', '###', '.#.'],
  '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '-': ['...', '...', '###', '...', '...'],
  '.': ['.', '.', '.', '.', '#'],
  ',': ['..', '..', '..', '.#', '#.'],
  '!': ['#', '#', '#', '.', '#'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  ':': ['.', '#', '.', '#', '.'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  "'": ['#', '#', '.', '.', '.'],
  '&': ['.#..', '#.#.', '.#..', '#.##', '.##.'],
  '(': ['.#', '#.', '#.', '#.', '.#'],
  ')': ['#.', '.#', '.#', '.#', '#.'],
  '#': ['#.#', '###', '#.#', '###', '#.#'],
  ' ': ['..', '..', '..', '..', '..'],
};

interface Glyph {
  w: number;
  px: [number, number][];
}

const glyphCache = new Map<string, Glyph>();

function glyph(ch: string): Glyph {
  let g = glyphCache.get(ch);
  if (g) return g;
  const rows = G[ch] ?? G['?'];
  const dy = rows.length > 5 ? -1 : 0;
  const px: [number, number][] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') px.push([x, y + dy]);
  });
  g = { w: rows[0].length, px };
  glyphCache.set(ch, g);
  return g;
}

export const FONT_H = 5;
export const FONT_SPACING = 1;

const bitmapCache = new Map<string, TextBitmap>();

/** Layout a string into glyph pixel lists (x relative to the text's left edge, y to the cap line). */
export function textBitmap(text: string): TextBitmap {
  let bm = bitmapCache.get(text);
  if (bm) return bm;
  const glyphs: TextBitmap['glyphs'] = [];
  let x = 0;
  const s = text.toUpperCase();
  for (let i = 0; i < s.length; i++) {
    const g = glyph(s[i]);
    glyphs.push({ x, w: g.w, px: g.px });
    x += g.w + FONT_SPACING;
  }
  bm = { w: Math.max(0, x - FONT_SPACING), h: FONT_H, glyphs };
  bitmapCache.set(text, bm);
  return bm;
}

/**
 * Shorten text until it fits maxW pixels: first drop spaces, then trailing characters.
 */
export function fitText(text: string, maxW: number): string {
  if (textBitmap(text).w <= maxW) return text;
  let t = text.replace(/ /g, '');
  while (t.length > 1 && textBitmap(t).w > maxW) t = t.slice(0, -1);
  return t;
}

export function measurePixelText(text: string, scale = 1): { w: number; h: number } {
  const bm = textBitmap(text);
  const s = Math.max(1, Math.round(scale));
  return { w: bm.w * s, h: bm.h * s };
}

/**
 * Draw pixel text onto a 2D canvas context with crisp integer-scaled pixels.
 * (x, y) is the top-left of the cap box for align 'left'; for 'center'/'right' x is
 * the centre / right edge. Shadow (if given) is offset one text pixel down-right.
 */
export function drawPixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  opts: { shadow?: string; scale?: number; align?: 'left' | 'center' | 'right' } = {},
): void {
  const s = Math.max(1, Math.round(opts.scale ?? 1));
  const bm = textBitmap(text);
  let ox = Math.round(x);
  if (opts.align === 'center') ox = Math.round(x - (bm.w * s) / 2);
  else if (opts.align === 'right') ox = Math.round(x - bm.w * s);
  const oy = Math.round(y);
  const paint = (dx: number, dy: number, style: string) => {
    ctx.fillStyle = style;
    for (const gl of bm.glyphs) {
      for (const [gx, gy] of gl.px) ctx.fillRect(ox + (gl.x + gx) * s + dx, oy + gy * s + dy, s, s);
    }
  };
  if (opts.shadow) paint(s, s, opts.shadow);
  paint(0, 0, color);
}
