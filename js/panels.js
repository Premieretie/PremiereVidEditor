// Project, Effects, Effect Controls, Audio Track Mixer, Meters, History and Tools panels.
import { project, seq, ui, bus, commit, history, revertTo, mediaById, clipById, clipEnd, placeMedia, removeClips } from './store.js';
import { importFiles, getRT, mediaIcon, newGenerated, relinkMedia, rt } from './media.js';
import { EFFECTS, TRANSITIONS, evalParam, setParam, toggleAnimation, makeEffect } from './effects.js';
import { audio, seek, engine, trackAudible } from './engine.js';
import { h, $, clamp, timecode, fmtDur, pickFiles, gainToDb, dbToGain, parseTimecode, EPS, isPhone } from './util.js';
import { setDragPayload } from './timeline.js';
import { contextMenu, toast, prompt, confirmBox, dialog } from './ui.js';
import * as A from './actions.js';
import { createTitleAt } from './monitors.js';

// ======================= PROJECT PANEL =======================
let pp = { view: 'icon', filter: '' };
export function initProject(el) {
  el.append(
    h('div.pp-head', {},
      h('div.pp-title', {}, pp.title = h('span'), pp.count = h('span.pp-count')),
      pp.search = h('input.pp-search', { placeholder: '🔍︎ Search', spellcheck: false }),
    ),
    pp.list = h('div.pp-list'),
    h('div.pp-foot', {},
      h('button.icon-btn', { title: 'List View', on: { click: () => { pp.view = 'list'; render(); } } }, '☰'),
      h('button.icon-btn', { title: 'Icon View', on: { click: () => { pp.view = 'icon'; render(); } } }, '▦'),
      pp.slider = h('input.pp-zoom', { type: 'range', min: 70, max: 220, value: 120, title: 'Thumbnail size' }),
      h('div.spacer'),
      h('button.icon-btn', { title: 'Import Media (Ctrl+I)', on: { click: () => doImport() } }, '⤓'),
      h('button.icon-btn', { title: 'New Item', on: { click: e => newItemMenu(e.currentTarget) } }, '✚'),
      h('button.icon-btn', { title: 'Clear (Delete selected items)', on: { click: () => deleteMedia() } }, '🗑︎'),
    ),
  );
  pp.search.addEventListener('input', () => { pp.filter = pp.search.value.toLowerCase(); render(); });
  pp.search.addEventListener('keydown', e => e.stopPropagation());
  pp.slider.addEventListener('input', () => el.style.setProperty('--thumb', pp.slider.value + 'px'));
  el.style.setProperty('--thumb', '120px');
  el.addEventListener('pointerdown', () => ui.focus = 'project', true);
  // drop files from OS
  el.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drop'); if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files], m => toast(m)); });
  pp.list.addEventListener('pointerdown', e => { if (e.target === pp.list) { ui.selMedia.clear(); render(); } });
  pp.list.addEventListener('dblclick', e => { if (e.target === pp.list) doImport(); });
  pp.list.addEventListener('contextmenu', e => { if (e.target === pp.list) { e.preventDefault(); contextMenu(e.clientX, e.clientY, newItems()); } });
  bus.on('change', render); bus.on('project', render);
  let t; bus.on('media-updated', () => { clearTimeout(t); t = setTimeout(render, 120); });
  bus.on('reveal-media', id => { ui.selMedia = new Set([id]); bus.emit('show-tab', 'project'); render(); });
  render();
}

export async function doImport() {
  const files = await pickFiles('video/*,audio/*,image/*,.mkv,.mov,.mp4,.webm,.mp3,.wav,.m4a,.flac,.ogg');
  if (!files.length) return;
  await importFiles(files, m => toast(m));
}

function newItems() {
  return [
    { label: 'Sequence…', action: () => A.newSequenceDialog() },
    '-',
    { label: 'Graphic / Title', action: () => newGenerated('title', 'Graphic') },
    { label: 'Color Matte…', action: async () => { const r = await dialog('Color Matte', [{ k: 'c', label: 'Color', type: 'color', value: '#1a3a6b' }, { k: 'n', label: 'Name', type: 'text', value: 'Color Matte' }]); if (r) newGenerated('color', r.n, { color: r.c }); } },
    { label: 'Black Video', action: () => newGenerated('color', 'Black Video', { color: '#000000' }) },
    { label: 'Adjustment Layer', action: () => newGenerated('adjustment', 'Adjustment Layer') },
    '-',
    { label: 'Import…', key: 'Ctrl+I', action: doImport },
  ];
}
function newItemMenu(btn) { const r = btn.getBoundingClientRect(); contextMenu(r.left, r.top - 180, newItems()); }

async function deleteMedia() {
  const ids = [...ui.selMedia]; if (!ids.length) return;
  const used = project.sequences.some(s => s.clips.some(c => ids.includes(c.mediaId)));
  if (used && !(await confirmBox('Clear', 'Some selected items are used in sequences. Remove them and their clips?', 'Remove'))) return;
  commit('Clear Media', () => {
    project.media = project.media.filter(m => !ids.includes(m.id));
    for (const s of project.sequences) s.clips = s.clips.filter(c => !ids.includes(c.mediaId));
  });
  ui.selMedia.clear();
}

