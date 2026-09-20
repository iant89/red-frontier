# Red Frontier — Steam Launch Kit

Everything you need to put **Red Frontier** on Steam: pricing, player-facing
store copy, generated key art, and the step-by-step path through Steam Direct.
Store copy in Section 3 is written for the finished product and contains no
development, roadmap, or build information — it is safe to paste directly into
your Steamworks store editor.

---

## 1. At a glance

| Item | Recommendation |
|---|---|
| **Title** | Red Frontier |
| **Tagline** | *One human. A handful of machines. An entire planet that does not want you there.* |
| **Sell-line** | Mars · 2066 — Real-Time Strategy · Survival · Automation · Exploration |
| **Base price** | **US $19.99**, 10% launch-week discount (see Section 4) |
| **Genres (Steam)** | Strategy, Simulation, Survival, Indie |
| **Players** | Single-player |
| **Mature content** | None |
| **Release shape** | Full release (Early Access alternative priced in Section 4) |

---

## 2. What this kit contains

| Path | What it is |
|---|---|
| `steam/steam-launch-kit.md` | This document — pricing, copy, steps, checklist |
| `steam/press-kit.html` | Press kit page: fact sheet, pitches, features, downloadable art & screenshots |
| `steam/store-page-preview.html` | A visual mockup of how the store page will look; open in a browser |
| `steam/steamworks-export/` | **Ready-to-upload assets at Steam's exact sizes** (see its README) |
| `steam/assets/red-frontier-logo.png` | Logo lockup (Mars roundel + title), master at 1254×1254 |
| `steam/assets/capsule-main.jpg` | Horizontal key art with title — master for main/header capsules |
| `steam/assets/capsule-header.jpg` | Wide key art with title — header capsule composition |
| `steam/assets/capsule-vertical.jpg` | Portrait key art with title — vertical/library capsule composition |
| `steam/assets/library-hero.jpg` | Ultra-wide cinematic panorama, no text — library hero |
| `steam/assets/page-background.jpg` | Dark regolith texture — store page background |

`steam/assets/` holds the high-resolution **masters**; `steam/steamworks-export/`
holds the exact-size files Steam asks for (Section 7), already cropped,
transparent where required, and named per upload slot. Upload from the export
folder; re-derive from masters only if you need to re-art-direct.

---

## 3. Store page copy — paste-ready

### 3.1 Short description
*(Shown in lists, search results, and next to the capsule. Limit: 300 characters.)*

> Mars, 2066. One human, a handful of machines, and an entire planet that
> does not want you there. Command autonomous rovers, build an industrial
> colony from ice and rust, forecast the storms before they strike — a
> hard-sci-fi survival strategy game where oxygen is the real clock.

**Alternates, if you prefer a different tone:**

- *Direct:* Mars survival strategy: one colonist, a fleet of rovers, and a
  supply chain that stands between you and the void. Mine, refine, build,
  forecast, survive.
- *Atmospheric:* The Red Planet is patient. It can wait for your batteries to
  die. Keep one human alive on a world of dust, lightning and dwindling air.

### 3.2 Long description ("About This Game")

Formatted in Steam's own BBCode — paste as-is into the *About This Game* field:

```
[i]One human. A handful of machines. An entire planet that does not want you there.[/i]

Mars, 2066. You are the sole crew of a planetary survey claim, and the
landing was only the easy part. With four sols of air, water and rations
in reserve, everything after "touchdown" is something you must build —
from the ice up.

Oxygen kills in hours. Water in days. Food in weeks. Build in that order,
and the Red Planet still has a vote.

[h1]THE REAL CLOCK IS OXYGEN[/h1]
Keep a single human alive with a chain that never sleeps: haul ice,
extract water, split oxygen, grow food. Every structure has tanks, every
tank runs dry. Your commander can walk the surface on EVA suit oxygen —
but the suit is the smallest tank in the colony.

[h1]COMMAND MACHINES, NOT PEONS[/h1]
Your crew is a fleet of rugged rovers that work while you think. Queue
orders, set repeating haul routes from seam to silo, write automation
rules, and let idle machines assign themselves. Keep them on the road:
the Rover Garage fast-charges their batteries, services their
drivetrains, and assembles new rolling stock from parts — including
long-haul cargo rovers for the far seams.

[h1]FROM ORE TO INDUSTRY[/h1]
Iron ore is dug. Steel is made. Run the Refinery, feed the Workshop, and
choose a production line — electric motors, circuit boards, or water
pipe — to fit out structures, refit rovers, and grow the fleet. Parts
wear out; machines limp; the Repair Bay brings them back. Every kilowatt
on the grid is spent visible at 35 kW a furnace is a promise, not a plan.

[h1]WEATHER IS A FIELD, NOT A MOOD[/h1]
Storms are travelling systems, not screen filters. A rover twenty meters
away can sit in clear air while the pad takes fifty-meter-per-second dust
head-on — and dust that thick carries lightning. It singes arrays, dumps
batteries, buries panels and rovers alike, and it will kill a colonist
caught outside. Build the Weather Radar Station and the sky stops being
a surprise: track storm cells on the world map, extend your forecast,
and decide what gets bolted down before the front arrives.

[h1]A PLANET WITH SOMEWHERE TO GO[/h1]
The map does not show you everything. Points of interest surface only
when a rover finds them — wrecks to cut apart with a salvage torch and
haul home, Earth supply drops that land under your transponder and start
burying themselves the moment they touch. Distance is a resource. Dust
is a clock.

[h1]YOUR CLAIM, YOUR RULES[/h1]
[list]
[*] Pick your landing site and shape the world from its seed
[*] A living sol cycle — harsh days, colder nights, dust devils at noon
[*] Pause any time and think; the machines hold your orders
[*] Autosaves and multiple slots — a hard planet, a forgiving journal
[*] An ambient procedural soundscape: wind, radio, machinery, thunder
[/list]

[i]The Red Planet is patient. It can wait for your batteries to die.[/i]
```

