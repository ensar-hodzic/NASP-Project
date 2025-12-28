"use client";

import { useEffect, useMemo, useState } from "react";
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

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371008.8;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const dφ = toRad(lat2 - lat1);
  const dλ = toRad(lon2 - lon1);
  const a =
    Math.sin(dφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

type Step = {
  id: number;
  point: number[];
  axis: number;
  diff: number;
  within: boolean;
  branched: boolean;
};

type OverpassNode = {
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
};

function linearRangeSearchTraceGeo(
  projectedPoints: number[][],
  latLonPoints: [number, number][],
  centerLatLon: [number, number],
  radiusMeters: number
) {
  const steps: Step[] = [];
  const resultsIdx: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < projectedPoints.length; i++) {
    const [plat, plon] = latLonPoints[i];
    const within =
      haversineMeters(centerLatLon[0], centerLatLon[1], plat, plon) <=
      radiusMeters;
    steps.push({
      id: i + 1,
      point: projectedPoints[i],
      axis: -1,
      diff: 0,
      within,
      branched: false,
    });
    if (within) resultsIdx.push(i);
  }
  const t1 = performance.now();
  return {
    steps: [...steps],
    resultsIdx: [...resultsIdx],
    visited: steps.length,
    searchMs: t1 - t0,
  };
}

const defaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});
L.Marker.prototype.options.icon = defaultIcon;

type SearchResult = {
  display_name: string;
  lat: string;
  lon: string;
};

function FlyToPosition({ position }: { position: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (position) map.flyTo(position, 14, { duration: 1.0 });
  }, [position, map]);
  return null;
}

