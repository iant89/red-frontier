#!/usr/bin/env node
/**
 * CLI runner for Large-Colony Stress Tests — Phase 29.
 *
 * Usage:
 *   node scripts/large-colony-stress.mjs [--hour] [--day] [--days <N>] [--ticks <N>]
 */

import {
  createLargeColonyScenario,
  assertStressInvariants,
} from '../src/sim/debug/LargeColonyScenario';
import { SIM_TICK } from '../src/sim/config';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let ticks = 4800; // default: 1 simulated day (1 sol)
  if (args.includes('--hour')) {
    ticks = 195; // ~1 Mars hour
  } else if (args.includes('--days')) {
    const dIdx = args.indexOf('--days');
    const days = parseFloat(args[dIdx + 1]) || 1;
    ticks = Math.round(days * 4800);
  } else if (args.includes('--ticks')) {
    const tIdx = args.indexOf('--ticks');
    ticks = parseInt(args[tIdx + 1], 10) || 4800;
  }

  const seedArg = args.find((a) => a.startsWith('--seed='));
  const seed = seedArg ? parseInt(seedArg.split('=')[1], 10) : 1001;

  console.log('='.repeat(78));
  console.log(`RED FRONTIER — LARGE COLONY STRESS RUNNER (Phase 29)`);
  console.log('='.repeat(78));
  console.log(`Config: ${ticks} ticks (~${(ticks / 4800).toFixed(2)} sols, ${(ticks * SIM_TICK).toFixed(0)} game seconds), seed: ${seed}`);
  console.log('Building 100-rover, 250-building colony with active storm and hauling...');

  const t0 = performance.now();
  const sim = createLargeColonyScenario({ seed });
  const setupMs = (performance.now() - t0).toFixed(1);
  console.log(`Colony ready: ${sim.rovers.length} rovers, ${sim.buildings.length} buildings (setup: ${setupMs}ms)\n`);

  const tStart = performance.now();
  const logCadence = Math.max(500, Math.floor(ticks / 10));

  for (let t = 0; t < ticks; t++) {
    sim.step(SIM_TICK);

    if ((t + 1) % logCadence === 0 || t === ticks - 1) {
      const elapsedSec = (performance.now() - tStart) / 1000;
      const rate = ((t + 1) / elapsedSec).toFixed(0);
      const res = assertStressInvariants(sim);
      const heapMb = (process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1);

      console.log(
        `Tick ${(t + 1).toString().padStart(6)} / ${ticks} ` +
        `(${(sim.simTime).toFixed(0)}s sim) | ` +
        `${rate} ticks/s | ` +
        `Heap: ${heapMb} MB | ` +
        `Max queue: ${res.maxRoverPendingQueue} | ` +
        `Hash: ${res.stateHash}`
      );
    }
  }

  const totalSec = ((performance.now() - tStart) / 1000).toFixed(2);
  const finalRes = assertStressInvariants(sim);

  console.log('-'.repeat(78));
  console.log(`Completed ${ticks} ticks in ${totalSec}s (${(ticks / parseFloat(totalSec)).toFixed(0)} ticks/s).`);
  console.log(`Final StateHash: ${finalRes.stateHash}`);
  console.log(`All stress invariants satisfied.`);
  console.log('='.repeat(78));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
