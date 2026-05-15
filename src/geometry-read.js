import wkx from 'wkx';

const ENVELOPE_LENGTHS = [0, 32, 48, 48, 64];

/**
 * Decode a GeoPackage binary geometry into GeoJSON geometry.
 *
 * GeoPackage geometry blobs start with a binary header. The WKB payload begins
 * after the fixed 8-byte header plus the optional envelope.
 *
 * @param {Buffer | Uint8Array | null} value
 * @returns {Record<string, unknown> | null}
 */
export function decodeGeoPackageGeometry(value) {
  if (!value) {
    return null;
  }

  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);

  if (buffer.length < 8) {
    throw new Error('invalid GeoPackage geometry: header is too short');
  }

  if (buffer.readUInt8(0) !== 0x47 || buffer.readUInt8(1) !== 0x50) {
    throw new Error('invalid GeoPackage geometry: missing GP magic bytes');
  }

  const flags = buffer.readUInt8(3);
  const isEmpty = Boolean(flags & 0b00010000);

  if (isEmpty) {
    return null;
  }

  const envelopeCode = (flags >> 1) & 0b00000111;
  const envelopeLength = ENVELOPE_LENGTHS[envelopeCode];

  if (envelopeLength === undefined) {
    throw new Error(`invalid GeoPackage geometry: unsupported envelope code ${envelopeCode}`);
  }

  const wkbOffset = 8 + envelopeLength;

  if (buffer.length <= wkbOffset) {
    throw new Error('invalid GeoPackage geometry: missing WKB payload');
  }

  return wkx.Geometry.parse(buffer.subarray(wkbOffset)).toGeoJSON();
}
