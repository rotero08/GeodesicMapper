// Routes worth drawing: each one shows a different way the shortest path and the constant-bearing
// path can part company. The figures in the notes were computed with this app's own geodesy.

export const EXAMPLES = [
  { from: 'Madrid', to: 'Tokyo', note: 'The shortest path climbs to about 68°N over Siberia. The rhumb line is a long straight diagonal.' },
  { from: 'London', to: 'New York', note: 'The classic transatlantic arc bows well north of the straight line.' },
  { from: 'Moscow', to: 'Seattle', note: 'The shortest route passes within 8° of the North Pole; the rhumb line is about a third longer.' },
  { from: 'Los Angeles', to: 'Shanghai', note: 'Crosses the antimeridian in the North Pacific, peaking near 52°N.' },
  { from: 'Buenos Aires', to: 'Auckland', note: 'Dips to 58°S, deep into the Southern Ocean, and crosses the antimeridian.' },
  { from: 'Dubai', to: 'Los Angeles', note: 'Leaves almost due north and crosses the Arctic, peaking near 84°N.' },
  { from: 'Quito', to: 'Kampala', note: 'Both cities lie almost exactly on the equator, so the two lines coincide.' },
];
