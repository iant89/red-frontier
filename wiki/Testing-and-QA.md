> ← [Home](Home.md)

# Testing and QA

**87 suites / 983 checks**, green in roughly a minute on a warm machine. The
suite is the unit of work, not the file: each one pins one corner of the game and
declares what it covers, so you can run the piece you touched instead of the whole
planet.

Verified on `main` (`46a75e8`) — `npm test` → *"87 suites, 983 checks passed"*.

## Commands

```bash
npm test                     # every suite, isolated parallel workers
npm run test:serial          # same coverage in one linked process (debug-friendly)
npm run test:affected        # only the suites your working changes touch (seconds)
npm run test:watch           # …and again on every save
npm run test:all             # --all: every suite, own process, in parallel

npm run test:sim             # every tests/sim suite
npm run test:hud             # every tests/hud suite
npm run test:unit            # the fast formula-level suites
npm run test:integration     # the wiring suites
npm test -- power            # any suite whose name or description matches "power"
npm test -- sim/life-support --case suit   # one case, inside its suite
npm run test:list            # all 87 suites and what each covers
npm run test:check           # layout guard: linked? @covers declared?
npm run test:replay          # canonical transcript replay
npm run test:bench           # fleet benchmark
npm run test:stress          # large-colony stress scenario
npm run test:smoke           # mobile smoke (needs a served build)
```

Raw runner flags: `--all` · `--group unit|integration|determinism|load|hud` ·
`--affected[=main]` · `--watch` · `--list` · `--check` · `--case TEXT` · `--force` ·
`--jobs N`. Environment knobs: `RF_LINKED=1` (serial), `RF_VERBOSE=1`, `RF_CASE`,
`SMOKE_QUERY` (for the browser smokes).

## Anatomy of a suite

A suite is a plain module that registers cases and finishes:

```ts
/**
 * @suite sim/power            the name you type
 * @group unit                 unit | integration | determinism | load | hud
 * @covers src/sim/power.ts    changed here → this suite runs
 * @desc What the suite is for, in a line.
 */
import { test, finish } from '../harness';

test('sheds the bottom tier first', () => { /* a thrown assertion fails it */ });
await finish();
```

The harness (`tests/harness.ts`) provides `suite()`, `group()` (a label; suites run
linearly), `test()`, `skip(name, why)` for cases that knowingly cannot run headless
— no DOM backend, no GPU, no network — and `finish()`.

## `--affected` is a real dependency graph

A changed file selects a suite when it:

1. matches a `@covers` entry,
2. **is** the suite file, or
3. is **imported** by the suite.

So editing `tests/fixtures/sim.ts` re-runs every suite that shares it. And
`src/sim/**` appears in the determinism and soak suites' `@covers` on purpose — a
change that can move a tick can move those.

`npm run test:check` fails if a suite on disk is not linked into
`tests/full.test.ts`, or if a suite declares no `@covers` and could therefore never
be selected by `--affected`. `npm test` runs the same layout guard, so an
unregistered suite is caught rather than silently skipped.

## Layout

```
tests/
  harness.ts            test() / group() / finish(), the per-suite report, the roll-up
  full.test.ts          optional serial run: imports every suite, prints the total
  fixtures/sim.ts       shared sim setup (place a building, run N sols, find a seam)
  fixtures/hud.ts       jsdom bootstrap, a recording 2D canvas stub, one mounted
                        HUD + sim per suite
  sim/                  power · clock · life-support · colony · soak · build · grid ·
                        alerts · weather · storms · rovers · fleet · garage · lights ·
                        determinism · persistence · pois · world · navgrid · host ·
                        worker · proximity · refining · components · engineering ·
                        water · maintenance · rover-state · invariants · state-hash ·
                        transcript · property-testing · performance-regression ·
                        large-colony-stress · network-boundary · save-validation ·
                        profiler · devtools · setup
                        + one suite per extracted system (clock-, weather-, power-,
                          production-, life-support-, construction-, rover-,
                          fleet-automation-, logistics-, exploration-, failure-,
                          alert-, history-, maintenance-, water-, upgrade-system)
  hud/                  chrome · weather · inspectors · fleet · garage · workshop ·
                        controls · alerts · mobile · dossier · markers · panels ·
                        devpanel · worldmap · pause-menu · water · engineering ·
                        maintenance
  render/               particles · descent-stage · weather-station · glb-assets ·
                        selection · solar · water-overlay · entity-preview
  audio/                system (the exhaustive command→cue map)
  ui/                   build-status · gestures
  app/                  game-controllers · pause-save · update-check
```

