import { describe, expect, it } from 'vitest'
import { cutStroke, piecePoints, validPieces, type EraserSweep } from '../src/core/split'
import { StrokeStore, type Point, type StrokeData } from '../src/core/stroke'
import { UndoHistory } from '../src/UndoHistory'

// A straight stroke along x from 0 to 10, one point per unit
const line: Point[] = Array.from({ length: 11 }, (_, i): Point => [i, 0])
const at = (x: number, y = 0, radius = 1): EraserSweep => ({ from: [x, y], to: [x, y], radius })

function saved(id: string, points: Point[] = line, pressure?: number[]): StrokeData {
  const stroke: StrokeData = { id, author: 'a', color: '#000000', width: 1, zoom: 12, points, order: 5 }
  if (pressure) stroke.pressure = pressure
  return stroke
}

describe('cutStroke', () => {
  it('returns null when the eraser does not reach the stroke', () => {
    expect(cutStroke(line, [at(5, 3)], 0)).toBeNull()
  })

  it('cuts the middle out, leaving the two ends', () => {
    const pieces = cutStroke(line, [at(5)], 0)!
    expect(pieces).toHaveLength(2)
    expect(pieces[0].from).toBe(0)
    expect(pieces[0].to).toBeCloseTo(4)
    expect(pieces[1].from).toBeCloseTo(6)
    expect(pieces[1].to).toBe(10)
  })

  it('cuts an end off, leaving one piece', () => {
    const pieces = cutStroke(line, [at(0)], 0)!
    expect(pieces).toHaveLength(1)
    expect(pieces[0].from).toBeCloseTo(1)
    expect(pieces[0].to).toBe(10)
  })

  it('cuts between points, where the eraser meets a segment only off its ends', () => {
    // The eraser at x = 5.5, 0.4 from the line: it covers x from 5.2 to 5.8, inside one segment
    const pieces = cutStroke(line, [{ from: [5.5, 0.4], to: [5.5, 0.4], radius: 0.5 }], 0)!
    expect(pieces[0].to).toBeCloseTo(5.2)
    expect(pieces[1].from).toBeCloseTo(5.8)
  })

  it('returns an empty list when nothing stays', () => {
    expect(cutStroke(line, [{ from: [0, 0], to: [10, 0], radius: 1 }], 0)).toEqual([])
  })

  it('drops the parts shorter than minLength', () => {
    // Left: 0 to 1.5 (length 1.5), right: 3.5 to 10 (length 6.5)
    const pieces = cutStroke(line, [at(2.5)], 2)!
    expect(pieces).toHaveLength(1)
    expect(pieces[0].from).toBeCloseTo(3.5)
  })

  it('erases a dot whole or not at all', () => {
    expect(cutStroke([[0, 0]], [at(0.5)], 0)).toEqual([])
    expect(cutStroke([[0, 0]], [at(5)], 0)).toBeNull()
  })

  it('erases the whole capsule the eraser swept between two positions, not only the positions', () => {
    // A sweep across the line from (5, -3) to (5, 3): the positions themselves are far from it
    const pieces = cutStroke(line, [{ from: [5, -3], to: [5, 3], radius: 0.5 }], 0)!
    expect(pieces).toHaveLength(2)
    expect(pieces[0].to).toBeCloseTo(4.5)
    expect(pieces[1].from).toBeCloseTo(5.5)
  })

  it('merges the parts several sweeps erase', () => {
    const pieces = cutStroke(line, [at(3), at(4)], 0)!
    expect(pieces).toHaveLength(2)
    expect(pieces[0].to).toBeCloseTo(2)
    expect(pieces[1].from).toBeCloseTo(5)
  })
})

describe('piecePoints', () => {
  it('interpolates the cut points and their pressure, and keeps the points between them', () => {
    const pressure = line.map((_, i) => i / 10)
    const { points, pressure: ps } = piecePoints(saved('s', line, pressure), { from: 1.5, to: 3.25 })
    expect(points).toEqual([
      [1.5, 0],
      [2, 0],
      [3, 0],
      [3.25, 0],
    ])
    expect(ps![0]).toBeCloseTo(0.15)
    expect(ps!.slice(1, 3)).toEqual([0.2, 0.3])
    expect(ps![3]).toBeCloseTo(0.325)
  })

  it('gives no pressure for a stroke without', () => {
    expect(piecePoints(saved('s'), { from: 0, to: 2 }).pressure).toBeUndefined()
  })
})

