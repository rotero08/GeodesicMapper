import { routeGeometry } from './routes.js';

/** Distance from point p to the segment a-b, all in screen pixels. */
function segmentDistance(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(wx, wy);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(p[0] - b[0], p[1] - b[1]);
  const k = c1 / c2;
  return Math.hypot(p[0] - (a[0] + k * vx), p[1] - (a[1] + k * vy));
}

/**
 * The route nearest to a screen point, within `tolerance` pixels, or null. Great-circle curves
 * are tested as drawn; a marker counts as its pin head, which sits above the position it marks.
 */
export function hitTest(frame, routes, point, tolerance = 12) {
  let best = null;
  let bestDistance = tolerance;
  for (const route of routes) {
    if (route.kind === 'marker' || route.verts.length < 2) {
      const at = frame.project(route.verts[0]);
      if (!at) continue;
      const d = Math.hypot(at[0] - point[0], at[1] - 11 - point[1]);
      if (d < bestDistance) [best, bestDistance] = [route, d];
      continue;
    }
    let previous = null;
    for (const position of routeGeometry(route).gc) {
      const at = frame.project(position);
      if (!at) {
        previous = null;
        continue;
      }
      const d = previous ? segmentDistance(point, previous, at) : Math.hypot(at[0] - point[0], at[1] - point[1]);
      if (d < bestDistance) [best, bestDistance] = [route, d];
      previous = at;
    }
  }
  return best;
}
