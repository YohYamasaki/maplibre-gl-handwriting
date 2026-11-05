// Stroke data and the operations (ops) that modify it.
// Used by the input, render and sync layers and by the Worker, so it must not depend on the DOM, MapLibre or any
// platform's APIs.
import { MAX_SPILL_POINTS, registerSpillHost, SPILL_DELAY_MS, type SpillOptions, type SpillRecord } from './spill'
import { pieceStroke, validPieces, type StrokePiece } from './split'
import { isSimilarity, transformStroke, type Matrix } from './transform'

/** Normalized Web Mercator coordinates (0 to 1), e.g. of a laser line or for a transform's matrix */
export type Point = [x: number, y: number]

/**
 * A stroke, finished or still being drawn.
 * JSON.stringify writes a typed array as an object, so an app that sends or saves strokes as JSON turns points and
 * pressure into arrays of numbers (Array.from) and back (new Float64Array, new Float32Array).
 * A store's stroke whose points are spilled (see StrokeStore) has points null, and pressure null when it has
 * pressure; a stroke handed to the store must have its points
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
  points: Float64Array | null
  /**
   * Width coefficient at each point, 0 to 1 (one per point, half the length of points): the stroke is
   * `width * pressure[i]` wide there. Missing for a stroke drawn without pressure, which is `width` wide everywhere
   */
  pressure?: Float32Array | null
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
  /**
   * Whether a layer that draws the store may spill the points of strokes far from the view to IndexedDB (see
   * StrokeStore); true when omitted. With false every point stays in memory, e.g. for an app that saves values()
   */
  spill?: boolean
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
 * not applied, and a load, a reset or a replace leaves out the strokes with them.
 *
 * A layer that draws the store (createHandwriting, HandwritingLayer) spills the points of strokes far from the view to
 * IndexedDB, in a browser that has it and Web Locks, unless the store was made with spill: false. A stroke with an
 * order, finished (a stroke of a load, a reset or a restore is), of at most 131,072 points, and that nothing holds
 * (hold) for a second is written there, and its points (and pressure) are null until they are read back; its other
 * fields, and its extent, stay. The layer holds the strokes near its view, the selection, the undo history and the
 * stroke being cut. hold and read bring points back. A remove or an order applies to a spilled stroke at once; ops that
 * need its points (points, split, transform, replace) wait until they are read back, as do the later ops on the same
 * strokes, and are then applied in the order they came: apply returns true for them, and subscribers get them once
 * applied. A load, a transform or a replace waits only for its strokes that wait: its part on the others applies at
 * once, and each stroke that waits comes later as an op of its own (a stroke a load brings takes its order, in the
 * default mode, when the load comes). A reset drops the ops waiting. Points that cannot be read back stay null: such a
 * stroke is not drawn and an op that needs its points is dropped
 */
export class StrokeStore {
  private strokes = new Map<string, StrokeData>()
  private listeners = new Set<StrokeListener>()
  private readonly orderMode: StrokeOrderMode
  private readonly spillEnabled: boolean
  /** The order the default mode gives next */
  private nextOrder = 1
  /** The arrays the strokes that points ops grow are kept in, with room for more points, until fit stops them */
  private growing = new Map<string, Room>()
  /** Strokes begun or given points since their end (or never ended): being drawn */
  private open = new Set<string>()
  /** Each stroke's extent (see extent), from its points, for every stroke with points or spilled */
  private extents = new Map<string, StrokeExtent>()
  /** How many times each ID is held (hold), also IDs not in the store */
  private holds = new Map<string, number>()
  /** The attached target, and what spilling needs of it */
  private spillState: SpillState | null = null
  /**
   * Strokes whose target record holds the same points as their array here (by identity), so spilling them again writes
   * nothing. Dropped when the points change, so the old array is not kept
   */
  private recorded = new Map<string, Float64Array>()
  /** Strokes with a record in the target, or one being written: it goes when they leave the store */
  private stored = new Set<string>()
  /** Strokes whose points are only in the target's record */
  private spilled = new Set<string>()
  /** Strokes whose points could not be read back */
  private lost = new Set<string>()
  /** Spilled strokes being read back: the stroke the read is for, and the read */
  private reading = new Map<string, { stroke: StrokeData; done: Promise<void> }>()
  /** Ops waiting for points to be read back, in the order they came, with the IDs each touches */
  private waiting: Waiting[] = []
  /** How many waiting ops touch each ID: a later op on it waits behind them */
  private busy = new Map<string, number>()

