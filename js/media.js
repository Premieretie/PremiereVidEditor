// Media import, metadata probing, thumbnails, waveforms and runtime element pools.
import { uid, waitEvent, clamp } from './util.js';
import { db } from './db.js';
import { project, commit, bus, mediaById } from './store.js';

/** Runtime-only data per media id: {url, blob, img, thumbs:[{t,c}], peaks:{data,rate}, status} */
export const rt = new Map();
export const getRT = id => { if (!rt.has(id)) rt.set(id, {}); return rt.get(id); };

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi|3gp)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

export function detectType(file) {
  const t = file.type || '';
  if (t.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video';
  if (t.startsWith('audio/') || AUDIO_EXT.test(file.name)) return 'audio';
  if (t.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
  return null;
}

let _actx;
function decodeCtx() { return _actx ||= new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 44100, 44100); }

export async function decodeAudio(blob) {
  const buf = await blob.arrayBuffer();
  return await new Promise((res, rej) => {
    try {
      const p = decodeCtx().decodeAudioData(buf, res, rej);
      if (p?.catch) p.catch(rej);
    } catch (e) { rej(e); }
  });
}

function computePeaks(ab, rate = 100) {
  const n = Math.max(1, Math.ceil(ab.duration * rate));
  const data = new Float32Array(n * 2);
  const chs = []; for (let i = 0; i < ab.numberOfChannels; i++) chs.push(ab.getChannelData(i));
  const per = ab.length / n;
  for (let b = 0; b < n; b++) {
    let mn = 0, mx = 0;
    const s0 = Math.floor(b * per), s1 = Math.min(ab.length, Math.floor((b + 1) * per));
    const stride = Math.max(1, Math.floor((s1 - s0) / 64));
    for (let i = s0; i < s1; i += stride) {
      let v = 0; for (const ch of chs) v += ch[i]; v /= chs.length;
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
    data[b * 2] = mn; data[b * 2 + 1] = mx;
  }
  return { data, rate };
}

async function probe(type, url) {
  if (type === 'image') {
    const img = new Image(); img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight, duration: 5, img };
  }
  const el = document.createElement(type === 'audio' ? 'audio' : 'video');
  el.preload = 'metadata'; el.muted = true; el.src = url;
  await new Promise((res, rej) => { el.onloadedmetadata = res; el.onerror = () => rej(new Error('Unsupported media format')); });
  let duration = el.duration;
  if (!isFinite(duration)) { // MediaRecorder webm files report Infinity until seeked to end
    el.currentTime = 1e9; await waitEvent(el, 'seeked', 4000);
    duration = el.duration; el.currentTime = 0;
  }
  const r = { duration: isFinite(duration) ? duration : 10, width: el.videoWidth || 0, height: el.videoHeight || 0 };
  el.removeAttribute('src'); el.load();
  return r;
}

export async function makeThumbs(m, url) {
  const R = getRT(m.id);
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = url; v.playsInline = true;
  await waitEvent(v, 'loadeddata', 8000);
  const count = clamp(Math.ceil(m.duration / 2), 1, 48);
  const th = 72, tw = Math.round(th * (m.width / m.height || 16 / 9));
  R.thumbs = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(m.duration - 0.05, (i / count) * m.duration + (i === 0 ? 0.05 : 0));
    v.currentTime = Math.max(0, t);
    await waitEvent(v, 'seeked', 4000);
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    try { c.getContext('2d').drawImage(v, 0, 0, tw, th); } catch { }
    R.thumbs.push({ t, c });
    if (i === 0 || i % 6 === 5) bus.emit('media-updated', m.id);
  }
  v.removeAttribute('src'); v.load();
  bus.emit('media-updated', m.id);
}

async function analyzeAudio(m, blob) {
  const R = getRT(m.id);
  if (blob.size > 600 * 1024 * 1024) { R.peaksPending = false; return true; }
  try {
    R.peaksPending = true;
    const ab = await decodeAudio(blob);
    R.peaks = computePeaks(ab);
    if (ab.duration < 240) R.audioBuffer = ab;
    R.peaksPending = false;
    bus.emit('media-updated', m.id);
    return ab.duration > 0.05;
  } catch {
    R.peaksPending = false;
    return false;
  }
}

