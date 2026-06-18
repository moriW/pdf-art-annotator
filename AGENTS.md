# PDF Art Annotator — Obsidian Plugin

An Obsidian plugin that adds a drawing/annotation overlay to the native PDF viewer. Supports freehand pen/highlighter strokes, composition guides (grid-9, grid-12, golden spiral, golden ratio, diagonals), and movable paragraph text.

## Project

- **Stack:** TypeScript 5.6 + esbuild 0.24, targeting ES2022
- **Entry:** `src/main.ts` → bundled to `main.js` (CJS)
- **Obsidian API:** `obsidian` v1.7+, `minAppVersion: 0.15.0`

## Commands

| Purpose       | Command              |
|---------------|----------------------|
| Dev build     | `npm run dev`        |
| Prod build    | `npm run build`      |
| Run tests     | `npm run test`       |

Both build commands run `node build.js`; the prod flag adds no sourcemap. Output is `main.js`. Tests use `vitest`.

## Architecture

```
src/
├── main.ts           Plugin entry, settings tab, ribbon/commands/events
├── commands.ts       Obsidian command palette actions for tool selection and page actions
├── tool-view.ts      Obsidian ItemView tool panel for PDF Art controls
├── types.ts           Data types (PenStroke, TextAnnotation, GuideState, PDFArtSettings) and defaults
├── storage.ts         AnnotationStore — JSON persistence with adapter-only writes, legacy path migration
├── guides.ts          Canvas2D composition guide renderer (5 guide types)
├── native-overlay.ts  NativePDFArtOverlayManager — leaf scheduling (~65 lines)
├── leaf-state.ts      NativePDFArtLeafState — per-PDF state, data ops, page sync
├── page-overlay.ts    NativePageOverlay — page canvas lifecycle, pointer event dispatch, gesture guard
└── tools/
    ├── stroke-tool.ts  Pen/highlighter stroke creation and rendering
    ├── eraser-tool.ts  Eraser path interpolation
    ├── text-tool.ts    Text rendering, hit testing, and editor popup
    └── guide-tool.ts   Guide rendering, controls, hit testing, and drag geometry
tests/
└── storage.test.ts    Unit tests for AnnotationStore (13 tests, vitest)
```

- **`PDFArtAnnotatorPlugin`** (main.ts) — wires lifecycle: loads settings, creates `AnnotationStore` and `NativePDFArtOverlayManager`, registers ribbon icon / file-menu / auto-open / commands / settings tab.
- **`PDFArtToolView`** (tool-view.ts) — Obsidian `ItemView` shown in the right sidebar; owns the main tool UI instead of a page-level floating toolbar.
- **`commands.ts`** — command palette actions for opening the tool view, toggling annotation mode, choosing tools/guides, and clearing the current page.
- **`AnnotationStore`** (storage.ts) — vault-level `PDF Art Annotations/` folder of JSON files. Uses adapter-only reads/writes and migrates from legacy companion-file locations.
- **`NativePDFArtOverlayManager`** (native-overlay.ts) — tracks `WorkspaceLeaf`→`NativePDFArtLeafState`; syncs on active-leaf / layout changes.
- **`NativePDFArtLeafState`** (leaf-state.ts) — per-PDF state: tool selection, annotation mutations, mutation/intersection observers for page rendering. Owns per-page `NativePageOverlay` instances.
- **`NativePageOverlay`** (page-overlay.ts) — per-page Canvas overlay lifecycle and pointer dispatch. Tool-specific drawing, hit testing, and geometry live under `src/tools/`.
- **`guides.ts`** — pure guide geometry renderer: `grid-9`, `grid-12`, `golden-spiral`, `golden-ratio`, `diagonals`; all guide types render through shared primitives.
- **`storage.ts`** — Uses Obsidian's `vault.adapter` directly to avoid high-frequency vault events for sync plugins. FNV-1a hash for filename disambiguation. Legacy companion-file migration on load.

## Conventions

- **Language:** UI text is Chinese; code identifiers in English.
- **Style:** strict TypeScript; `noUnusedLocals`/`noUnusedParameters` off.
- **Pattern:** Plugin extends `Plugin`, stores data in vault via `vault.adapter`, uses `registerEvent`/`addCommand`/`addRibbonIcon` Obsidian idioms.
- **DOM overlay:** Direct DOM injection into Obsidian's native PDF viewer (`".pdfViewer .page[data-page-number]"`), not an iframe or custom view.
- **Coordinates:** Normalized 0–1 for annotations (multiplied by pixel dimensions at render time). Guide rects are also normalized.
- **Storage:** This plugin intentionally uses `vault.adapter` for annotation JSON to avoid high-frequency vault events during drawing and reduce sync-plugin churn.

## Notes

- The project structure is flat: all source under `src/`, output at repo root (`main.js`). The `manifest.json` and `styles.css` are also at root for Obsidian to discover.
