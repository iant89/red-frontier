> ← [Home](Home.md)

# Performance Budgets

Every sim-side budget is a **test**, not a target in a document:
`tests/sim/performance-regression.test.ts` fails the run if a number goes the wrong
way on `npm test`. The renderer and the frame rate are not CI-gated — see the last
section for what that means in practice.

## Budgets

| Budget | Target | Status |
|---|---|---|
| Sim tick at 20 Hz (50 ms) | headroom at fleet scale | **ENFORCED** — avg tick <5 / <8 / <12 / <20 ms at 10 / 25 / 50 / 100 rovers; peak <45 ms at 100 |
| View projection | cheap enough to publish per frame | **ENFORCED** — view generation <8 / <8 / <10 ms at 10 / 25 / 50 rovers |
| Worker transport (clone + mirror apply) | inside a 16.6 ms frame | **ENFORCED** — <15 ms at 100 rovers; `sim/worker-performance` also asserts the counters exist (view time, structured-clone time, main-thread apply, message bytes) |
| View payload size | bounded growth | **ENFORCED** — <35 / <55 / <90 / <160 KB at 10 / 25 / 50 / 100 rovers |
| Pathfinding | no O(N²) under fleet load | **ENFORCED** — avg query <3 ms at 50 rovers |
| Determinism under load | benchmark runs reproducible | **ENFORCED** — bit-for-bit identical hashes |
| Large-colony stability | 100 rovers + ≥250 buildings through a storm | **ENFORCED** — `sim/large-colony-stress`: invariants hold, rover queues stay ≤5 pending, 4 800 ticks land on a **pinned state hash** |
| Particle budget | bounded pool | **ENFORCED** — 9 000 motes; worst measured case ~6 155; `render/particles` pins the ceiling |
| 60 FPS desktop / 30 mobile | target | playable, **not CI-gated** (headless smokes assert behaviour, not frame rate) |
| Draw calls <1 000 | target | **not instrumented** |
| Save <1–2 s | target | `localStorage` snaps are small; **not instrumented** |
| Sim LOD near/far/statistical | target | **OUT** — unnecessary so far; 250 rovers cost ~4.7 ms of a 50 ms tick |

## Measured baseline

`npm run test:bench` (`src/sim/debug/Benchmark.ts`). Numbers drift with hardware;
the *shape* is the point — average tick grows sub-linearly and payload growth is
bounded.

| Fleet | Avg tick | Peak tick | Pathfind | View gen | Clone+apply | Payload |
|---|---|---|---|---|---|---|
| 10 rovers | 0.50 ms | 6.81 ms | 0.15 ms | 0.94 ms | 0.50 ms | 18.9 KB |
| 25 rovers | 0.58 ms | 5.10 ms | 0.23 ms | 0.18 ms | 0.33 ms | 29.2 KB |
| 50 rovers | 1.10 ms | 7.49 ms | 0.02 ms | 0.44 ms | 0.63 ms | 46.4 KB |
| 100 rovers | 1.40 ms | 3.96 ms | 0.02 ms | 0.20 ms | 0.86 ms | 81.1 KB |
| 250 rovers | **4.73 ms** | 11.53 ms | 0.02 ms | 0.31 ms | 1.92 ms | 184.8 KB |

At 250 rovers the colony spends **<10% of the tick budget**. That measurement is why
there is no LOD system: the honest reason to skip it is a number, not a preference.

## Running the harnesses

```bash
npm run test:bench           # the table above
npm run test:stress          # 100 rovers + 250 buildings through a sustained storm
npm run test:replay          # canonical transcript against pinned hashes
npm run test -- sim/performance-regression
npm run test -- sim/soak     # twenty sols of live operation — run this before a release
node scripts/large-colony-stress.mjs
node scripts/benchmark.mjs
```

`debug/Profiler.ts` is the instrumentation behind all of it: a process-wide switch,
**default off**, enabled by `tests/harness.ts`. It tree-shakes out of the app
bundle, which is why there is **no in-game perf HUD** yet — the counters exist and
nothing surfaces them.

## Design choices that are performance choices

| Choice | Why it is fast |
|---|---|
| Terrain never crosses the worker boundary | heights, slope and geology are pure functions of the seed, so the mirror derives them instead of the host serialising a grid |
| Entities spread **whole** into a payload | a field-picked list always drifts — and correctness beats a smaller payload here; growth is bounded by the <160 KB budget |
| One `advance{dt}` per delivered frame, no worker timer | a timer in a hidden tab is throttled to ~1 Hz; an in-flight advance banks its `dt` so a stutter is one bigger tick, not a queue |
| Zero-allocation A\* with a binary min-heap | pathfinding is the classic O(N²) trap at fleet scale (Phase 23) |
| Fixed 20 Hz sim step, render reads the latest view | no interpolation buffers, no variable-step accumulator blowups |
| Systems are static functions over `ColonyState` | iteration is over plain arrays and records in a stable order — which is also what makes determinism testable |

## When something regresses

1. `npm run test -- sim/performance-regression` to confirm which budget moved.
2. Enable the profiler in a harness run (`tests/harness.ts` does it for you) and
   compare tick vs view-generation vs transport: the table above separates
   *sim slow* from *boundary slow*.
3. `npm run test:bench` for the scaling shape. A jump between two adjacent fleet
   rows that is not linear-ish is a loop-over-everything bug — check that a system
   is not scanning all buildings inside a per-rover loop.
4. Pin it with a new `@covers`-tagged suite, because an unenforced budget is a wish.

## Related

- [Testing and QA](Testing-and-QA.md) · [Architecture Overview](Architecture-Overview.md) ·
  [`TDD §20`](https://github.com/iant89/red-frontier/blob/main/docs/design/TDD.md)
