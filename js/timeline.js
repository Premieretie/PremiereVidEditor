// Timeline panel: canvas-drawn tracks, ruler, tools and drag interactions.
import {
  seq, ui, bus, commit, project, clipEnd, mediaById, trackById, trackKind, linkedOf, trackClips, clearRange,
  editPoints, seqDuration, mediaMaxDur, trimHead, shiftKeyframes, cloneClip, placeMedia, rippleShift,
} from './store.js';
import { seek, pause } from './engine.js';
import { getRT, importFiles } from './media.js';
import { h, $, clamp, timecode, parseTimecode, uid, EPS, gainToDb, dbToGain } from './util.js';
import { TRANSITIONS, EFFECTS, findFx, evalParam } from './effects.js';
import * as A from './actions.js';
import { contextMenu, toast, prompt } from './ui.js';

const RULER_H = 30;
const SEP_H = 8;
const EDGE_PX = 7;

let root, rulerCv, bodyCv, headersEl, headersInner, hbar, hthumb, tcEl, tabsEl;
let rg, bg; // contexts
let W = 0, H = 0, dpr = 1;
let dirty = true;
let drag = null;           // active drag state
let hover = null;          // hover info for cursor + razor line
let snapLine = null;       // time of snap indicator
let dropGhost = null;      // {rows:[{y,h}], t, dur}
let rows = [];

const s = () => seq();
const zoom = () => s().zoom;
const tToX = t => t * zoom() - s().scrollX;
const xToT = x => (x + s().scrollX) / zoom();
const frameT = t => Math.round(t * s().fps) / s().fps;

export function invalidate() { dirty = true; }

// ---------------- Layout ----------------
function layoutRows() {
  const q = s();
  rows = [];
  let y = 0;
  for (let i = q.videoTracks.length - 1; i >= 0; i--) { const tr = q.videoTracks[i]; rows.push({ track: tr, kind: 'video', index: i, y, h: tr.height }); y += tr.height; }
  y += SEP_H;
  q.audioTracks.forEach((tr, i) => { rows.push({ track: tr, kind: 'audio', index: i, y, h: tr.height }); y += tr.height; });
  return y;
}
const contentH = () => (rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : 0) + 60;
const rowAtY = y => rows.find(r => y >= r.y - s().scrollY && y < r.y + r.h - s().scrollY);
const rowOf = trackId => rows.find(r => r.track.id === trackId);
const rowY = r => r.y - s().scrollY;

// ---------------- Init ----------------
export function initTimeline(el) {
  root = el;
  root.append(
    h('div.tl-top', {},
      tabsEl = h('div.tl-seqtabs'),
    ),
    h('div.tl-bar', {},
      tcEl = h('input.tl-tc', { value: '00:00:00:00', title: 'Playhead Position (click to type a timecode)', spellcheck: false }),
      h('div.tl-bar-btns', {},
        btn('snap', 'Snap in Timeline (S)', svgSnap(), () => { ui.snap = !ui.snap; bus.emit('ui'); }),
        btn('linked', 'Linked Selection', svgLink(), () => { ui.linked = !ui.linked; bus.emit('ui'); }),
        btn('marker', 'Add Marker (M)', svgMarker(), () => A.addMarker()),
        btn('settings', 'Timeline Display Settings', svgWrench(), e => {
          const r = e.currentTarget.getBoundingClientRect();
          contextMenu(r.left, r.bottom, [
            { label: 'Expand All Tracks', action: () => setAllHeights(90) },
            { label: 'Minimize All Tracks', action: () => setAllHeights(34) },
            { label: 'Reset Track Heights', action: () => setAllHeights(54) },
            '-',
            { label: 'Add Video Track', action: () => A.addTracks('video') },
            { label: 'Add Audio Track', action: () => A.addTracks('audio') },
          ]);
        }),
      ),
      h('div.tl-zoomtools', {},
        h('button.icon-btn', { title: 'Zoom Out (-)', on: { click: () => zoomBy(1 / 1.5) } }, '−'),
        h('button.icon-btn', { title: 'Zoom to Fit (\\)', on: { click: () => zoomFit() } }, '⇔'),
        h('button.icon-btn', { title: 'Zoom In (=)', on: { click: () => zoomBy(1.5) } }, '+'),
      ),
    ),
    h('div.tl-main', {},
      h('div.tl-corner'),
      rulerCv = h('canvas.tl-ruler'),
      headersEl = h('div.tl-headers', {}, headersInner = h('div.tl-headers-inner')),
      bodyCv = h('canvas.tl-body', { tabindex: 0 }),
      h('div.tl-hcorner'),
      hbar = h('div.tl-hbar', {}, hthumb = h('div.tl-hthumb', {}, h('div.tl-hgrip.l'), h('div.tl-hgrip.r'))),
    ),
  );
  rg = rulerCv.getContext('2d'); bg = bodyCv.getContext('2d');

  tcEl.addEventListener('focus', () => tcEl.select());
  tcEl.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { seek(parseTimecode(tcEl.value, s().fps)); tcEl.blur(); }
    if (e.key === 'Escape') tcEl.blur();
  });
  tcEl.addEventListener('blur', () => updateTC());

  new ResizeObserver(() => { resize(); }).observe(root.querySelector('.tl-main'));
  setupRuler(); setupBody(); setupHBar(); setupDrop();

  bus.on('change', () => { dirty = true; buildHeaders(); buildTabs(); });
  bus.on('project', () => { dirty = true; buildHeaders(); buildTabs(); });
  bus.on('selection', () => dirty = true);
  bus.on('media-updated', () => dirty = true);
  bus.on('marks', () => dirty = true);
  bus.on('time', t => { dirty = true; updateTC(); autoScroll(t); });
  bus.on('ui', () => { dirty = true; syncBtns(); });
  buildHeaders(); buildTabs(); syncBtns();
  const loop = () => { if (dirty) { dirty = false; draw(); } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}

function btn(name, title, icon, fn) {
  return h('button.icon-btn.tl-' + name, { title, on: { click: fn } }, icon);
}
function syncBtns() {
  root.querySelector('.tl-snap')?.classList.toggle('on', ui.snap);
  root.querySelector('.tl-linked')?.classList.toggle('on', ui.linked);
  bodyCv.dataset.tool = ui.tool;
}
const svg = (p, vb = '0 0 16 16') => { const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); e.setAttribute('viewBox', vb); e.innerHTML = p; return e; };
const svgSnap = () => svg('<path d="M3 2v6a5 5 0 0010 0V2h-3v6a2 2 0 01-4 0V2z" fill="currentColor"/><rect x="3" y="2" width="3" height="2" fill="#000" opacity=".35"/><rect x="10" y="2" width="3" height="2" fill="#000" opacity=".35"/>');
const svgLink = () => svg('<path d="M6.5 9.5l3-3M5 7L3.5 8.5a2.5 2.5 0 003.5 3.5L8.5 10.5M11 9l1.5-1.5a2.5 2.5 0 00-3.5-3.5L7.5 5.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>');
const svgMarker = () => svg('<path d="M4 2h8v8l-4 4-4-4z" fill="currentColor"/>');
const svgWrench = () => svg('<path d="M10.5 1.5a3.5 3.5 0 00-3.3 4.6L1.8 11.5a1.4 1.4 0 002 2l5.4-5.4a3.5 3.5 0 004.6-3.3l-2 2-2-.6-.6-2z" fill="currentColor"/>');

function setAllHeights(hgt) {
  const q = s(); for (const t of [...q.videoTracks, ...q.audioTracks]) t.height = hgt;
  dirty = true; buildHeaders();
}

