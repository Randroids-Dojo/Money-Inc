// Drawer registry (kept separate so construction sites can draw their target
// building without an import cycle).

import type { BuildingKind } from '../types';
import type { Ctx } from './common';

export type Drawer = (c: Ctx) => void;

const DRAWERS: Partial<Record<BuildingKind, Drawer>> = {};

export function registerDrawer(kind: BuildingKind, fn: Drawer): void {
  DRAWERS[kind] = fn;
}

export function getDrawer(kind: BuildingKind): Drawer | undefined {
  return DRAWERS[kind];
}
