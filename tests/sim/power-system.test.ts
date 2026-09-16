/**
 * @suite sim/power-system
 * @group unit
 * @covers src/sim/systems/PowerSystem.ts src/sim/state/PowerState.ts
 * @desc PowerSystem extraction (Phase 6): the input → resolver → output pipeline
 * around the pure resolver — generation (solar chain vs the pod RTG), storage
 * capacity, tier shedding through the live system, rover charging as the lowest
 * tier, the production context seam, dust attenuation, building availability
 * reasons, restore clamping and deterministic replay.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { PowerSystem, type PowerSystemContext } from '../../src/sim/systems/PowerSystem';
import { batteryCapacityKWh } from '../../src/sim/state/PowerState';
import { BUILDINGS } from '../../src/sim/defs';
import {
  SIM_TICK,
  HOURS_PER_SEC,
  POD_POWER_KW,
  POD_LIFE_SUPPORT_KW,
  POD_BATTERY_KWH,
  ROVER_CHARGE_RATE_KW,
  GARAGE_CHARGE_RATE_KW,
  DAMAGED_HEALTH,
} from '../../src/sim/config';
import { run, buildOnline, findSpot } from '../fixtures/sim';
import { group, test, finish } from '../harness';

/** One tick's worth of hours — the unit all energy arithmetic hangs off. */
const HOURS = SIM_TICK * HOURS_PER_SEC;

/** A context where no process wants to run: loads fall to their idle draw. */
function idleCtx(): PowerSystemContext {
  return {
    desiredThroughput: () => 0,
    runProcess: () => {},
    processBlockReason: () => 'blocked',
  };
}

/** Record every runProcess call so tests can assert what production saw. */
function recordingCtx(want: (kind: string) => number): {
  ctx: PowerSystemContext;
  runs: Array<{ kind: string; throughput: number; hours: number }>;
  blocks: string[];
} {
  const runs: Array<{ kind: string; throughput: number; hours: number }> = [];
  const blocks: string[] = [];
  return {
    runs,
    blocks,
    ctx: {
      desiredThroughput: (b) => want(b.kind),
      runProcess: (b, throughput, hours) => runs.push({ kind: b.kind, throughput, hours }),
      processBlockReason: (b) => {
        blocks.push(b.kind);
        return 'Out of inputs';
      },
    },
  };
}

group('PowerSystem.tick — generation (the input stage)');

test('solar is sun × dust × cleanliness; the pod RTG ignores the sky', () => {
  const sim = new Simulation({ seed: 61 });
  const panel = buildOnline(sim, 'solar');
  sim.devSetBuildingCleanliness(panel.id, 1);
  sim.devSetTime(0, 0.5); // noon — irradiance is exactly 1
  sim.state.dustTransmission = 1;

  PowerSystem.tick(sim.state, idleCtx());
  const live = sim.buildingById(panel.id)!;
  assert.equal(live.genKw, 28, 'a clean array under a clear noon sky makes its plate rating');
  assert.equal(sim.power.generationKw, POD_POWER_KW + 28, 'generation is the RTG plus the array');

  // Dust in the air dims the array but never the reactor.
  sim.state.dustTransmission = 0.4;
  PowerSystem.tick(sim.state, idleCtx());
  assert.ok(
    Math.abs(live.genKw - 28 * 0.4) < 1e-9,
    `dust must scale the array (got ${live.genKw.toFixed(3)} kW)`,
  );
  assert.equal(sim.power.generationKw, POD_POWER_KW + 28 * 0.4);

  // Midnight: the array is worthless, the RTG carries the colony.
  sim.devSetTime(0, 0.95);
  sim.state.dustTransmission = 1;
  PowerSystem.tick(sim.state, idleCtx());
  assert.equal(live.genKw, 0, 'no sun, no solar');
  assert.equal(sim.power.generationKw, POD_POWER_KW, 'the RTG is weather-blind');
});

