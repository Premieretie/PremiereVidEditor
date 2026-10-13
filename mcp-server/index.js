#!/usr/bin/env node
// Premiere Web MCP server.
// Claude talks to this process over stdio (MCP). The editor running in your browser connects to it
// over a localhost WebSocket, and each tool call is forwarded to the live editor.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const PORT = parseInt(process.env.PREMIERE_WEB_PORT || '7811', 10);
// Pages allowed to connect. Add your own GitHub Pages origin with PREMIERE_WEB_ORIGINS="https://you.github.io".
const ALLOWED = (process.env.PREMIERE_WEB_ORIGINS || 'https://premieretie.github.io').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const log = (...a) => console.error('[premiere-web]', ...a); // stdout is reserved for MCP

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp' };

// ---------------- WebSocket bridge ----------------
let editor = null; // most recently connected editor tab
let bridgeError = null;
let nextId = 1;
const pending = new Map();

function originAllowed(origin) {
  if (!origin) return true; // non-browser clients (e.g. tests) send no Origin
  const o = origin.toLowerCase();
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o)) return true;
  return ALLOWED.includes(o);
}

const wss = new WebSocketServer({
  host: '127.0.0.1', port: PORT, maxPayload: 2 * 1024 * 1024 * 1024,
  verifyClient: ({ origin }) => { const ok = originAllowed(origin); if (!ok) log(`Rejected connection from origin ${origin}. Set PREMIERE_WEB_ORIGINS to allow it.`); return ok; },
});
wss.on('listening', () => log(`Bridge listening on ws://127.0.0.1:${PORT} (allowed origins: localhost, ${ALLOWED.join(', ')})`));
wss.on('error', e => { bridgeError = e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (is another Premiere Web MCP server running?). Set PREMIERE_WEB_PORT to use a different port, and change the port in the editor's Claude panel to match.` : e.message; log(bridgeError); });
wss.on('connection', (sock, req) => {
  log('Editor connected from', req.headers.origin || 'unknown origin');
  if (editor && editor !== sock) editor.close(1000, 'Another editor tab connected');
  editor = sock;
  sock.isAlive = true;
  sock.on('pong', () => sock.isAlive = true);
  sock.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'hello') { sock.info = msg; return; }
    const p = pending.get(msg.id); if (!p) return;
    pending.delete(msg.id); clearTimeout(p.timer);
    msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
  });
  sock.on('close', () => {
    if (editor === sock) editor = null;
    for (const [id, p] of pending) if (p.sock === sock) { pending.delete(id); clearTimeout(p.timer); p.reject(new Error('The editor tab disconnected')); }
    log('Editor disconnected');
  });
});
setInterval(() => { for (const c of wss.clients) { if (!c.isAlive) { c.terminate(); continue; } c.isAlive = false; c.ping(); } }, 15000).unref();

