import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MapLibreMap,
  type RendererProjectionData,
} from 'maplibre-gl'
import type { TileID } from './core/bucket'
import type { StrokeStore } from './core/stroke'
import { IDENTITY, scaleOf, type Matrix } from './core/transform'
import { mercatorPerPixel, visibleBounds } from './mapProjector'
import { GEOMETRY_FLOATS, MeshBuffer } from './MeshBuffer'
import type { Prediction } from './Prediction'
import type { Selection } from './Selection'
import { StrokeScene, type DrawRange } from './StrokeScene'
import type { StrokeTessellator } from './StrokeTessellator'
import { asError } from './reportError'
import { TessellationWorker, type WorkerLocation } from './TessellationWorker'
import { compositeFragmentSource, compositeVertexSource, fragmentSource, vertexSource } from './shaders'

type Program = {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
}

type GpuBuffer = { buffer: WebGLBuffer; uploadedBytes: number }

/** GPU copy of one MeshBuffer */
type GpuMesh = {
  vao: WebGLVertexArrayObject
  geometry: GpuBuffer
  colors: GpuBuffer
  widths: GpuBuffer
  zooms: GpuBuffer
  orders: GpuBuffer
  indices: GpuBuffer
  // Filled only while the wireframe debug view is on
  edges: WebGLBuffer
}

/**
 * The layer's own framebuffer, the size of the drawing buffer. The strokes are drawn here with a depth buffer
 * of their own, because MapLibre lends a 2D custom layer a single depth value (see FrameDraws in StrokeScene.ts),
 * and the result is then copied onto the map. It takes as many samples as the map's own framebuffer, so lines
 * are antialiased when the map is: then the strokes are drawn into multisampled renderbuffers (`draw`) and
 * resolved into the texture (`resolve`) once per frame
 */
type Target = {
  draw: WebGLFramebuffer
  resolve: WebGLFramebuffer
  color: WebGLTexture
  renderbuffers: WebGLRenderbuffer[]
  width: number
  height: number
  samples: number
}

/** The program that copies the Target onto the map, and the empty VAO it draws with */
type Composite = {
  program: WebGLProgram
  strokes: WebGLUniformLocation | null
  vao: WebGLVertexArrayObject
}

// Names of the uniforms. The projection ones are set per tile from options.getProjectionData,
// and the ones the current projection does not use resolve to null and are ignored
const UNIFORM_NAMES = [
  'u_viewport',
  'u_pixel_ratio',
  'u_mercator_to_screen',
  'u_zoom',
  'u_order_base',
  'u_linear',
  'u_translate',
  'u_scale',
  'u_wireframe',
  'u_projection_matrix',
  'u_projection_fallback_matrix',
  'u_projection_tile_mercator_coords',
  'u_projection_clipping_plane',
  'u_projection_transition',
] as const

/**
 * Whether the map's style holds this very layer: MapLibre wraps a custom layer it adds in a CustomStyleLayer that keeps
 * it as `implementation`. The ID alone may be another layer's, e.g. one added after a style rebuilt without this one
 */
export function holdsLayer(map: MapLibreMap, layer: CustomLayerInterface): boolean {
  const styleLayer = map.getLayer(layer.id)
  return styleLayer !== undefined && 'implementation' in styleLayer && styleLayer.implementation === layer
}

export type StrokeLayerOptions = WorkerLocation & {
  /** The layer's ID in the map style */
  id: string
  /** The strokes selected with the lasso tool, drawn apart and moved while they are dragged */
  selection?: Selection
  /** The browser's predicted points after the tips of the strokes being drawn */
  prediction?: Prediction
  /**
   * Called once for each worker an onAdd makes, on the map of that onAdd: with null once the worker has loaded its
   * WebAssembly module, or with the error when the worker could not be made or its script or module failed to load.
   * After a failure the layer has let go of its scene and worker, draws nothing, and makes neither again
   */
  onLoad: (error: Error | null, map: MapLibreMap) => void
}

