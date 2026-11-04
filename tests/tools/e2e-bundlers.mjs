// Browser check of the package with the bundlers other than Vite: packs it, and for each of examples/webpack,
// examples/rollup and examples/esbuild installs the tgz into a copy (the bundler from the example's own package.json,
// so this needs the network or npm's cache), builds it, and serves the builds side by side (serve.mjs) for the
// example's checks in headless Chrome (example-checks.mjs). The esbuild example is checked once more from a host that
// is not localhost (browser.mjs's INSECURE_HOST), where the page is not a secure context and crypto.randomUUID is
// missing: a stroke dragged there is still drawn. The bundlers' versions are not locked
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { freePort, INSECURE_HOST, startRun } from './browser.mjs'
import { checkExample } from './example-checks.mjs'

const BUNDLERS = ['webpack', 'rollup', 'esbuild']

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const work = mkdtempSync(join(tmpdir(), 'handwriting-bundlers-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(result.stdout + result.stderr)
    console.error(`e2e-bundlers: ${command} ${args.join(' ')} failed in ${cwd}`)
    process.exit(1)
  }
  return result.stdout
}

// npm pack runs prepack (the build), whose output comes before the JSON
const output = run('npm', ['pack', '--json', '--pack-destination', work], root)
const [packed] = JSON.parse(output.slice(output.search(/^\[$/m)))
const site = join(work, 'site')
mkdirSync(site)
for (const bundler of BUNDLERS) {
  const example = join(work, bundler)
  cpSync(join(root, 'examples', bundler), example, {
    recursive: true,
    filter: (path) => !/[/\\](node_modules|dist|package-lock\.json)$/.test(path),
  })
  // Not --prefer-offline: a stale entry in the cache can leave out the bundler's native package for this platform
  run('npm', ['install', '--no-audit', '--no-fund', join(work, packed.filename)], example)
  run('npm', ['run', 'build'], example)
  cpSync(join(example, 'dist'), join(site, bundler), { recursive: true })
}
writeFileSync(join(site, 'index.html'), BUNDLERS.map((b) => `<a href="${b}/">${b}</a>`).join('\n'))

const port = await freePort()
const browser = await startRun('e2e-bundlers', { command: 'node', args: [join(root, 'tests/tools/serve.mjs'), site, String(port)], cwd: work, port })

console.log('e2e-bundlers')
for (const bundler of BUNDLERS) {
  await checkExample(browser, { name: bundler, origin: `http://localhost:${port}`, path: `/${bundler}/` })
}
await checkExample(browser, { name: 'esbuild (not a secure context)', origin: `http://${INSECURE_HOST}:${port}`, path: '/esbuild/', insecure: true })

await browser.done()
