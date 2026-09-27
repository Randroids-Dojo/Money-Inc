// Headlines generated from simulation events — the game's message ticker.

import type { Economy } from './economy';
import type { NewsItem, NewsTone } from './types';
import { growth } from './banking';
import { fmtMoney, pct } from './format';

type Level = -2 | -1 | 0 | 1 | 2;

export class News {
  items: NewsItem[] = [];
  private nextId = 1;
  private cooldown = new Map<string, number>();
  private state = new Map<string, Level>();

  add(day: number, text: string, tone: NewsTone, agent?: number, lot?: number, key?: string, cooldownDays = 0): NewsItem | null {
    if (key) {
      const until = this.cooldown.get(key);
      if (until !== undefined && until > day) return null;
      this.cooldown.set(key, day + cooldownDays);
    }
    const item: NewsItem = { id: this.nextId++, day, text, tone, agent, lot };
    this.items.push(item);
    if (this.items.length > 400) this.items.shift();
    return item;
  }

  /** Report macro turning points with hysteresis so the ticker is not spammy. */
  macro(eco: Economy): void {
    // Genesis Mode: a handful of households make for silly statistics; wait until it is a town
    if (eco.genesis && !eco.genesis.macroNews) return;
    const st = eco.stats;
    if (st.length) this.yearReview(eco);
    if (st.length < 13) return;
    const day = eco.day;
    const infl = st.last('inflation');
    const u = st.last('unemployment');
    const hpg = st.last('hpiGrowth');
    const cg = st.last('creditGrowth');
    const mg = st.last('moneyGrowth');
    const cb = eco.cb.id;

    this.band('infl', infl, [-0.005, 0.045, 0.08], [0.005, 0.035, 0.065], (lvl, prev) => {
      if (lvl === -1) return [`Deflation: consumer prices are ${pct(infl)} lower than a year ago`, 'bad'];
      if (lvl === 1 && prev < 1) return [`Inflation climbs to ${pct(infl)} as spending outruns capacity`, 'bad'];
      if (lvl === 2) return [`Inflation surges to ${pct(infl)}!`, 'alert'];
      if (lvl === 0 && prev > 0) return [`Inflation cools to ${pct(infl)}`, 'good'];
      if (lvl === 0 && prev < 0) return [`Prices stop falling (${pct(infl)} a year)`, 'good'];
      return null;
    }, day, cb);

    this.band('unemp', u, [0.035, 0.08, 0.13], [0.045, 0.07, 0.11], (lvl, prev) => {
      if (lvl === -1) return [`Labour shortage: unemployment at just ${pct(u)}`, 'neutral'];
      if (lvl === 1 && prev < 1) return [`Unemployment rises to ${pct(u)}`, 'bad'];
      if (lvl === 2) return [`Recession: ${pct(u)} of workers are jobless`, 'alert'];
      if (lvl === 0 && prev > 0) return [`Jobs recover: unemployment down to ${pct(u)}`, 'good'];
      return null;
    }, day, eco.treasury.id);

    this.band('hpi', hpg, [-0.06, 0.1, 0.2], [-0.02, 0.07, 0.15], (lvl, prev) => {
      if (lvl === -1) return [`Housing slump: home prices down ${pct(-hpg)} in a year`, 'bad'];
      if (lvl === 1 && prev < 1) return [`Housing boom: prices up ${pct(hpg)} in a year`, 'neutral'];
      if (lvl === 2) return [`Property frenzy! Home prices up ${pct(hpg)} in twelve months`, 'alert'];
      if (lvl === 0 && prev > 0) return [`The housing market cools`, 'neutral'];
      if (lvl === 0 && prev < 0) return [`Home prices stabilise`, 'good'];
      return null;
    }, day);

    this.band('credit', cg, [-0.02, 0.12, 0.22], [0.01, 0.09, 0.18], (lvl, prev) => {
      if (lvl === -1) return [`Credit crunch: bank lending has shrunk ${pct(-cg)} in a year`, 'bad'];
      if (lvl === 1 && prev < 1) return [`Credit boom: loans outstanding up ${pct(cg)} in a year`, 'neutral'];
      if (lvl === 2) return [`Lending frenzy: credit up ${pct(cg)} in a year`, 'alert'];
      if (lvl === 0 && prev < 0) return [`Bank lending is growing again`, 'good'];
      return null;
    }, day);

    this.band('money', mg, [-0.02, 0.15, 0.3], [0.005, 0.11, 0.25], (lvl) => {
      if (lvl === -1) return [`The money supply is shrinking (${pct(mg)} a year): repayments exceed new lending`, 'bad'];
      if (lvl === 1) return [`Money supply growing fast: deposits up ${pct(mg)} in a year`, 'neutral'];
      return null;
    }, day);

    const fails = st.last('bankFailures');
    if (fails > 0 && eco.aliveBanks().length <= 1) this.add(day, `Only one bank is left standing in ${eco.city.name}`, 'alert');

    void growth;
    void fmtMoney;
  }

