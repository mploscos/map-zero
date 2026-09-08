import { batchTable } from './b3dm.js';
import { localizeEcefPositions } from './precision.js';
import { wgs84ToEcef } from './extrude.js';

/** Static point tiles: one batched point per feature, no runtime Entities. */
export function buildPointTile(features, height = 12) {
  const coordinates = features.map((feature) => feature.geometry.coordinates);
  const localized = localizeEcefPositions(coordinates.flatMap(([lon, lat]) => wgs84ToEcef(lon, lat, height)));
  const positions = Buffer.from(localized.positions.buffer);
  const batchIds = features.length > 65535 ? new Uint32Array(features.length) : new Uint16Array(features.length);
  for (let i = 0; i < batchIds.length; i++) batchIds[i] = i;
  const featureTable = {
    POINTS_LENGTH: features.length, BATCH_LENGTH: features.length, RTC_CENTER: localized.rtcCenter,
    POSITION: { byteOffset: 0 }, BATCH_ID: { byteOffset: positions.length, componentType: batchIds instanceof Uint32Array ? 'UNSIGNED_INT' : 'UNSIGNED_SHORT' },
    CONSTANT_RGBA: [255, 255, 255, 255]
  };
  const json = pad(Buffer.from(JSON.stringify(featureTable)), 28, 0x20);
  const binary = pad(Buffer.concat([positions, Buffer.from(batchIds.buffer)]), 28 + json.length, 0);
  const batch = pad(Buffer.from(JSON.stringify(batchTable(features.map((feature) => feature.properties)))), 28 + json.length + binary.length, 0x20);
  const header = Buffer.alloc(28);
  header.write('pnts'); header.writeUInt32LE(1, 4);
  header.writeUInt32LE(28 + json.length + binary.length + batch.length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(binary.length, 16); header.writeUInt32LE(batch.length, 20);
  return Buffer.concat([header, json, binary, batch]);
}
function pad(buffer, offset, fill) {
  return Buffer.concat([buffer, Buffer.alloc((8 - (offset + buffer.length) % 8) % 8, fill)]);
}
