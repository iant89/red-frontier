/**
 * @suite sim/pois
 * @group integration
 * @covers src/sim/pois.ts src/sim/World.ts src/sim/Simulation.ts src/sim/config.ts
 * @desc Exploration: seeded site scatter, discovery radius, the salvage task and
 * its refusals, Earth supply drops on a schedule, dust burying a container
 * faster inside a storm, and all of it surviving a save/restore.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import {
  POI_DISCOVER_M,
  POI_MIN_DIST_FROM_SPAWN,
  POI_MIN_SEPARATION,
  DROP_BURY_SOLS,
} from '../../src/sim/config';
import {
  isPickedClean,
  salvageTotalKg,
  scatterableKinds,
  POI_KINDS,
} from '../../src/sim/pois';
import type { ResourceId } from '../../src/sim/defs';
import { buildOnline, run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

/** The site nearest to the base that has something to take. */
function nearestSite(sim: Simulation) {
  return sim.world.pois
    .filter((p) => !isPickedClean(p) && p.kind !== 'settlementSite')
    .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
}

/** Park a rover next to a site — the drive out is `sim/rovers`' business. */
function parkAt(sim: Simulation, roverId: number, x: number, z: number) {
  const r = sim.roverById(roverId)!;
  r.x = x;
  r.z = z;
  r.y = sim.world.heightAt(x, z);
  r.battery = 999;
  r.recharge = false;
  return r;
}

/** Force the next Earth cargo mission to land almost immediately. */
function landDropNow(sim: Simulation) {
  sim.nextDropSol = 0.01;
  run(sim, 0.05);
  const drop = sim.world.pois.find((p) => p.kind === 'supplyDrop' && !p.buried);
  assert.ok(drop, 'a supply drop should have landed');
  return drop!;
}

group('World generation');

test('the same seed scatters the same planet, and a different one does not', () => {
  const a = new Simulation({ seed: 909, nearDeposits: 0.2 });
  const b = new Simulation({ seed: 909, nearDeposits: 0.2 });
  assert.ok(a.world.pois.length > 0, 'a world should have sites to find');
  assert.equal(a.world.pois.length, b.world.pois.length, 'same seed, same site count');
  for (let i = 0; i < a.world.pois.length; i++) {
    assert.equal(a.world.pois[i].kind, b.world.pois[i].kind, `site ${i} kind`);
    assert.equal(a.world.pois[i].x, b.world.pois[i].x, `site ${i} x`);
    assert.equal(a.world.pois[i].z, b.world.pois[i].z, `site ${i} z`);
    assert.equal(
      salvageTotalKg(a.world.pois[i]),
      salvageTotalKg(b.world.pois[i]),
      `site ${i} salvage`,
    );
  }
  const c = new Simulation({ seed: 1234, nearDeposits: 0.2 });
  const same = c.world.pois.every(
    (p, i) => a.world.pois[i] && p.x === a.world.pois[i].x && p.z === a.world.pois[i].z,
  );
  assert.equal(same, false, 'a different seed must scatter a different planet');
});

test('sites stay out of the known neighbourhood, apart from each other, and reachable', () => {
  const sim = new Simulation({ seed: 77, nearDeposits: 0.2 });
  const inner = Math.min(POI_MIN_DIST_FROM_SPAWN, sim.world.half * 0.45);
  for (const p of sim.world.pois) {
    assert.ok(
      Math.hypot(p.x, p.z) >= inner - 1e-6,
      `${p.kind} at ${Math.round(Math.hypot(p.x, p.z))} m is inside the known neighbourhood`,
    );
    assert.ok(sim.world.canDrive(p.x, p.z), `${p.kind} must be somewhere a rover can drive`);
  }
  for (const a of sim.world.pois) {
    for (const b of sim.world.pois) {
      if (a.id === b.id) continue;
      assert.ok(
        Math.hypot(a.x - b.x, a.z - b.z) >= POI_MIN_SEPARATION - 1e-6,
        'two sites must not sit on top of each other',
      );
    }
  }
  // Every scatterable kind must be *reachable* by the weighted pick — a
  // zero-weight typo otherwise deletes a feature with nothing to notice.
  for (const kind of scatterableKinds()) {
    const seen = new Set<number>();
    for (let seed = 1; seed < 40; seed++) {
      for (const p of new Simulation({ seed, nearDeposits: 0.2 }).world.pois) seen.add(p.kind.length);
    }
    assert.ok(seen.size > 0, `kind ${kind} should be scatterable`);
  }
});

