"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMap,
  Circle,
} from "react-leaflet";
import L from "leaflet";
import { buildKDTree, rangeSearch, KDNode } from "../../KdTree";
import { lonLatToMercator } from "../../geo";

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

type OverpassNode = {
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
};

function FlyToPosition({ position }: { position: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (position) map.flyTo(position, 14, { duration: 1.2 });
  }, [position, map]);
  return null;
}

export default function MapWithSearch() {
  const [markerPos, setMarkerPos] = useState<[number, number] | null>([48.137, 11.575]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const [restaurants, setRestaurants] = useState<OverpassNode[]>([]);
  const [radiusMeters, setRadiusMeters] = useState<number>(1500);
  const [fetchRadiusMeters] = useState<number>(5000);

  const listRef = useRef<HTMLUListElement | null>(null);

  const fetchRestaurants = async (center: [number, number], aroundMeters: number) => {
    const [lat, lon] = [center[0], center[1]];
    const query = `
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
        body: "data=" + encodeURIComponent(query),
      });
      const data = await res.json();
      type OverpassElement = {
        type?: string;
        id: number;
        lat?: number;
        lon?: number;
        tags?: Record<string, string>;
      };
      const elements = (data.elements || []) as OverpassElement[];
      const nodes: OverpassNode[] = elements
        .filter((e) => e.type === "node" && e.lat !== undefined && e.lon !== undefined)
        .map((e) => ({ id: e.id, lat: e.lat!, lon: e.lon!, tags: e.tags || {} }));
      setRestaurants(nodes);
    } catch (e) {
      console.error("Overpass fetch failed:", e);
      setRestaurants([]);
    }
  };

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

  const handleSelect = async (item: SearchResult) => {
    const pos: [number, number] = [parseFloat(item.lat), parseFloat(item.lon)];
    setMarkerPos(pos);
    setQuery(item.display_name);
    setResults([]);
    await fetchRestaurants(pos, fetchRadiusMeters);
  };

  const kdRoot: KDNode | null = useMemo(() => {
    if (!restaurants.length) return null;
    const pts = restaurants.map((r) => {
      const [x, y] = lonLatToMercator([r.lon, r.lat]);
      return [x, y];
    });
    return buildKDTree(pts);
  }, [restaurants]);

  const projectedToRestaurant = useMemo(() => {
    const map = new Map<string, OverpassNode>();
    for (const r of restaurants) {
      const [x, y] = lonLatToMercator([r.lon, r.lat]);
      map.set(`${x.toFixed(3)},${y.toFixed(3)}`, r);
    }
    return map;
  }, [restaurants]);

  const filteredRestaurants: OverpassNode[] = useMemo(() => {
    if (!kdRoot || !markerPos) return [];
    const centerMerc = lonLatToMercator([markerPos[1], markerPos[0]]);
    const nodes = rangeSearch(kdRoot, centerMerc, radiusMeters);
    const out: OverpassNode[] = [];
    for (const n of nodes) {
      const key = `${n.point[0].toFixed(3)},${n.point[1].toFixed(3)}`;
      const r = projectedToRestaurant.get(key);
      if (r) out.push(r);
    }
    return out;
  }, [kdRoot, markerPos, radiusMeters, projectedToRestaurant]);

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
        <ul
          ref={listRef}
          className="absolute top-16 left-1/2 z-[1000] max-h-60 w-[90%] max-w-2xl -translate-x-1/2 overflow-y-auto rounded-xl bg-white shadow-lg dark:bg-zinc-950"
        >
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

      <div className="absolute bottom-3 left-1/2 z-[1000] flex w-[90%] max-w-2xl -translate-x-1/2 items-center gap-3 rounded-full bg-white/90 px-4 py-2 text-sm shadow-md backdrop-blur dark:bg-zinc-900/90">
        <span className="text-xs text-zinc-600 dark:text-zinc-400">Radius</span>
        <input
          type="range"
          min={200}
          max={5000}
          step={100}
          value={radiusMeters}
          onChange={(e) => setRadiusMeters(parseInt(e.target.value, 10))}
          className="flex-1"
        />
        <span className="w-16 text-right text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
          {radiusMeters} m
        </span>
        <span className="hidden sm:inline text-xs text-zinc-500 dark:text-zinc-400">
          (fetch {fetchRadiusMeters / 1000} km)
        </span>
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

        {filteredRestaurants.map((r) => (
          <Marker key={r.id} position={[r.lat, r.lon]}>
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
                {r.tags?.website && (
                  <a
                    href={r.tags.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs underline"
                  >
                    Website
                  </a>
                )}
              </div>
            </Popup>
          </Marker>
        ))}

        <FlyToPosition position={markerPos} />
      </MapContainer>
    </div>
  );
}