test('a storm-grade sky collapses solar output; the grid survives on the RTG', () => {
  const sim = new Simulation({ seed: 62 });
  const panel = buildOnline(sim, 'solar');
  sim.devSetBuildingCleanliness(panel.id, 0.5); // a half-buried array
  sim.devSetTime(0, 0.5);
  sim.state.dustTransmission = 0.3; // storm-grade haze
  PowerSystem.tick(sim.state, idleCtx());
  const live = sim.buildingById(panel.id)!;
  assert.ok(
    Math.abs(live.genKw - 28 * 0.3 * 0.5) < 1e-9,
    `sun × dust × cleanliness (got ${live.genKw.toFixed(3)} kW)`,
  );
  assert.ok(live.genKw < 5, 'a dirty array in a dust storm is nearly decorative');
  assert.equal(sim.power.generationKw, POD_POWER_KW + 28 * 0.3 * 0.5);
});

group('PowerSystem.tick — storage');

test('batteryCapacityKWh counts only banks that are online, undamaged and switched on', () => {
  const sim = new Simulation({ seed: 63 });
  const a = buildOnline(sim, 'battery');
  const b = buildOnline(sim, 'battery');
  assert.equal(sim.batteryCapacity(), POD_BATTERY_KWH + 400, 'pod pack plus two banks');
  assert.equal(batteryCapacityKWh(sim.state), sim.batteryCapacity(), 'the sim delegates to the state helper');

  sim.setBuildingEnabled(a.id, false);
  assert.equal(sim.batteryCapacity(), POD_BATTERY_KWH + 200, 'a switched-off bank holds nothing');

  sim.setBuildingEnabled(a.id, true);
  sim.devSetBuildingHealth(b.id, DAMAGED_HEALTH - 5); // below the trip threshold
  assert.ok(sim.buildingById(b.id)!.damaged, 'precondition: the bank is tripped');
  assert.equal(sim.batteryCapacity(), POD_BATTERY_KWH + 200, 'a damaged bank holds nothing');

  sim.devSetBuildingHealth(b.id, 80);
  assert.equal(sim.batteryCapacity(), POD_BATTERY_KWH + 400, 'repairs restore the capacity');
});

test('a night deficit drains the pack; a noon surplus refills it — exact arithmetic', () => {
  const sim = new Simulation({ seed: 64 });
  const ext = buildOnline(sim, 'extractor');
  sim.devSetTime(0, 0.95); // midnight — the RTG is the only plant on the grid
  sim.state.dustTransmission = 1;
  const rec = recordingCtx(() => 1); // the extractor wants to run flat out

  // RTG 14 kW vs tier-0 life support 2 kW + tier-1 extractor 18 kW:
  // a 6 kW deficit the pack must cover for one tick.
  sim.state.storedKWh = 45;
  PowerSystem.tick(sim.state, rec.ctx);
  assert.ok(
    Math.abs(sim.state.storedKWh - (45 - 6 * HOURS)) < 1e-9,
    `the pack pays the deficit (${(45 - sim.state.storedKWh).toFixed(6)} kWh spent)`,
  );
  assert.ok(sim.power.batteryFlowKw < 0, 'the battery is discharging');
  assert.equal(sim.power.brownout, false, 'covered by battery is not a brownout');

  // Noon with an array: 14 + 28 kW against the same 20 kW of demand.
  const panel = buildOnline(sim, 'solar');
  sim.devSetBuildingCleanliness(panel.id, 1);
  sim.devSetTime(0, 0.5);
  sim.state.dustTransmission = 1;
  const before = sim.state.storedKWh;
  PowerSystem.tick(sim.state, rec.ctx);
  assert.ok(
    Math.abs(sim.state.storedKWh - (before + 22 * HOURS)) < 1e-9,
    `the pack banks the surplus (${(sim.state.storedKWh - before).toFixed(6)} kWh gained)`,
  );
  assert.ok(sim.power.batteryFlowKw > 0, 'the battery is charging');
  assert.equal(sim.buildingById(ext.id)!.throughput, 1, 'the process never noticed');
});

group('PowerSystem.tick — demand, tiers and shortages');

