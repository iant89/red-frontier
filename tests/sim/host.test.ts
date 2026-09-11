/**
 * @suite sim/host
 * @group unit
 * @covers src/sim/host/protocol.ts src/sim/host/applyCommand.ts src/sim/host/LocalSimHost.ts src/sim/host/view.ts src/sim/host/mirror.ts src/sim/host/projection.ts src/sim/sim.worker.ts src/app/Game.ts src/dev/DevMode.ts src/dev/DevPanel.ts src/ui/HUD.ts src/render/Renderer.ts
 * @desc The host seam: the command protocol's shape and its runtime gate, a
 * LocalSimHost round trip, the developer overlay, replay equality across the
 * protocol, and the architecture guards that keep the presentation layers off
 * the Simulation class.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../../src/sim/Simulation';
import {
  COMMAND_SHAPES,
  COMMAND_TYPES,
  LocalSimHost,
  applyCommand,
  createLocalHost,
  decodeCommand,
} from '../../src/sim/host';
import type { SimCommand, SimHost } from '../../src/sim/host';
import { DevMode } from '../../src/dev/DevMode';
import { ROVERS } from '../../src/sim/defs';
import { DEFAULT_WORLD_OPTIONS } from '../../src/sim/difficulty';
import { group, test, finish } from '../harness';

/**
 * One well-formed instance of every command in the protocol. Adding a command
 * means adding it here, which is the point: the sample table is where a new
 * message has to prove it is expressible as plain data before it is accepted.
 */
const SAMPLES: Record<SimCommand['type'], SimCommand> = {
  'rover/move': { type: 'rover/move', roverId: 1000, x: 12, z: -8, queue: false },
  'rover/mine': { type: 'rover/mine', roverId: 1000, depositId: 1, queue: false },
  'rover/unload': { type: 'rover/unload', roverId: 1000, queue: false },
  'rover/wait': { type: 'rover/wait', roverId: 1000, seconds: 60, queue: true },
  'rover/construct': { type: 'rover/construct', roverId: 1000, buildingId: 1, queue: false },
  'rover/clean': { type: 'rover/clean', roverId: 1000, buildingId: 1, queue: false },
  'rover/repair': { type: 'rover/repair', roverId: 1000, buildingId: 1, queue: false },
  'rover/recover': { type: 'rover/recover', roverId: 1000, strandedId: 1001, queue: false },
  'rover/salvage': { type: 'rover/salvage', roverId: 1000, poiId: 3, queue: false },
  'rover/stop': { type: 'rover/stop', roverId: 1000 },
  'rover/repeatRoute': { type: 'rover/repeatRoute', roverId: 1000, on: true },
  'rover/rule': { type: 'rover/rule', roverId: 1000, rule: 'autoHaul', on: true },
  'rover/chargeFloor': { type: 'rover/chargeFloor', roverId: 1000, pct: 40 },
  'rover/lights': { type: 'rover/lights', roverId: 1000, on: false },
  'building/place': { type: 'building/place', kind: 'warehouse', x: 40, z: 40 },
  'building/toggle': { type: 'building/toggle', buildingId: 1, enabled: false },
  'building/demolish': { type: 'building/demolish', buildingId: 1 },
  'building/maintain': { type: 'building/maintain', buildingId: 1 },
  'building/assemble': { type: 'building/assemble', buildingId: 1, kind: 'cargo' },
  'colonist/order': { type: 'colonist/order', order: { type: 'shelter' } },
  'dev/time': { type: 'dev/time', sol: 3, frac: 0.5 },
  'dev/storm/force': { type: 'dev/storm/force', kind: 'severe' },
  'dev/storm/clear': { type: 'dev/storm/clear' },
  'dev/storm/scheduler': { type: 'dev/storm/scheduler', on: false },
  'dev/dust': { type: 'dev/dust', frac: 0.5 },
  'dev/spawn/rover': { type: 'dev/spawn/rover', kind: 'cargo', x: 30, z: -30 },
  'dev/spawn/building': { type: 'dev/spawn/building', kind: 'solar', x: 45, z: 45 },
  'dev/spawn/deposit': { type: 'dev/spawn/deposit', resource: 'ice', x: 50, z: 50, kg: 2000 },
  'dev/building/complete': { type: 'dev/building/complete', buildingId: 1 },
  'dev/building/level': { type: 'dev/building/level', buildingId: 1, level: 3 },
  'dev/building/health': { type: 'dev/building/health', buildingId: 1, pct: 60 },
  'dev/building/damaged': { type: 'dev/building/damaged', buildingId: 1, on: true },
  'dev/building/cleanliness': { type: 'dev/building/cleanliness', buildingId: 1, frac: 0.5 },
  'dev/rover/battery': { type: 'dev/rover/battery', roverId: 1000, frac: 0.5 },
  'dev/rover/cargo': { type: 'dev/rover/cargo', roverId: 1000, resource: 'iron', kg: 100 },
  'dev/rover/cargoClear': { type: 'dev/rover/cargoClear', roverId: 1000 },
  'dev/rover/condition': { type: 'dev/rover/condition', roverId: 1000, pct: 80 },
  'dev/colonist/health': { type: 'dev/colonist/health', pct: 70 },
  'dev/colonist/suit': { type: 'dev/colonist/suit' },
};

