// UI toolkit demo (ui-demo.html): a fake pixel city standing in for the game world, a HUD strip and
// a few game windows fed with made-up data that drifts 4x a second.

import {
  actions,
  badge,
  balanceSheet,
  barChart,
  button,
  choice,
  closeAllWindows,
  closeTopWindow,
  field,
  gauge,
  glyph,
  h,
  iconButton,
  kv,
  lcd,
  lineChart,
  note,
  openWindow,
  section,
  setUiInsets,
  sparkline,
  spinner,
  stat,
  strip,
  stripGroup,
  table,
  ticker,
  updateWindows,
  type Tone,
} from './ui';

// ---------------------------------------------------------------------------------------------
// Helpers & made-up data

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(1999);
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];

function money(x: number): string {
  const s = x < 0 ? '-' : '';
  const a = Math.abs(x);
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(0)}K`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${a.toFixed(0)}`;
}
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateOf = (day: number) => {
  const y = Math.floor(day / 360) + 1;
  const m = Math.floor((day % 360) / 30);
  return { y, m, d: Math.floor(day % 30) + 1 };
};
const monthLabel = (k: number) => `${MONTHS[k % 12]} Y${Math.floor(k / 12) + 1}`;
const drift = (v: number, vol: number) => v * (1 + (rand() - 0.5) * vol);

const sim = {
  day: 2 * 360 + 2 * 30 + 13,
  speed: 1,
  paused: false,
  policyRate: 0.0425,
  reserveReq: 0.1,
  capitalReq: 0.08,
  lcrReq: 1.0,
  insurance: '100k',
  lolr: 'penalty',
  qe: 'off',
  inflation: 0.031,
  unemployment: 0.054,
  gdp: 0.021,
  mood: 0.72,
  cash: 1.24e9,
};

const bank = {
  reserves: 11.8e6,
  business: 38.2e6,
  mortgage: 44.8e6,
  consumer: 9.6e6,
  bonds: 16.3e6,
  mbs: 6.1e6,
  deposits: 101.4e6,
  wholesale: 13.2e6,
  cbLoans: 2.0e6,
  shareCapital: 8.0e6,
  npl: 0.036,
  netIncome: 0.41e6,
  hist: { capital: [] as number[], liquidity: [] as number[], npl: [] as number[], profit: [] as number[], month0: 0 },
};
const assetsOf = () => bank.reserves + bank.business + bank.mortgage + bank.consumer + bank.bonds + bank.mbs;
const liabOf = () => bank.deposits + bank.wholesale + bank.cbLoans;
const equityOf = () => assetsOf() - liabOf();
const rwa = () => bank.business * 1 + bank.mortgage * 0.5 + bank.consumer * 1 + bank.mbs * 0.5;
const capitalRatio = () => equityOf() / rwa();
const lcr = () => (bank.reserves + bank.bonds * 0.9) / (bank.deposits * 0.1 + bank.wholesale * 0.4);
const ltd = () => (bank.business + bank.mortgage + bank.consumer) / bank.deposits;

{
  // 24 months of history ending last month.
  let c = 0.138;
  let l = 1.52;
  let n = 0.021;
  for (let i = 0; i < 24; i++) {
    c += (rand() - 0.55) * 0.006 - (i > 16 ? 0.002 : 0);
    l += (rand() - 0.5) * 0.08 - (i > 17 ? 0.05 : 0);
    n += (rand() - 0.4) * 0.002;
    bank.hist.capital.push(c);
    bank.hist.liquidity.push(l / 10);
    bank.hist.npl.push(n);
    bank.hist.profit.push((rand() - 0.25) * 0.9e6 - (i === 18 || i === 19 ? 1.4e6 : 0));
  }
  bank.hist.month0 = Math.floor(sim.day / 30) - 24;
}

