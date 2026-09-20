> ← [Home](Home.md)

# Host and Worker Protocol

The host is the only way into the colony. This page is the practical version of
[`TDD §16`](https://github.com/iant89/red-frontier/blob/main/docs/design/TDD.md);
the schema-of-record is
[`src/sim/host/protocol.ts`](https://github.com/iant89/red-frontier/blob/main/src/sim/host/protocol.ts).

## Files

```
src/sim/host/
  protocol.ts        every legal write, as plain serializable data
  view.ts            SimView — the immutable read model
  viewModels.ts      the shapes a view is built from
  applyCommand.ts    the dispatch table (sim-side, worker-reusable)
  overlays.ts        runtime edits as *data* (a name + ids), never closures
  projection.ts      the view payload a host answers with
  messages.ts        HostRequest / HostReply envelopes
  LocalSimHost.ts    the in-process host: the live sim, narrowed to a view
  WorkerSimHost.ts  the worker host: posts ticks, mirrors state, optimistic acks
  workerRuntime.ts   the sim side of the wire (also driven headless in tests)
  mirror.ts          a SimView built from payloads + terrain from the seed
  NetworkPort.ts     the same requests/replies over any string duplex
  createHost.ts      one factory, either transport
  SimHost.ts         the interface both hosts implement
```

## Player commands

```
rover/move | mine | unload | wait | construct | clean | repair | recover | salvage
rover/stop | repeatRoute | rule | chargeFloor | lights
building/place | toggle | demolish | maintain | assemble | recipe
colonist/order
```

## Developer commands

```
dev/time
dev/storm/force | dev/storm/clear | dev/storm/scheduler
dev/dust
dev/lightning/strike
dev/spawn/rover | dev/spawn/building | dev/spawn/deposit
dev/building/complete | level | health | damaged | cleanliness
dev/rover/battery | cargo | cargoClear | condition
dev/colonist/health | suit
```

**Player intent and dev backdoors are separate surfaces.** Dev edits live in
`src/sim/DevBackdoors.ts` and are reachable only through a `dev/*` command, so a
UI bug cannot accidentally fabricate a rover through a player path. Note the
asymmetry that trips people up: a *fabricated* building or rover becomes a
first-class sim object and **is saved**; a dev *modifier* (a battery pin, an
upgrade mark) is a runtime overlay and **never** is. See
[Developer Mode](Developer-Mode.md).

## Acks, views and overlays

- **`SimAck { ok, entityId?, value?, error? }`** returns from placements and
  other mutating calls, so the build ghost's verdict *is* the sim's verdict on
  both transports. In the worker the ack is literally `applyCommand`'s own
  refusal — a one-tick-stale mirror never gets to decide.
- **`SimView`** is `readonly` all the way down. The compiler refuses
  `sim.step()`, `sim.placeBuilding()`, and field assignment on a view;
  `tests/sim/host.test.ts` greps the tree so nobody re-imports the class anyway.
- **Overlays are data**: a name plus a set of entity ids, applied by a sim-side
  registry — because you cannot hand a closure to a worker.
- **Terrain is never sent.** Heights, slope and surface geology are pure
  functions of the seed, so the mirror derives them; that is what makes a
  synchronous `canPlace` possible on the client.

## Transports

`createHost.ts` picks one factory with two branches:

| Transport | When | Notes |
|---|---|---|
| `WorkerSimHost` | **default** | module worker owns the `Simulation`; the client pumps one `advance{dt}` per delivered frame |
| `LocalSimHost` | `?worker=0`, or when a worker cannot start | in-process; the view *is* the live sim |

If a worker cannot start (a `file:` page, a browser without module workers) the
factory logs why and falls back rather than showing a blank screen.
`NetworkPort.ts` runs the same request/reply objects as JSON over any string
duplex — no server ships; the point is that sim and host stay oblivious to which
side of a process boundary they are on.

Remaining in the roadmap: after a release or two of soak with the worker as the
default, the in-process branch of `createHost` (and `LocalSimHost`'s use outside
tests) can go. Optional later work — a true 20 Hz worker timer with render
interpolation, transferables for terrain, `OffscreenCanvas` — is each behind its
own guard, and none of it is measured as a bottleneck today.

## Adding a command (the checklist)

The protocol is deliberately boring to extend and impossible to extend halfway.
Every new player intent needs **five** things:

1. A variant in `src/sim/host/protocol.ts`.
2. A field entry in the decoder table (`fieldOk` validates enums and ranges
   **before** `applyCommand` — see
   [Persistence and Save Format](Persistence-and-Save-Format.md#the-untrusted-boundary)).
3. A branch in `src/sim/host/applyCommand.ts`.
4. A cue in the exhaustive `COMMAND_CUES` map in
   `src/audio/AudioSystem.ts` — the map is exhaustive, so a missing cue is a type
   error, and `tests/audio/system.test.ts` pins the command→cue coverage.
5. A host test: it decodes, it applies, the gate refuses what the protocol does
   not name, and the same transcript replays to the same state hash.

Dev-only edits skip 1–3 for the player surface and instead land in
`sim/DevBackdoors.ts` with a `dev/*` command, so the player surface stays small.

**New *content* needs none of this.** A blueprint or bulk resource is validated
against `BUILDINGS` / `RESOURCES`, which is how the Refinery and `steel` shipped
with the decoder untouched. The one exception is a field whose legal values are a
*subset* of a table: `dev/spawn/deposit` uses `mineableResourceId`, because a seam
of refined material is not a thing that can exist.

## What the boundary has already caught

Recording these because they are the reason the seam is strict:

- The worker used to publish a view only on `advance`, so an order given to a
  **paused** colony was applied by the sim and invisible to the HUD until you
  unpaused. The in-process host cannot have that bug — its view is the live sim.
  Now any command batch publishes. Pinned by `tests/sim/worker.test.ts`.
- CI runs `worker-smoke` **twice**, once per transport, with the in-process run
  passing `SMOKE_QUERY='?worker=0'` explicitly — because an empty query would
  otherwise exercise the worker twice and quietly drop the gate.
- A dev battery pin was originally a per-frame poke from the UI into the sim; it
  is a host overlay now, which is what makes it invisible to `snapshot()`.

## Related

- [Architecture Overview](Architecture-Overview.md) ·
  [Simulation Systems](Simulation-Systems.md) ·
  [Testing and QA](Testing-and-QA.md)
