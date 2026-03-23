const statusEl = document.getElementById('status');
const terminalEl = document.getElementById('terminal');
const terminalWrapEl = document.getElementById('terminal-wrap');
const toolbarEl = document.querySelector('.toolbar');
const topbarEl = document.getElementById('topbar');
const ctrlButton = document.querySelector('[data-action="ctrl"]');
const modeToggleButton = document.getElementById('mode-toggle');
const toolbarToggleButton = document.getElementById('toolbar-toggle');
const uploadButton = document.getElementById('upload');
const logoutButton = document.getElementById('logout');
const fileInputEl = document.getElementById('file-input');
const appEl = document.getElementById('app');

const fontSizes = [10, 12, 14, 16, 18, 20];
const reconnectBaseMs = 800;
const reconnectMaxMs = 10000;
const STORAGE_BOOTSTRAP_TOKEN = 'bootstrap_token';
const STORAGE_FONT_SIZE = 'terminal_font_size';
const STORAGE_GESTURE_DEBUG = 'gesture_debug_enabled';
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

let fontIndex = 2;
let ctrlArmed = false;
let socket = null;
let socketCleanup = null;
let reconnectTimer = null;
let focusTimer = null;
let reconnectAttempt = 0;
let reconnectLocked = false;
let connectedOnce = false;
let isConnecting = false;
let toolbarCollapsed = false;
let inputMode = false;
let gestureMode = 'idle';
let touchStartX = 0;
let touchStartY = 0;
let touchStartTs = 0;
let focusSuppressedUntil = 0;
let pinchMoveListenerAttached = false;
let lastAppliedViewportHeight = 0;
let lastDebugViewportLogTs = 0;
let pinchState = {
  active: false,
  startDistance: 0,
  startSize: 14
};
const TAP_MOVE_THRESHOLD_PX = 8;
const TAP_MAX_DURATION_MS = 280;
const FOCUS_SCROLL_SUPPRESS_MS = 180;
const FOCUS_PINCH_SUPPRESS_MS = 240;
const DEBUG_LOG_LIMIT = 400;
const AUTH_FETCH_TIMEOUT_MS = 8000;
const WS_CONNECT_TIMEOUT_MS = 8000;

function getSavedFontSize() {
  const saved = Number(localStorage.getItem(STORAGE_FONT_SIZE));
  if (!Number.isFinite(saved)) {
    return fontSizes[fontIndex];
  }
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(saved)));
}

function setTerminalFontSize(nextSize) {
  const safeSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(nextSize)));
  term.options.fontSize = safeSize;
  localStorage.setItem(STORAGE_FONT_SIZE, String(safeSize));
  gestureDebug.push('fit', { reason: 'font_set', fontSize: safeSize });
  fitAndResize();
}

const term = new Terminal({
  cursorBlink: true,
  convertEol: true,
  fontFamily: "Menlo, Monaco, Consolas, 'SF Mono', monospace",
  fontSize: getSavedFontSize(),
  lineHeight: 1.24,
  cursorStyle: 'block',
  theme: {
    background: '#0f131a',
    foreground: '#e6edf3',
    cursor: '#7cc7ff',
    selectionBackground: '#27415f'
  },
  scrollback: 8000
});

const fitAddon = new FitAddon.FitAddon();
const webLinksAddon = new WebLinksAddon.WebLinksAddon();
term.loadAddon(fitAddon);
term.loadAddon(webLinksAddon);
term.open(terminalEl);

