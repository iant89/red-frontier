/**
 * @suite sim/construction-system
 * @group unit
 * @covers src/sim/systems/ConstructionSystem.ts src/sim/rules.ts
 * @desc ConstructionSystem extraction (Phase 9): the siting verdict and the
 * build ghost's agreement with it, site materials and the awaiting-materials
 * alert, the material ledger, worker choice (nearest capable rover, player
 * orders never stolen, recharging and cargo rovers skipped, wanderers
 * released), overlapping sites, progress arithmetic with the workshop and
 * storm multipliers, completion and its capacity recompute, cancellation
 * refunds, and the developer shortcuts.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import {
  ConstructionSystem,
  type ConstructionHostHooks,
} from '../../src/sim/systems/ConstructionSystem';
import { ColonyMirror } from '../../src/sim/host/mirror';
import { projectView } from '../../src/sim/host/projection';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { BUILDINGS, ROVERS, ALL_RESOURCES, type BuildingKind } from '../../src/sim/defs';
import {
  SIM_TICK,
  HOURS_PER_SEC,
  BASE_STORAGE_PER_RESOURCE,
  ROVER_WEAR_WORK_S,
  ROVER_CONDITION_SLOW,
} from '../../src/sim/config';
import { run, build, buildOnline, findSpot } from '../fixtures/sim';
import { group, test, finish } from '../harness';

const HOURS = SIM_TICK * HOURS_PER_SEC;

/** Two spots far enough apart that both may legally be standing at once. */
function twoSpots(sim: Simulation, kind: BuildingKind, second: BuildingKind = kind) {
  const a = findSpot(sim, kind);
  for (let r = 34; r <= 240; r += 3) {
    for (let ang = 0; ang < 360; ang += 7) {
      const x = Math.cos((ang * Math.PI) / 180) * r;
      const z = Math.sin((ang * Math.PI) / 180) * r;
      if (sim.canPlace(second, x, z) !== null) continue;
      if (Math.hypot(x - a.x, z - a.z) < 26) continue;
      return [a, { x, z }] as const;
    }
  }
  throw new Error('no second legal spot');
}

/**
 * A legal spot for `kind`: inside `WORKSHOP_ASSIST_RADIUS` of `anchor` when
 * `near`, deliberately outside it when not, and anywhere legal when there is
 * no anchor. Terrain decides, so the spot is searched rather than assumed.
 */
function pickSpot(
  sim: Simulation,
  kind: BuildingKind,
  anchor: { x: number; z: number } | null,
  near = true,
) {
  const radius = 70;
  const ok = (x: number, z: number) => {
    if (sim.canPlace(kind, x, z) !== null) return false;
    if (!anchor) return true;
    const d = Math.hypot(x - anchor.x, z - anchor.z);
    return near ? d < radius - 8 : d >= radius + 8;
  };
  const rings: Array<[number, number]> = [];
  for (let r = anchor ? 12 : 34; r <= 240; r += 3) {
    for (let a = 0; a < 360; a += 5) {
      rings.push([
        (anchor?.x ?? 0) + Math.cos((a * Math.PI) / 180) * r,
        (anchor?.z ?? 0) + Math.sin((a * Math.PI) / 180) * r,
      ]);
    }
  }
  for (const [x, z] of rings) if (ok(x, z)) return { x, z };
  throw new Error(`no legal ${near ? 'near' : 'far'} spot for ${kind}`);
}

/**
 * Two legal spots at least `minDist` apart. Terrain and deposits decide what is
 * legal, so the pair is searched rather than assumed — a hard-coded coordinate
 * is a different world on every seed.
 */
function farSpots(
  sim: Simulation,
  kindA: BuildingKind,
  kindB: BuildingKind,
  minDist: number,
): [{ x: number; z: number }, { x: number; z: number }] {
  const a = findSpot(sim, kindA);
  for (let r = 34; r <= 400; r += 4) {
    for (let ang = 0; ang < 360; ang += 5) {
      const x = Math.cos((ang * Math.PI) / 180) * r;
      const z = Math.sin((ang * Math.PI) / 180) * r;
      if (Math.hypot(x - a.x, z - a.z) < minDist) continue;
      if (sim.canPlace(kindB, x, z) !== null) continue;
      return [a, { x, z }];
    }
  }
  throw new Error('no pair of legal spots far enough apart');
}

/** Quiet the fleet's own automation so construction is the only thing moving. */
function still(sim: Simulation): Simulation {
  for (const r of sim.rovers) r.rules.autoHaul = false;
  return sim;
}

function stock(sim: Simulation, kg = 3000): void {
  for (const res of ALL_RESOURCES) sim.storage[res] = kg;
}

function remaining(b: { remainingCost: Record<string, number> }): number {
  let t = 0;
  for (const res of ALL_RESOURCES) t += b.remainingCost[res];
  return t;
}

/**
 * A recording stand-in for the cross-domain seam. Rover pathing, task
 * lifecycle, wear scaling and stranding belong to RoverSystem (Phase 10) and
 * LogisticsSystem (Phase 13), so these tests only assert *that* construction
 * asks, and with what arguments — never how the rover answers.
 *
 * `roverWorkMul` reports 1 so the arithmetic under test is the construction
 * domain's own (the condition-scaled factor is the hook's business).
 */
