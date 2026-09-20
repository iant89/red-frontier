/** Untrusted-save boundary for water; runtime topology never handles raw JSON. */
import type { ColonyState } from '../state/ColonyState';
import { emptyWaterState, reconcileWater } from '../state/WaterState';
import { waterPorts, waterLinkKey, pipeCost } from '../utilities/WaterNetwork';
import { WATER_PIPE_MAX_RUN } from '../config';

export function restoreWater(state: ColonyState, raw: unknown): void {
  state.water = emptyWaterState();
  if (!raw || typeof raw !== 'object') return;
  const saved = raw as Record<string, unknown>;
  state.water.active = saved.active === true;
  const ports = waterPorts(state.buildings),
    seen = new Set<string>();
  if (Array.isArray(saved.links))
    for (const link of saved.links) {
      if (!link || typeof link !== 'object') continue;
      const { a, b, pipes } = link;
      if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue;
      const from = ports.find((p) => p.id === a),
        to = ports.find((p) => p.id === b);
      if (
        !from ||
        !to ||
        Math.hypot(from.x - to.x, from.z - to.z) > WATER_PIPE_MAX_RUN
      )
        continue;
      if (pipes !== pipeCost(from, to)) continue; // no inflated salvage claim
      const key = waterLinkKey(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      state.water.links.push({ a: Math.min(a, b), b: Math.max(a, b), pipes });
    }
  state.water.links.sort((x, y) => x.a - y.a || x.b - y.b);
  if (state.water.active && saved.tanks && typeof saved.tanks === 'object') {
    const tanks = saved.tanks as Record<string, unknown>;
    for (const p of ports) {
      const n = tanks[p.id];
      state.water.tanks[p.id] =
        typeof n === 'number' && Number.isFinite(n)
          ? Math.max(0, Math.min(p.capacity, n))
          : 0;
    }
  }
  reconcileWater(state);
}
