// Browser check of the demo (decision 0016): builds the dev page as the static site npm run deploy:demo uploads
// (npm run build:demo, dist/demo), serves the build with vite preview --mode demo and checks it in headless Chrome:
// the toolbar and the layer are there and ready resolves, a stroke put in the store with a load op (which only the
// layer's worker tessellates) is drawn in its color, a stroke drawn with the pen goes into the store and is drawn,
// and the one tessellation worker and the WebAssembly module it is sent are the hashed files of the build's assets/.
// The page logs no error (browser.mjs). Cloudflare's own serving (the headers) is not looked at here
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { assert, freePort, hexToRgb, line, near, startRun, waitFor } from './browser.mjs'
import { RECORD_WORKERS } from './example-checks.mjs'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const build = spawnSync('npm', ['run', 'build:demo'], { cwd: root, encoding: 'utf8' })
if (build.status !== 0) {
  console.error(build.stdout + build.stderr)
  console.error('e2e-demo: npm run build:demo failed')
  process.exit(1)
}
const assets = readdirSync(join(root, 'dist/demo/assets'))

const port = await freePort()
const run = await startRun('e2e-demo', {
  command: 'npx',
  args: ['vite', 'preview', '--mode', 'demo', '--port', String(port), '--strictPort'],
  cwd: root,
  port,
})
const { check } = run
const site = `http://localhost:${port}`

console.log('e2e-demo')
const page = await run.openClient()
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORD_WORKERS })
// ?blank: no map tiles, so the pixels under the strokes are the plain background
await page.navigate('/?blank')
await waitFor(
  'the demo page',
  () => page.eval(`!!window.__handwriting && !!document.querySelector('.handwriting-toolbar')`),
  60000,
)
await waitFor('the layer', () => page.eval(`!!window.__handwriting.map.getLayer('handwriting')`), 30000)

// The map's errors are not looked at here: with no listener, MapLibre logs them, which fails the run (browser.mjs)
await check('ready resolves', async () => {
  const ready = await page.eval(`Promise.race([
    window.__handwriting.handle.ready.then(() => 'resolved', (e) => 'rejected: ' + e),
    new Promise((resolve) => setTimeout(() => resolve('not settled after 25 s'), 25000)),
  ])`)
  assert(ready === 'resolved', `ready ${ready}`)
})

await check('a stroke from a load op is drawn in its color, by the worker', async () => {
  await page.eval(`(() => {
    const h = window.__handwriting
    const mercator = ([x, y]) => {
      const { lng, lat } = h.map.unproject([x, y])
      const s = Math.sin((lat * Math.PI) / 180)
      return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)]
    }
    const points = new Float64Array(${JSON.stringify(line([300, 330], [700, 330]))}.flatMap(mercator))
    h.store.apply({ type: 'load', strokes: [{ id: 'loaded', author: 'e2e', color: '#0000ff', width: 6, zoom: h.map.getZoom(), points }] }, 'remote')
    return true
  })()`)
  const blue = hexToRgb('#0000ff')
  await waitFor('the loaded stroke on the page', async () => near((await page.pixels([[500, 330]]))[0], blue), 30000)
  const [off] = await page.pixels([[500, 370]])
  assert(!near(off, blue), `the page shows ${off} 40 px below the loaded stroke`)
})

await check('a stroke drawn with the pen goes into the store and is drawn', async () => {
  await page.drag(line([300, 450], [700, 450]))
  const stroke = await waitFor('the stroke with an order', () =>
    page.eval(
      `[...window.__handwriting.store.values()].map((s) => ({ id: s.id, order: s.order ?? null, points: s.points.length / 2 })).find((s) => s.id !== 'loaded' && s.order !== null) ?? null`,
    ),
  )
  assert(stroke.points > 2, `the stroke holds ${stroke.points} points`)
  const [on, off] = await page.pixels([
    [500, 450],
    [500, 550],
  ])
  const black = hexToRgb('#000000')
  assert(near(on, black) && !near(off, black), `the page shows ${on} on the stroke and ${off} away from it`)
})

await check('the one tessellation worker and its WebAssembly module are hashed files of the build', async () => {
  const workers = await page.eval(`window.__workers`)
  const tessellation = workers.filter((w) => w.wasmUrl !== null)
  assert(tessellation.length === 1, `${tessellation.length} tessellation workers: ${JSON.stringify(workers)}`)
  const [{ url, wasmUrl }] = tessellation
  for (const [what, at, name, type] of [
    ['worker', url, /^tessellation\.worker-[\w-]{8}\.js$/, 'text/javascript'],
    ['WebAssembly module', wasmUrl, /^handwriting_tessellator_bg-[\w-]{8}\.wasm$/, 'application/wasm'],
  ]) {
    const file = at.startsWith(`${site}/assets/`) ? at.slice(`${site}/assets/`.length) : null
    assert(file !== null && name.test(file), `the ${what} is loaded from ${at}, not a hashed file in ${site}/assets/`)
    assert(assets.includes(file), `the ${what} ${file} is not in dist/demo/assets: ${assets.join(', ')}`)
    const served = await page.eval(
      `fetch(${JSON.stringify(at)}).then((r) => ({ ok: r.ok, type: r.headers.get('content-type') }))`,
    )
    assert(
      served.ok && served.type.startsWith(type),
      `the ${what} at ${at} is served with ${served.ok ? served.type : 'an error'}`,
    )
  }
})

await run.done()
