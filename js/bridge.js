// Claude bridge: connects the editor to the local MCP server (mcp-server/) over a localhost
// WebSocket, so Claude can inspect and edit the open project through MCP tools.
import {
  project, seq, ui, bus, commit, undo, redo, mediaById, clipById, clipEnd, trackById, linkedOf, placeMedia,
  clearRange, splitWithLinks, removeClips, rippleDelete, rippleShift, trimHead, shiftKeyframes, mediaMaxDur,
  activeClipsAt, addTrack, deleteTrack, newSequence, seqDuration, history,
} from './store.js';
import { EFFECTS, TRANSITIONS, makeEffect, findFx } from './effects.js';
import { importFiles } from './media.js';
import { seek, play, pause } from './engine.js';
import { renderFrame } from './renderer.js';
import { runExport, supportedFormats, prepareFrameForRender } from './exporter.js';
import { h, $, uid, clamp, EPS, LABEL_COLORS } from './util.js';
import { modal, toast } from './ui.js';

const PORT_KEY = 'prweb-claude-port', EN_KEY = 'prweb-claude-enabled';
const store = {
  get port() { try { return parseInt(localStorage.getItem(PORT_KEY), 10) || 7811; } catch { return 7811; } },
  set port(v) { try { localStorage.setItem(PORT_KEY, String(v)); } catch { } },
  get enabled() { try { return localStorage.getItem(EN_KEY) === '1'; } catch { return false; } },
  set enabled(v) { try { localStorage.setItem(EN_KEY, v ? '1' : '0'); } catch { } },
};

let ws = null, status = 'off', retry = null, btn = null, activity = 0;

// ---------------- helpers ----------------
const r3 = v => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
const fr = (t, s = seq()) => Math.round(t * s.fps) / s.fps;

function trackLabel(id, s = seq()) {
  const vi = s.videoTracks.findIndex(t => t.id === id); if (vi >= 0) return 'V' + (vi + 1);
  const ai = s.audioTracks.findIndex(t => t.id === id); if (ai >= 0) return 'A' + (ai + 1);
  return null;
}
function resolveTrack(ref, s = seq()) {
  if (ref == null || ref === '') return null;
  const m = String(ref).match(/^([VA])(\d+)$/i);
  if (m) {
    const list = m[1].toUpperCase() === 'V' ? s.videoTracks : s.audioTracks;
    const t = list[parseInt(m[2], 10) - 1];
    if (!t) throw new Error(`Track ${ref} does not exist (sequence has V1-V${s.videoTracks.length}, A1-A${s.audioTracks.length})`);
    return t;
  }
  const t = trackById(ref, s); if (t) return t;
  throw new Error(`Unknown track "${ref}". Use names like "V1" or "A2".`);
}
function needClip(id, s = seq()) { const c = clipById(id, s); if (!c) throw new Error(`No clip with id ${id} in the active sequence`); return c; }
function needMedia(id) { const m = mediaById(id); if (!m) throw new Error(`No media with id ${id}`); return m; }
function findEffect(c, ref) {
  const fx = c.effects.find(e => e.id === ref) || c.effects.find(e => e.type === ref);
  if (!fx) throw new Error(`Clip ${c.id} has no effect "${ref}". Its effects: ${c.effects.map(e => `${e.type} (${e.id})`).join(', ')}`);
  return fx;
}

