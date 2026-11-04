import type { Map as MapLibreMap } from 'maplibre-gl'
import { describe, expect, it } from 'vitest'
import { registerDebugLayer } from '../src/debug'
import type { Handwriting } from '../src/index'
import type { StrokeLayer } from '../src/StrokeLayer'
import type { StrokeOp } from '../src/core/stroke'
import { BenchLayer } from '../dev/BenchLayer'

/** A map with only what show() reads: the view's bounds and zoom */
const map = {
  getBounds: () => ({
    getNorthWest: () => ({ lng: 139.7, lat: 35.7 }),
    getSouthEast: () => ({ lng: 139.8, lat: 35.6 }),
  }),
  getZoom: () => 12,
} as unknown as MapLibreMap

/** A handle whose layer is made when `load` is called, like createHandwriting's once the WebAssembly module loads */
function fakeHandwriting(): { create: () => Handwriting; layer: { wireframe: boolean }; load: () => Promise<void> } {
  const layer = { wireframe: false, setWireframe: (on: boolean): void => void (layer.wireframe = on) }
  let resolve = (): void => {}
  const loaded = new Promise<void>((r) => (resolve = r))
  const handle = {
    ready: loaded.then(() => registerDebugLayer(handle, layer as unknown as StrokeLayer)),
    destroy: (): void => registerDebugLayer(handle, null),
  } as unknown as Handwriting
  return {
    create: () => handle,
    layer,
    load: async (): Promise<void> => {
      resolve()
      await handle.ready
      await Promise.resolve()
    },
  }
}

describe('BenchLayer', () => {
  it('draws the generated strokes as wireframes when wireframe was on before they were generated', async () => {
    const fake = fakeHandwriting()
    const bench = new BenchLayer(map, () => {}, fake.create)
    bench.setWireframe(true)
    bench.show(10)
    expect([...bench.store.values()]).toHaveLength(10)
    await fake.load()
    expect(fake.layer.wireframe).toBe(true)
  })

  it('tells once the second handle has made its layer, so that Canvas2D can hide it before it is drawn', async () => {
    const fake = fakeHandwriting()
    let told = 0
    const bench = new BenchLayer(map, () => told++, fake.create)
    bench.show(10)
    expect(told).toBe(0)
    await fake.load()
    expect(told).toBe(1)
    bench.show(20)
    await fake.load()
    expect(told).toBe(1)
  })

  it('empties the store with reset and then adds the generated strokes with load', () => {
    const fake = fakeHandwriting()
    const bench = new BenchLayer(map, () => {}, fake.create)
    const ops: StrokeOp[] = []
    bench.store.subscribe((op) => void ops.push(op))
    bench.show(10)
    expect(ops.map((op) => op.type)).toEqual(['reset', 'load'])
    expect(ops[0]).toEqual({ type: 'reset', strokes: [] })
    expect(ops[1].type === 'load' && ops[1].strokes).toHaveLength(10)
  })

  it("replaces the last show's strokes with the new ones, though their IDs are the same", () => {
    const fake = fakeHandwriting()
    const bench = new BenchLayer(map, () => {}, fake.create)
    bench.show(10)
    const ops: StrokeOp[] = []
    bench.store.subscribe((op) => void ops.push(op))
    bench.show(5)
    expect([...bench.store.values()]).toHaveLength(5)
    const load = ops.find((op) => op.type === 'load')
    if (load?.type !== 'load') throw new Error('no load op')
    const sent = load.strokes.find((stroke) => stroke.id === 'bench:1')
    expect(sent).toBeDefined()
    expect(bench.store.get('bench:1')?.points).toEqual(sent?.points)
  })

  it('turns the wireframe off on a layer that exists already', async () => {
    const fake = fakeHandwriting()
    const bench = new BenchLayer(map, () => {}, fake.create)
    bench.setWireframe(true)
    bench.show(10)
    await fake.load()
    bench.setWireframe(false)
    expect(fake.layer.wireframe).toBe(false)
  })
})
