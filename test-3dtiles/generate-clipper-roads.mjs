import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildB3dm } from '../src/3dtiles/b3dm.js';
import { buildClipperLineSurfaceMesh } from '../src/3dtiles/clipper-surfaces.js';
import { buildGlbFromMesh } from '../src/3dtiles/glb.js';
import { buildContentNode, buildTileset } from '../src/3dtiles/tileset.js';

const outDir = new URL('./', import.meta.url);
const tileName = 'clipper-roads.b3dm';
const tilesetName = 'clipper-tileset.json';

const lines = [
  [
    [-3.704, 40.4097],
    [-3.7026, 40.4101],
    [-3.7012, 40.41055],
    [-3.6995, 40.41075],
    [-3.6978, 40.41065]
  ],
  [
    [-3.7029, 40.4084],
    [-3.7022, 40.40955],
    [-3.7017, 40.41065],
    [-3.7011, 40.41185],
    [-3.7005, 40.41275]
  ],
  [
    [-3.7038, 40.4118],
    [-3.7027, 40.41125],
    [-3.70165, 40.41065],
    [-3.7004, 40.40995],
    [-3.6992, 40.40945]
  ],
  [
    [-3.70065, 40.40905],
    [-3.69995, 40.40935],
    [-3.69955, 40.40995],
    [-3.6997, 40.41055],
    [-3.70035, 40.41085],
    [-3.70105, 40.41065],
    [-3.70135, 40.41005],
    [-3.7011, 40.40945],
    [-3.70065, 40.40905]
  ],
  [
    [-3.7023, 40.41055],
    [-3.7018, 40.41115],
    [-3.70115, 40.41155],
    [-3.7003, 40.41175],
    [-3.69935, 40.41165]
  ]
];

const mesh = await buildClipperLineSurfaceMesh(lines, {
  widthMeters: 18,
  height: 4,
  scale: 100,
  arcToleranceMeters: 0.2,
  cleanDistanceMeters: 0.03
});

if (!mesh) {
  throw new Error('Could not build Clipper road mesh');
}

const glb = buildGlbFromMesh(mesh, {
  color: [0.03, 0.9, 1, 0.92],
  generator: 'map-zero clipper road surface test'
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
await writeFile(new URL('clipper.html', outDir), buildHtml());

console.log(`Wrote ${path.join('test-3dtiles', tileName)}`);
console.log(`Wrote ${path.join('test-3dtiles', tilesetName)}`);
console.log(`Features: ${mesh.featureCount}, vertices: ${mesh.positions.length / 3}, bytes: ${b3dm.length}`);

function buildHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>map-zero Clipper roads test</title>
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
      destination: Cesium.Cartesian3.fromDegrees(-3.701, 40.4106, 900),
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
