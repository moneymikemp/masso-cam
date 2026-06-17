const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const isDev = process.env.NODE_ENV === 'development';
const store = new Store();

let mainWindow;
let pendingOpenPath = null;

const DEFAULT_TOOLS = [
  { name: '1/4" Flat End Mill', type: 'flat', diameter: 6.35, flutes: 2, material: 'HSS', notes: '', tool_number: 1, tipDiameter: 0, taperAngle: 0,
    feeds: [
      { material: 'MDF',      spindle_rpm: 18000, feed_rate: 2500, plunge_rate: 800,  depth_per_pass: 3.0, stepover: 0.45 },
      { material: 'Softwood', spindle_rpm: 16000, feed_rate: 2000, plunge_rate: 600,  depth_per_pass: 4.0, stepover: 0.45 },
      { material: 'Hardwood', spindle_rpm: 14000, feed_rate: 1500, plunge_rate: 500,  depth_per_pass: 2.5, stepover: 0.40 },
      { material: 'Aluminum', spindle_rpm: 10000, feed_rate: 800,  plunge_rate: 300,  depth_per_pass: 0.5, stepover: 0.35 },
      { material: 'HDPE',     spindle_rpm: 12000, feed_rate: 1800, plunge_rate: 600,  depth_per_pass: 3.0, stepover: 0.45 },
    ]},
  { name: '1/8" Flat End Mill', type: 'flat', diameter: 3.175, flutes: 2, material: 'HSS', notes: '', tool_number: 2, tipDiameter: 0, taperAngle: 0,
    feeds: [
      { material: 'MDF',      spindle_rpm: 22000, feed_rate: 1500, plunge_rate: 500,  depth_per_pass: 1.5, stepover: 0.45 },
      { material: 'Softwood', spindle_rpm: 20000, feed_rate: 1200, plunge_rate: 400,  depth_per_pass: 2.0, stepover: 0.45 },
      { material: 'Hardwood', spindle_rpm: 18000, feed_rate: 900,  plunge_rate: 300,  depth_per_pass: 1.5, stepover: 0.40 },
      { material: 'Aluminum', spindle_rpm: 12000, feed_rate: 500,  plunge_rate: 150,  depth_per_pass: 0.3, stepover: 0.30 },
    ]},
  { name: '1/2" Flat End Mill', type: 'flat', diameter: 12.7, flutes: 2, material: 'HSS', notes: '', tool_number: 3, tipDiameter: 0, taperAngle: 0,
    feeds: [
      { material: 'MDF',      spindle_rpm: 14000, feed_rate: 3000, plunge_rate: 1000, depth_per_pass: 5.0, stepover: 0.45 },
      { material: 'Softwood', spindle_rpm: 12000, feed_rate: 2500, plunge_rate: 800,  depth_per_pass: 6.0, stepover: 0.45 },
      { material: 'Hardwood', spindle_rpm: 10000, feed_rate: 1800, plunge_rate: 600,  depth_per_pass: 4.0, stepover: 0.40 },
    ]},
  { name: '90° V-Bit 1/4"', type: 'tapered', diameter: 6.35, flutes: 2, material: 'Carbide', notes: '', tool_number: 4, tipDiameter: 0, taperAngle: 45,
    feeds: [
      { material: 'MDF',      spindle_rpm: 18000, feed_rate: 2000, plunge_rate: 600,  depth_per_pass: 1.0, stepover: 0.10 },
      { material: 'Softwood', spindle_rpm: 16000, feed_rate: 1800, plunge_rate: 500,  depth_per_pass: 1.0, stepover: 0.10 },
      { material: 'Hardwood', spindle_rpm: 14000, feed_rate: 1200, plunge_rate: 400,  depth_per_pass: 0.8, stepover: 0.10 },
    ]},
  { name: '60° V-Bit 1/4"', type: 'tapered', diameter: 6.35, flutes: 2, material: 'Carbide', notes: '', tool_number: 5, tipDiameter: 0, taperAngle: 30,
    feeds: [
      { material: 'MDF',      spindle_rpm: 18000, feed_rate: 2000, plunge_rate: 600,  depth_per_pass: 1.0, stepover: 0.10 },
      { material: 'Hardwood', spindle_rpm: 14000, feed_rate: 1200, plunge_rate: 400,  depth_per_pass: 0.8, stepover: 0.10 },
    ]},
  { name: '1/4" Ball Nose', type: 'ball', diameter: 6.35, flutes: 2, material: 'Carbide', notes: '', tool_number: 6, tipDiameter: 0, taperAngle: 0,
    feeds: [
      { material: 'MDF',      spindle_rpm: 18000, feed_rate: 2000, plunge_rate: 600,  depth_per_pass: 2.0, stepover: 0.15 },
      { material: 'Hardwood', spindle_rpm: 14000, feed_rate: 1200, plunge_rate: 400,  depth_per_pass: 1.5, stepover: 0.15 },
      { material: 'Aluminum', spindle_rpm: 10000, feed_rate: 600,  plunge_rate: 200,  depth_per_pass: 0.4, stepover: 0.10 },
    ]},
  { name: '1/4" Upcut Spiral', type: 'upcut', diameter: 6.35, flutes: 2, material: 'Carbide', notes: '', tool_number: 7, tipDiameter: 0, taperAngle: 0,
    feeds: [
      { material: 'MDF',      spindle_rpm: 18000, feed_rate: 2800, plunge_rate: 900,  depth_per_pass: 3.5, stepover: 0.45 },
      { material: 'Softwood', spindle_rpm: 16000, feed_rate: 2200, plunge_rate: 700,  depth_per_pass: 4.5, stepover: 0.45 },
      { material: 'Plywood',  spindle_rpm: 16000, feed_rate: 2000, plunge_rate: 600,  depth_per_pass: 4.0, stepover: 0.45 },
    ]},
  { name: '1/4" Downcut Spiral', type: 'downcut', diameter: 6.35, flutes: 2, material: 'Carbide', notes: '', tool_number: 8, tipDiameter: 0, taperAngle: 0,
    feeds: [
      { material: 'MDF',      spindle_rpm: 18000, feed_rate: 2500, plunge_rate: 800,  depth_per_pass: 3.0, stepover: 0.45 },
      { material: 'Plywood',  spindle_rpm: 16000, feed_rate: 1800, plunge_rate: 600,  depth_per_pass: 3.5, stepover: 0.45 },
    ]},
];