interface Loan {
  id: number;
  borrower: string;
  kind: 'Business' | 'Mortgage' | 'Consumer';
  amount: number;
  rate: number;
  years: number;
  status: 'Current' | 'Late' | 'Default' | 'Restructured';
}
const BORROWERS = [
  "Joe's Diner",
  'Acme Hardware',
  'Sunrise Bakery',
  'Harbor Freight Co.',
  'The Martins',
  'Pixel Cinema',
  'Okafor Dental',
  'Green Leaf Grocers',
  'The Novaks',
  'Bolt Electronics',
  'Riverside Gym',
  'The Chens',
  'Blue Door Books',
  'Kowalski Law',
  'Maple Furniture',
  'The Garcias',
  'Stack & Sons Builders',
  'Lucky Laundromat',
  'The Abebes',
  'Copper Kettle Cafe',
];
const loans: Loan[] = Array.from({ length: 38 }, (_, i) => {
  const kind = pick(['Business', 'Business', 'Mortgage', 'Mortgage', 'Consumer'] as const);
  const r = rand();
  return {
    id: 1001 + i,
    borrower: kind === 'Mortgage' ? `${pick(BORROWERS.filter((b) => b.startsWith('The')))} #${(i % 9) + 1}` : pick(BORROWERS.filter((b) => !b.startsWith('The'))),
    kind,
    amount: kind === 'Mortgage' ? 180e3 + rand() * 420e3 : kind === 'Business' ? 40e3 + rand() * 900e3 : 2e3 + rand() * 30e3,
    rate: (kind === 'Consumer' ? 0.11 : kind === 'Mortgage' ? 0.052 : 0.068) + rand() * 0.02,
    years: kind === 'Mortgage' ? 25 : kind === 'Business' ? pick([3, 5, 7, 10]) : pick([1, 2, 3]),
    status: r < 0.72 ? 'Current' : r < 0.86 ? 'Late' : r < 0.93 ? 'Restructured' : 'Default',
  };
});
const STATUS_TONE: Record<Loan['status'], Tone> = { Current: 'good', Late: 'warn', Default: 'bad', Restructured: 'info' };

const biz = {
  name: "Joe's Diner",
  icon: '🍔',
  accent: '#d9822b',
  kind: 'Restaurant',
  street: '14 Harbor St.',
  revenue: Array.from({ length: 48 }, (_, i) => 2100 + Math.sin(i / 4) * 260 + i * 9 + rand() * 180),
  staff: 7,
  lender: 'First Mercantile',
};

// ---------------------------------------------------------------------------------------------
// Fake pixel city (stand-in for the renderer)

const world = document.getElementById('world') as HTMLCanvasElement;
const wctx = world.getContext('2d')!;
let zoom = 2;
let camX = 0;
let camY = 0;
const N = 44;
type Lot = { kind: 'grass' | 'road' | 'water' | 'park' | 'building' | 'tree'; hgt: number; color: string; lit: number };
const PALETTE = ['#c8553d', '#e0b04c', '#6c9bd2', '#e3d9bf', '#8fb996', '#b56576', '#e07a5f', '#7a9e9f', '#f2cc8f', '#a3c4bc', '#d4a5a5', '#5e7ce2'];
const lots: Lot[][] = [];
{
  const r = rng(7);
  for (let x = 0; x < N; x++) {
    lots.push([]);
    for (let y = 0; y < N; y++) {
      const river = Math.abs(x - 30 - Math.sin(y / 4) * 2.5) < 1.3;
      const road = x % 6 === 0 || y % 6 === 0;
      const dc = Math.hypot(x - 18, y - 20);
      let lot: Lot = { kind: 'grass', hgt: 0, color: '#5f9e4f', lit: 0 };
      if (road) lot = { kind: 'road', hgt: 0, color: '#6a6a70', lit: 0 };
      else if (river) lot = { kind: 'water', hgt: 0, color: '#3f86c6', lit: 0 };
      else if ((x > 8 && x < 12 && y > 26 && y < 30) || r() < 0.06) lot = { kind: 'park', hgt: 0, color: '#6fb35a', lit: 0 };
      else if (r() < (dc < 9 ? 0.92 : dc < 16 ? 0.7 : 0.35)) {
        const tall = dc < 9 ? 5 + Math.floor(r() * 7) : dc < 16 ? 2 + Math.floor(r() * 3) : 1 + Math.floor(r() * 2);
        lot = { kind: 'building', hgt: tall, color: PALETTE[Math.floor(r() * PALETTE.length)], lit: r() };
      } else if (r() < 0.6) lot = { kind: 'tree', hgt: 0, color: '#2f6b3a', lit: 0 };
      lots[x].push(lot);
    }
  }
}

