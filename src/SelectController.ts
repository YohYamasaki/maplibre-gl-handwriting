import type { Point, StrokeData, StrokeStore } from './core/stroke'
import { IDENTITY, similarityAbout, type Matrix } from './core/transform'
import type { Projector } from './DrawController'
import { insidePolygon, strokesInLasso, topmostStrokeAt } from './lasso'
import { mercatorPerPixelAt } from './mercator'
import type { Selection } from './Selection'
import type { StrokeIndex } from './StrokeIndex'

/** Converts normalized Web Mercator coordinates to a screen position (clientX, clientY) */
export type ScreenProjector = (p: Point) => [number, number]

export type SelectOptions = {
  /** Called on every pointerdown with that event. Returns false to ignore the input */
  isEnabled: (e: PointerEvent) => boolean
  /** Size of one CSS px in normalized Web Mercator units at the current zoom */
  pixelSize: () => number
  /** Called with the lasso being drawn, in client coordinates, and with null once it is done */
  onLasso: (points: [number, number][] | null) => void
  /** Called at the end of each drag that moved, scaled or rotated strokes, with the ones it changed */
  onTransform: (ids: string[], matrix: Matrix) => void
  /**
   * Called with the CSS cursor for what a mouse or pen over the map would grab of the selection, as it moves with
   * the lasso and as a drag of the frame starts (decision 0086)
   */
  onCursor?: (cursor: string) => void
}

/** What a drag that starts on the selection does */
export type FrameGrip = { kind: 'move' } | { kind: 'scale'; corner: number } | { kind: 'rotate' }

/** How far from a handle's center, in CSS px, a press still grabs it */
export const HANDLE_RADIUS = 12
/** How far above the middle of the frame's top edge the rotate handle sits, in CSS px */
export const ROTATE_HANDLE_OFFSET = 28
/** A press that moves less than this, in CSS px, is a tap */
const TAP_DISTANCE = 4
/** A tap reaches this far past a stroke's edge, in CSS px */
const TAP_RADIUS = 6
/** The smallest scale one drag makes, so a corner dragged onto its opposite corner does not flatten the strokes */
const MIN_DRAG_SCALE = 1e-3

/**
 * Where the rotate handle is: above the middle of the top edge of the frame (corners in client coordinates, top
 * left, top right, bottom right, bottom left), on the side away from the bottom edge
 */
export function rotateHandle(corners: [number, number][]): [number, number] {
  const top: [number, number] = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2]
  const bottom: [number, number] = [(corners[2][0] + corners[3][0]) / 2, (corners[2][1] + corners[3][1]) / 2]
  const dx = top[0] - bottom[0]
  const dy = top[1] - bottom[1]
  const length = Math.hypot(dx, dy) || 1
  return [top[0] + (dx / length) * ROTATE_HANDLE_OFFSET, top[1] + (dy / length) * ROTATE_HANDLE_OFFSET]
}

/** What a press at `p` (client coordinates) grabs of a frame with these corners (client coordinates), if anything */
export function gripAt(corners: [number, number][], p: [number, number]): FrameGrip | null {
  const near = (q: [number, number]): boolean => Math.hypot(q[0] - p[0], q[1] - p[1]) <= HANDLE_RADIUS
  if (near(rotateHandle(corners))) return { kind: 'rotate' }
  const corner = corners.findIndex(near)
  if (corner >= 0) return { kind: 'scale', corner }
  return insidePolygon(p, corners) ? { kind: 'move' } : null
}

/**
 * The resize cursor of a corner of the frame (corners in client coordinates, top left, top right, bottom right,
 * bottom left): the one of the two diagonal resize cursors closest to the corner's diagonal once turned with the
 * frame's top edge
 */
export function cornerCursor(corners: [number, number][], corner: number): 'nwse-resize' | 'nesw-resize' {
  const rotation = Math.atan2(corners[1][1] - corners[0][1], corners[1][0] - corners[0][0])
  // Unturned, the top left and bottom right corners lie on the nwse diagonal (pi/4), the others on the nesw one
  const diagonal = (corner % 2 === 0 ? Math.PI / 4 : (3 * Math.PI) / 4) + rotation
  const angle = ((diagonal % Math.PI) + Math.PI) % Math.PI
  // Directions repeat every pi; the nwse diagonal is pi/4 and the nesw one 3pi/4
  const fromNwse = Math.abs(angle - Math.PI / 4)
  return Math.min(fromNwse, Math.PI - fromNwse) <= Math.PI / 4 ? 'nwse-resize' : 'nesw-resize'
}

