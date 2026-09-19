/**
 * @suite sim/command-architecture
 * @group unit
 * @covers src/sim/host/protocol.ts src/sim/host/applyCommand.ts src/sim/debug/Transcript.ts src/app/SelectionController.ts src/dev/DevMode.ts
 * @desc Phase 22 command architecture: the PlayerCommand/DevCommand partition
 * of the protocol, the split dispatch behind the single applyCommand entry
 * point, the transcript replayer sharing that dispatch, and the origin rule
 * that only the developer panel constructs dev/* commands.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../../src/sim/Simulation';
import {
  COMMAND_TYPES,
  DEV_COMMAND_TYPES,
  PLAYER_COMMAND_TYPES,
  applyCommand,
  applyDevCommand,
  applyPlayerCommand,
  decodeCommand,
  isDevCommand,
  isPlayerCommand,
} from '../../src/sim/host';
import type { SimCommand, SimCommandType } from '../../src/sim/host';
import { TranscriptBuilder, replayTranscript } from '../../src/sim/debug/Transcript';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { group, test, finish } from '../harness';

/**
 * One well-formed instance of every command in the protocol. `sim/host` keeps
 * its own copy for shape coverage; this one exists so the partition and the
 * split dispatch can be driven without importing another suite — and, like
 * that table, it fails loudly when a new command arrives without a sample.
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
  'dev/lightning/strike': { type: 'dev/lightning/strike' },
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

// --------------------------------------------------------------- partition ----

group('Protocol partition');

test('the player and dev lists partition the protocol, disjoint and in wire order', () => {
  assert.deepEqual(
    [...PLAYER_COMMAND_TYPES, ...DEV_COMMAND_TYPES],
    [...COMMAND_TYPES],
    'COMMAND_TYPES is the player half followed by the dev half, in order',
  );
  const player: Set<SimCommandType> = new Set(PLAYER_COMMAND_TYPES);
  const dev: Set<SimCommandType> = new Set(DEV_COMMAND_TYPES);
  assert.equal(player.size, PLAYER_COMMAND_TYPES.length, 'no duplicate player type');
  assert.equal(dev.size, DEV_COMMAND_TYPES.length, 'no duplicate dev type');
  for (const type of player) {
    assert.ok(!dev.has(type), `${type} is in both halves`);
  }
  assert.equal(player.size + dev.size, COMMAND_TYPES.length, 'no command is in neither half');
});

test('the dev/ prefix rule names exactly the dev half', () => {
  for (const type of DEV_COMMAND_TYPES) {
    assert.ok(type.startsWith('dev/'), `${type} is a backdoor without the prefix`);
  }
  for (const type of PLAYER_COMMAND_TYPES) {
    assert.ok(!type.startsWith('dev/'), `${type} is a player order wearing the dev prefix`);
  }
});

test('every command has a sample here, and the guards agree with the lists', () => {
  assert.deepEqual(
    Object.keys(SAMPLES).sort(),
    [...COMMAND_TYPES].sort(),
    'a new command needs a sample here before it is covered',
  );
  for (const type of COMMAND_TYPES) {
    const sample = SAMPLES[type];
    assert.equal(isDevCommand(sample), DEV_COMMAND_TYPES.includes(type as never), `${type} guard`);
    assert.equal(isPlayerCommand(sample), PLAYER_COMMAND_TYPES.includes(type as never), `${type} guard`);
    assert.notEqual(isDevCommand(sample), isPlayerCommand(sample), `${type} is in exactly one half`);
  }
});

test('decodeCommand accepts both halves of the split union', () => {
  for (const type of COMMAND_TYPES) {
    const decoded = decodeCommand(SAMPLES[type]);
    assert.ok(decoded.ok, `${type} must still decode: ${'error' in decoded ? decoded.error : ''}`);
  }
});

// ------------------------------------------------------------ split dispatch ----

group('Split dispatch');

test('the split dispatch equals applyCommand, ack and resulting state', () => {
  for (const type of COMMAND_TYPES) {
    const viaEntry = freshSim();
    const viaHalf = freshSim();
    const ackEntry = applyCommand(viaEntry, SAMPLES[type]);
    const ackHalf = isDevCommand(SAMPLES[type])
      ? applyDevCommand(viaHalf, SAMPLES[type])
      : applyPlayerCommand(viaHalf, SAMPLES[type]);
    assert.deepEqual(ackHalf, ackEntry, `${type} ack differs between the entry point and the half`);
    assert.equal(
      JSON.stringify(viaHalf.snapshot()),
      JSON.stringify(viaEntry.snapshot()),
      `${type} lands differently through the split dispatch`,
    );
  }
});

test('a mixed player+dev transcript replays deterministically through the shared dispatch', () => {
  const probe = new Simulation({ seed: 11 });
  const deposit = probe.world.deposits[0];
  const build = () =>
    new TranscriptBuilder(11)
      .at(0, { type: 'rover/mine', roverId: 1000, depositId: deposit.id, queue: false })
      .at(0, { type: 'dev/time', sol: 1, frac: 0.4 })
      .at(10, { type: 'dev/dust', frac: 0.35 })
      .at(20, { type: 'rover/rule', roverId: 1001, rule: 'autoHaul', on: true })
      .at(30, { type: 'dev/rover/battery', roverId: 1000, frac: 0.9 })
      .duration(400)
      .build();
  const a = replayTranscript(build());
  const b = replayTranscript(build());
  assert.equal(hashSimulation(a.sim), hashSimulation(b.sim), 'the same mixed transcript diverged');
  // …and the replay is not vacuous: both halves visibly landed.
  assert.equal(a.sim.rovers[1].rules.autoHaul, true, 'the player order landed');
  assert.equal(a.sim.dustTransmission < 1, true, 'the dev edit landed');
});

// --------------------------------------------------------- architecture ----

group('Architecture guards');

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Strip comments so a guard matches code, not prose about a `dev/` path. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('only the developer panel constructs dev/* commands', () => {
  // The audio cue table keys its rows by command type (`'dev/time': ...`), so
  // the pattern requires the `type:` key — a command *construction*, not a
  // mention. `src/sim/host/protocol.ts` defines the union itself and the test
  // tree is allowed its fixtures; everything else outside `src/dev` is game
  // code, and game code sends player orders.
  const offenders: string[] = [];
  for (const dir of ['app', 'ui', 'render', 'audio']) {
    for (const file of tsFiles(`${SRC}/${dir}`)) {
      if (/type:\s*['"]dev\//.test(code(readFileSync(file, 'utf8')))) {
        offenders.push(file.replace(SRC, 'src'));
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a dev/* command outside src/dev means game code reaching for a backdoor — send a PlayerCommand instead',
  );
  assert.ok(
    /type:\s*['"]dev\//.test(code(readFileSync(`${SRC}/dev/DevMode.ts`, 'utf8'))),
    'the guard is vacuous unless the pattern matches the real sender',
  );
});

test('transcripts dispatch through the shared applyCommand, not a private copy', () => {
  const transcript = code(readFileSync(`${SRC}/sim/debug/Transcript.ts`, 'utf8'));
  assert.match(transcript, /from '\.\.\/host\/applyCommand'/, 'the replayer imports the shared dispatch');
  assert.match(transcript, /applyCommand\(sim, cmd\)/, 'and every transcripted command goes through it');
  assert.ok(
    !/case '(rover|building|colonist|dev)\//.test(transcript),
    'a case arm here is a second dispatch table — the protocol has one owner',
  );
});

test('the player gesture path is typed PlayerCommand', () => {
  const selection = code(readFileSync(`${SRC}/app/SelectionController.ts`, 'utf8'));
  assert.match(
    selection,
    /order\(command: PlayerCommand\)/,
    'SelectionController.order takes the player half, so a gesture cannot construct a backdoor',
  );
});

await finish('sim/command-architecture');
