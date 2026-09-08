import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { unzipSync } from 'fflate';
import { createMapZeroServer } from '../src/server.js';
import { packageMapZero } from '../src/package.js';
import { writeGeoPackage } from '../src/gpkg.js';
import { resolveManifestLayers } from '../src/manifest.js';
import { export3dTiles } from '../src/3dtiles/export.js';
import { Cesium3DTileset } from 'cesium';
import { createMapZeroCesiumTilesets } from '../packages/cesium/src/index.js';
import { buildPolygonSurfaceMesh } from '../src/3dtiles/flat.js';

const ids = ['roads','buildings','water','landuse','railways','boundaries','aip','pois','terrain','coastline','cliffs','group / name'];
const polygon = {type:'Polygon',coordinates:[[[-0.02,-0.02],[0.02,-0.02],[0.02,0.02],[-0.02,0.02],[-0.02,-0.02]]]};
const line = {type:'LineString',coordinates:[[-0.03,0],[0.03,0]]};
const point = {type:'Point',coordinates:[0,0]};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(),'mapzero-static-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const bbox = [-0.04,-0.04,0.04,0.04];
  const layers = [...ids.map(id=>({id,table:`table_${id}`})),{id:'observations',table:'survey',minZoom:5,maxZoom:13,featureZoom:{minColumn:'first',maxColumn:'last'}}];
  const schemas = layers.map(({table:id})=>({id,geometryType:'GEOMETRY',columns:{id:'TEXT',name:'TEXT',height:'REAL',quality:'INTEGER',first:'INTEGER',last:'INTEGER'}}));
  const features = Object.fromEntries(layers.map(({id,table})=>[table,[polygon,line,point].map((geometry,i)=>({
    geometry:id==='buildings'?polygon:geometry,properties:{id:`${id}-${i}`,name:`Example ${id} ${i}`,height:17.5,quality:2,first:8,last:11}
  }))]));
  writeGeoPackage(join(dir,'data.gpkg'),features,schemas,bbox);
  await writeFile(join(dir,'manifest.json'),JSON.stringify({format:'mapzero',version:1,bbox,layers,styles:{}}));
  return dir;
}

function contentTables(bytes) {
  const featureLength=bytes.readUInt32LE(12),binaryLength=bytes.readUInt32LE(16),batchLength=bytes.readUInt32LE(20);
  const feature=JSON.parse(bytes.subarray(28,28+featureLength));
  const offset=28+featureLength+binaryLength;
  const batch=JSON.parse(bytes.subarray(offset,offset+batchLength));
  return {feature,batch,glb:bytes.subarray(offset+batchLength+bytes.readUInt32LE(24))};
}

test('all logical layers and a custom layer have static content, streamed labels and bounded unique batches',async(t)=>{
  const dir=await fixture(t);
  for(const maxDepth of [0,3]) {
    const result=await export3dTiles({contextFormat:'mesh',packageDir:dir,maxDepth,maxFeatures:2});
    const manifest=JSON.parse(await readFile(join(dir,'manifest.json')));
    assert.deepEqual(Object.keys(manifest.tiles3d.tilesets),[...ids,'observations']);
    for(const [id,url] of Object.entries(manifest.tiles3d.tilesets)) {
      const tileset=JSON.parse(await readFile(join(dir,url)));
      const seen=new Set();let contents=0;
      async function walk(node,parent) {
        const region=node.boundingVolume.region;
        assert.ok(region.every(Number.isFinite));
        if(parent)for(let i=0;i<6;i++)assert.ok(i<2||i===4?region[i]>=parent[i]-1e-9:region[i]<=parent[i]+1e-9);
        if(node.content) {
          contents++;
          const bytes=await readFile(join(dir,dirname(url),node.content.uri));
          assert.equal(bytes.readUInt32LE(8),bytes.length);
          const {feature,batch,glb}=contentTables(bytes);
          assert.ok(feature.BATCH_LENGTH<=2);
          assert.equal(batch.id.length,feature.BATCH_LENGTH);
          assert.ok(batch.mapzero_label_lon.every(Number.isFinite));
          for(let i=0;i<batch.id.length;i++) {
            assert.ok(!seen.has(batch.id[i]),batch.id[i]);seen.add(batch.id[i]);
            assert.equal(batch.mapzero_layer[i],id);assert.equal(batch.quality[i],2);assert.equal(batch.height[i],17.5);
            if(id==='observations'){assert.equal(batch.mapzero_minzoom[i],8);assert.equal(batch.mapzero_maxzoom[i],11);}
          }
          if(bytes.subarray(0,4).toString()==='b3dm') {
            const json=JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)));
            const attributes=json.meshes[0].primitives[0].attributes;
            assert.equal(json.accessors[attributes._BATCHID].count,json.accessors[attributes.POSITION].count);
          } else {
            assert.equal(bytes.subarray(0,4).toString(),'pnts');
            assert.equal(feature.POINTS_LENGTH,feature.BATCH_LENGTH);
            assert.equal(feature.BATCH_ID.componentType,'UNSIGNED_SHORT');
          }
        }
        for(const child of node.children??[])await walk(child,region);
      }
      await walk(tileset.root);
      assert.equal(seen.size,3,id);assert.ok(contents>=2);
      assert.equal(result.layers[id].featureCount,3);
      assert.ok(result.layers[id].maxLeafFeatures<=2);assert.ok(result.layers[id].maxDepth<=maxDepth);
    }
    assert.equal(manifest.tiles,undefined);
    assert.equal(manifest.cesium,undefined);
  }
});

