import {
  $,
  h,
  VList,
  fmtBytes,
  fmtSize,
  fmtDate,
  fmtMode,
  specToFilter,
  applyMask,
  openModal,
  modalOpen,
  prompt,
  confirm,
  pick,
  popup,
  b64ToBytes,
  hexDump,
} from './ui.js';

// ---------------------------------------------------------------- backend

const TAURI = window.__TAURI__;
const token = new URLSearchParams(location.search).get('t') || '';

async function rpc(method, params = {}) {
  try {
    if (TAURI) return await TAURI.core.invoke('rpc', { method, params });
    const r = await fetch('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tallwood-token': token },
      body: JSON.stringify({ method, params }),
    });
    if (!r.ok) throw new Error(r.status === 403 ? 'Not authorised: open the URL printed at start-up' : `HTTP ${r.status}`);
    const j = await r.json();
    if ('err' in j) throw new Error(j.err);
    return j.ok;
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : e.message || String(e));
  }
}

/** replaceChildren that ignores null/false and flattens nested lists. */
const set = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

// ---------------------------------------------------------------- state

const S = {
  panes: [],
  active: 0,
  split: true,
  autoview: false,
  hidden: false,
  trash: true,
  theme: 'midnight',
  sep: '/',
  home: '/',
  os: '',
  roots: [],
  lastDest: '',
  mod: '',
  busy: false,
};
const THEMES = ['midnight', 'classic', 'paper'];
const cache = new Map(); // dir path -> { dirs: [entry], files: [file] }
const disks = new Map(); // pane root -> disk info

const active = () => S.panes[S.active];
const other = () => S.panes[1 - S.active];

// ---------------------------------------------------------------- paths

const isRoot = p => p === '/' || /^[A-Za-z]:\\$/.test(p);