function shadeHex(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v, i) =>
    Math.max(0, Math.min(255, Math.round(f < 1 ? v * f + (i === 2 ? (1 - f) * 30 : 0) : v + (255 - v) * (f - 1)))),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function drawWorld(): void {
  const W = Math.ceil(window.innerWidth / zoom);
  const H = Math.ceil(window.innerHeight / zoom);
  if (world.width !== W || world.height !== H) {
    world.width = W;
    world.height = H;
  }
  const c = wctx;
  c.imageSmoothingEnabled = false;
  c.fillStyle = '#34623a';
  c.fillRect(0, 0, W, H);
  const ox = Math.round(W / 2 + camX);
  const oy = Math.round(H / 2 - N * 16 + 40 + camY);
  const hw = 32;
  const hh = 16;
  const diamond = (sx: number, sy: number, w: number, hgt: number) => {
    c.beginPath();
    c.moveTo(sx, sy);
    c.lineTo(sx + w, sy + hgt);
    c.lineTo(sx, sy + hgt * 2);
    c.lineTo(sx - w, sy + hgt);
    c.closePath();
  };
  for (let s = 0; s < N * 2 - 1; s++) {
    for (let x = 0; x < N; x++) {
      const y = s - x;
      if (y < 0 || y >= N) continue;
      const lot = lots[x][y];
      const sx = ox + (x - y) * hw;
      const sy = oy + (x + y) * hh;
      if (sx < -80 || sx > W + 80 || sy < -260 || sy > H + 40) continue;
      // ground
      const ground = lot.kind === 'building' || lot.kind === 'tree' ? ((x + y) % 2 ? '#5b9a4c' : '#62a352') : lot.kind === 'grass' ? ((x * 7 + y * 3) % 5 ? '#5f9e4f' : '#67a857') : lot.color;
      diamond(sx, sy, hw, hh);
      c.fillStyle = ground;
      c.fill();
      if (lot.kind === 'road') {
        c.fillStyle = '#e8d27a';
        const horiz = y % 6 === 0;
        for (let k = -2; k <= 2; k += 2) c.fillRect(sx + (horiz ? k * 6 : -k * 6), sy + hh + k * 3, 3, 1);
        if ((x * 31 + y * 17) % 23 === 0) {
          c.fillStyle = ['#d33', '#36c', '#fc3', '#eee'][(x + y) % 4];
          c.fillRect(sx - 3, sy + hh - 2, 6, 3);
        }
      } else if (lot.kind === 'water') {
        c.fillStyle = 'rgba(255,255,255,0.35)';
        c.fillRect(sx - 8 + ((x * 5) % 11), sy + hh - 2 + (y % 3), 6, 1);
      } else if (lot.kind === 'park') {
        c.fillStyle = '#f4d35e';
        c.fillRect(sx - 2, sy + hh - 1, 2, 2);
        c.fillStyle = '#ee6c4d';
        c.fillRect(sx + 6, sy + hh + 3, 2, 2);
      } else if (lot.kind === 'tree') {
        c.fillStyle = '#5b3a1e';
        c.fillRect(sx - 1, sy + hh - 6, 2, 7);
        c.fillStyle = '#2f6b3a';
        c.fillRect(sx - 6, sy + hh - 16, 12, 11);
        c.fillStyle = '#3f8a47';
        c.fillRect(sx - 4, sy + hh - 18, 8, 6);
      } else if (lot.kind === 'building') {
        const bw = 24;
        const bh = 12;
        const top = sy + (hh - bh);
        const height = lot.hgt * 12;
        const base = lot.color;
        // left face
        c.beginPath();
        c.moveTo(sx - bw, top + bh);
        c.lineTo(sx, top + bh * 2);
        c.lineTo(sx, top + bh * 2 - height);
        c.lineTo(sx - bw, top + bh - height);
        c.closePath();
        c.fillStyle = shadeHex(base, 0.82);
        c.fill();
        // right face
        c.beginPath();
        c.moveTo(sx, top + bh * 2);
        c.lineTo(sx + bw, top + bh);
        c.lineTo(sx + bw, top + bh - height);
        c.lineTo(sx, top + bh * 2 - height);
        c.closePath();
        c.fillStyle = shadeHex(base, 0.6);
        c.fill();
        // roof
        diamond(sx, top - height, bw, bh);
        c.fillStyle = shadeHex(base, 1.18);
        c.fill();
        // windows
        for (let f = 0; f < lot.hgt; f++) {
          for (let k = 1; k <= 3; k++) {
            const t = k / 4;
            const lx = Math.round(sx - bw + bw * t);
            const ly = Math.round(top + bh + bh * t - f * 12 - 8);
            c.fillStyle = (f * 3 + k + x) % 5 < lot.lit * 5 ? '#ffe9a8' : 'rgba(20,30,50,0.55)';
            c.fillRect(lx - 1, ly, 3, 4);
            const rx = Math.round(sx + bw * t);
            const ry = Math.round(top + bh * 2 - bh * t - f * 12 - 8);
            c.fillStyle = (f + k * 2 + y) % 4 < lot.lit * 3 ? '#ffd66b' : 'rgba(15,20,40,0.6)';
            c.fillRect(rx - 1, ry, 3, 4);
          }
        }
      }
    }
  }
}

let drawQueued = false;
function queueDraw(): void {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    drawWorld();
  });
}

