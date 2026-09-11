# Red Frontier

> *One human. A handful of machines. An entire planet that does not want you there.*
> Mars · 2066 — Real-Time Strategy · Survival · Automation · Exploration

A browser-first Mars survival RTS. This repository currently contains the
**Prototype 4 vertical slice** plus the first slice of **exploration**:
everything from Prototypes 1–3 (terrain, orbit camera, autonomous rovers,
mining, staged construction, the power grid, the Mars sol, the water → oxygen →
food life-support chain keeping one human alive, and weather — wind, dust that
buries your panels, forecastable storms that dim the sun and batter exposed
hardware), **rover logistics** — queueable task orders, repeating haul routes,
per-rover automation rules, deposit reservations that spread the fleet across
seams, a Rover Garage that fast-charges, services drivetrains and assembles new
rovers, and the wear & jump-start recovery loop that keeps the machines on the
road — and **a planet with somewhere to go**: seeded points of interest the map
does not show until a rover finds them, a SALVAGE task that cuts a wreck apart
and hauls it home, and Earth cargo missions that land under a transponder and
get buried by the dust if nobody goes out for them.

Design & technical specifications live in [`docs/design/GDD.md`](docs/design/GDD.md)
and [`docs/design/TDD.md`](docs/design/TDD.md).

## Running it

```bash
npm install
npm run dev             # local dev server (Vite), http://localhost:5173
npm run build           # type-check + production build to dist/
npm run preview         # serve the production build
npm run typecheck       # type-check src and tests

npm test                # every suite in isolated parallel workers, ~1 min
npm run test:serial     # same coverage in one linked process, useful for debugging
npm run test:affected   # only the suites your working changes touch (seconds)
npm run test:watch      # …and again on every save

npm run test:sim        # every tests/sim suite
npm run test:hud        # every tests/hud suite
npm run test:unit       # the fast formula-level suites
npm test -- power       # any suite whose name/desc matches "power"
npm run test:list       # all 36 suites and what each covers
```

One URL flag is worth knowing while developing:

- **The colony runs inside a module worker by default** (TDD §16), with the main
  thread rendering from a mirrored view. **`?worker=0`** forces the in-process
  host, which is what every unit suite drives directly and what the fallback
  uses. If a worker cannot start (a `file:` page, a browser without module
  workers) the factory logs why and falls back instead of showing a blank
  screen. Both transports are gated: `scripts/worker-smoke.mjs` boots the game in
  headless Chromium and asserts the boundary — that the page got the transport it
  asked for, that orders and placements cross, that the ghost's verdict is the
  sim's verdict, that a dev pin holds inside the worker and never reaches the
  snapshot — and CI runs it twice, once per transport, so a divergence between
  the two fails the build rather than a playthrough:

  ```bash
  npm run build && npx vite preview --port 5199 --strictPort &
  node scripts/setup-playwright.mjs        # or: npm i --no-save playwright
  node scripts/worker-smoke.mjs                    # the worker (the default)
  SMOKE_QUERY='?worker=0' node scripts/worker-smoke.mjs   # the same, in-process
  ```

## How to survive

You land with a descent stage, two rovers, and roughly four sols of air, water
and rations. Everything after that you build.

**The chain that keeps you breathing:**

```
ice deposit → [rover hauls] → Water Extractor → water → Oxygen Generator → O₂
                                                  └───→ Greenhouse → food
```

A workable opening: **Warehouse** (storage) → **Solar + Battery** (power that
survives the night) → **Water Extractor** → **Oxygen Generator** → **Greenhouse**
(closes the food loop) → **Habitat** (recycles 55 % of your water). Once the
chain holds, a **Rover Garage** pays for itself — 40 kW charging halves the
fleet's downtime, the bay keeps drivetrains at 100%, and the assembly line can
add a **cargo rover** (3 t hopper, 120 kWh) for the long hauls.

Oxygen kills in hours, water in days, food in weeks — so build in that order.
Watch the *empty in…* estimates on the left panel; they are the real clock.

### Controls

