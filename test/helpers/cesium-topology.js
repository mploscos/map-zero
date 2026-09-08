import * as C from 'cesium';
import {encodeVectorContent} from '../../src/3dtiles/vector/encode-vector-gltf.js';
import {inspectVectorGlb} from '../../src/3dtiles/vector/validate.js';
import {tileToBbox} from '../../src/mvt.js';
import {decodedFeatures} from '../../src/3dtiles/mvt/features.js';

const ring=(x,y,s)=>[{x,y},{x:x+s,y},{x:x+s,y:y+s},{x,y:y+s},{x,y}];
const decoded={layers:[{name:'survey',extent:4096,features:[{type:'Polygon',properties:{id:'polygon-with-two-holes'},geometry:[ring(512,512,3072),ring(1024,1024,512).reverse(),ring(2560,2560,512).reverse()]}]},
  {name:'markers',extent:4096,features:[{type:'Point',properties:{id:'native-point'},geometry:[{x:2048,y:2048}]}]}]};
const bbox=tileToBbox(14,8026,6177);

/** Test oracle only: @ignore Cesium model components, pinned to 1.145.0.
 * This is a minimal reproducible runtime issue, never a production dependency.
 */
export function probeCesiumTopology() {
  const bytes=encodeVectorContent(decodedFeatures(decoded,14,8026,6177),{bbox})[0].bytes;
  const data=inspectVectorGlb(bytes),p=data.json.meshes[0].primitives[0],topology=p.extensions.EXT_mesh_polygon;
  const primitive=new C.ModelComponents.Primitive();primitive.primitiveType=4;
  const attribute=new C.ModelComponents.Attribute();
  Object.assign(attribute,{semantic:C.VertexAttributeSemantic.POSITION,componentDatatype:C.ComponentDatatype.FLOAT,type:'VEC3',
    count:data.accessor(p.attributes.POSITION).length/3,typedArray:new Float32Array(data.accessor(p.attributes.POSITION))});
  primitive.attributes=[attribute];primitive.indices=new C.ModelComponents.Indices();
  Object.assign(primitive.indices,{typedArray:new Uint32Array(data.accessor(p.indices)),count:data.accessor(p.indices).length,indexDatatype:C.ComponentDatatype.UNSIGNED_INT});
  primitive.polygon=new C.ModelComponents.Polygon();
  Object.assign(primitive.polygon,{count:topology.count,loopIndices:new Uint32Array(data.accessor(topology.loopIndices)),
    loopIndicesOffsets:new Uint32Array(data.accessor(topology.loopIndicesOffsets)),triangleIndices:primitive.indices.typedArray,
    triangleIndicesOffsets:new Uint32Array(data.accessor(topology.indicesOffsets))});
  const node=new C.ModelComponents.Node();node.primitives=[primitive];
  const components=new C.ModelComponents.Components();components.scene=new C.ModelComponents.Scene();components.scene.nodes=[node];
  const result=C.createVectorTileBuffersFromModelComponents({tileset:{featureIdLabel:'featureId_0'}},components);
  const collection=result.collections[0],polygon=collection.get(0,new C.BufferPolygon());
  const content=Object.create(C.VectorGltf3DTileContent.prototype);
  const table=Object.create(C.ModelFeatureTable.prototype);
  content._model={_featureTables:[table]};
  return {cesium:C.VERSION,expectedHoleOffsets:[4,8],actualHoleOffsets:Array.from(polygon.getHoles()),
    triangles:collection.triangleCount,allocatedTriangleCapacity:collection.triangleCountMax,
    reportedMetadataBytesFinite:Number.isFinite(content.batchTableByteLength),
    modelFeatureTableHasExpectedGetter:'batchTableByteLength' in table};
}
