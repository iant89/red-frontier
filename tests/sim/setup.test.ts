/**
 * @suite sim/setup
 * @group unit
 * @covers src/sim/difficulty.ts src/sim/marsGlobe.ts src/sim/World.ts src/ui/landingRegions.ts src/ui/SaveStore.ts
 * @desc Mission-wizard foundations: difficulty tables, world options, landing
 * regions, region-pinned sites, deposit scaling and the named save store.
 */

import assert from 'node:assert/strict';
import {
  DIFFICULTIES,
  WORLD_SIZES,
  DEFAULT_WORLD_OPTIONS,
  hashSeed,
  randomSeedText,
  stormMulFor,
  suppliesMulFor,
  richnessMulFor,
} from '../../src/sim/difficulty';
import { LANDABLE_REGIONS, pickLandingSiteInRegion, angDist } from '../../src/sim/marsGlobe';
import { World } from '../../src/sim/World';
import { REGION_BRIEFS, briefFor, BIOME_COLORS, BIOME_LABELS } from '../../src/ui/landingRegions';
import { SaveStore } from '../../src/ui/SaveStore';
import { group, test, finish } from '../harness';

group('Difficulties and world options');

test('the three difficulties bracket Pioneer on every axis', () => {
  const { settler, pioneer, survivor } = DIFFICULTIES;
  assert.equal(pioneer.consumptionMul, 1);
  assert.ok(settler.consumptionMul < 1 && survivor.consumptionMul > 1);
  assert.ok(settler.stormMul < pioneer.stormMul && survivor.stormMul > pioneer.stormMul);
  assert.ok(settler.damageMul < pioneer.damageMul && survivor.damageMul > pioneer.damageMul);
  assert.ok(settler.suppliesMul > pioneer.suppliesMul && survivor.suppliesMul < pioneer.suppliesMul);
});

test('world sizes step from outpost to planetary survey', () => {
  assert.deepEqual(
    [WORLD_SIZES.small, WORLD_SIZES.medium, WORLD_SIZES.large, WORLD_SIZES.planet].map((s) => s.worldHalf),
    [420, 640, 960, 1280],
  );
  for (const s of Object.values(WORLD_SIZES)) {
    assert.ok(s.label.length > 0 && s.tagline.length > 0 && s.description.length > 0);
    assert.ok(s.sizeLabel.length > 0);
  }
});

test('option multipliers scale monotonically with their level', () => {
  assert.deepEqual(
    (['calm', 'normal', 'brutal'] as const).map(stormMulFor),
    [0.45, 1, 1.8],
  );
  assert.deepEqual(
    (['lean', 'standard', 'abundant'] as const).map(suppliesMulFor),
    [0.7, 1, 1.4],
  );
  assert.deepEqual(
    (['poor', 'standard', 'rich'] as const).map(richnessMulFor),
    [0.65, 1, 1.5],
  );
  assert.deepEqual(Object.keys(DEFAULT_WORLD_OPTIONS).sort(), [
    'nearDeposits',
    'richness',
    'stormLevel',
    'supplies',
  ]);
});

test('seed hashing is deterministic and seed refresh makes short codes', () => {
  assert.equal(hashSeed('mars2066'), hashSeed('mars2066'));
  assert.notEqual(hashSeed('mars2066'), hashSeed('mars2067'));
  assert.match(randomSeedText(), /^ARES-[A-Z0-9]{4}$/);
  assert.notEqual(randomSeedText(), randomSeedText());
});

group('Landing regions and region-pinned sites');

test('the globe exposes eighteen unique landable regions', () => {
  assert.equal(LANDABLE_REGIONS.length, 18);
  assert.equal(new Set(LANDABLE_REGIONS.map((r) => r.name)).size, 18);
});

