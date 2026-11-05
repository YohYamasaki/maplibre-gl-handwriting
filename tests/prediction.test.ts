// The browser's predicted points are drawn after the tip of the stroke being drawn only,
// up to the time ahead (Prediction.ms) after their pointermove and within how far the pointer goes in that time at its
// speed since the previous pointermove (at most 24 px). They never reach the store (so the sync layer, which sends the
// store's ops, never sends them) and never the frozen part
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrokeStore, type Point, type StrokeData, type StrokeOp } from '../src/core/stroke'
import { registerDebugPrediction, setDebugPredictionMs, debugPredictionCounts } from '../src/debug'
import type { MeshBuffer } from '../src/MeshBuffer'
import { DrawController } from '../src/DrawController'
import {
  DEFAULT_PREDICTION_MS,
  MAX_PREDICTED_PX,
  PREDICTION_TIMEOUT_MS,
  Prediction,
  predictedPositions,
  predictionLimit,
} from '../src/Prediction'
import { StrokeScene } from '../src/StrokeScene'
import type { MeshWriter, Samples } from '../src/StrokeTessellator'
import { DeferredBuilds, fakeWriter, pairs, xy } from './support'

// One CSS px is 1e-6 in Web Mercator units, from [0.5, 0.5] at client (0, 0)
const PX = 1e-6
const project = (x: number, y: number): Point => [0.5 + x * PX, 0.5 + y * PX]
const WORLD = { minX: 0, minY: 0, maxX: 1, maxY: 1 }

/** A predicted event: client x, client y and timeStamp */
type Predicted = [number, number, number]

/** A pointer event of `type` at client (x, y) and `time`, with getPredictedEvents giving `predicted` when given */
function pointerEvent(type: string, x: number, y: number, time: number, predicted?: Predicted[]): Event {
  const fields: Record<string, unknown> = { pointerId: 1, button: 0, pointerType: 'mouse', clientX: x, clientY: y }
  if (predicted)
    fields.getPredictedEvents = () => predicted.map(([px, py, t]) => ({ clientX: px, clientY: py, timeStamp: t }))
  const event = Object.assign(new Event(type), fields)
  // Event.timeStamp is a getter on the prototype, which Object.assign cannot set
  Object.defineProperty(event, 'timeStamp', { value: time })
  return event
}

function drawing(ms = DEFAULT_PREDICTION_MS): {
  store: StrokeStore
  ops: StrokeOp[]
  prediction: Prediction
  pointer: (type: string, x: number, y: number, time: number, predicted?: Predicted[]) => void
} {
  const store = new StrokeStore({ order: 'custom' })
  const prediction = new Prediction(ms)
  const element = Object.assign(new EventTarget(), { setPointerCapture: (): void => {} }) as unknown as HTMLElement
  let next = 0
  const draw = new DrawController(element, store, project, {
    startStroke: () => ({ id: `s:${++next}`, author: 'a', color: '#000000', width: 4, pressure: null }),
    getZoom: () => 12,
    onStroke: () => {},
    prediction,
  })
  draw.enable()
  const ops: StrokeOp[] = []
  store.subscribe((op) => ops.push(op))
  const pointer = (type: string, x: number, y: number, time: number, predicted?: Predicted[]): void => {
    element.dispatchEvent(pointerEvent(type, x, y, time, predicted))
  }
  return { store, ops, prediction, pointer }
}

const pointsOf = (ops: StrokeOp[]): Point[] => ops.flatMap((op) => (op.type === 'points' ? pairs(op.pts) : []))
const at = ([x, y, t]: Predicted): { clientX: number; clientY: number; timeStamp: number } => ({
  clientX: x,
  clientY: y,
  timeStamp: t,
})

