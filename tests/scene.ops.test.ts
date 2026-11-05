// Random op sequences against StrokeScene: drawing opaque and translucent strokes, erasing, cutting (partial eraser), undo (restore), saving out of order,
// tile loads, reconnect snapshots, zooming and panning, and worker builds that arrive late or out of order.
// The invariants in ./invariants are checked after every step. A failure prints the seed and step to replay
import { describe, expect, it, vi } from 'vitest'
import { StrokeStore, type Point, type StrokeData, type StrokeOrderMode } from '../src/core/stroke'
import type { Bounds } from '../src/bounds'
import { grow, intersects } from '../src/bounds'
import { mercatorPerPixelAt } from '../src/mercator'
import { MeshBuffer } from '../src/MeshBuffer'
import { StrokeScene } from '../src/StrokeScene'
import { RETESSELLATE_ZOOMS } from '../src/StrokeTessellator'
import { expectConsistentScene, expectValidDraws } from './invariants'
import { DeferredBuilds, fakeWriter, pairs, random, xy } from './support'

// More seeds for a longer search: SCENE_SEEDS=1000 npm test
const SEEDS = Number(process.env.SCENE_SEEDS ?? 40)
const STEPS = 300
// Screen size in CSS px
const SCREEN = { width: 1000, height: 700 }

/**
 * custom: the test plays the server, giving ended strokes their order late and out of order. default: the store
 * gives each ended stroke the next order at once, and numbers loaded and reset strokes anew (decision 0091)
 */
