// Procedural city layout: a grid of roads, blocks subdivided into lots, a river with a
// bridge to the outside world, parks and a downtown around the Reserve Bank.
// Pure data — no rendering — so the simulation can run headless.

import { Rng } from '../sim/rng';
import { ROAD_E, ROAD_N, ROAD_S, ROAD_W } from '../render/iso';

export type Zone = 'res' | 'com' | 'ind' | 'civic' | 'park';

export const enum Terrain {
  Grass = 0,
  Water = 1,
  Road = 2,
  Lot = 3,
  Plaza = 4,
  Sand = 5,
  Garden = 6, // private garden / backyard tile inside a block
  Parking = 7,
  Bridge = 8,
}

export interface Lot {
  id: number;
  x: number;
  y: number;
  w: number;
  d: number;
  zone: Zone;
  /** road tile the lot's front door opens onto */
  road: { x: number; y: number };
  /** which side of the lot the road is on (ROAD_* bit, from the lot's perspective) */
  facing: number;
  /** reserved lots (civic buildings) cannot be redeveloped */
  reserved?: 'centralbank' | 'cityhall' | 'fund' | 'bank';
}

export interface Decoration {
  x: number;
  y: number;
  kind: 'tree' | 'pine' | 'bush' | 'lamp' | 'bench' | 'fountain' | 'flowers';
  variant: number;
}

export interface City {
  W: number;
  H: number;
  terrain: Uint8Array;
  roadMask: Uint8Array;
  lotAt: Int32Array;
  lots: Lot[];
  decorations: Decoration[];
  /** road tile at the map edge where newcomers arrive / leave */
  gateway: { x: number; y: number };
  name: string;
}

const BLOCK = 4; // block interior size in tiles
const PITCH = BLOCK + 1; // road every PITCH tiles
const NB = 6; // blocks per axis
const MARGIN_W = 3; // west/north margin
const RIVER_W = 3;

const CITY_NAMES = [
  'Millbrook',
  'Harbor Falls',
  'Copperton',
  'Westmere',
  'Ashford Bay',
  'Lindenfield',
  'Stonebridge',
  'Port Alder',
];

// Zone plan for the 6x6 block grid (row = by, col = bx). C = civic/downtown.
// r = residential, c = commercial, i = industrial, p = park, C = downtown civic, m = mixed res/com
const PLAN = [
  'rrrmcr',
  'rrccpi',
  'rmCCci',
  'rcCCii',
  'prcmii',
  'rrrcri',
];

