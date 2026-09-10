/**
 * @suite render/particles
 * @group unit
 * @covers src/render/particles/ParticlePool.ts src/render/particles/effects.ts src/render/particles/ParticlePoints.ts src/render/WeatherFX.ts
 * @desc The true particle system, headlessly: pool lifecycle and determinism,
 * wind/storm/devil/trail emitters, and the weather FX controller that drives
 * them from sim readings. No GPU needed — only final rendering needs one.
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mulberry32 } from '../../src/lib/rng';
import { ParticlePool } from '../../src/render/particles/ParticlePool';
import {
  WindEmitter,
  StormEmitter,
  DustDevil,
  DevilManager,
  RoverTrailEmitter,
  type FxContext,
} from '../../src/render/particles/effects';
import { ParticlePoints, makeSoftSprite } from '../../src/render/particles/ParticlePoints';
import { WeatherFX, type WeatherFxInput, type WeatherFxWeather } from '../../src/render/WeatherFX';
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
    dust: 0.08,
    storm: 'calm',
    stormIntensity: 0,
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

test('the devil manager only wants devils during devil storms', () => {
  const mgr = new DevilManager();
  assert.equal(mgr.wantedFor(makeCtx({ storm: 'calm' })), 0);
  assert.equal(mgr.wantedFor(makeCtx({ storm: 'regional', stormIntensity: 0.8 })), 0, 'grit walls are not vortices');
  assert.equal(mgr.wantedFor(makeCtx({ storm: 'devil', stormIntensity: 0.3 })), 1);
  assert.equal(mgr.wantedFor(makeCtx({ storm: 'devil', stormIntensity: 0.8 })), 2);

  const pool = new ParticlePool(3000, mulberry32(15));
  runEmitter((c, p) => mgr.update(c, p), makeCtx({ storm: 'calm' }), pool, 1);
  assert.equal(mgr.activeCount, 0, 'clear skies, no devils');
  const stormy = makeCtx({ windX: 3, windZ: 1, windSpeed: 8, storm: 'devil', stormIntensity: 0.7 });
  runEmitter((c, p) => mgr.update(c, p), stormy, pool, 4);
  assert.ok(mgr.activeCount >= 1, 'a devil storm spins devils up');
  runEmitter((c, p) => mgr.update(c, p), makeCtx({ time: stormy.time, storm: 'calm' }), pool, 12);
  assert.equal(mgr.activeCount, 0, 'devils dissipate once the storm passes');
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

group('WeatherFX controller');

function calmWeather(): WeatherFxWeather {
  return { windSpeed: 8, windDirRad: 0.7, dust: 0.08, visibility: 1, storm: 'calm', stormIntensity: 0 };
}

function makeFx(seed = 99): { fx: WeatherFX; cam: THREE.PerspectiveCamera } {
  const scene = new THREE.Scene();
  const fx = new WeatherFX(scene, { rand: mulberry32(seed) });
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

test('a severe storm fills the sky far beyond calm air', () => {
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
  assert.equal(blowing.fx.devilCount, 0, 'severe storms are grit, not vortices');
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
