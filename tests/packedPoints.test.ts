// A stroke's points are a Float64Array of x and y in turn and its width coefficients a Float32Array.
// The store grows the arrays of a stroke being drawn 32 points at a time and copies them to their exact length at its
// end, keeps copies of the arrays it is given, and leaves out points and coefficients of another type or length. The
// split, transform and GeoJSON numbers are those of the version that kept the points as [x, y] pairs (GOLDEN, written
// by it)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { strokesToGeoJSON } from '../src/core/geojson'
import { cutStroke, piecePoints, type EraserSweep } from '../src/core/split'
import { appendPoints, StrokeStore, type Point, type StrokeData, type StrokeOp } from '../src/core/stroke'
import { similarityAbout, transformStroke } from '../src/core/transform'
import { pairs, random, xy } from './support'

const begin = { type: 'begin', id: 'a', author: 'me', color: '#000000', width: 4, zoom: 12 } as const

/** `n` points along x from `x`, as a points op holds them */
function run(n: number, x = 0.5): Float64Array {
  return xy(Array.from({ length: n }, (_, i): Point => [x + i * 1e-6, 0.5]))
}

function saved(id: string, points: Float64Array, extra: Partial<StrokeData> = {}): StrokeData {
  return { id, author: 'me', color: '#000000', width: 4, zoom: 12, points, ...extra }
}

describe('a stroke being drawn', () => {
  it('grows its arrays 32 points at a time, at once to the multiple a larger op needs, and fits them at its end', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply(begin, 'local')
    store.apply({ type: 'points', id: 'a', pts: run(1), ps: Float32Array.of(0.5) }, 'local')
    const stroke = store.get('a')!
    expect(stroke.points).toHaveLength(2)
    expect(stroke.points!.buffer.byteLength).toBe(16 * 32)
    expect(stroke.pressure!.buffer.byteLength).toBe(4 * 32)
    const buffer = stroke.points!.buffer
    for (let i = 1; i < 32; i++) {
      store.apply({ type: 'points', id: 'a', pts: run(1, 0.5 + i * 1e-6), ps: Float32Array.of(0.5) }, 'local')
    }
    expect(stroke.points).toHaveLength(2 * 32)
    expect(stroke.points!.buffer).toBe(buffer)
    store.apply({ type: 'points', id: 'a', pts: run(1, 0.6), ps: Float32Array.of(0.25) }, 'local')
    expect(stroke.points!.buffer.byteLength).toBe(16 * 64)
    expect(stroke.pressure!.buffer.byteLength).toBe(4 * 64)
    // 33 points and 100 more: room for 160 at once
    store.apply({ type: 'points', id: 'a', pts: run(100, 0.7), ps: new Float32Array(100).fill(1) }, 'local')
    expect(stroke.points).toHaveLength(2 * 133)
    expect(stroke.points!.buffer.byteLength).toBe(16 * 160)
    expect(stroke.pressure!.buffer.byteLength).toBe(4 * 160)
    const drawn = [...run(32), ...run(1, 0.6), ...run(100, 0.7)]
    expect([...stroke.points!]).toEqual(drawn)

    store.apply({ type: 'end', id: 'a' }, 'local')
    expect(stroke.points!.buffer.byteLength).toBe(16 * 133)
    expect(stroke.pressure!.buffer.byteLength).toBe(4 * 133)
    expect([...stroke.points!]).toEqual(drawn)
    expect([...stroke.pressure!]).toEqual([...new Array(32).fill(0.5), 0.25, ...new Array(100).fill(1)])
  })

  it('appends to the moved points when a transform moved it while it is drawn', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply(begin, 'local')
    store.apply({ type: 'points', id: 'a', pts: run(2) }, 'local')
    store.apply({ type: 'order', id: 'a', order: 1 }, 'remote')
    store.apply({ type: 'transform', ids: ['a'], matrix: [1, 0, 0, 1, 0.1, 0] }, 'remote')
    store.apply({ type: 'points', id: 'a', pts: Float64Array.of(0.7, 0.5) }, 'local')
    store.apply({ type: 'end', id: 'a' }, 'local')
    expect(pairs(store.get('a')!.points)).toEqual([
      [0.5 + 0.1, 0.5],
      [0.500001 + 0.1, 0.5],
      [0.7, 0.5],
    ])
    expect(store.get('a')!.points!.buffer.byteLength).toBe(16 * 3)
  })
})

