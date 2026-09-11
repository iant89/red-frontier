/**
 * Playable terrain is a 1280 m window of real Mars.
 *
 * A seed picks a landable site on the globe (Amazonis, Arabia, Gale, …).
 * The *landscaping* starts from a compact MOLA-derived global relief prior:
 * the landing site's regional tilt and neighbouring topography steer a
 * several-kilometre window into playable scale. A seeded landform layer adds
 * broad, driveable hills where the coarse global DEM cannot resolve local
 * relief. On top of that sits HiRISE-scale local geology: round craters of
 * mixed age, a little grit, rocks on rims — not a single noise field, and not
 * star-shaped ejecta.
 */

import { Noise2D } from '../lib/noise';
import { mulberry32, hash2, clamp, lerp, smoothstep, norm } from '../lib/rng';
import { WORLD_HALF, SPAWN_RADIUS } from './config';
import { pickLandingSite, pickLandingSiteInRegion, worldToLatLon, marsElevationKm } from './marsGlobe';
import type { LandingSite } from './marsGlobe';

export type { LandingSite };

export const MAT = {
  dust: 0,
  sand: 1,
  bedrock: 2,
  layered: 3,
  basalt: 4,
  pale: 5,
} as const;

export type RegionId = 'plains' | 'rocky' | 'highlands' | 'basin' | 'rugged';

export interface SurfaceSample {
  height: number;
  mat: [number, number, number, number, number, number];
  rockiness: number;
  region: RegionId;
  crater: number;
  craterAge: number;
  steep: number;
}

export interface ScatterRock {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rotY: number;
  rotX: number;
  kind: 0 | 1 | 2;
  shade: number;
}

interface Crater {
  x: number;
  z: number;
  radius: number;
  depth: number;
  rimHeight: number;
  age: number;
  ellipticity: number;
  rotation: number;
  ejecta: number;
  centralPeak: number;
  rimJitter: number;
  notchAng: number;
  notchWidth: number;
  terrace: boolean;
  datum: number;
  reach: number;
}

/** A broad, low-gradient landform. Hills are separate from craters so the
 * playable map has real rolling relief instead of only impact holes. */
interface Hill {
  x: number;
  z: number;
  radius: number;
  height: number;
  stretch: number;
  rotation: number;
}

const PAD_INNER = SPAWN_RADIUS;
const PAD_OUTER = SPAWN_RADIUS + 48;

export interface TerrainOptions {
  /** Force the landing site into this named region (globe picker). */
  region?: string | null;
  /** Half-extent of the playable square, in metres. */
  worldHalf?: number;
}

export class MartianTerrain {
  readonly seed: number;
  readonly site: LandingSite;
  readonly craters: Crater[] = [];
  readonly hills: Hill[] = [];
  readonly rocks: ScatterRock[] = [];
  readonly worldHalf: number;

  private noise: Noise2D;
  private n2: Noise2D;
  private rng: () => number;
  private padDatum = 0;
  /** MOLA window compression: how many real km fit across the play window. */
  private mesoK: number;
  /** Vertical amplification applied to the compressed areoid. */
  private mesoAmp: number;
  /** Areoid value at the window centre (meso heights are relative to it). */
  private mesoDatum = 0;

  constructor(seed: number, opts: TerrainOptions = {}) {
    this.seed = seed >>> 0;
    this.worldHalf = opts.worldHalf ?? WORLD_HALF;
    this.noise = new Noise2D(this.seed);
    this.n2 = new Noise2D(this.seed ^ 0x51ed2e3);
    this.rng = mulberry32(this.seed ^ 0x9e3779b9);
    this.site =
      opts.region != null && opts.region !== ''
        ? pickLandingSiteInRegion(this.seed, opts.region)
        : pickLandingSite(this.seed);
    // The MOLA window: compress a seeded 3–7 km stretch of the real areoid
    // into the play square so the planet's own topography does the
    // landscaping. The vertical gain is then calibrated so the steepest
    // resulting grade stays inside the driving/building slope budget.
    this.mesoK = 3 + this.rand() * 4;
    this.mesoDatum = marsElevationKm(this.site.lat, this.site.lon);
    this.mesoAmp = this.calibrateMesoAmp();
    this.generate();
  }

