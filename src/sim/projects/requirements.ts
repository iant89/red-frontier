/**
 * Phase 2 — the requirement evaluator.
 *
 * The only place a {@link Requirement} record becomes a number. It reads
 * `ColonyState` and nothing else: no RNG, no DOM, no clock of its own, so two
 * colonies in the same state evaluate the same way and a replay lands on the
 * same result.
 *
 * Every branch answers the same three questions — how far along, how much is
 * asked for, and is it met — because the panel shows all three and because a
 * requirement the UI cannot explain is a requirement that teaches nothing.
 */

import type { ColonyState } from '../state/ColonyState';
import type { Requirement, RequirementProgress, RequirementUnit, ScaledNumber } from './types';
import type { DifficultyId } from '../difficulty';

/**
 * Resolve a {@link ScaledNumber} for a difficulty. A table that omits the
 * colony's difficulty falls back to `pioneer`, then to the first value it
 * carries — a project author who writes `{ settler: 3 }` gets 3 everywhere
 * rather than a target of zero that completes on the tick it is offered.
 */
export function scaledTarget(n: ScaledNumber, difficulty: DifficultyId): number {
  if (typeof n === 'number') return n;
  const own = n[difficulty];
  if (typeof own === 'number') return own;
  if (typeof n.pioneer === 'number') return n.pioneer;
  for (const v of Object.values(n)) if (typeof v === 'number') return v;
  return 0;
}

/** A requirement's unit, so the panel can say "kg" instead of guessing. */
export function requirementUnit(req: Requirement): RequirementUnit {
  switch (req.type) {
    case 'storage':
    case 'fluidAmount':
      return 'kg';
    case 'batteryCapacity':
      return 'kWh';
    case 'solsWithoutOrder':
    case 'stormsSurvived':
      return 'sols';
    case 'powerStable':
      return 'percent';
    default:
      return 'count';
  }
}

/** Stable per-requirement key for UI row identity (and for tests to pin). */
export function requirementKey(req: Requirement): string {
  switch (req.type) {
    case 'buildingOnline':
      return `buildingOnline:${req.building}`;
    case 'storage':
      return `storage:${req.resource}`;
    case 'components':
      return `components:${req.component}`;
    case 'fluidAmount':
      return `fluidAmount:${req.fluid}`;
    case 'roverRule':
      return `roverRule:${req.rule}`;
    default:
      return req.type;
  }
}

/** A building only counts when it is finished, structurally sound and switched on. */
function onlineCount(state: ColonyState, kind: string): number {
  let n = 0;
  for (const b of state.buildings) {
    if (b.kind !== kind) continue;
    if (b.state !== 'online' || b.damaged || !b.enabled) continue;
    n++;
  }
  return n;
}

function roversWithRule(state: ColonyState, rule: string): number {
  let n = 0;
  for (const r of state.rovers) {
    if ((r.rules as unknown as Record<string, boolean>)[rule] === true) n++;
  }
  return n;
}

/**
 * Rovers working a loop rather than a one-off order: a `mine` command flagged
 * `repeat`, which is what `roverStatusText` already calls "Hauling route".
 */
function repeatRouteCount(state: ColonyState): number {
  let n = 0;
  for (const r of state.rovers) {
    if (r.command.type === 'mine' && (r.command as { repeat?: boolean }).repeat) n++;
  }
  return n;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

export function evaluateRequirement(state: ColonyState, req: Requirement): RequirementProgress {
  const key = requirementKey(req);
  const unit = requirementUnit(req);
  let current = 0;
  let target = 0;

  switch (req.type) {
    case 'buildingOnline':
      current = onlineCount(state, req.building);
      target = req.count;
      break;

    case 'storage':
      current = state.storage[req.resource] ?? 0;
      target = req.kg;
      break;

    case 'components':
      current = state.components[req.component] ?? 0;
      target = req.count;
      break;

    case 'fluidAmount':
      current = state.pools.amounts[req.fluid] ?? 0;
      target = req.kg;
      break;

    case 'batteryCapacity':
      current = state.power.capacityKWh;
      target = req.kWh;
      break;

    case 'powerStable': {
      const capacity = state.power.capacityKWh;
      const frac = capacity > 0 ? state.power.storedKWh / capacity : 0;
      const floor = clamp(req.minStoredFrac, 0, 1);
      current = Math.round(frac * 100);
      target = Math.round(floor * 100);
      // Three things have to be true at once, which is what "stable" means:
      // nothing is being shed, the batteries are above the floor, and the
      // grid is making what it is spending — a colony that is draining its
      // reserve to stay lit is surviving, not stable.
      const stable =
        !state.power.brownout &&
        capacity > 0 &&
        frac >= floor &&
        // A colony drawing nothing is not stable, it is idle: the requirement
        // is about a grid carrying a load, so it cannot be met on the tick
        // before the machines have even spun up.
        state.power.demandKw > 0 &&
        state.power.generationKw >= state.power.demandKw - 1e-6;
      return {
        key,
        label: req.label,
        current,
        target,
        unit,
        met: stable,
      };
    }

    case 'roverRule':
      current = roversWithRule(state, req.rule);
      target = req.count;
      break;

    case 'repeatRoute':
      current = repeatRouteCount(state);
      target = req.count;
      break;

    case 'roverCount':
      current = state.rovers.length;
      target = req.count;
      break;

    case 'stormsSurvived':
      current = state.tutorial.stats.stormsSurvived;
      target = req.count;
      break;

    case 'poisDiscovered': {
      let n = 0;
      for (const p of state.world.pois) if (p.discovered) n++;
      current = n;
      target = req.count;
      break;
    }

    case 'solsWithoutOrder':
      // Phase 3: the autonomy streak — it ends on an accepted order *and* on
      // any breaker, so the flagship cannot be earned by watching a colony
      // drown. Whole sols, so the number agrees with the dashboard headline.
      current = Math.floor(state.clock.solsElapsed - state.autonomy.startedAt + 1e-9);
      target = scaledTarget(req.sols, state.difficulty);
      break;
  }

  return {
    key,
    label: req.label,
    current,
    target,
    unit,
    met: current >= target,
  };
}

/** True when every requirement of a project holds on this tick. */
export function requirementsMet(state: ColonyState, reqs: readonly Requirement[]): boolean {
  for (const req of reqs) {
    if (!evaluateRequirement(state, req).met) return false;
  }
  return true;
}
