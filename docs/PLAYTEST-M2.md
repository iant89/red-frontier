# Playtest M2 — "Can the player state their current project's goal unprompted?"

*The Definition-of-Done check for COMMERCIAL-PHASE-2.md (review §7, M2).*
*Status: READY TO RUN — instrument shipped; the sessions themselves are a human task.*

---

## What we are measuring

The projects panel and its HUD pip exist to answer one question for the
player at any moment: **what is the colony being asked to do, and how close
is it?** M2 passes when a playtester — who was never told to look at the
card — can answer that in their own words when interrupted.

This is a *legibility* test, not a difficulty test. A player who fails a
project but can say exactly what it wanted from them is a pass. A player who
completes it by accident and cannot say what it was is a fail.

## Who

- 5 sessions minimum, 8 preferred. Mixed: at least two who have never played
  a colony sim, at least two who have.
- Each plays alone, facilitator present, screen visible to the facilitator.
- Difficulty **Pioneer**, world **Territory**, no dev mode visible to the
  player. The facilitator opens the dev panel (`~`) only at checkpoints and
  only on their own second screen / after the session for the readout.

## Setup (facilitator)

1. `npm run dev`, a fresh browser profile (so no `rf-collapse-*` preferences
   carry over — the card must start open).
2. Start a new expedition through the wizard with the settings above. Do not
   narrate the wizard; the wizard is under test too.
3. Say only: *"Play for about forty minutes. Think aloud if you like. I'll
   interrupt you three times with one question."* Nothing about projects,
   objectives, or the panel.

## Checkpoints

Interrupt at **sol 2**, **sol 5**, and **whenever the first project lands**
(whichever of these comes first is checkpoint 1; you may end up with four).
At each checkpoint ask, verbatim:

> **"What is the colony trying to accomplish right now?"**

Then, if the answer names a goal, follow up with:

> **"How close is it?"**

Do not point at the screen, do not say "project", do not say "panel". Record
the answer word-for-word, then immediately open the dev panel → **Playtest
(M2)** section → **Copy readout**, and paste it under the answer.

### Scoring an answer

| Score | Criterion |
|---|---|
| **2 — states the goal** | Names the current project or paraphrases its blurb ("get air, water and food running and keep the lights on overnight"), *and* the follow-up gives a number or a remaining item that matches the readout ("three of five", "just the battery left"). |
| **1 — names a piece** | Names one requirement as the whole goal ("build a greenhouse"), or names the project but cannot say how close. |
| **0 — no goal** | "Survive", "build stuff", "I don't know", or names something the board does not ask for. |

The readout's `project:` and `next:` lines are the ground truth the answer is
scored against — the facilitator scores after the session, not live.

## Pass criterion

**M2 passes** when, across all sessions, the *median* checkpoint score is 2
and no session scores 0 at both sol-5 and first-landing checkpoints.

A player whose card was `collapsed` at a checkpoint and still scores 2 is
strong evidence the pip is carrying its weight; note it.

## What to log per session

```
session: <id>   player: <novice|veteran>   build: <git sha>
checkpoint 1 (sol N / landed): "<answer>"  score: _
[M2] readout pasted here
checkpoint 2 ...
checkpoint 3 ...
time to first landing: sol N (or "not reached")
card collapsed at any checkpoint: yes/no
unprompted mentions of the card or pip: <count, quotes>
```

The `[M2]` readout carries: lead project and count, the next unmet
requirement with its numbers, how many projects have landed and when the
first did, the autonomy streak, and whether the card was open or collapsed.
It is derived from the same view the panel renders, so it cannot disagree
with what the player saw.

## After the sessions

- Median score < 2 → the fix is copy or placement, not mechanics: start with
  the blurb of `establishSurvival` in `src/sim/projects/catalog.ts` and the
  pip text in `projectPip` (`src/ui/ProjectsPanel.ts`). Both are pinned in
  tests; change the test with the copy.
- Time to first landing > sol 6 on Pioneer for most players → a balance
  note for the requirements table, not a legibility fail.
- Tick the M2 box in `COMMERCIAL-PHASE-2.md` with the session count and the
  median, and file anything else under ISSUES.md.
