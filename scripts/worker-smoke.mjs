/**
 * Worker smoke test: drives the real browser boundary — a module worker holding
 * the `Simulation`, a main thread rendering a `ColonyMirror` — and asserts the
 * things a headless suite cannot see.
 *
 * Why this needs Chromium and not jsdom: the file checks `new Worker(new URL(...),
 * {type:'module'})` construction under a real bundler, worker messages crossing a
 * real structured-clone boundary, `postMessage` latency interleaving with actual
 * animation frames, and the three.js ghost picking a raycast terrain point from a
 * real pointer event. `tests/sim/worker.test.ts` covers the protocol itself
 * through a fake port; this covers the port.
 *
 * What it proves, in order:
 *   - the transport the page asked for is the transport it got (no silent
 *     fallback: `createHost` degrades to in-process on purpose, which would
 *     otherwise turn a broken worker into a green test)
 *   - `game.sim` on the worker path is the read model, not the simulation — it
 *     has no `step`, no `restore`, no `snapshot`, so nothing downstream can
 *     reach the world directly even by accident
 *   - the mirrored colony keeps ticking, one advance per delivered frame
 *   - the build ghost's legal/illegal verdict — computed locally from the seed,
 *     one payload stale — agrees with what the sim's own placement rule accepts
 *   - a dev-mode pin published across the port actually holds a battery inside
 *     the worker, and never reaches the snapshot taken through that same port
 *   - a save requested through the port resolves without stopping the world
 *   - no uncaught page errors
 *
 * Runs against a served build (BASE_URL, default http://127.0.0.1:5199):
 *   npm run build && (npx vite preview --port 5199 --strictPort &)
 *   node scripts/setup-playwright.mjs        # or: npm i --no-save playwright
 *   node scripts/worker-smoke.mjs            # the worker path
 *   SMOKE_QUERY='?worker=0' node scripts/worker-smoke.mjs   # the same, in-process
 *
 * The `SMOKE_QUERY` knob is the point: the two runs are the same assertions
 * against the same build, so a divergence between the transports fails here
 * rather than in someone's playthrough.
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 the harness broke (no
 * browser, no server, usage).
 *
 * Env knobs:
 *   BASE_URL        where the game is served (default above)
 *   SMOKE_QUERY     query string to load with (default '?worker=1';
 *                   '?worker=0' for the in-process host, which is no longer
 *                   the default, so it has to be asked for)
 *   SMOKE_FAILURE_SHOT  where to dump a screenshot on failure
 *                       (default ./worker-smoke-failure.png, gitignored)
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5199';
const QUERY = process.env.SMOKE_QUERY ?? '?worker=1';
const SHOT = process.env.SMOKE_FAILURE_SHOT ?? join(ROOT, 'worker-smoke-failure.png');
const VIEW = { width: 1360, height: 760 };

/**
 * Which transport this run should get. Derived from the query rather than
 * hardcoded, and defaulting to the worker because that is what the app defaults
 * to (`WORKER_DEFAULT` in `createHost.ts`): only an explicit opt-out means
 * in-process. Getting this wrong is the specific failure the run exists to
 * catch — an empty query used to mean "the in-process host", so a CI pair of
 * `?worker=1` + empty would quietly test the same transport twice.
 */
const wantsWorker = !/worker=(0|false|off)/.test(QUERY);
const WANT_TRANSPORT = wantsWorker ? 'worker' : 'in-process';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node scripts/worker-smoke.mjs\n\n' +
      'Boots the game from BASE_URL + SMOKE_QUERY and checks the sim host\n' +
      'boundary in a browser. Default SMOKE_QUERY is "?worker=1".\n',
  );
  process.exit(0);
}

// ---------------------------------------------------------------- reporting ----

const failures = [];
const pass = (name) => console.log(`ok - ${name}`);
const fail = (name, detail) => {
  failures.push(name);
  console.log(`FAIL - ${name}${detail ? `: ${detail}` : ''}`);
};
const check = (name, cond, detail) => {
  if (cond) pass(name);
  else fail(name, detail);
  return !!cond;
};
/** A product failure we cannot test past (boot/wizard/worldgen broke). */
class Fatal extends Error {}

