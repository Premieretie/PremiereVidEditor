// In-editor Claude assistant: a chat panel that calls the Claude API directly from the browser
// with the user's own API key, and lets Claude edit the project through the editing tools.
import Anthropic from './vendor/anthropic-sdk.js';
import { TOOLS, validateInput } from './claude-tools.js';
import { METHODS } from './bridge.js';
import { project, seq, ui, bus, history, revertTo } from './store.js';
import { importFiles } from './media.js';
import { runExport } from './exporter.js';
import { h, $, pickFiles, download } from './util.js';
import { toast, confirmBox, notify } from './ui.js';

const MODELS = [['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5']];
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']); // server-side refusal fallbacks
const MAX_STEPS = 60; // tool-use round trips per user message

const SYSTEM = `You are Claude, working inside Premiere Web, a Premiere Pro-style video editor running in the user's browser. You edit the user's open project directly with the provided tools; every edit appears live in their timeline and can be undone.

How the editor works:
- Times are in seconds. Tracks are "V1", "V2"... (video; V1 is the bottom layer, higher tracks draw on top) and "A1", "A2"... (audio).
- Video files with sound become linked video + audio clips; clip tools act on the linked partner too unless include_linked is false.
- Clips have built-in effects: motion (x, y, scale, rotation...), opacity, and for audio volume (dB) and panner. Effect keyframe times are relative to the clip start.
- Titles are text clips with a "text" effect. Use list_effects for effect/transition types and parameter names.

How to work:
- Call get_state before editing so you use real ids and times; ids change when clips are split or recreated.
- Make the edits the user asked for, then check visual results with render_frame when the look matters (titles, framing, color, transitions).
- If a request is ambiguous in a way that changes the result (which clip, which part of the video), ask a short question instead of guessing.
- Don't delete media or whole sequences, and don't export, unless the user asks.
- The user can attach media files in the chat; they are imported into the project before your turn and listed in the message.
- Keep replies short: say what you changed in a sentence or two, mentioning times and tracks where useful.`;

const LS = {
  get(k, d) { try { return localStorage.getItem('prweb-ai-' + k) ?? d; } catch { return d; } },
  set(k, v) { try { v == null ? localStorage.removeItem('prweb-ai-' + k) : localStorage.setItem('prweb-ai-' + k, v); } catch { } },
};

const st = {
  apiKey: LS.get('key', ''),
  model: LS.get('model', 'claude-opus-5-5'),
  effort: LS.get('effort', 'medium'),
  messages: [],        // Anthropic MessageParam[] (append-only)
  busy: false,
  stream: null,
  stopRequested: false,
  pendingFiles: [],    // imported media to mention in the next message
  notes: [],           // editor notes to include with the next message
};
let el = {};
let client = null;
const getClient = () => (client && client.apiKey === st.apiKey) ? client : (client = new Anthropic({ apiKey: st.apiKey, dangerouslyAllowBrowser: true }));

// ---------------- Markdown-ish rendering (escaped) ----------------
const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function md(text) {
  const parts = text.split(/```[\w-]*\n?([\s\S]*?)```/g);
  let html = '';
  parts.forEach((p, i) => {
    if (i % 2) { html += `<pre><code>${esc(p)}</code></pre>`; return; }
    const lines = esc(p).split('\n');
    let list = null;
    for (let line of lines) {
      line = line.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\W)\*([^*\s][^*]*)\*(?=\W|$)/g, '$1<i>$2</i>');
      const ul = line.match(/^\s*[-*•]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (ul || ol) {
        const tag = ul ? 'ul' : 'ol';
        if (list !== tag) { if (list) html += `</${list}>`; html += `<${tag}>`; list = tag; }
        html += `<li>${(ul || ol)[1]}</li>`;
        continue;
      }
      if (list) { html += `</${list}>`; list = null; }
      const hd = line.match(/^#{1,4}\s+(.*)/);
      if (hd) html += `<div class="ai-h">${hd[1]}</div>`;
      else if (line.trim()) html += `<p>${line}</p>`;
    }
    if (list) html += `</${list}>`;
  });
  return html;
}