/**
 * MapLibre custom layer that draws the strokes in a StrokeStore with WebGL.
 * What to draw, and in which order, comes from a StrokeScene (see there); this class owns the GPU copies
 * of the scene's meshes, the shader program and the draw calls, and runs bucket builds on a Web Worker.
 * GL resources are created lazily in render, because MapLibre resets its cached GL state only after render.
 *
 * MapLibre does not call onRemove when it rebuilds the style (setStyle without a diff) or when the map is removed,
 * so an onAdd may come while the last one's scene, worker and GPU resources are still held: they are freed first.
 * dispose frees them when the layer is no longer on the map's style and onRemove will not come.
 *
 * onAdd throws nothing of its own: a worker that cannot be made goes to options.onLoad, as one that fails to load
 */
export class StrokeLayer implements CustomLayerInterface {
  readonly id: string
  readonly type = 'custom'
  readonly renderingMode = '2d'

  private map: MapLibreMap | null = null
  // The context onAdd was given, which render creates the GPU resources on, to free them with when onRemove does not come
  private gl: WebGL2RenderingContext | null = null
  private worker: TessellationWorker | null = null
  private currentScene: StrokeScene | null = null
  // One program per projection variant (mercator, globe), since the shader prelude differs
  private programs = new Map<string, Program>()
  // GPU copies of the meshes drawn so far
  private gpu = new Map<MeshBuffer, GpuMesh>()
  private target: Target | null = null
  private composite: Composite | null = null
  // Debug view: draws the outlines of the tessellated triangles over the strokes
  private wireframe = false
  // A worker failed to load (options.onLoad): the layer stays empty from then on
  private failed = false

  constructor(
    private store: StrokeStore,
    private tessellator: StrokeTessellator,
    private options: StrokeLayerOptions,
  ) {
    this.id = options.id
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    // Added again without onRemove (a style rebuilt): the last scene, worker and GPU resources go first
    this.release()
    if (this.failed) return
    this.map = map
    this.gl = gl
    const repaint = (): void => map.triggerRepaint()
    let worker: TessellationWorker
    try {
      worker = new TessellationWorker(
        (result) => scene.onBuilt(result),
        (error) => this.loaded(error, map),
        this.options,
      )
    } catch (error) {
      this.loaded(asError(error), map)
      return
    }
    const scene = new StrokeScene(
      this.store,
      this.tessellator,
      worker,
      map.getZoom(),
      repaint,
      this.options.selection ?? null,
      this.options.prediction ?? null,
    )
    this.worker = worker
    this.currentScene = scene
  }

  /** A worker's load, from onAdd: a failure lets go of everything and leaves the layer empty for good */
  private loaded(error: Error | null, map: MapLibreMap): void {
    if (error) {
      this.failed = true
      this.release()
      // What the scene drew last goes too
      map.triggerRepaint()
    }
    this.options.onLoad(error, map)
  }

  /** Development builds only (debug.ts); the package never draws the wireframe */
  setWireframe(wireframe: boolean): void {
    this.wireframe = wireframe
    this.map?.triggerRepaint()
  }

  /** The scene while the layer is on a map. For createHandwriting's debug accessors; not exported from the package */
  get scene(): StrokeScene | null {
    return this.currentScene
  }

  onRemove(): void {
    this.release()
  }

  /**
   * Frees what the last onAdd made, as onRemove does, for a layer no longer on the map's style that onRemove will not
   * reach (a style rebuilt without it, or a removed map). The layer can be added again afterwards
   */
  dispose(): void {
    this.release()
  }

  /** Frees the scene (its store subscription), the worker and the GPU resources, with the context onAdd was given */
  private release(): void {
    this.currentScene?.destroy()
    this.worker?.terminate()
    const gl = this.gl
    if (gl) {
      for (const mesh of [...this.gpu.keys()]) this.deleteGpu(gl, mesh)
      for (const { program } of this.programs.values()) gl.deleteProgram(program)
      if (this.target) deleteTarget(gl, this.target)
      if (this.composite) {
        gl.deleteProgram(this.composite.program)
        gl.deleteVertexArray(this.composite.vao)
      }
    }
    this.gpu.clear()
    this.programs.clear()
    this.target = null
    this.composite = null
    this.currentScene = null
    this.worker = null
    this.map = null
    this.gl = null
  }

