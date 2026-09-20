# Red Frontier — Simulation Invariants (Phase 0)

*Living map of what the simulation promises not to break, and which suite pins each promise.*
*Source: `src/sim/debug/SimulationAssertions.ts` (Phase 1), enabled in `tests/harness.ts`.*
*`checkInvariants` is read-only, off by default in the game/worker/smokes, on in every test step.*

This file is the Phase 0 deliverable the commercial roadmap review asks for
(§4.7 item 3). The suites exist; this file is the map.

## How invariants work

- `checkInvariants(sim) → InvariantViolation[]` with stable `code` (e.g. `rover-battery`).
- `assertInvariants(sim, label)` throws `InvariantError` carrying all violations.
- `Simulation.step()` calls `assertInvariants` when `setInvariantChecks(true)`.
- Tests enable it once in `tests/harness.ts`; production pays nothing.
- Two documented exceptions (in module header + checks):
  - Storage may exceed capacity — `demolish()` refunds in full even if overfull (only negative is corruption).
  - Rover battery may briefly exceed pack — rescue jump-start pays uncapped give (only <0 or >3×cap+10kWh is corruption).

## Invariant catalog

| Code | What it checks | Why it matters | Pinned by |
|---|---|---|---|
| `time-finite` | `simTime` and `ticksRun` finite and ≥0 | Clock never NaN / negative | `sim/clock`, `sim/invariants`, `sim/clock-system` |
| `id-unique` | Rover, building, POI, deposit IDs unique within family | No entity aliasing | `sim/invariants`, `sim/colony`, `sim/determinism` |
| `rover-battery` | Battery ≥0 and ≤3×max+10kWh, finite | No negative / absurd energy | `sim/invariants`, `sim/rovers`, `sim/fleet`, `sim/property-testing`, `sim/garage`, `sim/rover-system` |
| `rover-cargo` | Cargo per-resource ≥0, total ≤ capacity | No mass from nowhere | `sim/invariants`, `sim/rovers`, `sim/logistics-system`, `sim/refining`, `sim/components` |
| `rover-condition` | `condition` ∈ [0,100] | Drivetrain wear bounded | `sim/invariants`, `sim/rovers`, `sim/maintenance` |
| `rover-part-health` | `parts.motor`, `parts.circuitBoard` ∈ [0,100] | Installed part wear bounded | `sim/invariants`, `sim/maintenance`, `sim/engineering` |
| `rover-position` | x,y,z finite | No NaN teleport | `sim/invariants`, `sim/rovers`, `sim/navigation` |
| `rover-execution` | Legal `(goal, phase, command)` table per `ROVER-STATE.md` §3, moving needs navPath | Execution state can't drift | `sim/rover-state` (27 checks), `sim/invariants`, `sim/rover-system`, `sim/fleet-automation` |
| `building-progress` | `progress` and `assembly.progress` ∈ [0,1] | Build progress bounded | `sim/invariants`, `sim/build`, `sim/construction-system` |
| `building-health` | `health` ∈ [0,100], `cleanliness` ∈ [0,1] | Building wear bounded | `sim/invariants`, `sim/build`, `sim/storms` |
| `building-maintenance` | Repair Bay job: valid roverId, valid component, progress ∈ [0,1], owner is repairBay | No dangling bay jobs | `sim/maintenance`, `sim/invariants` |
| `building-worker-ref` | `workerId` references live rover or null | No stale crew | `sim/invariants`, `sim/construction-system`, `sim/build` |
| `building-recipe` | `recipe` non-negative integer | Workshop line index valid | `sim/components`, `sim/invariants` |
| `building-craft` | `craft[component]` ∈ [0,1] | Bench fraction bounded | `sim/components`, `sim/invariants` |
| `storage-negative` | Bulk storage per-resource ≥0 | No negative silos | `sim/invariants`, `sim/colony`, `sim/logistics-system`, `sim/refining`, `sim/property-testing` |
| `fluid-range` | Fluid amount ∈ [0,capacity] | Tank clamping holds | `sim/invariants`, `sim/life-support`, `sim/life-support-system`, `sim/water` |
| `component-ledger` | Component integer 0..rack capacity | No fractional / over-rack parts | `sim/components`, `sim/invariants`, `sim/engineering` |
| `grid-battery` | `storedKWh` ∈ [0, batteryCapacity] | Grid battery bounded | `sim/invariants`, `sim/power`, `sim/power-system`, `sim/grid` |
| `deposit-amount` | `amount` ∈ [0,maxAmount] | Seam amount bounded | `sim/invariants`, `sim/world`, `sim/colony` |
| `reservation-ref` | `reservedBy` references live rover or null | No stale seam claim | `sim/invariants`, `sim/logistics-system`, `sim/fleet-automation`, `sim/rovers` |
| `poi-amounts` | `salvage[resource]` ≥0, `energyKWh` ≥0 | No negative salvage | `sim/invariants`, `sim/pois`, `sim/exploration-system` |
| `task-deposit-ref` | Mine task deposit exists | No dangling mine | `sim/invariants`, `sim/rovers`, `sim/property-testing` |
| `task-building-ref` | Construct/clean/repair task building exists | No dangling build job (fixed in P5 slice 1) | `sim/invariants`, `sim/construction-system`, `sim/property-testing` |
| `task-rover-ref` | Recover task rover exists | No dangling rescue | `sim/invariants`, `sim/rover-system`, `sim/fleet` |
| `task-poi-ref` | Salvage task POI exists | No dangling salvage | `sim/invariants`, `sim/pois`, `sim/exploration-system` |
| `colonist-state` | Health ∈ [0,100], suitO2 ∈ [0,SUIT_O2_CAPACITY], pos finite | Colonist bounded | `sim/invariants`, `sim/life-support`, `sim/life-support-system` |
| `colonist-shelter-ref` | `shelterId` -1 EVA / 0 pod / or live building | No dangling shelter | `sim/invariants`, `sim/life-support` |
| `water-network` | Links valid (existing ports, a<b, cost=pipeCost, dist≤max, no dup), tanks 0..capacity when active, no orphan tanks, sum==pools.water | Water topology honest | `sim/water` (15 checks), `sim/invariants`, `hud/water` |
| `engineering-state` | Upgrades allowed for kind, tier 1..3, paint known, job valid, garage bay unique | No invalid refits | `sim/engineering` (15 checks), `sim/invariants`, `hud/engineering` |
| `objective-board` | Board ids exist in the project catalogue, a completed project is never re-offered, an unlock is granted at most once | No phantom projects, no double rewards | `sim/objectives` (22 checks) |

