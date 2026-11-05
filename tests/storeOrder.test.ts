// Decision 0091: who gives strokes their place in the drawing order. A default store numbers the strokes itself, so
// selection, transforms, cuts and Export work with no server; a custom store leaves it to the caller
import { describe, expect, it } from 'vitest'
import { MAX_ORDER, StrokeStore, type Origin, type Point, type StrokeData, type StrokeOp } from '../src/core/stroke'
import { EraseController } from '../src/EraseController'
import { strokesInLasso, topmostStrokeAt } from '../src/lasso'
import { Selection } from '../src/Selection'
import { deleteSelected, duplicateSelected, exportGeoJSON } from '../src/selectionActions'
import { StrokeIndex } from '../src/StrokeIndex'
import { UndoHistory } from '../src/UndoHistory'
import { xy } from './support'

// One CSS px is 1e-6 in Web Mercator units
const PX = 1e-6

/** Draws a horizontal stroke of `n` points from `from`, 1px apart, as begin, points and end */
function draw(store: StrokeStore, id: string, from: Point, n = 3, origin: Origin = 'local'): void {
  store.apply({ type: 'begin', id, author: 'a', color: '#000000', width: 2, zoom: 12 }, origin)
  if (n > 0)
    store.apply(
      { type: 'points', id, pts: xy(Array.from({ length: n }, (_, i): Point => [from[0] + i * PX, from[1]])) },
      origin,
    )
  store.apply({ type: 'end', id }, origin)
}

/** A finished stroke as handed to load, reset or restore */
function stroke(id: string, order?: number): StrokeData {
  return {
    id,
    author: 'a',
    color: '#000000',
    width: 2,
    zoom: 12,
    points: Float64Array.of(0.5, 0.5, 0.5 + PX, 0.5),
    ...(order === undefined ? {} : { order }),
  }
}

function recorded(store: StrokeStore): [StrokeOp, Origin][] {
  const ops: [StrokeOp, Origin][] = []
  store.subscribe((op, origin) => ops.push([op, origin]))
  return ops
}

const orders = (store: StrokeStore): Record<string, number | undefined> =>
  Object.fromEntries([...store.values()].map((s) => [s.id, s.order]))

describe('a default store', () => {
  it('is the default, and refuses an unknown mode', () => {
    const store = new StrokeStore()
    draw(store, 'a', [0.5, 0.5])
    expect(store.get('a')!.order).toBe(1)
    expect(() => new StrokeStore({ order: 'server' as 'custom' })).toThrow(RangeError)
  })

  it('gives a stroke the next order right after its end, by an order op with the same origin', () => {
    const store = new StrokeStore()
    const ops = recorded(store)
    draw(store, 'a', [0.5, 0.5])
    draw(store, 'b', [0.5, 0.6], 3, 'remote')
    expect(orders(store)).toEqual({ a: 1, b: 2 })
    expect(ops.filter(([op]) => op.type === 'end' || op.type === 'order')).toEqual([
      [{ type: 'end', id: 'a' }, 'local'],
      [{ type: 'order', id: 'a', order: 1 }, 'local'],
      [{ type: 'end', id: 'b' }, 'remote'],
      [{ type: 'order', id: 'b', order: 2 }, 'remote'],
    ])
  })

  it('gives no order to a stroke without points, nor again to one that has an order', () => {
    const store = new StrokeStore()
    draw(store, 'empty', [0.5, 0.5], 0)
    expect(store.get('empty')!.order).toBeUndefined()
    draw(store, 'a', [0.5, 0.5])
    // A second end, and an end after more points were drawn onto the stroke
    store.apply({ type: 'end', id: 'a' }, 'local')
    store.apply({ type: 'points', id: 'a', pts: Float64Array.of(0.6, 0.6) }, 'local')
    store.apply({ type: 'end', id: 'a' }, 'local')
    expect(store.get('a')!.order).toBe(1)
    // An end for strokes that came back by restore and by load
    store.apply({ type: 'remove', id: 'a' }, 'local')
    store.apply({ type: 'restore', stroke: stroke('a', 1) }, 'local')
    store.apply({ type: 'load', strokes: [stroke('l')] }, 'remote')
    store.apply({ type: 'end', id: 'a' }, 'local')
    store.apply({ type: 'end', id: 'l' }, 'remote')
    expect(orders(store)).toEqual({ empty: undefined, a: 1, l: 2 })
    draw(store, 'b', [0.5, 0.6])
    expect(store.get('b')!.order).toBe(3)
  })

  it('numbers loaded and reset strokes anew in the order the op lists them, from where the counter is', () => {
    const store = new StrokeStore()
    draw(store, 'a', [0.5, 0.5])
    store.apply({ type: 'load', strokes: [stroke('x', 9), stroke('y'), stroke('z', 3), stroke('a', 7)] }, 'remote')
    // a is already held, so the load leaves it as it is
    expect(orders(store)).toEqual({ a: 1, x: 2, y: 3, z: 4 })
    store.apply({ type: 'reset', strokes: [stroke('r', 1), stroke('q', 2)] }, 'remote')
    expect(orders(store)).toEqual({ r: 5, q: 6 })
  })

  it('never lowers the counter on reset, so restored strokes and new ones never share an order', () => {
    const store = new StrokeStore()
    const history = new UndoHistory(store, 10)
    draw(store, 'a', [0.5, 0.5])
    draw(store, 'b', [0.5, 0.6])
    history.record({ type: 'draw', strokes: [store.get('b')!] })
    history.undo()
    store.apply({ type: 'reset', strokes: [] }, 'remote')
    draw(store, 'c', [0.5, 0.7])
    history.redo()
    expect(orders(store)).toEqual({ c: 3, b: 2 })
  })

  it('lets a selection, a transform, Duplicate, Delete and Export act on strokes drawn with no server', () => {
    const store = new StrokeStore()
    draw(store, 'a', [0.5, 0.5], 10)
    draw(store, 'b', [0.5, 0.5], 10)
    const index = new StrokeIndex(store)
    const box: Point[] = [
      [0.5 - PX, 0.5 - PX],
      [0.5 + 20 * PX, 0.5 - PX],
      [0.5 + 20 * PX, 0.5 + PX],
      [0.5 - PX, 0.5 + PX],
    ]
    expect(strokesInLasso(index, store, box).sort()).toEqual(['a', 'b'])
    // b was drawn later, so it is on top
    expect(topmostStrokeAt(index, store, [0.5 + 2 * PX, 0.5], () => 3 * PX, 3 * PX)).toBe('b')
    const selection = new Selection(store)
    selection.set(['a'])
    expect(selection.size).toBe(1)
    expect(store.apply({ type: 'transform', ids: ['a'], matrix: [1, 0, 0, 1, 10 * PX, 0] }, 'local')).toBe(true)
    expect(store.get('a')!.points[0]).toBeCloseTo(0.5 + 10 * PX, 15)
    const copies = duplicateSelected(store, selection, () => ({ id: 'copy', author: 'me' }), 16 * PX)
    expect(copies.map((s) => [s.id, s.order])).toEqual([['copy', 3]])
    const geojson = JSON.parse(exportGeoJSON(store, ['a', 'b', 'copy'])) as {
      features: { properties: { id: string } }[]
    }
    expect(geojson.features.map((f) => f.properties.id)).toEqual(['a', 'b', 'copy'])
    expect(deleteSelected(store, selection).map((s) => s.id)).toEqual(['a'])
    expect(store.get('a')).toBeUndefined()
  })

  it('lets the partial eraser cut a stroke drawn with no server; the pieces keep its order', () => {
    const store = new StrokeStore()
    draw(store, 'a', [0.5, 0.5], 101)
    const index = new StrokeIndex(store)
    const element = Object.assign(new EventTarget(), { setPointerCapture: (): void => {} }) as unknown as HTMLElement
    let next = 0
    const erase = new EraseController(element, store, (x, y) => [0.5 + x * PX, 0.5 + y * PX], index, {
      isEnabled: () => true,
      radius: () => 2,
      pixelSize: () => PX,
      mode: () => 'partial',
      newPieceId: () => `p:${++next}`,
      onErase: () => {},
      onCut: () => {},
    })
    erase.enable()
    const pointer = (type: string, x: number, y: number): void =>
      void element.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, button: 0, clientX: x, clientY: y }))
    pointer('pointerdown', 50, -20)
    pointer('pointermove', 50, 20)
    pointer('pointerup', 50, 20)
    expect(orders(store)).toEqual({ 'p:1': 1, 'p:2': 1 })
  })
})

