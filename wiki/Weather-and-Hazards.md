> ← [Home](Home.md)

# Weather and Hazards

**Storms are places, not moods.** Each storm is a circular weather *system* with a
kilometre-scale footprint that forms, travels along a heading, and dies on a
ramp–hold–decay envelope. The colony reads whatever system happens to be overhead,
so a storm *arrives*, *passes over*, and *moves on*.

Implementation: [`src/sim/weather.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/weather.ts)
(data + pure maths) and
[`src/sim/systems/WeatherSystem.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/systems/WeatherSystem.ts)
(progression and consequences).

## Cadence and classes

Weather is re-rolled every **84 game seconds** (≈0.35 sol), with a **96 s**
cooldown between storms and no storm before **2.2 sols** — you land in clear
weather.

| Class | Per-roll chance | Unlocks | Storm factor for lightning |
|---|---|---|---|
| Dust devil | 10% | sol 3 | 0.5 |
| Regional storm | 4.5% | sol 4 | 1.0 |
| Severe storm | 1.2% | sol 7 | 1.7 |
| Planetary dust event | 0.6% (grows each sol after) | sol 12 | 2.3 |

Difficulty multiplies the roll (Settler 0.55×, Pioneer 1×, Survivor 1.5×) and the
damage separately (0.6× / 1× / 1.4×).

## The field

`localIntensity(x, z)` and `localDust(x, z)` sample the storm footprint at a
position plus a fine seeded noise term, and **every** weather decision has an
`…At(x, z)` form evaluated at the entity:

- should this rover shelter
- can this colonist walk
- what is this structure's work-rate penalty
- how fast is this array being buried and this hull damaged

That is why a rover 20 m from the pad can be in comparatively clear air while the
colony is hammered — and why the HUD weather cell, the forecast and the alerts all
agree: they read the same field, not three separate numbers.

## What dust does

| Effect | Model |
|---|---|
| Solar output | irradiance × dust transmission, so a storm is a power event first |
| Panel soiling | airborne dust accumulates as *cleanliness* loss on exposed arrays; `exposure` per blueprint (an open array is 1.0, a nose-down RTG 0.15) |
| Structural damage | `STORM_DAMAGE_K = 0.38` scaled by exposure, local intensity and `damageMul` |
| Visibility | drives fog, the particle field, headlights and the audio mix |
| Rover work | work-rate multiplier from local dust, the same one that governs mining |

Cleaning and repair are rover tasks; **auto maintenance** will answer them for
you if you enable the rule on that rover.

## Lightning

Airborne dust is the charge source, so **calm clear air never strikes**. Gates:
dust ≥ `0.15` **and** local intensity ≥ `0.15`.

| Lever | Value |
|---|---|
| Base rate | 0.06 strikes / game-s at full hazard |
| Dust scaling | `dust^1.6` |
| Storm factor | devil 0.5 · regional 1.0 · severe 1.7 · planetary 2.3 |
| Difficulty | Settler 0.6 · Pioneer 1.0 · Survivor 1.5 |
| Aim | 25% of strikes target a weighted anchor (exposure × vulnerability: solar 1.9, battery and oxygenator 1.5, workshop 1.3), jittered ±9 m; the rest land anywhere in the claim |
| Damage radius | 24 m, falling off with distance |
| Core radius | 10 m — inside it a struck rover also loses 35% of its pack |

Effects within the radius: `16 × exposure × vulnerability × falloff × damageMul`
health to a structure (≤25 health trips it offline), **18% drivetrain condition**
to a rover, and **30 health** to a colonist on EVA — which can end the mission.

Lightning runs on its **own seeded RNG stream** (`weather.lightningRoll`), so a
strike never perturbs a weather roll and a forced dev strike never moves the sky.
That stream is part of the save, which is what makes a storm replayable.

> **Design rule:** a bolt bruises and can trip a structure offline. It does not
> delete the colony. Soft failure applies to the sky as much as to a flat battery.

## Forecasting

**60 game seconds** of warning by default (`STORM_WARN_LEAD_S`), **×2.25** with a
powered **Weather Radar Station** — a 10 kW, tier-2 blueprint that costs 25 kg of
steel, builds a 520 km live polarimetric scope, and puts storm cells *and their
predicted tracks* on the world map. That multiplier is the whole reason the radar
exists: 60 s is enough to react, 135 s is enough to *plan*.

Storm-prep levers that work today: charge batteries, shelter rovers (the per-rover
auto rule), clean the arrays, re-check power priorities, and keep a garage-serviced
fleet out of the open when the sky is electric.

## Dust devils as an ecology (presentation)

The sim owns the devil *storm class*; the wandering vortices you see live in the
renderer's particle layer. Counts are rolled per storm class and intensity band
(0–4, held for 2 s so a storm hovering on a boundary does not strobe), each devil
draws its own size, spin, wander frequencies and wind bias, and pairs interact on
contact — mutual cancellation, orbit-then-die, consume-and-grow, or a twin
co-orbit that splits. A sharp wind ramp (d(wind)/dt above 0.35 m/s²) banks charge
and spins one up out of clear air. At most 5 exist at once, and the worst measured
case spends 6 155 of the 9 000-mote pool.

The FX read the sim and never write it, and they animate on **sim time** — so a
pause freezes the devils while the wind keeps sounding.

## Developer controls

Force or clear any storm class (including planetary), switch the scheduler off to
fly the sky by hand, set airborne dust directly, and drop a bolt exactly on the
most exposed thing standing (`aim='exact'`: no jitter, no RNG — reproducible by
design). See [Developer Mode](Developer-Mode.md).

> One trap: a `dev/time` jump leaves `weather.time` behind, so a conjured storm's
> envelope does not follow the calendar. For screenshots, **force the storm and
> run at 4×** rather than time-travelling.

## Related

- [Rover Logistics](Rover-Logistics.md) — sheltering, wear, lights
- [Power and Life Support](Power-and-Life-Support.md) — what a dim sun costs
- [Rendering and Audio](Rendering-and-Audio.md) — the flash and the thunder
