import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Cartesian3} from 'cesium';
import {encodeVectorContent} from '../src/3dtiles/vector/encode-vector-gltf.js';
import {validateVectorGlb} from '../src/3dtiles/vector/validate.js';
import {VECTOR_FORMAT as E,declareVectorTileset} from '../src/3dtiles/vector/extensions.js';
import {createCesiumTileset} from '../src/3dtiles/create-tileset.js';
import {export3dTiles,exportCesiumTileset} from '../src/3dtiles/export.js';
import {writeGeoPackage} from '../src/gpkg.js';
import decode from '../src/3dtiles/mvt/decode.js';
import {decodedFeatures} from '../src/3dtiles/mvt/features.js';
import {probeCesiumTopology} from './helpers/cesium-topology.js';

function property(result,name,row) {
  const {json,bin}=result,metadata=json.extensions[E.metadata];
  const id=Object.keys(metadata.schema.classes.feature.properties).find(id=>metadata.schema.classes.feature.properties[id].name===name);
  const definition=metadata.schema.classes.feature.properties[id],p=metadata.propertyTables[0].properties[id];
  const offset=json.bufferViews[p.values].byteOffset;
  let value;
  if(definition.type==='SCALAR')value=bin.readDoubleLE(offset+row*8);
  else if(definition.type==='BOOLEAN')value=!!(bin[offset+(row>>3)]&(1<<(row&7)));
  else {const offsets=json.bufferViews[p.stringOffsets].byteOffset;value=bin.subarray(offset+bin.readUInt32LE(offsets+row*4),offset+bin.readUInt32LE(offsets+(row+1)*4)).toString();}
  return value===definition.noData?undefined:value;
}

