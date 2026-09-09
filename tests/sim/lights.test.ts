/**
 * @suite sim/lights
 * @group integration
 * @covers src/sim/Simulation.ts src/sim/defs.ts src/sim/config.ts
 * @desc Rover position lights: they come on at night and in blowing dust, they bill
 * the rover's battery while lit, the switch can turn them off, and a stranded
 * rover keeps flashing its reserve-powered strobe without drawing anything.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import type { Rover } from '../../src/sim/Simulation';
import { ROVERS } from '../../src/sim/defs';
import {
  HOURS_PER_SEC,
  LIGHTS_AUTO_IRRADIANCE,
  LIGHTS_AUTO_VISIBILITY,
} from '../../src/sim/config';
import { run } from '../fixtures/sim';
import { group, test, finish } from '../harness';

/** Step the sim for `seconds` of game time at the fixed tick. */
function stepSeconds(sim: Simulation, seconds: number): void {
  const ticks = Math.round(seconds * 20);
  for (let i = 0; i < ticks; i++) sim.step(1 / 20);
}

/** Park the rover deep in the field, idle, fully manual — lights are the only drain. */
function isolate(sim: Simulation, r: Rover): void {
  r.x = 200;
  r.z = 150;
  r.y = sim.world.heightAt(r.x, r.z);
  r.battery = ROVERS[r.kind].maxBatteryKWh * 0.9;
  r.rules.autoHaul = false;
  r.rules.autoService = false;
  r.rules.autoRescue = false;
  r.rules.stormShelter = false;
  sim.stopRover(r.id);
  assert.ok(!sim.nearCharger(r.x, r.z), 'precondition: far from any charger');
}

/** Put the authoritative sun somewhere on the sol (recomputes SunState). */
function setSolFrac(sim: Simulation, frac: number): void {
  sim.clock.frac = frac;
  sim.clock.advance(0);
}

group('When the lights come on');