function run(seed: number, mode: StrokeOrderMode): void {
  const rand = random(seed)
  const pick = <T>(items: T[]): T | undefined => items[Math.floor(rand() * items.length)]
  const store = new StrokeStore({ order: mode })
  const builds = new DeferredBuilds()
  let zoom = 12
  let center: Point = [0.8892, 0.3672]
  const scene = new StrokeScene(store, fakeWriter, builds, zoom)

  // What the test knows independently of the scene
  const drawing = new Set<string>()
  const unsaved: string[] = []
  const erased: StrokeData[] = []
  let nextOrder = 1
  let nextId = 0

  const view = (): Bounds => {
    const px = mercatorPerPixelAt(zoom)
    const [x, y] = center
    return {
      minX: x - (SCREEN.width / 2) * px,
      maxX: x + (SCREEN.width / 2) * px,
      minY: y - (SCREEN.height / 2) * px,
      maxY: y + (SCREEN.height / 2) * px,
    }
  }
  /** A point on screen, `spread` screens around the center */
  const pointNear = ([x, y]: Point, spread: number): Point => {
    const px = mercatorPerPixelAt(zoom)
    const clamp = (v: number) => Math.min(1, Math.max(0, v))
    return [
      clamp(x + (rand() - 0.5) * SCREEN.width * px * spread),
      clamp(y + (rand() - 0.5) * SCREEN.height * px * spread),
    ]
  }
  // Opaque or translucent: the two are drawn apart
  const color = (): string => (rand() < 0.4 ? '#33669980' : '#336699')
  const savedStroke = (): StrokeData => {
    const drawnAt = 2 + rand() * 18
    const first = pointNear(center, 2)
    const points: Point[] = [first]
    const n = Math.floor(rand() * 6)
    for (let i = 0; i < n; i++) points.push(pointNear(points.at(-1)!, 0.05 * 2 ** (zoom - drawnAt)))
    return {
      id: `saved:${nextId++}`,
      author: 'other',
      color: color(),
      width: 2 + rand() * 20,
      zoom: drawnAt,
      points: xy(points),
      order: nextOrder++,
    }
  }

  const steps: [weight: number, name: string, run: () => void][] = [
    [
      6,
      'begin',
      () => {
        const id = `s:${nextId++}`
        store.apply(
          { type: 'begin', id, author: 'me', color: color(), width: 8, zoom },
          rand() < 0.5 ? 'local' : 'remote',
        )
        store.apply({ type: 'points', id, pts: xy([pointNear(center, 1)]) }, 'local')
        drawing.add(id)
      },
    ],
    [
      12,
      'points',
      () => {
        const id = pick([...drawing])
        if (!id) return
        const last = pairs(store.get(id)!.points).at(-1)!
        const pts = Array.from({ length: 1 + Math.floor(rand() * 40) }, () => pointNear(last, 0.1))
        store.apply({ type: 'points', id, pts: xy(pts) }, 'local')
      },
    ],
    [
      5,
      'end',
      () => {
        const id = pick([...drawing])
        if (!id) return
        store.apply({ type: 'end', id }, 'local')
        drawing.delete(id)
        if (mode === 'custom') unsaved.push(id)
        else expect(store.get(id)?.order).toBeDefined()
      },
    ],
    [
      5,
      'order',
      () => {
        // The server's order need not match the order the ends arrived in
        const at = Math.floor(rand() * unsaved.length)
        const [id] = unsaved.splice(at, 1)
        if (id) store.apply({ type: 'order', id, order: nextOrder++ }, 'remote')
      },
    ],
    [
      4,
      'remove',
      () => {
        const stroke = pick([...store.values()])
        if (!stroke) return
        store.apply({ type: 'remove', id: stroke.id }, 'local')
        if (drawing.delete(stroke.id)) return
        if (stroke.order !== undefined) erased.push(structuredClone(stroke))
      },
    ],
    [
      3,
      'split',
      () => {
        // The partial eraser: a saved stroke, possibly just drawn here, is cut into one or two pieces
        const stroke = pick([...store.values()].filter((s) => s.order !== undefined && s.points.length / 2 >= 2))
        if (!stroke) return
        const last = stroke.points.length / 2 - 1
        const cut = rand() * last
        const pieces = [
          { id: `piece:${nextId++}`, from: 0, to: cut },
          { id: `piece:${nextId++}`, from: cut + rand() * (last - cut), to: last },
        ].filter((piece) => piece.to > piece.from)
        if (pieces.length === 0) return
        const original = structuredClone(stroke)
        if (!store.apply({ type: 'split', id: stroke.id, pieces }, rand() < 0.5 ? 'local' : 'remote')) return
        // A default store's reset gives strokes still being drawn an order, so they can be cut too
        if (!drawing.delete(stroke.id)) erased.push(original)
      },
    ],
    [
      2,
      'restore',
      () => {
        const stroke = erased.pop()
        if (stroke) store.apply({ type: 'restore', stroke }, 'remote')
      },
    ],
    [
      3,
      'load',
      () => {
        const strokes = Array.from({ length: 1 + Math.floor(rand() * 6) }, savedStroke)
        // Tiles overlap, so loads repeat strokes the store already has
        const known = pick([...store.values()].filter((stroke) => stroke.order !== undefined))
        if (known) strokes.push(structuredClone(known))
        store.apply({ type: 'load', strokes }, 'remote')
      },
    ],
    [
      1,
      'reset',
      () => {
        // A reconnect: the snapshot holds the strokes still being drawn. A default store gives them orders at once
        const drafts = [...drawing].map((id) => structuredClone(store.get(id)!))
        store.apply({ type: 'reset', strokes: drafts }, 'remote')
        unsaved.length = 0
      },
    ],
    [
      4,
      'move',
      () => {
        zoom = Math.min(20, Math.max(2, zoom + (rand() - 0.5) * 8))
        center = pointNear(center, 3)
      },
    ],
    [
      6,
      'deliver',
      () => {
        if (builds.pending.length > 0) scene.onBuilt(builds.deliver(Math.floor(rand() * builds.pending.length)))
      },
    ],
    [
      8,
      'frame',
      () => {
        const draws = scene.frame(view(), zoom)
        expectValidDraws(store, scene, draws, view(), zoom)
      },
    ],
  ]
  const total = steps.reduce((sum, [weight]) => sum + weight, 0)

  for (let step = 0; step < STEPS; step++) {
    let r = rand() * total
    const [, name, apply] = steps.find(([weight]) => (r -= weight) < 0)!
    try {
      apply()
      expectConsistentScene(store, scene, drawing)
    } catch (e) {
      throw new Error(`seed ${seed}, step ${step} (${name}): ${(e as Error).message}`, { cause: e })
    }
  }

  // Once the builds have all arrived, every bucket near the view has an up-to-date mesh for a nearby zoom
  for (let round = 0; round < 10 && (builds.pending.length > 0 || round === 0); round++) {
    while (builds.pending.length > 0) scene.onBuilt(builds.deliver())
    expectValidDraws(store, scene, scene.frame(view(), zoom), view(), zoom)
  }
  expect(builds.pending).toEqual([])
  const v = view()
  const near = grow(v, v.maxX - v.minX, v.maxY - v.minY)
  for (const bucket of scene.inspect().buckets.values()) {
    if (!intersects(bucket.bounds, near)) continue
    expect(bucket.mesh, `seed ${seed}: a bucket near the view has no mesh`).not.toBeNull()
    expect(bucket.meshVersion).toBe(bucket.version)
    expect(Math.abs(zoom - bucket.meshZoom)).toBeLessThan(RETESSELLATE_ZOOMS)
  }
  scene.destroy()
}

describe('StrokeScene under random op sequences', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, () => run(seed, 'custom'))
  }
})

describe('StrokeScene under random op sequences, with the store giving the orders', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, () => run(seed, 'default'))
  }
})

