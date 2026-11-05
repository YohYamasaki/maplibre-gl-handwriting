// Lasso and tap selection, and moving, scaling and rotating the selection
import { describe, expect, it } from 'vitest'
import { bucketOf, tileKey } from '../src/core/bucket'
import { StrokeStore, type Point, type StrokeData } from '../src/core/stroke'
import {
  applyToPoint,
  compose,
  inverse,
  isSimilarity,
  similarityAbout,
  transformStroke,
  type Matrix,
} from '../src/core/transform'
import { mercatorPerPixelAt } from '../src/mercator'
import { strokesInLasso, topmostStrokeAt } from '../src/lasso'
import {
  cornerCursor,
  dragTransform,
  gripAt,
  gripCursor,
  rotateHandle,
  SelectController,
} from '../src/SelectController'
import { Selection } from '../src/Selection'
import { deleteSelected, duplicateSelected, exportGeoJSON } from '../src/selectionActions'
import { StrokeIndex } from '../src/StrokeIndex'
import { StrokeScene, tileLocal } from '../src/StrokeScene'
import { UndoHistory } from '../src/UndoHistory'
import { expectConsistentScene, expectValidDraws } from './invariants'
import { DeferredBuilds, fakeWriter, pairs, xy } from './support'

const PX = 1e-6

/** A saved horizontal stroke of `n` points from `from`, 1px apart */
function line(id: string, from: Point, n: number, order: number, color = '#000000'): StrokeData {
  return {
    id,
    author: 'a',
    color,
    width: 2,
    zoom: 12,
    points: xy(Array.from({ length: n }, (_, i): Point => [from[0] + i * PX, from[1]])),
    order,
  }
}

/** Whether two lists of points, as [x, y] pairs or x and y in turn, are the same within `tolerance` */
function closeTo(first: Point[] | Float64Array | null, second: Point[] | Float64Array | null, tolerance: number): void {
  const [a, b] = [first, second].map((points) => (Array.isArray(points) ? points : pairs(points)))
  expect(a).toHaveLength(b.length)
  a.forEach((p, i) => {
    expect(Math.abs(p[0] - b[i][0])).toBeLessThan(tolerance)
    expect(Math.abs(p[1] - b[i][1])).toBeLessThan(tolerance)
  })
}

describe('transform math', () => {
  it('a transform then its inverse puts the points back within 1e-12', () => {
    const m = similarityAbout([0.3, 0.6], 3.7, 1.1, [0.01, -0.02])
    const points: Point[] = [
      [0.31, 0.61],
      [0.3001, 0.5999],
      [0.2999, 0.6002],
    ]
    const back = points.map((p) => applyToPoint(inverse(m), applyToPoint(m, p)))
    closeTo(back, points, 1e-12)
    expect(compose(inverse(m), m).every((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) < 1e-12)).toBe(true)
  })

  it('scaling changes the drawing zoom by log2 of the scale and keeps the width', () => {
    const stroke = line('s', [0.5, 0.5], 3, 1)
    const moved = transformStroke(stroke, similarityAbout([0.5, 0.5], 4, 0))!
    expect(moved.zoom).toBeCloseTo(10, 12)
    const shrunk = transformStroke(stroke, similarityAbout([0.5, 0.5], 0.5, 0))!
    expect(shrunk.zoom).toBeCloseTo(13, 12)
  })

  it('refuses a stroke the transform would take off the map, and a matrix that is not a similarity', () => {
    expect(transformStroke(line('s', [0.9, 0.5], 3, 1), [1, 0, 0, 1, 0.2, 0])).toBeNull()
    expect(isSimilarity([2, 0, 0, 1, 0, 0])).toBe(false)
    expect(isSimilarity([0, 1, -1, 0, 0.1, 0])).toBe(true)
  })
})

