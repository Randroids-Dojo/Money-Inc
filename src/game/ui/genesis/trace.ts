// Trace mode (Genesis Mode). Pick anything — a bank, a business, a family, a home, a loan or one of
// your decisions — and the town dims around what it is connected to. Direct relationships (it lent
// to, it employs, it built...) are gold; what followed from those, one or more steps further on,
// is blue; where it came from is teal. Click a lit building to see the chain that connects it,
// click anything else to trace from there. Connections are relationships, not claims about cause.

import { badge, button, choice, h, note, openWindow, closeWindow, isOpen, section, spinner, getWindow } from '../../../ui';
import { fmtDate } from '../../../sim/format';
import { nodeKey, type LNode, type TraceEntry } from '../../../sim/genesis/lineage';
import type { Genesis } from '../../../sim/genesis/state';
import type { Selection } from '../../game';
import type { Speed } from '../../game';
import type { TraceEnd, TraceLine, TraceRole, TraceSpot, TraceView } from '../../../render/traceOverlay';
import type { UIContext } from '../context';

export interface TraceController {
  active(): boolean;
  /** Trace a lineage key ("bank:12", "firm:40", "decision:3"...). */
  open(key: string): void;
  /** Trace whatever this selection is (returns false if it has no history). */
  openSelection(sel: Selection): boolean;
  /** Trace an agent by id. */
  openAgent(id: number): void;
  exit(): void;
  /** A click on the map while tracing. Returns true when trace mode handled it. */
  onPick(sel: Selection): boolean;
  /** Rebuild after the town changed. */
  refresh(): void;
  toggle(): void;
}

const KIND_WORD: Record<LNode['kind'], string> = {
  bank: 'bank',
  firm: 'business',
  household: 'household',
  loan: 'loan',
  unit: 'home',
  pool: 'security',
  decision: 'your decision',
  public: 'institution',
};

function short(s: string, n = 24): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Lineage key for something the player clicked. */
export function keyForSelection(g: Genesis, sel: Selection): string | null {
  if (!sel) return null;
  const eco = g.eco;
  const has = (k: string) => (g.lineage.get(k) ? k : null);
  switch (sel.kind) {
    case 'bank':
      return has(nodeKey('bank', sel.id));
    case 'firm':
      return has(nodeKey('firm', sel.id));
    case 'household':
      return has(nodeKey('household', sel.id));
    case 'loan':
      return has(nodeKey('loan', sel.id));
    case 'project': {
      const p = eco.projects.get(sel.id);
      return p ? has(nodeKey('firm', p.clientId)) : null;
    }
    case 'lot': {
      const units = eco.lotUnits.get(sel.id) ?? [];
      for (const u of units) {
        const k = has(nodeKey('unit', u));
        if (k) return k;
      }
      for (const u of units) {
        const occ = eco.units[u]?.occupantId ?? -1;
        if (occ >= 0) {
          const k = has(nodeKey('household', occ));
          if (k) return k;
        }
      }
      return null;
    }
    case 'cityhall':
      return has(nodeKey('public', eco.treasury.id));
    case 'fund':
      return has(nodeKey('public', eco.fund.id));
    default:
      return null;
  }
}

/** Where a lineage node sits on the map. */
function endOf(g: Genesis, n: LNode): TraceEnd | null {
  const eco = g.eco;
  if (n.kind === 'loan' || n.kind === 'pool' || n.kind === 'decision') return null;
  if (n.kind === 'public') {
    if (n.id === eco.world.id) return { agent: n.id };
    const lot = eco.lotOf(n.id);
    if (lot >= 0) return { lot };
    if (n.id === eco.treasury.id) return { agent: n.id };
    return null;
  }
  if (n.kind === 'household') {
    const h0 = eco.household(n.id);
    if (h0 && !h0.departed) {
      const lot = eco.lotOf(h0.id);
      if (lot >= 0) return { lot };
    }
  }
  return n.lot !== undefined && n.lot >= 0 ? { lot: n.lot } : null;
}