test('preview compatibility is pinned to the audited loader and renderer sources',async()=>{
  const hashes=JSON.parse(await readFile(new URL('../src/3dtiles/vector/cesium-compatibility.json',import.meta.url)));
  assert.equal(JSON.parse(await readFile(new URL('../node_modules/cesium/package.json',import.meta.url))).version,E.cesium);
  for(const [name,expected]of Object.entries(hashes)){
    const bytes=await readFile(new URL(`../node_modules/@cesium/engine/Source/${name}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,`Re-audit vector preview on Cesium upgrade: ${name}`);
  }
});

test('the pinned runtime still has the documented multi-hole and capacity limitations',()=>{
  // These are observations of the preview dependency, not desired semantics.
  // When Cesium fixes them, update the audit and visual acceptance tests.
  const probe=probeCesiumTopology();
  assert.deepEqual(probe.expectedHoleOffsets,[4,8]);
  assert.deepEqual(probe.actualHoleOffsets,[4,9]);
  assert.equal(probe.allocatedTriangleCapacity,3*probe.triangles);
  assert.equal(probe.reportedMetadataBytesFinite,false);
  assert.equal(probe.modelFeatureTableHasExpectedGetter,false);
});

test('Almudena uses only the new vector extensions and retains all 557 feature rows',async()=>{
  const decoded=decode(Uint8Array.from(await readFile(new URL('./fixtures/cesium-vector-almudena.mvt',import.meta.url))).buffer);
  const features=decodedFeatures(decoded,14,8026,6177),content=encodeVectorContent(features)[0];
  const result=validateVectorGlb(content.bytes),{json}=result;
  assert.equal(content.count,557);assert.deepEqual(content.warnings,{degeneratePolygons:0,collapsedHoles:0});
  assert.equal(json.extensions[E.metadata].propertyTables[0].count,557);
  for(const name of ['roads','railways']){
    const node=json.nodes.find(n=>n.name===name);
    assert.deepEqual(json.meshes[node.mesh].primitives.map(p=>p.mode),[3]);
  }
  features.forEach((f,i)=>{assert.equal(property(result,'id',i),f.properties.id);assert.equal(property(result,'_layer',i),f.layerId);assert.deepEqual(JSON.parse(property(result,'mapzero_properties_json',i)),f.properties);});
  const tree=declareVectorTileset({asset:{version:'1.0',gltfUpAxis:'Z'},root:{content:{uri:'tile.glb'}}});
  assert.equal(tree.asset.version,'1.1');assert.equal(tree.asset.gltfUpAxis,undefined);
  assert.deepEqual(tree.root.content.extensions[E.content],{vector:true});
  assert.ok(!tree.extensionsRequired?.includes(E.content));
});

test('all six geometry types, independent IDs, holes and arbitrary metadata survive',()=>{
  const ring=(x,y,size)=>[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]];
  const p=[-3.64,40.42,123.75];
  const features=[
    {layerId:'survey',id:'same',minZoom:8,maxZoom:12,vertical:{datum:'ellipsoid',lower:12.5},geometry:{type:'Point',coordinates:p},properties:{name:'Observación ñ',value:12.5,active:true,'source:key':'custom',nullable:null,nested:{a:[1,2]}}},
    {layerId:'other',id:'same',geometry:{type:'MultiPoint',coordinates:[p,[-3.641,40.42,125]]},properties:{value:null,active:false}},
    {layerId:'survey',id:'line',geometry:{type:'LineString',coordinates:[p,[-3.641,40.421,124]]},properties:{value:Number.MAX_VALUE}},
    {layerId:'survey',id:'multi-line',geometry:{type:'MultiLineString',coordinates:[[p,[-3.641,40.421,124]],[[-3.639,40.42,3],[-3.638,40.421,4]]]}},
    {layerId:'survey',id:'polygon',geometry:{type:'Polygon',coordinates:[ring(-3.65,40.41,.01),ring(-3.649,40.411,.002),ring(-3.644,40.415,.002)]}},
    {layerId:'survey',id:'multi-polygon',geometry:{type:'MultiPolygon',coordinates:[[ring(-3.66,40.42,.002)],[ring(-3.67,40.42,.002)]]}}
  ];
  const content=encodeVectorContent(features)[0],result=validateVectorGlb(content.bytes),{json,accessor}=result;
  assert.equal(content.count,6);assert.deepEqual(content.warnings,{degeneratePolygons:0,collapsedHoles:0});
  assert.deepEqual(json.meshes[0].primitives.map(p=>p.mode),[0,3,4]);
  const topology=json.meshes[0].primitives[2].extensions[E.polygon];
  assert.equal(topology.count,3);assert.equal(accessor(topology.loopIndices).filter(n=>n===E.restartIndex).length,4);
  assert.equal(property(result,'value',0),12.5);assert.equal(property(result,'active',0),true);
  assert.equal(property(result,'mapzero_minzoom',0),8);assert.equal(property(result,'mapzero_maxzoom',0),12);
  assert.deepEqual(JSON.parse(property(result,'mapzero_vertical',0)),features[0].vertical);
  assert.equal(property(result,'source:key',0),'custom');
  assert.deepEqual(JSON.parse(property(result,'mapzero_properties_json',0)),features[0].properties);
  assert.equal(property(result,'id',5),'same');assert.equal(property(result,'_layer',5),'other');
  assert.equal(property(result,'value',5),undefined);assert.equal(property(result,'active',5),false);
  const node=json.nodes[0],local=accessor(json.meshes[0].primitives[0].attributes.POSITION);
  const gltfWorld=local.slice(0,3).map((n,i)=>n+node.translation[i]);
  const ecef=[gltfWorld[0],-gltfWorld[2],gltfWorld[1]],reference=Cartesian3.fromDegrees(...p);
  assert.ok(Math.hypot(...ecef.map((v,i)=>v-[reference.x,reference.y,reference.z][i]))<0.001,'standard Y-up glTF transforms to the original WGS84 point');
  assert.deepEqual(encodeVectorContent(features)[0].bytes,content.bytes,'deterministic output');
});

test('points need neither polygon topology nor primitive restart; invalid inputs fail clearly',()=>{
  const f={geometry:{type:'Point',coordinates:[0,0]},properties:{name:''}};
  const result=validateVectorGlb(encodeVectorContent([f])[0].bytes);
  assert.deepEqual(result.json.extensionsUsed,[E.features,E.metadata]);assert.equal(property(result,'name',0),'');
  assert.deepEqual(encodeVectorContent([]),[]);
  assert.throws(()=>encodeVectorContent([{...f,geometry:{type:'Point',coordinates:[NaN,0]}}]),/Invalid vector coordinates/);
  assert.throws(()=>encodeVectorContent([{...f,properties:{value:Infinity}}]),/Non-finite metadata/);
  assert.throws(()=>encodeVectorContent([{...f,geometry:{type:'CircularString',coordinates:[[0,0],[1,1]]}}]),/Unsupported vector geometry/);
});

test('source degeneracy is counted, and loop indices never reference discarded triangulation vertices',()=>{
  const features=[{geometry:{type:'MultiPolygon',coordinates:[
    [[[0,0],[1,0],[2,0],[2,2],[0,2],[0,0]],[[.2,.2],[.2,.2],[.2,.2],[.2,.2]]],
    [[[4,4],[4,4],[4,4],[4,4]]]
  ]}}];
  const content=encodeVectorContent(features)[0];validateVectorGlb(content.bytes);
  assert.deepEqual(content.warnings,{degeneratePolygons:1,collapsedHoles:1});
});

test('GeoPackage source and ownership hierarchy are shared by mesh and preview encoders',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mapzero-vector-content-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const bbox=[-1,-1,1,1],layer={id:'observations',table:'external_table',minZoom:5,maxZoom:15,featureZoom:{minColumn:'first',maxColumn:'last'}};
  const features=Array.from({length:8},(_,i)=>({geometry:{type:'LineString',coordinates:[[-.8+i*.2,-.5],[-.7+i*.2,.5]]},properties:{id:`survey/${i}`,first:8,last:12,value:i+.75}}));
  writeGeoPackage(join(dir,'data.gpkg'),{external_table:features},[{id:'external_table',geometryType:'LINESTRING',columns:{id:'TEXT',first:'INTEGER',last:'INTEGER',value:'REAL'}}],bbox);
  await writeFile(join(dir,'manifest.json'),JSON.stringify({format:'mapzero',version:1,bbox,layers:[layer]}));
  const options={packageDir:dir,maxFeatures:2,maxDepth:4};
  const mesh=await export3dTiles({...options,contextFormat:'mesh',out:join(dir,'mesh')});
  const preview=await exportCesiumTileset({...options,out:join(dir,'preview')},encodeVectorContent);
  assert.deepEqual(preview.layers,mesh.layers);assert.equal(preview.leafCount,mesh.leafCount);
  const tree=JSON.parse(await readFile(preview.tilesetPath));let rows=0;
  async function visit(node){
    if(node.content){
      assert.deepEqual(node.content.extensions[E.content],{vector:true});
      const result=validateVectorGlb(await readFile(join(dirname(preview.tilesetPath),node.content.uri)));
      const count=result.json.extensions[E.metadata].propertyTables[0].count;rows+=count;
      for(let i=0;i<count;i++){assert.equal(property(result,'_layer',i),'observations');assert.equal(property(result,'mapzero_minzoom',i),8);assert.equal(property(result,'mapzero_maxzoom',i),12);}
    }
    for(const child of node.children??[])await visit(child);
  }
  await visit(tree.root);assert.equal(rows,8);
});

test('shared LOD writer creates only occupied contents and tight containing REPLACE bounds',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mapzero-vector-lod-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  async function* source(){for(const [z,x,y]of [[14,8026,6177],[16,32104,24708]])yield {z,x,y,features:[{geometry:{type:'Point',coordinates:[-3.64,40.42,20]},properties:{id:'one'}}]};}
  const result=await createCesiumTileset({source:source(),contentEncoder:encodeVectorContent,out:dir,minZoom:12,maxZoom:16});
  assert.equal(result.writtenTiles,2);let count=0;
  function visit(node,parent){
    const r=node.boundingVolume.region;assert.equal(node.refine,'REPLACE');assert.ok(r[5]-r[4]<10);
    if(parent)for(let i=0;i<6;i++)assert.ok(i<2||i===4?r[i]>=parent[i]:r[i]<=parent[i]);
    if(node.content)count++;
    for(const child of node.children??[])visit(child,r);
  }
  visit(result.tileset.root);assert.equal(count,2);
});
