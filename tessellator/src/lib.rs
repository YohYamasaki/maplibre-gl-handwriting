//! Stroke tessellation with lyon, compiled to WebAssembly for the handwriting render layer.
//!
//! The output keeps the line width out of the vertex positions: each vertex is a point on the
//! center line plus lyon's extrusion normal, and the vertex shader extrudes it on screen.
//!
//! The samples are joined by a centripetal Catmull-Rom spline, so the line is smooth when zoomed in.
//! Each segment is handed to lyon as the cubic Bézier that traces the same curve, and lyon flattens it.
//! A range of the samples can be tessellated on its own: the samples just outside it still shape its ends,
//! so separately tessellated pieces of one stroke meet without a kink.
//!
//! Every piece ends in round caps, so neighboring pieces overlap where they meet. A translucent stroke is still painted once there: all its vertices share one depth, and the render layer draws translucent
//! strokes with depth writes and a strictly-less depth test.
//!
//! With pen pressure, each sample carries a width coefficient (0 to 1). lyon then varies the line width along the
//! path, and each vertex's normal is scaled by the ratio of its width to the stroke's width, so the vertex shader
//! extrudes it that much less. Neighboring pieces both end in a round cap at the sample where they meet, sized by that
//! sample's coefficient. Without pressure the ratio is 1 and lyon draws the fixed width.
//!
//! Positions are in the local coordinates of a map tile rather than in absolute Web Mercator coordinates.
//! The GPU works in f32, which cannot tell apart absolute coordinates a few px apart at high zoom.
//! Small tile-local values keep that precision, and MapLibre computes each tile's matrix on the CPU in f64.
//!
//! The result never leaves through a view into this module's memory. `tessellate_into` asks a JS
//! `MeshTarget` for destination arrays and copies the mesh into them, so JS never holds a reference
//! into WebAssembly memory that a later call could overwrite or a memory growth could detach.

use js_sys::{Float32Array, Uint32Array};
use lyon_tessellation::geom::{Vector, point, vector};
use lyon_tessellation::path::Path;
use lyon_tessellation::{
    BuffersBuilder, LineCap, LineJoin, StrokeOptions, StrokeTessellator, StrokeVertex,
    VertexBuffers,
};
use wasm_bindgen::prelude::*;

/// MapLibre's world size at zoom 0, in px
const TILE_SIZE: f64 = 512.0;

/// Tile-local units across one tile, as in MapLibre (EXTENT)
const EXTENT: f64 = 8192.0;

/// Exponent of the distances between samples that sets the spline's parameter spacing.
/// 0.5 is the centripetal variant: unevenly spaced samples never make loops or cusps
const ALPHA: f64 = 0.5;

/// Number of f32 values per output vertex: x, y, normal x, normal y. The normal is lyon's times the vertex's width
/// ratio (its width over the stroke's, from pen pressure), so its length carries the ratio to the shader
const FLOATS_PER_VERTEX: usize = 4;

#[wasm_bindgen(typescript_custom_section)]
const MESH_TARGET_TYPES: &'static str = r#"
/** Receives meshes from Tessellator.tessellate_into */
export interface MeshTarget {
  /**
   * Makes room for a mesh and returns where to write it: `vertices` must hold exactly vertexCount * 4 floats
   * ([x, y, nx, ny] per vertex, the normal scaled by the vertex's width over the stroke's) and `indices` exactly
   * indexCount indices
   */
  reserve(vertexCount: number, indexCount: number): MeshSlot;
}

/** Where one mesh is written. Its indices are written already offset by baseVertex */
export interface MeshSlot {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly baseVertex: number;
}
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "MeshTarget")]
    pub type MeshTarget;

    #[wasm_bindgen(method, catch)]
    fn reserve(this: &MeshTarget, vertex_count: u32, index_count: u32)
    -> Result<MeshSlot, JsValue>;

    #[wasm_bindgen(typescript_type = "MeshSlot")]
    pub type MeshSlot;

    #[wasm_bindgen(method, getter)]
    fn vertices(this: &MeshSlot) -> Float32Array;

    #[wasm_bindgen(method, getter)]
    fn indices(this: &MeshSlot) -> Uint32Array;

    #[wasm_bindgen(method, getter = baseVertex)]
    fn base_vertex(this: &MeshSlot) -> u32;
}

/// Reusable tessellator. Keeps lyon's internal buffers and the output buffers between calls
#[wasm_bindgen]
pub struct Tessellator {
    tessellator: StrokeTessellator,
    output: VertexBuffers<[f32; FLOATS_PER_VERTEX], u32>,
}

