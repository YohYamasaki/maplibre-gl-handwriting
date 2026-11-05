// Stroke data and the operations (ops) that modify it.
// Used by the input, render and sync layers and by the Worker, so it must not depend on the DOM, MapLibre or any
// platform's APIs.
import { pieceStroke, validPieces, type StrokePiece } from './split'
import { isSimilarity, transformStroke, type Matrix } from './transform'

/** Normalized Web Mercator coordinates (0 to 1), e.g. of a laser line or for a transform's matrix */
export type Point = [x: number, y: number]

/**
 * A stroke, finished or still being drawn.
 * JSON.stringify writes a typed array as an object, so an app that sends or saves strokes as JSON turns points and
 * pressure into arrays of numbers (Array.from) and back (new Float64Array, new Float32Array)
 */
export type StrokeData = {
  id: string
  author: string
  color: string
  width: number
  zoom: number
  /**
   * The center line's points in normalized Web Mercator coordinates (0 to 1), x and y in turn: x0, y0, x1, y1, …
   * Point i is points[2i], points[2i + 1]
   */
  points: Float64Array
  /**
   * Width coefficient at each point, 0 to 1 (one per point, half the length of points): the stroke is
   * `width * pressure[i]` wide there. Missing for a stroke drawn without pressure, which is `width` wide everywhere
   */
  pressure?: Float32Array
  /**
   * Position in the drawing order, an integer from 1 to MAX_ORDER: later strokes are drawn over earlier ones.
   * Missing until the stroke gets one (an order op; see StrokeOrderMode for who applies it). Only strokes with an
   * order can be selected, transformed, cut or exported
   */
  order?: number
}

/**
 * A change to the strokes of a StrokeStore, given to its apply and passed on to its subscribers:
 * - begin, points and end: a stroke being drawn, its points (x and y in turn, as in StrokeData.points, and, for a
 *   stroke drawn with pressure, their width coefficients ps), and its end
 * - order: the stroke's place in the drawing order, an integer from 1 to MAX_ORDER
 * - remove: erases a whole stroke; restore brings a removed one back (undo of an erase, redo of a stroke)
 * - split: the partial eraser's cut of a stroke with an order into pieces, which keep its place in the drawing order
 * - transform: moves, scales and rotates strokes with an order (see transformStroke)
 * - replace: sets strokes held here to another copy of them, e.g. a sync layer's, which wins over what was applied here
 * - load: adds the strokes not in the store yet, e.g. saved ones; reset replaces all the strokes
 */
export type StrokeOp =
  | {
      type: 'begin'
      id: string
      author: string
      color: string
      width: number
      zoom: number
    }
  // pts: x and y in turn, as in StrokeData.points. ps: the width coefficient of each point of pts, for a stroke drawn
  // with pressure. A stroke's first points op decides whether it has pressure; every later one must agree
  | { type: 'points'; id: string; pts: Float64Array; ps?: Float32Array }
  | { type: 'end'; id: string }
  // Gives the stroke its place in the drawing order (an integer from 1 to MAX_ORDER)
  | { type: 'order'; id: string; order: number }
  // Erases a whole stroke, whether it is finished or still being drawn
  | { type: 'remove'; id: string }
  // Cuts a stroke with an order (partial eraser): removes it and adds its pieces, which keep its place in the drawing order.
  // Any client may cut anyone's stroke, like remove
  | { type: 'split'; id: string; pieces: StrokePiece[] }
  // Moves, scales and rotates strokes (core/transform). Strokes not here, without an order yet, or that the
  // transform would take off the map or out of the zoom range are left as they are. Listeners get only the IDs
  // that changed; the strokes are updated in place (points replaced, zoom changed)
  | { type: 'transform'; ids: string[]; matrix: Matrix }
  // Sets strokes held here to another copy of them, e.g. the one a sync layer keeps: its points and zoom, which
  // transforms change. That copy wins over what was applied here, so every client ends with the same strokes.
  // Strokes not held, without an order, with another number of points, with points that are not a Float64Array, or
  // already the same are skipped. Listeners get the store's strokes that changed, updated in place like transform
  | { type: 'replace'; strokes: StrokeData[] }
  // Brings back a stroke that was removed (undo of an erase, redo of a stroke)
  | { type: 'restore'; stroke: StrokeData }
  // Replaces everything, e.g. with the strokes a sync layer sends when it connects
  | { type: 'reset'; strokes: StrokeData[] }
  // Adds strokes not in the store yet, e.g. strokes loaded per tile
  | { type: 'load'; strokes: StrokeData[] }