function fxSummary(fx) {
  const kf = {};
  for (const [k, list] of Object.entries(fx.kf || {})) if (list?.length) kf[k] = list.map(f => ({ time: r3(f.t), value: r3(f.v), ease: f.ease || 'linear' }));
  const params = {}; for (const [k, v] of Object.entries(fx.params)) params[k] = r3(v);
  return { id: fx.id, type: fx.type, name: EFFECTS[fx.type]?.name, enabled: fx.enabled, params, ...(Object.keys(kf).length ? { keyframes: kf } : {}) };
}
function clipSummary(c, s = seq(), withFx = true) {
  const m = mediaById(c.mediaId);
  return {
    id: c.id, name: c.name, kind: c.type, media_id: c.mediaId, media_type: m?.type, track: trackLabel(c.trackId, s),
    start: r3(c.start), end: r3(clipEnd(c)), duration: r3(c.dur), source_in: r3(c.in), speed: c.speed,
    enabled: c.enabled !== false, scale_to_frame: c.fit,
    linked_clips: c.linkId ? s.clips.filter(x => x.linkId === c.linkId && x !== c).map(x => x.id) : [],
    transition_in: c.transIn ? { type: c.transIn.type, duration: r3(c.transIn.dur) } : null,
    transition_out: c.transOut ? { type: c.transOut.type, duration: r3(c.transOut.dur) } : null,
    ...(withFx ? { effects: c.effects.map(fxSummary) } : {}),
  };
}
function mediaSummary(m) {
  return { id: m.id, name: m.name, type: m.type, duration: r3(m.duration), width: m.width || null, height: m.height || null, has_audio: !!m.hasAudio, offline: !!m.offline, ...(m.srcIn != null || m.srcOut != null ? { source_in: r3(m.srcIn ?? 0), source_out: r3(m.srcOut ?? m.duration) } : {}) };
}
function seqSummary(s, full) {
  const base = { id: s.id, name: s.name, width: s.width, height: s.height, fps: s.fps, duration: r3(seqDuration(s)), active: s.id === project.activeSeqId };
  if (!full) return base;
  return {
    ...base, playhead: r3(s.playhead), in_point: r3(s.inPoint), out_point: r3(s.outPoint), background: s.bg,
    video_tracks: s.videoTracks.map((t, i) => ({ track: 'V' + (i + 1), id: t.id, name: t.name, hidden: t.hidden, locked: t.locked, targeted: t.target })),
    audio_tracks: s.audioTracks.map((t, i) => ({ track: 'A' + (i + 1), id: t.id, name: t.name, muted: t.muted, solo: t.solo, locked: t.locked, targeted: t.target, volume_db: t.volume || 0, pan: t.pan || 0 })),
    master_volume_db: s.masterVolume || 0,
    markers: s.markers.map(m => ({ id: m.id, time: r3(m.t), name: m.name, color: m.color })),
  };
}

function applyParams(c, fx, params = {}, time) {
  const def = EFFECTS[fx.type];
  for (const [k, v] of Object.entries(params)) {
    const p = def.params.find(q => q.k === k);
    if (!p) throw new Error(`Effect ${fx.type} has no parameter "${k}". Parameters: ${def.params.map(q => q.k).join(', ')}`);
    let val = v;
    if (p.type === 'number') { val = Number(v); if (!isFinite(val)) throw new Error(`${k} must be a number`); val = clamp(val, p.min ?? -1e9, p.max ?? 1e9); }
    if (p.type === 'select' && !p.options.includes(val)) throw new Error(`${k} must be one of: ${p.options.join(', ')}`);
    if (p.type === 'bool') val = !!v;
    const kfs = fx.kf?.[k];
    if (kfs?.length && p.type === 'number') {
      const t = clamp(time ?? (seq().playhead - c.start), 0, c.dur);
      const ex = kfs.find(f => Math.abs(f.t - t) < 1 / 120);
      if (ex) ex.v = val; else { kfs.push({ t, v: val, ease: 'linear' }); kfs.sort((a, b) => a.t - b.t); }
    } else fx.params[k] = val;
  }
}
function applyKeyframes(fx, keyframes = {}) {
  const def = EFFECTS[fx.type];
  fx.kf ||= {};
  for (const [k, list] of Object.entries(keyframes)) {
    const p = def.params.find(q => q.k === k);
    if (!p || p.type !== 'number') throw new Error(`"${k}" is not an animatable parameter of ${fx.type}`);
    if (!list || !list.length) { delete fx.kf[k]; continue; }
    fx.kf[k] = list.map(f => ({ t: Math.max(0, Number(f.time)), v: clamp(Number(f.value), p.min ?? -1e9, p.max ?? 1e9), ease: ['linear', 'ease', 'hold'].includes(f.ease) ? f.ease : 'linear' })).sort((a, b) => a.t - b.t);
  }
}

const titleParamMap = { text: 'text', font: 'font', size: 'size', weight: 'weight', italic: 'italic', align: 'align', color: 'fill', tracking: 'tracking', leading: 'leading', stroke_width: 'strokeW', stroke_color: 'stroke', shadow: 'shadow', background: 'bg', background_color: 'bgColor', background_opacity: 'bgOpacity' };

