// Pen pressure: the width coefficients from pressure, how they are thinned with the points, and kept with a stroke
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StrokeStore, type Point } from '../src/core/stroke'
import { mercatorPerPixelAt } from '../src/mercator'
import { DEFAULT_SETTINGS } from '../src/pens'
import { PressureFilter, pressureCoefficient, quantizePressure } from '../src/pressure'
import { StrokeScene } from '../src/StrokeScene'
import { appendSamples, StrokeTessellator, type Samples } from '../src/StrokeTessellator'
import { xy } from './support'

const id = '0123abcd-0123-4567-89ab-0123456789ab:7'
const curve = DEFAULT_SETTINGS.pressure

describe('pressure coefficients', () => {
  it('follow min + (1 - min) * p^gamma with the default curve (min 0.25, gamma 0.7)', () => {
    expect(curve).toEqual({ min: 0.25, gamma: 0.7 })
    expect(pressureCoefficient(0, curve)).toBe(quantizePressure(0.25))
    expect(pressureCoefficient(1, curve)).toBe(1)
    expect(pressureCoefficient(0.5, curve)).toBeCloseTo(0.25 + 0.75 * 0.5 ** 0.7, 2)
    // Out-of-range readings are clamped
    expect(pressureCoefficient(-1, curve)).toBe(pressureCoefficient(0, curve))
    expect(pressureCoefficient(2, curve)).toBe(1)
  })

  it('are rounded to 1/255 steps, written with three decimals, and never 0', () => {
    for (let k = 1; k <= 255; k++) {
      const q = quantizePressure(k / 255 + 0.001)
      expect(Math.round(q * 255)).toBe(k)
      expect(String(q).length).toBeLessThanOrEqual(5)
    }
    // Adjacent steps stay apart
    const levels = new Set(Array.from({ length: 255 }, (_, k) => quantizePressure((k + 1) / 255)))
    expect(levels.size).toBe(255)
    expect(quantizePressure(0)).toBeGreaterThan(0)
    expect(quantizePressure(1.5)).toBe(1)
  })

  it('are smoothed over the readings, half of each new one', () => {
    const filter = new PressureFilter({ min: 0, gamma: 1 })
    expect(filter.next(1)).toBe(1)
    expect(filter.next(0)).toBe(quantizePressure(0.5))
    expect(filter.next(0)).toBe(quantizePressure(0.25))
  })
})

describe('appendSamples with pressure', () => {
  const zoom = 12
  const px = mercatorPerPixelAt(zoom)
  const at = (x: number): Point => [0.5 + x * px, 0.5]

  it('drops the coefficient of each point it thins away, keeping the arrays the same length', () => {
    // Points 0.05 px apart: closer than the tolerance (1/8 px), so most are thinned
    const points = Array.from({ length: 40 }, (_, i) => at(i * 0.05))
    const pressure = Float32Array.from(points, (_, i) => 0.5 + (i % 2) * 0.01)
    const samples: Samples = { points: [] }
    appendSamples(samples, { points: xy(points), pressure }, 0, zoom)
    expect(samples.points.length).toBeLessThan(points.length)
    expect(samples.pressure).toHaveLength(samples.points.length)
    for (let i = 0; i < samples.points.length; i++) {
      const [x, y] = samples.points[i]
      expect(samples.pressure![i]).toBe(pressure[points.findIndex((p) => p[0] === x && p[1] === y)])
    }
  })

  it('keeps a point closer than the tolerance when its coefficient changed by 0.1 or more', () => {
    const points = [at(0), at(0.05), at(0.1), at(0.15)]
    const pressure = Float32Array.of(0.5, 0.55, 0.65, 0.7)
    const samples: Samples = { points: [] }
    appendSamples(samples, { points: xy(points), pressure }, 0, zoom)
    // 0.55 is within 0.1 of 0.5 and dropped, 0.65 is not and kept, 0.7 is within 0.1 of 0.65 and dropped
    expect(samples.points).toEqual([at(0), at(0.1)])
    expect(samples.pressure).toEqual([pressure[0], pressure[2]])
  })

  it('thins a point whose coefficient changed when it is closer than 3/4 of the tolerance', () => {
    // lyon would merge it into the sample before (found by a review)
    const points = [at(0), at(0.09), at(0.095)]
    const pressure = Float32Array.of(0.5, 1, 0.25)
    const samples: Samples = { points: [] }
    appendSamples(samples, { points: xy(points), pressure }, 0, zoom)
    expect(samples.points).toEqual([at(0), at(0.095)])
    expect(samples.pressure).toEqual([0.5, 0.25])
  })

  it('leaves the samples without coefficients for a stroke without pressure', () => {
    const samples: Samples = { points: [] }
    appendSamples(samples, { points: xy([at(0), at(1)]) }, 0, zoom)
    expect(samples.pressure).toBeUndefined()
  })
})

