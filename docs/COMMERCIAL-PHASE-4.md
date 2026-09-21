# Red Frontier — Commercial Phase 4: Colony Operations Dashboard

*Implementation spec for Phase 4 of COMMERCIAL-ROADMAP.md, per
COMMERCIAL-ROADMAP-REVIEW.md §5 P4, §3.5 (the shared persisted event log) and
§5 P13 (the dashboard row that gives P13 teeth).*
*Status: COMPLETE — extended history, the event journal and the dashboard shipped.*
*Branch: `arena/01a0c1a4-red-frontier` · save v18*

---

## Goal

> Let players understand what their increasingly complex colony is doing.
> The player should be able to answer "why is my colony failing?" without
> spreadsheet-level analysis.

The review's re-baseline (§5 P4) scopes three pieces of work, all shipped:

| Piece | What | Status |
|---|---|---|
| **1 — Extended history** | ore/steel/components series, rover utilization, production/consumption per resource, sol-bucketed downsampling so a 200-sol colony doesn't hold 300k samples | **shipped** |
| **2 — Event log persistence** | the bounded, persisted, sol-stamped event ring (§3.5) — P11/P12's one prerequisite | **shipped** |
| **3 — Dashboard UI** | a pure mirror-driven view of the roadmap's mock + its nine graph checkboxes; **no** "NEXT BOTTLENECK" (that's P5) | **shipped** |

Plus the P13 rider (review §5): the **single points of failure** row — one UI
element that teaches redundancy without a tutorial line.

---

## Piece 1 — Extended history

### The sample widens (`HistorySample`)

`HistorySystem` samples the same gate and ring (120 × 1 s) as before, now with
the review's series added:

| Field | Meaning |
|---|---|
| `ore` | bulk mined material in storage (regolith + iron + silicon + aluminum + ice), kg |
| `steel` | refined steel in storage, kg |
| `components` | whole units on the rack (counted, not weighed) |
| `roverUtil` | fraction of the fleet holding a live task — `moving`/`working` phases, the AUTONOMY.md work split |
| `prod` / `cons` | trailing-sol production and consumption rates per fluid, kg/sol — the existing flow-window arithmetic split by direction so the dashboard graphs rate both ways |

### Sol-bucketed downsampling (`SolHistoryRow`)

`HistorySystem.tick` now takes the clock's `newSol` flag (the same flag
`AutonomySystem` already receives; the call keeps one owner) and closes one
row per sol into `state.solHistory`, capped at **240 rows**
(`SOL_HISTORY_ROWS`):

- sol **averages** over the sol's samples: generation, load, fleet utilization
- the sol's **worst** battery moment (`storedFracMin`) — the number a fleet
  engineer actually plans around
- **end-of-sol** values for pools, ore, steel, components
- sol **totals** per fluid for produced/consumed (summed from the trailing
  window at roll time, one tick of lag — the same convention as the rate
  queries)

The within-sol accumulator is derived state: never saved, never hashed,
reset with the sampling windows on restore and on time jumps, so a restored
colony recomputes its partial sol exactly the way it recomputes its charts.
Rows feed **nothing** back — they are reports, never inputs, so no future
tick can depend on which sols are remembered. A 240-sol colony now holds 240
rows instead of ~1.15M samples.

---

## Piece 2 — The event journal (§3.5)

`state.journal` — a bounded (**300**, `EVENT_JOURNAL_MAX`), sol-stamped ring
of `JournalEntry = { sol, ...DomainEvent }`, with `sol` the clock's absolute
fractional `solsElapsed`. HistoryState owns it — the module header has named
that home since Phase 17.

**Wiring.** `DomainEventLog` gains a one-line `sink` hook invoked at push
time; `createColonyState` binds it to `pushJournal`. Every system that pushes
an event journals it without knowing the journal exists; the drain queue
hosts read is untouched. The hook resolves the state lazily, so restore
(which keeps the `DomainEventLog` instance but swaps `journal`/`clock`)
never unwires it.

**What's an entry.** Everything *discrete*: milestones, failures,
discoveries, construction, salvage, rover incidents, storms, shortages,
objectives, unlocks, autonomy breaks and rungs, policy actions, tutorial
beats — exactly what the colony report (P11) and the incident timeline
(P12) aggregate.

**What is not.** The streaming types — `resource/produced`,
`resource/consumed` (per tick per running process) and `rover/moved` (a haul
loop emits several a sol). Rates live in the flow windows and the history
rings; a ring of thousands a sol would flush the bound in seconds. The skip
list lives next to the ring (`journalWorthy`) and the restorer re-applies it,
so a hand-edited save carries no entries the live ring would have refused.

---

## Piece 3 — The dashboard UI

Entry points: topbar **📊** button, the **O** key, `Esc`/backdrop/× to close.
The overlay shares the alert-history frame.

### The operations card (the roadmap's mock, measured)

| Row | Value | Status rule (thresholds in one place) |
|---|---|---|
| POWER | battery % | crit: life-support tier shedding or ≤ 5 %; warn: any brownout or ≤ 25 %; else stable |
| WATER / OXYGEN / FOOD | pool % + kg/sol net | crit < 1.0 sol of reserve, warn < 2.5, else stable — the same floors tutorial warnings and AUTONOMY B4 use (`reserveSols` projected by the host) |
| ROVERS | operational/total | crit: none operational; warn: some disabled; else ok |
| AUTONOMY | current streak | identity + best streak; tooltip states what the number measures |

