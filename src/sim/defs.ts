/**
 * Data-driven content definitions (blueprints). No gameplay logic lives here.
 *
 * Two distinct material systems:
 *
 * - **Bulk resources** are solids dug out of the ground, carried by rovers and
 *   stockpiled in warehouses. They are the *construction* economy.
 * - **Fluids** (water, oxygen, food) are life-support commodities. They never
 *   ride on a rover; they live in tanks provided by buildings and move through
 *   processes. They are the *survival* economy.
 *
 * The bridge between the two is the Water Extractor: it eats bulk `ice` and
 * emits fluid `water`.
 */

import type { PowerTier } from './config';

// ------------------------------------------------------- bulk resources ----

export type ResourceId = 'regolith' | 'iron' | 'silicon' | 'aluminum' | 'ice';

export const ALL_RESOURCES: ResourceId[] = [
  'regolith',
  'iron',
  'silicon',
  'aluminum',
  'ice',
];

export type ResourceAmounts = Record<ResourceId, number>;

export function emptyAmounts(): ResourceAmounts {
  return { regolith: 0, iron: 0, silicon: 0, aluminum: 0, ice: 0 };
}

export interface ResourceInfo {
  id: ResourceId;
  label: string;
  short: string;
  color: number; // hex color used by renderer (mound + chip)
  /** kg mined per game second by a standard mining tool. */
  mineRateKg: number;
  description: string;
}

export const RESOURCES: Record<ResourceId, ResourceInfo> = {
  regolith: {
    id: 'regolith',
    label: 'Regolith',
    short: 'Reg',
    color: 0xb07850,
    mineRateKg: 12,
    description: 'Loose soil. Used for construction, foundations and shielding.',
  },
  iron: {
    id: 'iron',
    label: 'Iron Ore',
    short: 'Fe',
    color: 0x8a8677,
    mineRateKg: 5,
    description: 'Crushed and smelted into steel for structures and machinery.',
  },
  silicon: {
    id: 'silicon',
    label: 'Silica',
    short: 'Si',
    color: 0xc7cfd6,
    mineRateKg: 4,
    description: 'Refined into glass and silicon for panels and electronics.',
  },
  aluminum: {
    id: 'aluminum',
    label: 'Aluminum Ore',
    short: 'Al',
    color: 0xa9b7bd,
    mineRateKg: 3.5,
    description: 'Light structural metal for frames, hulls and solar trusses.',
  },
  ice: {
    id: 'ice',
    label: 'Water Ice',
    short: 'Ice',
    color: 0x5f9fd0,
    mineRateKg: 3,
    description:
      'Buried ice. Feed it to a Water Extractor to turn it into liquid water — and from there, oxygen and crops.',
  },
};

// -------------------------------------------------------------- fluids ----

export type FluidId = 'water' | 'oxygen' | 'food';

export const ALL_FLUIDS: FluidId[] = ['water', 'oxygen', 'food'];

export type FluidAmounts = Record<FluidId, number>;

export function emptyFluids(): FluidAmounts {
  return { water: 0, oxygen: 0, food: 0 };
}

export interface FluidInfo {
  id: FluidId;
  label: string;
  unit: string;
  color: number;
  cssColor: string;
  description: string;
}

export const FLUIDS: Record<FluidId, FluidInfo> = {
  water: {
    id: 'water',
    label: 'Water',
    unit: 'kg',
    color: 0x4aa3e0,
    cssColor: '#4aa3e0',
    description:
      'Potable water. Drunk by the crew, split into oxygen, and drunk again by the crops.',
  },
  oxygen: {
    id: 'oxygen',
    label: 'Oxygen',
    unit: 'kg',
    color: 0x7fd9c8,
    cssColor: '#7fd9c8',
    description: 'Breathable O₂, electrolysed from water. Without it you have minutes, not sols.',
  },
  food: {
    id: 'food',
    label: 'Food',
    unit: 'kg',
    color: 0x8fce5a,
    cssColor: '#8fce5a',
    description: 'Rations and greenhouse produce. Runs out slowly, then all at once.',
  },
};

// -------------------------------------------------------------- rovers ----

