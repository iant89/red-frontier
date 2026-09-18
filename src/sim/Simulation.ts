/**
 * The authoritative simulation — Phase 2 refactored to use ColonyState.
 *
 * Framework-agnostic by construction: no DOM, no three.js, no wall clock. The
 * renderer and HUD only ever *read* from here. That constraint is what will let
 * this module move onto a Worker without touching a line of rendering code.
 *
 * Tick order follows TDD §4:
 *   1. clock / day-night      5. life support & colonist
 *   2. weather (P3)           6. jobs & tasks
 *   3. power network          7. movement
 *   4. production             8. construction
 *                             9. failure checks → alerts → history
 *
 * Phase 2: Simulation owns a ColonyState (src/sim/state/ColonyState.ts) and
 * proxies its old public fields for backward compatibility.
 */

import { World } from './World';
// Phase 9: `evaluateSite` is no longer called here — ConstructionSystem.verdict
// owns that call. `rules.ts` remains the single producer of the siting strings,
// shared with `host/mirror.ts` so the build ghost and the sim cannot disagree.
import { maintenanceNeed } from './rules';
import type { Deposit } from './World';
import { clamp } from '../lib/rng';
import {
  SIM_TICK,
  SPAWN_X,
  SPAWN_Z,
  HOURS_PER_SEC,
  SOLS_PER_SEC,
  SUIT_O2_CAPACITY,
  SAVE_VERSION,
  BUILDING_MAX_HEALTH,
  DAMAGED_HEALTH,
  REPAIR_RESTART_HEALTH,
  GARAGE_SERVICE_RATE,
  DEV_MAX_BUILDING_LEVEL,
  devLevelMul,
} from './config';
import type {
  ResourceId,
  ResourceAmounts,
  FluidId,
  RoverKind,
  BuildingKind,
} from './defs';
import {
  RESOURCES,
  ROVERS,
  BUILDINGS,
  ALL_RESOURCES,
  emptyAmounts,
} from './defs';
import {
  DIFFICULTIES,
  DEFAULT_WORLD_OPTIONS,
} from './difficulty';
import type { DifficultyId, WorldOptions } from './difficulty';
import { POI_KINDS } from './pois';
import type { Poi, PoiKind } from './pois';
import { ExplorationSystem } from './systems/ExplorationSystem';
import { SolClock } from './clock';
import type { SunState } from './clock';
import type { Weather, StormKindReal } from './weather';
import type { PowerResult } from './power';
import {
  colonistStatusText,
  type Colonist,
  type ColonistOrder,
  type FluidPools,
} from './lifesupport';
import { AlertBus, type Severity } from './alerts';
import { assertInvariants, invariantChecksEnabled } from './debug/SimulationAssertions';
import { getProfiler, profilerEnabled } from './debug/Profiler';
import { decodeSave } from './persistence/SaveCodec';
import { coerceTask } from './persistence/SaveValidator';
import type { SaveState } from './persistence/SaveSchema';
import { ClockSystem } from './systems/ClockSystem';
import { WeatherSystem, type WeatherHostHooks } from './systems/WeatherSystem';
import { PowerSystem, type PowerSystemContext } from './systems/PowerSystem';
import { ProductionSystem } from './systems/ProductionSystem';
import { LifeSupportSystem, type LifeSupportHostHooks } from './systems/LifeSupportSystem';
import { ConstructionSystem, type ConstructionHostHooks } from './systems/ConstructionSystem';
import { RoverSystem, type RoverHostHooks } from './systems/RoverSystem';
import {
  FleetAutomationSystem,
  type FleetAutomationHostHooks,
} from './systems/FleetAutomationSystem';
import { LogisticsSystem } from './systems/LogisticsSystem';
import {
  FailureSystem,
  type FailureHostHooks,
  type FailureSystemContext,
} from './systems/FailureSystem';
import { AlertSystem } from './systems/AlertSystem';
import { HistorySystem } from './systems/HistorySystem';

// Phase 2 — state extraction
import {
  createColonyState,
  resetExplorationState,
  recomputeCapacitiesState,
  type ColonyState,
} from './state/ColonyState';
import {
  type Rover,
  type RoverTask,
  type RoverGoal,
  type RoverPhase,
  defaultRoverRules,
  cargoMass,
  roverStatusText,
} from './state/RoverState';
import {
  type Building,
  remainingCostTotal,
  lightningVulnerability,
} from './state/BuildingState';
import type { FluidFlow } from './state/ResourceState';
import type { HistorySample } from './state/HistoryState';
import { batteryCapacityKWh } from './state/PowerState';

// Re-export for backward compat (old import sites still work)
export type { RoverTask, RoverCommand, RoverRules, Rover, RoverGoal, RoverPhase, Building, HistorySample, FluidFlow } from './state';
export type { Colonist } from './lifesupport';
export { defaultRoverRules, cargoMass, roverStatusText, remainingCostTotal, lightningVulnerability };

// ---------------------------------------------------------- simulation ----

export class Simulation {
  readonly state: ColonyState;

  /**
   * Cross-domain side effects WeatherSystem triggers but does not own
   * (Phase 5 seam). Phase 10 absorbed disableRover into RoverSystem; Phase 15
   * absorbed tripDamaged / endMission into FailureSystem. The contract is
   * unchanged — only the implementor moved.
   */
  private readonly weatherHooks: WeatherHostHooks = {
    tripDamaged: (b, cause) => {
      const ev = FailureSystem.tripDamaged(this.state, b, cause, this.failureHooks);
      AlertSystem.applyFailureEvents(this.state, [ev]);
    },
    disableRover: (r) => RoverSystem.disable(this.state, r),
    endMission: (reason) => {
      const ev = FailureSystem.endMission(this.state, reason);
      AlertSystem.applyFailureEvents(this.state, [ev]);
    },
  };

  /**
   * Phase 8: the production-domain answers PowerSystem needs now live in
   * ProductionSystem. Simulation only wires the context; the implementor
   * is no longer here. Same shape as {@link weatherHooks}.
   */
  private readonly powerContext: PowerSystemContext = {
    desiredThroughput: (b) => ProductionSystem.desiredThroughput(this.state, b),
    runProcess: (b, throughput, hours) => ProductionSystem.runProcess(this.state, b, throughput, hours),
    processBlockReason: (b) => ProductionSystem.processBlockReason(this.state, b),
  };