function norm(p) {
  const sep = S.sep;
  if (sep === '\\') p = p.replace(/\//g, '\\');
  const unc = p.startsWith('\\\\');
  const out = [];
  for (const seg of p.split(sep)) {
    if (seg === '.') continue;
    if (seg === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    if (seg === '' && out.length) continue;
    out.push(seg);
  }
  let r = out.join(sep);
  if (unc) r = `\\${r}`;
  if (r === '') r = '/';
  if (/^[A-Za-z]:$/.test(r)) r += '\\';
  return r;
}
const join = (a, b) => (a.endsWith(S.sep) ? a + b : a + S.sep + b);
function parentOf(p) {
  if (isRoot(p)) return null;
  const i = p.lastIndexOf(S.sep);
  if (i < 0) return null;
  if (i === 0) return '/';
  const par = p.slice(0, i);
  if (par === '\\' || par === '') return null;
  return /^[A-Za-z]:$/.test(par) ? `${par}\\` : par;
}
const rootOf = p => (S.sep === '\\' ? (/^[A-Za-z]:/.test(p) ? `${p.slice(0, 2)}\\` : p) : '/');
const isUnder = (p, base) => p === base || p.startsWith(base.endsWith(S.sep) ? base : base + S.sep);
const baseName = p => (isRoot(p) ? p : p.slice(p.lastIndexOf(S.sep) + 1));
const relTo = (p, base) => (p === base ? '' : p.slice(base.endsWith(S.sep) ? base.length : base.length + 1));
function resolvePath(input, cwd) {
  let p = input.trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = S.home + p.slice(1);
  const abs = (S.sep === '/' && p.startsWith('/')) || /^[A-Za-z]:/.test(p) || p.startsWith('\\\\');
  return norm(abs ? p : join(cwd, p));
}

// ---------------------------------------------------------------- data

function mkFile(dir, name, size, mtime, hidden, ro, link, mode) {
  const dot = name.lastIndexOf('.');
  return {
    name,
    dir,
    path: join(dir, name),
    size,
    mtime,
    hidden,
    ro,
    link,
    mode,
    lname: name.toLowerCase(),
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

async function loadDir(path, force = false) {
  if (!force && cache.has(path)) return cache.get(path);
  const r = await rpc('list', { path });
  const dirs = [];
  const files = [];
  for (const e of r.entries) {
    if (e.d) dirs.push(e);
    else files.push(mkFile(path, e.n, e.s, e.m, e.h, e.r, e.l, e.x));
  }
  dirs.sort((a, b) => collator.compare(a.n, b.n));
  const d = { dirs, files };
  cache.set(path, d);
  return d;
}

const SORTS = {
  name: (a, b) => 0,
  ext: (a, b) => (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0),
  size: (a, b) => a.size - b.size,
  date: (a, b) => a.mtime - b.mtime,
  path: (a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0),
};

// ---------------------------------------------------------------- pane

const ROW = 22;
const MODE_LABEL = { dir: 'DIR', branch: 'BRANCH', showall: 'SHOWALL', global: 'GLOBAL' };

class Pane {
  constructor(id, el) {
    this.id = id;
    this.el = el;
    this.root = '/';
    this.cwd = '/';
    this.expanded = new Set();
    this.errs = new Map();
    this.nodes = [];
    this.treeIdx = 0;
    this.mode = 'dir';
    this.flat = [];
    this.flatBase = null;
    this.files = [];
    this.fileIdx = 0;
    this.focus = 'tree';
    this.zoom = false;
    this.tags = new Map();
    this.tagBytes = 0;
    this.spec = '*';
    this.taggedOnly = false;
    this.sort = { key: 'name', desc: false };
    this.fmt = 0;
    this.hist = [];
    this.hpos = -1;
    this.stat = { total: 0, totalB: 0, match: 0, matchB: 0 };
    this.seq = 0;
    this.anchor = 0;

    this.headEl = h('div', { class: 'pane-head' });
    this.treeEl = h('div', { class: 'tree' });
    this.colsEl = h('div', { class: 'cols' });
    this.filesEl = h('div', { class: 'files' });
    this.emptyEl = h('div', { class: 'empty' });
    el.append(this.headEl, this.treeEl, this.colsEl, h('div', { class: 'files-wrap' }, this.filesEl, this.emptyEl));
    this.treeList = new VList(this.treeEl, ROW, i => this.treeRow(i));
    this.fileList = new VList(this.filesEl, ROW, i => this.fileRow(i));

    el.addEventListener('mousedown', () => activate(this.id), true);
    this.treeEl.addEventListener('mousedown', e => this.treeClick(e));
    this.treeEl.addEventListener('dblclick', e => {
      const row = e.target.closest('.row');
      if (row) this.toggle(this.nodes[Number(row.dataset.i)]);
    });
    this.filesEl.addEventListener('mousedown', e => this.fileClick(e));
    this.filesEl.addEventListener('dblclick', e => {
      if (e.target.closest('.row')) run('open');
    });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY);
    });
    this.colsEl.addEventListener('click', e => {
      const key = e.target.dataset.sort;
      if (key) this.setSort(key);
    });
    this.headEl.addEventListener('click', e => {
      const path = e.target.dataset.path;
      if (path) this.cd(path).then(renderAll);
    });
  }

  // ----- tree

  rebuild() {
    const out = [];
    const walk = (path, name, depth) => {
      const c = cache.get(path);
      const kids = c ? c.dirs.filter(d => S.hidden || !d.h) : null;
      out.push({ path, name, depth, kids: kids ? kids.length : -1, err: this.errs.get(path) });
      if (kids && this.expanded.has(path)) for (const d of kids) walk(join(path, d.n), d.n, depth + 1);
    };
    walk(this.root, this.root, 0);
    this.nodes = out;
    let at = this.cwd;
    let idx = -1;
    while (at && (idx = out.findIndex(n => n.path === at)) < 0) at = parentOf(at);
    this.treeIdx = Math.max(0, idx);
    this.cwd = out[this.treeIdx].path;
  }

  /** Make `path` the current directory, logging a new root if it lies outside the tree. */
  async cd(path, { push = true } = {}) {
    path = norm(path);
    if (!isUnder(path, this.root)) {
      this.root = rootOf(path);
      this.expanded = new Set();
    }
    const chain = [];
    for (let p = path; p; p = parentOf(p)) {
      chain.unshift(p);
      if (p === this.root) break;
    }
    const seq = ++this.seq;
    for (const p of chain) {
      try {
        await loadDir(p);
        this.errs.delete(p);
      } catch (e) {
        this.errs.set(p, e.message);
      }
      if (p !== path || p === this.root) this.expanded.add(p);
    }
    if (seq !== this.seq) return;
    this.cwd = path;
    this.mode = 'dir';
    this.taggedOnly = false;
    if (push && this.hist[this.hpos] !== path) {
      this.hist.splice(this.hpos + 1);
      this.hist.push(path);
      this.hpos = this.hist.length - 1;
    }
    this.rebuild();
    this.refreshFiles();
    refreshDisk(this);
    saveSoon();
  }

  async log(root, cwd = root) {
    this.root = norm(root);
    this.expanded = new Set([this.root]);
    this.tags.clear();
    this.tagBytes = 0;
    await this.cd(cwd);
  }

  /** Tree cursor movement: instant highlight, file window follows when the listing arrives. */
  async select(idx) {
    idx = Math.max(0, Math.min(this.nodes.length - 1, idx));
    const node = this.nodes[idx];
    if (!node) return;
    this.treeIdx = idx;
    this.cwd = node.path;
    this.mode = 'dir';
    const seq = ++this.seq;
    if (!cache.has(node.path)) {
      this.files = [];
      this.render();
      try {
        await loadDir(node.path);
        this.errs.delete(node.path);
      } catch (e) {
        this.errs.set(node.path, e.message);
      }
      if (seq !== this.seq) return;
      this.rebuild();
    }
    this.refreshFiles();
    this.render();
    saveSoon();
  }

  async toggle(node, want) {
    if (!node) return;
    const open = want ?? !this.expanded.has(node.path);
    if (open) {
      try {
        await loadDir(node.path);
      } catch (e) {
        this.errs.set(node.path, e.message);
      }
      this.expanded.add(node.path);
    } else {
      this.expanded.delete(node.path);
      if (isUnder(this.cwd, node.path)) this.cwd = node.path;
    }
    this.rebuild();
    this.refreshFiles();
    this.render();
  }

  async expandBranch() {
    const queue = [this.cwd];
    let n = 0;
    while (queue.length && n < 3000) {
      const p = queue.shift();
      let d;
      try {
        d = await loadDir(p);
      } catch {
        continue;
      }
      this.expanded.add(p);
      n++;
      for (const k of d.dirs) if ((S.hidden || !k.h) && !k.l) queue.push(join(p, k.n));
    }
    if (queue.length) status('Branch is very large: expanded the first 3,000 folders', 'warn');
    this.rebuild();
    this.render();
  }

  treeRow(i) {
    const n = this.nodes[i];
    if (!n) return null;
    const open = this.expanded.has(n.path);
    return h(
      'div',
      { class: `row${i === this.treeIdx ? ' cur' : ''}${n.err ? ' err' : ''}`, title: n.err || n.path },
      h('span', { class: 'indent', style: { width: `${n.depth * 16}px` } }),
      h('span', { class: `twisty${n.kids < 0 ? ' unknown' : ''}` }, n.kids === 0 ? '' : open && n.kids > 0 ? '▾' : '▸'),
      h('span', { class: 'folder' }, open && n.kids !== 0 ? '📂' : '📁'),
      h('span', { class: 'c-name' }, n.name)
    );
  }

  treeClick(e) {
    const row = e.target.closest('.row');
    if (!row) return;
    const i = Number(row.dataset.i);
    this.focus = 'tree';
    if (e.target.classList.contains('twisty')) this.toggle(this.nodes[i]);
    else this.select(i);
  }

  // ----- files

  current() {
    return this.files[this.fileIdx];
  }

  refreshFiles(keepPath = this.current()?.path) {
    const base = this.mode === 'dir' ? cache.get(this.cwd)?.files || [] : this.flat;
    const match = specToFilter(this.spec);
    const st = { total: 0, totalB: 0, match: 0, matchB: 0 };
    const list = [];
    for (const f of base) {
      if (f.hidden && !S.hidden) continue;
      st.total++;
      st.totalB += f.size;
      if (!match(f.name)) continue;
      if (this.taggedOnly && !this.tags.has(f.path)) continue;
      st.match++;
      st.matchB += f.size;
      list.push(f);
    }
    const byKey = SORTS[this.sort.key];
    const byName = list.length < 20000 ? (a, b) => collator.compare(a.name, b.name) : (a, b) => (a.lname < b.lname ? -1 : a.lname > b.lname ? 1 : 0);
    const dir = this.sort.desc ? -1 : 1;
    list.sort((a, b) => dir * (byKey(a, b) || byName(a, b)));
    this.files = list;
    this.stat = st;
    const at = keepPath ? list.findIndex(f => f.path === keepPath) : -1;
    this.fileIdx = at >= 0 ? at : Math.max(0, Math.min(this.fileIdx, list.length - 1));
    if (!list.length && this.focus === 'files' && this.mode === 'dir') this.focus = 'tree';
  }

  async loadFlat(mode) {
    const roots = mode === 'branch' ? [this.cwd] : mode === 'showall' ? [this.root] : [...new Set(S.panes.map(p => p.root))];
    const tops = roots.filter(r => !roots.some(o => o !== r && isUnder(r, o)));
    status(`Logging ${tops.join(', ')}…`);
    const walks = await Promise.all(tops.map(path => rpc('walk', { path, hidden: S.hidden })));
    const flat = [];
    for (const w of walks) for (const [di, n, s, m, fl] of w.files) flat.push(mkFile(w.dirs[di], n, s, m, !!(fl & 1), !!(fl & 2), !!(fl & 4), 0));
    this.flat = flat;
    this.flatBase = mode === 'global' && tops.length > 1 ? null : tops[0];
    const cut = walks.some(w => w.truncated);
    status(cut ? `Stopped at ${fmtBytes(flat.length)} files: narrow the scope with Branch` : `${fmtBytes(flat.length)} files logged`, cut ? 'warn' : '');
  }

  async setMode(mode) {
    if (mode !== 'dir') {
      try {
        await this.loadFlat(mode);
      } catch (e) {
        return status(e.message, 'err');
      }
      this.focus = 'files';
    }
    this.mode = mode;
    if (mode === 'dir') this.taggedOnly = false;
    this.refreshFiles();
  }

  setSort(key) {
    this.sort = this.sort.key === key ? { key, desc: !this.sort.desc } : { key, desc: key === 'size' || key === 'date' };
    this.refreshFiles();
    this.render();
    saveSoon();
  }

  setTag(f, on) {
    const had = this.tags.has(f.path);
    if (on && !had) {
      this.tags.set(f.path, f);
      this.tagBytes += f.size;
    } else if (!on && had) {
      this.tagBytes -= this.tags.get(f.path).size;
      this.tags.delete(f.path);
    }
  }

  fileRow(i) {
    const f = this.files[i];
    if (!f) return null;
    const tagged = this.tags.has(f.path);
    const flat = this.mode !== 'dir';
    return h(
      'div',
      { class: `row${i === this.fileIdx ? ' cur' : ''}${tagged ? ' tagged' : ''}${f.hidden ? ' dim' : ''}` },
      h('span', { class: 'c-tag' }, tagged ? '◆' : ''),
      h('span', { class: 'c-name' }, f.name, f.link && h('span', { class: 'link' }, ' ↗')),
      flat && this.fmt === 0 && h('span', { class: 'c-path' }, this.flatBase ? relTo(f.dir, this.flatBase) || '.' : f.dir),
      this.fmt < 2 && h('span', { class: 'c-size' }, fmtBytes(f.size)),
      this.fmt === 0 && h('span', { class: 'c-date' }, fmtDate(f.mtime)),
      this.fmt === 0 && h('span', { class: 'c-attr' }, fmtMode(f))
    );
  }

  fileClick(e) {
    const row = e.target.closest('.row');
    this.focus = 'files';
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.shiftKey) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      for (let k = a; k <= b; k++) this.setTag(this.files[k], true);
    } else if (e.ctrlKey || e.metaKey) {
      this.setTag(this.files[i], !this.tags.has(this.files[i].path));
      this.anchor = i;
    } else this.anchor = i;
    this.fileIdx = i;
  }

  // ----- drawing

  render() {
    const isActive = S.active === this.id;
    const flat = this.mode !== 'dir';
    this.el.className = `pane fmt-${this.fmt}${isActive ? ' active' : ''}${flat ? ' flat' : ''}${this.zoom ? ' zoom' : ''} focus-${this.focus}`;

    const shown = flat && this.current() ? this.current().dir : this.cwd;
    const crumbs = [];
    for (let p = shown; p; p = parentOf(p)) crumbs.unshift(p);
    set(this.headEl, h('span', { class: `badge mode-${this.mode}` }, MODE_LABEL[this.mode]),
      h(
        'span',
        { class: 'crumbs', title: shown },
        crumbs.map((p, i) => [
          i > 1 || (i === 1 && !crumbs[0].endsWith(S.sep)) ? h('span', { class: 'sep' }, S.sep) : null,
          h('span', { class: 'crumb', 'data-path': p }, i === 0 ? p : baseName(p)),
        ])
      ),
      this.taggedOnly && h('span', { class: 'badge warn' }, 'TAGGED'),
      this.spec !== '*' && h('span', { class: 'badge spec', title: 'Filespec (F to change)' }, this.spec)
    );

    // Long paths keep their tail (the current folder) in view.
    const crumbsEl = this.headEl.querySelector('.crumbs');
    crumbsEl.scrollLeft = crumbsEl.scrollWidth;

    const arrow = k => (this.sort.key === k ? (this.sort.desc ? ' ▾' : ' ▴') : '');
    set(this.colsEl, h('span', { class: 'c-tag' }),
      h('span', { class: 'c-name', 'data-sort': 'name' }, `Name${arrow('name')}`, h('span', { class: 'ext-sort', 'data-sort': 'ext' }, `ext${arrow('ext')}`)),
      flat && this.fmt === 0 && h('span', { class: 'c-path', 'data-sort': 'path' }, `Folder${arrow('path')}`),
      this.fmt < 2 && h('span', { class: 'c-size', 'data-sort': 'size' }, `Size${arrow('size')}`),
      this.fmt === 0 && h('span', { class: 'c-date', 'data-sort': 'date' }, `Modified${arrow('date')}`),
      this.fmt === 0 && h('span', { class: 'c-attr' }, 'Attr')
    );

    this.treeList.set(this.nodes.length);
    this.treeList.reveal(this.treeIdx);
    this.fileList.set(this.files.length);
    this.fileList.reveal(this.fileIdx);

    const err = this.errs.get(this.cwd);
    this.emptyEl.textContent = this.files.length
      ? ''
      : err && !flat
        ? err
        : this.stat.total
          ? this.taggedOnly
            ? 'No tagged files here'
            : `No files match ${this.spec}`
          : 'No files';
    this.emptyEl.classList.toggle('err', !!err && !flat);
  }

  // ----- keyboard navigation (commands are handled globally)

  nav(e) {
    const k = e.key;
    if (this.focus === 'tree') {
      const node = this.nodes[this.treeIdx];
      const page = this.treeList.page();
      if (k === 'ArrowUp') this.select(this.treeIdx - 1);
      else if (k === 'ArrowDown') this.select(this.treeIdx + 1);
      else if (k === 'PageUp') this.select(this.treeIdx - page);
      else if (k === 'PageDown') this.select(this.treeIdx + page);
      else if (k === 'Home') this.select(0);
      else if (k === 'End') this.select(this.nodes.length - 1);
      else if (k === 'ArrowRight') {
        if (!this.expanded.has(node.path) || node.kids < 0) this.toggle(node, true);
        else if (node.kids > 0) this.select(this.treeIdx + 1);
      } else if (k === 'ArrowLeft') {
        if (this.expanded.has(node.path) && node.kids > 0) this.toggle(node, false);
        else {
          const par = parentOf(node.path);
          const i = this.nodes.findIndex(n => n.path === par);
          if (i >= 0) this.select(i);
        }
      } else if (k === '+' || k === '=') this.toggle(node, true);
      else if (k === '-') this.toggle(node, false);
      else if (k === '*') this.expandBranch();
      else if (k === 'Enter') {
        if (this.files.length) this.focus = 'files';
        else status(this.stat.total ? `No files match ${this.spec}` : 'No files in this folder');
        this.render();
      } else if (k === 'Backspace') run('parent');
      else return false;
      return true;
    }

    const move = i => {
      this.fileIdx = Math.max(0, Math.min(this.files.length - 1, i));
      this.anchor = this.fileIdx;
      this.render();
    };
    const page = this.fileList.page();
    if (k === 'ArrowUp') move(this.fileIdx - 1);
    else if (k === 'ArrowDown') move(this.fileIdx + 1);
    else if (k === 'PageUp') move(this.fileIdx - page);
    else if (k === 'PageDown') move(this.fileIdx + page);
    else if (k === 'Home') move(0);
    else if (k === 'End') move(this.files.length - 1);
    else if (k === ' ' || k === 'Insert') {
      const f = this.current();
      if (f) {
        this.setTag(f, !this.tags.has(f.path));
        move(this.fileIdx + 1);
      }
    } else if (k === 'Enter') run('open');
    else if (k === 'Escape' || k === 'Backspace' || k === 'ArrowLeft') {
      if (this.mode !== 'dir') this.setMode('dir').then(renderAll);
      else {
        this.focus = 'tree';
        this.zoom = false;
        this.render();
      }
    } else return false;
    return true;
  }
}

