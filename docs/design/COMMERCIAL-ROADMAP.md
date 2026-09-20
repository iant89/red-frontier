# RED FRONTIER — COMMERCIAL GAMEPLAY ROADMAP

> The commercial plan, preserved verbatim as proposed.
>
> Companion documents:
>
> - [`COMMERCIAL-ROADMAP-REVIEW.md`](./COMMERCIAL-ROADMAP-REVIEW.md) — the
>   codebase-grounded review: re-baseline of each phase against what already
>   ships, hidden ordering dependencies, revised sequencing, and commercial
>   gaps (packaging, mobile, telemetry).
> - [`AUTONOMY.md`](./AUTONOMY.md) — the design spec for the autonomy stat
>   that Phases 2, 3, 4, 9 and 11 all consume.
> - [`GDD.md`](./GDD.md) / [`TDD.md`](./TDD.md) — the game and technical
>   design documents this plan builds on.

```
RED FRONTIER — COMMERCIAL GAMEPLAY ROADMAP
==========================================

NORTH-STAR GOAL
---------------

Turn Red Frontier from:
    "A technically impressive Mars-colony simulation"

into:
    "A polished engineering/automation strategy game where
     players build a Mars colony that gradually becomes autonomous."

Core player loop:
    DISCOVER
       |
       v
     BUILD
       |
       v
   AUTOMATE
       |
       v
    SURVIVE
       |
       v
    EXPAND
       |
       v
  SOLVE ENGINEERING
     PROBLEMS
       |
       v
   BECOME AUTONOMOUS
       |
       v
    GO FARTHER
       |
       +----------------------+
                              |
                              v
                          DISCOVER

============================================================
PHASE 0 — FREEZE THE FOUNDATION
============================================================

Goal:
    Stop expanding the simulation temporarily and establish
    a stable baseline.

Tasks:
    [ ] Freeze current resource model.
    [ ] Freeze rover fundamentals.
    [ ] Freeze worker/simulation architecture.
    [ ] Establish save-game compatibility policy.
    [ ] Add deterministic regression tests.
    [ ] Record baseline performance.
    [ ] Create a "golden colony" save.
    [ ] Establish simulation invariants.

Suggested structure:
    /tests/
        /golden-colony/
        /simulation/
        /replay/
        /save-migrations/
    /benchmarks/

Definition of done:
    Major gameplay changes can be made without constantly
    worrying about breaking the simulation.

Estimated effort:
    1-2 weeks.

============================================================
PHASE 1 — MAKE THE FIRST 30 MINUTES EXCELLENT
============================================================

Goal:
    Make the game immediately understandable to someone
    who has never played it.

The first 30 minutes should teach:
    1. Move a rover.
    2. Find resources.
    3. Extract something.
    4. Bring it home.
    5. Build something.
    6. Generate power.
    7. Manage life support.
    8. Automate a task.
    9. Survive a small environmental problem.
   10. Receive a meaningful colony objective.

Desired player reaction:
    "I'm building a machine that keeps itself alive."

Add:
    [ ] Contextual tutorials.
    [ ] First-time hints.
    [ ] Recommended actions.
    [ ] Clear warnings.
    [ ] "Why this matters" explanations.
    [ ] Simplified early-game UI.
    [ ] Guided first engineering project.

Avoid:
    Do NOT make the tutorial:
        Click here.
        Click here.
        Click here.
        Click here.

Instead:
        "Your water reserve will run dry in 1.8 sols."

Then let the player discover how to solve it.

Playtest:
    Give the game to someone who has never played it.
    Do not explain the game.
    Watch them.

Repeated questions are UX problems.

Estimated effort:
    2-3 weeks.

============================================================
PHASE 2 — ENGINEERING PROJECTS
============================================================

Goal:
    Give the player meaningful objectives beyond
    "build whatever you want."

Introduce:
    ENGINEERING PROJECTS

Example:
    PROJECT: ESTABLISH SURVIVAL

    Requirements:
        - Functional oxygen.
        - Functional water.
        - Food production.
        - Stable power.

    Reward:
        Colony enters Stable Operations.

    PROJECT: SURVIVE THE FIRST STORM

    Requirements:
        - Radar.
        - Emergency battery.
        - Sheltered rover.
        - Emergency resource reserve.

    Reward:
        Storm forecasting.

    PROJECT: INDUSTRIALIZE

    Requirements:
        - Refinery.
        - Workshop.
        - Mining operation.
        - Automated haul route.

    Reward:
        Advanced automation.

    PROJECT: REMOTE OPERATIONS

    Requirements:
        - Long-range rover.
        - Remote power.
        - Communications.
        - Emergency supplies.

    Reward:
        Remote exploration.

    PROJECT: AUTONOMOUS COLONY

    Requirement:
        Survive 10 sols without manual intervention.

This could become one of the defining challenges
of Red Frontier.

============================================================
PHASE 3 — MAKE AUTOMATION THE PROGRESSION SYSTEM
============================================================

Goal:
    Make progression about moving from manual operation
    to autonomous colony management.

Instead of:
    Level 1
    Level 2
    Level 3

Use:
    MANUAL
       |
       v
    ASSISTED
       |
       v
    AUTOMATED
       |
       v
    REDUNDANT
       |
       v
    AUTONOMOUS

Example:
    EARLY GAME
        "Send Rover 2 to mine iron."

    MID GAME
        "Rover 2 automatically mines iron."

    LATE GAME
        "Keep iron above 500 kg."

    END GAME
        "Maintain enough iron production to support
         the colony."

Player progression becomes:
    OPERATOR
       |
       v
    ENGINEER
       |
       v
    COLONY ARCHITECT

This should become one of the game's primary fantasies.

============================================================
PHASE 4 — BUILD THE COLONY OPERATIONS DASHBOARD
============================================================

Goal:
    Let players understand what their increasingly
    complex colony is doing.

Example:
    +--------------------------------------+
    |        RED FRONTIER OPERATIONS       |
    +--------------------------------------+
    |                                      |
    | POWER       84%       STABLE         |
    | WATER       71%       WARNING        |
    | OXYGEN      96%       STABLE         |
    | FOOD        82%       STABLE         |
    |                                      |
    | ROVERS      4/5       OPERATIONAL    |
    |                                      |
    | AUTONOMY    6.8 sols                 |
    |                                      |
    | NEXT BOTTLENECK                      |
    | Water extraction                     |
    |                                      |
    +--------------------------------------+

Historical graphs:
    [ ] Power
    [ ] Water
    [ ] Oxygen
    [ ] Food
    [ ] Ore
    [ ] Rover utilization
    [ ] Battery reserves
    [ ] Production
    [ ] Consumption

Player should be able to answer:
    "Why is my colony failing?"

without requiring spreadsheet-level analysis.

============================================================
PHASE 5 — BUILD THE BOTTLENECK SYSTEM
============================================================

Goal:
    Turn raw simulation information into useful
    engineering decisions.

Example:
    +--------------------------------------+
    |          ! WATER BOTTLENECK          |
    +--------------------------------------+
    |                                      |
    | Production:       8.4 kg/sol         |
    | Consumption:      9.7 kg/sol         |
    |                                      |
    | Projected shortage: 3.2 sols         |
    |                                      |
    | Contributing factors:                |
    |   - Rover 3 unavailable              |
    |   - Ice deposit 2.4 km away          |
    |   - Refinery consuming excess power  |
    |                                      |
    | Possible solutions:                  |
    |   > Increase mining                  |
    |   > Reduce consumption               |
    |   > Build storage                    |
    |   > Repair Rover 3                   |
    |                                      |
    +--------------------------------------+

Important:
    The game should NOT automatically solve the problem.

    It should provide enough information for the player
    to make the decision.

============================================================
PHASE 6 — MAKE EXPLORATION WORTH DOING
============================================================

Goal:
    Make exploration more than travelling somewhere
    and collecting resources.

Introduce uncertainty.

Before surveying:
    +--------------------------------------+
    |           UNKNOWN ANOMALY            |
    +--------------------------------------+
    |                                      |
    | Distance: 2.7 km                     |
    | Signal:   Weak                       |
    |                                      |
    | Possible:                            |
    |   - Geological                        |
    |   - Artificial                        |
    |   - Thermal                           |
    |   - Impact-related                    |
    +--------------------------------------+

After surveying:
    +--------------------------------------+
    |            SURVEY COMPLETE           |
    +--------------------------------------+
    |                                      |
    | Iron deposit                         |
    | Estimated: 400-650 kg                |
    | Confidence: 89%                      |
    |                                      |
    | Terrain: Difficult                   |
    | Risk: High storm exposure            |
    +--------------------------------------+

Scouting now has strategic value.

============================================================
PHASE 7 — BUILD A POI / EVENT SYSTEM
============================================================

Goal:
    Turn exploration into stories and meaningful decisions.

Potential POIs:
    [ ] Abandoned rover.
    [ ] Old research station.
    [ ] Cargo pod.
    [ ] Geological anomaly.
    [ ] Old transmitter.
    [ ] Damaged expedition equipment.
    [ ] Buried infrastructure.
    [ ] Unknown scientific site.

Avoid:
    POI -> +100 iron

Prefer:
    POI -> New technology
        -> New information
        -> New location
        -> New engineering project
        -> Unique resource
        -> New challenge
        -> Story fragment

============================================================
PHASE 8 — GIVE MACHINES HISTORY
============================================================

Goal:
    Create attachment to machines without turning them
    into traditional RPG characters.

Allow players to name rovers.

Example:
    +--------------------------------------+
    | ROVER-03                             |
    | "ODYSSEUS"                           |
    +--------------------------------------+
    |                                      |
    | Distance traveled:   21.7 km         |
    | Ore hauled:          1,382 kg        |
    | Storms survived:     8               |
    | Recoveries:          2               |
    | Repairs:             4               |
    |                                      |
    | Built Sol 3                          |
    +--------------------------------------+

After several hours:
    "ODYSSEUS is still alive."

Create emotional investment through history,
not artificial character systems.

============================================================
PHASE 9 — BUILD THE CAMPAIGN
============================================================

Goal:
    Give the simulation a clear beginning, middle and end.

    CHAPTER 1 — SURVIVAL
        Keep one human alive.

    CHAPTER 2 — STABILITY
        Establish reliable water, oxygen and food.

    CHAPTER 3 — INDUSTRY
        Establish mining and manufacturing.

    CHAPTER 4 — AUTOMATION
        Reduce manual operation.

    CHAPTER 5 — STORM SEASON
        Survive major environmental events.

    CHAPTER 6 — EXPANSION
        Establish remote operations.

    CHAPTER 7 — INDEPENDENCE
        Produce everything the colony requires.

    CHAPTER 8 — AUTONOMY
        Survive without direct intervention.

Final objective:
    "Establish a self-sustaining human presence on Mars."

After completion:
    CONTINUE COLONY

remains available as a sandbox.

============================================================
PHASE 10 — BUILD REPLAYABILITY
============================================================

Goal:
    Make subsequent colonies meaningfully different.

Use deterministic procedural generation for:
    [ ] Resource distribution.
    [ ] Weather patterns.
    [ ] POIs.
    [ ] Terrain.
    [ ] Starting conditions.

Create scenarios:
    THE ENGINEER
        Normal starting conditions.
    DUST BOWL
        Extreme weather.
    LOW POWER
        Poor solar conditions.
    REMOTE COLONY
        Start far from major resources.
    BROKEN FLEET
        Begin with damaged rovers.
    LIMITED WATER
        Water resources are scarce.
    HARD AUTOMATION
        Advanced automation is expensive.

============================================================
PHASE 11 — BUILD THE COLONY REPORT
============================================================

Goal:
    Turn simulation history into procedural storytelling.

Example:
    +--------------------------------------+
    |           COLONY REPORT              |
    +--------------------------------------+
    |                                      |
    | Sol survived:       184              |
    |                                      |
    | Distance explored:  74.3 km          |
    |                                      |
    | RESOURCES PRODUCED                   |
    |   Iron              14,822 kg        |
    |   Water              8,291 kg        |
    |   Steel              4,104 kg        |
    |                                      |
    | ROVERS                               |
    |   5 deployed                         |
    |   1 lost                             |
    |   3 still operational                |
    |                                      |
    | MAJOR INCIDENTS                      |
    |   - Great Dust Storm                 |
    |   - Rover 3 stranded                 |
    |   - Oxygen shortage                  |
    |   - Remote outpost established       |
    |                                      |
    | ACHIEVEMENT                          |
    |   AUTONOMOUS COLONY                  |
    |                                      |
    |   Colony survived 42 sols            |
    |   without manual intervention.      |
    +--------------------------------------+

============================================================
PHASE 12 — BUILD INCIDENT / REPLAY SYSTEM
============================================================

Goal:
    Turn failures into understandable stories and make
    deterministic simulation useful to the player.

Example:
    INCIDENT REPORT — SOL 28

    14:02  Severe storm detected
    14:17  Solar output -63%
    14:20  Battery reserve < 30%
    14:24  Rover 3 enters storm
    14:31  Rover 3 drivetrain damaged
    14:36  Oxygen generator brownout
    14:42  Emergency reserve activated
    14:55  Storm passes

    ROOT CAUSE:
        Insufficient battery reserve.

This provides:
    1. Player learning.
    2. Better failure feedback.
    3. A visible benefit from deterministic simulation.

============================================================
PHASE 13 — REWARD REDUNDANCY
============================================================

Goal:
    Create strategic tension between efficiency and resilience.

Example:
    ONE WATER EXTRACTOR
        + Maximum efficiency
        - Extremely vulnerable to failure

    TWO WATER EXTRACTORS
        + Slightly less efficient
        + Colony survives one failure

    THREE WATER EXTRACTORS
        + Very resilient
        - Expensive

Apply the same concept to:
    [ ] Rovers
    [ ] Power
    [ ] Water
    [ ] Oxygen
    [ ] Food
    [ ] Manufacturing
    [ ] Storage
    [ ] Remote infrastructure

Central strategic question:
    "How much redundancy can I afford?"

============================================================
PHASE 14 — TECHNICAL HARDENING
============================================================

Goal:
    Prevent simulation complexity from creating subtle bugs.

Document explicit system ordering.

Example:
    CLOCK
      |
      v
    WEATHER
      |
      v
    ENVIRONMENT
      |
      v
    POWER
      |
      v
    NETWORKS
      |
      v
    PRODUCTION
      |
      v
    RESOURCE TRANSFERS
      |
      v
    ROVER MOVEMENT
      |
      v
    ROVER TASKS
      |
      v
    MAINTENANCE / DAMAGE
      |
      v
    LIFE SUPPORT
      |
      v
    ALERTS / EVENTS
      |
      v
    SNAPSHOT

Exact ordering can differ.

It must be explicit, documented and tested.

Add property-based tests for invariants:
    allocated power <= available power

    resource quantities never become negative

    rover cannot arrive with impossible battery state

    production cannot consume nonexistent resources

    save/load preserves deterministic state

    replay produces identical state hashes

============================================================
PHASE 15 — COMMERCIAL POLISH
============================================================

Only begin this after the gameplay loop is working.

UX:
    [ ] Settings.
    [ ] Accessibility.
    [ ] Keyboard remapping.
    [ ] Controller support if appropriate.
    [ ] Save management.
    [ ] Resolution/scaling.
    [ ] Fullscreen.
    [ ] Pause.
    [ ] Simulation speed controls.
    [ ] Better onboarding.
    [ ] Clearer alerts.

Visuals:
    [ ] Better building silhouettes.
    [ ] Stronger resource visualization.
    [ ] Better lighting.
    [ ] Better weather presentation.
    [ ] Rover animations.
    [ ] Construction effects.
    [ ] Failure/damage effects.
    [ ] Better environmental feedback.

Audio:

    [ ] Machinery.
    [ ] Rover movement.
    [ ] Environmental ambience.
    [ ] Warning sounds.
    [ ] Storm audio.
    [ ] Construction.
    [ ] UI feedback.

Game feel:
    Construction complete
           |
           v
    Mechanical animation
           |
           v
    Lights activate
           |
           v
    Power network responds
           |
           v
    UI notification
           |
           v
    New production begins

============================================================
PHASE 16 — BUILD A VERTICAL-SLICE DEMO
============================================================

Goal:
    Prove the game works commercially before spending
    months polishing everything.

Demo should contain:
    [ ] First colony.
    [ ] Core survival.
    [ ] Rover automation.
    [ ] One major storm.
    [ ] One exploration region.
    [ ] Several engineering projects.
    [ ] One meaningful progression milestone.

Target:
    30-90 minutes of polished gameplay.

The demo needs to answer:
    "Would I pay for the full game?"

============================================================
PHASE 17 — PLAYTEST WITH STRANGERS
============================================================

Find players who have never seen the game.

Do not explain the game.

Observe:
    [ ] Where they become confused.
    [ ] What they ignore.
    [ ] What they enjoy.
    [ ] What frustrates them.
    [ ] Where they quit.
    [ ] What they remember.
    [ ] What they talk about afterward.

Ask:
    "What were you trying to accomplish?"
    "What was confusing?"
    "What did you enjoy most?"
    "What would you change?"
    "At what point did you want to keep playing?"

Do not rely only on:
    "Did you like it?"

Player behavior is more valuable than compliments.

============================================================
PHASE 18 — STORE PAGE AND MARKETING
============================================================

Start marketing before the game is finished.

Build:
    [ ] Steam page.
    [ ] Trailer.
    [ ] Screenshots.
    [ ] Gameplay GIFs/clips.
    [ ] Developer updates.
    [ ] Community/Discord if useful.
    [ ] Demo.
    [ ] Wishlist campaign.

Possible positioning:
    "BUILD A SELF-SUSTAINING COLONY ON MARS."

    Mine resources.
    Build infrastructure.
    Program autonomous rovers.
    Survive dust storms.
    Solve cascading engineering failures.
    Expand beyond your first landing site.

    "Your goal isn't merely to survive Mars.
     It's to build a colony that no longer needs you."

============================================================
COMMERCIAL MILESTONES
============================================================

    M0  — Stable simulation
          |
          +-- Can we safely build on this?
          |
    M1  — First 30 minutes
          |
          +-- Is the game understandable?
          |
    M2  — Engineering Projects
          |
          +-- Does the player have meaningful goals?
          |
    M3  — Automation progression
          |
          +-- Is the core loop compelling?
          |
    M4  — Operations UI
          |
          +-- Can players understand the simulation?
          |
    M5  — Exploration
          |
          +-- Is there a reason to expand?
          |
    M6  — Campaign
          |
          +-- Is there a reason to finish a colony?
          |
    M7  — Replayability
          |
          +-- Is there a reason to start again?
          |
    M8  — Vertical-slice demo
          |
          +-- Would strangers buy this?
          |
    M9  — Public playtest
          |
          +-- Do strangers actually enjoy it?
          |
    M10 — Commercial polish
          |
          +-- Does it feel finished?
          |
    M11 — Launch
          |
          +-- Can the market support it?

============================================================
DEVELOPMENT PRIORITY
============================================================

TIER 1 — MUST HAVE
    [ ] First 30-minute experience.
    [ ] Engineering Projects.
    [ ] Automation progression.
    [ ] Clear colony objectives.
    [ ] Better alerts.
    [ ] Bottleneck analysis.
    [ ] Campaign progression.
    [ ] Exploration purpose.

TIER 2 — HIGH VALUE
    [ ] Colony dashboard.
    [ ] Historical graphs.
    [ ] Rover history.
    [ ] POI events.
    [ ] Procedural scenarios.
    [ ] Colony reports.
    [ ] Tutorial/onboarding.
    [ ] Audio/visual feedback.

TIER 3 — LATER
    [ ] More buildings.
    [ ] More resources.
    [ ] More cosmetic customization.
    [ ] More detailed simulation.
    [ ] Additional rover types.
    [ ] Advanced world systems.

TIER 4 — DO NOT PRIORITIZE YET
    [ ] Multiplayer.
    [ ] Combat.
    [ ] Massive procedural worlds.
    [ ] Complex NPC factions.
    [ ] MMO-like systems.

============================================================
WHAT NOT TO DO
============================================================

Do NOT spend the next year doing:
    New resource!
    New building!
    New machine!
    New upgrade!
    New resource!
    New weather effect!
    New building!
    New rover!
    New resource!

That creates an endlessly impressive prototype.

Instead:
    EXISTING SYSTEMS
          |
          v
    BETTER DECISIONS
          |
          v
    BETTER GOALS
          |
          v
    BETTER FEEDBACK
          |
          v
    BETTER PROGRESSION
          |
          v
    BETTER PLAYER STORIES
          |
          v
    BETTER PRODUCT

============================================================
CORE COMMERCIAL DEVELOPMENT LOOP
============================================================

    Can a stranger understand the game?
                    |
                    v
    Do they enjoy the first hour?
                    |
                    v
    Do they want to solve the next problem?
                    |
                    v
    Do they understand why they failed?
                    |
                    v
    Do they want to build a better colony?
                    |
                    v
    Do they want to start another colony?
                    |
                    v
    Will they wishlist the game?
                    |
                    v
    Will they pay for it?

============================================================
THE CORE DESIGN PRINCIPLE
============================================================

Do not add a system unless it creates a meaningful
player decision.

A new resource is valuable if it creates a decision.

A new rover is valuable if it creates a decision.

A new weather system is valuable if it creates a decision.

A new building is valuable if it creates a decision.

A new technology is valuable if it creates a decision.

Simulation complexity is NOT the goal.

Interesting decisions ARE the goal.

============================================================
THE RED FRONTIER FANTASY
============================================================

The strongest version of Red Frontier is NOT a game where
the player manually manages increasingly complicated machines.

It is a game where the player gradually transforms:
        HUMAN
          |
          v
     MANUAL WORK
          |
          v
       MACHINES
          |
          v
      AUTOMATION
          |
          v
       LOGISTICS
          |
          v
      REDUNDANCY
          |
          v
       AUTONOMY
          |
          v
   SELF-SUSTAINING
       COLONY

The player starts as:
    The person desperately keeping the colony alive.

The player ends as:
    The engineer who built a system capable of
    keeping itself alive.

============================================================
IMMEDIATE ROADMAP
============================================================

If development time and money are limited, implement these
in this exact order:

    1. First 30-Minute Experience
       Make the existing game immediately understandable.
    2. Engineering Projects
       Give the player explicit reasons to interact
       with the simulation.
    3. Automation Progression
       Make manual -> automated -> autonomous the
       central progression.
    4. Operations Dashboard
       Make complex colonies understandable.
    5. Bottleneck / Advisor System
       Turn simulation data into useful decisions.
    6. Exploration + POIs
       Give players a reason to leave the starting colony.
    7. Campaign
       Connect the systems into a beginning, middle and end.
    8. Replayability
       Add scenarios and different starting conditions.
    9. Vertical-Slice Demo
       Prove the game is fun before spending heavily
       on polish.
   10. Public Playtesting
       Use real player behavior to determine what needs fixing.
   11. Commercial Polish
       Visuals, audio, UX, accessibility and game feel.
   12. Launch Preparation
       Store page, trailer, demo, wishlists, community
       and launch campaign.

============================================================
ULTIMATE PRODUCT VISION
============================================================

The player's journey should feel like:
    "I am keeping myself alive."
                    |
                    v
    "I have a functioning colony."
                    |
                    v
    "My colony can survive storms."
                    |
                    v
    "My colony can operate without me."
                    |
                    v
    "My machines can build another colony."
                    |
                    v
    "I've built a self-sustaining human presence on Mars."

That is the identity, progression system, campaign arc,
and marketing message that I would build Red Frontier around.
```
