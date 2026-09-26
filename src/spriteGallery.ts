// Visual QA gallery for the procedural sprite library.
//   sprites.html?section=buildings|res|com|biz|civic|closed|lots|construction|ground|misc|city[&zoom=N]
// Everything is drawn on a native-resolution canvas and upscaled with an integer
// nearest-neighbour zoom (image-rendering: pixelated) so pixels stay crisp.

import {
  buildingSprite,
  groundTile,
  shoreTile,
  roadTile,
  propSprite,
  vehicleSprite,
  personSprite,
  iconSprite,
  coinSprite,
  drawPixelText,
  measurePixelText,
  type BuildingSpriteSpec,
  type Sprite,
  type PropKind,
  type VehicleKind,
  type IconKind,
  type GroundKind,
} from './render/sprites';
import { tileToScreen, ROAD_N, ROAD_E, ROAD_S, ROAD_W, type Dir } from './render/iso';
import { buildingDebug } from './render/sprites/buildings';

const params = new URLSearchParams(location.search);
const SECTIONS = ['buildings', 'res', 'com', 'biz', 'civic', 'closed', 'lots', 'construction', 'ground', 'misc', 'city', 'verify'] as const;
type Section = (typeof SECTIONS)[number];
const section = (SECTIONS as readonly string[]).includes(params.get('section') ?? '') ? (params.get('section') as Section) : 'city';
const ZOOM = Math.max(1, Math.min(8, Math.round(Number(params.get('zoom') ?? 2))));

// navigation
const nav = document.getElementById('nav')!;
for (const s of SECTIONS) {
  const a = document.createElement('a');
  a.href = `?section=${s}&zoom=${ZOOM}`;
  a.textContent = s;
  if (s === section) a.className = 'on';
  nav.appendChild(a);
}
const out = document.getElementById('out')!;

// ---------------------------------------------------------------------------
// Canvas + flow layout helpers

const BG = '#343a48';
const NATIVE_W = Math.floor((window.innerWidth - 16) / ZOOM);

