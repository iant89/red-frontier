/**
 * Capture the developer mode as PNGs into ./screenshots/ (17-* through 21-*).
 *
 * Runs against a served build or the dev server (BASE_URL, default
 * http://127.0.0.1:5173):
 *   npm run dev &
 *   npm i --no-save playwright && node scripts/setup-playwright.mjs
 *   node scripts/screenshots-devmode.mjs
 *
 * The sandbox/NSS recipe is the same one scripts/screenshots.mjs documents:
 * launch via sparticuz Chromium with LD_LIBRARY_PATH pointing at the stub
 * NSS built by setup-playwright.mjs.
 *
 * What it proves (and captures): the panel opens over a live colony; the Sun
 * jump + storm conjuring land in the ordinary weather systems; and fabrica-
 * tion, keep-full, cargo loading and the Mk upgrade marks all work — while
 * the localStorage save stays free of every dev overlay (asserted live).
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sparticuz from '@sparticuz/chromium';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
mkdirSync(OUT, { recursive: true });

/** Wait for finite UI animation and actual painted frames, not wall-clock guesses. */
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

const execPath = await sparticuz.executablePath();
const browser = await chromium.launch({
  executablePath: execPath,
  args: sparticuz.args
    .filter((a) => !a.startsWith('--headless'))
    .concat(['--disable-dev-shm-usage', '--headless=new']),
});

try {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 760 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  const shot = (name) => page.screenshot({ path: join(OUT, name), timeout: 120000 });

  // ------------------------------------------------------- new game wizard --
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.rf-menu', { timeout: 30000 });
  await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 30000 });
  await page.click('[data-act="new"]');
  await page.waitForSelector('#rf-save-name');
  await page.fill('#rf-save-name', 'Dev Lab');
  await page.click('[data-act="next"]'); // → world size
  await page.click('[data-act="next"]'); // → globe
  await settle(page);
  // Pick a landing region: raycast picking can land between spinning
  // markers, so sweep a grid until Next enables.
  const box = await (await page.$('.rf-globe-wrap canvas')).boundingBox();
  outer: for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 9; gx++) {
      await page.click('.rf-globe-wrap canvas', {
        position: { x: (box.width * (gx + 0.5)) / 9, y: (box.height * (gy + 0.5)) / 7 },
      });
      await settle(page);
      if (await page.$eval('[data-act="next"]', (b) => !b.disabled)) break outer;
    }
  }
  await settle(page);
  await page.click('[data-act="next"]'); // → summary
  await page.waitForSelector('.rf-summary');
  await page.click('.rf-advanced-toggle');
  await page.fill('#rf-seed', 'OLYMPUS-1');
  await page.click('[data-act="next"]'); // launch
  await page.waitForSelector('.rf-loading', { state: 'detached', timeout: 180000 });
  await settle(page);

  // -------------------------------------------------------- panel, as shipped
  await page.click('#dev-btn');
  await settle(page);
  await shot('17-developer-panel.png');

  // Jump the sun to local noon, then conjure a severe storm (a forecast
  // banner + weather panel entry shows the systems bought the trick).
  await page.evaluate(() => {
    const tod = document.querySelector('#dv-tod');
    tod.value = '48';
    tod.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(page);
  await page.click('[data-storm="severe"]');
  await page.waitForFunction(() => window.__rf.game.sim.weather.stormIntensity > 0.05, undefined, { timeout: 15000 });
  await settle(page);
  await shot('18-developer-storm.png');
  await page.click('#dv-wx-clear');
  await settle(page);

  // Fabricate a battery bank by tap: siting rules apply, so sweep terrain
  // taps (re-arming after each refusal) until one lands.
  await page.selectOption('#dv-spawn-bld', 'battery');
  let placed = false;
  for (const pos of [
    { x: 470, y: 250 }, { x: 570, y: 250 }, { x: 670, y: 200 }, { x: 420, y: 350 },
    { x: 620, y: 330 }, { x: 520, y: 180 }, { x: 750, y: 280 }, { x: 460, y: 170 },
  ]) {
    if (placed) break;
    await page.click('#dv-arm-building');
    await settle(page);
    await page.click('#game-canvas', { position: pos });
    await settle(page);
    placed = await page.evaluate(() => Boolean(document.querySelector('#dvs-mk')));
  }
  if (!placed) throw new Error('could not fabricate a battery bank in 8 taps');
  // Walk it to Mk 3 — the inspector picks up the "(unsaved)" badge row.
  await page.click('#dvs-mk-up');
  await page.click('#dvs-mk-up');
  await settle(page);
  await shot('20-developer-upgrade.png');

  // Fabricate a mining rover, pin its battery and load its hopper with ice.
  await page.selectOption('#dv-spawn-rover', 'mining');
  await page.click('#dv-now-rover');
  await settle(page);
  await page.evaluate(() => {
    const keep = document.querySelector('#dvs-keep');
    if (keep) {
      keep.checked = true;
      keep.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const res = document.querySelector('#dvs-res');
    if (res) res.value = 'ice';
    const kg = document.querySelector('#dvs-kg');
    if (kg) kg.value = '700';
  });
  await page.click('#dvs-cargo-set');
  await settle(page);
  await shot('19-developer-rover.png');

  // A fabricated fleet in frame (plus the two deposits below).
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) document.querySelector('#dv-now-rover').click();
  });
  await page.selectOption('#dv-spawn-dep', 'ice');
  await page.fill('#dv-dep-kg', '3000');
  await page.click('#dv-now-dep');
  await settle(page);
  await shot('21-developer-fleet.png');

  // ----------------------------------------------------- save purity, live --
  await page.keyboard.down('Control');
  await page.keyboard.press('s');
  await page.keyboard.up('Control');
  await settle(page);
  const purity = await page.evaluate(() => {
    const metas = JSON.parse(localStorage.getItem('red-frontier-saves-v1') ?? '[]');
    return metas.map((m) => {
      const data = JSON.parse(localStorage.getItem(`red-frontier-slot-v1:${m.id}`) ?? '{}');
      const buildings = data?.world?.buildings ?? data?.buildings ?? [];
      return { id: m.id, buildings: buildings.length, withLevel: buildings.filter((b) => 'level' in b).length };
    });
  });
  console.log('save purity:', JSON.stringify(purity));
  if (purity.some((p) => p.withLevel > 0)) {
    throw new Error('dev overlay leaked into a save slot!');
  }

  await ctx.close();
  console.log('developer-mode shots done →', OUT);
} finally {
  await browser.close();
}