| Action | Desktop | Touch |
|---|---|---|
| Rotate camera | drag | drag |
| Zoom | wheel | pinch |
| Pan | Shift+drag / middle-drag | two-finger drag |
| Select | left click | tap |
| Context order (move / EVA) | right click | long press |
| Build | pick from palette, click terrain | tap palette, tap terrain |
| Place several | Shift+click | — |
| Queue rover orders | Shift + move/mine/repair/clean | — |
| Pause | `Space` | ❚❚ button |
| Cycle overlays | `V` | overlay buttons |
| Focus selection | `F` | Focus button |
| Blueprints 1–9 | `1`…`9` | — |
| Save | `Ctrl/Cmd+S` | auto every 45 s |
| Developer panel | `` ` `` (backquote) | 🛠 topbar button |

Select a rover, then tap a deposit to mine it, the ground to move, or a
battered/buried structure to clean or repair it. **Shift+order** stacks tasks
into a queue — the rover's inspector shows the route — and a *Wait 1m* button
holds position between jobs. A mining task can be set as a **repeating haul
route** that loops the seam and pauses at the depot only while the silo is
full. A stranded rover (battery flat) goes dark and flashes a **yellow strobe**
— select another rover and tap it to jump-start.

Each rover carries its own automation levers in the inspector: **auto-haul**
(fetch what the build queue is short of), **auto maintenance** (repair and
panel-cleaning dispatches), **storm sheltering**, **auto-rescue**, and a
**charge floor** (10–60%) that recalls it before the ride home gets
expensive. Auto dispatch **reserves seams** so the fleet spreads across
deposits instead of dogpiling — a rich seam is still shared, a worked-out
scrap heap never is, and no rover idles merely because its nearest seam is
taken.

The **Rover Garage** fast-charges at 40 kW (twice the pod), services parked
rovers' drivetrains back to 100%, and its assembly line builds **utility,
mining and cargo rovers** from stockpiled parts. Work wears drivetrains — a
worn rover works at as little as half rate — so schedule garage time before
the fleet grinds to a crawl.

Select your colonist and right-click to send them on an EVA — the suit carries
a finite oxygen reserve, so the sim refuses walks it knows they cannot survive
(and refuses all of them in a storm).

When the forecast turns ugly: charge the batteries, shelter the crews, clean
the arrays — and remember the RTG does not care what the sky is doing.

### Developer mode

Press `` ` `` (backquote) or the 🛠 topbar button to open the **Developer
mode** panel. Everything it does is a live edit to the running colony — and,
by contract, **none of it is written into the save file**: the mode lives
outside the sim, and its building upgrade levels are runtime-only overlays
that reload never sees (the panel carries an `UNSAVED` badge to say so).
Since the host extraction that promise is structural: every edit leaves the
panel as a `dev/*` **command** on the colony's host, exactly as a player's move
order does, the keep-battery pin is a host *overlay* rather than a per-frame poke
from the UI, and the save payload is built inside the host — where the mode has
no handle at all.

- **Environment** — jump to any sol and time of day (the slider scrubs the
  sun live), conjure or dismiss any class of dust storm (including the
  planet-encircling ones), set airborne dust directly, and switch the storm
  scheduler off to fly the sky by hand.
- **Spawn** — fabricate rovers, buildings and resource deposits at the camera
  target, or arm *place…* and click terrain (Shift+click to keep placing,
  Esc to cancel — the same grammar as the build palette). Fabrications are
  honest sim objects: buildings pass the real siting checks and come online
  instantly, rovers arrive fully charged, and everything made this way
  *does* persist like something you earned.
- **Selection** — with a rover, structure, or your colonist selected the
  panel edits the thing directly: battery charge (plus a *keep full while
  dev mode is on* pin that also revives stranded rovers), ore type and load,
  drivetrain condition, structure health, damage state, cleanliness, power
  switch, one-click construction for unfinished sites, suit oxygen — and the
  developer **upgrade** buttons, which walk a structure through Mk 1–5 at
  +35 % output per mark.

## What is simulated

### Power grid (`sim/power.ts`)
A pure, deterministic resolver: generation → batteries → consumers, allocated by
**priority tier** (0 life support, 1 oxygen & water, 2 industry, 3 logistics).
Tiers are served in order and shed from the bottom up; within a tier every
consumer degrades by the same fraction, so a brownout reads as *"Industry at
62 %"* rather than an arbitrary subset going dark. Solar output tracks the
authoritative sun, batteries buffer the night, and the descent-stage RTG is the
14 kW that keeps you alive until you build something better.

