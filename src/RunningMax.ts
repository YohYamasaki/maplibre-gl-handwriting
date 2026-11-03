/**
 * The largest of a multiset of numbers that values are added to and removed from.
 * Keeps how many times each value is held, and a binary max-heap of the values. A value enters the heap only when
 * its count goes from 0 to 1; a value whose count drops to 0 stays in the heap until it reaches the top, and is
 * discarded there. Adding and removing take O(log distinct values). When the heap holds more than twice as many
 * entries as there are distinct values, it is rebuilt from the counts, so discarded values do not pile up
 * (amortized O(1) per removal).
 * For the smallest value, add and remove the values negated and negate the maximum
 */
export class RunningMax {
  private counts = new Map<number, number>()
  private heap: number[] = []
  /** Heap entries moved or placed so far, for tests of the cost */
  steps = 0

  /** The largest value held, or -Infinity when none is */
  max(): number {
    while (this.heap.length > 0 && !this.counts.has(this.heap[0])) this.pop()
    return this.heap.length > 0 ? this.heap[0] : -Infinity
  }

  add(value: number): void {
    const count = this.counts.get(value) ?? 0
    this.counts.set(value, count + 1)
    if (count > 0) return
    this.heap.push(value)
    this.siftUp(this.heap.length - 1)
    this.compact()
  }

  /** Removes one copy of `value`, which must be held */
  remove(value: number): void {
    const count = this.counts.get(value)
    if (count === undefined) return
    if (count > 1) {
      this.counts.set(value, count - 1)
      return
    }
    this.counts.delete(value)
    this.compact()
  }

  clear(): void {
    this.counts.clear()
    this.heap = []
  }

  /** Rebuilds the heap from the counts once discarded values make up more than half of it */
  private compact(): void {
    if (this.heap.length <= 2 * this.counts.size) return
    this.heap = [...this.counts.keys()]
    this.steps += this.heap.length
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.siftDown(i)
  }

  private pop(): void {
    this.steps++
    const last = this.heap.pop()!
    if (this.heap.length === 0) return
    this.heap[0] = last
    this.siftDown(0)
  }

  private siftUp(i: number): void {
    const heap = this.heap
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heap[parent] >= heap[i]) return
      ;[heap[parent], heap[i]] = [heap[i], heap[parent]]
      this.steps++
      i = parent
    }
  }

  private siftDown(i: number): void {
    const heap = this.heap
    for (;;) {
      const left = 2 * i + 1
      const right = left + 1
      let largest = i
      if (left < heap.length && heap[left] > heap[largest]) largest = left
      if (right < heap.length && heap[right] > heap[largest]) largest = right
      if (largest === i) return
      ;[heap[largest], heap[i]] = [heap[i], heap[largest]]
      this.steps++
      i = largest
    }
  }
}
