// App bootstrap: layout, menus, keyboard shortcuts and persistence.
import { project, setProject, newProject, seq, ui, bus, undo, redo, history, commit, placeMedia, mediaById } from './store.js';
import { db, requestPersistence } from './db.js';
import { hydrateMedia, newGenerated, rt, importFiles } from './media.js';
import { engine, togglePlay, pause, seek, shuttle, play, ensureAudio } from './engine.js';
import { initTimeline, zoomBy, zoomFit, invalidate } from './timeline.js';
import { initProgram, initSource, exportFrame, srcToggle, srcMarkIn, srcMarkOut, srcEdit, createTitleAt, sourceState } from './monitors.js';
import { initProject, initEffects, initEffectControls, initMixer, initMeters, initHistory, initTools, doImport, TOOLS } from './panels.js';
import { exportDialog } from './exporter.js';
import { initBridge } from './bridge.js';
import { initClaudeChat, focusClaude } from './claude-chat.js';
import { buildMenubar, tabs, splitter, toast, modal, confirmBox, dialog } from './ui.js';
import { $, $$, h, debounce, download, pickFiles, timecode } from './util.js';
import * as A from './actions.js';

// ---------------- Layout ----------------
const showTop = tabs($('#p-src'));
const showBottom = tabs($('#p-proj'));
initSource($('[data-page=source]'));
initEffectControls($('[data-page=effects]'));
initMixer($('[data-page=mixer]'));
initProgram($('#p-prog .panel-body'));
initProject($('[data-page=project]'));
initEffects($('[data-page=fxlib]'));
initHistory($('[data-page=history]'));
initTimeline($('#p-tl .panel-body'));
initTools($('#tools'));
initMeters($('#meters'));
initBridge();
initClaudeChat($('[data-page=claude]'));
$('.topbar-right').prepend(h('button.ask-claude', { title: 'Edit with Claude (Ctrl+J)', on: { click: () => { showTop('claude'); focusClaude(); } } }, '✳ Ask Claude'));

bus.on('show-tab', name => { if (['source', 'effects', 'mixer', 'claude'].includes(name)) showTop(name); else showBottom(name); });
bus.on('focus-effect-controls', () => showTop('effects'));
bus.on('selection', () => { if (ui.sel.size && $('#p-src .tab.active')?.dataset.tab === 'source' && !sourceState.media) showTop('effects'); });
bus.on('project', () => { $('#prog-title').textContent = `Program: ${seq().name}`; $('#tl-title').textContent = seq().name; });

const ws = $('.workspace');
const setVar = (k, v) => ws.style.setProperty(k, v + 'px');
const getVar = k => parseFloat(getComputedStyle(ws).getPropertyValue(k));
const LAYOUT_KEY = 'prweb-layout';
function saveLayout() { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ top: $('.ws-row.top').getBoundingClientRect().height, left: $('#p-src').getBoundingClientRect().width, bleft: $('#p-proj').getBoundingClientRect().width })); } catch { } }
try { const L = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); if (L) { setVar('--top-h', L.top); setVar('--left-w', L.left); setVar('--bleft-w', L.bleft); } } catch { }
splitter($('#split-h'), { axis: 'y', get: () => $('.ws-row.top').getBoundingClientRect().height, set: v => setVar('--top-h', Math.min(v, innerHeight - 220)), min: 150, onMove: saveLayout });
splitter($('#split-top'), { axis: 'x', get: () => $('#p-src').getBoundingClientRect().width, set: v => setVar('--left-w', Math.min(v, innerWidth - 300)), min: 220, onMove: saveLayout });
splitter($('#split-bottom'), { axis: 'x', get: () => $('#p-proj').getBoundingClientRect().width, set: v => setVar('--bleft-w', Math.min(v, innerWidth - 400)), min: 200, onMove: saveLayout });

