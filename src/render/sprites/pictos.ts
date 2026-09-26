// Tiny 5x5 pictograms for shop / service signs and billboards.

import { type Col, rgb } from './color';
import type { Face } from './raster';
import { lit } from './raster';

interface Picto {
  rows: string[];
  pal: Record<string, Col>;
}

const K = rgb(40, 38, 48);
const W = rgb(250, 248, 240);

export const PICTOS: Record<string, Picto> = {
  grocery: { rows: ['...g.', '.rgr.', 'rwrrr', 'rrrrr', '.rrr.'], pal: { g: rgb(70, 160, 60), r: rgb(214, 48, 44), w: rgb(255, 190, 180) } },
  clothing: { rows: ['pp.pp', 'ppppp', '.ppp.', '.ppp.', '.ppp.'], pal: { p: rgb(226, 88, 150) } },
  electronics: { rows: ['kkkkk', 'kccck', 'kcwck', 'kkkkk', '.k.k.'], pal: { k: K, c: rgb(60, 180, 240), w: rgb(200, 240, 255) } },
  hardware: { rows: ['o...o', 'oo.oo', '.ooo.', '..o..', '..o..'], pal: { o: rgb(110, 116, 128) } },
  furniture: { rows: ['b....', 'b....', 'bbbbb', 'b...b', 'b...b'], pal: { b: rgb(140, 90, 50) } },
  pharmacy: { rows: ['..g..', '..g..', 'ggggg', '..g..', '..g..'], pal: { g: rgb(40, 170, 90) } },
  bakery: { rows: ['.....', '.ttt.', 'ttttt', 'tdtdt', 'ttttt'], pal: { t: rgb(214, 150, 70), d: rgb(150, 90, 40) } },
  books: { rows: ['.mmmm', 'm.wwm', 'm.wwm', 'm.wwm', '.mmmm'], pal: { m: rgb(140, 40, 60), w: W } },
  diner: { rows: ['.bbb.', 'yyyyy', 'rrrrr', 'ggggg', '.bbb.'], pal: { b: rgb(214, 150, 70), y: rgb(250, 210, 60), r: rgb(160, 60, 40), g: rgb(90, 170, 60) } },
  cafe: { rows: ['.s.s.', '..s..', 'wwww.', 'wwwwk', '.ww..'], pal: { s: rgb(170, 170, 180), w: rgb(120, 80, 50), k: rgb(120, 80, 50) } },
  clinic: { rows: ['..r..', '..r..', 'rrrrr', '..r..', '..r..'], pal: { r: rgb(220, 40, 40) } },
  cinema: { rows: ['kwkwk', 'kkkkk', 'kyyyk', 'kkkkk', 'kwkwk'], pal: { k: K, w: W, y: rgb(250, 210, 60) } },
  gym: { rows: ['k...k', 'kk.kk', 'kkkkk', 'kk.kk', 'k...k'], pal: { k: K } },
  salon: { rows: ['k...k', '.k.k.', '..k..', 'rr.rr', 'rr.rr'], pal: { k: rgb(110, 116, 128), r: rgb(220, 60, 130) } },
  restaurant: { rows: ['k.k.k', 'k.k.k', '.k..k', '.k..k', '.k..k'], pal: { k: rgb(110, 116, 128) } },
  lawoffice: { rows: ['..k..', 'kkkkk', 'k.k.k', '..k..', '.kkk.'], pal: { k: rgb(150, 110, 30) } },
  house: { rows: ['..k..', '.kkk.', 'kkkkk', '.k.k.', '.k.k.'], pal: { k: K } },
  money: { rows: ['.ggg.', 'g.g..', '.ggg.', '..g.g', '.ggg.'], pal: { g: rgb(40, 150, 70) } },
  factory: { rows: ['k....', 'k.k.k', 'kkkkk', 'kkkkk', 'kkkkk'], pal: { k: K } },
};

/** Draw a pictogram upright on a face (top-left at column i, cap row jTop), `scale` 1 or 2. */
export function facePicto(f: Face, key: string, i: number, jTop: number, scale = 1): void {
  const p = PICTOS[key];
  if (!p) return;
  const mid = Math.max(0, Math.min(f.W - 1, i + ((5 * scale) >> 1)));
  for (let y = 0; y < p.rows.length; y++) {
    const row = p.rows[y];
    for (let x = 0; x < row.length; x++) {
      const c = p.pal[row[x]];
      if (c === undefined) continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const ci = i + x * scale + sx;
          if (ci < 0 || ci >= f.W) continue;
          f.r.plot(f.px(ci), f.bot[mid] - jTop + y * scale + sy, lit(c, f.tone), f.depth(ci) + 0.02, f.g);
        }
      }
    }
  }
}
