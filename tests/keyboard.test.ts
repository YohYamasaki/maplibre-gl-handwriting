import { describe, expect, it } from 'vitest'
import type { Tool } from '../src/createHandwriting'
import {
  changeToolSize,
  KeyboardShortcuts,
  shortcutRows,
  toolKey,
  type KeyboardActions,
  type KeyEventLike,
} from '../src/keyboard'
import { MAX_ERASER_RADIUS, MAX_WIDTH, MIN_ERASER_RADIUS, MIN_WIDTH, PenSettings } from '../src/pens'

type Fake = KeyboardActions & { tool: Tool; selected: boolean; listOpen: boolean; calls: string[] }

/** Actions that record what they were asked to do, with a tool, a selection and the list's state */
function fakeActions(tool: Tool = 'pen'): Fake {
  const fake: Fake = {
    tool,
    selected: false,
    listOpen: false,
    calls: [],
    getTool: () => fake.tool,
    setTool: (next) => {
      fake.calls.push(`tool:${String(next)}`)
      if (next !== 'lasso') fake.selected = false
      fake.tool = next
    },
    holdHand: () => {
      fake.calls.push('hand')
      fake.tool = null
    },
    undo: () => void fake.calls.push('undo'),
    redo: () => void fake.calls.push('redo'),
    hasSelection: () => fake.selected,
    deleteSelection: () => void fake.calls.push('delete'),
    duplicateSelection: () => void fake.calls.push('duplicate'),
    clearSelection: () => {
      fake.calls.push('clear')
      fake.selected = false
    },
    changeSize: (delta) => void fake.calls.push(`size:${delta}`),
    toggleList: () => {
      fake.calls.push('list')
      fake.listOpen = !fake.listOpen
    },
    closeList: () => {
      const open = fake.listOpen
      fake.listOpen = false
      return open
    },
    isInMap: (target) => (target as { inMap?: boolean } | null)?.inMap === true,
  }
  return fake
}

type KeyEvent = KeyEventLike & { prevented: boolean }

/** A key event with the given fields and no modifiers otherwise */
function key(k: string, fields: Partial<KeyEventLike> = {}): KeyEvent {
  const event: KeyEvent = {
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    target: null,
    prevented: false,
    preventDefault: () => {
      event.prevented = true
    },
    ...fields,
  }
  return event
}

function setup(tool: Tool = 'pen'): { actions: Fake; shortcuts: KeyboardShortcuts } {
  const actions = fakeActions(tool)
  const shortcuts = new KeyboardShortcuts(actions, new EventTarget())
  return { actions, shortcuts }
}

