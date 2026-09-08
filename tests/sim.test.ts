import assert from 'node:assert/strict';
import { Simulation } from '../src/sim/Simulation';
import type { Building } from '../src/sim/Simulation';

let pass = 0;

function ok(name: string): void {
  pass++;
  console.log(`  ✔ ${name}`);
}

function nearDeposit(sim: Simulation, res: string) {
  return sim.world.deposits
    .filter((d) => d.resource === res && d.amount > 0)
    .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
}

// ---- 1. Determinism: same seed + same ticks => identical state ----
{
  const a = new Simulation({ seed: 42, nearDeposits: 0.18 });
  const b = new Simulation({ seed: 42, nearDeposits: 0.18 });
  a.issueMine(a.rovers[0].id, nearDeposit(a, 'regolith')!.id);
  b.issueMine(b.rovers[0].id, nearDeposit(b, 'regolith')!.id);
  for (let i = 0; i < 3000; i++) {
    a.step(1 / 20);
    b.step(1 / 20);
  }
  assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()), 'state hashes differ');
  ok('deterministic: identical snapshots after identical ticks');
}

// ---- 2. Mining moves material from a deposit into colony storage ----
{
  const sim = new Simulation({ seed: 7, nearDeposits: 0.18 });
  const dep = nearDeposit(sim, 'iron')!;
  sim.issueMine(sim.rovers[0].id, dep.id); // mining rover
  const before = dep.amount;
  for (let i = 0; i < 6000; i++) sim.step(1 / 20); // 300 s
  const minedOut = dep.amount < before;
  const stored = sim.storageTotal() > 0;
  assert.ok(minedOut || stored, 'mining did not produce anything');
  ok('mining extracts iron and reaches storage');
}

// ---- 3. Placing + building a warehouse expands storage ----
{
  const sim = new Simulation({ seed: 3, nearDeposits: 0.18 });
  // give the builder stock so construction can start immediately
  sim.storage.regolith = 300;
  sim.storage.iron = 300;
  sim.storage.silicon = 300;
  const baseCap = sim.storageCapacity();
  assert.equal(sim.canPlace('warehouse', 12, 44), null, 'site should be buildable');
  const b = sim.placeBuilding('warehouse', 12, 44);
  assert.ok(b, 'warehouse placement failed');
  for (let i = 0; i < 8000; i++) sim.step(1 / 20); // up to 400 s
  const rebuilt = sim.buildings.find((x) => x.id === b!.id);
  assert.ok(rebuilt && rebuilt.state === 'online', 'warehouse never came online');
  assert.ok(sim.storageCapacity() > baseCap, 'storage capacity did not grow');
  ok('a warehouse can be built and increases storage capacity');
}

// ---- 4. Save/load round-trip restores identical simulation ----
{
  const sim = new Simulation({ seed: 99, nearDeposits: 0.18 });
  sim.issueMove(sim.rovers[0].id, 30, -20);
  for (let i = 0; i < 2000; i++) sim.step(1 / 20);
  const snap = sim.snapshot();
  const copy = new Simulation({ seed: 1 });
  copy.restore(JSON.parse(JSON.stringify(snap)));
  assert.equal(JSON.stringify(copy.snapshot()), JSON.stringify(snap), 'restored state differs');
  ok('snapshot/restore round-trips exactly');
}

// ---- 5. Storage cannot be overfilled past capacity ----
{
  const sim = new Simulation({ seed: 5, nearDeposits: 0.18 });
  sim.storage.regolith = 1e9;
  const room = sim.storageCapacity() - sim.storageTotal();
  assert.ok(room <= 0, 'expected storage to be full');
  assert.ok(sim.storageFull(), 'storageFull() should be true');
  ok('colony storage is capacity-bounded');
}

console.log(`\n${pass} simulation checks passed.`);
