/**
 * @suite sim/golden-colony
 * @group determinism
 * @covers src/sim/debug/Transcript.ts src/sim/debug/StateHash.ts src/sim/persistence/ColonyPersistence.ts
 * @desc Phase 0 golden colony — canonical transcript + pinned hash + save, the "can we safely build on this?" gate.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayTranscript, replayAndHash, decodeTranscript } from '../../src/sim/debug/Transcript';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { assertInvariants } from '../../src/sim/debug/SimulationAssertions';
import { Simulation } from '../../src/sim/Simulation';
import { group, test, finish } from '../harness';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const goldenDir = path.join(root, 'tests', 'golden-colony');

group('Golden colony artifacts');

test('golden colony transcript exists and is valid', () => {
  const p = path.join(goldenDir, 'golden-colony.transcript.json');
  assert.ok(fs.existsSync(p), 'golden-colony.transcript.json must exist (run generate-golden-colony.mjs --write)');
  const raw = fs.readFileSync(p, 'utf8');
  const t = decodeTranscript(raw);
  assert.equal(t.seed, 9001);
  assert.ok(t.commands.length >= 11, 'should have at least 11 building placements');
  assert.ok((t.durationTicks ?? 0) >= 20000, 'should run at least 5 sols');
});

test('golden colony hash file exists and matches format', () => {
  const p = path.join(goldenDir, 'golden-colony.hash.txt');
  assert.ok(fs.existsSync(p), 'golden-colony.hash.txt must exist');
  const hash = fs.readFileSync(p, 'utf8').trim();
  assert.match(hash, /^rf1-[0-9a-f]{14}-[0-9a-f]{14}$/, 'hash format must be rf1-<14hex>-<14hex>');
});

test('golden colony save file exists and decodes', () => {
  const p = path.join(goldenDir, 'golden-colony.save.json');
  assert.ok(fs.existsSync(p), 'golden-colony.save.json must exist');
  const raw = fs.readFileSync(p, 'utf8');
  const save = JSON.parse(raw);
  assert.ok(save.version >= 13, 'save version should be current');
  assert.ok(save.seed === 9001, 'save seed must match transcript');
  assert.ok(Array.isArray(save.buildings), 'save must have buildings');
  assert.ok(Array.isArray(save.rovers), 'save must have rovers');
});

group('Golden colony replay determinism');

test('transcript replays to pinned hash (Phase 0 gate)', () => {
  const transcriptPath = path.join(goldenDir, 'golden-colony.transcript.json');
  const hashPath = path.join(goldenDir, 'golden-colony.hash.txt');
  if (!fs.existsSync(transcriptPath) || !fs.existsSync(hashPath)) {
    // Skip if artifacts not present — generation is manual
    return;
  }
  const transcript = decodeTranscript(fs.readFileSync(transcriptPath, 'utf8'));
  const expectedHash = fs.readFileSync(hashPath, 'utf8').trim();
  const { hash, result } = replayAndHash(transcript);
  assert.equal(hash, expectedHash, `golden colony replay must match pinned hash\n  expected: ${expectedHash}\n  actual:   ${hash}\n  If intentional, run node scripts/generate-golden-colony.mjs --write`);
  assertInvariants(result.sim);
});

test('golden colony save restores and invariants hold', () => {
  const savePath = path.join(goldenDir, 'golden-colony.save.json');
  if (!fs.existsSync(savePath)) return;
  const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  const sim = new Simulation({ seed: save.seed });
  sim.restore(save);
  assertInvariants(sim);
  // After restore, advancing a bit should keep invariants
  for (let i = 0; i < 100; i++) sim.step(1 / 20);
  assertInvariants(sim);
});

test('golden colony save round-trip preserves hash when restored-vs-restored', () => {
  // Per StateHash contract, live vs restored differ (rest at rest), but restored-vs-restored must match
  const savePath = path.join(goldenDir, 'golden-colony.save.json');
  if (!fs.existsSync(savePath)) return;
  const save = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  const simA = new Simulation({ seed: save.seed });
  simA.restore(save);
  const simB = new Simulation({ seed: save.seed });
  simB.restore(save);
  const hashA = hashSimulation(simA);
  const hashB = hashSimulation(simB);
  assert.equal(hashA, hashB, 'restored-vs-restored must be deterministic');
});

test('golden colony has viable colony shape', () => {
  const transcriptPath = path.join(goldenDir, 'golden-colony.transcript.json');
  if (!fs.existsSync(transcriptPath)) return;
  const transcript = decodeTranscript(fs.readFileSync(transcriptPath, 'utf8'));
  const result = replayTranscript(transcript);
  const sim = result.sim;
  // Check that we have expected buildings online
  const onlineKinds = sim.buildings.filter(b => b.state === 'online').map(b => b.kind);
  // At least warehouse, solar, battery should be online after 5 sols
  assert.ok(onlineKinds.includes('warehouse'), 'warehouse should be online');
  assert.ok(onlineKinds.includes('solar'), 'solar should be online');
  assert.ok(onlineKinds.includes('battery'), 'battery should be online');
  // Storage should have some resources
  assert.ok(sim.storage.iron >= 0, 'iron storage exists');
  // Colonist alive
  assert.ok(!sim.colonist.dead, 'colonist should be alive after 5 sols');
  assert.ok(sim.colonist.health > 0, 'colonist health positive');
});

await finish('sim/golden-colony');