describe('StrokeScene with widths that scale with the map', () => {
  // 8px at zoom 2 is 8 * 2^16 px at zoom 18: the line covers the view though its center line is screens away
  it('builds and draws a wide line whose center line is far from the view', () => {
    const store = new StrokeStore({ order: 'custom' })
    const builds = new DeferredBuilds()
    const scene = new StrokeScene(store, fakeWriter, builds, 2)
    const stroke: StrokeData = {
      id: 's:1',
      author: 'a',
      color: '#000000',
      width: 8,
      zoom: 2,
      points: Float64Array.of(0.49, 0.5, 0.51, 0.5),
      order: 1,
    }
    store.apply({ type: 'load', strokes: [stroke] }, 'remote')
    const view = { minX: 0.499995, maxX: 0.500005, minY: 0.500995, maxY: 0.501005 }
    expect(
      intersects(
        grow(view, 0, 0),
        grow({ minX: 0.49, maxX: 0.51, minY: 0.5, maxY: 0.5 }, (8 * mercatorPerPixelAt(2)) / 2),
      ),
    ).toBe(true)
    scene.frame(view, 18)
    expect(builds.pending).toHaveLength(1)
    expect(builds.pending[0].strokes.map((s) => s.id)).toEqual(['s:1'])
    scene.onBuilt(builds.deliver())
    const frame = scene.frame(view, 18)
    expect(frame.opaque.length).toBeGreaterThan(0)
    expectConsistentScene(store, scene, new Set())
    expectValidDraws(store, scene, frame, view, 18)
  })
})

describe('StrokeScene after the widest line of a bucket is erased', () => {
  it('drops the mesh once the remaining thin lines are far from the view', () => {
    const store = new StrokeStore({ order: 'custom' })
    const builds = new DeferredBuilds()
    const scene = new StrokeScene(store, fakeWriter, builds, 18)
    const line = (id: number, width: number): StrokeData => ({
      id: `s:${id}`,
      author: 'a',
      color: '#000000',
      width,
      zoom: 2,
      points: Float64Array.of(0.5, 0.5),
      order: id,
    })
    store.apply(
      { type: 'load', strokes: [line(0, 64), ...Array.from({ length: 10 }, (_, i) => line(i + 1, 1))] },
      'remote',
    )
    const at = (y: number): Bounds => ({ minX: 0.499995, maxX: 0.500005, minY: y - 0.000005, maxY: y + 0.000005 })
    scene.frame(at(0.5), 18)
    scene.onBuilt(builds.deliver())
    scene.takeRetired()
    store.apply({ type: 'remove', id: 's:0' }, 'remote')
    // 0.001 away: inside the 64px line's half width at zoom 18, far outside the 1px lines'
    const frame = scene.frame(at(0.501), 18)
    expect(scene.takeRetired().length).toBeGreaterThan(0)
    expect(frame.opaque).toEqual([])
    expectConsistentScene(store, scene, new Set())
    expectValidDraws(store, scene, frame, at(0.501), 18)
  })
})

describe('StrokeScene after the stroke at the edge of a bucket is erased', () => {
  it('shrinks the bucket bounds and drops the mesh far from the strokes left', () => {
    const store = new StrokeStore({ order: 'custom' })
    const builds = new DeferredBuilds()
    const scene = new StrokeScene(store, fakeWriter, builds, 18)
    const line = (id: number, points: Point[]): StrokeData => ({
      id: `s:${id}`,
      author: 'a',
      color: '#000000',
      width: 1,
      zoom: 2,
      points: xy(points),
      // Orders start at 1
      order: id + 1,
    })
    // All in one bucket (zoom 2, first point at 0.51); s:0 reaches 0.09 further down
    store.apply(
      {
        type: 'load',
        strokes: [
          line(0, [
            [0.51, 0.51],
            [0.51, 0.6],
          ]),
          ...Array.from({ length: 10 }, (_, i) => line(i + 1, [[0.51, 0.51]])),
        ],
      },
      'remote',
    )
    const at = (y: number): Bounds => ({ minX: 0.509995, maxX: 0.510005, minY: y - 0.000005, maxY: y + 0.000005 })
    scene.frame(at(0.6), 18)
    scene.onBuilt(builds.deliver())
    scene.takeRetired()
    store.apply({ type: 'remove', id: 's:0' }, 'remote')
    const bucket = [...scene.inspect().buckets.values()][0]
    expect(bucket.bounds).toEqual({ minX: 0.51, minY: 0.51, maxX: 0.51, maxY: 0.51 })
    const frame = scene.frame(at(0.6), 18)
    expect(scene.takeRetired().length).toBeGreaterThan(0)
    expect(frame.opaque).toEqual([])
    expectConsistentScene(store, scene, new Set())
    expectValidDraws(store, scene, frame, at(0.6), 18)
  })

  it('erases 10,000 strokes of one width without scanning the bucket', () => {
    const store = new StrokeStore({ order: 'custom' })
    const scene = new StrokeScene(store, fakeWriter, new DeferredBuilds(), 2)
    const n = 10_000
    const strokes: StrokeData[] = Array.from({ length: n }, (_, i) => ({
      id: `s:${i}`,
      author: 'a',
      color: '#000000',
      width: 4,
      zoom: 2,
      points: Float64Array.of(0.51 + i * 1e-6, 0.51 + (i % 100) * 1e-6),
      order: i + 1,
    }))
    store.apply({ type: 'load', strokes }, 'remote')
    const bucket = [...scene.inspect().buckets.values()][0]
    expect(bucket.strokes.size).toBe(n)
    const extremes = Object.values(bucket.extremes)
    const steps = (): number => extremes.reduce((sum, extreme) => sum + extreme.steps, 0)
    const before = steps()
    const scans = vi.spyOn(bucket.strokes, 'values')
    for (const stroke of strokes) store.apply({ type: 'remove', id: stroke.id }, 'remote')
    expect(scans).not.toHaveBeenCalled()
    expect(steps() - before).toBeLessThanOrEqual(extremes.length * n * (Math.log2(n) + 2))
    expect(scene.inspect().buckets.size).toBe(0)
  })
})

