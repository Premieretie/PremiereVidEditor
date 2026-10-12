// Playback engine: clock, media element sync and Web Audio mixing graph.
import { bus, seq, ui, clipEnd, seqDuration, project, trackById } from './store.js';
import { pool, elementFor, disposeEl } from './media.js';
import { visibleVideo, sourceTime } from './renderer.js';
import { evalParam, findFx, transitionProgressCurve } from './effects.js';
import { dbToGain, EPS, clamp } from './util.js';

export const audio = { ctx: null, master: null, analyserL: null, analyserR: null, streamDest: null, tracks: new Map() };

export function ensureAudio() {
  if (audio.ctx) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return audio.ctx; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ctx = audio.ctx = new AC({ latencyHint: 'interactive' });
  audio.master = ctx.createGain();
  const split = ctx.createChannelSplitter(2);
  audio.analyserL = ctx.createAnalyser(); audio.analyserR = ctx.createAnalyser();
  audio.analyserL.fftSize = audio.analyserR.fftSize = 1024;
  audio.master.connect(split); split.connect(audio.analyserL, 0); split.connect(audio.analyserR, 1);
  audio.master.connect(ctx.destination);
  audio.streamDest = ctx.createMediaStreamDestination();
  audio.master.connect(audio.streamDest);
  return ctx;
}

function trackNode(track) {
  let n = audio.tracks.get(track.id);
  if (!n) {
    const ctx = audio.ctx;
    const gain = ctx.createGain(), pan = ctx.createStereoPanner();
    gain.connect(pan); pan.connect(audio.master);
    n = { gain, pan }; audio.tracks.set(track.id, n);
  }
  return n;
}

function audioChain(clip, el) {
  const p = pool.get(clip.id);
  if (!p || !audio.ctx) return null;
  if (p.chain) return p;
  const ctx = audio.ctx;
  try { p.node = ctx.createMediaElementSource(el); } catch (e) { console.warn(e); return null; }
  const bass = ctx.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 200; bass.gain.value = 0;
  const treble = ctx.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 3500; treble.gain.value = 0;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 22050;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 10;
  const gain = ctx.createGain(); const pan = ctx.createStereoPanner();
  p.node.connect(bass); bass.connect(treble); treble.connect(lp); lp.connect(hp); hp.connect(gain); gain.connect(pan);
  p.chain = [bass, treble, lp, hp, gain, pan];
  p.nodes = { bass, treble, lp, hp, gain, pan };
  p.trackId = null;
  return p;
}

/** Linear gain of an audio clip at timeline time t (volume keyframes, amplify, fades). */
export function clipGainAt(c, t) {
  const lt = t - c.start;
  let db = 0;
  for (const fx of c.effects) {
    if (!fx.enabled) continue;
    if (fx.type === 'volume') db += evalParam(fx, 'level', lt);
    if (fx.type === 'amplify') db += evalParam(fx, 'gain', lt);
  }
  let g = dbToGain(db);
  if (c.transIn && lt < c.transIn.dur) g *= transitionProgressCurve(c.transIn.type, clamp(lt / c.transIn.dur, 0, 1));
  const rem = clipEnd(c) - t;
  if (c.transOut && rem < c.transOut.dur) g *= transitionProgressCurve(c.transOut.type, clamp(rem / c.transOut.dur, 0, 1));
  return g;
}

export function trackAudible(track, s = seq()) {
  const anySolo = s.audioTracks.some(t => t.solo);
  return !track.muted && (!anySolo || track.solo);
}

function updateAudioParams(c, p, t, s) {
  const N = p.nodes; if (!N) return;
  const tr = trackById(c.trackId, s);
  if (!tr) return;
  if (p.trackId !== c.trackId) { N.pan.disconnect(); N.pan.connect(trackNode(tr).gain); p.trackId = c.trackId; }
  const lt = t - c.start;
  const fxOf = type => c.effects.find(e => e.type === type && e.enabled);
  const now = audio.ctx.currentTime;
  const set = (param, v) => param.setTargetAtTime(v, now, 0.015);
  set(N.gain.gain, clipGainAt(c, t));
  const pan = fxOf('panner'); set(N.pan.pan, pan ? clamp(evalParam(pan, 'balance', lt) / 100, -1, 1) : 0);
  const bass = fxOf('bass'); set(N.bass.gain, bass ? evalParam(bass, 'boost', lt) : 0);
  const treb = fxOf('treble'); set(N.treble.gain, treb ? evalParam(treb, 'boost', lt) : 0);
  const lp = fxOf('lowpass'); set(N.lp.frequency, lp ? evalParam(lp, 'freq', lt) : 22050);
  const hp = fxOf('highpass'); set(N.hp.frequency, hp ? evalParam(hp, 'freq', lt) : 10);
}

function updateTracks(s) {
  if (!audio.ctx) return;
  const now = audio.ctx.currentTime;
  for (const tr of s.audioTracks) {
    const n = trackNode(tr);
    n.gain.gain.setTargetAtTime(trackAudible(tr, s) ? dbToGain(tr.volume || 0) : 0, now, 0.015);
    n.pan.pan.setTargetAtTime(clamp((tr.pan || 0) / 100, -1, 1), now, 0.015);
  }
  audio.master.gain.setTargetAtTime(dbToGain(s.masterVolume || 0), now, 0.015);
}