export default function MapWithSearchLinear() {
  const [markerPos, setMarkerPos] = useState<[number, number] | null>([
    48.137, 11.575,
  ]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const [restaurants, setRestaurants] = useState<OverpassNode[]>([]);
  const [radiusMeters, setRadiusMeters] = useState<number>(1500);
  const [fetchRadiusMeters] = useState<number>(5000);

  const [isPlaying, setIsPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState(60);
  const [stepIdx, setStepIdx] = useState(0);

  const [searchInfo, setSearchInfo] = useState<{
    steps: Step[];
    resultsIdx: number[];
    visited: number;
    searchMs: number;
  }>({ steps: [], resultsIdx: [], visited: 0, searchMs: 0 });

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;
    setIsLoading(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
          query
        )}&addressdetails=1&limit=5`
      );
      const data: SearchResult[] = await res.json();
      setResults(data);
      if (data.length > 0) {
        const first = data[0];
        const pos: [number, number] = [
          parseFloat(first.lat),
          parseFloat(first.lon),
        ];
        setMarkerPos(pos);
        await fetchRestaurants(pos, fetchRadiusMeters);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
      setIsPlaying(false);
      setStepIdx(0);
      setSearchInfo({ steps: [], resultsIdx: [], visited: 0, searchMs: 0 });
    }
  };

  const handleSelect = async (item: SearchResult) => {
    const pos: [number, number] = [parseFloat(item.lat), parseFloat(item.lon)];
    setMarkerPos(pos);
    setQuery(item.display_name);
    setResults([]);
    await fetchRestaurants(pos, fetchRadiusMeters);
    setIsPlaying(false);
    setStepIdx(0);
    setSearchInfo({ steps: [], resultsIdx: [], visited: 0, searchMs: 0 });
  };

  const fetchRestaurants = async (
    center: [number, number],
    aroundMeters: number
  ) => {
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
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/json",
        },
        body: "data=" + encodeURIComponent(q),
      });
      const data = await res.json();
      type OverpassElement = {
        type?: string;
        id?: number;
        lat?: number;
        lon?: number;
        tags?: Record<string, string>;
      };
      const elements = (data.elements || []) as OverpassElement[];
      const nodes: OverpassNode[] = elements
        .filter(
          (e) =>
            e.type === "node" &&
            e.id !== undefined &&
            e.lat !== undefined &&
            e.lon !== undefined
        )
        .map((e) => ({
          id: e.id as number,
          lat: e.lat as number,
          lon: e.lon as number,
          tags: e.tags || {},
        }));
      setRestaurants(nodes);
    } catch (e) {
      console.error("Overpass fetch failed:", e);
      setRestaurants([]);
    }
  };

  const projected = useMemo(() => {
    return restaurants.map((r) => lonLatToMercator([r.lon, r.lat]));
  }, [restaurants]);

  const latlons = useMemo<[number, number][]>(() => {
    return restaurants.map((r) => [r.lat, r.lon] as [number, number]);
  }, [restaurants]);

  useEffect(() => {
    if (!isPlaying) return;
    if (searchInfo.steps.length === 0) return;

    const id = setTimeout(() => {
      setStepIdx((i) => {
        if (i + 1 >= searchInfo.steps.length) {
          setIsPlaying(false);
          return searchInfo.steps.length - 1;
        }
        return i + 1;
      });
    }, speedMs);
    return () => clearTimeout(id);
  }, [isPlaying, stepIdx, searchInfo.steps.length, speedMs]);

  useEffect(() => {
    setIsPlaying(false);
    setStepIdx(0);
    setSearchInfo({ steps: [], resultsIdx: [], visited: 0, searchMs: 0 });
  }, [restaurants, markerPos, radiusMeters]);

  const visitedKeySet = useMemo(() => {
    const s = new Set<string>();
    for (let i = 0; i <= stepIdx && i < searchInfo.steps.length; i++) {
      const p = searchInfo.steps[i].point;
      s.add(`${p[0].toFixed(3)},${p[1].toFixed(3)}`);
    }
    return s;
  }, [searchInfo.steps, stepIdx]);

  const inRangeKeySet = useMemo(() => {
    const s = new Set<string>();
    for (const idx of searchInfo.resultsIdx) {
      const p = projected[idx];
      s.add(`${p[0].toFixed(3)},${p[1].toFixed(3)}`);
    }
    return s;
  }, [searchInfo.resultsIdx, projected]);

  const pruningPct =
    restaurants.length > 0
      ? Math.max(0, 100 - (searchInfo.visited / restaurants.length) * 100)
      : 0;

  const currentStep = searchInfo.steps[stepIdx] || null;

  return (
    <div className="relative h-full w-full rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800">
      <form
        onSubmit={handleSearch}
        className="absolute top-3 left-1/2 z-[1000] flex w-[90%] max-w-2xl -translate-x-1/2 items-center gap-2 rounded-full bg-white/90 px-4 py-2 shadow-md backdrop-blur dark:bg-zinc-900/90"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 bg-transparent text-sm outline-none text-zinc-900 dark:text-zinc-50 placeholder:text-zinc-400"
          placeholder="Search a town (e.g. Sarajevo, Berlin)…"
        />
        <button
          type="submit"
          disabled={isLoading}
          className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {isLoading ? "…" : "Search"}
        </button>
      </form>

      {results.length > 0 && (
        <ul className="absolute top-16 left-1/2 z-[1000] max-h-60 w-[90%] max-w-2xl -translate-x-1/2 overflow-y-auto rounded-xl bg-white shadow-lg dark:bg-zinc-950">
          {results.map((item) => (
            <li
              key={item.display_name}
              onClick={() => handleSelect(item)}
              className="cursor-pointer border-b border-zinc-100 px-4 py-2 text-sm text-zinc-700 last:border-none hover:bg-zinc-50 dark:border-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-900/80"
            >
              {item.display_name}
            </li>
          ))}
        </ul>
      )}

      <div className="absolute bottom-3 left-1/2 z-[1000] flex w-[90%] max-w-3xl -translate-x-1/2 flex-col gap-2 rounded-xl bg-white/90 p-3 text-sm shadow-md backdrop-blur dark:bg-zinc-900/90">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <span className="text-zinc-500">Build:</span>{" "}
            <span className="font-medium">0.00 ms</span>
            <span className="text-zinc-500"> (no KD build)</span>
          </div>
          <div>
            <span className="text-zinc-500">Search:</span>{" "}
            <span className="font-medium">
              {searchInfo.searchMs.toFixed(2)} ms
            </span>
          </div>
          <div>
            <span className="text-zinc-500">Visited:</span>{" "}
            <span className="font-medium">{searchInfo.visited}</span>
            <span className="text-zinc-500"> / {restaurants.length}</span>
          </div>
          <div title="Linear scan visits all points → 0% pruning">
            <span className="text-zinc-500">Pruning:</span>{" "}
            <span className="font-medium">{pruningPct.toFixed(1)}%</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => {
                if (!isPlaying) {
                  if (markerPos && projected.length) {
                    const info = linearRangeSearchTraceGeo(
                      projected,
                      latlons,
                      [markerPos[0], markerPos[1]],
                      radiusMeters
                    );
                    setSearchInfo(info);
                    setStepIdx(0);
                  }
                  setIsPlaying(true);
                } else {
                  setIsPlaying(false);
                }
              }}
              disabled={!markerPos || projected.length === 0}
              className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {isPlaying ? "Pause" : "Play"}
            </button>
            <button
              onClick={() => {
                setIsPlaying(false);
                setStepIdx(0);
              }}
              className="rounded-full border px-3 py-1 text-xs"
            >
              Reset
            </button>
            <label className="ml-2 flex items-center gap-2 text-xs">
              <span className="text-zinc-500">Speed</span>
              <input
                type="range"
                min={20}
                max={800}
                step={20}
                value={speedMs}
                onChange={(e) => setSpeedMs(parseInt(e.target.value, 10))}
              />
              <span className="w-10 text-right tabular-nums">{speedMs}ms</span>
            </label>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <span className="text-zinc-500">Radius</span>
            <input
              type="range"
              min={200}
              max={5000}
              step={100}
              value={radiusMeters}
              onChange={(e) => setRadiusMeters(parseInt(e.target.value, 10))}
            />
            <span className="w-14 text-right tabular-nums">{radiusMeters} m</span>
          </label>
          <span className="text-xs text-zinc-500">
            Linear scan (geodesic radius) from town center. Fetched{" "}
            {fetchRadiusMeters / 1000} km of POIs from Overpass.
          </span>
        </div>

        {currentStep && (
          <div className="grid grid-cols-2 gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            <div>
              <span className="text-zinc-500">Axis:</span> -1
            </div>
            <div>
              <span className="text-zinc-500">diff:</span> 0
            </div>
            <div>
              <span className="text-zinc-500">Within radius:</span>{" "}
              {currentStep.within ? "Yes" : "No"}
            </div>
            <div>
              <span className="text-zinc-500">Branched:</span> No
            </div>
          </div>
        )}
      </div>

      <MapContainer
        center={markerPos ?? [48.137, 11.575]}
        zoom={13}
        scrollWheelZoom
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {markerPos && (
          <>
            <Marker position={markerPos}>
              <Popup>{query ? query : "Selected location"}</Popup>
            </Marker>
            <Circle center={markerPos} radius={radiusMeters} />
          </>
        )}

        {restaurants.map((r, i) => {
          const p = projected[i];
          const key = `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
          const visited = visitedKeySet.has(key);
          const inRange = inRangeKeySet.has(key);

          const baseRadius = 5;
          const pulseRadius = visited ? baseRadius + 4 : baseRadius;

          return (
            <CircleMarker
              key={r.id}
              center={[r.lat, r.lon]}
              radius={pulseRadius}
              pathOptions={{
                weight: visited ? 2 : 1,
                opacity: visited ? 0.9 : 0.6,
                fillOpacity: inRange ? 0.7 : 0.4,
                color: visited ? (inRange ? "green" : "red") : "gray",
              }}
            >
              <Popup>
                <div className="space-y-1">
                  <div className="font-medium">
                    {r.tags?.name ?? "Restaurant"}
                  </div>
                  {r.tags?.cuisine && (
                    <div className="text-xs text-zinc-600">
                      Cuisine: {r.tags.cuisine}
                    </div>
                  )}
                  <div className="text-xs text-zinc-500">
                    {visited ? "Visited (linear scan)" : "Not visited yet"}{" "}
                    {inRange ? "• In range" : ""}
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
        <FlyToPosition position={markerPos} />
      </MapContainer>
    </div>
  );
}
