// Wires the side panel: projection and morph, routes (search, examples, the list), tools,
// layers, units and sharing. Static markup lives in index.html; this fills in the rest.

import { EXAMPLES } from '../data/examples.js';
import { LAYERS } from '../app/state.js';
import {
  UNITS,
  compassName,
  formatDistance,
  formatPosition,
  pathMetrics,
} from '../geo/geodesy.js';
import { describePlace, findPlace, loadPlaces, searchPlaces } from '../geo/places.js';
import { FAMILIES, TARGETS, byId } from '../geo/projections.js';
import { createCombobox } from './combobox.js';
import { $, $$, ICONS, el, icon } from './dom.js';

export function setupPanel(app) {
  setupProjection(app);
  setupTools(app);
  setupLayers(app);
  setupUnits(app);
  setupSharing(app);
  setupRoutes(app);
}

// -------------------------------------------------------------------------------------------------
// Projection and morph
// -------------------------------------------------------------------------------------------------

function setupProjection(app) {
  const select = $('#projsel');
  for (const family of FAMILIES) {
    const group = el('optgroup', { label: family });
    for (const p of TARGETS.filter((t) => t.family === family)) group.append(el('option', { value: p.id }, p.name));
    select.append(group);
  }
  select.addEventListener('change', () => app.setTarget(select.value));

  const slider = $('#t');
  slider.addEventListener('input', () => app.setT(Number(slider.value)));

  const play = $('#play');
  play.addEventListener('click', () => app.togglePlay());
  $('#reset').addEventListener('click', () => app.resetView());

  const renderProjection = () => {
    const p = byId[app.state.target];
    select.value = p.id;
    $('#t-to').textContent = p.name;
    $('#projtags').replaceChildren(...[p.family, ...p.tags].map((tag) => el('li', {}, tag)));
    $('#projblurb').textContent = p.blurb;
  };
  const renderSlider = () => {
    slider.value = String(app.state.t);
    slider.style.setProperty('--fill', `${app.state.t * 100}%`);
    slider.setAttribute('aria-valuetext', app.state.t < 0.01 ? 'Globe' : app.state.t > 0.99 ? byId[app.state.target].name : `${Math.round(app.state.t * 100)} percent towards ${byId[app.state.target].name}`);
  };
  const renderPlay = () => {
    const playing = app.state.playing;
    play.replaceChildren(icon(playing ? ICONS.pause : ICONS.play, { fill: true }), el('span', {}, playing ? 'Pause' : 'Play morph'));
    play.setAttribute('aria-pressed', String(playing));
  };

  app.on('projection', renderProjection);
  app.on('view', renderSlider);
  app.on('play', renderPlay);
  renderProjection();
  renderSlider();
  renderPlay();
}

// -------------------------------------------------------------------------------------------------
// Tools, layers, units, sharing
// -------------------------------------------------------------------------------------------------

function setupTools(app) {
  const buttons = $$('[data-tool]');
  for (const button of buttons) button.addEventListener('click', () => app.setTool(button.dataset.tool));
  const render = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === app.state.tool)));
  app.on('tool', render);
  render();
  $('#erase').addEventListener('click', () => app.clearRoutes());
}

function setupLayers(app) {
  const host = $('#layers');
  const toggles = LAYERS.map((layer) => {
    const button = el(
      'button',
      { class: 'tg', type: 'button', role: 'switch', 'aria-checked': 'false', dataset: { key: layer.key }, onclick: () => app.toggleLayer(layer.key) },
      el('div', {}, el('span', {}, layer.label), el('small', {}, layer.hint)),
      el('i', { class: 'sw' }),
    );
    host.append(button);
    return button;
  });
  const render = () => toggles.forEach((button) => button.setAttribute('aria-checked', String(app.state.layers[button.dataset.key])));
  app.on('layers', render);
  render();
}

function setupUnits(app) {
  const host = $('#units');
  const buttons = Object.values(UNITS).map((unit) => {
    const button = el('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', dataset: { unit: unit.id }, onclick: () => app.setUnit(unit.id) }, unit.name);
    host.append(button);
    return button;
  });
  const render = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === app.state.unit)));
  app.on('unit', render);
  render();
}

function setupSharing(app) {
  $('#share').addEventListener('click', () => app.copyLink());
  $('#png').addEventListener('click', () => app.exportPng());
  $('#geojson').addEventListener('click', () => app.exportGeoJSON());
  const file = $('#importfile');
  $('#import').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const [chosen] = file.files;
    file.value = '';
    if (chosen) app.importGeoJSON(await chosen.text());
  });
  // Dropping a GeoJSON file anywhere on the map imports it too.
  app.stage.addEventListener('dragover', (event) => event.preventDefault());
  app.stage.addEventListener('drop', async (event) => {
    event.preventDefault();
    const [chosen] = event.dataTransfer?.files ?? [];
    if (chosen) app.importGeoJSON(await chosen.text());
  });
}

// -------------------------------------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------------------------------------

