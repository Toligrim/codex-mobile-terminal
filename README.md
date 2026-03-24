# Codex Terminal UI (Production-Hardened Mobile Build)

Mobile-first web terminal for iPhone Safari, backed by `node-pty` + WebSocket + `tmux`.

## What This Build Adds

- Token authentication for **all HTTP and WebSocket traffic**
- Optional source IP restriction (localhost and/or allowed subnets)
- HTTP security headers (CSP, X-Frame-Options, nosniff, no-referrer)
- Lightweight auth-failure slowdown and temporary lockout (`429` + `Retry-After`)
- Exponential reconnect backoff with reconnect status indicator
- Better iPhone viewport/keyboard/orientation handling
- Stronger focus handling after reconnect/taps/visibility changes
- Improved paste fallback when Clipboard API is blocked
- `xterm.js` web-links addon support
- Bootstrap token flow (`?token=` only for initial cookie bootstrap) + logout control
- Secure file upload to `files/tmp` from UI (`Upload` button)
- Minimal tmux quick actions (`new`, `attach`, `kill`)
- Improved PWA manifest and service worker strategy

## Project Structure

- `server/` Node.js server (`express`, `ws`, `node-pty`)
- `client/` Static frontend (`xterm.js` UI)

## Requirements

- Node.js 18+
- `tmux` installed on host

On Raspberry Pi / Debian-based systems:

```bash
sudo apt update
sudo apt install -y tmux build-essential python3 make g++
```

## Environment Configuration

- `AUTH_TOKEN` (required): shared token for HTTP + WebSocket auth
- `PORT` (optional): default `3000`
- `ALLOW_LOCALHOST` (optional): default `true`; set `false` to disable localhost bypass
- `ALLOWED_SUBNETS` (optional): comma-separated IPv4 CIDRs, e.g. `10.0.0.0/8,192.168.1.0/24`

Example:

```bash
AUTH_TOKEN='change-me-now' PORT=3000 ALLOWED_SUBNETS='10.8.0.0/24,192.168.1.0/24' npm start
```

## Install and Run

```bash
npm install
AUTH_TOKEN='change-me-now' npm start
```

Open from browser:

- `http://<server-ip>:3000/?token=<AUTH_TOKEN>`

After first authenticated load, the token is removed from URL and auth continues via secure cookie. The client keeps bootstrap token only in `sessionStorage`.

## Auth Behavior

Accepted auth inputs:

- `Authorization: Bearer <token>` header
- `?token=<token>` query parameter (bootstrap for HTTP only)
- `auth_token` cookie (set after valid query token)

If token is missing/invalid:

- HTTP routes return `401`
- WebSocket upgrade is rejected with `401` (query token is not accepted for WS)
- Repeated failures trigger slowdown and temporary `429`

## Logout

- Top bar includes `Logout` action.
- Logout clears client-side bootstrap token and requests `/api/logout` to clear auth cookie.
- Reconnect after logout will prompt for token again.

## File Uploads For Codex Analysis

- UI has `Upload` button in top bar.
- Uploaded files are saved to `files/tmp/`.
- Backend endpoint: `POST /api/upload` (auth required, same token/cookie policy).
- Max file size default: `25 MB` (`UPLOAD_MAX_BYTES` env override).

## tmux Behavior

- Desktop/default profile: `tmux new -A -s main`
- iOS profile (auto-selected): isolated tmux socket (`tmux -L mobile_web`) with:
  - `terminal-overrides 'xterm-256color:smcup@:rmcup@'`
  - increased `history-limit` (default `50000`)
- Session survives reconnects and browser refreshes
- Toolbar `Tmux` button supports:
  - `n` new session (`tmux new -A -s <name>`)
  - `a` attach session (`tmux new -A -s <name>`)
  - `k` kill session (`tmux kill-session -t <name>`)
- Optional WS/query override for testing: `tmuxProfile=default|mobile`
- iOS arbiter fallback: when xterm scrollback cannot move (`alternate` / `baseY=0`), client sends `tmux_scroll` and server drives tmux `copy-mode` via `send-keys -X scroll-up/down`
- Env overrides:
  - `TMUX_SESSION_NAME` (default: `main`)
  - `TMUX_SOCKET_DEFAULT` (empty = default tmux socket)
  - `TMUX_SOCKET_MOBILE` (default: `mobile_web`)
  - `TMUX_MOBILE_HISTORY_LIMIT` (default: `50000`)

## Mobile UX Notes

- Viewport is tied to `visualViewport` for iOS keyboard behavior
- Orientation and resize events trigger terminal fit + PTY resize
- Page scroll is prevented outside terminal viewport
- Toolbar buttons have large touch targets and haptic feedback (if supported)
- Sticky `Ctrl` key auto-resets after next input

## PWA Notes

- Manifest includes standalone display, theme colors, and icons
- Service worker uses:
  - network-first for navigation
  - stale-while-revalidate for static assets

## Trade-offs

- Auth token is shared secret auth (simple + lightweight, but not user/session-specific)
- Icons are SVG for portability and low weight (works for most modern browsers)
- tmux quick actions use prompts to keep UI minimal

## Security Recommendations

- Run behind HTTPS reverse proxy (Caddy/Nginx/Traefik)
- Use long random `AUTH_TOKEN`
- Restrict `ALLOWED_SUBNETS` to VPN/private ranges
- Rotate token if device is lost or shared

## Recommended Deployment Model (VPN-Only)

Recommended daily-driver setup:

1. Run terminal service on private network only (no public internet exposure).
2. Restrict `ALLOWED_SUBNETS` to your VPN subnet (example: `10.8.0.0/24`).
3. Access from iPhone through WireGuard/Tailscale/OpenVPN.
4. Keep reverse proxy + TLS enabled even on VPN.

Example:

```bash
AUTH_TOKEN='change-me-now' ALLOW_LOCALHOST=false ALLOWED_SUBNETS='10.8.0.0/24' npm start
```