#[wasm_bindgen]
impl Tessellator {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Tessellator {
        Tessellator {
            tessellator: StrokeTessellator::new(),
            output: VertexBuffers::new(),
        }
    }

    /// Tessellates the curve through samples `from..=to` and writes the mesh into `target`.
    ///
    /// `samples` is flat `[x0, y0, x1, y1, ...]` in normalized Web Mercator coordinates, with no two
    /// neighbors at the same position. The ones before `from` and after `to` are not drawn; only the nearest
    /// of each shapes the curve's ends. At the ends of `samples`, a mirrored neighbor is used instead.
    /// `pressure`, when given, holds one width coefficient (0 to 1) per sample, and the line is `width` times the
    /// coefficient wide there; without it the line is `width` wide throughout.
    /// `zoom` is the map zoom the geometry is made for: curves are flattened to within `tolerance` px there, and
    /// joins and round caps are shaped as they look there. `width` is the line width lyon splits the arcs of round
    /// caps and joins for, in CSS px; it is used as given. The caller passes the larger of the width on screen at
    /// `zoom` and the width the stroke was drawn with. The drawn width does not depend on it: the
    /// shader extrudes by the stroke's width, and each normal carries only the coefficient.
    /// The output positions are in the local coordinates of tile `tile_z/tile_x/tile_y` (0 to EXTENT across the tile).
    #[allow(clippy::too_many_arguments)]
    pub fn tessellate_into(
        &mut self,
        samples: &[f64],
        pressure: Option<Box<[f32]>>,
        from: usize,
        to: usize,
        width: f32,
        tolerance: f32,
        zoom: f64,
        tile_z: u32,
        tile_x: u32,
        tile_y: u32,
        target: &MeshTarget,
    ) -> Result<(), JsValue> {
        self.tessellate(
            samples,
            pressure.as_deref(),
            from,
            to,
            width,
            tolerance,
            zoom,
            (tile_z, tile_x, tile_y),
        )
        .map_err(|e| JsError::new(&e))?;
        self.write_output(target)
    }
}

impl Tessellator {
    /// Tessellates into `self.output`; see `tessellate_into`
    #[allow(clippy::too_many_arguments)]
    fn tessellate(
        &mut self,
        samples: &[f64],
        pressure: Option<&[f32]>,
        from: usize,
        to: usize,
        width: f32,
        tolerance: f32,
        zoom: f64,
        (tile_z, tile_x, tile_y): (u32, u32, u32),
    ) -> Result<(), String> {
        self.output.vertices.clear();
        self.output.indices.clear();
        if !samples.len().is_multiple_of(2) || from > to || to >= samples.len() / 2 {
            return Err("Invalid samples or range".into());
        }
        if pressure.is_some_and(|p| p.len() != samples.len() / 2) {
            return Err("pressure must hold one coefficient per sample".into());
        }

        // Build the path in px at `zoom`, relative to the first sample.
        // lyon works in f32, and absolute Web Mercator coordinates would lose precision there
        let scale = TILE_SIZE * zoom.exp2();
        let (origin_x, origin_y) = (samples[0], samples[1]);
        let in_px: Vec<Vector<f64>> = samples
            .as_chunks::<2>()
            .0
            .iter()
            .map(|[x, y]| vector((x - origin_x) * scale, (y - origin_y) * scale))
            .collect();

        // Maps a path point back to tile-local units. The large terms are subtracted here in f64,
        // so only small values are rounded to f32
        let tiles = f64::from(tile_z).exp2();
        let offset_x = (origin_x * tiles - f64::from(tile_x)) * EXTENT;
        let offset_y = (origin_y * tiles - f64::from(tile_y)) * EXTENT;
        let units_per_px = EXTENT * tiles / scale;

        // lyon's variable-width code puts the normals a little (about 1e-4) off its fixed-width code's even where every
        // coefficient is 1, so the fixed-width code stays the one for a piece without pressure or at full width
        // throughout: its mesh is exactly as without pressure
        let variable = pressure.filter(|p| p[from..=to].iter().any(|&c| c != 1.0));
        let path = catmull_rom_path(&in_px, variable, from, to);

        let mut options = StrokeOptions::default()
            .with_line_width(width)
            .with_tolerance(tolerance)
            .with_line_cap(LineCap::Round)
            .with_line_join(LineJoin::Round);
        if variable.is_some() {
            options = options.with_variable_line_width(0);
        }

        self.tessellator
            .tessellate_path(
                &path,
                &options,
                &mut BuffersBuilder::new(&mut self.output, |vertex: StrokeVertex| {
                    let p = vertex.position_on_path();
                    let normal = vertex.normal();
                    let ratio = if variable.is_some() {
                        vertex.line_width() / width
                    } else {
                        1.0
                    };
                    [
                        (offset_x + f64::from(p.x) * units_per_px) as f32,
                        (offset_y + f64::from(p.y) * units_per_px) as f32,
                        normal.x * ratio,
                        normal.y * ratio,
                    ]
                }),
            )
            .map_err(|e| format!("Failed to tessellate stroke: {e}"))?;
        Ok(())
    }

