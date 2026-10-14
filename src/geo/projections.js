// The projection engine: a registry of map projections and the code that morphs one into another.
//
// The globe becomes a flat map by being unrolled, then reshaped:
//
//    globe (orthographic) -> the plate carree, unrolled flat -> the target map
//
// The unrolling blends the globe's raw projection with the plate carree's point by point. A sheet
// cut from a sphere needs a seam, and it is behind the view (the antimeridian), so the picture shows
// the near side first and the far side appears from the edges as the sheet opens, like paper being
// unrolled; at each moment the view reaches only as far as the picture has not yet folded back on
// itself (the "horizon"), which is what removes the ghost far hemisphere. Azimuthal targets
// (stereographic, gnomonic, ...) share the globe's round geometry and are reached directly.
//
// From the unrolled sheet every other flat map is one straight blend away (they are all drawn on
// the same cut sphere, so no seam moves), and one flat map can also turn directly into another, so
// changing the projection on a flat map does not have to fold the world up and unfold it again.
// Finally the pace of a morph is measured: `Engine.progress` tells how far along the way the picture
// has travelled on screen, which is what lets an animation move at an even speed.

import {
  geoAzimuthalEqualArea,
  geoClipAntimeridian,
  geoClipCircle,
  geoAzimuthalEqualAreaRaw,
  geoAzimuthalEquidistant,
  geoAzimuthalEquidistantRaw,
  geoEqualEarth,
  geoEqualEarthRaw,
  geoEquirectangular,
  geoEquirectangularRaw,
  geoGnomonic,
  geoGnomonicRaw,
  geoMercator,
  geoMercatorRaw,
  geoNaturalEarth1,
  geoNaturalEarth1Raw,
  geoOrthographic,
  geoOrthographicRaw,
  geoPath,
  geoProjectionMutator,
  geoStereographic,
  geoStereographicRaw,
} from 'd3-geo';
import {
  geoAitoff,
  geoAitoffRaw,
  geoEckert4,
  geoEckert4Raw,
  geoMollweide,
  geoMollweideRaw,
  geoRobinson,
  geoRobinsonRaw,
  geoSinusoidal,
  geoSinusoidalRaw,
  geoWinkel3,
  geoWinkel3Raw,
} from 'd3-geo-projection';
import { DEG, RAD, clampLat, destination, greatCircleAngle, wrapLon } from './geodesy.js';

export const GLOBE = 'orthographic';
/** The map the unrolled globe is: the plate carree, where every other flat map begins. */
export const UNROLLED = 'equirect';
/** Where on the 0..1 slider the globe has been unrolled flat, for the maps that are reached through it. */
export const UNROLLED_AT = 0.5;

