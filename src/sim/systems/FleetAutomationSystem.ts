/**
 * Phase 12 — Extract FleetAutomationSystem
 *
 * Goal per roadmap §16: move the colony's *autonomous fleet decision-making*
 * out of `Simulation.ts`, and write the decision model down while doing it.
 * Phase 10 moved what a rover does once it has a task; this moves who gets
 * which task when nobody asked.
 *
 * ---------------------------------------------------------------------------
 * The job model
 * ---------------------------------------------------------------------------
 *
 * A job is a unit of unattended work the colony wants done, before any rover is
 * attached to it. Evaluators produce candidates; the pipeline filters, orders,
 * reserves and assigns them:
 *
 *     evaluate (pure)        priority + urgency + requirements
 *         ↓
 *     filter                 the shelter order, "someone is already on it"
 *         ↓
 *     order                  TDD §8 band, then the job's own urgency key
 *         ↓
 *     reserve                the rover or the seam is claimed
 *         ↓
 *     assign                 `RoverSystem.autoAssign`
 *
 * The evaluators are plain functions, not classes (roadmap §16):
 *
 *     maintenanceJobs()   repair (worst health first), then clean (dirtiest first)
 *     rescueJobs()        stranded rovers nobody is on the way to
 *     haulDemand()        the build queue's shortfall + the standing ice order
 *     pickHaul()          the seam one rover should work, scored
 *     waitingSite()       the construction job that holds a rover back
 *
 * **Every evaluator is fleet-major except the haul one.** A seam's score is
 * `distance ÷ demand`, so the best seam for one rover is not the best for
 * another; the haul evaluator therefore scores *for a given rover*, which is
 * exactly what the pre-extraction code did. Documented rather than "fixed":
 * the roadmap's gate for this phase is that automation behavior stays
 * equivalent, and unifying the scorers is the optimization that follows.
 *
 * ---------------------------------------------------------------------------
 * What moved, and what deliberately did not
 * ---------------------------------------------------------------------------
 *
 * Moved here (verbatim from `Simulation.ts`):
 *   - `assignMaintenance` — damaged structures first (survival), then solar
 *     arrays past the cleanliness threshold, one job per idle rover.
 *   - `assignRescues` — stranded rovers, nearest capable volunteer with the
 *     spare charge for the gift *and* its own ride home.
 *   - `assignSupplyRuns` — the haul ledger (build shortfall + ice buffer) and
 *     the deposit scorer, including the two hold-backs that reserve a rover for
 *     construction and for maintenance.
 *   - `maintenancePending` / `servicingRover` — the questions those passes ask.
 *
 * Stayed in `RoverSystem` (Phase 10's per-rover tick), because it is a
 * one-rover decision evaluated every tick, not a fleet dispatch:
 *   - **Charging** (the ride-home floor) and **storm shelter** (the recall).
 *     Roadmap §16 lists them among these responsibilities; the *fleet* half of
 *     both is here — the dispatch pools skip rovers that are charging or
 *     sheltering, and the storm order cancels the maintenance and rescue passes
 *     ({@link filterJobs}). The per-rover rule itself stays next to the task
 *     loop that obeys it, so there is still exactly one source of truth for
 *     "when does this rover break off"; duplicating the floor maths here would
 *     create a second one.
 *   - Site crew choice (`ConstructionSystem.assignBuilders`, Phase 9) — this
 *     system only *reserves* a rover for it, via {@link waitingSite}.
 *
 * Cross-domain seam — the haul ledger is LogisticsSystem's (Phase 13):
 *
 *   - {@link FleetAutomationHostHooks.canDeliverCargo} — "is this rover stuck
 *     on cargo the silos cannot take". Simulation implements it against the
 *     same `canDeliverAny` already wired into the construction and rover hooks;
 *     one answer, three callers.
 *
 * Determinism: no RNG, no wall clock, no DOM. Every draw is from state the
 * simulation already owns, and the tie-breaks (`|| id`, stable sort order) are
 * the ones the old passes used.
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, hosts, persistence schema.
 */

