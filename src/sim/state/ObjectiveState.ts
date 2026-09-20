/**
 * ObjectiveState — Phase 2 Engineering Projects.
 *
 * Tracks which projects are on the board and which have landed. Deterministic,
 * saved, no DOM.
 *
 * Deliberately small, because the review's constraint (§3.4) is that campaign
 * content is *data*: this state holds ids and sol stamps, never logic. What a
 * project asks for lives in `sim/projects/catalog.ts`; what it pays lives in
 * `sim/unlocks.ts`.
 *
 * `_view` is the per-tick transient projection the panels read. It is not saved
 * and not hashed — it is derived from `active` plus live colony state every
 * tick, exactly like `TutorialState._nextHint`.
 */

import type { ProjectId, ProjectProgress } from '../projects/types';
import { openingProjects } from '../projects/catalog';

/** When a project landed — sol-stamped so the colony report can quote it. */
export interface CompletionRecord {
  sol: number;
  tick: number;
}

export interface ObjectiveState {
  /** Projects on the board, in catalogue order. */
  active: ProjectId[];
  /** Completed projects, keyed by id. */
  completed: Partial<Record<ProjectId, CompletionRecord>>;
  /** Transient per-tick projection for the UI. Not saved, not hashed. */
  _view?: ProjectProgress[];
}

export function emptyObjectiveState(): ObjectiveState {
  return {
    // A new colony is handed its first project immediately — the P1 item the
    // roadmap deferred to this system ("the wizard hands the player their
    // first objective"). No waiting for a milestone to unlock it.
    active: openingProjects(),
    completed: {},
  };
}

export function isProjectComplete(state: ObjectiveState, id: ProjectId): boolean {
  return state.completed[id] != null;
}

export function completedProjectIds(state: ObjectiveState): ProjectId[] {
  return (Object.keys(state.completed) as ProjectId[]).filter((id) => state.completed[id] != null);
}