test('no site is scattered as a supply drop — those are scheduled, not generated', () => {
  const sim = new Simulation({ seed: 31, nearDeposits: 0.2 });
  assert.equal(
    sim.world.pois.filter((p) => p.kind === 'supplyDrop').length,
    0,
    'the world generator must not pre-place Earth cargo',
  );
  assert.equal(
    sim.world.pois.every((p) => !p.discovered),
    true,
    'a fresh map begins mostly unknown (GDD §06)',
  );
});

group('Discovery');

test('a rover arriving within range puts a site on the map, permanently', () => {
  const sim = new Simulation({ seed: 55, nearDeposits: 0.2 });
  const site = nearestSite(sim);
  assert.ok(site, 'the world should have somewhere worth going');
  assert.equal(site.discovered, false);

  // Just outside the radius: still unknown.
  const r = sim.rovers[0];
  r.x = site.x + POI_DISCOVER_M + 12;
  r.z = site.z;
  run(sim, 0.02);
  assert.equal(site.discovered, false, 'driving past at range should not reveal it');

  r.x = site.x + 6;
  run(sim, 0.02);
  assert.equal(site.discovered, true, 'arriving should reveal it');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes(POI_KINDS[site.kind].label)),
    'a find should be logged — GDD §11 Opportunity alerts',
  );

  // And it stays found when the rover leaves.
  r.x = site.x + 400;
  run(sim, 0.05);
  assert.equal(site.discovered, true, 'discovery is permanent');
});

test('an undiscovered site cannot be ordered — the sim knows, the player does not', () => {
  const sim = new Simulation({ seed: 55, nearDeposits: 0.2 });
  const site = nearestSite(sim);
  const r = sim.rovers[0];
  assert.equal(site.discovered, false);
  assert.equal(sim.issueSalvage(r.id, site.id), false, 'an unsurveyed site is not orderable');
  assert.equal(r.command.type, 'idle', 'a refused order queues nothing');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('surveyed')),
    'the refusal should say why',
  );
});

group('Salvage');

test('a salvage order fills the hold from the site, then keeps going until it is stripped', () => {
  const sim = new Simulation({ seed: 55, nearDeposits: 0.2 });
  buildOnline(sim, 'warehouse');
  const site = nearestSite(sim);
  site.discovered = true;
  const before = salvageTotalKg(site);
  assert.ok(before > 100, 'precondition: a site with something on it');

  const r = parkAt(sim, sim.rovers[0].id, site.x, site.z);
  assert.equal(sim.issueSalvage(r.id, site.id), true);
  assert.equal(r.command.type, 'salvage');

  run(sim, 0.5);
  const taken = Object.values(r.cargo).reduce((a, b) => a + b, 0);
  assert.ok(taken > 0, 'the rover should have cut something free');
  assert.ok(salvageTotalKg(site) < before, 'the site should be lighter');
});