import type { ColonyState } from '../state/ColonyState';
import type { Building } from '../state/BuildingState';
import { remainingCostTotal } from '../state/BuildingState';
import type { Rover, RoverRules } from '../state/RoverState';
import { cargoMass } from '../state/RoverState';
import { RoverSystem } from './RoverSystem';
import { LogisticsSystem } from './LogisticsSystem';
import type { Deposit } from '../World';
import type { ResourceAmounts, ResourceId } from '../defs';
import { ALL_RESOURCES, BUILDINGS, RESOURCES, ROVERS, emptyAmounts } from '../defs';
import { AUTO_CLEAN_THRESHOLD, HOURS_PER_SEC, RECOVER_MIN_GIVE_KWH } from '../config';
import { clamp } from '../../lib/rng';
import type { Severity } from '../alerts';

/**
 * Cross-domain answers the fleet asks but does not own. Implemented by
 * `Simulation` against the machinery that already lives there.
 */
export interface FleetAutomationHostHooks {
  /** True if any of this rover's cargo would currently fit in storage. */
  canDeliverCargo(r: Rover): boolean;
}

// ------------------------------------------------------------- the model ----

/** The kinds of unattended work the colony dispatches. */
export type FleetJobKind = 'repair' | 'clean' | 'rescue' | 'haul';

/**
 * TDD §8's dispatch order as numbers a sort can use. Survival first, then the
 * build queue, then routine chores: a stranded rover or a damaged structure
 * outranks a haul, and keeping a site staffed outranks fetching ice.
 */
export const JOB_PRIORITY = {
  survival: 0,
  construction: 1,
  routine: 2,
} as const;

/** The fields ordering and the shelter filter need, and nothing else. */
export interface JobOrderKey {
  /** TDD §8 band; lower runs first. */
  priority: number;
  /**
   * Within a band, lower runs first. The *same* key the pre-extraction sort
   * used (buildings: health or cleanliness; rescue: fleet order; haul: the seam
   * score) — the heuristics are per-kind on purpose, because roadmap §16's gate
   * is that automation behavior stays equivalent *before* scoring is unified.
   */
  urgency: number;
  /** Work a shelter order calls off (maintenance and rescue, but not hauling). */
  stormBlocked: boolean;
}

/** Everything else a job says before a rover is chosen for it. */
export interface JobScore extends JobOrderKey {
  /** The per-rover rule this kind respects (`null` = every rover qualifies). */
  rule: keyof RoverRules | null;
  /** The energy the job costs, kWh (`null` = nothing to budget). */
  energyKWh: number | null;
}

/** A repair or cleaning job, from {@link maintenanceJobs}. */
export type MaintenanceJob = JobScore & { kind: 'repair' | 'clean'; building: Building };

/** A rescue job, from {@link rescueJobs}. */
export type RescueJob = JobScore & { kind: 'rescue'; stranded: Rover; energyKWh: number };

/** Any unattended job, before a rover is attached to it. */
export type FleetJob = MaintenanceJob | RescueJob;

// ------------------------------------------------------------- inquiries ----

/**
 * The dispatch pool: nothing to do, and able to do it. The flags are
 * asymmetric because the passes that use them are — that asymmetry is current
 * behavior, preserved here and called out with it:
 *
 *   maintenance   skips the sheltered, ignores the queue
 *   rescue        skips the sheltered, requires an empty queue
 *   haul          *keeps* the sheltered (a sheltering rover is recharging,
 *                 which already excludes it), ignores the queue
 */
export function idlePool(
  state: ColonyState,
  opts: { excludeSheltered?: boolean; requireEmptyQueue?: boolean } = {},
): Rover[] {
  return state.rovers.filter(
    (r) =>
      r.phase !== 'disabled' &&
      !r.recharge &&
      (!opts.excludeSheltered || !r.sheltered) &&
      r.command.type === 'idle' &&
      (!opts.requireEmptyQueue || r.pending.length === 0),
  );
}

/** True when a rover is already en route to (or working on) this building. */
export function servicingRover(state: ColonyState, buildingId: number): boolean {
  return state.rovers.some(
    (r) =>
      (r.command.type === 'repair' || r.command.type === 'clean') &&
      r.command.buildingId === buildingId,
  );
}