describe('StrokeStore with pressure', () => {
  const begin = { type: 'begin', id: 'a', author: 'me', color: '#000000', width: 4, zoom: 12 } as const

  it('keeps one coefficient per point', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply(begin, 'remote')
    store.apply({ type: 'points', id: 'a', pts: Float64Array.of(0.5, 0.5), ps: Float32Array.of(0.5) }, 'remote')
    store.apply(
      { type: 'points', id: 'a', pts: Float64Array.of(0.6, 0.5, 0.7, 0.5), ps: Float32Array.of(0.6, 0.7) },
      'remote',
    )
    expect(store.get('a')!.pressure).toEqual(Float32Array.of(0.5, 0.6, 0.7))
    expect(store.get('a')!.points).toHaveLength(2 * 3)
  })

  it('ignores points that disagree with the first on having pressure, and a length mismatch', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply(begin, 'remote')
    store.apply({ type: 'points', id: 'a', pts: Float64Array.of(0.5, 0.5), ps: Float32Array.of(0.5) }, 'remote')
    expect(store.apply({ type: 'points', id: 'a', pts: Float64Array.of(0.6, 0.5) }, 'remote')).toBe(false)
    const twoCoefficients = Float32Array.of(0.5, 0.5)
    expect(
      store.apply({ type: 'points', id: 'a', pts: Float64Array.of(0.6, 0.5), ps: twoCoefficients }, 'remote'),
    ).toBe(false)
    const plain = new StrokeStore({ order: 'custom' })
    plain.apply(begin, 'remote')
    plain.apply({ type: 'points', id: 'a', pts: Float64Array.of(0.5, 0.5) }, 'remote')
    expect(
      plain.apply({ type: 'points', id: 'a', pts: Float64Array.of(0.6, 0.5), ps: Float32Array.of(0.5) }, 'remote'),
    ).toBe(false)
    expect(plain.get('a')!.pressure).toBeUndefined()
    expect(store.get('a')!.points).toHaveLength(2)
    expect(plain.get('a')!.points).toHaveLength(2)
  })
})

describe('a stroke being drawn with pressure', () => {
  // Found by a review: points 0.001 px apart whose coefficients alternate were all kept, lyon merged the whole frozen
  // piece into one point, and every frame after it threw ("no triangle has the flat end's edge")
  it('draws points far closer than the tolerance whose coefficients alternate', async () => {
    const tessellator = await StrokeTessellator.load(
      readFileSync(join(import.meta.dirname, '../tessellator/pkg/handwriting_tessellator_bg.wasm')),
    )
    const zoom = 12
    const px = mercatorPerPixelAt(zoom)
    const store = new StrokeStore({ order: 'custom' })
    const scene = new StrokeScene(store, tessellator, { build: () => {} }, zoom)
    const view = { minX: 0.5003 - 500 * px, maxX: 0.5003 + 500 * px, minY: 0.5003 - 350 * px, maxY: 0.5003 + 350 * px }
    store.apply({ type: 'begin', id: 'me:1', author: 'me', color: '#000000', width: 4, zoom }, 'local')
    for (let i = 0; i < 60; i++) {
      const ps = Float32Array.of(quantizePressure(i % 2 === 0 ? 0.251 : 1))
      store.apply({ type: 'points', id: 'me:1', pts: Float64Array.of(0.5003 + i * 0.001 * px, 0.5003), ps }, 'local')
      expect(() => scene.frame(view, zoom), `frame after point ${i}`).not.toThrow()
    }
  })
})