const freshSim = () => new Simulation({ seed: 7, nearDeposits: 0.2 });

// ------------------------------------------------------------ protocol ----

group('Command protocol');

test('the protocol, the shape table and the sample set name the same commands', () => {
  const declared = Object.keys(COMMAND_SHAPES).sort();
  const listed = [...COMMAND_TYPES].sort();
  assert.deepEqual(declared, listed, 'COMMAND_SHAPES and COMMAND_TYPES disagree');
  assert.deepEqual(
    Object.keys(SAMPLES).sort(),
    listed,
    'every command needs a sample here — a new message must be expressible as data',
  );
});

test('every command decodes, applies, and answers with a well-formed ack', () => {
  const sim = freshSim(); // one world for all of them: this is about shape, not side effects
  for (const type of COMMAND_TYPES) {
    const command = SAMPLES[type];
    const decoded = decodeCommand(command);
    assert.ok(decoded.ok, `${type} must decode: ${'error' in decoded ? decoded.error : ''}`);
    // Applying any of them to a fresh colony must be survivable: a command that
    // names a missing entity is stale UI intent, and the sim answers rather
    // than throwing across what may one day be a thread boundary.
    const sim = freshSim();
    const ack = applyCommand(sim, command);
    assert.equal(typeof ack.ok, 'boolean', `${type} returned a shapeless ack`);
    if ('value' in ack) assert.equal(typeof ack.value, 'number', `${type}.value`);
    if ('entityId' in ack) assert.ok((ack.entityId ?? 0) > 0, `${type}.entityId`);
    if (ack.error !== undefined) {
      assert.equal(typeof ack.error, 'string', `${type} refused without a readable reason`);
      assert.ok(!ack.ok, `${type} explained a success — a reason belongs to a refusal only`);
    }
  }
});

test('the gate refuses anything the protocol does not name', () => {
  const rejects: unknown[] = [
    undefined,
    null,
    'move the rover',
    {},
    { type: 'rover/teleport', roverId: 1000 },
    { type: 'rover/move', roverId: 1000, x: 1, z: 1 }, // queue missing
    { type: 'rover/move', roverId: 1000, x: NaN, z: 1, queue: false },
    { type: 'rover/move', roverId: 1000, x: 1, z: Infinity, queue: false },
    { type: 'rover/move', roverId: 1.5, x: 1, z: 1, queue: false }, // id is an integer
    { type: 'rover/move', roverId: -1, x: 1, z: 1, queue: false },
    { type: 'rover/wait', roverId: 1000, seconds: -5, queue: false },
    { type: 'rover/rule', roverId: 1000, rule: 'autoEverything', on: true },
    { type: 'building/place', kind: 'deathstar', x: 1, z: 1 },
    { type: 'colonist/order', order: { type: 'walkTheMoon' } },
    { type: 'dev/dust', frac: 4 }, // a fraction, not 0..1
    { type: 'dev/rover/battery', roverId: 1000, frac: 1.5 },
    { type: 'dev/rover/condition', roverId: 1000, pct: 900 },
    { type: 'dev/rover/battery', roverId: 1000, frac: 0.5, extra: true }, // strict keys
    { type: 'dev/storm/clear', sol: 4 },
  ];
  for (const raw of rejects) {
    const r = decodeCommand(raw);
    assert.ok(!r.ok, `${JSON.stringify(raw)} should have been refused`);
  }
});