/** Import File objects into the project. */
export async function importFiles(files, onProgress) {
  const added = [];
  let i = 0;
  for (const file of files) {
    i++;
    const type = detectType(file);
    if (!type) { onProgress?.(`Skipped unsupported file: ${file.name}`); continue; }
    onProgress?.(`Importing ${file.name} (${i}/${files.length})…`);
    const id = uid('m');
    const url = URL.createObjectURL(file);
    let meta;
    try { meta = await probe(type, url); }
    catch (e) { onProgress?.(`Could not read ${file.name}: ${e.message}`); URL.revokeObjectURL(url); continue; }
    const fileKey = uid('f');
    try { await db.putFile(fileKey, file); } catch (e) { console.warn('Could not store file in IndexedDB', e); }
    const m = {
      id, name: file.name, type, mime: file.type, size: file.size, fileKey,
      duration: meta.duration, width: meta.width, height: meta.height, hasAudio: type === 'audio',
      created: Date.now(),
    };
    if (type === 'video' && !meta.width) m.type = 'audio';
    const R = getRT(id); R.url = url; R.blob = file; R.img = meta.img;
    if (m.type === 'video' || m.type === 'audio') {
      const has = await analyzeAudio(m, file);
      if (m.type === 'video') m.hasAudio = has;
    }
    added.push(m);
    commit(`Import ${file.name}`, () => project.media.push(m));
    if (m.type === 'video') makeThumbs(m, url).catch(console.warn);
    else if (m.type === 'image') { const c = document.createElement('canvas'); c.height = 72; c.width = Math.round(72 * m.width / m.height); c.getContext('2d').drawImage(meta.img, 0, 0, c.width, c.height); R.thumbs = [{ t: 0, c }]; bus.emit('media-updated', id); }
  }
  return added;
}

/** Restore runtime URLs for a loaded project from IndexedDB. */
export async function hydrateMedia() {
  for (const m of project.media) {
    if (!m.fileKey) continue;
    const R = getRT(m.id);
    if (R.url) continue;
    let blob = null;
    try { blob = await db.getFile(m.fileKey); } catch { }
    if (!blob) { m.offline = true; continue; }
    m.offline = false;
    R.blob = blob; R.url = URL.createObjectURL(blob);
    if (m.type === 'image') {
      const img = new Image(); img.src = R.url; try { await img.decode(); } catch { }
      R.img = img;
      const c = document.createElement('canvas'); c.height = 72; c.width = Math.max(1, Math.round(72 * (m.width / m.height || 1))); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); R.thumbs = [{ t: 0, c }];
    }
    if (m.type === 'video' || m.type === 'audio') analyzeAudio(m, blob);
    if (m.type === 'video') makeThumbs(m, R.url).catch(console.warn);
  }
  bus.emit('media-updated');
}

export async function relinkMedia(m, file) {
  const type = detectType(file);
  const url = URL.createObjectURL(file);
  const meta = await probe(type, url);
  const fileKey = uid('f');
  try { await db.putFile(fileKey, file); } catch { }
  const R = getRT(m.id); R.url = url; R.blob = file; R.img = meta.img; R.thumbs = null; R.peaks = null;
  commit('Relink Media', () => {
    Object.assign(m, { fileKey, offline: false, size: file.size, mime: file.type, duration: meta.duration, width: meta.width, height: meta.height });
  });
  if (m.type === 'video' || m.type === 'audio') { const has = await analyzeAudio(m, file); if (m.type === 'video') m.hasAudio = has; }
  if (m.type === 'video') makeThumbs(m, url);
  bus.emit('media-updated', m.id);
}

