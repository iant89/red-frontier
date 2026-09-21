/**
 * Data-driven content definitions (blueprints). No gameplay logic lives here.
 *
 * Three distinct material systems:
 *
 * - **Bulk resources** are solids carried by rovers and stockpiled in
 *   warehouses. They are the *construction* economy. Two origins share one
 *   ledger (GDD §03):
 *     - `mined`  — dug out of a seam (regolith, iron ore, silica, aluminum ore,
 *                  water ice). Only these have deposits on the planet and only
 *                  these can be mined or dev-spawned as a seam.
 *     - `refined`— made by a building process out of something else (steel, P5).
 *                  Never scattered, never mined, but hauled, stored, reserved
 *                  and spent exactly like any other solid — one ledger, not two.
 * - **Fluids** (water, oxygen, food) are life-support commodities. They never
 *   ride on a rover; they live in tanks provided by buildings and move through
 *   processes. They are the *survival* economy.
 *
 * The bridges are the buildings: the Water Extractor eats bulk `ice` and emits
 * fluid `water`; the Refinery eats bulk `iron` and emits bulk `steel`.
 */

import type { PowerTier } from './config';
import type { UnlockId } from './unlocks';

// ------------------------------------------------------- bulk resources ----

/** Solids the planet has seams of — the only ones a rover can dig. */
export type MineableResourceId = 'regolith' | 'iron' | 'silicon' | 'aluminum' | 'ice';

/** Solids a building process makes (P5 — the middle of the industrial chain). */
export type RefinedResourceId = 'steel';

export type ResourceId = MineableResourceId | RefinedResourceId;

export const MINEABLE_RESOURCES: MineableResourceId[] = [
  'regolith',
  'iron',
  'silicon',
  'aluminum',
  'ice',
];

export const REFINED_RESOURCES: RefinedResourceId[] = ['steel'];

export const ALL_RESOURCES: ResourceId[] = [...MINEABLE_RESOURCES, ...REFINED_RESOURCES];

export type ResourceAmounts = Record<ResourceId, number>;

export function emptyAmounts(): ResourceAmounts {
  return { regolith: 0, iron: 0, silicon: 0, aluminum: 0, ice: 0, steel: 0 };
}

/** True for materials a process makes rather than a seam yields. */
export function isRefined(res: ResourceId): res is RefinedResourceId {
  return (REFINED_RESOURCES as string[]).includes(res);
}

export interface ResourceInfo {
  id: ResourceId;
  label: string;
  short: string;
  color: number; // hex color used by renderer (mound + chip)
  /** Where the material comes from: a seam, or a building process. */
  origin: 'mined' | 'refined';
  /**
   * kg mined per game second by a standard mining tool. Zero for refined
   * materials, which have no seam to mine — read {@link ResourceInfo.origin}
   * before using this.
   */
  mineRateKg: number;
  description: string;
}

