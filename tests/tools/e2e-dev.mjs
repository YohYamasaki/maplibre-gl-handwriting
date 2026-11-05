// Browser checks on the dev page (decision 0096), which has the debug code in: what the app's e2e checks looked at
// inside the layer before the library moved here (decision 0094). The scene's meshes after a zoom, the frozen pieces
// of a stroke being drawn, the selection and what a drag of it tessellates, and the input latency with and without
// the predicted points. Also a HandwritingLayer whose worker script is missing (an error on the map, ready rejected,
// nothing drawn), a handle offering some tools only (?tools=), and the page without ?blank whose map style cannot be
// loaded (a plain background in its place). No server: the default store gives the order (decision 0091)
import { dirname, resolve } from 'node:path'
import { assert, freePort, hexToRgb, line, near, startRun, wait, waitFor } from './browser.mjs'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const port = await freePort()
const run = await startRun('e2e-dev', {
  command: 'npx',
  args: ['vite', '--port', String(port), '--strictPort'],
  cwd: root,
  port,
})
const { check } = run

console.log('e2e-dev')
const a = await run.openClient()
// ?blank: no map tiles, so the pixels under the strokes are the plain background
await a.navigate('/?blank')
await waitFor(
  'the dev page',
  () => a.eval(`!!window.__handwriting && !!document.querySelector('.handwriting-toolbar')`),
  60000,
)
await waitFor('the layer', () => a.eval(`!!window.__handwriting.scene()`), 30000)
const center = [141.3545, 43.0618]
const jumpTo = (at, zoom) =>
  a.eval(`window.__handwriting.map.jumpTo({ center: ${JSON.stringify(at)}, zoom: ${zoom} }), true`)
const strokes = () =>
  a.eval(
    `[...window.__handwriting.store.values()].map((s) => ({ id: s.id, order: s.order ?? null, first: [s.points[0], s.points[1]], points: s.points.length / 2 }))`,
  )
await jumpTo(center, 12)

let drawn
await check('a stroke drawn without a server gets an order from the default store and is drawn', async () => {
  await a.drag(line([300, 330], [700, 330]))
  drawn = await waitFor('the stroke with an order', async () => (await strokes()).find((s) => s.order !== null))
  const [on] = await a.pixels([[500, 330]])
  assert(near(on, hexToRgb('#000000')), `the stroke shows ${on}`)
})

await check('zooming in rebuilds the bucket for the new zoom on the worker', async () => {
  const at = await a.eval(
    `(() => { const q = window.__handwriting.store.get(${JSON.stringify(drawn.id)}).points; const p = [q[10], q[11]]; return [p[0] * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * p[1]))) * 180 / Math.PI] })()`,
  )
  await jumpTo(at, 17)
  await waitFor('a mesh made for zoom 17', () =>
    a.eval(
      `[...window.__handwriting.scene().inspect().buckets.values()].some((b) => b.mesh && b.meshZoom === 17 && b.strokes.has(${JSON.stringify(drawn.id)}))`,
    ),
  )
  await jumpTo(center, 12)
})

await check(
  'a translucent stroke being drawn is painted once across the seams of its pieces, with round ends',
  async () => {
    const center2 = [141.45, 43.1]
    await jumpTo(center2, 12)
    // Out along y = 450 and straight back along y = 458, long enough to freeze pieces while the button is held
    const path = [...line([300, 450], [600, 450], 50), ...line([600, 458], [300, 458], 50).slice(1)]
    const inside = [
      ...Array.from({ length: 28 }, (_, i) => [320 + 10 * i, 454]),
      ...Array.from({ length: 6 }, (_, i) => [600, 448 + 2 * i]),
      // Past the start and past the pen, inside their round caps only
      [294, 450],
      [294, 458],
    ]
    const under = await a.pixels(inside)
    await a.tool('highlighter')
    let colors
    let hot
    await a.drag(path, async () => {
      hot = await waitFor('a frozen piece of the stroke being drawn', () =>
        a.eval(
          `[...window.__handwriting.scene().inspect().active.values()].find((h) => h && h.frozenTo > 0)?.frozenTo ?? null`,
        ),
      )
      colors = await a.pixels(inside)
    })
    await a.tool('pen')
    const color = '#ffeb3b80'
    const alpha = parseInt(color.slice(7), 16) / 255
    const once = (below) => hexToRgb(color).map((c, i) => c * alpha + below[i] * (1 - alpha))
    const bad = inside
      .map((p, i) => ({ p, color: colors[i], expected: once(under[i]) }))
      .filter(({ color, expected }) => !color.every((v, i) => Math.abs(v - expected[i]) <= 6))
    assert(
      bad.length === 0,
      `pixels of the stroke being drawn (frozen to sample ${hot}) not painted exactly once: ${bad.map(({ p, color, expected }) => `${p}=${color} (expected ${expected.map(Math.round)})`).join(' ')}`,
    )
  },
)

