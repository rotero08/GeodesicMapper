// Geometry for routes: a route is a list of vertices; between consecutive vertices it can be
// drawn as a great circle (shortest) or as a rhumb line (constant bearing).

import {
  greatCircleAngle,
  greatCirclePoints,
  rhumbAngle,
  rhumbPoints,
  samplesFor,
} from './geodesy.js';

/** Points along one leg, as a great circle ("gc") or a rhumb line ("rhumb"). */
export function legPoints(a, b, kind = 'gc') {
  return kind === 'rhumb'
    ? rhumbPoints(a, b, samplesFor(rhumbAngle(a, b)))
    : greatCirclePoints(a, b, samplesFor(greatCircleAngle(a, b)));
}

/** One continuous polyline through all the legs of a route. */
export function routeLine(verts, kind = 'gc') {
  const out = [];
  for (let i = 0; i < verts.length - 1; i++) {
    const leg = legPoints(verts[i], verts[i + 1], kind);
    out.push(...(i === 0 ? leg : leg.slice(1)));
  }
  return out;
}

/** The point halfway along a leg, where its distance label sits. */
export function legMidpoint(a, b, kind = 'gc') {
  const pts = legPoints(a, b, kind);
  return pts[pts.length >> 1];
}

/** Splits a polyline wherever it jumps across the antimeridian, as GeoJSON (RFC 7946) asks. */
export function splitAtAntimeridian(coords) {
  if (coords.length < 2) return [coords];
  const parts = [[coords[0]]];
  for (let i = 1; i < coords.length; i++) {
    const [lon0, lat0] = coords[i - 1];
    const [lon1, lat1] = coords[i];
    if (Math.abs(lon1 - lon0) > 180) {
      // Interpolate the latitude where the line meets the +-180 meridian.
      const east = lon0 > lon1; // heading east across +180
      const edge0 = east ? 180 : -180;
      const edge1 = east ? -180 : 180;
      const span = lon1 + (east ? 360 : -360) - lon0;
      const k = span === 0 ? 0 : (edge0 - lon0) / span;
      const lat = lat0 + (lat1 - lat0) * k;
      parts[parts.length - 1].push([edge0, lat]);
      parts.push([[edge1, lat]]);
    }
    parts[parts.length - 1].push([lon1, lat1]);
  }
  return parts.filter((p) => p.length > 1);
}

// Route geometry only changes when the vertices do, so each route's curves are built once per
// edit and shared by the renderer and by hit testing.
const cache = new WeakMap();

/** { gc, rhumb, marks } for a route: its two curves and where each leg's labels go. */
export function routeGeometry(route) {
  const key = route.verts.map((v) => `${v[0]},${v[1]}`).join(';');
  let entry = cache.get(route);
  if (entry?.key !== key) {
    entry = { key, gc: null, rhumb: null, marks: null };
    cache.set(route, entry);
  }
  entry.gc ??= routeLine(route.verts, 'gc');
  entry.rhumb ??= routeLine(route.verts, 'rhumb');
  entry.marks ??= route.verts.slice(0, -1).map((a, i) => ({
    gc: legMidpoint(a, route.verts[i + 1], 'gc'),
    rhumb: legMidpoint(a, route.verts[i + 1], 'rhumb'),
  }));
  return entry;
}