  /**
   * Cross-domain effects LifeSupportSystem triggers but does not own
   * (Phase 7 seam). Phase 15 absorbed endMission into FailureSystem; Phase 9
   * moved completeBuilding into ConstructionSystem. The contract is unchanged.
   * Same shape as {@link weatherHooks} / {@link powerContext}.
   */
  private readonly lifeSupportHooks: LifeSupportHostHooks = {
    endMission: (reason) => {
      const ev = FailureSystem.endMission(this.state, reason);
      AlertSystem.applyFailureEvents(this.state, [ev]);
    },
    completeBuilding: (b) => ConstructionSystem.complete(this.state, b),
  };

  /**
   * Cross-domain effects ConstructionSystem triggers but does not own
   * (Phase 9 seam). A site's *worker* is a rover, so pathing, task lifecycle,
   * wear and the flat-battery strand belong to RoverSystem (Phase 10); "is
   * this rover stuck on cargo the silos cannot take" is a haul question for
   * LogisticsSystem (Phase 13). Simulation implements them against the
   * machinery that already lives here, so no second source of truth appears.
   * Same shape as {@link weatherHooks} / {@link lifeSupportHooks}.
   */
  private readonly constructionHooks: ConstructionHostHooks = {
    setTravel: (r, x, z, goal) => RoverSystem.setTravel(this.state, r, x, z, goal),
    finishTask: (r) => RoverSystem.finishTask(r),
    autoAssign: (r, task) => RoverSystem.autoAssign(r, task),
    disableRover: (r) => RoverSystem.disable(this.state, r),
    roverWorkMul: (r) => RoverSystem.roverWorkMul(r),
    canDeliverCargo: (r) => this.canDeliverAny(r),
  };

  /**
   * Cross-domain effects RoverSystem triggers but does not own (Phase 10 seam).
   * `constructSite` is ConstructionSystem's job (Phase 9); `canDeliverCargo`
   * is the haul question LogisticsSystem (Phase 13) owns — the same
   * implementor Phase 9 wired into its own hooks.
   */
  private readonly roverHooks: RoverHostHooks = {
    constructSite: (r, b) => ConstructionSystem.build(this.state, r, b, this.constructionHooks),
    canDeliverCargo: (r) => this.canDeliverAny(r),
  };

  /**
   * Cross-domain answers FleetAutomationSystem asks but does not own (Phase 12
   * seam). The one question is the haul ledger LogisticsSystem (Phase 13) owns
   * — the same implementor Phase 9 and Phase 10 wired into their own hooks, so
   * "is this rover stuck on cargo the silos cannot take" has exactly one
   * answer for all three callers.
   */
  private readonly fleetHooks: FleetAutomationHostHooks = {
    canDeliverCargo: (r) => this.canDeliverAny(r),
  };

  /**
   * Cross-domain effects FailureSystem triggers but does not own (Phase 15
   * seam). Releasing a builder when a structure trips is rover-task lifecycle.
   */
  private readonly failureHooks: FailureHostHooks = {
    finishTask: (r) => RoverSystem.finishTask(r),
  };

  /**
   * Answers FailureSystem's checks need but do not own: the trailing-sol
   * fluid reserve ledger, and the shared online-and-undamaged predicate.
   */
  private readonly failureContext: FailureSystemContext = {
    reserveSols: (f) => this.reserveSols(f),
    runnable: (b) => this.runnable(b),
  };

  constructor(params: {
    seed: number;
    nearDeposits?: number;
    difficulty?: DifficultyId;
    worldHalf?: number;
    region?: string | null;
    worldOptions?: Partial<WorldOptions>;
  }) {
    this.state = createColonyState(params);
  }

  // ---- state proxies (backward compat) ----
  get world(): World { return this.state.world; }
  set world(v: World) { this.state.world = v; }
  get version(): number { return SAVE_VERSION; }
  get seed(): number { return this.state.seed; }
  set seed(v: number) { this.state.seed = v; }
  get difficulty(): DifficultyId { return this.state.difficulty; }
  set difficulty(v: DifficultyId) { this.state.difficulty = v; }
  get worldOptions(): WorldOptions { return this.state.worldOptions; }
  set worldOptions(v: WorldOptions) { this.state.worldOptions = v; }
  get consumptionMul(): number { return this.state.consumptionMul; }
  set consumptionMul(v: number) { this.state.consumptionMul = v; }

  private get nextId(): number { return this.state.nextId; }
  private set nextId(v: number) { this.state.nextId = v; }

  get clock(): SolClock { return this.state.clock; }
  set clock(v: SolClock) { this.state.clock = v; }
  get alerts(): AlertBus { return this.state.alerts; }
  set alerts(v: AlertBus) { this.state.alerts = v; }

  get rovers(): Rover[] { return this.state.rovers; }
  set rovers(v: Rover[]) { this.state.rovers = v; }
  get buildings(): Building[] { return this.state.buildings; }
  set buildings(v: Building[]) { this.state.buildings = v; }
  get colonist(): Colonist { return this.state.colonist; }
  set colonist(v: Colonist) { this.state.colonist = v; }

  get storage(): ResourceAmounts { return this.state.storage; }
  set storage(v: ResourceAmounts) { this.state.storage = v; }
  get pools(): FluidPools { return this.state.pools; }
  set pools(v: FluidPools) { this.state.pools = v; }

  get power(): PowerResult { return this.state.power; }
  set power(v: PowerResult) { this.state.power = v; }
  get storedKWh(): number { return this.state.storedKWh; }
  set storedKWh(v: number) { this.state.storedKWh = v; }

  get flows(): Record<FluidId, FluidFlow> { return this.state.flows; }
  set flows(v: Record<FluidId, FluidFlow>) { this.state.flows = v; }
  get lastFlows(): Record<FluidId, FluidFlow> { return this.state.lastFlows; }
  set lastFlows(v: Record<FluidId, FluidFlow>) { this.state.lastFlows = v; }
  get flowWindow(): Array<{ t: number; f: Record<FluidId, FluidFlow> }> { return this.state.flowWindow; }
  set flowWindow(v: Array<{ t: number; f: Record<FluidId, FluidFlow> }>) { this.state.flowWindow = v; }