describe('a stroke that stops growing before its end', () => {
  /** A store with stroke 'a' being drawn: 2 points with coefficients, and an order */
  function drawing(): { store: StrokeStore; stroke: StrokeData } {
    const store = new StrokeStore({ order: 'custom' })
    store.apply(begin, 'local')
    store.apply({ type: 'points', id: 'a', pts: run(2), ps: Float32Array.of(0.5, 0.25) }, 'local')
    store.apply({ type: 'order', id: 'a', order: 1 }, 'remote')
    return { store, stroke: store.get('a')! }
  }

  /** Whether both arrays of the stroke are of their exact length: 16 bytes a point and 4 bytes a coefficient */
  function expectExact(stroke: StrokeData, count: number): void {
    expect(stroke.points!.buffer.byteLength).toBe(16 * count)
    expect(stroke.pressure!.buffer.byteLength).toBe(4 * count)
    expect([...stroke.pressure!]).toEqual([0.5, 0.25])
  }

  it('fits its coefficients too when a transform or a replace gives it new points', () => {
    for (const op of [
      { type: 'transform', ids: ['a'], matrix: [1, 0, 0, 1, 0.1, 0] },
      { type: 'replace', strokes: [saved('a', run(2, 0.6), { order: 1 })] },
    ] as StrokeOp[]) {
      const { store, stroke } = drawing()
      expect(store.apply(op, 'remote')).toBe(true)
      expectExact(stroke, 2)
      store.apply({ type: 'end', id: 'a' }, 'local')
      expectExact(stroke, 2)
    }
  })

  it('fits both arrays when a remove, a split or a reset takes it out of the store', () => {
    for (const op of [
      { type: 'remove', id: 'a' },
      { type: 'split', id: 'a', pieces: [{ id: 'p', from: 0, to: 0.5 }] },
      { type: 'reset', strokes: [] },
    ] as StrokeOp[]) {
      const { store, stroke } = drawing()
      expect(store.apply(op, 'remote')).toBe(true)
      expect(store.get('a')).toBeUndefined()
      expectExact(stroke, 2)
    }
  })
})

