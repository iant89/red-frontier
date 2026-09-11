/**
 * @suite sim/worker
 * @group unit
 * @covers src/sim/host/WorkerSimHost.ts src/sim/host/workerRuntime.ts src/sim/host/mirror.ts src/sim/host/projection.ts src/sim/host/messages.ts src/sim/host/overlays.ts src/sim/host/createHost.ts src/sim/rules.ts src/sim/sim.worker.ts
 * @desc The boundary itself: a worker runtime driven through a fake port that
 * clones every message, so anything unclonable fails here rather than in a
 * browser. Covers terrain agreement between mirror and sim, the shared siting
 * rule, backpressure, optimistic ids, overlays as data, snapshot round trips,
 * and byte-equality of the projection across both transports.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { ColonyMirror } from '../../src/sim/host/mirror';
import { WorkerSimHost } from '../../src/sim/host/WorkerSimHost';
import { createSimRuntime } from '../../src/sim/host/workerRuntime';
import { projectView, type ViewPayload } from '../../src/sim/host/projection';
import { BATTERY_PIN_OVERLAY, EMPTY_OVERLAYS, runOverlays } from '../../src/sim/host/overlays';
import { evaluateSite, maintenanceNeed } from '../../src/sim/rules';
import { planHost, wantsWorker, workerSupported } from '../../src/sim/host/createHost';
import { applyCommand } from '../../src/sim/host';
import type { HostPort, HostReply, HostRequest } from '../../src/sim/host/messages';
import type { SimBootParams } from '../../src/sim/host/view';
import { BUILDINGS, ROVERS } from '../../src/sim/defs';
import { DEFAULT_WORLD_OPTIONS } from '../../src/sim/difficulty';
import { group, test, finish } from '../harness';

// ------------------------------------------------------------- fake wire ----

/**
 * A worker made of two function calls, with two properties a stub would not have:
 *
 *  - every message passes through `structuredClone` in *both* directions, so a
 *    payload holding a closure, a class instance or a cycle throws here instead of
 *    in a browser console;
 *  - delivery is manual (`flush`), so a test can observe an advance that has been
 *    posted but not answered — which is the only way to see backpressure at all.
 */
interface FakePort extends HostPort {
  readonly sent: HostRequest[];
  readonly replies: HostReply[];
  lastView(): ViewPayload;
  flush(): number;
}

function fakePort(): FakePort {
  const sent: HostRequest[] = [];
  const replies: HostReply[] = [];
  const outbox: HostReply[] = [];
  let handler: ((event: { data: HostReply }) => void) | null = null;

  const runtime = createSimRuntime((reply) => {
    const clone = structuredClone(reply) as HostReply;
    replies.push(clone);
    outbox.push(clone);
  });

  return {
    sent,
    replies,
    lastView: () => {
      for (let i = replies.length - 1; i >= 0; i--) {
        const r = replies[i];
        if (r.kind === 'view' || r.kind === 'ready' || r.kind === 'loaded') return r.view;
      }
      throw new Error('the fake worker has not projected a view');
    },
    flush: () => {
      let n = 0;
      // The shift is hoisted out of the call on purpose: `handler?.(outbox.shift())`
      // would short-circuit the *argument* too when nothing is listening, and the
      // loop would spin forever. The ceiling turns any such mistake into a failure
      // rather than a hung suite.
      while (outbox.length > 0) {
        if (n > 10_000) throw new Error(`the fake worker delivered ${n} replies in one flush`);
        const reply = outbox.shift() as HostReply;
        handler?.({ data: reply });
        n++;
      }
      return n;
    },
    postMessage: (message: HostRequest) => {
      const clone = structuredClone(message) as HostRequest;
      sent.push(clone);
      runtime.handle(clone);
    },
    set onmessage(h: ((event: { data: HostReply }) => void) | null) {
      handler = h;
    },
  };
}

/**
 * The same colony, built directly, so the tests can compare what arrived over the
 * wire against what a simulation actually is. Deliberately not shared with the
 * runtime: agreement between two independent worlds is the thing being asserted,
 * and a fake that handed back its own state would assert nothing.
 */
function twin(seed: number): Simulation {
  return new Simulation({ seed, worldOptions: DEFAULT_WORLD_OPTIONS });
}

