/**
 * @suite render/particles
 * @group unit
 * @covers src/render/particles/ParticlePool.ts src/render/particles/effects.ts src/render/particles/ParticlePoints.ts src/render/WeatherFX.ts src/sim/weather.ts
 * @desc The true particle system, headlessly: pool lifecycle and determinism,
 * wind/storm/devil/trail emitters, and the weather FX controller that drives
 * them from sim readings. No GPU needed — only final rendering needs one.
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mulberry32 } from '../../src/lib/rng';
import { ParticlePool, PKind } from '../../src/render/particles/ParticlePool';
import {
  WindEmitter,
  StormEmitter,
  DustDevil,
  DevilManager,
  RoverTrailEmitter,
  MAX_DEVILS,
  devilBand,
  dustField,
  FIELD_MIN,
  FIELD_MAX,
  type FxContext,
} from '../../src/render/particles/effects';
import { ParticlePoints, makeSoftSprite } from '../../src/render/particles/ParticlePoints';
import { WeatherFX, type WeatherFxInput, type WeatherFxWeather } from '../../src/render/WeatherFX';
import { Weather } from '../../src/sim/weather';
import { group, test, finish } from '../harness';

function makeCtx(over: Partial<FxContext> = {}, seed = 1234): FxContext {
  return {
    time: 0,
    dt: 0.05,
    camX: 0,
    camZ: 0,
    windX: 0,
    windZ: 0,
    windSpeed: 0,
    windRamp: 0,
    dust: 0.08,
    storm: 'calm',
    stormIntensity: 0,
    // A default orbit pose: see the WeatherFX controller group for how the
    // real one is derived from the camera.
    viewRadius: 150,
    heightAt: () => 0,
    rand: mulberry32(seed),
    ...over,
  };
}

/** Step an emitter + pool forward, advancing sim time like the game loop. */
function runEmitter(
  emit: (ctx: FxContext, pool: ParticlePool) => void,
  ctx: FxContext,
  pool: ParticlePool,
  seconds: number,
): void {
  const steps = Math.round(seconds / ctx.dt);
  for (let i = 0; i < steps; i++) {
    ctx.time += ctx.dt;
    emit(ctx, pool);
    pool.update(ctx.dt, ctx.time);
  }
}

function renderArrays(pool: ParticlePool): {
  pos: Float32Array;
  col: Float32Array;
  size: Float32Array;
  alpha: Float32Array;
} {
  return {
    pos: new Float32Array(pool.capacity * 3),
    col: new Float32Array(pool.capacity * 3),
    size: new Float32Array(pool.capacity),
    alpha: new Float32Array(pool.capacity),
  };
}

group('Particle pool');

test('particles live out their life, then die', () => {
  const pool = new ParticlePool(16, mulberry32(1));
  pool.spawn({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1 });
  assert.equal(pool.alive, 1);
  pool.update(0.6, 0.6);
  assert.equal(pool.alive, 1, 'still alive mid-life');
  pool.update(0.6, 1.2);
  assert.equal(pool.alive, 0, 'dead past its life');
});

test('a full pool recycles its oldest slots instead of failing', () => {
  const pool = new ParticlePool(8, mulberry32(2));
  for (let i = 0; i < 10; i++) {
    pool.spawn({ x: i, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 10, size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1 });
  }
  assert.equal(pool.alive, 8, 'capped at capacity, oldest overwritten');
});

test('zero or negative life never spawns', () => {
  const pool = new ParticlePool(8, mulberry32(3));
  pool.spawn({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1 });
  pool.spawn({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: -1, size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1 });
  assert.equal(pool.alive, 0);
});

test('size grows and alpha fades in and out across life', () => {
  const pool = new ParticlePool(4, mulberry32(4));
  pool.spawn({
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 10,
    size0: 1, size1: 3, r: 1, g: 1, b: 1, alpha: 1, fadeIn: 0.2, fadeOut: 0.5,
  });
  const a = renderArrays(pool);
  pool.writeRender(a.pos, a.col, a.size, a.alpha);
  assert.equal(a.size[0], 1, 'birth size');
  assert.equal(a.alpha[0], 0, 'fully faded in at birth');
  pool.update(5, 5);
  pool.writeRender(a.pos, a.col, a.size, a.alpha);
  assert.ok(Math.abs(a.size[0] - 2) < 1e-6, `mid-life size lerps, got ${a.size[0]}`);
  assert.ok(Math.abs(a.alpha[0] - 1) < 1e-6, `mid-life alpha is peak, got ${a.alpha[0]}`);
  pool.update(4.9, 9.9);
  pool.writeRender(a.pos, a.col, a.size, a.alpha);
  assert.ok(a.alpha[0] < 0.05, `nearly gone at death's door, got ${a.alpha[0]}`);
});

test('gravity pulls and drag slows, exactly', () => {
  const pool = new ParticlePool(4, mulberry32(5));
  pool.spawn({ x: 0, y: 0, z: 0, vx: 10, vy: 0, vz: 0, life: 10, size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1, gravity: 10 });
  pool.update(1, 1);
  const v = { x: 0, y: 0, z: 0 };
  pool.meanVelocity(v);
  assert.ok(Math.abs(v.y + 10) < 1e-6, `vy falls by g·dt, got ${v.y}`);
  assert.ok(Math.abs(v.x - 10) < 1e-6, 'no drag, no horizontal loss');

  const draggy = new ParticlePool(4, mulberry32(5));
  draggy.spawn({ x: 0, y: 0, z: 0, vx: 10, vy: 0, vz: 0, life: 10, size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1, drag: 1 });
  draggy.update(0.5, 0.5);
  draggy.meanVelocity(v);
  assert.ok(Math.abs(v.x - 5) < 1e-6, `drag halves it over half a second, got ${v.x}`);
});

test('particles settle on their ground plane instead of sinking', () => {
  const pool = new ParticlePool(4, mulberry32(6));
  pool.spawn({ x: 0, y: 5, z: 0, vx: 0, vy: -50, vz: 0, life: 5, size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1, groundY: 0 });
  pool.update(0.2, 0.2);
  const a = renderArrays(pool);
  const n = pool.writeRender(a.pos, a.col, a.size, a.alpha);
  assert.equal(n, 1);
  assert.equal(a.pos[1], 0, 'clamped to the ground');
});

test('wrapAmbient corrals wind-blown motes but never devil or trail dust', () => {
  const pool = new ParticlePool(8, mulberry32(7));
  const base = { y: 5, z: 0, vx: 0, vy: 0, vz: 0, life: 10, size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1 };
  // A storm mote blown 200 units past the box edge…
  pool.spawn({ ...base, x: 200 });
  // …while a devil swirl and a wheel puff sit just as far out.
  pool.spawn({ ...base, x: 200, kind: PKind.Devil });
  pool.spawn({ ...base, x: 200, kind: PKind.Trail });
  pool.wrapAmbient(0, 0, 75);
  const a = renderArrays(pool);
  const n = pool.writeRender(a.pos, a.col, a.size, a.alpha);
  assert.equal(n, 3);
  const xs = [a.pos[0], a.pos[3], a.pos[6]].sort((p, q) => p - q);
  // 200 wraps into [-75, 75]: 200 + 75 = 275 → 275 mod 150 = 125 → -75 + 125.
  assert.equal(xs[0], 50, `ambient mote wrapped into the box, got ${xs[0]}`);
  assert.equal(xs[1], 200, 'devil dust stays with its vortex');
  assert.equal(xs[2], 200, 'trail dust stays where the wheels threw it');
});

test('a centripetal anchor bends tangential throw into an orbit', () => {
  const drive = (pullK: number): number => {
    const pool = new ParticlePool(4, mulberry32(8));
    pool.spawn({
      x: 5, y: 0, z: 0, vx: 0, vy: 0, vz: 9, life: 3,
      size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1, pullX: 0, pullZ: 0, pullK,
    });
    for (let i = 0; i < 75; i++) pool.update(0.02, 0.02 * (i + 1));
    const a = renderArrays(pool);
    pool.writeRender(a.pos, a.col, a.size, a.alpha);
    return Math.hypot(a.pos[0], a.pos[2]);
  };
  const orbit = drive(4);
  const escape = drive(0);
  assert.ok(orbit < 7, `anchored throw stays near the funnel, got r=${orbit.toFixed(2)}`);
  assert.ok(escape > 12, `unanchored throw flies straight off, got r=${escape.toFixed(2)}`);
});

