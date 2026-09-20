/**
 * @suite app/pause-save
 * @group integration
 * @covers src/app/Game.ts src/app/MenuController.ts src/app/SaveController.ts
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
    drainDomainEvents: () => [],
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

test('saving hides the pause menu until progress closes, then disables save until resume', async () => {
  const { host, state } = makeHost();
  const game = await makeGame(host);
  const g = game as any;
  game.hud.setSpeed(2);
  g.openPauseMenu();
  const menu = g.pauseMenu;
  const save = menu.root.querySelector('[data-act="save"]') as HTMLButtonElement;
  save.click();
  assert.equal(menu.root.style.display, 'none');
  assert.equal(overlay('save-progress').style.display, 'flex');
  assert.equal(game.hud.speedIdx, 0);
  assert.equal(g.closePauseMenu(), false, 'Esc cannot resume a save in progress');
  g.manualSave(); // repeated shortcut must not start another snapshot
  await wait(120);
  assert.equal(state.snapshots, 1);
  assert.equal(menu.root.style.display, 'none', 'still hidden during the success fade');
  await wait(450);
  assert.equal(overlay('save-progress').style.display, 'none');
  assert.equal(g.pauseMenu, menu, 'restore the same pause session');
  assert.equal(menu.root.style.display, '');
  assert.equal(game.hud.speedIdx, 0);
  assert.equal(save.disabled, true);
  save.click();
  g.manualSave();
  await wait(60);
  assert.equal(state.snapshots, 1, 'button and shortcut cannot repeat a completed paused save');
  g.closePauseMenu();
  assert.equal(game.hud.speedIdx, 2, 'resume restores the original speed');
  g.openPauseMenu();
  assert.equal(g.pauseMenu.root.querySelector('[data-act="save"]').disabled, false);
  g.closePauseMenu();
});

test('a failed paused save restores an enabled menu and retry disables it only on success', async () => {
  const { host } = makeHost(1);
  const game = await makeGame(host);
  const g = game as any;
  g.openPauseMenu();
  const menu = g.pauseMenu;
  g.manualSave();
  await wait(120);
  assert.equal(menu.root.style.display, '');
  assert.equal(menu.root.querySelector('[data-act="save"]').disabled, false);
  assert.equal(overlay('save-error').style.display, 'flex');
  assert.equal(game.hud.speedIdx, 0);
  g.retrySave();
  assert.equal(menu.root.style.display, 'none');
  await wait(600);
  assert.equal(menu.root.style.display, '');
  assert.equal(menu.root.querySelector('[data-act="save"]').disabled, true);
  assert.equal(overlay('save-error').style.display, 'none');
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

// -------------------------------------------------------------- update card --

const NEWER_BUILD = 'f'.repeat(39) + 'a'; // → shortSha "fffffff", newer than the test build
const NEW_FEATURES = [
  'In-game pause menu with expedition stats',
  'A stable return-to-menu save',
  'A frostier save dialog',
];

const cardOpen = () => overlay('update-banner').style.display === 'flex';

const press = (id: string) =>
  overlay(id).dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }));

/**
 * The page reload can't happen in jsdom, so the teardown's reload timer is
 * swallowed; what matters is that it is only scheduled *after the player
 * clicks Reload* — never by the notice itself.
 */
function swallowReloads(fn: () => void): number {
  const real = win.setTimeout.bind(win);
  let reloads = 0;
  win.setTimeout = ((f: () => void, d?: number) => {
    if (d === 0 && /reload/.test(String(f))) {
      reloads++;
      return 999999;
    }
    return real(f, d);
  }) as typeof win.setTimeout;
  try {
    fn();
  } finally {
    win.setTimeout = real;
  }
  return reloads;
}

group('Update card');

test('finding a newer build freezes the colony and raises the card — nothing saves or reloads by itself', async () => {
  const { host, state } = makeHost();
  const game = await makeGame(host);
  const g = game as any;
  const hud = game.hud;

  hud.setSpeed(2);
  const real = win.setTimeout.bind(win);
  win.setTimeout = ((f: () => void, d?: number) => {
    if (d === 700 || d === 3000) return 999999; // any scheduled reload, old-style or new
    return real(f, d);
  }) as typeof win.setTimeout;
  try {
    g.onNewBuild({ commit: NEWER_BUILD, notes: NEW_FEATURES });

    assert.ok(cardOpen(), 'the card is up');
    assert.equal(hud.speedIdx, 0, 'the colony is frozen so the notice is readable');
    assert.equal(g.saveContext, 'update');
    assert.equal(state.snapshots, 0, 'no automatic save');

    assert.match(overlay('update-title').textContent, /new version/i);
    assert.ok(overlay('update-builds').textContent!.includes('fffffff'), 'the new build is named');
    const notes = Array.from(doc.querySelectorAll('#update-notes li')).map((li) => li.textContent);
    assert.deepEqual(notes, NEW_FEATURES, 'the changelog is listed');
    assert.match(overlay('update-text').textContent, /save/i, 'it says the player must save');
    assert.match(overlay('update-text').textContent, /reload/i, 'and then reload');
    assert.equal(overlay('ub-reload').style.display, 'none', 'reload waits for a successful save');

    await wait(150);
    assert.equal(state.snapshots, 0, 'still no automatic save a moment later');
    assert.ok(cardOpen(), 'the card waits for the player');
  } finally {
    win.setTimeout = real;
  }
});

