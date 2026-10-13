// Rebuilds src/data/places.json from Natural Earth's 1:50m populated places (public domain).
//
//   node scripts/build-places.mjs [path-or-url-to-ne_50m_populated_places_simple.geojson]
//
// Each place is stored as [name, ISO country code, latitude, longitude, population, isCapital],
// which keeps the whole file near 50 kB. It is loaded only when the search box is first used.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SOURCE =
  process.argv[2] ??
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places_simple.geojson';
const OUTPUT = fileURLToPath(new URL('../src/data/places.json', import.meta.url));

const text = /^https?:/.test(SOURCE) ? await (await fetch(SOURCE)).text() : await readFile(SOURCE, 'utf8');
const { features } = JSON.parse(text);

const places = features
  .map(({ properties: p }) => [
    p.name,
    p.iso_a2 === '-99' ? '' : p.iso_a2,
    Number(Number(p.latitude).toFixed(3)),
    Number(Number(p.longitude).toFixed(3)),
    Math.round(p.pop_max ?? 0),
    p.adm0cap ? 1 : 0,
  ])
  .sort((a, b) => b[4] - a[4]);

await writeFile(OUTPUT, JSON.stringify(places));
console.log(`${places.length} places written to ${OUTPUT}`);
