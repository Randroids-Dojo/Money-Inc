// "How Money Works in Money Inc.": the player's guide. Mostly static text, with a few live
// touches (the current rules, the city's warning lights, a real bank's balance sheet, the coins
// flying right now). The body is re-rendered only when something it shows has changed, so the
// player can read, scroll and select text in peace.

import {
  actions,
  appendChildren,
  badge,
  balanceSheet,
  button,
  choice,
  gauge,
  glyph,
  h,
  iconEl,
  kv,
  lcd,
  note,
  openWindow,
  section,
  type BsItem,
  type Child,
  type KvRow,
  type Tone,
  type WindowCtx,
} from '../../ui';
import { COIN_COLOURS, COIN_LABELS, type CoinKind } from '../../render/effects';
import { drawPixelText, iconSprite, measurePixelText, propSprite, type IconKind, type PropKind } from '../../render/sprites';
import { metrics } from '../../sim/banking';
import type { Economy } from '../../sim/economy';
import { fmtMoney, pct } from '../../sim/format';
import { INSURANCE_LIMITS, type PolicySettings } from '../../sim/types';
import type { UIContext } from './context';
import { openStatsWindow } from './statsWindow';

type TabId = 'play' | 'money' | 'banks' | 'cycles' | 'colours';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'play', label: 'How to play', icon: '🎮' },
  { id: 'money', label: 'Money', icon: '💵' },
  { id: 'banks', label: 'Banks', icon: '🏦' },
  { id: 'cycles', label: 'Booms & busts', icon: '🎢' },
  { id: 'colours', label: 'Legend', icon: '🎨' },
];

const isTab = (t: string | undefined): t is TabId => !!t && TABS.some((x) => x.id === t);

let lastTab: TabId = 'play';
/** Step of the "a loan creates money" demo. */
let demo: 'before' | 'lend' | 'repay' = 'before';
/** Bank shown on the Banks page. */
let shownBank = -1;

/**
 * Open (or focus) the help window, optionally on a topic:
 * 'play' | 'money' | 'banks' | 'cycles' | 'colours'.
 */