const gestureDebug = (() => {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get('debugGesture');
  let enabled = fromQuery === '1' || localStorage.getItem(STORAGE_GESTURE_DEBUG) === '1';
  const logs = [];

  function push(type, payload = {}) {
    if (!enabled) return;
    logs.push({ t: Date.now(), type, ...payload });
    if (logs.length > DEBUG_LOG_LIMIT) logs.shift();
  }

  function snapshot() {
    const vv = window.visualViewport;
    const xtermViewport = terminalEl.querySelector('.xterm-viewport');
    return {
      vvTop: vv ? Math.round(vv.offsetTop) : null,
      vvH: vv ? Math.round(vv.height) : null,
      winY: Math.round(window.scrollY),
      xtermViewportScrollTop: xtermViewport ? Math.round(xtermViewport.scrollTop) : null,
      termViewportY: term.buffer.active.viewportY,
      termBaseY: term.buffer.active.baseY
    };
  }

  window.__termGestureDebug = {
    enable() {
      enabled = true;
      localStorage.setItem(STORAGE_GESTURE_DEBUG, '1');
    },
    disable() {
      enabled = false;
      localStorage.setItem(STORAGE_GESTURE_DEBUG, '0');
    },
    clear() {
      logs.length = 0;
    },
    dump() {
      return logs.slice();
    },
    state() {
      return { enabled, size: logs.length };
    }
  };

  return {
    push,
    snapshot,
    dump() {
      return window.__termGestureDebug.dump();
    },
    isEnabled() {
      return enabled;
    }
  };
})();

term.onScroll(() => {
  if (!gestureDebug.isEnabled()) return;
  const nowTs = Date.now();
  if (nowTs - lastDebugViewportLogTs < 120) return;
  lastDebugViewportLogTs = nowTs;
  gestureDebug.push('viewport', { source: 'term_scroll', ...gestureDebug.snapshot() });
});

function installDebugExportButton() {
  if (!gestureDebug.isEnabled()) return;
  if (document.getElementById('debug-export')) return;

  const button = document.createElement('button');
  button.id = 'debug-export';
  button.type = 'button';
  button.textContent = 'Debug Log';
  button.style.position = 'fixed';
  button.style.right = '8px';
  button.style.bottom = '8px';
  button.style.zIndex = '99999';
  button.style.border = '0';
  button.style.borderRadius = '8px';
  button.style.padding = '7px 10px';
  button.style.fontSize = '12px';
  button.style.fontWeight = '700';
  button.style.background = 'rgba(20, 104, 58, 0.92)';
  button.style.color = '#d8f8e1';

  button.addEventListener('click', async () => {
    const payload = JSON.stringify(gestureDebug.dump(), null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      setStatus('Debug copied', 'online');
      term.writeln('\r\nDebug log copied to clipboard.\r\n');
      return;
    } catch (_err) {
      // Fallback to file download when clipboard API is unavailable.
    }

    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `gesture-debug-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus('Debug downloaded', 'online');
    term.writeln('\r\nDebug log downloaded as JSON.\r\n');
  });

  document.body.appendChild(button);
}

function consumeBootstrapTokenFromUrl() {
  const url = new URL(window.location.href);
  const fromQuery = (url.searchParams.get('token') || '').trim();
  if (!fromQuery) {
    return '';
  }

  // Query token is only bootstrap auth; remove it immediately from address bar.
  url.searchParams.delete('token');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}` || '/');
  return fromQuery;
}

function persistBootstrapToken(token) {
  if (!token) return;
  sessionStorage.setItem(STORAGE_BOOTSTRAP_TOKEN, token);
}

function clearAuthState() {
  sessionStorage.removeItem(STORAGE_BOOTSTRAP_TOKEN);
}

function getPersistedBootstrapToken() {
  return (sessionStorage.getItem(STORAGE_BOOTSTRAP_TOKEN) || '').trim();
}

async function bootstrapWithToken(token) {
  if (!token) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/bootstrap?token=${encodeURIComponent(token)}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return false;
    }

    persistBootstrapToken(token);
    return true;
  } catch (_err) {
    clearTimeout(timeout);
    return false;
  }
}

async function hasValidCookieSession() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch('/healthz', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (response.status === 200) return true;
    if (response.status === 401 || response.status === 429) return false;
    return false;
  } catch (_err) {
    clearTimeout(timeout);
    throw new Error('network_unavailable');
  }
}

