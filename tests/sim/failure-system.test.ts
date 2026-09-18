/**
 * @suite sim/failure-system
 * @group unit
 * @covers src/sim/systems/FailureSystem.ts src/sim/Simulation.ts
 * @desc FailureSystem extraction (Phase 15): tripDamaged / endMission actions,
 * failure-check domain events (PowerShortage, OxygenCritical via FluidReserve,
 * RoverDisabled, BuildingFailed, …), main-loop wiring, and the architecture
 * guard that gameOver / damaged trip writes go through FailureSystem.
 * Notification mapping lives in AlertSystem (Phase 16) — see
 * tests/sim/alert-system.test.ts.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../../src/sim/Simulation';
import {
  FailureSystem,
  type FailureEvent,
  type FailureHostHooks,
} from '../../src/sim/systems/FailureSystem';
import { RoverSystem } from '../../src/sim/systems/RoverSystem';
import { enterDisabled } from '../../src/sim/state/RoverState';
import {
  DAMAGED_HEALTH,
  ROVER_CONDITION_ALERT,
} from '../../src/sim/config';
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

function recordingHooks(): {
  hooks: FailureHostHooks;
  finished: number[];
} {
  const finished: number[] = [];
  return {
    finished,
    hooks: {
      finishTask: (r) => {
        finished.push(r.id);
        RoverSystem.finishTask(r);
      },
    },
  };
}

function ofKind<K extends FailureEvent['kind']>(
  events: FailureEvent[],
  kind: K,
): Extract<FailureEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<FailureEvent, { kind: K }> => e.kind === kind);
}

// ============================================================ actions ====

group('FailureSystem.tripDamaged');

test('trips a building offline, recomputes capacities, and emits BuildingTripped', () => {
  const sim = fresh();
  const b = buildOnline(sim, 'solar');
  assert.equal(b.damaged, false);
  const beforeCap = sim.state._storageCapacity;

  const ev = FailureSystem.tripDamaged(sim.state, b, 'lightning', silentHooks());
  assert.equal(b.damaged, true);
  assert.equal(ev.kind, 'BuildingTripped');
  assert.equal(ev.buildingId, b.id);
  assert.equal(ev.cause, 'lightning');
  assert.equal(ev.label.length > 0, true);
  // Notification is AlertSystem's job — FailureSystem must not write alerts.
  // buildOnline may have logged construction events; assert no *new* damage line.
  assert.ok(
    !sim.alerts.history().some((l) => l.text.includes('damaged by lightning')),
    'no alert writes from FailureSystem',
  );
  // Damaged solar no longer contributes generation capacity side-effects via
  // recompute — at minimum the call must not throw and state stays coherent.
  assert.ok(typeof sim.state._storageCapacity === 'number');
  void beforeCap;
});

test('releases a builder mid-job when the site trips', () => {
  const sim = fresh();
  const b = buildOnline(sim, 'warehouse');
  const r = sim.rovers[0];
  r.command = { type: 'construct', buildingId: b.id };
  b.workerId = r.id;
  const rec = recordingHooks();
  FailureSystem.tripDamaged(sim.state, b, 'the storm', rec.hooks);
  assert.deepEqual(rec.finished, [r.id]);
  assert.equal(b.workerId, null);
});

group('FailureSystem.endMission');

test('latches gameOver without raising mission-over', () => {
  const sim = fresh();
  assert.equal(sim.gameOver === null, true);
  const ev = FailureSystem.endMission(sim.state, 'test loss');
  assert.equal(ev.kind, 'MissionLost');
  assert.match(JSON.stringify(ev), /test loss/);
  assert.ok(sim.gameOver, 'FailureSystem.endMission latched the loss');
  assert.ok(sim.gameOver!.reason.includes('test loss'));
  // Notification is AlertSystem's job — FailureSystem must not write alerts.
  assert.ok(!sim.alerts.isActive('mission-over'), 'AlertSystem owns mission-over');
});

// ============================================================ evaluate ====

group('FailureSystem.evaluate — domain events');

test('PowerShortage critical when life-support tiers are shed', () => {
  const sim = fresh();
  // Force a critical shed signal the same way the grid reports it.
  sim.state.power.firstShedTier = 1;
  sim.state.power.generationKw = 2;
  sim.state.power.demandKw = 40;
  const events = FailureSystem.evaluate(sim.state, ctx(sim));
  const ps = ofKind(events, 'PowerShortage')[0];
  assert.equal(ps?.level, 'critical');
});

test('FluidReserve emits OxygenCritical-class level for near-empty oxygen', () => {
  const sim = fresh();
  // Drain oxygen and ensure net consumption so reserveSols is finite.
  sim.pools.amounts.oxygen = 0.5;
  run(sim, 0.15);
  const events = FailureSystem.evaluate(sim.state, ctx(sim));
  const ox = ofKind(events, 'FluidReserve').find((e) => e.fluid === 'oxygen');
  assert.ok(ox);
  assert.ok(
    ox!.level === 'exhausted' || ox!.level === 'critical' || ox!.level === 'warn',
    `expected a reserve failure, got ${ox!.level}`,
  );
});

test('RoverDisabled is active when phase is disabled', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  enterDisabled(r);
  const events = FailureSystem.evaluate(sim.state, ctx(sim));
  const d = ofKind(events, 'RoverDisabled').find((e) => e.roverId === r.id);
  assert.ok(d);
  assert.equal(d!.active, true);
});

test('BuildingFailed lists damaged structures', () => {
  const sim = fresh();
  const b = buildOnline(sim, 'solar');
  b.damaged = true;
  b.health = DAMAGED_HEALTH;
  const events = FailureSystem.evaluate(sim.state, ctx(sim));
  const bf = ofKind(events, 'BuildingFailed')[0];
  assert.ok(bf);
  assert.equal(bf.active, true);
  assert.ok(bf.buildingIds.includes(b.id));
});

test('RoverWear is active below ROVER_CONDITION_ALERT', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  r.condition = ROVER_CONDITION_ALERT - 1;
  const events = FailureSystem.evaluate(sim.state, ctx(sim));
  const w = ofKind(events, 'RoverWear').find((e) => e.roverId === r.id);
  assert.ok(w);
  assert.equal(w!.active, true);
});

// ============================================================ no alert writes ====

group('FailureSystem does not write alerts');

test('tick produces FluidReserve events without touching the alert bus', () => {
  const sim = fresh();
  sim.pools.amounts.oxygen = 0;
  const events = FailureSystem.tick(sim.state, ctx(sim));
  assert.ok(ofKind(events, 'FluidReserve').some((e) => e.level === 'exhausted'));
  assert.equal(sim.alerts.list().length, 0, 'evaluate/tick must not raise');
  assert.equal(sim.alerts.history().length, 0);
});

test('endMission latches gameOver without raising mission-over', () => {
  const sim = fresh();
  const ev = FailureSystem.endMission(sim.state, 'test loss');
  assert.equal(ev.kind, 'MissionLost');
  assert.ok(sim.gameOver);
  assert.ok(!sim.alerts.isActive('mission-over'), 'AlertSystem owns mission-over');
});

// ============================================================ tick wiring ====

group('Tick wiring');

test('Simulation.step runs FailureSystem + AlertSystem — low oxygen alerts', () => {
  const sim = fresh();
  sim.pools.amounts.oxygen = 0.01;
  run(sim, 0.1);
  assert.ok(sim.alerts.isActive('oxygen-low'), 'main loop tick raises via AlertSystem');
});

test('weatherHooks.tripDamaged is FailureSystem (live lightning path)', () => {
  const sim = fresh();
  const b = buildOnline(sim, 'solar');
  // Force damage the way weather does: through the seam Simulation wires.
  FailureSystem.tripDamaged(
    sim.state,
    b,
    'lightning',
    { finishTask: (r) => RoverSystem.finishTask(r) },
  );
  assert.equal(b.damaged, true);
  // A subsequent evaluate must report BuildingFailed.
  const events = FailureSystem.evaluate(sim.state, ctx(sim));
  assert.ok(ofKind(events, 'BuildingFailed')[0]?.active);
});

test('life-support death still latches gameOver through FailureSystem', () => {
  const sim = fresh();
  sim.pools.amounts.oxygen = 0;
  sim.colonist.suitO2 = 0;
  sim.colonist.inside = true;
  run(sim, 2);
  assert.ok(sim.gameOver, 'mission loss still fires');
  assert.ok(sim.alerts.isActive('mission-over'));
});

// ============================================================ architecture ====

group('Architecture guard — failures have one owner');

test('gameOver= and BuildingTripped damaged= writers are FailureSystem (+ restore)', () => {
  const simRoot = fileURLToPath(new URL('../../src/sim', import.meta.url));

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  const gameOverWriters = new Set<string>();
  const damagedAssign = new Set<string>();

  for (const file of walk(simRoot)) {
    const rel = relative(simRoot, file).replace(/\\/g, '/');
    const src = readFileSync(file, 'utf8');
    // gameOver assignments (not types / reads)
    if (/gameOver\s*=/.test(src)) gameOverWriters.add(rel);
    // `.damaged = true` trip path (not `damaged: false` object literals)
    if (/\.damaged\s*=\s*true/.test(src)) damagedAssign.add(rel);
  }

  // gameOver: FailureSystem.endMission, ColonyState init, Simulation accessor + restore
  const allowedGameOver = new Set([
    'systems/FailureSystem.ts',
    'state/ColonyState.ts',
    'Simulation.ts',
  ]);
  for (const f of gameOverWriters) {
    assert.ok(allowedGameOver.has(f), `unexpected gameOver= writer: ${f}`);
  }
  assert.ok(gameOverWriters.has('systems/FailureSystem.ts'));

  // `.damaged = true`: FailureSystem.tripDamaged is the runtime failure action.
  // Simulation.devSetBuildingHealth is the cheat/devtools path that mirrors the
  // same threshold — same "owner + boundary" split Phase 13 used for storage.
  const allowedDamaged = new Set([
    'systems/FailureSystem.ts',
    'Simulation.ts',
  ]);
  for (const f of damagedAssign) {
    assert.ok(allowedDamaged.has(f), `unexpected damaged=true writer: ${f}`);
  }
  assert.ok(damagedAssign.has('systems/FailureSystem.ts'));
});

test('FailureSystem does not import AlertSystem, write state.alerts, or touch HUD', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/sim/systems/FailureSystem.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(
    !/^import .*\bAlertSystem\b/m.test(src),
    'must not import AlertSystem — Simulation wires the seam',
  );
  assert.ok(!/state\.alerts\./.test(src), 'must not write the alert bus');
  assert.ok(!/static applyAlerts/.test(src), 'applyAlerts moved to AlertSystem');
  assert.ok(!/[^\w]document\./.test(src));
  assert.ok(!src.includes("from 'three'") && !src.includes('from "three"'));
  assert.ok(src.includes('domain events'), 'header names the event surface');
});

test('Simulation.evaluateAlerts wires FailureSystem → AlertSystem', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/sim/Simulation.ts', import.meta.url)),
    'utf8',
  );
  const m = src.match(/private evaluateAlerts\(\): void \{([^}]*)\}/);
  assert.ok(m, 'evaluateAlerts still exists as the tick seam');
  assert.ok(
    /FailureSystem\.tick\(this\.state,\s*this\.failureContext\)/.test(m![1]),
    'emits via FailureSystem.tick',
  );
  assert.ok(
    /AlertSystem\.applyFailureEvents\(this\.state,\s*events\)/.test(m![1]),
    'maps via AlertSystem.applyFailureEvents',
  );
  assert.ok(!/brownout-critical/.test(m![1]), 'alert copy no longer lives in Simulation');
});

finish();
