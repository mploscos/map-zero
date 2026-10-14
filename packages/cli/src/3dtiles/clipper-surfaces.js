import earcut from 'earcut';
import {
  EndType,
  JoinType,
  NativeClipperLibRequestedFormat,
  loadNativeClipperLibInstanceAsync
} from 'js-angusj-clipper';

import { wgs84SurfaceNormal, wgs84ToEcef } from './extrude.js';
import { localizeEcefPositions } from './precision.js';

/**
 * Builds flat elevated cartographic surfaces from linework by offsetting lines
 * with Clipper, dissolving joins/caps, and triangulating the resulting polygons.
 * This path is used for roads, railways, boundaries, and aviation linework where
 * hand-built ribbons produced visible join artifacts.
 */

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

/**
 * Lazily load the Clipper WASM/ASM implementation once per process.
 *
 * @returns {Promise<any>}
 */
function getClipper() {
  clipperPromise ??= loadNativeClipperLibInstanceAsync(
    NativeClipperLibRequestedFormat.WasmWithAsmJsFallback
  );
  return clipperPromise;
}

/**
 * Flatten a Clipper PolyTree into polygon rings, preserving first-level holes.
 *
 * @param {any} polyTree
 * @returns {Array<Array<Array<{ x: number, y: number }>>>}
 */
function collectPolyTreePolygons(polyTree) {
  const polygons = [];
  for (const child of polyTree.childs) {
    collectNode(child, polygons);
  }
  return polygons;
}

/**
 * Recursively collect closed non-hole nodes and their hole contours.
 *
 * @param {any} node
 * @param {Array<Array<Array<{ x: number, y: number }>>>} polygons
 */
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

/**
 * Convert integer Clipper polygon rings back into localized ECEF mesh data.
 *
 * @param {Array<Array<Array<{ x: number, y: number }>>>} polygons
 * @param {{ origin: [number, number], metersPerLon: number, metersPerLat: number }} projection
 * @param {number} scale
 * @param {number} height
 * @returns {import('./extrude.js').ExtrudedMesh | null}
 */
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
  const localized = localizeEcefPositions(positions);
  const normalArray = new Float32Array(normals);
  const indexArray = localized.positions.length / 3 > 65535
    ? new Uint32Array(indices)
    : new Uint16Array(indices);
  return {
    positions: localized.positions,
    normals: normalArray,
    indices: indexArray,
    min: localized.min,
    max: localized.max,
    rtcCenter: localized.rtcCenter,
    bbox: mergeBboxes(bboxes),
    maxHeight: height,
    featureCount
  };
}

/**
 * Convert a Clipper path to local meter coordinates and remove duplicate close
 * points before triangulation.
 *
 * @param {Array<{ x: number, y: number }>} path
 * @param {number} scale
 * @returns {Array<[number, number]>}
 */
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

/**
 * Normalize a lon/lat line to finite coordinate pairs.
 *
 * @param {Array<[number, number]>} line
 * @returns {Array<[number, number]>}
 */
function cleanLine(line) {
  return line
    .map((point) => [Number(point?.[0]), Number(point?.[1])])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

/**
 * Drop adjacent projected points that are closer than minDistance meters.
 *
 * @param {Array<[number, number]>} points
 * @param {number} minDistance
 * @returns {Array<[number, number]>}
 */
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

/**
 * Create a local lon/lat <-> meter projection centered on the data extent.
 *
 * @param {Array<[number, number]>} points
 * @returns {{ origin: [number, number], metersPerLon: number, metersPerLat: number }}
 */
function createLocalProjection(points) {
  const origin = polygonCentroid(points);
  const meanLat = origin[1] * Math.PI / 180;
  return {
    origin,
    metersPerLon: Math.max(1, 111320 * Math.cos(meanLat)),
    metersPerLat: 110540
  };
}

/**
 * Project one lon/lat point into local meters.
 *
 * @param {[number, number]} point
 * @param {{ origin: [number, number], metersPerLon: number, metersPerLat: number }} projection
 * @returns {[number, number]}
 */
function projectPoint(point, projection) {
  return [
    (point[0] - projection.origin[0]) * projection.metersPerLon,
    (point[1] - projection.origin[1]) * projection.metersPerLat
  ];
}

/**
 * Convert local meters back to lon/lat.
 *
 * @param {[number, number]} point
 * @param {{ origin: [number, number], metersPerLon: number, metersPerLat: number }} projection
 * @returns {[number, number]}
 */
function unprojectPoint(point, projection) {
  return [
    projection.origin[0] + point[0] / projection.metersPerLon,
    projection.origin[1] + point[1] / projection.metersPerLat
  ];
}

/**
 * Convert projected meter coordinates to Clipper integer coordinates.
 *
 * @param {[number, number]} point
 * @param {number} scale
 * @returns {{ x: number, y: number }}
 */
function toIntPoint(point, scale) {
  return {
    x: Math.round(point[0] * scale),
    y: Math.round(point[1] * scale)
  };
}

/**
 * Return a simple arithmetic lon/lat centroid for small local geometries.
 *
 * @param {Array<[number, number]>} points
 * @returns {[number, number]}
 */
function polygonCentroid(points) {
  let lon = 0;
  let lat = 0;
  for (const point of points) {
    lon += point[0];
    lat += point[1];
  }
  return [lon / points.length, lat / points.length];
}

/**
 * Compute a lon/lat bbox for a set of line or polygon vertices.
 *
 * @param {Array<[number, number]>} points
 * @returns {[number, number, number, number]}
 */
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

/**
 * Merge multiple lon/lat bounding boxes.
 *
 * @param {Array<[number, number, number, number]>} bboxes
 * @returns {[number, number, number, number]}
 */
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

/**
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {boolean}
 */
function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

/**
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number}
 */
function distance2(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
