import earcut from 'earcut';
import {
  EndType,
  JoinType,
  NativeClipperLibRequestedFormat,
  loadNativeClipperLibInstanceAsync
} from 'js-angusj-clipper';

import { wgs84SurfaceNormal, wgs84ToEcef } from './extrude.js';

const DEFAULT_SCALE = 100;
const DEFAULT_ARC_TOLERANCE_METERS = 0.25;
const DEFAULT_CLEAN_DISTANCE_METERS = 0.03;
let clipperPromise;

/**
 * Build a flat 3D mesh from linework using Clipper's open-path offsetter.
 *
 * This is intended to replace custom ribbon joins/caps for exported Cesium
 * cartography. It produces dissolved polygonal road surfaces that can be
 * triangulated and written to 3D Tiles.
 *
 * @param {Array<Array<[number, number]>>} lines
 * @param {{
 *   widthMeters: number,
 *   height?: number,
 *   scale?: number,
 *   arcToleranceMeters?: number,
 *   cleanDistanceMeters?: number,
 *   minSegmentMeters?: number,
 *   miterLimit?: number
 * }} options
 * @returns {Promise<{
 *   positions: Float32Array,
 *   normals: Float32Array,
 *   indices: Uint16Array,
 *   min: [number, number, number],
 *   max: [number, number, number],
 *   bbox: [number, number, number, number],
 *   maxHeight: number,
 *   featureCount: number
 * } | null>}
 */
export async function buildClipperLineSurfaceMesh(lines, options) {
  const cleanLines = lines.map(cleanLine).filter((line) => line.length >= 2);
  if (cleanLines.length === 0) return null;

  const clipper = await getClipper();
  const scale = positiveNumber(options.scale, DEFAULT_SCALE);
  const projection = createLocalProjection(cleanLines.flat());
  const openPaths = [];
  const closedPaths = [];
  const minSegmentMeters = positiveNumber(options.minSegmentMeters, 0.05);

  for (const line of cleanLines) {
    const local = removeRedundantLocalPoints(line.map((point) => projectPoint(point, projection)), minSegmentMeters);
    if (local.length < 2) continue;
    const closed = local.length > 2 && samePoint(local[0], local[local.length - 1]);
    const path = local.slice(0, closed ? -1 : undefined).map((point) => toIntPoint(point, scale));
    if (path.length < (closed ? 3 : 2)) continue;
    if (closed) closedPaths.push(path);
    else openPaths.push(path);
  }

  const offsetInputs = [];
  if (openPaths.length > 0) {
    offsetInputs.push({
      data: openPaths,
      joinType: JoinType.Round,
      endType: EndType.OpenRound
    });
  }
  if (closedPaths.length > 0) {
    offsetInputs.push({
      data: closedPaths,
      joinType: JoinType.Round,
      endType: EndType.ClosedLine
    });
  }
  if (offsetInputs.length === 0) return null;

  const offsetTree = clipper.offsetToPolyTree({
    delta: options.widthMeters * scale / 2,
    arcTolerance: positiveNumber(options.arcToleranceMeters, DEFAULT_ARC_TOLERANCE_METERS) * scale,
    miterLimit: positiveNumber(options.miterLimit, 2),
    offsetInputs
  });

  if (!offsetTree || offsetTree.total === 0) return null;

  const polygons = collectPolyTreePolygons(offsetTree);
  return buildSurfaceMeshFromClipperPolygons(polygons, projection, scale, options.height ?? 1);
}

function getClipper() {
  clipperPromise ??= loadNativeClipperLibInstanceAsync(
    NativeClipperLibRequestedFormat.WasmWithAsmJsFallback
  );
  return clipperPromise;
}

function collectPolyTreePolygons(polyTree) {
  const polygons = [];
  for (const child of polyTree.childs) {
    collectNode(child, polygons);
  }
  return polygons;
}

function collectNode(node, polygons) {
  if (node.isOpen) return;
  if (!node.isHole) {
    const holes = node.childs.filter((child) => child.isHole && !child.isOpen);
    polygons.push([node.contour, ...holes.map((child) => child.contour)]);
    for (const hole of holes) {
      for (const nested of hole.childs) {
        collectNode(nested, polygons);
      }
    }
  } else {
    for (const child of node.childs) {
      collectNode(child, polygons);
    }
  }
}