function render() {
  if (!pp.list) return;
  pp.title.textContent = project.name + '.prproj';
  const items = project.media.filter(m => !pp.filter || m.name.toLowerCase().includes(pp.filter));
  const seqs = project.sequences.filter(s => !pp.filter || s.name.toLowerCase().includes(pp.filter));
  pp.count.textContent = `${project.media.length + project.sequences.length} items`;
  pp.list.className = 'pp-list ' + pp.view;
  pp.list.innerHTML = '';
  if (pp.view === 'list') pp.list.append(h('div.pp-row.hdr', {}, h('span', {}, 'Name'), h('span', {}, 'Type'), h('span', {}, 'Duration'), h('span', {}, 'Size')));
  for (const s of seqs) {
    const it = item({ id: s.id, name: s.name, type: 'sequence', info: `${s.width}×${s.height} · ${s.fps}`, dur: Math.max(...s.clips.map(clipEnd), 0) });
    it.addEventListener('dblclick', () => { project.activeSeqId = s.id; bus.emit('project'); });
    it.addEventListener('contextmenu', e => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Open in Timeline', action: () => { project.activeSeqId = s.id; bus.emit('project'); } },
        { label: 'Rename…', action: async () => { const n = await prompt('Rename', 'Name', s.name); if (n) commit('Rename Sequence', () => s.name = n); } },
        { label: 'Duplicate', action: () => commit('Duplicate Sequence', () => { const c = JSON.parse(JSON.stringify(s)); c.id = 'seq_' + Math.random().toString(36).slice(2); c.name += ' Copy'; project.sequences.push(c); }) },
        { label: 'Delete', disabled: project.sequences.length < 2, action: () => commit('Delete Sequence', () => { project.sequences = project.sequences.filter(x => x !== s); if (project.activeSeqId === s.id) project.activeSeqId = project.sequences[0].id; }) },
      ]);
    });
    pp.list.append(it);
  }
  for (const m of items) {
    const it = item({ id: m.id, name: m.name, type: m.type, media: m, dur: m.type === 'video' || m.type === 'audio' ? m.duration : null, info: m.width ? `${m.width}×${m.height}` : '' });
    it.draggable = true;
    it.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', m.name); e.dataTransfer.effectAllowed = 'copy';
      setDragPayload({ kind: 'media', mediaId: m.id, srcIn: m.srcIn ?? 0, srcOut: m.srcOut ?? null });
    });
    it.addEventListener('dblclick', () => m.offline ? relink(m) : bus.emit('open-source', m.id));
    // Phone: tap the + to insert the item at the playhead (drag and drop isn't available on touch screens)
    const add = h('button.pp-add', { title: 'Add to timeline at playhead' }, '+');
    add.addEventListener('pointerdown', e => e.stopPropagation());
    add.addEventListener('click', e => {
      e.stopPropagation();
      if (m.offline) return relink(m);
      const s = seq();
      const created = commit('Insert', () => placeMedia(m, s.playhead, { mode: 'insert', srcIn: m.srcIn ?? 0, srcOut: m.srcOut ?? null }));
      if (created?.length) { seek(Math.max(...created.map(clipEnd))); toast(`Added ${m.name}`); bus.emit('phone-pane', 'timeline'); }
    });
    it.querySelector('.pp-thumb').append(add);
    it.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!ui.selMedia.has(m.id)) { ui.selMedia = new Set([m.id]); render(); }
      contextMenu(e.clientX, e.clientY, [
        { label: 'Open in Source Monitor', action: () => bus.emit('open-source', m.id) },
        { label: 'Insert at Playhead', key: ',', action: () => { const s = seq(); commit('Insert', () => placeMedia(m, s.playhead, { mode: 'insert', srcIn: m.srcIn ?? 0, srcOut: m.srcOut ?? null })); } },
        { label: 'Overwrite at Playhead', key: '.', action: () => { const s = seq(); commit('Overwrite', () => placeMedia(m, s.playhead, { srcIn: m.srcIn ?? 0, srcOut: m.srcOut ?? null })); } },
        { label: 'New Sequence From Clip', disabled: !(m.width && m.height), action: () => newSeqFromClip(m) },
        '-',
        { label: 'Rename…', action: async () => { const n = await prompt('Rename', 'Name', m.name); if (n) commit('Rename', () => m.name = n); } },
        (m.type === 'image' || m.type === 'title' || m.type === 'color' || m.type === 'adjustment') ? { label: 'Default Duration…', action: async () => { const v = await prompt('Duration', 'Duration (seconds)', String(m.duration)); if (v) commit('Duration', () => m.duration = Math.max(0.1, parseFloat(v) || 5)); } } : null,
        m.fileKey ? { label: m.offline ? 'Link Media…' : 'Replace Footage…', action: () => relink(m) } : null,
        { label: 'Clear', key: 'Del', action: () => deleteMedia() },
        '-',
        { label: 'Properties', action: () => dialog('Properties', [{ type: 'info', html: propsHtml(m) }]) },
      ]);
    });
    pp.list.append(it);
  }
  if (!items.length && !seqs.length) pp.list.append(h('div.pp-empty', {}, 'Import media to start'));
  if (!project.media.length) pp.list.append(h('div.pp-empty', {}, h('div', {}, 'Drop files here or double-click to import'), h('div.pp-empty-sub', {}, 'Video · Audio · Images')));
}

