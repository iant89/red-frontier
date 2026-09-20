> ← [Home](Home.md)

# Glossary

Words this project uses in a specific sense. Where a term maps to code, the file is
named so you can read the definition where it is enforced.

| Term | Meaning | Where |
|---|---|---|
| **Advance** | the one `advance{dt}` message a host receives per delivered frame. Both transports are stepped by the *client* — never by a timer in the worker | `src/sim/host/` |
| **Autopause** | a player setting that pauses the colony when a new **critical** condition is raised | settings, `src/ui/Settings.ts` |
| **Auto-haul / auto-rescue / storm sheltering** | per-rover automation rules the player authors; they lose to any explicit order | `src/sim/systems/FleetAutomationSystem.ts` |
| **Bench** | a Workshop's unfinished component fraction. It lives on the *building* (`Building.craft`), never on the component ledger | `src/sim/systems/ComponentSystem.ts` |
| **Brownout** | a tier served below `BROWNOUT_THRESHOLD = 0.995`. Degrades **evenly within a tier** — "Industry at 62%" | `src/sim/power.ts` |
| **Burial clock** | the 3-sol countdown on an Earth drop, run up to 3× faster by a storm. A buried container is gone | `src/sim/systems/ExplorationSystem.ts` |
| **Cadence** | the weather re-roll period: **84 game seconds**, with a 96 s gap after a storm and no storms before sol 2.2 | `src/sim/config.ts` |
| **Claim** | the playable square: `±world.half` per world size (840 m → 2.56 km) | `src/sim/World.ts` |
| **Command** (`SimCommand`) | the *only* legal write into a colony, as plain serializable data. Player intent and dev backdoors are separate command families | `src/sim/host/protocol.ts` |
| **Commissioning** | the permanent act of switching a colony from shared water plumbing to local tanks and paid pipe topology | `src/sim/systems/WaterSystem.ts` |
| **Condition** | a rover's drivetrain health (0–100), restored by a Garage service. Distinct from **installed part health** | `src/sim/state/RoverState.ts` |
| **Cue** | the short audio confirmation attached to a command. `COMMAND_CUES` is exhaustive, so a new command without a cue is a type error | `src/audio/AudioSystem.ts` |
| **Domain event** | a per-tick, structured, serializable record (`building/placed`). **Not** a pub/sub bus, and **not** the alert channel | `src/sim/domainEvents.ts` |
| **EVA** | a colonist walk on a finite suit reserve. The sim refuses walks it knows cannot survive, and all of them in a storm | `src/sim/systems/LifeSupportSystem.ts` |
| **Exposure** | a blueprint's 0–1 storm vulnerability. An open solar array is 1.0; a nose-down RTG is 0.15 | `src/sim/defs.ts` |
| **Fabrication** | a dev-mode spawn. It becomes a first-class sim object **and is saved** — unlike dev *modifiers* | `src/sim/DevBackdoors.ts` |
| **Field (weather)** | storms as spatial systems sampled per entity: `localIntensity(x, z)`, `localDust(x, z)`. Weather is a place, not a mood | `src/sim/weather.ts` |
| **Floor** | the soft-failure guarantee: a rover at zero condition or zero part health still works at **half rate** | `src/sim/systems/RoverSystem.ts` |
| **Haul route** | a `mine` task with `repeat` set: loops a seam and parks at the depot only while the target silo is full, resuming at 60 kg of headroom | `src/sim/config.ts` (`ROUTE_RESUME_ROOM_KG`) |
| **Hull clearance** | centre distance **minus both radii** — the measure rover proximity uses, so a bubble is outside the chassis rather than inside it | `src/sim/config.ts` |
| **Idle reason** | why a line is not producing right now (ore supply, rack full, silo full, power). Named per cause so the HUD can say which | `src/sim/systems/ProductionSystem.ts` |
| **Ledger** | one of two inventories: the **bulk** kg ledger (`LogisticsSystem`) and the **counted** component-unit ledger (`ComponentSystem`) | `src/sim/systems/` |
| **Levels (dev `level`)** | runtime-only Mk 1–5 upgrade overlays at +35% per mark. Deliberately omitted from `snapshot()` | `src/dev/DevMode.ts` |
| **Material flow** | anything authored in **game seconds**: mining kg/s, build seconds | `src/sim/config.ts` |
| **Mars time** | anything authored in real sols: kW·h per Mars hour, kg per sol. Bridged by `HOURS_PER_SEC` / `SOLS_PER_SEC` | `src/sim/config.ts` |
| **Overlay (host)** | a runtime edit expressed as *data* — a name plus entity ids — because you cannot hand a closure to a worker | `src/sim/host/overlays.ts` |
| **Origin** | `mined` (has seams) vs `refined` (made by a building). Steel has no seam, so it can never be dug or surveyed in | `src/sim/defs.ts` |
| **Pod** | the descent stage: 14 kW RTG, 90 kWh, 2 kW of its own tier-0 support, 16 kW rover charging, 8 m exclusion radius. Not a blueprint | `src/sim/config.ts` |
| **Process** | a building's conversion, authored as `solidIn` / `fluidIn` / `fluidOut` / `solidOut` / `componentOut`. A process **earns its output**: bounded by the input that actually arrived | `src/sim/defs.ts` |
| **Rack** | component **slots** on a building — capacity counted in units, not kg. The Workshop has 24; the pod has none | `src/sim/systems/ComponentSystem.ts` |
| **Reservation** | a claim on a seam (logistics) or on a Garage's single assembly/refit bay | `src/sim/systems/` |
| **Seam** | a deposit of *mined* material on the planet | `src/sim/World.ts` |
| **Site** | a POI (wreck, cave, cache…) **or** an in-progress construction, depending on the sentence. Context usually disambiguates | `src/sim/pois.ts`, `src/sim/systems/ConstructionSystem.ts` |
| **Silo** | per-resource storage. Base 260 kg; warehouses add 600 kg each; the Refinery adds 150 kg to every resource, including steel | `src/sim/systems/LogisticsSystem.ts` |
| **Sol** | 24 h 39 m 35 s of Mars time = **240 game seconds** at 1× (≈4 real minutes) | `src/sim/clock.ts` |
| **State hash** | `rf1-<14hex>-<14hex>` over canonical JSON of **live** state (sorted keys, entities sorted by id). Turns "did this change behaviour?" into a string comparison | `src/sim/debug/StateHash.ts` |
| **Stranded** | a rover at `ROVER_DISABLED_THRESHOLD` (1% battery): dark, flashing a reserve-powered **yellow strobe**, jump-startable | `src/sim/systems/RoverSystem.ts` |
| **Tick order** | the authoritative sequence of systems inside one 50 ms step. **Load-bearing** — reorder only with intent | `src/sim/Simulation.ts` |
| **Tier** | two uses: power priority **0–3** (shed from the bottom up), and upgrade **tier 1–3** (`MAX_UPGRADE_TIER`) | `src/sim/config.ts`, `src/sim/engineering/upgrades.ts` |
| **Transcript** | a colony expressed as seed + difficulty + world options + timed commands, replayable against pinned hashes | `src/sim/debug/Transcript.ts` |
| **View** (`SimView`) | the immutable read model every consumer renders from. It has no mutators, by type | `src/sim/host/view.ts` |
| **Wear** | condition and installed-part health lost to driving, tool work and unsheltered storms | `src/sim/systems/MaintenanceSystem.ts` |
| **Worker / in-process host** | the two `SimHost` transports: `WorkerSimHost` (default) and `LocalSimHost` (`?worker=0`) | `src/sim/host/createHost.ts` |

## Doc-level vocabulary

The project uses a deliberately small status alphabet everywhere — GDD, TDD, the
wiki:

| Tag | Meaning |
|---|---|
| **IN** | shipped and gated by tests / playable in the build |
| **PARTIAL** | present in reduced form; design depth still open |
| **OUT** | not in `src/` yet — still a design commitment |

**Slice** = a vertical piece of gameplay shipped end-to-end with tests (e.g. "P5
slice 2 — manufacturing"). **Phase** = a step of the completed 30-phase refactor
roadmap, referenced as "Phase 18", "Phase 22"… in code comments and in
`mnemosyne.md`. **Realignment** = a commit that re-sweeps the design docs against
the tree, restating status, test counts and save version.

## Related

- [Roadmap and Status](Roadmap-and-Status.md) · [Architecture Overview](Architecture-Overview.md)
