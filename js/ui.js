// Generic UI widgets: menus, context menus, dialogs, toasts, panel splitters and tabs.
import { h, $, $$ } from './util.js';

// ---------------- Toast ----------------
export function toast(msg, ms = 2600) {
  let wrap = $('#toasts');
  if (!wrap) document.body.append(wrap = h('div#toasts'));
  const t = h('div.toast', {}, msg);
  wrap.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---------------- Menus ----------------
let openMenu = null;
export function closeMenus() { openMenu?.remove(); openMenu = null; $$('.menubar .mb-item.open').forEach(e => e.classList.remove('open')); }

function buildMenu(items, x, y, { onClose } = {}) {
  const menu = h('div.menu', { role: 'menu' });
  const list = typeof items === 'function' ? items() : items;
  for (const it of list) {
    if (!it) continue;
    if (it === '-') { menu.append(h('div.menu-sep')); continue; }
    const row = h('div.menu-row' + (it.disabled ? '.disabled' : '') + (it.sub ? '.has-sub' : ''), { role: 'menuitem' },
      h('span.menu-check', {}, it.checked ? '✓' : ''),
      h('span.menu-label', {}, it.label),
      h('span.menu-key', {}, it.sub ? '▸' : (it.key || '')));
    if (it.sub) {
      let subEl = null;
      row.addEventListener('mouseenter', () => {
        menu.querySelectorAll(':scope > .menu').forEach(m => m.remove());
        const r = row.getBoundingClientRect();
        subEl = buildMenu(it.sub, r.right - 2, r.top - 4);
        subEl.classList.add('submenu');
        menu.append(subEl);
        fitToScreen(subEl, r.left);
      });
    } else {
      row.addEventListener('mouseenter', () => menu.querySelectorAll(':scope > .menu').forEach(m => m.remove()));
      row.addEventListener('click', e => { e.stopPropagation(); if (it.disabled) return; closeMenus(); onClose?.(); it.action?.(); });
    }
    menu.append(row);
  }
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.addEventListener('pointerdown', e => e.stopPropagation());
  return menu;
}

function fitToScreen(menu, altX) {
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > innerWidth) menu.style.left = Math.max(0, (altX != null ? altX - r.width : innerWidth - r.width - 4)) + 'px';
    if (r.bottom > innerHeight) menu.style.top = Math.max(0, innerHeight - r.height - 4) + 'px';
  });
}

export function contextMenu(x, y, items) {
  closeMenus();
  openMenu = buildMenu(items, x, y);
  document.body.append(openMenu);
  fitToScreen(openMenu);
}

export function buildMenubar(root, defs) {
  root.innerHTML = '';
  for (const d of defs) {
    const it = h('div.mb-item', { tabindex: -1 }, d.label);
    const open = () => {
      closeMenus();
      it.classList.add('open');
      const r = it.getBoundingClientRect();
      openMenu = buildMenu(d.items, r.left, r.bottom);
      document.body.append(openMenu);
      fitToScreen(openMenu);
    };
    it.addEventListener('pointerdown', e => { e.stopPropagation(); it.classList.contains('open') ? closeMenus() : open(); });
    it.addEventListener('mouseenter', () => { if (openMenu && !it.classList.contains('open') && $('.menubar .mb-item.open')) open(); });
    root.append(it);
  }
}

document.addEventListener('pointerdown', () => closeMenus());
window.addEventListener('blur', () => closeMenus());