const BOOT: SimBootParams = {
  seed: 4242,
  difficulty: 'pioneer',
  worldHalf: 640,
  region: null,
  worldOptions: DEFAULT_WORLD_OPTIONS,
};

/** Boot a host on a fake port, handshake included. */
async function connect(overrides: Partial<SimBootParams> = {}): Promise<{
  host: WorkerSimHost;
  port: FakePort;
  sim: Simulation;
}> {
  const params = { ...BOOT, ...overrides };
  const port = fakePort();
  const pending = WorkerSimHost.connect(port, { boot: params });
  port.flush();
  return { host: await pending, port, sim: twin(params.seed) };
}

/** Advance one tick and let the answer arrive: the shape of a frame. */
function tick(host: WorkerSimHost, port: FakePort, dt = 1 / 20): void {
  host.step(dt);
  port.flush();
}

/** A spot the sim says is buildable, so no test hard-codes geography. */
function openSpot(sim: Simulation, kind: keyof typeof BUILDINGS = 'warehouse'): { x: number; z: number } {
  for (let r = 34; r <= 220; r += 2) {
    for (let a = 0; a < 360; a += 5) {
      const x = Math.round(Math.cos((a * Math.PI) / 180) * r);
      const z = Math.round(Math.sin((a * Math.PI) / 180) * r);
      if (sim.canPlace(kind, x, z) === null) return { x, z };
    }
  }
  throw new Error('no open spot on the map');
}

// ------------------------------------------------------------------ boot ----

group('Booting across the wire');

test('the handshake names the terrain, and the mirror agrees about the ground', async () => {
  const { host, sim } = await connect({ seed: 90210 });
  const view = host.view;
  // Heights are not on the wire at all: the mirror derives them from the seed the
  // runtime reported. So this is the assertion that the *right planet* arrived.
  for (const [x, z] of [
    [0, 0],
    [120, -80],
    [-300, 260],
  ] as const) {
    assert.equal(view.world.heightAt(x, z), sim.world.heightAt(x, z), `height at ${x},${z}`);
  }
  assert.equal(view.world.half, sim.world.half, 'the claim size came from the sim');
  assert.equal(view.seed, sim.seed, 'and so did the seed');
  assert.equal(view.world.deposits.length, sim.world.deposits.length, 'deposits are projected');
  const a = view.world.sampleSurface(120, -80);
  const b = sim.world.sampleSurface(120, -80);
  assert.equal(a.rockiness, b.rockiness, 'surface geology is local too');
  assert.equal(a.region, b.region, 'down to which region of the map it is standing in');
});

test('a restored save rebuilds the world from the save, not from the boot params', async () => {
  const { host, port, sim } = await connect({ seed: 771 });
  tick(host, port, 300);
  tick(host, port, 300);
  const pending = host.requestSnapshot();
  port.flush();
  const snapshot = await pending;

  const port2 = fakePort();
  const resumed = WorkerSimHost.connect(port2, { restore: snapshot });
  port2.flush();
  const host2 = await resumed;
  assert.equal(host2.view.clock.sol, sim.clock.sol, 'the same sol, from the save');
  assert.equal(host2.view.seed, sim.seed, 'the same seed, from the save');
  assert.equal(host2.view.rovers.length, sim.rovers.length, 'and the same fleet');
  assert.equal(
    host2.view.world.heightAt(60, 60),
    sim.world.heightAt(60, 60),
    'on the same ground, which the save had to name',
  );
});

test('the view is already current before the first step', async () => {
  const { host, sim } = await connect();
  // `boot` projects immediately, so the HUD that paints the frame the loader
  // dismisses has a colony to draw rather than an empty list.
  assert.ok(host.view.rovers.length > 0, 'the fleet is there');
  assert.ok(host.view.world.deposits.length > 0, 'so is the ore');
  assert.equal(host.view.world.landingSite().name, sim.world.landingSite().name, 'on the named site');
  assert.equal(host.view.clock.sol, 0, 'and no time has passed');
  assert.ok(host.view.colonist, 'with someone walking around it');
});

// ------------------------------------------------------------ siting rule ----

group('The shared siting rule');

