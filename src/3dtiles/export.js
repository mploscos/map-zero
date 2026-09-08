import { promises as fs } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { resolveManifestLayers } from '../manifest.js';
import { quoteIdentifier } from '../utils.js';
import { labelAnchorForGeometry } from '../mvt-utils.js';
import { getLayerRule, mergeFeatureRule } from '../../packages/core/src/style.js';
import { openReadonlyGeoPackage } from './gpkg-buildings.js';
import { readLayerMetadata, createOwnedFeatureSource } from './gpkg-features.js';
import { buildTileset, buildContentNode } from './tileset.js';
import { encodeMeshContent } from './encode-mesh.js';
import { resolveMeshPolicy } from './mesh-policy.js';
import { partitionFeatures } from './partition.js';
import { exportVectorContext } from './vector-context.js';

/** Export spatially partitioned, feature-addressable static Cesium context.
 * @param {{packageDir:string, out?:string, layers?:string[]|string, maxDepth?:number,
 * maxFeatures?:number, defaultHeight?:number, contextFormat?:'vector'|'mesh',
 * minZoom?:number,maxZoom?:number,onProgress?:(event:object)=>void}} options
 */
export async function export3dTiles(options) {
  if (!['vector','mesh'].includes(options.contextFormat ?? 'vector')) throw new Error('contextFormat must be vector or mesh');
  return exportCesiumTileset(options, options.contextFormat === 'mesh' ? encodeMeshContent : undefined);
}

/** Shared orchestration. An explicit encoder uses the feature ownership tree;
 * the default combines vector context LODs and ordinary extruded meshes. */
