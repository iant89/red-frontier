/**
 * P5 engineering browser smoke on both real transports.
 * npm run build; npm run preview -- --port 5199
 * node scripts/setup-playwright.mjs; node scripts/engineering-smoke.mjs
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
      timeout: 360000,
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
  import { ALL_RESOURCES,ALL_COMPONENTS,BUILDINGS } from './src/sim/defs';
  const sim=new Simulation({seed:515,worldHalf:420});
  const shop=buildOnline(sim,'workshop');shop.enabled=false;
  const garage=buildOnline(sim,'garage');buildOnline(sim,'warehouse');
  for(let i=0;i<5;i++)buildOnline(sim,'rtg');
  for(const r of sim.rovers){sim.stopRover(r.id);r.rules.autoHaul=false;r.rules.autoService=false;}
  const r=sim.rovers[0];r.x=garage.x+BUILDINGS.garage.radius+3;r.z=garage.z;r.recharge=false;
  r.y=sim.world.heightAt(r.x,r.z);r.phase='idle';
  for(const k of ALL_RESOURCES)sim.storage[k]=sim.storageCapacity();
  for(const k of ALL_COMPONENTS)sim.components[k]=24;
  export default {save:sim.snapshot(),roverId:r.id,garageId:garage.id,shopId:shop.id};
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

async function pickPoint(type, id) {
  await page.evaluate(
    ({ type, id }) => {
      const g = window.__rf.game;
      g.selected = { type, id };
      g.handleAction('recenter');
      g.syncUI(true);
      if (window.innerWidth < 761) {
        g.hud.setVitalsCollapsed(true);
        g.hud.setInspectorCollapsed(true);
        g.hud.setMinimapCollapsed(true);
      }
    },
    { type, id },
  );
  return await page
    .waitForFunction(
      ({ type, id }) => {
        const g = window.__rf.game,
          e =
            type === 'rover'
              ? g.host.view.roverById(id)
              : g.host.view.buildingById(id);
        const p = g.renderer.project(e.x, e.z);
        for (let d = 0; d < 70; d += 5)
          for (const [dx, dy] of [
            [0, -d],
            [d, 0],
            [-d, 0],
            [0, d],
            [d, -d],
            [-d, -d],
          ]) {
            const x = p.x + dx,
              y = p.y + dy,
              h = g.renderer.pickTargetAt(x, y);
            if (
              h?.type === type &&
              h.id === id &&
              document.elementFromPoint(x, y)?.id === 'game-canvas'
            )
              return { x, y };
          }
        return false;
      },
      { type, id },
    )
    .then((h) => h.jsonValue());
}
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
        name: 'Engineering smoke',
        difficulty: 'pioneer',
        worldSize: 'small',
        region: null,
        seedText: '515',
      },
      save,
      1,
    );
    await g.loadSave(id);
    g.hud.setSpeed(0);
  }, fixture);
  const point = await pickPoint('rover', fixture.roverId);
  await page.evaluate(() => window.__rf.game.hud.setSpeed(3));
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.waitForSelector('.engineering-dialog');
  assert.equal(await page.evaluate(() => window.__rf.game.hud.speedIdx), 0);
  assert.ok(
    await page.locator('.engineering-model canvas').count(),
    'real 3D preview',
  );
  assert.ok(
    await page
      .locator('.engineering-content svg[aria-label="Aluminum Ore"]')
      .count(),
  );
  assert.ok(
    await page
      .locator('.engineering-content svg[aria-label="Drive Motor"]')
      .count(),
  );
  const paused = await page.evaluate(() =>
    window.__rf.game.host.requestSnapshot(),
  );
  const rotation = await page.evaluate(
    () => window.__rf.game.engineeringCtrl.preview.turntable.rotation.y,
  );
  await page.waitForFunction(
    (a) =>
      window.__rf.game.engineeringCtrl.preview.turntable.rotation.y > a + 0.02,
    rotation,
  );
  const still = await page.evaluate(() =>
    window.__rf.game.host.requestSnapshot(),
  );
  assert.equal(
    still.simTime,
    paused.simTime,
    'colony stays paused while model rotates',
  );
  await page.locator('[data-tab="appearance"]').click();
  await page.locator('[data-paint="#3e8299"]').click();
  await page.locator('.engineering-apply').click();
  await page.waitForFunction(
    ({ roverId }) =>
      window.__rf.game.host.view.roverById(roverId).paint === '#3e8299',
    fixture,
  );
  await page.locator('[data-tab="upgrades"]').click();
  await page.locator('[data-upgrade="battery"]').click();
  await page.waitForFunction(
    ({ roverId }) =>
      window.__rf.game.host.view.roverById(roverId).upgradeJob?.upgrade ===
      'battery',
    fixture,
  );
  const funded = await page.evaluate(() =>
    window.__rf.game.host.requestSnapshot(),
  );
  assert.equal(funded.components.batteryPack, 22);
  assert.equal(funded.rovers[0].upgradeJob.progress, 0);
  mkdirSync(join(ROOT, '.probe'), { recursive: true });
  if (process.env.SMOKE_SCREENSHOT)
    await page.screenshot({
      path: join(
        ROOT,
        `.probe/engineering-desktop-${query.includes('=1') ? 'worker' : 'local'}.png`,
      ),
      timeout: 60000,
    });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.engineering-dialog', { state: 'detached' });
  assert.equal(await page.evaluate(() => window.__rf.game.hud.speedIdx), 3);
  await page.waitForFunction(
    ({ roverId }) =>
      window.__rf.game.host.view.roverById(roverId).upgradeJob?.progress > 0.08,
    fixture,
  );
  await page.evaluate(() => window.__rf.game.hud.setSpeed(0));
  if (process.env.SMOKE_SCREENSHOT)
    await page.screenshot({
      path: join(
        ROOT,
        `.probe/engineering-world-${query.includes('=1') ? 'worker' : 'local'}.png`,
      ),
      timeout: 60000,
    });
  const mid = await page.evaluate(() =>
    window.__rf.game.host.requestSnapshot(),
  );
  assert.equal(mid.version, 13);
  // Explicit fixed advances keep the resumed-job test independent of software-GL frame rate.
  await page.evaluate(async (save) => {
    const g = window.__rf.game;
    g.hud.setSpeed(0);
    await g.host.loadSnapshot(save);
    for (let i = 0; i < 110; i++) {
      g.host.step(0.25);
      await g.host.requestSnapshot();
    }
  }, mid);
  await page.waitForFunction(
    ({ roverId }) =>
      window.__rf.game.host.view.roverById(roverId).upgrades?.battery === 1,
    fixture,
    { timeout: 150000 },
  );
  await page.evaluate(() => window.__rf.game.hud.setSpeed(0));
  const done = await page.evaluate(() =>
    window.__rf.game.host.requestSnapshot(),
  );
  assert.equal(done.components.batteryPack, 22);
  assert.equal(done.rovers[0].paint, '#3e8299');
  // Trusted touch input: exercise the actual long-press timer, not a direct UI call.
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await pickPoint('building', fixture.shopId);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: mobile.x, y: mobile.y }],
  });
  await page.waitForSelector('.engineering-dialog');
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  assert.match(
    await page.locator('#engineering-title').innerText(),
    /Workshop/,
  );
  if (process.env.SMOKE_SCREENSHOT)
    await page.screenshot({
      path: join(
        ROOT,
        `.probe/engineering-touch-preview-${query.includes('=1') ? 'worker' : 'local'}.png`,
      ),
      timeout: 60000,
    });
  await page.locator('[data-tab="actions"]').click();
  assert.equal(await page.locator('[data-recipe]').count(), 6);
  await page.locator('[data-recipe="5"]').click();
  await page.waitForFunction(
    ({ shopId }) =>
      window.__rf.game.host.view.buildingById(shopId).recipe === 5,
    fixture,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
    'no horizontal overflow',
  );
  if (process.env.SMOKE_SCREENSHOT)
    await page.screenshot({
      path: join(
        ROOT,
        `.probe/engineering-mobile-${query.includes('=1') ? 'worker' : 'local'}.png`,
      ),
      timeout: 60000,
    });
  await page.locator('.engineering-return').click();
  assert.equal(
    await page.evaluate(() => window.__rf.game.hud.speedIdx),
    0,
    'previous pause preserved',
  );
  await cdp.detach();
  assert.deepEqual(errors, []);
  console.log(
    `ok - desktop right click, touch long press, rotating model, pause lease, icon costs, paint, timed paid refit, save/load and six manufacturing lines ${query}`,
  );
} catch (err) {
  console.error(
    await page
      .evaluate(() => ({
        time: window.__rf?.game?.host?.view?.simTime,
        rover: window.__rf?.game?.host?.view?.rovers?.[0],
      }))
      .catch(() => null),
  );
  mkdirSync(join(ROOT, '.probe'), { recursive: true });
  await page
    .screenshot({
      path: join(ROOT, '.probe/engineering-smoke-failure.png'),
      timeout: 60000,
    })
    .catch(() => {});
  throw err;
} finally {
  await browser.close();
}