function propsHtml(m) {
  const row = (k, v) => `<div class="kv"><b>${k}</b><span>${v}</span></div>`;
  return row('Name', m.name) + row('Type', m.type) + (m.width ? row('Frame Size', `${m.width} × ${m.height}`) : '') +
    (m.duration ? row('Duration', fmtDur(m.duration) + ` (${m.duration.toFixed(2)}s)`) : '') +
    (m.size ? row('File Size', (m.size / 1048576).toFixed(1) + ' MB') : '') + row('Audio', m.hasAudio ? 'Yes' : 'No') + (m.mime ? row('MIME', m.mime) : '');
}

function newSeqFromClip(m) {
  commit('New Sequence From Clip', () => {
    const s = JSON.parse(JSON.stringify(seq()));
    Object.assign(s, { id: 'seq_' + Math.random().toString(36).slice(2), name: m.name.replace(/\.[^.]+$/, ''), width: m.width, height: m.height, clips: [], markers: [], playhead: 0, inPoint: null, outPoint: null, scrollX: 0 });
    project.sequences.push(s); project.activeSeqId = s.id;
    placeMedia(m, 0, {}, s);
  });
  bus.emit('project');
}

async function relink(m) {
  const [f] = await pickFiles('video/*,audio/*,image/*', false);
  if (f) { await relinkMedia(m, f); toast(`Linked ${f.name}`); }
}

function item({ id, name, type, media, dur, info }) {
  const sel = ui.selMedia.has(id);
  const R = media ? getRT(media.id) : {};
  let thumb;
  if (R.thumbs?.length) { const c = R.thumbs[0].c; thumb = h('img.pp-img', { src: c.toDataURL ? cachedURL(media.id, c) : '' }); }
  else if (type === 'color') thumb = h('div.pp-swatch', { style: { background: media.color || '#1a3a6b' } });
  else if (type === 'audio' && R.peaks) thumb = waveThumb(media.id, R.peaks);
  else thumb = h('div.pp-icon.' + type, {}, mediaIcon(type));
  const off = media?.offline;
  const el = h('div.pp-item' + (sel ? '.sel' : '') + (off ? '.offline' : ''), { dataset: { id }, title: name },
    h('div.pp-thumb', {}, thumb, dur != null ? h('span.pp-dur', {}, fmtDur(dur)) : null, h('span.pp-badge.' + type, {}, mediaIcon(type))),
    h('div.pp-name', {}, name),
    h('div.pp-meta', {}, type === 'sequence' ? 'Sequence' : off ? 'Media Offline' : type[0].toUpperCase() + type.slice(1)),
    h('div.pp-meta', {}, dur != null ? fmtDur(dur) : ''),
    h('div.pp-meta', {}, media?.size ? (media.size / 1048576).toFixed(1) + ' MB' : info || ''),
  );
  el.addEventListener('pointerdown', e => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) ui.selMedia.has(id) ? ui.selMedia.delete(id) : ui.selMedia.add(id);
    else if (!ui.selMedia.has(id)) ui.selMedia = new Set([id]);
    pp.list.querySelectorAll('.pp-item').forEach(x => x.classList.toggle('sel', ui.selMedia.has(x.dataset.id)));
  });
  return el;
}
const urlCache = new Map();
function cachedURL(id, c) { const k = id + ':' + c.width; if (!urlCache.has(k) || urlCache.get(k).c !== c) urlCache.set(k, { c, u: c.toDataURL('image/jpeg', 0.8) }); return urlCache.get(k).u; }
function waveThumb(id, pk) {
  const c = document.createElement('canvas'); c.width = 160; c.height = 90; const g = c.getContext('2d');
  g.fillStyle = '#16302b'; g.fillRect(0, 0, 160, 90); g.fillStyle = '#3fd0a8';
  const n = pk.data.length / 2;
  for (let x = 0; x < 160; x++) { const i0 = Math.floor(x / 160 * n), i1 = Math.floor((x + 1) / 160 * n); let mn = 0, mx = 0; for (let i = i0; i <= i1 && i < n; i++) { mn = Math.min(mn, pk.data[i * 2]); mx = Math.max(mx, pk.data[i * 2 + 1]); } g.fillRect(x, 45 - mx * 40, 1, Math.max(1, (mx - mn) * 40)); }
  return h('img.pp-img', { src: c.toDataURL() });
}

