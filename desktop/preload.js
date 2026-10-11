const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronOverlay", { resize: h => ipcRenderer.send("resize", h) });
