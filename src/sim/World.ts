import { MartianTerrain } from './terrain';
import type { ScatterRock, SurfaceSample, LandingSite } from './terrain';
import { NavGrid } from './navgrid';
import type { NavPoint } from './navgrid';
import { mulberry32 } from '../lib/rng';
import { WORLD_HALF, SPAWN_RADIUS } from './config';
import type { ResourceId } from './defs';
import { ALL_RESOURCES, RESOURCES, DEPOSIT_TABLE } from './defs';

export type { ScatterRock, SurfaceSample, LandingSite } from './terrain';

export interface Deposit {
  id: number;
  resource: ResourceId;
  x: number;
  z: number;
  amount: number;
  maxAmount: number;
  radius: number;
  /**
   * Runtime scheduler hint (P4, TDD §8): the rover whose auto-run currently
   * owns this seam. Never persisted — it is re-derived from live task state,
   * so a restored colony simply re-claims as its rovers work.
   */
  reservedBy?: number | null;
}

export interface WorldGenParams {
  seed: number;
  // fraction of generated deposits that appear in the "near" ring around spawn
  nearDeposits: number;
  /** Half-extent of the playable square, in metres (world size). */
  worldHalf?: number;
  /** Forced landing region name (globe picker), or null for random. */
  region?: string | null;
  /** Multiplier on deposit yields (richness option). */
  richness?: number;
}

/**
 * Owns the procedural height field and static deposit scatter.
 * The height field is sampled continuously so simulation, placement and the
 * rendered mesh all agree on one authoritative surface.
 */
export class World {
  seed: number;
  /** Half-extent of the playable square, in metres. */
  half: number;
  /** Landing region name chosen on the globe, or null for a random site. */
  region: string | null;
  private terrain: MartianTerrain;
  private nav: NavGrid;
  deposits: Deposit[] = [];
  private depositRng: () => number;
  private nextId = 1;

  constructor(params: WorldGenParams) {
    this.seed = params.seed >>> 0;
    this.half = params.worldHalf ?? WORLD_HALF;
    this.region = params.region ?? null;
    this.terrain = new MartianTerrain(this.seed, {
      region: this.region,
      worldHalf: this.half,
    });
    this.nav = new NavGrid((x, z) => this.terrain.heightAt(x, z), this.half);
    this.depositRng = mulberry32(this.seed ^ 0x9e3779b9);
    this.generateDeposits(params);
  }

  /** Authoritative ground height at world (x, z). Continuous. */
  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  /** Full geological sample — materials, region, rockiness. */
  sampleSurface(x: number, z: number): SurfaceSample {
    return this.terrain.sample(x, z);
  }

  /** Instanced debris derived from geology (rims, cliffs, rugged slopes). */
  rocks(): ScatterRock[] {
    return this.terrain.rocks;
  }

  /** Seeded landing site on the Mars globe. */
  landingSite(): LandingSite {
    return this.terrain.site;
  }

  /** Local slope (radians) at (x,z) — used for placement validation. */
  slopeAt(x: number, z: number): number {
    const e = 2;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.sqrt(dx * dx + dz * dz);
  }

  inBounds(x: number, z: number): boolean {
    return Math.abs(x) < this.half - 8 && Math.abs(z) < this.half - 8;
  }

  /** Rovers may drive here: not a rim drop-off, and reachable from the pad. */
  canDrive(x: number, z: number): boolean {
    return this.nav.canDrive(x, z);
  }

  /** Buildings may sit here: driveable and under the 0.24 slope cap. */
  canBuild(x: number, z: number): boolean {
    return this.nav.canBuild(x, z);
  }

  findPath(ax: number, az: number, bx: number, bz: number): NavPoint[] | null {
    return this.nav.findPath(ax, az, bx, bz);
  }

  pathLength(ax: number, az: number, bx: number, bz: number): number {
    return this.nav.pathLength(ax, az, bx, bz);
  }

  navStats(): { walkable: number; blocked: number; reachable: number } {
    return this.nav.stats();
  }

  private randIn(min: number, max: number): number {
    return min + this.depositRng() * (max - min);
  }

  private generateDeposits(params: WorldGenParams): void {
    // Deposit counts scale with surveyed area so larger claims stay rich.
    const areaScale = Math.min(4, Math.max(0.6, (this.half / WORLD_HALF) ** 2));
    const total = Math.round(42 * areaScale);
    const richness = params.richness ?? 1;
    const nearCount = Math.max(5, Math.round(total * params.nearDeposits));
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

      let x = 0;
      let z = 0;
      const rng = this.depositRng;
      let placed = false;
      for (let t = 0; t < 36 && !placed; t++) {
        if (isNear) {
          const ang = rng() * Math.PI * 2;
          const rad = SPAWN_RADIUS + 24 + rng() * 40;
          x = Math.cos(ang) * rad;
          z = Math.sin(ang) * rad;
        } else {
          const d = this.randIn(90, this.half - 20);
          const ang = rng() * Math.PI * 2;
          x = Math.cos(ang) * d;
          z = Math.sin(ang) * d;
        }
        placed = this.canDrive(x, z);
      }
      if (!placed) continue;

      const table = DEPOSIT_TABLE[res];
      const amount =
        table.amountKg * (1 + (rng() * 2 - 1) * table.amountVariance) * richness;
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

  /**
   * Developer mode: drop a fresh resource deposit into the world at runtime.
   * An ordinary deposit afterwards — the renderer picks it up on the next
   * sync and rovers can mine it like any generated seam.
   */
  addDeposit(resource: ResourceId, x: number, z: number, amountKg: number, radius?: number): Deposit {
    const table = DEPOSIT_TABLE[resource];
    const d: Deposit = {
      id: this.nextId++,
      resource,
      x,
      z,
      amount: amountKg,
      maxAmount: amountKg,
      radius: radius ?? table.radius,
      reservedBy: null,
    };
    this.deposits.push(d);
    return d;
  }

  /** nearest resource label helper for UI */
  resourceLabel(r: ResourceId): string {
    return RESOURCES[r].label;
  }
}
