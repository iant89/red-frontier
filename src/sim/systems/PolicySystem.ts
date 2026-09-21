/**
 * Phase 3 (slice 2) — PolicySystem: colony standing orders.
 *
 * The review's two requirements (COMMERCIAL-ROADMAP-REVIEW.md §5 P3):
 *
 *   (a) **Policies act through the same paths a player's order takes.** A
 *       stockpile run is `RoverSystem.autoAssign` of a `mine` task plus the
 *       seam claim — exactly what `dispatchSupplyRuns` does; a night-power
 *       shed is the same `enabled` flip `building/toggle` performs; an
 *       auto-maintain dispatch is the same `issueRepair`/`issueClean` the
 *       `building/maintain` command reaches. Nothing here has a private way
 *       of moving the world, so transcripts and determinism survive.
 *   (b) **Policy-issued actions are marked.** Rover work is `autoTask = true`
 *       (coverage counts it as self-directed, AUTONOMY.md §5); building
 *       toggles are recorded in `policies.held` so the policy can only give
 *       back what it took; and nothing a policy does goes near
 *       `noteCommandResult`, so the autonomy window never ends on a policy.
 *
 * Tick position (decided with ask-user): after construction crews and just
 * before `FleetAutomationSystem.tick`. Construction keeps first pick of idle
 * rovers; a stockpile run outranks generic hauling; a night-power toggle
 * lands on the next `PowerSystem.tick`.
 *
 * The four policies:
 *
 *   stockpile      keep `<resource>` above N kg — sends idle `autoHaul` rovers
 *                  to the best seam while storage is short and there is room.
 *   nightPower     after sunset, while the battery is under N %, switch
 *                  industry (tier ≥ 2) off; switch it back on at sunrise or
 *                  once the battery recovers. Never touches life support.
 *   stormShelter   colony-wide recall: when a real storm is on the forecast,
 *                  every rover's `stormShelter` rule is enforced and idle
 *                  rovers in the open are sent home to a charger.
 *   autoMaintain   dispatch maintenance when a building's wear exceeds N %,
 *                  wear = max(health loss, dust) — one idle rover per job.
 *
 * Determinism: no RNG, no wall clock. Every decision is a read of state and
 * every tie-break is by id.
 */

import type { ColonyState } from '../state/ColonyState';
import type { Building } from '../state/BuildingState';
import type { Rover } from '../state/RoverState';
import type { PolicyState, PolicyId } from '../state/PolicyState';
import { POLICY_IDS } from '../state/PolicyState';
import { hasUnlock, type UnlockId } from '../unlocks';
import { effectiveBuildingDef } from '../engineering/upgrades';
import { effectiveRoverDef } from '../engineering/upgrades';
import { RoverSystem } from './RoverSystem';
import { LogisticsSystem } from './LogisticsSystem';
import { WeatherSystem } from './WeatherSystem';
import { batteryCapacityKWh } from '../state/PowerState';
import { recomputeCapacitiesState } from '../state/ColonyState';
import { idlePool, pickHaul, servicingRover, waitingSite } from './FleetAutomationSystem';
import { BUILDINGS, RESOURCES, emptyAmounts } from '../defs';
import type { ResourceId } from '../defs';
import { BUILDING_MAX_HEALTH } from '../config';
import { clamp } from '../../lib/rng';
import type { Severity } from '../alerts';

/** Tuning in one place (the UI's slider ranges read these too). */
export const POLICY_TUNING = {
  /** Sun altitude below which "night" begins for the night-power policy. */
  nightAltitude: 0.02,
  /** Hysteresis: industry comes back on once the battery is this far above the floor. */
  nightPowerRecoverPct: 10,
  /** Lowest industry tier the night-power policy may shed (tier 0/1 are life support). */
  shedTierMin: 2,
  /** Storage floor slider bounds for stockpile (kg). */
  stockpileMinKg: 0,
  stockpileMaxKg: 5000,
} as const;

/** The wear the auto-maintain policy measures: the worse of damage and dust, 0..1. */
export function buildingWear(b: Building): number {
  const health = clamp(1 - b.health / BUILDING_MAX_HEALTH, 0, 1);
  const dust = effectiveBuildingDef(b).generation === 'solar' ? clamp(1 - b.cleanliness, 0, 1) : 0;
  return Math.max(health, dust);
}

