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
 * - **Deterministic.** One seeded PRNG stream (part of the save), noise sampled
 *   from absolute sim time, and a storm *envelope* that is a pure function of
 *   elapsed storm time. No per-particle randomness, no wall clock. Two runs
 *   with the same seed live through the same weather.
 * - **Scheduled, not simulated.** TDD §11 asks for regional state updated at
 *   1–5 min intervals and interpolated between — not per-grain fluid dynamics.
 *   A scheduler rolls the dice on a fixed cadence; a storm is then a scripted
 *   ramp-hold-decay envelope with a forecast lead time.
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
  SOL_SECONDS,
} from './config';
import { clamp, lerp, smoothstep } from '../lib/rng';
import { Noise2D } from '../lib/noise';

export type StormKind = 'calm' | 'devil' | 'regional' | 'severe' | 'planetary';

/** One scheduled or in-progress storm event. */
export type StormKindReal = Exclude<StormKind, 'calm'>;

/** One scheduled or in-progress storm event. */
export interface StormEvent {
  kind: StormKindReal;
  /** Sim time the winds arrive (end of the forecast lead). */
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
function stormIntensityAt(s: StormEvent, t: number): number {
  if (t <= s.startAt || t >= s.endAt) return 0;
  const dur = s.endAt - s.startAt;
  const u = (t - s.startAt) / dur;
  const ramp = Math.max(0.08, s.rampFrac);
  if (u < ramp) return s.peak * smoothstep(u / ramp);
  if (u > 1 - ramp) return s.peak * smoothstep((1 - u) / ramp);
  return s.peak;
}

/** Where a storm's dust tops out — dirtier classes fill more of the sky. */
function stormDustFor(s: StormEvent, intensity: number): number {
  return s.dustPeak * intensity;
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
  /** Storm currently on the map (null between events). */
  private active: StormEvent | null = null;
  /** Storm on the forecast board, not yet arrived. */
  private scheduled: StormEvent | null = null;

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

    // ---- scheduler ---------------------------------------------------------
    if (!this.active && !this.scheduled && now >= this.nextRollAt) {
      this.nextRollAt = now + WEATHER_ROLL_INTERVAL_S;
      if (now - this.lastStormEndAt >= WEATHER_STORM_COOLDOWN_S && sol + 1 >= WEATHER_CALM_SOLS) {
        const roll = this.rollStormKind(sol);
        if (roll) this.schedule(roll, now);
      }
    }

    // Move the scheduled storm to active when its winds arrive.
    if (this.scheduled && now >= this.scheduled.startAt) {
      this.active = this.scheduled;
      this.scheduled = null;
      this.lastStormEndAt = this.active.endAt;
    }
    if (this.active && now >= this.active.endAt) {
      this.active = null;
    }

    // ---- readings ----------------------------------------------------------
    const intensity = this.active ? stormIntensityAt(this.active, now) : 0;
    this.stormIntensity = intensity;
    this.storm = intensity > 0.01 && this.active ? this.active.kind : 'calm';

    // Ambient wind wanders on a smooth noise field; storms ride on top of it
    // with their own slow gusting.
    const t = now;
    const calmWind = lerp(5, 14, 0.5 + 0.5 * this.noise.fbm(t * 0.008 + 3.7, 11.2, 3, 2, 0.5));
    const gustN = 0.82 + 0.36 * (0.5 + 0.5 * this.gust.fbm(t * 0.013, 21.7, 2, 2, 0.5));
    const stormWind = this.active
      ? intensity *
        this.active.windPeak *
        (0.72 + 0.56 * (0.5 + 0.5 * this.gust.fbm(t * 0.011 + 7.3, 4.4, 2, 2, 0.5)))
      : 0;
    this.windSpeed = Math.max(0, calmWind * (1 - 0.45 * Math.min(1, intensity)) + stormWind * gustN);
    this.windDirRad = 2 * Math.PI * (0.5 + 0.5 * this.noise.sample(t * 0.004 + 9.2, 1.7));

    // ---- dust --------------------------------------------------------------
    // Dust follows the storm envelope, but with inertia: it takes time to
    // fill the sky, and long after the winds quit the sky stays milky.
    const ambient = 0.04 + 0.1 * (0.5 + 0.5 * this.noise.fbm(t * 0.006 - 2.1, 17.3, 2, 2, 0.5));
    const stormDust = this.active ? stormDustFor(this.active, intensity) : 0;
    const goal = Math.max(ambient, stormDust);
    const tau = goal > this.dust ? 14 : 50; // kicks up fast, settles slowly
    this.dust += (goal - this.dust) * Math.min(1, dt / tau);
    this.dust = clamp(this.dust, 0, 1);

    // ---- transmission & visibility ------------------------------------------
    this.solarTransmission = 1 - 0.75 * Math.pow(this.dust, 1.1);
    this.visibility = clamp(1 - 1.05 * this.dust - 0.12 * intensity, 0, 1);
  }

