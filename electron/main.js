'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, globalShortcut } = require('electron');
const { spawn, execFile } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let mainWindow = null;
let loadingWindow = null;
let tray = null;
let goProcess = null;
let isQuitting = false;
let appPort = null;
let activeDotenv = null;
let ollamaProcess = null;

// ---------------------------------------------------------------------------
// Resource path resolution
// ---------------------------------------------------------------------------
// Dev mode  (app.isPackaged === false): project root is one level above electron/
// Packaged: process.resourcesPath contains extraResources

function getResourcesDir() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
}

function getPaths() {
  const res = getResourcesDir();
  const userData = app.getPath('userData');

  //userData = "C:/Users/dave_/OneDrive/Desktop/digitalmuseum"
  const dataDir = path.join(userData, 'data');
  return {
    // Install / project root (contains bin/, static/, templates/). The Go server
    // must run with this as cwd so relative paths like static/data/*.json in
    // cmd/server/main.go resolve correctly — same as cmd/launcher (cmd.Dir = root).
    appRoot:     res,
    goExe:       path.join(res, 'bin', 'digitalmuseum.exe'),
    templatesDir: path.join(res, 'templates'),
    staticDir:   path.join(res, 'static'),
    userData,
    dataDir,
    sqliteMainPath: path.join(dataDir, 'main.sqlite'),
    sqliteBillingPath: path.join(dataDir, 'billing.sqlite'),
    dotEnvPath:  path.join(userData, '.env'),
    dotEnvDefaults: app.isPackaged
      ? path.join(process.resourcesPath, '.env.defaults')
      : path.join(__dirname, '.env.defaults'),
    appLogFile:  path.join(userData, 'logs', 'app.log'),
  };
}