// Panel maximize (`)
let maximized = null;
function toggleMaximize(panel) {
  if (maximized) { maximized.classList.remove('maximized'); ws.classList.remove('has-max'); const was = maximized; maximized = null; if (was === panel || !panel) return; }
  if (!panel) return;
  maximized = panel; panel.classList.add('maximized'); ws.classList.add('has-max');
}
let hoverPanel = null;
$$('.panel').forEach(p => p.addEventListener('pointerenter', () => hoverPanel = p));
$$('.panel').forEach(p => p.addEventListener('pointerdown', () => { $$('.panel').forEach(x => x.classList.toggle('focused', x === p)); }, true));

function setWorkspace(name) {
  if (maximized) toggleMaximize(null);
  if (name === 'Editing') { showTop('source'); showBottom('project'); }
  if (name === 'Effects') { showTop('effects'); showBottom('fxlib'); }
  if (name === 'Audio') { showTop('mixer'); showBottom('project'); }
  if (name === 'Assembly') { showTop('source'); showBottom('project'); setVar('--bleft-w', Math.round(innerWidth * 0.45)); }
  $$('.ws-tab').forEach(t => t.classList.toggle('active', t.textContent === name));
}
$$('.ws-tab').forEach(t => t.addEventListener('click', () => setWorkspace(t.textContent)));

// ---------------- Project persistence ----------------
const serialize = () => JSON.stringify({ ...project, savedAt: Date.now(), app: 'premiere-web' });
const autosave = debounce(async () => {
  try { await db.putProject('current', serialize()); $('#save-state').textContent = 'Saved'; } catch (e) { console.warn(e); $('#save-state').textContent = 'Not saved'; }
}, 700);
bus.on('change', () => { $('#save-state').textContent = 'Saving…'; autosave(); });
window.addEventListener('beforeunload', () => { try { db.putProject('current', serialize()); } catch { } });

function sanitize(p) {
  if (!p || !Array.isArray(p.sequences) || !p.sequences.length) throw new Error('Not a valid project file');
  p.media ||= [];
  for (const s of p.sequences) { s.markers ||= []; s.clips ||= []; s.playhead ||= 0; s.zoom ||= 60; s.scrollX ||= 0; s.scrollY ||= 0; }
  if (!p.sequences.some(s => s.id === p.activeSeqId)) p.activeSeqId = p.sequences[0].id;
  return p;
}

async function loadInitial() {
  let p = null;
  try { const json = await db.getProject('current'); if (json) p = sanitize(JSON.parse(json)); } catch (e) { console.warn('Could not restore project', e); }
  if (p) {
    setProject(p);
    await hydrateMedia();
    const off = project.media.filter(m => m.offline).length;
    if (off) toast(`${off} media item(s) offline — double-click them in the Project panel to relink`, 5000);
  } else {
    setProject(newProject());
    welcome();
  }
  bus.emit('project');
  requestPersistence();
}

async function newProjectCmd() {
  if (project.media.length || seq().clips.length) if (!(await confirmBox('New Project', 'Start a new project? The current project will be closed (save it first with File ▸ Save Project As if you want to keep it).', 'New Project'))) return;
  pause();
  for (const R of rt.values()) if (R.url) URL.revokeObjectURL(R.url);
  rt.clear();
  setProject(newProject());
  bus.emit('project');
  autosave();
}

function saveAs() {
  download(new Blob([serialize()], { type: 'application/json' }), `${project.name}.prweb`);
  toast('Project file saved. Media files stay in this browser; keep your originals to relink on another machine.', 5000);
}

async function openProject() {
  const [f] = await pickFiles('.prweb,.json,application/json', false);
  if (!f) return;
  try {
    const p = sanitize(JSON.parse(await f.text()));
    pause(); rt.clear();
    setProject(p);
    await hydrateMedia();
    bus.emit('project');
    autosave();
    const off = project.media.filter(m => m.offline).length;
    toast(off ? `Opened ${f.name}. ${off} item(s) offline — double-click to relink.` : `Opened ${f.name}`, 5000);
  } catch (e) { toast('Could not open project: ' + e.message, 5000); }
}

