// Money Inc. procedural pixel-art sprite library (public API).
//
// Everything is drawn in code at native resolution with a small software rasteriser
// (see raster.ts): crisp 2:1 isometric staircases, no anti-aliasing, deterministic
// output for identical inputs, and every generator is memoised.
//
// Anchor conventions (all in sprite-canvas pixels; draw at screenPoint - (ax, ay)):
//   buildings / ground / roads : (ax, ay) = top corner of the footprint diamond,
//                                i.e. draw at tileToScreen(lot.x, lot.y) - (ax, ay)
//   props                      : ground contact point (trunk base, post base, crane base)
//   vehicles                   : ground point under the vehicle centre
//   people                     : between the feet (ground point)
//   icons                      : bottom tip of the balloon tail
//   coin                       : centre of the coin

export * from './types';
export { buildingSprite } from './buildings';
export { groundTile, shoreTile, roadTile, type GroundKind } from './ground';
export { propSprite } from './props';
export { vehicleSprite } from './vehicles';
export { personSprite, iconSprite, coinSprite } from './people';
export { drawPixelText, measurePixelText } from './font';