describe('StrokeStore transform op', () => {
  it('moves only saved strokes, passes on only the ones it changed, and its inverse puts them back', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('a', [0.5, 0.5], 4, 1), line('b', [0.99, 0.5], 4, 2)] }, 'remote')
    store.apply({ type: 'begin', id: 'draft', author: 'a', color: '#000000', width: 2, zoom: 12 }, 'local')
    store.apply({ type: 'points', id: 'draft', pts: Float64Array.of(0.5, 0.5) }, 'local')
    const before = structuredClone(store.get('a')!.points)
    const seen: string[][] = []
    store.subscribe((op) => {
      if (op.type === 'transform') seen.push(op.ids)
    })
    const m: Matrix = [1, 0, 0, 1, 0.02, 0]
    expect(store.apply({ type: 'transform', ids: ['a', 'b', 'draft', 'missing'], matrix: m }, 'local')).toBe(true)
    // b would leave the map; the draft is not saved
    expect(seen).toEqual([['a']])
    expect(store.get('draft')!.points).toEqual(Float64Array.of(0.5, 0.5))
    store.apply({ type: 'transform', ids: ['a'], matrix: inverse(m) }, 'local')
    closeTo(store.get('a')!.points!, before, 1e-12)
    expect(store.apply({ type: 'transform', ids: ['a'], matrix: [2, 0, 0, 1, 0, 0] }, 'local')).toBe(false)
  })

  it('undo applies the inverse and redo the transform again', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('a', [0.5, 0.5], 4, 1)] }, 'remote')
    const before = structuredClone(store.get('a')!)
    const history = new UndoHistory(store, 10)
    const m = similarityAbout([0.5, 0.5], 2, 0.3)
    store.apply({ type: 'transform', ids: ['a'], matrix: m }, 'local')
    history.record({ type: 'transform', ids: ['a'], matrix: m })
    history.undo()
    closeTo(store.get('a')!.points!, before.points, 1e-12)
    expect(store.get('a')!.zoom).toBeCloseTo(before.zoom, 12)
    history.redo()
    expect(store.get('a')!.zoom).toBeCloseTo(before.zoom - 1, 12)
  })
})

describe('transforms at the edges of the range', () => {
  it('a transform then its inverse brings back a stroke at zoom 24 despite rounding, and undo can do it', () => {
    const m = similarityAbout([0.5, 0.5], 1 + 382 / 1000, 0)
    const stroke = { points: Float64Array.of(0.5, 0.5), zoom: 24 }
    const there = transformStroke(stroke, m)!
    const back = transformStroke(there, inverse(m))
    expect(back).not.toBeNull()
    expect(back!.zoom).toBe(24)
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [{ ...line('a', [0.5, 0.5], 1, 1), zoom: 24 }] }, 'remote')
    const history = new UndoHistory(store, 10)
    store.apply({ type: 'transform', ids: ['a'], matrix: m }, 'local')
    history.record({ type: 'transform', ids: ['a'], matrix: m })
    history.undo()
    expect(store.get('a')!.zoom).toBe(24)
    history.redo()
    expect(store.get('a')!.zoom).toBeCloseTo(there.zoom, 12)
  })

  it('keeps the edge of the map and still refuses a stroke clearly past it', () => {
    const m: Matrix = [1, 0, 0, 1, 0.3, 0]
    const back = transformStroke(transformStroke({ points: Float64Array.of(0.7, 0.5), zoom: 12 }, m)!, inverse(m))
    expect(back).not.toBeNull()
    expect(transformStroke({ points: Float64Array.of(1, 0.5), zoom: 12 }, [1, 0, 0, 1, 1e-9, 0])).toBeNull()
  })

  it('an undo or redo of a transform that moves none of its strokes stays where it was', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('a', [0.5, 0.5], 1, 1)] }, 'remote')
    const history = new UndoHistory(store, 10)
    const m: Matrix = [1, 0, 0, 1, 0.1, 0]
    store.apply({ type: 'transform', ids: ['a'], matrix: m }, 'local')
    history.record({ type: 'transform', ids: ['a'], matrix: m })
    // Someone else moves it to x = 0.05, where the inverse would leave the map
    store.apply({ type: 'replace', strokes: [line('a', [0.05, 0.5], 1, 1)] }, 'remote')
    history.undo()
    expect(store.get('a')!.points![0]).toBe(0.05)
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
    // Moved back within reach, the undo applies
    store.apply({ type: 'replace', strokes: [line('a', [0.6, 0.5], 1, 1)] }, 'remote')
    history.undo()
    expect(store.get('a')!.points![0]).toBeCloseTo(0.5, 12)
    expect(history.canRedo).toBe(true)
    // Same for redo
    store.apply({ type: 'replace', strokes: [line('a', [0.95, 0.5], 1, 1)] }, 'remote')
    history.redo()
    expect(store.get('a')!.points![0]).toBe(0.95)
    expect(history.canRedo).toBe(true)
    expect(history.canUndo).toBe(false)
    // A transform none of whose strokes is held any more is dropped
    store.apply({ type: 'remove', id: 'a' }, 'remote')
    history.redo()
    expect(history.canRedo).toBe(false)
  })

  it('undo of a transform that can no longer move a stroke does not redo it on that stroke', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('a', [0.5, 0.5], 2, 1), line('b', [0.6, 0.5], 2, 2)] }, 'remote')
    const history = new UndoHistory(store, 10)
    const m: Matrix = [1, 0, 0, 1, 0.01, 0]
    store.apply({ type: 'transform', ids: ['a', 'b'], matrix: m }, 'local')
    history.record({ type: 'transform', ids: ['a', 'b'], matrix: m })
    // Someone else erases b meanwhile
    store.apply({ type: 'remove', id: 'b' }, 'remote')
    history.undo()
    store.apply({ type: 'load', strokes: [line('b', [0.7, 0.5], 2, 2)] }, 'remote')
    history.redo()
    expect(store.get('b')!.points![0]).toBe(0.7)
    expect(store.get('a')!.points![0]).toBeCloseTo(0.51, 12)
  })
})

