/**
 * Particle emitters: wind-blown dust, storm grit, dust devils and rover wheel
 * trails. Pure logic over `ParticlePool` — no three.js, no DOM — driven each
 * frame by an `FxContext` the weather controller (`../WeatherFX`) builds from
 * the authoritative sim (`sim/weather.ts` + rover positions).
 *
 * Every emitter is rate-based with a fractional accumulator, so emission is
 * smooth at any frame rate and any game speed, and freezes exactly when the
 * sim does (`dt = 0` emits nothing).
 */

import type { ParticlePool, Rand } from './ParticlePool';
import { PKind } from './ParticlePool';
import type { StormKind } from '../../sim/weather';

/** Everything an emitter needs to know about this frame's world. */
export interface FxContext {
  /** Absolute sim time (seconds) — freezes on pause. */
  time: number;
  /** Sim seconds advanced this frame. */
  dt: number;
  /**
   * Emission centre — the ground under the middle of the view, which the
   * controller derives from the camera. Boxes and devil spawns follow it.
   */
  camX: number;
  camZ: number;
  /** Wind drift vector in world units/second (sim speed × compass bearing). */
  windX: number;
  windZ: number;
  /** Raw wind speed in m/s, for effect scaling. */
  windSpeed: number;
  /** Airborne dust density 0..1 (the same number that dims the panels). */
  dust: number;
  /** Live storm class + intensity envelope 0..1. */
  storm: StormKind;
  stormIntensity: number;
  /** Authoritative ground height (particles spawn above it, settle on it). */
  heightAt: (x: number, z: number) => number;
  rand: Rand;
}

const rr = (rand: Rand, a: number, b: number): number => a + rand() * (b - a);

/** Sandy dust palette with a little per-particle variation. */
function dustTint(
  rand: Rand,
  base: { r: number; g: number; b: number },
  spread: number,
): { r: number; g: number; b: number } {
  return {
    r: base.r + (rand() - 0.5) * spread,
    g: base.g + (rand() - 0.5) * spread,
    b: base.b + (rand() - 0.5) * spread,
  };
}

const WIND_TINT = { r: 0.78, g: 0.61, b: 0.43 };
// Storm grit reads brighter than the ground — sunlit airborne dust plus
// backscatter — so the wall separates from the terrain even from high orbit.
const STORM_TINT = { r: 0.85, g: 0.61, b: 0.4 };
const DEVIL_TINT = { r: 0.88, g: 0.64, b: 0.43 };
const TRAIL_TINT = { r: 0.76, g: 0.55, b: 0.38 };

// ------------------------------------------------------------- wind ----

/**
 * Ambient dust in the wind: a camera-following box of motes drifting on the
 * sim's wind vector. Always on, nearly invisible on a clear sol, thickening
 * as dust fills the air. Particles fade in and out over long lives, so the
 * box edge never visibly pops.
 */
export class WindEmitter {
  private acc = 0;

  /** Exposed for tuning/tests: particles emitted per second right now. */
  rateFor(ctx: FxContext): number {
    return Math.min(150, 6 + ctx.windSpeed * 1.7 + ctx.dust * 75);
  }

  update(ctx: FxContext, pool: ParticlePool): void {
    this.acc += this.rateFor(ctx) * ctx.dt;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.emitOne(ctx, pool);
    }
    // Never bank more than a frame's worth across a hitch.
    if (this.acc > 8) this.acc = 8;
  }

  private emitOne(ctx: FxContext, pool: ParticlePool): void {
    const R = ctx.rand;
    const W = 150;
    const D = 150;
    const H = 34;
    const x = ctx.camX + (R() - 0.5) * W;
    const z = ctx.camZ + (R() - 0.5) * D;
    const g = ctx.heightAt(x, z);
    const tint = dustTint(R, WIND_TINT, 0.09);
    const spread = 0.85 + R() * 0.3;
    pool.spawn({
      x,
      y: g + 0.4 + R() * H,
      z,
      vx: ctx.windX * spread + (R() - 0.5) * 1.2,
      vy: (R() - 0.4) * 0.7,
      vz: ctx.windZ * spread + (R() - 0.5) * 1.2,
      life: 4 + R() * 3,
      size0: 0.5 + R() * 0.7,
      size1: 1.2 + R() * 0.9,
      ...tint,
      alpha: 0.06 + ctx.dust * 0.2,
      fadeIn: 0.2,
      fadeOut: 0.45,
      gravity: 0.12,
      drag: 0.05,
      turbulence: 1.1,
      groundY: g + 0.15,
    });
  }
}

