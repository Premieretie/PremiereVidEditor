// Program and Source monitors.
import { seq, ui, bus, commit, project, mediaById, clipById, seqDuration, placeMedia, activeClipsAt, clipEnd, trackById } from './store.js';
import { engine, seek, togglePlay, pause, play, ensureAudio } from './engine.js';
import { renderFrame, clipCorners, clipTransform, visibleVideo } from './renderer.js';
import { getRT, renderTitle, newGenerated } from './media.js';
import { h, clamp, timecode, parseTimecode, download, EPS } from './util.js';
import { findFx, evalEffect, setParam, EFFECTS } from './effects.js';
import * as A from './actions.js';
import { setDragPayload } from './timeline.js';
import { contextMenu, toast } from './ui.js';

const svg = p => { const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); e.setAttribute('viewBox', '0 0 16 16'); e.innerHTML = p; return e; };
export const ICON = {
  play: () => svg('<path d="M4 2.5v11l9.5-5.5z" fill="currentColor"/>'),
  pause: () => svg('<rect x="3.5" y="2.5" width="3" height="11" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" fill="currentColor"/>'),
  stepB: () => svg('<path d="M12 3v10L5 8z M3 3h2v10H3z" fill="currentColor"/>'),
  stepF: () => svg('<path d="M4 3v10l7-5z M11 3h2v10h-2z" fill="currentColor"/>'),
  markIn: () => svg('<path d="M5 2h6v2H7v8h4v2H5z" fill="currentColor"/>'),
  markOut: () => svg('<path d="M11 2H5v2h4v8H5v2h6z" fill="currentColor"/>'),
  goIn: () => svg('<path d="M3 3h2v10H3z M13 3v10L6 8z" fill="currentColor"/><path d="M14 2h1v12h-1z" fill="currentColor" opacity=".5"/>'),
  goOut: () => svg('<path d="M11 3h2v10h-2z M3 3v10l7-5z" fill="currentColor"/><path d="M1 2h1v12H1z" fill="currentColor" opacity=".5"/>'),
  marker: () => svg('<path d="M4 2h8v8l-4 4-4-4z" fill="currentColor"/>'),
  lift: () => svg('<path d="M8 2l5 5h-3v4H6V7H3z M3 13h10v1.5H3z" fill="currentColor"/>'),
  extract: () => svg('<path d="M8 2l5 5h-3v4H6V7H3z M2 13h4v1.5H2z M10 13h4v1.5h-4z" fill="currentColor"/>'),
  camera: () => svg('<path d="M2 5h3l1.5-2h3L11 5h3v8H2z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="9" r="2.3" fill="none" stroke="currentColor" stroke-width="1.3"/>'),
  insert: () => svg('<path d="M2 4h4v8H2z M10 4h4v8h-4z" fill="currentColor" opacity=".55"/><path d="M8 2v9M5.5 8.5L8 11l2.5-2.5" stroke="currentColor" stroke-width="1.6" fill="none"/>'),
  overwrite: () => svg('<path d="M2 9h12v4H2z" fill="currentColor" opacity=".55"/><path d="M8 2v6M5.5 5.5L8 8l2.5-2.5" stroke="currentColor" stroke-width="1.6" fill="none"/>'),
  film: () => svg('<rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 3v10M11 3v10" stroke="currentColor"/>'),
  wave: () => svg('<path d="M1 8h2l1-4 2 8 2-10 2 10 2-6 1 2h2" fill="none" stroke="currentColor" stroke-width="1.3"/>'),
  loop: () => svg('<path d="M3 8a5 5 0 019-3M13 8a5 5 0 01-9 3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12 2v3H9M4 14v-3h3" fill="none" stroke="currentColor" stroke-width="1.4"/>'),
};

function tbtn(icon, title, fn, cls = '') { return h('button.tbtn' + cls, { title, on: { click: fn } }, icon()); }