describe('strokes handed to the store', () => {
  it('are kept as copies of 16 bytes a point and 4 bytes a coefficient, whatever buffer they came in', () => {
    const store = new StrokeStore({ order: 'custom' })
    const big = new Float64Array(1000)
    big.set(run(5), 10)
    const points = big.subarray(10, 20)
    const pressure = new Float32Array(100).subarray(3, 8).fill(0.5)
    store.apply({ type: 'load', strokes: [saved('a', points, { pressure })] }, 'remote')
    store.apply({ type: 'restore', stroke: saved('b', points) }, 'remote')
    for (const id of ['a', 'b']) {
      const stroke = store.get(id)!
      expect(stroke.points!.buffer.byteLength).toBe(16 * 5)
      expect([...stroke.points!]).toEqual([...run(5)])
    }
    expect(store.get('a')!.pressure!.buffer.byteLength).toBe(4 * 5)
    points[0] = 0
    expect(store.get('a')!.points![0]).toBe(0.5)
    store.apply({ type: 'reset', strokes: [saved('c', points)] }, 'remote')
    expect(store.get('c')!.points!.buffer.byteLength).toBe(16 * 5)
  })

  it('leave out points of another type or an odd length, and coefficients of another type or length', () => {
    const store = new StrokeStore({ order: 'custom' })
    const seen: StrokeOp[] = []
    store.subscribe((op) => seen.push(op))
    const good = saved('good', run(3), { pressure: Float32Array.of(1, 0.5, 0.25), order: 1 })
    const bad = [
      saved('pairs', [[0.5, 0.5]] as unknown as Float64Array),
      saved('odd', Float64Array.of(0.5, 0.5, 0.6)),
      saved('float32', Float32Array.of(0.5, 0.5) as unknown as Float64Array),
      saved('numbers', run(2), { pressure: [1, 1] as unknown as Float32Array }),
      saved('short', run(2), { pressure: Float32Array.of(1) }),
    ]
    expect(store.apply({ type: 'load', strokes: [...bad, good] }, 'remote')).toBe(true)
    expect([...store.values()].map((stroke) => stroke.id)).toEqual(['good'])
    expect(seen.map((op) => (op.type === 'load' ? op.strokes.map((s) => s.id) : op.type))).toEqual([['good']])
    expect(store.apply({ type: 'load', strokes: bad }, 'remote')).toBe(false)
    for (const stroke of bad) expect(store.apply({ type: 'restore', stroke }, 'remote')).toBe(false)

    store.apply({ type: 'reset', strokes: [good, ...bad] }, 'remote')
    expect([...store.values()].map((stroke) => stroke.id)).toEqual(['good'])

    // A replace skips the copy whose points are not a Float64Array and takes the one that is
    const moved = saved('good', run(3, 0.6), { order: 1 })
    expect(
      store.apply({ type: 'replace', strokes: [{ ...moved, points: pairs(moved.points) }] as never }, 'remote'),
    ).toBe(false)
    expect(store.apply({ type: 'replace', strokes: [moved] }, 'remote')).toBe(true)
    expect(store.get('good')!.points).toEqual(run(3, 0.6))
    expect(store.get('good')!.points).not.toBe(moved.points)
  })

  it('a points op of another type or length changes nothing and returns false', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply(begin, 'local')
    store.apply({ type: 'points', id: 'a', pts: run(1), ps: Float32Array.of(0.5) }, 'local')
    const bad = [
      { pts: [[0.6, 0.5]] as unknown as Float64Array, ps: Float32Array.of(0.5) },
      { pts: Float64Array.of(0.6, 0.5, 0.7), ps: Float32Array.of(0.5) },
      { pts: run(1), ps: [0.5] as unknown as Float32Array },
      { pts: run(1), ps: Float32Array.of(0.5, 0.5) },
      { pts: run(1) },
    ]
    for (const op of bad) expect(store.apply({ type: 'points', id: 'a', ...op }, 'local')).toBe(false)
    expect(store.get('a')!.points).toEqual(run(1))
    expect(store.get('a')!.pressure).toEqual(Float32Array.of(0.5))
  })
})

describe('appendPoints', () => {
  it('appends into arrays of the exact length and checks types and lengths as the store does', () => {
    const stroke = saved('a', run(2), { pressure: Float32Array.of(1, 0.5) })
    expect(appendPoints(stroke, Float64Array.of(0.7, 0.5), Float32Array.of(0.25))).toBe(true)
    expect(pairs(stroke.points)).toEqual([...pairs(run(2)), [0.7, 0.5]])
    expect(stroke.points!.buffer.byteLength).toBe(16 * 3)
    expect(stroke.pressure).toEqual(Float32Array.of(1, 0.5, 0.25))
    expect(appendPoints(stroke, Float64Array.of(0.7, 0.5), undefined)).toBe(false)
    expect(appendPoints(stroke, Float64Array.of(0.7), Float32Array.of(1))).toBe(false)
    expect(appendPoints(stroke, [0.7, 0.5] as unknown as Float64Array, Float32Array.of(1))).toBe(false)
    expect(stroke.points).toHaveLength(6)
  })
})

/**
 * toJSON and fromJSON as docs/usage.md defines them: the code of the first block under "Saving and sharing strokes", up
 * to its first blank line
 */
function usageConversions(): { toJSON: (op: unknown) => string; fromJSON: (text: string) => never } {
  const usage = readFileSync(join(import.meta.dirname, '../docs/usage.md'), 'utf8')
  const section = usage.slice(usage.indexOf('## Saving and sharing strokes'))
  const block = /```js\n([\s\S]*?)```/.exec(section)![1]
  const code = block.slice(0, block.indexOf('\n\n'))
  return new Function(`${code}\nreturn { toJSON, fromJSON }`)()
}

