import type { StrokeData, StrokeStore } from './core/stroke'
import { inverse, type Matrix } from './core/transform'

/** Something the user did that can be undone as one step */
export type HistoryAction =
  // Strokes drawn
  | { type: 'draw'; strokes: StrokeData[] }
  // Strokes erased in one eraser gesture
  | { type: 'erase'; strokes: StrokeData[] }
  // The cuts of one partial eraser gesture, in the order they were made
  | { type: 'split'; cuts: Cut[] }
  // Strokes moved, scaled or rotated by `matrix` in one drag of the selection (only the ones it changed)
  | { type: 'transform'; ids: string[]; matrix: Matrix }

/** One stroke the partial eraser cut: it was removed, and its pieces (none when nothing of it stayed) added */
export type Cut = { removed: StrokeData; pieces: StrokeData[] }

/**
 * Undo / redo of this user's own actions. Undoing a stroke removes it, undoing an erase restores the erased
 * strokes, undoing a partial erase removes the pieces and restores the cut strokes, latest cut first, so a
 * piece cut again in the same gesture comes back before its own stroke does, and undoing a transform applies its
 * inverse. All through the store as local ops like any other edit.
 * An undo can fail quietly: a stroke someone else has erased in the meantime cannot be restored,
 * and the server takes it away again
 */
export class UndoHistory {
  private undoStack: HistoryAction[] = []
  private redoStack: HistoryAction[] = []

  constructor(
    private store: StrokeStore,
    private limit: number,
    /** Called whenever canUndo or canRedo may have changed */
    private onChange: () => void = () => {},
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Records a finished action. A new action makes the undone ones unreachable, so they are dropped */
  record(action: HistoryAction): void {
    this.undoStack.push(action)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
    this.onChange()
  }

  undo(): void {
    const action = this.undoStack.pop()
    if (!action) return
    let done: HistoryAction | null = action
    if (action.type === 'split') this.uncut(action.cuts)
    else if (action.type === 'transform') done = this.transform(action, inverse(action.matrix))
    else this.apply(action.strokes, action.type === 'draw' ? 'remove' : 'restore')
    if (done) this.redoStack.push(done)
    else if (this.holdsAny(action)) this.undoStack.push(action)
    this.onChange()
  }

  redo(): void {
    const action = this.redoStack.pop()
    if (!action) return
    let done: HistoryAction | null = action
    if (action.type === 'split') this.recut(action.cuts)
    else if (action.type === 'transform') done = this.transform(action, action.matrix)
    else this.apply(action.strokes, action.type === 'draw' ? 'restore' : 'remove')
    if (done) this.undoStack.push(done)
    else if (this.holdsAny(action)) this.redoStack.push(action)
    this.onChange()
  }

  /** Forgets everything, e.g. when the connection that could undo the removes on the server is gone */
  clear(): void {
    this.undoStack = []
    this.redoStack = []
    this.onChange()
  }

  private apply(strokes: StrokeData[], change: 'remove' | 'restore'): void {
    for (const stroke of strokes) {
      if (change === 'remove') this.store.apply({ type: 'remove', id: stroke.id }, 'local')
      else this.store.apply({ type: 'restore', stroke }, 'local')
    }
  }

  /**
   * Applies `matrix` to the action's strokes and returns the action for the other stack with only the strokes it
   * changed (one removed or moved out of reach meanwhile is left behind), or null when it changed none
   */
  private transform(action: { ids: string[]; matrix: Matrix }, matrix: Matrix): HistoryAction | null {
    const before = new Map(action.ids.map((id) => [id, this.store.get(id)?.points]))
    this.store.apply({ type: 'transform', ids: action.ids, matrix }, 'local')
    const ids = action.ids.filter((id) => {
      const points = this.store.get(id)?.points
      return points !== undefined && points !== before.get(id)
    })
    return ids.length > 0 ? { type: 'transform', ids, matrix: action.matrix } : null
  }

  /**
   * Whether a transform that changed nothing can still apply later: some of its strokes are held, only out of reach of
   * it now (moved by someone else to where it would leave the map or the zoom range). Then it stays where it was;
   * when none is held, it can never apply and is dropped
   */
  private holdsAny(action: HistoryAction): boolean {
    return action.type === 'transform' && action.ids.some((id) => this.store.get(id) !== undefined)
  }

  private uncut(cuts: Cut[]): void {
    for (const cut of [...cuts].reverse()) {
      this.apply(cut.pieces, 'remove')
      this.apply([cut.removed], 'restore')
    }
  }

  /** Redoes the cuts with remove and restore, which the server can undo again, rather than cutting anew */
  private recut(cuts: Cut[]): void {
    for (const cut of cuts) {
      this.apply([cut.removed], 'remove')
      this.apply(cut.pieces, 'restore')
    }
  }
}
