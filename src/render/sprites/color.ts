// Colour helpers for the sprite library.
//
// Colours are packed 32-bit integers in ImageData byte order (little-endian
// 0xAABBGGRR), so they can be written straight into a Uint32Array view of an
// ImageData buffer. Alpha is always 255 for real pixels; 0 means "transparent /
// skip". Alpha 254 is used as a marker for *emissive* colours (lit windows, neon)
// that must not be darkened by face shading; it is normalised to 255 on plot.

export type Col = number;

export const EMISSIVE_ALPHA = 254;

export function rgb(r: number, g: number, b: number): Col {
  return ((255 << 24) | (clamp8(b) << 16) | (clamp8(g) << 8) | clamp8(r)) >>> 0;
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

export const cr = (c: Col): number => c & 255;
export const cg = (c: Col): number => (c >>> 8) & 255;
export const cb = (c: Col): number => (c >>> 16) & 255;
export const ca = (c: Col): number => c >>> 24;

const hexCache = new Map<string, Col>();

/** Parse "#rgb" / "#rrggbb" (with or without '#'). Invalid input gives magenta. */
export function hex(s: string): Col {
  const hit = hexCache.get(s);
  if (hit !== undefined) return hit;
  let h = s.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = /^[0-9a-fA-F]{6}$/.test(h) ? parseInt(h, 16) : 0xff00ff;
  const c = rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
  hexCache.set(s, c);
  return c;
}

export function toCss(c: Col): string {
  const n = (cr(c) << 16) | (cg(c) << 8) | cb(c);
  return '#' + n.toString(16).padStart(6, '0');
}

/** Mark a colour as emissive (ignores face shading). */
export function emissive(c: Col): Col {
  return ((c & 0x00ffffff) | (EMISSIVE_ALPHA << 24)) >>> 0;
}

export function isEmissive(c: Col): boolean {
  return c >>> 24 === EMISSIVE_ALPHA;
}

/**
 * Brightness adjustment with a painterly hue shift: f < 1 darkens and pushes towards
 * cool blue-violet, f > 1 lightens towards a warm cream.
 */
export function shade(c: Col, f: number): Col {
  let r = cr(c);
  let g = cg(c);
  let b = cb(c);
  if (f < 1) {
    const k = 1 - f;
    r = r * f * (1 - k * 0.12);
    g = g * f * (1 - k * 0.04);
    b = b * f + k * 34;
  } else if (f > 1) {
    const k = Math.min(1, f - 1);
    r += (255 - r) * k;
    g += (247 - g) * k;
    b += (222 - b) * k * 0.9;
  }
  const a = ca(c) === EMISSIVE_ALPHA ? EMISSIVE_ALPHA : 255;
  return ((a << 24) | (clamp8(b) << 16) | (clamp8(g) << 8) | clamp8(r)) >>> 0;
}

export function mix(a: Col, b: Col, t: number): Col {
  return rgb(cr(a) + (cr(b) - cr(a)) * t, cg(a) + (cg(b) - cg(a)) * t, cb(a) + (cb(b) - cb(a)) * t);
}

export function lum(c: Col): number {
  return 0.299 * cr(c) + 0.587 * cg(c) + 0.114 * cb(c);
}

/** Pull a colour towards grey by t (0..1). */
export function desat(c: Col, t: number): Col {
  const l = lum(c);
  return rgb(cr(c) + (l - cr(c)) * t, cg(c) + (l - cg(c)) * t, cb(c) + (l - cb(c)) * t);
}

/** Faded / weathered look used by closed and vacant buildings. */
export function fade(c: Col, t = 0.45): Col {
  return mix(desat(c, t), rgb(150, 142, 128), t * 0.35);
}

/** Grim tint for distressed banks: darker, greyer, slightly cold. */
export function grim(c: Col, t = 0.35): Col {
  return shade(desat(c, t), 1 - t * 0.35);
}

// ---------------------------------------------------------------------------
// Shared palette. Warm, saturated-but-not-neon "toy town" colours.

export const P = {
  outline: rgb(38, 32, 44),
  black: rgb(24, 22, 30),
  white: rgb(246, 243, 234),
  offwhite: rgb(232, 226, 210),
  cream: rgb(236, 222, 180),

  grass: rgb(104, 164, 76),
  grassLight: rgb(128, 184, 88),
  grassDark: rgb(82, 140, 64),
  grassDry: rgb(150, 160, 84),
  dirt: rgb(150, 112, 74),
  dirtLight: rgb(174, 136, 94),
  dirtDark: rgb(118, 86, 58),
  sand: rgb(222, 200, 142),
  sandDark: rgb(196, 170, 112),

  asphalt: rgb(78, 78, 88),
  asphaltLight: rgb(92, 92, 102),
  asphaltDark: rgb(64, 64, 74),
  lane: rgb(236, 196, 70),
  paint: rgb(236, 236, 228),
  sidewalk: rgb(186, 182, 170),
  sidewalkLight: rgb(206, 202, 190),
  curb: rgb(222, 218, 206),
  concrete: rgb(176, 172, 164),
  paving: rgb(196, 186, 166),

  water: rgb(58, 118, 176),
  waterDark: rgb(44, 96, 152),
  waterLight: rgb(96, 156, 206),
  foam: rgb(214, 234, 244),

  glassDay: rgb(78, 104, 138),
  glassDayHi: rgb(168, 198, 222),
  glassDark: rgb(40, 44, 56),
  glassLit: rgb(255, 214, 104),
  glassLitHi: rgb(255, 240, 170),

  wood: rgb(150, 100, 60),
  woodDark: rgb(112, 72, 44),
  woodLight: rgb(186, 136, 88),
  plank: rgb(160, 112, 66),

  steel: rgb(120, 128, 140),
  steelDark: rgb(84, 90, 102),
  steelLight: rgb(170, 178, 188),
  yellow: rgb(242, 190, 40),
  yellowDark: rgb(200, 146, 24),
  orange: rgb(232, 124, 44),
  red: rgb(206, 58, 50),
  redDark: rgb(150, 36, 36),
  green: rgb(70, 160, 80),
  blue: rgb(64, 110, 200),
  gold: rgb(236, 186, 60),
  goldDark: rgb(180, 128, 30),
  copper: rgb(96, 170, 146),
  copperDark: rgb(64, 130, 112),
} as const;

/** Wall colours for varied toy-town facades. */
export const WALLS: readonly Col[] = [
  hex('#b75a3e'), // brick red
  hex('#ecdcae'), // cream
  hex('#d9b77e'), // sand
  hex('#5fa39a'), // teal
  hex('#9fb784'), // sage
  hex('#d9a940'), // mustard
  hex('#efebe0'), // white plaster
  hex('#9fc0da'), // pale blue
  hex('#e2a18b'), // salmon
  hex('#b6a9cb'), // lavender
  hex('#efe29c'), // butter
  hex('#a86a4c'), // tan brick
];

/** Roof colours. */
export const ROOFS: readonly Col[] = [
  hex('#5c6676'), // slate
  hex('#c0603c'), // terracotta
  hex('#45704f'), // dark green
  hex('#43424c'), // charcoal
  hex('#80563a'), // brown
  hex('#a8453a'), // red
  hex('#50698f'), // blue
  hex('#7a4a5e'), // plum
];