/** Logs SQLite paths as configured, absolute, relative to userData/appRoot/cwd, and file presence. */
function logSqliteDatabasePaths(paths, mainPath, billingPath, ctxLabel) {
  const cwd = process.cwd();
  const abs = (p) => path.resolve(p);
  const rel = (baseDir, targetPath) => {
    try {
      return path.relative(path.resolve(baseDir), path.resolve(targetPath));
    } catch (e) {
      return `(relative error: ${e.message})`;
    }
  };
  const fileInfo = (label, p) => {
    const a = abs(p);
    let exists = false;
    let sizeBytes = 0;
    try {
      const st = fs.statSync(a);
      exists = true;
      sizeBytes = st.size;
    } catch (_) { /* not found */ }
    log(`[db:${ctxLabel}] ${label}: configured_path=${p}`);
    log(`[db:${ctxLabel}] ${label}: absolute=${a}`);
    log(`[db:${ctxLabel}] ${label}: relative_to_userData=${rel(paths.userData, a)} relative_to_appRoot=${rel(paths.appRoot, a)} relative_to_electron_cwd=${rel(cwd, a)}`);
    log(`[db:${ctxLabel}] ${label}: exists_on_disk=${exists} size_bytes=${exists ? sizeBytes : 0}${exists ? '' : ' (new or not yet created)'}`);
  };
  log(`[db:${ctxLabel}] --- sqlite path resolution ---`);
  log(`[db:${ctxLabel}] userData=${paths.userData}`);
  log(`[db:${ctxLabel}] appRoot_go_cwd=${paths.appRoot}`);
  log(`[db:${ctxLabel}] electron_process.cwd=${cwd}`);
  fileInfo('main', mainPath);
  fileInfo('billing', billingPath);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

let logStream = null;

function setupLogging(logFile) {
  try {
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  } catch (e) {
    // Fall back to console if log file can't be opened
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

// ---------------------------------------------------------------------------
// Free port finding
// ---------------------------------------------------------------------------

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(preferred = 8080) {
  for (let p = preferred; p < preferred + 100; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error('No free port found in range 8080–8179');
}

// ---------------------------------------------------------------------------
// HTTP readiness polling
// ---------------------------------------------------------------------------

async function waitForHealth(port, maxMs = 30000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch (_) { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Go server did not become healthy within ${maxMs}ms`);
}

// ---------------------------------------------------------------------------
// .env file parser (no npm dependency)
// ---------------------------------------------------------------------------

function loadDotEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function upsertEnvVar(content, key, value) {
  const re = new RegExp(`^${key}\\s*=.*`, 'm');
  return re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : content.trimEnd() + `\n${key}=${value}\n`;
}

function parseBoolEnv(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

// ---------------------------------------------------------------------------
// Ollama local AI helpers
// ---------------------------------------------------------------------------

function getOllamaExe() {
  return path.join(getResourcesDir(), 'bin', 'Ollama', 'ollama.exe');
}

async function waitForOllama(maxMs = 30000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:11434/');
      if (res.ok || res.status < 500) return;
    } catch (_) { /* not ready */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Ollama did not start within ${maxMs / 1000}s`);
}

async function ensureOllamaRunning() {
  const ollamaExe = getOllamaExe();
  if (!fs.existsSync(ollamaExe)) {
    return { ok: false, error: 'Ollama executable not found' };
  }
  try {
    const r = await fetch('http://127.0.0.1:11434/');
    if (r.ok || r.status < 500) {
      log('Ollama already running');
      return { ok: true };
    }
  } catch (_) { /* not running yet */ }
  const paths = getPaths();
  let logFd;
  try { logFd = fs.openSync(paths.appLogFile, 'a'); } catch (_) { /* ignore */ }
  ollamaProcess = spawn(ollamaExe, ['serve'], {
    windowsHide: true,
    stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    env: { ...process.env, OLLAMA_NUM_CTX: '32768' },
  });
  ollamaProcess.on('exit', (code) => log(`Ollama exited (code=${code})`));
  ollamaProcess.on('error', (err) => log(`Ollama error: ${err.message}`));
  try {
    await waitForOllama(30000);
    log('Ollama server ready');
    return { ok: true };
  } catch (err) {
    log(`start-ollama: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Status (embedded PostgreSQL removed — app uses SQLite files under userData/data/)
// ---------------------------------------------------------------------------

function sendStatus(msg) {
  log(msg);
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.webContents.send('status-update', msg);
  }
}

async function killZombies() {
  return new Promise((resolve) => {
    execFile('taskkill', ['/f', '/im', 'digitalmuseum.exe', '/t'],
      { windowsHide: true }, () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Go server lifecycle
// ---------------------------------------------------------------------------

function startGoServer(port, paths, dotenv) {
  sendStatus('Starting application server...');
  log(`Starting Go server on port ${port}...`);

  // Open a synchronous fd for the Go server log — spawn requires an already-open
  // fd, not a WriteStream (which has fd=null until the async 'open' event fires).
  let appLogFd;
  try {
    appLogFd = fs.openSync(paths.appLogFile, 'a');
  } catch (_) { /* ignore — fall back to 'ignore' */ }

  // Build env: process.env (PATH etc.) → dotenv (user config) → our hard overrides.
  const env = {
    ...process.env,
    ...dotenv,
    HOST_PORT:             String(port),
    SQLITE_PATH:           dotenv.SQLITE_PATH || paths.sqliteMainPath,
    BILLING_SQLITE_PATH:   dotenv.BILLING_SQLITE_PATH || paths.sqliteBillingPath,
    TEMPLATES_DIR:         paths.templatesDir,
    ASSET_STATIC_DIR:      paths.staticDir,
    DEPLOYMENT_NATURE:     dotenv.DEPLOYMENT_NATURE  || 'local',
    SESSION_COOKIE_SECURE: 'false',
  };

  logSqliteDatabasePaths(paths, env.SQLITE_PATH, env.BILLING_SQLITE_PATH, 'electron-spawn-env');

  goProcess = spawn(paths.goExe, [], {
    cwd: paths.appRoot,
    env,
    windowsHide: true,
    stdio: ['ignore',
      appLogFd ?? 'ignore',
      appLogFd ?? 'ignore'],
  });

  goProcess.on('exit', (code, signal) => {
    log(`Go server exited (code=${code}, signal=${signal})`);
  });

  goProcess.on('error', (err) => {
    log(`Go server spawn error: ${err.message}`);
  });
}

async function restartGoServer(newSqlitePath, logLevel) {
  if (goProcess && !goProcess.killed) {
    goProcess.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        if (goProcess && !goProcess.killed) goProcess.kill('SIGKILL');
        resolve();
      }, 5000);
      goProcess.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
  const paths = getPaths();
  let envContent = fs.existsSync(paths.dotEnvPath)
    ? fs.readFileSync(paths.dotEnvPath, 'utf8') : '';

  envContent = upsertEnvVar(envContent, 'SQLITE_PATH', newSqlitePath);
  if (logLevel) {
    envContent = upsertEnvVar(envContent, 'LOG_LEVEL', logLevel);
  }
  fs.writeFileSync(paths.dotEnvPath, envContent, 'utf8');
  activeDotenv = { ...activeDotenv, SQLITE_PATH: newSqlitePath };
  if (logLevel) activeDotenv = { ...activeDotenv, LOG_LEVEL: logLevel };
  startGoServer(appPort, paths, activeDotenv);
  await waitForHealth(appPort, 30000);
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

function createLoadingWindow() {
  loadingWindow = new BrowserWindow({
    width: 480,
    height: 300,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  loadingWindow.loadFile(path.join(__dirname, 'loading.html'));
  loadingWindow.on('closed', () => { loadingWindow = null; });
}

function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1080,
    show: false,
    title: 'Digital Museum',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  //mainWindow.loadURL(`http://localhost:${port}/`);

  mainWindow.loadURL(`http://localhost:${port}/`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (loadingWindow && !loadingWindow.isDestroyed()) {
      loadingWindow.close();
    }
    log('Main window ready');
  });

  // Closing the window shuts down the backend and quits the app.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      isQuitting = true;
      shutdown().finally(() => app.quit());
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function toggleMainWindowDevTools() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.toggleDevTools();
  }
}

/** Chromium-style shortcut; registered globally because Menu.setApplicationMenu(null) removes the default View menu. */
function registerDevToolsShortcut() {
  const ok = globalShortcut.register('CommandOrControl+Shift+I', toggleMainWindowDevTools);
  if (!ok) {
    log('Could not register Ctrl+Shift+I (Cmd+Opt+I on macOS) for Developer Tools — use the tray menu instead.');
  }
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

function loadTrayNativeImage() {
  const icoPath = path.join(__dirname, 'build', 'icon.ico');
  const pngPath = path.join(__dirname, 'tray-icon.png');
  if (fs.existsSync(icoPath)) {
    const img = nativeImage.createFromPath(icoPath);
    if (!img.isEmpty()) return img;
    log(`Tray: could not decode ${icoPath}`);
  }
  if (fs.existsSync(pngPath)) {
    const img = nativeImage.createFromPath(pngPath);
    if (!img.isEmpty()) return img;
    log(`Tray: could not decode ${pngPath}`);
  }
  log('Tray: no icon.ico or tray-icon.png — using empty image');
  return nativeImage.createEmpty();
}

function setupTray(port) {
  const icon = loadTrayNativeImage();

  tray = new Tray(icon);
  tray.setToolTip('Digital Museum');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Digital Museum',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createMainWindow(port);
        }
      },
    },
    {
      label: 'Toggle Developer Tools',
      click: () => toggleMainWindowDevTools(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        shutdown().finally(() => app.quit());
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

async function shutdown() {
  log('Shutting down...');
  const paths = getPaths();

  if (goProcess && !goProcess.killed) {
    goProcess.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        if (goProcess && !goProcess.killed) goProcess.kill('SIGKILL');
        resolve();
      }, 5000);
      goProcess.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  if (ollamaProcess && !ollamaProcess.killed) {
    ollamaProcess.kill('SIGTERM');
  }

  log('Shutdown complete');
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Single-instance guard
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  const paths = getPaths();
  // Writable dirs before any log or pg_ctl (packaged app resources/ may be read-only).
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.mkdirSync(path.dirname(paths.appLogFile), { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true });

  setupLogging(paths.appLogFile);
  log('Digital Museum starting...');

  // Copy .env.defaults to userData on first run
  if (!fs.existsSync(paths.dotEnvPath) && fs.existsSync(paths.dotEnvDefaults)) {
    fs.copyFileSync(paths.dotEnvDefaults, paths.dotEnvPath);
    log(`Created ${paths.dotEnvPath} from defaults`);
  }

  createLoadingWindow();

  try {
    // Load config: defaults as base, user's AppData .env on top.
    // In dev mode, also layer in the project root .env last so local DB
    // credentials (which aren't committed) stay in sync automatically.
    let dotenv = {
      ...loadDotEnv(paths.dotEnvDefaults),
      ...loadDotEnv(paths.dotEnvPath),
      ...(app.isPackaged ? {} : loadDotEnv(path.join(__dirname, '..', '.env'))),
    };
    // Packaged app: always use userData/data/*.sqlite so a leftover SQLITE_PATH in
    // %APPDATA%\.env (e.g. from dev) cannot point the installer at the wrong DB.
    if (app.isPackaged) {
      dotenv = {
        ...dotenv,
        SQLITE_PATH: paths.sqliteMainPath,
        BILLING_SQLITE_PATH: paths.sqliteBillingPath,
      };
    } else {
      dotenv = {
        ...dotenv,
        SQLITE_PATH: dotenv.SQLITE_PATH || paths.sqliteMainPath,
        BILLING_SQLITE_PATH: dotenv.BILLING_SQLITE_PATH || paths.sqliteBillingPath,
      };
    }
    logSqliteDatabasePaths(paths, dotenv.SQLITE_PATH, dotenv.BILLING_SQLITE_PATH, 'electron-resolved');

    sendStatus('Cleaning up previous processes...');
    await killZombies();

    sendStatus('Finding available port...');
    appPort = await findFreePort(8080);
    //appPort = 8081;
    log(`Using port ${appPort}`);

    dotenv.GMAIL_REDIRECT_URL = `http://localhost:${appPort}/gmail/auth/callback`;

    activeDotenv = dotenv;
    startGoServer(appPort, paths, dotenv);

    sendStatus('Waiting for server to be ready...');
    await waitForHealth(appPort, 30000);
    log('Server is healthy');

    sendStatus('Ready!');
    createMainWindow(appPort);
    setupTray(appPort);
    registerDevToolsShortcut();
    if (parseBoolEnv(dotenv.AUTO_START_LOCAL_AI)) {
      log('AUTO_START_LOCAL_AI enabled — starting Local AI');
      ensureOllamaRunning().then((res) => {
        if (!res.ok) log(`AUTO_START_LOCAL_AI failed: ${res.error || 'unknown'}`);
      });
    }

  } catch (err) {
    log(`Startup error: ${err.message}`);
    sendStatus(`Error: ${err.message}`);
    // Keep loading window open so user can see the error
  }
});

app.on('window-all-closed', () => {
  // On Windows/Linux, keep running in tray instead of quitting
  // (macOS convention would be different but this is a Windows-first app)
});

// ── File / directory picker (used by import dialogs) ─────────────────────────
ipcMain.handle('show-open-dialog', (_event, options) => dialog.showOpenDialog(options));
ipcMain.handle('show-save-dialog', (_event, options) => dialog.showSaveDialog(options));

ipcMain.handle('get-db-path', () => {
  const paths = getPaths();
  return (activeDotenv && activeDotenv.SQLITE_PATH) || paths.sqliteMainPath;
});

ipcMain.handle('get-log-level', () => (activeDotenv && activeDotenv.LOG_LEVEL) || 'warn');

ipcMain.handle('select-db', async (_event, opts) => {
  // opts: { path: string, logLevel?: string }
  const newPath = typeof opts === 'string' ? opts : opts.path;
  const logLevel = typeof opts === 'string' ? undefined : opts.logLevel;
  try {
    await restartGoServer(newPath, logLevel);
    return { ok: true };
  } catch (err) {
    log(`select-db error: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

// ── Ollama local AI ───────────────────────────────────────────────────────────

ipcMain.handle('check-ollama-model', () => {
  const ollamaExe = getOllamaExe();
  if (!fs.existsSync(ollamaExe)) {
    return { ok: false, error: 'Ollama executable not found at ' + ollamaExe };
  }
  // Check the manifest directory — avoids spawning the CLI which needs a running daemon.
  const manifestDir = path.join(
    require('os').homedir(),
    '.ollama', 'models', 'manifests',
    'registry.ollama.ai', 'library', 'gemma4',
  );
  const hasModel = fs.existsSync(manifestDir) &&
    fs.readdirSync(manifestDir).length > 0;
  return { ok: true, hasModel };
});

ipcMain.handle('pull-ollama-model', () => {
  const ollamaExe = getOllamaExe();
  return new Promise((resolve) => {
    const proc = spawn(ollamaExe, ['pull', 'gemma4-32k'], { windowsHide: true });
    const send = (line) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ollama-pull-progress', line);
      }
    };
    let errOut = '';
    proc.stdout && proc.stdout.on('data', (d) =>
      d.toString().split('\n').forEach(l => { if (l.trim()) send(l.trim()); }));
    proc.stderr && proc.stderr.on('data', (d) => {
      errOut += d.toString();
      d.toString().split('\n').forEach(l => { if (l.trim()) send(l.trim()); });
    });
    proc.on('close', (code) =>
      code === 0 ? resolve({ ok: true }) : resolve({ ok: false, error: errOut || `exit ${code}` }));
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

ipcMain.handle('start-ollama', async () => {
  return ensureOllamaRunning();
});

ipcMain.handle('get-auto-start-local-ai', () => {
  const paths = getPaths();
  const env = activeDotenv || loadDotEnv(paths.dotEnvPath);
  return parseBoolEnv(env.AUTO_START_LOCAL_AI);
});

ipcMain.handle('set-auto-start-local-ai', (_event, enabled) => {
  const paths = getPaths();
  try {
    let envContent = fs.existsSync(paths.dotEnvPath)
      ? fs.readFileSync(paths.dotEnvPath, 'utf8') : '';
    envContent = upsertEnvVar(envContent, 'AUTO_START_LOCAL_AI', enabled ? 'true' : 'false');
    fs.writeFileSync(paths.dotEnvPath, envContent, 'utf8');
    activeDotenv = { ...(activeDotenv || {}), AUTO_START_LOCAL_AI: enabled ? 'true' : 'false' };
    return { ok: true };
  } catch (err) {
    log(`set-auto-start-local-ai error: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', async (e) => {
  globalShortcut.unregisterAll();
  // Only intercept if Go process is still running to allow graceful shutdown
  if (goProcess && !goProcess.killed) {
    e.preventDefault();
    await shutdown();
    app.quit();
  }
});
