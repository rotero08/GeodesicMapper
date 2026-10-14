// The application core: owns the state, the engine and the renderer, and every action a user can
// take. The UI modules only call these methods and listen for the events they emit.

import { DEG, boundingCap, greatCircleAngle, pathMetrics } from '../geo/geodesy.js';
import { geoJSONToRoutes, routesToGeoJSON } from '../geo/geojson.js';
import { hitTest } from '../geo/hit.js';
import { Engine, GLOBE, UNROLLED, UNROLLED_AT, byId, positionFor, unrolledAt } from '../geo/projections.js';
import { routeGeometry } from '../geo/routes.js';
import { coarse, countryAt, loadDetail } from '../geo/world.js';
import { Renderer } from '../render/renderer.js';
import { HOME, LAYERS, TOOLS, createState, newRouteId } from './state.js';
import { decodeState, encodeState } from './urlstate.js';

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 14;
/** Past this zoom the 1:50m coastlines are fetched. */
const DETAIL_ZOOM = 2.2;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, k) => a + (b - a) * k;
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
/** Gentler than easeInOut: the picture speeds up and slows down by half as much, so the middle does not rush. */
const easeInOutSine = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x);
const linear = (x) => x;
/**
 * Constant speed with a short run-up and run-down: the first and last `edge` of the time speed up
 * and slow down, and everything between moves at one pace. (A morph should look evenly fast.)
 */
const cruise = (x, edge = 0.16) => {
  const top = 1 / (1 - edge); // the speed that makes the whole path add up to 1
  if (x < edge) return (top * x * x) / (2 * edge);
  if (x > 1 - edge) return 1 - (top * (1 - x) * (1 - x)) / (2 * edge);
  return top * (x - edge / 2);
};
const wrap180 = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
/** The angle equal to `target` (mod 360) that lies nearest `current`, so a turn takes the short way. */
const nearest = (target, current) => current + wrap180(target - current);
const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Where the app opens when there is nothing in the address: a route that shows the point at once.
const STARTER = { name: 'Madrid → Tokyo', verts: [[-3.7038, 40.4168], [139.6503, 35.6762]] };

export class App {
  constructor({ stage, canvas, sky }) {
    this.stage = stage;
    this.canvas = canvas;
    this.state = createState();
    this.engine = new Engine();
    this.renderer = new Renderer(canvas, sky);
    this.world = coarse;
    this.detail = null;
    // Things the renderer needs that are not part of the saved state.
    this.ui = { hoverGeo: null, hoverRoute: null, drawing: null };
    this.interacting = false;
    this.dirty = true;
    this.listeners = new Map();
    this.anim = null;
    this.measured = 0;
    this.urlTimer = 0;
    this.lastTick = 0;
    this.interactionTimer = 0;
  }

  // ---------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }

  emit(type, payload) {
    for (const fn of this.listeners.get(type) ?? []) fn(payload, this.state);
  }

  get view() {
    const { t, target, rot, zoom, pan, blend } = this.state;
    return { t, target, rot, zoom, pan, blend };
  }

  /** The morph position by visual progress (0..1): equal steps look equally fast. */
  get progress() {
    return this.engine.width ? this.engine.progress(this.state.target).toProgress(this.state.t) : this.state.t;
  }

  frame() {
    return this.engine.frame(this.view);
  }

  invalidate() {
    this.dirty = true;
  }

  /** Something that belongs in a shared link changed. */
  changed(type) {
    this.invalidate();
    if (type) this.emit(type);
    clearTimeout(this.urlTimer);
    this.urlTimer = setTimeout(() => this.syncUrl(), 300);
  }

  syncUrl() {
    const hash = `#${encodeState(this.state)}`;
    if (typeof history !== 'undefined' && location.hash !== hash) history.replaceState(null, '', hash);
  }