export type RoverKind = 'mining' | 'utility';

export interface RoverDef {
  kind: RoverKind;
  label: string;
  role: string;
  maxBatteryKWh: number;
  capacityKg: number;
  cruiseSpeed: number; // world units / game second
  turnRate: number; // rad/s
  movePowerKw: number;
  workPowerKw: number;
  /** Multiplier on resource.mineRateKg applied by this rover's tool. */
  mineSpeedMul: number;
  /** Construction work output relative to baseline (1.0). */
  buildPower: number;
  bodyColor: number;
  accentColor: number;
  radius: number; // visual / arrival radius
}

export const ROVERS: Record<RoverKind, RoverDef> = {
  mining: {
    kind: 'mining',
    label: 'Mining Rover',
    role: 'Drilling / extraction',
    maxBatteryKWh: 80,
    capacityKg: 1500,
    cruiseSpeed: 11,
    turnRate: 1.4,
    movePowerKw: 9,
    workPowerKw: 10,
    mineSpeedMul: 1.5,
    buildPower: 0.6,
    bodyColor: 0xe07b3a,
    accentColor: 0x2b2117,
    radius: 3,
  },
  utility: {
    kind: 'utility',
    label: 'Utility Rover',
    role: 'General work / building',
    maxBatteryKWh: 40,
    capacityKg: 500,
    cruiseSpeed: 14,
    turnRate: 1.8,
    movePowerKw: 6,
    workPowerKw: 7,
    mineSpeedMul: 0.6,
    buildPower: 1.6,
    bodyColor: 0x2f7fb0,
    accentColor: 0x1c2530,
    radius: 2.4,
  },
};

// ------------------------------------------------------------ buildings ----

export type BuildingKind =
  | 'habitat'
  | 'solar'
  | 'battery'
  | 'warehouse'
  | 'workshop'
  | 'extractor'
  | 'oxygenator'
  | 'greenhouse'
  | 'rtg';

/**
 * A continuous conversion run by an online, powered building.
 * All rates are **per Mars hour** so they read like engineering figures.
 */
export interface ProcessDef {
  /** Bulk solids consumed per hour at full rate. */
  solidIn?: Partial<Record<ResourceId, number>>;
  /** Fluids consumed per hour at full rate. */
  fluidIn?: Partial<Record<FluidId, number>>;
  /** Fluids produced per hour at full rate. */
  fluidOut?: Partial<Record<FluidId, number>>;
  /** If true the process also scales with available sunlight (greenhouses). */
  needsLight?: boolean;
  /** Short line shown in the inspector. */
  summary: string;
}

export interface BuildingDef {
  kind: BuildingKind;
  label: string;
  description: string;
  radius: number; // footprint (build clearance) in world units
  cost: ResourceAmounts;
  buildTime: number; // game seconds at buildPower 1.0
  /** Electrical load when running (kW). */
  powerDrawKw: number;
  /** Load when online but idle / throttled to zero (kW). */
  idlePowerKw: number;
  /** Peak electrical output (kW). Solar scales by sun, RTG is constant. */
  powerProduceKw: number;
  /** How generation behaves: solar follows the sun, baseload never varies. */
  generation?: 'solar' | 'baseload';
  /** Grid energy storage (kWh). */
  batteryKWh: number;
  /** Adds bulk stockpile capacity, per resource type (kg). */
  storagePerResourceKg: number;
  /** Adds life-support tank capacity. */
  fluidCapacity?: Partial<Record<FluidId, number>>;
  /** Load-shedding priority, 0 = shed last. */
  tier: PowerTier;
  /** Continuous conversion, if any. */
  process?: ProcessDef;
  /** A sealed volume the colonist can live in. */
  pressurized?: boolean;
  /** Recharges rover batteries when they park nearby. */
  providesCharge?: boolean;
  buildableBy: RoverKind[];
  /** Palette ordering / hotkey slot. */
  order: number;
}

export function costs(entries: Array<[ResourceId, number]>): ResourceAmounts {
  const a = emptyAmounts();
  for (const [r, n] of entries) a[r] = n;
  return a;
}

