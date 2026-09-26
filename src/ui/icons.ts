// Pixel glyphs (hand-drawn 1-bit icons rendered as crisp inline SVG) and "emoji sprites"
// (emoji rasterised at low resolution with a hard alpha edge and a dark outline, displayed with
// nearest-neighbour scaling so they sit naturally next to the pixel-art world).

const NS = 'http://www.w3.org/2000/svg';

/** 1-bit glyph maps: '#' = ink, anything else = transparent. */
export const GLYPHS = {
  close: ['##...##', '###.###', '.#####.', '..###..', '.#####.', '###.###', '##...##'],
  left: ['...#', '..##', '.###', '####', '.###', '..##', '...#'],
  right: ['#...', '##..', '###.', '####', '###.', '##..', '#...'],
  up: ['...#...', '..###..', '.#####.', '#######'],
  down: ['#######', '.#####.', '..###..', '...#...'],
  triUp: ['..#..', '.###.', '#####'],
  triDown: ['#####', '.###.', '..#..'],
  pause: ['##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '##.##'],
  play: ['#...', '##..', '###.', '####', '###.', '##..', '#...'],
  ff: ['#...#...', '##..##..', '###.###.', '########', '###.###.', '##..##..', '#...#...'],
  plus: ['..#..', '..#..', '#####', '..#..', '..#..'],
  minus: ['#####'],
  check: ['......#', '.....##', '#...##.', '##.##..', '.###...', '..#....'],
  dot: ['.##.', '####', '####', '.##.'],
  warn: ['...#...', '..###..', '..#.#..', '.##.##.', '.##.##.', '#######', '###.###', '#######'],
  info: ['.###.', '.....', '.###.', '..##.', '..##.', '..##.', '.####'],
  pin: ['.###.', '.###.', '.###.', '#####', '..#..', '..#..', '..#..'],
  shade: ['#######', '.......', '#######'],
  coin: ['.###.', '#.#.#', '#.###', '##..#', '###.#', '#.#.#', '.###.'],
  sortUp: ['..#..', '.###.', '#####'],
  sortDown: ['#####', '.###.', '..#..'],
} as const satisfies Record<string, readonly string[]>;

export type GlyphName = keyof typeof GLYPHS;

const pathCache = new Map<readonly string[], string>();

function pixelPath(map: readonly string[]): string {
  let d = pathCache.get(map);
  if (d !== undefined) return d;
  d = '';
  map.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === '#') {
        let x2 = x;
        while (x2 < row.length && row[x2] === '#') x2++;
        d += `M${x} ${y}h${x2 - x}v1h${x - x2}z`;
        x = x2;
      } else x++;
    }
  });
  pathCache.set(map, d);
  return d;
}

/** Render a 1-bit pixel map as crisp SVG (fill = currentColor). */
export function pixelSvg(map: readonly string[], scale = 1, className = 'mi-glyph'): SVGSVGElement {
  const hgt = map.length;
  const w = Math.max(...map.map((r) => r.length));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('width', String(w * scale));
  svg.setAttribute('height', String(hgt * scale));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', pixelPath(map));
  p.setAttribute('fill', 'currentColor');
  svg.appendChild(p);
  return svg;
}

/** A built-in pixel glyph, e.g. glyph('close'), glyph('pause', 2). */
export function glyph(name: GlyphName, scale = 1): SVGSVGElement {
  return pixelSvg(GLYPHS[name], scale, `mi-glyph mi-glyph-${name}`);
}

// ---------------------------------------------------------------------------------------------
// Emoji sprites

const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Segoe UI Symbol","Twemoji Mozilla",sans-serif';
const PICTO = /\p{Extended_Pictographic}/u;
const spriteCache = new Map<string, string | null>();

let pixelIcons = true;
/** Globally switch emoji-sprite rendering off (plain emoji text) or on. */
export function setPixelIcons(on: boolean): void {
  pixelIcons = on;
}

/**
 * Rasterise `g` into a (px+2)² sprite: hard alpha edge + 1px dark outline. Returns a data URL
 * (cached) or null when canvas is unavailable.
 */
