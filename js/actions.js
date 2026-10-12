// Editing commands shared by menus, keyboard shortcuts and context menus.
import {
  project, seq, ui, bus, commit, clipById, clipEnd, linkedOf, removeClips, rippleDelete, splitWithLinks,
  activeClipsAt, allTracks, trackById, cloneClip, clearRange, mediaById, mediaMaxDur, addTrack, deleteTrack,
  editPoints, seqDuration, frame, placeMedia, trackKind, trackClips, gapAt, rippleShift, newSequence, snapFrame,
} from './store.js';
import { seek, pause } from './engine.js';
import { TRANSITIONS, makeEffect, EFFECTS } from './effects.js';
import { uid, EPS, clamp, LABEL_COLORS } from './util.js';
import { prompt, toast, dialog } from './ui.js';

export const selClips = () => [...ui.sel].map(id => clipById(id)).filter(Boolean);

export function selectClip(c, { add = false, linked = ui.linked } = {}) {
  if (!add) ui.sel.clear();
  for (const x of linked ? linkedOf(c) : [c]) ui.sel.add(x.id);
  ui.selTrans = null;
  bus.emit('selection');
}
export function clearSelection() { ui.sel.clear(); ui.selTrans = null; bus.emit('selection'); }
export function selectAll() { ui.sel = new Set(seq().clips.map(c => c.id)); bus.emit('selection'); }

export function deleteSelection(ripple = false) {
  if (ui.selTrans) {
    const { clipId, edge } = ui.selTrans;
    commit('Delete Transition', () => { const c = clipById(clipId); if (c) c[edge === 'in' ? 'transIn' : 'transOut'] = null; });
    ui.selTrans = null; bus.emit('selection'); return;
  }
  const ids = [...ui.sel].filter(id => { const c = clipById(id); return c && !trackById(c.trackId)?.locked; });
  if (!ids.length) return;
  commit(ripple ? 'Ripple Delete' : 'Clear', () => { ripple ? rippleDelete(ids) : removeClips(ids); });
  bus.emit('selection');
}

export function rippleDeleteGap(trackId, t) {
  const g = gapAt(trackId, t); if (!g) return;
  const [a, b] = g;
  commit('Ripple Delete Gap', () => rippleShift(b, -(b - a), null));
}

/** Add Edit (Ctrl+K): split clips at playhead on targeted tracks (or all with all=true; or selected if any). */
export function addEdit(all = false) {
  const s = seq(), t = s.playhead;
  commit('Add Edit', () => {
    const sel = selClips();
    const targets = all ? s.clips : sel.length ? sel : s.clips.filter(c => trackById(c.trackId)?.target);
    for (const c of [...targets]) {
      if (trackById(c.trackId)?.locked) continue;
      if (c.start < t - EPS && clipEnd(c) > t + EPS) splitWithLinks(c, t, s, all ? false : ui.linked && !sel.length ? false : ui.linked);
    }
  });
}

export function razorAt(c, t, allTracks = false) {
  const s = seq();
  commit('Razor', () => {
    if (allTracks) { for (const x of [...s.clips]) if (!trackById(x.trackId)?.locked && x.start < t - EPS && clipEnd(x) > t + EPS) splitWithLinks(x, t, s, false); }
    else splitWithLinks(c, t, s, ui.linked);
  });
}

export function copySelection(cut = false) {
  const cl = selClips(); if (!cl.length) return;
  const t0 = Math.min(...cl.map(c => c.start));
  ui.clipboard = { t0, clips: JSON.parse(JSON.stringify(cl)) };
  if (cut) deleteSelection(false);
  toast(`${cut ? 'Cut' : 'Copied'} ${cl.length} clip${cl.length > 1 ? 's' : ''}`);
}

