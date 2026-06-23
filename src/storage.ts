import { normalizePath, Vault } from "obsidian";
import { PDFAnnotationData, PageAnnotations, StrokeAnnotation, TextAnnotation } from "./types";
import { GuideAnnotation, GuideType } from "./guides";

const ANNOTATION_ROOT = "PDF Art Annotations";
const HASH_LENGTH = 12;
const CURRENT_VERSION = 5;

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
      return this.parseAnnotationData(raw, path, pdfPath);
    }

    // Legacy migration: check old companion-file paths
    for (const legacyPath of this.legacyAnnotationPaths(pdfPath)) {
      if (await this.vault.adapter.exists(legacyPath)) {
        const raw = await this.vault.adapter.read(legacyPath);
        const data = this.parseAnnotationData(raw, legacyPath, pdfPath);
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
    data.version = CURRENT_VERSION;
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
    if (!data) data = { source: pdfPath, pages: [], version: CURRENT_VERSION };
    const idx = data.pages.findIndex((p) => p.page === annotations.page);
    if (idx >= 0) data.pages[idx] = annotations;
    else data.pages.push(annotations);
    await this.save(data);
  }

  async addStroke(pdfPath: string, pageNum: number, stroke: StrokeAnnotation): Promise<void> {
    let data = await this.load(pdfPath);
    if (!data) data = { source: pdfPath, pages: [], version: CURRENT_VERSION };
    let page = data.pages.find((p) => p.page === pageNum);
    if (!page) {
      page = { page: pageNum, strokes: [], texts: [], guides: [] };
      data.pages.push(page);
    }
    page.strokes.push(stroke);
    await this.save(data);
  }

  // ── Private helpers ──

  private parseAnnotationData(raw: string, path: string, fallbackSource: string): PDFAnnotationData {
    try {
      return normalizeAnnotationData(JSON.parse(stripJsonBom(raw)), fallbackSource);
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

function normalizeAnnotationData(input: unknown, fallbackSource: string): PDFAnnotationData {
  const raw = input as {
    source?: unknown;
    version?: unknown;
    pages?: Array<{
      page?: unknown;
      strokes?: unknown;
      texts?: unknown;
      guides?: unknown;
      items?: unknown;
    }>;
  };
  const pages: PageAnnotations[] = [];
  for (const page of raw.pages ?? []) {
    const pageNumber = Number(page.page);
    if (!Number.isInteger(pageNumber)) continue;
    const strokes = normalizeStrokeList(page.strokes);
    const texts = normalizeTextList(page.texts);
    const guides = normalizeGuideList(page.guides, Number(raw.version) || 0);
    // 兼容旧版数据：旧结构把画笔、荧光笔、文字都放在 items 里。
    if (strokes.length === 0) strokes.push(...normalizeStrokeList(page.items));
    if (texts.length === 0) texts.push(...normalizeTextList(page.items));
    pages.push({ page: pageNumber, strokes, texts, guides });
  }
  return {
    source: typeof raw.source === "string" && raw.source ? raw.source : fallbackSource,
    pages,
    version: CURRENT_VERSION,
  };
}

function normalizeStrokeList(value: unknown): StrokeAnnotation[] {
  if (!Array.isArray(value)) return [];
  const strokes: StrokeAnnotation[] = [];
  for (const item of value as Array<Partial<StrokeAnnotation>>) {
    if (item.type !== "pen" && item.type !== "highlighter") continue;
    if (!Array.isArray(item.points) || item.points.length === 0) continue;
    strokes.push({
      id: typeof item.id === "string" ? item.id : makeStrokeId(),
      type: item.type,
      points: item.points.map((point) => ({
        x: clamp01(Number(point.x)),
        y: clamp01(Number(point.y)),
        pressure: clamp01(Number(point.pressure) || 0.5),
      })),
      color: typeof item.color === "string" ? item.color : "#ff0000",
      width: Number(item.width) || 3,
      opacity: Number(item.opacity) || (item.type === "highlighter" ? 0.35 : 1),
    });
  }
  return strokes;
}

function normalizeGuideList(value: unknown, dataVersion: number): GuideAnnotation[] {
  if (!Array.isArray(value)) return [];
  const guides: GuideAnnotation[] = [];
  for (const item of value as Array<Partial<GuideAnnotation> & { _id?: unknown; rect?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }; visible?: unknown }>) {
    const type = normalizeGuideType(item.type);
    if (!type || item.visible === false) continue;
    guides.push({
      id: typeof item.id === "string" ? item.id : typeof item._id === "string" ? item._id : makeGuideId(),
      type,
      x: clamp01(Number(item.x ?? item.rect?.x ?? 0.1)),
      y: clamp01(Number(item.y ?? item.rect?.y ?? 0.1)),
      width: clampGuideSize(Number(item.width ?? item.rect?.w ?? 0.8)),
      height: clampGuideSize(Number(item.height ?? item.rect?.h ?? 0.8)),
      rotation: normalizeRotation(item.rotation, dataVersion),
      mirrorX: Boolean(item.mirrorX),
      mirrorY: Boolean(item.mirrorY),
      color: typeof item.color === "string" ? item.color : "#ffffff",
      strokeWidth: Number(item.strokeWidth) || 1,
    });
  }
  return guides;
}

function normalizeGuideType(type: unknown): GuideType | null {
  if (type === "grid-9" || type === "golden-ratio" || type === "golden-spiral") return type;
  if (type === "grid-16" || type === "grid-12") return "grid-16";
  return null;
}

function normalizeRotation(value: unknown, dataVersion: number): number {
  const rotation = Number(value);
  if (!Number.isFinite(rotation)) return 0;
  if (dataVersion < 5 && (rotation === 1 || rotation === 2 || rotation === 3)) {
    return normalizeAngle((rotation * Math.PI) / 2);
  }
  return normalizeAngle(rotation);
}

function normalizeTextList(value: unknown): TextAnnotation[] {
  if (!Array.isArray(value)) return [];
  const texts: TextAnnotation[] = [];
  for (const item of value as Array<Partial<TextAnnotation> & { type?: unknown; fontSizeRatio?: unknown }>) {
    if (item.type !== "text" && !("text" in item)) continue;
    if (typeof item.text !== "string" || item.text.trim().length === 0) continue;
    texts.push({
      id: typeof item.id === "string" ? item.id : makeTextId(),
      x: clamp01(Number(item.x)),
      y: clamp01(Number(item.y)),
      width: clampTextWidth(Number(item.width) || 0.28),
      text: item.text,
      color: typeof item.color === "string" ? item.color : "#ff4444",
      fontSize: Number(item.fontSize) || 16,
    });
  }
  return texts;
}

function makeStrokeId(): string {
  return `stroke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeTextId(): string {
  return `text-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeGuideId(): string {
  return `guide-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clampTextWidth(value: number): number {
  if (!Number.isFinite(value)) return 0.28;
  return Math.min(0.9, Math.max(0.08, value));
}

function clampGuideSize(value: number): number {
  if (!Number.isFinite(value)) return 0.8;
  return Math.min(1, Math.max(0.05, value));
}

function normalizeAngle(angle: number): number {
  const fullTurn = Math.PI * 2;
  const normalized = angle % fullTurn;
  return normalized < 0 ? normalized + fullTurn : normalized;
}
