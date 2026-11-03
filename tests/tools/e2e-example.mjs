// Browser check of the package as a user gets it (decisions 0091, 0094): packs it, installs the tgz into a copy of
// examples/basic, builds the example with Vite, serves the build and draws one stroke in headless Chrome. The stroke
// must be drawn and get its order from the default store, with no server
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assert, freePort, hexToRgb, line, near, startRun, waitFor } from './browser.mjs'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const work = mkdtempSync(join(tmpdir(), 'handwriting-example-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(result.stdout + result.stderr)
    console.error(`e2e-example: ${command} ${args.join(' ')} failed`)
    process.exit(1)
  }
  return result.stdout
}

// npm pack runs prepack (the build), whose output comes before the JSON
const output = run('npm', ['pack', '--json', '--pack-destination', work], root)
const [packed] = JSON.parse(output.slice(output.search(/^\[$/m)))
const example = join(work, 'basic')
cpSync(join(root, 'examples/basic'), example, {
  recursive: true,
  filter: (path) => !/[/\\](node_modules|dist|package-lock\.json)$/.test(path),
})
run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', join(work, packed.filename)], example)
run('npx', ['vite', 'build'], example)

const port = await freePort()
const browser = await startRun('e2e-example', { command: 'npx', args: ['vite', 'preview', '--port', String(port), '--strictPort'], cwd: example, port })

console.log('e2e-example')
const a = await browser.openClient()
await a.navigate('/')
await waitFor('the example', () => a.eval(`!!window.example && !!document.querySelector('.handwriting-toolbar')`), 60000)
await waitFor('the layer', () => a.eval(`!!window.example.map.getLayer('handwriting')`), 30000)

await browser.check('a stroke drawn in the built example is drawn and gets an order from the default store', async () => {
  await a.drag(line([300, 350], [700, 350]))
  const stroke = await waitFor('the stroke with an order', () =>
    a.eval(`[...window.example.store.values()].map((s) => ({ order: s.order ?? null, points: s.points.length })).find((s) => s.order !== null) ?? null`),
  )
  assert(stroke.points > 2, `the stroke holds ${stroke.points} points`)
  const [on, off] = await a.pixels([[500, 350], [500, 450]])
  const black = hexToRgb('#000000')
  assert(near(on, black) && !near(off, black), `the page shows ${on} on the stroke and ${off} away from it`)
})

await browser.done()
