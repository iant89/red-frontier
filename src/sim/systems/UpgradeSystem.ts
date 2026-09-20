/** Paid, timed permanent refits. Jobs own prepaid materials; cancellation returns
 * what fits. Leaving service pauses a rover job; player orders always win. */
import type { ColonyState } from '../state/ColonyState';
import { recomputeCapacitiesState } from '../state/ColonyState';
import type { Rover } from '../state/RoverState';
import type { Building } from '../state/BuildingState';
import { BUILDINGS, ROVERS, ALL_RESOURCES, ALL_COMPONENTS } from '../defs';
import { SIM_TICK } from '../config';
import { LogisticsSystem } from './LogisticsSystem';
import { ComponentSystem } from './ComponentSystem';
import {
  UPGRADES,
  PAINTS,
  MAX_UPGRADE_TIER,
  roverUpgrades,
  buildingUpgrades,
  upgradePrice,
  upgradeMul,
  levelOf,
  type EntityTarget,
  type UpgradeId,
} from '../engineering/upgrades';

export class UpgradeSystem {
  static entity(state: ColonyState, target: EntityTarget) {
    return target.entity === 'rover'
      ? state.rovers.find((e) => e.id === target.id)
      : state.buildings.find((e) => e.id === target.id);
  }
  static garage(state: ColonyState, r: Rover): Building | undefined {
    return state.buildings
      .filter(
        (b) =>
          b.kind === 'garage' &&
          b.state === 'online' &&
          !b.damaged &&
          b.enabled &&
          Math.hypot(b.x - r.x, b.z - r.z) <= BUILDINGS.garage.radius + 5,
      )
      .sort((a, b) => a.id - b.id)[0];
  }
  static start(
    state: ColonyState,
    target: EntityTarget,
    id: UpgradeId,
  ): boolean {
    const e = UpgradeSystem.entity(state, target);
    if (!e || !UPGRADES[id]) return false;
    const choices =
      target.entity === 'rover'
        ? roverUpgrades((e as Rover).kind)
        : buildingUpgrades((e as Building).kind);
    if (!choices.includes(id))
      return UpgradeSystem.refuse(
        state,
        'That upgrade does not fit this machine.',
      );
    if (e.upgradeJob)
      return UpgradeSystem.refuse(
        state,
        'Finish or cancel the current refit first.',
      );
    const tier = levelOf(e, id) + 1;
    if (tier > MAX_UPGRADE_TIER)
      return UpgradeSystem.refuse(
        state,
        'This upgrade is already at its maximum tier.',
      );
    let facilityId: number | null = null;
    if (target.entity === 'rover') {
      const r = e as Rover,
        garage = UpgradeSystem.garage(state, r);
      if (
        !garage ||
        !['idle', 'wait'].includes(r.command.type) ||
        r.pending.length ||
        r.phase === 'disabled'
      )
        return UpgradeSystem.refuse(
          state,
          'Park and stop this rover beside an enabled Garage (within its service ring).',
        );
      if (
        garage.assembly ||
        state.rovers.some((other) => other.upgradeJob?.facilityId === garage.id)
      )
        return UpgradeSystem.refuse(
          state,
          'This Garage installation bay is busy.',
        );
      facilityId = garage.id;
    } else if ((e as Building).state !== 'online' || (e as Building).damaged)
      return UpgradeSystem.refuse(
        state,
        'Complete and repair this building before refitting it.',
      );
    const cost = upgradePrice(id, tier);
    if (
      !ALL_RESOURCES.every((k) => state.storage[k] >= cost.solids[k]) ||
      !ComponentSystem.has(state, cost.parts)
    )
      return UpgradeSystem.refuse(
        state,
        'Not enough materials or manufactured components for this refit.',
      );
    for (const k of ALL_RESOURCES)
      LogisticsSystem.take(state, k, cost.solids[k]);
    ComponentSystem.consume(state, cost.parts);
    e.upgradeJob = { upgrade: id, tier, progress: 0, facilityId };
    state.alerts.event(
      'ok',
      `${UPGRADES[id].label} tier ${tier} funded. Close Engineering to resume installation.`,
      state.simTime,
      state.clock.format(),
    );
    return true;
  }
  static cancel(state: ColonyState, target: EntityTarget): boolean {
    const e = UpgradeSystem.entity(state, target),
      job = e?.upgradeJob;
    if (!e || !job) return false;
    const cost = upgradePrice(job.upgrade, job.tier);
    for (const k of ALL_RESOURCES)
      LogisticsSystem.store(state, k, cost.solids[k]);
    for (const k of ALL_COMPONENTS)
      ComponentSystem.store(state, k, cost.parts[k]);
    e.upgradeJob = null;
    state.alerts.event(
      'info',
      'Refit cancelled. Materials returned up to available silo/rack capacity; overflow discarded.',
      state.simTime,
      state.clock.format(),
    );
    return true;
  }
  static paint(
    state: ColonyState,
    target: EntityTarget,
    paint: string,
  ): boolean {
    const e = UpgradeSystem.entity(state, target);
    if (!e || (paint !== '' && !(PAINTS as readonly string[]).includes(paint)))
      return false;
    e.paint = paint || null;
    return true;
  }
  static holdsRover(state: ColonyState, r: Rover): boolean {
    const j = r.upgradeJob;
    if (!j || !['idle', 'wait'].includes(r.command.type) || r.pending.length)
      return false;
    const b = state.buildings.find((b) => b.id === j.facilityId);
    return (
      !!b &&
      b.state === 'online' &&
      Math.hypot(b.x - r.x, b.z - r.z) <= BUILDINGS.garage.radius + 5
    );
  }
  static tick(state: ColonyState): void {
    for (const r of state.rovers) {
      const job = r.upgradeJob;
      if (!job || !UpgradeSystem.holdsRover(state, r)) continue;
      const b = state.buildings.find((b) => b.id === job.facilityId)!;
      if (
        !b.enabled ||
        b.damaged ||
        b.powerSat <= 0 ||
        b.assembly ||
        r.phase === 'disabled'
      )
        continue;
      job.progress = Math.min(
        1,
        job.progress +
          (SIM_TICK * b.powerSat * upgradeMul(b, 'service')) /
            upgradePrice(job.upgrade, job.tier).seconds,
      );
      if (job.progress >= 1) UpgradeSystem.complete(state, r);
    }
  }
  static workBuilding(state: ColonyState, b: Building, work: number): void {
    const job = b.upgradeJob;
    if (!job || b.damaged || !b.enabled) return;
    const power = BUILDINGS[b.kind].powerDrawKw > 0 ? b.powerSat : 1;
    job.progress = Math.min(
      1,
      job.progress +
        (SIM_TICK * work * power) / upgradePrice(job.upgrade, job.tier).seconds,
    );
    if (job.progress >= 1) {
      UpgradeSystem.complete(state, b);
      b.workerId = null;
    }
  }
  private static complete(state: ColonyState, e: Rover | Building): void {
    const job = e.upgradeJob!;
    e.upgrades = { ...e.upgrades, [job.upgrade]: job.tier };
    e.upgradeJob = null;
    recomputeCapacitiesState(state);
    const label = 'label' in e ? ROVERS[e.kind].label : BUILDINGS[e.kind].label;
    state.alerts.event(
      'ok',
      `${label}: ${UPGRADES[job.upgrade].label} tier ${job.tier} installed.`,
      state.simTime,
      state.clock.format(),
    );
  }
  private static refuse(state: ColonyState, text: string): false {
    state.alerts.event('warn', text, state.simTime, state.clock.format());
    return false;
  }
}