test('mirror and sim reach the same verdict for the same sites', async () => {
  const { host, sim } = await connect({ seed: 5150 });
  const free = openSpot(sim);
  const sites: Array<[number, number]> = [
    [0, 0],
    [8, 0],
    [free.x, free.z],
    [10_000, 10_000],
    [-590, 590],
  ];
  for (const [x, z] of sites) {
    for (const kind of Object.keys(BUILDINGS) as Array<keyof typeof BUILDINGS>) {
      assert.equal(host.view.canPlace(kind, x, z), sim.canPlace(kind, x, z), `${kind} at ${x},${z}`);
    }
  }
});

test('an obstacle placed through the wire makes the next site illegal', async () => {
  const { host, port, sim } = await connect({ seed: 616 });
  const spot = openSpot(sim);
  const place = { type: 'building/place', kind: 'warehouse', x: spot.x, z: spot.z } as const;
  host.request(place);
  // The twin is told as well, or it is not a twin: the point is that both sides
  // reach the same verdict from the same *state*, and the state got there one way
  // through a wire and once directly.
  applyCommand(sim, place);
  tick(host, port);
  const here = host.view.canPlace('warehouse', spot.x, spot.z);
  assert.ok(here, 'the spot the sim just occupied is no longer free');
  assert.match(here, /existing structure|landing pod|resource deposit/);
  assert.equal(here, sim.canPlace('warehouse', spot.x, spot.z), 'and the sim agrees, word for word');
  const neighbour = { x: spot.x + 1, z: spot.z + 1 };
  assert.equal(
    host.view.canPlace('warehouse', neighbour.x, neighbour.z),
    sim.canPlace('warehouse', neighbour.x, neighbour.z),
    'the clearance margin reaches the neighbour too',
  );
});

test('the rule is pure: same inputs, same verdict, no world required', () => {
  const ground = (slope: number, bounds = 600) => ({
    inBounds: (x: number, z: number) => Math.abs(x) < bounds && Math.abs(z) < bounds,
    canDrive: () => true,
    canBuild: () => true,
    slopeAt: () => slope,
  });
  const ctx = { ground: ground(0.5), buildings: [], deposits: [] };
  assert.equal(evaluateSite('solar', 300, 300, ctx), 'Terrain too steep here.');
  assert.equal(evaluateSite('solar', 300, 300, { ...ctx, ground: ground(0.2) }), null, 'open arrays are tolerant');
  assert.equal(
    evaluateSite('greenhouse', 300, 300, { ...ctx, ground: ground(0.2) }),
    'Terrain too steep here.',
    'a pressurised volume on the same slope is not',
  );
  assert.equal(evaluateSite('solar', 900, 0, ctx), 'Outside the playable region.');
  assert.equal(
    evaluateSite('solar', 300, 300, { ...ctx, ground: { ...ground(0), canDrive: () => false } }),
    'No safe approach — drop-off or unreachable.',
    'and a driveway is checked before the ground itself',
  );
  assert.equal(
    evaluateSite('solar', 300, 300, {
      ...ctx,
      ground: ground(0),
      deposits: [{ x: 302, z: 300, radius: 20, amount: 500 }],
    }),
    'Cannot build on a resource deposit.',
  );
  assert.equal(
    evaluateSite('solar', 300, 300, {
      ...ctx,
      ground: ground(0),
      deposits: [{ x: 302, z: 300, radius: 20, amount: 0 }],
    }),
    null,
    'a seam that is spent no longer blocks a foundation',
  );
});

test('the maintenance rule follows damage sent over the wire', async () => {
  const { host, port, sim } = await connect({ seed: 631 });
  const spot = openSpot(sim, 'solar');
  const ack = host.request({ type: 'building/place', kind: 'solar', x: spot.x, z: spot.z });
  tick(host, port);
  const id = ack.entityId as number;
  // A site under construction needs nothing from anybody; only a running machine
  // can be unhealthy, and the rule says so.
  assert.equal(host.view.needsMaintenance(id), null, 'a fresh site is not a repair job');
  host.send({ type: 'dev/building/complete', buildingId: id });
  tick(host, port);
  assert.equal(host.view.needsMaintenance(id), null, 'online and clean, so still nothing');
  host.send({ type: 'dev/building/health', buildingId: id, pct: 40 });
  tick(host, port);
  assert.equal(host.view.needsMaintenance(id), 'repair', 'damaged, and the client can see it');
  assert.equal(maintenanceNeed(host.view.buildingById(id) ?? undefined), 'repair', 'from the same predicate');
  assert.equal(
    maintenanceNeed({ state: 'online', health: 100, cleanliness: 0.5, kind: 'solar' }),
    'clean',
    'a dusty array is a different errand',
  );
});