/** The CSS cursor over a grip of the frame, or while dragging it; `default` off the frame */
export function gripCursor(grip: FrameGrip | null, corners: [number, number][], dragging: boolean): string {
  if (!grip) return 'default'
  switch (grip.kind) {
    case 'move':
      return 'move'
    case 'scale':
      return cornerCursor(corners, grip.corner)
    case 'rotate':
      return dragging ? 'grabbing' : 'grab'
  }
}

/**
 * The transform of a drag of the selection from `start` to `p` (normalized Web Mercator coordinates), with the
 * frame's corners (same coordinates) as they were when it started. A move follows the pointer; a scale is about the
 * opposite corner, by how much further from it the pointer is; a rotation is about the frame's center, by the angle
 * the pointer turned around it
 */
export function dragTransform(grip: FrameGrip, corners: Point[], start: Point, p: Point): Matrix {
  switch (grip.kind) {
    case 'move':
      return [1, 0, 0, 1, p[0] - start[0], p[1] - start[1]]
    case 'scale': {
      const anchor = corners[(grip.corner + 2) % 4]
      const from = Math.hypot(start[0] - anchor[0], start[1] - anchor[1])
      if (from === 0) return IDENTITY
      const scale = Math.max(MIN_DRAG_SCALE, Math.hypot(p[0] - anchor[0], p[1] - anchor[1]) / from)
      return similarityAbout(anchor, scale, 0)
    }
    case 'rotate': {
      const center: Point = [(corners[0][0] + corners[2][0]) / 2, (corners[0][1] + corners[2][1]) / 2]
      const angle =
        Math.atan2(p[1] - center[1], p[0] - center[0]) - Math.atan2(start[1] - center[1], start[0] - center[0])
      return similarityAbout(center, 1, angle)
    }
  }
}

/** The drag in progress: a lasso, or a grip of the frame */
type Gesture =
  | { kind: 'lasso'; pointerId: number; client: [number, number][]; path: Point[] }
  | { kind: 'frame'; pointerId: number; grip: FrameGrip; corners: Point[]; start: Point; client: [number, number]; moved: boolean }

/**
 * The lasso tool (decision 0037 P5): a lasso selects the strokes with an order and at least half of their points inside
 * it, a tap selects the topmost stroke under the pointer, and a tap on nothing clears the selection. A drag inside
 * the frame moves the selection, of a corner handle scales it about the opposite corner, and of the handle above
 * rotates it about its center. While dragging only the selection's drag transform changes; the transform op is
 * applied to the store, as local, once the pointer is lifted
 */
export class SelectController {
  private gesture: Gesture | null = null
  // The last move of a mouse or pen over the element, kept so the cursor follows a selection that changes under a
  // pointer at rest (Delete, Esc, a cancelled drag); null once it leaves
  private lastHover: PointerEvent | null = null
  private unsubscribe: (() => void) | null = null

  constructor(
    private element: HTMLElement,
    private store: StrokeStore,
    private project: Projector,
    private toScreen: ScreenProjector,
    private index: StrokeIndex,
    private selection: Selection,
    private options: SelectOptions,
  ) {}

  enable(): void {
    this.element.addEventListener('pointerdown', this.onPointerDown)
    this.element.addEventListener('pointermove', this.onPointerMove)
    this.element.addEventListener('pointerup', this.onPointerUp)
    this.element.addEventListener('pointercancel', this.onPointerCancel)
    this.element.addEventListener('pointerleave', this.onPointerLeave)
    this.unsubscribe ??= this.selection.subscribe(this.onSelectionChange)
  }

  disable(): void {
    this.element.removeEventListener('pointerdown', this.onPointerDown)
    this.element.removeEventListener('pointermove', this.onPointerMove)
    this.element.removeEventListener('pointerup', this.onPointerUp)
    this.element.removeEventListener('pointercancel', this.onPointerCancel)
    this.element.removeEventListener('pointerleave', this.onPointerLeave)
    this.unsubscribe?.()
    this.unsubscribe = null
    this.lastHover = null
    this.end()
  }

  /** The pointer of the drag in progress, if any */
  get pointer(): number | null {
    return this.gesture?.pointerId ?? null
  }

  /** Ends the drag in progress, if any, as if it were lifted where it is */
  end(): void {
    if (this.gesture) this.finish()
  }