async function ensureAuthenticated() {
  if (await hasValidCookieSession()) {
    return true;
  }

  const remembered = getPersistedBootstrapToken();
  if (remembered && (await bootstrapWithToken(remembered)) && (await hasValidCookieSession())) {
    return true;
  }

  const prompted = (window.prompt('Enter AUTH_TOKEN to connect:') || '').trim();
  if (!prompted) {
    return false;
  }

  if (await bootstrapWithToken(prompted)) {
    return hasValidCookieSession();
  }

  return false;
}

function suppressFocusFor(ms) {
  const until = Date.now() + ms;
  if (until > focusSuppressedUntil) {
    focusSuppressedUntil = until;
    gestureDebug.push('focus', { action: 'suppress', until });
  }
}

function isFocusSuppressed() {
  return Date.now() < focusSuppressedUntil || pinchState.active || gestureMode === 'scroll';
}

function scheduleFocus(delayMs = 0, options = {}) {
  const { force = false } = options;
  if (!inputMode && !force) {
    return;
  }
  if (!force && isFocusSuppressed()) {
    return;
  }

  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    if (document.visibilityState === 'visible' && (force || !isFocusSuppressed())) {
      gestureDebug.push('focus', { action: 'focus', source: force ? 'forced_schedule' : 'schedule_focus' });
      term.focus();
    }
  }, delayMs);
}

function vibrate(ms = 8) {
  if ('vibrate' in navigator) {
    navigator.vibrate(ms);
  }
}

function setStatus(text, state) {
  statusEl.textContent = text;
  statusEl.classList.remove('online', 'offline', 'connecting', 'reconnecting', 'authfailed');
  statusEl.classList.add(state);
}

function setToolbarCollapsed(nextState) {
  toolbarCollapsed = nextState;
  appEl.classList.toggle('toolbar-collapsed', toolbarCollapsed);
  toolbarToggleButton.textContent = toolbarCollapsed ? 'Keys' : 'Hide';
  scheduleFocus(20, { force: true });
  setTimeout(updateViewportHeight, 20);
}

function setInputMode(nextState) {
  inputMode = nextState;
  modeToggleButton.textContent = inputMode ? 'Mode: Input' : 'Mode: Scroll';
  modeToggleButton.classList.toggle('active', inputMode);

  if (!inputMode && typeof term.blur === 'function') {
    gestureDebug.push('focus', { action: 'blur', source: 'mode_toggle' });
    term.blur();
  }

  if (inputMode) {
    scheduleFocus(20, { force: true });
  }
}

function fitAndResize() {
  fitAddon.fit();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

function touchDistance(touchA, touchB) {
  const dx = touchA.clientX - touchB.clientX;
  const dy = touchA.clientY - touchB.clientY;
  return Math.hypot(dx, dy);
}

function updateViewportHeight() {
  if (gestureMode === 'scroll' || gestureMode === 'pinch') {
    return;
  }
  const viewport = window.visualViewport;
  const visibleHeight = viewport ? Math.round(viewport.height + viewport.offsetTop) : window.innerHeight;
  const clampedHeight = Math.max(320, visibleHeight);
  if (clampedHeight === lastAppliedViewportHeight) {
    return;
  }
  lastAppliedViewportHeight = clampedHeight;

  document.documentElement.style.setProperty('--app-height', `${clampedHeight}px`);
  gestureDebug.push('fit', { reason: 'viewport_resize', appHeight: clampedHeight, ...gestureDebug.snapshot() });
  fitAndResize();
}

function ctrlTransform(data) {
  if (!ctrlArmed || !data) {
    return data;
  }

  ctrlArmed = false;
  ctrlButton.classList.remove('active');

  const ch = data[0];
  const code = ch.toUpperCase().charCodeAt(0);

  if (code >= 65 && code <= 90) {
    return String.fromCharCode(code - 64);
  }

  if (ch === '[') return '\u001b';
  if (ch === '\\') return '\u001c';
  if (ch === ']') return '\u001d';
  if (ch === '^') return '\u001e';
  if (ch === '_') return '\u001f';
  return data;
}

function sendInput(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({ type: 'input', data }));
}

