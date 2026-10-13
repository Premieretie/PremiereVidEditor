// Phone layout: rearranges the existing panels into a touch-friendly single-column editor
// (preview on top, contextual edit bar, one panel at a time, bottom navigation).
// The same panel elements are moved between layouts, so state is shared and switching is instant.
import { ui, bus, seq, undo, redo, history, clipById, project } from './store.js';
import { h, $, isPhone } from './util.js';
import { togglePlay, pause } from './engine.js';
import { sheetMenu, toast } from './ui.js';
import * as A from './actions.js';
import { createTitleAt } from './monitors.js';
import { doImport } from './panels.js';
import { exportDialog } from './exporter.js';
import { zoomFit } from './timeline.js';

const MODE_KEY = 'prweb-layout-mode';
const PANES = [
  ['timeline', 'Timeline', '<path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'],
  ['project', 'Media', '<rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 6v4l4-2z" fill="currentColor"/>'],
  ['fxlib', 'Effects', '<path d="M8 1.5l1.6 4.2 4.4.3-3.4 2.8 1.1 4.3L8 10.7 4.3 13.1l1.1-4.3L2 6l4.4-.3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'],
  ['effects', 'Adjust', '<path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="4" r="1.6" fill="currentColor"/><circle cx="10" cy="8" r="1.6" fill="currentColor"/><circle cx="5" cy="12" r="1.6" fill="currentColor"/>'],
  ['mixer', 'Audio', '<path d="M1 8h2l1.5-4 2 8 2-10 2 10 1.5-5 1 1H15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'],
  ['claude', 'Claude', '<path d="M8 1v14M1 8h14M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'],
];
// Panels that live in the main area but have no nav button (reached from menus or actions)
const EXTRA = ['source', 'history'];

let shell, monitorSlot, editBar, mainArea, nav, current = 'timeline';
const homes = new Map(); // moved node -> {parent, next}
let menus = [];

function move(node, target) {
  if (!node) return;
  if (!homes.has(node)) homes.set(node, { parent: node.parentNode, next: node.nextSibling });
  target.append(node);
}
function restoreAll() {
  for (const [node, { parent, next }] of [...homes].reverse()) parent.insertBefore(node, next && next.parentNode === parent ? next : null);
  homes.clear();
}

const icon = p => { const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); e.setAttribute('viewBox', '0 0 16 16'); e.innerHTML = p; return e; };

function buildShell() {
  shell = h('div#phone-shell', {},
    h('header.ph-top', {},
      h('button.ph-btn', { title: 'Menu', on: { click: () => sheetMenu(menus.map(m => ({ label: m.label, sub: m.items }))) } }, '☰'),
      h('div.ph-title', {}, h('span.ph-proj'), h('span.ph-tc')),
      h('button.ph-btn', { title: 'Undo', on: { click: undo } }, '↶'),
      h('button.ph-btn', { title: 'Redo', on: { click: redo } }, '↷'),
      h('button.ph-btn.ph-export', { title: 'Export', on: { click: exportDialog } }, 'Export'),
      h('button.ph-btn', { title: 'Switch to desktop layout', on: { click: () => setMode('desktop') } }, icon('<rect x="1.5" y="2.5" width="13" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 14h6M8 11.5V14" stroke="currentColor" stroke-width="1.4"/>')),
    ),
    monitorSlot = h('section.ph-monitor'),
    editBar = h('div.ph-editbar'),
    mainArea = h('section.ph-main', {}, [...PANES.map(p => p[0]), ...EXTRA].map(k => h('div.ph-pane', { dataset: { pane: k } }))),
    nav = h('nav.ph-nav', {}, PANES.map(([k, label, svg]) => {
      const b = h('button.ph-tab', { dataset: { pane: k } }, icon(svg), h('span', {}, label));
      b.addEventListener('click', () => showPane(k));
      return b;
    })),
  );
  document.body.append(shell);
  bus.on('selection', renderEditBar); bus.on('change', renderEditBar); bus.on('ui', renderEditBar); bus.on('project', renderEditBar);
  bus.on('time', t => { if (isPhone()) shell.querySelector('.ph-tc').textContent = fmt(t); });
  bus.on('play-state', renderEditBar);
  bus.on('phone-pane', k => { if (isPhone()) showPane(k); });
}
const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; };

