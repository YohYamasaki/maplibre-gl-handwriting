import type { Point, StrokeData, StrokeStore } from './core/stroke'
import type { PressureCurve } from './pens'
import { countPrediction } from './debug'
import { PREDICTION_TIMEOUT_MS, predictedPositions, predictionLimit, type Prediction } from './Prediction'
import { PRESSURE_STEP, PressureFilter } from './pressure'

/**
 * The input is recorded once it is this far from the last recorded point, or the stroke's width when that is less,
 * in CSS px
 */
export const MAX_SAMPLE_SPACING_PX = 4

/**
 * An input point not recorded stays within this distance of the recorded polyline, in CSS px: when a new point would
 * leave one of the points skipped since the last recorded point farther from the line to it, the point before it is
 * recorded first, so corners and turns are kept
 */
export const CORNER_TOLERANCE_PX = 0.5

/** How many of the latest skipped points the corner check looks at, so a resting pen costs a bounded amount */
export const CORNER_WINDOW = 32

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

/** A position of the pointer in client px, with its width coefficient (1 for a stroke without pressure) */
type Input = { x: number; y: number; c: number }

/**
 * The stroke being drawn: the spacing of its recorded points, the last recorded point and the points skipped since
 * (the latest CORNER_WINDOW), the client position and timeStamp of the previous pointermove (the pointerdown for the
 * first), and the timer that drops the predicted points when no pointermove comes
 */
type Drawing = {
  id: string
  pointerId: number
  pressure: PressureFilter | null
  spacing: number
  recorded: Input
  skipped: Input[]
  last: [number, number]
  lastTime: number
  timer: ReturnType<typeof setTimeout> | null
}

export type DrawOptions = {
  /**
   * Called on every pointerdown with that event. Returns the new stroke, or null to ignore the input
   * (e.g. while drawing is turned off, before the sync layer has given us an identity, or for touch in pen-only input)
   */
  startStroke: (e: PointerEvent) => StrokeStart | null
  /** Map zoom at the moment drawing starts */
  getZoom: () => number
  /** Called with each stroke this controller finishes, e.g. to record it for undo */
  onStroke: (stroke: StrokeData) => void
  /**
   * Where the latest input not recorded yet and the browser's predicted points after the stroke's tip go; they never
   * reach the store. Without it the drawn line ends at the last recorded point
   */
  prediction?: Prediction
}

/**
 * Turns Pointer Events on an element into stroke ops and applies them to the store as local.
 * Records the input only every min(width, MAX_SAMPLE_SPACING_PX) px on screen, at corners (CORNER_TOLERANCE_PX) and at
 * changes of width coefficient (PRESSURE_STEP); the points in between never reach the store, so they are not sent or
 * kept. Knows nothing about networking; the sync layer subscribes to the store and does the sending
 */
export class DrawController {
  private drawing: Drawing | null = null

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

