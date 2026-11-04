import { bucketOf, tileKey, type TileID } from './core/bucket'
import type { Point, StrokeData, StrokeOp, StrokeStore } from './core/stroke'
import { boundsOf, contains, grow, intersects, union, type Bounds } from './bounds'
import { mercatorPerPixelAt } from './mercator'
import { MeshBuffer, isTranslucent } from './MeshBuffer'
import { RunningMax } from './RunningMax'
import { RETESSELLATE_ZOOMS, appendSamples, detailZoom, type MeshWriter, type Samples } from './StrokeTessellator'
import type { BuildJob, BuildResult } from './TessellationWorker'
import { IDENTITY, compose, scaleOf, type Matrix } from './core/transform'
import type { Selection, SelectionChange } from './Selection'
import type { Prediction } from './Prediction'

// How many final segments of a stroke being drawn pile up behind its tail before they are tessellated
// into its fixed mesh. Bounds the work per frame: the tail never has more segments than this plus two
const FREEZE_SEGMENTS = 32

/** Tile-local units across one tile, as the tessellator writes positions (MapLibre's EXTENT) */
const TILE_EXTENT = 8192

/**
 * Depth resolution of the drawing order: the vertex shader gives consecutive orders depths 2^-ORDER_DEPTH_BITS
 * apart, so ORDER_DEPTH_BITS sits a little below the 24 bits of the depth buffer, leaving a margin for rounding.
 * 2^ORDER_DEPTH_BITS - 2 consecutive orders get depths of their own (see FrameDraws.orderBase)
 */
export const ORDER_DEPTH_BITS = 22

/** Where bucket builds are sent. TessellationWorker in the browser; a synchronous stand-in in tests */
export type BuildQueue = { build: (job: BuildJob) => void }

/**
 * One draw call: indices firstIndex .. firstIndex + indexCount of a mesh. `transform`, in the mesh tile's local
 * coordinates, moves the vertices before they are projected (the selection being dragged); none means identity
 */
export type DrawRange = {
  mesh: MeshBuffer
  firstIndex: number
  indexCount: number
  transform?: Matrix
}

/** A bucket's strokes as two meshes: opaque ones, whose order the depth test keeps, and translucent ones */
export type BucketMesh = { opaque: MeshBuffer; translucent: MeshBuffer }

/**
 * What to draw in one frame. Opaque strokes are drawn first with depth writes, in any order: each vertex's
 * order becomes its depth, so later strokes cover earlier ones. Translucent strokes are drawn after them,
 * in drawing order, with depth writes and a strictly-less test: they blend over what is under them, are hidden
 * by later opaque strokes, and each is painted once where it covers a pixel twice. In each list,
 * strokes being drawn come last
 */
export type FrameDraws = {
  opaque: DrawRange[]
  translucent: DrawRange[]
  /**
   * The order drawn deepest. Orders base .. base + 2^ORDER_DEPTH_BITS - 3 get depths of their own, and older
   * ones share the deepest. 0, the order of a stroke without one yet, is drawn in front of every stroke with an order
   */
  orderBase: number
}

/** Where some strokes are and how wide they get, for testing whether they can show on screen */
export type Extent = {
  // Bounds of the center lines
  bounds: Bounds
  // Widest line, in Web Mercator units (widths scale with the map)
  maxWidthMercator: number
}

/**
 * The extremes of a bucket's strokes, kept exact as strokes are added and removed, so the bucket's Extent
 * shrinks when a stroke is erased. The minima are held negated
 */
export type BucketExtremes = {
  negMinX: RunningMax
  negMinY: RunningMax
  maxX: RunningMax
  maxY: RunningMax
  width: RunningMax
}

/**
 * The finished strokes of one bucket (see core/bucket.ts), drawn from one mesh.
 * Its Extent covers the strokes it holds now, recomputed from `extremes` on every change
 */
export type Bucket = Extent & {
  tile: TileID
  strokes: Map<string, StrokeData>
  // Bounds of each stroke's center line, for leaving far strokes out of a build
  strokeBounds: Map<string, Bounds>
  // Width of each stroke on the map as it was filed, so it can be taken back out of `extremes` after the stroke
  // was transformed in place
  strokeWidths: Map<string, number>
  extremes: BucketExtremes
  // Changes on every change to strokes. The mesh shows the strokes as of meshVersion.
  // Drawn from one counter for the whole scene, so a bucket emptied and made again never reuses a version
  // and a build asked for by the earlier bucket cannot pass for a build of the new one
  version: number
  mesh: BucketMesh | null
  meshVersion: number
  // Zoom the mesh is tessellated for
  meshZoom: number
  // The area whose strokes the mesh holds; strokes wholly outside it were left out when it was built
  meshArea: Bounds | null
  // While the worker is building a mesh for the bucket, the area that build covers
  building: Bounds | null
}

