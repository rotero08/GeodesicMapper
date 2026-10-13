// Regenerates the pictures in docs/ from the production build.
//
//   npm run build && npm run screenshots     (needs a Chromium-family browser; CHROME_PATH works)

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import puppeteer from 'puppeteer-core';

const OUT = fileURLToPath(new URL('../docs/', import.meta.url));
const executablePath = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/brave-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
if (!executablePath) {
  console.error('No Chromium-family browser found. Set CHROME_PATH.');
  process.exit(2);
}
await mkdir(OUT, { recursive: true });

const server = await preview({ preview: { port: 0, host: '127.0.0.1' } });
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(viewport, hash, extra = {}) {
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, ...extra });
  await page.goto(`${base}?debug#${hash}`, { waitUntil: 'load' });
  await wait(1200);
  return page;
}

try {
  // 1. The globe, with the two paths.
  let page = await open({ width: 1440, height: 900 }, 'p=mercator&t=0&v=-65,-58,1,0,0&u=km&l=cgrs&w=Madrid%20%E2%86%92%20Tokyo:40.4168,-3.7038,35.6762,139.6503');
  await page.evaluate(() => geodesic.select(geodesic.state.routes[0].id));
  await wait(300);
  await page.screenshot({ path: `${OUT}screenshot-globe.webp`, type: 'webp', quality: 88 });
  await page.close();

  // 2. A flat map, where the shortest path is the curve.
  page = await open({ width: 1440, height: 900 }, 'p=mercator&t=1&v=-20,0,1,0,0&u=km&l=cgrs&w=London%20%E2%86%92%20New%20York:51.5074,-0.1278,40.7128,-74.006~Dubai%20%E2%86%92%20Los%20Angeles:25.2048,55.2708,34.0522,-118.2437');
  await page.evaluate(() => geodesic.select(geodesic.state.routes[1].id));
  await wait(300);
  await page.screenshot({ path: `${OUT}screenshot-flat.webp`, type: 'webp', quality: 88 });

  // 3. The morph as a strip of frames.
  const frames = [];
  for (const t of [0, 0.2, 0.34, 0.5, 0.75, 1]) {
    await page.evaluate((t) => {
      geodesic.clearRoutes();
      geodesic.state.target = 'mercator';
      geodesic.state.rot = [-12, -16, 0];
      geodesic.state.zoom = 1;
      geodesic.state.pan = [0, 0];
      geodesic.setT(t);
    }, t);
    await wait(250);
    frames.push(await page.screenshot({ clip: { x: 0, y: 0, width: 1096, height: 900 }, encoding: 'base64' }));
  }
  await page.close();
  const sheet = await browser.newPage();
  await sheet.setViewport({ width: 1800, height: 1010 });
  await sheet.setContent(`<body style="margin:0;background:#091420;display:grid;grid-template-columns:repeat(3,1fr);gap:0">${frames
    .map((f) => `<img style="width:100%;display:block" src="data:image/png;base64,${f}">`)
    .join('')}</body>`);
  await wait(300);
  await sheet.screenshot({ path: `${OUT}morph.webp`, type: 'webp', quality: 86 });
  await sheet.close();

  // 4. A phone.
  page = await open({ width: 390, height: 844 }, 'p=mercator&t=0.62&v=-65,-40,1,0,0&u=km&l=cgrs&w=Madrid%20%E2%86%92%20Tokyo:40.4168,-3.7038,35.6762,139.6503', { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluate(() => geodesic.select(geodesic.state.routes[0].id));
  await wait(300);
  await page.screenshot({ path: `${OUT}screenshot-mobile.webp`, type: 'webp', quality: 88 });
  await page.close();
  console.log(`Pictures written to ${OUT}`);
} finally {
  await browser.close();
  await server.close();
}
