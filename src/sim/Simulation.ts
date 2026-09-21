/**
 * The authoritative simulation — Phase 18 thin orchestrator.
 *
 * Framework-agnostic by construction: no DOM, no three.js, no wall clock. The
 * renderer and HUD only ever *read* from here. That constraint is what will let
 * this module move onto a Worker without touching a line of rendering code.
 *
 * Target responsibilities (roadmap §22):
 *   create state · initialize systems · process commands · advance systems ·
 *   create SimView · expose minimal lifecycle API
 *
 * Domain behavior lives in systems/*; Simulation coordinates. Tick order
 * follows TDD §4 and MUST stay identical to the Phase 17 body unless asked:
 *   Clock → Weather → Exploration → Power → Garages → LifeSupport →
 *   Construction (site mats + builders) → FleetAutomation → Rover (lights /
 *   update / move) → Colonist → Failure→Alert → History
 *
 * Phase 2: Simulation owns a ColonyState and proxies its old public fields
 * for backward compatibility.
 */

import { UpgradeSystem } from './systems/UpgradeSystem';
import type { EntityTarget, UpgradeId } from './engineering/upgrades';
import { World } from './World';
import { maintenanceNeed } from './rules';
import type { Deposit } from './World';
import {
  SAVE_VERSION,
} from './config';
import type {
  MineableResourceId,
  ResourceId,
  ResourceAmounts,
  ComponentId,
  ComponentAmounts,
  FluidId,
  RoverKind,
  BuildingKind,
} from './defs';
import {
  ROVERS,
  BUILDINGS,
} from './defs';
import type { DifficultyId, WorldOptions } from './difficulty';
import type { Poi } from './pois';
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
import type { DomainEvent } from './domainEvents';
import { assertInvariants, invariantChecksEnabled } from './debug/SimulationAssertions';
import { getProfiler, profilerEnabled } from './debug/Profiler';
import { decodeSave } from './persistence/SaveCodec';
import { snapshotColony, restoreColony } from './persistence/ColonyPersistence';
import type { SaveState } from './persistence/SaveSchema';
import { ClockSystem } from './systems/ClockSystem';
import { WeatherSystem, type WeatherHostHooks } from './systems/WeatherSystem';
import { PowerSystem, type PowerSystemContext } from './systems/PowerSystem';
import { WaterSystem } from './systems/WaterSystem';
import { ProductionSystem } from './systems/ProductionSystem';
import { ComponentSystem } from './systems/ComponentSystem';
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
import { GarageSystem } from './systems/GarageSystem';
import { MaintenanceSystem } from './systems/MaintenanceSystem';
import { TutorialSystem } from './systems/TutorialSystem';
import { ObjectiveSystem, objectiveSnapshot } from './systems/ObjectiveSystem';
import { AutonomySystem, autonomySnapshot } from './systems/AutonomySystem';
import { PolicySystem, POLICY_UNLOCK, policySnapshot } from './systems/PolicySystem';
import { bottleneckSnapshot } from './bottlenecks/analyzer';
import { UNLOCKS, hasUnlock } from './unlocks';
import type { PolicyId } from './state/PolicyState';
import { DevBackdoors } from './DevBackdoors';

