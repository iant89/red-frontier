> ← [Home](Home.md)

# Water Networks

The fourth engineering slice moved water from *"a colony-wide pool"* to
**commissioned plumbing**: pipes, a pump, local tanks, and a one-way decision that
never strands an old save.

## The default is still shared plumbing

Existing and new colonies keep a **temporary shared reserve** until you explicitly
commission a network. No colony loses its supply just because the game was
upgraded — the migration is opt-in per colony, which is why the panel explains every
unmet condition instead of silently failing.

## Four steps

1. **Manufacture Water Pipes** on the Workshop's pipe line (1 kg steel → 2 sections
   per Mars hour). Each section spans **20 m** (rounded up), and a direct link can
   reach **200 m**.
2. **Build a Pump Station** — 6 kW, **tier 1**, 20 kg water buffer, priced
   20 regolith · 15 iron · 6 silica · 10 steel.
3. **Lay pipe.** Select any online water building, open its **Water network**
   panel, choose a destination and *Lay pipe*. Junctions can be any water port —
   including the **Landing Pod**, which is a destination too.
4. **Commission network.** Connect **every** online water port — the pod, each
   enabled extractor, each powered pump — keep some water in reserve, then click
   *Commission network*. **This is permanent.** The existing reserve is distributed
   across local tanks without losing water; new structures start empty and need
   their own pipes.

## How flow works

- A powered pump moves up to **6 kg per Mars hour**, scaled by supplied power,
  within its connected component.
- Pumps **balance tank fill fractions**, sharing flow among consumers rather than
  letting the first port monopolise the line.
- **Local reserves stay usable during a blackout or disconnection**, but a
  disconnected tank cannot share water — it drains to empty on its own.
- Indoor drinking and reclamation use the **shelter tank**; EVA provisions still
  debit the pod in this slice.
- **Oxygen and food remain pooled.** This slice is about water only.

The oxygenator carries its own 10 kg water buffer so a short brownout does not
unpressurise the colony.

## Reading the network

Cycle overlays with `V` to the **Water overlay**: pipe routes, **directional flow
beads**, and **amber diamonds** at ports that need attention. The inspector
distinguishes the four real reasons a port is unhappy —

| Inspector state | Meaning |
|---|---|
| **Not connected** | no paid pipe topology reaches this port |
| **No pump power** | connected, but the pump is offline or browns out |
| **No water** | connected and powered, upstream buffer empty |
| *Waiting for pumped supply* | connected, flow coming, tank still filling |

— alongside the actual local buffer and the measured kg/h flow.

## Breaking it

| Action | Result |
|---|---|
| Disconnect a link | salvages **half** the sections, rounded down, limited by rack space |
| Demolish a building | removes incident pipes, **no salvage** |
| Damage or demolish a tank | that tank's water is lost — **not** the colony's reserve |

## Out of scope in this slice

Pressure, leaks, valves, trench routing, and **oxygen networks**. Heat and data
networks are further out still. The infrastructure-overlay set (`none / power /
life / water / weather`) reflects exactly what is simulated — there is no overlay
for a system that does not exist.

## Where the code lives

| Concern | Source |
|---|---|
| Topology, commissioning, flow | `src/sim/systems/WaterSystem.ts`, `src/sim/utilities/WaterNetwork.ts` |
| Network state | `src/sim/state/WaterState.ts` |
| Save fields | `src/sim/persistence/WaterPersistence.ts` |
| Overlay rendering | `src/render/WaterNetworkOverlay.ts` |
| Panel | `src/ui/WaterPanel.ts` |
| Siting and port rules | `src/sim/rules.ts` |

Save **v12** preserves commissioned tanks and paid topology; **v3–v11 saves
migrate safely into shared-plumbing mode**. Covered by `tests/sim/water.test.ts`,
`tests/hud/water.test.ts` and `scripts/water-smoke.mjs`.

## Related

- [Power and Life Support](Power-and-Life-Support.md)
- [Industry and Manufacturing](Industry-and-Manufacturing.md)