describe('keyboard shortcuts', () => {
  it('selects the tools by letter, either case, and by 1 to 5 in the toolbar order', () => {
    const { actions, shortcuts } = setup()
    for (const k of ['h', 'P', 'm', 'E', 'l', '1', '2', '3', '4', '5']) {
      const e = key(k)
      shortcuts.keydown(e)
      expect(e.prevented).toBe(true)
    }
    expect(actions.calls).toEqual([
      'tool:null',
      'tool:pen',
      'tool:highlighter',
      'tool:eraser',
      'tool:lasso',
      'tool:null',
      'tool:pen',
      'tool:highlighter',
      'tool:eraser',
      'tool:lasso',
    ])
    // Held down, a letter selects once; other digits and letters are left to the page
    actions.calls.length = 0
    shortcuts.keydown(key('e', { repeat: true }))
    const six = key('6')
    shortcuts.keydown(six)
    shortcuts.keydown(key('x'))
    expect(actions.calls).toEqual([])
    expect(six.prevented).toBe(false)
    expect(toolKey('highlighter')).toBe('M')
  })

  it('selects the laser pointer with K, either case, and lists it without a number', () => {
    const { actions, shortcuts } = setup()
    for (const k of ['k', 'K']) {
      const e = key(k)
      shortcuts.keydown(e)
      expect(e.prevented).toBe(true)
    }
    expect(actions.calls).toEqual(['tool:laser', 'tool:laser'])
    expect(toolKey('laser')).toBe('K')
    expect(shortcutRows(true)).toContainEqual(['K', 'Laser pointer'])
  })

  it('undoes and redoes with Cmd or Ctrl, and leaves Ctrl or Cmd with other letters to the browser', () => {
    const { actions, shortcuts } = setup()
    shortcuts.keydown(key('z', { metaKey: true }))
    shortcuts.keydown(key('z', { ctrlKey: true }))
    shortcuts.keydown(key('Z', { metaKey: true, shiftKey: true }))
    shortcuts.keydown(key('y', { ctrlKey: true }))
    expect(actions.calls).toEqual(['undo', 'undo', 'redo', 'redo'])
    actions.calls.length = 0
    const copy = key('p', { ctrlKey: true })
    shortcuts.keydown(copy)
    shortcuts.keydown(key('e', { metaKey: true }))
    // Cmd+Y is not redo on a Mac, and Cmd+D without a selection is the browser's bookmark
    const bookmark = key('d', { metaKey: true })
    shortcuts.keydown(bookmark)
    shortcuts.keydown(key('y', { metaKey: true }))
    expect(actions.calls).toEqual([])
    expect(copy.prevented).toBe(false)
    expect(bookmark.prevented).toBe(false)
  })

  it('deletes, duplicates and clears the selection only when there is one', () => {
    const { actions, shortcuts } = setup('lasso')
    const back = key('Backspace')
    shortcuts.keydown(back)
    shortcuts.keydown(key('Delete'))
    shortcuts.keydown(key('Escape'))
    expect(actions.calls).toEqual([])
    expect(back.prevented).toBe(false)
    actions.selected = true
    shortcuts.keydown(key('Delete'))
    shortcuts.keydown(key('Backspace'))
    shortcuts.keydown(key('d', { ctrlKey: true }))
    const esc = key('Escape')
    shortcuts.keydown(esc)
    expect(actions.calls).toEqual(['delete', 'delete', 'duplicate', 'clear'])
    expect(esc.prevented).toBe(true)
  })

  it('makes one copy while Cmd or Ctrl+D is held, and goes on undoing while Cmd or Ctrl+Z is', () => {
    const { actions, shortcuts } = setup('lasso')
    actions.selected = true
    shortcuts.keydown(key('d', { ctrlKey: true }))
    const repeat = key('d', { ctrlKey: true, repeat: true })
    shortcuts.keydown(repeat)
    shortcuts.keydown(key('d', { metaKey: true, repeat: true }))
    // The repeats are still taken, so the browser does not bookmark the page
    expect(repeat.prevented).toBe(true)
    expect(actions.calls).toEqual(['duplicate'])
    actions.calls.length = 0
    shortcuts.keydown(key('z', { metaKey: true }))
    shortcuts.keydown(key('z', { metaKey: true, repeat: true }))
    expect(actions.calls).toEqual(['undo', 'undo'])
  })

  it('keeps the selection when an Escape was already taken, e.g. by the toolbar closing its popover', () => {
    const { actions, shortcuts } = setup('lasso')
    actions.selected = true
    shortcuts.keydown(key('Escape', { defaultPrevented: true }))
    expect(actions.selected).toBe(true)
    expect(actions.calls).toEqual([])
  })

  it('closes the list on Escape before it clears the selection', () => {
    const { actions, shortcuts } = setup('lasso')
    actions.selected = true
    shortcuts.keydown(key('?', { shiftKey: true }))
    expect(actions.listOpen).toBe(true)
    shortcuts.keydown(key('Escape'))
    expect(actions.listOpen).toBe(false)
    expect(actions.selected).toBe(true)
    shortcuts.keydown(key('Escape'))
    expect(actions.selected).toBe(false)
  })

  it('toggles the list with ?, typed with Shift or not, once while held', () => {
    const { actions, shortcuts } = setup()
    shortcuts.keydown(key('?', { shiftKey: true }))
    shortcuts.keydown(key('?', { shiftKey: true, repeat: true }))
    expect(actions.listOpen).toBe(true)
    shortcuts.keydown(key('?'))
    expect(actions.listOpen).toBe(false)
    expect(actions.calls).toEqual(['list', 'list'])
  })

  it('takes [ and ] typed with AltGr (Ctrl+Alt), and not with Ctrl or Cmd alone', () => {
    const { actions, shortcuts } = setup()
    shortcuts.keydown(key('['))
    shortcuts.keydown(key(']', { ctrlKey: true, altKey: true }))
    shortcuts.keydown(key('[', { ctrlKey: true }))
    shortcuts.keydown(key(']', { metaKey: true }))
    expect(actions.calls).toEqual(['size:-1', 'size:1'])
    // A letter typed with AltGr is a tool too, as the key it gives says
    shortcuts.keydown(key('l', { ctrlKey: true, altKey: true }))
    expect(actions.tool).toBe('lasso')
  })

  it('does nothing while typing in a field', () => {
    const { actions, shortcuts } = setup('lasso')
    actions.selected = true
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      for (const k of ['e', '2', ' ', 'Backspace', '[', '?', 'Escape']) shortcuts.keydown(key(k, { target: { tagName } as never }))
      shortcuts.keydown(key('z', { metaKey: true, target: { tagName } as never }))
    }
    shortcuts.keydown(key('e', { target: { tagName: 'DIV', isContentEditable: true } as never }))
    expect(actions.calls).toEqual([])
    expect(actions.selected).toBe(true)
  })

  it('holds the hand while Space is down, then gives back the tool and keeps the selection', () => {
    const { actions, shortcuts } = setup('lasso')
    actions.selected = true
    const down = key(' ')
    shortcuts.keydown(down)
    shortcuts.keydown(key(' ', { repeat: true }))
    expect(down.prevented).toBe(true)
    expect(actions.tool).toBe(null)
    expect(actions.selected).toBe(true)
    const up = key(' ')
    shortcuts.keyup(up)
    expect(up.prevented).toBe(true)
    expect(actions.tool).toBe('lasso')
    expect(actions.selected).toBe(true)
    expect(actions.calls).toEqual(['hand', 'tool:lasso'])
  })

  it('keeps the tool chosen while Space is held, and gives the tool back when the window loses focus', () => {
    const { actions, shortcuts } = setup('pen')
    shortcuts.keydown(key(' '))
    shortcuts.keydown(key('e'))
    shortcuts.keyup(key(' '))
    expect(actions.tool).toBe('eraser')
    shortcuts.keydown(key(' '))
    expect(actions.tool).toBe(null)
    shortcuts.restore()
    expect(actions.tool).toBe('eraser')
  })

  it('leaves Space on a button outside the map to the button, and takes it on one inside', () => {
    const { actions, shortcuts } = setup('pen')
    const outside = key(' ', { target: { tagName: 'BUTTON' } as never })
    shortcuts.keydown(outside)
    expect(outside.prevented).toBe(false)
    expect(actions.tool).toBe('pen')
    // A keyup of a Space never taken is not taken either
    const up = key(' ')
    shortcuts.keyup(up)
    expect(up.prevented).toBe(false)
    // Space after clicking a toolbar button (focused, inside the map) does not press it again
    const inside = key(' ', { target: { tagName: 'BUTTON', inMap: true } as never })
    shortcuts.keydown(inside)
    expect(inside.prevented).toBe(true)
    expect(actions.tool).toBe(null)
  })

  it('listens to nothing until enabled, and to nothing again once disabled', () => {
    const target = new EventTarget()
    const actions = fakeActions('pen')
    const shortcuts = new KeyboardShortcuts(actions, target)
    const dispatch = (type: string, k: string): void => {
      target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false }))
    }
    expect(shortcuts.enabled).toBe(false)
    dispatch('keydown', 'e')
    expect(actions.calls).toEqual([])
    shortcuts.setEnabled(true)
    dispatch('keydown', 'e')
    expect(actions.tool).toBe('eraser')
    // Disabling while Space holds the hand gives the tool back and closes the list
    dispatch('keydown', ' ')
    actions.listOpen = true
    shortcuts.setEnabled(false)
    expect(actions.tool).toBe('eraser')
    expect(actions.listOpen).toBe(false)
    actions.calls.length = 0
    dispatch('keydown', 'p')
    dispatch('keyup', ' ')
    expect(actions.calls).toEqual([])
  })

  it('changes the pen width and the eraser radius by 1 px, stopping at their ranges', () => {
    const settings = new PenSettings({ pens: { pen: { width: MAX_WIDTH - 0.5 } }, eraser: { radius: MIN_ERASER_RADIUS + 0.5 } })
    changeToolSize(settings, 'pen', 1)
    expect(settings.pen('pen').width).toBe(MAX_WIDTH)
    changeToolSize(settings, 'pen', 1)
    expect(settings.pen('pen').width).toBe(MAX_WIDTH)
    changeToolSize(settings, 'eraser', -1)
    expect(settings.eraserRadius()).toBe(MIN_ERASER_RADIUS)
    changeToolSize(settings, 'eraser', 1)
    expect(settings.eraserRadius()).toBe(MIN_ERASER_RADIUS + 1)
    const highlighter = settings.pen('highlighter').width
    changeToolSize(settings, 'highlighter', -1)
    expect(settings.pen('highlighter').width).toBe(Math.max(MIN_WIDTH, highlighter - 1))
    // The hand and the lasso have no size
    changeToolSize(settings, null, 1)
    changeToolSize(settings, 'lasso', 1)
    expect(settings.eraserRadius()).toBe(MIN_ERASER_RADIUS + 1)
    expect(MAX_ERASER_RADIUS).toBeGreaterThan(MIN_ERASER_RADIUS)
  })

  it('lists Cmd on Apple platforms and Ctrl elsewhere', () => {
    expect(shortcutRows(true).find(([, what]) => what === 'Undo')?.[0]).toBe('⌘Z')
    expect(shortcutRows(false).find(([, what]) => what === 'Redo')?.[0]).toBe('Shift+Ctrl+Z / Ctrl+Y')
  })
})