function updateTC() {
  if (document.activeElement !== tcEl) tcEl.value = timecode(s().playhead, s().fps);
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  const main = root.querySelector('.tl-main');
  const r = bodyCv.getBoundingClientRect();
  W = Math.max(10, Math.floor(r.width)); H = Math.max(10, Math.floor(r.height));
  for (const [cv, w, hh] of [[bodyCv, W, H], [rulerCv, W, RULER_H]]) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
  }
  dirty = true;
  void main;
}

function buildTabs() {
  tabsEl.innerHTML = '';
  for (const q of project.sequences) {
    const t = h('div.tl-seqtab' + (q.id === project.activeSeqId ? '.active' : ''), { title: `${q.width}×${q.height} ${q.fps}fps` }, q.name);
    t.addEventListener('pointerdown', () => { if (project.activeSeqId !== q.id) { pause(); project.activeSeqId = q.id; ui.sel.clear(); bus.emit('project'); } });
    tabsEl.append(t);
  }
}

// ---------------- Track headers ----------------
function buildHeaders() {
  layoutRows();
  headersInner.innerHTML = '';
  const q = s();
  for (const r of rows) {
    const tr = r.track;
    const isV = r.kind === 'video';
    const toggle = (prop, label, title, cls) => {
      const b = h('button.th-btn.' + cls + (tr[prop] ? '.on' : ''), { title }, label);
      b.addEventListener('click', () => { commit(title, () => { tr[prop] = !tr[prop]; }); });
      return b;
    };
    const short = (isV ? 'V' : 'A') + (r.index + 1);
    const tgt = h('button.th-target' + (tr.target ? '.on' : ''), { title: 'Toggle track targeting' }, short);
    tgt.addEventListener('click', () => { tr.target = !tr.target; buildHeaders(); dirty = true; });
    const el = h('div.th.' + r.kind, { style: { height: tr.height + 'px' } },
      toggle('locked', '🔒︎', 'Toggle Track Lock', 'lock'),
      tgt,
      isV ? toggle('hidden', '👁︎', 'Toggle Track Output', 'eye') : null,
      !isV ? toggle('muted', 'M', 'Mute Track', 'mute') : null,
      !isV ? toggle('solo', 'S', 'Solo Track', 'solo') : null,
      h('div.th-name', { title: 'Double-click to rename' }, tr.name === short ? (isV ? 'Video ' : 'Audio ') + (r.index + 1) : tr.name),
      h('div.th-resize'),
    );
    if (isV && tr.hidden) el.classList.add('off');
    el.querySelector('.th-name').addEventListener('dblclick', async () => {
      const n = await prompt('Rename Track', 'Track Name', tr.name); if (n) commit('Rename Track', () => tr.name = n);
    });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Rename…', action: async () => { const n = await prompt('Rename Track', 'Track Name', tr.name); if (n) commit('Rename Track', () => tr.name = n); } },
        { label: 'Add Video Track', action: () => A.addTracks('video') },
        { label: 'Add Audio Track', action: () => A.addTracks('audio') },
        { label: 'Delete Track', action: () => A.removeTrack(tr.id) },
      ]);
    });
    const rz = el.querySelector('.th-resize');
    rz.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation(); rz.setPointerCapture(e.pointerId);
      const y0 = e.clientY, h0 = tr.height;
      const mv = ev => { tr.height = clamp(h0 + ev.clientY - y0, 26, 220); el.style.height = tr.height + 'px'; layoutRows(); dirty = true; };
      const up = () => { rz.removeEventListener('pointermove', mv); rz.removeEventListener('pointerup', up); buildHeaders(); };
      rz.addEventListener('pointermove', mv); rz.addEventListener('pointerup', up);
    });
    headersInner.append(el);
    if (r.kind === 'video' && r.index === 0) headersInner.append(h('div.th-sep', { style: { height: SEP_H + 'px' } }));
  }
  headersInner.style.transform = `translateY(${-q.scrollY}px)`;
}

// ---------------- Drawing ----------------
function niceStep(pxPerSec, fps) {
  const minPx = 90;
  const cand = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const c of cand) if (c * pxPerSec >= minPx) return c;
  return 7200;
}

function draw() {
  const q = s();
  layoutRows();
  clampScroll();
  headersInner.style.transform = `translateY(${-q.scrollY}px)`;
  drawRuler(q);
  drawBody(q);
  updateHBar();
}

function drawRuler(q) {
  const g = rg;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#1d1d1d'; g.fillRect(0, 0, W, RULER_H);
  // in/out
  if (q.inPoint != null || q.outPoint != null) {
    const a = q.inPoint ?? 0, b = q.outPoint ?? seqDuration(q);
    g.fillStyle = 'rgba(120,130,150,0.35)'; g.fillRect(tToX(a), 0, tToX(b) - tToX(a), RULER_H);
    g.fillStyle = '#9aa8c2';
    if (q.inPoint != null) g.fillRect(tToX(a), 0, 2, RULER_H);
    if (q.outPoint != null) g.fillRect(tToX(b) - 2, 0, 2, RULER_H);
  }
  const step = niceStep(zoom(), q.fps);
  const sub = step >= 1 ? step / (step >= 60 ? 6 : step >= 10 ? 5 : step >= 2 ? 4 : 5) : step / 2;
  const t0 = Math.floor(xToT(0) / sub) * sub;
  g.strokeStyle = '#6a6a6a'; g.fillStyle = '#a8a8a8'; g.font = '10px system-ui, sans-serif'; g.textBaseline = 'top';
  g.beginPath();
  for (let t = t0; tToX(t) < W + 2; t += sub) {
    const x = Math.round(tToX(t)) + 0.5;
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-4;
    g.moveTo(x, major ? 14 : 22); g.lineTo(x, RULER_H);
    if (major) g.fillText(timecode(t, q.fps), x + 3, 3);
  }
  g.stroke();
  g.strokeStyle = '#333'; g.beginPath(); g.moveTo(0, RULER_H - 0.5); g.lineTo(W, RULER_H - 0.5); g.stroke();
  // markers
  for (const m of q.markers) {
    const x = tToX(m.t);
    g.fillStyle = m.color || '#3ec85a';
    g.beginPath(); g.moveTo(x - 5, 14); g.lineTo(x + 5, 14); g.lineTo(x + 5, 21); g.lineTo(x, 26); g.lineTo(x - 5, 21); g.closePath(); g.fill();
  }
  // playhead
  const px = Math.round(tToX(q.playhead)) + 0.5;
  g.fillStyle = '#2d8ceb';
  g.beginPath(); g.moveTo(px - 6, 12); g.lineTo(px + 6, 12); g.lineTo(px + 6, 22); g.lineTo(px, 29); g.lineTo(px - 6, 22); g.closePath(); g.fill();
  g.fillRect(px - 0.5, 22, 1, 8);
}

