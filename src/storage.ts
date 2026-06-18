import { normalizePath, Vault } from "obsidian";
import { PDFAnnotationData, PageAnnotations, AnnotationItem } from "./types";

const ANNOTATION_ROOT = "PDF Art Annotations";
const HASH_LENGTH = 12;

/**
 * Annotation storage — plugin-internal data persisted through vault.adapter.
 *
 * ALL I/O bypasses Obsidian's vault event system (vault.create / vault.process
 * / vault.read) to avoid triggering sync plugins like FastNoteSync.  Annotation
 * JSON files are operational data that change at high frequency during drawing;
 * syncing them as binary attachments causes chunked-upload session races and
 * "Record Not Found" errors.
 *
 * - vault.adapter.write() overwrites in-place — never a file-missing window
 * - vault.adapter.read() / exists() / remove() / mkdir() are event-agnostic
 * - file naming: PDF Art Annotations/{basename}-{hash}.annotations.json
 */
export class AnnotationStore {
  constructor(private vault: Vault) {}

  private annotationPath(pdfPath: string): string {
    const normalizedPdfPath = normalizePath(pdfPath).replace(/^\/+/, "");
    const baseName = this.pdfBaseName(normalizedPdfPath);
    const hash = this.sourcePathHash(normalizedPdfPath);
    return normalizePath(`${ANNOTATION_ROOT}/${baseName}-${hash}.annotations.json`);
  }

  private mirroredAnnotationPath(pdfPath: string): string {
    const p = normalizePath(pdfPath).replace(/^\/+/, "");
    return normalizePath(`${ANNOTATION_ROOT}/${p}.annotations.json`);
  }

  private hiddenCompanionAnnotationPath(pdfPath: string): string {
    const p = normalizePath(pdfPath).replace(/^\/+/, "");
    const slash = p.lastIndexOf("/");
    const dir = slash >= 0 ? `${p.slice(0, slash + 1)}` : "";
    const name = slash >= 0 ? p.slice(slash + 1) : p;
    return `${dir}.${name.replace(/\.pdf$/i, "")}.annotations.json`;
  }

  private visibleCompanionAnnotationPath(pdfPath: string): string {
    const p = normalizePath(pdfPath).replace(/^\/+/, "");
    return p.replace(/\.pdf$/i, ".annotations.json");
  }

  private legacyAnnotationPaths(pdfPath: string): string[] {
    return Array.from(new Set([
      this.mirroredAnnotationPath(pdfPath),
      this.hiddenCompanionAnnotationPath(pdfPath),
      this.visibleCompanionAnnotationPath(pdfPath),
    ]));
  }

  private pdfBaseName(pdfPath: string): string {
    const slash = pdfPath.lastIndexOf("/");
    const name = slash >= 0 ? pdfPath.slice(slash + 1) : pdfPath;
    return name.replace(/\.pdf$/i, "") || "pdf";
  }

  private sourcePathHash(pdfPath: string): string {
    return fnv1aHex(pdfPath).slice(0, HASH_LENGTH);
  }

  // ── Public API ──

  async load(pdfPath: string): Promise<PDFAnnotationData | null> {
    const path = this.annotationPath(pdfPath);
    if (await this.vault.adapter.exists(path)) {
      const raw = await this.vault.adapter.read(path);
      return this.parseAnnotationData(raw, path);
    }

    // Legacy migration: check old companion-file paths
    for (const legacyPath of this.legacyAnnotationPaths(pdfPath)) {
      if (await this.vault.adapter.exists(legacyPath)) {
        const raw = await this.vault.adapter.read(legacyPath);
        const data = this.parseAnnotationData(raw, legacyPath);
        // Migrate to canonical path (adapter-only, no vault event)
        await this.ensureParentFolder(path);
        await this.vault.adapter.write(path, JSON.stringify(data, null, 2));
        // Clean up old locations
        await this.removeIfExists(legacyPath);
        for (const other of this.legacyAnnotationPaths(pdfPath)) {
          if (other !== legacyPath) await this.removeIfExists(other);
        }
        return data;
      }
    }

    return null;
  }

  async save(data: PDFAnnotationData): Promise<void> {
    const path = this.annotationPath(data.source);
    const json = JSON.stringify(data, null, 2);
    await this.ensureParentFolder(path);
    // adapter.write() overwrites in-place, no file-missing window, no
    // Obsidian vault event — sync plugins never see this file change.
    await this.vault.adapter.write(path, json);
  }

  async delete(pdfPath: string): Promise<void> {
    const path = this.annotationPath(pdfPath);
    await this.removeIfExists(path);
  }

  async getPageAnnotations(pdfPath: string, pageNum: number): Promise<PageAnnotations | null> {
    const data = await this.load(pdfPath);
    if (!data) return null;
    return data.pages.find((p) => p.page === pageNum) ?? null;
  }

  async upsertPageAnnotations(pdfPath: string, annotations: PageAnnotations): Promise<void> {
    let data = await this.load(pdfPath);
    if (!data) data = { source: pdfPath, pages: [], version: 1 };
    const idx = data.pages.findIndex((p) => p.page === annotations.page);
    if (idx >= 0) data.pages[idx] = annotations;
    else data.pages.push(annotations);
    await this.save(data);
  }

  async addItem(pdfPath: string, pageNum: number, item: AnnotationItem): Promise<void> {
    let data = await this.load(pdfPath);
    if (!data) data = { source: pdfPath, pages: [], version: 1 };
    let page = data.pages.find((p) => p.page === pageNum);
    if (!page) {
      page = { page: pageNum, items: [], guides: [] };
      data.pages.push(page);
    }
    page.items.push(item);
    await this.save(data);
  }

  // ── Private helpers ──

  private parseAnnotationData(raw: string, path: string): PDFAnnotationData {
    try {
      return normalizeLegacyGuideTypes(JSON.parse(stripJsonBom(raw)) as PDFAnnotationData);
    } catch (error) {
      throw new Error(`Invalid PDF Art annotation JSON at ${path}: ${error}`);
    }
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return;
    const parts = path.slice(0, slash).split("/");
    let current = "";
    for (const part of parts) {
      if (!part) continue;
      current = current ? `${current}/${part}` : part;
      if (!(await this.vault.adapter.exists(current))) {
        await this.vault.adapter.mkdir(current);
      }
    }
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.vault.adapter.exists(path)) {
      await this.vault.adapter.remove(path);
    }
  }
}

function stripJsonBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function fnv1aHex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function normalizeLegacyGuideTypes(data: PDFAnnotationData): PDFAnnotationData {
  for (const page of data.pages ?? []) {
    for (const guide of page.guides ?? []) {
      if ((guide as { type?: string }).type === "rule-of-thirds") {
        guide.type = "grid-9";
      }
      const legacyCorner = (guide as { spiralCorner?: string }).spiralCorner;
      if (guide.type === "golden-spiral" && guide.rotation === undefined && legacyCorner) {
        guide.rotation = legacySpiralCornerToRotation(legacyCorner);
      }
      delete (guide as { spiralCorner?: string }).spiralCorner;
    }
  }
  return data;
}

function legacySpiralCornerToRotation(corner: string): 0 | 1 | 2 | 3 {
  if (corner === "bl") return 0;
  if (corner === "br") return 1;
  if (corner === "tr") return 2;
  if (corner === "tl") return 3;
  return 1;
}
