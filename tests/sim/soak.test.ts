/**
 * @suite sim/soak
 * @group load
 * @covers src/sim/**
 * @desc Twenty sols of live operation: days, nights, storms, hauling and wear.
 * The slowest suite in the house — worth running on its own or before a
 * release, not on every keystroke.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import type { BuildingKind } from '../../src/sim/defs';
import { run, buildOnline } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Long-run stability');

test('a full colony survives 20 sols of live operation', () => {
  const sim = new Simulation({ seed: 42, nearDeposits: 0.2 });
  for (const k of ['warehouse', 'solar', 'battery', 'extractor', 'oxygenator'] as BuildingKind[]) {
    buildOnline(sim, k);
  }
  buildOnline(sim, 'greenhouse');
  buildOnline(sim, 'solar');
  buildOnline(sim, 'battery');
  // Twenty sols of days, nights, storms, hauling and wear — with the asserts
  // kept to what live operation can promise: survival and health. Whether the
  // food loop itself closes is measured deterministically in sim/colony, not sampled
  // from the middle of the logistics lottery.
  run(sim, 20);

  assert.ok(sim.clock.sol >= 20, `the run must actually cross 20 sols (reached ${sim.clock.sol})`);
  assert.ok(sim.history.length > 10, 'long-run power and life-support history should be populated');
  assert.ok(
    sim.rovers.some((rover) => rover.condition < 99),
    'live logistics must accumulate measurable rover wear',
  );
  assert.ok(!sim.gameOver, 'the colony should survive');
  assert.ok(sim.colonist.health > 90, `colonist should be healthy, was ${sim.colonist.health}`);
  assert.ok(sim.pools.amounts.food > 0, 'the colony should not be starving');
});

await finish('sim/soak');