/**
 * A stroke being drawn. A spline segment depends on the samples up to one past its end, so every segment
 * but the last two is final. Final ones are tessellated once into `frozen`, and only the tail after them
 * is tessellated again as the stroke grows
 */
export type HotStroke = Extent & {
  // Tessellation zoom. The state is started over when the stroke needs another one
  zoom: number
  translucent: boolean
  samples: Samples
  // How many of the stroke's points have been turned into samples
  sampled: number
  // The curve up to samples[frozenTo]
  frozen: MeshBuffer
  frozenTo: number
  // The curve from samples[frozenTo] to the end, then through the predicted points, and the
  // sample count and predicted points it was made for
  tail: MeshBuffer
  tailSamples: number
  tailPredicted: Point[] | undefined
}

/**
 * The selected strokes, taken out of their buckets and tessellated once into meshes of their
 * own, one pair per tile the strokes are filed under, so a drag only changes the transform they are drawn with
 */
type SelectionMeshes = {
  strokes: Map<string, StrokeData>
  meshes: (BucketMesh & { tile: TileID })[]
  // The transforms applied to the strokes since the meshes were made, in normalized Web Mercator coordinates
  applied: Matrix
  // Integer map zoom the meshes were made for
  zoom: number
  // Strokes left the selection since the meshes were made: they are made again on the next frame, once for all
  // the strokes that left meanwhile (a Delete of the whole selection removes them one by one)
  stale: boolean
}

/** A translucent mesh and what the draw plan needs of it: the area its strokes can cover, and their orders */
type PlanSource = {
  mesh: MeshBuffer
  area: Bounds
  strokes: ReadonlyMap<string, StrokeData>
}

/** The whole map: the area of the selection, which can be dragged anywhere without changing the draw plan */
const WORLD: Bounds = { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity }

/** Counters for the scale benchmark and the tests. Cumulative ones count from the scene's creation */
export type SceneStats = {
  /** Cumulative: vertices tessellated on the main thread */
  mainThreadVertices: number
  /** Cumulative: builds sent to the worker, and the points copied into them on the main thread */
  builds: number
  buildPoints: number
  /** Cumulative: times the draw plan was recomputed */
  planRebuilds: number
  /** Last frame: buckets looked at, and draw calls returned (opaque and translucent) */
  bucketsScanned: number
  drawCalls: number
  /** Now: finished strokes held, buckets, meshes holding any stroke, strokes being drawn */
  strokes: number
  buckets: number
  meshes: number
  hotStrokes: number
  /** Now: vertices in all meshes, and the bytes of their arrays as allocated and as used */
  meshVertices: number
  meshBytesAllocated: number
  meshBytesUsed: number
}

/**
 * What to draw: the strokes of a StrokeStore as meshes, and the draw calls that draw them in order.
 * Knows nothing of WebGL or of the MapLibre map, so it runs without a browser; StrokeLayer turns its
 * draw calls into GL calls.
 *
 * Finished strokes are grouped into buckets by the tile they were drawn on, and each bucket is one pair of meshes
 * (opaque and translucent strokes, see FrameDraws) in that tile's local coordinates. A bucket's mesh is made for one zoom and kept while the view stays within
 * RETESSELLATE_ZOOMS of it; after that the old mesh stays on screen while the build queue makes a new one.
 * Buckets near the view get meshes, and far ones drop theirs. A single finished or erased stroke changes
 * its bucket's mesh right away. Strokes being drawn are tessellated here, only their newest part each frame
 */
export class StrokeScene {
  private buckets = new Map<string, Bucket>()
  // Bucket key of each finished stroke
  private strokeBuckets = new Map<string, string>()
  // The strokes being drawn, by stroke ID. null until first tessellated
  private active = new Map<string, HotStroke | null>()
  private hotStale = false
  // Integer map zoom the strokes being drawn are tessellated for
  private hotZoom: number
  // Meshes no longer used, waiting for the renderer to free their GPU copies
  private retired: MeshBuffer[] = []
  // Bumped whenever a translucent stroke gets its place in the drawing order
  private orderRevision = 0
  // The lowest and highest orders seen, for FrameDraws.orderBase
  private orderMin = Infinity
  private orderMax = -Infinity
  // Source of bucket versions (see Bucket.version)
  private nextVersion = 1
  // The draw calls for the finished translucent strokes, and what they were planned from (see planDraws)
  private plan: DrawRange[] = []
  private planKey: {
    meshes: MeshBuffer[]
    revisions: number[]
    orderRevision: number
  } = {
    meshes: [],
    revisions: [],
    orderRevision: -1,
  }
  private unsubscribe: () => void
  private unsubscribeSelection: () => void = () => {}
  private unsubscribePrediction: () => void = () => {}
  private selected: SelectionMeshes = {
    strokes: new Map(),
    meshes: [],
    applied: IDENTITY,
    zoom: 0,
    stale: false,
  }
  private counters = {
    mainThreadVertices: 0,
    builds: 0,
    buildPoints: 0,
    planRebuilds: 0,
    bucketsScanned: 0,
    drawCalls: 0,
  }

