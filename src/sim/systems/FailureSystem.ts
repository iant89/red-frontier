/**
 * Phase 15 — Extract FailureSystem
 * Phase 16 — alert bridge moved to AlertSystem
 *
 * Goal per roadmap §19: centralize failures WITHOUT mixing them with alerts.
 *
 * ---------------------------------------------------------------------------
 * The distinction
 * ---------------------------------------------------------------------------
 *
 *   FailureSystem (this module)
 *       =  something went wrong in the colony: a building tripped offline, a
 *          rover is stranded, the grid is shedding life-support, oxygen is
 *          critical, the mission is lost. This module owns those *outcomes*
 *          and the checks that detect them. It emits domain events only.
 *
 *   AlertSystem (Phase 16)
 *       =  how the player is notified. Simulation wires FailureEvent[] into
 *          AlertSystem.applyFailureEvents — FailureSystem does not touch
 *          `state.alerts`.
 *
 * ---------------------------------------------------------------------------
 * Responsibilities (roadmap §19)
 * ---------------------------------------------------------------------------
 *   - equipment failures     tripped / damaged structures (tripDamaged)
 *   - rover breakdowns       stranded (flat pack) and worn drivetrains
 *   - building failures      damaged-structure check
 *   - environmental failures active storm, dusted solar arrays
 *   - resource failures      brownout / battery / fluid reserve / silo full
 *   - mission loss           endMission (colonist death, lightning on EVA, …)
 *
 * Domain events produced (existing modes only — no new product failure modes):
 *   RoverDisabled, RoverWear, BuildingFailed, BuildingTripped,
 *   PowerShortage, BatteryLow, FluidReserve (OxygenCritical et al.),
 *   ColonistHealth, SuitOxygen, StorageFull, StormActive, PanelsDirty,
 *   MissionLost.
 *
 * ---------------------------------------------------------------------------
 * What deliberately does NOT live here
 * ---------------------------------------------------------------------------
 *   - **AlertBus / AlertSystem** (dedupe, ack, history drain, notification
 *     mapping) — `alerts.ts` / AlertSystem Phase 16. This module must not
 *     import AlertSystem or write `state.alerts`.
 *   - **Rover disable action** (`RoverSystem.disable` / `enterDisabled`) —
 *     rover domain; this system *observes* `phase === 'disabled'` and emits
 *     RoverDisabled. Weather / construction still call disable via hooks.
 *   - **History sampling** (`recordHistory`) — HistorySystem Phase 17.
 *   - **Fluid draw / colonist needs** — LifeSupportSystem Phase 7; we only
 *     *report* reserve / health conditions.
 *
 * Determinism: pure reads over ColonyState + the reserveSols answer the host
 * already computed; no RNG, no DOM.
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, Simulation, hosts,
 * persistence schema.
 */

import type { ColonyState } from '../state/ColonyState';
import type { Building } from '../state/BuildingState';
import type { Rover } from '../state/RoverState';
import { recomputeCapacitiesState } from '../state/ColonyState';
import type { FluidId, ResourceId } from '../defs';
import {
  ALL_FLUIDS,
  BUILDINGS,
} from '../defs';
import {
  ROVER_CONDITION_ALERT,
  SUIT_O2_CAPACITY,
} from '../config';
import type { StormKindReal } from '../weather';
import type { Severity } from '../alerts';
import { LogisticsSystem } from './LogisticsSystem';

// ---------------------------------------------------------- domain events ----

/**
 * Simulation-level failure outcomes. Invented only to hold what already
 * existed in evaluateAlerts / tripDamaged / endMission — not new modes.
 * AlertSystem (Phase 16) will map these to player-facing notifications.
 */