export function paste(insert = false) {
  const cb = ui.clipboard; if (!cb) return;
  const s = seq(), t = s.playhead;
  const dur = Math.max(...cb.clips.map(c => c.start + c.dur)) - cb.t0;
  commit(insert ? 'Paste Insert' : 'Paste', () => {
    if (insert) {
      for (const x of [...s.clips]) if (x.start < t - EPS && clipEnd(x) > t + EPS) splitWithLinks(x, t, s, false);
      rippleShift(t, dur, null, s);
    }
    const links = new Map();
    ui.sel.clear();
    for (const src of cb.clips) {
      const tr = trackById(src.trackId) ? src.trackId : (src.type === 'audio' ? s.audioTracks[0].id : s.videoTracks[0].id);
      const c = cloneClip(src, { start: t + (src.start - cb.t0), trackId: tr });
      if (src.linkId) { if (!links.has(src.linkId)) links.set(src.linkId, uid('lnk')); c.linkId = links.get(src.linkId); }
      clearRange(c.trackId, c.start, clipEnd(c), new Set(), s);
      s.clips.push(c); ui.sel.add(c.id);
    }
  });
  seek(t + dur);
  bus.emit('selection');
}

export function duplicateSelection() { copySelection(); const s = seq(); const cl = selClips(); if (!cl.length) return; const end = Math.max(...cl.map(clipEnd)); const ph = s.playhead; s.playhead = end; paste(false); s.playhead = ph; }

export function toggleLink() {
  const cl = selClips(); if (!cl.length) return;
  const linked = cl.some(c => c.linkId);
  commit(linked ? 'Unlink' : 'Link', () => {
    if (linked) cl.forEach(c => c.linkId = null);
    else { const id = uid('lnk'); cl.forEach(c => c.linkId = id); }
  });
}

export function toggleEnable() {
  const cl = selClips(); if (!cl.length) return;
  const en = !cl.every(c => c.enabled !== false);
  commit(en ? 'Enable' : 'Disable', () => cl.forEach(c => c.enabled = en));
}

export function setLabel(color) { const cl = selClips(); commit('Label', () => cl.forEach(c => c.label = color)); }

export async function renameClip() {
  const cl = selClips(); if (cl.length !== 1) return;
  const n = await prompt('Rename Clip', 'Clip Name', cl[0].name); if (n == null) return;
  commit('Rename Clip', () => cl[0].name = n);
}

export async function speedDialog() {
  const cl = selClips().filter(c => mediaById(c.mediaId)); if (!cl.length) return toast('Select a clip first');
  const c0 = cl[0];
  const r = await dialog('Clip Speed / Duration', [
    { k: 'speed', label: 'Speed (%)', type: 'number', value: Math.round(c0.speed * 1000) / 10, min: 1, max: 10000, step: 1 },
    { k: 'ripple', label: 'Ripple Edit, Shifting Trailing Clips', type: 'checkbox', value: true },
  ]);
  if (!r) return;
  const sp = clamp(r.speed / 100, 0.01, 100);
  const s = seq();
  commit('Speed/Duration', () => {
    for (const c of cl) {
      const oldEnd = clipEnd(c);
      const srcDur = c.dur * c.speed;
      c.speed = sp;
      c.dur = snapFrame(srcDur / sp);
      const m = mediaById(c.mediaId);
      if (isFinite(mediaMaxDur(m))) c.dur = Math.min(c.dur, (m.duration - c.in) / sp);
      const delta = clipEnd(c) - oldEnd;
      if (r.ripple) rippleShift(oldEnd, delta, [c.trackId], s, new Set(cl.map(x => x.id)));
      else { // don't overlap the next clip
        const next = trackClips(c.trackId, s).find(x => x.id !== c.id && x.start >= oldEnd - EPS);
        if (next && clipEnd(c) > next.start) c.dur = next.start - c.start;
      }
    }
  });
}

export function scaleToFrame() {
  const cl = selClips().filter(c => c.type === 'video');
  commit('Scale to Frame Size', () => cl.forEach(c => c.fit = !c.fit));
}