// ---------------- Clock ----------------
export const engine = {
  rate: 0, t0: 0, n0: 0, dirty: true, renderers: new Set(), endAt: null, onEnd: null,
  get time() { return seq().playhead; },
};

export function seek(t, { snapToFrame = true } = {}) {
  const s = seq();
  t = Math.max(0, t);
  if (snapToFrame) t = Math.round(t * s.fps) / s.fps;
  s.playhead = t;
  if (ui.playing) { engine.t0 = t; engine.n0 = performance.now(); }
  engine.dirty = true;
  bus.emit('time', t);
}

export function play(rate = 1) {
  ensureAudio();
  const s = seq();
  if (rate > 0 && s.playhead >= seqDuration(s) - EPS && engine.endAt == null) seek(0);
  engine.rate = rate; engine.t0 = s.playhead; engine.n0 = performance.now();
  ui.playing = true;
  bus.emit('play-state', true);
}

export function pause() {
  if (!ui.playing) return;
  ui.playing = false; engine.rate = 0;
  const s = seq(); seek(s.playhead);
  for (const p of pool.values()) p.el.pause();
  engine.endAt = null;
  bus.emit('play-state', false);
  const cb = engine.onEnd; engine.onEnd = null; cb?.();
}

export function togglePlay() { ui.playing ? pause() : play(1); }

/** Play a range then stop (used by "play in to out" and real-time export). */
export function playRange(a, b, onEnd) {
  seek(a); engine.endAt = b; engine.onEnd = onEnd; play(1);
}

export function shuttle(dir) {
  if (dir === 0) return pause();
  const steps = [1, 2, 4, 8];
  if (!ui.playing || Math.sign(engine.rate) !== dir) return play(dir);
  const i = steps.indexOf(Math.abs(engine.rate));
  play(dir * steps[Math.min(steps.length - 1, i + 1)]);
}

let lastPrune = 0;
function prune(now) {
  if (now - lastPrune < 2000) return;
  lastPrune = now;
  const ids = new Set(); for (const s of project.sequences) for (const c of s.clips) ids.add(c.id);
  for (const id of [...pool.keys()]) if (!ids.has(id) && !id.startsWith('src:')) disposeEl(id);
}

function syncMedia(t, playing, s) {
  const needed = new Map(); // clipId -> {clip, st}
  for (const e of visibleVideo(s, t)) {
    for (const c of [e.clip, e.trans?.A, e.trans?.B]) if (c) needed.set(c.id, c);
  }
  for (const c of s.clips) {
    if (c.type !== 'audio' || c.enabled === false) continue;
    if (c.start <= t + EPS && clipEnd(c) > t + EPS) needed.set(c.id, c);
  }
  const rate = engine.rate;
  const forward = playing && rate > 0;
  const fps = s.fps;
  for (const c of needed.values()) {
    const el = elementFor(c); if (!el) continue;
    const m = project.media.find(x => x.id === c.mediaId);
    const st = sourceTime(c, t, m);
    if (c.type === 'audio' && audio.ctx) { const p = audioChain(c, el); if (p) updateAudioParams(c, p, t, s); }
    if (forward) {
      const pr = clamp(c.speed * rate, 0.0625, 16);
      if (Math.abs(el.playbackRate - pr) > 1e-3) el.playbackRate = pr;
      if (el.paused) { if (Math.abs(el.currentTime - st) > 0.03) el.currentTime = st; el.play().catch(() => { }); }
      else if (Math.abs(el.currentTime - st) > 0.25 * Math.max(1, pr)) el.currentTime = st;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - st) > 0.5 / fps && !el.seeking) el.currentTime = st;
    }
  }
  // Pre-roll: get upcoming clips seeked to their in-points.
  if (forward) {
    for (const c of s.clips) {
      if (needed.has(c.id) || c.enabled === false) continue;
      if (c.start > t && c.start - t < 1.5 * Math.max(1, rate)) {
        const el = elementFor(c); if (!el) continue;
        if (c.type === 'audio' && audio.ctx) audioChain(c, el);
        if (!el.seeking && Math.abs(el.currentTime - c.in) > 0.05) el.currentTime = c.in;
        needed.set(c.id, c);
      }
      // Clips needed as transition partners shortly
    }
  }
  for (const [id, p] of pool) if (!needed.has(id) && !id.startsWith('src:') && !p.el.paused) p.el.pause();
}

function tick(now) {
  const s = seq();
  if (ui.playing) {
    let t = engine.t0 + (now - engine.n0) / 1000 * engine.rate;
    const end = engine.endAt ?? seqDuration(s);
    if (engine.rate > 0 && t >= end) { t = end; s.playhead = t; pause(); }
    else if (engine.rate < 0 && t <= 0) { t = 0; s.playhead = 0; pause(); }
    else { s.playhead = t; bus.emit('time', t); }
    engine.dirty = true;
  }
  if (engine.suspended) { requestAnimationFrame(tick); return; }
  try {
    updateTracks(s);
    syncMedia(s.playhead, ui.playing, s);
    prune(now);
  } catch (e) { console.error(e); }
  if (engine.dirty) {
    engine.dirty = false;
    for (const r of engine.renderers) { try { r(s.playhead); } catch (e) { console.error(e); } }
  }
  requestAnimationFrame(tick);
}

bus.on('frame-ready', () => { engine.dirty = true; });
bus.on('change', () => { engine.dirty = true; });
bus.on('project', () => { engine.dirty = true; });
requestAnimationFrame(tick);
