import { DEG, RAD, wrapLon } from './geodesy.js';

/**
 * Where the Sun is directly overhead at `date`, as [longitude, latitude] in degrees.
 * The low-precision formulae of the Astronomical Almanac: good to about 0.01 degrees, far
 * better than a map on a screen can show, and they include the equation of time.
 */
export function subsolarPoint(date = new Date()) {
  const julian = date.getTime() / 86400000 + 2440587.5;
  const n = julian - 2451545.0; // days since J2000.0

  const meanLongitude = (280.46 + 0.9856474 * n) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD;
  const obliquity = (23.439 - 0.0000004 * n) * RAD;

  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));

  // Greenwich mean sidereal time, in hours.
  const gmst = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
  return [wrapLon(rightAscension * DEG - gmst * 15), declination * DEG];
}
