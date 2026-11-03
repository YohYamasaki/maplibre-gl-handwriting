import {
  erasedIntervals,
  keptRanges,
  MAX_PIECES_PER_SPLIT,
  mergeIntervals,
  pieceStroke,
  type EraserSweep,
  type PieceRange,
  type StrokePiece,
} from './core/split'
import type { Origin, Point, StrokeData, StrokeOp, StrokeStore } from './core/stroke'
import { boundsOf, grow } from './bounds'
import type { Projector } from './DrawController'
import { findStrokesNear } from './hitTest'
import { mercatorPerPixelAt } from './mercator'
import type { StrokeIndex } from './StrokeIndex'
import type { EraserMode } from './pens'
import type { Cut } from './UndoHistory'

export type EraseOptions = {
  /**
   * Called on every pointerdown with that event. Returns false to ignore the input (e.g. while another tool is
   * selected, or for touch in pen-only input)
   */
  isEnabled: (e: PointerEvent) => boolean
  /** How far from the pointer a stroke's edge is still hit, in CSS px */
  radius: () => number
  /** Size of one CSS px in normalized Web Mercator units at the current zoom */
  pixelSize: () => number
  /** The mode of a gesture, read when it starts */
  mode: () => EraserMode
  /** A new stroke ID for each piece the partial eraser leaves, or null to leave the stroke alone */
  newPieceId: () => string | null
  /** Called at the end of each whole-stroke gesture with the strokes it erased, e.g. to record them for undo */
  onErase: (strokes: StrokeData[]) => void
  /** Called at the end of each partial gesture with the cuts it made, in order */
  onCut: (cuts: Cut[]) => void
}

/**
 * Between a stroke's ID and a number, the ID of a piece shown while the partial eraser is down. Stroke IDs from
 * createHandwriting are `sessionId:seq`, so no stroke in the store has such an ID
 */
const PREVIEW_SEPARATOR = '~'

/** A stroke the partial gesture in progress erases from */
type PendingCut = {
  /** The stroke as it was before the gesture */
  original: StrokeData
  /** The parts of its center line erased so far, as [start, end] positions in order and apart */
  erased: [number, number][]
  /** IDs of the pieces of it shown in its place */
  shown: string[]
}

/**
 * Eraser: while the pointer is down, every stroke it touches is removed as a whole (object eraser), or, in partial
 * mode, cut: the part within reach of the pointer's path goes, and the rest stays as new strokes (pieces).
 * Like DrawController, it only applies ops to the store as local; the sync layer does the sending.
 * The partial eraser shows its cuts as preview ops while the pointer is down, and makes one cut of each stroke
 * when it is lifted
 */
export class EraseController {
  // Pointer that is currently erasing
  private pointerId: number | null = null
  // Strokes erased by the current gesture
  private erased: StrokeData[] = []
  // Cuts made at the end of the current gesture, when it is partial
  private cuts: Cut[] = []
  // Strokes the current partial gesture erases from, by ID
  private pending = new Map<string, PendingCut>()
  // The stroke each piece shown during the gesture belongs to, by the piece's ID
  private previewOf = new Map<string, string>()
  private unsubscribe: (() => void) | null = null
  private partial = false
  // Where the partial eraser was at the previous event: the next one erases along the segment from there
  private last: Point | null = null

  constructor(
    private element: HTMLElement,
    private store: StrokeStore,
    private project: Projector,
    private index: StrokeIndex,
    private options: EraseOptions,
  ) {}

  enable(): void {
    this.unsubscribe ??= this.store.subscribe(this.onOp)
    this.element.addEventListener('pointerdown', this.onPointerDown)
    this.element.addEventListener('pointermove', this.onPointerMove)
    this.element.addEventListener('pointerup', this.onPointerUp)
    this.element.addEventListener('pointercancel', this.onPointerUp)
  }

