/** Authoritative water tanks + paid links. Flow readings are derived, not saved. */
import type { WaterLink } from '../utilities/WaterNetwork';
import { waterPorts } from '../utilities/WaterNetwork';
import type { Building } from './BuildingState';
import type { FluidPools } from '../lifesupport';

export interface WaterState {
  active: boolean;
  links: WaterLink[];
  tanks: Record<string, number>;
  flowKgHour: Record<string, number>;
}
export const emptyWaterState = (): WaterState => ({
  active: false,
  links: [],
  tanks: {},
  flowKgHour: {},
});

/** Capacity changes remove demolished links and clamp lost/damaged tanks. No mass creation. */
export function reconcileWater(state: {
  buildings: Building[];
  water: WaterState;
  pools: FluidPools;
}): void {
  const ports = waterPorts(state.buildings);
  const live = new Set(ports.map((p) => p.id));
  state.water.links = state.water.links.filter(
    (l) => live.has(l.a) && live.has(l.b),
  );
  if (!state.water.active) return;
  const tanks: Record<string, number> = {};
  for (const p of ports) {
    const stored = state.water.tanks[p.id] ?? 0;
    tanks[p.id] = Number.isFinite(stored)
      ? Math.max(0, Math.min(p.capacity, stored))
      : 0;
  }
  state.water.tanks = tanks;
  state.pools.amounts.water = Object.values(tanks).reduce(
    (sum, n) => sum + n,
    0,
  );
}
