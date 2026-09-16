/**
 * @suite sim/weather-system
 * @group unit
 * @covers src/sim/systems/WeatherSystem.ts src/sim/weather.ts src/sim/state/WeatherState.ts
 * @desc WeatherSystem extraction (Phase 5): the system tick's storm lifecycle
 * (creation, expiry), progression into colony state, colony effects (panel
 * dust, wind damage, lightning via the host-hooks seam), the dedicated RNG
 * streams, restore wiring, and deterministic replay.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { Weather } from '../../src/sim/weather';
import { WeatherSystem } from '../../src/sim/systems/WeatherSystem';
import { createWeatherState } from '../../src/sim/state/WeatherState';
import { hashSimulation } from '../../src/sim/debug/StateHash';
import { DIFFICULTIES } from '../../src/sim/difficulty';
import {
  SOL_SECONDS,
  CLEANLINESS_FLOOR,
  DAMAGED_HEALTH,
} from '../../src/sim/config';
import { run, buildOnline } from '../fixtures/sim';
import { group, test, finish } from '../harness';

/** Snapshot JSON with the lightning stream stripped (it may legitimately diverge). */
function schedulerView(wx: Weather): string {
  const s = wx.snapshot() as Record<string, unknown>;
  return JSON.stringify({ ...s, lightningRngState: undefined });
}

group('WeatherSystem.tick — progression');

test('dustTransmission mirrors the weather transmission every tick', () => {
  const sim = new Simulation({ seed: 21 });
  sim.weather.debugSuppressRolls();
  for (let i = 0; i < 40; i++) {
    sim.step(1 / 20);
    assert.equal(sim.state.dustTransmission, sim.weather.solarTransmission, `tick ${i}`);
  }
  // A dusty storm pushes the mirrored value down hard.
  const calm = sim.state.dustTransmission;
  sim.weather.debugScheduleStorm('severe', sim.simTime, 0);
  run(sim, 120 / SOL_SECONDS);
  assert.ok(sim.weather.stormIntensity > 0.4, 'precondition: the storm must be blowing');
  assert.ok(sim.state.dustTransmission < calm, 'storm dust must cut transmission');
  assert.equal(sim.state.dustTransmission, sim.weather.solarTransmission, 'still mirrored');
});

test('storm creation: forecast alert, then the arrival announcement', () => {
  const sim = new Simulation({ seed: 5 });
  sim.weather.debugSuppressRolls();
  sim.weather.debugScheduleStorm('regional', sim.simTime, 60);

  sim.step(1 / 20);
  assert.ok(sim.weather.forecast(), 'the storm should be on the forecast board');
  assert.ok(sim.alerts.isActive('storm-inbound'), 'forecast should raise the inbound alert');
  assert.equal(sim.state.stormAnnounced, false, 'not announced before arrival');

  run(sim, 80 / SOL_SECONDS);
  assert.ok(!sim.weather.forecast(), 'forecast clears on arrival');
  assert.ok(sim.weather.current(), 'the storm is on site');
  assert.equal(sim.state.stormAnnounced, true, 'arrival is announced');
  assert.ok(!sim.alerts.isActive('storm-inbound'), 'inbound alert clears on arrival');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('on site')),
    'the arrival is logged',
  );
});

test('storm expiration: the passing announcement fires and the flag resets', () => {
  const sim = new Simulation({ seed: 6 });
  sim.weather.debugSuppressRolls();
  sim.weather.debugScheduleStorm('regional', sim.simTime, 0);
  run(sim, 120 / SOL_SECONDS);
  assert.ok(sim.weather.current(), 'precondition: storm in progress');
  assert.equal(sim.state.stormAnnounced, true);

  run(sim, 400 / SOL_SECONDS); // regional lasts 220–330 s
  assert.ok(!sim.weather.current(), 'the storm has fully passed');
  assert.equal(sim.weather.stormIntensity, 0);
  assert.equal(sim.state.stormAnnounced, false, 'passing resets the flag');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('storm has passed')),
    'the passing is logged',
  );
  assert.ok(!sim.weather.forecast(), 'no new storm while rolls are suppressed');
});

group('WeatherSystem.tick — colony effects');

