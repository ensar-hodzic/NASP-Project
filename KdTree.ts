// lib/kdTree.ts
export class KDNode {
  point: number[];    // e.g. [x, y] in meters
  axis: number;
  left: KDNode | null;
  right: KDNode | null;

  constructor(point: number[], axis: number) {
    this.point = point;
    this.axis = axis;
    this.left = null;
    this.right = null;
  }
}

export function buildKDTree(points: number[][], depth = 0): KDNode | null {
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

export function distanceSquared(p1: number[], p2: number[]) {
  return p1.reduce((s, v, i) => {
    const d = v - p2[i];
    return s + d * d;
  }, 0);
}

// Find ALL nodes within radius (meters) of target
export function rangeSearch(
  root: KDNode | null,
  target: number[],
  radiusMeters: number,
  depth = 0,
  results: KDNode[] = []
): KDNode[] {
  if (!root) return results;
  const k = target.length;
  const axis = depth % k;

  const r2 = radiusMeters * radiusMeters;
  if (distanceSquared(target, root.point) <= r2) results.push(root);

  const diff = target[axis] - root.point[axis];
  // visit side of target first
  if (diff < 0) rangeSearch(root.left, target, radiusMeters, depth + 1, results);
  else rangeSearch(root.right, target, radiusMeters, depth + 1, results);

  // visit the other side if sphere crosses the splitting plane
  if (Math.abs(diff) <= radiusMeters) {
    if (diff < 0) rangeSearch(root.right, target, radiusMeters, depth + 1, results);
    else rangeSearch(root.left, target, radiusMeters, depth + 1, results);
  }
  return results;
}