function blobToBase64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });
}
function base64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

function pickVideoTrackFree(s, start, dur) {
  return s.videoTracks.find(t => !t.locked && !s.clips.some(c => c.trackId === t.id && c.start < start + dur - EPS && clipEnd(c) > start + EPS));
}
const label = l => `Claude: ${l}`;

// ---------------- methods ----------------
const METHODS = {
  async get_state({ include_effects = true } = {}) {
    const s = seq();
    return {
      project: project.name,
      active_sequence: seqSummary(s, true),
      sequences: project.sequences.map(q => seqSummary(q, false)),
      media: project.media.map(mediaSummary),
      clips: [...s.clips].sort((a, b) => a.start - b.start).map(c => clipSummary(c, s, include_effects)),
      selection: [...ui.sel],
      notes: 'Times are in seconds. Clip effect keyframe times are relative to the clip start. Tracks are named V1.. (bottom to top) and A1..',
    };
  },

  async list_effects() {
    const describe = ([k, d]) => ({ type: k, name: d.name, kind: d.kind, built_in: !!d.fixed, params: d.params.map(p => ({ name: p.k, label: p.label, type: p.type, default: p.def, ...(p.min != null ? { min: p.min, max: p.max } : {}), ...(p.options ? { options: p.options } : {}), ...(p.unit ? { unit: p.unit } : {}) })) });
    return {
      effects: Object.entries(EFFECTS).map(describe),
      transitions: Object.entries(TRANSITIONS).map(([k, d]) => ({ type: k, name: d.name, kind: d.kind })),
      label_colors: LABEL_COLORS,
    };
  },

  async import_media({ name, data_base64, mime }) {
    const file = new File([base64ToBytes(data_base64)], name, { type: mime || '' });
    const added = await importFiles([file], msg => toast(msg));
    if (!added.length) throw new Error(`Could not import ${name} (unsupported format for this browser?)`);
    return { imported: added.map(mediaSummary) };
  },

  async add_clip({ media_id, start, track, audio_track, mode = 'overwrite', source_in, source_out, duration, video = true, audio = true }) {
    const s = seq(); const m = needMedia(media_id);
    if (m.offline) throw new Error(`${m.name} is offline; relink it in the editor first`);
    const t = fr(start ?? s.playhead);
    let vTrack = null, aTrack = null;
    const tr = track ? resolveTrack(track, s) : null;
    if (tr && s.videoTracks.includes(tr)) vTrack = tr.id; else if (tr) aTrack = tr.id;
    if (audio_track) aTrack = resolveTrack(audio_track, s).id;
    const srcIn = source_in ?? m.srcIn ?? 0;
    let srcOut = source_out ?? (source_in == null ? m.srcOut : null) ?? null;
    if (duration != null) srcOut = srcIn + Number(duration);
    if (isFinite(mediaMaxDur(m)) && srcOut != null) srcOut = Math.min(srcOut, m.duration);
    const created = commit(label(mode === 'insert' ? 'Insert' : 'Overwrite'), () => placeMedia(m, t, { vTrack, aTrack, srcIn, srcOut, mode, video, audio }, s));
    if (!created?.length) throw new Error('Nothing was placed (check the video/audio flags and the media type)');
    return { clips: created.map(c => clipSummary(c, s, false)) };
  },

  async move_clip({ clip_id, start, track, include_linked = true }) {
    const s = seq(); const c = needClip(clip_id, s);
    const group = include_linked ? linkedOf(c, s) : [c];
    const dt = start != null ? fr(start) - c.start : 0;
    if (Math.min(...group.map(g => g.start)) + dt < -EPS) throw new Error('Clips cannot start before 0');
    const newTrack = track ? resolveTrack(track, s) : null;
    if (newTrack && (s.videoTracks.includes(newTrack) !== (c.type === 'video'))) throw new Error(`A ${c.type} clip cannot go on track ${track}`);
    commit(label('Move'), () => {
      for (const g of group) g.start = Math.max(0, g.start + dt);
      if (newTrack) c.trackId = newTrack.id;
      const ids = new Set(group.map(g => g.id));
      for (const g of group) clearRange(g.trackId, g.start, clipEnd(g), ids, s);
    });
    return { clips: group.map(g => clipSummary(g, s, false)) };
  },

  async trim_clip({ clip_id, new_start, new_end, ripple = false, include_linked = true }) {
    const s = seq(); const c = needClip(clip_id, s);
    const group = include_linked ? linkedOf(c, s).filter(g => Math.abs(g.start - c.start) < 1e-3 && Math.abs(clipEnd(g) - clipEnd(c)) < 1e-3) : [c];
    const f = 1 / s.fps;
    commit(label('Trim'), () => {
      const ids = new Set(group.map(g => g.id));
      if (new_start != null) {
        let d = fr(new_start) - c.start;
        for (const g of group) {
          const md = mediaMaxDur(mediaById(g.mediaId));
          if (isFinite(md)) d = Math.max(d, -g.in / g.speed);
          d = Math.min(d, g.dur - f);
          if (!ripple) d = Math.max(d, -g.start);
        }
        const oldEnd = clipEnd(c);
        for (const g of group) {
          if (ripple) { g.in += d * g.speed; g.dur -= d; shiftKeyframes(g, -d); }
          else trimHead(g, g.start + d);
        }
        if (ripple) rippleShift(oldEnd, -d, null, s, ids);
        else for (const g of group) clearRange(g.trackId, g.start, clipEnd(g), ids, s);
      }
      if (new_end != null) {
        let ne = fr(new_end);
        for (const g of group) {
          const md = mediaMaxDur(mediaById(g.mediaId));
          if (isFinite(md)) ne = Math.min(ne, g.start + (md - g.in) / g.speed);
          ne = Math.max(ne, g.start + f);
        }
        const oldEnd = clipEnd(c);
        for (const g of group) g.dur = ne - g.start;
        if (ripple) rippleShift(oldEnd, ne - oldEnd, null, s, ids);
        else for (const g of group) clearRange(g.trackId, g.start, clipEnd(g), ids, s);
      }
    });
    return { clips: group.map(g => clipSummary(g, s, false)) };
  },

  async split_clip({ time, clip_id, all_tracks = false }) {
    const s = seq(); const t = fr(time ?? s.playhead);
    const created = [];
    commit(label('Razor'), () => {
      if (clip_id) created.push(...splitWithLinks(needClip(clip_id, s), t, s, true));
      else for (const c of [...s.clips]) {
        if (trackById(c.trackId, s)?.locked) continue;
        if (!all_tracks && !trackById(c.trackId, s)?.target && !c.linkId) continue;
        if (c.start < t - EPS && clipEnd(c) > t + EPS) { const r = splitWithLinks(c, t, s, false); created.push(...r); }
      }
    });
    if (!created.length) throw new Error(`No clip spans time ${t}s${clip_id ? ' for that clip' : ''}`);
    return { new_clips: created.map(c => clipSummary(c, s, false)) };
  },

  async delete_clips({ clip_ids, ripple = false, include_linked = false }) {
    const s = seq();
    let ids = clip_ids.map(id => needClip(id, s).id);
    if (include_linked) ids = [...new Set(ids.flatMap(id => linkedOf(clipById(id, s), s).map(c => c.id)))];
    commit(label(ripple ? 'Ripple Delete' : 'Clear'), () => ripple ? rippleDelete(ids, s) : removeClips(ids, s));
    return { deleted: ids };
  },

  async close_gap({ track, time }) {
    const s = seq(); const tr = resolveTrack(track, s);
    const cl = s.clips.filter(c => c.trackId === tr.id).sort((a, b) => a.start - b.start);
    let a = 0, b = null;
    for (const c of cl) { if (clipEnd(c) <= time + EPS) a = Math.max(a, clipEnd(c)); else if (c.start > time && b == null) b = c.start; }
    if (b == null || cl.some(c => c.start <= time && clipEnd(c) > time)) throw new Error(`No gap at ${time}s on ${track}`);
    commit(label('Ripple Delete Gap'), () => rippleShift(b, -(b - a), null, s));
    return { removed_gap: [r3(a), r3(b)] };
  },

  async set_clip({ clip_id, name, enabled, speed, label: lab, scale_to_frame, include_linked = true }) {
    const s = seq(); const c = needClip(clip_id, s);
    const group = include_linked ? linkedOf(c, s) : [c];
    commit(label('Clip Properties'), () => {
      for (const g of group) {
        if (name != null) g.name = name;
        if (enabled != null) g.enabled = !!enabled;
        if (lab != null) g.label = LABEL_COLORS[lab] || lab;
        if (scale_to_frame != null && g.type === 'video') g.fit = !!scale_to_frame;
        if (speed != null) {
          const sp = clamp(Number(speed), 0.01, 100);
          const srcDur = g.dur * g.speed;
          g.speed = sp; g.dur = fr(srcDur / sp);
          const m = mediaById(g.mediaId);
          if (isFinite(mediaMaxDur(m))) g.dur = Math.min(g.dur, (m.duration - g.in) / sp);
        }
      }
    });
    return { clips: group.map(g => clipSummary(g, s)) };
  },

  async add_effect({ clip_id, effect, params, keyframes }) {
    const s = seq(); const c = needClip(clip_id, s);
    const def = EFFECTS[effect];
    if (!def || def.fixed) throw new Error(`Unknown effect "${effect}". Use list_effects to see available effects.`);
    if ((def.kind === 'audio') !== (c.type === 'audio')) throw new Error(`${def.name} is a ${def.kind} effect but clip ${clip_id} is ${c.type}`);
    let fx;
    commit(label(`Apply ${def.name}`), () => {
      fx = makeEffect(effect);
      c.effects.push(fx);
      if (params) applyParams(c, fx, params);
      if (keyframes) applyKeyframes(fx, keyframes);
    });
    return { effect: fxSummary(fx) };
  },

  async set_effect({ clip_id, effect, params, keyframes, time, enabled, reset = false }) {
    const s = seq(); const c = needClip(clip_id, s);
    const fx = findEffect(c, effect);
    commit(label(`Edit ${EFFECTS[fx.type].name}`), () => {
      if (reset) { const n = makeEffect(fx.type); fx.params = n.params; fx.kf = {}; }
      if (enabled != null) fx.enabled = !!enabled;
      if (keyframes) applyKeyframes(fx, keyframes);
      if (params) applyParams(c, fx, params, time);
    });
    return { effect: fxSummary(fx) };
  },

  async remove_effect({ clip_id, effect }) {
    const s = seq(); const c = needClip(clip_id, s);
    const fx = findEffect(c, effect);
    if (EFFECTS[fx.type].fixed) throw new Error(`${EFFECTS[fx.type].name} is built in and cannot be removed; use set_effect with reset or enabled=false`);
    commit(label(`Remove ${EFFECTS[fx.type].name}`), () => c.effects.splice(c.effects.indexOf(fx), 1));
    return { removed: fx.id };
  },

  async set_transition({ clip_id, edge, type, duration = 1 }) {
    const s = seq(); const c = needClip(clip_id, s);
    if (edge !== 'in' && edge !== 'out') throw new Error('edge must be "in" (clip start) or "out" (clip end)');
    if (type) {
      const def = TRANSITIONS[type]; if (!def) throw new Error(`Unknown transition "${type}"`);
      if ((def.kind === 'audio') !== (c.type === 'audio')) throw new Error(`${def.name} is a ${def.kind} transition but the clip is ${c.type}`);
    }
    commit(label(type ? `Apply ${TRANSITIONS[type].name}` : 'Remove Transition'), () => {
      c[edge === 'in' ? 'transIn' : 'transOut'] = type ? { type, dur: clamp(fr(duration), 1 / s.fps, c.dur) } : null;
    });
    return { clip: clipSummary(c, s, false) };
  },

  async add_title({ text, start, duration = 5, track, x, y, ...style }) {
    const s = seq(); const t = fr(start ?? s.playhead);
    const tr = track ? resolveTrack(track, s) : pickVideoTrackFree(s, t, duration) || s.videoTracks[s.videoTracks.length - 1];
    if (!s.videoTracks.includes(tr)) throw new Error('Titles go on a video track');
    let clip;
    commit(label('New Title'), () => {
      const m = { id: uid('m'), name: String(text).split('\n')[0].slice(0, 40) || 'Graphic', type: 'title', duration: Number(duration), width: s.width, height: s.height, hasAudio: false, created: Date.now() };
      project.media.push(m);
      [clip] = placeMedia(m, t, { vTrack: tr.id, audio: false, srcIn: 0, srcOut: Number(duration) }, s);
      const tfx = findFx(clip, 'text');
      tfx.params.size = Math.round(s.height / 11);
      const p = { text };
      for (const [k, v] of Object.entries(style)) { if (v == null) continue; if (!titleParamMap[k]) throw new Error(`Unknown title option ${k}`); p[titleParamMap[k]] = v; }
      applyParams(clip, tfx, p);
      const mfx = findFx(clip, 'motion');
      mfx.params.x = x ?? s.width / 2; mfx.params.y = y ?? Math.round(s.height * 0.8);
    });
    return { clip: clipSummary(clip, s) };
  },

  async add_generated({ type, start, duration = 5, track, color = '#000000', name }) {
    const s = seq(); const t = fr(start ?? s.playhead);
    if (type !== 'color' && type !== 'adjustment') throw new Error('type must be "color" or "adjustment"');
    const tr = track ? resolveTrack(track, s) : pickVideoTrackFree(s, t, duration) || s.videoTracks[s.videoTracks.length - 1];
    let clip;
    commit(label(type === 'color' ? 'New Color Matte' : 'New Adjustment Layer'), () => {
      const m = { id: uid('m'), name: name || (type === 'color' ? 'Color Matte' : 'Adjustment Layer'), type, duration: Number(duration), width: s.width, height: s.height, hasAudio: false, created: Date.now(), ...(type === 'color' ? { color } : {}) };
      project.media.push(m);
      [clip] = placeMedia(m, t, { vTrack: tr.id, audio: false, srcIn: 0, srcOut: Number(duration) }, s);
      if (type === 'color') findFx(clip, 'colorMatte').params.color = color;
    });
    return { clip: clipSummary(clip, s) };
  },

  async add_marker({ time, name = '', color = '#3ec85a' }) {
    const s = seq(); let mk;
    commit(label('Add Marker'), () => s.markers.push(mk = { id: uid('mk'), t: fr(time ?? s.playhead), name, color }));
    return { marker: { id: mk.id, time: r3(mk.t), name, color } };
  },
  async remove_marker({ marker_id }) {
    const s = seq();
    if (!s.markers.some(m => m.id === marker_id)) throw new Error('No such marker');
    commit(label('Clear Marker'), () => s.markers = s.markers.filter(m => m.id !== marker_id));
    return { removed: marker_id };
  },
  async set_in_out({ in_point, out_point }) {
    const s = seq();
    if (in_point !== undefined) s.inPoint = in_point == null ? null : fr(in_point);
    if (out_point !== undefined) s.outPoint = out_point == null ? null : fr(out_point);
    bus.emit('marks');
    return { in_point: r3(s.inPoint), out_point: r3(s.outPoint) };
  },

  async add_track({ kind }) {
    if (kind !== 'video' && kind !== 'audio') throw new Error('kind must be "video" or "audio"');
    const s = seq(); let t;
    commit(label(`Add ${kind} Track`), () => t = addTrack(kind, s));
    return { track: trackLabel(t.id, s) };
  },
  async set_track({ track, name, muted, solo, locked, hidden, volume_db, pan, targeted }) {
    const s = seq(); const t = resolveTrack(track, s);
    commit(label('Track Settings'), () => {
      if (name != null) t.name = name;
      if (locked != null) t.locked = !!locked;
      if (targeted != null) t.target = !!targeted;
      if (s.videoTracks.includes(t)) { if (hidden != null) t.hidden = !!hidden; }
      else {
        if (muted != null) t.muted = !!muted;
        if (solo != null) t.solo = !!solo;
        if (volume_db != null) t.volume = clamp(Number(volume_db), -96, 12);
        if (pan != null) t.pan = clamp(Number(pan), -100, 100);
      }
    });
    return (await METHODS.get_state({ include_effects: false })).active_sequence;
  },
  async delete_track({ track }) {
    const s = seq(); const t = resolveTrack(track, s); let ok;
    commit(label('Delete Track'), () => ok = deleteTrack(t.id, s));
    if (!ok) throw new Error('A sequence needs at least one video and one audio track');
    return { deleted: track };
  },
  async set_master_volume({ volume_db }) {
    const s = seq();
    commit(label('Master Volume'), () => s.masterVolume = clamp(Number(volume_db), -96, 12));
    return { master_volume_db: s.masterVolume };
  },

  async create_sequence({ name, width = 1920, height = 1080, fps = 30, activate = true }) {
    let s;
    commit(label('New Sequence'), () => {
      s = newSequence(name || `Sequence ${String(project.sequences.length + 1).padStart(2, '0')}`, Math.round(width), Math.round(height), Number(fps));
      project.sequences.push(s);
      if (activate) project.activeSeqId = s.id;
    });
    bus.emit('project');
    return { sequence: seqSummary(s, false) };
  },
  async set_sequence({ sequence_id, name, width, height, fps, background }) {
    let s = seq();
    if (sequence_id) {
      const q = project.sequences.find(x => x.id === sequence_id || x.name === sequence_id);
      if (!q) throw new Error('No such sequence');
      pause(); project.activeSeqId = q.id; ui.sel.clear(); s = q;
    }
    if (name != null || width != null || height != null || fps != null || background != null) {
      commit(label('Sequence Settings'), () => {
        if (name != null) s.name = name;
        if (width != null) s.width = Math.round(width);
        if (height != null) s.height = Math.round(height);
        if (fps != null) s.fps = Number(fps);
        if (background != null) s.bg = background;
      });
    }
    bus.emit('project');
    return { sequence: seqSummary(s, true) };
  },

  async select_clips({ clip_ids = [] }) {
    const s = seq(); ui.sel = new Set(clip_ids.filter(id => clipById(id, s))); ui.selTrans = null; bus.emit('selection');
    return { selected: [...ui.sel] };
  },
  async seek({ time }) { seek(Number(time)); return { playhead: r3(seq().playhead) }; },
  async play() { play(1); return { playing: true }; },
  async pause() { pause(); return { playing: false, playhead: r3(seq().playhead) }; },
  async undo() { const n = history.undo.at(-1)?.label; undo(); return { undone: n || null }; },
  async redo() { const n = history.redo.at(-1)?.label; redo(); return { redone: n || null }; },

  async render_frame({ time, max_width = 960 } = {}) {
    const s = seq(); const t = time ?? s.playhead;
    pause();
    if (time != null) seek(t);
    // give media elements a moment to seek, then render with the exporter's frame-accurate prep
    await prepareFrameForRender(s, t);
    const c = document.createElement('canvas');
    renderFrame(c, s, t, Math.min(1, max_width / s.width));
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    return { time: r3(t), width: c.width, height: c.height, png_base64: await blobToBase64(blob), visible_clips: activeClipsAt(t, s).map(x => ({ id: x.id, name: x.name, track: trackLabel(x.trackId, s) })) };
  },

  async export_video(opts = {}) {
    const fmts = await supportedFormats();
    const format = opts.format || fmts[0];
    if (!fmts.includes(format)) throw new Error(`This browser can export: ${fmts.join(', ')}`);
    const range = opts.start != null || opts.end != null ? [opts.start ?? 0, opts.end ?? seqDuration()] : (opts.range || 'all');
    const { blob, filename } = await runExport({ format, name: opts.name, range, size: opts.size, bitrate: opts.bitrate_mbps, audio: opts.audio !== false });
    return { filename, mime: blob.type, bytes: blob.size, data_base64: await blobToBase64(blob) };
  },

  async export_formats() { return { formats: await supportedFormats() }; },
};

