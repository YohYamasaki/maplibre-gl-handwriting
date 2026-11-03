// Browser checks on the dev page (decision 0096), which has the debug code in: what the app's e2e checks looked at
// inside the layer before the library moved here (decision 0094). The scene's meshes after a zoom, the frozen pieces
// of a stroke being drawn, the selection and what a drag of it tessellates, and the input latency with and without
// the predicted points. No server: the default store gives the order (decision 0091)
import { dirname, resolve } from 'node:path'
import { assert, freePort, hexToRgb, line, near, startRun, wait, waitFor } from './browser.mjs'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const port = await freePort()
const run = await startRun('e2e-dev', { command: 'npx', args: ['vite', '--port', String(port), '--strictPort'], cwd: root, port })
const { check } = run

console.log('e2e-dev')
const a = await run.openClient()
// ?blank: no map tiles, so the pixels under the strokes are the plain background
await a.navigate('/?blank')
await waitFor('the dev page', () => a.eval(`!!window.__handwriting && !!document.querySelector('.handwriting-toolbar')`), 60000)
await waitFor('the layer', () => a.eval(`!!window.__handwriting.scene()`), 30000)
const center = [141.3545, 43.0618]
const jumpTo = (at, zoom) => a.eval(`window.__handwriting.map.jumpTo({ center: ${JSON.stringify(at)}, zoom: ${zoom} }), true`)
const strokes = () =>
  a.eval(`[...window.__handwriting.store.values()].map((s) => ({ id: s.id, order: s.order ?? null, first: s.points[0], points: s.points.length }))`)
await jumpTo(center, 12)

let drawn
await check('a stroke drawn without a server gets an order from the default store and is drawn', async () => {
  await a.drag(line([300, 330], [700, 330]))
  drawn = await waitFor('the stroke with an order', async () => (await strokes()).find((s) => s.order !== null))
  const [on] = await a.pixels([[500, 330]])
  assert(near(on, hexToRgb('#000000')), `the stroke shows ${on}`)
})

await check('zooming in rebuilds the bucket for the new zoom on the worker', async () => {
  const at = await a.eval(`(() => { const p = window.__handwriting.store.get(${JSON.stringify(drawn.id)}).points[5]; return [p[0] * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * p[1]))) * 180 / Math.PI] })()`)
  await jumpTo(at, 17)
  await waitFor('a mesh made for zoom 17', () =>
    a.eval(`[...window.__handwriting.scene().inspect().buckets.values()].some((b) => b.mesh && b.meshZoom === 17 && b.strokes.has(${JSON.stringify(drawn.id)}))`),
  )
  await jumpTo(center, 12)
})

