# Commercial Roadmap — Review & Re-Baseline

*Analysis of the Commercial Gameplay Roadmap against the actual state of the
codebase at `46a75e8` (v0.3.0, post-architectural-refactor). The verdict: the
strategy is right, but the roadmap is written as if several of its own phases
hadn't already started. This document re-baselines it, flags hidden ordering
dependencies, and fills the commercial gaps it doesn't cover.*

---

## 1. Overall verdict

**The roadmap is strategically sound.** Its core instincts are exactly what
this project needs:

- Stop adding content, add **decisions, goals, and feedback**. Correct — the
  simulation is already deeper than the game around it (refinery → workshop →
  components → refits → water networks, and still no objectives system).
- Order of attack (first 30 minutes → projects → automation → dashboard →
  bottleneck) matches the classic "make it understandable, then make it
  goal-directed, then make it legible" sequence.
- The anti-goals section ("Do NOT spend the next year adding resources") is the
  single most valuable paragraph in the document. Keep it visible.

**The three structural problems:**

1. **It under-counts what already exists.** Phase 0 is ~80% done. Parts of
   Phases 3, 4, 6, 7, 10, 14, 15 and 18 have foundations in the tree. The plan
   should be re-baselined so effort estimates mean something.
2. **Hidden ordering dependencies between phases** that the flat 0→18 sequence
   doesn't surface (forecast math is needed by Phase 1 but lives in Phase 5;
   the autonomy project in Phase 2 is unfair without Phase 4/5 information
   systems; Phases 2/7/9 all need one shared "unlock" mechanism).
3. **Commercial gaps**: no desktop/Steam packaging workstream, no demo cutline,
   no decision on mobile's role, no playtest telemetry plan, no answer to how
   browser-localStorage saves survive a Steam release.

---

## 2. Re-baseline: what the codebase already has

