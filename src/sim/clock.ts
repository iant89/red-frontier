/**
 * The Mars sol clock and the authoritative sun.
 *
 * TDD §12: "Renderer uses the same authoritative sun as simulation (single
 * source)." Everything — solar output, greenhouse grow lamps, the directional
 * light in the 3D scene, the sky colour — reads from this one object.
 */

import {
  SOL_SECONDS,
  SOL_HOURS,
  SUNRISE_FRAC,
  SUNSET_FRAC,
  HORIZON_EXTINCTION,
  START_SOL_FRAC,
} from './config';
import { clamp } from '../lib/rng';

export interface SunState {
  /** Normalised height of the sun, -1 (midnight) .. 1 (local noon). */
  altitude: number;
  /** Elevation above the horizon in radians (negative at night). */
  elevationRad: number;
  /** Compass bearing of the sun in radians, sweeping east → west. */
  azimuthRad: number;
  /**
   * Fraction of peak irradiance reaching a horizontal surface, 0 at night.
   * Includes atmospheric extinction near the horizon.
   */
  irradiance: number;
  /** True between sunrise and sunset. */
  isDay: boolean;
}

export class SolClock {
  /** Whole sols completed since landing (display is 1-based). */
  sol = 0;
  /** Position within the current sol, 0 (midnight) .. 1. */
  frac = START_SOL_FRAC;

  sun: SunState = sunFor(START_SOL_FRAC);

  /** Advance by dt game seconds. Returns true when a new sol began. */
  advance(dt: number): boolean {
    this.frac += dt / SOL_SECONDS;
    let rolled = false;
    while (this.frac >= 1) {
      this.frac -= 1;
      this.sol++;
      rolled = true;
    }
    this.sun = sunFor(this.frac);
    return rolled;
  }

  /** Total sols elapsed as a float — handy for rate maths. */
  get solsElapsed(): number {
    return this.sol + this.frac;
  }

  /** Local Mars time as {h, m} on a 24h 39m clock. */
  localTime(): { h: number; m: number } {
    const hours = this.frac * SOL_HOURS;
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    return { h, m };
  }

  /** "Sol 4 · 06:12" */
  format(): string {
    const { h, m } = this.localTime();
    return `Sol ${this.sol + 1} · ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /** Coarse label for the current phase of the sol. */
  phase(): string {
    const f = this.frac;
    if (f < 0.22) return 'Night';
    if (f < 0.3) return 'Dawn';
    if (f < 0.45) return 'Morning';
    if (f < 0.55) return 'Midday';
    if (f < 0.7) return 'Afternoon';
    if (f < 0.78) return 'Dusk';
    return 'Night';
  }

  snapshot(): { sol: number; frac: number } {
    return { sol: this.sol, frac: this.frac };
  }

  restore(data: { sol?: number; frac?: number } | undefined): void {
    this.sol = Math.max(0, Math.floor(data?.sol ?? 0));
    this.frac = clamp(data?.frac ?? START_SOL_FRAC, 0, 0.9999);
    this.sun = sunFor(this.frac);
  }
}

/**
 * Pure sun model for a sol fraction. Sunrise at 0.25, noon at 0.5, sunset at
 * 0.75 — a clean sinusoid, which keeps day and night equal length. Seasonal
 * tilt is deliberately out of scope until the weather slice.
 */
export function sunFor(frac: number): SunState {
  const altitude = Math.sin(2 * Math.PI * (frac - SUNRISE_FRAC));
  const isDay = frac > SUNRISE_FRAC && frac < SUNSET_FRAC;

  // Elevation, capped a touch below vertical so shadows never fully collapse.
  const elevationRad = Math.asin(clamp(altitude * 0.96, -1, 1));

  // Sun sweeps a full circle across the sol; noon puts it due north/south.
  const azimuthRad = 2 * Math.PI * (frac - SUNRISE_FRAC) + Math.PI / 2;

  // Air mass grows sharply at low elevation, so light reddens and weakens.
  let irradiance = 0;
  if (altitude > 0) {
    const grazing = Math.pow(altitude, 0.55);
    irradiance = HORIZON_EXTINCTION + (1 - HORIZON_EXTINCTION) * grazing;
    irradiance *= clamp(altitude * 6, 0, 1); // soften the first minutes of dawn
  }

  return { altitude, elevationRad, azimuthRad, irradiance, isDay };
}

/** Unit vector pointing *from the origin toward the sun*. */
export function sunDirection(sun: SunState): { x: number; y: number; z: number } {
  const ce = Math.cos(sun.elevationRad);
  return {
    x: Math.cos(sun.azimuthRad) * ce,
    y: Math.sin(sun.elevationRad),
    z: Math.sin(sun.azimuthRad) * ce,
  };
}
