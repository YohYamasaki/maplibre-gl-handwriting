// Draws the triangle meshes from lyon. Each vertex is a point on the stroke's center line plus lyon's extrusion normal.
// The vertex shader projects the center line point with MapLibre's projectTile, using the projection uniforms
// of the tile the position is relative to, then pushes the vertex out along the normal on screen.
// The width scales with the map, so it needs no re-tessellating on zoom.
// The depth is not the projection's: it is the stroke's place in the drawing order, so the depth test draws
// later strokes over earlier ones whatever order the draw calls come in (see FrameDraws in StrokeScene.ts).
import { ORDER_DEPTH_BITS } from './StrokeScene'

export function vertexSource(prelude: string, define: string): string {
  return `#version 300 es
${prelude}
${define}
layout(location = 0) in vec2 a_position; // point on the center line in tile-local units (0 to 8192 across the tile)
layout(location = 1) in vec2 a_normal;   // lyon's normal times the vertex's width over a_width (pen pressure): the outline is at position + normal * width / 2
layout(location = 2) in vec4 a_color;
layout(location = 3) in float a_width;   // CSS px at the drawing zoom
layout(location = 4) in float a_zoom;    // drawing zoom
layout(location = 5) in uint a_order;    // place in the drawing order; 0 while the stroke has no order yet

uniform vec2 u_viewport;                 // drawing buffer size in device px
uniform float u_pixel_ratio;
uniform mat2 u_mercator_to_screen;       // Web Mercator direction -> CSS px direction (y down) at the map center
uniform float u_zoom;                    // current map zoom
uniform uint u_order_base;               // the order drawn deepest (FrameDraws.orderBase)
// The draw's transform in tile-local units (DrawRange.transform), a similarity: identity except for the selection
// being dragged. u_scale is the scale of u_linear, which widens the lines with the strokes
uniform mat2 u_linear;
uniform vec2 u_translate;
uniform float u_scale;

out vec4 v_color;
// The projection's own z and w, which the fragment shader clips with: on the globe they hide the far side.
// Passed apart and divided per fragment, since an interpolated z / w is not the z / w of the point in between
out vec2 v_clip;

void main() {
  vec4 center = projectTile(u_linear * a_position + u_translate);

  // CSS px on screen: the width grows and shrinks with the map like a drawn feature
  float width = a_width * exp2(u_zoom - a_zoom) * u_scale;
  // The rotation alone turns the normal; its length is kept
  vec2 normal = u_linear * a_normal / u_scale;
  vec2 dir = u_mercator_to_screen * normal;
  float len = length(dir);
  // lyon makes the normal longer than 1 at sharp joins; keep that length on screen
  vec2 offset = len > 1e-6 ? dir / len * length(normal) * 0.5 * width * u_pixel_ratio : vec2(0.0);
  // Screen px are y down, clip space is y up
  offset.y = -offset.y;

  // Orders from u_order_base on get depths 2^-${ORDER_DEPTH_BITS} apart, later ones nearer; older ones share the deepest.
  // A stroke without an order yet is in front of all of them
  float steps = a_order == 0u ? float(1 << ${ORDER_DEPTH_BITS}) : float(a_order > u_order_base ? a_order - u_order_base : 0u) + 1.0;
  float depth = 1.0 - steps * exp2(-${ORDER_DEPTH_BITS}.0);

  gl_Position = vec4(center.xy + offset / (0.5 * u_viewport) * center.w, (2.0 * depth - 1.0) * center.w, center.w);
  v_color = a_color;
  v_clip = center.zw;
}
`
}

export const fragmentSource = `#version 300 es
precision highp float;

in vec4 v_color;
in vec2 v_clip;

uniform bool u_wireframe;                // debug view: draws the triangle edges in one color

out vec4 fragColor;

void main() {
  // Where the projection's depth falls outside the clip volume the GPU would have clipped the vertex
  if (abs(v_clip.x) > v_clip.y) discard;
  vec4 color = u_wireframe ? vec4(0.0, 0.0, 0.0, 1.0) : v_color;
  // MapLibre blends custom layers with premultiplied alpha
  fragColor = vec4(color.rgb * color.a, color.a);
}
`

// Copies the layer's own framebuffer (see StrokeLayer) onto the map with one triangle that covers the screen.
// Its colors are premultiplied already, as MapLibre's blending expects
export const compositeVertexSource = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`

export const compositeFragmentSource = `#version 300 es
precision highp float;

uniform sampler2D u_strokes;

out vec4 fragColor;

void main() {
  fragColor = texelFetch(u_strokes, ivec2(gl_FragCoord.xy), 0);
}
`