/** Generated media (titles, mattes, adjustment layers). */
export function newGenerated(type, name, extra = {}) {
  const s = project.sequences.find(q => q.id === project.activeSeqId);
  const m = { id: uid('m'), name, type, duration: 5, width: s.width, height: s.height, hasAudio: false, created: Date.now(), ...extra };
  commit(`New ${name}`, () => project.media.push(m));
  return m;
}

// ---------------- Titles ----------------
const titleCache = new Map();
export function renderTitle(p) {
  const key = JSON.stringify(p);
  if (titleCache.has(key)) return titleCache.get(key);
  const lines = String(p.text ?? '').split('\n');
  const font = `${p.italic ? 'italic ' : ''}${p.weight} ${p.size}px "${p.font}", ${p.font}, sans-serif`;
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = font;
  if ('letterSpacing' in meas) meas.letterSpacing = p.tracking + 'px';
  const lh = p.size * p.leading / 100;
  const widths = lines.map(l => meas.measureText(l).width);
  const pad = Math.ceil(p.strokeW + p.shadow * 1.5 + p.size * 0.25);
  const w = Math.max(1, Math.ceil(Math.max(...widths, 1) + pad * 2));
  const hgt = Math.max(1, Math.ceil(lh * lines.length + pad * 2));
  const c = document.createElement('canvas'); c.width = w; c.height = hgt;
  const g = c.getContext('2d');
  if (p.bg) { g.globalAlpha = p.bgOpacity / 100; g.fillStyle = p.bgColor; g.fillRect(0, 0, w, hgt); g.globalAlpha = 1; }
  g.font = font; if ('letterSpacing' in g) g.letterSpacing = p.tracking + 'px';
  g.textBaseline = 'middle'; g.textAlign = p.align; g.lineJoin = 'round';
  const x = p.align === 'left' ? pad : p.align === 'right' ? w - pad : w / 2;
  lines.forEach((l, i) => {
    const y = pad + lh * i + lh / 2;
    if (p.shadow > 0) { g.shadowColor = 'rgba(0,0,0,0.75)'; g.shadowBlur = p.shadow; g.shadowOffsetX = p.shadow / 3; g.shadowOffsetY = p.shadow / 3; }
    if (p.strokeW > 0) { g.strokeStyle = p.stroke; g.lineWidth = p.strokeW * 2; g.strokeText(l, x, y); g.shadowColor = 'transparent'; }
    g.fillStyle = p.fill; g.fillText(l, x, y);
    g.shadowColor = 'transparent';
  });
  if (titleCache.size > 60) titleCache.delete(titleCache.keys().next().value);
  titleCache.set(key, c);
  return c;
}

// ---------------- Element pools ----------------
/** One media element per clip, so overlapping uses of the same file play independently. */
export const pool = new Map(); // clipId -> {el, mediaId, kind}

export function elementFor(clip) {
  const m = mediaById(clip.mediaId);
  if (!m || m.offline) return null;
  const R = getRT(m.id);
  if (!R.url) return null;
  let p = pool.get(clip.id);
  if (p && p.mediaId === m.id && p.url === R.url) return p.el;
  if (p) disposeEl(clip.id);
  const audioOnly = clip.type === 'audio';
  const el = document.createElement(audioOnly ? 'audio' : 'video');
  el.preload = 'auto'; el.playsInline = true; el.crossOrigin = 'anonymous';
  el.muted = !audioOnly;
  el.src = R.url;
  el.addEventListener('seeked', () => bus.emit('frame-ready'));
  el.addEventListener('loadeddata', () => bus.emit('frame-ready'));
  pool.set(clip.id, { el, mediaId: m.id, url: R.url, kind: clip.type });
  return el;
}

export function disposeEl(clipId) {
  const p = pool.get(clipId); if (!p) return;
  try { p.el.pause(); p.node?.disconnect(); p.chain?.forEach(n => n.disconnect()); } catch { }
  p.el.removeAttribute('src'); p.el.load();
  pool.delete(clipId);
}

export function mediaIcon(type) {
  return { video: '🎞', audio: '♪', image: '🖼', title: 'T', color: '■', adjustment: '◐', sequence: '▤' }[type] || '?';
}
