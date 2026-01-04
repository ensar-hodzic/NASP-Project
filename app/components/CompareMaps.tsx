"use client";

import { useEffect, useMemo, useState } from "react";
import Autocomplete, { AutocompleteRenderInputParams } from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMap,
  Circle,
  CircleMarker,
} from "react-leaflet";
import L from "leaflet";

import { lonLatToMercator } from "../../geo";
import { buildKDTree } from "../../KdTree";


const defaultIcon = L.icon({  
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});
L.Marker.prototype.options.icon = defaultIcon;

type OverpassNode = { id: number; lat: number; lon: number; tags?: Record<string, string> };
type SearchResult = { display_name: string; lat: string; lon: string };

function nowMs() {
  if (typeof globalThis !== "undefined") {
    return (globalThis).performance.now();
  }
  return Date.now();
}

function distanceSq(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
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

type KDNode = { point: number[]; axis: number; left: KDNode | null; right: KDNode | null };
type Step = { id: number; point: number[]; axis: number; diff: number; within: boolean; branched: boolean };

function linearRangeSearchTraceGeo(
  projectedPoints: number[][],
  latLonPoints: [number, number][],
  centerLatLon: [number, number],
  radiusMeters: number
) {
  const steps: Step[] = [];
  const resultsIdx: number[] = [];
  const t0 = nowMs();
  for (let i = 0; i < projectedPoints.length; i++) {
    const [plat, plon] = latLonPoints[i];
    const within = haversineMeters(centerLatLon[0], centerLatLon[1], plat, plon) <= radiusMeters;
    steps.push({ id: i + 1, point: projectedPoints[i], axis: -1, diff: 0, within, branched: false });
    if (within) resultsIdx.push(i);
  }
  const t1 = nowMs();
  return { steps, resultsIdx, visited: steps.length, searchMs: t1 - t0 };
}

function rangeSearchTrace(root: KDNode | null, target: number[], projectedRadius: number) {
  const steps: Step[] = [];
  const results: KDNode[] = [];
  const r2 = projectedRadius * projectedRadius;
  let visitId = 0;
  function dfs(node: KDNode | null, depth: number) {
    if (!node) return;
    const k = target.length;
    const axis = depth % k;
    const diff = target[axis] - node.point[axis];
    const within = distanceSq(target, node.point) <= r2;
    const id = ++visitId;
    const idx = steps.length;
    steps.push({ id, point: node.point, axis, diff, within, branched: false });
    if (within) results.push(node);
    const main = diff < 0 ? node.left : node.right;
    const other = diff < 0 ? node.right : node.left;
    dfs(main, depth + 1);
    let branched = false;
    if (Math.abs(diff) <= projectedRadius) {
      branched = true;
      dfs(other, depth + 1);
    }
    steps[idx].branched = branched;
  }
  const t0 = nowMs();
  dfs(root, 0);
  const t1 = nowMs();
  return { steps, results, visited: steps.length, searchMs: t1 - t0 };
}

function FlyToPosition({ position }: { position: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (position) map.flyTo(position, 14, { duration: 1.0 });
  }, [position, map]);
  return null;
}

