# Cesium vector format: implementation notes

map-zero 0.5.0 writes static vector context and ordinary extruded building meshes.
The viewer defaults to `HeightReference.NONE`. On the evaluated flat Madrid
scene, disabling clamping substantially reduced motion stalls while retaining
acceptable appearance. This does not establish equivalent results on terrain
with relief. Clamping remains an explicit application option.

## Format and dependencies

Tested runtime: CesiumJS **1.145.0**, pinned by the Cesium package peer dependency.
Native vector data is a Cesium Technology Preview based on public drafts:
`3DTILES_content_gltf_vector`, `KHR_mesh_primitive_restart`, `EXT_mesh_polygon`,
plus `EXT_mesh_features` and `EXT_structural_metadata`. These are not presented
as a finalized 3D Tiles 2.0 standard. Exact revisions and audited runtime hashes
are in `src/3dtiles/vector/`. Re-audit them when upgrading Cesium.

Sources: [content draft](https://github.com/CesiumGS/3d-tiles/pull/838),
[polygon draft](https://github.com/KhronosGroup/glTF/pull/2570),
[restart draft](https://github.com/KhronosGroup/glTF/pull/2569).
The older `CESIUM_mesh_vector` encoding and its writer are not shipped.

GeoPackage → in-memory MVT → decoded features → vector GLB preserves the tested
cartographic pipeline. No intermediate MVT files are generated. The decoder in
`src/3dtiles/mvt/` is attributed Apache-2.0 code adapted from Cesium 1.145, using
native Error. Production export imports no Cesium modules and requires no ion
service. The vector writer uses the specifications and Earcut; lines are native
LINE_STRIP primitives rather than ribbons.

## Shared architecture

Extraction, spatial hierarchy and content encoding remain separate.
`createCesiumTileset` writes occupied XYZ LODs with REPLACE refinement, geometry
bounds and shared paths. The vector source applies existing MVT policy, source
zoom intervals and labels. Building/mesh output retains the centroid ownership
partition and hard feature batch limit. Different content encoders do not change
GeoPackage, layer descriptors or PMTiles.

Logical context layers share one URL and one Cesium instance, with metadata-based
visibility, opacity and line width. Buildings are separate: Cesium 1.145 dispatches
vector content from a tileset-wide extension. Runtime adaptation is explicit;
NONE is the default for both geometry and labels.

## Remaining runtime limitations

- Cesium 1.145 computes incorrect second/later hole offsets in the new polygon
  reader: `[4,8]` becomes `[4,9]`. It also allocates triangle capacity from index
  count. Writer topology remains correct. Use `--context-format mesh` when these
  polygon cases require the conventional renderer.
- The vector content metadata-byte getter reads a nonexistent ModelFeatureTable
  getter. Total tileset memory becomes NaN, so automatic cache-budget comparisons
  cannot be relied on. Explicit trimming/destruction works. This is not fixed by
  disabling clamping.
- Clamped line/polygon picking did not work in the evaluated scene; native points
  and unclamped polygons were pickable. Metadata table reads remain available.
- Vector loading can perform GPU buffer readbacks. Terrain projection, styling
  and buffer/texture uploads still incur runtime costs despite offline generation.
- Cesium 1.145 does not consume the draft clip flag. Bounds contain buffered
  geometry, but arbitrary cross-tile composition and terrain bounds need care.

These observations remain covered by small source-compatibility and topology
regression fixtures. The validator checks encoder invariants, not certification
by a full draft-aware glTF validator. No Cesium internals are patched.

## Metadata

Feature IDs use FLOAT attributes (exact through 2^24). Source IDs are separate
properties. Numeric metadata uses finite noData sentinels, strings use UTF-8 and
booleans packed bits. A JSON companion preserves original null/missing, mixed and
structured properties. Invalid schema identifiers are reversibly encoded.
Nullable typed boolean reads alone cannot distinguish missing from false.

The generic encoder supports all six point/line/polygon geometry types, source
properties, feature zoom limits and optional vertical metadata. The current MVT
map source is two-dimensional; a future volumetric source must preserve altitude
and datum explicitly. No ARINC semantics are embedded in the encoder.

## Evaluation reference

Before product integration, two-pass Madrid measurements with common building
meshes and an RTX 3060 Ti showed motion p95 about 72 ms for runtime MVT, 65 ms
for clamped prebuilt vector data and 19 ms for ordinary meshes. A separate
instrumented unclamped vector pass reached about 20 ms. These are different
workloads/settings, not a promised speedup or a post-integration benchmark.
The single Almudena tile matched the runtime MVT screenshots in three views.
Generated comparisons, profiles and screenshots were removed after evaluation;
small source fixtures and current product recordings are retained.