function stubHooks(): {
  hooks: ConstructionHostHooks;
  travel: Array<{ id: number; x: number; z: number; goal: string }>;
  finished: number[];
  assigned: Array<{ id: number; buildingId: number }>;
  disabled: number[];
} {
  const travel: Array<{ id: number; x: number; z: number; goal: string }> = [];
  const finished: number[] = [];
  const assigned: Array<{ id: number; buildingId: number }> = [];
  const disabled: number[] = [];
  return {
    travel,
    finished,
    assigned,
    disabled,
    hooks: {
      setTravel: (r, x, z, goal) => travel.push({ id: r.id, x, z, goal }),
      finishTask: (r) => finished.push(r.id),
      autoAssign: (r, task) =>
        assigned.push({ id: r.id, buildingId: (task as { buildingId: number }).buildingId }),
      disableRover: (r) => disabled.push(r.id),
      roverWorkMul: () => 1,
      canDeliverCargo: () => true,
    },
  };
}

/** Park a rover inside the site's reach so `build` assembles rather than walks. */
function parkAt(sim: Simulation, b: { x: number; z: number; kind: BuildingKind }, i = 0) {
  const r = sim.rovers[i];
  r.x = b.x + 2;
  r.z = b.z;
  r.condition = ROVER_CONDITION_SLOW; // roverWorkMul would be 1 in the live sim too
  r.battery = ROVERS[r.kind].maxBatteryKWh;
  return r;
}

// ---------------------------------------------------------------- siting ----

group('ConstructionSystem.verdict / place — siting authority');

test('a legal spot sites a hungry record with the definition\'s full cost', () => {
  const sim = new Simulation({ seed: 901 });
  const spot = findSpot(sim, 'warehouse');
  assert.equal(ConstructionSystem.verdict(sim.state, 'warehouse', spot.x, spot.z), null);

  const before = sim.nextEntityId;
  const b = ConstructionSystem.place(sim.state, 'warehouse', spot.x, spot.z);
  assert.ok(b, 'a legal site is accepted');
  assert.equal(b!.id, before, 'the id comes from the state\'s own counter');
  assert.equal(b!.state, 'site');
  assert.equal(b!.progress, 0);
  assert.equal(b!.workerId, null);
  assert.equal(b!.needsMaterials, false, 'hunger is decided by the materials tick, not by placement');
  assert.equal(remaining(b!), BUILDINGS.warehouse.cost.regolith + BUILDINGS.warehouse.cost.iron);
  assert.equal(b!.buildTime, BUILDINGS.warehouse.buildTime);
  assert.equal(sim.buildings.at(-1), b!, 'and it joined the colony');
  assert.match(sim.drainEvents().map((e) => e.text).join('\n'), /sited — assigning a builder/);
});

test('illegal ground is refused with the reason, and nothing is sited', () => {
  const sim = new Simulation({ seed: 902 });
  const cases: Array<[string, BuildingKind, number, number]> = [
    ['on the landing pod', 'warehouse', 0, 0],
    ['outside the region', 'warehouse', 5000, 5000],
  ];
  const dep = sim.world.deposits.find((d) => d.amount > 0)!;
  cases.push(['on a deposit', 'warehouse', dep.x, dep.z]);

  for (const [why, kind, x, z] of cases) {
    const n = sim.buildings.length;
    const err = ConstructionSystem.verdict(sim.state, kind, x, z);
    assert.ok(err, `${why}: the ground refuses`);
    assert.equal(ConstructionSystem.place(sim.state, kind, x, z), null, `${why}: place refuses too`);
    assert.equal(sim.buildings.length, n, `${why}: nothing was sited`);
  }
  const logged = sim.drainEvents();
  assert.ok(logged.every((e) => e.severity === 'warn'), 'every refusal is logged as a warning');
  assert.equal(logged.length, cases.length, 'the verdict is a silent query; only place logs');

  // An existing structure keeps its clearance margin.
  const spot = findSpot(sim, 'warehouse');
  const first = sim.placeBuilding('warehouse', spot.x, spot.z)!;
  assert.match(
    ConstructionSystem.verdict(sim.state, 'warehouse', first.x + 1, first.z + 1) ?? '',
    /existing structure/,
  );
});

test('the build ghost and the sim reach the same verdict, and place obeys it', () => {
  const sim = still(new Simulation({ seed: 903 }));
  const ghost = new ColonyMirror(
    { seed: sim.world.seed, worldHalf: sim.world.half, region: sim.world.region },
    projectView(sim, 'worker', {}),
  );
  const sites: Array<[number, number]> = [
    [0, 0],
    [34, 0],
    [5000, 5000],
    [-590, 590],
  ];
  const spot = findSpot(sim, 'warehouse');
  sites.push([spot.x, spot.z], [sim.world.deposits[0].x, sim.world.deposits[0].z]);

  for (const [x, z] of sites) {
    for (const kind of Object.keys(BUILDINGS) as BuildingKind[]) {
      const verdict = ConstructionSystem.verdict(sim.state, kind, x, z);
      assert.equal(ghost.canPlace(kind, x, z), verdict, `${kind} at ${x},${z}`);
      assert.equal(sim.placeVerdict(kind, x, z), verdict, 'the sim\'s public query is the system\'s');
      // The gate: what the ghost previewed is what placement decides.
      const placed = ConstructionSystem.place(sim.state, kind, x, z);
      assert.equal(placed === null, verdict !== null, `${kind} at ${x},${z}: place agrees with the ghost`);
      if (placed) sim.demolish(placed.id);
      sim.drainEvents();
    }
  }
});