describe('the order of a stroke', () => {
  for (const mode of ['default', 'custom'] as const) {
    it(`is an integer from 1 to 2^32 - 1, and anything else is refused (${mode})`, () => {
      const store = new StrokeStore({ order: mode })
      store.apply({ type: 'begin', id: 'a', author: 'a', color: '#000000', width: 2, zoom: 12 }, 'local')
      for (const bad of [0, -1, 1.5, MAX_ORDER + 1, Number.NaN, Infinity]) {
        expect(store.apply({ type: 'order', id: 'a', order: bad }, 'remote')).toBe(false)
      }
      expect(store.get('a')!.order).toBeUndefined()
      expect(store.apply({ type: 'order', id: 'a', order: MAX_ORDER }, 'remote')).toBe(true)
      expect(MAX_ORDER).toBe(2 ** 32 - 1)

      expect(store.apply({ type: 'restore', stroke: stroke('r', 0) }, 'local')).toBe(false)
      expect(store.apply({ type: 'load', strokes: [stroke('bad', 2 ** 32), stroke('l', 5)] }, 'remote')).toBe(true)
      expect(store.get('bad')).toBeUndefined()
      expect(store.apply({ type: 'load', strokes: [stroke('bad', -3)] }, 'remote')).toBe(false)
      store.apply({ type: 'reset', strokes: [stroke('ok', 4), stroke('bad', 0.5)] }, 'remote')
      expect([...store.values()].map((s) => s.id)).toEqual(['ok'])
    })
  }
})

describe('a custom store', () => {
  it('gives no order itself and keeps the orders it is handed', () => {
    const store = new StrokeStore({ order: 'custom' })
    draw(store, 'a', [0.5, 0.5])
    expect(store.get('a')!.order).toBeUndefined()
    store.apply({ type: 'load', strokes: [stroke('x', 9), stroke('y')] }, 'remote')
    store.apply({ type: 'order', id: 'a', order: 12 }, 'remote')
    expect(orders(store)).toEqual({ a: 12, x: 9, y: undefined })
    store.apply({ type: 'reset', strokes: [stroke('r', 40)] }, 'remote')
    expect(orders(store)).toEqual({ r: 40 })
  })
})
