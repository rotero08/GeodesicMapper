import { geoAzimuthalEquidistantRaw } from 'd3-geo';
import { geoAitoffRaw } from 'd3-geo-projection';
import { describe, expect, it } from 'vitest';
import { greatCircleAngle } from '../src/geo/geodesy.js';
import { DISC_AT, Engine, GLOBE, OVAL_AT, PROJECTIONS, TARGETS, byId, discOvalRaw, sharesHub, stagesFor } from '../src/geo/projections.js';

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

  it('flat maps go globe -> disc -> oval -> map, azimuthal ones straight from the globe', () => {
    expect(stagesFor('mercator').map((s) => [s.a, s.b])).toEqual([[GLOBE, 'azeq'], ['azeq', 'aitoff'], ['aitoff', 'mercator']]);
    expect(stagesFor('mercator')[0].to).toBe(DISC_AT);
    expect(stagesFor('mercator')[1].to).toBe(OVAL_AT);
    expect(stagesFor('aitoff').map((s) => [s.a, s.b])).toEqual([[GLOBE, 'azeq'], ['azeq', 'aitoff']]);
    expect(stagesFor('gnomonic')).toEqual([{ a: GLOBE, b: 'gnomonic', from: 0, to: 1 }]);
    // Every stage list covers 0..1 without gaps.
    for (const { id } of TARGETS) {
      const stages = stagesFor(id);
      expect(stages[0].from).toBe(0);
      expect(stages.at(-1).to).toBe(1);
      stages.slice(1).forEach((s, i) => expect(s.from).toBe(stages[i].to));
    }
    expect(sharesHub('mercator', 'robinson')).toBe(true);
    expect(sharesHub('mercator', 'gnomonic')).toBe(false);
    expect(sharesHub('mercator', 'aitoff')).toBe(false);
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
// and while the globe unrolls the inverse is exact. Between the whole-world disc and a flat map
// the blend can fold over itself near the antimeridian, so there only the picture is checked:
// the position found must land back on the pixel that was asked about.
describe('picking', () => {
  const ts = [0, 0.1, 0.2, DISC_AT, 0.4, OVAL_AT, 0.55, 0.8, 1];
  const targets = TARGETS.map((p) => p.id);

  it.each(targets)('inverts %s at every stage of the morph', (target) => {
    const exact = [];
    const folded = { checked: 0, failed: 0 };
    let checked = 0;
    for (const t of ts) {
      for (const rot of [[-12, -16, 0], [40, -50, 0], [-170, 10, 0]]) {
        const f = engine.frame(view({ t, target, rot }));
        const midSecondStage = f.stage.a !== 'orthographic' && f.u > 1e-3 && f.u < 1 - 1e-3;
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

// The disc opens into the oval through a family of projections. A straight blend of the two turned
// the rim into a diamond with notches for a moment; the family stays rounded all the way.
describe('the disc opening into the oval', () => {
  const grid = [];
  for (let x = -3.1; x <= 3.1; x += 0.31) for (let y = -1.55; y <= 1.55; y += 0.31) grid.push([x, y]);

  it('is the Aitoff oval at one end and the azimuthal equidistant disc at the other', () => {
    for (const [x, y] of grid) {
      const oval = discOvalRaw(0.5)(x, y);
      const aitoff = geoAitoffRaw(x, y);
      expect(oval[0]).toBeCloseTo(aitoff[0], 9);
      expect(oval[1]).toBeCloseTo(aitoff[1], 9);
      const disc = discOvalRaw(1)(x, y);
      const azeq = geoAzimuthalEquidistantRaw(x, y);
      expect(disc[0]).toBeCloseTo(azeq[0], 9);
      expect(disc[1]).toBeCloseTo(azeq[1], 9);
    }
  });

  const edge = [];
  for (let lat = -85; lat <= 85; lat += 5) edge.push([179.9, lat], [-179.9, lat]);
  edge.push([0, 89.9], [0, -89.9]);

  it('keeps the whole outline of the world on the screen at every step', () => {
    for (let t = DISC_AT + 0.004; t < OVAL_AT; t += 0.01) {
      const f = engine.frame(view({ t, rot: [0, 0, 0] }));
      for (const point of edge) {
        const p = f.project(point);
        expect(p, `t=${t} ${point}`).not.toBeNull();
        expect(p[0]).toBeGreaterThan(-2);
        expect(p[0]).toBeLessThan(W + 2);
        expect(p[1]).toBeGreaterThan(-2);
        expect(p[1]).toBeLessThan(H + 2);
      }
    }
  });

  it('has no jump where the stage begins or ends: the step across a keyframe is no bigger than its neighbours', () => {
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
    for (const at of [DISC_AT, OVAL_AT]) {
      const across = travel(at - 0.002, at + 0.002);
      const around = Math.max(travel(at - 0.006, at - 0.002), travel(at + 0.002, at + 0.006));
      expect(across, `at ${at}`).toBeLessThan(around * 1.5 + 1);
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

  it('gives the disc opening into the oval a share that matches how much it changes', () => {
    const { toProgress } = engine.progress('mercator');
    const share = toProgress(OVAL_AT) - toProgress(DISC_AT);
    expect(share).toBeGreaterThan(0.2); // it is a fifth of t, and far more of the picture
    expect(toProgress(1) - toProgress(OVAL_AT)).toBeLessThan(0.3); // the last half of t is a gentle finish
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
