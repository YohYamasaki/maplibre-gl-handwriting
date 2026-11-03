import type { StrokeData, StrokeOp, StrokeStore } from './core/stroke'
import { boundsOf, intersects, union, type Bounds } from './bounds'
import { mercatorPerPixelAt } from './mercator'
import { RunningMax } from './RunningMax'

/** Deepest quadtree level. A cell there is about a metre across, far below any stroke's size */
const MAX_LEVEL = 24

/**
 * At a level where the query box covers more cells than this, the cells that hold strokes
 * are scanned instead of looking up every covered cell
 */
const MAX_LOOKUPS_PER_LEVEL = 16

type Entry = { bounds: Bounds; level: number; cell: number; widthMercator: number }

/**
 * Spatial index of a store's strokes for hit tests: a linear quadtree over Web Mercator space.
 * Each stroke is filed under the smallest quadtree cell (a map tile) that holds its whole center line,
 * so a query only looks at the cells around the query box on each level. Kept in sync with the store
 */
export class StrokeIndex {
  // Per level, the IDs of the strokes filed under each cell, by cell number (x * 2^level + y)
  private levels = Array.from({ length: MAX_LEVEL + 1 }, () => new Map<number, Set<string>>())
  private entries = new Map<string, Entry>()
  /** Widest stroke indexed now, in Web Mercator units; 0 with none */
  maxWidthMercator = 0
  private widths = new RunningMax()
  private unsubscribe: () => void

  constructor(private store: StrokeStore) {
    for (const stroke of store.values()) this.add(stroke)
    this.unsubscribe = store.subscribe(this.onOp)
  }

  /** Stops following the store */
  destroy(): void {
    this.unsubscribe()
  }

  /** IDs of the strokes whose center line bounds intersect `box` */
  search(box: Bounds): string[] {
    const found: string[] = []
    for (let level = 0; level <= MAX_LEVEL; level++) {
      const cells = this.levels[level]
      if (cells.size === 0) continue
      const size = 2 ** level
      const toCell = (v: number) => Math.min(size - 1, Math.max(0, Math.floor(v * size)))
      const minX = toCell(box.minX)
      const maxX = toCell(box.maxX)
      const minY = toCell(box.minY)
      const maxY = toCell(box.maxY)
      const covered = (maxX - minX + 1) * (maxY - minY + 1)
      if (covered <= MAX_LOOKUPS_PER_LEVEL) {
        for (let x = minX; x <= maxX; x++) {
          for (let y = minY; y <= maxY; y++) this.collect(cells.get(x * size + y), box, found)
        }
      } else {
        for (const [cell, ids] of cells) {
          const x = Math.floor(cell / size)
          const y = cell % size
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) this.collect(ids, box, found)
        }
      }
    }
    return found
  }

  private collect(ids: Set<string> | undefined, box: Bounds, found: string[]): void {
    for (const id of ids ?? []) {
      if (intersects(this.entries.get(id)!.bounds, box)) found.push(id)
    }
  }

  private onOp = (op: StrokeOp): void => {
    switch (op.type) {
      case 'points': {
        // A stroke being drawn grows, so it may need a larger cell
        const stroke = this.store.get(op.id)
        if (stroke) this.add(stroke, boundsOf(op.pts))
        break
      }
      case 'remove':
        this.remove(op.id)
        break
      case 'split':
        this.remove(op.id)
        for (const piece of op.pieces) {
          const stroke = this.store.get(piece.id)
          if (stroke) this.add(stroke)
        }
        break
      case 'transform':
        // The strokes were moved in place; refiling recomputes their bounds and width
        for (const id of op.ids) {
          const stroke = this.store.get(id)
          if (stroke) this.add(stroke)
        }
        break
      case 'replace':
        for (const stroke of op.strokes) this.add(stroke)
        break
      case 'reset':
        for (const cells of this.levels) cells.clear()
        this.entries.clear()
        this.widths.clear()
        this.maxWidthMercator = 0
        for (const stroke of op.strokes) this.add(stroke)
        break
      case 'load':
        for (const stroke of op.strokes) this.add(stroke)
        break
      case 'restore':
        this.add(op.stroke)
        break
    }
  }

  /** Files a stroke, or refiles it with its bounds grown by `grownBy` */
  private add(stroke: StrokeData, grownBy?: Bounds): void {
    if (stroke.points.length === 0) return
    const previous = this.entries.get(stroke.id)
    const bounds = previous && grownBy ? union(previous.bounds, grownBy) : boundsOf(stroke.points)
    if (previous) this.remove(stroke.id)
    const { level, cell } = cellOf(bounds)
    let ids = this.levels[level].get(cell)
    if (!ids) this.levels[level].set(cell, (ids = new Set()))
    ids.add(stroke.id)
    const widthMercator = stroke.width * mercatorPerPixelAt(stroke.zoom)
    this.entries.set(stroke.id, { bounds, level, cell, widthMercator })
    this.widths.add(widthMercator)
    this.maxWidthMercator = Math.max(0, this.widths.max())
  }

  private remove(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const cells = this.levels[entry.level]
    const ids = cells.get(entry.cell)!
    ids.delete(id)
    if (ids.size === 0) cells.delete(entry.cell)
    this.entries.delete(id)
    this.widths.remove(entry.widthMercator)
    this.maxWidthMercator = Math.max(0, this.widths.max())
  }
}

/** The deepest cell that holds the whole box: the level where both corners first fall into different cells, minus one */
function cellOf(bounds: Bounds): { level: number; cell: number } {
  let level = 0
  while (level < MAX_LEVEL) {
    const size = 2 ** (level + 1)
    const sameX = Math.floor(bounds.minX * size) === Math.floor(Math.min(bounds.maxX * size, size - 1))
    const sameY = Math.floor(bounds.minY * size) === Math.floor(Math.min(bounds.maxY * size, size - 1))
    if (!sameX || !sameY) break
    level++
  }
  const size = 2 ** level
  const toCell = (v: number) => Math.min(size - 1, Math.floor(v * size))
  return { level, cell: toCell(bounds.minX) * size + toCell(bounds.minY) }
}