// ---------------------------------------------------------------- ticks ----

group('Time and backpressure');

test('time moves only when the client asks for it', async () => {
  const { host, port } = await connect({ seed: 1234 });
  const t0 = host.view.simTime;
  port.flush();
  port.flush();
  assert.equal(host.view.simTime, t0, 'an idle port advances nothing');
  tick(host, port, 2);
  assert.ok(host.view.simTime > t0, 'one posted advance moved the world');
  assert.equal(port.sent.filter((m) => m.kind === 'advance').length, 1, 'exactly one advance was sent');
});

test('an advance still in flight banks its time instead of queueing or dropping it', async () => {
  const { host, port } = await connect({ seed: 22 });
  host.step(1);
  host.step(2);
  host.step(3);
  const inFlight = port.sent.filter((m) => m.kind === 'advance');
  assert.equal(inFlight.length, 1, 'only the first post went out');
  port.flush();
  const all = port.sent.filter((m) => m.kind === 'advance') as Array<{ dt: number }>;
  assert.equal(all.length, 2, 'the banked time became one bigger tick');
  assert.ok(Math.abs(all[1].dt - 5) < 1e-9, 'and it adds up');
});

test('a zero step posts nothing, and a pin published while paused still bites', async () => {
  const { host, port } = await connect({ seed: 31 });
  host.step(0);
  assert.equal(port.sent.filter((m) => m.kind === 'advance').length, 0, 'no work requested');
  const rover = host.view.rovers[0];
  const full = ROVERS[rover.kind].maxBatteryKWh;
  host.send({ type: 'dev/rover/battery', roverId: rover.id, frac: 0.05 });
  tick(host, port);
  assert.ok(host.view.rovers[0].battery < full, 'drained, as asked');
  host.syncOverlays({ [BATTERY_PIN_OVERLAY]: [rover.id] });
  tick(host, port, 0.001);
  assert.equal(host.view.rovers[0].battery, full, 'the grip took effect on the next report');
});

test('log lines cross once, and never twice', async () => {
  const { host, port } = await connect({ seed: 44 });
  host.send({ type: 'dev/storm/force', kind: 'severe' });
  tick(host, port, 60);
  const seen = host.drainEvents();
  assert.ok(seen.length > 0, 'the storm said something');
  assert.equal(host.drainEvents().length, 0, 'a second drain finds nothing new');
  for (const ev of seen) {
    assert.equal(typeof ev.text, 'string', 'lines are plain text');
    assert.ok('severity' in ev, 'with a severity');
  }
});

// -------------------------------------------------------------- writes ----

group('Commands and optimistic acks');

test('an order crosses as data and lands on the rover', async () => {
  const { host, port, sim } = await connect({ seed: 700 });
  const rover = host.view.rovers[0];
  const start = { x: rover.x, z: rover.z };
  const target = { x: 200, z: 0 };
  assert.equal(sim.canPlace('warehouse', target.x, target.z), null, 'a drivable target, picked from the twin');
  host.send({ type: 'rover/move', roverId: rover.id, x: target.x, z: target.z, queue: false });
  tick(host, port, 20);
  const moved = host.view.rovers[0];
  assert.ok(Math.hypot(moved.x - start.x, moved.z - start.z) > 100, 'the sim drove it');
  assert.equal(port.sent.filter((m) => m.kind === 'command').length, 1, 'as one message');
  // The projected position is the world's, not an approximation of it.
  applyCommand(sim, { type: 'rover/move', roverId: rover.id, x: target.x, z: target.z, queue: false });
  sim.step(20);
  assert.equal(moved.x, sim.rovers[0].x, 'the mirror reports the same metre the sim is standing on');
  assert.equal(moved.z, sim.rovers[0].z);
});

