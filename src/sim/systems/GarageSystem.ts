/**
 * Phase 18 — Garage bay extracted from Simulation.
 *
 * The rover garage's service bay and assembly line used to live as
 * `Simulation.tickGarages` / `assembleRover`. They consume `powerSat` (they
 * do not convert mass the way ProductionSystem does) and spawn / service
 * rovers — move-not-redesign into a named owner so Simulation can coordinate
 * rather than implement.
 *
 * Flow:
 *
 *     PowerSystem.tick  →  GarageSystem.tick  →  (rovers serviced / rolled out)
 *     host command      →  Simulation.assembleRover  →  GarageSystem.assemble
 *
 * Cross-domain seams (not owned here):
 *   - Material affordability / spend → ConstructionSystem (bulk kg ledger)
 *   - Component affordability / spend → ComponentSystem (counted-unit ledger, P5)
 *   - Rover spawn                    → RoverSystem.spawn
 *   - Power saturation               → PowerSystem (writes `b.powerSat`)
 *
 * Determinism: no RNG beyond the deterministic rollout angle from garage id
 * and `simTime` (same formula the Simulation body used). No DOM, no wall clock.
 *
 * Does NOT know about: Three.js, DOM, renderer, UI, Simulation, hosts,
 * persistence schema.
 */

import type { ColonyState } from '../state/ColonyState';
import type { Building } from '../state/BuildingState';
import { ConstructionSystem } from './ConstructionSystem';
import { ComponentSystem } from './ComponentSystem';
import { RoverSystem } from './RoverSystem';
import { BUILDINGS, ROVERS, type RoverKind } from '../defs';
import { SIM_TICK, GARAGE_SERVICE_RATE, devLevelMul } from '../config';

function runnable(b: Building): boolean {
  return b.state === 'online' && !b.damaged;
}

function event(state: ColonyState, severity: 'info' | 'warn' | 'ok', text: string): void {
  state.alerts.event(severity, text, state.simTime, state.clock.format());
}

export class GarageSystem {
  /**
   * Start assembling a rover on a garage's line. Materials leave storage and
   * components leave the rack up front; the build itself runs on garage power
   * and pauses in a brownout. Same refusals and log lines
   * Simulation.assembleRover used — including the component shortfall (P5),
   * which names what the line is missing rather than just saying no.
   */
  static assemble(state: ColonyState, buildingId: number, kind: RoverKind): boolean {
    const b = state.buildings.find((x) => x.id === buildingId);
    if (!b || b.kind !== 'garage' || !runnable(b) || !b.enabled) {
      event(state, 'warn', 'Rovers are assembled at an online Rover Garage.');
      return false;
    }
    if (b.assembly) {
      event(state, 'info', `The garage line is already building a ${ROVERS[b.assembly.kind].label}.`);
      return false;
    }
    const def = ROVERS[kind];
    // Phase 9: the material ledger has one owner. Assembly *spends* mass the
    // same way a site does, so it asks ConstructionSystem rather than keeping
    // a second copy of "can we afford this" (roadmap §17's design rule).
    if (!ConstructionSystem.hasMaterials(state, def.cost)) {
      event(
        state,
        'warn',
        `Not enough materials for a ${def.label} — needs ${ConstructionSystem.missingList(def.cost)}.`,
      );
      return false;
    }
    // P5: a rover is a machine as well as a mass of metal. Motors and boards
    // come off the component rack — counted, not weighed — so this is a second
    // ledger answering the same "can we afford it" question, and both answers
    // have to be yes before *anything* is spent.
    if (!ComponentSystem.has(state, def.componentCost)) {
      event(
        state,
        'warn',
        `Not enough components for a ${def.label} — needs ${ComponentSystem.missingList(def.componentCost)}.`,
      );
      return false;
    }
    ConstructionSystem.consumeMaterials(state, def.cost);
    ComponentSystem.consume(state, def.componentCost);
    b.assembly = { kind, progress: 0 };
    event(
      state,
      'info',
      `${def.label} assembly started — about ${Math.round(def.buildTime)} s on the line.`,
    );
    return true;
  }

  /**
   * Rover garages (P4): service the drivetrains of anything parked in the bay
   * and advance the assembly line. Both scale with the power the garage
   * actually received — a brownout slows the line to a crawl.
   *
   * Called from Simulation.tick immediately after PowerSystem.tick — same
   * slot the former private `tickGarages` occupied.
   */
  static tick(state: ColonyState): void {
    for (const b of state.buildings) {
      if (b.kind !== 'garage' || !runnable(b) || !b.enabled) continue;
      const reach = BUILDINGS.garage.radius + 5;
      const service =
        GARAGE_SERVICE_RATE * devLevelMul(b.level) * SIM_TICK * (0.3 + 0.7 * b.powerSat);
      for (const r of state.rovers) {
        if (r.phase === 'disabled' || r.condition >= 100) continue;
        if (Math.hypot(b.x - r.x, b.z - r.z) <= reach) {
          const before = r.condition;
          r.condition = Math.min(100, r.condition + service);
          if (before < 100 && r.condition >= 100) {
            state.domainEvents.push({
              type: 'rover/repaired',
              roverId: r.id,
              reason: 'garage-service',
            });
          }
        }
      }
      if (b.assembly) {
        const def = ROVERS[b.assembly.kind];
        b.assembly.progress += (SIM_TICK * b.powerSat) / def.buildTime;
        if (b.assembly.progress >= 1) {
          const kind = b.assembly.kind;
          b.assembly = null;
          // Roll out beside the bay, facing in — deterministic per garage.
          const ang = ((b.id * 2.3999) % (Math.PI * 2)) + state.simTime * 0.05;
          const ox = Math.cos(ang) * (BUILDINGS.garage.radius + 4.5);
          const oz = Math.sin(ang) * (BUILDINGS.garage.radius + 4.5);
          RoverSystem.spawn(state, kind, b.x + ox, b.z + oz, Math.atan2(-ox, -oz));
          event(state, 'ok', `${def.label} rolled out of the garage — charged and ready for orders.`);
        }
      }
    }
  }
}