/** True when a repair or cleaning job is waiting for a free rover. */
export function maintenancePending(state: ColonyState): boolean {
  for (const b of state.buildings) {
    if (b.state !== 'online' || servicingRover(state, b.id)) continue;
    if (b.damaged) return true;
    if (BUILDINGS[b.kind].generation === 'solar' && b.cleanliness < AUTO_CLEAN_THRESHOLD) {
      return true;
    }
  }
  return false;
}

/** True while the weather says every rover should be heading for shelter. */
export function isStormBlocked(state: ColonyState): boolean {
  return state.weather.shelterRovers();
}

/** Drop the jobs a shelter order cancels. */
export function filterJobs<T extends JobOrderKey>(state: ColonyState, jobs: T[]): T[] {
  if (!isStormBlocked(state)) return jobs;
  return jobs.filter((j) => !j.stormBlocked);
}

/**
 * Priority band, then urgency — a *stable* sort, so jobs the two keys tie on
 * keep the order their evaluator produced. That is deliberate: the
 * pre-extraction passes sorted repairs by `(health, id)` and cleans by
 * `(cleanliness, id)`, and those keys live in {@link maintenanceJobs} exactly
 * as they did, rather than being re-invented as tie-breaks here.
 */
export function orderJobs<T extends JobOrderKey>(jobs: T[]): T[] {
  return jobs
    .map((job, index) => ({ job, index }))
    .sort(
      (a, b) =>
        a.job.priority - b.job.priority || a.job.urgency - b.job.urgency || a.index - b.index,
    )
    .map(({ job }) => job);
}

// ----------------------------------------------------------- evaluators ----

/**
 * Repair jobs (worst health first) then cleaning jobs (dirtiest array first).
 * TDD §8: a damaged structure is survival-critical, a dirty panel is routine.
 */
export function maintenanceJobs(state: ColonyState): MaintenanceJob[] {
  const repairs = state.buildings
    .filter((b) => b.state === 'online' && b.damaged)
    .sort((a, c) => a.health - c.health || a.id - c.id)
    .map<MaintenanceJob>((b) => ({
      kind: 'repair',
      building: b,
      priority: JOB_PRIORITY.survival,
      urgency: b.health,
      stormBlocked: true,
      rule: null, // repairs ignore the auto-service opt-out: too important
      energyKWh: null,
    }));
  const cleans = state.buildings
    .filter(
      (b) =>
        b.state === 'online' &&
        !b.damaged &&
        BUILDINGS[b.kind].generation === 'solar' &&
        b.cleanliness < AUTO_CLEAN_THRESHOLD,
    )
    .sort((a, c) => a.cleanliness - c.cleanliness || a.id - c.id)
    .map<MaintenanceJob>((b) => ({
      kind: 'clean',
      building: b,
      priority: JOB_PRIORITY.construction,
      urgency: b.cleanliness,
      stormBlocked: true,
      rule: 'autoService',
      energyKWh: null,
    }));
  return [...repairs, ...cleans];
}

/**
 * Stranded rovers nobody is already on the way to, in fleet order. The rescue
 * itself needs a volunteer with spare charge — a per-*candidate* question,
 * answered by {@link rescueFeasible} against the job's `energyKWh` (the gift
 * the stranded rover needs to get home).
 */
export function rescueJobs(state: ColonyState): RescueJob[] {
  return state.rovers
    .filter((s) => s.phase === 'disabled' && !RoverSystem.rescueTargeted(state, s.id))
    .map((s) => ({
      kind: 'rescue',
      stranded: s,
      priority: JOB_PRIORITY.survival,
      urgency: 0, // nearest-first is decided against the candidate, not the job
      stormBlocked: true,
      rule: 'autoRescue',
      energyKWh: rescueGiftKWh(state, s),
    }));
}

