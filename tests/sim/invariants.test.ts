/**
 * @suite sim/invariants
 * @group unit
 * @covers src/sim/debug/SimulationAssertions.ts src/sim/Simulation.ts
 * @desc Refactor roadmap Phase 1: the simulation invariant checker. Sound
 * colonies pass; deliberately corrupted state is caught, by code; the
 * step-time gate throws; and the checks themselves never change what the
 * simulation computes.
 */

import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/Simulation';
import { ROVERS } from '../../src/sim/defs';
import { SIM_TICK } from '../../src/sim/config';
import {
  checkInvariants,
  assertInvariants,
  setInvariantChecks,
  invariantChecksEnabled,
  InvariantError,
} from '../../src/sim/debug/SimulationAssertions';
import type { InvariantViolation } from '../../src/sim/debug/SimulationAssertions';
import { run, build, nearDeposit } from '../fixtures/sim';
import { group, test, finish } from '../harness';

function fresh(seed = 7): Simulation {
  return new Simulation({ seed, nearDeposits: 0.2 });
}

function codes(violations: InvariantViolation[]): string[] {
  return violations.map((v) => v.code);
}

/** Corrupt, expect the code, then put the state back exactly as it was. */
function expectCode(sim: Simulation, code: string, mutate: () => () => void): void {
  const restore = mutate();
  try {
    const found = checkInvariants(sim);
    assert.ok(
      codes(found).includes(code),
      `expected invariant '${code}', got: ${codes(found).join(', ') || '(none)'}`,
    );
  } finally {
    restore();
  }
  assert.deepEqual(checkInvariants(sim), [], 'state must be sound again after restore');
}

group('Sound states pass');

test('a fresh colony satisfies every invariant', () => {
  const sim = fresh();
  assert.deepEqual(checkInvariants(sim), []);
  assertInvariants(sim); // must not throw
});

test('a working colony stays sound through live operation', () => {
  const sim = fresh(21);
  build(sim, 'solar');
  build(sim, 'warehouse');
  const dep = nearDeposit(sim, 'iron');
  if (dep) sim.issueMine(sim.rovers[0].id, dep.id);
  // Construction sites, a claimed seam, movement and automation all in flight.
  run(sim, 0.5);
  assert.deepEqual(checkInvariants(sim), []);
});

test('a live reservation is valid state', () => {
  const sim = fresh(33);
  const dep = nearDeposit(sim, 'iron');
  assert.ok(dep, 'test world must have an iron seam');
  const r = sim.rovers[0];
  for (const other of sim.rovers) other.rules.autoHaul = false;
  sim.issueMine(r.id, dep!.id);
  sim.step(SIM_TICK);
  assert.equal(dep!.reservedBy, r.id, 'the mine order must claim the seam');
  assert.deepEqual(checkInvariants(sim), []);
});

group('Corruption is caught');

test('rover battery bounds', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const max = ROVERS[r.kind].maxBatteryKWh;
  expectCode(sim, 'rover-battery', () => {
    const old = r.battery;
    r.battery = -1;
    return () => {
      r.battery = old;
    };
  });
  expectCode(sim, 'rover-battery', () => {
    const old = r.battery;
    r.battery = max * 5;
    return () => {
      r.battery = old;
    };
  });
});

test('rover cargo bounds', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  expectCode(sim, 'rover-cargo', () => {
    const old = r.cargo.iron;
    r.cargo.iron = -5;
    return () => {
      r.cargo.iron = old;
    };
  });
  expectCode(sim, 'rover-cargo', () => {
    const old = r.cargo.iron;
    r.cargo.iron = ROVERS[r.kind].capacityKg + 50;
    return () => {
      r.cargo.iron = old;
    };
  });
});

test('rover condition and position', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  expectCode(sim, 'rover-condition', () => {
    const old = r.condition;
    r.condition = 150;
    return () => {
      r.condition = old;
    };
  });
  expectCode(sim, 'rover-position', () => {
    const old = r.x;
    r.x = NaN;
    return () => {
      r.x = old;
    };
  });
});

