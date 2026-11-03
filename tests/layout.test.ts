import { describe, expect, it } from 'vitest'
import { scrollToShow } from '../src/ui/layout'

describe('scrollToShow', () => {
  // A view 100 px long scrolled to 50 shows 50..150
  it('keeps the scroll when the item is in view', () => {
    expect(scrollToShow(60, 36, 50, 100)).toBe(50)
    expect(scrollToShow(50, 100, 50, 100)).toBe(50)
  })

  it('scrolls back to the item when it is hidden before the view', () => {
    expect(scrollToShow(20, 36, 50, 100)).toBe(20)
    expect(scrollToShow(40, 36, 50, 100)).toBe(40)
  })

  it('scrolls on until the item ends at the view end when it is hidden after the view', () => {
    expect(scrollToShow(140, 36, 50, 100)).toBe(76)
    expect(scrollToShow(300, 36, 50, 100)).toBe(236)
  })
})
