import { geometryBbox } from '../mvt-utils.js';
import { buildContextMesh, mergeBounds } from './context-mesh.js';
import { buildB3dm } from './b3dm.js';
import { buildGlbFromMesh } from './glb.js';
import { buildPointTile } from './pnts.js';

/** Stable mesh content encoder. Spatial ownership and file writing are external.
 * @param {object[]} features
 * @param {{policy:object,defaultHeight?:number}} options
 */
export function encodeMeshContent(features, {policy, defaultHeight = 9}) {
  const points = features.filter(f => f.geometry.type === 'Point');
  const shapes = features.filter(f => f.geometry.type !== 'Point').map(f => {
    if (policy.strategy !== 'line' || !f.geometry.type.includes('Polygon')) return f;
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return { ...f, geometry: { type:'MultiLineString', coordinates:polygons.flat() },
      properties: { ...f.properties, mapzero_geometry:'MultiLineString' } };
  });
  const contents = [];
  if (points.length) contents.push({ bytes: buildPointTile(points, policy.height), extension:'pnts',
    bbox: mergeBounds(points.map(f => geometryBbox(f.geometry))), maxHeight:policy.height, count:points.length });
  const mesh = buildContextMesh(shapes, policy.strategy, { ...policy, defaultHeight });
  if (mesh) contents.push({ bytes:buildB3dm(buildGlbFromMesh(mesh, {
    color:[1,1,1,1], includeNormals:policy.strategy === 'extruded', doubleSided:true, unlit:policy.strategy !== 'extruded'
  }), { rtcCenter:mesh.rtcCenter, properties:mesh.properties }), extension:'b3dm', ...mesh, count:mesh.properties.length });
  return contents;
}
