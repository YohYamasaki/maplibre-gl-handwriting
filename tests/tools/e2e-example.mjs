// Browser check of the package as a user gets it (decisions 0091, 0094): packs it, installs the tgz into a copy of
// examples/basic, builds the example with Vite, serves the build and runs the example's checks in headless Chrome
// (example-checks.mjs): the stroke of a load op and one drawn by dragging are drawn, ready resolves with no error on
// the map, and the worker and the WebAssembly module come from the build. No server: the default store gives the order
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { freePort, startRun } from './browser.mjs'
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
run('npx', ['vite', 'build'], example)

const port = await freePort()
const browser = await startRun('e2e-example', {
  command: 'npx',
  args: ['vite', 'preview', '--port', String(port), '--strictPort'],
  cwd: example,
  port,
})

console.log('e2e-example')
await checkExample(browser, { name: 'Vite', origin: `http://localhost:${port}`, path: '/' })

await browser.done()