  start() {
    this.resize();
    new ResizeObserver(() => this.resize()).observe(this.stage);
    const loop = (now) => {
      this.tick(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const { width, height } = this.stage.getBoundingClientRect();
    if (width < 1 || height < 1) return;
    this.renderer.resize(width, height);
    this.engine.resize(width, height);
    this.invalidate();
  }

  tick(now) {
    const dt = Math.min(0.1, (now - this.lastTick) / 1000 || 0);
    this.lastTick = now;
    const s = this.state;
    if (s.layers.spin && !this.interacting && !this.anim && !prefersReducedMotion()) {
      s.rot[0] = wrap180(s.rot[0] + 6 * dt);
      this.dirty = true;
      this.emit('spin');
    }
    if (!this.dirty || this.engine.width === 0) return;
    this.dirty = false;
    const quick = this.interacting || this.anim;
    this.renderer.render({
      frame: this.frame(),
      state: s,
      world: this.detail && !quick && s.zoom >= DETAIL_ZOOM ? this.detail : this.world,
      ui: this.ui,
    });
    if (s.zoom >= DETAIL_ZOOM && !this.detail && !this.detailRequested) {
      this.detailRequested = true;
      loadDetail()
        .then((world) => {
          this.detail = world;
          this.invalidate();
        })
        .catch(() => {
          this.detailRequested = false;
        });
    }
  }

  /** Marks the start and end of a gesture, so the cheaper coastlines are used while it lasts. */
  beginInteraction() {
    clearTimeout(this.interactionTimer);
    this.cancelAnimation();
    this.interacting = true;
  }

  endInteraction(delay = 0) {
    clearTimeout(this.interactionTimer);
    this.interactionTimer = setTimeout(() => {
      this.interacting = false;
      this.invalidate();
    }, delay);
  }

  // ---------------------------------------------------------------------------------------------
  // Animation
  // ---------------------------------------------------------------------------------------------

  cancelAnimation() {
    const wasPlaying = this.state.playing;
    clearTimeout(this.holdTimer);
    this.anim = null;
    this.state.playing = false;
    // A map that was part-way into another stays where it was heading.
    if (this.state.blend) {
      this.state.blend = null;
      this.invalidate();
    }
    if (wasPlaying) this.emit('play');
  }

  /** Runs `update(eased 0..1)` over `duration` ms; a new animation replaces the running one. */
  #animate(duration, update, done, ease = easeInOut) {
    const token = {};
    this.anim = token;
    if (duration <= 0 || prefersReducedMotion()) {
      update(1);
      this.anim = null;
      this.changed('view');
      done?.();
      return;
    }
    const start = performance.now();
    const step = (now) => {
      if (this.anim !== token) return;
      const k = clamp((now - start) / duration, 0, 1);
      update(ease(k));
      this.changed('view');
      if (k < 1) requestAnimationFrame(step);
      else {
        this.anim = null;
        done?.();
      }
    };
    requestAnimationFrame(step);
  }

  /**
   * Animates the morph position from its current value to `to`. The position is moved by visual
   * progress, not by `t` itself, so the picture keeps an even pace: the globe unrolling gets the time
   * it needs instead of flashing past.
   */
  #tween(to, duration, done) {
    const s = this.state;
    const profile = this.engine.progress(s.target);
    const from = profile.toProgress(s.t);
    const goal = profile.toProgress(to);
    const span = Math.abs(goal - from);
    this.#animate(span < 1e-3 ? 0 : duration(span), (k) => (s.t = k >= 1 ? to : profile.toT(lerp(from, goal, k))), done, cruise);
  }

  // ---------------------------------------------------------------------------------------------
  // The morph
  // ---------------------------------------------------------------------------------------------

  setT(value) {
    this.cancelAnimation();
    this.state.t = clamp(value, 0, 1);
    this.changed('view');
  }

  /** Sets the morph by visual progress, which is what the slider does. */
  setProgress(value) {
    const p = clamp(value, 0, 1);
    this.setT(this.engine.width ? this.engine.progress(this.state.target).toT(p) : p);
  }