/** Buildings the night-power policy is allowed to shed: online industry that draws power. */
export function sheddable(state: ColonyState): Building[] {
  return state.buildings
    .filter((b) => {
      if (b.state !== 'online' || !b.enabled) return false;
      const def = effectiveBuildingDef(b);
      return def.tier >= POLICY_TUNING.shedTierMin && def.powerDrawKw > 0 && !def.providesCharge;
    })
    .sort((a, c) => a.id - c.id);
}

function log(state: ColonyState, severity: Severity, text: string): void {
  state.alerts.event(severity, text, state.simTime, state.clock.format());
}

function acted(state: ColonyState, policy: PolicyId): void {
  state.policies.actions += 1;
  state.domainEvents.push({ type: 'policy/acted', policy, sol: state.clock.solsElapsed });
}

// ------------------------------------------------------------ policies ----

/** Stockpile: while `<resource>` is under the floor, idle haulers go dig it. */
export function tickStockpile(state: ColonyState): void {
  const p = state.policies.stockpile;
  if (!p.on) return;
  const short = p.minKg - state.storage[p.resource];
  if (short <= 1 || LogisticsSystem.room(state, p.resource) <= 1) return;
  if (!(RESOURCES as Record<string, unknown>)[p.resource]) return;

  // Construction keeps its crew (the same courtesy dispatchSupplyRuns pays).
  let pool = idlePool(state, { excludeSheltered: true }).filter((r) => r.rules.autoHaul);
  const site = waitingSite(state);
  if (site) {
    const reserved = pool.find((r) => BUILDINGS[site.kind].buildableBy.includes(r.kind));
    if (reserved) pool = pool.filter((r) => r !== reserved);
  }
  if (pool.length === 0) return;

  const shortfall = emptyAmounts();
  shortfall[p.resource] = short;
  const wanted: ResourceId[] = [p.resource];
  for (const rover of pool) {
    if (shortfall[p.resource] <= 1) break;
    const pick = pickHaul(state, rover, wanted, shortfall);
    if (!pick) continue;
    RoverSystem.autoAssign(rover, { type: 'mine', depositId: pick.deposit.id });
    RoverSystem.claimDeposit(state, rover, pick.deposit.id);
    shortfall[p.resource] -= effectiveRoverDef(rover).capacityKg;
    acted(state, 'stockpile');
    log(state, 'info', `Stockpile policy: ${rover.label} sent for ${RESOURCES[p.resource].label.toLowerCase()} (${Math.round(state.storage[p.resource])} of ${p.minKg} kg).`);
  }
}

/** Night power: shed industry after dark while the battery is low; restore it after. */
export function tickNightPower(state: ColonyState): void {
  const p = state.policies.nightPower;
  const held = state.policies.held;
  if (!p.on && held.length === 0) return;
  const capacity = batteryCapacityKWh(state);
  const soc = capacity > 0 ? (state.storedKWh / capacity) * 100 : 100;
  const night = state.clock.sun.altitude < POLICY_TUNING.nightAltitude;

  const shouldShed = p.on && night && soc < p.minBatteryPct;
  const shouldRestore = !p.on || !night || soc >= p.minBatteryPct + POLICY_TUNING.nightPowerRecoverPct;

  if (shouldShed) {
    const targets = sheddable(state).filter((b) => !held.includes(b.id));
    if (targets.length === 0) return;
    for (const b of targets) {
      b.enabled = false;
      held.push(b.id);
    }
    recomputeCapacitiesState(state);
    WeatherSystem.refreshRadar(state);
    acted(state, 'nightPower');
    log(state, 'info', `Night power policy: battery ${Math.round(soc)} % — ${targets.length === 1 ? effectiveBuildingDef(targets[0]).label : `${targets.length} industry buildings`} shed until morning.`);
    return;
  }

  if (shouldRestore && held.length > 0) {
    let restored = 0;
    for (const id of held) {
      const b = state.buildings.find((o) => o.id === id);
      // A building the player switched on by hand in the meantime is theirs; one
      // that has been demolished is nobody's. Only a still-off one is restored.
      if (b && !b.enabled) {
        b.enabled = true;
        restored++;
      }
    }
    held.length = 0;
    if (restored > 0) {
      recomputeCapacitiesState(state);
      WeatherSystem.refreshRadar(state);
      acted(state, 'nightPower');
      log(state, 'ok', `Night power policy: ${restored} ${restored === 1 ? 'building' : 'buildings'} back on (${night ? `battery ${Math.round(soc)} %` : 'sunrise'}).`);
    }
  }
}

