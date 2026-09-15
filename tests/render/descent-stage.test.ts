/**
 * @suite render/descent-stage
 * @group unit
 * @covers src/render/DescentStage.ts
 * @desc The landed descent stage at the centre of the pad: the tripod stance,
 * and the reentry burn that still stands on its flank. Pure math, extracted
 * from the module so it can be checked without a GPU context — the same trick
 * `render/selection` uses for the pulse curve.
 */

import assert from 'node:assert/strict';
import {
  BURN,
  STAGE,
  STAGE_HEIGHT,
  beaconBlink,
  burnProfile,
  emberFlicker,
  emberLightIntensity,
  legFoot,
  legSplayRad,
} from '../../src/render/DescentStage';
import { group, test, finish } from '../harness';

group('Tripod stance');

test('three legs, evenly spaced, is what makes it a tripod', () => {
  assert.equal(STAGE.legAzimuthsDeg.length, 3, 'a tripod has three legs');
  const gaps = STAGE.legAzimuthsDeg.map((az, i) => {
    const next = STAGE.legAzimuthsDeg[(i + 1) % STAGE.legAzimuthsDeg.length];
    return ((next - az) % 360 + 360) % 360;
  });
  for (const g of gaps) assert.ok(Math.abs(g - 120) < 1e-9, `legs must be 120° apart, got ${g}`);
});

test('every foot stands the same distance off the centreline', () => {
  for (const az of STAGE.legAzimuthsDeg) {
    const f = legFoot(az, STAGE.legReach);
    const r = Math.hypot(f.x, f.z);
    assert.ok(
      Math.abs(r - STAGE.legReach) < 1e-9,
      `foot at ${az}° is ${r} m out, expected ${STAGE.legReach}`,
    );
  }
});

test('feet clear the tank — the legs splay outward, not into the hull', () => {
  for (const az of STAGE.legAzimuthsDeg) {
    const f = legFoot(az, STAGE.legReach);
    assert.ok(
      Math.hypot(f.x, f.z) > STAGE.hullRadius + 1,
      `foot at ${az}° lands inside the tank`,
    );
  }
});

test('splay is atan(reach/drop) — the whole stance in one angle', () => {
  assert.ok(Math.abs(legSplayRad(0, 12) - 0) < 1e-12, 'a vertical strut does not splay');
  assert.ok(Math.abs(legSplayRad(12, 12) - Math.PI / 4) < 1e-12, '45° when reach = drop');
  const real = legSplayRad(STAGE.legReach, STAGE.hipHeight);
  assert.ok(real > 0.2 && real < 0.6, `deployed stance should read as splayed, got ${real} rad`);
  assert.ok(
    Math.abs(real - Math.atan2(STAGE.legReach, STAGE.hipHeight)) < 1e-12,
    'splay must equal atan(reach/drop)',
  );
});

test('a degenerate strut reports vertical rather than NaN', () => {
  assert.ok(Number.isFinite(legSplayRad(0, 0)), 'never hand a NaN rotation to three.js');
  assert.equal(legSplayRad(0, 0), Math.PI / 2);
});

test('the legs miss the rovers\' spawn points', () => {
  // Simulation.ts parks the starting rovers at (±9, 0) and (−9, +4), inside the
  // pod's exclusion radius. Legs landing on a rover would be a first-frame bug.
  const spawns: Array<[number, number]> = [
    [9, 0],
    [-9, 4],
  ];
  for (const az of STAGE.legAzimuthsDeg) {
    const f = legFoot(az, STAGE.legReach);
    for (const [sx, sz] of spawns) {
      const d = Math.hypot(f.x - sx, f.z - sz);
      assert.ok(d > 3.0, `leg at ${az}° sits ${d.toFixed(2)} m from a rover at (${sx}, ${sz})`);
    }
  }
});

test('the stage stands taller than anything the colony can build', () => {
  assert.ok(STAGE_HEIGHT > 40, `a descent stage should dominate the base: ${STAGE_HEIGHT} m`);
  assert.ok(STAGE_HEIGHT < 90, `…but not so tall it leaves the frame: ${STAGE_HEIGHT} m`);
  // A 14 m visual footprint inside the sim's 8 m pod radius is the trade the
  // module header describes; this pins the number the header quotes.
  assert.ok(STAGE.legReach + 1.7 < 14, 'footprint must stay inside the pad clear zone');
});

group('Reentry burn');

