/**
 * Phase 2 — Entity store: id allocation and entity lookup.
 * Minimal owner for nextId; rovers/buildings arrays live in ColonyState
 * but allocation is centralized here.
 */

export class EntityStore {
  private nextId: number;

  constructor(start = 1000) {
    this.nextId = start;
  }

  allocId(): number {
    return this.nextId++;
  }

  get next(): number {
    return this.nextId;
  }

  set next(v: number) {
    this.nextId = v;
  }

  /** Ensure nextId is at least `min` (used on restore). */
  ensureAtLeast(min: number): void {
    if (this.nextId < min) this.nextId = min;
  }
}