describe('predictedPositions', () => {
  it('keeps every point up to the time ahead, however many, and drops the first after it with every point after it', () => {
    // 240 Hz: 4.2 ms apart, the 5th 20.8 ms ahead
    const events = [1, 2, 3, 4, 5, 6].map((k) => at([k, 0, 100 + k * 4.16]))
    expect(predictedPositions([0, 0], 100, events, 24, 20)).toEqual({
      positions: [
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
      ],
      dropped: 'time',
    })
    // A point exactly the time ahead is kept
    expect(predictedPositions([0, 0], 100, [at([1, 0, 120])], 24, 20)).toEqual({ positions: [[1, 0]], dropped: null })
  })

  it('drops a point behind the pointermove, and every point after it, for the time', () => {
    expect(predictedPositions([0, 0], 100, [at([1, 0, 99]), at([2, 0, 104])], 24, 20)).toEqual({
      positions: [],
      dropped: 'time',
    })
  })

  // A point beyond the limit is not pulled back; it and every point after it are dropped
  it('drops a point farther than the limit and every point after it, even one within the limit', () => {
    expect(predictedPositions([0, 0], 0, [at([3, 4, 5]), at([6, 8, 10])], 5, 20)).toEqual({
      positions: [[3, 4]],
      dropped: 'distance',
    })
    expect(predictedPositions([0, 0], 0, [at([9, 0, 5]), at([1, 0, 10])], 5, 20)).toEqual({
      positions: [],
      dropped: 'distance',
    })
  })

  it('gives the time as the reason when a point is both too far ahead and too far away', () => {
    expect(predictedPositions([0, 0], 0, [at([1, 0, 5]), at([30, 0, 30])], 5, 20)).toEqual({
      positions: [[1, 0]],
      dropped: 'time',
    })
  })

  it('drops every point for the time with a time ahead of 0, and gives no reason without predicted events', () => {
    expect(predictedPositions([0, 0], 0, [at([1, 0, 0]), at([2, 0, 4])], 24, 0)).toEqual({
      positions: [],
      dropped: 'time',
    })
    expect(predictedPositions([0, 0], 0, [], 24, 20)).toEqual({ positions: [], dropped: null })
    expect(predictedPositions([0, 0], 0, [], 24, 0)).toEqual({ positions: [], dropped: null })
  })
})

describe('predictionLimit', () => {
  it('is how far the pointer goes in the time ahead at its speed, at most 24 px', () => {
    // 10 px in 8 ms is 1.25 px/ms: 25 px in 20 ms, capped at 24
    expect(predictionLimit(10, 8, 20)).toBe(MAX_PREDICTED_PX)
    expect(predictionLimit(10, 8, 16)).toBe(20)
    expect(predictionLimit(4, 16, 20)).toBe(5)
    expect(predictionLimit(4, 16, 0)).toBe(0)
  })

  it('is 0 when the time since the previous pointermove is not above 0', () => {
    expect(predictionLimit(10, 0, 20)).toBe(0)
    expect(predictionLimit(10, -5, 20)).toBe(0)
  })
})