async function renameProject() {
  const r = await dialog('Project Settings', [{ k: 'name', label: 'Project Name', type: 'text', value: project.name }]);
  if (r?.name) commit('Rename Project', () => project.name = r.name);
}

// ---------------- Menus ----------------
const sel = () => A.selClips();
const hasSel = () => ui.sel.size > 0;
buildMenubar($('.menubar'), [
  {
    label: 'File', items: () => [
      { label: 'New Project', key: 'Ctrl+Alt+N', action: newProjectCmd },
      { label: 'New', sub: [
        { label: 'Sequence…', key: 'Ctrl+N', action: () => A.newSequenceDialog() },
        { label: 'Graphic / Title', key: 'Ctrl+T', action: () => createTitleAt() },
        { label: 'Color Matte', action: () => newGenerated('color', 'Color Matte', { color: '#1a3a6b' }) },
        { label: 'Black Video', action: () => newGenerated('color', 'Black Video', { color: '#000000' }) },
        { label: 'Adjustment Layer', action: () => newGenerated('adjustment', 'Adjustment Layer') },
      ] },
      { label: 'Open Project…', key: 'Ctrl+O', action: openProject },
      '-',
      { label: 'Save', key: 'Ctrl+S', action: async () => { await db.putProject('current', serialize()); toast('Project saved in this browser'); } },
      { label: 'Save Project As…', key: 'Ctrl+Shift+S', action: saveAs },
      '-',
      { label: 'Import…', key: 'Ctrl+I', action: doImport },
      { label: 'Export', sub: [
        { label: 'Media…', key: 'Ctrl+M', action: exportDialog },
        { label: 'Frame (PNG)', key: 'Ctrl+Shift+E', action: exportFrame },
      ] },
      '-',
      { label: 'Project Settings…', action: renameProject },
    ],
  },
  {
    label: 'Edit', items: () => [
      { label: history.undo.length ? `Undo ${history.undo.at(-1).label}` : 'Undo', key: 'Ctrl+Z', disabled: !history.undo.length, action: undo },
      { label: history.redo.length ? `Redo ${history.redo.at(-1).label}` : 'Redo', key: 'Ctrl+Shift+Z', disabled: !history.redo.length, action: redo },
      '-',
      { label: 'Cut', key: 'Ctrl+X', disabled: !hasSel(), action: () => A.copySelection(true) },
      { label: 'Copy', key: 'Ctrl+C', disabled: !hasSel(), action: () => A.copySelection() },
      { label: 'Paste', key: 'Ctrl+V', disabled: !ui.clipboard, action: () => A.paste() },
      { label: 'Paste Insert', key: 'Ctrl+Shift+V', disabled: !ui.clipboard, action: () => A.paste(true) },
      { label: 'Duplicate', key: 'Ctrl+Shift+/', disabled: !hasSel(), action: () => A.duplicateSelection() },
      { label: 'Clear', key: 'Delete', disabled: !hasSel() && !ui.selTrans, action: () => A.deleteSelection() },
      { label: 'Ripple Delete', key: 'Shift+Delete', disabled: !hasSel(), action: () => A.deleteSelection(true) },
      '-',
      { label: 'Select All', key: 'Ctrl+A', action: A.selectAll },
      { label: 'Deselect All', key: 'Ctrl+Shift+A', action: A.clearSelection },
      '-',
      { label: 'Keyboard Shortcuts', key: 'F1', action: shortcutsHelp },
    ],
  },
  {
    label: 'Clip', items: () => [
      { label: 'Rename…', disabled: sel().length !== 1, action: A.renameClip },
      { label: 'Speed/Duration…', key: 'Ctrl+R', disabled: !hasSel(), action: A.speedDialog },
      '-',
      { label: 'Enable', key: 'Shift+E', disabled: !hasSel(), checked: hasSel() && sel().every(c => c.enabled !== false), action: A.toggleEnable },
      { label: 'Link / Unlink', key: 'Ctrl+L', disabled: !hasSel(), action: A.toggleLink },
      { label: 'Set to Frame Size', disabled: !hasSel(), action: A.scaleToFrame },
      { label: 'Label', disabled: !hasSel(), sub: Object.entries(A.LABEL_COLORS).map(([n, c]) => ({ label: n, action: () => A.setLabel(c) })) },
      '-',
      { label: 'Insert (from Source)', key: ',', action: () => srcEdit('insert') },
      { label: 'Overwrite (from Source)', key: '.', action: () => srcEdit('overwrite') },
      { label: 'Nudge Left 1 Frame', key: 'Alt+Left', disabled: !hasSel(), action: () => A.nudge(-1) },
      { label: 'Nudge Right 1 Frame', key: 'Alt+Right', disabled: !hasSel(), action: () => A.nudge(1) },
    ],
  },
  {
    label: 'Sequence', items: () => [
      { label: 'Sequence Settings…', action: A.sequenceSettings },
      { label: 'New Sequence…', key: 'Ctrl+N', action: A.newSequenceDialog },
      '-',
      { label: 'Add Edit', key: 'Ctrl+K', action: () => A.addEdit() },
      { label: 'Add Edit to All Tracks', key: 'Ctrl+Shift+K', action: () => A.addEdit(true) },
      { label: 'Ripple Trim Previous Edit to Playhead', key: 'Q', action: () => A.trimToPlayhead('start') },
      { label: 'Ripple Trim Next Edit to Playhead', key: 'W', action: () => A.trimToPlayhead('end') },
      '-',
      { label: 'Apply Video Transition', key: 'Ctrl+D', action: () => A.applyTransition('crossDissolve') },
      { label: 'Apply Audio Transition', key: 'Ctrl+Shift+D', action: () => A.applyTransition('constantPower') },
      '-',
      { label: 'Lift', key: ';', action: () => A.liftExtract(false) },
      { label: 'Extract', key: "'", action: () => A.liftExtract(true) },
      '-',
      { label: 'Zoom In', key: '=', action: () => zoomBy(1.5) },
      { label: 'Zoom Out', key: '-', action: () => zoomBy(1 / 1.5) },
      { label: 'Zoom to Sequence', key: '\\', action: zoomFit },
      '-',
      { label: 'Snap in Timeline', key: 'S', checked: ui.snap, action: () => { ui.snap = !ui.snap; bus.emit('ui'); } },
      { label: 'Linked Selection', checked: ui.linked, action: () => { ui.linked = !ui.linked; bus.emit('ui'); } },
      '-',
      { label: 'Add Tracks', sub: [{ label: 'Video Track', action: () => A.addTracks('video') }, { label: 'Audio Track', action: () => A.addTracks('audio') }] },
    ],
  },
  {
    label: 'Markers', items: () => [
      { label: 'Mark In', key: 'I', action: A.markIn },
      { label: 'Mark Out', key: 'O', action: A.markOut },
      { label: 'Mark Clip', key: 'X', action: A.markClip },
      { label: 'Go to In', key: 'Shift+I', action: () => seek(seq().inPoint ?? 0) },
      { label: 'Go to Out', key: 'Shift+O', action: () => seek(seq().outPoint ?? 0) },
      { label: 'Clear In and Out', key: 'Ctrl+Shift+X', action: A.clearInOut },
      '-',
      { label: 'Add Marker', key: 'M', action: A.addMarker },
      { label: 'Go to Next Marker', key: 'Shift+M', action: () => A.gotoMarker(1) },
      { label: 'Go to Previous Marker', key: 'Ctrl+Shift+M', action: () => A.gotoMarker(-1) },
      { label: 'Clear All Markers', action: A.clearMarkers },
    ],
  },
  {
    label: 'Graphics', items: () => [
      { label: 'New Layer ▸ Text', key: 'Ctrl+T', action: () => createTitleAt() },
      { label: 'Type Tool', key: 'T', action: () => { ui.tool = 'type'; bus.emit('ui'); toast('Click in the Program Monitor to add text'); } },
      { label: 'New Color Matte', action: () => newGenerated('color', 'Color Matte', { color: '#1a3a6b' }) },
      { label: 'New Adjustment Layer', action: () => newGenerated('adjustment', 'Adjustment Layer') },
    ],
  },
  {
    label: 'View', items: () => [
      { label: 'Safe Margins', checked: ui.safeMargins, action: () => { ui.safeMargins = !ui.safeMargins; engine.dirty = true; } },
      { label: 'Playback Resolution', sub: [['auto', 'Auto'], ['1', 'Full'], ['0.5', '1/2'], ['0.25', '1/4']].map(([v, l]) => ({ label: l, checked: $('#p-prog .mon-sel[title="Select Playback Resolution"]').value === v, action: () => { const s = $('#p-prog .mon-sel[title="Select Playback Resolution"]'); s.value = v; engine.dirty = true; } })) },
      '-',
      { label: 'Maximize Panel Under Cursor', key: '`', action: () => toggleMaximize(hoverPanel) },
    ],
  },
  {
    label: 'Window', items: () => [
      { label: 'Workspaces', sub: ['Editing', 'Assembly', 'Effects', 'Audio'].map(n => ({ label: n, action: () => setWorkspace(n) })) },
      { label: 'Reset Layout', action: () => { localStorage.removeItem(LAYOUT_KEY); ws.removeAttribute('style'); setWorkspace('Editing'); } },
      '-',
      { label: 'Source Monitor', action: () => showTop('source') },
      { label: 'Effect Controls', key: 'Shift+5', action: () => showTop('effects') },
      { label: 'Audio Track Mixer', key: 'Shift+6', action: () => showTop('mixer') },
      { label: 'Claude', key: 'Ctrl+J', action: () => { showTop('claude'); focusClaude(); } },
      { label: 'Project', key: 'Shift+1', action: () => showBottom('project') },
      { label: 'Effects', key: 'Shift+7', action: () => showBottom('fxlib') },
      { label: 'History', action: () => showBottom('history') },
    ],
  },
  {
    label: 'Help', items: () => [
      { label: 'Keyboard Shortcuts', key: 'F1', action: shortcutsHelp },
      { label: 'Getting Started', action: welcome },
      { label: 'About', action: () => modal('About Premiere Web', h('div', {}, h('p', {}, 'A browser-based non-linear video editor inspired by Adobe Premiere Pro. Everything runs locally in your browser — your media never leaves your computer.'), h('p.muted', {}, 'Not affiliated with Adobe. MP4 muxing by mp4-muxer (MIT).')), [{ label: 'OK', primary: true, action: c => c() }]) },
    ],
  },
]);

