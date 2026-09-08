import Feature from 'ol/Feature.js';
import MVT from 'ol/format/MVT.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import { createXYZ } from 'ol/tilegrid.js';
import { FileSource, FetchSource, PMTiles } from 'pmtiles';
import { resolveManifestLayers, isFeatureInZoomRange } from '../../core/src/manifest.js';

let sourceId = 0;

/** Shared MVT loader for the standard map-zero renderer and custom renderers.
 * Errors remain tile errors (and can be retried); missing entries are empty.
 * @param {MVT} format @param {PMTiles} archive
 * @param {{idProperty?: string, onFeatures?: Function}} [options]
 */
export function createPmtilesTileLoadFunction(format, archive, options = {}) {
  return (tile) => tile.setLoader((extent, resolution, projection) => {
    const [z, x, y] = tile.getTileCoord();
    archive.getZxy(z, x, y).then((result) => {
      const features = result ? format.readFeatures(result.data, { extent, featureProjection: projection }) : [];
      if (options.idProperty) {
        for (const feature of features) {
          const id = feature.get(options.idProperty);
          if (id != null) feature.setId(id);
        }
      }
      options.onFeatures?.(features, [z, x, y]);
      tile.setFeatures(features);
    }).catch(() => tile.setState(3));
  });
}

/** Open a vector archive using HTTP Range, File/Blob slices, or a PMTiles Source.
 * Does not load the whole archive. The caller owns its layers and style.
 * Metrics count underlying range reads, including header/directory/metadata.
 * @param {{input: string|Blob|import('pmtiles').Source, manifest?: object,
 *   idProperty?: string, onFeatures?: Function}} options
 */
export async function createPmtilesVectorSource(options) {
  const started = performance.now();
  const metrics = { metadataMs: null, firstTileMs: null, rangeRequests: 0, rangeBytes: 0, tilesLoaded: 0, tileErrors: 0 };
  let input = options.input;
  if (typeof input === 'string') input = new FetchSource(input);
  else if (typeof Blob !== 'undefined' && input instanceof Blob) {
    // FileSource already implements slice().arrayBuffer(); its filename key is
    // replaced so two different local files with the same name cannot collide.
    input = new FileSource(input);
    const key = `mapzero-file:${++sourceId}`;
    input.getKey = () => key;
  }
  if (!input?.getBytes || !input?.getKey) throw new Error('Expected a PMTiles URL, File/Blob or range Source');
  const transport = input;
  const archive = new PMTiles({
    getKey: () => transport.getKey(),
    async getBytes(...args) {
      metrics.rangeRequests++;
      const result = await transport.getBytes(...args);
      metrics.rangeBytes += result.data.byteLength;
      return result;
    }
  });
  const [header, metadata] = await Promise.all([archive.getHeader(), archive.getMetadata()]);
  if (header.tileType !== 1) throw new Error('Expected vector MVT PMTiles');
  metrics.metadataMs = performance.now() - started;
  const manifest = options.manifest ?? {
    layers: metadata['mapzero:layers'] ?? (metadata.vector_layers ?? []).map((layer) => ({
      id: layer.id, minZoom: layer.minzoom, maxZoom: layer.maxzoom
    }))
  };
  const layers = resolveManifestLayers(manifest);
  const format = new MVT({ featureClass: Feature });
  const source = new VectorTileSource({
    format, wrapX: false, transition: 0,
    // A 256px grid makes source z agree with the usual OpenLayers view z.
    tileGrid: createXYZ({ minZoom: header.minZoom, maxZoom: header.maxZoom, tileSize: 256 }),
    tileUrlFunction: (coord) => coord ? `pmtiles://${transport.getKey()}/${coord.join('/')}` : undefined,
    tileLoadFunction: createPmtilesTileLoadFunction(format, archive, {
      idProperty: options.idProperty ?? 'id',
      onFeatures(features, coord) {
        metrics.tilesLoaded++;
        if (features.length && metrics.firstTileMs === null) metrics.firstTileMs = performance.now() - started;
        options.onFeatures?.(features, coord);
      }
    })
  });
  source.on('tileloaderror', () => metrics.tileErrors++);
  return { source, archive, header, metadata, layers, metrics,
    destroy() { source.clear(); source.dispose(); }
  };
}

/** Apply inclusive descriptor and feature bounds at the ACTUAL view zoom.
 * Canvas vector tile style callbacks may receive a source/parent resolution.
 * Reevaluate on view resolution changes (e.g. layer.changed()).
 * @param {Function} style @param {{layers: object[], getZoom: () => number}} options
 */
export function withFeatureZoomVisibility(style, { layers, getZoom }) {
  const descriptors = new Map(layers.map((layer) => [layer.id, layer]));
  return (feature, resolution) => {
    const descriptor = descriptors.get(feature.get('layer'));
    if (descriptor && !isFeatureInZoomRange(descriptor, (key) => feature.get(key), getZoom())) return null;
    return style(feature, resolution);
  };
}
