/**
 * @suite render/solar
 * @group unit
 * @covers src/render/Renderer.ts src/sim/defs.ts
 * @desc Solar arrays stay focused on power generation; weather observation is
 * provided by the dedicated radar-station building instead of hidden hardware
 * attached to the first array.
 */

import assert from 'node:assert/strict';
import { BUILDINGS } from '../../src/sim/defs';
import { group, test, finish } from '../harness';

group('Solar and radar building roles');

test('the solar array has no weather-instrument capability', () => {
  assert.equal(BUILDINGS.solar.weatherRadarRangeKm, undefined);
  assert.equal(BUILDINGS.solar.advancedForecast, undefined);
  assert.equal(BUILDINGS.solar.generation, 'solar');
});

test('the radar station owns weather maps and advanced forecasting', () => {
  assert.ok((BUILDINGS.weatherStation.weatherRadarRangeKm ?? 0) > 0);
  assert.equal(BUILDINGS.weatherStation.advancedForecast, true);
  assert.equal(BUILDINGS.weatherStation.powerDrawKw > 0, true);
});

await finish('render/solar');
