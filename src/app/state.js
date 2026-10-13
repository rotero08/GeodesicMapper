// The shape of the app's state and its defaults.

export const TOOLS = ['rotate', 'draw', 'marker', 'cut'];

/** Layers the user can switch, in panel order. `code` is the letter used in shared links. */
export const LAYERS = [
  { key: 'countries', code: 'c', label: 'Countries', hint: 'land fill and borders', on: true },
  { key: 'graticule', code: 'g', label: 'Graticule', hint: 'latitude and longitude grid', on: true },
  { key: 'keyLines', code: 'k', label: 'Key parallels', hint: 'equator, tropics and polar circles', on: false },
  { key: 'rhumb', code: 'r', label: 'Compare rhumb lines', hint: 'overlay the constant-bearing path', on: true },
  { key: 'tissot', code: 't', label: 'Tissot indicatrix', hint: 'show how the projection distorts', on: false },
  { key: 'terminator', code: 'n', label: 'Day and night', hint: 'where the Sun is right now', on: false },
  { key: 'stars', code: 's', label: 'Starfield', hint: 'the sky behind the globe', on: true },
  { key: 'spin', code: 'a', label: 'Auto-spin', hint: 'slowly rotate the globe', on: false },
];

/** The view the app opens with, and returns to on "Reset view". Europe and Africa face you. */
export const HOME = { rot: [-12, -16, 0], zoom: 1, pan: [0, 0] };

export function createState() {
  return {
    target: 'mercator', // the map the globe morphs into
    t: 0, // 0 = globe, 1 = the map
    rot: [...HOME.rot], // d3 rotation: [-centre longitude, -centre latitude, roll]
    zoom: HOME.zoom,
    pan: [...HOME.pan], // screen offset, used on flat maps
    tool: 'rotate',
    unit: 'km',
    layers: Object.fromEntries(LAYERS.map((layer) => [layer.key, layer.on])),
    routes: [], // { id, kind: 'path' | 'marker', verts: [[lon, lat], …], name?, label? }
    selected: null, // id of the highlighted route
    drawing: null, // id of the route the Measure tool is extending
    playing: false,
  };
}

let counter = 0;
export const newRouteId = () => `r${++counter}`;
