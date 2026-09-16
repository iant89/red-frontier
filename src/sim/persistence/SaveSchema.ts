/**
 * Current save schema — version 8.
 *
 * Phase 3: persistence extraction. This file owns the *shape* of a saved
 * colony. Simulation.ts no longer defines it inline in snapshot().
 */

import type { ResourceAmounts, FluidAmounts, ResourceId, RoverKind, BuildingKind } from '../defs';
import type { DifficultyId, WorldOptions } from '../difficulty';
import type { PoiKind } from '../pois';
import type { RoverTask, RoverRules } from '../state/RoverState';
import { SAVE_VERSION } from '../config';

// ---- sub-schemas -----------------------------------------------------------

export interface ClockSave {
  sol: number;
  frac: number;
}

export interface DepositSave {
  id: number;
  resource: ResourceId;
  x: number;
  z: number;
  amount: number;
  maxAmount: number;
  radius: number;
  reservedBy: number | null;
}

export interface PoiSave {
  id: number;
  kind: PoiKind;
  x: number;
  z: number;
  salvage: Partial<Record<ResourceId, number>>;
  energyKWh: number;
  discovered: boolean;
  solsToBury: number;
  buried: boolean;
  manifest: string;
}

export interface RoverSave {
  id: number;
  kind: RoverKind;
  x: number;
  y: number;
  z: number;
  heading: number;
  battery: number;
  cargo: ResourceAmounts;
  command: RoverTask;
  pending: RoverTask[];
  condition: number;
  rules: RoverRules;
  autoTask: boolean;
  recharge: boolean;
  lowBatteryNotified: boolean;
  blockNotified: boolean;
  sheltered: boolean;
  lightsOn: boolean;
}

export interface BuildingAssemblySave {
  kind: RoverKind;
  progress: number;
}

export interface BuildingSave {
  id: number;
  kind: BuildingKind;
  x: number;
  z: number;
  rot: number;
  state: 'site' | 'building' | 'online';
  remainingCost: ResourceAmounts;
  needsMaterials: boolean;
  progress: number;
  buildTime: number;
  workerId: number | null;
  enabled: boolean;
  health: number;
  cleanliness: number;
  damaged: boolean;
  assembly: BuildingAssemblySave | null;
}

export interface ColonistSave {
  id: number;
  name: string;
  x: number;
  z: number;
  heading: number;
  health: number;
  suitO2: number;
  inside: boolean;
  shelterId: number;
  order: { type: string; [k: string]: unknown };
  dead: boolean;
}

export interface ExplorationSave {
  nextDropSol: number;
}

// Weather snapshot — matches Weather.snapshot() return
export interface WeatherSave {
  rngState?: number;
  lightningRngState?: number;
  nextRollAt?: number;
  lastStormEndAt?: number;
  active?: unknown;
  scheduled?: unknown;
  dust?: number;
  windSpeed?: number;
  windDirRad?: number;
  frequencyMul?: number;
  damageMul?: number;
  lightningMul?: number;
  [k: string]: unknown;
}

export interface AlertSave {
  active?: Array<{
    key: string;
    severity?: string;
    title?: string;
    detail?: string;
    since?: number;
    lastSeen?: number;
    entityId?: number;
  }>;
  log?: Array<{
    severity?: string;
    text?: string;
    time?: number;
    stamp?: string;
  }>;
}

// ---- current save ----------------------------------------------------------

export const CURRENT_SAVE_VERSION = SAVE_VERSION;

export interface SaveState {
  version: typeof CURRENT_SAVE_VERSION;
  seed: number;
  difficulty: DifficultyId;
  worldHalf: number;
  region: string | null;
  worldOptions: WorldOptions;
  simTime: number;
  ticksRun: number;
  clock: ClockSave;
  storage: ResourceAmounts;
  fluids: FluidAmounts;
  storedKWh: number;
  gameOver: { reason: string; sol: number } | null;
  colonist: ColonistSave;
  deposits: DepositSave[];
  pois: PoiSave[];
  exploration: ExplorationSave;
  rovers: RoverSave[];
  buildings: BuildingSave[];
  weather: WeatherSave;
  alerts: AlertSave;
}

/**
 * Loose historical save — used as input to migrations. Version may be <8,
 * fields may be missing. This is intentionally `any`-like but typed as unknown
 * record for migration functions to narrow.
 */
export type HistoricalSave = Record<string, unknown> & { version?: unknown };