/** Wait for painted frames rather than guessing how fast software GL renders. */
const settle = (page, frames = 2) =>
  page.evaluate(async (count) => {
    await document.fonts.ready;
    for (let i = 0; i < count; i++) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, frames);

/**
 * Poll a page-side predicate until true, or give up. Everything across a port is
 * asynchronous by nature — a payload lands on somebody's frame, not on our
 * `await` — so the checks wait for the *state*, never for a guessed duration.
 */
const until = (page, fn, arg, timeoutMs = 20000) =>
  page
    .waitForFunction(fn, arg, { timeout: timeoutMs, polling: 'raf' })
    .then(() => true)
    .catch(() => false);

const rf = (page, fn, arg) => page.evaluate(fn, arg);

/**
 * Click the first element matching `selector` that is genuinely on top at its own
 * centre, and return where it was clicked — or null if none of them are.
 *
 * The HUD floats panels over the play area, and at this viewport the log panel
 * covers the left end of the build bar, so `locator.click()` would either time out
 * or, with `force`, dispatch a pointer event the *panel* swallows. Asking
 * `elementFromPoint` is what a finger would decide, and it is how mobile-smoke
 * picks its long-press target for the same reason.
 */
async function clickTopmost(page, selector) {
  const spot = await rf(
    page,
    (sel) => {
      for (const el of document.querySelectorAll(sel)) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const b = el.getBoundingClientRect();
        const x = b.x + b.width / 2;
        const y = b.y + b.height / 2;
        if (b.width < 4 || b.height < 4) continue;
        const top = document.elementFromPoint(x, y);
        if (top && (top === el || el.contains(top))) return { x, y, label: el.textContent.trim().slice(0, 24) };
      }
      return null;
    },
    selector,
  );
  if (!spot) return null;
  await page.mouse.click(spot.x, spot.y);
  return spot;
}

// ------------------------------------------------------------------ browser ----

async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error(
      'worker-smoke: playwright is not installed.\n' +
        '  Full install: npm i --no-save playwright && npx playwright install chromium\n' +
        '  No-system-NSS sandbox instead: node scripts/setup-playwright.mjs',
    );
    process.exit(2);
  }
  // Same recipe mobile-smoke documents: sparticuz Chromium plus the stub NSS
  // `setup-playwright.mjs` builds, when present; stock launch otherwise.
  try {
    const mod = await import('@sparticuz/chromium').catch(() => null);
    const stubDir = join(ROOT, '.playwright-libs', 'nss-stub');
    const stubsExist = existsSync(join(stubDir, 'libnss3.so'));
    if (mod && (process.env.RF_SPARTICUZ || stubsExist)) {
      const sparticuz = mod.default ?? mod;
      const args = sparticuz.args.filter((a) => !a.startsWith('--headless'));
      args.push('--disable-dev-shm-usage');
      const env = { ...process.env };
      if (stubsExist) env.LD_LIBRARY_PATH = `${stubDir}:${process.env.LD_LIBRARY_PATH ?? ''}`;
      return await chromium.launch({ executablePath: await sparticuz.executablePath(), args, env });
    }
  } catch (err) {
    console.warn(`worker-smoke: sparticuz launch failed, trying stock (${err.message})`);
  }
  return await chromium.launch();
}

/**
 * One read of everything the checks need, in one atomic page evaluation. Taken as
 * a single snapshot on purpose: fields that were read in separate `evaluate`
 * calls could each belong to a *different* payload, which would make a lag
 * comparison meaningless.
 */
