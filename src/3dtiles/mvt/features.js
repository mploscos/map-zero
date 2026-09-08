/** MVT -> generic WGS84 features adapter. Ring grouping follows the
 * pinned Cesium 1.145 decoder/builder reference; no storage or content encoding.
 */
export function decodedFeatures(decoded, z, x, y) {
  const result = [];
  for (const layer of decoded.layers) {
    const coordinate = p => [((x + p.x / layer.extent) / 2 ** z * 2 * Math.PI - Math.PI) * 180 / Math.PI,
      Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + p.y / layer.extent) / 2 ** z))) * 180 / Math.PI];
    for (const feature of layer.features) {
      let geometry;
      if (feature.type === 'Point') geometry = feature.geometry.length === 1
        ? {type:'Point',coordinates:coordinate(feature.geometry[0])}
        : {type:'MultiPoint',coordinates:feature.geometry.map(coordinate)};
      else if (feature.type === 'LineString') geometry = {type:'MultiLineString',coordinates:feature.geometry.map(line=>line.map(coordinate))};
      else if (feature.type === 'Polygon') {
        const polygons = [];
        for (const raw of feature.geometry) {
          const ring = raw.length > 1 && raw[0].x === raw.at(-1).x && raw[0].y === raw.at(-1).y ? raw.slice(0,-1) : raw;
          if (ring.length < 3) continue;
          let area = 0;
          for (let i=0,j=ring.length-1;i<ring.length;j=i++) area += (ring[j].x+ring[i].x)*(ring[j].y-ring[i].y);
          if (area <= 0) polygons.push([ring.map(coordinate)]);
          else if (polygons.length) polygons.at(-1).push(ring.map(coordinate));
        }
        geometry = {type:'MultiPolygon',coordinates:polygons};
      }
      if (geometry) result.push({id:feature.id,layerId:layer.name,geometry,properties:{...feature.properties,_layer:layer.name}});
    }
  }
  return result;
}