term.onData((data) => {
  sendInput(ctrlTransform(data));
});

function getBackoffMs(attempt) {
  const base = Math.min(reconnectBaseMs * 2 ** attempt, reconnectMaxMs);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

function clearReconnectTimer() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function disposeSocket(options = {}) {
  if (!socket) {
    return;
  }

  if (socketCleanup) {
    socketCleanup();
    socketCleanup = null;
  }

  const current = socket;
  socket = null;

  if (options.close && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) {
    try {
      current.close();
    } catch (_err) {
      // Ignore close errors.
    }
  }
}

function scheduleReconnect() {
  clearReconnectTimer();
  if (reconnectLocked) {
    return;
  }

  const delay = getBackoffMs(reconnectAttempt);
  reconnectAttempt += 1;
  setStatus(`Reconnecting (${Math.round(delay / 1000)}s)`, 'reconnecting');

  reconnectTimer = setTimeout(() => {
    connect();
  }, delay);
}

function attachSocketHandlers(ws) {
  const connectTimeout = setTimeout(() => {
    if (socket !== ws || ws.readyState !== WebSocket.CONNECTING) return;
    try {
      ws.close();
    } catch (_err) {
      // Ignore close errors.
    }
  }, WS_CONNECT_TIMEOUT_MS);

  const onOpen = () => {
    if (socket !== ws) return;
    clearTimeout(connectTimeout);

    isConnecting = false;
    connectedOnce = true;
    reconnectAttempt = 0;
    setStatus('Online', 'online');
    updateViewportHeight();
    scheduleFocus(30);
  };

  const onMessage = (event) => {
    if (socket !== ws) return;

    let message;
    try {
      message = JSON.parse(event.data);
    } catch (_err) {
      return;
    }

    if (message.type === 'output') {
      term.write(message.data);
      return;
    }

    if (message.type === 'status' && message.detail) {
      term.writeln(`\r\n${message.detail}\r\n`);
    }
  };

  const onClose = (event) => {
    clearTimeout(connectTimeout);
    if (socket === ws) {
      socket = null;
    }

    isConnecting = false;
    const closeReason = String(event?.reason || '');
    if (event?.code === 1000 && closeReason.includes('Replaced by a new client connection')) {
      reconnectLocked = true;
      setStatus('Replaced by another client', 'offline');
      term.writeln('\r\nDisconnected: replaced by another active client.\r\n');
      return;
    }

    if (reconnectLocked) {
      return;
    }

    setStatus('Offline', 'offline');
    scheduleReconnect();
  };

  const onError = () => {
    if (socket !== ws) return;
    clearTimeout(connectTimeout);
    setStatus('Offline', 'offline');
  };

  ws.addEventListener('open', onOpen);
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onError);

  socketCleanup = () => {
    clearTimeout(connectTimeout);
    ws.removeEventListener('open', onOpen);
    ws.removeEventListener('message', onMessage);
    ws.removeEventListener('close', onClose);
    ws.removeEventListener('error', onError);
  };
}

async function connect() {
  if (isConnecting || reconnectLocked) {
    return;
  }

  isConnecting = true;
  clearReconnectTimer();
  setStatus(connectedOnce ? 'Reconnecting...' : 'Connecting...', connectedOnce ? 'reconnecting' : 'connecting');

  try {
    const ready = await ensureAuthenticated();
    if (!ready) {
      isConnecting = false;
      reconnectLocked = true;
      setStatus('Auth Failed', 'authfailed');
      return;
    }
  } catch (_err) {
    isConnecting = false;
    setStatus('Offline', 'offline');
    scheduleReconnect();
    return;
  }

  disposeSocket({ close: true });

  const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${wsProtocol}://${window.location.host}/ws`);
  socket = ws;
  attachSocketHandlers(ws);
}

