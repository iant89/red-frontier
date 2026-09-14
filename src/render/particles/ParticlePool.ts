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

/**
 * The turbulence field: a divergence-free cellular flow (Taylor–Green style —
 * `u = sin(a)cos(b)`, `w = −cos(a)sin(b)`), evaluated through the `sin(a±b)`
 * product identity so the whole 3-component field costs two sines per
 * particle — cheaper than the per-mote random jitter it replaced.
 *
 * The field is *coherent*: its phase comes from world position, so
 * neighbouring motes turn together and the air reads as flowing rather than
 * shimmering. Each mote's seed nudges its phase a little (`CURL_SCAT`), so
 * two motes inside the same roll still take visibly different paths, and the
 * temporal phases (`CURL_F*`) make the rolls breathe and travel.
 */
const CURL_K = 0.04; // ≈157 m rolls
const CURL_SCAT = 0.3; // per-mote phase scatter (turns of a radian)
const CURL_F1 = 0.37; // pattern drift rates (rad/s)
const CURL_F2 = 0.29;
/** Vertical share of the roll — dust lifts on one face, settles on the other. */
const CURL_LIFT = 0.35;

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
  /**
   * Rim feather for the camera-following ambient field (see `setFalloff`).
   * `fallR1 <= 0` disables it; `fallK` is the inner radius as a fraction of it.
   */
  private fallCX = 0;
  private fallCZ = 0;
  private fallK = 0;
  private fallR1 = -1;

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
    // The flow field's temporal phases depend only on sim time: hoist them out
    // of the particle loop (and freeze with it, on pause).
    const tp1 = time * CURL_F1;
    const tp2 = time * CURL_F2;
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
        const s = this.seed[i] * 6.2832;
        const a = this.px[i] * CURL_K + tp1 + s * CURL_SCAT;
        const b = this.pz[i] * CURL_K + tp2 - s * CURL_SCAT * 0.7;
        // sin(a)cos(b) = ½(sin(a+b) + sin(a−b)); −cos(a)sin(b) = ½(sin(a−b) − sin(a+b)).
        const p = Math.sin(a + b);
        const q = Math.sin(a - b);
        vx += (p + q) * 0.5 * tb * dt;
        vz += (q - p) * 0.5 * tb * dt;
        vy += (p - q) * (CURL_LIFT * tb) * dt;
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
   * Feather the ambient field's rim so the emission box has no visible edge:
   * ambient particles fade from full alpha at `r0` out to nothing at `r1`
   * (world units from (`cx`, `cz`)). The falloff is a p=4 superellipse, which
   * hugs the square `wrapAmbient` box while rounding its corners off — a disc
   * would leave the box's four corners populated but invisible.
   *
   * Devil and trail dust is never feathered: it belongs to its vortex or its
   * wheels, not to the camera-following field. `r1 <= r0` disables it.
   */
  setFalloff(cx: number, cz: number, r0: number, r1: number): void {
    if (!(r1 > r0)) {
      this.fallR1 = -1;
      return;
    }
    this.fallCX = cx;
    this.fallCZ = cz;
    // Stored in distance⁴ space (the superellipse's own power), so the render
    // loop needs no roots at all — just two multiplies and a compare.
    const k = clamp01(r0 / r1);
    this.fallK = k * k * k * k;
    this.fallR1 = r1;
  }

  /** Test/debug helper: the feather this pool currently applies. */
  falloff(): { cx: number; cz: number; r0: number; r1: number } {
    if (this.fallR1 < 0) return { cx: this.fallCX, cz: this.fallCZ, r0: -1, r1: -1 };
    const k = Math.sqrt(Math.sqrt(this.fallK));
    return { cx: this.fallCX, cz: this.fallCZ, r0: k * this.fallR1, r1: this.fallR1 };
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
      let a = this.peakA[i] * aIn * aOut;
      if (this.fallR1 > 0 && this.kind[i] === PKind.Ambient) {
        const dx = (this.px[i] - this.fallCX) / this.fallR1;
        const dz = (this.pz[i] - this.fallCZ) / this.fallR1;
        const ax = dx * dx;
        const az = dz * dz;
        const m = ax * ax + az * az; // (r/r1)⁴ on the p=4 superellipse
        if (m >= 1) a = 0;
        else if (m > this.fallK) a *= 1 - sstep((m - this.fallK) / (1 - this.fallK));
      }
      alpha[w] = a;
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
