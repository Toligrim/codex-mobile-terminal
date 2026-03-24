const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
const TMUX_SESSION_NAME = process.env.TMUX_SESSION_NAME || 'main';
const TMUX_PROFILE_DEFAULT = 'default';
const TMUX_PROFILE_MOBILE = 'mobile';
const TMUX_SOCKET_DEFAULT = process.env.TMUX_SOCKET_DEFAULT || '';
const TMUX_SOCKET_MOBILE = process.env.TMUX_SOCKET_MOBILE || 'mobile_web';
const TMUX_MOBILE_HISTORY_LIMIT = Number(process.env.TMUX_MOBILE_HISTORY_LIMIT || 50000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const ALLOW_LOCALHOST = process.env.ALLOW_LOCALHOST !== 'false';
const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 25 * 1024 * 1024);
const UPLOAD_DIR = path.join(__dirname, '..', 'files', 'tmp');
const AUTH_FAILURE_TTL_MS = Number(process.env.AUTH_FAILURE_TTL_MS || 30 * 60 * 1000);
const AUTH_FAILURE_SWEEP_INTERVAL_MS = Number(process.env.AUTH_FAILURE_SWEEP_INTERVAL_MS || 5 * 60 * 1000);
const ALLOWED_SUBNETS = (process.env.ALLOWED_SUBNETS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const TMUX_PROBE_TIMEOUT_MS = Number(process.env.TMUX_PROBE_TIMEOUT_MS || 900);
const NET_DIAG_ENABLED = process.env.NET_DIAG_ENABLED !== 'false';
const NET_DIAG_FILE = process.env.NET_DIAG_FILE || path.join(__dirname, '..', 'files', 'tmp', 'net-diag.log');

if (!AUTH_TOKEN) {
  // eslint-disable-next-line no-console
  console.error('AUTH_TOKEN is required. Set AUTH_TOKEN before starting the server.');
  process.exit(1);
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const wssDiag = new WebSocket.Server({ noServer: true });

let activeConnection = null;
const authFailures = new Map();

function normalizeIp(address) {
  if (!address) return '';
  if (address === '::1') return '127.0.0.1';
  if (address.startsWith('::ffff:')) return address.slice(7);
  return address;
}

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) return result;

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    try {
      result[key] = decodeURIComponent(value);
    } catch (_err) {
      result[key] = value;
    }
  }
  return result;
}

function safeParseUrl(urlText, baseUrl) {
  try {
    return new URL(urlText || '/', baseUrl);
  } catch (_err) {
    return null;
  }
}

function getRequestCid(requestLike) {
  const host = requestLike?.headers?.host || 'localhost';
  const protocol = requestLike?.headers?.['x-forwarded-proto'] || 'http';
  const url = safeParseUrl(requestLike?.url || '/', `${protocol}://${host}`);
  return String(url?.searchParams.get('cid') || '').trim();
}

function getDiagHeaders(headers = {}) {
  const keys = [
    'host',
    'origin',
    'user-agent',
    'upgrade',
    'connection',
    'sec-websocket-version',
    'sec-websocket-key',
    'x-forwarded-for',
    'x-forwarded-proto'
  ];
  const result = {};
  for (const key of keys) {
    if (headers[key]) {
      result[key] = headers[key];
    }
  }
  return result;
}

function netDiag(event, payload = {}) {
  if (!NET_DIAG_ENABLED) return;
  const entry = {
    type: 'net_diag',
    event,
    ts: Date.now(),
    ...payload
  };
  const line = `${JSON.stringify(entry)}\n`;
  try {
    fs.appendFileSync(NET_DIAG_FILE, line, 'utf8');
  } catch (_err) {
    // Ignore file write errors for diagnostics.
  }
  // eslint-disable-next-line no-console
  console.log(line.trim());
}

function parseCidr(cidrText) {
  const [rawIp, rawMask] = cidrText.split('/');
  const mask = Number(rawMask);
  if (!rawIp || !Number.isInteger(mask) || mask < 0 || mask > 32) {
    return null;
  }

  const octets = rawIp.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  const ip = octets.reduce((sum, octet) => (sum << 8) + octet, 0) >>> 0;
  const maskBits = mask === 0 ? 0 : ((0xffffffff << (32 - mask)) >>> 0);
  return { network: ip & maskBits, maskBits };
}