export function openHelpWindow(ctx: UIContext, topic?: string): void {
  injectStyle();
  let sig: readonly unknown[] = [];
  openWindow({
    id: 'help',
    title: 'How Money Works in Money Inc.',
    icon: '❓',
    width: 520,
    className: 'mi-help-win',
    tabs: TABS,
    initialTab: isTab(topic) ? topic : lastTab,
    render(body, w) {
      const tab: TabId = isTab(w.tab) ? w.tab : 'play';
      lastTab = tab;
      sig = signature(ctx, tab);
      appendChildren(body, PAGES[tab](ctx, w));
    },
    update(body, w) {
      const tab: TabId = isTab(w.tab) ? w.tab : 'play';
      if (tab === 'colours') patchActivity(ctx, body);
      const next = signature(ctx, tab);
      if (sameDeps(next, sig) || isBusy(body)) return;
      w.win.rerender();
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Re-render only when what a page shows has changed.

function policyKey(p: PolicySettings): string {
  return [p.policyRate, p.capitalRequirement, p.liquidityRequirement, p.depositInsurance, p.emergencyLiquidity, p.qePerMonth, p.qeTarget, p.autopilot].join('|');
}

function signature(ctx: UIContext, tab: TabId): readonly unknown[] {
  const eco = ctx.game.eco;
  switch (tab) {
    case 'play':
      return [eco];
    case 'money':
      return [eco, policyKey(eco.policy)];
    case 'banks':
      return [eco, eco.month, policyKey(eco.policy), eco.banks.map((b) => (b.alive ? 1 : 0)).join('')];
    case 'cycles':
      return [eco, eco.stats.length, eco.policy.capitalRequirement];
    case 'colours':
      return [eco, ctx.game.showFlows];
  }
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/** Don't rebuild under the player's pointer or while they are selecting text. */
function isBusy(body: HTMLElement): boolean {
  const sel = document.getSelection();
  if (sel && !sel.isCollapsed && sel.anchorNode && body.contains(sel.anchorNode)) return true;
  return body.querySelector(':active') !== null;
}

// ---------------------------------------------------------------------------------------------
// Little building blocks

const b = (s: string) => h('b', null, s);
const p = (...c: Child[]) => h('p', { class: 'mi-help-p' }, ...c);
const bullets = (items: Child[]) => h('ul', { class: 'mi-help-list' }, items.map((it) => h('li', null, it)));
const key = (k: string) => h('kbd', { class: 'mi-help-key' }, k);

function keys(rows: [Child[], string][]): HTMLElement {
  return h(
    'div',
    { class: 'mi-help-keys' },
    rows.map(([ks, what]) => [h('span', { class: 'mi-help-keycaps' }, ks), h('span', null, what)]),
  );
}

/** A row of "icon · text" items. */
function iconRows(rows: [string | Node, Child][]): HTMLElement {
  return h(
    'div',
    { class: 'mi-help-irows' },
    rows.map(([icon, text]) => h('div', { class: 'mi-help-irow' }, h('span', { class: 'mi-help-ibox' }, typeof icon === 'string' ? iconEl(icon, { px: 12 }) : icon), h('span', null, text))),
  );
}

/** Four-step feedback loop: A → B ↓ C ← D ↑ back to A. */
function loop(tone: 'boom' | 'bust', steps: [string, string][]): HTMLElement {
  const box = (i: number) => h('div', { class: 'mi-help-loop-box' }, iconEl(steps[i][0], { px: 12 }), h('span', null, steps[i][1]));
  const arrow = (g: 'right' | 'left' | 'triUp' | 'triDown') => h('span', { class: 'mi-help-loop-arrow', 'aria-hidden': 'true' }, glyph(g, 2));
  return h(
    'div',
    { class: ['mi-help-loop', `is-${tone}`], role: 'img', 'aria-label': steps.map((s) => s[1]).join(', then ') + ', and round again.' },
    box(0),
    arrow('right'),
    box(1),
    arrow('triUp'),
    h('span', { class: 'mi-help-loop-hub' }, tone === 'boom' ? 'BOOM' : 'BUST'),
    arrow('triDown'),
    box(3),
    arrow('left'),
    box(2),
  );
}

function insuranceText(p: PolicySettings): string {
  const lim = INSURANCE_LIMITS[p.depositInsurance];
  if (p.depositInsurance === 'none') return 'None';
  if (!Number.isFinite(lim)) return 'Every deposit';
  return `Up to ${fmtMoney(lim)}`;
}

function lolrText(p: PolicySettings): string {
  return p.emergencyLiquidity === 'none' ? 'None' : p.emergencyLiquidity === 'broad' ? 'Broad (any collateral)' : 'Standard (good collateral)';
}

function pctRule(v: number): string {
  return pct(v, Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? 0 : 1);
}

// ---------------------------------------------------------------------------------------------
// Pages

const PAGES: Record<TabId, (ctx: UIContext, w: WindowCtx) => Child[]> = {
  play: (ctx) => {
    const eco = ctx.game.eco;
    return [
      h(
        'div',
        { class: 'mi-help-hero' },
        iconEl('🏛️', { px: 14, scale: 2 }),
        h(
          'p',
          null,
          'Welcome to ',
          b(eco.city.name),
          '! You run its ',
          b('Reserve Bank'),
          ' — the central bank and banking regulator. You don’t build anything: the town lives on its own. People work, shop, borrow and buy homes; firms hire, invest and sometimes go bust; banks lend, compete and sometimes fail.',
        ),
      ),
      section(
        'Your job',
        p(
          'Keep money working for the town: steady prices, plenty of jobs, and banks that don’t blow up. Your levers are the ',
          b('interest rate'),
          ' and the ',
          b('banking rules'),
          ' — plus the power to step in when a crisis hits.',
        ),
        actions(button('Open the Reserve Bank', () => ctx.open({ kind: 'cb' }), { icon: '🏛️', primary: true, small: true, title: 'Your controls (B)' })),
      ),
      section(
        'Look around',
        bullets([
          [b('Click anything'), ' — a house, a shop, a bank, a building site — to open its window: income, spending, savings and debts.'],
          [b('Follow a loan'), ': open a bank, pick one of its loans, and see where the money it created went.'],
          ['Buildings show their mood with balloons, signs and floating captions (see ', b('Legend'), ').'],
        ]),
      ),
      section(
        'The bottom strip',
        bullets([
          [b('Date and speed'), ': pause, 1×, 2×, 5× or 10×.'],
          [b('News ticker'), ' — click it to read every headline.'],
          [b('Key numbers'), ': money, credit, inflation, jobs, home prices and your policy rate.'],
          [b('Buttons'), ': Reserve Bank, Statistics, News, this guide and a new city.'],
        ]),
      ),
      section(
        'Map views',
        p('The panel at the top left switches the map between lenses:'),
        iconRows([
          ['🏦', [b('Banks'), ' — which bank holds each building’s money.']],
          ['📉', [b('Debt'), ' — who owes money, and who is falling behind.']],
          ['🧬', [b('Origin'), ' — which bank created the money sitting in each building.']],
          ['🏠', [b('Property'), ' — home values.']],
          ['👷', [b('Jobs'), ' — where people are out of work, and who is hiring.']],
          ['💸', [b('Money'), ' — coins fly for every payment: green for new money, red for money destroyed.']],
        ]),
      ),
      section(
        'Windows',
        bullets([
          'Drag a window by its title bar; double-click the title to fold it away.',
          'On a phone, windows slide up from the bottom: swipe the title down to close.',
          'Hover a chart (or touch and drag) to read exact values. Dotted labels explain themselves.',
        ]),
      ),
      section(
        'Keyboard',
        keys([
          [[key('Space')], 'Pause / resume'],
          [[key('1'), key('2'), key('3'), key('4')], 'Speed 1× · 2× · 5× · 10×'],
          [[key('Esc')], 'Close the top window'],
          [[key('+'), key('−')], 'Zoom in / out'],
          [[key('←'), key('↑'), key('→'), key('↓')], 'Pan the map (or W A S D)'],
          [[key('L')], 'Next map lens'],
          [[key('F')], 'Money flows on / off'],
          [[key('B')], 'Reserve Bank'],
          [[key('G')], 'Statistics'],
          [[key('N')], 'News'],
          [[key('H'), key('?')], 'This guide'],
        ]),
      ),
    ];
  },

  money: (ctx, w) => {
    const eco = ctx.game.eco;
    const pol = eco.policy;
    return [
      section(
        'Banks create money',
        p(
          'When a bank makes a loan it does not hand over anybody’s savings. It simply ',
          b('types a new deposit'),
          ' into the borrower’s account. That deposit is brand-new money — it pops up on the map as a green sparkle.',
        ),
        loanDemo(w),
      ),
      section(
        'Repaying destroys it',
        p(
          'When a loan is paid back, the deposit and the debt cancel out and the money ',
          b('vanishes'),
          ' (a red puff on the map). So the money supply grows only while new lending outpaces repayments — when banks stop lending, money shrinks.',
        ),
      ),
      section(
        'No money multiplier',
        p('Textbooks say banks lend out deposits, multiplied up from their reserves. Not here — and not in real life. Reserves are for settling payments between banks, and a bank short of reserves simply borrows them. What really limits lending:'),
        bullets([
          [b('Capital'), ' — every loan must be backed by a slice of the bank’s own money (equity).'],
          [b('Fear'), ' — after losses, bankers tighten their standards and hoard safe assets.'],
          [b('Borrowers'), ' — someone has to want a loan, and be able to repay it.'],
        ]),
      ),
      section(
        'What you control',
        p('The Reserve Bank sets the price of reserves — the ', b('policy rate'), ', which banks pass on to borrowers and savers — and the rules of the game:'),
        kv([
          ['Policy rate', pol.autopilot ? `${pct(pol.policyRate, 2)} (autopilot)` : pct(pol.policyRate, 2), { hint: 'What banks pay to borrow reserves. Higher rates make every loan dearer.' }],
          ['Capital requirement', pctRule(pol.capitalRequirement), { hint: 'Equity each bank must hold per dollar of risky loans.' }],
          ['Liquidity requirement', pctRule(pol.liquidityRequirement), { hint: 'Cash-like assets each bank must hold per dollar of deposits.' }],
          ['Deposit insurance', insuranceText(pol), { hint: 'Deposits guaranteed if a bank fails. Insured savers have no reason to run.' }],
          ['Emergency lending', lolrText(pol), { hint: 'Whether the Reserve Bank lends reserves to a bank caught in a run.' }],
          [
            'Asset purchases',
            pol.qePerMonth === 0
              ? 'None'
              : `${pol.qePerMonth > 0 ? 'Buying' : 'Selling'} ${fmtMoney(Math.abs(pol.qePerMonth))}/month`,
            { hint: pol.qeTarget === 'govt_mbs' ? 'Government and mortgage bonds.' : 'Government bonds.' },
          ],
        ]),
        actions(button('Change the rules', () => ctx.open({ kind: 'cb' }), { icon: '🏛️', small: true, primary: true })),
      ),
      section(
        'Every dollar has a history',
        p(
          'Money here remembers where it came from. Open ',
          b('any loan'),
          ' to see which bank created it, where the money was spent, who holds it now and who took the loss if it went bad. The ',
          b('Origin'),
          ' lens colours every building by the bank that created the money in its accounts.',
        ),
        actions(button('Money & credit statistics', () => openStatsWindow(ctx, 'money'), { icon: '📊', small: true })),
      ),
    ];
  },

  banks: (ctx, w) => {
    const eco = ctx.game.eco;
    const pol = eco.policy;
    return [
      section('What a bank looks like', bankSheet(ctx, w)),
      section(
        'Two health checks',
        healthGauges(eco),
        p(b('Capital'), ' is the cushion that absorbs losses. ', b('Liquidity'), ' is cash on hand for withdrawals. Fall short on either and the bank must stop lending — or worse.'),
      ),
      section(
        'How banks fail',
        h(
          'div',
          { class: 'mi-help-cards' },
          h(
            'div',
            { class: 'mi-help-card' },
            badge('Insolvent', 'bad'),
            p('Bad loans eat through the equity until the bank owes more than it owns. Nothing can save it but fresh capital.'),
          ),
          h(
            'div',
            { class: 'mi-help-card' },
            badge('Illiquid (a run)', 'warn'),
            p('Depositors and lenders pull money out faster than the bank can raise reserves. Even a healthy bank can fall — fear is contagious.'),
          ),
        ),
      ),
      section(
        'Safety nets',
        kv([
          ['Deposit insurance', insuranceText(pol), { hint: 'Guarantees deposits up to a limit so savers don’t run. The catch: insured banks can take more risk.' }],
          ['Lender of last resort', lolrText(pol), { hint: 'The Reserve Bank lends reserves to a bank in a run, against collateral.' }],
          ['Resolution', 'Automatic', { hint: 'A failed bank’s accounts and loans are handed to a healthy bank. Uninsured deposits may take a haircut.' }],
        ]),
        note('Every rescue has a price: banks that expect to be saved take bigger risks next time.'),
      ),
      section(
        'Securitisation',
        p(
          'Banks can bundle mortgages into ',
          b('mortgage-backed securities (MBS)'),
          ` and sell them to investors like ${eco.fund.name}. The loans leave the bank’s books — freeing capital to lend again — but the money they created stays in the town, and the risk moves to whoever holds the bonds.`,
        ),
      ),
    ];
  },

  cycles: (ctx) => {
    return [
      h(
        'div',
        { class: 'mi-help-hero' },
        iconEl('🎢', { px: 14, scale: 2 }),
        h('p', null, b('Nothing is scripted.'), ' Booms and busts come from thousands of small decisions feeding back on each other — the same loops that drive real economies.'),
      ),
      section(
        'The boom loop',
        loop('boom', [
          ['🏦', 'Banks lend more'],
          ['💸', 'New money gets spent'],
          ['📈', 'Prices and home values rise'],
          ['🏠', 'Collateral looks safer'],
        ]),
        note('Rising house prices make bigger loans look safe, which pushes prices higher still.'),
      ),
      section(
        'The bust loop',
        loop('bust', [
          ['⚠️', 'Defaults and losses'],
          ['🔒', 'Banks get scared and tighten'],
          ['📉', 'Lending dries up: money shrinks'],
          ['👷', 'Spending falls, jobs go'],
        ]),
        note('Fewer jobs mean more defaults — and the loop turns again. Fear spreads from bank to bank.'),
      ),
      section({ title: 'Warning lights', aside: h('span', { class: 'mi-help-aside' }, 'right now') }, warningLights(ctx.game.eco)),
      section(
        'Your tools',
        bullets([
          [b('Lean against the boom'), ': raise rates or capital requirements before the debt piles up.'],
          [b('Soften the bust'), ': cut rates, lend to banks in a run, guarantee deposits.'],
          [b('Mind the side effects'), ': every rescue teaches banks that risk is safe.'],
        ]),
        actions(
          button('Statistics', () => openStatsWindow(ctx, 'money'), { icon: '📊', small: true }),
          button('Reserve Bank', () => ctx.open({ kind: 'cb' }), { icon: '🏛️', small: true, primary: true }),
        ),
      ),
    ];
  },

  colours: (ctx, w) => {
    const flows = ctx.game.showFlows;
    return [
      section(
        { title: 'Money on the move', aside: button(flows ? 'Showing' : 'Hidden', () => toggleFlows(ctx, w), { small: true, icon: '💸', active: flows, title: 'Money flows on / off (F)' }) },
        h(
          'div',
          { class: 'mi-help-coins' },
          COIN_ORDER.map((k) =>
            h(
              'div',
              { class: 'mi-help-coin', dataset: { coin: k } },
              w.memo(`coin:${k}`, [COIN_COLOURS[k]], () => coinCanvas(k)),
              h('span', { class: 'mi-help-coin-label' }, COIN_LABELS[k]),
              h('span', { class: 'mi-help-meter', tip: 'How much of this is flying around right now' }, h('i', { style: { width: '0%' } })),
            ),
          ),
        ),
        note(flows ? 'Every coin is a real payment between two buildings. Bigger coins carry more money.' : 'Money flows are hidden. Press F (or the Money button, top left) to watch payments fly.'),
      ),
      section(
        'Sparkles and puffs',
        iconRows([
          [w.memo('burst:create', [], () => burstCanvas('create')), [b('Green sparkle'), ' — a bank just lent: new money was created.']],
          [w.memo('burst:destroy', [], () => burstCanvas('destroy')), [b('Grey puff'), ' — a repayment arrived: money was destroyed.']],
        ]),
      ),
      section(
        'Balloons over buildings',
        w.memo('balloons', [], () =>
          spriteRows(
            BALLOONS.map(([k, text]) => [safeSprite(() => iconSprite(k).canvas), text]),
          ),
        ),
      ),
      section(
        'Signs',
        w.memo('signs', [], () => spriteRows(SIGNS.map(([k, text]) => [safeSprite(() => propSprite(k).canvas), text]))),
      ),
      section(
        'Floating captions',
        w.memo('captions', [], () =>
          h(
            'div',
            { class: 'mi-help-captions' },
            CAPTIONS.map(([text, color, what]) => h('div', { class: 'mi-help-caption' }, safeCaption(text, color), h('span', null, what))),
          ),
        ),
      ),
      note('Map lenses (Banks, Debt, Origin, Property, Jobs) show their own colour key in the corner while they are on.'),
    ];
  },
};

// ---------------------------------------------------------------------------------------------
// Money page: the loan demo (a toy bank's T-account)

function loanDemo(w: WindowCtx): HTMLElement {
  const NEW = COIN_COLOURS.new;
  const OLD_LOANS = 800_000;
  const OLD_DEP = 820_000;
  const step = demo;
  const garcia = step === 'lend' ? 200_000 : step === 'repay' ? 150_000 : 0;
  const assets: BsItem[] = [
    { label: 'Reserves', value: 100_000, hint: 'Money at the Reserve Bank. Notice it does not change when the bank lends.' },
    { label: 'Loans', value: OLD_LOANS },
  ];
  const liabilities: BsItem[] = [{ label: 'Deposits', value: OLD_DEP }];
  if (garcia) {
    assets.push({ label: 'Garcias’ mortgage', value: garcia, color: NEW });
    liabilities.push({ label: 'Garcias’ deposit', value: garcia, color: NEW });
  }
  const money = OLD_DEP + garcia;
  const caption: Record<typeof step, Child> = {
    before: ['A small bank: $900K of assets, funded by $820K of deposits and $80K of its owners’ equity. Press ', b('Lend $200K'), '.'],
    lend: [
      'The Garcias borrow $200K for a home. The bank books the loan as an asset and ',
      b('creates a matching $200K deposit'),
      '. Nobody’s savings moved: the money supply just grew by $200K.',
    ],
    repay: [
      'The Garcias repay $50K. Loan and deposit shrink together — ',
      b('$50K of money no longer exists'),
      '. The reserves never moved.',
    ],
  };
  return h(
    'div',
    { class: 'mi-help-demo' },
    h(
      'div',
      { class: 'mi-help-demo-bar' },
      choice({
        small: true,
        value: step,
        options: [
          { id: 'before', label: 'Before' },
          { id: 'lend', label: 'Lend $200K', title: 'The bank makes a mortgage loan' },
          { id: 'repay', label: 'Repay $50K', title: 'The borrower pays some of it back' },
        ],
        onChange: (id) => {
          demo = id === 'lend' ? 'lend' : id === 'repay' ? 'repay' : 'before';
          w.win.rerender();
        },
      }),
      h('span', { class: 'mi-help-demo-money' }, h('span', null, 'Money in town'), lcd(fmtMoney(money), { tone: garcia === 200_000 ? 'good' : garcia ? 'bad' : undefined })),
    ),
    balanceSheet({
      format: (v) => fmtMoney(v),
      assets,
      liabilities,
      equity: [{ label: 'Equity', value: 80_000, hint: 'The owners’ stake.' }],
      shares: false,
    }),
    p(caption[step]),
  );
}

// ---------------------------------------------------------------------------------------------
// Banks page: a real bank's balance sheet and the system's health

function bankSheet(ctx: UIContext, w: WindowCtx): Child {
  const eco = ctx.game.eco;
  const alive = eco.aliveBanks();
  if (!alive.length) return note('There are no banks left in town!', 'bad');
  const bank = alive.find((x) => x.id === shownBank) ?? alive.reduce((a, x) => (x.deposits > a.deposits ? x : a));
  shownBank = bank.id;
  const m = metrics(eco, bank);
  const other = m.interbank + m.reo;
  return [
    h(
      'div',
      { class: 'mi-help-demo-bar' },
      choice({
        small: true,
        value: String(bank.id),
        options: alive.map((x) => ({ id: String(x.id), label: x.short, title: x.name })),
        onChange: (id) => {
          shownBank = Number(id);
          w.win.rerender();
        },
      }),
      button('Open', () => ctx.showAgent(bank.id), { small: true, icon: '🏦', title: `Open ${bank.name}` }),
    ),
    balanceSheet({
      format: (v) => fmtMoney(v),
      titles: [`${bank.short}: what it owns`, 'What it owes + equity'],
      assets: [
        { label: 'Reserves', value: m.reserves, hint: 'Money held at the Reserve Bank, used to settle payments and meet withdrawals.' },
        { label: 'Loans', value: m.loansNet, hint: 'Mortgages, business and consumer loans (after provisions for expected losses).' },
        { label: 'Gov. bonds & bills', value: m.bills + m.bonds, hint: 'Safe, easy-to-sell government debt.' },
        { label: 'Mortgage bonds', value: m.mbs, hint: 'MBS: packaged mortgages bought from other banks.' },
        ...(other > 0 ? [{ label: 'Other', value: other, hint: 'Loans to other banks and repossessed property.' }] : []),
      ],
      liabilities: [
        { label: 'Deposits', value: m.deposits, hint: 'What the bank owes its customers. This is the town’s money.' },
        { label: 'Wholesale funding', value: m.wholesale, hint: 'Short-term loans from investors — the first money to flee in a panic.' },
        { label: 'Reserve Bank loans', value: m.cbLoan, hint: 'Borrowed from you.' },
        { label: 'Bonds issued', value: m.bondsIssued, hint: 'Long-term borrowing from investors.' },
      ],
      equity: [{ label: 'Equity', value: m.equity, hint: 'The owners’ stake: losses eat this first.' }],
    }),
    note(['Assets must always equal liabilities plus equity. When losses push equity below zero, the bank is ', b('insolvent'), '.']),
  ];
}

function healthGauges(eco: Economy): HTMLElement {
  let equity = 0;
  let rwa = 0;
  let liquid = 0;
  let deposits = 0;
  for (const bk of eco.aliveBanks()) {
    const m = metrics(eco, bk);
    equity += m.equity;
    rwa += m.rwa;
    liquid += m.liquid;
    deposits += m.deposits;
  }
  const pol = eco.policy;
  const cap = rwa > 0 ? equity / rwa : 0;
  const liq = deposits > 0 ? liquid / deposits : 0;
  return h(
    'div',
    { class: 'mi-help-gauges' },
    gauge({
      label: 'Capital ratio — all banks',
      value: cap,
      min: 0,
      max: Math.max(0.25, pol.capitalRequirement * 2.2),
      format: (v) => pct(v, 1),
      marks: [{ at: pol.capitalRequirement, label: `Min ${pctRule(pol.capitalRequirement)}`, color: '#ff6a55' }],
      dangerBelow: pol.capitalRequirement,
      warnBelow: pol.capitalRequirement + 0.02,
      tip: 'Equity ÷ risk-weighted loans.',
    }),
    gauge({
      label: 'Liquidity — all banks',
      value: liq,
      min: 0,
      max: Math.max(0.6, pol.liquidityRequirement * 2.5),
      format: (v) => pct(v, 0),
      marks: [{ at: pol.liquidityRequirement, label: `Min ${pctRule(pol.liquidityRequirement)}`, color: '#ff6a55' }],
      dangerBelow: pol.liquidityRequirement,
      warnBelow: pol.liquidityRequirement * 1.3,
      tip: 'Reserves and government securities ÷ deposits.',
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Cycles page: live warning lights

function warningLights(eco: Economy): HTMLElement {
  const st = eco.stats;
  const year = st.length > 12;
  const L = (k: Parameters<typeof st.last>[0]) => (st.length ? st.last(k) : NaN);
  const alive = eco.aliveBanks();
  const fear = alive.length ? alive.reduce((a, x) => a + x.fear, 0) / alive.length : NaN;
  const light = (tone: Tone | null, word: string) => badge(word, tone ?? 'good');
  const row = (label: string, value: string, tone: Tone | null, word: string, hint: string): KvRow => [
    label,
    h('span', { class: 'mi-help-light' }, value, light(tone, word)),
    { hint },
  ];
  const cg = year ? L('creditGrowth') : NaN;
  const hg = year ? L('hpiGrowth') : NaN;
  const npl = L('npl');
  const infl = L('inflation');
  const u = eco.market.unemployment;
  const na = (v: number) => !Number.isFinite(v);
  return h(
    'div',
    null,
    kv([
      row(
        'Credit growth (12 mo)',
        na(cg) ? '—' : pct(cg),
        na(cg) ? 'muted' : cg > 0.2 ? 'bad' : cg > 0.12 || cg < 0 ? 'warn' : null,
        na(cg) ? 'Wait' : cg > 0.2 ? 'Frenzy' : cg > 0.12 ? 'Hot' : cg < 0 ? 'Shrinking' : 'OK',
        'Loans growing much faster than incomes are the classic sign of a boom that will end badly.',
      ),
      row(
        'House prices (12 mo)',
        na(hg) ? '—' : pct(hg),
        na(hg) ? 'muted' : hg > 0.18 || hg < -0.05 ? 'bad' : hg > 0.1 || hg < 0 ? 'warn' : null,
        na(hg) ? 'Wait' : hg > 0.18 ? 'Bubble?' : hg > 0.1 ? 'Hot' : hg < -0.05 ? 'Slump' : hg < 0 ? 'Falling' : 'OK',
        'Fast-rising prices pull in speculators and bigger mortgages.',
      ),
      row(
        'Bad loans',
        pct(npl),
        na(npl) ? 'muted' : npl > 0.06 ? 'bad' : npl > 0.03 ? 'warn' : null,
        na(npl) ? 'Wait' : npl > 0.06 ? 'Danger' : npl > 0.03 ? 'Watch' : 'OK',
        'Loans 90+ days behind. Losses here eat bank capital.',
      ),
      row(
        'Bank fear',
        na(fear) ? '—' : String(Math.round(fear * 100)),
        na(fear) ? 'muted' : fear > 0.75 ? 'bad' : fear > 0.5 ? 'warn' : null,
        na(fear) ? '—' : fear > 0.75 ? 'Panic' : fear > 0.5 ? 'Nervous' : 'Calm',
        'Frightened banks lend less — which can turn a slowdown into a slump.',
      ),
      row(
        'Inflation',
        pct(infl),
        na(infl) ? 'muted' : infl > 0.07 || infl < -0.005 ? 'bad' : infl > 0.04 || infl < 0.005 ? 'warn' : null,
        na(infl) ? 'Wait' : infl > 0.07 ? 'High' : infl > 0.04 ? 'Rising' : infl < 0 ? 'Deflation' : infl < 0.005 ? 'Low' : 'OK',
        'Prices vs a year ago. Spending racing ahead of what shops can supply pushes it up.',
      ),
      row(
        'Unemployment',
        pct(u),
        u > 0.1 ? 'bad' : u > 0.07 ? 'warn' : null,
        u > 0.1 ? 'Slump' : u > 0.07 ? 'Weak' : 'OK',
        'Share of workers without a job.',
      ),
    ]),
    year ? null : note('Growth rates need a year of history — check back later.'),
  );
}

// ---------------------------------------------------------------------------------------------
// Colours page: coins, bursts, balloons, signs and captions drawn with the game's own sprites

const COIN_ORDER: CoinKind[] = ['new', 'destroy', 'spend', 'wage', 'income', 'public', 'property', 'market', 'bank'];

const BALLOONS: [IconKind, Child][] = [
  ['warning', [b('Trouble'), ' — a bank under stress or living on emergency loans, a struggling business, or a stalled building site.']],
  ['alarm', [b('Bank run!'), ' — depositors are queuing to pull their money out.']],
  ['lock', [b('Failed bank'), ' — closed by the regulator; its accounts went to another bank.']],
  ['hammer', [b('Building'), ' — construction or an expansion is under way.']],
  ['zzz', [b('Closed'), ' — a business that shut down recently.']],
];

const SIGNS: [PropKind, Child][] = [
  ['sign_forsale', 'Home for sale'],
  ['sign_sold', 'Just sold'],
  ['sign_foreclosed', [b('Repossessed'), ' by a bank after the owners defaulted']],
  ['sign_forrent', 'Home to rent'],
  ['sign_hiring', 'Hiring'],
  ['sign_sale', 'Shop sale — discounting to clear stock'],
];

const CAPTIONS: [string, string, string][] = [
  ['+$50K LOAN', '#63ff7e', 'New money lent into existence'],
  ['DEFAULT $12K', '#ff5a4a', 'A borrower stopped paying'],
  ['FORECLOSED', '#ff7a4a', 'A bank took back a home'],
  ['SOLD $210K', '#ff9ad0', 'A home changed hands'],
  ['GRAND OPENING!', '#ffd23c', 'A new business opens'],
  ['PACKAGED $400K', '#3cd2b4', 'Mortgages bundled into bonds'],
  ['BANK RUN!', '#ff4040', 'Depositors are fleeing a bank'],
];

function toggleFlows(ctx: UIContext, w: WindowCtx): void {
  ctx.game.showFlows = !ctx.game.showFlows;
  w.win.rerender();
}

/** Live "how much is flying" meters next to each coin colour. */
function patchActivity(ctx: UIContext, body: HTMLElement): void {
  const act = ctx.renderer.effects?.activity as Partial<Record<CoinKind, number>> | undefined;
  if (!act) return;
  let max = 1;
  for (const k of COIN_ORDER) max = Math.max(max, act[k] ?? 0);
  for (const el of body.querySelectorAll<HTMLElement>('.mi-help-coin')) {
    const k = el.dataset.coin as CoinKind | undefined;
    const bar = el.querySelector<HTMLElement>('.mi-help-meter > i');
    if (!k || !bar) continue;
    const v = ctx.game.showFlows ? Math.round(((act[k] ?? 0) / max) * 100) : 0;
    const wv = `${v}%`;
    if (bar.style.width !== wv) bar.style.width = wv;
  }
}

function pixelCanvas(w: number, hh: number, scale: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D | null } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hh;
  c.className = 'mi-help-px';
  c.style.width = `${w * scale}px`;
  c.style.height = `${hh * scale}px`;
  const g = c.getContext('2d');
  if (g) g.imageSmoothingEnabled = false;
  return { c, g };
}

/** A coin exactly as the renderer draws it (size 2). */
function coinCanvas(k: CoinKind): HTMLCanvasElement {
  const { c, g } = pixelCanvas(9, 9, 2);
  if (g) {
    const s = 3;
    const x = 4;
    const y = 4;
    g.fillStyle = 'rgba(12,14,22,0.85)';
    g.fillRect(x - s, y - s, s * 2 + 1, s * 2 + 1);
    g.fillStyle = COIN_COLOURS[k];
    g.fillRect(x - s + 1, y - s + 1, s * 2 - 1, s * 2 - 1);
    if (k === 'new') {
      g.fillStyle = '#ffffff';
      g.fillRect(x, y - s, 1, 1);
    }
  }
  return c;
}

/** A frozen frame of the "money created" sparkle / "money destroyed" puff. */
function burstCanvas(kind: 'create' | 'destroy'): HTMLCanvasElement {
  const { c, g } = pixelCanvas(28, 22, 2);
  if (!g) return c;
  g.fillStyle = '#10232a';
  g.fillRect(0, 0, 28, 22);
  const x = 14;
  const y = 12;
  const t = 0.32;
  const k = t / 0.9;
  if (kind === 'create') {
    const r = (4 + 10 * k) * 1.2;
    g.fillStyle = '#b8ffc4';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + t;
      g.fillRect(Math.round(x + Math.cos(a) * r), Math.round(y + Math.sin(a) * r * 0.6), 2, 2);
    }
    g.fillStyle = COIN_COLOURS.new;
    g.fillRect(x - 1, Math.round(y - r * 0.5), 3, 3);
  } else {
    const r = (4 + 10 * k) * 1.6;
    g.fillStyle = '#8a8a96';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      g.fillRect(Math.round(x + Math.cos(a) * r * 0.6), Math.round(y + Math.sin(a) * r * 0.4 - r * 0.5 + 6), 3, 3);
    }
    g.fillStyle = COIN_COLOURS.destroy;
    g.fillRect(x - 1, y + 5, 2, 2);
  }
  return c;
}

/**
 * Copy a sprite canvas, cropped to its visible pixels and scaled up crisply by the largest whole
 * number (1–3) that fits a maxW x maxH box.
 */
function cropSprite(src: HTMLCanvasElement, maxW: number, maxH: number): HTMLCanvasElement {
  const sw = src.width;
  const sh = src.height;
  let x0 = 0;
  let y0 = 0;
  let x1 = sw;
  let y1 = sh;
  const sg = src.getContext('2d', { willReadFrequently: true });
  if (sg && sw && sh) {
    const d = sg.getImageData(0, 0, sw, sh).data;
    x0 = sw;
    y0 = sh;
    x1 = -1;
    y1 = -1;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (d[(y * sw + x) * 4 + 3] === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < x0) {
      x0 = 0;
      y0 = 0;
      x1 = sw - 1;
      y1 = sh - 1;
    }
    x1++;
    y1++;
  }
  const w = Math.max(1, x1 - x0);
  const hh = Math.max(1, y1 - y0);
  const scale = Math.max(1, Math.min(3, Math.floor(Math.min(maxW / w, maxH / hh))));
  const { c, g } = pixelCanvas(w, hh, scale);
  g?.drawImage(src, x0, y0, w, hh, 0, 0, w, hh);
  return c;
}

function safeSprite(get: () => HTMLCanvasElement): Node {
  try {
    return cropSprite(get(), 52, 40);
  } catch {
    return h('span', { class: 'mi-help-missing' }, '?');
  }
}

function spriteRows(rows: [Node, Child][]): HTMLElement {
  return h(
    'div',
    { class: 'mi-help-sprites' },
    rows.map(([sprite, text]) => h('div', { class: 'mi-help-sprite' }, h('span', { class: 'mi-help-sprite-box' }, sprite), h('span', null, text))),
  );
}

function safeCaption(text: string, color: string): Node {
  try {
    const m = measurePixelText(text, 1);
    const { c, g } = pixelCanvas(m.w + 6, m.h + 6, 2);
    if (g) {
      g.fillStyle = 'rgba(12,14,22,0.85)';
      g.fillRect(0, 0, c.width, c.height);
      drawPixelText(g, text, 3, 3, color, { shadow: '#000000' });
    }
    return c;
  } catch {
    return h('span', { class: 'mi-help-caption-text', style: { color } }, text);
  }
}

// ---------------------------------------------------------------------------------------------
// Styles (injected once)

const STYLE_ID = 'mi-help-style';

function injectStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
.mi-help-win .mi-win-body {
  line-height: 1.45;
}
.mi-help-p {
  margin: 0 0 6px;
  font-size: 12px;
  line-height: 1.45;
}
.mi-help-win .mi-section + .mi-section {
  margin-top: 12px;
}
.mi-help-hero {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0 0 12px;
  padding: 8px 10px;
  background: rgba(216, 200, 160, 0.42);
  border: 1px solid;
  border-color: var(--mi-paper-lo) var(--mi-paper-hi) var(--mi-paper-hi) var(--mi-paper-lo);
}
.mi-help-hero p {
  margin: 0;
  font-size: 12.5px;
}
.mi-help-hero > .mi-icon {
  flex: none;
  margin-top: 2px;
}
.mi-help-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.mi-help-list li {
  position: relative;
  margin: 0 0 4px;
  padding-left: 13px;
}
.mi-help-list li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 6px;
  width: 5px;
  height: 5px;
  background: var(--mi-brass);
  box-shadow: 0 0 0 1px var(--mi-brass-lo);
}
.mi-help-keys {
  display: grid;
  grid-template-columns: max-content 1fr;
  align-items: center;
  gap: 5px 12px;
}
.mi-help-keycaps {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 3px;
}
.mi-help-key {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 18px;
  padding: 0 5px;
  font: 700 11px/1 var(--mi-font-ui);
  color: var(--mi-ink);
  background: linear-gradient(180deg, #fbf4df 0%, var(--mi-key) 55%, var(--mi-key-2) 100%);
  border: 1px solid var(--mi-key-edge);
  border-bottom-width: 2px;
  box-shadow: inset 1px 1px 0 var(--mi-key-hi);
  clip-path: var(--mi-notch);
}
.mi-help-irows,
.mi-help-sprites {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.mi-help-irow,
.mi-help-sprite {
  display: flex;
  align-items: center;
  gap: 9px;
}
.mi-help-ibox {
  flex: none;
  display: grid;
  place-items: center;
  min-width: 22px;
}
.mi-help-sprite-box {
  flex: none;
  display: grid;
  place-items: center;
  width: 58px;
  min-height: 34px;
  padding: 3px;
  background: #5f9e4f;
  border: 1px solid;
  border-color: var(--mi-paper-lo) var(--mi-paper-hi) var(--mi-paper-hi) var(--mi-paper-lo);
  box-shadow: inset 1px 1px 0 rgba(0, 0, 0, 0.25);
}
.mi-help-px {
  display: block;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}
.mi-help-missing {
  font: 700 14px/1 var(--mi-font-ui);
  color: var(--mi-ink-3);
}
.mi-help-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.mi-help-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  padding: 7px 8px;
  background: var(--mi-paper-hi);
  border: 1px solid var(--mi-rule-2);
  box-shadow: 2px 2px 0 rgba(120, 96, 50, 0.18);
}
.mi-help-card .mi-help-p {
  margin: 0;
}
.mi-help-gauges {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.mi-help-demo {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}
.mi-help-demo-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 6px;
}
.mi-help-demo .mi-help-demo-bar {
  margin-bottom: 0;
}
.mi-help-demo-money {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 8px/1 var(--mi-font-pixel);
  text-transform: uppercase;
  color: var(--mi-ink-2);
  -webkit-font-smoothing: none;
}
.mi-help-demo-money .mi-lcd {
  font-size: 13px;
  height: 20px;
}
.mi-help-demo .mi-help-p {
  min-height: 3.4em;
  margin: 0;
}
.mi-help-loop {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 26px minmax(0, 1fr);
  grid-template-rows: auto 26px auto;
  align-items: center;
  justify-items: center;
  margin: 2px 0 4px;
}
.mi-help-loop-box {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 38px;
  padding: 5px 8px;
  font-size: 11.5px;
  font-weight: 700;
  line-height: 1.25;
  background: linear-gradient(180deg, #f6eed8 0%, var(--mi-key) 100%);
  border: 1px solid var(--mi-key-edge);
  box-shadow:
    inset 1px 1px 0 var(--mi-key-hi),
    inset -1px -1px 0 var(--mi-key-lo),
    2px 2px 0 rgba(60, 40, 10, 0.15);
  clip-path: var(--mi-notch);
}
.mi-help-loop-box > .mi-icon {
  flex: none;
}
.mi-help-loop-arrow {
  display: grid;
  place-items: center;
  color: var(--mi-ink-2);
}
.mi-help-loop.is-boom .mi-help-loop-arrow {
  color: #2f7d3a;
}
.mi-help-loop.is-bust .mi-help-loop-arrow {
  color: var(--mi-bad);
}
.mi-help-loop-hub {
  font: 8px/1 var(--mi-font-pixel);
  letter-spacing: 1px;
  color: var(--mi-ink-3);
  -webkit-font-smoothing: none;
}
.mi-help-aside {
  font: 8px/1 var(--mi-font-pixel);
  text-transform: uppercase;
  color: var(--mi-ink-3);
  -webkit-font-smoothing: none;
}
.mi-help-light {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.mi-help-light .mi-badge {
  min-width: 54px;
  justify-content: center;
}
.mi-help-coins {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px 14px;
}
.mi-help-coin {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 40px;
  align-items: center;
  gap: 7px;
  min-height: 20px;
}
.mi-help-coin-label {
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.2;
}
.mi-help-meter {
  height: 6px;
  background: var(--mi-screen);
  border: 1px solid;
  border-color: var(--mi-paper-lo) var(--mi-paper-hi) var(--mi-paper-hi) var(--mi-paper-lo);
}
.mi-help-meter > i {
  display: block;
  height: 100%;
  background: var(--mi-brass);
  transition: width 0.25s steps(3, end);
}
.mi-help-coin[data-coin='new'] .mi-help-meter > i { background: ${COIN_COLOURS.new}; }
.mi-help-coin[data-coin='destroy'] .mi-help-meter > i { background: ${COIN_COLOURS.destroy}; }
.mi-help-captions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 14px;
}
.mi-help-caption {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  font-size: 11px;
  color: var(--mi-ink-2);
}
.mi-help-caption-text {
  padding: 2px 4px;
  font: 8px/1 var(--mi-font-pixel);
  background: #10181c;
}
@media (max-width: 719px) {
  .mi-help-cards,
  .mi-help-coins,
  .mi-help-captions {
    grid-template-columns: 1fr;
  }
}
@media (prefers-reduced-motion: reduce) {
  .mi-help-meter > i {
    transition: none;
  }
}
`;
  document.head.appendChild(el);
}