// ---------------- Keyboard ----------------
function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['checkbox', 'range', 'button', 'color'].includes(t.type)) || t.isContentEditable);
}

document.addEventListener('keydown', e => {
  if (document.querySelector('.modal-back')) return;
  if (isTyping(e)) return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey, sh = e.shiftKey, alt = e.altKey;
  const src = ui.focus === 'source';
  const run = fn => { e.preventDefault(); fn(); };
  if (ctrl) {
    const kk = k.toLowerCase();
    if (kk === 'z' && !sh) return run(undo);
    if ((kk === 'z' && sh) || kk === 'y') return run(redo);
    if (kk === 'x' && sh) return run(A.clearInOut);
    if (kk === 'x') return run(() => A.copySelection(true));
    if (kk === 'c') return run(() => A.copySelection());
    if (kk === 'v') return run(() => A.paste(sh));
    if (kk === 'a') return run(sh ? A.clearSelection : A.selectAll);
    if (kk === 'k') return run(() => A.addEdit(sh));
    if (kk === 'd') return run(() => A.applyTransition(sh ? 'constantPower' : 'crossDissolve'));
    if (kk === 'r') return run(A.speedDialog);
    if (kk === 'l') return run(A.toggleLink);
    if (kk === 'j') return run(() => { showTop('claude'); focusClaude(); });
    if (kk === 'm' && sh) return run(() => A.gotoMarker(-1));
    if (kk === 'm') return run(exportDialog);
    if (kk === 'e' && sh) return run(exportFrame);
    if (kk === 'i') return run(doImport);
    if (kk === 's' && sh) return run(saveAs);
    if (kk === 's') return run(async () => { await db.putProject('current', serialize()); toast('Project saved in this browser'); });
    if (kk === 'o') return run(openProject);
    if (kk === 'n' && alt) return run(newProjectCmd);
    if (kk === 'n') return run(A.newSequenceDialog);
    if (kk === 't') return run(() => createTitleAt());
    if (kk === '/' && sh || kk === '?') return run(A.duplicateSelection);
    if (k === '=' || k === '+') return run(() => zoomBy(1.5));
    if (k === '-') return run(() => zoomBy(1 / 1.5));
    return;
  }
  switch (k) {
    case ' ': return run(() => src ? srcToggle() : togglePlay());
    case 'k': case 'K': return run(() => pause());
    case 'l': case 'L': return run(() => shuttle(1));
    case 'j': case 'J': return run(() => shuttle(-1));
    case 'ArrowLeft': return run(() => alt ? A.nudge(sh ? -5 : -1) : (src ? sourceStep(sh ? -5 : -1) : A.step(sh ? -5 : -1)));
    case 'ArrowRight': return run(() => alt ? A.nudge(sh ? 5 : 1) : (src ? sourceStep(sh ? 5 : 1) : A.step(sh ? 5 : 1)));
    case 'ArrowUp': return run(() => A.gotoEdit(-1));
    case 'ArrowDown': return run(() => A.gotoEdit(1));
    case 'Home': return run(() => seek(0));
    case 'End': return run(() => seek(A.seqDuration()));
    case 'i': case 'I': return run(() => sh ? seek(seq().inPoint ?? 0) : src ? srcMarkIn() : A.markIn());
    case 'o': case 'O': return run(() => sh ? seek(seq().outPoint ?? 0) : src ? srcMarkOut() : A.markOut());
    case 'x': case 'X': return run(A.markClip);
    case 'm': case 'M': return run(() => sh ? A.gotoMarker(1) : A.addMarker());
    case 'Delete': case 'Backspace': return run(() => A.deleteSelection(sh));
    case ',': return run(() => srcEdit('insert'));
    case '.': return run(() => srcEdit('overwrite'));
    case ';': return run(() => A.liftExtract(false));
    case "'": return run(() => A.liftExtract(true));
    case 'q': case 'Q': return run(() => A.trimToPlayhead('start'));
    case 'w': case 'W': return run(() => A.trimToPlayhead('end'));
    case '=': case '+': return run(() => zoomBy(1.5));
    case '-': case '_': return run(() => zoomBy(1 / 1.5));
    case '\\': return run(zoomFit);
    case 's': case 'S': return run(() => { ui.snap = !ui.snap; bus.emit('ui'); toast(`Snap ${ui.snap ? 'on' : 'off'}`, 900); });
    case 'e': case 'E': if (sh) return run(A.toggleEnable); break;
    case '`': return run(() => toggleMaximize(hoverPanel));
    case 'F1': case '?': return run(shortcutsHelp);
    case 'Escape': return run(() => { A.clearSelection(); if (ui.tool !== 'select') { ui.tool = 'select'; bus.emit('ui'); } });
  }
  if (sh && /^Digit[1-7]$/.test(e.code)) {
    const n = e.code.slice(-1);
    const map = { 1: () => showBottom('project'), 2: () => showTop('source'), 3: () => $('#p-tl .tl-body').focus(), 4: () => {}, 5: () => showTop('effects'), 6: () => showTop('mixer'), 7: () => showBottom('fxlib') };
    return run(map[n]);
  }
  if (!alt && !sh) {
    const tool = TOOLS.find(t => t[2].toLowerCase() === k.toLowerCase());
    if (tool) { e.preventDefault(); ui.tool = tool[0]; bus.emit('ui'); }
  }
});
function sourceStep(n) { const s = sourceState; if (s.media) { s.t = Math.max(0, s.t + n / seq().fps); if (s.video.src) s.video.currentTime = s.t; } }

