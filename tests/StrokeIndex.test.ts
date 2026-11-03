import { describe, expect, it } from 'vitest'
import { StrokeStore, type Point } from '../src/core/stroke'
import { mercatorPerPixelAt } from '../src/mercator'
import { StrokeIndex } from '../src/StrokeIndex'

const box = (x: number, y: number, r: number) => ({ minX: x - r, minY: y - r, maxX: x + r, maxY: y + r })

describe('StrokeIndex', () => {
  it('finds strokes whose center line bounds meet the box, and follows the store', () => {
    const store = new StrokeStore({ order: 'custom' })
    const index = new StrokeIndex(store)
    const line = (id: string, pts: Point[]): void => {
      store.apply({ type: 'begin', id, author: 'a', color: '#000000', width: 8, zoom: 14 }, 'local')
      store.apply({ type: 'points', id, pts }, 'local')
      store.apply({ type: 'end', id }, 'local')
    }
    line('near', [[0.5, 0.5], [0.5001, 0.5]])
    line('far', [[0.1, 0.1], [0.1001, 0.1]])
    line('dot', [[0.50005, 0.500005]])
    expect(index.search(box(0.50005, 0.5, 1e-5)).sort()).toEqual(['dot', 'near'])

    // A stroke that grows is refiled under its new bounds
    store.apply({ type: 'points', id: 'far', pts: [[0.5, 0.5]] }, 'remote')
    expect(index.search(box(0.5, 0.5, 1e-6)).sort()).toEqual(['far', 'near'])

    store.apply({ type: 'remove', id: 'near' }, 'local')
    expect(index.search(box(0.5, 0.5, 1e-6))).toEqual(['far'])
    index.destroy()
  })
})

describe('StrokeIndex.maxWidthMercator', () => {
  it('follows the widest stroke still indexed, and counts a refiled stroke once', () => {
    const store = new StrokeStore({ order: 'custom' })
    const index = new StrokeIndex(store)
    const line = (id: string, width: number): void => {
      store.apply({ type: 'begin', id, author: 'a', color: '#000000', width, zoom: 14 }, 'local')
      store.apply({ type: 'points', id, pts: [[0.5, 0.5]] }, 'local')
      store.apply({ type: 'end', id }, 'local')
    }
    line('thin', 2)
    line('wide', 16)
    const perPixel = mercatorPerPixelAt(14)
    expect(index.maxWidthMercator).toBeCloseTo(16 * perPixel)
    // Refiled on more points: still one stroke, so erasing it once takes its width away
    store.apply({ type: 'points', id: 'wide', pts: [[0.6, 0.6]] }, 'remote')
    store.apply({ type: 'remove', id: 'wide' }, 'local')
    expect(index.maxWidthMercator).toBeCloseTo(2 * perPixel)
    store.apply({ type: 'remove', id: 'thin' }, 'local')
    expect(index.maxWidthMercator).toBe(0)
    line('again', 4)
    store.apply({ type: 'reset', strokes: [] }, 'remote')
    expect(index.maxWidthMercator).toBe(0)
    index.destroy()
  })
})