// ---------------- UI ----------------
export function initClaudeChat(page) {
  el.page = page;
  page.append(
    h('div.ai-head', {},
      el.model = h('select.ai-sel', { title: 'Model' }, MODELS.map(([v, l]) => h('option', { value: v, selected: v === st.model }, l))),
      el.effort = h('select.ai-sel', { title: 'Effort: how hard Claude thinks before acting' }, [['low', 'Fast'], ['medium', 'Balanced'], ['high', 'Thorough']].map(([v, l]) => h('option', { value: v, selected: v === st.effort }, l))),
      h('div.spacer'),
      h('button.icon-btn', { title: 'New chat', on: { click: newChat } }, '✚'),
      h('button.icon-btn', { title: 'API key settings', on: { click: () => showKeySetup(true) } }, '⚙'),
    ),
    el.log = h('div.ai-log'),
    el.attach = h('div.ai-attachments'),
    h('div.ai-input', {},
      h('button.icon-btn.ai-clip', { title: 'Attach media (imports it into the project)', on: { click: attachFiles }, html: '<svg viewBox="0 0 16 16"><path d="M10.5 4.5l-5 5a1.4 1.4 0 002 2l5.5-5.5a2.8 2.8 0 00-4-4L3.5 7.5a4.2 4.2 0 006 6l4-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' }),
      el.input = h('textarea.ai-text', { rows: 2, placeholder: 'Ask Claude to edit… e.g. "Cut the first 3 seconds and add a title that says Summer 2026"', spellcheck: true }),
      el.send = h('button.btn.primary.ai-send', { on: { click: () => st.busy ? stop() : send() } }, 'Send'),
    ),
  );
  el.model.addEventListener('change', () => { st.model = el.model.value; LS.set('model', st.model); });
  el.effort.addEventListener('change', () => { st.effort = el.effort.value; LS.set('effort', st.effort); });
  el.input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!st.busy) send(); }
  });
  el.input.addEventListener('input', () => { el.input.style.height = 'auto'; el.input.style.height = Math.min(160, el.input.scrollHeight) + 'px'; });
  page.addEventListener('pointerdown', () => ui.focus = 'claude', true);
  page.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); page.classList.add('drop'); } });
  page.addEventListener('dragleave', () => page.classList.remove('drop'));
  page.addEventListener('drop', async e => { e.preventDefault(); page.classList.remove('drop'); if (e.dataTransfer.files.length) await addFiles([...e.dataTransfer.files]); });
  renderEmpty();
}

function renderEmpty() {
  el.log.innerHTML = '';
  if (!st.apiKey) return showKeySetup(false);
  const ex = ['Put all my clips on the timeline in order with cross dissolves between them', 'Add a lower-third title "Jane Doe — Director" from 2s to 7s', 'Make the second clip black and white and slow it to 50%', 'Fade the music down to -18 dB under the video and fade it out at the end', 'Show me the frame at 5 seconds'];
  el.log.append(h('div.ai-welcome', {},
    h('div.ai-logo', {}, '✳'),
    h('div.ai-w-title', {}, 'Edit with Claude'),
    h('div.ai-w-sub', {}, 'Describe the edit you want. Claude works directly in your timeline, and you can undo anything it does.'),
    h('div.ai-examples', {}, ex.map(t => h('button.ai-ex', { on: { click: () => { el.input.value = t; el.input.focus(); } } }, t))),
  ));
}

function showKeySetup(fromSettings) {
  const key = h('input.ai-key', { type: 'password', placeholder: 'sk-ant-…', value: st.apiKey, autocomplete: 'off', spellcheck: false });
  const remember = h('input', { type: 'checkbox', checked: LS.get('key', '') !== '' || !st.apiKey });
  key.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') save(); });
  const save = () => {
    const v = key.value.trim();
    if (v && !v.startsWith('sk-')) return toast('That does not look like an Anthropic API key (it should start with sk-ant-)');
    st.apiKey = v; client = null;
    LS.set('key', remember.checked && v ? v : null);
    card.remove();
    if (!v) { toast('API key removed'); renderEmpty(); return; }
    toast('API key saved');
    if (!st.messages.length) renderEmpty();
  };
  const card = h('div.ai-setup', {},
    h('div.ai-w-title', {}, fromSettings ? 'Claude API key' : 'Connect your Claude API key'),
    h('p', {}, 'The assistant calls Claude directly from this page using your own Anthropic API key. Usage is billed to your Anthropic API account, which is separate from a claude.ai subscription.'),
    h('ol', {},
      h('li', { html: 'Create a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>.' }),
      h('li', {}, 'Paste it here.'),
    ),
    key,
    h('label.ai-remember', {}, remember, ' Remember on this device'),
    h('p.muted.ai-small', {}, 'The key is only sent to api.anthropic.com. If you choose to remember it, it is stored in this browser\'s local storage, so don\'t do that on a shared computer.'),
    h('div.ai-setup-btns', {},
      fromSettings && st.apiKey ? h('button.btn', { on: { click: () => { key.value = ''; save(); } } }, 'Remove key') : null,
      fromSettings ? h('button.btn', { on: { click: () => card.remove() } }, 'Cancel') : null,
      h('button.btn.primary', { on: { click: save } }, 'Save'),
    ),
  );
  if (!fromSettings) el.log.innerHTML = '';
  el.log.append(card);
  el.log.scrollTop = el.log.scrollHeight;
  key.focus();
}