/** The largest order a stroke can have: orders are uint32 vertex attributes */
export const MAX_ORDER = 2 ** 32 - 1

/** Whether `order` can be a stroke's place in the drawing order: an integer from 1 to MAX_ORDER */
export function validOrder(order: number): boolean {
  return Number.isInteger(order) && order >= 1 && order <= MAX_ORDER
}

/**
 * Who gives strokes their order.
 * default: the store does. Right after a stroke's end, a stroke with points and no order gets the next value of
 * the store's counter, which starts at 1 and never goes down, by an order op applied with the end's origin. The
 * strokes a load or reset brings in get the next values in the order the op lists them, whatever order they held,
 * so no order is handed out twice.
 * custom: the store never gives an order; the caller applies order ops (e.g. a sync layer that decides one order for
 * every client)
 */
export type StrokeOrderMode = 'default' | 'custom'

/** The options of a new StrokeStore */
export type StrokeStoreOptions = {
  /** Who gives strokes their order; 'default' when omitted */
  order?: StrokeOrderMode
}

/**
 * local: drawn on this screen / remote: received from elsewhere, e.g. through a sync layer / preview: shown on this
 * screen only, never sent
 * (e.g. the partial eraser's cuts while the pointer is down)
 */
export type Origin = 'local' | 'remote' | 'preview'

/**
 * A subscriber of a StrokeStore (subscribe): called after each op the store applied, with the op as applied (e.g. a
 * transform with only the IDs that changed, a load with only the strokes added, as the store's own copies) and its
 * origin. An op the store could not apply reaches no subscriber
 */
export type StrokeListener = (op: StrokeOp, origin: Origin) => void

/**
 * Holds the list of strokes, applies ops and notifies subscribers.
 * Both our own ops and others' ops go through apply, so the render layer does not care where an op came from.
 * The store keeps its own copies of the points it is given. Points that are not a Float64Array of x and y in turn, and
 * width coefficients that are not a Float32Array of one per point, are not taken: a points op or a restore with them is
 * not applied, and a load, a reset or a replace leaves out the strokes with them
 */
export class StrokeStore {
  private strokes = new Map<string, StrokeData>()
  private listeners = new Set<StrokeListener>()
  private readonly orderMode: StrokeOrderMode
  /** The order the default mode gives next */
  private nextOrder = 1
  /** The arrays the strokes that points ops grow are kept in, with room for more points, until fit stops them */
  private growing = new Map<string, Room>()

  constructor(options: StrokeStoreOptions = {}) {
    const mode = options.order ?? 'default'
    if (mode !== 'default' && mode !== 'custom') throw new RangeError(`unknown order mode: ${String(mode)}`)
    this.orderMode = mode
  }