| Roadmap phase | Claimed state | Actual state in tree |
|---|---|---|
| 0 — Freeze foundation | Not started | **~80% done.** 87 suites / 983 checks incl. determinism, transcript replay to a pinned hash, state-hash, property-based tests, soak, perf regression, large-colony stress. Save migrations v3→v13 with hostile-payload tests. Systems extracted under `sim/systems/` with an explicit orchestrator. Benchmarks (`test:bench`, `test:stress`) exist. |
| 1 — First 30 minutes | Not started | **Correctly not started** — zero tutorial/hint/objective code. The descent intro exists; onboarding is the genuine gap. |
| 2 — Engineering projects | Not started | Correctly not started. No objective/milestone system anywhere (`grep objective` hits only debug tooling). |
| 3 — Automation progression | Not started | **Partially exists.** Auto-dispatch, per-rover automation rules (`rover/rule`), haul routes, charge floors, energy-aware reservations. Missing: colony-level standing orders ("keep iron above 500 kg"). The MANUAL→ASSISTED rungs already exist. |
| 4 — Dashboard | Not started | **Foundation exists.** `HistorySystem` samples power + fluid vitals; `DomainEventLog` streams 19 event types; HUD has a vitals panel. Missing: ore/steel/components series, rover utilization, any dashboard UI, retention/downsampling. |
| 5 — Bottleneck | Not started | Not started, but the raw inputs (flow windows `emptyFlows`, per-building idle reasons, power tiers) all exist. |
| 6 — Exploration value | Not started | **Partially exists.** Seed-scattered POIs, fog-of-ware discovery at 55 m, salvage task, supply drops with storm-accelerated burial clocks. README itself lists "survey confidence" as the known TODO. |
| 7 — POI/event system | Not started | POIs exist but are "silent salvage pinatas" (README's own words). Narrative content is a known TODO. |
| 8 — Machine history | Not started | No rover naming, no lifetime stats. Genuine gap; cheap win. |
| 9 — Campaign | Not started | Correctly not started, but it collapses into Phase 2's system if that system is designed as data. |
| 10 — Replayability | Not started | **Foundation exists.** Three difficulty presets with real teeth, advanced world options, world seed input, seeded deterministic procgen for terrain/weather/deposits/POIs. Scenarios ≈ presets + starting-condition deltas. |
| 11 — Colony report | Not started | Inputs exist (`resource/produced`/`consumed` events, `poi/discovered`, storm events). |
| 12 — Incident/replay | Not started | Transcript replay exists as a **test** tool; incident reports need the persisted event log. |
| 13 — Redundancy | Not started | Mostly a balance + UI-surfacing pass; the sim already supports N-of-anything. |
| 14 — Technical hardening | Not started | **Largely done.** Invariants + property tests + orchestrator tests exist. Remaining: a written system-order doc and a CI-invoked golden replay. |
| 15 — Commercial polish | Not started | **Partially exists.** Settings UI, pause menu (3 tabs), sim speed controls, reduced-motion support, audio system with command→cue map, 8 rover finishes. Real work remaining: game feel, visuals, audio *content*. |
| 16 — Vertical slice | Not started | Not started; note the slice is mostly Phases 1–5 assembled. |
| 17 — Playtesting | Not started | No telemetry or session export yet. |
| 18 — Store/marketing | Not started | **Steam capsule assets at all required sizes already exported** (`steam/steamworks-export/`), press kit exists. |

**Consequence:** Phase 0 is not 1–2 weeks; it is 2–4 days of codification (see
§4.7). The estimated overall timeline compresses meaningfully once the plan
stops re-paying for work already shipped.

---

## 3. Hidden ordering dependencies (the important part)

### 3.1 Phase 1 secretly depends on Phase 5

The roadmap's own tutorial exemplar — *"Your water reserve will run dry in
1.8 sols"* — is a **forecast**: production/consumption projection over time.
That math is listed under Phase 5 (bottleneck system). Decide now that the
**forecast utility is Phase 1 infrastructure**: one pure, deterministic
function (`resource → sols-to-empty / sols-to-shortage`) living in `sim/`,
consumed by tutorial warnings (P1), the dashboard (P4), and the bottleneck
panel (P5). Build it once, three phases early.

### 3.2 The autonomy project (P2) is unfair without P4/P5

"Survive 10 sols without manual intervention" as an *early* project punishes
players who cannot yet see cascades coming. It is only fair once the colony is
legible (dashboard + warnings + forecasts). Options:

- Make "AUTONOMOUS COLONY" a **late** project (post-P4/P5), or
- Ship it early but with **difficulty-scaled duration** (3 sols settler /
  5 pioneer) and pre-warned storm scheduling.

Related: define the autonomy metric *before* building anything that displays
it (see §4.1).

### 3.3 Phases 2, 7, and 9 all need the same missing primitive: unlocks

Project rewards ("Storm forecasting", "Advanced automation"), POI rewards
("New technology"), and campaign chapters all **grant unlocks**. Today every
blueprint is available from sol 1; there is no gating concept in the sim.
Design the **unlock registry once** — a sim-side, deterministic, saved set of
`unlockId`s that blueprint availability, project rewards, POI contents, and
chapter progression all read from. Without it, each phase invents its own
gating and they fight later.

Note: this deliberately defers GDD §09's six-tier *research* tree. Projects
and POIs can grant unlocks without a research system; add research later (or
never) without rework.

### 3.4 Phase 9 (campaign) should not be its own system

If Engineering Projects (P2) are authored as **data** — `{id, title,
requirements: predicates over ColonyState, rewards: unlockIds, next: id}` —
then the campaign is just a curated chain of projects plus scripted world
events. Write that constraint into Phase 2's spec now: *no project logic in
code, only in data tables.* Chapters 1–8, scenarios, and the demo cut all
become content authoring.

### 3.5 Phases 4, 11, and 12 share one prerequisite: the persisted event log

`HistoryState`'s own header comment already says this: *"a discrete event log
(milestones, failures, discoveries, construction completion, rover incidents)
… is the named owner that future replay / analytics / mission-report work can
hang off."* `DomainEventLog` streams in-memory today but isn't saved. Build the
bounded, persisted, sol-stamped event ring **once** (P4 infrastructure) and
P11 (colony report) and P12 (incident timeline) become aggregations over it.

---

## 4. Cross-cutting recommendations

### 4.1 Define "autonomy" as one measured stat, threaded through everything

Autonomy is the north-star fantasy, the flagship project, the campaign
end-condition, the dashboard headline, and the report achievement — but the
roadmap never defines how it's measured. **Now defined in
`docs/design/AUTONOMY.md`** (three faces — streak, coverage, resilience —
with command classification, breaker rules, rung gates, save v14 schema, and
test plan). Proposal summary:

- The command protocol already classifies intent. **Direct orders**
  (`rover/move|mine|construct…`, `building/place|toggle…`, `colonist/order`)
  reset the autonomy clock. **Standing policies** (P3's future
  `policy/*` commands) do *not* — a policy doing the work is the fantasy
  working. `dev/*` commands never count.
- Persist `lastDirectOrderSol` in `ColonyState` (save-compatible: new field,
  defaults to current sol on migration).
- **AUTONOMY: 6.8 sols** on the dashboard, the P2 project gate, Chapter 8's
  win condition, and the end-of-run achievement all read the same number.

One stat, five features, zero divergence.

### 4.2 Decide the desktop/packaging story before Phase 16

The game is a Vite web app; saves and settings live in `localStorage`; an
update-checker polls the web. A commercial Steam release needs:

- A desktop shell (Tauri or Electron) or an accepted "Steam = Brave/CEF wrapper"
  story;
- **File-based saves + Steam Cloud** (localStorage saves don't survive a
  desktop build and can't sync) — this is a persistence-layer project, not a
  polish item, and touches `SaveStore`, `SaveController`, and migration
  testing;
- The update-checker behind a build flag;
- A packaging CI job producing a Steam-uploadable build.

Add this as an explicit workstream (call it **Phase 16a — Packaging**) with a
deadline *before* the vertical slice ships, because demo distribution depends
on it. `steam/steamworks-export/` already has the art; it has none of the
plumbing.

### 4.3 Decide mobile's role explicitly

The game has real mobile support (touch gestures, mobile smoke test gating CI,
mobile HUD collapse) — and ISSUES.md #1 shows the mobile UX is painful to
maintain. Every remaining UI phase (dashboard, projects UI, reports) doubles in
cost if mobile parity is required. Recommendation: declare **"desktop-first,
mobile playable but not release-gating"**, demote the mobile smoke from a
required PR gate to a nightly, and re-evaluate after M2. Un-decided, this
silently taxes every phase; decided, it's a one-line policy.

### 4.4 Make `npm test` a PR gate

CI (`.github/workflows/pages.yml`) runs build + browser smokes but **not** the
983-check suite. The entire Phase 0 value proposition — "major gameplay changes
can be made without worrying about breaking the simulation" — only holds if
the suite runs on every PR. It takes ~3.5 minutes. This is the single
highest-leverage item in this review.

### 4.5 Turn playtest transcripts into a feature

The repo already proves sessions are replayable (seed + command transcript →
identical hash). Add an **opt-in "export session transcript"** button
(dev menu first, playtest builds later). A remote playtester can then send a
few hundred bytes that reproduce their *exact* run locally — far more valuable
than a survey answer, and uniquely cheap *because* the sim is deterministic.
This belongs in Phase 17 prep, and it is a differentiator no non-deterministic
competitor can copy.

### 4.6 Externalize strings starting in Phase 1

The tutorial, warnings, projects, and narrative POIs are about to add thousands
of words of player-facing text. If it goes into `HUD.ts` template literals the
way current HUD copy does, localization later becomes a rewrite. Introduce a
`src/ui/strings.ts` (or JSON bundles) convention in Phase 1 and require new
player-facing copy to go through it. Cheap now, impossible later. English-only
at launch is a fine decision; *unlocalizable* is not.

### 4.7 Re-scope Phase 0 to what's actually missing

Genuinely remaining Phase 0 work, ~2–4 days:

1. CI runs the full suite on PRs (§4.4).
2. **Golden colony = a canonical transcript + pinned end-state hash checked
   into `tests/golden-colony/`**, not just a save file. Transcripts are
   diffable, seed-pinned, and already the replay format. Keep a checked-in
   save alongside it for manual inspection in `tests/golden-colony/`.
   `npm run test:replay` exists — wire it into CI.
3. Write `docs/SIMULATION-INVARIANTS.md` listing each invariant with the suite
   that pins it (the suites exist; the map doesn't).
4. Write the save-compatibility policy as a doc: "every schema bump ships a
   migration + hostile-payload test" (v3→v13 already obeys it).
5. Record baseline perf numbers from `test:bench`/`test:stress` into
   `benchmarks/baseline.md` and note the thresholds the regression suites pin.

### 4.8 Soften the "ROOT CAUSE" promise in Phase 12

Automatically deriving *"ROOT CAUSE: insufficient battery reserve"* is an
expert system — a research project disguised as a UI panel. The bottleneck
panel's *contributing factors* approach (§P5 of the roadmap) is the right
pattern; reuse it for incidents: a timeline of events + state snapshots +
static per-incident-type "likely causes" copy. Deliver the *learning* without
promising automated diagnosis.

---

## 5. Phase-by-phase notes

**P0** — See §4.7. Also: "freeze" should mean *change-control*, not *no
changes*: new content still lands, but any change that moves a tick output
requires updating the golden hash deliberately (PR-visible, reviewed). That's
already how the transcript suite behaves; write the policy down.

**P1** — Right first priority, and correctly specified (situation-warnings,
not click-here). Additions: (a) the forecast utility (§3.1); (b) string
externalization (§4.6); (c) instrument the *first-session funnel* — log
(anonymized, opt-in) milestone events like `first-power`, `first-water-chain`,
`first-storm-survived` so "where do new players quit" is data, not vibes;
(d) the existing descent-stage intro + mission wizard is already a decent
first 5 minutes — the vulnerable zone is minutes 5–30, between "pod landed"
and "water → oxygen chain understood". Prototype the warning copy on real
players before polishing anything visual.

**P2** — The biggest genuinely-new architecture. Requirements:
- `ObjectiveSystem` in `sim/systems/`, ticked after alerts, writing to
  `ColonyState.objectives`; project definitions in a data table
  (`sim/projects/`), never in code (§3.4).
- Progress predicates must read only deterministic sim state (they do, if
  authored against `ColonyState`).
- Rewards route through the unlock registry (§3.3) — decide what "Advanced
  automation" concretely unlocks (likely: colony-level policies, P3).
- Keep the five example projects honest to existing entities: "Emergency
  battery" and "Radar" exist (battery packs, Weather Radar Station);
  "Automated haul route" exists (`rover/repeatRoute`). Good — the first
  projects should be completable with **today's** building set, which also
  protects the demo cutline.
- UI: a projects panel + situation-driven pips on the HUD; the wizard intro
  can hand the player their first project.

**P3** — The missing piece is the **PolicySystem**: player-authored standing
orders ("keep iron > 500 kg", "keep batteries > 60% overnight") that the sim
satisfies by issuing the *same commands a player would*. Two hard
requirements: (a) policies act through the command path so transcripts and
determinism survive; (b) policy-issued actions are marked as such so the
autonomy stat stays honest (§4.1). Ship 3–5 policies, not a scripting
language. The OPERATOR→ENGINEER→ARCHITECT fantasy should be surfaced as a
visible label tied to how much of the colony's work is policy-driven — cheap
and motivating.

**P4** — Extend `HistorySystem`: add ore/steel/components series, rover
utilization (fraction of fleet with a task), production/consumption per
resource (the flow accumulators exist), and sol-bucketed downsampling so a
200-sol colony doesn't hold 300k samples. Dashboard reads the mirror; it must
not touch sim state (the host seam already enforces this — keep the dashboard
a pure view). Do **not** put "NEXT BOTTLENECK" in the dashboard; that's P5's
advisory panel, and keeping description/advice separate keeps the roadmap's
"don't auto-solve" principle enforceable.

**P5** — One pure "analyzer" module in `sim/` (testable without UI):
inputs = history + current state; outputs = ranked bottlenecks with
contributing factors and *static* solution suggestions per bottleneck type.
The roadmap's mock is exactly right; the only correction is scope: 3 bottleneck
types at first (water, power, oxygen), not a general solver.

**P6** — Matches the README's own TODO list (survey confidence, estimates as
ranges). Implementation notes: survey rolls drawn from the seeded RNG *inside*
the sim, so worker/in-process transports agree and replays hash identically;
confidence then improves with survey time/proximity. Also add the README's
"expeditions as a decision" (range/fuel planning) here rather than deferring
it — it's what makes surveying strategic rather than ceremonial.

**P7** — POIs exist; the gap is *consequence*. Before the unlock registry
exists, ship POI variety that doesn't need it: narrative log fragments,
repairable wreck → fleet chassis (garage-assembly path the README already
wants), unique resource seams. Then POI→technology via the registry. The
"avoid POI → +100 iron" rule is correct and already half-obeyed (supply drops
carry components, not just ore).

**P8** — Cheapest high-emotion phase. Per-rover lifetime accumulators in
`RoverState` (distance, kg hauled, storms survived, recoveries, repairs, built
sol), a name field (editable in the existing Engineering panel — it already
has Appearance/paint), save v14, and a dossier card. The stats are plain
deterministic sim state; the naming is a command (`rover/rename`). Note for
the report phase: "ODYSSEUS survived" lines write themselves from these
accumulators.

**P9** — A content pass over the P2 system (§3.4), plus scripted world events
(storm season = scheduler tweaks you already have via world options). Be
honest about scope: 8 chapters of authored content is months. Recommend
shipping EA with Chapters 1–3 (Survival, Stability, Industry) and adding the
rest during EA. Chapter 8's end condition is the autonomy stat (§4.1);
"CONTINUE COLONY" is simply "campaign complete, objectives panel empties."

**P10** — Mostly done via difficulty + world options; scenarios =
`{difficulty preset + world-option deltas + starting-fleet modifications +
optional fixed first project}`. "Broken Fleet" (damaged starting rovers) and
"Limited Water" (deposit scatter weights) need small world-option additions.
NewGameWizard gains a scenario picker. The seed box already supports sharing
challenge runs ("same seed race") — a marketing gift; document it.

**P11** — Aggregation over the event log + history (§3.5). Make the report
**exportable as an image** (canvas-render the card). Colony-sim audiences
spread via shareable end-of-run cards; this is a marketing feature wearing
gameplay clothes. Cheap: every number it needs is already an event or a
counter.

**P12** — Timeline = filtered persisted event log around the incident window
+ a few state snapshots (battery %, solar output) sampled by HistorySystem.
Root cause = static per-type copy (§4.8). Full in-game replay-from-save is a
luxury; the transcript exporter (§4.5) already gives *developers* frame-exact
replays of player failures, which is the part that actually improves the game.

**P13** — Correctly placed; it's a design/balance pass, not a system. One
concrete addition to P4 so P13 has teeth: a **"single points of failure"**
row on the dashboard (any resource/system with exactly one producer gets a
marker). That one UI element *teaches* redundancy without a tutorial line.

**P14** — Largely complete; remaining work is documentation (system-order doc
mirroring `Simulation.tick`'s actual sequence, kept honest by an ordering test
that asserts call order) plus the CI golden replay from §4.7. The listed
invariants (no negative resources, power ≤ available, replay hash equality)
already have suites; link them in `docs/SIMULATION-INVARIANTS.md`.

**P15** — The UX checklist is ~half shipped (settings, pause, speed controls,
reduced-motion, alerts with severity ranks). The genuine remaining work is
content: game-feel chains (construction → lights → power response →
notification — the power tier system already *causes* the physical response,
so the polish is presentation), audio *samples*, weather presentation. Keep
this last except for "clearer alerts," which P1/P4 need earlier — pull alert
presentation polish forward into P1.

**P16** — Define the **demo cutline now**, so P1–P5 aim at it: e.g., first
three projects (Establish Survival, Survive the First Storm, Industrialize),
one storm arc, POIs + salvage + one supply drop, ~60–90 min. Everything in
P1–P5 should be scoped to that cut. Demo needs the packaging workstream
(§4.2) and a build flag set (update-check off, report telemetry prompt on).

**P17** — Add §4.5's transcript export + funnel milestones (P1) as the
instrumentation, recruit from the demo's audience, and keep the roadmap's
excellent question list. One addition: record and review *sessions*, not
opinions — the questions are for after, the transcript is the evidence.

**P18** — Steam art is already exported. Add: the positioning line from the
roadmap's own final section ("Your goal isn't merely to survive Mars…") as the
page hero copy — it's the best sentence in the document; a devlog cadence
(start with the P1/P2 milestones, they're readable stories); Next Fest timing
against the demo's readiness, not the calendar.

---

## 6. Suggested revised sequence

Same total work, dependency-honest order:

```
P0'  Codify the freeze (CI suite gate, golden transcript, invariant doc)  [days]
P1'  First 30 min  +  Forecast utility  +  strings externalization
P2'  ObjectiveSystem (data-driven)  +  Unlock registry        ← shared primitive
P3'  PolicySystem (colony standing orders)  +  AUTONOMY stat
P4'  Event log persistence  +  Dashboard + extended history
P5'  Bottleneck analyzer (3 types)
P13' Single-points-of-failure surfacing (one dashboard row — ride along with P5)
P6'  Survey confidence + expedition planning
P7'  POI consequences (narrative first, unlocks second)
P8'  Rover history & naming                                   [cheap, slot anywhere]
P11' Colony report (shareable card) — after event log, before campaign
P9'  Campaign (EA: chapters 1–3)
P10' Scenarios
P16' Vertical slice  ← needs Packaging workstream done
P12' Incident reports
P17' Playtests → P15' Polish → P18' Launch
```

Rationale for the moves: forecast utility precedes everything that warns;
unlock registry precedes everything that rewards; event log precedes the two
report phases; the report phases precede the campaign because the colony
report is the *payoff* that makes finishing a campaign shareable; packaging
can't wait for P16 because demo distribution depends on it.

---

## 7. Milestone exit criteria (make the questions measurable)

The milestone questions are good; add counts so "done" is checkable:

- **M0**: suite green on every PR; golden transcript pinned in CI.
- **M1**: ≥7 of 10 unguided playtesters reach "water → oxygen chain stable"
  within 45 min without external help; the other 3 all fail at the *same*
  step (then fix that step).
- **M2**: playtesters can state their current project's goal unprompted.
- **M3**: ≥1 policy in use by session 2 of a new player's first colony.
- **M4**: for any observed failure, playtesters can answer "why is my colony
  failing" from the dashboard alone (watch, don't ask).
- **M8 (demo)**: median session ≥45 min; ≥50% finish "Survive the First
  Storm"; a measurable wishlist conversion from the demo page.
- **M9**: ≥60% of strangers return for a second session.

Numbers are placeholders — set them before the playtests so they can't be
moved to match results.

---

## 8. Risks & scope realism

1. **Solo-dev throughput vs. phase count.** 18 phases at the written estimates
   is 12–18 months. The compression in §2/§6 helps; the bigger lever is
   cutting: EA with chapters 1–3 (P9), 3 bottleneck types (P5), 3–5 policies
   (P3), demo-cutline-only scope for P1–P5.
2. **The sim keeps growing anyway.** The roadmap's "WHAT NOT TO DO" list will
   be violated by the roadmap itself in small ways (e.g., P7 invites deeper
   POI simulation). Rule of thumb, already stated in the document: every
   addition names the decision it creates. Enforce it in review.
3. **Determinism tax on new features.** Every phase that adds player-facing
   randomness (survey estimates, POI contents, scenarios) must draw from the
   seeded RNG inside the sim. This is a standing constraint, not a per-phase
   afterthought; the transcript/hash suites will catch violations, but late.
4. **Saves & migration debt.** v3→v13 is healthy, but every phase above adds
   fields (objectives, policies, unlocks, rover stats, names, event log).
   Budget a migration per phase as a first-class deliverable, and the desktop
   save move (§4.2) will multiply it — do the desktop move *before* the
   heaviest save-schema phases (P2/P3/P4), not after.
5. **One-colony emotional ceiling.** The fantasy arc ends at autonomy; after
   M6 the retention engine is scenarios + seeds + reports (P10/P11). If
   playtests show players stopping at "colony is autonomous," invest there
   before P15 polish.

---

## 9. What the roadmap should keep verbatim

- The core loop diagram and the HUMAN → AUTONOMOUS progression — they are the
  game's identity and should be pasted into the store page and the GDD.
- The tutorial philosophy (situation → warning → player discovers the fix).
- "Repeated questions are UX problems."
- The TIER 1–4 prioritization and the entire WHAT NOT TO DO section.
- "Simulation complexity is NOT the goal. Interesting decisions ARE."
