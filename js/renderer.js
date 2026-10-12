// Frame compositor: draws a sequence at time t onto a 2D canvas.
import { EPS, clamp } from './util.js';
import { evalEffect, findFx, cssFilterFor, EFFECTS } from './effects.js';
import { mediaById, clipEnd, trackClips } from './store.js';
import { getRT, renderTitle, elementFor } from './media.js';

const canvases = {};
function scratch(name, w, h) {
  let c = canvases[name];
  if (!c) c = canvases[name] = document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}

export function sourceTime(clip, t, media) {
  let st = clip.in + (t - clip.start) * clip.speed;
  if (media && (media.type === 'video' || media.type === 'audio')) st = clamp(st, 0, Math.max(0, media.duration - 0.02));
  return st;
}

/**
 * List of {clip, role, partner, p, type} that must be drawn at t, per video track (bottom->top).
 * Used by renderer and by the playback engine to know which elements must be in sync.
 */
export function visibleVideo(s, t) {
  const out = [];
  for (const tr of s.videoTracks) {
    if (tr.hidden) continue;
    const cl = trackClips(tr.id, s).filter(c => c.type === 'video' && c.enabled !== false);
    const cur = cl.find(c => c.start <= t + EPS && clipEnd(c) > t + EPS);
    const entry = { track: tr, clip: cur || null, trans: null };
    if (cur?.transIn && t < cur.start + cur.transIn.dur) {
      const prev = cl.find(c => Math.abs(clipEnd(c) - cur.start) < 1e-3);
      entry.trans = { type: cur.transIn.type, A: prev || null, B: cur, p: clamp((t - cur.start) / cur.transIn.dur, 0, 1) };
    } else if (cur?.transOut && t >= clipEnd(cur) - cur.transOut.dur) {
      entry.trans = { type: cur.transOut.type, A: cur, B: null, p: clamp(1 - (clipEnd(cur) - t) / cur.transOut.dur, 0, 1) };
    }
    if (cur) out.push(entry);
  }
  return out;
}

export function sourceSize(clip, media, s) {
  if (!media) return [s.width, s.height];
  if (media.type === 'title') { const c = titleCanvas(clip, 0); return [c.width, c.height]; }
  if (media.type === 'color' || media.type === 'adjustment') return [s.width, s.height];
  return [media.width || s.width, media.height || s.height];
}

function titleCanvas(clip, lt) {
  const fx = findFx(clip, 'text');
  return renderTitle(fx ? evalEffect(fx, lt) : EFFECTS.text.params.reduce((o, p) => (o[p.k] = p.def, o), {}));
}

/** Compute transform params for a visual clip at timeline time t. */
export function clipTransform(clip, t, s) {
  const media = mediaById(clip.mediaId);
  const lt = t - clip.start;
  const mfx = findFx(clip, 'motion');
  const mv = mfx ? evalEffect(mfx, lt) : { x: null, y: null, scale: 100, scaleW: 100, rotation: 0, ax: 0, ay: 0 };
  const [w, h] = sourceSize(clip, media, s);
  const fit = clip.fit && media && media.type !== 'title' ? Math.min(s.width / w, s.height / h) : 1;
  let flipX = 1, flipY = 1;
  let crop = { l: 0, t: 0, r: 0, b: 0 };
  for (const fx of clip.effects) {
    if (!fx.enabled) continue;
    if (fx.type === 'hflip') flipX = -1;
    if (fx.type === 'vflip') flipY = -1;
    if (fx.type === 'crop') { const v = evalEffect(fx, lt); crop = { l: v.left / 100, t: v.top / 100, r: v.right / 100, b: v.bottom / 100 }; }
  }
  return {
    x: mv.x ?? s.width / 2, y: mv.y ?? s.height / 2,
    sx: fit * (mv.scale / 100) * (mv.scaleW / 100) * flipX, sy: fit * (mv.scale / 100) * flipY,
    rot: (mv.rotation || 0) * Math.PI / 180, ax: mv.ax || 0, ay: mv.ay || 0, w, h, crop,
  };
}

/** Corner points of a clip's visible rect in sequence coords (for monitor overlays). */
export function clipCorners(clip, t, s) {
  const T = clipTransform(clip, t, s);
  const { w, h, crop } = T;
  const pts = [[-w / 2 + crop.l * w, -h / 2 + crop.t * h], [w / 2 - crop.r * w, -h / 2 + crop.t * h], [w / 2 - crop.r * w, h / 2 - crop.b * h], [-w / 2 + crop.l * w, h / 2 - crop.b * h]];
  const c = Math.cos(T.rot), sn = Math.sin(T.rot);
  return pts.map(([px, py]) => {
    px = (px - T.ax) * T.sx; py = (py - T.ay) * T.sy;
    return [T.x + px * c - py * sn, T.y + px * sn + py * c];
  });
}