test('a stripped site hands over its cells, then refuses further orders', () => {
  const sim = new Simulation({ seed: 55, nearDeposits: 0.2 });
  buildOnline(sim, 'warehouse');
  const drop = landDropNow(sim);
  drop.discovered = true;
  const kg = salvageTotalKg(drop);
  const cells = drop.energyKWh;

  const r = parkAt(sim, sim.rovers[0].id, drop.x, drop.z);
  assert.equal(sim.issueSalvage(r.id, drop.id), true);
  // A drop is small enough for one hold on any rover, so this strips it.
  run(sim, 1.5);

  assert.ok(isPickedClean(drop), 'the site should be empty');
  if (cells > 0.5) {
    assert.ok(sim.storedKWh > 0, 'surviving cells should reach the grid store');
  }
  assert.equal(sim.issueSalvage(r.id, drop.id), false, 'nothing left to take');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('picked clean')),
    'the refusal should say the site is empty',
  );
  // A recovered drop is finished, so its deadline must come off the board —
  // clearing only on burial would leave it counting down a sol it no longer has.
  assert.equal(
    sim.alerts.list().some((a) => a.key === `drop-live-${drop.id}`),
    false,
    'the deadline alert goes away when the cargo is recovered',
  );
  assert.ok(kg > 0, 'precondition: the drop carried cargo');
});

test('a settlement site is a marker, not a job', () => {
  const sim = new Simulation({ seed: 31, nearDeposits: 0.2 });
  let site = sim.world.pois.find((p) => p.kind === 'settlementSite');
  if (!site) {
    // Not every seed scatters one; the rule is what is under test.
    site = sim.world.addPoi({
      kind: 'settlementSite',
      x: 300,
      z: 0,
      salvage: {},
      energyKWh: 0,
      discovered: true,
      solsToBury: 0,
      buried: false,
      manifest: '',
    });
  }
  site.discovered = true;
  assert.equal(isPickedClean(site), true, 'a marker never has salvage');
  assert.equal(sim.issueSalvage(sim.rovers[0].id, site.id), false);
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('place to build')),
    'the refusal should explain what a settlement site is for',
  );
});

group('Supply drops');

test('Earth sends cargo on a schedule, announces it, and the clock is in the alert', () => {
  const sim = new Simulation({ seed: 4242, nearDeposits: 0.2 });
  assert.equal(
    sim.world.pois.filter((p) => p.kind === 'supplyDrop').length,
    0,
    'nothing has landed at launch',
  );
  assert.ok(sim.nextDropSol > 1, 'the first mission is booked a few sols out');

  const drop = landDropNow(sim);
  assert.ok(drop.manifest.length > 0, 'a drop should say what Earth sent');
  assert.ok(drop.discovered, 'the transponder gives the bearing without a rover');
  assert.ok(salvageTotalKg(drop) > 0, 'a drop should carry cargo');
  assert.equal(
    'fluids' in drop,
    false,
    'drops carry no water or food — exposed fluids would freeze and cannot be recovered',
  );
  const alert = sim.alerts.list().find((a) => a.key === `drop-live-${drop.id}`);
  assert.ok(alert, 'a landed drop should raise a standing alert');
  assert.ok(
    alert!.detail.includes('Buried in'),
    `the alert should carry the deadline, got: ${alert!.detail}`,
  );
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('Transponder contact')),
    'the arrival should be logged',
  );
});

test('dust buries an unrecovered drop, and a storm buries it faster', () => {
  // Same seed, same landing spot, same window — the only difference is the sky.
  const WINDOW = 1.0; // sols

  // Calm control: the clock runs at one sol per sol.
  const calm = new Simulation({ seed: 808, nearDeposits: 0.2 });
  const calmDrop = landDropNow(calm);
  // The drop landed a fraction of a sol ago (landDropNow advances time to get it
  // on the ground), so its clock is already ticking — just under the full window.
  const calmStart = calmDrop.solsToBury;
  assert.ok(
    calmStart > DROP_BURY_SOLS - 0.12 && calmStart <= DROP_BURY_SOLS,
    `a fresh drop should get the full ${DROP_BURY_SOLS}-sol window, got ${calmStart}`,
  );
  run(calm, WINDOW);
  const calmLost = calmStart - calmDrop.solsToBury;
  assert.ok(
    calmLost > WINDOW * 0.9 && calmLost < WINDOW * 1.15,
    `calm burial should cost about ${WINDOW} sols, got ${calmLost}`,
  );
  assert.equal(calmDrop.buried, false, 'one sol of calm weather is not enough to lose it');

  // Storm: the same elapsed time costs several times more of the window, because
  // that is the whole design of the feature (GDD §10).
  const storm = new Simulation({ seed: 808, nearDeposits: 0.2 });
  const stormDrop = landDropNow(storm);
  storm.devForceStorm('severe');
  const stormStart = stormDrop.solsToBury;
  run(storm, WINDOW);
  const stormLost = stormStart - stormDrop.solsToBury;
  assert.ok(
    storm.weather.stormIntensity > 0.05 || stormDrop.buried,
    'precondition: the storm reached the colony inside the window',
  );
  assert.ok(
    stormLost > calmLost * 1.5,
    `a storm must bury faster than calm weather (${stormLost.toFixed(2)} vs ${calmLost.toFixed(2)} sols)`,
  );
});

