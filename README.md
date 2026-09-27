# Money Inc.

**An isometric management game about banks, credit and crises — where every dollar has a history.**

Money Inc. looks and plays like a classic 90s management sim. You look down on a small
pixel-art town: shops, factories, apartment blocks, four commercial banks, an investment fund,
City Hall and the Reserve Bank. Underneath it runs a banking-economy simulation, and the
town's life is how you see that simulation.

- Banks **create money when they lend**. A loan puts new deposits in the borrower's account.
  Green coins burst from the bank.
- That money gets **spent**, becomes someone else's deposit, and flows between banks.
- Repaying a loan **destroys the money**. Red coins fly back to the bank and vanish.
- Firms borrow to open, expand and hire. Households borrow to buy homes. Builders borrow to
  develop apartments. You can see each of these in the city as it happens.
- Banks manage their own balance sheets. They set standards, price risk, securitise
  mortgages, sell loans, borrow wholesale, raise capital and hoard liquidity. They also grow
  bold in good times and fearful after losses.
- Booms, bubbles, credit crunches, bank runs and failures come out of these interactions.
  **None of them are scripted.**

You play as the **Reserve Bank**. You set the policy rate, the capital and liquidity rules,
deposit insurance, emergency lending and asset purchases (QE). Then you watch the city react.
Public **approval** (a letter grade in the status bar) tracks your mandate: about 2%
inflation, plenty of jobs and no bank failures. An advisor explains each new phenomenon the
first time it happens: new money, securitisation, a default, a run.

## Playing

```bash
npm install
npm run dev        # open the printed URL
```

| | |
|---|---|
| **Click** anything | Opens its window: a bank's balance sheet, a business's story, a family's finances, a construction site, a loan's full trail |
| **Drag** / arrows / WASD | Pan the map |
| **Wheel** / `+` `-` | Zoom |
| `Space`, `1`–`4` | Pause, then speeds 1×, 2×, 5×, 10× |
| `B` | Reserve Bank controls |
| `G` / `N` / `H` | Statistics, news, how it works |
| `L` | Cycle data lenses: bank market share, debt and arrears, money origin, property values, jobs |
| `F` | Toggle the money-flow overlay |
| `K` / `J` / `T` | Genesis Mode: your desk, the town journal, trace mode |
| `Esc` | Close the top window |

The bottom strip shows the date, the speed controls, a news ticker and key indicators: money
supply, credit, inflation, unemployment, house prices and the policy rate. Crisis alerts pop
up at the top of the screen.

### Things to try

- Watch the first year. Coins show new loans. When a firm's capacity is full it borrows to
  expand, and scaffolding goes up. House prices climb while mortgage credit flows.
- Open a business and click one of its loans. **"Follow the Money"** tells you which bank
  created the money, where it was spent first and how much is repaid (destroyed). It also
  shows who holds the loan now (perhaps an MBS pool owned by the fund) and who absorbed the
  loss if it went bad.
- Switch on the **Origin** lens to see which bank created the money in each building.
- Cut the policy rate to 0% and lower the capital requirement. Then raise the rate to 10%.
- Start a **No Safety Net** city (no deposit insurance, no lender of last resort) and wait
  for a run. People queue outside the bank.

## Genesis Mode

Pick **Genesis** on the title screen to start from almost nothing: one bank (Genesis Bank),
one would-be business, one person looking for work, a few cottages — and not a single dollar
of bank money. The world waits for the first economic event: the first loan.

- **You make the key decisions; the town does the rest.** Early on every loan comes to your
  desk (`K`) with its business plan or home purchase, the terms you can change (size, rate,
  term, security) and what it would do to the bank. Later the banks decide routine loans under
  your **lending rules** (Reserve Bank → *Lending rules*), and you are called for the big
  moments: missed payments, a bank at its limits, a run, a failing bank, a new bank's licence.
  Nothing says which choice is right. Each option says what it does, and the simulation plays
  it out.
- **The first loan** shows both balance sheets: +$100K loan and +$100K deposit for the bank,
  +$100K deposit and +$100K loan for the business, and money in town going from $0 to $100K.
  After that, the town's firsts (first employee, paycheck, repayment, mortgage, default,
  second bank...) are marked with banners that fade as the town grows.