test('a site just placed makes its own spot illegal for the next one', () => {
  const sim = new Simulation({ seed: 904 });
  const spot = findSpot(sim, 'solar');
  assert.equal(sim.canPlace('solar', spot.x, spot.z), null);
  const b = sim.placeBuilding('solar', spot.x, spot.z)!;
  assert.ok(sim.canPlace('solar', spot.x, spot.z), 'the authority sees the new structure at once');
  sim.demolish(b.id);
  assert.equal(sim.canPlace('solar', spot.x, spot.z), null, 'and forgets it when the site is cancelled');
});

// ------------------------------------------------------------- materials ----

group('ConstructionSystem.tickSiteMaterials — the material ledger');

test('a hungry site keeps its cost, raises the alert, and gets no builder', () => {
  const sim = still(new Simulation({ seed: 905 }));
  const b = build(sim, 'warehouse');
  const cost = { ...BUILDINGS.warehouse.cost };

  ConstructionSystem.tickSiteMaterials(sim.state);
  assert.equal(remaining(b), cost.regolith + cost.iron, 'nothing was available to commit');
  assert.equal(b.needsMaterials, true);

  const alert = sim.alerts.list().find((a) => a.key === `mats-${b.id}`);
  assert.ok(alert, 'the awaiting-materials alert is raised');
  assert.equal(alert!.severity, 'warn');
  assert.equal(alert!.title, 'Warehouse awaiting materials');
  assert.equal(alert!.detail, 'Still needs 35 kg Regolith, 15 kg Iron Ore.');
  assert.equal(alert!.entityId, b.id);

  ConstructionSystem.assignBuilders(sim.state, stubHooks().hooks);
  assert.equal(b.workerId, null, 'delivery is someone else\'s job — a hungry site is not staffed');
});

test('a partial silo commits what it has, and a full one clears the alert', () => {
  const sim = still(new Simulation({ seed: 906 }));
  const b = build(sim, 'warehouse');
  ConstructionSystem.tickSiteMaterials(sim.state); // raise the alert first

  sim.storage.regolith = 10; // short of the 35 kg the warehouse owes
  sim.storage.iron = 100; // comfortably over the 15 kg it owes
  const took = ConstructionSystem.commitAvailableMaterials(sim.state, b);
  assert.equal(took, 25, 'only what the silo actually holds is committed: 10 regolith + 15 iron');
  assert.equal(sim.storage.regolith, 0, 'the short silo is drained, not driven negative');
  assert.equal(sim.storage.iron, 85, 'the covered one pays exactly the cost');
  assert.equal(b.remainingCost.regolith, 25, 'the outstanding cost falls by the same mass');
  assert.equal(b.remainingCost.iron, 0, 'iron was covered in full');
  assert.ok(sim.storage.iron >= 0 && b.remainingCost.iron >= 0, 'neither ledger goes negative');

  stock(sim, 3000);
  ConstructionSystem.tickSiteMaterials(sim.state);
  assert.equal(remaining(b), 0);
  assert.equal(b.needsMaterials, false);
  assert.equal(sim.alerts.list().find((a) => a.key === `mats-${b.id}`), undefined, 'the alert is cleared');
  assert.match(
    sim.drainEvents().map((e) => e.text).join('\n'),
    /fully stocked — ready to assemble/,
  );
});

test('hasMaterials / consumeMaterials / missingList are the one ledger the garage also spends from', () => {
  const sim = new Simulation({ seed: 907 });
  const cost = { ...BUILDINGS.warehouse.cost };
  assert.equal(ConstructionSystem.hasMaterials(sim.state, cost), false, 'an empty colony cannot afford it');
  assert.equal(ConstructionSystem.missingList(cost), '35 kg Regolith, 15 kg Iron Ore');

  stock(sim, 3000);
  assert.equal(ConstructionSystem.hasMaterials(sim.state, cost), true);
  ConstructionSystem.consumeMaterials(sim.state, cost);
  assert.equal(sim.storage.regolith, 3000 - cost.regolith);
  assert.equal(sim.storage.iron, 3000 - cost.iron);

  // A cost nobody owes reads as "materials", never as an empty string.
  assert.equal(ConstructionSystem.missingList({ regolith: 0, iron: 0, silicon: 0, aluminum: 0, ice: 0 }), 'materials');
});

// ------------------------------------------------------- worker choice ----

group('ConstructionSystem.assignBuilders — who builds it');

