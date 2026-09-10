/**
 * @suite hud/weather
 * @group hud
 * @covers src/ui/HUD.ts src/sim/weather.ts
 * @desc The weather block: dust, visibility, wind, and the storm badge.
 */

import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { group, test, finish } from '../harness';

const { doc, hud, sim } = await mountHud();

group('Weather');

test('the weather panel reflects the sim state', () => {
  sim.weather.dust = 0.5;
  sim.weather.visibility = 0.4;
  sim.weather.windSpeed = 33;
  hud.updateVitals(sim);
  assert.match(doc.getElementById('wx-wind')!.textContent!, /33 m\/s/);
  assert.equal(doc.getElementById('wx-dust-bar')!.style.width, '50%');
  assert.equal(doc.getElementById('wx-vis-bar')!.style.width, '40%');
  assert.match(doc.getElementById('wx-status')!.textContent!, /sunlight through the dust/);
  assert.match(doc.getElementById('wx-badge')!.textContent!, /Clear/);
});

test('an active storm names itself in the badge and status line', () => {
  const wx: any = sim.weather;
  wx.debugScheduleStorm('regional', sim.simTime, 0);
  for (let i = 0; i < 20 * 20; i++) sim.step(1 / 20); // 20 s: storm ramped up
  hud.updateVitals(sim);
  assert.match(doc.getElementById('wx-badge')!.textContent!, /Regional dust storm/);
  assert.match(doc.getElementById('wx-status')!.textContent!, /overhead — clearing in/);
  // clean up so later tests run in calm weather
  wx.debugClearStorms();
  wx.dust = 0.08;
});

test('an approaching storm reports its distance and bearing', () => {
  const wx: any = sim.weather;
  // A long forecast lead keeps the system well over the horizon.
  wx.debugScheduleStorm('severe', sim.simTime, 200);
  wx.tick(1 / 20, sim.simTime + 1 / 20, sim.clock.sol);
  hud.updateVitals(sim);
  assert.match(
    doc.getElementById('wx-status')!.textContent!,
    /km (N|NE|E|SE|S|SW|W|NW)/,
    'the forecast should give a real range and compass bearing',
  );
  wx.debugClearStorms();
  wx.dust = 0.08;
});

await finish('hud/weather');
