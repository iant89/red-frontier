/**
 * @suite app/pause-save
 * @group integration
 * @covers src/app/Game.ts
 * @desc The return-to-menu hand-off must not dispose the host before the save
 * settles (the "Save failed — the colony could not be read" bug), a failed
 * save raises the recovery prompt with the right options per context,
 * "save as new file" writes a fresh slot, and the pause menu owns the
 * keyboard and the sim clock while it is open.
 */

import assert from 'node:assert/strict';
import { mountHud, loadDefs } from '../fixtures/hud';
import { Game } from '../../src/app/Game';
import { group, test, finish, linked } from '../harness';

// The fixture installs the jsdom globals the Game constructor expects
// (canvas, rAF, window) before any of its UI modules run.
const { dom, sim } = await mountHud();
const { ROVERS } = await loadDefs();
void ROVERS;

const doc = dom.window.document as unknown as Document;
const win = dom.window as any;

// The Game constructor's main menu pings GitHub for the build badge. In a
// test that fetch would race the network (and can hold the process open):
// answer it immediately with a failure instead.
(globalThis as any).fetch = (url: unknown) =>
  Promise.reject(new Error(`no network in tests (${String(url).slice(0, 40)})`));

/**
 * Every Game builds its own HUD chrome into #app, so a stale chrome would
 * give getElementById two answers. Freshen the document per Game: clear
 * #app and restore the canvas the constructor grabs by id.
 */
function freshApp(): void {
  const app = doc.getElementById('app') as HTMLElement;
  app.innerHTML = '';
  const canvas = doc.createElement('canvas');
  canvas.id = 'game-canvas';
  app.appendChild(canvas);
}
freshApp();

/** A stand-in host: the real sim behind the view, a scriptable snapshot. */
function makeHost(failFirst = 0, delayMs = 25) {
  let fails = failFirst;
  const state = { disposed: false, snapshots: 0 };
  const host: any = {
    transport: 'worker',
    view: sim,
    step: () => {},
    send: () => {},
    request: () => ({ ok: true }),
    requestPlacement: async () => ({ ok: true }),
    drainEvents: () => [],
    syncOverlays: () => {},
    requestSnapshot: () =>
      new Promise((resolve, reject) => {
        win.setTimeout(() => {
          state.snapshots++;
          if (fails > 0) {
            fails--;
            reject(new Error('the colony has shut down'));
          } else {
            resolve(sim.snapshot());
          }
        }, delayMs);
      }),
    loadSnapshot: async () => {},
    dispose: () => {
      state.disposed = true;
    },
  };
  return { host, state };
}

/** A Game wired with a live host and a real save slot, no launch(). */
async function makeGame(host: any) {
  freshApp();
  const game = new Game();
  const g = game as any;
  g.host = host;
  g.saveId = g.store.create(
    { name: 'Test Colony', difficulty: 'pioneer', worldSize: 'medium', region: null, seedText: 'test' },
    sim.snapshot(),
    1,
  );
  g.started = true;
  return game;
}

const wait = (ms: number) => new Promise((r) => win.setTimeout(r, ms));

const overlay = (id: string) => doc.getElementById(id)! as HTMLElement;

// ---------------------------------------------------------- return to menu --

group('Return-to-menu hand-off');

test('the host is not disposed before the save settles', async () => {
  const { host, state } = makeHost();
  const game = await makeGame(host);
  const g = game as any;

  // The hand-off ends in a page reload, which jsdom cannot perform: swallow
  // the teardown's 700 ms reload timer and prove it was scheduled at all —
  // everything else (the snapshot hop, the fades) runs on real timers.
  const realSetTimeout = win.setTimeout.bind(win);
  let reloadScheduled = 0;
  win.setTimeout = ((f: () => void, d?: number) => {
    if (d === 700) {
      reloadScheduled++;
      return 999999;
    }
    return realSetTimeout(f, d);
  }) as typeof win.setTimeout;

  g.returnToMenu();
  assert.equal(state.disposed, false, 'dispose must wait for the save (the bug)');
  assert.equal(g.started, true, 'the colony is still running mid-save');
  assert.equal(overlay('save-progress').style.display, 'flex', 'the progress dialog is up');
  assert.match(overlay('sp-title').textContent, /Returning to main menu/);

  await wait(120);
  assert.equal(state.disposed, true, 'and only now does the host go');
  assert.equal(g.started, false);
  assert.equal(overlay('save-error').style.display, 'none', 'no error prompt on a clean save');
  assert.equal(reloadScheduled, 1, 'the menu reload is scheduled by the teardown');
  win.setTimeout = realSetTimeout;
});

group('Save failure');

test('a failed menu save raises the prompt with return-without-saving', async () => {
  const { host, state } = makeHost(99);
  const game = await makeGame(host);

  (game as any).returnToMenu();
  await wait(120);
  assert.equal(overlay('save-error').style.display, 'flex', 'the prompt is up');
  assert.equal(overlay('save-progress').style.display, 'none', 'the progress card gave way to it');
  assert.match(overlay('se-reason').textContent, /could not be read/i);
  assert.equal(overlay('se-abandon').style.display, '', 'abandon is offered in the menu context');
  assert.equal(state.disposed, false, 'the colony is still alive for the retry');
  assert.equal((game as any).started, true, 'and the game is still running');
});

test('retrying the failed menu save completes the hand-off', async () => {
  const { host, state } = makeHost(1); // first snapshot fails, the retry succeeds
  const game = await makeGame(host);
  const g = game as any;

  g.returnToMenu();
  await wait(120);
  assert.equal(overlay('save-error').style.display, 'flex');
  assert.equal(state.disposed, false);

  overlay('se-retry').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  await wait(150);
  assert.equal(state.disposed, true, 'the retry disposed the host');
  assert.equal(overlay('save-error').style.display, 'none', 'the prompt closed on success');
  assert.equal(g.started, false);
});

