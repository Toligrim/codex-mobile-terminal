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
let pinchState = {
  active: false,
  startDistance: 0,
  startSize: 14
};

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

  try {
    const response = await fetch(`/api/bootstrap?token=${encodeURIComponent(token)}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store'
    });

    if (!response.ok) {
      return false;
    }

    persistBootstrapToken(token);
    return true;
  } catch (_err) {
    return false;
  }
}

async function hasValidCookieSession() {
  try {
    const response = await fetch('/healthz', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (response.status === 200) return true;
    if (response.status === 401 || response.status === 429) return false;
    return false;
  } catch (_err) {
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

function scheduleFocus(delayMs = 0, options = {}) {
  const { force = false } = options;
  if (!inputMode && !force) {
    return;
  }

  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    if (document.visibilityState === 'visible') {
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
  const viewport = window.visualViewport;
  const visibleHeight = viewport ? Math.round(viewport.height + viewport.offsetTop) : window.innerHeight;

  document.documentElement.style.setProperty('--app-height', `${Math.max(320, visibleHeight)}px`);
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
  const onOpen = () => {
    if (socket !== ws) return;

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

  const onClose = () => {
    if (socket === ws) {
      socket = null;
    }

    isConnecting = false;
    if (reconnectLocked) {
      return;
    }

    setStatus('Offline', 'offline');
    scheduleReconnect();
  };

  const onError = () => {
    if (socket !== ws) return;
    setStatus('Offline', 'offline');
  };

  ws.addEventListener('open', onOpen);
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onError);

  socketCleanup = () => {
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
  window.visualViewport.addEventListener('scroll', updateViewportHeight);
}

document.addEventListener(
  'touchmove',
  (event) => {
    if (!event.target.closest('.xterm-viewport')) {
      event.preventDefault();
    }
  },
  { passive: false }
);

for (const el of [terminalWrapEl, topbarEl]) {
  if (el === topbarEl) {
    el.addEventListener('pointerdown', () => scheduleFocus(0));
    el.addEventListener('touchstart', () => scheduleFocus(0), { passive: true });
  }
}

terminalWrapEl.addEventListener(
  'touchstart',
  (event) => {
    if (event.touches.length !== 2) {
      return;
    }

    const [a, b] = event.touches;
    pinchState.active = true;
    pinchState.startDistance = touchDistance(a, b);
    pinchState.startSize = Number(term.options.fontSize) || 14;
  },
  { passive: true }
);

terminalWrapEl.addEventListener(
  'touchmove',
  (event) => {
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
    event.preventDefault();
  },
  { passive: false }
);

terminalWrapEl.addEventListener(
  'touchend',
  (event) => {
    const endedPinch = pinchState.active && event.touches.length < 2;
    if (event.touches.length < 2) {
      pinchState.active = false;
    }

    if (endedPinch) {
      return;
    }

    if (!inputMode) {
      return;
    }
    if (!event.target.closest('.xterm-viewport')) {
      return;
    }
    scheduleFocus(0);
  },
  { passive: true }
);

document.addEventListener('visibilitychange', () => {
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
  toolbarToggleButton.textContent = 'Hide';
  connect();
  scheduleFocus(20);
})();