test('flat polygon surfaces keep holes open',()=>{
  const outer=[[0,0],[0.01,0],[0.01,0.01],[0,0.01],[0,0]];
  const hole=[[0.002,0.002],[0.008,0.002],[0.008,0.008],[0.002,0.008],[0.002,0.002]];
  const mesh=buildPolygonSurfaceMesh([{geometry:{type:'Polygon',coordinates:[outer,hole]}}],{height:4});
  // A triangulation of a four-vertex outer ring with a four-vertex hole has 8 triangles.
  assert.equal(mesh.indices.length,24);
  assert.equal(mesh.positions.length/3,8);
});

test('static strategy descriptors are validated independently of storage table names',()=>{
  const layer={id:'observations',table:'measurements',tiles3d:{strategy:'mixed',height:12,widthMeters:4}};
  assert.deepEqual(resolveManifestLayers({layers:[layer]}),[layer]);
  for(const tiles3d of ['points',null,{strategy:'invalid'},{height:NaN},{widthMeters:-1}]) {
    assert.throws(()=>resolveManifestLayers({layers:[{id:'x',tiles3d}]}),/invalid manifest tiles3d/);
  }
});

test('Cesium tears down partial tileset creation on a failed static URL',async(t)=>{
  let destroyed=false,calls=0;
  t.mock.method(Cesium3DTileset,'fromUrl',async()=>{
    if(calls++)throw new Error('missing tileset');
    return {destroy(){destroyed=true;}};
  });
  await assert.rejects(createMapZeroCesiumTilesets({
    manifestUrl:'https://example.com/map/manifest.json',styleJson:{},
    manifest:{tiles3d:{format:'3dtiles',tilesets:{roads:'roads.json',pois:'pois.json'}}}
  }),/missing tileset/);
  assert.equal(destroyed,true);
});

test('portable ZIP includes every static tileset and point content without GeoPackage',async(t)=>{
  const dir=await fixture(t);
  await export3dTiles({contextFormat:'mesh',packageDir:dir,maxFeatures:2});
  const result=await packageMapZero({packageDir:dir,out:join(dir,'delivery.zip')});
  const entries=unzipSync(await readFile(result.outPath));
  const manifest=JSON.parse(Buffer.from(entries[`${basename(dir)}/manifest.json`]).toString());
  for(const url of Object.values(manifest.tiles3d.tilesets))assert.ok(entries[`${basename(dir)}/${url}`],url);
  assert.ok(Object.keys(entries).some(name=>name.endsWith('.pnts')));
  assert.ok(!Object.keys(entries).some(name=>name.endsWith('.gpkg')));
  assert.equal(Object.keys(entries).length,result.fileCount);
});

test('built-in preview serves static Cesium packages without opening GeoPackage',async(t)=>{
  const dir=await fixture(t);
  await export3dTiles({contextFormat:'mesh',packageDir:dir});
  await rm(join(dir,'data.gpkg'));
  const app=await createMapZeroServer({packageDir:dir});
  try {
    assert.equal((await app.inject('/cesium')).statusCode,200);
    assert.equal((await app.inject('/3dtiles/pois/tileset.json')).statusCode,200);
    assert.equal((await app.inject('/api/tiles/14/8192/8192.mvt')).statusCode,409);
    assert.match((await app.inject('/api/info')).body,/no GeoPackage/);
  }finally{await app.close();}
});

test('static export validates mapped zoom columns before replacing existing artifacts',async(t)=>{
  const dir=await fixture(t);
  await export3dTiles({contextFormat:'mesh',packageDir:dir});
  const original=await readFile(join(dir,'3dtiles/roads/tileset.json'));
  const file=join(dir,'manifest.json');
  const manifest=JSON.parse(await readFile(file));
  manifest.layers[0].featureZoom={minColumn:'name'};
  await writeFile(file,JSON.stringify(manifest));
  await assert.rejects(export3dTiles({contextFormat:'mesh',packageDir:dir}),/declare INTEGER/);
  assert.deepEqual(await readFile(join(dir,'3dtiles/roads/tileset.json')),original);
});