/** Apply transition to selected clips' edges or at playhead edit point. */
export function applyTransition(type, target = null) {
  const def = TRANSITIONS[type]; if (!def) return;
  const s = seq();
  const d = Math.min(1, 30 / s.fps); // default 1s-ish
  commit(`Apply ${def.name}`, () => {
    const apply = (c, edge) => {
      if (!c || (def.kind === 'audio') !== (c.type === 'audio')) return;
      const max = c.dur;
      c[edge === 'in' ? 'transIn' : 'transOut'] = { type, dur: Math.min(d, max) };
    };
    if (target) return apply(target.clip, target.edge);
    const t = s.playhead;
    const kind = def.kind;
    let applied = false;
    const sel = selClips().filter(c => (kind === 'audio') === (c.type === 'audio'));
    if (sel.length) {
      for (const c of sel) { const edge = Math.abs(t - c.start) <= Math.abs(t - clipEnd(c)) ? 'in' : 'out'; apply(c, edge); }
      return;
    }
    for (const tr of (kind === 'video' ? s.videoTracks : s.audioTracks)) {
      if (!tr.target) continue;
      const cl = trackClips(tr.id, s);
      const b = cl.find(c => Math.abs(c.start - t) < frame(s) / 2);
      const a = cl.find(c => Math.abs(clipEnd(c) - t) < frame(s) / 2);
      if (b) { apply(b, 'in'); applied = true; }
      else if (a) { apply(a, 'out'); applied = true; }
    }
    if (!applied) toast('Place the playhead on an edit point or select a clip');
  });
}

export function applyEffect(type, clips = selClips()) {
  const def = EFFECTS[type];
  const target = clips.filter(c => (def.kind === 'audio') === (c.type === 'audio'));
  if (!target.length) return toast(`Select a ${def.kind} clip to apply ${def.name}`);
  commit(`Apply ${def.name}`, () => target.forEach(c => c.effects.push(makeEffect(type))));
  bus.emit('selection');
}

// ---------- Navigation / marks ----------
export function gotoEdit(dir) {
  const s = seq(); const t = s.playhead;
  const pts = editPoints(s);
  const next = dir > 0 ? pts.find(p => p > t + EPS) : [...pts].reverse().find(p => p < t - EPS);
  if (next != null) seek(next);
}
export function step(frames) { pause(); const s = seq(); seek(s.playhead + frames / s.fps); }
export function markIn() { const s = seq(); s.inPoint = s.playhead; if (s.outPoint != null && s.outPoint <= s.inPoint) s.outPoint = null; bus.emit('marks'); }
export function markOut() { const s = seq(); s.outPoint = s.playhead + 1 / s.fps; if (s.inPoint != null && s.inPoint >= s.outPoint) s.inPoint = null; bus.emit('marks'); }
export function clearInOut() { const s = seq(); s.inPoint = s.outPoint = null; bus.emit('marks'); }
export function markClip() {
  const s = seq(); const cl = selClips();
  const list = cl.length ? cl : activeClipsAt(s.playhead).filter(c => c.type === 'video');
  if (!list.length) return;
  s.inPoint = Math.min(...list.map(c => c.start)); s.outPoint = Math.max(...list.map(clipEnd)); bus.emit('marks');
}
export function addMarker() {
  const s = seq();
  commit('Add Marker', () => s.markers.push({ id: uid('mk'), t: s.playhead, name: '', color: '#3ec85a' }));
}
export function gotoMarker(dir) {
  const s = seq(); const ts = s.markers.map(m => m.t).sort((a, b) => a - b);
  const n = dir > 0 ? ts.find(x => x > s.playhead + EPS) : ts.reverse().find(x => x < s.playhead - EPS);
  if (n != null) seek(n);
}
export function clearMarkers() { commit('Clear Markers', () => seq().markers = []); }

export function liftExtract(extract) {
  const s = seq();
  if (s.inPoint == null || s.outPoint == null) return toast('Set In and Out points first');
  const a = s.inPoint, b = s.outPoint;
  commit(extract ? 'Extract' : 'Lift', () => {
    for (const tr of allTracks(s)) if (!tr.locked && tr.target !== undefined) clearRange(tr.id, a, b, new Set(), s);
    if (extract) rippleShift(b, -(b - a), null, s);
  });
  if (extract) { s.outPoint = null; }
}

