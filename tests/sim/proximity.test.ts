/**
 * @suite sim/proximity
 * @group integration
 * @covers src/sim/Simulation.ts src/sim/config.ts
 * @desc Rover proximity awareness (issue #11): hull-clearance detection,
 * immediate crawl on contact, stricter behaviour in the colony yard, and the
 * guarantee that two rovers nose-to-nose never lock forever.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { ROVERS } from '../../src/sim/defs';
import {
  SIM_TICK,
  ROVER_PROXIMITY_CLEARANCE_M,
  ROVER_PROXIMITY_COLONY_CLEARANCE_M,
  ROVER_PROXIMITY_SPEED_MUL,
  ROVER_PROXIMITY_COLONY_SPEED_MUL,
  ROVER_COLONY_YARD_M,
  SPAWN_X,
  SPAWN_Z,
} from '../../src/sim/config';
import { group, test, finish } from '../harness';

/** Park every rover so auto-haul / rescue cannot steal the subject mid-test. */
function freezeFleet(sim: Simulation, exceptId?: number): void {
  for (const r of sim.rovers) {
    r.rules.autoHaul = false;
    r.rules.autoService = false;
    r.rules.autoRescue = false;
    r.rules.stormShelter = false;
    if (exceptId !== undefined && r.id === exceptId) continue;
    // Hold the rest still with a long WAIT so they stay physical obstacles
    // without driving off.
    sim.issueWait(r.id, 1e6);
  }
}

/** Place `r` at (x, z) without going through pathfinding. */
function park(sim: Simulation, r: { id: number; x: number; z: number; y: number }, x: number, z: number): void {
  r.x = x;
  r.z = z;
  r.y = sim.world.heightAt(x, z);
}

/** Advance one fixed tick and return how far `r` moved in the XZ plane. */
function tickTravel(sim: Simulation, r: { x: number; z: number }): number {
  const x0 = r.x;
  const z0 = r.z;
  sim.step(SIM_TICK);
  return Math.hypot(r.x - x0, r.z - z0);
}

group('Open-country proximity');

test('a clear road cruises at full speed', () => {
  const sim = new Simulation({ seed: 11, nearDeposits: 0.2 });
  const r = sim.rovers[0];
  freezeFleet(sim, r.id);
  // Far from the pad and the second starter, heading into empty ground.
  park(sim, r, 200, 0);
  park(sim, sim.rovers[1], -200, 0);
  sim.issueMove(r.id, 260, 0);
  // One tick to pick up the path, then measure a clean cruise tick.
  sim.step(SIM_TICK);
  const moved = tickTravel(sim, r);
  const cruise = ROVERS[r.kind].cruiseSpeed * SIM_TICK;
  assert.ok(
    Math.abs(moved - cruise) < 0.05,
    `expected ~${cruise.toFixed(3)} m/tick on a clear road, got ${moved.toFixed(3)}`,
  );
});

test('an obstacle inside the hull bubble drops speed immediately', () => {
  const sim = new Simulation({ seed: 11, nearDeposits: 0.2 });
  const mover = sim.rovers[0];
  const block = sim.rovers[1];
  freezeFleet(sim, mover.id);
  // Open country. Hull gap just inside the open-country clearance.
  const selfR = ROVERS[mover.kind].radius;
  const otherR = ROVERS[block.kind].radius;
  const gap = ROVER_PROXIMITY_CLEARANCE_M * 0.6; // well inside the bubble
  park(sim, mover, 200, 0);
  park(sim, block, 200 + selfR + otherR + gap, 0);
  sim.issueWait(block.id, 1e6);
  sim.issueMove(mover.id, 280, 0);
  sim.step(SIM_TICK); // acquire path
  const moved = tickTravel(sim, mover);
  const cruise = ROVERS[mover.kind].cruiseSpeed * SIM_TICK;
  const crawl = cruise * ROVER_PROXIMITY_SPEED_MUL;
  assert.ok(
    moved < cruise * 0.5,
    `proximity must cut speed in half at least (moved ${moved.toFixed(3)}, cruise ${cruise.toFixed(3)})`,
  );
  assert.ok(
    Math.abs(moved - crawl) < 0.05,
    `expected the documented crawl (${crawl.toFixed(3)}), got ${moved.toFixed(3)}`,
  );
});

