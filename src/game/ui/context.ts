// Shared handle the game windows use to reach the simulation, the map and each other.

import type { Game, Selection } from '../game';
import type { Renderer } from '../../render/renderer';

export interface UIContext {
  game: Game;
  renderer: Renderer;
  /** Open the window for an entity (bank, firm, household, loan, construction site, ...). */
  open(sel: Selection, anchor?: { x: number; y: number }): void;
  /** Select an entity and pan the camera to it (without opening a window). */
  showOnMap(sel: Selection): void;
  /** Pan to an agent (household, firm, bank, fund, ...) by id and select it. */
  showAgent(agentId: number): void;
}
