/**
 * The factory: one call, either transport.
 *
 * `Game` asks for a host and gets one; which side of a thread boundary the colony
 * lives on is decided here and nowhere else. That is the shape the migration to a
 * worker needed — the alternative was a fork in `Game.loop`, which is how a
 * refactor like this ends up half-tested on one path and half-shipped on the other.
 *
 * The worker is selected with `?worker=1` and otherwise stays off. Deliberately:
 * the in-process host is what every existing test drives and what the mobile smoke
 * gate exercises, so the seam lands green first and the worker earns its default
 * by passing the same gates. `?worker=0` forces it off even if the default flips.
 *
 * Falling back is not a courtesy. A page served from `file:`, a browser without
 * module-worker support, or an environment where `new Worker` throws would each
 * otherwise show a blank screen; they get the game on this thread instead, with a
 * console line saying why.
 */

import { createLocalHost, restoreLocalHost } from './LocalSimHost';
import { WorkerSimHost } from './WorkerSimHost';
import type { SimHost } from './SimHost';
import type { HostPort } from './messages';
import type { SimBootParams, SimSnapshot } from './view';

/** Which transport to use. Omitted means: whatever the URL asks for. */
export interface HostChoice {
  worker?: boolean;
}

/** Whether this environment can host a worker at all. */
export function workerSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof structuredClone === 'function';
}

/**
 * `?worker=1` turns the boundary on, `?worker=0` turns it off, and anything else
 * (including a malformed value) leaves the default. Pure and parameterised
 * because the alternative is a test that has to navigate a browser.
 */
export function wantsWorker(search: string, fallback = false): boolean {
  const raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('worker');
  if (raw === null) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === '1' || value === 'true' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'off') return false;
  return fallback;
}

/**
 * The module worker entry. Written as `new URL(...)` rather than a path string so
 * the bundler emits it as a separate chunk with a hashed name — a plain
 * `'./sim.worker.js'` would be resolved against the *page*, which works in dev and
 * silently breaks in a build.
 */
function spawnWorker(): Worker {
  return new Worker(new URL('../sim.worker.ts', import.meta.url), { type: 'module' });
}

export interface HostPlan {
  transport: 'in-process' | 'worker';
  reason: string;
}

/** What the factory would pick, for the loading screen and for tests. */
export function planHost(search: string): HostPlan {
  const asked = wantsWorker(search);
  if (!asked) return { transport: 'in-process', reason: 'default (in-process host)' };
  if (!workerSupported())
    return { transport: 'in-process', reason: 'worker requested but unavailable in this browser' };
  return { transport: 'worker', reason: 'requested via ?worker=1' };
}

async function withFallback(host: Promise<SimHost>, make: () => SimHost, why: string): Promise<SimHost> {
  try {
    return await host;
  } catch (err) {
    console.warn(`[sim:host] ${why}; falling back to the in-process host`, err);
    return make();
  }
}

/** Boot a fresh colony behind whichever host the environment picked. */
export async function createHost(params: SimBootParams, choice: HostChoice = {}): Promise<SimHost> {
  const useWorker =
    choice.worker ?? (typeof location === 'undefined' ? false : wantsWorker(location.search));
  if (!useWorker || !workerSupported()) {
    if (useWorker) console.warn('[sim:host] worker requested but unavailable; using the in-process host');
    return createLocalHost(params);
  }
  return withFallback(
    WorkerSimHost.connect(spawnWorker() as unknown as HostPort, { boot: params }),
    () => createLocalHost(params),
    'the worker failed to boot',
  );
}

/** Resume a saved colony. The save names its own seed, so both hosts agree. */
export async function restoreHost(
  snapshot: SimSnapshot,
  choice: HostChoice = {},
  fallbackSeed = 1,
): Promise<SimHost> {
  const useWorker =
    choice.worker ?? (typeof location === 'undefined' ? false : wantsWorker(location.search));
  if (!useWorker || !workerSupported()) {
    if (useWorker) console.warn('[sim:host] worker requested but unavailable; using the in-process host');
    return restoreLocalHost(snapshot, fallbackSeed);
  }
  return withFallback(
    WorkerSimHost.connect(spawnWorker() as unknown as HostPort, { restore: snapshot }),
    () => restoreLocalHost(snapshot, fallbackSeed),
    'the worker failed to restore',
  );
}
