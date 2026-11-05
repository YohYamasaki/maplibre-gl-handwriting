import { describe, expect, it } from 'vitest'
import type { Bounds } from '../src/bounds'
import { generateBenchStrokes } from '../dev/benchStrokes'
import { mercatorPerPixelAt } from '../src/core/mercator'
import type { Point } from '../src/core/stroke'
import { isTranslucent } from '../src/MeshBuffer'
import { pairs } from './support'

/** A deterministic stand-in for Math.random (mulberry32) */
function seeded(seed: number): () => number {
  let a = seed
  return (): number => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** generateBenchStrokes, with each stroke's points as [x, y] pairs */
function generated(...args: Parameters<typeof generateBenchStrokes>): { points: Point[] }[] {
  return generateBenchStrokes(...args).map((stroke) => ({ ...stroke, points: pairs(stroke.points) }))
}

describe('generateBenchStrokes', () => {
  const bounds = { minX: 0.4, minY: 0.3, maxX: 0.41, maxY: 0.31 }

  it('makes the asked number of strokes with unique IDs, orders 1..count and no pressure', () => {
    const strokes = generateBenchStrokes(1000, bounds, 12, seeded(1))
    expect(strokes).toHaveLength(1000)
    expect(new Set(strokes.map((s) => s.id)).size).toBe(1000)
    expect(strokes.map((s) => s.order)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1))
    expect(strokes.every((s) => s.pressure === undefined && s.author === 'bench' && s.zoom === 12)).toBe(true)
  })

  it('gives each stroke 31 to 151 points, all inside the bounds', () => {
    for (const stroke of generated(1000, bounds, 12, seeded(2))) {
      expect(stroke.points.length).toBeGreaterThanOrEqual(31)
      expect(stroke.points.length).toBeLessThanOrEqual(151)
      for (const [x, y] of stroke.points) {
        expect(x).toBeGreaterThanOrEqual(bounds.minX)
        expect(x).toBeLessThanOrEqual(bounds.maxX)
        expect(y).toBeGreaterThanOrEqual(bounds.minY)
        expect(y).toBeLessThanOrEqual(bounds.maxY)
      }
    }
  })

  it('keeps the points in [0, 1] at zoom 0 when the bounds are twice the world', () => {
    const world = { minX: -0.5, minY: -0.5, maxX: 1.5, maxY: 1.5 }
    for (const stroke of generated(500, world, 0, seeded(3))) {
      for (const [x, y] of stroke.points) {
        expect(x >= 0 && x <= 1 && y >= 0 && y <= 1).toBe(true)
      }
    }
  })

  it('uses the opaque pen and the translucent highlighter', () => {
    // Two colors, one opaque and one translucent, whatever their values
    const colors = [...new Set(generateBenchStrokes(1000, bounds, 12, seeded(4)).map((s) => s.color))]
    expect(colors).toHaveLength(2)
    expect(colors.map(isTranslucent).sort()).toEqual([false, true])
  })

  // Mirrors of the generator's constants (dev/benchStrokes.ts)
  const PX = mercatorPerPixelAt(12)
  const STEP = 3 * PX
  const WALL = 30 * PX
  const MAX_STEER = 0.25

  /** Bounds of w × h Mercator units with the corner at (0.4, 0.3) */
  function box(w: number, h: number): Bounds {
    return { minX: 0.4, minY: 0.3, maxX: 0.4 + w, maxY: 0.3 + h }
  }

  function inside(b: Bounds, [x, y]: Point): boolean {
    return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY
  }

  function onEdge(b: Bounds, [x, y]: Point): boolean {
    return x === b.minX || x === b.maxX || y === b.minY || y === b.maxY
  }

  function inWall(b: Bounds, [x, y]: Point): boolean {
    return x - b.minX <= WALL || b.maxX - x <= WALL || y - b.minY <= WALL || b.maxY - y <= WALL
  }

  /** Largest change of direction between the segments of three neighboring points, in radians */
  function maxTurn(points: Point[]): number {
    let max = 0
    for (let i = 2; i < points.length; i++) {
      const a = Math.atan2(points[i - 1][1] - points[i - 2][1], points[i - 1][0] - points[i - 2][0])
      const b = Math.atan2(points[i][1] - points[i - 1][1], points[i][0] - points[i - 1][0])
      let d = Math.abs(b - a)
      if (d > Math.PI) d = 2 * Math.PI - d
      max = Math.max(max, d)
    }
    return max
  }

  /** Longest run of neighboring points within the wall band, in steps */
  function longestWallRun(b: Bounds, points: Point[]): number {
    let run = 0
    let longest = 0
    for (let i = 1; i < points.length; i++) {
      run = inWall(b, points[i - 1]) && inWall(b, points[i]) ? run + 1 : 0
      longest = Math.max(longest, run)
    }
    return longest
  }

  /** Median of the longer side of the strokes' bounding boxes, in px at zoom 12 */
  function medianLongSide(strokes: { points: Point[] }[]): number {
    const sides = strokes
      .map(({ points }) => {
        const xs = points.map((p) => p[0])
        const ys = points.map((p) => p[1])
        return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / PX
      })
      .sort((a, b) => a - b)
    const mid = sides.length >> 1
    return sides.length % 2 === 1 ? sides[mid] : (sides[mid - 1] + sides[mid]) / 2
  }

  for (const [label, b] of [
    ['100 × 100 steps', box(100 * STEP, 100 * STEP)],
    ['1,000 × 100 steps', box(1000 * STEP, 100 * STEP)],
  ] as const) {
    for (const seed of [1, 7, 9]) {
      it(`turns smoothly and bends away from the edges in ${label} (seed ${seed})`, () => {
        const strokes = generated(1000, b, 12, seeded(seed))
        let stuck = 0
        let longRuns = 0
        let turn = 0
        for (const { points } of strokes) {
          expect(points.every((p) => inside(b, p))).toBe(true)
          turn = Math.max(turn, maxTurn(points))
          for (let i = 1; i < points.length; i++) {
            if (onEdge(b, points[i - 1]) && onEdge(b, points[i])) stuck++
          }
          if (longestWallRun(b, points) >= 20) longRuns++
        }
        expect(turn).toBeLessThanOrEqual(MAX_STEER + 1e-9)
        expect(stuck).toBe(0)
        expect(longRuns).toBe(0)
      })
    }
  }

  it('keeps the strokes spread out', () => {
    // 65.8 px is half of 131.6 px, the median the earlier generator (turns of up to ±0.6 rad per step) gave here
    expect(medianLongSide(generated(1000, bounds, 12, seeded(1)))).toBeGreaterThanOrEqual(65.8)
  })

  it('keeps the points inside the bounds and [0, 1] when an axis is too narrow to steer on', () => {
    const narrow: Bounds[] = [
      box(0, 0),
      box(0, 100 * STEP),
      box(1.5 * STEP, 1.5 * STEP),
      { minX: 1 - 1.5 * STEP, minY: 0, maxX: 1, maxY: 1.5 * STEP },
    ]
    for (const b of narrow) {
      for (const { points } of generated(500, b, 12, seeded(5))) {
        for (const p of points) {
          expect(inside(b, p)).toBe(true)
          expect(p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1).toBe(true)
        }
      }
    }
  })

  it('does not gather the strokes in the middle of a narrow, tall bounds', () => {
    expect(medianLongSide(generated(1000, box(10 * PX, 300 * STEP), 12, seeded(1)))).toBeGreaterThanOrEqual(50)
  })
})
