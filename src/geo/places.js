// Place search over a compact gazetteer (Natural Earth populated places, loaded on demand), and
// "40.4, -3.7"-style coordinates typed straight into the same box.

import { formatPosition, parseCoordinates } from './geodesy.js';

/** Lower-case with accents removed, so "sao paulo" finds "São Paulo". */
export const fold = (text) => text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().trim();

const regionNames = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
function countryName(iso) {
  if (!iso) return '';
  try {
    return regionNames?.of(iso) ?? iso;
  } catch {
    return iso;
  }
}

/** [name, iso, lat, lon, population, isCapital] rows -> searchable records. */
export function prepare(rows) {
  return rows.map(([name, iso, lat, lon, pop, capital]) => {
    const country = countryName(iso);
    return { name, iso, lat, lon, pop, capital: Boolean(capital), key: fold(name), country, countryKey: fold(country) };
  });
}

let loading = null;
/** The gazetteer, fetched the first time it is needed. */
export function loadPlaces() {
  loading ??= import('../data/places.json').then(({ default: rows }) => prepare(rows));
  return loading;
}

/**
 * Up to `limit` matches for `query`, best first: exact name, name prefix, word prefix, anywhere
 * in the name, then capitals of a matching country. Bigger cities win ties. Coordinates typed
 * in any common notation come back as a single result.
 */
export function searchPlaces(places, query, limit = 7) {
  const q = fold(String(query ?? ''));
  if (!q) return [];

  const typed = parseCoordinates(query);
  if (typed) return [{ kind: 'coordinates', name: formatPosition(typed, 4), country: '', lon: typed[0], lat: typed[1] }];

  const scored = [];
  for (const place of places) {
    let rank;
    if (place.key === q) rank = 0;
    else if (place.key.startsWith(q)) rank = 1;
    else if (place.key.split(/[\s'’-]+/).some((word) => word.startsWith(q))) rank = 2;
    else if (place.key.includes(q)) rank = 3;
    else if (place.capital && place.countryKey.startsWith(q)) rank = 4;
    else continue;
    scored.push({ place, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || Number(b.place.capital) - Number(a.place.capital) || b.place.pop - a.place.pop);
  return scored
    .slice(0, limit)
    .map(({ place }) => ({ kind: 'place', name: place.name, country: place.country, lon: place.lon, lat: place.lat }));
}

/** "Madrid, Spain" for a place, the formatted position for typed coordinates. */
export const describePlace = (result) => (result.kind === 'place' && result.country ? `${result.name}, ${result.country}` : result.name);

/** The place whose name is exactly `name` (accents and case ignored); the biggest wins. */
export function findPlace(places, name) {
  const key = fold(name);
  return places.find((p) => p.key === key) ?? null;
}
