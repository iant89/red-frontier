# Red Frontier — Performance Baseline (Phase 0)

*Recorded 2026-09-20, `SAVE_VERSION = 15`, commit `arena/01a0c09f-red-frontier`.*
*Node 22, 2 CPU workers, software GL (CI uses same).*

This file is the Phase 0 baseline the commercial roadmap review asks for.
Thresholds are enforced by `tests/sim/performance-regression.test.ts` (Phase 28);
this file is the human-readable reference and the place to note intentional
movement.

## Fleet scaling benchmark (`npm run test:bench`)

Source: `src/sim/debug/Benchmark.ts`, `scripts/benchmark.mjs`

Measured 2026-09-20:

| Rovers | Avg Tick | Peak Tick | Pathfind | View Gen | Clone+Apply | Payload |
|---|---|---|---|---|---|---|
| 10 | 0.63 ms | 7.38 ms | 0.24 ms | 2.33 ms | 0.98 ms | 20.5 KB |
| 25 | 0.58 ms | 4.58 ms | 0.11 ms | 0.20 ms | 0.44 ms | 32.7 KB |
| 50 | 1.07 ms | 9.53 ms | 0.02 ms | 0.46 ms | 0.77 ms | 52.9 KB |
| 100 | 1.88 ms | 7.19 ms | 0.02 ms | 0.25 ms | 1.01 ms | 93.6 KB |
| 250 | 5.13 ms | 13.17 ms | 0.02 ms | 0.40 ms | 4.04 ms | 215.5 KB |

Budgets (TDD §20) — enforced in `sim/performance-regression`:

- Sim tick at 20 Hz = 50 ms. Even 250 rovers avg 5.13 ms = ~10% of budget.
- View projection <8 ms at 10/25, <10 ms at 50.
- Worker transport (clone + mirror apply) <15 ms at 100 rovers (frame budget 16.6 ms).
- Payload <35 / 55 / 90 / 160 KB at 10/25/50/100 rovers.
- Pathfinding avg <3 ms at 50 rovers.
- Determinism: benchmark runs are bit-for-bit identical hashes.

## Large-colony stress (`npm run test:stress -- --day`)

Source: `src/sim/debug/LargeColonyScenario.ts`, `scripts/large-colony-stress.mjs`

Config: 4800 ticks = 1 sol = 240 game seconds, seed 1001, 100 rovers / 255 buildings,
active severe storm, 5 construction sites, 10 haul routes, 3 exploration dispatches.

Measured 2026-09-20:

- Setup: ~340 ms
- Throughput: ~418 ticks/s (11.5 s wall for 1 sol)
- Heap: ~108 MB at end (no leak)
- Max pending queue: 0 (bounded ≤10 enforced)
- Active reservations: unique, no duplicates
- Final StateHash: `rf1-04c7c49448948d-1f99000dcbb019` (pinned in `tests/sim/large-colony-stress.test.ts`)
- All invariants green

7-day run (`--days 7`, 33,600 ticks) is supported but not run in CI by default.

## Canonical transcript replay (`npm run test:replay`)

Source: `src/sim/debug/Transcript.ts`, `scripts/replay-transcript.mjs`

| Scenario | Seed | Ticks | Final Hash | Suite |
|---|---|---|---|---|
| colony-foundation | 101 | 800 | `rf1-0dc0246485fd22-184c3b80f61d23` | `sim/transcript` |
| logistics-haul-loop | 2026 | 2000 | `rf1-0aaa36bcc0b488-03d7d73ca3bcb8` | `sim/transcript` |
| severe-storm-protocol | 303 | 1200 | `rf1-0aed83ab454620-0556950a99cfac` | `sim/transcript` |

These hashes are pinned in both `Transcript.ts` (`CANONICAL_SCENARIOS`) and
`tests/sim/transcript.test.ts`. Changing tick behavior must update them
deliberately.

## Golden colony (`tests/golden-colony/`)

Source: `scripts/generate-golden-colony.mjs`, `tests/sim/golden-colony.test.ts`

The golden colony is the Phase 0 "can we safely build on this?" gate. It is a
canonical transcript that builds a viable mid-game colony (warehouse, solar,
battery, extractor, oxygenator, greenhouse, refinery, workshop, garage, water
tank + pump) and runs for 5 sols.

Artifacts:

- `golden-colony.transcript.json` — seed + commands + duration (diffable)
- `golden-colony.hash.txt` — pinned final StateHash (`rf1-024150dbf13fe8-03093564627b23`, re-pinned 2026-09-20 for save v15)
- `golden-colony.save.json` — snapshot for manual inspection
- `README.md` — how to regenerate

Regeneration:

```bash
node scripts/generate-golden-colony.mjs --write
npm run test:replay   # checks canonical hashes
npm test -- golden-colony  # checks golden colony
```

## Build sizes (Phase 0)

Measured 2026-09-20 (Vite):

- `index.js` ~1,225 kB (358 kB gzip) — crosses 1200 kB warning, tracked in roadmap Phase 27
- `sim.worker.js` ~270 kB
- `index.css` ~69 kB
- 120 modules

Bundle growth should be tracked here when engineering UI (Phase 27 note) is
lazy-loaded.

## How to update this file

1. Run `npm run test:bench`, `npm run test:stress -- --day`, `npm run test:replay`
2. Copy the table rows into this file
3. If thresholds in `performance-regression.test.ts` need raising, note why here
4. Commit alongside the code change that moved the numbers