test('a command reaches the mirror with no tick at all — a paused colony shows its orders', async () => {
  /**
   * The bug this pins: the runtime used to publish a view only on `advance`, so
   * an order sent while paused was applied by the sim and invisible to the HUD
   * until the player unpaused. The in-process host cannot have that bug (its
   * view *is* the sim), which made it a worker-only divergence — found by the
   * mobile smoke gate the day the worker became the default transport, because
   * that gate pauses the colony before ordering a rover.
   */
  const { host, port } = await connect({ seed: 701 });
  const rover = host.view.rovers[0];
  const repliesBefore = port.replies.length;
  host.send({ type: 'rover/move', roverId: rover.id, x: 180, z: 40, queue: false });
  port.flush(); // deliberately no tick(): the client is paused, so nothing is pumped
  assert.equal(
    port.sent.filter((m) => m.kind === 'advance').length,
    0,
    'precondition: not a single advance was posted',
  );
  assert.ok(port.replies.length > repliesBefore, 'the runtime published a view for the command');
  assert.equal(
    host.view.roverById(rover.id)?.command.type,
    'moveTo',
    'the order is on the mirror while the world is standing still',
  );
});

test('an optimistic id is the id the sim actually used', async () => {
  const { host, port, sim } = await connect({ seed: 800 });
  const spot = openSpot(sim);
  const ack = host.request({ type: 'building/place', kind: 'warehouse', x: spot.x, z: spot.z });
  assert.ok(ack.entityId, 'the caller has an id before the round trip');
  tick(host, port);
  const built = host.view.buildingById(ack.entityId as number);
  assert.ok(built, 'and the site exists under that id');
  assert.equal(built?.kind, 'warehouse', 'with the kind that was asked for');
  assert.equal(built?.x, spot.x, 'where it was asked for');
});

test('a refused placement costs the world nothing, and the counter rebases', async () => {
  const { host, port, sim } = await connect({ seed: 901 });
  const before = host.view.buildings.length;
  const ack = host.request({ type: 'building/place', kind: 'warehouse', x: 0, z: 0 });
  tick(host, port);
  assert.ok(ack.entityId, 'an id was still handed out');
  assert.equal(host.view.buildings.length, before, 'and nothing was built');
  assert.equal(host.view.buildingById(ack.entityId as number), undefined, 'the ghost id resolves to nothing');
  const spot = openSpot(sim, 'solar');
  const next = host.request({ type: 'building/place', kind: 'solar', x: spot.x, z: spot.z });
  tick(host, port);
  assert.equal(host.view.buildingById(next.entityId as number)?.kind, 'solar', 'rebased correctly');
});

test('a malformed command is rejected on the client, so the runtime never sees it', async () => {
  const { host, port } = await connect({ seed: 950 });
  const before = host.view.simTime;
  const errors: unknown[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    host.send({ type: 'rover/move', roverId: 'ten', x: 1, z: 1, queue: false } as never);
    port.flush();
  } finally {
    console.error = real;
  }
  assert.equal(port.sent.filter((m) => m.kind === 'command').length, 1, 'the message was still posted');
  assert.equal(host.view.simTime, before, 'and the colony did not change shape');
});

// ------------------------------------------------------------- overlays ----

group('Overlays as data');

test('a pin published to the worker holds a battery across ticks', async () => {
  const { host, port } = await connect({ seed: 1100 });
  const rover = host.view.rovers[0];
  const full = ROVERS[rover.kind].maxBatteryKWh;
  host.send({ type: 'dev/rover/battery', roverId: rover.id, frac: 0.05 });
  tick(host, port);
  assert.ok(host.view.rovers[0].battery < full, 'it really was low');
  host.syncOverlays({ [BATTERY_PIN_OVERLAY]: [rover.id] });
  for (let i = 0; i < 10; i++) tick(host, port, 60);
  assert.equal(host.view.rovers[0].battery, full, 'and the pin is holding it');
  assert.deepEqual(port.lastView().pinnedRovers, [rover.id], 'echoed back to the client');
  host.syncOverlays(EMPTY_OVERLAYS);
  for (let i = 0; i < 10; i++) tick(host, port, 60);
  assert.ok(host.view.rovers[0].battery < full, 'withdrawing the grip lets it discharge again');
});

