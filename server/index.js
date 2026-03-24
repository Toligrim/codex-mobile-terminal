const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pty = require('node-pty');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
const TMUX_COMMAND = 'tmux new -A -s main';
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

if (!AUTH_TOKEN) {
  // eslint-disable-next-line no-console
  console.error('AUTH_TOKEN is required. Set AUTH_TOKEN before starting the server.');
  process.exit(1);
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

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
  const allowBootstrapToken = req.path === '/' || req.path === '/index.html' || req.path === '/api/bootstrap';
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

function handleTmuxAction(shellPty, ws, action, sessionName) {
  const target = sessionName || 'main';
  if (!sessionIsValid(target)) {
    send(ws, {
      type: 'status',
      state: 'error',
      detail: 'Invalid session name. Use letters, numbers, dash, underscore.'
    });
    return;
  }

  if (action === 'new') {
    shellPty.write(`tmux new -A -s ${target}\r`);
    return;
  }

  if (action === 'attach') {
    shellPty.write(`tmux new -A -s ${target}\r`);
    return;
  }

  if (action === 'kill') {
    shellPty.write(`tmux kill-session -t ${target}\r`);
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

server.on('upgrade', (req, socket, head) => {
  const host = req.headers.host || 'localhost';
  const url = safeParseUrl(req.url, `http://${host}`);
  const ip = normalizeIp(req.socket.remoteAddress);
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

  if (url.pathname !== '/ws') {
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

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  // eslint-disable-next-line no-console
  console.log('[ws] connection_open');
  if (activeConnection && activeConnection.ws.readyState === WebSocket.OPEN) {
    cleanupConnection(activeConnection, 1000, 'Replaced by a new client connection');
  }

  const shellPty = pty.spawn(SHELL, ['-lc', TMUX_COMMAND], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: {
      ...process.env,
      TERM: 'xterm-256color'
    }
  });

  const connection = { ws, shellPty, cleanedUp: false };
  activeConnection = connection;
  send(ws, { type: 'status', state: 'connected' });

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

  ws.on('message', (rawMessage) => {
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
      handleTmuxAction(shellPty, ws, message.action, String(message.session || 'main'));
    }
  });

  ws.on('close', () => {
    cleanupConnection(connection);
  });

  ws.on('error', () => {
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
