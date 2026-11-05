// Decisions 0023 to 0025: the store spills the points of the strokes nothing holds to a target (here one in memory),
// the scene holds the strokes of the buckets near the view, and ops that need spilled points wait for them
import { describe, expect, it, vi } from 'vitest'
import {
  attachSpill,
  detachSpill,
  MAX_SPILL_POINTS,
  spillStrokes,
  type SpillRecord,
  type SpillTarget,
} from '../src/core/spill'
import { StrokeStore, type Origin, type Point, type StrokeData, type StrokeOp } from '../src/core/stroke'
import { inverse, type Matrix } from '../src/core/transform'
import type { Bounds } from '../src/bounds'
import { mercatorPerPixelAt } from '../src/mercator'
import { exportGeoJSON } from '../src/selectionActions'
import { StrokeScene } from '../src/StrokeScene'
import { UndoHistory } from '../src/UndoHistory'
import { EraseController } from '../src/EraseController'
import { findStrokesNear } from '../src/hitTest'
import { strokesInLasso } from '../src/lasso'
import { Selection } from '../src/Selection'
import { StrokeIndex } from '../src/StrokeIndex'
import { DeferredBuilds, fakeWriter, pairs, xy } from './support'

const ZOOM = 12
const PX = mercatorPerPixelAt(ZOOM)
const HERE: Point = [0.5, 0.5]
const FAR: Point = [0.6, 0.5]

/**
 * A target in memory that does its calls one after the other, in the order they are made (as IndexedDB does), can
 * stop them until `resume`, and fail them
 */
class MemoryTarget implements SpillTarget {
  records = new Map<string, SpillRecord>()
  puts: string[][] = []
  putPoints: number[] = []
  gets: string[][] = []
  // Reads of these IDs wait until resumeSlow, and hold back the calls after them
  slow = new Set<string>()
  private slowGate: { promise: Promise<void>; resolve: () => void } | null = null
  deletes: string[][] = []
  clears = 0
  failPut = false
  failGet = new Set<string>()
  private paused: { promise: Promise<void>; resolve: () => void } | null = null
  private last: Promise<unknown> = Promise.resolve()

  pause(): void {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    this.paused = { promise, resolve }
  }

  resume(): void {
    this.paused?.resolve()
    this.paused = null
  }

  resumeSlow(): void {
    this.slow.clear()
    this.slowGate?.resolve()
    this.slowGate = null
  }

  /** Runs `work` after the calls made before, and after a pause in force now */
  private queue<T>(work: () => T): Promise<T> {
    const gate = this.paused?.promise
    const run = this.last.then(() => gate).then(work)
    this.last = run.catch(() => {})
    return run
  }

  put(records: SpillRecord[]): Promise<void> {
    this.puts.push(records.map((record) => record.id))
    this.putPoints.push(records.reduce((sum, record) => sum + record.points.length / 2, 0))
    // Copied when called, as IndexedDB's put does
    const copies = records.map(({ id, points, pressure }) => ({
      id,
      points: points.slice(),
      pressure: pressure?.slice(),
    }))
    return this.queue(() => {
      if (this.failPut) throw new Error('put failed')
      for (const copy of copies) {
        this.records.set(copy.id, copy.pressure ? copy : { id: copy.id, points: copy.points })
      }
    })
  }

  get(ids: string[]): Promise<Map<string, SpillRecord>> {
    this.gets.push(ids)
    if (ids.some((id) => this.slow.has(id))) {
      if (!this.slowGate) {
        let resolve!: () => void
        const promise = new Promise<void>((r) => (resolve = r))
        this.slowGate = { promise, resolve }
      }
      const gate = this.slowGate.promise
      const run = this.last.then(() => gate)
      this.last = run
    }
    return this.queue(() => {
      const found = new Map<string, SpillRecord>()
      for (const id of ids) {
        const record = this.records.get(id)
        if (record && !this.failGet.has(id)) found.set(id, record)
      }
      return found
    })
  }

  delete(ids: string[]): Promise<void> {
    this.deletes.push(ids)
    return this.queue(() => {
      for (const id of ids) this.records.delete(id)
    })
  }

  clear(): Promise<void> {
    this.clears++
    return this.queue(() => this.records.clear())
  }
}

/** Lets the promises under way settle */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A store with the memory target attached, a clock the test moves, and the errors reported */
function spilling(options: { order?: 'default' | 'custom' } = {}): {
  store: StrokeStore
  target: MemoryTarget
  errors: Error[]
  advance: (ms: number) => void
  tick: () => Promise<void>
} {
  const store = new StrokeStore({ order: options.order ?? 'custom' })
  const target = new MemoryTarget()
  const errors: Error[] = []
  let time = 0
  expect(attachSpill(store, { target, now: () => time, onError: (error) => errors.push(error) })).toBe(true)
  return {
    store,
    target,
    errors,
    advance: (ms) => (time += ms),
    tick: async () => {
      await spillStrokes(store)
      await settle()
    },
  }
}