await check(
  'the lasso selects a stroke, a drag moves it without tessellating, and undo puts it back with the selection',
  async () => {
    const center3 = [141.66, 43.2]
    await jumpTo(center3, 12)
    await a.tool('pen')
    const before = new Set((await strokes()).map((s) => s.id))
    await a.drag(line([400, 350], [600, 350]))
    const stroke = await waitFor('the stroke to move', async () =>
      (await strokes()).find((s) => !before.has(s.id) && s.order !== null),
    )

    await a.tool('lasso')
    await a.drag([
      [380, 320],
      [620, 320],
      [620, 380],
      [380, 380],
      [380, 322],
    ])
    assert(
      await a.eval(`window.__handwriting.scene().inspect().selected.has(${JSON.stringify(stroke.id)})`),
      'the lasso did not select the stroke',
    )

    // A drag inside the frame, away from its handles; the meshes stay as they are while it moves
    const stats = () =>
      a.eval(`(() => { const s = window.__handwriting.scene().stats(); return [s.builds, s.mainThreadVertices] })()`)
    const atStart = await stats()
    let during
    await a.drag(line([500, 350], [500, 450], 10), async () => {
      during = await stats()
    })
    assert(during[0] === atStart[0] && during[1] === atStart[1], `tessellated during the drag: ${atStart} -> ${during}`)
    const moved = await waitFor('the move in the store', async () => {
      const s = (await strokes()).find((x) => x.id === stroke.id)
      return s && s.first[1] > stroke.first[1] ? s : null
    })
    assert(moved.order === stroke.order, `the order changed: ${stroke.order} -> ${moved.order}`)
    const black = hexToRgb('#000000')
    const [there, gone] = await a.pixels([
      [450, 450],
      [450, 350],
    ])
    assert(
      near(there, black) && !near(gone, black),
      `the page shows ${there} at the new place and ${gone} at the old one`,
    )

    await a.eval(`document.activeElement?.blur(), true`)
    await a.key('z', 'KeyZ', 90, 4)
    await waitFor('the undo of the move', async () => {
      const s = (await strokes()).find((x) => x.id === stroke.id)
      return s && Math.abs(s.first[1] - stroke.first[1]) < 1e-12
    })
    assert(await a.eval(`window.__handwriting.scene().inspect().selected.size === 1`), 'the undo dropped the selection')
    await a.key('Escape', 'Escape', 27)
    assert(
      await a.eval(`window.__handwriting.scene().inspect().selected.size === 0`),
      'Escape did not clear the selection',
    )
    await a.drag([
      [380, 320],
      [620, 320],
      [620, 380],
      [380, 380],
      [380, 322],
    ])
    assert(
      await a.eval(`window.__handwriting.scene().inspect().selected.size === 1`),
      'the lasso did not select the stroke again',
    )
    await a.tool('pen')
    assert(
      await a.eval(`window.__handwriting.scene().inspect().selected.size === 0`),
      'the selection stayed after leaving the lasso',
    )
  },
)