  setTarget(id) {
    const s = this.state;
    if (id === s.target || id === GLOBE || !byId[id]) return;
    this.cancelAnimation();
    const old = s.target;
    const resting = s.t;
    const apply = (t = resting) => {
      s.target = id;
      s.t = t;
      this.changed('projection');
    };
    if (resting < 0.002) return apply();
    if (!byId[old].azimuthal && !byId[id].azimuthal) {
      // Every flat map is reached by unrolling the globe, and until it is unrolled the picture does not
      // depend on the map at all: it is carried over as it is. (Not for the plate carree itself once it
      // is complete: that is a map already, so the other map has to be made from it.)
      const unrolled = unrolledAt(old, resting);
      if (unrolled !== null) {
        if (unrolled < 1 || old !== UNROLLED) return apply(positionFor(id, unrolled));
        return this.#reshape(id);
      }
      if (id === UNROLLED) return this.#backToSheet(id, resting);
      return this.#turnInto(old, id); // two reshaped maps turn straight into each other
    }
    // Two azimuthal maps turn straight into each other.
    if (byId[old].azimuthal && byId[id].azimuthal) return this.#turnInto(old, id);
    // Otherwise fold the old map back into the globe and unfold the new one from it, in one motion.
    this.#foldInto(old, id, resting);
  }

