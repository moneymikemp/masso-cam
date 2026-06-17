const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const isDev = process.env.NODE_ENV === 'development';
const store = new Store();

let mainWindow;
let db;
let pendingOpenPath = null;

function initDatabase() {
  try {
    const Database = require('better-sqlite3');
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'dmdcam.db');
    // One-time migration: copy old MassoCAM DB if new one doesn't exist yet
    const oldDbSameDir = path.join(userDataPath, 'massocam.db');
    const oldDbProdDir = path.join(path.dirname(userDataPath), 'MassoCAM', 'massocam.db');
    if (!fs.existsSync(dbPath)) {
      if (fs.existsSync(oldDbSameDir)) try { fs.copyFileSync(oldDbSameDir, dbPath); } catch (_) {}
      else if (fs.existsSync(oldDbProdDir)) try { fs.copyFileSync(oldDbProdDir, dbPath); } catch (_) {}
    }
    db = new Database(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        diameter REAL NOT NULL,
        flutes INTEGER DEFAULT 2,
        material TEXT DEFAULT 'HSS',
        notes TEXT DEFAULT '',
        tool_number INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS feeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_id INTEGER NOT NULL,
        material TEXT NOT NULL,
        spindle_rpm INTEGER NOT NULL,
        feed_rate REAL NOT NULL,
        plunge_rate REAL NOT NULL,
        depth_per_pass REAL NOT NULL,
        stepover REAL DEFAULT 0.5,
        FOREIGN KEY (tool_id) REFERENCES tools(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Schema migrations — each wrapped so they're no-ops on fresh DBs.
    try { db.exec(`ALTER TABLE tools ADD COLUMN tool_number INTEGER DEFAULT 1`); } catch (_) {}
    try { db.exec(`ALTER TABLE tools ADD COLUMN tip_diameter REAL DEFAULT 0`); } catch (_) {}
    try { db.exec(`ALTER TABLE tools ADD COLUMN taper_angle  REAL DEFAULT 0`); } catch (_) {}

    // Data migration: vbit → tapered with angle inferred from tool name.
    db.prepare(`
      UPDATE tools SET
        type         = 'tapered',
        taper_angle  = CASE
          WHEN name LIKE '%90%' THEN 45
          WHEN name LIKE '%60%' THEN 30
          WHEN name LIKE '%45%' THEN 22.5
          ELSE 45
        END,
        tip_diameter = 0
      WHERE type = 'vbit'
    `).run();

    const toolCount = db.prepare('SELECT COUNT(*) as count FROM tools').get();
    if (toolCount.count === 0) {
      insertDefaultTools();
    }
  } catch (err) {
    console.error('Database init error:', err);
  }
}

function insertDefaultTools() {
  const insertTool = db.prepare(`
    INSERT INTO tools (name, type, diameter, flutes, material, notes, tip_diameter, taper_angle)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFeed = db.prepare(`
    INSERT INTO feeds (tool_id, material, spindle_rpm, feed_rate, plunge_rate, depth_per_pass, stepover)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const defaults = [
    { name: '1/4" Flat End Mill', type: 'flat', diameter: 6.35, flutes: 2, material: 'HSS',
      feeds: [
        { mat: 'MDF', rpm: 18000, feed: 2500, plunge: 800, dpp: 3.0, so: 0.45 },
        { mat: 'Softwood', rpm: 16000, feed: 2000, plunge: 600, dpp: 4.0, so: 0.45 },
        { mat: 'Hardwood', rpm: 14000, feed: 1500, plunge: 500, dpp: 2.5, so: 0.40 },
        { mat: 'Aluminum', rpm: 10000, feed: 800, plunge: 300, dpp: 0.5, so: 0.35 },
        { mat: 'HDPE', rpm: 12000, feed: 1800, plunge: 600, dpp: 3.0, so: 0.45 },
      ]},
    { name: '1/8" Flat End Mill', type: 'flat', diameter: 3.175, flutes: 2, material: 'HSS',
      feeds: [
        { mat: 'MDF', rpm: 22000, feed: 1500, plunge: 500, dpp: 1.5, so: 0.45 },
        { mat: 'Softwood', rpm: 20000, feed: 1200, plunge: 400, dpp: 2.0, so: 0.45 },
        { mat: 'Hardwood', rpm: 18000, feed: 900, plunge: 300, dpp: 1.5, so: 0.40 },
        { mat: 'Aluminum', rpm: 12000, feed: 500, plunge: 150, dpp: 0.3, so: 0.30 },
      ]},
    { name: '1/2" Flat End Mill', type: 'flat', diameter: 12.7, flutes: 2, material: 'HSS',
      feeds: [
        { mat: 'MDF', rpm: 14000, feed: 3000, plunge: 1000, dpp: 5.0, so: 0.45 },
        { mat: 'Softwood', rpm: 12000, feed: 2500, plunge: 800, dpp: 6.0, so: 0.45 },
        { mat: 'Hardwood', rpm: 10000, feed: 1800, plunge: 600, dpp: 4.0, so: 0.40 },
      ]},
    { name: '90° V-Bit 1/4"', type: 'tapered', diameter: 6.35, flutes: 2, material: 'Carbide', tipDiameter: 0, taperAngle: 45,
      feeds: [
        { mat: 'MDF', rpm: 18000, feed: 2000, plunge: 600, dpp: 1.0, so: 0.10 },
        { mat: 'Softwood', rpm: 16000, feed: 1800, plunge: 500, dpp: 1.0, so: 0.10 },
        { mat: 'Hardwood', rpm: 14000, feed: 1200, plunge: 400, dpp: 0.8, so: 0.10 },
      ]},
    { name: '60° V-Bit 1/4"', type: 'tapered', diameter: 6.35, flutes: 2, material: 'Carbide', tipDiameter: 0, taperAngle: 30,
      feeds: [
        { mat: 'MDF', rpm: 18000, feed: 2000, plunge: 600, dpp: 1.0, so: 0.10 },
        { mat: 'Hardwood', rpm: 14000, feed: 1200, plunge: 400, dpp: 0.8, so: 0.10 },
      ]},
    { name: '1/4" Ball Nose', type: 'ball', diameter: 6.35, flutes: 2, material: 'Carbide',
      feeds: [
        { mat: 'MDF', rpm: 18000, feed: 2000, plunge: 600, dpp: 2.0, so: 0.15 },
        { mat: 'Hardwood', rpm: 14000, feed: 1200, plunge: 400, dpp: 1.5, so: 0.15 },
        { mat: 'Aluminum', rpm: 10000, feed: 600, plunge: 200, dpp: 0.4, so: 0.10 },
      ]},
    { name: '1/4" Upcut Spiral', type: 'upcut', diameter: 6.35, flutes: 2, material: 'Carbide',
      feeds: [
        { mat: 'MDF', rpm: 18000, feed: 2800, plunge: 900, dpp: 3.5, so: 0.45 },
        { mat: 'Softwood', rpm: 16000, feed: 2200, plunge: 700, dpp: 4.5, so: 0.45 },
        { mat: 'Plywood', rpm: 16000, feed: 2000, plunge: 600, dpp: 4.0, so: 0.45 },
      ]},
    { name: '1/4" Downcut Spiral', type: 'downcut', diameter: 6.35, flutes: 2, material: 'Carbide',
      feeds: [
        { mat: 'MDF', rpm: 18000, feed: 2500, plunge: 800, dpp: 3.0, so: 0.45 },
        { mat: 'Plywood', rpm: 16000, feed: 1800, plunge: 600, dpp: 3.5, so: 0.45 },
      ]},
  ];

  for (const tool of defaults) {
    const result = insertTool.run(
      tool.name, tool.type, tool.diameter, tool.flutes, tool.material, tool.notes || '',
      tool.tipDiameter ?? 0, tool.taperAngle ?? 0,
    );
    for (const f of tool.feeds) {
      insertFeed.run(result.lastInsertRowid, f.mat, f.rpm, f.feed, f.plunge, f.dpp, f.so);
    }
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
    initDatabase();
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

// Tool library DB handlers
ipcMain.handle('db-get-tools', () => {
  if (!db) return [];
  const tools = db.prepare('SELECT * FROM tools ORDER BY type, name').all();
  for (const tool of tools) {
    tool.feeds = db.prepare('SELECT * FROM feeds WHERE tool_id = ?').all(tool.id);
    // Map snake_case DB columns to camelCase for the renderer.
    tool.tipDiameter = tool.tip_diameter ?? 0;
    tool.taperAngle  = tool.taper_angle  ?? 0;
    delete tool.tip_diameter;
    delete tool.taper_angle;
  }
  return tools;
});

ipcMain.handle('db-save-tool', (_, tool) => {
  if (!db) return null;
  const { feeds, ...toolData } = tool;
  let toolId = toolData.id;
  const toolNum     = toolData.tool_number ?? 1;
  const tipDiameter = toolData.tipDiameter ?? 0;
  const taperAngle  = toolData.taperAngle  ?? 0;
  if (toolId) {
    db.prepare('UPDATE tools SET name=?, type=?, diameter=?, flutes=?, material=?, notes=?, tool_number=?, tip_diameter=?, taper_angle=? WHERE id=?')
      .run(toolData.name, toolData.type, toolData.diameter, toolData.flutes, toolData.material, toolData.notes, toolNum, tipDiameter, taperAngle, toolId);
    db.prepare('DELETE FROM feeds WHERE tool_id=?').run(toolId);
  } else {
    const result = db.prepare('INSERT INTO tools (name,type,diameter,flutes,material,notes,tool_number,tip_diameter,taper_angle) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(toolData.name, toolData.type, toolData.diameter, toolData.flutes, toolData.material, toolData.notes || '', toolNum, tipDiameter, taperAngle);
    toolId = result.lastInsertRowid;
  }
  const insertFeed = db.prepare('INSERT INTO feeds (tool_id,material,spindle_rpm,feed_rate,plunge_rate,depth_per_pass,stepover) VALUES (?,?,?,?,?,?,?)');
  for (const f of (feeds || [])) {
    insertFeed.run(toolId, f.material, f.spindle_rpm, f.feed_rate, f.plunge_rate, f.depth_per_pass, f.stepover);
  }
  const saved = db.prepare('SELECT * FROM tools WHERE id=?').get(toolId);
  saved.feeds = db.prepare('SELECT * FROM feeds WHERE tool_id=?').all(toolId);
  return saved;
});

ipcMain.handle('db-delete-tool', (_, toolId) => {
  if (!db) return false;
  db.prepare('DELETE FROM tools WHERE id=?').run(toolId);
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
