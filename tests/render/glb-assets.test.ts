/**
 * @suite render/glb-assets
 * @group unit
 * @covers src/render/ModelRegistry.ts src/render/GlbLoader.ts src/render/assetCatalog.ts
 * @desc GLB asset registry: URL resolve, load success (fixture / mock), missing
 * id and failed load both fall back to procedural meshes; light-target rebind,
 * register URL invalidate, failed-load retry.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { DEFAULT_ASSET_CATALOG, buildingAssetId, roverAssetId } from '../../src/render/assetCatalog';
import { GlbLoader, type GlbLoaderLike } from '../../src/render/GlbLoader';
import { ModelRegistry, rebindLightTargets } from '../../src/render/ModelRegistry';
import { group, test, finish } from '../harness';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_PATH = path.join(root, 'public/models/_fixtures/placeholder.glb');
const FIXTURE_URL = '/models/_fixtures/placeholder.glb';

function proceduralBox(): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'procedural';
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
  return g;
}

/** Template with a SpotLight whose target is a parented sibling (GLB-like). */
function spotlightSiblingTemplate(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'lit';
  const light = new THREE.SpotLight(0xffffff, 1);
  light.name = 'spot';
  light.position.set(0, 2, 0);
  const target = new THREE.Object3D();
  target.name = 'spotTarget';
  target.position.set(1, 0, 0);
  light.target = target;
  root.add(light);
  root.add(target);
  return root;
}

group('Catalog resolve');

test('default catalog maps rover/building ids to /models/… URLs (no fixture entry)', () => {
  assert.equal(DEFAULT_ASSET_CATALOG['rover/cargo'], '/models/rovers/cargo.glb');
  assert.equal(DEFAULT_ASSET_CATALOG['building/solar'], '/models/buildings/solar.glb');
  assert.equal(DEFAULT_ASSET_CATALOG['prop/placeholder'], undefined);
  assert.equal(roverAssetId('mining'), 'rover/mining');
  assert.equal(buildingAssetId('weatherStation'), 'building/weatherStation');
});

test('registry.resolveUrl returns the catalog URL or null for unknowns', () => {
  const reg = new ModelRegistry();
  assert.equal(reg.resolveUrl('rover/cargo'), '/models/rovers/cargo.glb');
  assert.equal(reg.resolveUrl('building/solar'), '/models/buildings/solar.glb');
  assert.equal(reg.resolveUrl('no/such/asset'), null);
  assert.equal(reg.status('no/such/asset'), 'unregistered');
});

group('Load success');

test('mocked loader caches a template and getClone returns distinct trees', async () => {
  const loader: GlbLoaderLike = {
    async load(url) {
      const g = new THREE.Group();
      g.name = `loaded:${url}`;
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5)));
      return g;
    },
  };
  const reg = new ModelRegistry({ loader });
  const template = await reg.load('rover/cargo');
  assert.ok(template, 'load should succeed');
  assert.equal(reg.status('rover/cargo'), 'ready');
  assert.equal(reg.isReady('rover/cargo'), true);

  const a = reg.getClone('rover/cargo');
  const b = reg.getClone('rover/cargo');
  assert.ok(a && b);
  assert.notEqual(a, b, 'clones must be distinct Object3Ds');
  assert.notEqual(a, template, 'getClone must not hand out the template');
  assert.equal(a!.name, `loaded:/models/rovers/cargo.glb`);
});

test('fixture .glb parses via GLTFLoader.parse (no network)', async () => {
  assert.ok(fs.existsSync(FIXTURE_PATH), 'placeholder.glb must be in the repo');
  const bytes = fs.readFileSync(FIXTURE_PATH);
  // Node Buffer → ArrayBuffer slice for three's parser
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loader = new GlbLoader();
  const scene = await loader.parse!(ab);
  assert.ok(scene);
  assert.ok(scene.children.length >= 1 || scene.type === 'Group' || scene.type === 'Object3D');

  // Wire parse through a registry-shaped loader so load() succeeds without fetch.
  // Fixture id is injected — not part of DEFAULT_ASSET_CATALOG.
  const inject: GlbLoaderLike = {
    async load(_url) {
      return loader.parse!(ab);
    },
  };
  const reg = new ModelRegistry({
    catalog: { 'prop/placeholder': FIXTURE_URL },
    loader: inject,
  });
  const got = await reg.load('prop/placeholder');
  assert.ok(got);
  assert.equal(reg.status('prop/placeholder'), 'ready');
  const clone = reg.getClone('prop/placeholder');
  assert.ok(clone);
});

group('Light target rebind');

