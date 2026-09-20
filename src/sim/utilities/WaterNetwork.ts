/** Pure water topology. No simulation writes, power resolver, or presentation. */
import { effectiveBuildingDef } from '../engineering/upgrades';
import type { Building } from '../state/BuildingState';
import { BUILDINGS, POD_FLUID_CAPACITY } from '../defs';
import { SPAWN_X, SPAWN_Z, devLevelMul, WATER_PIPE_LENGTH } from '../config';

export interface WaterLink {
  a: number;
  b: number;
  pipes: number;
}
export interface WaterPort {
  id: number;
  label: string;
  x: number;
  z: number;
  capacity: number;
  usable: boolean;
  pump: boolean;
  source: boolean;
  power: number;
}
export function waterPorts(buildings: ReadonlyArray<Building>): WaterPort[] {
  const ports: WaterPort[] = [
    {
      id: 0,
      label: 'Landing Pod',
      x: SPAWN_X,
      z: SPAWN_Z,
      capacity: POD_FLUID_CAPACITY.water,
      usable: true,
      pump: false,
      source: false,
      power: 0,
    },
  ];
  for (const b of buildings) {
    const def = effectiveBuildingDef(b);
    if (!def.fluidCapacity?.water || b.state !== 'online') continue;
    ports.push({
      id: b.id,
      label: `${def.label} #${b.id}`,
      x: b.x,
      z: b.z,
      capacity: b.damaged ? 0 : def.fluidCapacity.water * devLevelMul(b.level),
      usable: !b.damaged,
      pump: b.kind === 'pumpStation' && b.enabled && !b.damaged,
      source: b.kind === 'extractor' && b.enabled && !b.damaged,
      power: b.enabled && !b.damaged && b.loadKw > 0 ? b.powerSat : 0,
    });
  }
  return ports.sort((a, b) => a.id - b.id);
}
export const waterLinkKey = (a: number, b: number): string =>
  `${Math.min(a, b)}:${Math.max(a, b)}`;
export const pipeCost = (
  a: Pick<WaterPort, 'x' | 'z'>,
  b: Pick<WaterPort, 'x' | 'z'>,
): number =>
  Math.max(1, Math.ceil(Math.hypot(a.x - b.x, a.z - b.z) / WATER_PIPE_LENGTH));

/** Each component is sorted by id; adjacency never depends on Map iteration order. */
export function waterGraph(ports: WaterPort[], links: readonly WaterLink[]) {
  const adjacent = new Map(
    ports.filter((p) => p.usable).map((p) => [p.id, [] as number[]]),
  );
  for (const link of links) {
    if (!adjacent.has(link.a) || !adjacent.has(link.b)) continue;
    adjacent.get(link.a)!.push(link.b);
    adjacent.get(link.b)!.push(link.a);
  }
  for (const edges of adjacent.values()) edges.sort((a, b) => a - b);
  const components: number[][] = [];
  const seen = new Set<number>();
  for (const id of adjacent.keys()) {
    if (seen.has(id)) continue;
    const queue = [id];
    seen.add(id);
    for (let i = 0; i < queue.length; i++)
      for (const next of adjacent.get(queue[i])!) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    components.push(queue.sort((a, b) => a - b));
  }
  return { adjacent, components };
}

export interface WaterNodeView extends WaterPort {
  water: number;
  network: number;
  status: string;
}
export interface WaterNetworkView {
  readonly active: boolean;
  readonly nodes: ReadonlyArray<Readonly<WaterNodeView>>;
  readonly links: ReadonlyArray<Readonly<WaterLink & { flowKgHour: number }>>;
  /** Empty means the network can safely take over from temporary shared plumbing. */
  readonly commissionReason: string;
}
