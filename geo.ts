// lib/geo.ts
const R = 6378137; // Web Mercator radius in meters

export function lonLatToMercator([lon, lat]: [number, number]): [number, number] {
  const λ = (lon * Math.PI) / 180;
  const φ = (lat * Math.PI) / 180;
  const x = R * λ;
  const y = R * Math.log(Math.tan(Math.PI / 4 + φ / 2));
  return [x, y];
}
