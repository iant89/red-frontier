/**
 * Simulation invariant checks — refactor roadmap Phase 1.
 *
 * The roadmap's whole plan is to move state between systems, one phase at a
 * time. That is only safe if a corrupted state is *loud*: these checks turn
 * "something drifted after the extraction" from a gameplay bug found days
 * later into an immediate, named error at the step that broke it.
 *
 * Design rules kept here:
 *
 *  - **Read-only.** `checkInvariants` inspects the simulation and reports; it
 *    never mutates state, never draws on an RNG stream, never touches the
 *    clock. Running it cannot change a deterministic replay (Golden Rule 1).
 *
 *  - **Off by default.** The checks cost a handful of microseconds per step,
 *    which is free in tests and unacceptable in a shipped worker. The suite
 *    enables them process-wide via `setInvariantChecks(true)` (see
 *    `tests/harness.ts`); the game, the worker and the browser smokes never
 *    flip that switch.
 *
 *  - **Bound to what the sim actually promises.** Two deliberate exceptions,
 *    both discovered while writing this file:
 *
 *      * Storage may legitimately sit *above* silo capacity — `demolish()`
 *        refunds delivered materials in full even when that overfills the
 *        store ("temporarily over-full, drains as it gets used"). Negative
 *        storage is still corruption.
 *      * A rover's battery may momentarily exceed `maxBatteryKWh` while a
 *        rescue jump-start is paying in its trickle (`recover` sizes the give
 *        against the ride home, not the pack's nameplate). Battery below zero
 *        is still corruption.
 *
 *    Both are documented below where the checks live. If either exception
 *    ever disappears from the sim, tighten the check to match.
 */

import { ROVERS, ALL_RESOURCES, ALL_FLUIDS } from '../defs';
import { SUIT_O2_CAPACITY } from '../config';
import type { Simulation, Rover, Building, RoverPhase, RoverTask } from '../Simulation';

/** One broken invariant. `code` is stable so tests can pin it. */
export interface InvariantViolation {
  /** Stable machine identifier, e.g. `rover-battery`. */
  code: string;
  /** What is broken, e.g. `rover #1001 (Miner)`. */
  subject: string;
  /** Full sentence for logs and errors. */
  message: string;
}

/** Error thrown by {@link assertInvariants}; carries every violation found. */
export class InvariantError extends Error {
  readonly violations: InvariantViolation[];

  constructor(violations: InvariantViolation[], label: string) {
    const lines = violations.map((v) => `  [${v.code}] ${v.message}`);
    super(
      `Simulation invariants violated (${label}):\n${lines.join('\n')}`,
    );
    this.name = 'InvariantError';
    this.violations = violations;
  }
}

/**
 * Process-wide switch. Tests turn it on once in the harness; nothing in the
 * shipped game does, so production pays nothing.
 */
let checksEnabled = false;

export function setInvariantChecks(on: boolean): void {
  checksEnabled = on;
}

export function invariantChecksEnabled(): boolean {
  return checksEnabled;
}

/**
 * Float slack for bounds that are maintained by clamping arithmetic. Anything
 * past this is corruption, not representation error.
 */
const EPS = 1e-6;

const inRange = (v: number, lo: number, hi: number): boolean =>
  Number.isFinite(v) && v >= lo - EPS && v <= hi + EPS * Math.max(1, Math.abs(hi));

const roverName = (r: Rover): string => `rover #${r.id} (${r.label})`;
const buildingName = (b: Building): string => `building #${b.id} (${b.kind})`;

// ------------------------------------------------------------- the checks ----

function checkTime(sim: Simulation, out: InvariantViolation[]): void {
  if (!Number.isFinite(sim.simTime) || sim.simTime < 0) {
    out.push({
      code: 'time-finite',
      subject: 'simulation clock',
      message: `simTime must be finite and >= 0, found ${sim.simTime}`,
    });
  }
  // ticksRun lives on ColonyState; do not reintroduce Simulation private proxies.
  if (!Number.isFinite(sim.state.ticksRun) || sim.state.ticksRun < 0) {
    out.push({
      code: 'time-finite',
      subject: 'simulation clock',
      message: `ticksRun must be finite and >= 0, found ${sim.state.ticksRun}`,
    });
  }
}

/** Unique ids within each entity family, returned as lookup sets for the
 * reference checks below. */
