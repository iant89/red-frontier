/**
 * @suite hud/workshop
 * @group hud
 * @covers src/ui/HUD.ts src/sim/defs.ts src/sim/Simulation.ts
 * @desc P5 slice 2 in the HUD: the component rack on the topbar, the workshop's
 * production-line selector, and the component prices on the garage's assembly
 * buttons. The panel reads the sim and sends commands — it never decides what a
 * building is running, which is why every assertion here is about what the *view*
 * shows for a state the sim owns.
 */

import assert from 'node:assert/strict';
import { mountHud } from '../fixtures/hud';
import {
  ALL_COMPONENTS,
  ALL_RESOURCES,
  COMPONENTS,
  ROVERS,
  recipesFor,
} from '../../src/sim/defs';
import { group, test, finish } from '../harness';

const { dom, doc, calls, hud, sim, place } = await mountHud();

const workshop = place('workshop');
workshop.state = 'online';
sim.recomputeCapacities();

/** Whichever building this suite last selected — `refresh` re-renders it. */
let selectedId = workshop.id;

/** Re-render the selection: the update path, not a rebuilt skeleton. */
function refresh(): void {
  const b = sim.buildings.find((x) => x.id === selectedId)!;
  hud.showBuilding(b, sim);
}

/** Give the silo everything, so a test is about one shortage at a time. */
function stockSilo(): void {
  for (const r of ALL_RESOURCES) sim.storage[r] = 5000;
}

group('The component rack in the HUD');

test('the topbar rack reads counts against rack space, and hides when there is none', () => {
  const rack = doc.getElementById('components')!;
  assert.ok(rack, 'the chrome has a rack row');
  sim.components.motor = 3;
  sim.components.circuitBoard = 1;
  hud.updateVitals(sim);

  assert.equal(rack.style.display, '', 'a standing workshop means a visible rack');
  const chips = rack.querySelectorAll('.res-chip.comp');
  assert.equal(chips.length, ALL_COMPONENTS.length, 'one chip per component');
  assert.match(chips[0].textContent!, /3\/24/, 'counted against slots, not weighed');
  assert.match(chips[1].textContent!, /1\/24/);

  // A damaged workshop brings no rack with it, and the row disappears rather than
  // showing two chips that can never move.
  workshop.damaged = true;
  sim.recomputeCapacities();
  hud.updateVitals(sim);
  assert.equal(sim.componentCapacity(), 0, 'the rack went with the workshop');
  assert.equal(rack.style.display, 'none', 'so the row hides');

  workshop.damaged = false;
  sim.recomputeCapacities();
  sim.components.motor = 3;
  sim.components.circuitBoard = 1;
  hud.updateVitals(sim);
  assert.equal(rack.style.display, '', 'and comes back when it is repaired');
});

group('The workshop in the HUD');

test('a workshop inspector offers one button per line and marks the one running', () => {
  const recs = recipesFor('workshop');
  assert.ok(recs.length >= 2, 'this suite is about a building with a choice');
  selectedId = workshop.id;
  refresh();

  const block = doc.getElementById('b-recipe')!;
  assert.ok(block, 'the selector is part of the panel');
  const btns = block.querySelectorAll('button[data-act="recipe"]');
  assert.equal(btns.length, recs.length, 'one button per line');
  recs.forEach((r, i) => {
    assert.match(btns[i].textContent!, new RegExp(r.label.split(' ')[0]), `line ${i} is named`);
    assert.equal(
      (btns[i] as HTMLElement).dataset.arg,
      String(i),
      'and carries the index the command needs',
    );
  });
  assert.ok(
    doc.getElementById('rec-0')!.classList.contains('active'),
    'the line the sim says is running is the one highlighted',
  );
  assert.ok(!doc.getElementById('rec-1')!.classList.contains('active'));

  calls.length = 0;
  doc
    .getElementById('rec-1')!
    .dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.ok(
    calls.includes('action:recipe:1'),
    `a click sends the index, it does not edit the building: ${JSON.stringify(calls)}`,
  );
});

test('a building with nothing to choose shows no selector at all', () => {
  const solar = place('solar');
  solar.state = 'online';
  selectedId = solar.id;
  refresh();
  assert.equal(doc.getElementById('b-recipe'), null, 'no lines, no selector');

  selectedId = workshop.id;
  refresh();
  assert.ok(doc.getElementById('b-recipe'), 'and it comes back with the workshop');
});

test('the panel shows the bench and greys a line the colony could not run', () => {
  workshop.recipe = 0;
  workshop.craft.motor = 0.4;
  for (const r of ALL_RESOURCES) sim.storage[r] = 0;
  refresh();

  assert.match(
    doc.getElementById('b-recipe-note')!.textContent!,
    /On the bench:\s*Mtr 40%/,
    'work in progress is visible, so a changeover does not look like a loss',
  );
  assert.ok(
    doc.getElementById('rec-0')!.classList.contains('unaffordable'),
    'an empty silo greys the line out before the click',
  );

  stockSilo();
  refresh();
  assert.ok(
    !doc.getElementById('rec-0')!.classList.contains('unaffordable'),
    'stocked again, the line is offered',
  );
  assert.ok(
    !doc.getElementById('rec-1')!.classList.contains('unaffordable'),
    'and so is the other one',
  );

  // A full rack is the other reason a line cannot run, and it reads the same way —
  // per line, because the two lines make different things.
  sim.components.motor = sim.componentCapacity();
  refresh();
  assert.ok(
    doc.getElementById('rec-0')!.classList.contains('unaffordable'),
    'a full rack greys the motor line',
  );
  assert.ok(
    !doc.getElementById('rec-1')!.classList.contains('unaffordable'),
    'but not the board line — the rack has room for boards',
  );
  sim.components.motor = 0;
});

group('The garage in the HUD');

test('the assembly buttons price a rover in parts as well as metal', () => {
  const garage = place('garage');
  garage.state = 'online';
  sim.recomputeCapacities();
  for (const r of ALL_RESOURCES) sim.storage[r] = 0;
  selectedId = garage.id;
  refresh();

  for (const kind of ['utility', 'mining', 'cargo'] as const) {
    const btn = doc.getElementById(`asm-${kind}`)!;
    const cost = ROVERS[kind].componentCost;
    assert.match(
      btn.textContent!,
      new RegExp(`${cost.motor}\\s*${COMPONENTS.motor.short}`),
      `${kind} names the motors it costs`,
    );
    assert.match(
      btn.textContent!,
      new RegExp(`${cost.circuitBoard}\\s*${COMPONENTS.circuitBoard.short}`),
      `${kind} names the boards it costs`,
    );
    assert.ok(
      btn.classList.contains('unaffordable'),
      `${kind} is greyed out with an empty silo and an empty rack`,
    );
  }

  stockSilo();
  sim.components.motor = 12;
  sim.components.circuitBoard = 6;
  refresh();
  assert.ok(
    !doc.getElementById('asm-utility')!.classList.contains('unaffordable'),
    'metal and parts together: the line can run',
  );

  sim.components.motor = 0;
  sim.components.circuitBoard = 0;
  refresh();
  assert.ok(
    doc.getElementById('asm-utility')!.classList.contains('unaffordable'),
    'and metal alone is not enough — the rack is part of the price',
  );
});

await finish('hud/workshop');