function drawBody(q) {
  const g = bg;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#1b1b1b'; g.fillRect(0, 0, W, H);
  for (const r of rows) {
    const y = rowY(r);
    if (y > H || y + r.h < 0) continue;
    g.fillStyle = r.track.target ? '#212124' : '#1f1f1f';
    g.fillRect(0, y, W, r.h);
    g.fillStyle = '#151515'; g.fillRect(0, y + r.h - 1, W, 1);
  }
  const vr = rows.find(r => r.kind === 'video' && r.index === 0);
  if (vr) { g.fillStyle = '#111'; g.fillRect(0, rowY(vr) + vr.h, W, SEP_H); }
  // in/out shading
  if (q.inPoint != null || q.outPoint != null) {
    const a = q.inPoint ?? 0, b = q.outPoint ?? seqDuration(q);
    g.fillStyle = 'rgba(140,150,170,0.06)'; g.fillRect(tToX(a), 0, tToX(b) - tToX(a), H);
  }
  // clips
  const tMin = xToT(-10), tMax = xToT(W + 10);
  for (const c of q.clips) {
    if (clipEnd(c) < tMin || c.start > tMax) continue;
    const r = rowOf(c.trackId); if (!r) continue;
    drawClip(g, c, r, q);
  }
  // marquee
  if (drag?.mode === 'marquee' && drag.moved) {
    const x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1);
    g.fillStyle = 'rgba(80,140,230,0.15)'; g.strokeStyle = '#5a9be8'; g.lineWidth = 1;
    g.fillRect(x0, y0, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    g.strokeRect(x0 + 0.5, y0 + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
  }
  // drop ghost
  if (dropGhost) {
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.strokeStyle = '#fff'; g.setLineDash([4, 3]);
    for (const gr of dropGhost.rows) {
      const x = tToX(dropGhost.t), w = dropGhost.dur * zoom();
      g.fillRect(x, rowY(gr) + 1, w, gr.h - 2); g.strokeRect(x + 0.5, rowY(gr) + 1.5, w - 1, gr.h - 3);
    }
    g.setLineDash([]);
  }
  // markers lines
  for (const m of q.markers) { g.fillStyle = 'rgba(62,200,90,0.35)'; g.fillRect(Math.round(tToX(m.t)), 0, 1, H); }
  // snap line
  if (snapLine != null) { g.fillStyle = '#ffffff'; g.fillRect(Math.round(tToX(snapLine)), 0, 1, H); }
  // razor hover
  if (hover?.razorT != null) {
    g.fillStyle = '#f0f0f0'; const x = Math.round(tToX(hover.razorT));
    if (hover.allTracks) g.fillRect(x, 0, 1, H);
    else if (hover.row) g.fillRect(x, rowY(hover.row), 1, hover.row.h);
  }
  // playhead
  g.fillStyle = '#2d8ceb'; g.fillRect(Math.round(tToX(q.playhead)), 0, 1, H);
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = v => clamp(Math.round(v * f), 0, 255);
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

function drawClip(g, c, r, q) {
  const media = mediaById(c.mediaId);
  const x0 = tToX(c.start), x1 = tToX(clipEnd(c));
  const y = rowY(r) + 1, hh = r.h - 3;
  const w = x1 - x0;
  if (w < 0.5) return;
  const sel = ui.sel.has(c.id);
  const off = !media || media.offline;
  const base = off ? '#c43030' : c.label;
  const disabled = c.enabled === false;
  g.save();
  g.beginPath(); g.rect(Math.max(-2, x0), y, Math.min(W + 4, x1) - Math.max(-2, x0), hh); g.clip();
  g.fillStyle = shade(base, disabled ? 0.32 : sel ? 0.78 : 0.55);
  g.fillRect(x0, y, w, hh);
  // header band
  const band = Math.min(16, hh);
  g.fillStyle = shade(base, disabled ? 0.4 : sel ? 1.05 : 0.8);
  g.fillRect(x0, y, w, band);
  const R = media ? getRT(media.id) : {};
  // thumbnails (video)
  if (c.type === 'video' && hh > 30 && R.thumbs?.length && !off) {
    const ty = y + band, th = hh - band;
    const t0 = R.thumbs[0].c;
    const tw = Math.max(8, th * t0.width / t0.height);
    const startX = Math.max(x0, Math.floor((0 - x0) / tw) * tw + x0);
    g.globalAlpha = disabled ? 0.3 : 0.85;
    for (let x = startX; x < Math.min(x1, W); x += tw) {
      const st = c.in + ((x - x0) / zoom()) * c.speed;
      let best = R.thumbs[0];
      for (const th_ of R.thumbs) if (th_.t <= st + 0.01) best = th_;
      g.drawImage(best.c, x, ty, tw, th);
    }
    g.globalAlpha = 1;
  } else if (c.type === 'video' && hh > 30 && media && (media.type === 'title' || media.type === 'color' || media.type === 'adjustment')) {
    g.fillStyle = 'rgba(255,255,255,0.08)';
    if (media.type === 'color') { g.fillStyle = findFx(c, 'colorMatte')?.params.color || '#000'; g.globalAlpha = 0.8; }
    g.fillRect(x0, y + band, w, hh - band); g.globalAlpha = 1;
  }
  // waveform
  if (c.type === 'audio' && R.peaks && hh > 20) {
    const pk = R.peaks; const mid = y + band + (hh - band) / 2; const amp = (hh - band) / 2 - 1;
    const lvl = findFx(c, 'volume'); const gain = lvl ? dbToGain(lvl.params.level) : 1;
    g.fillStyle = disabled ? 'rgba(255,255,255,0.25)' : 'rgba(230,255,240,0.75)';
    const xa = Math.max(Math.floor(x0), 0), xb = Math.min(Math.ceil(x1), W);
    for (let x = xa; x < xb; x++) {
      const sa = c.in + ((x - x0) / zoom()) * c.speed, sb = c.in + ((x + 1 - x0) / zoom()) * c.speed;
      let i0 = Math.floor(sa * pk.rate), i1 = Math.max(i0 + 1, Math.floor(sb * pk.rate));
      let mn = 0, mx = 0;
      for (let i = i0; i < i1 && i * 2 < pk.data.length; i++) { if (pk.data[i * 2] < mn) mn = pk.data[i * 2]; if (pk.data[i * 2 + 1] > mx) mx = pk.data[i * 2 + 1]; }
      mn = Math.max(-1, mn * gain); mx = Math.min(1, mx * gain);
      g.fillRect(x, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
    }
  }
  // volume rubber band
  if (c.type === 'audio' && hh > 26) {
    const fx = findFx(c, 'volume');
    if (fx) {
      g.strokeStyle = '#f0d34a'; g.lineWidth = 1; g.beginPath();
      const yOf = db => y + band + (hh - band) * (1 - dbNorm(db));
      const kf = fx.kf.level;
      if (kf?.length) {
        g.moveTo(x0, yOf(evalParam(fx, 'level', 0)));
        for (const k of kf) g.lineTo(x0 + k.t * zoom(), yOf(k.v));
        g.lineTo(x1, yOf(evalParam(fx, 'level', c.dur)));
        g.stroke();
        g.fillStyle = '#f0d34a';
        for (const k of kf) { const kx = x0 + k.t * zoom(), ky = yOf(k.v); g.beginPath(); g.moveTo(kx, ky - 4); g.lineTo(kx + 4, ky); g.lineTo(kx, ky + 4); g.lineTo(kx - 4, ky); g.fill(); }
      } else { const yy = Math.round(yOf(fx.params.level)) + 0.5; g.moveTo(x0, yy); g.lineTo(x1, yy); g.stroke(); }
    }
  }
  // label text
  g.fillStyle = disabled ? '#888' : '#f4f4f4';
  g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';
  const hasFx = c.effects.some(e => !EFFECTS[e.type]?.fixed);
  let tx = Math.max(x0 + (c.transIn ? c.transIn.dur * zoom() : 0), 0) + 4;
  if (hasFx && w > 26) {
    g.fillStyle = '#e8c547'; g.fillRect(tx, y + 3, 14, 10); g.fillStyle = '#222'; g.font = 'bold 8px system-ui'; g.fillText('fx', tx + 2.5, y + 8.5);
    tx += 18; g.font = '11px system-ui, sans-serif'; g.fillStyle = disabled ? '#888' : '#f4f4f4';
  }
  let label = c.name + (c.speed !== 1 ? ` [${Math.round(c.speed * 100)}%]` : '') + (off ? ' (Media Offline)' : '');
  if (c.linkId) label += '';
  g.fillText(label, tx, y + band / 2 + 0.5);
  if (c.linkId && w > 60 && !ui.linked) { /* noop */ }
  // transitions
  for (const edge of ['in', 'out']) {
    const tr = edge === 'in' ? c.transIn : c.transOut; if (!tr) continue;
    const tw = tr.dur * zoom();
    const tx0 = edge === 'in' ? x0 : x1 - tw;
    const tsel = ui.selTrans?.clipId === c.id && ui.selTrans.edge === edge;
    const grd = g.createLinearGradient(tx0, 0, tx0 + tw, 0);
    const a = tsel ? 'rgba(120,170,255,0.95)' : 'rgba(150,150,170,0.85)', b = tsel ? 'rgba(70,110,200,0.95)' : 'rgba(90,90,110,0.85)';
    if (edge === 'in') { grd.addColorStop(0, b); grd.addColorStop(1, a); } else { grd.addColorStop(0, a); grd.addColorStop(1, b); }
    g.fillStyle = grd; g.fillRect(tx0, y, tw, Math.min(hh, Math.max(16, hh * 0.6)));
    g.strokeStyle = tsel ? '#fff' : '#bbb'; g.strokeRect(tx0 + 0.5, y + 0.5, tw - 1, Math.min(hh, Math.max(16, hh * 0.6)) - 1);
    g.beginPath(); g.moveTo(tx0, y + Math.min(hh, Math.max(16, hh * 0.6))); g.lineTo(tx0 + tw, y); g.stroke();
    if (tw > 40) { g.fillStyle = '#fff'; g.font = '10px system-ui'; g.fillText(TRANSITIONS[tr.type]?.name || tr.type, tx0 + 4, y + 9); }
  }
  g.restore();
  // outline
  g.strokeStyle = sel ? '#ffffff' : shade(base, 0.35); g.lineWidth = sel ? 1.5 : 1;
  g.strokeRect(x0 + 0.5, y + 0.5, w - 1, hh - 1);
  if (disabled) { g.strokeStyle = 'rgba(255,255,255,0.08)'; for (let k = Math.max(x0, -hh); k < Math.min(x1, W); k += 8) { g.beginPath(); g.moveTo(k, y + hh); g.lineTo(k + hh, y); g.stroke(); } }
  // media end markers (show when at source boundary)
  if (media && isFinite(mediaMaxDur(media))) {
    g.fillStyle = 'rgba(255,255,255,0.5)';
    if (c.in <= 1e-3) { g.beginPath(); g.moveTo(x0 + 1, y + 1); g.lineTo(x0 + 7, y + 1); g.lineTo(x0 + 1, y + 7); g.fill(); }
    if (c.in + c.dur * c.speed >= media.duration - 0.05) { g.beginPath(); g.moveTo(x1 - 1, y + 1); g.lineTo(x1 - 7, y + 1); g.lineTo(x1 - 1, y + 7); g.fill(); }
  }
}

const dbNorm = db => clamp((db + 60) / 75, 0, 1) ** 1.6; // -60..+15 dB
const normDb = n => clamp(Math.pow(clamp(n, 0, 1), 1 / 1.6) * 75 - 60, -60, 15);

// ---------------- Scroll / zoom ----------------
function contentW() { return (Math.max(seqDuration(s()), xToT(W) * 0) + 60) * zoom(); }
function clampScroll() {
  const q = s();
  const maxX = Math.max(0, Math.max(contentW(), (seqDuration(q) + 10) * zoom()) - W * 0.5);
  q.scrollX = clamp(q.scrollX, 0, maxX);
  q.scrollY = clamp(q.scrollY, 0, Math.max(0, contentH() - H));
}
export function zoomBy(f, anchorX = null) {
  const q = s();
  const ax = anchorX ?? (tToX(q.playhead) >= 0 && tToX(q.playhead) <= W ? tToX(q.playhead) : W / 2);
  const t = xToT(ax);
  q.zoom = clamp(q.zoom * f, minZoom(), q.fps * 80);
  q.scrollX = t * q.zoom - ax;
  dirty = true;
}
function minZoom() { return Math.max(0.5, (W - 40) / Math.max(30, seqDuration(s()) * 3)); }
export function zoomFit() {
  const q = s(); const d = Math.max(5, seqDuration(q));
  q.zoom = clamp((W - 40) / d, minZoom(), q.fps * 80); q.scrollX = 0; dirty = true;
}
function autoScroll(t) {
  if (!ui.playing || drag) return;
  const x = tToX(t);
  if (x > W - 10 || x < 0) { s().scrollX += x - 20; dirty = true; }
}

function setupHBar() {
  hthumb.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation(); hthumb.setPointerCapture(e.pointerId);
    const grip = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'm';
    const q = s(); const x0 = e.clientX; const sx0 = q.scrollX; const z0 = q.zoom; const bw = hbar.clientWidth;
    const total = Math.max(contentW(), W);
    const thumbL = sx0 / total * bw, thumbW = W / total * bw;
    const mv = ev => {
      const dx = ev.clientX - x0;
      if (grip === 'm') q.scrollX = sx0 + dx / bw * total;
      else {
        // adjust visible span
        const tStart = sx0 / z0, tEnd = (sx0 + W) / z0;
        const tTotal = total / z0;
        let l = thumbL + (grip === 'l' ? dx : 0), r = thumbL + thumbW + (grip === 'r' ? dx : 0);
        if (r - l < 12) return;
        const nStart = l / bw * tTotal, nEnd = r / bw * tTotal;
        q.zoom = clamp(W / Math.max(0.01, nEnd - nStart), minZoom(), q.fps * 80);
        q.scrollX = nStart * q.zoom; void tStart; void tEnd;
      }
      dirty = true;
    };
    const up = () => { hthumb.removeEventListener('pointermove', mv); hthumb.removeEventListener('pointerup', up); };
    hthumb.addEventListener('pointermove', mv); hthumb.addEventListener('pointerup', up);
  });
}
function updateHBar() {
  const total = Math.max(contentW(), W + s().scrollX);
  const bw = hbar.clientWidth;
  hthumb.style.left = (s().scrollX / total * bw) + 'px';
  hthumb.style.width = Math.max(24, W / total * bw) + 'px';
}

// ---------------- Ruler interaction ----------------
function setupRuler() {
  rulerCv.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    ui.focus = 'timeline';
    const q = s();
    const x = e.offsetX;
    const mk = q.markers.find(m => Math.abs(tToX(m.t) - x) < 6 && e.offsetY >= 12);
    if (mk && e.detail === 2) { editMarker(mk); return; }
    rulerCv.setPointerCapture(e.pointerId);
    const wasPlaying = ui.playing; if (wasPlaying) pause();
    const scrub = ev => { const r = rulerCv.getBoundingClientRect(); seek(snapTime(xToT(ev.clientX - r.left), new Set(), ev.shiftKey)); };
    scrub(e);
    const up = () => { snapLine = null; dirty = true; rulerCv.removeEventListener('pointermove', scrub); rulerCv.removeEventListener('pointerup', up); };
    rulerCv.addEventListener('pointermove', scrub); rulerCv.addEventListener('pointerup', up);
  });
  rulerCv.addEventListener('contextmenu', e => {
    e.preventDefault();
    const q = s(); const mk = q.markers.find(m => Math.abs(tToX(m.t) - e.offsetX) < 6);
    contextMenu(e.clientX, e.clientY, [
      mk ? { label: 'Edit Marker…', action: () => editMarker(mk) } : null,
      mk ? { label: 'Clear Selected Marker', action: () => commit('Clear Marker', () => q.markers = q.markers.filter(m => m !== mk)) } : null,
      { label: 'Add Marker', key: 'M', action: () => A.addMarker() },
      { label: 'Clear All Markers', action: () => A.clearMarkers() },
      '-',
      { label: 'Mark In', key: 'I', action: () => A.markIn() },
      { label: 'Mark Out', key: 'O', action: () => A.markOut() },
      { label: 'Clear In and Out', action: () => A.clearInOut() },
    ]);
  });
  rulerCv.addEventListener('wheel', onWheel, { passive: false });
}