function call(method, params = {}, timeoutMs = 60000) {
  if (bridgeError) return Promise.reject(new Error(bridgeError));
  if (!editor || editor.readyState !== 1) {
    return Promise.reject(new Error(`The Premiere Web editor is not connected. Ask the user to open the editor in their browser and click "Connect Claude" in the top-right corner (bridge port ${PORT}).`));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out waiting for the editor (${method})`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer, sock: editor });
    editor.send(JSON.stringify({ id, method, params }));
  });
}

// ---------------- MCP tools ----------------
const server = new McpServer({ name: 'premiere-web', version: '1.0.0' }, {
  instructions: [
    'These tools drive Premiere Web, a Premiere Pro-style video editor open in the user\'s browser. Edits happen live in their project and each one can be undone (undo tool or Ctrl+Z).',
    'Start with get_state to see media, tracks and clips (with ids). Times are in seconds. Tracks are "V1", "V2"... (video, V1 is the bottom layer) and "A1", "A2"... (audio).',
    'Video files with sound create linked video+audio clips; most clip tools act on the linked partner too unless include_linked is false.',
    'Effect keyframe times are relative to the clip start. Use list_effects for effect/transition types and parameter names.',
    'Use render_frame to look at the result before and after visual changes. Export with export_video, which saves the file on the user\'s computer.',
  ].join('\n'),
});

const json = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = e => ({ isError: true, content: [{ type: 'text', text: e.message || String(e) }] });
function tool(name, description, shape, handler, annotations = {}) {
  server.registerTool(name, { description, inputSchema: shape, annotations }, async args => {
    try { return await handler(args || {}); } catch (e) { return fail(e); }
  });
}
const forward = (method, timeout) => async args => json(await call(method, args, timeout));

const track = z.string().describe('Track name like "V1", "V2", "A1"');
const sec = z.number().min(0);

tool('get_state', 'Get the open project: media library, active sequence (size, fps, tracks, markers, in/out, playhead) and every clip with its id, track, timing, effects and transitions.',
  { include_effects: z.boolean().optional().describe('Include effect parameters for each clip (default true)') }, forward('get_state'), { readOnlyHint: true });

tool('list_effects', 'List available video/audio effects (with parameter names, ranges and defaults), transitions and label colors.', {}, forward('list_effects'), { readOnlyHint: true });

tool('import_media', 'Import a video, audio or image file into the project from a path on this computer or an http(s) URL.',
  { path: z.string().optional().describe('Absolute or ~ path to a local file'), url: z.string().url().optional().describe('http(s) URL to download'), name: z.string().optional().describe('Name to show in the Project panel') },
  async ({ path: p, url, name }) => {
    if (!p && !url) throw new Error('Provide path or url');
    let bytes, fname, mime;
    if (p) {
      const full = path.resolve(p.replace(/^~(?=$|\/|\\)/, os.homedir()));
      bytes = await fs.readFile(full); fname = name || path.basename(full); mime = MIME[path.extname(full).toLowerCase()] || '';
    } else {
      const r = await fetch(url); if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
      bytes = Buffer.from(await r.arrayBuffer()); mime = r.headers.get('content-type')?.split(';')[0] || '';
      fname = name || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
      if (!path.extname(fname)) { const ext = Object.entries(MIME).find(([, m]) => m === mime)?.[0]; if (ext) fname += ext; }
    }
    return json(await call('import_media', { name: fname, mime, data_base64: bytes.toString('base64') }, 10 * 60 * 1000));
  });

tool('add_clip', 'Place a media item on the timeline (overwrite or insert edit). Video with sound creates linked video and audio clips. Returns the new clip ids.',
  {
    media_id: z.string(), start: sec.optional().describe('Timeline time in seconds (default: playhead)'),
    track: track.optional().describe('Destination track. For video media this is the video track; for audio media, the audio track.'),
    audio_track: track.optional().describe('Destination audio track for the sound of a video file'),
    mode: z.enum(['overwrite', 'insert']).optional().describe('overwrite replaces what is there; insert pushes later clips right'),
    source_in: sec.optional().describe('Start point inside the source media'), source_out: sec.optional().describe('End point inside the source media'),
    duration: z.number().positive().optional().describe('Clip length (handy for images, titles, mattes)'),
    video: z.boolean().optional(), audio: z.boolean().optional(),
  }, forward('add_clip'));

tool('move_clip', 'Move a clip (and its linked partner) to a new start time and/or track. Overwrites whatever it lands on.',
  { clip_id: z.string(), start: sec.optional(), track: track.optional(), include_linked: z.boolean().optional() }, forward('move_clip'));

tool('trim_clip', 'Trim a clip\'s start and/or end to new timeline times. With ripple=true the following clips shift to close or open the gap.',
  { clip_id: z.string(), new_start: sec.optional(), new_end: sec.optional(), ripple: z.boolean().optional(), include_linked: z.boolean().optional() }, forward('trim_clip'));

tool('split_clip', 'Razor cut at a time. Give clip_id to cut one clip (and its linked partner), or all_tracks=true to cut everything at that time.',
  { time: sec, clip_id: z.string().optional(), all_tracks: z.boolean().optional() }, forward('split_clip'));

tool('delete_clips', 'Delete clips. ripple=true closes the resulting gap (Ripple Delete).',
  { clip_ids: z.array(z.string()).min(1), ripple: z.boolean().optional(), include_linked: z.boolean().optional().describe('Also delete linked partners (default false)') }, forward('delete_clips'), { destructiveHint: true });

tool('close_gap', 'Ripple-delete the empty gap at a time on a track.', { track, time: sec }, forward('close_gap'));

tool('set_clip', 'Change clip properties: name, enabled, speed (1 = 100%, 2 = double speed), label color name, scale_to_frame.',
  { clip_id: z.string(), name: z.string().optional(), enabled: z.boolean().optional(), speed: z.number().positive().optional(), label: z.string().optional(), scale_to_frame: z.boolean().optional(), include_linked: z.boolean().optional() }, forward('set_clip'));

const kfShape = z.record(z.string(), z.array(z.object({ time: z.number().min(0).describe('Seconds from clip start'), value: z.number(), ease: z.enum(['linear', 'ease', 'hold']).optional() })))
  .describe('Keyframes per parameter, e.g. {"opacity": [{"time": 0, "value": 0}, {"time": 1, "value": 100}]}. An empty list removes animation.');

tool('add_effect', 'Add an effect from list_effects to a clip (e.g. gaussianBlur, lumetri, crop, vignette, bass). Optional initial params and keyframes.',
  { clip_id: z.string(), effect: z.string(), params: z.record(z.string(), z.any()).optional(), keyframes: kfShape.optional() }, forward('add_effect'));

tool('set_effect', 'Change an effect on a clip, including built-in ones: "motion" (x, y, scale, scaleW, rotation, ax, ay), "opacity" (opacity, blend), "volume" (level in dB), "panner" (balance), "text" on titles (text, font, size, fill, ...), "colorMatte" (color). Identify the effect by type or id. Use keyframes to animate.',
  { clip_id: z.string(), effect: z.string().describe('Effect type or effect id'), params: z.record(z.string(), z.any()).optional(), keyframes: kfShape.optional(), time: z.number().min(0).optional().describe('Clip-relative time used when setting a param that is already animated'), enabled: z.boolean().optional(), reset: z.boolean().optional() }, forward('set_effect'));

tool('remove_effect', 'Remove an added effect from a clip.', { clip_id: z.string(), effect: z.string() }, forward('remove_effect'));

tool('set_transition', 'Put a transition on the start ("in") or end ("out") of a clip, or remove it with type null. At a cut, an "in" transition on the second clip blends from the clip before it.',
  { clip_id: z.string(), edge: z.enum(['in', 'out']), type: z.string().nullable().describe('e.g. crossDissolve, dipToBlack, wipe, push, constantPower; null removes'), duration: z.number().positive().optional() }, forward('set_transition'));

tool('add_title', 'Add a text title on a video track. Position x/y is the text centre in sequence pixels (default: lower third).',
  {
    text: z.string(), start: sec.optional(), duration: z.number().positive().optional(), track: track.optional(), x: z.number().optional(), y: z.number().optional(),
    font: z.string().optional(), size: z.number().optional(), weight: z.string().optional(), italic: z.boolean().optional(), align: z.enum(['left', 'center', 'right']).optional(),
    color: z.string().optional().describe('#rrggbb'), stroke_width: z.number().optional(), stroke_color: z.string().optional(), shadow: z.number().optional(),
    background: z.boolean().optional(), background_color: z.string().optional(), background_opacity: z.number().optional(), tracking: z.number().optional(), leading: z.number().optional(),
  }, forward('add_title'));

tool('add_generated', 'Add a color matte (type "color") or an adjustment layer (type "adjustment", put effects on it to affect everything below).',
  { type: z.enum(['color', 'adjustment']), start: sec.optional(), duration: z.number().positive().optional(), track: track.optional(), color: z.string().optional(), name: z.string().optional() }, forward('add_generated'));

tool('add_marker', 'Add a sequence marker.', { time: sec.optional(), name: z.string().optional(), color: z.string().optional() }, forward('add_marker'));
tool('remove_marker', 'Remove a sequence marker by id.', { marker_id: z.string() }, forward('remove_marker'));
tool('set_in_out', 'Set or clear (null) the sequence In and Out points.', { in_point: sec.nullable().optional(), out_point: sec.nullable().optional() }, forward('set_in_out'));

tool('add_track', 'Add a video or audio track.', { kind: z.enum(['video', 'audio']) }, forward('add_track'));
tool('set_track', 'Change track settings: name, locked, targeted; video: hidden; audio: muted, solo, volume_db, pan (-100..100).',
  { track, name: z.string().optional(), muted: z.boolean().optional(), solo: z.boolean().optional(), locked: z.boolean().optional(), hidden: z.boolean().optional(), volume_db: z.number().optional(), pan: z.number().optional(), targeted: z.boolean().optional() }, forward('set_track'));
tool('delete_track', 'Delete a track and its clips.', { track }, forward('delete_track'), { destructiveHint: true });
tool('set_master_volume', 'Set the master output volume in dB.', { volume_db: z.number() }, forward('set_master_volume'));

tool('create_sequence', 'Create a new sequence (e.g. 1920x1080, 1080x1920 vertical, 3840x2160) and optionally make it active.',
  { name: z.string().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), fps: z.number().positive().optional(), activate: z.boolean().optional() }, forward('create_sequence'));
tool('set_sequence', 'Switch the active sequence (by id or name) and/or change its name, size, fps or background color.',
  { sequence_id: z.string().optional(), name: z.string().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), fps: z.number().positive().optional(), background: z.string().optional() }, forward('set_sequence'));

tool('select_clips', 'Select clips in the editor UI (so the user sees them in Effect Controls).', { clip_ids: z.array(z.string()) }, forward('select_clips'));
tool('seek', 'Move the playhead.', { time: sec }, forward('seek'));
tool('play', 'Start playback in the editor.', {}, forward('play'));
tool('pause', 'Stop playback.', {}, forward('pause'));
tool('undo', 'Undo the last edit.', {}, forward('undo'));
tool('redo', 'Redo the last undone edit.', {}, forward('redo'));

tool('render_frame', 'Render the sequence at a time and return it as an image so you can see the edit.',
  { time: sec.optional().describe('Default: playhead'), max_width: z.number().int().min(64).max(3840).optional().describe('Default 960') },
  async args => {
    const r = await call('render_frame', args, 60000);
    const { png_base64, ...meta } = r;
    return { content: [{ type: 'image', data: png_base64, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(meta) }] };
  }, { readOnlyHint: true });

tool('export_video', 'Render and save the sequence to a file on this computer. Formats: mp4 (H.264, needs Chrome/Edge), webm (VP9), wav (audio only), realtime (screen-recorded fallback). Can take a while for long sequences.',
  {
    output_path: z.string().optional().describe('File or folder to save to (default: ~/Downloads)'),
    format: z.enum(['mp4', 'webm', 'wav', 'realtime']).optional(), name: z.string().optional().describe('File name without extension'),
    start: sec.optional(), end: sec.optional(), range: z.enum(['all', 'io']).optional().describe('io = use sequence In/Out points'),
    size: z.enum(['match', '2160', '1080', '720', '480']).optional(), bitrate_mbps: z.number().positive().optional(), audio: z.boolean().optional(),
  },
  async ({ output_path, ...opts }) => {
    const r = await call('export_video', opts, 2 * 60 * 60 * 1000);
    let target = output_path ? path.resolve(output_path.replace(/^~(?=$|\/|\\)/, os.homedir())) : path.join(os.homedir(), 'Downloads');
    let isDir = false;
    try { isDir = (await fs.stat(target)).isDirectory(); } catch { isDir = !path.extname(target); }
    if (isDir) { await fs.mkdir(target, { recursive: true }); target = path.join(target, r.filename); }
    else await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(r.data_base64, 'base64'));
    return json({ saved_to: target, bytes: r.bytes, mime: r.mime });
  });

tool('export_formats', 'List the export formats the user\'s browser supports.', {}, forward('export_formats'), { readOnlyHint: true });

tool('editor_status', 'Check whether the browser editor is connected to this MCP server.', {}, async () => json({
  connected: !!(editor && editor.readyState === 1), port: PORT, bridge_error: bridgeError, editor: editor?.info || null,
}), { readOnlyHint: true });

await server.connect(new StdioServerTransport());
log('MCP server ready');
