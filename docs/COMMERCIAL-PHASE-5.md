# Red Frontier — Commercial Phase 5: The Bottleneck System

*Implementation spec for Phase 5 of COMMERCIAL-ROADMAP.md, re-baselined per
COMMERCIAL-ROADMAP-REVIEW.md §5 P5 (the pure analyzer) and §5 P13 (the rider
that already shipped with Phase 4's dashboard SPOF strip).*
*Status: COMPLETE — the pure analyzer + host wiring + advisor panel + badge shipped.*
*Branch: `arena/01a0c3fd-red-frontier` · save version unchanged (v18 — first
commercial phase with no migration) · suite 100 suites / 1192 checks*

---

## Goal

> Turn raw simulation information into useful engineering decisions.

The roadmap's mock, shipped almost verbatim:

```
+--------------------------------------+
|          ! WATER BOTTLENECK          |
+--------------------------------------+
|                                      |
| Production:       8.4 kg/sol         |
| Consumption:      9.7 kg/sol         |
|                                      |
| Projected shortage: 3.2 sols         |
|                                      |
| Contributing factors:                |
|   - Rover 3 unavailable              |
|   - Ice deposit 2.4 km away          |
|   - Refinery consuming excess power  |
|                                      |
| Possible solutions:                  |
|   > Increase mining                  |
|   > Reduce consumption               |
|   > Build storage                    |
|   > Repair Rover 3                   |
+--------------------------------------+
```

Important, and kept as architecture rather than a comment:

> The game should NOT automatically solve the problem. It should provide
> enough information for the player to make the decision.

---

## Re-baselined scope (review §5 P5)

| Piece | What | Status |
|---|---|---|
| **The analyzer** | One pure module in `sim/` — inputs = history + current state, outputs = ranked bottlenecks with contributing factors and **static** solution suggestions per kind | **shipped** — `src/sim/bottlenecks/` |
| **Scope discipline** | 3 kinds at first (water, oxygen, power), **not** a general solver | **kept** — `BOTTLENECK_KINDS` is a 3-item tuple |
| **P13 rider** (§5 P13) | Single-points-of-failure surfacing — one dashboard row that teaches redundancy | **already shipped with Phase 4** (dashboard SPOF strip over `autonomy.singlePoints`) |

The P13 rider landed early because Phase 4 needed the row to have teeth:
AutonomySystem's resilience face already *measures* single points of failure;
the dashboard's strip is the *surfacing*. Phase 5 inherits it rather than
rebuilding it.

---

## The analyzer (`src/sim/bottlenecks/`)

Three files, matching the projects system's split of logic, data and shape:

- **`types.ts`** — `BottleneckReport` (kind, title, severity, per-sol rates,
  projected shortage, factors, solutions) and `BottleneckSnapshot` (ranked
  list + `next`). Plain JSON end to end: no `Map`, no `Infinity` — the worker
  carries it whole.
- **`solutions.ts`** — the static advice, as **data** (the review's *static
  solution suggestions per bottleneck type*, and the projects rule kept as a
  habit: content lives in tables, not branches). Each kind's rows echo the
  mock's own lines ("Increase mining", "Reduce consumption", "Build storage",
  "Repair Rover 3" → repair echoes for the machine that is actually hurt).
