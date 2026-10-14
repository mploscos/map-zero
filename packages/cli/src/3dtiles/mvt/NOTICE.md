# MVT decoding attribution

`decode.js` is adapted from CesiumJS 1.145.0 / @cesium/engine 26.3.0,
`Source/Scene/decodeMVT.js`, Copyright 2011–2024 CesiumJS Contributors,
under Apache-2.0 (see LICENSE.md). The only runtime dependency change replaces
Cesium RuntimeError with native Error. No Cesium imports are used at build time.
`features.js` maps decoded tile coordinates and ring winding to WGS84 GeoJSON.
The Cesium decoder is retained for the tested MVT conversion semantics; its
older vector GLB builder is not included.