test('building progress, health and worker references', () => {
  const sim = fresh();
  const b = build(sim, 'solar');
  expectCode(sim, 'building-progress', () => {
    const old = b.progress;
    b.progress = 1.5;
    return () => {
      b.progress = old;
    };
  });
  expectCode(sim, 'building-progress', () => {
    const old = b.assembly;
    b.assembly = { kind: 'mining', progress: -0.5 };
    return () => {
      b.assembly = old;
    };
  });
  expectCode(sim, 'building-health', () => {
    const old = b.health;
    b.health = -1;
    return () => {
      b.health = old;
    };
  });
  expectCode(sim, 'building-health', () => {
    const old = b.cleanliness;
    b.cleanliness = 5;
    return () => {
      b.cleanliness = old;
    };
  });
  expectCode(sim, 'building-worker-ref', () => {
    const old = b.workerId;
    b.workerId = 424242;
    return () => {
      b.workerId = old;
    };
  });
});

test('colony storage never goes negative', () => {
  const sim = fresh();
  expectCode(sim, 'storage-negative', () => {
    const old = sim.storage.iron;
    sim.storage.iron = -1;
    return () => {
      sim.storage.iron = old;
    };
  });
});

test('fluid pools stay within 0..capacity', () => {
  const sim = fresh();
  expectCode(sim, 'fluid-range', () => {
    const old = sim.pools.amounts.water;
    sim.pools.amounts.water = -1;
    return () => {
      sim.pools.amounts.water = old;
    };
  });
  assert.ok(sim.pools.capacity.oxygen > 0, 'the pod carries oxygen capacity');
  expectCode(sim, 'fluid-range', () => {
    const old = sim.pools.amounts.oxygen;
    sim.pools.amounts.oxygen = sim.pools.capacity.oxygen + 50;
    return () => {
      sim.pools.amounts.oxygen = old;
    };
  });
});

test('the grid battery stays within 0..capacity', () => {
  const sim = fresh();
  expectCode(sim, 'grid-battery', () => {
    const old = sim.storedKWh;
    sim.storedKWh = -1;
    return () => {
      sim.storedKWh = old;
    };
  });
  expectCode(sim, 'grid-battery', () => {
    const old = sim.storedKWh;
    sim.storedKWh = sim.batteryCapacity() + 100;
    return () => {
      sim.storedKWh = old;
    };
  });
});

test('deposit amounts and reservation references', () => {
  const sim = fresh();
  const dep = sim.world.deposits[0];
  expectCode(sim, 'deposit-amount', () => {
    const old = dep.amount;
    dep.amount = -1;
    return () => {
      dep.amount = old;
    };
  });
  expectCode(sim, 'deposit-amount', () => {
    const old = dep.amount;
    dep.amount = dep.maxAmount + 10;
    return () => {
      dep.amount = old;
    };
  });
  expectCode(sim, 'reservation-ref', () => {
    const old = dep.reservedBy;
    dep.reservedBy = 424242;
    return () => {
      dep.reservedBy = old;
    };
  });
});

test('poi salvage and energy never go negative', () => {
  const sim = fresh(99);
  const poi = sim.world.pois[0];
  assert.ok(poi, 'test world must have a site');
  expectCode(sim, 'poi-amounts', () => {
    const old = poi.energyKWh;
    poi.energyKWh = -1;
    return () => {
      poi.energyKWh = old;
    };
  });
  expectCode(sim, 'poi-amounts', () => {
    const had = 'iron' in poi.salvage;
    const old = poi.salvage.iron ?? 0;
    poi.salvage.iron = old - 1000;
    return () => {
      if (had) poi.salvage.iron = old;
      else delete poi.salvage.iron;
    };
  });
});

test('entity ids stay unique', () => {
  const sim = fresh();
  expectCode(sim, 'id-unique', () => {
    sim.rovers.push(sim.rovers[0]);
    return () => {
      sim.rovers.pop();
    };
  });
  expectCode(sim, 'id-unique', () => {
    sim.buildings.push(build(sim, 'solar'));
    const dup = sim.buildings[sim.buildings.length - 1];
    sim.buildings.push(dup);
    return () => {
      sim.buildings.pop();
      // remove the helper-placed solar too, leaving the colony as found
      sim.buildings.pop();
    };
  });
});

