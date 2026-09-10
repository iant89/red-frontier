/**
 * @suite sim/devtools
 * @group unit
 * @covers src/sim/Simulation.ts src/sim/World.ts src/sim/weather.ts src/dev/DevMode.ts src/sim/config.ts
 * @desc Developer-mode backdoors: fabricating rovers, buildings and deposits,
 * instant completion, upgrade levels, time travel and storm control — and the
 * hard contract that none of it ever reaches the save file.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { DevMode } from '../../src/dev/DevMode';
import { devLevelMul } from '../../src/sim/config';
import { ROVERS } from '../../src/sim/defs';
import type { BuildingKind } from '../../src/sim/defs';
import { run, findSpot } from '../fixtures/sim';
import { group, test, finish } from '../harness';

const silentDev = () => new DevMode(() => {});

/** Fab `kind` at the first legal spot on a widening ring, or throw. */
function devBuild(sim: Simulation, kind: BuildingKind, clearance = 22) {
  for (let r = 34; r <= 170; r += 3) {
    for (let a = 0; a < 360; a += 11) {
      const x = Math.cos((a * Math.PI) / 180) * r;
      const z = Math.sin((a * Math.PI) / 180) * r;
      // Keep later fabs apart from everything already standing.
      if (sim.buildings.some((b) => Math.hypot(b.x - x, b.z - z) < clearance)) continue;
      const b = sim.devSpawnBuilding(kind, x, z);
      if (b) return b;
    }
  }
  throw new Error(`no dev-fab site found for ${kind}`);
}

// ----------------------------------------------------- spawn: rovers ----

test('devSpawnRover fabricates an ordinary, fully-charged rover at the spot', () => {
  const sim = new Simulation({ seed: 11 });
  const before = sim.rovers.length;
  const r = sim.devSpawnRover('cargo', 40, -25);
  assert.equal(sim.rovers.length, before + 1);
  assert.equal(r.kind, 'cargo');
  assert.equal(r.battery, ROVERS.cargo.maxBatteryKWh, 'fab rover lands charged');
  assert.equal(Math.round(r.x), 40);
  assert.equal(Math.round(r.z), -25);
  // It is a real rover afterwards: the sim can command it.
  sim.step(1 / 20);
  sim.issueMove(r.id, 48, -25);
  const before2 = Math.hypot(r.x - 48, r.z + 25);
  run(sim, 0.05);
  const after2 = Math.hypot(r.x - 48, r.z + 25);
  assert.ok(after2 < before2, 'the fabricated rover should answer orders');
});

// -------------------------------------------------- spawn: buildings ----

test('devSpawnBuilding lands a complete, online, free structure', () => {
  const sim = new Simulation({ seed: 12 });
  const b = devBuild(sim, 'warehouse');
  assert.equal(b.kind, 'warehouse');
  assert.equal(b.state, 'online', 'it comes online immediately');
  assert.equal(b.progress, 1);
  // Free: nothing left storage, nothing owing on the site.
  assert.equal(b.remainingCost.regolith, 0);
  assert.equal(sim.storageTotal(), 0, 'no materials were consumed');
  // Capacities notice immediately (warehouse adds 600 kg per silo).
  assert.ok(sim.storageCapacity() > 260, 'storage grew by the warehouse amount');
});

test('devSpawnBuilding refuses an illegal spot and places nothing', () => {
  const sim = new Simulation({ seed: 12 });
  const b = sim.devSpawnBuilding('habitat', 0, 0); // the pod lives there
  assert.equal(b, null, 'on top of the pod is not a legal site');
  assert.equal(sim.buildings.length, 0);
});

// ----------------------------------------------------- spawn: deposits ----

test('devSpawnDeposit surveys in a mineable seam', () => {
  const sim = new Simulation({ seed: 13 });
  const count = sim.world.deposits.length;
  const d = sim.devSpawnDeposit('ice', 55, 55, 2000);
  assert.equal(sim.world.deposits.length, count + 1);
  assert.equal(d.resource, 'ice');
  assert.equal(d.amount, 2000);
  assert.equal(d.maxAmount, 2000);
  // It is the real thing: a rover ordered to it mines ice out of it.
  const rover = sim.devSpawnRover('mining', 52, 55);
  sim.issueMine(rover.id, d.id);
  run(sim, 0.4);
  const mine = sim.world.deposits.find((x) => x.id === d.id)!;
  assert.ok(mine.amount < 2000, 'the fabricated seam depletes as it is mined');
});

