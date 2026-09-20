> ← [Home](Home.md)

# Rover Logistics

Rovers are the colony's hands: everything physical that moves, gets dug, gets
built, or gets fixed is a **task** on a rover. This page covers the task model,
automation, wear and recovery;
[docs/design/ROVER-STATE.md](https://github.com/iant89/red-frontier/blob/main/docs/design/ROVER-STATE.md)
is the deeper reference for the state fields.

## Task layers

| Layer | Fields | Persisted | Owner |
|---|---|---|---|
| **Task** — what it should do | `command`, `pending` | yes | `RoverSystem` |
| **Execution state** — how it is doing it right now | `goal`, `phase` | **no** — rebuilt on restore | `RoverSystem` |
| **Conditions & progress** — what the world is doing to it | battery, cargo, condition, nav, lights, flags | mixed | `RoverSystem`, `PowerSystem`, `ConstructionSystem` |
| **Presentation** — wording | *(none stored)* | — | `roverStatusText(r)` |

Two consequences worth internalising:

1. `goal` / `phase` are **runtime** execution state. A save round-trip rebuilds
   them from `command`/`pending` plus the world in `RoverSystem.rehydrate`, so any
   rule about "what a restored rover is doing" must match the rule the live tick
   uses — which is why rehydration lives beside those rules, not inline in
   `Simulation.restore`.
2. **Wording is not state.** A stored `statusText` used to exist, nothing read it,
   and it could only drift — so the refactor deleted it.

## Task types

```
idle | moveTo | mine{repeat?} | construct | clean | repair | recover{give,given}
     | salvage | unload | wait{seconds}
```

`moveTo` · `mine` · `construct` · `clean` · `repair` · `recover` · `salvage` ·
`wait` are all **queueable**: `Shift`+order appends, a plain order replaces the
queue, and the head task is the current command. `recover`'s `give`/`given` fields
make the task the *only* place that knows how far a jump-start has got.

Assigning a task does **not** touch execution state — the next `updateRover`
derives it. Between an order and the next tick, `goal`/`phase` still describe the
previous task. That is deliberate: the order is intent, the tick is action.

A task is complete when its body calls `finishTask` (promote the queue, or idle).
`finishTask` never touches reservations — `giveTask` and `releaseReservations` own
those, because a *replaced* task must drop its claim while a *completed* one has
already spent it.

### Goal / phase legal pairs

| `goal` | legal `phase` | entered by |
|---|---|---|
| `idle` | `idle`, `charging`, `disabled` | initial state, `finishTask`, `stopRover`, a completed rescue |
| `move` | `moving` | `doMoveTo` |
| `mine` | `moving`, `working` | `doMine` (the walk out reuses the task's own goal) |
| `toDepot` → | `moving` | `beginUnload` |
| `toCharge` / `charge` | `moving` / `charging` | `doRecharge`, a storm recall |
| `toSite` / `build` | `moving` / `working` | `ConstructionSystem.build` |
| `toService` / `service` | `moving` / `working` | `doService` |
| `toSalvage` / `salvage` | `moving` / `working` | `doSalvage` |
| `toRecover` / `recover` | `moving` / `working` | `doRecover` |

Each `toX`/`x` pair is a travel/arrived pair, and every pair is written by exactly
one transition function (`enterTravel`, `enterWork`, `enterCharge`, `enterIdle`,
`enterDisabled`). `mine` is the exception with two legal phases because there is no
`toMine`. `tests/sim/rover-state.test.ts` and `checkRoverExecution()` are this
table's executable form.

## Haul routes

A `mine` task can set `repeat`, becoming a route that loops the seam and parks at
the depot only while the target silo is full — resuming the instant consumption
frees **60 kg** (`ROUTE_RESUME_ROOM_KG`). A route is a *standing order*, not a
poll: the rover holds position rather than driving back and forth burning charge.

## Automation rules (per rover, player-authored)

| Rule | Behaviour |
|---|---|
| **auto-haul** | fetch what the build queue is short of, keeping a standing ice order weighted by how thin the water reserve is |
| **auto maintenance** | accept repair and panel-cleaning dispatches |
| **storm sheltering** | recall to shelter when local intensity says so |
| **auto-rescue** | answer a stranded rover |
| **charge floor** (10–60%) | recall before the ride home gets expensive |

Auto dispatch is **energy-aware**: it only sends a rover to a seam it can reach,
dig a worthwhile load from, *and get home from*, keeping enough battery for the
return leg. Construction outranks hauling (TDD §8), so a stocked site always gets
a builder. **Your explicit orders always win** over any automation or reservation.

## Seam reservations

Dispatch reserves deposits so the fleet spreads instead of dogpiling:

- auto runs **prefer unclaimed** seams,
- **rich** seams may be **shared** (a second rover on a fat iron seam is fine),
- a worked-out scrap heap is never worth a reservation,
- and no rover idles merely because its nearest seam is held.

A **player order outranks any reservation.**

## Wear, stranding and recovery

Tool work, driving and exposed storms grind drivetrain condition. Below **45%** a
rover works progressively slower — never below half rate. **Rovers fail soft**: a
worn machine is a slow machine, not a lost one.

A battery-flat rover **strands**: it goes dark and flashes a **yellow strobe**.
Select another rover and tap it to `recover` — the rescuer transfers just enough
charge for the ride home, not a full pack. The garage bay then services parked
rovers back to 100%.

Installed motors and circuit boards wear *separately* from condition and are
replaced at a **Repair Bay**, which a garage cannot do. See
[Maintenance and Repairs](Maintenance-and-Repairs.md).

## Position lights

Every rover carries headlights and a rear strobe so it stays visible at night and
in blowing dust. The sim switches them on automatically when the sun drops or
visibility closes in, and **bills the rover's own battery** for it
(0.5–0.9 kW per kind). A fleet left lit through a long night pays a real energy
toll, and a parked rover can theoretically drain itself flat; the per-rover switch
in the inspector can run a rover dark to save power. A stranded rover's headlights
die with its battery — the reserve-powered strobe keeps flashing to mark the wreck.

## Proximity: rovers crawl near obstacles

Movement measures **hull clearance** (centre distance minus both radii), not
centre-to-centre, against anything it can hit — other rovers, buildings, the
landing pod, discovered non-buried sites:

| Context | Bubble | Speed inside it |
|---|---|---|
| Open country | 1.5 m (≈5 ft) | **28%** |
| Colony yard | 3.0 m | **15%** |

The drop is immediate, not a ramp, and never zero — a nose-to-nose pair keeps
inching, so nothing can deadlock. Move power scales with the multiplier, so
slowing down is a brake rather than a battery tax. The rover's **current
destination is exempt** once inside arrival reach, or a builder crawling up to its
own site would never finish.

Still out of scope, on purpose: collision physics (rovers never shove each
other), re-pathing around an obstacle, and per-part failures.

## The garage

A **Rover Garage** (3 kW idle, tier 2, 30 kg steel) does three jobs at once:

- **fast-charge** at 32 kW — twice the pod's 16 kW, which halves fleet downtime;
- **service** parked rovers' drivetrains back to 100% (routine condition only —
  it cannot replace installed parts);
- **assemble** utility, mining and cargo rovers from stockpiled metal *and*
  components, spending both ledgers or refusing with the missing part named.

Each garage holds **one assembly/refit reservation** at a time, and a parked
rover must sit within the garage radius **+5 m**.

## Materials flow without a rover parked on them

Construction sites accumulate **Materials Reserved** mass while a rover is off
fetching iron — TDD §7's staged pipeline — and cancelling a site refunds
everything already delivered. That is why "a stocked site always gets a builder"
is a scheduling statement, not a logistics one.

## Related

- [Simulation Systems](Simulation-Systems.md) — where `RoverSystem` sits in the tick
- [World Generation](World-Generation.md) — the nav grid and A* the rovers drive on
- [Blueprint Reference](Blueprint-Reference.md) — per-kind cargo, battery, speeds