### The Mars sol (`sim/clock.ts`)
A sol is 24 h 39 m of Mars time compressed into 4 minutes at 1× speed. One
`SunState` drives solar generation, greenhouse growth, sky colour, shadow
direction and the panels physically tilting to track the sun — TDD §12's
"single authoritative sun".

Energy and life support are authored in *Mars time* (kW·h per Mars hour, kg per
sol) so the numbers read like real engineering figures, while mining and
construction are paced in *game seconds* for playability. `HOURS_PER_SEC` and
`SOLS_PER_SEC` bridge the two.

### Life support (`sim/lifesupport.ts`)
Fluids (water, oxygen, food) live in tanks provided by buildings, entirely
separate from the bulk solids rovers haul. The colonist consumes 0.84 kg O₂,
4 kg water and 1.5 kg food per sol; a habitat reclaims 55 % of the water. Going
outside puts them on a finite suit reserve, and the sim aborts an EVA before it
becomes fatal.

### Automation
Idle rovers work out what the build queue is short of and go fetch it, keeping a
standing ice order weighted by how thin the water reserve is. Construction
outranks hauling (TDD §8), so a stocked site always gets a builder. Explicit
player orders always win.

Auto dispatch is energy-aware — it only sends a rover to a seam it can reach,
dig a worthwhile load from, *and get home from*, reserving enough battery for
the ride back. Deposit reservations spread the fleet: auto runs prefer
unclaimed seams, share rich ones, and never idle a rover because its nearest
seam is held. A player order outranks any reservation.

### Rover logistics (P4)
Rovers carry a **task queue** (`moveTo`, `mine`, `construct`, `clean`, `repair`,
`recover`, `salvage`, `wait`); the head task is the current command, the rest
wait.
Shift+orders append; a plain order replaces the queue. A `mine` task can repeat
as a **haul route** that parks at the depot while the silo is full and resumes
the moment consumption frees 60 kg of room.

**Wear & recovery:** tool work, driving and storms grind drivetrain condition;
below 45% a rover works progressively slower (never below half rate — rovers
fail *soft*). A battery-flat rover strands with a flashing yellow strobe; a
rescuer transfers just enough charge for the ride home. The garage bay services
parked rovers back to 100%.

**Position lights:** every rover carries headlights and a rear strobe so it
stays visible at night and in blowing dust. The sim switches them on
automatically whenever the sun drops or visibility closes in, and bills the
rover's own battery for it (0.5–0.9 kW per rover kind) — a fleet left lit
through a long night pays a real energy toll, and a parked rover can
theoretically drain itself flat. The per-rover switch in the inspector can run
a rover dark to save power. A stranded rover's headlights die with its battery,
but a reserve-powered **yellow strobe** keeps flashing to mark the wreck.

Materials flow into sites *without* a rover parked there — the "Materials
Reserved" stage of TDD §7. A site quietly accumulates regolith while a rover
fetches iron, and cancelling one refunds everything already delivered.

### Exploration (`sim/pois.ts`)
The map begins mostly unknown (GDD §06). The world scatters **sites** from the
seed — a wrecked rover, an abandoned camp, a meteorite, an ice cave, a science
cache, a flat spot worth building on — none of them inside 150 m of the landing
site, and none of them *on the map* until a rover or your colonist comes within
55 m. Finding one is a permanent event and an **Opportunity** alert saying what
it is and roughly how much is salvageable.

Select a rover and tap a site to send it out on a **SALVAGE** task (GDD §05's
task list). The rover cuts bulk salvage free at 26 kg/s — modified by the same
weather and drivetrain multipliers that govern mining — fills its hold, hauls
home, and goes back out until the site is stripped. Salvage is ordinary cargo
afterwards: it lands in the silos through the same unload path ore does.

**Earth cargo missions** (GDD §10) are scheduled rather than generated: the
first lands 2–4 sols in, then one every 5–9 sols, somewhere between 30 % and
85 % of the way out to the edge of your claim. The transponder announces it with
a bearing and a manifest (battery cells, replacement parts, specialised
machinery, or scientific equipment), and from that moment the
container is on a **3-sol burial clock** that a storm runs up to three times
faster. That clock is the whole design: the drop is not lost because time
passed, it is lost because the sky came in while you were deciding. A buried
container is gone — refused, logged, and left on the landscape as a dim marker.

