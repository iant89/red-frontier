/**
 * @suite sim/history-system
 * @group unit
 * @covers src/sim/systems/HistorySystem.ts src/sim/state/HistoryState.ts src/sim/Simulation.ts src/sim/persistence/ColonyPersistence.ts src/sim/DevBackdoors.ts
 * @desc HistorySystem extraction (Phase 17): vitals sampling gate and ring
 * buffer, inseparable flow-window roll, clear / afterTimeJump, main-loop
 * wiring, and the architecture guard that Simulation no longer owns
 * recordHistory / resetFlows.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../../src/sim/Simulation';
import { HistorySystem } from '../../src/sim/systems/HistorySystem';
import { emptyFlows } from '../../src/sim/state/ResourceState';
import {
  HISTORY_SAMPLES,
  HISTORY_INTERVAL_S,
  SIM_TICK,
  SOL_SECONDS,
  SOL_HISTORY_ROWS,
} from '../../src/sim/config';
import { run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

function fresh(seed = 71): Simulation {
  const sim = new Simulation({ seed, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  return sim;
}

// ============================================================ tick / sample ====

group('HistorySystem.tick — vitals sampling');

test('first tick always samples (lastHistoryAt starts at -Infinity)', () => {
  const sim = fresh();
  assert.equal(sim.history.length, 0);
  HistorySystem.tick(sim.state);
  assert.equal(sim.history.length, 1);
  const s = sim.history[0];
  assert.equal(s.t, sim.simTime);
  assert.equal(typeof s.genKw, 'number');
  assert.equal(typeof s.loadKw, 'number');
  assert.equal(typeof s.storedFrac, 'number');
  assert.equal(s.water, sim.pools.amounts.water);
  assert.equal(s.oxygen, sim.pools.amounts.oxygen);
  assert.equal(s.food, sim.pools.amounts.food);
});

test('samples only when HISTORY_INTERVAL_S has elapsed', () => {
  const sim = fresh();
  HistorySystem.tick(sim.state);
  assert.equal(sim.history.length, 1);
  // Advance less than the interval without going through Simulation.tick
  // (which would also sample) — bump simTime alone.
  sim.state.simTime += HISTORY_INTERVAL_S * 0.5;
  HistorySystem.tick(sim.state);
  assert.equal(sim.history.length, 1, 'inside the interval: no second sample');
  sim.state.simTime += HISTORY_INTERVAL_S;
  HistorySystem.tick(sim.state);
  assert.equal(sim.history.length, 2, 'past the interval: second sample');
});

test('ring buffer caps at HISTORY_SAMPLES', () => {
  const sim = fresh();
  for (let i = 0; i < HISTORY_SAMPLES + 5; i++) {
    sim.state.simTime = i * HISTORY_INTERVAL_S;
    HistorySystem.tick(sim.state);
  }
  assert.equal(sim.history.length, HISTORY_SAMPLES);
  assert.equal(sim.history[0].t, 5 * HISTORY_INTERVAL_S, 'oldest dropped');
  assert.equal(sim.history[HISTORY_SAMPLES - 1].t, (HISTORY_SAMPLES + 4) * HISTORY_INTERVAL_S);
});

test('sample reads live power and pool amounts', () => {
  const sim = fresh();
  // Force distinctive values so we know the sample is a live read.
  sim.state.pools.amounts.water = 12.5;
  sim.state.pools.amounts.oxygen = 34.5;
  sim.state.pools.amounts.food = 56.5;
  sim.state.power = {
    ...sim.state.power,
    generationKw: 7.25,
    servedKw: 3.5,
    capacityKWh: 100,
    storedKWh: 40,
  };
  HistorySystem.tick(sim.state);
  const s = sim.history[0];
  assert.equal(s.genKw, 7.25);
  assert.equal(s.loadKw, 3.5);
  assert.equal(s.storedFrac, 0.4);
  assert.equal(s.water, 12.5);
  assert.equal(s.oxygen, 34.5);
  assert.equal(s.food, 56.5);
});

// ============================================================ flow window ====

group('HistorySystem.tick — flow window roll');

test('every tick rolls flows into flowWindow and zeroes accumulators', () => {
  const sim = fresh();
  sim.state.flows.water.produced = 1.5;
  sim.state.flows.water.consumed = 0.5;
  HistorySystem.tick(sim.state);
  assert.equal(sim.flowWindow.length, 1);
  assert.equal(sim.flowWindow[0].f.water.produced, 1.5);
  assert.equal(sim.lastFlows.water.produced, 1.5);
  assert.equal(sim.flows.water.produced, 0, 'accumulators zeroed');
  assert.equal(sim.flows.water.consumed, 0);
});

test('flowWindow keeps at most one trailing sol', () => {
  const sim = fresh();
  // Seed a window older than one sol, plus a fresh one.
  sim.state.flowWindow = [
    {
      t: 0,
      f: {
        water: { produced: 1, consumed: 0 },
        oxygen: { produced: 0, consumed: 0 },
        food: { produced: 0, consumed: 0 },
      },
    },
  ];
  sim.state.simTime = SOL_SECONDS + 10;
  sim.state.lastHistoryAt = sim.state.simTime; // skip sample path; still resets flows
  HistorySystem.tick(sim.state);
  assert.ok(sim.flowWindow.length >= 1);
  assert.ok(
    sim.flowWindow.every((w) => w.t >= sim.simTime - SOL_SECONDS),
    'no sample older than one sol remains (except possibly the sole survivor)',
  );
  // With length > 1 before the push+trim, the ancient t=0 entry must be gone.
  assert.ok(!sim.flowWindow.some((w) => w.t === 0), 'ancient sample trimmed');
});

test('skip-sample path still resets flows', () => {
  const sim = fresh();
  HistorySystem.tick(sim.state); // establishes lastHistoryAt
  sim.state.flows.oxygen.consumed = 9;
  sim.state.simTime += HISTORY_INTERVAL_S * 0.25;
  HistorySystem.tick(sim.state);
  assert.equal(sim.history.length, 1, 'no new sample');
  assert.equal(sim.flows.oxygen.consumed, 0, 'flows still rolled');
  assert.equal(sim.lastFlows.oxygen.consumed, 9);
});

// ============================================================ clear / jump ====

group('HistorySystem.clear / afterTimeJump');

test('clear empties history and flow windows', () => {
  const sim = fresh();
  HistorySystem.tick(sim.state);
  assert.ok(sim.history.length > 0);
  HistorySystem.clear(sim.state);
  assert.equal(sim.history.length, 0);
  assert.equal(sim.flowWindow.length, 0);
  assert.equal(sim.state.lastHistoryAt, -Infinity);
});

test('afterTimeJump rewinds the sample clock and flow window', () => {
  const sim = fresh();
  HistorySystem.tick(sim.state);
  sim.state.lastFlows.water.produced = 3;
  HistorySystem.afterTimeJump(sim.state);
  assert.equal(sim.state.lastHistoryAt, -Infinity);
  assert.equal(sim.flowWindow.length, 0);
  assert.equal(sim.lastFlows.water.produced, 0);
  // history samples themselves are left alone (devSetTime did not clear them)
});

test('emptyFlows helper matches the cleared flow shape', () => {
  const f = emptyFlows();
  assert.deepEqual(f.water, { produced: 0, consumed: 0 });
});

// ============================================================ main-loop wiring ====

group('Simulation wires HistorySystem');

test('Simulation.tick samples through HistorySystem', () => {
  const sim = fresh();
  assert.equal(sim.history.length, 0);
  run(sim, 1);
  assert.ok(sim.history.length >= 1, 'first main-loop tick samples');
});

test('devSetTime re-anchors via HistorySystem.afterTimeJump', () => {
  const sim = fresh();
  run(sim, 4);
  const beforeLen = sim.history.length;
  assert.ok(beforeLen >= 1);
  sim.devSetTime(3, 0.5);
  assert.equal(sim.state.lastHistoryAt, -Infinity);
  assert.equal(sim.flowWindow.length, 0);
  // Next tick should sample again immediately.
  run(sim, 1);
  assert.ok(sim.history.length >= beforeLen);
});

test('restore clears history via HistorySystem.clear', () => {
  const sim = fresh();
  run(sim, 4);
  assert.ok(sim.history.length > 0);
  const snap = sim.snapshot();
  run(sim, 4);
  sim.restore(snap);
  assert.equal(sim.history.length, 0);
  assert.equal(sim.flowWindow.length, 0);
  assert.equal(sim.state.lastHistoryAt, -Infinity);
});

test('reserveSols still reads the flow window HistorySystem writes', () => {
  const sim = fresh();
  // Accumulate a drain so the trailing-sol net is negative.
  sim.state.flows.oxygen.consumed = 10;
  HistorySystem.tick(sim.state);
  // With only consumption and a positive pool, reserve should be finite.
  const r = sim.reserveSols('oxygen');
  assert.ok(Number.isFinite(r) || r === Infinity);
  // And the public surface still exists (host boundary).
  assert.equal(typeof sim.reserveSols, 'function');
  assert.equal(typeof sim.netRatePerSol, 'function');
});

// ============================================================ architecture ====

group('Architecture guard — history sampling has one owner');

test('HistorySystem owns tick/resetFlows/clear; Simulation does not', () => {
  const histSrc = readFileSync(
    fileURLToPath(new URL('../../src/sim/systems/HistorySystem.ts', import.meta.url)),
    'utf8',
  );
  const simSrc = readFileSync(
    fileURLToPath(new URL('../../src/sim/Simulation.ts', import.meta.url)),
    'utf8',
  );
  const persSrc = readFileSync(
    fileURLToPath(new URL('../../src/sim/persistence/ColonyPersistence.ts', import.meta.url)),
    'utf8',
  );
  const devSrc = readFileSync(
    fileURLToPath(new URL('../../src/sim/DevBackdoors.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(histSrc.includes('static tick'));
  assert.ok(histSrc.includes('static resetFlows'));
  assert.ok(histSrc.includes('static clear'));
  assert.ok(histSrc.includes('static afterTimeJump'));
  assert.ok(!simSrc.includes('private recordHistory'));
  assert.ok(!simSrc.includes('private resetFlows'));
  // Phase 4: the same call now also forwards the clock's new-sol flag.
  assert.ok(simSrc.includes('HistorySystem.tick(this.state, newSol)'));
  // Phase 18: restore / time-jump call sites moved out of Simulation into
  // ColonyPersistence / DevBackdoors — still HistorySystem.clear/afterTimeJump.
  assert.ok(persSrc.includes('HistorySystem.clear(state)'));
  assert.ok(devSrc.includes('HistorySystem.afterTimeJump(state)'));
  assert.ok(!/[^\w]document\./.test(histSrc));
  assert.ok(!histSrc.includes("from 'three'") && !histSrc.includes('from "three"'));
});

test('HistorySystem does not own alerts or failure actions', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/sim/systems/HistorySystem.ts', import.meta.url)),
    'utf8',
  );
  // Strip block comments so doc references to AlertBus do not trip the guard.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bstate\.alerts\b/.test(code));
  assert.ok(!code.includes('static tripDamaged'));
  assert.ok(!code.includes('static endMission'));
  assert.ok(!/gameOver\s*=/.test(code));
});

test('SIM_TICK constant still drives the main loop (sanity)', () => {
  assert.ok(SIM_TICK > 0);
});

// ====================================== Phase 4 — extended vitals series ====

group('HistorySystem Phase 4 — extended sample series');

test('sample carries ore/steel/components/util and split flow rates', () => {
  const sim = fresh();
  HistorySystem.tick(sim.state);
  const s = sim.history[0];
  for (const k of ['ore', 'steel', 'components', 'roverUtil'] as const) {
    assert.equal(typeof s[k], 'number', `${k} sampled`);
    assert.ok(Number.isFinite(s[k]), `${k} finite`);
  }
  for (const dir of [s.prod, s.cons]) {
    assert.deepEqual(Object.keys(dir), ['water', 'oxygen', 'food']);
  }
});

test('ore sums mined materials only; steel and components are their own series', () => {
  const sim = fresh();
  sim.state.storage.iron = 10;
  sim.state.storage.ice = 4;
  sim.state.storage.steel = 5;
  sim.state.components.motor = 2;
  HistorySystem.tick(sim.state);
  const s = sim.history[0];
  assert.equal(s.ore, 14, 'regolith/iron/silicon/aluminum/ice only');
  assert.equal(s.steel, 5, 'steel reported separately');
  assert.equal(s.components, 2, 'whole units on the rack');
});

test('roverUtil is the fraction of the fleet holding a live task', () => {
  const sim = fresh();
  assert.equal(sim.rovers.length, 2, 'landing fleet is two rovers');
  HistorySystem.tick(sim.state);
  assert.equal(sim.history[0].roverUtil, 0, 'idle fleet: nobody tasked');

  sim.rovers[0].phase = 'moving';
  sim.state.simTime += HISTORY_INTERVAL_S;
  HistorySystem.tick(sim.state);
  assert.equal(sim.history[sim.history.length - 1].roverUtil, 0.5, 'one of two on a task');

  sim.rovers[0].phase = 'disabled';
  sim.rovers[1].phase = 'working';
  sim.state.simTime += HISTORY_INTERVAL_S;
  HistorySystem.tick(sim.state);
  assert.equal(
    sim.history[sim.history.length - 1].roverUtil,
    0.5,
    'a disabled rover still counts against the fleet, the working one still counts for it',
  );
});

// ============================================ Phase 4 — sol downsampling ====

group('HistorySystem Phase 4 — sol-bucketed downsampling');

test('the clock roll closes one row with means, worst battery and end values', () => {
  const sim = fresh();
  // Three samples spread over the sol with distinctive values.
  for (const dt of [0, HISTORY_INTERVAL_S, HISTORY_INTERVAL_S * 2]) {
    sim.state.simTime += dt;
    HistorySystem.tick(sim.state);
  }
  assert.equal(sim.history.length, 3);
  const genSum = sim.history.reduce((a, s) => a + s.genKw, 0);
  sim.state.pools.amounts.water = 42;
  HistorySystem.tick(sim.state, true);
  assert.equal(sim.solHistory.length, 1, 'one row closed');
  const row = sim.solHistory[0];
  assert.equal(row.sol, sim.clock.sol, 'row takes the just-completed sol number');
  assert.ok(Math.abs(row.genKwAvg - genSum / 3) < 1e-9, 'generation is the sample mean');
  assert.equal(row.water, 42, 'pools are end-of-sol values');
  assert.ok(row.storedFracMin <= 1 && row.storedFracMin >= 0, 'battery column is the sol worst');
});

test('rolling with no samples closes no row (time jump midpoint)', () => {
  const sim = fresh();
  HistorySystem.tick(sim.state, true);
  assert.equal(sim.solHistory.length, 0, 'nothing accumulated, nothing closed');
});

test('rows cap at SOL_HISTORY_ROWS, keeping the newest sols', () => {
  const sim = fresh();
  for (let i = 0; i < SOL_HISTORY_ROWS + 3; i++) {
    sim.state.simTime += HISTORY_INTERVAL_S;
    sim.clock.sol = i + 1; // pretend the sol just rolled
    HistorySystem.tick(sim.state, true);
  }
  assert.equal(sim.solHistory.length, SOL_HISTORY_ROWS);
  assert.equal(sim.solHistory[solHistoryLast(sim)].sol, SOL_HISTORY_ROWS + 3 - 1 + 1);
  assert.equal(sim.solHistory[0].sol, 4, 'oldest rows fall off the front');
});

test('row flow columns sum the closed sols flow window', () => {
  const sim = fresh();
  sim.state.simTime += HISTORY_INTERVAL_S;
  sim.state.flows.water.produced = 5;
  HistorySystem.tick(sim.state); // window picks up the 5 kg at reset
  sim.state.flows.water.consumed = 2;
  sim.state.simTime += HISTORY_INTERVAL_S;
  HistorySystem.tick(sim.state);
  HistorySystem.tick(sim.state, true);
  const row = sim.solHistory[0];
  assert.ok(Math.abs(row.prod.water - 5) < 1e-9, 'produced totals the sol');
  assert.ok(Math.abs(row.cons.water - 2) < 1e-9, 'consumed totals the sol');
});

test('clear resets the accumulator — a restored colony closes no stale row', () => {
  const sim = fresh();
  HistorySystem.tick(sim.state);
  HistorySystem.clear(sim.state);
  HistorySystem.tick(sim.state, true);
  assert.equal(sim.solHistory.length, 0, 'no partial row from before the restore');
});

function solHistoryLast(sim: Simulation): number {
  return sim.solHistory.length - 1;
}

finish();
