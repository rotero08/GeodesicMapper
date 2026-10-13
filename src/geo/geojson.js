// Routes <-> GeoJSON. Exported files carry the routes themselves (role "route" or "marker") plus
// the drawn great-circle and rhumb-line curves for any other GeoJSON tool. Importing reads the
// routes back, and also accepts plain GeoJSON from elsewhere (points and lines).

import { pathMetrics, UNITS } from './geodesy.js';
import { routeLine, splitAtAntimeridian } from './routes.js';

const round = (n) => Math.round(n * 1e6) / 1e6;
const position = ([lon, lat]) => [round(lon), round(lat)];

const asGeometry = (parts) =>
  parts.length === 1 ? { type: 'LineString', coordinates: parts[0].map(position) } : { type: 'MultiLineString', coordinates: parts.map((p) => p.map(position)) };

export function routesToGeoJSON(routes, unit = 'km') {
  const features = [];
  for (const route of routes) {
    if (route.kind === 'marker') {
      features.push({
        type: 'Feature',
        properties: { role: 'marker', name: route.label ?? route.name ?? '' },
        geometry: { type: 'Point', coordinates: position(route.verts[0]) },
      });
      continue;
    }
    if (route.verts.length < 2) continue;
    const m = pathMetrics(route.verts, unit);
    const name = route.name ?? '';
    features.push({
      type: 'Feature',
      properties: { role: 'route', name },
      geometry: { type: 'LineString', coordinates: route.verts.map(position) },
    });
    features.push({
      type: 'Feature',
      properties: { role: 'great-circle', name, [`distance_${unit}`]: Math.round(m.gc * 10) / 10 },
      geometry: asGeometry(splitAtAntimeridian(routeLine(route.verts, 'gc'))),
    });
    features.push({
      type: 'Feature',
      properties: { role: 'rhumb-line', name, [`distance_${unit}`]: Math.round(m.rh * 10) / 10 },
      geometry: asGeometry(splitAtAntimeridian(routeLine(route.verts, 'rhumb'))),
    });
  }
  return { type: 'FeatureCollection', properties: { generator: 'Geodesic Mapper', unit: UNITS[unit]?.label ?? unit }, features };
}

const validPosition = (p) =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 360;

/**
 * Reads routes from a parsed GeoJSON value. Returns { routes, skipped } where each route is
 * { kind, verts, name?, label? } without an id. Derived curves in our own exports are ignored.
 */
export function geoJSONToRoutes(json, { maxVertices = 200 } = {}) {
  const features = [];
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FeatureCollection') node.features?.forEach(collect);
    else if (node.type === 'Feature') features.push(node);
    else if (node.type) features.push({ type: 'Feature', properties: {}, geometry: node });
  };
  collect(json);

  const routes = [];
  let skipped = 0;
  for (const { properties = {}, geometry } of features) {
    if (properties?.role === 'great-circle' || properties?.role === 'rhumb-line') continue;
    const name = typeof properties?.name === 'string' && properties.name ? properties.name : undefined;
    const lines = [];
    if (geometry?.type === 'Point' && validPosition(geometry.coordinates)) {
      routes.push({ kind: 'marker', verts: [[geometry.coordinates[0], geometry.coordinates[1]]], label: name });
      continue;
    }
    if (geometry?.type === 'LineString') lines.push(geometry.coordinates);
    else if (geometry?.type === 'MultiLineString') lines.push(...geometry.coordinates);
    else if (geometry?.type === 'MultiPoint') {
      for (const c of geometry.coordinates) if (validPosition(c)) routes.push({ kind: 'marker', verts: [[c[0], c[1]]], label: name });
      continue;
    }
    for (const line of lines) {
      if (!Array.isArray(line) || line.length < 2 || !line.every(validPosition)) {
        skipped++;
        continue;
      }
      const verts = line.map((p) => [p[0], p[1]]);
      // A foreign file may hold a finely sampled track; keep an even subset so it stays usable.
      const step = Math.ceil(verts.length / maxVertices);
      const kept = step > 1 ? verts.filter((_, i) => i % step === 0 || i === verts.length - 1) : verts;
      routes.push({ kind: 'path', verts: kept, name });
    }
    if (!geometry || !['Point', 'LineString', 'MultiLineString', 'MultiPoint'].includes(geometry.type)) skipped++;
  }
  return { routes, skipped };
}