async function editMarker(mk) {
  const n = await prompt('Marker', 'Name', mk.name || '');
  if (n != null) commit('Edit Marker', () => mk.name = n);
}

// ---------------- Snapping ----------------
function snapCandidates(exclude) {
  const q = s();
  const pts = editPoints(q, exclude);
  pts.push(q.playhead);
  for (const m of q.markers) pts.push(m.t);
  if (q.inPoint != null) pts.push(q.inPoint);
  if (q.outPoint != null) pts.push(q.outPoint);
  return pts;
}
/** Snap a single time; returns snapped time and sets snapLine. */
function snapTime(t, exclude = new Set(), disable = false) {
  snapLine = null;
  t = Math.max(0, t);
  if (!ui.snap || disable) return frameT(t);
  const tol = 8 / zoom();
  let best = null, bd = tol;
  for (const p of snapCandidates(exclude)) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
  if (best != null) { snapLine = best; return best; }
  return frameT(t);
}
/** Snap a delta for a set of edges (times) to candidates. */
function snapDelta(edges, dt, exclude) {
  snapLine = null;
  if (!ui.snap) return frameT(dt);
  const tol = 8 / zoom();
  const cands = snapCandidates(exclude);
  let best = null, bd = tol;
  for (const e of edges) for (const p of cands) { const d = Math.abs(e + dt - p); if (d < bd) { bd = d; best = p - e; snapLine = p; } }
  return best != null ? best : frameT(dt);
}

