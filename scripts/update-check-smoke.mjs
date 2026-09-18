#!/usr/bin/env node
/**
 * Update-check smoke test: verifies the in-play "new build available" card
 * (TDD §23) in a real browser.
 *
 * What it covers (and why each needs a real browser, not jsdom):
 *   - the production build boots a live colony and the checker starts there
 *   - while playing, the game polls its own version.json (the ?updateCheckMs
 *     QA knob tightens the interval so the test does not wait five minutes)
 *   - when the served manifest names a newer commit, a FROSTED CARD appears:
 *     it lists what is new and tells the player to save and reload
 *   - nothing happens automatically: over a 5 s window the colony is not
 *     saved and the page is not reloaded
 *   - "Later" dismisses the card and the colony resumes at its old speed
 *   - reloading the page manually brings the colony back and the check
 *     re-raises the card (the one-shot poller re-arms on a fresh page)
 *   - the player's own "Save colony" click runs the normal save, and only
 *     then does the card offer "Reload now"; that click reloads the page and
 *     the Continue button proves the snapshot landed
 *   - no uncaught page errors along the way
 *
 * Runs against a served production build (the check is production-only and
 * the manifest only exists in a built tree):
 *   npm run build && (npx vite preview --port 5173 --strictPort &)
 *   BASE_URL=http://127.0.0.1:5173 node scripts/update-check-smoke.mjs
 *
 * On machines without system NSS (this sandbox, minimal containers), run
 * `node scripts/setup-playwright.mjs` first: this script picks up the
 * sparticuz Chromium + stub NSS it installs automatically.
 *
 * The flow run rewrites dist/version.json while playing and restores it when
 * done (also on failure) — it must only ever point the manifest at a
 * different *full* commit hash, which is exactly what a fresh deploy does.
 * The rewrite also carries a small `notes` changelog, the way the real
 * build manifest does (vite writes the recent commit subjects).
 *
 * The card screenshot (UPDATE_CHECK_SHOT) is taken separately, by calling
 * the real hud.showUpdateNotice() on a paused colony: the live flow keeps
 * the card up until the player acts, and under software GL a frame can take
 * 20+ s to composite — the capture is a best-effort extra, not a gate.
 *
 * Exit codes: 0 all checks passed, 1 a check failed (see FAIL lines),
 * 2 the harness itself broke (no browser, no server, usage).
 *
 * Env knobs:
 *   BASE_URL           where the game is served (default http://127.0.0.1:5173)
 *   SMOKE_QUERY        extra query params (worker-smoke convention;
 *                       SMOKE_QUERY='worker=0' for the in-process host)
 *   UPDATE_CHECK_SHOT  where to dump a screenshot of the update card
 *                       (defaults to none)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = join(ROOT, 'dist', 'version.json');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node scripts/update-check-smoke.mjs\n\n' +
      'Boots a live colony from BASE_URL (default http://127.0.0.1:5173),\n' +
      'points dist/version.json at a newer commit, and asserts the\n' +
      'card tells the player what is new and that saving + reloading is\n' +
      'their own two clicks (nothing happens automatically). Serve a\n' +
      'build first:\n' +
      '  npm run build && npx vite preview --port 5173 --strictPort &\n' +
      '  node scripts/update-check-smoke.mjs',
  );
  process.exit(0);
}

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
// The poll interval must stay tight for the flow to be testable; SMOKE_QUERY
// adds the transport opt-out (worker-smoke convention): SMOKE_QUERY='worker=0'.
const EXTRA = (process.env.SMOKE_QUERY ?? '').replace(/^\?/, '');
const QUERY = `?updateCheckMs=1500${EXTRA ? `&${EXTRA}` : ''}`;
const SAVE_NAME = 'Update Smoke';
const FAKE_NEWER = 'f'.repeat(39) + 'a'; // a full 40-hex sha, certainly not this build
const NOTES = [
  'In-game pause menu with expedition stats',
  'A stable return-to-menu save',
  'Frosted save progress and fault dialogs',
];

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
      'update-check-smoke: playwright is not installed.\n' +
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
    console.warn(`update-check-smoke: sparticuz launch failed, trying stock (${err.message})`);
  }
  return chromium.launch({ headless: true });
}

/** Wait for browser frames instead of guessing how fast this runner renders. */
const settle = (page, frames = 2) =>
  page.evaluate(async (count) => {
    await document.fonts.ready;
    for (let i = 0; i < count; i++) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, frames);

/** Read the live Game's private state (TS privacy is compile-time only). */
const gameState = (page) =>
  page.evaluate(() => ({
    sim: Boolean(window.__rf?.game?.sim),
    speed: window.__rf?.game?.hud?.speedIdx ?? -1,
    lastSave: window.__rf?.game?.lastSave ?? null,
    card: (document.querySelector('#update-banner')?.style.display ?? 'none') !== 'none',
  }));

/** The new-game wizard, exactly as mobile-smoke drives it (desktop viewport). */
async function bootColony(page) {
  await page.click('[data-act="new"]');
  await page.waitForSelector('#rf-save-name');
  await page.fill('#rf-save-name', SAVE_NAME);
  await page.click('[data-act="next"]'); // → world size
  await page.waitForSelector('[data-grid="size"]');
  await page.click('[data-grid="size"] .rf-pick:has-text("Outpost")');
  await page.click('[data-act="next"]'); // → landing globe
  await page.waitForSelector('.rf-globe-wrap canvas');
  await settle(page);
  // Raycast picking can land between spinning markers, so sweep a grid
  // until a zone catches and Next enables.
  let picked = false;
  for (let pass = 0; pass < 2 && !picked; pass++) {
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
  await page.click('[data-act="next"]'); // → launch review
  await page.waitForSelector('.rf-summary');
  await page.click('[data-act="next"]'); // Begin Mission
  try {
    await page.waitForSelector('.rf-loading', { timeout: 15000 }).catch(() => null);
    await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 180000 });
  } catch {
    throw new Fatal('world generation never finished');
  }
  await settle(page);
  if (!(await page.evaluate(() => Boolean(window.__rf?.game?.sim)))) {
    throw new Fatal('reached no live simulation after worldgen');
  }
}

