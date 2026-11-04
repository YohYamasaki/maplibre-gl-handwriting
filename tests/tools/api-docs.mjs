// Writes docs/api.md, the API reference of the package's two entries, from their type declarations and TSDoc
// (decision 0014): `npm run docs:api`. The declarations are those of a declaration emit (.d.ts) done in memory, as
// written there, without the private members; the checker's printing of types is not used. Per entry: the functions,
// the classes, the types and the constants, each by name, with its declaration and TSDoc, and the TSDoc of each
// member of an object type or a class. The core entry lists only its own names, and links to the ones it shares.
// It fails, listing the problems, when a public name has no TSDoc, when a public function or method has no written
// return type, or when a declaration names a type of src that its entry does not export.
// --check compares instead of writing, and exits with 1 when docs/api.md differs; --print writes the reference to the
// standard output. For tests/apiDocs.test.ts: --check-first <file> adds that file to the program and checks it before
// the declarations are emitted, and --entry <file> documents the exports of that file instead of the two entries
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', '..')
const OUTPUT = join(root, 'docs/api.md')
const ENTRIES = [
  { name: 'maplibre-gl-handwriting', file: join(root, 'src/index.ts') },
  { name: 'maplibre-gl-handwriting/core', file: join(root, 'src/core/index.ts') },
]
const CATEGORIES = ['Functions', 'Classes', 'Types', 'Constants']

const args = process.argv.slice(2)
const check = args.includes('--check')
const printOnly = args.includes('--print')

/** The file after `flag`, which must exist; null without the flag */
function fileArgument(flag) {
  const at = args.indexOf(flag)
  if (at === -1) return null
  const file = args[at + 1]
  if (!file || file.startsWith('--')) {
    console.error(`${flag} needs a file`)
    process.exit(2)
  }
  if (!existsSync(resolve(file))) {
    console.error(`${flag}: ${file} does not exist`)
    process.exit(2)
  }
  return resolve(file)
}
const checkFirst = fileArgument('--check-first')
const entryFile = fileArgument('--entry')
const entries = entryFile ? [{ name: basename(entryFile), file: entryFile }] : ENTRIES

const problems = []

// The package's declaration build (tsconfig.build.json), emitted into memory only
const config = ts.getParsedCommandLineOfConfigFile(
  join(root, 'tsconfig.build.json'),
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
)
const options = { ...config.options, noEmit: false, declaration: true, emitDeclarationOnly: true }
// The outputs are kept in memory by the source they come from, so their paths do not matter; without a rootDir, an
// --entry outside the repository is no error
delete options.rootDir
const program = ts.createProgram({
  rootNames: [...entries.map((e) => e.file), join(root, 'src/globals.d.ts'), ...(checkFirst ? [checkFirst] : [])],
  options,
})
if (checkFirst) program.getSemanticDiagnostics(program.getSourceFile(checkFirst))

/** The declaration file emitted for each source file, by the source file's name */
const emitted = new Map()
const emit = program.emit(
  undefined,
  (fileName, text, _bom, _onError, sourceFiles) => {
    if (fileName.endsWith('.d.ts') && sourceFiles?.length === 1) emitted.set(sourceFiles[0].fileName, text)
  },
  undefined,
  true,
)
const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => root, getNewLine: () => '\n' }
for (const diagnostic of emit.diagnostics) problems.push(ts.formatDiagnostic(diagnostic, host).trim())
if (emit.emitSkipped) problems.push('the declarations were not emitted')

const parsed = new Map()
/** The emitted declarations of `sourceFile`, parsed */
function declarationsOf(sourceFile) {
  if (!parsed.has(sourceFile)) {
    const text = emitted.get(sourceFile)
    if (text === undefined) throw new Error(`no declarations were emitted for ${relative(root, sourceFile)}`)
    parsed.set(sourceFile, ts.createSourceFile(`${sourceFile}.d.ts`, text, ts.ScriptTarget.Latest, true))
  }
  return parsed.get(sourceFile)
}

/** The names a statement declares */
function namesOf(statement) {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map((d) => d.name.getText())
  return statement.name ? [statement.name.text] : []
}

function categoryOf(statement) {
  if (ts.isFunctionDeclaration(statement)) return 'Functions'
  if (ts.isClassDeclaration(statement)) return 'Classes'
  if (ts.isVariableStatement(statement)) return 'Constants'
  return 'Types'
}