import {
  createColonyState,
  recomputeCapacitiesState,
  type ColonyState,
} from './state/ColonyState';
import {
  type Rover,
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
import type { HistorySample, SolHistoryRow, JournalEntry } from './state/HistoryState';
import { batteryCapacityKWh } from './state/PowerState';

// Re-export for backward compat (old import sites still work)
export type { RoverTask, RoverCommand, RoverRules, Rover, RoverGoal, RoverPhase, Building, HistorySample, SolHistoryRow, JournalEntry, FluidFlow } from './state';
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
   * ProductionSystem. Simulation only wires the context.
   */
  private readonly powerContext: PowerSystemContext = {
    desiredThroughput: (b) => ProductionSystem.desiredThroughput(this.state, b),
    runProcess: (b, throughput, hours) => ProductionSystem.runProcess(this.state, b, throughput, hours),
    processBlockReason: (b) => ProductionSystem.processBlockReason(this.state, b),
  };

  /**
   * Cross-domain effects LifeSupportSystem triggers but does not own
   * (Phase 7 seam). Phase 15 absorbed endMission; Phase 9 moved completeBuilding.
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
   * (Phase 9 seam). Worker pathing / task lifecycle → RoverSystem; haul
   * question → LogisticsSystem.
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
   */
  private readonly roverHooks: RoverHostHooks = {
    constructSite: (r, b) => ConstructionSystem.build(this.state, r, b, this.constructionHooks),
    canDeliverCargo: (r) => this.canDeliverAny(r),
  };

  /**
   * Cross-domain answers FleetAutomationSystem asks but does not own (Phase 12).
   */
  private readonly fleetHooks: FleetAutomationHostHooks = {
    canDeliverCargo: (r) => this.canDeliverAny(r),
  };

  /**
   * Cross-domain effects FailureSystem triggers but does not own (Phase 15).
   */
  private readonly failureHooks: FailureHostHooks = {
    finishTask: (r) => RoverSystem.finishTask(r),
  };

  /**
   * Answers FailureSystem's checks need but do not own.
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

  // ---- state proxies (backward compat / SimView surface) ----
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
  get components(): ComponentAmounts { return this.state.components; }
  set components(v: ComponentAmounts) { this.state.components = v; }

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

  /** Phase 4 — downsampled one-row-per-sol record (saved; feeds nothing). */
  get solHistory(): SolHistoryRow[] { return this.state.solHistory; }

  /** Phase 4 — the persisted, bounded, sol-stamped event journal. */
  get journal(): JournalEntry[] { return this.state.journal; }

  get gameOver(): { reason: string; sol: number } | null { return this.state.gameOver; }
  set gameOver(v: { reason: string; sol: number } | null) { this.state.gameOver = v; }

  get dustTransmission(): number { return this.state.dustTransmission; }
  set dustTransmission(v: number) { this.state.dustTransmission = v; }

  get weather(): Weather { return this.state.weather; }
  set weather(v: Weather) { this.state.weather = v; }

  get nextDropSol(): number { return this.state.nextDropSol; }
  set nextDropSol(v: number) { this.state.nextDropSol = v; }

  get simTime(): number { return this.state.simTime; }
  set simTime(v: number) { this.state.simTime = v; }
  // ------------------------------------------------------------ setup ----

  get nextEntityId(): number {
    return this.state.nextId;
  }

  startUpgrade(target: EntityTarget, upgrade: UpgradeId): boolean { return UpgradeSystem.start(this.state, target, upgrade); }
  cancelUpgrade(target: EntityTarget): boolean { return UpgradeSystem.cancel(this.state, target); }
  paintEntity(target: EntityTarget, paint: string): boolean { return UpgradeSystem.paint(this.state, target, paint); }

  get waterNetwork() { return WaterSystem.view(this.state); }
  connectWater(a: number, b: number): boolean { return WaterSystem.connect(this.state, a, b); }
  disconnectWater(a: number, b: number): boolean { return WaterSystem.disconnect(this.state, a, b); }
  commissionWater(): boolean { return WaterSystem.commission(this.state); }

  recomputeCapacities(): void {
    recomputeCapacitiesState(this.state);
  }

  // ---- storage ledger (Phase 13: LogisticsSystem) — thin delegates ----

  storageCapacity(): number {
    return LogisticsSystem.capacity(this.state);
  }

  storageRoom(res: ResourceId): number {
    return LogisticsSystem.room(this.state, res);
  }

  // ---- component rack (P5) — counted, not weighed, so a separate ledger ----

  componentCapacity(): number {
    return ComponentSystem.capacity(this.state);
  }

  componentRoom(c: ComponentId): number {
    return ComponentSystem.room(this.state, c);
  }

  /**
   * Switch a building's production line (P5). Returns false — and logs why —
   * when the sim refuses, so the UI never has to guess what happened.
   */
  setBuildingRecipe(buildingId: number, recipe: number): boolean {
    return ProductionSystem.setRecipe(this.state, buildingId, recipe);
  }

  storageTotal(): number {
    return LogisticsSystem.total(this.state);
  }

  storageTotalCapacity(): number {
    return LogisticsSystem.totalCapacity(this.state);
  }

  storageFull(): boolean {
    return LogisticsSystem.isFull(this.state);
  }

  fullResources(): ResourceId[] {
    return LogisticsSystem.fullResources(this.state);
  }

  batteryCapacity(): number {
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
   * low-battery return, not storm-sheltering, not stranded.
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

  shelters(): Array<{ id: number; x: number; z: number; radius: number; recycles: boolean }> {
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

  // ------------------------------------------------------- rover commands ----

  nearDepot(x: number, z: number): boolean {
    return RoverSystem.nearDepot(this.state, x, z);
  }

  nearCharger(x: number, z: number): boolean {
    return RoverSystem.nearCharger(this.state, x, z);
  }

  issueMove(roverId: number, x: number, z: number, queued = false): void {
    RoverSystem.issueMove(this.state, roverId, x, z, queued);
    this.state.tutorial.stats.moves++;
  }

  issueMine(roverId: number, depositId: number, queued = false): void {
    RoverSystem.issueMine(this.state, roverId, depositId, queued);
    this.state.tutorial.stats.mines++;
  }

  issueUnload(roverId: number, queued = false): void {
    RoverSystem.issueUnload(this.state, roverId, queued);
    this.state.tutorial.stats.hauls++;
  }

  issueWait(roverId: number, seconds: number, queued = false): void {
    RoverSystem.issueWait(this.state, roverId, seconds, queued);
  }

  issueConstruct(roverId: number, buildingId: number, queued = false): void {
    RoverSystem.issueConstruct(this.state, roverId, buildingId, queued);
  }

  stopRover(roverId: number): void {
    RoverSystem.stopRover(this.state, roverId);
  }

  setRepeatRoute(roverId: number, on: boolean): void {
    RoverSystem.setRepeatRoute(this.state, roverId, on);
    if (on) this.state.tutorial.stats.automations++;
  }

  setRoverRule(
    roverId: number,
    rule: 'autoHaul' | 'autoService' | 'stormShelter' | 'autoRescue',
    on: boolean,
  ): void {
    RoverSystem.setRoverRule(this.state, roverId, rule, on);
    if (on) this.state.tutorial.stats.automations++;
  }

  setChargeFloor(roverId: number, pct: number): void {
    RoverSystem.setChargeFloor(this.state, roverId, pct);
  }

  setRoverLights(roverId: number, on: boolean): void {
    RoverSystem.setRoverLights(this.state, roverId, on);
  }

  lightsNeeded(): boolean {
    return RoverSystem.lightsNeeded(this.state);
  }

  assembleRover(buildingId: number, kind: RoverKind): boolean {
    return GarageSystem.assemble(this.state, buildingId, kind);
  }

  issueRecover(roverId: number, strandedId: number, queued = false): boolean {
    return RoverSystem.issueRecover(this.state, roverId, strandedId, queued);
  }

  setBuildingEnabled(buildingId: number, enabled: boolean): void {
    const b = this.buildingById(buildingId);
    if (!b) return;
    if (b.enabled === enabled) return;
    b.enabled = enabled;
    this.recomputeCapacities();
    WeatherSystem.refreshRadar(this.state);
    this.event(
      enabled ? 'ok' : 'info',
      `${BUILDINGS[b.kind].label} ${enabled ? 'switched on' : 'switched off'}.`,
    );
  }

  demolish(buildingId: number): void {
    ConstructionSystem.demolish(this.state, buildingId, this.constructionHooks);
    WeatherSystem.refreshRadar(this.state);
  }

  issueClean(roverId: number, buildingId: number, queued = false): boolean {
    return RoverSystem.issueClean(this.state, roverId, buildingId, queued);
  }

  issueRepair(roverId: number, buildingId: number, queued = false): boolean {
    return RoverSystem.issueRepair(this.state, roverId, buildingId, queued);
  }

  dispatchMaintenance(buildingId: number): boolean {
    return RoverSystem.dispatchMaintenance(this.state, buildingId);
  }

  needsMaintenance(buildingId: number): 'repair' | 'clean' | null {
    return maintenanceNeed(this.buildingById(buildingId));
  }

  orderColonist(order: ColonistOrder): void {
    LifeSupportSystem.order(this.state, order);
  }

  dismissTutorialHint(hintId: string): void {
    TutorialSystem.dismissHint(this.state, hintId);
  }

  // -------------------------------------------------------- placement ----

  canPlace(kind: BuildingKind, x: number, z: number): string | null {
    return this.placeVerdict(kind, x, z);
  }

  placeVerdict(kind: BuildingKind, x: number, z: number): string | null {
    return ConstructionSystem.verdict(this.state, kind, x, z);
  }

  placeBuilding(kind: BuildingKind, x: number, z: number): Building | null {
    return ConstructionSystem.place(this.state, kind, x, z);
  }

  // ------------------------------------------------------- developer mode ----

  devSpawnRover(kind: RoverKind, x: number, z: number): Rover {
    return DevBackdoors.spawnRover(this.state, kind, x, z);
  }

  devSpawnBuilding(kind: BuildingKind, x: number, z: number): Building | null {
    return DevBackdoors.spawnBuilding(this.state, kind, x, z);
  }

  devSpawnDeposit(resource: MineableResourceId, x: number, z: number, amountKg: number): Deposit {
    return DevBackdoors.spawnDeposit(this.state, resource, x, z, amountKg);
  }

  devCompleteBuilding(id: number): boolean {
    return DevBackdoors.completeBuilding(this.state, id, this.constructionHooks);
  }

  devSetBuildingLevel(id: number, level: number): number {
    return DevBackdoors.setBuildingLevel(this.state, id, level);
  }

  devSetDust(frac: number): void {
    DevBackdoors.setDust(this.state, frac);
  }

  devForceStorm(kind: StormKindReal): void {
    DevBackdoors.forceStorm(this.state, kind);
  }

  devClearStorms(): void {
    DevBackdoors.clearStorms(this.state);
  }

  devSetStormScheduler(on: boolean): void {
    DevBackdoors.setStormScheduler(this.state, on);
  }

  devSetRoverBatteryFrac(roverId: number, frac: number): boolean {
    return DevBackdoors.setRoverBatteryFrac(this.state, roverId, frac);
  }

  devSetRoverCondition(roverId: number, pct: number): boolean {
    return DevBackdoors.setRoverCondition(this.state, roverId, pct);
  }

  devSetRoverCargo(roverId: number, res: ResourceId, kg: number): number {
    return DevBackdoors.setRoverCargo(this.state, roverId, res, kg);
  }

  devClearRoverCargo(roverId: number): boolean {
    return DevBackdoors.clearRoverCargo(this.state, roverId);
  }

  devSetBuildingHealth(buildingId: number, pct: number): boolean {
    return DevBackdoors.setBuildingHealth(this.state, buildingId, pct);
  }

  devSetBuildingCleanliness(buildingId: number, frac: number): boolean {
    return DevBackdoors.setBuildingCleanliness(this.state, buildingId, frac);
  }

  devSetBuildingDamaged(buildingId: number, on: boolean): boolean {
    return DevBackdoors.setBuildingDamaged(this.state, buildingId, on);
  }

  devSetColonistHealth(pct: number): boolean {
    return DevBackdoors.setColonistHealth(this.state, pct);
  }

  devRefillSuit(): void {
    DevBackdoors.refillSuit(this.state);
  }

  devSetTime(sol: number, frac: number): void {
    DevBackdoors.setTime(this.state, sol, frac);
  }

  // -------------------------------------------------------- main loop ----

  /** Advance simulation by `frameDt` game seconds (fixed substeps applied). */
  step(frameDt: number): number {
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

  /**
   * Authoritative tick order — preserve exactly (roadmap §22 / Phase 18).
   * Do not reorder without ask-user.
   */
  private tick(): void {
    if (this.gameOver) return;

    // 1. clock & sun
    const newSol = ClockSystem.tick(this.state);
    if (newSol) {
      this.event('info', `A new sol begins. Sol ${this.clock.sol + 1}.`);
    }

    // 2. weather
    WeatherSystem.tick(this.state, this.weatherHooks);

    // 2b. exploration (discovery / drops / burial)
    ExplorationSystem.tick(this.state);

    // 3 & 4. power network, then garage bay (consumes powerSat)
    PowerSystem.tick(this.state, this.powerContext);
    WaterSystem.tick(this.state);
    GarageSystem.tick(this.state);
    UpgradeSystem.tick(this.state);
    MaintenanceSystem.tickBays(this.state);

    // 5. life support & the human
    LifeSupportSystem.tick(this.state, this.lifeSupportHooks);

    // 6/7/8. logistics, jobs, movement, construction
    ConstructionSystem.tickSiteMaterials(this.state);
    ConstructionSystem.assignBuilders(this.state, this.constructionHooks);
    // Phase 3: standing orders act before generic fleet dispatch, so a
    // stockpile run outranks a routine haul and a shed lands next PowerSystem
    // tick (position decided with ask-user; no existing system moved).
    PolicySystem.tick(this.state);
    FleetAutomationSystem.tick(this.state, this.fleetHooks);
    for (const r of this.rovers) {
      if (r.phase === 'disabled') continue;
      if (!RoverSystem.tickLights(this.state, r)) continue;
      RoverSystem.updateRover(this.state, r, this.roverHooks);
    }
    for (const r of this.rovers) {
      if (r.phase === 'disabled') continue;
      RoverSystem.moveRover(this.state, r);
    }
    LifeSupportSystem.tickColonist(this.state, this.lifeSupportHooks);
    MaintenanceSystem.tickWear(this.state);

    // 9. failure checks → alerts → tutorial → history
    this.evaluateAlerts();
    // Phase 3: breakers read the alert transitions just made; the flagship
    // project (ObjectiveSystem, next) reads the streak this maintains.
    AutonomySystem.tick(this.state, newSol);
    TutorialSystem.tick(this.state, {
      reserveSols: (f) => this.reserveSols(f),
      netRatePerSol: (f) => this.netRatePerSol(f),
      instantRatePerSol: (f) => this.instantRatePerSol(f),
    });
    ObjectiveSystem.tick(this.state);
    // Phase 4: the clock's new-sol flag closes one downsampled sol row.
    HistorySystem.tick(this.state, newSol);
  }

  /** Test/cheat hook (TDD §22): drop a bolt on the most exposed target now. */
  devForceLightningStrike(): void {
    DevBackdoors.forceLightningStrike(this.state, this.weatherHooks);
  }

  // -------------------------------------------------------- exploration ----

  get pois(): Poi[] {
    return this.world.pois;
  }

  poiById(id: number): Poi | undefined {
    return this.world.pois.find((p) => p.id === id);
  }

  issueSalvage(roverId: number, poiId: number, queued = false): boolean {
    return RoverSystem.issueSalvage(this.state, roverId, poiId, queued);
  }

  /** Whether a building is online *and* structurally sound enough to run. */
  private runnable(b: Building): boolean {
    return b.state === 'online' && !b.damaged;
  }

  /** The fleet/construction question, answered once by the ledger. */
  private canDeliverAny(r: Rover): boolean {
    return LogisticsSystem.canDeliver(this.state, r);
  }

  // ------------------------------------------------------------ alerts ----

  get tutorial(): import('./host/viewModels').TutorialView {
    return {
      milestones: { ...this.state.tutorial.milestones } as any,
      activeWarnings: [...(this.state.tutorial._activeWarnings ?? [])],
      nextHint: this.state.tutorial._nextHint ?? null,
      funnel: [...this.state.tutorial.funnel],
      stats: { ...this.state.tutorial.stats },
    };
  }

  /**
   * Phase 2: the engineering-project board as the panels read it. Built from
   * live state on demand (the same projection the worker payload carries), so
   * a restore paints a correct panel before the first tick lands.
   */
  get objectives(): import('./host/viewModels').ObjectiveView {
    return objectiveSnapshot(this.state);
  }

  /**
   * Record a player-issued order against the autonomy streak. The command
   * dispatcher is the one path every order takes, in-process or across the
   * worker, which is what makes the streak replay-faithful.
   */
  noteOrder(commandType: string): void {
    ObjectiveSystem.noteCommand(this.state, commandType);
  }

  /**
   * Phase 3: the autonomy window ends only on an *accepted* intervention — a
   * refused order steered nothing. Called by the dispatcher with the ack.
   */
  noteCommandResult(commandType: string, accepted: boolean): void {
    AutonomySystem.noteCommand(this.state, commandType, accepted);
  }

  /**
   * Phase 3: set one standing order. Refused (false) when the colony has not
   * earned colony-level automation yet or the payload names nothing.
   */
  setPolicy(policy: PolicyId, patch: Record<string, unknown>): boolean {
    if (POLICY_UNLOCK && !hasUnlock(this.state.unlocks, POLICY_UNLOCK)) {
      this.event('warn', `Standing orders need ${UNLOCKS[POLICY_UNLOCK].title} — finish the project that grants it.`);
      return false;
    }
    return PolicySystem.set(this.state, policy, patch);
  }

  /** Phase 3: the standing orders as the panel reads them. */
  get policies(): import('./host/viewModels').PolicyView {
    return policySnapshot(this.state);
  }

  /** Phase 3: the autonomy stat as the dashboard and the projects read it. */
  get autonomy(): import('./host/viewModels').AutonomyView {
    return autonomySnapshot(this.state);
  }

  /**
   * Phase 5: the bottleneck advisory as the advisor panel reads it. Built
   * from live state on demand — the same pure analyzer the worker payload
   * uses — so a restore paints a correct panel before the first tick lands.
   */
  get bottlenecks(): import('./host/viewModels').BottlenecksView {
    return bottleneckSnapshot(this.state);
  }

  solsOfReserve(f: FluidId): number {
    return this.reserveSols(f);
  }

  private evaluateAlerts(): void {
    const events = FailureSystem.tick(this.state, this.failureContext);
    AlertSystem.applyFailureEvents(this.state, events);
  }

  // ----------------------------------------------------------- history ----

  netRatePerSol(f: FluidId): number {
    return HistorySystem.netRatePerSol(this.state, f);
  }

  instantRatePerSol(f: FluidId): number {
    return HistorySystem.instantRatePerSol(this.state, f);
  }

  reserveSols(f: FluidId): number {
    return HistorySystem.reserveSols(this.state, f);
  }

  // ------------------------------------------------------------ events ----
  private event(severity: Severity, text: string): void {
    this.alerts.event(severity, text, this.simTime, this.clock.format());
  }

  drainEvents() {
    return this.alerts.drain();
  }

  /**
   * Structured domain events since the last drain (Phase 21). Separate from
   * {@link drainEvents} / AlertBus HUD toasts.
   */
  drainDomainEvents(): ReadonlyArray<DomainEvent> {
    return this.state.domainEvents.drain();
  }

  // ------------------------------------------------------- persistence ----

  snapshot(): SaveState {
    return snapshotColony(this.state);
  }

  restore(data: unknown): void {
    restoreColony(this.state, decodeSave(data));
  }
}

export { colonistStatusText };