// ======================= PROGRAM MONITOR =======================
let pv = {};
export function initProgram(el) {
  const q = () => seq();
  pv.root = el;
  el.append(
    pv.stage = h('div.mon-stage', {},
      pv.canvas = h('canvas.mon-canvas'),
      pv.overlay = h('canvas.mon-overlay'),
    ),
    pv.scrub = h('div.mon-scrub', {}, pv.scrubIO = h('div.mon-scrub-io'), pv.scrubHead = h('div.mon-scrub-head')),
    h('div.mon-info', {},
      pv.tc = h('input.mon-tc', { value: '00:00:00:00', spellcheck: false, title: 'Playhead Position' }),
      h('div.mon-selects', {},
        pv.zoomSel = h('select.mon-sel', { title: 'Select Zoom Level' }, ['Fit', '25%', '50%', '75%', '100%'].map(v => h('option', { value: v }, v))),
        pv.resSel = h('select.mon-sel', { title: 'Select Playback Resolution' }, [['auto', 'Auto'], ['1', 'Full'], ['0.5', '1/2'], ['0.25', '1/4']].map(([v, l]) => h('option', { value: v }, l))),
      ),
      pv.dur = h('div.mon-dur', { title: 'In/Out Duration' }, '00:00:00:00'),
    ),
    h('div.mon-transport', {},
      tbtn(ICON.marker, 'Add Marker (M)', () => A.addMarker()),
      tbtn(ICON.markIn, 'Mark In (I)', () => A.markIn()),
      tbtn(ICON.markOut, 'Mark Out (O)', () => A.markOut()),
      tbtn(ICON.goIn, 'Go to In (Shift+I)', () => seek(q().inPoint ?? 0)),
      tbtn(ICON.stepB, 'Step Back 1 Frame (Left)', () => A.step(-1)),
      pv.playBtn = tbtn(ICON.play, 'Play-Stop Toggle (Space)', () => togglePlay(), '.big'),
      tbtn(ICON.stepF, 'Step Forward 1 Frame (Right)', () => A.step(1)),
      tbtn(ICON.goOut, 'Go to Out (Shift+O)', () => seek(q().outPoint != null ? q().outPoint - 1 / q().fps : seqDuration(q()))),
      tbtn(ICON.lift, 'Lift (;)', () => A.liftExtract(false)),
      tbtn(ICON.extract, "Extract (')", () => A.liftExtract(true)),
      tbtn(ICON.camera, 'Export Frame (Shift+E)', () => exportFrame()),
    ),
  );
  pv.tc.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { seek(parseTimecode(pv.tc.value, q().fps)); pv.tc.blur(); } });
  pv.tc.addEventListener('focus', () => pv.tc.select());
  pv.zoomSel.addEventListener('change', layout);
  pv.resSel.addEventListener('change', () => { engine.dirty = true; });
  el.addEventListener('pointerdown', () => ui.focus = 'program', true);
  new ResizeObserver(layout).observe(pv.stage);
  setupScrub(pv.scrub, () => seqDuration(q()) || 10, t => seek(t));
  setupOverlay();
  engine.renderers.add(drawProgram);
  bus.on('play-state', p => { pv.playBtn.replaceChildren(p ? ICON.pause() : ICON.play()); });
  bus.on('selection', () => drawOverlay());
  bus.on('project', layout);
  bus.on('marks', () => engine.dirty = true);
  layout();
}

function layout() {
  const s = seq();
  const sw = pv.stage.clientWidth, sh = pv.stage.clientHeight;
  if (!sw || !sh) return;
  let k;
  const z = pv.zoomSel.value;
  if (z === 'Fit') k = Math.min((sw - 8) / s.width, (sh - 8) / s.height);
  else k = parseFloat(z) / 100;
  const dw = Math.max(1, Math.round(s.width * k)), dh = Math.max(1, Math.round(s.height * k));
  for (const c of [pv.canvas, pv.overlay]) {
    c.style.width = dw + 'px'; c.style.height = dh + 'px';
    c.style.left = Math.round((sw - dw) / 2) + 'px'; c.style.top = Math.max(0, Math.round((sh - dh) / 2)) + 'px';
  }
  pv.k = k; pv.dw = dw; pv.dh = dh;
  const dpr = devicePixelRatio || 1;
  pv.overlay.width = Math.round(dw * dpr); pv.overlay.height = Math.round(dh * dpr);
  engine.dirty = true;
}