/** The charge a stranded rover needs handed to it to get home (TDD §8). */
export function rescueGiftKWh(state: ColonyState, stranded: Rover): number {
  const sDef = ROVERS[stranded.kind];
  const home = RoverSystem.nearestChargerPoint(state, stranded.x, stranded.z);
  return Math.max(
    RoverSystem.travelKWh(stranded.x, stranded.z, home.x, home.z, sDef) * 1.25,
    sDef.maxBatteryKWh * 0.15,
  );
}

/**
 * Can this rover deliver `giftKWh` and still get itself home? Energy maths
 * instead of vibes — the rest of TDD §8's RECOVER contract (sizing the transfer
 * to what the volunteer can spare) lives in `RoverSystem.doRecover`; this is
 * the dispatch-time filter that keeps a weak volunteer from being sent out.
 */
export function rescueFeasible(
  state: ColonyState,
  cand: Rover,
  stranded: Rover,
  giftKWh: number,
): boolean {
  const rDef = ROVERS[cand.kind];
  const home = RoverSystem.nearestChargerPoint(state, stranded.x, stranded.z);
  const reserve = Math.max(
    rDef.maxBatteryKWh * (cand.rules.chargeFloorPct / 100),
    RoverSystem.travelKWh(stranded.x, stranded.z, home.x, home.z, rDef) * 1.15,
  );
  const outAndBack = RoverSystem.travelKWh(cand.x, cand.z, stranded.x, stranded.z, rDef);
  return cand.battery - reserve - outAndBack >= Math.max(giftKWh, RECOVER_MIN_GIVE_KWH);
}

/**
 * How much of each resource the colony is short of, in kilograms: what the
 * unfinished build queue still needs on hand, plus the standing ice order.
 *
 * Ice is not a build cost — the extractor burns it continuously, so the colony
 * wants a buffer *before* the extractor exists, weighted by how thin the water
 * reserve actually is.
 */
export function haulDemand(state: ColonyState): ResourceAmounts {
  const shortfall = emptyAmounts();
  for (const b of state.buildings) {
    if (b.state === 'online') continue;
    for (const res of ALL_RESOURCES) {
      const need = b.remainingCost[res] - state.storage[res];
      if (need > 0) shortfall[res] += need;
    }
  }
  const wantsIce =
    state.buildings.some((b) => b.kind === 'extractor') ||
    state.pools.amounts.water < state.pools.capacity.water * 0.5;
  if (wantsIce) {
    const target = LogisticsSystem.capacity(state) * 0.6;
    if (state.storage.ice < target) {
      const urgency =
        state.pools.capacity.water > 0
          ? 1 + 3 * (1 - clamp(state.pools.amounts.water / state.pools.capacity.water, 0, 1))
          : 1;
      shortfall.ice += (target - state.storage.ice) * urgency;
    }
  }
  return shortfall;
}

/** The resources worth hauling, scarcest first (and only where there is room). */
export function haulWanted(state: ColonyState, shortfall: ResourceAmounts): ResourceId[] {
  return ALL_RESOURCES.filter(
    (r) => shortfall[r] > 1 && LogisticsSystem.room(state, r) > 1,
  ).sort((a, b) => shortfall[b] - shortfall[a]);
}

/** What one rover's round trip to a seam costs: travel out and back, plus the dig. */
export function haulTripKWh(
  rover: Rover,
  dep: Deposit,
  res: ResourceId,
): { oneWayKWh: number; totalKWh: number } {
  const rd = ROVERS[rover.kind];
  const oneWayKWh = RoverSystem.travelKWh(rover.x, rover.z, dep.x, dep.z, rd);
  const loadTimeS = 60 / (RESOURCES[res].mineRateKg * rd.mineSpeedMul);
  const digKWh = rd.workPowerKw * HOURS_PER_SEC * loadTimeS;
  return { oneWayKWh, totalKWh: oneWayKWh * 2 + digKWh };
}

/**
 * Can this rover physically get to the seam, dig a worthwhile load, *and get
 * home*? A naive range heuristic (battery × constant) once dispatched both
 * rovers beyond round-trip range and stranded the entire fleet — found by the
 * weather suite. The low-battery reserve that aborts the dig must still cover
 * the ride home.
 */
