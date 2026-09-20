/**
 * @suite sim/tutorial
 * @group unit
 * @covers src/sim/systems/TutorialSystem.ts src/sim/state/TutorialState.ts src/sim/persistence/ColonyPersistence.ts
 * @desc Phase 1 First 30 Minutes — tutorial milestones, warnings, persistence, transient clearing.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { TutorialSystem } from '../../src/sim/systems/TutorialSystem';
import { emptyTutorialState } from '../../src/sim/state/TutorialState';
import { snapshotColony, restoreColony } from '../../src/sim/persistence/ColonyPersistence';
import { createColonyState } from '../../src/sim/state/ColonyState';
import { group, test, finish } from '../harness';

group('TutorialState defaults');

test('emptyTutorialState has all milestones incomplete and bounded structures', () => {
  const s = emptyTutorialState();
  for (const k of Object.keys(s.milestones) as (keyof typeof s.milestones)[]) {
    assert.equal(s.milestones[k].completed, false, `${k} should start incomplete`);
  }
  for (const k of Object.keys(s.warnings) as (keyof typeof s.warnings)[]) {
    assert.equal(s.warnings[k].active, false, `${k} should start inactive`);
  }
  assert.equal(s.funnel.length, 0);
  assert.deepEqual(s.stats, { moves: 0, mines: 0, hauls: 0, builds: 0, automations: 0, stormsSurvived: 0 });
  // transient fields are undefined on fresh empty
  assert.equal((s as any)._activeWarnings, undefined);
  assert.equal((s as any)._nextHint, undefined);
});

group('TutorialSystem milestone detection');

test('first-move completes when rover has moved', () => {
  const sim = new Simulation({ seed: 42 });
  // Move rover far from origin
  sim.rovers[0].x = 100;
  sim.rovers[0].z = 100;
  // Run a few ticks to let tutorial tick
  for (let i = 0; i < 5; i++) sim.step(1 / 20);
  assert.equal(sim.state.tutorial.milestones['first-move'].completed, true, 'first-move should complete after rover moved');
});

test('first-build completes when building exists', () => {
  const sim = new Simulation({ seed: 42 });
  sim.state.tutorial.milestones['first-move'].completed = true; // bypass
  sim.placeBuilding('warehouse', 40, 0);
  for (let i = 0; i < 10; i++) sim.step(1 / 20);
  assert.equal(sim.state.tutorial.milestones['first-build'].completed, true, 'first-build should complete after building placed');
});

test('tutorial stats increment via explicit hooks', () => {
  const sim = new Simulation({ seed: 42 });
  const before = sim.state.tutorial.stats.moves;
  TutorialSystem.onRoverMove(sim.state);
  assert.equal(sim.state.tutorial.stats.moves, before + 1);
  TutorialSystem.onMine(sim.state);
  assert.equal(sim.state.tutorial.stats.mines, 1);
  TutorialSystem.onHaul(sim.state);
  assert.equal(sim.state.tutorial.stats.hauls, 1);
  TutorialSystem.onBuild(sim.state);
  assert.equal(sim.state.tutorial.stats.builds, 1);
  TutorialSystem.onAutomation(sim.state);
  assert.equal(sim.state.tutorial.stats.automations, 1);
  TutorialSystem.onStormSurvived(sim.state);
  assert.equal(sim.state.tutorial.stats.stormsSurvived, 1);
});

group('TutorialSystem warnings');

test('water-critical warning triggers when reserve <1 sol', () => {
  const sim = new Simulation({ seed: 42 });
  // Force low water and high consumption
  sim.state.pools.amounts.water = 1; // very low
  // Set rates to depleting fast via forecast ctx
  // Tutorial tick uses reserveSols from LifeSupportSystem; we can fake by directly calling TutorialSystem.tick with custom ctx
  const ctx = {
    reserveSols: (f: 'water' | 'oxygen' | 'food') => (f === 'water' ? 0.5 : Infinity),
    netRatePerSol: () => -10,
    instantRatePerSol: () => -10,
  };
  TutorialSystem.tick(sim.state, ctx);
  assert.ok(sim.state.tutorial.warnings['water-critical'].active, 'water-critical should be active');
  assert.ok((sim.state.tutorial._activeWarnings ?? []).includes('water-critical'), '_activeWarnings should include water-critical');
});

test('warning cooldown prevents spam but active stays', () => {
  const sim = new Simulation({ seed: 42 });
  const ctx = {
    reserveSols: () => 0.5 as number,
    netRatePerSol: () => -10,
    instantRatePerSol: () => -10,
  };
  // First trigger
  TutorialSystem.tick(sim.state, ctx);
  const count1 = sim.state.tutorial.warnings['water-critical'].count;
  // Immediate second tick should not increment due to cooldown
  TutorialSystem.tick(sim.state, ctx);
  const count2 = sim.state.tutorial.warnings['water-critical'].count;
  assert.equal(count1, count2, 'cooldown should prevent second increment');
  assert.equal(sim.state.tutorial.warnings['water-critical'].active, true);
});

test('clearWarning and afterTimeJump reset transient', () => {
  const sim = new Simulation({ seed: 42 });
  const ctx = {
    reserveSols: () => 0.5 as number,
    netRatePerSol: () => -10,
    instantRatePerSol: () => -10,
  };
  TutorialSystem.tick(sim.state, ctx);
  assert.ok((sim.state.tutorial._activeWarnings ?? []).length > 0);
  TutorialSystem.afterTimeJump(sim.state);
  assert.equal((sim.state.tutorial._activeWarnings ?? []).length, 0, 'afterTimeJump should clear _activeWarnings');
  assert.equal(sim.state.tutorial._nextHint, null);
  // Warnings lastSeenTick reset to -1e12
  for (const id of Object.keys(sim.state.tutorial.warnings) as (keyof typeof sim.state.tutorial.warnings)[]) {
    assert.ok(sim.state.tutorial.warnings[id].lastSeenTick < 0, 'lastSeenTick should be reset');
  }
});

group('Tutorial persistence and migration');

test('snapshot includes tutorial milestones and restore preserves them', () => {
  const sim = new Simulation({ seed: 42 });
  sim.rovers[0].x = 100;
  for (let i = 0; i < 5; i++) sim.step(1 / 20);
  assert.equal(sim.state.tutorial.milestones['first-move'].completed, true);

  const snap = snapshotColony(sim.state);
  assert.ok(snap.tutorial, 'snapshot should have tutorial');
  assert.equal(snap.tutorial.milestones['first-move'].completed, true);

  const fresh = createColonyState({ seed: 1 });
  // Need to give fresh a world and rovers for restore to not crash? restoreColony recreates world from seed
  restoreColony(fresh, snap as any);
  assert.equal(fresh.tutorial.milestones['first-move'].completed, true, 'restored milestone should remain completed');
  assert.equal(fresh.tutorial.stats.moves, sim.state.tutorial.stats.moves);
});

test('restore from old save without tutorial field creates empty tutorial', () => {
  const sim = new Simulation({ seed: 42 });
  const snap = snapshotColony(sim.state);
  const oldSnap = { ...snap } as any;
  delete oldSnap.tutorial;
  const fresh = createColonyState({ seed: 1 });
  restoreColony(fresh, oldSnap);
  // Should not crash, should have empty tutorial
  assert.ok(fresh.tutorial, 'should have tutorial even when old save missing it');
  assert.equal(fresh.tutorial.milestones['first-move'].completed, false);
});

test('funnel bounded to 200 entries', () => {
  const sim = new Simulation({ seed: 42 });
  // Push many funnel events via milestones
  for (let i = 0; i < 250; i++) {
    (sim.state.tutorial.funnel as any).push({ id: `test-${i}`, type: 'milestone', sol: 0, tick: i, at: 0 });
  }
  // Manually enforce bound via tick? pushFunnel bounds on push, but direct push bypasses.
  // Now trigger a milestone that will call pushFunnel which will shift
  // Actually we test pushFunnel directly via completing milestones repeatedly? We'll just check snapshot trimming.
  const snap = snapshotColony(sim.state);
  // snapshot copies funnel as is (up to 250), but restore should trim to 200
  const fresh = createColonyState({ seed: 1 });
  restoreColony(fresh, snap as any);
  assert.ok(fresh.tutorial.funnel.length <= 200, `funnel should be trimmed to <=200, got ${fresh.tutorial.funnel.length}`);
});

group('Tutorial dismiss');

test('dismissHint persists via dismissedHints and snapshot', () => {
  const sim = new Simulation({ seed: 42 });
  TutorialSystem.dismissHint(sim.state, 'welcome');
  assert.equal(sim.state.tutorial.dismissedHints['welcome'], true);
  const snap = snapshotColony(sim.state);
  assert.equal(snap.tutorial!.dismissedHints['welcome'], true);
  const fresh = createColonyState({ seed: 1 });
  restoreColony(fresh, snap as any);
  assert.equal(fresh.tutorial.dismissedHints['welcome'], true);
});

test('nextHint respects dismissedHints', () => {
  const sim = new Simulation({ seed: 42 });
  const ctx = {
    reserveSols: () => Infinity,
    netRatePerSol: () => 0,
    instantRatePerSol: () => 0,
  };
  // Initially, nextHint should be welcome
  TutorialSystem.tick(sim.state, ctx);
  assert.equal(sim.state.tutorial._nextHint, 'welcome');
  // Dismiss welcome
  TutorialSystem.dismissHint(sim.state, 'welcome');
  TutorialSystem.tick(sim.state, ctx);
  // Now nextHint should be move-rover (since first-move not completed)
  assert.equal(sim.state.tutorial._nextHint, 'move-rover');
});

await finish('sim/tutorial');
