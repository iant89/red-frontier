/**
 * Mobile smoke test: boots the real game in a phone-size viewport with touch
 * enabled, starts a small expedition through the new-game wizard, then drives
 * the touch-only input paths and asserts the user-visible outcomes.
 *
 * What it covers (and why each needs a real browser, not jsdom):
 *   - narrow-viewport panel defaults (matchMedia + localStorage defaults)
 *   - tap to arm a blueprint, long-press to cancel it (contextTap branch)
 *   - tap-to-select a rover (3D picking through the real renderer)
 *   - tap-vs-drag disambiguation (a tap never rotates the camera)
 *   - long-press on terrain issues a move order to the selected rover
 *   - pinch spread zooms the camera, two-finger drag pans it
 *   - no uncaught page errors along the way
 *
 * Runs against a served build (BASE_URL, default http://127.0.0.1:5199):
 *   npm run build && (npx vite preview --port 5199 --strictPort &)
 *   npm i --no-save playwright && npx playwright install chromium
 *   node scripts/mobile-smoke.mjs
 *
 * On machines without system NSS (this sandbox, minimal containers), run
 * `node scripts/setup-playwright.mjs` first: this script picks up the
 * sparticuz Chromium + stub NSS it installs automatically.
 *
 * Exit codes: 0 all checks passed, 1 a check failed (see FAIL lines),
 * 2 the harness itself broke (no browser, no server, usage).
 *
 * Env knobs:
 *   BASE_URL            where the game is served (default above)
 *   SMOKE_FAILURE_SHOT  where to dump a screenshot on failure
 *                       (default ./smoke-failure.png, gitignored)
 *
 * The .github/workflows/pages.yml workflow runs this on every push to main
 * (and on pull requests) and blocks the Pages deploy when it fails.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node scripts/mobile-smoke.mjs\n\n' +
      'Boots the game from BASE_URL (default http://127.0.0.1:5199) in a\n' +
      'phone-size touch viewport and drives the mobile input paths.\n' +
      'Serve a build first, e.g.:\n' +
      '  npm run build && npx vite preview --port 5199 --strictPort &\n' +
      '  node scripts/mobile-smoke.mjs',
  );
  process.exit(0);
}

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5199';
const SHOT = process.env.SMOKE_FAILURE_SHOT ?? join(ROOT, 'smoke-failure.png');
// iPhone-ish CSS size. hasTouch + isMobile are what matter here: the game
// keys its mobile behaviour off pointerType and a 760px media query.
const VIEW = { width: 390, height: 844 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ------------------------------------------------------------------ browser ----

async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error(
      'mobile-smoke: playwright is not installed.\n' +
        '  Full install: npm i --no-save playwright && npx playwright install chromium\n' +
        '  No-system-NSS sandbox instead: node scripts/setup-playwright.mjs',
    );
    process.exit(2);
  }
  // Sandbox recipe (see setup-playwright.mjs): sparticuz Chromium plus the
  // stub NSS it built, when they are present. Stock CI runners take the
  // plain launch below.
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
      return await chromium.launch({
        executablePath: await sparticuz.executablePath(),
        args,
        env,
      });
    }
  } catch (err) {
    console.warn(`mobile-smoke: sparticuz launch failed, trying stock (${err.message})`);
  }
  return await chromium.launch();
}

// ------------------------------------------------------------------ helpers ----

/** Centre of an element in CSS px, for touchscreen taps. */
async function centerOf(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Fatal(`no bounding box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** One real touch tap at a point (touchstart+touchend → pointerType touch). */
async function touchTap(page, point) {
  await page.touchscreen.tap(point.x, point.y);
}

/**
 * Run a touch gesture as one atomic script on the page's own event loop.
 * Each step waits until `at` ms (page time) then dispatches a synthetic
 * PointerEvent on the game canvas. Playwright's touchscreen API only taps,
 * so multi-touch and timed holds need synthesis — and atomicity matters:
 * the game's long-press timer also lives on that loop, so a 650ms hold
 * deterministically beats the 480ms timer no matter how janky the CDP
 * roundtrips or software-rendered frames get. (Spacing the events from
 * Node lets the release overtake the timer under load — a race this
 * exact script used to lose.)
 *
 * steps: Array of [atMs, type, pointerId, x, y].
 */
async function gesture(page, steps) {
  await page.evaluate(async (steps) => {
    const c = document.getElementById('game-canvas');
    const fire = (type, id, x, y) =>
      c.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
          button: 0,
          isPrimary: id === 1,
        }),
      );
    let t = 0;
    for (const [at, type, id, x, y] of steps) {
      await new Promise((r) => setTimeout(r, Math.max(0, at - t)));
      t = at;
      fire(type, id, x, y);
    }
  }, steps);
}

/**
 * A tap: down and up dispatched synchronously in one task, so dur is ~0ms
 * no matter how long software-rendered frames block the event loop. (A
 * timer-spaced tap can stretch past Game's 500ms tap window under jank and
 * silently stop being a tap — exactly the CI flake this once was.)
 */
const tapCanvas = (page, x, y) =>
  page.evaluate(
    ({ x, y }) => {
      const c = document.getElementById('game-canvas');
      const ev = (type) =>
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: 'touch',
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
          button: 0,
          isPrimary: true,
        });
      c.dispatchEvent(ev('pointerdown'));
      c.dispatchEvent(ev('pointerup'));
    },
    { x, y },
  );

/** A press held past Game's 480ms long-press timer, then released. */
const longPressCanvas = (page, x, y, holdMs = 650) =>
  gesture(page, [
    [0, 'pointerdown', 1, x, y],
    [holdMs, 'pointerup', 1, x, y],
  ]);

/** One pointer glides from corner to corner, then releases. */
function dragCanvas(page, x1, y1, x2, y2, steps = 10, spanMs = 160) {
  const seq = [[0, 'pointerdown', 1, x1, y1]];
  for (let i = 1; i <= steps; i++) {
    seq.push([
      (spanMs * i) / steps,
      'pointermove',
      1,
      x1 + ((x2 - x1) * i) / steps,
      y1 + ((y2 - y1) * i) / steps,
    ]);
  }
  seq.push([spanMs + 20, 'pointerup', 1, x2, y2]);
  return gesture(page, seq);
}

/** Two pointers down, both glide to new spots, both release. */
function twoFinger(page, a1, b1, a2, b2, steps = 8, spanMs = 140) {
  const seq = [
    [0, 'pointerdown', 1, a1.x, a1.y],
    [0, 'pointerdown', 2, b1.x, b1.y],
  ];
  for (let i = 1; i <= steps; i++) {
    const at = (spanMs * i) / steps;
    seq.push([at, 'pointermove', 1, a1.x + ((a2.x - a1.x) * i) / steps, a1.y + ((a2.y - a1.y) * i) / steps]);
    seq.push([at, 'pointermove', 2, b1.x + ((b2.x - b1.x) * i) / steps, b1.y + ((b2.y - b1.y) * i) / steps]);
  }
  seq.push([spanMs + 20, 'pointerup', 1, a2.x, a2.y]);
  seq.push([spanMs + 20, 'pointerup', 2, b2.x, b2.y]);
  return gesture(page, seq);
}

// Read-backs through the window.__rf handle main.ts exposes for this script.
const rf = (page, fn, arg) => page.evaluate(fn, arg);
const rigState = (page) =>
  rf(page, () => {
    const g = window.__rf.game;
    return {
      theta: g.rig.theta,
      phi: g.rig.phi,
      radius: g.rig.radius,
      tx: g.rig.target.x,
      tz: g.rig.target.z,
    };
  });
/**
 * Terrain raycast against the CONVERGED camera pose. Gesture handlers only
 * change rig params — position/quaternion follow on the next rendered
 * frame, which software rendering can delay past our sleeps. Converging
 * here (atomically, so no frame can interleave) reads the same pose the
 * gesture's own raycast will see after frames catch up.
 */
const raycastSynced = (page, x, y) =>
  rf(
    page,
    ({ x, y }) => {
      const g = window.__rf.game;
      g.rig.update();
      g.rig.camera.updateMatrixWorld();
      const pt = g.renderer.raycastTerrain(x, y);
      return pt ? { x: pt.x, z: pt.z } : null;
    },
    { x, y },
  );

// ------------------------------------------------------------------ main ----

const browser = await launchBrowser();
const pageErrors = [];
const consoleErrors = [];
let page;

try {
  const ctx = await browser.newContext({
    viewport: VIEW,
    hasTouch: true,
    isMobile: true,
  });
  page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (err) => pageErrors.push(String(err?.message ?? err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // ------------------------------------------------------------- boot ----
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    console.error(
      `mobile-smoke: could not reach ${BASE} — is a build served there?\n  ${err.message.split('\n')[0]}`,
    );
    process.exit(2);
  }
  try {
    await page.waitForSelector('.rf-menu', { timeout: 30000 });
    await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 30000 });
  } catch {
    throw new Fatal('the main menu never appeared');
  }
  pass('boot to the main menu');
  check(
    'narrow viewport registers as mobile',
    await rf(page, () => window.matchMedia('(max-width: 760px)').matches),
    `innerWidth=${await rf(page, () => window.innerWidth)}`,
  );

  // ----------------------------------------------------------- wizard ----
  await page.click('[data-act="new"]');
  await page.waitForSelector('#rf-save-name');
  await page.fill('#rf-save-name', 'Smoke Test');
  await page.click('[data-act="next"]'); // → world size
  await page.waitForSelector('[data-grid="size"]');
  await page.click('[data-grid="size"] .rf-pick:has-text("Outpost")');
  await page.click('[data-act="next"]'); // → landing globe
  await page.waitForSelector('.rf-globe-wrap canvas');
  await sleep(1200);
  // Raycast picking can land between spinning markers, so sweep a grid
  // until a zone catches and Next enables (same recipe as the screenshots).
  // Two passes: on a slow frame a click can fall between markers twice over.
  let picked = false;
  for (let pass = 0; pass < 2 && !picked; pass++) {
    const box = await page.locator('.rf-globe-wrap canvas').boundingBox();
    if (!box) break;
    outer: for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 9; gx++) {
        await page.click('.rf-globe-wrap canvas', {
          position: { x: (box.width * (gx + 0.5)) / 9, y: (box.height * (gy + 0.5)) / 7 },
        });
        await sleep(120);
        if (await page.$eval('[data-act="next"]', (b) => !b.disabled)) {
          picked = true;
          break outer;
        }
      }
    }
  }
  if (!picked) throw new Fatal('no landing zone could be picked on the globe');
  const zone = await page.locator('.rf-site-name').first().textContent().catch(() => null);
  console.log(`info - landing zone: ${zone ?? '(unread)'}`);
  await page.click('[data-act="next"]'); // → launch review
  await page.waitForSelector('.rf-summary');
  await page.click('.rf-advanced-toggle');
  await page.fill('#rf-seed', 'SMOKE-1');
  await page.click('[data-act="next"]'); // Begin Mission
  try {
    await page.waitForSelector('.rf-loading', { timeout: 15000 }).catch(() => null);
    await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 180000 });
  } catch {
    throw new Fatal('world generation never finished');
  }
  await sleep(2500); // let the first frames render
  if (!(await rf(page, () => Boolean(window.__rf?.game?.sim)))) {
    throw new Fatal('reached no live simulation after worldgen');
  }
  pass('wizard to a live colony (Outpost, seed SMOKE-1)');
  // Freeze the sim clock: gesture asserts below read back issued orders,
  // and must not race the autonomy scheduler. Rendering continues.
  await rf(page, () => window.__rf.game.hud.setSpeed(0));

  // --------------------------------------- narrow-viewport panel defaults ----
  check(
    'vitals start collapsed on phones',
    await page.locator('#vitals.collapsed').count(),
    'expected #vitals.collapsed',
  );
  check(
    'inspector starts collapsed on phones',
    await page.locator('#inspector.collapsed').count(),
    'expected #inspector.collapsed',
  );
  check(
    'build bar starts expanded on phones',
    (await page.locator('#buildbar.bar-hidden').count()) === 0,
    'expected #buildbar without .bar-hidden',
  );
  await touchTap(page, await centerOf(page, '#vitals-toggle'));
  await sleep(200);
  const expanded = (await page.locator('#vitals.collapsed').count()) === 0;
  await touchTap(page, await centerOf(page, '#vitals-toggle'));
  await sleep(200);
  const recollapsed = (await page.locator('#vitals.collapsed').count()) === 1;
  check('vitals toggle expands and re-collapses by tap', expanded && recollapsed);

  // ---------------------------------- palette arm + long-press to cancel ----
  // The arm tap races the 450ms hold-to-peek dossier: on a slow runner the
  // release can land late, the dossier opens, and the tap disarms itself.
  // Retry until armed — checking first, since tapping while armed would
  // toggle the blueprint back off.
  const armedCount = () =>
    rf(page, () => document.querySelectorAll('.build-btn.active').length);
  for (let i = 0; i < 3 && (await armedCount()) !== 1; i++) {
    await touchTap(page, await centerOf(page, '.build-btn'));
    await sleep(250);
  }
  const armed = await armedCount();
  check('tapping a blueprint arms it', armed === 1, `active=${armed}`);
  const canvasBox = await page.locator('#game-canvas').boundingBox();
  const cx = canvasBox.x + canvasBox.width / 2;
  const cy = canvasBox.y + canvasBox.height / 2;
  await longPressCanvas(page, cx, cy);
  await sleep(200);
  const stillArmed = await rf(page, () => document.querySelectorAll('.build-btn.active').length);
  check('long-press cancels the armed blueprint', stillArmed === 0, `active=${stillArmed}`);

  // -------------------------------------- tap-to-select + tap-vs-drag ----
  const roster = await rf(page, () =>
    window.__rf.game.sim.rovers.map((r) => ({ id: r.id, label: r.label })),
  );
  const readSelection = async () => {
    const title = await rf(
      page,
      () => document.querySelector('#inspector .i-head h3')?.textContent ?? null,
    );
    const kind = await rf(
      page,
      () => document.querySelector('#inspector .i-bar-kind')?.textContent ?? null,
    );
    // The id, not the label: both starter rovers share one label.
    const idText = await rf(
      page,
      () => document.querySelector('#inspector .i-id')?.textContent ?? null,
    );
    const id = idText?.startsWith('#') ? Number(idText.slice(1)) : null;
    return { title, kind, idText, id: roster.some((r) => r.id === id) ? id : null };
  };
  const frameRover = (idx) =>
    rf(page, (i) => {
      const g = window.__rf.game;
      const r = g.sim.rovers[i];
      g.rig.target.set(r.x, 4, r.z);
      g.rig.radius = 60;
      g.rig.update();
    }, idx);
  const projectRover = (idx) =>
    rf(page, (i) => {
      const g = window.__rf.game;
      const r = g.sim.rovers[i];
      const p = g.renderer.project(r.x, r.z);
      return { x: p.x, y: p.y, behind: p.behind };
    }, idx);
  // Entity picking reads mesh world matrices, which normally refresh on
  // render. Push sim state into the meshes and bake the matrices here so
  // the taps below don't depend on rAF having ticked recently.
  const convergeScene = () =>
    rf(page, () => {
      const g = window.__rf.game;
      g.renderer.sync(g.sim);
      g.renderer.scene.updateMatrixWorld(true);
    });
  // Test setup, not a gesture: frame the first rover so the tap below has
  // a real on-screen target at a tappable size.
  await frameRover(0);
  await sleep(400);
  const target = await projectRover(0);
  const onScreen =
    !target.behind && target.x > 0 && target.x < VIEW.width && target.y > 0 && target.y < VIEW.height;
  let selectedId = null;
  if (!check('first rover projects on-screen', onScreen, JSON.stringify(target))) {
    fail('tap selects the rover', 'precondition failed');
    fail('a tap never rotates the camera', 'precondition failed');
  } else {
    const frames = await rf(page, () => window.__rf.game.renderer.renderer.info.render.frame);
    console.log(`info - frames rendered: ${frames}`);
    // Converge, probe the pick directly (so a miss says whether the tap
    // point itself is bad), then tap and record the camera around it.
    const tapRoverAt = async (x, y) => {
      await convergeScene();
      const probe = await rf(
        page,
        ({ x, y }) => {
          const pk = window.__rf.game.renderer.pickTargetAt(x, y);
          return pk ? `${pk.type}#${pk.id}` : 'null';
        },
        { x, y },
      );
      console.log(`info - pick at tap point (${Math.round(x)},${Math.round(y)}): ${probe}`);
      const before = await rigState(page);
      await tapCanvas(page, x, y);
      await sleep(300);
      const after = await rigState(page);
      return { before, after };
    };
    const r1 = await tapRoverAt(target.x, target.y);
    let sel = await readSelection();
    let after = r1.after;
    const before = r1.before;
    // One retry on the twin: in some landing layouts a building or deposit
    // photobombs rover 0's exact screen centre and eats the tap.
    if ((sel.kind !== 'Rover' || sel.id === null) && roster.length > 1) {
      await frameRover(1);
      await sleep(400);
      const t2 = await projectRover(1);
      if (!t2.behind && t2.x > 0 && t2.x < VIEW.width && t2.y > 0 && t2.y < VIEW.height) {
        const r2 = await tapRoverAt(t2.x, t2.y);
        after = r2.after;
        sel = await readSelection();
      }
    }
    selectedId = sel.id;
    check('tap selects the rover', sel.kind === 'Rover' && selectedId !== null, `kind=${sel.kind} title=${sel.title} id=${sel.idText}`);
    check(
      'a tap never rotates the camera',
      Math.abs(after.theta - before.theta) < 1e-9 && Math.abs(after.phi - before.phi) < 1e-9,
      `dTheta=${after.theta - before.theta} dPhi=${after.phi - before.phi}`,
    );
  }

  // ------------------------------------------------- drag rotates ----
  {
    const before = await rigState(page);
    await dragCanvas(page, cx - 50, cy + 60, cx + 50, cy + 60);
    await sleep(200);
    const after = await rigState(page);
    check(
      'single-finger drag rotates the camera',
      Math.abs(after.theta - before.theta) > 0.01,
      `dTheta=${after.theta - before.theta}`,
    );
  }

  // --------------------------------------- long-press orders the rover ----
  if (selectedId === null) {
    fail('long-press orders the selected rover to move', 'precondition: tap-to-select failed');
  } else {
    const px = cx;
    const py = cy + 120;
    const expected = await raycastSynced(page, px, py);
    if (!expected) {
      fail('long-press orders the selected rover to move', 'terrain raycast missed');
    } else {
      await longPressCanvas(page, px, py);
      await sleep(150);
      const cmd = await rf(page, (id) => window.__rf.game.sim.roverById(id)?.command ?? null, selectedId);
      const moved =
        cmd?.type === 'moveTo' &&
        Math.abs(cmd.x - expected.x) < 1e-6 &&
        Math.abs(cmd.z - expected.z) < 1e-6;
      check(
        'long-press orders the selected rover to move',
        moved,
        `cmd=${JSON.stringify(cmd)} want=(${expected.x},${expected.z})`,
      );
    }
  }

  // -------------------------------------------- pinch zoom + pan ----
  {
    const before = await rigState(page);
    await twoFinger(
      page,
      { x: cx - 45, y: cy + 60 },
      { x: cx + 45, y: cy + 60 },
      { x: cx - 85, y: cy + 60 },
      { x: cx + 85, y: cy + 60 },
    );
    await sleep(200);
    const after = await rigState(page);
    check(
      'pinch spread zooms the camera in',
      after.radius < before.radius * 0.9,
      `radius ${before.radius} → ${after.radius}`,
    );
  }
  {
    const before = await rigState(page);
    await twoFinger(
      page,
      { x: cx - 45, y: cy + 60 },
      { x: cx + 45, y: cy + 60 },
      { x: cx + 15, y: cy + 60 },
      { x: cx + 105, y: cy + 60 },
    );
    await sleep(200);
    const after = await rigState(page);
    const drift = Math.hypot(after.tx - before.tx, after.tz - before.tz);
    check('two-finger drag pans the camera', drift > 1, `drift=${drift.toFixed(2)}m`);
  }

  // ------------------------------------------------------- error sweep ----
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  if (consoleErrors.length > 0) {
    // Warning only: headless GL drivers can be chatty, and anything fatal
    // already fails a functional check above.
    console.log(`warn - ${consoleErrors.length} console.error(s); first:`);
    for (const line of consoleErrors.slice(0, 3)) console.log(`warn -   ${line.slice(0, 220)}`);
  }
} catch (err) {
  if (err instanceof Fatal) {
    fail(err.message);
  } else {
    throw err;
  }
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
  console.log(`\nmobile-smoke: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nmobile-smoke: all checks passed');
