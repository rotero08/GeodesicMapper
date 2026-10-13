// Spherical geodesy on a perfect sphere. Positions are [longitude, latitude] in degrees, the
// order GeoJSON and d3 use. Arc lengths are angles in radians: multiply by a radius for a
// distance. Everything here is pure, so it can be tested without a browser.

export const RAD = Math.PI / 180;
export const DEG = 180 / Math.PI;
const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

/** Mean Earth radius, in each unit the app can show. */
export const UNITS = {
  km: { id: 'km', label: 'km', name: 'Kilometres', radius: 6371.0088 },
  mi: { id: 'mi', label: 'mi', name: 'Miles', radius: 3958.7613 },
  nmi: { id: 'nmi', label: 'nmi', name: 'Nautical miles', radius: 3440.0695 },
};

/** Longitude folded into [-180, 180). */
export const wrapLon = (lon) =>
  lon >= -180 && lon < 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180;
export const clampLat = (lat) => Math.max(-90, Math.min(90, lat));
export const normalizeBearing = (deg) => ((deg % 360) + 360) % 360;

const toCartesian = ([lon, lat]) => {
  const lambda = lon * RAD;
  const phi = lat * RAD;
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
};

const toLonLat = ([x, y, z]) => [Math.atan2(y, x) * DEG, Math.atan2(z, Math.hypot(x, y)) * DEG];

// ---------------------------------------------------------------------------------------------
// Great circle: the shortest path on the sphere.
// ---------------------------------------------------------------------------------------------

/** Angle of the shortest arc between two positions (haversine form, stable for short arcs). */
export function greatCircleAngle([lon1, lat1], [lon2, lat2]) {
  const phi1 = lat1 * RAD;
  const phi2 = lat2 * RAD;
  const a =
    Math.sin((phi2 - phi1) / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

/** Compass bearing (0 = north, clockwise) to leave `a` on the great circle towards `b`. */
export function initialBearing([lon1, lat1], [lon2, lat2]) {
  const phi1 = lat1 * RAD;
  const phi2 = lat2 * RAD;
  const dLambda = (lon2 - lon1) * RAD;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return normalizeBearing(Math.atan2(y, x) * DEG);
}

/** Compass bearing at which the great circle from `a` arrives at `b`. */
export const finalBearing = (a, b) => normalizeBearing(initialBearing(b, a) + 180);

/**
 * Points along the great circle from `a` to `b`, `n` steps (n + 1 points). Exactly antipodal
 * endpoints have no unique great circle; the path then runs over the northern side.
 */
export function greatCirclePoints(a, b, n = 64) {
  const omega = greatCircleAngle(a, b);
  if (omega < 1e-10) return Array.from({ length: n + 1 }, () => [a[0], a[1]]);

  const A = toCartesian(a);
  const out = [];
  if (Math.PI - omega < 1e-9) {
    // Any direction perpendicular to A works; choose the one that points north.
    let N = [-A[0] * A[2], -A[1] * A[2], 1 - A[2] * A[2]];
    const len = Math.hypot(...N);
    N = len < 1e-9 ? [0, 1, 0] : N.map((v) => v / len);
    for (let i = 0; i <= n; i++) {
      const angle = (i / n) * Math.PI;
      out.push(toLonLat(A.map((v, j) => v * Math.cos(angle) + N[j] * Math.sin(angle))));
    }
  } else {
    const B = toCartesian(b);
    const s = Math.sin(omega);
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const w1 = Math.sin((1 - k) * omega) / s;
      const w2 = Math.sin(k * omega) / s;
      out.push(toLonLat(A.map((v, j) => v * w1 + B[j] * w2)));
    }
  }
  out[0] = [a[0], a[1]];
  out[n] = [b[0], b[1]];
  return out;
}

/** The position `angle` radians from `from`, travelling on compass bearing `bearing`. */
export function destination([lon, lat], bearing, angle) {
  const phi1 = lat * RAD;
  const theta = bearing * RAD;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(angle) + Math.cos(phi1) * Math.sin(angle) * Math.cos(theta),
  );
  const dLambda = Math.atan2(
    Math.sin(theta) * Math.sin(angle) * Math.cos(phi1),
    Math.cos(angle) - Math.sin(phi1) * Math.sin(phi2),
  );
  return [wrapLon(lon + dLambda * DEG), phi2 * DEG];
}

