// Tiny pedestrians (5x10) with a 2-frame walk cycle in 4 directions, plus status
// balloon icons and the spinning coin. All hand-designed pixel art with palette
// substitution; anchors: person = feet, icon = balloon tail tip, coin = centre.

import type { Dir } from '../iso';
import type { IconKind, Sprite } from './types';
import { type Col, P, hex, rgb, shade } from './color';
import { art, artSprite, mirrorArt, LRU } from './sprite';

// ---------------------------------------------------------------------------
// People
//
// Palette keys: H hair, S skin, s skin shadow, T shirt, t shirt shadow, L trousers,
// K shoes, Y hard hat, C cap, B bag, O outline.

const FRONT: string[][] = [
  // frame 0: stride
  ['.HHH.', 'HSSs.', '.SSs.', 'tTTt.', 'TTTTs', 'StTt.', '.tTt.', '.L.L.', 'L...L', 'K...K'],
  // frame 1: passing
  ['.HHH.', 'HSSs.', '.SSs.', 'tTTt.', 'tTTTt', 'StTtS', '.tTt.', '.LL..', '.LL..', '.KK..'],
];

const BACK: string[][] = [
  ['.HHH.', 'HHHH.', '.HHs.', 'tTTt.', 'TTTTt', 'StTtS', '.tTt.', '.L.L.', 'L...L', 'K...K'],
  ['.HHH.', 'HHHH.', '.HHs.', 'tTTt.', 'tTTTt', 'StTtS', '.tTt.', '.LL..', '.LL..', '.KK..'],
];

const HAIRS = [rgb(60, 40, 30), rgb(30, 26, 24), rgb(150, 100, 50), rgb(220, 190, 110), rgb(120, 60, 40), rgb(180, 180, 180)];
const SKINS = [hex('#f1c8a0'), hex('#d9a577'), hex('#b07a4e'), hex('#7a4e30'), hex('#f6d6b8')];

