/**
 * @suite sim/power
 * @group unit
 * @covers src/sim/power.ts src/sim/config.ts
 * @desc Pure power maths: allocation order, tier shedding, curtailment and the energy
 * balance of one tick. No Simulation is built here, so it costs milliseconds —
 * the suite to run when you touch the grid maths.
 */

import assert from 'node:assert/strict';
import { resolvePower } from '../../src/sim/power';
import { group, test, finish } from '../harness';

group('Power network');

test('generation is spent before storage, surplus charges the pack', () => {
  const r = resolvePower(100, [{ id: 1, tier: 0, kw: 40 }], 50, 200, 1);
  assert.equal(r.servedKw, 40);
  assert.equal(r.batteryFlowKw, 60, 'surplus should charge');
  assert.equal(r.storedKWh, 110);
  assert.equal(r.brownout, false);
});

test('storage covers a deficit and discharges', () => {
  const r = resolvePower(10, [{ id: 1, tier: 0, kw: 30 }], 50, 200, 1);
  assert.equal(r.servedKw, 30);
  assert.equal(r.batteryFlowKw, -20);
  assert.equal(r.storedKWh, 30);
  assert.equal(r.brownout, false, 'covered by battery is not a brownout');
});

test('load is shed from the lowest priority tier upward', () => {
  const r = resolvePower(
    30,
    [
      { id: 1, tier: 0, kw: 20 },
      { id: 2, tier: 2, kw: 20 },
      { id: 3, tier: 3, kw: 20 },
    ],
    0,
    0,
    1,
  );
  assert.equal(r.tierSatisfaction[0], 1, 'tier 0 must be fully served');
  assert.equal(r.tierSatisfaction[2], 0.5, 'tier 2 takes the partial hit');
  assert.equal(r.tierSatisfaction[3], 0, 'tier 3 is shed entirely');
  assert.equal(r.firstShedTier, 2);
  assert.ok(r.brownout);
});

test('consumers within a tier degrade evenly, not arbitrarily', () => {
  const r = resolvePower(
    10,
    [
      { id: 1, tier: 1, kw: 10 },
      { id: 2, tier: 1, kw: 10 },
    ],
    0,
    0,
    1,
  );
  assert.equal(r.satisfaction.get(1), 0.5);
  assert.equal(r.satisfaction.get(2), 0.5);
});

test('generation with nowhere to go is reported as curtailed', () => {
  const r = resolvePower(100, [], 200, 200, 1);
  assert.equal(r.curtailedKw, 100);
  assert.equal(r.batteryFlowKw, 0);
});

test('energy is conserved across a tick', () => {
  const stored = 80;
  const r = resolvePower(25, [{ id: 1, tier: 0, kw: 40 }], stored, 200, 0.5);
  const deltaStored = r.storedKWh - stored;
  const generated = 25 * 0.5;
  const served = r.servedKw * 0.5;
  assert.ok(
    Math.abs(generated - served - deltaStored - r.curtailedKw * 0.5) < 1e-9,
    'generation must equal load + storage delta + curtailment',
  );
});

await finish('sim/power');