- **`analyzer.ts`** — the measurement. Pure function of `ColonyState`: the
  P1 forecast utility for fluid severity/projection (the same warning tiers
  the tutorial banner uses, so panel and banner can never disagree), the
  power resolver's own books for the grid, per-building measured state for
  causes, and deterministic ranking: severity → projected shortage → a fixed
  triage order (oxygen, water, power — "oxygen kills in hours, water in
  days").

### What a factor is allowed to say

Every factor is **measured, one clause, machine-linked when it can be**.
The analyzer never guesses — if it can't read the cause out of state, the
cause doesn't appear:

- **Producer scrutiny** (water/oxygen): nothing built, under construction,
  damaged (*repair* echo), switched off (*switch-on* echo), power-starved,
  throttled, or idle with the sim's own measured `idleReason`.
- **Water feed**: empty ice silo (plus stranded rovers as the reason the seam
  sits untouched — the mock's "Rover 3 unavailable"), nearest ice deposit
  distance in km from the build centroid (the mock's "Ice deposit 2.4 km
  away"), tankage covering under two sols of burn, the thirstiest consumer
  named with its nominal draw.
- **Oxygen feed**: water itself — when water fails first, oxygen is named as
  the symptom and "Fix water first" outranks "build another generator".
- **Power books**: demand/generation gap with both numbers, brownout shed
  tier, dead-before-dawn runway (battery sols left vs sols of night left —
  computed from the clock's own sun model), low reserve, dust-dimmed sky
  (daylight only — at night the panels were dark anyway), pod-only storage,
  and the heaviest running machine with its measured draw (the mock's
  "Refinery consuming excess power").

Caps keep the mock's proportions: **4 factors, 4 solutions** per card. More
rows than that is a spreadsheet, and spreadsheet archaeology is the failure
this phase exists to prevent.

The severity gate is the same forecast the tutorial warnings use
(`forecastFluidWithRates`): no depletion below a watch tier, no card. A
healthy colony reports **zero** bottlenecks — the empty state is the panel's
calm, not a bug.

---

## Don't-auto-solve, enforced

Nothing in the pipeline can issue a command and nothing tries:

- The analyzer's outputs are strings and entity ids only.
- The host boundary carries them on the **read-only** payload field
  (`bottlenecks`), next to `objectives`/`autonomy`/`policies`, built by the
  same snapshot function on both transports so worker and in-process can
  never disagree.
- The panel's single interaction is `focus` — the same gesture an alert card
  offers when it names a machine. Entity rows focus; solution rows focus the
  machine they name ("Repair Water Extractor #1004" → that extractor); the
  staticky advice has no click target at all.
- Every card ends with the oath (externalized copy): *"The advisor names the
  problem. Solving it stays yours."*

Description and advice stay in their two panels on purpose (review §5 P4/P5):
the P4 dashboard keeps zero advisory content — its "NEXT BOTTLENECK" absence
remains pinned by `tests/ui/dashboard`, and this phase adds the counterpart
rather than smuggling advice in.

---

## UI — the advisor panel (`src/ui/AdvisorPanel.ts`)

- **Overlay** in the dashboard's overlay family (`O`-sibling): roadmap-mock
  layout per card — headline + severity, production/consumption/projected
  shortage (a sub-sol shortage turns the number breach-red), factors dashed,
  solutions careted. Pure `advisorModelFromView` + `renderAdvisorHtml`
  (+ `advisorBadge`), the class is a shell — the dashboard pattern kept.
- **Entry points**: `B` hotkey, ⚠ topbar button, Esc-chain slot (between the
  world map and the dashboard), backdrop-`Esc` semantics identical to the
  alert history.
- **The badge** — the one place a shortage shouts with the panel closed: a
  count in the worst severity's tone, tooltip listing the active cards, and
  completely hidden when nothing is short. The advisor speaks when there is
  something to say and refuses to render otherwise ("No bottlenecks.").
- Focus taps route through the HUD's existing intent line
  (`cb.onAction('focus', id)`) — no new command type, no sim access from UI.

### Boundary wiring (payload, mirror, view, local getter)

`projection.ts` carries `bottlenecks`, `viewModels.ts` declares the readonly
view types, `mirror.ts` serves the getter, `view.ts` adds the `SimFields`
slot, and `Simulation` keeps the parity getter (`sim.bottlenecks`) — the same
four seams Phase 3's policies used, so behaviour is identical local vs worker
by construction, and a restore paints a correct panel before the first tick.

### Save version: unchanged (v18)

The advisory is **derived**: every field is recomputable from state the save
already carries, so nothing is persisted and nothing is hashed. First
commercial phase with no migration and no hash re-pin — confirmed by the
transcript, golden-colony and stress hashes passing untouched.

---

## Tests

| Suite | Checks | Pins |
|---|---|---|
| `sim/bottlenecks` (15) | healthy colony quiet; starved water → critical card with the mock's factors/solutions; damaged / switched-off machines become repair / switch-on echoes; factor & solution caps; oxygen-as-symptom ("fix water first"); power reserve tiers (10% warning / 4% critical); deficit names both kW figures; dead-before-dawn runway; pod-pack battery advice; advice is sentences-not-commands; ranking (critical oxygen > warning water); determinism + plain-JSON roundtrip; local/worker/mirror parity | all |
| `ui/advisor` (7) | the mock's numbers formatted; kWh vs kg unit handling; sub-sol breach flag; badge silent/counted/toned; mock section order; dashed factors, careted solutions, focus rows, the oath; escaping; empty state | all |

`npm test`: **100 suites / 1192 checks** (was 98 / 1170). Replay, golden and
stress hashes: unchanged. Browser smoke (build + vite preview, `?worker=0`):
13/13 — wizard to a live colony, badge silent when healthy, empty state
paints on first open (this caught a real repaint-guard bug: `lastKey === ''`
collided with the empty board's change key; the sentinel lives in
`AdvisorPanel.open`), badge counts + tones after starving water, the card
carries the mock's sections and the oath, Esc and `B` both drive it, zero
page/console errors.

---

## What this phase deliberately leaves out

- **Food** — the roadmap's three-type scope holds; the fluid machinery
  generalizes trivially when the roadmap asks for it.
- **Alerts on bottleneck transitions** — useful later, but it is tick output
  (log lines, journal entries, hash moves) and deserves its own deliberate
  pass, possibly alongside P12's incident timeline.
- **A general diagnosis solver** — the review's exact instruction is to not
  build one.
- **Historical bottleneck memory** — the P11/P12 aggregations over the P4
  journal own "what went wrong before"; the advisor is the *now*.

---

## Exit criteria (review §7)

- **M5-flavoured check**: for any of the three watched shortages, a player
  can answer "why" from the panel without leaving it (factors are measured
  and machine-linked) and has at least three distinct moves to consider
  (solutions are plural and static). The playtest instrument to confirm it
  remains the shared M1–M9 batch.

## Next (review §6 order)

- **P6'** — survey confidence + expedition planning: seeded in-sim survey
  rolls, estimates as ranges, expeditions as a range/fuel decision.
- **P8'** — rover history & naming is cheap and can slot anywhere.