test('the nearest capable rover is dispatched, as an auto task', () => {
  const sim = still(new Simulation({ seed: 908 }));
  const b = build(sim, 'warehouse');
  stock(sim, 3000);
  ConstructionSystem.tickSiteMaterials(sim.state);
  const rec = stubHooks();

  ConstructionSystem.assignBuilders(sim.state, rec.hooks);
  assert.equal(rec.assigned.length, 1, 'exactly one dispatch');
  assert.equal(rec.assigned[0].buildingId, b.id);
  assert.equal(b.workerId, rec.assigned[0].id);

  const chosen = sim.roverById(rec.assigned[0].id)!;
  const other = sim.rovers.find((r) => r.id !== chosen.id)!;
  assert.ok(
    Math.hypot(chosen.x - b.x, chosen.z - b.z) <= Math.hypot(other.x - b.x, other.z - b.z),
    'the nearer rover won',
  );
  assert.ok(BUILDINGS.warehouse.buildableBy.includes(chosen.kind), 'and it is a kind that can build');
});

test('a player order is never stolen, a recharging rover is skipped, a cargo rover is refused', () => {
  const sim = still(new Simulation({ seed: 909 }));
  const b = build(sim, 'warehouse');
  stock(sim, 3000);
  ConstructionSystem.tickSiteMaterials(sim.state);
  const [r0, r1] = sim.rovers;

  sim.issueMove(r0.id, 120, 120); // an explicit player order: autoTask false
  r1.recharge = true; // heading for a charger
  ConstructionSystem.assignBuilders(sim.state, stubHooks().hooks);
  assert.equal(b.workerId, null, 'construction outranks an auto supply run, never a player order');
  assert.equal(r0.command.type, 'moveTo', 'the player\'s order is untouched');

  r1.recharge = false;
  const cargo = sim.devSpawnRover('cargo', b.x + 3, b.z);
  r1.recharge = true; // now only the cargo rover is free
  ConstructionSystem.assignBuilders(sim.state, stubHooks().hooks);
  assert.equal(b.workerId, null, `a ${ROVERS.cargo.label} cannot build — buildableBy excludes it`);
  assert.equal(cargo.command.type, 'idle');
});

test('a worker pulled onto a player order is released, and the site is re-staffed', () => {
  // Driven through the live tick rather than the stub hooks: the point is what
  // the *rover* ends up doing, and applying a task is RoverSystem's answer to
  // the `autoAssign` hook, not construction's.
  const sim = still(new Simulation({ seed: 910 }));
  const b = build(sim, 'warehouse');
  stock(sim, 3000);
  sim.step(1 / 20); // materials commit, then the site is staffed
  const worker = b.workerId;
  assert.ok(worker !== null, 'precondition: the site was staffed');
  const other = sim.rovers.find((r) => r.id !== worker)!;
  assert.equal(other.command.type, 'idle', 'precondition: the spare rover has nothing to do');

  // The player takes the builder off the job for something else.
  sim.issueMove(worker!, 120, 120);
  sim.step(1 / 20);
  assert.equal(b.workerId, other.id, 'the stale claim is dropped and the spare rover takes the job');
  assert.equal(sim.roverById(worker!)!.command.type, 'moveTo', 'the player\'s order survives the re-staff');
  assert.equal(sim.roverById(worker!)!.autoTask, false, 'and it is still a player order, not an auto task');
  assert.equal(other.command.type, 'construct', 'the spare rover is really on the job now');

  // A rover that leaves the fleet entirely releases its claim just as firmly.
  other.phase = 'disabled';
  sim.step(1 / 20);
  assert.equal(b.workerId, null, 'a disabled worker holds no site');
});

test('overlapping sites: one rover claimed twice builds the later site first', () => {
  /**
   * Characterization, not an endorsement. Sites are staffed in placement
   * order and an *auto* task is stealable, so when one rover is nearest to
   * both sites the later site takes it and the earlier one keeps a stale
   * `workerId` until the later site finishes. Both do get built. This is the
   * behaviour the extraction preserved byte-for-byte; whether it is the
   * behaviour the game wants is a scheduling decision for RoverSystem
   * (Phase 10) / FleetAutomationSystem (Phase 12), recorded in the roadmap.
   */
  const sim = still(new Simulation({ seed: 911 }));
  const [sa, sb] = twoSpots(sim, 'warehouse', 'solar');
  const a = sim.placeBuilding('warehouse', sa.x, sa.z)!;
  const b = sim.placeBuilding('solar', sb.x, sb.z)!;
  stock(sim, 3000);

  run(sim, 0.05);
  assert.equal(a.workerId, b.workerId, 'both sites claim the same rover');
  assert.equal(a.progress, 0, 'and the earlier site does no work while it holds a stale claim');
  assert.ok(b.progress > 0, 'the later site is the one being assembled');

  for (let i = 0; i < 20_000 && (a.state !== 'online' || b.state !== 'online'); i++) sim.step(1 / 20);
  assert.equal(b.state, 'online');
  assert.equal(a.state, 'online', 'the earlier site is built once the later one releases the crew');
});