test('a night shortage sheds charging first, thins tier 1, never life support', () => {
  const sim = new Simulation({ seed: 65 });
  buildOnline(sim, 'warehouse');
  buildOnline(sim, 'extractor');
  buildOnline(sim, 'oxygenator');
  buildOnline(sim, 'garage');
  sim.devSetTime(0, 0.95); // midnight
  sim.state.dustTransmission = 1;
  sim.state.storedKWh = 0; // flat pack: only the RTG's 14 kW exist

  const rover = sim.rovers[0];
  rover.phase = 'charging';
  rover.battery = 5; // parked at the pod, begging for charge

  const rec = recordingCtx((kind) => (BUILDINGS[kind as keyof typeof BUILDINGS].process ? 1 : 0));
  PowerSystem.tick(sim.state, rec.ctx);

  // Demand: 2 (tier 0) + 18 + 12 (tier 1) + 0.4 + 0.8 (tier 2) + 16 (tier 3).
  const p = sim.power;
  assert.equal(p.tierSatisfaction[0], 1, 'life support is sacred');
  assert.ok(
    Math.abs(p.tierSatisfaction[1] - 12 / 30) < 1e-9,
    `tier 1 takes the partial hit (got ${p.tierSatisfaction[1].toFixed(4)})`,
  );
  assert.equal(p.tierSatisfaction[2], 0, 'tier 2 is shed entirely');
  assert.equal(p.tierSatisfaction[3], 0, 'rover charging is first against the wall');
  assert.equal(p.firstShedTier, 1);
  assert.ok(p.brownout, 'a shedding grid is a brownout');
  assert.equal(p.storedKWh, 0, 'a flat pack stays flat');
  assert.ok(Math.abs(p.demandKw - 49.2) < 1e-9, `total demand (got ${p.demandKw.toFixed(2)} kW)`);

  const ext = sim.buildings.find((b) => b.kind === 'extractor')!;
  const oxy = sim.buildings.find((b) => b.kind === 'oxygenator')!;
  assert.ok(Math.abs(ext.powerSat - 0.4) < 1e-9, 'the extractor sees the tier fraction');
  assert.ok(Math.abs(ext.throughput - 0.4) < 1e-9, 'throughput is want × satisfaction');
  assert.ok(Math.abs(oxy.powerSat - 0.4) < 1e-9);
  assert.equal(rover.chargeSat, 0, 'the rover is told it got nothing');
  assert.equal(rover.battery, 5, 'no charge flows to a shed tier');

  // Production ran at the satisfied fraction — the dependency the seam exists for.
  assert.deepEqual(
    rec.runs.map((r) => r.kind).sort(),
    ['extractor', 'oxygenator'],
    'both processes were invited to run',
  );
  assert.ok(rec.runs.every((r) => Math.abs(r.throughput - 0.4) < 1e-9), 'at the shed fraction');
  assert.ok(rec.runs.every((r) => Math.abs(r.hours - HOURS) < 1e-12), 'for one tick of hours');
});

test('two extractors short of power degrade evenly, not arbitrarily', () => {
  const sim = new Simulation({ seed: 66 });
  const a = buildOnline(sim, 'extractor');
  const b = buildOnline(sim, 'extractor');
  sim.devSetTime(0, 0.95); // midnight, flat pack: 12 kW reach tier 1
  sim.state.dustTransmission = 1;
  sim.state.storedKWh = 0;

  PowerSystem.tick(sim.state, recordingCtx(() => 1).ctx);

  const sa = sim.buildingById(a.id)!.powerSat;
  const sb = sim.buildingById(b.id)!.powerSat;
  assert.ok(Math.abs(sa - 1 / 3) < 1e-9, `36 kW of want, 12 kW of supply (got ${sa.toFixed(4)})`);
  assert.ok(Math.abs(sa - sb) < 1e-12, 'even within the tier');
  assert.equal(sim.buildingById(a.id)!.throughput, sim.buildingById(b.id)!.throughput);
});

group('PowerSystem.tick — rover charging');