### Single points of failure (P13 teeth)

One strip under the card: any critical chain with exactly one producer,
named (measured by `AutonomySystem.resilience`), or "None — every critical
chain has a spare." No tutorial line involved.

### Historical graphs — the roadmap's nine checkboxes

Power (generation/load), Water, Oxygen, Food, Ore, Rover utilization,
Battery reserves, Production, Consumption — each a canvas chart from
`view.history` **live** (the 120-sample ring) or `view.solHistory` **sols**
(the downsampled record), with a Live/Sols scope toggle. Ratio charts pin
[0, 1]; the rest autoscale across their series. Checkbox and scope choices
persist (`localStorage`). A fresh colony switching to Sols reads "The long
record begins when the first sol closes."

### What the dashboard is not

- **Not write-capable.** It reads the mirror; there is no command path out
  of it. The host seam enforces this structurally. [`ui/dashboard` pins
  description-not-advice.]
- **Not the advisor.** "NEXT BOTTLENECK" is absent on purpose — that is
  P5's panel, and keeping description/advice separate keeps the roadmap's
  don't-auto-solve principle enforceable.
- **Not the P11 report.** The journal is persisted and hashed but the
  dashboard doesn't print it; aggregation is the report's job.

---

## Save v18

`history: { sols, journal }` joins the save:

- `migrations/v17.ts` (v17 → v18): old colonies get empty rings and start
  accumulating from the restore forward.
- `persistence/historySave.ts` — the block's one sanitiser, shared by the
  migration and the restorer: plausible ranges, fixed fluid keys, the
  journal skip list re-applied, both rings re-bounded keeping the newest.
  Missing or hostile → empty charts, never a throw.
- `SaveValidator` warns on a malformed block (never on a missing one).
- The `core` state-hash section now carries `solHistory` and `journal`:
  both outlive the 120-sample ring, so hashing them pins long-run
  determinism the ring no longer can. `_solAcc` stays out (derived
  transient). Transcript, golden-colony and stress hashes deliberately
  re-pinned (SHAPE change only — no tick output moved; the freeze's
  PR-visible procedure).

`docs/SAVE-COMPATIBILITY.md` carries the v18 row; the range is v3..v18.

---

## What shipped

| Layer | Files |
|---|---|
| History state | `src/sim/state/HistoryState.ts` — extended sample, `SolHistoryRow`, transient `SolAccumulator`, journal entry/skip-list/`pushJournal` |
| Sampling | `src/sim/systems/HistorySystem.ts` — wider sample, `tick(state, newSol)`, `rollSol`, `fleetUtilization`, `flowRatePerSol`, accumulator resets in `clear`/`afterTimeJump` |
| State | `src/sim/state/ColonyState.ts` — `solHistory`, `journal`, `_solAcc`; the journal `sink` wiring |
| Events | `src/sim/domainEvents.ts` — the one-line `sink` hook |
| Tick | `Simulation.tick` forwards the clock's `newSol` (no system moved) |
| Config | `SOL_HISTORY_ROWS = 240`, `EVENT_JOURNAL_MAX = 300`, `SAVE_VERSION = 18` |
| Read model | `solHistory` in payload/mirror/ResourceView; history samples deep-copied now that they carry records |
| Save | schema **v18** (`history` block), `migrations/v17.ts`, `persistence/historySave.ts`, validator warnings |
| Hash | `solHistory` + `journal` in `core`; canonical transcripts, golden colony and the stress hash re-pinned |
| UI | `src/ui/DashboardPanel.ts` (pure model + pure markup + canvas), topbar 📊 button, `O` hotkey, Esc chain, `#dashboard-overlay` styles |
| Strings | `dashboard.*` extended (statuses, SPOF, graph titles, scopes, subs) |
| Tests | `sim/history-system` (+9), `sim/event-journal` (new, 12), `ui/dashboard` (new, 14); suite totals **98 suites / 1170 checks** |
| Docs | this file; `COMMERCIAL-IMPLEMENTATION.md`, `SAVE-COMPATIBILITY.md`, `SIMULATION-INVARIANTS.md`, `benchmarks/baseline.md` updated |

## How to run

```bash
npm run typecheck
npm test                     # 98 suites / 1170 checks
npm run test:replay          # re-pinned canonical hashes
npm run test:golden          # re-pinned golden colony
npm run dev                  # O or the 📊 topbar button opens Operations
```

## Definition of done (review §7)

- **M4: for any observed failure, playtesters can answer "why is my colony
  failing" from the dashboard alone** — the dashboard ships; the playtest
  that scores it is the open item (with P17).

## Open follow-ups (not this phase)

- P5 bottleneck advisor reads exactly this panel's inputs (history + reserve
  forecasts) — deliberately a separate overlay.
- P11 colony report + P12 incident timeline aggregate `state.journal`; when
  they build UI for it, project a bounded journal slice into the payload
  (today it travels save + sim only, by design).
- Playtest instrumentation for M4 rides the P17 pass.
