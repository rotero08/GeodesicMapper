import { describe, expect, it } from 'vitest';
import {
  UNITS,
  boundingCap,
  compassName,
  destination,
  finalBearing,
  formatDistance,
  greatCircleAngle,
  greatCirclePoints,
  initialBearing,
  parseCoordinates,
  pathMetrics,
  rhumbAngle,
  rhumbBearing,
  rhumbPoints,
  wrapLon,
} from '../src/geo/geodesy.js';
import { subsolarPoint } from '../src/geo/sun.js';

const R = UNITS.km.radius;
const MADRID = [-3.7038, 40.4168];
const TOKYO = [139.6503, 35.6762];
const LONDON = [-0.1278, 51.5074];
const NEW_YORK = [-74.006, 40.7128];

describe('great circle', () => {
  it('a quarter of the equator is a quarter of the circumference', () => {
    expect(greatCircleAngle([0, 0], [90, 0]) * R).toBeCloseTo((Math.PI / 2) * R, 6);
  });

  it('antipodes are half the circumference apart', () => {
    expect(greatCircleAngle([10, 20], [-170, -20]) * R).toBeCloseTo(Math.PI * R, 3);
  });

  it('matches the well-known London to New York distance (about 5,570 km)', () => {
    expect(greatCircleAngle(LONDON, NEW_YORK) * R).toBeGreaterThan(5560);
    expect(greatCircleAngle(LONDON, NEW_YORK) * R).toBeLessThan(5585);
  });

  it('is symmetric and zero for the same point', () => {
    expect(greatCircleAngle(MADRID, TOKYO)).toBeCloseTo(greatCircleAngle(TOKYO, MADRID), 12);
    expect(greatCircleAngle(MADRID, MADRID)).toBe(0);
  });

  it('bearings: due east, due north, due south, due west', () => {
    expect(initialBearing([0, 0], [10, 0])).toBeCloseTo(90, 9);
    expect(initialBearing([0, 0], [0, 10])).toBeCloseTo(0, 9);
    expect(initialBearing([0, 10], [0, 0])).toBeCloseTo(180, 9);
    expect(initialBearing([10, 0], [0, 0])).toBeCloseTo(270, 9);
  });

  it('a great circle from a high latitude leaves heading towards the pole and arrives heading away', () => {
    const start = initialBearing(LONDON, NEW_YORK);
    const end = finalBearing(LONDON, NEW_YORK);
    expect(start).toBeGreaterThan(270); // north-west
    expect(start).toBeLessThan(300);
    expect(end).toBeGreaterThan(220); // arrives heading south-west
    expect(end).toBeLessThan(start);
  });

  it('interpolated points stay on the great circle and keep their endpoints', () => {
    const pts = greatCirclePoints(MADRID, TOKYO, 50);
    expect(pts).toHaveLength(51);
    expect(pts[0]).toEqual(MADRID);
    expect(pts[50]).toEqual(TOKYO);
    const total = greatCircleAngle(MADRID, TOKYO);
    for (let i = 1; i < pts.length; i++) {
      expect(greatCircleAngle(pts[i - 1], pts[i])).toBeCloseTo(total / 50, 9);
    }
  });

  it('handles exactly antipodal points without NaN', () => {
    const pts = greatCirclePoints([0, 0], [180, 0], 20);
    expect(pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    expect(greatCircleAngle(pts[10], [0, 0])).toBeCloseTo(Math.PI / 2, 6);
  });

  it('destination is the inverse of bearing and distance', () => {
    const angle = greatCircleAngle(MADRID, TOKYO);
    const [lon, lat] = destination(MADRID, initialBearing(MADRID, TOKYO), angle);
    expect(lon).toBeCloseTo(TOKYO[0], 6);
    expect(lat).toBeCloseTo(TOKYO[1], 6);
    expect(destination([0, 0], 90, Math.PI / 2)[0]).toBeCloseTo(90, 9);
  });
});

describe('rhumb line', () => {
  it('equals the great circle along the equator and along a meridian', () => {
    expect(rhumbAngle([0, 0], [50, 0])).toBeCloseTo(greatCircleAngle([0, 0], [50, 0]), 9);
    expect(rhumbAngle([20, -30], [20, 55])).toBeCloseTo(greatCircleAngle([20, -30], [20, 55]), 9);
  });

  it('along a parallel its length is cos(latitude) times the longitude difference', () => {
    const expected = Math.cos(40 * (Math.PI / 180)) * (Math.PI / 2);
    expect(rhumbAngle([0, 40], [90, 40])).toBeCloseTo(expected, 9);
    expect(rhumbBearing([0, 40], [90, 40])).toBeCloseTo(90, 9);
  });

  it('is never shorter than the great circle', () => {
    const pairs = [
      [MADRID, TOKYO],
      [LONDON, NEW_YORK],
      [[-70, -33], [151, -34]],
      [[10, 60], [-120, 55]],
    ];
    for (const [a, b] of pairs) expect(rhumbAngle(a, b)).toBeGreaterThanOrEqual(greatCircleAngle(a, b) - 1e-12);
  });

  it('takes the short way round the antimeridian', () => {
    expect(rhumbAngle([179, 10], [-179, 10])).toBeCloseTo(rhumbAngle([0, 10], [2, 10]), 9);
    expect(rhumbBearing([179, 10], [-179, 10])).toBeCloseTo(90, 9);
  });

  it('its sampled points keep a constant bearing', () => {
    const pts = rhumbPoints(LONDON, NEW_YORK, 40);
    const bearing = rhumbBearing(LONDON, NEW_YORK);
    for (let i = 1; i < pts.length; i++) {
      expect(rhumbBearing(pts[i - 1], pts[i])).toBeCloseTo(bearing, 3);
    }
    expect(pts[0]).toEqual([LONDON[0], LONDON[1]]);
  });

  it('survives the poles and identical points', () => {
    expect(Number.isFinite(rhumbAngle([0, 90], [30, 10]))).toBe(true);
    expect(rhumbAngle(MADRID, MADRID)).toBe(0);
    expect(rhumbBearing(MADRID, MADRID)).toBe(0);
  });
});

describe('pathMetrics', () => {
  it('sums legs and reports how much longer the rhumb line is', () => {
    const m = pathMetrics([LONDON, NEW_YORK, [-118.2437, 34.0522]], 'km');
    expect(m.legs).toHaveLength(2);
    expect(m.gc).toBeCloseTo(m.legs[0].gc + m.legs[1].gc, 9);
    expect(m.rh).toBeGreaterThan(m.gc);
    expect(m.extra).toBeCloseTo(m.rh / m.gc - 1, 12);
  });

  it('converts units', () => {
    const km = pathMetrics([MADRID, TOKYO], 'km').gc;
    expect(pathMetrics([MADRID, TOKYO], 'mi').gc).toBeCloseTo(km / 1.609344, 1);
    expect(pathMetrics([MADRID, TOKYO], 'nmi').gc).toBeCloseTo(km / 1.852, 1);
  });

  it('a single point has no legs', () => {
    expect(pathMetrics([MADRID])).toEqual({ legs: [], gc: 0, rh: 0, extra: 0 });
  });
});

describe('boundingCap', () => {
  it('centres between two points and spans half their distance', () => {
    const { center, radius } = boundingCap([[0, 0], [90, 0]]);
    expect(center[0]).toBeCloseTo(45, 6);
    expect(center[1]).toBeCloseTo(0, 6);
    expect(radius).toBeCloseTo(Math.PI / 4, 6);
  });
});

describe('formatting', () => {
  it('names compass points', () => {
    expect(compassName(0)).toBe('N');
    expect(compassName(90)).toBe('E');
    expect(compassName(225)).toBe('SW');
    expect(compassName(359)).toBe('N');
  });

  it('formats distances with sensible precision', () => {
    expect(formatDistance(10751.4, 'km', 'en')).toBe('10,751 km');
    expect(formatDistance(42.46, 'mi', 'en')).toBe('42.5 mi');
  });

  it('folds longitudes', () => {
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-181)).toBe(179);
    expect(wrapLon(180)).toBe(-180);
  });
});

