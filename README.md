# Premiere Web

A Premiere Pro–style, non-linear video editor that runs entirely in the browser. There is no server, no build step and no upload: your media stays on your computer. It's a static site, so it can be hosted on **GitHub Pages**.

## Features

**Workspace**
- Premiere-style layout with Source, Effect Controls and Audio Track Mixer panels, the Program monitor, Project/Effects/History panels, a Tools panel, the Timeline and audio meters
- Resizable panels, workspaces (Editing, Assembly, Effects, Audio), and maximize-panel with the `` ` `` key
- Menus and keyboard shortcuts that follow Premiere's defaults (press **F1** for the full list)

**Media and project**
- Import video, audio and images by dragging them into the Project panel or the timeline, or with `Ctrl+I`
- Thumbnails, audio waveforms, and list or icon views with search
- New items: Graphic/Title, Color Matte, Black Video and Adjustment Layer
- Multiple sequences with presets (1080p, 4K, 720p, vertical 9:16, square, 4:5) and frame rates from 23.976 to 60 fps
- Autosaves to browser storage (IndexedDB), including the media files
- Save and open `.prweb` project files, and relink offline media

**Timeline editing**
- Unlimited video and audio tracks, with lock, target, output toggle, mute and solo
- Linked audio/video clips, snapping, markers and In/Out points
- Tools: Selection (V), Track Select Forward (A), Ripple Edit (B), Rolling Edit (N), Razor (C), Slip (Y), Hand (H), Zoom (Z) and Type (T)
- Overwrite and insert edits, ripple delete (including gaps), Lift/Extract, Add Edit (`Ctrl+K`) and Q/W ripple trims
- Copy/cut/paste, paste insert, Alt-drag to duplicate, nudge, Speed/Duration, enable/disable, label colors
- Audio volume "rubber band" on clips
- Undo/redo with a History panel

**Effects and transitions**
- Motion (position, scale, rotation, anchor) with on-screen handles in the Program monitor, plus Opacity with 16 blend modes
- Keyframes on any numeric parameter, with linear, ease and hold interpolation
- Video effects: Lumetri Color (basic), Brightness & Contrast, Black & White, Sepia, Invert, Gaussian Blur, Drop Shadow, Crop, Horizontal/Vertical Flip, Vignette, Tint and Mosaic
- Audio effects: Volume, Panner, Bass, Treble, Lowpass, Highpass and Amplify
- Video transitions: Cross Dissolve, Film Dissolve, Dip to Black/White, Wipe, Barn Doors, Iris Round, Push, Slide and Cross Zoom
- Audio transitions: Constant Power, Constant Gain and Exponential Fade
- Titles with font, size, weight, fill, stroke, shadow, tracking, leading and background box

**Export (`Ctrl+M`)**
- **H.264 MP4** or **VP9 WebM**, rendered frame-accurately with WebCodecs, with AAC or Opus audio
- A real-time recording fallback for browsers without WebCodecs
- WAV audio mixdown and PNG still frames

## Phone layout

The editor has a touch-friendly phone layout. It switches on automatically on phones, and you can toggle it anywhere with **📱 Phone** (top bar) or **View ▸ Phone Layout**. On the phone, the 🖥 button switches back to desktop.

- **Screen layout:** the preview sits on top, an edit bar of context actions is in the middle, and one panel shows at a time, switched with the bottom tabs (Timeline, Media, Effects, Adjust, Audio, Claude). Holding the phone sideways puts the preview on the left.
- **Edit bar:** with a clip selected it offers Split, Delete, Ripple delete, Adjust, Speed, Fade, Effects, Copy, Enable and More. With nothing selected it offers Media, Text, Split, Razor, Transitions, Fit and Import.
- **Gestures:**
  - **Timeline:** tap a clip to select it, drag it to move it, and drag its edges to trim. Drag empty space to scroll, pinch to zoom, and long-press a clip for its full menu.
  - **Preview:** drag the selected clip to move it, or pinch to resize it.
- **Adding media:** tap **+** on a Media item to insert it at the playhead. Tap an effect or transition to apply it to the selected clip.
- **Menus:** the ☰ button opens the full desktop menus as a bottom sheet.

## Editing with Claude

### In the browser: the Claude panel

Click **✳ Ask Claude** (top right) or press `Ctrl+J`, then describe the edit you want. For example: *"Put my clips in order with cross dissolves, add a title that says 'Summer 2026' and make the last clip slow motion."* Claude works directly in your timeline. It can look at rendered frames to check its work, and each reply has an **Undo** button.

- **API key:** the first time, paste an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys). The page calls the Claude API directly, so there's no server. Usage is billed to your Anthropic API account, which is separate from a claude.ai subscription. The key is only sent to `api.anthropic.com`, and it's kept in this browser only if you tick **Remember on this device**.
- **Model and effort:** choose Claude Opus 5.5 (default), Sonnet 5.5 or Haiku 5.5, and Fast, Balanced or Thorough effort, from the panel header.
- **Media:** attach files with the paperclip or by dragging them onto the panel. They're imported into the project, and Claude is told about them.

### From the Claude desktop app or Claude Code (MCP)

With the MCP server, Claude can also edit your project from the Claude desktop app or Claude Code. It can import media, cut and arrange clips, add effects, titles, transitions and keyframes, check its work by looking at rendered frames, and export the result.

1. Set up the small local MCP server in [`mcp-server/`](mcp-server/README.md) and add it to Claude Desktop or Claude Code.
2. In the editor, click **Claude app (MCP)** (top right).
3. Ask Claude something like: *"Import ~/Videos/clip.mp4, trim the first 3 seconds, add a title that says 'Summer 2026' and export it as MP4."*

Every change Claude makes appears live and can be undone from the History panel or with `Ctrl+Z`.

## Deploying to GitHub Pages

1. Push this repository to GitHub (the files are already at the repository root).
2. On GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**. Then choose branch **`main`** and folder **`/ (root)`**, and click **Save**.
4. After a minute or so the editor will be live at `https://<your-username>.github.io/<repository-name>/`.

The `.nojekyll` file tells GitHub Pages to serve the files as they are.

## Running locally

ES modules need to be served over HTTP, not opened as `file://`:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Browser support

Use a current **Chrome** or **Edge** for the best experience, including H.264 MP4 export. Firefox and Safari can edit, but the export formats they offer depend on their WebCodecs support. The export dialog only lists formats your browser can encode.

## Notes and limitations

- Media files are stored in your browser's IndexedDB so the project survives a reload. Clearing site data removes them. A `.prweb` project file holds the edit but not the media, so keep your original files to relink.
- Decoding uses the browser's own codecs, so what you can import depends on the browser. For example, ProRes and some MKV files may not work.
- Long or 4K timelines with many layers can play back slowly; set the Program monitor's playback resolution to 1/2 or 1/4.

Not affiliated with or endorsed by Adobe. MP4/WebM muxing uses [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) and [webm-muxer](https://github.com/Vanilagy/webm-muxer) (MIT, vendored in `js/vendor/`).