function ipv4ToInt(ipText) {
  const octets = ipText.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets.reduce((sum, octet) => (sum << 8) + octet, 0) >>> 0;
}

function isIpAllowed(address) {
  const ip = normalizeIp(address);
  if (!ip) return false;

  if (ALLOW_LOCALHOST && ip === '127.0.0.1') {
    return true;
  }

  if (ALLOWED_SUBNETS.length === 0) {
    return true;
  }

  const value = ipv4ToInt(ip);
  if (value === null) return false;

  for (const cidrText of ALLOWED_SUBNETS) {
    const cidr = parseCidr(cidrText);
    if (!cidr) continue;
    if ((value & cidr.maskBits) === cidr.network) {
      return true;
    }
  }

  return false;
}

function getFailureState(ip) {
  const state = authFailures.get(ip) || { count: 0, blockedUntil: 0, expiresAt: 0 };
  const now = Date.now();
  if (state.expiresAt <= now && state.blockedUntil <= now) {
    authFailures.delete(ip);
    return { count: 0, blockedUntil: 0, expiresAt: 0 };
  }
  return state;
}

function resetFailureState(ip) {
  authFailures.delete(ip);
}

function registerAuthFailure(ip) {
  const state = getFailureState(ip);
  const nextCount = Math.min(50, state.count + 1);
  let blockedUntil = state.blockedUntil;

  if (nextCount >= 8) {
    const blockMs = Math.min(60000, (nextCount - 7) * 5000);
    blockedUntil = Date.now() + blockMs;
  }

  authFailures.set(ip, {
    count: nextCount,
    blockedUntil,
    expiresAt: Date.now() + AUTH_FAILURE_TTL_MS
  });
}

function authSlowdownMs(ip) {
  const state = getFailureState(ip);
  if (state.count <= 0) return 0;
  return Math.min(2500, state.count * 200);
}

function isAuthBlocked(ip) {
  const state = getFailureState(ip);
  return state.blockedUntil > Date.now();
}

function setSecurityHeaders(req, res, next) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

function extractTokenFromRequestLike(requestLike, options = {}) {
  const cookies = parseCookies(requestLike.headers?.cookie);
  const authHeader = requestLike.headers?.authorization || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return bearerMatch[1].trim();
  }

  if (cookies.auth_token) {
    return cookies.auth_token;
  }

  if (!options.allowQueryToken) {
    return '';
  }

  const host = requestLike.headers?.host || 'localhost';
  const protocol = requestLike.headers?.['x-forwarded-proto'] || 'http';
  const url = safeParseUrl(requestLike.url, `${protocol}://${host}`);
  if (!url) return '';
  return (url.searchParams.get('token') || '').trim();
}

function isAuthenticated(requestLike, options = {}) {
  return extractTokenFromRequestLike(requestLike, options) === AUTH_TOKEN;
}

