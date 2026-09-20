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

import { copyEngineering, restoreEngineering } from './EngineeringPersistence';
import { roverUpgrades, buildingUpgrades } from '../engineering/upgrades';
import { restoreWater } from './WaterPersistence';
import { emptyWaterState } from '../state/WaterState';
import { World } from '../World';
import {
  SAVE_VERSION,
  BUILDING_MAX_HEALTH,
} from '../config';
import {
  ROVERS,
  BUILDINGS,
  MINEABLE_RESOURCES,
  ALL_COMPONENTS,
  ROVER_PARTS,
  emptyAmounts,
  emptyComponents,
  type ComponentAmounts,
  type MineableResourceId,
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
import { CURRENT_SAVE_VERSION } from './SaveSchema';
import type { ColonyState } from '../state/ColonyState';
import {
  resetExplorationState,
  recomputeCapacitiesState,
} from '../state/ColonyState';
import {
  defaultRoverRules,
  freshRoverParts,
  type RoverTask,
  type RoverPhase,
  type RoverGoal,
} from '../state/RoverState';
import { emptyCraft } from '../state/BuildingState';
import { ClockSystem } from '../systems/ClockSystem';
import { WeatherSystem } from '../systems/WeatherSystem';
import { PowerSystem } from '../systems/PowerSystem';
import { LifeSupportSystem } from '../systems/LifeSupportSystem';
import { RoverSystem } from '../systems/RoverSystem';
import { HistorySystem } from '../systems/HistorySystem';
import { emptyTutorialState } from '../state/TutorialState';

/** Build a SaveState from live ColonyState — former Simulation.snapshot body. */
export function snapshotColony(state: ColonyState): SaveState {
  return {
    // No literal cast: the snapshot's version *is* the schema's current one,
    // so bumping SAVE_VERSION cannot silently write a stale header.
    version: CURRENT_SAVE_VERSION,
    seed: state.seed,
    difficulty: state.difficulty,
    worldHalf: state.world.half,
    region: state.world.region,
    worldOptions: { ...state.worldOptions },
    simTime: state.simTime,
    ticksRun: state.ticksRun,
    clock: state.clock.snapshot() as { sol: number; frac: number },
    storage: { ...state.storage },
    components: { ...state.components },
    fluids: { ...state.pools.amounts },
    water: { active: state.water.active, links: state.water.links.map((l) => ({ ...l })), tanks: { ...state.water.tanks } },
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
      ...copyEngineering(r),
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
      parts: { ...r.parts },
      rules: { ...r.rules },
      autoTask: r.autoTask,
      recharge: r.recharge,
      lowBatteryNotified: r.lowBatteryNotified,
      blockNotified: r.blockNotified,
      sheltered: r.sheltered,
      lightsOn: r.lightsOn,
    })),
    buildings: state.buildings.map((b) => ({
      ...copyEngineering(b),
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
      recipe: b.recipe,
      craft: { ...b.craft },
      maintenance: b.maintenance ? { ...b.maintenance } : null,
    })),
    weather: state.weather.snapshot() as SaveState['weather'],
    alerts: state.alerts.snapshot() as SaveState['alerts'],
    tutorial: {
      milestones: { ...state.tutorial.milestones },
      warnings: { ...state.tutorial.warnings },
      seenHints: { ...state.tutorial.seenHints },
      dismissedHints: { ...state.tutorial.dismissedHints },
      funnel: [...state.tutorial.funnel],
      stats: { ...state.tutorial.stats },
    },
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
  // Components are whole units: a save that claims a fraction of a motor (or a
  // negative one, or a NaN) is not trusted with it.
  state.components = emptyComponents();
  const savedComponents = (data as { components?: Partial<ComponentAmounts> }).components ?? {};
  for (const c of ALL_COMPONENTS) {
    const n = savedComponents[c];
    state.components[c] = Number.isFinite(n) ? Math.max(0, Math.floor(n as number)) : 0;
  }
  state.gameOver = data.gameOver ?? null;

  state.world = new World({
    seed: data.seed,
    nearDeposits: 0.2,
    worldHalf: Number.isFinite(data.worldHalf) ? data.worldHalf : 640,
    region: typeof data.region === 'string' ? data.region : null,
  });
  // A seam is always of a *mined* material: refined resources (steel, P5) have
  // no deposits, so a save that claims one is hand-edited and the row is dropped
  // rather than trusted.
  state.world.deposits = (data.deposits ?? [])
    .filter((d) => d && (MINEABLE_RESOURCES as string[]).includes(d.resource))
    .map((d) => ({
      id: d.id,
      resource: d.resource as MineableResourceId,
      x: d.x,
      z: d.z,
      amount: d.amount,
      maxAmount: d.maxAmount,
      radius: d.radius,
      reservedBy: Number.isFinite(d.reservedBy as unknown as number)
        ? (d.reservedBy as number)
        : null,
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
      ...restoreEngineering(r, roverUpgrades(r.kind)),
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
      parts: (() => {
        const parts = freshRoverParts();
        for (const c of ROVER_PARTS) {
          const n = r.parts?.[c];
          parts[c] = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 100;
        }
        return parts;
      })(),
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
    ...restoreEngineering(b, buildingUpgrades(b.kind)),
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
    // v11 jobs are unpaid; invalid jobs can be discarded without a refund.
    maintenance: (() => {
      const job = b.maintenance;
      if (b.kind !== 'repairBay' || !job || !ROVER_PARTS.includes(job.component) ||
          !state.rovers.some((r) => r.id === job.roverId) ||
          !Number.isFinite(job.progress)) return null;
      return { roverId: job.roverId, component: job.component, progress: Math.max(0, Math.min(1, job.progress)) };
    })(),
    // A v9 save has neither field: recipe 0 is "the first line" (and is ignored
    // by a kind with no recipe list), and an empty bench is what a colony that
    // has never crafted anything actually has.
    recipe: Number.isInteger(b.recipe) && (b.recipe as number) >= 0 ? (b.recipe as number) : 0,
    craft: (() => {
      const craft = emptyCraft();
      const saved = (b.craft ?? {}) as Partial<ComponentAmounts>;
      for (const c of ALL_COMPONENTS) {
        const n = saved[c];
        // Work in progress is a fraction in [0, 1): clamp rather than trust.
        craft[c] = Number.isFinite(n) ? Math.min(1, Math.max(0, n as number)) : 0;
      }
      return craft;
    })(),
  }));

  const reservedGarages = new Set<number>();
  for (const r of state.rovers) {
    const id = r.upgradeJob?.facilityId;
    if (r.upgradeJob && (id == null || reservedGarages.has(id) || !state.buildings.some(b => b.id === id && b.kind === 'garage'))) r.upgradeJob = null;
    else if (id != null) reservedGarages.add(id);
  }
  for (const b of state.buildings) if (b.upgradeJob && (b.state !== 'online' || b.upgradeJob.facilityId !== null)) b.upgradeJob = null;

  // Phase 11: execution state (goal/phase) is rebuilt from the task + world.
  RoverSystem.rehydrate(state);

  state.water = emptyWaterState();
  recomputeCapacitiesState(state);
  // Phase 7: fluid clamp + colonist rebuild delegated to LifeSupportSystem
  LifeSupportSystem.restore(state, data.fluids, data.colonist);
  restoreWater(state, data.water);

  // Phase 6: grid rebuild delegated to PowerSystem
  PowerSystem.restore(state, data.storedKWh);
  // Radar capability is derived, not saved; restore it before the first view
  // so a resumed colony immediately shows its weather map.
  WeatherSystem.refreshRadar(state);

  state.alerts.reset();
  state.domainEvents.clear();
  if (data.alerts) state.alerts.restore(data.alerts);

  // v14 tutorial state
  const savedTut = (data as { tutorial?: unknown }).tutorial as
    | Record<string, unknown>
    | undefined;
  if (savedTut && typeof savedTut === 'object') {
    const base = emptyTutorialState();
    // milestones
    const sm = savedTut['milestones'] as Record<string, unknown> | undefined;
    if (sm && typeof sm === 'object') {
      for (const k of Object.keys(base.milestones) as (keyof typeof base.milestones)[]) {
        const m = sm[k as string] as { completed?: unknown; sol?: unknown; tick?: unknown } | undefined;
        if (m && typeof m.completed === 'boolean') {
          base.milestones[k] = {
            completed: !!m.completed,
            sol: Number.isFinite(m.sol as number) ? (m.sol as number) : 0,
            tick: Number.isFinite(m.tick as number) ? (m.tick as number) : 0,
          };
        }
      }
    }
    // warnings
    const sw = savedTut['warnings'] as Record<string, unknown> | undefined;
    if (sw && typeof sw === 'object') {
      for (const k of Object.keys(base.warnings) as (keyof typeof base.warnings)[]) {
        const w = sw[k as string] as
          | { lastSeenTick?: unknown; lastSeenSol?: unknown; count?: unknown; active?: unknown }
          | undefined;
        if (w && Number.isFinite(w.lastSeenTick as number)) {
          base.warnings[k] = {
            lastSeenTick: Number(w.lastSeenTick) || -1e12,
            lastSeenSol: Number(w.lastSeenSol) || -1e12,
            count: Math.max(0, Math.floor(Number(w.count) || 0)),
            active: !!w.active,
          };
        }
      }
    }
    const sh = savedTut['seenHints'];
    if (sh && typeof sh === 'object') {
      base.seenHints = { ...(sh as Record<string, boolean>) };
    }
    const dh = savedTut['dismissedHints'];
    if (dh && typeof dh === 'object') {
      base.dismissedHints = { ...(dh as Record<string, boolean>) };
    }
    const funnel = savedTut['funnel'];
    if (Array.isArray(funnel)) {
      base.funnel = funnel.slice(-200).map((e: unknown) => {
        const rec = e as Record<string, unknown>;
        return {
          id: String(rec['id'] ?? ''),
          type: (rec['type'] === 'warning' || rec['type'] === 'hint' ? rec['type'] : 'milestone') as
            | 'milestone'
            | 'warning'
            | 'hint',
          sol: Number(rec['sol']) || 0,
          tick: Math.floor(Number(rec['tick']) || 0),
          at: Number(rec['at']) || 0,
        };
      });
    }
    const st = savedTut['stats'] as Record<string, unknown> | undefined;
    if (st && typeof st === 'object') {
      base.stats = {
        moves: Math.max(0, Math.floor(Number(st['moves']) || 0)),
        mines: Math.max(0, Math.floor(Number(st['mines']) || 0)),
        hauls: Math.max(0, Math.floor(Number(st['hauls']) || 0)),
        builds: Math.max(0, Math.floor(Number(st['builds']) || 0)),
        automations: Math.max(0, Math.floor(Number(st['automations']) || 0)),
        stormsSurvived: Math.max(0, Math.floor(Number(st['stormsSurvived']) || 0)),
      };
    }
    state.tutorial = base;
  } else {
    state.tutorial = emptyTutorialState();
  }

  HistorySystem.clear(state);

  let maxId = state.nextId;
  for (const e of [...state.rovers, ...state.buildings]) maxId = Math.max(maxId, e.id + 1);
  for (const d of state.world.deposits) maxId = Math.max(maxId, d.id + 1);
  state.nextId = maxId;
}
