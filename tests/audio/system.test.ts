/**
 * @suite audio/system
 * @group unit
 * @covers src/audio/AudioSystem.ts src/sim/host/protocol.ts
 * @desc The presentation audio routing: exhaustive command cues and ambient mix
 * rules, including the promise that pausing never silences Mars.
 */

import assert from 'node:assert/strict';
import { COMMAND_TYPES } from '../../src/sim/host/protocol';
import { AudioSystem, audioMix, cueForCommand } from '../../src/audio/AudioSystem';
import { group, test, finish } from '../harness';

const calmGame = {
  scene: 'game' as const,
  paused: false,
  windSpeed: 9,
  dust: 0.08,
  stormIntensity: 0,
  activeRovers: 2,
  onlineBuildings: 4,
};

group('Command feedback');

test('every host command has an audible cue', () => {
  for (const type of COMMAND_TYPES) {
    assert.ok(cueForCommand(type), `${type} needs an audio cue`);
  }
});

test('missing browser audio support is a safe no-op', () => {
  const audio = new AudioSystem();
  audio.activateFromUserGesture();
  audio.command('rover/move');
  audio.dispose();
});

group('Continuous ambience');

test('the main menu owns an ambient bed before a colony launches', () => {
  const mix = audioMix({ ...calmGame, scene: 'menu', paused: false });
  assert.ok(mix.menuAtmosphere > 0, 'menu should not be silent');
  assert.equal(mix.worldAtmosphere, 0);
  assert.equal(mix.machinery, 0);
});

test('pausing drops machinery but preserves the Mars ambient and wind', () => {
  const running = audioMix(calmGame);
  const paused = audioMix({ ...calmGame, paused: true });
  assert.ok(paused.worldAtmosphere > 0, 'a paused colony must retain ambience');
  assert.equal(paused.machinery, 0, 'time-bound machinery should fade while paused');
  assert.equal(paused.wind, running.wind, 'the frozen weather remains audible');
});

test('stronger wind and a storm raise their dedicated environmental layers', () => {
  const breeze = audioMix({ ...calmGame, windSpeed: 7, dust: 0.05, stormIntensity: 0 });
  const storm = audioMix({ ...calmGame, windSpeed: 52, dust: 0.9, stormIntensity: 0.88 });
  assert.ok(storm.wind > breeze.wind, 'storm wind should be louder than a breeze');
  assert.ok(storm.storm > 0, 'storm grit needs its own mix layer');
});

await finish('audio/system');