/** A line of `n` points 1 px apart from `from` */
function line(id: string, from: Point, n = 3, extra: Partial<StrokeData> = {}): StrokeData {
  const points = xy(Array.from({ length: n }, (_, i): Point => [from[0] + i * PX, from[1]]))
  return { id, author: 'a', color: '#000000', width: 4, zoom: ZOOM, points, order: 1, ...extra }
}

/** The view of a 1000 × 700 px screen centered on `center` at ZOOM */
function viewAt([x, y]: Point): Bounds {
  return { minX: x - 500 * PX, maxX: x + 500 * PX, minY: y - 350 * PX, maxY: y + 350 * PX }
}

/** Spills every candidate: moves the clock past the delay and lets the store write */
async function spillAll(advance: (ms: number) => void, tick: () => Promise<void>): Promise<void> {
  advance(1000)
  await tick()
}

describe('spilling with the scene', () => {
  it('spills strokes loaded far from the view at startup, and keeps the near ones', async () => {
    const { store, target, advance, tick } = spilling()
    const scene = new StrokeScene(store, fakeWriter, new DeferredBuilds(), ZOOM)
    store.apply({ type: 'load', strokes: [line('near', HERE), line('far', FAR, 3, { order: 2 })] }, 'remote')
    scene.frame(viewAt(HERE), ZOOM)
    await spillAll(advance, tick)
    expect(store.get('far')!.points).toBeNull()
    expect(store.get('near')!.points).not.toBeNull()
    expect([...target.records.keys()]).toEqual(['far'])
    // Its extent stays, and the scene keeps it in its bucket
    expect(store.extent('far')).toEqual({ minX: FAR[0], minY: 0.5, maxX: FAR[0] + 2 * PX, maxY: 0.5, start: FAR })
    expect(scene.inspect().strokeBuckets.has('far')).toBe(true)
  })

  it('waits a second after a stroke stops being held before it spills it', async () => {
    const { store, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('a', FAR)] }, 'remote')
    advance(999)
    await tick()
    expect(store.get('a')!.points).not.toBeNull()
    advance(1)
    await tick()
    expect(store.get('a')!.points).toBeNull()
  })

  it('never spills a stroke loaded later into a bucket it holds', async () => {
    const { store, advance, tick } = spilling()
    const scene = new StrokeScene(store, fakeWriter, new DeferredBuilds(), ZOOM)
    store.apply({ type: 'load', strokes: [line('first', HERE)] }, 'remote')
    scene.frame(viewAt(HERE), ZOOM)
    store.apply({ type: 'load', strokes: [line('later', [HERE[0] + 10 * PX, HERE[1]], 3, { order: 2 })] }, 'remote')
    expect(scene.inspect().strokeBuckets.get('later')).toBe(scene.inspect().strokeBuckets.get('first'))
    await spillAll(advance, tick)
    await spillAll(advance, tick)
    expect(store.get('later')!.points).not.toBeNull()
  })

  it('drops the points of a far bucket and brings them back, then builds it, when the view comes near', async () => {
    const { store, advance, tick } = spilling()
    const builds = new DeferredBuilds()
    const scene = new StrokeScene(store, fakeWriter, builds, ZOOM)
    const stroke = line('a', HERE, 5)
    const points = stroke.points!.slice()
    store.apply({ type: 'load', strokes: [stroke] }, 'remote')
    scene.frame(viewAt(HERE), ZOOM)
    scene.onBuilt(builds.deliver())
    // Four screens away: let go of
    scene.frame(viewAt([HERE[0] + 4 * 1000 * PX, HERE[1]]), ZOOM)
    await spillAll(advance, tick)
    expect(store.get('a')!.points).toBeNull()
    // Back: held, read back, and built once the points are here
    scene.frame(viewAt(HERE), ZOOM)
    expect(builds.pending).toHaveLength(0)
    await settle()
    expect(store.get('a')!.points).toEqual(points)
    scene.frame(viewAt(HERE), ZOOM)
    expect(builds.pending.map((job) => job.strokes.map((s) => s.id))).toEqual([['a']])
    // Held again: it stays
    await spillAll(advance, tick)
    expect(store.get('a')!.points).not.toBeNull()
  })

  it('keeps the strokes of a bucket between two and three screens away as they were', async () => {
    const { store, advance, tick } = spilling()
    const scene = new StrokeScene(store, fakeWriter, new DeferredBuilds(), ZOOM)
    store.apply({ type: 'load', strokes: [line('a', HERE)] }, 'remote')
    scene.frame(viewAt(HERE), ZOOM)
    // 2.6 screens to the side: past the two that hold, within the three that keep
    scene.frame(viewAt([HERE[0] + 2.6 * 1000 * PX, HERE[1]]), ZOOM)
    await spillAll(advance, tick)
    expect(store.get('a')!.points).not.toBeNull()
  })

  it('lets go of a stroke that leaves a held bucket, and of everything it holds when destroyed', async () => {
    const { store, advance, tick } = spilling()
    const scene = new StrokeScene(store, fakeWriter, new DeferredBuilds(), ZOOM)
    store.apply({ type: 'load', strokes: [line('a', HERE), line('b', HERE, 3, { order: 2 })] }, 'remote')
    scene.frame(viewAt(HERE), ZOOM)
    // Moved far into a bucket the scene does not hold
    expect(store.apply({ type: 'transform', ids: ['a'], matrix: [1, 0, 0, 1, 0.1, 0] }, 'remote')).toBe(true)
    await spillAll(advance, tick)
    expect(store.get('a')!.points).toBeNull()
    expect(store.get('b')!.points).not.toBeNull()
    scene.destroy()
    await spillAll(advance, tick)
    expect(store.get('b')!.points).toBeNull()
  })

  it('spills neither a stroke being drawn nor one without an order', async () => {
    const { store, advance, tick } = spilling()
    store.apply({ type: 'begin', id: 'd', author: 'a', color: '#000000', width: 4, zoom: ZOOM }, 'local')
    store.apply({ type: 'points', id: 'd', pts: xy([FAR, [FAR[0] + PX, FAR[1]]]) }, 'local')
    store.apply({ type: 'load', strokes: [line('n', FAR, 3, { order: undefined })] }, 'remote')
    await spillAll(advance, tick)
    expect(store.get('d')!.points).not.toBeNull()
    expect(store.get('n')!.points).not.toBeNull()
    // Ended, it still has no order (custom mode); once it has one it spills
    store.apply({ type: 'end', id: 'd' }, 'local')
    await spillAll(advance, tick)
    expect(store.get('d')!.points).not.toBeNull()
    store.apply({ type: 'order', id: 'd', order: 5 }, 'remote')
    store.apply({ type: 'order', id: 'n', order: 6 }, 'remote')
    await spillAll(advance, tick)
    expect(store.get('d')!.points).toBeNull()
    expect(store.get('n')!.points).toBeNull()
  })

  it('does not spill a store made with spill: false', () => {
    const store = new StrokeStore({ spill: false })
    expect(attachSpill(store, { target: new MemoryTarget(), now: () => 0, onError: () => {} })).toBe(false)
  })
})