test('dust settles on the panels where they stand, clamped at the floor', () => {
  const sim = new Simulation({ seed: 13 });
  const panel = buildOnline(sim, 'solar');
  sim.weather.debugSuppressRolls();
  const clean0 = panel.cleanliness;
  assert.ok(clean0 > 0.9, 'a fresh array is nearly clean');

  sim.weather.debugScheduleStorm('regional', sim.simTime, 0);
  run(sim, 170 / SOL_SECONDS);
  assert.ok(panel.cleanliness < 0.9, `a storm must dirty the array (${panel.cleanliness.toFixed(2)})`);

  // The floor is a hard clamp: an almost-buried array stops exactly there.
  panel.cleanliness = CLEANLINESS_FLOOR + 0.01;
  run(sim, 20 / SOL_SECONDS);
  assert.ok(panel.cleanliness >= CLEANLINESS_FLOOR - 1e-9, 'never below the floor');
  assert.ok(
    Math.abs(panel.cleanliness - CLEANLINESS_FLOOR) < 1e-6 || panel.cleanliness > CLEANLINESS_FLOOR + 0.01,
    `settles toward the floor (got ${panel.cleanliness.toFixed(4)})`,
  );
});

test('wind damage chews exposed structures and trips them offline', () => {
  const sim = new Simulation({ seed: 17 });
  const panel = buildOnline(sim, 'solar');
  sim.weather.debugSuppressRolls();
  sim.weather.lightningMul = 0; // isolate wind damage from bolts

  sim.weather.debugScheduleStorm('severe', sim.simTime, 0);
  run(sim, 240 / SOL_SECONDS); // ~1 sol: peak intensity, ~0.34 health/s
  assert.ok(sim.weather.stormIntensity > 0.25, 'precondition: bruising winds');
  assert.ok(panel.health < 100, `the array must take damage (${panel.health.toFixed(1)})`);
  assert.ok(panel.damaged, 'crossing the threshold trips the structure offline');
  assert.ok(panel.health <= DAMAGED_HEALTH, 'tripped only at or below the threshold');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('damaged by the storm')),
    'the trip is logged through the host hooks',
  );
});

test('an exact bolt lands on the most exposed anchor and hits it hard', () => {
  const sim = new Simulation({ seed: 23 });
  const panel = buildOnline(sim, 'solar'); // exposure 1.0 × vulnerability 1.9
  sim.weather.debugSuppressRolls();
  sim.devSetBuildingHealth(panel.id, 40); // one 30.4-damage bolt will trip it

  sim.devForceLightningStrike();
  const strike = sim.weather.lastStrike;
  assert.ok(strike, 'the strike is recorded for the renderer');
  assert.equal(strike!.x, panel.x, 'exact aim lands on the anchor x');
  assert.equal(strike!.z, panel.z, 'exact aim lands on the anchor z');
  assert.ok(panel.health < 40, `the bolt damages the structure (${panel.health.toFixed(1)})`);
  assert.ok(panel.damaged, 'the damage crosses the trip threshold');
  assert.ok(
    sim.alerts.history().some((e) => e.text.includes('damaged by lightning')),
    'the lightning trip is logged with its cause',
  );
});