// Pan the map; a click without dragging "inspects" a building (opens the Business window there).
{
  let down: { x: number; y: number; cx: number; cy: number; id: number } | null = null;
  let moved = false;
  world.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, cx: camX, cy: camY, id: e.pointerId };
    moved = false;
    world.setPointerCapture(e.pointerId);
  });
  world.addEventListener('pointermove', (e) => {
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    moved = true;
    world.classList.add('is-panning');
    camX = down.cx + dx / zoom;
    camY = down.cy + dy / zoom;
    queueDraw();
  });
  const up = (e: PointerEvent) => {
    if (!down || e.pointerId !== down.id) return;
    world.classList.remove('is-panning');
    if (!moved && e.type === 'pointerup') {
      const names: [string, string, string][] = [
        ['Copper Kettle Cafe', '☕', '#8b5a2b'],
        ['Bolt Electronics', '🔌', '#3d6fb6'],
        ['Blue Door Books', '📚', '#2d6a8f'],
        ['Riverside Gym', '🏋️', '#b0413e'],
        ['Green Leaf Grocers', '🥬', '#4d8b31'],
      ];
      const [name, icon, accent] = pick(names);
      Object.assign(biz, { name, icon, accent, kind: 'Shop', street: `${2 + Math.floor(rand() * 90)} Market St.` });
      openBusiness({ x: e.clientX, y: e.clientY });
    }
    down = null;
  };
  world.addEventListener('pointerup', up);
  world.addEventListener('pointercancel', up);
  // Window-level wheel zoom: wheel over a game window never gets here (the toolkit shields it).
  window.addEventListener(
    'wheel',
    (e) => {
      const z = Math.max(1, Math.min(3, zoom + (e.deltaY < 0 ? 1 : -1)));
      if (z !== zoom) {
        zoom = z;
        queueDraw();
      }
    },
    { passive: true },
  );
  window.addEventListener('resize', queueDraw);
}

// ---------------------------------------------------------------------------------------------
// Windows