test('clearance is measured from the hull, not the centre', () => {
  // A centre-to-centre "5 ft" would sit inside a 3 m rover. The bubble must
  // fire only once the *gap between hulls* is under the clearance.
  const sim = new Simulation({ seed: 11, nearDeposits: 0.2 });
  const mover = sim.rovers[0];
  const block = sim.rovers[1];
  freezeFleet(sim, mover.id);
  const selfR = ROVERS[mover.kind].radius;
  const otherR = ROVERS[block.kind].radius;

  // Just outside the bubble → still cruising.
  park(sim, mover, 200, 0);
  park(sim, block, 200 + selfR + otherR + ROVER_PROXIMITY_CLEARANCE_M + 0.4, 0);
  sim.issueWait(block.id, 1e6);
  sim.issueMove(mover.id, 280, 0);
  sim.step(SIM_TICK);
  const clearMoved = tickTravel(sim, mover);

  // Just inside the bubble → crawl.
  park(sim, mover, 200, 0);
  park(sim, block, 200 + selfR + otherR + ROVER_PROXIMITY_CLEARANCE_M - 0.2, 0);
  sim.stopRover(mover.id);
  sim.issueMove(mover.id, 280, 0);
  sim.step(SIM_TICK);
  const nearMoved = tickTravel(sim, mover);

  const cruise = ROVERS[mover.kind].cruiseSpeed * SIM_TICK;
  assert.ok(clearMoved > cruise * 0.9, 'outside the bubble must still cruise');
  assert.ok(nearMoved < cruise * 0.5, 'inside the bubble must crawl');
  assert.ok(nearMoved < clearMoved * 0.5, 'the drop is immediate, not a gentle ease');
});

group('Colony yard');

test('the colony yard uses a wider bubble and a slower crawl', () => {
  const sim = new Simulation({ seed: 11, nearDeposits: 0.2 });
  const mover = sim.rovers[0];
  const block = sim.rovers[1];
  freezeFleet(sim, mover.id);
  const selfR = ROVERS[mover.kind].radius;
  const otherR = ROVERS[block.kind].radius;

  // A gap that is *clear* in open country but *inside* the colony bubble.
  const gap =
    (ROVER_PROXIMITY_CLEARANCE_M + ROVER_PROXIMITY_COLONY_CLEARANCE_M) / 2;
  assert.ok(
    gap > ROVER_PROXIMITY_CLEARANCE_M && gap < ROVER_PROXIMITY_COLONY_CLEARANCE_M,
    'precondition: gap sits between the two clearances',
  );

  // Open country first — same gap, must cruise.
  park(sim, mover, 220, 0);
  park(sim, block, 220 + selfR + otherR + gap, 0);
  assert.ok(
    Math.hypot(mover.x - SPAWN_X, mover.z - SPAWN_Z) > ROVER_COLONY_YARD_M,
    'precondition: open-country sample is outside the yard',
  );
  sim.issueWait(block.id, 1e6);
  sim.issueMove(mover.id, 300, 0);
  sim.step(SIM_TICK);
  const openMoved = tickTravel(sim, mover);

  // Same gap inside the yard — must crawl at the colony rate.
  // Stay off the pad body itself so the pod is not the obstacle under test.
  const yardX = 12;
  const yardZ = 18;
  park(sim, mover, yardX, yardZ);
  park(sim, block, yardX + selfR + otherR + gap, yardZ);
  assert.ok(
    Math.hypot(mover.x - SPAWN_X, mover.z - SPAWN_Z) <= ROVER_COLONY_YARD_M,
    'precondition: yard sample is inside the yard',
  );
  sim.stopRover(mover.id);
  sim.issueMove(mover.id, yardX + 40, yardZ);
  sim.step(SIM_TICK);
  const yardMoved = tickTravel(sim, mover);

  const cruise = ROVERS[mover.kind].cruiseSpeed * SIM_TICK;
  const colonyCrawl = cruise * ROVER_PROXIMITY_COLONY_SPEED_MUL;
  assert.ok(openMoved > cruise * 0.9, 'open country must ignore this gap');
  assert.ok(
    Math.abs(yardMoved - colonyCrawl) < 0.05,
    `yard must use the colony crawl (${colonyCrawl.toFixed(3)}), got ${yardMoved.toFixed(3)}`,
  );
});

