// Stroke data and the operations (ops) that modify it.
// Used by the input, render and sync layers and by the Worker, so it must not depend on DOM / MapLibre / Cloudflare APIs.
import { pieceStroke, validPieces, type StrokePiece } from "./split";
import { isSimilarity, transformStroke, type Matrix } from "./transform";

/** Normalized Web Mercator coordinates (0 to 1) */
export type Point = [x: number, y: number];

/** A stroke, finished or still being drawn */
export type StrokeData = {
  id: string;
  author: string;
  color: string;
  width: number;
  zoom: number;
  points: Point[];
  /**
   * Width coefficient at each point, 0 to 1 (same length as points): the stroke is `width * pressure[i]` wide there.
   * Missing for a stroke drawn without pressure, which is `width` wide everywhere
   */
  pressure?: number[];
  /**
   * Position in the drawing order, an integer from 1 to MAX_ORDER: later strokes are drawn over earlier ones.
   * Missing until the stroke gets one (an order op; see StrokeOrderMode for who applies it). Only strokes with an
   * order can be selected, transformed, cut or exported
   */
  order?: number;
};

export type StrokeOp =
  | {
      type: "begin";
      id: string;
      author: string;
      color: string;
      width: number;
      zoom: number;
    }
  // ps: the width coefficient of each of pts, for a stroke drawn with pressure. A stroke's first points op decides
  // whether it has pressure; every later one must agree
  | { type: "points"; id: string; pts: Point[]; ps?: number[] }
  | { type: "end"; id: string }
  // Gives the stroke its place in the drawing order (an integer from 1 to MAX_ORDER)
  | { type: "order"; id: string; order: number }
  // Erases a whole stroke, whether it is finished or still being drawn
  | { type: "remove"; id: string }
  // Cuts a stroke with an order (partial eraser): removes it and adds its pieces, which keep its place in the drawing order.
  // Any client may cut anyone's stroke, like remove
  | { type: "split"; id: string; pieces: StrokePiece[] }
  // Moves, scales and rotates strokes (core/transform). Strokes not here, without an order yet, or that the
  // transform would take off the map or out of the zoom range are left as they are. Listeners get only the IDs
  // that changed; the strokes are updated in place (points replaced, zoom changed)
  | { type: "transform"; ids: string[]; matrix: Matrix }
  // Sets strokes held here to the server's copy of them: its points and zoom, which transforms change. The
  // server's word wins over what was applied here, so every client ends with the same strokes. Strokes not held,
  // without an order, with another number of points, or already the same are skipped. Listeners get the store's strokes
  // that changed, updated in place like transform
  | { type: "replace"; strokes: StrokeData[] }
  // Brings back a stroke that was removed (undo of an erase, redo of a stroke)
  | { type: "restore"; stroke: StrokeData }
  // Replaces everything. Used for the snapshot on connect
  | { type: "reset"; strokes: StrokeData[] }
  // Adds strokes not in the store yet, e.g. strokes loaded per tile
  | { type: "load"; strokes: StrokeData[] };

/** The largest order a stroke can have: orders are uint32 vertex attributes (decision 0024) */
export const MAX_ORDER = 2 ** 32 - 1;

/** Whether `order` can be a stroke's place in the drawing order: an integer from 1 to MAX_ORDER */
export function validOrder(order: number): boolean {
  return Number.isInteger(order) && order >= 1 && order <= MAX_ORDER;
}

/**
 * Who gives strokes their order (decision 0091).
 * default: the store does. Right after a stroke's end, a stroke with points and no order gets the next value of
 * the store's counter, which starts at 1 and never goes down, by an order op applied with the end's origin. The
 * strokes a load or reset brings in get the next values in the order the op lists them, whatever order they held,
 * so no order is handed out twice.
 * custom: the store never gives an order; the caller applies order ops (e.g. the sync layer, from the server)
 */
export type StrokeOrderMode = "default" | "custom";

export type StrokeStoreOptions = {
  /** Who gives strokes their order; 'default' when omitted */
  order?: StrokeOrderMode;
};

/**
 * local: drawn on this screen / remote: received from the server / preview: shown on this screen only, never sent
 * (e.g. the partial eraser's cuts while the pointer is down)
 */
export type Origin = "local" | "remote" | "preview";

export type StrokeListener = (op: StrokeOp, origin: Origin) => void;

/**
 * Holds the list of strokes, applies ops and notifies subscribers.
 * Both our own ops and others' ops go through apply, so the render layer does not care where an op came from.
 */
export class StrokeStore {
  private strokes = new Map<string, StrokeData>();
  private listeners = new Set<StrokeListener>();
  private readonly orderMode: StrokeOrderMode;
  /** The order the default mode gives next */
  private nextOrder = 1;

  constructor(options: StrokeStoreOptions = {}) {
    const mode = options.order ?? "default";
    if (mode !== "default" && mode !== "custom") throw new RangeError(`unknown order mode: ${String(mode)}`);
    this.orderMode = mode;
  }

