# DMDCAM Feature Reference

**Version 1.1.7** — 2.5D CAM for Masso G3 CNC Router  
**Stack:** Electron 29 + React 18 · Formats: DXF R12–2024 · Post Processor: Masso G3

---

## Table of Contents

1. [File Operations](#file-operations)
2. [CAD / Drawing Tools](#cad--drawing-tools)
3. [CAD Edit Tools](#cad-edit-tools)
4. [Selection & Transform](#selection--transform)
5. [Snap & Grid](#snap--grid)
6. [CAM Operations](#cam-operations)
7. [Common Operation Parameters](#common-operation-parameters)
8. [Tool Library](#tool-library)
9. [Machine Profiles & Post Processors](#machine-profiles--post-processors)
10. [Stock Configuration](#stock-configuration)
11. [Text Engraving](#text-engraving)
12. [Inlay Operations (Tapered Pocket / Plug)](#inlay-operations-tapered-pocket--plug)
13. [V-Carve](#v-carve)
14. [Dogbone Fillets](#dogbone-fillets)
15. [G-Code Panel](#g-code-panel)
16. [Layer Management](#layer-management)
17. [Reference Image & Auto-Trace](#reference-image--auto-trace)
18. [Array & Offset Tools](#array--offset-tools)
19. [View & Display](#view--display)
20. [CAD Mode vs CAM Mode](#cad-mode-vs-cam-mode)
21. [Keyboard Shortcuts](#keyboard-shortcuts)
22. [Project Files & Persistence](#project-files--persistence)

---

## File Operations

| Action | Shortcut | Description |
|---|---|---|
| New Project | Ctrl+N | Create a blank project |
| Open Project | Ctrl+O | Load a saved `.dmdcam` or `.mcam` project file |
| Save Project | Ctrl+S | Save current project to disk |
| Save Project As | Ctrl+Shift+S | Save project to a new filename |
| Import DXF | Ctrl+I | Import 2D geometry from AutoCAD DXF (R12–2024); auto-detects units and preserves layers |
| Export DXF | Ctrl+Shift+D | Export all canvas entities back to DXF format with layer info preserved |
| Export G-code | Ctrl+E | Generate NC file(s) from current operations; single or multi-file with per-tool-change splitting |
| Import Reference Image | Toolbar | Load JPG/PNG/BMP/GIF/WEBP image as a tracing underlay on the canvas |

---

## CAD / Drawing Tools

All tools are in the **CAD Tools panel** (left sidebar, visible in CAD mode). Most tools also have a single-letter hotkey.

| Tool | Key | Icon | Description |
|---|---|---|---|
| Select | S | ▲ | Click to select entities; drag to box-select; drag selection to move; Ctrl+click to multi-select |
| Line | L | ╱ | Click start point, click end point; Shift constrains to 45° increments |
| Circle | C | ○ | Click center, then click or type radius; diameter input overlay appears at first point |
| Arc | A | ⌒ | Click start point, click a midpoint on the arc, click end point |
| Rectangle | R | □ | Click one corner, click opposite corner; Shift forces a square; W/H input overlay available |
| Polyline | P | ⌒╱ | Click to add vertices; **A** toggles arc segments (tangent mode by default), **L** returns to line segments, **3** toggles 3-point arc mode, **C** closes the path, **Enter** finishes |
| Polygon | ⬡ | ⬡ | Click center; set number of sides in the overlay (persists across draws); click to set radius |
| Mirror | ⇔ | ⇔ | Select entities first, then click two points to define the mirror axis; ghost preview shown while defining axis |

### Polyline Arc Sub-modes

When in polyline arc mode (`A`):

| Key | Mode | Behavior |
|---|---|---|
| *(default)* | Tangent arc | One click sets the endpoint; arc is automatically smooth and continuous with the previous segment |
| `3` | 3-point arc | Two clicks — first sets a midpoint on the arc, second sets the endpoint; reverts to tangent mode after committing |
| `L` | Return to lines | Switches back to straight line segments |

---

## CAD Edit Tools

| Tool | Key | Icon | Description |
|---|---|---|---|
| Trim | T | ✂ | Click any segment to trim it at its nearest intersecting edges (lines, arcs, circles, polylines) |
| Extend | E | →\| | Click near the end of a line or arc to extend it to the nearest boundary entity |
| Fillet | F | ╭ | Click two lines to round their shared corner; radius set in the persistent bottom-right overlay |
| Chamfer | H | ⌐ | Click two lines to cut their shared corner at 45°; distance set in the bottom-right overlay |
| Measure | *(panel)* | ⊢→ | Click two points to read distance with a label; click a third point to show the included angle with an arc indicator; resets after third click |

---

## Selection & Transform

| Feature | Where | Description |
|---|---|---|
| Select entity | Select tool / canvas click | Highlights entity; shows grip handles |
| Box select | Select tool / drag | Selects all entities whose bounding box falls inside the drag rectangle |
| Multi-select | Ctrl+click | Adds or removes a single entity from the current selection |
| Select All | Ctrl+A | Selects all visible entities |
| Select by Layer | Layers panel | Click a layer name to select all entities on that layer |
| Move (drag) | Select tool | Drag any selected entity or group to reposition |
| Grip editing | Select tool | Yellow square grips on endpoints, cyan diamond grips on midpoints/centers move individual vertices; arc midpoint grip reshapes radius while keeping endpoints fixed |
| Rotate handle | Selection bbox | Blue circle above the selection bounding box; drag to rotate the selection around its centroid |
| Scale handles | Selection bbox | Yellow squares at bounding box corners (visible when ≥2 entities selected); drag to scale uniformly |
| Context Menu — Cut | Right-click | Copy selected entities to clipboard and delete them |
| Context Menu — Copy | Right-click | Copy selected entities to clipboard |
| Context Menu — Copy with Base Point | Right-click | Copy entities; prompts for a base point before paste |
| Context Menu — Paste | Right-click | Paste clipboard entities at original position or relative to a base point |
| Context Menu — Move | Right-click | Two-click move: click base point, click destination |
| Context Menu — Scale… | Right-click | Typed scale dialog; applies uniform scale factor to selection |
| Context Menu — Rotate… | Right-click | Typed angle dialog; rotates selection around its centroid |
| Context Menu — Erase | Right-click | Delete selected entities |
| Delete | Del | Delete currently selected entities |
| Undo | Ctrl+Z | Undo last entity edit (up to 50 snapshots) |
| Redo | Ctrl+Y | Redo last undone entity edit |
| Coordinate input | Space (while drawing) | Opens X/Y dialog to enter an exact point position; Tab switches fields |

---

## Snap & Grid

| Feature | Where | Description |
|---|---|---|
| Endpoint snap | Automatic | Snaps cursor to line/arc/polyline endpoints |
| Midpoint snap | Automatic | Snaps to segment midpoints |
| Center snap | Automatic | Snaps to circle/arc centers |
| Intersection snap | Automatic | Snaps to line-line intersections |
| Grid Snap | CAD Tools panel button | 10 mm snap grid; toggle on/off with the **⊞ Grid Snap** button |
| Snap indicator | Canvas | Visual indicator (colored dot) shows which snap type is active at the cursor |

---

## CAM Operations

Operations are created in the **Operations panel** (CAM mode, right sidebar). Each operation has a dedicated parameters section.

### 2D Contour

Profile cut following a closed or open curve.

- **Cut side:** Outside / Inside / Center-line  
- **Stock to leave:** Radial allowance for finish passes  
- **Lead-in:** Plunge, Ramp (configurable angle), or Tangential Arc  
- **Tabs:** Auto or manual placement; tab profiles: Flat, DMD Curve, or Triangle; configurable width/height  
- **Finish pass:** Optional second pass with separate stock allowance and feed rate  
- **Depth per pass / number of passes**

### 2D Pocket

Clear an enclosed area.

- **Cut side:** Inside or Outside  
- **Stepover %**  
- **Start from center** toggle  
- **Rest machining:** Leave areas for a smaller tool; set previous tool diameter  
- **Lead-in:** Plunge, Ramp, or Helical  
- **Finish pass** with separate allowance  
- **Boundary clipping:** Confine cuts to selected entities rather than the full stock outline

### 2D Adaptive

High-efficiency trochoidal pocket clearing.

- **Stepover %**  
- **Optimal load %** (arc engagement limit)  
- **Rest machining**  
- **Lead-in:** Plunge, Ramp, or Helical  
- **Cut side:** Inside / Outside

### Face

Surfacing passes across stock.

- **Stepover %**  
- **Facing angle**  
- **Stock margins:** X+, X−, Y+, Y− overhang beyond stock  
- **Lead-in:** Plunge or Ramp  
- **Progressive depth passes**

### Drill

Point drilling with optional peck cycle.

- **Peck depth** (0 = full-depth single plunge)  
- **Chip break / dwell** option  
- **Spindle RPM, feed rate, plunge rate**

### Bore

Helical boring interpolation for precise circular pockets.

- **Helical pitch**  
- **Direction:** Climb or Conventional  
- **Tool diameter**

### Circular

Concentric circular passes from center outward.

- **Stepover %**  
- **Helical entry** option  
- **Rest machining**  
- **Direction:** Climb / Conventional

### Engrave

Single-pass vector engraving along entity shapes.

- Fixed depth cut; follows open or closed curves exactly  
- **Depth, Top Z, Safe Z, Feed, Plunge**

### Trace

Open-curve tracing (similar to Engrave; optimized for open paths).

### Slot

Slot routing with ramp entry.

- **Ramp angle**  
- **Direction:** Climb / Conventional  
- **Progressive depth passes**

### 2D Chamfer

Chamfer-mill along a profile edge.

- **Cut side:** Outside edge / Inside edge  
- **Chamfer angle** and **width**  
- **Tool diameter, Top Z, Safe Z**

### Thread Mill

Helical thread milling.

- **Pitch**  
- **Direction:** Right-hand / Left-hand  
- **Type:** Internal / External  
- **Spindle RPM**

---

## Common Operation Parameters

These appear on nearly every operation:

| Parameter | Description |
|---|---|
| Entity assignment | "Assign Selected" button links the current canvas selection to the operation |
| Tool selection | Pick from library (shows name + diameter) or enter diameter manually |
| Spindle RPM | Spindle speed |
| Feed rate | XY cutting speed |
| Plunge rate | Z descent speed |
| Total depth | Full cutting depth |
| Depth per pass | Step-down per cutting pass; or set number of passes to auto-calculate |
| Top of stock (Z) | Z reference height of the stock surface |
| Safe Z | Rapid-travel clearance height |
| Direction | Climb vs Conventional milling direction |
| Lead-in style | Plunge / Ramp (+ angle) / Helical / Tangential Arc |

---

## Tool Library

Located in the **Tools tab** of the right sidebar (CAM mode).

| Feature | Description |
|---|---|
| Tool list | All saved tools shown with name, type icon, and diameter |
| Add tool (+) | Create a new tool entry |
| Tool types | Flat, Ball, Tapered, Upcut, Downcut, Compression, Diamond, V-bit |
| Tool number | 1–99 machine slot number; duplicate numbers flagged with a warning |
| Diameter | With mm/inch unit toggle |
| Tip diameter | For tapered/V-bit tools |
| Taper angle | For tapered/V-bit tools |
| Flutes | Number of flutes |
| Material | Carbide, HSS, Cobalt, Ceramic, Diamond PCD |
| Notes | Free-text notes field |
| Feeds & Speeds profiles | Per-material RPM, feed, plunge, depth-per-pass, stepover — add rows for: MDF, Plywood, Softwood, Hardwood, Aluminum, HDPE, Acrylic, Foam, Brass, Steel, Copper |
| Save / Delete | Persist changes or remove the tool |
| Import from Fusion 360 | Import `.json` tool library from Fusion 360; auto-maps types and materials |
| Import from VCarve | Import `.vtdb` tool database from VCarve Pro |

---

## Machine Profiles & Post Processors

Accessed via the **Machine Setup** button (top toolbar, CAM mode) or **Ctrl+Shift+M**.

### Machine Profiles

| Feature | Description |
|---|---|
| Profile list | Named profiles with post-processor type badge; active profile highlighted |
| Add / Delete profile | Create new profiles; delete with confirmation |
| Active profile | One profile active at a time (single-instance lock) |

### Hardware Configuration

| Setting | Description |
|---|---|
| X/Y/Z travel | Machine working envelope in mm |
| Max spindle RPM | Upper spindle speed limit |
| Min spindle RPM | Lower spindle speed limit |
| Max feed rate (XY) | Maximum XY rapid/feed speed |
| Max feed rate (Z) | Maximum Z rapid/feed speed |
| Machine home position | X/Y/Z home coordinates |

### Post Processor Settings (Masso G3)

| Setting | Description |
|---|---|
| Output units | mm or inch; auto-converts all parameter values |
| Coolant | Off, Flood (M8), or Mist (M7) |
| Spindle ramp-up delay | Seconds to dwell after M3 before starting the cut |
| Safe Z | Rapid clearance height |
| Tool change Z | Height to raise before M6 tool change |
| Line numbering | Toggle N-code line numbers; set increment |
| Home at end | Emit G28 return-to-home at program end |
| Program header | Freeform G-code prepended to every file |
| Program footer | Freeform G-code appended to every file |
| Tool number mapping | Table mapping library tool IDs to machine tool slot numbers for M6 codes |

---

## Stock Configuration

Located in the **Stock panel** (CAM mode, right sidebar).

| Feature | Description |
|---|---|
| Width / Length / Thickness | Stock dimensions with mm/inch toggle |
| Z reference | Work-zero height; preset buttons: Stock Top / Stock Bottom |
| Datum selector | 3×3 grid (TL/TC/TR, ML/MC/MR, BL/BC/BR) sets which corner/edge/center is the machine origin |
| Stock bounds display | Shows computed stock min/max X, Y, Z in world coordinates |
| WCS selector | G54–G59 work coordinate system dropdown |
| Fit Stock to Part | Sizes stock to geometry bounds + 10 % margin and centers geometry |
| Move to Origin | Shifts all entities so the selected datum lands at (0, 0) |

---

## Text Engraving

Text operations are created in the **Operations panel** (CAM mode) via **Add Operation → Text**.

| Feature | Description |
|---|---|
| Text content | Multiline text input |
| Font selection | System font picker (dynamically loads installed fonts) |
| Cap height | Font size (controls height of capital letters in mm) |
| Output mode — Engraved | V-bit trace follows the skeleton of each letter |
| Output mode — Outlined | Contour cut around the outer profile of each letter |
| Output mode — Filled | Pocket operation with configurable stepover fills each letter |
| Place on canvas | Click **Place** button then click the canvas to position the text |
| Generate Geometry | Converts font outlines to CAD entities (lines, arcs) on the canvas |
| Common CAM params | Depth, Top Z, Safe Z, Feed, Plunge, Tool selection |

---

## Inlay Operations (Tapered Pocket / Plug)

Two linked operation types for producing fitted wood inlays.

### Tapered Pocket

| Feature | Description |
|---|---|
| Pass 1 — Taper contour | V-bit tracing of the inlay boundary |
| Pass 2 — Taper cleanup | V-bit cleanup of corners and residual material |
| Pass 3 — Detail endmill | Small-endmill finishing of the floor |
| Pass 4 — Bulk endmill | Large-endmill bulk clearance |
| Per-pass controls | Enable/disable, tool selection, RPM, feed, plunge, wall stock |
| Mirror X | Flips the pocket geometry horizontally (for book-matched inlays) |
| Corner relief angle | V-bit corner relief cut angle |
| Link to plug | Associates this pocket with its matching plug operation |

### Tapered Plug

| Feature | Description |
|---|---|
| Same 4-pass structure as pocket | Taper contour, taper cleanup, detail endmill, bulk endmill |
| Fit tolerance | Distance value controlling Z-raise to achieve tight / ideal / loose fit |
| Engagement depth preview | Visual indicator (tight/ideal/loose) based on current tolerance |
| Link to pocket | Associates this plug with its matching pocket operation |

### Inlay Wizard

A 5-step guided workflow (**Machine → Inlay Wizard** or Ctrl+Shift+W) that creates a matched pocket+plug pair with all parameters pre-configured.

---

## V-Carve

Variable-depth V-bit carving for text and artistic shapes.

| Feature | Description |
|---|---|
| V-bit half angle | Half-angle of the cutter (e.g. 15° for a 30° bit) |
| Tip diameter | Flat-bottom tip diameter (0 for a true pointed V-bit) |
| Max depth | Maximum carving depth limit |
| Flat depth | Minimum cut depth at wide edges (prevents zero-depth passes) |
| Medial axis preview | Toggle magenta skeleton overlay on canvas showing the computed centerline skeleton |
| Calculate button | Run medial axis computation and show skeleton before generating toolpath |

---

## Dogbone Fillets

Drills internal corners so square-edged parts fit flush in pockets.

| Feature | Description |
|---|---|
| Auto mode | Automatically finds all sharp internal corners in selected geometry |
| Manual mode | Click individual corners on the canvas to select which ones get dogbones |
| Corner selection display | Highlights selected corners on canvas |
| Tool diameter | Sets the drill/endmill diameter (determines dogbone hole size) |
| Depth parameters | Depth, Top Z, Safe Z |
| Feeds & speeds | Spindle RPM, feed rate, plunge rate |

---

## G-Code Panel

Located in the **G-Code tab** of the right sidebar (CAM mode).

| Feature | Description |
|---|---|
| Syntax-highlighted preview | Color-coded display: comments (green), G0 rapids (red), G1 feeds (green), G2/G3 arcs (cyan), M-codes (yellow), N-codes (gray) |
| Cycle time estimate | Computed from move distances and feed rates; displayed as HH:MM:SS |
| Move count | Total number of G-code moves |
| Line count | Total number of output lines |
| Generate button | Recalculates G-code from all enabled operations |
| Export — Single file | Save as `.nc` / `.gcode` / `.tap` / `.cnc` |
| Export — Multi-file | Prompts for a base name then writes one file per tool change (suffixed `_T1`, `_T2`, etc.) |
| Export — Inlay files | Generates separate `_pocket` and `_plug` files when inlay operations are present |
| Post processor settings | Inline controls for units, coolant, spindle delay, Safe Z, tool-change Z, line numbers, home-at-end |

---

## Layer Management

Located in the **Layers panel** (left sidebar, CAD mode).

| Feature | Description |
|---|---|
| Layer list | All DXF layers with name, color swatch, and entity count |
| Visibility toggle | Eye icon shows/hides each layer on the canvas |
| Select by layer | Click a layer name to select all entities on that layer |

---

## Reference Image & Auto-Trace

Available in the **top toolbar** in CAD mode when an image is loaded.

| Feature | Description |
|---|---|
| Import Reference Image | Loads a raster image (JPG/PNG/BMP/GIF/WEBP) as a semi-transparent underlay; auto-scales to ~200 mm wide |
| Opacity slider | 5–80 % opacity for the image underlay |
| Scale slider | 1–200 % scale relative to the imported size |
| Clear image | Removes the reference image |
| Auto-Trace | Edge-detection processing that converts the image to polyline entities (lines and arcs) on the canvas; reports outline and vertex counts |

---

## Array & Offset Tools

Accessed from the **top toolbar** in CAD mode (require an active selection).

### Array (Offset button → Array dialog)

| Tab | Feature | Description |
|---|---|---|
| Rectangular | Columns / Rows | Number of instances in each direction |
| Rectangular | X / Y spacing | Distance between instances (mm or inch) |
| Circular | Count | Total copies (including original) |
| Circular | Center X / Y | Auto-calculated from selection bounds; editable |
| Circular | Start angle | Angular offset of first copy |

### Offset

| Option | Description |
|---|---|
| Distance | Offset distance with unit conversion |
| Expand | Offsets outward (positive) |
| Shrink | Offsets inward (negative) |
| Both sides | Creates both +/− offsets simultaneously |

---

## View & Display

| Feature | Where | Description |
|---|---|---|
| Zoom In | Ctrl+Plus / scroll wheel | Zoom into the canvas |
| Zoom Out | Ctrl+Minus / scroll wheel | Zoom out of the canvas |
| Zoom to Fit | Ctrl+Shift+H | Frame all geometry and stock in the viewport |
| Pan | Middle-click drag / Alt+drag | Pan the viewport |
| Show Toolpaths | Top toolbar toggle | Show/hide calculated toolpath lines on canvas |
| Show Rapids | Top toolbar toggle | Show/hide rapid (air) moves |
| Toolpath colors | Canvas | Cutting moves = green, rapids = red/dashed, plunges = orange |
| Z-level filter slider | CAM mode canvas | Scrub through depth passes to visualize individual Z levels |
| Medial axis overlay | V-Carve operation | Magenta skeleton shown when **Show Medial Axis** is toggled in the operation |
| Stock rectangle | Canvas | Semi-transparent stock boundary always shown in CAM mode |
| Origin crosshair | Canvas | Red (X) and green (Y) crosshair at the datum origin |
| Entity colors | Canvas | Default blue, selected yellow, hovered light-blue |

---

## CAD Mode vs CAM Mode

Toggle between modes using the **✏ CAD / ⚙ CAM** button (top left of the toolbar).

| Mode | Available Features |
|---|---|
| **CAD mode** | Drawing tools, edit tools, measure, mirror, array, offset, layers, reference image, entity properties panel, entity grips, snap |
| **CAM mode** | Operations panel, tool library, stock config, G-code panel, toolpath visualization, Z-level slider |

---

## Keyboard Shortcuts

### File & Project

| Shortcut | Action |
|---|---|
| Ctrl+N | New Project |
| Ctrl+O | Open Project |
| Ctrl+S | Save Project |
| Ctrl+Shift+S | Save Project As |
| Ctrl+I | Import DXF |
| Ctrl+Shift+D | Export DXF |
| Ctrl+E | Export G-code |

### Edit

| Shortcut | Action |
|---|---|
| Ctrl+Z | Undo |
| Ctrl+Y | Redo |
| Ctrl+A | Select All |
| Delete | Delete selected entities |

### View

| Shortcut | Action |
|---|---|
| Ctrl+Shift+H | Zoom to Fit |
| Ctrl++ | Zoom In |
| Ctrl+− | Zoom Out |

### Machine

| Shortcut | Action |
|---|---|
| Ctrl+Shift+W | Open Inlay Wizard |

### Drawing (canvas, CAD mode)

| Key | Action |
|---|---|
| S | Select tool |
| L | Line tool |
| C | Circle tool |
| A | Arc tool (or arc segment in polyline) |
| R | Rectangle tool |
| P | Polyline tool |
| M | Mirror tool |
| T | Trim tool |
| E | Extend tool |
| F | Fillet tool |
| H | Chamfer tool |
| O | Open Offset dialog (selection required) |
| Space | Open coordinate input dialog (while drawing) |
| Escape | Cancel current draw operation / close dialog |

### Polyline-specific

| Key | Action |
|---|---|
| A | Toggle arc segments (enters tangent arc mode) |
| L | Return to straight line segments |
| 3 | Toggle 3-point arc mode (while in arc mode) |
| C | Close the polyline path |
| Enter | Finish and commit the polyline |

---

## Project Files & Persistence

| Item | Storage | Contents |
|---|---|---|
| Project file (`.dmdcam`) | User-selected path | Entities, layers, operations, stock config, machine config, post config, geometry bounds |
| Tool library | Electron store (global) | All saved tools with feeds/speeds profiles; default tools pre-populated |
| Machine profiles | Electron store (global) | All machine profiles and post processor settings; one profile active at a time |

### DXF Import Capabilities

- Auto-detects drawing units (unitless, mm, inch) and converts to app units
- Preserves layer names and colors
- Supported entity types: Line, Circle, Arc, Polyline (LWPolyline and Polyline), Spline (approximated)

### G-code Export Formats

| Format | Extension |
|---|---|
| Masso G3 NC | `.nc` |
| Generic G-code | `.gcode` |
| Tormach | `.tap` |
| Generic CNC | `.cnc` |

---

*DMDCAM is developed by Mike Parnell. Built with Electron and React.*