// Decision 0037 P7-3: the time from a pointermove's timeStamp to the next animation frame, with the browser's predicted
// points drawn and without them. Only reported: no target, and not in the benchmark (it needs a browser)
await check('input latency with and without predicted points; predicted points never reach the store', async () => {
  await jumpTo([141.8, 43.3], 12)
  await a.tool('pen')
  const results = {}
  for (const [name, ms] of [
    ['without prediction', 0],
    ['with prediction', 20],
  ]) {
    const enabled = ms > 0
    await a.eval(`window.__handwriting.setPredictionMs(${ms}), true`)
    await a.eval(`(() => {
      const h = window.__handwriting
      const record = h.latency = { delays: [], predicted: 0, moves: 0 }
      const element = h.map.getCanvasContainer()
      h.stopLatency?.()
      const onMove = (e) => {
        record.moves++
        if (e.getPredictedEvents?.().length) record.predicted++
        const at = e.timeStamp
        requestAnimationFrame(() => record.delays.push(performance.now() - at))
      }
      element.addEventListener('pointermove', onMove)
      h.stopLatency = () => element.removeEventListener('pointermove', onMove)
      return true
    })()`)
    const before = new Set((await strokes()).map((s) => s.id))
    const path = line([300, 300 + (enabled ? 100 : 0)], [700, 300 + (enabled ? 100 : 0)], 60)
    // Chrome gives input sent through the DevTools protocol no predicted events, so withPredictedEvents stays 0 and
    // the two runs differ only by the prediction path's own cost. Its effect shows with a real pen or finger
    await a.drag(path)
    await wait(100)
    const record = await a.eval(`(() => { window.__handwriting.stopLatency(); return window.__handwriting.latency })()`)
    const stroke = await waitFor('the stroke in the store', async () =>
      (await strokes()).find((s) => !before.has(s.id)),
    )
    // Each mouseMoved is one pointermove with one position; the stroke holds those and the press, nothing predicted
    assert(
      stroke.points === path.length,
      `${name}: the stroke holds ${stroke.points} points for ${path.length} positions`,
    )
    const delays = record.delays.toSorted((x, y) => x - y)
    const pick = (q) => delays[Math.min(delays.length - 1, Math.floor(q * delays.length))]
    results[name] = {
      moves: record.moves,
      withPredictedEvents: record.predicted,
      medianMs: pick(0.5)?.toFixed(1),
      p90Ms: pick(0.9)?.toFixed(1),
    }
  }
  await a.eval(`window.__handwriting.setPredictionMs(20), true`)
  console.log(`  input latency (pointermove timeStamp to the next animation frame): ${JSON.stringify(results)}`)
})

await check("the panel shows the scene's stats", async () => {
  assert(
    await a.eval(`document.querySelector('.dev-panel')?.textContent.includes('strokes ')`),
    'the panel shows no scene stats',
  )
})

await check(
  'the load test strokes come in under the layer through load, and Canvas2D and the wireframe draw them',
  async () => {
    const toggle = (text) =>
      a.eval(
        `(() => { const l = [...document.querySelectorAll('.dev-panel label')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); l.querySelector('input').click(); return true })()`,
      )
    await jumpTo(center, 12)
    await toggle('load test strokes')
    await waitFor('the load test layer under the main one', () =>
      a.eval(
        `(() => { const ids = window.__handwriting.map.getLayersOrder(); const i = ids.indexOf('handwriting-bench'); return i >= 0 && i < ids.indexOf('handwriting') })()`,
      ),
    )
    await toggle('wireframe')
    await wait(500)
    await toggle('wireframe')
    const canvases = () => a.eval(`document.querySelectorAll('canvas').length`)
    const before = await canvases()
    await toggle('Canvas2D')
    await wait(500)
    // The Canvas2D view adds a canvas of its own over the map's
    assert((await canvases()) === before + 1, 'no Canvas2D canvas over the map')
    await toggle('Canvas2D')
    await toggle('load test strokes')
  },
)

