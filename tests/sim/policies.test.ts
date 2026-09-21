/**
 * @suite sim/policies
 * @group unit
 * @covers src/sim/systems/PolicySystem.ts src/sim/state/PolicyState.ts src/sim/persistence/policySave.ts src/sim/persistence/migrations/v16.ts src/sim/host/protocol.ts src/sim/host/applyCommand.ts
 * @desc Phase 3 (slice 2): colony standing orders. Policies act through the
 * same paths a player's order takes, their work is marked as self-directed,
 * setting one never ends the autonomy window, the panel is gated on the
 * advancedAutomation unlock, and the block survives a save and a v16 migration.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import {
  PolicySystem,
  POLICY_UNLOCK,
  buildingWear,
  policySnapshot,
  sheddable,
  tickNightPower,
} from '../../src/sim/systems/PolicySystem';
import { anyPolicyOn, emptyPolicyState, POLICY_IDS } from '../../src/sim/state/PolicyState';
import { classifyCommand, currentStreak } from '../../src/sim/systems/AutonomySystem';
import { applyCommand, decodeCommand } from '../../src/sim/host';
import { grantUnlock } from '../../src/sim/unlocks';
import { sanitisePolicies } from '../../src/sim/persistence/policySave';
import { migrateV16Save } from '../../src/sim/persistence/migrations/v16';
import { snapshotColony, restoreColony } from '../../src/sim/persistence/ColonyPersistence';
import { createColonyState } from '../../src/sim/state/ColonyState';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { CURRENT_SAVE_VERSION } from '../../src/sim/persistence/SaveSchema';
import { SIM_TICK } from '../../src/sim/config';
import { group, test, finish } from '../harness';
import { buildOnline, run } from '../fixtures/sim';

function tick(sim: Simulation, n = 1): void {
  for (let i = 0; i < n; i++) sim.step(SIM_TICK);
}

/** A colony that has earned colony-level automation. */
function unlocked(seed: number): Simulation {
  const sim = new Simulation({ seed });
  grantUnlock(sim.state.unlocks, 'advancedAutomation', 'test', sim.clock.sol, sim.state.ticksRun);
  return sim;
}

// ------------------------------------------------------------- protocol ----

group('Protocol: policy/* commands (review §5 P3 (a))');

test('every policy command decodes, is a player command, and is classified as policy', () => {
  const cmds = [
    { type: 'policy/stockpile', on: true, resource: 'ice', minKg: 300 },
    { type: 'policy/nightPower', on: true, minBatteryPct: 40 },
    { type: 'policy/stormShelter', on: true },
    { type: 'policy/autoMaintain', on: true, maxWearPct: 30 },
  ];
  for (const c of cmds) {
    const d = decodeCommand(c);
    assert.ok(d.ok, `${c.type} decodes`);
    assert.equal(classifyCommand(c.type), 'policy', `${c.type} never ends the window`);
  }
  assert.equal(decodeCommand({ type: 'policy/stockpile', on: true, resource: 'gold', minKg: 1 }).ok, false, 'an unknown resource is malformed');
  assert.equal(decodeCommand({ type: 'policy/nightPower', on: true, minBatteryPct: 140 }).ok, false, 'a percentage is 0..100');
  assert.equal(decodeCommand({ type: 'policy/stormShelter' }).ok, false, 'the toggle is required');
});

test('policies are gated on the advancedAutomation unlock; a refusal is an ack, not a change', () => {
  assert.equal(POLICY_UNLOCK, 'advancedAutomation');
  const sim = new Simulation({ seed: 1 });
  const ack = applyCommand(sim, { type: 'policy/stormShelter', on: true });
  assert.equal(ack.ok, false);
  assert.equal(sim.state.policies.stormShelter.on, false);
  assert.equal(sim.policies.unlocked, false);
  assert.ok(sim.alerts.history().some((e) => /Standing orders need/.test(e.text)));

  grantUnlock(sim.state.unlocks, 'advancedAutomation', 'test', sim.clock.sol, sim.state.ticksRun);
  assert.equal(applyCommand(sim, { type: 'policy/stormShelter', on: true }).ok, true);
  assert.equal(sim.state.policies.stormShelter.on, true);
  assert.equal(sim.policies.unlocked, true);
});