describe('Selection frame', () => {
  it('Delete of many selected strokes measures none of the strokes left, with the frame asked for after each', () => {
    const store = new StrokeStore({ order: 'custom' })
    const strokes = Array.from({ length: 200 }, (_, i) => line(`s${i}`, [0.5, 0.5 + i * PX], 50, i + 1))
    store.apply({ type: 'load', strokes }, 'remote')
    const selection = new Selection(store)
    selection.set(strokes.map((s) => s.id))
    // The frame on screen asks for the corners on every change
    selection.subscribe(() => selection.frame())
    let gets = 0
    const get = store.get.bind(store)
    store.get = (id: string): StrokeData | undefined => {
      gets++
      return get(id)
    }
    deleteSelected(store, selection)
    expect(selection.size).toBe(0)
    // deleteSelected reads each stroke a few times itself; measuring the rest per stroke would be 200 * 199 / 2
    expect(gets).toBeLessThan(4 * strokes.length)
  })

  it('a frame fitted after a whole move and then a removal surrounds the strokes where they are', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('a', [0.5, 0.5], 3, 1), line('b', [0.6, 0.5], 3, 2)] }, 'remote')
    const selection = new Selection(store)
    selection.set(['a', 'b'])
    store.apply({ type: 'transform', ids: ['a', 'b'], matrix: [1, 0, 0, 1, 0.1, 0] }, 'local')
    store.apply({ type: 'remove', id: 'b' }, 'remote')
    const xs = selection.frame()!.map(([x]) => x)
    expect(Math.min(...xs)).toBeGreaterThan(0.59)
    expect(Math.max(...xs)).toBeLessThan(0.61)
  })

  it('fits the strokes again when a transform moved only some of the selection', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('a', [0.5, 0.5], 3, 1), line('b', [0.9, 0.5], 3, 2)] }, 'remote')
    const selection = new Selection(store)
    selection.set(['a', 'b'])
    // b would leave the map, so it stays
    store.apply({ type: 'transform', ids: ['a', 'b'], matrix: [1, 0, 0, 1, 0.45, 0] }, 'local')
    expect(store.get('b')!.points![0]).toBe(0.9)
    const xs = selection.frame()!.map(([x]) => x)
    expect(Math.min(...xs)).toBeLessThan(0.951)
    expect(Math.max(...xs)).toBeLessThan(0.96)
  })

  it("fits the strokes again on the server's copies, and when a selected stroke is removed", () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('a', [0.5, 0.5], 3, 1), line('b', [0.9, 0.5], 3, 2)] }, 'remote')
    const selection = new Selection(store)
    selection.set(['a', 'b'])
    store.apply({ type: 'remove', id: 'b' }, 'remote')
    expect(Math.max(...selection.frame()!.map(([x]) => x))).toBeLessThan(0.51)
    store.apply({ type: 'replace', strokes: [line('a', [0.3, 0.5], 3, 1)] }, 'remote')
    expect(Math.max(...selection.frame()!.map(([x]) => x))).toBeLessThan(0.31)
  })

  it('a whole move still carries the frame, rotated with it', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('a', [0.5, 0.5], 3, 1)] }, 'remote')
    const selection = new Selection(store)
    selection.set(['a'])
    const before = selection.frame()!
    const m = similarityAbout([0.5, 0.5], 1, 0.5)
    store.apply({ type: 'transform', ids: ['a'], matrix: m }, 'local')
    closeTo(
      selection.frame()!,
      before.map((p) => applyToPoint(m, p)),
      1e-15,
    )
  })
})

