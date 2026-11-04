// Stand-ins for the tests of the layers without a browser: a Worker that counts the live workers and answers its
// TessellationInit as the test says, a map with the events, the repaint and the layer lookups the layers use, and one
// for createHandwriting that also adds custom layers and has a DOM of stand-ins
import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl'
import { vi } from 'vitest'
import type { TessellationLoad } from '../src/TessellationWorker'

/**
 * What a new FakeWorker does: 'load' answers its TessellationInit with `{ loaded: true }`, 'fail' with a load failure,
 * 'script' fires the error event of a script that failed to load, 'silent' leaves the answer to the test (emit), and
 * 'throw' makes the constructor throw as new Worker does for a script of another origin
 */
export type WorkerBehavior = 'load' | 'fail' | 'script' | 'silent' | 'throw'

export class FakeWorker {
  static live = new Set<FakeWorker>()
  static made: FakeWorker[] = []
  static behavior: WorkerBehavior = 'load'
  messages: unknown[] = []
  terminated = false
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  static reset(): void {
    FakeWorker.live.clear()
    FakeWorker.made = []
    FakeWorker.behavior = 'load'
  }

  constructor(readonly url: string | URL) {
    if (FakeWorker.behavior === 'throw')
      throw new DOMException('The worker script is of another origin', 'SecurityError')
    FakeWorker.live.add(this)
    FakeWorker.made.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(listener)
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
    if (typeof message !== 'object' || message === null || !('wasmUrl' in message)) return
    // A worker answers later, never inside postMessage
    const behavior = FakeWorker.behavior
    queueMicrotask(() => {
      if (behavior === 'load') this.answer({ loaded: true })
      else if (behavior === 'fail') this.answer({ loaded: false, error: 'no module' })
      else if (behavior === 'script') this.emit('error', { type: 'error' })
    })
  }

  /** The worker's TessellationLoad, as a message event */
  answer(load: TessellationLoad): void {
    this.emit('message', { data: load })
  }

  /** Delivers an event to the listeners, also after terminate: a message the worker sent before may still come */
  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  terminate(): void {
    this.terminated = true
    FakeWorker.live.delete(this)
  }
}

export type FakeMap = MapLibreMap & {
  triggerRepaint: ReturnType<typeof vi.fn>
  /** The error events fired on the map */
  errors: { error: Error; layerId: string }[]
}

/** A map whose error events are recorded once `listenForErrors` is true; its style has no layer */
export function fakeMap(listenForErrors = true): FakeMap {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const map = {
    errors: [] as { error: Error; layerId: string }[],
    getZoom: () => 12,
    triggerRepaint: vi.fn(),
    getLayer: () => undefined,
    removeLayer: vi.fn(),
    on(type: string, listener: (event: unknown) => void) {
      let set = listeners.get(type)
      if (!set) listeners.set(type, (set = new Set()))
      set.add(listener)
      return map
    },
    off(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener)
      return map
    },
    listens: (type: string) => (listeners.get(type)?.size ?? 0) > 0,
    fire(type: string, properties: object = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, ...properties })
      return map
    },
  }
  if (listenForErrors) map.on('error', (event) => map.errors.push(event as { error: Error; layerId: string }))
  return map as unknown as FakeMap
}

export type HandwritingMap = FakeMap & {
  /** The style's layers by ID, as map.addLayer added them */
  layers: Map<string, CustomLayerInterface>
  /** A style rebuilt without a diff: the custom layers are gone (no onRemove), then style.load */
  rebuildStyle(): void
}

/** A map for createHandwriting: a loaded style that adds custom layers (calling their onAdd), and a DOM of stand-ins */
export function handwritingMap(listenForErrors = true): HandwritingMap {
  const map = fakeMap(listenForErrors) as HandwritingMap
  const layers = new Map<string, CustomLayerInterface>()
  const element = Object.assign(new EventTarget(), { setPointerCapture() {} })
  return Object.assign(map, {
    layers,
    style: {},
    getCanvasContainer: () => element,
    getContainer: () => Object.assign(new EventTarget(), { contains: () => false }),
    getLayer: (id: string) => (layers.has(id) ? { implementation: layers.get(id) } : undefined),
    addLayer(layer: CustomLayerInterface) {
      layers.set(layer.id, layer)
      layer.onAdd?.(map as unknown as MapLibreMap, {} as WebGL2RenderingContext)
      return map
    },
    removeLayer(id: string) {
      layers.get(id)?.onRemove?.(map as unknown as MapLibreMap, {} as WebGL2RenderingContext)
      layers.delete(id)
      return map
    },
    rebuildStyle() {
      layers.clear()
      map.fire('style.load')
    },
  })
}

/** A WebGL context that fails the test on any use: given to render, it shows that nothing is drawn */
export const untouchableGl = new Proxy({} as WebGL2RenderingContext, {
  get(_target, name) {
    throw new Error(`the layer used the WebGL context (${String(name)})`)
  },
})

/** Lets the promise callbacks and the workers' answers run */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Records the unhandled rejections while `run` runs, and returns them */
export async function unhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    await run()
    await settle()
    await settle()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return unhandled
}
