// Spilling (decisions 0023 to 0025): a StrokeStore writes the points of the strokes nothing holds to a target elsewhere
// (IndexedDB in a browser, src/IndexedDBSpill.ts) and reads them back when they are needed. The target interface and
// the entry points that attach one, spill and detach are the package's own: core/index.ts does not export this module.
// Used by the store, so it must not depend on the DOM, MapLibre or any platform's APIs
import type { StrokeStore } from './stroke'

/** A stroke's points as written: x and y in turn, and its width coefficients when it has them */
export type SpillRecord = { id: string; points: Float64Array; pressure?: Float32Array }

/** Where a store's spilled points are kept. It does the calls in the order they are made, as IndexedDB does */
export interface SpillTarget {
  /** Writes the records, replacing those of the same IDs. Rejects when they could not be written */
  put(records: SpillRecord[]): Promise<void>
  /** The records of these IDs; an ID missing from the result could not be read. Rejects when none could be */
  get(ids: string[]): Promise<Map<string, SpillRecord>>
  /** Deletes the records of these IDs. Rejects when they could not be deleted */
  delete(ids: string[]): Promise<void>
  /** Deletes every record of the store. Rejects when they could not be deleted */
  clear(): Promise<void>
}

export type SpillOptions = {
  target: SpillTarget
  /** The time in ms, from a clock that never goes back (performance.now) */
  now: () => number
  /**
   * Called with what failed: a write, a delete or the target itself, after which the store stops spilling and reads
   * every point back, or a read, after which the strokes not read stay without points
   */
  onError: (error: Error) => void
}

/** How long a stroke nothing holds stays in memory before it is written, in ms */
export const SPILL_DELAY_MS = 1000

/** The most points one write takes; more wait for the next. A stroke of more points than this is never spilled */
export const MAX_SPILL_POINTS = 2 ** 17

/** What a StrokeStore gives the entry points below (registerSpillHost) */
export type SpillHost = {
  attach(options: SpillOptions): boolean
  spill(): Promise<void>
  fail(error: Error): void
  detach(): Promise<void>
}

const hosts = new WeakMap<object, SpillHost>()

/** Called by every StrokeStore once, so that the entry points below reach it */
export function registerSpillHost(store: object, host: SpillHost): void {
  hosts.set(store, host)
}

/**
 * Attaches a target to the store, which then spills its strokes there. Returns false, attaching nothing, for a store
 * made with spill: false. A store holds one target at a time: attaching while one is attached changes nothing
 */
export function attachSpill(store: StrokeStore, options: SpillOptions): boolean {
  return hosts.get(store)?.attach(options) ?? false
}

/**
 * Writes the strokes that have been candidates for SPILL_DELAY_MS or more, up to MAX_SPILL_POINTS points, and drops
 * their points from memory once written. Called about once a second while a target is attached; does nothing while a
 * write of its is under way
 */
export function spillStrokes(store: StrokeStore): Promise<void> {
  return hosts.get(store)?.spill() ?? Promise.resolve()
}

/** The target cannot be used (e.g. it could not be opened): the store stops spilling, reads back, and reports `error` */
export function failSpill(store: StrokeStore, error: Error): void {
  hosts.get(store)?.fail(error)
}

/**
 * Stops spilling, reads every spilled point back, deletes the target's records and lets go of the target. Resolves
 * once that is done, also when some could not be read or deleted (reported to the target's onError)
 */
export function detachSpill(store: StrokeStore): Promise<void> {
  return hosts.get(store)?.detach() ?? Promise.resolve()
}