test('two sites far apart are staffed by two different rovers in the same pass', () => {
  const sim = still(new Simulation({ seed: 912 }));
  const [sa, sb] = farSpots(sim, 'warehouse', 'solar', 150);
  const a = sim.placeBuilding('warehouse', sa.x, sa.z);
  const b = sim.placeBuilding('solar', sb.x, sb.z);
  assert.ok(a && b, 'precondition: both spots are legal');
  stock(sim, 3000);
  ConstructionSystem.tickSiteMaterials(sim.state);
  ConstructionSystem.assignBuilders(sim.state, stubHooks().hooks);
  assert.notEqual(a!.workerId, b!.workerId, 'each site gets its own crew');
  assert.ok(a!.workerId !== null && b!.workerId !== null);
});

// -------------------------------------------------------------- progress ----

group('ConstructionSystem.build — progress arithmetic');

test('out of reach the builder walks: setTravel, no progress', () => {
  const sim = new Simulation({ seed: 913 });
  const b = build(sim, 'warehouse');
  const r = sim.rovers[0];
  r.x = b.x + 400;
  r.z = b.z + 400;
  const rec = stubHooks();

  ConstructionSystem.build(sim.state, r, b, rec.hooks);
  assert.equal(rec.travel.length, 1);
  assert.deepEqual(
    { x: rec.travel[0].x, z: rec.travel[0].z, goal: rec.travel[0].goal },
    { x: b.x, z: b.z, goal: 'toSite' },
  );
  assert.equal(r.gid, b.id, 'the rover remembers which site it is walking to');
  assert.equal(b.progress, 0, 'no work is done from 400 m away');
});

test('a builder standing on a hungry site gives the job back', () => {
  const sim = new Simulation({ seed: 914 });
  const b = build(sim, 'warehouse');
  const r = parkAt(sim, b);
  b.workerId = r.id;
  const rec = stubHooks();

  ConstructionSystem.build(sim.state, r, b, rec.hooks);
  assert.deepEqual(rec.finished, [r.id], 'the rover is released rather than idling on the pad');
  assert.equal(b.workerId, null, 'and the site forgets its claim');
  assert.equal(b.progress, 0);
});

test('one tick of assembly moves progress by buildPower × tick ÷ buildTime, and wears the rover', () => {
  const sim = new Simulation({ seed: 915 });
  const b = build(sim, 'warehouse');
  stock(sim, 3000);
  ConstructionSystem.tickSiteMaterials(sim.state);
  const r = parkAt(sim, b);
  const rec = stubHooks();
  const battery0 = r.battery;
  const condition0 = r.condition;

  ConstructionSystem.build(sim.state, r, b, rec.hooks);
  const def = ROVERS[r.kind];
  assert.ok(
    Math.abs(b.progress - (def.buildPower * SIM_TICK) / b.buildTime) < 1e-12,
    `progress follows the authored rate (got ${b.progress})`,
  );
  assert.equal(b.state, 'building', 'the first blow turns a site into a building');
  assert.equal(r.goal, 'build');
  assert.equal(r.phase, 'working');
  assert.ok(
    Math.abs(battery0 - r.battery - def.workPowerKw * HOURS * 0.6) < 1e-12,
    'assembly draws the work rate, at the 0.6 build share',
  );
  assert.ok(
    Math.abs(condition0 - r.condition - ROVER_WEAR_WORK_S * 0.7 * SIM_TICK) < 1e-12,
    'and the drivetrain wears while it works',
  );
  assert.match(sim.drainEvents().map((e) => e.text).join('\n'), /began assembling the Warehouse/);
});

test('an online workshop within 70 m lends tools: \u00d71.35, and only while it is switched on', () => {
  /** One tick of assembly progress for a site sited at `pick`. */
  const rate = (
    withShop: boolean,
    opts: { enabled?: boolean; near?: boolean } = {},
  ): { progress: number; dist: number } => {
    const enabled = opts.enabled ?? true;
    const near = opts.near ?? true;
    const sim = still(new Simulation({ seed: 916 }));
    let anchor: { x: number; z: number } | null = null;
    if (withShop) {
      const shop = buildOnline(sim, 'workshop');
      shop.enabled = enabled;
      anchor = shop;
    }
    const spot = pickSpot(sim, 'warehouse', anchor, near);
    const b = sim.placeBuilding('warehouse', spot.x, spot.z)!;
    stock(sim, 3000);
    ConstructionSystem.tickSiteMaterials(sim.state);
    const r = parkAt(sim, b);
    ConstructionSystem.build(sim.state, r, b, stubHooks().hooks);
    return {
      progress: b.progress,
      dist: anchor ? Math.hypot(anchor.x - b.x, anchor.z - b.z) : Infinity,
    };
  };

  const plain = rate(false).progress;
  const helped = rate(true);
  const off = rate(true, { enabled: false });
  const far = rate(true, { near: false });

  assert.ok(helped.dist < 70, `precondition: the assisted site is inside the radius (${helped.dist.toFixed(0)} m)`);
  assert.ok(
    Math.abs(helped.progress / plain - 1.35) < 1e-9,
    `the workshop bonus is exactly \u00d71.35 (got \u00d7${helped.progress / plain})`,
  );
  assert.equal(off.progress, plain, 'a switched-off workshop lends nothing');
  assert.ok(far.dist >= 70, `precondition: the far site is outside the radius (${far.dist.toFixed(0)} m)`);
  assert.ok(Math.abs(far.progress - plain) < 1e-12, 'and out of range the bonus does not reach');
});

