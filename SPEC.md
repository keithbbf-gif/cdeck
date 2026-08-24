# cDeck — COSMOS Dashboard for Windows 10 (standalone)

**Owner:** Keith · **Builders:** Grok Bot (GBt) + Grok Build 4.6 (Cursor), collaborating, tested in GitHub CI.
**Not** KDash (KDash stays with BTS-MESH). cDeck is COSMOS's own desktop deck.

## What it is
A **standalone Windows 10 desktop application** — NOT a Chrome tab, NOT a browser page — that is the control/monitoring deck for **COSMOS**. It reads the live COSMOS HTTP API (the same web service the VMC voice app and `kdash/mobile.html` use) and renders a real-time dashboard.

## Tech (recommended, Grok may override with justification)
- **Tauri** (Rust shell + a web UI). Produces a small native `.exe`/`.msi`, no Chrome/Electron bloat, cross-compiles toward Linux later (T7920/SVR1). Reuse the existing COSMOS web dashboard (`kdash/index.html` in the `cosmos` repo) as the starting UI, then evolve it into a proper deck.
- If Tauri is impractical, fall back to a small native option (WinUI/WPF or a Python PySide6 app), but keep it a **standalone app**, not a served web page.

## COSMOS API it consumes (read the `cosmos` repo `cosmos/cosmos_service.py` for exact shapes)
Base: `http://<host>:8791` (loopback, LAN, or Tailscale IP e.g. `http://100.103.9.112:8791`). Bearer optional (`--no-auth` in trial). Over Tailscale it's encrypted, plain HTTP is fine.
- `GET /api/v1/status` · `/audit` · `/jobs` · `/health` · `/spend` · `/rails` · `/makers` · `/events?since_seq=N` (append-only live feed)
- `POST /api/v1/jobs {command,priority}` · `POST /api/v1/command {text}` · `POST /api/v1/voice {transcript,session_id?,confirm_id?}` (session-continuous voice/chat seam)

## Panels (v1)
- **Status** (READY, tree_id, ledger head) · **Health** (verdict + red rows) · **Spend** (per-rail headroom, red under threshold) · **Jobs** (states) · **Rails** (matrix + probe age) · **Makers** (the CREATE map) · **Live event feed** (`/events` append-only, never refetch old — the frozen-dashboard scar).
- A **command bar** (POST /command) and a **CREATE** panel (Agent/Tool/Connector/Skill from `/makers`).
- Every panel shows its **last-refreshed age** (a panel that can't show its age is the frozen-dashboard scar).

## Non-negotiables (COSMOS canon — read `cosmos` repo docs/)
- Never cache `/api/*` as if live; always show measured age. · Configurable server URL (loopback/LAN/Tailscale) persisted. · No secrets in the repo. · Graceful when the server is down (say so, don't hang).

## CI
GitHub Actions builds the Windows artifact (Tauri: `tauri build` on windows-latest → `.msi`/`.exe` artifact). Iterate until CI is green and the artifact installs.

## Collaboration
GBt + Grok 4.6 split the work (e.g. one on the shell/build/CI, one on the panels/API client), review each other's PRs, converge on `main`. Open issues for design decisions; keep `main` green.
