# @map-zero/cesium

Serverless Cesium maps from prebuilt static 3D Tiles, with spatially streamed
native vector context, extruded buildings, feature metadata and labels. GeoPackage is used during export; Cesium needs
neither the database nor PMTiles at runtime.

```js
import { addMapZeroToCesium } from '@map-zero/cesium';
const controller = await addMapZeroToCesium(viewer, {
  manifestUrl: '/maps/madrid/manifest.json'
});
controller.setVisible('roads', false);
controller.setOpacity('buildings', 0.6);
controller.setLabelsVisible(false);
controller.destroy();
```

Install with `npm install @map-zero/cesium cesium@1.145.0`. Export the map with
`map-zero 3dtiles <package>` and host its manifest, styles and 3dtiles directory
as ordinary static files. OpenLayers uses the independent PMTiles output.

[Full guide: export, hosting, geometry, labels, styling and limits](https://github.com/mploscos/map-zero/blob/main/docs/cesium.md).

Terrain clamping is disabled by default. Pass `clampToTerrain: true` when your
scene requires terrain adaptation. Layer controls work independently even when
context layers share the same tileset.
