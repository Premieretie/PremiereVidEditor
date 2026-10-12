// Project model, undo/redo history and timeline editing operations.
import { uid, Emitter, deepClone, EPS, LABEL_COLORS } from './util.js';
import { defaultEffectsFor, cloneEffects } from './effects.js';

export const bus = new Emitter();

export const ui = {
  tool: 'select',          // select | trackFwd | ripple | rolling | razor | slip | hand | zoom | type
  snap: true,
  linked: true,
  sel: new Set(),          // selected clip ids
  selTrans: null,          // {clipId, edge:'in'|'out'}
  selMedia: new Set(),
  focus: 'timeline',       // panel focus for shortcuts: timeline | program | source | project | ...
  playing: false,
  previewScale: 1,
  safeMargins: false,
  clipboard: null,
};

export function newSequence(name = 'Sequence 01', w = 1920, h = 1080, fps = 30) {
  const vt = n => ({ id: uid('vt'), name: 'V' + n, hidden: false, locked: false, height: 54, target: n === 1 });
  const at = n => ({ id: uid('at'), name: 'A' + n, muted: false, solo: false, locked: false, height: 54, target: n === 1, volume: 0, pan: 0 });
  return {
    id: uid('seq'), name, width: w, height: h, fps, bg: '#000000',
    videoTracks: [vt(1), vt(2), vt(3)], audioTracks: [at(1), at(2), at(3)],
    clips: [], markers: [], inPoint: null, outPoint: null, playhead: 0, zoom: 60, scrollX: 0, scrollY: 0,
    masterVolume: 0,
  };
}

export function newProject() {
  const seq = newSequence();
  return { version: 1, name: 'Untitled Project', media: [], sequences: [seq], activeSeqId: seq.id };
}

export let project = newProject();
export function setProject(p) {
  project = p;
  ui.sel.clear(); ui.selTrans = null; ui.selMedia.clear();
  history.undo = []; history.redo = [];
  bus.emit('project'); bus.emit('change', 'load');
}

export const seq = () => project.sequences.find(s => s.id === project.activeSeqId) || project.sequences[0];
export const mediaById = id => project.media.find(m => m.id === id);
export const clipById = (id, s = seq()) => s.clips.find(c => c.id === id);
export const allTracks = (s = seq()) => [...s.videoTracks, ...s.audioTracks];
export const trackById = (id, s = seq()) => allTracks(s).find(t => t.id === id);
export const trackKind = (id, s = seq()) => s.videoTracks.some(t => t.id === id) ? 'video' : 'audio';
export const trackIndex = (id, s = seq()) => { const k = trackKind(id, s); return (k === 'video' ? s.videoTracks : s.audioTracks).findIndex(t => t.id === id); };
export const clipEnd = c => c.start + c.dur;
export const frame = (s = seq()) => 1 / s.fps;
export const snapFrame = (t, s = seq()) => Math.round(t * s.fps) / s.fps;

export function seqDuration(s = seq()) {
  let d = 0; for (const c of s.clips) d = Math.max(d, clipEnd(c)); return d;
}

export function mediaMaxDur(media) {
  if (!media) return Infinity;
  return (media.type === 'video' || media.type === 'audio') ? media.duration : Infinity;
}

// ---------------- History ----------------
export const history = { undo: [], redo: [], max: 150 };

function snapshot() { return JSON.stringify({ media: project.media, sequences: project.sequences, activeSeqId: project.activeSeqId, name: project.name }); }
function restore(snap) {
  const keep = new Map(project.sequences.map(s => [s.id, { playhead: s.playhead, zoom: s.zoom, scrollX: s.scrollX, scrollY: s.scrollY }]));
  const o = JSON.parse(snap);
  project.media = o.media; project.sequences = o.sequences; project.activeSeqId = o.activeSeqId; project.name = o.name;
  for (const s of project.sequences) Object.assign(s, keep.get(s.id) || {});
  for (const id of [...ui.sel]) if (!clipById(id)) ui.sel.delete(id);
  if (ui.selTrans && !clipById(ui.selTrans.clipId)) ui.selTrans = null;
}

/** Run a mutation as one undoable step. */
export function commit(label, fn) {
  const before = snapshot();
  let r;
  try { r = fn(); } catch (e) { restore(before); throw e; }
  if (snapshot() === before) return r;
  history.undo.push({ label, snap: before, time: Date.now() });
  if (history.undo.length > history.max) history.undo.shift();
  history.redo = [];
  bus.emit('change', label);
  return r;
}
export function undo() {
  const e = history.undo.pop(); if (!e) return;
  history.redo.push({ label: e.label, snap: snapshot() });
  restore(e.snap); bus.emit('project'); bus.emit('change', 'undo');
}
export function redo() {
  const e = history.redo.pop(); if (!e) return;
  history.undo.push({ label: e.label, snap: snapshot() });
  restore(e.snap); bus.emit('project'); bus.emit('change', 'redo');
}
export function revertTo(index) { // undo until history.undo.length === index
  while (history.undo.length > index) undo();
}

