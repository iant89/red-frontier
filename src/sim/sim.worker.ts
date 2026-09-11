/**
 * The worker entry point: a bolt, nothing more.
 *
 * It deliberately contains no simulation logic and no imports beyond the runtime
 * factory — if this file ever grows a `document` reference, a `three` import or
 * a piece of game state that only lives here, the boundary has leaked. Keeping it
 * at seven lines is the cheapest guard on that.
 *
 * Vite bundles it as an ES module from the `new Worker(new URL(...))` call in
 * `host/index.ts`, so it shares no instance with the main-thread copy of `World`
 * or the defs — that is why every type crossing the boundary is plain data.
 */

/// <reference lib="webworker" />

import { createSimRuntime } from './host/workerRuntime';

const runtime = createSimRuntime((reply) => {
  (self as unknown as Worker).postMessage(reply);
});

self.onmessage = (event: MessageEvent) => {
  runtime.handle(event.data);
};
