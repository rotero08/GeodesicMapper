// Pointer and keyboard input for the map.
//
// Dragging always moves the view, whatever tool is active; a press that barely moves is a click
// and does the tool's job. Two fingers pinch to zoom. Everything the mouse can do has a keyboard
// or on-screen equivalent.

import { hitTest } from '../geo/hit.js';
import { TARGETS } from '../geo/projections.js';
import { $ } from './dom.js';

const CLICK_SLOP = 6; // pixels a press may move and still count as a click

export function setupInteraction(app) {
  const canvas = app.canvas;
  const pointers = new Map();
  let gesture = null;

  const at = (event) => [event.offsetX, event.offsetY];

  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener('pointerdown', (event) => {
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, at(event));
    app.beginInteraction();

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { pinch: true, distance: Math.hypot(a[0] - b[0], a[1] - b[1]), moved: Infinity };
      return;
    }
    gesture = { id: event.pointerId, button: event.button, last: at(event), moved: 0, dragging: false };
    if (event.button === 2) event.preventDefault();
  });

  canvas.addEventListener('pointermove', (event) => {
    const point = at(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, point);

    if (gesture?.pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (gesture.distance > 0 && distance > 0) {
        app.zoomBy(distance / gesture.distance, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        gesture.distance = distance;
      }
      return;
    }

    if (gesture && gesture.id === event.pointerId) {
      const dx = point[0] - gesture.last[0];
      const dy = point[1] - gesture.last[1];
      gesture.moved += Math.abs(dx) + Math.abs(dy);
      if (gesture.moved > CLICK_SLOP && gesture.button !== 2) {
        if (!gesture.dragging) {
          gesture.dragging = true;
          canvas.classList.add('dragging');
        }
        app.dragBy(dx, dy);
      }
      gesture.last = point;
    }

    // Hover feedback needs no button; touches only matter while pressed.
    if (event.pointerType !== 'touch' || gesture) {
      app.setPointer(point);
      canvas.classList.toggle('pointing', Boolean(app.ui.hoverRoute) && !gesture?.dragging);
    }
  });

  const release = (event) => {
    const wasGesture = gesture && gesture.id === event.pointerId ? gesture : null;
    pointers.delete(event.pointerId);
    canvas.classList.remove('dragging');
    if (gesture?.pinch) {
      if (pointers.size === 0) gesture = null;
      app.endInteraction(120);
      return;
    }
    if (wasGesture && event.type === 'pointerup' && wasGesture.moved <= CLICK_SLOP) click(wasGesture.button, at(event));
    if (pointers.size === 0) gesture = null;
    app.endInteraction(event.pointerType === 'touch' ? 80 : 0);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'touch') {
      app.setPointer(null);
      canvas.classList.remove('pointing');
    }
  });

  function click(button, point) {
    const { state } = app;
    if (button === 2) {
      app.undo();
      return;
    }
    if (button !== 0) return;
    const frame = app.frame();
    if (state.tool === 'cut') {
      app.cutAt(point);
    } else if (state.tool === 'draw') {
      const position = frame.invert(point);
      if (position) app.addVertex(position);
    } else if (state.tool === 'marker') {
      const position = frame.invert(point);
      if (position) app.addMarker(position);
    } else {
      // Rotate tool: a click on a route selects it, a click elsewhere clears the selection.
      app.select(hitTest(frame, state.routes, point)?.id ?? null);
    }
  }

  // A double-click places the same vertex twice; keep one and finish the route.
  canvas.addEventListener('dblclick', () => {
    const route = app.drawingRoute;
    if (app.state.tool !== 'draw' || !route) return;
    const frame = app.frame();
    const n = route.verts.length;
    if (n >= 2) {
      const a = frame.project(route.verts[n - 1]);
      const b = frame.project(route.verts[n - 2]);
      if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) < 12) route.verts.pop();
    }
    app.finishDrawing();
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      app.beginInteraction();
      app.zoomBy(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0016)), at(event));
      app.endInteraction(180);
    },
    { passive: false },
  );

  $('#zin').addEventListener('click', () => app.zoomBy(1.25));
  $('#zout').addEventListener('click', () => app.zoomBy(1 / 1.25));

  setupKeyboard(app);
}

function setupKeyboard(app) {
  const canvas = app.canvas;
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.metaKey || event.altKey) return;
    const target = event.target;
    const typing = target.closest?.('input, textarea, select, [contenteditable]');
    const onCanvas = target === canvas || target === document.body;
    const key = event.key;
    const { state } = app;

    if (event.ctrlKey && key.toLowerCase() === 'z' && !typing) {
      event.preventDefault();
      app.undo();
      return;
    }
    if (event.ctrlKey || typing) return;

    const step = event.shiftKey ? 15 : 5;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (arrows[key] && onCanvas) {
      event.preventDefault();
      app.rotateBy(...arrows[key]);
      return;
    }

    switch (key) {
      case ' ':
        if (onCanvas) {
          event.preventDefault();
          app.togglePlay();
        }
        break;
      case '+':
      case '=':
        if (onCanvas) app.zoomBy(1.25);
        break;
      case '-':
      case '_':
        if (onCanvas) app.zoomBy(1 / 1.25);
        break;
      case '[':
      case ']': {
        const at = TARGETS.findIndex((p) => p.id === state.target);
        app.setTarget(TARGETS[(at + (key === ']' ? 1 : -1) + TARGETS.length) % TARGETS.length].id);
        break;
      }
      case 'Enter':
        if (app.drawingRoute && onCanvas) {
          event.preventDefault();
          app.finishDrawing();
        }
        break;
      case 'Escape':
        if (app.drawingRoute) app.cancelDrawing();
        else if (state.tool !== 'rotate') app.setTool('rotate');
        break;
      case 'Backspace':
        if (onCanvas) {
          event.preventDefault();
          app.undo();
        }
        break;
      case 'Delete':
        if (state.selected && onCanvas) app.removeRoute(state.selected);
        break;
      case '?': {
        const details = $('.foot details');
        details.open = true;
        details.scrollIntoView({ block: 'center' });
        break;
      }
      default: {
        const tool = { v: 'rotate', m: 'draw', p: 'marker', x: 'cut' }[key.toLowerCase()];
        if (tool) app.setTool(tool);
        else if (key.toLowerCase() === 'r') app.resetView();
      }
    }
  });
}