export const BUILDINGS: Record<BuildingKind, BuildingDef> = {
  habitat: {
    kind: 'habitat',
    label: 'Habitat',
    description:
      'Pressurised shelter. The colonist sleeps, eats and breathes here, and its recycler returns most of the water they use.',
    radius: 9,
    cost: costs([
      ['regolith', 60],
      ['iron', 40],
      ['silicon', 15],
      ['aluminum', 10],
    ]),
    buildTime: 46,
    powerDrawKw: 5,
    idlePowerKw: 1.2,
    powerProduceKw: 0,
    batteryKWh: 0,
    storagePerResourceKg: 60,
    fluidCapacity: { water: 200, oxygen: 30, food: 150 },
    tier: 0,
    pressurized: true,
    providesCharge: true,
    buildableBy: ['utility', 'mining'],
    order: 5,
  },
  solar: {
    kind: 'solar',
    label: 'Solar Array',
    description:
      'Photovoltaic array. Output tracks the sun exactly — brilliant at noon, worthless at midnight.',
    radius: 5,
    cost: costs([
      ['regolith', 10],
      ['silicon', 18],
      ['aluminum', 12],
    ]),
    buildTime: 18,
    powerDrawKw: 0,
    idlePowerKw: 0,
    powerProduceKw: 24,
    generation: 'solar',
    batteryKWh: 0,
    storagePerResourceKg: 0,
    tier: 3,
    buildableBy: ['utility', 'mining'],
    order: 1,
  },
  battery: {
    kind: 'battery',
    label: 'Battery Bank',
    description:
      'Stores 200 kWh. Charges on surplus, carries the colony through the night, and is the difference between a dark sol and a dead one.',
    radius: 4.5,
    cost: costs([
      ['regolith', 8],
      ['iron', 26],
      ['silicon', 6],
    ]),
    buildTime: 16,
    powerDrawKw: 0,
    idlePowerKw: 0.2,
    powerProduceKw: 0,
    batteryKWh: 200,
    storagePerResourceKg: 0,
    tier: 3,
    buildableBy: ['utility', 'mining'],
    order: 2,
  },
  rtg: {
    kind: 'rtg',
    label: 'RTG Array',
    description:
      'Radioisotope generators salvaged from the descent stage. Only 5 kW, but it never sleeps and no storm can dim it.',
    radius: 4,
    cost: costs([
      ['iron', 55],
      ['aluminum', 35],
      ['silicon', 20],
    ]),
    buildTime: 52,
    powerDrawKw: 0,
    idlePowerKw: 0,
    powerProduceKw: 5,
    generation: 'baseload',
    batteryKWh: 0,
    storagePerResourceKg: 0,
    tier: 3,
    buildableBy: ['utility', 'mining'],
    order: 9,
  },
  warehouse: {
    kind: 'warehouse',
    label: 'Warehouse',
    description: 'Adds bulk storage so mined material can be stockpiled for construction.',
    radius: 7,
    cost: costs([
      ['regolith', 35],
      ['iron', 15],
    ]),
    buildTime: 25,
    powerDrawKw: 1,
    idlePowerKw: 0.4,
    powerProduceKw: 0,
    batteryKWh: 0,
    storagePerResourceKg: 600,
    tier: 2,
    buildableBy: ['utility', 'mining'],
    order: 0,
  },
  extractor: {
    kind: 'extractor',
    label: 'Water Extractor',
    description:
      'Bakes hauled ice into liquid water. The first link in the survival chain — nothing downstream runs without it.',
    radius: 5.5,
    cost: costs([
      ['regolith', 20],
      ['iron', 30],
      ['aluminum', 12],
    ]),
    buildTime: 30,
    powerDrawKw: 18,
    idlePowerKw: 1.5,
    powerProduceKw: 0,
    batteryKWh: 0,
    storagePerResourceKg: 0,
    fluidCapacity: { water: 120 },
    tier: 1,
    process: {
      solidIn: { ice: 1.4 },
      fluidOut: { water: 1.15 },
      summary: '1.4 kg ice → 1.15 kg water per hour',
    },
    buildableBy: ['utility', 'mining'],
    order: 3,
  },
  oxygenator: {
    kind: 'oxygenator',
    label: 'Oxygen Generator',
    description:
      'Electrolyses water into breathable oxygen (and vented hydrogen). Power-hungry, and absolutely non-negotiable.',
    radius: 5,
    cost: costs([
      ['regolith', 15],
      ['iron', 28],
      ['silicon', 14],
      ['aluminum', 10],
    ]),
    buildTime: 32,
    powerDrawKw: 12,
    idlePowerKw: 1,
    powerProduceKw: 0,
    batteryKWh: 0,
    storagePerResourceKg: 0,
    fluidCapacity: { oxygen: 25 },
    tier: 1,
    process: {
      fluidIn: { water: 0.14 },
      fluidOut: { oxygen: 0.125 },
      summary: '0.14 kg water → 0.125 kg O₂ per hour',
    },
    buildableBy: ['utility', 'mining'],
    order: 4,
  },
  greenhouse: {
    kind: 'greenhouse',
    label: 'Greenhouse',
    description:
      'Hydroponic crops under pressure. Drinks water and light, returns food — the only renewable calories on the planet. One greenhouse comfortably feeds one colonist.',
    radius: 7,
    cost: costs([
      ['regolith', 25],
      ['iron', 18],
      ['silicon', 30],
      ['aluminum', 8],
    ]),
    buildTime: 38,
    powerDrawKw: 8,
    idlePowerKw: 1.5,
    powerProduceKw: 0,
    batteryKWh: 0,
    storagePerResourceKg: 0,
    fluidCapacity: { water: 60, food: 80 },
    tier: 1,
    pressurized: true,
    process: {
      fluidIn: { water: 0.42 },
      fluidOut: { food: 0.17 },
      needsLight: true,
      summary: '0.42 kg water + light → 0.17 kg food per hour (~2 kg/sol)',
    },
    buildableBy: ['utility', 'mining'],
    order: 6,
  },
  workshop: {
    kind: 'workshop',
    label: 'Workshop',
    description: 'Repairs and fabricates components. Speeds up nearby construction work.',
    radius: 6,
    cost: costs([
      ['regolith', 30],
      ['iron', 25],
      ['aluminum', 10],
    ]),
    buildTime: 30,
    powerDrawKw: 5,
    idlePowerKw: 1,
    powerProduceKw: 0,
    batteryKWh: 0,
    storagePerResourceKg: 120,
    tier: 2,
    buildableBy: ['utility', 'mining'],
    order: 7,
  },
};