test('a rover on the pod charger draws tier-3 power and tops its pack up', () => {
  const sim = new Simulation({ seed: 67 });
  buildOnline(sim, 'solar');
  sim.devSetTime(0, 0.5); // noon: surplus, so charging is fully served
  sim.state.dustTransmission = 1;
  const rover = sim.rovers[0];
  rover.phase = 'charging';
  rover.battery = 5;

  PowerSystem.tick(sim.state, idleCtx());

  assert.equal(sim.power.tierDemand[3], ROVER_CHARGE_RATE_KW, 'the pod charger rate');
  assert.equal(rover.chargeSat, 1, 'surplus noon serves the lowest tier too');
  assert.ok(
    Math.abs(rover.battery - (5 + ROVER_CHARGE_RATE_KW * HOURS)) < 1e-9,
    `the pack gains rate × hours (got ${rover.battery.toFixed(6)} kWh)`,
  );
  assert.equal(sim.power.brownout, false);
});

test('garage bays fast-charge; the charge map is distance-honest', () => {
  const sim = new Simulation({ seed: 68 });
  const garage = buildOnline(sim, 'garage');
  const state = sim.state;

  assert.equal(PowerSystem.chargeRateKwAt(state, garage.x, garage.z), GARAGE_CHARGE_RATE_KW);
  assert.equal(PowerSystem.chargeRateKwAt(state, 300, 300), ROVER_CHARGE_RATE_KW, 'base rate in the open');
  assert.equal(PowerSystem.nearCharger(state, garage.x, garage.z), true, 'the bay is a charger');
  assert.equal(PowerSystem.nearCharger(state, 300, 300), false, 'the open desert is not');
  assert.equal(PowerSystem.nearCharger(state, 0, 0), true, 'the landing pod is a charger');

  const rover = sim.rovers[0];
  rover.x = garage.x;
  rover.z = garage.z;
  rover.phase = 'charging';
  rover.battery = 5;
  sim.devSetTime(0, 0.5);
  sim.state.dustTransmission = 1;
  PowerSystem.tick(sim.state, idleCtx());

  assert.equal(sim.power.tierDemand[3], GARAGE_CHARGE_RATE_KW, 'the garage rate wins inside the bay');
  assert.ok(
    Math.abs(rover.battery - (5 + GARAGE_CHARGE_RATE_KW * HOURS)) < 1e-9,
    'fast-charge moves rate × hours of energy',
  );
});

group('PowerSystem.tick — the production context seam');

test('want scales the load; runProcess gets want × satisfaction; block reasons only when power is fine', () => {
  const sim = new Simulation({ seed: 69 });
  const panel = buildOnline(sim, 'solar');
  buildOnline(sim, 'extractor');
  sim.devSetBuildingCleanliness(panel.id, 1);
  const ext = sim.buildings.find((b) => b.kind === 'extractor')!;

  // (a) A process that wants 60% under surplus: load follows, process runs at 0.6.
  sim.devSetTime(0, 0.5);
  sim.state.dustTransmission = 1;
  const rec = recordingCtx((kind) => (kind === 'extractor' ? 0.6 : 0));
  PowerSystem.tick(sim.state, rec.ctx);
  assert.ok(Math.abs(ext.loadKw - (1.5 + 16.5 * 0.6)) < 1e-9, `load = idle + draw × want (got ${ext.loadKw.toFixed(3)} kW)`);
  assert.equal(rec.runs.length, 1, 'the process ran once');
  assert.ok(Math.abs(rec.runs[0].throughput - 0.6) < 1e-9, 'at the wanted fraction');
  assert.equal(ext.idleReason, '', 'a running process has nothing to confess');

  // (b) A process that wants nothing: idle draw only, and the *domain* reason shows.
  const rec2 = recordingCtx(() => 0);
  PowerSystem.tick(sim.state, rec2.ctx);
  assert.ok(Math.abs(ext.loadKw - 1.5) < 1e-9, 'idle draw only');
  assert.equal(rec2.runs.length, 0, 'no run for a process that wants nothing');
  assert.deepEqual(rec2.blocks, ['extractor'], 'the block reason came from the context');
  assert.equal(ext.idleReason, 'Out of inputs');

  // (c) A process that wants to run under a full shed: "No power", and the
  // domain is NOT asked why — power is the reason. Three habitats wanting
  // everything push tier 0 past the RTG, so tier 1 is left with nothing.
  buildOnline(sim, 'habitat');
  buildOnline(sim, 'habitat');
  buildOnline(sim, 'habitat');
  sim.devSetTime(0, 0.95);
  sim.state.dustTransmission = 1;
  sim.state.storedKWh = 0;
  const rec3 = recordingCtx((kind) => (kind === 'extractor' || kind === 'habitat' ? 1 : 0));
  PowerSystem.tick(sim.state, rec3.ctx);
  assert.equal(ext.powerSat, 0, 'tier 1 got nothing');
  assert.equal(ext.throughput, 0);
  assert.equal(rec3.runs.length, 0, 'a shed process does not run');
  assert.equal(ext.idleReason, 'No power', 'power speaks first');
  assert.deepEqual(rec3.blocks, [], 'the domain is not consulted during a brownout');
  assert.ok(sim.power.tierSatisfaction[0] < 1, 'precondition: even tier 0 thinned');
});