describe('strokes as JSON (docs/usage.md)', () => {
  const { toJSON, fromJSON } = usageConversions()

  it('go through Array.from and new Float64Array to the same strokes, sent as ops or saved', () => {
    const here = new StrokeStore()
    const there = new StrokeStore({ order: 'custom' })
    here.subscribe((op, origin) => {
      if (origin === 'local') there.apply(fromJSON(toJSON(op)), 'remote')
    })
    here.apply(begin, 'local')
    here.apply({ type: 'points', id: 'a', pts: run(3), ps: Float32Array.of(0.698, 0.682, 0.564) }, 'local')
    here.apply({ type: 'points', id: 'a', pts: run(2, 0.6), ps: Float32Array.of(1, 0.25) }, 'local')
    here.apply({ type: 'end', id: 'a' }, 'local')
    here.apply({ type: 'points', id: 'b', pts: run(1) }, 'local')
    there.apply({ type: 'order', id: 'a', order: here.get('a')!.order! }, 'remote')
    expect(there.get('a')).toEqual(here.get('a'))
    expect(there.get('a')!.points).toBeInstanceOf(Float64Array)
    expect(there.get('a')!.pressure).toBeInstanceOf(Float32Array)

    // Saved as a load op, and every op that carries strokes
    const saved = fromJSON(toJSON({ type: 'load', strokes: [...here.values()] }))
    const restored = new StrokeStore({ order: 'custom' })
    expect(restored.apply(saved, 'remote')).toBe(true)
    expect(restored.get('a')).toEqual(here.get('a'))
    const stroke = here.get('a')!
    for (const op of [
      { type: 'reset', strokes: [stroke] },
      { type: 'replace', strokes: [stroke] },
      { type: 'restore', stroke },
    ] as StrokeOp[]) {
      expect(fromJSON(toJSON(op))).toEqual(op)
    }
  })

  it('leave the other messages as they are, such as a laser op with pts of [x, y] pairs', () => {
    const laser = {
      source: 'b',
      trail: 0,
      pts: [
        [0.5, 0.5],
        [0.6, 0.5],
      ],
    }
    expect(fromJSON(JSON.stringify(laser))).toEqual(laser)
    expect(fromJSON(toJSON(laser))).toEqual(laser)
    const order = { type: 'order', id: 'points', order: 3 }
    expect(fromJSON(toJSON(order))).toEqual(order)
  })
})

// Written by the version of src/core that kept the points as [x, y] pairs, for the stroke and sweeps below
const GOLDEN = {
  ranges: [
    { from: 0, to: 2.7779055554752015 },
    { from: 3.517218049752487, to: 7.837299236399231 },
    { from: 9.177074623807071, to: 11 },
  ],
  pieces: [
    {
      points: [
        [0.5, 0.5],
        [0.5001011587048648, 0.5000029946408234],
        [0.5002119705612772, 0.500012010404421],
        [0.5003170482308884, 0.5000149681800616],
      ],
      pressure: [0.698, 0.682, 0.564, 0.8121518721965892],
    },
    {
      points: [
        [0.5003770482308884, 0.5000173904342902],
        [0.5004050508470275, 0.5000188631853322],
        [0.5005158245054073, 0.5000138956743991],
        [0.5006138287523993, 0.5000482477416052],
        [0.5007058263274841, 0.5000652685005218],
        [0.5008047556258627, 0.5000368684922192],
      ],
      pressure: [0.8680006765571778, 0.854, 0.827, 0.488, 0.717, 0.4842308122810139],
    },
    {
      points: [
        [0.5009076950704738, 0.5000067818800027],
        [0.5009814224021277, 0.4999966568758944],
        [0.501089673310332, 0.4999594050206244],
      ],
      pressure: [0.38301635663683453, 0.806, 0.983],
    },
  ],
  transformed: {
    points: [
      [0.5001, 0.4998000000000001],
      [0.5002196093199465, 0.49985479669261573],
      [0.5003477289673159, 0.4999216898015127],
      [0.5005075433163426, 0.4999946247515095],
      [0.5005754501250488, 0.5000276408857218],
      [0.5007106029815492, 0.5000777713737401],
      [0.5008105607148594, 0.5001685178744806],
      [0.50091210005176, 0.5002354713848867],
      [0.501070744914788, 0.5002546721268144],
      [0.5011633233223648, 0.5002622129488521],
      [0.5012768272972141, 0.5002928360628482],
      [0.5014253032155056, 0.5003030328187459],
    ],
    zoom: 14.62148837674627,
  },
  geojson:
    '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"LineString","coordinates":[[0,0],[0.001078071,-0.036417131],[0.004323746,-0.076309379],[0.005692548,-0.124937264]]},"properties":{"id":"b","author":"you","order":1,"color":"#445566","opacity":1,"width_px":3,"zoom":9.5,"width_m":324.29484620858733}},{"type":"Feature","geometry":{"type":"LineString","coordinates":[[0,0],[0.036417134,-0.001078071],[0.076309402,-0.004323746],[0.124937363,-0.005692548],[0.145818305,-0.006790747],[0.185696822,-0.005002443],[0.220978351,-0.017369187],[0.254097478,-0.02349666],[0.296632507,-0.011285968],[0.321059032,-0.003225797],[0.353312065,0.001203525],[0.392282392,0.014614192]]},"properties":{"id":"a","author":"me","order":2,"color":"#112233","opacity":0.5019607843137255,"width_px":6,"zoom":15,"width_m":14.331942803621292,"pressure":[0.698,0.682,0.564,0.883,0.854,0.827,0.488,0.717,0.439,0.292,0.806,0.983]}}]}',
}