describe('writes and reads', () => {
  it('writes at most 2^17 points at once, and the rest on the next tick, and never a longer stroke', async () => {
    const { store, target, advance, tick } = spilling()
    const n = 50_000
    const long = line('long', [0.05, 0.5], MAX_SPILL_POINTS + 1)
    const strokes = ['a', 'b', 'c'].map((id, k) => line(id, [0.1 + k * 0.1, 0.5], n, { order: k + 2 }))
    store.apply({ type: 'load', strokes: [long, ...strokes] }, 'remote')
    await spillAll(advance, tick)
    expect(target.puts).toEqual([['a', 'b']])
    await tick()
    await spillAll(advance, tick)
    expect(target.puts).toEqual([['a', 'b'], ['c']])
    for (const points of target.putPoints) expect(points).toBeLessThanOrEqual(MAX_SPILL_POINTS)
    expect(store.get('long')!.points).toEqual(long.points)
    expect(strokes.every(({ id }) => store.get(id)!.points === null)).toBe(true)
  })

  it('does not write again a stroke read back unchanged, and writes it again once changed', async () => {
    const { store, target, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('a', FAR)] }, 'remote')
    await spillAll(advance, tick)
    await store.hold(['a'])
    store.release(['a'])
    await spillAll(advance, tick)
    expect(store.get('a')!.points).toBeNull()
    expect(target.puts).toEqual([['a']])
    // A transform reads it back, moves it, and the record is no longer its points
    store.apply({ type: 'transform', ids: ['a'], matrix: [1, 0, 0, 1, 0.01, 0] }, 'remote')
    await settle()
    await spillAll(advance, tick)
    expect(target.puts).toEqual([['a'], ['a']])
    expect(target.records.get('a')!.points[0]).toBeCloseTo(FAR[0] + 0.01, 12)
  })

  it('keeps the points of a stroke held while it is written, and spills it later without writing', async () => {
    const { store, target, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('a', FAR)] }, 'remote')
    advance(1000)
    target.pause()
    const writing = spillStrokes(store)
    void store.hold(['a'])
    target.resume()
    await writing
    expect(store.get('a')!.points).not.toBeNull()
    store.release(['a'])
    await spillAll(advance, tick)
    expect(store.get('a')!.points).toBeNull()
    expect(target.puts).toEqual([['a']])
  })

  for (const [name, change] of [
    [
      'a remove and a load of the same ID',
      (store: StrokeStore, stroke: StrokeData) => {
        store.apply({ type: 'remove', id: 'a' }, 'remote')
        store.apply({ type: 'load', strokes: [stroke] }, 'remote')
      },
    ],
    [
      'a reset with the same ID',
      (store: StrokeStore, stroke: StrokeData) => {
        store.apply({ type: 'reset', strokes: [stroke] }, 'remote')
      },
    ],
  ] as const) {
    it(`leaves a new stroke as it is after ${name} while its old points are written`, async () => {
      const { store, target, advance } = spilling()
      store.apply({ type: 'load', strokes: [line('a', FAR)] }, 'remote')
      advance(1000)
      target.pause()
      const writing = spillStrokes(store)
      const fresh = line('a', [0.7, 0.5], 4)
      change(store, fresh)
      target.resume()
      await writing
      expect(store.get('a')!.points).toEqual(fresh.points)
    })

    it(`leaves a new stroke as it is after ${name} while its old points are read back`, async () => {
      const { store, target, advance, tick } = spilling()
      store.apply({ type: 'load', strokes: [line('a', FAR)] }, 'remote')
      await spillAll(advance, tick)
      target.pause()
      const reading = store.hold(['a'])
      const fresh = line('a', [0.7, 0.5], 4)
      change(store, fresh)
      target.resume()
      await reading
      await settle()
      expect(store.get('a')!.points).toEqual(fresh.points)
    })
  }

  it('deletes the record of a stroke removed while it is written', async () => {
    const { store, target, advance } = spilling()
    store.apply({ type: 'load', strokes: [line('a', FAR)] }, 'remote')
    advance(1000)
    target.pause()
    const writing = spillStrokes(store)
    store.apply({ type: 'remove', id: 'a' }, 'remote')
    target.resume()
    await writing
    await settle()
    expect(target.deletes).toEqual([['a']])
    expect(target.records.size).toBe(0)
  })

  it('resolves hold and Export when a read fails, builds the rest, and reports it', async () => {
    const { store, target, errors, advance, tick } = spilling()
    const builds = new DeferredBuilds()
    const scene = new StrokeScene(store, fakeWriter, builds, ZOOM)
    store.apply({ type: 'load', strokes: [line('a', FAR), line('b', FAR, 3, { order: 2 })] }, 'remote')
    scene.frame(viewAt(HERE), ZOOM)
    await spillAll(advance, tick)
    target.failGet.add('b')
    const geojson = JSON.parse(await exportGeoJSON(store, ['a', 'b'])) as { features: { properties: { id: string } }[] }
    expect(geojson.features.map((feature) => feature.properties.id)).toEqual(['a'])
    expect(errors).toHaveLength(1)
    expect(store.get('b')!.points).toBeNull()
    scene.frame(viewAt(FAR), ZOOM)
    await settle()
    scene.frame(viewAt(FAR), ZOOM)
    expect(builds.pending.map((job) => job.strokes.map((s) => s.id))).toEqual([['a']])
    await expect(store.hold(['b'])).resolves.toBeUndefined()
  })

  it('stops spilling and reads every point back when a write fails', async () => {
    const { store, target, errors, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('a', FAR)] }, 'remote')
    await spillAll(advance, tick)
    expect(store.get('a')!.points).toBeNull()
    target.failPut = true
    store.apply({ type: 'load', strokes: [line('b', FAR, 3, { order: 2 })] }, 'remote')
    await spillAll(advance, tick)
    await settle()
    expect(errors.map((error) => error.message)).toEqual(['put failed'])
    expect(store.get('a')!.points).not.toBeNull()
    expect(store.get('b')!.points).not.toBeNull()
    await spillAll(advance, tick)
    expect(target.puts).toHaveLength(2)
  })

  it('reads every point back and deletes the records when detached', async () => {
    const { store, target, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('a', FAR), line('b', FAR, 3, { order: 2 })] }, 'remote')
    await spillAll(advance, tick)
    await detachSpill(store)
    expect(store.get('a')!.points).not.toBeNull()
    expect(store.get('b')!.points).not.toBeNull()
    expect(target.records.size).toBe(0)
    await spillAll(advance, tick)
    expect(store.get('a')!.points).not.toBeNull()
  })

  it('deletes the record of a stroke removed or split, and every record on a reset', async () => {
    const { store, target, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('a', FAR), line('b', FAR, 3, { order: 2 })] }, 'remote')
    await spillAll(advance, tick)
    store.apply({ type: 'remove', id: 'a' }, 'remote')
    await settle()
    expect([...target.records.keys()]).toEqual(['b'])
    store.apply({ type: 'reset', strokes: [] }, 'remote')
    await settle()
    expect(target.clears).toBe(1)
    expect(target.records.size).toBe(0)
  })
})

