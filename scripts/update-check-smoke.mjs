#!/usr/bin/env node
/**
 * Update-check smoke test: verifies the in-play "new build available" flow
 * (TDD §23) in a real browser.
 *
 * What it covers (and why each needs a real browser, not jsdom):
 *   - the production build boots a live colony and the checker starts there
 *   - while playing, the game polls its own version.json (the ?updateCheckMs
 *     QA knob tightens the interval so the test does not wait five minutes)
 *   - when the served manifest names a newer commit, the banner appears, the
 *     colony is saved, and the page reloads back to the main menu with the
 *     save intact (the Continue button proves the snapshot landed)
 *   - no uncaught page errors along the way
 *
 * Runs against a served production build (the check is production-only and
 * the manifest only exists in a built tree):
 *   npm run build && (npx vite preview --port 5173 --strictPort &)\
 *   BASE_URL=http://127.0.0.1:5173 node scripts/update-check-smoke.mjs
 *
 * On machines without system NSS (this sandbox, minimal containers), run
 * `node scripts/setup-playwright.mjs` first: this script picks up the
 * sparticuz Chromium + stub NSS it installs automatically.
 *
 * The flow run rewrites dist/version.json while playing and restores it when
 * done (also on failure) — it must only ever point the manifest at a
 * different *full* commit hash, which is exactly what a fresh deploy does.
 *
 * The banner screenshot (UPDATE_CHECK_SHOT) is taken separately, by calling
 * the real hud.showUpdateNotice() on a paused colony: the live flow reloads
 * the page ~3 s after the save, and under software GL a frame can take 20+ s
 * to composite — a mid-flow capture would race the reload and capture the
 * menu instead of the banner.
 *
 * Exit codes: 0 all checks passed, 1 a check failed (see FAIL lines),
 * 2 the harness itself broke (no browser, no server, usage).
 *
 * Env knobs:
 *   BASE_URL           where the game is served (default http://127.0.0.1:5173)
 *   UPDATE_CHECK_SHOT  where to dump a screenshot of the update banner
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
      'save-and-reload update flow. Serve a build first:\n' +
      '  npm run build && npx vite preview --port 5173 --strictPort &\n' +
      '  node scripts/update-check-smoke.mjs',
  );
  process.exit(0);
}

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const SAVE_NAME = 'Update Smoke';
const FAKE_NEWER = 'f'.repeat(39) + 'a'; // a full 40-hex sha, certainly not this build

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
    // The QA knob tightens the 5-minute poll to 1.5 s so the flow is testable
    // without waiting for the production interval.
    await page.goto(`${BASE}/?updateCheckMs=1500`, { waitUntil: 'load' });
    await page.waitForSelector('.rf-menu', { timeout: 30000 });
    await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 30000 }).catch(
      () => null,
    );
    pass('boot to the main menu');

    await bootColony(page);
    pass('wizard to a live colony');

    if (process.env.UPDATE_CHECK_SHOT) {
      // Deterministic banner capture (see the header): the real notice
      // renderer on a paused colony, no poll/save/reload race. Best-effort —
      // a slow compositor must never fail the flow checks.
      try {
        await page.evaluate(() => {
          window.__rf.game.hud.setSpeed(0);
          window.__rf.game.hud.showUpdateNotice(
            '1f8e9e0fc803259a0bf43b05305bda5f5950fa06',
            '7c48989d0e42a772c4f274e0d5468c7e68e17739',
          );
        });
        await settle(page, 4);
        await page.screenshot({ path: process.env.UPDATE_CHECK_SHOT, timeout: 120000 });
        pass(`screenshot -> ${process.env.UPDATE_CHECK_SHOT}`);
      } catch (e) {
        console.warn(`warn - screenshot skipped: ${String(e.message).split('\n')[0]}`);
      }
      await page.evaluate(() => window.__rf.game.hud.hideUpdateNotice()).catch(() => null);
    }

    // The first poll already ran at launch and saw the matching manifest —
    // no banner while the build is current.
    await page.waitForTimeout(4000);
    check(
      'no notice while the build is current',
      (await page.$eval('#update-banner', (el) => el.style.display)) === 'none',
    );

    // A "deploy" lands: the served manifest now names a newer commit.
    const newer = JSON.parse(original);
    newer.commit = FAKE_NEWER;
    writeFileSync(MANIFEST, `${JSON.stringify(newer, null, 2)}\n`);
    pass('manifest updated to a newer build');

    await page.waitForFunction(
      () => {
        const b = document.querySelector('#update-banner');
        return b && b.style.display !== 'none';
      },
      { timeout: 20000 },
    );
    pass('update banner appeared');
    const title = await page.$eval('#update-title', (el) => el.textContent);
    check('banner names the situation', /NEW BUILD AVAILABLE/i.test(title), title);
    // The save can finish before we read the banner, so either phase text is
    // the correct observation at this instant.
    const foundText = await page.$eval('#update-text', (el) => el.textContent);
    check(
      'banner explains save + reload',
      /saving your colony/i.test(foundText) || /Colony saved/i.test(foundText),
      foundText,
    );

    // The colony is persisted and the page reloads onto the "new" build.
    await page.waitForFunction(
      () => /Colony saved/i.test(document.querySelector('#update-text')?.textContent ?? ''),
      null,
      { timeout: 30000 },
    );
    pass('colony saved');

    await page.waitForSelector('.rf-menu', { timeout: 60000 });
    pass('page reloaded back to the main menu');
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
