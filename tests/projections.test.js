import { geoCircle, geoPath } from 'd3-geo';
import { describe, expect, it } from 'vitest';
import { greatCircleAngle } from '../src/geo/geodesy.js';
import { Engine, GLOBE, PROJECTIONS, TARGETS, UNROLLED_AT, byId, sharesHub, stagesFor } from '../src/geo/projections.js';

const W = 1100;
const H = 800;
const engine = new Engine();
engine.resize(W, H);

const view = (over = {}) => ({ t: 0, target: 'mercator', rot: [-12, -16, 0], zoom: 1, pan: [0, 0], ...over });

describe('registry', () => {
  it('has the globe plus fourteen target maps', () => {
    expect(PROJECTIONS).toHaveLength(15);
    expect(TARGETS).toHaveLength(14);
    expect(byId[GLOBE].name).toBe('Globe');
  });

  it('every projection explains itself', () => {
    for (const P of PROJECTIONS) {
      expect(P.blurb.length, P.id).toBeGreaterThan(40);
      expect(P.tags.length, P.id).toBeGreaterThan(0);
      expect(typeof P.gen).toBe('function');
      expect(typeof P.raw).toBe('function');
    }
  });

  it('flat maps go globe -> unrolled -> map, azimuthal ones and the plate carree straight from the globe', () => {
    expect(stagesFor('mercator').map((s) => [s.a, s.b])).toEqual([[GLOBE, 'equirect'], ['equirect', 'mercator']]);
    expect(stagesFor('mercator')[0].to).toBe(UNROLLED_AT);
    expect(stagesFor('aitoff').map((s) => [s.a, s.b])).toEqual([[GLOBE, 'equirect'], ['equirect', 'aitoff']]);
    expect(stagesFor('equirect')).toEqual([{ a: GLOBE, b: 'equirect', from: 0, to: 1 }]);
    expect(stagesFor('gnomonic')).toEqual([{ a: GLOBE, b: 'gnomonic', from: 0, to: 1 }]);
    // Every stage list covers 0..1 without gaps.
    for (const { id } of TARGETS) {
      const stages = stagesFor(id);
      expect(stages[0].from).toBe(0);
      expect(stages.at(-1).to).toBe(1);
      stages.slice(1).forEach((s, i) => expect(s.from).toBe(stages[i].to));
    }
    expect(sharesHub('mercator', 'robinson')).toBe(true);
    expect(sharesHub('mercator', 'aitoff')).toBe(true);
    expect(sharesHub('mercator', 'gnomonic')).toBe(false);
    expect(sharesHub('mercator', 'equirect')).toBe(false); // the plate carree is the unrolled sheet itself: its slider runs differently
  });
});

describe('frames', () => {
  it('the globe centres the point it is rotated to', () => {
    const f = engine.frame(view({ rot: [-30, -20, 0] }));
    const [x, y] = f.project([30, 20]);
    expect(x).toBeCloseTo(W / 2, 3);
    expect(y).toBeCloseTo(H / 2, 3);
  });

  it('hides the far side of the globe', () => {
    const f = engine.frame(view({ rot: [0, 0, 0] }));
    expect(f.project([180, 0])).toBeNull();
    expect(f.project([0, 0])).not.toBeNull();
  });

  it('memoises identical views', () => {
    expect(engine.frame(view())).toBe(engine.frame(view()));
    expect(engine.frame(view({ t: 0.2 }))).not.toBe(engine.frame(view({ t: 0.3 })));
  });

  it('the final frame is the real target projection (north up, equator horizontal)', () => {
    const f = engine.frame(view({ t: 1, target: 'equirect', rot: [0, 0, 0] }));
    const a = f.project([-90, 0]);
    const b = f.project([90, 0]);
    expect(a[1]).toBeCloseTo(b[1], 6);
    expect(b[0]).toBeGreaterThan(a[0]);
  });

  it('tilt is flattened away on a flat map', () => {
    const tilted = engine.frame(view({ t: 1, target: 'robinson', rot: [0, -50, 0] }));
    const level = engine.frame(view({ t: 1, target: 'robinson', rot: [0, 0, 0] }));
    expect(tilted.project([10, 20])[1]).toBeCloseTo(level.project([10, 20])[1], 6);
  });
});

