# README recordings

These animations show an actual map-zero package generated from a local Madrid OpenStreetMap extract. The bbox builder animation captures drawing a rectangle and choosing outputs in the real `bbox-ui`; it stops before submitting a build job. The generation animation is a time-compressed replay of [the captured CLI output](generation.log). The 2D and 3D animations are screenshots of the actual OpenLayers and Cesium viewers, with camera movement and captions added by the recording script.

Static previews, for readers who prefer no animation:

- [Draw a bbox and configure the build](bbox-builder.png)
- [Generation](generate.png)
- [OpenLayers 2D](openlayers-2d.png)
- [Cesium static vector 3D Tiles, buildings and labels](cesium-3d.png)

Data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), from the local Geofabrik Madrid extract. Bbox: `-3.710,40.413,-3.696,40.422`. Source data and generated map packages are not committed to the repository.

## Reproduce

Record the bbox builder independently, without a generated package:

```bash
npm run docs:record:bbox
```

This opens the real builder on a temporary local port, loads OpenStreetMap basemap tiles, draws a bbox with mouse interactions, and chooses an output name and export formats. It asserts that coordinates were populated and records `bbox-builder.gif` plus a static preview. It does not submit a generation job or simulate build results.


Use Node 22+, Chromium, FFmpeg and `npm ci`. Set `CHROMIUM_PATH` if Chromium is not installed at `/usr/bin/chromium`. The viewers load JS/CSS dependencies from CDNs; map data stays local. The recorder uses an isolated browser profile and a temporary local server.

```bash
mkdir -p docs/media
node src/cli.js build data/madrid.osm.pbf \
  --bbox -3.710,40.413,-3.696,40.422 \
  --out generated/readme-demo.mapzero > docs/media/generation.log 2>&1
node src/cli.js pmtiles generated/readme-demo.mapzero \
  --minzoom 8 --maxzoom 16 --workers 4 >> docs/media/generation.log 2>&1
node src/cli.js 3dtiles generated/readme-demo.mapzero >> docs/media/generation.log 2>&1
npm run docs:record -- generated/readme-demo.mapzero docs/media/generation.log
npm run test:browser -- generated/readme-demo.mapzero
```

Camera coordinates in `scripts/record-readme.mjs` target this Madrid bbox. Adapt those coordinates before recording another area. The script never invents generation progress: it reads the supplied log. Inspect successful completion of all three CLI commands before recording.

GIFs are scaled to 720 pixels wide at 4 frames per second with a 128-color palette and no dithering to reduce README download size. Static PNG previews preserve the original 1120 × 680 screenshots. The original map-zero theme and renderer behavior remain visible; Cesium rendering limits are described in [the guide](../cesium.md).
