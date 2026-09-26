// Small deterministic hashing / PRNG helpers (never Math.random: sprites must be
// pixel-identical for identical specs).

/** Mix any number of integers into a 32-bit hash. */
export function hash(...vals: number[]): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < vals.length; i++) {
    h = Math.imul(h ^ (vals[i] | 0), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  h = Math.imul(h ^ (h >>> 16), 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

export function hashStr(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return hash(h);
}

/** Hash to [0, 1). */
export function h01(...vals: number[]): number {
  return hash(...vals) / 4294967296;
}

/** Mulberry32 PRNG. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  range(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}