function checkIds(sim: Simulation, out: InvariantViolation[]): {
  rovers: Set<number>;
  buildings: Set<number>;
  pois: Set<number>;
} {
  const rovers = new Set<number>();
  for (const r of sim.rovers) {
    if (rovers.has(r.id)) {
      out.push({
        code: 'id-unique',
        subject: roverName(r),
        message: `duplicate rover id ${r.id}`,
      });
    }
    rovers.add(r.id);
  }

  const buildings = new Set<number>();
  for (const b of sim.buildings) {
    if (buildings.has(b.id)) {
      out.push({
        code: 'id-unique',
        subject: buildingName(b),
        message: `duplicate building id ${b.id}`,
      });
    }
    buildings.add(b.id);
  }

  const pois = new Set<number>();
  for (const p of sim.world.pois) {
    if (pois.has(p.id)) {
      out.push({
        code: 'id-unique',
        subject: `poi #${p.id} (${p.kind})`,
        message: `duplicate poi id ${p.id}`,
      });
    }
    pois.add(p.id);
  }

  const deposits = new Set<number>();
  for (const d of sim.world.deposits) {
    if (deposits.has(d.id)) {
      out.push({
        code: 'id-unique',
        subject: `deposit #${d.id} (${d.resource})`,
        message: `duplicate deposit id ${d.id}`,
      });
    }
    deposits.add(d.id);
  }

  return { rovers, buildings, pois };
}

function checkRovers(sim: Simulation, out: InvariantViolation[]): void {
  for (const r of sim.rovers) {
    const def = ROVERS[r.kind];
    const who = roverName(r);

    // Battery: never negative. The upper bound is deliberately generous: a
    // rescue jump-start pays its "give" into the stranded rover without
    // capping at the pack's nameplate (recover sizes the give against the
    // ride home and the rescuer's spare, not the recipient's capacity), so a
    // rover can legitimately — if briefly — carry several packs' worth. This
    // check is here to catch corruption (a botched migration writing
    // thousands of kWh), not that quirk. If the jump-start ever gains a
    // headroom cap, tighten this to `maxBatteryKWh` (see file header).
    if (!Number.isFinite(r.battery) || r.battery < 0) {
      out.push({
        code: 'rover-battery',
        subject: who,
        message: `battery must be >= 0, found ${r.battery}`,
      });
    } else if (r.battery > def.maxBatteryKWh * 3 + 10) {
      out.push({
        code: 'rover-battery',
        subject: who,
        message: `battery ${r.battery.toFixed(2)} kWh implausibly exceeds capacity ${def.maxBatteryKWh} kWh`,
      });
    }

    // Cargo: every resource non-negative, total within the hold.
    let mass = 0;
    for (const k of ALL_RESOURCES) {
      const v = r.cargo[k];
      mass += v;
      if (!Number.isFinite(v) || v < 0) {
        out.push({
          code: 'rover-cargo',
          subject: who,
          message: `cargo[${k}] must be >= 0, found ${v}`,
        });
      }
    }
    if (mass > def.capacityKg + EPS * Math.max(1, def.capacityKg)) {
      out.push({
        code: 'rover-cargo',
        subject: who,
        message: `cargo mass ${mass.toFixed(2)} kg exceeds capacity ${def.capacityKg} kg`,
      });
    }

    if (!inRange(r.condition, 0, 100)) {
      out.push({
        code: 'rover-condition',
        subject: who,
        message: `condition must be within 0..100, found ${r.condition}`,
      });
    }

    if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.z)) {
      out.push({
        code: 'rover-position',
        subject: who,
        message: `position must be finite, found (${r.x}, ${r.y}, ${r.z})`,
      });
    }
  }
}

/**
 * Rover execution state (roadmap Phase 11): `goal` and `phase` are runtime
 * execution state — rebuilt from the task every tick, never saved — and their
 * legal combinations are the table in `docs/design/ROVER-STATE.md` §3. An
 * impossible pair means a transition site drifted, which nothing in the UI
 * would notice: the HUD derives its wording, and the renderer only asks about
 * `disabled`. That is exactly the failure an extraction can hide, so the pair
 * is checked here.
 */
