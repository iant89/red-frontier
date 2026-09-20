#!/usr/bin/env node
/**
 * CLI runner for Simulation Performance Benchmarks — Phase 28.
 *
 * Usage:
 *   node scripts/benchmark.mjs [--rovers 10,25,50,100,250] [--ticks 30]
 */

import { benchmarkFleet } from '../src/sim/debug/Benchmark';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const roversArg = args.find((a) => a.startsWith('--rovers=') || a === '--rovers');
  let counts = [10, 25, 50, 100, 250];
  if (roversArg) {
    const val = roversArg.includes('=') ? roversArg.split('=')[1] : args[args.indexOf('--rovers') + 1];
    counts = val.split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  }

  console.log('='.repeat(78));
  console.log('RED FRONTIER — SIMULATION FLEET PERFORMANCE BENCHMARK (Phase 28)');
  console.log('='.repeat(78));
  console.log(
    'Rovers'.padEnd(8) +
    'Avg Tick'.padEnd(12) +
    'Peak Tick'.padEnd(12) +
    'Pathfind'.padEnd(12) +
    'View Gen'.padEnd(12) +
    'Clone+Apply'.padEnd(14) +
    'Payload'
  );
  console.log('-'.repeat(78));

  for (const count of counts) {
    const res = benchmarkFleet(count, 30);
    const transport = (res.cloneMs + res.applyMs).toFixed(2) + 'ms';
    const payload = (res.payloadBytes / 1024).toFixed(1) + ' KB';

    console.log(
      String(res.roverCount).padEnd(8) +
      (res.avgTickMs.toFixed(2) + 'ms').padEnd(12) +
      (res.maxTickMs.toFixed(2) + 'ms').padEnd(12) +
      (res.avgPathfindMs.toFixed(2) + 'ms').padEnd(12) +
      (res.viewGenMs.toFixed(2) + 'ms').padEnd(12) +
      transport.padEnd(14) +
      payload
    );
  }
  console.log('='.repeat(78));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