/** Storm shelter: a real storm on the board recalls the whole fleet. */
export function tickStormShelter(state: ColonyState): void {
  const p = state.policies.stormShelter;
  if (!p.on) return;
  const fc = state.weather.forecast();
  const incoming = (fc && fc.kind !== 'devil' && fc.kind !== 'calm') || state.weather.shelterRovers();
  if (!incoming) return;

  for (const r of state.rovers) {
    if (r.phase === 'disabled') continue;
    // Enforce the per-rover rule so the recall path (`updateRover`) takes it
    // from here; a daredevil override is not a policy the colony has.
    if (!r.rules.stormShelter) {
      r.rules.stormShelter = true;
      acted(state, 'stormShelter');
      log(state, 'info', `Storm shelter policy: ${r.label}'s shelter rule re-armed — ${fc?.label ?? 'storm'} on the board.`);
    }
    // Idle rovers in the open are brought in before the wind arrives rather
    // than at the shelter threshold; a rover on a task keeps it until the
    // per-rover recall fires (its job may be the thing that saves the colony).
    const idle = r.command.type === 'idle' && r.pending.length === 0;
    if (idle && !r.recharge && !r.sheltered && !RoverSystem.nearCharger(state, r.x, r.z)) {
      r.recharge = true;
      acted(state, 'stormShelter');
      log(state, 'info', `Storm shelter policy: ${r.label} recalled ahead of the ${(fc?.label ?? 'storm').toLowerCase()}.`);
    }
  }
}

/** Auto-maintain: one idle rover per building past the wear threshold. */
export function tickAutoMaintain(state: ColonyState): void {
  const p = state.policies.autoMaintain;
  if (!p.on || state.weather.shelterRovers()) return;
  const threshold = clamp(p.maxWearPct, 0, 100) / 100;
  const jobs = state.buildings
    .filter((b) => b.state === 'online' && buildingWear(b) > threshold && !servicingRover(state, b.id))
    .sort((a, c) => buildingWear(c) - buildingWear(a) || a.id - c.id);
  if (jobs.length === 0) return;

  const pool = idlePool(state, { excludeSheltered: true, requireEmptyQueue: true });
  for (const b of jobs) {
    if (pool.length === 0) return;
    pool.sort((a, c) => Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(c.x - b.x, c.z - b.z) || a.id - c.id);
    const rover = pool[0];
    const needsRepair = b.health < BUILDING_MAX_HEALTH - 0.5;
    const ok = needsRepair
      ? RoverSystem.issueRepair(state, rover.id, b.id)
      : RoverSystem.issueClean(state, rover.id, b.id);
    if (!ok) continue;
    // issue* is the player path and clears the flag; a policy's dispatch is
    // self-directed work, so mark it as such for coverage (AUTONOMY.md §5).
    rover.autoTask = true;
    pool.shift();
    acted(state, 'autoMaintain');
    log(state, 'info', `Maintenance policy: ${rover.label} dispatched to ${needsRepair ? 'repair' : 'clean'} the ${effectiveBuildingDef(b).label} (wear ${Math.round(buildingWear(b) * 100)} %).`);
  }
}

// ------------------------------------------------------------------ tick ----

export class PolicySystem {
  /**
   * One pass over the four standing orders. Order matters only where two
   * policies want the same rover: shelter first (nothing else should send a
   * rover out into a storm), then repairs (survival), then the stockpile.
   */
  static tick(state: ColonyState): void {
    tickNightPower(state);
    tickStormShelter(state);
    tickAutoMaintain(state);
    tickStockpile(state);
  }