test('setting a policy clamps its numbers and never ends the autonomy window', () => {
  const sim = unlocked(2);
  run(sim, 1);
  const before = currentStreak(sim.state);
  assert.ok(before >= 0.9);
  applyCommand(sim, { type: 'policy/stockpile', on: true, resource: 'iron', minKg: 99999 });
  applyCommand(sim, { type: 'policy/nightPower', on: true, minBatteryPct: 100 });
  applyCommand(sim, { type: 'policy/autoMaintain', on: true, maxWearPct: 0 });
  assert.equal(sim.state.policies.stockpile.minKg, 5000, 'floor is clamped to the slider range');
  assert.equal(sim.state.policies.stockpile.resource, 'iron');
  assert.ok(currentStreak(sim.state) >= before, 'four policies set, no break');
  assert.equal(sim.state.autonomy.lastBreak, null);
  assert.ok(anyPolicyOn(sim.state.policies));
  assert.equal(PolicySystem.set(sim.state, 'stockpile', { resource: 'unobtainium' }), false, 'nonsense is refused');
});

// ------------------------------------------------------------ stockpile ----

group('Stockpile: keep <resource> above N kg');

test('an idle hauler is sent to the best seam while storage is short, marked as self-directed', () => {
  const sim = unlocked(3);
  run(sim, 0.1);
  const iron0 = sim.storage.iron;
  applyCommand(sim, { type: 'policy/stockpile', on: true, resource: 'iron', minKg: iron0 + 300 });
  tick(sim, 3);
  const miners = sim.rovers.filter((r) => r.command.type === 'mine');
  assert.ok(miners.length >= 1, 'a rover is on a mine run');
  for (const r of miners) {
    assert.equal(r.autoTask, true, 'policy work counts as self-directed (coverage)');
    const dep = sim.world.deposits.find((d) => d.id === (r.command as { depositId: number }).depositId)!;
    assert.equal(dep.resource, 'iron', 'and it is the resource the policy names');
  }
  assert.ok(sim.state.policies.actions >= 1);
  assert.ok(sim.alerts.history().some((e) => /Stockpile policy: .* sent for iron ore/.test(e.text)));
  assert.equal(sim.state.autonomy.lastBreak, null, 'the window survives the dispatch');
});

test('a satisfied floor sends nobody; a rover with autoHaul off is left alone', () => {
  const sim = unlocked(4);
  run(sim, 0.1);
  applyCommand(sim, { type: 'policy/stockpile', on: true, resource: 'iron', minKg: 0 });
  const busy = () => sim.rovers.filter((r) => r.command.type === 'mine' && r.autoTask).length;
  tick(sim, 2);
  assert.equal(busy(), 0, 'nothing to stock');

  for (const r of sim.rovers) applyCommand(sim, { type: 'rover/rule', roverId: r.id, rule: 'autoHaul', on: false });
  applyCommand(sim, { type: 'policy/stockpile', on: true, resource: 'iron', minKg: 2000 });
  tick(sim, 3);
  assert.equal(busy(), 0, 'the per-rover rule still wins');
});

// ---------------------------------------------------------- night power ----

group('Night power: shed industry after dark below N % battery');

test('after dark under the floor, industry is switched off and life support is not; morning gives it back', () => {
  const sim = unlocked(5);
  buildOnline(sim, 'refinery');
  const refinery = sim.buildings.find((b) => b.kind === 'refinery')!;
  const lifeSupport = sim.buildings.filter((b) => b.kind === 'extractor' || b.kind === 'oxygenator');
  assert.ok(sheddable(sim.state).some((b) => b.id === refinery.id));
  assert.ok(!sheddable(sim.state).some((b) => b.kind === 'habitat'), 'the pod is never on the list');

  applyCommand(sim, { type: 'policy/nightPower', on: true, minBatteryPct: 100 });
  applyCommand(sim, { type: 'dev/time', sol: sim.clock.sol, frac: 0.5 } as any);
  tick(sim, 2);
  assert.equal(refinery.enabled, true, 'daylight: nothing shed however low the pack');

  applyCommand(sim, { type: 'dev/time', sol: sim.clock.sol, frac: 0.9 } as any);
  tick(sim, 2);
  assert.equal(refinery.enabled, false, 'night + under the floor: shed');
  assert.deepEqual(sim.state.policies.held, [refinery.id]);
  for (const b of lifeSupport) assert.equal(b.enabled, true);
  assert.equal(sim.policies.nightPower.shedding, 1);
  assert.equal(sim.state.autonomy.lastBreak, null, 'a policy toggle is not an intervention');

  applyCommand(sim, { type: 'dev/time', sol: sim.clock.sol + 1, frac: 0.5 } as any);
  tick(sim, 2);
  assert.equal(refinery.enabled, true, 'sunrise: restored');
  assert.deepEqual(sim.state.policies.held, []);
  assert.ok(sim.alerts.history().some((e) => /Night power policy: 1 building back on \(sunrise\)/.test(e.text)));
});