Drops contain no fluids: exposed water and food cargo would freeze, and the
current logistics model has no way to recover fluids in the field. Surviving
battery cells go straight into the grid store when the rover strips the bulk
cargo; cells that exceed available battery capacity are lost and logged.

### Alerts (`sim/alerts.ts`)
Conditions that are *currently true* (raised once, cleared once) are kept
distinct from events that *happened* (streamed to the log). That separation is
what stops a brownout producing 200 identical log lines.

## Module layout

```
docs/design/        GDD + TDD reference copies
src/
  main.ts           entry point
  app/              Game loop, input, camera rig, command dispatch
  sim/              framework-agnostic simulation (no DOM / no three.js)
    config.ts       balance constants + the two time bases
    defs.ts         data-driven blueprints (resources, fluids, rovers, buildings)
    clock.ts        Mars sol clock + authoritative sun
    power.ts        pure power-grid resolver
    lifesupport.ts  fluid pools, colonist needs, health
    alerts.ts       alert bus (conditions) + event log (occurrences)
    weather.ts      wind, dust, storm scheduler + envelopes
    pois.ts         site/drop content tables + the pure salvage maths
    World.ts        seeded terrain + deposits + scattered sites
    Simulation.ts   entities, tick order, construction, persistence
    host/           the seam: SimCommand protocol, SimView read model, the host
      protocol.ts     every legal write, as plain serializable data
      view.ts         SimView — the read model, derived from Simulation by Pick
      rules.ts        the siting + maintenance verdicts, shared by both sides
      applyCommand.ts the dispatch table (sim-side, worker-reusable)
      overlays.ts     runtime edits as *data* (a name + ids), never closures
      projection.ts   the view payload a host answers with
      LocalSimHost.ts the in-process host: the live sim, narrowed to a view
      mirror.ts       a SimView built from payloads + terrain from the seed
      workerRuntime.ts the sim side of the wire (also driven headless in tests)
      WorkerSimHost.ts the worker host: posts ticks, mirrors state, optimistic acks
      createHost.ts   one factory, either transport (worker by default, ?worker=0 opts out)
  dev/              developer mode: runtime edit state (DevMode) + the panel (DevPanel)
  render/           three.js renderer (terrain, entities, day/night, overlays)
    particles/      true particle system (wind, storm grit, dust devils, rover trails)
  ui/               DOM HUD (vitals, alerts, inspectors, build palette)
  lib/              deterministic RNG + simplex noise
tests/              36 headless suites (sim/*, hud/*, render/*, ui/*) + linked serial test
scripts/            esbuild test runner: parallel scheduling, filters, --affected, --watch
```

## Architecture