function setAuthCookie(req, res, value, maxAgeSeconds) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const cookieParts = [
    `auth_token=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function setAuthCookieIfBootstrapToken(req, res) {
  const queryToken = (req.query?.token || '').trim();
  if (!queryToken || queryToken !== AUTH_TOKEN) {
    return;
  }

  const existingCookies = parseCookies(req.headers.cookie);
  if (existingCookies.auth_token === AUTH_TOKEN) {
    return;
  }

  setAuthCookie(req, res, AUTH_TOKEN, 2592000);
}

function clearAuthCookie(req, res) {
  setAuthCookie(req, res, '', 0);
}

function authMiddleware(req, res, next) {
  const ip = normalizeIp(req.socket.remoteAddress);
  const allowBootstrapToken =
    req.path === '/' ||
    req.path === '/index.html' ||
    req.path === '/api/bootstrap' ||
    req.path === '/api/ws-preflight' ||
    req.path === '/api/ws-postflight';
  if (!isIpAllowed(ip)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  if (isAuthBlocked(ip)) {
    const waitMs = Math.max(0, getFailureState(ip).blockedUntil - Date.now());
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(waitMs / 1000))));
    res.status(429).json({ error: 'too_many_attempts' });
    return;
  }

  if (!isAuthenticated(req, { allowQueryToken: allowBootstrapToken })) {
    // eslint-disable-next-line no-console
    console.warn(
      `[auth] unauthorized path=${req.path} ip=${ip} hasCookie=${Boolean(parseCookies(req.headers.cookie).auth_token)} hasAuthHeader=${Boolean(
        req.headers.authorization
      )} hasQueryToken=${Boolean((req.query?.token || '').trim())}`
    );
    registerAuthFailure(ip);
    const delayMs = authSlowdownMs(ip);
    setTimeout(() => {
      res.status(401).json({ error: 'unauthorized' });
    }, delayMs);
    return;
  }

  resetFailureState(ip);
  setAuthCookieIfBootstrapToken(req, res);
  next();
}

function writeUpgradeError(socket, statusCode, message, headers = {}) {
  const headerLines = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
  const suffix = headerLines ? `${headerLines}\r\n` : '';
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\n${suffix}Connection: close\r\n\r\n`);
  socket.destroy();
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sessionIsValid(sessionName) {
  return /^[a-zA-Z0-9_-]{1,32}$/.test(sessionName);
}

function getTmuxSocketName(profile) {
  if (profile === TMUX_PROFILE_MOBILE) {
    return TMUX_SOCKET_MOBILE;
  }
  return TMUX_SOCKET_DEFAULT;
}

function getTmuxPrefix(profile) {
  const socketName = getTmuxSocketName(profile);
  if (!socketName) {
    return 'tmux';
  }
  return `tmux -L ${socketName}`;
}

function isLikelyIOSUserAgent(userAgent) {
  const ua = String(userAgent || '');
  return /iPhone|iPad|iPod/i.test(ua) || (ua.includes('Macintosh') && ua.includes('Mobile'));
}

function getTmuxProfileFromRequest(req) {
  const host = req.headers.host || 'localhost';
  const url = safeParseUrl(req.url, `http://${host}`);
  const fromQuery = String(url?.searchParams.get('tmuxProfile') || '')
    .trim()
    .toLowerCase();
  if (fromQuery === TMUX_PROFILE_MOBILE || fromQuery === TMUX_PROFILE_DEFAULT) {
    return fromQuery;
  }
  return isLikelyIOSUserAgent(req.headers['user-agent']) ? TMUX_PROFILE_MOBILE : TMUX_PROFILE_DEFAULT;
}

function buildTmuxCommand(profile) {
  const tmuxPrefix = getTmuxPrefix(profile);
  if (profile !== TMUX_PROFILE_MOBILE) {
    return `exec ${tmuxPrefix} new -A -s ${TMUX_SESSION_NAME}`;
  }
  const safeHistoryLimit = Number.isFinite(TMUX_MOBILE_HISTORY_LIMIT) ? Math.max(2000, TMUX_MOBILE_HISTORY_LIMIT) : 50000;
  return [
    `${tmuxPrefix} set -g history-limit ${safeHistoryLimit} >/dev/null 2>&1`,
    `${tmuxPrefix} set -g terminal-overrides 'xterm-256color:smcup@:rmcup@' >/dev/null 2>&1`,
    `exec ${tmuxPrefix} new -A -s ${TMUX_SESSION_NAME}`
  ].join('; ');
}