describe('DrawController with predicted events', () => {
  it('hands predicted points to the prediction only, replaces them on each move and drops them at the end', () => {
    const { store, ops, prediction, pointer } = drawing()
    pointer('pointerdown', 0, 0, 0)
    pointer('pointermove', 10, 0, 10, [
      [12, 0, 12],
      [14, 0, 14],
    ])
    expect(prediction.get('s:1')).toEqual([project(12, 0), project(14, 0)])
    pointer('pointermove', 20, 0, 20, [[23, 0, 23]])
    expect(prediction.get('s:1')).toEqual([project(23, 0)])
    // A move without predicted events (a browser without getPredictedEvents) leaves none
    pointer('pointermove', 30, 0, 30)
    expect(prediction.get('s:1')).toBeUndefined()
    pointer('pointermove', 40, 0, 40, [[45, 0, 45]])
    pointer('pointerup', 40, 0, 41)
    expect(prediction.size).toBe(0)

    const real = [project(0, 0), project(10, 0), project(20, 0), project(30, 0), project(40, 0)]
    expect(pointsOf(ops)).toEqual(real)
    expect(pairs(store.get('s:1')!.points)).toEqual(real)
  })

  it('draws the points up to the time ahead after the pointermove, more than two when they are', () => {
    const { prediction, pointer } = drawing(20)
    pointer('pointerdown', 0, 0, 0)
    // 120 Hz: 8 px every 8.3 ms, about 19 px in 20 ms; the 3rd point is 25 ms ahead
    pointer('pointermove', 8, 0, 8.3, [
      [16, 0, 16.6],
      [24, 0, 24.9],
      [32, 0, 33.2],
    ])
    expect(prediction.get('s:1')).toEqual([project(16, 0), project(24, 0)])
    // 240 Hz: 4 px every 4.2 ms, about 19 px in 20 ms; the 5th point is 20.8 ms ahead
    pointer('pointermove', 12, 0, 12.5, [
      [16, 0, 16.7],
      [20, 0, 20.8],
      [24, 0, 25],
      [28, 0, 29.1],
      [32, 0, 33.3],
    ])
    expect(prediction.get('s:1')).toEqual([project(16, 0), project(20, 0), project(24, 0), project(28, 0)])
  })

  it('limits the distance to the speed since the pointerdown, then since the previous move, times the time ahead', () => {
    const { prediction, pointer } = drawing(20)
    pointer('pointerdown', 100, 0, 0)
    // 5 px in 10 ms from the pointerdown: within 10 px
    pointer('pointermove', 105, 0, 10, [
      [111, 0, 14],
      [116, 0, 18],
    ])
    expect(prediction.get('s:1')).toEqual([project(111, 0)])
    // 15 px in 10 ms: 30 px in 20 ms, capped at 24 px
    pointer('pointermove', 120, 0, 20, [
      [140, 0, 30],
      [145, 0, 34],
    ])
    expect(prediction.get('s:1')).toEqual([project(140, 0)])
  })

  it('limits the distance to the time ahead it has now', () => {
    const { prediction, pointer } = drawing(10)
    pointer('pointerdown', 0, 0, 0)
    // 1 px/ms: 10 px in 10 ms
    pointer('pointermove', 10, 0, 10, [
      [18, 0, 18],
      [21, 0, 19],
    ])
    expect(prediction.get('s:1')).toEqual([project(18, 0)])
  })

  it('draws no predicted point after a move at the same time as the previous one', () => {
    const { prediction, pointer } = drawing()
    pointer('pointerdown', 0, 0, 5)
    pointer('pointermove', 10, 0, 5, [[11, 0, 9]])
    expect(prediction.get('s:1')).toBeUndefined()
    pointer('pointermove', 20, 0, 4, [[21, 0, 8]])
    expect(prediction.get('s:1')).toBeUndefined()
  })

  it('draws none with a time ahead of 0, and the latest input not recorded yet still', () => {
    const { prediction, pointer } = drawing(0)
    pointer('pointerdown', 0, 0, 0)
    pointer('pointermove', 1, 0, 8, [
      [2, 0, 12],
      [3, 0, 16],
    ])
    // Not recorded (within 4 px of the pointerdown): drawn after the tip alone
    expect(prediction.get('s:1')).toEqual([project(1, 0)])
  })

  it('counts the offered points as kept and dropped by time and by distance, a point after a dropped one with it', () => {
    const { prediction, pointer } = drawing(20)
    const handle = {}
    registerDebugPrediction(handle, prediction)
    pointer('pointerdown', 0, 0, 0)
    // 1 px/ms: 20 px. Two kept, the 3rd 21 ms ahead
    pointer('pointermove', 10, 0, 10, [
      [15, 0, 15],
      [20, 0, 20],
      [31, 0, 31],
    ])
    // The 1st 21 px away: it and the two after it, one within the limit and one too far ahead, are dropped by distance
    pointer('pointermove', 20, 0, 20, [
      [41, 0, 30],
      [21, 0, 31],
      [22, 0, 50],
    ])
    expect(debugPredictionCounts(handle)).toEqual({
      counts: { offered: 6, kept: 2, droppedByTime: 1, droppedByDistance: 3 },
      aheadMs: [10, 11, 30],
    })
    // A time ahead of 0 counts every point as dropped by time
    setDebugPredictionMs(handle, 0)
    pointer('pointermove', 30, 0, 30, [
      [31, 0, 31],
      [32, 0, 32],
    ])
    expect(debugPredictionCounts(handle)).toEqual({
      counts: { offered: 8, kept: 2, droppedByTime: 3, droppedByDistance: 3 },
      aheadMs: [1, 2],
    })
    // A move without predicted events counts nothing and leaves no time ahead
    pointer('pointermove', 40, 0, 40)
    expect(debugPredictionCounts(handle)).toEqual({
      counts: { offered: 8, kept: 2, droppedByTime: 3, droppedByDistance: 3 },
      aheadMs: [],
    })
  })

  it('drops the predicted points drawn now when the development tools set the time ahead to 0', () => {
    const { prediction, pointer } = drawing(20)
    const handle = {}
    registerDebugPrediction(handle, prediction)
    pointer('pointerdown', 0, 0, 0)
    pointer('pointermove', 10, 0, 10, [[12, 0, 12]])
    expect(prediction.get('s:1')).toEqual([project(12, 0)])
    setDebugPredictionMs(handle, 0)
    expect(prediction.ms).toBe(0)
    expect(prediction.get('s:1')).toBeUndefined()
    setDebugPredictionMs(handle, 15)
    pointer('pointermove', 20, 0, 20, [
      [25, 0, 25],
      [30, 0, 36],
    ])
    expect(prediction.get('s:1')).toEqual([project(25, 0)])
  })
})

