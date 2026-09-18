/**
 * @suite render/glb-assets
 * @group unit
 * @covers src/render/ModelRegistry.ts src/render/GlbLoader.ts src/render/assetCatalog.ts
 * @desc GLB asset registry: URL resolve, load success (fixture / mock), missing
 * id and failed load both fall back to procedural meshes.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { DEFAULT_ASSET_CATALOG, buildingAssetId, roverAssetId } from '../../src/render/assetCatalog';
import { GlbLoader, type GlbLoaderLike } from '../../src/render/GlbLoader';
import { ModelRegistry } from '../../src/render/ModelRegistry';
import { group, test, finish } from '../harness';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_PATH = path.join(root, 'public/models/_fixtures/placeholder.glb');

function proceduralBox(): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'procedural';
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
  return g;
}

group('Catalog resolve');

test('default catalog maps rover/building/prop ids to /models/… URLs', () => {
  assert.equal(DEFAULT_ASSET_CATALOG['rover/cargo'], '/models/rovers/cargo.glb');
  assert.equal(DEFAULT_ASSET_CATALOG['building/solar'], '/models/buildings/solar.glb');
  assert.equal(DEFAULT_ASSET_CATALOG['prop/placeholder'], '/models/_fixtures/placeholder.glb');
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
  const inject: GlbLoaderLike = {
    async load(_url) {
      return loader.parse!(ab);
    },
  };
  const reg = new ModelRegistry({
    catalog: { 'prop/placeholder': '/models/_fixtures/placeholder.glb' },
    loader: inject,
  });
  const got = await reg.load('prop/placeholder');
  assert.ok(got);
  assert.equal(reg.status('prop/placeholder'), 'ready');
  const clone = reg.getClone('prop/placeholder');
  assert.ok(clone);
});

group('Fallback paths');

test('missing id → load null, getClone null, getOrFallback uses procedural', async () => {
  const reg = new ModelRegistry({ catalog: {} });
  const loaded = await reg.load('rover/cargo');
  assert.equal(loaded, null);
  assert.equal(reg.getClone('rover/cargo'), null);
  assert.equal(reg.resolveUrl('rover/cargo'), null);

  const mesh = reg.getOrFallback('rover/cargo', proceduralBox);
  assert.equal(mesh.name, 'procedural');
});

test('failed load → status failed, getOrFallback uses procedural', async () => {
  const loader: GlbLoaderLike = {
    async load() {
      throw new Error('404 Not Found');
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

  const mesh = reg.getOrFallback('rover/cargo', proceduralBox);
  assert.equal(mesh.name, 'procedural');

  // Second load short-circuits without re-hitting the loader.
  let hits = 0;
  const counting: GlbLoaderLike = {
    async load() {
      hits += 1;
      throw new Error('404');
    },
  };
  const reg2 = new ModelRegistry({
    catalog: { 'building/solar': '/models/buildings/solar.glb' },
    loader: counting,
  });
  await reg2.load('building/solar');
  await reg2.load('building/solar');
  assert.equal(hits, 1, 'failed loads must not retry forever');
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

await finish('render/glb-assets');