export function generateCity(seed: number): City {
  const rng = new Rng(seed ^ 0x51ed27);
  const W = MARGIN_W + NB * PITCH + 1 + RIVER_W + 2;
  const H = MARGIN_W + NB * PITCH + 1 + 3;
  const terrain = new Uint8Array(W * H);
  const roadMask = new Uint8Array(W * H);
  const lotAt = new Int32Array(W * H).fill(-1);
  const lots: Lot[] = [];
  const decorations: Decoration[] = [];
  const idx = (x: number, y: number) => y * W + x;
  const inb = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;

  const ox = MARGIN_W;
  const oy = MARGIN_W;
  const gridEnd = ox + NB * PITCH; // last road line coordinate

  // River along the east edge.
  const riverX0 = gridEnd + 2;
  for (let y = 0; y < H; y++) {
    const wobble = Math.round(Math.sin(y * 0.35) * 0.8);
    for (let x = riverX0 + wobble; x < riverX0 + wobble + RIVER_W && x < W; x++) terrain[idx(x, y)] = Terrain.Water;
    const sx = riverX0 + wobble - 1;
    if (inb(sx, y)) terrain[idx(sx, y)] = Terrain.Sand;
    const ex = riverX0 + wobble + RIVER_W;
    if (inb(ex, y)) terrain[idx(ex, y)] = Terrain.Sand;
  }

  // Road grid.
  for (let i = 0; i <= NB; i++) {
    const rx = ox + i * PITCH;
    const ry = oy + i * PITCH;
    for (let t = oy; t <= gridEnd; t++) terrain[idx(rx, t)] = Terrain.Road;
    for (let t = ox; t <= gridEnd; t++) terrain[idx(t, ry)] = Terrain.Road;
  }

  // Bridge road to the outside world, heading east across the river from the middle avenue.
  const bridgeY = oy + 3 * PITCH;
  let gateway = { x: W - 1, y: bridgeY };
  for (let x = gridEnd + 1; x < W; x++) {
    const t = terrain[idx(x, bridgeY)];
    terrain[idx(x, bridgeY)] = t === Terrain.Water ? Terrain.Bridge : Terrain.Road;
    gateway = { x, y: bridgeY };
  }

  // Road connectivity masks.
  const isRoad = (x: number, y: number) =>
    inb(x, y) && (terrain[idx(x, y)] === Terrain.Road || terrain[idx(x, y)] === Terrain.Bridge);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!isRoad(x, y)) continue;
      let m = 0;
      if (isRoad(x, y - 1)) m |= ROAD_N;
      if (isRoad(x + 1, y)) m |= ROAD_E;
      if (isRoad(x, y + 1)) m |= ROAD_S;
      if (isRoad(x - 1, y)) m |= ROAD_W;
      roadMask[idx(x, y)] = m;
    }

  const addLot = (x: number, y: number, w: number, d: number, zone: Zone, reserved?: Lot['reserved']) => {
    // find the adjacent road: prefer the side facing down-left (+y) or down-right (+x) so doors face the viewer
    const candidates: { x: number; y: number; facing: number }[] = [];
    for (let i = 0; i < w; i++) {
      if (isRoad(x + i, y + d)) candidates.push({ x: x + i, y: y + d, facing: ROAD_S });
      if (isRoad(x + i, y - 1)) candidates.push({ x: x + i, y: y - 1, facing: ROAD_N });
    }
    for (let j = 0; j < d; j++) {
      if (isRoad(x + w, y + j)) candidates.push({ x: x + w, y: y + j, facing: ROAD_E });
      if (isRoad(x - 1, y + j)) candidates.push({ x: x - 1, y: y + j, facing: ROAD_W });
    }
    if (!candidates.length) return null;
    const pref = [ROAD_S, ROAD_E, ROAD_W, ROAD_N];
    candidates.sort((a, b) => pref.indexOf(a.facing) - pref.indexOf(b.facing));
    const c = candidates[0];
    const lot: Lot = { id: lots.length, x, y, w, d, zone, road: { x: c.x, y: c.y }, facing: c.facing, reserved };
    lots.push(lot);
    for (let j = 0; j < d; j++)
      for (let i = 0; i < w; i++) {
        terrain[idx(x + i, y + j)] = Terrain.Lot;
        lotAt[idx(x + i, y + j)] = lot.id;
      }
    return lot;
  };

  const garden = (x: number, y: number) => {
    terrain[idx(x, y)] = Terrain.Garden;
    decorations.push({ x, y, kind: rng.chance(0.3) ? 'pine' : 'tree', variant: rng.int(0, 7) });
  };

  let downtownDone = false;
  for (let by = 0; by < NB; by++)
    for (let bx = 0; bx < NB; bx++) {
      const zc = PLAN[by][bx];
      const x0 = ox + bx * PITCH + 1;
      const y0 = oy + by * PITCH + 1;
      if (zc === 'p') {
        // whole-block park
        for (let j = 0; j < BLOCK; j++)
          for (let i = 0; i < BLOCK; i++) {
            terrain[idx(x0 + i, y0 + j)] = Terrain.Grass;
          }
        addLot(x0, y0, BLOCK, BLOCK, 'park');
        continue;
      }
      if (zc === 'C') {
        if (!downtownDone) {
          // Four downtown blocks handled as one: CB block (top-left), then civic quadrants.
          downtownDone = true;
          // Central bank block
          addLot(x0, y0, 3, 3, 'civic', 'centralbank');
          for (let i = 0; i < BLOCK; i++) {
            terrain[idx(x0 + 3, y0 + i)] = Terrain.Plaza;
            terrain[idx(x0 + i, y0 + 3)] = Terrain.Plaza;
          }
          decorations.push({ x: x0 + 3, y: y0 + 3, kind: 'fountain', variant: 0 });
          decorations.push({ x: x0 + 3, y: y0 + 0, kind: 'lamp', variant: 0 });
          decorations.push({ x: x0 + 0, y: y0 + 3, kind: 'lamp', variant: 0 });
          decorations.push({ x: x0 + 3, y: y0 + 1, kind: 'flowers', variant: 1 });
          decorations.push({ x: x0 + 1, y: y0 + 3, kind: 'flowers', variant: 2 });
          // East downtown block: city hall + fund tower + 2 bank lots
          const ex = x0 + PITCH;
          addLot(ex, y0, 2, 2, 'civic', 'cityhall');
          addLot(ex + 2, y0, 2, 2, 'civic', 'fund');
          addLot(ex, y0 + 2, 2, 2, 'civic', 'bank');
          addLot(ex + 2, y0 + 2, 2, 2, 'com');
          // South downtown block: banks and offices
          const sy = y0 + PITCH;
          addLot(x0, sy, 2, 2, 'civic', 'bank');
          addLot(x0 + 2, sy, 2, 2, 'civic', 'bank');
          addLot(x0, sy + 2, 2, 2, 'com');
          addLot(x0 + 2, sy + 2, 2, 2, 'civic', 'bank');
          // South-east downtown block: bank + offices
          addLot(ex, sy, 2, 2, 'civic', 'bank');
          addLot(ex + 2, sy, 2, 2, 'com');
          addLot(ex, sy + 2, 2, 2, 'com');
          addLot(ex + 2, sy + 2, 2, 2, 'com');
        }
        continue;
      }
      // Regular blocks: 4 quadrants of 2x2.
      for (let q = 0; q < 4; q++) {
        const qx = x0 + (q % 2) * 2;
        const qy = y0 + Math.floor(q / 2) * 2;
        let zone: Zone = zc === 'r' ? 'res' : zc === 'c' ? 'com' : zc === 'i' ? 'ind' : rng.chance(0.5) ? 'res' : 'com';
        if (zone === 'ind') {
          addLot(qx, qy, 2, 2, 'ind');
          continue;
        }
        const big = zone === 'res' ? rng.chance(0.3) : rng.chance(0.28);
        if (big) {
          addLot(qx, qy, 2, 2, zone);
          continue;
        }
        // small lots: 3 road-facing 1x1 lots + an interior garden/parking tile
        for (let t = 0; t < 4; t++) {
          const tx = qx + (t % 2);
          const ty = qy + Math.floor(t / 2);
          // interior tile = the one not touching the block edge in both axes
          const interiorX = q % 2 === 0 ? tx === qx + 1 : tx === qx;
          const interiorY = Math.floor(q / 2) === 0 ? ty === qy + 1 : ty === qy;
          if (interiorX && interiorY) {
            if (zone === 'com' && rng.chance(0.6)) terrain[idx(tx, ty)] = Terrain.Parking;
            else garden(tx, ty);
            continue;
          }
          addLot(tx, ty, 1, 1, zone);
        }
      }
    }

  // Scatter trees in the margins (not on water/roads).
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const t = terrain[idx(x, y)];
      if (t !== Terrain.Grass) continue;
      if (lotAt[idx(x, y)] >= 0) continue;
      const nearGrid = x >= ox - 1 && x <= gridEnd + 1 && y >= oy - 1 && y <= gridEnd + 1;
      const p = nearGrid ? 0.08 : 0.45;
      if (rng.chance(p)) decorations.push({ x, y, kind: rng.chance(0.45) ? 'pine' : rng.chance(0.2) ? 'bush' : 'tree', variant: rng.int(0, 7) });
    }
  // Street lamps along a few avenues.
  for (let i = 0; i <= NB; i += 2) {
    const ry = oy + i * PITCH;
    for (let x = ox + 2; x < gridEnd; x += 5) {
      const ly = ry + 1;
      if (inb(x, ly) && terrain[idx(x, ly)] === Terrain.Plaza) decorations.push({ x, y: ly, kind: 'lamp', variant: 0 });
    }
  }

  return {
    W,
    H,
    terrain,
    roadMask,
    lotAt,
    lots,
    decorations,
    gateway,
    name: CITY_NAMES[Math.floor(rng.next() * CITY_NAMES.length)],
  };
}

export function isRoadTile(city: City, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= city.W || y >= city.H) return false;
  const t = city.terrain[y * city.W + x];
  return t === Terrain.Road || t === Terrain.Bridge;
}
