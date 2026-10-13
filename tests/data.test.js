import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../src/data/examples.js';
import { geoJSONToRoutes, routesToGeoJSON } from '../src/geo/geojson.js';
import { pathMetrics } from '../src/geo/geodesy.js';
import { fold, findPlace, loadPlaces, searchPlaces } from '../src/geo/places.js';
import { routeLine, splitAtAntimeridian } from '../src/geo/routes.js';
import { countryAt, coarse } from '../src/geo/world.js';
import { decodeState, encodeState } from '../src/app/urlstate.js';
import { createState } from '../src/app/state.js';

const places = await loadPlaces();

describe('places', () => {
  it('loads a useful gazetteer', () => {
    expect(places.length).toBeGreaterThan(1000);
    expect(places.find((p) => p.name === 'Madrid')?.country).toBe('Spain');
  });

  it('ignores accents and case', () => {
    expect(fold('São Paulo')).toBe('sao paulo');
    expect(searchPlaces(places, 'sao paulo')[0].name).toBe('São Paulo');
    expect(searchPlaces(places, 'REYKJAVIK')[0].name).toBe('Reykjavík');
  });

  it('ranks prefixes first and bigger cities before smaller ones', () => {
    const results = searchPlaces(places, 'mad');
    expect(results[0].name).toBe('Madrid');
    expect(searchPlaces(places, 'london')[0].country).toMatch(/United Kingdom/);
  });

  it('finds a country by its capital', () => {
    expect(searchPlaces(places, 'japan')[0].name).toBe('Tokyo');
  });

  it('reads coordinates typed into the box', () => {
    const [hit] = searchPlaces(places, '40.4168, -3.7038');
    expect(hit.kind).toBe('coordinates');
    expect([hit.lat, hit.lon]).toEqual([40.4168, -3.7038]);
  });

  it('returns nothing for empty or unknown queries', () => {
    expect(searchPlaces(places, '')).toEqual([]);
    expect(searchPlaces(places, 'zzzzqqq')).toEqual([]);
  });

  it('every example route resolves to real places', () => {
    for (const { from, to } of EXAMPLES) {
      expect(findPlace(places, from), from).not.toBeNull();
      expect(findPlace(places, to), to).not.toBeNull();
    }
  });
});

describe('world', () => {
  it('names the country under a point', () => {
    expect(countryAt(coarse, [2.35, 48.85])).toBe('France');
    expect(countryAt(coarse, [-3.7, 40.4])).toBe('Spain');
    expect(countryAt(coarse, [-30, 0])).toBeNull(); // open Atlantic
  });

  it('has outlines without straight seam lines along the antimeridian', () => {
    for (const line of coarse.coast.coordinates) {
      for (let i = 1; i < line.length; i++) {
        const seam = Math.abs(line[i][0]) > 179.99 && Math.abs(line[i - 1][0]) > 179.99 && Math.sign(line[i][0]) === Math.sign(line[i - 1][0]);
        expect(seam).toBe(false);
      }
    }
  });
});

describe('antimeridian splitting', () => {
  it('splits a line that crosses +180 and keeps its latitude continuous', () => {
    const parts = splitAtAntimeridian([[170, 10], [-170, 30]]);
    expect(parts).toHaveLength(2);
    expect(parts[0].at(-1)).toEqual([180, 20]);
    expect(parts[1][0]).toEqual([-180, 20]);
  });

  it('does not split lines that stay on one side', () => {
    expect(splitAtAntimeridian([[10, 0], [20, 5], [30, 8]])).toHaveLength(1);
  });

  it('a long route across the Pacific splits exactly once', () => {
    const parts = splitAtAntimeridian(routeLine([[139.7, 35.7], [-122.4, 37.8]], 'gc'));
    expect(parts).toHaveLength(2);
  });
});

