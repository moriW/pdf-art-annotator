import { describe, it, expect, beforeEach } from "vitest";
import { AnnotationStore } from "../src/storage";
import type { PDFAnnotationData } from "../src/types";

// ── In-memory adapter — mirrors Obsidian's vault.adapter API ──

class MemAdapter {
  private files = new Map<string, string>();

  private norm(p: string): string {
    return p.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(this.norm(path));
  }
  async read(path: string): Promise<string> {
    const content = this.files.get(this.norm(path));
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }
  async write(path: string, contents: string): Promise<void> {
    this.files.set(this.norm(path), contents);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(this.norm(path));
  }
  async mkdir(_path: string): Promise<void> { /* no-op */ }

  dumpFiles(): string[] {
    return Array.from(this.files.keys()).sort();
  }
}

// Store only touches vault.adapter now — a plain object is enough
function makeVault(adapter: MemAdapter) {
  return { adapter } as any;
}

// ── Helpers ──

function makeSampleData(source: string): PDFAnnotationData {
  return { source, pages: [], version: 5 };
}

// ── Tests ──

describe("AnnotationStore", () => {
  let adapter: MemAdapter;
  let store: AnnotationStore;

  beforeEach(() => {
    adapter = new MemAdapter();
    store = new AnnotationStore(makeVault(adapter));
  });

  describe("load", () => {
    it("returns null when no annotation file exists", async () => {
      expect(await store.load("art/photo.pdf")).toBeNull();
    });

    it("loads existing annotation data", async () => {
      const source = "art/photo.pdf";
      await store.save({ source, pages: [{ page: 1, strokes: [], texts: [], guides: [] }], version: 5 });
      const loaded = await store.load(source);
      expect(loaded).not.toBeNull();
      expect(loaded!.source).toBe(source);
      expect(loaded!.pages[0].page).toBe(1);
      expect(loaded!.pages[0].strokes).toEqual([]);
      expect(loaded!.pages[0].texts).toEqual([]);
      expect(loaded!.pages[0].guides).toEqual([]);
    });

    it("migrates from legacy companion file path", async () => {
      const source = "art/photo.pdf";
      await adapter.write("art/photo.annotations.json", JSON.stringify(makeSampleData(source)));

      const data = await store.load(source);
      expect(data).not.toBeNull();
      expect(data!.source).toBe(source);
      expect(await adapter.exists("art/photo.annotations.json")).toBe(false);
    });

    it("throws on invalid JSON", async () => {
      const source = "broken.pdf";
      await store.save(makeSampleData(source));
      const annoFile = adapter.dumpFiles().find((f) => f.endsWith(".annotations.json"))!;
      await adapter.write(annoFile, "not json {{{");
      await expect(store.load(source)).rejects.toThrow(/Invalid PDF Art annotation JSON/);
    });
  });

  describe("save", () => {
    it("persists annotation data", async () => {
      const source = "art/sketch.pdf";
      await store.save(makeSampleData(source));
      expect(await store.load(source)).not.toBeNull();
    });

    it("overwrites existing data", async () => {
      const source = "art/sketch.pdf";
      await store.save(makeSampleData(source));
      await store.save({ source, pages: [{ page: 3, strokes: [], texts: [], guides: [] }], version: 5 });
      const loaded = await store.load(source);
      expect(loaded!.version).toBe(5);
      expect(loaded!.pages[0].page).toBe(3);
    });

    it("creates annotation folder on first save", async () => {
      const source = "deep/nested/doc.pdf";
      await store.save(makeSampleData(source));
      const files = adapter.dumpFiles().filter((f) => f.endsWith(".annotations.json"));
      expect(files).toHaveLength(1);
      expect(files[0]).toContain("PDF Art Annotations/");
    });
  });

  describe("delete", () => {
    it("removes annotation file", async () => {
      const source = "art/photo.pdf";
      await store.save(makeSampleData(source));
      expect(await store.load(source)).not.toBeNull();
      await store.delete(source);
      expect(await store.load(source)).toBeNull();
    });
  });

  describe("upsertPageAnnotations", () => {
    it("adds and updates pages", async () => {
      const source = "doc.pdf";
      await store.upsertPageAnnotations(source, { page: 5, strokes: [], texts: [], guides: [] });
      let data = await store.load(source);
      expect(data!.pages).toHaveLength(1);

      await store.upsertPageAnnotations(source, {
        page: 5,
        texts: [],
        guides: [],
        strokes: [{
          id: "s1",
          type: "pen",
          points: [{ x: 0.1, y: 0.2, pressure: 0.5 }],
          color: "#fff",
          width: 3,
          opacity: 1,
        }],
      });
      data = await store.load(source);
      expect(data!.pages[0].strokes).toHaveLength(1);
    });
  });

  describe("addStroke", () => {
    it("appends a stroke, creating page if needed", async () => {
      const source = "doc.pdf";
      await store.addStroke(source, 1, {
        id: "s1",
        type: "pen",
        points: [{ x: 0, y: 0, pressure: 0.5 }],
        color: "#f00",
        width: 3,
        opacity: 1,
      });
      const page = await store.getPageAnnotations(source, 1);
      expect(page!.strokes).toHaveLength(1);

      expect(await store.getPageAnnotations(source, 99)).toBeNull();
      await store.addStroke(source, 99, {
        id: "s2",
        type: "highlighter",
        points: [{ x: 0.2, y: 0.3, pressure: 0.5 }],
        color: "#ff0",
        width: 12,
        opacity: 0.35,
      });
      expect(await store.getPageAnnotations(source, 99)).not.toBeNull();
    });
  });

  describe("legacy data migration", () => {
    it("keeps old pen/highlighter items as strokes", async () => {
      const source = "legacy.pdf";
      await adapter.write("legacy.annotations.json", JSON.stringify({
        source,
        version: 1,
        pages: [{
          page: 2,
          items: [
            { type: "pen", points: [{ x: 0.1, y: 0.2, pressure: 0.5 }], color: "#f00", width: 3, opacity: 1 },
            { type: "text", x: 0.5, y: 0.5, text: "old", color: "#fff", fontSize: 16, width: 0.28 },
          ],
          guides: [
            { _id: "g1", type: "grid-12", visible: true, rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, rotation: 1, mirrorX: true },
          ],
        }],
      }));

      const loaded = await store.load(source);
      expect(loaded!.version).toBe(5);
      expect(loaded!.pages[0].strokes).toHaveLength(1);
      expect(loaded!.pages[0].strokes[0].type).toBe("pen");
      expect(loaded!.pages[0].texts).toHaveLength(1);
      expect(loaded!.pages[0].texts[0].text).toBe("old");
      expect(loaded!.pages[0].guides).toHaveLength(1);
      expect(loaded!.pages[0].guides[0].type).toBe("grid-16");
      expect(loaded!.pages[0].guides[0].rotation).toBeCloseTo(Math.PI / 2);
      expect(loaded!.pages[0].guides[0].mirrorX).toBe(true);
    });
  });

  describe("file naming", () => {
    it("uses PDF base name + 12-char hex hash", async () => {
      await store.save(makeSampleData("art/gallery.pdf"));
      const f = adapter.dumpFiles().find((x) => x.endsWith(".annotations.json"))!;
      expect(f).toContain("gallery");
      expect(f).toMatch(/-[0-9a-f]{12}\.annotations\.json$/);
    });

    it("reuses same file for same PDF path", async () => {
      await store.save(makeSampleData("deep/nested/doc.pdf"));
      const f1 = adapter.dumpFiles().filter((x) => x.endsWith(".annotations.json"));
      await store.save(makeSampleData("deep/nested/doc.pdf"));
      const f2 = adapter.dumpFiles().filter((x) => x.endsWith(".annotations.json"));
      expect(f2).toEqual(f1);
    });
  });

  describe("JSON BOM handling", () => {
    it("loads JSON with BOM prefix", async () => {
      const source = "bom.pdf";
      await store.save(makeSampleData(source));
      const annoFile = adapter.dumpFiles().find((f) => f.endsWith(".annotations.json"))!;
      await adapter.write(annoFile, "\uFEFF" + JSON.stringify(makeSampleData(source)));

      const loaded = await store.load(source);
      expect(loaded).not.toBeNull();
      expect(loaded!.source).toBe(source);
    });
  });
});
