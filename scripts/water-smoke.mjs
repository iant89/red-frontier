/**
 * P5 water network browser smoke on both real transports.
 * npm run build; npm run preview -- --port 5199
 * node scripts/setup-playwright.mjs; node scripts/water-smoke.mjs
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
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, SMOKE_QUERY: query },
      timeout: 240000,
    });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  process.exit(0);
}
const queries = [process.env.SMOKE_QUERY];
const compiled = await build({
  stdin: {
    resolveDir: ROOT,
    contents: `
    import { Simulation } from './src/sim/Simulation';
    import { buildOnline } from './tests/fixtures/sim';
    const sim = new Simulation({ seed: 813, worldHalf: 420 });
    const shop = buildOnline(sim, 'workshop'); shop.enabled=false;
    const extractor=buildOnline(sim, 'extractor');
    const consumer=buildOnline(sim, 'oxygenator');
    const pump=buildOnline(sim, 'pumpStation');
    const tank=buildOnline(sim, 'waterTank');
    for(let i=0;i<6;i++) buildOnline(sim,'rtg');
    for(const r of sim.rovers) { sim.stopRover(r.id); r.command={type:'wait',seconds:300}; }
    sim.components.pipe=40;
    export default { save:sim.snapshot(), pumpId:pump.id, consumerId:consumer.id, extractorId:extractor.id, tankId:tank.id };
  `,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { default: fixture } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
);
const stubDir = join(ROOT, '.playwright-libs/nss-stub');
const mod = await import('@sparticuz/chromium').catch(() => null);
const useSparticuz =
  mod && (process.env.RF_SPARTICUZ || existsSync(join(stubDir, 'libnss3.so')));
const browser = useSparticuz
  ? await chromium.launch({
      executablePath: await mod.default.executablePath(),
      args: [
        ...mod.default.args.filter((a) => !a.startsWith('--headless')),
        '--disable-dev-shm-usage',
      ],
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${stubDir}:${process.env.LD_LIBRARY_PATH ?? ''}`,
      },
    })
  : await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.setDefaultTimeout(60000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  const query = queries[0];
  await page.goto(base + query, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.rf-menu');
  await page.waitForSelector('.rf-loading', { state: 'detached' });
  await page.evaluate(async ({ save }) => {
    const g = window.__rf.game;
    g.settings.setAutopause(false);
    g.settings.setShadows(false);
    g.settings.setWeatherFx(false);
    g.settings.setRenderResolution('performance');
    const id = g.store.create(
      {
        name: 'Water smoke',
        difficulty: 'pioneer',
        worldSize: 'small',
        region: null,
        seedText: '813',
      },
      save,
      1,
    );
    await g.loadSave(id);
    g.hud.setSpeed(1);
  }, fixture);
  await page.waitForFunction(
    ({ pumpId }) => window.__rf.game.host.view.buildingById(pumpId)?.loadKw > 0,
    fixture,
  );
  await page.evaluate(({ pumpId }) => {
    const g = window.__rf.game;
    g.hud.setSpeed(0);
    g.selected = { type: 'building', id: pumpId };
    g.handleAction('recenter');
    g.syncUI(true);
  }, fixture);
  await page.waitForSelector('[data-water="target"]', { state: 'visible' });
  assert.match(
    await page.locator('[data-water="mode"]').innerText(),
    /Temporary shared plumbing/,
  );
  let count = 0;
  for (const id of [
    0,
    fixture.extractorId,
    fixture.consumerId,
    fixture.tankId,
  ]) {
    await page.selectOption('[data-water="target"]', String(id));
    await page.locator('[data-water="connect"]').click();
    await page.waitForFunction(
      (n) => window.__rf.game.host.view.waterNetwork.links.length === n,
      ++count,
    );
  }
  const before = await page.evaluate(() =>
    window.__rf.game.host.requestSnapshot(),
  );
  assert.ok(before.components.pipe < 40);
  await page.locator('[data-water="commission"]').click();
  await page.waitForFunction(
    () => window.__rf.game.host.view.waterNetwork.active,
  );
  const active = await page.evaluate(() =>
    window.__rf.game.host.requestSnapshot(),
  );
  assert.equal(active.version, 13);
  assert.ok(
    Math.abs(active.fluids.water - before.fluids.water) < 1e-7,
    'commission preserves reserve',
  );
  // Arrange an empty consumer against a full source via the normal snapshot
  // load boundary, then exercise live pipe commands and actual powered ticks.
  for (const id of Object.keys(active.water.tanks)) active.water.tanks[id] = 0;
  active.water.tanks[fixture.extractorId] = 60;
  active.fluids.water = 60;
  await page.evaluate(
    async ({ save, pumpId }) => {
      const g = window.__rf.game;
      await g.host.loadSnapshot(save);
      g.selected = { type: 'building', id: pumpId };
      g.syncUI(true);
    },
    { save: active, pumpId: fixture.pumpId },
  );
  await page.waitForSelector('[data-water="target"]', { state: 'visible' });
  await page.selectOption('[data-water="target"]', String(fixture.consumerId));
  await page.locator('[data-water="disconnect"]').click();
  await page.waitForFunction(
    ({ consumerId }) =>
      window.__rf.game.host.view.waterNetwork.nodes.find(
        (n) => n.id === consumerId,
      ).status === 'Not connected',
    fixture,
  );
  const t = await page.evaluate(() => {
    const g = window.__rf.game;
    g.hud.setSpeed(3);
    return g.host.view.simTime;
  });
  await page.waitForFunction(
    (time) => window.__rf.game.host.view.simTime > time + 2,
    t,
  );
  await page.evaluate(() => window.__rf.game.hud.setSpeed(0));
  assert.equal(
    await page.evaluate(
      ({ consumerId }) =>
        window.__rf.game.host.view.waterNetwork.nodes.find(
          (n) => n.id === consumerId,
        ).water,
      fixture,
    ),
    0,
  );
  await page.locator('[data-water="connect"]').click();
  await page.waitForFunction(
    () => window.__rf.game.host.view.waterNetwork.links.length === 4,
  );
  await page.evaluate(() => window.__rf.game.hud.setSpeed(3));
  await page.waitForFunction(
    ({ consumerId }) =>
      window.__rf.game.host.view.waterNetwork.nodes.find(
        (n) => n.id === consumerId,
      ).water > 0,
    fixture,
  );
  await page.evaluate(() => window.__rf.game.hud.setSpeed(0));
  await page.locator('button[title^="Water network"]').click();
  await page.waitForFunction(
    () =>
      window.__rf.game.renderer.waterOverlay.root.visible &&
      window.__rf.game.renderer.waterOverlay.root.children.length > 0,
  );
  const saved = await page.evaluate(() =>
    window.__rf.game.host.requestSnapshot(),
  );
  await page.evaluate(async (save) => {
    await window.__rf.game.host.loadSnapshot(save);
  }, saved);
  const resumed = await page.evaluate(() =>
    window.__rf.game.host.requestSnapshot(),
  );
  assert.deepEqual(resumed.water, saved.water);
  if (process.env.SMOKE_SCREENSHOT) {
    mkdirSync(join(ROOT, '.probe'), { recursive: true });
    await page.screenshot({
      path: join(
        ROOT,
        `.probe/water-${query.includes('=1') ? 'worker' : 'local'}.png`,
      ),
      timeout: 60000,
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    `ok - pipes, commissioning, conservation, disconnection, pumped supply, save/load and water overlay ${query}`,
  );
} catch (err) {
  mkdirSync(join(ROOT, '.probe'), { recursive: true });
  await page
    .screenshot({ path: join(ROOT, '.probe/water-smoke-failure.png') })
    .catch(() => {});
  throw err;
} finally {
  await browser.close();
}
