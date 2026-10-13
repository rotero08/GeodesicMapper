// Draws one frame of the map onto a canvas: sky glow, ocean, grid, land, overlays and routes.

import { geoCircle, geoPath } from 'd3-geo';
import { formatDistance, greatCircleAngle, rhumbAngle, UNITS } from '../geo/geodesy.js';
import { graticule, keyLines, sphere, tissot } from '../geo/layers.js';
import { legMidpoint, routeGeometry, routeLine } from '../geo/routes.js';
import { subsolarPoint } from '../geo/sun.js';
import { COLORS } from './theme.js';
import { Stars } from './stars.js';

const FONT = '600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export class Renderer {
  constructor(canvas, starsHost) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stars = new Stars(starsHost);
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.stars.resize(width, height, this.dpr);
  }

  /**
   * @param {object} scene
   * @param {import('../geo/projections.js').Frame} scene.frame
   * @param {object} scene.state   layers, routes, unit, selection
   * @param {object} scene.world   land, borders, coast
   * @param {object} scene.ui      transient: hover position, route being drawn, route under the pointer
   */
  render({ frame, state, world, ui }) {
    const { ctx, width, height } = this;
    const path = geoPath(frame.projection, ctx);
    const { layers } = state;
    ctx.clearRect(0, 0, width, height);
    this.stars.setVisibility(layers.stars ? 1 - frame.flat : 0);

    this.#atmosphere(frame);
    this.#ocean(path, frame);

    if (layers.graticule) this.#stroke(path, graticule, COLORS.graticule, 0.6);
    if (layers.keyLines) this.#stroke(path, keyLines, COLORS.keyLine, 1, [6, 5]);
    if (layers.countries) {
      ctx.beginPath();
      path(world.land);
      ctx.fillStyle = COLORS.land;
      ctx.fill();
      this.#stroke(path, world.borders, COLORS.border, 0.45);
      this.#stroke(path, world.coast, COLORS.coast, 0.55);
    }
    if (layers.tissot) {
      ctx.fillStyle = COLORS.tissotFill;
      ctx.strokeStyle = COLORS.tissotLine;
      ctx.lineWidth = 1;
      for (const circle of tissot.geometries) {
        ctx.beginPath();
        path(circle);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (layers.terminator) this.#terminator(path, frame);
    this.#stroke(path, sphere, COLORS.outline, 1.1);

    this.#routes(path, frame, state, ui);
  }

  #stroke(path, object, color, width, dash = []) {
    const { ctx } = this;
    ctx.beginPath();
    path(object);
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  #atmosphere(frame) {
    if (frame.glow < 0.01) return;
    const { ctx } = this;
    const { cx, cy, r } = frame.disc;
    const [red, green, blue] = COLORS.atmosphere;
    const gradient = ctx.createRadialGradient(cx, cy, r * 0.86, cx, cy, r * 1.22);
    gradient.addColorStop(0, `rgba(${red}, ${green}, ${blue}, 0)`);
    gradient.addColorStop(0.55, `rgba(${red}, ${green}, ${blue}, ${0.16 * frame.glow})`);
    gradient.addColorStop(1, 'rgba(20, 60, 90, 0)');
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.22, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  #ocean(path, frame) {
    const { ctx } = this;
    ctx.beginPath();
    path(sphere);
    ctx.fillStyle = COLORS.oceanFlat;
    ctx.fill();
    if (frame.glow > 0.02) {
      const { cx, cy, r } = frame.disc;
      const gradient = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.34, r * 0.1, cx, cy, r * 1.05);
      gradient.addColorStop(0, COLORS.oceanLight);
      gradient.addColorStop(1, COLORS.oceanDark);
      ctx.globalAlpha = frame.glow;
      ctx.beginPath();
      path(sphere);
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  #terminator(path, frame) {
    const { ctx } = this;
    const sun = subsolarPoint(new Date());
    ctx.beginPath();
    path(nightCap(sun));
    ctx.fillStyle = COLORS.night;
    ctx.fill();
    const at = frame.project(sun);
    if (at) {
      ctx.beginPath();
      ctx.arc(at[0], at[1], 4, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.sun;
      ctx.fill();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------------------------

  #routes(path, frame, state, ui) {
    const { ctx } = this;
    const labels = new LabelLayer(ctx, this.width, this.height);
    const crowded = state.routes.length > 4;

    // The route that is selected, drawn last so it sits on top.
    const ordered = [...state.routes].sort((a, b) => Number(a.id === state.selected) - Number(b.id === state.selected));

    for (const route of ordered) {
      const isSelected = route.id === state.selected;
      const isDrawing = route.id === ui.drawing;
      const isHover = route.id === ui.hoverRoute;
      const showLegs = !crowded || isSelected || isDrawing;
      if (route.kind === 'marker') {
        this.#pin(frame, route, labels, { isSelected, isHover });
        continue;
      }
      if (route.verts.length < 2) {
        this.#vertices(frame, route, { isSelected, isDrawing });
        continue;
      }
      const geometry = routeGeometry(route);

      if (isSelected || isHover) {
        ctx.beginPath();
        path({ type: 'LineString', coordinates: geometry.gc });
        ctx.strokeStyle = isSelected ? 'rgba(248, 209, 129, 0.22)' : 'rgba(248, 209, 129, 0.14)';
        ctx.lineWidth = 7;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
      if (state.layers.rhumb) {
        ctx.beginPath();
        path({ type: 'LineString', coordinates: geometry.rhumb });
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = COLORS.rust;
        ctx.lineWidth = isSelected ? 1.9 : 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      path({ type: 'LineString', coordinates: geometry.gc });
      ctx.strokeStyle = COLORS.brass;
      ctx.lineWidth = isSelected ? 2.6 : 2.1;
      ctx.lineJoin = 'round';
      ctx.stroke();

      this.#vertices(frame, route, { isSelected, isDrawing });

      if (showLegs) {
        route.verts.slice(0, -1).forEach((a, i) => {
          const b = route.verts[i + 1];
          const unit = state.unit;
          const radius = UNITS[unit].radius;
          const gc = frame.project(geometry.marks[i].gc);
          if (gc) labels.place(gc, formatDistance(greatCircleAngle(a, b) * radius, unit), COLORS.brassSoft, state.layers.rhumb ? -9 : 0);
          if (state.layers.rhumb) {
            const rh = frame.project(geometry.marks[i].rhumb);
            if (rh) labels.place(rh, formatDistance(rhumbAngle(a, b) * radius, unit), COLORS.rustSoft, 9);
          }
        });
      }
    }

    // While measuring: a dotted line from the last vertex to the pointer, with its length.
    const drawing = state.routes.find((r) => r.id === ui.drawing);
    if (drawing && ui.hoverGeo && state.tool === 'draw') {
      const last = drawing.verts[drawing.verts.length - 1];
      if (last) {
        ctx.beginPath();
        path({ type: 'LineString', coordinates: routeLine([last, ui.hoverGeo], 'gc') });
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = 'rgba(248, 209, 129, 0.75)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        const mid = frame.project(legMidpoint(last, ui.hoverGeo, 'gc'));
        if (mid) {
          labels.place(mid, formatDistance(greatCircleAngle(last, ui.hoverGeo) * UNITS[state.unit].radius, state.unit), COLORS.brassSoft, -9);
        }
      }
    }
  }

  #vertices(frame, route, { isSelected, isDrawing }) {
    const { ctx } = this;
    route.verts.forEach((vertex, i) => {
      const at = frame.project(vertex);
      if (!at) return;
      const start = i === 0;
      ctx.beginPath();
      ctx.arc(at[0], at[1], start ? 5 : 4.2, 0, Math.PI * 2);
      ctx.fillStyle = start || (isDrawing && i === route.verts.length - 1) ? COLORS.brass : COLORS.vertexFill;
      ctx.fill();
      ctx.lineWidth = isSelected ? 2.4 : 2;
      ctx.strokeStyle = COLORS.glow;
      ctx.stroke();
    });
  }

  #pin(frame, marker, labels, { isSelected, isHover }) {
    const { ctx } = this;
    const at = frame.project(marker.verts[0]);
    if (!at) return;
    const [x, y] = at;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x - 9, y - 10, x - 7.5, y - 23, x, y - 23);
    ctx.bezierCurveTo(x + 7.5, y - 23, x + 9, y - 10, x, y);
    ctx.closePath();
    ctx.fillStyle = isSelected || isHover ? COLORS.glow : COLORS.brass;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = COLORS.vertexFill;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y - 14.5, 2.7, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.vertexFill;
    ctx.fill();
    if (marker.label) labels.place([x, y - 14], marker.label, COLORS.brassSoft, -26);
  }

  /** The map as a PNG: sky, map and a one-line caption. Resolves to a Blob. */
  snapshot(caption) {
    const { width, height, dpr } = this;
    const out = document.createElement('canvas');
    out.width = Math.round(width * dpr);
    out.height = Math.round(height * dpr);
    const ctx = out.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(0, 0, width, height);
    if (Number(this.stars.host.style.opacity) > 0) {
      ctx.globalAlpha = Number(this.stars.host.style.opacity);
      this.stars.drawInto(ctx, width, height);
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(this.canvas, 0, 0, width, height);
    ctx.font = '500 12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(210, 224, 231, 0.75)';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(caption, 14, height - 14);
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  }
}

/** The half of the globe in darkness: a 90-degree circle around the point opposite the Sun. */
const nightCap = ([lon, lat]) => geoCircle().center([lon + 180, -lat]).radius(90).precision(3)();

/** Distance labels, placed so that no two overlap. */
class LabelLayer {
  constructor(ctx, width, height) {
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    this.boxes = [];
  }

  /** Draws `text` centred near `at`, nudged vertically until it is clear of earlier labels. */
  place([x, y], text, color, offset = 0) {
    const { ctx } = this;
    ctx.font = FONT;
    const w = ctx.measureText(text).width + 12;
    const h = 16;
    if (x < -w || x > this.width + w || y < -h || y > this.height + h) return;
    const top = y + offset - h / 2;
    for (const nudge of [0, 18, -18, 36, -36, 54, -54]) {
      const candidate = { x: x - w / 2, y: top + nudge, w, h };
      if (!this.boxes.some((b) => overlaps(b, candidate))) {
        this.boxes.push(candidate);
        this.#draw(candidate, text, color);
        return;
      }
    }
  }

  #draw({ x, y, w, h }, text, color) {
    const { ctx } = this;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 5);
    else ctx.rect(x, y, w, h);
    ctx.fillStyle = COLORS.pill;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
