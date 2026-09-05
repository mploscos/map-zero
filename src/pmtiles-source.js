import { open } from 'node:fs/promises';

/** PMTiles range source backed by a local readonly file; shared by server/tests. */
export class LocalPmtilesSource {
  constructor(path) {
    this.path = path;
    this.handle = open(path, 'r');
  }
  getKey() { return this.path; }
  async getBytes(offset, length) {
    const handle = await this.handle;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead) };
  }
  async close() { await (await this.handle).close(); }
}