// ======================= EFFECTS PANEL =======================
export function initEffects(el) {
  const search = h('input.pp-search', { placeholder: '🔍︎ Search effects', spellcheck: false });
  const tree = h('div.fx-tree');
  el.append(h('div.pp-head', {}, search), tree);
  search.addEventListener('keydown', e => e.stopPropagation());
  const groups = [
    ['Audio Effects', Object.entries(EFFECTS).filter(([, d]) => d.kind === 'audio' && !d.fixed), 'effect'],
    ['Audio Transitions', Object.entries(TRANSITIONS).filter(([, d]) => d.kind === 'audio'), 'transition'],
    ['Video Effects', Object.entries(EFFECTS).filter(([, d]) => d.kind === 'video' && !d.fixed), 'effect'],
    ['Video Transitions', Object.entries(TRANSITIONS).filter(([, d]) => d.kind === 'video'), 'transition'],
  ];
  const open = new Set(['Video Effects', 'Video Transitions']);
  const render = () => {
    const f = search.value.toLowerCase();
    tree.innerHTML = '';
    for (const [name, list, kind] of groups) {
      const items = list.filter(([, d]) => !f || d.name.toLowerCase().includes(f));
      if (!items.length) continue;
      const isOpen = open.has(name) || f;
      const head = h('div.fx-folder' + (isOpen ? '.open' : ''), {}, h('span.caret', {}, isOpen ? '▾' : '▸'), '📁︎ ' + name);
      head.addEventListener('click', () => { open.has(name) ? open.delete(name) : open.add(name); render(); });
      tree.append(head);
      if (!isOpen) continue;
      const byCat = {};
      for (const [k, d] of items) (byCat[d.category || 'Other'] ||= []).push([k, d]);
      for (const [cat, its] of Object.entries(byCat)) {
        tree.append(h('div.fx-cat', {}, cat));
        for (const [k, d] of its) {
          const it = h('div.fx-item', { draggable: true, title: kind === 'transition' ? 'Drag onto a clip edge, or double-click to apply at the playhead' : 'Drag onto a clip, or double-click to apply to selection' },
            h('span.fx-ico.' + kind + '.' + d.kind, {}, kind === 'transition' ? '⧉' : 'fx'), d.name,
            (kind === 'transition' && (k === 'crossDissolve' || k === 'constantPower')) ? h('span.fx-def', { title: 'Default transition' }, '★') : null);
          it.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', d.name); setDragPayload({ kind, type: k }); });
          it.addEventListener('dblclick', () => kind === 'transition' ? A.applyTransition(k) : A.applyEffect(k));
          it.addEventListener('click', () => { if (isPhone()) kind === 'transition' ? A.applyTransition(k) : A.applyEffect(k); });
          tree.append(it);
        }
      }
    }
  };
  search.addEventListener('input', render);
  render();
}

// ======================= EFFECT CONTROLS =======================
let ec = {};
export function initEffectControls(el) {
  ec.root = el;
  el.append(ec.head = h('div.ec-head'), ec.body = h('div.ec-body'));
  const rerender = () => renderEC();
  bus.on('selection', rerender); bus.on('change', rerender); bus.on('project', rerender);
  bus.on('fx-live', () => syncECValues());
  bus.on('time', () => { if (!ui.playing) syncECValues(); else updateKfPlayheads(); });
  el.addEventListener('pointerdown', () => ui.focus = 'effects', true);
  renderEC();
}

function ecClip() {
  const sel = [...ui.sel].map(id => clipById(id)).filter(Boolean);
  if (ui.selTrans) return null;
  return sel.find(c => c.type === 'video') || sel[0] || null;
}

function renderEC() {
  if (!ec.body) return;
  const active = document.activeElement;
  if (active && ec.root.contains(active) && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && active.type === 'text'))) { syncECValues(); return; }
  ec.body.innerHTML = ''; ec.head.innerHTML = '';
  ec.rows = [];
  const s = seq();
  if (ui.selTrans) return renderTransitionEC();
  const c = ecClip();
  if (!c) { ec.body.append(h('div.ec-empty', {}, '(no clips selected)')); return; }
  const m = mediaById(c.mediaId);
  const lt = () => s.playhead - c.start;
  ec.head.append(h('span.ec-src', {}, `Master * ${m?.name || ''}`), h('span.ec-sep', {}, ' › '), h('span.ec-clip', {}, `${s.name} * ${c.name}`));
  const others = [...ui.sel].map(id => clipById(id)).filter(x => x && x !== c && x.linkId && x.linkId === c.linkId);
  const showClips = [c, ...others.filter(o => o.type !== c.type).slice(0, 1)];
  for (const clip of showClips) {
    ec.body.append(h('div.ec-section', {}, clip.type === 'audio' ? 'Audio' : 'Video'));
    clip.effects.forEach((fx, idx) => {
      const def = EFFECTS[fx.type]; if (!def) return;
      const open = !(fx._collapsed);
      const header = h('div.ec-fx' + (fx.enabled ? '' : '.off'), {},
        h('span.caret', {}, open ? '▾' : '▸'),
        h('button.ec-toggle' + (fx.enabled ? '.on' : ''), { title: 'Toggle effect on/off' }, 'fx'),
        h('span.ec-fxname', {}, def.name),
        !def.fixed ? h('button.ec-del', { title: 'Remove effect' }, '×') : null,
      );
      header.querySelector('.caret').addEventListener('click', () => { fx._collapsed = !fx._collapsed; renderEC(); });
      header.querySelector('.ec-fxname').addEventListener('click', () => { fx._collapsed = !fx._collapsed; renderEC(); });
      header.querySelector('.ec-toggle').addEventListener('click', () => commit('Toggle Effect', () => fx.enabled = !fx.enabled));
      header.querySelector('.ec-del')?.addEventListener('click', () => commit(`Remove ${def.name}`, () => clip.effects.splice(clip.effects.indexOf(fx), 1)));
      header.addEventListener('contextmenu', e => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'Reset Effect', action: () => commit('Reset Effect', () => { const n = makeEffect(fx.type); fx.params = n.params; fx.kf = {}; }) },
          !def.fixed ? { label: 'Remove Effect', action: () => commit(`Remove ${def.name}`, () => clip.effects.splice(clip.effects.indexOf(fx), 1)) } : null,
          !def.fixed && idx > 0 && !EFFECTS[clip.effects[idx - 1].type].fixed ? { label: 'Move Up', action: () => commit('Reorder Effects', () => { clip.effects.splice(idx, 1); clip.effects.splice(idx - 1, 0, fx); }) } : null,
          !def.fixed && idx < clip.effects.length - 1 ? { label: 'Move Down', action: () => commit('Reorder Effects', () => { clip.effects.splice(idx, 1); clip.effects.splice(idx + 1, 0, fx); }) } : null,
        ]);
      });
      ec.body.append(header);
      if (!open) return;
      for (const p of def.params) ec.body.append(paramRow(clip, fx, p, lt));
      if (fx.type === 'motion') ec.body.append(h('div.ec-row', {}, h('span.ec-label'), h('label.ec-check', {}, (() => { const cb = h('input', { type: 'checkbox', checked: clip.fit }); cb.addEventListener('change', () => commit('Set to Frame Size', () => clip.fit = cb.checked)); return cb; })(), ' Scale to frame size')));
    });
  }
  ec.body.append(h('div.ec-hint', {}, 'Drag effects from the Effects panel onto clips. Click ⏱ to enable keyframes.'));
  syncECValues();
}