  constructor(options: StrokeStoreOptions = {}) {
    const mode = options.order ?? 'default'
    if (mode !== 'default' && mode !== 'custom') throw new RangeError(`unknown order mode: ${String(mode)}`)
    this.orderMode = mode
    this.spillEnabled = options.spill ?? true
    registerSpillHost(this, {
      attach: (spillOptions) => this.attachSpill(spillOptions),
      spill: () => this.spillNow(),
      fail: (error) => {
        if (this.spillState) this.stopSpilling(this.spillState, error)
      },
      detach: () => this.detachSpill(),
    })
  }

  /**
   * Ignores ops that cannot be applied (e.g. points for an unknown ID) and returns false. An op that waits for spilled
   * points to be read back returns true (see StrokeStore)
   */
  apply(op: StrokeOp, origin: Origin): boolean {
    if (op.type === 'reset') {
      this.forgetSpilling()
      return this.applyNow(op, origin)
    }
    if (this.waiting.length === 0 && this.spilled.size === 0) return this.applyNow(op, origin)
    // Each stroke that waits waits alone (decision 0026): the part of a load, a transform or a replace on strokes that
    // need not wait applies now, and the rest is one waiting op per stroke
    switch (op.type) {
      case 'transform': {
        const now: string[] = []
        let waited = false
        for (const id of new Set(op.ids)) {
          if (!this.mustWait(id, true)) now.push(id)
          else {
            this.wait({ type: 'transform', ids: [id], matrix: op.matrix }, origin, [id])
            waited = true
          }
        }
        const applied = now.length > 0 && this.applyNow({ ...op, ids: now }, origin)
        return applied || waited
      }
      case 'replace': {
        const now: StrokeData[] = []
        let waited = false
        for (const stroke of op.strokes) {
          if (!this.mustWait(stroke.id, true)) now.push(stroke)
          else {
            this.wait({ type: 'replace', strokes: [stroke] }, origin, [stroke.id])
            waited = true
          }
        }
        const applied = now.length > 0 && this.applyNow({ ...op, strokes: now }, origin)
        return applied || waited
      }
      case 'load': {
        // In the default mode the strokes take their orders now, in the order the load lists them, the ones that wait
        // included (decision 0026)
        const ordered = this.orderMode === 'default'
        const now: StrokeData[] = []
        const orders: (number | undefined)[] = []
        let waited = false
        for (const stroke of op.strokes) {
          if (!this.mustWait(stroke.id, false)) {
            now.push(stroke)
            orders.push(ordered && !this.strokes.has(stroke.id) && canKeep(stroke) ? this.takeOrder() : undefined)
          } else {
            const order = ordered && canKeep(stroke) ? this.takeOrder() : undefined
            this.wait({ type: 'load', strokes: [stroke] }, origin, [stroke.id], [order])
            waited = true
          }
        }
        const applied = now.length > 0 && this.applyNow({ ...op, strokes: now }, origin, orders)
        return applied || waited
      }
      default: {
        // A split waits with its pieces' IDs, so the ops on its pieces wait for it
        const ids = touchedIds(op)
        const needs = needsPoints(op)
        if (!ids.some((id) => this.mustWait(id, needs))) return this.applyNow(op, origin)
        this.wait(op, origin, ids)
        return true
      }
    }
  }

  /** Whether an op on `id` waits: an earlier op on it waits, or its points are being read or, when it needs them, spilled */
  private mustWait(id: string, needsPoints: boolean): boolean {
    return this.busy.has(id) || this.reading.has(id) || (needsPoints && this.spilled.has(id))
  }