const isPrivate = (member) =>
  (member.name && ts.isPrivateIdentifier(member.name)) ||
  (ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword))

/**
 * The blocks of the TSDoc comments right before `node`: each paragraph on one line, and each list (lines starting
 * with "- ") as { items }, one line per item
 */
function tsdocOf(node) {
  const comments = (node.jsDoc ?? []).map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? '').filter(Boolean)
  const blocks = []
  for (const paragraph of comments.join('\n\n').split(/\n\s*\n/)) {
    let text = []
    let items = null
    const flush = () => {
      if (text.length > 0) blocks.push(text.join(' '))
      text = []
    }
    for (const line of paragraph.split('\n').map((l) => l.trim())) {
      if (!line) continue
      if (line.startsWith('- ')) {
        flush()
        if (!items) blocks.push((items = { items: [] }))
        items.items.push(line.slice(2))
      } else if (items) {
        items.items[items.items.length - 1] += ` ${line}`
      } else {
        text.push(line)
      }
    }
    flush()
  }
  return blocks
}

/** Markdown for TSDoc text: < outside `code`, and what would read as markup at the start of a paragraph, escaped */
function inlineOf(text) {
  const escaped = text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/</g, '&lt;')))
    .join('')
  // A heading, a quote, a list item or a link reference definition
  return /^(#{1,6}(\s|$)|>|[-+*](\s|$)|\d+[.)](\s|$)|\[[^\]]*\]:)/.test(escaped) ? `\\${escaped}` : escaped
}

/** Markdown for a block of tsdocOf */
const markdownOf = (block) =>
  typeof block === 'string' ? inlineOf(block) : block.items.map((item) => `- ${inlineOf(item)}`).join('\n')

/** The member's label in the list of members: its name, with () for a method */
function memberLabel(member) {
  if (ts.isConstructorDeclaration(member)) return 'constructor'
  const name = member.name.getText()
  return ts.isMethodDeclaration(member) || ts.isMethodSignature(member) ? `${name}()` : name
}

/** The members of an object type or a class, without the private ones; null for other declarations */
function membersOf(statement) {
  if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement))
    return statement.members.filter((m) => !isPrivate(m))
  if (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type)) return [...statement.type.members]
  return null
}

const OMITTED_MODIFIERS = [ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.DeclareKeyword, ts.SyntaxKind.DefaultKeyword]

/** The members a declaration leaves out: the private ones of a class */
const privateMembers = (statement) => (ts.isClassDeclaration(statement) ? statement.members.filter(isPrivate) : [])

/**
 * The declaration of `name` in `statement` of the emitted `file`, as written there, without export and declare, the
 * private members and the TSDoc comments
 */
function declarationOf(file, statement, name) {
  const text = file.text
  const list = ts.isVariableStatement(statement) ? statement.declarationList : null
  if (list && list.declarations.length > 1) {
    const keyword = list.flags & ts.NodeFlags.Const ? 'const' : list.flags & ts.NodeFlags.Let ? 'let' : 'var'
    return `${keyword} ${list.declarations.find((d) => d.name.getText() === name).getText()};`
  }
  const start = statement.getStart()
  const cuts = privateMembers(statement).map((member) => [member.pos, member.end])
  for (const modifier of ts.getModifiers(statement) ?? []) {
    if (OMITTED_MODIFIERS.includes(modifier.kind)) cuts.push([modifier.getStart(), ts.skipTrivia(text, modifier.end)])
  }
  const visit = (node) => {
    if (cuts.some(([from, to]) => node.pos >= from && node.end <= to)) return
    for (const doc of node.jsDoc ?? []) cuts.push([doc.pos, ts.skipTrivia(text, doc.end)])
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(statement, visit)
  let declaration = ''
  let at = start
  for (const [from, to] of cuts.sort(([a], [b]) => a - b)) {
    if (from > at) declaration += text.slice(at, from)
    at = Math.max(at, to)
  }
  return declaration + text.slice(at, statement.end)
}

/** The leftmost identifier of an entity name or a property access */
function leftmost(name) {
  while (ts.isQualifiedName(name) || ts.isPropertyAccessExpression(name))
    name = ts.isQualifiedName(name) ? name.left : name.expression
  return ts.isIdentifier(name) ? name.text : null
}

const isRelative = (specifier) => specifier.startsWith('./') || specifier.startsWith('../')

/**
 * Where a name used in a declaration of `file` comes from: { src: name } for a declaration of src (in the same file
 * or imported from a relative path), { external: module, imported } for an import from a package, null for a global
 */
function originOf(file, name) {
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier.text
      const clause = statement.importClause
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.name.text !== name) continue
          const imported = (element.propertyName ?? element.name).text
          return isRelative(specifier) ? { src: imported } : { external: specifier, imported }
        }
      }
      if (clause?.name?.text === name || (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name))
        return isRelative(specifier) ? { src: name } : { external: specifier, imported: name }
    } else if (!ts.isExportDeclaration(statement) && namesOf(statement).includes(name)) {
      return { src: name }
    }
  }
  return null
}

