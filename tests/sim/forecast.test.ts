/**
 * @suite sim/forecast
 * @group unit
 * @covers src/sim/forecast.ts
 * @desc Phase 1 infrastructure — pure forecast utility: sols-to-empty, runway breach, warning tiers.
 */

import assert from 'node:assert/strict';
import { forecastFluidWithRates, formatSolsToEmpty, warningForFluid } from '../../src/sim/forecast';
import { group, test, finish } from '../harness';

group('Forecast math');

test('not depleting returns Infinity', () => {
  const f = forecastFluidWithRates(100, 200, 'water', 10, 5);
  assert.equal(f.isDepleting, false);
  assert.equal(f.solsToEmpty, Infinity);
  assert.equal(f.runwayBreach, false);
  assert.equal(f.warningTier, 'ok');
});

test('depleting calculates sols-to-empty', () => {
  // 100 kg, net -10 kg/sol = 10 sols
  const f = forecastFluidWithRates(100, 200, 'water', 0, 10);
  assert.equal(f.isDepleting, true);
  assert.ok(Math.abs(f.solsToEmpty - 10) < 1e-9);
  assert.equal(f.warningTier, 'ok'); // 10 sols = ok (watch is <5)
});

test('warning tiers based on sols-to-empty', () => {
  const watch = forecastFluidWithRates(40, 200, 'water', 0, 10); // 4 sols
  assert.equal(watch.warningTier, 'watch');

  const warning = forecastFluidWithRates(20, 200, 'water', 0, 10); // 2 sols
  assert.equal(warning.warningTier, 'warning');

  const critical = forecastFluidWithRates(5, 200, 'water', 0, 10); // 0.5 sols
  assert.equal(critical.warningTier, 'critical');
});

test('runway breach <1.0 sol', () => {
  const breach = forecastFluidWithRates(8, 200, 'oxygen', 0, 10); // 0.8 sols
  assert.equal(breach.runwayBreach, true);
  assert.equal(breach.warningTier, 'critical');

  const ok = forecastFluidWithRates(15, 200, 'oxygen', 0, 10); // 1.5 sols
  assert.equal(ok.runwayBreach, false);
});

test('formatSolsToEmpty', () => {
  assert.equal(formatSolsToEmpty(Infinity), '∞');
  assert.equal(formatSolsToEmpty(0.05), '0.05 sols');
  assert.equal(formatSolsToEmpty(1.8), '1.8 sols');
  assert.equal(formatSolsToEmpty(12.3), '12 sols');
});

test('warningForFluid copy matches roadmap exemplar', () => {
  const critical = forecastFluidWithRates(18, 200, 'water', 0, 10); // 1.8 sols
  const msg = warningForFluid(critical);
  assert.ok(msg !== null);
  assert.match(msg!, /water.*1\.8 sols/i, 'should match roadmap exemplar "Your water reserve will run dry in 1.8 sols."');

  const stable = forecastFluidWithRates(100, 200, 'water', 10, 5);
  assert.equal(warningForFluid(stable), null);
});

test('net production/consumption math', () => {
  const f = forecastFluidWithRates(100, 200, 'water', 9.7, 8.4); // net +1.3
  assert.equal(f.isDepleting, false);
  assert.ok(Math.abs(f.netPerSol - 1.3) < 1e-9);

  const depleting = forecastFluidWithRates(100, 200, 'water', 8.4, 9.7); // net -1.3
  assert.equal(depleting.isDepleting, true);
  assert.ok(depleting.solsToEmpty > 70 && depleting.solsToEmpty < 80); // 100/1.3 ≈ 76.9
});

test('deterministic — same inputs same outputs', () => {
  const a = forecastFluidWithRates(100, 200, 'water', 8.4, 9.7);
  const b = forecastFluidWithRates(100, 200, 'water', 8.4, 9.7);
  assert.deepEqual(a, b);
});

await finish('sim/forecast');
