// The projection engine: a registry of map projections and the code that morphs one into another.
//
// The morph runs through up to four keyframes. Every flat map is reached from the globe through
// two whole-world pictures, because those are where the far side of the Earth is visible without
// overlapping the near side:
//
//    globe (orthographic) -> disc (azimuthal equidistant) -> oval (Aitoff) -> target map
//
// The disc is cut open along the antimeridian and its halves slide apart into the oval, which is
// already close to every flat map. Azimuthal targets (stereographic, gnomonic, ...) share the
// globe's geometry and are reached directly. Between keyframes the raw projection functions are
// blended point by point. While the globe is unrolling, a horizon limits the picture to the part
// of the sphere that has not yet folded back on itself, which is what removes the "ghost" far
// hemisphere.

import {
  geoAzimuthalEqualArea,
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
const DISC = 'azeq';
const OVAL = 'aitoff';
/** Where on the 0..1 slider the whole-world disc and the oval sit, for flat maps. */
export const DISC_AT = 0.3;
export const OVAL_AT = 0.5;

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
  if (targetId === OVAL) {
    return [
      { a: GLOBE, b: DISC, from: 0, to: 0.4 },
      { a: DISC, b: OVAL, from: 0.4, to: 1 },
    ];
  }
  return [
    { a: GLOBE, b: DISC, from: 0, to: DISC_AT },
    { a: DISC, b: OVAL, from: DISC_AT, to: OVAL_AT },
    { a: OVAL, b: targetId, from: OVAL_AT, to: 1 },
  ];
}

/** True when two targets share the oval keyframe, so one map can morph straight into the other. */
export const sharesHub = (a, b) =>
  [a, b].every((id) => !byId[id]?.azimuthal && id !== OVAL);

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
  P.id === 'mercator'
    ? safe((x, y) => geoMercatorRaw(x, Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, y))))
    : safe(P.raw);

/** Distance from the centre, in raw units, of the point `c` radians away along a meridian. */
const radialOf = (raw, c) => raw(0, c)[1];

/**
 * How far from the view centre (in degrees) the blend of `A` and `B` may show before the picture
 * folds back on itself. The limit is the smaller of "grow from A's reach to B's" and the first
 * angle beyond the horizon where the blended radius stops increasing.
 */
function horizonFor(A, B, u) {
  const reachA = A.clip ?? 180;
  const reachB = B.clip ?? 180 - 1e-3;
  const wanted = lerp(reachA, reachB, u);
  const rawA = safe(A.raw);
  const rawB = safe(B.raw);
  let previous = lerp(radialOf(rawA, 90 * RAD), radialOf(rawB, 90 * RAD), u);
  let fold = 180;
  for (let c = 91; c <= 180; c++) {
    const r = lerp(radialOf(rawA, c * RAD), radialOf(rawB, c * RAD), u);
    if (r < previous - 1e-9) {
      fold = c - 1;
      break;
    }
    previous = r;
  }
  return Math.min(wanted, fold);
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
  }

  resize(width, height) {
    this.width = Math.max(20, width);
    this.height = Math.max(20, height);
    this.fits = Object.fromEntries(REGISTRY.map((P) => [P.id, computeFit(P, this.width, this.height)]));
    this._memo = null;
  }

  /**
   * The frame for a view: { t, target, rot, zoom, pan }. `t` runs 0 (globe) to 1 (target map),
   * `rot` is d3's [lambda, phi, gamma], `pan` is a screen offset used on flat maps.
   */
  frame(view) {
    const key = `${view.t}|${view.target}|${view.rot}|${view.zoom}|${view.pan}|${this.width}x${this.height}`;
    if (this._memo?.key === key) return this._memo.frame;
    const frame = this._build(view);
    this._memo = { key, frame };
    return frame;
  }

  _real(P, scale, translate, rotate, extent) {
    const projection = P.gen().scale(scale).translate(translate).rotate(rotate);
    if (P.clip) projection.clipAngle(P.clip);
    projection.clipExtent(extent);
    return projection;
  }

  _build({ t, target, rot, zoom, pan }) {
    const { width, height } = this;
    const stages = stagesFor(target);
    const stage = stages.find((s) => t <= s.to) ?? stages[stages.length - 1];
    const u = clamp01((t - stage.from) / (stage.to - stage.from));
    const A = byId[stage.a];
    const B = byId[stage.b];
    const fa = this.fits[A.id];
    const fb = this.fits[B.id];

    const flat = lerp(A.flat, B.flat, u);
    // Tilt is damped as the map flattens, and the map can be dragged vertically instead.
    const mapness = smoothstep((flat - 0.35) / 0.45);
    const rotate = [rot[0], rot[1] * (1 - flat), rot[2]];
    const scale = lerp(fa.scale, fb.scale, u) * zoom;
    const translate = [
      lerp(fa.translate[0], fb.translate[0], u) + pan[0] * mapness,
      lerp(fa.translate[1], fb.translate[1], u) + pan[1] * mapness,
    ];
    const extent = [[-MARGIN, -MARGIN], [width + MARGIN, height + MARGIN]];
    const centerLon = -rotate[0];

    let projection;
    let guess;
    let radial = null;
    let horizon = 180;
    if (u <= EPS || u >= 1 - EPS) {
      const P = u <= EPS ? A : B;
      projection = this._real(P, scale, translate, rotate, extent);
      if (P.fitLat) projection.clipExtent(bandExtent(projection, P.fitLat, centerLon, width, height, 1));
      horizon = P.clip ?? 180;
      guess = projection; // a real projection inverts exactly
    } else {
      const rawA = blendRaw(A);
      const rawB = blendRaw(B);
      projection = geoProjectionMutator((k) => (x, y) => {
        const a = rawA(x, y);
        const b = rawB(x, y);
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      })(u);
      projection.scale(scale).translate(translate).rotate(rotate);
      if (A.id === GLOBE) {
        horizon = horizonFor(A, B, u);
        projection.clipAngle(horizon);
        projection.clipExtent(extent);
      } else if (B.fitLat) {
        projection.clipExtent(extent);
        projection.clipExtent(bandExtent(projection, B.fitLat, centerLon, width, height, u));
      } else {
        projection.clipExtent(extent);
      }
      // Blends have no inverse of their own; the nearer keyframe provides a starting guess.
      guess = this._real(u < 0.5 ? A : B, scale, translate, rotate, extent);
      if (A.id === GLOBE) {
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
    if (stage.a === GLOBE && u > EPS && u < 1 - EPS) {
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
