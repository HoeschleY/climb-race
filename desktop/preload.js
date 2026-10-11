const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronOverlay", {
  resize: h => ipcRenderer.send("resize", h),
  onClient: cb => ipcRenderer.on("client", (_e, st) => cb(st)),   // League client phase + champ select
});