  /**
   * Draws the strokes into the layer's own framebuffer: opaque ones with depth writes, translucent ones after them
   * without, each in the order FrameDraws gives. Then copies the result onto the map with the depth state MapLibre
   * set up for this layer, so other layers stay above or below it as before
   */
  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const map = this.map
    const scene = this.currentScene
    // Nothing once a worker failed to load
    if (!map || !scene) return
    const zoom = map.getZoom()
    const frame = scene.frame(visibleBounds(map), zoom)
    for (const mesh of scene.takeRetired()) this.deleteGpu(gl, mesh)
    const draws = [...frame.opaque, ...frame.translucent]
    if (draws.length === 0) return

    // What MapLibre set up for this layer, for the copy onto the map
    const outer = {
      framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
      samples: gl.getParameter(gl.SAMPLES) as number,
      viewport: gl.getParameter(gl.VIEWPORT) as Int32Array,
      depthRange: gl.getParameter(gl.DEPTH_RANGE) as Float32Array,
      depthFunc: gl.getParameter(gl.DEPTH_FUNC) as GLenum,
      depthTest: gl.isEnabled(gl.DEPTH_TEST),
    }
    const target = this.targetOf(gl, outer.samples)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.draw)
    gl.viewport(0, 0, target.width, target.height)
    gl.depthRange(0, 1)
    gl.depthMask(true)
    gl.clearColor(0, 0, 0, 0)
    gl.clearDepth(1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    // Premultiplied alpha, as the fragment shader writes and as the copy onto the map expects
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    const { program, uniforms } = this.getProgram(gl, options.shaderData)
    gl.useProgram(program)
    gl.uniform2f(uniforms.u_viewport, target.width, target.height)
    gl.uniform1f(uniforms.u_pixel_ratio, map.getPixelRatio())
    gl.uniformMatrix2fv(uniforms.u_mercator_to_screen, false, mercatorToScreen(map))
    gl.uniform1f(uniforms.u_zoom, zoom)
    gl.uniform1ui(uniforms.u_order_base, frame.orderBase)

    const meshes = new Set(draws.map((draw) => draw.mesh))
    for (const mesh of meshes) upload(gl, mesh, this.gpuOf(gl, mesh))
    const setTile = (tile: TileID): void =>
      setProjection(
        gl,
        uniforms,
        // Same flag as for defaultProjectionData, so globe projection follows the globe transition
        options.getProjectionData({
          tileID: { canonical: tile },
          applyGlobeMatrix: true,
        }),
      )
    gl.uniform1i(uniforms.u_wireframe, 0)
    const setTransform = (m: Matrix): void => {
      gl.uniformMatrix2fv(uniforms.u_linear, false, [m[0], m[1], m[2], m[3]])
      gl.uniform2f(uniforms.u_translate, m[4], m[5])
      gl.uniform1f(uniforms.u_scale, scaleOf(m))
    }
    this.drawRanges(gl, frame.opaque, 'triangles', setTile, setTransform)
    // Translucent strokes write depth and pass only a strictly nearer one: all vertices of a stroke share
    // its depth, so a pixel the stroke covers twice (a tight turn, a loop, the round caps of a hot
    // stroke's sections) is painted once. Later strokes are nearer and still blend over earlier ones;
    // the draw plan keeps translucent ranges in drawing order, which this depends on
    gl.depthFunc(gl.LESS)
    this.drawRanges(gl, frame.translucent, 'triangles', setTile, setTransform)
    // The copy onto the map leaves the map's depth alone
    gl.depthMask(false)
    if (__HANDWRITING_DEBUG__ && this.wireframe) {
      for (const mesh of meshes) uploadEdges(gl, mesh, this.gpu.get(mesh)!)
      gl.disable(gl.DEPTH_TEST)
      gl.uniform1i(uniforms.u_wireframe, 1)
      this.drawRanges(gl, draws, 'edges', setTile, setTransform)
    }

    if (target.samples > 0) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.draw)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.resolve)
      const { width, height } = target
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, outer.framebuffer)
    gl.viewport(outer.viewport[0], outer.viewport[1], outer.viewport[2], outer.viewport[3])
    gl.depthRange(outer.depthRange[0], outer.depthRange[1])
    gl.depthFunc(outer.depthFunc)
    if (outer.depthTest) gl.enable(gl.DEPTH_TEST)
    else gl.disable(gl.DEPTH_TEST)
    const composite = this.compositeOf(gl)
    gl.useProgram(composite.program)
    gl.bindVertexArray(composite.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, target.color)
    gl.uniform1i(composite.strokes, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindVertexArray(null)
  }

  /** The layer's own framebuffer, made again when the drawing buffer's size or the map's sample count changed */
  private targetOf(gl: WebGL2RenderingContext, mapSamples: number): Target {
    const width = gl.drawingBufferWidth
    const height = gl.drawingBufferHeight
    const samples = Math.min(mapSamples, gl.getParameter(gl.MAX_SAMPLES) as number)
    const current = this.target
    if (current && current.width === width && current.height === height && current.samples === samples) {
      return current
    }
    if (current) deleteTarget(gl, current)
    const color = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, color)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.bindTexture(gl.TEXTURE_2D, null)
    const renderbuffer = (format: GLenum): WebGLRenderbuffer => {
      const buffer = gl.createRenderbuffer()
      gl.bindRenderbuffer(gl.RENDERBUFFER, buffer)
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, format, width, height)
      gl.bindRenderbuffer(gl.RENDERBUFFER, null)
      return buffer
    }
    const depth = renderbuffer(gl.DEPTH_COMPONENT24)
    const resolve = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolve)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0)
    let draw = resolve
    const renderbuffers = [depth]
    if (samples > 0) {
      const multisampled = renderbuffer(gl.RGBA8)
      renderbuffers.push(multisampled)
      draw = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, draw)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, multisampled)
    }
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth)
    this.target = { draw, resolve, color, renderbuffers, width, height, samples }
    return this.target
  }

  private compositeOf(gl: WebGL2RenderingContext): Composite {
    if (this.composite) return this.composite
    const program = link(gl, compositeVertexSource, compositeFragmentSource)
    this.composite = {
      program,
      strokes: gl.getUniformLocation(program, 'u_strokes'),
      vao: gl.createVertexArray(),
    }
    return this.composite
  }

  private gpuOf(gl: WebGL2RenderingContext, mesh: MeshBuffer): GpuMesh {
    let gpu = this.gpu.get(mesh)
    if (!gpu) {
      gpu = createGpuMesh(gl)
      this.gpu.set(mesh, gpu)
    }
    return gpu
  }

  /** Draws each range's triangles, or their edges as lines, in the given order. The meshes must be uploaded */
  private drawRanges(
    gl: WebGL2RenderingContext,
    draws: DrawRange[],
    primitive: 'triangles' | 'edges',
    setTile: (tile: TileID) => void,
    setTransform: (m: Matrix) => void,
  ): void {
    const edges = primitive === 'edges'
    let transform: Matrix = IDENTITY
    setTransform(transform)
    // The edge list has two entries per triangle index
    const scale = edges ? 2 : 1
    let tile: TileID | null = null
    for (const { mesh, firstIndex, indexCount, transform: next = IDENTITY } of draws) {
      if (indexCount === 0) continue
      if (next !== transform) setTransform((transform = next))
      const gpu = this.gpu.get(mesh)!
      gl.bindVertexArray(gpu.vao)
      // The element array binding is part of the VAO, so this picks which index list it draws
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, edges ? gpu.edges : gpu.indices.buffer)
      if (mesh.tile !== tile) setTile((tile = mesh.tile))
      gl.drawElements(
        edges ? gl.LINES : gl.TRIANGLES,
        indexCount * scale,
        gl.UNSIGNED_INT,
        firstIndex * scale * Uint32Array.BYTES_PER_ELEMENT,
      )
    }
  }

  private deleteGpu(gl: WebGL2RenderingContext, mesh: MeshBuffer): void {
    const gpu = this.gpu.get(mesh)
    if (!gpu) return
    gl.deleteVertexArray(gpu.vao)
    for (const { buffer } of [gpu.geometry, gpu.colors, gpu.widths, gpu.zooms, gpu.orders, gpu.indices]) {
      gl.deleteBuffer(buffer)
    }
    gl.deleteBuffer(gpu.edges)
    this.gpu.delete(mesh)
  }

  private getProgram(gl: WebGL2RenderingContext, shaderData: CustomRenderMethodInput['shaderData']): Program {
    const cached = this.programs.get(shaderData.variantName)
    if (cached) return cached

    const program = link(gl, vertexSource(shaderData.vertexShaderPrelude, shaderData.define), fragmentSource)
    const uniforms = Object.fromEntries(UNIFORM_NAMES.map((name) => [name, gl.getUniformLocation(program, name)]))
    const created = { program, uniforms }
    this.programs.set(shaderData.variantName, created)
    return created
  }
}

