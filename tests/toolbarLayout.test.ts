import { describe, expect, it } from 'vitest'
import {
  edgeOffset,
  nearestEdge,
  popoverPosition,
  TOOLBAR_MARGIN,
  TOOLTIP_GAP,
  toolbarPosition,
  tooltipPosition,
} from '../src/ui/layout'

const container = { width: 1000, height: 700 }
const bar = { width: 300, height: 44 }

describe('toolbar layout', () => {
  it('drops the toolbar on the side of the map nearest to its center', () => {
    expect(nearestEdge(500, 20, container)).toBe('top')
    expect(nearestEdge(500, 690, container)).toBe('bottom')
    expect(nearestEdge(10, 350, container)).toBe('left')
    expect(nearestEdge(980, 350, container)).toBe('right')
  })

  it('puts the toolbar back where it was dropped along that side', () => {
    for (const offset of [0, 0.25, 0.5, 1]) {
      const at = toolbarPosition('bottom', offset, container, bar)
      expect(at.top).toBe(container.height - TOOLBAR_MARGIN - bar.height)
      expect(edgeOffset('bottom', at.left + bar.width / 2, at.top, container, bar.width)).toBeCloseTo(offset, 12)
    }
    const vertical = { width: bar.height, height: bar.width }
    const left = toolbarPosition('left', 0.75, container, vertical)
    expect(left.left).toBe(TOOLBAR_MARGIN)
    expect(edgeOffset('left', left.left, left.top + vertical.height / 2, container, vertical.height)).toBeCloseTo(
      0.75,
      12,
    )
  })

  it('keeps the toolbar inside the map, at the margin when it is longer than the side', () => {
    expect(edgeOffset('top', -500, 0, container, bar.width)).toBe(0)
    expect(edgeOffset('top', 5000, 0, container, bar.width)).toBe(1)
    const narrow = { width: 280, height: 700 }
    expect(toolbarPosition('top', 1, narrow, bar).left).toBe(TOOLBAR_MARGIN)
    const right = toolbarPosition('right', 1, container, { width: 44, height: 300 })
    expect(right.left + 44).toBe(container.width - TOOLBAR_MARGIN)
    expect(right.top + 300).toBe(container.height - TOOLBAR_MARGIN)
  })

  it('opens the popover on the map side of the toolbar, centered on the button and inside the map', () => {
    const popover = { width: 248, height: 200 }
    const barRect = { left: 350, top: 648, width: 300, height: 44 }
    const button = { left: 400, top: 652, width: 36, height: 36 }
    const above = popoverPosition('bottom', button, barRect, popover, container)
    expect(above.top + popover.height).toBe(barRect.top - TOOLBAR_MARGIN)
    expect(above.left + popover.width / 2).toBe(button.left + button.width / 2)
    const nearCorner = popoverPosition(
      'top',
      { left: 4, top: 12, width: 36, height: 36 },
      { left: 0, top: 8, width: 300, height: 44 },
      popover,
      container,
    )
    expect(nearCorner).toEqual({ left: TOOLBAR_MARGIN, top: 8 + 44 + TOOLBAR_MARGIN })
    const beside = popoverPosition(
      'right',
      { left: 952, top: 680, width: 36, height: 36 },
      { left: 948, top: 392, width: 44, height: 300 },
      popover,
      container,
    )
    expect(beside.left + popover.width).toBe(948 - TOOLBAR_MARGIN)
    expect(beside.top + popover.height).toBe(container.height - TOOLBAR_MARGIN)
  })

  it('puts a tooltip TOOLTIP_GAP from the toolbar on its map side, centered on the button and inside the map', () => {
    const tooltip = { width: 160, height: 50 }
    const barRect = { left: 350, top: 8, width: 300, height: 44 }
    const button = { left: 400, top: 12, width: 36, height: 36 }
    const below = tooltipPosition('top', button, barRect, tooltip, container)
    expect(below).toEqual({ left: 418 - 80, top: 8 + 44 + TOOLTIP_GAP })
    const left = tooltipPosition(
      'right',
      { left: 952, top: 4, width: 36, height: 36 },
      { left: 948, top: 0, width: 44, height: 300 },
      tooltip,
      container,
    )
    expect(left).toEqual({ left: 948 - TOOLTIP_GAP - 160, top: TOOLBAR_MARGIN })
    const right = tooltipPosition(
      'left',
      { left: 12, top: 300, width: 36, height: 36 },
      { left: 8, top: 200, width: 44, height: 300 },
      tooltip,
      container,
    )
    expect(right).toEqual({ left: 8 + 44 + TOOLTIP_GAP, top: 318 - 25 })
  })
})
