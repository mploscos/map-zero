# Vector 3D Tiles encoder

Tested against **CesiumJS 1.145.0** / `@cesium/engine` 26.3.0. This is not a
standalone public API. The normal exporter uses it for map context and retains
ordinary meshes for extruded geometry.

The encoder is a small implementation of the public specifications, using the
existing Earcut dependency for polygon surfaces. It does not import Cesium,
call ion, decode MVT, write files, or tessellate line ribbons. The MVT source adapter is outside this directory. Full audit and measurements:
[format and compatibility notes](../../../docs/cesium-format.md).

| Declaration | Encoding | Status of the audited reference |
| --- | --- | --- |
| `3DTILES_content_gltf_vector` | Tileset `extensionsUsed`; each vector `content.extensions` has `{vector:true}` | Public draft, Cesium Technology Preview |
| `KHR_mesh_primitive_restart` | GLB `extensionsUsed` **and** `extensionsRequired` when restart indices occur | Public draft |
| `EXT_mesh_polygon` | TRIANGLES plus polygon count, triangle offsets, loop indices and loop offsets | Public draft |
| `EXT_mesh_features` | `_FEATURE_ID_0` attribute, property table 0 | Established Cesium metadata mechanism; linked specification remains a proposal |
| `EXT_structural_metadata` | Embedded schema and binary property table | Established Cesium metadata mechanism; linked specification remains a proposal |

Exact draft revisions are centralized in [extensions.js](extensions.js).
Reference documents:

