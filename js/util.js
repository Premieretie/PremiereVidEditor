// Small shared helpers.

export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const EPS = 1e-6;

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

/** Tiny hyperscript: h('div.cls#id', {attrs, on:{click}}, children...) */
export function h(tag, props = {}, ...children) {
  const m = tag.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const node = document.createElement(m[1] || 'div');
  (m[2].match(/[.#][\w-]+/g) || []).forEach(t => t[0] === '.' ? node.classList.add(t.slice(1)) : (node.id = t.slice(1)));
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}

/** Simple event bus */
export class Emitter {
  constructor() { this._l = {}; }
  on(ev, fn) { (this._l[ev] ||= new Set()).add(fn); return () => this._l[ev].delete(fn); }
  emit(ev, ...a) { this._l[ev]?.forEach(fn => { try { fn(...a); } catch (e) { console.error(e); } }); }
}

export function fpsFloor(fps) { return Math.round(fps); }

/** seconds -> HH:MM:SS:FF */
export function timecode(sec, fps = 30) {
  const nf = Math.round(fps);
  let frames = Math.round(Math.max(0, sec) * fps);
  const f = frames % nf; frames = Math.floor(frames / nf);
  const s = frames % 60; frames = Math.floor(frames / 60);
  const m = frames % 60; const hh = Math.floor(frames / 60);
  const p = n => String(n).padStart(2, '0');
  return `${p(hh)}:${p(m)}:${p(s)}:${p(f)}`;
}

/** Parse "HH:MM:SS:FF", "MM:SS", "123" (frames) or "1.5s" */
export function parseTimecode(str, fps = 30) {
  str = String(str).trim();
  if (/^\d+(\.\d+)?s$/.test(str)) return parseFloat(str);
  if (/^\d+$/.test(str)) return parseInt(str, 10) / fps;
  const parts = str.split(/[:;.]/).map(n => parseInt(n, 10) || 0);
  while (parts.length < 4) parts.unshift(0);
  const [hh, mm, ss, ff] = parts.slice(-4);
  return hh * 3600 + mm * 60 + ss + ff / fps;
}

export function fmtDur(sec) {
  if (!isFinite(sec)) return '--';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const dbToGain = db => db <= -96 ? 0 : Math.pow(10, db / 20);
export const gainToDb = g => g <= 0.0000158 ? -96 : 20 * Math.log10(g);

export function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

export function pickFiles(accept = '', multiple = true) {
  return new Promise(res => {
    const inp = h('input', { type: 'file', accept, multiple });
    inp.addEventListener('change', () => res([...inp.files]));
    inp.click();
  });
}

export const deepClone = o => JSON.parse(JSON.stringify(o));

export function waitEvent(target, ev, timeout = 3000) {
  return new Promise(res => {
    let done = false;
    const fin = () => { if (!done) { done = true; target.removeEventListener(ev, fin); res(); } };
    target.addEventListener(ev, fin);
    setTimeout(fin, timeout);
  });
}

export const LABEL_COLORS = {
  Violet: '#a68fe3', Iris: '#7f8ff0', Caribbean: '#2fbfa9', Lavender: '#d48fe3',
  Cerulean: '#4fa7e6', Forest: '#6bbd45', Rose: '#e66f9b', Mango: '#f0a64c',
  Purple: '#9f5ccf', Blue: '#4b6ee0', Teal: '#2a9d9a', Magenta: '#d64ad6',
  Tan: '#c9a97c', Green: '#3ea85a', Brown: '#a06a3c', Yellow: '#e2cf3c',
};

/** True when the phone layout is active. */
export const isPhone = () => document.body.classList.contains('phone');