function execFileText(cmd, args, timeoutMs = TMUX_PROBE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function parseTmuxPaneRows(rawText) {
  const rows = [];
  for (const line of String(rawText || '').split('\n')) {
    if (!line.trim()) continue;
    const [sessionName, windowIndex, paneIndex, paneActive, alternateOn, paneInMode, historySize, historyLimit] =
      line.split('\t');
    rows.push({
      sessionName: String(sessionName || ''),
      windowIndex: Number(windowIndex),
      paneIndex: Number(paneIndex),
      paneActive: Number(paneActive),
      alternateOn: Number(alternateOn),
      paneInMode: Number(paneInMode),
      historySize: Number(historySize),
      historyLimit: Number(historyLimit)
    });
  }
  return rows;
}

async function probeTmuxState(preferredSession = TMUX_SESSION_NAME, socketName = '') {
  const format = '#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_active}\t#{alternate_on}\t#{pane_in_mode}\t#{history_size}\t#{history_limit}';
  const args = [];
  if (socketName) {
    args.push('-L', socketName);
  }
  args.push('list-panes', '-a', '-F', format);
  try {
    const stdout = await execFileText('tmux', args);
    const panes = parseTmuxPaneRows(stdout);
    if (panes.length === 0) {
      return { ok: false, error: 'no_panes' };
    }

    let pane =
      panes.find((item) => item.sessionName === preferredSession && item.paneActive === 1) ||
      panes.find((item) => item.sessionName === preferredSession) ||
      panes.find((item) => item.paneActive === 1) ||
      panes[0];

    return {
      ok: true,
      sessionName: pane.sessionName,
      windowIndex: Number.isFinite(pane.windowIndex) ? pane.windowIndex : null,
      paneIndex: Number.isFinite(pane.paneIndex) ? pane.paneIndex : null,
      paneTarget:
        Number.isFinite(pane.windowIndex) && Number.isFinite(pane.paneIndex)
          ? `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`
          : null,
      alternateOn: Number.isFinite(pane.alternateOn) ? pane.alternateOn : null,
      paneInMode: Number.isFinite(pane.paneInMode) ? pane.paneInMode : null,
      historySize: Number.isFinite(pane.historySize) ? pane.historySize : null,
      historyLimit: Number.isFinite(pane.historyLimit) ? pane.historyLimit : null,
      paneCount: panes.length
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.killed ? 'timeout' : 'probe_failed',
      stderr: String(error?.stderr || '').trim().slice(0, 180)
    };
  }
}

async function performTmuxScroll(socketName, preferredSession, rawLines) {
  const lines = Math.trunc(Number(rawLines) || 0);
  if (!Number.isFinite(lines) || lines === 0) {
    return { ok: false, error: 'invalid_lines' };
  }

  const tmux = await probeTmuxState(preferredSession, socketName);
  if (!tmux.ok || !tmux.paneTarget) {
    return { ok: false, error: tmux.error || 'no_pane_target', tmux };
  }

  const direction = lines < 0 ? 'scroll-up' : 'scroll-down';
  const count = Math.min(100, Math.max(1, Math.abs(lines)));
  const argsPrefix = socketName ? ['-L', socketName] : [];

  try {
    await execFileText('tmux', [...argsPrefix, 'copy-mode', '-e', '-t', tmux.paneTarget]);
    await execFileText('tmux', [...argsPrefix, 'send-keys', '-X', '-N', String(count), '-t', tmux.paneTarget, direction]);
    const after = await probeTmuxState(preferredSession, socketName);
    return { ok: true, direction, count, paneTarget: tmux.paneTarget, tmux: after };
  } catch (error) {
    return {
      ok: false,
      error: 'scroll_failed',
      stderr: String(error?.stderr || '').trim().slice(0, 180),
      paneTarget: tmux.paneTarget
    };
  }
}

function handleTmuxAction(shellPty, ws, action, sessionName, tmuxPrefix = 'tmux') {
  const target = sessionName || TMUX_SESSION_NAME;
  if (!sessionIsValid(target)) {
    send(ws, {
      type: 'status',
      state: 'error',
      detail: 'Invalid session name. Use letters, numbers, dash, underscore.'
    });
    return;
  }

  if (action === 'new') {
    shellPty.write(`${tmuxPrefix} new -A -s ${target}\r`);
    return;
  }

  if (action === 'attach') {
    shellPty.write(`${tmuxPrefix} new -A -s ${target}\r`);
    return;
  }

  if (action === 'kill') {
    shellPty.write(`${tmuxPrefix} kill-session -t ${target}\r`);
    return;
  }

  send(ws, {
    type: 'status',
    state: 'error',
    detail: 'Unsupported tmux action.'
  });
}

function cleanupConnection(connection, reasonCode = 1000, reason = 'closed') {
  if (!connection || connection.cleanedUp) {
    return;
  }

  connection.cleanedUp = true;

  try {
    connection.shellPty.kill();
  } catch (_err) {
    // Ignore pty kill errors.
  }

  try {
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.close(reasonCode, reason);
    }
  } catch (_err) {
    // Ignore ws close errors.
  }

  if (activeConnection === connection) {
    activeConnection = null;
  }
}