export const BUILDING_ORDER: BuildingKind[] = (
  Object.keys(BUILDINGS) as BuildingKind[]
).sort((a, b) => BUILDINGS[a].order - BUILDINGS[b].order);

export function buildingLabel(kind: BuildingKind): string {
  return BUILDINGS[kind].label;
}

// ------------------------------------------------------------- deposits ----

export interface DepositDef {
  resource: ResourceId;
  amountKg: number;
  radius: number;
  amountVariance: number;
}

/** Deposit spread parameters by resource (generated around the region). */
export const DEPOSIT_TABLE: Record<ResourceId, DepositDef> = {
  regolith: { resource: 'regolith', amountKg: 6000, radius: 6, amountVariance: 0.5 },
  iron: { resource: 'iron', amountKg: 4000, radius: 5, amountVariance: 0.6 },
  silicon: { resource: 'silicon', amountKg: 3500, radius: 5, amountVariance: 0.6 },
  aluminum: { resource: 'aluminum', amountKg: 3000, radius: 4.5, amountVariance: 0.6 },
  ice: { resource: 'ice', amountKg: 4500, radius: 6, amountVariance: 0.7 },
};

// ------------------------------------------------------- landing supplies ----

/** Bulk capacity and life-support tankage built into the landing pod itself. */
export const POD_FLUID_CAPACITY: FluidAmounts = { water: 90, oxygen: 16, food: 130 };

/** What the pod touched down with. The clock starts here. */
export const POD_STARTING_FLUIDS: FluidAmounts = { water: 62, oxygen: 12, food: 96 };
