/**
 * Immutable presentation view models for SimView (Phase 20).
 *
 * Plain readonly data only — no class instances, no mutator methods. Projection
 * (`projectView`) is the sole producer; LocalSimHost and WorkerSimHost both
 * surface these through the same ColonyMirror path so presentation reads are
 * semantically equivalent across transports.
 */

import type { EngineeringState, UpgradeLevels, UpgradeJob } from '../engineering/upgrades';
import type {
  BuildingKind,
  ComponentAmounts,
  FluidId,
  ResourceAmounts,
  RoverKind,
} from '../defs';
import type { PartReplacement } from '../state/BuildingState';
import type { Alert, LogEvent, Severity } from '../alerts';
import type { FluidFlow, HistorySample, SolHistoryRow } from '../Simulation';
import type {
  RoverGoal,
  RoverPhase,
  RoverRules,
  RoverPartHealth,
  RoverTask,
} from '../state/RoverState';
import type { ColonistActivity, ColonistOrder } from '../lifesupport';
import type { StormCell, StormKind, StormKindReal, WeatherRadar } from '../weather';
import type { TutorialState, MilestoneId, WarningId, HintId } from '../state/TutorialState';

/**
 * Phase 2 — one requirement's live numbers on a project card. `label` is copy
 * from the project data table; the numbers are what the sim evaluated this
 * tick, so the panel never recomputes them.
 */
export interface ObjectiveRequirementView {
  readonly key: string;
  readonly label: string;
  readonly current: number;
  readonly target: number;
  readonly unit: 'count' | 'kg' | 'kWh' | 'sols' | 'percent';
  readonly met: boolean;
}

/** Phase 2 — a project on the board, with its progress and what it pays. */
export interface ObjectiveProjectView {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly why: string;
  readonly requirements: ReadonlyArray<ObjectiveRequirementView>;
  readonly met: number;
  readonly total: number;
  readonly rewards: ReadonlyArray<{ readonly id: string; readonly title: string; readonly granted: boolean }>;
}

/** Phase 3 — the autonomy stat (AUTONOMY.md): one number, three faces, one rung. */
export interface AutonomyView {
  /** Sols the open hands-off window has run. */
  readonly current: number;
  readonly best: number;
  readonly lifetimeSols: number;
  readonly rung: 'manual' | 'assisted' | 'automated' | 'redundant' | 'autonomous';
  readonly bestRung: 'manual' | 'assisted' | 'automated' | 'redundant' | 'autonomous';
  readonly identity: 'operator' | 'engineer' | 'architect';
  /** Fraction of recent rover work that was self-directed, [0, 1]. */
  readonly coverage: number;
  /** Critical chains still below their redundancy gate. */
  readonly singlePoints: ReadonlyArray<string>;
  readonly lastBreak: { readonly at: number; readonly reason: string; readonly streak: number; readonly detail: string } | null;
}

/** Phase 3 — the standing orders as the panel reads them. */
export interface PolicyView {
  readonly unlocked: boolean;
  readonly stockpile: { readonly on: boolean; readonly resource: string; readonly minKg: number; readonly currentKg: number };
  readonly nightPower: { readonly on: boolean; readonly minBatteryPct: number; readonly shedding: number };
  readonly stormShelter: { readonly on: boolean };
  readonly autoMaintain: { readonly on: boolean; readonly maxWearPct: number; readonly worstWearPct: number };
  readonly actions: number;
  readonly lines: Readonly<Record<'stockpile' | 'nightPower' | 'stormShelter' | 'autoMaintain', string>>;
}

/** Phase 2 — the board: what is offered, what landed, what was earned. */
export interface ObjectiveView {
  readonly active: ReadonlyArray<ObjectiveProjectView>;
  readonly completed: ReadonlyArray<{ readonly id: string; readonly title: string; readonly sol: number }>;
  readonly unlocks: ReadonlyArray<{ readonly id: string; readonly title: string; readonly sol: number }>;
  /** Sols since the last direct order — the autonomy streak (AUTONOMY.md §4.1). */
  readonly solsWithoutOrder: number;
}

export interface TutorialView {
  readonly milestones: Readonly<Record<MilestoneId, { completed: boolean; sol: number; tick: number }>>;
  readonly activeWarnings: ReadonlyArray<WarningId>;
  readonly nextHint: HintId | null;
  readonly funnel: ReadonlyArray<{ id: string; type: string; sol: number; tick: number; at: number }>;
  readonly stats: Readonly<{ moves: number; mines: number; hauls: number; builds: number; automations: number; stormsSurvived: number }>;
}