// ---------------- connection ----------------
function setStatus(st, detail = '') {
  status = st;
  if (!btn) return;
  btn.dataset.state = st;
  btn.title = st === 'connected' ? 'Claude is connected through MCP. Click for details.' : st === 'connecting' ? `Looking for the Claude MCP server on port ${store.port}… ${detail}` : 'Connect Claude (MCP)';
  btn.querySelector('.cl-text').textContent = st === 'connected' ? 'Claude connected' : st === 'connecting' ? 'Waiting for Claude…' : 'Connect Claude';
  bus.emit('claude-status', st);
}

function connect() {
  clearTimeout(retry);
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  setStatus('connecting');
  let sock;
  try { sock = new WebSocket(`ws://127.0.0.1:${store.port}`); } catch (e) { scheduleRetry(); return; }
  ws = sock;
  sock.onopen = () => {
    setStatus('connected');
    sock.send(JSON.stringify({ type: 'hello', app: 'premiere-web', version: 1, project: project.name }));
    toast('Claude connected — it can now edit this project', 3000);
  };
  sock.onmessage = async ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'ping') return sock.send(JSON.stringify({ type: 'pong' }));
    if (msg.id == null || !msg.method) return;
    const fn = METHODS[msg.method];
    flash();
    try {
      if (!fn) throw new Error(`Unknown method ${msg.method}`);
      const result = await fn(msg.params || {});
      sock.send(JSON.stringify({ id: msg.id, result }));
    } catch (e) {
      sock.send(JSON.stringify({ id: msg.id, error: e?.message || String(e) }));
    }
  };
  sock.onclose = () => { if (ws === sock) { ws = null; const was = status; setStatus(store.enabled ? 'connecting' : 'off'); if (was === 'connected') toast('Claude disconnected'); scheduleRetry(); } };
  sock.onerror = () => { };
}
function scheduleRetry() { clearTimeout(retry); if (store.enabled) retry = setTimeout(connect, 3000); }
function disconnect() { store.enabled = false; clearTimeout(retry); const s = ws; ws = null; s?.close(); setStatus('off'); }
function flash() { if (!btn) return; btn.classList.add('busy'); clearTimeout(activity); activity = setTimeout(() => btn.classList.remove('busy'), 600); }

