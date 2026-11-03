// Snapshots of what other code depends on: the public API of the package (its . and ./core entries) and the messages
// to and from the tessellation worker. A difference in public-api.txt is a minor release (CHANGELOG.md); it exits
// with 1 until the snapshots are accepted with --accept
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const accept = process.argv.includes('--accept')

const TYPE_FLAGS =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType

/** Every export of `file` (or only `names`), with its type spelled out and, for classes, their public members */
function describeExports(program, file, names) {
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(join(root, file))
  if (!source) throw new Error(`${file} is not part of the program`)
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(source))
  const lines = []
  for (const exported of exports.sort((a, b) => a.name.localeCompare(b.name))) {
    if (names && !names.includes(exported.name)) continue
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
    const declaration = symbol.declarations?.[0]
    if (!declaration) continue
    if (ts.isClassDeclaration(declaration)) {
      lines.push(...describeClass(checker, exported.name, symbol, declaration))
    } else if (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
      lines.push(`type ${exported.name} = ${checker.typeToString(checker.getDeclaredTypeOfSymbol(symbol), undefined, TYPE_FLAGS)}`)
    } else {
      lines.push(`${exported.name}: ${checker.typeToString(checker.getTypeOfSymbol(symbol), undefined, TYPE_FLAGS)}`)
    }
  }
  return lines.join('\n') + '\n'
}

function describeClass(checker, name, symbol, declaration) {
  const lines = [`class ${name}`]
  const isPublic = (member) =>
    !member.declarations?.some(
      (d) => ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected) || (d.name && ts.isPrivateIdentifier(d.name)),
    )
  const staticType = checker.getTypeOfSymbol(symbol)
  for (const signature of staticType.getConstructSignatures()) {
    if (signature.declaration && !isPublic({ declarations: [signature.declaration] })) continue
    lines.push(`  constructor${checker.signatureToString(signature, undefined, TYPE_FLAGS)}`)
  }
  for (const member of checker.getPropertiesOfType(staticType)) {
    if (member.name === 'prototype' || !isPublic(member)) continue
    lines.push(`  static ${member.name}: ${checker.typeToString(checker.getTypeOfSymbol(member), undefined, TYPE_FLAGS)}`)
  }
  for (const member of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))) {
    if (!isPublic(member)) continue
    lines.push(`  ${member.name}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(member, declaration), undefined, TYPE_FLAGS)}`)
  }
  return lines
}

const config = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
const program = ts.createProgram({
  rootNames: ['src/index.ts', 'src/core/index.ts', 'src/TessellationWorker.ts', 'src/globals.d.ts'].map((f) => join(root, f)),
  options: config.options,
})

const snapshots = {
  'public-api.txt': describeExports(program, 'src/index.ts') + '\n// maplibre-gl-handwriting/core\n' + describeExports(program, 'src/core/index.ts'),
  'worker-messages.txt':
    describeExports(program, 'src/TessellationWorker.ts', ['BuildJob', 'BuildResult', 'TessellationInit']) +
    describeExports(program, 'src/MeshBuffer.ts', ['MeshData', 'StrokeRange']),
}

const dir = join(root, 'tests/snapshots')
mkdirSync(dir, { recursive: true })
const changed = []
for (const [name, content] of Object.entries(snapshots)) {
  const path = join(dir, name)
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (previous === content) continue
  if (accept || previous === null) writeFileSync(path, content)
  else changed.push({ name, previous, content })
}

if (changed.length > 0) {
  for (const { name, previous, content } of changed) {
    const before = new Set(previous.split('\n'))
    const after = new Set(content.split('\n'))
    console.error(`tests/snapshots/${name} differs:`)
    for (const line of previous.split('\n')) if (!after.has(line)) console.error(`  - ${line}`)
    for (const line of content.split('\n')) if (!before.has(line)) console.error(`  + ${line}`)
  }
  console.error('\nA change of the public API is a minor release (CHANGELOG.md). Once intended: npm run snapshots -- --accept')
  process.exit(1)
}
console.log(accept ? 'Snapshots: accepted' : 'Snapshots: unchanged')