test('task references resolve', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const cases: Array<[string, () => void]> = [
    [
      'task-deposit-ref',
      () => {
        r.command = { type: 'mine', depositId: 999999 };
      },
    ],
    [
      'task-building-ref',
      () => {
        r.command = { type: 'construct', buildingId: 999999 };
      },
    ],
    [
      'task-building-ref',
      () => {
        r.pending = [{ type: 'repair', buildingId: 999999 }];
      },
    ],
    [
      'task-rover-ref',
      () => {
        r.command = { type: 'recover', roverId: 999999 };
      },
    ],
    [
      'task-poi-ref',
      () => {
        r.command = { type: 'salvage', poiId: 999999 };
      },
    ],
  ];
  for (const [code, corrupt] of cases) {
    const cmd = r.command;
    const pending = r.pending;
    corrupt();
    try {
      assert.ok(
        codes(checkInvariants(sim)).includes(code),
        `expected invariant '${code}'`,
      );
    } finally {
      r.command = cmd;
      r.pending = pending;
    }
  }
  assert.deepEqual(checkInvariants(sim), []);
});

test('colonist state stays physical', () => {
  const sim = fresh();
  const c = sim.colonist;
  expectCode(sim, 'colonist-state', () => {
    const old = c.health;
    c.health = 200;
    return () => {
      c.health = old;
    };
  });
  expectCode(sim, 'colonist-state', () => {
    const old = c.suitO2;
    c.suitO2 = -1;
    return () => {
      c.suitO2 = old;
    };
  });
  expectCode(sim, 'colonist-shelter-ref', () => {
    const old = c.shelterId;
    c.shelterId = 424242;
    return () => {
      c.shelterId = old;
    };
  });
});

test('simulation time stays finite', () => {
  const sim = fresh();
  expectCode(sim, 'time-finite', () => {
    const old = sim.simTime;
    sim.simTime = NaN;
    return () => {
      sim.simTime = old;
    };
  });
});

group('The step gate');

test('step() throws on corrupted state while checks are enabled', () => {
  const sim = fresh();
  assert.ok(invariantChecksEnabled(), 'the harness must enable invariant checks');
  // Negative cargo survives a tick untouched (nothing clamps it back), which
  // is what makes it a reliable probe of the post-tick gate.
  const r = sim.rovers[0];
  const old = r.cargo.iron;
  r.cargo.iron = -5;
  try {
    assert.throws(() => sim.step(SIM_TICK), InvariantError);
  } finally {
    r.cargo.iron = old;
  }
  // Sound again: the same step now passes.
  sim.step(SIM_TICK);
});

test('assertInvariants names the label and every violation', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const oldB = r.battery;
  const oldC = r.condition;
  r.battery = -1;
  r.condition = -5;
  try {
    assert.throws(
      () => assertInvariants(sim, 'unit probe'),
      (err: unknown) => {
        assert.ok(err instanceof InvariantError);
        assert.match(err.message, /unit probe/);
        assert.ok(codes(err.violations).includes('rover-battery'));
        assert.ok(codes(err.violations).includes('rover-condition'));
        return true;
      },
    );
  } finally {
    r.battery = oldB;
    r.condition = oldC;
  }
});

test('with checks switched off, step() does not police state', () => {
  const sim = fresh();
  const r = sim.rovers[0];
  const old = r.cargo.iron;
  r.cargo.iron = -5;
  setInvariantChecks(false);
  try {
    sim.step(SIM_TICK); // must not throw
  } finally {
    r.cargo.iron = old;
    setInvariantChecks(true);
  }
  assert.ok(invariantChecksEnabled(), 'the harness switch must be restored');
});

group('Checks never change behavior');

test('identical seeds produce identical states with checks on or off', () => {
  const runWith = (checks: boolean): string => {
    const before = invariantChecksEnabled();
    setInvariantChecks(checks);
    try {
      const sim = fresh(1234);
      const dep = nearDeposit(sim, 'iron');
      if (dep) sim.issueMine(sim.rovers[0].id, dep.id);
      run(sim, 0.25);
      return JSON.stringify(sim.snapshot());
    } finally {
      setInvariantChecks(before);
    }
  };
  const on = runWith(true);
  const off = runWith(false);
  assert.equal(on, off, 'invariant checks must be observationally inert');
});

await finish('sim/invariants');