async function newChat() {
  if (st.busy) return;
  st.messages = []; st.pendingFiles = []; st.notes = []; el.attach.innerHTML = '';
  renderEmpty();
}

async function attachFiles() {
  const files = await pickFiles('video/*,audio/*,image/*');
  if (files.length) await addFiles(files);
}
async function addFiles(files) {
  const added = await importFiles(files, notify);
  for (const m of added) {
    st.pendingFiles.push(m);
    el.attach.append(h('span.ai-chip', { title: 'Imported into the project' }, '+ ' + m.name));
  }
}

function setBusy(b) {
  st.busy = b;
  el.send.textContent = b ? 'Stop' : 'Send';
  el.send.classList.toggle('stop', b);
  bus.emit('claude-busy', b);
}
const scroll = () => { const L = el.log; if (L.scrollHeight - L.scrollTop - L.clientHeight < 140) L.scrollTop = L.scrollHeight; };

function stop() {
  st.stopRequested = true;
  try { st.stream?.abort(); } catch { }
}

// ---------------- Conversation loop ----------------
async function send() {
  const text = el.input.value.trim();
  if (!text && !st.pendingFiles.length) return;
  if (!st.apiKey) return showKeySetup(false);
  if (!st.messages.length) el.log.innerHTML = '';
  el.input.value = ''; el.input.style.height = '';
  let content = text;
  const notes = [];
  if (st.pendingFiles.length) notes.push('Attached and imported into the project: ' + st.pendingFiles.map(m => `${m.name} (media id ${m.id}, ${m.type}${m.duration && m.type !== 'image' ? `, ${m.duration.toFixed(2)}s` : ''}${m.width ? `, ${m.width}x${m.height}` : ''}${m.hasAudio ? ', has audio' : ''})`).join('; '));
  notes.push(...st.notes); st.notes = [];
  if (ui.sel.size) notes.push(`Currently selected clip ids: ${[...ui.sel].join(', ')}`);
  notes.push(`Playhead: ${seq().playhead.toFixed(2)}s`);
  content = (text || '(see attachments)') + `\n\n[Editor context — ${notes.join('. ')}]`;
  el.log.append(h('div.ai-msg.user', {}, h('div.ai-bubble', {}, text || '(attachments)', st.pendingFiles.length ? h('div.ai-att', {}, st.pendingFiles.map(m => '+ ' + m.name).join('  ')) : null)));
  st.pendingFiles = []; el.attach.innerHTML = '';
  st.messages.push({ role: 'user', content });
  const turn = h('div.ai-msg.assistant');
  el.log.append(turn); scroll();
  const undoMark = history.undo.length;
  setBusy(true); st.stopRequested = false;
  try {
    await runTurn(turn);
  } catch (e) {
    showError(turn, e);
  } finally {
    setBusy(false); st.stream = null;
    if (history.undo.length > undoMark) addUndo(turn, undoMark);
    scroll();
  }
}