export function previewScale() {
  const s = seq(); const v = pv.resSel?.value || 'auto';
  if (v !== 'auto') return parseFloat(v);
  const dpr = devicePixelRatio || 1;
  return clamp((pv.dw || s.width) * dpr / s.width, 0.1, 1);
}

function drawProgram(t) {
  const s = seq();
  renderFrame(pv.canvas, s, t, previewScale());
  if (document.activeElement !== pv.tc) pv.tc.value = timecode(t, s.fps);
  const a = s.inPoint ?? 0, b = s.outPoint ?? seqDuration(s);
  pv.dur.textContent = timecode(Math.max(0, b - a), s.fps);
  const D = seqDuration(s) || 10;
  pv.scrubHead.style.left = (t / D * 100) + '%';
  pv.scrubIO.style.left = (a / D * 100) + '%'; pv.scrubIO.style.width = (Math.max(0, b - a) / D * 100) + '%';
  pv.scrubIO.style.display = (s.inPoint != null || s.outPoint != null) ? '' : 'none';
  drawOverlay();
}

function setupScrub(bar, getDur, onSeek) {
  bar.addEventListener('pointerdown', e => {
    bar.setPointerCapture(e.pointerId);
    const go = ev => { const r = bar.getBoundingClientRect(); onSeek(clamp((ev.clientX - r.left) / r.width, 0, 1) * getDur()); };
    go(e);
    const up = () => { bar.removeEventListener('pointermove', go); bar.removeEventListener('pointerup', up); };
    bar.addEventListener('pointermove', go); bar.addEventListener('pointerup', up);
  });
}

// ----- Overlay: selected clip bounds + direct manipulation -----
function overlayClip() {
  const s = seq();
  const sel = [...ui.sel].map(id => clipById(id)).filter(c => c && c.type === 'video');
  const t = s.playhead;
  return sel.find(c => c.start <= t + EPS && clipEnd(c) > t + EPS && mediaById(c.mediaId)?.type !== 'adjustment');
}

function drawOverlay() {
  const s = seq(); const o = pv.overlay; if (!o) return;
  const g = o.getContext('2d'); const dpr = devicePixelRatio || 1;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, o.width, o.height);
  const k = pv.k * dpr;
  if (ui.safeMargins) {
    g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1;
    for (const f of [0.9, 0.8]) { const w = s.width * f * k, hh = s.height * f * k; g.strokeRect((o.width - w) / 2 + 0.5, (o.height - hh) / 2 + 0.5, w, hh); }
  }
  const c = overlayClip(); if (!c) return;
  const pts = clipCorners(c, s.playhead, s).map(([x, y]) => [x * k, y * k]);
  g.strokeStyle = '#ffffff'; g.lineWidth = 1;
  g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.stroke();
  const mids = pts.map((p, i) => { const q = pts[(i + 1) % 4]; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; });
  g.fillStyle = '#fff';
  for (const [x, y] of [...pts, ...mids]) g.fillRect(x - 3, y - 3, 6, 6);
  const T = clipTransform(c, s.playhead, s);
  g.strokeStyle = '#fff'; g.beginPath(); g.arc(T.x * k, T.y * k, 5, 0, Math.PI * 2); g.moveTo(T.x * k - 8, T.y * k); g.lineTo(T.x * k + 8, T.y * k); g.moveTo(T.x * k, T.y * k - 8); g.lineTo(T.x * k, T.y * k + 8); g.stroke();
}