- [3D Tiles vector draft, c48ebdc](https://github.com/CesiumGS/3d-tiles/blob/c48ebdc8db43dc00917b4f200eff5e2131d7e493/extensions/3DTILES_content_gltf_vector/README.md)
- [Polygon topology draft, c1a0354](https://github.com/CesiumGS/glTF/blob/c1a035499b70aeb5d8281470101423e5e285dfe3/extensions/2.0/Vendor/EXT_mesh_polygon/README.md)
- [Primitive restart draft, 9811e84](https://github.com/CesiumGS/glTF/blob/9811e8407d4533500cfc6b10e3bc408345035a6f/extensions/2.0/Khronos/KHR_mesh_primitive_restart/README.md)
- [Feature IDs](https://github.com/CesiumGS/glTF/tree/proposal-EXT_mesh_features/extensions/2.0/Vendor/EXT_mesh_features)
- [Structural metadata](https://github.com/CesiumGS/glTF/tree/proposal-EXT_structural_metadata/extensions/2.0/Vendor/EXT_structural_metadata)

The draft content extension is optional, not `extensionsRequired`. Its current
text says “written against 3D Tiles 2.0”; Cesium's public preview instructions
and the tested runtime use 3D Tiles **1.1**. This is a draft dependency, not a
claim that 3D Tiles 2.0 is finalized.

## Internal input and output

`encodeVectorContent(features, {bbox})` takes WGS84 GeoJSON geometries:
Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon.
The optional bbox chooses a local coordinate origin, not spatial ownership.

```js
{
  id: 'survey/123',
  layerId: 'observations',
  geometry: { type: 'Point', coordinates: [-3.64, 40.42, 125.5] },
  properties: { name: 'Station', quality: 2, temperature: 18.75 },
  minZoom: 8,
  maxZoom: 15,
  vertical: { datum: 'ellipsoid' }
}
```

Only coordinate[2] affects geometric altitude. `vertical` is preserved metadata,
without interpreting domain-specific vertical limits or datums. Source zoom
visibility becomes `mapzero_minzoom` / `mapzero_maxzoom`; the shared GeoPackage
adapter already resolves descriptor and mapped feature intervals.

The encoder returns zero or one `{bytes, extension, bbox, minHeight, maxHeight,
count, warnings}` payloads. Spatial writers own paths, bounds, hierarchy, LOD,
refinement and tileset declarations. `declareTileset` is the encoder's internal
declaration hook. The mesh encoder uses the same payload contract.

## Geometry and metadata conventions

- Standard glTF Y-up; double precision node translations, local Float32 vertices.
  No `asset.gltfUpAxis` override is needed for new GLBs.
- Points use POINTS; lines use LINE_STRIP, with Uint32 `0xffffffff` separators.
  Line vertex streams are never triangulated by map-zero's vector encoder.
- Polygons use TRIANGLES, with explicit rings and triangle offsets. Rings do not
  repeat the closing index. Exteriors are CCW and holes CW in a Mercator chart.
- Feature ID attributes use FLOAT, exactly representing IDs through 2^24;
  `UNSIGNED_INT` is not a valid core glTF vertex-attribute type. A tile exceeding
  that range is rejected. Source IDs are metadata, not these compact indices.
- Metadata numbers use FLOAT64 with finite `noData` sentinels; NaN and Infinity
  are forbidden. Strings use UTF-8 and Uint32 offsets. Booleans use packed bits.
- Property IDs that are not schema identifiers are reversibly encoded as
  `_property_<UTF-8 hex>`; schema `name` retains the original name.
- `_layer`, `mapzero_layer`, `mapzero_geometry`, `mapzero_minzoom`,
  `mapzero_maxzoom`, `mapzero_vertical`, and `mapzero_properties_json` are internal
  metadata fields. The JSON companion retains original source properties,
  including null vs missing, complex values and mixed column types. This costs
  bytes; it is intentionally explicit rather than lossy type coercion.
- Typed nullable boolean reads cannot distinguish missing from false; use the
  JSON companion for exact source inspection. Metadata is restricted to JSON
  values. Cycles, BigInt and non-finite numbers are unsupported.
- Repeated vertices are removed. Source polygon parts that cannot be triangulated
  as valid rings and collapsed holes are counted in `warnings`; exporters must
  expose these counts. This is particularly relevant after MVT quantization.

## Cesium 1.145 assumptions and upgrade checks

`Cesium3DTileContentFactory` dispatches on the **tileset's** vector extension,
even though the draft marker is per content. Keep ordinary building meshes in a
separate tileset. `GltfLoader` reads the new topology, and
`createVectorTileBuffersFromModelComponents` builds native point/polyline/polygon
collections. Clamped lines/polygons still pass through `VectorProvider` for
projection and terrain baking at runtime.

The old `CESIUM_mesh_vector` extension is absent from this encoder. Cesium 1.145
still recognizes it, and its internal `buildVectorGltfFromMVT` still emits it;
that builder is not a supported writer for the new format.

The current content draft also defines `clip:true`. The inspected 1.145 path
does not consume that flag, so it is omitted. Bounds contain buffered geometry;
this does not promise seamless clipping across all adjacent tiles. Ellipsoid
height assumptions in the map source must be replaced by source terrain bounds
before using an arbitrary terrain provider.

On upgrade, review the pinned source hashes in `cesium-compatibility.json`, the
three draft revisions, declarations, primitive restart, multiple polygons and
holes, standard Y-up placement, metadata and feature picking. Run the source fixtures and the normal viewer smoke tests again. `validate.js` checks writer invariants;
it is not certification by a complete draft-aware glTF validator.

## Reproduced runtime limitations

Cesium 1.145's new polygon reader computes second and later hole offsets before
removing primitive restart indices: `[4, 8]` becomes `[4, 9]`. It also allocates
triangle capacity from the number of indices. The encoder emits correct topology;
we do not encode deliberately incorrect topology to compensate for these bugs.
Unused Earcut vertices are compacted to satisfy the reader's dense-index assumption.

`VectorGltf3DTileContent.batchTableByteLength` reads a nonexistent
`ModelFeatureTable.batchTableByteLength` getter. Total tileset memory becomes NaN,
which undermines automatic cache-budget comparisons. Explicit trim/destroy works.
Clamped points can be picked; clamped lines/polygons were not screen-pickable in
our probes. Unclamped polygons were pickable. Metadata table reads work.

The loader can upload accessors and then read them back with `getBufferData` while
creating vector collections. Offline generation does not remove that cost or
runtime terrain baking. See the evaluation for profiles and reproducible probes.
The normal viewer uses NONE. Mesh context remains available when these limits
affect the data. No production patches to Cesium internals are applied. Re-audit them when upgrading the engine.