describe('parseCoordinates', () => {
  it('reads plain decimals, with or without a comma', () => {
    expect(parseCoordinates('40.4168, -3.7038')).toEqual([-3.7038, 40.4168]);
    expect(parseCoordinates('40.4168 -3.7038')).toEqual([-3.7038, 40.4168]);
    expect(parseCoordinates('40.4168 3.7038')).toEqual([3.7038, 40.4168]);
    expect(parseCoordinates('-33.87,151.21')).toEqual([151.21, -33.87]);
  });

  it('reads hemisphere letters in either order', () => {
    expect(parseCoordinates('40.4168N 3.7038W')).toEqual([-3.7038, 40.4168]);
    expect(parseCoordinates('3.7038 W, 40.4168 N')).toEqual([-3.7038, 40.4168]);
    expect(parseCoordinates('N40.4168 W3.7038')).toEqual([-3.7038, 40.4168]);
    expect(parseCoordinates('33.87° S, 151.21° E')).toEqual([151.21, -33.87]);
  });

  it('reads degrees, minutes and seconds', () => {
    const [lon, lat] = parseCoordinates('40°26′46″N 79°58′56″W');
    expect(lat).toBeCloseTo(40.446111, 5);
    expect(lon).toBeCloseTo(-79.982222, 5);
    expect(parseCoordinates("40°30'N 3°W")[1]).toBeCloseTo(40.5, 9);
  });

  it('rejects things that are not coordinates', () => {
    for (const text of ['', 'Madrid', 'Madrid 40', '95, 10', '40', '40 N 10 N', '1 2 3', '40.4, 200.5, 7']) {
      expect(parseCoordinates(text), JSON.stringify(text)).toBeNull();
    }
  });
});

describe('subsolarPoint', () => {
  it('sits on the equator at the March equinox and the tropic at the June solstice', () => {
    const equinox = subsolarPoint(new Date('2024-03-20T03:06:00Z'));
    expect(Math.abs(equinox[1])).toBeLessThan(0.1);
    const solstice = subsolarPoint(new Date('2024-06-20T20:51:00Z'));
    expect(solstice[1]).toBeCloseTo(23.44, 1);
  });

  it('moves west by 15 degrees an hour', () => {
    const a = subsolarPoint(new Date('2024-05-01T12:00:00Z'));
    const b = subsolarPoint(new Date('2024-05-01T13:00:00Z'));
    expect(wrapLon(a[0] - b[0])).toBeCloseTo(15, 0);
  });

  it('is near Greenwich at midday UTC (within the equation of time)', () => {
    for (const day of ['2024-01-15', '2024-04-15', '2024-07-15', '2024-11-03']) {
      const lon = subsolarPoint(new Date(`${day}T12:00:00Z`))[0];
      expect(Math.abs(lon)).toBeLessThan(4.5);
    }
  });
});
