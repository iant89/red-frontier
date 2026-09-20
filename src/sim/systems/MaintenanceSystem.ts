/**
 * P5 — installed component wear and Repair Bay replacements.
 * Routine drivetrain condition remains GarageSystem's responsibility. Installed
 * parts are health percentages on a rover; replacement inventory is the counted
 * ComponentSystem ledger. No new inventory, RNG, UI state or wall-clock timers.
 *
 * Park beside a bay: one job per bay and one bay per rover. Work consumes power;
 * one matching spare is spent atomically only when the job completes. Missing
 * stock/brownouts pause progress. Leaving or issuing an order cancels the job
 * without spending a part. Player orders and emergency charging always win.
 */
import { upgradeMul } from '../engineering/upgrades';
import type { ColonyState } from '../state/ColonyState';
import type { Building, PartReplacement } from '../state/BuildingState';
import type { Rover } from '../state/RoverState';
import { ROVER_PARTS, BUILDINGS, COMPONENTS } from '../defs';
import {
  SIM_TICK, PART_REPLACE_THRESHOLD, PART_REPLACE_SECONDS,
  PART_MOTOR_WEAR_MOVE, PART_MOTOR_WEAR_WORK, PART_MOTOR_WEAR_STORM,
  PART_BOARD_WEAR_MOVE, PART_BOARD_WEAR_WORK, PART_BOARD_WEAR_STORM,
  devLevelMul,
} from '../config';
import { ComponentSystem } from './ComponentSystem';

export class MaintenanceSystem {
  static runnable(b: Building): boolean {
    return b.kind === 'repairBay' && b.state === 'online' && b.enabled && !b.damaged;
  }

  static parkedAt(r: Rover, b: Building): boolean {
    return r.battery > 0 && !r.recharge && r.phase !== 'disabled' && r.phase !== 'moving' &&
      (r.command.type === 'idle' && r.pending.length === 0 || r.command.type === 'wait') &&
      Math.hypot(r.x - b.x, r.z - b.z) <= BUILDINGS.repairBay.radius + 5;
  }

  /** Stable id/part order; a second bay cannot work on the same rover. */
  static jobFor(state: ColonyState, b: Building): PartReplacement | null {
    if (!MaintenanceSystem.runnable(b) && !b.maintenance) return null;
    const eligible = (r: Rover) => MaintenanceSystem.parkedAt(r, b) &&
      !state.buildings.some((other) => other.id !== b.id &&
        MaintenanceSystem.runnable(other) && other.maintenance?.roverId === r.id);
    const job = b.maintenance;
    if (job) {
      const r = state.rovers.find((r) => r.id === job.roverId);
      if (r && eligible(r) && r.parts[job.component] <= PART_REPLACE_THRESHOLD) return job;
    }
    if (!MaintenanceSystem.runnable(b)) return null;
    const rovers = state.rovers.filter(eligible).sort((a, c) => a.id - c.id);
    // Prefer a repair we can actually finish; a missing motor must not block
    // an available board (or another rover's repair) indefinitely.
    for (const stocked of [true, false]) {
      for (const r of rovers) {
        const component = ROVER_PARTS.find((c) => r.parts[c] <= PART_REPLACE_THRESHOLD &&
          (!stocked || state.components[c] >= 1));
        if (component) return { roverId: r.id, component, progress: 0 };
      }
    }
    return null;
  }

  /** Called by PowerSystem's production context, before power is resolved. */
  static desiredThroughput(state: ColonyState, b: Building): number {
    const job = MaintenanceSystem.jobFor(state, b);
    return job && state.components[job.component] >= 1 ? 1 : 0;
  }

  /** Keep automation from stealing a parked rover during a funded repair. */
  static holdsRover(state: ColonyState, r: Rover): boolean {
    return state.buildings.some((b) => {
      if (!MaintenanceSystem.runnable(b)) return false;
      const job = MaintenanceSystem.jobFor(state, b);
      return job?.roverId === r.id && state.components[job.component] >= 1;
    });
  }

  /** After power, before job dispatch: consume the power the bay actually got. */
  static tickBays(state: ColonyState): void {
    for (const b of state.buildings) {
      if (b.kind !== 'repairBay') continue;
      const job = MaintenanceSystem.jobFor(state, b);
      b.maintenance = job;
      if (!MaintenanceSystem.runnable(b)) continue;
      if (!job) {
        b.idleReason = `Park a rover beside the bay — parts replaced at ${PART_REPLACE_THRESHOLD}% or below`;
        continue;
      }
      if (state.components[job.component] < 1) {
        b.idleReason = `Needs 1 × ${COMPONENTS[job.component].label} from the Workshop`;
        continue;
      }
      if (b.powerSat <= 0 || b.throughput <= 0) {
        b.idleReason = 'No power — replacement paused';
        continue;
      }
      job.progress = Math.min(1, job.progress + SIM_TICK * b.throughput * devLevelMul(b.level) * upgradeMul(b, 'service') / PART_REPLACE_SECONDS);
      b.idleReason = `Replacing ${COMPONENTS[job.component].label} — ${Math.floor(job.progress * 100)}%`;
      if (job.progress < 1 - 1e-9) continue;
      const r = state.rovers.find((r) => r.id === job.roverId)!;
      // Recheck and debit through the ledger: concurrent bays never spend the
      // same unit, and a cancelled job never owes a refund.
      if (ComponentSystem.take(state, job.component, 1) !== 1) continue;
      r.parts[job.component] = 100;
      b.maintenance = null;
      state.domainEvents.push({ type: 'rover/part-replaced', roverId: r.id, buildingId: b.id, component: job.component });
      state.alerts.event('ok', `${r.label}: ${COMPONENTS[job.component].label} replaced (1 spare used).`, state.simTime, state.clock.format());
    }
  }

  /** After rover movement/work: usage and exposed storms wear installed parts. */
  static tickWear(state: ColonyState): void {
    for (const r of state.rovers) {
      if (r.phase === 'disabled') continue;
      const moving = r.phase === 'moving';
      const working = r.phase === 'working';
      const sheltered = r.sheltered || state.buildings.some((b) =>
        MaintenanceSystem.runnable(b) && MaintenanceSystem.parkedAt(r, b));
      const intensity = sheltered ? 0 : state.weather.localIntensity(r.x, r.z);
      const storm = intensity > 0.4 ? intensity : 0;
      const motor = (moving ? PART_MOTOR_WEAR_MOVE : working ? PART_MOTOR_WEAR_WORK : 0) + storm * PART_MOTOR_WEAR_STORM;
      const board = (moving ? PART_BOARD_WEAR_MOVE : working ? PART_BOARD_WEAR_WORK : 0) + storm * PART_BOARD_WEAR_STORM;
      r.parts.motor = Math.max(0, r.parts.motor - motor * SIM_TICK);
      r.parts.circuitBoard = Math.max(0, r.parts.circuitBoard - board * SIM_TICK);
    }
  }
}