  /** Puts an op behind the ones waiting, and reads back the spilled points it needs */
  private wait(op: StrokeOp, origin: Origin, ids: string[], orders?: (number | undefined)[]): void {
    this.waiting.push({ op, origin, ids, orders })
    for (const id of ids) {
      this.busy.set(id, (this.busy.get(id) ?? 0) + 1)
      this.spillState?.candidates.delete(id)
    }
    if (needsPoints(op)) void this.readBack(ids)
  }

  /**
   * Applies the waiting ops that wait for nothing any more, in the order they came. One still waiting holds back the
   * later ones on its strokes. A stroke no op waits on any more may be spilled again, whether its op changed it or not
   */
  private drain(): void {
    const held = new Set<string>()
    for (let i = 0; i < this.waiting.length; i++) {
      const entry = this.waiting[i]
      let stuck = entry.ids.some((id) => held.has(id) || this.reading.has(id))
      if (!stuck && needsPoints(entry.op)) {
        const spilled = entry.ids.filter((id) => this.spilled.has(id))
        if (spilled.length > 0) {
          void this.readBack(spilled)
          stuck = true
        }
      }
      if (stuck) {
        for (const id of entry.ids) held.add(id)
        continue
      }
      this.waiting.splice(i--, 1)
      const free: string[] = []
      for (const id of entry.ids) {
        const count = this.busy.get(id)!
        if (count > 1) {
          this.busy.set(id, count - 1)
        } else {
          this.busy.delete(id)
          free.push(id)
        }
      }
      this.applyNow(entry.op, entry.origin, entry.orders)
      for (const id of free) this.considerCandidate(id)
    }
  }