### 3.3 Feature bullets
*(The short bullet list Steam displays beside the description.)*

- Keep one human alive on a world that kills with air, water and time
- Command an autonomous rover fleet — queues, haul routes, rules, assembly
- Build an industry: mine, refine, manufacture, repair, refit, expand
- Forecast travelling dust storms — and the lightning inside them
- Salvage wrecks, claim Earth supply drops, map what the map won't show
- A full sol cycle with day and night, plus a procedural ambient soundscape

### 3.4 Genres and tags

| Field | Values (ordered by priority — tag order affects Steam's algorithm) |
|---|---|
| **Genres** | Strategy, Simulation, Survival, Indie |
| **Tags (pick ≤20)** | Real-Time Strategy · Survival · Base Building · Automation · Space Sim · Colony Sim · Mars · Sci-fi · Resource Management · Sandbox · Management · Difficult · Atmospheric · Top-Down · Economy · Nonlinear · Singleplayer · Indie |

### 3.5 System requirements

Suggested figures for a lightweight 3D title — **confirm against your final
Windows build before publishing**:

| | Minimum | Recommended |
|---|---|---|
| **OS** | Windows 10 (64-bit) | Windows 10/11 (64-bit) |
| **Processor** | Dual-core 2.5 GHz | Quad-core 3.0 GHz |
| **Memory** | 8 GB RAM | 16 GB RAM |
| **Graphics** | Integrated GPU with modern shader support (Intel UHD 620 equivalent) | Discrete GPU (GeForce GTX 1050 / Radeon RX 560 class or better) |
| **Storage** | 1 GB available space | 1 GB available space |
| **Additional** | Runs on desktop and touch-screen devices | 1920×1080 display, headphones recommended |

### 3.6 The remaining store fields

- **Developer / Publisher:** `[Your studio name here]` (both are public —
  use the name you want printed on the page; "Ares Expeditionary Command"
  reads as an in-world brand and also works as a studio alias)
- **Mature Content:** None — no violence, gore or sexual content. Survival
  hazards exist but are presented without graphic imagery.
- **Categories (single feature list):** Single-player · Family Sharing
- **Languages:** English (interface + full audio). Add interface-only
  languages later as localizations ship.

---

## 4. Pricing

### Recommendation: **US $19.99 with a 10% launch-week discount**

Why that number:

| Comparable (approx. standard US price) | Why it anchors your choice |
|---|---|
| Against the Storm — $29.99 | Premium survival-city builder; full PC production polish |
| Surviving Mars / Aven Colony / Per Aspera — $29.99 | Publisher-backed Mars colony builders |
| Oxygen Not Included — $24.99 | Hand-crafted, huge content depth at 1.0 |
| **Dyson Sphere Program — $19.99** | The modern automation sweet-spot from an independent team |
| **Mars First Logistics — $19.99** | Mars hauler from an independent team; launched Early Access |

**$19.99** is the current "premium indie strategy" anchor and matches Red
Frontier's shape — a deep, focused, single-player strategy game from an
independent team. It leaves headroom for the standard 20–30% seasonal
discounts (→ $13.99–15.99) without the "$9.99 game" ceiling where a 50%
cut later means $4.99.

- **Launch discount:** 10% (conversion nudge, keeps the price anchor).
  Use 15% only if you want to aggressively trade revenue for day-one
  volume and early reviews.
- **Early Access alternative:** launch at **$14.99**, raise to **$19.99–24.99
  at 1.0**. Only choose this if you intend a long public EA road; the
  store copy above is written for a finished product.
- **The money math:** Valve takes 30%. At $19.99 you net ≈ **$13.99** per
  copy before returns and tax/VAT handling. Your $100 Steam Direct fee is
  recouped once the game passes **$1,000 adjusted gross** (≈ 72 copies at
  full price).
- **Regional pricing:** accept Steam's recommended regional price matrix,
  round to .99 endings, and re-review after major currency moves. Do not
  discount deeper than your true floor — the lowest allowed price on
  Steam is 90% off, and wishlist holders see every move.
- **Rule of thumb:** you cannot run a discount within ~30 days of a price
  change, so set base price and launch discount together and leave them
  alone through release week.

---

## 5. Getting onto Steam — the starting point

Realistic first-time timeline: **8–10 weeks** from payment to launch.

1. **Create a Steamworks account**, complete identity, banking, and the tax
   interview (W-9 for US, W-8BEN otherwise). Allow 2–7 business days.
2. **Pay the $100 Steam Direct fee** for the app. This starts a mandatory
   **30-day minimum waiting period** — you cannot release before it ends,
   so pay it early.
3. **Build the store page** using Section 3 and the art in Section 7.
   Submit for Valve's store-page review — typically 3–5 business days,
   budget 7.
4. **Publish the "Coming Soon" page.** It must be publicly visible for at
   least **14 days** before release. This window is your wishlist engine —
   point every trailer, post, screenshot Saturday and community update
   at it. (Rough guidance: 7,000–10,000 wishlists at launch is a healthy
   signal for a $19.99 indie strategy title.)
5. **Upload the Windows build**, configure launch options, install scripts
   and depot settings, then submit for **build review** (another 3–5
   business days, budget 7 — first-time titles sometimes take longer).
6. **Set the price and launch discount**, finish the release checklist,
   and release. Respond to reviews, fix fast, and schedule your first
   real sale no earlier than ~30 days after launch.

---

## 6. Visual assets — ready to upload

All sizes below are already exported in `steam/steamworks-export/`; the
originals in `steam/assets/` are untouched so any slot can be re-derived:

| Upload to slot | File | Size | Made from |
|---|---|---|---|
| Header capsule (required) | `capsule-header-460x215.jpg` | 460×215 | `assets/capsule-header.jpg` |
| Header capsule @2× | `capsule-header-920x430.jpg` | 920×430 | `assets/capsule-header.jpg` |
| Small capsule (required) | `capsule-small-231x87.jpg` | 231×87 | `assets/capsule-header.jpg` |
| Small capsule @2× | `capsule-small-462x174.jpg` | 462×174 | `assets/capsule-header.jpg` |
| Main capsule (required) | `capsule-main-616x353.jpg` | 616×353 | `assets/capsule-main.jpg` |
| Main capsule @2× | `capsule-main-1232x706.jpg` | 1232×706 | `assets/capsule-main.jpg` |
| Vertical / hero capsule | `capsule-vertical-374x448.jpg` | 374×448 | `assets/capsule-vertical.jpg` |
| Library capsule | `library-capsule-600x900.jpg` | 600×900 | `assets/capsule-vertical.jpg` |
| Library hero | `library-hero-1920x620.jpg` | 1920×620 | `assets/library-hero.jpg` |
| Library hero (optional HD) | `library-hero-3840x1240.jpg` | 3840×1240 | upscaled |
| Library logo | `library-logo-1280x720.png` | ≤1280×720, transparent | `assets/red-frontier-logo.png` |
| Page background | `page-background-1438x810.jpg` | 1438×810 | `assets/page-background.jpg` |
| Community icon | `community-icon-184x184.png`, `community-icon-32x32.png` | 184×184 / 32×32 | logo roundel |
| Client icon | `red-frontier-client.ico` (+ 16/32/64 px `.png`/`.tga`) | 16/32/64 | logo roundel |

Rules that matter: capsule art must be **in-game-representative or
approved art with no review scores, no award mentions and no discount or
time-limited marketing text** (Valve's September 2022 imagery rules). The
title + in-world brand lockup used here is compliant. The library hero
must carry **no text at all** — the generated one already doesn't.

---

## 7. Release checklist

**T-10 weeks** — Steamworks paperwork complete, $100 paid, store page live
as *Coming Soon* using this kit's art and copy. Begin wishlist outreach.

**T-4 weeks** — Store-page review approved; system requirements confirmed
against the final build; trailer cut (30–60 s of base growth + a storm
front hitting) uploaded.

**T-2 weeks** — Coming Soon window satisfied; build submitted to review;
price and launch discount set; press/curator keys prepared.

**Launch week** — Release; post the launch announcement; answer reviews.

**T+2 to T+4 weeks** — First patch out; first 20–30% seasonal sale
scheduled for the next seasonal window (Summer/Winter/Autumn Sale).

---

*Prepared 2026-09-20. Steam policy details (fee, review windows, capsule
rules) reflect Steamworks documentation and current industry guides; links
are plain-text in the appendix below.*

### Appendix — sources

- Steam Direct fee, recoupment and timeline: soonlab.ai / immutable.com
  "How to Publish a Game on Steam (2026)"; egmatic.com "Steam Direct 2026"
- Capsule imagery rules and dimensions: presskit.gg "Steam Capsule Sizes &
  Art Guide"; steampagecheck.com "Capsule Image Requirements"
