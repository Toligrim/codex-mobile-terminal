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
const STORAGE_IOS_SCROLL_MODEL = 'ios_scroll_model';
const STORAGE_IOS_ALT_SCREEN_MODE = 'ios_alt_screen_mode';
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
let wsAttemptSeq = 0;
let toolbarCollapsed = false;
let inputMode = false;
let gestureMode = 'idle';
let touchStartX = 0;
let touchStartY = 0;
let touchLastY = 0;
let touchStartTs = 0;
let focusSuppressedUntil = 0;
let pinchMoveListenerAttached = false;
let lastAppliedViewportHeight = 0;
let lastDebugViewportLogTs = 0;
let lastOutputDebugLogTs = 0;
let lastDiagScrollMoveTs = 0;
let lastDiagViewportEventTs = 0;
let lastTmuxScrollSendTs = 0;
let outputByteCount = 0;
let arbiterLineRemainder = 0;
let tmuxScrollLineRemainder = 0;
let pinchState = {
  active: false,
  startDistance: 0,
  startSize: 14
};
const TAP_MOVE_THRESHOLD_PX = 8;
const TAP_MAX_DURATION_MS = 280;
const FOCUS_SCROLL_SUPPRESS_MS = 180;
const FOCUS_PINCH_SUPPRESS_MS = 240;
const DEBUG_LOG_LIMIT = 4000;
const AUTH_FETCH_TIMEOUT_MS = 8000;
const WS_CONNECT_TIMEOUT_MS = 18000;
const IOS_SCROLL_MODEL_NATIVE = 'native';
const IOS_SCROLL_MODEL_ARBITER = 'arbiter';
const IOS_ALT_SCREEN_MODE_NATIVE = 'native';
const IOS_ALT_SCREEN_MODE_IGNORE = 'ignore';
const TMUX_PROFILE_DEFAULT = 'default';
const TMUX_PROFILE_MOBILE = 'mobile';
const DEFAULT_LINE_HEIGHT_PX = 18;
const DIAG_SCROLL_MOVE_INTERVAL_MS = 280;
const DIAG_VIEWPORT_INTERVAL_MS = 320;
const TMUX_SCROLL_SEND_INTERVAL_MS = 90;

function isIOSDevice() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return true;
  }
  // iPadOS can report itself as macOS while still exposing touch points.
  return navigator.platform === 'MacIntel' && Number(navigator.maxTouchPoints) > 1;
}

function getIOSScrollModel() {
  const url = new URL(window.location.href);
  const fromQuery = (url.searchParams.get('iosScrollModel') || '').trim().toLowerCase();
  if (fromQuery === IOS_SCROLL_MODEL_NATIVE || fromQuery === IOS_SCROLL_MODEL_ARBITER) {
    localStorage.setItem(STORAGE_IOS_SCROLL_MODEL, fromQuery);
    return fromQuery;
  }
  const fromStorage = (localStorage.getItem(STORAGE_IOS_SCROLL_MODEL) || '').trim().toLowerCase();
  if (fromStorage === IOS_SCROLL_MODEL_NATIVE || fromStorage === IOS_SCROLL_MODEL_ARBITER) {
    return fromStorage;
  }
  return IOS_SCROLL_MODEL_NATIVE;
}

const isIOS = isIOSDevice();
const iosScrollModel = getIOSScrollModel();

function isArbiterIOSScrollEnabled() {
  return isIOS && iosScrollModel === IOS_SCROLL_MODEL_ARBITER;
}

function getIOSAltScreenMode() {
  const url = new URL(window.location.href);
  const fromQuery = (url.searchParams.get('iosAltScreen') || '').trim().toLowerCase();
  if (fromQuery === IOS_ALT_SCREEN_MODE_NATIVE || fromQuery === IOS_ALT_SCREEN_MODE_IGNORE) {
    localStorage.setItem(STORAGE_IOS_ALT_SCREEN_MODE, fromQuery);
    return fromQuery;
  }
  const fromStorage = (localStorage.getItem(STORAGE_IOS_ALT_SCREEN_MODE) || '').trim().toLowerCase();
  if (fromStorage === IOS_ALT_SCREEN_MODE_NATIVE || fromStorage === IOS_ALT_SCREEN_MODE_IGNORE) {
    return fromStorage;
  }
  return IOS_ALT_SCREEN_MODE_NATIVE;
}