  constructor(
    private store: StrokeStore,
    private writer: MeshWriter,
    private builds: BuildQueue,
    zoom: number,
    /** Called when something changed that needs a new frame */
    private onChange: () => void = () => {},
    /** The strokes selected with the lasso tool, drawn apart from their buckets */
    private selection: Selection | null = null,
    /** The browser's predicted points after the tips of the strokes being drawn, drawn after their tails only */
    private prediction: Prediction | null = null,
  ) {
    this.hotZoom = Math.floor(zoom)
    // The store does not say which strokes are finished. Ones still being drawn move over on their next points
    for (const stroke of store.values()) this.addToBucket(stroke, false)
    this.unsubscribe = store.subscribe(this.onOp)
    if (selection) {
      this.unsubscribeSelection = selection.subscribe(this.onSelection)
      this.syncSelection()
    }
    if (prediction) {
      this.unsubscribePrediction = prediction.subscribe(() => {
        this.hotStale = true
        this.onChange()
      })
    }
  }

  destroy(): void {
    this.unsubscribe()
    this.unsubscribeSelection()
    this.unsubscribePrediction()
  }

  private onSelection = (change: SelectionChange): void => {
    if (change === 'ids') this.syncSelection()
    this.onChange()
  }

  /**
   * Takes the strokes that became selected out of their buckets and puts the ones no longer selected back, then
   * tessellates the selected strokes into the selection meshes once. Only strokes with an order filed in a bucket can be
   * selected
   */
  private syncSelection(): void {
    const wanted = this.selection?.ids ?? new Set<string>()
    const { strokes } = this.selected
    let left = false
    let added = false
    for (const [id, stroke] of strokes) {
      if (wanted.has(id) && this.store.get(id) === stroke) continue
      strokes.delete(id)
      left = true
      // A stroke removed meanwhile stays out
      if (this.store.get(id) === stroke) this.addToBucket(stroke, true)
    }
    for (const id of wanted) {
      if (strokes.has(id) || !this.strokeBuckets.has(id)) continue
      const stroke = this.store.get(id)
      if (!stroke || stroke.order === undefined) continue
      this.removeFromBucket(id)
      strokes.set(id, stroke)
      added = true
    }
    // Strokes selected are tessellated now, before a drag starts; ones that only left wait for the next frame
    if (added) this.buildSelection()
    else if (left) this.selected.stale = true
  }

  /** Tessellates the selected strokes into new selection meshes, in drawing order, on this thread */
  private buildSelection(): void {
    const selected = this.selected
    for (const { opaque, translucent } of selected.meshes) this.retired.push(opaque, translucent)
    selected.meshes = []
    selected.applied = IDENTITY
    selected.zoom = this.hotZoom
    selected.stale = false
    const byTile = new Map<string, BucketMesh & { tile: TileID }>()
    const strokes = [...selected.strokes.values()].sort((a, b) => a.order! - b.order!)
    for (const stroke of strokes) {
      const tile = bucketOf(stroke.points[0], stroke.zoom)
      const key = tileKey(tile)
      let pair = byTile.get(key)
      if (!pair) {
        pair = { tile, opaque: new MeshBuffer(tile), translucent: new MeshBuffer(tile) }
        byTile.set(key, pair)
      }
      const mesh = isTranslucent(stroke.color) ? pair.translucent : pair.opaque
      const zoom = detailZoom(stroke, this.hotZoom)
      this.onMainThread(mesh, () => this.writer.appendStroke(mesh, stroke, zoom))
    }
    selected.meshes = [...byTile.values()]
  }

  /** The transform the selection meshes are drawn with: what was applied since they were made, then the drag */
  private selectionTransform(): Matrix {
    return compose(this.selection?.drag ?? IDENTITY, this.selected.applied)
  }

