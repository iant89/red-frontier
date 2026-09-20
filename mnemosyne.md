# Mnemosyne

Persistent notes for future coding sessions.

## Project wiki (2026-09-20)

- **The wiki is generated, not hand-maintained.** Pages live in `wiki/` as ordinary
  Markdown (one file per page, file name = page name, hyphenated) and
  `node scripts/publish-wiki.mjs` publishes the directory to the GitHub page wiki as
  a single commit. Also available as `npm run wiki:check` / `npm run wiki:publish`.
- **Why in-repo:** documentation should review like code and stay diffable against
  the source it describes. Consequence: publishing *replaces* the wiki with `wiki/`,
  so an edit made in the GitHub web UI is overwritten by the next publish — port it
  into `wiki/` instead.
- **27 pages** (Home, `_Sidebar`, `_Footer`, plus 24 content pages: playing,
  per-system references, architecture/protocol/persistence, testing, performance,
  roadmap, contributing, glossary). `wiki/README.md` states the page rules and the
  "you changed X → also update Y" table.
- **Numbers are quoted from code, never remembered:** balance and status claims come
  from `src/sim/config.ts`, `src/sim/defs.ts`, `difficulty.ts`,
  `engineering/upgrades.ts`, the docs, and a live `npm test` (currently
  *87 suites / 983 checks*). If you change a constant that a page quotes, change the
  page in the same PR — `Grep: wiki/ <old-value>` finds them.
- **`npm run wiki:preview` serves `wiki/` like the GitHub wiki does**
  (`scripts/preview-wiki.mjs`, `marked` resolved at runtime via
  `npm i --no-save marked` — intentionally not a project dependency). It rewrites the
  same relative links to local routes, so clicking around the preview is a real link
  test of the whole wiki before anything is published.
- **Publisher checks (`--check`) run before every publish** and fail the run on:
  a relative link that is not a `Page.md` sibling, a missing anchor in our own pages,
  a missing `assets/` file, a page without a `# Title` or the Home breadcrumb, an
  illegal page name, a stray `[[Gollum]]` link, and pages orphaned from Home/Sidebar.
- **Links:** sibling pages are written `[Text](Page-Name.md)` so the file reads
  correctly *in the repo*, and the publisher rewrites them to `Page-Name` for the
  wiki (147 rewrites today). Links to **code** stay absolute
  `https://github.com/iant89/red-frontier/blob/main/...`, because the wiki is a
  different repository from the source.
- **Images:** `wiki/assets/*.jpg` (~1100 px, derived from `screenshots/`) are
  committed and copied into the wiki repo, so `![alt](assets/x.jpg)` resolves in
  both places.

## Engineering & customization (2026-09-20)

- **Interaction:** right-click any built rover/building entity on desktop, or
  long-press on touch, to open Engineering. Empty-ground context orders remain.
  The dialog pauses the colony and restores exactly the previous speed on close
  (including zero). Model rotation uses UI time; reduced-motion disables spin.
  Desktop: model left/options right; narrow screens stack and scroll. Keyboard
  isolation, focus trap, Escape/backdrop close, preview resource disposal included.
- **Owners:** `EngineeringController` owns modal/pause lifetime; EngineeringPanel
  owns DOM/intent controls; EntityPreview owns a separate Three turntable cloned
  from the renderer's actual entity model. EntityAppearance isolates materials
  and factory paint; ItemIcons provides labelled SVG pictograms in engineering,
  resource chips, blueprint costs, assembly and recipes. No generated icon assets.
- **Authoritative engineering:** `sim/engineering/upgrades.ts` is the typed
  catalogue + effective-stat readers, `UpgradeSystem` owns paid jobs. Optional
  entity `upgrades`, `upgradeJob`, `paint` are independent of installed wear and
  unsaved developer `level`. All 15 buildable types have appropriate upgrades.
  Rover drivetrain/battery/cargo and miner-only teeth: three tiers, gains per tier
  +20% speed (+8% drive power), +35% battery, +40% cargo, +30% mining respectively.
  Building production/generation/service/radar +25%, storage +40%, pump +30%,
  efficiency reduces base grid draw by 12% per tier. Values scale base stats.
- **Installation decision explicitly approved by user:** timed service; pause
  while browsing. Park and stop beside a Garage (radius+5 m). One refit/customer
  or assembly per bay. Materials/components are spent **once at queue time**.
  Leaving/new orders/power loss/damage pause paid jobs. Idle automation respects
  the reservation, battery safety still wins. Explicit cancel refunds once up to
  current silo/rack capacity; overflow discarded. Demolishing a Garage cancels
  customer jobs and refunds; demolishing a building loses its own unfinished refit.
- Building refits use the existing construct task and on-site builder ownership
  in ConstructionSystem, with progress in `upgradeJob`, not construction progress.
  Online refitting structures retain existing production/capacity until complete;
  disabled/damaged/unpowered targets pause installation. Fleet prioritises them
  like construction. New battery/tank/cargo capacity never manufactures contents.
- Workshop now has **six lines**: motors/boards/pipes plus battery packs (2 Al +
  1 silica + .5 steel kg/h → .5 packs/h), cargo frames (3 Al + 2 steel → .5/h),
  drill teeth (1 iron + 3 steel → .5/h). Installed rover parts remain motor/board
  only. Palette paint (eight colours + factory reset) is free and saved for both
  rovers/buildings; preview changes require Apply to reach the authoritative model.
- **Save v13**, migration v12→13. Owned nested projection/snapshot copies,
  sanitation of supported tiers/jobs/palette, unique valid Garage reservations,
  invariant checks and hash fields. Effective stats cover movement/mining/hauls,
  charging/rescue/fleet estimates, production/power/radar/storage, UI/dev readouts.
- **Final gates PASS:** typecheck; full **87 suites / 983 checks**; manifest linkage;
  canonical replay hashes; 4,800-tick stress invariants; production build. Browser
  smoke passes on **both local and worker** after final changes: desktop and mobile
  gestures, rotation while paused, speed restoration, paid job/save/load, paint,
  six recipes and no horizontal overflow. Screenshots under `.probe/engineering-*`.
  Preview remains available on port 5199. Build: main 1,224.77 kB (357.79 gzip),
  worker 270.06 kB, CSS 68.92 kB; existing 1,200 kB bundle threshold warns, not fails.
  Additional cleanup covers partial WebGL construction failure, independently
  owned line/mesh resources and borrowed textures. Desktop component rack is 3×2;
  blueprint costs now wrap within their own buttons instead of overlapping.
- Validation at final implementation: sim/engineering 15, hud/engineering 6,
  render/entity-preview 3 new checks. `scripts/engineering-smoke.mjs` exercises
  actual right-click and trusted CDP touch long-press, paused rotation, icon costs,
  paint, paid installation across save/load, six recipe choices and mobile layout.
  Run software-GL browsers separately from the full suite. Resumed job uses
  explicit host fixed-step advances to avoid coupling validation to software-GL
  frame rate. A desktop→mobile resize needs collapsed panels; this exposed/fixed
  Game.syncUI reopening collapsed building inspectors on every refresh.
- Replay pins (new component/engineering fields): foundation
  `rf1-14ed7eb836dc03-1164ec0689266e`, logistics
  `rf1-17bc9bdd9b5057-0117bb605da5e9`, storm
  `rf1-17d5135575ee97-0ffdd05072a1d3`, stress
  `rf1-17f926380467a3-0b6ffd671d40ac`. Earlier records below are historical.
- Scope limits: no module swapping/downgrades, automatic retrofit travel, part
  attachment meshes, RGB picker, or upgrades to the fixed landing-stage prop.
  Use the new role-specific tiers/palette; future catalogue entries belong in
  the engineering owner. Large main-bundle warning is tracked under Phase 27.
  Existing pause-save/stable-alert/water/maintenance work remains intact; no commit.

## Pause-save presentation and stable alerts (2026-09-20)

- `HUD.onSaveProgress(open, saved)` reports the actual progress-card lifetime,
  including its success fade. `MenuController` hides (does not close) the pause
  menu during it, preserving the original speed and blocking resume. Success
  disables Save and Ctrl+S for that pause session; resume/reopen resets it.
  Failures leave Save enabled. The fade timer is cancelled on a new save or
  forced dismissal so an old timer cannot hide a newer progress card.
- HUD alerts are keyed DOM nodes, updated in place. Do not replace the alert
  container's `innerHTML` on live detail changes: it restarts `alert-in` on every
  power/weather update. The content signature includes title and focus target;
  retained listeners read the current dataset. New alerts still animate in.
- Validation: 79 suites / 918 checks, typecheck, build, test linkage, and pause
  browser smokes on both local and worker transports pass.

## P5 slice 4 — water utility networks (2026-09-20)

- **Shipped:** paid pipe connections, local tanks, powered pumping, stable water
  inspector controls and dedicated overlay. Fifteen blueprints: Pump Station
  (6 kW/tier 1, 20 kg, 6 kg/h), Water Tank (250 kg); oxygenator has 10 kg buffer.
  Workshop third recipe: 1 kg steel/h → 2 pipes/h. A section spans 20 m, maximum
  run 200 m. Disconnect salvages floor(half), rack-clamped; demolish no refund.
- **Safe commissioning:** new/old colonies stay on shared plumbing until explicit
  Commission network. All online water ports including pod, enabled extractor
  and powered pump must connect, be undamaged and have a nonempty reserve.
  Mass is preserved across proportional tank fill. Post-commission buildings
  start empty; production and indoor drinking/recycling use their own tanks.
  EVA water still debits pod, oxygen/food remain pooled. Damage loses local water.
- Owners: `state/WaterState`, `utilities/WaterNetwork`, `systems/WaterSystem`,
  `persistence/WaterPersistence`, `ui/WaterPanel`, `render/WaterNetworkOverlay`.
  Deterministic components/BFS, fair proportional pump budgets, signed flow.
  Tick after power/production, before life support. Tanks are authoritative;
  pooled water is derived. Current flow is transient, not saved/hashed.
- Save **v12**, migration v11→12; old saves receive no free pipes and do not
  auto-commission. `RoverPartId` / `ROVER_PARTS` distinguish installed wear from
  the wider `ComponentId` inventory (pipe must never become a rover part).
- Commands: water/connect, water/disconnect (a/b IDs, pod = 0), water/commission.
  Immutable host copies, malformed-save sanitation, hashing/invariants included.
- Gate: **84 suites / 959 checks** green (280.4 s), typecheck, build (120 modules),
  test linkage, canonical replay, one-sol stress and both browser transports.
  `sim/water` 15, `hud/water` 4, `render/water-overlay` 1. Full suite and browser
  smokes must run separately. `scripts/water-smoke.mjs` uses a fresh browser per
  transport; local save-load can take >30 s in software GL, so waits allow 60 s
  and explicitly reselect the pump after fixture load. First local attempt
  timed out; sequential rerun passed. No app fault was observed.
- Current pins: foundation `rf1-150b8afdaf2d47-021a099501d17f`, logistics
  `rf1-1ee38a25171a21-04bbb238dea72b`, storm
  `rf1-1e4b4910ff8f60-004d5acbd00d1e`, stress
  `rf1-09b6f5c6ffd13e-020b2da0f43c5b`. Earlier pins below are historical.
- Deliberately OUT: pressure/leaks/valves, trench routing, oxygen/heat/data
  networks, portable EVA water. Aggregate histories/alerts are not local supply
  guarantees; use inspector/overlay. Follow-ups recorded at roadmap Phases
  7/8/9/15/27. P5 backlog still includes glass, broader parts, building component
  wear, Laboratory/Nuclear Reactor. No commit requested or made.

## P5 slice 3 — rover component maintenance (2026-09-20)

- `MaintenanceSystem` owns installed **health**, not inventory: `Rover.parts`
  holds motor/board percentages (`RoverPartHealth`), distinct from routine
  `condition`. Motion/work/exposed storms wear parts. `roverWorkMul` takes the
  weakest health, keeping the original half-rate floor. Garage service restores
  condition only; no manufacturing prerequisite for structural building repairs.
- `repairBay`: radius 7 + service reach 5, 8/1 kW active/idle, tier 2, 38 s build,
  20 kg steel + raw stock. At ≤70% part health, 12 powered seconds replaces one
  part. `Building.maintenance` owns `{roverId, component, progress}`. Debit **one**
  matching spare via ComponentSystem at completion, never on each repair tick.
  Cancelling has no refund because nothing was prepaid. No-power/missing-stock
  pauses; new orders, departure or charging cancel; bays never share a customer.
- Tick additions: bay after GarageSystem; part wear after movement/colonist work.
  ProductionSystem delegates demand; fleet/construction skip funded bay customers.
  Players park using move/stop/wait; automatic travel to a bay is not implemented.
  Missing stock does not reserve a rover forever (use Wait while restocking).
- Save **v11**, `migrations/v10.ts`: old saves receive healthy parts/empty bays.
  Health and jobs are saved/hashed, nested view and snapshot bags are copied.
  Named v7/v8/v9 migrations now bump **one version**, not straight to CURRENT.
- Validation: **81 suites / 939 checks** green; typecheck, production build,
  canonical replay, stress invariants and both browser transports pass. Run
  browser smokes separately from the CPU-heavy full suite in this sandbox.
- Tests: `sim/maintenance` 17, `hud/maintenance` 4; browser
  `node scripts/maintenance-smoke.mjs` covers both transports + mid-job save/load.
  Defaults to fresh child/browser per transport: software GL in this sandbox can
  stall a second navigation in one browser. Use SMOKE_QUERY for one transport.
- Current canonical hashes (new health/job state): foundation
  `rf1-0c8ea29bf65ec4-1ddbca6058e53d`; logistics
  `rf1-1ca9dfaacf9b91-1ff3cb9bc00375`; severe storm
  `rf1-02bb9bacda012b-0b3e3c47d3a04c`; stress
  `rf1-01b6d9c75f237e-1779e17dc23916`. Slice 2's values below are historical.
- P5 still open: utility networks and their parts, glass, building-level component
  wear. Repair Bay is IN; Laboratory and Nuclear Reactor still OUT. Architecture
  follow-ups are recorded against Phases 12/15/27 in the roadmap's slice 3 block.

## P5 slice 2 — manufacturing (components, recipes, save v10)