function fallbackPasteCapture() {
  const helper = document.createElement('textarea');
  helper.setAttribute('aria-hidden', 'true');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  helper.style.pointerEvents = 'none';
  helper.style.bottom = '0';
  helper.style.left = '0';
  document.body.appendChild(helper);

  term.writeln('\r\nClipboard permission blocked. Paste now (Cmd/Ctrl+V).\r\n');

  const cleanup = () => {
    window.removeEventListener('paste', onPaste);
    helper.remove();
    scheduleFocus(20);
  };

  const onPaste = (event) => {
    const text = event.clipboardData?.getData('text') || helper.value || '';
    if (text) {
      sendInput(text);
    }
    cleanup();
  };

  window.addEventListener('paste', onPaste, { once: true });
  helper.focus();
  setTimeout(cleanup, 8000);
}

async function handlePaste() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      sendInput(text);
      return;
    }
  } catch (_err) {
    // Fall back to manual paste capture for iOS permission failures.
  }

  fallbackPasteCapture();
}

function sendKeySequence(seq) {
  sendInput(seq);
}

function sendTmuxAction(action) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const session = (window.prompt('Session name', 'main') || '').trim() || 'main';
  socket.send(
    JSON.stringify({
      type: 'tmux_action',
      action,
      session
    })
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function uploadOneFile(file) {
  const body = await file.arrayBuffer();
  const response = await fetch('/api/upload', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name)
    },
    body
  });

  if (!response.ok) {
    throw new Error(`upload_failed_${response.status}`);
  }

  return response.json();
}

async function handleFileUploadSelection(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) {
    return;
  }

  setStatus('Uploading...', 'connecting');
  for (const file of files) {
    try {
      const result = await uploadOneFile(file);
      term.writeln(`\r\nUploaded: ${result.relativePath} (${formatBytes(result.size)})\r\n`);
    } catch (_err) {
      setStatus('Upload failed', 'authfailed');
      term.writeln(`\r\nUpload failed: ${file.name}\r\n`);
      return;
    }
  }

  setStatus('Online', 'online');
  scheduleFocus(30);
}

async function handleLogout() {
  reconnectLocked = true;
  clearReconnectTimer();
  disposeSocket({ close: true });
  clearAuthState();

  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
  } catch (_err) {
    // Logout still clears local state if network request fails.
  }

  connectedOnce = false;
  reconnectAttempt = 0;
  setStatus('Logged out', 'authfailed');
  term.writeln('\r\nLogged out. Tap reconnect to sign in again.\r\n');
}

toolbarEl.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) {
    return;
  }

  const { action } = button.dataset;
  vibrate(10);

  const inputActions = ['ctrl', 'esc', 'tab', 'up', 'down', 'left', 'right', 'paste'];
  if (inputActions.includes(action) && !inputMode) {
    setInputMode(true);
  }

  scheduleFocus(0);

  if (action === 'ctrl') {
    ctrlArmed = !ctrlArmed;
    button.classList.toggle('active', ctrlArmed);
    return;
  }

  if (action === 'esc') return sendKeySequence('\u001b');
  if (action === 'tab') return sendKeySequence('\t');
  if (action === 'up') return sendKeySequence('\u001b[A');
  if (action === 'down') return sendKeySequence('\u001b[B');
  if (action === 'right') return sendKeySequence('\u001b[C');
  if (action === 'left') return sendKeySequence('\u001b[D');
  if (action === 'paste') return handlePaste();

  if (action === 'font') {
    const current = Number(term.options.fontSize) || fontSizes[fontIndex];
    const next = fontSizes.find((size) => size > current) || fontSizes[0];
    setTerminalFontSize(next);
    return;
  }

  if (action === 'tmux') {
    const pick = (window.prompt('Tmux action: n=new, a=attach, k=kill', 'a') || '').trim().toLowerCase();
    if (pick === 'n') return sendTmuxAction('new');
    if (pick === 'a') return sendTmuxAction('attach');
    if (pick === 'k') return sendTmuxAction('kill');
    return;
  }

  if (action === 'reconnect') {
    reconnectLocked = false;
    reconnectAttempt = 0;
    clearReconnectTimer();
    disposeSocket({ close: true });
    connect();
  }

  if (action === 'reset') {
    reconnectLocked = false;
    reconnectAttempt = 0;
    clearReconnectTimer();
    disposeSocket({ close: true });
    connect();
  }
});

