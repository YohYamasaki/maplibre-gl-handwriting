// How a module or a tessellation worker that fails to load reaches the API, without a browser: `ready` rejects, the
// map gets one error event with the layer's ID (or the console one error when nothing listens), no rejection is left
// unhandled, and the layer then draws nothing and makes no worker again. On success, ready waits for the first worker
// to answer. createHandwriting's DOM parts (the eraser's circle, the selection's frame, the laser's canvas) are
// stand-ins here
import type { CustomRenderMethodInput } from 'maplibre-gl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrokeStore } from '../src/core/stroke'
import { createHandwriting } from '../src/createHandwriting'
import { HandwritingLayer } from '../src/HandwritingLayer'
import type { StrokeLayer } from '../src/StrokeLayer'
import { StrokeTessellator } from '../src/StrokeTessellator'
import {
  fakeMap,
  FakeWorker,
  handwritingMap,
  settle,
  unhandledRejections,
  untouchableGl,
  type WorkerBehavior,
} from './layerFakes'
import { fakeWriter } from './support'

vi.mock('../src/ui/cursor', () => ({ EraserCursor: class { show(): void {} hide(): void {} destroy(): void {} } }))
vi.mock('../src/ui/selection', () => ({
  SelectionFrame: class { update(): void {} showLasso(): void {} destroy(): void {} },
}))
vi.mock('../src/ui/laser', () => ({ LaserOverlay: class { destroy(): void {} } }))

const tessellator = fakeWriter as unknown as StrokeTessellator
const gl = {} as WebGL2RenderingContext
const renderInput = {} as CustomRenderMethodInput

/** The failures of a worker: its module, its script, and new Worker itself */
const FAILURES: { name: string; behavior: WorkerBehavior }[] = [
  { name: 'the worker cannot load its module', behavior: 'fail' },
  { name: 'the worker script fails to load', behavior: 'script' },
  { name: 'new Worker throws', behavior: 'throw' },
]

/** The main thread's module, loaded when the test says */
function loadByHand(): { resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<StrokeTessellator>((a, b) => {
    resolve = () => a(tessellator)
    reject = b
  })
  vi.spyOn(StrokeTessellator, 'load').mockReturnValue(promise)
  return { resolve, reject }
}

/** Whether `promise` has resolved (true), rejected (false) or neither (null), once the pending callbacks have run */
async function stateOf(promise: Promise<void>): Promise<boolean | null> {
  let state: boolean | null = null
  promise.then(() => (state = true), () => (state = false))
  await settle()
  return state
}

beforeEach(() => {
  FakeWorker.reset()
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('window', new EventTarget())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createHandwriting', () => {
  it.each(FAILURES)('$name: ready rejects, the map gets one error, and the layer stays empty', async ({ behavior }) => {
    const map = handwritingMap()
    let handle: ReturnType<typeof createHandwriting> | null = null
    const unhandled = await unhandledRejections(async () => {
      const load = loadByHand()
      FakeWorker.behavior = behavior
      handle = createHandwriting(map, { store: new StrokeStore() })
      load.resolve()
      await settle()
    })
    expect(unhandled).toEqual([])
    await expect(handle!.ready).rejects.toThrow(behavior === 'throw' ? 'another origin' : 'tessellation worker')
    expect(map.errors).toHaveLength(1)
    expect(map.errors[0]).toMatchObject({ layerId: 'handwriting', error: expect.any(Error) })
    expect(FakeWorker.live.size).toBe(0)

    const layer = map.layers.get('handwriting') as StrokeLayer
    expect(() => layer.render(untouchableGl, renderInput)).not.toThrow()
    // The style rebuilt: the layer is added again, and makes no worker
    const made = FakeWorker.made.length
    FakeWorker.behavior = 'load'
    map.rebuildStyle()
    expect(map.layers.get('handwriting')).toBe(layer)
    expect(FakeWorker.made.length).toBe(made)
    await settle()
    expect(map.errors).toHaveLength(1)
    handle!.destroy()
  })

  it('rejects ready and reports the error when the main thread cannot load the module', async () => {
    const map = handwritingMap()
    const load = loadByHand()
    const handle = createHandwriting(map, { store: new StrokeStore() })
    load.reject(new Error('no module'))
    await expect(handle.ready).rejects.toThrow('no module')
    expect(map.errors).toMatchObject([{ layerId: 'handwriting', error: new Error('no module') }])
    expect(map.layers.size).toBe(0)
    expect(FakeWorker.made).toHaveLength(0)
    handle.destroy()
  })

  it('logs the error on the console when the map has no error listener', async () => {
    const map = handwritingMap(false)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = loadByHand()
    FakeWorker.behavior = 'fail'
    const handle = createHandwriting(map, { store: new StrokeStore(), layerId: 'strokes' })
    load.resolve()
    await expect(handle.ready).rejects.toThrow('no module')
    expect(logged).toHaveBeenCalledOnce()
    expect(logged.mock.calls[0][0]).toBeInstanceOf(Error)
    handle.destroy()
  })

  it("resolves ready only once the first worker's module has loaded", async () => {
    const map = handwritingMap()
    const load = loadByHand()
    FakeWorker.behavior = 'silent'
    const handle = createHandwriting(map, { store: new StrokeStore() })
    load.resolve()
    await settle()
    expect(FakeWorker.made).toHaveLength(1)
    expect(await stateOf(handle.ready)).toBeNull()
    FakeWorker.made[0].answer({ loaded: true })
    expect(await stateOf(handle.ready)).toBe(true)
    handle.destroy()
  })

  it("settles ready with the next worker when the style is rebuilt before the first answers, and drops the first's answer", async () => {
    const map = handwritingMap()
    const load = loadByHand()
    FakeWorker.behavior = 'silent'
    const handle = createHandwriting(map, { store: new StrokeStore() })
    load.resolve()
    await settle()
    map.rebuildStyle()
    const [first, second] = FakeWorker.made
    expect(first.terminated).toBe(true)
    first.answer({ loaded: false, error: 'late' })
    expect(await stateOf(handle.ready)).toBeNull()
    expect(map.errors).toEqual([])
    second.answer({ loaded: true })
    expect(await stateOf(handle.ready)).toBe(true)
    handle.destroy()
  })

  it('only reports a worker that fails after ready has resolved, and the layer then stays empty', async () => {
    const map = handwritingMap()
    const load = loadByHand()
    const handle = createHandwriting(map, { store: new StrokeStore() })
    load.resolve()
    await handle.ready
    FakeWorker.behavior = 'fail'
    map.rebuildStyle()
    await settle()
    expect(await stateOf(handle.ready)).toBe(true)
    expect(map.errors).toMatchObject([{ layerId: 'handwriting' }])
    const layer = map.layers.get('handwriting') as StrokeLayer
    expect(layer.scene).toBeNull()
    expect(() => layer.render(untouchableGl, renderInput)).not.toThrow()
    handle.destroy()
  })

  it('resolves a ready still waiting on destroy, and tells nothing after it', async () => {
    const map = handwritingMap()
    const load = loadByHand()
    const handle = createHandwriting(map, { store: new StrokeStore() })
    handle.destroy()
    load.reject(new Error('no module'))
    expect(await stateOf(handle.ready)).toBe(true)
    expect(map.errors).toEqual([])
  })
})

