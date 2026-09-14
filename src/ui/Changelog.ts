/**
 * Build history for the main-menu changelog timeline.
 * The text is curated from the real Git history so the timeline reads like
 * actual flight-recorder notes, not placeholder lorem ipsum.
 */

export type ChangelogKind = 'feature' | 'fix' | 'improvement' | 'infra';

export interface ChangelogEntry {
  sha: string;
  date: string; // YYYY-MM-DD
  title: string;
  kind: ChangelogKind;
  summary: string;
  bullets: string[];
  version?: string;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    sha: 'a30de49',
    date: '2026-09-14',
    title: 'Rover proximity — crawl near obstacles, stricter in the yard',
    kind: 'feature',
    summary:
      'Rovers finally watch where they are going. Anything inside a hull-clearance bubble drops them to a crawl on contact — especially when rolling back into the crowded colony yard.',
    bullets: [
      'Hull clearance, not centre-to-centre: centreDist − selfR − otherR against 1.5 m (≈5 ft) in open country and 3.0 m inside the pad yard.',
      'Immediate speed drop — no ramp. Open country crawls at 28 %; the yard at 15 %. Never zero, so nose-to-nose pairs keep inching and cannot lock.',
      'Obstacles watched: other rovers, buildings, the landing pod, and discovered (non-buried) sites. Destination of the current goal is skipped inside arrival reach so builders and rescuers still finish the job.',
      'Move power scales with speed so a crawl is a brake, not a battery tax. Covered by tests/sim/proximity.test.ts (7 checks).',
    ],
  },
  {
    sha: 'eeae7d2',
    date: '2026-09-14',
    title: 'Main-menu button alignment + build changelog timeline',
    kind: 'improvement',
    summary:
      'The mission-control shell tightened up: menu buttons finally share a clean optical grid, and the build badge opens a curated flight-recorder of every deploy since Prototype 1.',
    bullets: [
      'Primary and secondary menu buttons use a flex column label with a fixed 28 px icon slot — glyphs stay centred while the two-line title + subtitle stack aligns cleanly.',
      'Build-status badge is a real button (focus ring, hover lift) that opens the changelog overlay.',
      'ChangelogDialog: newest-first vertical timeline with kind badges, YOU ARE HERE / LATEST flags, glass cards, backdrop/×/Esc close, and body scroll lock.',
      'History is hand-curated in src/ui/Changelog.ts from the real Git log — not generated, so the prose stays readable.',
    ],
  },
  {
    sha: 'dd90474',
    date: '2026-09-14',
    version: '0.3.0',
    title: 'In-play update check — save and reload onto newer builds',
    kind: 'feature',
    summary:
      'While a colony runs, the game now watches its own version.json manifest and hands you a one-shot save-and-reload when a newer deploy goes live.',
    bullets: [
      'Vite now ships dist/version.json with every bundle — the manifest is the source of truth for “what is live”.',
      'Poller every ~5 min (overridable via ?updateCheckMs), silent retries, hidden-tab skip and re-arm.',
      '“NEW BUILD AVAILABLE” banner freezes the sim, saves through the normal path, disposes the host, then reloads — with a “Reload anyway” fallback if the save fails.',
      'GitHub API stays the main-menu badge’s source (“where is main?”), manifest stays the in-play source (“what is deployed?”).',
    ],
  },
  {
    sha: 'e06ac93',
    date: '2026-09-14',
    title: 'Update-check internals — manifest & poller',
    kind: 'infra',
    summary:
      'The plumbing behind the in-play check: manifest writer, fetchers, and the UpdateCheck poller unit-tested in isolation.',
    bullets: [
      'buildManifest Vite plugin writes commit + builtAt into version.json at closeBundle time.',
      'latestDeployedCommit() fetches own-origin manifest no-store with per-request cache-buster.',
      'UpdateCheck: interval, hidden-tab skip, exponential backoff on transient GitHub failures.',
      '10 unit checks in tests/app/update-check.test.ts + real-browser smoke at scripts/update-check-smoke.mjs.',
    ],
  },
  {
    sha: 'e5c579c',
    date: '2026-09-14',
    title: 'Camera-scaled dust field & curl-flow storms',
    kind: 'improvement',
    summary:
      'Storm dust no longer turns into a cube when you pull the camera back. Particles are finer, far more numerous, and flow with a wavy, turbulent drift.',
    bullets: [
      'Emission volume and wrap radius now scale with camera altitude/rig radius — fills the view at 30 m and at 1 600 m.',
      'Storm grit shrunk to 0.5 – 1.2 → 1.2 – 2.1 world units and multiplied in count — reads as haze, not cloud puffs.',
      'Curl-style layered sines replace straight streaks; net transport stays downwind (~2.2 + 2.5 k turbulence).',
      'Pool budget held at 9 000 — density via size + count, not unbounded spawns.',
    ],
  },
  {
    sha: 'ddc4463',
    date: '2026-09-13',
    title: 'Weather per-entity sampling + lightning storms',
    kind: 'feature',
    summary:
      'Storms gained a local intensity that advects across the map, and high dust now carries a real lightning risk.',
    bullets: [
      'Dust and opacity sampled per-entity — a rover 20 m away can be in clear air while the colony is hammered.',
      'Lightning strike probability = f(dust %, storm class); calm weather never strikes. Visible flash + colony log + alert.',
      'Deterministic under seeded RNG, difficulty-scaled, with a Dev-Panel “force strike” for testing.',
      'HUD weather cell, forecast and alerts all sample the same spatial field.',
    ],
  },
  {
    sha: 'ff6474f',
    date: '2026-09-13',
    title: 'Dust devils — rolled counts, own paths, pair physics',
    kind: 'feature',
    summary:
      'Desert vortices went from a hard-coded pair to a small, wandering, occasionally colliding ecology.',
    bullets: [
      'Counts rolled per storm class / intensity band (0–4) and held for 2 s — big regional fronts can throw a handful, weak ones sometimes none.',
      'Each devil draws its own wander frequencies, amplitude and wind bias — formations diverge 19–34 m in 15 s while staying downwind.',
      'Contact at 1.15 × summed radii: mutual cancellation, dance (orbit-then-die), consume-and-grow, or twin co-orbit (9–18 s) → split/decay.',
      'Wind ramp spin-up: sharp d(wind)/dt above 0.35 m/s² banks charge and spends it on one devil; capped at 5 total, 6 155 / 9 000 pool worst case.',
    ],
  },
  {
    sha: '4852271',
    date: '2026-09-13',
    title: 'Dynamic colony soundscape',
    kind: 'feature',
    summary:
      'Audio moved off autoplay promises into a reactive mix: menu ambience, colony wind/storm/machinery, brownout reminders, and confirmation cues for every player and dev command.',
    bullets: [
      'Browser-friendly activation on first gesture; paused sessions keep wind/storm audible so inspection never goes silent.',
      'Time-bound machinery fades on pause, ambient and warnings remain.',
      'Per-Rover automation levers and every dev edit emit their own short confirmation.',
    ],
  },
  {
    sha: 'cba4e84',
    date: '2026-09-13',
    title: 'Selection ring — true circle + pulsing white glow · Mobile one-finger pan',
    kind: 'fix',
    summary:
      'Two long-standing visual and control complaints fixed together: the selection ellipse and the “pan barely moves” phone camera.',
    bullets: [
      'Ring now uniformly scaled (1.4 unit geometry ÷ entity radius), even thickness at every zoom, +0.2 ground offset unchanged.',
      'Additive halo 1.18 × wider, 3.2 × thicker, ring 0.72→1.0 and halo 0.16→0.42 over a 1.9 s sim-time cosine — freezes when paused.',
      'Touch: one-finger drag pans 1:1; two-finger look orbits only when one finger is resting, pinch still dollies — travel now measured from gesture start, dolly classified vs look on accumulated drift.',
      'Desktop Shift-drag / middle-drag and wheel unchanged.',
    ],
  },
  {
    sha: 'bb15557',
    date: '2026-09-13',
    title: 'Dev panel: master switch decoupled from visibility',
    kind: 'improvement',
    summary:
      'Developer mode finally behaves like a proper tool — closing the panel no longer kills the mode, and the 🛠 toggle and ⌘ panels track each other cleanly.',
    bullets: [
      '`DevMode.enabled` became the source of truth; panel visibility is independent state.',
      'Master toggle lives at the top of the panel with a live “enabled” badge and an UNSAVED reminder.',
      'Host overlay keeps the battery pin alive without per-frame pokes from the UI.',
    ],
  },
  {
    sha: 'ea0980c',
    date: '2026-09-11',
    version: '0.2.8',
    title: 'Mars terrain — MOLA relief + PBR atlas + broad hills',
    kind: 'feature',
    summary:
      'Procedural terrain graduated from Perlin-only to a composite that samples real Mars relief and respects material physics.',
    bullets: [
      'Compact MOLA height sampling blended with fractal broad hills (octaves tuned against overhead captures).',
      'PBR atlas wired: albedo / ao / normal / roughness / metallic / height read per texel — specular now follows slope and dust.',
      'Seeded 1 280 m claim generation kept deterministic; deposits sit where geology says they should.',
    ],
  },
  {
    sha: '4a7bd23',
    date: '2026-09-11',
    title: 'GDD & TDD realigned to Prototype 4 + exploration',
    kind: 'infra',
    summary:
      'Design docs were brought back to what the build actually does — no phantom systems, no silent divergence.',
    bullets: [
      'Implementation status tables (IN / PARTIAL / OUT) across §§16 and 25; roadmap gates T1–T5 IN, T6 partial.',
      'Deliberate locks named (fluids never ride rovers, per-resource storage, soft rover failure, dev overlays unbaked).',
      'Architecture diagrams updated for the SimHost boundary and the conditional worker.',
    ],
  },
  {
    sha: '17bd2ea',
    date: '2026-09-11',
    title: 'Points of interest, salvage and Earth supply drops',
    kind: 'feature',
    summary:
      'The map finally had somewhere to go: seeded wrecks and caches the world never shows until a rover finds them.',
    bullets: [
      'POIs discovered by proximity — SALVAGE task cuts the wreck apart and hauls it home.',
      'Cargo missions land under a transponder and slowly bury if nobody goes out for them.',
      'First slice of T6: no survey confidence or narrative logs yet, but the loop Explore → Extract → Salvage is closed.',
    ],
  },
  {
    sha: 'afd7ef0',
    date: '2026-09-11',
    title: 'The simulation behind a host — worker default + placement acks',
    kind: 'feature',
    summary:
      'The colony was pulled behind a narrow SimHost seam so it can live either in-process or inside a module worker without the UI noticing.',
    bullets: [
      'LocalSimHost (in-process) and WorkerSimHost (module worker) behind createHost / restoreHost / planHost(?worker=0).',
      'View payload + terrain re-derived from seed on the mirror; commands remain the only writes.',
      'Placement requests now await a host acknowledgement — the new building ID is allocated by the sim, not guessed by the UI.',
      'Worker-smoke suite boots the game in headless Chromium and asserts the boundary twice (once per transport).',
    ],
  },
  {
    sha: 'fe0fb2d',
    date: '2026-09-10',
    title: 'True particle system — wind, storm grit, dust devils, rover trails',
    kind: 'feature',
    summary:
      'Weather stopped being numbers on a panel and became something you can see moving across the ground.',
    bullets: [
      'GPU-point pool (9 000) with additively-blended size-attenuated quads; wind emitter + storm emitter + DustDevil manager.',
      'Rover dust trails and per-wheel kicks driven by speed, load and ground dust.',
      'ParticlePoints / ParticlePool budgeted so severe storms still hold headroom at 60 fps.',
    ],
  },
  {
    sha: 'ae83aef',
    date: '2026-09-09',
    version: '0.2.0',
    title: 'Mission menu overhaul — splash, main menu, wizard, load screen',
    kind: 'feature',
    summary:
      'A full mission-control shell replaced the raw overlay: art-backed splash, orbital menu, multi-step new-game wizard, and a saved-games browser.',
    bullets: [
      'GlobePicker with 18 landing regions, difficulty presets (Pioneer / Survivor), and seed world-size matrix.',
      'Splash + loading screens with staged progress, blurred orbital backdrop, and time-accurate sol clock.',
      'localStorage slots with renames, deletes and “Continue last expedition” affordance.',
    ],
  },
  {
    sha: 'a121589',
    date: '2026-09-09',
    title: 'Martian globe terrain, 1 280 m map, rover nav grid',
    kind: 'feature',
    summary:
      'The world went from an infinite plane to a framed claim on a proper Mars globe with honest navigation.',
    bullets: [
      'Signed-distance field globe with selectable landing ellipses; navgrid bakes slopes into driveability.',
      'Headlights + rear strobe per rover (battery-drawn), with a yellow emergency strobe when stranded.',
      'Camera rig clamped to claim bounds, dolly limits tuned to globe curvature.',
    ],
  },
  {
    sha: '4e110f4',
    date: '2026-09-09',
    version: '0.1.8',
    title: 'Prototype 4 — rover logistics: queues, haul routes, garage, wear & recovery',
    kind: 'feature',
    summary:
      'Fleet play arrived: queueable orders, looping haul routes, reservations that spread the fleet, and a garage that keeps drivetrains honest.',
    bullets: [
      'Shift+order queue, “Wait 1 m”, repeating mine with depot-full pause, and per-Rover auto-haul / auto-maintenance / shelter / rescue + charge floor.',
      'Reservation system prevents seam dogpiling; rich seams share, scrap heaps don’t.',
      'Rover Garage: 40 kW fast charge, drivetrain service back to 100 %, assembly line for utility / mining / cargo rovers.',
      'Wear → half-rate grind; stranded battery-flat rovers flash and are jump-started by a second rover.',
    ],
  },
  {
    sha: '0584ed1',
    date: '2026-09-08',
    version: '0.1.6',
    title: 'Prototype 3 — wind, dust, storms, and degradation',
    kind: 'feature',
    summary:
      'Weather became a survival pressure: wind, dust that buries panels, forecastable regional/severe/planetary storms and bulk hardware degradation.',
    bullets: [
      'WindSpeed / dust accumulation model with forecast window and HUD severity badge.',
      'Storm scheduler with device-rattle intensities and solar dimming.',
      'Panel burial + rover drivetrain wear that forces maintenance loops.',
    ],
  },
  {
    sha: '7ac7195',
    date: '2026-09-08',
    version: '0.1.3',
    title: 'Prototype 2 — power grid, Mars sol, and life support',
    kind: 'feature',
    summary:
      'The sol turned once and the lights stayed on: a deterministic power resolver, compressed Martian time, and the chain that keeps one human breathing.',
    bullets: [
      'Tiered power grid (0 life support → 3 logistics), solar tilt-tracking, batteries and the 14 kW RTG.',
      'Mars sol 24 h 39 m → 4 min at 1× with one authoritative Sun driving generation, growth, sky and shadows.',
      'Water → oxygen → food chain (Extractor → Generator → Greenhouse → Habitat + 55 % recycler) with empty-in countdowns.',
    ],
  },
  {
    sha: 'dc08039',
    date: '2026-09-08',
    version: '0.1.0',
    title: 'Prototype 1 — 3D vertical slice on the Red Planet',
    kind: 'feature',
    summary:
      'First playable: seeded terrain and deposits, two rovers, staged building placement, and a HUD that tells you you’re about to run out of air.',
    bullets: [
      'Three.js WebGL2 claim with orbit camera, raycast build ghost, and deterministic 20 Hz sim.',
      'Mining, inventory, staged construction and localStorage saves (v3).',
      'Design docs (GDD/TDD) + headless determinism, power and colony suites to keep the numbers honest.',
    ],
  },
];