  /**
   * Measure the compressed areoid's worst grade across the window and pick
   * the largest amplification that keeps it playable (broad ramps, never
   * cliffs). Deterministic — it only ever samples the seeded globe.
   */
  private calibrateMesoAmp(): number {
    const e = this.worldHalf / 9;
    let maxSlope = 0;
    const kmAt = (x: number, z: number): number => {
      const { lat, lon } = worldToLatLon(this.site, x * this.mesoK, z * this.mesoK);
      return marsElevationKm(lat, lon) - this.mesoDatum;
    };
    for (let gx = -1; gx <= 1; gx++) {
      for (let gz = -1; gz <= 1; gz++) {
        const x = gx * e * 2.6;
        const z = gz * e * 2.6;
        const dx = (kmAt(x + e, z) - kmAt(x - e, z)) * 1000;
        const dz = (kmAt(x, z + e) - kmAt(x, z - e)) * 1000;
        // Elevation change over window distance — the rendered grade at amp 1.
        maxSlope = Math.max(maxSlope, Math.hypot(dx, dz) / (2 * e));
      }
    }
    if (maxSlope <= 0.0001) return 1.6; // dead flat areoid — give it sculpting room
    // Largest gain that keeps the steepest grade under the ~0.11 drive budget,
    // capped so even a steep highlands window stays a landscape, not a cliff.
    return clamp(0.11 / maxSlope, 0.2, 1.6);
  }

  heightAt(x: number, z: number): number {
    return this.sample(x, z).height;
  }

  sample(x: number, z: number): SurfaceSample {
    let h = this.macroElevation(x, z);
    const crater = this.applyCraters(x, z, h);
    h = crater.h;
    h += this.microCraters(x, z);
    h += this.fineDetail(x, z);

    const r = Math.hypot(x, z);
    const world = smoothstep(norm(r, PAD_INNER, PAD_OUTER));
    h = lerp(0, h - this.padDatum, world * world);

    const mat = this.materials(x, z, crater, world);
    const region = this.regionOf();
    const rockiness = clamp(
      (this.site.rockiness + 0.55 * crater.rim + 0.25 * crater.steep) * world,
      0,
      1,
    );

    return {
      height: h,
      mat,
      rockiness,
      region,
      crater: clamp(crater.influence, 0, 1),
      craterAge: crater.age,
      steep: clamp(crater.steep + this.regionalSteep(), 0, 1),
    };
  }

  private generate(): void {
    this.placeHills();
    this.placeCraters();
    this.captureCraterDatums();
    this.padDatum = this.macroElevation(0, 0);
    this.scatterRocks();
  }

  /**
   * Lay down a handful of broad, seeded landforms. The MOLA approximation is
   * intentionally gentle at this scale: it often reads as regional tilt, not
   * as a hill. These landforms supply the missing visual relief while keeping
   * their gradients below the rover/building limits.
   *
   * A separate random stream keeps adding hills from changing crater layouts,
   * deposits, or save compatibility for an existing seed. The pad is still
   * flattened by the pad blend in sample(), so a hill may safely roll past it.
   */
  private placeHills(): void {
    const hillRng = mulberry32(this.seed ^ 0x48_49_4c_53);
    const rand = (a: number, b: number): number => a + hillRng() * (b - a);
    const count = 5 + Math.floor(hillRng() * 3);

    for (let i = 0; i < count; i++) {
      const angle = rand(0, Math.PI * 2);
      const distance = rand(150, this.worldHalf * 0.78);
      const radius = rand(180, 300);
      const positive = i === 0 || hillRng() > 0.34;
      this.hills.push({
        x: Math.cos(angle) * distance,
        z: Math.sin(angle) * distance,
        radius,
        // Positive mounds dominate, with a few shallow swales to keep the
        // horizon from becoming a row of identical bumps.
        height: (positive ? 1 : -1) * rand(11, 21),
        stretch: rand(0.78, 1.45),
        rotation: rand(0, Math.PI),
      });
    }
  }

  /** Height contributed by the broad hill / swale layer. */
  private hillElevation(x: number, z: number): number {
    let h = 0;
    for (const hill of this.hills) {
      const dx = x - hill.x;
      const dz = z - hill.z;
      const c = Math.cos(hill.rotation);
      const s = Math.sin(hill.rotation);
      const along = dx * c + dz * s;
      const across = (-dx * s + dz * c) / hill.stretch;
      const q = Math.hypot(along, across) / hill.radius;
      if (q > 2.2) continue;
      // Gaussian shoulders make the landform merge into the surrounding
      // areoid without the sharp edge a clipped cone would introduce.
      h += hill.height * Math.exp(-1.55 * q * q);
    }
    return h;
  }

  private rand(a = 0, b = 1): number {
    return a + this.rng() * (b - a);
  }

  private awayFromSpawn(x: number, z: number, extra = 0): boolean {
    return Math.hypot(x, z) > 90 + extra;
  }