// `flat` says how map-like a projection is (0 globe, 1 flat map): it fades the star field and
// the atmosphere and damps how far the view can be tilted. `clip` is the visible angle from the
// centre, in degrees. `fitLat` crops a map to a band of latitudes (Mercator's poles are infinite)
// and `cover` lets such a map grow to fill a tall window.
const REGISTRY = [
  {
    id: 'orthographic', name: 'Globe', family: 'Globe', gen: geoOrthographic, raw: geoOrthographicRaw, flat: 0, clip: 90,
    tags: ['Perspective view', 'One hemisphere'],
    blurb: 'A view of the Earth from very far away. Nothing is flattened, so it is the most honest picture, but you only ever see half of it.',
  },
  {
    id: 'stereographic', name: 'Stereographic', family: 'Azimuthal', gen: geoStereographic, raw: geoStereographicRaw, flat: 0.35, clip: 142, azimuthal: true,
    tags: ['Conformal', 'Circles stay circles'],
    blurb: 'Preserves angles and turns every circle on the sphere into a circle on the map. Popular for polar charts; area grows quickly away from the centre.',
  },
  {
    id: 'gnomonic', name: 'Gnomonic', family: 'Azimuthal', gen: geoGnomonic, raw: geoGnomonicRaw, flat: 0.45, clip: 60, azimuthal: true,
    tags: ['Great circles are straight', 'Less than a hemisphere'],
    blurb: 'Every great circle becomes a straight line, so the shortest route between two places is simply a ruler line. Distortion explodes towards the edge, and only part of a hemisphere fits.',
  },
  {
    id: 'azea', name: 'Azimuthal equal-area', family: 'Azimuthal', gen: geoAzimuthalEqualArea, raw: geoAzimuthalEqualAreaRaw, flat: 0.3, azimuthal: true,
    tags: ['Equal-area'],
    blurb: 'Keeps areas true while bending shapes towards the edge. Atlases like it for continents and hemispheres.',
  },
  {
    id: 'azeq', name: 'Azimuthal equidistant', family: 'Azimuthal', gen: geoAzimuthalEquidistant, raw: geoAzimuthalEquidistantRaw, flat: 0.3, azimuthal: true,
    tags: ['True distance from the centre'],
    blurb: 'Distances and directions measured from the centre point are true, which makes it the natural map for "how far is everything from here". The United Nations emblem uses it centred on the North Pole.',
  },
  {
    id: 'equirect', name: 'Equirectangular', family: 'Cylindrical', gen: geoEquirectangular, raw: geoEquirectangularRaw, flat: 1,
    tags: ['Plate carrée'],
    blurb: 'Longitude and latitude become x and y directly. Simple to compute and common for data grids, but it distorts both shapes and areas.',
  },
  {
    id: 'mercator', name: 'Mercator', family: 'Cylindrical', gen: geoMercator, raw: geoMercatorRaw, flat: 1, fitLat: 80, cover: 1.5,
    tags: ['Conformal', 'Rhumb lines are straight'],
    blurb: 'Preserves angles and local shapes, so a constant compass heading is a straight line, which is why sailors loved it. Area balloons towards the poles: Greenland looks as big as Africa, which is really about 14 times larger.',
  },
  {
    id: 'naturalearth', name: 'Natural Earth', family: 'Compromise', gen: geoNaturalEarth1, raw: geoNaturalEarth1Raw, flat: 1,
    tags: ['Compromise'],
    blurb: 'A balanced, good-looking map that trades a little of everything: neither conformal nor equal-area, with gently curved meridians. Designed by Tom Patterson in 2007.',
  },
  {
    id: 'equalearth', name: 'Equal Earth', family: 'Compromise', gen: geoEqualEarth, raw: geoEqualEarthRaw, flat: 1,
    tags: ['Equal-area'],
    blurb: 'Equal-area with a pleasing shape. Published in 2018 as a modern alternative to the Robinson and Mollweide projections.',
  },
  {
    id: 'robinson', name: 'Robinson', family: 'Compromise', gen: geoRobinson, raw: geoRobinsonRaw, flat: 1,
    tags: ['Compromise'],
    blurb: 'Neither conformal nor equal-area, tuned by eye to look right. Used by National Geographic from 1988 to 1998.',
  },
  {
    id: 'winkel', name: 'Winkel Tripel', family: 'Compromise', gen: geoWinkel3, raw: geoWinkel3Raw, flat: 1,
    tags: ['Compromise'],
    blurb: "Averages three older projections to keep area, direction and distance errors all small. National Geographic's world-map standard since 1998.",
  },
  {
    id: 'mollweide', name: 'Mollweide', family: 'Compromise', gen: geoMollweide, raw: geoMollweideRaw, flat: 1,
    tags: ['Equal-area'],
    blurb: 'Equal-area on a 2:1 ellipse. Shapes squash near the edges; often chosen for global thematic and sky maps.',
  },
  {
    id: 'eckert4', name: 'Eckert IV', family: 'Compromise', gen: geoEckert4, raw: geoEckert4Raw, flat: 1,
    tags: ['Equal-area'],
    blurb: 'Equal-area with elliptical meridians and poles drawn as lines half the length of the equator.',
  },
  {
    id: 'sinusoidal', name: 'Sinusoidal', family: 'Compromise', gen: geoSinusoidal, raw: geoSinusoidalRaw, flat: 1,
    tags: ['Equal-area'],
    blurb: 'Equal-area with true scale along every parallel and the central meridian. Shapes shear badly towards the edges, so it works best for regions near the centre.',
  },
  {
    id: 'aitoff', name: 'Aitoff', family: 'Compromise', gen: geoAitoff, raw: geoAitoffRaw, flat: 1,
    tags: ['Compromise'],
    blurb: 'Stretches the azimuthal equidistant map into a 2:1 ellipse. A close relative of the Hammer projection.',
  },
];