  private scheduledLead(): number {
    return this.scheduled ? STORM_PROFILE[this.scheduled.kind].warnLead : 0;
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

  /** Put a storm on the board with a forecast lead. */
  private schedule(kind: StormKindReal, now: number): void {
    const p = STORM_PROFILE[kind];
    const dur = lerp(p.durMin, p.durMax, this.rand());
    const lead = p.warnLead;
    this.scheduled = {
      kind,
      startAt: now + lead,
      endAt: now + lead + dur,
      peak: lerp(p.peakMin, p.peakMax, this.rand()),
      rampFrac: kind === 'planetary' ? 0.3 : kind === 'devil' ? 0.18 : 0.24,
      dustPeak: p.dust * lerp(0.9, 1.05, this.rand()),
      windPeak: lerp(p.windMin, p.windMax, this.rand()),
      announced: false,
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
    if (!this.scheduled) return null;
    return {
      kind: this.scheduled.kind,
      label: STORM_PROFILE[this.scheduled.kind].label,
      arrivesIn: Math.max(0, this.scheduled.startAt - this.time),
    };
  }

  /** Storm event in progress, if any (HUD countdowns). */
  current(): StormEvent | null {
    return this.active;
  }

  /** Seconds until the storm in progress has fully passed (0 when calm). */
  passesIn(): number {
    return this.active ? Math.max(0, this.active.endAt - this.time) : 0;
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
    this.scheduled = {
      kind,
      startAt: now + lead,
      endAt: now + lead + (p.durMin + p.durMax) / 2,
      peak: (p.peakMin + p.peakMax) / 2,
      rampFrac: kind === 'devil' ? 0.18 : 0.24,
      dustPeak: p.dust,
      windPeak: (p.windMin + p.windMax) / 2,
      announced: false,
    };
  }

  /** Test/cheat hook (TDD §22): stop the scheduler from rolling new weather. */
  debugSuppressRolls(): void {
    this.nextRollAt = Infinity;
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

  restore(data: any): void {
    this.frequencyMul = Number.isFinite(data?.frequencyMul) ? data.frequencyMul : 1;
    this.damageMul = Number.isFinite(data?.damageMul) ? data.damageMul : 1;
    this.rngState = (data?.rngState ?? (this.seed ^ 0x9e3779b9)) >>> 0;
    this.nextRollAt = data?.nextRollAt ?? WEATHER_CALM_SOLS * SOL_SECONDS;
    this.lastStormEndAt = data?.lastStormEndAt ?? -Infinity;
    this.active = data?.active ?? null;
    this.scheduled = data?.scheduled ?? null;
    this.dust = clamp(data?.dust ?? 0.08, 0, 1);
    this.windSpeed = data?.windSpeed ?? 8;
    this.windDirRad = data?.windDirRad ?? 0.7;
    this.stormIntensity = this.active ? stormIntensityAt(this.active, this.time) : 0;
    this.storm = this.active ? this.active.kind : 'calm';
    this.solarTransmission = 1 - 0.75 * Math.pow(this.dust, 1.1);
    this.visibility = clamp(1 - 1.05 * this.dust - 0.12 * this.stormIntensity, 0, 1);
  }
}