function setupRoutes(app) {
  const picked = { from: null, to: null };
  // The place index is a separate download; if it cannot be fetched, search simply finds nothing.
  const places = async () => {
    try {
      return await loadPlaces();
    } catch {
      app.toast('The place list could not be loaded. Type coordinates instead.');
      return [];
    }
  };
  const search = async (query) => searchPlaces(await places(), query);

  for (const which of ['from', 'to']) {
    createCombobox({
      input: $(`#${which}`),
      list: $(`#${which}-list`),
      search,
      label: describePlace,
      onPick: (result) => {
        picked[which] = result;
        // Choosing the first place moves on to the second, so a route takes two selections.
        if (which === 'from') $('#to').focus();
      },
    });
    // Typing again invalidates an earlier choice.
    $(`#${which}`).addEventListener('input', () => (picked[which] = null));
  }

  const resolve = async (which) => {
    if (picked[which]) return picked[which];
    const text = $(`#${which}`).value;
    return searchPlaces(await places(), text)[0] ?? null;
  };

  $('#routeform').addEventListener('submit', async (event) => {
    event.preventDefault();
    const [from, to] = await Promise.all([resolve('from'), resolve('to')]);
    if (!from || !to) {
      app.toast(`I could not find ${!from ? `“${$('#from').value || 'the start'}”` : `“${$('#to').value || 'the destination'}”`}`);
      return;
    }
    app.drawRoute([from.lon, from.lat], [to.lon, to.lat], `${from.name} → ${to.name}`);
    $('#exnote').hidden = true;
  });

  // Example routes.
  const note = $('#exnote');
  $('#examples').replaceChildren(
    ...EXAMPLES.map((example) =>
      el(
        'button',
        {
          class: 'chip',
          type: 'button',
          onclick: async () => {
            const index = await places();
            const a = findPlace(index, example.from);
            const b = findPlace(index, example.to);
            if (!a || !b) return;
            app.drawRoute([a.lon, a.lat], [b.lon, b.lat], `${a.name} → ${b.name}`);
            note.textContent = example.note;
            note.hidden = false;
          },
        },
        `${example.from} → ${example.to}`,
      ),
    ),
  );

  // The list of routes.
  const list = $('#routes');
  const empty = $('#routes-empty');
  let shown = null;
  const render = () => {
    const { routes, selected } = app.state;
    list.replaceChildren(...routes.map((route) => routeItem(app, route)));
    empty.hidden = routes.length > 0;
    // Bring a newly selected route into view, but never on the first paint of the page.
    if (shown !== null && selected && selected !== shown) list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
    shown = selected;
  };
  app.on('routes', render);
  app.on('unit', render);
  render();
  shown = app.state.selected ?? '';
}

function routeItem(app, route) {
  const { state } = app;
  const unit = state.unit;
  const current = route.id === state.selected;
  const head = el(
    'div',
    { class: 'route-head' },
    el('button', { class: 'route-name', type: 'button', title: 'Highlight on the map', onclick: () => app.select(route.id) }, route.kind === 'marker' ? route.label || 'Marker' : route.name),
    el('button', { class: 'icon', type: 'button', 'aria-label': `Show ${route.name ?? route.label ?? 'marker'} on the map`, title: 'Show on the map', onclick: () => app.focusRoute(route.id) }, icon(ICONS.focus)),
    el('button', { class: 'icon danger', type: 'button', 'aria-label': `Delete ${route.name ?? route.label ?? 'marker'}`, title: 'Delete', onclick: () => app.removeRoute(route.id) }, icon(ICONS.trash)),
  );
  const item = el('li', { class: 'route', 'aria-current': String(current), dataset: { id: route.id } }, head);

  if (route.kind === 'marker') {
    item.append(el('p', { class: 'coords mono' }, formatPosition(route.verts[0], 3)));
    return item;
  }
  if (route.verts.length < 2) {
    item.append(el('p', { class: 'coords' }, 'Click the map to add the next point.'));
    return item;
  }

  const m = pathMetrics(route.verts, unit);
  const widest = Math.max(m.gc, m.rh, 1e-9);
  const same = m.extra < 0.0005;
  const first = m.legs[0];

  item.append(
    el(
      'dl',
      { class: 'figures' },
      el('div', { class: 'gc' }, el('dt', {}, 'Great circle'), el('dd', {}, formatDistance(m.gc, unit))),
      el('div', { class: 'rh' }, el('dt', {}, 'Rhumb line'), el('dd', {}, formatDistance(m.rh, unit))),
    ),
    el(
      'div',
      { class: 'bars', 'aria-hidden': 'true' },
      barFor('gc', m.gc / widest),
      barFor('rh', m.rh / widest),
    ),
    el(
      'p',
      { class: 'delta' },
      same
        ? 'The two paths are practically the same here.'
        : `The rhumb line is ${(m.extra * 100).toFixed(m.extra < 0.1 ? 1 : 0)}% longer: ${formatDistance(m.rh - m.gc, unit)} more.`,
    ),
    el(
      'div',
      { class: 'bearings' },
      el('span', {}, 'Leaves at ', el('b', {}, `${first.bearingStart.toFixed(0)}° ${compassName(first.bearingStart)}`), ', arrives at ', el('b', {}, `${first.bearingEnd.toFixed(0)}° ${compassName(first.bearingEnd)}`)),
      el('span', {}, 'Rhumb bearing ', el('b', {}, `${first.bearingRhumb.toFixed(0)}° ${compassName(first.bearingRhumb)}`), ', constant'),
    ),
  );

  if (m.legs.length > 1) {
    item.append(
      el(
        'details',
        { class: 'legs' },
        el('summary', {}, `${m.legs.length} legs`),
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Leg'), el('th', {}, 'Great circle'), el('th', {}, 'Rhumb'), el('th', {}, 'Bearing'))),
          el(
            'tbody',
            {},
            ...m.legs.map((leg, i) =>
              el('tr', {}, el('td', {}, String(i + 1)), el('td', {}, formatDistance(leg.gc, unit)), el('td', {}, formatDistance(leg.rh, unit)), el('td', {}, `${leg.bearingStart.toFixed(0)}° ${compassName(leg.bearingStart)}`)),
            ),
          ),
        ),
      ),
    );
  }
  return item;
}

function barFor(kind, ratio) {
  const bar = el('i', { class: `bar ${kind}` });
  bar.style.setProperty('--w', `${Math.max(2, ratio * 100)}%`);
  return bar;
}