    /// Copies the last result into the arrays `target` hands out.
    /// copy_from copies straight from this module's memory into the JS arrays, with no copy in between
    fn write_output(&mut self, target: &MeshTarget) -> Result<(), JsValue> {
        let vertex_count = self.output.vertices.len();
        let index_count = self.output.indices.len();
        let slot = target.reserve(vertex_count as u32, index_count as u32)?;
        let (vertices, indices) = (slot.vertices(), slot.indices());
        // copy_from panics on a length mismatch; a MeshTarget that breaks its contract gets an error instead
        if vertices.length() as usize != vertex_count * FLOATS_PER_VERTEX
            || indices.length() as usize != index_count
        {
            return Err(
                JsError::new("MeshTarget.reserve returned arrays of the wrong length").into(),
            );
        }
        let base = slot.base_vertex();
        for index in &mut self.output.indices {
            *index += base;
        }
        vertices.copy_from(self.output.vertices.as_flattened());
        indices.copy_from(&self.output.indices);
        Ok(())
    }
}

impl Default for Tessellator {
    fn default() -> Self {
        Self::new()
    }
}

/// Path through `samples[from..=to]`, with one cubic Bézier per pair of neighboring samples. With `pressure`, each
/// endpoint carries one attribute, the width coefficient at its sample, for lyon's variable line width; without it
/// the path has no attributes.
///
/// A segment of a centripetal Catmull-Rom spline is a cubic polynomial, so a cubic Bézier traces it exactly.
/// Its control points come from the segment's two samples, their outer neighbors and the distances between them
/// (Yuksel et al., "Parameterization and Applications of Catmull-Rom Curves", 2011)
fn catmull_rom_path(
    samples: &[Vector<f64>],
    pressure: Option<&[f32]>,
    from: usize,
    to: usize,
) -> Path {
    let n = samples.len();
    // The segments at the ends of `samples` have only one neighbor, so mirror one past each end
    let sample = |i: isize| -> Vector<f64> {
        if i < 0 {
            samples[0] * 2.0 - samples[1]
        } else if i as usize >= n {
            samples[n - 1] * 2.0 - samples[n - 2]
        } else {
            samples[i as usize]
        }
    };
    let to_point = |v: Vector<f64>| point(v.x as f32, v.y as f32);

    // One attribute per endpoint with pressure, none without
    let ratio = |i: usize| -> Option<f32> { pressure.map(|p| p[i]) };
    let mut builder = Path::builder_with_attributes(usize::from(pressure.is_some()));
    builder.begin(to_point(samples[from]), ratio(from).as_slice());
    for i in from as isize..to as isize {
        // The segment runs from p1 to p2; p0 and p3 are the neighbors outside it
        let (p0, p1, p2, p3) = (sample(i - 1), sample(i), sample(i + 1), sample(i + 2));
        let d1 = (p1 - p0).length().powf(ALPHA);
        let d2 = (p2 - p1).length().powf(ALPHA);
        let d3 = (p3 - p2).length().powf(ALPHA);
        let c1 = (p2 * (d1 * d1) - p0 * (d2 * d2) + p1 * (2.0 * d1 * d1 + 3.0 * d1 * d2 + d2 * d2))
            / (3.0 * d1 * (d1 + d2));
        let c2 = (p1 * (d3 * d3) - p3 * (d2 * d2) + p2 * (2.0 * d3 * d3 + 3.0 * d3 * d2 + d2 * d2))
            / (3.0 * d3 * (d3 + d2));
        builder.cubic_bezier_to(
            to_point(c1),
            to_point(c2),
            to_point(p2),
            ratio(i as usize + 1).as_slice(),
        );
    }
    // lyon draws caps for a single-point sub-path only when it is closed, so close it to get a dot
    builder.end(from == to);
    builder.build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A wavy stroke of `n` samples, a few px apart at zoom 12, in normalized Web Mercator coordinates
    fn wavy_samples(n: usize) -> Vec<f64> {
        let px = 1.0 / (TILE_SIZE * 4096.0);
        (0..n)
            .flat_map(|i| {
                let t = i as f64;
                [0.5 + t * 6.0 * px, 0.5 + (t * 0.7).sin() * 10.0 * px]
            })
            .collect()
    }

    /// Tessellates `samples` whole at zoom 12, 8 px wide, and returns the vertices and indices
    fn tessellate_whole(
        samples: &[f64],
        pressure: Option<&[f32]>,
    ) -> (Vec<[f32; FLOATS_PER_VERTEX]>, Vec<u32>) {
        let mut tessellator = Tessellator::new();
        tessellator
            .tessellate(
                samples,
                pressure,
                0,
                samples.len() / 2 - 1,
                8.0,
                0.125,
                12.0,
                (12, 2048, 2048),
            )
            .expect("a stroke");
        (
            tessellator.output.vertices.clone(),
            tessellator.output.indices.clone(),
        )
    }

    #[test]
    fn a_stroke_with_every_coefficient_1_gets_the_mesh_of_one_without_pressure() {
        let samples = wavy_samples(40);
        let (fixed, fixed_indices) = tessellate_whole(&samples, None);
        let ones = vec![1.0; samples.len() / 2];
        let (full, full_indices) = tessellate_whole(&samples, Some(&ones));
        assert_eq!(fixed_indices, full_indices);
        assert_eq!(fixed, full);
    }

    #[test]
    fn the_outline_width_follows_the_coefficients() {
        // Straight, so the outline's offset from the center line is the half width alone
        let px = 1.0 / (TILE_SIZE * 4096.0);
        let samples: Vec<f64> = (0..20)
            .flat_map(|i| [0.5 + f64::from(i) * 6.0 * px, 0.5])
            .collect();
        let pressure: Vec<f32> = (0..20).map(|i| 0.25 + 0.75 * i as f32 / 19.0).collect();
        let (vertices, _) = tessellate_whole(&samples, Some(&pressure));
        let mut checked = 0;
        for i in 0..20 {
            let x = ((samples[2 * i] * 4096.0 - 2048.0) * EXTENT) as f32;
            for v in vertices
                .iter()
                .filter(|v| (v[0] - x).abs() < 1e-2 && v[1].abs() < 1e-2)
            {
                // The normal carries the coefficient there: normal × half width reaches the outline
                if v[2] != 0.0 || v[3] != 0.0 {
                    let offset = vector(v[2], v[3]).length() * 4.0;
                    assert!(
                        (offset - 4.0 * pressure[i]).abs() < 1e-3,
                        "sample {i}: {v:?}"
                    );
                    checked += 1;
                }
            }
        }
        assert!(checked >= 20, "checked {checked}");
    }

    #[test]
    fn both_pieces_at_a_seam_end_in_a_cap_of_the_coefficient_there() {
        // The pieces on either side of a seam size its round caps by the seam sample's
        // coefficient, so the two caps are the same circle
        let samples = wavy_samples(12);
        let pressure: Vec<f32> = (0..12).map(|i| 0.3 + 0.05 * i as f32).collect();
        let seam = 6;
        let cap_radius = |from: usize, to: usize| -> f32 {
            let mut tessellator = Tessellator::new();
            tessellator
                .tessellate(
                    &samples,
                    Some(&pressure),
                    from,
                    to,
                    8.0,
                    0.125,
                    12.0,
                    (12, 2048, 2048),
                )
                .expect("a piece");
            let x = ((samples[2 * seam] * 4096.0 - 2048.0) * EXTENT) as f32;
            let y = ((samples[2 * seam + 1] * 4096.0 - 2048.0) * EXTENT) as f32;
            tessellator
                .output
                .vertices
                .iter()
                .filter(|v| (v[0] - x).abs() < 1e-3 && (v[1] - y).abs() < 1e-3)
                .map(|v| vector(v[2], v[3]).length())
                .fold(0.0, f32::max)
        };
        let (before, after) = (cap_radius(0, seam), cap_radius(seam, 11));
        assert!(
            (before - pressure[seam]).abs() < 1e-3,
            "earlier piece: {before}"
        );
        assert!(
            (after - pressure[seam]).abs() < 1e-3,
            "later piece: {after}"
        );
    }
}