function renderTransitionEC() {
  const { clipId, edge } = ui.selTrans; const c = clipById(clipId); if (!c) return;
  const T = edge === 'in' ? c.transIn : c.transOut; if (!T) return;
  const s = seq();
  ec.head.append(h('span.ec-clip', {}, `${TRANSITIONS[T.type]?.name} — ${edge === 'in' ? 'start' : 'end'} of ${c.name}`));
  const dur = h('input.ec-num', { value: timecode(T.dur, s.fps) });
  dur.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') dur.blur(); });
  dur.addEventListener('change', () => commit('Transition Duration', () => { T.dur = clamp(parseTimecode(dur.value, s.fps), 1 / s.fps, c.dur); }));
  const type = h('select.ec-select', {}, Object.entries(TRANSITIONS).filter(([, d]) => (d.kind === 'audio') === (c.type === 'audio')).map(([k, d]) => h('option', { value: k, selected: k === T.type }, d.name)));
  type.addEventListener('change', () => commit('Change Transition', () => T.type = type.value));
  ec.body.append(
    h('div.ec-fx', {}, h('span.ec-fxname', {}, 'Transition')),
    h('div.ec-row', {}, h('span.ec-label', {}, 'Type'), type),
    h('div.ec-row', {}, h('span.ec-label', {}, 'Duration'), dur),
    h('div.ec-row', {}, h('span.ec-label'), h('button.btn', { on: { click: () => A.deleteSelection() } }, 'Remove Transition')),
  );
}

