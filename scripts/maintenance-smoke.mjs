/**
 * P5 Repair Bay browser smoke on both real transports.
 * npm run build; npm run preview -- --port 5199
 * node scripts/setup-playwright.mjs; node scripts/maintenance-smoke.mjs
 * Optional BASE_URL and SMOKE_QUERY (?worker=0 or ?worker=1); defaults to both.
 * Fixture enters via SaveStore + the normal load path, never by mutating a view.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const base = process.env.BASE_URL ?? 'http://127.0.0.1:5199';
// A fresh browser per transport avoids single-process software-GL teardown
// stalling the next navigation in minimal containers.
if (!process.env.SMOKE_QUERY) {
  for (const query of ['?worker=1', '?worker=0']) {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, SMOKE_QUERY: query },
      timeout: 240000,
    });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  process.exit(0);
}
const queries = [process.env.SMOKE_QUERY];
const compiled = await build({
  stdin: { resolveDir: ROOT, contents: `
    import { Simulation } from './src/sim/Simulation';
    import { buildOnline } from './tests/fixtures/sim';
    import { ComponentSystem } from './src/sim/systems/ComponentSystem';
    const sim = new Simulation({ seed: 515, worldHalf: 420, nearDeposits: 0.2 });
    const shop = buildOnline(sim, 'workshop');
    shop.enabled = false; // keep the spare count fixed for the assertions
    const bay = buildOnline(sim, 'repairBay');
    for (let i = 0; i < 4; i++) buildOnline(sim, 'rtg');
    for (const r of sim.rovers) {
      sim.stopRover(r.id);
      r.command = { type: 'wait', seconds: 120 };
    }
    const r = sim.rovers[0];
    Object.assign(r, { x: bay.x + 10, z: bay.z, recharge: false, phase: 'idle' });
    r.parts.motor = 25;
    ComponentSystem.store(sim.state, 'motor', 2);
    export default { save: sim.snapshot(), bayId: bay.id, roverId: r.id };
  ` },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { default: fixture } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const stubDir = join(ROOT, '.playwright-libs/nss-stub');
const mod = await import('@sparticuz/chromium').catch(() => null);
const useSparticuz = mod && (process.env.RF_SPARTICUZ || existsSync(join(stubDir, 'libnss3.so')));
const browser = useSparticuz ? await chromium.launch({
  executablePath: await mod.default.executablePath(),
  args: [...mod.default.args.filter((a) => !a.startsWith('--headless')), '--disable-dev-shm-usage'],
  env: { ...process.env, LD_LIBRARY_PATH: `${stubDir}:${process.env.LD_LIBRARY_PATH ?? ''}` },
}) : await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.setDefaultTimeout(30000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  for (const query of queries) {
    await page.goto(base + query, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.rf-menu');
    await page.waitForSelector('.rf-loading', { state: 'detached' });
    await page.evaluate(async ({ save }) => {
      const g = window.__rf.game;
      g.settings.setAutopause(false);
      g.settings.setShadows(false);
      g.settings.setWeatherFx(false);
      g.settings.setRenderResolution('performance');
      const id = g.store.create({ name: 'Maintenance smoke', difficulty: 'pioneer', worldSize: 'small', region: null, seedText: '515' }, save, 1);
      await g.loadSave(id);
      g.hud.setSpeed(0);
    }, fixture);
    await page.evaluate(({ bayId }) => {
      const g = window.__rf.game;
      g.selected = { type: 'building', id: bayId };
      g.handleAction('recenter');
      g.syncUI(true);
    }, fixture);
    await page.waitForSelector('#b-maintenance', { state: 'visible' });
    assert.match(await page.locator('#b-maint-stock').innerText(), /2 motors/);
    await page.evaluate(() => window.__rf.game.hud.setSpeed(3));
    await page.waitForFunction(({ bayId }) => window.__rf.game.host.view.buildingById(bayId)?.maintenance?.progress > 0.15,
      fixture, { timeout: 45000, polling: 50 });
    await page.evaluate(() => window.__rf.game.hud.setSpeed(0));
    assert.match(await page.locator('#b-maint-part').innerText(), /Drive Motor/);
    const saved = await page.evaluate(() => window.__rf.game.host.requestSnapshot());
    assert.equal(saved.version, 13);
    assert.ok(saved.buildings.find((b) => b.id === fixture.bayId).maintenance.progress > 0);
    assert.equal(saved.components.motor, 2, 'no partial-job debit');
    await page.evaluate(async (save) => {
      const g = window.__rf.game;
      await g.host.loadSnapshot(save);
      g.hud.setSpeed(3);
    }, saved);
    await page.waitForFunction(({ roverId }) => window.__rf.game.host.view.roverById(roverId).parts.motor === 100,
      fixture, { timeout: 45000, polling: 50 });
    await page.evaluate(() => window.__rf.game.hud.setSpeed(0));
    const final = await page.evaluate(() => window.__rf.game.host.requestSnapshot());
    assert.equal(final.components.motor, 1, 'exactly one motor spent across save/load');
    assert.equal(final.rovers[0].parts.motor, 100);
    await page.evaluate(({ roverId }) => {
      const g = window.__rf.game;
      g.selected = { type: 'rover', id: roverId };
      g.syncUI(true);
    }, fixture);
    assert.equal(await page.locator('#i-part-motor').innerText(), '100%');
    assert.equal(await page.locator('#i-part-circuitBoard').innerText(), '100%');
    // Also inspect the distinct procedural model in the actual WebGL renderer.
    if (process.env.SMOKE_SCREENSHOT) {
      mkdirSync(join(ROOT, '.probe'), { recursive: true });
      await page.screenshot({ path: join(ROOT, `.probe/maintenance-${query.includes('=1') ? 'worker' : 'local'}.png`), timeout: 60000 });
    }
    console.log(`ok - Repair Bay: progress, parts, save/load, renderer and HUD ${query}`);
  }
  assert.deepEqual(errors, [], 'no browser errors');
  console.log('maintenance-smoke: all checks passed');
} catch (err) {
  mkdirSync(join(ROOT, '.probe'), { recursive: true });
  await page.screenshot({ path: join(ROOT, '.probe/maintenance-smoke-failure.png') }).catch(() => {});
  throw err;
} finally {
  await browser.close();
}
