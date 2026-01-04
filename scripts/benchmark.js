#!/usr/bin/env node
// Lightweight benchmark for linear vs KD-tree range search timings.
// Usage: node scripts/benchmark.js [N] [iterations] [lat] [lon] [radiusMeters]
const { argv } = require('process');

function nowNs() {
  return process.hrtime.bigint();
}

// from geo.ts
const R = 6378137;
function lonLatToMercator([lon, lat]) {
  const λ = (lon * Math.PI) / 180;
  const φ = (lat * Math.PI) / 180;
  const x = R * λ;
  const y = R * Math.log(Math.tan(Math.PI / 4 + φ / 2));
  return [x, y];
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R_ = 6371008.8;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const dφ = toRad(lat2 - lat1);
  const dλ = toRad(lon2 - lon1);
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R_ * c;
}

// KD utilities copied/adapted from repo
class KDNode {
  constructor(point, axis) {
    this.point = point;
    this.axis = axis;
    this.left = null;
    this.right = null;
  }
}

function buildKDTree(points, depth = 0) {
  if (!points || points.length === 0) return null;
  const k = points[0].length;
  const axis = depth % k;
  const sorted = [...points].sort((a, b) => a[axis] - b[axis]);
  const mid = Math.floor(sorted.length / 2);
  const node = new KDNode(sorted[mid], axis);
  node.left = buildKDTree(sorted.slice(0, mid), depth + 1);
  node.right = buildKDTree(sorted.slice(mid + 1), depth + 1);
  return node;
}

function distanceSquared(p1, p2) {
  let s = 0;
  for (let i = 0; i < p1.length; i++) {
    const d = p1[i] - p2[i];
    s += d * d;
  }
  return s;
}

function rangeSearch(root, target, radiusMeters, depth = 0, results = []) {
  if (!root) return results;
  const k = target.length;
  const axis = depth % k;
  const r2 = radiusMeters * radiusMeters;
  if (distanceSquared(target, root.point) <= r2) results.push(root);
  const diff = target[axis] - root.point[axis];
  if (diff < 0) rangeSearch(root.left, target, radiusMeters, depth + 1, results);
  else rangeSearch(root.right, target, radiusMeters, depth + 1, results);
  if (Math.abs(diff) <= radiusMeters) {
    if (diff < 0) rangeSearch(root.right, target, radiusMeters, depth + 1, results);
    else rangeSearch(root.left, target, radiusMeters, depth + 1, results);
  }
  return results;
}

function linearSearchGeo(latlons, centerLatLon, radiusMeters) {
  const resIdx = [];
  for (let i = 0; i < latlons.length; i++) {
    const [plat, plon] = latlons[i];
    if (haversineMeters(centerLatLon[0], centerLatLon[1], plat, plon) <= radiusMeters) resIdx.push(i);
  }
  return resIdx;
}

function randInCircle(lat, lon, meters) {
  // approximate: random angle, random distance sqrt-uniform
  const r = Math.sqrt(Math.random()) * meters;
  const θ = Math.random() * 2 * Math.PI;
  // offset in degrees (approx)
  const dLat = (r * Math.cos(θ)) / 111320; // meters per deg lat
  const dLon = (r * Math.sin(θ)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lon + dLon];
}

function stats(nsArray) {
  // nsArray elements are BigInt (nanoseconds)
  const n = Number(nsArray.length);
  const nums = nsArray.map((b) => Number(b));
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const sq = nums.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  const std = Math.sqrt(sq / n);
  return { mean, std, n };
}

async function main() {
  const N = parseInt(argv[2] || '5000', 10);
  const iterations = parseInt(argv[3] || '5', 10);
  const centerLat = parseFloat(argv[4] || '48.137');
  const centerLon = parseFloat(argv[5] || '11.575');
  const radiusMeters = parseFloat(argv[6] || '1500');

  console.log(`Benchmark: N=${N}, iterations=${iterations}, center=${centerLat},${centerLon}, radius=${radiusMeters}m`);

  // prepare dataset
  const latlons = new Array(N);
  for (let i = 0; i < N; i++) latlons[i] = randInCircle(centerLat, centerLon, radiusMeters * 3);
  const projected = latlons.map(([lat, lon]) => lonLatToMercator([lon, lat]));

  const buildTimes = [];
  const kdSearchTimes = [];
  const linSearchTimes = [];

  // Warmup
  for (let w = 0; w < 2; w++) {
    const root = buildKDTree(projected);
    rangeSearch(root, lonLatToMercator([centerLon, centerLat]), radiusMeters / Math.cos((centerLat * Math.PI) / 180));
    linearSearchGeo(latlons, [centerLat, centerLon], radiusMeters);
  }

  for (let it = 0; it < iterations; it++) {
    const t0 = nowNs();
    const root = buildKDTree(projected);
    const t1 = nowNs();
    buildTimes.push(t1 - t0);

    const centerMerc = lonLatToMercator([centerLon, centerLat]);
    const rProj = radiusMeters / Math.cos((centerLat * Math.PI) / 180);
    const t2 = nowNs();
    rangeSearch(root, centerMerc, rProj);
    const t3 = nowNs();
    kdSearchTimes.push(t3 - t2);

    const t4 = nowNs();
    linearSearchGeo(latlons, [centerLat, centerLon], radiusMeters);
    const t5 = nowNs();
    linSearchTimes.push(t5 - t4);

    // small pause to avoid starving event loop
    await new Promise((r) => setTimeout(r, 10));
  }

  const b = stats(buildTimes);
  const k = stats(kdSearchTimes);
  const l = stats(linSearchTimes);

  const nsToMs = (n) => (Number(n) / 1e6).toFixed(4);

  console.log('\nResults (mean ± stddev) in ms:');
  console.log(`KD build:  ${nsToMs(b.mean)} ms ± ${nsToMs(b.std)} ms  (n=${b.n})`);
  console.log(`KD search: ${nsToMs(k.mean)} ms ± ${nsToMs(k.std)} ms  (n=${k.n})`);
  console.log(`Linear:    ${nsToMs(l.mean)} ms ± ${nsToMs(l.std)} ms  (n=${l.n})`);
  console.log('\nRaw samples (ms):');
  console.log('build:', buildTimes.map((x) => nsToMs(x)).join(', '));
  console.log('kd:', kdSearchTimes.map((x) => nsToMs(x)).join(', '));
  console.log('lin:', linSearchTimes.map((x) => nsToMs(x)).join(', '));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
