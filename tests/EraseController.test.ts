import { describe, expect, it } from 'vitest'
import { StrokeStore, type Origin, type StrokeData, type StrokeOp } from '../src/core/stroke'
import { EraseController } from '../src/EraseController'
import { StrokeIndex } from '../src/StrokeIndex'
import { UndoHistory, type Cut } from '../src/UndoHistory'

// One CSS px is 1e-6 in Web Mercator units, from [0.5, 0.5] at client (0, 0)
const PX = 1e-6

/** A saved horizontal stroke from client x 0 to 100, one point per px */
const line = (id: string): StrokeData => ({
  id,
  author: 'a',
  color: '#000000',
  width: 1,
  zoom: 12,
  points: Array.from({ length: 101 }, (_, i): [number, number] => [0.5 + i * PX, 0.5]),
  order: 1,
})

function setup(): {
  store: StrokeStore
  ops: [StrokeOp, Origin][]
  cuts: Cut[][]
  pointer: (type: string, x: number, y: number) => void
  erase: EraseController
  history: UndoHistory
} {
  const store = new StrokeStore({ order: 'custom' })
  store.apply({ type: 'load', strokes: [line('a:1')] }, 'remote')
  const index = new StrokeIndex(store)
  const element = Object.assign(new EventTarget(), { setPointerCapture: (): void => {} }) as unknown as HTMLElement
  const cuts: Cut[][] = []
  const history = new UndoHistory(store, 100, () => {})
  let next = 0
  const erase = new EraseController(element, store, (x, y) => [0.5 + x * PX, 0.5 + y * PX], index, {
    isEnabled: () => true,
    radius: () => 2,
    pixelSize: () => PX,
    mode: () => 'partial',
    newPieceId: () => `s:${++next}`,
    onErase: () => {},
    onCut: (made) => {
      cuts.push(made)
      history.record({ type: 'split', cuts: made })
    },
  })
  erase.enable()
  const ops: [StrokeOp, Origin][] = []
  store.subscribe((op, origin) => ops.push([op, origin]))
  const pointer = (type: string, x: number, y: number): void =>
    void element.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, button: 0, clientX: x, clientY: y }))
  return { store, ops, cuts, pointer, erase, history }
}

describe('EraseController partial', () => {
  it('shows its cuts on this screen only while the pointer is down, and makes one cut per stroke when lifted', () => {
    const { store, ops, cuts, pointer } = setup()
    // Two passes across the stroke, over many moves
    pointer('pointerdown', 30, -20)
    for (let y = -18; y <= 20; y += 2) pointer('pointermove', 30, y)
    pointer('pointermove', 70, 20)
    for (let y = 18; y >= -20; y -= 2) pointer('pointermove', 70, y)

    expect(ops.length).toBeGreaterThan(0)
    expect(ops.every(([, origin]) => origin === 'preview')).toBe(true)
    // What is shown: three parts of the stroke, in its place
    const shown = [...store.values()]
    expect(shown.map((stroke) => stroke.id).sort()).toEqual(['a:1~0', 'a:1~1', 'a:1~2'])
    expect(shown.every((stroke) => stroke.order === 1)).toBe(true)

    ops.length = 0
    pointer('pointerup', 70, -20)
    const local = ops.filter(([, origin]) => origin === 'local').map(([op]) => op)
    expect(local).toHaveLength(1)
    expect(local[0]).toMatchObject({ type: 'split', id: 'a:1', pieces: [{ id: 's:1' }, { id: 's:2' }, { id: 's:3' }] })
    expect([...store.values()].map((stroke) => stroke.id).sort()).toEqual(['s:1', 's:2', 's:3'])
    expect(cuts).toHaveLength(1)
    expect(cuts[0]).toHaveLength(1)
    expect(cuts[0][0].removed.points).toHaveLength(101)
    expect(cuts[0][0].pieces.map((piece) => piece.id)).toEqual(['s:1', 's:2', 's:3'])
  })

  it('removes a stroke nothing of which stays, as one local op', () => {
    const { store, ops, cuts, pointer } = setup()
    pointer('pointerdown', -10, 0)
    pointer('pointermove', 110, 0)
    pointer('pointerup', 110, 0)
    expect(ops.filter(([, origin]) => origin === 'local').map(([op]) => op)).toEqual([{ type: 'remove', id: 'a:1' }])
    expect([...store.values()]).toEqual([])
    expect(cuts[0][0].pieces).toEqual([])
  })

  it('undo during the press acts on the store as the history saw it, and the gesture cuts nothing it undid', () => {
    const { store, ops, pointer, erase, history } = setup()
    history.record({ type: 'draw', strokes: [store.get('a:1')!] })
    pointer('pointerdown', 30, -20)
    pointer('pointermove', 30, 20)
    // As createHandwriting's undo does
    erase.cancelCuts()
    history.undo()
    pointer('pointerup', 30, 20)
    const local = ops.filter(([, origin]) => origin === 'local').map(([op]) => op)
    expect(local).toEqual([{ type: 'remove', id: 'a:1' }])
    expect([...store.values()]).toEqual([])
    // Redo brings back the stroke whole
    erase.cancelCuts()
    history.redo()
    expect([...store.values()].map((stroke) => stroke.points.length)).toEqual([101])
  })

  it('hides a stroke being cut again when it comes back during the press, and shows its pieces again after a reset', async () => {
    const { store, pointer } = setup()
    pointer('pointerdown', 30, -20)
    pointer('pointermove', 30, 20)
    const shown = (): string[] => [...store.values()].map((stroke) => stroke.id).sort()
    expect(shown()).toEqual(['a:1~0', 'a:1~1'])
    // Its tile is loaded again
    store.apply({ type: 'load', strokes: [line('a:1')] }, 'remote')
    await Promise.resolve()
    expect(shown()).toEqual(['a:1~0', 'a:1~1'])
    pointer('pointermove', 30, 20)
    expect(shown()).toEqual(['a:1~0', 'a:1~1'])
    // A reconnect resets the store, and the tile comes back
    store.apply({ type: 'reset', strokes: [] }, 'remote')
    store.apply({ type: 'load', strokes: [line('a:1')] }, 'remote')
    await Promise.resolve()
    expect(shown()).toEqual(['a:1~0', 'a:1~1'])
    pointer('pointerup', 30, 20)
    expect(shown()).toEqual(['s:1', 's:2'])
  })

  it('cuts a stroke moved by someone else during the press where it is now, as the server does', async () => {
    const { store, pointer } = setup()
    pointer('pointerdown', 30, -20)
    pointer('pointermove', 30, 20)
    // The server's copy after someone moved it arrives while it is hidden (the sync layer loads it)
    const moved = { ...line('a:1'), points: line('a:1').points.map(([x, y]): [number, number] => [x + 0.01, y]) }
    store.apply({ type: 'load', strokes: [moved] }, 'remote')
    await Promise.resolve()
    pointer('pointerup', 30, 20)
    const pieces = [...store.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
    expect(pieces.map((s) => s.id)).toEqual(['s:1', 's:2'])
    // The server cuts its own (moved) copy at the same positions along the stroke
    for (const piece of pieces) expect(piece.points.every(([x]) => x >= 0.51 - 1e-12)).toBe(true)
  })
})