## What each category pins

| Category | Representative claim being tested |
|---|---|
| **Unit** | power allocation and tier shedding; energy conservation; the sun model; dust transmission and visibility; the spatial weather field and the lightning hazard curve; the alert bus's raise/clear rule; the host seam itself (every command decodes and applies, the gate refuses what the protocol does not name, the view carries no mutator) |
| **Integration** | ice → water → oxygen actually produces oxygen; the greenhouse closes the food loop; batteries charge by day and drain by night; switching a building off drops demand; storms cut solar, bury arrays, damage structures, shelter crews, refuse EVAs and recover, end to end; a bolt trips the array it lands on; haul routes park on a full silo and resume; seam reservations; jump-start recovery; garage service/fast-charge/assembly; the hull-clearance crawl **and the destination exemption that keeps a builder from hanging**; the v3→v13 migrations against hostile payloads |
| **Determinism & replay** | identical seeds and identical elapsed time produce identical state hashes *regardless of frame pacing*; a canonical transcript (seed + difficulty + world options + timed commands) replays to a pinned hash; weather and the scattered planet are identical across replays **and across a save/restore** |
| **Property-based** | random command sequences must never break the invariants, whatever order they arrive in |
| **Performance** | tick, view-projection, transport, payload and pathfinding thresholds at 10/25/50/100 rovers; 100 rovers + 250 buildings through a sustained storm with bounded queues and a pinned end-state hash |
| **Load** | `sim/soak` — twenty sols of live operation: days, nights, storms, hauling and wear. The one suite worth running on its own before a release |
| **HUD** | every panel exists and patches live under jsdom; every callback fires; inspectors (rover, structure, crew, site); mobile collapse and dismiss gestures; alert history; autopause; drop edge markers and their deadlines; the pause menu's three tabs; the minimap/world-map paint paths |
| **Render / audio / app** | GPU-free checks: particle budget and coherence, descent-stage leg clearances, radar-station animation, the GLB registry's fallback contract, the selection pulse; the pure audio mix; the Game-level save/pause hand-off and the update-check poller |

## Browser smokes

CI runs these against the **built** bundle in headless Chromium, once per transport:

```bash
npm run build && npx vite preview --port 5199 --strictPort &
node scripts/setup-playwright.mjs          # the project's installer
node scripts/worker-smoke.mjs                    # the worker (the default)
SMOKE_QUERY='?worker=0' node scripts/worker-smoke.mjs   # the same, in-process
node scripts/mobile-smoke.mjs
node scripts/engineering-smoke.mjs         # gestures, paint, paid installs across save/load
node scripts/maintenance-smoke.mjs
node scripts/water-smoke.mjs
node scripts/update-check-smoke.mjs        # the whole save-and-reload flow
node scripts/pause-smoke.mjs
node scripts/preview-nav.mjs / preview-terrain.mjs / screenshots.mjs
```

`worker-smoke` asserts the **boundary**, not the visuals: the page got the
transport it asked for, orders and placements cross, the ghost's verdict *is* the
sim's verdict, and a dev pin holds inside the worker while never reaching the
snapshot.

## CI: what is and is not gated

`.github/workflows/pages.yml`, on pushes to `main` and on PRs:
`npm ci` → install headless Chromium → `npm run build` (which runs `tsc`, so
**every PR type-checks**) → serve that exact `dist/` → `mobile-smoke` →
`worker-smoke` twice → deploy on `main` only. Failures upload evidence, comment on
the PR, and open an issue when `main` breaks. A separate `screenshots` workflow
rebuilds and commits `screenshots/`.

> **`npm test` is not part of CI.** The full suite is the local and review contract,
> so *run it before you open a pull request* — see
> [Contributing](Contributing.md).

## Adding a suite

1. Drop `tests/<area>/<name>.test.ts` with the four-line header.
2. Import it in `tests/full.test.ts`.
3. `npm run test:check` — it fails if you forgot either, or if `@covers` is missing.
4. `npm test -- <area>/<name>` while iterating; `npm run test:affected` before you
   push.

## Related

- [Performance Budgets](Performance-Budgets.md) — which numbers are pinned
- [Host and Worker Protocol](Host-and-Worker-Protocol.md) — what the boundary tests defend
- [`docs/design/TDD §21`](https://github.com/iant89/red-frontier/blob/main/docs/design/TDD.md)