// ---------------- Dialogs ----------------
export function modal(title, body, buttons, { wide = false, onClose } = {}) {
  const back = h('div.modal-back');
  const box = h('div.modal' + (wide ? '.wide' : ''), {},
    h('div.modal-title', {}, title, h('button.modal-x', { title: 'Close', on: { click: () => close(null) } }, '×')),
    h('div.modal-body', {}, body),
    h('div.modal-foot', {}, buttons.map(b => h('button.btn' + (b.primary ? '.primary' : ''), { on: { click: () => b.action(close) } }, b.label))));
  back.append(box);
  let done = false;
  function close(v) { if (done) return; done = true; back.remove(); document.removeEventListener('keydown', key, true); onClose?.(v); }
  function key(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { const p = buttons.find(b => b.primary); if (p) { e.preventDefault(); e.stopPropagation(); p.action(close); } }
    e.stopPropagation();
  }
  document.addEventListener('keydown', key, true);
  document.body.append(back);
  setTimeout(() => box.querySelector('input,select,textarea')?.focus(), 30);
  return { close, box };
}

export function dialog(title, fields, { okText = 'OK', wide = false } = {}) {
  return new Promise(res => {
    const inputs = {};
    const body = h('div.form');
    for (const f of fields) {
      let inp;
      if (f.type === 'info') { body.append(h('div.form-info', { html: f.html })); continue; }
      if (f.type === 'select') {
        inp = h('select', {}, (f.options || []).map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(f.value) }, l); }));
      } else if (f.type === 'checkbox') inp = h('input', { type: 'checkbox', checked: !!f.value });
      else if (f.type === 'textarea') inp = h('textarea', { rows: 4 }, f.value ?? '');
      else inp = h('input', { type: f.type || 'text', value: f.value ?? '', min: f.min, max: f.max, step: f.step });
      inputs[f.k] = inp;
      body.append(h('label.form-row' + (f.type === 'checkbox' ? '.check' : ''), {}, h('span', {}, f.label), inp));
    }
    const read = () => {
      const o = {};
      for (const f of fields) {
        if (!inputs[f.k]) continue;
        const i = inputs[f.k];
        o[f.k] = f.type === 'checkbox' ? i.checked : f.type === 'number' ? parseFloat(i.value) : i.value;
      }
      return o;
    };
    modal(title, body, [
      { label: 'Cancel', action: c => c(null) },
      { label: okText, primary: true, action: c => c(read()) },
    ], { wide, onClose: res });
  });
}

export async function prompt(title, label, value = '') {
  const r = await dialog(title, [{ k: 'v', label, type: 'text', value }]);
  return r ? r.v : null;
}

export function confirmBox(title, msg, okText = 'OK') {
  return new Promise(res => modal(title, h('p', {}, msg), [
    { label: 'Cancel', action: c => c(false) },
    { label: okText, primary: true, action: c => c(true) },
  ], { onClose: v => res(!!v) }));
}

export function progressBox(title, onCancel) {
  const bar = h('div.progress-fill'); const txt = h('div.progress-text', {}, 'Starting…');
  const m = modal(title, h('div', {}, h('div.progress'), txt), [{ label: 'Cancel', action: c => { onCancel?.(); c(null); } }]);
  m.box.querySelector('.progress').append(bar);
  return { set(f, t) { bar.style.width = (Math.max(0, Math.min(1, f)) * 100).toFixed(1) + '%'; if (t) txt.textContent = t; }, close: () => m.close(true) };
}

// ---------------- Tabs ----------------
export function tabs(panel, onChange) {
  const heads = $$(':scope > .panel-tabs > .tab', panel);
  const show = name => {
    heads.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$(':scope > .panel-body > .tab-page', panel).forEach(p => p.classList.toggle('active', p.dataset.page === name));
    onChange?.(name);
  };
  heads.forEach(t => t.addEventListener('pointerdown', () => show(t.dataset.tab)));
  return show;
}

// ---------------- Splitters ----------------
export function splitter(el, { axis, get, set, min = 120, onMove }) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const start = axis === 'x' ? e.clientX : e.clientY;
    const v0 = get();
    el.classList.add('drag');
    const mv = ev => { const d = (axis === 'x' ? ev.clientX : ev.clientY) - start; set(Math.max(min, v0 + d)); onMove?.(); };
    const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
}