export async function exportCesiumTileset(options, contentEncoder) {
  const packageDir = resolve(options.packageDir);
  const manifestPath = join(packageDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const descriptors = resolveManifestLayers(manifest);
  if (manifest.format !== 'mapzero' || !Array.isArray(manifest.bbox) || manifest.bbox.length !== 4 ||
      !manifest.bbox.every(Number.isFinite) || manifest.bbox[0] >= manifest.bbox[2] || manifest.bbox[1] >= manifest.bbox[3]) {
    throw new Error('3D Tiles export requires a mapzero manifest with a valid bbox');
  }
  const requested = options.layers === undefined ? descriptors.map(layer => layer.id)
    : (Array.isArray(options.layers) ? options.layers : options.layers.split(',')).map(id => id.trim());
  const selected = [...new Set(requested)].map(id => {
    const layer = descriptors.find(layer => layer.id === id) ?? descriptors.find(layer => layer.id === (id === 'aviation' ? 'aip' : id === 'aip' ? 'aviation' : id));
    if (!layer) throw new Error(`manifest does not contain 3D layer: ${id}`);
    return layer;
  });
  const maxFeatures = options.maxFeatures ?? 1500, maxDepth = options.maxDepth ?? 8;
  const defaultHeight = options.defaultHeight ?? 9;
  if (!Number.isFinite(defaultHeight) || defaultHeight <= 0) throw new Error('defaultHeight must be a positive number');
  if (!Number.isInteger(maxFeatures) || maxFeatures < 1 || !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 24) {
    throw new Error('maxFeatures must be positive and maxDepth must be an integer in 0..24');
  }
  const policies = new Map(selected.map(layer => [layer.id, resolveMeshPolicy(layer)]));
  const vectorLayers = contentEncoder ? [] : selected.filter(layer=>policies.get(layer.id).strategy !== 'extruded');
  const meshLayers = contentEncoder ? selected : selected.filter(layer=>policies.get(layer.id).strategy === 'extruded');
  const minZoom=options.minZoom??manifest.tiles?.minZoom??8,maxZoom=options.maxZoom??manifest.tiles?.maxZoom??16;
  if(!Number.isInteger(minZoom)||!Number.isInteger(maxZoom)||minZoom<0||maxZoom>24||minZoom>maxZoom)throw new Error('3D zoom range must be integers in 0..24');
  const meshEncoder=contentEncoder??encodeMeshContent;
  const outDir = resolve(options.out ?? join(packageDir, '3dtiles'));
  const outRelative = relative(packageDir, outDir);
  if (!outRelative || outRelative.startsWith(`..${sep}`) || outRelative === '..') throw new Error('3D output must be a subdirectory of the package');
  const staging = `${outDir}.tmp-${process.pid}-${Date.now()}`;
  let style = {};
  if (manifest.styles?.default) style = JSON.parse(await fs.readFile(join(packageDir, manifest.styles.default), 'utf8'));
  const db = openReadonlyGeoPackage(join(packageDir, manifest.data ?? 'data.gpkg'));
  const tilesets = {}, summary = {};
  let writtenTiles = 0, outputBytes = 0, skippedTiles = 0, leafCount = 0;
  let vectorWarnings;
  try {
    await fs.mkdir(staging, { recursive: true });
    // Validate all mapped zoom columns before either encoder starts writing.
    for (const layer of selected) {
      const metadata = readLayerMetadata(db, manifest, layer.id);
      const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(metadata.table)})`).all();
      for (const column of Object.values(layer.featureZoom ?? {})) {
        if (!columns.some(info => info.name === column && String(info.type).toUpperCase() === 'INTEGER')) {
          throw new Error(`featureZoom column ${column} must exist and declare INTEGER`);
        }
      }
    }
    if(vectorLayers.length) {
      const result=await exportVectorContext({packageDir,manifest,layers:vectorLayers,out:join(staging,'context'),style,minZoom,maxZoom,onProgress:options.onProgress});
      writtenTiles+=result.writtenTiles;leafCount+=result.writtenTiles;outputBytes+=result.outputBytes;skippedTiles+=result.skippedTiles;
      vectorWarnings=result.warnings;
      for(const [id,stats] of Object.entries(result.summary)) {
        tilesets[id]=`${outRelative.replaceAll('\\','/')}/context/tileset.json`;
        const metadata=readLayerMetadata(db,manifest,id);
        const count=db.prepare(`SELECT count(*) count FROM ${quoteIdentifier(metadata.rtree)}`).get().count;
        summary[id]={strategy:policies.get(id).strategy,sourceFeatures:count,...stats};
      }
    }
    for (const layer of meshLayers) {
      const policy = policies.get(layer.id);
      const metadata = readLayerMetadata(db, manifest, layer.id);
      const rtree = quoteIdentifier(metadata.rtree);
      const extent = db.prepare(`SELECT min(minx) west,min(miny) south,max(maxx) east,max(maxy) north,count(*) count FROM ${rtree}`).get();
      if (!extent.count) continue;
      const bounds = [extent.west, extent.south, extent.east, extent.north];
      const rootBounds = bounds.map((n, i) => n + (i < 2 ? -1e-7 : 1e-7));
      // Keep output paths portable and injective even for SQL-style public IDs.
      const layerDir = /^[a-zA-Z0-9_-]+$/.test(layer.id) && !layer.id.startsWith('_layer-') && layer.id !== 'context'
        ? layer.id : `_layer-${Buffer.from(layer.id).toString('hex')}`;
      await fs.mkdir(join(staging, layerDir, 'tiles'), { recursive: true });
      const sourceRule = getLayerRule(style, layer);
      let featureCount = 0, layerTiles = 0, layerDepth = 0, largestLeaf = 0;
      let minZoom = 24, maxZoom = 0;
      const warnings = {};
      options.onProgress?.({ phase: 'estimate', layerId: layer.id, featureCount: extent.count, leafCount: Math.ceil(extent.count / maxFeatures) });

      const source = createOwnedFeatureSource(db, metadata, ({geometry, properties}) => {
        const anchor = labelAnchorForGeometry(geometry);
        const rule = mergeFeatureRule(sourceRule, { get: key => properties[key] });
        const featureMin = layer.featureZoom?.minColumn ? properties[layer.featureZoom.minColumn] : null;
        const featureMax = layer.featureZoom?.maxColumn ? properties[layer.featureZoom.maxColumn] : null;
        properties.mapzero_layer = layer.id;
        properties.mapzero_geometry = geometry.type;
        properties.mapzero_minzoom = Math.max(layer.minZoom ?? 0, rule.minZoom ?? 0, featureMin ?? 0);
        properties.mapzero_maxzoom = Math.min(layer.maxZoom ?? 24, rule.maxZoom ?? 24, featureMax ?? 24);
        minZoom = Math.min(minZoom, properties.mapzero_minzoom);
        maxZoom = Math.max(maxZoom, properties.mapzero_maxzoom);
        if (anchor && ['name','ref','iata','icao','operator','official_name','short_name'].some(key => properties[key])) {
          properties.mapzero_label_lon = anchor[0]; properties.mapzero_label_lat = anchor[1];
        }
        return {geometry, properties};
      });
      async function emit(features) {
        leafCount++; largestLeaf = Math.max(largestLeaf, features.length);
        const contents = await meshEncoder(features, {policy, defaultHeight});
        if (!contents.length) skippedTiles++;
        const nodes = [];
        for (const content of contents) {
          for (const [key,count] of Object.entries(content.warnings ?? {})) if (count) warnings[key] = (warnings[key] ?? 0) + count;
          const name = `tile-${layerTiles++}.${content.extension}`;
          await fs.writeFile(join(staging, layerDir, 'tiles', name), content.bytes);
          writtenTiles++; outputBytes += content.bytes.length; featureCount += content.count;
          const node = buildContentNode({bbox:content.bbox, maxHeight:content.maxHeight, uri:`tiles/${name}`});
          // Conservative lower altitude includes chord sag and float32 rounding.
          const span = Math.max(content.bbox[2]-content.bbox[0],content.bbox[3]-content.bbox[1])*111320;
          node.boundingVolume.region[4] = Math.min(0, content.minHeight ?? 0) - Math.max(2,span*span/(8*6378137));
          node.boundingVolume.region[5] += 2;
          node.extras = { featureCount:content.count };
          nodes.push(node);
        }
        options.onProgress?.({phase:'leaf',layerId:layer.id,leafIndex:leafCount,leafCount,featureCount:features.length,writtenTiles,skippedTiles});
        return nodes;
      }
      const root = await partitionFeatures({source, bounds:rootBounds, maxFeatures, maxDepth, emit,
        onDepth:depth => { layerDepth = Math.max(depth, layerDepth); }});
      if (!root) continue;
      const tileset = buildTileset({bbox:rootBounds,maxHeight:1,children:[]});
      tileset.root = root;
      tileset.geometricError = Math.max(1, ...rootBounds.slice(2).map((n,i) => (n-rootBounds[i])*111320));
      meshEncoder.declareTileset?.(tileset);
      const json = JSON.stringify(tileset);
      await fs.writeFile(join(staging,layerDir,'tileset.json'),json);
      outputBytes += Buffer.byteLength(json);
      tilesets[layer.id] = `${outRelative.replaceAll('\\','/')}/${layerDir}/tileset.json`;
      summary[layer.id] = {strategy:policy.strategy,sourceFeatures:extent.count,featureCount,tiles:layerTiles,maxDepth:layerDepth,maxLeafFeatures:largestLeaf,minZoom,maxZoom,...(Object.keys(warnings).length ? {warnings} : {})};
    }
    if (!Object.keys(tilesets).length) throw new Error('no 3D Tiles were generated');
    await fs.rm(outDir,{recursive:true,force:true});
    await fs.rename(staging,outDir);
    manifest.tiles3d = {format:'3dtiles',url:Object.values(tilesets)[0],layers:Object.keys(tilesets),tilesets,
      metadata:vectorLayers.length?'structural-and-batch':meshEncoder.metadata ?? 'batch-table', representations:summary,
      ...(vectorWarnings&&Object.keys(vectorWarnings).length?{warnings:vectorWarnings}:{})};
    delete manifest.cesium;
    await fs.writeFile(manifestPath,`${JSON.stringify(manifest,null,2)}\n`);
  } finally {
    db.close(); await fs.rm(staging,{recursive:true,force:true});
  }
  options.onProgress?.({phase:'done',writtenTiles,skippedTiles,outputBytes});
  return {outDir,tilesetPath:join(packageDir,Object.values(tilesets)[0]),leafCount,writtenTiles,skippedTiles,outputBytes,layers:summary};
}