const iosAltScreenMode = getIOSAltScreenMode();

function getTmuxProfile() {
  const url = new URL(window.location.href);
  const fromQuery = (url.searchParams.get('tmuxProfile') || '').trim().toLowerCase();
  if (fromQuery === TMUX_PROFILE_DEFAULT || fromQuery === TMUX_PROFILE_MOBILE) {
    return fromQuery;
  }
  return isIOS ? TMUX_PROFILE_MOBILE : TMUX_PROFILE_DEFAULT;
}

const tmuxProfile = getTmuxProfile();

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
const termDebugId = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function getBufferSnapshot() {
  const active = term.buffer.active;
  const normal = term.buffer.normal;
  return {
    termId: termDebugId,
    activeType: active?.type || 'unknown',
    activeBaseY: Number(active?.baseY || 0),
    activeViewportY: Number(active?.viewportY || 0),
    activeLength: Number(active?.length || 0),
    normalBaseY: Number(normal?.baseY || 0),
    normalViewportY: Number(normal?.viewportY || 0),
    normalLength: Number(normal?.length || 0),
    rows: Number(term.rows || 0),
    cols: Number(term.cols || 0),
    scrollback: Number(term.options.scrollback || 0),
    xtermViewportScrollTop: Number(terminalEl.querySelector('.xterm-viewport')?.scrollTop || 0),
    termElementAttached: Boolean(term.element && term.element.isConnected)
  };
}

function escapeSample(text, fromHead = true, maxLen = 80) {
  const part = fromHead ? text.slice(0, maxLen) : text.slice(-maxLen);
  return part
    .replace(/\x1b/g, '\\x1b')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function summarizeChunk(text) {
  const lfCount = (text.match(/\n/g) || []).length;
  const crCount = (text.match(/\r/g) || []).length;
  const escCount = (text.match(/\x1b/g) || []).length;
  return {
    bytes: text.length,
    lfCount,
    crCount,
    escCount,
    hasRIS: text.includes('\x1bc'),
    hasED2: text.includes('\x1b[2J'),
    hasED3: text.includes('\x1b[3J'),
    hasHome: text.includes('\x1b[H'),
    hasAltOn: text.includes('\x1b[?1049h'),
    hasAltOff: text.includes('\x1b[?1049l'),
    sampleHeadEscaped: escapeSample(text, true),
    sampleTailEscaped: escapeSample(text, false)
  };
}

function dumpState(source) {
  gestureDebug.push('buffer', {
    source,
    ...getBufferSnapshot()
  });
}

const originalClear = typeof term.clear === 'function' ? term.clear.bind(term) : null;
if (originalClear) {
  term.clear = (...args) => {
    gestureDebug.push('lifecycle', { event: 'clear', termId: termDebugId, ...getBufferSnapshot() });
    return originalClear(...args);
  };
}

const originalReset = typeof term.reset === 'function' ? term.reset.bind(term) : null;
if (originalReset) {
  term.reset = (...args) => {
    gestureDebug.push('lifecycle', { event: 'reset', termId: termDebugId, ...getBufferSnapshot() });
    return originalReset(...args);
  };
}

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

const diagProbeLastSentAt = new Map();
let diagRequestSeq = 0;

function pushDiag(stage, payload = {}) {
  if (!gestureDebug.isEnabled()) return;
  gestureDebug.push('diag', {
    stage,
    ...payload,
    ...gestureDebug.snapshot(),
    ...getBufferSnapshot()
  });
}

function requestServerDiag(reason, payload = {}, throttleMs = 0) {
  if (!gestureDebug.isEnabled()) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  const now = Date.now();
  const lastTs = Number(diagProbeLastSentAt.get(reason) || 0);
  if (throttleMs > 0 && now - lastTs < throttleMs) {
    return;
  }
  diagProbeLastSentAt.set(reason, now);

  const requestId = `diag-${now}-${diagRequestSeq++}`;
  socket.send(
    JSON.stringify({
      type: 'diag_probe',
      requestId,
      reason,
      client: {
        ...payload,
        ...gestureDebug.snapshot(),
        ...getBufferSnapshot()
      }
    })
  );
}

gestureDebug.push('config', {
  termId: termDebugId,
  isIOS,
  iosScrollModel,
  iosAltScreenMode,
  tmuxProfile,
  ...getBufferSnapshot()
});
pushDiag('config_loaded', { isIOS, iosScrollModel, iosAltScreenMode, tmuxProfile });

if (isIOS && iosAltScreenMode === IOS_ALT_SCREEN_MODE_IGNORE) {
  const suppressAltScreenMode = (params) => {
    const modeParams = Array.isArray(params) ? params : [];
    if (!modeParams.some((mode) => mode === 47 || mode === 1047 || mode === 1049)) {
      return false;
    }
    gestureDebug.push('prevented', {
      event: 'csi_alt_screen',
      params: modeParams.slice(0, 6),
      ...getBufferSnapshot()
    });
    return true;
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, suppressAltScreenMode);
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, suppressAltScreenMode);
}

