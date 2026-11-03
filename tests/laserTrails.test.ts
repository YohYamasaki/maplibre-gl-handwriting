import { describe, expect, it } from 'vitest'
import type { Point } from '../src/core/stroke'
import { LASER_LIFETIME, LaserTrails, MAX_LASER_POINTS_PER_SOURCE } from '../src/LaserTrails'
import { traceTrail } from '../src/ui/laser'

const pt = (i: number): Point => [0.5 + i * 1e-6, 0.5]

/** The trails as [points, ages] at `now` */
function read(trails: LaserTrails, now: number): [Point[], number[]][] {
  const out: [Point[], number[]][] = []
  trails.forEach(now, (pts, ages) => out.push([[...pts], ages]))
  return out
}

describe('LaserTrails', () => {
  it('drops each point LASER_LIFETIME after it was added, and a trail once it is empty', () => {
    const trails = new LaserTrails()
    trails.add('', 0, [pt(0)], 0)
    trails.add('', 0, [pt(1)], 500)
    trails.prune(LASER_LIFETIME - 1)
    expect(trails.size).toBe(2)
    trails.prune(LASER_LIFETIME)
    expect(read(trails, LASER_LIFETIME)).toEqual([[[pt(1)], [0.5]]])
    trails.prune(500 + LASER_LIFETIME)
    expect(trails.size).toBe(0)
    expect(read(trails, 500 + LASER_LIFETIME)).toEqual([])
  })

  it('an add drops its own source\'s old points and the sources gone quiet; prune drops the rest', () => {
    const trails = new LaserTrails()
    trails.add('a', 1, [pt(0)], 0)
    trails.add('b', 1, [pt(1)], 0)
    trails.add('b', 1, [pt(3)], 500)
    trails.add('a', 1, [pt(2)], LASER_LIFETIME)
    // a's first point went; b still sends, so its old point waits for prune
    expect(trails.size).toBe(3)
    trails.prune(LASER_LIFETIME)
    expect(trails.size).toBe(2)
    expect(read(trails, LASER_LIFETIME)).toEqual([
      [[pt(3)], [0.5]],
      [[pt(2)], [0]],
    ])
  })

  it('holds only the sources still sending when prune is never called (a hidden tab draws no frames)', () => {
    const trails = new LaserTrails()
    // Each reconnect is a new source
    for (let s = 0; s < 1000; s++) {
      trails.add(`s${s}`, 1, Array.from({ length: 1000 }, (_, i) => pt(i)), s * 2000)
    }
    expect(trails.size).toBe(1000)
    expect(read(trails, 999 * 2000).length).toBe(1)
  })

  it('keeps only the last second when points keep coming without prune', () => {
    const trails = new LaserTrails()
    for (let t = 0; t < 5000; t += 10) trails.add('s', 1, [pt(t)], t)
    // Added at 4000 < t <= 4990
    expect(trails.size).toBe(LASER_LIFETIME / 10)
    for (const [, ages] of read(trails, 4990)) expect(Math.max(...ages)).toBeLessThan(1)
  })

  it('keeps at most MAX_LASER_POINTS_PER_SOURCE per source, dropping the oldest', () => {
    const trails = new LaserTrails()
    const many = (from: number, n: number): Point[] => Array.from({ length: n }, (_, i) => pt(from + i))
    trails.add('a', 0, many(0, 600), 0)
    trails.add('a', 1, many(600, 600), 1)
    trails.add('b', 0, many(0, 300), 1)
    expect(trails.size).toBe(MAX_LASER_POINTS_PER_SOURCE + 300)
    const [first, second] = read(trails, 1)
    // The oldest trail lost its first 200 points; the newer one is whole
    expect(first[0]).toHaveLength(400)
    expect(first[0][0]).toEqual(pt(200))
    expect(second[0]).toHaveLength(600)
    // One add larger than the limit keeps its last points
    trails.add('c', 0, many(0, 1500), 2)
    const c = read(trails, 2).at(-1)!
    expect(c[0]).toHaveLength(MAX_LASER_POINTS_PER_SOURCE)
    expect(c[0][0]).toEqual(pt(500))
  })

  it('gives ages from 0 to 1', () => {
    const trails = new LaserTrails()
    trails.add('', 0, [pt(0)], 0)
    trails.add('', 0, [pt(1)], 250)
    trails.add('', 0, [pt(2)], 999)
    const [[, ages]] = read(trails, 999)
    expect(ages[0]).toBeCloseTo(0.999)
    expect(ages[1]).toBeCloseTo(0.749)
    expect(ages[2]).toBe(0)
    // Read later than prune: still within 0 to 1
    const [[, later]] = read(trails, 5000)
    expect(later.every((age) => age >= 0 && age <= 1)).toBe(true)
  })
})

describe('traceTrail', () => {
  /** Records the path and gives the signed area of each closed shape (positive: clockwise on screen) */
  function trace(pts: { x: number; y: number }[], radii: number[]): number[] {
    const areas: number[] = []
    let shape: [number, number][] = []
    const close = (): void => {
      if (shape.length < 3) return void (shape = [])
      let area = 0
      for (let i = 0; i < shape.length; i++) {
        const [x0, y0] = shape[i]
        const [x1, y1] = shape[(i + 1) % shape.length]
        area += x0 * y1 - x1 * y0
      }
      areas.push(area / 2)
      shape = []
    }
    traceTrail(
      {
        moveTo: (x: number, y: number) => {
          close()
          shape = [[x, y]]
        },
        lineTo: (x: number, y: number) => void shape.push([x, y]),
        arc: (x: number, y: number, r: number, from: number, to: number, ccw?: boolean) => {
          expect(ccw ?? false).toBe(false)
          for (let k = 1; k <= 16; k++) {
            const a = from + ((to - from) * k) / 16
            shape.push([x + r * Math.cos(a), y + r * Math.sin(a)])
          }
        },
        closePath: () => close(),
      },
      pts,
      radii,
    )
    close()
    return areas
  }

  it('winds every circle and trapezoid the same way, so one nonzero fill paints their union once', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 5 },
    ]
    const areas = trace(pts, [3, 2.5, 2, 1])
    // A circle per point and a trapezoid per segment
    expect(areas).toHaveLength(pts.length + pts.length - 1)
    expect(areas.every((area) => area > 0)).toBe(true)
  })

  it('leaves out points that have no width left', () => {
    expect(trace([{ x: 0, y: 0 }], [0])).toEqual([])
  })
})