test('a severe storm throttles the crew to the weather\'s work multiplier', () => {
  /**
   * One tick of assembly, measured directly. The storm is conjured *before*
   * the site exists: stepping a live colony while a builder is parked on it
   * would let the sim finish the job under test.
   */
  const measure = (storm: boolean) => {
    const sim = still(new Simulation({ seed: 918 }));
    if (storm) {
      sim.devForceStorm('severe');
      for (let i = 0; i < 60_000 && sim.weather.stormIntensity < 0.55; i++) sim.step(1 / 20);
    }
    const b = build(sim, 'warehouse');
    stock(sim, 3000);
    ConstructionSystem.tickSiteMaterials(sim.state);
    const r = parkAt(sim, b);
    const mul = sim.weather.workMultiplierAt(r.x, r.z);
    ConstructionSystem.build(sim.state, r, b, stubHooks().hooks);
    return { rate: b.progress, mul, intensity: sim.weather.stormIntensity };
  };

  const calm = measure(false);
  const rough = measure(true);
  assert.equal(calm.mul, 1, 'precondition: calm weather does not throttle the crew');
  assert.ok(rough.intensity >= 0.4, `precondition: the front arrived (I=${rough.intensity.toFixed(2)})`);
  assert.ok(rough.mul < 1, `precondition: the storm is throttling work (\u00d7${rough.mul})`);
  assert.ok(
    Math.abs(rough.rate / calm.rate - rough.mul) < 1e-9,
    `the assembly rate scales with the weather multiplier (got \u00d7${rough.rate / calm.rate}, want \u00d7${rough.mul})`,
  );
});

test('a flat battery mid-job strands the rover through the hook', () => {
  const sim = new Simulation({ seed: 919 });
  const b = build(sim, 'warehouse');
  stock(sim, 3000);
  ConstructionSystem.tickSiteMaterials(sim.state);
  const r = parkAt(sim, b);
  r.battery = ROVERS[r.kind].workPowerKw * HOURS * 0.6; // exactly one tick of work left
  const rec = stubHooks();

  ConstructionSystem.build(sim.state, r, b, rec.hooks);
  assert.equal(r.battery, 0, 'the last of it went into the assembly');
  assert.deepEqual(rec.disabled, [r.id], 'construction reports the strand; it does not own it');
});

// ------------------------------------------------------------ completion ----

group('ConstructionSystem.complete — switching a structure on');

test('completion brings it online, drops the worker, and grows the silos and the grid', () => {
  const sim = still(new Simulation({ seed: 920 }));
  const cap0 = sim.storageCapacity();
  const kwh0 = sim.batteryCapacity();
  const wh = build(sim, 'warehouse');
  const bt = build(sim, 'battery');
  stock(sim, 3000);
  ConstructionSystem.tickSiteMaterials(sim.state);
  wh.workerId = sim.rovers[0].id;
  const rec = stubHooks();

  ConstructionSystem.complete(sim.state, wh);
  assert.equal(wh.state, 'online');
  assert.equal(wh.progress, 1);
  assert.equal(wh.workerId, null, 'the crew is stood down');
  assert.equal(sim.storageCapacity(), cap0 + BUILDINGS.warehouse.storagePerResourceKg);
  assert.match(
    sim.drainEvents().map((e) => e.text).join('\n'),
    new RegExp(`Warehouse is online — \\+${BUILDINGS.warehouse.storagePerResourceKg} kg per silo`),
  );

  ConstructionSystem.complete(sim.state, bt);
  assert.equal(sim.batteryCapacity(), kwh0 + BUILDINGS.battery.batteryKWh, 'the grid learns about the batteries');
  assert.match(
    sim.drainEvents().map((e) => e.text).join('\n'),
    new RegExp(`Battery Bank is online — grid \\+${BUILDINGS.battery.batteryKWh} kWh`),
  );

  // Idempotent: a second call is not a second building.
  const events = sim.drainEvents().length;
  ConstructionSystem.complete(sim.state, wh);
  assert.equal(sim.drainEvents().length, events, 'completing an online structure logs nothing');
  assert.equal(sim.storageCapacity(), cap0 + BUILDINGS.warehouse.storagePerResourceKg);
  assert.deepEqual(rec.finished, [], 'completion alone does not release a rover — the caller does');
});

test('a rover that lands the final blow completes the site and is released', () => {
  const sim = still(new Simulation({ seed: 921 }));
  const b = build(sim, 'solar'); // a short buildTime, so the tick under test is near the end
  stock(sim, 3000);
  ConstructionSystem.tickSiteMaterials(sim.state);
  const r = parkAt(sim, b);
  b.progress = 1 - (ROVERS[r.kind].buildPower * SIM_TICK) / b.buildTime / 2; // half a tick from done
  b.workerId = r.id;
  const rec = stubHooks();

  ConstructionSystem.build(sim.state, r, b, rec.hooks);
  assert.equal(b.state, 'online');
  assert.equal(b.progress, 1, 'progress is clamped, never overshot');
  assert.deepEqual(rec.finished, [r.id], 'the crew is released in the same tick it finishes');
});