test('every region has a mission brief, a biome and a marker color', () => {
  assert.equal(REGION_BRIEFS.length, LANDABLE_REGIONS.length);
  for (const r of LANDABLE_REGIONS) {
    const brief = briefFor(r.name);
    assert.ok(brief, `${r.name} needs a brief`);
    assert.ok(brief!.description.length > 40, `${r.name} needs a real brief`);
    assert.ok(brief!.traits.length >= 2, `${r.name} needs traits`);
    assert.match(BIOME_COLORS[brief!.biome], /^#[0-9a-f]{6}$/);
    assert.ok(BIOME_LABELS[brief!.biome].length > 0);
  }
});

test('region-pinned sites are deterministic and land inside their region', () => {
  for (const r of LANDABLE_REGIONS) {
    const a = pickLandingSiteInRegion(4242, r.name);
    const b = pickLandingSiteInRegion(4242, r.name);
    assert.equal(a.lat, b.lat);
    assert.equal(a.lon, b.lon);
    assert.equal(a.name, r.name);
    assert.equal(a.biome, r.biome);
    // The pin jitters inside the region's box; allow the box diagonal plus slack.
    const d = angDist(a.lat, a.lon, r.lat, r.lon);
    assert.ok(d <= r.jitterDeg * 1.5 + 0.5, `${r.name}: site ${d.toFixed(2)}° off center`);
  }
});

test('different regions pin different sites for the same seed', () => {
  const coords = new Set(
    LANDABLE_REGIONS.map((r) => {
      const s = pickLandingSiteInRegion(7, r.name);
      return `${s.lat.toFixed(3)},${s.lon.toFixed(3)}`;
    }),
  );
  assert.ok(coords.size >= 16, 'region pins should mostly disagree');
});

group('World size and richness scaling');

test('worlds remember their claim size and region', () => {
  const w = new World({ seed: 11, nearDeposits: 0.2, worldHalf: 960, region: 'Elysium Planitia' });
  assert.equal(w.half, 960);
  assert.equal(w.region, 'Elysium Planitia');
  assert.ok(w.inBounds(900, 0) && !w.inBounds(1000, 0));
});

test('deposit counts grow with surveyed area', () => {
  const small = new World({ seed: 99, nearDeposits: 0.2, worldHalf: 420 });
  const big = new World({ seed: 99, nearDeposits: 0.2, worldHalf: 1280 });
  assert.ok(big.deposits.length > small.deposits.length * 2, `${small.deposits.length} vs ${big.deposits.length}`);
});

test('richness scales deposit yields for the same seed', () => {
  const poor = new World({ seed: 99, nearDeposits: 0.2, richness: 0.65 });
  const rich = new World({ seed: 99, nearDeposits: 0.2, richness: 1.5 });
  assert.equal(poor.deposits.length, rich.deposits.length);
  const sum = (w: World): number => w.deposits.reduce((t, d) => t + d.maxAmount, 0);
  assert.ok(sum(rich) > sum(poor) * 2, 'rich claims should hold far more ore');
});

group('Named save store');

function fakeSnapshot(sol: number): Record<string, unknown> {
  return { version: 6, seed: 5, sol, clock: { sol } };
}

test('saves list most-recent-first and round-trip their snapshots', () => {
  const store = new SaveStore();
  const a = store.create(
    { name: 'Alpha', difficulty: 'pioneer', worldSize: 'medium', region: null, seedText: 'aa' },
    fakeSnapshot(1),
    1,
  );
  // The store orders by millisecond timestamps — cross a ms boundary so the
  // ordering assertion below is deterministic, not a same-ms coin flip.
  for (let guard = Date.now(); Date.now() === guard;) {
    /* spin, at most ~1 ms */
  }
  const b = store.create(
    { name: 'Beta', difficulty: 'settler', worldSize: 'small', region: 'Arcadia Planitia', seedText: 'bb' },
    fakeSnapshot(9),
    9,
  );
  assert.deepEqual(store.list().map((s) => s.id), [b, a]);
  const record = store.read(b);
  assert.equal(record?.meta.name, 'Beta');
  assert.equal((record?.data as { sol: number }).sol, 9);

  store.update(b, fakeSnapshot(10), 10);
  assert.equal(store.list()[0].sol, 10);

  store.rename(a, 'Alpha Prime');
  assert.equal(store.read(a)?.meta.name, 'Alpha Prime');

  store.remove(b);
  assert.deepEqual(store.list().map((s) => s.id), [a]);
});

test('unknown ids are harmless and the freshest save leads', () => {
  const store = new SaveStore();
  assert.equal(store.read('nope'), null);
  assert.equal(store.get('nope'), null);
  assert.equal(store.update('nope', fakeSnapshot(1), 1), false);
  assert.equal(store.rename('nope', 'Ghost'), false);
  assert.equal(store.remove('nope'), false);
  assert.equal(store.rename(store.list()[0]?.id ?? 'nope', '   '), false);

  for (let guard = Date.now(); Date.now() === guard;) {
    /* cross a ms boundary so Voyager is strictly the freshest save */
  }
  const id = store.create(
    { name: 'Voyager', difficulty: 'survivor', worldSize: 'planet', region: 'Hellas Planitia', seedText: 'cc' },
    fakeSnapshot(40),
    40,
  );
  assert.equal(store.mostRecent()?.id, id);
  assert.equal(store.get(id)?.difficulty, 'survivor');
  store.remove(id);
  assert.equal(store.get(id), null);
});

await finish('sim/setup');