// ---------------------------------------------------------------- chrome

let statusTimer;
function status(msg, kind = '') {
  const el = $('#status-msg');
  el.textContent = msg;
  el.className = kind;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (el.textContent = ''), kind ? 9000 : 5000);
}

async function refreshDisk(pane) {
  try {
    disks.set(pane.root, await rpc('disk', { path: pane.cwd }));
    renderStats();
  } catch {
    /* statistics are optional */
  }
}

function renderStats() {
  const p = active();
  const d = disks.get(p.root);
  const f = p.focus === 'files' ? p.current() : null;
  const used = d && d.total ? 1 - d.free / d.total : 0;
  const pair = (label, n, bytes) =>
    h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-n' }, `${fmtBytes(n)} files`), h('div', { class: 'stat-b' }, `${fmtBytes(bytes)} bytes`));
  set($('#stats'), h('div', { class: 'stat-h' }, 'FILE'),
    h('div', { class: 'stat-v spec' }, p.spec === '*' ? '*.*' : p.spec),
    h('div', { class: 'stat-h' }, 'DISK'),
    h('div', { class: 'stat-v', title: p.root }, d?.name ? `${p.root}  ${d.name}` : p.root),
    d && d.total ? h('div', { class: 'meter' }, h('div', { class: `meter-fill${used > 0.9 ? ' full' : ''}`, style: { width: `${(used * 100).toFixed(1)}%` } })) : null,
    d && d.total ? h('div', { class: 'stat-b' }, `${fmtSize(d.free)} free of ${fmtSize(d.total)}`) : null,
    h('div', { class: 'stat-h' }, `${MODE_LABEL[p.mode]} Statistics`),
    pair('Total', p.stat.total, p.stat.totalB),
    pair('Matching', p.stat.match, p.stat.matchB),
    pair('Tagged', p.tags.size, p.tagBytes),
    h('div', { class: 'stat-h' }, f ? 'Current File' : 'Current Directory'),
    h('div', { class: 'stat-v name' }, f ? f.name : baseName(p.cwd)),
    f ? h('div', { class: 'stat-b' }, `${fmtBytes(f.size)} bytes`) : h('div', { class: 'stat-b' }, `${fmtBytes(p.stat.totalB)} bytes`),
    f ? h('div', { class: 'stat-b' }, fmtDate(f.mtime)) : null,
    f ? h('div', { class: 'stat-b mono' }, fmtMode(f)) : null,
    h('div', { class: 'stat-h' }, 'Options'),
    h('div', { class: 'stat-b' }, `Sort: ${p.sort.key} ${p.sort.desc ? '↓' : '↑'}`),
    h('div', { class: 'stat-b' }, `Hidden files: ${S.hidden ? 'shown' : 'off'}`),
    h('div', { class: 'stat-b' }, `Delete: ${S.trash ? 'to trash' : 'permanent'}`)
  );
}

function renderAll() {
  const main = $('#main');
  main.classList.toggle('split', S.split && !S.autoview);
  main.classList.toggle('autoview', S.autoview);
  S.panes.forEach((p, i) => {
    p.el.hidden = i !== S.active && (!S.split || S.autoview);
    if (!p.el.hidden) p.render();
  });
  renderStats();
  renderCmdbar();
  if (S.autoview) previewSoon();
}

function activate(id) {
  if (S.active === id) return;
  S.active = id;
  setTimeout(renderAll);
}

// ---------------------------------------------------------------- viewer / autoview

const IMAGES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };

async function loadContent(file, cap) {
  if (IMAGES[file.ext] && file.size <= 24 << 20) {
    const r = await rpc('read', { path: file.path, len: 24 << 20 });
    return { kind: 'image', url: `data:${IMAGES[file.ext]};base64,${r.b64}` };
  }
  const r = await rpc('read', { path: file.path, len: cap });
  const bytes = b64ToBytes(r.b64);
  return { kind: bytes.subarray(0, 8192).includes(0) ? 'hex' : 'text', bytes, truncated: r.size > bytes.length };
}

function contentEl(c, kind = c.kind) {
  if (c.kind === 'image') return h('div', { class: 'view-image' }, h('img', { src: c.url, alt: '' }));
  const pre = h('pre', { class: `view-${kind}` });
  pre.textContent = kind === 'hex' ? hexDump(c.bytes) : new TextDecoder().decode(c.bytes);
  return pre;
}

