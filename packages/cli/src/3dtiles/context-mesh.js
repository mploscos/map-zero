import { buildMergedExtrudedPolygonMesh } from './extrude.js';
import { buildLineRibbonMesh, buildPolygonSurfaceMesh } from './flat.js';
import { localizeEcefPositions } from './precision.js';
import { buildingHeight } from './gpkg-buildings.js';

/** Build localized feature meshes, retaining a batch ID for every vertex. */
export function buildContextMesh(features, strategy, options = {}) {
  const positions = [], normals = [], indices = [], ids = [], properties = [], boxes = [];
  let maxHeight = 1;
  for (const feature of features) {
    const geometry = feature.geometry;
    const line = geometry.type.includes('Line');
    let mesh;
    if (strategy === 'extruded' && geometry.type.includes('Polygon')) {
      const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
      mesh = buildMergedExtrudedPolygonMesh(polygons.map((polygon) => ({ coordinates: polygon[0], height: buildingHeight(feature.properties, options.defaultHeight ?? 9) })));
    } else if (line) {
      mesh = buildLineRibbonMesh([feature], { height: options.height ?? 10, widthMeters: options.widthMeters ?? 6,
        join: 'round', cap: 'round', roundSegments: 4, miterLimit: 3.5 });
    } else if (geometry.type.includes('Polygon')) {
      mesh = buildPolygonSurfaceMesh([feature], { height: options.height ?? 4 });
    }
    if (!mesh) continue;
    const batchId = properties.length, offset = positions.length / 3;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) positions.push(mesh.positions[i + axis] + mesh.rtcCenter[axis]);
      normals.push(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]);
      ids.push(batchId);
    }
    for (const index of mesh.indices) indices.push(index + offset);
    properties.push(feature.properties); boxes.push(mesh.bbox); maxHeight = Math.max(maxHeight, mesh.maxHeight);
  }
  if (!properties.length) return null;
  const localized = localizeEcefPositions(positions);
  return { ...localized, normals: new Float32Array(normals),
    indices: positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    batchIds: properties.length > 65535 ? new Float32Array(ids) : new Uint16Array(ids),
    properties, featureCount: properties.length, bbox: mergeBounds(boxes), maxHeight };
}
export function mergeBounds(boxes) {
  return [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
    Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
}
