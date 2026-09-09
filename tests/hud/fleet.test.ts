/**
 * @suite hud/fleet
 * @group hud
 * @covers src/ui/HUD.ts src/sim/Simulation.ts
 * @desc Fleet control from the HUD: the route list, repeat haul, automation rules,
 * WAIT, the Unload order and cycling to an idle rover.
 */

import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import { group, test, finish } from '../harness';

const { dom, doc, calls, hud, sim } = await mountHud();

group('Prototype 4 HUD');

test('the rover inspector shows the task queue and a queued WAIT label', () => {
  const rv = sim.rovers[0];
  hud.showRover(rv, sim);
  sim.issueMove(rv.id, 40, 0);
  sim.issueWait(rv.id, 30, true);
  hud.showRover(rv, sim);
  const items = doc.querySelectorAll('#i-route .route-item');
  assert.ok(items.length >= 2, `queue should list tasks, got ${items.length}`);
  assert.match(items[0]!.textContent!, /Move/);
  assert.match(items[1]!.textContent!, /Wait/);
});

test('a mining rover offers the repeat-haul toggle, and it fires', () => {
  const rv = sim.rovers[0];
  sim.stopRover(rv.id);
  const ice = sim.world.deposits.find((d) => d.resource === 'ice')!;
  sim.issueMine(rv.id, ice.id);
  hud.showRover(rv, sim);
  const rep = doc.getElementById('i-repeat') as any;
  assert.ok(rep, 'the repeat button should exist for a mining rover');
  assert.equal(rep.style.display, '', 'and be visible');
  calls.length = 0;
  rep.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(calls.includes('action:repeathaul:'), `got ${JSON.stringify(calls)}`);
});

test('rule checkboxes and the charge slider fire actions', () => {
  const rv = sim.rovers[1];
  hud.showRover(rv, sim);
  const haul = doc.getElementById('r-haul') as any;
  assert.equal(haul.checked, true, 'auto-haul is on by default');
  haul.checked = false;
  calls.length = 0;
  haul.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.ok(calls.includes('action:rule-haul:0'), `got ${JSON.stringify(calls)}`);

  const slider = doc.getElementById('r-charge') as any;
  slider.value = '45';
  calls.length = 0;
  slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.ok(calls.includes('action:rule-charge:45'), `got ${JSON.stringify(calls)}`);
});

test('the wait button queues a hold via the wait action', () => {
  const rv = sim.rovers[1];
  hud.showRover(rv, sim);
  const btn = doc.querySelector('[data-act="wait"]') as any;
  assert.ok(btn, 'the wait button should exist');
  calls.length = 0;
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(calls.includes('action:wait:60'), `got ${JSON.stringify(calls)}`);
});

group('Rover unload order');

test('the rover inspector offers an Unload order button', () => {
  const r = sim.rovers[0];
  r.command = { type: 'idle' };
  r.pending = [];
  r.cargo.ice = 100;
  hud.showRover(r, sim);
  const btn = doc.querySelector('#i-unload') as any;
  assert.ok(btn, 'expected an #i-unload button in the inspector');
  assert.equal(btn.hasAttribute('disabled'), false, 'a loaded hold means the order is live');
  calls.length = 0;
  btn.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(calls.includes('action:unload:'), `expected unload action, saw ${calls}`);
  r.cargo.ice = 0;
});

test('the Unload button reads the queue, not just the hold', () => {
  const r = sim.rovers[0];
  r.cargo.ice = 0;
  r.command = { type: 'idle' };
  r.pending = [];
  hud.showRover(r, sim);
  assert.equal(
    (doc.querySelector('#i-unload') as any).hasAttribute('disabled'),
    true,
    'empty hold, nothing queued: the order would be pointless',
  );
  const dep = sim.world.deposits.find((d) => d.amount > 0)!;
  r.pending = [{ type: 'mine', depositId: dep.id }];
  hud.showRover(r, sim);
  assert.equal(
    (doc.querySelector('#i-unload') as any).hasAttribute('disabled'),
    false,
    'a queued mine run will fill the hold: unloading after it is sensible',
  );
  r.pending = [];
});

test('an unload task renders in the route list', () => {
  const r = sim.rovers[0];
  r.command = { type: 'unload' };
  r.pending = [];
  hud.showRover(r, sim);
  const route = (doc.querySelector('#i-route') as any).textContent;
  assert.ok(route.includes('Unload cargo at depot'), `route list says: ${route}`);
  r.command = { type: 'idle' };
});

group('Idle rover cycling');

test('the topbar shows an idle count that tracks the sim', () => {
  for (const r of sim.rovers) {
    r.command = { type: 'idle' };
    r.pending = [];
    r.recharge = false;
    r.sheltered = false;
    r.phase = 'idle';
  }
  hud.updateVitals(sim);
  assert.equal((doc.querySelector('#idle-n') as any).textContent, '2');
  sim.issueMove(sim.rovers[0].id, 10, 10);
  hud.updateVitals(sim);
  assert.equal((doc.querySelector('#idle-n') as any).textContent, '1');
  assert.equal((doc.querySelector('#idle-btn') as any).classList.contains('none'), false);
  sim.stopRover(sim.rovers[0].id);
  sim.stopRover(sim.rovers[1].id);
});

test('the idle button asks the game to cycle to the next idle rover', () => {
  calls.length = 0;
  (doc.querySelector('#idle-btn') as any).dispatchEvent(
    new dom.window.Event('pointerdown', { bubbles: true }),
  );
  assert.ok(calls.includes('action:cycle-idle:'), `expected cycle-idle, saw ${calls}`);
});

await finish('hud/fleet');