/** Back in the menu: relaunch the same save by name. */
async function continueColony(page) {
  await page.waitForSelector('.rf-menu', { timeout: 60000 });
  const continueBtn = page.locator('[data-act="continue"]').first();
  const label = (await continueBtn.textContent().catch(() => '')) ?? '';
  if (!label.includes(SAVE_NAME)) throw new Fatal(`no Continue for "${SAVE_NAME}" in the menu`);
  await continueBtn.click();
  await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 180000 });
  await settle(page);
  if (!(await page.evaluate(() => Boolean(window.__rf?.game?.sim)))) {
    throw new Fatal('Continue did not reach a live simulation');
  }
}

// --------------------------------------------------------------------- main ----

const original = existsSync(MANIFEST)
  ? readFileSync(MANIFEST, 'utf8')
  : null;
if (!original) {
  console.error('update-check-smoke: dist/version.json is missing — run `npm run build` first.');
  process.exit(2);
}

try {
  const serverAlive = await fetch(`${BASE}/version.json`, { cache: 'no-store' })
    .then((r) => r.ok)
    .catch(() => false);
  if (!serverAlive) {
    console.error(
      `update-check-smoke: could not reach ${BASE}/version.json — is a build served there?`,
    );
    process.exit(2);
  }

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  try {
    // The QA knob tightens the 5-minute poll so the flow is testable without
    // waiting for the production interval. It rides along through the manual
    // reload below, which is what re-arms the one-shot check.
    await page.goto(`${BASE}/${QUERY}`, { waitUntil: 'load' });
    await page.waitForSelector('.rf-menu', { timeout: 30000 });
    await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 30000 }).catch(
      () => null,
    );
    pass('boot to the main menu');

    await bootColony(page);
    pass('wizard to a live colony');

    // The no-save window below is about *the update flow* not saving. The
    // colony's own 45 s autosave uses the same quiet save and is
    // indistinguishable via lastSave, so it would be a confound, not a
    // signal. Switch the cadence off for the run; the old (buggy) flow saved
    // via a *direct* save() in onNewBuild, so the regression stays tested.
    await page.evaluate(() => {
      window.__rf.game.autosaveSec = 0;
    });

    if (process.env.UPDATE_CHECK_SHOT) {
      // Deterministic card capture (see the header): the real notice
      // renderer on a paused colony, with a changelog, no poll race.
      // Best-effort — a slow compositor must never fail the flow checks. The
      // helper is self-contained: it pauses for the capture and restores the
      // speed, so the live flow that follows sees a normal, running colony.
      try {
        await page.evaluate((notes) => {
          const game = window.__rf.game;
          const hud = game.hud;
          const prior = hud.speedIdx;
          hud.setSpeed(0);
          hud.showUpdateNotice({
            current: '1f8e9e0fc803259a0bf43b05305bda5f5950fa06',
            latest: '7c48989d0e42a772c4f274e0d5468c7e68e17739',
            notes,
          });
          window.__rf._shotPriorSpeed = prior;
        }, NOTES);
        await settle(page, 4);
        await page.screenshot({ path: process.env.UPDATE_CHECK_SHOT, timeout: 120000 });
        pass(`screenshot -> ${process.env.UPDATE_CHECK_SHOT}`);
      } catch (e) {
        console.warn(`warn - screenshot skipped: ${String(e.message).split('\n')[0]}`);
      }
      await page
        .evaluate(() => {
          const game = window.__rf.game;
          game.hud.hideUpdateNotice();
          if (typeof window.__rf._shotPriorSpeed === 'number') {
            game.hud.setSpeed(window.__rf._shotPriorSpeed);
            delete window.__rf._shotPriorSpeed;
          }
        })
        .catch(() => null);
    }

    // The first poll already ran at launch and saw the matching manifest —
    // no card while the build is current.
    await page.waitForTimeout(4000);
    check(
      'no card while the build is current',
      (await gameState(page)).card === false,
    );

    // A "deploy" lands: the served manifest now names a newer commit, with
    // the changelog the build would have written.
    const newer = JSON.parse(original);
    newer.commit = FAKE_NEWER;
    newer.notes = NOTES;
    writeFileSync(MANIFEST, `${JSON.stringify(newer, null, 2)}\n`);
    pass('manifest updated to a newer build');

    await page.waitForFunction(
      () => {
        const b = document.querySelector('#update-banner');
        return b && b.style.display === 'flex';
      },
      { timeout: 20000 },
    );
    pass('update card appeared');

    const title = await page.$eval('#update-title', (el) => el.textContent);
    check('card names the situation', /NEW VERSION IS LIVE/i.test(title), title);
    const listed = await page.$$eval('#update-notes li', (els) => els.map((el) => el.textContent));
    check('card lists what is new', JSON.stringify(listed) === JSON.stringify(NOTES), listed.join(' | '));
    const builds = await page.$eval('#update-builds', (el) => el.textContent);
    check('card shows the build step', /build [0-9a-f]{7}\s*→\s*build fffffff/.test(builds), builds);
    const foundText = await page.$eval('#update-text', (el) => el.textContent);
    check(
      'card says the player must save and reload',
      /save/i.test(foundText) && /reload/i.test(foundText),
      foundText,
    );
    const st1 = await gameState(page);
    check('the colony is frozen for a readable card', st1.speed === 0 && st1.sim, JSON.stringify(st1));
    check(
      'reload is not offered before a save succeeds',
      (await page.$eval('#ub-reload', (el) => el.style.display)) === 'none',
    );

    // THE core of the change: over five seconds the page saves nothing and
    // reloads nothing. The card just waits for the player.
    await page.waitForTimeout(5000);
    const st2 = await gameState(page);
    check(
      'no automatic save within 5 s',
      st2.lastSave === null || st2.lastSave.ok === null,
      JSON.stringify(st2.lastSave),
    );
    check(
      'no automatic reload within 5 s',
      st2.card === true && st2.sim === true,
      JSON.stringify(st2),
    );

    // "Later": the player keeps this build; the card is gone and the colony
    // resumes at the speed it had when the notice arrived.
    await page.click('#ub-later');
    const st3 = await gameState(page);
    check(
      '"Later" dismisses the card and resumes the colony',
      st3.card === false && st3.speed === 1 && st3.sim === true,
      JSON.stringify(st3),
    );

    // A manual page reload is the player's own way back — and on the fresh
    // page the one-shot check re-runs and raises the card again. Wait only on
    // the navigation committing: under software GL the reloaded document's
    // 'load' event can stall behind the old frame pipeline, and the menu
    // selector below is the real gate anyway.
    await page.reload({ waitUntil: 'commit', timeout: 60000 });
    await continueColony(page);
    await page.waitForFunction(
      () => {
        const b = document.querySelector('#update-banner');
        return b && b.style.display === 'flex';
      },
      { timeout: 20000 },
    );
    pass('the card is back after the player reloads and continues');

    // Now the player does the two things the card asked for.
    await page.click('#ub-save');
    await page.waitForSelector('#save-progress', { state: 'visible', timeout: 20000 });
    await page.waitForFunction(
      () => {
        const r = document.querySelector('#ub-reload');
        return r && r.style.display !== 'none';
      },
      { timeout: 30000 },
    );
    const savedText = await page.$eval('#update-text', (el) => el.textContent);
    check(
      'the save the player asked for is reported on the card',
      /saved/i.test(savedText) && /reload/i.test(savedText),
      savedText,
    );
    const st4 = await gameState(page);
    check(
      'the save wrote to storage',
      st4.lastSave !== null && st4.lastSave.ok === true,
      JSON.stringify(st4.lastSave),
    );

    // And only now — with the save proven — does the player reload.
    await page.click('#ub-reload');
    await page.waitForSelector('.rf-menu', { timeout: 60000 });
    pass('the page reloaded back to the main menu on the player\'s click');
    const continueBtn = await page
      .locator('[data-act="continue"]')
      .first()
      .textContent()
      .catch(() => '');
    check('the save survived the reload', continueBtn?.includes(SAVE_NAME), continueBtn ?? null);

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    writeFileSync(MANIFEST, original);
    await browser.close().catch(() => null);
  }
} catch (err) {
  if (err instanceof Fatal) throw err;
  fail('harness', String(err?.message ?? err));
}

if (failures.length) {
  console.error(`\nupdate-check-smoke: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nupdate-check-smoke: all checks passed');