function openPanel() {
  const port = h('input', { type: 'number', value: store.port, min: 1024, max: 65535, style: { width: '90px' } });
  const stateText = () => status === 'connected' ? '🟢 Connected — Claude can edit this project. Every change shows up in History and can be undone.' : status === 'connecting' ? `🟡 Waiting for the MCP server on port ${store.port}. Make sure Claude Desktop / Claude Code is running with the premiere-web MCP server.` : '⚪ Not connected.';
  const st = h('div.cl-state', {}, stateText());
  const off = bus.on('claude-status', () => st.textContent = stateText());
  const body = h('div.cl-panel', {},
    st,
    h('label.form-row', {}, h('span', {}, 'Bridge port'), port),
    h('div.form-info', { html: `
      <p><b>Set up once:</b></p>
      <ol>
        <li>Install <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js 18+</a>, download this repository, then run <code>npm install</code> in its <code>mcp-server</code> folder.</li>
        <li>Add the server to Claude:<br>
          <b>Claude Code:</b> <code>claude mcp add premiere-web -- node /path/to/mcp-server/index.js</code><br>
          <b>Claude Desktop:</b> add it to <code>claude_desktop_config.json</code> (see <code>mcp-server/README.md</code>).</li>
        <li>Click <b>Connect</b> here. If your browser asks to allow access to apps on this device, choose <b>Allow</b>.</li>
      </ol>
      <p class="muted">The bridge only talks to <code>127.0.0.1</code>. Your media never leaves your computer except when Claude asks to view a frame.</p>` }),
  );
  modal('Claude (MCP)', body, [
    { label: status === 'off' ? 'Close' : 'Disconnect', action: c => { if (status !== 'off') disconnect(); c(); } },
    { label: status === 'connected' ? 'OK' : 'Connect', primary: true, action: c => { const p = parseInt(port.value, 10); if (p && p !== store.port) { store.port = p; ws?.close(); } if (status !== 'connected') { store.enabled = true; connect(); } c(); } },
  ], { onClose: () => off() });
}

export function initBridge() {
  btn = h('button.claude-btn', { on: { click: openPanel } }, h('span.cl-dot'), h('span.cl-text', {}, 'Connect Claude'));
  $('.topbar-right').prepend(btn);
  setStatus('off');
  if (store.enabled) connect();
  window.__claudeMethods = METHODS; // handy for debugging from the console
}