// ---------------- Hit testing ----------------
function hitTest(x, y) {
  const r = rowAtY(y);
  if (!r) return { row: null };
  const t = xToT(x);
  const q = s();
  const cl = trackClips(r.track.id, q);
  const ry = rowY(r);
  // nearest edge within EDGE_PX; at a cut prefer the clip on the cursor's side
  let edge = null, bd = Infinity;
  for (const c of cl) {
    const xs = tToX(c.start), xe = tToX(clipEnd(c));
    const ds = Math.abs(x - xs) + (x < xs ? 0.5 : 0), de = Math.abs(x - xe) + (x > xe ? 0.5 : 0);
    if (ds <= EDGE_PX && ds < bd) { bd = ds; edge = { clip: c, side: 'in' }; }
    if (de <= EDGE_PX && de < bd) { bd = de; edge = { clip: c, side: 'out' }; }
  }
  const clip = cl.find(c => t >= c.start && t < clipEnd(c));
  let trans = null;
  if (clip) {
    const transH = Math.max(16, (r.h - 3) * 0.6);
    if (y - ry < transH + 1) {
      if (clip.transIn && t < clip.start + clip.transIn.dur) trans = { clip, edge: 'in' };
      else if (clip.transOut && t > clipEnd(clip) - clip.transOut.dur) trans = { clip, edge: 'out' };
    }
  }
  // rubber band
  let band = null;
  if (clip && clip.type === 'audio' && r.h > 26) {
    const fx = findFx(clip, 'volume');
    if (fx && !fx.kf.level?.length) {
      const bandTop = Math.min(16, r.h - 3);
      const yy = ry + 1 + bandTop + (r.h - 3 - bandTop) * (1 - dbNorm(fx.params.level));
      if (Math.abs(y - yy) <= 3) band = { clip, fx, top: ry + 1 + bandTop, h: r.h - 3 - bandTop };
    }
  }
  return { row: r, t, clip, edge, trans, band };
}

// ---------------- Body interaction ----------------
function setupBody() {
  bodyCv.addEventListener('wheel', onWheel, { passive: false });
  bodyCv.addEventListener('pointermove', e => { if (!drag) updateHover(e); });
  bodyCv.addEventListener('pointerleave', () => { hover = null; dirty = true; });
  bodyCv.addEventListener('pointerdown', onDown);
  bodyCv.addEventListener('dblclick', e => {
    const hit = hitTest(e.offsetX, e.offsetY);
    if (hit.clip) bus.emit('open-source', hit.clip.mediaId, hit.clip);
  });
  bodyCv.addEventListener('contextmenu', onContext);
}

function onWheel(e) {
  e.preventDefault();
  const q = s();
  if (e.altKey || e.ctrlKey || e.metaKey) zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.offsetX);
  else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) q.scrollX += (e.deltaX || e.deltaY);
  else q.scrollY += e.deltaY;
  dirty = true;
}

function setCursor(c) { if (bodyCv.style.cursor !== c) bodyCv.style.cursor = c; }

function updateHover(e) {
  const hit = hitTest(e.offsetX, e.offsetY);
  const tool = ui.tool;
  hover = { row: hit.row };
  if (tool === 'razor') {
    hover.razorT = hit.clip ? snapTime(hit.t, new Set(), e.shiftKey && false) : null; hover.allTracks = e.shiftKey; snapLine = null;
    setCursor('crosshair');
  } else if (tool === 'hand') setCursor('grab');
  else if (tool === 'zoom') setCursor(e.altKey ? 'zoom-out' : 'zoom-in');
  else if (tool === 'slip') setCursor(hit.clip ? 'ew-resize' : 'default');
  else if (tool === 'trackFwd') setCursor('e-resize');
  else if (hit.edge && !locked(hit.edge.clip)) {
    const ripple = tool === 'ripple' || e.ctrlKey || e.metaKey;
    setCursor(tool === 'rolling' ? 'col-resize' : ripple ? (hit.edge.side === 'in' ? 'w-resize' : 'e-resize') : 'ew-resize');
  } else if (hit.band) setCursor('ns-resize');
  else setCursor('default');
  dirty = true;
}

const locked = c => trackById(c.trackId)?.locked;

