/**
 * Capture the menu flow as PNGs into ./screenshots/.
 *
 * Runs against a served build (BASE_URL, default http://127.0.0.1:5199):
 *   npm run build && npx vite preview --port 5199 --strictPort &
 *   npm i --no-save playwright && npx playwright install chromium
 *   node scripts/screenshots.mjs
 *
 * On machines without system NSS (this sandbox, minimal containers), run
 * `node scripts/setup-playwright.mjs` first and launch via the sparticuz
 * Chromium + stub recipe it prints, instead of `npx playwright install`.
 *
 * The .github/workflows/screenshots.yml workflow does all of this on a
 * runner and commits the PNGs back to the branch.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5199';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
mkdirSync(OUT, { recursive: true });

const shot = (page, name) => page.screenshot({ path: join(OUT, name) });

/** Wait for fonts, finite CSS transitions and two painted frames. */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForFunction(() =>
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .every((animation) => animation.playState === 'finished' || animation.playState === 'idle'),
      undefined,
      { timeout: 1500 },
    )
    .catch(() => {});
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Screenshot a loading screen mid-flight: wait until the percent readout hits
 * one of the target beats, falling back to "whatever is on screen" so a fast
 * runner degrades to an early shot instead of a timeout failure.
 */
async function snapProgress(page, name, beats, timeoutMs) {
  try {
    await page.waitForFunction(
      (list) => list.includes(document.querySelector('.rf-progress-pct')?.textContent ?? ''),
      beats,
      { timeout: timeoutMs },
    );
  } catch {
    /* runner was too fast (or too slow) — shoot the current frame */
  }
  await shot(page, name);
}