  /** The `policy/*` commands land here. Returns false for a nonsense payload. */
  static set(state: ColonyState, policy: PolicyId, patch: Record<string, unknown>): boolean {
    const p = state.policies;
    switch (policy) {
      case 'stockpile': {
        if (typeof patch.on === 'boolean') p.stockpile.on = patch.on;
        if (typeof patch.resource === 'string') {
          if (!(patch.resource in RESOURCES)) return false;
          p.stockpile.resource = patch.resource as ResourceId;
        }
        if (typeof patch.minKg === 'number' && Number.isFinite(patch.minKg)) {
          p.stockpile.minKg = clamp(patch.minKg, POLICY_TUNING.stockpileMinKg, POLICY_TUNING.stockpileMaxKg);
        }
        break;
      }
      case 'nightPower': {
        if (typeof patch.on === 'boolean') p.nightPower.on = patch.on;
        if (typeof patch.minBatteryPct === 'number' && Number.isFinite(patch.minBatteryPct)) {
          p.nightPower.minBatteryPct = clamp(patch.minBatteryPct, 0, 100);
        }
        // Switching the policy off hands back anything it is holding, now.
        if (!p.nightPower.on) tickNightPower(state);
        break;
      }
      case 'stormShelter': {
        if (typeof patch.on === 'boolean') p.stormShelter.on = patch.on;
        break;
      }
      case 'autoMaintain': {
        if (typeof patch.on === 'boolean') p.autoMaintain.on = patch.on;
        if (typeof patch.maxWearPct === 'number' && Number.isFinite(patch.maxWearPct)) {
          p.autoMaintain.maxWearPct = clamp(patch.maxWearPct, 0, 100);
        }
        break;
      }
      default:
        return false;
    }
    log(state, 'info', describe(p, policy));
    return true;
  }
}

/** One line per policy, the way the panel and the log both say it. */
export function describe(p: PolicyState, id: PolicyId): string {
  switch (id) {
    case 'stockpile':
      return p.stockpile.on
        ? `Policy: keep ${RESOURCES[p.stockpile.resource].label.toLowerCase()} above ${Math.round(p.stockpile.minKg)} kg.`
        : 'Policy: stockpile — off.';
    case 'nightPower':
      return p.nightPower.on
        ? `Policy: shed industry after dark below ${Math.round(p.nightPower.minBatteryPct)} % battery.`
        : 'Policy: night power — off.';
    case 'stormShelter':
      return p.stormShelter.on ? 'Policy: recall the fleet when a storm is forecast.' : 'Policy: storm shelter — off.';
    case 'autoMaintain':
      return p.autoMaintain.on
        ? `Policy: maintain buildings past ${Math.round(p.autoMaintain.maxWearPct)} % wear.`
        : 'Policy: auto-maintain — off.';
  }
}

/**
 * The unlock that gates the panel: the registry's second consumer. `null`
 * would ship policies open from sol 1; the roadmap ties them to Industrialize.
 */
export const POLICY_UNLOCK: UnlockId | null = 'advancedAutomation';

/** Which rovers are currently on policy work — for the read model. */
export function policyRovers(state: ColonyState): Rover[] {
  return state.rovers.filter((r) => r.autoTask && r.command.type !== 'idle');
}

/** The read model — plain data, safe across a worker boundary. */
export interface PolicySnapshot {
  unlocked: boolean;
  stockpile: { on: boolean; resource: ResourceId; minKg: number; currentKg: number };
  nightPower: { on: boolean; minBatteryPct: number; shedding: number };
  stormShelter: { on: boolean };
  autoMaintain: { on: boolean; maxWearPct: number; worstWearPct: number };
  actions: number;
  lines: Record<PolicyId, string>;
}

export function policySnapshot(state: ColonyState): PolicySnapshot {
  const p = state.policies;
  let worst = 0;
  for (const b of state.buildings) if (b.state === 'online') worst = Math.max(worst, buildingWear(b));
  const lines = {} as Record<PolicyId, string>;
  for (const id of POLICY_IDS) lines[id] = describe(p, id);
  return {
    unlocked: POLICY_UNLOCK === null || hasUnlock(state.unlocks, POLICY_UNLOCK),
    stockpile: { ...p.stockpile, currentKg: state.storage[p.stockpile.resource] },
    nightPower: { ...p.nightPower, shedding: p.held.length },
    stormShelter: { ...p.stormShelter },
    autoMaintain: { ...p.autoMaintain, worstWearPct: Math.round(worst * 100) },
    actions: p.actions,
    lines,
  };
}