  /** Applies an op now (see apply); a load's strokes take `orders`, in the default mode, where given */
  private applyNow(op: StrokeOp, origin: Origin, orders?: (number | undefined)[]): boolean {
    switch (op.type) {
      case 'begin': {
        if (this.strokes.has(op.id)) return false
        const { type: _, ...rest } = op
        this.strokes.set(op.id, { ...rest, points: new Float64Array(0) })
        this.open.add(op.id)
        break
      }
      case 'points': {
        // Ignore strokes whose begin we never received, e.g. when joining mid-stroke
        const stroke = this.strokes.get(op.id)
        if (!stroke || !this.grow(stroke, op.pts, op.ps)) return false
        this.recorded.delete(op.id)
        this.open.add(op.id)
        this.spillState?.candidates.delete(op.id)
        const added = extentOf(op.pts)
        const before = this.extents.get(op.id)
        if (added) this.extents.set(op.id, before ? unionExtent(before, added) : added)
        break
      }
      case 'end': {
        const stroke = this.strokes.get(op.id)
        if (!stroke) return false
        this.fit(stroke)
        this.open.delete(op.id)
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
        this.forget(op.id)
        break
      }
      // Listeners find the pieces in the store by their IDs
      case 'split': {
        const { id, pieces } = op
        const stroke = this.strokes.get(id)
        if (!stroke || stroke.points === null || !validPieces(pieces, pointCount(stroke.points))) return false
        if (pieces.some((piece) => this.strokes.has(piece.id) || piece.id === id)) return false
        if (new Set(pieces.map((piece) => piece.id)).size !== pieces.length) return false
        this.fit(stroke)
        this.strokes.delete(id)
        this.forget(id)
        for (const piece of pieces) this.put(pieceStroke(stroke, piece))
        break
      }
      case 'transform': {
        if (!isSimilarity(op.matrix)) return false
        const changed: string[] = []
        for (const id of new Set(op.ids)) {
          const stroke = this.strokes.get(id)
          if (!stroke || stroke.order === undefined || stroke.points === null) continue
          const moved = transformStroke(stroke, op.matrix)
          if (!moved) continue
          stroke.points = moved.points
          stroke.zoom = moved.zoom
          this.recorded.delete(id)
          this.fit(stroke)
          this.setExtent(stroke)
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
          if (!stroke || stroke.order === undefined || stroke.points === null || !(points instanceof Float64Array)) {
            continue
          }
          if (stroke.points.length !== points.length) continue
          if (stroke.zoom === zoom && samePoints(stroke.points, points)) continue
          stroke.points = points.slice()
          stroke.zoom = zoom
          this.recorded.delete(id)
          this.fit(stroke)
          this.setExtent(stroke)
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
        this.open.clear()
        this.extents.clear()
        op = { type: 'reset', strokes: op.strokes.filter(canKeep).map((stroke) => this.keepOrdered(stroke)) }
        break
      case 'load': {
        // Tiles overlap and may be loaded again, so only the new strokes are added and passed on
        const kept: StrokeData[] = []
        op.strokes.forEach((stroke, i) => {
          if (!this.strokes.has(stroke.id) && canKeep(stroke)) kept.push(this.keepOrdered(stroke, orders?.[i]))
        })
        if (kept.length === 0) return false
        op = { type: 'load', strokes: kept }
        break
      }
    }
    for (const listener of this.listeners) listener(op, origin)
    if (op.type === 'end' && this.orderMode === 'default') {
      // Looked up again: a listener may have removed the stroke
      const stroke = this.strokes.get(op.id)
      if (stroke && stroke.order === undefined && stroke.points !== null && stroke.points.length > 0) {
        this.apply({ type: 'order', id: op.id, order: this.takeOrder() }, origin)
      }
    }
    if (this.spillState) for (const id of touchedIds(op)) this.considerCandidate(id)
    return true
  }

  /**
   * Appends a points op's points, and their width coefficients, to a stroke (see appendPoints), in arrays with room
   * for GROWTH_POINTS more at a time: points and pressure are views of the part in use. Returns false, changing
   * nothing, when appendPoints would
   */
  private grow(stroke: StrokeData, pts: Float64Array, ps: Float32Array | undefined): boolean {
    if (!canAppend(stroke, pts, ps)) return false
    const current = stroke.points!
    const count = pointCount(current)
    const total = count + pointCount(pts)
    let room = this.growing.get(stroke.id)
    // Made again when the stroke's arrays are not the views it gave (a transform, a replace, or appendPoints
    // replaced them), or when it is full
    const fits =
      room !== undefined &&
      room.view === current &&
      room.pressureView === stroke.pressure &&
      room.points.length >= 2 * total &&
      (ps === undefined || room.pressure !== null)
    if (!fits) {
      const capacity = Math.ceil(total / GROWTH_POINTS) * GROWTH_POINTS
      const points = new Float64Array(2 * capacity)
      points.set(current)
      let pressure: Float32Array | null = null
      if (ps !== undefined) {
        pressure = new Float32Array(capacity)
        if (stroke.pressure) pressure.set(stroke.pressure)
      }
      room = { points, pressure, view: current, pressureView: stroke.pressure ?? undefined }
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
    stroke.points = exact(stroke.points!)
    if (stroke.pressure) stroke.pressure = exact(stroke.pressure)
  }

  /** The default mode's next order; the counter never goes down */
  private takeOrder(): number {
    return this.nextOrder++
  }

  /** Stores a copy of a stroke handed in from outside and returns the copy */
  private keep(stroke: StrokeData): StrokeData {
    const copy = { ...stroke, points: stroke.points!.slice() }
    if (stroke.pressure) copy.pressure = stroke.pressure.slice()
    this.put(copy)
    return copy
  }

  /** keep, with `order` or else the next order of the counter in the default mode (load and reset) */
  private keepOrdered(stroke: StrokeData, order?: number): StrokeData {
    const copy = this.keep(stroke)
    if (this.orderMode === 'default') copy.order = order ?? this.takeOrder()
    return copy
  }

  /** Adds a stroke of the store's own, with its extent */
  private put(stroke: StrokeData): void {
    this.strokes.set(stroke.id, stroke)
    this.setExtent(stroke)
  }

  private setExtent(stroke: StrokeData): void {
    const extent = stroke.points && extentOf(stroke.points)
    if (extent) this.extents.set(stroke.id, extent)
    else this.extents.delete(stroke.id)
  }

  /** The stroke with this ID, or undefined. Its points are null while they are spilled (see StrokeStore) */
  get(id: string): StrokeData | undefined {
    return this.strokes.get(id)
  }

  /**
   * Every stroke held. They come in no set order: the drawing order is each stroke's order. The points of spilled ones
   * are null (see StrokeStore): read gives every point
   */
  values(): IterableIterator<StrokeData> {
    return this.strokes.values()
  }

  /** Call the returned function to unsubscribe */
  subscribe(listener: StrokeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * The bounds of a stroke's center line and its first point, in normalized Web Mercator coordinates, also while its
   * points are spilled. Undefined for an ID not in the store and for a stroke without points yet
   */
  extent(id: string): { minX: number; minY: number; maxX: number; maxY: number; start: Point } | undefined {
    return this.extents.get(id)
  }

  /**
   * Keeps the points of these strokes in memory until as many release calls: reads back the ones spilled, and none of
   * them is spilled meanwhile. Holds are counted per ID, also for IDs not in the store yet. Resolves once the points
   * are back, also when some could not be read (their points stay null)
   */
  hold(ids: Iterable<string>): Promise<void> {
    const list = [...ids]
    for (const id of list) {
      this.holds.set(id, (this.holds.get(id) ?? 0) + 1)
      this.spillState?.candidates.delete(id)
    }
    return this.readBack(list)
  }

  /** Takes back one hold of each of these IDs (see hold); a stroke no longer held may be spilled again */
  release(ids: Iterable<string>): void {
    for (const id of ids) {
      const count = this.holds.get(id)
      if (count === undefined) continue
      if (count > 1) {
        this.holds.set(id, count - 1)
      } else {
        this.holds.delete(id)
        this.considerCandidate(id)
      }
    }
  }

  /**
   * The store's strokes with these IDs (IDs not in the store are left out), once their spilled points are read back.
   * Resolves also when some could not be read: their points stay null. The strokes are not held, so their points may be
   * spilled again a second later: use them, e.g. to save them, when this resolves
   */
  async read(ids: Iterable<string>): Promise<StrokeData[]> {
    const list = [...new Set(ids)]
    await this.readBack(list)
    return list.map((id) => this.strokes.get(id)).filter((stroke): stroke is StrokeData => stroke !== undefined)
  }

  /** Attaches a spill target (core/spill.ts attachSpill) */
  private attachSpill(options: SpillOptions): boolean {
    if (!this.spillEnabled) return false
    if (this.spillState) return true
    this.spillState = { options, stopped: false, writing: false, candidates: new Map() }
    for (const id of this.strokes.keys()) this.considerCandidate(id)
    return true
  }

  /** Makes a stroke a candidate for spilling when it can be one and is not yet */
  private considerCandidate(id: string): void {
    const state = this.spillState
    if (!state || state.stopped || state.candidates.has(id)) return
    if (this.holds.has(id) || this.open.has(id) || this.busy.has(id) || this.growing.has(id)) return
    const stroke = this.strokes.get(id)
    if (!stroke || stroke.points === null || stroke.points.length === 0 || stroke.order === undefined) return
    // A stroke of more points than one write takes stays in memory (decision 0026)
    if (pointCount(stroke.points) > MAX_SPILL_POINTS) return
    // Always added last, so the candidates stay in the order they became ones
    state.candidates.set(id, state.options.now())
  }

  /** Writes the candidates of SPILL_DELAY_MS or more and drops their points (core/spill.ts spillStrokes) */
  private async spillNow(): Promise<void> {
    const state = this.spillState
    if (!state || state.stopped || state.writing) return
    const now = state.options.now()
    const batch: { stroke: StrokeData; points: Float64Array; since: number }[] = []
    const records: SpillRecord[] = []
    let total = 0
    for (const [id, since] of state.candidates) {
      if (now - since < SPILL_DELAY_MS) break
      const stroke = this.strokes.get(id)
      const points = stroke?.points
      if (!stroke || !points || this.holds.has(id) || this.open.has(id) || this.busy.has(id)) {
        state.candidates.delete(id)
        continue
      }
      // The record holds these very points: nothing to write
      if (this.recorded.get(id) === points) {
        this.drop(stroke)
        continue
      }
      const count = pointCount(points)
      if (count > MAX_SPILL_POINTS) {
        state.candidates.delete(id)
        continue
      }
      if (total + count > MAX_SPILL_POINTS) break
      total += count
      batch.push({ stroke, points, since })
      records.push(stroke.pressure ? { id, points, pressure: stroke.pressure } : { id, points })
    }
    if (batch.length === 0) return
    for (const { stroke } of batch) this.stored.add(stroke.id)
    state.writing = true
    try {
      await state.options.target.put(records)
    } catch (error) {
      state.writing = false
      this.stopSpilling(state, error)
      return
    }
    state.writing = false
    for (const { stroke, points, since } of batch) {
      // A stroke removed, reset away or changed meanwhile keeps what it has now
      if (this.strokes.get(stroke.id) !== stroke || stroke.points !== points) continue
      this.recorded.set(stroke.id, points)
      // Held, or made a candidate again, meanwhile: the points stay for now
      if (this.spillState === state && !state.stopped && state.candidates.get(stroke.id) === since) this.drop(stroke)
    }
  }

  /** Drops the points of a stroke whose record holds them */
  private drop(stroke: StrokeData): void {
    this.spillState?.candidates.delete(stroke.id)
    this.recorded.delete(stroke.id)
    this.spilled.add(stroke.id)
    stroke.points = null
    if (stroke.pressure) stroke.pressure = null
  }

  /**
   * Reads back the points of the spilled ones among `ids`; resolves once they are back (also when some could not be
   * read), and at once when none is spilled
   */
  private readBack(ids: Iterable<string>): Promise<void> {
    const waits: Promise<void>[] = []
    const batch: StrokeData[] = []
    for (const id of ids) {
      const reading = this.reading.get(id)
      if (reading) waits.push(reading.done)
      else if (this.spilled.has(id)) batch.push(this.strokes.get(id)!)
    }
    const state = this.spillState
    if (batch.length > 0 && state) {
      const ids = batch.map((stroke) => stroke.id)
      const done = Promise.resolve()
        .then(() => state.options.target.get(ids))
        .catch((error: unknown) => {
          state.options.onError(asError(error))
          return new Map<string, SpillRecord>()
        })
        .then((records) => this.readDone(batch, records, state))
      for (const stroke of batch) this.reading.set(stroke.id, { stroke, done })
      waits.push(done)
    }
    return waits.length === 0 ? Promise.resolve() : Promise.all(waits).then(() => {})
  }

  /** Gives the strokes read back their points, when they are the strokes the read was for, then applies what waited */
  private readDone(strokes: StrokeData[], records: Map<string, SpillRecord>, state: SpillState): void {
    let missing = 0
    for (const stroke of strokes) {
      const { id } = stroke
      if (this.reading.get(id)?.stroke === stroke) this.reading.delete(id)
      // Removed, reset away or replaced by a stroke of the same ID meanwhile
      if (this.strokes.get(id) !== stroke || !this.spilled.has(id)) continue
      this.spilled.delete(id)
      const record = records.get(id)
      const hadPressure = stroke.pressure === null
      if (
        !record ||
        !validPoints(record.points) ||
        (hadPressure ? !validPressure(record.pressure, record.points) : record.pressure !== undefined)
      ) {
        this.lost.add(id)
        missing++
        continue
      }
      stroke.points = record.points
      if (hadPressure) stroke.pressure = record.pressure
      this.recorded.set(id, record.points)
      this.considerCandidate(id)
    }
    if (missing > 0) state.options.onError(new Error(`The points of ${missing} spilled strokes could not be read back`))
    this.drain()
  }

  /** A stroke left the store: it is no longer spilled, and its record goes */
  private forget(id: string): void {
    this.open.delete(id)
    this.extents.delete(id)
    this.recorded.delete(id)
    this.spilled.delete(id)
    this.lost.delete(id)
    const stored = this.stored.delete(id)
    const state = this.spillState
    if (!state) return
    state.candidates.delete(id)
    // After a write of it under way, if any: the target does them in the order they are asked for
    if (stored) state.options.target.delete([id]).catch((error: unknown) => this.stopSpilling(state, error))
  }

  /** A reset: the ops waiting and the records go, and the reads under way are for strokes no longer here */
  private forgetSpilling(): void {
    this.waiting = []
    this.busy.clear()
    this.reading.clear()
    this.recorded.clear()
    this.stored.clear()
    this.spilled.clear()
    this.lost.clear()
    const state = this.spillState
    if (!state) return
    state.candidates.clear()
    state.options.target.clear().catch((error: unknown) => this.stopSpilling(state, error))
  }

  /** A write failed or the target cannot be used: reports it, stops spilling and reads every point back */
  private stopSpilling(state: SpillState, error: unknown): void {
    if (state.stopped) return
    state.stopped = true
    state.candidates.clear()
    state.options.onError(asError(error))
    void this.readBack([...this.spilled])
  }

  /** Stops spilling, reads every point back and clears the target (core/spill.ts detachSpill) */
  private async detachSpill(): Promise<void> {
    const state = this.spillState
    if (!state) return
    state.stopped = true
    state.candidates.clear()
    await this.readBack([...this.spilled])
    try {
      await state.options.target.clear()
    } catch (error) {
      state.options.onError(asError(error))
    }
    if (this.spillState !== state) return
    this.spillState = null
    this.recorded.clear()
    this.stored.clear()
    // Points that could not be read stay null; the records are gone
    for (const id of this.spilled) this.lost.add(id)
    this.spilled.clear()
  }
}

/** The bounds of a stroke's center line and its first point (see StrokeStore.extent) */
type StrokeExtent = { minX: number; minY: number; maxX: number; maxY: number; start: Point }

/** What the store keeps of an attached spill target */
type SpillState = {
  options: SpillOptions
  /** Spilling stopped: a write failed, or the target is being detached */
  stopped: boolean
  /** A write is under way */
  writing: boolean
  /** The strokes that can be spilled, with the time each became one, in that order */
  candidates: Map<string, number>
}

/**
 * An op waiting for points to be read back (see StrokeStore.apply): of one stroke, or a split with its pieces. A load
 * keeps the order it took when it came, in the default mode
 */
type Waiting = { op: StrokeOp; origin: Origin; ids: string[]; orders?: (number | undefined)[] }

/** The IDs of the strokes an op touches */
function touchedIds(op: StrokeOp): string[] {
  switch (op.type) {
    case 'transform':
      return op.ids
    case 'replace':
    case 'reset':
    case 'load':
      return op.strokes.map((stroke) => stroke.id)
    case 'restore':
      return [op.stroke.id]
    case 'split':
      return [op.id, ...op.pieces.map((piece) => piece.id)]
    default:
      return [op.id]
  }
}

/** Whether an op needs the points of the strokes it touches */
function needsPoints(op: StrokeOp): boolean {
  return op.type === 'points' || op.type === 'split' || op.type === 'transform' || op.type === 'replace'
}

/** The extent of points (x and y in turn), or undefined when there are none */
function extentOf(points: Float64Array): StrokeExtent | undefined {
  if (points.length < 2) return undefined
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i + 1 < points.length; i += 2) {
    minX = Math.min(minX, points[i])
    minY = Math.min(minY, points[i + 1])
    maxX = Math.max(maxX, points[i])
    maxY = Math.max(maxY, points[i + 1])
  }
  return { minX, minY, maxX, maxY, start: [points[0], points[1]] }
}

/** The extent of a stroke's points and of points appended to them */
function unionExtent(a: StrokeExtent, b: StrokeExtent): StrokeExtent {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    start: a.start,
  }
}

/** What was thrown or rejected with, as an Error */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
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
  if (stroke.points === null || !validPoints(pts)) return false
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
 * one coefficient per point, when the op disagrees with the stroke's earlier points about having pressure, or when the
 * stroke's points are spilled (null)
 */
export function appendPoints(stroke: StrokeData, pts: Float64Array, ps: Float32Array | undefined): boolean {
  if (!canAppend(stroke, pts, ps)) return false
  const current = stroke.points!
  const points = new Float64Array(current.length + pts.length)
  points.set(current)
  points.set(pts, current.length)
  stroke.points = points
  if (ps !== undefined) {
    const pressure = new Float32Array(pointCount(points))
    if (stroke.pressure) pressure.set(stroke.pressure)
    pressure.set(ps, pressure.length - ps.length)
    stroke.pressure = pressure
  }
  return true
}
