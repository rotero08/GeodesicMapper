import './style.css';
import { App } from './app/app.js';
import { setupInteraction } from './ui/interaction.js';
import { setupOverlays } from './ui/overlays.js';
import { setupPanel } from './ui/panel.js';
import { $ } from './ui/dom.js';

const app = new App({ stage: $('#stage'), canvas: $('#map'), sky: $('#sky') });

setupPanel(app);
setupOverlays(app);
setupInteraction(app);

app.boot(location.hash);
app.start();

// A pasted or edited link changes the hash without reloading the page.
window.addEventListener('hashchange', () => app.applyHash(location.hash));

// Handy for poking at the app from the browser console (and for the smoke tests).
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) window.geodesic = app;