function buildSurfaceMeshFromClipperPolygons(polygons, projection, scale, height) {
  const positions = [];
  const normals = [];
  const indices = [];
  const bboxes = [];
  let featureCount = 0;

  for (const polygon of polygons) {
    const vertices = [];
    const holes = [];
    const localPoints = [];
    let cursor = 0;

    for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
      const ring = cleanPathRing(polygon[ringIndex], scale);
      if (ring.length < 3) continue;
      if (ringIndex > 0) holes.push(cursor);
      for (const point of ring) {
        vertices.push(point[0], point[1]);
        localPoints.push(point);
        cursor++;
      }
    }

    if (vertices.length < 6) continue;
    const triangles = earcut(vertices, holes, 2);
    if (triangles.length === 0) continue;

    const lonLatPoints = localPoints.map((point) => unprojectPoint(point, projection));
    const centroid = polygonCentroid(lonLatPoints);
    const normal = wgs84SurfaceNormal(centroid[0], centroid[1]);
    const ecef = lonLatPoints.map(([lon, lat]) => wgs84ToEcef(lon, lat, height));
    const vertexOffset = positions.length / 3;

    for (const point of ecef) {
      positions.push(...point);
      normals.push(...normal);
    }
    for (const index of triangles) {
      indices.push(vertexOffset + index);
    }
    bboxes.push(lineBbox(lonLatPoints));
    featureCount++;
  }

  if (positions.length === 0 || featureCount === 0) return null;
  const positionArray = new Float32Array(positions);
  const normalArray = new Float32Array(normals);
  const indexArray = positionArray.length / 3 > 65535
    ? new Uint32Array(indices)
    : new Uint16Array(indices);
  const bounds = minMaxVec3(positionArray);
  return {
    positions: positionArray,
    normals: normalArray,
    indices: indexArray,
    min: bounds.min,
    max: bounds.max,
    bbox: mergeBboxes(bboxes),
    maxHeight: height,
    featureCount
  };
}

function cleanPathRing(path, scale) {
  const ring = [];
  for (const point of path) {
    const local = [point.x / scale, point.y / scale];
    const last = ring[ring.length - 1];
    if (!last || !samePoint(last, local)) {
      ring.push(local);
    }
  }
  if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) {
    ring.pop();
  }
  return ring;
}

function cleanLine(line) {
  return line
    .map((point) => [Number(point?.[0]), Number(point?.[1])])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

function removeRedundantLocalPoints(points, minDistance) {
  const out = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || distance2(last, point) >= minDistance) {
      out.push(point);
    }
  }
  return out;
}

function createLocalProjection(points) {
  const origin = polygonCentroid(points);
  const meanLat = origin[1] * Math.PI / 180;
  return {
    origin,
    metersPerLon: Math.max(1, 111320 * Math.cos(meanLat)),
    metersPerLat: 110540
  };
}

function projectPoint(point, projection) {
  return [
    (point[0] - projection.origin[0]) * projection.metersPerLon,
    (point[1] - projection.origin[1]) * projection.metersPerLat
  ];
}

function unprojectPoint(point, projection) {
  return [
    projection.origin[0] + point[0] / projection.metersPerLon,
    projection.origin[1] + point[1] / projection.metersPerLat
  ];
}

function toIntPoint(point, scale) {
  return {
    x: Math.round(point[0] * scale),
    y: Math.round(point[1] * scale)
  };
}

function polygonCentroid(points) {
  let lon = 0;
  let lat = 0;
  for (const point of points) {
    lon += point[0];
    lat += point[1];
  }
  return [lon / points.length, lat / points.length];
}

function lineBbox(points) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

function mergeBboxes(bboxes) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const bbox of bboxes) {
    minLon = Math.min(minLon, bbox[0]);
    minLat = Math.min(minLat, bbox[1]);
    maxLon = Math.max(maxLon, bbox[2]);
    maxLat = Math.max(maxLat, bbox[3]);
  }
  return [minLon, minLat, maxLon, maxLat];
}

function minMaxVec3(positions) {
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

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function distance2(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
