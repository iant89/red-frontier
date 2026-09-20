# Golden Colony (Phase 0)

This directory holds the Phase 0 golden colony — the "can we safely build on this?" gate.

## Contents

- `golden-colony.transcript.json` — seed + timed commands (diffable, seed-pinned, replay format)
- `golden-colony.hash.txt` — pinned final StateHash after 5 sols
- `golden-colony.save.json` — snapshot for manual inspection in a text editor
- `golden-colony.meta.json` — seed, ticks, spots, generation time
- This README

## How it was built

Seed 9001, pioneer difficulty, nearDeposits 0.2. Buildings placed via deterministic
findSpot search (ring scan), same as tests/fixtures/sim.ts, then completed via
dev/building/complete to ensure viability regardless of rover logistics:

```
warehouse, solar, battery, extractor, oxygenator, greenhouse,
refinery, workshop, garage, waterTank, pumpStation
```

Then ice + iron mining with repeatRoute hauling, plus a spawned cargo rover for silicon.

Total duration: 5 sols = 24000 ticks at 20Hz (SOL_SECONDS=240).

Using dev commands is intentional: this is a regression gate, not a gameplay challenge.
The transcript is still deterministic and diffable, and the hash still moves when
tick behavior changes — which is the point.

## Regeneration

```bash
node scripts/generate-golden-colony.mjs --write
npm run test:replay
npm test -- golden-colony
```

## Change control

"Freeze" = change-control, not no-changes. If tick output moves, update the pinned hash
deliberately (PR-visible, reviewed). That's how transcript hashes already behave.

See docs/SIMULATION-INVARIANTS.md and benchmarks/baseline.md.