  /** Ignores ops that cannot be applied (e.g. points for an unknown ID) and returns false */
  apply(op: StrokeOp, origin: Origin): boolean {
    switch (op.type) {
      case 'begin': {
        if (this.strokes.has(op.id)) return false
        const { type: _, ...rest } = op
        this.strokes.set(op.id, { ...rest, points: new Float64Array(0) })
        break
      }
      case 'points': {
        // Ignore strokes whose begin we never received, e.g. when joining mid-stroke
        const stroke = this.strokes.get(op.id)
        if (!stroke || !this.grow(stroke, op.pts, op.ps)) return false
        break
      }
      case 'end': {
        const stroke = this.strokes.get(op.id)
        if (!stroke) return false
        this.fit(stroke)
        break
      }
      case 'order': {
        const stroke = this.strokes.get(op.id)
        if (!stroke || !validOrder(op.order)) return false
        stroke.order = op.order
        break
      }
      case 'remove': {
        // A listener, e.g. the undo history, may keep the stroke removed
        const stroke = this.strokes.get(op.id)
        if (!stroke) return false
        this.fit(stroke)
        this.strokes.delete(op.id)
        break
      }
      // Listeners find the pieces in the store by their IDs
      case 'split': {
        const { id, pieces } = op
        const stroke = this.strokes.get(id)
        if (!stroke || !validPieces(pieces, pointCount(stroke.points))) return false
        if (pieces.some((piece) => this.strokes.has(piece.id) || piece.id === id)) return false
        if (new Set(pieces.map((piece) => piece.id)).size !== pieces.length) return false
        this.fit(stroke)
        this.strokes.delete(id)
        for (const piece of pieces) this.strokes.set(piece.id, pieceStroke(stroke, piece))
        break
      }
      case 'transform': {
        if (!isSimilarity(op.matrix)) return false
        const changed: string[] = []
        for (const id of new Set(op.ids)) {
          const stroke = this.strokes.get(id)
          if (!stroke || stroke.order === undefined) continue
          const moved = transformStroke(stroke, op.matrix)
          if (!moved) continue
          stroke.points = moved.points
          stroke.zoom = moved.zoom
          this.fit(stroke)
          changed.push(id)
        }
        if (changed.length === 0) return false
        op = { type: 'transform', ids: changed, matrix: op.matrix }
        break
      }
      case 'replace': {
        const changed: StrokeData[] = []
        for (const { id, points, zoom } of op.strokes) {
          const stroke = this.strokes.get(id)
          if (!stroke || stroke.order === undefined || !(points instanceof Float64Array)) continue
          if (stroke.points.length !== points.length) continue
          if (stroke.zoom === zoom && samePoints(stroke.points, points)) continue
          stroke.points = points.slice()
          stroke.zoom = zoom
          this.fit(stroke)
          changed.push(stroke)
        }
        if (changed.length === 0) return false
        op = { type: 'replace', strokes: changed }
        break
      }
      // The store keeps its own copies of strokes handed in, and passes those copies on, so listeners hold
      // the same objects the store later updates (e.g. on an order op). Strokes with an order out of range, or with
      // points or width coefficients not of their type and length, are dropped
      case 'restore': {
        if (this.strokes.has(op.stroke.id) || !canKeep(op.stroke)) return false
        const stroke = this.keep(op.stroke)
        op = { type: 'restore', stroke }
        break
      }
      case 'reset':
        for (const id of this.growing.keys()) this.fit(this.strokes.get(id)!)
        this.strokes.clear()
        op = { type: 'reset', strokes: op.strokes.filter(canKeep).map((stroke) => this.keepOrdered(stroke)) }
        break
      case 'load': {
        // Tiles overlap and may be loaded again, so only the new strokes are added and passed on
        const added = op.strokes.filter((stroke) => !this.strokes.has(stroke.id) && canKeep(stroke))
        if (added.length === 0) return false
        op = { type: 'load', strokes: added.map((stroke) => this.keepOrdered(stroke)) }
        break
      }
    }
    for (const listener of this.listeners) listener(op, origin)
    if (op.type === 'end' && this.orderMode === 'default') {
      // Looked up again: a listener may have removed the stroke
      const stroke = this.strokes.get(op.id)
      if (stroke && stroke.order === undefined && stroke.points.length > 0) {
        this.apply({ type: 'order', id: op.id, order: this.takeOrder() }, origin)
      }
    }
    return true
  }

  /**
   * Appends a points op's points, and their width coefficients, to a stroke (see appendPoints), in arrays with room
   * for GROWTH_POINTS more at a time: points and pressure are views of the part in use. Returns false, changing
   * nothing, when appendPoints would
   */
  private grow(stroke: StrokeData, pts: Float64Array, ps: Float32Array | undefined): boolean {
    if (!canAppend(stroke, pts, ps)) return false
    const count = pointCount(stroke.points)
    const total = count + pointCount(pts)
    let room = this.growing.get(stroke.id)
    // Made again when the stroke's arrays are not the views it gave (a transform, a replace, or appendPoints
    // replaced them), or when it is full
    const fits =
      room !== undefined &&
      room.view === stroke.points &&
      room.pressureView === stroke.pressure &&
      room.points.length >= 2 * total &&
      (ps === undefined || room.pressure !== null)
    if (!fits) {
      const capacity = Math.ceil(total / GROWTH_POINTS) * GROWTH_POINTS
      const points = new Float64Array(2 * capacity)
      points.set(stroke.points)
      let pressure: Float32Array | null = null
      if (ps !== undefined) {
        pressure = new Float32Array(capacity)
        if (stroke.pressure) pressure.set(stroke.pressure)
      }
      room = { points, pressure, view: stroke.points, pressureView: stroke.pressure }
      this.growing.set(stroke.id, room)
    }
    room = room!
    room.points.set(pts, 2 * count)
    stroke.points = room.view = room.points.subarray(0, 2 * total)
    if (ps !== undefined) {
      room.pressure!.set(ps, count)
      stroke.pressure = room.pressureView = room.pressure!.subarray(0, total)
    }
    return true
  }