// ---------------------------------------------------------------------------------------------
// Rhumb line (loxodrome): the path of constant compass bearing.
// ---------------------------------------------------------------------------------------------

// Latitudes are held just short of the poles, where the Mercator ordinate is infinite.
const POLE_LIMIT = (90 - 1e-6) * RAD;
const mercatorY = (phi) => Math.log(Math.tan(Math.PI / 4 + phi / 2));

function rhumbParts([lon1, lat1], [lon2, lat2]) {
  const phi1 = Math.max(-POLE_LIMIT, Math.min(POLE_LIMIT, lat1 * RAD));
  const phi2 = Math.max(-POLE_LIMIT, Math.min(POLE_LIMIT, lat2 * RAD));
  // The rhumb line takes the shorter way round the globe.
  let dLambda = (lon2 - lon1) * RAD;
  dLambda = ((((dLambda + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
  const dPhi = phi2 - phi1;
  const dPsi = mercatorY(phi2) - mercatorY(phi1);
  // Along a parallel dPsi is 0 and the stretch factor is just cos(latitude).
  const q = Math.abs(dPsi) > 1e-12 ? dPhi / dPsi : Math.cos(phi1);
  return { phi1, dLambda, dPhi, dPsi, q };
}

/** Length of the rhumb line between two positions, as an arc angle. */
export function rhumbAngle(a, b) {
  const { dPhi, dLambda, q } = rhumbParts(a, b);
  return Math.hypot(dPhi, q * dLambda);
}

/** The constant compass bearing of the rhumb line from `a` to `b`. */
export function rhumbBearing(a, b) {
  const { dLambda, dPsi } = rhumbParts(a, b);
  return normalizeBearing(Math.atan2(dLambda, dPsi) * DEG);
}

/** Points along the rhumb line from `a` to `b`, `n` steps (n + 1 points). */
export function rhumbPoints(a, b, n = 64) {
  const { phi1, dLambda, dPsi } = rhumbParts(a, b);
  const psi1 = mercatorY(phi1);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    const phi = 2 * Math.atan(Math.exp(psi1 + dPsi * k)) - HALF_PI;
    out.push([wrapLon(a[0] + dLambda * DEG * k), phi * DEG]);
  }
  out[0] = [wrapLon(a[0]), a[1]];
  out[n] = [wrapLon(b[0]), b[1]];
  return out;
}

/** How many samples a curve of this angular length needs to look smooth on screen. */
export const samplesFor = (angle) => Math.max(12, Math.min(720, Math.ceil(angle * DEG * 1.5)));

// ---------------------------------------------------------------------------------------------
// Whole paths
// ---------------------------------------------------------------------------------------------

/**
 * Per-leg and total figures for a path of two or more vertices, in `unit`.
 * `extra` is how much longer the rhumb line is than the great circle (0.1 = 10 % longer).
 */
export function pathMetrics(verts, unit = 'km') {
  const radius = (UNITS[unit] ?? UNITS.km).radius;
  const legs = [];
  let gc = 0;
  let rh = 0;
  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i];
    const b = verts[i + 1];
    const legGc = greatCircleAngle(a, b) * radius;
    const legRh = rhumbAngle(a, b) * radius;
    gc += legGc;
    rh += legRh;
    legs.push({
      from: a,
      to: b,
      gc: legGc,
      rh: legRh,
      extra: legGc > 1e-9 ? legRh / legGc - 1 : 0,
      bearingStart: initialBearing(a, b),
      bearingEnd: finalBearing(a, b),
      bearingRhumb: rhumbBearing(a, b),
    });
  }
  return { legs, gc, rh, extra: gc > 1e-9 ? rh / gc - 1 : 0 };
}

/** The two furthest-apart extremes of a set of positions, as a centre and an angular radius. */
export function boundingCap(points) {
  if (points.length === 0) return { center: [0, 0], radius: 0 };
  const sum = points.map(toCartesian).reduce((s, p) => s.map((v, i) => v + p[i]), [0, 0, 0]);
  const len = Math.hypot(...sum);
  const center = len < 1e-9 ? points[0] : toLonLat(sum.map((v) => v / len));
  let radius = 0;
  for (const p of points) radius = Math.max(radius, greatCircleAngle(center, p));
  return { center, radius };
}

// ---------------------------------------------------------------------------------------------
// Text <-> coordinates
// ---------------------------------------------------------------------------------------------

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** "NE", "SSW" … the 16-point compass name for a bearing. */
export const compassName = (deg) => COMPASS[Math.round(normalizeBearing(deg) / 22.5) % 16];

export const formatLat = (lat, digits = 2) => `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? 'N' : 'S'}`;
export const formatLon = (lon, digits = 2) => `${Math.abs(wrapLon(lon)).toFixed(digits)}°${wrapLon(lon) >= 0 ? 'E' : 'W'}`;
export const formatPosition = ([lon, lat], digits = 2) => `${formatLat(lat, digits)}, ${formatLon(lon, digits)}`;

/** "12,345 km" below 100 the value keeps one decimal. */
export function formatDistance(value, unit = 'km', locale) {
  const digits = value >= 100 ? 0 : 1;
  const text = value.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  return `${text} ${(UNITS[unit] ?? UNITS.km).label}`;
}

// One coordinate is degrees with optional minutes and seconds (each needs its own mark, so
// that "40.4 3.7" stays two numbers) and a hemisphere letter. The letter either leads or
// trails every coordinate, never a mix:   40.4168  -3.7  40°26'46"N  N40.4  79°58.9'W
const BODY = String.raw`(?<sign>[+-])?\s*(?<deg>\d+(?:\.\d+)?)\s*(?:°|º)?\s*(?:(?<min>\d+(?:\.\d+)?)\s*(?:'|′|’)\s*)?(?:(?<sec>\d+(?:\.\d+)?)\s*(?:"|″|”|'')\s*)?`;
const LETTER_FIRST = new RegExp(String.raw`(?<hemi>[NSEW])\s*${BODY}`, 'gi');
const LETTER_LAST = new RegExp(String.raw`${BODY}(?<hemi>[NSEW])?`, 'gi');

/**
 * Reads a pair of coordinates typed by a person: "40.4168, -3.7038", "40.4168 N 3.7038 W",
 * "40°26′46″N 79°58′56″W". Returns [lon, lat], or null when the text is not a coordinate pair.
 */
export function parseCoordinates(text) {
  const source = String(text ?? '').trim();
  if (!/\d/.test(source) || !/^[\s\d.+\-°º'′’"″”,;NSEWnsew]+$/.test(source)) return null;

  const pattern = /^[NSEW]/i.test(source) ? LETTER_FIRST : LETTER_LAST;
  const found = [...source.matchAll(pattern)];
  // Everything typed must belong to one of the two coordinates.
  if (found.length !== 2 || source.replace(pattern, ' ').replace(/[\s,;]/g, '') !== '') return null;

  const [first, second] = found.map(({ groups: g }) => {
    const hemisphere = (g.hemi ?? '').toUpperCase();
    const magnitude = Number(g.deg) + Number(g.min ?? 0) / 60 + Number(g.sec ?? 0) / 3600;
    const negative = g.sign === '-' || hemisphere === 'S' || hemisphere === 'W';
    return { value: negative ? -magnitude : magnitude, hemisphere };
  });

  const isLat = (v) => v.hemisphere === 'N' || v.hemisphere === 'S';
  const isLon = (v) => v.hemisphere === 'E' || v.hemisphere === 'W';
  let [lat, lon] = [first, second];
  if (isLon(first) || isLat(second)) [lat, lon] = [second, first];
  if (isLon(lat) || isLat(lon)) return null; // two latitudes, or two longitudes

  if (Math.abs(lat.value) > 90 || Math.abs(lon.value) > 360) return null;
  return [wrapLon(lon.value), lat.value];
}