- **Trace mode** (`T`) dims the town and lights up what anything is connected to: direct
  relationships in gold, what followed further on in blue, where it came from in teal. Click a
  lit building to see the chain, or anything else to trace from there. Relationships are
  recorded, not individual dollars, and "downstream" means connected, not caused.
- **The town journal** (`J`) keeps every decision you made, what changed after it, the
  town's firsts, and the life of the first bank: what it financed, what became of its loans,
  and who took over its book if it failed. Genesis Bank has no plot armour.
- **The money ledger** in the corner: money in town, lent into existence, still owed,
  repaid (destroyed), paid as interest, written off. The "other ways" section adds banks' own
  spending, City Hall and trade with the region, and the total balances to the dollar.

The town is a small open economy. It sells to the region and buys from it. Newcomers arrive
for jobs and board with families until homes are built: by families with mortgages, by
employers for their workers, or by builders to sell. Money spent across the river drains the
town's bank of reserves. That is why a small bank can run short of cash long before it runs
short of capital.

```bash
npx tsx scripts/genesis.ts --seed 3 --years 20 --player bank --check   # headless Genesis run
# player: bank (go along with the banks), yes (approve all), big, small, no
```

Add `?scenario=genesis` to the URL to skip the title screen.

## How the simulation works

`src/sim/` is a headless, deterministic, stock-flow-consistent model. It can run in Node
without the game.

- **Ledger** (`ledger.ts`). Deposits are bank liabilities and reserves are central-bank
  liabilities. Every payment is a matched set of entries. Payments between banks settle in
  reserves. Every account carries a **provenance vector** that records how much of its
  balance each bank created, how much came from public spending and how much predates the
  game.
- **Banks** (`bank.ts`, `banking.ts`). Each bank has a full balance sheet:
  - Assets: reserves, business, mortgage, consumer and development loans, bills, bonds, MBS,
    interbank loans and repossessed property.
  - Liabilities: deposits, wholesale funding, Reserve Bank loans and bonds.
  - Equity: paid-in capital, retained earnings and mark-to-market changes.

  Banks underwrite loans (PD, LTV, DTI, DSCR), price them and set lending budgets. They
  provision and write off bad loans. They securitise, sell loans, raise capital, issue
  bonds, manage liquidity daily and pay dividends. Fear rises quickly after losses and fades
  slowly (disaster myopia). There is no money multiplier: capital and willingness to lend
  constrain lending, not reserves.
- **Failure and resolution** (`resolution.ts`). A bank fails through insolvency (losses wipe
  out its capital) or illiquidity (a run, or wholesale funders refuse to roll over). The
  resolution uses deposit insurance or bail-in, and another bank takes over the failed
  one's book. New banks get chartered when the market is thin.
- **Firms** (`firms.ts`). Firms have capacity set by labour and capital, cost-plus pricing
  that responds to demand, wages that respond to unemployment, inventories and investment.
  They borrow to start up, expand or cover payroll. They go into distress, close and default.
- **Households** (`households.ts`, `housing.ts`). Households work, consume out of income
  and wealth, and save in deposits or the fund. They rent or buy homes and speculate on
  property. They borrow, fall behind, default and get foreclosed on. They move in and out
  of town.
- **Markets** (`markets.ts`). Markets clear goods, labour, housing, government debt and MBS.
  The house price index comes from actual transactions, and expectations extrapolate recent
  price moves but are anchored by rents.
- **Public sector** (`publicSector.ts`, `fund.ts`). City Hall taxes, employs, pays benefits
  and pensions, and borrows. The Reserve Bank runs policy and QE. Meridian Capital is the
  households' savings fund: it owns the banks, buys MBS and cheap homes, and lends wholesale.

Useful scripts:

```bash
npm test                                  # invariants: books balance, loans create money, determinism
npx tsx scripts/simulate.ts --years 12 --seed 2 --every 6    # headless run with a monthly table
npx tsx scripts/sweep.ts 10               # multi-seed calibration summary
npx tsx scripts/debugBooks.ts 1 2000      # checks the accounting after every phase of every day
```

## Project layout

```
src/sim/      simulation (no DOM)            src/render/sprites/  procedural pixel-art sprites
src/world/    city layout generator          src/render/          isometric renderer, traffic, effects
src/game/     game shell + windows (UI)      src/ui/              window/widget toolkit ("Brass & Ledger")
scripts/      headless runners               tests/               vitest invariant tests
```

All art is drawn in code. There are no external assets.
