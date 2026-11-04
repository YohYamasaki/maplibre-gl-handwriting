// Checks what `npm pack` ships (decision 0096): the entries, the worker, the WebAssembly module as a file, the
// stylesheet, the declarations with every relative import in them resolving inside the package, and the third-party
// licenses. The JavaScript uses import.meta.url only in new URL("./<path>", import.meta.url), the generic form,
// with the path pointing at a file of the package. The debug code must be out of the package: its marker (DEBUG_BUILD_NOTICE in src/debug.ts) is absent from
// the packed build and present in a build with __HANDWRITING_DEBUG__ true, so the check cannot pass by looking for
// the wrong text. Exits with 1 and lists the problems
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const MARKER = /export const DEBUG_BUILD_NOTICE = '([^']+)'/.exec(readFileSync(join(root, 'src/debug.ts'), 'utf8'))?.[1]
if (!MARKER) throw new Error('DEBUG_BUILD_NOTICE was not found in src/debug.ts')

const work = mkdtempSync(join(tmpdir(), 'handwriting-pack-'))
const problems = []

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr)
    throw new Error(`${command} ${args.join(' ')} failed`)
  }
  return result.stdout
}

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
}

try {
  // The package as published: npm pack runs prepack (the build), whose output comes before the JSON
  const output = run('npm', ['pack', '--json', '--pack-destination', work])
  const [packed] = JSON.parse(output.slice(output.search(/^\[$/m)))
  run('tar', ['-xzf', join(work, packed.filename), '-C', work])
  const dir = join(work, 'package')
  const shipped = new Set(packed.files.map((f) => f.path))
  const required = [
    'package.json',
    'LICENSE',
    'README.md',
    'THIRD_PARTY_LICENSES',
    'dist/index.js',
    'dist/core.js',
    'dist/style.css',
    'dist/assets/handwriting_tessellator_bg.wasm',
    'dist/assets/tessellation.worker.js',
    'dist/types/src/index.d.ts',
    'dist/types/src/core/index.d.ts',
  ]
  for (const path of required) if (!shipped.has(path)) problems.push(`${path} is not in the package`)
  for (const path of shipped) {
    if (!/^(dist\/|package\.json$|LICENSE$|README\.md$|THIRD_PARTY_LICENSES$|CHANGELOG\.md$)/.test(path))
      problems.push(`${path} should not be in the package`)
  }

  // Every export of package.json is a file in the package
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  for (const [entry, target] of Object.entries(manifest.exports)) {
    for (const file of typeof target === 'string' ? [target] : Object.values(target)) {
      if (!shipped.has(posix.normalize(file)))
        problems.push(`exports['${entry}'] points at ${file}, which is not in the package`)
    }
  }

  const code = filesUnder(join(dir, 'dist')).filter((path) => path.endsWith('.js'))
  for (const path of code) {
    const text = readFileSync(path, 'utf8')
    const name = path.slice(dir.length + 1)
    if (text.includes(MARKER)) problems.push(`${name} has the debug code in it (its marker was found)`)
    if (text.includes('__HANDWRITING_DEBUG__')) problems.push(`${name} has __HANDWRITING_DEBUG__ left in it`)
    if (text.includes('data:application/wasm')) problems.push(`${name} inlines the WebAssembly module`)
    const all = text.split('import.meta.url').length - 1
    const generic = [...text.matchAll(/new URL\("(\.\.?\/[^"]+)", import\.meta\.url\)/g)]
    if (generic.length !== all)
      problems.push(
        `${name} uses import.meta.url ${all - generic.length} times outside new URL("./<path>", import.meta.url)`,
      )
    for (const [, spec] of generic) {
      const target = posix.normalize(posix.join(posix.dirname(name), spec))
      if (!shipped.has(target))
        problems.push(`${name} has new URL("${spec}", import.meta.url), and ${target} is not in the package`)
    }
  }

  // The relative imports in the declarations resolve to declarations in the package
  const declarations = filesUnder(join(dir, 'dist/types')).filter((path) => path.endsWith('.d.ts'))
  const IMPORT = /(?:from\s+|import\()\s*['"](\.[^'"]+)['"]/g
  for (const path of declarations) {
    for (const [, spec] of readFileSync(path, 'utf8').matchAll(IMPORT)) {
      const base = resolve(dirname(path), spec).replace(/\.js$/, '')
      const found = [`${base}.d.ts`, join(base, 'index.d.ts'), base].some((candidate) =>
        declarations.includes(candidate),
      )
      if (!found) problems.push(`${path.slice(dir.length + 1)} imports '${spec}', which is not in the package`)
    }
  }

  // The same build with the debug code in has the marker, so the check above looks for the right text
  const debugOut = join(work, 'debug-build')
  run('npx', ['vite', 'build'], { HANDWRITING_DEBUG: '1', HANDWRITING_OUT_DIR: debugOut })
  if (!filesUnder(debugOut).some((path) => path.endsWith('.js') && readFileSync(path, 'utf8').includes(MARKER))) {
    problems.push(
      'a build with __HANDWRITING_DEBUG__ true does not have the marker: the check of the package proves nothing',
    )
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error(`The package is not as it should be (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`)
  process.exit(1)
}
console.log('Package contents: OK')
