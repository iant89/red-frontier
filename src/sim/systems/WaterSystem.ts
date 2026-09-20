/**
 * P5 water network: a deliberate commissioning transition from shared plumbing
 * to local, authoritative tanks. Pumps redistribute water only within connected
 * components, at a power-scaled network throughput (not pressure/hydraulics).
 * Production and drinking draw local buffers; a blackout never teleports water.
 */
import { upgradeMul } from '../engineering/upgrades';
import type { ColonyState } from '../state/ColonyState';
import { reconcileWater } from '../state/WaterState';
import {
  waterPorts,
  waterGraph,
  waterLinkKey,
  pipeCost,
  type WaterNetworkView,
} from '../utilities/WaterNetwork';
import {
  HOURS_PER_SEC,
  SIM_TICK,
  WATER_PUMP_KG_HOUR,
  WATER_PIPE_MAX_RUN,
} from '../config';
import { ComponentSystem } from './ComponentSystem';
import { takeFluid, addFluid, fluidHeadroom } from '../lifesupport';

export class WaterSystem {
  static connect(state: ColonyState, a: number, b: number): boolean {
    const ports = waterPorts(state.buildings),
      from = ports.find((p) => p.id === a),
      to = ports.find((p) => p.id === b);
    if (!from || !to || a === b)
      return WaterSystem.refuse(
        state,
        'Choose two different online water ports.',
      );
    if (
      state.water.links.some(
        (l) => waterLinkKey(l.a, l.b) === waterLinkKey(a, b),
      )
    )
      return WaterSystem.refuse(state, 'Those ports already have a pipe.');
    if (Math.hypot(from.x - to.x, from.z - to.z) > WATER_PIPE_MAX_RUN)
      return WaterSystem.refuse(
        state,
        `Pipe runs are limited to ${WATER_PIPE_MAX_RUN} m. Use a tank or pump as a junction.`,
      );
    const cost = pipeCost(from, to);
    if (state.components.pipe < cost)
      return WaterSystem.refuse(
        state,
        `Needs ${cost} Water Pipes; manufacture them at the Workshop.`,
      );
    ComponentSystem.take(state, 'pipe', cost);
    state.water.links.push({
      a: Math.min(a, b),
      b: Math.max(a, b),
      pipes: cost,
    });
    state.water.links.sort((x, y) => x.a - y.a || x.b - y.b);
    state.alerts.event(
      'ok',
      `${from.label} connected to ${to.label} (${cost} pipes).`,
      state.simTime,
      state.clock.format(),
    );
    return true;
  }
  static disconnect(state: ColonyState, a: number, b: number): boolean {
    const index = state.water.links.findIndex(
      (l) => waterLinkKey(l.a, l.b) === waterLinkKey(a, b),
    );
    if (index < 0)
      return WaterSystem.refuse(state, 'No pipe connects those ports.');
    const [link] = state.water.links.splice(index, 1);
    const recovered = ComponentSystem.store(
      state,
      'pipe',
      Math.floor(link.pipes / 2),
    );
    delete state.water.flowKgHour[waterLinkKey(a, b)];
    state.alerts.event(
      'info',
      `Pipe removed — ${recovered} sections recovered (half salvage, limited by rack space).`,
      state.simTime,
      state.clock.format(),
    );
    return true;
  }
  static commissionReason(state: ColonyState): string {
    if (state.water.active) return '';
    const ports = waterPorts(state.buildings),
      graph = waterGraph(ports, state.water.links);
    if (!ports.some((p) => p.source))
      return 'Build an online Water Extractor first.';
    if (!ports.some((p) => p.pump && p.power > 0))
      return 'Build and power a Pump Station first.';
    if (graph.components.length !== 1 || ports.some((p) => !p.usable))
      return 'Connect every water port, including the Landing Pod, and repair damaged structures.';
    if (state.pools.amounts.water <= 0)
      return 'Fill the shared water reserve before commissioning.';
    return '';
  }
  static commission(state: ColonyState): boolean {
    if (state.water.active) return true;
    const reason = WaterSystem.commissionReason(state);
    if (reason) return WaterSystem.refuse(state, reason);
    const ports = waterPorts(state.buildings);
    const capacity = ports.reduce((s, p) => s + p.capacity, 0);
    const reserve = state.pools.amounts.water;
    state.water.tanks = {};
    for (const p of ports)
      state.water.tanks[p.id] = (reserve * p.capacity) / capacity;
    state.water.active = true;
    reconcileWater(state);
    state.alerts.event(
      'ok',
      'Water network commissioned. Stored water preserved; new buildings now need pipes.',
      state.simTime,
      state.clock.format(),
    );
    return true;
  }
  static amount(state: ColonyState, id: number): number {
    return state.water.active
      ? (state.water.tanks[id] ?? 0)
      : state.pools.amounts.water;
  }
  static room(state: ColonyState, id: number): number {
    if (!state.water.active) return fluidHeadroom(state.pools, 'water');
    const port = waterPorts(state.buildings).find((p) => p.id === id);
    return Math.max(0, (port?.capacity ?? 0) - WaterSystem.amount(state, id));
  }
  static take(state: ColonyState, id: number, kg: number): number {
    if (!state.water.active) return takeFluid(state.pools, 'water', kg);
    const got = Math.min(Math.max(0, kg), WaterSystem.amount(state, id));
    state.water.tanks[id] = WaterSystem.amount(state, id) - got;
    WaterSystem.syncTotal(state);
    return got;
  }
  static add(state: ColonyState, id: number, kg: number): number {
    if (!state.water.active) return addFluid(state.pools, 'water', kg);
    const got = Math.min(Math.max(0, kg), WaterSystem.room(state, id));
    state.water.tanks[id] = WaterSystem.amount(state, id) + got;
    WaterSystem.syncTotal(state);
    return got;
  }
  private static syncTotal(state: ColonyState): void {
    state.pools.amounts.water = Object.values(state.water.tanks).reduce(
      (s, n) => s + n,
      0,
    );
  }
  static view(state: ColonyState): WaterNetworkView {
    const ports = waterPorts(state.buildings),
      graph = waterGraph(ports, state.water.links);
    return {
      active: state.water.active,
      commissionReason: WaterSystem.commissionReason(state),
      links: state.water.links.map((l) => ({
        ...l,
        flowKgHour: state.water.flowKgHour[waterLinkKey(l.a, l.b)] ?? 0,
      })),
      nodes: ports.map((p) => {
        const ids = graph.components.find((g) => g.includes(p.id)) ?? [p.id];
        const group = ports.filter((n) => ids.includes(n.id));
        const water = state.water.active ? WaterSystem.amount(state, p.id) : 0;
        let status = 'Supplied';
        if (!state.water.active) status = 'Temporary shared plumbing';
        else if (!p.usable) status = 'Damaged — port offline';
        else if (ids.length === 1) status = 'Not connected';
        else if (!group.some((n) => n.pump && n.power > 0))
          status = 'No pump power';
        else if (!group.some((n) => WaterSystem.amount(state, n.id) > 1e-8))
          status = 'No water';
        else if (water <= 1e-8) status = 'Awaiting pumped water';
        return { ...p, water, network: ids[0], status };
      }),
    };
  }
  static blockReason(state: ColonyState, id: number): string {
    return (
      WaterSystem.view(state).nodes.find((p) => p.id === id)?.status ??
      'Not connected'
    );
  }
  /** After current power is resolved; flows are signed from link.a to link.b. */
  static tick(state: ColonyState): void {
    state.water.flowKgHour = {};
    if (!state.water.active) return;
    reconcileWater(state);
    const ports = waterPorts(state.buildings),
      graph = waterGraph(ports, state.water.links);
    const hours = SIM_TICK * HOURS_PER_SEC;
    for (const ids of graph.components) {
      const group = ports.filter((p) => ids.includes(p.id));
      const budget = group.reduce(
        (sum, p) => sum + (p.pump ? p.power * WATER_PUMP_KG_HOUR * hours * upgradeMul(state.buildings.find(b => b.id === p.id)!, 'pump') : 0),
        0,
      );
      if (budget <= 0) continue;
      const total = group.reduce(
        (sum, p) => sum + WaterSystem.amount(state, p.id),
        0,
      );
      const capacity = group.reduce((sum, p) => sum + p.capacity, 0);
      const target = new Map(
        group.map((p) => [p.id, (total * p.capacity) / capacity]),
      );
      // Share the pump budget proportionally across deficits, so low-id tanks
      // cannot monopolise flow while a small life-support buffer stays dry.
      const demand = group.reduce(
        (sum, p) =>
          sum + Math.max(0, target.get(p.id)! - state.water.tanks[p.id]),
        0,
      );
      const available = Math.min(budget, demand);
      if (demand <= 1e-10) continue;
      for (const to of group) {
        let allocation =
          (Math.max(0, target.get(to.id)! - state.water.tanks[to.id]) *
            available) /
          demand;
        for (const from of group) {
          const kg = Math.min(
            allocation,
            state.water.tanks[from.id] - target.get(from.id)!,
          );
          if (kg <= 1e-12) continue;
          state.water.tanks[from.id] -= kg;
          state.water.tanks[to.id] += kg;
          allocation -= kg;
          WaterSystem.recordPath(
            state,
            graph.adjacent,
            from.id,
            to.id,
            kg / hours,
          );
        }
      }
    }
    WaterSystem.syncTotal(state);
  }
  private static recordPath(
    state: ColonyState,
    adjacent: Map<number, number[]>,
    from: number,
    to: number,
    rate: number,
  ): void {
    const parent = new Map<number, number>([[from, from]]),
      queue = [from];
    for (let i = 0; i < queue.length && !parent.has(to); i++)
      for (const n of adjacent.get(queue[i]) ?? []) {
        if (!parent.has(n)) {
          parent.set(n, queue[i]);
          queue.push(n);
        }
      }
    for (let n = to; n !== from; ) {
      const prev = parent.get(n)!;
      const key = waterLinkKey(prev, n);
      state.water.flowKgHour[key] =
        (state.water.flowKgHour[key] ?? 0) + (prev < n ? rate : -rate);
      n = prev;
    }
  }
  private static refuse(state: ColonyState, text: string): false {
    state.alerts.event('warn', text, state.simTime, state.clock.format());
    return false;
  }
}