logoutButton.addEventListener('click', () => {
  vibrate(12);
  handleLogout();
});

modeToggleButton.addEventListener('click', () => {
  vibrate(8);
  setInputMode(!inputMode);
});

toolbarToggleButton.addEventListener('click', () => {
  vibrate(8);
  setToolbarCollapsed(!toolbarCollapsed);
});

uploadButton.addEventListener('click', () => {
  vibrate(8);
  fileInputEl.click();
});

fileInputEl.addEventListener('change', async () => {
  await handleFileUploadSelection(fileInputEl.files);
  fileInputEl.value = '';
});

window.addEventListener('resize', updateViewportHeight);
window.addEventListener('orientationchange', () => setTimeout(updateViewportHeight, 120));
window.addEventListener('pageshow', updateViewportHeight);
window.addEventListener('focus', () => scheduleFocus(20));

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateViewportHeight);
}

for (const el of [terminalWrapEl, topbarEl]) {
  if (el === topbarEl) {
    el.addEventListener('pointerdown', () => scheduleFocus(0));
    el.addEventListener('touchstart', () => scheduleFocus(0), { passive: true });
  }
}

terminalWrapEl.addEventListener(
  'touchstart',
  (event) => {
    const fromState = gestureMode;
    if (event.touches.length === 2) {
      const [a, b] = event.touches;
      pinchState.active = true;
      pinchState.startDistance = touchDistance(a, b);
      pinchState.startSize = Number(term.options.fontSize) || 14;
      gestureMode = 'pinch';
      gestureDebug.push('gesture', { from: fromState, to: 'pinch', touches: 2, ...gestureDebug.snapshot() });
      suppressFocusFor(FOCUS_PINCH_SUPPRESS_MS);
      if (!pinchMoveListenerAttached) {
        terminalWrapEl.addEventListener('touchmove', handlePinchMove, { passive: false });
        pinchMoveListenerAttached = true;
      }
      return;
    }
    if (event.touches.length !== 1) {
      return;
    }
    const touch = event.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchStartTs = Date.now();
    gestureMode = 'tap_candidate';
    gestureDebug.push('gesture', {
      from: fromState,
      to: 'tap_candidate',
      touches: 1,
      x: Math.round(touch.clientX),
      y: Math.round(touch.clientY),
      ...gestureDebug.snapshot()
    });
  },
  { passive: true }
);

function handlePinchMove(event) {
  if (!pinchState.active || event.touches.length !== 2) {
    return;
  }
  const [a, b] = event.touches;
  const currentDistance = touchDistance(a, b);
  if (pinchState.startDistance < 8) {
    return;
  }
  const ratio = currentDistance / pinchState.startDistance;
  const nextSize = pinchState.startSize * ratio;
  setTerminalFontSize(nextSize);
  gestureDebug.push('prevented', { event: 'touchmove', reason: 'pinch' });
  event.preventDefault();
}

function exitPinchMode() {
  const fromState = gestureMode;
  pinchState.active = false;
  if (gestureMode === 'pinch') {
    gestureMode = 'idle';
  }
  gestureDebug.push('gesture', { from: fromState, to: gestureMode, reason: 'pinch_end' });
  suppressFocusFor(FOCUS_PINCH_SUPPRESS_MS);
  if (pinchMoveListenerAttached) {
    terminalWrapEl.removeEventListener('touchmove', handlePinchMove);
    pinchMoveListenerAttached = false;
  }
}