async function runTurn(turn) {
  const anthropic = getClient();
  for (let step = 0; step < MAX_STEPS; step++) {
    const params = {
      model: st.model,
      max_tokens: 32000,
      system: SYSTEM,
      tools: TOOLS,
      messages: st.messages,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: st.effort },
      cache_control: { type: 'ephemeral' },
    };
    if (FALLBACK_MODELS.has(st.model)) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
    const view = renderStreamInto(turn);
    const stream = st.stream = anthropic.beta.messages.stream(params);
    stream.on('streamEvent', view.onEvent);
    let message;
    try {
      message = await stream.finalMessage();
    } catch (e) {
      view.done();
      if (e instanceof Anthropic.APIUserAbortError || st.stopRequested) { turn.append(h('div.ai-note', {}, 'Stopped.')); return; }
      throw e;
    }
    view.done();
    if (message.stop_reason === 'refusal') {
      turn.append(h('div.ai-note.warn', {}, 'Claude declined this request.' + (message.stop_details?.explanation ? ' ' + message.stop_details.explanation : '')));
      return;
    }
    if (message.stop_reason === 'pause_turn') { st.messages.push({ role: 'assistant', content: message.content }); continue; }
    const toolUses = message.content.filter(b => b.type === 'tool_use');
    if (!toolUses.length) { st.messages.push({ role: 'assistant', content: message.content }); return; }
    if (message.stop_reason === 'max_tokens') throw new Error('Claude\'s reply was cut off (max_tokens) before it finished a tool call. Try a smaller request.');
    st.messages.push({ role: 'assistant', content: message.content });
    const results = [];
    for (const tu of toolUses) {
      if (st.stopRequested) { results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Cancelled: the user pressed Stop.' }); continue; }
      results.push(await runTool(tu, view.chipFor(tu)));
    }
    st.messages.push({ role: 'user', content: results }); // all results for this step in one message
    if (st.stopRequested) { turn.append(h('div.ai-note', {}, 'Stopped.')); return; }
  }
  turn.append(h('div.ai-note.warn', {}, `Stopped after ${MAX_STEPS} steps. Send another message to let Claude continue.`));
}

/** Streams thinking/text/tool-call blocks into the assistant turn element. */
function renderStreamInto(turn) {
  const blocks = new Map(); // index -> {kind, node, text}
  const chips = new Map();  // tool_use id -> chip element
  const onEvent = ev => {
    if (ev.type === 'content_block_start') {
      const b = ev.content_block;
      if (b.type === 'text') { const node = h('div.ai-text'); turn.append(node); blocks.set(ev.index, { kind: 'text', node, text: '' }); }
      else if (b.type === 'thinking') {
        const body = h('div.ai-think-body'); const node = h('details.ai-think', {}, h('summary', {}, 'Thinking…'), body);
        turn.append(node); blocks.set(ev.index, { kind: 'thinking', node, body, text: '' });
      } else if (b.type === 'tool_use') {
        const chip = h('div.ai-tool.running', {}, h('span.ai-tool-ico', {}, '⚙'), h('span.ai-tool-name', {}, prettyTool(b.name)), h('span.ai-tool-status', {}, '…'));
        turn.append(chip); chips.set(b.id, chip); blocks.set(ev.index, { kind: 'tool', node: chip });
      }
    } else if (ev.type === 'content_block_delta') {
      const blk = blocks.get(ev.index); if (!blk) return;
      if (ev.delta.type === 'text_delta') { blk.text += ev.delta.text; blk.node.innerHTML = md(blk.text); }
      else if (ev.delta.type === 'thinking_delta') { blk.text += ev.delta.thinking; blk.body.textContent = blk.text; }
    } else if (ev.type === 'content_block_stop') {
      const blk = blocks.get(ev.index);
      if (blk?.kind === 'thinking') { blk.node.querySelector('summary').textContent = blk.text.trim() ? 'Thought process' : 'Thought'; if (!blk.text.trim()) blk.node.classList.add('empty'); }
    }
    scroll();
  };
  return {
    onEvent,
    chipFor: tu => chips.get(tu.id) || (() => { const c = h('div.ai-tool.running', {}, h('span.ai-tool-ico', {}, '⚙'), h('span.ai-tool-name', {}, prettyTool(tu.name)), h('span.ai-tool-status', {}, '…')); turn.append(c); return c; })(),
    done: () => turn.querySelectorAll('details.ai-think > summary').forEach(s => { if (s.textContent === 'Thinking…') s.textContent = 'Thought'; }),
  };
}

const TOOL_LABELS = { get_state: 'Read project', list_effects: 'Look up effects', add_clip: 'Add clip', move_clip: 'Move clip', trim_clip: 'Trim clip', split_clip: 'Razor cut', delete_clips: 'Delete clips', close_gap: 'Close gap', set_clip: 'Clip properties', add_effect: 'Add effect', set_effect: 'Adjust effect', remove_effect: 'Remove effect', set_transition: 'Transition', add_title: 'Add title', add_generated: 'Add matte/layer', add_marker: 'Add marker', remove_marker: 'Remove marker', set_in_out: 'In/Out points', add_track: 'Add track', set_track: 'Track settings', delete_track: 'Delete track', set_master_volume: 'Master volume', create_sequence: 'New sequence', set_sequence: 'Sequence settings', select_clips: 'Select clips', seek: 'Move playhead', undo: 'Undo', redo: 'Redo', render_frame: 'Look at frame', export_video: 'Export' };
const prettyTool = n => TOOL_LABELS[n] || n;

