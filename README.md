# Geodesic Mapper

Interactive globe that morphs smoothly between 15 map projections (Orthographic,
Mercator, Mollweide, Winkel Tripel, Equal Earth, Robinson, Gnomonic, …). Draw a
path on any projection and it renders the **great circle** (shortest path) and the
**rhumb line** (constant compass bearing) at once, with live distance and bearing.
Plus Tissot distortion ellipses, a day/night terminator, drag-to-spin, zoom, and a
starfield. Coastlines bundled in — runs offline.

## Requirements

- **Node.js 18 or newer** (check with `node -v`). Get it at https://nodejs.org

## Run it (development, with hot reload)

```bash
npm install      # once, installs d3-geo, d3-geo-projection, topojson-client, vite
npm run dev      # starts the dev server
```

Then open the URL it prints — usually **http://localhost:5173** .
Edit anything in `src/` and the page reloads instantly.

## Build for production

```bash
npm run build    # outputs a self-contained site into dist/
npm run preview  # serves dist/ locally so you can check it: http://localhost:4173
```

`dist/` is fully static (the map data is bundled into the JS, no network needed).
Drop it on any static host — GitHub Pages, Netlify, S3, nginx — and it just works.

> Note: don't open `dist/index.html` by double-clicking. Browsers block ES-module
> scripts over `file://`. Use `npm run preview` or any static server.

## Controls

- **Drag** to spin the globe — full free rotation, tumble over the poles as much as you like
- **Scroll** to zoom · **middle-drag** pans/spins in any tool
- **Map projection** dropdown picks the flat map · the **Globe → map** slider morphs between
  the 3-D globe and that map · **Play** ping-pongs the morph
- **Measure** tool: left-click to add points (each leg is labelled on the map with its
  great-circle distance, and rhumb distance when that overlay is on); **right-click** undoes
  the last point; double-click finishes. Totals and bearing show bottom-left. Toggle km / mi.
- **Marker** drops pins · **Cut** (scissors) deletes one measurement you click on ·
  **Clear all** wipes everything
- **Layers**: countries, graticule, rhumb overlay, Tissot indicatrix, day/night,
  starfield, auto-spin
- Keys: **Space** = play/pause morph · **R** = reset view

## Project layout

```
index.html          Vite entry (markup only)
src/main.js          all the app logic (canvas render, projections, geodesy)
src/style.css        styling
src/world-110m.json  Natural Earth 110m coastlines (TopoJSON, bundled at build)
vite.config.js       relative base so the build runs from any path
```

## Swapping in higher-res coastlines

`src/world-110m.json` is low-res (110m). For sharper land, replace it with the
50m or 10m file from the `world-atlas` package and keep the same import:

```bash
npm install world-atlas
# then copy node_modules/world-atlas/countries-50m.json to src/world-110m.json
```

Bigger files = sharper coast, slightly heavier bundle.