function drawOffline(g, s, msg = 'Media Offline') {
  g.fillStyle = '#c0101a'; g.fillRect(0, 0, s.width, s.height);
  g.fillStyle = '#fff'; g.font = `bold ${Math.round(s.height / 14)}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(msg, s.width / 2, s.height / 2);
}

/** Draw a clip into its own full-frame layer canvas (seq coords at given scale). Returns {canvas, alpha, blend} or null. */
function drawLayer(main, clip, t, s, scale, layerName) {
  const media = mediaById(clip.mediaId);
  const W = main.width, H = main.height;
  const layer = scratch(layerName, W, H);
  const g = layer.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H); g.filter = 'none'; g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.setTransform(scale, 0, 0, scale, 0, 0);
  const lt = t - clip.start;
  let alpha = 1, blend = 'source-over';
  const filters = [];
  let shadow = null, post = [];
  for (const fx of clip.effects) {
    if (!fx.enabled) continue;
    const v = evalEffect(fx, lt);
    if (fx.type === 'opacity') { alpha = v.opacity / 100; blend = v.blend === 'normal' ? 'source-over' : v.blend; continue; }
    const f = cssFilterFor(fx.type, v, scale); if (f) filters.push(f);
    if (fx.type === 'dropShadow') shadow = v;
    if (fx.type === 'tint') filters.push(`grayscale(${v.amount / 100})`);
    if (fx.type === 'vignette' || fx.type === 'tint' || fx.type === 'mosaic') post.push([fx.type, v]);
  }
  if (!media || media.offline) { drawOffline(g, s); return { canvas: layer, alpha, blend }; }

  if (media.type === 'adjustment') {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.filter = filters.join(' ') || 'none';
    g.drawImage(main, 0, 0);
    g.filter = 'none';
    applyPost(g, post, W, H, null);
    return { canvas: layer, alpha, blend };
  }

  let src = null;
  if (media.type === 'video') {
    const el = elementFor(clip);
    if (!el || el.readyState < 2) return null;
    src = el;
  } else if (media.type === 'image') src = getRT(media.id).img;
  else if (media.type === 'title') src = titleCanvas(clip, lt);
  if (!src && media.type !== 'color') return null;

  const T = clipTransform(clip, t, s);
  g.translate(T.x, T.y); g.rotate(T.rot); g.scale(T.sx, T.sy); g.translate(-T.ax, -T.ay);
  g.filter = filters.join(' ') || 'none';
  if (shadow) {
    const a = shadow.direction * Math.PI / 180, d = shadow.distance * scale;
    const col = shadow.color, op = shadow.opacity / 100;
    g.shadowColor = hexA(col, op); g.shadowBlur = shadow.softness * scale;
    g.shadowOffsetX = Math.sin(a) * d; g.shadowOffsetY = -Math.cos(a) * d;
  }
  const { w, h, crop } = T;
  const sx0 = crop.l * w, sy0 = crop.t * h, sw = Math.max(0.5, w * (1 - crop.l - crop.r)), sh = Math.max(0.5, h * (1 - crop.t - crop.b));
  const dx = -w / 2 + sx0, dy = -h / 2 + sy0;
  const drawSrc = () => {
    if (media.type === 'color') { g.fillStyle = findFx(clip, 'colorMatte')?.params.color || '#000'; g.fillRect(dx, dy, sw, sh); }
    else {
      const nw = src.videoWidth || src.naturalWidth || src.width, nh = src.videoHeight || src.naturalHeight || src.height;
      const kx = nw / w, ky = nh / h;
      g.drawImage(src, sx0 * kx, sy0 * ky, sw * kx, sh * ky, dx, dy, sw, sh);
    }
  };
  drawSrc();
  g.shadowColor = 'transparent'; g.filter = 'none';
  if (post.length) applyPost(g, post, W, H, () => {
    g.save(); g.translate(T.x, T.y); g.rotate(T.rot); g.scale(T.sx, T.sy); g.translate(-T.ax, -T.ay); drawSrc(); g.restore();
  }, scale);
  return { canvas: layer, alpha, blend };
}

function applyPost(g, post, W, H, redrawMask, scale = 1) {
  for (const [type, v] of post) {
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    if (type === 'tint') {
      g.globalCompositeOperation = 'multiply'; g.globalAlpha = v.amount / 100; g.fillStyle = v.color; g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
      if (redrawMask) { g.globalCompositeOperation = 'destination-in'; g.setTransform(scale, 0, 0, scale, 0, 0); redrawMask(); }
    } else if (type === 'vignette') {
      g.globalCompositeOperation = 'source-atop';
      const r = Math.hypot(W, H) / 2;
      const grd = g.createRadialGradient(W / 2, H / 2, r * (v.size / 100) * 0.9, W / 2, H / 2, r);
      grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, `rgba(0,0,0,${v.amount / 100})`);
      g.fillStyle = grd; g.fillRect(0, 0, W, H);
    } else if (type === 'mosaic') {
      const bw = Math.max(1, Math.round(v.blocks)), bh = Math.max(1, Math.round(v.blocks * H / W));
      const tiny = scratch('mosaic', bw, bh); const tg = tiny.getContext('2d');
      tg.clearRect(0, 0, bw, bh); tg.imageSmoothingEnabled = true; tg.drawImage(g.canvas, 0, 0, bw, bh);
      g.globalCompositeOperation = 'copy'; g.imageSmoothingEnabled = false; g.drawImage(tiny, 0, 0, W, H); g.imageSmoothingEnabled = true;
    }
    g.restore();
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function composite(g, L, s, scale, mods = {}) {
  if (!L) return;
  const W = g.canvas.width, H = g.canvas.height;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = clamp(L.alpha * (mods.alpha ?? 1), 0, 1);
  g.globalCompositeOperation = L.blend;
  if (mods.clip) { g.beginPath(); mods.clip(g, W, H); g.clip(); }
  if (mods.dx || mods.zoom) {
    const z = mods.zoom || 1;
    g.translate(W / 2 + (mods.dx || 0) * W, H / 2); g.scale(z, z); g.translate(-W / 2, -H / 2);
  }
  g.drawImage(L.canvas, 0, 0);
  g.restore();
}

function fillBlack(g, a) {
  if (a <= 0) return;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = clamp(a, 0, 1); g.fillStyle = '#000'; g.fillRect(0, 0, g.canvas.width, g.canvas.height); g.restore();
}
function fillWhite(g, a) {
  if (a <= 0) return;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = clamp(a, 0, 1); g.fillStyle = '#fff'; g.fillRect(0, 0, g.canvas.width, g.canvas.height); g.restore();
}

function drawTransition(g, tr, t, s, scale) {
  const { type, A, B, p } = tr;
  const la = A ? drawLayer(g.canvas, A, t, s, scale, 'layerA') : null;
  const lb = B ? drawLayer(g.canvas, B, t, s, scale, 'layerB') : null;
  switch (type) {
    case 'dipToBlack': case 'dipToWhite': {
      const dip = type === 'dipToBlack' ? fillBlack : fillWhite;
      if (p < 0.5) { composite(g, la, s, scale); dip(g, A ? p * 2 : 1); }
      else { composite(g, lb, s, scale); dip(g, B ? (1 - p) * 2 : 1); }
      break;
    }
    case 'wipe':
      composite(g, la, s, scale, B ? {} : { clip: (c, W, H) => c.rect(p * W, 0, W, H) });
      if (lb) composite(g, lb, s, scale, { clip: (c, W, H) => c.rect(0, 0, p * W, H) });
      break;
    case 'barnDoors':
      composite(g, la, s, scale, B ? {} : { clip: (c, W, H) => { c.rect(0, 0, W / 2 * (1 - p), H); c.rect(W / 2 * (1 + p), 0, W, H); } });
      if (lb) composite(g, lb, s, scale, { clip: (c, W, H) => c.rect(W / 2 * (1 - p), 0, W * p, H) });
      break;
    case 'iris':
      composite(g, la, s, scale, B ? {} : { clip: (c, W, H) => c.arc(W / 2, H / 2, Math.hypot(W, H) / 2 * (1 - p), 0, Math.PI * 2) });
      if (lb) composite(g, lb, s, scale, { clip: (c, W, H) => c.arc(W / 2, H / 2, Math.max(0.1, Math.hypot(W, H) / 2 * p), 0, Math.PI * 2) });
      break;
    case 'push':
      composite(g, la, s, scale, { dx: -p });
      composite(g, lb, s, scale, { dx: 1 - p });
      break;
    case 'slide':
      composite(g, la, s, scale, B ? {} : { dx: -p });
      composite(g, lb, s, scale, { dx: 1 - p });
      break;
    case 'zoom':
      composite(g, la, s, scale, { zoom: 1 + 2 * p, alpha: 1 - p });
      composite(g, lb, s, scale, { zoom: 3 - 2 * p, alpha: p });
      break;
    case 'filmDissolve': {
      const q = p * p * (3 - 2 * p);
      if (la) composite(g, la, s, scale, { alpha: B ? 1 : 1 - q });
      if (lb) composite(g, lb, s, scale, { alpha: q });
      break;
    }
    default: // crossDissolve
      if (la) composite(g, la, s, scale, { alpha: B ? 1 : 1 - p });
      if (lb) composite(g, lb, s, scale, { alpha: p });
  }
}

/** Render sequence s at time t into canvas (sized to s.width*scale x s.height*scale). */
export function renderFrame(canvas, s, t, scale = 1) {
  const W = Math.max(1, Math.round(s.width * scale)), H = Math.max(1, Math.round(s.height * scale));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const g = canvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none';
  g.fillStyle = s.bg || '#000'; g.fillRect(0, 0, W, H);
  for (const entry of visibleVideo(s, t)) {
    if (entry.trans) drawTransition(g, entry.trans, t, s, scale);
    else composite(g, drawLayer(canvas, entry.clip, t, s, scale, 'layer'), s, scale);
  }
  return canvas;
}
