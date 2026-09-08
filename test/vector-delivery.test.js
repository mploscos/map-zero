import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {decodeMVT as referenceDecode,Cesium3DTileset,HeightReference} from 'cesium';
import decode from '../src/3dtiles/mvt/decode.js';
import {writeGeoPackage} from '../src/gpkg.js';
import {export3dTiles} from '../src/3dtiles/export.js';
import {validateVectorGlb} from '../src/3dtiles/vector/validate.js';
import {createMapZeroCesiumTilesets} from '../packages/cesium/src/index.js';
import {packageMapZero} from '../src/package.js';
import {unzipSync} from 'fflate';

test('MVT adapter retains the pinned decoder semantics without a runtime Cesium dependency',async()=>{
  const bytes=Uint8Array.from(await readFile(new URL('./fixtures/cesium-vector-almudena.mvt',import.meta.url))).buffer;
  assert.deepEqual(decode(bytes),referenceDecode(bytes));
  for(const data of [[26,255],[26,10,10,50]])assert.throws(()=>decode(Uint8Array.from(data).buffer));
});

test('default delivery exports shared vector LODs and independent extruded meshes',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mapzero-delivery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const bbox=[-3.6402,40.4198,-3.6398,40.4202];
  const layers=[{id:'markers',minZoom:13,maxZoom:15,featureZoom:{minColumn:'first',maxColumn:'last'}},
    {id:'paths'},{id:'regions'},{id:'buildings',tiles3d:{strategy:'extruded'}}];
  const polygon={type:'Polygon',coordinates:[[[-3.6401,40.4199],[-3.6399,40.4199],[-3.6399,40.4201],[-3.6401,40.4201],[-3.6401,40.4199]]]};
  const feature=(id,geometry,extra={})=>({geometry,properties:{id,name:'Medición',value:12.5,...extra}});
  writeGeoPackage(join(dir,'data.gpkg'),{
    markers:[feature('early',{type:'Point',coordinates:[-3.64,40.42]},{first:13,last:13}),feature('late',{type:'Point',coordinates:[-3.64001,40.42]},{first:14,last:14})],
    paths:[feature('line',{type:'LineString',coordinates:[[-3.6401,40.42],[-3.6399,40.42]]})],
    regions:[feature('polygon',polygon)],buildings:[feature('building',polygon)]
  },layers.map(l=>({id:l.id,geometryType:'GEOMETRY',columns:{id:'TEXT',name:'TEXT',value:'REAL',first:'INTEGER',last:'INTEGER'}})),bbox);
  await writeFile(join(dir,'manifest.json'),JSON.stringify({format:'mapzero',version:1,bbox,layers,tiles:{minZoom:13,maxZoom:15}}));
  const source=await readFile(join(dir,'data.gpkg'));
  const result=await export3dTiles({packageDir:dir});
  assert.ok(result.writtenTiles>0);
  const manifest=JSON.parse(await readFile(join(dir,'manifest.json')));
  assert.equal(manifest.tiles3d.tilesets.markers,manifest.tiles3d.tilesets.paths);
  assert.notEqual(manifest.tiles3d.tilesets.markers,manifest.tiles3d.tilesets.buildings);
  const tree=JSON.parse(await readFile(join(dir,manifest.tiles3d.tilesets.markers)));
  assert.ok(tree.extensionsUsed.includes('3DTILES_content_gltf_vector'));
  const ids=new Map(),modes=new Set();
  async function visit(node){
    if(node.content){
      const {json}=validateVectorGlb(await readFile(join(dir,dirname(manifest.tiles3d.tilesets.markers),node.content.uri)));
      for(const m of json.meshes)for(const p of m.primitives)modes.add(p.mode);
      const {bin}=validateVectorGlb(await readFile(join(dir,dirname(manifest.tiles3d.tilesets.markers),node.content.uri)));
      const p=json.extensions.EXT_structural_metadata.propertyTables[0].properties.id;
      const offsets=json.bufferViews[p.stringOffsets].byteOffset,values=json.bufferViews[p.values].byteOffset;
      const found=ids.get(node.extras.z)??new Set();ids.set(node.extras.z,found);
      for(let i=0;i<json.extensions.EXT_structural_metadata.propertyTables[0].count;i++)found.add(bin.subarray(values+bin.readUInt32LE(offsets+i*4),values+bin.readUInt32LE(offsets+(i+1)*4)).toString());
    }
    for(const child of node.children??[])await visit(child);
  }
  await visit(tree.root);
  assert.ok(ids.get(13).has('early'));assert.ok(!ids.get(13).has('late'));
  assert.ok(ids.get(14).has('late'));assert.ok(!ids.get(14).has('early'));
  assert.ok(!ids.get(15).has('early')&&!ids.get(15).has('late'));
  assert.deepEqual([...modes].sort(),[0,3,4]);
  const building=JSON.parse(await readFile(join(dir,manifest.tiles3d.tilesets.buildings)));
  assert.equal(building.extensionsUsed,undefined);
  assert.deepEqual(await readFile(join(dir,'data.gpkg')),source);
  const zip=await packageMapZero({packageDir:dir,out:join(dir,'delivery.zip')});
  const names=Object.keys(unzipSync(await readFile(zip.outPath)));
  assert.ok(names.some(n=>n.endsWith('.glb'))&&names.some(n=>n.endsWith('.b3dm')));
  assert.ok(!names.some(n=>/\.(mvt|gpkg)$/.test(n)));
});

test('viewer shares context URLs and defaults to NONE; clamping is explicit',async t=>{
  const calls=[];
  t.mock.method(Cesium3DTileset,'fromUrl',async(url,options)=>{calls.push({url,options});return {hasExtension:()=>true,destroy(){}};});
  const options={manifestUrl:'https://example.com/manifest.json',styleJson:{},manifest:{tiles3d:{format:'3dtiles',tilesets:{a:'context/tileset.json',b:'context/tileset.json'}}}};
  const result=await createMapZeroCesiumTilesets(options);
  assert.equal(calls.length,1);assert.equal(result.tilesets.a,result.tilesets.b);
  assert.equal(calls[0].options.heightReference,HeightReference.NONE);
  assert.equal(result.tilesets.a.maximumScreenSpaceError,8);
  await createMapZeroCesiumTilesets({...options,clampToTerrain:true,scene:{}});
  assert.equal(calls[1].options.heightReference,HeightReference.CLAMP_TO_TERRAIN);
});