test('world coordinates may be negative; the landing site is the origin', () => {
  const ok = decodeCommand({ type: 'rover/move', roverId: 1000, x: -70.5, z: -12, queue: false });
  assert.ok(ok.ok, 'orders west and south of the pod are ordinary');
});

// --------------------------------------------------------------- host ----

group('LocalSimHost');

test('a command through the host changes the world and answers with the new id', () => {
  const host = createLocalHost({
    seed: 8,
    difficulty: 'pioneer',
    worldHalf: 640,
    region: null,
    worldOptions: { ...DEFAULT_WORLD_OPTIONS, nearDeposits: 0.2 },
  });
  const spot = findOpenSpot(host);
  const ack = host.request({ type: 'building/place', kind: 'warehouse', x: spot.x, z: spot.z });
  assert.ok(ack.ok, ack.error ?? 'the warehouse should have been sited');
  assert.equal(host.view.buildings.length, 1);
  assert.equal(host.view.buildings[0].id, ack.entityId, 'the ack carries the id the sim chose');
  // …and the view is the same world, so placement is visible without a reload.
  assert.ok(
    host.view.canPlace('warehouse', spot.x, spot.z) !== null,
    'the spot is now spoken for, per the view',
  );
});

test('an illegal placement is refused as data, and the world is untouched', () => {
  const host = createLocalHost({
    seed: 9,
    difficulty: 'pioneer',
    worldHalf: 640,
    region: null,
    worldOptions: { ...DEFAULT_WORLD_OPTIONS, nearDeposits: 0.2 },
  });
  const ack = host.request({ type: 'building/place', kind: 'habitat', x: 0, z: 0 });
  assert.equal(ack.ok, false, 'the descent stage is already there');
  assert.equal(typeof ack.error, 'string');
  assert.equal(host.view.buildings.length, 0);
});

test('a malformed command is dropped loudly and changes nothing', () => {
  const sim = freshSim();
  const host = new LocalSimHost(sim);
  const before = JSON.stringify(sim.snapshot());
  const errors: unknown[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args[0]);
  try {
    // Standing on the type here is the point: the runtime gate must catch what
    // a caller slipped past, because across a worker there is no type at all.
    host.send({ type: 'rover/stop' } as unknown as SimCommand);
  } finally {
    console.error = realError;
  }
  assert.equal(errors.length, 1, 'the drop is reported once');
  assert.match(String(errors[0]), /malformed command/);
  assert.equal(JSON.stringify(sim.snapshot()), before, 'a refused command is inert');
});

test('orders reach the rover they name, and only that rover', () => {
  const sim = freshSim();
  const host = new LocalSimHost(sim);
  const [a, b] = sim.rovers;
  host.send({ type: 'rover/move', roverId: a.id, x: 20, z: 20, queue: false });
  host.send({ type: 'rover/wait', roverId: b.id, seconds: 30, queue: false });
  assert.equal(host.view.roverById(a.id)?.command.type, 'moveTo');
  assert.equal(host.view.roverById(b.id)?.command.type, 'wait');
});