- **Nothing outside the host touches the simulation.** `app/`, `ui/`, `render/`
  and `dev/` hold a `SimHost`: they read a `SimView` and write only by sending a
  `SimCommand` (TDD §16's "commands = player intent"). A view is not a sim — the
  compiler refuses `sim.step()`, `sim.placeBuilding()`, a field assignment — and
  `tests/sim/host.test.ts` greps the tree so no one re-imports the class anyway.
  Two hosts implement the interface today: `LocalSimHost` (the live sim, narrowed
  to a view) and `WorkerSimHost` (a colony inside a module worker, mirrored on
  this side). The worker host is the default; `?worker=0` picks the in-process
  host, and nothing else in `app/`, `ui/`, `render/` or `dev/` changes.
- **A command publishes the world.** The worker applies a command batch and
  sends a fresh view with it, rather than waiting for the next `advance` — the
  obvious moment to order a rover is while paused, and a paused client posts no
  advances. The in-process host gets this for free (its view *is* the sim), so
  anything less is a divergence between the two transports.
- **State crosses as data, in one shape.** Entities are spread whole into a
  `ViewPayload` (a field-picked list always drifts), derived numbers are computed
  where the smoothing lives, and `satisfaction` travels as entries so a payload
  stays JSON-printable. Terrain is *not* sent: heights, slope and surface geology
  are pure functions of the seed, so the mirror derives them locally — which is
  what lets the build ghost answer `canPlace` synchronously by running the same
  `evaluateSite` the simulation runs (one tick of lag, never a different rule).
  Dev-mode overlays are a name plus entity ids applied by a sim-side registry,
  because a worker cannot be handed a closure.
- **The simulation is authoritative, and the frame loop sets its pace.** It has
  zero DOM and zero three.js imports; rendering and UI only read it
  (`renderer.sync(view)` per frame). Both hosts are stepped by the client — the
  worker gets one `advance{dt}` per delivered frame rather than running its own
  timer, because a timer in a hidden tab is throttled to about 1 Hz and the
  colony would race ahead unseen. An advance still in flight banks its `dt`
  instead of queueing, so a stutter delivers one bigger tick, which is exactly
  what the fixed-substep accumulator already assumes.
- **Determinism is enforced, not hoped for.** Seeded PRNG, integer tick counter,
  stable iteration order. The tick accumulator holds its remainder in
  `[0, step)` and telescopes, so 60 s delivered in 3 600 ragged browser frames
  runs exactly as many ticks as 60 s delivered in one call — there is a test
  for precisely this. Weather runs on its own seeded stream and a pure
  storm envelope, so two colonies with the same seed live through the same
  skies (also tested, through a save/restore).
- **Data drives content.** Resources, fluids, blueprints, processes, power
  tiers and balance all live in `defs.ts`/`config.ts`, outside game logic.
- **Storage is per-resource,** not one shared pool. A shared pool lets a single
  rover-load of regolith deadlock every other supply chain, which reads as a bug
  rather than a bottleneck.
- **Saves are versioned** and refuse to load a schema they don't understand
  rather than silently corrupting a colony. The chain runs v3 → v7, each step
  additive: task queues, drivetrain condition and automation rules (v4),
  position lights (v5), difficulty and world options (v6), and exploration (v7)
  — a v6 colony loads with its sites unscattered-but-unfound and a fresh drop
  schedule, because a planet that had nothing on it is not a corrupted save.
- **Developer mode is a runtime overlay, never sim state.** The keep-full
  battery pin is registered on the host as an overlay (so it applies to a step,
  not to a save), and the upgrade marks ride as a runtime-only field that
  `snapshot()` deliberately skips — nothing the panel does can leak into, or
  contaminate, a save. Verified three ways: a sim suite, a host-suite snapshot
  check, and poking the stored save JSON end-to-end.

### Testing

The tests are split into **36 small suites** that each pin one corner of the
game, plus one linked serial entry point. A suite is a plain module that
registers cases with `test()` and finishes with `await finish()`; `scripts/run-tests.mjs`
bundles and runs any subset in isolated processes. Full runs schedule the
historically slowest suites first across the available CPU workers.

```
tests/
  harness.ts          test()/group()/finish(), the per-suite report, the roll-up
  full.test.ts        optional serial run: imports all 36 suites, prints the total
  fixtures/sim.ts     shared sim setup (place a building, run N sols, find a seam)
  fixtures/hud.ts     jsdom bootstrap, one mounted HUD + sim per suite
  sim/                power · clock · life-support · colony · soak · build · grid
                      · alerts · weather · storms · rovers · fleet · garage
                      · lights · determinism · persistence · pois · setup
                      · world · devtools · host · worker
  hud/                chrome · weather · inspectors · fleet · garage · controls
                      · alerts · mobile · dossier · markers · panels · devpanel
  render/ particles   ui/ build-status
```

Run the piece you touched, not the whole planet:

```bash
npm test -- sim/power            # 0.5 s   — the grid maths, no Simulation built
npm test -- sim/storms           # ~12 s   — storm damage, sheltering, recovery
npm run test:affected            # seconds — whatever `git diff` implies
npm test -- sim/life-support --case suit   # one case, inside its suite
```

`--affected` works because every suite header declares the sources it pins:

```ts
/**
 * @suite sim/power            the name you type
 * @group unit                 unit | integration | determinism | load | hud
 * @covers src/sim/power.ts    changed here → this suite runs
 * @desc What the suite is for, in a line.
 */
```

A changed file selects a suite when it matches `@covers`, when it *is* the suite,
or when the suite imports it — so editing `tests/fixtures/sim.ts` re-runs every
suite that shares it. `src/sim/**` appears in the determinism and soak suites,
which is honest: a change that can move a tick can move those.

Adding a suite means dropping a `*.test.ts` under `tests/` with that header and
importing it in `tests/full.test.ts`. `npm run test:check` fails if a suite on
disk is not linked, or if a suite declares no `@covers` and could therefore
never be picked by `--affected`; `npm test` performs the same layout guard.

What is covered, by TDD §21's categories:

- **Unit** (`sim/power`, `sim/clock`, `sim/alerts`, `sim/weather`, `sim/host`) — power
  allocation, tier shedding, energy conservation, the sun model, dust
  transmission and visibility, the alert bus's raise/clear rule, and the host
  seam itself — every command decodes and applies, the gate refuses what the
  protocol does not name, the view carries no mutator, and the same command
  transcript replayed against the same seed lands on an identical colony.
- **Integration** (`sim/life-support`, `sim/colony`, `sim/build`, `sim/grid`,
  `sim/storms`, `sim/rovers`, `sim/fleet`, `sim/garage`, `sim/lights`,
  `sim/pois`, `sim/persistence`) —
  ice → water → oxygen actually produces oxygen; the greenhouse closes the food
  loop; batteries charge by day and drain by night; switching a building off
  drops grid demand; storms cut solar, bury arrays, damage structures, shelter
  crews, refuse EVAs and recover, end to end; rover orders (queue, replace,
  WAIT), haul routes parking on a full silo and resuming, seam reservations,
  jump-start recovery, drivetrain wear, garage service/fast-charge/assembly,
  per-rover automation rules, position lights (night/dust auto-on, battery
  draw, the switch, the stranded rover's reserve strobe), seeded site scatter,
  discovery radius, the salvage task and its refusals, supply drops landing on a
  schedule and being buried faster inside a storm, and the v3→v7 save
  migrations.
- **Determinism** (`sim/determinism`, `sim/weather`, `sim/pois`,
  `sim/persistence`) — identical seeds and identical elapsed time produce
  identical state hashes regardless of frame pacing; weather and the scattered
  planet are identical across replays and across a save/restore.
- **Load** (`sim/soak`) — twenty sols of live operation: days, nights, storms,
  hauling and wear. The one suite worth running on its own before a release.
- **HUD** (`hud/*`) — every panel exists and patches live under jsdom, every
  callback fires, the inspectors (rover, structure, crew, site), the mobile
  collapse and dismiss gestures, the alert history, autopause, the supply-drop
  edge markers and their deadlines.

`npm test` runs all 299 checks in isolated parallel child processes, with the
longest suites launched first; on a two-worker machine it takes about 80 seconds.
`npm run test:serial` keeps the linked single-process run available for debugging.
The renderer needs a GPU and is covered separately by the mobile smoke test.

## Next milestones (per GDD §16 / TDD §25)

**Where this sits on the roadmaps:** GDD §16 **P1–P4** and TDD §25 **T1–T5** are
in — terrain and camera, the mission wizard, staged construction, the power
grid, the sol and the water → oxygen → food chain, weather and storms, and the
rover fleet with queued tasks, automation rules and a garage — plus the first
slice of **P6/T6** (points of interest, the salvage task, supply drops). The MVP
building set from GDD §16 is complete. `npm test` is green at 36 suites / 299
checks.

1. **Finish the Web Worker move** (TDD T1–T2 hardening). `WorkerSimHost` is in:
   a module worker owns the `Simulation`, the client pumps it one `advance{dt}`
   per frame, and the main thread renders a `ColonyMirror` fed by view payloads
   plus a terrain derived from the seed the worker reported. Already done, in the
   order they were worth doing:
   - ~~gate the worker path in CI~~ — `scripts/worker-smoke.mjs` runs against the
     production build once per transport on every pull request
     (`.github/workflows/pages.yml`, the second run with `SMOKE_QUERY='?worker=0'`), so a
     divergence between the two fails the build rather than a playthrough;
   - ~~an authoritative placement verdict~~ — the ghost no longer guesses. A
     placement goes out as `host.requestPlacement({ type: 'building/place', … })`
     (`src/app/Game.ts`) and returns a `SimAck{ok, entityId, value, error}`
     (`src/sim/host/protocol.ts`); in the worker that ack *is* `applyCommand`'s
     own refusal (`workerRuntime.ts`), so both transports answer with the
     simulation's verdict rather than a one-tick-stale mirror;
   - ~~flip the default~~ — `WORKER_DEFAULT = true` in
     `src/sim/host/createHost.ts`: a page with no opinion gets the worker, and
     `?worker=0` is the escape hatch. The CI in-process run now passes
     `SMOKE_QUERY='?worker=0'` explicitly, because an empty query would
     otherwise exercise the worker twice and quietly drop the gate.

   Remaining, in the order that makes it worth doing:
   - **live with the worker as the default, then delete the fallback.** The gate
     is in place on both transports; what is missing is a release or two of
     soak, after which `createHost`'s in-process branch (and with it
     `LocalSimHost`'s use outside tests) can go. The flip already earned its
     keep: it put the mobile smoke gate on the worker for the first time, which
     found that the worker runtime published a view only on `advance` — so an
     order given to a *paused* colony was applied by the sim and invisible to
     the HUD until you unpaused. The in-process host cannot have that bug,
     because its view is the live sim; `workerRuntime` now publishes after any
     command batch, and `sim/worker` pins it.
   - the 20 Hz worker timer plus render interpolation TDD §4 asks for, *if* the
     frame-pumped version ever measures as the bottleneck — a change confined to
     `WorkerSimHost`, which is the whole point of the seam. There is no
     `setInterval` on the worker side today, by design (a timer in a hidden tab
     is throttled and the colony would race ahead unseen).
   - transferables for the terrain and `OffscreenCanvas` for the renderer
     (TDD §16 P2/P3), each needing its own guard. Neither is in the tree yet.
2. **GDD §16 P5 — refining, manufacturing, utility networks, maintenance.** The
   slice the roadmap puts next. None of it is implemented: `defs.ts` defines ten
   blueprints (habitat, solar, battery, rtg, warehouse, extractor, oxygenator,
   greenhouse, workshop, garage), so GDD §04's table still has no **Refinery**,
   **Laboratory**, **Repair Bay** or **Nuclear Reactor**; ore the rovers haul is
   stockpiled rather than processed (the only `process` definitions are the
   extractor, oxygenator and greenhouse), there is no `sim/utilities/` module
   because power is the only network, and GDD §03's replication chain — iron →
   crushing → smelting → steel → components → construction — has no middle.
   TDD §6's logistics reservations and §7's staged construction are the pieces
   this builds on.
3. **GDD §16 P6 / TDD §25 T6 — procedural exploration, POIs, supply drops.**
   The first slice is in: `sim/pois.ts` carries the content tables, `World`
   scatters sites from the seed, the map only shows what a rover has found,
   SALVAGE is a first-class rover task, and Earth cargo missions land on a
   schedule with a burial clock a storm accelerates. What T6's exit criterion —
   "explore and recover remote objectives" — still needs:
   - **survey confidence** (GDD §06: "survey improves confidence; estimates
     before"). Site contents are exact today; they should be a range until
     surveyed;
   - **expeditions as a decision** — a drop's manifest is visible from the
     transponder, but there is no range/fuel planning and no multi-site routing;
   - **narrative content** (GDD §10): logs, radio messages and abandoned hardware
     that tell you something. The sites are silent placeholders right now;
   - **repairable/salvageable old rovers** as distinct from scrap: GDD §06 wants
     a wreck you can bring back into the fleet, which needs the garage's
     assembly line to accept a salvaged chassis;
   - **deeper POI variety**: lava tubes and ice caves are flat salvage today
     rather than a protected habitat or a water source with its own rules.
4. **TDD §25 T7 — research, agriculture depth, colonists.** There is no
   `research` symbol anywhere in `src/`, so GDD §09's six-tier tech tree and
   §08's skills ladder have nothing to attach to yet, and the colony is still
   exactly one human.
5. **TDD §22 — the rest of the developer tooling.** The panel (`src/dev/`)
   shipped; the spec's other tools did not: tick/frame perf counters, worker
   queue inspection, the deterministic state hash, and the teleport/reveal cheat
   commands.

**An ordering conflict worth knowing about.** GDD §16 and TDD §25 disagree about
what follows the rover slice: GDD puts **refining/manufacturing at P5** and
exploration at P6, while TDD puts **POIs and supply drops at T6** and never
gives refining its own tier. The choice is which pillar to grow next —
**Engineering** (item 2) or **Exploration** (item 3) — not what the documents
decided for you.
