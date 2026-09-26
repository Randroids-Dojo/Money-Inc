// Late-bound windows (statistics, news, help, intro) so the core UI does not depend on them.

import type { Scenario } from '../../sim/setup';
import type { UIContext } from './context';

export const extraUi = {
  stats: (_ctx: UIContext): void => {},
  news: (_ctx: UIContext): void => {},
  help: (_ctx: UIContext): void => {},
  intro: (_ctx: UIContext, onStart: (seed: number, scenario: Scenario) => void): void => {
    onStart(Math.floor(1 + Math.random() * 9999), 'classic');
  },
};