test('a failed manual save prompts without the abandon option', async () => {
  const { host, state } = makeHost(99);
  const game = await makeGame(host);

  (game as any).manualSave();
  await wait(120);
  assert.equal(overlay('save-error').style.display, 'flex');
  assert.equal(overlay('se-abandon').style.display, 'none', 'no "leave" on a plain save');
  assert.equal(state.disposed, false, 'the world keeps running');

  overlay('se-dismiss').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(overlay('save-error').style.display, 'none', '"keep playing" just closes it');
  assert.equal((game as any).started, true);
});

test('return-without-saving tears down without another write', async () => {
  const { host, state } = makeHost(99);
  const game = await makeGame(host);
  const g = game as any;

  g.returnToMenu();
  await wait(120);
  assert.equal(overlay('save-error').style.display, 'flex');
  const snapshotsBefore = state.snapshots;

  overlay('se-abandon').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(state.snapshots, snapshotsBefore, 'no further snapshot is requested');
  assert.equal(state.disposed, true, 'the hand-off finishes');
  assert.equal(g.started, false);
});

test('save as new file writes a fresh slot and adopts the identity', async () => {
  const { host } = makeHost();
  const game = await makeGame(host);
  const g = game as any;
  const store: any = g.store;
  const oldId = g.saveId;
  const metasBefore = store.list().length;

  (game as any).manualSave(); // open the progress card like the real flow
  await wait(120);
  g.saveAsNew();
  await wait(150);

  const metas = store.list();
  assert.equal(metas.length, metasBefore + 1, 'a new slot exists');
  assert.notEqual(g.saveId, oldId, 'the game now writes to the new slot');
  assert.equal(store.get(g.saveId)?.name, 'Test Colony', 'identity adopted from the old slot');
  assert.equal(overlay('save-error').style.display, 'none');
  assert.match(doc.getElementById('save-flash')!.textContent, /new file/i);
});

// -------------------------------------------------------------- pause menu --

group('Pause menu');

test('opening the pause menu freezes the sim and closing restores the speed', async () => {
  const { host } = makeHost();
  const game = await makeGame(host);
  const g = game as any;
  const hud = game.hud;

  hud.setSpeed(2);
  assert.equal(g.pauseMenu, null, 'closed at rest');
  g.openPauseMenu();
  assert.ok(g.pauseMenu, 'the menu is mounted');
  assert.ok(doc.body.contains(g.pauseMenu.root), 'its overlay is in the document');
  assert.equal(hud.speedIdx, 0, 'the colony is paused');

  g.closePauseMenu();
  assert.equal(g.pauseMenu, null, 'and unmounted again');
  assert.equal(hud.speedIdx, 2, 'the pre-pause speed is restored');
});

test('the pause menu cannot be opened twice', async () => {
  const { host } = makeHost();
  const game = await makeGame(host);
  const g = game as any;
  g.openPauseMenu();
  const first = g.pauseMenu;
  g.openPauseMenu();
  assert.equal(g.pauseMenu, first, 'the second open is ignored');
  g.closePauseMenu();
});

test('the pause menu offers save, settings and a live stats pull', async () => {
  const { host } = makeHost();
  const game = await makeGame(host);
  const g = game as any;
  g.openPauseMenu();
  const root: HTMLElement = g.pauseMenu.root;

  assert.ok(root.textContent!.includes('MISSION PAUSED'), 'the paused header');
  // The expedition tab pulls real numbers from the host view.
  const stats = g.buildColonyStats();
  assert.ok(stats, 'stats are available');
  assert.equal(stats.fleet.total, sim.rovers.length);
  assert.equal(stats.structures.total, sim.buildings.length);
  assert.ok(stats.clockText.includes('Sol'), 'the clock line');
  assert.ok(stats.resources.length >= 4, 'every resource is listed');
  g.closePauseMenu();
});

test('the settings contract persists and applies autosave cadence', async () => {
  const { host } = makeHost();
  const game = await makeGame(host);
  const g = game as any;

  const before = g.autosaveSec;
  const s = g.pauseSettings();
  assert.ok(Number.isFinite(s.autosaveIntervalSec), 'reads the persisted interval');
  s.onAutosaveInterval(60);
  assert.equal(g.autosaveSec, 60, 'the loop budget follows the setting');
  s.onAutosaveInterval(before); // restore for later cases
});

test('a failed autosave in a hidden tab logs and toasts instead of prompting', async () => {
  const { host, state } = makeHost(99);
  const game = await makeGame(host);
  const g = game as any;

  // Read via the document instance (the prototype getter brand-checks its
  // receiver), then shadow it for the duration of the test.
  const orig = doc.visibilityState;
  Object.defineProperty(win.Document.prototype, 'visibilityState', {
    value: 'hidden',
    configurable: true,
  });
  try {
    g.saveContext = 'auto';
    g.save(true);
    await wait(120);
    assert.equal(overlay('save-error').style.display, 'none', 'no prompt in a hidden tab');
    assert.equal(state.disposed, false);
    assert.match(doc.getElementById('save-flash')!.textContent, /Save failed/);
  } finally {
    Object.defineProperty(win.Document.prototype, "visibilityState", {
      value: orig,
      configurable: true,
    });
  }
});

await finish('app/pause-save');
// The Game under test schedules its frame loop via requestAnimationFrame
// (backed by a jsdom timer), which keeps the event loop alive. Every case has
// already run, so a standalone run can exit cleanly; a linked run is the
// harness's to end.
if (!linked) process.exit(process.exitCode ?? 0);