test('a seeded pool is bit-deterministic', () => {
  const drive = (seed: number): Float32Array => {
    const pool = new ParticlePool(256, mulberry32(seed));
    const ctx = makeCtx({ windX: 6, windZ: -2, windSpeed: 14, dust: 0.5 }, seed);
    const wind = new WindEmitter();
    runEmitter((c, p) => wind.update(c, p), ctx, pool, 3);
    const a = renderArrays(pool);
    pool.writeRender(a.pos, a.col, a.size, a.alpha);
    return a.pos;
  };
  const a = drive(77);
  const b = drive(77);
  const c = drive(78);
  assert.deepEqual([...a], [...b], 'same seed, same bytes');
  assert.notDeepEqual([...a], [...c], 'different seed, different sky');
});

group('Emitters');

test('wind drifts particles downwind', () => {
  const pool = new ParticlePool(2000, mulberry32(11));
  const ctx = makeCtx({ windX: 10, windZ: 0, windSpeed: 22, dust: 0.5 });
  const wind = new WindEmitter();
  runEmitter((c, p) => wind.update(c, p), ctx, pool, 4);
  assert.ok(pool.alive > 100, `a windy sky should be populated, got ${pool.alive}`);
  const v = { x: 0, y: 0, z: 0 };
  pool.meanVelocity(v);
  assert.ok(v.x > 5, `mean drift follows the wind, got vx=${v.x.toFixed(2)}`);
  assert.ok(Math.abs(v.z) < 2, `no crosswind drift, got vz=${v.z.toFixed(2)}`);
});

test('wind emission thickens with dust and wind speed', () => {
  const wind = new WindEmitter();
  const calm = makeCtx({ windSpeed: 5, dust: 0.05 });
  const dusty = makeCtx({ windSpeed: 20, dust: 0.7 });
  assert.ok(wind.rateFor(dusty) > wind.rateFor(calm) * 2, 'dusty wind emits far more');

  const drive = (ctx: FxContext): number => {
    const pool = new ParticlePool(3000, mulberry32(12));
    runEmitter((c, p) => wind.update(c, p), ctx, pool, 3);
    return pool.alive;
  };
  const a = drive(makeCtx({ windX: 2, windZ: 1, windSpeed: 5, dust: 0.05 }));
  const b = drive(makeCtx({ windX: 9, windZ: 4, windSpeed: 20, dust: 0.7 }));
  assert.ok(b > a * 2, `dusty air holds far more motes (${a} vs ${b})`);
});

test('storm grit scales with intensity and vanishes in calm', () => {
  const storm = new StormEmitter();
  assert.equal(storm.rateFor(makeCtx({ stormIntensity: 0 })), 0);
  const half = storm.rateFor(makeCtx({ storm: 'regional', stormIntensity: 0.5, dust: 0.6 }));
  const full = storm.rateFor(makeCtx({ storm: 'severe', stormIntensity: 1, dust: 0.85 }));
  assert.ok(half > 0 && full > half, `grit grows with the storm (${half} → ${full})`);
  const devilSky = storm.rateFor(makeCtx({ storm: 'devil', stormIntensity: 1, dust: 0.85 }));
  assert.ok(devilSky < half, `a dust devil is haze, not a wall (${devilSky} < ${half})`);

  const pool = new ParticlePool(2000, mulberry32(13));
  runEmitter((c, p) => storm.update(c, p), makeCtx({ stormIntensity: 0 }), pool, 2);
  assert.equal(pool.alive, 0, 'calm air emits no storm grit');
});

test('a dust devil spins a rising column', () => {
  const pool = new ParticlePool(2000, mulberry32(14));
  const devil = new DustDevil({ x: 0, z: 0, groundY: 0 }, mulberry32(14));
  const ctx = makeCtx({ windX: 2, windZ: 1, windSpeed: 6, storm: 'devil', stormIntensity: 0.6 });
  runEmitter((c, p) => devil.update(c, p), ctx, pool, 3);
  assert.ok(devil.strength > 0.8, `spun up, strength=${devil.strength.toFixed(2)}`);
  assert.ok(pool.alive > 50, `a visible funnel, got ${pool.alive}`);
  const v = { x: 0, y: 0, z: 0 };
  pool.meanVelocity(v);
  assert.ok(v.y > 2, `the column rises, mean vy=${v.y.toFixed(2)}`);
});

test('the devil funnel holds together instead of blowing apart', () => {
  const pool = new ParticlePool(2000, mulberry32(16));
  const devil = new DustDevil({ x: 0, z: 0, groundY: 0 }, mulberry32(16));
  const ctx = makeCtx({ windX: 2, windZ: 1, windSpeed: 6, storm: 'devil', stormIntensity: 0.6 });
  runEmitter((c, p) => devil.update(c, p), ctx, pool, 3);
  const a = renderArrays(pool);
  const n = pool.writeRender(a.pos, a.col, a.size, a.alpha);
  assert.ok(n > 50, `a visible funnel, got ${n}`);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.hypot(a.pos[i * 3] - devil.x, a.pos[i * 3 + 2] - devil.z);
  }
  const mean = sum / n;
  assert.ok(mean < 18, `the funnel hugs its devil, mean radius=${mean.toFixed(2)}`);
});

test('the devil manager staffs a storm and stands down when it passes', () => {
  const pool = new ParticlePool(4000, mulberry32(15));
  const mgr = new DevilManager();
  runEmitter((c, p) => mgr.update(c, p), makeCtx({ storm: 'calm' }), pool, 1);
  assert.equal(mgr.activeCount, 0, 'clear skies, no devils');
  const stormy = makeCtx({ windX: 3, windZ: 1, windSpeed: 8, storm: 'devil', stormIntensity: 0.7 });
  runEmitter((c, p) => mgr.update(c, p), stormy, pool, 4);
  assert.ok(mgr.activeCount >= 1, 'a devil storm spins devils up');
  runEmitter((c, p) => mgr.update(c, p), makeCtx({ time: stormy.time, storm: 'calm' }), pool, 25);
  assert.equal(mgr.activeCount, 0, 'devils dissipate once the storm passes');
});

test('a planetary dust wall carries no vortices at all', () => {
  const pool = new ParticlePool(4000, mulberry32(151));
  const mgr = new DevilManager();
  runEmitter(
    (c, p) => mgr.update(c, p),
    makeCtx({ windX: 20, windZ: 6, windSpeed: 50, storm: 'planetary', stormIntensity: 1, dust: 0.98 }),
    pool,
    8,
  );
  assert.equal(mgr.activeCount, 0, 'a uniform sheet of dust has no coherent funnels in it');
});

test('a devil is born on the ground and climbs into the air', () => {
  const pool = new ParticlePool(6000, mulberry32(25));
  const devil = new DustDevil({ x: 0, z: 0, groundY: 0 }, mulberry32(25));
  const ctx = makeCtx({ windX: 2, windZ: 1, windSpeed: 6, storm: 'devil', stormIntensity: 0.6 });
  runEmitter((c, p) => devil.update(c, p), ctx, pool, 0.6);
  assert.ok(devil.growth < 0.3, `still young, growth=${devil.growth.toFixed(2)}`);
  const early = renderArrays(pool);
  const nEarly = pool.writeRender(early.pos, early.col, early.size, early.alpha);
  assert.ok(nEarly > 20, 'the birth burst is already throwing dust');
  let maxEarly = 0;
  for (let i = 0; i < nEarly; i++) maxEarly = Math.max(maxEarly, early.pos[i * 3 + 1]);
  assert.ok(
    maxEarly < devil.height * 0.45,
    `a newborn devil hugs the ground (top at ${maxEarly.toFixed(1)} of ${devil.height.toFixed(0)})`,
  );
  runEmitter((c, p) => devil.update(c, p), ctx, pool, 4);
  assert.ok(devil.growth >= 0.99, 'the column reaches full height');
  const late = renderArrays(pool);
  const nLate = pool.writeRender(late.pos, late.col, late.size, late.alpha);
  let maxLate = 0;
  for (let i = 0; i < nLate; i++) maxLate = Math.max(maxLate, late.pos[i * 3 + 1]);
  assert.ok(maxLate > devil.height * 0.55, `a mature devil towers (${maxLate.toFixed(1)} m)`);
});

