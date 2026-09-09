/**
 * @suite sim/determinism
 * @group determinism
 * @covers src/sim/**
 * @desc Identical inputs, identical state: the same seed and commands, and the same
 * elapsed time delivered at any frame pacing.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { nearDeposit, run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Determinism & persistence');

test('same seed and same commands produce identical state', () => {
  const a = new Simulation({ seed: 42, nearDeposits: 0.18 });
  const b = new Simulation({ seed: 42, nearDeposits: 0.18 });
  a.issueMine(a.rovers[0].id, nearDeposit(a, 'regolith')!.id);
  b.issueMine(b.rovers[0].id, nearDeposit(b, 'regolith')!.id);
  run(a, 5);
  run(b, 5);
  assert.equal(
    JSON.stringify(a.snapshot()),
    JSON.stringify(b.snapshot()),
    'state diverged between two identical runs',
  );
});

test('the same total time produces the same state at any frame rate', () => {
  const steady = new Simulation({ seed: 77, nearDeposits: 0.18 });
  const jittery = new Simulation({ seed: 77, nearDeposits: 0.18 });
  for (let i = 0; i < 1200; i++) steady.step(1 / 20);
  // Same 60 s of sim time, delivered in uneven chunks like a real browser.
  let delivered = 0;
  const chunks = [1 / 30, 1 / 15, 1 / 60, 1 / 20, 0.1];
  let i = 0;
  while (delivered < 60 - 1e-9) {
    const dt = Math.min(chunks[i++ % chunks.length], 60 - delivered);
    jittery.step(dt);
    delivered += dt;
  }
  assert.equal(
    JSON.stringify(steady.snapshot()),
    JSON.stringify(jittery.snapshot()),
    'variable frame pacing must not change the simulation',
  );
});

await finish('sim/determinism');
