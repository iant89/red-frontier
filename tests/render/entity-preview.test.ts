/**
 * @suite render/entity-preview
 * @group unit
 * @covers src/render/EntityAppearance.ts src/render/EntityPreview.ts
 * @desc Paint and preview clones own geometry/materials and preserve factory
 * finishes without recolouring other entities or mechanical details.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applyEntityPaint,
  clonePreviewModel,
  disposePreviewResources,
} from '../../src/render/EntityAppearance';
import { EntityPreview } from '../../src/render/EntityPreview';
import { test, finish } from '../harness';

test('paint changes a body, not tyres or another entity sharing its factory material', () => {
  const root = new THREE.Group();
  const shared = new THREE.MeshStandardMaterial({ color: 0xaabbaa });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), shared);
  body.userData.paintable = true;
  const tyre = new THREE.Mesh(
    new THREE.SphereGeometry(0.3),
    new THREE.MeshStandardMaterial({ color: 0x111111 }),
  );
  const other = new THREE.Mesh(body.geometry, shared);
  root.add(body, tyre);
  applyEntityPaint(root, '#d67635');
  assert.equal(
    (body.material as THREE.MeshStandardMaterial).color.getHexString(),
    'd67635',
  );
  assert.equal(shared.color.getHexString(), 'aabbaa');
  assert.equal(
    (tyre.material as THREE.MeshStandardMaterial).color.getHexString(),
    '111111',
  );
  applyEntityPaint(root, null);
  assert.equal(
    (body.material as THREE.MeshStandardMaterial).color.getHexString(),
    'aabbaa',
  );
  assert.equal(other.material, shared);
});
test('preview geometry/materials are independently disposable and factory reset works after cloning paint', () => {
  const root = new THREE.Group();
  root.position.set(100, 5, 60);
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xc8c0ab }),
  );
  body.userData.paintable = true;
  root.add(body);
  applyEntityPaint(root, '#d67635');
  const preview = clonePreviewModel(root),
    clone = preview.children[0] as THREE.Mesh;
  assert.equal(preview.position.length(), 0);
  assert.notEqual(clone.geometry, body.geometry);
  assert.notEqual(clone.material, body.material);
  applyEntityPaint(preview, '#4b896a');
  assert.equal(
    (body.material as THREE.MeshStandardMaterial).color.getHexString(),
    'd67635',
  );
  applyEntityPaint(preview, null);
  assert.equal(
    (clone.material as THREE.MeshStandardMaterial).color.getHexString(),
    'c8c0ab',
  );
});
test('disposal owns lines and meshes, borrows textures, and cleans up a failed context constructor', () => {
  const source = new THREE.Group(),
    texture = new THREE.Texture();
  source.add(
    new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ map: texture }),
    ),
  );
  source.add(
    new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial(),
    ),
  );
  let borrowedDisposed = 0,
    ownedDisposed = 0;
  texture.addEventListener('dispose', () => borrowedDisposed++);
  source.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
      o.geometry.addEventListener('dispose', () => borrowedDisposed++);
      (o.material as THREE.Material).addEventListener(
        'dispose',
        () => borrowedDisposed++,
      );
    }
  });
  const preview = clonePreviewModel(source);
  preview.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
      o.geometry.addEventListener('dispose', () => ownedDisposed++);
      (o.material as THREE.Material).addEventListener(
        'dispose',
        () => ownedDisposed++,
      );
    }
  });
  disposePreviewResources(preview);
  assert.equal(ownedDisposed, 4);
  assert.equal(borrowedDisposed, 0);
  const partial = clonePreviewModel(source);
  let released = false;
  (partial.children[0] as THREE.Mesh).geometry.addEventListener(
    'dispose',
    () => (released = true),
  );
  const win = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const cancel = Object.getOwnPropertyDescriptor(
    globalThis,
    'cancelAnimationFrame',
  );
  Reflect.set(globalThis, 'window', { matchMedia: () => ({ matches: false }) });
  Reflect.set(globalThis, 'cancelAnimationFrame', () => {});
  try {
    // No document/WebGL exists in this node suite: construction must fail cleanly.
    assert.throws(() => new EntityPreview({} as HTMLElement, partial));
    assert.equal(released, true);
    assert.equal(borrowedDisposed, 0);
  } finally {
    if (win) Object.defineProperty(globalThis, 'window', win);
    else Reflect.deleteProperty(globalThis, 'window');
    if (cancel)
      Object.defineProperty(globalThis, 'cancelAnimationFrame', cancel);
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  }
});
await finish('render/entity-preview');
