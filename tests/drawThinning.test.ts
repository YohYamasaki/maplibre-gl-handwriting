// Decision 0019: DrawController records the input only once it is min(width, 4) px from the last recorded point on
// screen, at corners (a skipped point more than 0.5 px off the line) and at changes of width coefficient. The points
// in between never reach the store; the latest of them is drawn after the tip (Prediction's pending point) and is
// recorded when the stroke ends
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { StrokeStore, type Point, type StrokeData, type StrokeOp } from '../src/core/stroke'
import { bucketOf } from '../src/core/bucket'
import { setDebugPredictionMs, registerDebugPrediction } from '../src/debug'
import { CORNER_TOLERANCE_PX, CORNER_WINDOW, DrawController, MAX_SAMPLE_SPACING_PX } from '../src/DrawController'
import { MeshBuffer } from '../src/MeshBuffer'
import { mercatorPerPixelAt } from '../src/mercator'
import { DEFAULT_SETTINGS } from '../src/pens'
import { DEFAULT_PREDICTION_MS, PREDICTION_TIMEOUT_MS, Prediction } from '../src/Prediction'
import { PressureFilter } from '../src/pressure'
import { StrokeTessellator } from '../src/StrokeTessellator'
import { pairs, xy } from './support'

const ZOOM = 12
// One CSS px at the drawing zoom, from [0.5, 0.5] at client (0, 0)
const PX = mercatorPerPixelAt(ZOOM)
const project = (x: number, y: number): Point => [0.5 + x * PX, 0.5 + y * PX]
const toClient = (p: Point): [number, number] => [(p[0] - 0.5) / PX, (p[1] - 0.5) / PX]
// What projecting and back loses
const EPSILON = 1e-6

/** One pointer position, with the pen's raw pressure when it is a pen */
type Input = { x: number; y: number; pressure?: number }

/**
 * The time between two pointer events of drawing(), in ms: each event is this much after the one before, and the
 * browser's predicted points of a pointermove are this much apart after it
 */
const EVENT_MS = 8

function drawing(options: { width?: number; pen?: boolean } = {}): {
  store: StrokeStore
  ops: StrokeOp[]
  prediction: Prediction
  draw: DrawController
  down: (p: Input) => void
  /** One pointermove at the last of `inputs`, with all of them as its coalesced events */
  move: (inputs: Input[], predicted?: [number, number][]) => void
  pointer: (type: string, p: Input) => void
  /** The recorded points of the stroke, in client px */
  recorded: () => [number, number][]
} {
  const store = new StrokeStore({ order: 'custom' })
  const prediction = new Prediction(DEFAULT_PREDICTION_MS)
  const element = Object.assign(new EventTarget(), { setPointerCapture: (): void => {} }) as unknown as HTMLElement
  const draw = new DrawController(element, store, project, {
    startStroke: () => ({
      id: 's:1',
      author: 'a',
      color: '#000000',
      width: options.width ?? 4,
      pressure: options.pen ? DEFAULT_SETTINGS.pressure : null,
    }),
    getZoom: () => ZOOM,
    onStroke: () => {},
    prediction,
  })
  draw.enable()
  const ops: StrokeOp[] = []
  store.subscribe((op) => ops.push(op))
  const fieldsOf = (p: Input): Record<string, unknown> => ({
    pointerId: 1,
    button: 0,
    pointerType: options.pen ? 'pen' : 'mouse',
    clientX: p.x,
    clientY: p.y,
    pressure: p.pressure ?? 0.5,
  })
  let time = 0
  const pointer = (type: string, p: Input, extra: Record<string, unknown> = {}): void => {
    const event = Object.assign(new Event(type), fieldsOf(p), extra)
    // Event.timeStamp is a getter on the prototype, which Object.assign cannot set
    Object.defineProperty(event, 'timeStamp', { value: time })
    element.dispatchEvent(event)
    time += EVENT_MS
  }
  const move = (inputs: Input[], predicted?: [number, number][]): void => {
    const extra: Record<string, unknown> = { getCoalescedEvents: () => inputs.map(fieldsOf) }
    const at = time
    if (predicted)
      extra.getPredictedEvents = () =>
        predicted.map(([x, y], i) => ({ clientX: x, clientY: y, timeStamp: at + (i + 1) * EVENT_MS }))
    pointer('pointermove', inputs.at(-1)!, extra)
  }
  return {
    store,
    ops,
    prediction,
    draw,
    down: (p) => pointer('pointerdown', p),
    move,
    pointer,
    recorded: () => pairs(store.get('s:1')!.points).map(toClient),
  }
}