describe('StrokeStore replace', () => {
  it("takes the server's points and zoom for saved strokes held, and skips the same, the unsaved and the missing", () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('a', [0.5, 0.5], 3, 1), line('b', [0.5, 0.6], 3, 2)] }, 'remote')
    const seen: string[][] = []
    store.subscribe((op) => {
      if (op.type === 'replace') seen.push(op.strokes.map((s) => s.id))
    })
    const a = store.get('a')!
    const moved = { ...line('a', [0.4, 0.5], 3, 1), zoom: 11 }
    expect(
      store.apply(
        { type: 'replace', strokes: [moved, line('b', [0.5, 0.6], 3, 2), line('c', [0, 0], 3, 3)] },
        'remote',
      ),
    ).toBe(true)
    expect(seen).toEqual([['a']])
    expect(store.get('a')).toBe(a)
    expect(a.points).toEqual(moved.points)
    expect(a.points).not.toBe(moved.points)
    expect(a.zoom).toBe(11)
    expect(store.apply({ type: 'replace', strokes: [moved] }, 'remote')).toBe(false)
  })
})

describe('lasso and tap', () => {
  it('a lasso selects the saved strokes with at least half of their points inside', () => {
    const store = new StrokeStore({ order: 'custom' })
    // 10 points from x = 0.5: the lasso up to x = 0.5 + 4.5px holds 5 of them, up to 3.5px holds 4
    store.apply({ type: 'load', strokes: [line('half', [0.5, 0.5], 10, 1), line('far', [0.6, 0.6], 3, 2)] }, 'remote')
    store.apply({ type: 'begin', id: 'draft', author: 'a', color: '#000000', width: 2, zoom: 12 }, 'local')
    store.apply({ type: 'points', id: 'draft', pts: Float64Array.of(0.5 + PX, 0.5) }, 'local')
    store.apply({ type: 'end', id: 'draft' }, 'local')
    const index = new StrokeIndex(store)
    const box = (right: number): Point[] => [
      [0.5 - PX, 0.5 - PX],
      [0.5 + right * PX, 0.5 - PX],
      [0.5 + right * PX, 0.5 + PX],
      [0.5 - PX, 0.5 + PX],
    ]
    expect(strokesInLasso(index, store, box(4.5))).toEqual(['half'])
    expect(strokesInLasso(index, store, box(3.5))).toEqual([])
  })

  it('a tap picks the topmost stroke under it', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('top', [0.5, 0.5], 5, 9), line('under', [0.5, 0.5], 5, 3)] }, 'remote')
    const index = new StrokeIndex(store)
    const reach = (): number => 3 * PX
    expect(topmostStrokeAt(index, store, [0.5 + 2 * PX, 0.5 + PX], reach, 3 * PX)).toBe('top')
    expect(topmostStrokeAt(index, store, [0.5, 0.6], reach, 3 * PX)).toBeNull()
  })
})