function checkRoverExecution(sim: Simulation, out: InvariantViolation[]): void {
  /** goal -> legal phase(s). `mine` is the one goal with a travel and a work phase. */
  const LEGAL_PHASES: Record<string, RoverPhase[]> = {
    idle: ['idle', 'charging', 'disabled'],
    move: ['moving'],
    mine: ['moving', 'working'],
    toDepot: ['moving'],
    toCharge: ['moving'],
    charge: ['charging'],
    toSite: ['moving'],
    build: ['working'],
    toService: ['moving'],
    service: ['working'],
    toSalvage: ['moving'],
    salvage: ['working'],
    toRecover: ['moving'],
    recover: ['working'],
  };
  /** While a rover is working a task, the command it holds must still be that task. */
  const COMMANDS: Record<string, string[]> = {
    move: ['moveTo'],
    mine: ['mine'],
    toSite: ['construct'],
    build: ['construct'],
    toService: ['clean', 'repair'],
    service: ['clean', 'repair'],
    toSalvage: ['salvage'],
    salvage: ['salvage'],
    toRecover: ['recover'],
    recover: ['recover'],
  };

  for (const r of sim.rovers) {
    const who = roverName(r);
    const legal = LEGAL_PHASES[r.goal];
    if (legal && !legal.includes(r.phase)) {
      out.push({
        code: 'rover-execution',
        subject: who,
        message: `goal '${r.goal}' cannot be in phase '${r.phase}' (legal: ${legal.join(' | ')})`,
      });
    }
    if (r.phase === 'moving' && r.navPath.length === 0) {
      out.push({
        code: 'rover-execution',
        subject: who,
        message: "phase 'moving' with an empty nav path",
      });
    }
    const expects = COMMANDS[r.goal];
    if (expects && !expects.includes(r.command.type)) {
      out.push({
        code: 'rover-execution',
        subject: who,
        message: `goal '${r.goal}' is executing command '${r.command.type}' (expected ${expects.join(' | ')})`,
      });
    }
  }
}

function checkBuildings(sim: Simulation, roverIds: Set<number>, out: InvariantViolation[]): void {
  for (const b of sim.buildings) {
    const what = buildingName(b);

    if (!inRange(b.progress, 0, 1)) {
      out.push({
        code: 'building-progress',
        subject: what,
        message: `progress must be within 0..1, found ${b.progress}`,
      });
    }
    if (b.assembly && !inRange(b.assembly.progress, 0, 1)) {
      out.push({
        code: 'building-progress',
        subject: what,
        message: `assembly progress must be within 0..1, found ${b.assembly.progress}`,
      });
    }

    if (!inRange(b.health, 0, 100)) {
      out.push({
        code: 'building-health',
        subject: what,
        message: `health must be within 0..100, found ${b.health}`,
      });
    }
    if (!inRange(b.cleanliness, 0, 1)) {
      out.push({
        code: 'building-health',
        subject: what,
        message: `cleanliness must be within 0..1, found ${b.cleanliness}`,
      });
    }

    if (b.workerId !== null && !roverIds.has(b.workerId)) {
      out.push({
        code: 'building-worker-ref',
        subject: what,
        message: `workerId ${b.workerId} does not reference a rover`,
      });
    }
  }
}

function checkResources(sim: Simulation, out: InvariantViolation[]): void {
  // Bulk storage: never negative. No upper bound — demolish() refunds
  // delivered materials in full even when that overfills the silo (see file
  // header); the excess drains as the colony spends it.
  for (const k of ALL_RESOURCES) {
    const v = sim.storage[k];
    if (!Number.isFinite(v) || v < 0) {
      out.push({
        code: 'storage-negative',
        subject: `storage.${k}`,
        message: `storage must be >= 0, found ${v}`,
      });
    }
  }

  // Life-support fluids are clamped on both sides by addFluid/takeFluid.
  for (const f of ALL_FLUIDS) {
    const v = sim.pools.amounts[f];
    const cap = sim.pools.capacity[f];
    if (!inRange(v, 0, Math.max(cap, 0))) {
      out.push({
        code: 'fluid-range',
        subject: `pools.${f}`,
        message: `fluid amount must be within 0..${cap}, found ${v}`,
      });
    }
  }

  // Grid battery.
  const cap = sim.batteryCapacity();
  if (!inRange(sim.storedKWh, 0, cap)) {
    out.push({
      code: 'grid-battery',
      subject: 'power grid',
      message: `storedKWh must be within 0..${cap.toFixed(2)}, found ${sim.storedKWh}`,
    });
  }
}

function checkWorld(sim: Simulation, roverIds: Set<number>, out: InvariantViolation[]): void {
  for (const d of sim.world.deposits) {
    if (!inRange(d.amount, 0, Math.max(d.maxAmount, 0))) {
      out.push({
        code: 'deposit-amount',
        subject: `deposit #${d.id} (${d.resource})`,
        message: `amount must be within 0..${d.maxAmount}, found ${d.amount}`,
      });
    }
    if (d.reservedBy != null && !roverIds.has(d.reservedBy)) {
      out.push({
        code: 'reservation-ref',
        subject: `deposit #${d.id} (${d.resource})`,
        message: `reservedBy ${d.reservedBy} does not reference a rover`,
      });
    }
  }

  for (const p of sim.world.pois) {
    for (const [k, v] of Object.entries(p.salvage)) {
      if (!Number.isFinite(v) || v < 0) {
        out.push({
          code: 'poi-amounts',
          subject: `poi #${p.id} (${p.kind})`,
          message: `salvage.${k} must be >= 0, found ${v}`,
        });
      }
    }
    if (!Number.isFinite(p.energyKWh) || p.energyKWh < 0) {
      out.push({
        code: 'poi-amounts',
        subject: `poi #${p.id} (${p.kind})`,
        message: `energyKWh must be >= 0, found ${p.energyKWh}`,
      });
    }
  }
}