describe('DrawController prediction timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops the predicted points when no move comes for 32 ms, and keeps them while moves come', () => {
    vi.useFakeTimers()
    const { store, prediction, pointer } = drawing()
    pointer('pointerdown', 0, 0, 0)
    pointer('pointermove', 10, 0, 10, [[15, 0, 15]])
    vi.advanceTimersByTime(PREDICTION_TIMEOUT_MS - 1)
    pointer('pointermove', 20, 0, 20, [[25, 0, 25]])
    vi.advanceTimersByTime(PREDICTION_TIMEOUT_MS - 1)
    expect(prediction.get('s:1')).toEqual([project(25, 0)])
    vi.advanceTimersByTime(1)
    expect(prediction.get('s:1')).toBeUndefined()
    expect(pairs(store.get('s:1')!.points)).toEqual([project(0, 0), project(10, 0), project(20, 0)])
  })

  it('leaves no timer after the stroke ends', () => {
    vi.useFakeTimers()
    const { pointer } = drawing()
    pointer('pointerdown', 0, 0, 0)
    pointer('pointermove', 10, 0, 10, [[15, 0, 15]])
    pointer('pointerup', 10, 0, 11)
    expect(vi.getTimerCount()).toBe(0)
  })
})

/** A writer that records the samples of each piece it is asked for, and writes the fake mesh */
function recordingWriter(): { writer: MeshWriter; pieces: { mesh: MeshBuffer; points: Point[] }[] } {
  const pieces: { mesh: MeshBuffer; points: Point[] }[] = []
  const writer: MeshWriter = {
    appendStroke: (mesh, stroke, zoom) => fakeWriter.appendStroke(mesh, stroke, zoom),
    appendPiece(mesh: MeshBuffer, stroke: StrokeData, samples: Samples, from: number, to: number, zoom: number): void {
      pieces.push({ mesh, points: samples.points.slice(from, to + 1) })
      fakeWriter.appendPiece(mesh, stroke, samples, from, to, zoom)
    },
  }
  return { writer, pieces }
}