test('a colonist assisting to progress 1 completes through the life-support seam', () => {
  // Phase 7 left this hook pointing at Simulation; Phase 9 moved the
  // implementor here. The contract is unchanged, so the live wiring still has
  // to bring a site online with no rover involved.
  const sim = still(new Simulation({ seed: 922 }));
  const b = build(sim, 'warehouse');
  stock(sim, 3000);
  for (const r of sim.rovers) sim.stopRover(r.id);
  sim.orderColonist({ type: 'assist', buildingId: b.id });

  for (let i = 0; i < 20_000 && b.state !== 'online'; i++) sim.step(1 / 20);
  assert.equal(b.state, 'online', 'the human finished it alone');
  assert.equal(b.progress, 1);
  assert.equal(b.workerId, null);
  assert.equal(sim.colonist.order.type, 'assist', 'the tick that completes it is still the assist');
  sim.step(1 / 20);
  assert.equal(sim.colonist.order.type, 'shelter', 'and the next one sends them home');
});

// ---------------------------------------------------------- cancellation ----

group('ConstructionSystem.demolish — refunds and dismantling');

test('cancelling a site refunds exactly what was committed, and releases its builder', () => {
  const sim = still(new Simulation({ seed: 923 }));
  const b = build(sim, 'warehouse');
  sim.storage.regolith = 20;
  sim.storage.iron = 5;
  ConstructionSystem.tickSiteMaterials(sim.state); // commits 20 regolith + 5 iron
  assert.equal(remaining(b), 25, 'precondition: 15 regolith and 10 iron still owed');

  const r = sim.rovers[0];
  r.command = { type: 'construct', buildingId: b.id };
  r.autoTask = true;
  b.workerId = r.id;
  const rec = stubHooks();
  const before = { regolith: sim.storage.regolith, iron: sim.storage.iron };

  ConstructionSystem.demolish(sim.state, b.id, rec.hooks);
  assert.equal(sim.storage.regolith, before.regolith + 20, 'the delivered regolith comes back');
  assert.equal(sim.storage.iron, before.iron + 5, 'and the delivered iron');
  assert.equal(sim.buildings.find((x) => x.id === b.id), undefined, 'the site is gone');
  assert.deepEqual(rec.finished, [r.id], 'a rover walking to a cancelled site is released');
  assert.equal(sim.alerts.list().find((a) => a.key === `mats-${b.id}`), undefined, 'its alert is cleared');
  assert.match(
    sim.drainEvents().map((e) => e.text).join('\n'),
    /Warehouse site cancelled — 25 kg recovered/,
  );
});

test('a refund lands in full when the silo has room, and is clamped when it does not', () => {
  const sim = still(new Simulation({ seed: 924 }));
  const b = build(sim, 'warehouse');
  stock(sim, 3000);
  ConstructionSystem.tickSiteMaterials(sim.state);
  assert.equal(remaining(b), 0, 'precondition: the site was fully delivered');

  sim.recomputeCapacities();
  const cap = sim.storageCapacity();
  assert.equal(sim.storage.regolith, cap, 'precondition: the recompute clamped the silo full');

  ConstructionSystem.demolish(sim.state, b.id, stubHooks().hooks);
  /**
   * Characterization, and a discrepancy worth knowing about: `demolish`
   * documents "refund the full amount even if it overfills the silo", but the
   * capacity recompute that follows the refund in the same method clamps
   * storage straight back to capacity. So a refund into an *already full*
   * silo is silently lost, while `SimulationAssertions` still permits
   * over-capacity storage (and the excess does survive when the silo has
   * room, which is the ordinary case). Preserved as-is by the extraction;
   * recorded in the roadmap's Phase 9 block rather than fixed inside it.
   */
  assert.equal(sim.storage.regolith, cap, 'the trailing recompute clamps a full silo back');

  // The same refund with room in the silo is paid in full.
  const sim2 = still(new Simulation({ seed: 924 }));
  const b2 = build(sim2, 'warehouse');
  sim2.storage.regolith = 20;
  sim2.storage.iron = 5;
  ConstructionSystem.tickSiteMaterials(sim2.state);
  ConstructionSystem.demolish(sim2.state, b2.id, stubHooks().hooks);
  assert.equal(sim2.storage.regolith, 20, 'regolith comes back');
  assert.equal(sim2.storage.iron, 5, 'and so does the iron');
  sim2.step(1 / 20); // the Phase 1 gate runs on every step and must not trip
  assert.ok(sim2.storage.regolith > 0);
});

test('dismantling a standing structure refunds nothing and shrinks capacity', () => {
  const sim = still(new Simulation({ seed: 925 }));
  const b = buildOnline(sim, 'warehouse');
  const cap = sim.storageCapacity();
  const total = sim.storageTotal();

  sim.demolish(b.id);
  assert.equal(sim.storageTotal(), total, 'a dismantled structure is scrap, not a refund');
  assert.equal(sim.storageCapacity(), cap - BUILDINGS.warehouse.storagePerResourceKg);
  assert.equal(sim.buildings.find((x) => x.id === b.id), undefined);
  assert.match(sim.drainEvents().map((e) => e.text).join('\n'), /dismantled/);

  const n = sim.buildings.length;
  sim.demolish(999_999);
  assert.equal(sim.buildings.length, n, 'an unknown id is a no-op, not a crash');
});

