/**
 * Convert absolute ECEF positions to local tile coordinates before storing them
 * as Float32. Absolute ECEF values are around millions of meters, where Float32
 * precision is too coarse for flat terrain meshes.
 *
 * @param {number[]} positions
 * @returns {{ positions: Float32Array, min: [number, number, number], max: [number, number, number], rtcCenter: [number, number, number] }}
 */
export function localizeEcefPositions(positions) {
  const absoluteBounds = minMaxVec3(positions);
  const rtcCenter = [
    (absoluteBounds.min[0] + absoluteBounds.max[0]) / 2,
    (absoluteBounds.min[1] + absoluteBounds.max[1]) / 2,
    (absoluteBounds.min[2] + absoluteBounds.max[2]) / 2
  ];
  const local = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    local[i] = positions[i] - rtcCenter[0];
    local[i + 1] = positions[i + 1] - rtcCenter[1];
    local[i + 2] = positions[i + 2] - rtcCenter[2];
  }
  const localBounds = minMaxVec3(local);
  return {
    positions: local,
    min: localBounds.min,
    max: localBounds.max,
    rtcCenter
  };
}

/**
 * @param {ArrayLike<number>} positions
 * @returns {{ min: [number, number, number], max: [number, number, number] }}
 */
export function minMaxVec3(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    min[0] = Math.min(min[0], positions[i]);
    min[1] = Math.min(min[1], positions[i + 1]);
    min[2] = Math.min(min[2], positions[i + 2]);
    max[0] = Math.max(max[0], positions[i]);
    max[1] = Math.max(max[1], positions[i + 1]);
    max[2] = Math.max(max[2], positions[i + 2]);
  }
  return { min, max };
}
