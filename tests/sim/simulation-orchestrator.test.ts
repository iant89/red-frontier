/**
 * @suite sim/simulation-orchestrator
 * @group unit
 * @covers src/sim/Simulation.ts src/sim/systems/GarageSystem.ts src/sim/persistence/ColonyPersistence.ts src/sim/DevBackdoors.ts src/sim/systems/HistorySystem.ts
 * @desc Phase 18 — Simulation is a thin orchestrator: tick order pinned,
 * garage bay + snapshot/restore + rate arithmetic live outside Simulation,
 * public host surface still delegates.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../../src/sim/Simulation';
import { GarageSystem } from '../../src/sim/systems/GarageSystem';
import { HistorySystem } from '../../src/sim/systems/HistorySystem';
import { snapshotColony, restoreColony } from '../../src/sim/persistence/ColonyPersistence';
import { SIM_TICK } from '../../src/sim/config';
import { group, test, finish } from '../harness';

const simSrc = readFileSync(
  fileURLToPath(new URL('../../src/sim/Simulation.ts', import.meta.url)),
  'utf8',
);

group('Phase 18 — garage bay has one owner');

test('GarageSystem owns assemble + tick; Simulation delegates', () => {
  const garageSrc = readFileSync(
    fileURLToPath(new URL('../../src/sim/systems/GarageSystem.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(garageSrc.includes('static assemble'));
  assert.ok(garageSrc.includes('static tick'));
  assert.ok(!simSrc.includes('private tickGarages'));
  assert.ok(simSrc.includes('GarageSystem.tick(this.state)'));
  assert.ok(simSrc.includes('GarageSystem.assemble(this.state'));
});

group('Phase 18 — persistence bodies live outside Simulation');

test('ColonyPersistence owns snapshot/restore; Simulation thin-delegates', () => {
  const persSrc = readFileSync(
    fileURLToPath(new URL('../../src/sim/persistence/ColonyPersistence.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(persSrc.includes('export function snapshotColony'));
  assert.ok(persSrc.includes('export function restoreColony'));
  assert.ok(!simSrc.includes('private restoreFromState'));
  assert.ok(simSrc.includes('snapshotColony(this.state)'));
  assert.ok(simSrc.includes('restoreColony(this.state'));
});

test('round-trip snapshotColony / restoreColony matches Simulation.snapshot/restore', () => {
  const a = new Simulation({ seed: 18, nearDeposits: 0.2 });
  a.step(SIM_TICK * 40);
  const viaSim = a.snapshot();
  const viaMod = snapshotColony(a.state);
  assert.deepEqual(viaMod.seed, viaSim.seed);
  assert.deepEqual(viaMod.simTime, viaSim.simTime);
  assert.deepEqual(viaMod.rovers.length, viaSim.rovers.length);

  const b = new Simulation({ seed: 99, nearDeposits: 0.2 });
  restoreColony(b.state, viaSim);
  assert.equal(b.seed, a.seed);
  assert.equal(b.simTime, a.simTime);
  assert.equal(b.rovers.length, a.rovers.length);
});

group('Phase 18 — rate arithmetic lives in HistorySystem');

test('HistorySystem owns net/instant/reserve; Simulation delegates', () => {
  const histSrc = readFileSync(
    fileURLToPath(new URL('../../src/sim/systems/HistorySystem.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(histSrc.includes('static netRatePerSol'));
  assert.ok(histSrc.includes('static instantRatePerSol'));
  assert.ok(histSrc.includes('static reserveSols'));
  assert.ok(simSrc.includes('HistorySystem.netRatePerSol(this.state'));
  assert.ok(simSrc.includes('HistorySystem.reserveSols(this.state'));
});

test('public rate queries still answer on Simulation', () => {
  const sim = new Simulation({ seed: 7, nearDeposits: 0.2 });
  sim.step(SIM_TICK * 20);
  assert.equal(typeof sim.netRatePerSol('oxygen'), 'number');
  assert.equal(typeof sim.instantRatePerSol('water'), 'number');
  assert.equal(typeof sim.reserveSols('food'), 'number');
  assert.equal(sim.netRatePerSol('oxygen'), HistorySystem.netRatePerSol(sim.state, 'oxygen'));
});

group('Phase 18 — authoritative tick order preserved');

test('Simulation.tick calls systems in the Phase 17 order', () => {
  // Strip comments so doc examples cannot fake the order.
  const code = simSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const tickMatch = code.match(/private tick\(\): void \{([\s\S]*?)\n  \}/);
  assert.ok(tickMatch, 'private tick() body present');
  const body = tickMatch![1];
  const markers = [
    'ClockSystem.tick',
    'WeatherSystem.tick',
    'ExplorationSystem.tick',
    'PowerSystem.tick',
    'GarageSystem.tick',
    'LifeSupportSystem.tick',
    'ConstructionSystem.tickSiteMaterials',
    'ConstructionSystem.assignBuilders',
    'FleetAutomationSystem.tick',
    'RoverSystem.tickLights',
    'RoverSystem.updateRover',
    'RoverSystem.moveRover',
    'LifeSupportSystem.tickColonist',
    'evaluateAlerts',
    'HistorySystem.tick',
  ];
  let last = -1;
  for (const m of markers) {
    const idx = body.indexOf(m);
    assert.ok(idx >= 0, `tick body must call ${m}`);
    assert.ok(idx > last, `${m} must follow prior marker (order preserved)`);
    last = idx;
  }
});

test('GarageSystem has no presentation imports', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/sim/systems/GarageSystem.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(!/[^\w]document\./.test(src));
  assert.ok(!src.includes("from 'three'") && !src.includes('from "three"'));
  assert.ok(!src.includes("from '../Simulation'") && !src.includes('from "../Simulation"'));
});

test('SIM_TICK constant still drives the main loop (sanity)', () => {
  assert.ok(SIM_TICK > 0);
  assert.equal(typeof GarageSystem.tick, 'function');
});

finish();