/** The IDs an op names */
function touched(op: StrokeOp): string[] {
  switch (op.type) {
    case 'transform':
      return op.ids
    case 'replace':
    case 'load':
    case 'reset':
      return op.strokes.map((stroke) => stroke.id)
    case 'restore':
      return [op.stroke.id]
    case 'split':
      return [op.id, ...op.pieces.map((piece) => piece.id)]
    default:
      return [op.id]
  }
}

/** Records what a store's subscribers get */
function recorded(store: StrokeStore): [StrokeOp, Origin][] {
  const ops: [StrokeOp, Origin][] = []
  store.subscribe((op, origin) => ops.push([op, origin]))
  return ops
}

describe('ops on spilled strokes', () => {
  const pen = (id: string, from: Point, order: number): StrokeData => ({
    ...line(id, from, 4, { order }),
    pressure: Float32Array.of(0.25, 0.5, 0.75, 1),
  })

  it('apply transform, split and replace once the points are back, in the order they came, as another store does', async () => {
    const { store, target, advance, tick } = spilling()
    const other = new StrokeStore({ order: 'custom' })
    const strokes = [pen('a', FAR, 1), pen('b', [0.6, 0.6], 2)]
    store.apply({ type: 'load', strokes }, 'remote')
    other.apply({ type: 'load', strokes }, 'remote')
    await spillAll(advance, tick)
    expect(store.get('a')!.points).toBeNull()
    const seen = recorded(store)
    target.pause()
    const ops: StrokeOp[] = [
      { type: 'transform', ids: ['a', 'b'], matrix: [1, 0, 0, 1, 0.01, 0] },
      {
        type: 'split',
        id: 'a',
        pieces: [
          { id: 'a1', from: 0, to: 1.5 },
          { id: 'a2', from: 2, to: 3 },
        ],
      },
      { type: 'transform', ids: ['a2'], matrix: [1, 0, 0, 1, 0, 0.01] },
      {
        type: 'replace',
        strokes: [
          {
            ...other.get('b')!,
            points: xy([
              [0.4, 0.4],
              [0.41, 0.4],
              [0.42, 0.4],
              [0.43, 0.4],
            ]),
          },
        ],
      },
      { type: 'order', id: 'a1', order: 9 },
    ]
    for (const op of ops) {
      expect(store.apply(op, 'remote')).toBe(true)
      other.apply(op, 'remote')
    }
    expect(seen).toEqual([])
    target.resume()
    await settle()
    // Each stroke waits alone (decision 0026): a's ops, read back first, in the order they came, then b's
    expect(seen.map(([op]) => [op.type, ...touched(op)])).toEqual([
      ['transform', 'a'],
      ['split', 'a', 'a1', 'a2'],
      ['transform', 'a2'],
      ['order', 'a1'],
      ['transform', 'b'],
      ['replace', 'b'],
    ])
    for (const id of ['a1', 'a2', 'b']) {
      expect(store.get(id)!.points).toEqual(other.get(id)!.points)
      expect(store.get(id)!.pressure).toEqual(other.get(id)!.pressure)
      expect(store.get(id)!.order).toBe(other.get(id)!.order)
    }
    expect(store.get('a')).toBeUndefined()
  })

  it('applies the part of a transform on a stroke in memory at once, so its undo is one step', async () => {
    const { store, target, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('a', HERE), line('b', FAR, 3, { order: 2 })] }, 'remote')
    const history = new UndoHistory(store, 10)
    const mine: Matrix = [1, 0, 0, 1, 0.001, 0]
    store.apply({ type: 'transform', ids: ['a'], matrix: mine }, 'local')
    history.record({ type: 'transform', ids: ['a'], matrix: mine })
    await spillAll(advance, tick)
    expect(store.get('a')!.points).not.toBeNull()
    expect(store.get('b')!.points).toBeNull()
    target.pause()
    const theirs: Matrix = [1, 0, 0, 1, 0, 0.001]
    const seen = recorded(store)
    expect(store.apply({ type: 'transform', ids: ['a', 'b'], matrix: theirs }, 'remote')).toBe(true)
    expect(seen.map(([op]) => op.type === 'transform' && op.ids)).toEqual([['a']])
    const before = pairs(store.get('a')!.points)
    history.undo()
    expect(history.canRedo).toBe(true)
    expect(history.canUndo).toBe(false)
    const back = pairs(store.get('a')!.points)
    back.forEach((p, i) => expect(p[0]).toBeCloseTo(before[i][0] + inverse(mine)[4], 12))
    target.resume()
    await settle()
    expect(seen.map(([op]) => op.type === 'transform' && op.ids)).toEqual([['a'], ['a'], ['b']])
  })

  it('applies a remove and an order to a spilled stroke without reading it back', async () => {
    const { store, target, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('a', FAR), line('b', FAR, 3, { order: 2 })] }, 'remote')
    await spillAll(advance, tick)
    const seen = recorded(store)
    expect(store.apply({ type: 'remove', id: 'a' }, 'remote')).toBe(true)
    expect(store.apply({ type: 'order', id: 'b', order: 7 }, 'remote')).toBe(true)
    expect(seen.map(([op]) => op.type)).toEqual(['remove', 'order'])
    expect(target.gets).toEqual([])
    expect(store.get('b')).toMatchObject({ order: 7, points: null })
  })

  it('drops the ops waiting on a reset', async () => {
    const { store, target, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('a', FAR)] }, 'remote')
    await spillAll(advance, tick)
    target.pause()
    store.apply({ type: 'transform', ids: ['a'], matrix: [1, 0, 0, 1, 0.01, 0] }, 'remote')
    const seen = recorded(store)
    store.apply({ type: 'reset', strokes: [line('a', HERE)] }, 'remote')
    target.resume()
    await settle()
    expect(seen.map(([op]) => op.type)).toEqual(['reset'])
    expect(pairs(store.get('a')!.points)[0]).toEqual(HERE)
  })

  it('gives read the strokes with their points back', async () => {
    const { store, advance, tick } = spilling()
    const stroke = pen('a', FAR, 1)
    store.apply({ type: 'load', strokes: [stroke] }, 'remote')
    await spillAll(advance, tick)
    const [a] = await store.read(['a', 'missing'])
    expect(a.points).toEqual(stroke.points)
    expect(a.pressure).toEqual(stroke.pressure)
    expect(a).toBe(store.get('a'))
  })

  it('does not take a stroke whose points are spilled into a load, a restore or a points op', async () => {
    const { store, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('a', FAR)] }, 'remote')
    await spillAll(advance, tick)
    const spilled = { ...store.get('a')!, id: 'copy' }
    expect(store.apply({ type: 'load', strokes: [spilled] }, 'remote')).toBe(false)
    expect(store.apply({ type: 'restore', stroke: spilled }, 'remote')).toBe(false)
  })
})