- **Two ledgers, one shape.** `ComponentId` = `'motor' | 'circuitBoard'`;
  `state.components: ComponentAmounts` is an **integer** ledger and
  `state._componentCapacity` is *rack slots*, not kg. `ComponentSystem` mirrors
  `LogisticsSystem`'s API on purpose (`capacity` / `room` / `total` /
  `totalCapacity` / `store` / `take` / `has` / `consume` / `missingList`);
  `store`/`take` **floor to whole units** and return what actually moved.
  Components are deliberately *not* in `ALL_RESOURCES`, so nothing that iterates
  the bulk ledger (haul, cargo, silos, reservations, HUD chips, assertions) picks
  them up — a motor is not 40 kg of anything.
- **The bench holds the fraction.** `Building.craft: ComponentAmounts` is keyed by
  **component, not by recipe**, so switching lines keeps work in progress.
  `ProductionSystem.runProcess` accumulates `craft[c]`, clamps it to ≤ 1 (a stalled
  line can never bank invisible progress), floors it, hands the whole unit to
  `ComponentSystem.store` and pushes `component/crafted`. `Building.recipe` is the
  index of the line the building runs. Both are persisted, hashed and
  invariant-checked (`building-recipe`, `building-craft`, `component-ledger`).
- **B′ — a recipe list *replaces* the blueprint process.** `RECIPES:
  Partial<Record<BuildingKind, RecipeDef[]>>`; workshop = `motors` (2.5 steel + 1
  aluminum → 0.5 motor/hr) and `boards` (1.2 silicon + 0.4 aluminum + 0.2 steel →
  0.35 board/hr). **`BUILDINGS.workshop.process` is `undefined`** and a
  `sim/components` check pins that a kind with recipes has no fixed process — one
  source of truth per blueprint. Everything reads `activeProcess(kind, recipe)`
  (out-of-range index → 0, never throws); `recipesFor` / `hasRecipes` /
  `hasProcess` / `activeSummary` are the rest of that surface. **Grep `def.process`
  before adding a reader**: ProductionSystem, PowerSystem, Renderer (×3) and HUD
  (×3) were all converted in this slice.
- **Rack space is a building's.** `BuildingDef.componentSlots` (workshop 24),
  `BASE_COMPONENT_SLOTS = 0` (the pod has none → nothing is craftable until a
  workshop stands), summed over online undamaged buildings × `devLevelMul` and
  floored in `recomputeCapacitiesState`, which also **clamps stored components to
  the new capacity** — the same rule as the silo clamp right beside it. A full rack
  makes `desiredThroughput` 0 and `processBlockReason` say `"Drive Motor rack
  full"`; the HUD greys the line out before the click.