  /** "Year N in review" headline every December. */
  private yearReview(eco: Economy): void {
    const st = eco.stats;
    const day = eco.day;
    const cb = eco.cb.id;
    const infl = st.last('inflation');
    const cg = st.last('creditGrowth');
    if (eco.month % 12 === 11) {
      const y = Math.floor(eco.month / 12) + 1;
      const sum = (k: Parameters<typeof st.last>[0]) => {
        let s = 0;
        for (let i = 0; i < 12; i++) s += st.last(k, i) || 0;
        return s;
      };
      const gdpNow = sum('realGdp');
      let gdpPrev = 0;
      for (let i = 12; i < 24; i++) gdpPrev += st.last('realGdp', i) || 0;
      const g = gdpPrev > 0 && st.length >= 24 ? gdpNow / gdpPrev - 1 : NaN;
      const opened = sum('openings');
      const closed = sum('closures');
      const failed = sum('bankFailures');
      const parts = [
        Number.isFinite(g) ? `the economy ${g >= 0 ? 'grew' : 'shrank'} ${pct(Math.abs(g))}` : null,
        Number.isFinite(infl) ? `prices ${infl >= 0 ? 'rose' : 'fell'} ${pct(Math.abs(infl))}` : null,
        Number.isFinite(cg) && st.length >= 13 ? `credit ${cg >= 0 ? 'grew' : 'shrank'} ${pct(Math.abs(cg))}` : null,
        `${opened} business${opened === 1 ? '' : 'es'} opened and ${closed} closed`,
        failed > 0 ? `${failed} bank${failed > 1 ? 's' : ''} failed` : null,
      ].filter(Boolean);
      this.add(day, `Year ${y} in review: ${parts.join(', ')}.`, 'policy', cb);
    }
  }

  private band(
    key: string,
    v: number,
    up: [number, number, number],
    down: [number, number, number],
    msg: (lvl: Level, prev: Level) => [string, NewsTone] | null,
    day: number,
    agent?: number,
  ): void {
    const prev = this.state.get(key) ?? 0;
    // up: [lowEnter, highEnter, veryHighEnter]; down: [lowExit, highExit, veryHighExit]
    let lvl: Level = prev;
    if (v < up[0]) lvl = -1;
    else if (prev === -1 && v > down[0]) lvl = 0;
    if (v > up[2]) lvl = 2;
    else if (v > up[1] && prev < 1) lvl = 1;
    else if (prev === 2 && v < down[2]) lvl = 1;
    if (prev >= 1 && v < down[1]) lvl = v < up[0] ? -1 : 0;
    if (lvl === prev) return;
    this.state.set(key, lvl);
    const m = msg(lvl, prev);
    if (m) this.add(day, m[0], m[1], agent);
  }
}
