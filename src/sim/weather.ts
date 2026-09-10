/**
 * Mars weather: wind, airborne dust, and the storms that come with them.
 *
 * GDD §7 / TDD §11. Weather is the dependency chain's *root* — dust dims the
 * sun, dust buries the panels, wind batters the hardware, and every downstream
 * system (power, life support, logistics) feels it. The GDD's canonical
 * cascading failure is exactly this: storm → solar drops → batteries drain →
 * pumps stop → greenhouse stalls → food declines.
 *
 * Design rules, taken from the rest of the sim:
 *
 * - **Storms are places, not moods.** Weather works the way it does on Earth:
 *   a storm is a circular weather *system* with a footprint on the planet that
 *   forms, travels, and dies. The colony sits at one point; it reads the wind,
 *   dust and sky of whatever system is overhead right now. A storm therefore
 *   *arrives* (the leading edge crosses the site), *passes over* (the site sits
 *   under the footprint), and *moves on* — and its winds blow along its track,
 *   with dust devils spinning up inside the system.
 * - **Deterministic.** One seeded PRNG stream (part of the save), noise sampled
 *   from absolute sim time, and a storm *envelope* that is a pure function of
 *   elapsed storm time. No per-particle randomness, no wall clock. Two runs
 *   with the same seed live through the same weather.
 * - **Scheduled, not simulated.** TDD §11 asks for regional state updated at
 *   1–5 min intervals and interpolated between — not per-grain fluid dynamics.
 *   A scheduler rolls the dice on a fixed cadence; a storm is then a scripted
 *   ramp-hold-decay envelope with a forecast lead time, riding on a moving cell.
 * - **Readable.** Four storm classes straight off the GDD §7 table, each with
 *   a distinct signature: dust devils are short tactical surprises, regional
 *   storms are forecastable grid crises, severe storms damage hardware, and a
 *   planetary dust event is the campaign-level nightmare.
 */

import {
  WEATHER_CALM_SOLS,
  WEATHER_ROLL_INTERVAL_S,
  WEATHER_STORM_COOLDOWN_S,
  STORM_CHANCES,
  STORM_UNLOCK_SOL,
  STORM_WARN_LEAD_S,
  STORM_CELL_GEOM,
  SOL_SECONDS,
} from './config';
import { clamp, lerp, smoothstep } from '../lib/rng';
import { Noise2D } from '../lib/noise';

export type StormKind = 'calm' | 'devil' | 'regional' | 'severe' | 'planetary';

/** One scheduled or in-progress storm event. */
export type StormKindReal = Exclude<StormKind, 'calm'>;

/**
 * One travelling storm system. Positions are kilometres relative to the colony
 * site (x east, z north); the colony sits at the origin. The cell moves along
 * `heading` at `speedKmS` — the weather the colony experiences is whatever its
 * footprint covers.
 */
export interface StormCell {
  kind: StormKindReal;
  /** Centre position relative to the colony, km. */
  x: number;
  z: number;
  /** Compass bearing the system travels (atan2(x, z), the sim's convention). */
  heading: number;
  /** Travel speed, km per game second. */
  speedKmS: number;
  /** Footprint radius, km. */
  radiusKm: number;
  /** Sim time the winds arrive at the site (leading edge reaches the colony). */
  startAt: number;
  /** Sim time the storm has fully passed. */
  endAt: number;
  /** Peak storm intensity, 0..1. */
  peak: number;
  /** Fraction of the storm spent ramping up (and, mirrored, down). */
  rampFrac: number;
  /** Peak airborne dust contribution, 0..1. */
  dustPeak: number;
  /** Peak wind speed in m/s. */
  windPeak: number;
  /** Whether the forecast has been announced in the log yet. */
  announced: boolean;
  /** Per-cell noise phase so two storms never gust in lockstep. */
  phase: number;
}

/** Legacy (v≤6) storm shape — a pure time envelope with no geography. */
interface LegacyStormEvent {
  kind: StormKindReal;
  startAt: number;
  endAt: number;
  peak: number;
  rampFrac: number;
  dustPeak: number;
  windPeak: number;
  announced: boolean;
}

export interface WeatherReading {
  windSpeed: number;
  windDirRad: number;
  /** Airborne dust density, 0..1 — drives transmission, visibility and dirt. */
  dust: number;
  /** 0..1, how far you can see (storm haze closes the world in). */
  visibility: number;
  storm: StormKind;
  /** Current storm intensity 0..1 (0 when calm). */
  stormIntensity: number;
  /** Fraction of peak irradiance getting through the ambient dust. */
  solarTransmission: number;
}

