// Decision 0076: strokes as GeoJSON
import { describe, expect, it } from 'vitest'
import { strokesToGeoJSON } from '../src/core/geojson'
import { mercatorPerPixelAt } from '../src/core/mercator'
import type { Point, StrokeData } from '../src/core/stroke'

type Geometry = { type: string; coordinates: unknown }
type Feature = { type: string; geometry: Geometry; properties: Record<string, unknown> }
type Collection = { type: string; features: Feature[]; crs?: unknown }

function stroke(id: string, points: Point[], extra: Partial<StrokeData> = {}): StrokeData {
  return { id, author: 'me', color: '#112233', width: 4, zoom: 10, points, order: 1, ...extra }
}

function parse(strokes: StrokeData[]): Collection {
  return JSON.parse(strokesToGeoJSON(strokes)) as Collection
}

/** Every position in a geometry, for Point and LineString */
function positions(geometry: Geometry): number[][] {
  return geometry.type === 'Point' ? [geometry.coordinates as number[]] : (geometry.coordinates as number[][])
}

/** Checks the RFC 7946 shape: types, geometry, properties and coordinates in range */
function expectRfc7946(out: Collection): void {
  expect(out.type).toBe('FeatureCollection')
  expect(out.crs).toBeUndefined()
  expect(Array.isArray(out.features)).toBe(true)
  for (const feature of out.features) {
    expect(feature.type).toBe('Feature')
    expect(typeof feature.properties).toBe('object')
    expect(['Point', 'LineString']).toContain(feature.geometry.type)
    const list = positions(feature.geometry)
    if (feature.geometry.type === 'LineString') expect(list.length).toBeGreaterThanOrEqual(2)
    for (const position of list) {
      expect(position).toHaveLength(2)
      const [lng, lat] = position
      expect(Number.isFinite(lng) && Number.isFinite(lat)).toBe(true)
      expect(lng).toBeGreaterThanOrEqual(-180)
      expect(lng).toBeLessThanOrEqual(180)
      expect(lat).toBeGreaterThanOrEqual(-90)
      expect(lat).toBeLessThanOrEqual(90)
    }
  }
}

describe('strokesToGeoJSON', () => {
  it('maps (0.5, 0.5) to [0, 0] and the corners to the Web Mercator bounds', () => {
    const out = parse([stroke('a', [[0.5, 0.5], [0, 0], [1, 1]])])
    expectRfc7946(out)
    const [center, topLeft, bottomRight] = positions(out.features[0].geometry)
    expect(center).toEqual([0, 0])
    expect(topLeft[0]).toBe(-180)
    expect(topLeft[1]).toBeCloseTo(85.0511287798, 9)
    expect(bottomRight[0]).toBe(180)
    expect(bottomRight[1]).toBeCloseTo(-85.0511287798, 9)
  })

  it('rounds coordinates to 9 decimals', () => {
    const out = parse([stroke('a', [[0.123456789123, 0.4], [0.6, 0.6]])])
    for (const position of positions(out.features[0].geometry)) {
      for (const value of position) {
        const [, decimals = ''] = String(value).split('.')
        expect(decimals.length).toBeLessThanOrEqual(9)
      }
    }
    const [lng] = positions(out.features[0].geometry)[0]
    expect(lng).toBe(Math.round((360 * 0.123456789123 - 180) * 1e9) / 1e9)
  })

  it('drops points that rounding made equal to the one before, with their pressure', () => {
    const tiny = 1e-15
    const out = parse([
      stroke('a', [[0.5, 0.5], [0.5 + tiny, 0.5], [0.6, 0.5], [0.6, 0.5]], { pressure: [0.1, 0.2, 0.3, 0.4] }),
    ])
    const geometry = out.features[0].geometry
    expect(geometry.type).toBe('LineString')
    expect(positions(geometry)).toHaveLength(2)
    expect(out.features[0].properties.pressure).toEqual([0.1, 0.3])
  })

  it('makes a Point of a stroke left with one point and skips a stroke without points', () => {
    const out = parse([stroke('dot', [[0.5, 0.5], [0.5, 0.5]], { order: 1 }), stroke('empty', [], { order: 2 })])
    expectRfc7946(out)
    expect(out.features).toHaveLength(1)
    expect(out.features[0].geometry).toEqual({ type: 'Point', coordinates: [0, 0] })
    expect(out.features[0].properties.id).toBe('dot')
  })

  it('orders features by drawing order, strokes without one last, then by id', () => {
    const p: Point[] = [[0.4, 0.4], [0.5, 0.5]]
    const out = parse([
      stroke('z', p, { order: undefined }),
      stroke('c', p, { order: 2 }),
      stroke('b', p, { order: 1 }),
      stroke('a', p, { order: 2 }),
      stroke('y', p, { order: undefined }),
    ])
    expect(out.features.map((f) => f.properties.id)).toEqual(['b', 'a', 'c', 'y', 'z'])
    expect(out.features[3].properties.order).toBeNull()
  })

  it('writes the properties, with opacity from the color and the width on the ground', () => {
    const y = 0.4
    const out = parse([stroke('a', [[0.5, y], [0.6, y]], { color: '#ffeb3b80', width: 16, zoom: 12, order: 7 })])
    const properties = out.features[0].properties
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y)))
    expect(properties).toEqual({
      id: 'a',
      author: 'me',
      order: 7,
      color: '#ffeb3b',
      opacity: 0x80 / 255,
      width_px: 16,
      zoom: 12,
      width_m: 16 * mercatorPerPixelAt(12) * 40075016.686 * Math.cos(lat),
    })
    expect(parse([stroke('b', [[0.5, 0.5], [0.6, 0.5]])]).features[0].properties.opacity).toBe(1)
  })

  it('gives width_m in metres: 1 px at zoom 0 on the equator is about 78 km', () => {
    const out = parse([stroke('a', [[0.5, 0.5], [0.6, 0.5]], { width: 1, zoom: 0 })])
    expect(out.features[0].properties.width_m).toBeCloseTo(40075016.686 / 512, 6)
  })

  it('writes pressure only for a stroke drawn with pressure', () => {
    const out = parse([
      stroke('a', [[0.4, 0.5], [0.5, 0.5]], { pressure: [0.25, 1], order: 1 }),
      stroke('b', [[0.4, 0.5], [0.5, 0.5]], { order: 2 }),
    ])
    expect(out.features[0].properties.pressure).toEqual([0.25, 1])
    expect('pressure' in out.features[1].properties).toBe(false)
  })
})
