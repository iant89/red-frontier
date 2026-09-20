> ← [Home](Home.md)

# Power and Life Support

Two systems that share one design commitment: **degrade evenly and explain
yourself**, rather than fail arbitrarily and stay quiet.

## The power grid

[`src/sim/power.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/power.ts)
is a **pure resolver**: hand it generation, storage and ranked demands, get back
what each tier actually received. It knows nothing about buildings, rovers or the
world — which is what makes the whole grid unit-testable and keeps `Simulation`
readable.

### Allocation rule

1. Generation is spent first.
2. Loads are served **strictly by tier** — 0 Life support, 1 Oxygen & water,
   2 Industry, 3 Logistics — with batteries as the buffer of last resort.
3. **Within a tier every consumer is satisfied by the same fraction.** A brownout
   therefore degrades a tier evenly instead of picking arbitrary winners: the HUD
   reads *"Industry at 62%"* rather than *"some of your machines stopped"*.
4. Only genuine surplus goes back into charging.

`BROWNOUT_THRESHOLD = 0.995` — below that satisfaction a tier counts as browned
out, which is what the alerts and the audio warning key off.

| Tier | Label | Typical members |
|---|---|---|
| 0 | Life support | Habitat, the pod's own scrubbers and heaters |
| 1 | Oxygen & water | Extractor, oxygenator, greenhouse, pump stations, water tanks |
| 2 | Industry | Refinery, Workshop, Garage, Repair Bay, Warehouse, Radar Station |
| 3 | Logistics | Solar arrays, battery banks, RTG arrays |

Tier 3 is *shed first*, which is why production outages read as a supply problem
downstream rather than a mystery.

### Generation

- **Solar Array** — 28 kW peak, output tracks the authoritative `SunState` and
  is multiplied by dust transmission. Panels physically tilt to follow the sun.
  `HORIZON_EXTINCTION = 0.08`: at a Mars sunrise a panel already makes 8% of peak,
  because the atmosphere is thin but dusty.
- **RTG Array** — 5 kW baseload, and the descent stage's own 14 kW RTG. No storm
  dims either; the RTG is the answer to "the sky is at war with my array".
- **Battery Bank** — 200 kWh each (the pod carries 90 kWh). Batteries buffer the
  night; a colony that cannot survive darkness has a battery problem, not a solar
  problem.

`SunState` is the **single authoritative sun** (TDD §12): solar generation,
greenhouse growth, sky colour, shadow direction and the panel tilt all read the
same value, so a render can never disagree with a production number.

## The sol

[`src/sim/clock.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/clock.ts)
compresses a real Mars day — 24 h 39 m 35 s, `SOL_HOURS = 24.6597` — into
**240 game seconds** at 1×. Sunrise and sunset sit at sol fractions **0.25** and
**0.75**; a mission starts at **0.34** so you get a full day of light before your
first night.

Energy and life support are authored in **Mars time** (kW·h per Mars hour, kg per
sol) so the numbers read like engineering figures; mining and construction are
paced in **game seconds** so they feel like a game. `HOURS_PER_SEC` and
`SOLS_PER_SEC` are the only two bridges, and both live in `config.ts`.

## Life support

[`src/sim/lifesupport.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/lifesupport.ts)
keeps fluids (water, oxygen, food) in **tanks provided by buildings**, entirely
separate from the bulk solids rovers haul. That separation is the reason a rover
can never "accidentally" deliver breathable air.

| Need | Colonist rate | Kills you in |
|---|---|---|
| Oxygen | 0.84 kg/sol | hours |
| Water | 4 kg/sol | days |
| Food | 1.5 kg/sol | weeks |

…so build in that order. The *empty in…* estimates in the left rail are the real
deadline, computed from the live draw rather than a static guess.

### The chain

```
ice seam → rover hauls → Water Extractor (18 kW, tier 1)
                             1.4 kg ice → 1.15 kg water per Mars hour
                                 ↓
             Oxygen Generator (12 kW)  0.14 kg water → 0.125 kg O₂ / h
                                 ↓
                        Greenhouse (8 kW)  0.42 kg water + light → 0.17 kg food / h
                                 ↓
                        Habitat (5 kW, tier 0) — reclaims 55% of the water used
```

- `WATER_RECLAIM_FRACTION = 0.55` — the Habitat is a water system, not a bedroom.
- The **oxygenator holds a 10 kg water buffer** and the extractor 120 kg; the
  greenhouse holds 60 kg of water and 80 kg of food.
- A **process earns its output**: conversion is bounded by the input that actually
  arrived in the tick, so two lines drawing on one silo split the ore instead of
  both smelting a full rate. This closed a mass-from-nothing edge that pre-dated
  steel.
- Indoor drinking and reclamation use the shelter's tank once a **water network is
  commissioned** (see [Water Networks](Water-Networks.md)); before that, the pool
  is shared.

### EVAs

Select the colonist and right-click (or long-press) to walk. The suit carries a
finite O₂ reserve and the sim **refuses a walk it knows they cannot survive** —
and refuses all of them when the local storm intensity says it should. Going
outside also exposes them to a bolt: lightning inside the strike radius does 30
health to a colonist on EVA, which can end the mission.

Health is checked by `FailureSystem`, which raises the mission-end event; a dead
colonist is the game-over condition and the *only* hard loss. Everything else in
this game is recoverable.

## Alerts you will actually see

| Message | Reading |
|---|---|
| *Industry at 62%* | Brownout in tier 2 — shed something or store more |
| *Batteries at 0%* | You are running on generation alone; a night or a storm ends the colony |
| *Water reserve thin* | Auto-haul keeps a standing ice order weighted by how thin it is |
| *Steel silo full* | The Refinery is idle by capacity, not by shortage |

Conditions that are **currently true** are raised once and cleared once; things
that **happened** stream to the log. That separation (
[`src/sim/alerts.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/alerts.ts))
is what stops a brownout producing 200 identical lines. Severity is
`crit · warn · info · opportunity · ok`, and every alert carries an icon *and*
text — colour is never the only channel.

## Related

- [Weather and Hazards](Weather-and-Hazards.md) — what takes the sun away
- [Water Networks](Water-Networks.md) — commissioning local tanks
- [Blueprint Reference](Blueprint-Reference.md) — every kW and kg number