function openBank(): void {
  openWindow({
    id: 'bank:first-mercantile',
    title: 'First Mercantile Bank',
    icon: '🏦',
    accent: '#2f6d55',
    width: 392,
    x: 16,
    y: 16,
    tabs: [
      { id: 'overview', label: 'Overview', icon: '📋' },
      { id: 'balance', label: 'Balance Sheet', icon: '⚖️' },
      { id: 'loans', label: 'Loans', icon: '📜' },
      { id: 'history', label: 'History', icon: '📈' },
    ],
    render(body, ctx) {
      if (ctx.tab === 'overview') {
        const cr = capitalRatio();
        body.append(
          h(
            'div',
            { class: 'mi-row', style: { marginBottom: '8px' } },
            badge('Solvent', 'good'),
            lcr() < 1.15 ? badge('Liquidity tight', 'warn', { blink: true, tip: 'Liquid assets barely cover 30 days of outflows.' }) : badge('Liquid', 'good'),
            badge('Tier 2', 'muted'),
            h('span', { class: 'mi-muted', style: { marginLeft: 'auto', fontSize: '11px' } }, 'CEO: Marge Pennyworth'),
          ),
          h(
            'div',
            { class: 'mi-sunken mi-grid3' },
            stat('Deposits', money(bank.deposits), '+1.8%'),
            stat('Loan book', money(bank.business + bank.mortgage + bank.consumer), '+0.9%'),
            stat('Net income', money(bank.netIncome), { value: -1, text: '12%' }, { tone: bank.netIncome < 0 ? 'bad' : undefined }),
          ),
          section(
            'Health',
            gauge({
              label: 'Capital ratio',
              value: cr,
              min: 0,
              max: 0.2,
              format: (v) => pct(v),
              marks: [
                { at: sim.capitalReq, label: `Min ${pct(sim.capitalReq, 0)}`, color: '#ff6a55' },
                { at: 0.105, label: 'Buffer', color: '#f2c14e' },
              ],
              dangerBelow: sim.capitalReq,
              warnBelow: 0.105,
              tip: 'Equity ÷ risk-weighted assets.\nBelow the minimum the regulator steps in.',
            }),
            gauge({
              label: 'Liquidity coverage',
              value: lcr(),
              min: 0,
              max: 2,
              format: (v) => pct(v, 0),
              marks: [{ at: sim.lcrReq, label: 'Req. 100%', color: '#ff6a55' }],
              dangerBelow: sim.lcrReq,
              warnBelow: 1.2,
            }),
            gauge({
              label: 'Loan-to-deposit',
              value: ltd(),
              min: 0.5,
              max: 1.3,
              format: (v) => pct(v, 0),
              warnAbove: 0.9,
              dangerAbove: 1.1,
            }),
          ),
          section(
            'Ledger',
            kv([
              ['Reserves at central bank', money(bank.reserves), { hint: 'Deposits held at the Reserve Bank. Required: ' + pct(sim.reserveReq, 0) }],
              ['Wholesale funding', money(bank.wholesale), { tone: bank.wholesale > 12e6 ? 'warn' : undefined }],
              ['Non-performing loans', pct(bank.npl), { tone: bank.npl > 0.04 ? 'bad' : 'warn' }],
              ['Deposit rate', pct(sim.policyRate * 0.45, 2)],
              ['Avg. lending rate', pct(sim.policyRate + 0.031, 2)],
              ['Equity', money(equityOf()), { strong: true }],
            ]),
          ),
          actions(
            button('Audit', () => news.push('Auditors dispatched to First Mercantile.'), { icon: '🔍' }),
            button('Emergency loan', () => news.push('Reserve Bank extends $5M emergency loan to First Mercantile.', 'warn'), { icon: '💰' }),
            button('Resolve…', () => news.push('Resolution plan drafted for First Mercantile.', 'bad'), { danger: true }),
          ),
        );
      } else if (ctx.tab === 'balance') {
        body.append(
          balanceSheet({
            format: money,
            assets: [
              { label: 'Reserves', value: bank.reserves, hint: 'Central bank money' },
              { label: 'Business loans', value: bank.business, onClick: () => ctx.win.setTab('loans') },
              { label: 'Mortgages', value: bank.mortgage, onClick: () => ctx.win.setTab('loans') },
              { label: 'Consumer loans', value: bank.consumer, onClick: () => ctx.win.setTab('loans') },
              { label: 'Gov. bonds', value: bank.bonds },
              { label: 'MBS', value: bank.mbs, hint: 'Mortgage-backed securities' },
            ],
            liabilities: [
              { label: 'Deposits', value: bank.deposits },
              { label: 'Wholesale', value: bank.wholesale },
              { label: 'CB loans', value: bank.cbLoans },
            ],
            equity: [
              { label: 'Share capital', value: bank.shareCapital },
              { label: 'Retained', value: equityOf() - bank.shareCapital },
            ],
          }),
          note('Every loan the bank makes creates a matching deposit: both sides of the T grow together.'),
          section(
            'Stress test: −20% house prices',
            balanceSheet({
              format: money,
              shares: false,
              titles: ['Assets (stressed)', 'Claims'],
              assets: [
                { label: 'Reserves', value: bank.reserves },
                { label: 'Loans', value: (bank.business + bank.consumer) * 0.9 + bank.mortgage * 0.8 },
                { label: 'Securities', value: bank.bonds + bank.mbs * 0.55 },
              ],
              liabilities: [
                { label: 'Deposits', value: bank.deposits },
                { label: 'Other', value: bank.wholesale + bank.cbLoans },
              ],
              equity: [{ label: 'Equity', value: assetsOf() - liabOf() - 0.1 * (bank.business + bank.consumer) - 0.2 * bank.mortgage - 0.45 * bank.mbs }],
            }),
          ),
        );
      } else if (ctx.tab === 'loans') {
        const rows = loanFilter === 'all' ? loans : loans.filter((l) => l.kind.toLowerCase() === loanFilter);
        body.append(
          h(
            'div',
            { class: 'mi-row is-spread', style: { marginBottom: '6px' } },
            choice({
              small: true,
              value: loanFilter,
              options: [
                { id: 'all', label: 'All' },
                { id: 'business', label: 'Business' },
                { id: 'mortgage', label: 'Mortgage' },
                { id: 'consumer', label: 'Consumer' },
              ],
              onChange: (id) => {
                loanFilter = id;
                ctx.win.rerender();
              },
            }),
            h('span', { class: 'mi-muted', style: { fontSize: '11px' } }, `${rows.length} loans`),
          ),
          table<Loan>({
            key: 'fm-loans',
            sortable: true,
            maxRows: 11,
            rows,
            columns: [
              { key: 'borrower', label: 'Borrower', grow: true },
              { key: 'kind', label: 'Type', format: (v: string) => v.slice(0, 4) + '.' },
              { key: 'amount', label: 'Amount', format: (v: number) => money(v) },
              { key: 'rate', label: 'Rate', format: (v: number) => pct(v, 2) },
              { key: 'status', label: 'Status', format: (v: Loan['status']) => badge(v === 'Restructured' ? 'Restruct.' : v, STATUS_TONE[v]) },
            ],
            rowTone: (l) => (l.status === 'Default' ? 'bad' : undefined),
            onRowClick: (l, _i, e) => openLoan(l, 'clientX' in e ? { x: e.clientX, y: e.clientY } : undefined),
          }),
          kv([
            ['Book value', money(rows.reduce((s, l) => s + l.amount, 0))],
            ['Late or defaulted', `${rows.filter((l) => l.status === 'Late' || l.status === 'Default').length}`, { tone: 'warn' }],
          ]),
        );
      } else {
        const hv = bank.hist.capital.length + bank.hist.month0 * 1000;
        const labels = bank.hist.capital.map((_, i) => monthLabel(bank.hist.month0 + i));
        body.append(
          section(
            'Key ratios',
            ctx.memo('ratios', [hv, sim.capitalReq], () =>
              lineChart({
                percent: true,
                height: 150,
                labels,
                series: [
                  { label: 'Capital ratio', color: '#f2c14e', values: bank.hist.capital, area: true },
                  { label: 'Liquid assets', color: '#5fd3c6', values: bank.hist.liquidity },
                  { label: 'NPL ratio', color: '#ff7a5c', values: bank.hist.npl, dashed: true },
                ],
                refLines: [{ at: sim.capitalReq, label: `MIN ${pct(sim.capitalReq, 0)}`, color: '#ff6a55' }],
                markers: [
                  { index: 9, label: 'Rate hike', color: '#c9a0ff' },
                  { index: 18, label: 'Bank run', color: '#ff7a5c' },
                ],
              }),
            ),
          ),
          section(
            'Monthly profit',
            ctx.memo('profit', [hv], () =>
              barChart({
                height: 96,
                labels,
                zeroLine: true,
                format: money,
                series: [{ label: 'Net income', color: '#9be07a', values: bank.hist.profit }],
              }),
            ),
          ),
        );
      }
    },
  });
}
let loanFilter = 'all';

