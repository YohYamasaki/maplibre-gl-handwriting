import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

function snapshots(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, ['tests/tools/snapshots.mjs', '--print', ...args], {
    cwd: root,
    encoding: 'utf8',
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

// The snapshots do not depend on the order in which the checker created the types
describe('snapshot text', () => {
  it(
    'is the same when another file creates the string literal types first, in the reverse order',
    { timeout: 30_000 },
    () => {
      const literals =
        readFileSync(join(root, 'tests/snapshots/public-api.txt'), 'utf8').match(/'(?:[^'\\\n]|\\.)*'/g) ?? []
      expect(literals.length).toBeGreaterThan(0)
      const dir = mkdtempSync(join(tmpdir(), 'snapshot-order-'))
      try {
        const first = join(dir, 'literals.ts')
        writeFileSync(first, `export const literals = [${literals.reverse().join(', ')}] as const\n`)
        const plain = snapshots()
        const checkedFirst = snapshots('--check-first', first)
        expect(plain.status, plain.stderr).toBe(0)
        expect(checkedFirst.status, checkedFirst.stderr).toBe(0)
        expect(plain.stdout).toContain('public-api.txt\n')
        expect(checkedFirst.stdout).toBe(plain.stdout)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