  /**
   * The MOLA field doing the landscaping. The window compresses a several-km
   * stretch of the real areoid (hills, swales, the regional tilt of the
   * landing site itself) and amplifies it to visible relief — so where the
   * ground rises and falls is where Mars says it does, not where one noise
   * octave happens to.
   */
  private mesoElevation(x: number, z: number): number {
    const { lat, lon } = worldToLatLon(this.site, x * this.mesoK, z * this.mesoK);
    const hKm = marsElevationKm(lat, lon);
    return (hKm - this.mesoDatum) * 1000 * this.mesoAmp;
  }

  /** Meso height relative to the site centre — drives material weighting. */
  private mesoRelative(x: number, z: number): number {
    return this.mesoElevation(x, z) - this.mesoElevation(0, 0);
  }

  /**
   * Areoid across the 1280 m window, in metres relative to the site centre:
   * the compressed MOLA landscape plus a couple of metres of rolling ground —
   * not a second mountain range.
   */
  private macroElevation(x: number, z: number): number {
    const { lat, lon } = worldToLatLon(this.site, x, z);
    const hKm = marsElevationKm(lat, lon);
    const regional = (hKm - this.site.elevKm) * 1000;
    const roll =
      this.noise.fbm(x * 0.004 + 3.1, z * 0.004 - 1.7, 3, 2.0, 0.5) * 1.6 * (0.4 + this.site.rockiness);
    return regional + this.hillElevation(x, z) + roll + this.mesoElevation(x, z);
  }

  private regionalSteep(): number {
    return clamp(Math.hypot(this.site.dEdx, this.site.dEdz) * 4, 0, 0.45);
  }

  private regionOf(): RegionId {
    switch (this.site.biome) {
      case 'highlands':
        return 'highlands';
      case 'basin':
        return 'basin';
      case 'volcanic':
        return 'rocky';
      case 'canyon':
        return 'rugged';
      case 'crater':
        return 'basin';
      default:
        return 'plains';
    }
  }

