# cDeck

Standalone **Windows 10** desktop dashboard for [COSMOS](https://github.com/keithbbf-gif/cosmos). Native Tauri shell (Rust) + local web UI. Not a browser tab, not KDash.

Reads the live COSMOS HTTP API (`http://<host>:8791`) and renders Status, Health, Spend, Jobs, Rails, Makers / CREATE, a command bar, and an append-only live event feed.

Full brief: [`SPEC.md`](SPEC.md).

## What it talks to

| Method | Path | Panel |
| --- | --- | --- |
| GET | `/api/v1/status` | Status (READY, `tree_id`, ledger head) |
| GET | `/api/v1/health` | Health (verdict + red rows) |
| GET | `/api/v1/spend` | Spend (per-rail headroom) |
| GET | `/api/v1/jobs` | Jobs (states) |
| GET | `/api/v1/rails` | Rails matrix + probe age |
| GET | `/api/v1/makers` | Makers map; CREATE filters `?kind=` |
| GET | `/api/v1/events?since_seq=N` | Live feed — append-only, never refetches old seq |
| POST | `/api/v1/command` `{text}` | Command bar |

Every panel shows **measured age**. A down server is named as down (8s timeout); the deck does not hang. Last good data stays on screen with its age.

The **server URL** (loopback, LAN, or Tailscale, e.g. `http://100.103.9.112:8791`) is persisted in the app config dir. The **bearer token is never written to disk** — session memory only. Leave it blank when COSMOS is running `--no-auth`.

No secrets belong in this repo.

## Prerequisites

- Windows 10 (or later) with [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (bundled with recent Edge; the installer can fetch it)
- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) stable (MSVC toolchain on Windows: `rustup default stable-msvc`)
- A running COSMOS service on port **8791** (or whatever URL you configure)

## Run (dev)

```bat
npm install
npm run tauri dev
```

The window opens against `ui/`. Default server URL is `http://127.0.0.1:8791`. Paste a bearer if the kernel requires one, then CONNECT. Changing the URL resets the event-feed cursor so a different ledger is not mixed with the previous one.

## Build (Windows `.msi` / `.exe`)

```bat
npm install
npm run tauri build
```

Artifacts land in:

- `src-tauri/target/release/bundle/msi/*.msi`
- `src-tauri/target/release/bundle/nsis/*.exe`

GitHub Actions (`.github/workflows/build.yml`) runs the same `tauri build` on `windows-latest` and uploads those artifacts.

## Layout

```
ui/                 static deck (no CDN, no bundler)
src-tauri/          Rust shell — HTTP proxy, URL persistence
.github/workflows/  Windows CI
```

COSMOS HTTP is **proxied in Rust** (`api_request`) so the webview never depends on CORS and every call has a hard timeout.

## License

Same owner as COSMOS (Keith). Internal deck.