// ------------------------------------------------------------- storm ----

/**
 * Storm grit: dense, fast, near-horizontal dust that only exists while a storm
 * is blowing. A third of the spawns hug the ground as rushing streaks; the
 * rest fill a tighter box around the camera so a severe storm reads as a wall.
 */
export class StormEmitter {
  private acc = 0;

  rateFor(ctx: FxContext): number {
    const k = ctx.stormIntensity;
    if (k <= 0.03) return 0;
    // Devils are local vortices under relatively clear skies (visibility
    // stays high) — they kick up a light haze, not a regional grit wall.
    const kindScale = ctx.storm === 'devil' ? 0.25 : ctx.storm === 'regional' ? 0.7 : 1;
    return Math.min(560, (k * 520 + ctx.dust * 40) * kindScale);
  }

  update(ctx: FxContext, pool: ParticlePool): void {
    this.acc += this.rateFor(ctx) * ctx.dt;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.emitOne(ctx, pool);
    }
    if (this.acc > 24) this.acc = 24;
  }

  private emitOne(ctx: FxContext, pool: ParticlePool): void {
    const R = ctx.rand;
    const k = Math.max(0.05, ctx.stormIntensity);
    const W = 110;
    const D = 110;
    const H = 26;
    const x = ctx.camX + (R() - 0.5) * W;
    const z = ctx.camZ + (R() - 0.5) * D;
    const g = ctx.heightAt(x, z);
    const streak = R() < 0.4;
    const tint = dustTint(R, STORM_TINT, 0.08);
    const boost = 1.0 + k * 0.8;
    // Slow vertical heaving sells the gust fronts rolling through.
    const heave = Math.sin(ctx.time * 2.4 + x * 0.05 + z * 0.03) * 2.6 * k;
    pool.spawn({
      x,
      y: streak ? g + 0.3 + R() * 2.2 : g + 0.5 + R() * H,
      z,
      vx: ctx.windX * boost + (R() - 0.5) * (3 + 5 * k),
      vy: heave * 0.4 + (R() - 0.5) * 1.6,
      vz: ctx.windZ * boost + (R() - 0.5) * (3 + 5 * k),
      life: 2 + R() * 2,
      size0: 2.0 + R() * 1.6,
      size1: 4.0 + R() * 2.5,
      ...tint,
      alpha: 0.15 + 0.4 * k,
      fadeIn: 0.12,
      fadeOut: 0.4,
      gravity: 0.25,
      drag: 0.12,
      turbulence: 2.2 + 2.5 * k,
      groundY: g + 0.12,
    });
  }
}

// --------------------------------------------------------- dust devil ----

export interface DevilOptions {
  x: number;
  z: number;
  groundY: number;
  baseRadius?: number;
  height?: number;
  /** Radians of spin per second at the rim. */
  spin?: number;
  spinDir?: 1 | -1;
}

/**
 * One wandering dust devil: a spinning column plus a skirt of outflow dust at
 * its base. Particles spawn through the funnel with tangential + inward + rising
 * velocity, so the vortex shape emerges from motion, not sprites. `strength`
 * ramps toward `target`, so devils spin up and dissipate instead of popping.
 */
export class DustDevil {
  x: number;
  z: number;
  groundY: number;
  readonly baseR: number;
  readonly height: number;
  readonly spin: number;
  readonly dir: 1 | -1;
  /** 0..1 — eased toward `target` every update. */
  strength = 0;
  target = 1;

  private readonly wanderA: number;
  private colAcc = 0;
  private skirtAcc = 0;

  constructor(o: DevilOptions, rand: Rand = Math.random) {
    this.x = o.x;
    this.z = o.z;
    this.groundY = o.groundY;
    this.baseR = o.baseRadius ?? 3.2 + rand() * 2.4;
    this.height = o.height ?? 26 + rand() * 14;
    this.spin = o.spin ?? 2.6 + rand() * 1.4;
    this.dir = o.spinDir ?? (rand() < 0.5 ? 1 : -1);
    this.wanderA = rand() * Math.PI * 2;
  }