function setupOverlay() {
  const o = pv.overlay;
  const toSeq = e => { const r = o.getBoundingClientRect(); return [(e.clientX - r.left) / pv.k, (e.clientY - r.top) / pv.k]; };
  o.addEventListener('pointermove', e => {
    if (e.buttons) return;
    const c = overlayClip();
    if (ui.tool === 'type') { o.style.cursor = 'text'; return; }
    if (!c) { o.style.cursor = 'default'; return; }
    const s = seq(); const [x, y] = toSeq(e);
    const pts = clipCorners(c, s.playhead, s);
    const near = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) * pv.k < 8);
    const nearR = pts.findIndex(([px, py]) => { const d = Math.hypot(px - x, py - y) * pv.k; return d >= 8 && d < 22; });
    o.style.cursor = near >= 0 ? 'nwse-resize' : inside(pts, x, y) ? 'move' : nearR >= 0 ? 'alias' : 'default';
  });
  o.addEventListener('dblclick', e => {
    // Double-click selects topmost visible clip under cursor
    const s = seq(); const [x, y] = toSeq(e);
    const vis = visibleVideo(s, s.playhead).map(v => v.clip).reverse();
    const hit = vis.find(c => inside(clipCorners(c, s.playhead, s), x, y));
    if (hit) A.selectClip(hit);
  });
  // Two-finger pinch on the monitor scales the selected clip.
  const fingers = new Map(); let pinch = null, pinchGen = 0;
  const fdist = () => { const [a, b] = [...fingers.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  o.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    fingers.set(e.pointerId, [e.clientX, e.clientY]);
    if (fingers.size !== 2) return;
    e.stopImmediatePropagation();
    const c = overlayClip(); const fx = c && findFx(c, 'motion'); if (!fx) return;
    const s = seq(); const lt = s.playhead - c.start;
    pinchGen++;
    pinch = { fx, lt, d0: Math.max(10, fdist()), v0: evalEffect(fx, lt).scale, before: JSON.stringify(fx) };
  }, true);
  o.addEventListener('pointermove', e => {
    if (!fingers.has(e.pointerId)) return;
    fingers.set(e.pointerId, [e.clientX, e.clientY]);
    if (!pinch || fingers.size !== 2) return;
    Object.assign(pinch.fx, JSON.parse(pinch.before));
    setParam(pinch.fx, 'scale', Math.round(clamp(pinch.v0 * fdist() / pinch.d0, 1, 1000) * 10) / 10, pinch.lt);
    engine.dirty = true; bus.emit('fx-live');
  });
  const fingerUp = e => {
    fingers.delete(e.pointerId);
    if (pinch && fingers.size < 2) {
      const { fx, before } = pinch; pinch = null;
      const after = JSON.stringify(fx); Object.assign(fx, JSON.parse(before));
      if (after !== before) commit('Scale', () => Object.assign(fx, JSON.parse(after)));
    }
  };
  o.addEventListener('pointerup', fingerUp); o.addEventListener('pointercancel', fingerUp);

  o.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const s = seq(); const [x, y] = toSeq(e);
    if (ui.tool === 'type') { createTitleAt(x, y); return; }
    let c = overlayClip();
    if (!c) {
      const vis = visibleVideo(s, s.playhead).map(v => v.clip).reverse();
      const hit = vis.find(cc => inside(clipCorners(cc, s.playhead, s), x, y) && mediaById(cc.mediaId)?.type !== 'adjustment');
      if (!hit) return;
      A.selectClip(hit); c = hit;
    }
    const fx = findFx(c, 'motion'); if (!fx) return;
    const lt = s.playhead - c.start;
    const pts = clipCorners(c, s.playhead, s);
    const T = clipTransform(c, s.playhead, s);
    const corner = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) * pv.k < 8);
    const rot = corner < 0 && !inside(pts, x, y) && pts.some(([px, py]) => Math.hypot(px - x, py - y) * pv.k < 22);
    if (corner < 0 && !rot && !inside(pts, x, y)) { A.clearSelection(); return; }
    const v0 = evalEffect(fx, lt);
    const x0 = v0.x ?? s.width / 2, y0 = v0.y ?? s.height / 2;
    const before = JSON.stringify(fx);
    const gen = pinchGen;
    const d0 = Math.hypot(x - T.x, y - T.y), a0 = Math.atan2(y - T.y, x - T.x);
    o.setPointerCapture(e.pointerId);
    const mv = ev => {
      if (ev.pointerId !== e.pointerId || pinch) return;
      const [nx, ny] = toSeq(ev);
      Object.assign(fx, JSON.parse(before));
      if (corner >= 0) {
        const d = Math.hypot(nx - T.x, ny - T.y);
        setParam(fx, 'scale', Math.round(clamp(v0.scale * d / Math.max(1, d0), 0, 1000) * 10) / 10, lt);
      } else if (rot) {
        let a = (Math.atan2(ny - T.y, nx - T.x) - a0) * 180 / Math.PI;
        if (ev.shiftKey) a = Math.round(a / 15) * 15;
        setParam(fx, 'rotation', Math.round((v0.rotation + a) * 10) / 10, lt);
      } else {
        let px = x0 + (nx - x), py = y0 + (ny - y);
        if (ev.shiftKey) { if (Math.abs(nx - x) > Math.abs(ny - y)) py = y0; else px = x0; }
        // snap to center
        if (Math.abs(px - s.width / 2) * pv.k < 6) px = s.width / 2;
        if (Math.abs(py - s.height / 2) * pv.k < 6) py = s.height / 2;
        setParam(fx, 'x', Math.round(px * 10) / 10, lt); setParam(fx, 'y', Math.round(py * 10) / 10, lt);
      }
      engine.dirty = true; bus.emit('fx-live');
    };
    const up = ev => {
      if (ev.pointerId !== e.pointerId) return;
      o.removeEventListener('pointermove', mv); o.removeEventListener('pointerup', up); o.removeEventListener('pointercancel', up);
      if (pinch || gen !== pinchGen) return; // a pinch took over and commits its own change
      const after = JSON.stringify(fx);
      Object.assign(fx, JSON.parse(before));
      if (after !== before) commit(corner >= 0 ? 'Scale' : rot ? 'Rotation' : 'Position', () => Object.assign(fx, JSON.parse(after)));
    };
    o.addEventListener('pointermove', mv); o.addEventListener('pointerup', up); o.addEventListener('pointercancel', up);
  });
}