/**
 * The names of src that the declaration in `statement` (without its private members) uses and the entry does not
 * export (`exported`). The types it uses from packages go into `external`, by their name in `file`
 */
function checkReferences(file, statement, exported, external) {
  const skipped = new Set(privateMembers(statement))
  const typeParameters = new Set()
  const used = []
  const hidden = []
  const visit = (node) => {
    if (skipped.has(node)) return
    if (ts.isTypeParameterDeclaration(node)) typeParameters.add(node.name.text)
    if (ts.isTypeReferenceNode(node)) used.push(leftmost(node.typeName))
    else if (ts.isExpressionWithTypeArguments(node)) used.push(leftmost(node.expression))
    else if (ts.isTypeQueryNode(node)) used.push(leftmost(node.exprName))
    else if (ts.isImportTypeNode(node)) {
      const specifier = node.argument.literal?.text ?? ''
      if (isRelative(specifier) && !(node.qualifier && exported.has(leftmost(node.qualifier))))
        hidden.push(`import("${specifier}")${node.qualifier ? `.${node.qualifier.getText()}` : ''}`)
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(statement, visit)
  for (const name of used) {
    if (!name || typeParameters.has(name)) continue
    const origin = originOf(file, name)
    if (origin?.src && !exported.has(origin.src)) hidden.push(origin.src)
    if (origin?.external) external.set(name, origin)
  }
  return [...new Set(hidden)]
}

const isFunction = (node) => !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))

/** The functions and methods without a written return type in the source declaration of a public name */
function unwrittenReturnTypes(name, declaration) {
  const missing = []
  if (ts.isFunctionDeclaration(declaration) && !declaration.type) missing.push(`${name}()`)
  if (ts.isVariableDeclaration(declaration) && !declaration.type && isFunction(declaration.initializer)) {
    if (!declaration.initializer.type) missing.push(name)
  }
  const members = ts.isClassDeclaration(declaration)
    ? declaration.members.filter((m) => !isPrivate(m))
    : ts.isInterfaceDeclaration(declaration)
      ? declaration.members
      : ts.isTypeAliasDeclaration(declaration) && ts.isTypeLiteralNode(declaration.type)
        ? declaration.type.members
        : []
  for (const member of members) {
    const label = `${name}.${member.name?.getText() ?? 'constructor'}`
    if ((ts.isMethodDeclaration(member) || ts.isMethodSignature(member) || ts.isGetAccessor(member)) && !member.type)
      missing.push(`${label}()`)
    if (ts.isPropertyDeclaration(member) && !member.type && isFunction(member.initializer) && !member.initializer.type)
      missing.push(label)
  }
  return missing
}

const checker = program.getTypeChecker()