test('the player saves from the card; reload is offered only after the save lands', async () => {
  const { host, state } = makeHost();
  const game = await makeGame(host);
  const g = game as any;
  g.onNewBuild({ commit: NEWER_BUILD, notes: NEW_FEATURES });
  assert.ok(cardOpen());

  press('ub-save');
  await wait(150);
  assert.equal(state.snapshots, 1, 'the save ran when asked');
  assert.match(overlay('update-text').textContent, /saved/i, 'the card reports the save');
  assert.equal(overlay('ub-reload').style.display, '', 'now the reload is offered');
  assert.equal(state.disposed, false, 'yet the page still waits for the click');
  assert.equal(g.started, true);
});

test('"Reload now" — after the save — tears the colony down and schedules the page reload', async () => {
  const { host, state } = makeHost();
  const game = await makeGame(host);
  const g = game as any;
  g.onNewBuild({ commit: NEWER_BUILD, notes: NEW_FEATURES });
  press('ub-save');
  await wait(150);
  assert.equal(overlay('ub-reload').style.display, '');

  const reloads = swallowReloads(() => press('ub-reload'));
  assert.equal(reloads, 1, 'the reload is the player\'s click, and only his');
  assert.equal(state.disposed, true);
  assert.equal(g.started, false);
  assert.ok(!cardOpen(), 'the card is gone with the colony');
});

test('"Later" keeps the player on this build and restores the pre-notice speed', async () => {
  const { host, state } = makeHost();
  const game = await makeGame(host);
  const g = game as any;
  g.hud.setSpeed(2);
  g.onNewBuild({ commit: NEWER_BUILD, notes: NEW_FEATURES });
  assert.equal(g.hud.speedIdx, 0);

  press('ub-later');
  assert.ok(!cardOpen(), 'the card is down');
  assert.equal(g.hud.speedIdx, 2, 'the pre-notice speed is restored');
  assert.equal(g.saveContext, 'auto', 'background saves are un-remarkable again');
  assert.equal(state.snapshots, 0, 'nothing was saved');
  assert.equal(state.disposed, false);
  assert.equal(g.started, true, 'the colony keeps running');
});

test('Esc is ignored while the card\'s own save is in flight', async () => {
  const { host } = makeHost();
  const game = await makeGame(host);
  const g = game as any;
  g.hud.setSpeed(2);
  g.onNewBuild({ commit: NEWER_BUILD, notes: NEW_FEATURES });

  press('ub-save');
  // The snapshot hop is still in flight (25 ms); dismissing the card now
  // would make the success land on a card the player can no longer see.
  win.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(cardOpen(), 'the card stays up while its save runs');
  assert.equal(g.hud.speedIdx, 0);

  await wait(150);
  assert.match(overlay('update-text').textContent, /saved/i, 'the save still lands on the card');
  assert.equal(overlay('ub-reload').style.display, '', 'and unlocks the reload');
});

test('Esc behaves as "Later" while the card is open', async () => {
  const { host } = makeHost();
  const game = await makeGame(host);
  const g = game as any;
  g.hud.setSpeed(2);
  g.onNewBuild({ commit: NEWER_BUILD, notes: NEW_FEATURES });

  win.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(!cardOpen(), 'Esc dismisses the card');
  assert.equal(g.hud.speedIdx, 2, 'and resumes the colony');
});

test('a failed save from the card reports on the card; the retry goes through the same button', async () => {
  const { host, state } = makeHost(1); // the first snapshot fails, the retry succeeds
  const game = await makeGame(host);
  const g = game as any;
  g.onNewBuild({ commit: NEWER_BUILD, notes: NEW_FEATURES });

  press('ub-save');
  await wait(150);
  assert.equal(overlay('save-error').style.display, 'none', 'no prompt stacked on the card');
  assert.match(overlay('update-text').textContent, /failed/i, 'the card carries the failure');
  assert.equal(overlay('ub-reload').style.display, 'none', 'no reload before a save succeeded');
  assert.equal(state.disposed, false, 'the colony is alive for the retry');

  press('ub-save'); // retry
  await wait(150);
  assert.match(overlay('update-text').textContent, /saved/i, 'the retry lands on the card');
  assert.equal(overlay('ub-reload').style.display, '', 'and unlocks the reload');
});

await finish('app/pause-save');
// The Game under test schedules its frame loop via requestAnimationFrame
// (backed by a jsdom timer), which keeps the event loop alive. Every case has
// already run, so a standalone run can exit cleanly; a linked run is the
// harness's to end.
if (!linked) process.exit(process.exitCode ?? 0);