function inside(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function createTitleAt(x, y) {
  const s = seq();
  const m = newGenerated('title', 'Graphic');
  const tr = s.videoTracks.find(t => !t.locked && !s.clips.some(c => c.trackId === t.id && c.start < s.playhead + 5 && clipEnd(c) > s.playhead)) || s.videoTracks[s.videoTracks.length - 1];
  const created = commit('New Text Layer', () => {
    const cl = placeMedia(m, s.playhead, { vTrack: tr.id, audio: false }, s);
    const mfx = findFx(cl[0], 'motion');
    if (x != null) { mfx.params.x = Math.round(x); mfx.params.y = Math.round(y); }
    else { mfx.params.x = s.width / 2; mfx.params.y = Math.round(s.height * 0.8); }
    const tfx = findFx(cl[0], 'text'); tfx.params.size = Math.round(s.height / 11);
    return cl;
  });
  ui.sel = new Set(created.map(c => c.id)); ui.tool = 'select';
  bus.emit('ui'); bus.emit('selection'); bus.emit('focus-effect-controls', 'text');
}

export function exportFrame() {
  const s = seq();
  const c = document.createElement('canvas');
  renderFrame(c, s, s.playhead, 1);
  c.toBlob(b => download(b, `${s.name} ${timecode(s.playhead, s.fps).replace(/:/g, '-')}.png`), 'image/png');
}

// ======================= SOURCE MONITOR =======================
const sv = { media: null, t: 0, playing: false };
export function initSource(el) {
  el.append(
    sv.stage = h('div.mon-stage.src', {},
      sv.video = h('video.src-video', { playsInline: true, preload: 'auto' }),
      sv.canvas = h('canvas.src-canvas'),
      sv.empty = h('div.src-empty', {}, 'Double-click a clip in the Project panel to open it here'),
    ),
    sv.scrub = h('div.mon-scrub', {}, sv.scrubIO = h('div.mon-scrub-io'), sv.scrubHead = h('div.mon-scrub-head')),
    h('div.mon-info', {},
      sv.tc = h('input.mon-tc', { value: '00:00:00:00', spellcheck: false }),
      sv.name = h('div.src-name'),
      sv.dur = h('div.mon-dur', { title: 'In/Out Duration' }, '00:00:00:00'),
    ),
    h('div.mon-transport', {},
      tbtn(ICON.markIn, 'Mark In (I)', () => srcMarkIn()),
      tbtn(ICON.markOut, 'Mark Out (O)', () => srcMarkOut()),
      tbtn(ICON.goIn, 'Go to In', () => srcSeek(sv.media?.srcIn ?? 0)),
      tbtn(ICON.stepB, 'Step Back', () => srcStep(-1)),
      sv.playBtn = tbtn(ICON.play, 'Play-Stop Toggle (Space)', () => srcToggle(), '.big'),
      tbtn(ICON.stepF, 'Step Forward', () => srcStep(1)),
      tbtn(ICON.goOut, 'Go to Out', () => srcSeek(sv.media?.srcOut ?? srcDur())),
      tbtn(ICON.insert, 'Insert (,)', () => srcEdit('insert')),
      tbtn(ICON.overwrite, 'Overwrite (.)', () => srcEdit('overwrite')),
      sv.dragV = h('div.drag-handle', { draggable: true, title: 'Drag Video Only' }, ICON.film()),
      sv.dragA = h('div.drag-handle', { draggable: true, title: 'Drag Audio Only' }, ICON.wave()),
    ),
  );
  sv.video.addEventListener('timeupdate', () => { if (sv.playing) { sv.t = sv.video.currentTime; drawSource(); } });
  sv.video.addEventListener('seeked', drawSource);
  sv.video.addEventListener('ended', () => { sv.playing = false; sv.playBtn.replaceChildren(ICON.play()); });
  sv.tc.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { srcSeek(parseTimecode(sv.tc.value, seq().fps)); sv.tc.blur(); } });
  el.addEventListener('pointerdown', () => ui.focus = 'source', true);
  setupScrub(sv.scrub, srcDur, t => srcSeek(t));
  const startDrag = (e, video, audio) => {
    if (!sv.media) return e.preventDefault();
    e.dataTransfer.setData('text/plain', sv.media.name);
    e.dataTransfer.effectAllowed = 'copy';
    setDragPayload({ kind: 'media', mediaId: sv.media.id, srcIn: sv.media.srcIn ?? 0, srcOut: sv.media.srcOut ?? null, video, audio });
  };
  sv.stage.draggable = true;
  sv.stage.addEventListener('dragstart', e => startDrag(e, true, true));
  sv.dragV.addEventListener('dragstart', e => startDrag(e, true, false));
  sv.dragA.addEventListener('dragstart', e => startDrag(e, false, true));
  new ResizeObserver(drawSource).observe(sv.stage);
  bus.on('open-source', (id, clip) => openSource(id, clip));
  bus.on('media-updated', () => { if (sv.media && !sv.media.offline && !sv.video.src && getRT(sv.media.id).url) openSource(sv.media.id); });
  bus.on('project', () => { if (sv.media && !mediaById(sv.media.id)) closeSource(); });
}