  update(ctx: FxContext, pool: ParticlePool): void {
    // Devils walk downwind at a fraction of the wind, meandering as they go.
    const t = ctx.time;
    this.x += (ctx.windX * 0.22 + Math.cos(t * 0.3 + this.wanderA) * 1.6) * ctx.dt;
    this.z += (ctx.windZ * 0.22 + Math.sin(t * 0.23 + this.wanderA * 1.7) * 1.6) * ctx.dt;
    this.groundY = ctx.heightAt(this.x, this.z);

    this.strength += (this.target - this.strength) * Math.min(1, ctx.dt * 0.9);
    if (this.strength < 0.02) return;

    this.colAcc += 220 * this.strength * ctx.dt;
    while (this.colAcc >= 1) {
      this.colAcc -= 1;
      this.emitColumn(ctx, pool);
    }
    if (this.colAcc > 10) this.colAcc = 10;

    this.skirtAcc += 42 * this.strength * ctx.dt;
    while (this.skirtAcc >= 1) {
      this.skirtAcc -= 1;
      this.emitSkirt(ctx, pool);
    }
    if (this.skirtAcc > 6) this.skirtAcc = 6;
  }

  private emitColumn(ctx: FxContext, pool: ParticlePool): void {
    const R = ctx.rand;
    // Bias spawns low: the funnel is densest where it touches the ground.
    const h01 = Math.pow(R(), 1.5);
    const h = h01 * this.height;
    // The funnel widens with altitude.
    const r = this.baseR * (0.35 + 1.5 * h01) * (0.75 + R() * 0.5);
    const a = R() * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const tint = dustTint(R, DEVIL_TINT, 0.07);
    // Tangential rim speed plus a centripetal anchor on the funnel: without
    // the anchor the throw would fly off on straight tangents and the column
    // would dissolve into haze. Rim speed grows with radius while the spring
    // is uniform, so the funnel naturally flares with height.
    const rim = this.spin * r * 0.3 * this.dir;
    pool.spawn({
      x: this.x + ca * r,
      y: this.groundY + 0.3 + h,
      z: this.z + sa * r,
      vx: -sa * rim,
      vy: 5 + 3.5 * (1 - h01) + R() * 1.5,
      vz: ca * rim,
      life: 0.9 + R() * 0.7,
      size0: 1.8 + R() * 1.4,
      size1: 3.5 + R() * 2.0,
      ...tint,
      alpha: 0.6 * this.strength,
      fadeIn: 0.15,
      fadeOut: 0.5,
      gravity: 0,
      drag: 0.4,
      turbulence: 1.4,
      kind: PKind.Devil,
      pullX: this.x,
      pullZ: this.z,
      pullK: 5,
    });
  }

  private emitSkirt(ctx: FxContext, pool: ParticlePool): void {
    const R = ctx.rand;
    const a = R() * Math.PI * 2;
    const r = this.baseR * (1.2 + R() * 1.1);
    const tint = dustTint(R, DEVIL_TINT, 0.08);
    const speed = 6 + R() * 4;
    pool.spawn({
      x: this.x + Math.cos(a) * r,
      y: this.groundY + 0.3 + R() * 0.8,
      z: this.z + Math.sin(a) * r,
      vx: Math.cos(a) * speed + ctx.windX * 0.2,
      vy: 0.8 + R() * 1.2,
      vz: Math.sin(a) * speed + ctx.windZ * 0.2,
      life: 0.5 + R() * 0.4,
      size0: 1.1 + R() * 0.9,
      size1: 2.8 + R() * 1.2,
      ...tint,
      alpha: 0.3 * this.strength,
      fadeIn: 0.1,
      fadeOut: 0.6,
      gravity: 1.2,
      drag: 1.6,
      turbulence: 1.8,
      groundY: this.groundY + 0.1,
      kind: PKind.Devil,
    });
  }
}

/**
 * Owns the live devils. A dust-devil storm spins up one (two in a strong one)
 * near the camera; anything else lets them dissipate and removes them. Devils
 * never spawn for regional/severe/planetary storms — those are grit walls, not
 * vortices.
 */
export class DevilManager {
  devils: DustDevil[] = [];

  /** Devils currently visible (spun up past a whisper). */
  get activeCount(): number {
    return this.devils.filter((d) => d.strength > 0.05).length;
  }

  wantedFor(ctx: FxContext): number {
    if (ctx.storm !== 'devil' || ctx.stormIntensity <= 0.05) return 0;
    return ctx.stormIntensity > 0.55 ? 2 : 1;
  }

