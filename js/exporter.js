// Export: frame-accurate H.264/AAC MP4 via WebCodecs, real-time MediaRecorder fallback, and WAV mixdown.
import * as MP4 from './vendor/mp4-muxer.js';
import * as WEBM from './vendor/webm-muxer.js';
import { seq, ui, clipEnd, seqDuration, mediaById, trackById, bus } from './store.js';
import { engine, pause, playRange, ensureAudio, audio, clipGainAt, trackAudible } from './engine.js';
import { renderFrame, visibleVideo, sourceTime } from './renderer.js';
import { elementFor, getRT, decodeAudio } from './media.js';
import { evalParam, findFx } from './effects.js';
import { dialog, progressBox, toast } from './ui.js';
import { download, waitEvent, dbToGain, clamp, timecode } from './util.js';

const hasWebCodecs = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

export async function exportDialog() {
  pause();
  const s = seq();
  const D = seqDuration(s);
  if (D <= 0) return toast('The sequence is empty — add some clips first');
  const hasIO = s.inPoint != null || s.outPoint != null;
  const formats = [];
  if (hasWebCodecs()) {
    if (await pickVideoCodec('mp4', 1280, 720, 30, 8e6)) formats.push(['mp4', 'H.264 MP4 (frame accurate, recommended)']);
    if (await pickVideoCodec('webm', 1280, 720, 30, 8e6)) formats.push(['webm', 'VP9 WebM (frame accurate)']);
  }
  formats.push(['realtime', 'WebM/MP4 (real-time recording)']);
  formats.push(['wav', 'Waveform Audio (.wav)']);
  formats.push(['png', 'PNG Still (current frame)']);
  const r = await dialog('Export Settings', [
    { k: 'name', label: 'File Name', type: 'text', value: s.name },
    { k: 'format', label: 'Format', type: 'select', value: formats[0][0], options: formats },
    { k: 'size', label: 'Video Size', type: 'select', value: 'match', options: [['match', `Match Sequence (${s.width}×${s.height})`], ['2160', '2160p (4K)'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']] },
    { k: 'bitrate', label: 'Target Bitrate (Mbps)', type: 'number', value: s.height >= 2000 ? 40 : s.height >= 1000 ? 16 : 8, min: 1, max: 200, step: 1 },
    { k: 'range', label: 'Source Range', type: 'select', value: hasIO ? 'io' : 'all', options: [['all', 'Entire Sequence'], ['io', 'Sequence In/Out']] },
    { k: 'audio', label: 'Export Audio', type: 'checkbox', value: true },
    { type: 'info', html: `<div class="muted">Sequence: ${s.width}×${s.height} · ${s.fps} fps · ${timecode(D, s.fps)}<br>MP4 export renders every frame offline, so it may run slower or faster than real time.</div>` },
  ], { okText: 'Export' });
  if (!r) return;
  let a = 0, b = D;
  if (r.range === 'io') { a = s.inPoint ?? 0; b = s.outPoint ?? D; }
  if (b - a <= 0) return toast('Export range is empty');
  const [ow, oh] = outputSize(s, r.size);
  const opts = { name: r.name || s.name, a, b, ow, oh, bitrate: r.bitrate * 1e6, audio: r.audio };
  try {
    if (r.format === 'mp4' || r.format === 'webm') await exportEncoded(r.format, opts);
    else if (r.format === 'realtime') await exportRealtime(opts);
    else if (r.format === 'wav') await exportWAV(opts);
    else if (r.format === 'png') { const c = document.createElement('canvas'); renderFrame(c, s, s.playhead, ow / s.width); c.toBlob(bl => download(bl, opts.name + '.png'), 'image/png'); }
  } catch (e) {
    console.error(e);
    toast('Export failed: ' + (e.message || e), 6000);
  } finally {
    engine.suspended = false; engine.dirty = true;
  }
}

function outputSize(s, size) {
  let ow = s.width, oh = s.height;
  if (size && size !== 'match') { const H = parseInt(size, 10); oh = H; ow = Math.round(s.width * H / s.height); }
  return [Math.max(2, Math.round(ow / 2) * 2), Math.max(2, Math.round(oh / 2) * 2)];
}

/** Supported formats in this browser (for the MCP bridge). */
export async function supportedFormats() {
  const f = [];
  if (hasWebCodecs()) {
    if (await pickVideoCodec('mp4', 1280, 720, 30, 8e6)) f.push('mp4');
    if (await pickVideoCodec('webm', 1280, 720, 30, 8e6)) f.push('webm');
  }
  return [...f, 'realtime', 'wav'];
}

/** Programmatic export: resolves to {blob, filename} instead of downloading. */
export async function runExport({ format = 'mp4', name, range = 'all', size = 'match', bitrate, audio: withAudio = true } = {}) {
  pause();
  const s = seq();
  const D = seqDuration(s);
  if (D <= 0) throw new Error('The sequence is empty');
  let a = 0, b = D;
  if (range === 'io') { a = s.inPoint ?? 0; b = s.outPoint ?? D; }
  else if (Array.isArray(range)) { a = Math.max(0, +range[0]); b = Math.min(D, +range[1]); }
  if (b - a <= 0) throw new Error('Export range is empty');
  const [ow, oh] = outputSize(s, size);
  let out = null;
  const opts = { name: name || s.name, a, b, ow, oh, bitrate: (bitrate || (oh >= 2000 ? 40 : oh >= 1000 ? 16 : 8)) * 1e6, audio: withAudio, deliver: (blob, filename) => out = { blob, filename } };
  try {
    if (format === 'mp4' || format === 'webm') await exportEncoded(format, opts);
    else if (format === 'realtime') await exportRealtime(opts);
    else if (format === 'wav') await exportWAV(opts);
    else throw new Error('Unknown format ' + format);
  } finally { engine.suspended = false; engine.dirty = true; }
  if (!out) throw new Error('Export was cancelled');
  return out;
}

// ---------------- Audio mixdown ----------------
async function mixdown(s, a, b, sampleRate = 48000, onStatus) {
  const len = Math.max(1, Math.ceil((b - a) * sampleRate));
  const ctx = new OfflineAudioContext(2, len, sampleRate);
  const master = ctx.createGain(); master.gain.value = dbToGain(s.masterVolume || 0); master.connect(ctx.destination);
  const tracks = new Map();
  for (const tr of s.audioTracks) {
    const g = ctx.createGain(); g.gain.value = trackAudible(tr, s) ? dbToGain(tr.volume || 0) : 0;
    const p = ctx.createStereoPanner(); p.pan.value = clamp((tr.pan || 0) / 100, -1, 1);
    g.connect(p); p.connect(master); tracks.set(tr.id, g);
  }
  const buffers = new Map();
  const clips = s.clips.filter(c => c.type === 'audio' && c.enabled !== false && clipEnd(c) > a && c.start < b);
  let n = 0;
  for (const c of clips) {
    n++;
    const tr = trackById(c.trackId, s); if (!tr || !trackAudible(tr, s)) continue;
    const m = mediaById(c.mediaId); if (!m || m.offline) continue;
    let buf = buffers.get(m.id);
    if (!buf) {
      const R = getRT(m.id);
      onStatus?.(`Decoding audio ${n}/${clips.length}: ${m.name}`);
      buf = R.audioBuffer;
      if (!buf && R.blob) { try { buf = await decodeAudio(R.blob); } catch { buf = null; } }
      if (!buf) continue;
      buffers.set(m.id, buf);
    }
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = c.speed;
    let node = src;
    const fxOn = type => c.effects.find(e => e.type === type && e.enabled);
    const mid = c.dur / 2;
    const chain = (type, ftype, prop, freq) => {
      const fx = fxOn(type); if (!fx) return;
      const f = ctx.createBiquadFilter(); f.type = ftype;
      if (ftype === 'lowshelf' || ftype === 'highshelf') { f.frequency.value = freq; f.gain.value = evalParam(fx, 'boost', mid); }
      else f.frequency.value = evalParam(fx, 'freq', mid);
      node.connect(f); node = f; void prop;
    };
    chain('bass', 'lowshelf', 'boost', 200); chain('treble', 'highshelf', 'boost', 3500);
    chain('lowpass', 'lowpass', 'freq'); chain('highpass', 'highpass', 'freq');
    const gain = ctx.createGain(); const pan = ctx.createStereoPanner();
    node.connect(gain); gain.connect(pan); pan.connect(tracks.get(c.trackId));
    const t0 = Math.max(a, c.start), t1 = Math.min(b, clipEnd(c));
    const animated = c.transIn || c.transOut || c.effects.some(e => Object.keys(e.kf || {}).length);
    const panFx = fxOn('panner');
    if (animated) {
      const step = 1 / 50;
      gain.gain.setValueAtTime(clipGainAt(c, t0), t0 - a);
      for (let t = t0 + step; t < t1 + step; t += step) {
        const tt = Math.min(t, t1);
        gain.gain.linearRampToValueAtTime(clipGainAt(c, tt), tt - a);
        if (panFx?.kf?.balance?.length) pan.pan.linearRampToValueAtTime(clamp(evalParam(panFx, 'balance', tt - c.start) / 100, -1, 1), tt - a);
      }
    } else gain.gain.value = clipGainAt(c, (t0 + t1) / 2);
    if (panFx && !panFx.kf?.balance?.length) pan.pan.value = clamp(panFx.params.balance / 100, -1, 1);
    const offset = c.in + (t0 - c.start) * c.speed;
    if (offset < buf.duration) src.start(t0 - a, offset, (t1 - t0) * c.speed);
  }
  onStatus?.('Mixing audio…');
  return await ctx.startRendering();
}

// ---------------- MP4 (WebCodecs) ----------------
async function pickVideoCodec(container, w, h, fps, bitrate) {
  const big = w * h > 1920 * 1088;
  const cands = container === 'mp4'
    ? (big ? ['avc1.640033', 'avc1.4d0033', 'avc1.420033'] : ['avc1.640028', 'avc1.4d0028', 'avc1.42001f', 'avc1.640033', 'avc1.42e01e'])
    : ['vp09.00.41.08', 'vp09.00.40.08', 'vp09.00.31.08', 'vp8'];
  for (const codec of cands) {
    for (const hardwareAcceleration of ['no-preference', 'prefer-software']) {
      const cfg = { codec, width: w, height: h, bitrate, framerate: fps, hardwareAcceleration };
      if (codec.startsWith('avc1')) cfg.avc = { format: 'avc' };
      try { const sup = await VideoEncoder.isConfigSupported(cfg); if (sup.supported) return cfg; } catch { }
    }
  }
  return null;
}
async function pickAudioCodec(container, sampleRate) {
  const list = container === 'mp4' ? [['mp4a.40.2', 'aac'], ['opus', 'opus']] : [['opus', 'A_OPUS']];
  for (const [codec, mux] of list) {
    const cfg = { codec, sampleRate, numberOfChannels: 2, bitrate: 192000 };
    try { if (typeof AudioEncoder !== 'undefined' && (await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, mux }; } catch { }
  }
  return null;
}

async function prepareFrame(s, t) {
  const waits = [];
  for (const e of visibleVideo(s, t)) {
    for (const c of [e.clip, e.trans?.A, e.trans?.B]) {
      if (!c) continue;
      const m = mediaById(c.mediaId); if (!m || m.type !== 'video' || m.offline) continue;
      const el = elementFor(c); if (!el) continue;
      if (!el.paused) el.pause();
      if (el.readyState < 1) waits.push(waitEvent(el, 'loadedmetadata', 8000));
      const st = Math.min(sourceTime(c, t, m) + 0.001, Math.max(0, m.duration - 0.001));
      waits.push((async () => {
        if (el.readyState < 1) await waitEvent(el, 'loadedmetadata', 8000);
        if (Math.abs(el.currentTime - st) > 1e-4 || el.readyState < 2) {
          const p = waitEvent(el, 'seeked', 8000);
          el.currentTime = st;
          await p;
        }
        if (el.readyState < 2) await waitEvent(el, 'loadeddata', 3000);
      })());
    }
  }
  await Promise.all(waits);
}

async function exportEncoded(container, { name, a, b, ow, oh, bitrate, audio: withAudio, deliver = download }) {
  const s = seq();
  const fps = s.fps;
  let cancelled = false;
  const pb = progressBox(`Exporting ${name}.${container}`, () => cancelled = true);
  engine.suspended = true;
  const vcfg = await pickVideoCodec(container, ow, oh, fps, bitrate);
  if (!vcfg) { pb.close(); throw new Error(`This browser cannot encode ${container === 'mp4' ? 'H.264' : 'VP9'} at ${ow}×${oh}. Try another size or the real-time export.`); }
  const sampleRate = 48000;
  let acfg = null, abuf = null;
  if (withAudio && s.clips.some(c => c.type === 'audio')) {
    acfg = await pickAudioCodec(container, sampleRate);
    if (acfg) abuf = await mixdown(s, a, b, sampleRate, txt => pb.set(0, txt));
    else toast('Audio encoding is not supported in this browser; exporting video only', 5000);
  }
  if (cancelled) return;
  const lib = container === 'mp4' ? MP4 : WEBM;
  const target = new lib.ArrayBufferTarget();
  const vcodec = container === 'mp4' ? 'avc' : (vcfg.codec === 'vp8' ? 'V_VP8' : 'V_VP9');
  const muxer = new lib.Muxer({
    target, firstTimestampBehavior: 'offset',
    ...(container === 'mp4' ? { fastStart: 'in-memory' } : {}),
    video: { codec: vcodec, width: ow, height: oh, frameRate: Math.round(fps) },
    audio: abuf ? { codec: acfg.mux, numberOfChannels: 2, sampleRate } : undefined,
  });
  let encErr = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => encErr = e });
  venc.configure(vcfg);
  // audio first (fast)
  if (abuf) {
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => encErr = e });
    aenc.configure(acfg.cfg);
    const L = abuf.getChannelData(0), R = abuf.getChannelData(1);
    const block = 4096;
    for (let i = 0; i < abuf.length; i += block) {
      const n = Math.min(block, abuf.length - i);
      const data = new Float32Array(n * 2); data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / sampleRate * 1e6), data });
      aenc.encode(ad); ad.close();
    }
    await aenc.flush(); aenc.close();
  }
  const canvas = document.createElement('canvas');
  const total = Math.max(1, Math.round((b - a) * fps));
  const scale = ow / s.width;
  const t0 = performance.now();
  for (let i = 0; i < total; i++) {
    if (cancelled || encErr) break;
    const t = a + i / fps;
    await prepareFrame(s, t);
    renderFrame(canvas, s, t, scale);
    let src = canvas;
    if (canvas.width !== ow || canvas.height !== oh) { // aspect differs slightly: fit exactly
      const c2 = prepareFit(canvas, ow, oh); src = c2;
    }
    const frame = new VideoFrame(src, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: i % Math.round(fps * 2) === 0 });
    frame.close();
    while (venc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 4));
    if (i % 3 === 0) {
      const el = (performance.now() - t0) / 1000; const eta = el / (i + 1) * (total - i - 1);
      pb.set((i + 1) / total, `Frame ${i + 1} / ${total} · ${((i + 1) / el).toFixed(1)} fps · ~${Math.ceil(eta)}s remaining`);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if (cancelled) { try { venc.close(); } catch { } toast('Export cancelled'); return; }
  if (encErr) { pb.close(); throw encErr; }
  pb.set(1, 'Finalizing…');
  await venc.flush(); venc.close();
  muxer.finalize();
  pb.close();
  deliver(new Blob([target.buffer], { type: `video/${container}` }), `${name}.${container}`);
  toast(`Exported ${name}.${container} (${(target.buffer.byteLength / 1048576).toFixed(1)} MB)`, 5000);
}