describe('StrokeScene with predicted points', () => {
  function scene(): {
    store: StrokeStore
    prediction: Prediction
    pieces: { mesh: MeshBuffer; points: Point[] }[]
    s: StrokeScene
    hot: () => { frozen: MeshBuffer; tail: MeshBuffer; frozenTo: number }
  } {
    const store = new StrokeStore({ order: 'custom' })
    const prediction = new Prediction(DEFAULT_PREDICTION_MS)
    const { writer, pieces } = recordingWriter()
    const s = new StrokeScene(store, writer, new DeferredBuilds(), 12, () => {}, null, prediction)
    const hot = (): { frozen: MeshBuffer; tail: MeshBuffer; frozenTo: number } => s.inspect().active.get('s:1')!
    store.apply({ type: 'begin', id: 's:1', author: 'a', color: '#000000', width: 4, zoom: 12 }, 'local')
    return { store, prediction, pieces, s, hot }
  }
  // Points 10 px apart, far enough to be samples at zoom 12
  const at = (i: number): Point => project(10 * i, 0)

  it('draws them after the tail only, and the frozen part from real points alone', () => {
    const { store, prediction, pieces, s, hot } = scene()
    for (let i = 0; i < 80; i++) {
      store.apply({ type: 'points', id: 's:1', pts: xy([at(i)]) }, 'local')
      prediction.set('s:1', [at(i + 1), at(i + 2)])
      s.frame(WORLD, 12)
    }
    expect(hot().frozenTo, 'some of the stroke was frozen').toBeGreaterThan(0)
    const real = new Set(pairs(store.get('s:1')!.points).map((p) => p.join()))
    const frozen = pieces.filter((piece) => piece.mesh === hot().frozen)
    expect(frozen.length).toBeGreaterThan(0)
    for (const piece of frozen)
      for (const p of piece.points) expect(real.has(p.join()), `${p} in the frozen part`).toBe(true)
    // The latest tail ends with the two predicted points
    const tail = pieces.filter((piece) => piece.mesh === hot().tail).at(-1)!
    expect(tail.points.slice(-3)).toEqual([at(79), at(80), at(81)])
    expect(tail.points[0]).toEqual(pairs(store.get('s:1')!.points)[hot().frozenTo])
  })

  it('tessellates the tail again when the prediction alone changes, and drops the predicted part with it', () => {
    const { store, prediction, pieces, s, hot } = scene()
    for (let i = 0; i < 5; i++) store.apply({ type: 'points', id: 's:1', pts: xy([at(i)]) }, 'local')
    s.frame(WORLD, 12)
    const tails = (): Point[][] => pieces.filter((piece) => piece.mesh === hot().tail).map((piece) => piece.points)
    expect(tails().at(-1)!.at(-1)).toEqual(at(4))
    prediction.set('s:1', [at(5)])
    s.frame(WORLD, 12)
    expect(tails().at(-1)!.at(-1)).toEqual(at(5))
    prediction.set('s:1', [])
    s.frame(WORLD, 12)
    expect(tails().at(-1)!.at(-1)).toEqual(at(4))
    // Nothing changed: no tessellation
    const count = pieces.length
    prediction.set('s:1', [])
    s.frame(WORLD, 12)
    expect(pieces.length).toBe(count)
  })

  it('gives predicted points the last coefficient of a stroke with pressure', () => {
    const store = new StrokeStore({ order: 'custom' })
    const prediction = new Prediction(DEFAULT_PREDICTION_MS)
    const seen: Samples[] = []
    const writer: MeshWriter = {
      appendStroke: (mesh, stroke, zoom) => fakeWriter.appendStroke(mesh, stroke, zoom),
      appendPiece(mesh, stroke, samples, from, to, zoom): void {
        seen.push(structuredClone(samples))
        fakeWriter.appendPiece(mesh, stroke, samples, from, to, zoom)
      },
    }
    const s = new StrokeScene(store, writer, new DeferredBuilds(), 12, () => {}, null, prediction)
    store.apply({ type: 'begin', id: 's:1', author: 'a', color: '#000000', width: 4, zoom: 12 }, 'local')
    store.apply(
      { type: 'points', id: 's:1', pts: xy([at(0), at(1), at(2)]), ps: Float32Array.of(1, 0.8, 0.6) },
      'local',
    )
    prediction.set('s:1', [at(3)])
    s.frame(WORLD, 12)
    const last = seen.at(-1)!
    expect(last.points.at(-1)).toEqual(at(3))
    expect(last.pressure).toEqual(Array.from(Float32Array.of(1, 0.8, 0.6, 0.6)))
  })
})