function openLoan(l: Loan, anchor?: { x: number; y: number }): void {
  openWindow({
    id: 'loan',
    title: `Loan #${l.id}`,
    icon: l.kind === 'Mortgage' ? '🏠' : l.kind === 'Business' ? '🏪' : '💳',
    width: 250,
    anchor,
    render(body) {
      body.append(
        h('div', { class: 'mi-row is-spread', style: { marginBottom: '6px' } }, h('b', null, l.borrower), badge(l.status, STATUS_TONE[l.status])),
        kv([
          ['Type', l.kind],
          ['Principal', money(l.amount)],
          ['Rate', pct(l.rate, 2)],
          ['Term', `${l.years} years`],
          ['Monthly payment', money((l.amount * (l.rate / 12)) / (1 - Math.pow(1 + l.rate / 12, -l.years * 12)))],
        ]),
        actions(button('Restructure', () => news.push(`Loan #${l.id} restructured.`), { small: true }), button('Call in', () => news.push(`Loan #${l.id} called in!`, 'bad'), { small: true, danger: true })),
      );
    },
  });
}

function openReserveBank(): void {
  openWindow({
    id: 'reserve-bank',
    title: 'Reserve Bank',
    icon: '🏛️',
    accent: '#3a4f8f',
    width: 318,
    x: window.innerWidth - 318 - 16,
    y: 16,
    render(body, ctx) {
      body.append(
        section(
          'Policy levers',
          spinner({
            label: 'Policy rate',
            value: sim.policyRate,
            min: 0,
            max: 0.15,
            step: 0.0025,
            format: (v) => pct(v, 2),
            onChange: (v) => (sim.policyRate = v),
            tip: 'The rate at which banks borrow reserves overnight.',
          }),
          spinner({ label: 'Reserve requirement', value: sim.reserveReq, min: 0, max: 0.3, step: 0.005, format: (v) => pct(v, 1), onChange: (v) => (sim.reserveReq = v) }),
          spinner({ label: 'Capital requirement', value: sim.capitalReq, min: 0.04, max: 0.16, step: 0.005, format: (v) => pct(v, 1), onChange: (v) => (sim.capitalReq = v) }),
        ),
        section(
          'Backstops',
          field(
            'Deposit insurance',
            choice({
              value: sim.insurance,
              options: [
                { id: 'none', label: 'None', title: 'Depositors lose money when a bank fails.' },
                { id: '100k', label: '$100K', title: 'Deposits insured up to $100K per account.' },
                { id: 'all', label: 'All', title: 'Every deposit is guaranteed (moral hazard!).' },
              ],
              onChange: (id) => (sim.insurance = id),
            }),
          ),
          field(
            'Lender of last resort',
            choice({
              value: sim.lolr,
              options: [
                { id: 'off', label: 'Off' },
                { id: 'penalty', label: 'Penalty' },
                { id: 'easy', label: 'Easy' },
              ],
              onChange: (id) => (sim.lolr = id),
            }),
          ),
          field(
            'Asset purchases',
            choice({
              value: sim.qe,
              options: [
                { id: 'off', label: 'Off' },
                { id: 'bonds', label: 'Bonds' },
                { id: 'mbs', label: 'MBS' },
              ],
              onChange: (id) => {
                sim.qe = id;
                ctx.win.rerender();
              },
            }),
          ),
        ),
        section(
          'Economy',
          h(
            'div',
            { class: 'mi-sunken mi-grid3' },
            stat('Inflation', pct(sim.inflation), { value: 0.2, text: '0.2pp', good: 'down' }),
            stat('Jobless', pct(sim.unemployment), { value: -0.1, text: '0.1pp', good: 'down' }),
            stat('GDP', pct(sim.gdp), '+0.3pp'),
          ),
        ),
        actions(
          button('Announce', () => news.push(`Reserve Bank sets policy rate at ${pct(sim.policyRate, 2)}.`, 'good'), { primary: true, icon: '📣' }),
          iconButton('❓', 'How monetary policy works', () => news.push('Tip: higher rates cool lending and inflation.')),
        ),
      );
    },
  });
}