export type FailureEvent =
  | {
      kind: 'PowerShortage';
      level: 'critical' | 'warn' | null;
      generationKw: number;
      demandKw: number;
    }
  | {
      kind: 'BatteryLow';
      active: boolean;
      storedKWh: number;
      drainKw: number;
    }
  | {
      kind: 'FluidReserve';
      fluid: FluidId;
      level: 'exhausted' | 'critical' | 'warn' | null;
      amount: number;
      reserveSols: number;
    }
  | {
      kind: 'ColonistHealth';
      colonistId: number;
      name: string;
      health: number;
      level: 'crit' | 'warn' | null;
    }
  | {
      kind: 'SuitOxygen';
      colonistId: number;
      name: string;
      active: boolean;
    }
  | {
      kind: 'RoverDisabled';
      roverId: number;
      label: string;
      active: boolean;
    }
  | {
      kind: 'RoverWear';
      roverId: number;
      label: string;
      condition: number;
      active: boolean;
    }
  | {
      kind: 'StorageFull';
      resources: ResourceId[];
      active: boolean;
    }
  | {
      kind: 'StormActive';
      stormKind: StormKindReal | null;
      severity: Severity;
      dustDropPct: number;
      visibility: number;
      windSpeed: number;
    }
  | {
      kind: 'BuildingFailed';
      buildingIds: number[];
      labels: string[];
      active: boolean;
    }
  | {
      kind: 'PanelsDirty';
      active: boolean;
      worstCleanliness: number;
      dirtyCount: number;
      subjectId: number | null;
      /** True when there is no runnable solar — clear without recovery copy. */
      silentClear: boolean;
    }
  | {
      kind: 'BuildingTripped';
      buildingId: number;
      label: string;
      cause: string;
    }
  | {
      kind: 'MissionLost';
      reason: string;
      sol: number;
    };

/**
 * Cross-domain effects FailureSystem triggers but does not own. Releasing a
 * builder mid-job when a structure trips is rover-task lifecycle
 * (RoverSystem.finishTask) — same seam shape as ConstructionHostHooks.
 */
export interface FailureHostHooks {
  finishTask(r: Rover): void;
}

/**
 * Answers FailureSystem's checks need but do not own. `reserveSols` is the
 * trailing-sol fluid ledger Simulation already computes; `runnable` is the
 * shared "online and undamaged" predicate power / production also use.
 */
export interface FailureSystemContext {
  reserveSols(f: FluidId): number;
  runnable(b: Building): boolean;
}

export class FailureSystem {
  // -------------------------------------------------------------- actions ----

  /**
   * Storm / lightning damage has tripped a building offline until repaired.
   * Absorbs Simulation.tripDamaged (WeatherHostHooks implementor).
   */
  static tripDamaged(
    state: ColonyState,
    b: Building,
    cause = 'the storm',
    hooks: FailureHostHooks,
  ): FailureEvent {
    b.damaged = true;
    const def = BUILDINGS[b.kind];
    recomputeCapacitiesState(state);
    // Any builder pointed at it can do nothing; release the crew.
    for (const r of state.rovers) {
      if (r.command.type === 'construct' && r.command.buildingId === b.id) {
        hooks.finishTask(r);
        b.workerId = null;
      }
    }
    return {
      kind: 'BuildingTripped',
      buildingId: b.id,
      label: def.label,
      cause,
    };
  }

  /**
   * The mission is over (colonist lost). Absorbs Simulation.endMission
   * (WeatherHostHooks / LifeSupportHostHooks implementor).
   */
  static endMission(state: ColonyState, reason: string): FailureEvent {
    const sol = state.clock.sol + 1;
    state.gameOver = { reason, sol };
    // Notification is AlertSystem's job — Simulation applies the MissionLost
    // event after this returns.
    return { kind: 'MissionLost', reason, sol };
  }

  // -------------------------------------------------------------- tick ----

  /**
   * Failure checks for this tick (TDD §4 step 9). Produces domain events only —
   * Simulation passes them to AlertSystem.applyFailureEvents for notification.
   */
  static tick(state: ColonyState, ctx: FailureSystemContext): FailureEvent[] {
    return FailureSystem.evaluate(state, ctx);
  }

