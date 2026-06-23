# PDF Art Annotator

PDF Art Annotator is an Obsidian community plugin that adds a lightweight annotation overlay to Obsidian's native PDF viewer.

It supports pen and highlighter strokes, erasing, text boxes, selection-based editing, and composition guide overlays. Annotation data is stored inside the vault under `PDF Art Annotations/`.

## Features

- Draw directly on native PDF pages with pen or highlighter tools.
- Erase strokes on the current PDF page.
- Add movable text boxes on top of PDF pages.
- Select annotations with a full-containment selection box, then adjust appearance or delete them.
- Add draggable composition guides, including 9-grid, 16-grid, golden ratio, and golden spiral guides.
- Toggle the overlay from the ribbon, command palette, or PDF file context menu.
- Store annotations as JSON files with adapter-only writes to reduce high-frequency vault events while drawing.

## Development

Install dependencies:

```bash
npm ci
```

Run a development build with an inline sourcemap:

```bash
npm run dev
```

Run a production build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

## Manual Install

Copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<Vault>/.obsidian/plugins/pdf-art-annotator/
```

Reload Obsidian and enable **PDF Art Annotator** in **Settings -> Community plugins**.