/** Per-class storm parameters, keyed off the GDD §7 severity table. */
const STORM_PROFILE: Record<
  Exclude<StormKind, 'calm'>,
  {
    label: string;
    durMin: number;
    durMax: number;
    peakMin: number;
    peakMax: number;
    dust: number;
    windMin: number;
    windMax: number;
    warnLead: number;
  }
> = {
  devil: {
    label: 'Dust devil',
    durMin: 70,
    durMax: 130,
    peakMin: 0.5,
    peakMax: 0.68,
    dust: 0.3,
    windMin: 30,
    windMax: 45,
    warnLead: 10,
  },
  regional: {
    label: 'Regional dust storm',
    durMin: 220,
    durMax: 330,
    peakMin: 0.65,
    peakMax: 0.8,
    dust: 0.62,
    windMin: 28,
    windMax: 40,
    warnLead: STORM_WARN_LEAD_S,
  },
  severe: {
    label: 'Severe dust storm',
    durMin: 300,
    durMax: 430,
    peakMin: 0.85,
    peakMax: 1,
    dust: 0.85,
    windMin: 42,
    windMax: 58,
    warnLead: STORM_WARN_LEAD_S,
  },
  planetary: {
    label: 'Planetary dust event',
    durMin: 520,
    durMax: 700,
    peakMin: 0.95,
    peakMax: 1,
    dust: 0.98,
    windMin: 35,
    windMax: 50,
    warnLead: STORM_WARN_LEAD_S + 30,
  },
};

export function stormLabel(kind: StormKind): string {
  return kind === 'calm' ? 'Clear' : STORM_PROFILE[kind].label;
}

/**
 * How hard a storm is blowing at time `t`. A smooth ramp → hold → decay
 * envelope, pure in `t`, so storms are identical on replay.
 */
function stormIntensityAt(s: StormCell, t: number): number {
  if (t <= s.startAt || t >= s.endAt) return 0;
  const dur = s.endAt - s.startAt;
  const u = (t - s.startAt) / dur;
  const ramp = Math.max(0.08, s.rampFrac);
  if (u < ramp) return s.peak * smoothstep(u / ramp);
  if (u > 1 - ramp) return s.peak * smoothstep((1 - u) / ramp);
  return s.peak;
}

/**
 * How much of a cell the colony is standing in: 1 under the footprint,
 * tapering across the rim, with a windy fringe ahead of the leading edge
 * (the gust front arrives before the dust wall does).
 */
function spatialFactor(cell: StormCell): number {
  const d = Math.hypot(cell.x, cell.z);
  const R = cell.radiusKm;
  if (d <= R * 0.85) return 1;
  if (d <= R) return 0.55 + 0.45 * smoothstep((R - d) / (R * 0.15));
  if (d <= R * 1.35) return 0.28 * (1 - (d - R) / (R * 0.35));
  return 0;
}

export class Weather {
  seed: number;
  /** Sim time mirror (game seconds) — kept for snapshot sanity. */
  time = 0;
  /** Multiplier on storm roll probabilities (difficulty × storm option). */
  frequencyMul = 1;
  /** Multiplier on storm structural damage (difficulty). */
  damageMul = 1;

  // ---- current readings ----------------------------------------------------
  windSpeed = 8;
  windDirRad = 0.7;
  dust = 0.08;
  visibility = 1;
  storm: StormKind = 'calm';
  stormIntensity = 0;
  /** Fraction of peak irradiance the ambient dust lets through. */
  solarTransmission = 1;

