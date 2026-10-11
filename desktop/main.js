// Climb Race overlay: a small always-on-top window over League (play in Borderless mode).
// Ctrl+Shift+O  show / hide      Ctrl+Shift+L  lock (clicks pass through to the game) / unlock
const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, shell } = require("electron");
const fs = require("fs"), path = require("path");
const URL = "https://hoeschley.github.io/climb-race/overlay.html?bare";
const cfgFile = () => path.join(app.getPath("userData"), "window.json");
let win, locked = false, tray;

function readCfg() { try { return JSON.parse(fs.readFileSync(cfgFile(), "utf8")); } catch { return {}; } }
function saveCfg() { try { const [x, y] = win.getPosition(); fs.writeFileSync(cfgFile(), JSON.stringify({ x, y, locked })); } catch {} }

function setLocked(v) {
  locked = v;
  win.setIgnoreMouseEvents(locked, { forward: true });
  win.setOpacity(locked ? 0.9 : 1);
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

app.whenReady().then(() => {
  const cfg = readCfg(), area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: 322, height: 300,
    x: cfg.x ?? area.x + area.width - 340, y: cfg.y ?? area.y + 120,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, focusable: true,
    alwaysOnTop: true, hasShadow: false, backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(URL);
  // links (u.gg builds…) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.on("moved", saveCfg);
  ipcMain.on("resize", (_e, h) => { const [w] = win.getSize(); win.setSize(w, Math.max(40, Math.min(900, h | 0))); });
  // keep it on top when the game grabs focus
  setInterval(() => { if (win.isVisible()) win.moveTop(); }, 3000);
  win.webContents.on("did-fail-load", () => setTimeout(() => win.loadURL(URL), 10000));

  globalShortcut.register("CommandOrControl+Shift+O", () => { win.isVisible() ? win.hide() : win.showInactive(); updateTray(); });
  globalShortcut.register("CommandOrControl+Shift+L", () => setLocked(!locked));

  const img = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGklEQVR4nGM4sSrvPyWYYdSAUQNGDRguBgAAHwvfH2uOggcAAAAASUVORK5CYII=");
  tray = new Tray(img); tray.setToolTip("Climb Race Overlay"); updateTray();
  if (cfg.locked) setLocked(true);
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