  /** Brings the meshes up to date for a view and returns what to draw (see FrameDraws) */
  frame(view: Bounds, zoom: number): FrameDraws {
    this.requestBuilds(view, zoom)
    this.updateHot(Math.floor(zoom))

    const isVisible = (extent: Extent): boolean => intersects(grow(extent.bounds, halfWidth(extent)), view)
    const buckets = [...this.buckets.values()].filter((bucket) => bucket.mesh && isVisible(bucket))
    const whole = (mesh: MeshBuffer): DrawRange => ({
      mesh,
      firstIndex: 0,
      indexCount: mesh.indexCount,
    })
    const opaque = buckets
      .map((bucket) => bucket.mesh!.opaque)
      .filter((mesh) => mesh.indexCount > 0)
      .map(whole)
    const sources: PlanSource[] = buckets
      .filter((bucket) => bucket.mesh!.translucent.indexCount > 0)
      .map((bucket) => ({
        mesh: bucket.mesh!.translucent,
        area: grow(bucket.bounds, halfWidth(bucket)),
        strokes: bucket.strokes,
      }))
    const selection = this.selected
    if (
      selection.stale ||
      (selection.strokes.size > 0 && Math.abs(Math.floor(zoom) - selection.zoom) >= RETESSELLATE_ZOOMS)
    ) {
      this.buildSelection()
    }
    for (const pair of selection.meshes) {
      if (pair.translucent.indexCount > 0) {
        sources.push({ mesh: pair.translucent, area: WORLD, strokes: selection.strokes })
      }
    }
    let translucent = [...this.planDraws(sources)]
    if (selection.meshes.length > 0) {
      // The plan is kept across a drag; only the transform its selection draws get changes
      const transform = this.selectionTransform()
      const tiles = new Map(selection.meshes.map((pair) => [pair.translucent, pair.tile]))
      translucent = translucent.map((draw) => {
        const tile = tiles.get(draw.mesh)
        return tile ? { ...draw, transform: tileLocal(transform, tile) } : draw
      })
      for (const pair of selection.meshes) {
        if (pair.opaque.indexCount === 0) continue
        opaque.push({ ...whole(pair.opaque), transform: tileLocal(transform, pair.tile) })
      }
    }
    for (const hot of this.active.values()) {
      if (!hot || !isVisible(hot)) continue
      ;(hot.translucent ? translucent : opaque).push(whole(hot.frozen), whole(hot.tail))
    }
    this.counters.bucketsScanned = this.buckets.size
    this.counters.drawCalls = opaque.length + translucent.length
    return { opaque, translucent, orderBase: this.orderBase() }
  }

  /** See FrameDraws.orderBase: the newest 2^ORDER_DEPTH_BITS - 2 orders seen get depths of their own */
  private orderBase(): number {
    if (this.orderMin === Infinity) return 1
    return Math.max(this.orderMin, this.orderMax - (2 ** ORDER_DEPTH_BITS - 3))
  }

  private noteOrder(order: number | undefined): void {
    if (order === undefined) return
    this.orderMin = Math.min(this.orderMin, order)
    this.orderMax = Math.max(this.orderMax, order)
  }

  /** Meshes no longer used since the last call, whose GPU copies can be freed */
  takeRetired(): MeshBuffer[] {
    return this.retired.splice(0)
  }

  /** Takes a finished build. One for strokes that changed since it was asked for is dropped and asked for again */
  onBuilt = (result: BuildResult): void => {
    const bucket = this.buckets.get(result.key)
    if (!bucket) return
    const area = bucket.building
    bucket.building = null
    if (result.version === bucket.version) {
      this.dropMesh(bucket)
      const mesh = {
        opaque: MeshBuffer.fromData(result.opaque),
        translucent: MeshBuffer.fromData(result.translucent),
      }
      // Strokes given an order while the build was under way still hold none in it
      const orderOf = (id: string): number => bucket.strokes.get(id)?.order ?? 0
      mesh.opaque.syncOrders(orderOf)
      mesh.translucent.syncOrders(orderOf)
      bucket.mesh = mesh
      bucket.meshVersion = result.version
      bucket.meshZoom = result.zoom
      bucket.meshArea = area
    }
    this.onChange()
  }

  stats(): SceneStats {
    let meshes = 0
    let meshVertices = 0
    let meshBytesAllocated = 0
    let meshBytesUsed = 0
    const allMeshes = [
      ...[...this.buckets.values()].flatMap((bucket) =>
        bucket.mesh ? [bucket.mesh.opaque, bucket.mesh.translucent] : [],
      ),
      ...[...this.active.values()].flatMap((hot) => (hot ? [hot.frozen, hot.tail] : [])),
      ...this.selected.meshes.flatMap((pair) => [pair.opaque, pair.translucent]),
    ]
    for (const mesh of allMeshes) {
      // A mesh with no stroke (most buckets' translucent one) holds no arrays
      if (!mesh || mesh.vertexCount === 0) continue
      meshes++
      meshVertices += mesh.vertexCount
      meshBytesAllocated += mesh.allocatedBytes()
      meshBytesUsed += mesh.usedBytes()
    }
    return {
      ...this.counters,
      strokes: this.strokeBuckets.size + this.selected.strokes.size,
      buckets: this.buckets.size,
      meshes,
      hotStrokes: this.active.size,
      meshVertices,
      meshBytesAllocated,
      meshBytesUsed,
    }
  }

  /** Read-only views of the state, for the tests' invariant checks */
  inspect(): {
    buckets: ReadonlyMap<string, Readonly<Bucket>>
    strokeBuckets: ReadonlyMap<string, string>
    active: ReadonlyMap<string, Readonly<HotStroke> | null>
    selected: ReadonlyMap<string, StrokeData>
    selectionMeshes: readonly Readonly<BucketMesh & { tile: TileID }>[]
  } {
    return {
      buckets: this.buckets,
      strokeBuckets: this.strokeBuckets,
      active: this.active,
      selected: this.selected.strokes,
      selectionMeshes: this.selected.meshes,
    }
  }

