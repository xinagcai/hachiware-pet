# hachiware-pet

A desktop pet for **DeepSeek Harness** that lives in a small transparent, always-on-top window. It watches your Harness sessions and reacts to what they are doing:

- **idle / focused / strained / tired** — the four moods follow how long a session has been running
- **alert** — a badge and a chime the moment a tool call is waiting for your approval
- **panel** — one row per session with its title and state, click a row to bring the Harness window forward
- **skins** — starts as a simple line drawing, then "＋ New skin" downloads a Petdex sprite sheet and you can switch or delete skins from a single scrolling row
- **draggable** — grab the pet anywhere on the desktop, it remembers the position; double-click to park it bottom-right

中文说明见 [README.md](README.md).

## Requirements

- DeepSeek Harness desktop app (macOS, or Windows through the desktop build)
- Install through the plugin manager: **Plugins → Add plugin → `hachiware-pet`**
- Windows needs the .NET 8 Desktop Runtime; the release ships a prebuilt `HachiwarePet.exe`
- macOS ships a universal binary (`arm64 + x86_64`) — no Xcode needed unless you edit `helper/main.swift`

## How it works

```text
Harness hub (Node)                     native shell                     page (WebView)
─────────────────                      ──────────────                   ───────────────
index.js  ──state.json──▶  main.swift / Program.cs  ──__petState──▶  pet/renderer.js
  sessions, agents,                transparent, always-on-top            sprites, moods,
  approvals                        window, click-through, drag           panel, chime
```

- `index.js` runs inside the Harness hub: it subscribes to sessions and `session/event` approval records, and writes `state.json` (plus a `command.json` inbox for install / switch / delete).
- The native shell is the only platform-specific piece: Swift + AppKit/WebKit on macOS, C# + WinForms/WebView2 on Windows. Both keep the window click-through unless the pointer is over the pet or the open panel.
- `pet/` is a plain HTML/JS page. Skins arrive as `data:` URLs from the native shell, because a `file://` page cannot reference arbitrary images.

Data lives in `~/Library/Application Support/dsh-hachiware-pet/` (macOS) or `%APPDATA%\dsh-hachiware-pet\` (Windows): `state.json`, `helper.log`, `install.log`, `skins/`.

## Skins

The package ships **no character art**. The first run draws a simple pet; pressing **＋ New skin** runs `petdex install <slug>` and copies the sprite sheet into your app-data skin folder.

- Frames per row are measured from the sheet's alpha at load time, so uneven sheets (most of them) play without blank frames
- The grid is derived from the image size, so 8×9 and 8×11 sheets both render correctly
- **Search skins** opens a field that matches against the cached petdex catalog by slug or display name; a result marked *download* fetches the sheet straight from the CDN and switches to it, one marked *installed* switches immediately
- `×` asks for a second click, then deletes that skin; deleting the current one switches to the next, deleting all of them falls back to the line drawing

## Verify a published tarball

The package can prove itself: this downloads the real tarball from npm and checks every layer in a temp directory, touching nothing on your machine.

```sh
npm run verify            # npm latest
npm run verify -- 0.2.2   # a specific version
```

It checks the download, the sha1 against the registry document, the unpacked file set (no character art, licence, both native binaries), JS and JSON parsing, the host half with a fake ctx, and — on macOS — launches the bundled native shell to confirm it renders and produces a snapshot. Expected output ends with `16/16 checks passed`.

## Development

```sh
# mac: rebuild the native shell (universal, adhoc signed)
HACHIWARE_PET_UNIVERSAL=1 sh helper/build.sh

# windows: rebuild the native shell (dotnet SDK 8)
powershell -ExecutionPolicy Bypass -File helper-win/build.ps1
```

Editing `pet/index.html` or `pet/renderer.js` takes effect on the next helper start; editing `index.js` needs a Harness restart.

## Not affiliated

This is an unofficial community plugin. Character skins are downloaded by the user from [Petdex](https://petdex.dev) and are not redistributed here. "Chiikawa" and its characters belong to their rights holders.