describe('what holds strokes', () => {
  it('keeps the points of the selected strokes and of the strokes the undo history refers to', async () => {
    const { store, advance, tick } = spilling()
    store.apply(
      { type: 'load', strokes: [line('s', FAR), line('h', FAR, 3, { order: 2 }), line('x', FAR, 3, { order: 3 })] },
      'remote',
    )
    const selection = new Selection(store)
    selection.set(['s'])
    const history = new UndoHistory(store, 1)
    history.record({ type: 'transform', ids: ['h'], matrix: [1, 0, 0, 1, 0, 0] })
    await spillAll(advance, tick)
    expect(store.get('s')!.points).not.toBeNull()
    expect(store.get('h')!.points).not.toBeNull()
    expect(store.get('x')!.points).toBeNull()
    // The selection let go of, and the action pushed out of the history (limit 1) by another
    selection.set([])
    history.record({ type: 'transform', ids: ['x'], matrix: [1, 0, 0, 1, 0, 0] })
    await spillAll(advance, tick)
    expect(store.get('s')!.points).toBeNull()
    expect(store.get('h')!.points).toBeNull()
    history.clear()
    await settle()
    await spillAll(advance, tick)
    expect(store.get('x')!.points).toBeNull()
  })

  it('holds a stroke being cut until the gesture ends', async () => {
    const { store, advance, tick } = spilling()
    const stroke = line('a', HERE, 101)
    store.apply({ type: 'load', strokes: [stroke] }, 'remote')
    const element = Object.assign(new EventTarget(), { setPointerCapture: (): void => {} }) as unknown as HTMLElement
    let next = 0
    const erase = new EraseController(
      element,
      store,
      (x, y) => [HERE[0] + x * PX, HERE[1] + y * PX],
      new StrokeIndex(store),
      {
        isEnabled: () => true,
        radius: () => 2,
        pixelSize: () => PX,
        mode: () => 'partial',
        newPieceId: () => `p:${++next}`,
        onErase: () => {},
        onCut: () => {},
      },
    )
    erase.enable()
    const pointer = (type: string, x: number, y: number): void =>
      void element.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, button: 0, clientX: x, clientY: y }))
    const hold = vi.spyOn(store, 'hold')
    const release = vi.spyOn(store, 'release')
    pointer('pointerdown', 50, -10)
    pointer('pointermove', 50, 10)
    expect(hold.mock.calls).toEqual([[['a']]])
    expect(release).not.toHaveBeenCalled()
    pointer('pointerup', 50, 10)
    expect(release.mock.calls.map(([ids]) => [...ids])).toEqual([['a']])
    // Its pieces are not held: they spill
    await spillAll(advance, tick)
    expect([...store.values()].map((piece) => piece.points)).toEqual([null, null])
  })

  it('leaves strokes whose points are spilled out of hit tests and the lasso', async () => {
    const { store, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('a', HERE)] }, 'remote')
    const index = new StrokeIndex(store)
    await spillAll(advance, tick)
    expect(store.get('a')!.points).toBeNull()
    expect(findStrokesNear(index, store, HERE, () => 2 * PX, 2 * PX)).toEqual([])
    const around: Point[] = [
      [HERE[0] - PX, HERE[1] - PX],
      [HERE[0] + 3 * PX, HERE[1] - PX],
      [HERE[0] + 3 * PX, HERE[1] + PX],
      [HERE[0] - PX, HERE[1] + PX],
    ]
    expect(strokesInLasso(index, store, around)).toEqual([])
    await store.hold(['a'])
    expect(findStrokesNear(index, store, HERE, () => 2 * PX, 2 * PX)).toEqual(['a'])
    expect(strokesInLasso(index, store, around)).toEqual(['a'])
  })
})

