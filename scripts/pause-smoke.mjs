/**
 * Pause-menu smoke test: drives the real browser through the flow that used to
 * be broken — click ☰, and instead of "Save failed — the colony could not be
 * read" the player gets a pause menu; save from it; and leave to the main
 * menu with the save actually landing on disk before the page reloads.
 *
 * The regression it pins (in order):
 *   - the ☰ button opens the pause menu and does NOT race a save against the
 *     host teardown (the old bug: dispose rejected the in-flight snapshot)
 *   - the pause menu pauses the sim; resume restores the speed
 *   - "Save game" runs the progress dialog and lands a "Saved" flash
 *   - the settings and expedition tabs render
 *   - "Return to main menu" saves (progress dialog, "Returning to main menu")
 *     and only then reloads onto a menu that offers the colony again
 *   - no uncaught page errors at any point
 *
 * Runs against a served build, like the other smokes:
 *   npm run build && (npx vite preview --port 5199 --strictPort &)
 *   node scripts/setup-playwright.mjs
 *   node scripts/pause-smoke.mjs
 *
 * Env: BASE_URL (default http://127.0.0.1:5199), SMOKE_QUERY (?worker=1 by
 * default — the transport the bug actually lived on).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5199';
const QUERY = process.env.SMOKE_QUERY ?? '?worker=1';

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
class Fatal extends Error {}

const settle = (page, frames = 2) =>
  page.evaluate(async (count) => {
    await document.fonts.ready;
    for (let i = 0; i < count; i++) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, frames);

const rf = (page, fn, arg) => page.evaluate(fn, arg);

async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error(
      'pause-smoke: playwright is not installed.\n' +
        '  node scripts/setup-playwright.mjs\n',
    );
    process.exit(2);
  }
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
    console.warn(`pause-smoke: sparticuz launch failed, trying stock (${err.message})`);
  }
  return await chromium.launch();
}

/** True while the save-failed prompt is on screen. */
const errorPromptVisible = (page) =>
  rf(page, () => {
    const el = document.getElementById('save-error');
    return !!el && el.style.display !== 'none';
  });

/** The text of the transient save flash, if any is showing. */
const flashText = (page) =>
  rf(page, () => {
    const el = document.getElementById('save-flash');
    return el && el.style.display !== 'none' ? el.textContent : '';
  });

async function bootToColony(page) {
  const url = BASE + QUERY;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    console.error(`pause-smoke: could not reach ${url} — is a build served there?\n  ${err.message.split('\n')[0]}`);
    process.exit(2);
  }
  try {
    await page.waitForSelector('.rf-menu', { timeout: 30000 });
    await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 30000 });
  } catch {
    throw new Fatal('the main menu never appeared');
  }

  await page.click('[data-act="new"]');
  await page.waitForSelector('#rf-save-name');
  await page.fill('#rf-save-name', 'Pause Smoke');
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
  await page.fill('#rf-seed', 'SMOKE-P');
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
  await rf(page, () => {
    const hud = window.__rf.game.hud;
    hud.autopauseOnCrit = false;
    hud.setSpeed(1);
  });
  pass('wizard to a live colony');
}