export default function CompareMaps() {
  const [markerPos, setMarkerPos] = useState<[number, number] | null>([48.137, 11.575]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [restaurants, setRestaurants] = useState<OverpassNode[]>([]);
  const [fetchRadiusMeters] = useState<number>(2000);

  const [radiusMeters, setRadiusMeters] = useState<number>(1500);
  const [speedMs, setSpeedMs] = useState(80);

  const [linSearchInfo, setLinSearchInfo] = useState<{ steps: Step[]; resultsIdx: number[]; visited: number; searchMs: number }>(
    { steps: [], resultsIdx: [], visited: 0, searchMs: 0 }
  );
  const [linIsPlaying, setLinIsPlaying] = useState(false);
  const [linStepIdx, setLinStepIdx] = useState(0);

  const [kdSearchInfo, setKdSearchInfo] = useState<{ steps: Step[]; results: KDNode[]; visited: number; searchMs: number }>(
    { steps: [], results: [], visited: 0, searchMs: 0 }
  );
  const [kdBuildMs, setKdBuildMs] = useState(0);
  const [kdIsPlaying, setKdIsPlaying] = useState(false);
  const [kdStepIdx, setKdStepIdx] = useState(0);

  const [linAnimStartTime, setLinAnimStartTime] = useState<number | null>(null);
  const [linAnimDurationMs, setLinAnimDurationMs] = useState<number | null>(null);
  const [kdAnimStartTime, setKdAnimStartTime] = useState<number | null>(null);
  const [kdAnimDurationMs, setKdAnimDurationMs] = useState<number | null>(null);

  const [benchRunning, setBenchRunning] = useState(false);
  const [benchResult, setBenchResult] = useState<any | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);

  const projected = useMemo(() => restaurants.map((r) => lonLatToMercator([r.lon, r.lat])), [restaurants]);
  const latlons = useMemo(() => restaurants.map((r) => [r.lat, r.lon] as [number, number]), [restaurants]);

  useEffect(() => {
    if (!linIsPlaying) {
      if (linAnimStartTime !== null && linStepIdx >= linSearchInfo.steps.length - 1) {
        setLinAnimDurationMs(nowMs() - linAnimStartTime);
      }
      return;
    }
    if (linSearchInfo.steps.length === 0) return;

    if (linStepIdx === 0 && linAnimStartTime === null) {
      setLinAnimStartTime(nowMs());
      setLinAnimDurationMs(null);
    }

    const id = setTimeout(() => {
      setLinStepIdx((i) => {
        const nextIdx = i + 1;
        if (nextIdx >= linSearchInfo.steps.length) {
          setLinIsPlaying(false);
          return linSearchInfo.steps.length - 1;
        }
        return nextIdx;
      });
    }, speedMs);
    return () => clearTimeout(id);
  }, [linIsPlaying, linStepIdx, linSearchInfo.steps.length, speedMs, linAnimStartTime]);

  useEffect(() => {
    if (!kdIsPlaying) {
      if (kdAnimStartTime !== null && kdStepIdx >= kdSearchInfo.steps.length - 1) {
        setKdAnimDurationMs(nowMs() - kdAnimStartTime);
      }
      return;
    }
    if (kdSearchInfo.steps.length === 0) return;

    if (kdStepIdx === 0 && kdAnimStartTime === null) {
      setKdAnimStartTime(nowMs());
      setKdAnimDurationMs(null);
    }

    const id = setTimeout(() => {
      setKdStepIdx((i) => {
        const nextIdx = i + 1;
        if (nextIdx >= kdSearchInfo.steps.length) {
          setKdIsPlaying(false);
          return kdSearchInfo.steps.length - 1;
        }
        return nextIdx;
      });
    }, speedMs);
    return () => clearTimeout(id);
  }, [kdIsPlaying, kdStepIdx, kdSearchInfo.steps.length, speedMs, kdAnimStartTime]);

  useEffect(() => {
    setLinIsPlaying(false);
    setKdIsPlaying(false);
    setLinStepIdx(0);
    setKdStepIdx(0);
    setLinAnimStartTime(null);
    setLinAnimDurationMs(null);
    setKdAnimStartTime(null);
    setKdAnimDurationMs(null);
    setLinSearchInfo({ steps: [], resultsIdx: [], visited: 0, searchMs: 0 });
    setKdSearchInfo({ steps: [], results: [], visited: 0, searchMs: 0 });
  }, [restaurants, markerPos, radiusMeters]);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;
    setIsLoading(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1&limit=5`
      );
      const data: SearchResult[] = await res.json();
      setResults(data);
      if (data.length > 0) {
        const first = data[0];
        const pos: [number, number] = [parseFloat(first.lat), parseFloat(first.lon)];
        setMarkerPos(pos);
        await fetchRestaurants(pos, fetchRadiusMeters);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1&limit=5`
      );
      const data: SearchResult[] = await res.json();
      setResults(data);

    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  const fetchRestaurants = async (center: [number, number], aroundMeters: number) => {
    const [lat, lon] = center;
    const q = `
      [out:json][timeout:25];
      (
        node["amenity"="restaurant"](around:${aroundMeters},${lat},${lon});
      );
      out body;
    `;
    try {
      const res = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Accept: "application/json" },
        body: "data=" + encodeURIComponent(q),
      });
      const data = await res.json();
      type OverpassElement = { type?: string; id?: number; lat?: number; lon?: number; tags?: Record<string, string> };
      const elements = (data.elements || []) as OverpassElement[];
      const nodes: OverpassNode[] = elements
        .filter((e) => e.type === "node" && e.id !== undefined && e.lat !== undefined && e.lon !== undefined)
        .map((e) => ({ id: e.id as number, lat: e.lat as number, lon: e.lon as number, tags: e.tags || {} }));
      setRestaurants(nodes);
    } catch (e) {
      console.error("Overpass fetch failed:", e);
      setRestaurants([]);
    }
  };

  const runBothSearches = async () => {
    if (!markerPos || restaurants.length === 0) return;

    setLinAnimStartTime(null);
    setLinAnimDurationMs(null);
    setKdAnimStartTime(null);
    setKdAnimDurationMs(null);

    const linInfo = linearRangeSearchTraceGeo(projected, latlons, [markerPos[0], markerPos[1]], radiusMeters);
    setLinSearchInfo(linInfo);
    setLinStepIdx(0);

    await new Promise((r) => setTimeout(r, 10));

    const t0 = nowMs();
    const root = (buildKDTree(projected) as unknown) as KDNode | null;
    const t1 = nowMs();
    setKdBuildMs(t1 - t0);

    const centerMerc = lonLatToMercator([markerPos[1], markerPos[0]]);
    const phiRad = (markerPos[0] * Math.PI) / 180;
    const rProj = radiusMeters / Math.cos(phiRad);
    const kdInfo = rangeSearchTrace(root, centerMerc, rProj);
    setKdSearchInfo(kdInfo);
    setKdStepIdx(0);

    setLinIsPlaying(true);
    setKdIsPlaying(true);
  };

  // Fast / skip-visualization run: compute both searches and set final state immediately
  const runFastSearch = () => {
    if (!markerPos || restaurants.length === 0) return;

    // stop any animations
    setLinIsPlaying(false);
    setKdIsPlaying(false);
    setLinAnimStartTime(null);
    setLinAnimDurationMs(null);
    setKdAnimStartTime(null);
    setKdAnimDurationMs(null);

    // linear (geodesic) search — compute and set final index
    const linInfo = linearRangeSearchTraceGeo(projected, latlons, [markerPos[0], markerPos[1]], radiusMeters);
    setLinSearchInfo(linInfo);
    setLinStepIdx(Math.max(0, linInfo.steps.length - 1));

    // KD tree build + search
    const t0 = nowMs();
    const root = (buildKDTree(projected) as unknown) as KDNode | null;
    const t1 = nowMs();
    setKdBuildMs(t1 - t0);

    const centerMerc = lonLatToMercator([markerPos[1], markerPos[0]]);
    const phiRad = (markerPos[0] * Math.PI) / 180;
    const rProj = radiusMeters / Math.cos(phiRad);
    const kdInfo = rangeSearchTrace(root, centerMerc, rProj);
    setKdSearchInfo(kdInfo);
    setKdStepIdx(Math.max(0, kdInfo.steps.length - 1));

    // mark playback durations as completed immediately
    setLinAnimDurationMs(0);
    setKdAnimDurationMs(0);
  };

  const runServerBenchmark = async () => {
    if (!markerPos) return;
    setBenchRunning(true);
    setBenchResult(null);
    setBenchError(null);
    try {
      const res = await fetch('/api/benchmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ centerLat: markerPos[0], centerLon: markerPos[1], radiusMeters, fetchRadiusMeters: 2000 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'benchmark failed');
      setBenchResult(data);
    } catch (e) {
      setBenchError(String(e));
    } finally {
      setBenchRunning(false);
    }
  };

  const linVisitedSet = useMemo(() => {
    const s = new Set<string>();
    for (let i = 0; i <= linStepIdx && i < linSearchInfo.steps.length; i++) {
      const p = linSearchInfo.steps[i].point;
      s.add(`${p[0].toFixed(3)},${p[1].toFixed(3)}`);
    }
    return s;
  }, [linSearchInfo.steps, linStepIdx]);

  const linInRangeSet = useMemo(() => {
    const s = new Set<string>();
    for (const idx of linSearchInfo.resultsIdx || []) {
      const p = projected[idx];
      s.add(`${p[0].toFixed(3)},${p[1].toFixed(3)}`);
    }
    return s;
  }, [linSearchInfo.resultsIdx, projected]);

  const kdVisitedSet = useMemo(() => {
    const s = new Set<string>();
    for (let i = 0; i <= kdStepIdx && i < kdSearchInfo.steps.length; i++) {
      const p = kdSearchInfo.steps[i].point;
      s.add(`${p[0].toFixed(3)},${p[1].toFixed(3)}`);
    }
    return s;
  }, [kdSearchInfo.steps, kdStepIdx]);

  const kdInRangeSet = useMemo(() => {
    const s = new Set<string>();
    for (const n of kdSearchInfo.results || []) {
      const p = n.point;
      s.add(`${p[0].toFixed(3)},${p[1].toFixed(3)}`);
    }
    return s;
  }, [kdSearchInfo.results]);

  const linVisitedList = useMemo(() => {
    const inside: OverpassNode[] = [];
    const outside: OverpassNode[] = [];
    for (let i = 0; i < restaurants.length; i++) {
      const key = `${projected[i][0].toFixed(3)},${projected[i][1].toFixed(3)}`;
      if (linVisitedSet.has(key)) {
        if (linInRangeSet.has(key)) inside.push(restaurants[i]);
        else outside.push(restaurants[i]);
      }
    }
    return { inside, outside };
  }, [restaurants, projected, linVisitedSet, linInRangeSet]);

  const kdVisitedList = useMemo(() => {
    const inside: OverpassNode[] = [];
    const outside: OverpassNode[] = [];
    for (let i = 0; i < restaurants.length; i++) {
      const key = `${projected[i][0].toFixed(3)},${projected[i][1].toFixed(3)}`;
      if (kdVisitedSet.has(key)) {
        if (kdInRangeSet.has(key)) inside.push(restaurants[i]);
        else outside.push(restaurants[i]);
      }
    }
    return { inside, outside };
  }, [restaurants, projected, kdVisitedSet, kdInRangeSet]);

  return (
    <div className="flex flex-col gap-6">
      <div className="w-full max-w-4xl mx-auto flex gap-2 mb-2">
        <Autocomplete
          freeSolo
          options={results.map((item) => item.display_name)}
          inputValue={query}
          onInputChange={(_event: React.SyntheticEvent, value: string) => setQuery(value)}
          onChange={(_event: React.SyntheticEvent, value: string | null) => {
            if (typeof value === 'string') setQuery(value);
          }}
          renderInput={(params: AutocompleteRenderInputParams) => (
            <TextField {...params} label="Search a town…" variant="outlined" size="small" fullWidth />
          )}
          disableClearable
          open={results.length > 0 && !results.some(r => r.display_name === query)}
          className="w-full"
        />
        <button type="button" onClick={handleSearch} disabled={isLoading} className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{isLoading ? "…" : "Search"}</button>
      </div>

      <div className="w-full max-w-4xl mx-auto bg-white rounded-lg shadow-lg p-4 border border-slate-200">
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => {
              if (!linIsPlaying && linStepIdx < linSearchInfo.steps.length - 1) {
                setLinIsPlaying(true);
                setLinAnimStartTime(nowMs() - (linAnimDurationMs ?? 0));
                setLinAnimDurationMs(null);
              } else if (!kdIsPlaying && kdStepIdx < kdSearchInfo.steps.length - 1) {
                setKdIsPlaying(true);
                setKdAnimStartTime(nowMs() - (kdAnimDurationMs ?? 0));
                setKdAnimDurationMs(null);
              } else {
                runBothSearches();
              }
            }}
            className="px-4 py-2 rounded bg-green-600 text-white hover:bg-green-700 font-medium text-sm"
          >
            Start
          </button>
          <button
            type="button"
            onClick={runFastSearch}
            className="px-4 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700 font-medium text-sm"
          >
            Skip visualization
          </button>
          <button
            type="button"
            onClick={() => runServerBenchmark()}
            disabled={!markerPos || benchRunning}
            className="px-4 py-2 rounded bg-sky-600 text-white hover:bg-sky-700 font-medium text-sm"
          >
            {benchRunning ? 'Benchmarking…' : 'Benchmark (server)'}
          </button>
          <button
            onClick={() => {
              setLinIsPlaying(false);
              setKdIsPlaying(false);
              if (linIsPlaying && linAnimStartTime !== null) {
                setLinAnimDurationMs(nowMs() - linAnimStartTime);
              }
              if (kdIsPlaying && kdAnimStartTime !== null) {
                setKdAnimDurationMs(nowMs() - kdAnimStartTime);
              }
            }}
            className="px-4 py-2 rounded bg-yellow-500 text-white hover:bg-yellow-600 font-medium text-sm"
          >
            Pause
          </button>
          <button
            onClick={() => {
              setLinIsPlaying(false);
              setKdIsPlaying(false);
              setLinStepIdx(0);
              setKdStepIdx(0);
              setLinAnimStartTime(null);
              setKdAnimStartTime(null);
            }}
            className="px-4 py-2 rounded bg-red-600 text-white hover:bg-red-700 font-medium text-sm"
          >
            Stop
          </button>
        </div>

        {benchResult && (
          <div className="mt-3 p-3 bg-gray-50 rounded border border-slate-200 text-sm text-black">
            <div className="font-semibold mb-2">Server benchmark results — {benchResult.count} POIs</div>
            <div>KD build: {benchResult.buildMs?.toFixed(4)} ms</div>
            <div>KD search: {benchResult.kdMs?.toFixed(4)} ms</div>
            <div>Linear: {benchResult.linMs?.toFixed(4)} ms</div>
            <div className="mt-2">KD visited: {benchResult.kdVisited ?? '—'} / {benchResult.count}</div>
            <div>Linear visited: {benchResult.linVisited ?? '—'} / {benchResult.count}</div>
            <div className="mt-2">Inside (linear): {benchResult.linInsideCount ?? benchResult.inside?.length}</div>
          </div>
        )}
        {benchError && (
          <div className="mt-3 p-2 bg-red-50 rounded border border-red-200 text-sm text-red-700">{benchError}</div>
        )}

        <div className="grid grid-cols-2 gap-6">
          <div>
            <label className="flex items-center gap-3">
              <span className="text-sm font-semibold text-slate-900 w-24">Radius:</span>
              <input
                type="range"
                min={200}
                max={2000}
                step={50}
                value={radiusMeters}
                onChange={(e) => setRadiusMeters(parseInt(e.target.value, 10))}
                className="flex-1"
              />
              <span className="text-sm font-medium text-slate-700 w-20 text-right tabular-nums">{radiusMeters} m</span>
            </label>
          </div>
          <div>
            <label className="flex items-center gap-3">
              <span className="text-sm font-semibold text-slate-900 w-24">Speed:</span>
              <input
                type="range"
                min={10}
                max={400}
                step={5}
                value={speedMs}
                onChange={(e) => setSpeedMs(parseInt(e.target.value, 10))}
                className="flex-1"
              />
              <span className="text-sm font-medium text-slate-700 w-20 text-right tabular-nums">{speedMs} ms</span>
            </label>
          </div>
        </div>
      </div>

      <div className="flex gap-4">
        <div className="flex-1 bg-white rounded-lg shadow-lg p-4 border border-slate-200">
          <div className="text-lg font-semibold mb-3 text-slate-900">Linear (geodesic)</div>
          <div className="h-80 relative">
            <MapContainer center={markerPos ?? [48.137, 11.575]} zoom={13} scrollWheelZoom className="h-full w-full rounded">
              <TileLayer attribution='&copy; OSM' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              {markerPos && (
                <>
                  <Marker position={markerPos}><Popup>{query || "Selected"}</Popup></Marker>
                  <Circle center={markerPos} radius={radiusMeters} />
                </>
              )}
              {restaurants.map((r, i) => {
                const p = projected[i];
                const key = `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
                const visited = linVisitedSet.has(key);
                const inRange = linInRangeSet.has(key);
                const color = visited ? (inRange ? "green" : "red") : "gray";
                const fillOp = inRange ? 0.7 : 0.4;
                const rad = visited ? 9 : 5;
                return (
                  <CircleMarker key={r.id} center={[r.lat, r.lon]} radius={rad} pathOptions={{ color, fillOpacity: fillOp, weight: 1, className: "will-change-transform" }}>
                    <Popup>
                      <div className="font-medium">{r.tags?.name ?? "Restaurant"}</div>
                      <div className="text-xs">{visited ? "Visited" : "Not visited"} {inRange ? "• In range" : ""}</div>
                    </Popup>
                  </CircleMarker>
                );
              })}
              <FlyToPosition position={markerPos} />
            </MapContainer>
          </div>

          <div className="mt-3 text-sm bg-slate-50 rounded p-3 border border-slate-200">
            <div className="text-slate-700 font-medium text-xs space-y-1">
              <div>
                <span>Search: </span><span className="text-blue-600 font-mono">{(linSearchInfo.searchMs ?? 0).toFixed(2)} ms</span>
                <span className="mx-2">—</span>
                <span>Playback: </span>
                {linIsPlaying && linAnimStartTime !== null ? (
                  <span className="text-purple-600 font-mono animate-pulse">{((nowMs() - linAnimStartTime) / 1000).toFixed(2)}s (live)</span>
                ) : linAnimDurationMs !== null ? (
                  <span className="text-purple-600 font-mono">{(linAnimDurationMs / 1000).toFixed(2)}s</span>
                ) : (
                  <span className="text-slate-400 font-mono">— s</span>
                )}
              </div>
              <div>
                <span>Visited: </span><span className="text-orange-600 font-mono">{linSearchInfo.visited ?? 0}</span><span className="text-slate-500"> / {restaurants.length}</span>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <div className="font-semibold text-slate-900 text-xs uppercase tracking-wide mb-2 inline-flex items-center gap-2">
                  <span>✓ Inside radius</span>
                  <span className="bg-emerald-100 text-emerald-700 rounded-full px-2 py-0.5 font-mono text-xs">{linVisitedList.inside.length}</span>
                </div>
                <ul className="max-h-40 overflow-auto text-xs text-slate-700 bg-white rounded border border-emerald-200 p-2">
                  {linVisitedList.inside.length > 0 ? linVisitedList.inside.map((n) => <li key={n.id} className="py-1 border-b border-emerald-100 last:border-0">✓ {n.tags?.name ?? `POI ${n.id}`}</li>) : <li className="text-slate-500 italic">None</li>}
                </ul>
              </div>
              <div>
                <div className="font-semibold text-slate-900 text-xs uppercase tracking-wide mb-2 inline-flex items-center gap-2">
                  <span>✕ Outside radius</span>
                  <span className="bg-red-100 text-red-700 rounded-full px-2 py-0.5 font-mono text-xs">{linVisitedList.outside.length}</span>
                </div>
                <ul className="max-h-40 overflow-auto text-xs text-slate-700 bg-white rounded border border-red-200 p-2">
                  {linVisitedList.outside.length > 0 ? linVisitedList.outside.map((n) => <li key={n.id} className="py-1 border-b border-red-100 last:border-0">✕ {n.tags?.name ?? `POI ${n.id}`}</li>) : <li className="text-slate-500 italic">None</li>}
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 bg-white rounded-lg shadow-lg p-4 border border-slate-200">
          <div className="text-lg font-semibold mb-3 text-slate-900">KD-Tree (projected)</div>
          <div className="h-80 relative">
            <MapContainer center={markerPos ?? [48.137, 11.575]} zoom={13} scrollWheelZoom className="h-full w-full rounded">
              <TileLayer attribution='&copy; OSM' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              {markerPos && (
                <>
                  <Marker position={markerPos}><Popup>{query || "Selected"}</Popup></Marker>
                  <Circle center={markerPos} radius={radiusMeters} />
                </>
              )}

              {restaurants.map((r) => {
                const p = lonLatToMercator([r.lon, r.lat]);
                const key = `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
                const visited = kdVisitedSet.has(key);
                const inRange = kdInRangeSet.has(key);
                const color = visited ? (inRange ? "green" : "red") : "gray";
                const fillOp = inRange ? 0.7 : 0.4;
                const rad = visited ? 9 : 5;
                return (
                  <CircleMarker key={r.id} center={[r.lat, r.lon]} radius={rad} pathOptions={{ color, fillOpacity: fillOp, weight: 1, className: "will-change-transform" }}>
                    <Popup>
                      <div className="font-medium">{r.tags?.name ?? "Restaurant"}</div>
                      <div className="text-xs">{visited ? "Visited" : "Not visited"} {inRange ? "• In range" : ""}</div>
                    </Popup>
                  </CircleMarker>
                );
              })}

              <FlyToPosition position={markerPos} />
            </MapContainer>
          </div>

          <div className="mt-3 text-sm bg-slate-50 rounded p-3 border border-slate-200">
            <div className="text-slate-700 font-medium text-xs space-y-1">
              <div>
                <span>Build: </span><span className="text-violet-600 font-mono">{kdBuildMs.toFixed(2)} ms</span>
                <span className="mx-2">—</span>
                <span>Search: </span><span className="text-blue-600 font-mono">{(kdSearchInfo.searchMs ?? 0).toFixed(2)} ms</span>
                <span className="mx-2">—</span>
                <span>Playback: </span>
                {kdIsPlaying && kdAnimStartTime !== null ? (
                  <span className="text-purple-600 font-mono animate-pulse">{((nowMs() - kdAnimStartTime) / 1000).toFixed(2)}s (live)</span>
                ) : kdAnimDurationMs !== null ? (
                  <span className="text-purple-600 font-mono">{(kdAnimDurationMs / 1000).toFixed(2)}s</span>
                ) : (
                  <span className="text-slate-400 font-mono">— s</span>
                )}
              </div>
              <div>
                <span>Visited: </span><span className="text-orange-600 font-mono">{kdSearchInfo.visited ?? 0}</span><span className="text-slate-500"> / {restaurants.length}</span>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <div className="font-semibold text-slate-900 text-xs uppercase tracking-wide mb-2 inline-flex items-center gap-2">
                  <span>✓ Inside radius</span>
                  <span className="bg-emerald-100 text-emerald-700 rounded-full px-2 py-0.5 font-mono text-xs">{kdVisitedList.inside.length}</span>
                </div>
                <ul className="max-h-40 overflow-auto text-xs text-slate-700 bg-white rounded border border-emerald-200 p-2">
                  {kdVisitedList.inside.length > 0 ? kdVisitedList.inside.map((n) => <li key={n.id} className="py-1 border-b border-emerald-100 last:border-0">✓ {n.tags?.name ?? `POI ${n.id}`}</li>) : <li className="text-slate-500 italic">None</li>}
                </ul>
              </div>
              <div>
                <div className="font-semibold text-slate-900 text-xs uppercase tracking-wide mb-2 inline-flex items-center gap-2">
                  <span>✕ Outside radius</span>
                  <span className="bg-red-100 text-red-700 rounded-full px-2 py-0.5 font-mono text-xs">{kdVisitedList.outside.length}</span>
                </div>
                <ul className="max-h-40 overflow-auto text-xs text-slate-700 bg-white rounded border border-red-200 p-2">
                  {kdVisitedList.outside.length > 0 ? kdVisitedList.outside.map((n) => <li key={n.id} className="py-1 border-b border-red-100 last:border-0">✕ {n.tags?.name ?? `POI ${n.id}`}</li>) : <li className="text-slate-500 italic">None</li>}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