await check('a translucent stroke being drawn is painted once across the seams of its pieces, with round ends', async () => {
  const center2 = [141.45, 43.1]
  await jumpTo(center2, 12)
  // Out along y = 450 and straight back along y = 458, long enough to freeze pieces while the button is held
  const path = [...line([300, 450], [600, 450], 50), ...line([600, 458], [300, 458], 50).slice(1)]
  const inside = [
    ...Array.from({ length: 28 }, (_, i) => [320 + 10 * i, 454]),
    ...Array.from({ length: 6 }, (_, i) => [600, 448 + 2 * i]),
    // Past the start and past the pen, inside their round caps only
    [294, 450], [294, 458],
  ]
  const under = await a.pixels(inside)
  await a.tool('highlighter')
  let colors
  let hot
  await a.drag(path, async () => {
    hot = await waitFor('a frozen piece of the stroke being drawn', () =>
      a.eval(`[...window.__handwriting.scene().inspect().active.values()].find((h) => h && h.frozenTo > 0)?.frozenTo ?? null`),
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
})

await check('the lasso selects a stroke, a drag moves it without tessellating, and undo puts it back with the selection', async () => {
  const center3 = [141.66, 43.2]
  await jumpTo(center3, 12)
  await a.tool('pen')
  const before = new Set((await strokes()).map((s) => s.id))
  await a.drag(line([400, 350], [600, 350]))
  const stroke = await waitFor('the stroke to move', async () => (await strokes()).find((s) => !before.has(s.id) && s.order !== null))

  await a.tool('lasso')
  await a.drag([[380, 320], [620, 320], [620, 380], [380, 380], [380, 322]])
  assert(await a.eval(`window.__handwriting.scene().inspect().selected.has(${JSON.stringify(stroke.id)})`), 'the lasso did not select the stroke')

  // A drag inside the frame, away from its handles; the meshes stay as they are while it moves
  const stats = () => a.eval(`(() => { const s = window.__handwriting.scene().stats(); return [s.builds, s.mainThreadVertices] })()`)
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
  const [there, gone] = await a.pixels([[450, 450], [450, 350]])
  assert(near(there, black) && !near(gone, black), `the page shows ${there} at the new place and ${gone} at the old one`)

  await a.eval(`document.activeElement?.blur(), true`)
  await a.key('z', 'KeyZ', 90, 4)
  await waitFor('the undo of the move', async () => {
    const s = (await strokes()).find((x) => x.id === stroke.id)
    return s && Math.abs(s.first[1] - stroke.first[1]) < 1e-12
  })
  assert(await a.eval(`window.__handwriting.scene().inspect().selected.size === 1`), 'the undo dropped the selection')
  await a.key('Escape', 'Escape', 27)
  assert(await a.eval(`window.__handwriting.scene().inspect().selected.size === 0`), 'Escape did not clear the selection')
  await a.drag([[380, 320], [620, 320], [620, 380], [380, 380], [380, 322]])
  assert(await a.eval(`window.__handwriting.scene().inspect().selected.size === 1`), 'the lasso did not select the stroke again')
  await a.tool('pen')
  assert(await a.eval(`window.__handwriting.scene().inspect().selected.size === 0`), 'the selection stayed after leaving the lasso')
})

// Decision 0037 P7-3: the time from a pointermove's timeStamp to the next animation frame, with the browser's predicted
// points drawn and without them. Only reported: no target, and not in the benchmark (it needs a browser)
await check('input latency with and without predicted points; predicted points never reach the store', async () => {
  await jumpTo([141.8, 43.3], 12)
  await a.tool('pen')
  const results = {}
  for (const [name, enabled] of [['without prediction', false], ['with prediction', true]]) {
    await a.eval(`window.__handwriting.setPrediction(${enabled}), true`)
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
    const stroke = await waitFor('the stroke in the store', async () => (await strokes()).find((s) => !before.has(s.id)))
    // Each mouseMoved is one pointermove with one position; the stroke holds those and the press, nothing predicted
    assert(stroke.points === path.length, `${name}: the stroke holds ${stroke.points} points for ${path.length} positions`)
    const delays = record.delays.toSorted((x, y) => x - y)
    const pick = (q) => delays[Math.min(delays.length - 1, Math.floor(q * delays.length))]
    results[name] = { moves: record.moves, withPredictedEvents: record.predicted, medianMs: pick(0.5)?.toFixed(1), p90Ms: pick(0.9)?.toFixed(1) }
  }
  await a.eval(`window.__handwriting.setPrediction(true), true`)
  console.log(`  input latency (pointermove timeStamp to the next animation frame): ${JSON.stringify(results)}`)
})

await check("the panel shows the scene's stats", async () => {
  assert(await a.eval(`document.querySelector('.dev-panel')?.textContent.includes('strokes ')`), 'the panel shows no scene stats')
})

await check('the load test strokes come in under the layer through load, and Canvas2D and the wireframe draw them', async () => {
  const toggle = (text) =>
    a.eval(`(() => { const l = [...document.querySelectorAll('.dev-panel label')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); l.querySelector('input').click(); return true })()`)
  await jumpTo(center, 12)
  await toggle('load test strokes')
  await waitFor('the load test layer under the main one', () =>
    a.eval(`(() => { const ids = window.__handwriting.map.getLayersOrder(); const i = ids.indexOf('handwriting-bench'); return i >= 0 && i < ids.indexOf('handwriting') })()`),
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
})

await run.done()