async function main() {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1360, height: 760 } });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  try {
    await bootToColony(page);

    // ------------------------------------------------- the menu button ----
    await page.click('#menu-btn');
    await page.waitForSelector('.rf-pause', { timeout: 5000 });
    check(
      'the ☰ button opens the pause menu',
      await rf(page, () =>
        (document.querySelector('.rf-pause')?.textContent ?? '').includes('MISSION PAUSED'),
      ),
    );
    check('no save-failed prompt after opening the menu', !(await errorPromptVisible(page)));
    const flashAfterMenu = await flashText(page);
    check(
      'no "Save failed" flash after opening the menu',
      !/save failed/i.test(flashAfterMenu),
      `flash="${flashAfterMenu}"`,
    );
    const paused = await rf(page, () => window.__rf.game.hud.speedIdx === 0);
    check('the colony is paused while the menu is open', paused);

    // ------------------------------------------------------ settings tab ----
    await page.click('.rf-pause [data-tab="settings"]');
    const settingsRendered = await rf(page, () => {
      const t = document.querySelector('.rf-pause [data-body="settings"]')?.textContent ?? '';
      return t.includes('Game') && t.includes('Graphical') && t.includes('Interface');
    });
    check('the settings tab shows game, graphical and interface sections', settingsRendered);
    // Flip the weather-FX switch off and back on — a live renderer must accept it.
    const fxResult = await rf(page, () => {
      const g = window.__rf.game;
      const before = g.settings.weatherFx();
      g.settings.setWeatherFx(!before);
      g.applyGraphics();
      const applied = g.settings.weatherFx() === !before;
      g.settings.setWeatherFx(before);
      g.applyGraphics();
      return applied;
    });
    check('the weather-FX setting applies to the live renderer', fxResult);

    // ---------------------------------------------------- expedition tab ----
    await page.click('.rf-pause [data-tab="expedition"]');
    await page.waitForFunction(
      () =>
        (document.querySelector('.rf-pause [data-body="expedition"]')?.textContent ?? '').includes(
          'Life support',
        ),
      { timeout: 5000 },
    );
    check('the expedition tab renders the colony portrait', true);

    // --------------------------------------------------------- save game ----
    await page.click('.rf-pause [data-tab="actions"]');
    await page.click('.rf-pause [data-act="save"]');
    await page.waitForSelector('#save-progress', { state: 'visible', timeout: 5000 });
    check('a manual save raises the progress dialog', true);
    // The "Saved" flash is transient (~1.8 s), so catch it the moment it
    // appears instead of reading it after the progress lifts — and poll on
    // timers, since a stalled headless frame can swallow an rAF poll.
    const flashShown = page
      .waitForFunction(
        () => {
          const f = document.getElementById('save-flash');
          return f && f.style.display !== 'none' ? f.textContent : '';
        },
        undefined,
        { timeout: 15000, polling: 50 },
      )
      .then((h) => h.jsonValue());
    await page.waitForFunction(
      () => document.getElementById('save-progress').style.display === 'none',
      { timeout: 15000, polling: 50 },
    );
    check('the progress dialog lifts once the write settles', true);
    const flashAfterSave = await flashShown;
    check(
      'the save lands as a "Saved" flash, not an error',
      /^Saved/i.test(flashAfterSave),
      `flash="${flashAfterSave}"`,
    );
    check('no save-failed prompt after a successful save', !(await errorPromptVisible(page)));

    // --------------------------------------------------- return to menu ----
    await rf(page, () => {
      window.rfNav = true; // a reload wipes this; the check below proves it
    });
    await page.click('.rf-pause [data-act="quit"]');
    await page.waitForSelector('#save-progress', { state: 'visible', timeout: 5000 });
    check(
      'leaving saves first, under its own progress title',
      (await rf(page, () => document.getElementById('sp-title').textContent)) ===
        'Returning to main menu',
    );
    // The reload is the teardown: the save must have settled before it happens.
    // Poll from the Node side — one fresh evaluate per tick. A long-lived
    // in-page poller (waitForFunction) does not reliably re-arm across the
    // reload on this headless Chromium build, while a fresh evaluate always
    // sees whichever document is current: the old one (rfNav still set) or
    // the new one (it is gone).
    let reloaded = false;
    for (let i = 0; i < 120; i++) {
      if (await rf(page, () => !('rfNav' in window)).catch(() => true)) {
        reloaded = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    if (!reloaded) {
      const state = await rf(page, () => ({
        progress: document.getElementById('save-progress')?.style.display,
        error: document.getElementById('save-error')?.style.display,
        flash: document.getElementById('save-flash')?.textContent,
        started: window.__rf?.game?.started,
        saveInFlight: window.__rf?.game?.saveInFlight,
        lastSave: window.__rf?.game?.lastSave,
        saveContext: window.__rf?.game?.saveContext,
      })).catch((e) => ({ evalFailed: String(e) }));
      console.log('DEBUG quit state:', JSON.stringify(state));
      await page.screenshot({ path: join(ROOT, 'pause-smoke-failure.png') }).catch(() => {});
      throw new Fatal('the page never reloaded after the menu hand-off');
    }
    await page.waitForSelector('.rf-menu', { timeout: 30000 });
    check('the page reloaded onto the main menu', true);
    check('no save-failed prompt after the hand-off', !(await errorPromptVisible(page)));
    const flashAfterLeave = await flashText(page);
    check(
      'no "Save failed" flash after the hand-off',
      !/save failed/i.test(flashAfterLeave),
      `flash="${flashAfterLeave}"`,
    );

    // The save must have actually landed: the menu offers the colony back.
    const offersContinue = await rf(page, () =>
      (document.querySelector('.rf-menu [data-act="continue"]')?.textContent ?? '').includes(
        'Pause Smoke',
      ),
    );
    check('the saved colony is offered on the main menu', offersContinue);

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error(`\npause-smoke [${QUERY}]: ${failures.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log(`\npause-smoke [${QUERY}]: all checks passed`);
}

main().catch((err) => {
  if (err instanceof Fatal) {
    console.error(`pause-smoke: ${err.message}`);
    process.exit(1);
  }
  throw err;
});