test('the policy only ever gives back what it took, and switching it off returns it now', () => {
  const sim = unlocked(6);
  buildOnline(sim, 'refinery');
  buildOnline(sim, 'workshop');
  const refinery = sim.buildings.find((b) => b.kind === 'refinery')!;
  const workshop = sim.buildings.find((b) => b.kind === 'workshop')!;
  // The player switched the workshop off by hand before nightfall.
  applyCommand(sim, { type: 'building/toggle', buildingId: workshop.id, enabled: false });
  applyCommand(sim, { type: 'policy/nightPower', on: true, minBatteryPct: 100 });
  applyCommand(sim, { type: 'dev/time', sol: sim.clock.sol, frac: 0.9 } as any);
  tick(sim, 2);
  assert.equal(refinery.enabled, false);
  assert.deepEqual(sim.state.policies.held, [refinery.id], 'the hand-switched workshop was never taken');

  applyCommand(sim, { type: 'policy/nightPower', on: false, minBatteryPct: 100 });
  assert.equal(refinery.enabled, true, 'off → restored immediately');
  assert.equal(workshop.enabled, false, 'the player\'s own switch is left where they put it');
  assert.deepEqual(sim.state.policies.held, []);
});

test('hysteresis: restored only once the battery is comfortably above the floor', () => {
  const sim = unlocked(7);
  buildOnline(sim, 'refinery');
  const refinery = sim.buildings.find((b) => b.kind === 'refinery')!;
  sim.state.policies.nightPower = { on: true, minBatteryPct: 50 };
  applyCommand(sim, { type: 'dev/time', sol: sim.clock.sol, frac: 0.9 } as any);
  const cap = sim.state.storedKWh / 0.6; // pod pack is three-fifths full at start
  sim.state.storedKWh = cap * 0.45;
  tickNightPower(sim.state);
  assert.equal(refinery.enabled, false);
  sim.state.storedKWh = cap * 0.55;
  tickNightPower(sim.state);
  assert.equal(refinery.enabled, false, '55 % is above the floor but inside the band');
  sim.state.storedKWh = cap * 0.61;
  tickNightPower(sim.state);
  assert.equal(refinery.enabled, true, '61 % clears floor + 10');
});

// -------------------------------------------------------- storm shelter ----

group('Storm shelter: recall the fleet when a storm is forecast');

test('a real storm on the board re-arms every rover\'s shelter rule and brings idle rovers in', () => {
  const sim = unlocked(8);
  run(sim, 0.1);
  for (const r of sim.rovers) applyCommand(sim, { type: 'rover/rule', roverId: r.id, rule: 'stormShelter', on: false });
  applyCommand(sim, { type: 'policy/stormShelter', on: true });
  tick(sim, 2);
  assert.ok(sim.rovers.every((r) => !r.rules.stormShelter), 'clear skies: the daredevil setting stands');

  applyCommand(sim, { type: 'dev/storm/force', kind: 'regional' } as any);
  tick(sim, 2);
  assert.ok(sim.rovers.every((r) => r.rules.stormShelter), 'forecast: the rule is enforced fleet-wide');
  assert.ok(sim.alerts.history().some((e) => /Storm shelter policy: .* shelter rule re-armed/.test(e.text)));
});

