/**
 * Phase 15 — Extract FailureSystem
 *
 * Goal per roadmap §19: centralize failures WITHOUT mixing them with alerts.
 *
 * ---------------------------------------------------------------------------
 * The distinction
 * ---------------------------------------------------------------------------
 *
 *   FailureSystem
 *       =  something went wrong in the colony: a building tripped offline, a
 *          rover is stranded, the grid is shedding life-support, oxygen is
 *          critical, the mission is lost. This module owns those *outcomes*
 *          and the checks that detect them.
 *
 *   AlertSystem (Phase 16 — not this phase)
 *       =  how the player is notified. Until that extraction, FailureSystem
 *          still drives `state.alerts.raise` / `.clear` with the same keys,
 *          severities and copy Simulation.evaluateAlerts used — a thin bridge
 *          so behavior stays identical. Domain events below are the surface
 *          AlertSystem will consume later.
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
 *   - **AlertBus mechanics** (dedupe, ack, history drain) — `alerts.ts` /
 *     AlertSystem Phase 16.
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
  ALL_RESOURCES,
  BUILDINGS,
  FLUIDS,
  RESOURCES,
} from '../defs';
import {
  ROVER_CONDITION_ALERT,
  SUIT_O2_CAPACITY,
} from '../config';
import { stormLabel } from '../weather';
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
    state.alerts.event(
      'crit',
      `${def.label} damaged by ${cause} — offline until repaired.`,
      state.simTime,
      state.clock.format(),
    );
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
    state.alerts.raise(
      'mission-over',
      'crit',
      'Mission lost',
      reason,
      state.simTime,
      state.clock.format(),
    );
    return { kind: 'MissionLost', reason, sol };
  }

  // -------------------------------------------------------------- tick ----

  /**
   * Failure checks for this tick (TDD §4 step 9). Produces domain events and
   * bridges them onto `state.alerts` with the exact raise/clear behavior
   * Simulation.evaluateAlerts had — AlertSystem (Phase 16) will own the
   * bridge later.
   */
  static tick(state: ColonyState, ctx: FailureSystemContext): FailureEvent[] {
    const events = FailureSystem.evaluate(state, ctx);
    FailureSystem.applyAlerts(state, events);
    return events;
  }

  /**
   * Detect failure conditions. Pure over state + context — no alert writes.
   * {@link FailureSystem.applyAlerts} is the interim notification bridge.
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
      });
    } else {
      events.push({
        kind: 'PanelsDirty',
        active: false,
        worstCleanliness: 1,
        dirtyCount: 0,
        subjectId: null,
      });
    }

    return events;
  }

  /**
   * Interim bridge until AlertSystem (Phase 16): the exact raise/clear
   * Simulation.evaluateAlerts performed, driven by {@link FailureEvent}s.
   * Does not invent new copy or keys.
   */
  static applyAlerts(state: ColonyState, events: FailureEvent[]): void {
    const t = state.simTime;
    const stamp = state.clock.format();
    const A = state.alerts;

    for (const e of events) {
      switch (e.kind) {
        case 'PowerShortage': {
          if (e.level === 'critical') {
            A.raise(
              'brownout-critical',
              'crit',
              'Grid brownout',
              `Life-support tiers are being shed. Generation ${e.generationKw.toFixed(1)} kW vs ${e.demandKw.toFixed(1)} kW demand.`,
              t,
              stamp,
            );
          } else {
            A.clear('brownout-critical', t, stamp, 'Critical loads are powered again.');
            if (e.level === 'warn') {
              A.raise(
                'brownout',
                'warn',
                'Power deficit',
                `Non-essential loads throttled. ${e.generationKw.toFixed(1)} kW generated, ${e.demandKw.toFixed(1)} kW requested.`,
                t,
                stamp,
              );
            } else {
              A.clear('brownout', t, stamp);
            }
          }
          break;
        }
        case 'BatteryLow': {
          if (e.active) {
            A.raise(
              'battery-low',
              'warn',
              'Batteries nearly flat',
              `${e.storedKWh.toFixed(0)} kWh left, draining at ${e.drainKw.toFixed(1)} kW.`,
              t,
              stamp,
            );
          } else {
            A.clear('battery-low', t, stamp);
          }
          break;
        }
        case 'FluidReserve': {
          const info = FLUIDS[e.fluid];
          const key = `${e.fluid}-low`;
          if (e.level === 'exhausted') {
            A.raise(
              key,
              'crit',
              `${info.label} exhausted`,
              e.fluid === 'oxygen'
                ? 'The colonist is breathing suit reserves. Restore oxygen production now.'
                : `No ${info.label.toLowerCase()} left in the colony.`,
              t,
              stamp,
            );
          } else if (e.level === 'critical') {
            A.raise(
              key,
              'crit',
              `${info.label} critical`,
              `${e.amount.toFixed(1)} kg left — about ${e.reserveSols.toFixed(1)} sol${e.reserveSols >= 2 ? 's' : ''} at the current rate.`,
              t,
              stamp,
            );
          } else if (e.level === 'warn') {
            A.raise(
              key,
              'warn',
              `${info.label} reserve falling`,
              `${e.amount.toFixed(1)} kg left — about ${e.reserveSols.toFixed(1)} sols at the current rate.`,
              t,
              stamp,
            );
          } else {
            A.clear(key, t, stamp);
          }
          break;
        }
        case 'ColonistHealth': {
          if (e.level === 'crit') {
            A.raise(
              'colonist-health',
              'crit',
              `${e.name} is failing`,
              `Health ${e.health.toFixed(0)}%. Restore life support immediately.`,
              t,
              stamp,
              e.colonistId,
            );
          } else if (e.level === 'warn') {
            A.raise(
              'colonist-health',
              'warn',
              `${e.name} is unwell`,
              `Health ${e.health.toFixed(0)}%.`,
              t,
              stamp,
              e.colonistId,
            );
          } else {
            A.clear('colonist-health', t, stamp, `${e.name} has recovered.`);
          }
          break;
        }
        case 'SuitOxygen': {
          if (e.active) {
            A.raise(
              'suit-o2',
              'crit',
              'Suit oxygen low',
              `${e.name} must reach a pressurised volume.`,
              t,
              stamp,
              e.colonistId,
            );
          } else {
            A.clear('suit-o2', t, stamp);
          }
          break;
        }
        case 'RoverDisabled': {
          const key = `rover-dead-${e.roverId}`;
          if (e.active) {
            A.raise(
              key,
              'warn',
              `${e.label} stranded`,
              'Battery flat, out in the field — another rover can jump-start it.',
              t,
              stamp,
              e.roverId,
            );
          } else {
            A.clear(key, t, stamp);
          }
          break;
        }
        case 'RoverWear': {
          const wkey = `rover-wear-${e.roverId}`;
          if (e.active) {
            A.raise(
              wkey,
              'warn',
              `${e.label} needs service`,
              `Drivetrain at ${Math.round(e.condition)}% — work rate reduced. Park it at a Rover Garage.`,
              t,
              stamp,
              e.roverId,
            );
          } else {
            A.clear(wkey, t, stamp, `${e.label} is back in shape.`);
          }
          break;
        }
        case 'StorageFull': {
          if (e.active) {
            A.raise(
              'storage-full',
              'warn',
              e.resources.length === ALL_RESOURCES.length ? 'All silos full' : 'Silo full',
              `${e.resources.map((r) => RESOURCES[r].label).join(', ')} at capacity — build a Warehouse to keep hauling.`,
              t,
              stamp,
            );
          } else {
            A.clear('storage-full', t, stamp);
          }
          break;
        }
        case 'StormActive': {
          if (e.stormKind) {
            A.raise(
              'storm-active',
              e.severity,
              stormLabel(e.stormKind),
              `Solar −${e.dustDropPct}% from dust · visibility ${Math.round(e.visibility * 100)}% · winds ${Math.round(e.windSpeed)} m/s.`,
              t,
              stamp,
            );
          } else {
            A.clear('storm-active', t, stamp, 'Storm passed — skies are settling.');
          }
          break;
        }
        case 'BuildingFailed': {
          if (e.active) {
            A.raise(
              'building-damaged',
              'crit',
              e.buildingIds.length === 1
                ? `${e.labels[0]} damaged`
                : `${e.buildingIds.length} structures damaged`,
              e.buildingIds.length === 1
                ? 'Offline until a rover repairs it.'
                : `${e.labels.join(', ')} — dispatch rovers to repair.`,
              t,
              stamp,
              e.buildingIds[0],
            );
          } else {
            A.clear('building-damaged', t, stamp, 'All structures repaired.');
          }
          break;
        }
        case 'PanelsDirty': {
          if (e.active) {
            A.raise(
              'panels-dirty',
              'warn',
              'Solar arrays dusted',
              `Output down ${Math.round((1 - e.worstCleanliness) * 100)}% on the dirtiest array${e.dirtyCount > 1 ? ` (${e.dirtyCount} arrays need cleaning)` : ''} — send a rover to clean.`,
              t,
              stamp,
              e.subjectId ?? undefined,
            );
          } else {
            // Match prior: clear with recovery text when panels exist and are
            // clean enough; clear silently when there are no solar panels.
            // evaluate always emits PanelsDirty; subjectId null + worst==1
            // with dirtyCount 0 means "no panels" (silent) vs cleaned (text).
            // We cannot distinguish from the event alone when active=false —
            // use dirtyCount===0 && worstCleanliness===1 && subjectId===null
            // as the no-panels sentinel evaluate emits.
            if (e.dirtyCount === 0 && e.worstCleanliness === 1 && e.subjectId === null) {
              // Ambiguous: either no panels, or all clean with worst exactly 1.
              // Prior code: no panels → A.clear('panels-dirty', t, stamp);
              //             clean → A.clear(..., 'Arrays are clean again.');
              // When panels exist and are clean, worst is typically < 1 after
              // any dust history, but a brand-new panel is cleanliness 1.
              // Preserve prior by checking buildings here for the clear text.
              const hasSolar = state.buildings.some(
                (b) =>
                  b.state === 'online' &&
                  !b.damaged &&
                  BUILDINGS[b.kind].generation === 'solar',
              );
              if (hasSolar) {
                A.clear('panels-dirty', t, stamp, 'Arrays are clean again.');
              } else {
                A.clear('panels-dirty', t, stamp);
              }
            } else {
              A.clear('panels-dirty', t, stamp, 'Arrays are clean again.');
            }
          }
          break;
        }
        case 'BuildingTripped':
        case 'MissionLost':
          // Raised at the action site (tripDamaged / endMission), not here.
          break;
      }
    }
  }
}
