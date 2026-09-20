/**
 * ObjectiveSystem — Phase 2 Engineering Projects.
 *
 * Pure, deterministic, no DOM. Ticked after alerts and tutorial, before
 * history: a project completes on what the colony *is*, so it reads the
 * post-tick state the same way the player sees it.
 *
 * What the system does, in order, every tick:
 *
 *   1. Drop board entries the catalogue no longer knows (a hand-edited save, a
 *      project retired between builds).
 *   2. Offer every project whose `after` prerequisites have landed.
 *   3. Complete any active project whose requirements all hold, grant its
 *      unlocks through the registry, and say so on the alert bus.
 *   4. Rebuild the transient `_view` the panels read.
 *
 * What it refuses to do: hold content. Titles, numbers and rewards are data
 * (`sim/projects/catalog.ts`, `sim/unlocks.ts`). A chapter — Phase 9 — is a
 * list of those records, not a new system.
 */

import type { ColonyState } from '../state/ColonyState';
import type { ObjectiveState } from '../state/ObjectiveState';
import type {
  CompletedSummary,
  ObjectiveSnapshot,
  ProjectDef,
  ProjectProgress,
  UnlockSummary,
} from '../projects/types';
import { PROJECTS, projectById } from '../projects/catalog';
import { evaluateRequirement, requirementsMet } from '../projects/requirements';
import { ALL_UNLOCKS, UNLOCKS, grantUnlock, hasUnlock } from '../unlocks';
import type { UnlockId } from '../unlocks';

/**
 * The command families that count as a **direct order** — the thing that ends
 * an autonomy streak. An allow-list, not a deny-list, on purpose: P3's future
 * `policy/*` commands must fall outside it without anyone remembering to come
 * back and exclude them. A policy doing the work is the fantasy working.
 *
 * AUTONOMY.md (Phase 3) owns the definitive classification; this is the working
 * set Phase 2 needs so the flagship project is measurable from sol 1.
 */
const DIRECT_ORDER_PREFIXES = ['rover/', 'building/', 'water/', 'colonist/'] as const;

export function isDirectOrder(commandType: string): boolean {
  return DIRECT_ORDER_PREFIXES.some((prefix) => commandType.startsWith(prefix));
}

/** How many sols since the player last told the colony to do something. */
export function solsWithoutOrder(state: ColonyState): number {
  return Math.max(0, state.clock.sol - state.lastDirectOrderSol);
}

/** One project's live progress, for the panel. */
export function projectProgress(state: ColonyState, def: ProjectDef): ProjectProgress {
  const requirements = def.requirements.map((req) => evaluateRequirement(state, req));
  const met = requirements.reduce((n, r) => (r.met ? n + 1 : n), 0);
  return {
    id: def.id,
    title: def.title,
    blurb: def.blurb,
    why: def.why,
    requirements,
    met,
    total: requirements.length,
    rewards: def.rewards.map((id) => ({
      id,
      title: UNLOCKS[id]?.title ?? id,
      granted: hasUnlock(state.unlocks, id),
    })),
  };
}

/**
 * The board as plain data: what is on offer, what has landed, what the colony
 * has earned, and how long it has run without being told what to do. Built on
 * demand rather than only on tick, so a restore paints a correct panel before
 * the first tick lands.
 */
export function objectiveSnapshot(state: ColonyState): ObjectiveSnapshot {
  const objectives = state.objectives;
  const active = objectives.active
    .map((id) => projectById(id))
    .filter((def): def is ProjectDef => !!def)
    .map((def) => projectProgress(state, def));

  const completed: CompletedSummary[] = [];
  for (const def of PROJECTS) {
    const record = objectives.completed[def.id];
    if (!record) continue;
    completed.push({ id: def.id, title: def.title, sol: record.sol });
  }

  const unlocks: UnlockSummary[] = [];
  for (const id of ALL_UNLOCKS) {
    const record = state.unlocks[id];
    if (!record) continue;
    unlocks.push({ id, title: UNLOCKS[id].title, sol: record.sol });
  }

  return { active, completed, unlocks, solsWithoutOrder: solsWithoutOrder(state) };
}