function initToolStore() {
  if (!store.has('tools')) {
    const tools = DEFAULT_TOOLS.map((t, i) => ({ ...t, id: i + 1 }));
    store.set('tools', tools);
    store.set('nextToolId', tools.length + 1);
    console.log('[ToolStore] seeded', tools.length, 'default tools');
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: 'default',
    title: 'DMDCAM',
    backgroundColor: '#1a1a2e',
    icon: isDev
      ? path.join(__dirname, '../../public/icon.ico')
      : path.join(__dirname, '../../build/icon.ico'),
  });

  const startUrl = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, '../../build/index.html')}`;

  mainWindow.loadURL(startUrl);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  buildMenu();
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => mainWindow.webContents.send('menu-new-project') },
        { label: 'Open Project...', accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('menu-open-project') },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('menu-save-project') },
        { label: 'Save Project As...', accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow.webContents.send('menu-save-project-as') },
        { type: 'separator' },
        { label: 'Import DXF...', accelerator: 'CmdOrCtrl+I', click: () => mainWindow.webContents.send('menu-import-dxf') },
        { type: 'separator' },
        { label: 'Export G-code...', accelerator: 'CmdOrCtrl+E', click: () => mainWindow.webContents.send('menu-export-gcode') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => mainWindow.webContents.send('menu-undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: () => mainWindow.webContents.send('menu-redo') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => mainWindow.webContents.send('menu-select-all') },
        { label: 'Delete Selected', accelerator: 'Delete', click: () => mainWindow.webContents.send('menu-delete-selected') },
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom to Fit', accelerator: 'CmdOrCtrl+Shift+H', click: () => mainWindow.webContents.send('menu-zoom-fit') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => mainWindow.webContents.send('menu-zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+Minus', click: () => mainWindow.webContents.send('menu-zoom-out') },
        { type: 'separator' },
        { label: 'Show Toolpaths', type: 'checkbox', checked: true, click: (item) => mainWindow.webContents.send('menu-toggle-toolpaths', item.checked) },
        { label: 'Show Rapid Moves', type: 'checkbox', checked: true, click: (item) => mainWindow.webContents.send('menu-toggle-rapids', item.checked) },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ]
    },
    {
      label: 'Machine',
      submenu: [
        { label: 'Machine Setup...', click: () => mainWindow.webContents.send('menu-machine-setup') },
        { label: 'Post Processor Settings...', click: () => mainWindow.webContents.send('menu-post-settings') },
        { label: 'Tool Library...', click: () => mainWindow.webContents.send('menu-tool-library') },
        { type: 'separator' },
        { label: 'Inlay Wizard...', accelerator: 'CmdOrCtrl+Shift+W', click: () => mainWindow.webContents.send('menu-inlay-wizard') },
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About DMDCAM', click: () => mainWindow.webContents.send('menu-about') },
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Returns a .dmdcam/.mcam file path from argv if present, or null.
function getFileArgument(argv) {
  const args = argv || process.argv;
  for (let i = 1; i < args.length; i++) {
    if (/\.(dmdcam|mcam)$/i.test(args[i])) {
      try { if (fs.existsSync(args[i])) return args[i]; } catch {}
    }
  }
  return null;
}

// Enforce single-instance so double-clicking a file while the app is running
// focuses the existing window and loads the new file rather than spawning a second instance.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const filePath = getFileArgument(argv);
      if (filePath) {
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          mainWindow.webContents.send('open-file', { path: filePath, data });
        } catch {}
      }
    }
  });

  app.whenReady().then(() => {
    pendingOpenPath = getFileArgument();
    initToolStore();
    createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('dialog-open-dxf', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import DXF File',
    filters: [{ name: 'AutoCAD DXF', extensions: ['dxf'] }],
    properties: ['openFile']
  });
  if (result.canceled) return null;
  const content = fs.readFileSync(result.filePaths[0], 'utf-8');
  return { path: result.filePaths[0], content };
});

ipcMain.handle('dialog-save-gcode', async (_, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export G-code',
    defaultPath: defaultName || 'toolpath.nc',
    filters: [
      { name: 'G-code', extensions: ['nc', 'gcode', 'tap', 'cnc'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog-save-gcode-inlay', async (_, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export G-code — choose base filename (multiple files will be saved)',
    defaultPath: defaultName || 'inlay.nc',
    filters: [
      { name: 'G-code', extensions: ['nc', 'gcode', 'tap', 'cnc'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('write-file', async (_, filePath, content) => {
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
});

ipcMain.handle('dialog-open-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Project',
    filters: [{ name: 'DMDCAM Project', extensions: ['dmdcam', 'mcam'] }],
    properties: ['openFile']
  });
  if (result.canceled) return null;
  const content = fs.readFileSync(result.filePaths[0], 'utf-8');
  return { path: result.filePaths[0], data: JSON.parse(content) };
});

ipcMain.handle('dialog-save-project', async (_, defaultPath) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Project',
    defaultPath: (defaultPath || 'project.dmdcam').replace(/\.mcam$/, '.dmdcam'),
    filters: [{ name: 'DMDCAM Project', extensions: ['dmdcam'] }]
  });
  return result.canceled ? null : result.filePath;
});

// Tool library — persisted in electron-store (no native module required)
ipcMain.handle('db-get-tools', () => {
  return store.get('tools', []);
});

ipcMain.handle('db-save-tool', (_, tool) => {
  const tools = store.get('tools', []);
  const { units, ...toolData } = tool; // units is renderer-only display state, not persisted
  if (toolData.id && toolData.id !== '__new__') {
    const idx = tools.findIndex(t => t.id === toolData.id);
    if (idx >= 0) {
      tools[idx] = toolData;
      store.set('tools', tools);
      return tools[idx];
    }
  }
  const nextId = store.get('nextToolId', 1);
  const saved = { ...toolData, id: nextId };
  store.set('nextToolId', nextId + 1);
  store.set('tools', [...tools, saved]);
  return saved;
});

ipcMain.handle('db-delete-tool', (_, toolId) => {
  store.set('tools', (store.get('tools', [])).filter(t => t.id !== toolId));
  return true;
});

ipcMain.handle('store-get', (_, key) => store.get(key));
ipcMain.handle('store-set', (_, key, value) => { store.set(key, value); return true; });

// Returns and clears the file path passed as a CLI argument at launch (file association open).
ipcMain.handle('get-initial-file', () => {
  if (!pendingOpenPath) return null;
  const filePath = pendingOpenPath;
  pendingOpenPath = null;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { path: filePath, data: JSON.parse(content) };
  } catch {
    return null;
  }
});

// ── System font enumeration ────────────────────────────────────────────────────

let systemFontsCache = null;

function getSystemFonts() {
  const { execSync } = require('child_process');
  const windir = process.env.WINDIR || 'C:\\Windows';
  const fontDir = path.join(windir, 'Fonts');
  const fonts = [];
  const seenNames = new Set();

  try {
    const output = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"',
      { encoding: 'utf8', timeout: 15000 }
    );
    for (const line of output.split('\n')) {
      const match = line.trim().match(/^(.+?)\s+REG_SZ\s+(.+\.(?:ttf|otf))$/i);
      if (!match) continue;
      const family = match[1]
        .replace(/\s*\(TrueType\)/i, '')
        .replace(/\s*\(OpenType\)/i, '')
        .trim();
      const filename = match[2].trim();
      const fontPath = filename.includes(':\\') ? filename : path.join(fontDir, filename);
      if (!family || seenNames.has(family.toLowerCase())) continue;
      if (!fs.existsSync(fontPath)) continue;
      seenNames.add(family.toLowerCase());
      fonts.push({ family, path: fontPath });
    }
  } catch {
    try {
      const files = fs.readdirSync(fontDir);
      for (const file of files) {
        if (!/\.(ttf|otf)$/i.test(file)) continue;
        const family = file.replace(/\.(ttf|otf)$/i, '').replace(/[-_]/g, ' ');
        const fontPath = path.join(fontDir, file);
        if (!seenNames.has(family.toLowerCase())) {
          seenNames.add(family.toLowerCase());
          fonts.push({ family, path: fontPath });
        }
      }
    } catch {}
  }

  return fonts.sort((a, b) => a.family.localeCompare(b.family));
}

ipcMain.handle('list-system-fonts', () => {
  if (!systemFontsCache) systemFontsCache = getSystemFonts();
  return systemFontsCache;
});

ipcMain.handle('read-font-file', (_, fontPath) => {
  try {
    return fs.readFileSync(fontPath);
  } catch {
    return null;
  }
});
