/**
 * Phase 18 — Colony snapshot / restore bodies extracted from Simulation.
 *
 * Simulation keeps the public lifecycle API (`snapshot` / `restore`) as thin
 * delegates; the field-by-field mapping lives here so the orchestrator does
 * not implement persistence. Decode still goes through SaveCodec at the
 * Simulation boundary (unknown → SaveState → apply).
 *
 * Move-not-redesign: every field written or read matches the former
 * Simulation.snapshot / restoreFromState bodies. System restore hooks
 * (Clock, Weather, LifeSupport, Power, Rover rehydrate, History clear) are
 * called in the same order.
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, Simulation class,
 * hosts.
 */

import { World } from '../World';
import {
  SAVE_VERSION,
  BUILDING_MAX_HEALTH,
} from '../config';
import {
  ROVERS,
  BUILDINGS,
  emptyAmounts,
  type RoverKind,
  type BuildingKind,
} from '../defs';
import {
  DIFFICULTIES,
  DEFAULT_WORLD_OPTIONS,
  type DifficultyId,
} from '../difficulty';
import { POI_KINDS, type PoiKind } from '../pois';
import { coerceTask } from './SaveValidator';
import type { SaveState } from './SaveSchema';
import type { ColonyState } from '../state/ColonyState';
import {
  resetExplorationState,
  recomputeCapacitiesState,
} from '../state/ColonyState';
import {
  defaultRoverRules,
  type RoverTask,
  type RoverPhase,
  type RoverGoal,
} from '../state/RoverState';
import { ClockSystem } from '../systems/ClockSystem';
import { WeatherSystem } from '../systems/WeatherSystem';
import { PowerSystem } from '../systems/PowerSystem';
import { LifeSupportSystem } from '../systems/LifeSupportSystem';
import { RoverSystem } from '../systems/RoverSystem';
import { HistorySystem } from '../systems/HistorySystem';

/** Build a SaveState from live ColonyState — former Simulation.snapshot body. */
export function snapshotColony(state: ColonyState): SaveState {
  return {
    version: SAVE_VERSION as 8,
    seed: state.seed,
    difficulty: state.difficulty,
    worldHalf: state.world.half,
    region: state.world.region,
    worldOptions: { ...state.worldOptions },
    simTime: state.simTime,
    ticksRun: state.ticksRun,
    clock: state.clock.snapshot() as { sol: number; frac: number },
    storage: { ...state.storage },
    fluids: { ...state.pools.amounts },
    storedKWh: state.storedKWh,
    gameOver: state.gameOver,
    colonist: {
      id: state.colonist.id,
      name: state.colonist.name,
      x: state.colonist.x,
      z: state.colonist.z,
      heading: state.colonist.heading,
      health: state.colonist.health,
      suitO2: state.colonist.suitO2,
      inside: state.colonist.inside,
      shelterId: state.colonist.shelterId,
      order: { ...state.colonist.order } as { type: string; [k: string]: unknown },
      dead: state.colonist.dead,
    },
    deposits: state.world.deposits.map((d) => ({
      id: d.id,
      resource: d.resource,
      x: d.x,
      z: d.z,
      amount: d.amount,
      maxAmount: d.maxAmount,
      radius: d.radius,
      reservedBy: d.reservedBy ?? null,
    })),
    pois: state.world.pois.map((p) => ({
      id: p.id,
      kind: p.kind,
      x: p.x,
      z: p.z,
      salvage: { ...p.salvage },
      energyKWh: p.energyKWh,
      discovered: p.discovered,
      solsToBury: p.solsToBury,
      buried: p.buried,
      manifest: p.manifest,
    })),
    exploration: { nextDropSol: state.nextDropSol },
    rovers: state.rovers.map((r) => ({
      id: r.id,
      kind: r.kind,
      x: r.x,
      y: r.y,
      z: r.z,
      heading: r.heading,
      battery: r.battery,
      cargo: { ...r.cargo },
      command: { ...r.command },
      pending: r.pending.map((task) => ({ ...task })),
      condition: r.condition,
      rules: { ...r.rules },
      autoTask: r.autoTask,
      recharge: r.recharge,
      lowBatteryNotified: r.lowBatteryNotified,
      blockNotified: r.blockNotified,
      sheltered: r.sheltered,
      lightsOn: r.lightsOn,
    })),
    buildings: state.buildings.map((b) => ({
      id: b.id,
      kind: b.kind,
      x: b.x,
      z: b.z,
      rot: b.rot,
      state: b.state,
      remainingCost: { ...b.remainingCost },
      needsMaterials: b.needsMaterials,
      progress: b.progress,
      buildTime: b.buildTime,
      workerId: b.workerId,
      enabled: b.enabled,
      health: b.health,
      cleanliness: b.cleanliness,
      damaged: b.damaged,
      assembly: b.assembly ? { ...b.assembly } : null,
    })),
    weather: state.weather.snapshot() as SaveState['weather'],
    alerts: state.alerts.snapshot() as SaveState['alerts'],
  };
}

/**
 * Apply an already-decoded SaveState onto ColonyState — former
 * Simulation.restoreFromState body. System restore order is preserved.
 */