  get history(): HistorySample[] { return this.state.history; }
  set history(v: HistorySample[]) { this.state.history = v; }

  get gameOver(): { reason: string; sol: number } | null { return this.state.gameOver; }
  set gameOver(v: { reason: string; sol: number } | null) { this.state.gameOver = v; }

  get dustTransmission(): number { return this.state.dustTransmission; }
  set dustTransmission(v: number) { this.state.dustTransmission = v; }

  get weather(): Weather { return this.state.weather; }
  set weather(v: Weather) { this.state.weather = v; }
  private get stormAnnounced(): boolean { return this.state.stormAnnounced; }
  private set stormAnnounced(v: boolean) { this.state.stormAnnounced = v; }

  get nextDropSol(): number { return this.state.nextDropSol; }
  set nextDropSol(v: number) { this.state.nextDropSol = v; }
  private get dropRng(): () => number { return this.state.dropRng; }
  private set dropRng(v: () => number) { this.state.dropRng = v; }

  get simTime(): number { return this.state.simTime; }
  set simTime(v: number) { this.state.simTime = v; }
  private get ticksRun(): number { return this.state.ticksRun; }
  private set ticksRun(v: number) { this.state.ticksRun = v; }
  private get remainder(): number { return this.state.remainder; }
  private set remainder(v: number) { this.state.remainder = v; }
  private get _storageCapacity(): number { return this.state._storageCapacity; }
  private set _storageCapacity(v: number) { this.state._storageCapacity = v; }

  // ------------------------------------------------------------ setup ----
  // (`spawnStart` and `allocId` used to live here. The fleet's opening rovers
  // have been built by `ColonyState.createColonyState` since Phase 2, and
  // `RoverSystem.spawn` allocates ids from `state.nextId` since Phase 10.)

  get nextEntityId(): number {
    return this.state.nextId;
  }

  recomputeCapacities(): void {
    recomputeCapacitiesState(this.state);
  }

  private resetExploration(nextDropSol?: number): void {
    resetExplorationState(this.state, nextDropSol);
  }

  // ---- storage ledger (Phase 13: LogisticsSystem owns resource accounting) --
  // The public surface the HUD, hosts and tests call stays here as thin
  // delegates, exactly like the rover command verbs kept their names after
  // Phase 10; the arithmetic and the capacity rules live in the system.

  /** Capacity **per resource type** (kg). */
  storageCapacity(): number {
    return LogisticsSystem.capacity(this.state);
  }

  /** Free space for one specific resource (kg). */
  storageRoom(res: ResourceId): number {
    return LogisticsSystem.room(this.state, res);
  }

  storageTotal(): number {
    return LogisticsSystem.total(this.state);
  }

  /** Total capacity across every silo — used for the HUD's aggregate bar. */
  storageTotalCapacity(): number {
    return LogisticsSystem.totalCapacity(this.state);
  }

  /** True only when *every* silo is full (nothing can be unloaded at all). */
  storageFull(): boolean {
    return LogisticsSystem.isFull(this.state);
  }

  /** Resources whose silo is full — the useful warning. */
  fullResources(): ResourceId[] {
    return LogisticsSystem.fullResources(this.state);
  }

  /** Total grid battery capacity (kWh), pod included. */
  batteryCapacity(): number {
    // Phase 6: capacity logic owns itself in state/PowerState.ts
    return batteryCapacityKWh(this.state);
  }

  get sun(): SunState {
    return this.clock.sun;
  }

  // ------------------------------------------------------- UI queries ----
  defsFor(kind: RoverKind) {
    return ROVERS[kind];
  }

  roverById(id: number): Rover | undefined {
    return this.rovers.find((r) => r.id === id);
  }

  buildingById(id: number): Building | undefined {
    return this.buildings.find((b) => b.id === id);
  }

  onlineBuildings(): Building[] {
    return this.buildings.filter((b) => b.state === 'online');
  }

  /**
   * Rovers with nothing to do: no task, no queue, not charging up after a
   * low-battery return, not storm-sheltering, not stranded. The `.` hotkey
   * and the HUD's idle button cycle through these.
   */
  idleRovers(): Rover[] {
    return this.rovers.filter(
      (r) =>
        r.phase !== 'disabled' &&
        !r.recharge &&
        !r.sheltered &&
        r.command.type === 'idle' &&
        r.pending.length === 0,
    );
  }

  onlineWarehouses(): Building[] {
    return this.buildings.filter(
      (b) => this.runnable(b) && BUILDINGS[b.kind].storagePerResourceKg > 0,
    );
  }

  /** Every pressurised volume the colonist could shelter in (pod is id 0). */
  shelters(): Array<{ id: number; x: number; z: number; radius: number; recycles: boolean }> {
    // Phase 7: the shelter map lives in LifeSupportSystem
    return LifeSupportSystem.shelters(this.state);
  }

