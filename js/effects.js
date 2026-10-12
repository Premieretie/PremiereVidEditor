// Effect registry, parameter evaluation and keyframe interpolation.
import { uid, clamp, lerp } from './util.js';

/*
 Param types: number (animatable), select, color, bool, text.
 Each effect instance on a clip: { id, type, enabled, params:{k:v}, kf:{k:[{t,v,ease}]} }
 kf times are clip-local seconds (0 = clip start on timeline).
*/

const blendModes = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];

export const EFFECTS = {
  // ---------- intrinsic video ----------
  motion: {
    name: 'Motion', kind: 'video', fixed: true, icon: 'fx',
    params: [
      { k: 'x', label: 'Position X', type: 'number', def: null, step: 1, unit: 'px', seqX: true },
      { k: 'y', label: 'Position Y', type: 'number', def: null, step: 1, unit: 'px', seqY: true },
      { k: 'scale', label: 'Scale', type: 'number', def: 100, min: 0, max: 1000, step: 0.5, unit: '%' },
      { k: 'scaleW', label: 'Scale Width', type: 'number', def: 100, min: 0, max: 1000, step: 0.5, unit: '%' },
      { k: 'rotation', label: 'Rotation', type: 'number', def: 0, min: -3600, max: 3600, step: 0.5, unit: '°' },
      { k: 'ax', label: 'Anchor X', type: 'number', def: 0, step: 1, unit: 'px' },
      { k: 'ay', label: 'Anchor Y', type: 'number', def: 0, step: 1, unit: 'px' },
    ],
  },
  opacity: {
    name: 'Opacity', kind: 'video', fixed: true,
    params: [
      { k: 'opacity', label: 'Opacity', type: 'number', def: 100, min: 0, max: 100, step: 0.5, unit: '%' },
      { k: 'blend', label: 'Blend Mode', type: 'select', def: 'normal', options: blendModes },
    ],
  },
  // ---------- intrinsic audio ----------
  volume: {
    name: 'Volume', kind: 'audio', fixed: true,
    params: [{ k: 'level', label: 'Level', type: 'number', def: 0, min: -60, max: 15, step: 0.1, unit: 'dB' }],
  },
  panner: {
    name: 'Panner', kind: 'audio', fixed: true,
    params: [{ k: 'balance', label: 'Balance', type: 'number', def: 0, min: -100, max: 100, step: 1 }],
  },
  // ---------- text (fixed on title clips) ----------
  text: {
    name: 'Text', kind: 'video', fixed: true, hidden: true,
    params: [
      { k: 'text', label: 'Text', type: 'text', def: 'Your Title' },
      { k: 'font', label: 'Font', type: 'select', def: 'Arial', options: ['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS', 'Impact', 'Comic Sans MS', 'system-ui', 'serif', 'sans-serif', 'monospace'] },
      { k: 'size', label: 'Font Size', type: 'number', def: 100, min: 4, max: 800, step: 1, unit: 'px' },
      { k: 'weight', label: 'Weight', type: 'select', def: 'bold', options: ['normal', 'bold', '300', '600', '900'] },
      { k: 'italic', label: 'Italic', type: 'bool', def: false },
      { k: 'align', label: 'Align', type: 'select', def: 'center', options: ['left', 'center', 'right'] },
      { k: 'fill', label: 'Fill', type: 'color', def: '#ffffff' },
      { k: 'tracking', label: 'Tracking', type: 'number', def: 0, min: -50, max: 200, step: 1, unit: 'px' },
      { k: 'leading', label: 'Leading', type: 'number', def: 120, min: 50, max: 300, step: 1, unit: '%' },
      { k: 'strokeW', label: 'Stroke Width', type: 'number', def: 0, min: 0, max: 60, step: 0.5, unit: 'px' },
      { k: 'stroke', label: 'Stroke', type: 'color', def: '#000000' },
      { k: 'shadow', label: 'Shadow', type: 'number', def: 0, min: 0, max: 100, step: 1, unit: 'px' },
      { k: 'bg', label: 'Background', type: 'bool', def: false },
      { k: 'bgColor', label: 'Background Color', type: 'color', def: '#000000' },
      { k: 'bgOpacity', label: 'Background Opacity', type: 'number', def: 60, min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
  colorMatte: {
    name: 'Color', kind: 'video', fixed: true, hidden: true,
    params: [{ k: 'color', label: 'Color', type: 'color', def: '#1a3a6b' }],
  },

  // ---------- video effects (Effects panel) ----------
  lumetri: {
    name: 'Lumetri Color (Basic)', kind: 'video', category: 'Color Correction',
    params: [
      { k: 'exposure', label: 'Exposure', type: 'number', def: 0, min: -4, max: 4, step: 0.05 },
      { k: 'contrast', label: 'Contrast', type: 'number', def: 0, min: -100, max: 100, step: 1 },
      { k: 'saturation', label: 'Saturation', type: 'number', def: 100, min: 0, max: 200, step: 1 },
      { k: 'temperature', label: 'Temperature', type: 'number', def: 0, min: -100, max: 100, step: 1 },
      { k: 'tint', label: 'Tint', type: 'number', def: 0, min: -100, max: 100, step: 1 },
      { k: 'hue', label: 'Hue Shift', type: 'number', def: 0, min: -180, max: 180, step: 1, unit: '°' },
    ],
  },
  brightnessContrast: {
    name: 'Brightness & Contrast', kind: 'video', category: 'Color Correction',
    params: [
      { k: 'brightness', label: 'Brightness', type: 'number', def: 0, min: -100, max: 100, step: 1 },
      { k: 'contrast', label: 'Contrast', type: 'number', def: 0, min: -100, max: 100, step: 1 },
    ],
  },
  blackWhite: { name: 'Black & White', kind: 'video', category: 'Image Control', params: [{ k: 'amount', label: 'Amount', type: 'number', def: 100, min: 0, max: 100, step: 1, unit: '%' }] },
  sepia: { name: 'Sepia', kind: 'video', category: 'Image Control', params: [{ k: 'amount', label: 'Amount', type: 'number', def: 100, min: 0, max: 100, step: 1, unit: '%' }] },
  invert: { name: 'Invert', kind: 'video', category: 'Channel', params: [{ k: 'amount', label: 'Amount', type: 'number', def: 100, min: 0, max: 100, step: 1, unit: '%' }] },
  gaussianBlur: { name: 'Gaussian Blur', kind: 'video', category: 'Blur & Sharpen', params: [{ k: 'blur', label: 'Blurriness', type: 'number', def: 10, min: 0, max: 200, step: 0.5 }] },
  dropShadow: {
    name: 'Drop Shadow', kind: 'video', category: 'Perspective',
    params: [
      { k: 'color', label: 'Shadow Color', type: 'color', def: '#000000' },
      { k: 'opacity', label: 'Opacity', type: 'number', def: 50, min: 0, max: 100, step: 1, unit: '%' },
      { k: 'distance', label: 'Distance', type: 'number', def: 10, min: 0, max: 500, step: 1 },
      { k: 'direction', label: 'Direction', type: 'number', def: 135, min: -360, max: 360, step: 1, unit: '°' },
      { k: 'softness', label: 'Softness', type: 'number', def: 10, min: 0, max: 200, step: 1 },
    ],
  },
  crop: {
    name: 'Crop', kind: 'video', category: 'Transform',
    params: [
      { k: 'left', label: 'Left', type: 'number', def: 0, min: 0, max: 100, step: 0.5, unit: '%' },
      { k: 'top', label: 'Top', type: 'number', def: 0, min: 0, max: 100, step: 0.5, unit: '%' },
      { k: 'right', label: 'Right', type: 'number', def: 0, min: 0, max: 100, step: 0.5, unit: '%' },
      { k: 'bottom', label: 'Bottom', type: 'number', def: 0, min: 0, max: 100, step: 0.5, unit: '%' },
    ],
  },
  hflip: { name: 'Horizontal Flip', kind: 'video', category: 'Transform', params: [] },
  vflip: { name: 'Vertical Flip', kind: 'video', category: 'Transform', params: [] },
  vignette: {
    name: 'Vignette', kind: 'video', category: 'Stylize',
    params: [
      { k: 'amount', label: 'Amount', type: 'number', def: 60, min: 0, max: 100, step: 1, unit: '%' },
      { k: 'size', label: 'Midpoint', type: 'number', def: 50, min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
  tint: {
    name: 'Tint', kind: 'video', category: 'Color Correction',
    params: [
      { k: 'color', label: 'Map White To', type: 'color', def: '#ffb35c' },
      { k: 'amount', label: 'Amount to Tint', type: 'number', def: 50, min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
  mosaic: {
    name: 'Mosaic', kind: 'video', category: 'Stylize',
    params: [{ k: 'blocks', label: 'Blocks', type: 'number', def: 40, min: 2, max: 400, step: 1 }],
  },

  // ---------- audio effects ----------
  bass: { name: 'Bass', kind: 'audio', category: 'Filter and EQ', params: [{ k: 'boost', label: 'Boost', type: 'number', def: 6, min: -24, max: 24, step: 0.5, unit: 'dB' }] },
  treble: { name: 'Treble', kind: 'audio', category: 'Filter and EQ', params: [{ k: 'boost', label: 'Boost', type: 'number', def: 6, min: -24, max: 24, step: 0.5, unit: 'dB' }] },
  lowpass: { name: 'Lowpass', kind: 'audio', category: 'Filter and EQ', params: [{ k: 'freq', label: 'Cutoff', type: 'number', def: 2000, min: 20, max: 20000, step: 10, unit: 'Hz' }] },
  highpass: { name: 'Highpass', kind: 'audio', category: 'Filter and EQ', params: [{ k: 'freq', label: 'Cutoff', type: 'number', def: 200, min: 20, max: 20000, step: 10, unit: 'Hz' }] },
  amplify: { name: 'Amplify', kind: 'audio', category: 'Amplitude', params: [{ k: 'gain', label: 'Gain', type: 'number', def: 6, min: -48, max: 48, step: 0.5, unit: 'dB' }] },
};

export const TRANSITIONS = {
  crossDissolve: { name: 'Cross Dissolve', kind: 'video', category: 'Dissolve' },
  dipToBlack: { name: 'Dip to Black', kind: 'video', category: 'Dissolve' },
  dipToWhite: { name: 'Dip to White', kind: 'video', category: 'Dissolve' },
  filmDissolve: { name: 'Film Dissolve', kind: 'video', category: 'Dissolve' },
  wipe: { name: 'Wipe', kind: 'video', category: 'Wipe' },
  barnDoors: { name: 'Barn Doors', kind: 'video', category: 'Wipe' },
  iris: { name: 'Iris Round', kind: 'video', category: 'Iris' },
  push: { name: 'Push', kind: 'video', category: 'Slide' },
  slide: { name: 'Slide', kind: 'video', category: 'Slide' },
  zoom: { name: 'Cross Zoom', kind: 'video', category: 'Zoom' },
  constantPower: { name: 'Constant Power', kind: 'audio', category: 'Crossfade' },
  constantGain: { name: 'Constant Gain', kind: 'audio', category: 'Crossfade' },
  exponentialFade: { name: 'Exponential Fade', kind: 'audio', category: 'Crossfade' },
};

export function makeEffect(type, overrides = {}) {
  const def = EFFECTS[type];
  const params = {};
  for (const p of def.params) params[p.k] = p.def;
  Object.assign(params, overrides);
  return { id: uid('fx'), type, enabled: true, params, kf: {} };
}

export function defaultEffectsFor(clipType, mediaType) {
  if (clipType === 'audio') return [makeEffect('volume'), makeEffect('panner')];
  const list = [makeEffect('motion'), makeEffect('opacity')];
  if (mediaType === 'title') list.unshift(makeEffect('text'));
  if (mediaType === 'color') list.unshift(makeEffect('colorMatte'));
  return list;
}

export function paramDef(type, k) { return EFFECTS[type]?.params.find(p => p.k === k); }

/** Evaluate an animatable parameter at clip-local time t. */
export function evalParam(fx, k, t) {
  const kfs = fx.kf?.[k];
  if (!kfs || !kfs.length) return fx.params[k];
  if (t <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      if (typeof a.v !== 'number') return a.v;
      let u = (t - a.t) / Math.max(1e-9, b.t - a.t);
      if (a.ease === 'hold') return a.v;
      if (a.ease === 'ease') u = u * u * (3 - 2 * u);
      return lerp(a.v, b.v, u);
    }
  }
  return fx.params[k];
}

/** Set a param value; if animated, create/update keyframe at t. */
export function setParam(fx, k, v, t) {
  const kfs = fx.kf?.[k];
  if (kfs && kfs.length) {
    const tol = 1 / 120;
    const ex = kfs.find(f => Math.abs(f.t - t) < tol);
    if (ex) ex.v = v; else { kfs.push({ t, v, ease: 'linear' }); kfs.sort((a, b) => a.t - b.t); }
  } else fx.params[k] = v;
}

export function toggleAnimation(fx, k, t) {
  fx.kf ||= {};
  if (fx.kf[k]?.length) { fx.params[k] = evalParam(fx, k, t); delete fx.kf[k]; }
  else fx.kf[k] = [{ t, v: fx.params[k], ease: 'linear' }];
}

/** Values for all params of an effect at time t. */
export function evalEffect(fx, t) {
  const out = {};
  for (const p of EFFECTS[fx.type].params) out[p.k] = p.type === 'number' ? evalParam(fx, p.k, t) : fx.params[p.k];
  return out;
}

export function findFx(clip, type) { return clip.effects?.find(e => e.type === type); }

/** Convert lumetri-ish params into a CSS filter string chunk */
export function cssFilterFor(fxType, v, scale = 1) {
  switch (fxType) {
    case 'lumetri': {
      const parts = [];
      if (v.exposure) parts.push(`brightness(${Math.pow(2, v.exposure).toFixed(3)})`);
      if (v.contrast) parts.push(`contrast(${(1 + v.contrast / 100).toFixed(3)})`);
      if (v.saturation !== 100) parts.push(`saturate(${(v.saturation / 100).toFixed(3)})`);
      if (v.temperature) parts.push(v.temperature > 0 ? `sepia(${(v.temperature / 300).toFixed(3)})` : `hue-rotate(${(v.temperature / 10).toFixed(2)}deg) saturate(${(1 + v.temperature / 400).toFixed(3)})`);
      if (v.tint) parts.push(`hue-rotate(${(v.tint / 8).toFixed(2)}deg)`);
      if (v.hue) parts.push(`hue-rotate(${v.hue}deg)`);
      return parts.join(' ');
    }
    case 'brightnessContrast': return `brightness(${(1 + v.brightness / 100).toFixed(3)}) contrast(${(1 + v.contrast / 100).toFixed(3)})`;
    case 'blackWhite': return `grayscale(${v.amount / 100})`;
    case 'sepia': return `sepia(${v.amount / 100})`;
    case 'invert': return `invert(${v.amount / 100})`;
    case 'gaussianBlur': return v.blur > 0 ? `blur(${(v.blur * scale / 2).toFixed(2)}px)` : '';
    default: return '';
  }
}

export function transitionProgressCurve(type, p) {
  if (type === 'constantPower') return Math.sin(p * Math.PI / 2);
  if (type === 'exponentialFade') return p * p;
  return p;
}

export function cloneEffects(effects) {
  return effects.map(e => ({ ...JSON.parse(JSON.stringify(e)), id: uid('fx') }));
}

export { clamp };