/** Positions every `step` px along the polyline through `corners`, from the first corner (left out) to the last */
function along(corners: [number, number][], step: number): Input[] {
  const out: Input[] = []
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1]
    const [bx, by] = corners[i]
    const n = Math.round(Math.hypot(bx - ax, by - ay) / step)
    for (let k = 1; k <= n; k++) out.push({ x: ax + ((bx - ax) * k) / n, y: ay + ((by - ay) * k) / n })
  }
  return out
}

function distanceToSegment([px, py]: [number, number], [ax, ay]: [number, number], [bx, by]: [number, number]): number {
  const dx = bx - ax
  const dy = by - ay
  const length2 = dx * dx + dy * dy
  const t = length2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

/** The distance from `p` to the polyline through `line` */
function distanceToPolyline(p: [number, number], line: [number, number][]): number {
  if (line.length === 1) return Math.hypot(p[0] - line[0][0], p[1] - line[0][1])
  let best = Infinity
  for (let i = 1; i < line.length; i++) best = Math.min(best, distanceToSegment(p, line[i - 1], line[i]))
  return best
}

/** A seeded generator of numbers in [0, 1) (mulberry32) */
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Draws `inputs` after a pointerdown at `start`, one pointermove each, and lifts the pointer at the last */
function drawPath(d: ReturnType<typeof drawing>, start: Input, inputs: Input[]): void {
  d.down(start)
  for (const p of inputs) d.move([p])
  d.pointer('pointerup', inputs.at(-1) ?? start)
}

const gaps = (line: [number, number][]): number[] =>
  line.slice(1).map((p, i) => Math.hypot(p[0] - line[i][0], p[1] - line[i][1]))

describe('DrawController thinning by distance', () => {
  it('records a 4 px pen every 4 px on a slow straight line, and its last position', () => {
    const d = drawing({ width: 4 })
    drawPath(
      d,
      { x: 0, y: 0 },
      along(
        [
          [0, 0],
          [100, 0],
        ],
        0.25,
      ),
    )
    const line = d.recorded()
    for (const gap of gaps(line).slice(0, -1)) expect(gap).toBeGreaterThanOrEqual(MAX_SAMPLE_SPACING_PX - EPSILON)
    expect(line.length).toBe(26)
    expect(line.at(-1)![0]).toBeCloseTo(100, 6)
    expect(line.at(-1)![1]).toBeCloseTo(0, 6)
  })

  it('records the last position when it is closer than the spacing to the last recorded point', () => {
    const d = drawing({ width: 4 })
    drawPath(
      d,
      { x: 0, y: 0 },
      along(
        [
          [0, 0],
          [10, 0],
        ],
        0.25,
      ),
    )
    const line = d.recorded()
    expect(line.map(([x]) => Math.round(x * 1000) / 1000)).toEqual([0, 4, 8, 10])
  })

  it('records every 4 px for a pen wider than 4 px, and every width for a narrower one', () => {
    for (const [width, spacing] of [
      [16, 4],
      [2, 2],
    ]) {
      const d = drawing({ width })
      drawPath(
        d,
        { x: 0, y: 0 },
        along(
          [
            [0, 0],
            [40, 0],
          ],
          0.25,
        ),
      )
      const line = d.recorded()
      expect(line.length, `width ${width}`).toBe(40 / spacing + 1)
      for (const gap of gaps(line)) expect(gap).toBeCloseTo(spacing, 6)
    }
  })

  it('records nothing while the pen rests with a 0.15 px tremor, but where it was put down and lifted', () => {
    const d = drawing({ width: 4 })
    const rand = seeded(1)
    const tremor = Array.from({ length: 2400 }, () => ({
      x: 50 + (rand() * 2 - 1) * 0.15,
      y: 50 + (rand() * 2 - 1) * 0.15,
    }))
    drawPath(d, { x: 50, y: 50 }, tremor)
    expect(d.recorded().length).toBe(2)
    expect(d.recorded()[1][0]).toBeCloseTo(tremor.at(-1)!.x, 6)
    // No points op while it rested: one for the pointerdown and one for the end
    expect(d.ops.map((op) => op.type)).toEqual(['begin', 'points', 'points', 'end'])
  })

  it('takes coalesced events one at a time, as one points op, and sends no op when none is recorded', () => {
    const d = drawing({ width: 4 })
    d.down({ x: 0, y: 0 })
    d.move(
      along(
        [
          [0, 0],
          [3, 0],
        ],
        0.25,
      ),
    )
    expect(d.ops.filter((op) => op.type === 'points')).toHaveLength(1)
    d.move(
      along(
        [
          [3, 0],
          [9, 0],
        ],
        0.25,
      ),
    )
    const points = d.ops.filter((op) => op.type === 'points')
    expect(points).toHaveLength(2)
    expect(
      points[1].type === 'points' && pairs(points[1].pts).map((p) => Math.round(toClient(p)[0] * 1000) / 1000),
    ).toEqual([4, 8])
  })
})

describe('DrawController thinning at corners', () => {
  function expectWithin(corners: [number, number][]): void {
    const d = drawing({ width: 4 })
    const inputs = along(corners, 0.25)
    drawPath(d, { x: corners[0][0], y: corners[0][1] }, inputs)
    const line = d.recorded()
    for (const p of inputs) {
      expect(distanceToPolyline([p.x, p.y], line), `(${p.x}, ${p.y})`).toBeLessThanOrEqual(
        CORNER_TOLERANCE_PX + EPSILON,
      )
    }
    expect(line.length).toBeLessThan(inputs.length / 4)
  }

  it('keeps every input of a right angle within 0.5 px of the recorded line', () => {
    expectWithin([
      [0, 0],
      [10, 0],
      [10, 10],
    ])
  })

  it('keeps every input of a 3 px flick back within 0.5 px of the recorded line', () => {
    expectWithin([
      [0, 0],
      [20, 0],
      [17, -2],
      [40, -2],
    ])
  })

  it('looks at the latest 32 skipped points only', () => {
    // A is within 0.5 px of the line to each B, and B of the line to P, but A is 0.55 px from the line to P. All are
    // within 4 px of the pointerdown
    const a = { x: 1, y: 0.45 }
    const b = { x: 2, y: 0.2 }
    const p = { x: 3, y: -0.3 }
    for (const [bs, recorded] of [
      [CORNER_WINDOW - 1, 2],
      [CORNER_WINDOW, 1],
    ]) {
      const d = drawing({ width: 4 })
      d.down({ x: 0, y: 0 })
      d.move([a, ...Array.from({ length: bs }, () => b), p])
      expect(d.recorded(), `${bs} points after A`).toHaveLength(recorded)
    }
  })
})

describe('DrawController thinning with pressure', () => {
  const curve = DEFAULT_SETTINGS.pressure

  it('records a point closer than the spacing when its coefficient changed by 0.1 or more', () => {
    const d = drawing({ width: 4, pen: true })
    d.down({ x: 0, y: 0, pressure: 0.2 })
    // 1 px on with a harder press: the smoothed coefficient changes by more than 0.1
    d.move([{ x: 1, y: 0, pressure: 1 }])
    // About as hard: a change under 0.1 is skipped
    d.move([{ x: 1.5, y: 0, pressure: 0.62 }])
    const stroke = d.store.get('s:1')!
    expect(
      pairs(stroke.points)
        .map(toClient)
        .map(([x]) => x),
    ).toEqual([0, 1].map((x) => expect.closeTo(x, 6)))
    const filter = new PressureFilter(curve)
    expect(stroke.pressure).toEqual(Float32Array.of(filter.next(0.2), filter.next(1)))
  })

  it('smooths the pressure over every reading, recorded or not', () => {
    const d = drawing({ width: 4, pen: true })
    const rand = seeded(2)
    const inputs = along(
      [
        [0, 0],
        [40, 0],
      ],
      0.25,
    ).map((p) => ({ ...p, pressure: 0.4 + rand() * 0.2 }))
    drawPath(d, { x: 0, y: 0, pressure: 0.5 }, inputs)
    const filter = new PressureFilter(curve)
    const expected = new Map([[0, filter.next(0.5)]])
    for (const p of inputs) expected.set(Math.round(p.x * 1000), filter.next(p.pressure))
    const stroke = d.store.get('s:1')!
    expect(stroke.points.length / 2).toBeLessThan(inputs.length / 4)
    pairs(stroke.points).forEach((point, i) => {
      expect(stroke.pressure![i]).toBe(Math.fround(expected.get(Math.round(toClient(point)[0] * 1000))!))
    })
  })
})

describe('DrawController pending point', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is drawn first after the tip, outlives the prediction timeout and a time ahead of 0, and reaches the store at the end', () => {
    vi.useFakeTimers()
    const d = drawing({ width: 4 })
    const handle = {}
    registerDebugPrediction(handle, d.prediction)
    d.down({ x: 0, y: 0 })
    d.move([{ x: 1, y: 0 }])
    expect(d.prediction.get('s:1')).toEqual([project(1, 0)])
    d.move([{ x: 2, y: 0 }], [[3, 0]])
    expect(d.prediction.get('s:1')).toEqual([project(2, 0), project(3, 0)])
    vi.advanceTimersByTime(PREDICTION_TIMEOUT_MS)
    expect(d.prediction.get('s:1')).toEqual([project(2, 0)])
    d.move([{ x: 2.5, y: 0 }], [[3, 0]])
    setDebugPredictionMs(handle, 0)
    expect(d.prediction.get('s:1')).toEqual([project(2.5, 0)])
    d.move([{ x: 3, y: 0 }], [[3.5, 0]])
    expect(d.prediction.get('s:1')).toEqual([project(3, 0)])
    // Not in the store until the end
    expect(d.ops.filter((op) => op.type === 'points')).toHaveLength(1)
    expect(d.recorded()).toHaveLength(1)
    // Once a point is recorded there is none
    d.move([{ x: 4, y: 0 }])
    expect(d.prediction.get('s:1')).toBeUndefined()
    d.move([{ x: 5, y: 0 }])
    d.pointer('pointerup', { x: 5, y: 0 })
    expect(d.prediction.size).toBe(0)
    expect(d.recorded().map(([x]) => Math.round(x * 1000) / 1000)).toEqual([0, 4, 5])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is recorded before the end by pointerup, pointercancel and end()', () => {
    const finishes: [string, (d: ReturnType<typeof drawing>) => void][] = [
      ['pointerup', (d) => d.pointer('pointerup', { x: 1, y: 0 })],
      ['pointercancel', (d) => d.pointer('pointercancel', { x: 1, y: 0 })],
      ['end()', (d) => d.draw.end()],
    ]
    for (const [name, finish] of finishes) {
      const d = drawing({ width: 4 })
      d.down({ x: 0, y: 0 })
      d.move([{ x: 1, y: 0 }])
      finish(d)
      const last = d.ops.slice(-2)
      expect(
        last.map((op) => op.type),
        name,
      ).toEqual(['points', 'end'])
      expect(last[0].type === 'points' && last[0].pts, name).toEqual(xy([project(1, 0)]))
      expect(d.prediction.size, name).toBe(0)
    }
  })
})