group('PowerSystem.tick — building availability');

test('offline, damaged and disabled buildings draw nothing and say why', () => {
  const sim = new Simulation({ seed: 70 });
  const panel = buildOnline(sim, 'solar');
  const ext = buildOnline(sim, 'extractor');
  const wantOn = recordingCtx((kind) => (kind === 'extractor' ? 1 : 0));
  sim.devSetTime(0, 0.5);
  sim.state.dustTransmission = 1;
  sim.devSetBuildingCleanliness(panel.id, 1);

  PowerSystem.tick(sim.state, wantOn.ctx);
  const fullDemand = sim.power.demandKw; // 2 life support + 18 extractor
  assert.ok(Math.abs(fullDemand - 20) < 1e-9, `precondition (got ${fullDemand.toFixed(2)} kW)`);
  assert.equal(sim.buildingById(panel.id)!.genKw, 28, 'precondition: the array is live');

  // Switched off: no load, honest reason, no generation either.
  sim.setBuildingEnabled(ext.id, false);
  PowerSystem.tick(sim.state, wantOn.ctx);
  const offExt = sim.buildingById(ext.id)!;
  assert.equal(offExt.loadKw, 0, 'a switched-off building draws nothing');
  assert.equal(offExt.powerSat, 1, 'powerSat is not a health report');
  assert.equal(offExt.idleReason, 'Switched off');
  assert.ok(Math.abs(sim.power.demandKw - POD_LIFE_SUPPORT_KW) < 1e-9, 'the load left the grid');

  sim.setBuildingEnabled(ext.id, true);
  PowerSystem.tick(sim.state, wantOn.ctx);
  assert.ok(Math.abs(sim.power.demandKw - fullDemand) < 1e-9, 're-enabled, the load returns');

  // Damaged: same shape, different reason — and the array trips offline too.
  sim.devSetBuildingDamaged(ext.id, true);
  sim.devSetBuildingDamaged(panel.id, true);
  PowerSystem.tick(sim.state, wantOn.ctx);
  assert.equal(sim.buildingById(ext.id)!.idleReason, 'Damaged — needs repair');
  assert.equal(sim.buildingById(ext.id)!.loadKw, 0);
  assert.equal(sim.buildingById(panel.id)!.genKw, 0, 'a tripped array generates nothing');
  assert.equal(sim.power.generationKw, POD_POWER_KW, 'only the RTG remains');

  // Disabled generation: an array switched off makes nothing.
  sim.devSetBuildingDamaged(panel.id, false);
  sim.setBuildingEnabled(panel.id, false);
  PowerSystem.tick(sim.state, wantOn.ctx);
  assert.equal(sim.buildingById(panel.id)!.genKw, 0, 'a switched-off array generates nothing');
  sim.setBuildingEnabled(panel.id, true);
  PowerSystem.tick(sim.state, wantOn.ctx);
  assert.equal(sim.buildingById(panel.id)!.genKw, 28, 'back on the sky');

  // Under construction: not part of the grid at all.
  const spot = findSpot(sim, 'oxygenator');
  const site = sim.placeBuilding('oxygenator', spot.x, spot.z)!;
  assert.notEqual(site.state, 'online');
  PowerSystem.tick(sim.state, wantOn.ctx);
  assert.equal(site.loadKw, 0, 'a construction site draws nothing');
  assert.equal(site.powerSat, 1, 'and is not reported as starved');
});

