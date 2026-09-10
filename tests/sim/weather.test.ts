/**
 * @suite sim/weather
 * @group unit
 * @covers src/sim/weather.ts src/sim/clock.ts
 * @desc The weather model on its own: dust against transmission and visibility, the
 * forecast envelope, and the seeded streams that give two colonies the same sky.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { Weather } from '../../src/sim/weather';
import { SOL_SECONDS } from '../../src/sim/config';
import { run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

group('Weather model');

test('clear-sky transmission is near 1 and falls as dust fills the air', () => {
  const wx = new Weather(7);
  const clear = new Weather(7);
  // Run both through calm weather.
  for (let i = 0; i < 20 * 60; i++) wx.tick(1 / 20, i / 20, 3);
  assert.ok(wx.solarTransmission > 0.9, `calm sol should transmit most light, got ${wx.solarTransmission.toFixed(2)}`);
  assert.ok(wx.visibility > 0.8, 'calm sol should be clearly visible');

  // Crank the dust up manually and watch the reading degrade.
  clear.dust = 0.8;
  // transmission recomputes on tick
  clear.tick(1 / 20, 0, 3);
  assert.ok(clear.solarTransmission < 0.6, 'heavy dust must cut solar transmission hard');
  assert.ok(clear.visibility < 0.25, 'heavy dust must kill visibility');
});

test('a storm is forecast before it arrives and follows its forecast schedule', () => {
  const sim = new Simulation({ seed: 5 });
  const t0 = sim.simTime;
  sim.weather.debugScheduleStorm('regional', t0, 60);
  // Mid-forecast: announced, but not yet blowing.
  sim.step(1 / 20);
  assert.ok(sim.weather.forecast(), 'the storm should be on the forecast board');
  assert.ok(sim.alerts.isActive('storm-inbound'), 'forecast should raise an alert');
  assert.equal(sim.weather.stormIntensity, 0, 'no wind before arrival');

  run(sim, 60 / SOL_SECONDS + 0.1);
  assert.ok(!sim.weather.forecast(), 'forecast clears on arrival');
  assert.ok(sim.weather.current(), 'the storm should now be active');
  assert.ok(sim.weather.stormIntensity > 0, 'winds picked up');
  // The envelope is finite: the storm fully passes.
  run(sim, 350 / SOL_SECONDS);
  assert.ok(!sim.weather.current(), 'the storm should pass');
  assert.equal(sim.weather.stormIntensity, 0);
});

test('weather is deterministic for a given seed', () => {
  const a = new Simulation({ seed: 31 });
  const b = new Simulation({ seed: 31 });
  a.weather.debugScheduleStorm('regional', 10, 5);
  b.weather.debugScheduleStorm('regional', 10, 5);
  // Sixty game seconds carries the forced cell through travel and arrival;
  // further sols repeat the same seeded tick contract.
  run(a, 0.25);
  run(b, 0.25);
  assert.ok(a.weather.current(), 'precondition: the forced storm must arrive during the run');
  assert.ok(a.weather.stormIntensity > 0, 'precondition: deterministic comparison must include live weather');
  assert.equal(
    JSON.stringify(a.weather.snapshot()),
    JSON.stringify(b.weather.snapshot()),
    'weather diverged between identical runs',
  );
});

group('Storms travel (spatial weather)');

test('a storm is a place on the map, and that place closes in', () => {
  const wx = new Weather(9);
  wx.debugScheduleStorm('regional', 0, 120);
  wx.tick(1 / 20, 1 / 20, 5);
  const far = wx.threat();
  assert.ok(far, 'a scheduled storm reports as an approaching system');
  assert.ok(far!.distKm > far!.radiusKm, `still over the horizon (${Math.round(far!.distKm)} km)`);
  // The system rides across the planet: half a minute later it is nearer.
  for (let i = 0; i < 30 * 20; i++) wx.tick(1 / 20, (i + 2) / 20, 5);
  const nearer = wx.threat();
  assert.ok(nearer, 'still approaching');
  assert.ok(
    nearer!.distKm < far!.distKm,
    `the front advanced (${Math.round(far!.distKm)} km → ${Math.round(nearer!.distKm)} km)`,
  );
  assert.ok(
    Number.isFinite(nearer!.bearingRad) && Number.isFinite(nearer!.arrivesIn),
    'bearing and ETA are readable',
  );
});

test('a storm arrives, sits over the colony, then moves on', () => {
  const wx = new Weather(11);
  wx.debugScheduleStorm('regional', 0, 0);
  assert.equal(wx.current(), null, 'nothing overhead before the first tick');
  // Ride the envelope: mid-storm the system is plainly overhead.
  for (let i = 0; i < 150 * 20; i++) wx.tick(1 / 20, (i + 1) / 20, 5);
  assert.ok(wx.current(), 'mid-storm: the system is over the site');
  assert.ok(wx.stormIntensity > 0.3, `and it is blowing (${wx.stormIntensity.toFixed(2)})`);
  const during = wx.storm;
  assert.notEqual(during, 'calm');
  // Past the envelope the system has blown through — the sky is the colony's again.
  for (let i = 0; i < 400 * 20; i++) wx.tick(1 / 20, 150 + (i + 1) / 20, 5);
  assert.equal(wx.current(), null, 'the system has passed');
  assert.equal(wx.stormIntensity, 0);
  assert.equal(wx.storm, 'calm');
});

test('wind blows along the storm track while it crosses the site', () => {
  const wx = new Weather(13);
  wx.debugScheduleStorm('severe', 0, 0);
  for (let i = 0; i < 100 * 20; i++) wx.tick(1 / 20, (i + 1) / 20, 5);
  const cell = wx.current();
  assert.ok(cell, 'mid-storm');
  // Within a sol of drift the reading stays near the system's heading.
  const angDiff = (a: number, b: number): number => {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  };
  assert.ok(
    angDiff(wx.windDirRad, cell!.heading) < 0.7,
    `wind follows the front (${wx.windDirRad.toFixed(2)} vs heading ${cell!.heading.toFixed(2)})`,
  );
  assert.ok(wx.windSpeed > 25, `a severe front carries real wind (${wx.windSpeed.toFixed(1)} m/s)`);
});

test('a snapshot captures the travelling systems and a restore keeps them moving', () => {
  const wx = new Weather(17);
  wx.debugScheduleStorm('regional', 0, 0);
  for (let i = 0; i < 60 * 20; i++) wx.tick(1 / 20, (i + 1) / 20, 5);
  const snap = wx.snapshot() as any;
  assert.ok(Array.isArray(snap.active) && snap.active.length > 0, 'cells are part of the save');
  assert.ok(Number.isFinite(snap.active[0].x) && Number.isFinite(snap.active[0].z), 'with positions');

  const wx2 = new Weather(17);
  wx2.restore(snap);
  wx2.time = wx.time;
  wx2.tick(1 / 20, wx.time + 1 / 20, 5);
  wx.tick(1 / 20, wx.time + 1 / 20, 5);
  assert.equal(
    wx2.stormIntensity.toFixed(4),
    wx.stormIntensity.toFixed(4),
    'the restored storm blows exactly like the original',
  );
});

test('legacy saves (time-only storms) restore as a system already overhead', () => {
  const wx = new Weather(19);
  wx.restore({
    active: {
      kind: 'regional',
      startAt: 0,
      endAt: 275,
      peak: 0.72,
      rampFrac: 0.24,
      dustPeak: 0.62,
      windPeak: 34,
      announced: true,
    },
    dust: 0.3,
    nextRollAt: 9999,
    lastStormEndAt: 275,
    rngState: 123,
  });
  wx.time = 100;
  wx.tick(1 / 20, 100 + 1 / 20, 5);
  assert.ok(wx.current(), 'the upgraded storm is overhead');
  assert.ok(wx.stormIntensity > 0.3, 'with its old envelope intact');
});

await finish('sim/weather');