describe('Prediction pending point', () => {
  it('comes before the predicted points, in a new array only when either changes', () => {
    const prediction = new Prediction(DEFAULT_PREDICTION_MS)
    let calls = 0
    prediction.subscribe(() => calls++)
    prediction.setPending('s:1', [1, 1])
    const first = prediction.get('s:1')
    expect(first).toEqual([[1, 1]])
    // The same point again changes nothing
    prediction.setPending('s:1', [1, 1])
    expect(prediction.get('s:1')).toBe(first)
    expect(calls).toBe(1)
    prediction.set('s:1', [[2, 2]])
    expect(prediction.get('s:1')).toEqual([
      [1, 1],
      [2, 2],
    ])
    prediction.clear()
    expect(prediction.get('s:1')).toEqual([[1, 1]])
    expect(prediction.size).toBe(1)
    prediction.setPending('s:1', null)
    expect(prediction.get('s:1')).toBeUndefined()
    expect(prediction.size).toBe(0)
    expect(calls).toBe(4)
  })
})

describe('DrawController thinning with lyon', () => {
  let tessellator: StrokeTessellator
  beforeAll(async () => {
    tessellator = await StrokeTessellator.load(
      readFileSync(join(import.meta.dirname, '..', 'tessellator/pkg/handwriting_tessellator_bg.wasm')),
    )
  })

  const vertices = (stroke: StrokeData): number => {
    const mesh = new MeshBuffer(bucketOf([stroke.points[0], stroke.points[1]], stroke.zoom))
    tessellator.appendStroke(mesh, stroke, stroke.zoom)
    return mesh.vertexCount
  }

  it('makes a slow wavy 300 px line with a 0.15 px tremor fewer than 1000 vertices', () => {
    const rand = seeded(3)
    const inputs = Array.from({ length: 1200 }, (_, i) => {
      const x = (i + 1) * 0.25
      return {
        x: x + (rand() * 2 - 1) * 0.15,
        y: 20 * Math.sin((2 * Math.PI * x) / 100) + (rand() * 2 - 1) * 0.15,
      }
    })
    const d = drawing({ width: 4 })
    drawPath(d, { x: 0, y: 0 }, inputs)
    expect(vertices(d.store.get('s:1')!)).toBeLessThan(1000)
    // Every input recorded, as before decision 0019, is many times that
    const raw = { ...d.store.get('s:1')!, points: xy([project(0, 0), ...inputs.map((p) => project(p.x, p.y))]) }
    expect(vertices(raw)).toBeGreaterThan(4000)
  })
})
