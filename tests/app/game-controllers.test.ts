/**
 * @suite app/game-controllers
 * @group unit
 * @covers src/app/Game.ts src/app/GameLoop.ts src/app/InputController.ts src/app/SelectionController.ts src/app/BuildController.ts src/app/SaveController.ts src/app/MenuController.ts src/app/UpdateController.ts
 * @desc Phase 19 — Game is a composition root: controllers own former Game
 * responsibilities; save onDone ordering and saveContext live on SaveController;
 * Game keeps thin private delegates for the pause-save pin surface.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { group, test, finish } from '../harness';

import { GameLoop } from '../../src/app/GameLoop';
import { InputController } from '../../src/app/InputController';
import { SelectionController } from '../../src/app/SelectionController';
import { BuildController } from '../../src/app/BuildController';
import { SaveController } from '../../src/app/SaveController';
import { MenuController } from '../../src/app/MenuController';
import { UpdateController } from '../../src/app/UpdateController';

const root = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const gameSrc = root('src/app/Game.ts');

group('Phase 19 — controllers exist and are importable');

test('all seven controllers export a class', () => {
  assert.equal(typeof GameLoop, 'function');
  assert.equal(typeof InputController, 'function');
  assert.equal(typeof SelectionController, 'function');
  assert.equal(typeof BuildController, 'function');
  assert.equal(typeof SaveController, 'function');
  assert.equal(typeof MenuController, 'function');
  assert.equal(typeof UpdateController, 'function');
});

group('Phase 19 — Game wires controllers as composition root');

test('Game constructs every controller', () => {
  assert.ok(gameSrc.includes('new GameLoop('));
  assert.ok(gameSrc.includes('new InputController('));
  assert.ok(gameSrc.includes('new SelectionController('));
  assert.ok(gameSrc.includes('new BuildController('));
  assert.ok(gameSrc.includes('new SaveController('));
  assert.ok(gameSrc.includes('new MenuController('));
  assert.ok(gameSrc.includes('new UpdateController('));
});

group('Phase 19 — save / menu / update ownership');

test('SaveController owns save + onDone-ordered leaveToMenu', () => {
  const src = root('src/app/SaveController.ts');
  assert.ok(src.includes('save(quiet'));
  assert.ok(src.includes('onSaveFailure('));
  assert.ok(src.includes('returnToMenu('));
  assert.ok(src.includes('leaveToMenu('));
  assert.ok(src.includes("saveContext: 'auto' | 'manual' | 'menu' | 'update'"));
  // The dispose must stay inside leaveToMenu / after onDone — not fire-and-forget.
  assert.ok(src.includes('this.save(false, (ok)'));
  assert.ok(src.includes('this.leaveToMenu()'));
  assert.ok(src.includes('disposeHost'));
  // Bodies must not remain as large private implementations on Game.
  assert.ok(!gameSrc.includes('void host\n      .requestSnapshot()'));
  assert.ok(gameSrc.includes('this.saveCtrl.save('));
  assert.ok(gameSrc.includes('this.saveCtrl.returnToMenu()'));
  assert.ok(gameSrc.includes('this.saveCtrl.leaveToMenu('));
});

test('MenuController owns pause menu + colony stats', () => {
  const src = root('src/app/MenuController.ts');
  assert.ok(src.includes('openPauseMenu('));
  assert.ok(src.includes('closePauseMenu('));
  assert.ok(src.includes('pauseSettings('));
  assert.ok(src.includes('buildColonyStats('));
  assert.ok(gameSrc.includes('this.menuCtrl.openPauseMenu()'));
  assert.ok(gameSrc.includes('this.menuCtrl.buildColonyStats()'));
});

test('UpdateController owns update notice actions', () => {
  const src = root('src/app/UpdateController.ts');
  assert.ok(src.includes('updateNoticeSave('));
  assert.ok(src.includes('updateNoticeReload('));
  assert.ok(src.includes('updateNoticeLater('));
  assert.ok(src.includes('onNewBuild('));
  assert.ok(gameSrc.includes('this.updateCtrl.updateNoticeSave()'));
});

group('Phase 19 — input / selection / build / loop ownership');

test('InputController owns attachInput + pointer/key handlers', () => {
  const src = root('src/app/InputController.ts');
  assert.ok(src.includes('attachInput('));
  assert.ok(src.includes('pointerDown('));
  assert.ok(src.includes('keyDown('));
  assert.ok(src.includes('uiCoversPoint('));
  assert.ok(!gameSrc.includes('private pointerDown('));
  assert.ok(gameSrc.includes('this.inputCtrl.attachInput()'));
});

test('SelectionController owns selection + tap paths + visual', () => {
  const src = root('src/app/SelectionController.ts');
  assert.ok(src.includes('primaryTap('));
  assert.ok(src.includes('contextTap('));
  assert.ok(src.includes('updateSelectionVisual('));
  assert.ok(src.includes('centerOnSelected('));
  assert.ok(!gameSrc.includes('private primaryTap('));
});

test('BuildController owns pending build + ghost + placement request', () => {
  const src = root('src/app/BuildController.ts');
  assert.ok(src.includes('setPendingBuild('));
  assert.ok(src.includes('placeBuild('));
  assert.ok(src.includes('updateGhost('));
  assert.ok(src.includes('requestPlacement'));
  // Validity stays on the sim — BuildController only previews / requests.
  assert.ok(src.includes('sim.canPlace'));
  assert.ok(!gameSrc.includes('private updateGhost('));
});

test('GameLoop owns rAF frame tick + resize', () => {
  const src = root('src/app/GameLoop.ts');
  assert.ok(src.includes('requestAnimationFrame'));
  assert.ok(src.includes('host.step('));
  assert.ok(src.includes('host.drainEvents('));
  assert.ok(src.includes('host.drainDomainEvents('), 'frame drain must clear domain queues');
  assert.ok(src.includes('resize('));
  assert.ok(gameSrc.includes('this.loopCtrl.loop('));
  assert.ok(gameSrc.includes('this.loopCtrl.resize()'));
});

finish();