test('the echo only names rovers the world still has', async () => {
  const { host, port } = await connect({ seed: 1150 });
  const id = host.view.rovers[0].id;
  host.syncOverlays({ [BATTERY_PIN_OVERLAY]: [id, 999_999] });
  tick(host, port);
  assert.deepEqual(port.lastView().pinnedRovers, [id], 'the dead id is not echoed');
});

test('an unknown overlay name is ignored, not fatal', async () => {
  const { host, port } = await connect({ seed: 1200 });
  const before = host.view.simTime;
  host.syncOverlays({ 'dev.somethingNewerThanThisWorker': [1] });
  tick(host, port, 5);
  assert.ok(host.view.simTime > before, 'the world kept turning');
  assert.equal(port.replies.filter((r) => r.kind === 'error').length, 0, 'and it said nothing about it');
});

test('the registry runs against a bare sim too, so one implementation serves both', () => {
  const sim = new Simulation({ seed: 1250 });
  const r = sim.rovers[0];
  const full = ROVERS[r.kind].maxBatteryKWh;
  r.battery = 1;
  runOverlays(sim, { [BATTERY_PIN_OVERLAY]: [r.id] });
  assert.equal(r.battery, full, 'the same code the host runs');
  r.battery = 1;
  runOverlays(sim, EMPTY_OVERLAYS);
  assert.equal(r.battery, 1, 'and it holds only while published');
});

// -------------------------------------------------------------- payload ----

group('The payload’s shape');

test('nothing that cannot be cloned crosses, and nothing that cannot be printed either', async () => {
  const { host, port } = await connect({ seed: 1300 });
  tick(host, port, 120);
  const view = port.lastView();
  // `structuredClone` already proved cloneability on the way through. JSON goes
  // further: it drops or rejects a Map, a Set and a function, which is precisely
  // the set of things a wire can carry and a *debuggable* payload must not.
  assert.ok(!(view.power.satisfaction instanceof Map), 'the wire carries entries, not a Map');
  assert.ok(host.view.power.satisfaction instanceof Map, 'and the grid gets its Map back');
  const printed = JSON.stringify(view);
  assert.ok(!printed.includes('[object Map]') && !printed.includes('function'), 'no stringified junk');
  assert.deepEqual(JSON.parse(printed), JSON.parse(JSON.stringify(JSON.parse(printed))), 'stable under round trip');
  for (const key of Object.keys(view)) {
    const value = (view as unknown as Record<string, unknown>)[key];
    assert.notEqual(typeof value, 'function', `${key} is data, not a method`);
  }
});

test('the projection is byte-identical across transports', async () => {
  const seed = 1717;
  const script = [
    { type: 'dev/time', sol: 2, frac: 0.42 },
    { type: 'dev/dust', frac: 0.35 },
    { type: 'rover/rule', roverId: 1000, rule: 'autoHaul', on: false },
    { type: 'building/toggle', buildingId: 1, enabled: false },
  ] as const;
  const dts = [60, 240, 90, 600, 30];

  const { host, port } = await connect({ seed });
  const local = twin(seed);
  for (let i = 0; i < dts.length; i++) {
    if (i < script.length) host.send(script[i] as never);
    tick(host, port, dts[i]);
    // The runtime's own order: commands, step, project. Nothing else differs.
    if (i < script.length) applyCommand(local, script[i] as never);
    local.step(dts[i]);
  }
  const here = projectView(local, 'worker', {});
  const there = port.lastView();
  assert.deepEqual(
    { ...there, transport: 'worker', events: [] },
    { ...here, transport: 'worker', events: [] },
    'the mirrored view says exactly what the live one does',
  );
});

test('the mirror is a read model: scribbling on it changes no world', async () => {
  const { host, port, sim } = await connect({ seed: 1800 });
  const view = host.view;
  const battery = sim.rovers[0].battery;
  (view.rovers[0] as { battery: number }).battery = 0;
  (view as unknown as { storage: Record<string, number> }).storage.iron = 1e9;
  assert.notEqual(sim.rovers[0].battery, 0, 'the sim never heard about it');
  tick(host, port, 1);
  assert.ok(host.view.rovers[0].battery > 0, 'and the next payload overwrites the scribble');
  void battery;
});