function onDown(e) {
  if (e.button === 1) { startHand(e); return; }
  if (e.button !== 0) return;
  bodyCv.focus({ preventScroll: true });
  ui.focus = 'timeline';
  const hit = hitTest(e.offsetX, e.offsetY);
  const tool = ui.tool;
  const q = s();
  if (tool === 'hand') return startHand(e);
  if (tool === 'zoom') { zoomBy(e.altKey ? 1 / 1.6 : 1.6, e.offsetX); return; }
  if (tool === 'razor') {
    if (hit.clip && !locked(hit.clip)) A.razorAt(hit.clip, snapTime(hit.t), e.shiftKey);
    return;
  }
  if (tool === 'trackFwd') {
    const t = hit.t ?? xToT(e.offsetX);
    ui.sel.clear();
    for (const c of q.clips) if (clipEnd(c) > t + EPS && (!e.shiftKey || c.trackId === hit.row?.track.id) && !locked(c)) ui.sel.add(c.id);
    bus.emit('selection');
    const any = [...ui.sel].map(id => q.clips.find(c => c.id === id))[0];
    if (any) beginMove(e, any, hit);
    return;
  }
  if (hit.trans && !hit.edge) {
    ui.sel.clear(); ui.selTrans = { clipId: hit.trans.clip.id, edge: hit.trans.edge }; bus.emit('selection');
    beginTransDrag(e, hit.trans);
    return;
  }
  if (hit.edge && !locked(hit.edge.clip) && (tool === 'select' || tool === 'ripple' || tool === 'rolling' || tool === 'type')) {
    const c = hit.edge.clip;
    if (!ui.sel.has(c.id)) A.selectClip(c, { linked: ui.linked && !e.altKey });
    const mode = tool === 'rolling' ? 'roll' : (tool === 'ripple' || e.ctrlKey || e.metaKey) ? 'ripple' : 'trim';
    beginTrim(e, hit.edge, mode, e.altKey);
    return;
  }
  if (hit.band && tool === 'select' && !locked(hit.band.clip)) { beginBand(e, hit.band); return; }
  if (hit.clip) {
    const c = hit.clip;
    if (locked(c)) return;
    if (tool === 'slip') { A.selectClip(c, { linked: ui.linked && !e.altKey }); beginSlip(e, c, e.altKey); return; }
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const group = ui.linked && !e.altKey ? linkedOf(c) : [c];
      const on = ui.sel.has(c.id);
      group.forEach(x => on ? ui.sel.delete(x.id) : ui.sel.add(x.id));
      ui.selTrans = null; bus.emit('selection');
      return;
    }
    if (!ui.sel.has(c.id)) A.selectClip(c, { linked: ui.linked && !e.altKey });
    else if (e.altKey) A.selectClip(c, { linked: false });
    beginMove(e, c, hit, e.altKey);
    return;
  }
  // empty: marquee
  if (!e.shiftKey) A.clearSelection();
  drag = { mode: 'marquee', x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY, moved: false, base: new Set(ui.sel) };
  capture(e, ev => {
    const r = bodyCv.getBoundingClientRect();
    drag.x1 = ev.clientX - r.left; drag.y1 = ev.clientY - r.top; drag.moved = true;
    const ta = xToT(Math.min(drag.x0, drag.x1)), tb = xToT(Math.max(drag.x0, drag.x1));
    const ya = Math.min(drag.y0, drag.y1), yb = Math.max(drag.y0, drag.y1);
    ui.sel = new Set(drag.base);
    for (const c of q.clips) {
      const rr = rowOf(c.trackId); if (!rr) continue;
      const cy = rowY(rr);
      if (clipEnd(c) > ta && c.start < tb && cy + rr.h > ya && cy < yb) for (const x of (ui.linked ? linkedOf(c) : [c])) ui.sel.add(x.id);
    }
    bus.emit('selection');
  }, () => { drag = null; dirty = true; });
}

function capture(e, move, up) {
  bodyCv.setPointerCapture(e.pointerId);
  const mv = ev => { move(ev); dirty = true; };
  const u = ev => {
    bodyCv.removeEventListener('pointermove', mv); bodyCv.removeEventListener('pointerup', u); bodyCv.removeEventListener('pointercancel', u);
    snapLine = null; up(ev); dirty = true;
  };
  bodyCv.addEventListener('pointermove', mv); bodyCv.addEventListener('pointerup', u); bodyCv.addEventListener('pointercancel', u);
}

function startHand(e) {
  const q = s(); const x0 = e.clientX, y0 = e.clientY, sx = q.scrollX, sy = q.scrollY;
  setCursor('grabbing');
  capture(e, ev => { q.scrollX = sx - (ev.clientX - x0); q.scrollY = sy - (ev.clientY - y0); }, () => setCursor(ui.tool === 'hand' ? 'grab' : 'default'));
}

// ----- Move -----
function beginMove(e, grabbed, hit, duplicate = false) {
  const q = s();
  const clips = [...ui.sel].map(id => q.clips.find(c => c.id === id)).filter(c => c && !locked(c));
  if (!clips.length) return;
  const orig = new Map(clips.map(c => [c.id, { start: c.start, trackId: c.trackId }]));
  const exclude = new Set(clips.map(c => c.id));
  const edges = clips.flatMap(c => [c.start, clipEnd(c)]);
  const t0 = xToT(e.offsetX);
  const grabbedRow = rowOf(grabbed.trackId);
  const y0 = e.offsetY;
  const minStart = Math.min(...clips.map(c => c.start));
  let moved = false, dIdx = 0, dt = 0;
  const vIdx = c => q.videoTracks.findIndex(t => t.id === orig.get(c.id).trackId);
  const aIdx = c => q.audioTracks.findIndex(t => t.id === orig.get(c.id).trackId);
  capture(e, ev => {
    const r = bodyCv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (!moved && Math.abs(x - e.offsetX) < 3 && Math.abs(y - y0) < 3) return;
    moved = true; drag = { mode: 'move' };
    dt = snapDelta(edges, xToT(x) - t0, exclude);
    dt = Math.max(dt, -minStart);
    // vertical: count rows of grabbed kind
    const rowNow = rowAtY(y);
    let di = 0;
    if (rowNow && rowNow.kind === grabbedRow.kind) di = grabbedRow.kind === 'video' ? rowNow.index - grabbedRow.index : rowNow.index - grabbedRow.index;
    else if (rowNow) di = dIdx;
    // clamp so every clip stays within its kind's tracks
    for (const c of clips) {
      const list = c.type === 'video' ? q.videoTracks : q.audioTracks;
      const i = c.type === 'video' ? vIdx(c) : aIdx(c);
      di = clamp(di, -i, list.length - 1 - i);
    }
    dIdx = di;
    for (const c of clips) {
      const o = orig.get(c.id);
      c.start = o.start + dt;
      const list = c.type === 'video' ? q.videoTracks : q.audioTracks;
      const i = c.type === 'video' ? vIdx(c) : aIdx(c);
      const nt = list[i + dIdx];
      c.trackId = nt && !nt.locked ? nt.id : o.trackId;
    }
    bus.emit('drag-time', dt);
  }, () => {
    drag = null;
    if (!moved) {
      // simple click: select only this clip (if part of multiple selection without shift)
      if (ui.sel.size > 1 && !e.shiftKey && !duplicate) { A.selectClip(grabbed, { linked: ui.linked && !e.altKey }); }
      return;
    }
    const final = new Map(clips.map(c => [c.id, { start: c.start, trackId: c.trackId }]));
    for (const c of clips) Object.assign(c, orig.get(c.id));
    commit(duplicate ? 'Duplicate' : 'Move', () => {
      let targets = clips;
      if (duplicate) {
        const links = new Map();
        targets = clips.map(c => {
          const n = cloneClip(c);
          if (c.linkId) { if (!links.has(c.linkId)) links.set(c.linkId, uid('lnk')); n.linkId = links.get(c.linkId); }
          Object.assign(n, final.get(c.id)); q.clips.push(n); return n;
        });
        ui.sel = new Set(targets.map(c => c.id));
      } else for (const c of clips) Object.assign(c, final.get(c.id));
      const ex = new Set(targets.map(c => c.id));
      for (const c of targets) clearRange(c.trackId, c.start, clipEnd(c), ex, q);
    });
    bus.emit('selection');
  });
}

// ----- Trim -----
function trimGroup(c, alt) {
  return ui.linked && !alt ? linkedOf(c).filter(x => Math.abs(x.start - c.start) < 1e-4 || Math.abs(clipEnd(x) - clipEnd(c)) < 1e-4) : [c];
}

