// Snapshots of what other code depends on: the public API of the package (its . and ./core entries) and the messages
// to and from the tessellation worker. A difference in public-api.txt is a minor release (CHANGELOG.md); it exits
// with 1 until the snapshots are accepted with --accept.
// The members of every union are written in the code point order of their text, null and undefined last, so the
// order in which the checker created the types does not show (decision 0003). --print writes the snapshots to the
// standard output without comparing or writing them; --check-first <file> adds that file to the program and checks
// it before the snapshots are written (tests/snapshotOrder.test.ts)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const args = process.argv.slice(2)
const accept = args.includes('--accept')
const printOnly = args.includes('--print')
const checkFirstAt = args.indexOf('--check-first')
const checkFirst = checkFirstAt === -1 ? null : args[checkFirstAt + 1]
if (checkFirstAt !== -1 && (!checkFirst || checkFirst.startsWith('--'))) {
  console.error('--check-first needs a file')
  process.exit(2)
}
const checkFirstPath = checkFirst && resolve(checkFirst)
if (checkFirstPath && !existsSync(checkFirstPath)) {
  console.error(`--check-first: ${checkFirst} does not exist`)
  process.exit(2)
}

// The flags checker.typeToString gave the node builder (NoTruncation, InTypeAlias, single quotes, IgnoreErrors);
// signatureToString adds WriteTypeParametersInQualifiedName
const TYPE_FLAGS =
  ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.InTypeAlias |
  ts.NodeBuilderFlags.UseSingleQuotesForStringLiteralType |
  ts.NodeBuilderFlags.IgnoreErrors
const SIGNATURE_FLAGS = TYPE_FLAGS | ts.NodeBuilderFlags.WriteTypeParametersInQualifiedName
const printer = ts.createPrinter({ removeComments: true, omitTrailingSemicolon: true })

const print = (node) => printer.printNode(ts.EmitHint.Unspecified, node, undefined)

// Written last, in this order, as TypeScript writes them
const LAST = ['null', 'undefined']

function compareMembers(a, b) {
  const rankA = LAST.indexOf(a.text)
  const rankB = LAST.indexOf(b.text)
  if (rankA !== rankB) return rankA - rankB
  return a.text < b.text ? -1 : a.text > b.text ? 1 : 0
}

/** `node` with the members of each union, at every depth, sorted by their text once the unions inside them are */
function sortUnions(node) {
  const visited = ts.visitEachChild(node, sortUnions, undefined)
  if (!ts.isUnionTypeNode(visited)) return visited
  const members = visited.types.map((type) => ({ type, text: print(type) })).sort(compareMembers)
  return ts.factory.updateUnionTypeNode(visited, ts.factory.createNodeArray(members.map((member) => member.type)))
}

function typeText(checker, type) {
  const node = checker.typeToTypeNode(type, undefined, TYPE_FLAGS)
  if (!node) throw new Error('the checker gave no type node')
  return print(sortUnions(node))
}

function signatureText(checker, signature) {
  const node = checker.signatureToSignatureDeclaration(
    signature,
    ts.SyntaxKind.CallSignature,
    undefined,
    SIGNATURE_FLAGS,
  )
  if (!node) throw new Error('the checker gave no signature declaration')
  return print(sortUnions(node))
}

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
      lines.push(`type ${exported.name} = ${typeText(checker, checker.getDeclaredTypeOfSymbol(symbol))}`)
    } else {
      lines.push(`${exported.name}: ${typeText(checker, checker.getTypeOfSymbol(symbol))}`)
    }
  }
  return lines.join('\n') + '\n'
}

function describeClass(checker, name, symbol, declaration) {
  const lines = [`class ${name}`]
  const isPublic = (member) =>
    !member.declarations?.some(
      (d) =>
        ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected) ||
        (d.name && ts.isPrivateIdentifier(d.name)),
    )
  const staticType = checker.getTypeOfSymbol(symbol)
  for (const signature of staticType.getConstructSignatures()) {
    if (signature.declaration && !isPublic({ declarations: [signature.declaration] })) continue
    lines.push(`  constructor${signatureText(checker, signature)}`)
  }
  for (const member of checker.getPropertiesOfType(staticType)) {
    if (member.name === 'prototype' || !isPublic(member)) continue
    lines.push(`  static ${member.name}: ${typeText(checker, checker.getTypeOfSymbol(member))}`)
  }
  for (const member of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))) {
    if (!isPublic(member)) continue
    lines.push(`  ${member.name}: ${typeText(checker, checker.getTypeOfSymbolAtLocation(member, declaration))}`)
  }
  return lines
}

const config = ts.getParsedCommandLineOfConfigFile(
  join(root, 'tsconfig.json'),
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
)
const program = ts.createProgram({
  rootNames: [
    ...['src/index.ts', 'src/core/index.ts', 'src/TessellationWorker.ts', 'src/globals.d.ts'].map((f) => join(root, f)),
    ...(checkFirstPath ? [checkFirstPath] : []),
  ],
  options: config.options,
})
if (checkFirstPath) {
  const first = program.getSourceFile(checkFirstPath)
  if (!first) throw new Error(`${checkFirst} is not part of the program`)
  program.getSemanticDiagnostics(first)
}

const snapshots = {
  'public-api.txt':
    describeExports(program, 'src/index.ts') +
    '\n// maplibre-gl-handwriting/core\n' +
    describeExports(program, 'src/core/index.ts'),
  'worker-messages.txt':
    describeExports(program, 'src/TessellationWorker.ts', [
      'BuildJob',
      'BuildResult',
      'TessellationInit',
      'TessellationLoad',
    ]) + describeExports(program, 'src/MeshBuffer.ts', ['MeshData', 'StrokeRange']),
}

if (printOnly) {
  for (const [name, content] of Object.entries(snapshots)) process.stdout.write(`${name}\n${content}`)
  process.exit(0)
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
  console.error(
    '\nA change of the public API is a minor release (CHANGELOG.md). Once intended: npm run snapshots -- --accept',
  )
  process.exit(1)
}
console.log(accept ? 'Snapshots: accepted' : 'Snapshots: unchanged')
