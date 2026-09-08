/**
 * Centralised alert bus (TDD §19).
 *
 * Two distinct concepts, easy to conflate:
 *
 * - **Log events** are things that *happened* once. They stream into the colony
 *   log and scroll away. "Warehouse online."
 * - **Alerts** are conditions that are *currently true*. They are raised, they
 *   persist while the condition holds, and they clear when it stops. "Oxygen
 *   reserve critical."
 *
 * Keeping them separate is what stops the log turning into 200 identical lines
 * during a brownout. Alerts are keyed, so re-raising an active alert just
 * refreshes it instead of spamming.
 */

export type Severity = 'crit' | 'warn' | 'info' | 'ok' | 'opportunity';

export const SEVERITY_RANK: Record<Severity, number> = {
  crit: 0,
  warn: 1,
  opportunity: 2,
  info: 3,
  ok: 4,
};

export interface LogEvent {
  severity: Severity;
  text: string;
  /** Sim time (game seconds) at which it happened. */
  time: number;
  /** Formatted sol stamp, e.g. "Sol 3 · 14:02". */
  stamp: string;
}

export interface Alert {
  /** Stable key, e.g. `oxygen-low`. Re-raising refreshes rather than duplicates. */
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Sim time the condition was first observed. */
  since: number;
  /** Optional entity to focus when the player clicks the alert. */
  entityId?: number;
  /** Bumped every time the condition is re-observed; lets the UI show duration. */
  lastSeen: number;
}

export class AlertBus {
  private active = new Map<string, Alert>();
  private log: LogEvent[] = [];
  private pending: LogEvent[] = [];
  private maxLog = 200;

  /** Record a one-off occurrence. */
  event(severity: Severity, text: string, time: number, stamp: string): void {
    const ev: LogEvent = { severity, text, time, stamp };
    this.log.push(ev);
    this.pending.push(ev);
    while (this.log.length > this.maxLog) this.log.shift();
  }

  /**
   * Assert that a condition currently holds. Emits a log line only on the
   * transition from inactive → active.
   */
  raise(
    key: string,
    severity: Severity,
    title: string,
    detail: string,
    time: number,
    stamp: string,
    entityId?: number,
  ): void {
    const existing = this.active.get(key);
    if (existing) {
      existing.lastSeen = time;
      existing.detail = detail;
      // An escalation (warn → crit) is worth announcing again.
      if (SEVERITY_RANK[severity] < SEVERITY_RANK[existing.severity]) {
        existing.severity = severity;
        existing.title = title;
        this.event(severity, `${title} — ${detail}`, time, stamp);
      }
      return;
    }
    const alert: Alert = {
      key,
      severity,
      title,
      detail,
      since: time,
      lastSeen: time,
      entityId,
    };
    this.active.set(key, alert);
    this.event(severity, `${title} — ${detail}`, time, stamp);
  }

  /** Withdraw a condition. Optionally announces the recovery. */
  clear(key: string, time: number, stamp: string, resolvedText?: string): void {
    if (!this.active.has(key)) return;
    this.active.delete(key);
    if (resolvedText) this.event('ok', resolvedText, time, stamp);
  }

  isActive(key: string): boolean {
    return this.active.has(key);
  }

  /** Active alerts, most severe first, then oldest first. */
  list(): Alert[] {
    return [...this.active.values()].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.since - b.since,
    );
  }

  /** Highest severity currently active, or null. */
  worst(): Severity | null {
    const l = this.list();
    return l.length ? l[0].severity : null;
  }

  /** Pull log lines emitted since the last drain (UI consumes these). */
  drain(): LogEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  history(): LogEvent[] {
    return this.log;
  }

  reset(): void {
    this.active.clear();
    this.log = [];
    this.pending = [];
  }

  snapshot(): object {
    return {
      active: [...this.active.values()].map((a) => ({
        key: a.key,
        severity: a.severity,
        title: a.title,
        detail: a.detail,
        since: a.since,
        // lastSeen is part of authoritative state (restores must replay
        // identically), not UI cosmetics.
        lastSeen: a.lastSeen,
        entityId: a.entityId,
      })),
      // The whole retained history, not a tail: a restored colony must be
      // byte-identical to the one that was saved, determinism tests included.
      log: this.log.slice(),
    };
  }

  restore(data: any): void {
    this.reset();
    for (const a of data?.active ?? []) {
      if (typeof a?.key !== 'string') continue;
      this.active.set(a.key, {
        key: a.key,
        severity: a.severity ?? 'info',
        title: a.title ?? a.key,
        detail: a.detail ?? '',
        since: a.since ?? 0,
        lastSeen: a.lastSeen ?? a.since ?? 0,
        entityId: a.entityId,
      });
    }
    for (const e of data?.log ?? []) {
      if (typeof e?.text !== 'string') continue;
      this.log.push({
        severity: e.severity ?? 'info',
        text: e.text,
        time: e.time ?? 0,
        stamp: e.stamp ?? '',
      });
    }
  }
}
