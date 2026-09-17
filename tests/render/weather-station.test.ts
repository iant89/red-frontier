/**
 * @suite render/weather-station
 * @group unit
 * @covers src/render/WeatherStation.ts src/ui/WorldMap.ts src/sim/weather.ts
 * @desc The weather radar station is presentation only: RAXpol dish, green
 * FrontSide radome, vane anemometer and MLI-wrapped hut, all driven from sim
 * time so a paused colony holds still. The claim map plots storm cells at
 * true km→m scale with a predicted track — not 1 m = 1 km.
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  MLI_GOLD,
  MLI_WHITE,
  RADOME_COLOR,
  RADOME_SIDE,
  buildWeatherStation,
  cupSpinRad,
  raxpolAzimuth,
  raxpolElevation,
  stationLedPulse,
  syncWeatherStation,
  vaneYaw,
} from '../../src/render/WeatherStation';
import {
  STORM_KM_TO_M,
  STORM_TRACK_LOOKAHEAD_S,
  drawStormOverlay,
  stormCellsForMap,
  stormOverlayKey,
  stormTrackPoints,
  stormWorldCentre,
  stormWorldRadius,
} from '../../src/ui/WorldMap';
import { Weather } from '../../src/sim/weather';
import { WORLD_HALF } from '../../src/sim/config';
import { group, test, finish } from '../harness';

group('Radome contract');

test('the green is the HUD / world-map radar accent, FrontSide only', () => {
  assert.equal(RADOME_COLOR, 0x6fd3b4);
  assert.equal(RADOME_SIDE, THREE.FrontSide);
  assert.equal(RADOME_SIDE, 0, 'FrontSide is backface-cull: opaque outside, see-through inside');
});

test('the built radome keeps that contract on the material', () => {
  const root = buildWeatherStation(1);
  const radome = root.getObjectByName('radome') as THREE.Mesh;
  assert.ok(radome, 'the sphere is named radome');
  const mat = radome.material as THREE.MeshStandardMaterial;
  assert.equal(mat.side, RADOME_SIDE);
  assert.equal(mat.color.getHex(), RADOME_COLOR);
});

group('Anemometer and RAXpol motion');

test('cups spin with wind and freeze when the wind (or the clock) does', () => {
  assert.equal(cupSpinRad(10, 0), 0);
  assert.equal(cupSpinRad(0, 40), 0);
  assert.ok(cupSpinRad(10, 20) > cupSpinRad(10, 5), 'a gale outruns a breeze');
  assert.equal(cupSpinRad(4, 12), cupSpinRad(4, 12), 'paused time freezes the cups');
  assert.ok(Number.isFinite(cupSpinRad(NaN, 10)));
  assert.equal(cupSpinRad(5, NaN), 0);
});

test('the vane points the way the wind blows', () => {
  assert.equal(vaneYaw(0.7), 0.7);
  assert.equal(vaneYaw(0), 0);
  assert.equal(vaneYaw(NaN), 0);
});

test('the dish slews on sim time while powered and parks when it is not', () => {
  assert.equal(raxpolAzimuth(10, false), 0);
  assert.ok(raxpolAzimuth(10, true) > 0);
  assert.equal(raxpolAzimuth(7.5, true), raxpolAzimuth(7.5, true));
  assert.notEqual(raxpolAzimuth(7.5, true), raxpolAzimuth(8.1, true));
  const rest = raxpolElevation(0, false);
  assert.ok(rest > 0 && rest < 1, 'a parked dish still looks up a little');
  assert.equal(raxpolElevation(3, false), rest);
  assert.notEqual(raxpolElevation(3, true), raxpolElevation(6, true));
});

test('status LEDs are a 0..1 envelope on sim time, dark most of the cycle', () => {
  for (let t = -4; t < 40; t += 0.017) {
    const p = stationLedPulse(t, 0);
    assert.ok(p === 0 || p === 1, `LED envelope must be a strobe, got ${p} at t=${t}`);
  }
  assert.equal(stationLedPulse(1.1, 0), stationLedPulse(1.1, 0));
  assert.equal(stationLedPulse(NaN), 0);
  let lit = 0;
  const N = 1400;
  for (let i = 0; i < N; i++) if (stationLedPulse((i / N) * 14, 0) > 0) lit++;
  const frac = lit / N;
  assert.ok(frac > 0.1 && frac < 0.4, `a blink, not a lamp: lit ${frac.toFixed(2)} of the time`);
});

test('sync writes those angles onto the named parts', () => {
  const root = buildWeatherStation(2);
  const t = 12.4;
  const wind = 18;
  const dir = 1.15;
  syncWeatherStation(root, { time: t, powered: true, windSpeed: wind, windDirRad: dir });
  assert.equal(root.getObjectByName('radarDish')!.rotation.y, raxpolAzimuth(t, true));
  assert.equal(root.getObjectByName('raxpolElev')!.rotation.x, raxpolElevation(t, true));
  assert.equal(root.getObjectByName('anemometerCups')!.rotation.y, cupSpinRad(t, wind));
  assert.equal(root.getObjectByName('windVane')!.rotation.y, dir);

  syncWeatherStation(root, { time: t, powered: false, windSpeed: wind, windDirRad: dir });
  assert.equal(root.getObjectByName('radarDish')!.rotation.y, 0, 'unpowered dish parks');
});

test('the moving parts and lamps are named so the renderer can find them', () => {
  const root = buildWeatherStation(3);
  for (const name of [
    'radarDish',
    'radome',
    'raxpolElev',
    'anemometerCups',
    'windVane',
    'ledPower',
    'ledScan',
    'ledFault',
    'ledBeacon',
  ]) {
    assert.ok(root.getObjectByName(name), `missing ${name}`);
  }
});

group('MLI wrap');

test('the blankets are NASA white and gold, not the radome green', () => {
  assert.equal(MLI_WHITE, 0xf3efe4);
  assert.equal(MLI_GOLD, 0xc4a35a);
  assert.notEqual(MLI_WHITE, RADOME_COLOR);
});

group('Storm overlay — true km scale');

test('one kilometre of storm is a thousand world metres, not one', () => {
  assert.equal(STORM_KM_TO_M, 1000);
  const c = stormWorldCentre({ xKm: 2, zKm: -0.5 });
  assert.equal(c.x, 2000);
  assert.equal(c.z, -500);
  assert.equal(stormWorldRadius({ radiusKm: 6.5 }), 6500);
  // A regional cell (90 km) swallows the 1.28 km claim — that is the point.
  assert.ok(stormWorldRadius({ radiusKm: 90 }) > WORLD_HALF * 2);
});

test('the predicted track is heading × speed × remaining, in metres', () => {
  // Heading 0 = north (+Z). 0.01 km/s for 100 s → 1 km north = 1000 m.
  const north = stormTrackPoints(
    { xKm: 0, zKm: 0, heading: 0, speedKmS: 0.01, remainingS: 100 },
    100,
    4,
  );
  assert.equal(north[0].x, 0);
  assert.equal(north[0].z, 0);
  assert.ok(Math.abs(north[north.length - 1].x) < 1e-9);
  assert.ok(Math.abs(north[north.length - 1].z - 1000) < 1e-6);

  // Heading π/2 = east (+X).
  const east = stormTrackPoints(
    { xKm: 1, zKm: 2, heading: Math.PI / 2, speedKmS: 0.02, remainingS: 50 },
    50,
    2,
  );
  assert.ok(Math.abs(east[east.length - 1].x - (1 + 0.02 * 50) * 1000) < 1e-6);
  assert.ok(Math.abs(east[east.length - 1].z - 2000) < 1e-6);
});

test('the track horizon is min(remaining, lookahead) and ignores junk numbers', () => {
  const short = stormTrackPoints(
    { xKm: 0, zKm: 0, heading: 0, speedKmS: 1, remainingS: 10 },
    STORM_TRACK_LOOKAHEAD_S,
    1,
  );
  assert.ok(Math.abs(short[1].z - 10 * 1000) < 1e-6, 'remaining shorter than lookahead wins');
  const paused = stormTrackPoints(
    { xKm: 3, zKm: -1, heading: 0.4, speedKmS: 0.05, remainingS: 40 },
    40,
    8,
  );
  const again = stormTrackPoints(
    { xKm: 3, zKm: -1, heading: 0.4, speedKmS: 0.05, remainingS: 40 },
    40,
    8,
  );
  assert.deepEqual(paused, again, 'a paused colony freezes the forecast track');
  const dead = stormTrackPoints(
    { xKm: NaN, zKm: NaN, heading: NaN, speedKmS: NaN, remainingS: NaN },
    30,
    2,
  );
  for (const p of dead) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), 'never hand NaN to the canvas');
  }
});

test('a live radar is the authority; without one, current and threat still plot', () => {
  const wx = new Weather(9);
  wx.setRadar(520, true);
  wx.debugScheduleStorm('devil', 0, 80);
  wx.tick(1 / 20, 1 / 20, 5);
  const radar = stormCellsForMap(wx);
  assert.ok(radar.length > 0, 'a scheduled devil is on the dish');
  assert.equal(radar[0].kind, 'devil');
  assert.ok(radar[0].speedKmS > 0);
  assert.ok(radar[0].remainingS > 0);

  wx.setRadar(0, false);
  const fallback = stormCellsForMap(wx);
  assert.ok(fallback.length > 0, 'without a dish the inbound threat still draws');
  assert.ok(stormOverlayKey(wx).length > 0);
  assert.notEqual(stormOverlayKey(wx), '', 'the minimap key notices the cell');
});

test('drawStormOverlay is a no-op on an empty sky and never throws without a backend', () => {
  const calls: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        calls.push(String(prop));
        return () => {};
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  drawStormOverlay(ctx, 160, 160, { scale: 0.1, offsetX: 80, offsetY: 80 }, 640, []);
  assert.equal(calls.length, 0, 'an empty sky must not touch the canvas');

  const wx = new Weather(11);
  wx.setRadar(520, true);
  wx.debugScheduleStorm('regional', 0, 40);
  wx.tick(1 / 20, 1 / 20, 5);
  const cells = stormCellsForMap(wx);
  drawStormOverlay(ctx, 160, 160, { scale: 0.1, offsetX: 80, offsetY: 80 }, 640, cells);
  assert.ok(calls.includes('save') && calls.includes('clip') && calls.includes('restore'));
  assert.ok(calls.includes('arc'), 'the footprint is a clipped fill');
});

await finish('render/weather-station');
