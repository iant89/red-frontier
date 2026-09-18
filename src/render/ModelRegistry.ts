/**
 * Asset registry: logical id → URL → cached Object3D template.
 *
 * Usage:
 *   await registry.load('rover/cargo');
 *   const mesh = registry.getClone('rover/cargo'); // null → use procedural
 *   // or
 *   const mesh = registry.getOrFallback('rover/cargo', () => makeProcedural());
 *
 * Missing catalog entries and failed loads both yield null / fallback — the
 * Renderer’s procedural meshes stay when no Leonardo `.glb` is present.
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

  /** Add or replace a catalog entry (does not load). */
  register(id: AssetId | string, url: string): void {
    this.urls.set(id, url);
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
   */
  async load(id: AssetId | string): Promise<Object3D | null> {
    if (!this.urls.has(id)) {
      this.statuses.set(id, 'unregistered');
      return null;
    }
    if (this.templates.has(id)) return this.templates.get(id)!;
    if (this.statuses.get(id) === 'failed') return null;

    const pending = this.inflight.get(id);
    if (pending) return pending;

    const url = this.urls.get(id)!;
    this.statuses.set(id, 'loading');
    const work = this.loader
      .load(url)
      .then((scene) => {
        // Keep the template out of any live scene; clones are handed out.
        scene.updateMatrixWorld(true);
        this.templates.set(id, scene);
        this.statuses.set(id, 'ready');
        this.inflight.delete(id);
        return scene;
      })
      .catch(() => {
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
   * procedural geometry.
   */
  getClone(id: AssetId | string): Object3D | null {
    const template = this.templates.get(id);
    if (!template) return null;
    return template.clone(true);
  }

  /** Prefer a loaded GLB clone; otherwise run the procedural factory. */
  getOrFallback(id: AssetId | string, fallback: () => Object3D): Object3D {
    return this.getClone(id) ?? fallback();
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
