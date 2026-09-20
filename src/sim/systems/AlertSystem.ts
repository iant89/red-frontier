/**
 * Phase 16 — Extract AlertSystem
 *
 * Goal per roadmap §20: separate "something happened" from "how the player is
 * notified."
 *
 * ---------------------------------------------------------------------------
 * The distinction
 * ---------------------------------------------------------------------------
 *
 *   FailureSystem (Phase 15)
 *       =  something went wrong in the colony. It produces domain events
 *          (`PowerShortage`, `FluidReserve`, `RoverDisabled`, …) and owns the
 *          failure *actions* (`tripDamaged`, `endMission`). It does not write
 *          the notification surface.
 *
 *   AlertSystem (this module)
 *       =  how the player is notified. It maps failure domain events onto
 *          `state.alerts` (AlertBus) with the same keys, severities, copy,
 *          raise/clear and hysteresis Simulation.evaluateAlerts /
 *          FailureSystem.applyAlerts used — move-not-redesign.
 *
 * Flow:
 *
 *     FailureSystem.evaluate / tripDamaged / endMission
 *         ↓  FailureEvent[]
 *     AlertSystem.applyFailureEvents
 *         ↓
 *     state.alerts (AlertBus)  →  SimView / HUD
 *
 * ---------------------------------------------------------------------------
 * Responsibilities (roadmap §20)
 * ---------------------------------------------------------------------------
 *   - alert creation         raise / event via AlertBus
 *   - severity               crit / warn / info / ok / opportunity
 *   - deduplication          AlertBus keyed raise (re-raise refreshes)
 *   - expiration             clear when the producing condition ends
 *   - acknowledgement state  presentation-side today (HUD dismiss/snooze);
 *                            the sim owns the live condition the HUD acks
 *                            against — moving ack into sim state would change
 *                            save/restore and is deferred
 *   - alert history          AlertBus log + drain (UI consumes pending)
 *
 * ---------------------------------------------------------------------------
 * What deliberately does NOT live here
 * ---------------------------------------------------------------------------
 *   - **Failure checks / tripDamaged / endMission** — FailureSystem.
 *   - **AlertBus mechanics implementation** — `alerts.ts` (same split as
 *     `weather.ts` beside WeatherSystem). This module *owns* the mapping onto
 *     the bus; the bus remains the data structure.
 *   - **History sampling** (`HistorySystem.tick`) — HistorySystem (Phase 17).
 *   - **HUD dismiss / snooze** — presentation; reads SimView alerts.
 *
 * Other domain systems (Weather, Construction, Exploration, …) still call
 * `state.alerts` directly for one-shot events and a few condition keys; those
 * writers are unchanged this phase (one architectural change). FailureSystem
 * is the first producer that emits domain events for AlertSystem to consume.
 *
 * Determinism: pure mapping over FailureEvent[] + clock stamp; no RNG, no DOM.
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, Simulation, hosts,
 * persistence schema.
 */

import type { ColonyState } from '../state/ColonyState';
import { ALL_RESOURCES, FLUIDS, RESOURCES } from '../defs';
import { stormLabel } from '../weather';
import type { FailureEvent } from './FailureSystem';

export class AlertSystem {
  /**
   * Map failure domain events onto the alert bus. Preserves the exact keys,
   * severities, copy and raise/clear semantics FailureSystem.applyAlerts
   * (Phase 15 interim bridge) and Simulation.evaluateAlerts had — including
   * BuildingTripped / MissionLost, which used to raise at the action site.
   */
  static applyFailureEvents(state: ColonyState, events: FailureEvent[]): void {
    const t = state.simTime;
    const stamp = state.clock.format();
    const A = state.alerts;

    for (const e of events) {
      switch (e.kind) {
        case 'PowerShortage': {
          if (e.level === 'critical') {
            if (!A.isActive('brownout-critical')) {
              state.domainEvents.push({
                type: 'power/shortage',
                level: 'critical',
                generationKw: e.generationKw,
                demandKw: e.demandKw,
              });
            }
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
              if (!A.isActive('brownout')) {
                state.domainEvents.push({
                  type: 'power/shortage',
                  level: 'warn',
                  generationKw: e.generationKw,
                  demandKw: e.demandKw,
                });
              }
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
            const prior = A.list().find((a) => a.key === 'colonist-health');
            if (!prior || prior.severity !== 'crit') {
              state.domainEvents.push({
                type: 'colonist/critical',
                colonistId: e.colonistId,
                health: e.health,
              });
            }
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
        case 'RoverPartWear': {
          const key = `rover-parts-${e.roverId}`;
          if (e.active) A.raise(key, 'warn', `${e.label} needs replacement parts`,
            `Motor ${Math.round(e.motor)}% · circuit board ${Math.round(e.circuitBoard)}%. Park beside a Repair Bay; each replacement uses 1 matching spare.`,
            t, stamp, e.roverId);
          else A.clear(key, t, stamp, `${e.label}'s components are back in shape.`);
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
          } else if (e.silentClear) {
            A.clear('panels-dirty', t, stamp);
          } else {
            A.clear('panels-dirty', t, stamp, 'Arrays are clean again.');
          }
          break;
        }
        case 'BuildingTripped': {
          // Was raised at FailureSystem.tripDamaged; now owned here.
          A.event(
            'crit',
            `${e.label} damaged by ${e.cause} — offline until repaired.`,
            t,
            stamp,
          );
          break;
        }
        case 'MissionLost': {
          // Was raised at FailureSystem.endMission; now owned here.
          A.raise(
            'mission-over',
            'crit',
            'Mission lost',
            e.reason,
            t,
            stamp,
          );
          break;
        }
      }
    }
  }
}