function strHash(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const personCache = new LRU<Sprite>(1024);

export interface PersonOpts {
  pants?: string;
  skin?: string;
  hat?: 'none' | 'hard' | 'cap';
  bag?: boolean;
}

export function personSprite(dir: Dir, frame: number, shirt: string, opts: PersonOpts = {}): Sprite {
  const f = ((Math.floor(frame) % 2) + 2) % 2;
  const key = `${dir}:${f}:${shirt}:${opts.pants ?? ''}:${opts.skin ?? ''}:${opts.hat ?? 'none'}:${opts.bag ? 1 : 0}`;
  const hit = personCache.get(key);
  if (hit) return hit;
  const h = strHash(shirt + (opts.pants ?? '') + (opts.skin ?? ''));
  const shirtC = hex(shirt);
  const pal: Record<string, Col> = {
    H: HAIRS[h % HAIRS.length],
    S: opts.skin ? hex(opts.skin) : SKINS[(h >> 3) % SKINS.length],
    T: shirtC,
    t: shade(shirtC, 0.78),
    L: opts.pants ? hex(opts.pants) : [rgb(56, 70, 110), rgb(60, 58, 64), rgb(120, 100, 76), rgb(40, 40, 48)][(h >> 5) % 4],
    K: rgb(40, 34, 34),
  };
  pal.s = shade(pal.S, 0.85);
  const back = dir === 2 || dir === 3;
  const rows = (back ? BACK : FRONT)[f].map((r) => r.split(''));
  if (opts.hat === 'hard') {
    rows[0] = '.YYY.'.split('');
    rows[1][0] = 'Y';
    rows[1][1] = back ? 'Y' : rows[1][1];
    rows[1][3] = back ? 'Y' : rows[1][3];
    pal.Y = P.yellow;
  } else if (opts.hat === 'cap') {
    rows[0] = '.CCC.'.split('');
    if (!back) rows[1][4] = 'C';
    pal.C = shade(shirtC, 0.7);
  }
  if (opts.bag) {
    rows[5][4] = 'B';
    rows[6][4] = 'B';
    rows[6][3] = rows[6][3] === '.' ? 'B' : rows[6][3];
    pal.B = rgb(236, 226, 196);
  }
  let a = art(rows.map((r) => r.join('')), pal, 2, 9);
  // sprites are drawn facing down-right (dir 0) / up-right (dir 3); mirror for the others
  if (dir === 1 || dir === 2) a = mirrorArt(a);
  const s = artSprite(a);
  personCache.set(key, s);
  return s;
}

// ---------------------------------------------------------------------------
// Icons (speech balloons, 13x15, anchor = tail tip)

const BALLOON = [
  '..OOOOOOOOO..',
  '.OWWWWWWWWWO.',
  'OWWWWWWWWWWWO',
  'OWWWWWWWWWWWO',
  'OWWWWWWWWWWWO',
  'OWWWWWWWWWWWO',
  'OWWWWWWWWWWWO',
  'OWWWWWWWWWWWO',
  'OWWWWWWWWWWWO',
  'OdWWWWWWWWWdO',
  '.OddWWWWWddO.',
  '..OOOOdOOOO..',
  '.....OdO.....',
  '......O......',
  '.............',
];

// 9x8 symbols drawn inside the balloon (offset 2,1)
const SYMBOLS: Record<IconKind, string[]> = {
  warning: ['....k....', '...kyk...', '...kyk...', '..kyyyk..', '..kykyk..', '.kyyyyyk.', '.kyykyyk.', 'kkkkkkkkk'],
  alarm: ['.rr...rr.', '.rr...rr.', '.rr...rr.', '.rr...rr.', '.rr...rr.', '.........', '.rr...rr.', '.rr...rr.'],
  money: ['....g....', '..ggggg..', '.gg.g....', '..ggg....', '....ggg..', '....g.gg.', '.ggggggg.', '....g....'],
  hammer: ['..mmmm...', '.mmmmmm..', '..mmmmm..', '....wm...', '...ww....', '..ww.....', '.ww......', 'ww.......'],
  zzz: ['....bbbb.', '......b..', '.bbb.b...', '...bbbbb.', '..b......', '.bbb.....', '.........', '.........'],
  up: ['....g....', '...ggg...', '..ggggg..', '.ggggggg.', '...ggg...', '...ggg...', '...ggg...', '...ggg...'],
  down: ['...rrr...', '...rrr...', '...rrr...', '...rrr...', '.rrrrrrr.', '..rrrrr..', '...rrr...', '....r....'],
  house: ['....r....', '...rrr...', '..rrrrr..', '.rrrrrrr.', '..wwwww..', '..wbwkw..', '..wwwkw..', '..wwwkw..'],
  person: ['...hhh...', '...sss...', '...sss...', '....s....', '..bbbbb..', '.b.bbb.b.', '...b.b...', '...b.b...'],
  lock: ['...kkk...', '..k...k..', '..k...k..', '.yyyyyyy.', '.yyykyyy.', '.yyykyyy.', '.yyyyyyy.', '.ddddddd.'],
};

const ICON_BG: Partial<Record<IconKind, Col>> = {
  warning: rgb(255, 236, 150),
  alarm: rgb(255, 214, 210),
  money: rgb(214, 246, 206),
  zzz: rgb(214, 228, 250),
  lock: rgb(226, 226, 232),
};

const iconCache = new Map<string, Sprite>();

export function iconSprite(kind: IconKind): Sprite {
  const hit = iconCache.get(kind);
  if (hit) return hit;
  const bg = ICON_BG[kind] ?? rgb(250, 248, 242);
  const pal: Record<string, Col> = {
    O: rgb(40, 34, 48),
    W: bg,
    d: shade(bg, 0.82),
    k: rgb(40, 34, 48),
    y: rgb(250, 200, 40),
    r: rgb(214, 44, 44),
    g: rgb(40, 150, 70),
    m: rgb(120, 126, 136),
    w: rgb(150, 100, 60),
    b: rgb(60, 100, 200),
    h: rgb(80, 50, 30),
    s: rgb(240, 200, 160),
  };
  const rows = BALLOON.map((r) => r.split(''));
  const sym = SYMBOLS[kind];
  for (let y = 0; y < sym.length; y++) {
    for (let x = 0; x < sym[y].length; x++) {
      const ch = sym[y][x];
      if (ch !== '.') rows[1 + y][2 + x] = ch;
    }
  }
  const a = art(rows.map((r) => r.join('')), pal, 6, 13);
  const s = artSprite(a);
  iconCache.set(kind, s);
  return s;
}

// ---------------------------------------------------------------------------
// Coin (7x7, 4 frames spinning, anchor = centre)

const COIN_FRAMES = [
  ['..ooo..', '.oyyyo.', 'oyhy$yo', 'oyy$yyo', 'oy$yyyo', '.oyyyo.', '..ooo..'],
  ['...o...', '..oyo..', '.oyhyo.', '.oy$yo.', '.oyyyo.', '..oyo..', '...o...'],
  ['...o...', '...o...', '...y...', '...y...', '...y...', '...o...', '...o...'],
  ['...o...', '..oyo..', '.oyyho.', '.oy$yo.', '.oyyyo.', '..oyo..', '...o...'],
];

const coinCache = new Map<number, Sprite>();

export function coinSprite(frame: number): Sprite {
  const f = ((Math.floor(frame) % 4) + 4) % 4;
  const hit = coinCache.get(f);
  if (hit) return hit;
  const pal: Record<string, Col> = { o: P.goldDark, y: P.gold, h: rgb(255, 244, 180), $: rgb(200, 140, 30) };
  const s = artSprite(art(COIN_FRAMES[f], pal, 3, 3));
  coinCache.set(f, s);
  return s;
}
