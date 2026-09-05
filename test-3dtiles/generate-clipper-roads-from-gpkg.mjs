import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { join, resolve } from 'node:path';

import { buildB3dm } from '../src/3dtiles/b3dm.js';
import { buildClipperLineSurfaceMesh } from '../src/3dtiles/clipper-surfaces.js';
import { buildGlbFromMesh } from '../src/3dtiles/glb.js';
import { openReadonlyGeoPackage } from '../src/3dtiles/gpkg-buildings.js';
import { readLayerFeatures, readLayerMetadata } from '../src/3dtiles/gpkg-features.js';
import { buildContentNode, buildTileset } from '../src/3dtiles/tileset.js';
import { parseBbox } from '../src/utils.js';

const packageDir = resolve(process.argv[2] ?? './huelva.mapzero');
const bbox = process.argv[3] ? parseBbox(process.argv[3]) : null;
const outDir = new URL('./', import.meta.url);
const tileName = 'clipper-gpkg-roads.b3dm';
const tilesetName = 'clipper-gpkg-tileset.json';

const manifest = JSON.parse(await readFile(join(packageDir, 'manifest.json'), 'utf8'));
const db = openReadonlyGeoPackage(join(packageDir, String(manifest.data ?? 'data.gpkg')));
try {
  const metadata = readLayerMetadata(db, manifest, 'roads');
  const queryBbox = bbox ?? centerBbox(metadata.bbox, 0.035);
  const features = readLayerFeatures(db, metadata, queryBbox, { limit: 1600 });
  const lines = features.flatMap((feature) => linesFromGeometry(feature.geometry));
  const mesh = await buildClipperLineSurfaceMesh(lines, {
    widthMeters: 10,
    height: 4,
    scale: 100,
    arcToleranceMeters: 0.25,
    cleanDistanceMeters: 0.05
  });

  if (!mesh) {
    throw new Error('Could not build Clipper road mesh from GeoPackage roads');
  }

  const glb = buildGlbFromMesh(mesh, {
    color: [0.03, 0.9, 1, 0.92],
    generator: 'map-zero clipper GeoPackage roads test'
  });
  const b3dm = buildB3dm(glb);
  const tileset = buildTileset({
    bbox: mesh.bbox,
    maxHeight: mesh.maxHeight,
    children: [
      buildContentNode({
        bbox: mesh.bbox,
        maxHeight: mesh.maxHeight,
        uri: tileName
      })
    ]
  });

  await mkdir(outDir, { recursive: true });
  await writeFile(new URL(tileName, outDir), b3dm);
  await writeFile(new URL(tilesetName, outDir), `${JSON.stringify(tileset, null, 2)}\n`);
  await writeFile(new URL('clipper-gpkg.html', outDir), buildHtml(centerOf(mesh.bbox)));

  console.log(`Read ${features.length} road features from ${packageDir}`);
  console.log(`Wrote ${path.join('test-3dtiles', tileName)}`);
  console.log(`Wrote ${path.join('test-3dtiles', tilesetName)}`);
  console.log(`Surfaces: ${mesh.featureCount}, vertices: ${mesh.positions.length / 3}, bytes: ${b3dm.length}`);
} finally {
  db.close();
}

function linesFromGeometry(geometry) {
  if (geometry?.type === 'LineString' && Array.isArray(geometry.coordinates)) {
    return [geometry.coordinates];
  }
  if (geometry?.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  return [];
}

function centerBbox(bbox, span) {
  const lon = (bbox[0] + bbox[2]) / 2;
  const lat = (bbox[1] + bbox[3]) / 2;
  return [lon - span, lat - span, lon + span, lat + span];
}

function centerOf(bbox) {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function buildHtml(center) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>map-zero Clipper GeoPackage roads test</title>
  <script src="https://cesium.com/downloads/cesiumjs/releases/1.145/Build/Cesium/Cesium.js"></script>
  <link href="https://cesium.com/downloads/cesiumjs/releases/1.145/Build/Cesium/Widgets/widgets.css" rel="stylesheet">
  <style>
    html, body, #cesium { width: 100%; height: 100%; margin: 0; background: #000; overflow: hidden; }
  </style>
</head>
<body>
  <div id="cesium"></div>
  <script type="module">
    const viewer = new Cesium.Viewer('cesium', {
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      navigationHelpButton: false,
      baseLayer: false
    });
    viewer.scene.globe.show = false;
    viewer.scene.skyAtmosphere.show = false;
    viewer.scene.fog.enabled = false;
    viewer.scene.backgroundColor = Cesium.Color.BLACK;

    const tileset = await Cesium.Cesium3DTileset.fromUrl('./${tilesetName}');
    viewer.scene.primitives.add(tileset);
    await tileset.readyPromise;
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(${center[0]}, ${center[1]}, 2600),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-90),
        roll: 0
      }
    });
  </script>
</body>
</html>
`;
}