// ------------------------------------------------- instant completion ----

test('devCompleteBuilding finishes a site with no materials and releases the crew', () => {
  const sim = new Simulation({ seed: 14 });
  const spot = findSpot(sim, 'solar');
  const b = sim.placeBuilding('solar', spot.x, spot.z);
  assert.ok(b, 'a legal site should exist near spawn');
  assert.equal(b!.state, 'site');
  // Storage is empty, so ordinary construction cannot even start.
  assert.equal(sim.storageTotal(), 0);
  sim.step(1 / 20);
  const ok = sim.devCompleteBuilding(b!.id);
  assert.ok(ok, 'the dev hook should complete it');
  assert.equal(sim.buildingById(b!.id)!.state, 'online');
  run(sim, 0.02); // a tick to make sure it settles without throwing
});

// --------------------------------------------------------- upgrade --------

test('upgrade levels multiply generation, storage and capacity — and clamp', () => {
  const sim = new Simulation({ seed: 15 });
  const solar = devBuild(sim, 'solar');
  const ware = devBuild(sim, 'warehouse');

  // Read generation under a pinned environment — same sun anchor, same dust,
  // clean panels both times — so the level multiplier is measured exactly.
  const readGen = () => {
    sim.devSetTime(0, 0.5);
    sim.weather.dust = 0.1;
    solar.cleanliness = 1;
    run(sim, 0.01);
    return solar.genKw;
  };
  const baseGen = readGen();
  assert.ok(baseGen > 20, 'noon sun should be near peak');

  const landed = sim.devSetBuildingLevel(solar.id, 3);
  assert.equal(landed, 3);
  const expected = devLevelMul(3);
  const upGen = readGen();
  assert.ok(
    Math.abs(upGen / baseGen - expected) < 0.01,
    `gen should scale by ${expected}, got ${(upGen / baseGen).toFixed(3)}`,
  );

  // Storage capacity tracks too (600 kg/silo × mul).
  sim.devSetBuildingLevel(ware.id, 3);
  const cap = sim.storageCapacity();
  assert.ok(
    Math.abs(cap - (260 + 600 * expected)) < 1,
    `silo capacity ${cap} should be ~${260 + 600 * expected}`,
  );

  // Levels clamp at the documented ceiling and floor.
  assert.equal(sim.devSetBuildingLevel(solar.id, 99), 5);
  assert.equal(sim.devSetBuildingLevel(solar.id, 0), 1);
});

test('upgrade level never reaches the save file — snapshot or restore', () => {
  const sim = new Simulation({ seed: 16 });
  const b = devBuild(sim, 'solar');
  sim.devSetBuildingLevel(b.id, 4);

  const snap = sim.snapshot() as any;
  const json = JSON.stringify(snap);
  assert.ok(!/"level"/.test(json), 'no level field anywhere in the snapshot');

  const twin = new Simulation({ seed: 16 });
  twin.restore(snap);
  const restored = twin.buildingById(b.id)!;
  assert.equal(restored.level, 1, 'a loaded colony comes back at base level');
});

// --------------------------------------------------------------- time -----

test('devSetTime jumps the calendar and the sun answers to it', () => {
  const sim = new Simulation({ seed: 17 });
  const startSol = sim.clock.sol;
  const startTime = sim.simTime;

  sim.devSetTime(startSol + 5, 0.5); // +5 sols, local noon
  assert.equal(sim.clock.sol, startSol + 5);
  assert.ok(Math.abs(sim.clock.frac - 0.5) < 1e-6);
  assert.ok(sim.clock.sun.isDay, 'noon is day');
  assert.ok(sim.clock.sun.irradiance > 0.9, 'noon irradiance near peak');
  // simTime travelled with the calendar — weather and history stay anchored.
  assert.ok(sim.simTime > startTime + 4 * 240, 'simTime travelled with the calendar');

  sim.devSetTime(startSol + 5, 0.95); // deep night
  assert.ok(!sim.clock.sun.isDay, 'midnight is not day');
  assert.equal(sim.clock.sun.irradiance, 0);

  // The clock keeps ticking sensibly from the new anchor.
  const f0 = sim.clock.frac;
  run(sim, 20 / 240);
  assert.ok(sim.clock.frac > f0 || sim.clock.sol > startSol + 5, 'time advances after the jump');
});

