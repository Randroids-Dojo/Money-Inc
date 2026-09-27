// Contract between the renderer and the procedural pixel-art sprite library.
// Everything here is original, procedurally drawn art (no external assets).

export type BuildingKind =
  | 'house' // 1x1 detached home (level 1 cottage, level 2 two-storey)
  | 'apartment' // 2x2 apartment block (level 1..4 => ~2,3,4,6 storeys)
  | 'shop' // 1x1 retail store (level 1..3)
  | 'service' // 1x1 consumer service business (level 1..3)
  | 'office' // 2x2 office building (level 1..4 => ~3,5,8,12 storeys)
  | 'factory' // 2x2 manufacturing plant (level 1..4: sheds, chimneys, silos, wings)
  | 'builder' // 2x2 construction company yard (level 1..3)
  | 'bank' // 2x2 commercial bank (level 1..3), uses accent colour + sign text
  | 'centralbank' // 3x3 the Reserve Bank (columns, dome, flag)
  | 'fund' // 2x2 investment fund glass tower with rooftop ticker
  | 'cityhall' // 2x2 civic building with clock tower
  | 'construction' // any footprint: building site, uses progress + target
  | 'emptylot' // any footprint: vacant land for sale
  | 'park'; // any footprint: trees, paths, benches, fountain

export type BuildingState =
  | 'normal'
  | 'closed' // business shut down: boarded windows, faded colours, CLOSED / FOR LEASE
  | 'failed' // bank closed by regulator: shutters, CLOSED sign, dark
  | 'distressed' // bank/business under stress: drawn normally but with a subtle grim tint
  | 'stalled' // construction halted: tarp, idle crane, weeds
  | 'vacant' // residential with nobody home: all windows dark
  | 'wild'; // empty land far from town: grass, no for-sale sign (Genesis Mode)

export type RetailSubtype =
  | 'grocery'
  | 'clothing'
  | 'electronics'
  | 'hardware'
  | 'furniture'
  | 'pharmacy'
  | 'bakery'
  | 'books';

export type ServiceSubtype =
  | 'diner'
  | 'cafe'
  | 'clinic'
  | 'cinema'
  | 'gym'
  | 'salon'
  | 'restaurant'
  | 'lawoffice';

export interface BuildingSpriteSpec {
  kind: BuildingKind;
  /** footprint width in tiles along +x */
  w: number;
  /** footprint depth in tiles along +y */
  d: number;
  /** size tier, 1..4 (clamped per kind) */
  level: number;
  /** deterministic style seed (wall/roof colours, shapes) */
  variant: number;
  /** flavour for shops/services/factories */
  subtype?: string;
  /** CSS hex colour: bank brand colour / company colour */
  accent?: string;
  /** short sign text, A-Z 0-9 space & . - ! $ % ' , max ~10 chars */
  sign?: string;
  state?: BuildingState;
  /** construction progress 0..1 */
  progress?: number;
  /** what a construction site will become */
  target?: { kind: BuildingKind; level: number; subtype?: string };
  /** fraction of windows lit (0..1), quantised by the caller to 0, .25, .5, .75, 1 */
  lit?: number;
  /**
   * Which visible face carries the main facade / front door (optional, default 'left').
   * 'left' = the face along y = y+d (looks down-left, towards +y / ROAD_S);
   * 'right' = the face along x = x+w (looks down-right, towards +x / ROAD_E).
   * Pick the side that faces the lot's road.
   */
  front?: 'left' | 'right';
}

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** pixel in the sprite canvas corresponding to the TOP corner of the footprint diamond */
  ax: number;
  ay: number;
  /** optional anchor points, in sprite-canvas pixels */
  chimneys?: { x: number; y: number }[];
  door?: { x: number; y: number };
  /** point above the roof where status icons should float */
  top?: { x: number; y: number };
}

export type PropKind =
  | 'tree'
  | 'pine'
  | 'bush'
  | 'lamp'
  | 'bench'
  | 'fountain'
  | 'flowers'
  | 'sign_forsale'
  | 'sign_sold'
  | 'sign_foreclosed'
  | 'sign_forrent'
  | 'sign_hiring'
  | 'sign_sale'
  | 'sign_lot'
  | 'crane';

export type VehicleKind = 'car' | 'truck' | 'van' | 'armored' | 'mixer' | 'bus';

export type IconKind =
  | 'warning' // yellow "!" balloon (stress)
  | 'alarm' // red "!!" balloon (crisis, bank run)
  | 'money' // green "$" balloon (loan approved)
  | 'hammer' // construction
  | 'zzz' // closed/idle
  | 'up' // green up arrow
  | 'down' // red down arrow
  | 'house' // housing
  | 'person' // hiring / jobs
  | 'lock' // frozen / failed
  | 'decision' // a decision is waiting for the player (Genesis Mode)
  | 'plan'; // a proposed business: plans, no building yet
