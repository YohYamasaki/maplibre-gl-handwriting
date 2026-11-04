// What the layers hold across onAdd, onRemove, dispose and destroy, without a browser: Worker is a stand-in that
// counts the live workers and loads its module at once, the WebGL context is never used (nothing is rendered), and
// the store counts its live subscriptions. MapLibre calls no onRemove when it rebuilds the style or the map is
// removed, so an onAdd can come while the last one's resources are still held
import type { Map as MapLibreMap } from 'maplibre-gl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrokeStore, type StrokeListener } from '../src/core/stroke'
import { HandwritingLayer } from '../src/HandwritingLayer'
import { StrokeLayer } from '../src/StrokeLayer'
import { StrokeTessellator, WASM_URL } from '../src/StrokeTessellator'
import { fakeMap, FakeWorker, settle } from './layerFakes'
import { fakeWriter } from './support'

/** Counts the store's subscriptions not yet unsubscribed */
function liveSubscriptions(store: StrokeStore): () => number {
  let live = 0
  const subscribe = store.subscribe.bind(store)
  store.subscribe = (listener: StrokeListener) => {
    live++
    const unsubscribe = subscribe(listener)
    let done = false
    return () => {
      if (!done) live--
      done = true
      unsubscribe()
    }
  }
  return () => live
}

// Only handed back to the layers: nothing is rendered, so no GPU resource is ever made on it
const gl = {} as WebGL2RenderingContext
const tessellator = fakeWriter as unknown as StrokeTessellator

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

const onLoad = (): void => {}

