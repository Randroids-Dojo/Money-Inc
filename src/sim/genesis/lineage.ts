// Economic lineage (Genesis Mode): the causal and accounting relationships created by
// transactions — who lent to whom, which loan financed which business, who worked where,
// who bought which home with whose mortgage, which loans were sold or went bad, which bank
// took over which. Dollars are fungible and are never tracked individually; relationships are.
//
// Records outlive the entities they describe: a failed bank, a closed shop or a family that
// left town keeps its node, so its history can still be traced decades later.

export type LKind = 'bank' | 'firm' | 'household' | 'loan' | 'unit' | 'pool' | 'decision' | 'public';

export type EdgeKind =
  | 'lent' // bank -> loan
  | 'financed' // loan -> borrower (the new deposit)
  | 'secured' // loan -> unit it is secured on (mortgage)
  | 'paid' // borrower -> supplier / contractor paid with borrowed money
  | 'founded' // household -> firm
  | 'employed' // employer -> household
  | 'built' // builder -> unit or firm premises
  | 'bought' // buyer -> unit
  | 'home' // unit -> the household living there
  | 'seized' // bank -> unit taken in a foreclosure
  | 'packaged' // loan -> MBS pool
  | 'sold' // loan or pool -> the investor that bought it
  | 'acquired' // failed / merged bank -> the bank that took over its book
  | 'successor' // loan -> a later loan to the same borrower (restructuring, rescue credit)
  | 'decided'; // player decision -> entity it concerned

export interface LNode {
  key: string;
  kind: LKind;
  id: number;
  label: string;
  born: number;
  /** day the entity stopped existing (repaid, defaulted, closed, failed, left town) */
  end?: number;
  endNote?: string;
  /** lot on the map where it lives / lived (units: their lot; households: last home) */
  lot?: number;
  /** extra description: sector, loan purpose... */
  sub?: string;
}

export interface LEdge {
  id: number;
  kind: EdgeKind;
  from: string;
  to: string;
  day: number;
  end?: number;
  amount: number;
  label: string;
}

export interface TraceEntry {
  key: string;
  /** 0 = the root, 1 = direct relationship, 2+ = downstream (connected through others) */
  depth: number;
  parent: string | null;
  via: LEdge | null;
  /** true when the relationship points into the root (a lender, a founder) */
  upstream?: boolean;
}

/** Hop cost of following an edge: loans and pools are connectors, not destinations. */
function hop(e: LEdge, forward: boolean): number {
  if (forward) {
    if (e.kind === 'lent' || e.kind === 'packaged' || e.kind === 'successor') return 0;
    return 1;
  }
  // walking backwards into a loan (borrower -> loan) is free; out of it to its lender costs 1
  if (e.kind === 'financed' || e.kind === 'secured' || e.kind === 'packaged' || e.kind === 'successor') return 0;
  return 1;
}

export const nodeKey = (kind: LKind, id: number): string => `${kind}:${id}`;

export class Lineage {
  nodes = new Map<string, LNode>();
  edges: LEdge[] = [];
  private out = new Map<string, LEdge[]>();
  private inn = new Map<string, LEdge[]>();
  /** open edges by "kind|from|to" for quick updates (employment, homes, wages) */
  private open = new Map<string, LEdge>();
  private nextEdge = 1;

  node(kind: LKind, id: number, label: string, born: number, lot?: number, sub?: string): LNode {
    const key = nodeKey(kind, id);
    let n = this.nodes.get(key);
    if (!n) {
      n = { key, kind, id, label, born, lot, sub };
      this.nodes.set(key, n);
    } else {
      n.label = label;
      if (lot !== undefined && lot >= 0) n.lot = lot;
      if (sub) n.sub = sub;
    }
    return n;
  }

  get(key: string): LNode | undefined {
    return this.nodes.get(key);
  }

  end(key: string, day: number, note: string): void {
    const n = this.nodes.get(key);
    if (!n || n.end !== undefined) return;
    n.end = day;
    n.endNote = note;
  }

  edge(kind: EdgeKind, from: string, to: string, day: number, amount: number, label: string): LEdge {
    const e: LEdge = { id: this.nextEdge++, kind, from, to, day, amount, label };
    this.edges.push(e);
    let o = this.out.get(from);
    if (!o) this.out.set(from, (o = []));
    o.push(e);
    let i = this.inn.get(to);
    if (!i) this.inn.set(to, (i = []));
    i.push(e);
    return e;
  }

