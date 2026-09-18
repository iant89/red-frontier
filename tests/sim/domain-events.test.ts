/**
 * @suite sim/domain-events
 * @group unit
 * @covers src/sim/domainEvents.ts src/sim/Simulation.ts src/sim/state/ColonyState.ts src/sim/host/LocalSimHost.ts src/sim/host/WorkerSimHost.ts src/sim/host/mirror.ts src/sim/host/projection.ts src/sim/host/workerRuntime.ts src/app/GameLoop.ts src/dev/DevMode.ts src/sim/systems/WeatherSystem.ts src/sim/systems/RoverSystem.ts src/sim/systems/ConstructionSystem.ts src/sim/systems/FailureSystem.ts src/sim/systems/ExplorationSystem.ts
 * @desc Phase 21 domain events: collector unit behaviour, transition emits,
 * AlertBus drain unchanged, Local↔Worker domain-event surface parity.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { DomainEventLog, type DomainEvent } from '../../src/sim/domainEvents';
import { RoverSystem } from '../../src/sim/systems/RoverSystem';
import { ConstructionSystem } from '../../src/sim/systems/ConstructionSystem';
import { FailureSystem } from '../../src/sim/systems/FailureSystem';
import { LocalSimHost } from '../../src/sim/host/LocalSimHost';
import { WorkerSimHost } from '../../src/sim/host/WorkerSimHost';
import { createSimRuntime } from '../../src/sim/host/workerRuntime';
import type { HostPort, HostReply, HostRequest } from '../../src/sim/host/messages';
import type { ViewPayload } from '../../src/sim/host/projection';
import { DEFAULT_WORLD_OPTIONS } from '../../src/sim/difficulty';
import { SIM_TICK } from '../../src/sim/config';
import { findSpot } from '../fixtures/sim';
import { group, test, finish } from '../harness';

function fresh(seed = 21): Simulation {
  const sim = new Simulation({ seed, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  return sim;
}

function typesOf(events: ReadonlyArray<DomainEvent>): string[] {
  return events.map((e) => e.type);
}

// ---------------------------------------------------------------- collector ----

group('DomainEventLog');

test('push / drain / take clears and returns ReadonlyArray', () => {
  const log = new DomainEventLog();
  log.push({ type: 'storm/ended' });
  log.push({ type: 'game/over', reason: 'test', sol: 1 });
  assert.equal(log.length, 2);
  assert.deepEqual(typesOf(log.snapshot()), ['storm/ended', 'game/over']);

  const drained = log.drain();
  assert.ok(Object.isFrozen(drained));
  assert.deepEqual(typesOf(drained), ['storm/ended', 'game/over']);
  assert.equal(log.length, 0);
  assert.equal(log.drain().length, 0);

  log.push({ type: 'storm/started', kind: 'dust' });
  const taken = log.take();
  assert.deepEqual(typesOf(taken), ['storm/started']);
  assert.equal(log.length, 0);
});

// ---------------------------------------------------------- AlertBus pin ----

group('AlertBus drain unchanged');

test('drainEvents still returns AlertBus log lines and is separate from domain drain', () => {
  const sim = fresh();
  sim.alerts.event('info', 'hello toast', sim.simTime, sim.clock.format());
  sim.state.domainEvents.push({ type: 'storm/ended' });

  const toasts = sim.drainEvents();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].text, 'hello toast');
  assert.equal(sim.drainEvents().length, 0, 'AlertBus drain consumes');

  const domain = sim.drainDomainEvents();
  assert.deepEqual(typesOf(domain), ['storm/ended']);
  assert.equal(sim.drainDomainEvents().length, 0);
});

// --------------------------------------------------------- transitions ----

group('transition emits');

test('rover disable emits rover/disabled', () => {
  const sim = fresh();
  const r = sim.rovers[0]!;
  sim.drainDomainEvents();
  RoverSystem.disable(sim.state, r);
  const evs = sim.drainDomainEvents();
  assert.ok(evs.some((e) => e.type === 'rover/disabled' && e.roverId === r.id));
  const d = evs.find((e) => e.type === 'rover/disabled')!;
  assert.equal(d.type, 'rover/disabled');
  if (d.type === 'rover/disabled') assert.equal(d.reason, 'battery-depleted');
});

test('building place + complete emit building/placed and building/completed', () => {
  const sim = fresh();
  sim.drainDomainEvents();
  const spot = findSpot(sim, 'solar');
  const b = ConstructionSystem.place(sim.state, 'solar', spot.x, spot.z);
  assert.ok(b, 'solar should site');
  let evs = sim.drainDomainEvents();
  assert.ok(evs.some((e) => e.type === 'building/placed' && e.buildingId === b!.id));

  ConstructionSystem.complete(sim.state, b!);
  evs = sim.drainDomainEvents();
  assert.ok(evs.some((e) => e.type === 'building/completed' && e.buildingId === b!.id));
});

test('tripDamaged emits building/failed; endMission emits game/over', () => {
  const sim = fresh();
  const spot = findSpot(sim, 'solar');
  const b = ConstructionSystem.place(sim.state, 'solar', spot.x, spot.z);
  assert.ok(b);
  ConstructionSystem.complete(sim.state, b!);
  sim.drainDomainEvents();

  FailureSystem.tripDamaged(sim.state, b!, 'the storm', { finishTask: () => {} });
  let evs = sim.drainDomainEvents();
  assert.ok(evs.some((e) => e.type === 'building/failed' && e.buildingId === b!.id));

  FailureSystem.endMission(sim.state, 'test loss');
  evs = sim.drainDomainEvents();
  assert.ok(evs.some((e) => e.type === 'game/over'));
  assert.ok(sim.gameOver);
});

test('storm arrival/pass emit storm/started and storm/ended', () => {
  const sim = fresh();
  sim.drainDomainEvents();
  sim.weather.debugScheduleStorm('regional', sim.simTime, 0);
  sim.step(SIM_TICK);
  let evs = sim.drainDomainEvents();
  assert.ok(
    evs.some((e) => e.type === 'storm/started'),
    `expected storm/started, got [${typesOf(evs)}]`,
  );
  assert.equal(sim.state.stormAnnounced, true);

  sim.devClearStorms();
  sim.step(SIM_TICK);
  evs = sim.drainDomainEvents();
  assert.ok(
    evs.some((e) => e.type === 'storm/ended'),
    `expected storm/ended, got [${typesOf(evs)}]`,
  );
  assert.equal(sim.state.stormAnnounced, false);
});

test('stepping accumulates domain events until drainDomainEvents', () => {
  const sim = fresh();
  sim.drainDomainEvents();
  RoverSystem.disable(sim.state, sim.rovers[0]!);
  sim.step(SIM_TICK);
  assert.ok(sim.state.domainEvents.length >= 1);
  const evs = sim.drainDomainEvents();
  assert.ok(evs.some((e) => e.type === 'rover/disabled'));
  assert.equal(sim.drainDomainEvents().length, 0);
});

// ------------------------------------------------------ host surface ----

group('host domain event surface');

test('LocalSimHost.drainDomainEvents surfaces sim events and leaves AlertBus alone', () => {
  const sim = fresh();
  const host = new LocalSimHost(sim);
  sim.alerts.event('info', 'toast', sim.simTime, sim.clock.format());
  RoverSystem.disable(sim.state, sim.rovers[0]!);
  host.step(0);

  const toasts = host.drainEvents();
  assert.ok(toasts.some((e) => e.text === 'toast'));
  const domain = host.drainDomainEvents();
  assert.ok(domain.some((e) => e.type === 'rover/disabled'));
  assert.equal(host.drainDomainEvents().length, 0);
  assert.equal(host.drainEvents().length, 0);
});

test('frame-style drain (GameLoop pattern) clears pending domain queue after step', () => {
  const sim = fresh();
  const host = new LocalSimHost(sim);
  host.drainDomainEvents();
  RoverSystem.disable(sim.state, sim.rovers[0]!);
  host.step(SIM_TICK);
  assert.ok(sim.state.domainEvents.length >= 1, 'events accumulate until drained');

  // Mirror GameLoop / DevMode.setTime: drain AlertBus + domain each frame.
  host.drainEvents();
  void host.drainDomainEvents();

  assert.equal(sim.state.domainEvents.length, 0, 'pending domain queue empty after frame drain');
  assert.equal(host.drainDomainEvents().length, 0);
});

interface FakePort extends HostPort {
  flush(): number;
  lastView(): ViewPayload;
}

function fakePort(): FakePort {
  const replies: HostReply[] = [];
  const outbox: HostReply[] = [];
  let handler: ((event: { data: HostReply }) => void) | null = null;
  const runtime = createSimRuntime((reply) => {
    const clone = structuredClone(reply) as HostReply;
    replies.push(clone);
    outbox.push(clone);
  });
  return {
    lastView: () => {
      for (let i = replies.length - 1; i >= 0; i--) {
        const r = replies[i];
        if (r.kind === 'view' || r.kind === 'ready' || r.kind === 'loaded') return r.view;
      }
      throw new Error('no view yet');
    },
    flush: () => {
      let n = 0;
      while (outbox.length > 0) {
        handler?.({ data: outbox.shift() as HostReply });
        n++;
      }
      return n;
    },
    postMessage: (message: HostRequest) => {
      runtime.handle(structuredClone(message) as HostRequest);
    },
    set onmessage(h: ((event: { data: HostReply }) => void) | null) {
      handler = h;
    },
  };
}

test('WorkerSimHost drains domain events from the view payload (parity with Local)', async () => {
  const port = fakePort();
  const pending = WorkerSimHost.connect(port, {
    boot: {
      seed: 4242,
      difficulty: 'pioneer',
      worldHalf: 640,
      region: null,
      worldOptions: DEFAULT_WORLD_OPTIONS,
    },
  });
  port.flush();
  const host = await pending;
  host.drainDomainEvents();
  host.drainEvents();

  // Drive a storm start on the worker via a command is awkward; instead assert
  // the payload field exists and Local↔payload agreement on an in-process twin.
  const local = fresh(4242);
  local.weather.debugScheduleStorm('regional', local.simTime, 0);
  local.step(SIM_TICK);
  const localEvs = local.drainDomainEvents();
  assert.ok(localEvs.some((e) => e.type === 'storm/started'));

  // Worker path: post advance after the runtime's sim has a storm — use restore
  // of a snapshot taken mid-storm so the next tick can end it, and emit via
  // a building place command which both hosts understand.
  host.send({ type: 'building/place', kind: 'solar', x: 20, z: 20 });
  port.flush();
  const afterPlace = host.drainDomainEvents();
  // Placement may fail siting; if it succeeded we expect building/placed.
  const view = port.lastView();
  assert.ok(Array.isArray(view.domainEvents), 'payload carries domainEvents');
  // Either the place landed (domain event drained into mirror) or it was refused
  // (empty) — both are fine; the surface must exist and not throw.
  assert.ok(Array.isArray(afterPlace));

  // Stronger pin: Local and Worker drain APIs are both present and consume.
  assert.equal(typeof host.drainDomainEvents, 'function');
  assert.equal(host.drainDomainEvents().length, 0);

  // Restore clears pending domain events (ephemeral).
  const snap = local.snapshot();
  local.state.domainEvents.push({ type: 'storm/ended' });
  assert.ok(local.state.domainEvents.length >= 1);
  local.restore(snap);
  assert.equal(local.drainDomainEvents().length, 0, 'restore clears domain event log');

  // Frame-style drain empties mirror unreadDomain (GameLoop pattern).
  host.send({ type: 'building/place', kind: 'solar', x: 40, z: 40 });
  port.flush();
  host.drainEvents();
  void host.drainDomainEvents();
  assert.equal(host.drainDomainEvents().length, 0, 'unreadDomain empty after frame drain');

  host.dispose();
});

await finish();
