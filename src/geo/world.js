// Natural Earth coastlines and borders (public domain) through the `world-atlas` package.
// The coarse 1:110m set ships in the main bundle; the 1:50m set is fetched only when the
// user zooms in far enough for it to matter.

import { geoBounds, geoContains } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import coarseTopology from 'world-atlas/countries-110m.json';

/**
 * The data is cut at the antimeridian and along the bottom of Antarctica, which leaves straight
 * seam lines in an outline. Drop every segment that runs along one of those cuts.
 */
function withoutSeams(multiLine) {
  const onSeam = ([lon0, lat0], [lon1, lat1]) =>
    (Math.abs(lon0) > 179.99 && Math.abs(lon1) > 179.99 && Math.sign(lon0) === Math.sign(lon1)) ||
    (lat0 < -89.99 && lat1 < -89.99);
  const lines = [];
  for (const line of multiLine.coordinates) {
    let current = [line[0]];
    for (let i = 1; i < line.length; i++) {
      if (onSeam(line[i - 1], line[i])) {
        if (current.length > 1) lines.push(current);
        current = [line[i]];
      } else current.push(line[i]);
    }
    if (current.length > 1) lines.push(current);
  }
  return { type: 'MultiLineString', coordinates: lines };
}

/** Turns a world-atlas topology into the few shapes the renderer and the cursor need. */
export function buildWorld(topology) {
  const countries = feature(topology, topology.objects.countries).features;
  for (const country of countries) country.bounds = geoBounds(country);
  return {
    land: feature(topology, topology.objects.land),
    countries,
    // Shared borders once each (not twice, once per neighbour) and the outer coastline.
    borders: withoutSeams(mesh(topology, topology.objects.countries, (a, b) => a !== b)),
    coast: withoutSeams(mesh(topology, topology.objects.land)),
  };
}

export const coarse = buildWorld(coarseTopology);

let detailPromise = null;
/** Loads the 1:50m set once; resolves to the same object every time. */
export function loadDetail() {
  detailPromise ??= import('world-atlas/countries-50m.json').then((m) => buildWorld(m.default));
  return detailPromise;
}

const inBounds = ([[west, south], [east, north]], lon, lat) =>
  lat >= south && lat <= north && (west <= east ? lon >= west && lon <= east : lon >= west || lon <= east);

/** Name of the country containing [lon, lat], or null over open water. */
export function countryAt(world, [lon, lat]) {
  for (const country of world.countries) {
    if (inBounds(country.bounds, lon, lat) && geoContains(country, [lon, lat])) return country.properties.name;
  }
  return null;
}