  update(ctx: FxContext, pool: ParticlePool): void {
    const want = this.wantedFor(ctx);
    while (this.devils.length < want) this.devils.push(this.spawnNear(ctx));
    for (let i = 0; i < this.devils.length; i++) {
      this.devils[i].target = i < want ? 1 : 0;
      this.devils[i].update(ctx, pool);
    }
    this.devils = this.devils.filter((d) => d.target > 0 || d.strength > 0.02);
  }

  private spawnNear(ctx: FxContext): DustDevil {
    const R = ctx.rand;
    const bearing = R() * Math.PI * 2;
    const dist = 30 + R() * 40;
    const x = ctx.camX + Math.cos(bearing) * dist;
    const z = ctx.camZ + Math.sin(bearing) * dist;
    return new DustDevil({ x, z, groundY: ctx.heightAt(x, z) }, R);
  }
}

// ------------------------------------------------------- rover trails ----

/** What the trail emitter needs per rover (speed comes from the controller). */
export interface TrailRover {
  id: number;
  x: number;
  z: number;
  /** Compass heading, atan2(x, z) — same convention as the sim. */
  heading: number;
  /** World units / sim second. */
  speed: number;
}

/**
 * Dust kicked up by rover wheels. Emission rate, puff size and opacity all
 * grow with speed — a crawl barely whispers, a utility rover at full cruise
 * throws a proper rooster tail. Puffs alternate rear wheels, inherit a little
 * of the rover's backwards throw plus the ambient wind, rise, then settle.
 */
export class RoverTrailEmitter {
  private readonly acc = new Map<number, number>();
  private readonly side = new Map<number, number>();

  /** Particles/second for a rover moving at `speed` (0 below a crawl). */
  rateFor(speed: number): number {
    if (speed < 0.4) return 0;
    return Math.min(72, 6 + speed * 4);
  }

  update(ctx: FxContext, pool: ParticlePool, rovers: TrailRover[]): void {
    const seen = new Set<number>();
    for (const r of rovers) {
      seen.add(r.id);
      const rate = this.rateFor(r.speed);
      if (rate <= 0) {
        this.acc.set(r.id, 0);
        continue;
      }
      const a = (this.acc.get(r.id) ?? 0) + rate * ctx.dt;
      let n = Math.floor(a);
      // The carry is always fractional; the burst itself is inherently bounded
      // (rate ≤ 60/s, dt ≤ 0.5 s), so no clamp can starve or flood the trail.
      this.acc.set(r.id, a - n);
      while (n-- > 0) this.emitOne(ctx, pool, r);
    }
    // Rovers that no longer exist must not leak accumulator entries.
    for (const id of [...this.acc.keys()]) {
      if (!seen.has(id)) {
        this.acc.delete(id);
        this.side.delete(id);
      }
    }
  }

  private emitOne(ctx: FxContext, pool: ParticlePool, r: TrailRover): void {
    const R = ctx.rand;
    // Alternate rear wheels so the trail reads as two churned tracks.
    const s = -(this.side.get(r.id) ?? 1);
    this.side.set(r.id, s);
    const fx = Math.sin(r.heading);
    const fz = Math.cos(r.heading);
    const lx = Math.cos(r.heading);
    const lz = -Math.sin(r.heading);
    const bx = r.x - fx * 1.9 + lx * s * 1.15;
    const bz = r.z - fz * 1.9 + lz * s * 1.15;
    const g = ctx.heightAt(bx, bz);
    const tint = dustTint(R, TRAIL_TINT, 0.08);
    const size = 0.9 + r.speed * 0.09;
    pool.spawn({
      x: bx,
      y: g + 0.45,
      z: bz,
      vx: -fx * r.speed * 0.1 + ctx.windX * 0.12 + (R() - 0.5) * 1.1,
      vy: (0.9 + r.speed * 0.14) * (0.7 + R() * 0.6),
      vz: -fz * r.speed * 0.1 + ctx.windZ * 0.12 + (R() - 0.5) * 1.1,
      life: 1.4 + R() * 1.0,
      size0: size,
      size1: size * 3.0,
      ...tint,
      alpha: Math.min(0.5, 0.14 + r.speed * 0.03),
      fadeIn: 0.12,
      fadeOut: 0.55,
      gravity: 0.9,
      drag: 1.1,
      turbulence: 1.6,
      groundY: g + 0.12,
      kind: PKind.Trail,
    });
  }
}
