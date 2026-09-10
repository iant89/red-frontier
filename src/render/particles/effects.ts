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
  /**
   * The terrain's own colour at a point, 0..1 RGB — a devil picks its dust up
   * off *this* ground, so its particles wear the ground's tint. Optional; a
   * null return (or no provider) falls back to the generic sand palette.
   */
  groundTint?: (x: number, z: number) => { r: number; g: number; b: number } | null;
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
 * One wandering dust devil.
 *
 * Life cycle, the way real ones read from a distance:
 *  - **Birth** — it starts on the ground. A skirt of dust bursts outward at
 *    the surface while the column *grows upward* from zero height (`growth`
 *    ramps over the first ~3 s), so the vortex visibly climbs into the air.
 *  - **Maturity** — a tall, narrow funnel (48–84 m) whose diameter varies
 *    along its body (a bulge profile modulated over time), whose particles
 *    wear the colour of the ground they were picked up from, and whose top
 *    wobbles sideways on its own — while staying anchored over the base, it
 *    never tears loose from the lower half of the vortex.
 *  - **Travel** — the devil walks downwind, laying down a lingering layer of
 *    settled dust along its track: a snaking deposit trail that survives the
 *    vortex itself.
 *  - **Death** — it does not pop. `strength` bleeds off slowly; emission rate,
 *    funnel diameter and skirt all shrink with it, until the last motes fade
 *    out of a column too thin to see.
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
  /** 0..1 — the column grows upward from the ground while this ramps. */
  growth = 0;
  /** Horizontal radius multiplier; collapses toward a thread as it dies. */
  radiusScale = 1;

  private readonly wanderA: number;
  private readonly wobA: number;
  private readonly wobB: number;
  private readonly wobF1: number;
  private readonly wobF2: number;
  private readonly bulgePhase: number;
  /** The ground's tint where the devil spawned — refreshed as it travels. */
  private tint = { ...DEVIL_TINT };
  private tintAt = -1;
  private colAcc = 0;
  private skirtAcc = 0;
  private depositAcc = 0;
  private spawned = false;

  constructor(o: DevilOptions, rand: Rand = Math.random) {
    this.x = o.x;
    this.z = o.z;
    this.groundY = o.groundY;
    // Every devil is a different size: narrow whips and fat churns alike.
    this.baseR = o.baseRadius ?? 2.7 + rand() * 3.1;
    this.height = o.height ?? 48 + rand() * 36;
    this.spin = o.spin ?? 2.6 + rand() * 1.4;
    this.dir = o.spinDir ?? (rand() < 0.5 ? 1 : -1);
    this.wanderA = rand() * Math.PI * 2;
    // Wobble: two incommensurate sines so the top never repeats its path.
    this.wobA = rand() * Math.PI * 2;
    this.wobB = rand() * Math.PI * 2;
    this.wobF1 = 0.5 + rand() * 0.4;
    this.wobF2 = 1.1 + rand() * 0.7;
    this.bulgePhase = rand() * Math.PI * 2;
  }

  /** Dead once it has fully dissipated (manager removes it then). */
  get dead(): boolean {
    return this.target === 0 && this.strength < 0.02;
  }

  /**
   * The funnel axis at a given height fraction: the base stays planted at
   * (x, z) while the top leans away on the wobble offsets — clamped so the
   * crown always hangs over the lower half of the vortex.
   */
  private axisAt(h01: number, t: number): { x: number; z: number } {
    const lean = Math.pow(h01, 1.25);
    // Amplitude grows toward the top but can never exceed the footprint:
    // the top wanders, yet never leaves the lower half behind.
    const amp = this.baseR * (0.75 + 0.35 * Math.sin(t * 0.21 + this.wobB));
    let ox = Math.sin(t * this.wobF1 + this.wobA) * amp + Math.sin(t * this.wobF2 + this.wobB) * amp * 0.45;
    let oz = Math.cos(t * this.wobF1 * 0.83 + this.wobB) * amp + Math.cos(t * this.wobF2 + this.wobA) * amp * 0.45;
    const mag = Math.hypot(ox, oz);
    const cap = this.baseR * 1.7;
    if (mag > cap) {
      ox *= cap / mag;
      oz *= cap / mag;
    }
    return { x: this.x + ox * lean, z: this.z + oz * lean };
  }

  update(ctx: FxContext, pool: ParticlePool): void {
    // Devils walk downwind at a fraction of the wind, meandering as they go.
    const t = ctx.time;
    this.x += (ctx.windX * 0.22 + Math.cos(t * 0.3 + this.wanderA) * 1.6) * ctx.dt;
    this.z += (ctx.windZ * 0.22 + Math.sin(t * 0.23 + this.wanderA * 1.7) * 1.6) * ctx.dt;
    this.groundY = ctx.heightAt(this.x, this.z);

    // The dust a devil carries is the dust it stands on — keep the palette
    // tracking the ground beneath it (refreshed at most every 0.4 s).
    if (ctx.groundTint && t - this.tintAt > 0.4) {
      this.tintAt = t;
      const g = ctx.groundTint(this.x, this.z);
      if (g) this.tint = { r: g.r, g: g.g, b: g.b };
    }

    // Spin-up is quick; dissipation is a slow wind-down — the funnel thins
    // and starves before it disappears rather than winking out.
    const rate = this.target > this.strength ? 0.9 : 0.32;
    this.strength += (this.target - this.strength) * Math.min(1, ctx.dt * rate);
    if (this.target === 0 && this.strength < 0.02) {
      this.strength = 0;
      return;
    }
    this.growth = Math.min(1, this.growth + ctx.dt / 3.1);
    // While dying, the funnel's diameter follows the dying strength straight
    // down — thinning all the way to a thread instead of holding its girth.
    const ref = this.target > 0 ? Math.max(0.2, this.target) : 1;
    this.radiusScale = 0.3 + 0.7 * Math.min(1, this.strength / ref);

    if (!this.spawned) {
      this.spawned = true;
      this.burstGround(ctx, pool);
    }

    const vigour = Math.pow(Math.max(0, this.strength), 1.15) * this.radiusScale;

    this.colAcc += 330 * vigour * ctx.dt;
    while (this.colAcc >= 1) {
      this.colAcc -= 1;
      this.emitColumn(ctx, pool, t);
    }
    if (this.colAcc > 12) this.colAcc = 12;

    this.skirtAcc += 90 * vigour * ctx.dt;
    while (this.skirtAcc >= 1) {
      this.skirtAcc -= 1;
      this.emitSkirt(ctx, pool);
    }
    if (this.skirtAcc > 8) this.skirtAcc = 8;

    // The deposit layer: settled dust left along the track as it travels.
    this.depositAcc += 14 * vigour * ctx.dt;
    while (this.depositAcc >= 1) {
      this.depositAcc -= 1;
      this.emitDeposit(ctx, pool);
    }
    if (this.depositAcc > 4) this.depositAcc = 4;
  }

  /** Birth: dust rips off the ground in a ring before the column exists. */
  private burstGround(ctx: FxContext, pool: ParticlePool): void {
    const R = ctx.rand;
    for (let i = 0; i < 46; i++) {
      const a = R() * Math.PI * 2;
      const r = this.baseR * (0.3 + R() * 1.6);
      const speed = 3.5 + R() * 5;
      pool.spawn({
        x: this.x + Math.cos(a) * r,
        y: this.groundY + 0.25 + R() * 0.6,
        z: this.z + Math.sin(a) * r,
        vx: Math.cos(a) * speed,
        vy: 1.4 + R() * 2.6,
        vz: Math.sin(a) * speed,
        life: 0.7 + R() * 0.7,
        size0: 1.4 + R() * 1.2,
        size1: 3.4 + R() * 2.2,
        ...dustTint(R, this.tint, 0.07),
        alpha: 0.4,
        fadeIn: 0.08,
        fadeOut: 0.6,
        gravity: 1.6,
        drag: 1.4,
        turbulence: 2.2,
        groundY: this.groundY + 0.12,
        kind: PKind.Devil,
      });
    }
  }

  private emitColumn(ctx: FxContext, pool: ParticlePool, t: number): void {
    const R = ctx.rand;
    // Bias spawns low: the funnel is densest where it touches the ground.
    // While the devil is still growing, the column only reaches as high as
    // it has climbed — the vortex visibly rises out of the ground.
    const grow = this.growth * this.growth * (3 - 2 * this.growth);
    const h01 = Math.pow(R(), 1.35) * Math.max(0.06, grow);
    const h = h01 * this.height;
    // Diameter varies along the body: the classic widening funnel plus a
    // slow-moving bulge, so the column breathes instead of reading as a cone.
    const bulge = 1 + 0.18 * Math.sin(h01 * 6.5 + t * 0.9 + this.bulgePhase);
    const r =
      this.baseR *
      this.radiusScale *
      (0.3 + 1.7 * Math.pow(h01, 0.9)) *
      bulge *
      (0.72 + R() * 0.55);
    const a = R() * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const axis = this.axisAt(h01, t);
    // Tangential rim speed plus a centripetal anchor on the (wobbling) axis:
    // without the anchor the throw would fly off on straight tangents and the
    // column would dissolve into haze. The anchor follows the lean, so the
    // funnel bends with the wobble instead of shearing apart.
    const rim = this.spin * r * 0.3 * this.dir;
    pool.spawn({
      x: axis.x + ca * r,
      y: this.groundY + 0.3 + h,
      z: axis.z + sa * r,
      vx: -sa * rim,
      vy: 5.5 + 4 * (1 - h01) + R() * 1.8,
      vz: ca * rim,
      life: 0.95 + R() * 0.75,
      size0: 1.9 + R() * 1.5,
      size1: 3.8 + R() * 2.2,
      ...dustTint(R, this.tint, 0.07),
      alpha: 0.62 * Math.min(1, this.strength * 1.4),
      fadeIn: 0.15,
      fadeOut: 0.5,
      gravity: 0,
      drag: 0.4,
      turbulence: 1.4,
      kind: PKind.Devil,
      pullX: axis.x,
      pullZ: axis.z,
      pullK: 5,
    });
  }

  private emitSkirt(ctx: FxContext, pool: ParticlePool): void {
    const R = ctx.rand;
    const a = R() * Math.PI * 2;
    const r = this.baseR * this.radiusScale * (1.2 + R() * 1.2);
    const speed = 6 + R() * 4.5;
    pool.spawn({
      x: this.x + Math.cos(a) * r,
      y: this.groundY + 0.3 + R() * 0.9,
      z: this.z + Math.sin(a) * r,
      vx: Math.cos(a) * speed + ctx.windX * 0.2,
      vy: 0.9 + R() * 1.4,
      vz: Math.sin(a) * speed + ctx.windZ * 0.2,
      life: 0.55 + R() * 0.45,
      size0: 1.2 + R() * 1.0,
      size1: 3.2 + R() * 1.6,
      ...dustTint(R, this.tint, 0.08),
      alpha: 0.34 * Math.min(1, this.strength * 1.4),
      fadeIn: 0.1,
      fadeOut: 0.6,
      gravity: 1.2,
      drag: 1.6,
      turbulence: 1.8,
      groundY: this.groundY + 0.1,
      kind: PKind.Devil,
    });
  }

  /**
   * The layer a devil leaves behind: slow, long-lived motes that settle onto
   * the ground along its track, spread and fade over many seconds — a visible
   * deposit snaking across the terrain after the vortex has moved on.
   */
  private emitDeposit(ctx: FxContext, pool: ParticlePool): void {
    const R = ctx.rand;
    const a = R() * Math.PI * 2;
    const r = this.baseR * (0.2 + R() * 1.1);
    const g = ctx.heightAt(this.x + Math.cos(a) * r, this.z + Math.sin(a) * r);
    pool.spawn({
      x: this.x + Math.cos(a) * r,
      y: g + 0.18 + R() * 0.5,
      z: this.z + Math.sin(a) * r,
      vx: ctx.windX * 0.1 + (R() - 0.5) * 0.5,
      vy: 0.12 + R() * 0.25,
      vz: ctx.windZ * 0.1 + (R() - 0.5) * 0.5,
      life: 11 + R() * 9,
      size0: 2.0 + R() * 1.6,
      size1: 6.5 + R() * 4,
      ...dustTint(R, this.tint, 0.05),
      alpha: 0.16 * Math.min(1, this.strength * 1.5),
      fadeIn: 0.12,
      fadeOut: 0.8,
      gravity: 0.35,
      drag: 0.9,
      turbulence: 0.3,
      groundY: g + 0.12,
      kind: PKind.Devil,
    });
  }
}

