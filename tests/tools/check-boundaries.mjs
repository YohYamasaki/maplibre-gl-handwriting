// Checks the import rules of the package's source and that StrokeScene stays runnable without a browser.
// Exits with 1 and lists the offending imports if any rule is broken
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')

// Each file falls under the first rule whose prefix matches. `allow` lists the repository paths and packages
// it may import; a path entry allows everything under it
const RULES = [
  {
    files: 'src/core/',
    allow: ['src/core/'],
    why: 'the ./core entry is the stroke model alone: no DOM, no MapLibre, no rendering (decision 0096)',
  },
  {
    files: 'src/',
    allow: ['src/', 'tessellator/pkg/', 'maplibre-gl'],
    why: 'the package may depend only on maplibre-gl and its own wasm; dev/, tests/ and examples/ are not in it',
  },
]

// Files that must not reach these packages through any chain of runtime imports (type-only imports are erased)
const NO_RUNTIME_DEPENDENCY = [
  {
    file: 'src/StrokeScene.ts',
    packages: ['maplibre-gl'],
    why: 'StrokeScene is tested without a browser; keep MapLibre in StrokeLayer and mapProjector',
  },
]

const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

/** Imports of a file: { spec, target (repository path or package name), typeOnly } */
function importsOf(file) {
  const source = readFileSync(join(root, file), 'utf8')
  const found = []
  for (const match of source.matchAll(IMPORT)) {
    const spec = match[3] ?? match[4]
    const typeOnly = Boolean(match[2])
    found.push({ spec, typeOnly, target: targetOf(file, spec) })
  }
  return found
}

function targetOf(file, spec) {
  if (!spec.startsWith('.')) {
    // A package name, without its subpath
    const parts = spec.split('/')
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  }
  const path = relative(root, resolve(root, dirname(file), spec))
  for (const candidate of [path, `${path}.ts`, `${path}/index.ts`, path.replace(/\.js$/, '.ts')]) {
    if (existsSync(join(root, candidate)) && statSync(join(root, candidate)).isFile()) return candidate
  }
  return path
}

function sourceFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(join(root, d))) {
      const path = join(d, name)
      if (['node_modules', 'pkg', 'target'].includes(name)) continue
      if (statSync(join(root, path)).isDirectory()) walk(path)
      else if (/\.(ts|svelte)$/.test(name) && !name.endsWith('.d.ts')) out.push(path)
    }
  }
  walk(dir)
  return out
}

const problems = []
for (const file of ['src'].flatMap(sourceFiles)) {
  const rule = RULES.find((r) => file.startsWith(r.files))
  if (!rule || rule.allow.includes('*')) continue
  for (const { spec, target } of importsOf(file)) {
    const allowed = rule.allow.some((allow) => (allow.endsWith('/') ? target.startsWith(allow) : target === allow))
    if (!allowed) problems.push(`${file}: imports '${spec}'${rule.why ? ` — ${rule.why}` : ''}`)
  }
}

for (const { file, packages, why } of NO_RUNTIME_DEPENDENCY) {
  // Walks runtime imports breadth-first and reports the first chain that reaches a forbidden package
  const seen = new Map([[file, null]])
  const queue = [file]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const { target, typeOnly } of importsOf(current)) {
      if (typeOnly) continue
      if (packages.includes(target)) {
        const chain = [target, current]
        for (let at = seen.get(current); at; at = seen.get(at)) chain.push(at)
        problems.push(`${file}: reaches '${target}' through ${chain.reverse().join(' → ')} — ${why}`)
        continue
      }
      if (target.endsWith('.ts') && !seen.has(target)) {
        seen.set(target, current)
        queue.push(target)
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Import rule violations (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`)
  process.exit(1)
}
console.log('Import rules: OK')