test('the event queue is drained by the host, once', () => {
  const sim = freshSim();
  const host = new LocalSimHost(sim);
  // autoHaul is chosen deliberately: unlike the lights switch, it always has
  // something to say, so the assertion is about the queue and not about a
  // command that legitimately decided to stay quiet.
  host.send({ type: 'rover/rule', roverId: sim.rovers[0].id, rule: 'autoHaul', on: true });
  const first = host.drainEvents();
  assert.ok(first.length > 0, 'the lights order logs a line');
  assert.equal(host.drainEvents().length, 0, 'a drain consumes');
});

test('the snapshot travels through the host and reloads into the same world', async () => {
  const sim = freshSim();
  const host = new LocalSimHost(sim);
  host.send({ type: 'dev/rover/battery', roverId: sim.rovers[0].id, frac: 0.25 });
  host.step(2);
  const snapshot = await host.requestSnapshot();
  const revived = createLocalHost({
    seed: 1,
    difficulty: 'pioneer',
    worldHalf: 640,
    region: null,
    worldOptions: { ...DEFAULT_WORLD_OPTIONS, nearDeposits: 0.2 },
  });
  await revived.loadSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(JSON.stringify(await revived.requestSnapshot()), JSON.stringify(snapshot));
});

test('a disposed host refuses further edits', () => {
  const sim = freshSim();
  const host = new LocalSimHost(sim);
  host.dispose();
  const ack = host.request({ type: 'dev/colonist/suit' });
  assert.equal(ack.ok, false, 'the colony has shut down');
  assert.equal(host.view.simTime, 0, 'and no step runs after it');
});

// ------------------------------------------------------------ overlays ----

group('Runtime overlays');

test('the battery pin rides the host, not the frame loop', () => {
  const sim = new Simulation({ seed: 22 });
  const host = new LocalSimHost(sim);
  const dev = new DevMode(() => {});
  dev.enabled = true;
  dev.attach(host);
  const r = sim.rovers[0];
  const full = ROVERS[r.kind].maxBatteryKWh;

  dev.setKeepBatteryFull(r.id, true);
  r.battery = 2;
  host.step(1 / 20);
  assert.equal(r.battery, full, 'a step holds the pin — no per-frame call needed');

  dev.detach();
  r.battery = 2;
  host.step(1 / 20);
  assert.ok(r.battery < full, 'detaching stops the overlay touching the charge');
});

test('an overlay edit never reaches the save file', async () => {
  const sim = new Simulation({ seed: 23 });
  const host = new LocalSimHost(sim);
  const dev = new DevMode(() => {});
  dev.enabled = true;
  dev.attach(host);
  dev.setKeepBatteryFull(sim.rovers[0].id, true);
  host.step(1 / 20);
  const payload = JSON.stringify(await host.requestSnapshot());
  assert.ok(!/keepBatteryFull|overlay/i.test(payload), 'the mode itself is not serialised');
  assert.ok(!payload.includes('"armedSpawn"'), 'neither is the armed spawn');
});

// -------------------------------------------------------------- replay ----

group('Replay through the protocol');

test('two colonies fed the same command script stay bit-identical', async () => {
  const boot = () =>
    createLocalHost({
      seed: 7,
      difficulty: 'pioneer',
      worldHalf: 640,
      region: null,
      worldOptions: { ...DEFAULT_WORLD_OPTIONS, nearDeposits: 0.2 },
    });
  const script: SimCommand[] = [
    { type: 'rover/mine', roverId: 1000, depositId: 0, queue: false },
    { type: 'rover/rule', roverId: 1001, rule: 'autoHaul', on: true },
    { type: 'dev/storm/force', kind: 'regional' },
    { type: 'dev/time', sol: 1, frac: 0.5 },
    { type: 'colonist/order', order: { type: 'shelter' } },
  ];
  interface Played {
    ticksRun: number;
    rovers: unknown[];
    simTime: number;
  }
  // Two hosts, one seed, the same script in the same order. What is being
  // pinned is that the command protocol is a *complete* description of play:
  // nothing a UI does rides on object identity or call timing, so a worker
  // replaying the transcript lands on the identical colony.
  const play = async (): Promise<Played> => {
    const host = boot();
    for (const cmd of script) host.send(cmd);
    for (let i = 0; i < 40; i++) host.step(1 / 20);
    return JSON.parse(JSON.stringify(await host.requestSnapshot())) as Played;
  };
  const a = await play();
  const b = await play();
  assert.deepEqual(a, b, 'the same transcript diverged');
  assert.equal(a.ticksRun, 40, 'the whole script ran through 40 fixed ticks');
  assert.equal(a.simTime, b.simTime, 'and the clock agrees about it');
  assert.equal(a.rovers.length, 2, 'the two starting rovers are the ones the script ordered');
});