// MapLibre calls no onRemove when setStyle rebuilds the style or the map is removed. The checks below count the
// tessellation workers alive (made and not terminated, through a Worker wrapped before the page loads) and the store's
// subscriptions (StrokeStore's listeners), so a layer added again, or destroyed off the map, is seen to free them
const COUNT_WORKERS = `(() => {
  const Native = window.Worker
  const counts = (window.__tessellationWorkers = { made: 0, terminated: 0 })
  window.Worker = class extends Native {
    constructor(url, options) {
      super(url, options)
      this.counted = String(url).includes('tessellation')
      if (this.counted) counts.made++
    }
    terminate() {
      if (this.counted) counts.terminated++
      this.counted = false
      super.terminate()
    }
  }
})()`
/** A tab on the dev page at `path`, with the tessellation workers counted, once its handle's layer is on the map */
async function openCounted(path) {
  const client = await run.openClient()
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT_WORKERS })
  await client.navigate(path)
  await waitFor(
    'the dev page',
    () => client.eval(`!!window.__handwriting && !!document.querySelector('.handwriting-toolbar')`),
    60000,
  )
  await waitFor(
    'the layer',
    () => client.eval(`!!window.__handwriting.scene() && !!window.__handwriting.map.getLayer('handwriting')`),
    30000,
  )
  return client
}
const liveWorkers = (client) =>
  client.eval(`window.__tessellationWorkers.made - window.__tessellationWorkers.terminated`)
const subscriptions = (client) => client.eval(`window.__handwriting.store.listeners.size`)
/** setStyle without a diff, with the style first read from the map (it leaves custom layers out); resolves after its style.load */
const rebuildStyle = (client, style = 'window.__handwriting.style') =>
  client.eval(`new Promise((resolve) => {
    const h = window.__handwriting
    h.lastScene = h.scene()
    h.map.once('style.load', () => resolve(true))
    h.map.setStyle(structuredClone(${style}), { diff: false })
  })`)

const c = await openCounted('/?blank')
const black = hexToRgb('#000000')
await check(
  'after setStyle without a diff, the handle adds its layer again, with one worker and no subscription left over',
  async () => {
    await c.drag(line([300, 330], [700, 330]))
    await waitFor('the stroke with an order', () =>
      c.eval(`[...window.__handwriting.store.values()].some((s) => s.order !== undefined)`),
    )
    await waitFor('the stroke on the page', async () => near((await c.pixels([[500, 330]]))[0], black))
    await c.eval(`window.__handwriting.style = window.__handwriting.map.getStyle(), true`)
    const before = await subscriptions(c)
    assert((await liveWorkers(c)) === 1, `${await liveWorkers(c)} tessellation workers before the rebuilds`)
    for (let i = 0; i < 3; i++) {
      await rebuildStyle(c)
      await waitFor(`the layer added again after rebuild ${i + 1}`, () =>
        c.eval(
          `(() => { const h = window.__handwriting; return !!h.map.getLayer('handwriting') && !!h.scene() && h.scene() !== h.lastScene })()`,
        ),
      )
    }
    await waitFor('the stroke on the page again', async () => near((await c.pixels([[500, 330]]))[0], black))
    const workers = await liveWorkers(c)
    assert(workers === 1, `${workers} tessellation workers alive after 3 rebuilds`)
    const after = await subscriptions(c)
    assert(after === before, `the store has ${after} subscriptions after 3 rebuilds, ${before} before`)
  },
)

await check('setStyle with a diff keeps the layer and its scene, and the stroke stays drawn', async () => {
  const made = await c.eval(`window.__tessellationWorkers.made`)
  await c.eval(`new Promise((resolve) => {
    const h = window.__handwriting
    h.lastScene = h.scene()
    const style = structuredClone(h.style)
    style.layers[0].paint = { 'background-color': '#e0e0e0' }
    h.map.once('styledata', () => resolve(true))
    h.map.setStyle(style)
  })`)
  await waitFor('the new background', async () => near((await c.pixels([[500, 600]]))[0], hexToRgb('#e0e0e0')))
  assert(
    await c.eval(
      `(() => { const h = window.__handwriting; return !!h.map.getLayer('handwriting') && h.scene() === h.lastScene })()`,
    ),
    'the diff replaced the layer',
  )
  const [on] = await c.pixels([[500, 330]])
  assert(near(on, black), `the stroke shows ${on}`)
  assert((await c.eval(`window.__tessellationWorkers.made`)) === made, 'the diff made a new worker')
})