function createGpuMesh(gl: WebGL2RenderingContext): GpuMesh {
  const createBuffer = (): GpuBuffer => ({
    buffer: gl.createBuffer(),
    uploadedBytes: 0,
  })
  const mesh = {
    vao: gl.createVertexArray(),
    geometry: createBuffer(),
    colors: createBuffer(),
    widths: createBuffer(),
    zooms: createBuffer(),
    orders: createBuffer(),
    indices: createBuffer(),
    edges: gl.createBuffer(),
  }
  gl.bindVertexArray(mesh.vao)
  // Locations match the layout qualifiers in the vertex shader
  const attributes: [
    buffer: GpuBuffer,
    location: number,
    size: number,
    type: GLenum,
    stride: number,
    offset: number,
  ][] = [
    [mesh.geometry, 0, 2, gl.FLOAT, GEOMETRY_FLOATS * 4, 0],
    [mesh.geometry, 1, 2, gl.FLOAT, GEOMETRY_FLOATS * 4, 2 * 4],
    // Four bytes read as 0..1 each
    [mesh.colors, 2, 4, gl.UNSIGNED_BYTE, 0, 0],
    [mesh.widths, 3, 1, gl.FLOAT, 0, 0],
    [mesh.zooms, 4, 1, gl.FLOAT, 0, 0],
  ]
  for (const [buffer, location, size, type, stride, offset] of attributes) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer.buffer)
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, size, type, type === gl.UNSIGNED_BYTE, stride, offset)
  }
  // Read as an integer, so orders above 2^24 keep their exact value
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.orders.buffer)
  gl.enableVertexAttribArray(5)
  gl.vertexAttribIPointer(5, 1, gl.UNSIGNED_INT, 0, 0)
  gl.bindVertexArray(null)
  return mesh
}

