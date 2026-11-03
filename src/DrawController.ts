import type { Point, StrokeData, StrokeStore } from './core/stroke'
import type { PressureCurve } from './pens'
import { countPrediction } from './debug'
import { PREDICTION_TIMEOUT_MS, predictedPositions, type Prediction } from './Prediction'
import { PressureFilter } from './pressure'

/** Converts a screen position (clientX, clientY) to normalized Web Mercator coordinates */
export type Projector = (clientX: number, clientY: number) => Point

/** Identity and style of a stroke that is about to start */
export type StrokeStart = {
  id: string
  author: string
  color: string
  width: number
  /** The pressure curve when the pen's pressure is on; the stroke then has pressure if a pen (pointerType 'pen') draws it */
  pressure: PressureCurve | null
}

export type DrawOptions = {
  /**
   * Called on every pointerdown with that event. Returns the new stroke, or null to ignore the input
   * (e.g. while drawing is turned off, before the server has given us an identity, or for touch in pen-only input)
   */
  startStroke: (e: PointerEvent) => StrokeStart | null
  /** Map zoom at the moment drawing starts */
  getZoom: () => number
  /** Called with each stroke this controller finishes, e.g. to record it for undo */
  onStroke: (stroke: StrokeData) => void
  /** Where the browser's predicted points after the stroke's tip go; they never reach the store (decision 0037 P7-1) */
  prediction?: Prediction
}

/**
 * Turns Pointer Events on an element into stroke ops and applies them to the store as local.
 * Knows nothing about networking; the sync layer subscribes to the store and does the sending
 */
export class DrawController {
  // The stroke currently being drawn, with the client position of the previous pointermove (the pointerdown for the
  // first) and the timer that drops the predicted points when no pointermove comes (decision 0080)
  private drawing: {
    id: string
    pointerId: number
    pressure: PressureFilter | null
    last: [number, number]
    timer: ReturnType<typeof setTimeout> | null
  } | null = null

  constructor(
    private element: HTMLElement,
    private store: StrokeStore,
    private project: Projector,
    private options: DrawOptions,
  ) {}

  enable(): void {
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
    this.end()
  }

  /** The pointer drawing the stroke being drawn, if any */
  get pointer(): number | null {
    return this.drawing?.pointerId ?? null
  }

  /** Finishes the stroke being drawn, if any, as it is; the rest of its drag is ignored */
  end(): void {
    if (this.drawing) this.finish()
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.drawing || e.button !== 0) return
    const stroke = this.options.startStroke(e)
    // Leave the event alone so the map's own gestures can handle it
    if (!stroke) return
    this.element.setPointerCapture(e.pointerId)

    const { id, author, color, width } = stroke
    // Only a pen's pressure is used; mouse and touch draw at the pen's width, and send no coefficients
    const pressure = stroke.pressure && e.pointerType === 'pen' ? new PressureFilter(stroke.pressure) : null
    this.drawing = { id, pointerId: e.pointerId, pressure, last: [e.clientX, e.clientY], timer: null }
    this.store.apply({ type: 'begin', id, author, color, width, zoom: this.options.getZoom() }, 'local')
    this.store.apply({ type: 'points', id, pts: [this.project(e.clientX, e.clientY)], ...this.pressures([e]) }, 'local')
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drawing || e.pointerId !== this.drawing.pointerId) return
    // Also pick up the fine-grained input accumulated since the previous pointermove
    const events = e.getCoalescedEvents?.() ?? []
    const moves = events.length > 0 ? events : [e]
    const pts = moves.map((ev) => this.project(ev.clientX, ev.clientY))
    this.store.apply({ type: 'points', id: this.drawing.id, pts, ...this.pressures(moves) }, 'local')
    const drawing = this.drawing
    const from: [number, number] = [e.clientX, e.clientY]
    const moved = Math.hypot(from[0] - drawing.last[0], from[1] - drawing.last[1])
    drawing.last = from
    const prediction = this.options.prediction
    if (!prediction) return
    // Browsers without getPredictedEvents predict nothing
    const offered = e.getPredictedEvents?.() ?? []
    const predicted = predictedPositions(from, offered, moved)
    if (__HANDWRITING_DEBUG__) countPrediction(prediction, offered.length, predicted.length)
    prediction.set(drawing.id, predicted.map(([x, y]) => this.project(x, y)))
    if (drawing.timer !== null) clearTimeout(drawing.timer)
    drawing.timer = predicted.length > 0 ? setTimeout(() => this.dropPrediction(drawing.id), PREDICTION_TIMEOUT_MS) : null
  }

  /** Drops the predicted points of stroke `id` when the pointer has rested since the last pointermove */
  private dropPrediction(id: string): void {
    if (this.drawing?.id !== id) return
    this.drawing.timer = null
    this.options.prediction?.set(id, [])
  }

  /** The width coefficients of `events` for the stroke being drawn, as the points op's field, if it has pressure */
  private pressures(events: PointerEvent[]): { ps?: number[] } {
    const filter = this.drawing?.pressure
    return filter ? { ps: events.map((ev) => filter.next(ev.pressure)) } : {}
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.drawing || e.pointerId !== this.drawing.pointerId) return
    this.finish()
  }

  private finish(): void {
    const { id, timer } = this.drawing!
    if (timer !== null) clearTimeout(timer)
    this.drawing = null
    this.options.prediction?.set(id, [])
    // The store drops a stroke that was erased or reset away while it was drawn, and then nothing is finished
    if (!this.store.apply({ type: 'end', id }, 'local')) return
    const stroke = this.store.get(id)
    if (stroke && stroke.points.length > 0) this.options.onStroke(stroke)
  }
}