export const PROJECTIONS = REGISTRY;
export const byId = Object.fromEntries(REGISTRY.map((p) => [p.id, p]));
/** The maps you can morph the globe into (everything but the globe itself). */
export const TARGETS = REGISTRY.filter((p) => p.id !== GLOBE);
export const FAMILIES = ['Azimuthal', 'Cylindrical', 'Compromise'];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smoothstep = (x) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

const EPS = 1e-4;
const MARGIN = 2;

/** The keyframes the slider passes through on its way from the globe to `targetId`. */
export function stagesFor(targetId) {
  if (byId[targetId]?.azimuthal) return [{ a: GLOBE, b: targetId, from: 0, to: 1 }];
  if (targetId === UNROLLED) return [{ a: GLOBE, b: UNROLLED, from: 0, to: 1 }];
  return [
    { a: GLOBE, b: UNROLLED, from: 0, to: UNROLLED_AT },
    { a: UNROLLED, b: targetId, from: UNROLLED_AT, to: 1 },
  ];
}

/** True when two targets share the unrolled keyframe, so one map can morph straight into the other. */
export const sharesHub = (a, b) =>
  [a, b].every((id) => !byId[id]?.azimuthal && id !== UNROLLED);

/**
 * How far the globe has unrolled (0..1) at position `t` on the way to the flat map `targetId`, or
 * null once it is being reshaped into that map (or when the map is azimuthal and nothing unrolls).
 * Every flat map is reached through the same unrolling, so this is what two of them have in common.
 */
export function unrolledAt(targetId, t) {
  if (byId[targetId]?.azimuthal) return null;
  if (targetId === UNROLLED) return t;
  return t <= UNROLLED_AT ? t / UNROLLED_AT : null;
}

/** The position on the way to the flat map `targetId` at which the globe has unrolled by `unrolled`. */
export const positionFor = (targetId, unrolled) => (targetId === UNROLLED ? unrolled : unrolled * UNROLLED_AT);

// Raw projection functions can return infinities (Mercator at the poles, gnomonic at the
// horizon). Blending needs finite numbers, so those are replaced by a large finite stand-in.
const LIMIT = 1e3;
const finite = (v) => (Number.isNaN(v) ? LIMIT : Math.max(-LIMIT, Math.min(LIMIT, v)));
const safe = (raw) => (x, y) => {
  const p = raw(x, y);
  return [finite(p[0]), finite(p[1])];
};

// Inside a blend Mercator stops at the Web Mercator limit, so the poles flatten into a line
// instead of shooting off to infinity (which draws tall rectangular tabs mid-morph).
const MERCATOR_LIMIT = 85.0511 * RAD;
const blendRaw = (P) =>
  P.mixRaw ??
  (P.id === 'mercator'
    ? safe((x, y) => geoMercatorRaw(x, Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, y))))
    : safe(P.raw));

// ---- one map turning into another

const clipOf = (P) => P.clip ?? 180 - 1e-3;

/** A map `k` of the way from `from` to `to`: its projection, framing and crop are blends of theirs. */
function mixOf(from, to, k) {
  const rawFrom = blendRaw(from);
  const rawTo = blendRaw(to);
  const mixed = {
    id: 'mix',
    name: to.name,
    azimuthal: to.azimuthal,
    flat: lerp(from.flat, to.flat, k),
    mixRaw: (x, y) => {
      const a = rawFrom(x, y);
      const b = rawTo(x, y);
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    },
  };
  mixed.raw = mixed.mixRaw;
  if (to.azimuthal) mixed.clip = lerp(clipOf(from), clipOf(to), k);
  else if (from.fitLat || to.fitLat) mixed.fitLat = lerp(from.fitLat ?? 90, to.fitLat ?? 90, k);
  return mixed;
}