  /**
   * Draw calls that draw the finished translucent strokes of `buckets` in drawing order.
   * Order only matters where strokes can overlap, so buckets whose areas (grown by their line width) overlap
   * are grouped, and only within a group are the strokes merged into one sequence by order. Each run of strokes
   * that sit next to each other in one mesh becomes one draw call, so a bucket that no other overlaps, or whose
   * strokes do not interleave with its neighbors', is still one draw call.
   * The result is kept until the buckets, their meshes or the strokes' order changes
   */
  private planDraws(sources: PlanSource[]): DrawRange[] {
    const meshes = sources.map((source) => source.mesh)
    const revisions = meshes.map((mesh) => mesh.revision)
    const key = this.planKey
    const current =
      key.orderRevision === this.orderRevision &&
      key.meshes.length === meshes.length &&
      meshes.every((mesh, i) => key.meshes[i] === mesh && key.revisions[i] === revisions[i])
    if (current) return this.plan
    this.counters.planRebuilds++

    // Widths scale with the map, so the areas, and the groups, do not change with the zoom
    const areas = sources.map((source) => source.area)
    const groups = overlappingGroups(areas)

    const plan: DrawRange[] = []
    for (const group of groups) {
      // Every stroke of the group as (order, bucket, place in its mesh). Strokes without an order go last, in mesh order
      const strokes = group.flatMap((b) =>
        meshes[b].ranges.map((range, r) => ({
          order: sources[b].strokes.get(range.id)?.order ?? Infinity,
          b,
          r,
        })),
      )
      strokes.sort((p, q) => p.order - q.order || p.b - q.b || p.r - q.r)
      for (const { b, r } of strokes) {
        const mesh = meshes[b]
        const range = mesh.ranges[r]
        const last = plan.at(-1)
        if (last?.mesh === mesh && last.firstIndex + last.indexCount === range.firstIndex) {
          last.indexCount += range.indexCount
        } else {
          plan.push({
            mesh,
            firstIndex: range.firstIndex,
            indexCount: range.indexCount,
          })
        }
      }
    }
    this.plan = plan
    this.planKey = {
      meshes,
      revisions,
      orderRevision: this.orderRevision,
    }
    return plan
  }

  private onOp = (op: StrokeOp): void => {
    switch (op.type) {
      case 'begin':
        this.active.set(op.id, null)
        this.hotStale = true
        break
      case 'points':
        // A stroke that was taken for finished is still being drawn
        if (!this.active.has(op.id)) {
          this.removeFromBucket(op.id)
          this.active.set(op.id, null)
        }
        this.hotStale = true
        break
      case 'order': {
        // The stroke is in the store's data the buckets share. Its vertices get the order as their depth,
        // and a translucent stroke also moves in the draw plan
        this.noteOrder(op.order)
        const mesh = this.buckets.get(this.strokeBuckets.get(op.id) ?? '')?.mesh
        if (mesh && !mesh.opaque.setOrder(op.id, op.order)) {
          mesh.translucent.setOrder(op.id, op.order)
        }
        const stroke = this.store.get(op.id)
        if (stroke && isTranslucent(stroke.color)) this.orderRevision++
        break
      }
      case 'end': {
        if (!this.active.has(op.id)) break
        this.retireHot(op.id)
        const stroke = this.store.get(op.id)
        if (stroke) this.addToBucket(stroke, true)
        break
      }
      case 'remove':
        if (this.active.has(op.id)) this.retireHot(op.id)
        else if (this.selected.strokes.delete(op.id)) this.selected.stale = true
        else this.removeFromBucket(op.id)
        break
      case 'split':
        // The pieces show at once, like a restored stroke. They keep the stroke's order, so they draw where it did
        if (this.active.has(op.id)) this.retireHot(op.id)
        else if (this.selected.strokes.delete(op.id)) this.selected.stale = true
        else this.removeFromBucket(op.id)
        for (const piece of op.pieces) {
          const stroke = this.store.get(piece.id)
          if (stroke) this.addToBucket(stroke, true)
        }
        break
      case 'transform': {
        // The strokes were moved in place: filed strokes go to the bucket their new place gives, and the selection
        // meshes take the transform on when it moved the whole selection the same way
        const selection = this.selected.strokes
        let selectedMoved = 0
        for (const id of op.ids) {
          if (selection.has(id)) {
            selectedMoved++
            continue
          }
          const stroke = this.store.get(id)
          if (!stroke || !this.strokeBuckets.has(id)) continue
          this.removeFromBucket(id)
          this.addToBucket(stroke, true)
        }
        if (selectedMoved === 0) break
        // A scaled selection would lose detail (or carry too much), so it is tessellated again for its new size
        if (selectedMoved === selection.size && Math.abs(scaleOf(op.matrix) - 1) < 1e-9) {
          this.selected.applied = compose(op.matrix, this.selected.applied)
        } else {
          this.buildSelection()
        }
        break
      }
      case 'replace': {
        // Strokes set to another copy of them moved: like a transform with no one matrix for the selection
        let selectedMoved = false
        for (const stroke of op.strokes) {
          if (this.selected.strokes.has(stroke.id)) {
            selectedMoved = true
            continue
          }
          if (!this.strokeBuckets.has(stroke.id)) continue
          this.removeFromBucket(stroke.id)
          this.addToBucket(stroke, true)
        }
        if (selectedMoved) this.buildSelection()
        break
      }
      case 'reset':
        // The snapshot holds only strokes still being drawn
        for (const bucket of this.buckets.values()) this.dropMesh(bucket)
        for (const id of [...this.active.keys()]) this.retireHot(id)
        this.buckets.clear()
        this.strokeBuckets.clear()
        for (const stroke of op.strokes) this.active.set(stroke.id, null)
        this.hotStale = true
        this.selected.strokes.clear()
        this.selected.stale = true
        break
      case 'load':
        for (const stroke of op.strokes) this.addToBucket(stroke, false)
        break
      case 'restore':
        // Shown at once, like a stroke just finished
        this.addToBucket(op.stroke, true)
        break
    }
    this.onChange()
  }