export function canMakeRun(rover: Rover, dep: Deposit, res: ResourceId): boolean {
  const rd = ROVERS[rover.kind];
  const { oneWayKWh, totalKWh } = haulTripKWh(rover, dep, res);
  const reserveKWh = Math.max(
    rd.maxBatteryKWh * (rover.rules.chargeFloorPct / 100),
    oneWayKWh * 1.15,
  );
  return totalKWh <= rover.battery - reserveKWh;
}

/**
 * The seam this rover should work, or null. Two tiers, because a reservation
 * steers the fleet apart but must never idle a capable rover: the best
 * *unclaimed* seam by score, else — if that one is out of energy range — the
 * best seam another auto-run holds. Sharing a seam is always physically
 * possible; only a worked-out scrap heap is held against a second rover.
 */
export function pickHaul(
  state: ColonyState,
  rover: Rover,
  wanted: readonly ResourceId[],
  shortfall: ResourceAmounts,
): { deposit: Deposit; resource: ResourceId; score: number; energyKWh: number } | null {
  let picked: Deposit | null = null;
  let pickedRes: ResourceId | null = null;
  let bestScore = Infinity;
  let shared: Deposit | null = null;
  let sharedRes: ResourceId | null = null;
  let sharedScore = Infinity;

  for (const res of wanted) {
    for (const d of state.world.deposits) {
      if (d.resource !== res || d.amount <= 0) continue;
      // Prefer close deposits, and rate the scarcest resource highest.
      const dist = Math.hypot(d.x - rover.x, d.z - rover.z);
      const score = dist / (1 + shortfall[res] / 100);
      const held =
        d.reservedBy != null &&
        d.reservedBy !== rover.id &&
        d.amount <= ROVERS[rover.kind].capacityKg * 2.5;
      if (held) {
        if (score < sharedScore) {
          sharedScore = score;
          shared = d;
          sharedRes = res;
        }
      } else if (score < bestScore) {
        bestScore = score;
        picked = d;
        pickedRes = res;
      }
    }
  }

  if (picked && pickedRes && !canMakeRun(rover, picked, pickedRes)) {
    picked = null;
    pickedRes = null;
  }
  if (picked && pickedRes) {
    return {
      deposit: picked,
      resource: pickedRes,
      score: bestScore,
      energyKWh: haulTripKWh(rover, picked, pickedRes).totalKWh,
    };
  }
  if (shared && sharedRes && canMakeRun(rover, shared, sharedRes)) {
    return {
      deposit: shared,
      resource: sharedRes,
      score: sharedScore,
      energyKWh: haulTripKWh(rover, shared, sharedRes).totalKWh,
    };
  }
  return null;
}

/**
 * The construction job that reserves a rover: a fully-stocked site nobody is
 * building yet. TDD §8 puts construction above production logistics, so the
 * haul pass holds one capable rover back rather than sending the whole fleet
 * out for ice and never building anything.
 */
export function waitingSite(state: ColonyState): Building | null {
  return (
    state.buildings.find(
      (b) => b.state !== 'online' && b.workerId === null && remainingCostTotal(b) <= 0,
    ) ?? null
  );
}

/**
 * The reservation step for the haul pass, expressed as exclusions: take the
 * rovers the higher-priority passes are entitled to off the list, and return
 * the pool that is genuinely spare.
 */
export function reserveForHigherPriority(
  state: ColonyState,
  pool: Rover[],
  hooks: FleetAutomationHostHooks,
): Rover[] {
  let spare = pool;

  const site = waitingSite(state);
  if (site) {
    const reserved = spare.find(
      (r) =>
        BUILDINGS[site.kind].buildableBy.includes(r.kind) &&
        (cargoMass(r) <= 0.01 || !hooks.canDeliverCargo(r)),
    );
    if (reserved) spare = spare.filter((r) => r !== reserved);
    if (spare.length === 0) return spare;
  }

  // Same idea, storm edition: a damaged structure or a buried solar array
  // outranks a routine haul, so keep one rover free for dispatchMaintenance.
  if (maintenancePending(state)) {
    spare = spare.slice(1);
  }
  return spare;
}

