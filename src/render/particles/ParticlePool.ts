/**
 * A true CPU particle pool: fixed-capacity, ring-buffer allocation, per-particle
 * velocity, drag, gravity, turbulence, ground collision, and size/alpha curves
 * over life.
 *
 * Deliberately framework-free (no three.js, no DOM): the sim stays authoritative
 * and GPU-free, and this pool is the presentation-side counterpart — it can be
 * unit-tested headlessly. `ParticlePoints` (three.js) is a thin adapter that
 * compacts the live particles into GPU buffers once per frame (one draw call).
 *
 * Spawning past capacity overwrites the oldest slot (a dust storm never fails
 * to spawn because the wind already used the budget — the oldest mote just
 * gets recycled). Randomness comes from an injected `Rand`, so tests can run
 * the pool deterministically while the game feeds it `Math.random`.
 */

/** Random source: `Math.random` in play, a seeded PRNG in tests. */
export type Rand = () => number;

/**
 * What a particle belongs to. Ambient wind/storm motes are wrapped into the
 * camera-following box every frame (they would otherwise blow hundreds of
 * units downwind and evacuate the viewed area); devil and trail particles
 * stay where the vortex / wheels put them.
 */
export const PKind = { Ambient: 0, Devil: 1, Trail: 2 } as const;
export type ParticleKind = (typeof PKind)[keyof typeof PKind];

export interface SpawnOptions {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds this particle lives. Must be > 0. */
  life: number;
  /** World-unit size at birth and at death (lerped across life). */
  size0: number;
  size1: number;
  /** Constant tint (linear-ish 0..1 RGB; dust barely shifts hue as it ages). */
  r: number;
  g: number;
  b: number;
  /** Peak opacity, before the fade envelope is applied. */
  alpha: number;
  /** Fraction of life spent fading in / out (0..1). Default 0.15 / 0.5. */
  fadeIn?: number;
  fadeOut?: number;
  /** Downward acceleration (world units/s²). Default 0. */
  gravity?: number;
  /** Velocity damping per second (0 = none). Default 0. */
  drag?: number;
  /** Curl-ish jitter amplitude. Default 0. */
  turbulence?: number;
  /** Floor the particle rests on (it lands, it doesn't fall through). */
  groundY?: number;
  /** What the particle belongs to (default `Ambient` — camera-box wrapped). */
  kind?: ParticleKind;
  /**
   * Centripetal anchor: each second the particle accelerates toward
   * (`pullX`, `pullZ`) by `pullK` × its distance from the anchor (a spring,
   * 1/s²). Zero (default) disables it. This is what bends the dust devil's
   * tangential throw into an orbit instead of a straight-line escape.
   */
  pullX?: number;
  pullZ?: number;
  pullK?: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (t: number): number => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

export class ParticlePool {
  /** Fixed capacity — the pool never allocates after construction. */
  readonly capacity: number;
  private readonly rand: Rand;

  // Structure-of-arrays storage. A slot is alive while life[i] > 0.
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly cr: Float32Array;
  private readonly cg: Float32Array;
  private readonly cb: Float32Array;
  private readonly peakA: Float32Array;
  private readonly fadeIn: Float32Array;
  private readonly fadeOut: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly turb: Float32Array;
  private readonly seed: Float32Array;
  private readonly groundY: Float32Array;
  private readonly kind: Uint8Array;
  private readonly pullX: Float32Array;
  private readonly pullZ: Float32Array;
  private readonly pullK: Float32Array;

  private cursor = 0;
  private count = 0;

  constructor(capacity = 6000, rand: Rand = Math.random) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.rand = rand;
    const n = this.capacity;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.cr = new Float32Array(n);
    this.cg = new Float32Array(n);
    this.cb = new Float32Array(n);
    this.peakA = new Float32Array(n);
    this.fadeIn = new Float32Array(n);
    this.fadeOut = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.turb = new Float32Array(n);
    this.seed = new Float32Array(n);
    this.groundY = new Float32Array(n);
    this.groundY.fill(-Infinity);
    this.kind = new Uint8Array(n);
    this.pullX = new Float32Array(n);
    this.pullZ = new Float32Array(n);
    this.pullK = new Float32Array(n);
  }

  /** Live particle count. */
  get alive(): number {
    return this.count;
  }

  /** Write one particle into the next ring slot (recycling the oldest). */
  spawn(o: SpawnOptions): void {
    if (!(o.life > 0)) return;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.life[i] <= 0) this.count++;