const srcDur = () => sv.media ? (sv.media.type === 'video' || sv.media.type === 'audio' ? sv.media.duration : 5) : 10;

export function openSource(id, clip) {
  const m = mediaById(id); if (!m) return;
  sv.media = m; sv.playing = false;
  sv.empty.style.display = 'none';
  sv.name.textContent = m.name;
  const R = getRT(m.id);
  if ((m.type === 'video' || m.type === 'audio') && R.url) {
    if (sv.video.src !== R.url) sv.video.src = R.url;
    sv.video.style.display = m.type === 'video' ? '' : 'none';
    sv.canvas.style.display = m.type === 'video' ? 'none' : '';
  } else {
    sv.video.removeAttribute('src'); sv.video.style.display = 'none'; sv.canvas.style.display = '';
  }
  sv.t = clip ? clip.in : (m.srcIn ?? 0);
  if (sv.video.src) sv.video.currentTime = sv.t;
  bus.emit('show-tab', 'source');
  ui.focus = 'source';
  drawSource();
}
function closeSource() { sv.media = null; sv.video.removeAttribute('src'); sv.empty.style.display = ''; sv.name.textContent = ''; drawSource(); }

function drawSource() {
  const m = sv.media; const D = srcDur();
  sv.tc.value = timecode(sv.t, seq().fps);
  sv.scrubHead.style.left = (sv.t / D * 100) + '%';
  const a = m?.srcIn ?? 0, b = m?.srcOut ?? D;
  sv.scrubIO.style.display = m && (m.srcIn != null || m.srcOut != null) ? '' : 'none';
  sv.scrubIO.style.left = (a / D * 100) + '%'; sv.scrubIO.style.width = ((b - a) / D * 100) + '%';
  sv.dur.textContent = timecode(b - a, seq().fps);
  const c = sv.canvas; const st = sv.stage;
  if (c.style.display === 'none' || !m) return;
  const dpr = devicePixelRatio || 1;
  c.width = Math.max(1, st.clientWidth * dpr); c.height = Math.max(1, st.clientHeight * dpr);
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  const R = getRT(m.id);
  let img = null;
  if (m.type === 'image') img = R.img;
  else if (m.type === 'title') img = renderTitle(EFFECTS.text.params.reduce((o, p) => (o[p.k] = p.def, o), {}));
  if (m.type === 'color') { g.fillStyle = m.color || EFFECTS.colorMatte.params[0].def; g.fillRect(0, 0, c.width, c.height); }
  if (img) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const k = Math.min(c.width / iw, c.height / ih);
    g.drawImage(img, (c.width - iw * k) / 2, (c.height - ih * k) / 2, iw * k, ih * k);
  }
  if (m.type === 'audio' && R.peaks) {
    const pk = R.peaks; g.fillStyle = '#3fd0a8'; const mid = c.height / 2;
    for (let x = 0; x < c.width; x++) {
      const i0 = Math.floor(x / c.width * pk.data.length / 2), i1 = Math.floor((x + 1) / c.width * pk.data.length / 2);
      let mn = 0, mx = 0; for (let i = i0; i <= i1 && i * 2 < pk.data.length; i++) { mn = Math.min(mn, pk.data[i * 2]); mx = Math.max(mx, pk.data[i * 2 + 1]); }
      g.fillRect(x, mid - mx * mid * 0.9, 1, Math.max(1, (mx - mn) * mid * 0.9));
    }
    g.fillStyle = '#fff'; g.fillRect(sv.t / D * c.width, 0, 1 * dpr, c.height);
  }
}

