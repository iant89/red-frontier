/**
 * Phase 2 — the shape of an Engineering Project.
 *
 * The review's constraint (§3.4), kept verbatim as a design rule:
 *
 *   > no project logic in code, only in data tables.
 *
 * That is why a project's requirements are **declarative** — small records the
 * system evaluates against `ColonyState` — rather than predicate functions.
 * A predicate would put campaign logic in TypeScript and make Phase 9 (the
 * campaign) another system instead of content authoring. With this shape, a
 * chapter is a list of these records with different numbers.
 *
 * Player-facing copy lives here with the data, the way blueprint labels live in
 * `defs.ts`: it is content, not HUD template literal.
 */

import type { BuildingKind, ComponentId, FluidId, ResourceId } from '../defs';
import type { DifficultyId } from '../difficulty';
import type { UnlockId } from '../unlocks';

/**
 * A number that may vary by difficulty. A plain number is the same on every
 * difficulty; a table is read by `ColonyState.difficulty`, falling back to
 * `pioneer` (the balanced campaign) for a difficulty the table omits. This is
 * how the review's "3 sols settler / 5 pioneer" (§3.2) lives in the data
 * table instead of in a branch in the evaluator.
 */
export type ScaledNumber = number | Partial<Record<DifficultyId, number>>;

/** The per-rover automation switches a project can ask for. */
export type ProjectRuleId = 'autoHaul' | 'autoService' | 'stormShelter' | 'autoRescue';

/** How a requirement's numbers should be read aloud. */
export type RequirementUnit = 'count' | 'kg' | 'kWh' | 'sols' | 'percent';

export type Requirement =
  /** N of a building kind standing, online and undamaged. */
  | { type: 'buildingOnline'; building: BuildingKind; count: number; label: string }
  /** Bulk solid in the colony ledger (proves something was mined and hauled). */
  | { type: 'storage'; resource: ResourceId; kg: number; label: string }
  /** Finished units racked in a workshop. */
  | { type: 'components'; component: ComponentId; count: number; label: string }
  /** A fluid held in the tanks right now. */
  | { type: 'fluidAmount'; fluid: FluidId; kg: number; label: string }
  /** Grid storage capacity, from online batteries plus the pod's own pack. */
  | { type: 'batteryCapacity'; kWh: number; label: string }
  /**
   * Power is not browning out *and* the reserve is above a floor. The floor is
   * a fraction of capacity, so "enough battery to ride out the night" scales
   * with how much battery the player chose to build.
   */
  | { type: 'powerStable'; minStoredFrac: number; label: string }
  /** Rovers with an automation rule switched on. */
  | { type: 'roverRule'; rule: ProjectRuleId; count: number; label: string }
  /** Rovers running a repeating mine → haul loop. */
  | { type: 'repeatRoute'; count: number; label: string }
  /** Fleet size — a bigger fleet is what makes distant work survivable. */
  | { type: 'roverCount'; count: number; label: string }
  /** Storms weathered, from the tutorial's lifetime counters. */
  | { type: 'stormsSurvived'; count: number; label: string }
  /** Sites found on the map. */
  | { type: 'poisDiscovered'; count: number; label: string }
  /**
   * Sols since the player last issued a direct order. This is the flagship
   * requirement and the reason `ColonyState.lastDirectOrderSol` exists in this
   * phase: AUTONOMY.md (Phase 3) will own the full three-faced autonomy stat,
   * but the streak it is measured from has to be recorded from sol 1.
   */
  | { type: 'solsWithoutOrder'; sols: ScaledNumber; label: string };

export type RequirementType = Requirement['type'];

export type ProjectId =
  | 'establishSurvival'
  | 'surviveFirstStorm'
  | 'industrialize'
  | 'remoteOperations'
  | 'autonomousColony';

export interface ProjectDef {
  id: ProjectId;
  title: string;
  /** What the player is being asked to do, in one sentence. */
  blurb: string;
  /**
   * Projects that must be completed before this one is offered. Empty means it
   * is on the board from sol 1 — the first project the colony ever sees.
   */
  after: ProjectId[];
  /** Every requirement must hold on the same tick for the project to land. */
  requirements: Requirement[];
  /** Unlocks granted the tick the project completes. */
  rewards: UnlockId[];
  /**
   * Why the player should care, in the roadmap's own voice. Shown under the
   * requirements so the panel answers "so what?" without a tutorial line.
   */
  why: string;
}

/** One requirement's live numbers, for the panel's progress rows. */
export interface RequirementProgress {
  /** Stable within a project: `type` plus the thing it counts. */
  key: string;
  label: string;
  current: number;
  target: number;
  unit: RequirementUnit;
  met: boolean;
}

/** One earned unlock, sol-stamped for the report (P11). */
export interface UnlockSummary {
  id: UnlockId;
  title: string;
  sol: number;
}

/** One landed project, sol-stamped. */
export interface CompletedSummary {
  id: ProjectId;
  title: string;
  sol: number;
}

/**
 * The whole objectives board as plain data — the shape that crosses the host
 * boundary. `host/viewModels.ts`'s `ObjectiveView` is the readonly mirror of it.
 */
export interface ObjectiveSnapshot {
  active: ProjectProgress[];
  completed: CompletedSummary[];
  unlocks: UnlockSummary[];
  /** Sols since the last direct order — the autonomy streak (AUTONOMY.md). */
  solsWithoutOrder: number;
}

/** A project as the panel reads it: identity, progress, and what it pays. */
export interface ProjectProgress {
  id: ProjectId;
  title: string;
  blurb: string;
  why: string;
  requirements: RequirementProgress[];
  /** Requirements met, and how many there are — the panel's headline number. */
  met: number;
  total: number;
  rewards: Array<{ id: UnlockId; title: string; granted: boolean }>;
}