test('a dust devil is not a storm the policy recalls for', () => {
  const sim = unlocked(9);
  for (const r of sim.rovers) applyCommand(sim, { type: 'rover/rule', roverId: r.id, rule: 'stormShelter', on: false });
  applyCommand(sim, { type: 'policy/stormShelter', on: true });
  applyCommand(sim, { type: 'dev/storm/force', kind: 'devil' } as any);
  tick(sim, 2);
  assert.ok(sim.rovers.every((r) => !r.rules.stormShelter));
});

// -------------------------------------------------------- auto-maintain ----

group('Auto-maintain: dispatch when wear > N %');

test('wear is the worse of damage and dust', () => {
  const sim = unlocked(10);
  const solar = buildOnline(sim, 'solar');
  const oxy = buildOnline(sim, 'oxygenator');
  assert.equal(buildingWear(solar), 0);
  solar.cleanliness = 0.4;
  assert.ok(Math.abs(buildingWear(solar) - 0.6) < 1e-9);
  solar.health = 30;
  assert.ok(Math.abs(buildingWear(solar) - 0.7) < 1e-9);
  oxy.cleanliness = 0; // an oxygenator has no panels: dust is not wear for it
  assert.equal(buildingWear(oxy), 0);
});

test('a building past the threshold gets the nearest idle rover, worst first, marked self-directed', () => {
  const sim = unlocked(11);
  const solar = buildOnline(sim, 'solar');
  applyCommand(sim, { type: 'policy/autoMaintain', on: true, maxWearPct: 25 });
  applyCommand(sim, { type: 'dev/building/cleanliness', buildingId: solar.id, frac: 0.9 } as any);
  tick(sim, 2);
  assert.ok(!sim.rovers.some((r) => r.command.type === 'clean'), '10 % dust is under the threshold');

  applyCommand(sim, { type: 'dev/building/cleanliness', buildingId: solar.id, frac: 0.5 } as any);
  tick(sim, 2);
  const cleaner = sim.rovers.find((r) => r.command.type === 'clean');
  assert.ok(cleaner, 'someone is on it');
  assert.equal((cleaner!.command as { buildingId: number }).buildingId, solar.id);
  assert.equal(cleaner!.autoTask, true, 'policy work is self-directed');
  assert.ok(sim.alerts.history().some((e) => /Maintenance policy: .* dispatched to clean the Solar Array \(wear 50 %\)/.test(e.text)));
  assert.equal(sim.state.autonomy.lastBreak, null);

  tick(sim, 2);
  assert.equal(sim.rovers.filter((r) => r.command.type === 'clean').length, 1, 'one job, one rover — no double dispatch');
});

test('storm-damaged buildings are repaired before dusty ones, and nobody is sent out mid-storm', () => {
  const sim = unlocked(12);
  const solar = buildOnline(sim, 'solar');
  const oxy = buildOnline(sim, 'oxygenator');
  applyCommand(sim, { type: 'policy/autoMaintain', on: true, maxWearPct: 20 });
  applyCommand(sim, { type: 'dev/building/cleanliness', buildingId: solar.id, frac: 0.6 } as any);
  applyCommand(sim, { type: 'dev/building/health', buildingId: oxy.id, pct: 40 } as any);
  // Keep one rover so the order of dispatch is observable.
  const spare = sim.rovers[1];
  applyCommand(sim, { type: 'rover/wait', roverId: spare.id, seconds: 600, queue: false });
  tick(sim, 2);
  const worker = sim.rovers[0];
  assert.equal(worker.command.type, 'repair', 'the 60 % damaged oxygenator outranks the 40 % dusty array');
  assert.equal((worker.command as { buildingId: number }).buildingId, oxy.id);

  const sim2 = unlocked(13);
  const solar2 = buildOnline(sim2, 'solar');
  applyCommand(sim2, { type: 'policy/autoMaintain', on: true, maxWearPct: 20 });
  applyCommand(sim2, { type: 'dev/storm/force', kind: 'severe' } as any);
  run(sim2, 0.3); // let the front arrive
  assert.ok(sim2.weather.shelterRovers(), 'the storm is on us');
  applyCommand(sim2, { type: 'dev/building/cleanliness', buildingId: solar2.id, frac: 0.3 } as any);
  tick(sim2, 3);
  assert.ok(!sim2.rovers.some((r) => r.command.type === 'clean'), 'no dispatch into a storm');
});

// ---------------------------------------------------------- persistence ----

group('Persistence: v17 block, v16 migration, hostile block');

