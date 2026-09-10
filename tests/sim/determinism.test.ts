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

group('Identical inputs, identical state');

test('same seed and same commands produce identical state', () => {
  const a = new Simulation({ seed: 42, nearDeposits: 0.18 });
  const b = new Simulation({ seed: 42, nearDeposits: 0.18 });
  const depA = nearDeposit(a, 'regolith')!;
  const depB = nearDeposit(b, 'regolith')!;
  const amountBefore = depA.amount;
  a.issueMine(a.rovers[0].id, depA.id);
  b.issueMine(b.rovers[0].id, depB.id);
  // A quarter-sol covers travel, mining, power, life support and weather. More
  // elapsed time repeats the same deterministic tick contract without adding
  // another code path.
  run(a, 0.25);
  run(b, 0.25);
  assert.ok(depA.amount < amountBefore, 'precondition: the commanded mining run must do real work');
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
  assert.ok(Math.abs(steady.simTime - 60) < 1e-8, 'precondition: steady must execute 60 seconds');
  assert.ok(Math.abs(jittery.simTime - 60) < 1e-8, 'precondition: jittery must execute 60 seconds');
  assert.equal(
    JSON.stringify(steady.snapshot()),
    JSON.stringify(jittery.snapshot()),
    'variable frame pacing must not change the simulation',
  );
});

await finish('sim/determinism');
