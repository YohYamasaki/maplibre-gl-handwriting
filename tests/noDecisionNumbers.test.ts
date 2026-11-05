// The comments, test names and check messages of the code say the reason for a choice in words, never by the number of
// a decision record, a plan or a review. This reads the files of the code and its settings and lists, as file:line,
// every place that cites such a number
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

/** The directories read, with all their files, and the files read at the root */
const DIRECTORIES = ['src', 'dev', 'examples', 'tests', 'tessellator/src']
const FILES = [
  'tessellator/Cargo.toml',
  'vite.config.ts',
  'vitest.config.ts',
  'vitest.bench.config.ts',
  '.gitignore',
  '.prettierignore',
]
/** Installed packages and build output, wherever they are */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'target', 'pkg'])
/** This file, which has the forms in its examples */
const SELF = 'tests/noDecisionNumbers.test.ts'

/** What may come between a keyword and the number: spaces, line breaks and the marks of comments and lists */
const BETWEEN = String.raw`[\s/*!:#-]`
/**
 * decision, ADR or plan, then only BETWEEN, then a number of 4 digits starting with 0; or finding on, then such a
 * number. In the plural too, in any case
 */
const DECISION_NUMBER = new RegExp(
  String.raw`\b(?:decisions?|adrs?|plans?)${BETWEEN}*0\d{3}|\bfindings?${BETWEEN}+on${BETWEEN}*0\d{3}`,
  'gi',
)

/** The files read, relative to the root, with / between the names */
function filesRead(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path)
      } else if (entry.isFile() && path !== SELF) {
        files.push(path)
      }
    }
  }
  for (const dir of DIRECTORIES) walk(dir)
  const tsconfigs = readdirSync(root).filter((name) => /^tsconfig.*\.json$/.test(name))
  return [...files, ...FILES, ...tsconfigs]
}

/** Each place in `text` that cites a number, as the line it starts on (from 1) and what it cites */
function citations(text: string): { line: number; match: string }[] {
  return [...text.matchAll(DECISION_NUMBER)].map((m) => ({
    line: text.slice(0, m.index).split('\n').length,
    match: m[0],
  }))
}

describe('the numbers of decisions, plans and reviews', () => {
  it('are cited nowhere in the code and its settings', () => {
    const files = filesRead()
    expect(files).toContain('src/core/stroke.ts')
    expect(files).toContain('tsconfig.json')
    const found = files.flatMap((file) =>
      citations(readFileSync(join(root, file), 'utf8')).map(
        ({ line, match }) => `${file}:${line}: ${JSON.stringify(match)}`,
      ),
    )
    expect(found, `Say the reason in words instead:\n${found.join('\n')}`).toEqual([])
  })

  it('skips installed packages and build output, and this file', () => {
    const files = filesRead()
    expect(files.filter((file) => file.split('/').some((name) => SKIPPED_DIRECTORIES.has(name)))).toEqual([])
    expect(files).not.toContain(SELF)
  })

  it.each([
    'decisions 0023 to 0025',
    '(ADR 0036, 0039, 0041, 0042)',
    'plan 0038',
    'Plans 0038',
    'Review finding on 0044',
    'Findings on 0044',
    '// Decision 0037 P5: lasso and tap selection',
    '// Measures the stroke layers (decision\n// 0089)',
    'docs/adr/0023-spill-far-stroke-points.md',
    'ADR-0023',
    'ADR0023',
    'ADRs 0023',
    '(ADR\n//! 0043)',
    'width (ADR\n/// 0044)',
    '# Kept out of the repository (decision #0094)',
    ' * as decided (Decision:\n * 0026)',
  ])('match %j', (text) => {
    expect(citations(text)).toHaveLength(1)
  })

  it('give each its line', () => {
    expect(citations('a\n// (decision\n// 0089)\nb ADR 0043')).toEqual([
      { line: 2, match: 'decision\n// 0089' },
      { line: 4, match: 'ADR 0043' },
    ])
  })

  it.each([
    '00000000-0000-4000-8000-000000000000',
    '0123abcd-0123-4567-89ab-0123456789ab',
    '[141.3545, 43.0618]',
    'Float64Array.of(0.0001, 0.0001)',
    'decision 1023',
    'the 0023 split',
    'explanation 0023',
    'planned 0023',
    'a decision on 0023',
  ])('do not match %j', (text) => {
    expect(citations(text)).toEqual([])
  })
})