/** Distance from the centre, in raw units, of the point `c` radians away along a meridian. */
const radialOf = (raw, c) => raw(0, c)[1];

/**
 * How far from the view centre (in degrees) the blend of `A` and `B` may show before the picture
 * folds back on itself. The limit is the smaller of "grow from A's reach to B's" and the angle
 * beyond the horizon where the blended radius stops increasing, found to a hundredth of a degree
 * so that the view grows smoothly instead of in steps of a whole degree.
 */
function horizonFor(A, B, u) {
  const reachA = A.clip ?? 180;
  const reachB = B.clip ?? 180 - 1e-3;
  // A flat map has no reach of its own: what limits the view is only where the picture folds.
  const rawA = safe(A.raw);
  const rawB = safe(B.raw);
  const radius = (degrees) => lerp(radialOf(rawA, degrees * RAD), radialOf(rawB, degrees * RAD), u);
  let wanted = B.azimuthal ? lerp(reachA, reachB, u) : 180;
  if (B.azimuthal && reachB < 90) {
    // A map that shows less than a hemisphere (the gnomonic) has a radius that shoots up towards 90
    // degrees, so blending it in even a little would stretch the rim of the globe far across the
    // screen. The view shrinks at once instead, to the angle where the blend has the radius that the
    // outline is growing towards, which keeps the picture the size of the globe at first.
    const goal = lerp(radialOf(rawA, reachA * RAD), radialOf(rawB, reachB * RAD), u);
    let low = reachB;
    let high = 89.999;
    for (let i = 0; i < 40; i++) {
      const mid = (low + high) / 2;
      if (radius(mid) < goal) low = mid;
      else high = mid;
    }
    wanted = (low + high) / 2;
  }
  let previous = radius(90);
  let fold = 180;
  for (let c = 91; c <= 180; c++) {
    const r = radius(c);
    if (r < previous - 1e-9) {
      // The radius peaks between the two angles before this one: narrow it down.
      let low = c - 2;
      let high = c;
      for (let i = 0; i < 24; i++) {
        const a = low + (high - low) / 3;
        const b = high - (high - low) / 3;
        if (radius(a) < radius(b)) low = a;
        else high = b;
      }
      fold = (low + high) / 2;
      break;
    }
    previous = r;
  }
  return Math.min(wanted, fold);
}

/**
 * The least the view may reach while a sheet unrolls, in degrees. A clip circle of exactly a hemisphere
 * puts the poles of the frame on its edge, where the clipping cannot tell inside from outside, and
 * land is then drawn as a stripe down the middle of the globe. A quarter of a degree more changes
 * nothing that can be seen: the rim it lets in is a hundredth of a pixel wide.
 */
const MIN_REACH = 90.25;

/**
 * The globe `u` of the way to being unrolled into the flat map `B`: how far from the view centre it
 * can show (`reach`, in degrees) and the half width and height of its outline in raw units, which is
 * what framing it exactly needs, because its shape and size change all along. The outline is the
 * horizon circle, the seam (behind the view) wherever the horizon has reached it, and the pole lines
 * of the frame; the view is turned so its centre is at (0, 0), so none of this depends on rotation.
 */