  /** Ignores ops that cannot be applied (e.g. points for an unknown ID) and returns false */
  apply(op: StrokeOp, origin: Origin): boolean {
    switch (op.type) {
      case "begin": {
        if (this.strokes.has(op.id)) return false;
        const { type: _, ...rest } = op;
        this.strokes.set(op.id, { ...rest, points: [] });
        break;
      }
      case "points": {
        // Ignore strokes whose begin we never received, e.g. when joining mid-stroke
        const stroke = this.strokes.get(op.id);
        if (!stroke || !appendPoints(stroke, op.pts, op.ps)) return false;
        break;
      }
      case "end":
        if (!this.strokes.has(op.id)) return false;
        break;
      case "order": {
        const stroke = this.strokes.get(op.id);
        if (!stroke || !validOrder(op.order)) return false;
        stroke.order = op.order;
        break;
      }
      case "remove":
        if (!this.strokes.delete(op.id)) return false;
        break;
      // Listeners find the pieces in the store by their IDs
      case "split": {
        const { id, pieces } = op;
        const stroke = this.strokes.get(id);
        if (!stroke || !validPieces(pieces, stroke.points.length)) return false;
        if (pieces.some((piece) => this.strokes.has(piece.id) || piece.id === id)) return false;
        if (new Set(pieces.map((piece) => piece.id)).size !== pieces.length) return false;
        this.strokes.delete(id);
        for (const piece of pieces) this.strokes.set(piece.id, pieceStroke(stroke, piece));
        break;
      }
      case "transform": {
        if (!isSimilarity(op.matrix)) return false;
        const changed: string[] = [];
        for (const id of new Set(op.ids)) {
          const stroke = this.strokes.get(id);
          if (!stroke || stroke.order === undefined) continue;
          const moved = transformStroke(stroke, op.matrix);
          if (!moved) continue;
          stroke.points = moved.points;
          stroke.zoom = moved.zoom;
          changed.push(id);
        }
        if (changed.length === 0) return false;
        op = { type: "transform", ids: changed, matrix: op.matrix };
        break;
      }
      case "replace": {
        const changed: StrokeData[] = [];
        for (const { id, points, zoom } of op.strokes) {
          const stroke = this.strokes.get(id);
          if (!stroke || stroke.order === undefined || stroke.points.length !== points.length) continue;
          if (stroke.zoom === zoom && samePoints(stroke.points, points)) continue;
          stroke.points = points.map(([x, y]): Point => [x, y]);
          stroke.zoom = zoom;
          changed.push(stroke);
        }
        if (changed.length === 0) return false;
        op = { type: "replace", strokes: changed };
        break;
      }
      // The store keeps its own copies of strokes handed in, and passes those copies on, so listeners hold
      // the same objects the store later updates (e.g. on an order op). Strokes with an order out of range are
      // dropped
      case "restore": {
        if (this.strokes.has(op.stroke.id) || !hasValidOrder(op.stroke)) return false;
        const stroke = this.keep(op.stroke);
        op = { type: "restore", stroke };
        break;
      }
      case "reset":
        this.strokes.clear();
        op = { type: "reset", strokes: op.strokes.filter(hasValidOrder).map((stroke) => this.keepOrdered(stroke)) };
        break;
      case "load": {
        // Tiles overlap and may be loaded again, so only the new strokes are added and passed on
        const added = op.strokes.filter((stroke) => !this.strokes.has(stroke.id) && hasValidOrder(stroke));
        if (added.length === 0) return false;
        op = { type: "load", strokes: added.map((stroke) => this.keepOrdered(stroke)) };
        break;
      }
    }
    for (const listener of this.listeners) listener(op, origin);
    if (op.type === "end" && this.orderMode === "default") {
      // Looked up again: a listener may have removed the stroke
      const stroke = this.strokes.get(op.id);
      if (stroke && stroke.order === undefined && stroke.points.length > 0) {
        this.apply({ type: "order", id: op.id, order: this.takeOrder() }, origin);
      }
    }
    return true;
  }

  /** The default mode's next order; the counter never goes down */
  private takeOrder(): number {
    return this.nextOrder++;
  }

  /** Stores a copy of a stroke handed in from outside and returns the copy */
  private keep(stroke: StrokeData): StrokeData {
    const copy = { ...stroke, points: [...stroke.points] };
    if (stroke.pressure) copy.pressure = [...stroke.pressure];
    this.strokes.set(copy.id, copy);
    return copy;
  }

  /** keep, with the next order of the counter in the default mode (load and reset) */
  private keepOrdered(stroke: StrokeData): StrokeData {
    const copy = this.keep(stroke);
    if (this.orderMode === "default") copy.order = this.takeOrder();
    return copy;
  }

  get(id: string): StrokeData | undefined {
    return this.strokes.get(id);
  }

  values(): IterableIterator<StrokeData> {
    return this.strokes.values();
  }

  /** Call the returned function to unsubscribe */
  subscribe(listener: StrokeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Whether a stroke's order, when it has one, is in range */
function hasValidOrder(stroke: StrokeData): boolean {
  return stroke.order === undefined || validOrder(stroke.order);
}

function samePoints(a: readonly Point[], b: readonly Point[]): boolean {
  return a.every(([x, y], i) => x === b[i][0] && y === b[i][1]);
}

/**
 * Appends points, and their width coefficients, to a stroke. Returns false, changing nothing, when the lengths differ
 * or the op disagrees with the stroke's earlier points about having pressure
 */
export function appendPoints(stroke: StrokeData, pts: Point[], ps: number[] | undefined): boolean {
  if (ps) {
    if (ps.length !== pts.length) return false;
    if (stroke.pressure) stroke.pressure.push(...ps);
    else if (stroke.points.length === 0) stroke.pressure = [...ps];
    else return false;
  } else if (stroke.pressure) {
    return false;
  }
  stroke.points.push(...pts);
  return true;
}