function openBusiness(anchor?: { x: number; y: number }): void {
  openWindow({
    id: 'business',
    title: biz.name,
    icon: biz.icon,
    accent: biz.accent,
    width: 272,
    anchor,
    render(body) {
      const rev = biz.revenue[biz.revenue.length - 1];
      const profit = rev * 30 - (biz.staff * 2600 + 5200 + 1900);
      body.append(
        h('div', { class: 'mi-row is-spread', style: { marginBottom: '6px' } }, h('span', { class: 'mi-muted' }, `${biz.kind} · ${biz.street}`), badge('Hiring', 'info')),
        h(
          'div',
          { class: 'mi-sunken mi-row is-spread' },
          stat('Revenue / day', money(rev), '+3.2%'),
          sparkline(biz.revenue, '#1f7a8c', 104, 28, { title: 'Daily revenue, last 48 days' }),
        ),
        section(
          'This month',
          kv([
            ['Wages', money(-biz.staff * 2600)],
            ['Rent', money(-5200)],
            ['Loan interest', money(-1900), { hint: `Loan from ${biz.lender} at ${pct(sim.policyRate + 0.035, 2)}` }],
            ['Profit', money(profit), { tone: profit >= 0 ? 'good' : 'bad', strong: true }],
          ]),
        ),
        actions(
          button('Visit', () => news.push(`You visit ${biz.name}. The coffee is decent.`), { small: true }),
          button('Offer loan', () => openLoanApp(), { small: true, primary: true }),
        ),
      );
    },
  });
}

let appTerm = '5';
let appRate = 0.0725;
function openLoanApp(): void {
  openWindow({
    id: 'loan-app',
    title: 'Loan Application',
    icon: '📝',
    width: 282,
    x: 424,
    y: window.innerHeight - 56 - 372,
    render(body) {
      const pay = (85e3 * (appRate / 12)) / (1 - Math.pow(1 + appRate / 12, -Number(appTerm) * 12));
      const dsr = (pay * 12) / 84e3;
      body.append(
        note(h('span', null, h('b', null, 'Sunrise Bakery'), ' wants $85K for a second oven.')),
        kv([
          ['Credit score', '712', { tone: 'good' }],
          ['Collateral', 'Oven + receivables'],
          ['Monthly payment', money(pay)],
        ]),
        h(
          'div',
          { style: { margin: '6px 0' } },
          gauge({
            label: 'Debt service ratio',
            value: dsr,
            min: 0,
            max: 0.5,
            format: (v) => pct(v),
            marks: [{ at: 0.3, label: 'Limit 30%', color: '#ff6a55' }],
            warnAbove: 0.25,
            dangerAbove: 0.3,
          }),
        ),
        field(
          'Term',
          choice({
            value: appTerm,
            options: [
              { id: '3', label: '3y' },
              { id: '5', label: '5y' },
              { id: '10', label: '10y' },
            ],
            onChange: (id) => (appTerm = id),
          }),
        ),
        spinner({ label: 'Interest rate', value: appRate, min: 0.03, max: 0.2, step: 0.0025, format: (v) => pct(v, 2), onChange: (v) => (appRate = v) }),
        actions(
          button('Decline', () => news.push('Loan application declined.', 'bad'), { danger: true }),
          button('Approve', () => news.push('Loan approved: $85K new money created as a deposit.', 'good'), { primary: true, icon: '✅' }),
        ),
      );
    },
  });
}

// ---------------------------------------------------------------------------------------------
// HUD strip

