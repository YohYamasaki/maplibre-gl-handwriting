// The IDs a handle gives its strokes when startStroke is omitted: UUID v4 from crypto.getRandomValues, also where
// crypto.randomUUID is missing (a page that is not a secure context)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomStrokeId } from '../src/strokeId'
import { UUID_V4 } from './support'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('randomStrokeId', () => {
  it('makes UUID v4 that do not repeat', () => {
    const ids = Array.from({ length: 10_000 }, () => randomStrokeId())
    for (const id of ids) expect(id).toMatch(UUID_V4)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('makes them with a crypto that has getRandomValues only', () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    vi.stubGlobal('crypto', { getRandomValues })
    expect(crypto.randomUUID).toBeUndefined()
    const ids = Array.from({ length: 100 }, () => randomStrokeId())
    for (const id of ids) expect(id).toMatch(UUID_V4)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('sets the version and variant bits whatever the random bytes are', () => {
    for (const fill of [0x00, 0xff]) {
      vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => array.fill(fill) })
      expect(randomStrokeId()).toMatch(UUID_V4)
    }
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => array.fill(0) })
    expect(randomStrokeId()).toBe('00000000-0000-4000-8000-000000000000')
  })
})
