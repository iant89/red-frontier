/** Permanent player engineering. Separate from wear and unsaved developer levels. */
import {
  BUILDINGS,
  ROVERS,
  emptyAmounts,
  emptyComponents,
  type BuildingKind,
  type RoverKind,
  type ResourceId,
  type ComponentId,
} from '../defs';

export const UPGRADE_IDS = [
  'drivetrain',
  'battery',
  'cargo',
  'teeth',
  'production',
  'generation',
  'storage',
  'service',
  'pump',
  'radar',
  'efficiency',
] as const;
export type UpgradeId = (typeof UPGRADE_IDS)[number];
export type UpgradeLevels = Partial<Record<UpgradeId, number>>;
export interface UpgradeJob {
  upgrade: UpgradeId;
  tier: number;
  progress: number;
  facilityId: number | null;
}
export interface EngineeringState {
  upgrades?: UpgradeLevels;
  upgradeJob?: UpgradeJob | null;
  paint?: string | null;
}
export type EntityTarget = { entity: 'rover' | 'building'; id: number };
export const MAX_UPGRADE_TIER = 3;
export const PAINTS = [
  '#d8d4c5',
  '#d67635',
  '#b53f38',
  '#3e8299',
  '#4b896a',
  '#dbc34f',
  '#7768a4',
  '#303c4b',
] as const;
export const levelOf = (e: EngineeringState, id: UpgradeId): number =>
  e.upgrades?.[id] ?? 0;
export const upgradeMul = (e: EngineeringState, id: UpgradeId): number =>
  1 + levelOf(e, id) * UPGRADES[id].gain;
export const UPGRADES: Record<
  UpgradeId,
  {
    label: string;
    description: string;
    gain: number;
    seconds: number;
    solids: Partial<Record<ResourceId, number>>;
    parts: Partial<Record<ComponentId, number>>;
  }
