/**
 * Phase 19 — save / load UI hand-off / autosave state.
 *
 * CRITICAL: onDone-ordered teardown. `leaveToMenu` must run only from the
 * save's `onDone` (or an explicit abandon) — never before the write settles.
 * That ordering fixed "Save failed — the colony could not be read".
 *
 * `saveContext: 'auto' | 'manual' | 'menu' | 'update'` phrasing/visibility
 * rules must stay identical (HUD frost, save-failed prompt, update card).
 *
 * Move-not-redesign from Game.ts.
 */

import type { SimHost, SimView } from '../sim/host';
import { AUTOSAVE_INTERVAL_S } from '../sim/config';
import { WORLD_SIZES } from '../sim/difficulty';
import type { WorldSizeId } from '../sim/difficulty';
import type { SaveStore } from '../ui/SaveStore';
import type { NewSaveInput } from '../ui/SaveStore';
import type { HUD } from '../ui/HUD';
import type { AudioSystem } from '../audio/AudioSystem';
import type { UpdateCheck } from './UpdateCheck';

/**
 * Reverse-look up a world size from the world's half-extent, for the
 * expedition tab and the "save as new file" identity when the slot's meta is
 * missing. Falls back to the classic campaign size.
 */
export function worldSizeFromHalf(half: number): WorldSizeId {
  for (const [id, def] of Object.entries(WORLD_SIZES)) {
    if (def.worldHalf === half) return id as WorldSizeId;
  }
  return 'medium';
}

export interface SaveControllerDeps {
  getHost: () => SimHost | null;
  getSim: () => SimView | null;
  getSaveId: () => string | null;
  setSaveId: (id: string | null) => void;
  getStore: () => SaveStore;
  getStarted: () => boolean;
  setStarted: (v: boolean) => void;
  hud: HUD;
  audio: AudioSystem;
  closePauseMenu: () => boolean;
  getUpdateCheck: () => UpdateCheck | null;
  detachDev: () => void;
  disposeHost: () => void;
}

export class SaveController {
  /**
   * What the in-flight save is for. The save-failed prompt phrases its
   * options by context: a *menu* hand-off can offer "return without saving",
   * an *update* save defers to the update banner, *auto* saves only prompt
   * while the player is actually looking.
   */
  saveContext: 'auto' | 'manual' | 'menu' | 'update' = 'auto';
  /** Whether a save is currently in flight (snapshot request outstanding). */
  saveInFlight = false;
  /** The most recent save's outcome, for the expedition tab. */
  lastSave: { at: number | null; ok: boolean | null } = { at: null, ok: null };
  /** Seconds between autosaves, 0 = off; read from settings at launch. */
  autosaveSec: number = AUTOSAVE_INTERVAL_S;

  constructor(private readonly d: SaveControllerDeps) {}