let previewTimer;
let previewSeq = 0;
function previewSoon() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const el = $('#preview');
    const p = active();
    const f = p.focus === 'files' ? p.current() : null;
    const seq = ++previewSeq;
    if (!f) {
      set(el, h('div', { class: 'pane-head' }, h('span', { class: 'badge' }, 'AUTOVIEW')), h('div', { class: 'empty' }, 'Move to a file to preview it'));
      return;
    }
    let body;
    try {
      const c = await loadContent(f, 256 * 1024);
      body = contentEl(c);
      if (c.truncated) body = h('div', { class: 'view-wrap' }, body, h('div', { class: 'view-note' }, 'Preview shows the first 256 KB. Press V for the full viewer.'));
    } catch (e) {
      body = h('div', { class: 'empty err' }, e.message);
    }
    if (seq !== previewSeq) return;
    set(el, h('div', { class: 'pane-head' }, h('span', { class: 'badge' }, 'AUTOVIEW'), h('span', { class: 'crumbs' }, f.name), h('span', { class: 'badge spec' }, fmtSize(f.size))),
      h('div', { class: 'view-body' }, body)
    );
  }, 90);
}

async function viewFile(f) {
  let c;
  try {
    c = await loadContent(f, 4 << 20);
  } catch (e) {
    return status(e.message, 'err');
  }
  let kind = c.kind;
  let wrap = false;
  const body = h('div', { class: 'view-body' });
  const hint = h('span', { class: 'view-hint' });
  const draw = () => {
    set(body, contentEl(c, kind));
    body.classList.toggle('wrap', wrap);
    hint.textContent =
      c.kind === 'image'
        ? 'Esc close'
        : `${kind === 'hex' ? 'T text' : 'H hex'} · W wrap ${wrap ? 'off' : 'on'} · Esc close${c.truncated ? ' · showing first 4 MB' : ''}${kind === 'hex' && c.bytes.length > 65536 ? ' · hex shows first 64 KB' : ''}`;
  };
  draw();
  const m = openModal({
    title: h('span', {}, `${f.path}  `, h('small', {}, `${fmtBytes(f.size)} bytes · ${fmtDate(f.mtime)}`)),
    body: h('div', { class: 'viewer' }, body, hint),
    cls: 'full',
    onKey: (e, close) => {
      const k = e.key.toLowerCase();
      if (k === 'q' || k === 'v' || k === 'f3') close(null);
      else if (c.kind !== 'image' && k === 'h') kind = 'hex';
      else if (c.kind !== 'image' && k === 't') kind = 'text';
      else if (k === 'w') wrap = !wrap;
      else if (k === 'arrowdown') body.scrollTop += 44;
      else if (k === 'arrowup') body.scrollTop -= 44;
      else if (k === 'pagedown' || k === ' ') body.scrollTop += body.clientHeight - 44;
      else if (k === 'pageup') body.scrollTop -= body.clientHeight - 44;
      else if (k === 'home') body.scrollTop = 0;
      else if (k === 'end') body.scrollTop = body.scrollHeight;
      else return false;
      draw();
      return true;
    },
  });
  m.box.setAttribute('aria-label', `View ${f.name}`);
  await m.promise;
}

// ---------------------------------------------------------------- jobs

const sleep = ms => new Promise(r => setTimeout(r, ms));
const JOB_TITLE = { copy: 'Copying', move: 'Moving', delete: 'Deleting' };

async function runJob(kind, items, opts = {}) {
  S.busy = true;
  try {
    const id = await rpc('job_start', { kind, items, ...opts });
    const started = Date.now();
    const fill = h('div', { class: 'bar-fill' });
    const cur = h('div', { class: 'job-current' });
    const count = h('div', { class: 'job-count' });
    let modal = null;
    let st;
    for (;;) {
      st = await rpc('job_status', { id });
      if (st.finished) break;
      if (!modal && Date.now() - started > 300) {
        modal = openModal({
          title: JOB_TITLE[kind],
          body: h('div', {}, cur, h('div', { class: 'bar' }, fill), count),
          buttons: [{ id: 'cancel', label: 'Cancel' }],
          cls: 'progress',
        });
        modal.promise.then(why => {
          if (why !== 'done') rpc('job_cancel', { id }).catch(() => {});
        });
      }
      const frac = st.total_bytes ? st.done_bytes / st.total_bytes : st.total_files ? st.done_files / st.total_files : 0;
      fill.style.width = `${(frac * 100).toFixed(1)}%`;
      cur.textContent = st.current;
      count.textContent = `${fmtBytes(st.done_files)} of ${fmtBytes(st.total_files)} files${st.total_bytes ? ` · ${fmtSize(st.done_bytes)} of ${fmtSize(st.total_bytes)}` : ''}`;
      await sleep(100);
    }
    if (modal) modal.close('done');
    if (st.errors.length) {
      await confirm({
        title: `${st.errors.length} problem${st.errors.length > 1 ? 's' : ''}`,
        message: 'Some items could not be processed:',
        detail: st.errors.slice(0, 30).join('\n') + (st.errors.length > 30 ? `\n… and ${st.errors.length - 30} more` : ''),
        buttons: [{ id: 'ok', label: 'OK', kind: 'primary' }],
      });
    }
    return st;
  } finally {
    S.busy = false;
  }
}

/** Drop the listing cache and bring both panes back to where they were. */
async function reloadAll({ light = false } = {}) {
  cache.clear();
  for (const p of S.panes) {
    const keep = p.current()?.path;
    p.errs.clear();
    await Promise.all([...p.expanded].map(d => loadDir(d).catch(() => p.expanded.delete(d))));
    let cwd = p.cwd;
    for (;;) {
      try {
        await loadDir(cwd);
        break;
      } catch (e) {
        const par = parentOf(cwd);
        if (!par || !isUnder(par, p.root)) {
          p.errs.set(cwd, e.message);
          break;
        }
        cwd = par;
      }
    }
    p.cwd = cwd;
    if (p.mode !== 'dir' && !light) await p.loadFlat(p.mode).catch(() => {});
    p.rebuild();
    p.refreshFiles(keep);
    refreshDisk(p);
  }
  renderAll();
}

// ---------------------------------------------------------------- operations

const sumSize = list => list.reduce((n, f) => n + f.size, 0);
const plural = (n, word) => `${fmtBytes(n)} ${word}${n === 1 ? '' : 's'}`;

/** Tagged files if any, otherwise the file under the cursor. */
function taggedOrCurrent() {
  const p = active();
  if (p.tags.size) return [...p.tags.values()];
  const f = p.focus === 'files' ? p.current() : null;
  return f ? [f] : [];
}
function currentOnly() {
  const p = active();
  const f = p.focus === 'files' ? p.current() : null;
  if (!f) status('No file selected');
  return f ? [f] : [];
}
const dirAsItem = path => ({ path, name: baseName(path), dir: parentOf(path), size: 0, isDir: true });