## Determinism & replay (not in SimulationAssertions but part of Phase 0 freeze)

| Invariant | What it checks | Pinned by |
|---|---|---|
| Same seed + same transcript → same StateHash | `hashSimulation` = `rf1-<14hex>-<14hex>` over canonical JSON, sorted keys, entities sorted by id. The `core` section carries the project board, the unlock registry and `lastDirectOrderSol`, so a colony that earned something different hashes differently | `sim/transcript` (canonical 3 hashes), `sim/determinism`, `sim/state-hash`, `sim/objectives`, `sim/large-colony-stress`, `tests/golden-colony` |
| Save/load preserves deterministic state | Snapshot → restore → step produces same hash as live | `sim/persistence`, `sim/save-validation`, `sim/water`, `sim/maintenance`, `sim/engineering` |
| Replay produces identical state hashes | `npm run test:replay` green | `sim/transcript`, CI `replay` job (Phase 0) |
| Worker and in-process produce same results | View payloads equal, commands ack same | `sim/worker`, `sim/host`, `worker-smoke` (both transports, CI) |
| No allocations in hot path | NavWorkspace zero allocs, heap-indexed | `sim/navigation`, `sim/performance-regression` |
| Performance thresholds | Fleet scaling budgets (§20) | `sim/performance-regression`, `sim/worker-performance`, `benchmarks/baseline.md` |
| Stress invariants | 100 rovers + 250 buildings, no queue explosion, no dup reservations, no deadlock | `sim/large-colony-stress`, `npm run test:stress` |

## Save compatibility (Phase 0 policy)

See `docs/SAVE-COMPATIBILITY.md` — every schema bump ships migration + hostile-payload test, range v3..CURRENT.

## How to add a new invariant

1. Add check in `src/sim/debug/SimulationAssertions.ts` with stable `code`.
2. Add corruption test in `tests/sim/invariants.test.ts` (intentionally corrupt state, assert code appears).
3. Add entry here with code + suite that pins it.
4. Run `npm test` — harness asserts after every step, so any existing suite that can reach the bad state will now fail.
5. If the invariant is intentionally loose (like storage overfill), document exception in module header and here.

## Change control (Phase 0 freeze meaning)

"Freeze" = change-control, not no-changes. New content still lands, but any change that moves tick output requires updating the golden hash deliberately (PR-visible, reviewed). That's already how `sim/transcript` behaves; this doc makes the policy explicit.

See `docs/design/COMMERCIAL-ROADMAP.md` Phase 0 and `docs/design/COMMERCIAL-ROADMAP-REVIEW.md` §4.7.