function unrolledSheet(rawA, rawB, A, B, u) {
  const reach = Math.max(horizonFor(A, B, u), MIN_REACH);
  const limit = reach * RAD;
  let halfWidth = 0;
  let halfHeight = 0;
  const take = (lon, lat) => {
    const a = rawA(lon, lat);
    const b = rawB(lon, lat);
    halfWidth = Math.max(halfWidth, Math.abs(lerp(a[0], b[0], u)));
    halfHeight = Math.max(halfHeight, Math.abs(lerp(a[1], b[1], u)));
  };
  for (let i = 0; i < 120; i++) {
    const bearing = (2 * Math.PI * i) / 120;
    take(Math.atan2(Math.sin(bearing) * Math.sin(limit), Math.cos(limit)), Math.asin(Math.sin(limit) * Math.cos(bearing)));
  }
  for (let i = 0; i <= 90; i++) {
    const lat = Math.PI / 2 - (Math.PI * i) / 90;
    if (Math.PI - Math.abs(lat) <= limit + 1e-9) take(Math.PI, lat);
    take(-Math.PI + (2 * Math.PI * i) / 90, Math.PI / 2);
  }
  return { reach, halfWidth: Math.max(halfWidth, 1e-6), halfHeight: Math.max(halfHeight, 1e-6) };
}

/** Screen extent of a map cropped to latitudes +-`lat`, weighted from "whole canvas" to "band". */
function bandExtent(projection, lat, lon, width, height, weight) {
  const full = [[-MARGIN, -MARGIN], [width + MARGIN, height + MARGIN]];
  const a = projection([lon, lat]);
  const b = projection([lon, -lat]);
  if (!a || !b) return full;
  const top = Math.max(0, Math.min(a[1], b[1]));
  const bottom = Math.min(height, Math.max(a[1], b[1]));
  return [[-MARGIN, lerp(-MARGIN, top, weight)], [width + MARGIN, lerp(height + MARGIN, bottom, weight)]];
}

/** What to frame so the whole map (or a latitude band of it) fits: scale and translate at rotation 0. */
function computeFit(P, width, height) {
  const pad = Math.min(width, height) * 0.05;
  try {
    const g = P.gen().rotate([0, 0, 0]);
    if (P.clip) g.clipAngle(P.clip);
    let object = { type: 'Sphere' };
    if (P.fitLat) {
      const ring = [];
      for (let i = 0; i <= 64; i++) ring.push([-180 + (360 * i) / 64, P.fitLat]);
      for (let i = 0; i <= 64; i++) ring.push([180 - (360 * i) / 64, -P.fitLat]);
      ring.push([-180, P.fitLat]);
      object = { type: 'Polygon', coordinates: [ring] };
    }
    g.fitExtent([[pad, pad], [width - pad, height - pad]], object);
    if (P.cover) {
      const b = geoPath(g).bounds(object);
      const k = Math.max(1, Math.min(P.cover, (height - 2 * pad) / (b[1][1] - b[0][1])));
      g.scale(g.scale() * k).translate([width / 2, height / 2]);
    }
    return { scale: g.scale(), translate: g.translate() };
  } catch {
    return { scale: Math.min(width, height) * 0.42, translate: [width / 2, height / 2] };
  }
}

/** Newton's method on the forward projection: the position whose image is `target`. */
function solve(project, target, start) {
  let lon = start[0];
  let lat = start[1];
  const h = 0.05;
  for (let i = 0; i < 20; i++) {
    const p = project([lon, lat]);
    if (!p) return null;
    const fx = p[0] - target[0];
    const fy = p[1] - target[1];
    if (Math.hypot(fx, fy) < 0.02) return [wrapLon(lon), clampLat(lat)];

    const sign = lat < 89.9 ? 1 : -1;
    const pl = project([lon + h, lat]);
    const pp = project([lon, lat + sign * h]);
    if (!pl || !pp) return null;
    const a = (pl[0] - p[0]) / h;
    const c = (pl[1] - p[1]) / h;
    const b = (pp[0] - p[0]) / (sign * h);
    const d = (pp[1] - p[1]) / (sign * h);
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) return null;

    let dLon = -(d * fx - b * fy) / det;
    let dLat = -(-c * fx + a * fy) / det;
    const step = Math.hypot(dLon, dLat);
    if (step > 15) {
      dLon *= 15 / step;
      dLat *= 15 / step;
    }
    lon += dLon;
    lat = clampLat(lat + dLat);
  }
  return null;
}