  private placeCraters(): void {
    const dens = this.site.craterDensity;
    const tryPlace = (radius: number, ageBias: number, tries: number): void => {
      for (let t = 0; t < tries; t++) {
        const ang = this.rand(0, Math.PI * 2);
        const dist = this.rand(70 + radius, this.worldHalf - radius * 0.5);
        const x = Math.cos(ang) * dist;
        const z = Math.sin(ang) * dist;
        if (!this.awayFromSpawn(x, z, radius * 0.2)) continue;
        let ok = true;
        for (const c of this.craters) {
          if (Math.hypot(c.x - x, c.z - z) < Math.min(c.radius, radius) * 0.55) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const age = clamp(ageBias + this.rand(-0.2, 0.2), 0.04, 0.96);
        this.craters.push(this.makeCrater(x, z, radius, age));
        return;
      }
    };

    // A couple of modest bowls can sit in the window — HiRISE scale, not basins.
    const large = dens > 0.4 ? 2 : 1;
    for (let i = 0; i < large; i++) {
      if (this.rng() < 0.7 + 0.25 * dens) tryPlace(this.rand(42, 88), dens > 0.5 ? 0.62 : 0.4, 32);
    }
    const medium = Math.round(8 + dens * 16);
    for (let i = 0; i < medium; i++) tryPlace(this.rand(12, 28), this.rand(0.15, 0.8), 18);
    const small = Math.round(22 + dens * 40);
    for (let i = 0; i < small; i++) tryPlace(this.rand(5, 12), this.rand(0.05, 0.75), 14);

    this.craters.sort((a, b) => b.age - a.age);
  }

  private makeCrater(x: number, z: number, radius: number, age: number): Crater {
    return {
      x,
      z,
      radius,
      depth: radius * this.rand(0.12, 0.2) * (1.05 - 0.4 * age),
      rimHeight: radius * this.rand(0.03, 0.055) * (1.05 - 0.45 * age),
      age,
      // Real simple craters are nearly circular. Tiny ellipticity only.
      ellipticity: this.rand(0.008, 0.045),
      rotation: this.rand(0, Math.PI),
      ejecta: this.rand(0.5, 0.9),
      centralPeak: radius > 50 && this.rng() > 0.65 ? radius * this.rand(0.03, 0.06) : 0,
      rimJitter: this.rand(0.012, 0.035),
      notchAng: this.rand(0, Math.PI * 2),
      notchWidth: age > 0.7 ? this.rand(0.15, 0.4) : 0,
      terrace: radius > 60,
      datum: 0,
      reach: radius * (1.15 + this.rand(0.4, 0.7)),
    };
  }

  private captureCraterDatums(): void {
    const older: Crater[] = [];
    for (const c of this.craters) {
      let h = this.macroElevation(c.x, c.z);
      h = this.applyCratersFrom(c.x, c.z, h, older).h;
      c.datum = h;
      older.push(c);
    }
  }

  private applyCraters(
    x: number,
    z: number,
    h: number,
  ): { h: number; influence: number; age: number; rim: number; steep: number } {
    return this.applyCratersFrom(x, z, h, this.craters);
  }

  private applyCratersFrom(
    x: number,
    z: number,
    h: number,
    list: Crater[],
  ): { h: number; influence: number; age: number; rim: number; steep: number } {
    let influence = 0;
    let age = 0;
    let rim = 0;
    let steep = 0;
    for (const c of list) {
      if (Math.abs(x - c.x) > c.reach || Math.abs(z - c.z) > c.reach) continue;
      const dx = x - c.x;
      const dz = z - c.z;
      const ang = Math.atan2(dz, dx) - c.rotation;
      const ell = 1 + c.ellipticity * Math.cos(2 * ang);
      const jitter = 1 + c.rimJitter * this.n2.sample(Math.cos(ang) * 1.4 + c.x * 0.01, Math.sin(ang) * 1.4);
      const R = c.radius * ell * jitter;
      const d = Math.hypot(dx, dz);
      const n = d / Math.max(1e-4, R);
      if (n > 1 + c.ejecta) continue;

      const floorR = 0.32 + 0.28 * c.age;
      const depth = c.depth * (1 - 0.65 * c.age);
      let rimH = c.rimHeight * (1 - 0.5 * c.age);
      if (c.notchWidth > 0) {
        let da = ang - c.notchAng;
        da = ((da + Math.PI) % (Math.PI * 2)) - Math.PI;
        if (Math.abs(da) < c.notchWidth) {
          const k = 1 - Math.abs(da) / c.notchWidth;
          rimH *= 1 - k * 0.45 * c.age;
        }
      }

      if (n <= 1) {
        let dh: number;
        if (n < floorR) {
          dh = -depth;
          if (c.centralPeak > 0) {
            const pr = n / (floorR * 0.45);
            if (pr < 1) dh += c.centralPeak * (1 - pr) * (1 - pr);
          }
          if (c.terrace && n > floorR * 0.55) dh += depth * 0.1;
        } else {
          const t = (n - floorR) / (1 - floorR);
          const s = t * t * (3 - 2 * t);
          dh = -depth + (depth + rimH) * Math.pow(s, 1.05 + 0.5 * (1 - c.age));
        }
        h = lerp(h, c.datum + dh, 1);
        influence = Math.max(influence, 1 - n * 0.5);
        age = c.age;
        if (n > 0.72) {
          rim = Math.max(rim, 1 - Math.abs(n - 0.92) * 5);
          steep = Math.max(steep, (1 - c.age * 0.45) * Math.max(0, 1 - Math.abs(n - 0.9) * 4));
        }
      } else {
        const t = (n - 1) / c.ejecta;
        const w = (1 - t) * (1 - t);
        h += rimH * 0.28 * w;
        influence = Math.max(influence, 0.28 * w);
        if (t < 0.2) rim = Math.max(rim, 0.3 * (1 - t * 5));
      }
    }
    return { h, influence, age, rim, steep };
  }

  private microCraters(x: number, z: number): number {
    if (Math.hypot(x, z) < 70) return 0;
    const dens = this.site.craterDensity;
    let acc = 0;
    for (const cell of [9, 19]) {
      const ix = Math.floor(x / cell);
      const iz = Math.floor(z / cell);
      const hsh = hash2(ix, iz, this.seed ^ (cell * 13));
      const thresh = cell < 12 ? 0.22 * dens : 0.14 * dens;
      if (hsh > thresh) continue;
      const cx = (ix + 0.25 + hash2(ix, iz, this.seed + 3) * 0.5) * cell;
      const cz = (iz + 0.25 + hash2(ix + 9, iz, this.seed + 5) * 0.5) * cell;
      const R = (cell < 12 ? 1.6 : 3.1) * (0.75 + hsh);
      const d = Math.hypot(x - cx, z - cz);
      const n = d / R;
      if (n >= 1.3) continue;
      const age = hash2(ix, iz, this.seed + 11);
      const depth = R * (0.2 - 0.1 * age);
      const rim = R * 0.05 * (1 - 0.5 * age);
      if (n < 1) acc += lerp(-depth, rim, n * n);
      else {
        const t = (n - 1) / 0.3;
        acc += rim * 0.25 * (1 - t) * (1 - t);
      }
    }
    return acc;
  }

  private fineDetail(x: number, z: number): number {
    const a = this.noise.sample(x * 0.12 + 51, z * 0.12 - 23) * 0.18;
    const b = this.n2.sample(x * 0.4, z * 0.4) * 0.05;
    const ripples =
      Math.sin(x * 0.38 + this.n2.sample(x * 0.02, z * 0.02) * 3) * 0.06 * this.site.dust;
    return a + b + ripples;
  }

  private materials(
    x: number,
    z: number,
    crater: { influence: number; age: number; rim: number; steep: number },
    world: number,
  ): [number, number, number, number, number, number] {
    const steep = crater.steep;
    // MOLA relief steers the drift: dust ponds in the lows, highs get winnowed
    // down to sand and bedrock.
    const rel = clamp(this.mesoRelative(x, z) / Math.max(4, this.mesoAmp * 3), -1, 1);
    const dust =
      this.site.dust * (0.8 - steep * 0.5 - rel * 0.22) + crater.influence * crater.age * 0.25;
    const sand = (1 - this.site.basalt) * 0.25 * (1 - steep) + crater.influence * (1 - crater.age) * 0.3;
    const bedrock = steep * 0.85 + crater.rim * 0.85 + this.site.rockiness * 0.35;
    const layered = crater.steep * 0.2 * (this.site.biome === 'highlands' ? 1 : 0.3);
    const basalt = this.site.basalt * 0.8 + crater.rim * 0.15 * (1 - crater.age);
    const pale = (this.site.biome === 'basin' ? 0.65 : 0.12) + crater.influence * crater.age * 0.4;

    const w = [dust, sand, bedrock, layered, basalt, pale];
    if (world < 0.999) {
      w[0] += (1 - world) * 1.4;
      w[1] += (1 - world) * 0.3;
    }
    let s = 0;
    for (let i = 0; i < 6; i++) {
      w[i] = Math.max(0, w[i]);
      s += w[i];
    }
    if (s < 1e-6) {
      w[0] = 1;
      s = 1;
    }
    for (let i = 0; i < 6; i++) w[i] /= s;
    return w as [number, number, number, number, number, number];
  }

  private scatterRocks(): void {
    const rocks: ScatterRock[] = [];
    const push = (
      x: number,
      z: number,
      kind: 0 | 1 | 2,
      scale: number,
      shade: number,
      yOpt?: number,
    ): void => {
      if (Math.hypot(x, z) < SPAWN_RADIUS + 10) return;
      if (Math.abs(x) > this.worldHalf - 8 || Math.abs(z) > this.worldHalf - 8) return;
      const y = yOpt ?? this.heightAt(x, z);
      rocks.push({
        x,
        y,
        z,
        sx: scale * this.rand(0.7, 1.35),
        sy: scale * this.rand(kind === 1 ? 0.25 : 0.55, kind === 1 ? 0.55 : 1.15),
        sz: scale * this.rand(0.7, 1.3),
        rotY: this.rand(0, Math.PI * 2),
        rotX: this.rand(-0.25, 0.25),
        kind,
        shade,
      });
    };

    for (const c of this.craters) {
      const n = Math.round(4 + c.radius * (0.28 + 0.35 * (1 - c.age)));
      for (let i = 0; i < n; i++) {
        const ang = this.rand(0, Math.PI * 2);
        const rad = c.radius * this.rand(0.84, 1.14);
        const kind: 0 | 1 | 2 = this.rng() > 0.7 ? 1 : this.rng() > 0.4 ? 0 : 2;
        push(
          c.x + Math.cos(ang) * rad,
          c.z + Math.sin(ang) * rad,
          kind,
          kind === 0 ? this.rand(0.9, 2.2) : this.rand(0.4, 1.4),
          this.rand(0.35, 0.7),
        );
      }
    }

    const step = 24;
    const half = this.worldHalf;
    for (let x = -half + 16; x < half - 16; x += step) {
      for (let z = -half + 16; z < half - 16; z += step) {
        const jx = x + (hash2(x | 0, z | 0, this.seed) - 0.5) * step;
        const jz = z + (hash2((x | 0) + 19, z | 0, this.seed ^ 7) - 0.5) * step;
        const s = this.sample(jx, jz);
        const p = hash2(jx | 0, jz | 0, this.seed ^ 0x111);
        if (p > s.rockiness * 0.5) continue;
        const kind: 0 | 1 | 2 = s.steep > 0.5 ? (p > 0.3 ? 0 : 1) : 2;
        push(
          jx,
          jz,
          kind,
          kind === 0 ? this.rand(0.8, 1.9) : this.rand(0.3, 1.0),
          0.3 + s.steep * 0.4,
          s.height,
        );
      }
    }
    this.rocks.push(...rocks);
  }
}