  /** An ongoing relationship (a job, a home, a line of spending): opened once, closed later. */
  openEdge(kind: EdgeKind, from: string, to: string, day: number, label: string, amount = 0): LEdge {
    const k = `${kind}|${from}|${to}`;
    const cur = this.open.get(k);
    if (cur) return cur;
    const e = this.edge(kind, from, to, day, amount, label);
    this.open.set(k, e);
    return e;
  }

  findOpen(kind: EdgeKind, from: string, to: string): LEdge | undefined {
    return this.open.get(`${kind}|${from}|${to}`);
  }

  closeEdge(kind: EdgeKind, from: string, to: string, day: number): void {
    const k = `${kind}|${from}|${to}`;
    const e = this.open.get(k);
    if (!e) return;
    e.end = day;
    this.open.delete(k);
  }

  /** Close every open edge of a kind that starts (or ends) at a node. */
  closeAll(kind: EdgeKind, key: string, day: number, side: 'from' | 'to'): void {
    const list = side === 'from' ? this.out.get(key) : this.inn.get(key);
    if (!list) return;
    for (const e of list) {
      if (e.kind !== kind || e.end !== undefined) continue;
      e.end = day;
      this.open.delete(`${e.kind}|${e.from}|${e.to}`);
    }
  }

  outOf(key: string): readonly LEdge[] {
    return this.out.get(key) ?? [];
  }

  into(key: string): readonly LEdge[] {
    return this.inn.get(key) ?? [];
  }

  /**
   * Everything connected to `root`: its direct relationships (both directions, depth 1) and
   * what followed downstream from them (forward only, up to `maxDepth`). Loans and pools are
   * connectors: a bank's loan to a shop makes the shop a direct relationship of the bank.
   * `until` limits the view to relationships formed by that day.
   */
  trace(root: string, maxDepth = 4, until = Infinity, limit = 4000): Map<string, TraceEntry> {
    const seen = new Map<string, TraceEntry>();
    if (!this.nodes.has(root)) return seen;
    seen.set(root, { key: root, depth: 0, parent: null, via: null });
    // 0-1 BFS with a deque (forward edges)
    const dq: string[] = [root];
    let head = 0;
    const push = (k: string, front: boolean) => {
      if (front) dq.splice(head, 0, k);
      else dq.push(k);
    };
    while (head < dq.length && seen.size < limit) {
      const k = dq[head++];
      const cur = seen.get(k)!;
      for (const e of this.outOf(k)) {
        if (e.day > until) continue;
        const c = hop(e, true);
        const d = cur.depth + c;
        if (d > maxDepth) continue;
        const prev = seen.get(e.to);
        if (prev && prev.depth < d) continue;
        if (prev && prev.depth === d) {
          // equally close: remember the earliest relationship (the first loan, not the latest)
          if (!prev.upstream && prev.via && e.day < prev.via.day) {
            prev.parent = k;
            prev.via = e;
          }
          continue;
        }
        seen.set(e.to, { key: e.to, depth: d, parent: k, via: e });
        push(e.to, c === 0);
      }
    }
    // upstream: who the root itself came from (its lenders, founders, previous owners) — depth 1
    const up = (k: string, depth: number) => {
      for (const e of this.into(k)) {
        if (e.day > until) continue;
        const c = hop(e, false);
        const d = depth + c;
        if (d > 1) continue;
        if (seen.has(e.from)) continue;
        seen.set(e.from, { key: e.from, depth: Math.max(1, d), parent: k, via: e, upstream: true });
        if (c === 0) up(e.from, d);
      }
    };
    up(root, 0);
    return seen;
  }

  /** Chain of edges from `root` to `target` inside a trace result (root first). */
  pathTo(trace: Map<string, TraceEntry>, target: string): TraceEntry[] {
    const out: TraceEntry[] = [];
    let k: string | null = target;
    let guard = 0;
    while (k && guard++ < 64) {
      const t = trace.get(k);
      if (!t) return [];
      out.push(t);
      k = t.parent;
    }
    return out.reverse();
  }

  /**
   * Shortest chain of relationships from `from` to `to` (forward only), e.g. how a house is
   * connected back to the bank that made the town's first loan. Empty when unconnected.
   */
  chain(from: string, to: string, maxDepth = 8): TraceEntry[] {
    if (from === to) return [];
    const t = this.trace(from, maxDepth, Infinity, 20000);
    const hit = t.get(to);
    if (!hit || hit.upstream) return [];
    return this.pathTo(t, to);
  }
}