describe('validPieces', () => {
  it('accepts pieces in order within the stroke', () => {
    expect(validPieces([{ from: 0, to: 2 }, { from: 3.5, to: 10 }], 11)).toBe(true)
  })

  it('rejects empty, empty-length, overlapping, out-of-range or non-finite pieces', () => {
    for (const bad of [
      [],
      [{ from: 2, to: 2 }],
      [{ from: 0, to: 4 }, { from: 3, to: 6 }],
      [{ from: -1, to: 2 }],
      [{ from: 0, to: 10.5 }],
      [{ from: 0, to: NaN }],
    ]) {
      expect(validPieces(bad, 11)).toBe(false)
    }
    expect(validPieces([{ from: 0, to: 0.5 }], 1)).toBe(false)
  })
})

describe('StrokeStore split', () => {
  it('replaces the stroke with its pieces, which keep its style and order', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [saved('s')] }, 'remote')
    const ok = store.apply({ type: 'split', id: 's', pieces: [{ id: 'p1', from: 0, to: 4 }, { id: 'p2', from: 6, to: 10 }] }, 'remote')
    expect(ok).toBe(true)
    expect(store.get('s')).toBeUndefined()
    expect(store.get('p1')).toMatchObject({ author: 'a', width: 1, zoom: 12, order: 5, points: line.slice(0, 5) })
    expect(store.get('p2')!.points).toEqual(line.slice(6))
  })

  it('rejects a split of a missing stroke, with bad pieces, or with piece IDs taken', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [saved('s'), saved('t')] }, 'remote')
    expect(store.apply({ type: 'split', id: 'x', pieces: [{ id: 'p', from: 0, to: 1 }] }, 'remote')).toBe(false)
    expect(store.apply({ type: 'split', id: 's', pieces: [{ id: 'p', from: 0, to: 11 }] }, 'remote')).toBe(false)
    expect(store.apply({ type: 'split', id: 's', pieces: [{ id: 't', from: 0, to: 1 }] }, 'remote')).toBe(false)
    expect(store.apply({ type: 'split', id: 's', pieces: [{ id: 's', from: 0, to: 1 }] }, 'remote')).toBe(false)
    const twice = [{ id: 'p', from: 0, to: 1 }, { id: 'p', from: 2, to: 3 }]
    expect(store.apply({ type: 'split', id: 's', pieces: twice }, 'remote')).toBe(false)
    expect(store.get('s')).toBeDefined()
    expect(store.get('p')).toBeUndefined()
  })
})

describe('UndoHistory with partial erases', () => {
  it('undoes a gesture whose cuts cut a piece again, latest first, and redoes it', () => {
    const store = new StrokeStore({ order: 'custom' })
    store.apply({ type: 'load', strokes: [saved('s')] }, 'remote')
    const history = new UndoHistory(store, 10)
    // The gesture cuts s into p1 and p2, then cuts p2 into p3, then erases p1 whole
    store.apply({ type: 'split', id: 's', pieces: [{ id: 'p1', from: 0, to: 4 }, { id: 'p2', from: 6, to: 10 }] }, 'local')
    const original = saved('s')
    const p1 = structuredClone(store.get('p1')!)
    const p2 = structuredClone(store.get('p2')!)
    store.apply({ type: 'split', id: 'p2', pieces: [{ id: 'p3', from: 2, to: 4 }] }, 'local')
    const p3 = structuredClone(store.get('p3')!)
    store.apply({ type: 'remove', id: 'p1' }, 'local')
    history.record({
      type: 'split',
      cuts: [
        { removed: original, pieces: [p1, p2] },
        { removed: p2, pieces: [p3] },
        { removed: p1, pieces: [] },
      ],
    })
    expect([...store.values()].map((stroke) => stroke.id)).toEqual(['p3'])

    history.undo()
    expect([...store.values()].map((stroke) => stroke.id)).toEqual(['s'])
    expect(store.get('s')!.points).toEqual(line)

    history.redo()
    expect([...store.values()].map((stroke) => stroke.id)).toEqual(['p3'])
    expect(store.get('p3')!.points).toEqual(p3.points)
  })
})
