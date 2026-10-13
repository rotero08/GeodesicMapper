/** Tiny helper: el('button', { class: 'btn', onclick }, 'Label', childNode) */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** An inline SVG icon from a path description, sized by CSS. */
export function icon(paths, { fill = false } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', fill ? 'currentColor' : 'none');
  svg.setAttribute('stroke', fill ? 'none' : 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', paths);
  svg.append(path);
  return svg;
}

export const ICONS = {
  play: 'M4.5 3.2v9.6a.6.6 0 0 0 .92.5l7.2-4.8a.6.6 0 0 0 0-1L5.42 2.7a.6.6 0 0 0-.92.5Z',
  pause: 'M4 3h3v10H4zM9 3h3v10H9z',
  focus: 'M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5M8 6.2v3.6M6.2 8h3.6',
  trash: 'M2.7 4h10.6M6 4V2.6h4V4M3.9 4l.7 9.4a1 1 0 0 0 1 .92h4.8a1 1 0 0 0 1-.92L12.1 4M6.5 6.6v5M9.5 6.6v5',
};
