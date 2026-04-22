'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, globalShortcut } = require('electron');
const { spawn, spawnSync, execFile } = require('child_process');
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
    width: 1400,
    height: 900,
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

function setupTray(port) {
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    // Fallback: empty 16×16 icon so tray doesn't crash
    icon = nativeImage.createEmpty();
  }

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
    dotenv = {
      ...dotenv,
      SQLITE_PATH: dotenv.SQLITE_PATH || paths.sqliteMainPath,
      BILLING_SQLITE_PATH: dotenv.BILLING_SQLITE_PATH || paths.sqliteBillingPath,
    };

    sendStatus('Cleaning up previous processes...');
    await killZombies();

    sendStatus('Finding available port...');
    appPort = await findFreePort(8080);
    //appPort = 8081;
    log(`Using port ${appPort}`);

    dotenv.GMAIL_REDIRECT_URL = `http://localhost:${appPort}/gmail/auth/callback`;

    startGoServer(appPort, paths, dotenv);

    sendStatus('Waiting for server to be ready...');
    await waitForHealth(appPort, 30000);
    log('Server is healthy');

    sendStatus('Ready!');
    createMainWindow(appPort);
    setupTray(appPort);
    registerDevToolsShortcut();

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