const news = ticker([
  'First Mercantile raises mortgage rates to 6.1%',
  'Harbor Savings reports record deposits',
  'Unemployment falls for the third month',
  'Bakers’ union demands a raise',
]);
const dateEl = lcd('');
const speedGroup = stripGroup();
const statsGroup = h('div', { class: 'demo-stats' });
const tools = stripGroup(
  iconButton('🏦', 'First Mercantile Bank', () => openBank(), { small: true }),
  iconButton('🏛️', 'Reserve Bank', () => openReserveBank(), { small: true }),
  iconButton('🍔', 'Business', () => openBusiness(), { small: true }),
  iconButton(glyph('close'), 'Close all windows', () => closeAllWindows(), { small: true }),
);
tools.classList.add('demo-tools');
const hud = strip(stripGroup(dateEl), speedGroup, news, statsGroup, tools);
hud.classList.add('demo-hud');
document.body.appendChild(hud);

function renderSpeed(): void {
  const speeds = [1, 2, 5, 10];
  speedGroup.replaceChildren(
    iconButton(glyph('pause'), 'Pause', () => {
      sim.paused = !sim.paused;
      renderSpeed();
    }, { small: true, active: sim.paused }),
    ...speeds.map((s) =>
      button(`${s}×`, () => {
        sim.speed = s;
        sim.paused = false;
        renderSpeed();
      }, { small: true, active: !sim.paused && sim.speed === s }),
    ),
  );
}

function renderHud(): void {
  const d = dateOf(sim.day);
  const t = `${MONTHS[d.m].toUpperCase()} ${String(d.d).padStart(2, '0')} Y${d.y}`;
  if (dateEl.textContent !== t) dateEl.textContent = t;
  statsGroup.replaceChildren(
    stat('Cash', money(sim.cash), '+2.1%'),
    stat('Policy', pct(sim.policyRate, 2)),
    stat('Inflation', pct(sim.inflation), { value: 1, text: '0.2', good: 'down' }, { tone: sim.inflation > 0.04 ? 'bad' : undefined }),
    stat('Jobless', pct(sim.unemployment), { value: -1, text: '0.1', good: 'down' }),
    stat('Mood', `${Math.round(sim.mood * 100)}%`, '+1', { tip: 'How people feel about the economy.' }),
  );
}

const demoCss = document.createElement('style');
demoCss.textContent = `
  .demo-hud { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; border-left: none; border-right: none; }
  .demo-stats { display: flex; gap: 14px; padding: 0 6px; }
  .demo-tools { margin-left: 2px; }
  @media (max-width: 1100px) { .demo-stats .mi-stat:nth-child(n+4) { display: none; } }
  @media (max-width: 719px) {
    .demo-hud { flex-wrap: wrap; gap: 4px; }
    .demo-hud .mi-ticker { order: 5; flex-basis: 100%; }
    .demo-stats { gap: 10px; padding: 0 2px; }
    .demo-stats .mi-stat:nth-child(n+3) { display: none; }
    .demo-tools { display: none; }
  }
`;
document.head.appendChild(demoCss);

function syncInsets(): void {
  setUiInsets({ bottom: hud.offsetHeight });
}

// ---------------------------------------------------------------------------------------------
// Boot

renderSpeed();
renderHud();
drawWorld();
syncInsets();
window.addEventListener('resize', syncInsets);

openBusiness({ x: Math.round(window.innerWidth * 0.46), y: Math.round(window.innerHeight * 0.3) });
openLoanApp();
openReserveBank();
openBank();

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTopWindow();
});

// 4 Hz "simulation": drift the numbers and refresh the UI.
setInterval(() => {
  if (!sim.paused) {
    const days = 0.25 * sim.speed;
    const before = Math.floor(sim.day / 30);
    sim.day += days;
    bank.deposits = drift(bank.deposits, 0.004);
    bank.reserves = Math.max(1e6, drift(bank.reserves, 0.01));
    bank.wholesale = drift(bank.wholesale, 0.01);
    bank.business = drift(bank.business, 0.002);
    bank.mortgage = drift(bank.mortgage, 0.002);
    bank.netIncome += (rand() - 0.5) * 0.02e6;
    bank.npl = Math.max(0.005, bank.npl + (rand() - 0.5) * 0.0006);
    sim.inflation += (rand() - 0.5) * 0.0004;
    sim.unemployment += (rand() - 0.5) * 0.0003;
    sim.cash = drift(sim.cash, 0.002);
    biz.revenue.push(Math.max(800, biz.revenue[biz.revenue.length - 1] + (rand() - 0.47) * 120));
    biz.revenue.shift();
    if (Math.floor(sim.day / 30) !== before) {
      const hst = bank.hist;
      hst.capital.push(capitalRatio());
      hst.liquidity.push(Math.min(0.2, (bank.reserves + bank.bonds) / assetsOf()));
      hst.npl.push(bank.npl);
      hst.profit.push(bank.netIncome);
      for (const a of [hst.capital, hst.liquidity, hst.npl, hst.profit]) a.shift();
      hst.month0++;
    }
  }
  renderHud();
  updateWindows();
}, 250);
