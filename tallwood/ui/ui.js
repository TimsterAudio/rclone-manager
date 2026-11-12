// Small UI toolkit: DOM helpers, formatting, virtual list, modals, popup menus.

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---------- formatting ----------

const nf = new Intl.NumberFormat('en-US');
export const fmtBytes = n => nf.format(n);

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[i]}`;
}

const pad = n => String(n).padStart(2, '0');
export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtMode(f) {
  if (!f.mode) return (f.ro ? 'r' : '-') + (f.hidden ? 'h' : '-') + (f.link ? 'l' : '-');
  const bits = 'rwxrwxrwx';
  let out = f.link ? 'l' : '-';
  for (let i = 0; i < 9; i++) out += f.mode & (1 << (8 - i)) ? bits[i] : '-';
  return out;
}

// ---------- filespec ----------

function globRegex(glob) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * Compile a filespec into a name predicate.
 * Patterns are separated by spaces, commas or semicolons; a leading `-` or `!`
 * excludes. `*.*` matches everything (as in DOS), and a bare word with no
 * wildcard matches names containing it.
 */
export function specToFilter(spec) {
  const parts = (spec || '').split(/[\s,;]+/).filter(Boolean);
  const inc = [];
  const exc = [];
  for (let p of parts) {
    const neg = p[0] === '-' || p[0] === '!';
    if (neg) p = p.slice(1);
    if (!p) continue;
    if (p === '*.*') p = '*';
    else if (!/[*?]/.test(p)) p = `*${p}*`;
    (neg ? exc : inc).push(globRegex(p));
  }
  if (!inc.length && !exc.length) return () => true;
  return name => (!inc.length || inc.some(r => r.test(name))) && !exc.some(r => r.test(name));
}

/**
 * Batch-rename mask. DOS wildcards act per name/extension part (`*` keeps the
 * rest of the original, `?` keeps one character); tokens: {name} {ext}
 * {n} / {n:3} (counter, zero padded) and {date} (modified, yyyy-mm-dd).
 */
export function applyMask(mask, file, index) {
  const dot = file.name.lastIndexOf('.');
  const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
  const ext = dot > 0 ? file.name.slice(dot + 1) : '';
  const part = (m, orig) => {
    let out = '';
    for (let i = 0; i < m.length; i++) {
      if (m[i] === '*') {
        out += orig.slice(i);
        break;
      }
      out += m[i] === '?' ? orig[i] || '' : m[i];
    }
    return out;
  };
  const held = [];
  let m = mask.replace(/\{(name|ext|date|n)(?::(\d+))?\}/g, (_, t, w) => {
    const d = new Date(file.mtime || 0);
    const v =
      t === 'name'
        ? stem
        : t === 'ext'
          ? ext
          : t === 'date'
            ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
            : String(index + 1).padStart(Number(w) || 1, '0');
    held.push(v);
    return `\u0000${held.length - 1}\u0001`;
  });
  const mdot = m.lastIndexOf('.');
  m = mdot >= 0 ? `${part(m.slice(0, mdot), stem)}.${part(m.slice(mdot + 1), ext)}` : part(m, stem);
  m = m.replace(/\u0000(\d+)\u0001/g, (_, i) => held[Number(i)]);
  return m.replace(/\.$/, '');
}

export function fuzzy(needle, hay) {
  needle = needle.toLowerCase();
  hay = hay.toLowerCase();
  if (hay.includes(needle)) return 1000 - hay.indexOf(needle);
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length ? 1 : 0;
}

// ---------- virtual list ----------

export class VList {
  constructor(el, rowH, render) {
    this.el = el;
    this.rowH = rowH;
    this.render = render;
    this.count = 0;
    this.inner = h('div', { class: 'vinner' });
    el.classList.add('vlist');
    el.append(this.inner);
    el.addEventListener('scroll', () => this.draw());
    new ResizeObserver(() => this.draw()).observe(el);
  }
  set(count) {
    this.count = count;
    this.inner.style.height = `${count * this.rowH}px`;
    this.draw();
  }
  draw() {
    const top = this.el.scrollTop;
    const first = Math.max(0, Math.floor(top / this.rowH) - 6);
    const last = Math.min(this.count, Math.ceil((top + this.el.clientHeight) / this.rowH) + 6);
    const rows = [];
    for (let i = first; i < last; i++) {
      const row = this.render(i);
      if (!row) continue; // list shrank since the last set()
      row.style.top = `${i * this.rowH}px`;
      row.dataset.i = i;
      rows.push(row);
    }
    this.inner.replaceChildren(...rows);
  }
  reveal(i) {
    const top = i * this.rowH;
    const view = this.el.clientHeight;
    if (top < this.el.scrollTop) this.el.scrollTop = top;
    else if (top + this.rowH > this.el.scrollTop + view) this.el.scrollTop = top + this.rowH - view;
  }
  page() {
    return Math.max(1, Math.floor(this.el.clientHeight / this.rowH) - 1);
  }
}

// ---------- modals ----------

let depth = 0;
export const modalOpen = () => depth > 0;

export function openModal({ title, body, buttons = [], onKey, cls = '' }) {
  const overlay = $('#overlay');
  let resolve;
  const promise = new Promise(r => (resolve = r));
  const footer = h('div', { class: 'modal-foot' });
  const box = h(
    'div',
    { class: `modal ${cls}`, role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-title' }, title),
    h('div', { class: 'modal-body' }, body),
    footer
  );
  const shade = h('div', { class: 'shade' }, box);
  const prevFocus = document.activeElement;
  let closed = false;
  const close = result => {
    if (closed) return;
    closed = true;
    depth--;
    shade.remove();
    if (prevFocus && prevFocus.isConnected) prevFocus.focus();
    resolve(result);
  };
  for (const b of buttons) {
    footer.append(
      h('button', { class: `btn ${b.kind || ''}`, 'data-id': b.id, onclick: () => close(b.id) }, b.label)
    );
  }
  if (!buttons.length) footer.remove();
  shade.addEventListener('mousedown', e => {
    if (e.target === shade) close(null);
  });
  shade.addEventListener('keydown', e => {
    e.stopPropagation();
    if (onKey && onKey(e, close) === true) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close(null);
    } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'TEXTAREA') {
      const primary = buttons.find(b => b.kind === 'primary');
      if (primary) {
        e.preventDefault();
        close(primary.id);
      }
    } else if (['ArrowLeft', 'ArrowRight'].includes(e.key) && e.target.tagName === 'BUTTON') {
      const all = [...footer.children];
      const next = all[(all.indexOf(e.target) + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
      next.focus();
    }
  });
  depth++;
  overlay.append(shade);
  const first = box.querySelector('input, textarea') || footer.querySelector('.primary') || footer.lastChild;
  if (first) {
    first.focus();
    if (first.select) first.select();
  } else {
    box.tabIndex = -1;
    box.focus();
  }
  return { promise, close, box };
}

/** Text prompt with one or more fields. Resolves to {name: value} or null. */
export async function prompt({ title, message, fields, okLabel = 'OK', onInput }) {
  const inputs = {};
  const preview = h('pre', { class: 'preview-text' });
  const body = h(
    'div',
    {},
    message && h('p', { class: 'msg' }, message),
    fields.map(f => {
      const input = h('input', {
        type: 'text',
        value: f.value ?? '',
        placeholder: f.placeholder || '',
        spellcheck: 'false',
        autocomplete: 'off',
        'data-field': f.name,
      });
      inputs[f.name] = input;
      return h('label', { class: 'field' }, h('span', {}, f.label), input, f.hint && h('small', {}, f.hint));
    }),
    onInput && preview
  );
  const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
  const update = () => {
    if (onInput) preview.textContent = onInput(values()) || '';
  };
  body.addEventListener('input', update);
  update();
  const m = openModal({
    title,
    body,
    buttons: [
      { id: 'ok', label: okLabel, kind: 'primary' },
      { id: 'cancel', label: 'Cancel' },
    ],
  });
  return (await m.promise) === 'ok' ? values() : null;
}

/** Button choice. Resolves to the chosen id or null. Buttons answer to their first letter. */
export function confirm({ title, message, detail, buttons }) {
  const body = h('div', {}, h('p', { class: 'msg' }, message), detail && h('pre', { class: 'preview-text' }, detail));
  return openModal({
    title,
    body,
    buttons,
    onKey: (e, close) => {
      if (e.ctrlKey || e.altKey || e.key.length !== 1) return false;
      const hit = buttons.filter(b => b.label[0].toLowerCase() === e.key.toLowerCase());
      if (hit.length === 1) {
        close(hit[0].id);
        return true;
      }
      return false;
    },
  }).promise;
}

/**
 * Filterable list picker. Resolves to the chosen item's value, to
 * `{ input }` when free text was accepted (allowInput), or null.
 */
export function pick({ title, items, placeholder = 'Type to filter…', allowInput = false, filter = true }) {
  const input = h('input', { type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off' });
  const list = h('div', { class: 'pick-list' });
  let shown = items;
  let idx = 0;
  const draw = () => {
    list.replaceChildren(
      ...shown.map((it, i) =>
        h(
          'div',
          { class: `pick-item${i === idx ? ' cur' : ''}`, 'data-i': i },
          h('span', { class: 'pick-label' }, it.label),
          it.detail && h('span', { class: 'pick-detail' }, it.detail),
          it.keys && h('kbd', {}, it.keys)
        )
      )
    );
    list.children[idx]?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    const q = input.value.trim();
    shown = !q || !filter
      ? items
      : items
          .map(it => ({ it, score: fuzzy(q, `${it.label} ${it.detail || ''}`) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map(x => x.it);
    idx = 0;
    draw();
  });
  const body = h('div', {}, (filter || allowInput) && input, list);
  const m = openModal({
    title,
    body,
    cls: 'picker',
    onKey: (e, close) => {
      if (e.key === 'ArrowDown') idx = Math.min(shown.length - 1, idx + 1);
      else if (e.key === 'ArrowUp') idx = Math.max(0, idx - 1);
      else if (e.key === 'PageDown') idx = Math.min(shown.length - 1, idx + 10);
      else if (e.key === 'PageUp') idx = Math.max(0, idx - 10);
      else if (e.key === 'Enter') {
        const typed = input.value.trim();
        if (allowInput && typed && (!shown.length || /[\\/~]/.test(typed))) close({ input: typed });
        else if (shown[idx]) close(shown[idx].value);
        return true;
      } else return false;
      draw();
      return true;
    },
  });
  list.addEventListener('click', e => {
    const row = e.target.closest('.pick-item');
    if (row) m.close(shown[Number(row.dataset.i)].value);
  });
  draw();
  return m.promise;
}

// ---------- popup menu ----------

let closePopup = () => {};
export function popup(x, y, items) {
  closePopup();
  const menu = h(
    'div',
    { class: 'popup' },
    items.map(it =>
      it === '-'
        ? h('div', { class: 'popup-sep' })
        : h(
            'div',
            {
              class: 'popup-item',
              onclick: () => {
                closePopup();
                it.run();
              },
            },
            h('span', {}, it.label),
            it.keys && h('kbd', {}, it.keys)
          )
    )
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  const away = e => {
    if (!menu.contains(e.target)) closePopup();
  };
  const esc = e => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePopup();
    }
  };
  closePopup = () => {
    menu.remove();
    document.removeEventListener('mousedown', away, true);
    document.removeEventListener('keydown', esc, true);
    closePopup = () => {};
  };
  setTimeout(() => {
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', esc, true);
  });
}

// ---------- bytes ----------

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hexDump(bytes, limit = 64 * 1024) {
  const n = Math.min(bytes.length, limit);
  const lines = [];
  for (let off = 0; off < n; off += 16) {
    let hex = '';
    let txt = '';
    for (let i = 0; i < 16; i++) {
      if (off + i < n) {
        const b = bytes[off + i];
        hex += b.toString(16).padStart(2, '0') + ' ';
        txt += b >= 32 && b < 127 ? String.fromCharCode(b) : '·';
      } else hex += '   ';
      if (i === 7) hex += ' ';
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex} ${txt}`);
  }
  return lines.join('\n');
}