/** Each export of an entry: its name, category, declaration, TSDoc and members' TSDoc, and the packages' types it uses */
function describeEntry(entry) {
  const source = program.getSourceFile(entry.file)
  const moduleSymbol = source && checker.getSymbolAtLocation(source)
  if (!moduleSymbol) throw new Error(`${relative(root, entry.file)} is not a module of the program`)
  const symbols = checker.getExportsOfModule(moduleSymbol).map((exported) => ({
    name: exported.name,
    symbol: exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported,
  }))
  const exported = new Set(symbols.map((s) => s.name))
  const external = new Map()
  const names = []
  for (const { name, symbol } of symbols) {
    const sourceDeclaration = symbol.declarations?.find((d) => !d.getSourceFile().isDeclarationFile)
    if (!sourceDeclaration) {
      problems.push(`${entry.name}: ${name} is not declared in a source file of the package`)
      continue
    }
    for (const missing of unwrittenReturnTypes(symbol.name, sourceDeclaration))
      problems.push(`${entry.name}: ${missing} has no written return type`)
    const file = declarationsOf(sourceDeclaration.getSourceFile().fileName)
    const statements = file.statements.filter((s) => !ts.isExportDeclaration(s) && namesOf(s).includes(symbol.name))
    if (statements.length === 0) {
      problems.push(`${entry.name}: ${name} is not in the emitted declarations`)
      continue
    }
    const tsdoc = statements.flatMap((s) => tsdocOf(s))
    if (tsdoc.length === 0) problems.push(`${entry.name}: ${name} has no TSDoc`)
    for (const statement of statements) {
      for (const type of checkReferences(file, statement, exported, external))
        problems.push(`${entry.name}: ${name} names ${type}, which the entry does not export`)
    }
    const members = []
    for (const statement of statements) {
      for (const member of membersOf(statement) ?? []) {
        const text = tsdocOf(member)
        if (text.length > 0) members.push({ label: memberLabel(member), text })
      }
    }
    names.push({
      name,
      category: categoryOf(statements[0]),
      code: statements.map((s) => declarationOf(file, s, symbol.name)).join('\n'),
      tsdoc,
      members,
    })
  }
  return { ...entry, names, external }
}

const described = entries.map(describeEntry)

if (problems.length > 0) {
  console.error(`docs/api.md cannot be generated:\n${problems.map((p) => `  ${p}`).join('\n')}`)
  process.exit(1)
}

/** GitHub's anchor for a heading */
const slugOf = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
const byName = (a, b) => {
  const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()]
  return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

const lines = [
  '# API reference',
  '',
  `The exports of ${described.map((e) => `\`${e.name}\``).join(' and ')}, with their type declarations and TSDoc. ` +
    'How to use them: [usage.md](usage.md).',
  '',
  'Generated by `npm run docs:api` (tests/tools/api-docs.mjs) from the TSDoc in src: edit that, not this file.',
]
const anchors = new Map()
const documented = new Set()
for (const entry of described) {
  lines.push('', `## ${entry.name}`)
  const shared = entry.names.filter((n) => documented.has(n.name)).sort(byName)
  if (shared.length > 0) {
    lines.push(
      '',
      `Also exported by \`${described[0].name}\`: ${shared.map((n) => `[\`${n.name}\`](#${anchors.get(n.name)})`).join(', ')}.`,
    )
  }
  const own = entry.names.filter((n) => !documented.has(n.name))
  const uses = (code, name) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(code)
  const used = [...entry.external].filter(([local]) => own.some((n) => uses(n.code, local)))
  if (used.length > 0) {
    const modules = new Map()
    for (const [local, { external, imported }] of used.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!modules.has(external)) modules.set(external, [])
      modules.get(external).push(local === imported ? `\`${local}\`` : `\`${local}\` (its \`${imported}\`)`)
    }
    for (const [module, types] of modules)
      lines.push('', `Types from \`${module}\` in the declarations: ${types.join(', ')}.`)
  }
  for (const category of CATEGORIES) {
    const inCategory = own.filter((n) => n.category === category).sort(byName)
    if (inCategory.length === 0) continue
    lines.push('', `### ${category}`)
    for (const item of inCategory) {
      const slug = slugOf(item.name)
      if ([...anchors.values()].includes(slug)) throw new Error(`two names have the anchor #${slug}`)
      anchors.set(item.name, slug)
      documented.add(item.name)
      lines.push('', `#### ${item.name}`, '', '```ts', item.code, '```')
      for (const paragraph of item.tsdoc) lines.push('', markdownOf(paragraph))
      if (item.members.length > 0) {
        lines.push('')
        for (const { label, text } of item.members) {
          const markdown = text
            .map(markdownOf)
            .join('\n\n')
            .replace(/\n(?=.)/g, '\n  ')
          lines.push(`- \`${label}\`: ${markdown}`)
        }
      }
    }
  }
}
const content = lines.join('\n') + '\n'

if (printOnly) {
  process.stdout.write(content)
  process.exit(0)
}
if (check) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : null
  if (current !== content) {
    console.error('docs/api.md is not up to date with the TSDoc: npm run docs:api')
    process.exit(1)
  }
  console.log('docs/api.md: up to date')
} else {
  writeFileSync(OUTPUT, content)
  console.log('docs/api.md: written')
}
