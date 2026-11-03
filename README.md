# Storage Saver

Keeps your computer's storage low. Your files become a 3D city: each category is a suburb (Media District, Cache Town, Downloads…), every folder or big file is a building whose height is its size, and free space is a park. Click a building for options, including **Demolish** (moves it to the Trash). A Safe clean panel finds caches, old downloads, trash and stale large files to clear in one go.

![Storage Saver by day](docs/screenshot.png)
![Storage Saver by night](docs/night.png)

## Run it

```bash
npm install
npm start
```

Click **Scan my files** (scans your home folder) or **Choose folder…** for any other folder.

- **Drag** to orbit, **scroll** to zoom, **click** a building for Walk in / Show in Finder / Demolish, **double-click** the sky to go back up.
- Colours: orange = caches & temp, purple = downloads & installers, blue = video/photo/audio, green = apps, yellow = documents, grey = other/system, dark glass = free space.
- **☾ Night** (top right) switches to night: stars, lit windows, lamps, headlights and neon.
- **While scanning** the city is a construction site: roads laid, cranes swinging, road crews patching, and each top-level folder's building goes up the moment it has been measured.
- **Full Disk Access** (macOS): a one-time screen opens the exact System Settings switch so there are no per-folder pop-ups.
- **Safe clean** lists what can go. Everything goes to the Trash / Recycle Bin, never a permanent delete.

## Browser demo

`npm run build:demo` writes `demo/index.html`, a single file that runs the same UI on sample data in any browser (no scanning or deleting).

## Install on a Mac

Download the latest `.dmg` from [Releases](https://github.com/angus-byte/storage-saver/releases) (`-arm64` for Apple silicon, otherwise the Intel one), open it and drag Storage Saver to Applications.

The build is not notarised with Apple yet, so on first launch macOS will say it cannot verify the developer. Right-click the app, choose **Open**, then **Open** again. If macOS reports the app as "damaged", run `xattr -dr com.apple.quarantine "/Applications/Storage Saver.app"` once in Terminal.

Builds come from the **Build Mac app** GitHub Action (run it by hand or push a `v*` tag). Locally on a Mac, `npm run dist` writes the `.dmg` to `dist/`.

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

## Free and Pro (Gigapolis Pro)

| | Free | Pro ($19.99 once) |
|---|---|---|
| Full scan + whole city | ✓ | ✓ |
| Street Sweep (Trash, old Downloads, caches, big stale files) | ✓ | ✓ |
| Demolish (move to Trash) | 20 GB in total | Unlimited |
| Deep Clean: render caches, duplicates, app leftovers, old iPhone backups, dev junk, logs/installers | see what's found | ✓ |
| Weekly check-up with alert | | ✓ |

Pro is unlocked with a **Lemon Squeezy licence key** (no account or login). Checkout link, store id (513897) and product id (1496849) live in `src/main/config.js`; env vars `GIGAPOLIS_CHECKOUT_URL` / `GIGAPOLIS_STORE_ID` / `GIGAPOLIS_PRODUCT_ID` override them. The key is checked online on activation and every few days after; Pro keeps working offline for 30 days. The free allowance is enforced in the main process. For development, `GIGAPOLIS_PRO=1 npm start` forces Pro (unpackaged builds only). In the browser demo the key `DEMO-PRO` unlocks Pro.

![Upgrade screen](docs/pro-upgrade.png)