  /**
   * Puts a finished stroke into its bucket. With `appendNow`, it is also tessellated into the bucket's mesh
   * here, so it shows at once; otherwise it waits for the bucket's next build
   */
  private addToBucket(stroke: StrokeData, appendNow: boolean): void {
    if (stroke.points.length === 0) return
    const tile = bucketOf(stroke.points[0], stroke.zoom)
    const key = tileKey(tile)
    // A stroke filed again (the same ID twice in one load) replaces the earlier copy, so its extent is counted once.
    // In the same bucket only the extent is taken back: the mesh is left alone, as a load leaves it
    const filedIn = this.strokeBuckets.get(stroke.id)
    if (filedIn !== undefined && filedIn !== key) this.removeFromBucket(stroke.id)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = {
        ...emptyExtent(),
        tile,
        strokes: new Map(),
        strokeBounds: new Map(),
        strokeWidths: new Map(),
        extremes: {
          negMinX: new RunningMax(),
          negMinY: new RunningMax(),
          maxX: new RunningMax(),
          maxY: new RunningMax(),
          width: new RunningMax(),
        },
        version: 0,
        mesh: null,
        meshVersion: -1,
        meshZoom: this.hotZoom,
        meshArea: null,
        building: null,
      }
      this.buckets.set(key, bucket)
    }
    const meshUpToDate = bucket.meshVersion === bucket.version
    const earlier = filedIn === key ? bucket.strokes.get(stroke.id) : undefined
    if (earlier) track(bucket, bucket.strokeBounds.get(stroke.id)!, bucket.strokeWidths.get(stroke.id)!, -1)
    const bounds = boundsOf(stroke.points)
    const width = widthMercator(stroke)
    this.noteOrder(stroke.order)
    bucket.strokes.set(stroke.id, stroke)
    bucket.strokeBounds.set(stroke.id, bounds)
    bucket.strokeWidths.set(stroke.id, width)
    bucket.version = this.nextVersion++
    track(bucket, bounds, width, 1)
    this.strokeBuckets.set(stroke.id, key)
    if (!appendNow) return