test('char is deepest at the engine deck and gone by the soot line', () => {
  const bottom = burnProfile(0);
  const top = burnProfile(1);
  assert.ok(bottom.soot > 0.8, `the deck should be fully charred: ${bottom.soot}`);
  assert.equal(top.soot, 0, 'clean metal above the burn');
  assert.ok(bottom.soot > burnProfile(0.25).soot, 'soot thins as it climbs');
});

test('heat never outruns the char — a cooled stage stays black, not bright', () => {
  assert.ok(BURN.glowTop < BURN.sootTop, 'the glow band must sit inside the soot band');
  let lastGlow = Infinity;
  let lastSoot = Infinity;
  for (let h = 0; h <= 1; h += 0.01) {
    const p = burnProfile(h);
    assert.ok(p.soot >= 0 && p.soot <= 1, `soot out of range at h=${h.toFixed(2)}`);
    assert.ok(p.glow >= 0 && p.glow <= 1, `glow out of range at h=${h.toFixed(2)}`);
    // Containment, not magnitude: the two terms are different units (char is a
    // multiplier on the hull's shading, heat is emission), so what matters is
    // that glowing metal is always charred metal — never a bright streak above
    // a clean one.
    if (p.glow > 0) assert.ok(p.soot > 0, `glowing but uncharred at h=${h.toFixed(2)}`);
    assert.ok(p.soot <= lastSoot + 1e-12, `soot climbs at h=${h.toFixed(2)}`);
    assert.ok(p.glow <= lastGlow + 1e-12, `heat climbs at h=${h.toFixed(2)}`);
    lastSoot = p.soot;
    lastGlow = p.glow;
  }
  assert.equal(burnProfile(BURN.glowTop).glow, 0, 'the heat stops at its own line');
  assert.ok(burnProfile(BURN.glowTop).soot > 0, '…and the char carries on above it');
});

test('the profile is finite for nonsense heights', () => {
  for (const h of [-3, -0.0001, 1.0001, 40, NaN, Infinity]) {
    const p = burnProfile(h);
    assert.ok(Number.isFinite(p.soot) && Number.isFinite(p.glow), `non-finite burn at h=${h}`);
    assert.ok(p.soot >= 0 && p.soot <= 1 && p.glow >= 0 && p.glow <= 1, `out of range at h=${h}`);
  }
});

group('Ember');

test('the flicker stays inside 0..1 over a long night', () => {
  let min = Infinity;
  let max = -Infinity;
  for (let t = 0; t < 600; t += 0.037) {
    const e = emberFlicker(t);
    assert.ok(e >= 0 && e <= 1, `flicker out of range at t=${t}: ${e}`);
    min = Math.min(min, e);
    max = Math.max(max, e);
  }
  assert.ok(max - min > 0.3, `a heat shimmer should visibly move: ${min}..${max}`);
});

test('it is keyed to sim time, so a paused colony freezes the heat', () => {
  const paused = 137.5;
  assert.equal(emberFlicker(paused), emberFlicker(paused));
  assert.notEqual(emberFlicker(paused), emberFlicker(paused + 0.4));
});

test('residual heat is a light source at night and only a colour at noon', () => {
  const ember = 0.8;
  const night = emberLightIntensity(ember, 0);
  const noon = emberLightIntensity(ember, 1);
  assert.ok(night > noon * 4, `night ${night} should dwarf noon ${noon}`);
  assert.ok(noon > 0, 'the ember still reads a little in daylight');
  assert.equal(emberLightIntensity(0, 0), 0, 'no heat, no light');
  for (const d of [-1, 0, 0.4, 1, 2, NaN]) {
    assert.ok(Number.isFinite(emberLightIntensity(0.5, d)), `non-finite intensity at day=${d}`);
  }
});

group('Nav beacon');

test('it blinks on a 2.2 s cycle and is dark most of the time', () => {
  assert.ok(beaconBlink(0) < 1e-9, 'starts dark');
  assert.ok(beaconBlink(0.27) > 0.9, 'lit mid-window');
  assert.ok(beaconBlink(1.4) === 0, 'dark between blinks');
  let lit = 0;
  const N = 2200;
  for (let i = 0; i < N; i++) if (beaconBlink((i / N) * 22) > 0.01) lit++;
  const frac = lit / N;
  assert.ok(frac > 0.15 && frac < 0.4, `a strobe, not a lamp: lit ${frac.toFixed(2)} of the time`);
});

test('the blink never goes negative or above 1', () => {
  for (let t = -7; t < 60; t += 0.011) {
    const b = beaconBlink(t);
    assert.ok(b >= 0 && b <= 1, `beacon out of range at t=${t}: ${b}`);
  }
});

await finish('render/descent-stage');
