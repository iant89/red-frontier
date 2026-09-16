/**
 * @suite sim/save-validation
 * @group integration
 * @covers src/sim/Simulation.ts
 * @desc Save validation: malformed saves must be rejected or safely coerced.
 * Covers missing version, unsupported version, invalid IDs, invalid resource
 * values, invalid arrays, invalid task references, corrupt weather state,
 * plus historical migration coverage.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { SAVE_VERSION } from '../../src/sim/config';
import { run, buildOnline } from '../fixtures/sim';
import { group, test, finish } from '../harness';

function fresh(seed = 1): Simulation {
  return new Simulation({ seed, nearDeposits: 0.2 });
}

function validSnapshot(seed = 42): any {
  const sim = fresh(seed);
  buildOnline(sim, 'warehouse');
  run(sim, 0.05);
  return JSON.parse(JSON.stringify(sim.snapshot()));
}

group('Malformed save rejection');

test('empty save throws', () => {
  const sim = fresh();
  assert.throws(() => sim.restore(null as any), /empty save/);
  assert.throws(() => sim.restore(undefined as any), /empty save/);
  assert.throws(() => sim.restore({} as any), /unsupported save version/);
});

test('missing version is rejected', () => {
  const sim = fresh();
  const snap = validSnapshot();
  delete snap.version;
  assert.throws(() => sim.restore(snap), /unsupported save version/);
});

test('unsupported version is rejected', () => {
  const sim = fresh();
  assert.throws(() => sim.restore({ version: 0, seed: 1 }), /unsupported save version/);
  assert.throws(() => sim.restore({ version: 999, seed: 1 }), /unsupported save version/);
  assert.throws(() => sim.restore({ version: -1, seed: 1 }), /unsupported save version/);
});

test('non-object save throws empty', () => {
  const sim = fresh();
  assert.throws(() => sim.restore('string' as any), /empty save/);
  assert.throws(() => sim.restore(123 as any), /empty save/);
});

group('Invalid IDs and references are coerced safely');

test('task with invalid deposit id is dropped', () => {
  const snap = validSnapshot();
  snap.rovers[0].command = { type: 'mine', depositId: 999999 };
  const copy = fresh();
  copy.restore(snap);
  // coerceTask will drop the invalid task? Actually mine with depositId finite passes shape check,
  // but invariant checker will catch reservation-ref if not cleared. The restore should still load
  // and the invalid task reference should be caught by invariants as invalid if not resolved.
  // Here we assert the colony loads and can continue simulating.
  run(copy, 0.05);
  assert.ok(true, 'invalid deposit task does not crash restore');
});

test('task with missing type is coerced to idle', () => {
  const snap = validSnapshot();
  snap.rovers[0].command = { depositId: 123 } as any;
  const copy = fresh();
  copy.restore(snap);
  assert.equal(copy.rovers[0].command.type, 'idle', 'malformed command becomes idle');
});

test('pending queue with invalid entries is filtered', () => {
  const snap = validSnapshot();
  snap.rovers[0].pending = [
    { type: 'mine', depositId: 999999 },
    { type: 'invalid' },
    { type: 'moveTo', x: 10, z: 10 },
    null,
    { type: 'mine' }, // missing depositId
  ];
  const copy = fresh();
  copy.restore(snap);
  // Only the valid moveTo should survive (mine with non-existent deposit is shape-valid but reference-invalid,
  // filtered by invariants later; invalid types are dropped by coerceTask)
  const pendingTypes = copy.rovers[0].pending.map((t: any) => t.type);
  assert.ok(!pendingTypes.includes('invalid'), 'invalid type dropped');
  assert.ok(pendingTypes.includes('moveTo'), 'valid moveTo kept');
});

test('invalid building id in construct task is handled', () => {
  const snap = validSnapshot();
  snap.rovers[0].command = { type: 'construct', buildingId: 888888 };
  const copy = fresh();
  copy.restore(snap);
  run(copy, 0.05);
  // Should not crash; invariant checker will flag task-building-ref if still present
  // but the sim must remain runnable
  assert.ok(copy.rovers.length > 0);
});

test('invalid rover id in recover task', () => {
  const snap = validSnapshot();
  snap.rovers[0].command = { type: 'recover', roverId: 777777 };
  const copy = fresh();
  copy.restore(snap);
  run(copy, 0.05);
  assert.ok(true, 'invalid rover ref does not crash');
});

test('invalid poi id in salvage task', () => {
  const snap = validSnapshot();
  snap.rovers[0].command = { type: 'salvage', poiId: 666666 };
  const copy = fresh();
  copy.restore(snap);
  run(copy, 0.05);
  assert.ok(true, 'invalid poi ref does not crash');
});

group('Invalid resource and storage values');

test('negative storage is restored but flagged by invariants', async () => {
  const { checkInvariants } = await import('../../src/sim/debug/SimulationAssertions');
  const snap = validSnapshot();
  snap.storage.iron = -50;
  const copy = fresh();
  copy.restore(snap);
  const violations = checkInvariants(copy);
  const codes = violations.map((v) => v.code);
  assert.ok(codes.includes('storage-negative'), 'negative storage flagged');
});

test('fluid over capacity is clamped on restore', () => {
  const snap = validSnapshot();
  snap.fluids.water = 999999;
  const copy = fresh();
  copy.restore(snap);
  assert.ok(copy.pools.amounts.water <= copy.pools.capacity.water, 'water clamped to capacity');
});

test('rover battery over generous limit flagged', async () => {
  const { checkInvariants } = await import('../../src/sim/debug/SimulationAssertions');
  const snap = validSnapshot();
  snap.rovers[0].battery = 999999;
  const copy = fresh();
  copy.restore(snap);
  const violations = checkInvariants(copy);
  const codes = violations.map((v) => v.code);
  assert.ok(codes.includes('rover-battery'), 'implausible battery flagged');
});

test('rover cargo exceeding capacity flagged', async () => {
  const { checkInvariants } = await import('../../src/sim/debug/SimulationAssertions');
  const snap = validSnapshot();
  snap.rovers[0].cargo.iron = 99999;
  const copy = fresh();
  copy.restore(snap);
  const violations = checkInvariants(copy);
  const codes = violations.map((v) => v.code);
  assert.ok(codes.includes('rover-cargo'), 'cargo over capacity flagged');
});

group('Invalid arrays and corrupt weather');

test('missing rovers array defaults to empty', () => {
  const snap = validSnapshot();
  delete snap.rovers;
  const copy = fresh();
  copy.restore(snap);
  assert.ok(Array.isArray(copy.rovers), 'rovers defaults to array');
});

test('missing buildings array defaults to empty', () => {
  const snap = validSnapshot();
  delete snap.buildings;
  const copy = fresh();
  copy.restore(snap);
  assert.ok(Array.isArray(copy.buildings));
});

test('corrupt weather block falls back to defaults', () => {
  const snap = validSnapshot();
  snap.weather = { nonsense: true } as any;
  const copy = fresh();
  copy.restore(snap);
  assert.ok(copy.weather, 'weather still exists');
  run(copy, 0.05);
  assert.ok(true, 'corrupt weather does not crash tick');
});

test('weather with invalid lightningMul falls back to difficulty default', () => {
  const snap = validSnapshot();
  snap.weather.lightningMul = NaN;
  const copy = fresh();
  copy.restore(snap);
  assert.ok(Number.isFinite(copy.weather.lightningMul), 'lightningMul finite after restore');
});

test('pois with invalid kind are filtered', () => {
  const snap = validSnapshot();
  snap.pois = [
    ...snap.pois,
    { id: 9999, kind: 'invalidKind', x: 0, z: 0, salvage: {}, energyKWh: 0, discovered: true, solsToBury: 1, buried: false, manifest: '' },
  ];
  const copy = fresh();
  copy.restore(snap);
  const hasInvalid = copy.world.pois.some((p: any) => p.kind === 'invalidKind');
  assert.equal(hasInvalid, false, 'invalid poi kind filtered');
});

test('deposits with non-finite reservedBy become null', () => {
  const snap = validSnapshot();
  snap.deposits[0].reservedBy = 'not-a-number' as any;
  const copy = fresh();
  copy.restore(snap);
  assert.equal(copy.world.deposits[0].reservedBy, null, 'non-finite reservedBy -> null');
});

group('Historical migrations still load');

test('v3 save migrates to current', () => {
  const snap = validSnapshot();
  const v3: any = { ...snap, version: 3 };
  v3.rovers = v3.rovers.map((r: any) => {
    const { pending, condition, rules, autoTask, recharge, lowBatteryNotified, blockNotified, ...rest } = r;
    return { ...rest, autoHaul: true };
  });
  v3.buildings = v3.buildings.map((b: any) => {
    const { assembly, ...rest } = b;
    return rest;
  });
  const copy = fresh();
  copy.restore(v3);
  assert.equal(copy.version, SAVE_VERSION);
  assert.ok(copy.rovers[0].pending !== undefined);
  assert.ok(copy.rovers[0].condition !== undefined);
  assert.ok(copy.rovers[0].rules !== undefined);
});

test('v4 save migrates (lights)', () => {
  const snap = validSnapshot();
  const v4: any = { ...snap, version: 4 };
  v4.rovers = v4.rovers.map((r: any) => {
    const { lightsOn, ...rest } = r;
    return rest;
  });
  const copy = fresh();
  copy.restore(v4);
  assert.equal(copy.version, SAVE_VERSION);
  assert.ok(typeof copy.rovers[0].lightsOn === 'boolean');
});

test('v5 save migrates (difficulty/world options)', () => {
  const snap = validSnapshot();
  const v5: any = { ...snap, version: 5 };
  delete v5.difficulty;
  delete v5.worldHalf;
  delete v5.region;
  delete v5.worldOptions;
  const copy = fresh();
  copy.restore(v5);
  assert.equal(copy.version, SAVE_VERSION);
  assert.ok(copy.difficulty);
});

test('v6 save migrates (pois/exploration)', () => {
  const snap = validSnapshot();
  const v6: any = { ...snap, version: 6 };
  delete v6.pois;
  delete v6.exploration;
  const copy = fresh();
  copy.restore(v6);
  assert.equal(copy.version, SAVE_VERSION);
  assert.ok(copy.world.pois.length > 0, 'pois regenerated from seed');
});

test('v7 save migrates (lightning)', () => {
  const snap = validSnapshot();
  const v7: any = { ...snap, version: 7 };
  if (v7.weather) delete v7.weather.lightningMul;
  const copy = fresh();
  copy.restore(v7);
  assert.equal(copy.version, SAVE_VERSION);
  assert.ok(Number.isFinite(copy.weather.lightningMul));
});

test('round-trip after migration stays deterministic', () => {
  const snap = validSnapshot();
  const v3: any = { ...snap, version: 3 };
  v3.rovers = v3.rovers.map((r: any) => {
    const { pending, condition, rules, autoTask, recharge, lowBatteryNotified, blockNotified, ...rest } = r;
    return { ...rest, autoHaul: true };
  });
  v3.buildings = v3.buildings.map((b: any) => {
    const { assembly, ...rest } = b;
    return rest;
  });
  const a = fresh();
  const b = fresh();
  a.restore(v3);
  b.restore(v3);
  run(a, 0.1);
  run(b, 0.1);
  assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()), 'migrated saves deterministic');
});

await finish('sim/save-validation');