/** Uploads what changed since the last frame. Leaves the mesh's VAO bound */
function upload(gl: WebGL2RenderingContext, cpu: MeshBuffer, gpu: GpuMesh): void {
  // Bind the VAO first: binding ELEMENT_ARRAY_BUFFER otherwise changes whichever VAO MapLibre left bound
  gl.bindVertexArray(gpu.vao)
  const from = cpu.dirtyVertexFrom
  const to = cpu.vertexCount
  const vertexArrays: [GpuBuffer, Float32Array | Uint32Array, number][] = [
    [gpu.geometry, cpu.geometry, GEOMETRY_FLOATS],
    [gpu.colors, cpu.colors, 1],
    [gpu.widths, cpu.widths, 1],
    [gpu.zooms, cpu.zooms, 1],
  ]
  for (const [buffer, data, perVertex] of vertexArrays) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer.buffer)
    uploadRange(gl, gl.ARRAY_BUFFER, buffer, data, from * perVertex, to * perVertex)
  }
  // Orders also change in place, for strokes given an order after they were uploaded
  const appended = from < to
  gl.bindBuffer(gl.ARRAY_BUFFER, gpu.orders.buffer)
  uploadRange(
    gl,
    gl.ARRAY_BUFFER,
    gpu.orders,
    cpu.orders,
    Math.min(from, cpu.dirtyOrderFrom),
    appended ? to : Math.min(cpu.dirtyOrderTo, to),
  )
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.indices.buffer)
  uploadRange(gl, gl.ELEMENT_ARRAY_BUFFER, gpu.indices, cpu.indices, cpu.dirtyIndexFrom, cpu.indexCount)
  cpu.dirtyVertexFrom = cpu.vertexCount
  cpu.dirtyIndexFrom = cpu.indexCount
  cpu.dirtyOrderFrom = Infinity
  cpu.dirtyOrderTo = 0
}