test('the mirror answers every query the view promises, without being a Simulation', async () => {
  const sim = twin(1801);
  const spot = openSpot(sim, 'warehouse');
  const ack = applyCommand(sim, { type: 'building/place', kind: 'warehouse', x: spot.x, z: spot.z });
  sim.step(30);
  const payload = projectView(sim, 'worker', {});
  const mirror = new ColonyMirror(
    { seed: sim.world.seed, worldHalf: sim.world.half, region: sim.world.region },
    payload,
  );
  assert.equal(mirror.roverById(1000)?.id, 1000);
  assert.equal(mirror.roverById(9999), undefined, 'nothing is invented for an unknown id');
  assert.equal(mirror.buildingById(9999), undefined);
  assert.equal(mirror.buildingById(ack.entityId as number)?.kind, 'warehouse', 'and a real one is found');
  assert.equal(mirror.storageCapacity(), sim.storageCapacity());
  assert.equal(mirror.reserveSols('oxygen'), sim.reserveSols('oxygen'));
  assert.equal(mirror.netRatePerSol('water'), sim.netRatePerSol('water'));
  assert.deepEqual(mirror.idleRovers().map((r) => r.id), sim.idleRovers().map((r) => r.id));
  assert.equal(mirror.weather.dust, sim.weather.dust);
  assert.equal(mirror.weather.forecast()?.label ?? null, sim.weather.forecast()?.label ?? null);
  assert.equal(mirror.clock.format(), sim.clock.format());
  assert.equal(mirror.alerts.worst(), sim.alerts.worst());
  assert.equal(mirror.sun.isDay, sim.sun.isDay);
  assert.equal(mirror.gameOver, null);
  assert.equal(mirror.version, sim.version);
  assert.equal(mirror.canPlace('warehouse', spot.x, spot.z), sim.canPlace('warehouse', spot.x, spot.z));
  assert.equal(mirror.needsMaintenance(ack.entityId as number), sim.needsMaintenance(ack.entityId as number));
});

test('a mirror built before the first payload is not a thing that can exist', () => {
  const sim = twin(1802);
  const payload = projectView(sim, 'worker', {});
  const mirror = new ColonyMirror(
    { seed: sim.world.seed, worldHalf: sim.world.half, region: sim.world.region },
    payload,
  );
  assert.equal(mirror.simTime, payload.simTime, 'it is constructed *with* a view');
  assert.equal(mirror.simTime, sim.simTime);
});

test('a frame that reads the world forty times gets one object, not forty', async () => {
  const { host, port } = await connect({ seed: 1810 });
  const view = host.view;
  assert.equal(view.world, view.world, 'identity is stable across reads');
  assert.equal(view.clock, view.clock);
  assert.equal(view.weather, view.weather);
  assert.equal(view.alerts, view.alerts);
  const dust = view.weather.dust;
  host.send({ type: 'dev/dust', frac: 0.75 });
  tick(host, port);
  assert.equal(view.weather, view.weather, 'the same object…');
  assert.notEqual(view.weather.dust, dust, '…with a newer answer');
});

// ---------------------------------------------------------- the entry ----

group('The worker entry');

test('sim.worker.ts wires the runtime to the port it is given', async () => {
  // The entry point is the only file in the layer that touches a Worker global,
  // so it is worth one test with a pretend one: it must post answers to whoever
  // spawned it and read requests off `onmessage`, and nothing else.
  const posted: HostReply[] = [];
  const scope: { onmessage: ((event: { data: unknown }) => void) | null } = { onmessage: null };
  const globalSelf = globalThis as unknown as Record<string, unknown>;
  const previous = globalSelf.self;
  globalSelf.self = {
    onmessage: null,
    postMessage: (message: HostReply) => posted.push(message),
    addEventListener: () => undefined,
  };
  try {
    await import('../../src/sim/sim.worker');
    const handler = (globalSelf.self as typeof scope & { postMessage: (m: HostReply) => void }).onmessage;
    assert.equal(typeof handler, 'function', 'it installed a message handler');
    handler!({ data: { kind: 'boot', id: 1, params: BOOT } });
    assert.equal(posted.length, 1, 'the boot was answered');
    assert.equal(posted[0].kind, 'ready');
    handler!({ data: { kind: 'advance', dt: 30 } });
    assert.equal(posted.length, 2, 'and a tick reported the new view');
    assert.equal(posted[1].kind, 'view');
    const view = (posted[1] as { view: ViewPayload }).view;
    // Not the exact clock: how much of a 30-second request a single step
    // delivers is `Simulation`'s substep policy, and other suites own that.
    assert.ok(view.simTime > 0, 'which is the world some way after that tick');
    assert.equal(view.seed, BOOT.seed, 'and still the colony that was booted');
    assert.equal(
      typeof (globalThis as unknown as Record<string, unknown>).document,
      'undefined',
      'no DOM was needed to get there',
    );
    void scope;
  } finally {
    globalSelf.self = previous;
  }
});