test('the hooks seam: trip, disable and mission end cross the boundary once each', () => {
  // --- tripDamaged: driven directly against a recording hooks object, no
  // Simulation in between — the system works against the contract alone.
  const sim = new Simulation({ seed: 29 });
  const panel = buildOnline(sim, 'solar');
  sim.weather.debugSuppressRolls();
  sim.weather.lightningMul = 0;
  sim.weather.debugScheduleStorm('severe', sim.simTime, 0);
  run(sim, 100 / SOL_SECONDS); // storm at peak, panel still healthy
  assert.ok(sim.weather.stormIntensity > 0.4, 'precondition: the storm is blowing');

  sim.devSetBuildingHealth(panel.id, 28); // a few ticks of wind from the threshold
  const trips: Array<{ id: number; cause?: string }> = [];
  const disabled: number[] = [];
  const missions: string[] = [];
  const recorder = {
    tripDamaged: (b: { id: number }, cause?: string) => trips.push({ id: b.id, cause }),
    disableRover: (r: { id: number }) => disabled.push(r.id),
    endMission: (reason: string) => missions.push(reason),
  };
  for (let i = 0; i < 400; i++) WeatherSystem.tick(sim.state, recorder);
  assert.equal(trips.length, 1, 'the threshold is crossed exactly once');
  assert.equal(trips[0].id, panel.id);
  assert.equal(trips[0].cause, undefined, 'wind damage uses the default cause');
  assert.equal(disabled.length, 0);
  assert.equal(missions.length, 0);

  // --- endMission: a colonist on EVA, the only thing standing.
  const sim2 = new Simulation({ seed: 31 });
  sim2.colonist.inside = false; // on EVA at the landing site
  sim2.devSetColonistHealth(10);
  for (const r of sim2.rovers) r.phase = 'disabled'; // nothing taller than the crew
  const missions2: string[] = [];
  WeatherSystem.resolveLightningStrike(sim2.state, {
    tripDamaged: () => {},
    disableRover: () => {},
    endMission: (reason) => missions2.push(reason),
  }, 'exact');
  assert.equal(missions2.length, 1, 'a fatal strike ends the mission');
  assert.ok(missions2[0].includes('struck by lightning'));
  assert.ok(sim2.colonist.dead);

  // --- disableRover: a core hit on a nearly flat pack strands the machine.
  const sim3 = new Simulation({ seed: 32 });
  const anchors = WeatherSystem.lightningAnchors(sim3.state);
  const top = anchors.slice().sort((a, b) => b.w - a.w || a.x - b.x || a.z - b.z)[0];
  const victim = sim3.rovers.find((r) => r.x === top.x && r.z === top.z)!;
  sim3.devSetRoverBatteryFrac(victim.id, 0.05);
  const disabled3: number[] = [];
  WeatherSystem.resolveLightningStrike(sim3.state, {
    tripDamaged: () => {},
    disableRover: (r: { id: number }) => disabled3.push(r.id),
    endMission: () => {},
  }, 'exact');
  assert.ok(disabled3.includes(victim.id), 'the core hit strands the rover');
});

group('WeatherSystem — dedicated RNG streams');

test('the lightning stream never perturbs the storm scheduler stream', () => {
  const a = new Weather(9);
  const b = new Weather(9);
  for (let i = 0; i < 17; i++) a.lightningRoll(); // a storm that strikes 17 times
  a.debugScheduleStorm('regional', 0, 60);
  b.debugScheduleStorm('regional', 0, 60);
  const sa = a.snapshot() as Record<string, unknown>;
  const sb = b.snapshot() as Record<string, unknown>;
  assert.notEqual(sa.lightningRngState, sb.lightningRngState, 'the lightning stream did advance');
  assert.equal(schedulerView(a), schedulerView(b), 'the scheduler draw sequence is untouched');
});

test('colony activity does not touch the weather scheduler stream', () => {
  const bare = new Simulation({ seed: 41 });
  const built = new Simulation({ seed: 41 });
  buildOnline(built, 'solar');
  buildOnline(built, 'solar');
  for (const s of [bare, built]) {
    s.weather.debugSuppressRolls();
    s.weather.debugScheduleStorm('severe', s.simTime, 0);
  }
  run(bare, 200 / SOL_SECONDS);
  run(built, 200 / SOL_SECONDS);
  assert.ok(built.weather.stormIntensity > 0.4, 'precondition: weather is live');
  assert.equal(
    (bare.weather.snapshot() as Record<string, unknown>).rngState,
    (built.weather.snapshot() as Record<string, unknown>).rngState,
    'the scheduler stream is identical with and without a built-up colony',
  );
  assert.equal(schedulerView(bare.weather), schedulerView(built.weather), 'the whole sky is identical');
});

test('createWeatherState: same seed, same streams; difficulty scales only the multipliers', () => {
  const a = createWeatherState(101, 'pioneer');
  const b = createWeatherState(101, 'survivor');
  const streams = (w: Weather) => {
    const s = w.snapshot() as Record<string, unknown>;
    return { rngState: s.rngState, lightningRngState: s.lightningRngState };
  };
  assert.deepEqual(streams(a), streams(b), 'identical seeds give identical RNG streams');
  const pioneer = DIFFICULTIES.pioneer;
  const survivor = DIFFICULTIES.survivor;
  assert.equal(a.frequencyMul, pioneer.stormMul, 'pioneer frequency');
  assert.equal(b.frequencyMul, survivor.stormMul, 'survivor frequency');
  assert.equal(b.damageMul, survivor.damageMul);
  assert.equal(b.lightningMul, survivor.lightningMul);
});

group('WeatherSystem — lifecycle seams');