function checkTaskRefs(
  task: RoverTask,
  slot: string,
  who: string,
  ids: { rovers: Set<number>; buildings: Set<number>; pois: Set<number> },
  depositExists: (id: number) => boolean,
  out: InvariantViolation[],
): void {
  switch (task.type) {
    case 'mine':
      if (!depositExists(task.depositId)) {
        out.push({
          code: 'task-deposit-ref',
          subject: who,
          message: `${slot} mine task references missing deposit ${task.depositId}`,
        });
      }
      break;
    case 'construct':
    case 'clean':
    case 'repair':
      if (!ids.buildings.has(task.buildingId)) {
        out.push({
          code: 'task-building-ref',
          subject: who,
          message: `${slot} ${task.type} task references missing building ${task.buildingId}`,
        });
      }
      break;
    case 'recover':
      if (!ids.rovers.has(task.roverId)) {
        out.push({
          code: 'task-rover-ref',
          subject: who,
          message: `${slot} recover task references missing rover ${task.roverId}`,
        });
      }
      break;
    case 'salvage':
      if (!ids.pois.has(task.poiId)) {
        out.push({
          code: 'task-poi-ref',
          subject: who,
          message: `${slot} salvage task references missing poi ${task.poiId}`,
        });
      }
      break;
    case 'idle':
    case 'moveTo':
    case 'unload':
    case 'wait':
      break;
  }
}

function checkTasks(
  sim: Simulation,
  ids: { rovers: Set<number>; buildings: Set<number>; pois: Set<number> },
  out: InvariantViolation[],
): void {
  const depositExists = (id: number): boolean =>
    sim.world.deposits.some((d) => d.id === id);

  for (const r of sim.rovers) {
    const who = roverName(r);
    checkTaskRefs(r.command, 'active', who, ids, depositExists, out);
    r.pending.forEach((t, i) =>
      checkTaskRefs(t, `pending[${i}]`, who, ids, depositExists, out),
    );
  }
}

function checkColonist(sim: Simulation, buildingIds: Set<number>, out: InvariantViolation[]): void {
  const c = sim.colonist;

  if (!inRange(c.health, 0, 100)) {
    out.push({
      code: 'colonist-state',
      subject: `colonist ${c.name}`,
      message: `health must be within 0..100, found ${c.health}`,
    });
  }
  if (!inRange(c.suitO2, 0, SUIT_O2_CAPACITY)) {
    out.push({
      code: 'colonist-state',
      subject: `colonist ${c.name}`,
      message: `suitO2 must be within 0..${SUIT_O2_CAPACITY}, found ${c.suitO2}`,
    });
  }
  if (!Number.isFinite(c.x) || !Number.isFinite(c.z)) {
    out.push({
      code: 'colonist-state',
      subject: `colonist ${c.name}`,
      message: `position must be finite, found (${c.x}, ${c.z})`,
    });
  }

  // shelterId: -1 = EVA, 0 = the landing pod, otherwise a building.
  if (c.shelterId > 0 && !buildingIds.has(c.shelterId)) {
    out.push({
      code: 'colonist-shelter-ref',
      subject: `colonist ${c.name}`,
      message: `shelterId ${c.shelterId} does not reference a building`,
    });
  }
}

// ----------------------------------------------------------------- public ----

/**
 * Inspect the simulation and return every invariant violation found. Pure and
 * read-only: safe to call at any quiescent moment (between steps, after a
 * command, after a restore). An empty result means the state is sound.
 */
export function checkInvariants(sim: Simulation): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  checkTime(sim, out);
  const ids = checkIds(sim, out);
  checkRovers(sim, out);
  checkRoverExecution(sim, out);
  checkBuildings(sim, ids.rovers, out);
  checkResources(sim, out);
  checkWorld(sim, ids.rovers, out);
  checkTasks(sim, ids, out);
  checkColonist(sim, ids.buildings, out);
  return out;
}

/**
 * Like {@link checkInvariants}, but throws an {@link InvariantError} naming
 * every violation. This is what `Simulation.step()` calls when invariant
 * checks are enabled — i.e. in the test suite, and nowhere else.
 */
export function assertInvariants(sim: Simulation, label = 'check'): void {
  const violations = checkInvariants(sim);
  if (violations.length > 0) throw new InvariantError(violations, label);
}