  disable(): void {
    this.element.removeEventListener('pointerdown', this.onPointerDown)
    this.element.removeEventListener('pointermove', this.onPointerMove)
    this.element.removeEventListener('pointerup', this.onPointerUp)
    this.element.removeEventListener('pointercancel', this.onPointerUp)
    this.endGesture()
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /**
   * Puts back as they were the strokes the partial gesture in progress erases from, without cutting them; the rest
   * of the drag cuts again. Called before undo and redo, which act on the store as the history saw it
   */
  cancelCuts(): void {
    for (const pending of this.pending.values()) {
      this.hide(pending)
      this.store.apply({ type: 'restore', stroke: pending.original }, 'preview')
    }
    this.pending.clear()
    this.previewOf.clear()
  }

  /**
   * A stroke being cut can come back while it is hidden (a tile loaded again, or moved by someone else), and a reset takes away the pieces
   * shown: the preview is made again from the store, once the op that did it has reached every listener
   */
  private onOp = (op: StrokeOp, origin: Origin): void => {
    if (origin === 'preview' || this.pending.size === 0) return
    if (op.type === 'load' || op.type === 'reset' || op.type === 'restore') queueMicrotask(this.refreshPreview)
  }

  private refreshPreview = (): void => {
    for (const pending of this.pending.values()) {
      pending.shown = pending.shown.filter((id) => {
        if (this.store.get(id)) return true
        this.previewOf.delete(id)
        return false
      })
      const back = this.store.get(pending.original.id)
      if (!back) continue
      // The stroke as it came back may have moved meanwhile (the server's copy after a transform). The parts erased
      // are positions along it, which a transform keeps, so they are cut from where it is now, as the server will
      pending.original = back
      const { original } = pending
      this.show(pending, keptRanges(original.points, pending.erased, original.width * mercatorPerPixelAt(original.zoom)))
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.pointerId !== null || e.button !== 0 || !this.options.isEnabled(e)) return
    this.element.setPointerCapture(e.pointerId)
    this.pointerId = e.pointerId
    this.partial = this.options.mode() === 'partial'
    this.last = null
    if (this.partial) this.cutAlong([e])
    else this.eraseAt(e)
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return
    // Check every intermediate position too, so a fast swipe does not skip thin strokes
    const events = e.getCoalescedEvents?.() ?? []
    const moves = events.length > 0 ? events : [e]
    if (this.partial) this.cutAlong(moves)
    else for (const ev of moves) this.eraseAt(ev)
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId === this.pointerId) this.endGesture()
  }

  /** The pointer of the erase gesture in progress, if any */
  get pointer(): number | null {
    return this.pointerId
  }

  /** Ends the erase gesture in progress, if any; the rest of its drag erases nothing */
  end(): void {
    if (this.pointerId !== null) this.endGesture()
  }

  private endGesture(): void {
    this.pointerId = null
    this.commitCuts()
    if (this.erased.length > 0) this.options.onErase(this.erased)
    if (this.cuts.length > 0) this.options.onCut(this.cuts)
    this.erased = []
    this.cuts = []
    this.last = null
  }

  private eraseAt(e: PointerEvent): void {
    const p = this.project(e.clientX, e.clientY)
    const pixelSize = this.options.pixelSize()
    // Half the width the stroke has on screen, in Web Mercator units: it scales with the map
    const halfWidth = (stroke: StrokeData): number => (stroke.width * mercatorPerPixelAt(stroke.zoom)) / 2
    const maxHalfWidth = this.index.maxWidthMercator / 2
    const radius = this.options.radius() * pixelSize
    // A stroke is hit when the pointer is within its half width plus the eraser radius
    const ids = findStrokesNear(this.index, this.store, p, (stroke) => halfWidth(stroke) + radius, maxHalfWidth + radius)
    for (const id of ids) {
      const stroke = this.store.get(id)!
      if (this.store.apply({ type: 'remove', id }, 'local')) this.erased.push(stroke)
    }
  }