export interface ChangelogDialogOptions {
  currentSha: string | null;
  latestSha: string | null;
  onClose: () => void;
}

/**
 * Neat, mission-control timeline — glass cards on a vertical rail, newest first.
 * Pure DOM; caller mounts it and disposes onClose.
 */
export class ChangelogDialog {
  readonly root: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;

  constructor(opts: ChangelogDialogOptions) {
    const current = opts.currentSha?.toLowerCase() ?? null;
    const latest = opts.latestSha?.toLowerCase() ?? null;

    const root = document.createElement('div');
    root.className = 'rf-changelog-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Changelog — Build history');

    const currentShort = current ? current.slice(0, 7) : null;
    const latestShort = latest ? latest.slice(0, 7) : null;

    root.innerHTML = `
      <div class="rf-changelog-card" role="document">
        <div class="rf-changelog-head">
          <div>
            <div class="rf-kicker" style="margin-bottom:4px">Flight recorder · Build history</div>
            <h2 class="rf-changelog-title">Changelog</h2>
            <p class="rf-changelog-sub">Every deployed build since Prototype&nbsp;1 — what shipped, what was fixed, and what came next. Newest first.</p>
          </div>
          <button class="rf-icon-btn rf-changelog-close" type="button" aria-label="Close changelog">✕</button>
        </div>
        <div class="rf-changelog-meta">
          <span class="rf-changelog-pill">Prototype 5 · deterministic sim</span>
          ${
            currentShort
              ? `<span class="rf-changelog-pill current">You are on <b>${currentShort}</b></span>`
              : `<span class="rf-changelog-pill">Build unknown</span>`
          }
          ${
            latestShort && latestShort !== currentShort
              ? `<span class="rf-changelog-pill latest">Latest on main · ${latestShort}</span>`
              : ''
          }
          <span class="rf-changelog-count">${CHANGELOG.length} builds</span>
        </div>
        <div class="rf-changelog-body rf-scroll">
          <div class="rf-timeline">
            ${CHANGELOG.map((entry) => {
              const isCurrent = current ? entry.sha.toLowerCase() === current.slice(0, 7) : false;
              const isLatest = entry === CHANGELOG[0];
              const kindLabel =
                entry.kind === 'feature'
                  ? 'Feature'
                  : entry.kind === 'fix'
                    ? 'Fix'
                    : entry.kind === 'improvement'
                      ? 'Improvement'
                      : 'Infra';
              return `
                <div class="rf-tl-row ${isCurrent ? 'is-current' : ''} ${isLatest ? 'is-latest' : ''}">
                  <div class="rf-tl-rail" aria-hidden="true">
                    <span class="rf-tl-dot"></span>
                    <span class="rf-tl-line"></span>
                  </div>
                  <div class="rf-tl-card">
                    <div class="rf-tl-meta">
                      <span class="rf-tl-date">${entry.date}</span>
                      <span class="rf-tl-sha" title="${entry.sha}">${entry.sha}</span>
                      ${entry.version ? `<span class="rf-tl-ver">${entry.version}</span>` : ''}
                      <span class="rf-tl-badge ${entry.kind}">${kindLabel}</span>
                      ${isCurrent ? `<span class="rf-tl-now">You are here</span>` : ''}
                      ${isLatest && !isCurrent ? `<span class="rf-tl-now latest-dot">Latest</span>` : ''}
                    </div>
                    <h3 class="rf-tl-title">${entry.title}</h3>
                    <p class="rf-tl-desc">${entry.summary}</p>
                    <ul class="rf-tl-list">
                      ${entry.bullets.map((b) => `<li>${b}</li>`).join('')}
                    </ul>
                  </div>
                </div>`;
            }).join('')}
          </div>
          <div class="rf-changelog-foot">
            <span>Curated from Git history — full log at <code>github.com/iant89/red-frontier</code>.</span>
            <span class="rf-changelog-legend">
              <i class="lg-dot feature"></i> Feature
              <i class="lg-dot fix"></i> Fix
              <i class="lg-dot improvement"></i> Improvement
              <i class="lg-dot infra"></i> Infra
            </span>
          </div>
        </div>
      </div>`;

    // Click on backdrop closes; click inside card does not.
    root.addEventListener('click', (e) => {
      if (e.target === root) opts.onClose();
    });
    const closeBtn = root.querySelector('.rf-changelog-close') as HTMLButtonElement;
    closeBtn.addEventListener('click', opts.onClose);

    this.onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') opts.onClose();
    };
    window.addEventListener('keydown', this.onKey);

    this.root = root;
  }

  mount(parent: HTMLElement = document.body): void {
    parent.appendChild(this.root);
    // Focus the close button for keyboard users.
    (this.root.querySelector('.rf-changelog-close') as HTMLElement | null)?.focus();
    // Prevent the orbital canvas from taking wheel events while the timeline scrolls.
    document.body.style.overflow = 'hidden';
  }

  unmount(): void {
    window.removeEventListener('keydown', this.onKey);
    document.body.style.overflow = '';
    this.root.remove();
  }
}
