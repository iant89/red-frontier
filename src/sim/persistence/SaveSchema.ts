/**
 * Current save schema — version 13.
 *
 * Phase 3: persistence extraction. This file owns the *shape* of a saved
 * colony. Simulation.ts no longer defines it inline in snapshot().
 */

import type { EngineeringState, UpgradeLevels, UpgradeJob } from '../engineering/upgrades';
import type { WaterState } from '../state/WaterState';

import type {
  ComponentAmounts,
  ResourceAmounts,
  FluidAmounts,
  MineableResourceId,
  ResourceId,
  RoverKind,
  BuildingKind,
} from '../defs';
import type { DifficultyId, WorldOptions } from '../difficulty';
import type { PoiKind } from '../pois';
import type { RoverTask, RoverRules, RoverPartHealth } from '../state/RoverState';
import type { PartReplacement } from '../state/BuildingState';
import type { TutorialState } from '../state/TutorialState';
import type { ObjectiveState, CompletionRecord } from '../state/ObjectiveState';
import type { UnlockRegistry, UnlockRecord } from '../unlocks';
import { SAVE_VERSION } from '../config';

// ---- sub-schemas -----------------------------------------------------------

export interface ClockSave {
  sol: number;
  frac: number;
}

export interface DepositSave {
  id: number;
  /** Always a *mined* material — refined resources have no seams (P5). */
  resource: MineableResourceId;
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

export interface RoverSave extends EngineeringState {
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
  /** v11 installed component health. Missing on old colonies means healthy. */
  parts?: Partial<RoverPartHealth>;
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

export interface BuildingSave extends EngineeringState {
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
  maintenance?: PartReplacement | null;
  /**
   * Which recipe the building is running (P5) — an index into `RECIPES[kind]`,
   * absent on a v9 save, where it means 0. Ignored by a kind with no recipes.
   */
  recipe?: number;
  /** Fraction of each next component, kept on the bench. Absent means zeros. */
  craft?: Partial<ComponentAmounts>;
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

/**
 * Phase 2 — the project board (v15). Both fields are optional in the type
 * because a v14 save simply does not have them; the migration supplies the
 * empty defaults.
 */
export interface ObjectiveSave {
  active: string[];
  completed: Record<string, CompletionRecord>;
}

/**
 * Phase 2 — the unlock registry (v15), plus the sol the player last issued a
 * direct order. `lastDirectOrderSol` lives at the top level because it is a
 * colony fact, not a project fact: AUTONOMY.md's streak is measured from it.
 */
export interface UnlockSave {
  unlocks: UnlockRegistry;
  lastDirectOrderSol: number;
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
  /** Manufactured components on the racks, in whole units (P5). */
  components: ComponentAmounts;
  fluids: FluidAmounts;
  water?: Pick<WaterState, 'active' | 'links' | 'tanks'>;
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
  tutorial?: TutorialState | null;
  /** v15 — engineering projects (Phase 2). Absent on older colonies. */
  objectives?: ObjectiveSave | null;
  /** v15 — unlock registry + the direct-order marker (Phase 2). */
  unlocks?: UnlockSave | null;
}

/**
 * Loose historical save — used as input to migrations. Version may be <11,
 * fields may be missing. This is intentionally `any`-like but typed as unknown
 * record for migration functions to narrow.
 */
export type HistoricalSave = Record<string, unknown> & { version?: unknown };
