/**
 * @suite sim/clock-system
 * @group unit
 * @covers src/sim/systems/ClockSystem.ts src/sim/clock.ts
 * @desc ClockSystem extraction Phase 4: fixed-step timing, remainder, tick count,
 * day/night state, accumulated time determinism.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { ClockSystem, CLOCK_MAX_TICKS } from '../../src/sim/systems/ClockSystem';
import { SIM_TICK, SOL_SECONDS } from '../../src/sim/config';
import { group, test, finish } from '../harness';

group('ClockSystem.consume');

test('1 second accumulates to 20 ticks at 20Hz', () => {
  const sim = new Simulation({ seed: 1 });
  const owed = ClockSystem.consume(sim.state, 1);
  assert.equal(owed, 20, '1s / SIM_TICK = 20');
  assert.ok(Math.abs(sim.state.remainder) < 1e-9, 'remainder ~0 after exact multiple');
});

test('10 seconds accumulates to 200 ticks', () => {
  const sim = new Simulation({ seed: 2 });
  const owed = ClockSystem.consume(sim.state, 10);
  assert.equal(owed, 200);
});

test('1 minute accumulates to 1200 ticks when delivered in chunks, capped in one frame', () => {
  const sim = new Simulation({ seed: 3 });
  // Single huge frame is capped to avoid freeze
  const capped = ClockSystem.consume(sim.state, 60);
  assert.equal(capped, CLOCK_MAX_TICKS, 'single huge frame capped');

  // Same 60s delivered as 60x1s yields 1200 ticks total
  const sim2 = new Simulation({ seed: 3 });
  let total = 0;
  for (let i = 0; i < 60; i++) {
    total += ClockSystem.consume(sim2.state, 1);
    // tick away the owed to reset remainder for next chunk
    for (let k = 0; k < 20; k++) ClockSystem.tick(sim2.state);
  }
  assert.equal(total, 1200, '60x1s = 1200 ticks');
});

test('ragged frame timing produces same total ticks as steady', () => {
  const steady = new Simulation({ seed: 10 });
  const jittery = new Simulation({ seed: 10 });

  // Steady: 60s in 20Hz steps
  let steadyTicks = 0;
  for (let i = 0; i < 1200; i++) {
    steadyTicks += ClockSystem.consume(steady.state, SIM_TICK);
    for (let t = 0; t < 1; t++) ClockSystem.tick(steady.state);
  }

  // Jittery: same 60s in uneven chunks
  let jitteryTicks = 0;
  let delivered = 0;
  const chunks = [1 / 30, 1 / 15, 1 / 60, 1 / 20, 0.1, 0.016, 0.033];
  let idx = 0;
  while (delivered < 60 - 1e-9) {
    const dt = Math.min(chunks[idx++ % chunks.length], 60 - delivered);
    jitteryTicks += ClockSystem.consume(jittery.state, dt);
    const owed = jitteryTicks - jittery.state.ticksRun;
    // Actually consume already advanced remainder, tick separately
    // We already counted ticks via consume, now tick them
    for (let k = 0; k < (jitteryTicks - jittery.state.ticksRun); k++) {
      // No-op, tick count handled below
    }
    delivered += dt;
  }
  // Reset and do proper loop
  const a = new Simulation({ seed: 10 });
  const b = new Simulation({ seed: 10 });
  for (let i = 0; i < 1200; i++) a.step(1 / 20);
  let del = 0;
  let ci = 0;
  while (del < 60 - 1e-9) {
    const dt = Math.min(chunks[ci++ % chunks.length], 60 - del);
    b.step(dt);
    del += dt;
  }
  assert.equal(a.state.ticksRun, b.state.ticksRun, 'ticksRun identical');
  assert.ok(Math.abs(a.state.simTime - b.state.simTime) < 1e-8, 'simTime identical');
  assert.ok(Math.abs(a.state.simTime - 60) < 1e-8);
});

test('accumulated remainder is preserved across frames', () => {
  const sim = new Simulation({ seed: 5 });
  // Deliver 0.03s — not a multiple of SIM_TICK (0.05)
  let owed = ClockSystem.consume(sim.state, 0.03);
  assert.equal(owed, 0, '0.03 < 0.05 => 0 ticks');
  assert.ok(Math.abs(sim.state.remainder - 0.03) < 1e-9);
  // Deliver another 0.03 => total 0.06 => 1 tick, remainder 0.01
  owed = ClockSystem.consume(sim.state, 0.03);
  assert.equal(owed, 1);
  assert.ok(Math.abs(sim.state.remainder - 0.01) < 1e-9);
});

test('max ticks cap prevents freeze on background tab', () => {
  const sim = new Simulation({ seed: 6 });
  const owed = ClockSystem.consume(sim.state, 1000); // huge dt
  assert.equal(owed, CLOCK_MAX_TICKS, 'capped at max');
  assert.equal(sim.state.remainder, 0, 'remainder dropped on cap');
});

test('invalid dt returns 0 and does not mutate remainder', () => {
  const sim = new Simulation({ seed: 7 });
  sim.state.remainder = 0.02;
  assert.equal(ClockSystem.consume(sim.state, 0), 0);
  assert.equal(ClockSystem.consume(sim.state, -1), 0);
  assert.equal(ClockSystem.consume(sim.state, NaN), 0);
  assert.equal(ClockSystem.consume(sim.state, Infinity), 0);
  assert.ok(Math.abs(sim.state.remainder - 0.02) < 1e-9, 'remainder unchanged');
});

group('ClockSystem.tick');

test('tick advances simTime by SIM_TICK and increments ticksRun', () => {
  const sim = new Simulation({ seed: 8 });
  const beforeTime = sim.state.simTime;
  const beforeTicks = sim.state.ticksRun;
  ClockSystem.tick(sim.state);
  assert.ok(Math.abs(sim.state.simTime - (beforeTime + SIM_TICK)) < 1e-9);
  assert.equal(sim.state.ticksRun, beforeTicks + 1);
});

test('tick advances sol clock and detects new sol', () => {
  const sim = new Simulation({ seed: 9 });
  sim.state.clock.restore({ sol: 0, frac: 0.99 });
  const rolled = ClockSystem.tick(sim.state);
  // 0.99 + SIM_TICK/SOL_SECONDS = 0.99 + 0.05/240 = 0.990208... not yet rollover
  // Force near edge
  sim.state.clock.restore({ sol: 0, frac: 0.9999 });
  const rolled2 = ClockSystem.tick(sim.state);
  assert.equal(typeof rolled, 'boolean');
  // After enough ticks, sol should increment
  sim.state.clock.restore({ sol: 2, frac: 0.999 });
  let newSolSeen = false;
  for (let i = 0; i < 100; i++) {
    if (ClockSystem.tick(sim.state)) {
      newSolSeen = true;
      break;
    }
  }
  assert.ok(newSolSeen, 'new sol eventually');
});

test('setTime jumps calendar and syncs simTime', () => {
  const sim = new Simulation({ seed: 11 });
  ClockSystem.setTime(sim.state, 5, 0.5);
  assert.equal(sim.state.clock.sol, 5);
  assert.ok(Math.abs(sim.state.clock.frac - 0.5) < 1e-9);
  // simTime = (sol+frac - START_FRAC)*SOL_SECONDS
  assert.ok(sim.state.simTime >= 0);
  assert.ok(Number.isFinite(sim.state.simTime));
});

test('snapshot/restore round-trip preserves time', () => {
  const sim = new Simulation({ seed: 12 });
  sim.step(10);
  const snap = ClockSystem.snapshot(sim.state);
  const sim2 = new Simulation({ seed: 12 });
  ClockSystem.restore(sim2.state, snap);
  assert.equal(sim2.state.simTime, snap.simTime);
  assert.equal(sim2.state.ticksRun, snap.ticksRun);
  assert.equal(sim2.state.clock.sol, snap.clock.sol);
  assert.ok(Math.abs(sim2.state.clock.frac - snap.clock.frac) < 1e-9);
  assert.equal(sim2.state.remainder, 0, 'remainder reset on restore');
});

test('Simulation.step still deterministic after extraction', () => {
  const a = new Simulation({ seed: 42 });
  const b = new Simulation({ seed: 42 });
  a.step(1);
  b.step(1);
  assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()));
  a.step(10);
  b.step(5);
  b.step(5);
  assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()), '1x10 vs 2x5 identical');
});

await finish('sim/clock-system');