test('a devil wears the colour of the ground it picks its dust up from', () => {
  const drive = (tint: { r: number; g: number; b: number }): { r: number; g: number; b: number } => {
    const pool = new ParticlePool(6000, mulberry32(26));
    const devil = new DustDevil({ x: 0, z: 0, groundY: 0 }, mulberry32(26));
    const ctx = makeCtx({
      windX: 2, windZ: 1, windSpeed: 6, storm: 'devil', stormIntensity: 0.6,
      groundTint: () => tint,
    });
    runEmitter((c, p) => devil.update(c, p), ctx, pool, 2);
    const a = renderArrays(pool);
    const n = pool.writeRender(a.pos, a.col, a.size, a.alpha);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < n; i++) {
      r += a.col[i * 3]; g += a.col[i * 3 + 1]; b += a.col[i * 3 + 2];
    }
    return { r: r / n, g: g / n, b: b / n };
  };
  const red = drive({ r: 0.9, g: 0.3, b: 0.2 });
  const pale = drive({ r: 0.85, g: 0.8, b: 0.65 });
  assert.ok(red.r > red.g && red.r > red.b, `red ground, red dust (${JSON.stringify(red)})`);
  assert.ok(pale.g > 0.55 && pale.b > 0.45, `pale ground, pale dust (${JSON.stringify(pale)})`);
  assert.ok(
    Math.abs(red.r - pale.r) > 0.02 || Math.abs(red.g - pale.g) > 0.02,
    'different ground, different devil',
  );
});

test('a travelling devil lays down a lingering dust layer along its track', () => {
  const pool = new ParticlePool(8000, mulberry32(27));
  const devil = new DustDevil({ x: 0, z: 0, groundY: 0 }, mulberry32(27));
  const ctx = makeCtx({ windX: 9, windZ: 0, windSpeed: 20, storm: 'devil', stormIntensity: 0.6 });
  runEmitter((c, p) => devil.update(c, p), ctx, pool, 7);
  const moved = devil.x;
  assert.ok(moved > 6, `the devil should have travelled downwind (${moved.toFixed(1)} m)`);
  const a = renderArrays(pool);
  const n = pool.writeRender(a.pos, a.col, a.size, a.alpha);
  let behind = 0;
  for (let i = 0; i < n; i++) {
    const x = a.pos[i * 3];
    const y = a.pos[i * 3 + 1];
    // Settled, slow, ground-hugging dust left in the devil's wake.
    if (y < 1.6 && x < moved - 4 && x > moved - 40) behind++;
  }
  assert.ok(behind > 10, `a visible deposit trail behind the vortex (${behind} motes)`);
});

test('a dying devil winds down — thinner, calmer, gone without a pop', () => {
  const pool = new ParticlePool(8000, mulberry32(28));
  const devil = new DustDevil({ x: 0, z: 0, groundY: 0 }, mulberry32(28));
  const ctx = makeCtx({ windX: 2, windZ: 1, windSpeed: 6, storm: 'devil', stormIntensity: 0.6 });
  runEmitter((c, p) => devil.update(c, p), ctx, pool, 3);
  assert.ok(devil.strength > 0.8, 'spun up first');
  const fullR = devil.radiusScale;

  // The storm drops it; it must decay slowly and shrink as it goes.
  devil.target = 0;
  let spawns = 0;
  const origSpawn = pool.spawn.bind(pool);
  pool.spawn = (o) => {
    spawns++;
    origSpawn(o);
  };
  const countOver = (secs: number): number => {
    const before = spawns;
    runEmitter((c, p) => devil.update(c, p), ctx, pool, secs);
    return spawns - before;
  };
  const firstHalf = countOver(2);
  const secondHalf = countOver(2);
  assert.ok(devil.strength > 0.2, `no instant pop — still blowing (${devil.strength.toFixed(2)})`);
  assert.ok(devil.radiusScale < fullR, `the funnel narrows as it dies (${devil.radiusScale.toFixed(2)})`);
  assert.ok(secondHalf < firstHalf, `emission starves (${firstHalf} → ${secondHalf})`);
  runEmitter((c, p) => devil.update(c, p), ctx, pool, 10);
  assert.ok(devil.dead, 'fully faded out in the end');
});

test('the wobbling top wanders but never leaves the lower half of the vortex', () => {
  const pool = new ParticlePool(8000, mulberry32(29));
  const devil = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 4 }, mulberry32(29));
  const ctx = makeCtx({ windX: 0, windZ: 0, windSpeed: 1, storm: 'devil', stormIntensity: 0.6 });
  // Watch the crown of the funnel for a while; it must stay over the base.
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    ctx.time += 0.05;
    devil.update(ctx, pool);
    const axis = (devil as any).axisAt(1, ctx.time);
    worst = Math.max(worst, Math.hypot(axis.x - devil.x, axis.z - devil.z));
  }
  assert.ok(
    worst <= 4 * 1.7 + 1e-6,
    `the top stays anchored over the footprint (worst lean ${worst.toFixed(2)} m)`,
  );
  assert.ok(worst > 0.5, `and it genuinely wobbles (lean ${worst.toFixed(2)} m)`);
});

test('rover trails ignore parked rovers', () => {
  const pool = new ParticlePool(1000, mulberry32(16));
  const trails = new RoverTrailEmitter();
  const ctx = makeCtx();
  runEmitter(
    (c, p) => trails.update(c, p, [{ id: 1, x: 0, z: 0, heading: 0, speed: 0 }]),
    ctx,
    pool,
    2,
  );
  assert.equal(pool.alive, 0, 'a parked rover kicks up nothing');
});

test('rover trails strengthen with speed', () => {
  const trails = new RoverTrailEmitter();
  assert.equal(trails.rateFor(0), 0);
  assert.ok(trails.rateFor(14) > trails.rateFor(4), 'faster rovers emit faster');

  const drive = (speed: number): number => {
    const pool = new ParticlePool(1000, mulberry32(17));
    const ctx = makeCtx();
    runEmitter((c, p) => trails.update(c, p, [{ id: 1, x: 0, z: 0, heading: 0, speed }]), ctx, pool, 2);
    return pool.alive;
  };
  const slow = drive(4);
  const fast = drive(14);
  assert.ok(fast > slow * 1.5, `full cruise throws far more dust (${slow} vs ${fast})`);
});

test('trail dust spawns behind the rover, at its rear wheels', () => {
  const pool = new ParticlePool(1000, mulberry32(18));
  const trails = new RoverTrailEmitter();
  // Heading 0 faces +Z, so the rooster tail must sit at −Z of the truck.
  trails.update(makeCtx({ dt: 0.3 }), pool, [{ id: 1, x: 10, z: 20, heading: 0, speed: 10 }]);
  assert.ok(pool.alive > 0, 'a moving rover puffs immediately');
  const a = renderArrays(pool);
  const n = pool.writeRender(a.pos, a.col, a.size, a.alpha);
  let mz = 0;
  let mx = 0;
  for (let i = 0; i < n; i++) {
    mx += a.pos[i * 3];
    mz += a.pos[i * 3 + 2];
  }
  mx /= n;
  mz /= n;
  assert.ok(mz < 20 - 0.5 && mz > 20 - 4, `dust trails behind (−Z), mean z=${mz.toFixed(2)}`);
  assert.ok(Math.abs(mx - 10) < 1.5, `centred on the truck, mean x=${mx.toFixed(2)}`);
});

group('Dust devils');

/** Two devils, spun up and standing in contact, ready to meet. */
function contactPair(
  mgr: DevilManager,
  big: DustDevil,
  small: DustDevil,
  gap = 3,
): { ctx: FxContext; pool: ParticlePool } {
  const pool = new ParticlePool(3000, mulberry32(77));
  for (const d of [big, small]) {
    d.strength = 1;
    d.growth = 1;
    d.target = 1;
  }
  small.x = big.x + gap;
  small.z = big.z;
  mgr.devils.push(big, small);
  const ctx = makeCtx({
    storm: 'devil',
    stormIntensity: 0.9,
    windX: 4,
    windZ: 0,
    windSpeed: 10,
  });
  return { ctx, pool };
}