term.onWriteParsed(() => {
  gestureDebug.push('write_parsed', {
    ...getBufferSnapshot()
  });
});

term.onScroll((y) => {
  if (!gestureDebug.isEnabled()) return;
  const nowTs = Date.now();
  if (nowTs - lastDebugViewportLogTs < 120) return;
  lastDebugViewportLogTs = nowTs;
  gestureDebug.push('viewport', { source: 'term_scroll', y, ...gestureDebug.snapshot(), ...getBufferSnapshot() });
});

function installDebugExportButton() {
  if (!gestureDebug.isEnabled()) return;
  if (document.getElementById('debug-export')) return;

  const makeDebugButton = (id, text, rightPx, bg, fg) => {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = text;
    button.style.position = 'fixed';
    button.style.right = `${rightPx}px`;
    button.style.bottom = '8px';
    button.style.zIndex = '99999';
    button.style.border = '0';
    button.style.borderRadius = '8px';
    button.style.padding = '7px 10px';
    button.style.fontSize = '12px';
    button.style.fontWeight = '700';
    button.style.background = bg;
    button.style.color = fg;
    return button;
  };

  const injectButton = makeDebugButton('debug-seq', 'Gen 300', 88, 'rgba(19, 73, 132, 0.92)', '#d8ecff');
  injectButton.addEventListener('click', () => {
    pushDiag('gen300_click');
    requestServerDiag('gen300_before');
    dumpState('gen300_before');
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatus('Offline', 'offline');
      term.writeln('\r\nDebug inject skipped: socket is not open.\r\n');
      gestureDebug.push('debug', { action: 'inject_seq300', result: 'socket_not_open' });
      return;
    }
    const cmd = 'printf "__DBG_START__\\n"; seq 1 300; printf "__DBG_END__\\n"';
    gestureDebug.push('debug', { action: 'inject_seq300', result: 'sent', cmd });
    // Try to break out of any running full-screen program before injecting.
    sendInput('\u0003');
    setTimeout(() => {
      sendInput(`${cmd}\r`);
    }, 40);
    setTimeout(() => dumpState('gen300_after_250ms'), 250);
    setTimeout(() => {
      dumpState('gen300_after_1000ms');
      pushDiag('gen300_after_1000ms');
      requestServerDiag('gen300_after_1000ms');
    }, 1000);
    term.writeln('\r\n[debug] injected with markers: seq 1 300\r\n');
  });
  document.body.appendChild(injectButton);

  const button = makeDebugButton('debug-export', 'Debug Log', 8, 'rgba(20, 104, 58, 0.92)', '#d8f8e1');

  button.addEventListener('click', async () => {
    const logs = gestureDebug.dump();
    const payload = JSON.stringify(logs, null, 2);
    try {
      const response = await fetch('/api/debug-log', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          logs,
          meta: {
            userAgent: navigator.userAgent,
            isIOS,
            iosScrollModel,
            iosAltScreenMode,
            tmuxProfile,
            href: window.location.href,
            hasPersistedBootstrapToken: Boolean(getPersistedBootstrapToken()),
            hasQueryTokenInUrl: Boolean(new URL(window.location.href).searchParams.get('token'))
          }
        })
      });

      if (!response.ok) {
        throw new Error(`debug_upload_failed_${response.status}`);
      }

      const result = await response.json();
      const summary = result.summary || {};
      setStatus('Debug uploaded', 'online');
      term.writeln('\r\nDebug log uploaded.\r\n');
      term.writeln(`Path: ${result.relativePath || result.fileName || 'unknown'}\r\n`);
      term.writeln(
        `Analysis: status=${summary.status || 'unknown'}, events=${summary.events || 0}, maxBaseY=${summary.maxBaseY || 0}, viewportMoves=${summary.viewportMoves || 0}, jumpsNoTerm=${summary.viewportJumpsWithoutTermMove || 0}, arbiter=${summary.arbiterScrollEvents || 0}, diag=${summary.diagEvents || 0}, diagSrv=${summary.diagServerEvents || 0}, tmuxAltSeen=${summary.tmuxAlternateOnSeen || 0}, tmuxHistMax=${summary.tmuxMaxHistorySize || 0}\r\n`
      );
      return;
    } catch (_err) {
      // Fallback to local export if server-side upload failed.
    }

    try {
      await navigator.clipboard.writeText(payload);
      setStatus('Debug copied', 'online');
      term.writeln('\r\nDebug upload failed, log copied to clipboard.\r\n');
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
    term.writeln('\r\nDebug upload failed, log downloaded as JSON.\r\n');
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

function makeConnectionCid() {
  wsAttemptSeq += 1;
  return `ws-${Date.now().toString(36)}-${wsAttemptSeq.toString(36)}`;
}

async function fetchDiagEndpoint(pathname, params = {}, timeoutMs = 1800) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    query.set(key, String(value));
  }
  const url = `${pathname}${query.toString() ? `?${query.toString()}` : ''}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal
    });
  } catch (_err) {
    // Best-effort diagnostics call.
  } finally {
    clearTimeout(timeout);
  }
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
  gestureDebug.push('status', {
    text,
    state
  });
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
  const before = getBufferSnapshot();
  fitAddon.fit();
  const after = getBufferSnapshot();
  gestureDebug.push('lifecycle', {
    event: 'fit',
    termId: termDebugId,
    rowsBefore: before.rows,
    colsBefore: before.cols,
    rowsAfter: after.rows,
    colsAfter: after.cols,
    ...after
  });
  if (socket && socket.readyState === WebSocket.OPEN) {
    gestureDebug.push('lifecycle', {
      event: 'resize_send',
      termId: termDebugId,
      cols: term.cols,
      rows: term.rows
    });
    socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

function touchDistance(touchA, touchB) {
  const dx = touchA.clientX - touchB.clientX;
  const dy = touchA.clientY - touchB.clientY;
  return Math.hypot(dx, dy);
}

function getTerminalLineHeightPx() {
  const firstRow = terminalEl.querySelector('.xterm-rows > div');
  if (firstRow) {
    const measured = firstRow.getBoundingClientRect().height;
    if (Number.isFinite(measured) && measured > 4) {
      return measured;
    }
  }
  const byFont = (Number(term.options.fontSize) || 14) * (Number(term.options.lineHeight) || 1.24);
  if (Number.isFinite(byFont) && byFont > 4) {
    return byFont;
  }
  return DEFAULT_LINE_HEIGHT_PX;
}

function applyArbiterScrollDelta(deltaY) {
  const lineHeightPx = getTerminalLineHeightPx();
  const rawLines = -deltaY / lineHeightPx;
  const linesWithRemainder = rawLines + arbiterLineRemainder;
  const wholeLines = linesWithRemainder > 0 ? Math.floor(linesWithRemainder) : Math.ceil(linesWithRemainder);
  arbiterLineRemainder = linesWithRemainder - wholeLines;
  const active = term.buffer.active;
  const beforeViewportY = Number(active.viewportY || 0);
  const maxLine = Math.max(0, active.baseY);
  const targetLine = Math.max(0, Math.min(maxLine, active.viewportY + wholeLines));
  let moved = false;

  if (wholeLines !== 0 && targetLine !== active.viewportY) {
    if (typeof term.scrollToLine === 'function') {
      term.scrollToLine(targetLine);
    } else if (typeof term.scrollLines === 'function') {
      term.scrollLines(targetLine - active.viewportY);
    }
    moved = Number(term.buffer.active.viewportY || 0) !== beforeViewportY;
  }

  if (gestureDebug.isEnabled()) {
    const nowTs = Date.now();
    if (nowTs - lastDebugViewportLogTs > 120) {
      lastDebugViewportLogTs = nowTs;
      gestureDebug.push('viewport', {
        source: 'touchmove_arbiter',
        deltaY: Math.round(deltaY),
        lines: wholeLines,
        targetLine,
        ...gestureDebug.snapshot()
      });
    }
  }

  return {
    wholeLines,
    targetLine,
    moved
  };
}

function sendTmuxScrollLines(wholeLines) {
  if (!isArbiterIOSScrollEnabled()) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!Number.isFinite(wholeLines) || wholeLines === 0) return;

  const nowTs = Date.now();
  const linesWithRemainder = wholeLines + tmuxScrollLineRemainder;
  const roundedLines = linesWithRemainder > 0 ? Math.floor(linesWithRemainder) : Math.ceil(linesWithRemainder);
  tmuxScrollLineRemainder = linesWithRemainder - roundedLines;
  if (roundedLines === 0) return;
  if (nowTs - lastTmuxScrollSendTs < TMUX_SCROLL_SEND_INTERVAL_MS) return;
  lastTmuxScrollSendTs = nowTs;

  socket.send(
    JSON.stringify({
      type: 'tmux_scroll',
      lines: roundedLines
    })
  );
  pushDiag('tmux_scroll_sent', { lines: roundedLines, fallback: true });
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
  pushDiag('visual_viewport_resize', { appHeight: clampedHeight });
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
  pushDiag('reconnect_scheduled', { attempt: reconnectAttempt, delayMs: delay });
  setStatus(`Reconnecting (${Math.round(delay / 1000)}s)`, 'reconnecting');

  reconnectTimer = setTimeout(() => {
    connect();
  }, delay);
}

function attachSocketHandlers(ws, connectionMeta = {}) {
  const { cid = '' } = connectionMeta;
  gestureDebug.push('ws', { event: 'create', cid: cid || null, termId: termDebugId, ...getBufferSnapshot() });
  let reconnectScheduledBySocket = false;
  const scheduleReconnectOnce = () => {
    if (reconnectScheduledBySocket || reconnectLocked) return;
    reconnectScheduledBySocket = true;
    scheduleReconnect();
  };
  const failStuckConnecting = (reason) => {
    if (socket !== ws) return;
    pushDiag('ws_force_reconnect', { reason, cid: cid || null });
    isConnecting = false;
    setStatus('Offline', 'offline');
    try {
      ws.close();
    } catch (_err) {
      // Ignore close errors.
    }
    setTimeout(() => {
      if (socket === ws) {
        disposeSocket({ close: false });
      }
      if (!isConnecting) {
        scheduleReconnectOnce();
      }
    }, 180);
  };
  const connectTimeout = setTimeout(() => {
    if (socket !== ws || ws.readyState !== WebSocket.CONNECTING) return;
    gestureDebug.push('ws', { event: 'connect_timeout', termId: termDebugId, ...getBufferSnapshot() });
    if (cid) {
      fetchDiagEndpoint('/api/ws-postflight', { cid, a: 'timeout', rs: ws.readyState });
    }
    failStuckConnecting('connect_timeout');
  }, WS_CONNECT_TIMEOUT_MS);

  const onOpen = () => {
    if (socket !== ws) return;
    clearTimeout(connectTimeout);
    gestureDebug.push('ws', { event: 'open', cid: cid || null, termId: termDebugId, ...getBufferSnapshot() });

    isConnecting = false;
    connectedOnce = true;
    reconnectAttempt = 0;
    setStatus('Online', 'online');
    updateViewportHeight();
    scheduleFocus(30);
    pushDiag('ws_open');
    if (cid) {
      fetchDiagEndpoint('/api/ws-postflight', { cid, a: 'open', rs: ws.readyState });
    }
    requestServerDiag('ws_open');
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
      const text = String(message.data || '');
      if (text.includes('__DBG_START__')) {
        pushDiag('gen300_marker_start');
        requestServerDiag('gen300_marker_start');
      }
      if (text.includes('__DBG_END__')) {
        pushDiag('gen300_marker_end');
        requestServerDiag('gen300_marker_end');
      }
      gestureDebug.push('ws_message', {
        termId: termDebugId,
        ...summarizeChunk(text),
        ...getBufferSnapshot()
      });
      gestureDebug.push('term_write_before', {
        termId: termDebugId,
        ...summarizeChunk(text),
        ...getBufferSnapshot()
      });
      term.write(text, () => {
        gestureDebug.push('term_write_cb', {
          termId: termDebugId,
          ...getBufferSnapshot()
        });
      });
      outputByteCount += text.length;
      const nowTs = Date.now();
      if (nowTs - lastOutputDebugLogTs > 300) {
        lastOutputDebugLogTs = nowTs;
        const newlineCount = (text.match(/\n/g) || []).length;
        gestureDebug.push('output', {
          bytesTotal: outputByteCount,
          chunkBytes: text.length,
          newlineCount,
          hasDbgStart: text.includes('__DBG_START__'),
          hasDbgEnd: text.includes('__DBG_END__'),
          ...gestureDebug.snapshot(),
          ...getBufferSnapshot()
        });
      }
      return;
    }

    if (message.type === 'diag_probe_result') {
      gestureDebug.push('diag_server', {
        ...message,
        ...gestureDebug.snapshot(),
        ...getBufferSnapshot()
      });
      return;
    }

    if (message.type === 'tmux_scroll_result') {
      gestureDebug.push('diag_server', {
        ...message,
        ...gestureDebug.snapshot(),
        ...getBufferSnapshot()
      });
      return;
    }

    if (message.type === 'status' && message.detail) {
      term.writeln(`\r\n${message.detail}\r\n`);
    }
  };

  const onClose = (event) => {
    clearTimeout(connectTimeout);
    gestureDebug.push('ws', {
      event: 'close',
      cid: cid || null,
      code: Number(event?.code || 0),
      reason: String(event?.reason || ''),
      termId: termDebugId,
      ...getBufferSnapshot()
    });
    pushDiag('ws_close', { code: Number(event?.code || 0), reason: String(event?.reason || '') });
    if (cid) {
      fetchDiagEndpoint('/api/ws-postflight', {
        cid,
        a: 'close',
        rs: ws.readyState,
        code: Number(event?.code || 0),
        reason: String(event?.reason || '')
      });
    }
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
    scheduleReconnectOnce();
  };

  const onError = () => {
    if (socket !== ws) return;
    clearTimeout(connectTimeout);
    gestureDebug.push('ws', { event: 'error', cid: cid || null, termId: termDebugId, ...getBufferSnapshot() });
    pushDiag('ws_error');
    if (cid) {
      fetchDiagEndpoint('/api/ws-postflight', { cid, a: 'error', rs: ws.readyState });
    }
    isConnecting = false;
    setStatus('Offline', 'offline');
    if (!reconnectLocked) {
      try {
        ws.close();
      } catch (_err) {
        // Ignore close errors and fallback to timer-based reconnect.
        scheduleReconnectOnce();
      }
      scheduleReconnectOnce();
    }
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
  pushDiag('connect_begin', { reconnectAttempt, connectedOnce });

  try {
    const ready = await ensureAuthenticated();
    gestureDebug.push('auth', { stage: 'ensureAuthenticated', ready });
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
  const cid = makeConnectionCid();
  const rememberedToken = getPersistedBootstrapToken();
  // iOS Safari can lose cookies on WS upgrade; use token query on first attempt too.
  const useTokenFallback = Boolean(rememberedToken) && (isIOS || reconnectAttempt > 0);
  const wsQuery = new URLSearchParams();
  if (useTokenFallback) {
    wsQuery.set('token', rememberedToken);
  }
  wsQuery.set('tmuxProfile', tmuxProfile);
  wsQuery.set('cid', cid);
  wsQuery.set('mode', 'primary');
  const wsTokenQuery = wsQuery.toString() ? `?${wsQuery.toString()}` : '';
  const wsUrl = `${wsProtocol}://${window.location.host}/ws${wsTokenQuery}`;
  await fetchDiagEndpoint('/api/ws-preflight', { cid, mode: 'primary' }, 1500);
  gestureDebug.push('ws', {
    event: 'connect_start',
    termId: termDebugId,
    cid,
    hasRememberedToken: Boolean(rememberedToken),
    useTokenFallback,
    useTokenFallbackOnFirstAttempt: Boolean(rememberedToken) && isIOS,
    tmuxProfile,
    hasQueryTokenInUrl: Boolean(new URL(window.location.href).searchParams.get('token')),
    url: `${wsProtocol}://${window.location.host}/ws`,
    wsHasTokenQuery: useTokenFallback
  });
  pushDiag('connect_socket_create', { useTokenFallback, cid });
  const ws = new WebSocket(wsUrl);
  socket = ws;
  attachSocketHandlers(ws, { cid });
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
  window.visualViewport.addEventListener('scroll', () => {
    const nowTs = Date.now();
    if (nowTs - lastDiagViewportEventTs < DIAG_VIEWPORT_INTERVAL_MS) return;
    lastDiagViewportEventTs = nowTs;
    pushDiag('visual_viewport_scroll');
  });
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
    touchLastY = touch.clientY;
    touchStartTs = Date.now();
    arbiterLineRemainder = 0;
    tmuxScrollLineRemainder = 0;
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
    let transitionedToScroll = false;
    if (gestureMode === 'tap_candidate' && (dx > TAP_MOVE_THRESHOLD_PX || dy > TAP_MOVE_THRESHOLD_PX)) {
      const fromState = gestureMode;
      gestureMode = 'scroll';
      touchLastY = touch.clientY;
      arbiterLineRemainder = 0;
      transitionedToScroll = true;
      gestureDebug.push('gesture', {
        from: fromState,
        to: 'scroll',
        dx: Math.round(dx),
        dy: Math.round(dy),
        ...gestureDebug.snapshot()
      });
      pushDiag('scroll_start', {
        source: isArbiterIOSScrollEnabled() ? 'arbiter' : 'native',
        dx: Math.round(dx),
        dy: Math.round(dy)
      });
      requestServerDiag('scroll_start', { source: isArbiterIOSScrollEnabled() ? 'arbiter' : 'native' }, 600);
      suppressFocusFor(FOCUS_SCROLL_SUPPRESS_MS);
    }
    if (gestureMode === 'scroll') {
      if (isArbiterIOSScrollEnabled()) {
        let deltaY = touch.clientY - touchLastY;
        if (transitionedToScroll && Math.abs(deltaY) < 1) {
          // On iOS the first scroll frame can be swallowed at state transition.
          deltaY = touch.clientY - touchStartY;
        }
        touchLastY = touch.clientY;
        const active = term.buffer.active;
        const beforeViewportY = Number(active?.viewportY || 0);
        const beforeBaseY = Number(active?.baseY || 0);
        const activeType = String(active?.type || 'unknown');
        const scrollResult = applyArbiterScrollDelta(deltaY);
        const afterViewportY = Number(term.buffer.active?.viewportY || 0);
        const localTermMoved = afterViewportY !== beforeViewportY || Boolean(scrollResult?.moved);
        const shouldFallbackToTmux =
          scrollResult?.wholeLines &&
          (activeType === 'alternate' || (!localTermMoved && beforeBaseY <= 0));
        if (shouldFallbackToTmux) {
          sendTmuxScrollLines(scrollResult.wholeLines);
          pushDiag('tmux_scroll_fallback', {
            reason: activeType === 'alternate' ? 'active_alternate' : 'no_local_scrollback',
            lines: scrollResult.wholeLines,
            activeType,
            beforeBaseY,
            beforeViewportY,
            afterViewportY
          });
        }
        event.preventDefault();
      }
      if (gestureDebug.isEnabled()) {
        const nowTs = Date.now();
        if (nowTs - lastDebugViewportLogTs > 120) {
          lastDebugViewportLogTs = nowTs;
          gestureDebug.push('viewport', { source: 'touchmove_scroll', ...gestureDebug.snapshot() });
        }
      }
      const nowTs = Date.now();
      if (nowTs - lastDiagScrollMoveTs > DIAG_SCROLL_MOVE_INTERVAL_MS) {
        lastDiagScrollMoveTs = nowTs;
        pushDiag('scroll_move', { source: isArbiterIOSScrollEnabled() ? 'arbiter' : 'native' });
        requestServerDiag('scroll_move', { source: isArbiterIOSScrollEnabled() ? 'arbiter' : 'native' }, 900);
      }
      suppressFocusFor(FOCUS_SCROLL_SUPPRESS_MS);
    }
  },
  { passive: false }
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
      arbiterLineRemainder = 0;
      tmuxScrollLineRemainder = 0;
      gestureDebug.push('gesture', { from: fromState, to: 'idle', reason: 'touchend_scroll' });
      pushDiag('scroll_end');
      requestServerDiag('scroll_end');
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
    arbiterLineRemainder = 0;
    tmuxScrollLineRemainder = 0;
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