terminalWrapEl.addEventListener(
  'touchmove',
  (event) => {
    if (gestureMode === 'pinch' || event.touches.length !== 1) {
      return;
    }
    const touch = event.touches[0];
    const dx = Math.abs(touch.clientX - touchStartX);
    const dy = Math.abs(touch.clientY - touchStartY);
    if (gestureMode === 'tap_candidate' && (dx > TAP_MOVE_THRESHOLD_PX || dy > TAP_MOVE_THRESHOLD_PX)) {
      const fromState = gestureMode;
      gestureMode = 'scroll';
      gestureDebug.push('gesture', {
        from: fromState,
        to: 'scroll',
        dx: Math.round(dx),
        dy: Math.round(dy),
        ...gestureDebug.snapshot()
      });
      suppressFocusFor(FOCUS_SCROLL_SUPPRESS_MS);
      return;
    }
    if (gestureMode === 'scroll') {
      if (gestureDebug.isEnabled()) {
        const nowTs = Date.now();
        if (nowTs - lastDebugViewportLogTs > 120) {
          lastDebugViewportLogTs = nowTs;
          gestureDebug.push('viewport', { source: 'touchmove_scroll', ...gestureDebug.snapshot() });
        }
      }
      suppressFocusFor(FOCUS_SCROLL_SUPPRESS_MS);
    }
  },
  { passive: true }
);

terminalWrapEl.addEventListener(
  'touchend',
  (event) => {
    if (pinchState.active && event.touches.length < 2) {
      exitPinchMode();
    }
    if (event.touches.length > 0) {
      return;
    }
    if (gestureMode === 'scroll') {
      const fromState = gestureMode;
      gestureMode = 'idle';
      gestureDebug.push('gesture', { from: fromState, to: 'idle', reason: 'touchend_scroll' });
      suppressFocusFor(FOCUS_SCROLL_SUPPRESS_MS);
      return;
    }
    if (gestureMode === 'tap_candidate') {
      const elapsed = Date.now() - touchStartTs;
      if (elapsed <= TAP_MAX_DURATION_MS && inputMode && event.target.closest('.xterm-viewport')) {
        gestureDebug.push('focus', { action: 'focus', source: 'confirmed_tap' });
        scheduleFocus(0, { force: true });
      }
    }
    if (gestureMode !== 'idle') {
      gestureDebug.push('gesture', { from: gestureMode, to: 'idle', reason: 'touchend' });
    }
    gestureMode = 'idle';
  },
  { passive: true }
);

terminalWrapEl.addEventListener(
  'touchcancel',
  () => {
    if (pinchState.active) {
      exitPinchMode();
    }
    gestureMode = 'idle';
    gestureDebug.push('gesture', { from: 'unknown', to: 'idle', reason: 'touchcancel' });
    suppressFocusFor(FOCUS_SCROLL_SUPPRESS_MS);
  },
  { passive: true }
);

toolbarEl.addEventListener(
  'touchmove',
  (event) => {
    gestureDebug.push('prevented', { event: 'touchmove', reason: 'toolbar' });
    event.preventDefault();
    event.stopPropagation();
  },
  { passive: false }
);

document.addEventListener('visibilitychange', () => {
  gestureDebug.push('lifecycle', { event: 'visibilitychange', state: document.visibilityState });
  if (document.visibilityState === 'visible') {
    scheduleFocus(40);
  }
});

window.addEventListener('beforeunload', () => {
  reconnectLocked = true;
  clearReconnectTimer();
  clearTimeout(focusTimer);
  disposeSocket({ close: true });
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

(async () => {
  const bootstrapToken = consumeBootstrapTokenFromUrl();
  if (bootstrapToken) {
    await bootstrapWithToken(bootstrapToken);
  }

  updateViewportHeight();
  setInputMode(false);
  installDebugExportButton();
  toolbarToggleButton.textContent = 'Hide';
  connect();
  scheduleFocus(20);
})();