test('devil counts are rolled per storm band, not a fixed ladder', () => {
  // Calm and planetary are the two skies that never carry vortices.
  for (let s = 0; s < 8; s++) {
    assert.equal(new DevilManager().wantedFor(makeCtx({ storm: 'calm' }, s)), 0);
    assert.equal(new DevilManager().wantedFor(makeCtx({ storm: 'planetary', stormIntensity: 1 }, s)), 0);
  }

  const rolled: Record<string, Set<number>> = {};
  for (const [storm, k] of [
    ['devil', 0.8],
    ['regional', 0.95],
    ['severe', 0.95],
  ] as const) {
    const counts = new Set<number>();
    for (let s = 0; s < 24; s++) {
      const want = new DevilManager().wantedFor(makeCtx({ storm, stormIntensity: k }, 1000 + s * 7919));
      const band = devilBand(storm, k)!;
      assert.ok(
        want >= band[0] && want <= band[1],
        `${storm}@${k} rolled ${want}, outside its band [${band[0]}, ${band[1]}]`,
      );
      assert.ok(want <= MAX_DEVILS, `never more than ${MAX_DEVILS} devils (got ${want})`);
      counts.add(want);
    }
    rolled[storm] = counts;
    assert.ok(counts.size > 1, `${storm}@${k} is still a fixed count: ${[...counts].join('/')}`);
  }
  // A big regional front can carry a handful…
  assert.ok(Math.max(...rolled.regional) >= 3, `a big front carries several (${[...rolled.regional]})`);
  // …and a weak one sometimes spins up nothing at all.
  const weak = new Set<number>();
  for (let s = 0; s < 24; s++) {
    weak.add(new DevilManager().wantedFor(makeCtx({ storm: 'regional', stormIntensity: 0.6 }, 31 + s * 104729)));
  }
  assert.ok(weak.has(0), `a weak front sometimes makes none (${[...weak]})`);
  assert.ok(Math.max(...weak) >= 1, `and sometimes still makes one (${[...weak]})`);
});

test('a band holds its roll instead of re-rolling every frame', () => {
  const mgr = new DevilManager();
  const ctx = makeCtx({ storm: 'regional', stormIntensity: 0.95 }, 4242);
  const first = mgr.wantedFor(ctx);
  const band = devilBand('regional', 0.95)!;
  assert.ok(first >= band[0] && first <= band[1], `rolled inside the band (${first})`);

  // Two hundred frames inside one band: the sky must not spawn and kill a
  // devil on alternate frames.
  const held = new Set<number>([first]);
  for (let i = 0; i < 200; i++) {
    ctx.time += 0.05;
    held.add(mgr.wantedFor(ctx));
  }
  assert.equal(held.size, 1, `the storm kept its devils (${[...held].join('/')})`);

  // A band change is held for a moment, then re-rolled once — not per frame.
  ctx.stormIntensity = 0.6;
  assert.equal(mgr.wantedFor(ctx), first, 'the old count holds when the band first changes');
  for (let i = 0; i < 10; i++) {
    ctx.time += 0.05;
    mgr.wantedFor(ctx);
  }
  assert.equal(mgr.wantedFor(ctx), first, 'still holding half a second later');
  for (let i = 0; i < 40; i++) {
    ctx.time += 0.05;
    mgr.wantedFor(ctx);
  }
  const after = mgr.wantedFor(ctx);
  const newBand = devilBand('regional', 0.6)!;
  assert.ok(
    after >= newBand[0] && after <= newBand[1],
    `re-rolled into the new band (${after} vs [${newBand[0]}, ${newBand[1]}])`,
  );
});

test('a sharp wind ramp spins up a devil with no storm declared', () => {
  const pool = new ParticlePool(4000, mulberry32(31));
  const mgr = new DevilManager();
  const ctx = makeCtx({ storm: 'calm', windX: 6, windZ: 0, windSpeed: 12, windRamp: 1.2 }, 5);
  runEmitter((c, p) => mgr.update(c, p), ctx, pool, 1);
  assert.equal(mgr.devils.length, 0, 'one second of gusting is not a front yet');
  runEmitter((c, p) => mgr.update(c, p), ctx, pool, 3);
  assert.ok(mgr.activeCount >= 1, `the front arrives with a devil (${mgr.activeCount})`);

  // A hard but *steady* wind, with no ramp behind it, spins nothing up.
  const steady = new DevilManager();
  runEmitter(
    (c, p) => steady.update(c, p),
    makeCtx({ storm: 'calm', windX: 12, windZ: 4, windSpeed: 40 }, 5),
    pool,
    30,
  );
  assert.equal(steady.devils.length, 0, 'a steady gale makes no devils of its own');
});

test('a wind that keeps rising stays well inside the devil ceiling', () => {
  const mgr = new DevilManager();
  const pool = new ParticlePool(4000, mulberry32(32));
  // Ramping hard, and never stopping, for four minutes of sim time.
  const ctx = makeCtx({ storm: 'calm', windX: 14, windZ: 0, windSpeed: 30, windRamp: 3 }, 6);
  let peak = 0;
  for (let i = 0; i < 4800; i++) {
    ctx.time += 0.05;
    mgr.update(ctx, pool);
    pool.update(0.05, ctx.time);
    peak = Math.max(peak, mgr.devils.length);
  }
  assert.ok(mgr.devils.length >= 1, 'the wind did spin devils up');
  // One devil per ramp, each held ~45 s, never more often than every 30 s.
  assert.ok(peak <= 2, `a climbing wind cannot carpet the map (peak ${peak})`);
  assert.ok(peak <= MAX_DEVILS, `and never breaches the ceiling of ${MAX_DEVILS}`);
});

test('two devils in the same storm walk their own paths', () => {
  const pool = new ParticlePool(4000, mulberry32(33));
  const a = new DustDevil({ x: 0, z: 0, groundY: 0 }, mulberry32(41));
  const b = new DustDevil({ x: 0, z: 0, groundY: 0 }, mulberry32(42));
  const ctx = makeCtx({ storm: 'devil', stormIntensity: 0.9, windX: 12, windZ: 2, windSpeed: 24 }, 43);
  // Released from the same spot into the same wind: they must not hold station.
  runEmitter(
    (c, p) => {
      a.update(c, p);
      b.update(c, p);
    },
    ctx,
    pool,
    15,
  );
  const sep = Math.hypot(a.x - b.x, a.z - b.z);
  assert.ok(sep > 8, `their tracks diverge (${sep.toFixed(1)} m apart after 15 s)`);

  // …but the meander still reads as downwind travel, not free drifting.
  const w = Math.hypot(12, 2);
  for (const d of [a, b]) {
    const down = (d.x * 12 + d.z * 2) / w;
    const cross = (d.x * 2 - d.z * 12) / w;
    assert.ok(down > 15, `still walks downwind (${down.toFixed(1)} m in 15 s)`);
    assert.ok(Math.abs(cross) < down * 0.6, `wandering, not drifting freely (cross ${cross.toFixed(1)})`);
  }
  // Their headings differ, which is what stopped them travelling in formation.
  const pa = { x: a.x, z: a.z };
  const pb = { x: b.x, z: b.z };
  runEmitter(
    (c, p) => {
      a.update(c, p);
      b.update(c, p);
    },
    ctx,
    pool,
    2,
  );
  const ha = Math.atan2(a.x - pa.x, a.z - pa.z);
  const hb = Math.atan2(b.x - pb.x, b.z - pb.z);
  assert.ok(Math.abs(ha - hb) > 0.05, `and they are not walking parallel (Δ${Math.abs(ha - hb).toFixed(3)} rad)`);
});

test('devils crowd apart instead of travelling as one clump', () => {
  const mgr = new DevilManager();
  const a = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 3, height: 50 }, mulberry32(44));
  const b = new DustDevil({ x: 1, z: 0, groundY: 0, baseRadius: 3, height: 50 }, mulberry32(45));
  mgr.devils.push(a, b);
  const before = Math.hypot(b.x - a.x, b.z - a.z);
  for (let i = 0; i < 20; i++) mgr.separate(0.05);
  const after = Math.hypot(b.x - a.x, b.z - a.z);
  assert.ok(after > before + 1, `a second of crowding peels them apart (${before.toFixed(2)} → ${after.toFixed(2)} m)`);

  const far = new DevilManager();
  const c = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 3, height: 50 }, mulberry32(46));
  const d = new DustDevil({ x: 200, z: 0, groundY: 0, baseRadius: 3, height: 50 }, mulberry32(47));
  far.devils.push(c, d);
  for (let i = 0; i < 200; i++) far.separate(0.05);
  assert.equal(Math.hypot(d.x - c.x, d.z - c.z), 200, 'a devil across the map is left alone');
});

test('a bigger devil swallows a smaller one and visibly grows', () => {
  const mgr = new DevilManager();
  const big = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 6, height: 60 }, mulberry32(48));
  const small = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 2, height: 40 }, mulberry32(49));
  const { ctx } = contactPair(mgr, big, small, 4);
  const r0 = big.baseR;
  const h0 = big.height;
  const emit0 = big.emitScale;

  mgr.resolveContacts(ctx);
  assert.equal(mgr.interactions, 1, 'the contact resolved once');
  assert.ok(mgr.twinCount === 0 && mgr.danceCount === 0, 'a size mismatch is not a pairing');
  assert.equal(small.target, 0, 'the little one is torn apart');
  assert.ok(big.baseR > r0, `the survivor swells (${r0.toFixed(2)} → ${big.baseR.toFixed(2)} m)`);
  assert.ok(big.height > h0, `and grows taller (${h0.toFixed(1)} → ${big.height.toFixed(1)} m)`);
  assert.ok(big.emitScale > emit0, `and throws more dust (${emit0.toFixed(2)} → ${big.emitScale.toFixed(2)}×)`);
  assert.equal(big.target, 1, 'the survivor carries on');
});

