# Storage Saver

Keeps your computer's storage low. A 3D visualiser shows your computer as a drive with every folder and big file stacked on it by size, and a Safe clean panel finds caches, old downloads, trash and stale large files you can move to the Trash in one click.

![Storage Saver screenshot](docs/screenshot.png)

## Run it

```bash
npm install
npm start
```

Click **Scan my files** (scans your home folder) or **Choose folder…** for any other folder.

- **Drag** to orbit, **scroll** to zoom, **click** a block to dive into that folder, **double-click** the background to go back up.
- Colours: orange = caches & temp, purple = downloads & installers, blue = video/photo/audio, green = apps, yellow = documents, grey = other/system, dark glass = free space.
- **Safe clean** lists what can go. Everything goes to the Trash / Recycle Bin, never a permanent delete.

## Browser demo

`npm run build:demo` writes `demo/index.html`, a single file that runs the same UI on sample data in any browser (no scanning or deleting).

## Build an installer

```bash
npm run dist   # .dmg on macOS, .exe installer on Windows
```

## Layout

- `src/main/scanner.js` – folder walker, size aggregation, categories, cleanup suggestions (pure Node, tested).
- `src/main/main.js` – Electron window and the privileged actions (scan, reveal, move to Trash).
- `src/renderer/` – the UI: `app.js` (Three.js scene + panel), `treemap.js` (squarified layout), `mock.js` (demo data).

## Roadmap

1. Scanner + 3D view (done)
2. Safe clean: caches, trash, old downloads, stale large files (done)
3. Duplicate finder
4. Weekly background scan + low-space alert
5. Cloud/external-drive offload for large stale media
