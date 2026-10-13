// Tool definitions for the in-editor Claude assistant (Anthropic Messages API tool schemas).
// Each tool maps onto a method in bridge.js (the same methods the MCP server forwards to).

const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = description => ({ type: 'boolean', description });
const track = str('Track name like "V1", "V2" (video, V1 is the bottom layer) or "A1", "A2" (audio)');
const time = d => num(d, { minimum: 0 });
const keyframes = {
  type: 'object',
  description: 'Keyframes per parameter, e.g. {"opacity": [{"time": 0, "value": 0}, {"time": 1, "value": 100}]}. Times are seconds from the clip start. An empty list removes the animation.',
  additionalProperties: {
    type: 'array',
    items: { type: 'object', properties: { time: num('Seconds from clip start', { minimum: 0 }), value: { type: 'number' }, ease: { type: 'string', enum: ['linear', 'ease', 'hold'] } }, required: ['time', 'value'] },
  },
};

function tool(name, description, properties = {}, required = []) {
  return { name, description, eager_input_streaming: true, input_schema: { type: 'object', properties, required } };
}

export const TOOLS = [
  tool('get_state', 'Get the open project: media library, active sequence (size, fps, tracks, markers, in/out, playhead) and every clip with id, track, timing, effects and transitions. Call this before editing and whenever ids may have changed.',
    { include_effects: bool('Include effect parameters for each clip (default true)') }),
  tool('list_effects', 'List available video/audio effects with parameter names, ranges and defaults, plus transitions and label colors.'),
  tool('add_clip', 'Place a media item on the timeline (overwrite or insert edit). Video with sound creates linked video and audio clips. Returns the new clip ids.', {
    media_id: str('Media id from get_state'), start: time('Timeline time in seconds (default: playhead)'),
    track: { ...track, description: 'Destination track. For video media, the video track; for audio media, the audio track.' },
    audio_track: { ...track, description: 'Destination audio track for the sound of a video file' },
    mode: { type: 'string', enum: ['overwrite', 'insert'], description: 'overwrite replaces what is there; insert pushes later clips right' },
    source_in: time('Start point inside the source media (seconds)'), source_out: time('End point inside the source media (seconds)'),
    duration: num('Clip length in seconds (handy for images, titles, mattes)', { exclusiveMinimum: 0 }),
    video: bool('Include the video part (default true)'), audio: bool('Include the audio part (default true)'),
  }, ['media_id']),
  tool('move_clip', 'Move a clip (and its linked partner) to a new start time and/or track. Overwrites whatever it lands on.',
    { clip_id: str('Clip id'), start: time('New start time'), track, include_linked: bool('Move linked clips too (default true)') }, ['clip_id']),
  tool('trim_clip', 'Trim a clip\'s start and/or end to new timeline times. ripple=true shifts the following clips to close or open the gap.',
    { clip_id: str('Clip id'), new_start: time('New start time on the timeline'), new_end: time('New end time on the timeline'), ripple: bool('Ripple the change'), include_linked: bool('Trim linked clips too (default true)') }, ['clip_id']),
  tool('split_clip', 'Razor cut at a time. Give clip_id to cut one clip (and its linked partner), or all_tracks=true to cut everything at that time.',
    { time: time('Cut time in seconds'), clip_id: str('Clip to cut'), all_tracks: bool('Cut every track') }, ['time']),
  tool('delete_clips', 'Delete clips. ripple=true closes the resulting gap (Ripple Delete).',
    { clip_ids: { type: 'array', items: { type: 'string' }, minItems: 1 }, ripple: bool('Close the gap'), include_linked: bool('Also delete linked partners (default false)') }, ['clip_ids']),
  tool('close_gap', 'Ripple-delete the empty gap at a time on a track.', { track, time: time('A time inside the gap') }, ['track', 'time']),
  tool('set_clip', 'Change clip properties: name, enabled, speed (1 = 100%, 2 = double speed, 0.5 = slow motion), label (color name from list_effects), scale_to_frame.',
    { clip_id: str('Clip id'), name: str('New name'), enabled: bool('Enable or disable'), speed: num('Playback speed multiplier', { exclusiveMinimum: 0 }), label: str('Label color name'), scale_to_frame: bool('Fit media to the frame'), include_linked: bool('Apply to linked clips too (default true)') }, ['clip_id']),
  tool('add_effect', 'Add an effect from list_effects to a clip (e.g. gaussianBlur, lumetri, crop, vignette, blackWhite, bass). Optional initial params and keyframes.',
    { clip_id: str('Clip id'), effect: str('Effect type'), params: { type: 'object', description: 'Parameter values by name' }, keyframes }, ['clip_id', 'effect']),
  tool('set_effect', 'Change an effect on a clip, including the built-in ones: "motion" (x, y in sequence pixels, scale, scaleW, rotation, ax, ay), "opacity" (opacity 0-100, blend), "volume" (level in dB), "panner" (balance -100..100), "text" on titles (text, font, size, fill, strokeW, stroke, bg, bgColor, ...), "colorMatte" (color). Identify the effect by type or id. Use keyframes to animate.',
    { clip_id: str('Clip id'), effect: str('Effect type or effect id'), params: { type: 'object', description: 'Parameter values by name' }, keyframes, time: time('Clip-relative time used when setting a parameter that is already animated'), enabled: bool('Turn the effect on or off'), reset: bool('Reset to defaults first') }, ['clip_id', 'effect']),
  tool('remove_effect', 'Remove an added effect from a clip.', { clip_id: str('Clip id'), effect: str('Effect type or id') }, ['clip_id', 'effect']),
  tool('set_transition', 'Put a transition on the start ("in") or end ("out") of a clip, or remove it with type null. At a cut, an "in" transition on the second clip blends from the clip before it.',
    { clip_id: str('Clip id'), edge: { type: 'string', enum: ['in', 'out'] }, type: { type: ['string', 'null'], description: 'e.g. crossDissolve, dipToBlack, wipe, push, constantPower; null removes' }, duration: num('Seconds (default 1)', { exclusiveMinimum: 0 }) }, ['clip_id', 'edge', 'type']),
  tool('add_title', 'Add a text title on a video track. x/y is the text centre in sequence pixels (default: lower third, centred).', {
    text: str('Title text; use \\n for line breaks'), start: time('Start time'), duration: num('Seconds (default 5)', { exclusiveMinimum: 0 }), track,
    x: { type: 'number' }, y: { type: 'number' }, font: str('Font family, e.g. Arial, Georgia, Impact'), size: num('Font size in pixels'), weight: str('normal, bold, 300, 600, 900'),
    italic: bool('Italic'), align: { type: 'string', enum: ['left', 'center', 'right'] }, color: str('#rrggbb'), stroke_width: { type: 'number' }, stroke_color: str('#rrggbb'),
    shadow: num('Shadow blur in pixels'), background: bool('Draw a box behind the text'), background_color: str('#rrggbb'), background_opacity: num('0-100'),
    tracking: { type: 'number' }, leading: num('Line spacing in percent'),
  }, ['text']),
  tool('add_generated', 'Add a color matte (type "color") or an adjustment layer (type "adjustment"; effects on it apply to everything below).',
    { type: { type: 'string', enum: ['color', 'adjustment'] }, start: time('Start time'), duration: num('Seconds', { exclusiveMinimum: 0 }), track, color: str('#rrggbb'), name: str('Name') }, ['type']),
  tool('add_marker', 'Add a sequence marker.', { time: time('Marker time'), name: str('Label'), color: str('#rrggbb') }),
  tool('remove_marker', 'Remove a sequence marker by id.', { marker_id: str('Marker id') }, ['marker_id']),
  tool('set_in_out', 'Set or clear (null) the sequence In and Out points.', { in_point: { type: ['number', 'null'] }, out_point: { type: ['number', 'null'] } }),
  tool('add_track', 'Add a video or audio track.', { kind: { type: 'string', enum: ['video', 'audio'] } }, ['kind']),
  tool('set_track', 'Change track settings: name, locked, targeted; video: hidden; audio: muted, solo, volume_db, pan (-100..100).',
    { track, name: str('Name'), muted: bool('Mute'), solo: bool('Solo'), locked: bool('Lock'), hidden: bool('Hide video track'), volume_db: num('Track volume in dB'), pan: num('Pan -100..100'), targeted: bool('Target for edits') }, ['track']),
  tool('delete_track', 'Delete a track and its clips.', { track }, ['track']),
  tool('set_master_volume', 'Set the master output volume in dB.', { volume_db: { type: 'number' } }, ['volume_db']),
  tool('create_sequence', 'Create a new sequence (e.g. 1920x1080, 1080x1920 vertical, 3840x2160) and optionally make it active.',
    { name: str('Name'), width: { type: 'integer', minimum: 16 }, height: { type: 'integer', minimum: 16 }, fps: num('Frame rate', { exclusiveMinimum: 0 }), activate: bool('Switch to it (default true)') }),
  tool('set_sequence', 'Switch the active sequence (by id or name) and/or change its name, size, fps or background color.',
    { sequence_id: str('Sequence id or name'), name: str('Name'), width: { type: 'integer', minimum: 16 }, height: { type: 'integer', minimum: 16 }, fps: { type: 'number' }, background: str('#rrggbb') }),
  tool('select_clips', 'Select clips in the editor so the user sees them highlighted and in Effect Controls.', { clip_ids: { type: 'array', items: { type: 'string' } } }, ['clip_ids']),
  tool('seek', 'Move the playhead.', { time: time('Seconds') }, ['time']),
  tool('undo', 'Undo the last edit.'),
  tool('redo', 'Redo the last undone edit.'),
  tool('render_frame', 'Render the sequence at a time and return it as an image so you can see the result. Use it to check visual changes.',
    { time: time('Default: playhead'), max_width: { type: 'integer', minimum: 64, maximum: 1920, description: 'Default 768' } }),
  tool('export_video', 'Render the sequence and download it to the user\'s computer. Only do this when the user asks to export. Formats: mp4 (H.264, Chrome/Edge), webm (VP9), wav (audio only).', {
    format: { type: 'string', enum: ['mp4', 'webm', 'wav', 'realtime'] }, name: str('File name without extension'), start: time('Range start'), end: time('Range end'),
    range: { type: 'string', enum: ['all', 'io'], description: 'io = use the sequence In/Out points' }, size: { type: 'string', enum: ['match', '2160', '1080', '720', '480'] },
    bitrate_mbps: num('Target bitrate', { exclusiveMinimum: 0 }), audio: bool('Include audio (default true)'),
  }),
];

/** Minimal validation of a tool input against its schema (types of top-level fields and required keys). */
export function validateInput(def, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be a JSON object';
  const { properties = {}, required = [] } = def.input_schema;
  for (const k of required) if (input[k] === undefined) return `missing required field "${k}"`;
  for (const [k, v] of Object.entries(input)) {
    const p = properties[k];
    if (!p || v === undefined) continue;
    const types = [].concat(p.type || []);
    const actual = v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
    const ok = !types.length || types.some(t => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) return `field "${k}" should be ${types.join(' or ')}, got ${actual}`;
    if (p.enum && !p.enum.includes(v)) return `field "${k}" must be one of ${p.enum.join(', ')}`;
  }
  return null;
}