> = {
  drivetrain: {
    label: 'Drivetrain',
    description:
      'Higher cruise speed. Drive power rises 8% per tier; installed motor wear still matters.',
    gain: 0.2,
    seconds: 20,
    solids: { aluminum: 60, steel: 20 },
    parts: { motor: 2, circuitBoard: 1 },
  },
  battery: {
    label: 'Battery pack',
    description:
      'Larger energy reserve. Installation adds empty capacity, not free charge.',
    gain: 0.35,
    seconds: 24,
    solids: { aluminum: 40, steel: 10 },
    parts: { batteryPack: 2, circuitBoard: 1 },
  },
  cargo: {
    label: 'Cargo expansion',
    description: 'A stronger frame and larger cargo bed.',
    gain: 0.4,
    seconds: 24,
    solids: { aluminum: 100, steel: 30 },
    parts: { cargoFrame: 2, motor: 1 },
  },
  teeth: {
    label: 'Miner teeth',
    description:
      'Hardened cutting teeth improve mining yield per second. Mining rovers only.',
    gain: 0.3,
    seconds: 20,
    solids: { steel: 30, iron: 20 },
    parts: { drillTeeth: 2, motor: 1 },
  },
  production: {
    label: 'Production line',
    description:
      'Increase both recipe inputs and outputs; still limited by supply, storage and power.',
    gain: 0.25,
    seconds: 28,
    solids: { steel: 25, aluminum: 30 },
    parts: { motor: 2, circuitBoard: 2 },
  },
  generation: {
    label: 'Power generation',
    description:
      'Increase rated generator output. Solar still depends on light and cleanliness.',
    gain: 0.25,
    seconds: 30,
    solids: { aluminum: 50, silicon: 40, steel: 20 },
    parts: { circuitBoard: 2, batteryPack: 1 },
  },
  storage: {
    label: 'Storage expansion',
    description:
      'Expand this building’s tanks, batteries, silos or component racks. New capacity starts empty.',
    gain: 0.4,
    seconds: 28,
    solids: { aluminum: 60, steel: 30 },
    parts: { cargoFrame: 2, circuitBoard: 1 },
  },
  service: {
    label: 'Service equipment',
    description:
      'Faster Garage charging, servicing, assembly and upgrade installation, or Repair Bay replacements.',
    gain: 0.25,
    seconds: 30,
    solids: { steel: 40, aluminum: 30 },
    parts: { motor: 2, circuitBoard: 2 },
  },
  pump: {
    label: 'Pump impeller',
    description:
      'Move more water through the connected network at the same power.',
    gain: 0.3,
    seconds: 24,
    solids: { steel: 25, aluminum: 20 },
    parts: { motor: 2, pipe: 2 },
  },
  radar: {
    label: 'Radar receiver',
    description: 'Expand the station’s radar coverage.',
    gain: 0.25,
    seconds: 26,
    solids: { silicon: 40, aluminum: 30 },
    parts: { circuitBoard: 3, motor: 1 },
  },
  efficiency: {
    label: 'Power efficiency',
    description:
      'Reduce active and idle grid draw by 12% of the original rating per tier.',
    gain: -0.12,
    seconds: 24,
    solids: { silicon: 30, steel: 15 },
    parts: { circuitBoard: 2, batteryPack: 1 },
  },
};
export function roverUpgrades(kind: RoverKind): UpgradeId[] {
  return kind === 'mining'
    ? ['drivetrain', 'battery', 'cargo', 'teeth']
    : ['drivetrain', 'battery', 'cargo'];
}
export function buildingUpgrades(kind: BuildingKind): UpgradeId[] {
  const d = BUILDINGS[kind],
    ids: UpgradeId[] = [];
  if (d.process || kind === 'workshop') ids.push('production');
  if (d.powerProduceKw > 0) ids.push('generation');
  if (
    d.batteryKWh ||
    d.storagePerResourceKg ||
    d.fluidCapacity ||
    d.componentSlots
  )
    ids.push('storage');
  if (kind === 'garage' || kind === 'repairBay') ids.push('service');
  if (kind === 'pumpStation') ids.push('pump');
  if (kind === 'weatherStation') ids.push('radar');
  if (d.powerDrawKw > 0) ids.push('efficiency');
  return ids;
}
export function upgradePrice(id: UpgradeId, tier: number) {
  const def = UPGRADES[id],
    solids = emptyAmounts(),
    parts = emptyComponents();
  for (const [key, amount] of Object.entries(def.solids))
    solids[key as ResourceId] = amount * tier;
  for (const [key, amount] of Object.entries(def.parts))
    parts[key as ComponentId] = amount * tier;
  return { solids, parts, seconds: def.seconds * tier };
}
export function effectiveRoverDef(r: EngineeringState & { kind: RoverKind }) {
  const def = ROVERS[r.kind];
  if (!r.upgrades || !Object.values(r.upgrades).some(Boolean)) return def;
  return {
    ...def,
    cruiseSpeed: def.cruiseSpeed * upgradeMul(r, 'drivetrain'),
    movePowerKw: def.movePowerKw * (1 + 0.08 * levelOf(r, 'drivetrain')),
    maxBatteryKWh: def.maxBatteryKWh * upgradeMul(r, 'battery'),
    capacityKg: def.capacityKg * upgradeMul(r, 'cargo'),
    mineSpeedMul: def.mineSpeedMul * upgradeMul(r, 'teeth'),
  };
}
export function effectiveBuildingDef(
  b: EngineeringState & { kind: BuildingKind },
) {
  const d = BUILDINGS[b.kind];
  if (!b.upgrades || !Object.values(b.upgrades).some(Boolean)) return d;
  const storage = upgradeMul(b, 'storage'),
    efficiency = upgradeMul(b, 'efficiency');
  return {
    ...d,
    powerDrawKw: d.powerDrawKw * efficiency,
    idlePowerKw: d.idlePowerKw * efficiency,
    powerProduceKw: d.powerProduceKw * upgradeMul(b, 'generation'),
    batteryKWh: d.batteryKWh * storage,
    storagePerResourceKg: d.storagePerResourceKg * storage,
    componentSlots: (d.componentSlots ?? 0) * storage,
    weatherRadarRangeKm: (d.weatherRadarRangeKm ?? 0) * upgradeMul(b, 'radar'),
    fluidCapacity: d.fluidCapacity
      ? Object.fromEntries(
          Object.entries(d.fluidCapacity).map(([k, v]) => [k, v * storage]),
        )
      : undefined,
  };
}