test('a clear midday keeps the lights off', () => {
  const sim = new Simulation({ seed: 21, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  setSolFrac(sim, 0.5); // local noon
  const r = sim.rovers[0];
  isolate(sim, r);
  assert.ok(sim.clock.sun.irradiance > LIGHTS_AUTO_IRRADIANCE, 'precondition: bright sun');

  stepSeconds(sim, 2);
  assert.equal(r.lightsActive, false, 'no lights at noon in clear air');
});

test('night switches the lights on', () => {
  const sim = new Simulation({ seed: 21, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  const r = sim.rovers[0];
  isolate(sim, r);
  setSolFrac(sim, 0.9); // deep night
  assert.equal(sim.clock.sun.irradiance, 0, 'precondition: the sun is down');

  stepSeconds(sim, 2);
  assert.equal(r.lightsActive, true, 'the switch is armed, so the dark lights them');
});

test('blowing dust lights them even at noon', () => {
  const sim = new Simulation({ seed: 21, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  const r = sim.rovers[0];
  isolate(sim, r);
  setSolFrac(sim, 0.5);

  // A severe storm already at peak blows its dust in while the sun is high.
  sim.weather.debugScheduleStorm('severe', sim.simTime - 120);
  for (let i = 0; i < 1200 && sim.weather.visibility >= LIGHTS_AUTO_VISIBILITY; i++) {
    sim.step(1 / 20);
  }
  assert.ok(sim.weather.visibility < LIGHTS_AUTO_VISIBILITY, 'precondition: visibility lost');
  assert.equal(r.lightsActive, true, 'daylight or not — the haze needs lights');
});

test('the switch off means running dark, even at night', () => {
  const sim = new Simulation({ seed: 21, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  const r = sim.rovers[0];
  isolate(sim, r);
  sim.setRoverLights(r.id, false);
  setSolFrac(sim, 0.9);

  stepSeconds(sim, 2);
  assert.equal(r.lightsActive, false, 'the player switch wins over the dark');
});

group('The battery pays for the lights');

test('lit lights draw lightsPowerKw off the rover battery', () => {
  const sim = new Simulation({ seed: 33, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  const r = sim.rovers[0];
  isolate(sim, r);
  setSolFrac(sim, 0.9);
  stepSeconds(sim, 1);
  assert.equal(r.lightsActive, true, 'precondition: lit');

  const before = r.battery;
  const seconds = 10;
  stepSeconds(sim, seconds);
  const drained = before - r.battery;
  const expected = ROVERS[r.kind].lightsPowerKw * HOURS_PER_SEC * seconds;
  assert.ok(
    Math.abs(drained - expected) < 1e-9,
    `lights should cost ${expected.toFixed(4)} kWh over ${seconds} s, cost ${drained.toFixed(4)}`,
  );
});

test('switched-off lights cost nothing extra at night', () => {
  const lit = new Simulation({ seed: 33, nearDeposits: 0.2 });
  const dark = new Simulation({ seed: 33, nearDeposits: 0.2 });
  for (const s of [lit, dark]) s.weather.debugSuppressRolls();
  isolate(lit, lit.rovers[0]);
  isolate(dark, dark.rovers[0]);
  dark.setRoverLights(dark.rovers[0].id, false);
  setSolFrac(lit, 0.9);
  setSolFrac(dark, 0.9);

  stepSeconds(lit, 12);
  stepSeconds(dark, 12);
  assert.equal(lit.rovers[0].lightsActive, true);
  assert.equal(dark.rovers[0].lightsActive, false);

  const diff = dark.rovers[0].battery - lit.rovers[0].battery;
  const expected = ROVERS[lit.rovers[0].kind].lightsPowerKw * HOURS_PER_SEC * 12;
  assert.ok(
    Math.abs(diff - expected) < 1e-9,
    `the lit rover should have spent exactly the lights load (${expected.toFixed(4)} kWh), spent ${diff.toFixed(4)}`,
  );
});

test('a day spent in the sun costs the lights nothing', () => {
  const lit = new Simulation({ seed: 33, nearDeposits: 0.2 });
  const dark = new Simulation({ seed: 33, nearDeposits: 0.2 });
  for (const s of [lit, dark]) s.weather.debugSuppressRolls();
  isolate(lit, lit.rovers[0]);
  isolate(dark, dark.rovers[0]);
  dark.setRoverLights(dark.rovers[0].id, false);
  setSolFrac(lit, 0.5);
  setSolFrac(dark, 0.5);

  stepSeconds(lit, 12);
  stepSeconds(dark, 12);
  assert.equal(lit.rovers[0].lightsActive, false);
  assert.equal(
    lit.rovers[0].battery,
    dark.rovers[0].battery,
    'idle daytime rovers should not spend anything on lights',
  );
});

test('lights can drink a parked rover flat — and then the yellow strobe takes over', () => {
  const sim = new Simulation({ seed: 33, nearDeposits: 0.2 });
  sim.weather.debugSuppressRolls();
  const r = sim.rovers[0];
  isolate(sim, r);
  // Nearly flat already: a long lit night finishes the job.
  r.battery = 0.02;
  setSolFrac(sim, 0.9);

  for (let i = 0; i < 400 && r.phase !== 'disabled'; i++) sim.step(1 / 20);
  assert.equal(r.phase, 'disabled', 'the lights drained the last of it');
  assert.equal(r.lightsActive, false, 'nothing left to power the headlights');
  const at = r.battery;
  run(sim, 0.05);
  assert.equal(r.battery, at, 'a stranded rover draws nothing more');
  assert.equal(r.phase, 'disabled', '…and stays stranded (renderer flashes the yellow strobe)');
});

group('The switch & saves');

test('setRoverLights flips the switch and announces it', () => {
  const sim = new Simulation({ seed: 33, nearDeposits: 0.2 });
  const r = sim.rovers[0];
  assert.equal(r.lightsOn, true, 'rovers leave the factory armed');
  sim.setRoverLights(r.id, false);
  assert.equal(r.lightsOn, false);
  sim.setRoverLights(r.id, true);
  assert.equal(r.lightsOn, true);
  const lines = sim.alerts.history().map((e) => e.text);
  assert.ok(lines.some((t) => /lights switched off/.test(t)), 'switching off is logged');
  assert.ok(lines.some((t) => /lights armed/.test(t)), 'switching on is logged');
});

test('the lights switch survives a save / restore round-trip', () => {
  const sim = new Simulation({ seed: 33, nearDeposits: 0.2 });
  sim.setRoverLights(sim.rovers[0].id, false);
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  const copy = new Simulation({ seed: 1 });
  copy.restore(snap);
  assert.equal(copy.rovers[0].lightsOn, false, 'switched-off survives');
  assert.equal(copy.rovers[1].lightsOn, true, 'armed stays armed');
  assert.equal(
    JSON.stringify(copy.snapshot()),
    JSON.stringify(sim.snapshot()),
    'the round-trip is exact',
  );
});

test('a v4 save migrates: rovers gain an armed lights switch', () => {
  const sim = new Simulation({ seed: 33, nearDeposits: 0.2 });
  const snap = JSON.parse(JSON.stringify(sim.snapshot())) as any;
  snap.version = 4;
  for (const r of snap.rovers) delete r.lightsOn;
  const copy = new Simulation({ seed: 1 });
  copy.restore(snap);
  assert.equal(copy.rovers[0].lightsOn, true, 'pre-lights rovers default to armed');
});

await finish('sim/lights');
