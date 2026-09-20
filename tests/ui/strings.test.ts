/**
 * @suite ui/strings
 * @group unit
 * @covers src/ui/strings.ts
 * @desc Phase 1 strings externalization — ensure copy is centralized and formatters work.
 */

import assert from 'node:assert/strict';
import { STRINGS, getString, formatKg, formatKm, formatPct, formatSols } from '../../src/ui/strings';
import { group, test, finish } from '../harness';

group('Strings externalization');

test('all keys are present', () => {
  assert.ok(STRINGS['tutorial.welcome']);
  assert.ok(STRINGS['warning.waterEmpty']);
  assert.ok(STRINGS['project.establishSurvival.title']);
  assert.ok(STRINGS['dashboard.title']);
  assert.ok(STRINGS['bottleneck.water.title']);
  assert.ok(STRINGS['autonomy.rung.autonomous']);
  assert.ok(STRINGS['poi.unknown.title']);
  assert.ok(STRINGS['rover.history.distance']);
  assert.ok(STRINGS['report.title']);
});

test('function strings format correctly', () => {
  const waterEmpty = STRINGS['warning.waterEmpty'] as (sols: string) => string;
  const msg = waterEmpty('1.8 sols');
  assert.match(msg, /1\.8 sols/);
  assert.match(msg, /water/i);

  const autonomy = STRINGS['autonomy.streak'] as (sols: string) => string;
  assert.equal(autonomy('6.8 sols'), 'Autonomy 6.8 sols');
});

test('getString returns value or key', () => {
  const v = getString('dashboard.title');
  assert.equal(v, 'Red Frontier Operations');
});

test('format helpers', () => {
  assert.equal(formatKg(500), '500 kg');
  assert.equal(formatKg(1500), '1.5 t');
  assert.equal(formatKm(500), '500 m');
  assert.equal(formatKm(2700), '2.7 km');
  assert.equal(formatPct(0.84), '84%');
  assert.equal(formatSols(1.8), '1.8 sols');
  assert.equal(formatSols(Infinity), '∞');
});

test('tutorial philosophy preserved — situation warning not click-here', () => {
  // The roadmap says tutorial should be situation-driven, not "Click here" chain
  // Ensure our strings contain situation copy, not click instructions
  const welcome = STRINGS['tutorial.welcome'] as string;
  assert.ok(!welcome.toLowerCase().includes('click here'), 'welcome should not be click-here');
  const waterEmpty = (STRINGS['warning.waterEmpty'] as Function)('1.8 sols') as string;
  assert.match(waterEmpty, /will run dry/, 'water warning should be situation-driven per roadmap');
});

await finish('ui/strings');
