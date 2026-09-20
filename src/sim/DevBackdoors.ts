/**
 * Phase 18 — Developer-panel mutation bodies extracted from Simulation.
 *
 * Simulation keeps the public `dev*` methods (host/command boundary) as thin
 * delegates; the clamping and field writes live here so the orchestrator does
 * not implement them. Runtime-only — never persisted (same contract as before).
 *
 * Move-not-redesign: every clamp, threshold and side-effect matches the former
 * Simulation.dev* bodies.
 */

import { effectiveRoverDef } from './engineering/upgrades';
import type { ColonyState } from './state/ColonyState';
import { recomputeCapacitiesState } from './state/ColonyState';
import type { Deposit } from './World';
import type { Building } from './state/BuildingState';
import type { Rover } from './state/RoverState';
import { clamp } from '../lib/rng';
import {
  SPAWN_X,
  SPAWN_Z,
  SUIT_O2_CAPACITY,
  DAMAGED_HEALTH,
  REPAIR_RESTART_HEALTH,
  DEV_MAX_BUILDING_LEVEL,
} from './config';
import {
  RESOURCES,
  ROVERS,
  ALL_RESOURCES,
  type MineableResourceId,
  type ResourceId,
  type RoverKind,
  type BuildingKind,
} from './defs';
import type { StormKindReal } from './weather';
import { ClockSystem } from './systems/ClockSystem';
import { WeatherSystem } from './systems/WeatherSystem';
import { ConstructionSystem, type ConstructionHostHooks } from './systems/ConstructionSystem';
import { RoverSystem } from './systems/RoverSystem';
import { HistorySystem } from './systems/HistorySystem';
import { TutorialSystem } from './systems/TutorialSystem';
import { ObjectiveSystem } from './systems/ObjectiveSystem';

function event(state: ColonyState, severity: 'ok' | 'info' | 'warn', text: string): void {
  state.alerts.event(severity, text, state.simTime, state.clock.format());
}

export const DevBackdoors = {
  spawnRover(state: ColonyState, kind: RoverKind, x: number, z: number): Rover {
    const r = RoverSystem.spawn(state, kind, x, z, Math.atan2(SPAWN_X - x, SPAWN_Z - z));
    event(state, 'ok', `${r.label} #${r.id} rolled out of nowhere — charged and ready (developer).`);
    return r;
  },

  spawnBuilding(
    state: ColonyState,
    kind: BuildingKind,
    x: number,
    z: number,
  ): Building | null {
    const b = ConstructionSystem.devSpawn(state, kind, x, z);
    WeatherSystem.refreshRadar(state);
    return b;
  },

  /**
   * Survey in a seam. The parameter is a *mined* resource: refined materials
   * have no deposit, and the boundaries that accept untyped input (the command
   * decoder's `mineableResourceId` field, DevMode before it sends) are what
   * keep them out.
   */
  spawnDeposit(
    state: ColonyState,
    resource: MineableResourceId,
    x: number,
    z: number,
    amountKg: number,
  ): Deposit {
    const d = state.world.addDeposit(resource, x, z, Math.max(10, amountKg));
    event(
      state,
      'ok',
      `${RESOURCES[resource].label} deposit surveyed in — ${Math.round(d.amount)} kg (developer).`,
    );
    return d;
  },

  completeBuilding(
    state: ColonyState,
    id: number,
    hooks: ConstructionHostHooks,
  ): boolean {
    const ok = ConstructionSystem.devComplete(state, id, hooks);
    WeatherSystem.refreshRadar(state);
    return ok;
  },

  setBuildingLevel(state: ColonyState, id: number, level: number): number {
    const b = state.buildings.find((x) => x.id === id);
    if (!b) return 1;
    const next = clamp(Math.round(level), 1, DEV_MAX_BUILDING_LEVEL);
    if (next !== b.level) {
      b.level = next;
      recomputeCapacitiesState(state);
    }
    return b.level;
  },

  setDust(state: ColonyState, frac: number): void {
    state.weather.dust = clamp(frac, 0, 1);
  },

  forceStorm(state: ColonyState, kind: StormKindReal): void {
    state.weather.debugScheduleStorm(kind, state.simTime, 4);
  },

  clearStorms(state: ColonyState): void {
    state.weather.debugClearStorms();
  },

  setStormScheduler(state: ColonyState, on: boolean): void {
    if (on) state.weather.debugResumeRolls(state.simTime);
    else state.weather.debugSuppressRolls();
  },

  setRoverBatteryFrac(state: ColonyState, roverId: number, frac: number): boolean {
    const r = state.rovers.find((x) => x.id === roverId);
    if (!r) return false;
    r.battery = clamp(frac, 0, 1) * effectiveRoverDef(r).maxBatteryKWh;
    return true;
  },

  setRoverCondition(state: ColonyState, roverId: number, pct: number): boolean {
    const r = state.rovers.find((x) => x.id === roverId);
    if (!r) return false;
    r.condition = clamp(pct, 0, 100);
    return true;
  },

  setRoverCargo(state: ColonyState, roverId: number, res: ResourceId, kg: number): number {
    const r = state.rovers.find((x) => x.id === roverId);
    if (!r) return 0;
    let others = 0;
    for (const k of ALL_RESOURCES) if (k !== res) others += r.cargo[k];
    r.cargo[res] = Math.min(Math.max(0, kg), Math.max(0, effectiveRoverDef(r).capacityKg - others));
    return r.cargo[res];
  },

  clearRoverCargo(state: ColonyState, roverId: number): boolean {
    const r = state.rovers.find((x) => x.id === roverId);
    if (!r) return false;
    for (const k of ALL_RESOURCES) r.cargo[k] = 0;
    return true;
  },

  setBuildingHealth(state: ColonyState, buildingId: number, pct: number): boolean {
    const b = state.buildings.find((x) => x.id === buildingId);
    if (!b) return false;
    b.health = clamp(pct, 0, 100);
    if (b.health <= DAMAGED_HEALTH) b.damaged = true;
    else if (b.damaged && b.health >= REPAIR_RESTART_HEALTH) b.damaged = false;
    recomputeCapacitiesState(state);
    return true;
  },

  setBuildingCleanliness(state: ColonyState, buildingId: number, frac: number): boolean {
    const b = state.buildings.find((x) => x.id === buildingId);
    if (!b) return false;
    b.cleanliness = clamp(frac, 0, 1);
    return true;
  },

  setBuildingDamaged(state: ColonyState, buildingId: number, on: boolean): boolean {
    const b = state.buildings.find((x) => x.id === buildingId);
    if (!b || b.damaged === on) return false;
    b.damaged = on;
    recomputeCapacitiesState(state);
    return true;
  },

  setColonistHealth(state: ColonyState, pct: number): boolean {
    if (state.colonist.dead) return false;
    state.colonist.health = clamp(pct, 0, 100);
    return true;
  },

  refillSuit(state: ColonyState): void {
    state.colonist.suitO2 = SUIT_O2_CAPACITY;
  },

  setTime(state: ColonyState, sol: number, frac: number): void {
    ClockSystem.setTime(state, sol, frac);
    WeatherSystem.afterTimeJump(state);
    HistorySystem.afterTimeJump(state);
    TutorialSystem.afterTimeJump(state);
    // Jumping the clock forward is not ten sols of autonomy.
    ObjectiveSystem.afterTimeJump(state);
  },

  forceLightningStrike(
    state: ColonyState,
    hooks: Parameters<typeof WeatherSystem.resolveLightningStrike>[1],
  ): void {
    WeatherSystem.resolveLightningStrike(state, hooks, 'exact');
  },
};