  /**
   * Persist the colony. `quiet` suppresses the progress dialog, flash and
   * sound (autosaves, the tab-hide save); `onDone` reports the outcome to
   * callers that must act on it — the return-to-menu hand-off is the one that
   * does (and must: it is not allowed to dispose the host until this settles).
   *
   * A user-initiated save gets the full-screen progress dialog; a failed save
   * turns it into the save-failed prompt with recovery options, rather than a
   * toast the player reads half a second too late.
   */
  save(quiet = false, onDone?: (ok: boolean, stamp: string) => void): void {
    const host = this.d.getHost();
    const id = this.d.getSaveId();
    if (!host || !id) {
      // No slot to write into. A user-initiated save is still recoverable:
      // the prompt's "save as new file" creates the missing slot.
      if (!quiet) {
        this.d.hud.showSaveError('read', this.saveContext === 'menu');
      }
      onDone?.(false, '');
      return;
    }
    // Everything about the payload — reading the world, serialising it, and the
    // sol it is stamped with — is taken *before* the handoff, so an autosave can
    // never interleave two colonies if the mission ends mid-write.
    const sol = host.view.clock.sol + 1;
    const stamp = host.view.clock.format();
    if (!quiet)
      this.d.hud.saveProgressStart(
        this.saveContext === 'menu' ? 'Returning to main menu' : 'Saving colony',
      );
    // TDD §20 budgets a save at 1–2 s of user-visible time; asking the host for
    // the snapshot instead of building it here is how that stays off the frame
    // loop once the sim runs on its own thread.
    this.saveInFlight = true;
    void host
      .requestSnapshot()
      .then(
        (snapshot) => {
          try {
            if (!quiet) this.d.hud.saveProgressStage(2);
            this.d.getStore().update(id, snapshot, sol);
            this.lastSave = { at: Date.now(), ok: true };
            if (!quiet) {
              this.d.hud.saveProgressEnd(true);
              this.d.hud.flashSave(`Saved · ${stamp}`);
              this.d.audio.saved();
            }
            onDone?.(true, stamp);
          } catch (e) {
            // Quota is the realistic failure here; the snapshot was good, the
            // disk said no.
            console.error(e);
            this.onSaveFailure('storage', quiet, onDone);
          }
        },
        (e) => {
          console.error(e);
          this.onSaveFailure('read', quiet, onDone);
        },
      )
      .finally(() => {
        this.saveInFlight = false;
      });
  }

  /**
   * One place that decides how a failed save is surfaced: the prompt, when
   * the player can see it and can act; a logged line plus a toast, when they
   * cannot (a background autosave in a hidden tab). The caller always gets
   * `onDone(false)` either way.
   */
  onSaveFailure(
    kind: 'read' | 'storage',
    quiet: boolean,
    onDone: ((ok: boolean, stamp: string) => void) | undefined,
  ): void {
    this.lastSave = { at: Date.now(), ok: false };
    if (!quiet) this.d.hud.saveProgressEnd(false);
    const visible = document.visibilityState !== 'hidden';
    if (this.saveContext === 'update') {
      // The update card owns this failure: it is on screen, the player is
      // reading it, and it already offers the recovery (retry / keep playing).
      // A save-failed prompt would sit on top of the card and compete with it.
      this.d.hud.updateNoticeSaveFailed(kind);
    } else if (!quiet || visible) {
      this.d.hud.showSaveError(kind, this.saveContext === 'menu');
    } else {
      this.d.hud.flashSave('Save failed — the colony could not be saved');
    }
    this.d.hud.addLog(
      'warn',
      `Save failed${kind === 'storage' ? ' — browser storage full' : ' — the colony could not be read'}. ` +
        `Your last successful save is unchanged.`,
    );
    this.d.audio.reject();
    onDone?.(false, '');
  }

  /** A manual save from the pause menu (or Ctrl+S): full progress dialog. */
  manualSave(): void {
    if (!this.d.getHost() || !this.d.getStarted()) return;
    if (this.saveInFlight || this.d.hud.isSaveProgressOpen()) return;
    this.saveContext = 'manual';
    this.save(false);
  }

  /** The failed-save prompt's "retry": re-run the save in its own context. */
  retrySave(): void {
    if (this.saveContext === 'menu') {
      this.d.hud.hideSaveError();
      this.returnToMenu();
    } else {
      this.d.hud.hideSaveError();
      this.saveContext = 'manual';
      this.save(false);
    }
  }

