/**
 * Phase 2 — Weather state placeholder.
 * Weather lives in sim/weather.ts; this module will own weather state
 * extraction in Phase 5. For Phase 2 it provides a factory.
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