/** Uploads data[from, to) to the bound buffer, or the whole array when the array was reallocated */
function uploadRange(
  gl: WebGL2RenderingContext,
  target: GLenum,
  gpu: GpuBuffer,
  data: Float32Array | Uint32Array,
  from: number,
  to: number,
): void {
  if (data.byteLength !== gpu.uploadedBytes) {
    gl.bufferData(target, data, gl.DYNAMIC_DRAW)
    gpu.uploadedBytes = data.byteLength
  } else if (from < to) {
    gl.bufferSubData(target, from * data.BYTES_PER_ELEMENT, data, from, to - from)
  }
}

/** Debug view only: builds the edge list from the triangles every frame, so normal frames carry no edge data */
function uploadEdges(gl: WebGL2RenderingContext, cpu: MeshBuffer, gpu: GpuMesh): void {
  // Bind the VAO first: the element array binding belongs to it
  gl.bindVertexArray(gpu.vao)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.edges)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, edgesOf(cpu.indices, cpu.indexCount), gl.STREAM_DRAW)
}

/** The triangles' edges as line pairs: triangle a b c becomes a-b, b-c, c-a */
function edgesOf(indices: Uint32Array, count: number): Uint32Array {
  const edges = new Uint32Array(count * 2)
  for (let i = 0; i < count; i += 3) {
    const a = indices[i]
    const b = indices[i + 1]
    const c = indices[i + 2]
    const at = i * 2
    edges[at] = a
    edges[at + 1] = b
    edges[at + 2] = b
    edges[at + 3] = c
    edges[at + 4] = c
    edges[at + 5] = a
  }
  return edges
}

function setProjection(
  gl: WebGL2RenderingContext,
  uniforms: Program['uniforms'],
  projection: RendererProjectionData,
): void {
  gl.uniformMatrix4fv(uniforms.u_projection_matrix, false, projection.mainMatrix)
  gl.uniformMatrix4fv(uniforms.u_projection_fallback_matrix, false, projection.fallbackMatrix)
  gl.uniform4f(uniforms.u_projection_tile_mercator_coords, ...projection.tileMercatorCoords)
  gl.uniform4f(uniforms.u_projection_clipping_plane, ...projection.clippingPlane)
  gl.uniform1f(uniforms.u_projection_transition, projection.projectionTransition)
}

/**
 * How a small step in Web Mercator coordinates moves on screen at the map center (column-major mat2, CSS px, y down).
 * Computed on the CPU in f64: probing in the shader with f32 coordinates would lose the step to rounding at high zoom
 */
function mercatorToScreen(map: MapLibreMap): [number, number, number, number] {
  const center = MercatorCoordinate.fromLngLat(map.getCenter())
  // About one px at the current zoom
  const step = mercatorPerPixel(map)
  const at = (dx: number, dy: number) => map.project(new MercatorCoordinate(center.x + dx, center.y + dy).toLngLat())
  const origin = at(0, 0)
  const x = at(step, 0)
  const y = at(0, step)
  return [x.x - origin.x, x.y - origin.y, y.x - origin.x, y.y - origin.y]
}

function deleteTarget(gl: WebGL2RenderingContext, target: Target): void {
  if (target.draw !== target.resolve) gl.deleteFramebuffer(target.draw)
  gl.deleteFramebuffer(target.resolve)
  gl.deleteTexture(target.color)
  for (const buffer of target.renderbuffers) gl.deleteRenderbuffer(buffer)
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()
  const shaders = [compile(gl, gl.VERTEX_SHADER, vertex), compile(gl, gl.FRAGMENT_SHADER, fragment)]
  for (const shader of shaders) gl.attachShader(program, shader)
  gl.linkProgram(program)
  // The linked program keeps what it needs
  for (const shader of shaders) gl.deleteShader(shader)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Failed to link stroke program: ${gl.getProgramInfoLog(program)}`)
  }
  return program
}

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Failed to compile stroke shader: ${gl.getShaderInfoLog(shader)}`)
  }
  return shader
}
