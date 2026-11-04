// The worker entry (src/tessellation.worker.ts) without a browser: `self` is a stand-in scope, and the module is
// imported anew for each test so that it loads its WebAssembly module (a stand-in too) again
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuildJob, TessellationInit } from '../src/TessellationWorker'
import { settle } from './layerFakes'
import { fakeWriter } from './support'

type Listener = (e: { data: BuildJob | TessellationInit }) => void

let listener: Listener | null = null
let posted: unknown[] = []

const init: TessellationInit = { wasmUrl: 'https://example.test/handwriting_tessellator_bg.wasm' }
const job: BuildJob = {
  key: '12/0/0',
  version: 1,
  tile: { z: 12, x: 0, y: 0 },
  zoom: 12,
  strokes: [
    {
      id: 'a',
      author: '',
      color: '#000000',
      width: 4,
      zoom: 12,
      points: [
        [0.0001, 0.0001],
        [0.0002, 0.0001],
      ],
      order: 1,
    },
  ],
}

/** Imports the worker entry with `load` as the module's load */
async function startWorker(load: () => Promise<unknown>): Promise<Listener> {
  vi.resetModules()
  const { StrokeTessellator } = await import('../src/StrokeTessellator')
  vi.spyOn(StrokeTessellator, 'load').mockImplementation(load as typeof StrokeTessellator.load)
  await import('../src/tessellation.worker')
  if (!listener) throw new Error('the worker entry listens for no message')
  return listener
}

beforeEach(() => {
  listener = null
  posted = []
  vi.stubGlobal('self', {
    addEventListener: (_type: string, l: Listener) => (listener = l),
    postMessage: (message: unknown) => posted.push(message),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('tessellation.worker', () => {
  it('says once that its module loaded, before the first result', async () => {
    const send = await startWorker(() => Promise.resolve(fakeWriter))
    send({ data: init })
    send({ data: job })
    send({ data: job })
    await settle()
    expect(posted).toHaveLength(3)
    expect(posted[0]).toEqual({ loaded: true })
    expect(posted[1]).toMatchObject({ key: job.key, version: job.version })
  })

  it('says once that its module failed to load, and answers no job after it', async () => {
    const send = await startWorker(() => Promise.reject(new Error('no module')))
    send({ data: init })
    send({ data: job })
    send({ data: job })
    await settle()
    expect(posted).toEqual([{ loaded: false, error: 'no module' }])
  })
})