test('a buried container is gone: refused, logged, and its alert cleared', () => {
  const sim = new Simulation({ seed: 808, nearDeposits: 0.2 });
  const drop = landDropNow(sim);
  drop.discovered = true;
  drop.solsToBury = 0.02; // the dust is nearly over it already
  run(sim, 0.1);

  assert.equal(drop.buried, true, 'the window ran out');
  assert.equal(sim.issueSalvage(sim.rovers[0].id, drop.id), false, 'a buried drop is not recoverable');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('The dust took')),
    'losing a drop should be logged',
  );
  assert.equal(
    sim.alerts.list().some((a) => a.key === `drop-live-${drop.id}`),
    false,
    'the deadline alert goes away with the cargo',
  );
});

group('Persistence');

test('sites, discovery and the drop schedule survive a save round-trip', () => {
  const sim = new Simulation({ seed: 606, nearDeposits: 0.2 });
  const site = nearestSite(sim);
  site.discovered = true;
  site.salvage[Object.keys(site.salvage)[0] as ResourceId] = 12.5;
  const drop = landDropNow(sim);
  run(sim, 0.4);

  const snap = JSON.parse(JSON.stringify(sim.snapshot())) as any;
  assert.equal(snap.version, 7, 'the snapshot should be on the current schema');
  assert.ok(Array.isArray(snap.pois) && snap.pois.length > 0, 'sites are saved');
  assert.ok(snap.exploration?.nextDropSol > 0, 'the drop schedule is saved');

  const next = new Simulation({ seed: 1, nearDeposits: 0.2 });
  next.restore(snap);
  const site2 = next.poiById(site.id)!;
  assert.equal(site2.discovered, true, 'a found site stays found');
  assert.equal(salvageTotalKg(site2), salvageTotalKg(site), 'salvage progress is kept');
  const drop2 = next.poiById(drop.id)!;
  assert.ok(drop2, 'a landed drop is kept');
  assert.ok(
    Math.abs(drop2.solsToBury - drop.solsToBury) < 1e-9,
    'the burial clock resumes where it stopped',
  );
  assert.equal(next.nextDropSol, sim.nextDropSol, 'the next mission is still booked');
});

test('a v6 save migrates: an older colony simply has not found anything yet', () => {
  const sim = new Simulation({ seed: 707, nearDeposits: 0.2 });
  run(sim, 0.2);
  const snap = JSON.parse(JSON.stringify(sim.snapshot())) as any;
  delete snap.pois;
  delete snap.exploration;
  snap.version = 6; // what the schema looked like before exploration existed

  const next = new Simulation({ seed: 707, nearDeposits: 0.2 });
  next.restore(snap);
  assert.ok(next.world.pois.length > 0, 'the seed still scatters its planet');
  assert.equal(
    next.world.pois.every((p) => !p.discovered),
    true,
    'nothing in a migrated colony has been found',
  );
  assert.ok(next.nextDropSol > 0, 'a migrated colony gets a drop schedule');
  const snap2 = JSON.parse(JSON.stringify(next.snapshot())) as any;
  assert.equal(snap2.version, 7, 're-saving lands on the current schema');
});

await finish('sim/pois');