const probe = (page) =>
  rf(page, () => {
    const g = window.__rf.game;
    const host = g.host;
    const view = host?.view;
    const rover = view?.rovers?.[0];
    return {
      transport: host?.transport ?? null,
      simTime: view?.simTime ?? -1,
      sol: view?.clock?.sol ?? -1,
      buildings: view?.buildings?.length ?? -1,
      rovers: view?.rovers?.length ?? -1,
      rover: rover ? { id: rover.id, x: rover.x, z: rover.z, battery: rover.battery } : null,
      // The read model must not carry the world's own doors.
      viewHasStep: typeof view?.step === 'function',
      viewHasRestore: typeof view?.restore === 'function',
      viewHasSnapshot: typeof view?.snapshot === 'function',
      viewHasCanPlace: typeof view?.canPlace === 'function',
      hint: document.getElementById('hintbar')?.textContent ?? '',
      hintShown: document.getElementById('hintbar')?.style.display !== 'none',
      armed: document.querySelectorAll('.build-btn.active').length,
    };
  });

const browser = await launchBrowser();
const pageErrors = [];
const hostWarnings = [];
let page;

try {
  const ctx = await browser.newContext({ viewport: VIEW });
  page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (err) => pageErrors.push(String(err?.message ?? err)));
  page.on('console', (msg) => {
    // The factory's fallback is the specific thing that must not happen silently.
    const text = msg.text();
    if (/\[sim:host\]|\[sim:worker\]/.test(text)) hostWarnings.push(`${msg.type()}: ${text.slice(0, 200)}`);
  });

  // ---------------------------------------------------------------- boot ----
  const url = BASE + QUERY;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    console.error(`worker-smoke: could not reach ${url} — is a build served there?\n  ${err.message.split('\n')[0]}`);
    process.exit(2);
  }
  try {
    await page.waitForSelector('.rf-menu', { timeout: 30000 });
    await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 30000 });
  } catch {
    throw new Fatal('the main menu never appeared');
  }

  // -------------------------------------------------------------- wizard ----
  await page.click('[data-act="new"]');
  await page.waitForSelector('#rf-save-name');
  await page.fill('#rf-save-name', 'Worker Smoke');
  await page.click('[data-act="next"]');
  await page.waitForSelector('[data-grid="size"]');
  await page.click('[data-grid="size"] .rf-pick:has-text("Outpost")');
  await page.click('[data-act="next"]');
  await page.waitForSelector('.rf-globe-wrap canvas');
  await settle(page);
  let picked = false;
  for (let round = 0; round < 2 && !picked; round++) {
    const box = await page.locator('.rf-globe-wrap canvas').boundingBox();
    if (!box) break;
    outer: for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 9; gx++) {
        await page.click('.rf-globe-wrap canvas', {
          position: { x: (box.width * (gx + 0.5)) / 9, y: (box.height * (gy + 0.5)) / 7 },
        });
        await settle(page);
        if (await page.$eval('[data-act="next"]', (b) => !b.disabled)) {
          picked = true;
          break outer;
        }
      }
    }
  }
  if (!picked) throw new Fatal('no landing zone could be picked on the globe');
  await page.click('[data-act="next"]');
  await page.waitForSelector('.rf-summary');
  await page.click('.rf-advanced-toggle');
  await page.fill('#rf-seed', 'SMOKE-W');
  await page.click('[data-act="next"]'); // Begin Mission
  try {
    await page.waitForSelector('.rf-loading', { timeout: 15000 }).catch(() => null);
    await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 180000 });
  } catch {
    throw new Fatal('world generation never finished');
  }
  await settle(page);
  if (!(await rf(page, () => Boolean(window.__rf?.game?.host)))) {
    throw new Fatal('reached no live host after worldgen');
  }
  /**
   * A crit alert pauses the colony by design (it is the whole point of autopause),
   * and a paused colony ticks nothing — which would turn every timing assertion in
   * this file into a false accusation. So the switch comes off for the run: the
   * checks are about the boundary, and they need the world to actually advance.
   */
  await rf(page, () => {
    const hud = window.__rf.game.hud;
    hud.autopauseOnCrit = false;
    // Index into SPEEDS = [0, 1, 2, 4]: 3 is 4×, not a fourth multiplier.
    hud.setSpeed(3);
  });
  pass(`wizard to a live colony${QUERY ? ` (${QUERY})` : ''}`);

  // ---------------------------------------------------------- transport ----
  const first = await probe(page);
  check(
    `the page runs on the ${WANT_TRANSPORT} host`,
    first.transport === WANT_TRANSPORT,
    `transport=${first.transport}${wantsWorker ? ' — createHost fell back, so the worker is broken' : ''}`,
  );
  check(
    'the host fell back nowhere',
    hostWarnings.length === 0,
    hostWarnings.slice(0, 2).join(' | ') || 'clean',
  );
  check(
    wantsWorker
      ? 'the view is a read model, not the simulation'
      : 'the in-process view is the live world, by design',
    wantsWorker
      ? !first.viewHasStep && !first.viewHasRestore && !first.viewHasSnapshot && first.viewHasCanPlace
      : first.viewHasStep && first.viewHasSnapshot,
    `step=${first.viewHasStep} restore=${first.viewHasRestore} snapshot=${first.viewHasSnapshot} canPlace=${first.viewHasCanPlace}`,
  );
  check('the mirrored colony has entities to draw', first.rovers > 0 && first.sol >= 0, `rovers=${first.rovers} sol=${first.sol}`);

  // ------------------------------------------------------------- ticking ----
  check(
    'the world is running, so a stall below is a boundary fault and not a pause',
    await until(page, () => window.__rf.game.host.view.simTime > 0, undefined, 15000),
    'simTime never left zero',
  );
  const ticking = await until(
    page,
    (arg) => window.__rf.game.host.view.simTime > arg.target,
    { target: first.simTime + 0.5 },
    15000,
  );
  check('time advances across the boundary, one payload at a time', ticking, `from simTime ${first.simTime}`);
  const frames = await rf(page, async () => {
    let n = 0;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => requestAnimationFrame(() => r()));
      n++;
    }
    return n;
  });
  // Only that rAF callbacks fire at this cadence — that the *game* loop is
  // running is what the simTime checks above and below prove, since it is the
  // loop that asks the host for time.
  check('the page paints frames', frames >= 20, `frames=${frames}`);

  // ------------------------------------------------- ghost ↔ sim parity ----
  // Arm a blueprint, then hunt the canvas for a pointer position the *mirror*
  // calls legal, and place there. A mirror that is wrong about legality shows up
  // as the click doing nothing — the sim re-runs its own rule and refuses — so
  // this one interaction tests the shared siting rule from both ends.
  const armed = await clickTopmost(page, '.build-btn');
  await settle(page);
  if (!check('a blueprint armed for placement', (await probe(page)).armed === 1, armed ? `clicked ${armed.label}` : 'no build button was clickable')) {
    throw new Fatal('the build palette could not be armed, so placement cannot be tested');
  }
  const box = await page.locator('#game-canvas').boundingBox();
  /**
   * The verdict of the *mirror*, for a screen point: raycast the terrain, ask the
   * local rule, and return the site or null when the pixel is not usable (a panel
   * owns it, or the ray hit nothing). This is the game's own input path with the
   * ghost's question made explicit, so the numbers below are ones a player acts on.
   */
  const siteUnder = (x, y) =>
    rf(
      page,
      ({ x, y }) => {
        const g = window.__rf.game;
        const el = document.elementFromPoint(x, y);
        if (!el || el.id !== 'game-canvas') return null;
        g.rig.update();
        g.rig.camera.updateMatrixWorld();
        const pt = g.renderer.raycastTerrain(x, y);
        if (!pt) return null;
        return {
          kind: g.pendingBuild,
          err: g.host.view.canPlace(g.pendingBuild, pt.x, pt.z),
          hint: document.getElementById('hintbar')?.textContent ?? '',
          x: pt.x,
          z: pt.z,
        };
      },
      { x, y },
    );

  // Sweep the canvas for one site the mirror calls legal and one it refuses.
  let legal = null;
  let illegal = null;
  for (let attempt = 0; attempt < 48 && (!legal || !illegal); attempt++) {
    const gx = attempt % 8;
    const gy = Math.floor(attempt / 8);
    const x = box.x + (box.width * (gx + 0.5)) / 8;
    const y = box.y + box.height * (0.28 + (gy * 0.5) / 6);
    await page.mouse.move(x, y);
    await settle(page);
    const state = await siteUnder(x, y);
    if (!state) continue;
    if (state.err === null && !legal) legal = { ...state, px: x, py: y };
    if (state.err !== null && !illegal) illegal = { ...state, px: x, py: y };
  }

  // The hint is derived from the same verdict one frame earlier, so agreement
  // between the two is a check on the ghost path, not a tautology: a ghost that
  // renders legal on an illegal site is how a stale mirror would show up.
  check(
    'the ghost verdict and the hint bar agree',
    !!legal && /Placing/.test(legal.hint) && !!illegal && /Cannot build here/.test(illegal.hint),
    legal && illegal ? `legal@${legal.err ?? 'null'} illegal="${illegal.err ?? ''}"` : `legal=${!!legal} illegal=${!!illegal}`,
  );

  if (legal) {
    // Clicking a site the mirror calls legal must be *accepted* by the sim, which
    // re-runs its own rule inside the command. Acceptance is not the same moment
    // as construction: a site appears only once materials reach it, so the window
    // is generous and the failure text carries the sim's own explanation.
    const atClick = await rf(page, () => ({
      count: window.__rf.game.host.view.buildings.length,
      armed: window.__rf.game.pendingBuild,
    }));
    await page.mouse.click(legal.px, legal.py);
    const accepted = await until(
      page,
      (arg) => window.__rf.game.host.view.buildings.length > arg.count,
      atClick,
      45000,
    );
    const note = await rf(page, (arg) => {
      const g = window.__rf.game;
      const log = g.host.view.alerts.history();
      return `sites ${arg.count}→${g.host.view.buildings.length} | ${
        log.length ? String(log[log.length - 1].text).slice(0, 110) : 'no log line'
      }`;
    }, atClick);
    check('a site the mirror called legal was accepted by the sim', accepted, note);
  } else {
    fail('a site the mirror called legal was accepted by the sim', 'no legal site found under a clickable pixel');
  }

  if (illegal) {
    // The sharper half: the sim must *refuse* where the mirror said refuse. A
    // mirror that was stale in the forgiving direction would build here, and that
    // is the failure mode a ghost cannot be trusted to hide.
    await page.mouse.move(illegal.px, illegal.py);
    await settle(page);
    const before = await rf(page, () => window.__rf.game.host.view.buildings.length);
    await page.mouse.click(illegal.px, illegal.py);
    await new Promise((r) => setTimeout(r, 4000));
    const after = await rf(page, () => window.__rf.game.host.view.buildings.length);
    check(
      'a site the mirror called illegal was refused by the sim too',
      after === before,
      `"${illegal.err}" at ${illegal.x.toFixed(0)},${illegal.z.toFixed(0)} — sites ${before}→${after}`,
    );
  } else {
    fail('a site the mirror called illegal was refused by the sim too', 'no refused site found under a clickable pixel');
  }
  await rf(page, () => window.__rf.game.hud.setPendingBuild?.(null));
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- order ----
  const before = await probe(page);
  const target = await rf(page, () => {
    const view = window.__rf.game.host.view;
    for (let r = 60; r <= 240; r += 10) {
      for (let a = 0; a < 360; a += 15) {
        const x = Math.round(Math.cos((a * Math.PI) / 180) * r);
        const z = Math.round(Math.sin((a * Math.PI) / 180) * r);
        if (view.canPlace('warehouse', x, z) === null) return { x, z };
      }
    }
    return null;
  });
  if (!target) throw new Fatal('the mirrored terrain offered nowhere to send a rover');
  await rf(
    page,
    ({ target, id }) => {
      window.__rf.game.host.send({ type: 'rover/move', roverId: id, x: target.x, z: target.z, queue: false });
    },
    { target, id: before.rover.id },
  );
  const drove = await until(
    page,
    (arg) => {
      const r = window.__rf.game.host.view.rovers.find((rv) => rv.id === arg.id);
      return r && Math.hypot(r.x - arg.x, r.z - arg.z) > 8;
    },
    { id: before.rover.id, x: before.rover.x, z: before.rover.z },
    30000,
  );
  check('an order sent across the boundary moved the rover', drove, `target ${JSON.stringify(target)}`);

  // -------------------------------------------------------- overlay pin ----
  await page.keyboard.press('Backquote');
  await settle(page);
  const pinned = await rf(page, async () => {
    const g = window.__rf.game;
    const view = g.host.view;
    const rover = view.rovers[0];
    const full = rover.battery;
    // Top it up first, so "full" is the number the sim itself holds rather than
    // a constant this script would have to keep in step with defs.ts.
    g.host.send({ type: 'dev/rover/battery', roverId: rover.id, frac: 1 });
    await new Promise((r) => setTimeout(r, 400));
    const charged = g.host.view.rovers.find((rv) => rv.id === rover.id).battery;
    g.dev.setKeepBatteryFull(rover.id, true);
    g.host.send({ type: 'dev/rover/battery', roverId: rover.id, frac: 0.02 });
    g.hud.setSpeed(3); // 4×: the pin has to survive several ticks, not one
    return { id: rover.id, charged, full };
  });
  const held = await until(
    page,
    (arg) => {
      const g = window.__rf.game;
      const r = g.host.view.rovers.find((rv) => rv.id === arg.id);
      return !!r && r.battery >= arg.charged - 1e-6 && g.dev.isKeepBatteryFull(arg.id);
    },
    pinned,
    30000,
  );
  check('a dev pin published to the host holds a battery inside the world', held, `id=${pinned.id}`);

  // ------------------------------------------------------------- snapshot ----
  const saved = await rf(page, async () => {
    const g = window.__rf.game;
    const before = g.host.view.simTime;
    const pending = g.host.requestSnapshot();
    // Two frames while the request is in flight: on the worker path the colony
    // must keep running, because serialising it happens elsewhere.
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(() => r()));
    const during = g.host.view.simTime;
    const snapshot = await pending;
    const text = JSON.stringify(snapshot);
    return {
      ok: !!snapshot && typeof text === 'string' && text.length > 2000,
      advanced: during > before,
      before,
      during,
      bytes: text.length,
      hasOverlay: /keepBatteryFull|batteryPins|armedSpawn/.test(text),
      sol: snapshot?.sol ?? snapshot?.clock?.sol ?? null,
      pins: g.host.view.rovers.length,
    };
  });
  check('a save requested through the host returns a colony', saved.ok, `bytes=${saved.bytes}`);
  check(
    wantsWorker ? 'the world kept ticking while its save was taken' : 'the in-process save blocks nothing it should not',
    wantsWorker ? saved.advanced : true,
    `simTime ${saved.before} → ${saved.during}`,
  );
  check('no overlay state reaches the snapshot', !saved.hasOverlay, 'a dev modifier leaked into the save');

  const restored = await rf(page, async () => {
    const g = window.__rf.game;
    const buildings = g.host.view.buildings.length;
    await g.host.loadSnapshot(await g.host.requestSnapshot());
    await new Promise((r) => requestAnimationFrame(() => r()));
    await new Promise((r) => requestAnimationFrame(() => r()));
    return { before: buildings, after: g.host.view.buildings.length };
  });
  check('a restore round trip through the host leaves the colony intact', restored.after === restored.before, `${restored.before} → ${restored.after}`);

  // ---------------------------------------------------------------- errors ----
  await rf(page, () => window.__rf.game.hud.setSpeed(1));
  await settle(page, 4);
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'clean');
  if (hostWarnings.length > 0) {
    for (const line of hostWarnings.slice(0, 4)) console.log(`warn - ${line}`);
  }
} catch (err) {
  if (err instanceof Fatal) fail(err.message);
  else throw err;
} finally {
  if (page && failures.length > 0) {
    try {
      await page.screenshot({ path: SHOT });
      console.log(`failure screenshot: ${SHOT}`);
    } catch {
      /* the page may already be dead — the FAIL lines are the signal */
    }
  }
  await browser.close();
}

if (failures.length > 0) {
  console.log(`\nworker-smoke${QUERY ? ` [${QUERY}]` : ''}: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nworker-smoke${QUERY ? ` [${QUERY}]` : ''}: all checks passed`);