  /**
   * The failed-save prompt's "save as new file": take a fresh snapshot and
   * write it to a brand-new slot, adopting the current colony's identity.
   * Useful when the existing slot is corrupt or the quota write keeps
   * failing into the same key.
   */
  saveAsNew(): void {
    const host = this.d.getHost();
    if (!host || !this.d.getStarted()) {
      this.d.hud.hideSaveError();
      return;
    }
    const saveId = this.d.getSaveId();
    const meta = saveId ? this.d.getStore().get(saveId) : null;
    const sim = this.d.getSim();
    const input: NewSaveInput = {
      name: meta?.name ?? 'Recovered Colony',
      difficulty: sim?.difficulty ?? meta?.difficulty ?? 'pioneer',
      worldSize: meta?.worldSize ?? (sim ? worldSizeFromHalf(sim.world.half) : 'medium'),
      region: meta?.region ?? sim?.world.region ?? null,
      seedText: meta?.seedText ?? '',
    };
    const sol = host.view.clock.sol + 1;
    this.d.hud.hideSaveError();
    this.d.hud.saveProgressStart('Saving to a new file');
    this.saveInFlight = true;
    void host
      .requestSnapshot()
      .then(
        (snapshot) => {
          this.d.hud.saveProgressStage(2);
          const newId = this.d.getStore().create(input, snapshot, sol);
          this.d.setSaveId(newId);
          this.lastSave = { at: Date.now(), ok: true };
          this.d.hud.saveProgressEnd(true);
          this.d.hud.flashSave('Saved to a new file');
          this.d.audio.saved();
          // If the failed save was the return-to-menu hand-off, the player's
          // intent was to leave — the new file is written, so finish the job.
          if (this.saveContext === 'menu') {
            this.saveContext = 'auto';
            this.leaveToMenu();
          } else {
            this.saveContext = 'manual';
          }
        },
        (e) => {
          console.error(e);
          this.d.hud.saveProgressEnd(false);
          this.d.hud.showSaveError('read', this.saveContext === 'menu');
          this.d.audio.reject();
        },
      )
      .finally(() => {
        this.saveInFlight = false;
      });
  }

  /**
   * The failed-save prompt's "return without saving" (menu context only):
   * the player explicitly chose to leave; the colony goes back as the last
   * successful save left it.
   */
  abandonToMenu(): void {
    this.d.hud.hideSaveError();
    this.d.hud.flashSave('Returned to menu — progress since the last save was not written');
    this.saveContext = 'auto';
    this.leaveToMenu();
  }

  /**
   * Persist the colony and hand control back to the main menu.
   *
   * The hand-off is ordered, because the ordering is the whole bug this used
   * to have: the old code fired the save and disposed the host on the very
   * next line, so with the (default) worker transport the pending snapshot
   * request was rejected as "the colony has shut down" — which is exactly the
   * "Save failed — the colony could not be read" the player saw on every menu
   * click. The dispose now happens only in `onDone`, after the write has
   * settled one way or the other; a failure lands on the save-failed prompt
   * instead of a toast.
   */
  returnToMenu(): void {
    if (!this.d.getStarted()) return;
    this.d.closePauseMenu();
    this.d.getUpdateCheck()?.stop();
    this.saveContext = 'menu';
    this.save(false, (ok) => {
      if (ok) {
        this.saveContext = 'auto';
        this.leaveToMenu();
      }
      // ok === false: onSaveFailure already raised the prompt with Retry /
      // Save-as-new / Return-without-saving for the menu context.
    });
  }

  /**
   * Tear the colony down and let the page reload onto the main menu. Callers
   * have already made the save decision; this only stops the world and goes.
   * A host with a timer inside it must not be left ticking through the
   * reload, which is why this runs after (never before) the save settles.
   */
  leaveToMenu(reloadMs = 700): void {
    this.d.closePauseMenu();
    this.d.getUpdateCheck()?.stop();
    this.d.detachDev();
    this.d.disposeHost();
    this.d.setStarted(false);
    // Fade the live colony layers back to the command-deck bed during the
    // hand-off; a reload creates the same menu scene again on the next page.
    this.d.audio.setScene('menu');
    this.d.audio.setPaused(true);
    // A clean boot is the only honest teardown for a WebGL colony: the menu
    // (and its splash) rebuilds in under a second.
    window.setTimeout(() => window.location.reload(), reloadMs);
  }

  /** Reset save UI state on a fresh colony launch. */
  resetForLaunch(autosaveSec: number): void {
    this.lastSave = { at: null, ok: null };
    this.saveContext = 'auto';
    this.saveInFlight = false;
    this.autosaveSec = autosaveSec;
  }
}
