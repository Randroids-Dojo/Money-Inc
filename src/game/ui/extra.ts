// Windows opened from the HUD and hotkeys: statistics, news, help and the new-game screen.

import type { Scenario } from '../../sim/setup';
import type { UIContext } from './context';
import { openStatsWindow } from './statsWindow';
import { openNewsWindow } from './newsWindow';
import { openHelpWindow } from './helpWindow';
import { showIntro } from './introScreen';

export const extraUi = {
  stats: (ctx: UIContext): void => openStatsWindow(ctx),
  news: (ctx: UIContext): void => openNewsWindow(ctx),
  help: (ctx: UIContext): void => openHelpWindow(ctx),
  intro: (ctx: UIContext, onStart: (seed: number, scenario: Scenario) => void): void => showIntro(ctx, onStart),
};
