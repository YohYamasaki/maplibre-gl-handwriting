import { describe, expect, it } from 'vitest'
import { RunningMax } from '../src/RunningMax'
import { random } from './support'

describe('RunningMax', () => {
  it('holds the largest value as values come and go', () => {
    const max = new RunningMax()
    expect(max.max()).toBe(-Infinity)
    max.add(3)
    max.add(7)
    max.add(5)
    expect(max.max()).toBe(7)
    max.remove(7)
    expect(max.max()).toBe(5)
    max.remove(3)
    expect(max.max()).toBe(5)
    max.remove(5)
    expect(max.max()).toBe(-Infinity)
  })

  it('counts repeated values', () => {
    const max = new RunningMax()
    max.add(4)
    max.add(4)
    max.add(1)
    max.remove(4)
    expect(max.max()).toBe(4)
    max.remove(4)
    expect(max.max()).toBe(1)
    // Removing a value not held changes nothing
    max.remove(4)
    expect(max.max()).toBe(1)
  })

  it('takes negated values for the smallest', () => {
    const min = new RunningMax()
    for (const v of [0.5, 0.25, 0.75]) min.add(-v)
    expect(-min.max()).toBe(0.25)
    min.remove(-0.25)
    expect(-min.max()).toBe(0.5)
  })

  it('agrees with a plain list under random adds and removes, with rebuilds', () => {
    const rand = random(1)
    const max = new RunningMax()
    const held: number[] = []
    for (let step = 0; step < 5000; step++) {
      if (held.length > 0 && rand() < 0.5) {
        const [value] = held.splice(Math.floor(rand() * held.length), 1)
        max.remove(value)
      } else {
        const value = Math.floor(rand() * 50)
        held.push(value)
        max.add(value)
      }
      // Asked only sometimes, so removed values pile up in the heap and a rebuild has to clear them
      if (step % 7 === 0) expect(max.max()).toBe(held.length > 0 ? Math.max(...held) : -Infinity)
    }
  })

  it('keeps the heap within twice the distinct values', () => {
    const max = new RunningMax()
    for (let i = 0; i < 1000; i++) max.add(i)
    // Removing all but the largest without asking for the maximum leaves the discarded values in the heap
    for (let i = 0; i < 999; i++) max.remove(i)
    expect((max as unknown as { heap: number[] }).heap.length).toBeLessThanOrEqual(2)
    expect(max.max()).toBe(999)
  })

  it('clears', () => {
    const max = new RunningMax()
    max.add(2)
    max.clear()
    expect(max.max()).toBe(-Infinity)
    max.add(1)
    expect(max.max()).toBe(1)
  })
})
