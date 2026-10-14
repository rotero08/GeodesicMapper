// A browser smoke test: serves the production build and drives it like a person would.
//
//   npm run build && npm run smoke          (needs a Chromium-family browser; set CHROME_PATH if
//                                            it is not one of the usual places)
//
// It checks that every projection and morph position draws something, that the tools and the
// route search work, that a shared link restores the view, and that nothing logs an error.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preview } from 'vite';
import puppeteer from 'puppeteer-core';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/brave-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const executablePath = CANDIDATES.find((path) => path && existsSync(path));
if (!executablePath) {
  console.error('No Chromium-family browser found. Install one or set CHROME_PATH.');
  process.exit(2);
}

const server = await preview({ preview: { port: 0, host: '127.0.0.1' } });
const url = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });

const failures = [];
const check = (condition, message) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('requestfailed', (request) => errors.push(`request failed: ${request.url()}`));

  await page.goto(`${url}?debug`, { waitUntil: 'load' });
  await wait(600);

  // Does the map canvas hold something other than the empty ocean colour?
  const inked = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('#map');
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let light = 0;
      for (let i = 0; i < data.length; i += 4 * 97) if (data[i] > 150 && data[i + 1] > 160) light++;
      return light;
    });

  check((await inked()) > 100, 'the first frame draws land');
  const app = () => page.evaluate(() => ({ routes: geodesic.state.routes.length, tool: geodesic.state.tool, selected: geodesic.state.selected }));
  check((await app()).routes === 1, 'a starter route is shown');
  check((await page.$eval('#summary', (el) => !el.hidden && /Great circle/.test(el.textContent))), 'the route summary shows the great circle');

  // Every projection, at the map end and part-way through the morph.
  const targets = await page.$$eval('#projsel option', (options) => options.map((o) => o.value));
  check(targets.length === 14, `the projection list has 14 maps (found ${targets.length})`);
  for (const target of targets) {
    for (const t of [0.25, 0.7, 1]) {
      await page.evaluate((target, t) => {
        geodesic.state.target = target;
        geodesic.setT(t);
      }, target, t);
      await wait(80);
      if ((await inked()) < 30) check(false, `${target} at t=${t} draws land`);
    }
  }
  check(errors.length === 0, 'no console errors while cycling every projection');

  // Measuring: three clicks and a double-click finish one route of three points, no duplicates.
  await page.evaluate(() => {
    geodesic.clearRoutes();
    geodesic.state.target = 'mercator';
    geodesic.setT(1);
    geodesic.state.rot = [-10, 0, 0];
  });
  await page.keyboard.press('m');
  check((await app()).tool === 'draw', 'M selects the Measure tool');
  await page.mouse.click(300, 300);
  await page.mouse.click(520, 260);
  await page.mouse.click(700, 420, { count: 2 });
  await wait(150);
  const measured = await page.evaluate(() => geodesic.state.routes.map((r) => r.verts.length));
  check(JSON.stringify(measured) === '[3]', `measuring finishes one 3-point route (got ${JSON.stringify(measured)})`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');

  // Searching two places draws a route between them.
  await page.type('#from', 'madrid');
  await wait(300);
  await page.keyboard.press('Enter');
  await page.type('#to', 'sydney');
  await wait(300);
  await page.keyboard.press('Enter');
  await page.click('#routeform button[type=submit]');
  await wait(300);
  const names = await page.evaluate(() => geodesic.state.routes.map((r) => r.name));
  check(names.includes('Madrid → Sydney'), `searching two places draws a route (got ${JSON.stringify(names)})`);

  // Mouse: drag turns the globe in any tool, the wheel zooms, right-click undoes a point.
  await page.evaluate(() => {
    geodesic.clearRoutes();
    geodesic.setT(0);
    geodesic.state.rot = [-12, -16, 0];
    geodesic.state.zoom = 1;
  });
  await page.keyboard.press('m');
  const turned = await page.evaluate(() => geodesic.state.rot[0]);
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await page.mouse.move(470, 410, { steps: 5 });
  await page.mouse.up();
  const afterDrag = await page.evaluate(() => ({ lon: geodesic.state.rot[0], routes: geodesic.state.routes.length }));
  check(afterDrag.lon !== turned && afterDrag.routes === 0, 'dragging turns the globe even in the Measure tool, and places no point');
  await page.mouse.click(500, 400);
  await page.mouse.click(560, 380);
  await page.mouse.click(560, 380, { button: 'right' });
  check((await page.evaluate(() => geodesic.state.routes[0]?.verts.length)) === 1, 'right-click removes the last point');
  await page.keyboard.press('Escape');
  const zoom0 = await page.evaluate(() => geodesic.state.zoom);
  await page.mouse.move(500, 400);
  await page.mouse.wheel({ deltaY: -300 });
  await wait(100);
  check((await page.evaluate(() => geodesic.state.zoom)) > zoom0, 'the wheel zooms in');

  // Markers and cutting.
  await page.keyboard.press('p');
  await page.mouse.click(520, 420);
  const placed = await page.evaluate(() => geodesic.state.routes.map((r) => r.kind));
  check(placed.includes('marker'), 'the Marker tool drops a pin');
  await page.keyboard.press('x');
  const marker = await page.evaluate(() => {
    const frame = geodesic.frame();
    const at = frame.project(geodesic.state.routes.find((r) => r.kind === 'marker').verts[0]);
    return at;
  });
  await page.mouse.click(marker[0], marker[1] - 11);
  check((await page.evaluate(() => geodesic.state.routes.filter((r) => r.kind === 'marker').length)) === 0, 'the Cut tool deletes the route under the pointer');
  await page.keyboard.press('v');

  // The morph: Play runs and Pause stops; switching map goes through the oval and ends on the new map.
  await page.evaluate(() => geodesic.setT(0));
  await page.click('#play');
  await wait(500);
  const mid = await page.evaluate(() => geodesic.state.t);
  check(mid > 0.02 && (await page.$eval('#play', (b) => /Pause/.test(b.textContent))), 'Play starts the morph and the button turns into Pause');
  await page.click('#play');
  const paused = await page.evaluate(() => geodesic.state.t);
  await wait(300);
  check(Math.abs((await page.evaluate(() => geodesic.state.t)) - paused) < 1e-9, 'Pause stops the morph');
  await page.evaluate(() => geodesic.setT(1));
  await page.select('#projsel', 'robinson');
  await page.waitForFunction(() => geodesic.state.target === 'robinson' && !geodesic.anim, { timeout: 4000 });
  check((await page.evaluate(() => geodesic.state.t)) === 1, 'switching map re-folds and unfolds to the new projection');
  await page.focus('#map'); // shortcuts are ignored while a form control has the focus
  await page.keyboard.press(']');
  // The new map takes over once the old one has folded back into the oval.
  const stepped = await page.waitForFunction(() => geodesic.state.target !== 'robinson', { timeout: 4000 }).then(() => true, () => false);
  check(stepped, 'the bracket keys step through projections');
  await page.waitForFunction(() => !geodesic.anim, { timeout: 4000 });
  await page.keyboard.press('r');
  await wait(1100);

  // Layers: the switch reflects state.
  await page.click('#layers [data-key="tissot"]');
  check((await page.evaluate(() => geodesic.state.layers.tissot)) === true && (await page.$eval('#layers [data-key="tissot"]', (b) => b.getAttribute('aria-checked'))) === 'true', 'a layer switch toggles the layer and its aria state');
  await page.click('#layers [data-key="tissot"]');

  // Export and import through real files.
  const cdp = await page.createCDPSession();
  const downloads = await mkdtemp(join(tmpdir(), 'geodesic-'));
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await page.evaluate(() => {
    geodesic.clearRoutes();
    geodesic.drawRoute([-3.7038, 40.4168], [139.6503, 35.6762], 'Madrid → Tokyo');
  });
  await page.click('#geojson');
  await page.click('#png');
  await page.waitForFunction(() => true);
  let files = [];
  for (let i = 0; i < 30 && files.filter((f) => !f.endsWith('.crdownload')).length < 2; i++) {
    await wait(150);
    files = await readdir(downloads);
  }
  const geojsonFile = files.find((f) => f.endsWith('.geojson'));
  const pngFile = files.find((f) => f.endsWith('.png'));
  check(Boolean(geojsonFile) && Boolean(pngFile), `export writes a GeoJSON and a PNG file (${files.join(', ') || 'none'})`);
  if (geojsonFile) {
    const json = JSON.parse(await readFile(join(downloads, geojsonFile), 'utf8'));
    const roles = json.features.map((f) => f.properties.role);
    check(roles.join() === 'route,great-circle,rhumb-line', `the GeoJSON holds the route and both curves (${roles.join()})`);
    await page.evaluate(() => geodesic.clearRoutes());
    await page.evaluate((text) => geodesic.importGeoJSON(text), JSON.stringify(json));
    check((await page.evaluate(() => geodesic.state.routes.map((r) => r.name))).join() === 'Madrid → Tokyo', 'importing that file brings the route back');
  }
  if (pngFile) check((await readFile(join(downloads, pngFile))).subarray(1, 4).toString() === 'PNG', 'the saved image is a PNG');

  // A shared link restores the view.
  await page.evaluate(() => geodesic.setT(0.8)); // part-way through a morph, to prove that is shared too
  const before = await page.evaluate(() => ({ ...geodesic.view, routes: geodesic.state.routes.length, unit: geodesic.state.unit }));
  await page.evaluate(() => geodesic.setUnit('nmi'));
  // The address is updated a moment after the view stops changing.
  await page.waitForFunction(() => location.hash.includes('u=nmi'), { timeout: 4000 }).catch(() => {});
  const hash = await page.evaluate(() => location.hash);
  check(hash.includes(`p=${before.target}`) && hash.includes('u=nmi'), 'the address bar tracks the view');
  const restored = await browser.newPage();
  await restored.setViewport({ width: 1280, height: 800 });
  await restored.goto(`${url}?debug${hash}`, { waitUntil: 'load' });
  await wait(500);
  const after = await restored.evaluate(() => ({ target: geodesic.state.target, t: geodesic.state.t, routes: geodesic.state.routes.length, unit: geodesic.state.unit }));
  check(after.target === before.target && after.routes === before.routes && after.unit === 'nmi' && Math.abs(after.t - 0.8) < 1e-3, 'a shared link restores projection, morph position, routes and unit');
  await restored.close();

  // The animations. Changing the map on a flat map turns one into the other in place (no trip back
  // to the globe), a flat map and an azimuthal one fold through the globe in one motion, and Play
  // sweeps at an even pace and rests at the ends.
  await page.evaluate(() => {
    geodesic.state.layers.spin = false;
    geodesic.state.target = 'mercator';
    geodesic.setT(1);
    geodesic.setTarget('robinson');
  });
  await wait(250);
  const turning = await page.evaluate(() => ({ t: geodesic.state.t, mixing: Boolean(geodesic.state.blend), target: geodesic.state.target }));
  check(turning.t === 1 && turning.mixing && turning.target === 'robinson', 'changing the map on a flat map turns it in place, without going back to the globe');
  await wait(800);
  check(await page.evaluate(() => geodesic.state.blend === null && geodesic.state.target === 'robinson' && geodesic.state.t === 1), 'the turn ends on the new map');
  await page.evaluate(() => geodesic.setTarget('gnomonic'));
  let lowest = 1;
  for (let i = 0; i < 16; i++) {
    await wait(100);
    lowest = Math.min(lowest, await page.evaluate(() => geodesic.state.t));
  }
  check(lowest < 0.05, `going to an azimuthal map folds through the globe (lowest morph position ${lowest.toFixed(2)})`);
  await wait(500);
  check(await page.evaluate(() => geodesic.state.target === 'gnomonic' && Math.abs(geodesic.state.t - 1) < 1e-6), 'and comes back out to the same morph position on the new map');
  await page.evaluate(() => geodesic.setTarget('mercator'));
  await wait(1800);
  await page.evaluate(() => { geodesic.setT(0); geodesic.play(); });
  const seen = [];
  for (let i = 0; i < 18; i++) {
    await wait(220);
    seen.push(await page.evaluate(() => geodesic.progress));
  }
  await page.evaluate(() => geodesic.pause());
  const steps = seen.slice(1).map((p, i) => p - seen[i]);
  const middle = steps.slice(3, 10);
  const spread = Math.max(...middle) / Math.max(1e-9, Math.min(...middle));
  check(seen[seen.length - 1] > 0.5 && !(await page.evaluate(() => geodesic.state.playing)), 'Play morph sweeps towards the map and Pause stops it');
  check(spread < 1.6, `Play moves at an even pace through the middle of the sweep (fastest step ${spread.toFixed(2)}x the slowest)`);

  // Keyboard: arrows turn the globe.
  await page.evaluate(() => geodesic.setT(0));
  await page.focus('#map');
  const lon = await page.evaluate(() => geodesic.state.rot[0]);
  await page.keyboard.press('ArrowRight');
  check((await page.evaluate(() => geodesic.state.rot[0])) !== lon, 'arrow keys rotate the globe');

  // The detail coastlines load when zoomed in.
  await page.evaluate(() => geodesic.zoomBy(4));
  await wait(1500);
  check(await page.evaluate(() => Boolean(geodesic.detail)), 'zooming in loads the 1:50m coastlines');

  // A phone: no sideways scrolling, and two fingers pinch to zoom.
  const phone = await browser.newPage();
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await phone.goto(`${url}?debug`, { waitUntil: 'load' });
  await wait(500);
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow on a phone');
  const touch = await phone.createCDPSession();
  const zoomBefore = await phone.evaluate(() => geodesic.state.zoom);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 200, id: 1 }, { x: 240, y: 200, id: 2 }] });
  for (const spread of [10, 30, 60]) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 150 - spread, y: 200, id: 1 }, { x: 240 + spread, y: 200, id: 2 }] });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(150);
  check((await phone.evaluate(() => geodesic.state.zoom)) > zoomBefore * 1.3, 'pinching two fingers apart zooms in');
  await phone.close();

  check(errors.length === 0, `no console errors in the whole run${errors.length ? `: ${errors[0]}` : ''}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
