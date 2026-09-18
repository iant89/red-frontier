/**
 * Asset registry: logical id → URL → cached Object3D template.
 *
 * Usage:
 *   await registry.load('rover/cargo');
 *   const mesh = registry.getClone('rover/cargo'); // null → use procedural
 *
 * Missing catalog entries and failed loads both yield null — the Renderer's
 * procedural meshes stay when no Leonardo `.glb` is present. Explicit
 * `load()` / `preload()` retries after a prior failure.
 */
import type { Object3D } from 'three';
import { DEFAULT_ASSET_CATALOG, type AssetId } from './assetCatalog';
import { GlbLoader, type GlbLoaderLike } from './GlbLoader';

export type ModelLoadStatus = 'unregistered' | 'idle' | 'loading' | 'ready' | 'failed';

export interface ModelRegistryOptions {
  /** Override or extend the default catalog. */
  catalog?: Readonly<Record<string, string>>;
  /** Inject a loader (tests). Default: real GLTFLoader wrapper. */
  loader?: GlbLoaderLike;
}

/**
 * After `Object3D.clone(true)`, SpotLight/DirectionalLight `.target` is a fresh
 * unparented Object3D (see three's Light.copy). Rebind to the cloned former
 * target in the tree when it was a sibling; otherwise parent the orphan.
 */
export function rebindLightTargets(source: Object3D, clone: Object3D): void {
  const sourceObjs: Object3D[] = [];
  const cloneObjs: Object3D[] = [];
  source.traverse((o) => {
    sourceObjs.push(o);
  });
  clone.traverse((o) => {
    cloneObjs.push(o);
  });
  // Parallel traverse keeps corresponding indices for shared hierarchy nodes.
  const n = Math.min(sourceObjs.length, cloneObjs.length);
  for (let i = 0; i < n; i++) {
    const s = sourceObjs[i]!;
    const c = cloneObjs[i]!;
    const srcLight = s as Object3D & { isLight?: boolean; target?: Object3D };
    const dstLight = c as Object3D & { isLight?: boolean; target?: Object3D };
    if (!srcLight.isLight || !srcLight.target || !dstLight.isLight || !dstLight.target) continue;

    const srcIdx = sourceObjs.indexOf(srcLight.target);
    if (srcIdx !== -1 && srcIdx < cloneObjs.length) {
      dstLight.target = cloneObjs[srcIdx]!;
    } else if (!dstLight.target.parent) {
      const parent = dstLight.parent ?? clone;
      parent.add(dstLight.target);
    }
  }
}

export class ModelRegistry {
  private readonly urls = new Map<string, string>();
  private readonly templates = new Map<string, Object3D>();
  private readonly statuses = new Map<string, ModelLoadStatus>();
  private readonly inflight = new Map<string, Promise<Object3D | null>>();
  private readonly loader: GlbLoaderLike;

  constructor(opts: ModelRegistryOptions = {}) {
    const catalog = opts.catalog ?? DEFAULT_ASSET_CATALOG;
    for (const [id, url] of Object.entries(catalog)) {
      this.urls.set(id, url);
      this.statuses.set(id, 'idle');
    }
    this.loader = opts.loader ?? new GlbLoader();
  }

  /** Resolve the public URL for a logical id, or null if unregistered. */
  resolveUrl(id: AssetId | string): string | null {
    return this.urls.get(id) ?? null;
  }

  /**
   * Add or replace a catalog entry (does not load). On URL change, drop any
   * cached template / inflight promise and reset status to idle so the next
   * `load()` fetches the new file.
   */
  register(id: AssetId | string, url: string): void {
    const prev = this.urls.get(id);
    this.urls.set(id, url);
    if (prev !== undefined && prev !== url) {
      this.templates.delete(id);
      this.inflight.delete(id);
      this.statuses.set(id, 'idle');
      return;
    }
    if (!this.templates.has(id) && this.statuses.get(id) !== 'loading') {
      this.statuses.set(id, 'idle');
    }
  }

  status(id: AssetId | string): ModelLoadStatus {
    if (!this.urls.has(id)) return 'unregistered';
    return this.statuses.get(id) ?? 'idle';
  }

  /**
   * Load and cache the template for `id`. Returns the template (not a clone),
   * or null when unregistered / load failed. Concurrent calls share one fetch.
   * A prior `failed` status is cleared so an explicit load/preload can retry.
   */
  async load(id: AssetId | string): Promise<Object3D | null> {
    if (!this.urls.has(id)) {
      this.statuses.set(id, 'unregistered');
      return null;
    }
    if (this.templates.has(id)) return this.templates.get(id)!;

    const pending = this.inflight.get(id);
    if (pending) return pending;

    const url = this.urls.get(id)!;
    this.statuses.set(id, 'loading');
    const work = this.loader
      .load(url)
      .then((scene) => {
        // Stale completion after register() swapped the URL — discard.
        if (this.urls.get(id) !== url) {
          this.inflight.delete(id);
          return null;
        }
        // Keep the template out of any live scene; clones are handed out.
        scene.updateMatrixWorld(true);
        this.templates.set(id, scene);
        this.statuses.set(id, 'ready');
        this.inflight.delete(id);
        return scene;
      })
      .catch(() => {
        if (this.urls.get(id) !== url) {
          this.inflight.delete(id);
          return null;
        }
        this.statuses.set(id, 'failed');
        this.inflight.delete(id);
        return null;
      });
    this.inflight.set(id, work);
    return work;
  }

  /**
   * Synchronous clone of a successfully loaded template, or null.
   * Call after `await load(id)` (or `preload`) when a GLB should replace
   * procedural geometry. Rebinds SpotLight/DirectionalLight targets so
   * clone(true) does not leave lights aiming at orphan Object3Ds.
   */
  getClone(id: AssetId | string): Object3D | null {
    const template = this.templates.get(id);
    if (!template) return null;
    const clone = template.clone(true);
    rebindLightTargets(template, clone);
    return clone;
  }

  /** Load many ids (default: every catalog entry). Failures are swallowed. */
  async preload(ids?: ReadonlyArray<string>): Promise<void> {
    const list = ids ?? [...this.urls.keys()];
    await Promise.all(list.map((id) => this.load(id)));
  }

  /** True when a template is cached and ready to clone. */
  isReady(id: AssetId | string): boolean {
    return this.statuses.get(id) === 'ready' && this.templates.has(id);
  }
}