async function transfer(kind, srcs, { withPaths = false } = {}) {
  if (!srcs.length) return status(`Nothing to ${kind}: tag files first or move to a file`);
  const p = active();
  const single = srcs.length === 1;
  const verb = kind === 'copy' ? 'Copy' : 'Move';
  const fields = [];
  if (single && !withPaths) fields.push({ name: 'as', label: 'as', value: srcs[0].name });
  fields.push({
    name: 'to',
    label: 'to',
    value: S.split ? other().cwd : S.lastDest || p.cwd,
    hint: 'Destination folder: created if missing. ~ and relative paths work.',
  });
  const v = await prompt({
    title: single ? `${verb} ${srcs[0].isDir ? 'folder' : 'file'} ${srcs[0].name}` : `${verb} ${plural(srcs.length, 'tagged file')}${withPaths ? ' with paths' : ''}`,
    message: single ? null : `${fmtSize(sumSize(srcs))} in total${withPaths ? '. The folder structure is recreated under the destination.' : ''}`,
    fields,
    okLabel: verb,
  });
  if (!v || !v.to.trim()) return;
  const dest = resolvePath(v.to, p.cwd);
  S.lastDest = dest;
  const base = p.mode !== 'dir' && p.flatBase ? p.flatBase : p.root;
  const items = srcs.map(f => {
    let d = dest;
    if (withPaths && isUnder(f.dir, base)) {
      const rel = relTo(f.dir, base);
      if (rel) d = join(dest, rel);
    }
    return { src: f.path, dst: join(d, (single && v.as && v.as.trim()) || f.name) };
  });

  let policy = 'skip';
  const there = await rpc('exists', { paths: items.map(i => i.dst) });
  const clash = items.filter((_, i) => there[i]);
  if (clash.length) {
    const a = await confirm({
      title: 'Already in the destination',
      message: `${clash.length} of ${plural(items.length, 'item')} already exist${clash.length === 1 ? 's' : ''} there.`,
      detail: clash.slice(0, 8).map(c => c.dst).join('\n') + (clash.length > 8 ? `\n… and ${clash.length - 8} more` : ''),
      buttons: [
        { id: 'skip', label: 'Skip existing', kind: 'primary' },
        { id: 'overwrite', label: 'Overwrite', kind: 'danger' },
        { id: 'rename', label: 'Keep both' },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    if (!a || a === 'cancel') return;
    policy = a;
  }
  const st = await runJob(kind, items, { policy });
  for (const f of srcs) p.setTag(f, false);
  await reloadAll();
  const done = st.done_files - st.skipped;
  status(`${kind === 'copy' ? 'Copied' : 'Moved'} ${plural(done, 'file')} to ${dest}${st.skipped ? `, skipped ${st.skipped}` : ''}${st.cancelled ? ' (cancelled)' : ''}`, st.errors.length ? 'warn' : 'ok');
}

async function remove(srcs, permanent = !S.trash) {
  if (!srcs.length) return status('Nothing to delete');
  const p = active();
  const what = srcs.length === 1 ? `${srcs[0].isDir ? 'folder' : 'file'} “${srcs[0].name}”${srcs[0].isDir ? ' and everything in it' : ''}` : `${plural(srcs.length, 'tagged file')} (${fmtSize(sumSize(srcs))})`;
  const a = await confirm({
    title: permanent ? 'Delete permanently' : 'Move to trash',
    message: permanent ? `Permanently delete ${what}? This cannot be undone.` : `Move ${what} to the trash?`,
    detail: srcs.length > 1 ? srcs.slice(0, 8).map(f => f.path).join('\n') + (srcs.length > 8 ? `\n… and ${srcs.length - 8} more` : '') : null,
    buttons: [
      { id: 'yes', label: permanent ? 'Delete' : 'Trash', kind: permanent ? 'danger' : 'primary' },
      { id: 'no', label: 'Cancel' },
    ],
  });
  if (a !== 'yes') return;
  const st = await runJob('delete', srcs.map(f => ({ src: f.path })), { trash: !permanent });
  for (const f of srcs) p.setTag(f, false);
  await reloadAll();
  status(`${permanent ? 'Deleted' : 'Trashed'} ${plural(st.done_files - st.errors.length, 'item')}`, st.errors.length ? 'warn' : 'ok');
}

async function renameOne(item) {
  const v = await prompt({ title: `Rename ${item.isDir ? 'folder' : 'file'}`, fields: [{ name: 'name', label: 'to', value: item.name }], okLabel: 'Rename' });
  const name = v?.name.trim();
  if (!name || name === item.name) return;
  if (/[\\/]/.test(name)) return status('A name cannot contain a path separator', 'err');
  const dst = join(item.dir, name);
  if ((await rpc('exists', { paths: [dst] }))[0] && dst.toLowerCase() !== item.path.toLowerCase()) return status(`“${name}” already exists`, 'err');
  const p = active();
  const st = await runJob('move', [{ src: item.path, dst }], { policy: 'overwrite' });
  if (st.errors.length) return reloadAll();
  if (item.isDir) {
    // Keep the tree where it was: rewrite paths below the renamed folder.
    for (const pane of S.panes) {
      const swap = x => (isUnder(x, item.path) ? dst + x.slice(item.path.length) : x);
      pane.expanded = new Set([...pane.expanded].map(swap));
      pane.cwd = swap(pane.cwd);
    }
  } else p.setTag(item, false);
  await reloadAll();
  if (!item.isDir) {
    const i = p.files.findIndex(f => f.path === dst);
    if (i >= 0) p.fileIdx = i;
    renderAll();
  }
  status(`Renamed to ${name}`, 'ok');
}

async function renameTagged() {
  const srcs = taggedOrCurrent();
  if (!srcs.length) return status('Nothing to rename');
  if (srcs.length === 1) return renameOne(srcs[0]);
  const plan = mask => srcs.map((f, i) => ({ f, name: applyMask(mask, f, i) }));
  const v = await prompt({
    title: `Rename ${plural(srcs.length, 'tagged file')}`,
    message: 'Wildcards keep parts of the old name; tokens: {name} {ext} {n:3} {date}',
    fields: [{ name: 'mask', label: 'mask', value: '*.*' }],
    okLabel: 'Rename',
    onInput: ({ mask }) =>
      plan(mask || '*.*')
        .slice(0, 6)
        .map(x => `${x.f.name}  →  ${x.name}`)
        .join('\n') + (srcs.length > 6 ? `\n… ${srcs.length - 6} more` : ''),
  });
  if (!v) return;
  const items = plan(v.mask || '*.*')
    .filter(x => x.name && x.name !== x.f.name)
    .map(x => ({ src: x.f.path, dst: join(x.f.dir, x.name) }));
  if (!items.length) return status('Nothing changes with that mask');
  if (items.some(i => /[\\/]/.test(i.dst.slice(parentOf(i.src).length + 1)))) return status('Names cannot contain a path separator', 'err');
  if (new Set(items.map(i => i.dst.toLowerCase())).size !== items.length) return status('That mask gives several files the same name: add {n}', 'err');
  const there = await rpc('exists', { paths: items.map(i => i.dst) });
  const taken = items.filter((it, i) => there[i] && !items.some(o => o.src === it.dst));
  if (taken.length) return status(`${baseName(taken[0].dst)} already exists`, 'err');
  const p = active();
  const st = await runJob('move', items, { policy: 'skip' });
  p.tags.clear();
  p.tagBytes = 0;
  await reloadAll();
  status(`Renamed ${plural(st.done_files - st.skipped, 'file')}`, st.errors.length ? 'warn' : 'ok');
}

async function makeDir() {
  const p = active();
  const v = await prompt({ title: `Make folder in ${baseName(p.cwd)}`, fields: [{ name: 'name', label: 'name', value: '', hint: 'Use / to create nested folders in one go.' }], okLabel: 'Create' });
  const name = v?.name.trim();
  if (!name) return;
  const path = resolvePath(name, p.cwd);
  try {
    await rpc('mkdir', { path });
  } catch (e) {
    return status(e.message, 'err');
  }
  p.expanded.add(p.cwd);
  await reloadAll();
  status(`Created ${path}`, 'ok');
}

async function newFile() {
  const p = active();
  const v = await prompt({ title: `New file in ${baseName(p.cwd)}`, fields: [{ name: 'name', label: 'name', value: '' }], okLabel: 'Create' });
  const name = v?.name.trim();
  if (!name) return;
  const path = resolvePath(name, p.cwd);
  try {
    await rpc('touch', { path });
  } catch (e) {
    return status(e.message, 'err');
  }
  await reloadAll();
  const i = p.files.findIndex(f => f.path === path);
  if (i >= 0) {
    p.fileIdx = i;
    p.focus = 'files';
  }
  renderAll();
}

async function setFilespec() {
  const p = active();
  const v = await prompt({
    title: 'Filespec',
    fields: [{ name: 'spec', label: 'show', value: p.spec === '*' ? '' : p.spec, placeholder: '*.*', hint: 'Examples:  *.jpg *.png   ·   report*   ·   *.rs -*test*   ·   invoice (contains)' }],
    okLabel: 'Apply',
  });
  if (!v) return;
  p.spec = v.spec.trim() || '*';
  p.refreshFiles();
  renderAll();
  saveSoon();
}

async function logDisk() {
  const p = active();
  const seen = new Set();
  const items = [];
  const add = (path, detail) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    items.push({ label: path, detail, value: path });
  };
  try {
    S.roots = await rpc('roots');
  } catch {
    /* keep the list from start-up */
  }
  for (const r of S.roots) add(r.path, r.total ? `${r.name ? `${r.name} · ` : ''}${fmtSize(r.free)} free of ${fmtSize(r.total)}` : r.name);
  add(S.home, 'Home folder');
  add(p.cwd, 'This folder only');
  add(other().cwd, 'Other pane’s folder');
  if (parentOf(p.root)) add(parentOf(p.root), 'One level above the current root');
  const r = await pick({ title: 'Log disk or folder', items, placeholder: 'Pick below, or type a path and press Enter', allowInput: true });
  if (!r) return;
  const path = typeof r === 'string' ? r : resolvePath(r.input, p.cwd);
  try {
    const st = await rpc('stat', { path });
    if (!st.dir) throw new Error(`${path} is not a folder`);
  } catch (e) {
    return status(e.message, 'err');
  }
  await p.log(path);
  renderAll();
  status(`Logged ${path}`);
}

async function goTo() {
  const p = active();
  const v = await prompt({ title: 'Go to', fields: [{ name: 'path', label: 'path', value: p.cwd, hint: 'A folder, or a file to jump to. ~ and relative paths work.' }], okLabel: 'Go' });
  if (!v || !v.path.trim()) return;
  const path = resolvePath(v.path, p.cwd);
  let st;
  try {
    st = await rpc('stat', { path });
  } catch (e) {
    return status(e.message, 'err');
  }
  await p.cd(st.dir ? path : parentOf(path));
  if (!st.dir) {
    const i = p.files.findIndex(f => f.path === path);
    if (i >= 0) {
      p.fileIdx = i;
      p.focus = 'files';
    }
  }
  renderAll();
}

async function quickFind() {
  const p = active();
  const inFiles = p.focus === 'files';
  const start = inFiles ? p.fileIdx : p.treeIdx;
  const jump = q => {
    q = q.toLowerCase();
    const list = inFiles ? p.files : p.nodes;
    const i = q ? list.findIndex(x => x.name.toLowerCase().startsWith(q)) : -1;
    const j = i >= 0 || !q ? i : list.findIndex(x => x.name.toLowerCase().includes(q));
    if (j >= 0) {
      if (inFiles) p.fileIdx = j;
      else p.treeIdx = j;
      p.render();
    }
    return j >= 0 || !q ? '' : 'No match';
  };
  const v = await prompt({ title: inFiles ? 'Jump to file' : 'Jump to folder', fields: [{ name: 'q', label: 'name', value: '' }], okLabel: 'Go', onInput: ({ q }) => jump(q) });
  if (!v) {
    if (inFiles) p.fileIdx = start;
    else p.treeIdx = start;
  } else if (!inFiles) await p.select(p.treeIdx);
  renderAll();
}

async function compare() {
  if (!S.split) return status('Compare needs both panes: press F8 to split', 'warn');
  const a = active();
  const b = other();
  const how = await pick({
    title: `Compare ${baseName(a.cwd)} with ${baseName(b.cwd)}`,
    filter: false,
    items: [
      { label: 'Unique', detail: 'tag files that exist on one side only', value: 'unique' },
      { label: 'Newer', detail: 'tag the newer copy of files on both sides', value: 'newer' },
      { label: 'Different', detail: 'tag files whose size or date differs', value: 'diff' },
      { label: 'Identical', detail: 'tag files with the same name, size and date', value: 'same' },
    ],
  });
  if (!how) return;
  const key = (pane, f) => (pane.mode === 'dir' ? '' : relTo(f.dir, pane.flatBase || pane.root) + S.sep) + f.name;
  const index = pane => new Map(pane.files.map(f => [key(pane, f), f]));
  const [ia, ib] = [index(a), index(b)];
  let n = 0;
  const mark = (pane, mine, theirs) => {
    for (const [k, f] of mine) {
      const o = theirs.get(k);
      // File systems differ in timestamp precision; treat <2s as equal.
      const sameTime = o && Math.abs(o.mtime - f.mtime) < 2000;
      const hit =
        how === 'unique' ? !o : how === 'newer' ? o && f.mtime - o.mtime >= 2000 : how === 'diff' ? o && (o.size !== f.size || !sameTime) : o && o.size === f.size && sameTime;
      if (hit) {
        pane.setTag(f, true);
        n++;
      }
    }
  };
  mark(a, ia, ib);
  mark(b, ib, ia);
  renderAll();
  status(`Compare: tagged ${plural(n, 'file')} across both panes`, 'ok');
}

async function properties() {
  const p = active();
  const item = p.focus === 'files' ? p.current() : dirAsItem(p.cwd);
  if (!item) return;
  let st;
  try {
    st = await rpc('stat', { path: item.path });
  } catch (e) {
    return status(e.message, 'err');
  }
  const size = h('span', {}, st.dir ? 'calculating…' : `${fmtBytes(st.size)} bytes (${fmtSize(st.size)})`);
  const rows = [
    ['Name', item.name],
    ['Location', item.dir || ''],
    ['Type', st.dir ? 'Folder' : item.ext ? `${item.ext.toUpperCase()} file` : 'File'],
    ['Size', size],
    ['Modified', fmtDate(st.modified)],
    ['Created', fmtDate(st.created)],
    ['Accessed', fmtDate(st.accessed)],
    ['Attributes', st.mode ? `${fmtMode({ mode: st.mode, link: !!st.link })}  (${(st.mode & 0o7777).toString(8)})` : st.readonly ? 'read-only' : 'read/write'],
    st.link ? ['Link to', st.link] : null,
  ].filter(Boolean);
  const m = openModal({
    title: 'Attributes',
    body: h('table', { class: 'props' }, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))),
    buttons: [{ id: 'ok', label: 'Close', kind: 'primary' }],
  });
  if (st.dir) {
    rpc('walk', { path: item.path, hidden: true })
      .then(w => {
        const bytes = w.files.reduce((n, f) => n + f[2], 0);
        size.textContent = `${fmtBytes(bytes)} bytes (${fmtSize(bytes)}) in ${plural(w.files.length, 'file')}, ${plural(w.dirs.length - 1, 'folder')}${w.truncated ? ' (at least)' : ''}`;
      })
      .catch(() => (size.textContent = 'unknown'));
  }
  await m.promise;
}

