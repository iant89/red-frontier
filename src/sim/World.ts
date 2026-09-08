import { Noise2D } from '../lib/noise';
import { mulberry32, clamp, norm, smoothstep } from '../lib/rng';
import { WORLD_HALF, SPAWN_RADIUS } from './config';
import type { ResourceId } from './defs';
import { ALL_RESOURCES, RESOURCES, DEPOSIT_TABLE } from './defs';

export interface Deposit {
  id: number;
  resource: ResourceId;
  x: number;
  z: number;
  amount: number;
  maxAmount: number;
  radius: number;
}

export interface WorldGenParams {
  seed: number;
  // fraction of generated deposits that appear in the "near" ring around spawn
  nearDeposits: number;
}

/**
 * Owns the procedural height field and static deposit scatter.
 * The height field is sampled continuously so simulation, placement and the
 * rendered mesh all agree on one authoritative surface.
 */
export class World {
  seed: number;
  private noise: Noise2D;
  private heightNoise: Noise2D;
  deposits: Deposit[] = [];
  private depositRng: () => number;
  private nextId = 1;

  constructor(params: WorldGenParams) {
    this.seed = params.seed >>> 0;
    this.noise = new Noise2D(this.seed);
    // a separate, higher-frequency layer for the fine surface
    this.heightNoise = new Noise2D(this.seed ^ 0x5deece66d);
    this.depositRng = mulberry32(this.seed ^ 0x9e3779b9);
    this.generateDeposits(params);
  }

  /** Authoritative ground height at world (x, z). Continuous. */
  heightAt(x: number, z: number): number {
    // broad lowlands / ridge system
    const broad =
      this.noise.fbm(x * 0.0018 + 11.3, z * 0.0018 - 7.2, 4, 2.0, 0.5) *
      7.5;
    // medium undulation
    const mid =
      this.heightNoise.fbm(x * 0.006 + 3.1, z * 0.006 - 1.9, 3, 2.0, 0.5) * 2.2;
    // fine detail
    const fine =
      this.noise.sample(x * 0.045 + 51, z * 0.045 - 23) * 0.5;
    let h = broad + mid + fine;

    // flatten the landing zone so the base sits on level, buildable ground
    const r = Math.hypot(x, z);
    const flat = 1 - smoothstep(norm(r, SPAWN_RADIUS, SPAWN_RADIUS + 46));
    h *= flat;
    return h;
  }

  /** Local slope (radians) at (x,z) — used for placement validation. */
  slopeAt(x: number, z: number): number {
    const e = 2;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.sqrt(dx * dx + dz * dz);
  }

  inBounds(x: number, z: number): boolean {
    return Math.abs(x) < WORLD_HALF - 8 && Math.abs(z) < WORLD_HALF - 8;
  }

  private randIn(min: number, max: number): number {
    return min + this.depositRng() * (max - min);
  }

  private generateDeposits(params: WorldGenParams): void {
    const total = 30;
    const nearCount = Math.max(5, Math.round(total * params.nearDeposits));
    const counts: Record<ResourceId, number> = {
      regolith: 0,
      iron: 0,
      silicon: 0,
      aluminum: 0,
      ice: 0,
    };
    const weight: Record<ResourceId, number> = {
      regolith: 3,
      iron: 3,
      silicon: 2,
      aluminum: 1.6,
      ice: 2.2,
    };

    /**
     * The first four deposits are guaranteed and near: without reachable
     * regolith, iron, silica and — above all — ice, the life-support chain is
     * unopenable and the seed is simply unwinnable.
     */
    const guaranteed: ResourceId[] = ['regolith', 'iron', 'ice', 'silicon'];

    for (let i = 0; i < total; i++) {
      const isNear = i < nearCount;
      let res: ResourceId;
      if (i < guaranteed.length) res = guaranteed[i];
      else res = this.pickWeighted(weight);
      counts[res]++;

      let x = 0;
      let z = 0;
      const rng = this.depositRng;
      // near deposits cluster in a ring around the base; far ones across region
      if (isNear) {
        const ang = rng() * Math.PI * 2;
        const rad = SPAWN_RADIUS + 24 + rng() * 40;
        x = Math.cos(ang) * rad;
        z = Math.sin(ang) * rad;
      } else {
        const d = this.randIn(90, WORLD_HALF - 20);
        const ang = rng() * Math.PI * 2;
        x = Math.cos(ang) * d;
        z = Math.sin(ang) * d;
      }

      const table = DEPOSIT_TABLE[res];
      const amount =
        table.amountKg *
        (1 + (rng() * 2 - 1) * table.amountVariance);
      this.deposits.push({
        id: this.nextId++,
        resource: res,
        x,
        z,
        amount,
        maxAmount: amount,
        radius: table.radius * (0.8 + rng() * 0.4),
      });
    }
  }

  private pickWeighted(weight: Record<ResourceId, number>): ResourceId {
    let total = 0;
    for (const r of ALL_RESOURCES) total += weight[r];
    let roll = this.depositRng() * total;
    for (const r of ALL_RESOURCES) {
      roll -= weight[r];
      if (roll <= 0) return r;
    }
    return 'regolith';
  }

  /** nearest resource label helper for UI */
  resourceLabel(r: ResourceId): string {
    return RESOURCES[r].label;
  }
}