function sanitizeFilename(inputName) {
  const base = path.basename(String(inputName || '').trim());
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') {
    return '';
  }
  return safe.slice(0, 120);
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function analyzeGestureLog(logs) {
  const safeLogs = Array.isArray(logs) ? logs : [];
  const summary = {
    events: safeLogs.length,
    durationMs: 0,
    maxBaseY: 0,
    maxViewportY: 0,
    viewportMoves: 0,
    viewportJumpsWithoutTermMove: 0,
    arbiterScrollEvents: 0,
    nativeTouchScrollEvents: 0,
    scrollGestures: 0,
    diagEvents: 0,
    diagServerEvents: 0,
    tmuxAlternateOnSeen: 0,
    tmuxPaneInModeSeen: 0,
    tmuxMaxHistorySize: 0,
    tmuxMinHistoryLimit: null,
    status: 'unknown'
  };

  if (safeLogs.length === 0) {
    summary.status = 'empty_log';
    return summary;
  }

  const firstTs = toFiniteNumber(safeLogs[0]?.t);
  const lastTs = toFiniteNumber(safeLogs[safeLogs.length - 1]?.t);
  if (firstTs !== null && lastTs !== null && lastTs >= firstTs) {
    summary.durationMs = Math.round(lastTs - firstTs);
  }

  let prevSnapshot = null;
  for (const event of safeLogs) {
    if (event?.type === 'gesture' && event?.to === 'scroll') {
      summary.scrollGestures += 1;
    }
    if (event?.type === 'viewport' && event?.source === 'touchmove_arbiter') {
      summary.arbiterScrollEvents += 1;
    }
    if (event?.type === 'viewport' && event?.source === 'touchmove_scroll') {
      summary.nativeTouchScrollEvents += 1;
    }
    if (event?.type === 'diag') {
      summary.diagEvents += 1;
    }
    if (event?.type === 'diag_server') {
      summary.diagServerEvents += 1;
      const alternateOn = toFiniteNumber(event?.tmux?.alternateOn);
      const paneInMode = toFiniteNumber(event?.tmux?.paneInMode);
      const historySize = toFiniteNumber(event?.tmux?.historySize);
      const historyLimit = toFiniteNumber(event?.tmux?.historyLimit);
      if (alternateOn === 1) {
        summary.tmuxAlternateOnSeen += 1;
      }
      if (paneInMode === 1) {
        summary.tmuxPaneInModeSeen += 1;
      }
      if (historySize !== null) {
        summary.tmuxMaxHistorySize = Math.max(summary.tmuxMaxHistorySize, historySize);
      }
      if (historyLimit !== null) {
        summary.tmuxMinHistoryLimit =
          summary.tmuxMinHistoryLimit === null ? historyLimit : Math.min(summary.tmuxMinHistoryLimit, historyLimit);
      }
    }

    const snapshot = {
      vvTop: toFiniteNumber(event?.vvTop),
      vvH: toFiniteNumber(event?.vvH),
      xtermViewportScrollTop: toFiniteNumber(event?.xtermViewportScrollTop),
      termViewportY: toFiniteNumber(event?.termViewportY),
      termBaseY: toFiniteNumber(event?.termBaseY)
    };

    if (snapshot.termBaseY !== null) {
      summary.maxBaseY = Math.max(summary.maxBaseY, snapshot.termBaseY);
    }
    if (snapshot.termViewportY !== null) {
      summary.maxViewportY = Math.max(summary.maxViewportY, snapshot.termViewportY);
    }

    if (prevSnapshot && snapshot.termViewportY !== null && prevSnapshot.termViewportY !== null) {
      const termMoved = snapshot.termViewportY !== prevSnapshot.termViewportY;
      if (termMoved) {
        summary.viewportMoves += 1;
      } else {
        const visualChanged =
          snapshot.vvTop !== prevSnapshot.vvTop || snapshot.vvH !== prevSnapshot.vvH;
        const nativeScrollChanged = snapshot.xtermViewportScrollTop !== prevSnapshot.xtermViewportScrollTop;
        if (visualChanged && !nativeScrollChanged) {
          summary.viewportJumpsWithoutTermMove += 1;
        }
      }
    }

    prevSnapshot = snapshot;
  }

  if (summary.maxBaseY <= 0) {
    summary.status = 'no_scrollback';
  } else if (summary.viewportMoves > 0) {
    summary.status = 'term_scroll_detected';
  } else if (summary.arbiterScrollEvents > 0 || summary.nativeTouchScrollEvents > 0) {
    summary.status = 'scroll_input_seen_no_term_move';
  } else {
    summary.status = 'no_scroll_input_detected';
  }

  return summary;
}