async function tagBranch(on) {
  const p = active();
  if (!on) {
    p.tags.clear();
    p.tagBytes = 0;
    renderAll();
    return status('All tags cleared');
  }
  const w = await rpc('walk', { path: p.cwd, hidden: S.hidden });
  const match = specToFilter(p.spec);
  let n = 0;
  for (const [di, name, size, mtime, fl] of w.files) {
    if (!match(name)) continue;
    p.setTag(mkFile(w.dirs[di], name, size, mtime, !!(fl & 1), !!(fl & 2), !!(fl & 4), 0), true);
    n++;
  }
  renderAll();
  status(`Tagged ${plural(n, 'file')} in this branch`, 'ok');
}

function tagListed(how) {
  const p = active();
  for (const f of p.files) p.setTag(f, how === 'invert' ? !p.tags.has(f.path) : how);
  if (p.taggedOnly) p.refreshFiles();
  renderAll();
}

function tagCurrent(on) {
  const p = active();
  if (p.focus === 'tree') return tagListed(on);
  const f = p.current();
  if (!f) return;
  p.setTag(f, on);
  p.fileIdx = Math.min(p.files.length - 1, p.fileIdx + 1);
  renderAll();
}

async function setView(mode) {
  const p = active();
  await p.setMode(p.mode === mode ? 'dir' : mode);
  renderAll();
}

async function chooseSort() {
  const p = active();
  const key = await pick({
    title: 'Sort files by',
    filter: false,
    items: [
      { label: 'Name', value: 'name' },
      { label: 'Extension', value: 'ext' },
      { label: 'Size', detail: 'largest first', value: 'size' },
      { label: 'Date modified', detail: 'newest first', value: 'date' },
      { label: 'Folder', detail: 'for Branch, Showall and Global', value: 'path' },
    ].map(it => ({ ...it, keys: p.sort.key === it.value ? (p.sort.desc ? '↓' : '↑') : '' })),
  });
  if (key) p.setSort(key);
}

function setTheme(name) {
  S.theme = name;
  document.documentElement.dataset.theme = name;
  saveSoon();
}

async function showHelp() {
  const groups = {};
  for (const c of COMMANDS) (groups[c.menu] ||= []).push(c);
  const nav = [
    ['↑ ↓ PgUp PgDn Home End', 'Move the cursor'],
    ['→ / ←', 'Tree: expand, collapse or step in and out'],
    ['+  −  *', 'Tree: expand, collapse, expand the whole branch'],
    ['Enter', 'Tree: go to the file window · Files: open'],
    ['Esc / Backspace', 'Files: back to the tree (or leave Branch/Showall/Global)'],
    ['Tab', 'Switch pane'],
    ['Space / Ins', 'Tag or untag the file and move down'],
    ['Ctrl+click, Shift+click', 'Tag with the mouse'],
  ];
  const section = (title, rows) => h('div', { class: 'help-sec' }, h('h3', {}, title), h('table', {}, rows.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))));
  await openModal({
    title: 'Tallwood keys',
    cls: 'help',
    body: h(
      'div',
      { class: 'help-grid' },
      section('Moving around', nav),
      Object.entries(groups).map(([name, cmds]) =>
        section(
          name,
          cmds.filter(c => c.keys.length).map(c => [c.keys.map(keyLabel).join(' / '), c.label + (c.ctx.length === 1 ? (c.ctx === 't' ? ' (tree)' : ' (files)') : '')])
        )
      )
    ),
    buttons: [{ id: 'ok', label: 'Close', kind: 'primary' }],
  }).promise;
}

async function palette() {
  const ctx = active().focus[0];
  const id = await pick({
    title: 'Commands',
    items: COMMANDS.filter(c => c.ctx.includes(ctx)).map(c => ({ label: c.label, detail: c.menu, keys: c.keys.map(keyLabel).join(' / '), value: c.id })),
  });
  if (id) run(id);
}