describe('HandwritingLayer', () => {
  it.each(FAILURES)('$name: ready rejects, the map gets one error, and the layer stays empty', async ({ behavior }) => {
    const map = fakeMap()
    const layer = new HandwritingLayer({ store: new StrokeStore(), id: 'view' })
    const unhandled = await unhandledRejections(async () => {
      const load = loadByHand()
      FakeWorker.behavior = behavior
      layer.onAdd(map, gl)
      load.resolve()
      await settle()
    })
    expect(unhandled).toEqual([])
    await expect(layer.ready).rejects.toThrow(behavior === 'throw' ? 'another origin' : 'tessellation worker')
    expect(map.errors).toHaveLength(1)
    expect(map.errors[0]).toMatchObject({ layerId: 'view', error: expect.any(Error) })
    expect(FakeWorker.live.size).toBe(0)
    expect(() => layer.render(untouchableGl, renderInput)).not.toThrow()

    // Added again, removed or not: no worker
    const made = FakeWorker.made.length
    FakeWorker.behavior = 'load'
    layer.onAdd(map, gl)
    layer.onRemove()
    layer.onAdd(map, gl)
    expect(FakeWorker.made.length).toBe(made)
    await settle()
    expect(map.errors).toHaveLength(1)
    layer.destroy()
  })

  it('logs the error on the console when the map has no error listener', async () => {
    const map = fakeMap(false)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = loadByHand()
    FakeWorker.behavior = 'script'
    const layer = new HandwritingLayer({ store: new StrokeStore(), id: 'view' })
    layer.onAdd(map, gl)
    load.resolve()
    await expect(layer.ready).rejects.toThrow('tessellation worker')
    expect(logged).toHaveBeenCalledOnce()
    layer.destroy()
  })

  it("resolves ready only once the first worker's module has loaded, and with the next one when added again first", async () => {
    const map = fakeMap()
    const load = loadByHand()
    FakeWorker.behavior = 'silent'
    const layer = new HandwritingLayer({ store: new StrokeStore(), id: 'view' })
    layer.onAdd(map, gl)
    load.resolve()
    await settle()
    expect(await stateOf(layer.ready)).toBeNull()
    // A style rebuilt before the worker answered: the inner layer stops it and makes another
    layer.onAdd(map, gl)
    const [first, second] = FakeWorker.made
    expect(first.terminated).toBe(true)
    first.answer({ loaded: true })
    first.emit('error', { type: 'error' })
    expect(await stateOf(layer.ready)).toBeNull()
    expect(map.errors).toEqual([])
    second.answer({ loaded: true })
    expect(await stateOf(layer.ready)).toBe(true)
    layer.destroy()
  })

  it('only reports a worker that fails after ready has resolved', async () => {
    const map = fakeMap()
    const load = loadByHand()
    const layer = new HandwritingLayer({ store: new StrokeStore(), id: 'view' })
    layer.onAdd(map, gl)
    load.resolve()
    await layer.ready
    FakeWorker.behavior = 'script'
    layer.onAdd(map, gl)
    await settle()
    expect(await stateOf(layer.ready)).toBe(true)
    expect(map.errors).toMatchObject([{ layerId: 'view' }])
    expect(FakeWorker.live.size).toBe(0)
    layer.destroy()
  })

  it('resolves a ready still waiting on destroy, and tells nothing after it', async () => {
    const map = fakeMap()
    const load = loadByHand()
    FakeWorker.behavior = 'silent'
    const layer = new HandwritingLayer({ store: new StrokeStore(), id: 'view' })
    layer.onAdd(map, gl)
    load.resolve()
    await settle()
    const [worker] = FakeWorker.made
    layer.destroy()
    worker.answer({ loaded: false, error: 'late' })
    expect(await stateOf(layer.ready)).toBe(true)
    expect(map.errors).toEqual([])
  })
})
