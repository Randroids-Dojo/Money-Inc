// Procedural surface textures, evaluated per pixel in world units (see raster.ts).
// All patterns are periodic with (a divisor of) one tile so tiles join seamlessly.

import { type Col, P, mix, shade, rgb } from './color';
import { h01 } from './rng';

/** Integer ground-lattice coordinates of the pixel whose centre is at world (x, y). */
export function lattice(x: number, y: number): [number, number] {
  return [Math.round(2 * x - 0.5), Math.round(2 * y - 0.5)];
}

/**
 * Lawn grass: base green with tiny lit tufts (dark blade + light tip above it).
 * `shaggy` (0..1) adds dry, uneven patches for neglected lots.
 */
export function grass(x: number, y: number, seed: number, shaggy = 0): Col {
  const [U, V] = lattice(x, y);
  const h = h01(U, V, seed);
  const hb = h01(U + 2, V + 2, seed); // pixel directly below
  const tuft = 0.055 + shaggy * 0.1;
  if (shaggy > 0) {
    const patch = h01(U >> 3, V >> 3, seed + 11);
    if (h < tuft) return patch < 0.5 ? P.grassDry : P.grassDark;
    if (hb < tuft) return patch < 0.5 ? rgb(176, 178, 104) : P.grassLight;
    if (patch < shaggy * 0.45) return mix(P.grass, P.grassDry, 0.55);
    if (patch > 0.8) return shade(P.grass, 0.92);
    return P.grass;
  }
  if (h < tuft) return P.grassDark;
  if (hb < tuft) return P.grassLight;
  return P.grass;
}

/** Grass with a few flowers sprinkled in (parks, gardens). */
export function meadow(x: number, y: number, seed: number, density = 0.012): Col {
  const [U, V] = lattice(x, y);
  const h = h01(U, V, seed + 99);
  if (h < density) {
    const k = h01(U, V, seed + 5);
    return k < 0.33 ? rgb(250, 246, 236) : k < 0.66 ? rgb(248, 214, 76) : rgb(236, 120, 150);
  }
  return grass(x, y, seed);
}

export function dirt(x: number, y: number, seed: number): Col {
  const [U, V] = lattice(x, y);
  const h = h01(U, V, seed + 31);
  const ha = h01(U - 2, V - 2, seed + 31); // pixel above
  if (h < 0.035) return P.dirtLight;
  if (ha < 0.035) return P.dirtDark;
  const blot = h01(U >> 4, V >> 4, seed + 3);
  if (blot < 0.25) return shade(P.dirt, 0.94);
  if (h > 0.96) return shade(P.dirt, 0.9);
  return P.dirt;
}

export function sand(x: number, y: number, seed: number): Col {
  const [U, V] = lattice(x, y);
  const h = h01(U, V, seed + 17);
  if (h < 0.05) return P.sandDark;
  if (h > 0.965) return rgb(238, 222, 170);
  if (h > 0.955) return rgb(210, 150, 130); // shell fleck
  return P.sand;
}

/** Stone paving: square slabs (slab units) with grout lines and slight tint variation. */
export function paving(x: number, y: number, seed: number, base: Col = P.paving, slab = 8): Col {
  const gx = Math.floor(x);
  const gy = Math.floor(y);
  if (gx % slab === 0 || gy % slab === 0) return shade(base, 0.9);
  const s = h01(Math.floor(gx / slab), Math.floor(gy / slab), seed);
  return s < 0.25 ? shade(base, 0.965) : s > 0.82 ? shade(base, 1.035) : base;
}

export function asphalt(x: number, y: number, seed: number): Col {
  const [U, V] = lattice(x, y);
  const h = h01(U, V, seed + 71);
  if (h < 0.04) return P.asphaltDark;
  if (h > 0.972) return P.asphaltLight;
  return P.asphalt;
}

/** Plain concrete apron with faint expansion joints every `joint` units. */
export function concrete(x: number, y: number, seed: number, base: Col = P.concrete, joint = 16): Col {
  const gx = Math.floor(x);
  const gy = Math.floor(y);
  if (gx % joint === 0 || gy % joint === 0) return shade(base, 0.93);
  const [U, V] = lattice(x, y);
  const h = h01(U, V, seed + 13);
  if (h < 0.03) return shade(base, 0.92);
  if (h > 0.975) return shade(base, 1.05);
  return base;
}

/** Roof gravel / tar. */
export function gravel(x: number, y: number, seed: number, base: Col): Col {
  const [U, V] = lattice(x, y);
  const h = h01(U, V, seed + 41);
  if (h < 0.08) return shade(base, 0.9);
  if (h > 0.93) return shade(base, 1.07);
  return base;
}

/** Flat-roof membrane: gravel with faint seams every `seam` units along x. */
export function membrane(x: number, y: number, seed: number, base: Col, seam = 12): Col {
  if (Math.floor(x) % seam === 0) return shade(base, 0.92);
  if (Math.floor(y) % (seam * 2) === 0) return shade(base, 0.96);
  return gravel(x, y, seed, base);
}