// ---------------------------------------------------------------- commands

const inTree = () => active().focus === 'tree';

// Key specs: a letter, a key name, or with a prefix: ^ Ctrl, @ Alt, + Shift.
// ctx: where the key is live: t(ree), f(iles).
const COMMANDS = [];
function cmd(id, label, keys, ctx, menu, fn, bar = true) {
  COMMANDS.push({ id, label, keys: keys ? keys.split(' ') : [], ctx, menu, run: fn, bar });
}

cmd('open', 'Open', 'o', 'f', 'File', async () => {
  const f = currentOnly()[0];
  if (f) await rpc('open', { path: f.path }).then(() => status(`Opened ${f.name}`), e => status(e.message, 'err'));
});
cmd('view', 'View', 'v F3', 'f', 'File', () => {
  const f = currentOnly()[0];
  if (f) return viewFile(f);
});
cmd('attributes', 'Attributes', 'a', 'tf', 'File', properties);
cmd('copy', 'Copy', 'c F5', 'f', 'File', () => transfer('copy', currentOnly()));
cmd('move', 'Move', 'm F6', 'f', 'File', () => transfer('move', currentOnly()));
cmd('rename', 'Rename', 'r F2', 'tf', 'File', () => (inTree() ? (isRoot(active().cwd) ? status('The root cannot be renamed') : renameOne(dirAsItem(active().cwd))) : currentOnly()[0] && renameOne(currentOnly()[0])));
cmd('delete', 'Delete', 'd Delete', 'tf', 'File', () => (inTree() ? (isRoot(active().cwd) ? status('The root cannot be deleted') : remove([dirAsItem(active().cwd)])) : remove(currentOnly())));
cmd('deleteForever', 'Delete permanently', '+Delete', 'tf', 'File', () => (inTree() ? (isRoot(active().cwd) ? null : remove([dirAsItem(active().cwd)], true)) : remove(taggedOrCurrent(), true)), false);
cmd('newfile', 'New file', 'n', 'f', 'File', newFile);
cmd('makedir', 'Makedir', 'm', 't', 'File', makeDir);
cmd('makedir2', 'Make folder', '^n', 'f', 'File', makeDir, false);
cmd('execute', 'eXecute (terminal here)', 'x', 'tf', 'File', () => rpc('terminal', { path: active().cwd }).catch(e => status(e.message, 'err')));

cmd('copyTagged', 'Copy tagged', '^c', 'f', 'Tagged', () => transfer('copy', taggedOrCurrent()));
cmd('moveTagged', 'Move tagged', '^m', 'f', 'Tagged', () => transfer('move', taggedOrCurrent()));
cmd('deleteTagged', 'Delete tagged', '^d', 'f', 'Tagged', () => remove(taggedOrCurrent()));
cmd('renameTagged', 'Rename tagged', '^r', 'f', 'Tagged', renameTagged);
cmd('copyPaths', 'Copy tagged with paths', '@c', 'f', 'Tagged', () => transfer('copy', taggedOrCurrent(), { withPaths: true }));
cmd('movePaths', 'Move tagged with paths', '@m', 'f', 'Tagged', () => transfer('move', taggedOrCurrent(), { withPaths: true }));
cmd('copyBranch', 'Copy branch', '@c', 't', 'Tagged', () => (isRoot(active().cwd) ? status('Pick a folder below the root') : transfer('copy', [dirAsItem(active().cwd)])));
cmd('graft', 'Graft (move branch)', '@g', 't', 'Tagged', () => (isRoot(active().cwd) ? status('Pick a folder below the root') : transfer('move', [dirAsItem(active().cwd)])));

cmd('tag', 'Tag', 't', 'tf', 'Tag', () => tagCurrent(true));
cmd('untag', 'Untag', 'u', 'tf', 'Tag', () => tagCurrent(false));
cmd('invert', 'Invert tags', 'i', 'tf', 'Tag', () => tagListed('invert'));
cmd('tagAll', 'Tag all listed', '^t ^a', 'f', 'Tag', () => tagListed(true));
cmd('untagAll', 'Untag all listed', '^u', 'f', 'Tag', () => tagListed(false));
cmd('tagBranch', 'Tag whole branch', '^t', 't', 'Tag', () => tagBranch(true));
cmd('untagEverything', 'Untag everything', '^u', 't', 'Tag', () => tagBranch(false));
cmd('showTagged', 'Show tagged only', '^s', 'tf', 'Tag', () => {
  const p = active();
  p.taggedOnly = !p.taggedOnly;
  p.refreshFiles();
  if (p.taggedOnly && p.files.length) p.focus = 'files';
  renderAll();
});
cmd('compare', 'Compare panes', 'c', 't', 'Tag', compare);
cmd('compare2', 'Compare panes', '@k', 'f', 'Tag', compare, false);

cmd('branch', 'Branch', 'b', 'tf', 'View', () => setView('branch'));
cmd('showall', 'Showall', 's', 'tf', 'View', () => setView('showall'));
cmd('global', 'Global', 'g', 'tf', 'View', () => setView('global'));
cmd('filespec', 'Filespec', 'f', 'tf', 'View', setFilespec);
cmd('sort', 'Sort', '@s', 'tf', 'View', chooseSort);
cmd('format', 'File display', '@f', 'tf', 'View', () => {
  const p = active();
  p.fmt = (p.fmt + 1) % 3;
  renderAll();
  saveSoon();
});
cmd('zoom', 'Zoom file window', 'z', 'tf', 'View', () => {
  const p = active();
  p.zoom = !p.zoom;
  if (p.zoom && p.files.length) p.focus = 'files';
  renderAll();
});
cmd('hidden', 'Hidden files', '^h', 'tf', 'View', async () => {
  S.hidden = !S.hidden;
  await reloadAll();
  saveSoon();
  status(`Hidden files ${S.hidden ? 'shown' : 'hidden'}`);
});
cmd('autoview', 'Autoview', 'F7', 'tf', 'View', () => {
  S.autoview = !S.autoview;
  renderAll();
});
cmd('split', 'Split / unsplit', 'F8', 'tf', 'View', () => {
  S.split = !S.split;
  S.autoview = false;
  renderAll();
  saveSoon();
});
cmd('theme', 'Next theme', 'F10', 'tf', 'View', () => {
  setTheme(THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length]);
  status(`Theme: ${S.theme}`);
});
cmd('refresh', 'Refresh', '^l F4', 'tf', 'View', () => reloadAll().then(() => status('Refreshed')));
cmd('trashMode', 'Toggle trash / permanent delete', '', 'tf', 'View', () => {
  S.trash = !S.trash;
  renderAll();
  saveSoon();
  status(S.trash ? 'Delete moves items to the trash' : 'Delete is now permanent', S.trash ? '' : 'warn');
});

cmd('log', 'Log disk', 'l', 'tf', 'Go', logDisk);
cmd('goto', 'Go to path', '^g', 'tf', 'Go', goTo);
cmd('find', 'Find in branch', '^f', 'tf', 'Go', async () => {
  const p = active();
  if (p.mode === 'dir') await p.setMode('branch');
  renderAll();
  await setFilespec();
});
cmd('jump', 'Jump to name', '/', 'tf', 'Go', quickFind);
cmd('reveal', 'Go to file’s folder', '\\', 'f', 'Go', async () => {
  const p = active();
  const f = p.current();
  if (!f) return;
  await p.cd(f.dir);
  const i = p.files.findIndex(x => x.path === f.path);
  if (i >= 0) {
    p.fileIdx = i;
    p.focus = 'files';
  }
  renderAll();
});
cmd('parent', 'Parent folder', '@ArrowUp', 'tf', 'Go', async () => {
  const p = active();
  const par = parentOf(p.cwd);
  if (!par) return;
  if (isUnder(par, p.root)) await p.cd(par);
  else await p.log(par, par).then(() => p.cd(par)); // step above the logged root
  p.focus = 'tree';
  renderAll();
});
const travel = async step => {
  const p = active();
  const at = p.hpos + step;
  if (at < 0 || at >= p.hist.length) return;
  p.hpos = at;
  await p.cd(p.hist[at], { push: false });
  renderAll();
};
cmd('back', 'Back', '@ArrowLeft', 'tf', 'Go', () => travel(-1));
cmd('forward', 'Forward', '@ArrowRight', 'tf', 'Go', () => travel(1));
cmd('home', 'Home folder', '^Home', 'tf', 'Go', () => active().cd(S.home).then(renderAll));
cmd('sync', 'Other pane → this folder', '^o', 'tf', 'Go', () => other().cd(active().cwd).then(renderAll));
cmd('swap', 'Swap panes', '@w', 'tf', 'Go', async () => {
  const [a, b] = [active(), other()];
  const [ra, ca, rb, cb] = [a.root, a.cwd, b.root, b.cwd];
  await a.log(rb, cb);
  await b.log(ra, ca);
  renderAll();
});