test('a devil cannot gorge itself past its ceiling', () => {
  const mgr = new DevilManager();
  const big = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 6, height: 60 }, mulberry32(50));
  for (let i = 0; i < 12; i++) {
    const small = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 1.5, height: 30 }, mulberry32(51 + i));
    const { ctx } = contactPair(mgr, big, small, 1);
    ctx.time = i * 20; // clear of the pair cooldown between meals
    mgr.resolveContacts(ctx);
    mgr.devils.length = 1;
  }
  assert.ok(big.baseR <= 6 * 1.8 + 1e-9, `growth is capped (${big.baseR.toFixed(2)} m)`);
  assert.ok(big.emitScale <= 2.2 + 1e-9, `and so is the emission boost (${big.emitScale.toFixed(2)}×)`);
  assert.ok(big.baseR > 6, 'but it did grow');
});

test('a size mismatch usually ends in a dance, and the little one dies off', () => {
  let danced = 0;
  let eaten = 0;
  for (let s = 0; s < 24; s++) {
    const mgr = new DevilManager();
    const big = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 5, height: 55 }, mulberry32(52));
    const small = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 3, height: 45 }, mulberry32(53));
    const { ctx, pool } = contactPair(mgr, big, small, 3);
    ctx.rand = mulberry32(200 + s * 13);
    mgr.resolveContacts(ctx);
    if (mgr.danceCount === 1) {
      danced++;
      assert.equal(big.target, 1, 'the big one is not interrupted');
      // The little one circles the big one, which keeps walking its own path.
      const bx0 = big.x;
      const bz0 = big.z;
      const r = mgr.pairs[0].r;
      for (let i = 0; i < 40; i++) {
        ctx.time += 0.05;
        mgr.resolveContacts(ctx);
        big.update(ctx, pool);
        small.update(ctx, pool);
        pool.update(0.05, ctx.time);
      }
      const gap = Math.hypot(small.x - big.x, small.z - big.z);
      assert.ok(Math.abs(gap - r) < 1e-6, `the little one holds its orbit (${gap.toFixed(4)} vs ${r.toFixed(4)})`);
      assert.ok(
        Math.hypot(big.x - bx0, big.z - bz0) > 1,
        `while the big one carries on downwind on its own path (${Math.hypot(big.x - bx0, big.z - bz0).toFixed(1)} m)`,
      );
    } else {
      assert.equal(small.target, 0, 'otherwise it is simply eaten');
      eaten++;
    }
  }
  assert.ok(danced > 0, `some mismatches dance (${danced} of 24)`);
  assert.ok(eaten > 0, `and some are swallowed instead (${eaten} of 24)`);
  assert.equal(danced + eaten, 24, 'every contact resolved one way or the other');

  // The dance ends with the little one winding down, having circled the big
  // one for a while rather than merging with it.
  const mgr = new DevilManager();
  const big = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 5, height: 55 }, mulberry32(54));
  const small = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 3, height: 45 }, mulberry32(55));
  const { ctx } = contactPair(mgr, big, small, 3);
  ctx.rand = mulberry32(213); // a seed that dances
  mgr.resolveContacts(ctx);
  if (mgr.danceCount === 1) {
    const r0 = small.baseR;
    const scratch = new ParticlePool(8, mulberry32(1));
    for (let i = 0; i < 280; i++) {
      ctx.time += 0.05;
      mgr.resolveContacts(ctx);
      big.update(ctx, scratch);
      small.update(ctx, scratch);
    }
    assert.equal(mgr.danceCount, 0, 'the dance ended');
    assert.equal(small.target, 0, 'and the little one is gone');
    assert.equal(big.target, 1, 'the big one never noticed');
    assert.equal(small.baseR, r0, 'nothing was consumed');
  }
});

test('matched devils either twin up or cancel — one outcome, chosen by the roll', () => {
  let twins = 0;
  let cancelled = 0;
  for (let s = 0; s < 24; s++) {
    const mgr = new DevilManager();
    const a = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 3, height: 50 }, mulberry32(56));
    const b = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 3.1, height: 50 }, mulberry32(57));
    const { ctx } = contactPair(mgr, a, b, 3);
    ctx.rand = mulberry32(300 + s * 17);
    mgr.resolveContacts(ctx);
    if (mgr.twinCount === 1) {
      twins++;
      assert.equal(a.target, 1);
      assert.equal(b.target, 1);
    } else {
      cancelled++;
      assert.equal(a.target, 0, 'both spin down');
      assert.equal(b.target, 0, 'and both disappear');
    }
    assert.equal(mgr.interactions, 1, 'exactly one resolution per contact');
  }
  assert.ok(twins > 0, `matched devils sometimes twin (${twins} of 24)`);
  assert.ok(cancelled > 0, `and sometimes cancel outright (${cancelled} of 24)`);
});

/** Matched devils, on a seed that rolls a twin pairing rather than a cancellation. */
function twinningSetup(): { mgr: DevilManager; a: DustDevil; b: DustDevil; ctx: FxContext; pool: ParticlePool } | null {
  for (let s = 0; s < 40; s++) {
    const mgr = new DevilManager();
    const a = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 3, height: 50 }, mulberry32(58));
    const b = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 3.1, height: 50 }, mulberry32(59));
    const { ctx, pool } = contactPair(mgr, a, b, 3);
    ctx.rand = mulberry32(500 + s * 31);
    mgr.resolveContacts(ctx);
    if (mgr.twinCount === 1) return { mgr, a, b, ctx, pool };
  }
  return null;
}

test('twins orbit a shared centre until they split or wind down', () => {
  const setup = twinningSetup();
  assert.ok(setup, 'matched devils can form a twin pair');
  const { mgr, a, b, ctx, pool } = setup!;
  const pair = mgr.pairs[0];
  const cx0 = pair.cx;

  for (let i = 0; i < 100; i++) {
    ctx.time += 0.05;
    mgr.resolveContacts(ctx);
    a.update(ctx, pool);
    b.update(ctx, pool);
    pool.update(0.05, ctx.time);
  }
  const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  assert.ok(
    Math.abs(Math.hypot(a.x - mid.x, a.z - mid.z) - pair.r) < 1e-6,
    'both ride the shared orbit, half a turn apart',
  );
  assert.ok(
    Math.abs(mid.x - (cx0 + 4 * 0.22 * 5)) < 0.5,
    `and the pair drifts downwind as a unit (${mid.x.toFixed(2)} m in 5 s)`,
  );

  // It resolves rather than orbiting forever.
  runEmitter(
    (c, p) => {
      mgr.resolveContacts(c);
      a.update(c, p);
      b.update(c, p);
    },
    ctx,
    pool,
    20,
  );
  assert.equal(mgr.twinCount, 0, 'the pairing ended');
  const sep = Math.hypot(a.x - b.x, a.z - b.z);
  const resolved = a.target === 0 || b.target === 0 || sep > (a.baseR + b.baseR) * 1.15;
  assert.ok(resolved, `split apart or wound down (sep ${sep.toFixed(1)} m, targets ${a.target}/${b.target})`);
});

test('a devil already winding down is not a merge target', () => {
  const mgr = new DevilManager();
  const live = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 3, height: 50 }, mulberry32(60));
  const dying = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 3, height: 50 }, mulberry32(61));
  const { ctx } = contactPair(mgr, live, dying, 2);
  dying.target = 0;
  dying.strength = 0.6;
  mgr.resolveContacts(ctx);
  assert.equal(mgr.interactions, 0, 'a dying devil is left to finish dying');
  assert.equal(mgr.twinCount, 0);
  assert.equal(live.target, 1, 'and the live one carries on');

  // Neither is a devil that has only just started spinning up.
  const fresh = new DevilManager();
  const weak = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 3, height: 50 }, mulberry32(62));
  const strong = new DustDevil({ x: 0, z: 0, groundY: 0, baseRadius: 3, height: 50 }, mulberry32(63));
  const c2 = contactPair(fresh, strong, weak, 2);
  weak.strength = 0.2;
  fresh.resolveContacts(c2.ctx);
  assert.equal(fresh.interactions, 0, 'a devil that has barely spun up is not a partner yet');
});