    // A new bucket gets its first mesh here, made for the zoom the stroke was just drawn at
    if (!bucket.mesh && bucket.strokes.size === 1) {
      bucket.mesh = { opaque: new MeshBuffer(tile), translucent: new MeshBuffer(tile) }
      bucket.meshZoom = this.hotZoom
      bucket.meshArea = bounds
    } else if (!bucket.mesh || !meshUpToDate) {
      return
    }
    const mesh = isTranslucent(stroke.color) ? bucket.mesh.translucent : bucket.mesh.opaque
    const zoom = detailZoom(stroke, bucket.meshZoom)
    this.onMainThread(mesh, () => this.writer.appendStroke(mesh, stroke, zoom))
    bucket.meshVersion = bucket.version
  }

  private removeFromBucket(id: string): void {
    const key = this.strokeBuckets.get(id)
    if (!key) return
    this.strokeBuckets.delete(id)
    const bucket = this.buckets.get(key)!
    const meshUpToDate = bucket.meshVersion === bucket.version
    // The extent decides how far from the view the mesh is kept, so it must not outlive the stroke
    track(bucket, bucket.strokeBounds.get(id)!, bucket.strokeWidths.get(id)!, -1)
    bucket.strokes.delete(id)
    bucket.strokeBounds.delete(id)
    bucket.strokeWidths.delete(id)
    bucket.version = this.nextVersion++
    if (bucket.strokes.size === 0) {
      this.dropMesh(bucket)
      this.buckets.delete(key)
      return
    }
    // Taken out of the mesh even when the mesh is behind, so an erased stroke never lingers until the rebuild
    const mesh = bucket.mesh
    const removed = mesh !== null && (mesh.opaque.removeStroke(id) || mesh.translucent.removeStroke(id))
    if (removed && meshUpToDate) {
      bucket.meshVersion = bucket.version
    }
  }

  /**
   * Asks for new meshes of the buckets near the view (within one screen) whose mesh is missing, behind their
   * strokes, made for a zoom RETESSELLATE_ZOOMS or more away, or missing strokes the view now reaches.
   * Until a mesh arrives the old one stays on screen. Buckets more than two screens away drop their meshes.
   * A build gets only the strokes within one screen of the view: a bucket from a shallow level can cover
   * many screens at the current zoom, and its far strokes would cost vertices and copying for nothing.
   * Distances count from the edge of the lines, not their center: widths scale with the map, so a line drawn
   * at a low zoom can cover the view while its center line is screens away
   */
  private requestBuilds(view: Bounds, zoom: number): void {
    const width = view.maxX - view.minX
    const height = view.maxY - view.minY
    const near = grow(view, width, height)
    const far = grow(view, 2 * width, 2 * height)
    for (const [key, bucket] of this.buckets) {
      const area = grow(bucket.bounds, halfWidth(bucket))
      if (!intersects(area, far)) {
        this.dropMesh(bucket)
        continue
      }
      if (bucket.building || !intersects(area, near)) continue
      // The mesh has every stroke the view can reach: the view is inside its area, or all strokes are
      const covered =
        bucket.meshArea !== null && (contains(bucket.meshArea, view) || contains(bucket.meshArea, bucket.bounds))
      const fresh =
        bucket.mesh !== null &&
        bucket.meshVersion === bucket.version &&
        Math.abs(zoom - bucket.meshZoom) < RETESSELLATE_ZOOMS &&
        covered
      if (fresh) continue
      bucket.building = near
      // In drawing order, so the mesh's ranges come out in that order and draw as one run
      const strokes = [...bucket.strokes.values()]
        .filter((stroke) => intersects(grow(bucket.strokeBounds.get(stroke.id)!, strokeHalfWidth(stroke)), near))
        .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || 0)
      this.counters.builds++
      for (const stroke of strokes) {
        this.counters.buildPoints += stroke.points.length
      }
      this.builds.build({
        key,
        version: bucket.version,
        tile: bucket.tile,
        zoom: Math.floor(zoom),
        strokes,
      })
    }
  }

  private dropMesh(bucket: Bucket): void {
    if (bucket.mesh) this.retired.push(bucket.mesh.opaque, bucket.mesh.translucent)
    bucket.mesh = null
    bucket.meshVersion = -1
    bucket.meshArea = null
  }

  /** Brings the strokes being drawn up to date, tessellating only what their new points changed */
  private updateHot(viewZoom: number): void {
    if (viewZoom !== this.hotZoom) {
      this.hotZoom = viewZoom
      this.hotStale = true
    }
    if (!this.hotStale) return
    for (const [id, previous] of this.active) {
      const stroke = this.store.get(id)
      if (stroke && stroke.points.length > 0) {
        this.active.set(id, this.updateHotStroke(stroke, previous))
      }
    }
    this.hotStale = false
  }

  private updateHotStroke(stroke: StrokeData, previous: HotStroke | null): HotStroke {
    const zoom = detailZoom(stroke, this.hotZoom)
    let hot = previous
    if (hot?.zoom !== zoom) {
      if (hot) this.retired.push(hot.frozen, hot.tail)
      const tile = bucketOf(stroke.points[0], stroke.zoom)
      hot = {
        ...emptyExtent(),
        zoom,
        translucent: isTranslucent(stroke.color),
        samples: { points: [] },
        sampled: 0,
        frozen: new MeshBuffer(tile),
        frozenTo: 0,
        tail: new MeshBuffer(tile),
        tailSamples: 0,
        tailPredicted: undefined,
      }
    }
    if (hot.sampled < stroke.points.length) {
      extend(hot, stroke, stroke.points.slice(hot.sampled))
      appendSamples(hot.samples, stroke, hot.sampled, zoom)
      hot.sampled = stroke.points.length
    }

    const { samples, frozen, tail } = hot
    const n = samples.points.length
    // The segments ending at or before samples[n - 2] have a real sample after them, so they are final
    if (n - 2 - hot.frozenTo >= FREEZE_SEGMENTS) {
      const from = hot.frozenTo
      // Round caps at both ends overlap the neighboring pieces; the stroke's single depth paints it once there
      this.onMainThread(frozen, () => {
        this.writer.appendPiece(frozen, stroke, samples, from, n - 2, zoom)
      })
      hot.frozenTo = n - 2
    }
    const predicted = this.prediction?.get(stroke.id)
    if (hot.tailSamples !== n || hot.tailPredicted !== predicted) {
      tail.clear()
      // Predicted points only lengthen the tail: the frozen part ends at samples[n - 2], which no predicted point
      // reaches, so it is made from real input alone
      if (predicted) extend(hot, stroke, predicted)
      const piece = predicted ? withPrediction(samples, hot.frozenTo, predicted, zoom) : { samples, from: hot.frozenTo }
      this.onMainThread(tail, () => {
        this.writer.appendPiece(tail, stroke, piece.samples, piece.from, piece.samples.points.length - 1, zoom)
      })
      hot.tailSamples = n
      hot.tailPredicted = predicted
    }
    return hot
  }

  private retireHot(id: string): void {
    const hot = this.active.get(id)
    if (hot) this.retired.push(hot.frozen, hot.tail)
    this.active.delete(id)
  }

  /** Runs a tessellation into `mesh` on this thread and counts the vertices it made */
  private onMainThread(mesh: MeshBuffer, tessellate: () => void): void {
    const before = mesh.vertexCount
    tessellate()
    this.counters.mainThreadVertices += mesh.vertexCount - before
  }
}

