// Decisions 0037 P7-1, 0080: the browser's predicted points are drawn after the tip of the stroke being drawn only. They never
// reach the store (so the sync layer, which sends the store's ops, never sends them) and never the frozen part
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrokeStore, type Point, type StrokeData, type StrokeOp } from '../src/core/stroke'
import type { MeshBuffer } from '../src/MeshBuffer'
import { DrawController } from '../src/DrawController'
import { MAX_PREDICTED_PX, PREDICTION_TIMEOUT_MS, Prediction, predictedPositions } from '../src/Prediction'
import { StrokeScene } from '../src/StrokeScene'
import type { MeshWriter, Samples } from '../src/StrokeTessellator'
import { DeferredBuilds, fakeWriter } from './support'

// One CSS px is 1e-6 in Web Mercator units, from [0.5, 0.5] at client (0, 0)
const PX = 1e-6
const project = (x: number, y: number): Point => [0.5 + x * PX, 0.5 + y * PX]
const WORLD = { minX: 0, minY: 0, maxX: 1, maxY: 1 }

type Position = { clientX: number; clientY: number }

function drawing(): {
  store: StrokeStore
  ops: StrokeOp[]
  prediction: Prediction
  pointer: (type: string, x: number, y: number, predicted?: [number, number][]) => void
} {
  const store = new StrokeStore({ order: 'custom' })
  const prediction = new Prediction()
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
  const pointer = (type: string, x: number, y: number, predicted?: [number, number][]): void => {
    const fields: Record<string, unknown> = { pointerId: 1, button: 0, pointerType: 'mouse', clientX: x, clientY: y }
    if (predicted)
      fields.getPredictedEvents = (): Position[] => predicted.map(([px, py]) => ({ clientX: px, clientY: py }))
    element.dispatchEvent(Object.assign(new Event(type), fields))
  }
  return { store, ops, prediction, pointer }
}

const pointsOf = (ops: StrokeOp[]): Point[] => ops.flatMap((op) => (op.type === 'points' ? op.pts : []))

describe('predictedPositions', () => {
  it('keeps at most two points', () => {
    expect(
      predictedPositions(
        [0, 0],
        [
          { clientX: 1, clientY: 0 },
          { clientX: 2, clientY: 0 },
          { clientX: 3, clientY: 0 },
        ],
        10,
      ),
    ).toEqual([
      [1, 0],
      [2, 0],
    ])
  })

  // Decision 0080: a point beyond the limit is not pulled back; it and every point after it are dropped
  it('drops a point farther than the limit and every point after it', () => {
    expect(
      predictedPositions(
        [0, 0],
        [
          { clientX: 3, clientY: 4 },
          { clientX: 6, clientY: 8 },
        ],
        5,
      ),
    ).toEqual([[3, 4]])
    expect(
      predictedPositions(
        [0, 0],
        [
          { clientX: 9, clientY: 0 },
          { clientX: 1, clientY: 0 },
        ],
        5,
      ),
    ).toEqual([])
  })

  it('caps the limit at 24 px however far the pointer moved', () => {
    const near = { clientX: 10, clientY: 10 + MAX_PREDICTED_PX }
    const far = { clientX: 10, clientY: 10 + MAX_PREDICTED_PX + 1 }
    expect(predictedPositions([10, 10], [near, far], 100)).toEqual([[near.clientX, near.clientY]])
  })

  it('predicts nothing without predicted events, or when the pointer did not move', () => {
    expect(predictedPositions([0, 0], [], 10)).toEqual([])
    expect(predictedPositions([0, 0], [{ clientX: 1, clientY: 0 }], 0)).toEqual([])
  })
})

