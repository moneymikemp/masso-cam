const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // File dialogs
  openDxf: () => ipcRenderer.invoke('dialog-open-dxf'),
  saveGcode: (name) => ipcRenderer.invoke('dialog-save-gcode', name),
  saveGcodeInlay: (name) => ipcRenderer.invoke('dialog-save-gcode-inlay', name),
  writeFile: (path, content) => ipcRenderer.invoke('write-file', path, content),
  openProject: () => ipcRenderer.invoke('dialog-open-project'),
  saveProject: (path) => ipcRenderer.invoke('dialog-save-project', path),

  // Tool library
  getTools: () => ipcRenderer.invoke('db-get-tools'),
  saveTool: (tool) => ipcRenderer.invoke('db-save-tool', tool),
  deleteTool: (id) => ipcRenderer.invoke('db-delete-tool', id),

  // Settings store
  storeGet: (key) => ipcRenderer.invoke('store-get', key),
  storeSet: (key, val) => ipcRenderer.invoke('store-set', key, val),

  // Tool library import
  openToolLibrary: () => ipcRenderer.invoke('dialog-open-tool-library'),
  importVtdb: (filePath) => ipcRenderer.invoke('import-vtdb', filePath),

  // File association / CLI open
  getInitialFile: () => ipcRenderer.invoke('get-initial-file'),
  onOpenFile: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('open-file', handler);
    return () => ipcRenderer.removeListener('open-file', handler);
  },

  // Font enumeration for Text Engraving
  listSystemFonts: () => ipcRenderer.invoke('list-system-fonts'),
  readFontFile: (fontPath) => ipcRenderer.invoke('read-font-file', fontPath),

  // Menu events
  onMenu: (callback) => {
    const events = [
      'menu-new-project', 'menu-open-project', 'menu-save-project', 'menu-save-project-as',
      'menu-import-dxf', 'menu-export-gcode', 'menu-undo', 'menu-redo',
      'menu-select-all', 'menu-delete-selected', 'menu-zoom-fit', 'menu-zoom-in',
      'menu-zoom-out', 'menu-toggle-toolpaths', 'menu-toggle-rapids',
      'menu-machine-setup', 'menu-post-settings', 'menu-tool-library', 'menu-about',
      'menu-inlay-wizard'
    ];
    const handlers = {};
    for (const event of events) {
      const handler = (_, ...args) => callback(event, ...args);
      ipcRenderer.on(event, handler);
      handlers[event] = handler;
    }
    return () => {
      for (const [event, handler] of Object.entries(handlers)) {
        ipcRenderer.removeListener(event, handler);
      }
    };
  }
});