interface Page {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

function makePage(w: number, h: number, bg = BG): Page {
  const cv = document.createElement('canvas');
  cv.width = w * ZOOM;
  cv.height = h * ZOOM;
  cv.style.width = `${w * ZOOM}px`;
  cv.style.height = `${h * ZOOM}px`;
  out.appendChild(cv);
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.scale(ZOOM, ZOOM);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  return { ctx, w, h };
}

/** A gallery item: draws itself with its reference point at (x, y). */
interface Item {
  label: string;
  /** extents relative to the reference point */
  left: number;
  right: number;
  up: number;
  down: number;
  draw: (ctx: CanvasRenderingContext2D, x: number, y: number) => void;
}

function spriteExtents(s: Sprite): { left: number; right: number; up: number; down: number } {
  return { left: s.ax, right: s.canvas.width - s.ax, up: s.ay, down: s.canvas.height - s.ay };
}

/** Building item: grass under the footprint, then the sprite at the footprint anchor. */
function buildingItem(spec: BuildingSpriteSpec, label: string): Item {
  const s = buildingSprite(spec);
  const e = spriteExtents(s);
  const w = spec.w;
  const d = spec.d;
  return {
    label,
    left: Math.max(e.left, 32 * d),
    right: Math.max(e.right, 32 * w),
    up: e.up,
    down: Math.max(e.down, 16 * (w + d)),
    draw: (ctx, x, y) => {
      for (let ty = 0; ty < d; ty++)
        for (let tx = 0; tx < w; tx++) {
          const g = groundTile('grass', tx * 3 + ty * 5);
          const p = tileToScreen(tx, ty);
          ctx.drawImage(g.canvas, x + p.x - g.ax, y + p.y - g.ay);
        }
      ctx.drawImage(s.canvas, x - s.ax, y - s.ay);
      if (params.get('anchors') === '1') {
        ctx.fillStyle = '#ff00ff';
        if (s.top) ctx.fillRect(x - s.ax + s.top.x, y - s.ay + s.top.y, 1, 1);
        ctx.fillStyle = '#00ffff';
        if (s.door) ctx.fillRect(x - s.ax + s.door.x, y - s.ay + s.door.y, 1, 1);
        ctx.fillStyle = '#ffff00';
        for (const c of s.chimneys ?? []) ctx.fillRect(x - s.ax + c.x, y - s.ay + c.y, 1, 1);
      }
    },
  };
}

function spriteItem(s: Sprite, label: string, under?: (ctx: CanvasRenderingContext2D, x: number, y: number) => void): Item {
  const e = spriteExtents(s);
  return {
    label,
    left: Math.max(e.left, under ? 32 : 0),
    right: Math.max(e.right, under ? 32 : 0),
    up: Math.max(e.up, under ? 16 : 0),
    down: Math.max(e.down, under ? 16 : 0),
    draw: (ctx, x, y) => {
      if (under) under(ctx, x, y);
      ctx.drawImage(s.canvas, x - s.ax, y - s.ay);
    },
  };
}

/** Lay items out in rows under a heading; returns the next y. */
function flow(ctx: CanvasRenderingContext2D | null, title: string, items: Item[], y0: number, width: number, gap = 10): number {
  let y = y0;
  if (ctx) drawPixelText(ctx, title.toUpperCase(), 8, y, '#f2d27a', { shadow: '#000', scale: 2 });
  y += 16;
  let x = 8;
  let rowUp = 0;
  let rowDown = 0;
  let row: { it: Item; x: number }[] = [];
  const flush = () => {
    const base = y + rowUp;
    for (const { it, x: ix } of row) {
      if (ctx) {
        it.draw(ctx, ix + it.left, base);
        const lw = measurePixelText(it.label).w;
        drawPixelText(ctx, it.label, ix + it.left - lw / 2, base + rowDown + 3, '#e8e4d8', { shadow: '#15171d' });
      }
    }
    y = base + rowDown + 12;
    row = [];
    x = 8;
    rowUp = 0;
    rowDown = 0;
  };
  for (const it of items) {
    const wdt = Math.max(it.left + it.right, measurePixelText(it.label).w);
    if (x + wdt > width - 8 && row.length) flush();
    row.push({ it, x: x + Math.max(0, (wdt - it.left - it.right) / 2) });
    x += wdt + gap;
    rowUp = Math.max(rowUp, it.up);
    rowDown = Math.max(rowDown, it.down);
  }
  if (row.length) flush();
  return y + 6;
}

/** Two-pass render: measure height, then draw. */
function renderGroups(groups: [string, Item[]][]): void {
  const width = Math.max(640, NATIVE_W);
  let y = 6;
  for (const [t, its] of groups) y = flow(null, t, its, y, width);
  const page = makePage(width, y + 4);
  y = 6;
  for (const [t, its] of groups) y = flow(page.ctx, t, its, y, width);
}

// ---------------------------------------------------------------------------
// Sections

const SHOPS = ['grocery', 'clothing', 'electronics', 'hardware', 'furniture', 'pharmacy', 'bakery', 'books'];
const SERVICES = ['diner', 'cafe', 'clinic', 'cinema', 'gym', 'salon', 'restaurant', 'lawoffice'];
const FACTORIES = ['textiles', 'furniture', 'electronics', 'steel', 'food', 'chemicals'];
const fr = (v: number): 'left' | 'right' => (v % 2 ? 'right' : 'left');

function resGroups(): [string, Item[]][] {
  const houses: Item[] = [];
  for (let v = 0; v < 12; v++) houses.push(buildingItem({ kind: 'house', w: 1, d: 1, level: 1, variant: v, front: fr(v), lit: v % 4 === 0 ? 0.5 : 0 }, `L1 V${v}`));
  const houses2: Item[] = [];
  for (let v = 0; v < 12; v++) houses2.push(buildingItem({ kind: 'house', w: 1, d: 1, level: 2, variant: v, front: fr(v), lit: v % 4 === 1 ? 0.75 : 0 }, `L2 V${v}`));
  const vac: Item[] = [];
  for (let v = 0; v < 6; v++) vac.push(buildingItem({ kind: 'house', w: 1, d: 1, level: 1 + (v % 2), variant: v, front: fr(v), state: 'vacant' }, `VACANT ${v}`));
  const apts: Item[] = [];
  for (let l = 1; l <= 4; l++) for (let v = 0; v < 2; v++) apts.push(buildingItem({ kind: 'apartment', w: 2, d: 2, level: l, variant: v * 3 + l, front: fr(v), lit: v ? 0.5 : 0 }, `APT L${l}`));
  apts.push(buildingItem({ kind: 'apartment', w: 2, d: 2, level: 3, variant: 7, state: 'vacant' }, 'APT VACANT'));
  return [['Houses level 1', houses], ['Houses level 2', houses2], ['Vacant houses', vac], ['Apartments', apts]];
}

function comGroups(): [string, Item[]][] {
  const shops: Item[] = [];
  for (const [k, sub] of SHOPS.entries()) for (let l = 1; l <= 3; l++) shops.push(buildingItem({ kind: 'shop', w: 1, d: 1, level: l, variant: k + l, subtype: sub, front: fr(k + l), lit: l === 3 ? 0.5 : 0 }, `${sub.slice(0, 5)} ${l}`));
  const svc: Item[] = [];
  for (const [k, sub] of SERVICES.entries()) for (let l = 1; l <= 3; l++) svc.push(buildingItem({ kind: 'service', w: 1, d: 1, level: l, variant: k + l, subtype: sub, front: fr(k + l), lit: l === 2 ? 0.75 : 0 }, `${sub.slice(0, 5)} ${l}`));
  return [['Shops (subtype x level)', shops], ['Services (subtype x level)', svc]];
}

function bizGroups(): [string, Item[]][] {
  const offices: Item[] = [];
  for (let l = 1; l <= 4; l++) for (let v = 0; v < 3; v++) offices.push(buildingItem({ kind: 'office', w: 2, d: 2, level: l, variant: v * 5 + l, front: fr(v), lit: v === 1 ? 0.5 : 0, sign: v === 2 ? 'ACME' : undefined }, `OFFICE L${l}`));
  const fac: Item[] = [];
  for (const [k, sub] of FACTORIES.entries()) fac.push(buildingItem({ kind: 'factory', w: 2, d: 2, level: 1 + (k % 4), variant: k, subtype: sub, front: fr(k) }, `${sub} L${1 + (k % 4)}`));
  for (let l = 1; l <= 4; l++) fac.push(buildingItem({ kind: 'factory', w: 2, d: 2, level: l, variant: 9, subtype: 'steel', front: 'left' }, `STEEL L${l}`));
  const bld: Item[] = [];
  for (let l = 1; l <= 3; l++) bld.push(buildingItem({ kind: 'builder', w: 2, d: 2, level: l, variant: l, accent: ['#e8792c', '#3a78c8', '#3a9a4a'][l - 1], sign: ['BOB', 'BUILDCO', 'RAPID'][l - 1], front: fr(l) }, `BUILDER L${l}`));
  return [['Offices', offices], ['Factories', fac], ['Builders yards', bld]];
}

function civicGroups(): [string, Item[]][] {
  const banks: Item[] = [];
  const accents = ['#2f6fb0', '#b03a3a', '#2f8a4a'];
  const names = ['FIRST NATL', 'CITY BANK', 'GREEN TRUST'];
  for (let l = 1; l <= 3; l++) {
    for (const st of ['normal', 'distressed', 'failed'] as const) {
      banks.push(buildingItem({ kind: 'bank', w: 2, d: 2, level: l, variant: l, accent: accents[l - 1], sign: names[l - 1], state: st, front: fr(l), lit: 0.25 }, `BANK L${l} ${st.slice(0, 6)}`));
    }
  }
  const big: Item[] = [
    buildingItem({ kind: 'centralbank', w: 3, d: 3, level: 1, variant: 0 }, 'RESERVE BANK'),
    buildingItem({ kind: 'centralbank', w: 3, d: 3, level: 1, variant: 1, front: 'right', lit: 0.5 }, 'RESERVE (RIGHT)'),
    buildingItem({ kind: 'fund', w: 2, d: 2, level: 1, variant: 0, accent: '#39d353', sign: 'ALPHA' }, 'FUND BULL'),
    buildingItem({ kind: 'fund', w: 2, d: 2, level: 1, variant: 1, accent: '#ff4040', front: 'right', lit: 0.5 }, 'FUND BEAR'),
    buildingItem({ kind: 'cityhall', w: 2, d: 2, level: 1, variant: 3 }, 'CITY HALL'),
    buildingItem({ kind: 'cityhall', w: 2, d: 2, level: 1, variant: 4, front: 'right', lit: 0.5 }, 'CITY HALL R'),
  ];
  return [['Banks: normal / distressed / failed', banks], ['Reserve bank, fund, city hall', big]];
}

function closedGroups(): [string, Item[]][] {
  const items: Item[] = [];
  for (const [k, sub] of SHOPS.entries()) items.push(buildingItem({ kind: 'shop', w: 1, d: 1, level: 1 + (k % 3), variant: k, subtype: sub, state: 'closed', front: fr(k) }, `${sub.slice(0, 5)}`));
  for (const [k, sub] of SERVICES.entries()) items.push(buildingItem({ kind: 'service', w: 1, d: 1, level: 1 + (k % 3), variant: k, subtype: sub, state: 'closed', front: fr(k) }, `${sub.slice(0, 5)}`));
  const big: Item[] = [];
  for (let l = 2; l <= 4; l += 2) big.push(buildingItem({ kind: 'office', w: 2, d: 2, level: l, variant: l, state: 'closed' }, `OFFICE L${l}`));
  big.push(buildingItem({ kind: 'factory', w: 2, d: 2, level: 3, variant: 2, subtype: 'food', state: 'closed' }, 'FACTORY'));
  big.push(buildingItem({ kind: 'factory', w: 2, d: 2, level: 2, variant: 3, subtype: 'steel', state: 'closed', front: 'right' }, 'FACTORY R'));
  big.push(buildingItem({ kind: 'builder', w: 2, d: 2, level: 2, variant: 1, state: 'closed', accent: '#3a78c8' }, 'BUILDER'));
  return [['Closed shops & services', items], ['Closed offices, factories, builders', big]];
}

function lotGroups(): [string, Item[]][] {
  const lots: Item[] = [];
  for (const [w, d] of [[1, 1], [2, 1], [2, 2], [3, 3]]) for (let v = 0; v < 2; v++) lots.push(buildingItem({ kind: 'emptylot', w, d, level: 1, variant: v * 3 + w }, `LOT ${w}X${d}`));
  const parks: Item[] = [];
  for (const [w, d] of [[1, 1], [2, 2], [3, 3]]) for (let v = 0; v < 3; v++) parks.push(buildingItem({ kind: 'park', w, d, level: 1, variant: v, front: fr(v) }, `PARK ${w}X${d} V${v}`));
  return [['Empty lots', lots], ['Parks', parks]];
}

function constructionGroups(): [string, Item[]][] {
  const PR = [0.05, 0.3, 0.6, 0.9];
  const mk = (w: number, d: number, target: BuildingSpriteSpec['target'], title: string): [string, Item[]] => {
    const items: Item[] = [];
    for (const p of PR) items.push(buildingItem({ kind: 'construction', w, d, level: 1, variant: 3, progress: p, target }, `${Math.round(p * 100)}%`));
    items.push(buildingItem({ kind: 'construction', w, d, level: 1, variant: 3, progress: 0.05, target, state: 'stalled' }, 'STALLED 5%'));
    items.push(buildingItem({ kind: 'construction', w, d, level: 1, variant: 3, progress: 0.5, target, state: 'stalled' }, 'STALLED 50%'));
    items.push(buildingItem({ kind: 'construction', w, d, level: 1, variant: 3, progress: 0.9, target, state: 'stalled' }, 'STALLED 90%'));
    return [title, items];
  };
  return [
    mk(1, 1, { kind: 'house', level: 2 }, 'House (1x1)'),
    mk(1, 1, { kind: 'shop', level: 2, subtype: 'bakery' }, 'Shop (1x1)'),
    mk(2, 2, { kind: 'office', level: 3 }, 'Office L3 (2x2)'),
    mk(2, 2, { kind: 'apartment', level: 2 }, 'Apartment L2 (2x2)'),
    mk(3, 3, { kind: 'office', level: 4 }, 'Tower on 3x3'),
  ];
}

function groundGroups(): [string, Item[]][] {
  const tiles: Item[] = [];
  const kinds: GroundKind[] = ['grass', 'dirt', 'plaza', 'parking', 'sand'];
  for (const k of kinds) for (let v = 0; v < 4; v++) tiles.push(spriteItem(groundTile(k, v), `${k} ${v}`));
  for (let f = 0; f < 4; f++) tiles.push(spriteItem(groundTile('water', 0, f), `water f${f}`));
  // 3x3 patches to check seamless tiling
  const patch = (k: GroundKind): Item => ({
    label: `${k} 3x3`,
    left: 96,
    right: 96,
    up: 0,
    down: 96,
    draw: (ctx, x, y) => {
      for (let ty = 0; ty < 3; ty++)
        for (let tx = 0; tx < 3; tx++) {
          const t = groundTile(k, tx * 7 + ty * 3);
          const p = tileToScreen(tx, ty);
          ctx.drawImage(t.canvas, x + p.x - t.ax, y + p.y - t.ay);
        }
    },
  });
  const patches = (['grass', 'dirt', 'plaza', 'parking', 'sand', 'water'] as GroundKind[]).map(patch);
  const roads: Item[] = [];
  const nm = (m: number) => `${m & ROAD_N ? 'N' : ''}${m & ROAD_E ? 'E' : ''}${m & ROAD_S ? 'S' : ''}${m & ROAD_W ? 'W' : ''}` || '-';
  for (let m = 0; m < 16; m++) roads.push(spriteItem(roadTile(m), `${m} ${nm(m)}`));
  const extra: Item[] = [];
  for (const m of [5, 10, 15, 7, 11]) extra.push(spriteItem(roadTile(m, { crosswalk: true }), `XWALK ${nm(m)}`));
  for (const m of [5, 10, 1, 4]) {
    extra.push(
      spriteItem(roadTile(m, { bridge: true }), `BRIDGE ${nm(m)}`, (ctx, x, y) => {
        const wt = groundTile('water', 0);
        ctx.drawImage(wt.canvas, x - wt.ax, y - wt.ay);
      }),
    );
  }
  const shores: Item[] = [];
  for (let m = 0; m < 16; m++) shores.push(spriteItem(shoreTile(m), `SHORE ${nm(m)}`));
  // a small lake made of shore tiles
  const lake: Item = {
    label: 'lake from shore tiles',
    left: 4 * 32 + 8,
    right: 5 * 32 + 8,
    up: 0,
    down: 9 * 16 + 8,
    draw: (ctx, x, y) => {
      const water = (tx: number, ty: number) => tx >= 1 && tx <= 3 && ty >= 1 && ty <= 2;
      for (let ty = 0; ty < 4; ty++)
        for (let tx = 0; tx < 5; tx++) {
          let t: Sprite;
          if (water(tx, ty)) {
            let m = 0;
            if (!water(tx, ty - 1)) m |= ROAD_N;
            if (!water(tx + 1, ty)) m |= ROAD_E;
            if (!water(tx, ty + 1)) m |= ROAD_S;
            if (!water(tx - 1, ty)) m |= ROAD_W;
            t = shoreTile(m, 1);
          } else t = groundTile('grass', tx + ty * 5);
          const p = tileToScreen(tx, ty);
          ctx.drawImage(t.canvas, x + p.x - t.ax, y + p.y - t.ay);
        }
    },
  };
  return [['Ground tiles', tiles], ['Seamless 3x3 patches', patches], ['Roads: all 16 masks', roads], ['Crosswalks & bridges', extra], ['Shore tiles (bits = land sides)', [...shores, lake]]];
}

function miscGroups(): [string, Item[]][] {
  const onGrass = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    const g = groundTile('grass', 1);
    ctx.drawImage(g.canvas, x - g.ax, y - 16 - g.ay);
  };
  const props: Item[] = [];
  const kinds: [PropKind, number][] = [['tree', 14], ['pine', 6], ['bush', 8], ['lamp', 1], ['bench', 2], ['fountain', 2], ['flowers', 5]];
  for (const [k, n] of kinds) for (let v = 0; v < n; v++) props.push(spriteItem(propSprite(k, v), `${k} ${v}`, onGrass));
  const signs: Item[] = [];
  for (const k of ['sign_forsale', 'sign_sold', 'sign_foreclosed', 'sign_forrent', 'sign_hiring', 'sign_sale', 'sign_lot'] as PropKind[]) signs.push(spriteItem(propSprite(k), k.slice(5), onGrass));
  signs.push(spriteItem(propSprite('crane', 0), 'crane 0', onGrass));
  signs.push(spriteItem(propSprite('crane', 1), 'crane 1', onGrass));
  const vehicles: Item[] = [];
  const vk: [VehicleKind, string | undefined][] = [['car', '#c83a3a'], ['car', '#3a78c8'], ['car', '#e8e4da'], ['truck', '#3a9a4a'], ['van', undefined], ['armored', undefined], ['mixer', '#e8b830'], ['bus', '#e8b830']];
  const onRoad = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
    const t = roadTile(ROAD_N | ROAD_S | ROAD_E | ROAD_W);
    ctx.drawImage(t.canvas, x - t.ax, y - 16 - t.ay);
  };
  for (const [k, c] of vk) for (let d = 0; d < 4; d++) vehicles.push(spriteItem(vehicleSprite(k, d as Dir, c), `${k} d${d}`, onRoad));
  const people: Item[] = [];
  const shirts = ['#d84a4a', '#3a78c8', '#3a9a4a', '#e8b830', '#8a4ab0', '#f0f0f0'];
  for (let d = 0; d < 4; d++) for (let f = 0; f < 2; f++) people.push(spriteItem(personSprite(d as Dir, f, shirts[d]), `d${d} f${f}`));
  people.push(spriteItem(personSprite(0, 0, '#e8792c', { hat: 'hard', pants: '#3a4a6a' }), 'hardhat'));
  people.push(spriteItem(personSprite(1, 1, '#e8792c', { hat: 'hard' }), 'hardhat'));
  people.push(spriteItem(personSprite(0, 0, '#3a78c8', { hat: 'cap' }), 'cap'));
  people.push(spriteItem(personSprite(1, 0, '#d84a8a', { bag: true }), 'bag'));
  people.push(spriteItem(personSprite(3, 1, '#f0f0f0', { skin: '#7a4e30', bag: true }), 'bag back'));
  const icons: Item[] = [];
  for (const k of ['warning', 'alarm', 'money', 'hammer', 'zzz', 'up', 'down', 'house', 'person', 'lock'] as IconKind[]) icons.push(spriteItem(iconSprite(k), k));
  for (let f = 0; f < 4; f++) icons.push(spriteItem(coinSprite(f), `coin ${f}`));
  const text: Item = {
    label: 'pixel font',
    left: 165,
    right: 165,
    up: 0,
    down: 44,
    draw: (ctx, cx, y) => {
      const x = cx - 165;
      drawPixelText(ctx, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789', x, y, '#ffffff');
      drawPixelText(ctx, "$ % + - . , ! ? : / ' & ( ) #  lowercase ok", x, y + 8, '#f2d27a');
      drawPixelText(ctx, 'LOAN APPROVED: $1,250 AT 4.5%!', x, y + 16, '#7bd88f', { shadow: '#000' });
      drawPixelText(ctx, 'BANK RUN!', x, y + 26, '#ff6060', { shadow: '#000', scale: 2 });
      drawPixelText(ctx, 'RIGHT ALIGN', x + 330, y + 26, '#9cc8f0', { align: 'right' });
    },
  };
  return [['Props', props], ['Signs & cranes', signs], ['Vehicles (4 dirs)', vehicles], ['People', people], ['Icons & coins', icons], ['Text', [text]]];
}