/**
 * A transform in normalized Web Mercator coordinates as one in the local coordinates of `tile` (EXTENT units across
 * it, from its corner): the linear part is the same, and the move is what the transform does to the tile's corner
 */
export function tileLocal(m: Matrix, tile: TileID): Matrix {
  const tiles = 2 ** tile.z
  const extent = TILE_EXTENT * tiles
  const ox = tile.x / tiles
  const oy = tile.y / tiles
  const [a, b, c, d, e, f] = m
  return [a, b, c, d, extent * (a * ox + c * oy + e - ox), extent * (b * ox + d * oy + f - oy)]
}

/** Indices of `areas` grouped so that areas overlapping each other, directly or through others, share a group */
function overlappingGroups(areas: Bounds[]): number[][] {
  // Union-find: parent[i] leads to the representative of i's group
  const parent = areas.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      if (intersects(areas[i], areas[j])) parent[find(i)] = find(j)
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < areas.length; i++) {
    const root = find(i)
    const group = groups.get(root)
    if (group) group.push(i)
    else groups.set(root, [i])
  }
  return [...groups.values()]
}

/** Half the widest line of an extent on screen, in Web Mercator units */
function halfWidth(extent: Extent): number {
  return extent.maxWidthMercator / 2
}

/** A stroke's line on screen, in Web Mercator units */
function widthMercator(stroke: StrokeData): number {
  return stroke.width * mercatorPerPixelAt(stroke.zoom)
}

/** Half a stroke's line on screen, in Web Mercator units */
function strokeHalfWidth(stroke: StrokeData): number {
  return widthMercator(stroke) / 2
}

/**
 * The samples of a stroke's tail, from samples[from - 1] (which shapes its start) on, followed by the predicted points
 * far enough apart to sample (appendSamples), at the last sample's width coefficient. Copies only the tail, which
 * FREEZE_SEGMENTS bounds, and returns where the tail starts in the copy
 */
function withPrediction(
  samples: Samples,
  from: number,
  predicted: Point[],
  zoom: number,
): { samples: Samples; from: number } {
  const start = Math.max(0, from - 1)
  const tip: Samples = { points: samples.points.slice(start) }
  if (samples.pressure) tip.pressure = samples.pressure.slice(start)
  const coefficient = samples.pressure?.at(-1)
  appendSamples(
    tip,
    coefficient === undefined
      ? { points: predicted }
      : { points: predicted, pressure: predicted.map(() => coefficient) },
    0,
    zoom,
  )
  return { samples: tip, from: from - start }
}

function emptyExtent(): Extent {
  return { bounds: boundsOf([]), maxWidthMercator: 0 }
}

/** Grows an extent to cover `points` of `stroke` */
function extend(extent: Extent, stroke: StrokeData, points: Point[]): void {
  extent.bounds = union(extent.bounds, boundsOf(points))
  extent.maxWidthMercator = Math.max(extent.maxWidthMercator, widthMercator(stroke))
}

/**
 * Adds (`sign` 1) or removes (`sign` -1) a stroke's center line bounds and width in a bucket's extremes,
 * and sets the bucket's Extent from them
 */
function track(bucket: Bucket, bounds: Bounds, width: number, sign: 1 | -1): void {
  const { negMinX, negMinY, maxX, maxY, width: widths } = bucket.extremes
  const apply = (extreme: RunningMax, value: number): void => {
    if (sign > 0) extreme.add(value)
    else extreme.remove(value)
  }
  apply(negMinX, -bounds.minX)
  apply(negMinY, -bounds.minY)
  apply(maxX, bounds.maxX)
  apply(maxY, bounds.maxY)
  apply(widths, width)
  bucket.bounds = {
    minX: -negMinX.max(),
    minY: -negMinY.max(),
    maxX: maxX.max(),
    maxY: maxY.max(),
  }
  bucket.maxWidthMercator = Math.max(0, widths.max())
}