  /** The frame's corners in client coordinates, or null when nothing is selected */
  private frameOnScreen(): { corners: Point[]; client: [number, number][] } | null {
    const corners = this.selection.frame()
    return corners ? { corners, client: corners.map(this.toScreen) } : null
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.gesture !== null || e.button !== 0 || !this.options.isEnabled(e)) return
    this.element.setPointerCapture(e.pointerId)
    if (e.pointerType !== 'touch') this.lastHover = e
    const client: [number, number] = [e.clientX, e.clientY]
    const frame = this.frameOnScreen()
    const grip = frame ? gripAt(frame.client, client) : null
    if (frame && grip) {
      this.options.onCursor?.(gripCursor(grip, frame.client, true))
      this.gesture = {
        kind: 'frame',
        pointerId: e.pointerId,
        grip,
        corners: frame.corners,
        start: this.project(e.clientX, e.clientY),
        client,
        moved: false,
      }
      return
    }
    this.gesture = { kind: 'lasso', pointerId: e.pointerId, client: [client], path: [this.project(e.clientX, e.clientY)] }
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') this.lastHover = e
    const gesture = this.gesture
    if (!gesture) {
      this.hover(e)
      return
    }
    if (e.pointerId !== gesture.pointerId) return
    if (gesture.kind === 'lasso') {
      const events = e.getCoalescedEvents?.() ?? []
      for (const ev of events.length > 0 ? events : [e]) {
        gesture.client.push([ev.clientX, ev.clientY])
        gesture.path.push(this.project(ev.clientX, ev.clientY))
      }
      if (!isTap(gesture.client)) this.options.onLasso(gesture.client)
      return
    }
    if (!gesture.moved && Math.hypot(e.clientX - gesture.client[0], e.clientY - gesture.client[1]) < TAP_DISTANCE) return
    gesture.moved = true
    this.selection.setDrag(dragTransform(gesture.grip, gesture.corners, gesture.start, this.project(e.clientX, e.clientY)))
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.gesture?.pointerId) return
    this.finish()
    // The selection or the frame may have changed under the pointer
    this.hover(e)
  }

  private onPointerLeave = (): void => {
    this.lastHover = null
  }

  /**
   * Gives the cursor again for a pointer at rest, e.g. once the map moved the frame under it; nothing during a drag.
   * Changes of the selection call it themselves
   */
  updateCursor(): void {
    if (this.gesture === null && this.lastHover) this.hover(this.lastHover)
  }

  private onSelectionChange = (): void => this.updateCursor()

  /** Reports the cursor for what a mouse or pen hovering over the map would grab of the frame */
  private hover(e: PointerEvent): void {
    if (e.pointerType === 'touch') return
    this.lastHover = e
    if (!this.options.onCursor || !this.options.isEnabled(e)) return
    const frame = this.frameOnScreen()
    const grip = frame ? gripAt(frame.client, [e.clientX, e.clientY]) : null
    this.options.onCursor(gripCursor(grip, frame?.client ?? [], false))
  }

  /** A cancelled drag of the frame changes nothing; a cancelled lasso selects nothing */
  private onPointerCancel = (e: PointerEvent): void => {
    const gesture = this.gesture
    if (!gesture || e.pointerId !== gesture.pointerId) return
    this.gesture = null
    if (gesture.kind === 'lasso') this.options.onLasso(null)
    else this.selection.setDrag(IDENTITY)
    // The drag's cursor (grabbing, a resize) goes with it
    if (this.lastHover) this.hover(this.lastHover)
  }

  private finish(): void {
    const gesture = this.gesture!
    this.gesture = null
    if (gesture.kind === 'frame') {
      const matrix = this.selection.drag
      // Shown no more as a drag: from here the strokes themselves carry it
      this.selection.setDrag(IDENTITY)
      if (gesture.moved && !isIdentity(matrix)) this.transform([...this.selection.ids], matrix)
      return
    }
    this.options.onLasso(null)
    if (isTap(gesture.client)) this.tap(gesture.path[0])
    else this.selection.set(strokesInLasso(this.index, this.store, gesture.path))
  }

  /** Selects the topmost stroke with an order at p, or nothing */
  private tap(p: Point): void {
    const reach = TAP_RADIUS * this.options.pixelSize()
    const halfWidth = (stroke: StrokeData): number => (stroke.width * mercatorPerPixelAt(stroke.zoom)) / 2
    const id = topmostStrokeAt(this.index, this.store, p, (s) => halfWidth(s) + reach, this.index.maxWidthMercator / 2 + reach)
    this.selection.set(id === null ? [] : [id])
  }

  /** Applies the transform to the strokes, and reports the ones it changed */
  private transform(ids: string[], matrix: Matrix): void {
    const before = new Map(ids.map((id) => [id, this.store.get(id)?.points]))
    if (!this.store.apply({ type: 'transform', ids, matrix }, 'local')) return
    // The store replaces the points of each stroke it moved, and leaves the rest as they were
    const changed = ids.filter((id) => this.store.get(id)?.points !== before.get(id))
    if (changed.length > 0) this.options.onTransform(changed, matrix)
  }
}

function isTap(client: [number, number][]): boolean {
  const [x0, y0] = client[0]
  return client.every(([x, y]) => Math.hypot(x - x0, y - y0) < TAP_DISTANCE)
}

function isIdentity(m: Matrix): boolean {
  return m.every((v, i) => v === IDENTITY[i])
}