  /**
   * Stops a stroke that points ops grew from growing: copies its points and width coefficients that are still views of
   * arrays with room for more into arrays of their exact length. At its end, and whenever the store drops the arrays
   * it grows in (a transform or a replace gave it new points, or it leaves the store)
   */
  private fit(stroke: StrokeData): void {
    if (!this.growing.delete(stroke.id)) return
    stroke.points = exact(stroke.points)
    if (stroke.pressure) stroke.pressure = exact(stroke.pressure)
  }

  /** The default mode's next order; the counter never goes down */
  private takeOrder(): number {
    return this.nextOrder++
  }

  /** Stores a copy of a stroke handed in from outside and returns the copy */
  private keep(stroke: StrokeData): StrokeData {
    const copy = { ...stroke, points: stroke.points.slice() }
    if (stroke.pressure) copy.pressure = stroke.pressure.slice()
    this.strokes.set(copy.id, copy)
    return copy
  }

  /** keep, with the next order of the counter in the default mode (load and reset) */
  private keepOrdered(stroke: StrokeData): StrokeData {
    const copy = this.keep(stroke)
    if (this.orderMode === 'default') copy.order = this.takeOrder()
    return copy
  }

  /** The stroke with this ID, or undefined */
  get(id: string): StrokeData | undefined {
    return this.strokes.get(id)
  }

  /** Every stroke held. They come in no set order: the drawing order is each stroke's order */
  values(): IterableIterator<StrokeData> {
    return this.strokes.values()
  }

  /** Call the returned function to unsubscribe */
  subscribe(listener: StrokeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/**
 * How many points a stroke being drawn gets room for at a time: its arrays grow by this many points, or at once by the
 * multiple of it that a points op with more needs
 */
const GROWTH_POINTS = 32

/**
 * The arrays a stroke being drawn grows in: its points (x and y in turn) and width coefficients, with room for more,
 * and the views of them last given to the stroke
 */
type Room = {
  points: Float64Array
  pressure: Float32Array | null
  view: Float64Array
  pressureView: Float32Array | undefined
}

/** How many points `points` (x and y in turn) has */
function pointCount(points: Float64Array): number {
  return points.length / 2
}

/** Whether `points` is a Float64Array of x and y in turn */
function validPoints(points: unknown): points is Float64Array {
  return points instanceof Float64Array && points.length % 2 === 0
}

/** Whether `pressure` is a Float32Array with one width coefficient for each of `points` */
function validPressure(pressure: unknown, points: Float64Array): pressure is Float32Array {
  return pressure instanceof Float32Array && pressure.length === pointCount(points)
}

/**
 * Whether the store can keep a copy of a stroke handed in: its order, when it has one, is in range, its points are a
 * Float64Array of x and y in turn, and its width coefficients, when it has them, a Float32Array of one per point
 */
function canKeep(stroke: StrokeData): boolean {
  if (stroke.order !== undefined && !validOrder(stroke.order)) return false
  if (!validPoints(stroke.points)) return false
  return stroke.pressure === undefined || validPressure(stroke.pressure, stroke.points)
}

/** Whether appendPoints can append `pts` and `ps` to the stroke (see appendPoints) */
function canAppend(stroke: StrokeData, pts: Float64Array, ps: Float32Array | undefined): boolean {
  if (!validPoints(pts)) return false
  if (ps === undefined) return stroke.pressure === undefined
  return validPressure(ps, pts) && (stroke.pressure !== undefined || stroke.points.length === 0)
}

/** `array`, or a copy of it when it is a view of a larger buffer */
function exact<T extends Float64Array | Float32Array>(array: T): T {
  return array.byteLength === array.buffer.byteLength ? array : (array.slice() as T)
}

function samePoints(a: Float64Array, b: Float64Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Appends points (x and y in turn), and their width coefficients, to a stroke, into new arrays of the exact length.
 * Returns false, changing nothing, when pts is not a Float64Array of x and y in turn, when ps is not a Float32Array of
 * one coefficient per point, or when the op disagrees with the stroke's earlier points about having pressure
 */
export function appendPoints(stroke: StrokeData, pts: Float64Array, ps: Float32Array | undefined): boolean {
  if (!canAppend(stroke, pts, ps)) return false
  const points = new Float64Array(stroke.points.length + pts.length)
  points.set(stroke.points)
  points.set(pts, stroke.points.length)
  stroke.points = points
  if (ps !== undefined) {
    const pressure = new Float32Array(pointCount(points))
    if (stroke.pressure) pressure.set(stroke.pressure)
    pressure.set(ps, pressure.length - ps.length)
    stroke.pressure = pressure
  }
  return true
}