export function restoreColony(state: ColonyState, data: SaveState): void {
  state.seed = data.seed;
  state.difficulty = DIFFICULTIES[data.difficulty as DifficultyId]
    ? (data.difficulty as DifficultyId)
    : 'pioneer';
  state.worldOptions = { ...DEFAULT_WORLD_OPTIONS, ...(data.worldOptions ?? {}) };
  state.consumptionMul = (DIFFICULTIES[state.difficulty] ?? DIFFICULTIES.pioneer).consumptionMul;
  // Phase 4: clock/time restore delegated to ClockSystem
  ClockSystem.restore(state, {
    simTime: data.simTime,
    ticksRun: (data as { ticksRun?: number }).ticksRun,
    clock: data.clock as { sol?: number; frac?: number },
  });
  // Phase 5: weather rebuild + derived flags delegated to WeatherSystem
  WeatherSystem.restore(state, data.weather);
  state.storage = { ...emptyAmounts(), ...(data.storage ?? {}) };
  state.gameOver = data.gameOver ?? null;

  state.world = new World({
    seed: data.seed,
    nearDeposits: 0.2,
    worldHalf: Number.isFinite(data.worldHalf) ? data.worldHalf : 640,
    region: typeof data.region === 'string' ? data.region : null,
  });
  state.world.deposits = (data.deposits ?? []).map((d) => ({
    id: d.id,
    resource: d.resource,
    x: d.x,
    z: d.z,
    amount: d.amount,
    maxAmount: d.maxAmount,
    radius: d.radius,
    reservedBy: Number.isFinite(d.reservedBy as unknown as number) ? (d.reservedBy as number) : null,
  }));
  if (Array.isArray(data.pois)) {
    state.world.setPois(
      (data.pois as unknown as Array<Record<string, unknown>>)
        .filter((p) => p && Number.isFinite(p.id as number) && POI_KINDS[p.kind as PoiKind])
        .map((p) => ({
          id: p.id as number,
          kind: p.kind as PoiKind,
          x: Number(p.x) || 0,
          z: Number(p.z) || 0,
          salvage: { ...((p.salvage as Record<string, number>) ?? {}) },
          energyKWh: Math.max(0, Number(p.energyKWh) || 0),
          discovered: !!p.discovered,
          solsToBury: Math.max(0, Number(p.solsToBury) || 0),
          buried: !!p.buried,
          manifest: typeof p.manifest === 'string' ? p.manifest : '',
        })),
    );
  }
  resetExplorationState(state, Number(data.exploration?.nextDropSol));

  state.rovers = (data.rovers ?? []).map((r) => {
    const command = coerceTask(r.command) ?? { type: 'idle' as const };
    const pending = Array.isArray(r.pending)
      ? (r.pending as unknown[]).map(coerceTask).filter((t): t is RoverTask => t !== null)
      : [];
    return {
      id: r.id,
      kind: r.kind,
      label: ROVERS[r.kind as RoverKind]?.label ?? 'Rover',
      x: r.x,
      y: state.world.heightAt(r.x, r.z),
      z: r.z,
      heading: r.heading,
      battery: r.battery,
      cargo: { ...emptyAmounts(), ...(r.cargo ?? {}) },
      phase: 'idle' as RoverPhase,
      command,
      pending,
      goal: 'idle' as RoverGoal,
      gx: r.x,
      gz: r.z,
      gid: 0,
      recharge: !!r.recharge,
      lowBatteryNotified: !!r.lowBatteryNotified,
      chargeSat: 0,
      autoTask: !!r.autoTask,
      condition: typeof r.condition === 'number' ? r.condition : 100,
      rules: { ...defaultRoverRules(), ...(r.rules ?? {}) },
      routePaused: false,
      blockNotified: !!r.blockNotified,
      sheltered: !!r.sheltered,
      lightsOn: (r as { lightsOn?: unknown }).lightsOn !== false,
      lightsActive: false,
      navPath: [],
      navI: 0,
    };
  });

  state.buildings = (data.buildings ?? []).map((b) => ({
    id: b.id,
    kind: b.kind,
    x: b.x,
    z: b.z,
    rot: b.rot ?? 0,
    state: b.state,
    remainingCost: { ...emptyAmounts(), ...(b.remainingCost ?? {}) },
    needsMaterials: !!b.needsMaterials,
    progress: b.progress ?? 0,
    buildTime: b.buildTime ?? BUILDINGS[b.kind as BuildingKind].buildTime,
    workerId: b.workerId ?? null,
    enabled: b.enabled !== false,
    powerSat: 1,
    throughput: 0,
    genKw: 0,
    loadKw: 0,
    idleReason: '',
    health: b.health ?? BUILDING_MAX_HEALTH,
    cleanliness: b.cleanliness ?? 1,
    damaged: !!b.damaged,
    assembly:
      b.assembly && ROVERS[(b.assembly as { kind: RoverKind }).kind as RoverKind]
        ? { kind: (b.assembly as { kind: RoverKind }).kind, progress: (b.assembly as { progress: number }).progress ?? 0 }
        : null,
    level: 1,
  }));

  // Phase 11: execution state (goal/phase) is rebuilt from the task + world.
  RoverSystem.rehydrate(state);

  recomputeCapacitiesState(state);
  // Phase 7: fluid clamp + colonist rebuild delegated to LifeSupportSystem
  LifeSupportSystem.restore(state, data.fluids, data.colonist);

  // Phase 6: grid rebuild delegated to PowerSystem
  PowerSystem.restore(state, data.storedKWh);
  // Radar capability is derived, not saved; restore it before the first view
  // so a resumed colony immediately shows its weather map.
  WeatherSystem.refreshRadar(state);

  state.alerts.reset();
  if (data.alerts) state.alerts.restore(data.alerts);
  HistorySystem.clear(state);

  let maxId = state.nextId;
  for (const e of [...state.rovers, ...state.buildings]) maxId = Math.max(maxId, e.id + 1);
  for (const d of state.world.deposits) maxId = Math.max(maxId, d.id + 1);
  state.nextId = maxId;
}