// Resume audio on first gesture (autoplay policies)
document.addEventListener('pointerdown', () => ensureAudio(), { once: true });

function shortcutsHelp() {
  const rows = [
    ['Space', 'Play / Stop'], ['J / K / L', 'Shuttle reverse / stop / forward (press L again for faster)'], ['← / →', 'Step 1 frame (Shift: 5)'], ['↑ / ↓', 'Previous / next edit point'],
    ['Home / End', 'Go to start / end'], ['I / O', 'Mark In / Out'], ['X', 'Mark clip'], ['M', 'Add marker'], ['V', 'Selection tool'], ['A', 'Track Select Forward tool'],
    ['B', 'Ripple Edit tool'], ['N', 'Rolling Edit tool'], ['C', 'Razor tool (Shift-click: all tracks)'], ['Y', 'Slip tool'], ['H', 'Hand tool'], ['Z', 'Zoom tool'], ['T', 'Type tool'],
    ['Ctrl+K', 'Add edit at playhead'], ['Delete', 'Clear'], ['Shift+Delete', 'Ripple delete'], ['Q / W', 'Ripple trim previous / next edit to playhead'],
    ['Alt+← / →', 'Nudge clip'], ['Ctrl+D', 'Apply Cross Dissolve'], ['Ctrl+Shift+D', 'Apply Constant Power'], ['Ctrl+R', 'Speed/Duration'], ['Ctrl+L', 'Link / Unlink'], ['Shift+E', 'Enable / Disable clip'],
    [', / .', 'Insert / Overwrite from Source Monitor'], ['; / \'', 'Lift / Extract In-Out'], ['= / - / \\', 'Zoom in / out / fit'], ['S', 'Toggle snapping'],
    ['Alt+drag', 'Duplicate clip (Alt-click selects only one side of a linked clip)'], ['Ctrl+drag edge', 'Ripple trim with the Selection tool'], ['Ctrl+drop', 'Insert instead of overwrite'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'], ['Ctrl+C / X / V', 'Copy / Cut / Paste'], ['Ctrl+M', 'Export Media'], ['Ctrl+Shift+E', 'Export Frame'], ['Ctrl+T', 'New text layer'], ['`', 'Maximize panel under cursor'],
  ];
  modal('Keyboard Shortcuts', h('div.kbd-list', {}, rows.map(([k, d]) => h('div.kbd-row', {}, h('kbd', {}, k), h('span', {}, d)))), [{ label: 'Close', primary: true, action: c => c() }], { wide: true });
}

function welcome() {
  modal('Welcome to Premiere Web', h('div.welcome', {},
    h('p', {}, 'A Premiere Pro–style video editor that runs entirely in your browser. Your media stays on your computer.'),
    h('ol', {},
      h('li', {}, h('b', {}, 'Import'), ' video, audio and images — drag files into the Project panel or press ', h('kbd', {}, 'Ctrl+I'), '.'),
      h('li', {}, h('b', {}, 'Edit'), ' — drag clips to the Timeline, trim edges, cut with the Razor ', h('kbd', {}, 'C'), ', and add transitions and effects from the Effects panel.'),
      h('li', {}, h('b', {}, 'Refine'), ' — select a clip and use Effect Controls for position, scale, opacity, color and keyframes (⏱).'),
      h('li', {}, h('b', {}, 'Export'), ' — File ▸ Export ▸ Media (', h('kbd', {}, 'Ctrl+M'), ') renders an H.264 MP4.'),
    ),
    h('p.muted', {}, 'Your project autosaves in this browser. Press F1 for keyboard shortcuts.'),
  ), [
    { label: 'Close', action: c => c() },
    { label: 'Import Media…', primary: true, action: c => { c(); doImport(); } },
  ]);
}

loadInitial();
window.__app = { project: () => project, seq, ui, bus, A, engine, importFiles, mediaById, placeMedia, commit };