// ---------------------------------------------------------------------------
// Mini city: real anchor math + painter's order

interface Lot {
  x: number;
  y: number;
  spec: BuildingSpriteSpec;
}

function city(): void {
  const N = 12;
  const isRiver = (x: number, y: number) => x === 11 && y !== 4;
  const isBridge = (x: number, y: number) => x === 11 && y === 4;
  const isRoad = (x: number, y: number) => x >= 0 && y >= 0 && x < 11 && y < N && (y === 4 || y === 9 || x === 3 || x === 8);
  const roadish = (x: number, y: number) => isRoad(x, y) || isBridge(x, y);
  const L = (x: number, y: number, spec: Partial<BuildingSpriteSpec> & Pick<BuildingSpriteSpec, 'kind' | 'level' | 'variant'>): Lot => ({ x, y, spec: { w: 1, d: 1, ...spec } });
  const lots: Lot[] = [
    // north-west: park + houses
    L(0, 0, { kind: 'park', w: 2, d: 2, level: 1, variant: 2 }),
    L(2, 0, { kind: 'house', level: 2, variant: 11, front: 'right' }),
    L(2, 1, { kind: 'house', level: 1, variant: 3, front: 'right', state: 'vacant' }),
    L(0, 2, { kind: 'house', level: 1, variant: 9, front: 'left' }),
    L(1, 2, { kind: 'emptylot', level: 1, variant: 0 }),
    L(2, 2, { kind: 'house', level: 2, variant: 7, front: 'right' }),
    L(0, 3, { kind: 'house', level: 1, variant: 1, front: 'left' }),
    L(1, 3, { kind: 'house', level: 2, variant: 2, front: 'left' }),
    L(2, 3, { kind: 'house', level: 1, variant: 5, front: 'right' }),
    // downtown north
    L(4, 0, { kind: 'apartment', w: 2, d: 2, level: 4, variant: 2, front: 'left' }),
    L(6, 0, { kind: 'office', w: 2, d: 2, level: 4, variant: 1, front: 'left', lit: 0.25 }),
    L(4, 2, { kind: 'bank', w: 2, d: 2, level: 2, variant: 1, accent: '#2f6fb0', sign: 'FIRST NATL', front: 'left' }),
    L(6, 2, { kind: 'fund', w: 2, d: 2, level: 1, variant: 0, accent: '#39d353', sign: 'ALPHA', front: 'left' }),
    // industry east
    L(9, 0, { kind: 'factory', w: 2, d: 2, level: 3, variant: 2, subtype: 'food', front: 'left' }),
    L(9, 2, { kind: 'builder', w: 2, d: 2, level: 2, variant: 1, accent: '#e8792c', sign: 'BOB', front: 'left' }),
    // west middle: shops & homes
    L(0, 5, { kind: 'shop', level: 1, variant: 1, subtype: 'grocery', front: 'left' }),
    L(1, 5, { kind: 'service', level: 1, variant: 2, subtype: 'cafe', front: 'left' }),
    L(2, 5, { kind: 'shop', level: 2, variant: 3, subtype: 'clothing', front: 'right' }),
    L(0, 6, { kind: 'house', level: 2, variant: 4, front: 'left' }),
    L(1, 6, { kind: 'house', level: 1, variant: 6, front: 'left' }),
    L(2, 6, { kind: 'service', level: 2, variant: 5, subtype: 'salon', front: 'right' }),
    L(0, 7, { kind: 'house', level: 1, variant: 8, front: 'left' }),
    L(1, 7, { kind: 'construction', level: 1, variant: 2, progress: 0.4, target: { kind: 'house', level: 2 } }),
    L(2, 7, { kind: 'shop', level: 3, variant: 2, subtype: 'electronics', front: 'right' }),
    L(0, 8, { kind: 'house', level: 2, variant: 10, front: 'left' }),
    L(1, 8, { kind: 'shop', level: 1, variant: 4, subtype: 'bakery', front: 'left' }),
    L(2, 8, { kind: 'service', level: 1, variant: 1, subtype: 'diner', front: 'left' }),
    // centre: the Reserve Bank and a shopping street
    L(4, 5, { kind: 'centralbank', w: 3, d: 3, level: 1, variant: 0, front: 'left' }),
    L(7, 5, { kind: 'shop', level: 2, variant: 5, subtype: 'pharmacy', front: 'left' }),
    L(7, 6, { kind: 'service', level: 3, variant: 3, subtype: 'cinema', front: 'left' }),
    L(7, 7, { kind: 'shop', level: 1, variant: 6, subtype: 'books', front: 'left', state: 'closed' }),
    L(4, 8, { kind: 'service', level: 2, variant: 7, subtype: 'restaurant', front: 'left' }),
    L(5, 8, { kind: 'shop', level: 1, variant: 8, subtype: 'hardware', front: 'left' }),
    L(6, 8, { kind: 'service', level: 1, variant: 4, subtype: 'gym', front: 'left' }),
    L(7, 8, { kind: 'service', level: 2, variant: 9, subtype: 'clinic', front: 'left' }),
    // east middle
    L(9, 5, { kind: 'cityhall', w: 2, d: 2, level: 1, variant: 3, front: 'left' }),
    L(9, 7, { kind: 'bank', w: 2, d: 2, level: 1, variant: 4, accent: '#b03a3a', sign: 'CITY BANK', state: 'failed', front: 'left' }),
    // south
    L(0, 10, { kind: 'house', level: 1, variant: 12, front: 'left', state: 'vacant' }),
    L(1, 10, { kind: 'house', level: 2, variant: 13, front: 'left' }),
    L(2, 10, { kind: 'house', level: 1, variant: 14, front: 'right' }),
    L(0, 11, { kind: 'house', level: 2, variant: 15, front: 'left' }),
    L(1, 11, { kind: 'emptylot', level: 1, variant: 3 }),
    L(2, 11, { kind: 'house', level: 1, variant: 16, front: 'right' }),
    L(4, 10, { kind: 'construction', w: 2, d: 2, level: 1, variant: 1, progress: 0.55, target: { kind: 'office', level: 3 } }),
    L(6, 10, { kind: 'construction', w: 2, d: 2, level: 1, variant: 5, progress: 0.3, state: 'stalled', target: { kind: 'apartment', level: 3 } }),
    L(9, 10, { kind: 'park', w: 2, d: 2, level: 1, variant: 0 }),
  ];
  // canvas extents from the real sprites
  const margin = 16;
  let minX = -N * 32, maxX = N * 32, minY = 0, maxY = N * 32;
  for (const l of lots) {
    const s = buildingSprite(l.spec);
    const p = tileToScreen(l.x, l.y);
    minX = Math.min(minX, p.x - s.ax);
    maxX = Math.max(maxX, p.x - s.ax + s.canvas.width);
    minY = Math.min(minY, p.y - s.ay);
    maxY = Math.max(maxY, p.y - s.ay + s.canvas.height);
  }
  const W = Math.ceil(maxX - minX + 2 * margin);
  const H = Math.ceil(maxY - minY + 2 * margin + 10);
  const page = makePage(W, H, '#1f2530');
  const ctx = page.ctx;
  const ox = margin - minX;
  const oy = margin - minY + 10;
  drawPixelText(ctx, "MINI CITY - REAL ANCHOR MATH, PAINTER'S ORDER", 6, 4, '#f2d27a', { shadow: '#000' });
  const at = (s: Sprite, sx: number, sy: number) => ctx.drawImage(s.canvas, Math.round(ox + sx - s.ax), Math.round(oy + sy - s.ay));
  const frame = Number(params.get('frame') ?? 0);

  // ground pass (flat tiles only; bridges go in the object pass)
  const occupied = new Set<string>();
  for (const l of lots) for (let dy = 0; dy < l.spec.d; dy++) for (let dx = 0; dx < l.spec.w; dx++) occupied.add(`${l.x + dx},${l.y + dy}`);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const p = tileToScreen(x, y);
      if (isRiver(x, y) || isBridge(x, y)) {
        let m = 0;
        if (!isRiver(x - 1, y) && !isBridge(x - 1, y)) m |= ROAD_W;
        const wv = (x * 7 + y * 3) % 4;
        at(isBridge(x, y) ? groundTile('water', wv, frame) : m ? shoreTile(m, frame) : groundTile('water', wv, frame), p.x, p.y);
      } else if (isRoad(x, y)) {
        let m = 0;
        if (roadish(x, y - 1)) m |= ROAD_N;
        if (roadish(x + 1, y)) m |= ROAD_E;
        if (roadish(x, y + 1)) m |= ROAD_S;
        if (roadish(x - 1, y)) m |= ROAD_W;
        const cross = (x === 3 || x === 8) && (y === 4 || y === 9);
        at(roadTile(m, { crosswalk: cross }), p.x, p.y);
      } else if (!occupied.has(`${x},${y}`)) {
        at(groundTile('grass', (x * 7 + y * 13) % 16), p.x, p.y);
      }
    }
  }

  // object pass: buildings, bridge, vehicles, people, props sorted by depth key
  interface Obj {
    key: number;
    draw: () => void;
  }
  const objs: Obj[] = [];
  for (const l of lots) {
    const s = buildingSprite(l.spec);
    const p = tileToScreen(l.x, l.y);
    objs.push({ key: l.x + l.spec.w + l.y + l.spec.d + (l.x + l.y) * 0.001, draw: () => at(s, p.x, p.y) });
  }
  const bp = tileToScreen(11, 4);
  objs.push({ key: 11 + 1 + 4 + 1, draw: () => at(roadTile(ROAD_W | ROAD_E, { bridge: true }), bp.x, bp.y) });
  // vehicles: [tile x, tile y, dir, kind, colour]; they keep to the right of their lane
  const cars: [number, number, Dir, VehicleKind, string][] = [
    [1.5, 4.3, 0, 'car', '#c83a3a'],
    [6.4, 4.7, 2, 'bus', '#e8b830'],
    [3.3, 1.5, 1, 'car', '#3a78c8'],
    [3.7, 7.2, 3, 'truck', '#3a9a4a'],
    [8.3, 2.5, 1, 'armored', ''],
    [8.7, 10.4, 3, 'car', '#e8e4da'],
    [5.5, 9.3, 0, 'van', ''],
    [11.4, 4.3, 0, 'car', '#8a4ab0'],
    [1.6, 9.7, 2, 'mixer', '#e8b830'],
    [8.3, 6.5, 1, 'car', '#e8792c'],
  ];
  for (const [tx, ty, d, k, c] of cars) {
    const s = vehicleSprite(k, d, c || undefined);
    const p = tileToScreen(tx, ty);
    objs.push({ key: tx + ty + 0.6, draw: () => at(s, p.x, p.y) });
  }
  // pedestrians on the sidewalks
  const walkers: [number, number, Dir, string, 'none' | 'hard' | 'cap', boolean][] = [
    [0.5, 4.08, 0, '#d84a4a', 'none', false],
    [2.2, 4.92, 2, '#3a78c8', 'none', true],
    [3.08, 2.4, 1, '#3a9a4a', 'cap', false],
    [3.92, 6.2, 3, '#f0f0f0', 'none', true],
    [5.2, 9.08, 0, '#e8792c', 'hard', false],
    [7.4, 9.92, 2, '#8a4ab0', 'none', false],
    [8.08, 8.0, 1, '#e8b830', 'none', true],
    [6.8, 4.08, 0, '#40b0b0', 'none', false],
    [4.6, 4.92, 2, '#b04040', 'none', true],
    [8.92, 1.2, 3, '#e8792c', 'hard', false],
  ];
  walkers.forEach(([tx, ty, d, shirt, hat, bag], i) => {
    const s = personSprite(d, (frame + i) % 2, shirt, { hat, bag });
    const p = tileToScreen(tx, ty);
    objs.push({ key: tx + ty + 0.5, draw: () => at(s, p.x, p.y) });
  });
  // a few props placed on lots
  const props: [number, number, PropKind, number][] = [
    [10.6, 9.4, 'tree', 3],
    [0.75, 10.85, 'sign_foreclosed', 0],
    [2.2, 1.85, 'sign_forsale', 0],
    [1.5, 11.85, 'sign_lot', 0],
    [7.5, 7.88, 'sign_sale', 0],
    [2.8, 11.85, 'sign_sold', 0],
  ];
  for (const [tx, ty, k, v] of props) {
    const s = propSprite(k, v);
    const p = tileToScreen(tx, ty);
    objs.push({ key: tx + ty + 0.3, draw: () => at(s, p.x, p.y) });
  }
  objs.sort((a, b) => a.key - b.key);
  for (const o of objs) o.draw();
  // status icons float at Sprite.top
  const iconAt = (x: number, y: number, k: IconKind) => {
    const l = lots.find((q) => q.x === x && q.y === y);
    if (!l) return;
    const s = buildingSprite(l.spec);
    if (!s.top) return;
    const p = tileToScreen(l.x, l.y);
    at(iconSprite(k), p.x - s.ax + s.top.x, p.y - s.ay + s.top.y);
  };
  iconAt(9, 7, 'lock');
  iconAt(4, 2, 'money');
  iconAt(4, 10, 'hammer');
  iconAt(7, 7, 'zzz');
  iconAt(6, 2, 'up');
  iconAt(0, 10, 'house');
  iconAt(9, 2, 'person');
  iconAt(6, 10, 'warning');
}