describe('waiting per stroke (decision 0026)', () => {
  it('applies a local split on a stroke in memory at once while another stroke of a load waits', async () => {
    const { store, target, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('R', FAR)] }, 'remote')
    await spillAll(advance, tick)
    target.pause()
    void store.hold(['R'])
    const S = line('S', HERE, 101, { order: 2 })
    store.apply({ type: 'load', strokes: [S] }, 'remote')
    expect(store.apply({ type: 'load', strokes: [S, line('R', FAR)] }, 'remote')).toBe(true)
    // The partial eraser cuts S and records the cut; the selection moves a piece and the move is undone
    const history = new UndoHistory(store, 10)
    const element = Object.assign(new EventTarget(), { setPointerCapture: (): void => {} }) as unknown as HTMLElement
    let next = 0
    const erase = new EraseController(
      element,
      store,
      (x, y) => [HERE[0] + x * PX, HERE[1] + y * PX],
      new StrokeIndex(store),
      {
        isEnabled: () => true,
        radius: () => 2,
        pixelSize: () => PX,
        mode: () => 'partial',
        newPieceId: () => `p:${++next}`,
        onErase: () => {},
        onCut: (cuts) => history.record({ type: 'split', cuts }),
      },
    )
    erase.enable()
    const pointer = (type: string, x: number, y: number): void =>
      void element.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, button: 0, clientX: x, clientY: y }))
    pointer('pointerdown', 50, -10)
    pointer('pointermove', 50, 10)
    expect(() => pointer('pointerup', 50, 10)).not.toThrow()
    expect(store.get('S')).toBeUndefined()
    expect(store.get('p:1')).toBeDefined()
    const selection = new Selection(store)
    selection.set(['p:1'])
    const matrix: Matrix = [1, 0, 0, 1, 10 * PX, 0]
    expect(store.apply({ type: 'transform', ids: ['p:1'], matrix }, 'local')).toBe(true)
    history.record({ type: 'transform', ids: ['p:1'], matrix })
    history.undo()
    expect(history.canRedo).toBe(true)
    expect(pairs(store.get('p:1')!.points)[0][0]).toBeCloseTo(HERE[0], 12)
    target.resume()
    await settle()
  })

  it('applies a local split on the first of two strokes read back for one transform at once', async () => {
    const { store, target, advance, tick } = spilling()
    store.apply({ type: 'load', strokes: [line('R1', FAR), line('R2', [0.7, 0.5], 3, { order: 2 })] }, 'remote')
    await spillAll(advance, tick)
    target.slow.add('R2')
    expect(store.apply({ type: 'transform', ids: ['R1', 'R2'], matrix: [1, 0, 0, 1, 0.01, 0] }, 'remote')).toBe(true)
    await settle()
    expect(store.get('R1')!.points).not.toBeNull()
    expect(store.get('R2')!.points).toBeNull()
    expect(store.apply({ type: 'split', id: 'R1', pieces: [{ id: 'q', from: 0, to: 1 }] }, 'local')).toBe(true)
    expect(store.get('q')).toBeDefined()
    target.resumeSlow()
    await settle()
    expect(store.get('R2')!.points![0]).toBeCloseTo(0.71, 12)
  })

  it('gives a stroke of a load that waits the order it takes when the load comes, in the default mode', async () => {
    const { store, target, advance, tick } = spilling({ order: 'default' })
    store.apply({ type: 'load', strokes: [line('R', FAR)] }, 'remote')
    await spillAll(advance, tick)
    target.pause()
    // R waits to be read back for the transform, the remove waits behind it, and so does the load of a new R
    store.apply({ type: 'transform', ids: ['R'], matrix: [1, 0, 0, 1, 0.01, 0] }, 'remote')
    store.apply({ type: 'remove', id: 'R' }, 'remote')
    expect(store.apply({ type: 'load', strokes: [line('R', HERE), line('A', HERE)] }, 'remote')).toBe(true)
    target.resume()
    await settle()
    expect(pairs(store.get('R')!.points)[0]).toEqual(HERE)
    expect(store.get('R')!.order!).toBeLessThan(store.get('A')!.order!)
  })

  for (const [name, op] of [
    ['a replace with the same points', (a: StrokeData): StrokeOp => ({ type: 'replace', strokes: [a] })],
    ['a replace of another length', (a: StrokeData): StrokeOp => ({ type: 'replace', strokes: [line('a', FAR, 5)] })],
    [
      'a transform that would leave the map',
      (): StrokeOp => ({ type: 'transform', ids: ['a'], matrix: [1, 0, 0, 1, 1, 0] }),
    ],
  ] as const) {
    it(`spills a far stroke again after ${name} changed nothing`, async () => {
      const { store, target, advance, tick } = spilling()
      const a = line('a', FAR)
      store.apply({ type: 'load', strokes: [a] }, 'remote')
      await spillAll(advance, tick)
      expect(store.apply(op(a), 'remote')).toBe(true)
      await settle()
      expect(store.get('a')!.points).not.toBeNull()
      await spillAll(advance, tick)
      await spillAll(advance, tick)
      expect(store.get('a')!.points).toBeNull()
      // The record still holds its points
      expect(target.puts).toEqual([['a']])
    })
  }
})

