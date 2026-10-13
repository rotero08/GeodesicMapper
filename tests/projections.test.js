import { describe, expect, it } from 'vitest';
import { greatCircleAngle } from '../src/geo/geodesy.js';
import { DISC_AT, Engine, GLOBE, OVAL_AT, PROJECTIONS, TARGETS, byId, sharesHub, stagesFor } from '../src/geo/projections.js';

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