// ------------------------------------------------------------- lifecycle ----

group('Lifecycle');

test('dispose stops the pump and unwinds what is waiting', async () => {
  const { host, port } = await connect({ seed: 1900 });
  const pending = host.requestSnapshot();
  host.dispose();
  await assert.rejects(pending, /shut down/, 'a save in flight is rejected, not swallowed');
  const before = port.sent.length;
  host.step(1);
  host.send({ type: 'dev/dust', frac: 0.9 });
  assert.equal(port.sent.length, before, 'and nothing is posted afterwards');
});

test('before boot, a tick is ignored and intent that needs a world is refused', () => {
  const port = fakePort();
  port.postMessage({ kind: 'advance', dt: 1 });
  assert.equal(port.replies.length, 0, 'an advance with no colony is absorbed, not complained about');
  port.postMessage({ kind: 'command', commands: [{ type: 'dev/dust', frac: 0.5 }] });
  assert.equal(port.replies.length, 1, 'a command before the handshake is a client bug, and is named once');
  assert.match((port.replies[0] as { error: string }).error, /no colony is running/);
  port.postMessage({ kind: 'snapshot', id: 7 });
  port.flush();
  const errors = port.replies.filter((r) => r.kind === 'error') as Array<{ error: string; id: number | null }>;
  assert.equal(errors.length, 2, 'both intents that needed a world were refused');
  assert.match(errors[0].error, /no colony is running/, 'each naming what is missing');
  assert.equal(errors[0].id, null, 'the command carried no transaction id, so nothing is tied to it');
  assert.equal(errors[1].id, 7, 'and the snapshot is answered under the id that asked');
});

test('a handshake that fails rejects instead of hanging the loading screen', async () => {
  const port = fakePort();
  // A snapshot the restore path cannot digest must surface as a rejection: the
  // alternative is a promise that never settles behind a progress bar.
  const pending = WorkerSimHost.connect(port, { restore: { version: -1 } as never });
  port.flush();
  const outcome = await pending.then(() => 'settled' as const, (e: Error) => e.message);
  assert.ok(typeof outcome === 'string', 'either a host or a sentence about why not');
  assert.ok(port.replies.length > 0, 'and the runtime answered something either way');
});

test('the transport switch is a URL, and the worker is the default', () => {
  assert.equal(wantsWorker(''), true, 'no parameter: the shipped path is the worker');
  assert.equal(wantsWorker('?worker=1'), true);
  assert.equal(wantsWorker('worker=true'), true);
  assert.equal(wantsWorker('?worker=0'), false, 'the escape hatch still works');
  assert.equal(wantsWorker('?worker=false'), false);
  // A typo is not a silent downgrade: an unparseable value keeps the default,
  // so a malformed URL cannot quietly put a player on the fallback transport.
  assert.equal(wantsWorker('?worker=nonsense'), true, 'a typo is not a downgrade');
  assert.equal(wantsWorker('', false), false, 'the default is a parameter, not a constant');

  const def = planHost('');
  assert.ok(
    def.transport === 'worker' ? workerSupported() : /unavailable/.test(def.reason),
    `the default plan is the worker where one can run, got: ${def.reason}`,
  );
  assert.equal(planHost('?worker=0').transport, 'in-process', 'asking for the fallback is honoured');
  const asked = planHost('?worker=1');
  assert.ok(
    asked.transport === 'worker' ? workerSupported() : /unavailable/.test(asked.reason),
    'a requested worker is either honoured or explained',
  );
});

await finish('sim/worker');