  depositAt(x: number, z: number): { d: Deposit; reach: number } | null {
    let best: Deposit | null = null;
    let bestDist = Infinity;
    for (const d of this.world.deposits) {
      if (d.amount <= 0) continue;
      const dist = Math.hypot(d.x - x, d.z - z);
      if (dist <= d.radius + 3 && dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    if (!best) return null;
    return { d: best, reach: best.radius + 2.4 };
  }

  buildingAt(x: number, z: number): { b: Building; reach: number } | null {
    let best: Building | null = null;
    let bestDist = Infinity;
    for (const b of this.buildings) {
      const rad = BUILDINGS[b.kind].radius;
      const dist = Math.hypot(b.x - x, b.z - z);
      if (dist <= rad + 4 && dist < bestDist) {
        bestDist = dist;
        best = b;
      }
    }
    if (!best) return null;
    return { b: best, reach: BUILDINGS[best.kind].radius + 3 };
  }

  // ------------------------------------------------------- rover queries ----
  // Phase 10: the rover's behavior lives in systems/RoverSystem.ts. Everything
  // below is the sim-side surface the hosts, the HUD, the fleet automation and
  // `applyCommand` call — deliberately thin, so the rover's rules have exactly
  // one owner.

  /** True when a rover sitting here could pour its hold into a silo. */
  nearDepot(x: number, z: number): boolean {
    return RoverSystem.nearDepot(this.state, x, z);
  }

  /** Somewhere a rover can draw charge: the pod, or any online habitat. */
  nearCharger(x: number, z: number): boolean {
    // Phase 6: the charger map lives in PowerSystem
    return RoverSystem.nearCharger(this.state, x, z);
  }

  issueMove(roverId: number, x: number, z: number, queued = false): void {
    RoverSystem.issueMove(this.state, roverId, x, z, queued);
  }

  issueMine(roverId: number, depositId: number, queued = false): void {
    RoverSystem.issueMine(this.state, roverId, depositId, queued);
  }

  /**
   * Drive to the nearest depot and pour out whatever fits (GDD §5 UNLOAD).
   * Queued behind a mining run it closes the loop explicitly; ordered plain
   * it interrupts the rover now. An empty hold is a no-op with a log line.
   */
  issueUnload(roverId: number, queued = false): void {
    RoverSystem.issueUnload(this.state, roverId, queued);
  }

  /** Hold position for a while (GDD §5 WAIT — usually queued between jobs). */
  issueWait(roverId: number, seconds: number, queued = false): void {
    RoverSystem.issueWait(this.state, roverId, seconds, queued);
  }

  issueConstruct(roverId: number, buildingId: number, queued = false): void {
    RoverSystem.issueConstruct(this.state, roverId, buildingId, queued);
  }

  stopRover(roverId: number): void {
    RoverSystem.stopRover(this.state, roverId);
  }

  /** Convert the active mining task into a repeating haul route (or back). */
  setRepeatRoute(roverId: number, on: boolean): void {
    RoverSystem.setRepeatRoute(this.state, roverId, on);
  }

  /** Flip one of the player-authored automation rules (GDD §5). */
  setRoverRule(
    roverId: number,
    rule: 'autoHaul' | 'autoService' | 'stormShelter' | 'autoRescue',
    on: boolean,
  ): void {
    RoverSystem.setRoverRule(this.state, roverId, rule, on);
  }

  /** Set the rover's return-to-charge battery floor (percent, 10–60). */
  setChargeFloor(roverId: number, pct: number): void {
    RoverSystem.setChargeFloor(this.state, roverId, pct);
  }

  /**
   * Flip the position-lights switch (headlights + rear strobe). When on,
   * the sim lights them automatically at night or in low visibility — and
   * bills the battery for every hour they stay lit.
   */
  setRoverLights(roverId: number, on: boolean): void {
    RoverSystem.setRoverLights(this.state, roverId, on);
  }

  /**
   * The sim's one judgement call about visibility: it is dark or the dust has
   * closed visibility in (rover domain).
   */
  lightsNeeded(): boolean {
    return RoverSystem.lightsNeeded(this.state);
  }

  /**
   * Start assembling a rover on a garage's line. Materials leave storage up
   * front; the build itself runs on garage power and pauses in a brownout.
   */
  assembleRover(buildingId: number, kind: RoverKind): boolean {
    const b = this.buildingById(buildingId);
    if (!b || b.kind !== 'garage' || !this.runnable(b) || !b.enabled) {
      this.event('warn', 'Rovers are assembled at an online Rover Garage.');
      return false;
    }
    if (b.assembly) {
      this.event('info', `The garage line is already building a ${ROVERS[b.assembly.kind].label}.`);
      return false;
    }
    const def = ROVERS[kind];
    // Phase 9: the material ledger has one owner. Assembly *spends* mass the
    // same way a site does, so it asks ConstructionSystem rather than keeping
    // a second copy of "can we afford this" (roadmap §17's design rule).
    if (!ConstructionSystem.hasMaterials(this.state, def.cost)) {
      this.event(
        'warn',
        `Not enough materials for a ${def.label} — needs ${ConstructionSystem.missingList(def.cost)}.`,
      );
      return false;
    }
    ConstructionSystem.consumeMaterials(this.state, def.cost);
    b.assembly = { kind, progress: 0 };
    this.event(
      'info',
      `${def.label} assembly started — about ${Math.round(def.buildTime)} s on the line.`,
    );
    return true;
  }

  /** Send a rover out to jump-start a stranded one (TDD §8's RECOVER task). */
  issueRecover(roverId: number, strandedId: number, queued = false): boolean {
    return RoverSystem.issueRecover(this.state, roverId, strandedId, queued);
  }

  /** Turn a building on or off (load shedding by hand). */
  setBuildingEnabled(buildingId: number, enabled: boolean): void {
    const b = this.buildingById(buildingId);
    if (!b) return;
    if (b.enabled === enabled) return;
    b.enabled = enabled;
    this.recomputeCapacities();
    // Observation equipment is a derived weather capability; update it now so
    // a paused colony never shows a stale radar map after load-shedding.
    WeatherSystem.refreshRadar(this.state);
    this.event(
      enabled ? 'ok' : 'info',
      `${BUILDINGS[b.kind].label} ${enabled ? 'switched on' : 'switched off'}.`,
    );
  }

  /**
   * Cancel an unfinished site (refunding what was already delivered) or
   * dismantle a standing structure.
   *
   * Phase 9: the rules live in ConstructionSystem — including the deliberate
   * "refund in full even if it overfills the silo" behaviour that
   * `SimulationAssertions` documents as a legal state.
   */
  demolish(buildingId: number): void {
    ConstructionSystem.demolish(this.state, buildingId, this.constructionHooks);
    WeatherSystem.refreshRadar(this.state);
  }

  /**
   * Send a rover to clean a building's exposed surfaces. Fails (with a log
   * line) if there is nothing to clean or the storm makes it unsafe.
   */
  issueClean(roverId: number, buildingId: number, queued = false): boolean {
    return RoverSystem.issueClean(this.state, roverId, buildingId, queued);
  }

  /** Send a rover to repair a damaged (or battered) building. */
  issueRepair(roverId: number, buildingId: number, queued = false): boolean {
    return RoverSystem.issueRepair(this.state, roverId, buildingId, queued);
  }

  /**
   * Convenience dispatch used by the building inspector: pick the nearest idle
   * rover and send it to service this building (repair first, then clean).
   */
  dispatchMaintenance(buildingId: number): boolean {
    return RoverSystem.dispatchMaintenance(this.state, buildingId);
  }

  /**
   * What maintenance a building currently needs, if any — the single source of
   * truth the HUD and the tap-to-order gesture both read.
   */
  needsMaintenance(buildingId: number): 'repair' | 'clean' | null {
    return maintenanceNeed(this.buildingById(buildingId));
  }

  orderColonist(order: ColonistOrder): void {
    // Phase 7: EVA range, weather refusal and the order itself live in LifeSupportSystem
    LifeSupportSystem.order(this.state, order);
  }

  // -------------------------------------------------------- placement ----
  // Phase 9: ConstructionSystem owns the construction job; the siting rule
  // itself stays in `rules.ts` so the mirrored view keeps running the *same*
  // function against the same seed. These three are the sim-side surface the
  // hosts and the build ghost call, and they are deliberately thin: the
  // authority is the simulation's, never the UI's.

  /**
   * The siting rule lives in `rules.ts` so the mirrored view can run the *same*
   * function against the same seed. This is the authoritative call: it sees the
   * live world, and `building/place` re-checks it before anything is sited.
   */
  canPlace(kind: BuildingKind, x: number, z: number): string | null {
    return this.placeVerdict(kind, x, z);
  }

  /** The authoritative siting verdict used by placement previews and commands. */
  placeVerdict(kind: BuildingKind, x: number, z: number): string | null {
    return ConstructionSystem.verdict(this.state, kind, x, z);
  }

  /** Site a building: the sim decides whether the placement is legal. */
  placeBuilding(kind: BuildingKind, x: number, z: number): Building | null {
    return ConstructionSystem.place(this.state, kind, x, z);
  }

  // ------------------------------------------------------- developer mode ----
  /**
   * Runtime-only backdoors for the developer panel. They mutate ordinary
   * entity state — a fabricated rover is a real rover from then on — but add
   * nothing to the save file: upgrade levels are never snapshotted, and the
   * panel's own switches live outside the sim entirely.
   */

  /** Fab a rover of `kind` out of thin air at world position. */
  devSpawnRover(kind: RoverKind, x: number, z: number): Rover {
    const r = RoverSystem.spawn(this.state, kind, x, z, Math.atan2(SPAWN_X - x, SPAWN_Z - z));
    this.event('ok', `${r.label} #${r.id} rolled out of nowhere — charged and ready (developer).`);
    return r;
  }

  /**
   * Fab a building instantly: placed for free, fully assembled and online.
   * Siting is still honest — the terrain and clearance checks apply, so a
   * bad spot returns null with the reason in the log.
   */
  devSpawnBuilding(kind: BuildingKind, x: number, z: number): Building | null {
    // Phase 9: ConstructionSystem.devSpawn runs the same siting check, then
    // `complete` flips it online, recomputes capacities and logs the
    // "+storage / +kW" extras exactly like an ordinary finish.
    const b = ConstructionSystem.devSpawn(this.state, kind, x, z);
    WeatherSystem.refreshRadar(this.state);
    return b;
  }

  /** Survey a fresh resource deposit in at world position. */
  devSpawnDeposit(resource: ResourceId, x: number, z: number, amountKg: number): Deposit {
    const d = this.world.addDeposit(resource, x, z, Math.max(10, amountKg));
    this.event(
      'ok',
      `${RESOURCES[resource].label} deposit surveyed in — ${Math.round(d.amount)} kg (developer).`,
    );
    return d;
  }

  /**
   * Complete a construction site instantly, for free. Any rover walking a
   * construct task to it is released exactly like a demolition release.
   */
  devCompleteBuilding(id: number): boolean {
    const ok = ConstructionSystem.devComplete(this.state, id, this.constructionHooks);
    WeatherSystem.refreshRadar(this.state);
    return ok;
  }

  /**
   * Set a building's developer upgrade level (1..DEV_MAX, clamped). Returns
   * the level it landed on. Never persisted — see the field's comment.
   */
  devSetBuildingLevel(id: number, level: number): number {
    const b = this.buildingById(id);
    if (!b) return 1;
    const next = clamp(Math.round(level), 1, DEV_MAX_BUILDING_LEVEL);
    if (next !== b.level) {
      b.level = next;
      this.recomputeCapacities();
    }
    return b.level;
  }

  /*
   * ---------------------------------------------------------- dev edits ----
   *
   * The writes the developer panel performs, as sim methods rather than field
   * pokes from UI code (TDD §22). They exist for one reason: once the sim can
   * live behind a worker, the panel has no objects to poke, so every edit has
   * to arrive as a command and land here. Keeping the *rules* on this side also
   * means the clamping is the sim's, not a copy in the panel that could drift.
   *
   * None of these are persisted — like the upgrade `level` they touch, they are
   * edits to live state that `snapshot()` deliberately never learns about.
   */

  /** Push the airborne dust reading to `frac`; it relaxes back on its own. */
  devSetDust(frac: number): void {
    this.weather.dust = clamp(frac, 0, 1);
  }

  /** Conjure a storm of `kind`, arriving within seconds. */
  devForceStorm(kind: StormKindReal): void {
    this.weather.debugScheduleStorm(kind, this.simTime, 4);
  }

  /** Dismiss every storm, on the map and on the forecast board. */
  devClearStorms(): void {
    this.weather.debugClearStorms();
  }

  /** Suspend the storm scheduler, or let the rolls run again. */
  devSetStormScheduler(on: boolean): void {
    if (on) this.weather.debugResumeRolls(this.simTime);
    else this.weather.debugSuppressRolls();
  }

  /** Set a rover's charge as a fraction of its pack (0..1). */
  devSetRoverBatteryFrac(roverId: number, frac: number): boolean {
    const r = this.roverById(roverId);
    if (!r) return false;
    r.battery = clamp(frac, 0, 1) * ROVERS[r.kind].maxBatteryKWh;
    return true;
  }

  /** Drivetrain condition, 0..100. */
  devSetRoverCondition(roverId: number, pct: number): boolean {
    const r = this.roverById(roverId);
    if (!r) return false;
    r.condition = clamp(pct, 0, 100);
    return true;
  }

  /**
   * Set one cargo slot to `kg`, clamped into the hopper's free room. Returns
   * the load that actually landed, so the panel can echo the truth.
   */
  devSetRoverCargo(roverId: number, res: ResourceId, kg: number): number {
    const r = this.roverById(roverId);
    if (!r) return 0;
    let others = 0;
    for (const k of ALL_RESOURCES) if (k !== res) others += r.cargo[k];
    r.cargo[res] = Math.min(Math.max(0, kg), Math.max(0, ROVERS[r.kind].capacityKg - others));
    return r.cargo[res];
  }

  /** Empty the hopper. */
  devClearRoverCargo(roverId: number): boolean {
    const r = this.roverById(roverId);
    if (!r) return false;
    for (const k of ALL_RESOURCES) r.cargo[k] = 0;
    return true;
  }

  /**
   * Structural health 0..100, crossing the sim's damage thresholds honestly:
   * dropping to `DAMAGED_HEALTH` takes a structure offline, and only climbing
   * back to `REPAIR_RESTART_HEALTH` restarts it — the same pair of numbers a
   * rover's repair work is judged against.
   */
  devSetBuildingHealth(buildingId: number, pct: number): boolean {
    const b = this.buildingById(buildingId);
    if (!b) return false;
    b.health = clamp(pct, 0, 100);
    if (b.health <= DAMAGED_HEALTH) b.damaged = true;
    else if (b.damaged && b.health >= REPAIR_RESTART_HEALTH) b.damaged = false;
    this.recomputeCapacities();
    return true;
  }

  /** Panel cleanliness 0..1 (meaningful on solar, harmless elsewhere). */
  devSetBuildingCleanliness(buildingId: number, frac: number): boolean {
    const b = this.buildingById(buildingId);
    if (!b) return false;
    b.cleanliness = clamp(frac, 0, 1);
    return true;
  }

  /** Set the damaged flag directly, leaving health alone. */
  devSetBuildingDamaged(buildingId: number, on: boolean): boolean {
    const b = this.buildingById(buildingId);
    if (!b || b.damaged === on) return false;
    b.damaged = on;
    this.recomputeCapacities();
    return true;
  }

  /** The colonist's health, 0..100. A dead crew is not revivable. */
  devSetColonistHealth(pct: number): boolean {
    if (this.colonist.dead) return false;
    this.colonist.health = clamp(pct, 0, 100);
    return true;
  }

  /** Top the suit tank back up. */
  devRefillSuit(): void {
    this.colonist.suitO2 = SUIT_O2_CAPACITY;
  }

  /**
   * Jump the mission calendar: set the sol and the time-of-day fraction
   * (0 = midnight, 0.25 = sunrise, 0.5 = noon). simTime is re-synced so the
   * weather scheduler and history windows stay coherent after the jump.
   *
   * Phase 4: clock part delegated to ClockSystem.setTime.
   * Phase 5: weather re-anchor delegated to WeatherSystem.afterTimeJump.
   */
  devSetTime(sol: number, frac: number): void {
    ClockSystem.setTime(this.state, sol, frac);
    WeatherSystem.afterTimeJump(this.state);
    HistorySystem.afterTimeJump(this.state);
  }

  // -------------------------------------------------------- main loop ----

  /** Advance simulation by `frameDt` game seconds (fixed substeps applied). */
  step(frameDt: number): number {
    // Phase 4: fixed-step accumulation delegated to ClockSystem
    const owed = ClockSystem.consume(this.state, frameDt);

    let ticks = 0;
    const t0 = profilerEnabled() ? performance.now() : 0;
    while (ticks < owed) {
      this.tick();
      ticks++;
    }

    if (profilerEnabled()) {
      const dt = performance.now() - t0;
      getProfiler().recordStep(ticks, dt);
    }

    if (invariantChecksEnabled()) assertInvariants(this, `step at t=${this.simTime.toFixed(2)}s`);

    return ticks;
  }

  private tick(): void {
    if (this.gameOver) return;

    // 1. clock & sun — Phase 4: delegated to ClockSystem
    const newSol = ClockSystem.tick(this.state);
    if (newSol) {
      this.event('info', `A new sol begins. Sol ${this.clock.sol + 1}.`);
    }

    // 2. weather (TDD §4's tick order puts it right after the clock)
    // Phase 5: delegated to WeatherSystem
    WeatherSystem.tick(this.state, this.weatherHooks);

    // 2b. the world past the base: what the fleet has found, and what Earth sent
    // Phase 14: delegated to ExplorationSystem
    ExplorationSystem.tick(this.state);

    // 3 & 4. power network, then production scaled by what it delivered.
    // Phase 6: delegated to PowerSystem
    PowerSystem.tick(this.state, this.powerContext);
    this.tickGarages();

    // 5. life support & the human
    // Phase 7: delegated to LifeSupportSystem
    LifeSupportSystem.tick(this.state, this.lifeSupportHooks);

    // 6/7/8. logistics, jobs, movement, construction
    // Phase 9: site materials and worker choice are ConstructionSystem's
    ConstructionSystem.tickSiteMaterials(this.state);
    ConstructionSystem.assignBuilders(this.state, this.constructionHooks);
    // Phase 12: the fleet's own dispatch (maintenance, rescue, supply runs)
    FleetAutomationSystem.tick(this.state, this.fleetHooks);
    for (const r of this.rovers) {
      if (r.phase === 'disabled') continue;
      if (!RoverSystem.tickLights(this.state, r)) continue; // the lights drank the last of it
      RoverSystem.updateRover(this.state, r, this.roverHooks);
    }
    for (const r of this.rovers) {
      if (r.phase === 'disabled') continue;
      RoverSystem.moveRover(this.state, r);
    }
    LifeSupportSystem.tickColonist(this.state, this.lifeSupportHooks);

    // 9. failure checks, alerts, history (Phases 15–17)
    this.evaluateAlerts();
    HistorySystem.tick(this.state);
  }

  // ------------------------------------------------------------ weather ----
  // Phase 5: the weather tick, its colony effects (panel dust, wind damage)
  // and the lightning resolver live in systems/WeatherSystem.ts — Simulation
  // passes the state plus the cross-domain hooks. Weather *queries* (shelter,
  // EVA limits, work rates) stay inline at their call sites until the phases
  // that own them extract those systems.

  /** Test/cheat hook (TDD §22): drop a bolt on the most exposed target now. */
  devForceLightningStrike(): void {
    WeatherSystem.resolveLightningStrike(this.state, this.weatherHooks, 'exact');
  }


  // -------------------------------------------------------- exploration ----
  // Phase 14: discovery, supply drops, burial and site-side salvage rewards
  // live in systems/ExplorationSystem.ts. World owns physical sites
  // (`world.pois`); Simulation exposes them directly (World vs Exploration).

  /** Every site on the planet — found or not. */
  get pois(): Poi[] {
    return this.world.pois;
  }

  poiById(id: number): Poi | undefined {
    return this.world.pois.find((p) => p.id === id);
  }

  /**
   * Send a rover to cut a site apart and haul it home (GDD §05's SALVAGE task).
   *
   * Refusals are the same shape as every other order's: a log line saying why,
   * and nothing queued. The interesting one is the undiscovered site — the sim
   * knows about it, the player is not supposed to yet, so it cannot be ordered.
   */
  issueSalvage(roverId: number, poiId: number, queued = false): boolean {
    return RoverSystem.issueSalvage(this.state, roverId, poiId, queued);
  }

  // Phase 15: tripDamaged lives in FailureSystem (weatherHooks implementor).

  /** Whether a building is online *and* structurally sound enough to run. */
  private runnable(b: Building): boolean {
    return b.state === 'online' && !b.damaged;
  }

  // ------------------------------------------------------------ power ----
  // Phase 6: the grid tick lives in systems/PowerSystem.ts.
  // Phase 8: the production-domain answers (desiredThroughput / runProcess /
  // processBlockReason) live in systems/ProductionSystem.ts — Simulation
  // only wires them into PowerSystemContext. The garage bay (service +
  // assembly), which *consumes* powerSat rather than converting mass, stays
  // here until its owning phase extracts it.

  /**
   * Rover garages (P4): service the drivetrains of anything parked in the bay
   * and advance the assembly line. Both scale with the power the garage
   * actually received — a brownout slows the line to a crawl.
   */
  private tickGarages(): void {
    for (const b of this.buildings) {
      if (b.kind !== 'garage' || !this.runnable(b) || !b.enabled) continue;
      const reach = BUILDINGS.garage.radius + 5;
      const service =
        GARAGE_SERVICE_RATE * devLevelMul(b.level) * SIM_TICK * (0.3 + 0.7 * b.powerSat);
      for (const r of this.rovers) {
        if (r.phase === 'disabled' || r.condition >= 100) continue;
        if (Math.hypot(b.x - r.x, b.z - r.z) <= reach) {
          r.condition = Math.min(100, r.condition + service);
        }
      }
      if (b.assembly) {
        const def = ROVERS[b.assembly.kind];
        b.assembly.progress += (SIM_TICK * b.powerSat) / def.buildTime;
        if (b.assembly.progress >= 1) {
          const kind = b.assembly.kind;
          b.assembly = null;
          // Roll out beside the bay, facing in — deterministic per garage.
          const ang = ((b.id * 2.3999) % (Math.PI * 2)) + this.simTime * 0.05;
          const ox = Math.cos(ang) * (BUILDINGS.garage.radius + 4.5);
          const oz = Math.sin(ang) * (BUILDINGS.garage.radius + 4.5);
          RoverSystem.spawn(this.state, kind, b.x + ox, b.z + oz, Math.atan2(-ox, -oz));
          this.event('ok', `${def.label} rolled out of the garage — charged and ready for orders.`);
        }
      }
    }
  }

  // ----------------------------------------------------- life support ----
  // Phase 7: the fluid draw, shelter occupancy, EVA orders, colonist motion
  // and colonist/fluid restore live in systems/LifeSupportSystem.ts —
  // Simulation passes the state plus the cross-domain hooks. Failure checks
  // that *report* life-support state (low O₂, colonist health) live in
  // FailureSystem (Phase 15); AlertSystem (Phase 16) owns notification.

  // Phase 15: endMission lives in FailureSystem (weather / life-support hooks).

  // --------------------------------------------------------- logistics ----
  // Phase 13: resource accounting — the storage ledger, cargo transfers,
  // site material delivery and deposit reservations — lives in
  // systems/LogisticsSystem.ts. Simulation wires the one cross-domain answer
  // its seams all ask for ("is this rover stuck on cargo the silos cannot
  // take") and keeps the public storage surface above as a delegate.

  /** The fleet/construction question, answered once by the ledger. */
  private canDeliverAny(r: Rover): boolean {
    return LogisticsSystem.canDeliver(this.state, r);
  }

  // ------------------------------------------------------ construction ----
  // Phase 9: siting, site materials, worker choice, build progress,
  // completion, cancellation and the material ledger live in
  // systems/ConstructionSystem.ts — Simulation passes the state plus the
  // cross-domain hooks (`constructionHooks`). The public surface the hosts and
  // the build ghost call (`canPlace`, `placeVerdict`, `placeBuilding`,
  // `demolish`) stays here as a thin delegate, because the siting authority
  // must remain the simulation's.

  // ------------------------------------------------------------ alerts ----
  // Phase 15/16: FailureSystem produces domain events; AlertSystem maps them
  // onto state.alerts. Phase 17: history sampling lives in HistorySystem.

  /** Sols of reserve left for a fluid at the trailing-sol net rate. */
  solsOfReserve(f: FluidId): number {
    return this.reserveSols(f);
  }

  private evaluateAlerts(): void {
    const events = FailureSystem.tick(this.state, this.failureContext);
    AlertSystem.applyFailureEvents(this.state, events);
  }

  // ----------------------------------------------------------- history ----
  // Phase 17: vitals sampling + flow-window roll live in HistorySystem.
  // Public rate queries (netRatePerSol / reserveSols) stay here — they read
  // the windows HistorySystem writes and are part of the host surface.

  /** Net rate of a fluid in kg/sol, averaged over the trailing sol. */
  netRatePerSol(f: FluidId): number {
    if (this.flowWindow.length === 0) return 0;
    const span = this.simTime - this.flowWindow[0].t;
    if (span <= 1e-6) return 0;
    let produced = 0;
    let consumed = 0;
    for (const w of this.flowWindow) {
      produced += w.f[f].produced;
      consumed += w.f[f].consumed;
    }
    return (produced - consumed) / (span * SOLS_PER_SEC);
  }

  /** Instantaneous rate for the current tick — used for live throughput read-outs. */
  instantRatePerSol(f: FluidId): number {
    const sols = SIM_TICK * SOLS_PER_SEC;
    if (sols <= 0) return 0;
    const fl = this.lastFlows[f];
    return (fl.produced - fl.consumed) / sols;
  }

  reserveSols(f: FluidId): number {
    const net = this.netRatePerSol(f);
    if (net >= -1e-9) return Infinity;
    return this.pools.amounts[f] / -net;
  }

  // ------------------------------------------------------------ events ----
  private event(severity: Severity, text: string): void {
    this.alerts.event(severity, text, this.simTime, this.clock.format());
  }

  drainEvents() {
    return this.alerts.drain();
  }

  // ------------------------------------------------------- persistence ----
  // Phase 3: persistence extraction — snapshot returns SaveState, restore
  // decodes via persistence module (unknown → SaveState → ColonyState).

  snapshot(): SaveState {
    return {
      version: SAVE_VERSION as 8,
      seed: this.seed,
      difficulty: this.difficulty,
      worldHalf: this.world.half,
      region: this.world.region,
      worldOptions: { ...this.worldOptions },
      simTime: this.simTime,
      ticksRun: this.ticksRun,
      clock: this.clock.snapshot() as { sol: number; frac: number },
      storage: { ...this.storage },
      fluids: { ...this.pools.amounts },
      storedKWh: this.storedKWh,
      gameOver: this.gameOver,
      colonist: {
        id: this.colonist.id,
        name: this.colonist.name,
        x: this.colonist.x,
        z: this.colonist.z,
        heading: this.colonist.heading,
        health: this.colonist.health,
        suitO2: this.colonist.suitO2,
        inside: this.colonist.inside,
        shelterId: this.colonist.shelterId,
        order: { ...this.colonist.order } as { type: string; [k: string]: unknown },
        dead: this.colonist.dead,
      },
      deposits: this.world.deposits.map((d) => ({
        id: d.id,
        resource: d.resource,
        x: d.x,
        z: d.z,
        amount: d.amount,
        maxAmount: d.maxAmount,
        radius: d.radius,
        reservedBy: d.reservedBy ?? null,
      })),
      pois: this.world.pois.map((p) => ({
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
      exploration: { nextDropSol: this.nextDropSol },
      rovers: this.rovers.map((r) => ({
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
      buildings: this.buildings.map((b) => ({
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
      weather: this.weather.snapshot() as SaveState['weather'],
      alerts: this.alerts.snapshot() as SaveState['alerts'],
    };
  }

  /**
   * Restore state from an earlier snapshot(). Mutates this sim in place.
   * Accepts `unknown` at the boundary — decodes via SaveCodec (validator →
   * migrations → schema) then applies to ColonyState.
   */
  restore(data: unknown): void {
    const save = decodeSave(data);
    this.restoreFromState(save);
  }

  /**
   * Typed restore path — receives an already-decoded, migrated SaveState.
   * This is the new boundary per roadmap §7: decodeSave(unknown) → SaveState
   * → restoreFromState(saveState).
   */
  private restoreFromState(data: SaveState): void {
    this.seed = data.seed;
    this.difficulty = DIFFICULTIES[data.difficulty as DifficultyId]
      ? (data.difficulty as DifficultyId)
      : 'pioneer';
    this.worldOptions = { ...DEFAULT_WORLD_OPTIONS, ...(data.worldOptions ?? {}) };
    this.consumptionMul = (DIFFICULTIES[this.difficulty] ?? DIFFICULTIES.pioneer).consumptionMul;
    // Phase 4: clock/time restore delegated to ClockSystem
    ClockSystem.restore(this.state, {
      simTime: data.simTime,
      ticksRun: (data as { ticksRun?: number }).ticksRun,
      clock: data.clock as { sol?: number; frac?: number },
    });
    // Phase 5: weather rebuild + derived flags delegated to WeatherSystem
    WeatherSystem.restore(this.state, data.weather);
    this.storage = { ...emptyAmounts(), ...(data.storage ?? {}) };
    this.gameOver = data.gameOver ?? null;

    this.world = new World({
      seed: data.seed,
      nearDeposits: 0.2,
      worldHalf: Number.isFinite(data.worldHalf) ? data.worldHalf : 640,
      region: typeof data.region === 'string' ? data.region : null,
    });
    this.world.deposits = (data.deposits ?? []).map((d) => ({
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
      this.world.setPois(
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
    this.resetExploration(Number(data.exploration?.nextDropSol));

    this.rovers = (data.rovers ?? []).map((r) => {
      const command = coerceTask(r.command) ?? { type: 'idle' as const };
      const pending = Array.isArray(r.pending)
        ? (r.pending as unknown[]).map(coerceTask).filter((t): t is RoverTask => t !== null)
        : [];
      return {
        id: r.id,
        kind: r.kind,
        label: ROVERS[r.kind as RoverKind]?.label ?? 'Rover',
        x: r.x,
        y: this.world.heightAt(r.x, r.z),
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

    this.buildings = (data.buildings ?? []).map((b) => ({
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
    RoverSystem.rehydrate(this.state);

    this.recomputeCapacities();
    // Phase 7: fluid clamp + colonist rebuild delegated to LifeSupportSystem
    LifeSupportSystem.restore(this.state, data.fluids, data.colonist);

    // Phase 6: grid rebuild delegated to PowerSystem
    PowerSystem.restore(this.state, data.storedKWh);
    // Radar capability is derived, not saved; restore it before the first view
    // so a resumed colony immediately shows its weather map.
    WeatherSystem.refreshRadar(this.state);

    this.alerts.reset();
    if (data.alerts) this.alerts.restore(data.alerts);
    HistorySystem.clear(this.state);

    let maxId = this.nextId;
    for (const e of [...this.rovers, ...this.buildings]) maxId = Math.max(maxId, e.id + 1);
    for (const d of this.world.deposits) maxId = Math.max(maxId, d.id + 1);
    this.nextId = maxId;
  }
}

export { colonistStatusText };
