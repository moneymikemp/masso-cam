# MassoCAM

A 2.5D CAM application for the Masso G3 CNC router. Import DXF files from AutoCAD, set up machining operations, and export Masso-compatible G-code.

## Features

### Operations
- **2D Contour** — Profile cuts (outside/inside/center), with tabs, ramp entry, finish pass
- **2D Pocket** — Pocket clearing with inward offsets, finish pass
- **2D Adaptive** — Trochoidal-style clearing with optimal load control
- **Face** — Raster surface facing passes
- **Drill** — Point drilling with peck, chip break, dwell
- **Bore** — Helical bore interpolation
- **Circular** — Circular pocket from center outward
- **Engrave** — Follow DXF curves at depth
- **Trace** — Open curve following
- **Slot** — Slot with ramp entry
- **2D Chamfer** — Chamfer milling along contours
- **Thread** — Helical thread milling

### CAD Input
- DXF import (AutoCAD R12 through 2024)
- Supports: Lines, Arcs, Circles, LWPolylines, Polylines, Splines, Ellipses
- Layer management with visibility toggle
- Entity selection by click (Ctrl+click multi-select)

### Tool Library
- Persistent SQLite database
- Multiple tool types (flat, ball, V-bit, upcut, downcut, etc.)
- Per-material feeds & speeds presets
- Default library included (8 common tools)

### Post Processor
- Masso G3 compatible Fanuc-dialect G-code
- Configurable: units (mm/inch), coolant, line numbering, safe Z, etc.
- Estimated cycle time
- Syntax-highlighted G-code preview

### Project
- Save/load projects (.mcam files)
- Full undo/redo support

---

## Building the .exe (GitHub Actions — no local install needed)

### Step 1: Create a GitHub account
Go to https://github.com and sign up (free).

### Step 2: Create a new repository
1. Click **New repository**
2. Name it `masso-cam`
3. Set it to **Public** (required for free Actions minutes)
4. Click **Create repository**

### Step 3: Upload the project files
Option A — GitHub Desktop (easiest):
1. Download GitHub Desktop: https://desktop.github.com
2. Clone your new repository
3. Copy all these project files into the cloned folder
4. Commit and push

Option B — GitHub web upload:
1. In your repository, click **Add file → Upload files**
2. Drag and drop all the project files/folders
3. Click **Commit changes**

### Step 4: Watch it build
1. Go to your repository on GitHub
2. Click the **Actions** tab
3. You'll see "Build Windows Installer" running
4. Wait ~5-10 minutes

### Step 5: Download your .exe
1. When the build is green ✅, click on it
2. Scroll down to **Artifacts**
3. Download **MassoCAM-Windows-Installer**
4. Unzip it — inside is `MassoCAM Setup X.X.X.exe`
5. Run the installer on your Windows machine

Every time you push changes, a new .exe is automatically built.

---

## Local development (if you have Node.js)

```bash
npm install
npm start
```

## Local build

```bash
npm run build
```

The installer will be in the `dist/` folder.

---

## Usage

1. **Import DXF** — File → Import DXF (Ctrl+I)
   - All layers appear in the left panel
   - Toggle layer visibility with the eye icon
   - Click a layer name to select all entities on it

2. **Select geometry** — Click entities on the canvas
   - Ctrl+click to add to selection
   - Click a layer name to select the whole layer

3. **Add operation** — Click **+** in the Operations panel
   - Choose operation type
   - Selected entities are automatically assigned
   - Or assign later with "← Assign X selected"

4. **Configure** — Set tool, depths, feeds in the params panel below
   - Pick a tool from the library for automatic feeds/speeds
   - Or enter tool diameter and feeds manually

5. **Calculate** — Click **⟳ Calculate** button
   - Green dot = toolpath ready
   - Orange dot = not yet calculated

6. **Export** — Go to G-code tab
   - Click **⟳ Generate** to preview
   - Click **↓ Export .nc** to save

---

## G-code compatibility

Generated code uses:
- G20/G21 for units
- G90 absolute positioning
- G0 rapid, G1 feed, G2/G3 arcs
- M3/M5 spindle, M8/M9 coolant
- G4 dwell
- M30 program end

Tested format: Masso G3 v3.xx firmware

---

## License
MIT