// Every visible position must round-trip: this is what keeps clicks and the cursor readout
// honest in the middle of a morph, when no projection has an inverse of its own. At the keyframes
// and while the globe turns into a round map the inverse is exact. While a sheet is unrolling or
// being reshaped there is no closed form, so only the picture is checked: the position found must
// land back on the pixel that was asked about.
describe('picking', () => {
  const ts = [0, 0.1, 0.2, 0.3, 0.4, UNROLLED_AT, 0.55, 0.8, 1];
  const targets = TARGETS.map((p) => p.id);

  it.each(targets)('inverts %s at every stage of the morph', (target) => {
    const exact = [];
    const folded = { checked: 0, failed: 0 };
    let checked = 0;
    for (const t of ts) {
      for (const rot of [[-12, -16, 0], [40, -50, 0], [-170, 10, 0]]) {
        const f = engine.frame(view({ t, target, rot }));
        const inverseIsExact = f.u <= 1e-3 || f.u >= 1 - 1e-3 || (f.stage.a === GLOBE && byId[f.stage.b].azimuthal);
        const midSecondStage = !inverseIsExact;
        for (let lon = -170; lon <= 170; lon += 30) {
          for (let lat = -70; lat <= 70; lat += 20) {
            const p = f.project([lon, lat]);
            if (!p || p[0] < 3 || p[0] > W - 3 || p[1] < 3 || p[1] > H - 3) continue;
            checked++;
            const back = f.invert(p);
            const again = back && f.project(back);
            const onScreen = Boolean(again) && Math.hypot(again[0] - p[0], again[1] - p[1]) < 0.05;
            if (midSecondStage) {
              folded.checked++;
              if (!onScreen) folded.failed++;
              continue;
            }
            // Near the horizon of the unrolling globe a pixel spans several degrees, so position
            // is only compared where the picture is well conditioned.
            const well = greatCircleAngle(f.center, [lon, lat]) < (f.horizon - 25) * (Math.PI / 180);
            const sameSpot = Boolean(back) && greatCircleAngle(back, [lon, lat]) < 0.0005;
            if (!onScreen || (well && Math.abs(lat) < 60 && !sameSpot)) exact.push(`t=${t} rot=${rot} [${lon},${lat}] -> ${back}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(exact.slice(0, 5), `${exact.length} exact failures`).toEqual([]);
    expect(folded.failed / Math.max(1, folded.checked), `${folded.failed}/${folded.checked} mid-morph`).toBeLessThan(0.03);
  });

  it('refuses points that are not on the map', () => {
    const f = engine.frame(view({ t: 0 }));
    expect(f.invert([2, 2])).toBeNull();
    const g = engine.frame(view({ t: 1, target: 'mollweide' }));
    expect(g.invert([3, 3])).toBeNull();
  });
});

// The globe becomes a flat map by being unrolled into the plate carree first. The sheet has a seam
// behind the view, so land that crosses it must be split there rather than smeared across the map,
// the far side may only show as far as the picture has not folded back, and the picture is framed
// exactly while its shape and size change.
describe('the globe unrolling', () => {
  const pad = Math.min(W, H) * 0.05;
  const extents = (f) => {
    let halfWidth = 0;
    let halfHeight = 0;
    for (let lon = -180; lon <= 180; lon += 3) {
      for (let lat = -90; lat <= 90; lat += 3) {
        const p = f.project([lon, lat]);
        if (!p) continue;
        halfWidth = Math.max(halfWidth, Math.abs(p[0] - W / 2));
        halfHeight = Math.max(halfHeight, Math.abs(p[1] - H / 2));
      }
    }
    return [halfWidth, halfHeight];
  };

  it('is the plate carree at the end of the first stage, and the globe at its start', () => {
    const unrolled = engine.frame(view({ t: UNROLLED_AT, rot: [0, 0, 0] }));
    const plate = engine.frame(view({ t: 1, target: 'equirect', rot: [0, 0, 0] }));
    for (const spot of [[-150, 60], [0, 0], [100, -30], [179, 10]]) {
      const a = unrolled.project(spot);
      const b = plate.project(spot);
      expect(a[0]).toBeCloseTo(b[0], 6);
      expect(a[1]).toBeCloseTo(b[1], 6);
    }
    const start = engine.frame(view({ t: 0, rot: [0, 0, 0] }));
    expect(start.horizon).toBe(90);
  });

  it('reveals the far side gradually: the horizon only ever grows, from the hemisphere to the whole world', () => {
    let last = 0;
    for (let t = 0; t <= UNROLLED_AT + 1e-9; t += 0.01) {
      const { horizon } = engine.frame(view({ t, rot: [0, 0, 0] }));
      expect(horizon, `t=${t}`).toBeGreaterThanOrEqual(last - 1e-9);
      last = horizon;
    }
    expect(last).toBeGreaterThanOrEqual(179.9);
    // The point opposite the view stays hidden until the sheet has opened all the way.
    expect(engine.frame(view({ t: 0.1, rot: [0, 0, 0] })).project([180, 0])).toBeNull();
    expect(engine.frame(view({ t: UNROLLED_AT - 0.01, rot: [0, 0, 0] })).project([180, 0])).not.toBeNull();
  });

  it('keeps the picture inside the window and as large as the window allows, at every step', () => {
    for (let t = 0.02; t < UNROLLED_AT; t += 0.02) {
      const [halfWidth, halfHeight] = extents(engine.frame(view({ t, rot: [0, 0, 0] })));
      const fill = Math.max(halfWidth / (W / 2 - pad), halfHeight / (H / 2 - pad));
      expect(fill, `t=${t.toFixed(2)}`).toBeGreaterThan(0.96);
      expect(fill, `t=${t.toFixed(2)}`).toBeLessThan(1.02);
    }
  });

  it('splits land that crosses the seam instead of smearing it across the map', () => {
    // A round patch of the far north that straddles the antimeridian of the view (here the 180th meridian).
    const patch = geoCircle().center([180, 75]).radius(8)();
    for (const t of [0.2, 0.3, 0.4, 0.5]) {
      const path = geoPath(engine.frame(view({ t, rot: [0, 0, 0] })).projection)(patch);
      expect(path, `t=${t}`).toBeTruthy();
      expect(path.match(/M/g), `t=${t}`).toHaveLength(2); // one piece each side of the seam
    }
  });

  it('has no jump where the first stage ends: the step across the keyframe is no bigger than its neighbours', () => {
    const spots = [];
    for (let lon = -150; lon <= 150; lon += 30) for (let lat = -60; lat <= 60; lat += 30) spots.push([lon, lat]);
    const travel = (a, b) => {
      const fa = engine.frame(view({ t: a, rot: [0, 0, 0] }));
      const fb = engine.frame(view({ t: b, rot: [0, 0, 0] }));
      let worst = 0;
      for (const spot of spots) {
        const p = fa.project(spot);
        const q = fb.project(spot);
        if (p && q) worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1]));
      }
      return worst;
    };
    const across = travel(UNROLLED_AT - 0.002, UNROLLED_AT + 0.002);
    const around = Math.max(travel(UNROLLED_AT - 0.006, UNROLLED_AT - 0.002), travel(UNROLLED_AT + 0.002, UNROLLED_AT + 0.006));
    expect(across).toBeLessThan(around * 1.5 + 1);
  });

  it('never makes a wild leap between two frames a hundredth of the way apart', () => {
    // A picture that jumps (a map flipping, a seam moving) shows as one spot travelling far in a hundredth of t.
    const spots = [];
    for (let lon = -150; lon <= 150; lon += 30) for (let lat = -60; lat <= 60; lat += 30) spots.push([lon, lat]);
    for (const target of ['mercator', 'robinson', 'mollweide']) {
      let before = null;
      for (let t = 0; t <= 1.0001; t += 0.01) {
        const f = engine.frame(view({ t: Math.min(1, t), target, rot: [-12, -16, 0] }));
        const now = spots.map((s) => f.project(s));
        if (before) {
          now.forEach((p, i) => {
            if (p && before[i]) expect(Math.hypot(p[0] - before[i][0], p[1] - before[i][1]), `${target} t=${t.toFixed(2)} ${spots[i]}`).toBeLessThan(0.2 * W);
          });
        }
        before = now;
      }
    }
  });
});

describe('one map turning into another', () => {
  const spots = [[-60, 20], [0, 0], [40, 50], [120, -30]];
  const at = (f) => spots.map((s) => f.project(s));

  it('starts as the old map and ends as the new one', () => {
    const start = engine.frame(view({ t: 1, target: 'robinson', rot: [0, 0, 0], blend: { from: 'mollweide', k: 0 } }));
    const old = engine.frame(view({ t: 1, target: 'mollweide', rot: [0, 0, 0] }));
    const end = engine.frame(view({ t: 1, target: 'robinson', rot: [0, 0, 0], blend: { from: 'mollweide', k: 1 } }));
    const robinson = engine.frame(view({ t: 1, target: 'robinson', rot: [0, 0, 0] }));
    at(start).forEach((p, i) => {
      expect(p[0]).toBeCloseTo(at(old)[i][0], 1);
      expect(p[1]).toBeCloseTo(at(old)[i][1], 1);
    });
    at(end).forEach((p, i) => {
      expect(p[0]).toBeCloseTo(at(robinson)[i][0], 6);
      expect(p[1]).toBeCloseTo(at(robinson)[i][1], 6);
    });
  });

  it('moves steadily in between, never jumping back', () => {
    let last = null;
    let total = 0;
    for (let k = 0; k <= 1; k += 0.1) {
      const f = engine.frame(view({ t: 1, target: 'equalearth', rot: [0, 0, 0], blend: { from: 'sinusoidal', k } }));
      const here = at(f);
      if (last) total += Math.hypot(here[3][0] - last[3][0], here[3][1] - last[3][1]);
      last = here;
    }
    const direct = Math.hypot(
      at(engine.frame(view({ t: 1, target: 'equalearth', rot: [0, 0, 0] })))[3][0] - at(engine.frame(view({ t: 1, target: 'sinusoidal', rot: [0, 0, 0] })))[3][0],
      at(engine.frame(view({ t: 1, target: 'equalearth', rot: [0, 0, 0] })))[3][1] - at(engine.frame(view({ t: 1, target: 'sinusoidal', rot: [0, 0, 0] })))[3][1],
    );
    expect(total).toBeLessThan(direct * 1.2 + 1); // a point travels about the straight way, not far and back
  });

  it('works between azimuthal maps too, clip angle included', () => {
    const half = engine.frame(view({ t: 1, target: 'azeq', blend: { from: 'stereographic', k: 0.5 } }));
    expect(half.horizon).toBeCloseTo((142 + 180) / 2, 2);
    expect(half.project([-168, -16])).toBeNull(); // the point opposite the centre (12, 16) is beyond any horizon
    expect(half.project([12, 16])).not.toBeNull();
  });

  it('picking still works while it is turning', () => {
    const f = engine.frame(view({ t: 1, target: 'robinson', blend: { from: 'mercator', k: 0.5 } }));
    const p = f.project([30, 20]);
    const back = f.invert(p);
    expect(back).not.toBeNull();
    expect(greatCircleAngle(back, [30, 20])).toBeLessThan(0.001);
  });
});

// Equal steps of `t` do not look equally fast: opening the disc is a small slice of t and the
// most change. `progress` measures the picture's own travel so animations can move evenly.
describe('progress', () => {
  it.each(['mercator', 'robinson', 'stereographic', 'gnomonic', 'aitoff', 'equirect'])('is a smooth 0..1 map of the morph to %s', (target) => {
    const { toProgress, toT } = engine.progress(target);
    expect(toProgress(0)).toBe(0);
    expect(toProgress(1)).toBeCloseTo(1, 9);
    let last = -1;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const p = toProgress(Math.min(1, t));
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
      expect(toT(p)).toBeCloseTo(Math.min(1, t), 2);
    }
  });

  it('gives the unrolling a share of the progress that matches how much it changes', () => {
    const { toProgress } = engine.progress('mercator');
    // The first half of t is the unrolling and nearly all of the picture's travel; reshaping the sheet is a gentle finish.
    expect(toProgress(UNROLLED_AT)).toBeGreaterThan(0.6);
    expect(toProgress(UNROLLED_AT)).toBeLessThan(0.95);
  });

  it('really does make equal steps look equally fast', () => {
    const { toT } = engine.progress('mercator');
    const spots = [];
    for (let lon = -150; lon <= 150; lon += 30) for (let lat = -60; lat <= 60; lat += 30) spots.push([lon, lat]);
    const where = (t) => spots.map((s) => engine.frame(view({ t, rot: [-10, -15, 0] })).project(s));
    const steps = 24;
    const travelled = [];
    let before = where(0);
    for (let i = 1; i <= steps; i++) {
      const after = where(toT(i / steps));
      let total = 0;
      let n = 0;
      before.forEach((p, j) => {
        if (p && after[j]) {
          total += Math.hypot(after[j][0] - p[0], after[j][1] - p[1]);
          n++;
        }
      });
      travelled.push(n ? total / n : 0);
      before = after;
    }
    const mean = travelled.reduce((a, b) => a + b, 0) / steps;
    const worst = Math.max(...travelled);
    // With equal steps of t the busiest step is many times the mean; with equal progress it stays close.
    expect(worst / mean).toBeLessThan(2.1);
  });
});