/**
 * Owns the live devils. Devils are the vortex children of moving storm
 * systems: a devil outbreak spins up one (two in a strong one), and the big
 * grit storms carry devils in their fronts once they are properly blowing —
 * the wind and the devils arrive together. Planetary events are a uniform
 * wall of dust with no coherent vortices inside. Anything else lets the
 * devils wind down slowly and removes them once fully dissipated.
 */
export class DevilManager {
  devils: DustDevil[] = [];

  /** Devils currently visible (spun up past a whisper). */
  get activeCount(): number {
    return this.devils.filter((d) => d.strength > 0.05).length;
  }

  wantedFor(ctx: FxContext): number {
    const k = ctx.stormIntensity;
    switch (ctx.storm) {
      case 'devil':
        return k <= 0.05 ? 0 : k > 0.55 ? 2 : 1;
      case 'regional':
        return k > 0.8 ? 2 : k > 0.5 ? 1 : 0;
      case 'severe':
        return k > 0.85 ? 2 : k > 0.6 ? 1 : 0;
      default:
        return 0;
    }
  }

  update(ctx: FxContext, pool: ParticlePool): void {
    const want = this.wantedFor(ctx);
    while (this.devils.length < want) this.devils.push(this.spawnNear(ctx));
    for (let i = 0; i < this.devils.length; i++) {
      this.devils[i].target = i < want ? 1 : 0;
      this.devils[i].update(ctx, pool);
    }
    this.devils = this.devils.filter((d) => !d.dead);
  }

  /**
   * New devils form upwind of the view and ride in with the storm's wind —
   * they arrive with the weather, not out of a clear sky.
   */
  private spawnNear(ctx: FxContext): DustDevil {
    const R = ctx.rand;
    const windMag = Math.hypot(ctx.windX, ctx.windZ);
    // Upwind bearing (where the wind comes from), fanned out ±60°.
    const upwind = windMag > 0.5 ? Math.atan2(-ctx.windX, -ctx.windZ) : R() * Math.PI * 2;
    const bearing = upwind + (R() - 0.5) * (Math.PI / 1.5);
    const dist = 28 + R() * 44;
    const x = ctx.camX + Math.sin(bearing) * dist;
    const z = ctx.camZ + Math.cos(bearing) * dist;
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
