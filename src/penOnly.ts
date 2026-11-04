/** The pointer fields pen-only input looks at */
export type PointerInput = { pointerId: number; pointerType: string }

/** The pointerType of a Touch: a stylus is a pen, anything else (direct, or no touchType) is a touch */
export function touchPointerType(touch: { touchType?: string }): 'pen' | 'touch' {
  return touch.touchType === 'stylus' ? 'pen' : 'touch'
}

/**
 * Pen-only input of one handle. While the setting is on, touch no longer draws or erases and moves
 * the map instead, whether or not a pen has been used; pen and mouse draw and erase with the tool. Touch is kept from
 * the map while a pen or mouse presses with a tool, so a palm that lands during a stroke does not move the map under it
 */
export class PenOnlyInput {
  // Pen and mouse pointers pressed on the map while a tool was selected
  private pressed = new Set<number>()
  // Touch pointers pressed on the map
  private touches = new Set<number>()

  constructor(private enabled: () => boolean) {}

  /** Whether pen-only input applies now: the setting is on */
  get active(): boolean {
    return this.enabled()
  }

  /** Whether a tool may take this pointer: touch is left to the map while pen-only input applies */
  accepts(e: PointerInput): boolean {
    return !(e.pointerType === 'touch' && this.active)
  }

  /** Whether touch may move the map while a tool is selected */
  get touchFree(): boolean {
    return this.active && this.pressed.size === 0
  }

  /**
   * A pointerdown on the map; `toolSelected` when a tool takes pointer input. Returns the touch pointers a tool has
   * to let go of now: those still pressed when a pen lands while pen-only input applies, such as a palm that would
   * otherwise go on drawing
   */
  down(e: PointerInput, toolSelected: boolean): number[] {
    if (e.pointerType === 'touch') this.touches.add(e.pointerId)
    if (toolSelected && e.pointerType !== 'touch') this.pressed.add(e.pointerId)
    return e.pointerType === 'pen' && this.active ? this.pressedTouches() : []
  }

  /** A pointerup or pointercancel on the map */
  up(e: PointerInput): void {
    this.pressed.delete(e.pointerId)
    this.touches.delete(e.pointerId)
  }

  /** The touch pointers pressed on the map now */
  pressedTouches(): number[] {
    return [...this.touches]
  }
}