export function emojiSprite(g: string, px = 14, outline = 'rgba(28,20,10,0.92)'): string | null {
  const key = `${g}|${px}|${outline}`;
  const hit = spriteCache.get(key);
  if (hit !== undefined) return hit;
  let url: string | null = null;
  try {
    const n = px + 2;
    const c = document.createElement('canvas');
    c.width = n;
    c.height = n;
    const x = c.getContext('2d', { willReadFrequently: true });
    if (x) {
      x.font = `${px}px ${EMOJI_FONT}`;
      x.textBaseline = 'alphabetic';
      x.textAlign = 'left';
      x.fillStyle = '#2a2116';
      const m = x.measureText(g);
      const bw = Math.max(1, m.actualBoundingBoxLeft + m.actualBoundingBoxRight);
      const bh = Math.max(1, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
      const s = Math.min(1, px / Math.max(bw, bh));
      x.save();
      x.translate(n / 2, n / 2);
      x.scale(s, s);
      x.fillText(g, -bw / 2 + m.actualBoundingBoxLeft, bh / 2 - m.actualBoundingBoxDescent);
      x.restore();
      const img = x.getImageData(0, 0, n, n);
      const d = img.data;
      const solid = new Uint8Array(n * n);
      for (let i = 0; i < n * n; i++) {
        const on = d[i * 4 + 3] >= 100;
        solid[i] = on ? 1 : 0;
        d[i * 4 + 3] = on ? 255 : 0;
      }
      const oc = outline.match(/[\d.]+/g)?.map(Number) ?? [28, 20, 10, 0.92];
      for (let y = 0; y < n; y++) {
        for (let xx = 0; xx < n; xx++) {
          const i = y * n + xx;
          if (solid[i]) continue;
          const near = (xx > 0 && solid[i - 1]) || (xx < n - 1 && solid[i + 1]) || (y > 0 && solid[i - n]) || (y < n - 1 && solid[i + n]);
          if (near) {
            d[i * 4] = oc[0];
            d[i * 4 + 1] = oc[1];
            d[i * 4 + 2] = oc[2];
            d[i * 4 + 3] = Math.round((oc[3] ?? 1) * 255);
          }
        }
      }
      x.putImageData(img, 0, 0);
      url = c.toDataURL();
    }
  } catch {
    url = null;
  }
  spriteCache.set(key, url);
  return url;
}

export interface IconOpts {
  /** Raster size of the emoji before scaling (default 14). */
  px?: number;
  /** Integer display scale (default 1). px 10 × scale 2 gives chunky sprite icons. */
  scale?: number;
  className?: string;
}

/**
 * Icon element from an emoji, a short text glyph ('$', '§'), a built-in pixel glyph ('px:close')
 * or a ready-made Node. Emoji become pixel sprites; other text renders in the current font/colour.
 */
export function iconEl(icon: string | Node | null | undefined, opts: IconOpts = {}): HTMLElement | null {
  if (icon === null || icon === undefined || icon === '') return null;
  const cls = `mi-icon${opts.className ? ' ' + opts.className : ''}`;
  const wrap = document.createElement('span');
  wrap.className = cls;
  wrap.setAttribute('aria-hidden', 'true');
  if (icon instanceof Node) {
    wrap.appendChild(icon);
    return wrap;
  }
  if (icon.startsWith('px:') && icon.slice(3) in GLYPHS) {
    wrap.classList.add('is-glyph');
    wrap.appendChild(glyph(icon.slice(3) as GlyphName, opts.scale ?? 1));
    return wrap;
  }
  const px = opts.px ?? 14;
  const scale = opts.scale ?? 1;
  const url = pixelIcons && PICTO.test(icon) ? emojiSprite(icon, px) : null;
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.draggable = false;
    img.width = (px + 2) * scale;
    img.height = (px + 2) * scale;
    wrap.classList.add('is-sprite');
    wrap.appendChild(img);
  } else {
    wrap.classList.add('is-text');
    wrap.textContent = icon;
  }
  return wrap;
}