group('PowerSystem — lifecycle');

test('restore clamps the saved pack to the capacity the buildings actually provide', () => {
  const sim = new Simulation({ seed: 71 });
  buildOnline(sim, 'battery'); // capacity 90 + 200 = 290
  const state = sim.state;

  PowerSystem.restore(state, 5000);
  assert.equal(state.storedKWh, 290, 'a save from a bigger colony clamps down');
  assert.equal(state.power.capacityKWh, 290);
  assert.equal(state.power.demandKw, 0, 'an idle result is parked until the next tick');
  assert.equal(state.power.brownout, false);
  assert.equal(state.power.storedKWh, 290);

  PowerSystem.restore(state, -3);
  assert.equal(state.storedKWh, 0, 'negative saves clamp to zero');

  PowerSystem.restore(state, undefined);
  assert.equal(state.storedKWh, 0, 'a missing field means an empty pack');

  PowerSystem.restore(state, 12.5);
  assert.equal(state.storedKWh, 12.5, 'an in-range value survives verbatim');
});

test('a save/restore round trip preserves the pack through the real wiring', () => {
  const sim = new Simulation({ seed: 72 });
  buildOnline(sim, 'solar');
  buildOnline(sim, 'battery');
  sim.devSetTime(0, 0.45);
  sim.state.storedKWh = 123.5;
  run(sim, 0.05); // let the grid resolve at least one real tick

  const copy = new Simulation({ seed: 99 });
  copy.restore(structuredClone(sim.snapshot()));
  assert.ok(Math.abs(copy.storedKWh - sim.storedKWh) < 1e-9, 'the pack survived the round trip');
  assert.equal(copy.batteryCapacity(), sim.batteryCapacity());
  assert.equal(copy.power.capacityKWh, sim.batteryCapacity(), 'the parked result knows the capacity');
});

group('PowerSystem — determinism');

test('same seed, same sky, same grid: two colonies resolve identically', () => {
  const build = (seed: number) => {
    const sim = new Simulation({ seed, nearDeposits: 0.2 });
    buildOnline(sim, 'warehouse');
    buildOnline(sim, 'solar');
    buildOnline(sim, 'battery');
    buildOnline(sim, 'extractor');
    buildOnline(sim, 'oxygenator');
    buildOnline(sim, 'garage');
    sim.devSetRoverBatteryFrac(sim.rovers[0].id, 0.2); // a hungry charger
    sim.rovers[0].phase = 'charging';
    return sim;
  };
  const a = build(73);
  const b = build(73);

  const gridView = (sim: Simulation) => ({
    stored: sim.storedKWh,
    gen: sim.power.generationKw,
    demand: sim.power.demandKw,
    served: sim.power.servedKw,
    flow: sim.power.batteryFlowKw,
    tierSat: { ...sim.power.tierSatisfaction },
    tierDemand: { ...sim.power.tierDemand },
    shed: sim.power.firstShedTier,
    brownout: sim.power.brownout,
    satisfaction: [...sim.power.satisfaction.entries()].sort(([x], [y]) => x - y),
    buildings: sim.buildings.map((x) => ({
      kind: x.kind,
      genKw: x.genKw,
      loadKw: x.loadKw,
      throughput: x.throughput,
      powerSat: x.powerSat,
      idleReason: x.idleReason,
    })),
    rovers: sim.rovers.map((r) => ({ battery: r.battery, chargeSat: r.chargeSat })),
  });

  // Noon with a hungry charger, then a long dark night on the pack.
  for (const sim of [a, b]) sim.devSetTime(1, 0.5);
  run(a, 0.25);
  run(b, 0.25);
  assert.deepEqual(gridView(a), gridView(b), 'noon resolves identically');

  for (const sim of [a, b]) sim.devSetTime(2, 0.95);
  run(a, 0.25);
  run(b, 0.25);
  assert.deepEqual(gridView(a), gridView(b), 'the night shift resolves identically too');
  assert.ok(a.power.demandKw > 0, 'precondition: the grid was actually loaded');
  assert.ok(a.rovers[0].battery > 0.2 * 120, 'precondition: the rover actually charged');
});

await finish('sim/power-system');
