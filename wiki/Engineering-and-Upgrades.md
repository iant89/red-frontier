> ← [Home](Home.md)

# Engineering and Upgrades

Right-click (desktop) or long-press (touch) any rover or building to open
**Engineering**: a rotating model plus **Overview / Upgrades / Appearance /
Actions**. The colony pauses while you browse and closing restores the previous
speed, including an already-paused game. On phones the model and controls stack and
scroll.

All 15 buildable structure types have appropriate upgrades, and every rover kind
has its own set. This page is the model behind them — implementation in
[`src/sim/engineering/upgrades.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/engineering/upgrades.ts),
driven by `UpgradeSystem`.

## Three permanent ledgers, and what each one is not

| Ledger | Field | Persistent? | What it means |
|---|---|---|---|
| **Upgrade tiers** | `upgrades` (0–3 per upgrade id) | **yes** (v13) | the player's engineering, paid for and installed |
| **In-flight job** | `upgradeJob` | **yes** | a funded installation with timed progress |
| **Paint** | `paint` | **yes** | a finish choice; cosmetic only |
| *Developer level* | `level` | **no** | runtime-only Mk 1–5 overlays, `+35%` per mark |

> **Authoritative player refits use `upgrades` and `upgradeJob`, never the
> developer-only `level`.** `snapshot()` deliberately omits `level` and
> `restore()` defaults it back to 1 — that separation is what lets the dev panel
> do anything it likes without ever contaminating a save. See
> [Developer Mode](Developer-Mode.md).

## Rover upgrades

| System | Gain per tier | Install |
|---|---|---|
| Drivetrain | **+20% cruise speed**; drive power rises 8% per tier | Powered Garage |
| Batteries | **+35% base energy capacity**; added capacity starts empty | Powered Garage |
| Cargo frame | **+40% base cargo capacity** | Powered Garage |
| Miner teeth | **+30% mining rate**, mining rovers only | Powered Garage |

Base prices at tier 1 — and everything **scales linearly with the tier**, so a
tier-3 drivetrain costs 3× the steel, 3× the parts and 3× the seconds
(`upgradePrice(id, tier)`):

| Upgrade | Materials at tier 1 | Parts at tier 1 | Seconds |
|---|---|---|---|
| Drivetrain | 60 alu · 20 steel | 2 motors · 1 board | 20 |
| Battery | 40 alu · 10 steel | 2 packs · 1 board | 24 |
| Cargo frame | 100 alu · 30 steel | 2 frames · 1 motor | 24 |
| Drill teeth | 30 steel · 20 iron | 2 teeth · 1 motor | 20 |

Note the interaction with wear: a drivetrain upgrade raises *base* speed, and
installed motor health still multiplies the work rate. Chrome does not make a
neglected rover fast.

## Building upgrades

Which upgrades a blueprint offers is **derived from its data**, not hand-listed —
so a new production building gets the right buttons for free:

| Upgrade | Offered to | Gain per tier |
|---|---|---|
| Production | any building with a `process` (plus the Workshop) | +25% |
| Generation | `powerProduceKw > 0` (solar, RTG) | +25% |
| Storage | battery, bulk storage, fluid capacity or rack slots | +40% |
| Service | Garage, Repair Bay | +25% |
| Pump throughput | Pump Station | +30% |
| Radar range | Weather Radar Station | +25% |
| Power efficiency | anything that draws power | **−12% of the original rating** per tier, active *and* idle |

`efficiency` is a *negative* gain on purpose: it reduces `powerDrawKw` and
`idlePowerKw` by 12% of the blueprint rating per tier, which is how a tier-3
Refinery becomes survivable on a solar-only afternoon.

## The installation flow

1. **Manufacture the components at the Workshop** — including Battery Packs, Cargo
   Frames and Drill Teeth alongside motors, boards and pipes.
2. **Park and stop** a rover beside a Garage (within its radius **+5 m**), or choose
   a completed, repaired building. Each Garage holds **one** assembly/refit
   reservation at a time.
3. **Compare** current → upgraded stats against illustrated material and component
   costs. Shortages are marked; unfunded installations cannot be queued.
4. **Queue the installation**, then close Engineering. Payment happens **once, when
   queued**; timed progress then begins and resumes with the colony. Leaving the
   bay, damage or power loss **pauses** a rover job; on-site builders handle
   building work.

Cancelling a refit recovers its materials **up to available storage capacity**
(excess is discarded). Demolishing a Garage cancels its customers' jobs;
demolishing an upgraded building loses its unfinished refit. Paid progress
survives saves.

## Appearance

**Eight free finishes plus the factory finish**, in a palette defined in code
(`PAINTS`). Try one on the preview, then **Apply finish** to paint the real rover
or building and save it. Mechanical details and glass keep their own finishes.

This slice changes **stats and paint**, not attachment geometry or
interchangeable module loadouts — that is deliberate, and the GLB pipeline
already reserves the room for it (see
[Rendering and Audio](Rendering-and-Audio.md#the-glb-asset-pipeline)).

## What is saved, and how old colonies are treated

Save **v13** carries supported permanent tiers, funded timed jobs and palette paint
per rover and building. Restore **sanitises**: allowed tiers, the next-tier job and
unique Garage reservations are validated, and three new component keys with bench
fractions default to zero. Older colonies migrate to **stock hardware** without
charging or granting anything — the same rule every migration step follows.

## Tests

`scripts/engineering-smoke.mjs` covers both transports, actual desktop **and**
touch gestures, paused model rotation, icons, paint and paid installation across
save/load. `tests/sim/engineering.test.ts` and `tests/hud/engineering.test.ts` pin
the model. Reduced-motion preferences disable the automatic model spin.

## Related

- [Industry and Manufacturing](Industry-and-Manufacturing.md)
- [Maintenance and Repairs](Maintenance-and-Repairs.md)
- [Blueprint Reference](Blueprint-Reference.md)