function paramRow(clip, fx, p, lt) {
  const s = seq();
  const animatable = p.type === 'number';
  const animated = () => !!fx.kf?.[p.k]?.length;
  const row = h('div.ec-row');
  const sw = animatable ? h('button.ec-sw' + (animated() ? '.on' : ''), { title: 'Toggle animation' }, '⏱') : h('span.ec-sw-space');
  const label = h('span.ec-label', {}, p.label);
  let input, get;
  const write = (v, label = p.label) => commit(`${EFFECTS[fx.type].name}: ${label}`, () => setParam(fx, p.k, v, clamp(s.playhead - clip.start, 0, clip.dur)));
  if (p.type === 'number') {
    input = h('span.ec-scrub', { title: 'Drag to change, click to type' });
    const edit = () => {
      const inp = h('input.ec-num', { value: fmtNum(getVal()) });
      input.replaceWith(inp); inp.focus(); inp.select();
      const done = ok => { inp.replaceWith(input); if (ok) { let v = parseFloat(inp.value); if (!isNaN(v)) write(clampP(p, v)); } };
      inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true));
    };
    input.addEventListener('pointerdown', e => {
      e.preventDefault(); input.setPointerCapture(e.pointerId);
      const x0 = e.clientX; const v0 = getVal() ?? (p.seqX ? s.width / 2 : p.seqY ? s.height / 2 : 0); let moved = false;
      const before = JSON.stringify(fx);
      const mv = ev => {
        const dx = ev.clientX - x0; if (Math.abs(dx) > 2) moved = true; if (!moved) return;
        const stepv = (p.step || 1) * (ev.shiftKey ? 10 : ev.ctrlKey ? 0.1 : 1);
        const v = clampP(p, Math.round((v0 + dx * stepv) / (p.step || 1)) * (p.step || 1));
        Object.assign(fx, JSON.parse(before));
        setParam(fx, p.k, v, clamp(s.playhead - clip.start, 0, clip.dur));
        input.textContent = fmtNum(v) + (p.unit ? ' ' + p.unit : '');
        engine.dirty = true; bus.emit('fx-live');
      };
      const up = () => {
        input.removeEventListener('pointermove', mv); input.removeEventListener('pointerup', up);
        const after = JSON.stringify(fx); Object.assign(fx, JSON.parse(before));
        if (!moved) return edit();
        if (after !== before) commit(`${EFFECTS[fx.type].name}: ${p.label}`, () => Object.assign(fx, JSON.parse(after)));
      };
      input.addEventListener('pointermove', mv); input.addEventListener('pointerup', up);
    });
    get = () => input.textContent = fmtNum(getVal() ?? (p.seqX ? s.width / 2 : p.seqY ? s.height / 2 : 0)) + (p.unit ? ' ' + p.unit : '');
  } else if (p.type === 'select') {
    input = h('select.ec-select', {}, p.options.map(o => h('option', { value: o }, o)));
    input.addEventListener('change', () => write(input.value));
    get = () => { if (document.activeElement !== input) input.value = fx.params[p.k]; };
  } else if (p.type === 'color') {
    input = h('input.ec-color', { type: 'color' });
    let committed = fx.params[p.k];
    input.addEventListener('input', () => { fx.params[p.k] = input.value; engine.dirty = true; });
    input.addEventListener('change', () => { const v = input.value; fx.params[p.k] = committed; commit(`${EFFECTS[fx.type].name}: ${p.label}`, () => fx.params[p.k] = v); committed = v; });
    get = () => { if (document.activeElement !== input) input.value = fx.params[p.k]; };
  } else if (p.type === 'bool') {
    input = h('input', { type: 'checkbox' });
    input.addEventListener('change', () => write(input.checked));
    get = () => input.checked = !!fx.params[p.k];
  } else if (p.type === 'text') {
    input = h('textarea.ec-text', { rows: 2, spellcheck: false });
    input.addEventListener('keydown', e => e.stopPropagation());
    input.addEventListener('input', () => { fx.params[p.k] = input.value; engine.dirty = true; });
    let orig = null;
    input.addEventListener('focus', () => orig = fx.params[p.k]);
    input.addEventListener('blur', () => { const v = input.value; if (v !== orig) { fx.params[p.k] = orig; commit('Edit Text', () => fx.params[p.k] = v); } });
    get = () => { if (document.activeElement !== input) input.value = fx.params[p.k]; };
  }
  const getVal = () => animatable ? evalParam(fx, p.k, clamp(s.playhead - clip.start, 0, clip.dur)) : fx.params[p.k];
  const reset = h('button.ec-reset', { title: 'Reset Parameter' }, '↺');
  reset.addEventListener('click', () => commit(`Reset ${p.label}`, () => { if (fx.kf) delete fx.kf[p.k]; fx.params[p.k] = p.def; }));
  // keyframe navigator
  let nav = null, kfLane = null;
  if (animatable) {
    sw.addEventListener('click', () => commit(animated() ? `Disable ${p.label} Animation` : `Enable ${p.label} Animation`, () => toggleAnimation(fx, p.k, clamp(s.playhead - clip.start, 0, clip.dur))));
    const kfs = () => fx.kf?.[p.k] || [];
    const cur = () => clamp(s.playhead - clip.start, 0, clip.dur);
    const prev = h('button.ec-kfnav', { title: 'Go to Previous Keyframe' }, '◂');
    const add = h('button.ec-kfnav.add', { title: 'Add/Remove Keyframe' }, '◆');
    const next = h('button.ec-kfnav', { title: 'Go to Next Keyframe' }, '▸');
    prev.addEventListener('click', () => { const k = [...kfs()].reverse().find(k => k.t < cur() - 1e-4); if (k) seek(clip.start + k.t); });
    next.addEventListener('click', () => { const k = kfs().find(k => k.t > cur() + 1e-4); if (k) seek(clip.start + k.t); });
    add.addEventListener('click', () => commit('Keyframe', () => {
      fx.kf ||= {};
      const list = fx.kf[p.k] ||= [];
      const t = cur(); const ex = list.findIndex(k => Math.abs(k.t - t) < 1 / s.fps / 2);
      if (ex >= 0) { list.splice(ex, 1); if (!list.length) { delete fx.kf[p.k]; } }
      else { list.push({ t, v: evalParam(fx, p.k, t) ?? (p.seqX ? s.width / 2 : p.seqY ? s.height / 2 : p.def), ease: 'linear' }); list.sort((a, b) => a.t - b.t); }
    }));
    nav = h('span.ec-kfnavs' + (animated() ? '' : '.hide'), {}, prev, add, next);
    kfLane = h('div.ec-lane');
    const drawLane = () => {
      kfLane.innerHTML = '';
      const W = 1;
      for (const k of kfs()) {
        const d = h('span.ec-kf' + (Math.abs(k.t - cur()) < 0.5 / s.fps ? '.cur' : '') + (k.ease === 'ease' ? '.ease' : k.ease === 'hold' ? '.hold' : ''), { style: { left: (k.t / clip.dur * 100 * W) + '%' }, title: `${timecode(k.t, s.fps)} = ${fmtNum(k.v)}` });
        d.addEventListener('pointerdown', e => {
          e.stopPropagation(); e.preventDefault();
          const r = kfLane.getBoundingClientRect(); d.setPointerCapture(e.pointerId);
          const t0 = k.t; let nt = t0;
          const mv = ev => { nt = clamp(Math.round(((ev.clientX - r.left) / r.width * clip.dur) * s.fps) / s.fps, 0, clip.dur); d.style.left = (nt / clip.dur * 100) + '%'; };
          const up = () => { d.removeEventListener('pointermove', mv); d.removeEventListener('pointerup', up); if (nt !== t0) commit('Move Keyframe', () => { k.t = nt; fx.kf[p.k].sort((a, b) => a.t - b.t); }); else seek(clip.start + k.t); };
          d.addEventListener('pointermove', mv); d.addEventListener('pointerup', up);
        });
        d.addEventListener('contextmenu', e => {
          e.preventDefault(); e.stopPropagation();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Linear', checked: (k.ease || 'linear') === 'linear', action: () => commit('Keyframe Interpolation', () => k.ease = 'linear') },
            { label: 'Ease (Bezier)', checked: k.ease === 'ease', action: () => commit('Keyframe Interpolation', () => k.ease = 'ease') },
            { label: 'Hold', checked: k.ease === 'hold', action: () => commit('Keyframe Interpolation', () => k.ease = 'hold') },
            '-',
            { label: 'Delete Keyframe', action: () => commit('Delete Keyframe', () => { const l = fx.kf[p.k]; l.splice(l.indexOf(k), 1); if (!l.length) delete fx.kf[p.k]; }) },
          ]);
        });
        kfLane.append(d);
      }
      kfLane.append(h('span.ec-lane-ph', { style: { left: (cur() / Math.max(1e-6, clip.dur) * 100) + '%' } }));
    };
    kfLane.addEventListener('pointerdown', e => { const r = kfLane.getBoundingClientRect(); seek(clip.start + clamp((e.clientX - r.left) / r.width, 0, 1) * clip.dur); });
    ec.rows.push({ get, drawLane, nav, animated, sw });
  } else ec.rows.push({ get });
  row.append(sw, label, h('span.ec-val', {}, input), nav || h('span'), reset, kfLane || h('span'));
  return row;
}

