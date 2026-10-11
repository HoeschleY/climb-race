// Climb Race overlay: a small always-on-top window over League (play in Borderless mode).
// Ctrl+Shift+O  show / hide      Ctrl+Shift+L  lock (clicks pass through to the game) / unlock
const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, shell } = require("electron");
const fs = require("fs"), path = require("path"), client = require("./client");
const URL = "https://hoeschley.github.io/climb-race/overlay.html?bare";
const cfgFile = () => path.join(app.getPath("userData"), "window.json");
let win, locked = false, tray;

function readCfg() { try { return JSON.parse(fs.readFileSync(cfgFile(), "utf8")); } catch { return {}; } }
function saveCfg() { try { const [x, y] = win.getPosition(); fs.writeFileSync(cfgFile(), JSON.stringify({ x, y, locked })); } catch {} }

function setLocked(v) {
  locked = v;
  win.setIgnoreMouseEvents(locked);   // no mouse forwarding: it hooks every mouse move and can stutter games
  saveCfg(); updateTray();
}
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win.isVisible() ? "Hide (Ctrl+Shift+O)" : "Show (Ctrl+Shift+O)", click: () => { win.isVisible() ? win.hide() : win.showInactive(); updateTray(); } },
    { label: locked ? "Unlock to move (Ctrl+Shift+L)" : "Lock, clicks go to the game (Ctrl+Shift+L)", click: () => setLocked(!locked) },
    { label: "Reload", click: () => win.reload() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
}

// The overlay is a few lines of text: keep it off the GPU so it never competes with the game
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu-vsync");
app.commandLine.appendSwitch("disable-smooth-scrolling");

app.whenReady().then(() => {
  const cfg = readCfg(), area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: 322, height: 300,
    x: cfg.x ?? area.x + area.width - 340, y: cfg.y ?? area.y + 120,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, focusable: true,
    alwaysOnTop: true, hasShadow: false, backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(URL);
  // links (u.gg builds…) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.on("moved", saveCfg);
  let lastH = 0;
  ipcMain.on("resize", (_e, h) => { h = Math.max(40, Math.min(900, h | 0)); if (Math.abs(h - lastH) < 2) return; lastH = h; const [w] = win.getSize(); win.setSize(w, h); });
  win.webContents.on("did-fail-load", () => setTimeout(() => win.loadURL(URL), 10000));

  // League client state (champ select, loading, in game) → overlay page
  let lastSent = "";
  const loop = async () => { try { const st = await client.poll(), j = JSON.stringify(st); if (j !== lastSent && !win.isDestroyed()) { lastSent = j; win.webContents.send("client", st); } } catch {}
    setTimeout(loop, client.intervalFor()); };
  win.webContents.on("did-finish-load", () => { lastSent = ""; });
  loop();

  globalShortcut.register("CommandOrControl+Shift+O", () => { win.isVisible() ? win.hide() : win.showInactive(); updateTray(); });
  globalShortcut.register("CommandOrControl+Shift+L", () => setLocked(!locked));

  const img = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGklEQVR4nGM4sSrvPyWYYdSAUQNGDRguBgAAHwvfH2uOggcAAAAASUVORK5CYII=");
  tray = new Tray(img); tray.setToolTip("Climb Race Overlay"); updateTray();
  if (cfg.locked) setLocked(true);
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