  /**
   * Partial eraser, while the pointer is down: erases from every stroke with an order within reach of the path from the
   * previous position through `events`, on this screen only (preview). The cuts are made once the gesture ends.
   * A stroke without an order yet has no place in the drawing order for its pieces to take, so it is left alone
   */
  private cutAlong(events: PointerEvent[]): void {
    const path = events.map((ev) => this.project(ev.clientX, ev.clientY))
    const steps: [Point, Point][] = []
    let from = this.last ?? path[0]
    for (const to of path) {
      steps.push([from, to])
      from = to
    }
    this.last = from
    const radius = this.options.radius() * this.options.pixelSize()
    const box = boundsOf(steps.flat())
    const near = this.index.search(grow(box, this.index.maxWidthMercator / 2 + radius))
    const touched = new Set<string>()
    for (const id of near) {
      const originalId = this.previewOf.get(id) ?? id
      if (touched.has(originalId)) continue
      touched.add(originalId)
      let pending = this.pending.get(originalId)
      if (!pending) {
        const stroke = this.store.get(originalId)
        if (!stroke || stroke.order === undefined) continue
        pending = { original: stroke, erased: [], shown: [] }
      }
      const { original } = pending
      const widthMercator = original.width * mercatorPerPixelAt(original.zoom)
      const sweeps: EraserSweep[] = steps.map(([a, b]) => ({ from: a, to: b, radius: radius + widthMercator / 2 }))
      const hit = erasedIntervals(original.points, sweeps)
      if (hit === null) continue
      const erased = mergeIntervals(pending.erased, hit)
      if (sameIntervals(erased, pending.erased)) continue
      // Pieces shorter than the stroke is wide would only leave dots
      const ranges = keptRanges(original.points, erased, widthMercator)
      if (ranges.length > MAX_PIECES_PER_SPLIT) continue
      pending.erased = erased
      this.pending.set(originalId, pending)
      this.show(pending, ranges)
    }
  }

  /** Shows what is left of a stroke being cut: replaces it, or the pieces shown before, with `ranges` of it */
  private show(pending: PendingCut, ranges: PieceRange[]): void {
    this.hide(pending)
    const { original } = pending
    pending.shown = ranges.map((range, k) => {
      const id = `${original.id}${PREVIEW_SEPARATOR}${k}`
      this.store.apply({ type: 'restore', stroke: pieceStroke(original, { id, ...range }) }, 'preview')
      this.previewOf.set(id, original.id)
      return id
    })
  }

  /** Takes away a stroke being cut, or the pieces of it shown so far */
  private hide(pending: PendingCut): void {
    this.store.apply({ type: 'remove', id: pending.original.id }, 'preview')
    for (const id of pending.shown) {
      this.store.apply({ type: 'remove', id }, 'preview')
      this.previewOf.delete(id)
    }
    pending.shown = []
  }

  /**
   * Makes the cuts of the partial gesture that ends: puts each stroke being cut back as it was, then cuts it
   * (or removes it, when nothing of it stays) as local ops, one per stroke
   */
  private commitCuts(): void {
    for (const pending of this.pending.values()) {
      this.hide(pending)
      const { original } = pending
      this.store.apply({ type: 'restore', stroke: original }, 'preview')
      const stroke = this.store.get(original.id)
      if (!stroke) continue
      const widthMercator = original.width * mercatorPerPixelAt(original.zoom)
      const ranges = keptRanges(original.points, pending.erased, widthMercator)
      if (ranges.length === 0) {
        if (this.store.apply({ type: 'remove', id: stroke.id }, 'local')) this.cuts.push({ removed: stroke, pieces: [] })
        continue
      }
      const pieces: StrokePiece[] = []
      for (const range of ranges) {
        const pieceId = this.options.newPieceId()
        if (pieceId === null) break
        pieces.push({ id: pieceId, ...range })
      }
      if (pieces.length < ranges.length) continue
      if (!this.store.apply({ type: 'split', id: stroke.id, pieces }, 'local')) continue
      this.cuts.push({ removed: stroke, pieces: pieces.map((piece) => this.store.get(piece.id)!) })
    }
    this.pending.clear()
    this.previewOf.clear()
  }
}

/** Whether two lists of [start, end] intervals are the same */
function sameIntervals(a: readonly [number, number][], b: readonly [number, number][]): boolean {
  return a.length === b.length && a.every(([start, end], i) => start === b[i][0] && end === b[i][1])
}
