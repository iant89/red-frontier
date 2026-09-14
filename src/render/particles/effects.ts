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
  /**
   * Rate of change of `windSpeed`, in m/s per sim second (smoothed by the
   * controller). A sharp rise is what spins a dust devil up out of clear
   * weather — the wind arrives before the storm is declared.
   */
  windRamp: number;
  /** Airborne dust density 0..1 (the same number that dims the panels). */
  dust: number;
  /** Live storm class + intensity envelope 0..1. */
  storm: StormKind;
  stormIntensity: number;
  /**
   * Half-diagonal (world units) of the ground footprint the camera actually
   * sees, derived by the controller from the rig radius, FOV and view angle.
   * The ambient emitters size their field from it, so a storm fills the
   * viewed area at every zoom instead of hanging in a fixed box that reads
   * as a cube from orbit.
   */
  viewRadius: number;
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

// ------------------------------------------------------- the dust field ----

/**
 * The ambient emitters do not blow dust into a fixed box: they blow it into a
 * field sized from `FxContext.viewRadius`, so the storm fills whatever the
 * camera sees. `dustField` turns that radius into the field's envelope.
 *
 * - `half` — the emission/wrap box half-extent: 1.45× the view radius, so the
 *   feathered rim (which fades to nothing exactly at `half`) always sits
 *   outside the frame.
 * - `height` — the layer's depth above the ground. It grows with the view, but
 *   far slower than the footprint: from orbit dust is a shallow veil.
 * - `size` — a world-size multiplier that keeps the on-screen grain roughly
 *   constant as the camera pulls back (a 1 m mote is sub-pixel from orbit).
 * - `alpha` — aerial perspective: the far field thins into haze instead of
 *   reading as geometry.
 * - `swirl` — turbulence multiplier, so the flow still wanders on screen when
 *   the world scale grows.
 * - `r0` — inner radius of the rim feather (see `ParticlePool.setFalloff`).
 */
/** Close-up floor: up close the player is inside the dust, not looking at it. */
export const FIELD_MIN = 45;
/**
 * From-orbit ceiling on the box half-extent. The playable world is 1280 m
 * across (~905 m half-diagonal); past this the field would hang over the void
 * beyond the terrain instead of over the planet.
 */
export const FIELD_MAX = 1000;
/** The view radius the hand-tuned ground-level numbers were scaled from. */
const FIELD_REF = 95;
/** Emission/wrap box margin over the view radius — room for the feather. */
const FIELD_MARGIN = 1.45;

export interface DustField {
  half: number;
  height: number;
  size: number;
  alpha: number;
  swirl: number;
  r0: number;
}

export function dustField(viewRadius: number): DustField {
  const v = Math.min(FIELD_MAX / FIELD_MARGIN, Math.max(FIELD_MIN, viewRadius));
  const half = v * FIELD_MARGIN;
  const size = Math.min(5, Math.max(1, Math.pow(v / FIELD_REF, 0.8)));
  return {
    half,
    height: Math.min(240, Math.max(26, v * 0.3)),
    size,
    alpha: Math.min(1, Math.max(0.6, Math.pow(FIELD_REF / v, 0.35))),
    swirl: Math.min(2.2, Math.max(1, Math.sqrt(size))),
    r0: half * 0.6,
  };
}

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
    const field = dustField(ctx.viewRadius);
    this.acc += this.rateFor(ctx) * ctx.dt;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.emitOne(ctx, pool, field);
    }
    // Never bank more than a frame's worth across a hitch.
    if (this.acc > 8) this.acc = 8;
  }

  private emitOne(ctx: FxContext, pool: ParticlePool, field: DustField): void {
    const R = ctx.rand;
    const half = field.half;
    const x = ctx.camX + (R() - 0.5) * 2 * half;
    const z = ctx.camZ + (R() - 0.5) * 2 * half;
    const g = ctx.heightAt(x, z);
    // Density falls off with height: the layer is thickest at the surface.
    const hFrac = Math.pow(R(), 1.25);
    const tint = dustTint(R, WIND_TINT, 0.09);
    const spread = 0.85 + R() * 0.3;
    pool.spawn({
      x,
      y: g + 0.4 + hFrac * field.height,
      z,
      vx: ctx.windX * spread + (R() - 0.5) * 1.2,
      vy: (R() - 0.4) * 0.7,
      vz: ctx.windZ * spread + (R() - 0.5) * 1.2,
      life: 4 + R() * 3,
      size0: (0.5 + R() * 0.7) * field.size,
      size1: (1.2 + R() * 0.9) * field.size,
      ...tint,
      alpha: (0.06 + ctx.dust * 0.2) * field.alpha * (1 - 0.45 * hFrac),
      fadeIn: 0.2,
      fadeOut: 0.45,
      gravity: 0.12,
      drag: 0.05,
      turbulence: 1.1 * field.swirl,
      groundY: g + 0.15,
    });
  }
}

