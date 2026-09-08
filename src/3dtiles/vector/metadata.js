/** EXT_structural_metadata property table. Numeric values stay FLOAT64,
 * booleans are packed bits, strings UTF-8. Complex properties use JSON strings.
 * A JSON companion preserves null/missing/mixed values without sentinel loss.
 * Property names are schema identifiers; original names are retained as name.
 */
export function encodeMetadata(rows, addView) {
  const definitions = Object.create(null), properties = Object.create(null);
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  for (const key of keys) {
    const values = rows.map(row => row[key]);
    const present = values.filter(value => value !== null && value !== undefined);
    if (!present.length) continue;
    const types = new Set(present.map(value => typeof value));
    const type = types.size === 1 ? [...types][0] : 'string';
    // Metadata schema property IDs must match [a-zA-Z_][a-zA-Z0-9_]*.
    const id = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && !key.startsWith('_property_')
      ? key : `_property_${Buffer.from(key).toString('hex')}`;
    if (type === 'number') {
      if (present.some(v => !Number.isFinite(v))) throw new Error(`Non-finite metadata property: ${key}`);
      const missing = values.some(v => v == null);
      const occupied = new Set(present);
      let noData = Number.MAX_VALUE;
      while (occupied.has(noData)) noData /= 2;
      definitions[id] = { name: key, type: 'SCALAR', componentType: 'FLOAT64' };
      if (missing) definitions[id].noData = noData;
      properties[id] = { values: addView(new Float64Array(values.map(v => v ?? noData)), 8) };
    } else if (type === 'boolean') {
      const bits = new Uint8Array(Math.ceil(rows.length / 8));
      values.forEach((v, i) => { if (v === true) bits[i >> 3] |= 1 << (i & 7); });
      definitions[id] = { name: key, type: 'BOOLEAN' };
      properties[id] = { values: addView(bits) };
    } else {
      const strings = values.map(v => v == null ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v));
      let noData = '';
      const occupied = new Set(strings);
      while (occupied.has(noData)) noData += '\u0000';
      const parts = strings.map(v => Buffer.from(v ?? noData));
      const offsets = new Uint32Array(rows.length + 1);
      parts.forEach((part, i) => { offsets[i + 1] = offsets[i] + part.length; });
      definitions[id] = { name: key, type: 'STRING' };
      if (strings.some(v => v === undefined)) definitions[id].noData = noData;
      properties[id] = { values: addView(Buffer.concat(parts)), stringOffsets: addView(offsets), stringOffsetType: 'UINT32' };
    }
  }
  return { schema: { id: 'mapzero_vector', classes: { feature: { properties: definitions } } },
    propertyTables: [{ class: 'feature', count: rows.length, properties }] };
}