/** One line of the "direct relationships" list, from the traced entity's point of view. */
function describe(g: Genesis, t: Map<string, TraceEntry>, e: TraceEntry): string {
  const n = g.lineage.get(e.key)!;
  const via = e.via;
  if (!via) return n.label;
  const parent = e.parent ? g.lineage.get(e.parent) : undefined;
  const up = !!e.upstream;
  switch (via.kind) {
    case 'financed':
      return up ? `borrowed: ${parent?.label ?? via.label}` : `${parent?.label ?? 'a loan'} → ${n.label}`;
    case 'lent':
      return up ? `${parent?.label ?? 'a loan'} from ${n.label}` : n.label;
    case 'employed':
      return up ? `works at ${n.label}` : `employs ${n.label}`;
    case 'founded':
      return up ? `founded by ${n.label}` : `founded ${n.label}`;
    case 'built':
      return up ? `built by ${n.label}` : `built ${n.label}`;
    case 'bought':
      return up ? `owned by ${n.label}` : `bought ${n.label}`;
    case 'home':
      return up ? `lives at ${n.label}` : `home of ${n.label}`;
    case 'secured':
      return up ? `borrowed against by ${n.label}` : `mortgage on ${n.label}`;
    case 'paid':
      return up ? `paid by ${n.label} with borrowed money` : `paid ${n.label} (${via.label.replace(/^paid for /, '')})`;
    case 'seized':
      return up ? `repossessed by ${n.label}` : `repossessed ${n.label}`;
    case 'packaged':
      return up ? `contains ${n.label}` : `packaged into ${n.label}`;
    case 'sold':
      return up ? `bought from ${n.label}` : `sold to ${n.label}`;
    case 'acquired':
      return up ? `took over ${n.label}` : `taken over by ${n.label}`;
    case 'successor':
      return up ? `follows ${n.label}` : `rescue credit: ${n.label}`;
    case 'decided':
      return up ? `your decision: ${n.label}` : `concerned ${n.label}`;
  }
  void t;
  return n.label;
}