test('getClone rebinds SpotLight.target to the cloned sibling (not an orphan)', async () => {
  const template = spotlightSiblingTemplate();
  const loader: GlbLoaderLike = {
    async load() {
      return template;
    },
  };
  const reg = new ModelRegistry({
    catalog: { 'prop/lit': '/models/props/lit.glb' },
    loader,
  });
  await reg.load('prop/lit');
  const clone = reg.getClone('prop/lit');
  assert.ok(clone);

  const light = clone!.getObjectByName('spot') as THREE.SpotLight;
  const sibling = clone!.getObjectByName('spotTarget');
  assert.ok(light && light.isSpotLight);
  assert.ok(sibling);
  assert.equal(light.target, sibling, 'target must be the cloned sibling in the tree');
  assert.ok(light.target.parent, 'target must be parented');
  assert.notEqual(light.target, template.getObjectByName('spotTarget'));
});

test('rebindLightTargets parents orphan target when source target was unparented', () => {
  const source = new THREE.Group();
  const light = new THREE.SpotLight();
  light.name = 'spot';
  // Default SpotLight.target is unparented
  source.add(light);
  const clone = source.clone(true);
  const clonedLight = clone.getObjectByName('spot') as THREE.SpotLight;
  assert.ok(clonedLight);
  assert.equal(clonedLight.target.parent, null, 'precondition: three leaves target unparented');

  rebindLightTargets(source, clone);
  assert.ok(clonedLight.target.parent, 'orphan target should be parented into the clone tree');
  assert.ok(
    clonedLight.target.parent === clone || clonedLight.target.parent === clonedLight,
    'parent should be clone root or the light',
  );
});

group('Fallback paths');

test('missing id → load null, getClone null; caller uses local procedural fallback', async () => {
  const reg = new ModelRegistry({ catalog: {} });
  const loaded = await reg.load('rover/cargo');
  assert.equal(loaded, null);
  assert.equal(reg.getClone('rover/cargo'), null);
  assert.equal(reg.resolveUrl('rover/cargo'), null);

  const mesh = reg.getClone('rover/cargo') ?? proceduralBox();
  assert.equal(mesh.name, 'procedural');
});

test('failed load → status failed; getClone null; explicit load retries', async () => {
  let hits = 0;
  const loader: GlbLoaderLike = {
    async load() {
      hits += 1;
      if (hits === 1) throw new Error('404 Not Found');
      const g = new THREE.Group();
      g.name = 'recovered';
      return g;
    },
  };
  const reg = new ModelRegistry({
    catalog: { 'rover/cargo': '/models/rovers/cargo.glb' },
    loader,
  });
  const loaded = await reg.load('rover/cargo');
  assert.equal(loaded, null);
  assert.equal(reg.status('rover/cargo'), 'failed');
  assert.equal(reg.getClone('rover/cargo'), null);

  const mesh = reg.getClone('rover/cargo') ?? proceduralBox();
  assert.equal(mesh.name, 'procedural');

  // Explicit load() clears sticky failure and refetches.
  const retry = await reg.load('rover/cargo');
  assert.ok(retry);
  assert.equal(reg.status('rover/cargo'), 'ready');
  assert.equal(reg.getClone('rover/cargo')!.name, 'recovered');
  assert.equal(hits, 2, 'second explicit load must hit the loader again');

  // Concurrent loads while already ready do not re-hit.
  await reg.load('rover/cargo');
  await reg.preload(['rover/cargo']);
  assert.equal(hits, 2, 'ready template must not refetch');
});

test('register overrides URL and enables a late-added asset', async () => {
  const loader: GlbLoaderLike = {
    async load(url) {
      const g = new THREE.Group();
      g.name = url;
      return g;
    },
  };
  const reg = new ModelRegistry({ catalog: {}, loader });
  assert.equal(reg.resolveUrl('prop/crate'), null);
  reg.register('prop/crate', '/models/props/crate.glb');
  assert.equal(reg.resolveUrl('prop/crate'), '/models/props/crate.glb');
  await reg.load('prop/crate');
  assert.equal(reg.getClone('prop/crate')!.name, '/models/props/crate.glb');
});

test('register URL change drops template/inflight and resets to idle', async () => {
  const loader: GlbLoaderLike = {
    async load(url) {
      const g = new THREE.Group();
      g.name = url;
      return g;
    },
  };
  const reg = new ModelRegistry({
    catalog: { 'prop/crate': '/models/props/crate-v1.glb' },
    loader,
  });
  await reg.load('prop/crate');
  assert.equal(reg.status('prop/crate'), 'ready');
  assert.equal(reg.getClone('prop/crate')!.name, '/models/props/crate-v1.glb');

  reg.register('prop/crate', '/models/props/crate-v2.glb');
  assert.equal(reg.resolveUrl('prop/crate'), '/models/props/crate-v2.glb');
  assert.equal(reg.status('prop/crate'), 'idle');
  assert.equal(reg.getClone('prop/crate'), null, 'old template must be dropped');
  assert.equal(reg.isReady('prop/crate'), false);

  await reg.load('prop/crate');
  assert.equal(reg.status('prop/crate'), 'ready');
  assert.equal(reg.getClone('prop/crate')!.name, '/models/props/crate-v2.glb');
});

await finish('render/glb-assets');