// ------------------------------------------------------------- storm ----

/**
 * Storm grit: dense, fast, near-horizontal dust that only exists while a storm
 * is blowing. A third of the spawns hug the ground as a sheared surface layer;
 * the rest fill the field around the camera so a severe storm reads as a wall.
 *
 * The grit is *grit*: motes at or below the ambient wind-dust sizes, thrown in
 * numbers, riding a coherent two-octave curl field — wavy, unpredictable paths
 * that still transport downwind. (The old 4–6.5 m sprites read as small clouds.)
 */
export class StormEmitter {
  private acc = 0;

  rateFor(ctx: FxContext): number {
    const k = ctx.stormIntensity;
    if (k <= 0.03) return 0;
    // Devils are local vortices under relatively clear skies (visibility
    // stays high) — they kick up a light haze, not a regional grit wall.
    const kindScale = ctx.storm === 'devil' ? 0.25 : ctx.storm === 'regional' ? 0.7 : 1;
    return Math.min(800, (k * 750 + ctx.dust * 50) * kindScale);
  }

  update(ctx: FxContext, pool: ParticlePool): void {
    const field = dustField(ctx.viewRadius);
    this.acc += this.rateFor(ctx) * ctx.dt;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.emitOne(ctx, pool, field);
    }
    if (this.acc > 24) this.acc = 24;
  }

  private emitOne(ctx: FxContext, pool: ParticlePool, field: DustField): void {
    const R = ctx.rand;
    const k = Math.max(0.05, ctx.stormIntensity);
    const half = field.half;
    const x = ctx.camX + (R() - 0.5) * 2 * half;
    const z = ctx.camZ + (R() - 0.5) * 2 * half;
    const g = ctx.heightAt(x, z);
    const streak = R() < 0.4;
    const tint = dustTint(R, STORM_TINT, 0.08);
    const boost = 1.0 + k * 0.8;
    // Boundary-layer shear: grit at the surface lags the air above it, so the
    // field rolls instead of sliding along as one sheet.
    const hFrac = streak ? R() * 0.09 : Math.pow(R(), 1.25);
    const shear = 0.62 + 0.38 * Math.min(1, hFrac * 4);
    // Slow vertical heaving sells the gust fronts rolling through.
    const heave = Math.sin(ctx.time * 2.4 + x * 0.05 + z * 0.03) * 1.6 * k;
    pool.spawn({
      x,
      y: g + 0.3 + hFrac * field.height,
      z,
      vx: ctx.windX * boost * shear + (R() - 0.5) * (1.6 + 2.4 * k),
      vy: heave * 0.4 + (R() - 0.5) * 1.2,
      vz: ctx.windZ * boost * shear + (R() - 0.5) * (1.6 + 2.4 * k),
      life: 1.7 + R() * 1.4,
      size0: (0.35 + R() * 0.55) * field.size,
      size1: (0.9 + R() * 0.9) * field.size,
      ...tint,
      alpha: (0.3 + 0.5 * k) * field.alpha * (1 - 0.45 * hFrac),
      fadeIn: 0.12,
      fadeOut: 0.4,
      gravity: 0.25,
      drag: 0.08,
      turbulence: (14 + 26 * k) * field.swirl,
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
const DEVIL_MAX_GROWTH = 1.8;
const DEVIL_MAX_EMIT_SCALE = 2.2;

export class DustDevil {
  x: number;
  z: number;
  groundY: number;
  /** Footprint radius — a devil that swallows a smaller one gets wider. */
  baseR: number;
  /** Column height in world units — it grows with the devil. */
  height: number;
  readonly spin: number;
  readonly dir: 1 | -1;
  /** 0..1 — eased toward `target` every update. */
  strength = 0;
  target = 1;
  /** 0..1 — the column grows upward from the ground while this ramps. */
  growth = 0;
  /** Horizontal radius multiplier; collapses toward a thread as it dies. */
  radiusScale = 1;
  /** Emission-rate multiplier — a fed devil throws more dust, not just wider. */
  emitScale = 1;
  /**
   * Set while this devil is locked in a pairing (a twin orbit, or a dance
   * around a bigger devil). The pair owns its position while it lasts.
   */
  twin: DevilTwin | null = null;
  /** Sim time of its last pair resolution — a pair cannot instantly re-trigger. */
  interactAt = -Infinity;

  private readonly spawnR: number;
  private readonly spawnH: number;
  private readonly wanderA: number;
  /** Own meander: two devils in one storm never share a track. */
  private readonly wanderF1: number;
  private readonly wanderF2: number;
  private readonly wanderAmp: number;
  /** Own angle off the wind (±26°), so the drift vector splits the pack. */
  private readonly driftBias: number;
  /** Fraction of the wind this devil walks at. */
  private readonly windFollow: number;
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
    this.spawnR = this.baseR;
    this.spawnH = this.height;
    this.spin = o.spin ?? 2.6 + rand() * 1.4;
    this.dir = o.spinDir ?? (rand() < 0.5 ? 1 : -1);
    this.wanderA = rand() * Math.PI * 2;
    // Its own path: independent meander frequencies and amplitude, its own
    // angle off the wind and its own fraction of it. Shared frequencies are
    // what made a whole outbreak drift in formation.
    this.wanderF1 = 0.19 + rand() * 0.26;
    this.wanderF2 = 0.15 + rand() * 0.22;
    this.wanderAmp = 1.1 + rand() * 1.5;
    this.driftBias = (rand() - 0.5) * 0.9;
    this.windFollow = 0.17 + rand() * 0.15;
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
   * Feed this devil: a wider footprint, a taller column and heavier
   * emission. Growth is capped against the size it was born at, so repeated
   * meals cannot grow a devil without limit.
   */
  grow(factor: number): void {
    const f = Math.max(1, factor);
    this.baseR = Math.min(this.spawnR * DEVIL_MAX_GROWTH, this.baseR * f);
    this.height = Math.min(this.spawnH * DEVIL_MAX_GROWTH, this.height * f);
    this.emitScale = Math.min(DEVIL_MAX_EMIT_SCALE, this.emitScale * f);
  }

  /** Downwind drift plus this devil's own meander — its own track, every time. */
  private wander(ctx: FxContext): void {
    const t = ctx.time;
    // Walk at a fixed angle off the wind: with its own meander frequencies on
    // top, two devils released into the same wind visibly diverge.
    const speed = Math.hypot(ctx.windX, ctx.windZ) * this.windFollow;
    const bearing = Math.atan2(ctx.windX, ctx.windZ) + this.driftBias;
    this.x += (Math.sin(bearing) * speed + Math.cos(t * this.wanderF1 + this.wanderA) * this.wanderAmp) * ctx.dt;
    this.z += (Math.cos(bearing) * speed + Math.sin(t * this.wanderF2 + this.wanderA * 1.7) * this.wanderAmp) * ctx.dt;
    this.groundY = ctx.heightAt(this.x, this.z);
  }

  /** Sit where the pairing says: both devils orbit for a twin, the follower alone for a dance. */
  private ridePair(ctx: FxContext): void {
    const p = this.twin;
    if (!p) return;
    if (p.kind === 'dance') {
      if (this === p.a) {
        // The devil being danced around keeps walking its own path.
        this.wander(ctx);
        return;
      }
      // The follower rides the lead's live position, so it never trails it.
      this.x = p.a.x + Math.cos(p.phase) * p.r;
      this.z = p.a.z + Math.sin(p.phase) * p.r;
      this.groundY = ctx.heightAt(this.x, this.z);
      return;
    }
    const off = this === p.b ? Math.PI : 0;
    this.x = p.cx + Math.cos(p.phase + off) * p.r;
    this.z = p.cz + Math.sin(p.phase + off) * p.r;
    this.groundY = ctx.heightAt(this.x, this.z);
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
    const t = ctx.time;
    // A paired devil's position belongs to the pair — the twin orbit holds
    // both of them, a dance only holds the smaller one circling the bigger.
    if (this.twin) this.ridePair(ctx);
    else this.wander(ctx);

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

    this.colAcc += 330 * vigour * this.emitScale * ctx.dt;
    while (this.colAcc >= 1) {
      this.colAcc -= 1;
      this.emitColumn(ctx, pool, t);
    }
    if (this.colAcc > 12) this.colAcc = 12;

    this.skirtAcc += 90 * vigour * this.emitScale * ctx.dt;
    while (this.skirtAcc >= 1) {
      this.skirtAcc -= 1;
      this.emitSkirt(ctx, pool);
    }
    if (this.skirtAcc > 8) this.skirtAcc = 8;

    // The deposit layer: settled dust left along the track as it travels.
    this.depositAcc += 14 * vigour * this.emitScale * ctx.dt;
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

// ------------------------------------------------- dust devil society ----

/** Hard ceiling on simultaneous devils, whatever the storm or the wind does. */
export const MAX_DEVILS = 5;

/** Two devils are in contact within this multiple of their summed radii. */
const CONTACT_REACH = 1.15;
/** Seconds a devil waits after a resolution before it may pair again. */
const PAIR_COOLDOWN = 14;
/** A devil has to be properly spun up to be a merge target at all. */
const PAIR_MIN_STRENGTH = 0.5;
/** Size ratio at which the bigger devil simply swallows the smaller one. */
const CONSUME_RATIO = 1.9;
/** Size ratio at which the smaller one dances around the bigger one. */
const DANCE_RATIO = 1.25;
/** Chance a size-mismatch contact is a swallow rather than a dance. */
const DANCE_CONSUME_CHANCE = 0.25;
/** Chance a matched pair becomes twins rather than cancelling outright. */
const TWIN_CHANCE = 0.6;
/** Growth applied to a devil that consumes another. */
const CONSUME_GROWTH = 1.22;
/** Orbit geometry, as a multiple of the summed radii. */
const TWIN_ORBIT = 0.85;
const DANCE_ORBIT = 1.25;
/** How long a pairing lasts before it resolves (sim seconds). */
const TWIN_MIN = 9;
const TWIN_MAX = 18;
const DANCE_MIN = 5;
const DANCE_MAX = 11;
/** Mild separation: how fast overlapping devils peel apart, per unit overlap. */
const SEPARATION_K = 0.15;
/** Devils only separate once they are inside this multiple of their radii. */
const SEPARATION_REACH = 2.4;

/**
 * Wind acceleration (m/s per sim second) that counts as a storm front
 * arriving. Ambient wind wanders at well under this; a storm's leading edge
 * ramps at several times it.
 */
const RAMP_MIN = 0.35;
/** Excess wind acceleration to bank before a ramp spins a devil up. */
const RAMP_CHARGE = 1.6;
/** Sim seconds a ramp-spawned devil is held alive before it may wind down. */
const RAMP_LIFE = 45;
/** Minimum gap between two ramp spawns, however hard the wind keeps rising. */
const RAMP_COOLDOWN = 30;
/** Seconds a changed count band is held before the manager re-rolls into it. */
const BAND_HOLD = 2;

/**
 * How many devils a storm wants, as an inclusive `[min, max]` range — rolled
 * from the FX RNG when the storm enters the band. `null` means none at all.
 *
 * A dust-devil outbreak is a handful of small vortices; a regional front carries
 * a few in its gust front; a severe storm's wall churns more; a planetary event
 * is a uniform sheet of dust with no coherent vortices inside it.
 */
export function devilBand(storm: StormKind, k: number): [number, number] | null {
  switch (storm) {
    case 'devil':
      if (k <= 0.05) return null;
      if (k < 0.3) return [0, 1];
      if (k < 0.6) return [1, 2];
      return [1, 3];
    case 'regional':
      if (k < 0.5) return [0, 1];
      if (k < 0.8) return [0, 2];
      return [1, 4];
    case 'severe':
      if (k < 0.6) return [0, 1];
      if (k < 0.85) return [0, 2];
      return [1, 4];
    default:
      // Calm, and the uniform wall of a planetary event: no vortices.
      return null;
  }
}

/**
 * Roll a count out of a band, biased toward the low end — a handful of devils
 * should be a big storm's exception, not its default.
 */
function rollCount(band: [number, number], rand: Rand): number {
  const [lo, hi] = band;
  const n = lo + Math.pow(rand(), 1.3) * (hi - lo);
  return Math.max(0, Math.min(MAX_DEVILS, Math.round(n)));
}

/**
 * A locked pair of devils.
 *
 * - `twin` — matched sizes: both ride a shared orbit around a shared centre
 *   that drifts downwind as a unit, until they split or one (or both) dies.
 * - `dance` — a size mismatch: only the smaller devil rides the orbit, and the
 *   centre is the bigger devil, which keeps walking its own path. It ends with
 *   the little one winding down dead.
 */
export interface DevilTwin {
  kind: 'twin' | 'dance';
  /** The larger devil (for a dance, the one being circled). */
  a: DustDevil;
  /** The smaller devil (for a dance, the one that rides the orbit). */
  b: DustDevil;
  /** Shared centre of the orbit (a dance tracks the lead's live position). */
  cx: number;
  cz: number;
  /** Orbit radius in world units. */
  r: number;
  phase: number;
  /** Signed angular rate, rad/s. */
  rate: number;
  /** Sim time the pairing resolves. */
  until: number;
  /** How it ends: peel apart, or wind down. */
  end: 'split' | 'decay';
}

/**
 * Owns the live devils.
 *
 * Devils are the vortex children of moving weather: an outbreak spins up a
 * handful, the big grit storms carry devils in their fronts once they are
 * properly blowing, and a wind that is *rising* hard can spin one up before a
 * storm is even declared. Counts are rolled per storm intensity band and held
 * while the storm stays in it, so a storm doesn't re-roll its devils every
 * frame. Planetary events are a uniform wall with no coherent vortices inside;
 * anything else lets the devils wind down slowly and removes them once fully
 * dissipated.
 *
 * Devils also notice each other: they peel apart when they crowd, and a pair
 * that actually touches resolves — matched devils twin up for a while, a
 * bigger one swallows or outlasts a smaller one.
 */
export class DevilManager {
  devils: DustDevil[] = [];
  /** Live pairings (twin orbits and dances). */
  readonly pairs: DevilTwin[] = [];
  /** Resolutions performed so far — bounded, or the pairs are thrashing. */
  interactions = 0;

  /** Count rolled for the band the storm is in now. */
  private roll: { key: string; count: number } | null = null;
  /** A band change waiting out `BAND_HOLD` before it takes effect. */
  private pending: { key: string; t: number } | null = null;
  /** Banked wind acceleration, for the ramp spin-up. */
  private rampCharge = 0;
  private rampAt = -Infinity;
  /** Devils a wind ramp spun up, and the sim time their mandate expires. */
  private readonly mandates = new Map<DustDevil, number>();

  /** Devils currently visible (spun up past a whisper). */
  get activeCount(): number {
    return this.devils.filter((d) => d.strength > 0.05).length;
  }

  /** Matched pairs currently orbiting a shared centre. */
  get twinCount(): number {
    return this.pairs.filter((p) => p.kind === 'twin').length;
  }

  /** Size-mismatch pairings: a little devil circling a big one. */
  get danceCount(): number {
    return this.pairs.filter((p) => p.kind === 'dance').length;
  }

  /**
   * How many devils this storm wants right now.
   *
   * The count is a *roll* — a range per storm class and intensity band drawn
   * from the FX RNG when the storm enters the band — not a fixed ladder, so
   * two runs of the same storm can carry different numbers. It is held for as
   * long as the storm stays in the band, so the sky doesn't spawn and kill a
   * devil every frame.
   */
  wantedFor(ctx: FxContext): number {
    const band = devilBand(ctx.storm, ctx.stormIntensity);
    if (!band) {
      this.roll = null;
      this.pending = null;
      return 0;
    }
    const key = `${ctx.storm}|${band[0]}-${band[1]}`;
    if (!this.roll) {
      this.roll = { key, count: rollCount(band, ctx.rand) };
      return this.roll.count;
    }
    if (this.roll.key === key) {
      this.pending = null;
      return this.roll.count;
    }
    // The band changed. Hold the old count for a moment, so a storm hovering
    // on a band boundary doesn't churn its devils.
    if (!this.pending || this.pending.key !== key) {
      this.pending = { key, t: ctx.time };
      return this.roll.count;
    }
    if (ctx.time - this.pending.t >= BAND_HOLD) {
      this.roll = { key, count: rollCount(band, ctx.rand) };
      this.pending = null;
    }
    return this.roll.count;
  }

  update(ctx: FxContext, pool: ParticlePool): void {
    this.spinUpOnRamp(ctx);

    // Ramp-spawned devils are mandated: they live out their window even if the
    // storm that raised the wind never declares itself.
    const want = Math.min(MAX_DEVILS, this.wantedFor(ctx) + this.liveMandates(ctx.time));
    while (this.devils.length < want) this.devils.push(this.spawnNear(ctx));

    let n = 0;
    for (const d of this.devils) d.target = 0;
    for (const d of this.devils) {
      if (n >= want) break;
      if (this.mandates.has(d)) {
        d.target = 1;
        n++;
      }
    }
    for (const d of this.devils) {
      if (n >= want) break;
      if (!this.mandates.has(d)) {
        d.target = 1;
        n++;
      }
    }

    this.separate(ctx.dt);
    this.resolveContacts(ctx);

    for (const d of this.devils) d.update(ctx, pool);
    this.devils = this.devils.filter((d) => !d.dead);

    for (const [d, until] of this.mandates) {
      if (d.dead || until <= ctx.time) this.mandates.delete(d);
    }
    for (let i = this.pairs.length - 1; i >= 0; i--) {
      const p = this.pairs[i];
      if (p.a.dead || p.b.dead || p.a.target === 0 || p.b.target === 0) this.release(p);
    }
  }

  /**
   * Mild separation: two devils that end up side by side peel apart instead of
   * travelling as one clump. Gentle enough to read as crowding, not shoving.
   */
  separate(dt: number): void {
    for (let i = 0; i < this.devils.length; i++) {
      for (let j = i + 1; j < this.devils.length; j++) {
        const a = this.devils[i];
        const b = this.devils[j];
        if (a.twin && a.twin === b.twin) continue;
        const min = (a.baseR + b.baseR) * SEPARATION_REACH;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= min) continue;
        if (d < 1e-4) {
          // Exactly on top of each other: pick an arbitrary axis.
          dx = 1;
          dz = 0;
        } else {
          dx /= d;
          dz /= d;
        }
        const push = (min - d) * 0.5 * SEPARATION_K * dt;
        a.x -= dx * push;
        a.z -= dz * push;
        b.x += dx * push;
        b.z += dz * push;
      }
    }
  }

  /**
   * A rising wind spins devils up on its own, with no storm declared: the
   * gust front arrives before the dust wall does. The charge is banked from
   * the *excess* ramp and spent on one devil at a time, so a wind that keeps
   * climbing all sol cannot carpet the map with vortices.
   */
  private spinUpOnRamp(ctx: FxContext): void {
    const ramp = Math.max(0, ctx.windRamp);
    if (ramp > RAMP_MIN) {
      this.rampCharge = Math.min(RAMP_CHARGE, this.rampCharge + (ramp - RAMP_MIN) * ctx.dt);
    } else {
      this.rampCharge = Math.max(0, this.rampCharge - ctx.dt * 0.5);
    }
    if (this.rampCharge < RAMP_CHARGE) return;
    if (ctx.time - this.rampAt < RAMP_COOLDOWN) return;
    if (this.devils.length >= MAX_DEVILS) return;
    this.rampCharge = 0;
    this.rampAt = ctx.time;
    const d = this.spawnNear(ctx);
    this.devils.push(d);
    this.mandates.set(d, ctx.time + RAMP_LIFE);
  }

  private liveMandates(now: number): number {
    let n = 0;
    for (const [, until] of this.mandates) if (until > now) n++;
    return n;
  }

  // ------------------------------------------------------------ pairs ----

  private updatePairs(ctx: FxContext): void {
    for (let i = this.pairs.length - 1; i >= 0; i--) {
      const p = this.pairs[i];
      if (p.a.dead || p.b.dead || p.a.target === 0 || p.b.target === 0) {
        this.release(p);
        continue;
      }
      p.phase += p.rate * ctx.dt;
      if (p.kind === 'twin') {
        // A twin pair drifts downwind as a unit. (A dance rides the lead's
        // live position instead, so its centre follows on its own.)
        p.cx += ctx.windX * 0.22 * ctx.dt;
        p.cz += ctx.windZ * 0.22 * ctx.dt;
      }
      if (ctx.time >= p.until) {
        this.finishPair(p, ctx);
        this.release(p);
      }
    }
  }

  /**
   * Run the pair logic: advance live pairings, then resolve at most one new
   * contact. Public so pair behaviour can be pinned without dragging the
   * storm's spawn ladder into every test.
   */
  resolveContacts(ctx: FxContext): void {
    this.updatePairs(ctx);
    this.findContacts(ctx);
  }

  /** One contact resolved per frame, so a cluster can't cascade. */
  private findContacts(ctx: FxContext): void {
    for (let i = 0; i < this.devils.length; i++) {
      for (let j = i + 1; j < this.devils.length; j++) {
        const a = this.devils[i];
        const b = this.devils[j];
        if (a === b) continue;
        if (!this.pairable(a, b, ctx.time)) continue;
        const reach = (a.baseR + b.baseR) * CONTACT_REACH;
        if (Math.hypot(b.x - a.x, b.z - a.z) > reach) continue;
        this.resolveContact(a, b, ctx);
        return;
      }
    }
  }

  private pairable(a: DustDevil, b: DustDevil, now: number): boolean {
    if (a.twin || b.twin || a.dead || b.dead) return false;
    // A devil already winding down is not a merge target — it is on its way out.
    if (a.target === 0 || b.target === 0) return false;
    if (a.strength < PAIR_MIN_STRENGTH || b.strength < PAIR_MIN_STRENGTH) return false;
    return now - a.interactAt >= PAIR_COOLDOWN && now - b.interactAt >= PAIR_COOLDOWN;
  }

  /** Outcome is weighted by relative size, then rolled from the FX RNG. */
  private resolveContact(a: DustDevil, b: DustDevil, ctx: FxContext): void {
    const big = a.baseR >= b.baseR ? a : b;
    const small = big === a ? b : a;
    const q = big.baseR / Math.max(0.2, small.baseR);
    a.interactAt = ctx.time;
    b.interactAt = ctx.time;
    this.interactions++;

    if (q >= CONSUME_RATIO) {
      this.consume(big, small);
    } else if (q >= DANCE_RATIO) {
      if (ctx.rand() < DANCE_CONSUME_CHANCE) this.consume(big, small);
      else this.dance(big, small, ctx);
    } else if (ctx.rand() < TWIN_CHANCE) {
      this.twinUp(a, b, ctx);
    } else {
      // Matched size, no twins today: both spin down and go.
      a.target = 0;
      b.target = 0;
    }
  }

  /** The bigger devil eats the smaller one and visibly swells. */
  private consume(big: DustDevil, small: DustDevil): void {
    small.target = 0;
    big.grow(CONSUME_GROWTH);
  }

  /** The smaller devil circles the bigger one for a while, then dies off. */
  private dance(big: DustDevil, small: DustDevil, ctx: FxContext): void {
    const p: DevilTwin = {
      kind: 'dance',
      a: big,
      b: small,
      cx: big.x,
      cz: big.z,
      r: (big.baseR + small.baseR) * DANCE_ORBIT,
      phase: Math.atan2(small.z - big.z, small.x - big.x),
      rate: big.dir * (0.3 + ctx.rand() * 0.25),
      until: ctx.time + DANCE_MIN + ctx.rand() * (DANCE_MAX - DANCE_MIN),
      end: 'decay',
    };
    small.twin = p;
    this.pairs.push(p);
  }

  /** Matched devils: a shared orbit that later splits or decays. */
  private twinUp(a: DustDevil, b: DustDevil, ctx: FxContext): void {
    const cx = (a.x + b.x) / 2;
    const cz = (a.z + b.z) / 2;
    const p: DevilTwin = {
      kind: 'twin',
      a,
      b,
      cx,
      cz,
      r: Math.max(2.5, (a.baseR + b.baseR) * TWIN_ORBIT),
      phase: Math.atan2(a.z - cz, a.x - cx),
      rate: a.dir * (0.18 + ctx.rand() * 0.16),
      until: ctx.time + TWIN_MIN + ctx.rand() * (TWIN_MAX - TWIN_MIN),
      end: ctx.rand() < 0.5 ? 'split' : 'decay',
    };
    a.twin = p;
    b.twin = p;
    this.pairs.push(p);
  }

  private finishPair(p: DevilTwin, ctx: FxContext): void {
    p.a.interactAt = ctx.time;
    p.b.interactAt = ctx.time;
    if (p.end === 'split') {
      // Peel them well clear of contact range, or they would pair right back up.
      const r = p.r * 1.9;
      const ax = Math.cos(p.phase);
      const az = Math.sin(p.phase);
      p.a.x = p.cx + ax * r;
      p.a.z = p.cz + az * r;
      p.a.groundY = ctx.heightAt(p.a.x, p.a.z);
      p.b.x = p.cx - ax * r;
      p.b.z = p.cz - az * r;
      p.b.groundY = ctx.heightAt(p.b.x, p.b.z);
      return;
    }
    if (p.kind === 'dance') {
      // It has danced itself out.
      p.b.target = 0;
      return;
    }
    // Twins: they either both go, or one of them does and the other carries on.
    if (ctx.rand() < 0.5) {
      p.a.target = 0;
      p.b.target = 0;
    } else {
      (ctx.rand() < 0.5 ? p.a : p.b).target = 0;
    }
  }

  private release(p: DevilTwin): void {
    if (p.a.twin === p) p.a.twin = null;
    if (p.b.twin === p) p.b.twin = null;
    const i = this.pairs.indexOf(p);
    if (i >= 0) this.pairs.splice(i, 1);
  }

  // ------------------------------------------------------------ spawn ----

  /**
   * New devils form upwind of the view and ride in with the storm's wind —
   * they arrive with the weather, not out of a clear sky. The bearing fan is
   * wide and the spawn is nudged off any funnel already standing there, so a
   * new devil doesn't resolve as a collision before it is ever seen.
   */
  private spawnNear(ctx: FxContext): DustDevil {
    const R = ctx.rand;
    const windMag = Math.hypot(ctx.windX, ctx.windZ);
    // Upwind bearing (where the wind comes from), fanned out wide.
    const upwind = windMag > 0.5 ? Math.atan2(-ctx.windX, -ctx.windZ) : R() * Math.PI * 2;
    let bearing = upwind + (R() - 0.5) * (Math.PI / 1.2);
    // Devils arrive with the weather that fills the *viewed* area, so their
    // approach spread scales with the dust field, not with a fixed ring.
    const span = Math.max(1, dustField(ctx.viewRadius).half / 140);
    let x = ctx.camX;
    let z = ctx.camZ;
    for (let tries = 0; tries < 4; tries++) {
      const dist = (24 + R() * 78) * span;
      x = ctx.camX + Math.sin(bearing) * dist;
      z = ctx.camZ + Math.cos(bearing) * dist;
      const clear = this.devils.every(
        (d) => Math.hypot(d.x - x, d.z - z) > (d.baseR + 6) * CONTACT_REACH,
      );
      if (clear) break;
      bearing += (R() - 0.5) * 1.6;
    }
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
