/** Data-driven content definitions (blueprints). No gameplay logic lives here. */

export type ResourceId = 'regolith' | 'iron' | 'silicon' | 'aluminum' | 'water';

export const ALL_RESOURCES: ResourceId[] = [
  'regolith',
  'iron',
  'silicon',
  'aluminum',
  'water',
];

export type ResourceAmounts = Record<ResourceId, number>;

export function emptyAmounts(): ResourceAmounts {
  return { regolith: 0, iron: 0, silicon: 0, aluminum: 0, water: 0 };
}

export interface ResourceInfo {
  id: ResourceId;
  label: string;
  color: number; // hex color used by renderer (mound + chip)
  /** kg mined per second by a standard mining tool (scaled by rover/tool). */
  mineRateKg: number;
  description: string;
}

export const RESOURCES: Record<ResourceId, ResourceInfo> = {
  regolith: {
    id: 'regolith',
    label: 'Regolith',
    color: 0xb07850,
    mineRateKg: 12,
    description: 'Loose soil. Used for construction, foundations and shielding.',
  },
  iron: {
    id: 'iron',
    label: 'Iron Ore',
    color: 0x8a8677,
    mineRateKg: 5,
    description: 'Crushed and smelted into steel for structures and machinery.',
  },
  silicon: {
    id: 'silicon',
    label: 'Silica',
    color: 0xc7cfd6,
    mineRateKg: 4,
    description: 'Refined into glass and silicon for panels and electronics.',
  },
  aluminum: {
    id: 'aluminum',
    label: 'Aluminum Ore',
    color: 0xa9b7bd,
    mineRateKg: 3.5,
    description: 'Light structural metal for frames and hulls.',
  },
  water: {
    id: 'water',
    label: 'Water Ice',
    color: 0x5f9fd0,
    mineRateKg: 3,
    description: 'The most precious resource: air, drink and crops depend on it.',
  },
};

export type RoverKind = 'mining' | 'utility';

export interface RoverDef {
  kind: RoverKind;
  label: string;
  role: string;
  maxBatteryKWh: number;
  capacityKg: number;
  cruiseSpeed: number; // world units / s
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
    movePowerKw: 3,
    workPowerKw: 7,
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
    movePowerKw: 2,
    workPowerKw: 4,
    mineSpeedMul: 0.6,
    buildPower: 1.6,
    bodyColor: 0x2f7fb0,
    accentColor: 0x1c2530,
    radius: 2.4,
  },
};

export type BuildingKind =
  | 'habitat'
  | 'solar'
  | 'battery'
  | 'warehouse'
  | 'workshop';

export interface BuildingDef {
  kind: BuildingKind;
  label: string;
  description: string;
  radius: number; // footprint (build clearance) in world units
  cost: ResourceAmounts;
  buildTime: number; // seconds at buildPower 1.0
  powerDrawKw: number; // recorded for future power loop
  powerProduceKw: number; // solar/nuclear, else 0
  storageCapacityKg: number; // if >0 this building adds colony storage
  providesCharge?: boolean; // base chargers rovers nearby
  buildableBy: RoverKind[]; // which rovers may construct it
  requires: ResourceId[]; // shorthand for cost keys with nonzero value
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
    description: 'Emergency shelter & life support. Initial base of operations.',
    radius: 9,
    cost: costs([
      ['regolith', 40],
      ['iron', 25],
      ['silicon', 8],
    ]),
    buildTime: 40,
    powerDrawKw: 5,
    powerProduceKw: 0,
    storageCapacityKg: 200,
    providesCharge: true,
    buildableBy: ['utility', 'mining'],
    requires: ['regolith', 'iron', 'silicon'],
  },
  solar: {
    kind: 'solar',
    label: 'Solar Array',
    description: 'Generates power from sunlight (once the power grid is online).',
    radius: 5,
    cost: costs([
      ['regolith', 10],
      ['silicon', 10],
      ['aluminum', 6],
    ]),
    buildTime: 18,
    powerDrawKw: 0,
    powerProduceKw: 10,
    storageCapacityKg: 0,
    buildableBy: ['utility', 'mining'],
    requires: ['regolith', 'silicon', 'aluminum'],
  },
  battery: {
    kind: 'battery',
    label: 'Battery Bank',
    description: 'Stores power for the colony (future power network).',
    radius: 4.5,
    cost: costs([
      ['regolith', 8],
      ['iron', 18],
    ]),
    buildTime: 16,
    powerDrawKw: 0.2,
    powerProduceKw: 0,
    storageCapacityKg: 0,
    buildableBy: ['utility', 'mining'],
    requires: ['regolith', 'iron'],
  },
  warehouse: {
    kind: 'warehouse',
    label: 'Warehouse',
    description: 'Adds storage capacity so mined resources can be stockpiled.',
    radius: 7,
    cost: costs([
      ['regolith', 35],
      ['iron', 15],
    ]),
    buildTime: 25,
    powerDrawKw: 1,
    powerProduceKw: 0,
    storageCapacityKg: 3000,
    buildableBy: ['utility', 'mining'],
    requires: ['regolith', 'iron'],
  },
  workshop: {
    kind: 'workshop',
    label: 'Workshop',
    description: 'Repairs and fabricates components (automation phase).',
    radius: 6,
    cost: costs([
      ['regolith', 30],
      ['iron', 25],
      ['aluminum', 10],
    ]),
    buildTime: 30,
    powerDrawKw: 5,
    powerProduceKw: 0,
    storageCapacityKg: 500,
    buildableBy: ['utility', 'mining'],
    requires: ['regolith', 'iron', 'aluminum'],
  },
};

export function buildingLabel(kind: BuildingKind): string {
  return BUILDINGS[kind].label;
}

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
  water: { resource: 'water', amountKg: 4500, radius: 6, amountVariance: 0.7 },
};