export function trimToPlayhead(which) { // Q / W ripple trim previous/next edit to playhead
  const s = seq(); const t = s.playhead;
  const cl = s.clips.filter(c => trackById(c.trackId)?.target && c.start < t - EPS && clipEnd(c) > t + EPS);
  if (!cl.length) return;
  commit(which === 'start' ? 'Ripple Trim Previous Edit' : 'Ripple Trim Next Edit', () => {
    if (which === 'start') {
      const d = t - Math.min(...cl.map(c => c.start));
      for (const c of cl) { const right = splitWithLinks(c, t, s, false); removeClips([c.id], s); }
      rippleShift(t, -d, null, s);
      seek(t - d);
    } else {
      const end = Math.max(...cl.map(clipEnd));
      for (const c of cl) { const right = splitWithLinks(c, t, s, false); removeClips(right.map(r => r.id), s); }
      rippleShift(end, -(end - t), null, s);
    }
  });
}

export function addTracks(kind) { commit(`Add ${kind} Track`, () => addTrack(kind)); }
export function removeTrack(id) { commit('Delete Track', () => { if (!deleteTrack(id)) toast('A sequence needs at least one track of each kind'); }); }

export function nudge(frames) {
  const cl = selClips(); if (!cl.length) return;
  const s = seq(); const d = frames / s.fps;
  if (Math.min(...cl.map(c => c.start)) + d < 0) return;
  commit('Nudge', () => {
    const ids = new Set(cl.map(c => c.id));
    for (const c of cl) c.start += d;
    for (const c of cl) clearRange(c.trackId, c.start, clipEnd(c), ids, s);
  });
}

export async function newSequenceDialog() {
  const r = await dialog('New Sequence', [
    { k: 'name', label: 'Sequence Name', type: 'text', value: `Sequence ${String(project.sequences.length + 1).padStart(2, '0')}` },
    ...sequenceFields(1920, 1080, 30),
  ]);
  if (!r) return;
  const [w, h] = r.preset === 'custom' ? [r.width, r.height] : r.preset.split('x').map(Number);
  commit('New Sequence', () => {
    const s = newSequence(r.name, w, h, parseFloat(r.fps));
    project.sequences.push(s); project.activeSeqId = s.id;
  });
  bus.emit('project');
}

export function sequenceFields(w, h, fps) {
  const presets = [['1920x1080', 'HD 1080p (1920×1080)'], ['3840x2160', 'UHD 4K (3840×2160)'], ['1280x720', 'HD 720p (1280×720)'], ['1080x1920', 'Vertical 9:16 (1080×1920)'], ['1080x1080', 'Square 1:1 (1080×1080)'], ['1080x1350', 'Portrait 4:5 (1080×1350)'], ['2560x1080', 'Ultrawide (2560×1080)'], ['custom', 'Custom…']];
  const cur = `${w}x${h}`;
  return [
    { k: 'preset', label: 'Frame Size', type: 'select', value: presets.some(p => p[0] === cur) ? cur : 'custom', options: presets },
    { k: 'width', label: 'Custom Width', type: 'number', value: w, min: 16, max: 8192, step: 2 },
    { k: 'height', label: 'Custom Height', type: 'number', value: h, min: 16, max: 8192, step: 2 },
    { k: 'fps', label: 'Timebase (fps)', type: 'select', value: String(fps), options: ['23.976', '24', '25', '29.97', '30', '50', '59.94', '60'].map(v => [v, v + ' fps']) },
  ];
}

export async function sequenceSettings() {
  const s = seq();
  const r = await dialog('Sequence Settings', [
    { k: 'name', label: 'Sequence Name', type: 'text', value: s.name },
    ...sequenceFields(s.width, s.height, s.fps),
    { k: 'bg', label: 'Background', type: 'color', value: s.bg || '#000000' },
  ]);
  if (!r) return;
  const [w, h] = r.preset === 'custom' ? [r.width, r.height] : r.preset.split('x').map(Number);
  commit('Sequence Settings', () => { Object.assign(s, { name: r.name, width: w, height: h, fps: parseFloat(r.fps), bg: r.bg }); });
  bus.emit('project');
}

export { LABEL_COLORS, placeMedia, trackKind, seqDuration };