// ------------------------------------------------------------- dispatch ----

/** Repair first, then clean — one job per idle rover, in priority order. */
export function dispatchMaintenance(state: ColonyState): void {
  const jobs = orderJobs(filterJobs(state, maintenanceJobs(state)));
  if (jobs.length === 0) return;

  const pool = idlePool(state, { excludeSheltered: true });
  if (pool.length === 0) return;

  for (const job of jobs) {
    if (servicingRover(state, job.building.id)) continue;
    const idx = pool.findIndex((r) => job.rule === null || r.rules[job.rule]);
    if (idx < 0) return; // the pool is spent — nothing else can be staffed
    const rover = pool[idx];
    pool.splice(idx, 1);
    RoverSystem.autoAssign(rover, { type: job.kind, buildingId: job.building.id });
  }
}

/** One volunteer per stranded rover: nearest first, with the charge to spare. */
export function dispatchRescues(state: ColonyState): void {
  const jobs = orderJobs(filterJobs(state, rescueJobs(state)));
  if (jobs.length === 0) return;

  for (const job of jobs) {
    const stranded = job.stranded;
    const pool = idlePool(state, { excludeSheltered: true, requireEmptyQueue: true }).filter(
      (r) => r.id !== stranded.id,
    );
    if (pool.length === 0) continue;
    pool.sort(
      (a, c) =>
        Math.hypot(a.x - stranded.x, a.z - stranded.z) -
          Math.hypot(c.x - stranded.x, c.z - stranded.z) || a.id - c.id,
    );
    for (const cand of pool) {
      if (job.rule !== null && !cand.rules[job.rule]) continue;
      if (!rescueFeasible(state, cand, stranded, job.energyKWh)) continue;
      RoverSystem.autoAssign(cand, { type: 'recover', roverId: stranded.id });
      log(state, 'info', `${cand.label} is heading out to jump-start ${stranded.label}.`);
      break;
    }
  }
}

/**
 * Send idle rovers out for what the build queue is short of. Rover-major: each
 * rover is matched to its own best seam, and the demand ledger is spent as
 * assignments are made, so the next rover scores against what is still missing
 * rather than chasing a load the fleet already covers.
 */
export function dispatchSupplyRuns(state: ColonyState, hooks: FleetAutomationHostHooks): void {
  const idle = reserveForHigherPriority(state, idlePool(state), hooks);
  if (idle.length === 0) return;

  const shortfall = haulDemand(state);
  const wanted = haulWanted(state, shortfall);
  if (wanted.length === 0) return;

  for (const rover of idle) {
    if (!rover.rules.autoHaul) continue;
    const pick = pickHaul(state, rover, wanted, shortfall);
    if (!pick) continue;
    RoverSystem.autoAssign(rover, { type: 'mine', depositId: pick.deposit.id });
    RoverSystem.claimDeposit(state, rover, pick.deposit.id);
    shortfall[pick.resource] -= ROVERS[rover.kind].capacityKg;
    if (shortfall[pick.resource] <= 1) {
      const i = wanted.indexOf(pick.resource);
      if (i >= 0) wanted.splice(i, 1);
    }
  }
}

/** Log a fleet decision through the shared alert bus. */
function log(state: ColonyState, severity: Severity, text: string): void {
  state.alerts.event(severity, text, state.simTime, state.clock.format());
}

// ----------------------------------------------------------------- tick ----

export class FleetAutomationSystem {
  /**
   * One dispatch pass, in TDD §8 order: survival (maintenance, then rescue)
   * before the build queue before routine hauling. Each pass re-reads the idle
   * pool, so a rover claimed above is not offered twice, and player orders
   * always win — every assignment here goes through `RoverSystem.autoAssign`,
   * which is the "fill idle time" half of the task lifecycle; player orders go
   * through `giveTask` instead.
   */
  static tick(state: ColonyState, hooks: FleetAutomationHostHooks): void {
    dispatchMaintenance(state);
    dispatchRescues(state);
    dispatchSupplyRuns(state, hooks);
  }
}