    this.px[i] = o.x;
    this.py[i] = o.y;
    this.pz[i] = o.z;
    this.vx[i] = o.vx;
    this.vy[i] = o.vy;
    this.vz[i] = o.vz;
    this.age[i] = 0;
    this.life[i] = o.life;
    this.size0[i] = o.size0;
    this.size1[i] = o.size1;
    this.cr[i] = o.r;
    this.cg[i] = o.g;
    this.cb[i] = o.b;
    this.peakA[i] = Math.max(0, o.alpha);
    this.fadeIn[i] = clamp01(o.fadeIn ?? 0.15);
    this.fadeOut[i] = clamp01(o.fadeOut ?? 0.5);
    this.grav[i] = o.gravity ?? 0;
    this.drag[i] = Math.max(0, o.drag ?? 0);
    this.turb[i] = Math.max(0, o.turbulence ?? 0);
    this.seed[i] = this.rand();
    this.groundY[i] = o.groundY ?? -Infinity;
    this.kind[i] = o.kind ?? PKind.Ambient;
    this.pullX[i] = o.pullX ?? 0;
    this.pullZ[i] = o.pullZ ?? 0;
    this.pullK[i] = Math.max(0, o.pullK ?? 0);
  }

  /**
   * Integrate every live particle by `dt` sim seconds. `time` is absolute sim
   * time (it freezes on pause, so the turbulence field freezes with it).
   */
  update(dt: number, time: number): void {
    if (!(dt > 0)) return;
    const n = this.capacity;
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0) continue;
      const age = this.age[i] + dt;
      if (age >= this.life[i]) {
        this.life[i] = 0;
        this.count--;
        continue;
      }
      this.age[i] = age;

      let vx = this.vx[i];
      let vy = this.vy[i];
      let vz = this.vz[i];

      const dr = this.drag[i];
      if (dr > 0) {
        const k = Math.max(0, 1 - dr * dt);
        vx *= k;
        vy *= k;
        vz *= k;
      }
      vy -= this.grav[i] * dt;

      const pk = this.pullK[i];
      if (pk > 0) {
        vx += (this.pullX[i] - this.px[i]) * pk * dt;
        vz += (this.pullZ[i] - this.pz[i]) * pk * dt;
      }

      const tb = this.turb[i];
      if (tb > 0) {
        const s = this.seed[i];
        const px = this.px[i];
        const py = this.py[i];
        vx += Math.sin(time * 1.7 + s * 6.2832 + py * 0.35) * tb * dt;
        vy += Math.sin(time * 1.31 + s * 4.1888) * tb * 0.45 * dt;
        vz += Math.cos(time * 1.53 + s * 5.236 + px * 0.35) * tb * dt;
      }

      const x = this.px[i] + vx * dt;
      let y = this.py[i] + vy * dt;
      let z = this.pz[i] + vz * dt;

      // Settle on the ground instead of sinking through it.
      const g = this.groundY[i];
      if (y < g) {
        y = g;
        if (vy < 0) vy = -vy * 0.08;
        vx *= 1 - Math.min(0.9, 2.5 * dt);
        vz *= 1 - Math.min(0.9, 2.5 * dt);
      }

      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
    }
  }

  /**
   * Toroidally wrap every live *ambient* particle into the square box around
   * (`cx`, `cz`) with the given half-extent. Storm grit at 50+ m/s would
   * otherwise travel hundreds of units downwind in one life and leave the
   * viewed area empty; wrapping keeps the box uniformly populated while the
   * fade envelope hides births and deaths. Devil and trail particles are
   * anchored to the vortex / wheels and are never wrapped.
   */
  wrapAmbient(cx: number, cz: number, half: number): void {
    const size = Math.max(1, half * 2);
    const n = this.capacity;
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0 || this.kind[i] !== PKind.Ambient) continue;
      const dx = this.px[i] - cx + half;
      const dz = this.pz[i] - cz + half;
      this.px[i] = cx - half + ((((dx % size) + size) % size));
      this.pz[i] = cz - half + ((((dz % size) + size) % size));
    }
  }

  /**
   * Compact every live particle into render arrays (position xyz, colour rgb,
   * world size, envelope alpha). Each array must hold `capacity` entries.
   * Returns the live count; the renderer draws `[0, count)`.
   */
  writeRender(
    pos: Float32Array,
    col: Float32Array,
    size: Float32Array,
    alpha: Float32Array,
  ): number {
    let w = 0;
    const n = this.capacity;
    for (let i = 0; i < n; i++) {
      const lf = this.life[i];
      if (lf <= 0) continue;
      const t = clamp01(this.age[i] / lf);
      const fi = this.fadeIn[i];
      const fo = this.fadeOut[i];
      const aIn = fi > 0 ? sstep(t / fi) : 1;
      const aOut = fo > 0 ? 1 - sstep((t - (1 - fo)) / fo) : 1;
      pos[w * 3] = this.px[i];
      pos[w * 3 + 1] = this.py[i];
      pos[w * 3 + 2] = this.pz[i];
      col[w * 3] = this.cr[i];
      col[w * 3 + 1] = this.cg[i];
      col[w * 3 + 2] = this.cb[i];
      size[w] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      alpha[w] = this.peakA[i] * aIn * aOut;
      w++;
    }
    return w;
  }

  /** Test helper: mean velocity of the live set (wind-alignment checks). */
  meanVelocity(out: { x: number; y: number; z: number }): number {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let k = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      sx += this.vx[i];
      sy += this.vy[i];
      sz += this.vz[i];
      k++;
    }
    out.x = k ? sx / k : 0;
    out.y = k ? sy / k : 0;
    out.z = k ? sz / k : 0;
    return k;
  }

  clear(): void {
    this.life.fill(0);
    this.count = 0;
    this.cursor = 0;
  }
}
