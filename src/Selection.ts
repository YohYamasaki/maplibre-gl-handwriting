import type { Point, StrokeOp, StrokeStore } from './core/stroke'
import { applyToPoint, compose, IDENTITY, type Matrix } from './core/transform'
import { boundsOfFlat, grow, union, type Bounds } from './bounds'
import { mercatorPerPixelAt } from './mercator'

/** What changed: the selected strokes, or the transform of the drag in progress */
export type SelectionChange = 'ids' | 'drag'

export type SelectionListener = (change: SelectionChange) => void

/**
 * The strokes the lasso tool selected (only strokes with an order), and the transform of the drag in progress, which is
 * shown but not applied to the strokes until the drag ends. Shared by the select controller, the scene (which draws
 * the selected strokes apart from their buckets) and the frame around them.
 * A selected stroke that is removed, cut or reset away leaves the selection
 */
export class Selection {
  private selected = new Set<string>()
  private dragMatrix: Matrix = IDENTITY
  // The box around each selected stroke, with its width, as it was when the frame was last fitted
  private bounds = new Map<string, Bounds>()
  // The union of `bounds`, made again from them only when the frame is next asked for after it went stale, so a bulk
  // change of the selection (Delete of many strokes) fits it once, not once per stroke
  private box: Bounds | null = null
  private stale = false
  // The transforms applied to the selected strokes since the frame was last fitted
  private placed: Matrix = IDENTITY
  private listeners = new Set<SelectionListener>()
  private unsubscribe: () => void

  constructor(private store: StrokeStore) {
    this.unsubscribe = store.subscribe(this.onOp)
  }

  destroy(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  get ids(): ReadonlySet<string> {
    return this.selected
  }

  get size(): number {
    return this.selected.size
  }

  /** The transform the drag in progress would apply, in normalized Web Mercator coordinates */
  get drag(): Matrix {
    return this.dragMatrix
  }

  has(id: string): boolean {
    return this.selected.has(id)
  }

  /** Selects these strokes instead of the ones selected now. Strokes without an order yet are left out */
  set(ids: Iterable<string>): void {
    const next = new Set([...ids].filter((id) => this.store.get(id)?.order !== undefined))
    const same = next.size === this.selected.size && [...next].every((id) => this.selected.has(id))
    this.dragMatrix = IDENTITY
    if (same) return
    this.selected = next
    this.bounds.clear()
    this.refit(this.selected)
    this.emit('ids')
  }

  /**
   * The corners of the frame around the selection (top left, top right, bottom right, bottom left of the box the
   * strokes had when selected), moved with them and with the drag in progress, in normalized Web Mercator
   * coordinates. Null when nothing is selected
   */
  frame(): Point[] | null {
    if (this.stale) {
      this.box = null
      for (const b of this.bounds.values()) this.box = this.box ? union(this.box, b) : b
      this.stale = false
    }
    if (this.selected.size === 0 || !this.box) return null
    const { minX, minY, maxX, maxY } = this.box
    const m = compose(this.dragMatrix, this.placed)
    return (
      [
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
      ] as Point[]
    ).map((p) => applyToPoint(m, p))
  }

  clear(): void {
    this.set([])
  }

  setDrag(matrix: Matrix): void {
    this.dragMatrix = matrix
    this.emit('drag')
  }

  /** Call the returned function to unsubscribe */
  subscribe(listener: SelectionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(change: SelectionChange): void {
    for (const listener of [...this.listeners]) listener(change)
  }

  private onOp = (op: StrokeOp): void => {
    if (this.selected.size === 0) return
    switch (op.type) {
      case 'remove':
      case 'split':
        if (!this.selected.delete(op.id)) break
        this.bounds.delete(op.id)
        this.refit([])
        this.emit('ids')
        break
      case 'reset':
        this.selected.clear()
        this.bounds.clear()
        this.dragMatrix = IDENTITY
        this.box = null
        this.stale = false
        this.emit('ids')
        break
      case 'transform': {
        // The strokes moved; the frame around them follows. When the transform left some of them where they were
        // (out of range, or not here), no one matrix moves the frame with all of them, so it is made again
        const moved = op.ids.filter((id) => this.selected.has(id))
        if (moved.length === 0) break
        if (moved.length === this.selected.size) this.placed = compose(op.matrix, this.placed)
        else this.refit(moved)
        this.emit('drag')
        break
      }
      case 'replace':
        // Strokes set to another copy of them (e.g. a sync layer's): no matrix says how they moved
        const changed = op.strokes.map((stroke) => stroke.id).filter((id) => this.selected.has(id))
        if (changed.length === 0) break
        this.refit(changed)
        this.emit('drag')
        break
    }
  }

  /**
   * Fits the frame again around the selected strokes as they are now, measuring again the strokes in `changed`.
   * After a transform carried by `placed`, every stroke has moved, so all of them are measured again
   */
  private refit(changed: Iterable<string>): void {
    const measure = this.placed === IDENTITY ? changed : this.selected
    for (const id of measure) {
      const stroke = this.store.get(id)
      if (stroke)
        this.bounds.set(id, grow(boundsOfFlat(stroke.points), (stroke.width * mercatorPerPixelAt(stroke.zoom)) / 2))
      else this.bounds.delete(id)
    }
    this.placed = IDENTITY
    this.stale = true
  }
}
