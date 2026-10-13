# Premiere Web MCP server

This server lets Claude edit your Premiere Web project. Claude can import media, cut and arrange clips, add effects, transitions, titles and keyframes, look at rendered frames, and export the finished video.

```
Claude (Desktop / Code)  ──MCP (stdio)──▶  this server  ──WebSocket (127.0.0.1:7811)──▶  editor tab in your browser
```

GitHub Pages can only host static files, so the MCP server runs on your own computer. The editor page, whether it's on GitHub Pages or `localhost`, connects to it. Every edit Claude makes appears live in the editor and is added to the History panel, so you can undo it with `Ctrl+Z`.

## Setup

**1. Install** (needs [Node.js](https://nodejs.org) 18 or newer):

```sh
git clone https://github.com/Premieretie/PremiereVidEditor.git
cd PremiereVidEditor/mcp-server
npm install
```

**2. Add it to Claude.**

*Claude Code:*

```sh
claude mcp add premiere-web -- node /full/path/to/PremiereVidEditor/mcp-server/index.js
```

*Claude Desktop:* open **Settings → Developer → Edit Config** and add the following to `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "premiere-web": {
      "command": "node",
      "args": ["/full/path/to/PremiereVidEditor/mcp-server/index.js"]
    }
  }
}
```

On Windows, write the path like `"C:\\Users\\you\\PremiereVidEditor\\mcp-server\\index.js"`.

**3. Connect the editor.** Open the editor (for example `https://premieretie.github.io/PremiereVidEditor/`) and click **Claude app (MCP)** in the top-right corner, then **Connect**. The button turns orange and reads **Claude app connected**. If Chrome asks whether the site may access apps and services on this device, click **Allow**. The editor reconnects automatically the next time you open it.

**4. Ask Claude**, for example:
- "Import ~/Videos/interview.mp4 and ~/Music/bed.mp3, cut the interview into three 10-second segments with cross dissolves, and put the music under it at -18 dB."
- "Add a lower-third title saying 'Jane Doe — Director' from 2s to 7s."
- "Show me the frame at 12 seconds."
- "Export the sequence as MP4 to my Desktop."

## Tools

| Tool | What it does |
|---|---|
| `get_state`, `list_effects`, `editor_status`, `export_formats` | Inspect the project, the effect catalog and the connection |
| `import_media` | Import a local file (`path`) or a URL |
| `add_clip`, `move_clip`, `trim_clip`, `split_clip`, `delete_clips`, `close_gap`, `set_clip` | Timeline editing (overwrite/insert, ripple, razor, speed, enable) |
| `add_effect`, `set_effect`, `remove_effect` | Effects and keyframes, including Motion, Opacity, Volume and title text |
| `set_transition` | Transitions on clip starts and ends |
| `add_title`, `add_generated` | Titles, color mattes and adjustment layers |
| `add_marker`, `remove_marker`, `set_in_out` | Markers and In/Out points |
| `add_track`, `set_track`, `delete_track`, `set_master_volume` | Tracks and mixing |
| `create_sequence`, `set_sequence` | Sequences and their settings |
| `seek`, `play`, `pause`, `select_clips`, `undo`, `redo` | Playback and the editor UI |
| `render_frame` | Returns an image of any frame so Claude can check its work |
| `export_video` | Renders MP4/WebM/WAV in the browser and saves it to disk (default `~/Downloads`) |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PREMIERE_WEB_PORT` | `7811` | WebSocket port. If you change it, set the same port in the editor's Claude panel. |
| `PREMIERE_WEB_ORIGINS` | `https://premieretie.github.io` | Comma-separated list of web origins allowed to connect. Add your own GitHub Pages origin if you host a fork. `localhost` is always allowed. |

Set these in the `env` field of the Claude Desktop config, or with `claude mcp add -e PREMIERE_WEB_PORT=7900 …`.

## Security

- The bridge listens on `127.0.0.1` only, so other machines on your network can't reach it.
- Only pages from the allowed origins can connect, so other websites you visit can't drive your editor.
- Media goes to Claude only when a tool sends it: `render_frame` returns a picture of a frame. Imported files and exports move between your disk and the browser on your machine.

## Troubleshooting

- **"The Premiere Web editor is not connected"**: open the editor and click **Claude app (MCP)**. Keep the tab open while Claude works. Long exports need the tab to stay visible.
- **Button stays yellow ("Waiting for Claude…")**: Claude isn't running the server. Check that the MCP server appears in Claude Desktop's settings or in `claude mcp list`, and that the ports match.
- **"Port 7811 is already in use"**: another copy of the server is running, for example from both Claude Desktop and Claude Code. Close one, or give one of them a different `PREMIERE_WEB_PORT`.
- **Safari won't connect**: Safari blocks secure pages from connecting to `ws://` on localhost. Use Chrome or Edge, or run the editor locally (`python3 -m http.server` in the repository root, then open `http://localhost:8000`).