// ------------------------------------------------------ developer paths ----

group('ConstructionSystem — developer shortcuts');

test('devComplete finishes a site for free and releases whoever was walking to it', () => {
  const sim = still(new Simulation({ seed: 926 }));
  const b = build(sim, 'warehouse');
  ConstructionSystem.tickSiteMaterials(sim.state); // raise the alert
  const r = sim.rovers[0];
  r.command = { type: 'construct', buildingId: b.id };
  b.workerId = r.id;
  const rec = stubHooks();

  assert.equal(ConstructionSystem.devComplete(sim.state, b.id, rec.hooks), true);
  assert.equal(b.state, 'online');
  assert.equal(remaining(b), 0, 'the cost is written off');
  assert.equal(b.needsMaterials, false);
  assert.deepEqual(rec.finished, [r.id]);
  assert.equal(sim.alerts.list().find((a) => a.key === `mats-${b.id}`), undefined);
  assert.equal(ConstructionSystem.devComplete(sim.state, b.id, rec.hooks), false, 'already online');
  assert.equal(ConstructionSystem.devComplete(sim.state, 999_999, rec.hooks), false, 'no such site');
});

test('devSpawn runs the same siting check, then completes the structure', () => {
  const sim = new Simulation({ seed: 927 });
  const cap0 = sim.storageCapacity();
  assert.equal(ConstructionSystem.devSpawn(sim.state, 'warehouse', 0, 0), null, 'the pod keeps its clearance');

  const spot = findSpot(sim, 'warehouse');
  const b = ConstructionSystem.devSpawn(sim.state, 'warehouse', spot.x, spot.z);
  assert.ok(b, 'a legal spot is accepted');
  assert.equal(b!.state, 'online');
  assert.equal(b!.progress, 1);
  assert.equal(remaining(b!), 0, 'it cost nothing');
  assert.equal(sim.storageCapacity(), cap0 + BUILDINGS.warehouse.storagePerResourceKg);
  assert.match(sim.drainEvents().map((e) => e.text).join('\n'), /is online/);
});

// ------------------------------------------------------------ end to end ----

group('ConstructionSystem — the live tick and determinism');

test('the full queue runs through the live tick: site → materials → crew → online', () => {
  const sim = new Simulation({ seed: 928, nearDeposits: 0.2 });
  const b = build(sim, 'warehouse');
  assert.equal(b.state, 'site');

  // Re-query rather than reuse `b` in the loop: `assert.equal(b.state, 'site')`
  // narrows the literal type, and a site that became a building is the point.
  // (Same idiom as `buildAndWait` in tests/fixtures/sim.ts.)
  for (let i = 0; i < 20_000 && sim.buildingById(b.id)?.state !== 'online'; i++) sim.step(1 / 20);
  const done = sim.buildingById(b.id)!;
  assert.equal(done.state, 'online', 'the colony built it with no direct drive at all');
  assert.equal(done.progress, 1);
  assert.ok(
    sim.storageCapacity() >= BASE_STORAGE_PER_RESOURCE + BUILDINGS.warehouse.storagePerResourceKg,
    'and the silos grew',
  );
  assert.equal(sim.alerts.list().find((a) => a.key === `mats-${b.id}`), undefined, 'no stale alert survives it');
});

test('same seed, same build queue: two colonies assemble identically', () => {
  const make = (seed: number) => {
    const sim = new Simulation({ seed, nearDeposits: 0.2 });
    const [sa, sb] = twoSpots(sim, 'warehouse', 'solar');
    sim.placeBuilding('warehouse', sa.x, sa.z);
    sim.placeBuilding('solar', sb.x, sb.z);
    return sim;
  };
  const a = make(929);
  const b = make(929);
  run(a, 1.5);
  run(b, 1.5);
  assert.equal(hashSimulation(a), hashSimulation(b), 'the build queue replayed');
  assert.equal(
    a.buildings.filter((x) => x.state === 'online').length,
    b.buildings.filter((x) => x.state === 'online').length,
  );
  assert.ok(a.buildings.some((x) => x.state === 'online'), 'precondition: something was actually built');
});

test('a save taken mid-build restores to the same site, and finishes the same way', () => {
  const sim = new Simulation({ seed: 930, nearDeposits: 0.2 });
  const b = build(sim, 'warehouse');
  run(sim, 0.4);
  assert.equal(b.state !== 'online' || b.progress > 0, true, 'precondition: the build is under way');

  const twin = new Simulation({ seed: 930, nearDeposits: 0.2 });
  twin.restore(sim.snapshot());
  const tb = twin.buildings.find((x) => x.kind === 'warehouse')!;
  assert.equal(tb.progress, b.progress, 'progress crosses the save boundary');
  assert.equal(tb.remainingCost.regolith, b.remainingCost.regolith, 'and so does the material ledger');

  for (let i = 0; i < 20_000 && tb.state !== 'online'; i++) twin.step(1 / 20);
  assert.equal(tb.state, 'online', 'a restored site still finishes');
  assert.equal(tb.progress, 1);
});

await finish('sim/construction-system');