test('the policies block round-trips through a save, held ids included', () => {
  assert.equal(CURRENT_SAVE_VERSION, 18);
  const sim = unlocked(14);
  buildOnline(sim, 'refinery');
  applyCommand(sim, { type: 'policy/stockpile', on: true, resource: 'silicon', minKg: 450 });
  applyCommand(sim, { type: 'policy/nightPower', on: true, minBatteryPct: 100 });
  applyCommand(sim, { type: 'policy/autoMaintain', on: true, maxWearPct: 35 });
  applyCommand(sim, { type: 'dev/time', sol: sim.clock.sol, frac: 0.9 } as any);
  tick(sim, 2);
  assert.equal(sim.state.policies.held.length, 1);
  const saved = snapshotColony(sim.state);
  const copy = createColonyState({ seed: 14 });
  restoreColony(copy, JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(copy.policies, sim.state.policies);
});

test('a v16 save migrates with every policy off and a ghost held id dropped', () => {
  const sim = unlocked(15);
  buildOnline(sim, 'solar');
  run(sim, 0.5);
  const v16 = JSON.parse(JSON.stringify(snapshotColony(sim.state)));
  v16.version = 16;
  delete v16.policies;
  const migrated = migrateV16Save(v16) as { version: number; policies: ReturnType<typeof emptyPolicyState> };
  assert.equal(migrated.version, 17);
  assert.deepEqual(migrated.policies, emptyPolicyState());

  v16.policies = { nightPower: { on: true, minBatteryPct: 500 }, held: [99999, sim.buildings[0].id, sim.buildings[0].id], actions: -4 };
  const m2 = migrateV16Save(v16) as { policies: ReturnType<typeof emptyPolicyState> };
  assert.equal(m2.policies.nightPower.minBatteryPct, 100);
  assert.deepEqual(m2.policies.held, [sim.buildings[0].id], 'unknown and duplicate ids dropped');
  assert.equal(m2.policies.actions, 0);
});

test('a hostile policies block is clamped, not trusted', () => {
  const out = sanitisePolicies(
    { stockpile: { on: 'yes', resource: 'gold', minKg: -50 }, autoMaintain: 7, held: 'all', actions: 'lots', stormShelter: { on: true } },
    new Set([1]),
  );
  assert.equal(out.stockpile.on, false);
  assert.equal(out.stockpile.resource, 'ice');
  assert.equal(out.stockpile.minKg, 0);
  assert.equal(out.autoMaintain.on, false);
  assert.equal(out.stormShelter.on, true);
  assert.deepEqual(out.held, []);
  assert.equal(out.actions, 0);
  assert.deepEqual(sanitisePolicies('nope', new Set()), emptyPolicyState());
});

// ---------------------------------------------------------- determinism ----

group('Determinism and the read model');

test('two colonies run to the same policies hash the same; different policies diverge', () => {
  const make = (minKg: number) => {
    const sim = unlocked(16);
    applyCommand(sim, { type: 'policy/stockpile', on: true, resource: 'iron', minKg });
    applyCommand(sim, { type: 'policy/autoMaintain', on: true, maxWearPct: 30 });
    run(sim, 0.5);
    return hashSimulation(sim);
  };
  assert.equal(make(400), make(400));
  assert.notEqual(make(400), make(0), 'the policy is in the hash and it moved the fleet');
});

test('the snapshot states every policy in one line and what it is holding', () => {
  const sim = unlocked(17);
  applyCommand(sim, { type: 'policy/stockpile', on: true, resource: 'ice', minKg: 300 });
  const snap = policySnapshot(sim.state);
  for (const id of POLICY_IDS) assert.ok(snap.lines[id].startsWith('Policy: '), id);
  assert.equal(snap.lines.stockpile, 'Policy: keep water ice above 300 kg.');
  assert.equal(snap.lines.nightPower, 'Policy: night power — off.');
  assert.equal(snap.stockpile.currentKg, sim.storage.ice);
  assert.equal(typeof snap.autoMaintain.worstWearPct, 'number');
  const view = JSON.parse(JSON.stringify(sim.policies));
  assert.deepEqual(view, JSON.parse(JSON.stringify(snap)), 'the getter is the snapshot');
});

await finish('sim/policies');