app.use(setSecurityHeaders);

app.post('/api/logout', (req, res) => {
  const ip = normalizeIp(req.socket.remoteAddress);
  if (!isIpAllowed(ip)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  clearAuthCookie(req, res);
  res.json({ ok: true });
});

app.use(authMiddleware);
app.post(
  '/api/upload',
  express.raw({ type: 'application/octet-stream', limit: UPLOAD_MAX_BYTES }),
  async (req, res) => {
    let rawName = '';
    try {
      rawName = decodeURIComponent(String(req.headers['x-file-name'] || ''));
    } catch (_err) {
      res.status(400).json({ error: 'invalid_filename' });
      return;
    }
    const safeName = sanitizeFilename(rawName);
    if (!safeName) {
      res.status(400).json({ error: 'invalid_filename' });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'empty_file' });
      return;
    }

    const targetName = `${Date.now()}-${safeName}`;
    const targetPath = path.join(UPLOAD_DIR, targetName);

    try {
      await fs.promises.writeFile(targetPath, req.body, { flag: 'wx' });
      res.json({
        ok: true,
        fileName: targetName,
        relativePath: path.posix.join('files', 'tmp', targetName),
        size: req.body.length
      });
    } catch (_err) {
      res.status(500).json({ error: 'upload_failed' });
    }
  }
);

app.post('/api/debug-log', express.json({ limit: '1mb' }), async (req, res) => {
  const logs = Array.isArray(req.body) ? req.body : req.body?.logs;
  if (!Array.isArray(logs)) {
    res.status(400).json({ error: 'invalid_payload' });
    return;
  }

  const summary = analyzeGestureLog(logs);
  const targetName = `${Date.now()}-gesture-debug.json`;
  const targetPath = path.join(UPLOAD_DIR, targetName);
  const doc = {
    uploadedAt: new Date().toISOString(),
    summary,
    meta: req.body?.meta || {},
    logs
  };

  try {
    await fs.promises.writeFile(targetPath, JSON.stringify(doc, null, 2), { flag: 'wx' });
    res.json({
      ok: true,
      fileName: targetName,
      relativePath: path.posix.join('files', 'tmp', targetName),
      summary
    });
  } catch (_err) {
    res.status(500).json({ error: 'upload_failed' });
  }
});
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit')));
app.use('/vendor/xterm-addon-web-links', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-web-links')));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/bootstrap', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/ws-preflight', (req, res) => {
  const cid = getRequestCid(req);
  netDiag('ws_preflight', {
    cid: cid || null,
    ip: normalizeIp(req.socket.remoteAddress),
    headers: getDiagHeaders(req.headers)
  });
  res.json({ ok: true, cid: cid || null, serverTime: Date.now() });
});

app.get('/api/ws-postflight', (req, res) => {
  const cid = getRequestCid(req);
  const action = String(req.query?.a || '').trim();
  const readyState = Number(req.query?.rs);
  netDiag('ws_postflight', {
    cid: cid || null,
    action: action || null,
    readyState: Number.isFinite(readyState) ? readyState : null,
    ip: normalizeIp(req.socket.remoteAddress),
    headers: getDiagHeaders(req.headers)
  });
  res.json({ ok: true, cid: cid || null, action: action || null, readyState: Number.isFinite(readyState) ? readyState : null });
});

