// The small panels floating over the map: cursor readout, selected-route summary, the Measure
// action bar, the hint line and the toast. Also the screen-reader announcements.

import { compassName, formatDistance, formatPosition, pathMetrics } from '../geo/geodesy.js';
import { $, el } from './dom.js';

export function setupOverlays(app) {
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  // Cursor
  const pos = $('#cursor-pos');
  const country = $('#cursor-country');
  app.on('hover', (hover) => {
    if (!hover) {
      pos.textContent = '— , —';
      country.textContent = '';
    } else if (!hover.geo) {
      pos.textContent = 'off the map';
      country.textContent = '';
    } else {
      pos.textContent = formatPosition(hover.geo, 2);
      country.textContent = hover.country ?? '';
    }
  });

  // Hint line, one per tool
  const hint = $('#hint');
  const map = $('#map');
  const hints = {
    rotate: touch ? 'Drag to spin · pinch to zoom' : 'Drag to spin · scroll to zoom · click a route to select it',
    draw: touch ? 'Tap the map to add points' : 'Click to add points · double-click or Enter to finish',
    marker: 'Click the map to drop a marker · drag to move the view',
    cut: 'Click a route to delete it · drag to move the view',
  };
  const renderTool = () => {
    hint.textContent = hints[app.state.tool];
    map.classList.toggle('drawing', app.state.tool !== 'rotate');
  };
  app.on('tool', renderTool);
  renderTool();

  // Action bar while a route is being drawn
  const bar = $('#actionbar');
  const count = $('#action-count');
  $('#act-finish').addEventListener('click', () => app.finishDrawing());
  $('#act-undo').addEventListener('click', () => app.undo());
  $('#act-cancel').addEventListener('click', () => app.cancelDrawing());
  const renderBar = () => {
    const route = app.drawingRoute;
    bar.hidden = !route;
    hint.hidden = Boolean(route);
    if (!route) return;
    const n = route.verts.length;
    const total = n >= 2 ? ` · ${formatDistance(pathMetrics(route.verts, app.state.unit).gc, app.state.unit)}` : '';
    count.textContent = `${n} ${n === 1 ? 'point' : 'points'}${total}`;
  };
  app.on('drawing', renderBar);
  app.on('routes', renderBar);
  app.on('unit', renderBar);

  // Summary chip for the selected route
  const summary = $('#summary');
  const renderSummary = () => {
    const { routes, selected, unit } = app.state;
    const route = routes.find((r) => r.id === selected);
    if (!route) {
      summary.hidden = true;
      return;
    }
    if (route.kind === 'marker') {
      summary.replaceChildren(el('div', { class: 'name' }, route.label || 'Marker'), el('div', { class: 'delta mono' }, formatPosition(route.verts[0], 3)));
      summary.hidden = false;
      return;
    }
    if (route.verts.length < 2) {
      summary.hidden = true;
      return;
    }
    const m = pathMetrics(route.verts, unit);
    const first = m.legs[0];
    summary.replaceChildren(
      el('div', { class: 'name' }, route.name),
      el('div', { class: 'line' }, el('span', {}, 'Great circle'), el('span', { class: 'gc mono' }, formatDistance(m.gc, unit))),
      el('div', { class: 'line' }, el('span', {}, 'Rhumb line'), el('span', { class: 'rh mono' }, formatDistance(m.rh, unit))),
      el(
        'div',
        { class: 'delta' },
        m.extra < 0.0005 ? 'Practically the same path' : `Rhumb is ${(m.extra * 100).toFixed(m.extra < 0.1 ? 1 : 0)}% longer · leaves ${first.bearingStart.toFixed(0)}° ${compassName(first.bearingStart)}`,
      ),
    );
    summary.hidden = false;
  };
  app.on('routes', renderSummary);
  app.on('unit', renderSummary);

  // Toast and live region
  const toast = $('#toast');
  let timer = 0;
  app.on('toast', (text) => {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => (toast.hidden = true), 2800);
    $('#live').textContent = text;
  });
  app.on('announce', (text) => {
    $('#live').textContent = '';
    // A change of text is what screen readers announce; the empty string first makes repeats count.
    setTimeout(() => ($('#live').textContent = text), 30);
  });

  renderBar();
  renderSummary();
}