test('resolutions settle instead of thrashing', () => {
  const mgr = new DevilManager();
  const pool = new ParticlePool(6000, mulberry32(64));
  // Five devils dropped on top of each other, in a severe storm, for two minutes.
  for (let i = 0; i < MAX_DEVILS; i++) {
    const d = new DustDevil({ x: i * 3, z: 0, groundY: 0, baseRadius: 4, height: 50 }, mulberry32(65 + i));
    mgr.devils.push(d);
  }
  const ctx = makeCtx({ storm: 'severe', stormIntensity: 1, windX: 18, windZ: 6, windSpeed: 50, dust: 0.9 }, 70);
  for (let i = 0; i < 2400; i++) {
    ctx.time += 0.05;
    mgr.update(ctx, pool);
    pool.update(0.05, ctx.time);
  }
  // One resolution per contact, a cooldown after each: five devils cannot
  // grind through dozens of merges.
  assert.ok(mgr.interactions <= 6, `the cluster settled quickly (${mgr.interactions} resolutions)`);
  assert.ok(mgr.devils.length <= MAX_DEVILS, `and the sky never held more than ${MAX_DEVILS}`);
});

test('a handful of devils still fits the particle budget', () => {
  const pool = new ParticlePool(9000, mulberry32(66));
  const devils: DustDevil[] = [];
  for (let i = 0; i < MAX_DEVILS; i++) {
    const d = new DustDevil({ x: i * 60, z: 0, groundY: 0, baseRadius: 6, height: 70 }, mulberry32(67 + i));
    d.grow(1.8); // the worst case: every devil already fed to its cap
    devils.push(d);
  }
  const storm = new StormEmitter();
  const wind = new WindEmitter();
  const ctx = makeCtx({ storm: 'severe', stormIntensity: 1, windX: 18, windZ: 6, windSpeed: 55, dust: 0.9 }, 72);
  let peak = 0;
  for (let i = 0; i < 600; i++) {
    ctx.time += 0.05;
    for (const d of devils) d.update(ctx, pool);
    storm.update(ctx, pool);
    wind.update(ctx, pool);
    pool.update(0.05, ctx.time);
    peak = Math.max(peak, pool.alive);
  }
  assert.ok(peak < 7500, `the worst case leaves headroom in the pool (peak ${peak} of 9000)`);
});

test('devil behaviour is deterministic under a seeded RNG', () => {
  const drive = (seed: number): string => {
    const pool = new ParticlePool(3000, mulberry32(seed));
    const mgr = new DevilManager();
    const ctx = makeCtx(
      { storm: 'severe', stormIntensity: 0.95, windX: 16, windZ: 5, windSpeed: 48, dust: 0.8, windRamp: 0.9 },
      seed,
    );
    runEmitter((c, p) => mgr.update(c, p), ctx, pool, 12);
    return JSON.stringify([
      mgr.devils.map((d) => [d.x.toFixed(6), d.z.toFixed(6), d.baseR.toFixed(6), d.strength.toFixed(6), d.target]),
      mgr.interactions,
      mgr.twinCount,
      mgr.danceCount,
    ]);
  };
  assert.equal(drive(1234), drive(1234), 'same seed, same sky');
  assert.notEqual(drive(1234), drive(4321), 'different seed, different weather');
});

group('Dust field');

/** One emission step, no integration: render arrays hold the spawn state. */
function spawnSnapshot(
  emit: (ctx: FxContext, pool: ParticlePool) => void,
  ctx: FxContext,
  capacity = 4000,
  seed = 91,
): { pos: Float32Array; size: Float32Array; alpha: Float32Array; n: number } {
  const pool = new ParticlePool(capacity, mulberry32(seed));
  emit(ctx, pool);
  const a = renderArrays(pool);
  const n = pool.writeRender(a.pos, a.col, a.size, a.alpha);
  return { pos: a.pos, size: a.size, alpha: a.alpha, n };
}

test('the emission field grows with the view and clamps at both ends', () => {
  const lo = dustField(5);
  const mid = dustField(200);
  const hi = dustField(900);
  const capped = dustField(9000);
  assert.equal(lo.half, dustField(FIELD_MIN).half, 'the close-up floor holds');
  assert.deepEqual(capped, hi, 'the from-orbit ceiling holds');
  assert.ok(lo.half < mid.half && mid.half < hi.half, `half grows (${lo.half} < ${mid.half} < ${hi.half})`);
  assert.ok(lo.height <= mid.height && mid.height <= hi.height, 'and so does the layer');
  assert.ok(lo.size <= mid.size && mid.size < hi.size, `grain holds its screen size (${mid.size} → ${hi.size})`);
  assert.ok(lo.alpha >= mid.alpha && mid.alpha > hi.alpha, `the far field thins to haze (${mid.alpha} → ${hi.alpha})`);
  assert.ok(hi.half <= FIELD_MAX, `never past the world (${hi.half} <= ${FIELD_MAX})`);
  for (const v of [5, 200, 900]) {
    const f = dustField(v);
    assert.ok(f.r0 < f.half, 'the feather band sits inside the box');
    assert.ok(f.half >= Math.max(FIELD_MIN, Math.min(v, FIELD_MAX / 1.45)), 'the box covers the viewed area');
  }
});

test('storm grit is finer than the ambient wind dust', () => {
  const ctx = makeCtx({ storm: 'severe', stormIntensity: 0.9, windX: 16, windZ: 5, windSpeed: 45, dust: 0.8 });
  const stormy = { ...ctx, dt: 1, rand: mulberry32(92) };
  const windy = { ...ctx, dt: 1, storm: 'calm' as const, stormIntensity: 0, rand: mulberry32(93) };
  const s = spawnSnapshot((c, p) => new StormEmitter().update(c, p), stormy);
  const w = spawnSnapshot((c, p) => new WindEmitter().update(c, p), windy);
  const bounds = (size: Float32Array, n: number): [number, number, number] => {
    let min = Infinity;
    let max = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      min = Math.min(min, size[i]);
      max = Math.max(max, size[i]);
      sum += size[i];
    }
    return [min, max, sum / n];
  };
  const [smin, smax, smean] = bounds(s.size, s.n);
  const [wmin, wmax, wmean] = bounds(w.size, w.n);
  assert.ok(s.n > 100 && w.n > 50, 'both emitters fired');
  assert.ok(smax <= wmax, `storm grit never outgrows wind dust (${smax.toFixed(2)} <= ${wmax.toFixed(2)} m)`);
  assert.ok(smean < wmean, `and reads finer on average (${smean.toFixed(2)} vs ${wmean.toFixed(2)} m)`);
  assert.ok(smax < 2, `grit-sized, not cloud-sized (${smax.toFixed(2)} m)`);
  assert.ok(smin > 0.1, 'but still visible');
});

test('the storm fills the viewed area at every zoom', () => {
  const spreads: number[] = [];
  for (const vr of [60, 250, 690]) {
    const ctx = makeCtx({ storm: 'severe', stormIntensity: 0.9, windX: 16, windZ: 5, windSpeed: 45, dust: 0.8, viewRadius: vr });
    const snap = spawnSnapshot((c, p) => new StormEmitter().update(c, p), { ...ctx, dt: 1 }, 8000);
    const half = dustField(vr).half;
    let reach = 0;
    for (let i = 0; i < snap.n; i++) {
      reach = Math.max(reach, Math.abs(snap.pos[i * 3] - ctx.camX), Math.abs(snap.pos[i * 3 + 2] - ctx.camZ));
    }
    assert.ok(reach > half * 0.9, `spawns span the field at viewRadius ${vr} (reach ${reach.toFixed(0)} of ${half.toFixed(0)})`);
    assert.ok(half >= vr, `the box covers the viewed footprint (${half.toFixed(0)} >= ${vr})`);
    spreads.push(half);
  }
  assert.ok(spreads[1] > spreads[0] * 2 && spreads[2] > spreads[1] * 2, `coverage scales with zoom (${spreads.map((s) => s.toFixed(0)).join(' → ')})`);
});