  // ---- scheduler state -----------------------------------------------------
  private noise: Noise2D;
  private gust: Noise2D;
  private rngState: number;
  private nextRollAt: number;
  private lastStormEndAt = -Infinity;
  /**
   * Storm systems on the map. `scheduled` cells are still on the forecast
   * board (winds not yet arrived); `active` ones have crossed the site's
   * longitude and are blowing or blowing themselves out.
   */
  private active: StormCell[] = [];
  private scheduled: StormCell[] = [];

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.noise = new Noise2D(this.seed ^ 0x51ab7e);
    this.gust = new Noise2D(this.seed ^ 0x1c0ffee);
    this.rngState = (this.seed ^ 0x9e3779b9) >>> 0;
    this.nextRollAt = WEATHER_CALM_SOLS * SOL_SECONDS;
    this.windDirRad = this.rand() * Math.PI * 2;
  }

  // -------------------------------------------------------------- rng ----
  /** mulberry32 stepped on an instance field, so saves can capture it. */
  private rand(): number {
    let a = (this.rngState | 0) >>> 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    this.rngState = (t ^ (t >>> 14)) >>> 0;
    return t / 4294967296;
  }

  // ------------------------------------------------------------- tick ----
  /**
   * Advance one fixed tick. `sol` is the current sol number (0-based) for the
   * early-game storm ban; `now` is the authoritative sim time.
   */
  tick(dt: number, now: number, sol: number): void {
    this.time = now;
    // A restored save (or a test) may have blanked these out from under us.
    if (!this.active) this.active = [];
    if (!this.scheduled) this.scheduled = [];

    // ---- scheduler ---------------------------------------------------------
    if (this.active.length === 0 && this.scheduled.length === 0 && now >= this.nextRollAt) {
      this.nextRollAt = now + WEATHER_ROLL_INTERVAL_S;
      if (now - this.lastStormEndAt >= WEATHER_STORM_COOLDOWN_S && sol + 1 >= WEATHER_CALM_SOLS) {
        const roll = this.rollStormKind(sol);
        if (roll) this.schedule(roll, now);
      }
    }

    // ---- move every system across the planet -------------------------------
    for (const cell of [...this.scheduled, ...this.active]) {
      const u = Math.sin(cell.heading);
      const w = Math.cos(cell.heading);
      cell.x += u * cell.speedKmS * dt;
      cell.z += w * cell.speedKmS * dt;
      // A slow, seeded serpentine — fronts wander a little as they travel.
      cell.heading += Math.sin(now * 0.0021 + cell.phase) * 0.00021 * dt * 60;
    }

    // Move scheduled systems to the board once their winds arrive.
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      if (now >= this.scheduled[i].startAt) {
        const cell = this.scheduled.splice(i, 1)[0];
        this.active.push(cell);
        this.lastStormEndAt = cell.endAt;
      }
    }
    // Systems whose envelope has fully decayed leave the map.
    this.active = this.active.filter((c) => now < c.endAt);

    // ---- local readings: whatever system is overhead ------------------------
    let dom: StormCell | null = null;
    let domI = 0;
    let dustGoal = 0;
    for (const cell of this.active) {
      const env = stormIntensityAt(cell, now);
      if (env <= 0) continue;
      const local = env * spatialFactor(cell);
      dustGoal = Math.max(dustGoal, cell.dustPeak * local);
      if (local > domI) {
        domI = local;
        dom = cell;
      }
    }
    // The gust front ahead of the wall: wind arrives before the dust does.
    let fringe = 0;
    let fringeCell: StormCell | null = null;
    if (!dom) {
      for (const cell of this.active) {
        const env = stormIntensityAt(cell, now);
        if (env <= 0) continue;
        const f = spatialFactor(cell) * env;
        if (f > fringe) {
          fringe = f;
          fringeCell = cell;
        }
      }
    }

    this.stormIntensity = domI;
    this.storm = domI > 0.01 && dom ? dom.kind : 'calm';

    // Ambient wind wanders on a smooth noise field; storms ride on top of it
    // with their own slow gusting, blowing along the system's track.
    const t = now;
    const calmWind = lerp(5, 14, 0.5 + 0.5 * this.noise.fbm(t * 0.008 + 3.7, 11.2, 3, 2, 0.5));
    const gustN = 0.82 + 0.36 * (0.5 + 0.5 * this.gust.fbm(t * 0.013, 21.7, 2, 2, 0.5));
    const driver = dom ?? fringeCell;
    const driverI = dom ? domI : fringe * 0.8;
    const stormWind = driver
      ? driverI *
        driver.windPeak *
        (0.72 + 0.56 * (0.5 + 0.5 * this.gust.fbm(t * 0.011 + 7.3 + driver.phase, 4.4, 2, 2, 0.5)))
      : 0;
    this.windSpeed = Math.max(
      0,
      calmWind * (1 - 0.45 * Math.min(1, driverI)) + stormWind * gustN,
    );
    if (driver) {
      // Wind blows along the storm's track, with a slow swirl about it.
      this.windDirRad =
        driver.heading + 0.35 * Math.sin(t * 0.004 + driver.phase) + 0.12 * Math.sin(t * 0.017);
    } else {
      this.windDirRad = 2 * Math.PI * (0.5 + 0.5 * this.noise.sample(t * 0.004 + 9.2, 1.7));
    }

    // ---- dust --------------------------------------------------------------
    // Dust follows the storm envelope, but with inertia: it takes time to
    // fill the sky, and long after the winds quit the sky stays milky.
    const ambient = 0.04 + 0.1 * (0.5 + 0.5 * this.noise.fbm(t * 0.006 - 2.1, 17.3, 2, 2, 0.5));
    const goal = Math.max(ambient, dustGoal);
    const tau = goal > this.dust ? 14 : 50; // kicks up fast, settles slowly
    this.dust += (goal - this.dust) * Math.min(1, dt / tau);
    this.dust = clamp(this.dust, 0, 1);

    // ---- transmission & visibility ------------------------------------------
    this.solarTransmission = 1 - 0.75 * Math.pow(this.dust, 1.1);
    this.visibility = clamp(1 - 1.05 * this.dust - 0.12 * domI, 0, 1);
  }

  // -------------------------------------------------------- scheduling ----
  /** Pick a storm class for this roll, respecting per-class unlock sols. */
  private rollStormKind(sol: number): StormKindReal | null {
    const can = (k: Exclude<StormKind, 'calm'>) => sol + 1 >= STORM_UNLOCK_SOL[k];
    const r = this.rand();
    let acc = 0;
    // Ordered by rarity-weighted drama; at most one storm per roll.
    const order: Array<Exclude<StormKind, 'calm'>> = ['planetary', 'severe', 'regional', 'devil'];
    for (const k of order) {
      if (!can(k)) continue;
      let p: number = STORM_CHANCES[k];
      if (k === 'planetary') p = Math.min(0.03, p + 0.002 * Math.max(0, sol + 1 - STORM_UNLOCK_SOL.planetary));
      acc += p * this.frequencyMul;
      if (r < acc) return k;
    }
    return null;
  }

  /**
   * Put a storm system on the board with a forecast lead. The cell spawns
   * upwind of the colony along its track, at exactly the distance its speed
   * and the lead time require — so the leading edge crosses the site at
   * `startAt`, and the colony sits under the footprint for the storm's life.
   */
  private schedule(kind: StormKindReal, now: number): void {
    this.scheduled.push(this.makeCell(kind, now, STORM_PROFILE[kind].warnLead));
  }

  private makeCell(kind: StormKindReal, now: number, lead: number): StormCell {
    const p = STORM_PROFILE[kind];
    const geo = STORM_CELL_GEOM[kind];
    const dur = lerp(p.durMin, p.durMax, this.rand());
    const radiusKm = lerp(geo.rMin, geo.rMax, this.rand());
    const heading = this.rand() * Math.PI * 2;
    // Crossing fraction of the radius per storm life → speed (km / game s).
    const speedKmS = (radiusKm * geo.cross) / dur;
    // The leading edge reaches the colony at startAt.
    const dist0 = radiusKm * 0.95 + speedKmS * lead;
    return {
      kind,
      x: -Math.sin(heading) * dist0,
      z: -Math.cos(heading) * dist0,
      heading,
      speedKmS,
      radiusKm,
      startAt: now + lead,
      endAt: now + lead + dur,
      peak: lerp(p.peakMin, p.peakMax, this.rand()),
      rampFrac: kind === 'planetary' ? 0.3 : kind === 'devil' ? 0.18 : 0.24,
      dustPeak: p.dust * lerp(0.9, 1.05, this.rand()),
      windPeak: lerp(p.windMin, p.windMax, this.rand()),
      announced: false,
      phase: this.rand() * Math.PI * 2,
    };
  }

  // ------------------------------------------------------------ queries ----
  get reading(): WeatherReading {
    return {
      windSpeed: this.windSpeed,
      windDirRad: this.windDirRad,
      dust: this.dust,
      visibility: this.visibility,
      storm: this.storm,
      stormIntensity: this.stormIntensity,
      solarTransmission: this.solarTransmission,
    };
  }

  /** The storm on the forecast board, if any. */
  forecast(): { kind: StormKind; label: string; arrivesIn: number } | null {
    if (this.scheduled.length === 0) return null;
    const next = this.scheduled.reduce((a, b) => (a.startAt < b.startAt ? a : b));
    return {
      kind: next.kind,
      label: STORM_PROFILE[next.kind].label,
      arrivesIn: Math.max(0, next.startAt - this.time),
    };
  }

  /** Storm system currently over the site, if any (HUD countdowns). */
  current(): StormCell | null {
    let best: StormCell | null = null;
    let bestI = 0;
    for (const cell of this.active) {
      const env = stormIntensityAt(cell, this.time);
      if (env <= 0) continue;
      const local = env * spatialFactor(cell);
      if (local > bestI) {
        bestI = local;
        best = cell;
      }
    }
    if (!best) return null;
    // On the board but blowing over somewhere else doesn't count as "here".
    if (Math.hypot(best.x, best.z) > best.radiusKm) return null;
    return best;
  }

  /**
   * A storm system the colony can see coming: still outside the footprint but
   * on an intercept track. Distance and bearing are real — the HUD shows the
   * front approaching the way a weather map would.
   */
  threat(): {
    kind: StormKindReal;
    label: string;
    distKm: number;
    bearingRad: number;
    arrivesIn: number;
    radiusKm: number;
  } | null {
    let best: StormCell | null = null;
    let bestEta = Infinity;
    for (const cell of [...this.scheduled, ...this.active]) {
      const d = Math.hypot(cell.x, cell.z);
      if (d <= cell.radiusKm) continue; // already overhead → current() owns it
      // Is it actually closing in? Velocity component toward the colony.
      const closing = -(Math.sin(cell.heading) * cell.x + Math.cos(cell.heading) * cell.z) / d;
      if (closing < 0.2 || cell.speedKmS <= 0) continue;
      const eta = Math.max(0, (d - cell.radiusKm * 0.9)) / (cell.speedKmS * closing);
      if (eta < bestEta) {
        bestEta = eta;
        best = cell;
      }
    }
    if (!best) return null;
    return {
      kind: best.kind,
      label: STORM_PROFILE[best.kind].label,
      distKm: Math.hypot(best.x, best.z),
      bearingRad: Math.atan2(best.x, best.z),
      arrivesIn: bestEta,
      radiusKm: best.radiusKm,
    };
  }

  /** Seconds until the storm in progress has fully passed (0 when calm). */
  passesIn(): number {
    const c = this.current();
    return c ? Math.max(0, c.endAt - this.time) : 0;
  }

  /** Rovers must shelter: mid-storm, above the safe-work intensity. */
  shelterRovers(): boolean {
    return this.stormIntensity >= 0.55 && this.storm !== 'devil';
  }

  /** New EVAs are refused while the wind is past this. */
  blocksEVA(): boolean {
    return this.stormIntensity >= 0.4 && this.storm !== 'devil';
  }

  /** Outdoor work runs at reduced rate in the storm's build-up. */
  workMultiplier(): number {
    return this.stormIntensity >= 0.4 ? 0.6 : 1;
  }

  /**
   * Storm damage applied to `exposure` this tick — zero below the bruising
   * threshold so ordinary breezes never chew on hardware.
   */
  damageRate(): number {
    if (this.stormIntensity <= 0.25) return 0;
    return Math.pow(this.stormIntensity, 1.5) * 0.38 * this.damageMul;
  }

  /** Test/cheat hook (TDD §22): force a storm on the board right now. */
  debugScheduleStorm(kind: Exclude<StormKind, 'calm'>, now: number, lead = 0): void {
    const p = STORM_PROFILE[kind];
    const geo = STORM_CELL_GEOM[kind];
    const dur = (p.durMin + p.durMax) / 2;
    const radiusKm = (geo.rMin + geo.rMax) / 2;
    const heading = this.rand() * Math.PI * 2;
    const speedKmS = (radiusKm * geo.cross) / dur;
    const dist0 = radiusKm * 0.95 + speedKmS * lead;
    this.scheduled.push({
      kind,
      x: -Math.sin(heading) * dist0,
      z: -Math.cos(heading) * dist0,
      heading,
      speedKmS,
      radiusKm,
      startAt: now + lead,
      endAt: now + lead + dur,
      peak: (p.peakMin + p.peakMax) / 2,
      rampFrac: kind === 'devil' ? 0.18 : 0.24,
      dustPeak: p.dust,
      windPeak: (p.windMin + p.windMax) / 2,
      announced: false,
      phase: this.rand() * Math.PI * 2,
    });
  }

  /** Test/cheat hook (TDD §22): stop the scheduler from rolling new weather. */
  debugSuppressRolls(): void {
    this.nextRollAt = Infinity;
  }

  /**
   * Developer-mode hook: let the scheduler roll again right away. Pairs with
   * {@link debugSuppressRolls}; the unlock-sol gates still apply, so early
   * colonies stay in their calm window.
   */
  debugResumeRolls(now: number): void {
    this.nextRollAt = now;
  }

  /** True while the storm scheduler is switched off (developer mode). */
  get rollsSuppressed(): boolean {
    return !Number.isFinite(this.nextRollAt);
  }

  /**
   * Developer-mode hook: clear every storm, on the map or merely forecast,
   * right now. The airborne dust then settles on its own natural timescale.
   */
  debugClearStorms(): void {
    this.active = [];
    this.scheduled = [];
    this.stormIntensity = 0;
    this.storm = 'calm';
  }

  // -------------------------------------------------------- persistence ----
  snapshot(): object {
    return {
      rngState: this.rngState,
      nextRollAt: this.nextRollAt,
      lastStormEndAt: this.lastStormEndAt,
      active: this.active,
      scheduled: this.scheduled,
      dust: this.dust,
      windSpeed: this.windSpeed,
      windDirRad: this.windDirRad,
      frequencyMul: this.frequencyMul,
      damageMul: this.damageMul,
    };
  }

  /**
   * Accept both the new cell lists and the legacy single-storm shape, so a
   * v6 save's mid-flight storm survives the upgrade: it is re-spawned as a
   * system already overhead, keeping its original envelope and timing.
   */
  restore(data: any): void {
    this.frequencyMul = Number.isFinite(data?.frequencyMul) ? data.frequencyMul : 1;
    this.damageMul = Number.isFinite(data?.damageMul) ? data.damageMul : 1;
    this.rngState = (data?.rngState ?? (this.seed ^ 0x9e3779b9)) >>> 0;
    this.nextRollAt = data?.nextRollAt ?? WEATHER_CALM_SOLS * SOL_SECONDS;
    this.lastStormEndAt = data?.lastStormEndAt ?? -Infinity;
    this.active = this.restoreCells(data?.active, true);
    this.scheduled = this.restoreCells(data?.scheduled, false);
    this.dust = clamp(data?.dust ?? 0.08, 0, 1);
    this.windSpeed = data?.windSpeed ?? 8;
    this.windDirRad = data?.windDirRad ?? 0.7;
    const dom = this.current();
    this.stormIntensity = dom
      ? stormIntensityAt(dom, this.time) * spatialFactor(dom)
      : 0;
    this.storm = this.stormIntensity > 0.01 && dom ? dom.kind : 'calm';
    this.solarTransmission = 1 - 0.75 * Math.pow(this.dust, 1.1);
    this.visibility = clamp(1 - 1.05 * this.dust - 0.12 * this.stormIntensity, 0, 1);
  }

  private restoreCells(raw: any, wasActive: boolean): StormCell[] {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const out: StormCell[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      if (Number.isFinite(item.radiusKm) && Number.isFinite(item.heading)) {
        out.push(item as StormCell);
        continue;
      }
      // Legacy time-only storm: rebuild a system already over the site.
      const legacy = item as LegacyStormEvent;
      const geo = STORM_CELL_GEOM[legacy.kind] ?? STORM_CELL_GEOM.regional;
      const dur = Math.max(30, (legacy.endAt ?? this.time) - (legacy.startAt ?? this.time));
      const radiusKm = (geo.rMin + geo.rMax) / 2;
      out.push({
        kind: legacy.kind,
        x: 0,
        z: 0,
        heading: this.rand() * Math.PI * 2,
        speedKmS: (radiusKm * geo.cross) / dur,
        radiusKm,
        startAt: legacy.startAt ?? this.time,
        endAt: legacy.endAt ?? this.time + dur,
        peak: legacy.peak ?? 0.7,
        rampFrac: legacy.rampFrac ?? 0.24,
        dustPeak: legacy.dustPeak ?? 0.6,
        windPeak: legacy.windPeak ?? 34,
        announced: legacy.announced ?? true,
        phase: this.rand() * Math.PI * 2,
      });
      void wasActive;
    }
    return out;
  }
}