export function showPane(k) {
  if (!shell) return;
  current = k;
  shell.querySelectorAll('.ph-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === k));
  shell.querySelectorAll('.ph-tab').forEach(b => b.classList.toggle('active', b.dataset.pane === k));
  if (k === 'claude') setTimeout(() => shell.querySelector('textarea.ai-text')?.focus({ preventScroll: true }), 50);
  renderEditBar();
}

function btn(label, svgPath, action, cls = '') {
  const b = h('button.ph-act' + cls, { on: { click: action } }, svgPath ? icon(svgPath) : null, h('span', {}, label));
  return b;
}
const I = {
  split: '<path d="M8 1v14" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 1.5"/><rect x="1.5" y="5" width="5" height="6" rx="1" fill="currentColor"/><rect x="9.5" y="5" width="5" height="6" rx="1" fill="currentColor"/>',
  del: '<path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  ripple: '<path d="M2 5h5v6H2zM9 8h5M11.5 5.5L9 8l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  dup: '<rect x="2" y="4" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="6" y="2" width="8" height="8" rx="1" fill="currentColor" opacity=".6"/>',
  speed: '<path d="M2.5 11a5.5 5.5 0 1111 0" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 11l3-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  adjust: '<path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="4" r="1.6" fill="currentColor"/><circle cx="10" cy="8" r="1.6" fill="currentColor"/><circle cx="5" cy="12" r="1.6" fill="currentColor"/>',
  trans: '<path d="M2 3h6v10H2z" fill="currentColor" opacity=".5"/><path d="M8 3h6v10H8z" fill="currentColor"/><path d="M6 13L10 3" stroke="#000" stroke-width="1"/>',
  fx: '<path d="M8 1.5l1.6 4.2 4.4.3-3.4 2.8 1.1 4.3L8 10.7 4.3 13.1l1.1-4.3L2 6l4.4-.3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  add: '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  text: '<path d="M3 3h10v2.5h-1.2L11.4 4.5H9V12l1.4.5V14H5.6v-1.5L7 12V4.5H4.6L4.2 5.5H3z" fill="currentColor"/>',
  eye: '<path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" fill="currentColor"/>',
  more: '<circle cx="3" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="13" cy="8" r="1.5" fill="currentColor"/>',
  fit: '<path d="M1 8h14M4 5L1 8l3 3M12 5l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  cursor: '<path d="M4 2l8 7H8.5l2 4.5-1.6.8L7 9.8 4 12.5z" fill="currentColor"/>',
  razor: '<path d="M3 13l8-8 2 2-8 8z" fill="currentColor"/>',
  play: '<path d="M4 2.5v11l9.5-5.5z" fill="currentColor"/>',
  pause: '<rect x="3.5" y="2.5" width="3" height="11" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" fill="currentColor"/>',
};

function renderEditBar() {
  if (!editBar || !isPhone()) return;
  editBar.innerHTML = '';
  editBar.scrollLeft = 0;
  const sel = A.selClips();
  const playBtn = btn(ui.playing ? 'Pause' : 'Play', ui.playing ? I.pause : I.play, () => togglePlay(), '.play');
  if (ui.selTrans) {
    editBar.append(playBtn,
      btn('Duration', I.speed, () => showPane('effects')),
      btn('Remove', I.del, () => A.deleteSelection()),
      btn('Done', null, () => A.clearSelection(), '.done'));
  } else if (sel.length) {
    const c = sel[0];
    editBar.append(playBtn,
      btn('Split', I.split, () => A.addEdit()),
      btn('Delete', I.del, () => A.deleteSelection()),
      btn('Ripple', I.ripple, () => A.deleteSelection(true)),
      btn('Adjust', I.adjust, () => showPane('effects')),
      btn('Speed', I.speed, () => A.speedDialog()),
      btn('Fade', I.trans, () => fadeMenu(c)),
      btn('Effects', I.fx, () => showPane('fxlib')),
      btn('Copy', I.dup, () => A.duplicateSelection()),
      btn(c.enabled === false ? 'Enable' : 'Disable', I.eye, () => A.toggleEnable()),
      btn('More', I.more, () => moreMenu(c)),
      btn('Done', null, () => A.clearSelection(), '.done'));
  } else {
    editBar.append(playBtn,
      btn('Media', I.add, () => { showPane('project'); }),
      btn('Text', I.text, () => createTitleAt()),
      btn('Split', I.split, () => A.addEdit(true)),
      btn(ui.tool === 'razor' ? 'Razor on' : 'Razor', I.razor, () => { ui.tool = ui.tool === 'razor' ? 'select' : 'razor'; bus.emit('ui'); toast(ui.tool === 'razor' ? 'Razor: tap a clip to cut it' : 'Select tool', 1200); }, ui.tool === 'razor' ? '.on' : ''),
      btn('Transitions', I.trans, () => showPane('fxlib')),
      btn('Fit', I.fit, () => { showPane('timeline'); zoomFit(); }),
      btn('Import', I.add, () => doImport()));
  }
}

function fadeMenu(c) {
  const isA = c.type === 'audio';
  const def = isA ? 'constantPower' : 'crossDissolve';
  sheetMenu([
    { label: isA ? 'Fade in (start)' : 'Cross Dissolve at start', action: () => A.applyTransition(def, { clip: c, edge: 'in' }) },
    { label: isA ? 'Fade out (end)' : 'Cross Dissolve at end', action: () => A.applyTransition(def, { clip: c, edge: 'out' }) },
    ...(isA ? [] : [
      { label: 'Dip to Black at start', action: () => A.applyTransition('dipToBlack', { clip: c, edge: 'in' }) },
      { label: 'Dip to Black at end', action: () => A.applyTransition('dipToBlack', { clip: c, edge: 'out' }) },
      { label: 'More transitions…', action: () => showPane('fxlib') },
    ]),
  ], 'Fades & transitions');
}

function moreMenu(c) {
  sheetMenu([
    { label: c.linkId ? 'Unlink audio/video' : 'Link', action: () => A.toggleLink() },
    c.type === 'video' ? { label: 'Set to Frame Size', checked: c.fit, action: () => A.scaleToFrame() } : null,
    { label: 'Rename…', action: () => A.renameClip() },
    { label: 'Label', sub: Object.entries(A.LABEL_COLORS).map(([n, col]) => ({ label: n, checked: c.label === col, action: () => A.setLabel(col) })) },
    '-',
    { label: 'Nudge left 1 frame', action: () => A.nudge(-1) },
    { label: 'Nudge right 1 frame', action: () => A.nudge(1) },
    { label: 'Open in Source Monitor', action: () => { bus.emit('open-source', c.mediaId, c); } },
    { label: 'Cut', action: () => A.copySelection(true) },
    { label: 'Copy', action: () => A.copySelection() },
    { label: 'Paste at playhead', disabled: !ui.clipboard, action: () => A.paste() },
  ], c.name);
}

// ---------------- Mode switching ----------------
function setViewport(mode) {
  const m = document.querySelector('meta[name=viewport]');
  if (!m) return;
  const narrow = Math.min(screen.width, screen.height) < 820;
  m.content = mode === 'phone'
    ? 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'
    : narrow ? 'width=1280' : 'width=device-width, initial-scale=1';
}

export function setMode(mode, { save = true } = {}) {
  if (save) try { localStorage.setItem(MODE_KEY, mode); } catch { }
  pause();
  setViewport(mode);
  if (mode === 'phone') {
    if (!shell) buildShell();
    restoreAll();
    move($('#p-prog .panel-body'), monitorSlot);
    const pane = k => shell.querySelector(`.ph-pane[data-pane=${k}]`);
    move($('#p-tl .panel-body'), pane('timeline'));
    for (const k of ['project', 'fxlib', 'effects', 'mixer', 'claude', 'source', 'history']) move($(`[data-page=${k}]`), pane(k));
    document.body.classList.add('phone');
    shell.querySelector('.ph-proj').textContent = project.name;
    showPane(current);
    for (const t of [...seq().videoTracks, ...seq().audioTracks]) if (t.height < 48) t.height = 48;
  } else {
    document.body.classList.remove('phone');
    restoreAll();
  }
  bus.emit('layout-mode', mode);
  bus.emit('project'); // re-layout monitors/timeline
  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
}

export function currentMode() { return isPhone() ? 'phone' : 'desktop'; }

export function initPhone(menuDefs) {
  menus = menuDefs;
  let mode = null;
  try { mode = localStorage.getItem(MODE_KEY); } catch { }
  if (!mode) mode = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600 ? 'phone' : 'desktop';
  if (mode === 'phone') setMode('phone', { save: false });
  else setViewport('desktop');
}

export function toggleMode() { setMode(isPhone() ? 'desktop' : 'phone'); }
