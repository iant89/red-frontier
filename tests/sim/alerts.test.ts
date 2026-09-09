/**
 * @suite sim/alerts
 * @group unit
 * @covers src/sim/alerts.ts
 * @desc The alert bus: a condition raises once, clears once, and never spams the log.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Alerts');

test('a condition raises once and clears once, without spamming the log', () => {
  const sim = new Simulation({ seed: 41 });
  sim.pools.amounts.oxygen = 0.01;
  run(sim, 0.3);
  const raised = sim.alerts.list().filter((a) => a.key === 'oxygen-low');
  assert.equal(raised.length, 1, 'exactly one active oxygen alert');
  const lines = sim.alerts.history().filter((l) => l.text.includes('Oxygen'));
  assert.ok(lines.length <= 3, `log should not spam, got ${lines.length} lines`);
});

test('alerts clear when the condition resolves', () => {
  const sim = new Simulation({ seed: 42 });
  sim.pools.amounts.water = 0.01;
  run(sim, 0.2);
  assert.ok(sim.alerts.isActive('water-low'));
  sim.pools.amounts.water = sim.pools.capacity.water;
  run(sim, 0.2);
  assert.ok(!sim.alerts.isActive('water-low'), 'refilling should clear the alert');
});

await finish('sim/alerts');