  /** Finishes the stroke being drawn, if any, at its latest input; the rest of its drag is ignored */
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
    // The pointerdown is always recorded
    const first: Input = { x: e.clientX, y: e.clientY, c: pressure?.next(e.pressure) ?? 1 }
    const drawing: Drawing = {
      id,
      pointerId: e.pointerId,
      pressure,
      spacing: Math.min(width, MAX_SAMPLE_SPACING_PX),
      recorded: first,
      skipped: [],
      last: [e.clientX, e.clientY],
      lastTime: e.timeStamp,
      timer: null,
    }
    this.drawing = drawing
    this.store.apply({ type: 'begin', id, author, color, width, zoom: this.options.getZoom() }, 'local')
    this.record(drawing, [first])
  }

  private onPointerMove = (e: PointerEvent): void => {
    const drawing = this.drawing
    if (!drawing || e.pointerId !== drawing.pointerId) return
    // Also pick up the fine-grained input accumulated since the previous pointermove, one event at a time. Every
    // reading goes through the pressure smoothing, recorded or not
    const events = e.getCoalescedEvents?.() ?? []
    const moves = events.length > 0 ? events : [e]
    const recorded: Input[] = []
    for (const ev of moves) {
      const input: Input = { x: ev.clientX, y: ev.clientY, c: drawing.pressure?.next(ev.pressure) ?? 1 }
      recorded.push(...thin(drawing, input))
    }
    if (recorded.length > 0) this.record(drawing, recorded)
    // A listener of the store may have ended the stroke
    if (this.drawing !== drawing) return
    const from: [number, number] = [e.clientX, e.clientY]
    const moved = Math.hypot(from[0] - drawing.last[0], from[1] - drawing.last[1])
    const elapsed = e.timeStamp - drawing.lastTime
    drawing.last = from
    drawing.lastTime = e.timeStamp
    const prediction = this.options.prediction
    if (!prediction) return
    // The latest input not recorded is drawn after the tip until it is recorded, ahead of the predicted points
    const pending = drawing.skipped.at(-1)
    prediction.setPending(drawing.id, pending ? this.project(pending.x, pending.y) : null)
    // Browsers without getPredictedEvents predict nothing. The predicted points are kept up to prediction.ms after
    // this pointermove, and within how far the pointer goes in that time at its speed since the previous one
    const offered = e.getPredictedEvents?.() ?? []
    const { ms } = prediction
    const { positions: predicted, dropped } = predictedPositions(
      from,
      e.timeStamp,
      offered,
      predictionLimit(moved, elapsed, ms),
      ms,
    )
    if (__HANDWRITING_DEBUG__) countPrediction(prediction, e.timeStamp, offered, predicted.length, dropped)
    prediction.set(
      drawing.id,
      predicted.map(([x, y]) => this.project(x, y)),
    )
    if (drawing.timer !== null) clearTimeout(drawing.timer)
    drawing.timer =
      predicted.length > 0 ? setTimeout(() => this.dropPrediction(drawing.id), PREDICTION_TIMEOUT_MS) : null
  }

  /**
   * Drops the predicted points of stroke `id` when the pointer has rested since the last pointermove; the pending
   * point stays
   */
  private dropPrediction(id: string): void {
    if (this.drawing?.id !== id) return
    this.drawing.timer = null
    this.options.prediction?.set(id, [])
  }

  /** Applies `inputs` to the store as one points op of stroke `drawing`, with their coefficients if it has pressure */
  private record(drawing: Drawing, inputs: Input[]): void {
    const pts = inputs.map((p) => this.project(p.x, p.y))
    const ps = drawing.pressure ? { ps: inputs.map((p) => p.c) } : {}
    this.store.apply({ type: 'points', id: drawing.id, pts, ...ps }, 'local')
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.drawing || e.pointerId !== this.drawing.pointerId) return
    this.finish()
  }

  /** Records the latest input not recorded yet, if any, drops the points drawn after the tip, and ends the stroke */
  private finish(): void {
    const drawing = this.drawing!
    const { id, timer } = drawing
    if (timer !== null) clearTimeout(timer)
    this.drawing = null
    const pending = drawing.skipped.at(-1)
    if (pending) this.record(drawing, [pending])
    this.options.prediction?.setPending(id, null)
    this.options.prediction?.set(id, [])
    // The store drops a stroke that was erased or reset away while it was drawn, and then nothing is finished
    if (!this.store.apply({ type: 'end', id }, 'local')) return
    const stroke = this.store.get(id)
    if (stroke && stroke.points.length > 0) this.options.onStroke(stroke)
  }
}

/**
 * The points to record for the next input `p` of a stroke being drawn, in order, and what is skipped after them.
 * When `p` would leave one of the skipped points more than CORNER_TOLERANCE_PX from the line from the last recorded
 * point to `p`, the latest skipped point is recorded first. Then `p` is recorded when it is at least the spacing from
 * the last recorded point, or its coefficient differs from that point's by PRESSURE_STEP or more, and is skipped
 * otherwise (only the latest CORNER_WINDOW skipped points are kept)
 */
function thin(drawing: Drawing, p: Input): Input[] {
  const out: Input[] = []
  const { skipped } = drawing
  if (skipped.some((s) => distanceToSegment(s, drawing.recorded, p) > CORNER_TOLERANCE_PX)) {
    const corner = skipped.at(-1)!
    out.push(corner)
    drawing.recorded = corner
    skipped.length = 0
  }
  const last = drawing.recorded
  if (Math.hypot(p.x - last.x, p.y - last.y) >= drawing.spacing || Math.abs(p.c - last.c) >= PRESSURE_STEP) {
    out.push(p)
    drawing.recorded = p
    skipped.length = 0
  } else {
    skipped.push(p)
    if (skipped.length > CORNER_WINDOW) skipped.shift()
  }
  return out
}

/** The distance from `p` to the segment from `a` to `b`, in client px */
function distanceToSegment(p: Input, a: Input, b: Input): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length2 = dx * dx + dy * dy
  const t = length2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