cmd('help', 'Help', 'F1 ?', 'tf', 'Help', showHelp);
cmd('palette', 'All commands', 'F9 ^p ^k', 'tf', 'Help', palette);

const byId = Object.fromEntries(COMMANDS.map(c => [c.id, c]));

function keyLabel(spec) {
  let mods = '';
  while ('^@+'.includes(spec[0]) && spec.length > 1) {
    mods += { '^': 'Ctrl+', '@': 'Alt+', '+': 'Shift+' }[spec[0]];
    spec = spec.slice(1);
  }
  const nice = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Delete: 'Del' };
  return mods + (nice[spec] || (spec.length === 1 ? spec.toUpperCase() : spec));
}

async function run(id) {
  try {
    await byId[id].run();
  } catch (e) {
    status(e.message, 'err');
    console.error(e);
  }
}

function renderCmdbar() {
  const ctx = active().focus[0];
  const mod = S.mod;
  const letters = [];
  const fkeys = [];
  for (const c of COMMANDS) {
    if (!c.bar || !c.ctx.includes(ctx)) continue;
    for (const spec of c.keys) {
      if (/^F\d+$/.test(spec)) {
        if (!fkeys.some(f => f.c === c)) fkeys.push({ c, spec });
        continue;
      }
      const m = spec.length > 1 && '^@'.includes(spec[0]) ? spec[0] : '';
      const key = m ? spec.slice(1) : spec;
      if (m !== mod || key.length !== 1 || !/[a-z]/.test(key)) continue;
      if (!letters.some(l => l.c === c)) letters.push({ c, key });
    }
  }
  letters.sort((a, b) => (a.key < b.key ? -1 : 1));
  fkeys.sort((a, b) => Number(a.spec.slice(1)) - Number(b.spec.slice(1)));
  const hot = (label, key) => {
    const i = label.toLowerCase().indexOf(key);
    if (i < 0) return [h('b', {}, key.toUpperCase()), ` ${label}`];
    return [label.slice(0, i), h('b', {}, label[i].toUpperCase()), label.slice(i + 1)];
  };
  const lead = `${mod === '^' ? 'CTRL ' : mod === '@' ? 'ALT ' : ''}${ctx === 't' ? 'DIR' : 'FILE'}`;
  set($('#cmdbar'), h('div', { class: 'cmd-row' }, h('span', { class: 'cmd-lead' }, lead), letters.map(({ c, key }) => h('span', { class: 'cmd', 'data-id': c.id }, hot(c.label.replace(/ \(.*\)$/, ''), key)))),
    h('div', { class: 'cmd-row fn' }, h('span', { class: 'cmd-lead' }, 'KEYS'), fkeys.map(({ c, spec }) => h('span', { class: 'cmd', 'data-id': c.id }, h('b', {}, spec), ` ${c.label.replace(/ \(.*\)$/, '')}`)), h('span', { class: 'cmd-tip' }, mod ? '' : 'hold Ctrl or Alt for more · Tab switches pane'))
  );
}

function contextMenu(x, y) {
  const ctx = active().focus[0];
  const ids = ctx === 'f' ? ['open', 'view', '-', 'copy', 'move', 'rename', 'delete', '-', 'tag', 'untag', 'copyTagged', 'moveTagged', '-', 'reveal', 'attributes'] : ['makedir', 'rename', 'delete', '-', 'tag', 'untag', 'branch', 'copyBranch', 'graft', '-', 'log', 'execute', 'attributes'];
  setTimeout(() =>
    popup(
      x,
      y,
      ids.map(id => (id === '-' ? '-' : { label: byId[id].label, keys: byId[id].keys[0] && keyLabel(byId[id].keys[0]), run: () => run(id) }))
    )
  );
}

function buildMenus() {
  const names = [...new Set(COMMANDS.map(c => c.menu))];
  set($('#menus'), ...names.map(name =>
      h(
        'button',
        {
          class: 'menu',
          tabindex: '-1',
          onclick: e => {
            const r = e.currentTarget.getBoundingClientRect();
            const ctx = active().focus[0];
            const seen = new Set();
            popup(
              r.left,
              r.bottom + 2,
              COMMANDS.filter(c => c.menu === name && c.ctx.includes(ctx) && !seen.has(c.label) && seen.add(c.label)).map(c => ({ label: c.label, keys: c.keys[0] && keyLabel(c.keys[0]), run: () => run(c.id) }))
            );
            e.currentTarget.blur();
          },
        },
        name
      )
    )
  );
}

// ---------------------------------------------------------------- keyboard

function setMod(e) {
  const m = e.ctrlKey || e.metaKey ? '^' : e.altKey ? '@' : '';
  if (m !== S.mod) {
    S.mod = m;
    renderCmdbar();
  }
}

document.addEventListener('keyup', e => {
  setMod(e);
  if (e.key === 'Alt') e.preventDefault();
});
window.addEventListener('blur', () => {
  S.mod = '';
  renderCmdbar();
});

document.addEventListener('keydown', e => {
  setMod(e);
  if (modalOpen()) return;
  if (['Control', 'Shift', 'Meta'].includes(e.key)) return;
  if (e.key === 'Alt') return e.preventDefault();
  const p = active();
  const ctrl = e.ctrlKey || e.metaKey;

  if (e.key === 'Tab') {
    e.preventDefault();
    if (S.split && !S.autoview) S.active = 1 - S.active;
    else p.focus = p.focus === 'tree' && p.files.length ? 'files' : 'tree';
    return renderAll();
  }

  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const spec = (ctrl ? '^' : '') + (e.altKey ? '@' : '') + (e.shiftKey && key.length > 1 ? '+' : '') + key;
  const ctx = p.focus[0];
  const c = COMMANDS.find(c => c.ctx.includes(ctx) && c.keys.includes(spec));
  if (c) {
    e.preventDefault();
    return run(c.id);
  }
  if (!ctrl && !e.altKey && p.nav(e)) {
    e.preventDefault();
    renderStats();
    renderCmdbar();
    if (S.autoview) previewSoon();
    return;
  }
  // Keep the webview from acting on keys we do not use (reload, find, print…).
  if (/^F\d+$/.test(e.key) || (ctrl && 'rfpgsuhjdl'.includes(key))) e.preventDefault();
});

$('#cmdbar').addEventListener('click', e => {
  const el = e.target.closest('.cmd');
  if (el) run(el.dataset.id);
});
$('#btn-palette').addEventListener('click', () => run('palette'));
$('#btn-help').addEventListener('click', () => run('help'));

let lastFocusReload = 0;
window.addEventListener('focus', () => {
  if (modalOpen() || S.busy || Date.now() - lastFocusReload < 3000) return;
  lastFocusReload = Date.now();
  reloadAll({ light: true }).catch(() => {});
});

// ---------------------------------------------------------------- settings

let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    rpc('config_set', {
      data: {
        theme: S.theme,
        split: S.split,
        hidden: S.hidden,
        trash: S.trash,
        panes: S.panes.map(p => ({ root: p.root, cwd: p.cwd, spec: p.spec, sort: p.sort, fmt: p.fmt })),
      },
    }).catch(() => {});
  }, 600);
}

async function init() {
  const info = await rpc('init');
  Object.assign(S, { sep: info.sep, home: norm(info.home), os: info.os, roots: info.roots });
  const cfg = (await rpc('config_get').catch(() => null)) || {};
  S.split = cfg.split ?? true;
  S.hidden = cfg.hidden ?? false;
  S.trash = cfg.trash ?? true;
  setTheme(THEMES.includes(cfg.theme) ? cfg.theme : 'midnight');
  clearTimeout(saveTimer);

  S.panes = [new Pane(0, $('#pane-0')), new Pane(1, $('#pane-1'))];
  buildMenus();
  for (const p of S.panes) {
    const saved = cfg.panes?.[p.id];
    let root = rootOf(S.home);
    let cwd = S.home;
    if (info.start) root = cwd = norm(info.start);
    else if (saved?.root && saved?.cwd) {
      const ok = await rpc('stat', { path: saved.cwd }).then(s => s.dir, () => false);
      if (ok && isUnder(saved.cwd, saved.root)) [root, cwd] = [saved.root, saved.cwd];
    }
    if (saved && !info.start) {
      p.spec = saved.spec || '*';
      if (SORTS[saved.sort?.key]) p.sort = saved.sort;
      p.fmt = saved.fmt || 0;
    }
    await p.log(root, cwd);
  }
  renderAll();
  document.body.classList.add('ready');
}

init().catch(e => {
  document.body.append(h('pre', { class: 'fatal' }, `Tallwood could not start:\n${e.message}`));
});