/** One rover as the HUD / renderer may see it — nested bags are owned copies. */
export interface RoverView {
  readonly upgrades?: Readonly<UpgradeLevels>;
  readonly upgradeJob?: Readonly<UpgradeJob> | null;
  readonly paint?: string | null;
  readonly id: number;
  readonly kind: RoverKind;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly battery: number;
  readonly cargo: Readonly<ResourceAmounts>;
  readonly phase: RoverPhase;
  readonly command: Readonly<RoverTask>;
  readonly pending: ReadonlyArray<Readonly<RoverTask>>;
  readonly goal: RoverGoal;
  readonly gx: number;
  readonly gz: number;
  readonly gid: number;
  readonly recharge: boolean;
  readonly lowBatteryNotified: boolean;
  readonly chargeSat: number;
  readonly autoTask: boolean;
  readonly condition: number;
  readonly parts: Readonly<RoverPartHealth>;
  readonly rules: Readonly<RoverRules>;
  readonly routePaused: boolean;
  readonly blockNotified: boolean;
  readonly sheltered: boolean;
  readonly lightsOn: boolean;
  readonly lightsActive: boolean;
  readonly navPath: ReadonlyArray<{ readonly x: number; readonly z: number }>;
  readonly navI: number;
}

/** One building as presentation reads it. */
export interface BuildingView {
  readonly upgrades?: Readonly<UpgradeLevels>;
  readonly upgradeJob?: Readonly<UpgradeJob> | null;
  readonly paint?: string | null;
  readonly id: number;
  readonly kind: BuildingKind;
  readonly x: number;
  readonly z: number;
  readonly rot: number;
  readonly state: 'site' | 'building' | 'online';
  readonly remainingCost: Readonly<ResourceAmounts>;
  readonly needsMaterials: boolean;
  readonly progress: number;
  readonly buildTime: number;
  readonly workerId: number | null;
  readonly enabled: boolean;
  readonly powerSat: number;
  readonly throughput: number;
  readonly genKw: number;
  readonly loadKw: number;
  readonly idleReason: string;
  readonly health: number;
  readonly cleanliness: number;
  readonly damaged: boolean;
  readonly assembly: Readonly<{ kind: RoverKind; progress: number }> | null;
  readonly level: number;
  readonly maintenance: Readonly<PartReplacement> | null;
  /**
   * Which line this building is running (P5) — an index into `RECIPES[kind]`,
   * ignored by kinds whose blueprint has a fixed process.
   */
  readonly recipe: number;
  /** Fractional progress toward each unit still on the bench. */
  readonly craft: Readonly<ComponentAmounts>;
}

/** The colonist as presentation reads them. */
export interface ColonistView {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly health: number;
  readonly suitO2: number;
  readonly inside: boolean;
  readonly shelterId: number;
  readonly activity: ColonistActivity;
  readonly order: Readonly<ColonistOrder>;
  readonly gx: number;
  readonly gz: number;
  readonly starved: Readonly<{ oxygen: boolean; water: boolean; food: boolean }>;
  readonly dead: boolean;
}

/**
 * Storage / economy presentation slice — the amounts and pool capacities the
 * HUD vitals strip reads. Kept as an intersection onto SimFields so existing
 * `view.storage` / `view.pools` accessors stay identical.
 */
export interface ResourceView {
  readonly storage: Readonly<ResourceAmounts>;
  readonly pools: {
    readonly amounts: Readonly<Record<FluidId, number>>;
    readonly capacity: Readonly<Record<FluidId, number>>;
  };
  readonly flows: Readonly<Record<FluidId, Readonly<FluidFlow>>>;
  readonly lastFlows: Readonly<Record<FluidId, Readonly<FluidFlow>>>;
  readonly history: ReadonlyArray<Readonly<HistorySample>>;
  /** Phase 4 — the downsampled one-row-per-sol record (dashboard's sols view). */
  readonly solHistory: ReadonlyArray<Readonly<SolHistoryRow>>;
  readonly storedKWh: number;
  /**
   * Manufactured components (P5): whole units on the rack. Counted, not
   * weighed, so they are deliberately *not* part of `storage`.
   */
  readonly components: Readonly<ComponentAmounts>;
}

/** One active alert on the board (plain data). */
export type AlertView = Readonly<Alert>;

/** The alert board, read-only — raising/clearing is sim-internal. */
export interface AlertsView {
  list(): ReadonlyArray<AlertView>;
  history(): ReadonlyArray<LogEvent>;
  worst(): Severity | null;
  isActive(key: string): boolean;
}

/**
 * Weather as a snapshot of the sky. Explicit interface (not Pick of Weather)
 * because the mirror is not a Weather instance.
 */
export interface WeatherView {
  readonly time: number;
  readonly windSpeed: number;
  readonly windDirRad: number;
  readonly dust: number;
  readonly visibility: number;
  readonly storm: StormKind;
  readonly stormIntensity: number;
  readonly solarTransmission: number;
  readonly radar: Readonly<WeatherRadar>;
  readonly lightning: { readonly x: number; readonly z: number; readonly t: number } | null;
  readonly rollsSuppressed: boolean;
  forecast(): { kind: StormKind; label: string; arrivesIn: number } | null;
  current(): StormCell | null;
  threat(): {
    kind: StormKindReal;
    label: string;
    distKm: number;
    bearingRad: number;
    arrivesIn: number;
    radiusKm: number;
  } | null;
  passesIn(): number;
}