describe('the strokes of a reset, and the strokes being drawn (decision 0026)', () => {
  it('files a reset stroke in its bucket, spills it far away, and draws it as being drawn on its next points', async () => {
    const { store, advance, tick } = spilling()
    const scene = new StrokeScene(store, fakeWriter, new DeferredBuilds(), ZOOM)
    store.apply({ type: 'reset', strokes: [line('r', FAR)] }, 'remote')
    expect(scene.inspect().strokeBuckets.has('r')).toBe(true)
    expect(scene.inspect().active.has('r')).toBe(false)
    scene.frame(viewAt(HERE), ZOOM)
    await spillAll(advance, tick)
    expect(store.get('r')!.points).toBeNull()
    expect(store.apply({ type: 'points', id: 'r', pts: xy([[FAR[0] + 3 * PX, FAR[1]]]) }, 'remote')).toBe(true)
    await settle()
    expect(store.get('r')!.points).toHaveLength(2 * 4)
    expect(scene.inspect().active.has('r')).toBe(true)
    expect(scene.inspect().strokeBuckets.has('r')).toBe(false)
    scene.frame(viewAt(FAR), ZOOM)
    expect(scene.inspect().active.get('r')).not.toBeNull()
  })

  it('does not hold a stroke being drawn in the scene', () => {
    const { store } = spilling()
    new StrokeScene(store, fakeWriter, new DeferredBuilds(), ZOOM)
    const hold = vi.spyOn(store, 'hold')
    store.apply({ type: 'begin', id: 'd', author: 'a', color: '#000000', width: 4, zoom: ZOOM }, 'local')
    store.apply({ type: 'points', id: 'd', pts: xy([FAR]) }, 'local')
    expect(hold).not.toHaveBeenCalled()
  })
})