describe('SelectController', () => {
  function setup(): {
    store: StrokeStore
    selection: Selection
    history: UndoHistory
    pointer: (type: string, x: number, y: number) => void
    cursors: string[]
    select: SelectController
  } {
    const store = new StrokeStore({ order: 'custom' })
    // Client (x, y) is [0.5 + x px, 0.5 + y px]
    store.apply({ type: 'load', strokes: [line('a', [0.5 + 10 * PX, 0.5 + 10 * PX], 41, 1)] }, 'remote')
    const index = new StrokeIndex(store)
    const selection = new Selection(store)
    const history = new UndoHistory(store, 10)
    const element = Object.assign(new EventTarget(), { setPointerCapture: (): void => {} }) as unknown as HTMLElement
    const cursors: string[] = []
    const select = new SelectController(
      element,
      store,
      (x, y) => [0.5 + x * PX, 0.5 + y * PX],
      ([x, y]) => [(x - 0.5) / PX, (y - 0.5) / PX],
      index,
      selection,
      {
        isEnabled: () => true,
        pixelSize: () => PX,
        onLasso: () => {},
        onTransform: (ids, matrix) => history.record({ type: 'transform', ids, matrix }),
        onCursor: (cursor) => void cursors.push(cursor),
      },
    )
    select.enable()
    const pointer = (type: string, x: number, y: number): void =>
      void element.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, button: 0, clientX: x, clientY: y }))
    return { store, selection, history, pointer, cursors, select }
  }

  /** Selects the stroke with a lasso around it; its frame is then about x 10..50, y 9..11 */
  function selectAll(pointer: (type: string, x: number, y: number) => void): void {
    pointer('pointerdown', 0, 0)
    for (const [x, y] of [
      [70, 0],
      [70, 20],
      [0, 20],
    ])
      pointer('pointermove', x, y)
    pointer('pointerup', 0, 20)
  }

  it('gives the cursor of what the pointer is over, and takes the drag cursor away when the drag is cancelled', () => {
    const { selection, pointer, cursors } = setup()
    selectAll(pointer)
    expect(selection.size).toBe(1)
    const corners = selection.frame()!.map(([x, y]) => [(x - 0.5) / PX, (y - 0.5) / PX] as [number, number])
    const [hx, hy] = rotateHandle(corners)
    pointer('pointermove', hx, hy)
    expect(cursors.at(-1)).toBe('grab')
    pointer('pointerdown', hx, hy)
    expect(cursors.at(-1)).toBe('grabbing')
    pointer('pointermove', hx + 20, hy + 5)
    pointer('pointercancel', hx + 20, hy + 5)
    // The frame is back where it was, and the pointer is off it
    expect(cursors.at(-1)).toBe('default')
  })

  it('updates the cursor of a pointer at rest when the selection under it goes away', () => {
    const { store, selection, pointer, cursors } = setup()
    selectAll(pointer)
    pointer('pointermove', 30, 10)
    expect(cursors.at(-1)).toBe('move')
    // As Esc does
    selection.clear()
    expect(cursors.at(-1)).toBe('default')
    // A pointer that left is not followed
    selectAll(pointer)
    pointer('pointermove', 30, 10)
    pointer('pointerleave', 30, 10)
    const count = cursors.length
    selection.clear()
    expect(cursors.length).toBe(count)
    // As Delete does
    selectAll(pointer)
    pointer('pointermove', 30, 10)
    expect(cursors.at(-1)).toBe('move')
    deleteSelected(store, selection)
    expect(cursors.at(-1)).toBe('default')
  })

  it('gives the cursor again when asked, as the map moves the frame, but not during a drag', () => {
    const { selection, pointer, cursors, select } = setup()
    selectAll(pointer)
    pointer('pointermove', 30, 10)
    expect(cursors.at(-1)).toBe('move')
    selection.clear()
    select.updateCursor()
    expect(cursors.at(-1)).toBe('default')
    pointer('pointerdown', 100, 100)
    const count = cursors.length
    select.updateCursor()
    expect(cursors.length).toBe(count)
  })

  it('selects by lasso, moves the selection by dragging inside the frame, and records it for undo', () => {
    const { store, selection, history, pointer } = setup()
    pointer('pointerdown', 0, 0)
    for (const [x, y] of [
      [70, 0],
      [70, 20],
      [0, 20],
    ])
      pointer('pointermove', x, y)
    pointer('pointerup', 0, 20)
    expect([...selection.ids]).toEqual(['a'])
    const before = structuredClone(store.get('a')!.points)
    // The middle of the frame, away from its handles
    pointer('pointerdown', 30, 10)
    pointer('pointermove', 40, 15)
    // While dragging only the drag transform changes
    expect(store.get('a')!.points).toEqual(before)
    expect(selection.drag[4]).toBeCloseTo(10 * PX, 15)
    pointer('pointerup', 40, 15)
    expect(store.get('a')!.points![0]).toBeCloseTo(before![0] + 10 * PX, 15)
    expect(selection.drag).toEqual([1, 0, 0, 1, 0, 0])
    expect(history.canUndo).toBe(true)
    history.undo()
    closeTo(store.get('a')!.points!, before, 1e-12)
  })

  it('a tap on a stroke selects it, and a tap on nothing clears the selection', () => {
    const { selection, pointer } = setup()
    pointer('pointerdown', 15, 10)
    pointer('pointerup', 15, 10)
    expect([...selection.ids]).toEqual(['a'])
    pointer('pointerdown', 200, 200)
    pointer('pointerup', 200, 200)
    expect(selection.size).toBe(0)
  })
})

