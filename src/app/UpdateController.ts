/**
 * Phase 19 — in-play update check / notice save-reload-later wiring.
 * Move-not-redesign from Game.ts (onNewBuild / updateNotice*).
 */

import { BUILD_COMMIT } from '../ui/BuildStatus';
import type { HUD } from '../ui/HUD';
import type { AudioSystem } from '../audio/AudioSystem';
import { UpdateCheck, updateCheckIntervalOverride, type UpdateFound } from './UpdateCheck';

export interface UpdateControllerDeps {
  hud: HUD;
  audio: AudioSystem;
  /** True while a save snapshot request is outstanding. */
  isSaveInFlight: () => boolean;
  setSaveContext: (ctx: 'auto' | 'manual' | 'menu' | 'update') => void;
  save: (quiet: boolean, onDone?: (ok: boolean, stamp: string) => void) => void;
  leaveToMenu: (reloadMs?: number) => void;
}

export class UpdateController {
  /** In-play update check while a colony runs (TDD §23); null in dev mode. */
  updateCheck: UpdateCheck | null = null;
  /** The speed to restore when the player dismisses the update card. */
  updateNoticeSpeed = 1;

  constructor(private readonly d: UpdateControllerDeps) {}

  /** Start the production-only in-play poller after a colony launches. */
  start(): void {
    if (!import.meta.env.PROD) return;
    this.updateCheck = new UpdateCheck({
      current: BUILD_COMMIT,
      intervalMs: updateCheckIntervalOverride(),
      onFound: (latest) => this.onNewBuild(latest),
    });
    this.updateCheck.start();
  }

  stop(): void {
    this.updateCheck?.stop();
    this.updateCheck = null;
  }

  /**
   * A newer build is live (TDD §23). The check has already stopped itself —
   * one notice per session, never a nag. Freeze the colony so the player can
   * read in peace, and raise the update card: it tells them what is new and
   * that continuing means they save and they reload. Nothing saves or reloads
   * by itself — both are the player's clicks, made from the card.
   */
  onNewBuild(found: UpdateFound): void {
    this.updateNoticeSpeed = this.d.hud.speedIdx;
    this.d.hud.setSpeed(0);
    this.d.audio.setPaused(true);
    this.d.hud.showUpdateNotice({
      current: BUILD_COMMIT,
      latest: found.commit,
      notes: found.notes,
    });
    // The card carries this save's progress and its failure fallback, so the
    // save-failed prompt must not pile on top of it (see onSaveFailure).
    this.d.setSaveContext('update');
  }

  /** The update card's "Save colony": the normal save, reported back to the card. */
  updateNoticeSave(): void {
    if (!this.d.hud.isUpdateNoticeOpen() || this.d.isSaveInFlight()) return;
    this.d.setSaveContext('update');
    this.d.hud.updateNoticeSaving();
    this.d.save(false, (ok, stamp) => {
      // ok === true: offer the reload. ok === false: onSaveFailure has already
      // put the failure and the retry on the card (update context).
      if (ok) this.d.hud.updateNoticeSaved(stamp);
    });
  }

  /**
   * The update card's "Reload now" — offered only after a successful save.
   * This is the player's own reload; the page never does it on a timer.
   */
  updateNoticeReload(): void {
    if (!this.d.hud.isUpdateNoticeOpen()) return;
    this.d.hud.hideUpdateNotice();
    this.d.setSaveContext('auto');
    this.d.leaveToMenu(0);
  }

  /** The update card's "Later" (or Esc): keep playing this build; the check is over. */
  updateNoticeLater(): void {
    if (!this.d.hud.isUpdateNoticeOpen()) return;
    this.d.hud.hideUpdateNotice();
    this.d.hud.setSpeed(this.updateNoticeSpeed);
    this.d.audio.setPaused(this.d.hud.speedIdx === 0);
    this.d.setSaveContext('auto');
  }
}