function beginTrim(e, edge, mode, alt) {
  const q = s();
  const c = edge.clip;
  const side = edge.side;
  let group = trimGroup(c, alt).filter(x => side === 'in' ? Math.abs(x.start - c.start) < 1e-4 : Math.abs(clipEnd(x) - clipEnd(c)) < 1e-4);
  let partners = [];
  if (mode === 'roll') {
    // adjacent clips on the other side of the edit point
    const pt = side === 'in' ? c.start : clipEnd(c);
    partners = q.clips.filter(x => group.some(g => g.trackId === x.trackId) && !group.includes(x) && (side === 'in' ? Math.abs(clipEnd(x) - pt) < 1e-4 : Math.abs(x.start - pt) < 1e-4));
  }
  const snap0 = JSON.stringify(q.clips);
  const origs = new Map(q.clips.map(x => [x.id, { start: x.start, dur: x.dur, in: x.in, kf: JSON.stringify(x.effects) }]));
  const restore = () => { for (const x of q.clips) { const o = origs.get(x.id); if (o) { x.start = o.start; x.dur = o.dur; x.in = o.in; x.effects = JSON.parse(o.kf); } } };
  const t0 = xToT(e.offsetX);
  const exclude = new Set([...group, ...partners].map(x => x.id));
  const edgeT = side === 'in' ? c.start : clipEnd(c);
  const origEnd = clipEnd(c);
  const fr = 1 / q.fps;
  let moved = false, last = 0;
  // bounds for delta
  let lo = -Infinity, hi = Infinity;
  for (const g of group) {
    const m = mediaById(g.mediaId); const md = mediaMaxDur(m);
    if (side === 'in') {
      hi = Math.min(hi, g.dur - fr);
      if (isFinite(md)) lo = Math.max(lo, -g.in / g.speed);
      if (mode === 'trim') { const prev = trackClips(g.trackId, q).filter(x => clipEnd(x) <= g.start + EPS && !exclude.has(x.id)).pop(); lo = Math.max(lo, (prev ? clipEnd(prev) : 0) - g.start); }
      if (mode === 'roll') lo = Math.max(lo, -g.start);
    } else {
      lo = Math.max(lo, -(g.dur - fr));
      if (isFinite(md)) hi = Math.min(hi, (md - g.in) / g.speed - g.dur);
      if (mode === 'trim') { const next = trackClips(g.trackId, q).find(x => x.start >= clipEnd(g) - EPS && !exclude.has(x.id)); if (next) hi = Math.min(hi, next.start - clipEnd(g)); }
    }
  }
  for (const p of partners) {
    const m = mediaById(p.mediaId); const md = mediaMaxDur(m);
    if (side === 'in') { // partner's out moves
      lo = Math.max(lo, -(p.dur - fr));
      if (isFinite(md)) hi = Math.min(hi, (md - p.in) / p.speed - p.dur);
    } else { // partner's in moves
      hi = Math.min(hi, p.dur - fr);
      if (isFinite(md)) lo = Math.max(lo, -p.in / p.speed);
    }
  }
  const apply = d => {
    restore();
    for (const g of group) {
      if (side === 'in') {
        if (mode === 'ripple') { // keep start, change content; ripple later
          g.in += d * g.speed; g.dur -= d; shiftKeyframes(g, -d);
        } else trimHead(g, g.start + d);
      } else g.dur += d;
    }
    for (const p of partners) {
      if (side === 'in') p.dur += d; else trimHead(p, p.start + d);
    }
    if (mode === 'ripple') {
      const from = side === 'in' ? origEnd : edgeT;
      const shift = side === 'in' ? -d : d;
      for (const x of q.clips) if (!exclude.has(x.id) && x.start >= from - EPS && !locked(x)) x.start += shift;
    }
  };
  capture(e, ev => {
    const r = bodyCv.getBoundingClientRect();
    let d = xToT(ev.clientX - r.left) - t0;
    moved = true; drag = { mode: 'trim' };
    d = snapDelta([edgeT], d, exclude);
    d = clamp(d, lo, hi);
    last = d;
    apply(d);
    if (!ui.playing) seek(side === 'in' ? edgeT + (mode === 'ripple' ? 0 : d) : edgeT + d - (side === 'out' ? fr : 0));
  }, () => {
    drag = null;
    restore();
    void snap0;
    if (!moved || Math.abs(last) < 1e-6) return;
    commit(mode === 'roll' ? 'Rolling Edit' : mode === 'ripple' ? 'Ripple Trim' : 'Trim', () => apply(last));
  });
}

// ----- Transition duration drag -----
function beginTransDrag(e, tr) {
  const c = tr.clip; const t0 = xToT(e.offsetX);
  const T = tr.edge === 'in' ? c.transIn : c.transOut;
  const d0 = T.dur; let moved = false, nd = d0;
  capture(e, ev => {
    const r = bodyCv.getBoundingClientRect();
    const dt = xToT(ev.clientX - r.left) - t0;
    moved = Math.abs(dt) * zoom() > 3;
    if (!moved) return;
    nd = clamp(frameT(d0 + (tr.edge === 'in' ? dt : -dt)), 1 / s().fps, c.dur);
    T.dur = nd;
  }, () => {
    T.dur = d0;
    if (moved && nd !== d0) commit('Transition Duration', () => { (tr.edge === 'in' ? c.transIn : c.transOut).dur = nd; });
  });
}

// ----- Slip -----
function beginSlip(e, c, alt) {
  const group = ui.linked && !alt ? linkedOf(c) : [c];
  const orig = new Map(group.map(g => [g.id, g.in]));
  const t0 = xToT(e.offsetX);
  let last = 0, moved = false;
  // d range: in + d*speed >= 0 and in + (d + dur)*speed <= media duration
  const bounds = group.map(g => { const md = mediaMaxDur(mediaById(g.mediaId)); return [-g.in / g.speed, isFinite(md) ? (md - g.in) / g.speed - g.dur : Infinity]; });
  capture(e, ev => {
    const r = bodyCv.getBoundingClientRect();
    let d = (t0 - xToT(ev.clientX - r.left)); moved = true;
    d = frameT(d);
    for (const [lo, hi] of bounds) d = clamp(d, lo, hi);
    last = d;
    group.forEach(g => g.in = orig.get(g.id) + d * g.speed);
    bus.emit('time', s().playhead);
  }, () => {
    group.forEach(g => g.in = orig.get(g.id));
    if (moved && last) commit('Slip', () => group.forEach(g => g.in = orig.get(g.id) + last * g.speed));
  });
}

// ----- Volume rubber band -----
function beginBand(e, band) {
  const fx = band.fx; const v0 = fx.params.level; let v = v0;
  capture(e, ev => {
    const r = bodyCv.getBoundingClientRect();
    const y = ev.clientY - r.top;
    v = Math.round(normDb(1 - (y - band.top) / band.h) * 10) / 10;
    fx.params.level = v;
    hover = { bandDb: v };
    bus.emit('selection');
  }, () => {
    fx.params.level = v0;
    if (v !== v0) commit('Volume Level', () => fx.params.level = v);
    toast(`Volume: ${v.toFixed(1)} dB`, 900);
  });
}

