import { describe, expect, it } from 'vitest'
import { strokeTransform, type CanvasTransform, type StrokeView } from '../dev/Canvas2DStrokes'
import { mercatorPerPixelAt } from '../src/mercator'

/** Where setTransform(...t) puts the path point (x, y) */
function apply(t: CanvasTransform, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = t
  return [a * x + c * y + e, b * x + d * y + f]
}

describe('strokeTransform', () => {
  const zoom = 10
  const unit = mercatorPerPixelAt(zoom)
  const center: [number, number] = [0.5, 0.5]
  // First point 100 px east of the center at the map's zoom; the stroke was drawn one zoom level further out
  const stroke = { zoom: zoom - 1, points: Float64Array.of(0.5 + 100 * unit, 0.5) }
  const view = (bearing: number): StrokeView => ({ center, zoom, bearing, width: 800, height: 600, pixelRatio: 2 })

  it('puts the first point east of the center to the right at bearing 0, scaled by the zoom and the pixel ratio', () => {
    const t = strokeTransform(stroke, view(0))
    expectClose(apply(t, 0, 0), [800 + 200, 600])
    // 10 px at the stroke's zoom are 20 px at the map's, 40 device px; north (path -y) is up
    expectClose(apply(t, 10, 0), [800 + 240, 600])
    expectClose(apply(t, 0, -10), [800 + 200, 600 - 40])
  })

  it('puts east up and north left at bearing 90', () => {
    const t = strokeTransform(stroke, view(90))
    expectClose(apply(t, 0, 0), [800, 600 - 200])
    expectClose(apply(t, 10, 0), [800, 600 - 240])
    expectClose(apply(t, 0, -10), [800 - 40, 600 - 200])
  })
})

function expectClose(actual: [number, number], expected: [number, number]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 6)
  expect(actual[1]).toBeCloseTo(expected[1], 6)
}
