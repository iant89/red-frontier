/**
 * Phase 21 — Introduce Domain Events (roadmap §25).
 *
 * Plain serializable events + a simple per-tick collector. Not an event bus:
 * no pub/sub, middleware, or async listeners. Systems push; the host drains
 * after a step. AlertBus remains the HUD toast / log channel —
 * `drainDomainEvents` is a separate structured channel for system-to-system
 * and future consumers.
 *
 * Example:
 *   { type: 'rover/disabled', roverId: 42, reason: 'battery-depleted' }
 */

export type DomainEvent =
  | { type: 'rover/moved'; roverId: number; x: number; z: number }
  | {
      type: 'rover/disabled';
      roverId: number;
      reason: 'battery-depleted';
    }
  | {
      type: 'rover/repaired';
      roverId: number;
      reason: 'jump-start' | 'garage-service';
    }
  | {
      type: 'building/placed';
      buildingId: number;
      kind: string;
      x: number;
      z: number;
    }
  | { type: 'rover/part-replaced'; roverId: number; buildingId: number; component: 'motor' | 'circuitBoard' }
  | { type: 'building/completed'; buildingId: number; kind: string }
  | { type: 'building/failed'; buildingId: number; cause: string }
  | {
      type: 'resource/produced';
      resource: string;
      amount: number;
      buildingId?: number;
    }
  | {
      /** A whole manufactured unit came off a bench (P5). */
      type: 'component/crafted';
      component: string;
      amount: number;
      buildingId?: number;
    }
  | {
      type: 'resource/consumed';
      resource: string;
      amount: number;
      buildingId?: number;
    }
  | {
      type: 'power/shortage';
      level: 'critical' | 'warn';
      generationKw: number;
      demandKw: number;
    }
  | { type: 'storm/started'; kind: string }
  | { type: 'storm/ended' }
  | { type: 'poi/discovered'; poiId: number; kind: string }
  | {
      type: 'salvage/recovered';
      poiId: number;
      roverId: number;
      kg: number;
    }
  | { type: 'colonist/critical'; colonistId: number; health: number }
  | { type: 'game/over'; reason: string; sol: number }
  | { type: 'tutorial/milestone'; milestone: string; sol: number }
  | { type: 'tutorial/warning'; warning: string; sol: number }
  | { type: 'tutorial/hint'; hint: string; sol: number };

/** Catalog discriminants — derived from the union so they cannot drift. */
export type DomainEventType = DomainEvent['type'];

/**
 * Per-tick (actually per-drain-window) collector. Systems push; hosts drain
 * after `Simulation.step`. Drained arrays are readonly snapshots.
 */
export class DomainEventLog {
  private pending: DomainEvent[] = [];

  push(event: DomainEvent): void {
    this.pending.push(event);
  }

  /** Clear and return events since the last drain. */
  drain(): ReadonlyArray<DomainEvent> {
    if (this.pending.length === 0) return Object.freeze([]);
    const out = this.pending;
    this.pending = [];
    return Object.freeze(out);
  }

  /** Non-consuming peek (tests / debugging). */
  snapshot(): ReadonlyArray<DomainEvent> {
    return Object.freeze(this.pending.slice());
  }

  get length(): number {
    return this.pending.length;
  }

  clear(): void {
    this.pending = [];
  }
}
