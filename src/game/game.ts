// The game shell: owns the economy, runs the simulation clock at the chosen speed and keeps
// the player's view state (selection, overlays, lens). Renderer and UI both read from here.

import { createEconomy, type Scenario } from '../sim/setup';
import type { Economy } from '../sim/economy';
import type { FlowEvent, SimEvent } from '../sim/types';

export type Speed = 0 | 1 | 2 | 5 | 10;

/** What the player has clicked on. */
export type Selection =
  | { kind: 'firm'; id: number }
  | { kind: 'bank'; id: number }
  | { kind: 'household'; id: number }
  | { kind: 'lot'; id: number } // residential building, empty lot, park
  | { kind: 'project'; id: number }
  | { kind: 'cb' }
  | { kind: 'fund' }
  | { kind: 'cityhall' }
  | { kind: 'loan'; id: number }
  | null;

export type Lens = 'none' | 'banks' | 'debt' | 'origin' | 'value' | 'jobs';

/** Simulated days per real second at 1x. */
export const DAYS_PER_SECOND = 1;

export interface GameListeners {
  day: (() => void)[];
  month: (() => void)[];
  select: (() => void)[];
  newGame: (() => void)[];
}

export class Game {
  eco: Economy;
  speed: Speed = 1;
  /** speed to restore when un-pausing */
  lastSpeed: Speed = 1;
  seed: number;
  scenario: Scenario;
  selection: Selection = null;
  lens: Lens = 'none';
  showFlows = true;
  showLinks = true;
  /** fraction of the current day elapsed (for smooth animation) */
  dayFrac = 0;
  private acc = 0;
  /** flows and events produced since the renderer last drained them */
  flows: FlowEvent[] = [];
  events: SimEvent[] = [];
  readonly on: GameListeners = { day: [], month: [], select: [], newGame: [] };

  constructor(seed: number, scenario: Scenario) {
    this.seed = seed;
    this.scenario = scenario;
    this.eco = this.build();
  }

  private build(): Economy {
    const eco = createEconomy({ seed: this.seed, banks: 4, scenario: this.scenario });
    eco.recordVisuals = true;
    eco.flowBuffer.length = 0;
    eco.eventBuffer.length = 0;
    return eco;
  }

  newGame(seed: number, scenario: Scenario): void {
    this.seed = seed;
    this.scenario = scenario;
    this.eco = this.build();
    this.selection = null;
    this.flows = [];
    this.events = [];
    this.acc = 0;
    this.dayFrac = 0;
    for (const f of this.on.newGame) f();
  }

  setSpeed(s: Speed): void {
    if (s !== 0) this.lastSpeed = s;
    this.speed = s;
  }

  togglePause(): void {
    this.setSpeed(this.speed === 0 ? this.lastSpeed || 1 : 0);
  }

  select(sel: Selection): void {
    this.selection = sel;
    for (const f of this.on.select) f();
  }

  /** Advance the clock by `dt` real seconds. Returns the number of days simulated. */
  tick(dt: number): number {
    if (this.speed === 0) return 0;
    this.acc += Math.min(0.25, dt) * this.speed * DAYS_PER_SECOND;
    let steps = 0;
    // never let a slow frame snowball into a long catch-up
    const maxSteps = Math.max(2, this.speed);
    while (this.acc >= 1 && steps < maxSteps) {
      this.acc -= 1;
      this.stepDay();
      steps++;
    }
    if (steps >= maxSteps) this.acc = Math.min(this.acc, 1);
    this.dayFrac = this.acc;
    return steps;
  }

  stepDay(): void {
    const eco = this.eco;
    const month = eco.month;
    eco.step();
    // hand the visual buffers to the renderer
    if (eco.flowBuffer.length) {
      for (const f of eco.flowBuffer) this.flows.push(f);
      eco.flowBuffer.length = 0;
    }
    if (eco.eventBuffer.length) {
      for (const e of eco.eventBuffer) this.events.push(e);
      eco.eventBuffer.length = 0;
    }
    if (this.flows.length > 30000) this.flows.splice(0, this.flows.length - 30000);
    if (this.events.length > 3000) this.events.splice(0, this.events.length - 3000);
    for (const f of this.on.day) f();
    if (eco.month !== month) for (const f of this.on.month) f();
  }
}