test('restore rebuilds weather from the colony seed with coherent derived flags', () => {
  const sim = new Simulation({ seed: 51, difficulty: 'pioneer' });
  sim.weather.debugSuppressRolls();
  sim.weather.debugScheduleStorm('regional', sim.simTime, 0);
  run(sim, 120 / SOL_SECONDS);
  assert.ok(sim.weather.current(), 'precondition: storm on site');

  const save = sim.snapshot();
  // `Weather.snapshot()` hands out its live storm-cell references, so a save
  // restored into a second sim in-process must be deep-cloned first or the two
  // weathers alias (the JSON/postMessage paths clone for free). See mnemosyne.
  const twin = new Simulation({ seed: 1 });
  twin.restore(structuredClone(save));
  assert.ok(twin.weather.current(), 'the in-flight storm survives the restore');
  assert.equal(twin.state.stormAnnounced, true, 'the announcement flag is rebuilt');
  assert.equal(twin.state.dustTransmission, twin.weather.solarTransmission, 'transmission re-mirrored');
  assert.equal(
    JSON.stringify((twin.weather.snapshot() as Record<string, unknown>).active),
    JSON.stringify((sim.weather.snapshot() as Record<string, unknown>).active),
    'the storm cells round-trip exactly',
  );

  // A save older than lightningMul falls back to the difficulty's value.
  const legacy = structuredClone(save);
  delete (legacy.weather as { lightningMul?: number }).lightningMul;
  const older = new Simulation({ seed: 2 });
  older.restore(legacy);
  assert.equal(older.weather.lightningMul, DIFFICULTIES.pioneer.lightningMul, 'lightningMul fallback');
});

test('afterTimeJump re-anchors the weather clock so forecasts stay coherent', () => {
  const sim = new Simulation({ seed: 61 });
  sim.weather.debugSuppressRolls();
  const lead = 360; // 1.5 sols of warning
  sim.weather.debugScheduleStorm('regional', sim.simTime, lead);
  sim.step(1 / 20);
  assert.ok(sim.weather.forecast(), 'precondition: storm on the board');
  const startAt = sim.simTime + lead;

  sim.devSetTime(1, 0.25); // jump half a sol forward
  assert.equal(sim.weather.time, sim.simTime, 'the weather clock mirror is re-anchored');
  const fc = sim.weather.forecast()!;
  assert.ok(fc, 'still forecast after the jump');
  const expected = startAt - sim.simTime;
  assert.ok(
    Math.abs(fc.arrivesIn - expected) < 1,
    `countdown follows the jump (${fc.arrivesIn.toFixed(1)} vs ${expected.toFixed(1)})`,
  );
});

group('WeatherSystem — deterministic replay');

test('same seed and weather: identical skies and identical colony hashes', () => {
  const a = new Simulation({ seed: 77 });
  const b = new Simulation({ seed: 77 });
  for (const s of [a, b]) {
    s.weather.debugSuppressRolls();
    s.weather.debugScheduleStorm('regional', s.simTime, 10);
  }
  run(a, 1.5);
  run(b, 1.5);
  for (const s of [a, b]) s.weather.debugScheduleStorm('severe', s.simTime, 5);
  run(a, 1);
  run(b, 1);
  assert.ok(a.weather.stormIntensity > 0 || a.weather.current(), 'precondition: live weather in the window');
  assert.equal(JSON.stringify(a.weather.snapshot()), JSON.stringify(b.weather.snapshot()), 'the sky replayed');
  assert.equal(hashSimulation(a), hashSimulation(b), 'the colony replayed');
  assert.notEqual(hashSimulation(a), hashSimulation(new Simulation({ seed: 78 })), 'hashes are not trivially equal');
});

test('a restored colony lives through the same weather as an uninterrupted one', () => {
  const a = new Simulation({ seed: 88 });
  a.weather.debugSuppressRolls();
  a.weather.debugScheduleStorm('regional', a.simTime, 10);
  run(a, 0.5);

  // Deep-clone: the snapshot's storm cells are live references (see the
  // restore test above) — without the clone both sims would drive one cell.
  const c = new Simulation({ seed: 3 });
  c.restore(structuredClone(a.snapshot()));
  run(a, 0.5);
  run(c, 0.5);
  assert.equal(
    JSON.stringify(a.weather.snapshot()),
    JSON.stringify(c.weather.snapshot()),
    'weather after restore+run equals weather from the uninterrupted run',
  );
});

await finish('sim/weather-system');
