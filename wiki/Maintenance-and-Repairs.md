> ← [Home](Home.md)

# Maintenance and Repairs

Two maintenance ledgers that are easy to confuse, one building that tells them
apart, and one rule: **a worn machine is a slow machine, never a lost one.**

## Condition vs part health

| | **Drivetrain condition** | **Installed part health** |
|---|---|---|
| What it models | routine wear on the drive package | motors and circuit boards as installed units |
| Worn by | driving, tool work, exposed storms | the same, at per-part rates (`PART_MOTOR_WEAR_STORM 0.02`, `PART_BOARD_WEAR_STORM 0.03`) |
| Slowdown | below **45%**, progressively, floored at half rate | below **45%**, the *weakest* part applies, floored at half rate |
| Alert | condition below `ROVER_CONDITION_ALERT = 35` | below **35%**, naming the Repair Bay and the spare cost |
| Restored by | **Rover Garage** service (back to 100%) | **Repair Bay** replacement (a garage *cannot* do this) |
| Also | — | structural building health and solar cleanliness, which stay unchanged and never need parts |

The floor is the design point: **even at zero the rover retains half rate**, so a
colony can always rebuild its supply chain. Nothing in this game can strand you
permanently through wear.

## Repair Bay

| | |
|---|---|
| Cost | 30 regolith · 18 iron · 12 aluminum · 10 silica · **20 steel** |
| Build | 38 s |
| Power | **8 kW active / 1 kW idle**, tier 2 (industry) |
| Reach | park a rover within **12 m** of the building centre |
| Eligibility | an installed motor or board at **≤70%** health |
| Job | **12 game seconds at full power**, one matching spare from the Workshop rack, spent on completion |
| Concurrency | one bay, one rover, one part at a time |

- A **brownout slows** work; **missing stock pauses** it — and the inspector says
  which.
- A **funded** repair keeps idle automation from taking the rover away. New player
  orders and emergency charging still win. If the rack is short, use **Wait 1m** to
  hold a customer while the Workshop catches up.
- **Leaving cancels** unfinished work without spending a part.
- Save/load preserves completed wear and in-progress jobs; colonies older than
  **v11** load with healthy parts, because a planet that had nothing on it is not a
  corrupted save.

## Structures: health and cleanliness

Buildings carry `health` and `cleanliness`, both driven by
[`src/sim/rules.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/rules.ts)
`maintenanceNeed()` and shared with the siting verdicts:

| Cause | Effect | Fix |
|---|---|---|
| Airborne dust | soiling → panel output loss | `clean` order (auto-maintenance will take it) |
| Storm exposure | damage scaled by per-blueprint `exposure` × `damageMul` | `repair` order |
| Lightning within 24 m | `16 × exposure × vulnerability × falloff × damageMul` health; **≤25 health trips a structure offline** | repair, then check what you were relying on |

Solar cleaning and structural building repair deliberately **do not require
manufactured parts** — recovery must be possible before the industrial chain exists.

## Demolition and refunds

| Action | Refund |
|---|---|
| Cancel a build site | everything already delivered goes back |
| Disconnect a water pipe | half the sections, rounded down, limited by rack space |
| Demolish a building | removes incident pipes **without** salvage; that tank's water is lost, not the colony's |
| Demolish a Garage | cancels its customers' refit jobs |
| Demolish an upgraded building | loses its unfinished refit |

## Out of scope, on purpose

- **Building-specific component wear** — this slice covers rover motors and boards,
  not every machine in the colony. A Workshop does not have a motor to replace.
- Wheel / motor / sensor failures as distinct systems on rovers.
- Part *inventory* beyond the rack: there is no warehouse shelf for a spare motor,
  only rack slots.

## Regression coverage

`tests/sim/maintenance.test.ts`, `tests/hud/maintenance.test.ts`, and
`node scripts/maintenance-smoke.mjs` against a served build (both transports —
run `node scripts/setup-playwright.mjs` first). See
[Testing and QA](Testing-and-QA.md).

## Related

- [Rover Logistics](Rover-Logistics.md) — condition, stranding, garage servicing
- [Industry and Manufacturing](Industry-and-Manufacturing.md) — where spares come from
- [Weather and Hazards](Weather-and-Hazards.md) — what does the wearing