await check(
  'a HandwritingLayer with a store of its own draws what is loaded into it, and destroy after map.remove() frees its worker',
  async () => {
    await c.eval(`(() => {
    const h = window.__handwriting
    const store = new h.store.constructor()
    h.view = { store, layer: new h.HandwritingLayer({ store, id: 'view' }) }
    h.map.addLayer(h.view.layer)
    return true
  })()`)
    await c.eval(`window.__handwriting.view.layer.ready.then(() => true)`)
    const screen = line([300, 450], [700, 450])
    await c.eval(`(() => {
    const h = window.__handwriting
    const mercator = ([x, y]) => {
      const { lng, lat } = h.map.unproject([x, y])
      const s = Math.sin((lat * Math.PI) / 180)
      return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)]
    }
    const points = new Float64Array(${JSON.stringify(screen)}.flatMap(mercator))
    h.view.store.apply({ type: 'load', strokes: [{ id: 'view-1', author: 'e2e', color: '#0000ff', width: 6, zoom: h.map.getZoom(), points }] }, 'remote')
    return true
  })()`)
    const blue = hexToRgb('#0000ff')
    await waitFor('the loaded stroke on the page', async () => near((await c.pixels([[500, 450]]))[0], blue))
    assert((await liveWorkers(c)) === 2, `${await liveWorkers(c)} tessellation workers with the handle and the layer`)
    await c.eval(`window.__handwriting.map.remove(), true`)
    await c.eval(`window.__handwriting.view.layer.destroy(), true`)
    assert((await liveWorkers(c)) === 1, `${await liveWorkers(c)} tessellation workers after the layer's destroy`)
    await c.eval(`window.__handwriting.handle.destroy(), true`)
    assert((await liveWorkers(c)) === 0, `${await liveWorkers(c)} tessellation workers after the handle's destroy`)
  },
)

const d = await openCounted('/?blank&overlay')
const order = () => d.eval(`window.__handwriting.map.getLayersOrder()`)
await check(
  "a handle with beforeId comes back before the page's own layer after a rebuild, and never goes on top",
  async () => {
    // Before it, not necessarily right before: the frame timer's layers (dev/StrokeTimer.ts) go around the handle's
    const placed = (ids) => ids.indexOf('handwriting') >= 0 && ids.indexOf('handwriting') < ids.indexOf('overlay')
    await waitFor('the layer before the overlay', async () => placed(await order()))
    // The page adds the overlay again on its style.load
    await d.eval(
      `(() => { const h = window.__handwriting; const style = h.map.getStyle(); style.layers = style.layers.filter((l) => l.id !== 'overlay'); h.style = style; return true })()`,
    )
    await rebuildStyle(d)
    await waitFor('the layer before the overlay after the rebuild', async () => placed(await order()))

    await d.eval(`window.__handwriting.addOverlay = false, true`)
    await rebuildStyle(d)
    await wait(500)
    const ids = await order()
    assert(!ids.includes('handwriting'), `the layer went in without the overlay: ${ids}`)
    assert((await liveWorkers(d)) === 1, `${await liveWorkers(d)} tessellation workers while the layer waits`)
    await d.eval(`window.__handwriting.handle.destroy(), true`)
    assert((await liveWorkers(d)) === 0, `${await liveWorkers(d)} tessellation workers after destroy off the map`)
  },
)

const e = await openCounted('/?blank')
await check(
  "destroy leaves a layer of the style's with the handle's layer ID, and frees the handle's own layer",
  async () => {
    // A rebuilt style with a layer of its own named 'handwriting': the handle's layer cannot go in, and is off the map
    await e.eval(`(() => {
    const h = window.__handwriting
    const style = h.map.getStyle()
    style.layers.push({ id: 'handwriting', type: 'background', paint: { 'background-color': '#000000', 'background-opacity': 0 } })
    h.style = style
    return true
  })()`)
    await rebuildStyle(e)
    await wait(500)
    const type = () => e.eval(`window.__handwriting.map.getLayer('handwriting')?.type ?? null`)
    assert((await type()) === 'background', `the layer 'handwriting' is ${await type()}`)
    assert((await liveWorkers(e)) === 1, `${await liveWorkers(e)} tessellation workers before destroy`)
    await e.eval(`window.__handwriting.handle.destroy(), true`)
    assert((await type()) === 'background', `destroy took the style's layer away: 'handwriting' is ${await type()}`)
    assert((await liveWorkers(e)) === 0, `${await liveWorkers(e)} tessellation workers after destroy`)
  },
)