export function createTrace(ctx: UIContext): TraceController {
  const game = ctx.game;
  let root: string | null = null;
  let focus: string | null = null;
  const stack: string[] = [];
  let downstream = true;
  let untilYear = 0; // 0 = now
  let resume: Speed = 0;
  let result: Map<string, TraceEntry> = new Map();

  const g = () => game.eco.genesis;

  function build(): void {
    const gg = g();
    if (!gg || !root) {
      ctx.renderer.traceView = null;
      return;
    }
    const until = untilYear > 0 ? untilYear * 360 - 1 : Infinity;
    result = gg.lineage.trace(root, downstream ? 4 : 1, until, 3000);
    const spots = new Map<number, TraceSpot>();
    const rank: Record<TraceRole, number> = { root: 0, direct: 1, upstream: 2, downstream: 3 };
    const lines: TraceLine[] = [];
    for (const e of result.values()) {
      const n = gg.lineage.get(e.key);
      if (!n) continue;
      const role: TraceRole = e.key === root ? 'root' : e.upstream ? 'upstream' : e.depth <= 1 ? 'direct' : 'downstream';
      const end = endOf(gg, n);
      const ended = (n.end !== undefined && n.end <= until) || (e.via?.end !== undefined && e.via.end <= until);
      if (end && 'lot' in end) {
        const cur = spots.get(end.lot);
        const label = role === 'root' || role === 'direct' || role === 'upstream' ? short(n.label) : undefined;
        if (!cur || rank[role] < rank[cur.role]) spots.set(end.lot, { lotId: end.lot, role, depth: e.depth, ended: ended && role !== 'root', label: label ?? cur?.label });
      }
      if (e.key === root || !end) continue;
      // join it to the nearest thing above it that has a place on the map
      let p = e.parent;
      let a: TraceEnd | null = null;
      for (let guard = 0; p && guard < 12; guard++) {
        const pn = gg.lineage.get(p);
        a = pn ? endOf(gg, pn) : null;
        if (a) break;
        p = result.get(p)?.parent ?? null;
      }
      if (!a) continue;
      lines.push(e.upstream ? { a: end, b: a, role: 'upstream', depth: e.depth, ended } : { a, b: end, role, depth: e.depth, ended });
    }
    // the chain to the building the player is looking at
    if (focus && result.has(focus)) {
      const path = gg.lineage.pathTo(result, focus);
      let prev: TraceEnd | null = null;
      for (const step of path) {
        const n = gg.lineage.get(step.key);
        const end = n ? endOf(gg, n) : null;
        if (!end) continue;
        if (prev) lines.push({ a: prev, b: end, role: 'chain', depth: 0 });
        prev = end;
      }
    }
    // keep the picture readable in a big town
    const keep = lines.filter((l) => l.role !== 'downstream');
    const down = lines.filter((l) => l.role === 'downstream').sort((a, b) => a.depth - b.depth).slice(0, 260);
    const focusEnd = focus ? gg.lineage.get(focus) : undefined;
    const fe = focusEnd ? endOf(gg, focusEnd) : null;
    const view: TraceView = { spots: [...spots.values()], lines: [...keep, ...down], focusLot: fe && 'lot' in fe ? fe.lot : undefined };
    ctx.renderer.traceView = view;
  }

  function panel(): void {
    openWindow({
      id: 'gtrace',
      title: 'Trace',
      icon: '🔍',
      width: 380,
      x: 8,
      y: 52,
      className: 'gn-trace-win',
      onClose: () => {
        if (root) exit();
      },
      render: (body) => {
        const gg = g();
        if (!gg || !root) return;
        const n = gg.lineage.get(root);
        if (!n) return;
        const win = getWindow('gtrace');
        win?.setTitle(`Tracing ${short(n.label, 30)}`);
        const eco = gg.eco;
        const yearNow = Math.floor(eco.day / 360) + 1;
        body.append(
          h(
            'div',
            { class: 'mi-row gm-badges' },
            stack.length ? button('Back', () => back(), { small: true, icon: '◀' }) : null,
            badge(KIND_WORD[n.kind].toUpperCase(), 'accent'),
            badge(n.born > 0 ? `SINCE ${fmtDate(n.born, false).toUpperCase()}` : 'FROM THE START', 'muted'),
            n.end !== undefined ? badge(`${n.endNote ?? 'ended'} (${fmtDate(n.end, false)})`.toUpperCase(), 'warn') : null,
          ),
          h(
            'div',
            { class: 'gn-trace-ctl' },
            choice({
              options: [
                { id: 'direct', label: 'Direct only', title: 'Only what it did itself: lent to, employed, built, bought...' },
                { id: 'all', label: '+ downstream', title: 'Also what followed from those, a few steps on (connected, not caused).' },
              ],
              value: downstream ? 'all' : 'direct',
              onChange: (v) => {
                downstream = v === 'all';
                build();
                rerender();
              },
              small: true,
            }),
            yearNow > 1
              ? spinner({
                  value: untilYear || yearNow,
                  min: 1,
                  max: yearNow,
                  step: 1,
                  format: (v) => (v >= yearNow ? 'Now' : `Up to Y${v}`),
                  onChange: (v) => {
                    untilYear = v >= yearNow ? 0 : v;
                    build();
                    rerender();
                  },
                  tip: 'See the connections as they stood at the end of an earlier year.',
                })
              : null,
          ),
        );
        const entries = [...result.values()];
        const direct = entries.filter((e) => e.key !== root && !e.upstream && e.depth === 1);
        const decided = entries.filter((e) => e.upstream && e.via?.kind === 'decided');
        const from = entries.filter((e) => e.upstream && e.via?.kind !== 'decided');
        const deeper = entries.filter((e) => !e.upstream && e.depth >= 2);
        // every relationship the root (or one of its loans) has with each direct entity
        const sources = [root!, ...entries.filter((e) => e.depth === 0 && e.key !== root).map((e) => e.key)];
        const rels = new Map<string, string[]>();
        for (const src of sources) {
          const srcNode = gg.lineage.get(src);
          for (const ed of gg.lineage.outOf(src)) {
            const t = result.get(ed.to);
            if (!t || t.upstream || t.depth !== 1) continue;
            let arr = rels.get(ed.to);
            if (!arr) rels.set(ed.to, (arr = []));
            const what =
              ed.kind === 'financed' ? srcNode?.label ?? 'a loan' : ed.kind === 'secured' ? `security for the ${srcNode?.label ?? 'loan'}` : ed.kind === 'employed' ? 'employs them' : ed.kind === 'paid' ? ed.label : ed.kind === 'decided' ? 'concerned' : ed.label;
            if (!arr.includes(what)) arr.push(what);
          }
        }
        const nameLink = (e: TraceEntry, text: string) =>
          h(
            'a',
            {
              class: 'gm-link',
              href: '#',
              onclick: (ev: MouseEvent) => {
                ev.preventDefault();
                setFocus(e.key);
              },
              tip: 'Show it on the map and how it connects',
            },
            text,
          );
        const row = (e: TraceEntry, text: HTMLElement | string, sub?: string) => {
          const node = gg.lineage.get(e.key)!;
          const day = e.via?.day ?? node.born;
          return h(
            'li',
            { class: ['gn-trace-item', (node.end !== undefined || e.via?.end !== undefined) && 'is-ended', e.key === focus && 'is-focus'] },
            h('span', { class: 'gn-trace-date' }, fmtDate(day, false)),
            h('div', { class: 'gn-trace-what' }, text, sub ? h('div', { class: 'gn-trace-sub' }, sub) : null),
            button('', () => open(e.key), { small: true, icon: '🔍', title: 'Trace from here' }),
          );
        };
        const cap = 60;
        const directList = direct
          .filter((e) => {
            const k = gg.lineage.get(e.key)?.kind;
            return k !== 'loan' && k !== 'pool';
          })
          .sort((a, b) => (a.via?.day ?? 0) - (b.via?.day ?? 0));
        body.append(
          section(
            { title: 'Direct relationships', aside: String(directList.length) },
            directList.length
              ? h(
                  'ul',
                  { class: 'gn-trace-list mi-scroll', dataset: { scrollKey: 'direct' } },
                  directList.slice(0, cap).map((e) => {
                    const node = gg.lineage.get(e.key)!;
                    const r = rels.get(e.key) ?? [describe(gg, result, e)];
                    const ended = node.end !== undefined ? ` · ${node.endNote ?? 'ended'}` : '';
                    return row(e, nameLink(e, node.label), `${r.join(' · ')}${ended}`);
                  }),
                )
              : note('None yet.'),
            directList.length > cap ? note(`…and ${directList.length - cap} more.`, 'muted') : null,
          ),
        );
        if (from.length) body.append(section({ title: 'Where it came from', aside: String(from.length) }, h('ul', { class: 'gn-trace-list' }, from.slice(0, 12).map((e) => row(e, nameLink(e, describe(gg, result, e)))))));
        if (decided.length)
          body.append(
            section(
              { title: 'Your decisions about it', aside: String(decided.length) },
              h('ul', { class: 'gn-trace-list' }, decided.slice(-12).map((e) => row(e, gg.lineage.get(e.key)!.label))),
            ),
          );
        if (downstream) {
          const count = (k: LNode['kind']) => deeper.filter((e) => gg.lineage.get(e.key)?.kind === k).length;
          const parts = [
            [count('firm'), 'business', 'businesses'],
            [count('household'), 'household', 'households'],
            [count('unit'), 'home', 'homes'],
            [count('bank'), 'bank', 'banks'],
          ].filter(([n0]) => (n0 as number) > 0);
          body.append(
            section(
              { title: 'Downstream', aside: String(deeper.filter((e) => endOf(gg, gg.lineage.get(e.key)!)).length) },
              parts.length ? h('p', { class: 'gm-para' }, 'Connected through others: ', parts.map(([n0, one, many]) => `${n0} ${n0 === 1 ? one : many}`).join(' · '), '. Click a blue building to see the chain.') : note('Nothing further along yet.'),
              note('Downstream means connected through a chain of relationships — lent to, employed by, bought from — not caused by.', 'muted'),
            ),
          );
        }
        if (focus && result.has(focus)) {
          const path = gg.lineage.pathTo(result, focus);
          const steps: HTMLElement[] = [];
          path.forEach((st, i) => {
            const node = gg.lineage.get(st.key);
            if (!node) return;
            if (i > 0 && st.via) steps.push(h('div', { class: 'gn-chain-edge' }, `↓ ${st.upstream ? '(from) ' : ''}${st.via.label}`));
            steps.push(h('div', { class: ['gn-chain-node', `is-${node.kind}`] }, node.label));
          });
          body.append(section('How it connects', h('div', { class: 'gn-chain' }, steps), button('Trace from here', () => open(focus!), { small: true, primary: true })));
        }
        body.append(h('div', { class: 'mi-actions' }, button('Leave trace mode', () => exit(), { small: true, title: 'T' })));
      },
      update: () => {},
    });
  }

  function rerender(): void {
    getWindow('gtrace')?.rerender();
  }

  function setFocus(key: string): void {
    focus = key;
    build();
    rerender();
    const gg = g();
    const n = gg?.lineage.get(key);
    const end = gg && n ? endOf(gg, n) : null;
    if (end && 'lot' in end) ctx.renderer.focusLot(end.lot);
  }

  function open(key: string): void {
    const gg = g();
    if (!gg || !gg.lineage.get(key)) return;
    if (!root) {
      resume = game.speed;
      game.setSpeed(0);
    } else if (root !== key) stack.push(root);
    root = key;
    focus = null;
    build();
    if (!isOpen('gtrace')) panel();
    else rerender();
    const n = gg.lineage.get(key)!;
    const end = endOf(gg, n);
    if (end && 'lot' in end) ctx.renderer.focusLot(end.lot);
    game.select(null);
  }

  function back(): void {
    const k = stack.pop();
    if (!k) return;
    root = k;
    focus = null;
    build();
    rerender();
  }

  function exit(): void {
    root = null;
    focus = null;
    stack.length = 0;
    untilYear = 0;
    ctx.renderer.traceView = null;
    if (isOpen('gtrace')) closeWindow('gtrace');
    if (resume) game.setSpeed(resume);
    resume = 0;
  }

  function openSelection(sel: Selection): boolean {
    const gg = g();
    if (!gg) return false;
    const k = keyForSelection(gg, sel);
    if (!k) return false;
    open(k);
    return true;
  }

  game.on.newGame.push(() => exit());

  return {
    active: () => root !== null,
    open,
    openSelection,
    openAgent(id: number) {
      const gg = g();
      if (!gg) return;
      const a = gg.eco.agents.get(id);
      if (!a) return;
      const kind = a.kind === 'bank' ? 'bank' : a.kind === 'firm' ? 'firm' : a.kind === 'household' ? 'household' : 'public';
      open(nodeKey(kind, id));
    },
    exit,
    onPick(sel: Selection): boolean {
      if (!root) return false;
      const gg = g();
      if (!gg) return false;
      const k = keyForSelection(gg, sel);
      if (!k) return true; // nothing traceable there: stay in trace mode
      if (result.has(k) && k !== root) setFocus(k);
      else if (k !== root) open(k);
      return true;
    },
    refresh() {
      if (root) build();
    },
    toggle() {
      if (root) {
        exit();
        return;
      }
      const gg = g();
      if (!gg) return;
      if (!openSelection(game.selection)) open(nodeKey('bank', gg.genesisBankId));
    },
  };
}
