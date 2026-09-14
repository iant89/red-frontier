/**
 * In-play update check (TDD §23).
 *
 * While a colony is running, poll the page's own origin for the build
 * manifest every few minutes. The Pages workflow ships the bundle and
 * `version.json` as one artifact, so a mismatch between the manifest and
 * this page's stamped commit (`BUILD_COMMIT`) means a newer build is live
 * and a reload will land on it. The GitHub API is deliberately *not* used
 * here: it answers "where is main?" (main can sit ahead of the live deploy
 * — a failed smoke gate blocks publishing while main keeps moving — so a
 * reload would "update" onto the same page), and unauthenticated calls
 * rate-limit per IP, which a per-player 5-minute poll would burn through.
 *
 * The check is one-shot: when a newer build is found it stops and hands
 * over to the Game, which freezes the colony, saves it, and reloads.
 * Transient failures (network, dev server with no manifest) are silent —
 * the next poll simply retries.
 */

import { assessBuild, latestDeployedCommit } from '../ui/BuildStatus';

/** ~5 minutes. The manifest is a few hundred bytes; this is negligible. */
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * QA knob (same family as `?worker=0`): `?updateCheckMs=2000` tightens the
 * poll interval for smoke tests and live previews. Clamped to a 1 s floor so
 * the flag can never be used to hammer the manifest.
 */
export function updateCheckIntervalOverride(): number | undefined {
  try {
    const raw = new URLSearchParams(window.location.search).get('updateCheckMs');
    if (!raw) return undefined;
    const ms = Number(raw);
    return Number.isFinite(ms) && ms >= 1000 ? Math.round(ms) : undefined;
  } catch {
    return undefined; // no DOM/window: keep the default
  }
}

export interface UpdateCheckOptions {
  /** This page's build identity — a validated full commit, or null. */
  current: string | null;
  /** Fires exactly once with the newer commit; the poller then stops. */
  onFound: (latest: string) => void;
  intervalMs?: number;
  fetcher?: typeof fetch;
  /** Test seam; defaults to the page's own manifest. */
  manifestUrl?: () => string;
}

export class UpdateCheck {
  private readonly opts: UpdateCheckOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** One request at a time — a slow fetch must not stack the next poll. */
  private inFlight = false;

  constructor(opts: UpdateCheckOptions) {
    this.opts = opts;
  }

  get active(): boolean {
    return this.running;
  }

  /** Begin polling. A page with no valid build identity has nothing to compare. */
  start(): void {
    if (this.running) return;
    if (!this.opts.current || !assessBuild(this.opts.current, this.opts.current).current) return;
    this.running = true;
    try {
      window.addEventListener('visibilitychange', this.onVisibility);
    } catch {
      /* no window (test harness, non-browser host): always treated as visible */
    }
    // First check runs now: a colony that booted moments after a deploy
    // should be told at once, not five minutes later.
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    try {
      window.removeEventListener('visibilitychange', this.onVisibility);
    } catch {
      /* see start() */
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, delayMs);
  }

  private onVisibility = (): void => {
    // Background tabs get throttled timers, and a reload behind the player's
    // back is worse than a late notice — so a hidden tab skips the check, and
    // returning to the tab re-arms it immediately.
    if (this.running && this.isVisible()) this.schedule(0);
  };

  private isVisible(): boolean {
    try {
      return document.visibilityState === 'visible';
    } catch {
      return true; // no DOM (test harness): assume visible
    }
  }

  private async check(): Promise<void> {
    if (!this.running || this.inFlight || !this.isVisible()) return;
    this.inFlight = true;
    let latest: string;
    try {
      latest = await latestDeployedCommit(
        this.opts.fetcher,
        this.opts.manifestUrl ? this.opts.manifestUrl() : undefined,
      );
    } catch {
      // Network blip, CDN hiccup, or a dev server that ships no manifest:
      // stay quiet and let the next poll retry.
      this.inFlight = false;
      this.schedule(this.opts.intervalMs ?? UPDATE_CHECK_INTERVAL_MS);
      return;
    }
    this.inFlight = false;
    if (!this.running) return; // stopped while the manifest was in flight
    const result = assessBuild(this.opts.current, latest);
    if (result.state === 'old') {
      const newer = result.latest as string;
      this.stop();
      try {
        this.opts.onFound(newer);
      } catch (e) {
        // The hand-off (banner, save, reload) is the Game's; its failure
        // should not escape as an unhandled rejection from a poll.
        console.error('update hand-off failed', e);
      }
      return;
    }
    // 'latest' or 'unknown' (manifest moved under us between polls): keep polling.
    this.schedule(this.opts.intervalMs ?? UPDATE_CHECK_INTERVAL_MS);
  }
}
