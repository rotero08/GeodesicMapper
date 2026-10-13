// The view and the routes, packed into the URL hash so a link reproduces what you are looking at.
//
//   #p=mercator&t=1&v=-12,-16,1.5,0,0&u=km&l=cgrs&w=Madrid%20to%20Tokyo:40.4168,-3.7038,35.6762,139.6503~!Home:41.9,12.5
//
// p projection, t morph position, v rotation lon, rotation lat, zoom, pan x, pan y, u unit,
// l enabled layers (one letter each), w routes (name:lat,lon,lat,lon…, and "!" marks a marker).

import { UNITS } from '../geo/geodesy.js';
import { TARGETS } from '../geo/projections.js';
import { LAYERS } from './state.js';

const num = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const round = (n, digits) => String(Number(n.toFixed(digits)));

export function encodeState(state) {
  const parts = [
    `p=${state.target}`,
    `t=${round(state.t, 3)}`,
    `v=${round(state.rot[0], 2)},${round(state.rot[1], 2)},${round(state.zoom, 2)},${Math.round(state.pan[0])},${Math.round(state.pan[1])}`,
    `u=${state.unit}`,
    `l=${LAYERS.filter((layer) => state.layers[layer.key]).map((layer) => layer.code).join('')}`,
  ];
  const routes = state.routes.map((route) => {
    const coords = route.verts.flatMap(([lon, lat]) => [round(lat, 4), round(lon, 4)]).join(',');
    const name = route.kind === 'marker' ? (route.label ?? route.name ?? '') : (route.name ?? '');
    // Commas, colons and tildes are separators here, so they cannot appear in a name.
    const safe = encodeURIComponent(name).replace(/~/g, '%7E');
    return `${route.kind === 'marker' ? '!' : ''}${safe}:${coords}`;
  });
  if (routes.length) parts.push(`w=${routes.join('~')}`);
  return parts.join('&');
}

/** Reads a hash produced by encodeState; anything missing or malformed is simply left out. */
export function decodeState(hash) {
  const text = String(hash ?? '').replace(/^#/, '');
  const fields = Object.fromEntries(
    text
      .split('&')
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf('=');
        return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
      }),
  );
  const out = {};

  if (TARGETS.some((p) => p.id === fields.p)) out.target = fields.p;
  if (fields.t !== undefined) out.t = num(fields.t, 0, 0, 1);
  if (fields.v) {
    const [lon, lat, zoom, px, py] = fields.v.split(',');
    out.rot = [num(lon, -12, -540, 540), num(lat, -16, -540, 540), 0];
    out.zoom = num(zoom, 1, 0.5, 14);
    out.pan = [num(px, 0, -5000, 5000), num(py, 0, -5000, 5000)];
  }
  if (UNITS[fields.u]) out.unit = fields.u;
  if (fields.l !== undefined) {
    out.layers = Object.fromEntries(LAYERS.map((layer) => [layer.key, fields.l.includes(layer.code)]));
  }
  if (fields.w) out.routes = decodeRoutes(fields.w);
  return out;
}

function decodeRoutes(text) {
  const routes = [];
  for (const item of text.split('~')) {
    const at = item.lastIndexOf(':');
    if (at < 0) continue;
    let head = item.slice(0, at);
    const marker = head.startsWith('!');
    if (marker) head = head.slice(1);
    let name;
    try {
      name = decodeURIComponent(head);
    } catch {
      name = head;
    }
    const numbers = item.slice(at + 1).split(',').map(Number);
    if (numbers.length < 2 || numbers.length % 2 || numbers.some((n) => !Number.isFinite(n))) continue;

    const verts = [];
    for (let i = 0; i < numbers.length; i += 2) {
      if (Math.abs(numbers[i]) > 90 || Math.abs(numbers[i + 1]) > 360) {
        verts.length = 0;
        break;
      }
      verts.push([numbers[i + 1], numbers[i]]);
    }
    if (!verts.length || (!marker && verts.length < 2)) continue;
    routes.push(
      marker
        ? { kind: 'marker', verts: [verts[0]], label: name || undefined }
        : { kind: 'path', verts, name: name || undefined },
    );
    if (routes.length >= 60) break;
  }
  return routes;
}