/** One frame of the morph: a d3 projection plus everything the renderer and pointer need. */
export class Frame {
  constructor({ projection, guess, radial, flat, mapness, glow, disc, rotate, horizon, stage, u }) {
    this.projection = projection;
    this.flat = flat;
    this.mapness = mapness;
    this.glow = glow;
    this.disc = disc;
    this.rotate = rotate;
    this.horizon = horizon;
    this.stage = stage;
    this.u = u;
    this.center = [-rotate[0], -rotate[1]];
    this._guess = guess;
    this._radial = radial;
  }

  /** Is this position on the visible part of the sphere (the near side of a globe, say)? */
  visible(position) {
    return this.horizon >= 179.9 || greatCircleAngle(this.center, position) <= this.horizon * RAD + 1e-9;
  }

  /**
   * Position -> screen point, or null when it is not visible. (d3's own projection(point) has no
   * notion of the horizon: it happily places far-side points on top of the near side.)
   */
  project(position) {
    if (!this.visible(position)) return null;
    const p = this.projection(position);
    return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : null;
  }

  /**
   * Screen point -> [lon, lat], or null when the point is not on the map. While the globe unrolls
   * the picture is radially symmetric about the view centre, so it inverts exactly; other blends
   * are refined by Newton's method from the nearer keyframe's own inverse.
   */
  invert(point) {
    if (this._radial) return this._invertRadial(point);
    const start = this._guess?.invert?.(point);
    const seed = start && Number.isFinite(start[0]) && Number.isFinite(start[1]) ? start : this.center;
    // Real projections invert exactly; a blend (or a point the guess cannot place) is refined.
    const project = (p) => this.project(p);
    const found = solve(project, point, seed);
    if (found) return found;
    // Mid-morph the map can fold over itself near the antimeridian; try a few other starts.
    const [lon, lat] = this.center;
    for (const start of [this.center, [lon + 90, lat], [lon - 90, lat], [lon + 180, 0]]) {
      const again = solve(project, point, start);
      if (again) return again;
    }
    return null;
  }

  _invertRadial(point) {
    const { profile, scale, cx, cy } = this._radial;
    const dx = point[0] - cx;
    const dy = point[1] - cy;
    const rho = Math.hypot(dx, dy) / scale;
    const reach = this.horizon * RAD;
    // A point exactly on the horizon may sit a rounding error beyond it.
    if (rho > profile(reach) * (1 + 1e-6) + 1e-9) return null;
    // The profile increases from 0 out to the horizon, so a bisection finds the arc angle.
    let lo = 0;
    let hi = reach;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (profile(mid) < rho) lo = mid;
      else hi = mid;
    }
    const bearing = Math.atan2(dx, -dy) * DEG;
    return destination(this.center, bearing, (lo + hi) / 2);
  }
}