function srcSeek(t) { if (!sv.media) return; sv.t = clamp(t, 0, srcDur()); if (sv.video.src) sv.video.currentTime = sv.t; drawSource(); }
function srcStep(n) { srcPause(); srcSeek(sv.t + n / seq().fps); }
function srcPause() { sv.playing = false; sv.video.pause(); sv.playBtn.replaceChildren(ICON.play()); }
export function srcToggle() {
  if (!sv.media || !sv.video.src) return;
  if (sv.playing) return srcPause();
  pause();
  sv.playing = true; sv.playBtn.replaceChildren(ICON.pause());
  if (sv.t >= srcDur() - 0.05) srcSeek(0);
  sv.video.play().catch(() => { });
}
export function srcMarkIn() { if (!sv.media) return; sv.media.srcIn = sv.t; if (sv.media.srcOut != null && sv.media.srcOut <= sv.t) sv.media.srcOut = null; drawSource(); }
export function srcMarkOut() { if (!sv.media) return; sv.media.srcOut = sv.t; if (sv.media.srcIn != null && sv.media.srcIn >= sv.t) sv.media.srcIn = null; drawSource(); }
export function srcShuttleStep(n) { srcStep(n); }
export function srcEdit(mode) {
  const m = sv.media; if (!m) return toast('Open a clip in the Source Monitor first');
  const s = seq();
  const created = commit(mode === 'insert' ? 'Insert' : 'Overwrite', () => placeMedia(m, s.playhead, { srcIn: m.srcIn ?? 0, srcOut: m.srcOut ?? null, mode }, s));
  if (created?.length) seek(Math.max(...created.map(clipEnd)));
}
export const sourceState = sv;