describe('frame grips and drag transforms', () => {
  const corners: [number, number][] = [
    [0, 0],
    [100, 0],
    [100, 50],
    [0, 50],
  ]
  it('finds the rotate handle, the corners and the inside', () => {
    expect(gripAt(corners, [50, -28])).toEqual({ kind: 'rotate' })
    expect(gripAt(corners, [101, 49])).toEqual({ kind: 'scale', corner: 2 })
    expect(gripAt(corners, [50, 25])).toEqual({ kind: 'move' })
    expect(gripAt(corners, [300, 300])).toBeNull()
  })

  it('scales about the opposite corner and rotates about the center', () => {
    const m = dragTransform({ kind: 'scale', corner: 2 }, corners, [100, 50], [200, 100])
    expect(applyToPoint(m, [0, 0])).toEqual([0, 0])
    expect(applyToPoint(m, [100, 50])).toEqual([200, 100])
    const r = dragTransform({ kind: 'rotate' }, corners, [50, -10], [110, 25])
    const c = applyToPoint(r, [50, 25])
    expect(c[0]).toBeCloseTo(50, 12)
    expect(c[1]).toBeCloseTo(25, 12)
  })
})

describe('selection bar actions', () => {
  it('Delete removes the selected strokes, Duplicate draws copies under new identities in drawing order', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('b', [0.5, 0.5], 3, 2), line('a', [0.5, 0.6], 3, 1)] }, 'remote')
    const selection = new Selection(store)
    selection.set(['a', 'b'])
    let next = 0
    const copies = duplicateSelected(store, selection, () => ({ id: `new:${++next}`, author: 'me' }), 16 * PX)
    expect(copies.map((s) => s.id)).toEqual(['new:1', 'new:2'])
    expect(copies[0].points![0]).toBeCloseTo(0.5 + 16 * PX, 15)
    expect(copies[0].author).toBe('me')
    expect(store.get('new:2')!.points![1]).toBeCloseTo(0.5 + 16 * PX, 15)
    const removed = deleteSelected(store, selection)
    expect(removed.map((s) => s.id)).toEqual(['a', 'b'])
    expect(store.get('a')).toBeUndefined()
    expect(selection.size).toBe(0)
  })
})

describe('Export of the selection', () => {
  type Collection = { features: { geometry: { coordinates: number[][] }; properties: { id: string } }[] }

  it('exports only the selected strokes', async () => {
    const store = new StrokeStore({ order: 'custom' })
    const strokes = [line('a', [0.5, 0.5], 3, 1), line('b', [0.5, 0.6], 3, 2), line('c', [0.5, 0.7], 3, 3)]
    store.apply({ type: 'load', strokes }, 'remote')
    const selection = new Selection(store)
    selection.set(['c', 'a'])
    const out = JSON.parse(await exportGeoJSON(store, selection.ids)) as Collection
    expect(out.features.map((f) => f.properties.id)).toEqual(['a', 'c'])
  })

  it('skips IDs not in the store and strokes not saved yet', async () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('a', [0.5, 0.5], 3, 1)] }, 'remote')
    store.apply({ type: 'begin', id: 'draft', author: 'a', color: '#000000', width: 2, zoom: 12 }, 'local')
    store.apply(
      {
        type: 'points',
        id: 'draft',
        pts: Float64Array.of(0.5, 0.5, 0.6, 0.5),
      },
      'local',
    )
    store.apply({ type: 'end', id: 'draft' }, 'local')
    const out = JSON.parse(await exportGeoJSON(store, ['missing', 'draft', 'a'])) as Collection
    expect(out.features.map((f) => f.properties.id)).toEqual(['a'])
  })

  it('exports the coordinates after a transform', async () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [line('a', [0.5, 0.5], 3, 1)] }, 'remote')
    const selection = new Selection(store)
    selection.set(['a'])
    // Moves the stroke by 1/360 of the world to the east: 1 degree of longitude
    store.apply({ type: 'transform', ids: ['a'], matrix: [1, 0, 0, 1, 1 / 360, 0] }, 'local')
    const out = JSON.parse(await exportGeoJSON(store, selection.ids)) as Collection
    const [lng, lat] = out.features[0].geometry.coordinates[0]
    expect(lng).toBeCloseTo(1, 9)
    expect(lat).toBeCloseTo(0, 9)
  })
})