// ---------------- Clip helpers ----------------
export function shiftKeyframes(clip, delta) {
  for (const fx of clip.effects) for (const k in fx.kf) fx.kf[k] = fx.kf[k].map(f => ({ ...f, t: f.t + delta }));
}

export function makeClip(media, type, trackId, start, opts = {}) {
  const dur = opts.dur ?? (media.type === 'video' || media.type === 'audio' ? media.duration : 5);
  return {
    id: uid('clip'), mediaId: media.id, type, trackId, start, dur, in: opts.in ?? 0, speed: 1,
    linkId: opts.linkId ?? null, name: media.name, label: type === 'audio' ? LABEL_COLORS.Caribbean : (media.type === 'title' ? LABEL_COLORS.Rose : media.type === 'adjustment' ? LABEL_COLORS.Lavender : media.type === 'color' ? LABEL_COLORS.Mango : LABEL_COLORS.Violet),
    enabled: true, fit: true, effects: defaultEffectsFor(type, media.type, media), transIn: null, transOut: null,
  };
}

export function cloneClip(c, overrides = {}) {
  return { ...deepClone(c), effects: cloneEffects(c.effects), id: uid('clip'), ...overrides };
}

export function linkedOf(clip, s = seq()) {
  if (!clip.linkId) return [clip];
  return s.clips.filter(c => c.linkId === clip.linkId);
}

export function trackClips(trackId, s = seq()) {
  return s.clips.filter(c => c.trackId === trackId).sort((a, b) => a.start - b.start);
}

export function removeClips(ids, s = seq()) {
  const set = new Set(ids);
  s.clips = s.clips.filter(c => !set.has(c.id));
  for (const id of ids) ui.sel.delete(id);
}

/** Trim clip's head so it starts at newStart (keeps content in place). */
export function trimHead(c, newStart) {
  const d = newStart - c.start;
  c.in += d * c.speed; c.dur -= d; c.start = newStart; shiftKeyframes(c, -d);
}

/** Split clip at time t; returns new right-hand clip (already inserted) or null. */
export function splitClip(c, t, s = seq()) {
  if (t <= c.start + EPS || t >= clipEnd(c) - EPS) return null;
  const right = cloneClip(c, { linkId: c.linkId });
  right.transIn = null; c.transOut = null;
  trimHead(right, t);
  right.dur = clipEnd(c) - t;
  c.dur = t - c.start;
  s.clips.push(right);
  return right;
}

/** Split clip and linked partners at t, keeping links paired on each side. */
export function splitWithLinks(c, t, s = seq(), useLinks = true) {
  const group = useLinks ? linkedOf(c, s) : [c];
  const newLink = group.length > 1 ? uid('lnk') : null;
  const rights = [];
  for (const g of group) {
    const r = splitClip(g, t, s);
    if (r) { if (newLink) r.linkId = newLink; rights.push(r); }
  }
  return rights;
}

/** Clear [a,b) on a track, trimming/splitting/removing clips (overwrite edit). */
export function clearRange(trackId, a, b, exclude = new Set(), s = seq()) {
  if (b - a < EPS) return;
  for (const c of [...s.clips]) {
    if (c.trackId !== trackId || exclude.has(c.id)) continue;
    const ce = clipEnd(c);
    if (ce <= a + EPS || c.start >= b - EPS) continue;
    if (c.start >= a - EPS && ce <= b + EPS) { removeClips([c.id], s); continue; }
    if (c.start < a && ce > b) {
      const r = splitClip(c, b, s);
      if (r) r.linkId = null;
      c.dur = a - c.start; c.transOut = null;
      continue;
    }
    if (c.start < a) { c.dur = a - c.start; c.transOut = null; }
    else { trimHead(c, b); c.transIn = null; }
  }
}

/** Shift every clip starting at/after t on the given tracks by delta. */
export function rippleShift(t, delta, trackIds = null, s = seq(), exclude = new Set()) {
  for (const c of s.clips) {
    if (exclude.has(c.id)) continue;
    if (trackIds && !trackIds.includes(c.trackId)) continue;
    if (trackById(c.trackId, s)?.locked) continue;
    if (c.start >= t - EPS) c.start = Math.max(0, c.start + delta);
  }
  for (const m of s.markers) if (!trackIds && m.t >= t - EPS) m.t = Math.max(0, m.t + delta);
}