// ------------------------------------------------------------ weather -----

test('storms can be conjured, dismissed, and the scheduler switched', () => {
  const sim = new Simulation({ seed: 18 });
  const dev = silentDev();

  dev.forceStorm(sim, 'severe');
  assert.ok(sim.weather.forecast(), 'the storm is on the forecast board');
  run(sim, 80 / 240); // past the 4 s lead, well up the ramp
  assert.equal(sim.weather.storm, 'severe', 'the conjured storm arrives');
  assert.ok(sim.weather.stormIntensity > 0.3, 'and it is blowing');

  dev.clearStorms(sim);
  assert.equal(sim.weather.storm, 'calm', 'clearing dismisses it outright');
  assert.ok(!sim.weather.forecast(), 'the board is empty');
  assert.ok(!sim.weather.current(), 'nothing active');

  dev.setStormScheduler(sim, false);
  assert.ok(sim.weather.rollsSuppressed, 'scheduler suspended');
  dev.setStormScheduler(sim, true);
  assert.ok(!sim.weather.rollsSuppressed, 'scheduler resumed');
});

// ------------------------------------------------------- DevMode rover ----

test('keep-battery-full pins the charge and revives a stranded rover', () => {
  const sim = new Simulation({ seed: 19 });
  const dev = silentDev();
  dev.enabled = true;
  const r = sim.rovers[0];

  dev.setKeepBatteryFull(sim, r.id, true);
  assert.equal(r.battery, ROVERS[r.kind].maxBatteryKWh, 'pinning tops up immediately');

  // Drain it by hand and apply a frame: the pin wins.
  r.battery = 3;
  dev.applyTo(sim);
  assert.equal(r.battery, ROVERS[r.kind].maxBatteryKWh);

  // A battery-flat rover is disabled; the pin stands it back up.
  r.battery = 0;
  r.phase = 'disabled';
  dev.applyTo(sim);
  assert.equal(r.phase, 'idle', 'the stranded rover is revived');
  assert.ok(r.recharge, 'and sent home to recover honestly');

  // Mode off: nothing applies any more.
  dev.disable();
  r.battery = 1;
  dev.applyTo(sim);
  assert.equal(r.battery, 1, 'a disabled mode touches nothing');
});

test('setCargo writes the chosen ore and clamps it into the hopper', () => {
  const sim = new Simulation({ seed: 20 });
  const dev = silentDev();
  const r = sim.devSpawnRover('utility', 30, 30); // 500 kg hopper

  const landed = dev.setCargo(sim, r.id, 'iron', 900);
  const rr = sim.roverById(r.id)!;
  assert.ok(landed <= 500, `900 kg cannot fit a utility hopper (landed ${landed})`);
  assert.equal(rr.cargo.iron, landed);
  assert.equal(rr.cargo.ice, 0, 'other slots are untouched');

  dev.clearCargo(sim, r.id);
  assert.equal(rr.cargo.iron, 0, 'the bay empties');
});

test('DevMode edits respect damage thresholds and sim invariants', () => {
  const sim = new Simulation({ seed: 21 });
  const dev = silentDev();
  const b = devBuild(sim, 'solar');

  // Dropping health below the damage line trips the structure offline.
  dev.setHealth(sim, b.id, 10);
  assert.ok(b.damaged, 'below DAMAGED_HEALTH means damaged');
  // Restoring above the restart line fixes it honestly.
  dev.setHealth(sim, b.id, 80);
  assert.ok(!b.damaged, 'repaired above the restart threshold');
  assert.equal(b.health, 80);

  dev.setCleanliness(sim, b.id, 0.25);
  assert.ok(Math.abs(b.cleanliness - 0.25) < 1e-9);

  dev.setBatteryFrac(sim, sim.rovers[0].id, 0.5);
  assert.ok(
    Math.abs(sim.rovers[0].battery - ROVERS[sim.rovers[0].kind].maxBatteryKWh / 2) < 1e-6,
  );

  dev.setCondition(sim, sim.rovers[0].id, 12);
  assert.equal(sim.rovers[0].condition, 12);
});

await finish('sim/devtools');