let fitCv;
function prepareFit(src, w, h) {
  fitCv ||= document.createElement('canvas');
  fitCv.width = w; fitCv.height = h;
  const g = fitCv.getContext('2d'); g.drawImage(src, 0, 0, w, h);
  return fitCv;
}

// ---------------- Real-time (MediaRecorder) ----------------
async function exportRealtime({ name, a, b, ow, oh, bitrate, audio: withAudio, deliver = download }) {
  const s = seq();
  ensureAudio();
  const canvas = document.createElement('canvas');
  const scale = ow / s.width;
  renderFrame(canvas, s, a, scale);
  const stream = canvas.captureStream(s.fps);
  if (withAudio && audio.streamDest) for (const tr of audio.streamDest.stream.getAudioTracks()) stream.addTrack(tr);
  const types = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mimeType = types.find(t => window.MediaRecorder?.isTypeSupported?.(t));
  if (!mimeType) throw new Error('MediaRecorder is not supported in this browser');
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  let cancelled = false;
  const pb = progressBox(`Recording ${name} (real time)`, () => { cancelled = true; pause(); });
  const render = t => { renderFrame(canvas, s, t, scale); pb.set((t - a) / (b - a), `${timecode(t - a, s.fps)} / ${timecode(b - a, s.fps)} — keep this tab visible`); };
  engine.renderers.add(render);
  const done = new Promise(res => rec.onstop = res);
  await new Promise(r => setTimeout(r, 300)); // let elements pre-seek
  rec.start(250);
  await new Promise(res => playRange(a, b, res));
  await new Promise(r => setTimeout(r, 150));
  rec.stop(); await done;
  engine.renderers.delete(render);
  pb.close();
  if (cancelled) return toast('Export cancelled');
  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  deliver(new Blob(chunks, { type: mimeType.split(';')[0] }), `${name}.${ext}`);
  toast(`Exported ${name}.${ext}`);
}

// ---------------- WAV ----------------
async function exportWAV({ name, a, b, deliver = download }) {
  const s = seq();
  const pb = progressBox(`Exporting ${name}.wav`);
  const buf = await mixdown(s, a, b, 48000, t => pb.set(0.3, t));
  pb.set(0.9, 'Encoding WAV…');
  const blob = encodeWAV(buf);
  pb.close();
  deliver(blob, name + '.wav');
}

export function encodeWAV(buf) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, sr, true);
  out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = clamp(data[c][i], -1, 1); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

export { hasWebCodecs, prepareFrame as prepareFrameForRender };