const fmtNum = v => v == null ? '—' : typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, m => m.includes('.') ? '' : m) : String(v);
const clampP = (p, v) => clamp(v, p.min ?? -1e6, p.max ?? 1e6);

function syncECValues() { for (const r of ec.rows || []) { r.get?.(); r.drawLane?.(); if (r.nav) { r.nav.classList.toggle('hide', !r.animated()); r.sw.classList.toggle('on', r.animated()); } } }
function updateKfPlayheads() { for (const r of ec.rows || []) r.drawLane?.(); }

// ======================= AUDIO TRACK MIXER =======================
export function initMixer(el) {
  const strips = h('div.mx-strips');
  el.append(strips);
  const render = () => {
    const s = seq(); strips.innerHTML = '';
    const strip = (name, getV, setV, getPan, setPan, extra, meterIdx) => {
      const val = h('div.mx-val');
      const fader = h('input.mx-fader', { type: 'range', min: -60, max: 12, step: 0.1, orient: 'vertical' });
      fader.value = getV(); val.textContent = (+getV()).toFixed(1) + ' dB';
      let before = null;
      fader.addEventListener('pointerdown', () => before = getV());
      fader.addEventListener('input', () => { setV(parseFloat(fader.value), true); val.textContent = (+fader.value).toFixed(1) + ' dB'; });
      fader.addEventListener('change', () => { const v = parseFloat(fader.value); setV(before ?? v, true); commit(`${name} Volume`, () => setV(v)); });
      fader.addEventListener('dblclick', () => commit(`${name} Volume`, () => setV(0)));
      const pan = getPan ? h('input.mx-pan', { type: 'range', min: -100, max: 100, step: 1, value: getPan(), title: 'Pan (double-click to center)' }) : h('div.mx-pan-space');
      if (getPan) {
        let pb = null;
        pan.addEventListener('pointerdown', () => pb = getPan());
        pan.addEventListener('input', () => setPan(parseFloat(pan.value), true));
        pan.addEventListener('change', () => { const v = parseFloat(pan.value); setPan(pb ?? v); commit(`${name} Pan`, () => setPan(v)); });
        pan.addEventListener('dblclick', () => commit(`${name} Pan`, () => setPan(0)));
      }
      return h('div.mx-strip', {}, h('div.mx-name', {}, name), pan, extra || h('div.mx-btns'), h('div.mx-fader-wrap', {}, fader), val);
    };
    for (const tr of s.audioTracks) {
      const btns = h('div.mx-btns', {},
        h('button.th-btn.mute' + (tr.muted ? '.on' : ''), { title: 'Mute', on: { click: () => commit('Mute', () => tr.muted = !tr.muted) } }, 'M'),
        h('button.th-btn.solo' + (tr.solo ? '.on' : ''), { title: 'Solo', on: { click: () => commit('Solo', () => tr.solo = !tr.solo) } }, 'S'));
      strips.append(strip(tr.name, () => tr.volume || 0, v => tr.volume = v, () => tr.pan || 0, v => tr.pan = v, btns));
    }
    const master = strip('Mix', () => s.masterVolume || 0, v => s.masterVolume = v); master.classList.add('master'); strips.append(master);
  };
  bus.on('change', render); bus.on('project', render);
  render();
}