describe('the numbers of a cut, a transform and GeoJSON', () => {
  // A walk of 12 points from (0.5, 0.5) and coefficients of three decimals, as the pen gives them
  const rand = random(11)
  const walk: Point[] = [[0.5, 0.5]]
  for (let i = 1; i < 12; i++) {
    const [x, y] = walk[i - 1]
    walk.push([x + 1e-4 * (0.5 + rand()), y + 1e-4 * (rand() - 0.5)])
  }
  const coefficients = walk.map(() => Math.round((0.25 + 0.75 * rand()) * 1000) / 1000)
  const a = saved('a', xy(walk), { color: '#11223380', width: 6, zoom: 15, order: 2 })
  a.author = 'me'
  a.pressure = Float32Array.from(coefficients)
  const b: StrokeData = {
    id: 'b',
    author: 'you',
    color: '#445566',
    width: 3,
    zoom: 9.5,
    points: xy(walk.slice(0, 4).map(([x, y]): Point => [y, x])),
    order: 1,
  }

  it('are those of the version with [x, y] pairs, with the coefficients rounded to float32', () => {
    const sweeps: EraserSweep[] = [
      { from: [walk[3][0], walk[3][1] - 5e-5], to: [walk[3][0], walk[3][1] + 5e-5], radius: 3e-5 },
      { from: walk[8], to: [walk[9][0], walk[9][1] + 1e-5], radius: 2e-5 },
    ]
    const ranges = cutStroke(a.points!, sweeps, 1e-5)
    expect(ranges).toEqual(GOLDEN.ranges)
    GOLDEN.pieces.forEach((golden, k) => {
      const piece = piecePoints(a, ranges![k])
      expect(pairs(piece.points)).toEqual(golden.points)
      // The cuts' coefficients are interpolated between float32 values now, so they may differ in their last bit
      expect([...piece.pressure!]).toEqual(golden.pressure.map((c) => expect.closeTo(Math.fround(c), 6)))
      expect(piece.pressure!.slice(1, -1)).toEqual(Float32Array.from(golden.pressure.slice(1, -1)))
    })
    const moved = transformStroke(a, similarityAbout([0.5, 0.5], 1.3, 0.4, [1e-4, -2e-4]))!
    expect(pairs(moved.points)).toEqual(GOLDEN.transformed.points)
    expect(moved.zoom).toBe(GOLDEN.transformed.zoom)
    expect(strokesToGeoJSON([a, b])).toBe(GOLDEN.geojson)
  })
})