test('the rim feather hides the box edge, and only for ambient dust', () => {
  const f = dustField(200);
  const pool = new ParticlePool(64, mulberry32(94));
  pool.setFalloff(0, 0, f.r0, f.half);
  const radii = [0, 0.3, 0.6, 0.75, 0.9, 0.99, 1.1];
  for (const r of radii) {
    const base = { y: 2, z: 0, vx: 0, vy: 0, vz: 0, life: 4, size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1 };
    pool.spawn({ ...base, x: r * f.half });
    pool.spawn({ ...base, x: -r * f.half, kind: PKind.Devil });
    pool.spawn({ ...base, x: r * f.half * 0.7071, z: r * f.half * 0.7071, kind: PKind.Trail });
  }
  pool.update(2, 2); // mid-life: the fade envelope is at peak
  const a = renderArrays(pool);
  const n = pool.writeRender(a.pos, a.col, a.size, a.alpha);
  assert.equal(n, radii.length * 3);
  let prev = Infinity;
  for (let i = 0; i < radii.length; i++) {
    const ambient = a.alpha[i * 3];
    const devil = a.alpha[i * 3 + 1];
    const trail = a.alpha[i * 3 + 2];
    assert.equal(devil, 1, `devil dust ignores the feather at r=${radii[i]}`);
    assert.equal(trail, 1, `trail dust ignores the feather at r=${radii[i]}`);
    assert.ok(ambient <= prev + 1e-9, `ambient alpha never rises outward (${radii[i]}: ${ambient.toFixed(3)})`);
    prev = ambient;
    if (radii[i] <= 0.6) assert.equal(ambient, 1, `full strength well inside the rim (r=${radii[i]})`);
  }
  assert.equal(a.alpha[(radii.length - 1) * 3], 0, 'nothing past the rim');
  assert.ok(a.alpha[4 * 3] < 0.6 && a.alpha[4 * 3] > 0.05, `the band fades gradually (r=0.9: ${a.alpha[4 * 3].toFixed(3)})`);
});

test('the flow field is coherent: neighbours roll together, far motes roll against', () => {
  const drive = (gap: number): number => {
    const pool = new ParticlePool(8, mulberry32(95));
    for (const x of [0, gap]) {
      pool.spawn({ x, y: 4, z: 0, vx: 0, vy: 0, vz: 0, life: 6, size0: 1, size1: 1, r: 1, g: 1, b: 1, alpha: 1, turbulence: 40 });
    }
    const a = renderArrays(pool);
    let ax = 0;
    let az = 0;
    let bx = 0;
    let bz = 0;
    for (let f = 0; f < 30; f++) {
      pool.writeRender(a.pos, a.col, a.size, a.alpha);
      const p = [a.pos[0], a.pos[2], a.pos[3], a.pos[5]];
      pool.update(1 / 60, f / 60);
      pool.writeRender(a.pos, a.col, a.size, a.alpha);
      ax += a.pos[0] - p[0];
      az += a.pos[2] - p[1];
      bx += a.pos[3] - p[2];
      bz += a.pos[5] - p[3];
    }
    return (ax * bx + az * bz) / Math.max(1e-9, Math.hypot(ax, az) * Math.hypot(bx, bz));
  };
  const near = drive(8);
  const far = drive(79); // half a roll apart: opposite faces turn against each other
  assert.ok(near > 0.7, `motes in the same roll turn together (cos ${near.toFixed(3)})`);
  assert.ok(far < -0.5, `opposite faces of a roll turn against each other (cos ${far.toFixed(3)})`);
});

test('grit paths curve and wander while still transporting downwind', () => {
  const track = (turbulence: number): { dev: number; swing: number; down: number } => {
    const pool = new ParticlePool(128, mulberry32(96));
    const R = mulberry32(97);
    const N = 40;
    for (let i = 0; i < N; i++) {
      pool.spawn({
        x: (R() - 0.5) * 30,
        y: 1 + R() * 15,
        z: (R() - 0.5) * 30,
        vx: 40 * (0.62 + 0.38 * Math.min(1, R() * 2)),
        vy: (R() - 0.5) * 1.2,
        vz: (R() - 0.5) * 1.6,
        life: 2.4,
        size0: 1,
        size1: 1,
        r: 1,
        g: 1,
        b: 1,
        alpha: 0.5,
        gravity: 0.25,
        drag: 0.08,
        turbulence,
      });
    }
    const a = renderArrays(pool);
    const frames: Float32Array[] = [];
    for (let f = 0; f < 144; f++) {
      pool.update(1 / 60, f / 60);
      pool.writeRender(a.pos, a.col, a.size, a.alpha);
      frames.push(Float32Array.from(a.pos.subarray(0, N * 3)));
    }
    let dev = 0;
    let swing = 0;
    let down = 0;
    for (let i = 0; i < N; i++) {
      const x0 = frames[0][i * 3];
      const z0 = frames[0][i * 3 + 2];
      const cx = frames[143][i * 3] - x0;
      const cz = frames[143][i * 3 + 2] - z0;
      const len = Math.hypot(cx, cz);
      if (len < 1) continue;
      let maxd = 0;
      let worst = 0;
      for (let f = 0; f < 144; f += 3) {
        const dx = frames[f][i * 3] - x0;
        const dz = frames[f][i * 3 + 2] - z0;
        maxd = Math.max(maxd, Math.abs(dx * cz - dz * cx) / len);
        if (f > 0 && f < 138) {
          const h = Math.atan2(frames[f + 6][i * 3 + 2] - frames[f][i * 3 + 2], frames[f + 6][i * 3] - frames[f][i * 3]);
          worst = Math.max(worst, Math.abs(h));
        }
      }
      dev += maxd / len;
      swing += worst;
      down += cx > 0 ? 1 : 0;
    }
    return { dev: dev / N, swing: (swing / N) * (180 / Math.PI), down: down / N };
  };
  const straight = track(0);
  const blown = track(40);
  assert.ok(straight.dev < 0.005, `without turbulence the path is a streak (${straight.dev.toFixed(4)})`);
  assert.ok(blown.dev > 0.02, `grit wanders off its own chord (${blown.dev.toFixed(3)} of path length)`);
  assert.ok(blown.swing > 4, `headings swing off the wind by ${(blown.swing).toFixed(1)}° on average`);
  assert.ok(blown.down > 0.9, `yet the storm still has a direction (${(blown.down * 100).toFixed(0)}% downwind)`);
});

test('zooming out thins and coarsens the grain instead of emptying the sky', () => {
  const run = (rig: number): { alive: number; half: number; size: number; alpha: number } => {
    const scene = new THREE.Scene();
    const fx = new WeatherFX(scene, { rand: mulberry32(101) });
    fx.setViewport(900, 55);
    const cam = new THREE.PerspectiveCamera(55, 1.78, 0.5, 4200);
    const phi = 0.8;
    cam.position.set(Math.sin(phi) * Math.sin(0.85) * rig, Math.max(10, Math.cos(phi) * rig), Math.sin(phi) * Math.cos(0.85) * rig);
    cam.lookAt(0, 4, 0);
    cam.updateMatrixWorld();
    const input = makeInput({ windSpeed: 48, windDirRad: 1.4, dust: 0.8, visibility: 0.2, storm: 'severe', stormIntensity: 0.9 });
    runFx(fx, cam, input, 5);
    const out = { alive: fx.alive, half: fx.field.half, size: fx.field.size, alpha: fx.field.alpha };
    fx.dispose(scene);
    return out;
  };
  const near = run(60);
  const far = run(1200);
  assert.ok(far.half > near.half * 3, `the field grows with the view (${near.half.toFixed(0)} → ${far.half.toFixed(0)})`);
  assert.ok(far.size > near.size * 2, `grain holds its screen size (${near.size.toFixed(2)} → ${far.size.toFixed(2)})`);
  assert.ok(far.alpha < near.alpha, `and thins into haze (${near.alpha.toFixed(2)} → ${far.alpha.toFixed(2)})`);
  assert.ok(
    far.alive > near.alive * 0.5 && far.alive < near.alive * 2,
    `population stays rate-bound, not area-bound (${near.alive} vs ${far.alive})`,
  );
});

test('the worst case at maximum zoom stays inside the pool budget', () => {
  const pool = new ParticlePool(9000, mulberry32(102));
  const devils: DustDevil[] = [];
  for (let i = 0; i < MAX_DEVILS; i++) {
    const d = new DustDevil({ x: i * 200, z: 0, groundY: 0, baseRadius: 6, height: 70 }, mulberry32(103 + i));
    d.grow(1.8);
    devils.push(d);
  }
  const storm = new StormEmitter();
  const wind = new WindEmitter();
  const ctx = makeCtx({ storm: 'severe', stormIntensity: 1, windX: 18, windZ: 6, windSpeed: 55, dust: 0.9, viewRadius: 690 }, 104);
  let peak = 0;
  for (let i = 0; i < 600; i++) {
    ctx.time += 0.05;
    for (const d of devils) d.update(ctx, pool);
    storm.update(ctx, pool);
    wind.update(ctx, pool);
    pool.update(0.05, ctx.time);
    peak = Math.max(peak, pool.alive);
  }
  assert.ok(peak < 7500, `from orbit the whole sky still fits the pool (peak ${peak} of 9000)`);
});

