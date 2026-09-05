# Rendering and export review — 0.4.0

## What changed

| Path | Finding | Change |
| --- | --- | --- |
| OpenLayers vector | Geometry and labels opened separate PMTiles readers and fetched the same tile independently. | Share a reader and a 128-entry promise cache per map instance. Labels still decode only their required layers. |
| OpenLayers labels | Style objects accumulated across names and zoom levels. | Bound the style cache to 2,048 entries. |
| Cesium viewer | A static scene rendered continuously. | Enable `requestRenderMode` and `maximumRenderTimeChange: Infinity`; request frames after controller changes. External viewers retain their own settings. |
| Cesium native vectors | Context required rasterization. | Add `MVTDataProvider` with the 1.145 `heightReference` API. The built-in viewer reads MVT from the same PMTiles archive used by OpenLayers, via a readonly XYZ endpoint. |
| Cesium labels | Native context lacked text. | Reuse loaded tile metadata in a native LabelCollection, deduplicate anchors and declutter with at most 150 visible labels by default. |
| Raster paths | Duplicate rendering pipeline and worker dependencies. | Removed from both integrations in 0.4.0; Cesium no longer depends on OL. |
| PMTiles | Uncompressed payloads; inaccurate `clustered` flag; a fixed directory layout could exceed the first 16 KiB. | Gzip tiles at level 1, gzip metadata/directories, size leaves adaptively and calculate the clustered flag from actual offsets. |
| Parallel PMTiles | A worker was considered idle before its queued file write finished. Large `push(...entries)` calls could overflow the JS argument stack. | Keep writes in the active-job count until committed and append entries iteratively. |
| 3D Tiles | Crossing features were meshed in several leaves; flat reads silently truncated at twice `maxFeatures`. | Deduplicate by GeoPackage row ID, stream database rows and remove the implicit read limit. Bounds cover the whole emitted feature. |
| GLB | Sequential indices duplicated vertex order. Quantized normals lacked required extension metadata/alignment. | Omit identity index buffers; declare `KHR_mesh_quantization` and align signed-byte normals to four-byte vertex strides. |
| Multi-layer 3D Tiles | The manifest retained only the first tileset URL. | Store a URL per layer while keeping the legacy `url` and `layers` fields readable. |

Cache limits are entry counts, not strict memory budgets. Dense decoded vector tiles can still be large. The configurable Cesium building tileset GPU cache is separate from the caches above.

## Measured example

One local Madrid extract, bbox `[-3.710, 40.413, -3.696, 40.422]`, Node 22.21.1, PMTiles z8–16, 2,008 source buildings. The before/after runs used the same GeoPackage and theme. A single run of each configuration is a smoke benchmark, not a statistically controlled throughput comparison; browser checks were also running on this machine.

| Export | Before | 0.4.0 | Interpretation |
| --- | ---: | ---: | --- |
| PMTiles size, 118 nonempty tiles | 1,013,568 B | 719,745 B | Approximately 29% smaller; same 118 nonempty tiles, now including geometry type and stable label anchors. |
| Building tiles size, 4 leaves | 6,222,764 B | 4,937,545 B | Approximately 21% smaller, including corrected normal alignment. |

The initial measurements (before label metadata), including timings, and the final archive size with anchors are in [benchmark.json](media/benchmark.json). Compression mainly reduces storage and transfer cost. PMTiles generation time was similar in the initial comparison; no general throughput or FPS improvement is claimed.

The browser smoke test checks OpenLayers vectors and native Cesium MVT, labels, visibility, opacity and cleanup. On the recorded scene, Cesium rendered **0 frames during 1.5 seconds at rest**, and rendered again after changing opacity. This is an idle rendering observation, not a CPU/GPU utilization or navigation FPS benchmark.

## Native Cesium vectors: scope and limits

Cesium 1.145 supports MVT draping on terrain, 3D Tiles, or both. Map-zero defaults to `CLAMP_TO_TERRAIN` so roads do not appear on building roofs; use `vectorHeightReference: HeightReference.CLAMP_TO_GROUND` to drape onto both. No ion token is needed with the built-in ellipsoid terrain and local data.

The provider accepts an XYZ MVT endpoint, not a PMTiles file URL. `/api/vector-tiles/{z}/{x}/{y}.mvt` reads existing tiles without regenerating geometry. Without an archive it redirects to dynamic GeoPackage MVT. Static applications must provide an external MVT endpoint for Cesium context, or disable context and display exported 3D Tiles only.

The helper translates the shared theme's base colors, feature property overrides, visibility, opacity and widths. Polygons, lines and points in new archives include `mapzero_geometry` so mixed layers can be styled appropriately. Existing archives remain readable; native rendering falls back to layer-based geometry classification until they are re-exported.

This is **not full cartographic parity**: native MVT does not reproduce OL polygon outlines, glow, road casings, dashes or every width expression. Native labels share the theme but use screen-aligned text rather than curved road placement. Exported buildings remain 3D Tiles; native MVT is the ground context, not a building extrusion pipeline.

Cesium's MVT API is experimental, eagerly builds the runtime tile hierarchy and currently decodes/meshes MVT on the main thread. The integration bounds the hierarchy estimate to 20,000 nodes and reduces its maximum zoom for broad regions; inspect `controller.vectorRange` to see the effective range. Dense tiles may still stall navigation.

## Further work

- Reuse PMTiles workers across zooms and profile database queries before changing concurrency defaults. Worker startup currently repeats for each zoom.
- Add coarse building LODs and a spatial hierarchy above leaves for regional 3D packages. Current leaf content has zero geometric error, so screen-space error alone cannot simplify it.
- Preserve building courtyard holes and consider minimum-height tags; the existing building extrusion path uses exterior rings only.
- Partition very large features spatially. Deduplication removes repeated content, but a feature spanning a large region still produces a large content bound.
- Profile PBF relation selection. A small bbox can still require scanning a broad extract and resolving many relation members. Prefer the smallest suitable source extract.
- Measure GPU memory and navigation frame times on target hardware with representative city and region datasets before changing visual quality defaults.

## References

- [Cesium 1.145 release](https://github.com/CesiumGS/cesium/releases/tag/1.145)
- [Cesium native MVT tutorial and current limits](https://cesium.com/learn/cesiumjs-learn/load-mapbox-vector-tiles-in-cesiumjs/)
- [Cesium Scene explicit rendering options](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html)
- [PMTiles v3 specification](https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md)
- [Cesium LabelCollection](https://cesium.com/learn/cesiumjs/ref-doc/LabelCollection.html)