group('No permanent lock');

test('two rovers nose-to-nose still inch forward', () => {
  const sim = new Simulation({ seed: 11, nearDeposits: 0.2 });
  const a = sim.rovers[0];
  const b = sim.rovers[1];
  freezeFleet(sim);
  // Overlapping hulls — worst case. Both drive the same way so neither is a
  // destination the other is allowed to ignore.
  const mid = 180;
  park(sim, a, mid, 0);
  park(sim, b, mid + 0.5, 0);
  sim.issueMove(a.id, mid + 80, 0);
  sim.issueMove(b.id, mid + 80, 0);
  const a0 = a.x;
  const b0 = b.x;
  // A couple of seconds of crawl must still accumulate real travel.
  for (let i = 0; i < 40; i++) sim.step(SIM_TICK);
  assert.ok(a.x > a0 + 0.5, `rover A must keep inching (Δ=${(a.x - a0).toFixed(3)})`);
  assert.ok(b.x > b0 + 0.5, `rover B must keep inching (Δ=${(b.x - b0).toFixed(3)})`);
  // And neither was disabled by the encounter.
  assert.notEqual(a.phase, 'disabled');
  assert.notEqual(b.phase, 'disabled');
});

test('a builder still reaches its site through the arrival skip', () => {
  // Without the destination skip, crawling up to a building would never end
  // and construction would hang. Pin that the skip lets the job start.
  const sim = new Simulation({ seed: 11, nearDeposits: 0.2 });
  freezeFleet(sim);
  const r = sim.rovers.find((x) => x.kind === 'utility') ?? sim.rovers[0];
  // Free materials so the site is assemble-ready the moment the rover arrives.
  for (const k of Object.keys(sim.storage) as Array<keyof typeof sim.storage>) {
    sim.storage[k] = 500;
  }
  const b = sim.placeBuilding('solar', 40, 0);
  assert.ok(b, 'solar site placed');
  // Commit materials so remainingCost is zero and the builder will assemble.
  sim.recomputeCapacities();
  // Force the site fully stocked via the public commit path: dump enough and
  // let tickSiteLogistics drain it on the next step.
  sim.issueConstruct(r.id, b!.id);
  // Drive long enough to arrive even at a crawl.
  for (let i = 0; i < 800; i++) {
    sim.step(SIM_TICK);
    if (b!.state === 'building' || b!.state === 'online') break;
    if (r.goal === 'build' || r.phase === 'working') break;
  }
  assert.ok(
    r.goal === 'build' || r.phase === 'working' || b!.state !== 'site',
    `builder must start work (goal=${r.goal}, phase=${r.phase}, site=${b!.state})`,
  );
});

group('Determinism');

test('proximity slowdown is bit-stable across two runs', () => {
  const runOnce = () => {
    const sim = new Simulation({ seed: 77, nearDeposits: 0.2 });
    const mover = sim.rovers[0];
    const block = sim.rovers[1];
    freezeFleet(sim, mover.id);
    const selfR = ROVERS[mover.kind].radius;
    const otherR = ROVERS[block.kind].radius;
    park(sim, mover, 150, 10);
    park(sim, block, 150 + selfR + otherR + 0.8, 10);
    sim.issueWait(block.id, 1e6);
    sim.issueMove(mover.id, 220, 10);
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      samples.push(tickTravel(sim, mover));
    }
    return samples;
  };
  const a = runOnce();
  const b = runOnce();
  assert.deepEqual(a, b, 'two seeded runs must produce identical travel per tick');
});

await finish('sim/proximity');