- **Rovers are the end of the chain.** `RoverDef.componentCost`: utility 2 motors +
  1 board, mining 4 + 1, cargo 6 + 2. `GarageSystem.assemble` asks
  `ComponentSystem.has` after the bulk check and **before spending either ledger**,
  refusing with `missingList` in the sentence ("Not enough components for a Cargo
  Rover — needs 6 × Drive Motor, 2 × Circuit Board.").
- **Command.** `building/recipe {buildingId, recipe}` with a new `'index'`
  FieldKind (integer 0…255 — an entity id is not a list position). `applyCommand`
  forwards the boolean like `building/assemble`; `AudioSystem.COMMAND_CUES` maps it
  to `'toggle'`; `SelectionController` case `'recipe'` parses `data-arg`.
  `ProductionSystem.setRecipe` owns the refusals (unknown building / fixed-line
  kind / out-of-range index) and logs each one, but treats "already running that
  line" as a **silent success** so a stale panel click cannot spam the log.
- **Save v10.** `SAVE_VERSION = 10`, `migrations/v9.ts` (a version bump only —
  additive), codec range 3…10, `SaveState.components` + `BuildingSave.recipe?` /
  `craft?`. Restore **sanitises**: components floor to whole ≥ 0 (then the capacity
  clamp), craft clamps to 0…1 with `NaN → 0`, a non-integer or negative recipe
  resets to 0 — but an out-of-range *integer* recipe is kept as data, because
  `activeProcess` resolves it. A v9 colony arrives with an empty rack, every
  building on its first line and every bench empty.
- **Read model.** `ResourceView.components` (field, like `storage`) plus
  `SimQuery.componentCapacity()` — a **method**, like `storageCapacity()`, because
  `Simulation` has to satisfy `SimView` structurally and the HUD tests pass a
  `Simulation` straight in. Payload carries both; `BuildingView.recipe`/`craft`
  flow through `projectBuilding`'s `...b` spread, with `craft` copied so the panel
  owns it.
- **HUD.** Topbar gains `#components` chips reading `4/24`, hidden while capacity
  is 0; the inspector gains a `#b-recipe` selector built **into the skeleton** (so
  its buttons get the one-time `data-act` wiring every other control has), lines
  grey out through `.unaffordable` when inputs are short or the rack is full, the
  note shows what is on the bench, and the garage's assembly buttons price
  components too. Module-level helpers: `lineCount` / `linesText` / `recipeBlock`.
  CSS: `.comp-rack`, `.res-chip.comp` (dashed border, smaller numerals).
- **Hashes moved again** (rack + line + bench joined the hashed building state):
  canonical `rf1-1d7ae6c1b30534-0db8f0413ab365` (foundation),
  `rf1-04698eb32329c3-1bd5148e7c7808` (logistics),
  `rf1-1e512ca8a160cd-07318129a675dd` (severe storm); 1-day stress
  `rf1-1497ee5db284ac-1af522781eadd7`. Re-pinned in `src/sim/debug/Transcript.ts`
  **and** `tests/sim/transcript.test.ts` (both!),
  `tests/sim/large-colony-stress.test.ts`, and the Phase 26/29 notes below.
  `npm run test:replay` prints actual-vs-expected for the canonical three;
  `npm run test:stress` prints the 1-day final hash.
- **Tests.** `tests/sim/components.test.ts` — **21 checks**, `@group integration`,
  linked in `full.test.ts` right after `refining`; `tests/hud/workshop.test.ts` —
  **5 checks** (rack chips, line selector + `action:recipe:1`, the bench note,
  `.unaffordable` greying per line, component prices on the assembly buttons). Also
  touched: `sim/garage` (stands a workshop and racks parts before assembling),
  `sim/host` (a `building/recipe` sample + three gate rejections), `sim/refining`
  (its `SAVE_VERSION` pin moved 9 → 10). Suite totals **79 suites / 913 checks**.
- **Traps found.** (a) `assert.equal(x, null)` from `node:assert/strict` **narrows**
  the local, so a later `x?.kind` typechecks as `never` — re-read through the sim
  instead. (b) A fresh `Simulation` has component capacity 0, so a test that writes
  `sim.components.motor = 12` without an online workshop trips `component-ledger`.
  (c) `ComponentSystem.fullComponents()` was written and then **deleted as dead
  code**: with zero capacity every rack reads "full", which is true for a line but
  false for a colony — ProductionSystem names the blocking component itself.
- **What P5 still owes.** Utility networks (no `sim/utilities/`), a wider parts
  catalogue (pipes / valves — wants networks first), a second refined material
  (glass; the recipe machinery can carry it as another line), and maintenance depth
  (part-level wear — components now exist to wear out, and nothing consumes them
  except the garage line). **Update: slice 3 above adds rover part replacement;
  building-specific components still remain.**

## P5 slice 1 — refining (steel, the Refinery, save v9)

- **One ledger, two origins.** `ResourceId` = `MineableResourceId |
  RefinedResourceId`; `steel` is the only refined one. `RESOURCES[*].origin`
  (`'mined' | 'refined'`) is the discriminator and `isRefined(res)` is a *type
  predicate* — that narrowing is what lets `World.addDeposit` take a
  `MineableResourceId` after a refusal. Everything that iterates `ALL_RESOURCES`
  (LogisticsSystem, ResourceState, HUD chips, cargo, assertions, StateHash) picked
  steel up with **no** changes. Do not add a second inventory for refined goods
  (roadmap §39/§40).
- **Deposits are mined-only, by type.** `Deposit.resource`, `DepositDef.resource`,
  `DEPOSIT_TABLE`, `DepositSave.resource` are `MineableResourceId`;
  `World.generateDeposits` + `pickWeighted` iterate `MINEABLE_RESOURCES` (same
  order, same weights as the old `ALL_RESOURCES` list → world gen is bit-identical,
  only the hash of *storage* moved). `dev/spawn/deposit` decodes through a new
  `mineableResourceId` field kind; `DevMode.spawnDeposit` refuses refined material
  before sending (returns -1, logs a warn); DevPanel's dropdown lists mined only;
  restore *drops* any deposit row naming a refined resource.
- **`ProcessDef.solidOut`** is the new half of Phase 8's contract: `desiredThroughput`
  gates on `LogisticsSystem.room`, `processBlockReason` says `"Steel silo full"`,
  and `runProcess` stores through `LogisticsSystem.store` (clamped, like a
  delivery) and pushes the ordinary `resource/produced` event. Refinery: 2.6 kg
  iron ore → 1.6 kg steel per Mars hour, 35 kW draw / 4 kW idle, tier 2, +150 kg
  per silo, 48 s build, radius 7.5, order 11 — cost 40 regolith / 50 iron / 18
  silica / 16 aluminum and **no steel**, so the chain is openable from a cold start.
- **`runProcess` conserves mass now.** Outputs are scaled by `earned`, the smallest
  `obtained / wanted` over all inputs. Pre-existing bug: `desiredThroughput` is
  answered per building *before* any of them draws, so two lines on one silo (two
  extractors, two refineries) both got a full rate and the second produced output
  for input it never received. Pinned by `sim/refining` ("two furnaces on one ore
  pile…").
- **`demolish` prunes queued tasks.** `ConstructionSystem.demolish` now removes
  every pending task targeting the building *before* `hooks.finishTask(r)` —
  `finishTask` promotes `pending[0]`, so the order is load-bearing — and it covers
  `clean` / `repair`, not just `construct`. Helper: `RoverState.taskTargetsBuilding`.
  Real pre-existing invariant break (`task-building-ref`): at the base commit the
  `sim/property-testing` rapid-placement property fails on **31 of 39** seed pairs;
  P5 only surfaced it because a 12th blueprint shifts that test's RNG sequence.
  Now 0 of 39.
- **Steel is a construction cost.** garage 30 kg, weatherStation 25 kg (their raw
  iron dropped 30→12 and 36→18 to keep the totals sane). The survival chain —
  habitat, solar, battery, extractor, oxygenator, greenhouse — costs **no** steel,
  deliberately: P5 gates industry, never breathing. Costs are plain
  `ResourceAmounts`, so sites, reservations, `missingList` and the palette needed
  no changes.
- **Save v9.** `SAVE_VERSION = 9`, `persistence/migrations/v8.ts` in the chain,
  codec range 3…9. Additive: restore spreads `{ ...emptyAmounts(), ...saved }`, so
  a v8 colony simply has `steel: 0`. `snapshotColony` now writes
  `CURRENT_SAVE_VERSION` — the brittle `version: SAVE_VERSION as 8` literal cast is
  gone, so a bump cannot stamp a stale header.
- **Presentation.** `Renderer.makeBuildingBody` case `'refinery'` (shaft furnace +
  conical bell, catwalk ring on legs, inclined ore skip hoist, two vent stacks,
  emissive tap hole with a point light, ingot stack); `HUD.iconFor` → '🏭';
  `assetCatalog` has `building/refinery` (no GLB ships). **No HUD logic changed** —
  palette, stock chips, inspector process rows and the expedition dossier all
  iterate the tables.
- **Tests.** `tests/sim/refining.test.ts` — 19 checks, `@group integration`, linked
  in `full.test.ts` — plus 2 new `hud/chrome` checks (palette pricing, steel chip).
  Suite totals **77 suites / 887 checks**.
- **Hashes moved** (ledger grew a key, then the mass fix moved the stress one
  again): canonical `rf1-1fb397a83dab0f-03933d5673e3fc` (foundation),
  `rf1-04ac719607e6ef-19c1b02d1efd57` (logistics), `rf1-024f47c6057572-040fc7d7a2fd6a`
  (severe storm); 1-day stress `rf1-17fd8ba2b33ec1-055f4434298265`. **All four were
  re-pinned again by slice 2 — the live values are in the section above.** Pins live in
  `tests/sim/transcript.test.ts` **and** `src/sim/debug/Transcript.ts` (both!),
  `tests/sim/large-colony-stress.test.ts`, and below. `npm run test:replay` prints
  actual-vs-expected for the canonical three — use it instead of guessing.
- **Next P5 slice — shipped, see above.** The plan recorded here (components as an
  *integer* ledger beside `ResourceAmounts`, capacity from workshops, a Workshop
  process with `componentOut`, a per-building whole-unit craft accumulator,
  `ROVERS[kind].componentCost` spent in `GarageSystem.assemble`) is what slice 2
  built, and the recipe decision it was blocked on was answered as **B′**: a
  `RECIPES` list *replaces* `BUILDINGS[kind].process` rather than joining it, with
  `Building.recipe` as the selected index. Debt entries are in the roadmap's
  "Recorded (P5 slice 1 — refining)" section.

## GLB asset pipeline (rf-11)

- **Pipeline only** — Leonardo da Vinci exports land under `public/models/`
  (`rovers/`, `buildings/`, `props/`). This repo does not author/bake art.
  Tiny fixture: `public/models/_fixtures/placeholder.glb` (~0.6 KB).
- **API** (`src/render/`): `assetCatalog.ts` (logical id → URL; rover/building
  ids derived from `defs.ts` kinds), `GlbLoader.ts` (GLTFLoader wrapper,
  injectable), `ModelRegistry.ts` (`resolveUrl` / `register` / `load` /
  `getClone` / `preload`; `getClone` rebinds light targets; `register` URL
  change invalidates; failed loads retry on explicit load/preload).
  `GameRenderer.models` is the live registry. GLB mesh paths set
  castShadow/receiveShadow (+ building pick metadata) like procedural.
- **Fallback**: mesh factories (`makeRoverMesh`, `makeBuildingBody`) call
  `getClone` first; on miss they keep the existing procedural meshes.
  Unregistered id, missing file, or failed load → procedural. With an empty
  models tree (no preload), visuals are A/B identical to pre-pipeline.
- **Enable assets**: drop `.glb`s at catalog paths, then
  `await renderer.models.preload()` (or `load(id)`). Until then nothing
  fetches. Rover GLBs should include named light nodes (`marker`, `lampL`,
  `lampR`, `headlight`, `strobe`, `strobeLight`) for night lights; solar
  GLBs need `solarTrack` / `sensorEye` for tracking.
- Tests: `tests/render/glb-assets.test.ts` (linked in `full.test.ts`).

## In-play update check (TDD §23)

- `vite.config.ts` writes `dist/version.json` (`{ name, commit, builtAt,
  notes }`) at build time — commit from `GITHUB_SHA` in CI, else local
  `git rev-parse HEAD`; `notes` = the last 8 non-merge commit subjects
  (`buildNotes()`, `[]` when git is unavailable). The Pages workflow uploads
  `dist/` as-is, so the manifest is *by construction* the live build. Never
  remove it from the Pages upload path. The Pages checkout is `fetch-depth: 0`
  on purpose: the changelog needs full history, and main's HEAD is a merge
  commit a shallow clone cannot expand.
- `src/app/UpdateCheck.ts` polls that manifest every 5 min **while a colony
  runs** (started in `Game.launch`, production builds only, stopped on
  `returnToMenu`/mission end) and hands the Game an `UpdateFound`
  `{ commit, notes }` — `latestDeployedCommit` (`src/ui/BuildStatus.ts`)
  validates the sha and the note list (strings only, trimmed, capped at 12).
  Same-origin on purpose: the GitHub API (`BuildStatus.latestMainCommit`,
  main-menu badge) answers "where is main?", which can sit ahead of the live
  deploy (a failed smoke gate blocks the deploy while main moves), and
  rate-limits per IP.
- Flow on a newer commit: one-shot — freeze the sim, open the **update card**
  (frost + card, `#update-banner` / `.update-overlay`): it lists what is new
  (the `notes` changelog) and tells the player that continuing means **they**
  save and **they** reload. **Nothing saves or reloads by itself — that is a
  user requirement, not an implementation detail.** Card actions: "Save
  colony" runs the normal `Game.save(false, onDone)` under the save-progress
  frost; only a *successful* save reveals "Reload now", which the player
  clicks to run `leaveToMenu(0)`. "Later" (or Esc) hides the card and
  restores the pre-notice speed; the check is over for the session (a manual
  page reload re-arms it). Save failure in the `update` context is reported
  **on the card** (`updateNoticeSaveFailed`), never as a stacked
  save-failed prompt. Hidden tabs skip + re-arm on `visibilitychange`. QA
  knob: `?updateCheckMs=…` (≥1000).
- `scripts/update-check-smoke.mjs` drives the whole flow in headless Chromium
  (rewrites `dist/version.json` mid-run — commit **and notes** — and restores
  it); it proves the 5 s no-auto-save/no-auto-reload window, "Later", the
  reload-re-triggers-the-card path, and the player's Save → Reload path; run
  it after any change to the manifest/poller/card. `tests/app/update-check.
  test.ts` covers the poller unit-level (fake fetcher, no DOM, notes
  pass-through/validation); `tests/app/pause-save.test.ts` "Update card"
  covers the Game-level flow (jsdom).


## Pause menu + save hand-off (the "Save failed" bug)

- Root cause of the old "Save failed — the colony could not be read" on every
  ☰ click: the old menu button fired the save and disposed the host on the
  very next line, so on the (default) worker transport the in-flight snapshot
  request was rejected as "the colony has shut down". **The fix is ordering,
  not retries:** `Game.leaveToMenu()` only runs from the save's `onDone`
  callback — after the write has settled one way or the other — and a failed
  hand-off save lands on the save-failed prompt instead of a toast.
- The ☰ button now opens `src/ui/PauseMenu.ts`: the sim pauses
  (`hud.setSpeed(0)`, restored on close; while open the menu owns the keyboard
  and only Esc is honored). Tabs: actions (Resume / Save game / Return to main
  menu), settings (game, graphical, interface — applied live through
  `Game.pauseSettings()`), expedition (live stats from `Game.buildColonyStats()`).
- Save UX contract (HUD): `#save-progress` is the full-screen frost
  (z-120, above the pause menu's z-100) with a centered card and staged
  progress — user-initiated saves only; `#save-flash` is transient (1.8 s);
  `#save-error` is the save-failed prompt (Retry / Save as new file / Keep
  playing, plus "Return to menu without saving" in menu context only).
  `Game.saveContext: 'auto' | 'manual' | 'menu' | 'update'` decides phrasing
  and visibility: the prompt shows when `!quiet || (visible && context
  !== 'update')`; a hidden-tab autosave failure is console + toast, never a
  prompt.
- **Headless reload gotchas (learned the hard way in `scripts/pause-smoke.mjs`):**
  after `location.reload()`, a long-lived in-page poller (Playwright
  `waitForFunction`, in *any* polling mode) does not reliably re-arm in the
  sparticuz Chromium build, while a fresh `page.evaluate` from Node always
  sees the current document. Poll for the reload from the Node side — the
  smoke sets `window.rfNav` before the quit click, then polls
  `!('rfNav' in window)` every 250 ms. Also: the "Saved" flash is up ~1.8 s
  total; catch it with a timer-polling wait armed *before* the save settles,
  never by reading it after the progress frost lifts.
- Tests: `tests/app/pause-save.test.ts` (Game-level) +
  `tests/hud/pause-menu.test.ts`. jsdom notes: a standalone suite that
  constructs `new Game()` must `process.exit` itself at the end (the frame
  loop's chained rAF keeps Node alive), and `globalThis.fetch` must be stubbed
  to reject (MainMenu's GitHub badge fetch hangs the runner in a blackholed
  sandbox).
- **Phase 19 done:** save/pause-menu logic extracted to `SaveController` /
  `MenuController` (see Phase 19 note below). onDone-ordered teardown and
  `saveContext` phrasing/visibility preserved.

- `scripts/setup-playwright.mjs` installs the Playwright browser-test dependencies. Use it when Playwright is needed instead of searching for another setup script.
- TypeScript is a local project dependency. Run `npm install` before expecting `tsc` or other package tools to be available.
- Add architecture notes, recurring pitfalls, useful commands, and unfinished work here as they are discovered.

## Design docs (realigned)

- `docs/design/GDD.md` and `docs/design/TDD.md` carry a living **§0 Implementation status** that maps every major system to **IN / PARTIAL / OUT** against the current tree (Prototype 4 + the first P6 exploration slice + four shipped P5 slices: refining, manufacturing, rover maintenance and water networks). Prefer those tables over the original PDF wording when deciding what exists.
- **Re-swept 2026-09-20** on `arena/01a0bc5e-red-frontier` (this branch): GDD §§0/02/04/05/06/07/11/12/13/14/15/16/17, TDD §§0–3/4/9/10/11/15/16/17/18/19/20/21/22/23/25/26/27 + both appendices, README (intro, garage kW, module tree, save chain, testing, milestones), `ROVER-STATE.md` §3, and `ISSUES.md` #18.
- **Updated for P5 slice 1 (refining)** on this branch: GDD §§0/02/03/04/16, TDD header + §§0/6/7/15/21/25/26 + Appendices A/B, README (survival + growth chains, a new *Refining (P5)* section, module tree, save chain, testing counts, milestone 2, the ordering note), and a new "Recorded (P5 slice 1 — refining)" section in the roadmap.
- **Updated again for P5 slice 2 (manufacturing)**: GDD §§0/02/03/04/05/16 (the industrial-components paragraph, the Workshop row, the rover assembly prices, the P5 slice row and a new "slice 2 shipped" bullet list), TDD header + §§3/6/15/16/25/26 + Appendix B (a `Manufacturing` network row, the v10 migration step, `building/recipe` in the command list, the acceptance table), README (a machine chain diagram, a new *Manufacturing (P5)* section, module tree, save chain, suite list and prose, milestone 2, the ordering note), and this file. `SaveCodec`'s header comment was also stale ("outside 3..8", "migrations v3..v7 → v8") and now describes the rule instead of a version.
- Package is `0.3.0`; README correctly says Prototype 4. **`SAVE_VERSION = 11`** (v9 = steel; v10 = manufacturing; v11 = installed rover part health and Repair Bay jobs; supported chain v3→v11). Worker is the default transport (`WORKER_DEFAULT = true`).
- **Numbers to quote:** `npm test` = **79 suites / 913 checks**, ~3½ min in parallel (39 unit, 23 integration, 15 hud, 1 determinism, 1 load, + `full.test.ts` as the linked serial entry). CI (`pages.yml`) runs `npm run build` (which runs `tsc`) + mobile smoke + worker smoke ×2 transports; **`npm test` is not in CI** — that is deliberate and now written down in TDD §23.
- **Things the docs used to get wrong** (fixed, but check them again if you touch these areas): audio was listed OUT while `src/audio/AudioSystem.ts` shipped; lightning was absent from every doc while 21 source files carried it; the garage charge rate was quoted as 40 kW when `GARAGE_CHARGE_RATE_KW = 32` (2× the pod's 16); perf budgets were called "unenforced" while `sim/performance-regression` asserts them; the minimap/world map was open in `ISSUES.md` while `ui/WorldMap.ts` + `hud/worldmap` shipped it; world sizes were described as "~640 m default" without the four presets (420/640/960/1280 half-extent).
- **Doc-drift trap:** suite/check counts, the save version and the module tree are quoted in *four* places (README, GDD §0, TDD §0/§3, this file). When you add a suite or bump `SAVE_VERSION`, grep for the old number rather than updating the file you happen to be in.
- **Next-pillar fork was answered in the build:** Exploration (P6) went first, then Engineering in three slices — refining, manufacturing and rover maintenance are IN, and GDD §03's replication chain is complete end to end. TDD §25 still has no tier for the industrial layer, so P5 progress is tracked in GDD §0/§16 and TDD Appendix B, not in a T-row. The one-process-per-building model that blocked slice 2 is **gone** (`RECIPES` + `Building.recipe` + `activeProcess`), so a second refined material or a wider parts catalogue is now content, not architecture. The open fork is the remaining P5 depth (utility networks, building component wear) vs the T6 remainder. (The 30-phase *architectural* roadmap is complete, so this is a content/product decision, not a structural one.)
- Deliberate locks encoded in sim + docs: bulk solids on rovers, fluids never; per-resource storage; **one bulk ledger** — refined material is a `ResourceId` with `origin: 'refined'`, never a parallel inventory; **a deposit is always mined material** (typed, not just conventional); **a process earns its output** — production is bounded by the input that actually arrived; dev *modifiers* never save, *fabrications* do; no field-fluid recovery in supply drops; **audio + particles are presentation** (read the sim, never write it, animate on sim time); **lightning has its own seeded RNG stream** so strikes never perturb weather rolls.
- Unconfirmed, worth watching: one full `npm test` run in three showed a single transient suite failure that the two re-runs did not reproduce (the failing log line was lost to a `| tail`). Timing-threshold suites (`sim/performance-regression`, `sim/worker-performance`) are the obvious suspects under parallel load. If it recurs, capture the whole log before concluding anything.

## Weather FX (dust devils)

- Devil behaviour lives in `src/render/particles/effects.ts` (`DustDevil`, `DevilManager`, `devilBand`, `MAX_DEVILS`).
  `FxContext` is the only interface between it and the world, and it now carries **`windRamp`** (m/s per sim second) —
  `WeatherFX.sync` derives it from the previous frame's reading, because the sim reports wind speed but never its
  derivative. Anything building an `FxContext` by hand (tests, tooling) must supply it.
- Devil counts are **rolled per intensity band and held**, not rolled per frame (`wantedFor` + `BAND_HOLD`). Rolling
  every frame would spawn and kill a devil on alternate frames as a storm hovers on a band boundary.
- `RAMP_MIN = 0.35 m/s²` was calibrated against the real sim, not guessed: 20 minutes of ambient weather across six
  seeds never trips it, a scheduled storm trips it as its front arrives. Re-check both directions before touching it.
- Budget: `MAX_DEVILS = 5`. Worst case measured at ~6155 of 9000 particles (5 devils fed to their growth cap plus a
  severe storm). `tests/render/particles.test.ts` pins that ceiling.
- **Adding a `rand()` draw to `DustDevil`'s constructor moves every seeded FX test** — the devil RNG is the FX RNG, and
  the size/spin/wander draws all come out of one stream. Expect to re-tune seeds when it changes.

## Dust field (the #2 / #7 rework)

- Ambient dust no longer blows into a fixed box: `WeatherFX.viewGeometry` derives `viewRadius`
  (half-diagonal of the viewed ground footprint) from rig radius, FOV, aspect and view angle, and
  `dustField(viewRadius)` in `particles/effects.ts` turns it into the emission envelope
  (`half`, `height`, `size` LOD, `alpha` haze, `swirl`, feather `r0`). `FxContext.viewRadius` is
  **required** — anything building an `FxContext` by hand (tests, tooling) must supply it.
- `half` is the emission box, the `wrapAmbient` radius *and* the rim feather's outer radius at
  once — that coincidence is what hides the box: `ParticlePool.setFalloff` fades ambient alpha to
  zero exactly at the wrap rim on a p=4 superellipse (stored in distance⁴ space so `writeRender`
  needs no roots). Never wrap at one radius and feather at another.
- `FIELD_MIN = 45` (close-up floor: up close you are inside the dust), `FIELD_MAX = 1000`
  (from-orbit ceiling: the world is 1280 m across, past that the field would hang over the void).
  Emission *rates* are deliberately view-independent — the box matches the view, so screen-space
  density is constant for free and the 9000-particle pool never grows.
- Storm grit is grit: sizes `(0.35–0.9, 0.9–1.8)·size`, strictly under the wind emitter's
  `(0.5–1.2, 1.2–2.1)·size`. The storm's wall-opacity comes from fog + sky haze, not from sprite
  coverage — do not "fix" thin-looking storms by re-inflating sprite sizes.
- Turbulence is now ONE coherent divergence-free roll (`CURL_K ≈ 157 m` cells, Taylor–Green via
  the sin(a±b) identity: 2 sines/particle, cheaper than the old 3-sine per-mote jitter) plus
  `CURL_SCAT` per-mote phase scatter. Coherence is the whole "fluid" read — neighbouring motes
  must turn together. `tests/render/particles.test.ts` pins coherence (cos ≈ 1 at 8 m, ≈ −1 half
  a roll away), path curvature and the downwind transport.
- Retuning traps: turbulence amplitude means *acceleration*; visible swing ≈ tb/ω² with
  ω ≈ wind·CURL_K + pattern drift. And `drag` silently eats wander over a particle's life.

## Rover proximity (issue #11)

- Hull clearance, not centre-to-centre: `nearestObstacleClearance` returns
  `centreDist − selfR − otherR`. A literal "5 ft from centre" would sit inside
  a 2.4–3.4 m rover. Constants live in `config.ts`
  (`ROVER_PROXIMITY_*`, `ROVER_COLONY_YARD_M`).
- Speed multiplies inside `moveRover` only — no re-path, no alert, no full stop.
  Crawl multipliers are never zero so nose-to-nose pairs keep inching.
- **Destination skip is load-bearing.** Without it, a builder crawling up to a
  site (or a rescuer closing on a stranded rover) never reaches arrival reach
  and the job hangs. Skip the current goal's target once inside that task's
  arrival ring. Covered by `tests/sim/proximity.test.ts`.
- Move power scales with `speedMul` so a crawl is a brake, not a battery tax.
  Condition wear is still per-tick of driving (the drivetrain is still turning).

## Learned the hard way

- **The two sim transports have different failure modes, and only the browser gates see both.** `LocalSimHost`'s view *is* the live sim, so anything that delays a view
  update is invisible to `npm test` and fatal on the worker. Concrete case: `workerRuntime` used to publish a view only on `advance`, so a command sent to a **paused**
  colony was applied and never shown. Found by `mobile-smoke` (which pauses before ordering) the day the worker became the default transport. If you touch
  `workerRuntime`'s message cases, run `node scripts/mobile-smoke.mjs` and `scripts/worker-smoke.mjs`, not just `npm test`.
- **`SMOKE_QUERY` must be explicit now that the worker is the default.** `SMOKE_QUERY='?worker=0'` for the in-process run; an empty query means "the default", which is
  the worker, so a CI pair of `?worker=1` + empty would test one transport twice. `worker-smoke` derives its expectation from the query for exactly this reason.
- **Attributing a smoke failure takes ~3 minutes and is worth it.** Export the base commit with `git archive <sha> | tar -x -C /tmp/base`, symlink `node_modules`, build,
  serve on another port, and point `BASE_URL` at it. That is how the paused-order bug was pinned on the worker flip rather than on the feature that landed next to it.
- **POI ids and entity ids are separate spaces.** Rovers, buildings and sites each allocate their own; anything keying a DOM node or a Map by id must namespace it
  (`hud/markers` uses `rover-12` / `poi-3`).
- Sites live on `World` (`world.pois`) but are *player-mutated* state (found, stripped, burial clock), so they cross the wire in the view payload and are snapshotted —
  do not try to re-derive them from the seed client-side the way the terrain is.
- Supply drops contain bulk resources and sometimes battery cells, never fluids. Exposed water or food would freeze, and the current rover logistics model has no
  field-fluid recovery path; do not bypass that boundary by teleporting fluid cargo into colony tanks.
- **Storm screenshots need patience, not time travel.** `dev/time` jumps re-anchor the clock but
  leave `weather.time` behind, so a conjured storm's envelope does not follow the jump — and the
  severe ramp is ~1.5 sim-hours anyway. The working recipe: `game.dev.enable()` +
  `game.dev.forceStorm('severe')` straight through the dev API (the panel's buttons need the PR #29
  master switch, and on a minified build the UI path is painful to debug), then run at 4× and
  `waitForFunction(stormIntensity > 0.75)` — a few real minutes. On a worker host, dev command
  acks are Promises: a synchronous `JSON.stringify(ack)` reads as `undefined`, which is not a failure.
  The same master switch gates `overlayState()`: anything publishing pins (including
  `scripts/worker-smoke.mjs`'s battery-pin check, which #29 left red on main until it called
  `g.dev.enable()`) must turn the mode on first.
- `src/audio/AudioSystem.ts` is presentation-only procedural Web Audio: it never writes sim state, starts on the first real input gesture to satisfy autoplay policy,
  and is deliberately updated at simulation speed 0 so paused colonies retain environmental ambience and brownout/storm reminders. Keep new `SimCommand` values
  represented in its exhaustive `COMMAND_CUES` map; `tests/audio/system.test.ts` pins that contract.

- **GitHub has no REST API for wiki pages, and `contents: write` is not enough to publish one.** A GitHub page wiki is a *separate* repository (`<owner>/<repo>.wiki.git`)
  that GitHub only materialises once the wiki has a page, and which needs the repository permission **“Wikis: Write”**. Both cases answer
  `remote: Repository not found.` over HTTPS — indistinguishable from a missing repo, so `scripts/publish-wiki.mjs` treats "cannot reach it" as "try to create it"
  and prints the two causes with a preserved commit to push by hand. Verify with `git ls-remote https://github.com/<owner>/<repo>.wiki.git` before assuming a bug in
  the tooling, and note that a *reachable* wiki git repo whose only branch is `master` is still a bootstrap case for us (the publisher pushes `main`).

## Descent stage (the pod, given a body)

- `src/render/DescentStage.ts` draws the sim's landing pod (`POD_RADIUS` = 8 m at
  SPAWN) as a ~56 m propulsive-landing stage on three splayed legs. **Presentation
  only**: not in `getPickObjects()` (clicks fall through to terrain), never writes
  sim state, nothing in a save. The sim's exclusion/charge/shelter rules stay
  authoritative; the visual footprint (~10.9 m incl. feet) deliberately sits inside
  the sim's 8 m pod radius plus the 1.5 m rule margin so no *legal* building site
  can overlap a foot (`rules.ts`: centre ≥ def.radius + POD_RADIUS + 1.5).
- **Leg azimuths are load-bearing:** `[0, 120, 240]` degrees. `Simulation.ts` parks
  the starting rovers at (9, 0) and (−9, 4) — i.e. 90° and 294° — inside the pod
  radius, so a tripod at the wrong phase lands a foot on a rover on frame one.
  `tests/render/descent-stage.test.ts` pins the ≥3 m clearance; moving a leg or a
  rover spawn must re-check it.
- **The burn is two passes on one shell.** A char veil (NormalBlending, dark, alpha
  = soot) and a heat glow (AdditiveBlending). An additive pass can never darken,
  which is why the char cannot live in the glow pass — and additive blending in
  three multiplies source rgb **by source alpha** (SrcAlpha, One), so the glow's
  intensity must ride in `gl_FragColor.a` with the colour in rgb. An rgb-only
  payload with alpha 0 compiles, draws, and adds nothing: the quietest shader bug
  in this repo so far.
- `BURN` constants are the single source for both the GLSL (`BURN_MATH` templates
  them in) and the tested pure curve `burnProfile`, so the painted burn and the
  unit-tested one cannot drift. The glow also multiplies by `(1 - uDay)`: residual
  heat is a night feature, and at 86 % sun the same shader reads as a stage on
  fire.
- Metalness is kept ≈0.3 on the stage: the scene has **no environment map**, so a
  mirror-metal tank reflects nothing and renders near-black. If an env map ever
  lands, the stage is the first thing that can afford real metal.
- Shadow camera near plane went 50 → 30 (`Renderer.buildEnvironment`): a high sun
  puts the stage's top closer to the directional light than the old near plane,
  which clipped its shadow.

## Weather Radar Station (presentation + claim-map overlay)

- Mesh lives in `src/render/WeatherStation.ts` (`buildWeatherStation` /
  `syncWeatherStation`), same pattern as `DescentStage`: presentation only,
  sim owns radar range / forecast / wind. Named parts: `radarDish` (azimuth),
  `raxpolElev` (nod), `anemometerCups`, `windVane`, `ledPower`/`ledScan`/
  `ledFault`/`ledBeacon`. Animation is a pure function of sim time — pause
  freezes cups, dish and LEDs like every other light in the scene.
- **Radome contract:** `RADOME_COLOR = 0x6fd3b4`, `RADOME_SIDE = THREE.FrontSide`
  (opaque outside, backface-culled inside). MLI (white quilted beta-cloth +
  gold kapton) wraps the hut and pedestal only — never the radome, dish or cups.
- Storm cells on the **claim map** (`src/ui/WorldMap.ts`) plot at true scale:
  `STORM_KM_TO_M = 1000`. The world is 1.28 km across; a 90 km regional cell
  fills the claim, which is the honest read. HUD `#wx-radar-map` stays a
  separate km-scope PPI (heading ticks only; predicted track is the world map).
- Track math: `(xKm + sin(h)*speedKmS*t)*1000` for
  `t ∈ [0, min(remainingS, STORM_TRACK_LOOKAHEAD_S)]`. Radar available →
  `weather.radar.cells` even if empty; otherwise `current()` (full track) +
  `threat()` (footprint only, `speedKmS: 0`). Fill is clipped to the claim;
  the dashed track strokes outside the clip.
- `WeatherRadarCell` carries `speedKmS` + `remainingS` (filled in
  `radarMap()`). The host projection `{ ...cell }` already forwards new
  fields — do not list them by hand. Minimap paint key includes
  `stormOverlayKey` so a travelling front actually animates.
- GPU-free tests in `tests/render/weather-station.test.ts`. Do not import
  Three into sim; WorldMap stays 2D canvas.

## Milestone 1 — deterministic state hash (StateHash)

- `src/sim/debug/StateHash.ts`: `hashSimulation(sim)` → `rf1-<14hex>-<14hex>`
  (two cyrb53 lanes over canonical-JSON — keys sorted, entity arrays sorted
  by id). **A 53-bit hash needs 14 hex digits** — padStart(13) was a real
  bug caught by the format test; keep the `{14}` in the regex.
- Hashes **live state, deliberately not `snapshot()`** — so a persistence bug
  can't hide behind the tool that polices it, and Phase 3's codec rework
  won't churn the hash. Consequence: a live sim and its just-restored twin
  do **not** hash equal — restore resumes rovers/buildings *at rest*
  (goal/nav/chargeSat/history reset by design). Compare restored-vs-restored,
  or compare after both advance. `tests/sim/state-hash.test.ts` pins this.
- Excluded on purpose (would churn without behavior change): `statusText`,
  `idleReason`, rover `label`, colonist `name`; also unobservable: `remainder`
  and the `dropRng` closure counter (a dropRng divergence surfaces one roll
  later as a real `nextDropSol`/drop diff, which *is* hashed).
- Sensitivity-test pattern: restore by **captured exact value**, never by
  inverse arithmetic — `x + 0.1; x - 0.1` leaves float residue and the
  back-to-baseline assert fails.
- The hash module is imported only by tests: it tree-shakes out of the app
  bundle (build size unchanged). If you ever wire it into dev tooling,
  remember it becomes bundle weight.

## Milestone 1 — remaining pieces (Profiler, Save validation, Transcripts)

- `src/sim/debug/Profiler.ts`: dev-only diagnostics with process-wide switch
  (`setProfilerEnabled`, default off, enabled in `tests/harness.ts`). Counters:
  ticks, pathfinds (`NavGrid.findPath`), commands (`applyCommand`), workerMessages
  (`WorkerSimHost.post` + `workerRuntime` send wrapper), viewGenerations + timing
  (`projectView`). `Simulation.step()` measures batch time via `performance.now()`.
  `snapshot(sim)` reports tick, simTime, realMs, entities/rovers/buildings/deposits/pois,
  activeTasks (non-idle command or pending), pathfinds, commands, workerMessages,
  viewGenerations, stepTimeMs/viewTimeMs and averages. `report(sim)` adds summary +
  table identical to roadmap's example. Observationally inert (same snapshot with
  profiler on/off). Tree-shakes out of bundle when not imported.
  `tests/sim/profiler.test.ts` (10 checks) pins counters, timing, reset, report format,
  inertness.

- `tests/sim/save-validation.test.ts` (26 checks): malformed-save suite covering
  Phase 3 requirements — empty save, missing version, unsupported version, non-object,
  invalid task shapes (coerced to idle), pending queue filtering, invalid building/
  rover/poi refs, negative storage flagged by invariants, fluid clamping, battery/cargo
  bounds, missing arrays defaulting, corrupt weather fallback, lightningMul fallback,
  invalid poi kind filtering, reservedBy coercion, plus v3→v8 historical migrations
  and round-trip determinism after migration. Uses `checkInvariants` for negative cases.

- `src/sim/debug/Transcript.ts`: transcript format `{ seed, difficulty?, worldHalf?,
  region?, worldOptions?, commands: [{ tick, command }], durationTicks? }` where tick
  is Simulation ticks (SIM_TICK = 1/20s). `replayTranscript()` sorts by tick,
  delivers tick-0 pre-tick, fixed-step loop, deterministic. `TranscriptBuilder`
  ergonomic helper, `validateTranscript()` shape errors, `canonicalTranscriptJson()`
  sorted-keys JSON for stable hashing. `tests/sim/transcript.test.ts` (12 checks):
  validation, canonical stability, same-transcript identical hash (via StateHash),
  different seed/commands diverge, building placement, mining haul, builder ergonomics,
  empty transcript, manual vs transcript replay (ticks = round(20*240*sols)), hash pinning
  `rf1-…` format. Intended use for refactor policing: pin hash before extraction, compare after.

- Milestone 1 is now **complete** (48 suites / 471 checks green). Next per roadmap §51
  is Phase 2 — ColonyState, then Phase 3 — Persistence as first major extraction.
  Recorded in roadmap §58 "Recorded (Milestone 1 complete)".

## Rover task handlers — check order is load-bearing (salvage ping-pong)

- **"Am I done/full?" checks must run before "am I there yet?" checks** in a
  rover task handler. `doSalvage` had the full-hold check *after* the distance
  check; a loaded rover trying to leave the site was turned straight back
  (goal `toSalvage`↔`toDepot` every tick — the status glitched between
  "Heading to the site" and "Hauling to storage"), or, inside the 8 m reach,
  the at-site branch clobbered goal/phase to `salvage` before `beginUnload`
  re-pathed — defeating `setTravel`'s keep-in-flight guard, so the rover
  re-pathed every tick and **froze on the reach ring without moving**.
  `doMine` already had the right order; match it in any new task handler.
- **`setTravel`'s keep-in-flight guard is only as good as the caller**: it
  keeps a path only while `goal` stays the same between ticks. Anything that
  flips goal/phase between travel issuances (task branches, status writes)
  makes every tick a fresh A* path — and with one-waypoint-per-tick
  advancement the rover spends its whole tick stepping onto the cell centre it
  already occupies. Symptom: `phase === 'moving'`, position frozen.
- Full-silo salvage parks at the depot (`routePaused`, like a stuck haul
  route) retrying `tryUnload` as consumption frees room; the out-and-back
  loop resumes on its own. Pinned by the "full hold hauls home" test in
  `tests/sim/pois.test.ts`.

## Refactor Phase 5 (WeatherSystem) — and the snapshot-aliasing trap

- `src/sim/systems/WeatherSystem.ts` owns the weather behavior that used to
  live in `Simulation.ts` (`tickWeather`, the lightning resolver, the restore
  wiring, the time-jump re-anchor). The `Weather` model in `sim/weather.ts` is
  **unchanged** — scheduler + lightning RNG streams stay inside it, now pinned
  by `tests/sim/weather-system.test.ts` instead of by convention.
- **`WeatherHostHooks` is the pattern for systems that trigger cross-domain
  effects**: `tripDamaged` / `disableRover` / `endMission` are implemented by
  Simulation against its existing private methods (no second source of
  truth). Phase 10 (RoverSystem) and Phase 15 (FailureSystem) replace the
  *implementor*, not the interface. Expect the same seam for the next
  extractions that can't be pure-state yet.
- **`Weather.snapshot()` returns live references** — its `active`/`scheduled`
  arrays *and* the storm-cell objects inside them. Consequences:
  - `JSON.stringify` (localStorage saves) and `postMessage` (worker) deep-clone
    and are safe.
  - **Direct in-process `simB.restore(simA.snapshot())` aliases the two
    weathers**: both ticks move the same cells (double speed), readings
    diverge, and a "restored colony replays the same weather" test fails in
    ways that look impossible (identical cells + identical simTime, different
    `windDirRad`). Diagnose by recomputing the reading from state by hand —
    the mismatch points at shared mutation, not at the math.
  - Tests must `structuredClone(save)` before restoring into a second sim.
    (`JSON.parse(JSON.stringify())` is *not* equivalent here: it turns
    `nextRollAt: Infinity` — suppressed rolls — into `null`, which
    `Weather.restore`'s `??` reads as "resume rolling".)
  - Fix belongs to a future phase that touches the model (make `snapshot()`
    return copies); Golden Rule 1 kept Phase 5 from changing it. Recorded in
    the roadmap's Phase 5 block.
- Extraction fidelity was proven with a **pre/post hash baseline**: a
  weather-heavy script (forced storms, dirtying panels, wind damage, rolled +
  exact bolts, mid-storm save/restore) hashed at six checkpoints with
  `StateHash` before the refactor and after — byte-identical. Cheap to redo;
  do it for every extraction phase.
- `SOL_SECONDS = 240` (the game sol is compressed) — storm "durMin 300–430"
  in `STORM_PROFILE` is game-*seconds* despite the name. A 1-sol `run()` is
  only 4800 ticks; weather suites are cheap.
- Gate on completion (2026-09-16): 50 suites / 497 checks green, build
  996.7 kB / sim.worker 221.7 kB unchanged, all four browser smokes green on
  both transports. Recorded in the roadmap's "Phase 5 — Recorded" block.

## Refactor Phase 6 (PowerSystem) — moved, not redesigned

- `src/sim/systems/PowerSystem.ts` owns the grid pipeline that was
  `Simulation.tickPower` (~110 lines, verbatim move): input (generation +
  demand) → `resolvePower` (pure, `sim/power.ts`, **untouched**) → output
  (state + per-building/per-rover apply). `PowerSystem.restore` owns the
  save clamp; `nearCharger`/`chargeRateKwAt` are statics the Simulation
  delegates to — one charger map, not two.
- **`PowerSystemContext` is the second instance of the host-hooks pattern**
  (`desiredThroughput` / `runProcess` / `processBlockReason`): production
  questions answered by Simulation's existing private methods. Phase 8
  (ProductionSystem) absorbs the implementor, not the contract. A useful
  property discovered while testing: `processBlockReason` is only consulted
  when satisfaction ≥ 0.99 — during a brownout "No power" wins and the
  domain is not asked why. That ordering is load-bearing for honest idle
  reasons; the seam test pins it.
- **`tickGarages` stays in Simulation on purpose** — it *consumes*
  `powerSat` (service/assembly rates) rather than resolving the grid; it
  belongs to a later owner. Noted at the call site and in the system header
  so the next extraction doesn't "helpfully" drag it in.
- **Allocation carve-out for the "no allocations in tick" rule**: the
  per-tick `PowerResult` on `state.power` is deliberate (the view projects
  it); demand array + desired-throughput map remain the only tick-local
  scratch. Recorded in the roadmap's Phase 6 block.
- Behavior preservation: same **pre/post hash baseline** recipe as Phase 5
  (eight checkpoints: setup/noon/night/brownout/severe-storm dust collapse/
  availability loss/save-restore) — byte-identical. The baseline script
  pattern: esbuild-bundle a `/tmp/*.ts` scenario against the repo, run
  before and after, `diff`.
- Direct-drive unit tests are the cheap way to test the system in
  isolation: `devSetTime` recomputes `clock.sun` immediately (no step
  needed), and `PowerSystem.tick(sim.state, stubCtx)` can be called without
  `sim.step` — set `state.dustTransmission` by hand (normally the weather
  tick mirrors it) and give rovers full batteries to keep them out of the
  demand list.
- Gate on completion (2026-09-16): 51 suites / 511 checks green
  (`tests/sim/power-system.test.ts` +13), build 997.2 kB (290 gz) /
  sim.worker 222.1 kB, all four browser smokes green on both transports.
  Recorded in the roadmap's "Phase 6 — Recorded" block.

## Refactor Phase 7 (LifeSupportSystem) — moved, not redesigned

- `src/sim/systems/LifeSupportSystem.ts` owns the survival pipeline that
  was `Simulation.tickLifeSupport` + `tickColonistMovement` +
  `orderColonist` + `shelters`/`nearestShelter` + the fluid/colonist
  restore block, moved verbatim. `sim/lifesupport.ts`
  (`applyColonistNeeds`, `makeColonist`) is **untouched** — the system is
  the named owner around the existing pure resolver.
- **`LifeSupportHostHooks` is the third instance of the host-hooks
  pattern** (`endMission` / `completeBuilding`): death is FailureSystem
  (Phase 15), assist-complete is ConstructionSystem (Phase 9). Simulation
  implements both against its existing private methods. The system does
  **not** write `gameOver` or flip a building `online` itself — the
  recorder tests pin that.
- **Power is an input the fluid draw ignores.** A brownout still
  consumes; the pod's scrubbers are a tier-0 *load* on the grid, not a
  gate on breathing. Pinned by the power-loss test. Do not "fix" this
  inside an extraction.
- **Colonist locomotion came along this pass** (`tickColonist`) because
  suit-critical abort, storm recall and assist-complete are survival
  overrides on the same order the player issued. Splitting motion back
  into Simulation would leave two writers of `colonist.order`.
- **EVA log minutes use the literal `24.66`**, not `SOL_HOURS` (24.6597).
  Golden Rule 1 kept that rounding.
- Alerts that *report* life-support state (low O₂, colonist health) stay
  in `evaluateAlerts` until Phase 16. The system only emits the one-off
  EVA / refusal / death log lines the old methods did.
- Behavior preservation: same **pre/post hash baseline** recipe as
  Phases 5–6 (nine checkpoints: sol 1, EVA out/back, no-O₂, production
  chain, storm EVA, live vs restored mid-EVA, suit-critical abort) —
  byte-identical. Live vs restored hashes still differ (restore resumes
  at rest) — that is the StateHash contract, not a regression.
- Gate on completion (2026-09-16): 52 suites / 526 checks green
  (`tests/sim/life-support-system.test.ts` +15), typecheck green, build
  `index.js` 997.8 kB (290 gz) / `sim.worker` 222.7 kB. Recorded in the
  roadmap's "Phase 7 — Recorded" block.

## Refactor Phase 8 (ProductionSystem) — moved, not redesigned

- `src/sim/systems/ProductionSystem.ts` owns the three answers PowerSystem
  asks about a process (`desiredThroughput` / `processBlockReason` /
  `runProcess`), moved verbatim from Simulation. `BuildingDef.process` in
  `sim/defs.ts` is **untouched** — processes were already declarative; this
  phase names the owner.
- **`PowerSystemContext` did not change.** Simulation only wires
  ProductionSystem into it. Power still speaks first on a brownout
  (`processBlockReason` is not consulted when satisfaction < 0.99) — that
  ordering stays load-bearing; the production suite pins the domain half.
- **`tickGarages` stays in Simulation** — service/assembly consume
  `powerSat` rather than converting mass. Do not drag it into
  ProductionSystem "to finish the phase".
- Ice's display name is `Water Ice` (`RESOURCES.ice.label`). Idle copy
  reads `Out of Water Ice`, not `Out of Ice`.
- Greenhouses crawl at 15% in the dark (`0.15 + 0.85 × light`) rather than
  stopping; `processBlockReason` still says `Waiting for daylight` below
  irradiance 0.02. Do not "fix" that inside an extraction.
- Direct-drive tests (`ProductionSystem.runProcess(state, b, rate, hours)`
  and `PowerSystem.tick(state, liveCtx)`) are the cheap way to assert
  plate-rate arithmetic. A full `sim.step` also runs life support, which
  drinks oxygen and will miss an exact O₂ delta.
- Behavior preservation: same **pre/post hash baseline** recipe as Phases
  5–7 (ten checkpoints: extract, chain, food, no-ice, tanks-full, brownout,
  upgrade, live vs restored, night-crop) — byte-identical.
- Gate on completion (2026-09-16): 53 suites / 538 checks green
  (`tests/sim/production-system.test.ts` +12), typecheck green, build
  `index.js` 997.8 kB (290 gz) / `sim.worker` 222.7 kB. Recorded in the
  roadmap's "Phase 8 — Recorded" block.

## Refactor Phase 9 (ConstructionSystem) — moved, not redesigned

- `src/sim/systems/ConstructionSystem.ts` owns the construction job that was
  spread across `Simulation`: `verdict`/`place`/`devSpawn` (siting + the site
  record), `tickSiteMaterials` (was `tickSiteLogistics`), the material ledger
  (`commitAvailableMaterials`/`hasMaterials`/`consumeMaterials`/`missingList`),
  `assignBuilders`, `build` (was `doBuild`), `complete`/`devComplete`,
  `demolish`. `Simulation`'s public surface is unchanged — `canPlace`,
  `placeVerdict`, `placeBuilding`, `demolish`, `devSpawnBuilding`,
  `devCompleteBuilding` are thin delegates, so hosts, `applyCommand`,
  `Transcript` and every old test kept working untouched.
- **The siting rule was already extracted and stayed put.** `verdict` calls the
  same `evaluateSite` in `sim/rules.ts` that `host/mirror.ts` calls. Do not
  "tidy" the rule into the system — the ghost and the sim agree *because* there
  is one producer of those strings, on both sides of the wire.
- **`ConstructionHostHooks` is the fourth instance of the host-hooks pattern**
  (after `WeatherHostHooks`, `PowerSystemContext`, `LifeSupportHostHooks`):
  `setTravel`/`finishTask`/`autoAssign`/`disableRover`/`roverWorkMul` are
  RoverSystem's (Phase 10) and `canDeliverCargo` is LogisticsSystem's
  (Phase 13). Capacity recompute is *not* a hook — `recomputeCapacitiesState`
  is already pure over state, so `complete`/`demolish` call it directly.
- **Phase 7's `completeBuilding` hook now lands here.** The
  `LifeSupportHostHooks` *contract* did not change (its suite still stubs it);
  only the implementor moved, exactly as Phase 7 said it would. A colonist
  assisting to progress 1 still brings a site online — pinned through the live
  wiring now, not just through a stub.
- **The material ledger has one owner.** `assembleRover` (garage line) spends
  through `ConstructionSystem.hasMaterials/consumeMaterials/missingList`
  instead of private copies — that is §17's "resource accounting must have one
  authoritative owner", satisfied early. `tickGarages`/`assembleRover`
  themselves stay in Simulation (Phases 6 and 8 both left them there on
  purpose: the line consumes `powerSat` and produces rovers, it is not a site).
- Two pre-existing quirks are now **pinned by tests, not fixed** (Golden
  Rule 1), and recorded in the roadmap's Phase 9 block:
  - *One rover can be claimed by two sites and the later site wins.* Sites are
    staffed in placement order and an auto task is stealable, so the first site
    keeps a **stale `workerId`** and does no work until the second is online —
    with the two-rover starting fleet the spare rover never gets dispatched.
    This is the construction twin of the reservation quirk Phase 1 recorded.
    Fixing it (exclusive claims, or prefer an unclaimed rover) is a scheduling
    decision for Phase 10/12.
  - *A refund into an already-full silo is silently lost.* `demolish`'s comment
    promises a full refund "even if it overfills the silo" and
    `SimulationAssertions` permits over-capacity storage on that basis, but the
    capacity recompute at the end of the same method clamps it straight back.
    Paid in full only when the silo has room. Somebody should decide which of
    the three (clamp, comment, invariant note) is wrong — as a behavior change.
- **Baseline lesson: endpoint hashes are not enough — trace the rate.** The
  first 48-checkpoint baseline was green but weak: builds finish fast, so most
  construction checkpoints landed on `progress = 1` and would not have noticed
  a changed assembly *rate*. What made it sensitive was (a) sampling progress
  every few ticks into an FNV-hashed trace and (b) **same-seed differentials
  with exactly one variable** — with/without a workshop pinned 0.003600 →
  0.004860 per sample (×1.35), calm/peaked-storm pinned 0.013200 → 0.007920
  (×0.6). Reuse that recipe for Phase 10, where rover speed and wear rates are
  the whole subject.
- Test-writing traps hit this phase:
  - **A stub hook does not apply anything.** `stubHooks().autoAssign` only
    records, so asserting `rover.command.type === 'construct'` afterwards fails.
    Assert on `workerId` + the recorded call for the seam, and drive the *live*
    `sim.step` when the point is what the rover ends up doing.
  - **`assert.equal(b.state, 'site')` narrows the literal type**, so a later
    `b.state !== 'online'` loop condition fails to compile (TS2367). Re-query
    through `sim.buildingById(b.id)?.state` — the idiom `buildAndWait` in
    `tests/fixtures/sim.ts` already uses.
  - **Hard-coded world coordinates are a different world on every seed.**
    `(90, 0)` is legal on seed 700 and sits on a deposit on seed 912. Search
    for spots (`findSpot`, or a pair-search with a minimum separation) instead.
- Gate on completion (2026-09-16): 54 suites / 567 checks green
  (`tests/sim/construction-system.test.ts` +29), typecheck green, build
  `index.js` 998.3 kB (291.0 gz) / `sim.worker` 223.2 kB, all four browser
  smokes green on both transports — `worker-smoke` re-proves the phase gate
  ("ghost and placement agree") in a real browser. Recorded in the roadmap's
  "Phase 9 — Recorded" block.

## Refactor Phase 10 (RoverSystem) — moved, not redesigned

- `src/sim/systems/RoverSystem.ts` owns the fleet: the 15 `rover/*` command
  verbs, `giveTask`/`autoAssign`/`finishTask` and the deposit reservations,
  `updateRover` (storm recall → seal wear → ride-home floor → command switch),
  `moveRover` + `setTravel` and the proximity/clearance helpers, every task
  body (`doMoveTo`/`goIdle`/`doRecharge`/`unloadWhileCharging`/`doMine`/
  `beginUnload`/`tryUnload`/`doService`/`doSalvage`/`recoverSiteCells`/
  `doRecover`/`doUnload`), the energy queries (`travelKWh`/`chargeRateKwAt`/
  `nearestChargerPoint`/`roverWorkMul`/`nearDepot`/`nearCharger`/`lightsNeeded`/
  `tickLights`) and the one `spawn` factory. `Simulation`'s public rover
  surface is unchanged — thin delegates, so hosts, `applyCommand`, `Transcript`
  and every old test kept working untouched. `Simulation.ts`: 3,328 → 2,082
  lines.
- **Phase 9's rover-side hooks are absorbed.** `ConstructionHostHooks`
  (`setTravel`/`finishTask`/`autoAssign`/`disableRover`/`roverWorkMul`) and
  `WeatherHostHooks.disableRover` now call RoverSystem statics; the contracts
  did not change, so suites that stub them still pass. `RoverHostHooks`
  (`constructSite`, `canDeliverCargo`) is the fifth instance of the pattern —
  simulation still implements both seams against existing machinery.
- **What stayed, and why it is not a shortcut**: the scheduler
  (`assignMaintenance`/`assignRescues`/`assignSupplyRuns`) is Phase 12's,
  `canDeliverAny` is Phase 13's, and `tickGarages`/`assembleRover`/the dev
  backdoors/snapshot-restore are not rover behavior. This phase moved; Phase 11
  is the first allowed to *change* rover behavior (§14's move-first rule).
- **Baseline recipe that makes rover drifts visible**: 36 `StateHash`
  checkpoints + 38 FNV-1a per-tick traces (per-rover sample every 4 ticks:
  x/z/heading/battery/condition/phase/goal/navI/recharge/sheltered/
  routePaused/lights/cargo), two seeds, plus a `structuredClone`
  snapshot→restore 600-tick equality pair and a seed-912 determinism pair.
  Byte-identical before/after. A *rate* change moves a trace even when an
  endpoint hash lands on the same value — the Phase 9 lesson still holds.
- Test-writing traps hit this phase:
  - **The literal-narrowing trap, again.** `assert.equal(r.command.type, 'wait')`
    narrows the property, so a later `assert.equal(r.command.type, 'idle')` on
    the same object is compared against `never` (TS2339, not TS2367 this time).
    Re-read through a helper (`commandOf(r)`, `waitSeconds(r)`) — the same
    medicine as `buildingById` in Phase 9.
  - **A freshly-pathed rover does not move for a tick.** `setTravel` goes
    through `world.findPath` and the first waypoint is the current cell centre,
    so `moveRover` snaps to it and returns. For measured-step assertions, hand
    the rover a single far `navPath` waypoint directly.
  - **`finishTask` resets `blockNotified`** (and `routePaused`). Assert the
    *log line* (`sim.alerts.history()`) for "silos are full", not the flag —
    the flag is deliberately cleared so the next trip warns again.
  - **The ride-home floor hijacks low-battery setups.** To reach `doRecover`'s
    "can't spare enough charge" branch, the rescuer must sit *above* its own
    floor and *below* the gift minimum: near the pad that means ≈21 % of
    `maxBatteryKWh` (floor ≈ 20 %). At 12 % it just turns for a charger.
  - **You cannot strand a rover that is still beside the pad.** A near-zero
    battery on a moving rover re-enters recharge and rebounds; `stopRover`
    both machines, drive the victim away from the chargers, then set the
    battery below a tick of driving. `phase === 'disabled'` then holds.
  - **A salvage unit test that only calls `updateRover` never moves the
    rover**, so a hold-filling site loops until the tick cap. Build a small
    site (`p.salvage = {…}`, `p.energyKWh = …`) that one stop strips clean.
- The extraction also pruned the imports/constants rover code had orphaned
  (`ROVER_*`, `STORM_*`, `takeSalvage`, `mulberry32`, `PowerTier`, …) plus two
  dead privates it had called (`spawnStart`, `allocId`). Two pre-existing dead
  accessors — `Simulation.stormAnnounced`, `Simulation.remainder` — predate the
  phase, are not rover code, and were left alone and logged in the roadmap.
- Gate on completion (2026-09-18): 59 suites / 645 checks green
  (`tests/sim/rover-system.test.ts` +24), typecheck green, `test:check` green,
  build `index.js` 1,045.64 kB (304.76 gz) / `sim.worker` 226.73 kB (a
  +1.5 kB module boundary), all four browser smokes green on both transports,
  and the pre/post baseline byte-identical. The gate itself ("no renderer or UI
  code required") holds: the new file imports only sim modules and
  `lib/rng`. Recorded in the roadmap's Phase 10 block.

## Refactor Phase 11 (rover state) — documented before it was simplified

- **`docs/design/ROVER-STATE.md` is the deliverable**, not a by-product: §15 says
  document the semantics *first*, and the document is now the reference for
  `RoverSystem`, `RoverState`, persistence and the dev overlays. Its executable
  form is `tests/sim/rover-state.test.ts` (27 checks) plus
  `checkRoverExecution()` in `SimulationAssertions.ts`. Keep the three in step:
  if the code disagrees with the document, one of them is wrong *in this change*.
- **The model in one screen**: `command`/`pending` = Task (persisted, hashed);
  `goal` = execution step; `phase` = projection of the step (idle / moving /
  working / charging / disabled) that the power grid, renderer and HUD read.
  `goal` is the one field carrying two things — the task family (`mine`, `build`,
  …) and travel-vs-arrived (`toX` vs `x`). The target split (`Task` +
  `ExecutionState { phase, step }`) is right but **deferred past Phases 12/13**,
  whose scheduler rewrites would otherwise have to rebase through it; the
  four-step migration is design doc §7.
- Legal pairs (design doc §3): `idle` → idle | charging | disabled;
  `move`/`toDepot`/`toCharge`/`toSite`/`toService`/`toSalvage`/`toRecover` →
  moving; `mine` → moving | working; `charge` → charging;
  `build`/`service`/`salvage`/`recover` → working. `mine` is the only two-phase
  goal; `toDepot` and `move` have no arrived twin (arrival *is* the next
  behavior: `tryUnload`, or `finishTask`).
- Code changes: deleted the write-only `Rover.statusText`; deleted the
  unreachable `'unload'` goal (`unload` is a task, no writer ever assigned the
  goal); `enterTravel`/`enterWork`/`enterCharge`/`enterIdle`/`enterDisabled` are
  now the only writers of a `(goal, phase)` pair; `RoverSystem.rehydrate(state)`
  owns restore-time execution state (moved out of `Simulation.restore`);
  `checkRoverExecution()` machine-checks the table.
- **Phase 11 was allowed to change rover behavior and chose not to**: the Phase
  10 baseline re-ran byte-identical (`/home/user/phase11-baseline.txt`). Treat
  that file as the frozen target — a diff in a later phase means either an
  intended change (say so, and re-freeze) or a bug.
- The invariant earned its keep immediately, twice: `onArrive`'s "site is gone"
  branch left `phase='working'` behind `goal='idle'`, and the Phase 9
  construction suite stranded a rover by writing `phase = 'disabled'` by hand.
  **Fixtures must reach stranded/parked states through the domain**
  (`RoverSystem.disable`, `Simulation.issue*`), never by assigning `goal`/`phase`.
- Test traps this phase taught:
  - **A `park()` helper must reset execution state, not just position.** Clearing
    `navPath` while `goal`/`phase` still said `toSite`/`moving` is an unreachable
    state, and the new invariant fails the *fixture*, not the code.
  - **`world.findPath` never returns an empty path** (it clamps into the nav grid
    and falls back to a single waypoint), so "`moving` with no path" is always
    hand-built state.
  - **The stranded rover is usually the utility machine (40 kWh pack).** The
    jump-start gift is `max(need, 15 % of the *stranded* rover's pack)` — 6 kWh
    there, not the mining rover's 12. Don't hardcode pack numbers.
  - **`PowerSystem` can flip a parked rover to `charging` on the next tick**
    while its `goal` stays `'idle'`: post-rescue assertions should accept
    `idle | charging`, not demand `idle`.
  - **The live grid generates power**, so a salvage test's `storedKWh` delta is
    `>=` the site's cells: pin the alert text (`Recovered from the site: 30 kWh`)
    and `p.energyKWh === 0` instead of an exact store delta.
  - **The queued-order quirk is real and pinned**: an order queued behind a
    `moveTo` never runs, because `onArrive`'s `move` case idles the command
    without promoting `pending`. `until(sim, () => r.command.type === 'wait')`
    returning `-1` is the assertion.
- Gate on completion (2026-09-18): 60 suites / 672 checks green
  (`tests/sim/rover-state.test.ts` +27), typecheck and `test:check` green, build
  `index.js` 1,044.48 kB (304.50 gz) / `sim.worker` 224.65 kB, all four browser
  smokes green on both transports, baseline byte-identical. Recorded in the
  roadmap's Phase 11 block.

## Refactor Phase 12 (FleetAutomationSystem) — the job model, then the move

- **The model lives in the new file's header, not in a separate doc**:
  evaluators produce jobs; the pipeline is evaluate → filter (shelter order,
  "someone is already on it") → order (priority band, then urgency) → reserve
  (rover or seam claimed) → assign (`RoverSystem.autoAssign`). Evaluators are
  pure functions — `maintenanceJobs`, `rescueJobs`, `haulDemand`, `pickHaul`,
  `waitingSite` — and `tests/sim/fleet-automation.test.ts` exercises each one
  directly plus the passes through the live tick.
- **Priority bands are TDD §8's ordering as numbers**: survival 0 (repair,
  rescue), construction 1 (clean, site staffing), routine 2 (haul). `urgency`
  keeps the *pre-existing* per-kind sort key (health, cleanliness, fleet order,
  seam score) rather than inventing one, because the phase gate is behavioral
  equivalence. `orderJobs` is a stable sort so tied jobs keep their evaluator's
  order — which is where `|| id` tie-breaks went: they live in the evaluators.
- **"Every evaluator fleet-major except haul"** is a real asymmetry, worth
  remembering: a seam's score is `distance ÷ demand`, so the best seam depends
  on *which rover is asking*. `pickHaul(state, rover, …)` is per-rover on
  purpose.
- **Charging and storm shelter stay in `RoverSystem`.** §16 lists them under the
  scheduler, but they are one-rover rules evaluated every tick; the fleet half
  (pools skip charging/sheltering rovers; `filterJobs` cancels maintenance and
  rescue in a storm) is in `FleetAutomationSystem`. Moving the ride-home floor
  would have duplicated its maths across two modules.
- **`scripts/behavior-baseline.ts` is now in the repo.** Phases 5–11 each threw
  away their baseline script with the temp dir; this one is checked in, with
  `--write`/`--check`. It scripts a colony through every dispatch path (storm,
  flat pack in the field with a volunteer, new site, dust, damaged structure,
  caked array, then a quiet stretch with nobody under orders), hashes six
  checkpoints and folds a 2,400-sample per-tick trace per seed. **Use it for
  every future extraction.**
  - Run it against a *git archive* of `HEAD` to get a true "before":
    `git archive HEAD | tar -x -C /tmp/before && cp scripts/behavior-baseline.ts /tmp/before/scripts/ && npx esbuild /tmp/before/scripts/behavior-baseline.ts …`.
    The 12 checkpoint hashes + 2 trace digests + 4 equality pairs came back
    byte-identical from pre-Phase-10 `HEAD` to today — the strongest form of the
    claim, and cheap (20 s).
  - Trap: a scripted storm arrives *within seconds* (`devForceStorm` schedules
    with a lead), so anything you want to observe during a storm has to be
    stepped into (`until(sim, () => isStormBlocked(sim.state))`) before you set
    it up. Setting damage *before* the storm let the pre-storm ticks repair it.
- Test-authoring traps this phase produced, all of them about *who else is in
  the world*:
  - **A dispatch test must park every rover.** The tick's dispatch runs on its
    own; a test that parks rover 0 and leaves rover 1 idle is a test about two
    rovers. The second rover happily takes the clean job, which then makes
    `servicingRover` true and the assertion about the first rover meaningless.
  - **`parkAll()` before spawning a stranded rover** — parking resets
    `phase`, so parking *after* `RoverSystem.disable` un-strands the victim and
    the rescue pass has nothing to answer (silent zero-dispatch).
  - **Nearest-first is decided against the candidate**, so asserting "rover 0
    gets the rescue" fails whenever another parked rover is closer. Restrict the
    pool (`autoRescue = false` on the others) or assert on the fleet.
  - The ride-home floor also gives these tests their "low battery" scenario:
    a near-empty rover sets `recharge` on the next tick and leaves the pool —
    which is why `dispatchRescues` never has to model it.
- Gate on completion (2026-09-18): 61 suites / 695 checks green
  (`tests/sim/fleet-automation.test.ts` +23), typecheck and `test:check` green,
  build `index.js` 1,045.63 kB (304.80 gz) / `sim.worker` 225.79 kB, all four
  browser smokes green on both transports, and the A/B byte-identical against
  pre-Phase-10 `HEAD`. `Simulation.ts` 2,082 → 1,799 lines. Recorded in the
  roadmap's Phase 12 block.


## Refactor Phase 30 (Optional Future Network Boundary) — pure transport seam & string wire adapter

- **Simulation isolation guarantee**: Verified that the simulation core contains 0 references to DOM, `window`, `document`, `WebSocket`, or `fetch`.
- **Network wire adapter**: `src/sim/host/NetworkPort.ts` implements `createNetworkHostPort` and `bindServerNetworkChannel` adapting typed `HostRequest`/`HostReply` streams to/from serialized JSON string packets over duplex network channels (`NetworkDuplexChannel`).
- **Transport expansion**: `SimTransport` union expanded to `'in-process' | 'worker' | 'network'`.
- **Network boundary test suite**: `tests/sim/network-boundary.test.ts` (+6 checks) validates simulation purity, wire protocol serialization, full network host lifecycle, and latency resilience.
- Gate on completion (2026-09-20): 76 suites / 866 checks green, typecheck green, baseline byte-identical.

## Refactor Phase 29 (Large-Colony Stress Tests) — 100 rovers, 250+ buildings, sustained storm & logistics

- **Stress scenario generator**: `src/sim/debug/LargeColonyScenario.ts` creates a deterministic high-load colony (100 rovers, 255 buildings, active severe storm, multi-site construction, mining/hauling repeat-routes, and exploration).
- **Stress invariant assertions**: `assertStressInvariants(sim)` verifies deep invariants, pending queue boundedness (`<=10`), deposit reservation uniqueness, and non-deadlock progression.
- **Runners & regression suite**: `scripts/large-colony-stress.mjs` (`npm run test:stress`), `tests/sim/large-colony-stress.test.ts` (+6 checks). Pinned 1-day (4,800 ticks) state hash: `rf1-1497ee5db284ac-1af522781eadd7`.
- Gate on completion (2026-09-20): 75 suites / 860 checks green, typecheck green, baseline byte-identical.

## Refactor Phase 28 (Performance Regression Tests) — fleet scaling & benchmark thresholds

- **Scaling benchmark harness**: `src/sim/debug/Benchmark.ts` and `scripts/benchmark.mjs` (`npm run test:bench`) measure tick time, pathfinding, view generation, worker transport, and payload size across 10, 25, 50, 100, and 250 rovers.
- **Measured baseline**: 100 rovers execute ticks in ~1.4ms (budget: 50ms `SIM_TICK`), worker transport + view gen takes <1.1ms (frame budget: 16.6ms), payload 81 KB. 250 rovers execute ticks in ~4.7ms.
- **Regression suite**: `tests/sim/performance-regression.test.ts` (+6 checks) enforces scaling thresholds to catch quadratic loops and serialization regressions.
- Gate on completion (2026-09-19): 74 suites / 854 checks green, typecheck green, baseline byte-identical.

## Refactor Phase 27 (Simulation State Hashing) — domain section hashing & divergence diffing

- **Domain-isolated section hashing**: `hashSimulationSection(sim, section)` and `hashSimulationSections(sim)` across 7 authoritative simulation domains (`core`, `weather`, `resources`, `rovers`, `buildings`, `colonist`, `world`).
- **Deep structural diffing**: `diffSimulationState(simA, simB)` and `explainStateDivergence(simA, simB)` provide exact path and value differences for regression triage and desync diagnosis.
- **Authoritative projection export**: `projectSimulation(sim)` exports canonical plain-data representation.
- Gate on completion (2026-09-19): 73 suites / 848 checks green (`tests/sim/state-hash.test.ts` +3), replay tests green, baseline byte-identical.

## Refactor Phase 26 (Deterministic Replay Testing) — pinned canonical scenarios

- **Unified command application**: `Transcript.ts` now delegates `applyCommandForTranscript` directly to `applyCommand(sim, cmd)`, dropping 150 lines of duplicate command dispatching.
- **Transcript serialization & replay runner**: `encodeTranscript` / `decodeTranscript` with shape validation; `replayAndHash` returns both simulation state and final `StateHash`.
- **Pinned canonical scenarios**:
  - Scenario 1 (Foundation): `rf1-1d7ae6c1b30534-0db8f0413ab365`
  - Scenario 2 (Logistics Haul): `rf1-04698eb32329c3-1bd5148e7c7808`
  - Scenario 3 (Severe Storm Protocol): `rf1-1e512ca8a160cd-07318129a675dd`
- Gate on completion (2026-09-19): 73 suites / 842 checks green (`tests/sim/transcript.test.ts` +4), baseline byte-identical.

## Refactor Phase 25 (Property-Based Simulation Testing) — invariant fuzzing

- **Randomized command fuzzing**: `tests/sim/property-testing.test.ts` drives continuous randomized player command sequences across multiple simulation seeds.
- **Per-step invariant assertions**: Every step verifies `assertInvariants(sim)` for battery bounds, hold capacity, non-negative storage, valid reservations, and reference integrity.
- **Stress & replay verification**: Fuzzing verified under rapid build/demolish cycles, severe storms, and proven deterministic via byte-identical `StateHash` replays.
- Gate on completion (2026-09-19): 73 suites / 838 checks green (`tests/sim/property-testing.test.ts` +4), baseline byte-identical.

## Refactor Phase 24 (Worker/View Performance) — metrics without delta complexity

- **Profiler instrumentation**: `viewTimeMs`, `structuredCloneTimeMs`, `mainThreadApplyTimeMs`, `workerMessageBytes` in `src/sim/debug/Profiler.ts`. Measured in `WorkerSimHost`, `workerRuntime`, and `mirror`.
- **Baseline confirmation**: View generation (~0.3 ms), structured clone (<0.15 ms), message size (~5 KB), and mirror apply (<0.08 ms) comfortably fit within 60 FPS frame budgets. Full snapshots are not a bottleneck at current colony scale, avoiding delta complexity.
- Gate on completion (2026-09-19): 72 suites / 834 checks green (`tests/sim/worker-performance.test.ts` +3), both worker smokes (`?worker=1`, `?worker=0`) green, baseline byte-identical.

## Refactor Phase 23 (Navigation Optimization) — zero allocations & binary min-heap

- **`NavWorkspace` in `src/sim/navgrid.ts`**: reusable preallocated workspace with generation stamping (`nextSearch()`). Eliminates per-pathfinding typed array allocations (0 allocs).
- **Indexed Binary Min-Heap**: $O(\log K)$ push, pop, decreaseKey replaces $O(K)$ linear minimum scans in open set.
- **Profiler integration**: records A* duration, nodes expanded, path length, and allocation count.
- Gate on completion (2026-09-19): 71 suites / 831 checks green (`tests/sim/navigation.test.ts` +7), baseline byte-identical.

## Refactor Phase 22 (Command Architecture) — player intent vs dev backdoors

- **`PlayerCommand` vs `DevCommand`**: Formalized in `src/sim/host/protocol.ts`. Sub-unions for `RoverCommand`, `BuildingCommand`, `ColonistCommand`.
- **Exhaustive separation**: `PLAYER_COMMAND_TYPES` and `DEV_COMMAND_TYPES` partition `COMMAND_TYPES`. Type guards `isPlayerCommand`, `isDevCommand`, `isPlayerCommandType`, `isDevCommandType`.
- **Dispatch**: `applyPlayerCommand` and `applyDevCommand` in `src/sim/host/applyCommand.ts`. Architecture guard in `tests/sim/host.test.ts` prevents non-dev controllers from issuing dev backdoors.
- Gate on completion (2026-09-19): 70 suites / 824 checks green, baseline byte-identical.

## Refactor Phase 21 (Domain Events) — per-tick structured channel

- **`DomainEvent` + `DomainEventLog`** in `src/sim/domainEvents.ts`. String
  `type` discriminants (`rover/disabled`, `building/placed`, …). Collector is
  push/drain only — not a bus.
- **Wired on `ColonyState.domainEvents`.** Systems emit at existing transition
  sites beside AlertBus / FailureSystem calls. Gameplay outcomes unchanged.
- **Host API:** `drainDomainEvents()` on Simulation / LocalSimHost /
  WorkerSimHost. Worker `ViewPayload.domainEvents` for parity. AlertBus
  `drainEvents` stays the HUD toast channel.
- Gate on completion (2026-09-18): see roadmap Phase 21 Recorded block.

## Refactor Phase 20 (Strengthen SimView) — immutable presentation boundary

- **View models:** `RoverView`, `BuildingView`, `ColonistView`, `ResourceView`,
  `WeatherView`, `AlertView` / `AlertsView` in `src/sim/host/viewModels.ts`.
- **Both hosts project:** `LocalSimHost` refreshes a `ColonyMirror` via
  `projectView` (same surface as `WorkerSimHost`); live `Simulation` is never
  the presentation `SimView`. Nested bags (cargo, pending, rules, …) are
  owned copies — mutating a view field does not mutate sim state.
- **Move-not-redesign:** types/projection only; no gameplay, tick-order,
  domain events, or command-architecture changes.
- Gate on completion (2026-09-18): see roadmap Phase 20 Recorded block.

## Refactor Phase 19 (Game controllers) — composition root

- **`Game.ts` is a composition root.** Controllers under `src/app/` own the
  former Game responsibilities:
  - `GameLoop` — rAF / frame timing / `host.step()` / render scheduling
  - `InputController` — keyboard, pointer, touch, camera, `attachInput`
  - `SelectionController` — selection state, tap paths, selection visual
  - `BuildController` — build mode, ghost, placement *request* (not validity)
  - `SaveController` — save/load hand-off/autosave UI; **onDone-ordered**
    `returnToMenu` → save settle → `leaveToMenu` dispose
  - `MenuController` — pause menu open/close, settings, colony stats
  - `UpdateController` — in-play update notice save/reload/later
- **Preserved:** `saveContext: 'auto'|'manual'|'menu'|'update'` visibility
  rules; thin Game delegates keep `tests/app/pause-save.test.ts` working via
  `(game as any).returnToMenu()` etc.; smoke field aliases on Game.
- Gate on completion (2026-09-18): see roadmap Phase 19 Recorded block.
  `Game.ts` 1,904 → 868 lines.

## Refactor Phase 18 (Simulation orchestrator) — coordinate, don't implement

- **`Simulation.ts` is a thin orchestrator.** Create state, wire cross-system
  hooks, process host commands as thin delegates, advance systems in the
  existing tick order, expose lifecycle (`step` / `snapshot` / `restore`) and
  satisfy SimView. Domain bodies that were still inline moved out:
  - `GarageSystem` — bay service + assembly (`tickGarages` / `assembleRover`)
  - `persistence/ColonyPersistence` — `snapshotColony` / `restoreColony`
  - `DevBackdoors` — developer-panel mutation bodies
  - `HistorySystem` rate statics — `netRatePerSol` / `instantRatePerSol` /
    `reserveSols` arithmetic (public names stay on Simulation)
- **Tick order unchanged.** Clock → Weather → Exploration → Power → Garage →
  LifeSupport → Construction → FleetAutomation → Rover → Colonist →
  Failure→Alert → History. Architecture guard pins the call order in source.
- **Public host/command/view boundaries preserved.** applyCommand, SimView
  Pick list, and restore decode path unchanged.
- Gate on completion (2026-09-18): 67 suites / 786 checks green
  (`tests/sim/simulation-orchestrator.test.ts` +8), typecheck and `test:check`
  green, production build green (`index.js` 1,050.60 kB / 305.08 gz,
  `sim.worker` 230.68 kB), behavior A/B byte-identical against Phase 17 tip
  `6d3053e`. Smokes skipped (no Playwright on this host). `Simulation.ts`
  1,361 → ~733 lines. Recorded in the roadmap's Phase 18 block.

## Refactor Phase 17 (HistorySystem) — historical records without simulation mechanics

- **`src/sim/systems/HistorySystem.ts` owns vitals sampling.** `tick` absorbs
  `Simulation.recordHistory` + `resetFlows` (same interval gate, sample shape,
  `HISTORY_SAMPLES` ring buffer, trailing-sol flow-window roll). `clear` /
  `afterTimeJump` cover restore and `devSetTime` re-anchors.
- **`src/sim/state/HistoryState.ts` owns `HistorySample`.** Moved out of
  `ResourceState`; `emptyFlows` / `emptyHistoryWindows` helpers initialise and
  clear the windows. ColonyState create uses them.
- **Discrete event narratives stay on AlertBus.** Milestones, failures,
  discoveries, construction completion and rover incidents still write
  `state.alerts` — Domain Event → HistoryState event-log is foundation only
  (replay/analytics/reports deferred). One architectural change this phase.
- **Public rate queries stay on Simulation.** `netRatePerSol` /
  `instantRatePerSol` / `reserveSols` / `history` read the windows
  HistorySystem writes — host boundary unchanged.
- Gate on completion (2026-09-18): 66 suites / 778 checks green
  (`tests/sim/history-system.test.ts` +17), typecheck and `test:check` green,
  production build green (`index.js` 1,049.48 kB / 304.74 gz, `sim.worker`
  229.59 kB), behavior A/B byte-identical against Phase 16 tip `59b6814`.
  Smokes skipped (no Playwright on this host). `Simulation.ts` 1,419 → 1,361
  lines. Recorded in the roadmap's Phase 17 block.

## Refactor Phase 16 (AlertSystem) — notifications without FailureSystem writes

- **`src/sim/systems/AlertSystem.ts` owns failure→alert mapping.**
  `applyFailureEvents` absorbs Phase 15's interim `FailureSystem.applyAlerts`
  bridge and the action-site raises from `tripDamaged` / `endMission`
  (`BuildingTripped` / `MissionLost`). Same keys, severities, copy and
  raise/clear hysteresis — move-not-redesign.
- **FailureSystem emits events only.** It no longer writes `state.alerts` or
  imports AlertSystem. Simulation wires `FailureSystem.tick` →
  `AlertSystem.applyFailureEvents`, and weather / life-support hooks apply
  action events the same way.
- **AlertBus stays in `alerts.ts`.** Deduplication, history drain and severity
  ranking remain there; AlertSystem owns the mapping onto the bus. HUD
  dismiss/snooze stays presentation-side.
- **Other domain `state.alerts` writers unchanged** (Weather, Construction,
  Exploration, …) — one architectural change this phase.
- Gate on completion (2026-09-18): 65 suites / 761 checks green
  (`tests/sim/alert-system.test.ts` +13), typecheck and `test:check` green,
  production build green (`index.js` 1,049.72 kB / 304.68 gz, `sim.worker`
  229.82 kB), behavior A/B byte-identical against Phase 15 tip `445942c`.
  Smokes skipped (no Playwright on this host). `Simulation.ts` 1,410 → 1,419
  lines (FailureSystem 690 → 428). Recorded in the roadmap's Phase 16 block.

## Refactor Phase 15 (FailureSystem) — failures without AlertSystem

- **`src/sim/systems/FailureSystem.ts` owns failure outcomes and checks.**
  `tripDamaged` / `endMission` (the WeatherHostHooks / LifeSupportHostHooks
  implementors) and the former `Simulation.evaluateAlerts` body live here as
  `evaluate` → domain events → interim `applyAlerts` bridge. AlertBus mechanics
  and HUD objects stay out; AlertSystem is Phase 16.
- **Domain events are the existing modes only:** `RoverDisabled`, `RoverWear`,
  `BuildingFailed`, `BuildingTripped`, `PowerShortage`, `BatteryLow`,
  `FluidReserve` (OxygenCritical et al.), `ColonistHealth`, `SuitOxygen`,
  `StorageFull`, `StormActive`, `PanelsDirty`, `MissionLost`. No new product
  failure modes.
- **Rover disable stays in RoverSystem.** FailureSystem *observes*
  `phase === 'disabled'` and emits `RoverDisabled`; weather/construction still
  call `RoverSystem.disable` via hooks.
- **`FailureHostHooks.finishTask`** releases a builder when a structure trips —
  same host-hooks pattern as ConstructionSystem. `FailureSystemContext` answers
  `reserveSols` / `runnable` without owning those ledgers.
- **Delegate, don't move call sites.** `Simulation.evaluateAlerts` is a one-line
  `FailureSystem.tick` forward; weather/life-support hooks point at
  FailureSystem. Existing `tests/sim/alerts.test.ts` kept working.
- Gate on completion (2026-09-18): 64 suites / 750 checks green
  (`tests/sim/failure-system.test.ts` +18), typecheck and `test:check` green,
  production build green (`index.js` 1,049.69 kB / 304.64 gz, `sim.worker`
  229.80 kB), behavior A/B byte-identical against pre-Phase-15 tree. Smokes
  skipped (no Playwright on this host). `Simulation.ts` 1,652 → 1,410 lines.
  Recorded in the roadmap's Phase 15 block.

## Refactor Phase 14 (ExplorationSystem) — discovery vs the planet

- **`src/sim/systems/ExplorationSystem.ts` owns what the player has found.**
  Discovery radius, the Earth supply-drop schedule and burial clock, and the
  site-side of salvage (`takeSalvage` / `recoverSiteCells`) live here.
  `World.generatePois` still scatters the planet; the salvage *task* body stays
  in `RoverSystem`. That is §18's distinction as code, not a comment.
- **Delegate, don't move the call sites.** `Simulation.pois` / `poiById` and
  `RoverSystem.recoverSiteCells` keep their names as one-line forwards — same
  pattern as Phase 13's storage accessors and Phase 10's command verbs. The
  existing `tests/sim/pois.test.ts` suite did not need call-site edits.
- **No hooks required.** Exploration only writes `state.world.pois`,
  `state.nextDropSol` / `dropRng`, `state.storedKWh` (cell reward) and
  `state.alerts` — all already on `ColonyState`. Cross-domain seams that needed
  `*HostHooks` in weather/construction/rover do not appear here.
- **Architecture guard:** `.discovered=` and `.buried=` writers under `src/sim`
  are exactly `ExplorationSystem.ts`. Object-literal constructors (`discovered:
  false` in `makePoi`) and save restore (`world.setPois`) are whole-object
  writes, deliberately not matched — same split Phase 13 used for storage.
- **dropRng stays a dedicated stream.** Landing a container consumes
  `state.dropRng` alone; never the world / deposit / weather streams (roadmap
  §9 Important). A divergence still surfaces as a real `nextDropSol` / POI-id
  mismatch in the behavior baseline.
- Gate on completion (2026-09-18): 63 suites / 733 checks green
  (`tests/sim/exploration-system.test.ts` +13), typecheck and `test:check` green,
  production build green (`index.js` 1,046.93 kB / 303.80 gz, `sim.worker`
  227.03 kB), behavior A/B byte-identical against pre-Phase-14 tree. Smokes
  skipped (no Playwright on this host). `Simulation.ts` 1,790 → 1,652 lines.
  Recorded in the roadmap's Phase 14 block.

## Refactor Phase 13 (LogisticsSystem) — one owner for resource accounting

- **`src/sim/systems/LogisticsSystem.ts` is now the only module in `src/sim` that
  writes storage.** §17's design rule ("resource accounting must have one
  authoritative owner") is enforced by a test, not a convention:
  `tests/sim/logistics-system.test.ts` walks `src/sim` and asserts the modules
  matching `storage[…]\s*[-+*/]?=(?!=)` are exactly `LogisticsSystem.ts` (the
  owner) and `ColonyState.ts` (the Phase 2 capacity clamp), and that modules
  matching `\.storage\s*=` are exactly `Simulation.ts` (the accessor + save
  path). Two lessons from writing that guard:
  - **Element writes and whole-object writes are different rules** — one is
    accounting, the other is the boundary/persistence path — so the guard keeps
    two owner lists and asserts each is *exactly* the set it saw. An exemption
    list that is a superset is a lie that lets the rule rot.
  - **Scope the walk to `src/sim`.** Walking all of `src` flagged
    `src/ui/Settings.ts` (`this.storage = …`, a localStorage wrapper) — same
    identifier, unrelated concept. The simulation boundary is what the rule is
    about.
- **Delegate, don't move the call sites.** `Simulation.storageRoom/storageTotal/
  storageFull/fullResources/canDeliverAny`, `ConstructionSystem.commitAvailable
  Materials/hasMaterials/consumeMaterials/missingList` and
  `RoverSystem.claimDeposit/releaseDeposit/releaseReservations/rescueTargeted`
  all keep their names and signatures as one-line forwards. That is why this
  phase didn't touch `view.ts`, `projection.ts`, the mirror or the worker
  protocol at all, and why the existing suites kept passing unmodified. Same
  pattern as Phase 10's command verbs.
- **Reservations are task-scoped, and that is observable.** `finishTask` takes no
  state, so a finished task does *not* release its seam; the release happens on
  the next `giveTask` / `stopRover` / `disable`. Test trap this produced:
  **a test that claims a deposit directly (`RoverSystem.claimDeposit`) and then
  calls `stopRover` will not see a release** — `releaseReservations` only acts
  when the rover's command is a `mine` task. Claim the way the game does
  (`sim.issueMine`) when the subject is release-on-cancel.
- **Only deposits are reserved; sites are demand, not claims.** A starving site
  is fed by `remainingCost` (production-style), and the fleet's "held against a
  second rover" rule is a *scorer* tier inside `pickHaul` (`amount <= capacityKg
  × 2.5` shares), not a lock. That asymmetry is deliberate, documented in the
  header, and pinned: a claim steers a second hauler to the other seam;
  cancelling hands the seam back; a claim on a drained seam pins nobody.
- **You cannot iterate a deposit out of the world while a task references it** —
  the invariant checker raises `task-deposit-ref` on the next `step()`. The game
  never despawns deposits (a seam is *exhausted*, `amount → 0`), so a
  "destroyed destination" test should use the real in-game path: dismantle the
  *depot* mid-haul (the rover re-plans to the pod and the load still lands), or
  drain the seam and then test the ledger's null-safety for a missing record
  **without stepping**.
- Test-authoring traps this phase produced, all about setup *matching* the
  ledger's rules:
  - Fill silos through `LogisticsSystem.store(state, res, 1e9)`, never by
    assigning `storage[res]` in a test that is also *pinning* the rule —
    otherwise the test's own setup breaks the rule it asserts.
  - "A full silo delivers nothing to a *site*" is nonsense — a full silo still
    has material to give. What has nothing to give is an **empty** stockpile.
  - `pickHaul` returns `null` when `canMakeRun` fails, so a competing-haulers
    test that parks two rovers with stock batteries gets `undefined` and no
    clue why: set a fat battery (`b.battery = 500`) and **drain the starting
    regolith field** first — a fresh world has nearer deposits than the ones the
    test spawns, so "the best seam" is rarely yours.
  - The blocked-cargo flag means "a silo was already full when the pour
    started", not "some of the hold is stuck". Two rover-side callers log and one
    is silent about it; that is why `unloadCargo` returns `{moved, blocked}` and
    does not log.
- **The A/B "before" file can always be rebuilt**, because
  `scripts/behavior-baseline.ts` is in the repo: `git archive HEAD | tar -x -C
  /tmp/rf-head`, copy the script in, bundle it there, `--write
  /home/user/phase13-baseline-BEFORE.txt`, then `--check` from today's tree. This
  survived the scratch directory being wiped between sessions. Result: byte
  identical, and the trace digests are the same ones Phase 12 recorded
  (`17b0526f` / `32b26160`) — Phases 10–13 together moved nothing.
- Gate on completion (2026-09-18): 62 suites / 720 checks green
  (`tests/sim/logistics-system.test.ts` +25), typecheck and `test:check` green,
  production build green (`index.js` 1,046.78 kB / 305.10 gz, `sim.worker`
  226.88 kB), all four browser smokes green on both transports, and the A/B
  byte-identical against pre-Phase-13 `HEAD`. `Simulation.ts`
  1,799 → 1,790 lines (the public storage surface stayed, as delegates).
  Recorded in the roadmap's Phase 13 block.

## Refactor Phase 1 (invariants) — the loud-state era

- `src/sim/debug/SimulationAssertions.ts` is the Phase 1 deliverable: pure
  `checkInvariants(sim) → InvariantViolation[]` + `assertInvariants` that
  throws `InvariantError`. **Codes are load-bearing** — tests pin them
  (`tests/sim/invariants.test.ts`). Add new checks with new stable codes,
  never renumber.
- The gate lives at the end of `Simulation.step()`, behind the process-wide
  `setInvariantChecks()` switch (default **off**). `tests/harness.ts` flips
  it on, so every suite asserts after every step; the game, worker and
  browser smokes never do. Full-suite cost was ~11 s.
- **Two documented exceptions** (module header + check comments): storage
  may exceed capacity (`demolish()` refunds in full on purpose — only
  *negative* storage is corruption), and rover battery may briefly exceed
  the pack (rescue jump-start pays its "give" uncapped; the check only
  trips above 3× capacity + 10 kWh). If jump-start ever caps at headroom,
  tighten `rover-battery` to `maxBatteryKWh`.
- **Test fixtures may not create impossible state** — that is what the gate
  is for. `sim/pois` used to park rovers at `battery = 999`; it now charges
  a full pack and tops up *between* steps (`runPowered` in pois.test.ts).
  The pattern for "energy is not this test's subject": mutate between
  `step()` calls, never leave an impossible value sitting at a check point.
- Deliberately NOT checked in Phase 1 (reachable legit states, verified by
  reading the code, not by guess): reservation ↔ task consistency
  (`releaseReservations` only looks at the active command, so queued mines
  can leave stale claims when stop/replaced) and one-rover-multiple-claims
  (shift-queued mine orders claim each seam). Both are real lifecycle quirks
  for a future phase to decide on — do not "fix" them inside an extraction
  without a behavior-change note.
- Gate on completion (2026-09-16): 44 suites / 413 checks green, build 989 kB
  unchanged, all four browser smokes green on both transports. Recorded in
  the roadmap's "Phase 1 — Recorded" block.

## Refactor Phase 0 (baseline) — and the jsdom canvas trap

- `ARCHITECTURAL-REFACTOR-ROADMAP.md` (repo root) is the governing plan since PR #38. Read
  §3 (Golden Rules), §48 (phase checklist) and §51 (execution order) before touching `sim/`.
  Phases run 0 → 30; **Phase 0 is recorded complete** in that file's "Recorded baseline"
  table (typecheck 6.0 s, build 7.0 s, `npm test` 43 suites / 393 checks in 107 s on 2 cores,
  all four browser smokes green, `index.js` 989 kB). **Phase 1 (invariants) is done** — see
  the section below. Remaining Milestone 1 (§58) items: deterministic state hash, perf
  instrumentation, save validation, command transcripts — *then* Persistence is the first
  extraction.
- **CI does not run `npm test`.** `.github/workflows/pages.yml` gates `npm run build` +
  `mobile-smoke` + `worker-smoke` (both transports) only. That is how main carried 12 red
  suites: `WorldMapOverlay`'s constructor threw on a null 2D context, and the jsdom fixture
  answered null for *every* canvas, so `HUD.buildChrome()` died and all `hud/*` went red
  while CI stayed green. If you fix a HUD bug and only CI is green, run `npm test` anyway.
- `tests/fixtures/hud.ts` now hands canvases a **recording stub 2D context** instead of
  `null`. Two consequences to remember:
  - every `ui/` paint path is now genuinely executed in the HUD suites (minimap, world map,
    power sparkline) — which is how it found `stopLoop`'s bare `cancelAnimationFrame`: legal
    in a browser, a `ReferenceError` wherever only `window` is defined. Pair rAF/cAF as
    `window.requestAnimationFrame` + `window.cancelAnimationFrame`, never bare globals.
  - `paints.byCanvas[id]` counts 2D calls **per canvas id** and is module-global, so it
    accumulates across suites in the linked serial run. Assert deltas against a reading you
    took a line earlier, never absolute counts.
- `setCanvasBackend('none')` is the knob for "the browser refused the context". `ui/` must
  degrade there — a canvas is presentation, and a lost canvas may not lose the colony's
  controls. `tests/hud/worldmap.test.ts` pins that contract; anything new that paints should
  hold it too (guard the paint, keep open/fit/close/pick working — they are pure geometry).
- The stub counts calls, it does not rasterise. A wrong `MapTransform` still passes every
  jsdom test, so *what the map looks like* is only checkable in the browser smokes.
- Cosmetic, not a bug: `HUD.ts`'s `#map-btn` markup carries `class="btn"` twice; the parser
  keeps the first, so the button renders correctly. Left alone — unrelated to this fix.
