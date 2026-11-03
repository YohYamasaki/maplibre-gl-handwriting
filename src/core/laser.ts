// Laser pointer lines (decision 0078): shown for a moment on every screen, never stored or saved.
// Used by the input, render and sync layers, so it must not depend on DOM / MapLibre / Cloudflare APIs.
import type { Point } from './stroke'

/**
 * Points added to one laser line. `source` tells apart whose line it is: '' for this screen's own lines, the sending
 * connection's session for a line received from the server. `trail` numbers the lines of one source
 */
export type LaserOp = { source: string; trail: number; pts: Point[] }

/** local: drawn on this screen / remote: received from the server */
export type LaserOrigin = 'local' | 'remote'

export type LaserListener = (op: LaserOp, origin: LaserOrigin) => void

/** The largest trail number; the count wraps around to 0 after it, within what the protocol accepts */
export const MAX_LASER_TRAIL = 999_999_999

/**
 * Passes laser ops from whoever draws or receives them to whoever shows or sends them, like StrokeStore does for
 * strokes but holding nothing. Every handle and sync connection given the same channel shares its trail numbers
 */
export class LaserChannel {
  private listeners = new Set<LaserListener>()
  private trail = 0

  /** A trail number for a new line of this screen, different from the ones given before it */
  nextTrail(): number {
    const trail = this.trail
    this.trail = trail >= MAX_LASER_TRAIL ? 0 : trail + 1
    return trail
  }

  emit(op: LaserOp, origin: LaserOrigin): void {
    for (const listener of [...this.listeners]) listener(op, origin)
  }

  /** Calls `listener` with every op emitted from now on. Returns the function that stops it */
  subscribe(listener: LaserListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
