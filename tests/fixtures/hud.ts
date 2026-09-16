/**
 * Shared setup for the `tests/hud/*` suites.
 *
 * The renderer needs a real GPU, but the HUD is plain DOM, so it can be mounted
 * headlessly under jsdom. Importing this module installs the globals the HUD
 * expects *before* the HUD module itself is pulled in — which is why `HUD` and
 * `Simulation` are imported dynamically here rather than statically.
 *
 * `mountHud()` wipes `#app` before building a chrome, so every suite gets a
 * document holding exactly one HUD and `getElementById` stays unambiguous even
 * when the linked run mounts suite after suite into the same jsdom instance.
 */

import { JSDOM } from 'jsdom';
import type { Building, Simulation } from '../../src/sim/Simulation';
import type { BuildingKind } from '../../src/sim/defs';
import type { HUD } from '../../src/ui/HUD';

const dom = new JSDOM(
  `<!doctype html><html><body><div id="app"><canvas id="game-canvas"></canvas></div></body></html>`,
  { pretendToBeVisual: true },
);

// Expose the jsdom globals the HUD module expects at import time.
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
// `navigator` is a getter-only global in modern Node; define it descriptively.
if (!('navigator' in g) || !g.navigator?.userAgent?.includes('jsdom')) {
  Object.defineProperty(g, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
}
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
g.CustomEvent = dom.window.CustomEvent;
g.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(0), 16);

// jsdom has no 2D canvas backend. `() => null` was the old answer, and it is a
// lie with consequences: the minimap, the world map and the power sparkline all
// bail out when `getContext('2d')` returns null, so every paint path in `ui/`
// was quietly absent from every HUD suite. The stub below is a *recording*
// no-op context instead — every 2D call is legal, and `paints` counts them, so
// a test can assert the map actually drew rather than merely survived.
//
// `setCanvasBackend('none')` restores the null answer, which is what a browser
// that refuses the context looks like. The HUD must still build in that world.
export const paints = {
  /** Total 2D calls issued into every canvas since the process started. */
  calls: 0,
  /** The same count, per `id`, so a test can say *which* canvas painted. */
  byCanvas: {} as Record<string, number>,
};

let canvasBackend: 'stub' | 'none' = 'stub';

/** Switch the fake 2D backend: a recording context, or no context at all. */
export function setCanvasBackend(next: 'stub' | 'none'): void {
  canvasBackend = next;
}

function stubContext2D(canvas: HTMLCanvasElement): any {
  const state: Record<string, unknown> = { canvas };
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (typeof prop !== 'string') return undefined;
      return () => {
        paints.calls++;
        if (canvas.id) paints.byCanvas[canvas.id] = (paints.byCanvas[canvas.id] ?? 0) + 1;
      };
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  });
}

(dom.window.HTMLCanvasElement.prototype as any).getContext = function (this: any, type: string) {
  if (type !== '2d' || canvasBackend === 'none') return null;
  return stubContext2D(this);
};

/** Every callback the HUD can fire, recorded as a string for assertions. */
export type CallLog = string[];

export interface HudFixture {
  dom: JSDOM;
  doc: Document;
  /** The `#app` element the HUD builds its chrome into. */
  app: HTMLElement;
  calls: CallLog;
  hud: HUD;
  sim: Simulation;
  /** The HUD class itself, for a suite that wants a second instance. */
  HUD: typeof HUD;
  /** Place `kind` at the first legal spot on a ring around the base. */
  place: (kind: BuildingKind) => Building;
}

let modules: Promise<[any, any, any]> | null = null;

function load(): Promise<[any, any, any]> {
  modules ??= Promise.all([
    import('../../src/ui/HUD'),
    import('../../src/sim/Simulation'),
    import('../../src/sim/defs'),
  ]);
  return modules;
}

/** The sim definition modules, for cases that need the blueprint tables. */
export async function loadDefs(): Promise<any> {
  const [, , defs] = await load();
  return defs;
}

/**
 * Mount a fresh HUD and simulation pair. The defaults mirror a normal opening
 * so every panel has something real to read; pass a seed to vary that.
 */
export async function mountHud(
  opts: { seed?: number; nearDeposits?: number } = {},
): Promise<HudFixture> {
  const [{ HUD }, { Simulation }] = await load();
  const doc = dom.window.document as unknown as Document;
  const app = doc.getElementById('app')!;
  app.innerHTML = ''; // one chrome per suite, so panel ids never collide

  const calls: CallLog = [];
  const hud = new HUD({
    onSpeed: (i: number) => calls.push(`speed:${i}`),
    onPickBuild: (k: string | null) => calls.push(`build:${k}`),
    onAction: (a: string, arg?: number | string) => calls.push(`action:${a}:${arg ?? ''}`),
    onStart: (seed: string, near: number) => calls.push(`start:${seed}:${near}`),
    onOverlay: (m: string) => calls.push(`overlay:${m}`),
  });
  const sim = new Simulation({
    seed: opts.seed ?? 42,
    nearDeposits: opts.nearDeposits ?? 0.2,
  });

  return {
    dom,
    doc,
    app,
    calls,
    hud,
    HUD,
    sim,
    place: (kind: BuildingKind) => {
      for (let r = 34; r <= 120; r += 2) {
        for (let a = 0; a < 360; a += 5) {
          const x = Math.round(Math.cos((a * Math.PI) / 180) * r);
          const z = Math.round(Math.sin((a * Math.PI) / 180) * r);
          if (sim.canPlace(kind, x, z) !== null) continue;
          const b = sim.placeBuilding(kind, x, z);
          if (b) return b;
        }
      }
      throw new Error(`no placeable spot found for ${kind}`);
    },
  };
}

/**
 * Run `fn` with the window's timers captured, so a hold-to-open gesture fires
 * synchronously and deterministically instead of on a real 450 ms timeout.
 */
export function withFakeTimers(
  fn: (timers: { fire: () => void; pending: () => boolean }) => void,
): void {
  const w = dom.window as any;
  const realSet = w.setTimeout;
  const realClear = w.clearTimeout;
  let held: (() => void) | null = null;
  w.setTimeout = (cb: () => void) => {
    held = cb;
    return 1;
  };
  w.clearTimeout = () => {
    held = null;
  };
  try {
    fn({
      fire: () => {
        const cb = held;
        held = null;
        cb?.();
      },
      pending: () => held !== null,
    });
  } finally {
    w.setTimeout = realSet;
    w.clearTimeout = realClear;
  }
}

/** A pointer event carrying a `pointerType`, the way a touch would. */
export function press(target: any, type: string, x = 100, y = 100): void {
  const ev = new dom.window.Event(type, { bubbles: true }) as any;
  ev.pointerType = 'touch';
  ev.clientX = x;
  ev.clientY = y;
  target.dispatchEvent(ev);
}