// ----- Context menu -----
function onContext(e) {
  e.preventDefault();
  const hit = hitTest(e.offsetX, e.offsetY);
  if (hit.trans) {
    ui.selTrans = { clipId: hit.trans.clip.id, edge: hit.trans.edge }; ui.sel.clear(); bus.emit('selection');
    contextMenu(e.clientX, e.clientY, [{ label: 'Clear', action: () => A.deleteSelection() }, { label: 'Set Transition Duration…', action: () => transDurDialog(hit.trans) }]);
    return;
  }
  if (hit.clip) {
    if (!ui.sel.has(hit.clip.id)) A.selectClip(hit.clip, { linked: ui.linked && !e.altKey });
    const c = hit.clip;
    const labels = Object.entries(A.LABEL_COLORS).map(([n, col]) => ({ label: n, action: () => A.setLabel(col), checked: c.label === col }));
    contextMenu(e.clientX, e.clientY, [
      { label: 'Cut', key: 'Ctrl+X', action: () => A.copySelection(true) },
      { label: 'Copy', key: 'Ctrl+C', action: () => A.copySelection() },
      { label: 'Paste', key: 'Ctrl+V', action: () => A.paste(), disabled: !ui.clipboard },
      { label: 'Clear', key: 'Del', action: () => A.deleteSelection() },
      { label: 'Ripple Delete', key: 'Shift+Del', action: () => A.deleteSelection(true) },
      '-',
      { label: 'Enable', checked: c.enabled !== false, action: () => A.toggleEnable() },
      { label: c.linkId ? 'Unlink' : 'Link', action: () => A.toggleLink() },
      '-',
      { label: 'Speed/Duration…', key: 'Ctrl+R', action: () => A.speedDialog() },
      { label: 'Add Edit at Playhead', key: 'Ctrl+K', action: () => A.addEdit() },
      { label: 'Apply Default Transitions', key: 'Ctrl+D', action: () => { A.applyTransition(c.type === 'audio' ? 'constantPower' : 'crossDissolve', { clip: c, edge: hit.t - c.start < c.dur / 2 ? 'in' : 'out' }); } },
      c.type === 'video' ? { label: 'Set to Frame Size', checked: c.fit, action: () => A.scaleToFrame() } : null,
      '-',
      { label: 'Rename…', action: () => A.renameClip() },
      { label: 'Label', sub: labels },
      { label: 'Reveal in Project', action: () => bus.emit('reveal-media', c.mediaId) },
      { label: 'Open in Source Monitor', action: () => bus.emit('open-source', c.mediaId, c) },
    ]);
    return;
  }
  if (hit.row) {
    const g = (() => { const cl = trackClips(hit.row.track.id); const t = hit.t; let a = 0, b = null; for (const c of cl) { if (clipEnd(c) <= t) a = Math.max(a, clipEnd(c)); if (c.start > t && b == null) b = c.start; } return b != null ? [a, b] : null; })();
    contextMenu(e.clientX, e.clientY, [
      { label: 'Ripple Delete', disabled: !g, action: () => A.rippleDeleteGap(hit.row.track.id, hit.t) },
      { label: 'Paste', disabled: !ui.clipboard, action: () => A.paste() },
      '-',
      { label: 'Add Video Track', action: () => A.addTracks('video') },
      { label: 'Add Audio Track', action: () => A.addTracks('audio') },
    ]);
  }
}

async function transDurDialog(tr) {
  const c = tr.clip; const T = tr.edge === 'in' ? c.transIn : c.transOut;
  const v = await prompt('Set Transition Duration', 'Duration (timecode or seconds e.g. 1.5s)', timecode(T.dur, s().fps));
  if (v == null) return;
  const d = clamp(parseTimecode(v, s().fps), 1 / s().fps, c.dur);
  commit('Transition Duration', () => { (tr.edge === 'in' ? c.transIn : c.transOut).dur = d; });
}

// ---------------- Drag & drop from panels/OS ----------------
let dragPayload = null;
export function setDragPayload(p) { dragPayload = p; }

function setupDrop() {
  bodyCv.addEventListener('dragover', e => {
    e.preventDefault();
    const p = dragPayload;
    const x = e.offsetX, y = e.offsetY;
    const hit = hitTest(x, y);
    if (p?.kind === 'media') {
      const m = mediaById(p.mediaId); if (!m) return;
      const dur = (p.srcOut ?? (isFinite(mediaMaxDur(m)) ? m.duration : 5)) - (p.srcIn || 0);
      const t = snapTime(xToT(x - 0));
      const tr = dropTracks(hit.row, m, p);
      dropGhost = { t, dur, rows: [tr.v, tr.a].filter(Boolean).map(id => rowOf(id)).filter(Boolean) };
      e.dataTransfer.dropEffect = 'copy';
    } else if (p?.kind === 'effect' || p?.kind === 'transition') {
      dropGhost = null;
      hover = { row: hit.row };
      e.dataTransfer.dropEffect = hit.clip ? 'copy' : 'none';
    } else e.dataTransfer.dropEffect = 'copy';
    dirty = true;
  });
  bodyCv.addEventListener('dragleave', () => { dropGhost = null; snapLine = null; dirty = true; });
  bodyCv.addEventListener('drop', async e => {
    e.preventDefault();
    const p = dragPayload; dragPayload = null;
    dropGhost = null; snapLine = null; dirty = true;
    const hit = hitTest(e.offsetX, e.offsetY);
    const t = snapTime(xToT(e.offsetX)); snapLine = null;
    if (e.dataTransfer.files?.length && !p) {
      const added = await importFiles([...e.dataTransfer.files], msg => toast(msg));
      let tt = t;
      for (const m of added) { const created = dropMedia(m, hit.row, tt, {}, e.ctrlKey || e.metaKey); tt = Math.max(tt, ...created.map(clipEnd)); }
      return;
    }
    if (!p) return;
    if (p.kind === 'media') {
      const m = mediaById(p.mediaId); if (!m) return;
      dropMedia(m, hit.row, t, p, e.ctrlKey || e.metaKey);
    } else if (p.kind === 'effect') {
      if (hit.clip) A.applyEffect(p.type, ui.sel.has(hit.clip.id) ? A.selClips() : [hit.clip]);
    } else if (p.kind === 'transition') {
      if (hit.clip) A.applyTransition(p.type, { clip: hit.clip, edge: hit.t - hit.clip.start < hit.clip.dur / 2 ? 'in' : 'out' });
    }
  });
}

function dropTracks(row, m, p) {
  const q = s();
  let vi = 0, ai = 0;
  if (row) { if (row.kind === 'video') { vi = row.index; ai = Math.min(row.index, q.audioTracks.length - 1); } else { ai = row.index; vi = Math.min(row.index, q.videoTracks.length - 1); } }
  const wantV = m.type !== 'audio' && p.video !== false;
  const wantA = (m.type === 'audio' || m.hasAudio) && p.audio !== false;
  return { v: wantV ? q.videoTracks[vi].id : null, a: wantA ? q.audioTracks[ai].id : null };
}

function dropMedia(m, row, t, p, insert) {
  const q = s();
  const tr = dropTracks(row, m, p);
  if ((tr.v && trackById(tr.v)?.locked) || (tr.a && trackById(tr.a)?.locked)) { toast('Track is locked'); return []; }
  const created = commit(insert ? 'Insert' : 'Overwrite', () => placeMedia(m, t, {
    vTrack: tr.v, aTrack: tr.a, srcIn: p.srcIn || 0, srcOut: p.srcOut ?? null, mode: insert ? 'insert' : 'overwrite',
    video: !!tr.v, audio: !!tr.a,
  }, q)) || [];
  ui.sel = new Set(created.map(c => c.id)); bus.emit('selection');
  if (q.clips.length === created.length && created.length) { const md = m; if ((md.width && md.height) && (md.width !== q.width || md.height !== q.height) && md.type === 'video') toast('Tip: use Sequence ▸ Sequence Settings to match the clip resolution', 4000); }
  return created;
}

export function timelineFocus() { bodyCv.focus({ preventScroll: true }); }