const browser = await chromium.launch();
try {
  // ---------------------------------------------------------- menu flow ----
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await snapProgress(page, '01-splash.png', ['30%', '58%', '82%'], 8000);

  await page.waitForSelector('.rf-menu', { timeout: 20000 });
  await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 20000 });
  await settle(page);
  await shot(page, '02-menu.png');

  // ------------------------------------------------------- new-game wizard --
  await page.click('[data-act="new"]');
  await page.waitForSelector('#rf-save-name');
  await page.fill('#rf-save-name', 'Ares Prime');
  await page.click('[data-grid="diff"] .rf-pick:has-text("Survivor")');
  await settle(page);
  await shot(page, '03-wizard-mission.png');

  await page.click('[data-act="next"]');
  await page.waitForSelector('[data-grid="size"]');
  await page.click('[data-grid="size"] .rf-pick:has-text("Planetary Survey")');
  await settle(page);
  await shot(page, '04-wizard-world.png');

  await page.click('[data-act="next"]');
  await page.waitForSelector('.rf-globe-wrap canvas', { timeout: 20000 });
  await settle(page); // globe texture and first frames are painted
  // Click the canvas middle — usually a zone; harmless when it is not.
  await page.click('.rf-globe-wrap canvas', { position: { x: 300, y: 180 } });
  await settle(page);
  await shot(page, '05-wizard-landing.png');

  await page.click('[data-act="next"]');
  await page.waitForSelector('.rf-summary');
  await page.click('.rf-advanced-toggle');
  await page.fill('#rf-seed', 'OLYMPUS-1');
  await settle(page);
  await shot(page, '06-wizard-launch.png');

  // ------------------------------------------------------- world generation -
  // Best effort: begin the mission and catch the descent loading screen,
  // then the live colony as a bonus.
  await page.click('[data-act="next"]');
  await page.waitForSelector('.rf-loading', { timeout: 15000 });
  // '68%' is the "Building terrain mesh" beat — it persists through the slow
  // first render, so it is the most reliable mid-load frame to catch.
  await snapProgress(page, '07-worldgen.png', ['56%', '68%', '87%'], 15000);
  try {
    await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 180000 });
    await settle(page);
    await shot(page, '08-colony.png');

    // ------------------------------------------- descent stage (23–27) ----
    // The landed stage is the colony's centrepiece, so it gets its own plate:
    // the strategic read, the windward burn, the tripod, then the same hull at
    // dusk and deep night — the residual heat is a night feature, and these
    // two jump the sol through the dev handle the smoke scripts use (no panel
    // in frame, and the jump re-anchors the sky immediately).
    const stageFrame = async (name, fn) => {
      await page.evaluate(fn);
      await page.waitForTimeout(1200); // let the sun/sim catch the new frame
      await settle(page);
      await shot(page, name);
    };
    const jumpTod = (step) =>
      page.evaluate((v) => {
        const tod = document.querySelector('#dv-tod');
        tod.value = String(v);
        tod.dispatchEvent(new Event('input', { bubbles: true }));
      }, step);
    try {
      await page.waitForFunction(() => Boolean(window.__rf?.game?.rig), undefined, {
        timeout: 15000,
      });
      await stageFrame('23-descent-stage.png', () => {
        const rig = window.__rf.game.rig;
        rig.target.set(0, 16, 0);
        rig.theta = 0.55; rig.phi = 1.05; rig.radius = 150;
        rig.update();
      });
      await stageFrame('24-descent-stage-burn.png', () => {
        const rig = window.__rf.game.rig;
        rig.target.set(0, 13, 0);
        rig.theta = 0.39; rig.phi = 1.34; rig.radius = 44;
        rig.update();
      });
      await stageFrame('25-descent-stage-legs.png', () => {
        const rig = window.__rf.game.rig;
        rig.target.set(0, 5, 0);
        rig.theta = 2.2; rig.phi = 1.36; rig.radius = 40;
        rig.update();
      });
      await page.evaluate(() => window.__rf.game.dev.enable());
      await jumpTod(73); // ~18:15 — last light on the metal
      await stageFrame('26-descent-stage-dusk.png', () => {
        const rig = window.__rf.game.rig;
        rig.target.set(0, 15, 0);
        rig.theta = 5.9; rig.phi = 1.28; rig.radius = 58;
        rig.update();
      });
      await jumpTod(2); // deep night — embers, pad heat and the beacon
      await stageFrame('27-descent-stage-night.png', () => {
        const rig = window.__rf.game.rig;
        rig.target.set(0, 14, 0);
        rig.theta = 0.75; rig.phi = 1.12; rig.radius = 96;
        rig.update();
      });
    } catch (e) {
      console.warn('descent-stage shots skipped:', e.message.split('\n')[0]);
    }
  } catch (e) {
    console.warn('colony shot skipped:', e.message.split('\n')[0]);
  }
  await ctx.close();

  // ------------------------------------------------------------ load game ---
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx2.addInitScript(() => {
    const now = Date.now();
    const metas = [
      {
        id: 'shot-save-1',
        name: 'Elysium Expedition',
        createdAt: now - 86400000 * 2,
        updatedAt: now - 3600000 * 3,
        sol: 12,
        difficulty: 'pioneer',
        worldSize: 'large',
        region: 'Elysium Planitia',
        seedText: 'ARES-7K2Q',
      },
      {
        id: 'shot-save-2',
        name: 'Hellas Deep Drill',
        createdAt: now - 86400000 * 9,
        updatedAt: now - 86400000,
        sol: 41,
        difficulty: 'survivor',
        worldSize: 'planet',
        region: 'Hellas Planitia',
        seedText: 'ARES-9Z1P',
      },
    ];
    localStorage.setItem('red-frontier-saves-v1', JSON.stringify(metas));
    localStorage.setItem('red-frontier-slot-v1:shot-save-1', JSON.stringify({ version: 6, seed: 1 }));
    localStorage.setItem('red-frontier-slot-v1:shot-save-2', JSON.stringify({ version: 6, seed: 2 }));
  });
  const loads = await ctx2.newPage();
  await loads.goto(BASE, { waitUntil: 'domcontentloaded' });
  await loads.waitForSelector('.rf-menu', { timeout: 20000 });
  await loads.waitForSelector('.rf-loading', { state: 'detached', timeout: 20000 });
  await loads.click('[data-act="load"]');
  await loads.waitForSelector('.rf-save-row');
  await settle(page);
  await shot(loads, '09-loads.png');
  await loads.click('.rf-save-row .rf-dots');
  await loads.waitForSelector('.rf-menu-pop');
  await settle(page);
  await shot(loads, '10-loads-popover.png');
  await ctx2.close();

  console.log(`screenshots saved to ${OUT}`);
} finally {
  await browser.close();
}