group('WeatherFX controller');

function calmWeather(): WeatherFxWeather {
  return { windSpeed: 8, windDirRad: 0.7, dust: 0.08, visibility: 1, storm: 'calm', stormIntensity: 0 };
}

function makeFx(seed = 99, maxParticles?: number): { fx: WeatherFX; cam: THREE.PerspectiveCamera } {
  const scene = new THREE.Scene();
  const fx = new WeatherFX(scene, { rand: mulberry32(seed), maxParticles });
  fx.setViewport(900, 55);
  const cam = new THREE.PerspectiveCamera(55, 1, 0.5, 4200);
  cam.position.set(120, 110, 150);
  return { fx, cam };
}

function makeInput(weather: WeatherFxWeather): WeatherFxInput {
  return { time: 0, weather, rovers: [], heightAt: () => 0 };
}

function runFx(fx: WeatherFX, cam: THREE.PerspectiveCamera, input: WeatherFxInput, seconds: number, dt = 0.05): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    input.time += dt;
    fx.sync(input, cam, dt);
  }
}

test('calm air carries ambient dust, but no storm and no devils', () => {
  const { fx, cam } = makeFx();
  const input = makeInput(calmWeather());
  runFx(fx, cam, input, 3);
  assert.ok(fx.alive > 0, 'ambient motes drift even on a clear sol');
  assert.equal(fx.rendered, fx.alive, 'everything live reaches the GPU');
  assert.equal(fx.devilCount, 0);
});

test('a severe storm fills the sky far beyond calm air — devils ride its front', () => {
  const still = makeFx(21);
  runFx(still.fx, still.cam, makeInput(calmWeather()), 4);
  const blowing = makeFx(21);
  const storm = makeInput({
    windSpeed: 50, windDirRad: 2.1, dust: 0.85, visibility: 0.1, storm: 'severe', stormIntensity: 0.95,
  });
  runFx(blowing.fx, blowing.cam, storm, 4);
  assert.ok(
    blowing.fx.alive > still.fx.alive * 3,
    `storm air is far denser (${still.fx.alive} vs ${blowing.fx.alive})`,
  );
  assert.ok(
    blowing.fx.devilCount >= 1,
    `the wind and the devils arrive together (${blowing.fx.devilCount} spun up)`,
  );
});

test('a devil storm spins up a devil near the camera', () => {
  const { fx, cam } = makeFx(22);
  const storm = makeInput({
    windSpeed: 38, windDirRad: 1.2, dust: 0.3, visibility: 0.6, storm: 'devil', stormIntensity: 0.6,
  });
  runFx(fx, cam, storm, 4);
  assert.ok(fx.devilCount >= 1, 'a devil is visibly spinning');
});

test('a moving rover leaves a trail; a parked one leaves nothing', () => {
  const dt = 0.05;
  const drive = (moving: boolean): number => {
    const { fx, cam } = makeFx(23);
    const input = makeInput(calmWeather());
    const speed = 14;
    let x = 0;
    const steps = Math.round(2 / dt);
    for (let i = 0; i < steps; i++) {
      input.time += dt;
      if (moving) x += speed * dt;
      input.rovers = [{ id: 7, x, z: 0, heading: Math.PI / 2, phase: moving ? 'moving' : 'idle' }];
      fx.sync(input, cam, dt);
    }
    return fx.alive;
  };
  const parked = drive(false);
  const cruising = drive(true);
  assert.ok(cruising > parked + 10, `the mover trails dust (${parked} vs ${cruising})`);
});

test('a rising wind spins a devil up through the FX controller', () => {
  const dt = 0.05;
  const steps = 200; // ten sim seconds of wind that will not stop climbing
  const rising = makeFx(26);
  const input = makeInput(calmWeather());
  for (let i = 0; i < steps; i++) {
    input.time += dt;
    input.weather = { ...calmWeather(), windSpeed: 8 + 3 * input.time };
    rising.fx.sync(input, rising.cam, dt);
  }
  assert.ok(rising.fx.devilCount >= 1, `the gust front arrives before any storm is declared (${rising.fx.devilCount})`);

  // A hard but steady wind, however, spins nothing up: it is the *ramp* that
  // does it, not the speed.
  const steady = makeFx(27);
  const still = makeInput({ ...calmWeather(), windSpeed: 45 });
  for (let i = 0; i < steps; i++) {
    still.time += dt;
    steady.fx.sync(still, steady.cam, dt);
  }
  assert.equal(steady.fx.devilCount, 0, 'a steady gale makes no devils of its own');
});

test('a real storm arrives with devils; calm weather never has them', () => {
  const drive = (withStorm: boolean, seed: number): { devils: number; firstAt: number; peak: number } => {
    const weather = new Weather(seed);
    weather.debugSuppressRolls();
    if (withStorm) weather.debugScheduleStorm('severe', 0, 20);
    // A small pool: this test is about the devils, not the dust budget, and
    // the sim-side run covers thousands of ticks.
    const { fx, cam } = makeFx(seed + 1, 1200);
    const input = makeInput(calmWeather());
    const dt = 0.05;
    let firstAt = -1;
    let peak = 0;
    for (let i = 0; i < 3600; i++) {
      // Three sim minutes: the front arrives, peaks and is still blowing.
      input.time += dt;
      weather.tick(dt, input.time, 1);
      input.weather = weather.reading;
      fx.sync(input, cam, dt);
      peak = Math.max(peak, fx.devilCount);
      if (firstAt < 0 && fx.devilCount > 0) firstAt = input.time;
    }
    return { devils: fx.devilCount, firstAt, peak };
  };

  // The real sim's ambient wind wanders all the time; it must never be enough.
  for (const seed of [11, 12, 13]) {
    const calm = drive(false, seed);
    assert.equal(calm.devils, 0, `three minutes of clear weather spins nothing up (seed ${seed})`);
  }
  const storm = drive(true, 11);
  assert.ok(storm.firstAt > 0, 'the storm brought devils with it');
  assert.ok(storm.peak >= 2, `and more than the old two at once (peak ${storm.peak})`);
  assert.ok(storm.peak <= MAX_DEVILS, `never more than ${MAX_DEVILS} (peak ${storm.peak})`);
});

test('pause freezes the system exactly', () => {
  const { fx, cam } = makeFx(24);
  const input = makeInput(calmWeather());
  runFx(fx, cam, input, 1);
  const alive = fx.alive;
  const rendered = fx.rendered;
  for (let i = 0; i < 20; i++) fx.sync(input, cam, 0);
  assert.equal(fx.alive, alive, 'no aging, no emission while paused');
  assert.equal(fx.rendered, rendered);
});

test('emission centres on the viewed ground, not the camera', () => {
  const { fx, cam } = makeFx(25);
  // The default orbit pose: perched out at radius, looking back at the pad.
  cam.position.set(120, 110, 150);
  cam.lookAt(0, 0, 0);
  const input = makeInput(calmWeather());
  runFx(fx, cam, input, 0.5);
  const f = fx.focus;
  assert.ok(
    Math.hypot(f.x, f.z) < 30,
    `focus sits near the pad, got (${f.x.toFixed(1)}, ${f.z.toFixed(1)})`,
  );
  assert.ok(
    Math.hypot(f.x - 120, f.z - 150) > 100,
    'focus is far from the ground below the camera',
  );
});

group('GPU adapter');

test('perspective calibration matches the projection math', () => {
  const pts = new ParticlePoints(64);
  pts.setPerspective(900, 55);
  const expect = 900 / (2 * Math.tan((55 * Math.PI) / 180 / 2));
  assert.ok(Math.abs(pts.pixelScale - expect) < 1e-9, `uScale=${pts.pixelScale}`);
  pts.dispose();
});

test('the soft sprite is procedural and deterministic', () => {
  const a = makeSoftSprite();
  const b = makeSoftSprite();
  assert.deepEqual([...(a.image.data as Uint8Array)], [...(b.image.data as Uint8Array)]);
  assert.ok(a.image.data[3] === 0 || a.image.data[3] < 16, 'corners fall to transparent');
  a.dispose();
  b.dispose();
});

await finish('render/particles');
