/**
 * Phase 2/5 — Weather state.
 *
 * Owns weather-state construction: the Weather model instance seeded from the
 * colony seed (dedicated stream — never the world/deposit/POI/cargo RNG) with
 * the difficulty × storm-option multipliers applied. The behavior that *drives*
 * it lives in `sim/systems/WeatherSystem.ts` (Phase 5); the model itself
 * (progression, storm scheduling, readings, snapshot/restore) lives in
 * `sim/weather.ts`.
 */

import { Weather } from '../weather';
import { DIFFICULTIES, stormMulFor } from '../difficulty';
import type { DifficultyId, WorldOptions } from '../difficulty';

export function createWeatherState(seed: number, difficulty: DifficultyId = 'pioneer', worldOptions?: Partial<WorldOptions>): Weather {
  const diff = DIFFICULTIES[difficulty] ?? DIFFICULTIES.pioneer;
  const w = new Weather(seed ^ 0x77e711e);
  const level = worldOptions?.stormLevel ?? 'normal';
  w.frequencyMul = diff.stormMul * stormMulFor(level);
  w.damageMul = diff.damageMul;
  w.lightningMul = diff.lightningMul;
  return w;
}
