#!/usr/bin/env node
/**
 * CLI tool for replaying Simulation Command Transcripts and verifying deterministic state hashes.
 *
 * Usage:
 *   npx tsx scripts/replay-transcript.ts --canonical
 *   npx tsx scripts/replay-transcript.ts <transcript.json> [--expect <rf1-...>]
 */

import { readFileSync } from 'node:fs';
import {
  decodeTranscript,
  replayAndHash,
  CANONICAL_SCENARIOS,
} from '../src/sim/debug/Transcript';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--canonical')) {
    console.log('Running canonical transcript scenarios...\n');
    let failures = 0;
    for (const [key, scenario] of Object.entries(CANONICAL_SCENARIOS)) {
      process.stdout.write(`• ${scenario.name} (${key}): `);
      const transcript = scenario.build();
      const t0 = performance.now();
      const { hash, result } = replayAndHash(transcript);
      const elapsed = (performance.now() - t0).toFixed(1);

      if (hash === scenario.expectedHash) {
        console.log(`PASS (${result.ticksRun} ticks, ${elapsed}ms) -> ${hash}`);
      } else {
        console.error(`FAIL!\n  Expected: ${scenario.expectedHash}\n  Actual:   ${hash}`);
        failures++;
      }
    }

    if (failures > 0) {
      process.exit(1);
    }
    console.log('\nAll canonical scenarios matched pinned state hashes.');
    return;
  }

  const filePath = args.find((a) => !a.startsWith('--'));
  if (!filePath) {
    console.error('Usage:\n  npx tsx scripts/replay-transcript.ts --canonical\n  npx tsx scripts/replay-transcript.ts <transcript.json> [--expect <hash>]');
    process.exit(1);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const transcript = decodeTranscript(raw);

  const expectIdx = args.indexOf('--expect');
  const expectedHash = expectIdx !== -1 ? args[expectIdx + 1] : undefined;

  console.log(`Replaying transcript from ${filePath} (seed: ${transcript.seed}, commands: ${transcript.commands.length})...`);
  const t0 = performance.now();
  const { hash, result } = replayAndHash(transcript);
  const elapsed = (performance.now() - t0).toFixed(1);

  console.log(`Replayed ${result.ticksRun} ticks in ${elapsed}ms.`);
  console.log(`Final StateHash: ${hash}`);

  if (expectedHash) {
    if (hash === expectedHash) {
      console.log(`Hash matched expected value: ${expectedHash}`);
    } else {
      console.error(`MISMATCH:\n  Expected: ${expectedHash}\n  Actual:   ${hash}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
