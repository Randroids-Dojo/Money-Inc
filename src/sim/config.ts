// Tunable parameters. Everything the calibration touches lives here.

import type { Sector } from './types';

export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR;

export interface SectorParams {
  /** units of output per worker per month (for builders: $ of construction work) */
  A: number;
  /** real capital per unit of monthly capacity */
  kappa: number;
  /** normal markup over unit cost */
  markup: number;
  /** factory goods needed per unit sold (retail) or per $ of construction (builders) */
  inputShare: number;
  /** typical workforce of a new firm */
  startWorkers: number;
  /** share of household spending (retail/service only) */
  demandShare: number;
}

export const SECTORS: Record<Sector, SectorParams> = {
  retail: { A: 12000, kappa: 6, markup: 0.1, inputShare: 0.45, startWorkers: 3, demandShare: 0.55 },
  service: { A: 6000, kappa: 11, markup: 0.12, inputShare: 0, startWorkers: 3, demandShare: 0.45 },
  factory: { A: 6400, kappa: 14, markup: 0.15, inputShare: 0, startWorkers: 6, demandShare: 0 },
  builder: { A: 8800, kappa: 2.5, markup: 0.12, inputShare: 0.3, startWorkers: 4, demandShare: 0 },
};

export const CFG = {
  // ---------------- households ----------------
  initialHouseholds: 180,
  /** spare homes at the start, relative to households */
  initialVacancy: 0.04,
  baseWage: 4000,
  essentials: 1250, // monthly essential consumption at CPI = 1
  taxRate: 0.18, // flat tax on wages
  dividendTax: 0.2, // withheld on dividends and fund distributions
  benefitRatio: 0.42, // unemployment benefit as share of average wage
  pensionRatio: 0.5, // public pension as share of average wage
  mpcRange: [0.9, 0.97] as [number, number],
  bufferRange: [2.5, 9] as [number, number], // months of income held as deposits
  wealthSpend: 0.03, // monthly spend-down of deposits above the buffer
  rebuildRate: 0.07, // monthly pull-back when below the buffer
  homeEquityMpc: 0.0012, // monthly consumption out of home equity
  renovationRate: 0.0008, // monthly home maintenance spend as share of home value
  fundInvestShare: 0.15, // share of surplus deposits moved into the fund each month
  fundWealthMpc: 0.0025, // monthly consumption out of fund savings
  ownershipDrive: 0.045, // monthly chance an eligible renter starts house hunting
  speculatorShare: 0.18, // share of households with speculative streak
  relocationRate: 0.012, // monthly chance an owner sells for life reasons

  // ---------------- firms ----------------
  depreciation: 0.075, // annual
  productivityGrowth: 0.012, // annual labour productivity growth (better tools and methods)
  targetUtilization: 0.85,
  priceAdjust: 0.035, // price response to demand pressure
  maxPriceStep: 0.02, // max monthly price change from demand
  costPull: 0.12, // monthly pull of price toward cost-plus target
  wageAdjust: 0.45, // wage response to the unemployment gap (annual)
  naturalUnemployment: 0.06,
  cashBufferMonths: 1.2, // firms keep this many months of costs as cash
  payoutShare: 0.5, // share of excess cash paid to owners
  expansionHurdle: 0.04, // required return above borrowing cost
  entryBase: 0.06, // monthly base chance of a new firm per sector
  startupEquityShare: 0.3,

  // ---------------- housing ----------------
  houseBaseValue: 185_000,
  aptUnitBaseValue: 125_000,
  houseBaseRent: 1_050,
  aptBaseRent: 800,
  devCostRatio: 0.92, // construction cost of a unit relative to its base value (at price 1)
  devMargin: 0.18, // required margin to start speculative building
  mortgageTerm: 300,
  foreclosureRecovery: 0.78, // foreclosed sale value relative to market value

  // ---------------- banks ----------------
  rwMortgage: 0.5,
  opexPerAsset: 0.0035, // annual non-staff opex as share of assets
  depositInsurancePremium: 0.0008, // annual, on deposits
  servicingFee: 0.0025,
  mbsDuration: 4,
  bondDuration: 7,
  bondYears: 10,
  resolutionThreshold: 0.02, // capital ratio at which a bank is closed
  runSensitivity: 1.0,

  // ---------------- public sector ----------------

  // ---------------- public sector ----------------
  surplusRecycling: 0.1, // share of the Treasury's spare cash spent on public works each month
  stabiliser: 0.8, // extra public spending per point of unemployment above normal (share of GDP)
  structuralDeficit: 0.015, // public works spending beyond tax revenue, as share of GDP

  // ---------------- policy defaults ----------------
  policyRate: 0.03,
  capitalRequirement: 0.08,
  liquidityRequirement: 0.1,
  inflationTarget: 0.02,
};

export const START_YEAR = 1;