export const RESOURCES: Record<ResourceId, ResourceInfo> = {
  regolith: {
    id: 'regolith',
    label: 'Regolith',
    short: 'Reg',
    color: 0xb07850,
    origin: 'mined',
    mineRateKg: 12,
    description: 'Loose soil. Used for construction, foundations and shielding.',
  },
  iron: {
    id: 'iron',
    label: 'Iron Ore',
    short: 'Fe',
    color: 0x8a8677,
    origin: 'mined',
    mineRateKg: 5,
    description: 'Crushed and smelted into steel for structures and machinery.',
  },
  silicon: {
    id: 'silicon',
    label: 'Silica',
    short: 'Si',
    color: 0xc7cfd6,
    origin: 'mined',
    mineRateKg: 4,
    description: 'Refined into glass and silicon for panels and electronics.',
  },
  aluminum: {
    id: 'aluminum',
    label: 'Aluminum Ore',
    short: 'Al',
    color: 0xa9b7bd,
    origin: 'mined',
    mineRateKg: 3.5,
    description: 'Light structural metal for frames, hulls and solar trusses.',
  },
  ice: {
    id: 'ice',
    label: 'Water Ice',
    short: 'Ice',
    color: 0x5f9fd0,
    origin: 'mined',
    mineRateKg: 3,
    description:
      'Buried ice. Feed it to a Water Extractor to turn it into liquid water — and from there, oxygen and crops.',
  },
  steel: {
    id: 'steel',
    label: 'Steel',
    short: 'Stl',
    color: 0x8e9aa6,
    origin: 'refined',
    mineRateKg: 0,
    description:
      'Smelted iron. There is no seam for it: a Refinery makes it out of ore and power, and the heavy structures downstream are built from it.',
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

// ---------------------------------------------------------- components ----

/**
 * Manufactured units (P5 slice 2). Components are **counted, not weighed**: a
 * motor is not 40 kg of anything, it is one motor, so it lives on its own
 * integer ledger (`ColonyState.components`) rather than bending the kg ledger
 * into holding counts. They are crafted by a workshop recipe, racked in
 * workshop slots, and spent when the garage assembles a rover.
 */
export type ComponentId = 'motor' | 'circuitBoard' | 'pipe' | 'batteryPack' | 'cargoFrame' | 'drillTeeth';
/** Only installed rover parts have wear; pipes are construction inventory. */
export const ROVER_PARTS = ['motor', 'circuitBoard'] as const;
export type RoverPartId = typeof ROVER_PARTS[number];

export const ALL_COMPONENTS: ComponentId[] = ['motor', 'circuitBoard', 'pipe', 'batteryPack', 'cargoFrame', 'drillTeeth'];

export type ComponentAmounts = Record<ComponentId, number>;

export function emptyComponents(): ComponentAmounts {
  return { motor: 0, circuitBoard: 0, pipe: 0, batteryPack: 0, cargoFrame: 0, drillTeeth: 0 };
}

/** Component costs, as whole units — the counted counterpart of {@link costs}. */
export function units(entries: Array<[ComponentId, number]>): ComponentAmounts {
  const a = emptyComponents();
  for (const [c, n] of entries) a[c] = n;
  return a;
}

export interface ComponentInfo {
  id: ComponentId;
  label: string;
  short: string;
  color: number; // hex, for the HUD chip
  description: string;
}

export const COMPONENTS: Record<ComponentId, ComponentInfo> = {
  batteryPack: { id:'batteryPack', label:'Battery Pack', short:'Pack', color:0xd7ad49, description:'Rechargeable cells and control electronics for larger energy reserves and efficient machinery.' },
  cargoFrame: { id:'cargoFrame', label:'Cargo Frame', short:'Frame', color:0x83a9b9, description:'Reinforced structural modules for expanded rover beds, tanks and storage racks.' },
  drillTeeth: { id:'drillTeeth', label:'Drill Teeth', short:'Teeth', color:0xd0c8b4, description:'Hardened steel cutting teeth for permanent mining-tool upgrades.' },
  pipe: {
    id: 'pipe', label: 'Water Pipe', short: 'Pipe', color: 0x529bd6,
    description: 'A sealed 20 m pipe section. Lay permanent water links between building ports; longer runs consume more sections.',
  },
  motor: {
    id: 'motor',
    label: 'Drive Motor',
    short: 'Mtr',
    color: 0xc9a227,
    description:
      'A sealed drive unit machined out of steel. Used for rover assembly and to replace worn motors at a Repair Bay.',
  },
  circuitBoard: {
    id: 'circuitBoard',
    label: 'Circuit Board',
    short: 'PCB',
    color: 0x3fae6a,
    description:
      'Controller and sensor boards cut from silica and wired with aluminum. A rover needs them to be more than a remote-controlled cart.',
  },
};

// -------------------------------------------------------------- rovers ----

export type RoverKind = 'mining' | 'utility' | 'cargo';

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
  /**
   * Position lights + headlights load (kW) while lit. Drawn from the rover's
   * own battery whenever the sim has the lights on (night / low visibility).
   * A battery-flat rover can no longer power them — but its yellow emergency
   * strobe runs off a small reserve cell and keeps flashing anyway.
   */
  lightsPowerKw: number;
  /** Multiplier on resource.mineRateKg applied by this rover's tool. */
  mineSpeedMul: number;
  /** Construction work output relative to baseline (1.0). */
  buildPower: number;
  bodyColor: number;
  accentColor: number;
  radius: number; // visual / arrival radius
  /** Materials consumed when the garage assembles one of these (P4). */
  cost: ResourceAmounts;
  /**
   * Manufactured components the garage line consumes alongside the bulk cost
   * (P5). Crafted in a workshop — so a rover is now the end of the whole chain:
   * ore → steel → motors and boards → vehicle.
   */
  componentCost: ComponentAmounts;
  /** Garage assembly time at full line power (game seconds). */
  buildTime: number;
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
    lightsPowerKw: 0.7,
    mineSpeedMul: 1.5,
    buildPower: 0.6,
    bodyColor: 0xe07b3a,
    accentColor: 0x2b2117,
    radius: 3,
    cost: costs([
      ['iron', 60],
      ['aluminum', 30],
      ['silicon', 15],
    ]),
    componentCost: units([
      ['motor', 4],
      ['circuitBoard', 1],
    ]),
    buildTime: 55,
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
    lightsPowerKw: 0.5,
    mineSpeedMul: 0.6,
    buildPower: 1.6,
    bodyColor: 0x2f7fb0,
    accentColor: 0x1c2530,
    radius: 2.4,
    cost: costs([
      ['iron', 40],
      ['aluminum', 20],
      ['silicon', 10],
    ]),
    componentCost: units([
      ['motor', 2],
      ['circuitBoard', 1],
    ]),
    buildTime: 40,
  },
  cargo: {
    kind: 'cargo',
    label: 'Cargo Rover',
    role: 'Long-distance hauling',
    maxBatteryKWh: 120,
    capacityKg: 3000,
    cruiseSpeed: 7,
    turnRate: 1.1,
    movePowerKw: 12,
    workPowerKw: 8,
    lightsPowerKw: 0.9,
    mineSpeedMul: 0.25,
    buildPower: 0.3,
    bodyColor: 0xb9973e,
    accentColor: 0x2b2618,
    radius: 3.4,
    cost: costs([
      ['iron', 80],
      ['aluminum', 50],
      ['silicon', 25],
    ]),
    componentCost: units([
      ['motor', 6],
      ['circuitBoard', 2],
    ]),
    buildTime: 75,
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
  | 'garage'
  | 'rtg'
  | 'weatherStation'
  | 'refinery'
  | 'repairBay'
  | 'pumpStation'
  | 'waterTank';

/**
 * A continuous conversion run by an online, powered building.
 * All rates are **per Mars hour** so they read like engineering figures.
 */
export interface ProcessDef {
  /** Bulk solids consumed per hour at full rate. */
  solidIn?: Partial<Record<ResourceId, number>>;
  /**
   * Bulk solids produced per hour at full rate (P5 — refining). Output is
   * limited by silo room in the colony ledger, exactly like a delivery.
   */
  solidOut?: Partial<Record<ResourceId, number>>;
  /** Fluids consumed per hour at full rate. */
  fluidIn?: Partial<Record<FluidId, number>>;
  /** Fluids produced per hour at full rate. */
  fluidOut?: Partial<Record<FluidId, number>>;
  /**
   * Manufactured units produced per hour at full rate (P5). A line accumulates
   * the fraction on the building and hands over **whole** units — you cannot
   * rack 0.4 of a motor — so a slow recipe still delivers, just less often.
   */
  componentOut?: Partial<Record<ComponentId, number>>;
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
  /** Maximum radius in kilometres covered by an online weather radar. */
  weatherRadarRangeKm?: number;
  /** Whether this building turns a basic outlook into an advanced forecast. */
  advancedForecast?: boolean;
  /** A sealed volume the colonist can live in. */
  pressurized?: boolean;
  /** Recharges rover batteries when they park nearby. */
  providesCharge?: boolean;
  /**
   * Storm exposure 0..1 — how much wind-blown dust and pressure this design
   * takes (GDD §4: buildings are machines with wear and failure modes). An
   * open solar array is fully exposed; a nose-down RTG barely notices a storm.
   */
  exposure: number;
  buildableBy: RoverKind[];
  /**
   * Rack space for manufactured components (P5). Whole units, not kg, and it is
   * the *only* component capacity in the game: the landing pod has no rack, so
   * nothing can be crafted until a workshop stands.
   */
  componentSlots?: number;
  /**
   * Blueprint gating (Phase 2 unlock registry). When set, the blueprint cannot
   * be sited until the colony holds this unlock: `ConstructionSystem.verdict`
   * refuses it, the host mirror's `placeVerdict` says why, and the build bar
   * greys it out with the project that pays it. Unset — as every shipping
   * blueprint is today, by design — means available from sol 1.
   */
  requiresUnlock?: UnlockId;
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
    exposure: 0.35,
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
    powerProduceKw: 28,
    generation: 'solar',
    batteryKWh: 0,
    storagePerResourceKg: 0,
    tier: 3,
    exposure: 1.0,
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
    exposure: 0.45,
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
    exposure: 0.15,
    buildableBy: ['utility', 'mining'],
    order: 9,
  },
  weatherStation: {
    kind: 'weatherStation',
    label: 'Weather Radar Station',
    description:
      'A RAXpol polarimetric radar under a green radome, a vane anemometer, and MLI-wrapped instruments. Builds a live weather map of nearby storm cells — including dust devils and their predicted tracks — and extends the colony to an advanced forecast.',
    radius: 6,
    cost: costs([
      ['regolith', 24],
      ['iron', 18],
      ['silicon', 28],
      ['aluminum', 18],
      ['steel', 25],
    ]),
    buildTime: 44,
    powerDrawKw: 10,
    idlePowerKw: 2,
    powerProduceKw: 0,
    batteryKWh: 0,
    storagePerResourceKg: 0,
    tier: 2,
    weatherRadarRangeKm: 520,
    advancedForecast: true,
    exposure: 0.3,
    buildableBy: ['utility', 'mining'],
    order: 10,
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
    exposure: 0.5,
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
    exposure: 0.6,
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
    fluidCapacity: { oxygen: 25, water: 10 },
    tier: 1,
    process: {
      fluidIn: { water: 0.14 },
      fluidOut: { oxygen: 0.125 },
      summary: '0.14 kg water → 0.125 kg O₂ per hour',
    },
    exposure: 0.6,
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
    exposure: 0.7,
    buildableBy: ['utility', 'mining'],
    order: 6,
  },
  workshop: {
    kind: 'workshop',
    label: 'Workshop',
    description:
      'Machine shop and repair bench. Runs one of six lines — motors, boards, pipes, battery packs, cargo frames or drill teeth — out of refined stock, racks the finished components, and lends tooling to every build site nearby.',
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
    componentSlots: 24,
    tier: 2,
    exposure: 0.5,
    buildableBy: ['utility', 'mining'],
    order: 7,
  },
  garage: {
    kind: 'garage',
    label: 'Rover Garage',
    description:
      'Vehicle bay. Fast-charges rover batteries, services their worn drivetrains while they park, and can assemble new rovers from stockpiled parts.',
    radius: 6.5,
    cost: costs([
      ['regolith', 25],
      ['iron', 12],
      ['silicon', 12],
      ['steel', 30],
    ]),
    buildTime: 34,
    powerDrawKw: 3,
    idlePowerKw: 0.8,
    powerProduceKw: 0,
    batteryKWh: 0,
    storagePerResourceKg: 100,
    tier: 2,
    providesCharge: true,
    exposure: 0.45,
    buildableBy: ['utility', 'mining'],
    order: 8,
  },
  pumpStation: {
    kind: 'pumpStation', label: 'Pump Station',
    description: 'Moves up to 6 kg of water per Mars hour through its connected pipe network. Build and connect every water port before commissioning; temporary shared plumbing stays active until then.',
    radius: 4.5, cost: costs([['regolith', 20], ['iron', 15], ['silicon', 6], ['steel', 10]]),
    buildTime: 26, powerDrawKw: 6, idlePowerKw: 0.5, powerProduceKw: 0,
    batteryKWh: 0, storagePerResourceKg: 0, fluidCapacity: { water: 20 },
    tier: 1, exposure: 0.4, buildableBy: ['utility', 'mining'], order: 13,
  },
  waterTank: {
    kind: 'waterTank', label: 'Water Tank',
    description: 'Stores 250 kg of water. Connect it with pipes and a powered pump to buffer production and supply nearby consumers. Once commissioned, disconnected tanks cannot share their water.',
    radius: 5, cost: costs([['regolith', 25], ['iron', 20], ['aluminum', 10]]),
    buildTime: 24, powerDrawKw: 0, idlePowerKw: 0, powerProduceKw: 0,
    batteryKWh: 0, storagePerResourceKg: 0, fluidCapacity: { water: 250 },
    tier: 1, exposure: 0.3, buildableBy: ['utility', 'mining'], order: 14,
  },
  repairBay: {
    kind: 'repairBay',
    label: 'Repair Bay',
    description:
      'Advanced rover maintenance. Park a rover beside the bay to replace motors and circuit boards at 70% health or below. Each replacement takes 12 powered seconds and one matching part from the Workshop rack. Routine garage servicing cannot replace worn parts.',
    radius: 7,
    cost: costs([
      ['regolith', 30],
      ['iron', 18],
      ['aluminum', 12],
      ['silicon', 10],
      ['steel', 20],
    ]),
    buildTime: 38,
    powerDrawKw: 8,
    idlePowerKw: 1,
    powerProduceKw: 0,
    batteryKWh: 0,
    storagePerResourceKg: 0,
    tier: 2,
    exposure: 0.4,
    buildableBy: ['utility', 'mining'],
    order: 12,
  },
  refinery: {
    kind: 'refinery',
    label: 'Refinery',
    description:
      'Smelts hauled iron ore into steel. The gate on every heavy structure downstream: steel is made, not dug, and a hungry arc furnace will brown out half the colony to make it.',
    radius: 7.5,
    cost: costs([
      ['regolith', 40],
      ['iron', 50],
      ['silicon', 18],
      ['aluminum', 16],
    ]),
    buildTime: 48,
    powerDrawKw: 35,
    idlePowerKw: 4,
    powerProduceKw: 0,
    batteryKWh: 0,
    storagePerResourceKg: 150,
    tier: 2,
    process: {
      solidIn: { iron: 2.6 },
      solidOut: { steel: 1.6 },
      summary: '2.6 kg iron ore → 1.6 kg steel per hour',
    },
    exposure: 0.6,
    buildableBy: ['utility', 'mining'],
    order: 11,
  },
};

export const BUILDING_ORDER: BuildingKind[] = (
  Object.keys(BUILDINGS) as BuildingKind[]
).sort((a, b) => BUILDINGS[a].order - BUILDINGS[b].order);

export function buildingLabel(kind: BuildingKind): string {
  return BUILDINGS[kind].label;
}

// ------------------------------------------------------------- recipes ----

/**
 * A selectable production line (P5 slice 2).
 *
 * **B′, one source of truth per building:** when a kind has recipes, the list
 * *replaces* `BUILDINGS[kind].process` rather than adding to it — a blueprint
 * either has one fixed line or a menu of them, never both. A test pins that.
 * Everything that used to read `def.process` reads {@link activeProcess} now, so
 * the sim, the renderer and the HUD cannot disagree about which line is running.
 *
 * The selection is a per-building index (`Building.recipe`), saved and hashed
 * like any other building field; switching lines keeps whatever work-in-progress
 * the bench holds, because `craft` is keyed by component, not by recipe.
 */
export interface RecipeDef {
  /** Stable name for UI keys and log lines. */
  id: string;
  label: string;
  process: ProcessDef;
}

export const RECIPES: Partial<Record<BuildingKind, RecipeDef[]>> = {
  workshop: [
    {
      id: 'motors',
      label: 'Drive Motors',
      process: {
        solidIn: { steel: 2.5, aluminum: 1 },
        componentOut: { motor: 0.5 },
        summary: '2.5 kg steel + 1 kg aluminum → 1 drive motor per 2 hours',
      },
    },
    {
      id: 'boards',
      label: 'Circuit Boards',
      process: {
        solidIn: { silicon: 1.2, aluminum: 0.4, steel: 0.2 },
        componentOut: { circuitBoard: 0.35 },
        summary: '1.2 kg silica + 0.4 kg aluminum + 0.2 kg steel → 1 board per ~3 hours',
      },
    },
    {
      id: 'pipes', label: 'Water Pipes',
      process: { solidIn: { steel: 1 }, componentOut: { pipe: 2 }, summary: '1 kg steel → 2 water pipes per hour (20 m each)' },
    },
    { id:'battery-packs',label:'Battery Packs',process:{solidIn:{aluminum:2,silicon:1,steel:.5},componentOut:{batteryPack:.5},summary:'2 kg aluminum + 1 kg silica + 0.5 kg steel → 0.5 battery packs/h'} },
    { id:'cargo-frames',label:'Cargo Frames',process:{solidIn:{aluminum:3,steel:2},componentOut:{cargoFrame:.5},summary:'3 kg aluminum + 2 kg steel → 0.5 cargo frames/h'} },
    { id:'drill-teeth',label:'Drill Teeth',process:{solidIn:{iron:1,steel:3},componentOut:{drillTeeth:.5},summary:'1 kg iron + 3 kg steel → 0.5 sets of drill teeth/h'} },
  ],
};

/** The recipe list for a kind; empty for a building with a fixed line or none. */
export function recipesFor(kind: BuildingKind): RecipeDef[] {
  return RECIPES[kind] ?? [];
}

/** True when this kind has a line the player can choose. */
export function hasRecipes(kind: BuildingKind): boolean {
  return (RECIPES[kind]?.length ?? 0) > 1;
}

/**
 * The process a building is actually running. An out-of-range index falls back to
 * the first recipe rather than throwing: a save from a future build, or a stale
 * UI command, must not take the tick down with it.
 */
export function activeProcess(kind: BuildingKind, recipe: number): ProcessDef | undefined {
  const list = RECIPES[kind];
  if (list && list.length > 0) {
    const i = Number.isInteger(recipe) && recipe >= 0 && recipe < list.length ? recipe : 0;
    return list[i].process;
  }
  return BUILDINGS[kind].process;
}

/** Does this kind convert anything at all (fixed line or first recipe)? */
export function hasProcess(kind: BuildingKind): boolean {
  return activeProcess(kind, 0) !== undefined;
}

/** The line a building is running, as one sentence — what the HUD prints. */
export function activeSummary(kind: BuildingKind, recipe: number): string {
  return activeProcess(kind, recipe)?.summary ?? '';
}

// ------------------------------------------------------------- deposits ----

/**
 * A seam of *mined* material. Refined resources never appear here: there is no
 * steel deposit on this planet, only a refinery that makes steel out of ore.
 */
export interface DepositDef {
  resource: MineableResourceId;
  amountKg: number;
  radius: number;
  amountVariance: number;
}

/** Deposit spread parameters by resource (generated around the region). */
export const DEPOSIT_TABLE: Record<MineableResourceId, DepositDef> = {
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
