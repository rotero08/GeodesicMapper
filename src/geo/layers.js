// Static geometry for the optional map layers, built once.

import { geoCircle, geoGraticule } from 'd3-geo';

export const sphere = { type: 'Sphere' };

/** Grid lines every 15 degrees. */
export const graticule = geoGraticule().step([15, 15])();

const parallel = (lat) => ({
  type: 'LineString',
  coordinates: Array.from({ length: 181 }, (_, i) => [-180 + i * 2, lat]),
});
const meridian = (lon) => ({
  type: 'LineString',
  coordinates: Array.from({ length: 91 }, (_, i) => [lon, -90 + i * 2]),
});

/** The Equator, the tropics, the polar circles and the prime meridian pair. */
export const keyLines = {
  type: 'GeometryCollection',
  geometries: [
    parallel(0),
    parallel(23.4366),
    parallel(-23.4366),
    parallel(66.5634),
    parallel(-66.5634),
    meridian(0),
    meridian(180),
  ],
};

/** Tissot's indicatrix: identical 5-degree circles whose distortion shows how a map bends the globe. */
export const tissot = (() => {
  const circles = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -150; lon <= 180; lon += 30) {
      circles.push(geoCircle().center([lon, lat]).radius(5).precision(2)());
    }
  }
  return { type: 'GeometryCollection', geometries: circles };
})();