// ---------------------------------------------------------------------------
// Automated checks: footprint alignment, anchors, determinism, generation time

/** Raster head-room per kind (mirrors buildings/index.ts) to detect clipping at the top. */
function headroomHint(spec: BuildingSpriteSpec): number {
  const t: Record<string, number> = { house: 72, apartment: 140, shop: 100, service: 100, factory: 110, builder: 70, bank: 116, centralbank: 160, fund: 216, cityhall: 146, construction: 236, emptylot: 40, park: 64 };
  if (spec.kind === 'office') return [95, 125, 165, 222][spec.level - 1];
  return t[spec.kind] ?? 64;
}

function verify(): void {
  // check root causes with the safety clip disabled (?clip=1 to test the shipped path)
  buildingDebug.clip = params.get('clip') === '1';
  const specs: BuildingSpriteSpec[] = [];
  const kinds: [BuildingSpriteSpec['kind'], number, number, number][] = [
    ['house', 1, 1, 2],
    ['apartment', 2, 2, 4],
    ['shop', 1, 1, 3],
    ['service', 1, 1, 3],
    ['office', 2, 2, 4],
    ['factory', 2, 2, 4],
    ['builder', 2, 2, 3],
    ['bank', 2, 2, 3],
    ['centralbank', 3, 3, 1],
    ['fund', 2, 2, 1],
    ['cityhall', 2, 2, 1],
  ];
  const states = ['normal', 'closed', 'failed', 'distressed', 'vacant'] as const;
  for (const [kind, w, d, maxL] of kinds) {
    for (let l = 1; l <= maxL; l++) {
      for (let v = 0; v < 4; v++) {
        for (const st of states) {
          const subs = kind === 'shop' ? SHOPS : kind === 'service' ? SERVICES : kind === 'factory' ? FACTORIES : [''];
          const sub = subs[(v + l) % subs.length];
          specs.push({ kind, w, d, level: l, variant: v * 7 + l, subtype: sub, state: st, front: v % 2 ? 'right' : 'left', lit: (v % 3) * 0.5, accent: '#3a78c8', sign: 'TEST CO' });
        }
      }
    }
  }
  for (const [w, d] of [[1, 1], [2, 1], [1, 2], [2, 2], [3, 3], [3, 2]]) {
    for (let v = 0; v < 3; v++) {
      specs.push({ kind: 'emptylot', w, d, level: 1, variant: v });
      specs.push({ kind: 'park', w, d, level: 1, variant: v, front: v % 2 ? 'right' : 'left' });
      for (const p of [0.05, 0.3, 0.6, 0.9])
        for (const st of ['normal', 'stalled'] as const)
          specs.push({ kind: 'construction', w, d, level: 1, variant: v, progress: p, state: st, target: { kind: w * d >= 4 ? 'office' : 'house', level: 2 } });
    }
  }
  const perKind = new Map<string, number>();
  const kindTime = new Map<string, [number, number]>();
  const sizes = new Map<string, [number, number, number]>();
  // warm up the JIT so timings are representative
  for (let v = 0; v < 6; v++) buildingSprite({ kind: 'shop', w: 1, d: 1, level: 1 + (v % 3), variant: 1000 + v });
  let fails = 0;
  let maxMs = 0;
  let maxSpec = '';
  let total = 0;
  const lines: string[] = [];
  for (const spec of specs) {
    const t = performance.now();
    const s = buildingSprite(spec);
    const ms = performance.now() - t;
    total += ms;
    const sz = sizes.get(spec.kind) ?? [0, 0, 0];
    sizes.set(spec.kind, [Math.max(sz[0], s.canvas.width), Math.max(sz[1], s.canvas.height), Math.max(sz[2], s.ay)]);
    const tk = kindTime.get(spec.kind) ?? [0, 0];
    kindTime.set(spec.kind, [tk[0] + ms, tk[1] + 1]);
    if (ms > maxMs) {
      maxMs = ms;
      maxSpec = `${spec.kind} L${spec.level} ${spec.state ?? ''}`;
    }
    const cx = s.canvas.getContext('2d')!;
    const img = cx.getImageData(0, 0, s.canvas.width, s.canvas.height).data;
    const alpha = (px: number, py: number) => {
      const X = px + s.ax, Y = py + s.ay;
      if (X < 0 || Y < 0 || X >= s.canvas.width || Y >= s.canvas.height) return 0;
      return img[(Y * s.canvas.width + X) * 4 + 3];
    };
    let holes = 0;
    let spill = 0;
    let spillOpaque = 0;
    const spillAt: string[] = [];
    const W = spec.w * 32, D = spec.d * 32;
    for (let py = -2; py < 16 * (spec.w + spec.d) + 40; py++) {
      for (let px = -32 * spec.d - 40; px < 32 * spec.w + 40; px++) {
        const U = px + 2 * py + 1, V = 2 * py - px;
        const inside = U >= 0 && U < 2 * W && V >= 0 && V < 2 * D;
        const a = alpha(px, py);
        if (inside && a < 255) holes++;
        // below the lower edges of the diamond (ground level in front of the lot)
        const below = U >= 2 * W || V >= 2 * D;
        const aboveTop = U < 0 || V < 0;
        if (!inside && below && !aboveTop && a > 0) {
          spill++;
          if (a === 255) spillOpaque++;
          if (spillAt.length < 3) spillAt.push(`(${px},${py})a${a}`);
        }
      }
    }
    const errs: string[] = [];
    // content cropped at the raster's top edge means the headroom estimate is too small
    if (s.ay >= 0) {
      let topHit = false;
      for (let X = 0; X < s.canvas.width && !topHit; X++) if (img[X * 4 + 3] > 0 && s.canvas.height > 0) topHit = s.ay >= headroomHint(spec);
      if (topHit) errs.push(`touches top (ay=${s.ay})`);
    }
    if (holes) errs.push(`${holes} holes in lot`);
    if (spill) errs.push(`${spill} px spill below footprint (${spillOpaque} opaque) ${spillAt.join(' ')}`);
    if (!s.top) errs.push('no top anchor');
    if (spec.kind !== 'emptylot' && spec.kind !== 'park' && spec.kind !== 'construction' && !s.door) errs.push('no door');
    if (spec.kind === 'factory' && spec.state !== 'closed' && !(s.chimneys && s.chimneys.length)) errs.push('no chimneys');
    if (errs.length) {
      fails++;
      const kk = `${spec.kind}`;
      perKind.set(kk, (perKind.get(kk) ?? 0) + 1);
      if (lines.length < 40 && (perKind.get(kk) ?? 0) <= 4) lines.push(`${spec.kind} ${spec.w}x${spec.d} L${spec.level} v${spec.variant} ${spec.state ?? ''} ${spec.front ?? ''} p${spec.progress ?? ''}: ${errs.join(', ')}`);
    }
  }
  // memo: an identical spec with different object identity hits the same key
  const a = buildingSprite({ kind: 'house', w: 1, d: 1, level: 1, variant: 5 });
  const b = buildingSprite({ variant: 5, level: 1, d: 1, w: 1, kind: 'house' });
  // determinism: regenerate a sample with the cache bypassed and compare pixels
  buildingDebug.noCache = true;
  let diffs = 0;
  for (let k = 0; k < specs.length; k += 13) {
    const s1 = buildingSprite(specs[k]);
    const s2 = buildingSprite(specs[k]);
    const d1 = s1.canvas.getContext('2d')!.getImageData(0, 0, s1.canvas.width, s1.canvas.height).data;
    const d2 = s2.canvas.getContext('2d')!.getImageData(0, 0, s2.canvas.width, s2.canvas.height).data;
    let same = d1.length === d2.length && s1.ax === s2.ax && s1.ay === s2.ay;
    for (let q = 0; same && q < d1.length; q++) if (d1[q] !== d2[q]) same = false;
    if (!same) diffs++;
  }
  buildingDebug.noCache = false;
  const summary = `VERIFY: ${specs.length} sprites, ${fails} with problems; avg ${(total / specs.length).toFixed(2)} ms, max ${maxMs.toFixed(1)} ms (${maxSpec}); memo ${a === b ? 'ok' : 'BROKEN'}; determinism ${diffs ? diffs + ' DIFFS' : 'ok'}`;
  console.log(summary);
  console.log('per kind: ' + [...perKind.entries()].map(([k, n]) => `${k}=${n}`).join(' '));
  console.log('max WxH (height above top corner): ' + [...sizes.entries()].map(([k, [w, h, ay]]) => `${k}=${w}x${h}(${ay})`).join(' '));
  console.log('ms/sprite: ' + [...kindTime.entries()].map(([k, [t, n]]) => `${k}=${(t / n).toFixed(1)}`).join(' '));
  for (const l of lines) console.log('  ' + l);
  const page = makePage(900, 40 + lines.length * 9);
  drawPixelText(page.ctx, summary, 6, 6, fails ? '#ff8080' : '#80ff80');
  lines.forEach((l, i) => drawPixelText(page.ctx, l, 6, 20 + i * 9, '#e8e4d8'));
}

// ---------------------------------------------------------------------------

const t0 = performance.now();
switch (section) {
  case 'res':
    renderGroups(resGroups());
    break;
  case 'com':
    renderGroups(comGroups());
    break;
  case 'biz':
    renderGroups(bizGroups());
    break;
  case 'civic':
    renderGroups(civicGroups());
    break;
  case 'closed':
    renderGroups(closedGroups());
    break;
  case 'lots':
    renderGroups(lotGroups());
    break;
  case 'buildings':
    renderGroups([...resGroups(), ...comGroups(), ...bizGroups(), ...civicGroups(), ...closedGroups(), ...lotGroups()]);
    break;
  case 'construction':
    renderGroups(constructionGroups());
    break;
  case 'ground':
    renderGroups(groundGroups());
    break;
  case 'misc':
    renderGroups(miscGroups());
    break;
  case 'verify':
    verify();
    break;
  default:
    city();
}
console.log(`gallery '${section}' rendered in ${(performance.now() - t0).toFixed(0)} ms`);
