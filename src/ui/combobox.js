// An accessible autocomplete (ARIA 1.2 combobox with a listbox popup).

import { el } from './dom.js';

/**
 * @param {object} options
 * @param {HTMLInputElement} options.input
 * @param {HTMLUListElement} options.list
 * @param {(query: string) => Promise<object[]> | object[]} options.search  returns result objects
 * @param {(result: object) => string} options.label   text to show for a result
 * @param {(result: object) => string} [options.detail]   small text at the end of the row
 * @param {(result: object) => void} options.onPick
 */
export function createCombobox({ input, list, search, label, detail, onPick }) {
  let results = [];
  let active = -1;
  let token = 0;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const highlight = (index) => {
    active = index;
    [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === index)));
    if (index >= 0) {
      input.setAttribute('aria-activedescendant', list.children[index].id);
      list.children[index].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };

  const pick = (result) => {
    input.value = label(result);
    close();
    onPick(result);
  };

  const render = () => {
    list.replaceChildren(
      ...results.map((result, i) =>
        el(
          'li',
          {
            role: 'option',
            id: `${list.id}-${i}`,
            'aria-selected': 'false',
            // mousedown, not click: the input would blur and close the list first.
            onmousedown: (event) => {
              event.preventDefault();
              pick(result);
            },
          },
          el('span', {}, label(result)),
          detail?.(result) ? el('small', {}, detail(result)) : null,
        ),
      ),
    );
    list.hidden = results.length === 0;
    input.setAttribute('aria-expanded', String(results.length > 0));
    highlight(results.length ? 0 : -1);
  };

  input.addEventListener('input', async () => {
    const mine = ++token;
    const found = await search(input.value);
    if (mine !== token) return;
    results = found;
    render();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (list.hidden || !results.length) return;
      event.preventDefault();
      highlight((active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if (event.key === 'Enter' && !list.hidden && active >= 0) {
      event.preventDefault();
      pick(results[active]);
    } else if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      close();
    }
  });

  input.addEventListener('blur', close);
  return { close, get results() { return results; } };
}
