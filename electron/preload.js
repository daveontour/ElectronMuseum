'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onStatusUpdate: (cb) => ipcRenderer.on('status-update', (_event, msg) => cb(msg)),
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  getDbPath:      ()        => ipcRenderer.invoke('get-db-path'),
  getLogLevel:    ()        => ipcRenderer.invoke('get-log-level'),
  selectDatabase: (opts)    => ipcRenderer.invoke('select-db', opts),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
});
