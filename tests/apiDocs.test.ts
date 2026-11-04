import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

function apiDocs(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, ['tests/tools/api-docs.mjs', ...args], { cwd: root, encoding: 'utf8' })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

/** The output of the generator for an entry file with `source` alone, written in a directory of its own */
function forEntry(source: string): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'api-docs-'))
  try {
    const entry = join(dir, 'entry.ts')
    writeFileSync(entry, source)
    return apiDocs('--print', '--entry', entry)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// docs/api.md is written from the declarations and their TSDoc by tests/tools/api-docs.mjs (decision 0014)
describe('the API reference', () => {
  it('is up to date with the TSDoc', { timeout: 30_000 }, () => {
    const check = apiDocs('--check')
    expect(check.status, check.stderr).toBe(0)
  })

  it(
    'is the same when another file creates the string literal types first, in the reverse order',
    { timeout: 30_000 },
    () => {
      const literals =
        readFileSync(join(root, 'tests/snapshots/public-api.txt'), 'utf8').match(/'(?:[^'\\\n]|\\.)*'/g) ?? []
      expect(literals.length).toBeGreaterThan(0)
      const dir = mkdtempSync(join(tmpdir(), 'api-docs-order-'))
      try {
        const first = join(dir, 'literals.ts')
        writeFileSync(first, `export const literals = [${literals.reverse().join(', ')}] as const\n`)
        const plain = apiDocs('--print')
        const checkedFirst = apiDocs('--print', '--check-first', first)
        expect(plain.status, plain.stderr).toBe(0)
        expect(checkedFirst.status, checkedFirst.stderr).toBe(0)
        expect(plain.stdout).toContain('# API reference\n')
        expect(checkedFirst.stdout).toBe(plain.stdout)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('cannot be written while a public name has no TSDoc', { timeout: 30_000 }, () => {
    const documented = forEntry('/** Documented */\nexport type Documented = { a: number }\n')
    expect(documented.status, documented.stderr).toBe(0)
    expect(documented.stdout).toContain('#### Documented\n')

    const undocumented = forEntry(
      '/** Documented */\nexport type Documented = { a: number }\nexport type Undocumented = { b: number }\n',
    )
    expect(undocumented.status).toBe(1)
    expect(undocumented.stderr).toContain('entry.ts: Undocumented has no TSDoc')
    expect(undocumented.stderr).not.toMatch(/\bDocumented has no TSDoc/)
    expect(undocumented.stdout).toBe('')
  })

  it('cannot be written while a public function or method has no written return type', { timeout: 30_000 }, () => {
    const result = forEntry(
      [
        '/** A function */',
        'export function inferred(a: number) {',
        '  return a',
        '}',
        '/** A function */',
        'export function written(a: number): number {',
        '  return a',
        '}',
        '/** A class */',
        'export class Box {',
        '  /** A method */',
        '  size() {',
        '    return 1',
        '  }',
        '  private inner() {',
        '    return 2',
        '  }',
        '}',
        '/** An arrow */',
        'export const arrow = (a: number) => a',
      ].join('\n'),
    )
    expect(result.status).toBe(1)
    const problems = result.stderr.split('\n').filter((line) => line.includes('has no written return type'))
    expect(problems.map((line) => line.trim()).sort()).toEqual([
      'entry.ts: Box.size() has no written return type',
      'entry.ts: arrow has no written return type',
      'entry.ts: inferred() has no written return type',
    ])
  })

  it('cannot be written while a declaration names a type its entry does not export', { timeout: 30_000 }, () => {
    const result = forEntry(
      [
        'type Hidden = { a: number }',
        '/** Shown */',
        'export type Shown = { hidden: Hidden }',
        '/** A class whose private member alone uses Hidden */',
        'export class Box {',
        '  private hidden: Hidden = { a: 1 }',
        '  /** Generic */',
        '  get<K extends keyof Shown>(key: K): Shown[K] {',
        '    return { hidden: this.hidden }[key]',
        '  }',
        '}',
      ].join('\n'),
    )
    expect(result.status).toBe(1)
    const problems = result.stderr.split('\n').filter((line) => line.includes('which the entry does not export'))
    expect(problems.map((line) => line.trim())).toEqual([
      'entry.ts: Shown names Hidden, which the entry does not export',
    ])
  })
})