async function runTool(tu, chip) {
  const setChip = (cls, status, detail) => {
    chip.classList.remove('running'); chip.classList.add(cls);
    chip.querySelector('.ai-tool-status').textContent = status;
    if (detail) { chip.title = detail; }
  };
  const def = TOOLS.find(t => t.name === tu.name);
  const fail = msg => { setChip('error', '✕', msg); return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: msg }; };
  if (!def) return fail(`Unknown tool ${tu.name}`);
  const invalid = validateInput(def, tu.input);
  if (invalid) return fail(`INVALID_INPUT: ${invalid}. Input received: ${JSON.stringify(tu.input).slice(0, 500)}`);
  try {
    if (tu.name === 'render_frame') {
      const r = await METHODS.render_frame({ max_width: 768, ...tu.input });
      const { png_base64, ...meta } = r;
      setChip('ok', '✓');
      chip.after(h('img.ai-frame', { src: 'data:image/png;base64,' + png_base64, title: `Frame at ${meta.time}s` }));
      return { type: 'tool_result', tool_use_id: tu.id, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png_base64 } }, { type: 'text', text: JSON.stringify(meta) }] };
    }
    if (tu.name === 'export_video') {
      const { start, end, range, ...rest } = tu.input;
      chip.querySelector('.ai-tool-status').textContent = 'rendering…';
      const { blob, filename } = await runExport({ ...rest, bitrate: rest.bitrate_mbps, range: start != null || end != null ? [start ?? 0, end ?? Infinity] : (range || 'all') });
      download(blob, filename);
      setChip('ok', '✓', filename);
      return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ downloaded: filename, bytes: blob.size }) };
    }
    const result = await METHODS[tu.name](tu.input);
    setChip('ok', '✓', summarize(tu.input));
    return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
  } catch (e) {
    return fail(e?.message || String(e));
  }
}
const summarize = input => Object.entries(input || {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n').slice(0, 400);

function showError(turn, e) {
  let msg;
  if (e instanceof Anthropic.AuthenticationError) { msg = 'Your API key was rejected. Check it in settings (⚙).'; }
  else if (e instanceof Anthropic.PermissionDeniedError) msg = 'This API key doesn\'t have access to that model. Try another model, or check your Anthropic Console.';
  else if (e instanceof Anthropic.RateLimitError) msg = 'Rate limited by the Claude API. Wait a moment and try again.';
  else if (e instanceof Anthropic.BadRequestError) msg = 'The Claude API rejected the request: ' + (e.error?.error?.message || e.message);
  else if (e instanceof Anthropic.APIConnectionError) msg = 'Could not reach the Claude API. Check your internet connection.';
  else if (e instanceof Anthropic.APIError) msg = `Claude API error${e.status ? ' ' + e.status : ''}: ${e.message}`;
  else msg = e?.message || String(e);
  turn.append(h('div.ai-note.error', {}, msg));
  // Keep the conversation valid: if the last message is a user turn that got no reply, drop nothing (the
  // next send appends a new user message, which the API merges); if it ends with an assistant tool_use, close it.
  const last = st.messages.at(-1);
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    const pending = last.content.filter(b => b.type === 'tool_use');
    if (pending.length) st.messages.push({ role: 'user', content: pending.map(b => ({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: 'Interrupted by an error.' })) });
  }
}

function addUndo(turn, mark) {
  const n = history.undo.length - mark;
  const btn = h('button.ai-undo', { title: 'Revert the project to how it was before this reply' }, `↶ Undo ${n} change${n > 1 ? 's' : ''}`);
  btn.addEventListener('click', async () => {
    const later = history.undo.length - (mark + n);
    if (later > 0 && !(await confirmBox('Undo Claude\'s changes', `This also undoes ${later} later edit${later > 1 ? 's' : ''} made after this reply.`, 'Undo'))) return;
    revertTo(mark);
    btn.disabled = true; btn.textContent = 'Undone';
    st.notes.push('The user undid all the changes from one of your earlier replies, so call get_state before editing');
  });
  turn.append(btn);
}

export function focusClaude() { el.input?.focus(); }