server.on('connection', (socket) => {
  netDiag('tcp_connection', {
    ip: normalizeIp(socket.remoteAddress),
    remotePort: Number(socket.remotePort || 0),
    localAddress: socket.localAddress || '',
    localPort: Number(socket.localPort || 0)
  });
});

server.on('request', (req) => {
  netDiag('http_request', {
    cid: getRequestCid(req) || null,
    ip: normalizeIp(req.socket.remoteAddress),
    method: req.method,
    url: req.url,
    headers: getDiagHeaders(req.headers)
  });
});

server.on('clientError', (error, socket) => {
  netDiag('http_client_error', {
    error: String(error && error.message ? error.message : error),
    ip: normalizeIp(socket.remoteAddress),
    remotePort: Number(socket.remotePort || 0)
  });
});

server.on('upgrade', (req, socket, head) => {
  const host = req.headers.host || 'localhost';
  const url = safeParseUrl(req.url, `http://${host}`);
  const ip = normalizeIp(req.socket.remoteAddress);
  const cid = getRequestCid(req);
  const cookieToken = parseCookies(req.headers.cookie).auth_token;
  const authHeader = req.headers.authorization || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!url) {
    // eslint-disable-next-line no-console
    console.warn(`[ws-upgrade] bad_url ip=${ip}`);
    writeUpgradeError(socket, 400, 'Bad Request');
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[ws-upgrade] incoming ip=${ip} path=${url.pathname} hasCookie=${Boolean(cookieToken)} hasQueryToken=${Boolean(
      (url.searchParams.get('token') || '').trim()
    )} hasAuthHeader=${Boolean(bearerMatch)}`
  );
  netDiag('http_upgrade', {
    cid: cid || null,
    ip,
    path: url.pathname,
    headLen: Number(head?.length || 0),
    hasCookie: Boolean(cookieToken),
    hasQueryToken: Boolean((url.searchParams.get('token') || '').trim()),
    headers: getDiagHeaders(req.headers)
  });

  if (url.pathname !== '/ws' && url.pathname !== '/ws-diag') {
    // eslint-disable-next-line no-console
    console.warn(`[ws-upgrade] not_found ip=${ip} path=${url.pathname}`);
    writeUpgradeError(socket, 404, 'Not Found');
    return;
  }

  if (!isIpAllowed(ip)) {
    // eslint-disable-next-line no-console
    console.warn(`[ws-upgrade] forbidden_ip ip=${ip}`);
    writeUpgradeError(socket, 403, 'Forbidden');
    return;
  }

  if (isAuthBlocked(ip)) {
    const waitMs = Math.max(0, getFailureState(ip).blockedUntil - Date.now());
    writeUpgradeError(socket, 429, 'Too Many Requests', {
      'Retry-After': String(Math.max(1, Math.ceil(waitMs / 1000)))
    });
    return;
  }

  // iOS/Safari can intermittently drop auth cookie on WS upgrade; allow bootstrap token query as fallback.
  if (!isAuthenticated(req, { allowQueryToken: true })) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ws-upgrade] unauthorized ip=${ip} hasCookie=${Boolean(parseCookies(req.headers.cookie).auth_token)} hasAuthHeader=${Boolean(
        req.headers.authorization
      )} hasQueryToken=${Boolean((url.searchParams.get('token') || '').trim())}`
    );
    registerAuthFailure(ip);
    const delayMs = authSlowdownMs(ip);
    setTimeout(() => {
      writeUpgradeError(socket, 401, 'Unauthorized');
    }, delayMs);
    return;
  }

  resetFailureState(ip);
  // eslint-disable-next-line no-console
  console.log(`[ws-upgrade] authorized ip=${ip}`);

  if (url.pathname === '/ws-diag') {
    wssDiag.handleUpgrade(req, socket, head, (ws) => {
      wssDiag.emit('connection', ws, req);
    });
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wssDiag.on('connection', (ws, req) => {
  const cid = getRequestCid(req);
  netDiag('ws_diag_connection', {
    cid: cid || null,
    ip: normalizeIp(req.socket.remoteAddress),
    url: req.url
  });
  send(ws, { type: 'ws_diag_ready', cid: cid || null, ts: Date.now() });

  ws.on('message', (message) => {
    send(ws, { type: 'ws_diag_echo', cid: cid || null, ts: Date.now(), data: String(message || '') });
  });
});

wss.on('connection', (ws, req) => {
  const cid = getRequestCid(req);
  const tmuxProfile = getTmuxProfileFromRequest(req);
  const tmuxPrefix = getTmuxPrefix(tmuxProfile);
  const tmuxSocketName = getTmuxSocketName(tmuxProfile);
  const tmuxCommand = buildTmuxCommand(tmuxProfile);
  // eslint-disable-next-line no-console
  console.log(`[ws] connection_open profile=${tmuxProfile || TMUX_PROFILE_DEFAULT} socket=${tmuxSocketName || 'default'}`);
  netDiag('ws_connection_open', {
    cid: cid || null,
    ip: normalizeIp(req.socket.remoteAddress),
    profile: tmuxProfile || TMUX_PROFILE_DEFAULT,
    socket: tmuxSocketName || 'default',
    url: req.url
  });
  if (activeConnection && activeConnection.ws.readyState === WebSocket.OPEN) {
    cleanupConnection(activeConnection, 1000, 'Replaced by a new client connection');
  }

  const shellPty = pty.spawn(SHELL, ['-lc', tmuxCommand], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: {
      ...process.env,
      TERM: 'xterm-256color'
    }
  });

  const connection = {
    ws,
    shellPty,
    cleanedUp: false,
    tmuxProfile,
    tmuxPrefix,
    tmuxSocketName
  };
  activeConnection = connection;
  send(ws, { type: 'status', state: 'connected', tmuxProfile, tmuxSocketName: tmuxSocketName || null });

  shellPty.onData((data) => {
    send(ws, { type: 'output', data });
  });

  shellPty.onExit(({ exitCode, signal }) => {
    send(ws, {
      type: 'status',
      state: 'closed',
      detail: `Shell exited (code=${exitCode}, signal=${signal})`
    });
    cleanupConnection(connection, 1011, 'Shell exited');
  });

  ws.on('message', async (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch (_err) {
      return;
    }

    if (message.type === 'input' && typeof message.data === 'string') {
      shellPty.write(message.data);
      return;
    }

    if (message.type === 'resize') {
      const cols = Number(message.cols);
      const rows = Number(message.rows);
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 1 && rows > 1) {
        shellPty.resize(cols, rows);
      }
      return;
    }

    if (message.type === 'tmux_action') {
      handleTmuxAction(shellPty, ws, message.action, String(message.session || TMUX_SESSION_NAME), connection.tmuxPrefix);
      return;
    }

    if (message.type === 'tmux_scroll') {
      const result = await performTmuxScroll(connection.tmuxSocketName, TMUX_SESSION_NAME, message.lines);
      send(ws, {
        type: 'tmux_scroll_result',
        ts: Date.now(),
        requestedLines: Math.trunc(Number(message.lines) || 0),
        result
      });
      return;
    }

    if (message.type === 'diag_probe') {
      const requestId = String(message.requestId || '');
      const reason = String(message.reason || 'unspecified');
      const tmux = await probeTmuxState(TMUX_SESSION_NAME, connection.tmuxSocketName);
      send(ws, {
        type: 'diag_probe_result',
        requestId,
        reason,
        ts: Date.now(),
        tmux,
        client: message.client && typeof message.client === 'object' ? message.client : null
      });
    }
  });

  ws.on('close', () => {
    netDiag('ws_connection_close', {
      cid: cid || null
    });
    cleanupConnection(connection);
  });

  ws.on('error', () => {
    netDiag('ws_connection_error', {
      cid: cid || null
    });
    cleanupConnection(connection);
  });
});

function shutdown() {
  cleanupConnection(activeConnection, 1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of authFailures.entries()) {
    if ((state.expiresAt || 0) <= now && state.blockedUntil <= now) {
      authFailures.delete(ip);
    }
  }
}, AUTH_FAILURE_SWEEP_INTERVAL_MS).unref();

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Terminal server listening on http://0.0.0.0:${PORT}`);
});