describe('StrokeScene with a selection', () => {
  const view = { minX: 0.5 - 500 * PX, maxX: 0.5 + 500 * PX, minY: 0.5 - 350 * PX, maxY: 0.5 + 350 * PX }
  const zoom = Math.log2(1 / (512 * PX))

  function setup(): { store: StrokeStore; scene: StrokeScene; selection: Selection; builds: DeferredBuilds } {
    const store = new StrokeStore({ order: 'custom' })
    store.apply(
      {
        type: 'load',
        strokes: [
          line('a', [0.5, 0.5], 20, 1),
          line('b', [0.5, 0.5001], 20, 2, '#33669980'),
          line('c', [0.5001, 0.5], 20, 3),
        ],
      },
      'remote',
    )
    const builds = new DeferredBuilds()
    const selection = new Selection(store)
    const scene = new StrokeScene(store, fakeWriter, builds, zoom, () => {}, selection)
    scene.frame(view, zoom)
    while (builds.pending.length > 0) scene.onBuilt(builds.deliver())
    scene.frame(view, zoom)
    return { store, scene, selection, builds }
  }

  it('tessellates the selection once: a drag changes only the transform of its draws', () => {
    const { scene, selection, builds } = setup()
    selection.set(['a', 'b'])
    while (builds.pending.length > 0) scene.onBuilt(builds.deliver())
    scene.frame(view, zoom)
    const before = scene.stats()
    for (let i = 1; i <= 20; i++) {
      selection.setDrag(similarityAbout([0.5, 0.5], 1 + i / 10, i / 10, [i * PX, 0]))
      const draws = scene.frame(view, zoom)
      const transformed = [...draws.opaque, ...draws.translucent].filter((d) => d.transform)
      expect(transformed.length).toBeGreaterThan(0)
    }
    const after = scene.stats()
    expect(after.builds).toBe(before.builds)
    expect(after.mainThreadVertices).toBe(before.mainThreadVertices)
    expect(scene.inspect().selected.size).toBe(2)
  })

  it('a committed move keeps the meshes, and deselecting files the strokes in the buckets their new place gives', () => {
    const { store, scene, selection, builds } = setup()
    selection.set(['a', 'b'])
    const vertices = scene.stats().mainThreadVertices
    const m: Matrix = [1, 0, 0, 1, 0.3, 0.1]
    selection.setDrag(m)
    selection.setDrag([1, 0, 0, 1, 0, 0])
    store.apply({ type: 'transform', ids: ['a', 'b'], matrix: m }, 'local')
    scene.frame(view, zoom)
    expect(scene.stats().mainThreadVertices).toBe(vertices)
    selection.clear()
    expectConsistentScene(store, scene, new Set())
    const a = store.get('a')!
    expect(scene.inspect().strokeBuckets.get('a')).toBe(tileKey(bucketOf([a.points![0], a.points![1]], a.zoom)))
    const moved = { minX: view.minX + 0.3, maxX: view.maxX + 0.3, minY: view.minY + 0.1, maxY: view.maxY + 0.1 }
    scene.frame(moved, zoom)
    while (builds.pending.length > 0) scene.onBuilt(builds.deliver())
    expectValidDraws(store, scene, scene.frame(moved, zoom), moved, zoom)
  })

  it('a scale re-tessellates the selection; a stroke moved by someone else is refiled', () => {
    const { store, scene, selection } = setup()
    selection.set(['a'])
    const vertices = scene.stats().mainThreadVertices
    store.apply({ type: 'transform', ids: ['a'], matrix: similarityAbout([0.5, 0.5], 2, 0) }, 'remote')
    expect(scene.stats().mainThreadVertices).toBeGreaterThan(vertices)
    store.apply({ type: 'transform', ids: ['c'], matrix: similarityAbout([0.5, 0.5], 1 / 1024, 0) }, 'remote')
    selection.clear()
    expectConsistentScene(store, scene, new Set())
  })

  it('Delete of a large selection tessellates nothing per stroke removed, and the next frame drops the meshes once', () => {
    const store = new StrokeStore({ order: 'custom' })
    const strokes = Array.from({ length: 200 }, (_, i) => line(`s${i}`, [0.5, 0.5 + i * 2 * PX], 5, i + 1))
    store.apply({ type: 'load', strokes }, 'remote')
    let appended = 0
    const writer = {
      ...fakeWriter,
      appendStroke: (...args: Parameters<typeof fakeWriter.appendStroke>): void => {
        appended++
        fakeWriter.appendStroke.apply(writer, args)
      },
    }
    const builds = new DeferredBuilds()
    const selection = new Selection(store)
    const scene = new StrokeScene(store, writer, builds, zoom, () => {}, selection)
    scene.frame(view, zoom)
    while (builds.pending.length > 0) scene.onBuilt(builds.deliver())
    selection.set(strokes.map((s) => s.id))
    scene.takeRetired()
    appended = 0
    deleteSelected(store, selection)
    expect(appended).toBe(0)
    expect(scene.takeRetired()).toEqual([])
    scene.frame(view, zoom)
    expect(appended).toBe(0)
    expect(scene.inspect().selectionMeshes).toEqual([])
    expect(scene.takeRetired().length).toBeGreaterThan(0)
    expectConsistentScene(store, scene, new Set())
  })

  it("a stroke the server's copy moved is refiled, and a selected one re-tessellated", () => {
    const { store, scene, selection } = setup()
    selection.set(['a'])
    const vertices = scene.stats().mainThreadVertices
    store.apply({ type: 'replace', strokes: [line('a', [0.6, 0.5], 20, 1)] }, 'remote')
    expect(scene.stats().mainThreadVertices).toBeGreaterThan(vertices)
    store.apply({ type: 'replace', strokes: [line('c', [0.6001, 0.5], 20, 3)] }, 'remote')
    expect(scene.inspect().strokeBuckets.get('c')).toBe(tileKey(bucketOf([0.6001, 0.5], 12)))
    selection.clear()
    expectConsistentScene(store, scene, new Set())
  })

  it('tileLocal turns a transform of Web Mercator coordinates into one of tile-local units', () => {
    const m = similarityAbout([0.51, 0.49], 1.5, 0.7, [0.001, -0.002])
    const tile = { z: 10, x: 522, y: 501 }
    const local = tileLocal(m, tile)
    const extent = 8192 * 2 ** tile.z
    const toLocal = ([x, y]: Point): Point => [(x - tile.x / 2 ** tile.z) * extent, (y - tile.y / 2 ** tile.z) * extent]
    const p: Point = [0.5101, 0.4899]
    const expected = toLocal(applyToPoint(m, p))
    const got = applyToPoint(local, toLocal(p))
    expect(got[0]).toBeCloseTo(expected[0], 3)
    expect(got[1]).toBeCloseTo(expected[1], 3)
    expect(mercatorPerPixelAt(zoom)).toBeCloseTo(PX, 15)
  })
})

