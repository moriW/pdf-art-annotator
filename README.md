# PDF Art Annotator

PDF Art Annotator is an Obsidian community plugin that adds a drawing and annotation overlay to Obsidian's native PDF viewer.

It supports freehand pen strokes, highlighter strokes, composition guides, and movable paragraph text annotations. Annotation data is stored inside the vault under `PDF Art Annotations/`.

## Features

- Draw directly on native PDF pages with pen or highlighter tools.
- Add composition guides including rule of thirds, 12-grid, golden spiral, golden ratio, and diagonals.
- Place and move paragraph text annotations.
- Toggle the overlay from the ribbon, command palette, or PDF file context menu.
- Store annotations as JSON files using Obsidian vault APIs.

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
