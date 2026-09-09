/**
 * Capture the menu flow as PNGs into ./screenshots/.
 *
 * Runs against a served build (BASE_URL, default http://127.0.0.1:5199):
 *   npm run build && npx vite preview --port 5199 --strictPort &
 *   npm i --no-save playwright && npx playwright install chromium
 *   node scripts/screenshots.mjs
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: join(OUT, name) });

const browser = await chromium.launch();
try {
  // ---------------------------------------------------------- menu flow ----
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(650);
  await shot(page, '01-splash.png');

  await page.waitForSelector('.rf-menu', { timeout: 20000 });
  await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 20000 });
  await sleep(400);
  await shot(page, '02-menu.png');

  // ------------------------------------------------------- new-game wizard --
  await page.click('[data-act="new"]');
  await page.waitForSelector('#rf-save-name');
  await page.fill('#rf-save-name', 'Ares Prime');
  await page.click('[data-grid="diff"] .rf-pick:has-text("Survivor")');
  await sleep(300);
  await shot(page, '03-wizard-mission.png');

  await page.click('[data-act="next"]');
  await page.waitForSelector('[data-grid="size"]');
  await page.click('[data-grid="size"] .rf-pick:has-text("Planetary Survey")');
  await sleep(300);
  await shot(page, '04-wizard-world.png');

  await page.click('[data-act="next"]');
  await page.waitForSelector('.rf-globe-wrap canvas', { timeout: 20000 });
  await sleep(2500); // let the globe spin into a flattering angle
  // Click the canvas middle — usually a zone; harmless when it is not.
  await page.click('.rf-globe-wrap canvas', { position: { x: 300, y: 180 } });
  await sleep(800);
  await shot(page, '05-wizard-landing.png');

  await page.click('[data-act="next"]');
  await page.waitForSelector('.rf-summary');
  await page.click('.rf-advanced-toggle');
  await page.fill('#rf-seed', 'OLYMPUS-1');
  await sleep(400);
  await shot(page, '06-wizard-launch.png');

  // ------------------------------------------------------- world generation -
  // Best effort: begin the mission and catch the descent loading screen,
  // then the live colony as a bonus.
  await page.click('[data-act="next"]');
  await page.waitForSelector('.rf-loading', { timeout: 15000 });
  await sleep(1500);
  await shot(page, '07-worldgen.png');
  try {
    await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 180000 });
    await sleep(2500);
    await shot(page, '08-colony.png');
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
  await sleep(400);
  await shot(loads, '09-loads.png');
  await loads.click('.rf-save-row .rf-dots');
  await loads.waitForSelector('.rf-menu-pop');
  await sleep(300);
  await shot(loads, '10-loads-popover.png');
  await ctx2.close();

  console.log(`screenshots saved to ${OUT}`);
} finally {
  await browser.close();
}