describe('GeoJSON', () => {
  const routes = [
    { id: 'a', kind: 'path', name: 'Madrid to Tokyo', verts: [[-3.7038, 40.4168], [139.6503, 35.6762]] },
    { id: 'b', kind: 'marker', label: 'Home', verts: [[12.5, 41.9]] },
  ];

  it('exports routes, markers and the drawn curves', () => {
    const json = routesToGeoJSON(routes, 'km');
    const roles = json.features.map((f) => f.properties.role);
    expect(roles).toEqual(['route', 'great-circle', 'rhumb-line', 'marker']);
    const gc = json.features.find((f) => f.properties.role === 'great-circle');
    expect(gc.properties.distance_km).toBeCloseTo(pathMetrics(routes[0].verts, 'km').gc, 0);
  });

  it('round-trips through its own export without the derived curves', () => {
    const { routes: back, skipped } = geoJSONToRoutes(JSON.parse(JSON.stringify(routesToGeoJSON(routes))));
    expect(skipped).toBe(0);
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ kind: 'path', name: 'Madrid to Tokyo' });
    expect(back[0].verts[1]).toEqual([139.6503, 35.6762]);
    expect(back[1]).toMatchObject({ kind: 'marker', label: 'Home' });
  });

  it('reads plain GeoJSON from elsewhere and thins very long tracks', () => {
    const track = Array.from({ length: 1000 }, (_, i) => [i / 10, 20 + Math.sin(i / 50)]);
    const { routes: back } = geoJSONToRoutes({ type: 'Feature', geometry: { type: 'LineString', coordinates: track }, properties: {} }, { maxVertices: 100 });
    expect(back[0].verts.length).toBeLessThanOrEqual(101);
    expect(back[0].verts.at(-1)).toEqual(track.at(-1));
  });

  it('skips what it cannot use instead of throwing', () => {
    const { routes: back, skipped } = geoJSONToRoutes({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 100], [1, 2]] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
    ] });
    expect(back).toHaveLength(1);
    expect(skipped).toBe(2);
    expect(geoJSONToRoutes(null)).toEqual({ routes: [], skipped: 0 });
  });
});

describe('URL state', () => {
  it('round-trips the view, layers, unit and routes', () => {
    const state = createState();
    Object.assign(state, { target: 'robinson', t: 0.625, rot: [33.5, -20.25, 0], zoom: 2.5, pan: [10, -40], unit: 'nmi' });
    state.layers.tissot = true;
    state.layers.stars = false;
    state.routes = [
      { id: 'x', kind: 'path', name: 'A → B, with: odd ~ chars', verts: [[-3.7038, 40.4168], [139.6503, 35.6762], [-122.4194, 37.7749]] },
      { id: 'y', kind: 'marker', label: 'Café', verts: [[2.35, 48.85]] },
    ];
    const back = decodeState(`#${encodeState(state)}`);
    expect(back.target).toBe('robinson');
    expect(back.t).toBeCloseTo(0.625, 3);
    expect(back.rot).toEqual([33.5, -20.25, 0]);
    expect(back.zoom).toBe(2.5);
    expect(back.pan).toEqual([10, -40]);
    expect(back.unit).toBe('nmi');
    expect(back.layers.tissot).toBe(true);
    expect(back.layers.stars).toBe(false);
    expect(back.layers.countries).toBe(true);
    expect(back.routes[0].name).toBe('A → B, with: odd ~ chars');
    expect(back.routes[0].verts).toEqual(state.routes[0].verts);
    expect(back.routes[1]).toMatchObject({ kind: 'marker', label: 'Café' });
  });

  it('ignores garbage and clamps out-of-range numbers', () => {
    expect(decodeState('')).toEqual({});
    expect(decodeState('#p=nope&t=abc&u=furlongs&w=x:1,2,3')).toMatchObject({ t: 0 });
    const clamped = decodeState('#t=7&v=0,0,500,0,0');
    expect(clamped.t).toBe(1);
    expect(clamped.zoom).toBe(14);
    expect(decodeState('#w=:95,0,10,10').routes).toEqual([]); // latitude out of range
    expect(decodeState('#w=:10,10').routes).toEqual([]); // a path needs two vertices
  });
});