  /** The plate carree, a finished map, becoming another flat map: the sheet is reshaped, which is the second half of the morph. */
  #reshape(id) {
    const s = this.state;
    s.target = id;
    s.t = UNROLLED_AT;
    this.emit('projection');
    this.#animate(700, (k) => (s.t = lerp(UNROLLED_AT, 1, k)), () => this.changed('projection'), easeInOutSine);
  }

  /** A flat map becoming the plate carree: it is reshaped back into the unrolled sheet, which is that map. */
  #backToSheet(id, resting) {
    const s = this.state;
    this.#animate(
      700,
      (k) => (s.t = lerp(resting, UNROLLED_AT, k)),
      () => {
        s.target = id;
        s.t = 1;
        this.changed('projection');
      },
      easeInOutSine,
    );
  }

  /** One map turning directly into another, over a single smooth motion. */
  #turnInto(from, id) {
    const s = this.state;
    s.target = id;
    s.blend = { from, k: 0 };
    this.emit('projection');
    this.#animate(
      700,
      (k) => {
        s.blend = k >= 1 ? null : { from, k };
      },
      () => this.changed('projection'),
      easeInOutSine,
    );
  }

  /**
   * Back to the globe and out to the new map without stopping: the position dips to the globe
   * and rises again along one curve that is slow at the start, at the globe and at the end.
   */
  #foldInto(old, id, resting) {
    const s = this.state;
    const before = this.engine.progress(old);
    const after = this.engine.progress(id);
    const down = before.toProgress(resting);
    const up = after.toProgress(resting);
    let switched = false;
    this.#animate(
      1150,
      (k) => {
        const dip = Math.cos(Math.PI * k) ** 2;
        if (k < 0.5) s.t = before.toT(down * dip);
        else {
          if (!switched) {
            switched = true;
            s.target = id;
            this.emit('projection');
          }
          s.t = k >= 1 ? resting : after.toT(up * dip);
        }
      },
      () => this.changed('projection'),
      linear,
    );
  }

  /** Loops globe -> map -> globe until paused, resting a moment at each end. */
  play() {
    const s = this.state;
    this.cancelAnimation();
    if (prefersReducedMotion()) {
      // No endless animation for people who asked for none: just flip between the two ends.
      s.t = s.t < 0.5 ? 1 : 0;
      this.changed('view');
      return;
    }
    s.playing = true;
    this.emit('play');
    const swing = () => {
      if (!s.playing) return;
      const goal = s.t < 0.5 ? 1 : 0;
      this.#tween(
        goal,
        (span) => 900 + 2300 * span,
        () => {
          if (!s.playing) return;
          this.holdTimer = setTimeout(swing, 650);
        },
      );
    };
    swing();
  }

  pause() {
    this.cancelAnimation();
  }

  togglePlay() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  // ---------------------------------------------------------------------------------------------
  // The view
  // ---------------------------------------------------------------------------------------------

  /** Limits panning so the map cannot be dragged completely out of the window. */
  #clampPan() {
    const s = this.state;
    const { width, height } = this.engine;
    const reach = (size) => (0.5 * Math.max(0, s.zoom - 1) + 0.35) * size;
    s.pan[0] = clamp(s.pan[0], -reach(width), reach(width));
    s.pan[1] = clamp(s.pan[1], -reach(height), reach(height));
  }

  /** Drag by (dx, dy) screen pixels: spins the globe, or slides a flat map. */
  dragBy(dx, dy) {
    const s = this.state;
    const frame = this.frame();
    const degreesPerPixel = DEG / frame.projection.scale();
    s.rot[0] = wrap180(s.rot[0] + dx * degreesPerPixel);
    s.rot[1] = wrap180(s.rot[1] - dy * degreesPerPixel * (1 - frame.mapness));
    s.pan[1] += dy * frame.mapness;
    this.#clampPan();
    this.changed('view');
  }

  /** Move the view centre by degrees (keyboard navigation). */
  rotateBy(dLon, dLat) {
    const s = this.state;
    const { mapness } = this.frame();
    this.cancelAnimation();
    s.rot[0] = wrap180(s.rot[0] - dLon);
    s.rot[1] = wrap180(s.rot[1] - dLat * (1 - mapness));
    s.pan[1] += dLat * 4 * mapness;
    this.#clampPan();
    this.changed('view');
  }

  /** Zooms by `factor`; on a flat map the point under `anchor` (screen pixels) stays put. */
  zoomBy(factor, anchor = null) {
    const s = this.state;
    this.cancelAnimation();
    const before = this.frame();
    const held = anchor && before.mapness > 0.15 ? before.invert(anchor) : null;
    s.zoom = clamp(s.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (held) {
      const after = this.frame();
      const at = after.project(held);
      if (at) {
        s.pan[0] += (anchor[0] - at[0]) / after.mapness;
        s.pan[1] += (anchor[1] - at[1]) / after.mapness;
      }
    }
    this.#clampPan();
    this.changed('view');
  }

  /** Smoothly turns the view to centre `center` ([lon, lat]) at `zoom`. */
  flyTo({ center, zoom = this.state.zoom, duration = 900 }) {
    const s = this.state;
    this.cancelAnimation();
    const goal = {
      rot: [nearest(-center[0], s.rot[0]), nearest(-center[1], s.rot[1]), 0],
      zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM),
      pan: [0, 0],
    };
    // On a flat map the height is set by sliding the map, not by tilting the globe.
    const probe = this.engine.frame({ ...this.view, rot: goal.rot, zoom: goal.zoom, pan: [0, 0] });
    if (probe.mapness > 0.05) {
      const at = probe.project(center);
      if (at) goal.pan = [(this.engine.width / 2 - at[0]) / probe.mapness, (this.engine.height / 2 - at[1]) / probe.mapness];
    }
    const from = { rot: [...s.rot], zoom: s.zoom, pan: [...s.pan] };
    this.#animate(duration, (k) => {
      s.rot = [lerp(from.rot[0], goal.rot[0], k), lerp(from.rot[1], goal.rot[1], k), 0];
      s.zoom = from.zoom * (goal.zoom / from.zoom) ** k;
      s.pan = [lerp(from.pan[0], goal.pan[0], k), lerp(from.pan[1], goal.pan[1], k)];
      this.#clampPan();
    });
  }

  resetView() {
    this.flyTo({ center: [-HOME.rot[0], -HOME.rot[1]], zoom: HOME.zoom, duration: 700 });
  }

  /**
   * Frames a route so all of it is in view. The view is turned to the route's middle first; then
   * the zoom is chosen from how far the projected curve reaches from that middle, so it works
   * for any projection and any point of the morph.
   */
  focusRoute(id) {
    const route = this.state.routes.find((r) => r.id === id);
    if (!route) return;
    const single = route.kind === 'marker' || route.verts.length < 2;
    const points = single ? route.verts : routeGeometry(route).gc;
    const cap = boundingCap(points);
    if (single) {
      this.flyTo({ center: cap.center, zoom: Math.max(this.state.zoom, 3) });
      return;
    }

    const s = this.state;
    const rot = [nearest(-cap.center[0], s.rot[0]), nearest(-cap.center[1], s.rot[1]), 0];
    const probe = this.engine.frame({ ...this.view, rot, zoom: 1, pan: [0, 0] });
    const middle = probe.project(cap.center);
    let zoom = 1;
    if (middle) {
      let reachX = 1;
      let reachY = 1;
      for (const point of points) {
        const at = probe.project(point);
        if (!at) continue;
        reachX = Math.max(reachX, Math.abs(at[0] - middle[0]));
        reachY = Math.max(reachY, Math.abs(at[1] - middle[1]));
      }
      const margin = 90;
      zoom = Math.min((this.engine.width / 2 - margin) / reachX, (this.engine.height / 2 - margin) / reachY);
      // A route longer than half the globe is partly hidden: do not zoom into the visible part.
      if (probe.mapness < 0.5 && cap.radius > 1.2) zoom = Math.min(zoom, 1.1);
    }
    this.flyTo({ center: cap.center, zoom: clamp(zoom, probe.mapness > 0.5 ? 1 : 0.8, 8) });
  }

  // ---------------------------------------------------------------------------------------------
  // Tools and routes
  // ---------------------------------------------------------------------------------------------

  setTool(tool) {
    if (!TOOLS.includes(tool) || tool === this.state.tool) return;
    if (this.state.tool === 'draw') this.finishDrawing();
    this.state.tool = tool;
    this.ui.hoverRoute = null;
    this.invalidate();
    this.emit('tool');
  }

  #route(id) {
    return this.state.routes.find((r) => r.id === id);
  }

  get drawingRoute() {
    return this.#route(this.state.drawing);
  }

  /** Measure tool: adds a vertex to the route being drawn, starting one if needed. */
  addVertex(position) {
    const s = this.state;
    let route = this.drawingRoute;
    if (!route) {
      route = { id: newRouteId(), kind: 'path', verts: [], name: `Route ${++this.measured}` };
      s.routes.push(route);
      s.drawing = route.id;
      this.ui.drawing = route.id;
    }
    const last = route.verts[route.verts.length - 1];
    if (last && greatCircleAngle(last, position) < 1e-6) return;
    route.verts.push(position);
    s.selected = route.id;
    this.changed('routes');
    this.emit('drawing');
  }

  addMarker(position, label) {
    const marker = { id: newRouteId(), kind: 'marker', verts: [position], label };
    this.state.routes.push(marker);
    this.state.selected = marker.id;
    this.changed('routes');
    this.announce(`Marker placed at ${position[1].toFixed(2)}, ${position[0].toFixed(2)}`);
    return marker;
  }

  /** Ends the route being drawn; one with a single point is not a route and is dropped. */
  finishDrawing() {
    const s = this.state;
    const route = this.drawingRoute;
    if (!route) return;
    s.drawing = null;
    this.ui.drawing = null;
    if (route.verts.length < 2) {
      s.routes = s.routes.filter((r) => r !== route);
      if (s.selected === route.id) s.selected = null;
    } else {
      const m = pathMetrics(route.verts, s.unit);
      this.announce(`${route.name}: great circle ${Math.round(m.gc).toLocaleString()} ${s.unit}, rhumb line ${Math.round(m.rh).toLocaleString()} ${s.unit}.`);
    }
    this.changed('routes');
    this.emit('drawing');
  }

  /** Removes the last point of the route being drawn, or else of the newest route. */
  undo() {
    const s = this.state;
    const route = this.drawingRoute ?? s.routes[s.routes.length - 1];
    if (!route) return;
    if (route.kind === 'marker') {
      s.routes = s.routes.filter((r) => r !== route);
    } else {
      route.verts.pop();
      if (route.verts.length === 0) {
        s.routes = s.routes.filter((r) => r !== route);
        if (s.drawing === route.id) {
          s.drawing = null;
          this.ui.drawing = null;
        }
      }
    }
    if (s.selected && !this.#route(s.selected)) s.selected = null;
    this.changed('routes');
    this.emit('drawing');
  }

  cancelDrawing() {
    const s = this.state;
    const route = this.drawingRoute;
    if (!route) return;
    s.routes = s.routes.filter((r) => r !== route);
    if (s.selected === route.id) s.selected = null;
    s.drawing = null;
    this.ui.drawing = null;
    this.changed('routes');
    this.emit('drawing');
  }

  removeRoute(id) {
    const s = this.state;
    s.routes = s.routes.filter((r) => r.id !== id);
    if (s.selected === id) s.selected = null;
    if (s.drawing === id) {
      s.drawing = null;
      this.ui.drawing = null;
    }
    this.changed('routes');
    this.emit('drawing');
  }

  clearRoutes() {
    const s = this.state;
    s.routes = [];
    s.selected = null;
    s.drawing = null;
    this.ui.drawing = null;
    this.changed('routes');
    this.emit('drawing');
  }

  select(id) {
    this.state.selected = id;
    this.invalidate();
    this.emit('routes');
  }

  /** A two-point route between named places, framed and selected. */
  drawRoute(from, to, name) {
    if (this.state.drawing) this.finishDrawing();
    const route = { id: newRouteId(), kind: 'path', verts: [from, to], name };
    this.state.routes.push(route);
    this.state.selected = route.id;
    this.changed('routes');
    this.focusRoute(route.id);
    const m = pathMetrics(route.verts, this.state.unit);
    this.announce(`${name}: great circle ${Math.round(m.gc).toLocaleString()} ${this.state.unit}, rhumb line ${Math.round(m.rh).toLocaleString()} ${this.state.unit}.`);
    return route;
  }

  /** Cut tool: deletes the route nearest the pointer. Returns whether something was cut. */
  cutAt(point) {
    const hit = hitTest(this.frame(), this.state.routes, point);
    if (!hit) return false;
    this.removeRoute(hit.id);
    this.ui.hoverRoute = null;
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Pointer feedback
  // ---------------------------------------------------------------------------------------------

  /** Where the pointer is on the map (null when it is off the map or has left). */
  setPointer(point) {
    const s = this.state;
    const previousHover = this.ui.hoverRoute;
    if (!point) {
      this.ui.hoverGeo = null;
      this.ui.hoverRoute = null;
      this.emit('hover', null);
      this.invalidate();
      return null;
    }
    const frame = this.frame();
    const geo = frame.invert(point);
    this.ui.hoverGeo = geo;
    if (!this.interacting && (s.tool === 'rotate' || s.tool === 'cut')) {
      this.ui.hoverRoute = hitTest(frame, s.routes, point)?.id ?? null;
    } else this.ui.hoverRoute = null;
    this.emit('hover', geo ? { geo, country: countryAt(this.world, geo) } : { geo: null });
    if (this.drawingRoute || previousHover !== this.ui.hoverRoute) this.invalidate();
    return geo;
  }

  // ---------------------------------------------------------------------------------------------
  // Layers, units, sharing
  // ---------------------------------------------------------------------------------------------

  toggleLayer(key) {
    if (!LAYERS.some((l) => l.key === key)) return;
    this.state.layers[key] = !this.state.layers[key];
    this.changed('layers');
  }

  setUnit(unit) {
    this.state.unit = unit;
    this.changed('unit');
  }

  announce(text) {
    this.emit('announce', text);
  }

  toast(text) {
    this.emit('toast', text);
  }

  async exportPng() {
    const s = this.state;
    const name = s.t < 0.002 ? 'Globe' : `${byId[s.target].name}${s.t < 0.998 ? ' morph' : ''}`;
    const blob = await this.renderer.snapshot(`Geodesic Mapper · ${name}`);
    download(blob, `geodesic-mapper-${s.target}.png`);
    this.toast('Image saved');
  }

  exportGeoJSON() {
    const { routes, unit } = this.state;
    if (!routes.length) {
      this.toast('Draw a route first, then export it');
      return;
    }
    const blob = new Blob([JSON.stringify(routesToGeoJSON(routes, unit), null, 2)], { type: 'application/geo+json' });
    download(blob, 'geodesic-mapper-routes.geojson');
    this.toast(`Exported ${routes.length} ${routes.length === 1 ? 'route' : 'routes'}`);
  }

  /** Adds routes from GeoJSON text. Returns how many were added. */
  importGeoJSON(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      this.toast('That file is not valid JSON');
      return 0;
    }
    const { routes, skipped } = geoJSONToRoutes(json);
    if (!routes.length) {
      this.toast('No points or lines found in that file');
      return 0;
    }
    for (const route of routes.slice(0, 60)) this.state.routes.push({ ...route, id: newRouteId(), name: route.name ?? (route.kind === 'path' ? `Route ${++this.measured}` : undefined) });
    this.state.selected = this.state.routes[this.state.routes.length - 1].id;
    this.changed('routes');
    this.focusRoute(this.state.selected);
    this.toast(`Imported ${routes.length} ${routes.length === 1 ? 'item' : 'items'}${skipped ? `, skipped ${skipped}` : ''}`);
    return routes.length;
  }

  async copyLink() {
    this.syncUrl();
    try {
      await navigator.clipboard.writeText(location.href);
      this.toast('Link copied: it reproduces this exact view');
    } catch {
      this.toast('Copy the address bar: it already holds this exact view');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Starting up
  // ---------------------------------------------------------------------------------------------

  /** Applies a shared link's hash. Returns whether it contained anything. */
  applyHash(hash) {
    const data = decodeState(hash);
    if (!Object.keys(data).length) return false;
    const s = this.state;
    this.cancelAnimation();
    if (data.target) s.target = data.target;
    if (data.t !== undefined) s.t = data.t;
    if (data.rot) {
      s.rot = data.rot;
      s.zoom = data.zoom;
      s.pan = data.pan;
    }
    if (data.unit) s.unit = data.unit;
    if (data.layers) s.layers = { ...s.layers, ...data.layers };
    if (data.routes) {
      s.routes = data.routes.map((r) => ({ ...r, id: newRouteId() }));
      s.selected = null;
      s.drawing = null;
      this.ui.drawing = null;
      this.measured = s.routes.filter((r) => /^Route \d+$/.test(r.name ?? '')).length;
    }
    this.#clampPan();
    for (const type of ['projection', 'view', 'routes', 'layers', 'unit', 'tool', 'drawing']) this.emit(type);
    this.invalidate();
    return true;
  }

  /** Opens with the link's view, or with a starter route when there is none. */
  boot(hash) {
    if (this.applyHash(hash)) return;
    const route = { id: newRouteId(), kind: 'path', ...STARTER, verts: STARTER.verts.map((v) => [...v]) };
    this.state.routes.push(route);
    this.state.selected = route.id;
    const cap = boundingCap(routeGeometry(route).gc);
    this.state.rot = [-cap.center[0], -cap.center[1], 0];
    this.state.zoom = 1;
    this.emit('routes');
    this.emit('view');
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