const f = await run.openClient()
await f.navigate('/?blank')
await waitFor(
  'the dev page',
  () => f.eval(`!!window.__handwriting && !!document.querySelector('.handwriting-toolbar')`),
  60000,
)
await check(
  'a HandwritingLayer whose worker script is missing rejects ready, is an error on the map, and draws nothing',
  async () => {
    await f.eval(`(() => {
    const h = window.__handwriting
    h.failures = []
    h.map.on('error', (e) => h.failures.push({ layerId: e.layerId, message: String(e.error?.message ?? e.error) }))
    const store = new h.store.constructor()
    h.broken = { store, layer: new h.HandwritingLayer({ store, id: 'broken', workerUrl: '/no-such-worker.js' }) }
    h.map.addLayer(h.broken.layer)
    return true
  })()`)
    const outcome = await f.eval(
      `window.__handwriting.broken.layer.ready.then(() => 'resolved', (e) => 'rejected: ' + e.message)`,
    )
    assert(outcome.startsWith('rejected'), `ready ${outcome}`)
    const failures = await f.eval(`window.__handwriting.failures`)
    assert(failures.length === 1 && failures[0].layerId === 'broken', `the map's errors: ${JSON.stringify(failures)}`)
    // A stroke put in its store afterwards is not drawn either
    await f.eval(`(() => {
    const h = window.__handwriting
    const mercator = ([x, y]) => {
      const { lng, lat } = h.map.unproject([x, y])
      const s = Math.sin((lat * Math.PI) / 180)
      return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)]
    }
    const points = new Float64Array(${JSON.stringify(line([300, 450], [700, 450]))}.flatMap(mercator))
    h.broken.store.apply({ type: 'load', strokes: [{ id: 'broken-1', author: 'e2e', color: '#ff0000', width: 8, zoom: h.map.getZoom(), points }] }, 'remote')
    h.map.triggerRepaint()
    return true
  })()`)
    await wait(1000)
    const [at] = await f.pixels([[500, 450]])
    assert(!near(at, hexToRgb('#ff0000')), `the stroke of the failed layer shows ${at}`)
    assert((await f.eval(`window.__handwriting.failures.length`)) === 1, 'more errors on the map after the stroke')
  },
)

const g = await run.openClient()
await g.navigate('/?blank&tools=pen,eraser')
await check('?tools=pen,eraser: the toolbar has the hand, the pen and the eraser only', async () => {
  await waitFor('the toolbar', () => g.eval(`!!document.querySelector('.handwriting-toolbar')`), 60000)
  const buttons = await g.eval(
    `[...document.querySelectorAll('.handwriting-toolbar [data-tool]')].map((b) => b.dataset.tool)`,
  )
  assert(JSON.stringify(buttons) === JSON.stringify(['hand', 'pen', 'eraser']), `the toolbar's tools: ${buttons}`)
})

// Without ?blank the page loads OpenFreeMap's style (decision 0017); with that host blocked, the style fails to load
// and the page falls back to the plain background
const h = await run.openClient()
await h.send('Network.enable')
await h.send('Network.setBlockedURLs', { urls: ['*tiles.openfreemap.org*'] })
await h.navigate('/')
await check('the map style blocked, the page falls back to a plain background and a pen stroke is drawn', async () => {
  await waitFor(
    'the dev page',
    () => h.eval(`!!window.__handwriting && !!document.querySelector('.handwriting-toolbar')`),
    60000,
  )
  await waitFor(
    'the layer',
    () => h.eval(`!!window.__handwriting.scene() && !!window.__handwriting.map.getLayer('handwriting')`),
    30000,
  )
  await h.drag(line([300, 450], [700, 450]))
  await waitFor('the stroke with an order', () =>
    h.eval(`[...window.__handwriting.store.values()].some((s) => s.order !== undefined)`),
  )
  await waitFor('the stroke on the page', async () => near((await h.pixels([[500, 450]]))[0], black))
  assert(await h.eval(`!!window.__handwriting.map.getLayer('handwriting')`), "the map has no layer 'handwriting'")
})

await run.done()
