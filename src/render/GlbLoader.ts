/**
 * Thin GLTFLoader wrapper for `.glb` files under `public/models/`.
 *
 * Injectable so unit tests can mock network I/O or feed `GLTFLoader.parse`
 * without a browser fetch.
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Object3D } from 'three';

/** Minimal surface the ModelRegistry needs from a loader. */
export interface GlbLoaderLike {
  load(url: string): Promise<Object3D>;
  /** Optional: parse raw GLB bytes (used by fixture tests). */
  parse?(data: ArrayBuffer, path?: string): Promise<Object3D>;
}

export class GlbLoader implements GlbLoaderLike {
  private readonly loader = new GLTFLoader();

  load(url: string): Promise<Object3D> {
    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => resolve(gltf.scene),
        undefined,
        (err) => reject(err instanceof Error ? err : new Error(String(err))),
      );
    });
  }

  parse(data: ArrayBuffer, path = ''): Promise<Object3D> {
    return new Promise((resolve, reject) => {
      this.loader.parse(
        data,
        path,
        (gltf) => resolve(gltf.scene),
        (err) => reject(err instanceof Error ? err : new Error(String(err))),
      );
    });
  }
}