describe('frame cursors', () => {
  // Top left, top right, bottom right, bottom left of a frame turned by `angle` about the origin
  const turned = (angle: number): [number, number][] =>
    (
      [
        [-50, -30],
        [50, -30],
        [50, 30],
        [-50, 30],
      ] as [number, number][]
    ).map(([x, y]) => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)])

  it('gives the corners the diagonal resize cursor nearest to their diagonal as the frame turns', () => {
    const upright = turned(0)
    expect([0, 1, 2, 3].map((corner) => cornerCursor(upright, corner))).toEqual([
      'nwse-resize',
      'nesw-resize',
      'nwse-resize',
      'nesw-resize',
    ])
    // A little turn keeps them; a quarter turn swaps them
    expect(cornerCursor(turned(0.3), 0)).toBe('nwse-resize')
    expect(cornerCursor(turned(-0.3), 1)).toBe('nesw-resize')
    expect([0, 1, 2, 3].map((corner) => cornerCursor(turned(Math.PI / 2), corner))).toEqual([
      'nesw-resize',
      'nwse-resize',
      'nesw-resize',
      'nwse-resize',
    ])
    expect(cornerCursor(turned(Math.PI), 0)).toBe('nwse-resize')
    expect(cornerCursor(turned(-Math.PI / 2 + 0.2), 0)).toBe('nesw-resize')
  })

  it('moves inside, grabs the rotate handle, grabbing while it turns, and the arrow off the frame', () => {
    const corners = turned(0)
    expect(gripCursor({ kind: 'move' }, corners, false)).toBe('move')
    expect(gripCursor({ kind: 'rotate' }, corners, false)).toBe('grab')
    expect(gripCursor({ kind: 'rotate' }, corners, true)).toBe('grabbing')
    expect(gripCursor({ kind: 'scale', corner: 1 }, corners, false)).toBe('nesw-resize')
    expect(gripCursor(null, corners, false)).toBe('default')
  })
})