describe('StrokeScene given the same stroke twice in one load', () => {
  it('counts its extent once, so erasing it shrinks the bucket back', () => {
    const store = new StrokeStore({ order: 'custom' })
    const scene = new StrokeScene(store, fakeWriter, new DeferredBuilds(), 2)
    const line = (id: string, width: number, end: number): StrokeData => ({
      id,
      author: 'a',
      color: '#000000',
      width,
      zoom: 2,
      points: Float64Array.of(0.51, 0.51, 0.51, end),
      order: 1,
    })
    store.apply({ type: 'load', strokes: [line('keep', 1, 0.51)] }, 'remote')
    for (let i = 0; i < 200; i++) {
      const twice = line('s', 2 + i, 0.52 + i * 1e-4)
      store.apply({ type: 'load', strokes: [twice, twice] }, 'remote')
      store.apply({ type: 'remove', id: 's' }, 'remote')
    }
    const bucket = [...scene.inspect().buckets.values()][0]
    expect(bucket.strokes.size).toBe(1)
    expect(bucket.bounds).toEqual({ minX: 0.51, minY: 0.51, maxX: 0.51, maxY: 0.51 })
    expect(bucket.maxWidthMercator).toBeCloseTo(mercatorPerPixelAt(2))
    const heaps = Object.values(bucket.extremes).map(
      (extreme) => (extreme as unknown as { heap: number[] }).heap.length,
    )
    for (const length of heaps) expect(length).toBeLessThanOrEqual(2)
    expectConsistentScene(store, scene, new Set())
  })
})

describe('StrokeScene given new strokes twice in one load into a bucket with a mesh', () => {
  it('does not search the mesh for them', () => {
    const store = new StrokeStore({ order: 'custom' })
    const builds = new DeferredBuilds()
    const scene = new StrokeScene(store, fakeWriter, builds, 18)
    const line = (id: string, y: number): StrokeData => ({
      id,
      author: 'a',
      color: '#000000',
      width: 1,
      zoom: 2,
      points: Float64Array.of(0.51, y),
      order: 1,
    })
    store.apply(
      { type: 'load', strokes: Array.from({ length: 100 }, (_, i) => line(`old:${i}`, 0.51 + i * 1e-7)) },
      'remote',
    )
    const view = { minX: 0.509995, maxX: 0.510005, minY: 0.509995, maxY: 0.510005 }
    scene.frame(view, 18)
    scene.onBuilt(builds.deliver())
    expect([...scene.inspect().buckets.values()][0].mesh).not.toBeNull()
    const removals = vi.spyOn(MeshBuffer.prototype, 'removeStroke')
    const fresh = Array.from({ length: 50 }, (_, i) => line(`new:${i}`, 0.52 + i * 1e-6))
    store.apply({ type: 'load', strokes: [...fresh, ...fresh] }, 'remote')
    expect(removals).not.toHaveBeenCalled()
    removals.mockRestore()
    const bucket = [...scene.inspect().buckets.values()][0]
    expect(bucket.bounds.maxY).toBeCloseTo(0.52 + 49e-6)
    for (const stroke of fresh) store.apply({ type: 'remove', id: stroke.id }, 'remote')
    expect(bucket.bounds.maxY).toBeCloseTo(0.51 + 99e-7)
    expectConsistentScene(store, scene, new Set())
  })
})
