import { NextResponse } from 'next/server';
import { buildKDTree, rangeSearch as kdRangeSearch } from '../../../KdTree';
import { lonLatToMercator } from '../../../geo';

function nowNs() {
  return process.hrtime.bigint();
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371008.8;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const dφ = toRad(lat2 - lat1);
  const dλ = toRad(lon2 - lon1);
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function fetchRestaurants(lat: number, lon: number, aroundMeters: number) {
  const q = `
    [out:json][timeout:25];
    (
      node["amenity"="restaurant"](around:${aroundMeters},${lat},${lon});
    );
    out body;
  `;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json' },
    body: 'data=' + encodeURIComponent(q),
  });

  // Overpass may return HTML/XML error pages (rate limit, overloaded, etc.).
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Overpass error: status=${res.status} ${res.statusText} - ${text.slice(0, 500)}`);
  }
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(`Overpass returned unexpected content-type=${contentType}: ${text.slice(0, 500)}`);
  }

  let data: any;
  try {
    data = await res.json();
  } catch (err) {
    const text = await res.text();
    throw new Error(`Failed to parse Overpass JSON response: ${String(err)} - ${text.slice(0, 500)}`);
  }
  const elements = data.elements || [];
  const nodes = elements
    .filter((e: any) => e.type === 'node' && e.lat !== undefined && e.lon !== undefined)
    .map((e: any) => ({ id: e.id, lat: e.lat, lon: e.lon }));
  return nodes;
}

function stats(nums: number[]) {
  const n = nums.length;
  const mean = nums.reduce((a, b) => a + b, 0) / n;
  const sq = nums.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  const std = Math.sqrt(sq / n);
  return { mean, std, n };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const centerLat = Number(body.centerLat ?? 48.137);
    const centerLon = Number(body.centerLon ?? 11.575);
      const radiusMeters = Number(body.radiusMeters ?? 1500);
      const fetchRadius = Number(body.fetchRadiusMeters ?? 5000);
      const iterations = Number(body.iterations ?? 5);

    // fetch real restaurants from Overpass using same radius as the app
      const restaurants = await fetchRestaurants(centerLat, centerLon, fetchRadius);
    const latlons: [number, number][] = restaurants.map((r: any) => [r.lat, r.lon]);
    const projected = latlons.map(([lat, lon]) => lonLatToMercator([lon, lat]));

    // Single precise measurement: build KD tree, run KD rangeSearch, run linear geodesic search
    const t0 = nowNs();
    const root = buildKDTree(projected as any);
    const t1 = nowNs();
    const buildMs = Number(t1 - t0) / 1e6;

    const centerMerc = lonLatToMercator([centerLon, centerLat]);
    const phiRad = (centerLat * Math.PI) / 180;
    const rProj = radiusMeters / Math.cos(phiRad);

    const t2 = nowNs();
    // exact KD-tree search using exported rangeSearch
    const kdRes = kdRangeSearch(root as any, centerMerc as any, rProj as any) || [];
    const t3 = nowNs();
    const kdMs = Number(t3 - t2) / 1e6;

    // compute KD visited count using same traversal logic as rangeSearchTrace
    let kdVisited = 0;
    (function dfs(node: any, depth: number) {
      if (!node) return;
      kdVisited++;
      const k = centerMerc.length;
      const axis = depth % k;
      const diff = centerMerc[axis] - node.point[axis];
      const main = diff < 0 ? node.left : node.right;
      const other = diff < 0 ? node.right : node.left;
      dfs(main, depth + 1);
      if (Math.abs(diff) <= rProj) dfs(other, depth + 1);
    })(root, 0);

    const t4 = nowNs();
    const linIdx: number[] = [];
    for (let i = 0; i < latlons.length; i++) {
      const [plat, plon] = latlons[i];
      if (haversineMeters(centerLat, centerLon, plat, plon) <= radiusMeters) linIdx.push(i);
    }
    const t5 = nowNs();
    const linMs = Number(t5 - t4) / 1e6;

    // Map results to IDs for easy comparison
    const kdInsideIds = new Set(kdRes.map((n: any) => {
      return restaurants.find((r: any) => {
        const p = lonLatToMercator([r.lon, r.lat]);
        return Math.abs(p[0] - n.point[0]) < 1e-6 && Math.abs(p[1] - n.point[1]) < 1e-6;
      })?.id;
    }).filter(Boolean as any));

    const linInsideIds = new Set(linIdx.map((i) => restaurants[i].id));

    const inside = Array.from(linInsideIds);
    const outside = restaurants.filter((r: any) => !linInsideIds.has(r.id)).map((r: any) => r.id);

    return NextResponse.json({
      count: restaurants.length,
      buildMs,
      kdMs,
      linMs,
      inside,
      outside,
      kdInsideCount: kdInsideIds.size,
      linInsideCount: linInsideIds.size,
      kdVisited,
      linVisited: restaurants.length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