/** Ripple delete clips: remove and close gaps on their tracks (and sync linked). */
export function rippleDelete(ids, s = seq()) {
  const clips = ids.map(id => clipById(id, s)).filter(Boolean);
  if (!clips.length) return;
  const byTrack = new Map();
  for (const c of clips) { if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []); byTrack.get(c.trackId).push(c); }
  removeClips(ids, s);
  // Simple model: per-track, shift later clips left by removed duration (process from right to left).
  const allTrackIds = allTracks(s).map(t => t.id);
  const unionStart = Math.min(...clips.map(c => c.start));
  const union = mergeIntervals(clips.map(c => [c.start, clipEnd(c)]));
  // Shift all tracks consistently (sync lock behavior) if clear on all tracks, else only affected tracks.
  const syncOK = allTrackIds.every(tid => byTrack.has(tid) || !s.clips.some(c => c.trackId === tid && union.some(([a, b]) => c.start < b - EPS && clipEnd(c) > a + EPS)));
  const targets = syncOK ? null : [...byTrack.keys()];
  for (const [a, b] of union.reverse()) rippleShift(b, -(b - a), targets, s);
  return unionStart;
}

export function mergeIntervals(iv) {
  iv = iv.slice().sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of iv) {
    if (out.length && a <= out[out.length - 1][1] + EPS) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Gaps: find empty interval on a track around time t. */
export function gapAt(trackId, t, s = seq()) {
  const cl = trackClips(trackId, s);
  let a = 0, b = Infinity;
  for (const c of cl) {
    if (c.start <= t && clipEnd(c) > t) return null;
    if (clipEnd(c) <= t) a = Math.max(a, clipEnd(c));
    if (c.start > t) b = Math.min(b, c.start);
  }
  return b === Infinity ? null : [a, b];
}

/** Collect edit points (for snapping / navigation). */
export function editPoints(s = seq(), exclude = new Set()) {
  const pts = new Set([0]);
  for (const c of s.clips) { if (exclude.has(c.id)) continue; pts.add(c.start); pts.add(clipEnd(c)); }
  return [...pts].sort((a, b) => a - b);
}

export function addTrack(kind, s = seq()) {
  const list = kind === 'video' ? s.videoTracks : s.audioTracks;
  const n = list.length + 1;
  const t = kind === 'video'
    ? { id: uid('vt'), name: 'V' + n, hidden: false, locked: false, height: 54, target: false }
    : { id: uid('at'), name: 'A' + n, muted: false, solo: false, locked: false, height: 54, target: false, volume: 0, pan: 0 };
  list.push(t);
  return t;
}

export function deleteTrack(id, s = seq()) {
  const k = trackKind(id, s);
  const list = k === 'video' ? s.videoTracks : s.audioTracks;
  if (list.length <= 1) return false;
  removeClips(s.clips.filter(c => c.trackId === id).map(c => c.id), s);
  list.splice(list.findIndex(t => t.id === id), 1);
  list.forEach((t, i) => { if (/^[VA]\d+$/.test(t.name)) t.name = (k === 'video' ? 'V' : 'A') + (i + 1); });
  return true;
}

export function targetTrack(kind, s = seq()) {
  const list = kind === 'video' ? s.videoTracks : s.audioTracks;
  return list.find(t => t.target && !t.locked) || list.find(t => !t.locked) || list[0];
}

/**
 * Place a media item (or a source range of it) on the timeline.
 * mode: 'overwrite' | 'insert'. Returns created clips.
 */
export function placeMedia(media, t, { vTrack, aTrack, srcIn = 0, srcOut = null, mode = 'overwrite', video = true, audio = true } = {}, s = seq()) {
  const maxD = mediaMaxDur(media);
  const end = srcOut ?? (isFinite(maxD) ? maxD : srcIn + 5);
  const dur = Math.max(frame(s), Math.floor((end - srcIn) * s.fps + 1e-3) / s.fps);
  const wantV = video && media.type !== 'audio';
  const wantA = audio && (media.type === 'audio' || (media.type === 'video' && media.hasAudio));
  vTrack ||= targetTrack('video', s).id;
  aTrack ||= targetTrack('audio', s).id;
  if (mode === 'insert') {
    for (const tr of allTracks(s)) if (!tr.locked) for (const c of [...s.clips]) if (c.trackId === tr.id && c.start < t - EPS && clipEnd(c) > t + EPS) splitWithLinks(c, t, s, false);
    rippleShift(t, dur, null, s);
  }
  const link = wantV && wantA ? uid('lnk') : null;
  const out = [];
  if (wantV) {
    clearRange(vTrack, t, t + dur, new Set(), s);
    const c = makeClip(media, 'video', vTrack, t, { dur, in: srcIn, linkId: link }); s.clips.push(c); out.push(c);
  }
  if (wantA) {
    clearRange(aTrack, t, t + dur, new Set(), s);
    const c = makeClip(media, 'audio', aTrack, t, { dur, in: srcIn, linkId: link }); s.clips.push(c); out.push(c);
  }
  return out;
}

export function activeClipsAt(t, s = seq()) {
  return s.clips.filter(c => c.start <= t + EPS && clipEnd(c) > t + EPS);
}
