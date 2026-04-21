'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onStatusUpdate: (cb) => ipcRenderer.on('status-update', (_event, msg) => cb(msg)),
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
});