  /**
   * Detect failure conditions. Pure over state + context — no alert writes.
   * AlertSystem (Phase 16) maps the returned events onto `state.alerts`.
   */
  static evaluate(state: ColonyState, ctx: FailureSystemContext): FailureEvent[] {
    const events: FailureEvent[] = [];
    const p = state.power;

    // ---- power ------------------------------------------------------------
    if (p.firstShedTier !== null && p.firstShedTier <= 1) {
      events.push({
        kind: 'PowerShortage',
        level: 'critical',
        generationKw: p.generationKw,
        demandKw: p.demandKw,
      });
    } else if (p.brownout) {
      events.push({
        kind: 'PowerShortage',
        level: 'warn',
        generationKw: p.generationKw,
        demandKw: p.demandKw,
      });
    } else {
      events.push({
        kind: 'PowerShortage',
        level: null,
        generationKw: p.generationKw,
        demandKw: p.demandKw,
      });
    }

    const cap = p.capacityKWh;
    const frac = cap > 0 ? p.storedKWh / cap : 0;
    if (frac < 0.1 && p.batteryFlowKw < 0) {
      events.push({
        kind: 'BatteryLow',
        active: true,
        storedKWh: p.storedKWh,
        drainKw: -p.batteryFlowKw,
      });
    } else if (frac > 0.25 || p.batteryFlowKw >= 0) {
      events.push({
        kind: 'BatteryLow',
        active: false,
        storedKWh: p.storedKWh,
        drainKw: Math.max(0, -p.batteryFlowKw),
      });
    }

    // ---- life support / resource failures ---------------------------------
    for (const f of ALL_FLUIDS) {
      const amount = state.pools.amounts[f];
      const reserve = ctx.reserveSols(f);
      const critSols = f === 'oxygen' ? 0.5 : f === 'water' ? 1 : 2;
      const warnSols = f === 'oxygen' ? 1.5 : f === 'water' ? 3 : 6;

      let level: 'exhausted' | 'critical' | 'warn' | null = null;
      if (amount <= 1e-6) level = 'exhausted';
      else if (reserve < critSols) level = 'critical';
      else if (reserve < warnSols) level = 'warn';
      events.push({
        kind: 'FluidReserve',
        fluid: f,
        level,
        amount,
        reserveSols: reserve,
      });
    }

    // ---- the human --------------------------------------------------------
    const c = state.colonist;
    if (!c.dead) {
      let healthLevel: 'crit' | 'warn' | null = null;
      if (c.health < 35) healthLevel = 'crit';
      else if (c.health < 70) healthLevel = 'warn';
      events.push({
        kind: 'ColonistHealth',
        colonistId: c.id,
        name: c.name,
        health: c.health,
        level: healthLevel,
      });

      events.push({
        kind: 'SuitOxygen',
        colonistId: c.id,
        name: c.name,
        active: !c.inside && c.suitO2 < SUIT_O2_CAPACITY * 0.35,
      });
    }

    // ---- stranded & worn rovers -------------------------------------------
    for (const r of state.rovers) {
      events.push({
        kind: 'RoverDisabled',
        roverId: r.id,
        label: r.label,
        active: r.phase === 'disabled',
      });
      events.push({
        kind: 'RoverWear',
        roverId: r.id,
        label: r.label,
        condition: r.condition,
        active: r.condition < ROVER_CONDITION_ALERT,
      });
    }

    // ---- storage ----------------------------------------------------------
    const full = LogisticsSystem.fullResources(state);
    events.push({
      kind: 'StorageFull',
      resources: full,
      active: full.length > 0,
    });

    // ---- weather (environmental) ------------------------------------------
    const wx = state.weather;
    const active = wx.current();
    if (active) {
      const sev: Severity =
        active.kind === 'severe' || active.kind === 'planetary'
          ? 'crit'
          : active.kind === 'devil'
            ? 'info'
            : 'warn';
      const drop = Math.round((1 - state.dustTransmission) * 100);
      events.push({
        kind: 'StormActive',
        stormKind: active.kind,
        severity: sev,
        dustDropPct: drop,
        visibility: wx.visibility,
        windSpeed: wx.windSpeed,
      });
    } else {
      events.push({
        kind: 'StormActive',
        stormKind: null,
        severity: 'info',
        dustDropPct: 0,
        visibility: wx.visibility,
        windSpeed: wx.windSpeed,
      });
    }

    // ---- storm damage & dirty panels --------------------------------------
    const hurt = state.buildings.filter((b) => b.damaged);
    events.push({
      kind: 'BuildingFailed',
      buildingIds: hurt.map((b) => b.id),
      labels: hurt.map((b) => BUILDINGS[b.kind].label),
      active: hurt.length > 0,
    });

    const panels = state.buildings.filter(
      (b) => ctx.runnable(b) && BUILDINGS[b.kind].generation === 'solar',
    );
    if (panels.length > 0) {
      const worst = Math.min(...panels.map((b) => b.cleanliness));
      const dirty = panels.filter((b) => b.cleanliness < 0.6).length;
      const subject =
        worst < 0.6
          ? panels.slice().sort((a, b) => a.cleanliness - b.cleanliness)[0].id
          : null;
      events.push({
        kind: 'PanelsDirty',
        active: worst < 0.6,
        worstCleanliness: worst,
        dirtyCount: dirty,
        subjectId: subject,
        silentClear: false,
      });
    } else {
      events.push({
        kind: 'PanelsDirty',
        active: false,
        worstCleanliness: 1,
        dirtyCount: 0,
        subjectId: null,
        silentClear: true,
      });
    }

    return events;
  }

}