export class Engine {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.fits = {};
    this._memo = null;
    this._progress = null;
  }

  resize(width, height) {
    this.width = Math.max(20, width);
    this.height = Math.max(20, height);
    this.fits = Object.fromEntries(REGISTRY.map((P) => [P.id, computeFit(P, this.width, this.height)]));
    this._memo = null;
    this._progress = null;
  }

  /**
   * The frame for a view: { t, target, rot, zoom, pan, blend }. `t` runs 0 (globe) to 1 (target
   * map), `rot` is d3's [lambda, phi, gamma], `pan` is a screen offset used on flat maps, and
   * `blend` ({ from, k }) says that the target is still `k` of the way from the map `from`.
   */
  frame(view) {
    const mix = view.blend ? `${view.blend.from}:${view.blend.k}` : '';
    const key = `${view.t}|${view.target}|${view.rot}|${view.zoom}|${view.pan}|${mix}|${this.width}x${this.height}`;
    if (this._memo?.key === key) return this._memo.frame;
    const frame = this._build(view);
    this._memo = { key, frame };
    return frame;
  }

  /**
   * How far along the morph to `target` the picture has travelled on screen. Equal steps of
   * progress look equally fast, which `t` does not give: the unrolling covers a small slice of `t`
   * and the most change. Returns { toProgress(t), toT(progress) }, both 0..1.
   */
  progress(target) {
    const key = `${target}|${this.width}x${this.height}`;
    if (this._progress?.key === key) return this._progress.value;

    const steps = 96;
    const view = { target, rot: [-10, -15, 0], zoom: 1, pan: [0, 0], blend: null };
    const spots = [];
    for (let lat = -60; lat <= 60; lat += 30) for (let i = 0; i < 12; i++) spots.push([-175 + 30 * i, lat]);
    spots.push([0, 85], [0, -85]);
    const where = (t) => {
      const frame = this._build({ ...view, t });
      return spots.map((spot) => frame.project(spot));
    };

    const raw = [];
    let before = where(0);
    for (let i = 1; i <= steps; i++) {
      const after = where(i / steps);
      let total = 0;
      let counted = 0;
      for (let j = 0; j < spots.length; j++) {
        if (!before[j] || !after[j]) continue;
        total += Math.hypot(after[j][0] - before[j][0], after[j][1] - before[j][1]);
        counted++;
      }
      raw.push(counted ? total / counted : 0);
      before = after;
    }
    // Smooth the measurement, and never let the pace fall to zero (a still picture would take no time at all).
    const mean = raw.reduce((a, b) => a + b, 0) / steps || 1;
    const speeds = raw.map((_, i) => {
      let sum = 0;
      let n = 0;
      for (let k = Math.max(0, i - 3); k <= Math.min(steps - 1, i + 3); k++) {
        sum += raw[k];
        n++;
      }
      return Math.max(sum / n, 0.25 * mean);
    });
    const cumulative = [0];
    for (const speed of speeds) cumulative.push(cumulative[cumulative.length - 1] + speed);
    const total = cumulative[steps];
    for (let i = 0; i <= steps; i++) cumulative[i] /= total;

    const value = {
      toProgress(t) {
        const x = clamp01(t) * steps;
        const i = Math.min(steps - 1, Math.floor(x));
        return cumulative[i] + (cumulative[i + 1] - cumulative[i]) * (x - i);
      },
      toT(p) {
        const goal = clamp01(p);
        let lo = 0;
        let hi = steps;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (cumulative[mid] <= goal) lo = mid;
          else hi = mid;
        }
        const span = cumulative[lo + 1] - cumulative[lo];
        return clamp01((lo + (span > 0 ? (goal - cumulative[lo]) / span : 0)) / steps);
      },
    };
    this._progress = { key, value };
    return value;
  }

  _real(P, scale, translate, rotate, extent) {
    const projection = P.gen().scale(scale).translate(translate).rotate(rotate);
    if (P.clip) projection.clipAngle(P.clip);
    projection.clipExtent(extent);
    return projection;
  }

  _build({ t, target, rot, zoom, pan, blend = null }) {
    const { width, height } = this;
    const stages = stagesFor(target);
    const stage = stages.find((s) => t <= s.to) ?? stages[stages.length - 1];
    const u = clamp01((t - stage.from) / (stage.to - stage.from));

    // While one map is turning into another, the target is a blend of the two.
    const mixing = blend && blend.k < 1 && blend.from !== target ? blend : null;
    const resolve = (id) => (mixing && id === target ? mixOf(byId[mixing.from], byId[target], mixing.k) : byId[id]);
    const A = resolve(stage.a);
    const B = resolve(stage.b);
    const fitOf = (P) =>
      P.id === 'mix'
        ? {
            scale: lerp(this.fits[mixing.from].scale, this.fits[target].scale, mixing.k),
            translate: [0, 1].map((i) => lerp(this.fits[mixing.from].translate[i], this.fits[target].translate[i], mixing.k)),
          }
        : this.fits[P.id];
    const fa = fitOf(A);
    const fb = fitOf(B);

    const flat = lerp(A.flat, B.flat, u);
    // Tilt is damped as the map flattens, and the map can be dragged vertically instead.
    const mapness = smoothstep((flat - 0.35) / 0.45);
    const rotate = [rot[0], rot[1] * (1 - flat), rot[2]];
    const real = (P) => P.id !== 'mix';
    const atKeyframe = (u <= EPS && real(A)) || (u >= 1 - EPS && real(B));
    const rawA = atKeyframe ? null : blendRaw(A);
    const rawB = atKeyframe ? null : blendRaw(B);
    // The globe becoming a flat sheet: its outline changes shape and size all along, so frame it exactly.
    const sheet = !atKeyframe && stage.a === GLOBE && !B.azimuthal ? unrolledSheet(rawA, rawB, A, B, u) : null;

    let scale = lerp(fa.scale, fb.scale, u);
    let translate = [lerp(fa.translate[0], fb.translate[0], u), lerp(fa.translate[1], fb.translate[1], u)];
    if (sheet) {
      const pad = Math.min(width, height) * 0.05;
      scale = Math.min((width - 2 * pad) / (2 * sheet.halfWidth), (height - 2 * pad) / (2 * sheet.halfHeight));
      translate = [width / 2, height / 2];
    }
    scale *= zoom;
    translate = [translate[0] + pan[0] * mapness, translate[1] + pan[1] * mapness];
    const extent = [[-MARGIN, -MARGIN], [width + MARGIN, height + MARGIN]];
    const centerLon = -rotate[0];

    let projection;
    let guess;
    let radial = null;
    let horizon = 180;
    if (atKeyframe) {
      const P = u <= EPS ? A : B;
      projection = this._real(P, scale, translate, rotate, extent);
      if (P.fitLat) projection.clipExtent(bandExtent(projection, P.fitLat, centerLon, width, height, 1));
      horizon = P.clip ?? 180;
      guess = projection; // a real projection inverts exactly
    } else {
      projection = geoProjectionMutator((k) => (x, y) => {
        const a = rawA(x, y);
        const b = rawB(x, y);
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      })(u);
      projection.scale(scale).translate(translate).rotate(rotate);
      if (stage.a === GLOBE) {
        horizon = sheet ? sheet.reach : horizonFor(A, B, u);
        // A round picture needs only the cut at the horizon circle. A sheet also has its seam (the
        // antimeridian, behind the view), which is cut first so that land crossing it is split there.
        if (B.azimuthal) projection.clipAngle(horizon);
        else if (horizon < 179.9) projection.preclip((sink) => geoClipCircle(horizon * RAD)(geoClipAntimeridian(sink)));
        projection.clipExtent(extent);
      } else if (B.fitLat) {
        projection.clipExtent(extent);
        projection.clipExtent(bandExtent(projection, B.fitLat, centerLon, width, height, u));
      } else {
        projection.clipExtent(extent);
      }
      // Blends have no inverse of their own; the nearer real map provides a starting guess.
      const near = u < 0.5 ? A : B;
      guess = this._real(real(near) ? near : byId[target], scale, translate, rotate, extent);
      if (stage.a === GLOBE && B.azimuthal) {
        radial = {
          profile: (c) => lerp(radialOf(rawA, c), radialOf(rawB, c), u),
          scale,
          cx: translate[0],
          cy: translate[1],
        };
      }
    }

    // The globe's visible disc, for the atmosphere and the ocean shading.
    const glow = stage.a === GLOBE ? 1 - u : 0;
    let discRadius = scale;
    if (sheet) {
      discRadius = scale * Math.max(sheet.halfWidth, sheet.halfHeight);
    } else if (stage.a === GLOBE && u > EPS && u < 1 - EPS) {
      const c = horizon * RAD;
      discRadius = scale * lerp(radialOf(safe(A.raw), c), radialOf(safe(B.raw), c), u);
    } else if (u >= 1 - EPS) {
      discRadius = scale * Math.max(0.0001, radialOf(safe(B.raw), (B.clip ?? 180 - 1e-3) * RAD));
    }
    return new Frame({
      projection,
      guess,
      radial,
      flat,
      mapness,
      glow,
      disc: { cx: translate[0], cy: translate[1], r: discRadius },
      rotate,
      horizon,
      stage,
      u,
    });
  }
}