export class ObjectiveSystem {
  /** Evaluate the board. Called from `Simulation.tick` after the tutorial. */
  static tick(state: ColonyState): void {
    const objectives: ObjectiveState = state.objectives;

    // 1. Forget ids this build's catalogue does not carry.
    if (objectives.active.some((id) => !projectById(id) || objectives.completed[id])) {
      objectives.active = objectives.active.filter((id) => projectById(id) && !objectives.completed[id]);
    }

    // 2. Offer everything whose prerequisites have landed. Catalogue order
    // keeps the board stable no matter what order projects completed in.
    for (const def of PROJECTS) {
      if (objectives.completed[def.id]) continue;
      if (objectives.active.includes(def.id)) continue;
      if (!def.after.every((id) => objectives.completed[id] != null)) continue;
      objectives.active.push(def.id);
      state.alerts.event('info', `New project — ${def.title}.`, state.simTime, state.clock.format());
      state.domainEvents.push({ type: 'objective/offered', project: def.id, sol: state.clock.sol });
    }

    // 3. Complete whatever now holds. A completion may unlock the next project,
    // but that one waits for the following tick — one change per tick is
    // easier to read in a log than a cascade.
    for (const id of [...objectives.active]) {
      const def = projectById(id);
      if (!def) continue;
      if (!requirementsMet(state, def.requirements)) continue;
      ObjectiveSystem.complete(state, def);
    }

    // 4. Rebuild the transient view the panels read.
    objectives._view = objectives.active
      .map((id) => projectById(id))
      .filter((def): def is ProjectDef => !!def)
      .map((def) => projectProgress(state, def));
  }

  /** Complete a project: stamp it, pay its rewards, and say so once. */
  static complete(state: ColonyState, def: ProjectDef): void {
    const objectives = state.objectives;
    if (objectives.completed[def.id]) return;
    objectives.completed[def.id] = { sol: state.clock.sol, tick: state.ticksRun };
    objectives.active = objectives.active.filter((id) => id !== def.id);

    for (const unlock of def.rewards) {
      if (!grantUnlock(state.unlocks, unlock, def.id, state.clock.sol, state.ticksRun)) continue;
      state.domainEvents.push({ type: 'unlock/granted', unlock, sol: state.clock.sol });
    }

    state.domainEvents.push({ type: 'objective/completed', project: def.id, sol: state.clock.sol });
    state.alerts.event('ok', `Project complete — ${def.title}.`, state.simTime, state.clock.format());
  }

  /**
   * Record a player-issued direct order. Called from the command dispatcher
   * (the single path every order takes, including across the worker boundary),
   * so a replayed transcript resets the streak exactly as the live session did.
   */
  static noteCommand(state: ColonyState, commandType: string): void {
    if (!isDirectOrder(commandType)) return;
    state.lastDirectOrderSol = state.clock.sol;
  }

  /**
   * A developer time-jump is not ten sols of autonomy. Move the marker with the
   * clock so `dev/time` cannot hand the flagship project to a cheater.
   */
  static afterTimeJump(state: ColonyState): void {
    state.lastDirectOrderSol = state.clock.sol;
  }

  /** Grant an unlock directly — POI rewards (P7) and chapters (P9) will call this. */
  static grant(state: ColonyState, id: UnlockId, source: string): boolean {
    const granted = grantUnlock(state.unlocks, id, source, state.clock.sol, state.ticksRun);
    if (granted) {
      state.domainEvents.push({ type: 'unlock/granted', unlock: id, sol: state.clock.sol });
    }
    return granted;
  }

  static has(state: ColonyState, id: UnlockId): boolean {
    return hasUnlock(state.unlocks, id);
  }
}
