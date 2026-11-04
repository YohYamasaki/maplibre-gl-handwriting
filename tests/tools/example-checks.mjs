// The checks of an example built from the packed package (e2e-example.mjs with Vite, e2e-bundlers.mjs with webpack,
// Rollup and esbuild). The example (examples/*/main.*) puts one blue stroke in its store with a load op, which only
// the layer's worker tessellates, records the map's errors and whether ready resolved, and selects the pen
import { assert, hexToRgb, line, near, waitFor } from './browser.mjs'

// Run before the page's own scripts: records each worker the page makes, and the WebAssembly URL the tessellation
// worker is sent (TessellationInit), which tells it from MapLibre's workers
const RECORD_WORKERS = `(() => {
  const Native = window.Worker
  const workers = (window.__workers = [])
  window.Worker = class extends Native {
    constructor(url, options) {
      super(url, options)
      this.record = { url: String(new URL(url, document.baseURI)), wasmUrl: null }
      workers.push(this.record)
    }
    postMessage(message, transfer) {
      if (message && typeof message.wasmUrl === 'string') this.record.wasmUrl = message.wasmUrl
      return super.postMessage(message, transfer)
    }
  }
})()`

// The loaded stroke's middle (examples/*/main.*: from 141.32 to 141.39 east, at 43.07 north)
const LOADED_AT = [141.355, 43.07]

/**
 * Opens the example at `path` (a directory of the server at `origin`, ending in /) in a new tab and runs its checks,
 * each named after `name`
 */
export async function checkExample(run, { name, origin, path }) {
  const page = await run.openClient()
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORD_WORKERS })
  await page.navigate(path)
  await waitFor(`the ${name} example`, () => page.eval(`!!window.example && !!document.querySelector('.handwriting-toolbar')`), 60000)
  await waitFor(`the layer of the ${name} example`, () => page.eval(`!!window.example.map.getLayer('handwriting')`), 30000)

  await run.check(`${name}: ready resolves and the map reports no error`, async () => {
    await waitFor('ready to settle', () => page.eval(`window.example.ready !== null`), 30000)
    const ready = await page.eval(`window.example.ready`)
    const errors = await page.eval(`window.example.errors`)
    assert(ready === true && errors.length === 0, `ready ${ready ? 'resolved' : 'rejected'}, errors on the map: ${JSON.stringify(errors)}`)
  })

  await run.check(`${name}: the stroke from the load op is drawn in its color, by the worker`, async () => {
    const { x, y } = await page.eval(`window.example.map.project(${JSON.stringify(LOADED_AT)})`)
    const blue = hexToRgb('#0000ff')
    await waitFor('the loaded stroke on the page', async () => near((await page.pixels([[x, y]]))[0], blue), 30000)
    const [off] = await page.pixels([[x, y + 40]])
    assert(!near(off, blue), `the page shows ${off} 40 px below the loaded stroke`)
  })

  await run.check(`${name}: a stroke drawn by dragging is drawn and gets an order from the default store`, async () => {
    await page.drag(line([300, 450], [700, 450]))
    const stroke = await waitFor('the stroke with an order', () =>
      page.eval(`[...window.example.store.values()].map((s) => ({ id: s.id, order: s.order ?? null, points: s.points.length })).find((s) => s.id !== 'loaded' && s.order !== null) ?? null`),
    )
    assert(stroke.points > 2, `the stroke holds ${stroke.points} points`)
    const [on, off] = await page.pixels([[500, 450], [500, 550]])
    const black = hexToRgb('#000000')
    assert(near(on, black) && !near(off, black), `the page shows ${on} on the stroke and ${off} away from it`)
  })

  await run.check(`${name}: the tessellation worker and the WebAssembly module are loaded from the build`, async () => {
    const workers = await page.eval(`window.__workers`)
    const tessellation = workers.filter((w) => w.wasmUrl !== null)
    assert(tessellation.length === 1, `${tessellation.length} tessellation workers: ${JSON.stringify(workers)}`)
    const [{ url, wasmUrl }] = tessellation
    const build = `${origin}${path}`
    for (const [what, at, type] of [['worker', url, 'text/javascript'], ['WebAssembly module', wasmUrl, 'application/wasm']]) {
      assert(at.startsWith(build), `the ${what} is loaded from ${at}, not from the build at ${build}`)
      const served = await page.eval(`fetch(${JSON.stringify(at)}).then((r) => ({ ok: r.ok, type: r.headers.get('content-type') }))`)
      assert(served.ok && served.type.startsWith(type), `the ${what} at ${at} is served with ${served.ok ? served.type : 'an error'}`)
    }
  })
  return page
}