// --------------------------------------------------------- architecture ----

group('Architecture guards');

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'host') continue; // the host layer is allowed to own the sim
      out.push(...tsFiles(path));
    } else if (entry.name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** The presentation layers: everything that must speak to the sim only via a host. */
const CLIENT_DIRS = ['app', 'ui', 'render', 'dev'];

test('no presentation module imports the Simulation class', () => {
  const offenders: string[] = [];
  for (const dir of CLIENT_DIRS) {
    for (const file of tsFiles(`${SRC}/${dir}`)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[^']*sim\/Simulation'/g)) {
        const names = match[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]);
        if (names.includes('Simulation')) offenders.push(`${file.replace(SRC, 'src')}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'read the world through SimView and change it with a SimCommand; the Simulation class ' +
      'belongs to the host layer alone (see src/sim/host)',
  );
});

/**
 * The names a `SimQuery` may not carry: every one of these is a write, and a
 * view that exposed one would let the UI mutate state that a worker's snapshot
 * cannot hold. Checked against the pick lists in `view.ts` by name, which is a
 * heuristic on purpose — it is the *shape* of the seam that must stay legible.
 */
const MUTATOR_PATTERNS = [
  /^issue/,
  /^set/,
  /^dev[A-Z]/,
  /^give/,
  /^finish/,
  /^apply/,
  /^restore$/,
  /^snapshot$/,
  /^step$/,
  /^drain/,
  /^place/,
  /^demolish/,
  /^dispatch/,
  /^assemble/,
  /^order/,
  /^stop/,
  /^recompute/,
  /^clear/,
  /^spawn/,
  /^update$/,
];

test('the view exposes queries only — no sim mutator survives the pick list', () => {
  const view = readFileSync(`${SRC}/sim/host/view.ts`, 'utf8');
  const pickLists = [...view.matchAll(/Pick<\s*\n?\s*(?:Simulation|AlertBus|SolClock|World),\n([^>]*?)\n\s*>/g)].map(
    (m) => m[1],
  );
  assert.ok(pickLists.length >= 2, 'the guard expects the view to be built from Pick lists');
  const names = pickLists
    .join('\n')
    .split('\n')
    .map((line) => line.replace(/[^a-zA-Z']/g, '').replace(/'/g, '').trim())
    .filter(Boolean);
  assert.ok(names.length > 10, 'the pick lists parsed empty');
  const offenders = names.filter((n) => MUTATOR_PATTERNS.some((re) => re.test(n)));
  assert.deepEqual(
    offenders,
    [],
    `"${offenders.join('", "')}" is a write; it belongs in the command protocol, not the view`,
  );
});

test('the app shell reaches the world only through read queries and order()', () => {
  const app = readFileSync(`${SRC}/app/Game.ts`, 'utf8');
  // Derive the allow-list from the view's own pick list, so the two cannot drift.
  const view = readFileSync(`${SRC}/sim/host/view.ts`, 'utf8');
  const queryList = /SimQuery = Pick<\s*\n?\s*Simulation,\n([^>]*?)\n\s*>/.exec(view)?.[1] ?? '';
  const allowed = new Set(
    queryList
      .split('\n')
      .map((line) => line.replace(/[^a-zA-Z]/g, ''))
      .filter(Boolean),
  );
  const seen: string[] = [];
  for (const match of app.matchAll(/\bthis\.sim\.([a-zA-Z]+)\s*\(/g)) {
    const name = match[1];
    if (!allowed.has(name)) seen.push(name);
  }
  assert.deepEqual(
    [...new Set(seen)],
    [],
    'a non-query call on the view means a write is bypassing the host',
  );
});

// ------------------------------------------------------------- fixtures ----

/** The first ring position around the pod where the view says a build is legal. */
function findOpenSpot(host: SimHost): { x: number; z: number } {
  for (let r = 34; r <= 160; r += 2) {
    for (let a = 0; a < 360; a += 5) {
      const x = Math.round(Math.cos((a * Math.PI) / 180) * r);
      const z = Math.round(Math.sin((a * Math.PI) / 180) * r);
      if (host.view.canPlace('warehouse', x, z) === null) return { x, z };
    }
  }
  throw new Error('no open spot on the map');
}

/** Strip comments so a guard matches code, not prose about a "play window". */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('the sim side of the wire has no DOM to lean on', () => {
  // The runtime imports the whole simulation, so if *any* sim file reaches for a
  // browser global the worker will not boot — and it would fail at import time,
  // inside a thread with no stack trace worth reading. Cheaper to forbid here.
  const offenders: string[] = [];
  const forbidden = /\b(document|window|localStorage|requestAnimationFrame|HTMLElement|HTMLCanvasElement)\b/;
  for (const file of tsFiles(`${SRC}/sim`)) {
    if (file.endsWith('sim.worker.ts')) continue; // the bolt is allowed its `self`
    if (forbidden.test(code(readFileSync(file, 'utf8')))) offenders.push(file.replace(SRC, 'src'));
  }
  assert.deepEqual(offenders, [], 'src/sim must stay headless: a Worker has no DOM, and the save path has no window');
});

test('the worker entry imports the runtime and nothing else', () => {
  const source = code(readFileSync(`${SRC}/sim/sim.worker.ts`, 'utf8'));
  const from = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(from, ['./host/workerRuntime'], 'seven lines, one dependency: if this grows, the boundary has leaked');
  assert.ok(!/new Worker|postMessage\s*\(\s*\{\s*kind:\s*'advance'/.test(source), 'and it drives nothing itself');
});

test('every query the view promises is answered by the mirror', () => {
  // Adding a member to `SimQuery` without implementing it in `mirror.ts` would
  // otherwise surface as a runtime `undefined` on the worker path only, on the
  // day someone turns the worker on. The types already catch it in `Simulation`;
  // this catches it in the *protocol*, which is where the cost is paid.
  const view = readFileSync(`${SRC}/sim/host/view.ts`, 'utf8');
  const pick = view.match(/export type SimQuery = Pick<\n\s*Simulation,\n([^>]*?)>;\n/s);
  assert.ok(pick, 'the SimQuery pick list is still declared the documented way');
  const names = (pick?.[1] ?? '')
    .split('|')
    .map((raw) => raw.trim().replace(/'/g, ''))
    .filter((n) => n.length > 0);
  assert.ok(names.length >= 8, `found ${names.length} queries, which is fewer than the view has`);
  const mirror = code(readFileSync(`${SRC}/sim/host/mirror.ts`, 'utf8'));
  const missing = names.filter((n) => !new RegExp(`\\b${n}\\s*[(:=]`).test(mirror));
  assert.deepEqual(missing, [], 'mirror.ts must answer each of these');

  // And the payload has to carry what the mirror needs to answer them: the
  // fields a projection forgets are the fields a HUD shows as zero.
  const projection = code(readFileSync(`${SRC}/sim/host/projection.ts`, 'utf8'));
  for (const key of ['rovers', 'buildings', 'colonist', 'storage', 'pools', 'power', 'weather', 'alerts', 'deposits', 'history']) {
    assert.match(projection, new RegExp(`\\b${key}:`), `the payload carries ${key}`);
  }
});

await finish('sim/host');
