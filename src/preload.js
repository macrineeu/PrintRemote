const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('status:get'),
  getPrinters: () => ipcRenderer.invoke('printers:list'),
  testPrint: (printerName) => ipcRenderer.invoke('print:test', printerName),
  openConfig: () => ipcRenderer.invoke('config:open'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  onLog: (cb) => ipcRenderer.on('log', (_e, entry) => cb(entry)),
});