beforeEach(() => {
  FakeWorker.reset()
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('StrokeLayer', () => {
  it('frees the last scene and worker when it is added again without onRemove', () => {
    const store = new StrokeStore()
    const live = liveSubscriptions(store)
    const layer = new StrokeLayer(store, tessellator, { id: 'strokes', onLoad })
    const map = fakeMap()
    layer.onAdd(map, gl)
    const [first] = FakeWorker.live
    const firstScene = layer.scene!
    const destroy = vi.spyOn(firstScene, 'destroy')

    layer.onAdd(map, gl)
    expect(destroy).toHaveBeenCalledOnce()
    expect(first.terminated).toBe(true)
    expect(FakeWorker.live.size).toBe(1)
    expect(live()).toBe(1)
    expect(layer.scene).not.toBe(firstScene)
  })

  it('dispose frees the scene and the worker, and later ops reach neither', () => {
    const store = new StrokeStore()
    const live = liveSubscriptions(store)
    const layer = new StrokeLayer(store, tessellator, { id: 'strokes', onLoad })
    const map = fakeMap()
    layer.onAdd(map, gl)
    const [worker] = FakeWorker.live

    layer.dispose()
    expect(worker.terminated).toBe(true)
    expect(FakeWorker.live.size).toBe(0)
    expect(live()).toBe(0)
    expect(layer.scene).toBeNull()

    store.apply({ type: 'begin', id: 'a', author: '', color: '#000000', width: 4, zoom: 12 }, 'remote')
    store.apply(
      {
        type: 'points',
        id: 'a',
        pts: [
          [0.5, 0.5],
          [0.5001, 0.5],
        ],
      },
      'remote',
    )
    store.apply({ type: 'end', id: 'a' }, 'remote')
    // Only the TessellationInit it was made with
    expect(worker.messages).toEqual([{ wasmUrl: WASM_URL.href }])
    expect(map.triggerRepaint).not.toHaveBeenCalled()
    // Freed twice (dispose after onRemove) is fine
    layer.dispose()
  })
})

describe('HandwritingLayer', () => {
  function loadByHand(): ReturnType<typeof deferred<StrokeTessellator>> & { calls: () => number } {
    const load = deferred<StrokeTessellator>()
    const spy = vi.spyOn(StrokeTessellator, 'load').mockReturnValue(load.promise)
    return { ...load, calls: () => spy.mock.calls.length }
  }

  it('keeps one worker when it is removed and added again while the module loads', async () => {
    const load = loadByHand()
    const store = new StrokeStore()
    const live = liveSubscriptions(store)
    const layer = new HandwritingLayer({ store, id: 'view' })
    const map = fakeMap()
    layer.onAdd(map, gl)
    layer.onRemove()
    layer.onAdd(map, gl)
    expect(FakeWorker.live.size).toBe(0)

    load.resolve(tessellator)
    await layer.ready
    await settle()
    expect(load.calls()).toBe(1)
    expect(FakeWorker.live.size).toBe(1)
    expect(live()).toBe(1)
    expect(map.triggerRepaint).toHaveBeenCalled()
  })

  it('keeps one worker when it is added twice without onRemove while the module loads', async () => {
    const load = loadByHand()
    const store = new StrokeStore()
    const live = liveSubscriptions(store)
    const layer = new HandwritingLayer({ store, id: 'view' })
    const first = fakeMap()
    const second = fakeMap()
    layer.onAdd(first, gl)
    layer.onAdd(second, gl)

    load.resolve(tessellator)
    await layer.ready
    await settle()
    expect(load.calls()).toBe(1)
    expect(FakeWorker.live.size).toBe(1)
    expect(live()).toBe(1)
    // The latest onAdd's map is the one drawn on
    expect(second.triggerRepaint).toHaveBeenCalled()
    expect(first.triggerRepaint).not.toHaveBeenCalled()

    // A style rebuilt: added again without onRemove, the inner layer frees its last worker first
    layer.onAdd(second, gl)
    expect(FakeWorker.live.size).toBe(1)
    expect(live()).toBe(1)
  })

  it('makes the layer after an onRemove while loading, adds it on the next onAdd, and resolves ready with its worker', async () => {
    const load = loadByHand()
    const store = new StrokeStore()
    const live = liveSubscriptions(store)
    const layer = new HandwritingLayer({ store, id: 'view' })
    const map = fakeMap()
    layer.onAdd(map, gl)
    layer.onRemove()
    let resolved = false
    void layer.ready.then(() => (resolved = true))

    load.resolve(tessellator)
    await settle()
    expect(FakeWorker.live.size).toBe(0)
    expect(live()).toBe(0)
    // No worker yet, so ready waits
    expect(resolved).toBe(false)

    layer.onAdd(map, gl)
    expect(load.calls()).toBe(1)
    expect(FakeWorker.live.size).toBe(1)
    expect(live()).toBe(1)
    await layer.ready
    layer.onRemove()
    expect(FakeWorker.live.size).toBe(0)
    expect(live()).toBe(0)
  })

  it('rejects ready when the module fails to load, without an unhandled rejection, and stays empty', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const load = loadByHand()
      const layer = new HandwritingLayer({ store: new StrokeStore(), id: 'view' })
      const map = fakeMap()
      layer.onAdd(map, gl)
      load.reject(new Error('no module'))
      await settle()
      await settle()
      expect(unhandled).toEqual([])
      await expect(layer.ready).rejects.toThrow('no module')
      expect(map.errors).toEqual([{ type: 'error', error: new Error('no module'), layerId: 'view' }])

      layer.onRemove()
      layer.onAdd(map, gl)
      expect(load.calls()).toBe(1)
      expect(FakeWorker.live.size).toBe(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('destroy frees the worker and the store subscription when the layer is no longer on the map', async () => {
    const load = loadByHand()
    const store = new StrokeStore()
    const live = liveSubscriptions(store)
    const layer = new HandwritingLayer({ store, id: 'view' })
    // The map's style no longer has the layer (rebuilt, or the map removed), and no onRemove came
    const map = fakeMap()
    layer.onAdd(map, gl)
    load.resolve(tessellator)
    await layer.ready
    await settle()
    expect(FakeWorker.live.size).toBe(1)

    layer.destroy()
    expect(map.removeLayer).not.toHaveBeenCalled()
    expect(FakeWorker.live.size).toBe(0)
    expect(live()).toBe(0)
    layer.onAdd(map, gl)
    expect(FakeWorker.live.size).toBe(0)
  })

  it('destroy removes the layer from the map when it is on it', async () => {
    const load = loadByHand()
    const store = new StrokeStore()
    const layer = new HandwritingLayer({ store, id: 'view' })
    const removeLayer = vi.fn((_id: string) => layer.onRemove())
    // MapLibre's CustomStyleLayer keeps the custom layer it wraps as `implementation`
    const map = {
      ...fakeMap(),
      getLayer: (id: string) => (id === 'view' ? { implementation: layer } : undefined),
      removeLayer,
    } as unknown as MapLibreMap
    layer.onAdd(map, gl)
    load.resolve(tessellator)
    await layer.ready
    await settle()

    layer.destroy()
    expect(removeLayer).toHaveBeenCalledWith('view')
    expect(FakeWorker.live.size).toBe(0)
  })

  it('destroy leaves another layer with the same ID on the map, and frees its own resources', async () => {
    const load = loadByHand()
    const store = new StrokeStore()
    const live = liveSubscriptions(store)
    const old = new HandwritingLayer({ store, id: 'view' })
    const added = new HandwritingLayer({ store, id: 'view' })
    let onStyle: HandwritingLayer = old
    const removeLayer = vi.fn((_id: string) => onStyle.onRemove())
    const map = {
      ...fakeMap(),
      getLayer: (id: string) => (id === 'view' ? { implementation: onStyle } : undefined),
      removeLayer,
    } as unknown as MapLibreMap
    old.onAdd(map, gl)
    load.resolve(tessellator)
    await old.ready
    await settle()
    // The style rebuilt without `old` (no onRemove), and a new layer with its ID added to the new style
    onStyle = added
    added.onAdd(map, gl)
    await settle()
    expect(FakeWorker.live.size).toBe(2)
    expect(live()).toBe(2)

    old.destroy()
    expect(removeLayer).not.toHaveBeenCalled()
    expect(FakeWorker.live.size).toBe(1)
    expect(live()).toBe(1)
  })

  it('makes nothing for a load that resolves after destroy', async () => {
    const load = loadByHand()
    const store = new StrokeStore()
    const live = liveSubscriptions(store)
    const layer = new HandwritingLayer({ store, id: 'view' })
    layer.onAdd(fakeMap(), gl)
    layer.destroy()

    load.resolve(tessellator)
    await layer.ready
    await settle()
    expect(FakeWorker.live.size).toBe(0)
    expect(live()).toBe(0)
  })
})