describe('DrawController with predicted events', () => {
  it('hands predicted points to the prediction only, replaces them on each move and drops them at the end', () => {
    const { store, ops, prediction, pointer } = drawing()
    pointer('pointerdown', 0, 0)
    pointer('pointermove', 10, 0, [
      [12, 0],
      [14, 0],
    ])
    expect(prediction.get('s:1')).toEqual([project(12, 0), project(14, 0)])
    pointer('pointermove', 20, 0, [[23, 0]])
    expect(prediction.get('s:1')).toEqual([project(23, 0)])
    // A move without predicted events (a browser without getPredictedEvents) leaves none
    pointer('pointermove', 30, 0)
    expect(prediction.get('s:1')).toBeUndefined()
    pointer('pointermove', 40, 0, [[45, 0]])
    pointer('pointerup', 40, 0)
    expect(prediction.size).toBe(0)

    const real = [project(0, 0), project(10, 0), project(20, 0), project(30, 0), project(40, 0)]
    expect(pointsOf(ops)).toEqual(real)
    expect(store.get('s:1')!.points).toEqual(real)
  })

  it('compares the first move with the pointerdown position, and later ones with the previous move', () => {
    const { prediction, pointer } = drawing()
    pointer('pointerdown', 100, 0)
    // Moved 5 px from the pointerdown: a point 6 px ahead is dropped, though it is within 24 px
    pointer('pointermove', 105, 0, [[111, 0]])
    expect(prediction.get('s:1')).toBeUndefined()
    pointer('pointermove', 120, 0, [
      [130, 0],
      [140, 0],
    ])
    // Moved 15 px: 10 px ahead is kept, 20 px ahead is dropped
    expect(prediction.get('s:1')).toEqual([project(130, 0)])
  })

  it('counts the kept and dropped 1st and 2nd points', () => {
    const { prediction, pointer } = drawing()
    pointer('pointerdown', 0, 0)
    pointer('pointermove', 10, 0, [
      [15, 0],
      [25, 0],
    ])
    pointer('pointermove', 20, 0, [
      [40, 0],
      [41, 0],
    ])
    pointer('pointermove', 30, 0, [[35, 0]])
    expect(prediction.debug?.counts).toEqual({ kept: [2, 0], dropped: [1, 2] })
  })
})

describe('DrawController prediction timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops the predicted points when no move comes for 32 ms, and keeps them while moves come', () => {
    vi.useFakeTimers()
    const { store, prediction, pointer } = drawing()
    pointer('pointerdown', 0, 0)
    pointer('pointermove', 10, 0, [[15, 0]])
    vi.advanceTimersByTime(PREDICTION_TIMEOUT_MS - 1)
    pointer('pointermove', 20, 0, [[25, 0]])
    vi.advanceTimersByTime(PREDICTION_TIMEOUT_MS - 1)
    expect(prediction.get('s:1')).toEqual([project(25, 0)])
    vi.advanceTimersByTime(1)
    expect(prediction.get('s:1')).toBeUndefined()
    expect(store.get('s:1')!.points).toEqual([project(0, 0), project(10, 0), project(20, 0)])
  })

  it('leaves no timer after the stroke ends', () => {
    vi.useFakeTimers()
    const { pointer } = drawing()
    pointer('pointerdown', 0, 0)
    pointer('pointermove', 10, 0, [[15, 0]])
    pointer('pointerup', 10, 0)
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
    const prediction = new Prediction()
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
      store.apply({ type: 'points', id: 's:1', pts: [at(i)] }, 'local')
      prediction.set('s:1', [at(i + 1), at(i + 2)])
      s.frame(WORLD, 12)
    }
    expect(hot().frozenTo, 'some of the stroke was frozen').toBeGreaterThan(0)
    const real = new Set(store.get('s:1')!.points.map((p) => p.join()))
    const frozen = pieces.filter((piece) => piece.mesh === hot().frozen)
    expect(frozen.length).toBeGreaterThan(0)
    for (const piece of frozen)
      for (const p of piece.points) expect(real.has(p.join()), `${p} in the frozen part`).toBe(true)
    // The latest tail ends with the two predicted points
    const tail = pieces.filter((piece) => piece.mesh === hot().tail).at(-1)!
    expect(tail.points.slice(-3)).toEqual([at(79), at(80), at(81)])
    expect(tail.points[0]).toEqual(store.get('s:1')!.points[hot().frozenTo])
  })

  it('tessellates the tail again when the prediction alone changes, and drops the predicted part with it', () => {
    const { store, prediction, pieces, s, hot } = scene()
    for (let i = 0; i < 5; i++) store.apply({ type: 'points', id: 's:1', pts: [at(i)] }, 'local')
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
    const prediction = new Prediction()
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
    store.apply({ type: 'points', id: 's:1', pts: [at(0), at(1), at(2)], ps: [1, 0.8, 0.6] }, 'local')
    prediction.set('s:1', [at(3)])
    s.frame(WORLD, 12)
    const last = seen.at(-1)!
    expect(last.points.at(-1)).toEqual(at(3))
    expect(last.pressure).toEqual([1, 0.8, 0.6, 0.6])
  })
})