// ======================= AUDIO METERS =======================
export function initMeters(el) {
  const cv = h('canvas.meter-cv'); el.append(cv);
  const g = cv.getContext('2d');
  const peaks = [{ v: -96, hold: -96, t: 0 }, { v: -96, hold: -96, t: 0 }];
  const buf = new Float32Array(1024);
  const dbY = (db, H) => (1 - clamp((db + 60) / 66, 0, 1)) * H; // -60..+6
  const loop = now => {
    const dpr = devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, W, H);
    const top = 8, bot = H - 6, MH = bot - top;
    const bw = Math.max(5, Math.min(12, (W - 26) / 2 - 2));
    const x0 = W - bw * 2 - 6;
    [audio.analyserL, audio.analyserR].forEach((an, i) => {
      let db = -96;
      if (an && ui.playing) { an.getFloatTimeDomainData(buf); let pk = 0; for (let k = 0; k < buf.length; k++) pk = Math.max(pk, Math.abs(buf[k])); db = gainToDb(pk); }
      const P = peaks[i];
      P.v = db > P.v ? db : P.v - 1.2;
      if (P.v > P.hold || now - P.t > 1500) { P.hold = P.v; P.t = now; }
      const x = x0 + i * (bw + 2);
      g.fillStyle = '#0d0d0d'; g.fillRect(x, top, bw, MH);
      const y = top + dbY(P.v, MH);
      const grd = g.createLinearGradient(0, top + MH, 0, top);
      grd.addColorStop(0, '#1d9e3a'); grd.addColorStop(0.75, '#2fd34f'); grd.addColorStop(0.88, '#e6d02a'); grd.addColorStop(1, '#e0312b');
      g.fillStyle = grd; g.fillRect(x, y, bw, top + MH - y);
      if (P.hold > -60) { g.fillStyle = P.hold > 0 ? '#ff4040' : '#ddd'; g.fillRect(x, top + dbY(P.hold, MH), bw, 1.5); }
    });
    g.fillStyle = '#8a8a8a'; g.font = '9px system-ui'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let d = 0; d >= -60; d -= 6) g.fillText(String(d), x0 - 3, top + dbY(d, MH));
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ======================= HISTORY =======================
export function initHistory(el) {
  const list = h('div.hist-list'); el.append(list);
  const render = () => {
    list.innerHTML = '';
    const items = [{ label: 'Open' }, ...history.undo];
    items.forEach((it, i) => {
      const row = h('div.hist-row' + (i === items.length - 1 ? '.cur' : ''), {}, h('span.hist-ico', {}, '▪'), it.label);
      row.addEventListener('click', () => revertTo(i));
      list.append(row);
    });
    for (const it of [...history.redo].reverse()) list.append(h('div.hist-row.redo', {}, h('span.hist-ico', {}, '▫'), it.label));
    list.scrollTop = list.scrollHeight;
  };
  bus.on('change', render); bus.on('project', render);
  render();
}

// ======================= TOOLS =======================
export const TOOLS = [
  ['select', 'Selection Tool (V)', 'V', '<path d="M4 2l8 7H8.5l2 4.5-1.6.8L7 9.8 4 12.5z" fill="currentColor"/>'],
  ['trackFwd', 'Track Select Forward Tool (A)', 'A', '<path d="M2 3h2v10H2z M6 6h8v4H6z" fill="currentColor"/><path d="M9 4l3 4-3 4" fill="none" stroke="currentColor"/>'],
  ['ripple', 'Ripple Edit Tool (B)', 'B', '<path d="M7 2v12M3 5l4 3-4 3M13 4h-3v8h3" fill="none" stroke="currentColor" stroke-width="1.5"/>'],
  ['rolling', 'Rolling Edit Tool (N)', 'N', '<path d="M8 2v12M4 5L1.5 8 4 11M12 5l2.5 3L12 11" fill="none" stroke="currentColor" stroke-width="1.5"/>'],
  ['razor', 'Razor Tool (C)', 'C', '<path d="M3 13l8-8 2 2-8 8z" fill="currentColor"/><path d="M11 5l2-3 1 1-3 2" fill="currentColor"/>'],
  ['slip', 'Slip Tool (Y)', 'Y', '<path d="M2 8h12M5 5L2 8l3 3M11 5l3 3-3 3M6 3v10M10 3v10" fill="none" stroke="currentColor" stroke-width="1.3"/>'],
  ['hand', 'Hand Tool (H)', 'H', '<path d="M5 8V4a1 1 0 012 0v3V3a1 1 0 012 0v4V4a1 1 0 012 0v5l1-1.5a1 1 0 011.6 1.2L11 14H6L3.5 9.5a1 1 0 011.5-1.3z" fill="currentColor"/>'],
  ['zoom', 'Zoom Tool (Z)', 'Z', '<circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 10l4 4" stroke="currentColor" stroke-width="2"/>'],
  ['type', 'Type Tool (T)', 'T', '<path d="M3 3h10v3h-1.5l-.5-1.5H9V12l1.5.5V14h-5v-1.5L7 12V4.5H5L4.5 6H3z" fill="currentColor"/>'],
];
export function initTools(el) {
  const render = () => {
    el.innerHTML = '';
    for (const [k, title, , icon] of TOOLS) {
      const b = h('button.tool' + (ui.tool === k ? '.on' : ''), { title });
      b.innerHTML = `<svg viewBox="0 0 16 16">${icon}</svg>`;
      b.addEventListener('click', () => { ui.tool = k; bus.emit('ui'); });
      el.append(b);
    }
  };
  bus.on('ui', render); render();
}

export { createTitleAt };
