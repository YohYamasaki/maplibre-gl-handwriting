import type { Point } from './core/stroke'

/** How long a laser point stays, in ms from when it was added */
export const LASER_LIFETIME = 1000
/** The most points kept per source; past it, the oldest go first */
export const MAX_LASER_POINTS_PER_SOURCE = 1000

/** One laser line: its points and the time each was added, oldest first */
type Trail = { pts: Point[]; times: number[] }

/**
 * The laser points still alive, per source and trail, each with the time it was added. Knows
 * nothing of the screen: ui/laser.ts draws what it holds
 */
export class LaserTrails {
  private sources = new Map<string, Map<number, Trail>>()
  // When each source last added points: its newest point's time
  private lastAdded = new Map<string, number>()
  private count = 0

  /** How many points are held: those of other sources past their time stay counted until prune */
  get size(): number {
    return this.count
  }

  /**
   * Adds points to a trail at time `now`, after dropping the sources whose newest point has lived its time and
   * that source's points that have. One check per source and a walk of one source's trails, so an add does not
   * cost every live trail, and sources that stopped sending (a reconnect is a new source) go even while prune is
   * not called (a hidden tab draws no frames); prune drops the rest
   */
  add(source: string, trail: number, pts: Point[], now: number): void {
    for (const [other, last] of this.lastAdded) {
      if (now - last < LASER_LIFETIME) continue
      this.dropSource(other)
    }
    let trails = this.sources.get(source)
    if (trails) {
      this.pruneSource(trails, now)
      if (trails.size === 0) this.dropSource(source)
    }
    if (pts.length === 0) return
    trails = this.sources.get(source)
    if (!trails) this.sources.set(source, (trails = new Map()))
    let line = trails.get(trail)
    if (!line) trails.set(trail, (line = { pts: [], times: [] }))
    for (const p of pts) {
      line.pts.push(p)
      line.times.push(now)
    }
    this.count += pts.length
    this.lastAdded.set(source, now)
    this.limit(trails)
  }

  /** Drops the points older than LASER_LIFETIME at `now`, and the trails and sources left empty */
  prune(now: number): void {
    for (const [source, trails] of this.sources) {
      this.pruneSource(trails, now)
      if (trails.size === 0) this.dropSource(source)
    }
  }

  /** Forgets a source and all its points */
  private dropSource(source: string): void {
    for (const line of this.sources.get(source)?.values() ?? []) this.count -= line.pts.length
    this.sources.delete(source)
    this.lastAdded.delete(source)
  }

  private pruneSource(trails: Map<number, Trail>, now: number): void {
    for (const [trail, line] of trails) {
      let dead = 0
      while (dead < line.times.length && now - line.times[dead] >= LASER_LIFETIME) dead++
      if (dead === 0) continue
      this.drop(trails, trail, line, dead)
    }
  }

  /**
   * Calls `fn` with the points of each trail and the age of each point at `now`, 0 (just added) to 1 (about to
   * go). Call prune first, so no point is past its time
   */
  forEach(now: number, fn: (pts: Point[], ages: number[]) => void): void {
    for (const trails of this.sources.values()) {
      for (const line of trails.values()) {
        fn(
          line.pts,
          line.times.map((t) => Math.min(1, Math.max(0, (now - t) / LASER_LIFETIME))),
        )
      }
    }
  }

  /** Forgets every point */
  clear(): void {
    this.sources.clear()
    this.lastAdded.clear()
    this.count = 0
  }

  /** Drops the oldest points of a source until it has at most MAX_LASER_POINTS_PER_SOURCE */
  private limit(trails: Map<number, Trail>): void {
    let total = 0
    for (const line of trails.values()) total += line.pts.length
    while (total > MAX_LASER_POINTS_PER_SOURCE) {
      // The trail whose first point is the oldest, and the oldest first point of the others: trails of one source
      // can be drawn at the same time (two pointers), so their points interleave in time
      let oldest: [number, Trail] | null = null
      let next = Infinity
      for (const entry of trails) {
        const first = entry[1].times[0]
        if (!oldest || first < oldest[1].times[0]) {
          if (oldest) next = Math.min(next, oldest[1].times[0])
          oldest = entry
        } else {
          next = Math.min(next, first)
        }
      }
      const [trail, line] = oldest!
      // Its points up to the others' oldest one, at least one, and no more than are over
      let dead = 1
      const over = total - MAX_LASER_POINTS_PER_SOURCE
      while (dead < over && dead < line.times.length && line.times[dead] <= next) dead++
      this.drop(trails, trail, line, dead)
      total -= dead
    }
  }

  private drop(trails: Map<number, Trail>, trail: number, line: Trail, dead: number): void {
    line.pts.splice(0, dead)
    line.times.splice(0, dead)
    this.count -= dead
    if (line.pts.length === 0) trails.delete(trail)
  }
}
