// Browser check of the package as a user gets it (decisions 0091, 0094, 0013): packs it, installs the tgz into a copy
// of examples/basic (a page with an import map and no build), serves the copy as it is (serve.mjs) and runs the
// example's checks in headless Chrome (example-checks.mjs), once from localhost and once from a host that is not
// localhost (browser.mjs's INSECURE_HOST), where the page is not a secure context and crypto.randomUUID is missing:
// the stroke of a load op and one drawn by dragging are drawn, ready resolves, and the worker and the WebAssembly
// module come from the package next to the page. The page logs no error, the map's errors included (MapLibre logs
// them when nothing listens). No server: the default store gives the order
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { freePort, INSECURE_HOST, startRun } from './browser.mjs'
import { checkExample } from './example-checks.mjs'

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
// What the checks look at, kept out of the example itself: its map, its store and its handle
appendFileSync(join(example, 'main.js'), '\nwindow.example = { map, store, handwriting }\n')

const port = await freePort()
const browser = await startRun('e2e-example', {
  command: 'node',
  args: [join(root, 'tests/tools/serve.mjs'), example, String(port)],
  cwd: work,
  port,
})

console.log('e2e-example')
await checkExample(browser, { name: 'localhost', origin: `http://localhost:${port}`, path: '/' })
await checkExample(browser, {
  name: 'not a secure context',
  origin: `http://${INSECURE_HOST}:${port}`,
  path: '/',
  insecure: true,
})

await browser.done()
