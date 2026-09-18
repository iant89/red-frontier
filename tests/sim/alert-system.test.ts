/**
 * @suite sim/alert-system
 * @group unit
 * @covers src/sim/systems/AlertSystem.ts src/sim/systems/FailureSystem.ts src/sim/Simulation.ts
 * @desc AlertSystem extraction (Phase 16): FailureEvent → state.alerts mapping
 * (keys, copy, raise/clear, hysteresis), BuildingTripped / MissionLost
 * notification ownership, main-loop wiring, and the guard that FailureSystem
 * no longer writes the alert bus.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../../src/sim/Simulation';
import {
  FailureSystem,
  type FailureEvent,
  type FailureHostHooks,
} from '../../src/sim/systems/FailureSystem';
import { AlertSystem } from '../../src/sim/systems/AlertSystem';
import { RoverSystem } from '../../src/sim/systems/RoverSystem';
import { enterDisabled } from '../../src/sim/state/RoverState';
import { SUIT_O2_CAPACITY } from '../../src/sim/config';
import { run, buildOnline } from '../fixtures/sim';
import { group, test, finish } from '../harness';

function fresh(seed = 61): Simulation {
  const sim = new Simulation({ seed, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  return sim;
}

function ctx(sim: Simulation) {
  return {
    reserveSols: (f: Parameters<Simulation['reserveSols']>[0]) => sim.reserveSols(f),
    runnable: (b: { state: string; damaged: boolean }) =>
      b.state === 'online' && !b.damaged,
  };
}

function silentHooks(): FailureHostHooks {
  return { finishTask: () => {} };
}

// ============================================================ applyFailureEvents ====

group('AlertSystem.applyFailureEvents');

test('oxygen exhaustion raises oxygen-low exactly once', () => {
  const sim = fresh();
  sim.pools.amounts.oxygen = 0;
  const events = FailureSystem.tick(sim.state, ctx(sim));
  AlertSystem.applyFailureEvents(sim.state, events);
  assert.ok(sim.alerts.isActive('oxygen-low'));
  const raised = sim.alerts.list().filter((a) => a.key === 'oxygen-low');
  assert.equal(raised.length, 1);
});

test('clearing oxygen restores clears the alert', () => {
  const sim = fresh();
  sim.pools.amounts.oxygen = 0;
  AlertSystem.applyFailureEvents(sim.state, FailureSystem.tick(sim.state, ctx(sim)));
  assert.ok(sim.alerts.isActive('oxygen-low'));
  sim.pools.amounts.oxygen = sim.pools.capacity.oxygen;
  AlertSystem.applyFailureEvents(sim.state, FailureSystem.tick(sim.state, ctx(sim)));
  assert.ok(!sim.alerts.isActive('oxygen-low'), 'refill clears via AlertSystem');
});

test('stranded rover raises rover-dead-*', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  enterDisabled(r);
  AlertSystem.applyFailureEvents(sim.state, FailureSystem.tick(sim.state, ctx(sim)));
  assert.ok(sim.alerts.isActive(`rover-dead-${r.id}`));
});

test('suit oxygen low raises suit-o2', () => {
  const sim = fresh();
  const c = sim.colonist;
  c.inside = false;
  c.suitO2 = SUIT_O2_CAPACITY * 0.1;
  AlertSystem.applyFailureEvents(sim.state, FailureSystem.tick(sim.state, ctx(sim)));
  assert.ok(sim.alerts.isActive('suit-o2'));
});

test('BuildingTripped emits the crit log line (moved from tripDamaged)', () => {
  const sim = fresh();
  const b = buildOnline(sim, 'solar');
  const before = sim.alerts.history().length;
  const ev = FailureSystem.tripDamaged(sim.state, b, 'lightning', silentHooks());
  assert.equal(sim.alerts.history().length, before, 'FailureSystem alone is silent');
  assert.ok(!sim.alerts.history().some((l) => l.text.includes('damaged by lightning')));
  AlertSystem.applyFailureEvents(sim.state, [ev]);
  assert.ok(
    sim.alerts.history().some((l) => l.text.includes('damaged by lightning')),
    'crit log line',
  );
});

test('MissionLost raises mission-over (moved from endMission)', () => {
  const sim = fresh();
  const ev = FailureSystem.endMission(sim.state, 'test loss');
  assert.ok(!sim.alerts.isActive('mission-over'));
  AlertSystem.applyFailureEvents(sim.state, [ev]);
  assert.ok(sim.alerts.isActive('mission-over'));
  const a = sim.alerts.list().find((x) => x.key === 'mission-over');
  assert.equal(a?.detail, 'test loss');
});

test('PowerShortage critical raises brownout-critical with preserved copy', () => {
  const sim = fresh();
  const events: FailureEvent[] = [
    {
      kind: 'PowerShortage',
      level: 'critical',
      generationKw: 1.5,
      demandKw: 4.2,
    },
  ];
  AlertSystem.applyFailureEvents(sim.state, events);
  assert.ok(sim.alerts.isActive('brownout-critical'));
  const a = sim.alerts.list().find((x) => x.key === 'brownout-critical');
  assert.match(a!.detail, /1\.5 kW vs 4\.2 kW/);
});

test('re-raise refreshes without duplicating (hysteresis / dedupe)', () => {
  const sim = fresh();
  sim.pools.amounts.oxygen = 0;
  const events = FailureSystem.tick(sim.state, ctx(sim));
  AlertSystem.applyFailureEvents(sim.state, events);
  const before = sim.alerts.history().filter((l) => l.text.includes('Oxygen')).length;
  AlertSystem.applyFailureEvents(sim.state, events);
  AlertSystem.applyFailureEvents(sim.state, events);
  const after = sim.alerts.history().filter((l) => l.text.includes('Oxygen')).length;
  assert.equal(after, before, 'dedupe: re-raise must not spam the log');
  assert.equal(sim.alerts.list().filter((a) => a.key === 'oxygen-low').length, 1);
});

// ============================================================ tick wiring ====

group('Tick wiring');

test('Simulation.step raises oxygen-low through AlertSystem', () => {
  const sim = fresh();
  sim.pools.amounts.oxygen = 0.01;
  run(sim, 0.1);
  assert.ok(sim.alerts.isActive('oxygen-low'));
});

test('weatherHooks.tripDamaged notifies via AlertSystem', () => {
  const sim = fresh();
  const b = buildOnline(sim, 'solar');
  // Use the same seam Simulation wires for weather.
  const hooks = {
    finishTask: (r: Parameters<typeof RoverSystem.finishTask>[0]) => RoverSystem.finishTask(r),
  };
  const ev = FailureSystem.tripDamaged(sim.state, b, 'lightning', hooks);
  AlertSystem.applyFailureEvents(sim.state, [ev]);
  assert.ok(sim.alerts.history().some((l) => l.text.includes('damaged by lightning')));
});

test('life-support death raises mission-over through the wired seam', () => {
  const sim = fresh();
  sim.pools.amounts.oxygen = 0;
  sim.colonist.suitO2 = 0;
  sim.colonist.inside = true;
  run(sim, 2);
  assert.ok(sim.gameOver, 'mission loss still fires');
  assert.ok(sim.alerts.isActive('mission-over'));
});

// ============================================================ architecture ====

group('Architecture guard — alerts have one failure-event owner');

test('AlertSystem owns applyFailureEvents; FailureSystem has no applyAlerts', () => {
  const alertSrc = readFileSync(
    fileURLToPath(new URL('../../src/sim/systems/AlertSystem.ts', import.meta.url)),
    'utf8',
  );
  const failSrc = readFileSync(
    fileURLToPath(new URL('../../src/sim/systems/FailureSystem.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(alertSrc.includes('static applyFailureEvents'));
  assert.ok(alertSrc.includes('brownout-critical'), 'alert copy lives in AlertSystem');
  assert.ok(!failSrc.includes('static applyAlerts'));
  assert.ok(!/state\.alerts\./.test(failSrc));
  assert.ok(!/[^\w]document\./.test(alertSrc));
  assert.ok(!alertSrc.includes("from 'three'") && !alertSrc.includes('from "three"'));
});

test('AlertSystem does not own failure actions', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/sim/systems/AlertSystem.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(!src.includes('static tripDamaged'));
  assert.ok(!src.includes('static endMission'));
  assert.ok(!/gameOver\s*=/.test(src));
  assert.ok(!/\.damaged\s*=\s*true/.test(src));
});

finish();
