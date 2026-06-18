import { Notice, TFile, WorkspaceLeaf } from "obsidian";
import { AnnotationStore } from "./storage";
import { PDFAnnotationData, PageAnnotations, PenStroke, TextAnnotation } from "./types";
import { GuideState, GuideType } from "./guides";
import { NativePageOverlay } from "./page-overlay";

export type Tool = "pen" | "highlighter" | "eraser" | "text" | "guide";
export type GuideHitMode = "move" | "resize-tl" | "resize-br" | "delete" | "rotate" | "mirror-x" | "mirror-y";
export type TextHitMode = "move" | "delete";

export const SELECTORS = {
	viewerContainer: ".pdf-viewer-container",
	pages: ".pdfViewer .page[data-page-number]",
	canvasWrapper: ".canvasWrapper",
} as const;

// ── Tuning constants ──
export const SYNC_DEBOUNCE_MS = 120;
export const MUTATION_DEBOUNCE_MS = 60;
export const MAX_FONT_SIZE = 72;
export const MIN_FONT_SIZE = 8;
export const MAX_STROKE_WIDTH = 30;
export const DEFAULT_TEXT_WIDTH_RATIO = 0.28;
export const DEFAULT_GUIDE_SIZE = 0.8;

export interface NativeOverlaySettings {
	defaultPenColor: string;
	defaultPenWidth: number;
	defaultHighlighterColor: string;
	defaultHighlighterWidth: number;
	defaultTextColor: string;
	defaultFontSize: number;
}

// ── Helpers ──

export function strokeNearPoint(stroke: PenStroke, x: number, y: number, radius: number, pageWidth: number, pageHeight: number) {
	for (const point of stroke.points) {
		const px = point.x <= 1 ? point.x : point.x / pageWidth;
		const py = point.y <= 1 ? point.y : point.y / pageHeight;
		if (Math.hypot(px - x, py - y) <= radius) return true;
	}
	return false;
}

// ── Leaf state ──

export class NativePDFArtLeafState {
	private root: HTMLElement | null = null;
	private file: TFile | null = null;
	private data: PDFAnnotationData | null = null;
	private mutationObserver: MutationObserver | null = null;
	private mutationTimer: number | null = null;
	private intersectionObserver: IntersectionObserver | null = null;
	private observedPages = new Map<HTMLElement, number>();
	private visiblePages = new Set<number>();
	private overlays = new Map<number, NativePageOverlay>();
	private enabled = false;
	private tool: Tool = "pen";
	private guideType: GuideType = "grid-9";
	private color = "#ff0000";
	private width = 3;
	private selectedGuide: { page: number; id: string } | null = null;
	private selectedText: { page: number; index: number } | null = null;

	constructor(
		private readonly leaf: WorkspaceLeaf,
		private readonly store: AnnotationStore,
		private readonly getSettings: () => NativeOverlaySettings
	) {
		const settings = this.getSettings();
		this.color = settings.defaultPenColor;
		this.width = settings.defaultPenWidth;
	}

	async sync() {
		const view = this.leaf.view as any;
		const file = view.file instanceof TFile ? view.file : null;
		const root = view.containerEl as HTMLElement | undefined;
		if (!file || file.extension.toLowerCase() !== "pdf" || !root) {
			this.destroy();
			return;
		}
		this.root = root;
		this.root.addClass("pdf-art-native-host");
		if (this.file?.path !== file.path) {
			this.file = file;
			try {
				this.data = (await this.store.load(file.path)) ?? { source: file.path, pages: [], version: 1 };
			} catch (error) {
				console.error("PDF Art Annotator: failed to load annotations", error);
				new Notice("PDF Art Annotator：批注 JSON 损坏或无法读取，已停止加载以避免覆盖数据。");
				this.data = null;
				this.file = null;
				for (const overlay of this.overlays.values()) overlay.destroy();
				this.overlays.clear();
				return;
			}
			this.selectedGuide = null;
			this.selectedText = null;
		}
		this.ensureMutationObserver();
		this.syncPages();
		this.renderAll();
	}

	destroy() {
		if (this.mutationTimer !== null) {
			window.clearTimeout(this.mutationTimer);
			this.mutationTimer = null;
		}
		this.mutationObserver?.disconnect();
		this.mutationObserver = null;
		this.intersectionObserver?.disconnect();
		this.intersectionObserver = null;
		this.observedPages.clear();
		this.visiblePages.clear();
		this.root?.removeClass("pdf-art-native-host");
		for (const overlay of this.overlays.values()) overlay.destroy();
		this.overlays.clear();
	}

	toggleEnabled() {
		this.enabled = !this.enabled;
		this.refreshOverlayState();
	}

	getEnabled() { return this.enabled; }
	getTool() { return this.tool; }
	getColor() { return this.color; }
	getWidth() { return this.width; }
	getGuideType() { return this.guideType; }
	getSelectedGuide() { return this.selectedGuide; }
	getSelectedText() { return this.selectedText; }

	setTool(tool: Tool) {
		this.tool = tool;
		this.enabled = true;
		const settings = this.getSettings();
		if (tool === "pen") {
			this.color = settings.defaultPenColor;
			this.width = settings.defaultPenWidth;
		} else if (tool === "highlighter") {
			this.color = settings.defaultHighlighterColor;
			this.width = settings.defaultHighlighterWidth;
		} else if (tool === "text") {
			this.color = settings.defaultTextColor;
			this.width = settings.defaultFontSize;
		}
		if (tool !== "guide") this.selectedGuide = null;
		if (tool !== "text") this.selectedText = null;
		this.renderAll();
	}

	setColor(color: string) {
		this.color = color;
		if (this.selectedText) {
			void this.updateText(this.selectedText.page, this.selectedText.index, { color });
		}
		this.applySelectedGuideStyle({ color });
	}

	setWidth(width: number) {
		this.width = width;
		if (this.selectedText || this.tool === "text") {
			const nextSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, width));
			this.width = nextSize;
			if (this.selectedText) {
				const pageWidth = this.overlays.get(this.selectedText.page)?.getPageWidth();
				void this.updateText(this.selectedText.page, this.selectedText.index, {
					fontSize: nextSize,
					fontSizeRatio: pageWidth && pageWidth > 0 ? nextSize / pageWidth : undefined,
				});
			}
			return;
		}
		this.applySelectedGuideStyle({ strokeWidth: width });
	}

	setGuideType(type: GuideType) {
		this.guideType = type;
		this.setTool("guide");
		this.selectedGuide = null;
		this.renderAll();
	}

	getPage(pageNumber: number): PageAnnotations {
		if (!this.data) throw new Error("PDF Art native overlay has no data");
		let page = this.data.pages.find((p) => p.page === pageNumber);
		if (!page) {
			page = { page: pageNumber, items: [], guides: [] };
			this.data.pages.push(page);
		}
		return page;
	}

	async save() {
		if (!this.data) return;
		await this.store.save(this.data);
	}

	async addStroke(pageNumber: number, stroke: PenStroke) {
		this.getPage(pageNumber).items.push(stroke);
		await this.save();
	}

	async addText(pageNumber: number, x: number, y: number, text: string, pageWidth?: number) {
		const trimmed = text.trim();
		if (!trimmed) return;
		const fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, this.width));
		const item: TextAnnotation = {
			type: "text",
			x,
			y,
			text: trimmed,
			fontSize,
			fontSizeRatio: pageWidth && pageWidth > 0 ? fontSize / pageWidth : undefined,
			color: this.color,
			width: DEFAULT_TEXT_WIDTH_RATIO,
		};
		const page = this.getPage(pageNumber);
		page.items.push(item);
		this.selectedText = { page: pageNumber, index: page.items.length - 1 };
		await this.save();
		this.renderAll();
	}

	async addGuide(pageNumber: number, x: number, y: number) {
		const id = `guide-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const w = DEFAULT_GUIDE_SIZE;
		const h = DEFAULT_GUIDE_SIZE;
		const rect = {
			x: Math.min(1 - w, Math.max(0, x - w / 2)),
			y: Math.min(1 - h, Math.max(0, y - h / 2)),
			w,
			h,
		};
		this.getPage(pageNumber).guides.push({
			_id: id,
			type: this.guideType,
			visible: true,
			rect,
			rotation: 1,
			strokeWidth: this.width,
			color: this.color,
			mirrorX: false,
			mirrorY: false,
		});
		this.selectedGuide = { page: pageNumber, id };
		await this.save();
		this.renderAll();
	}

	selectText(page: number, index: number | null) {
		this.selectedText = index === null ? null : { page, index };
		if (index !== null) this.selectedGuide = null;
		const item = index === null ? null : this.getPage(page).items[index];
		if (item?.type === "text") {
			this.color = item.color;
			this.width = item.fontSize;
		}
		this.renderAll();
	}

	async updateText(pageNumber: number, index: number, patch: Partial<TextAnnotation>) {
		const item = this.getPage(pageNumber).items[index];
		if (!item || item.type !== "text") return;
		Object.assign(item, patch);
		await this.save();
		this.renderAll();
	}

	async removeText(pageNumber: number, index: number) {
		const page = this.getPage(pageNumber);
		const item = page.items[index];
		if (!item || item.type !== "text") return;
		page.items.splice(index, 1);
		this.selectedText = null;
		await this.save();
		this.renderAll();
	}

	async eraseAt(pageNumber: number, x: number, y: number, radius: number, options: { save?: boolean; pageWidth?: number; pageHeight?: number } = {}) {
		const page = this.getPage(pageNumber);
		const pw = options.pageWidth ?? 1000;
		const ph = options.pageHeight ?? 1000;
		page.items = page.items.filter((item) => {
			if (item.type === "text") return true;
			return !strokeNearPoint(item, x, y, radius, pw, ph);
		});
		if (options.save !== false) await this.save();
		this.renderAll();
	}

	selectGuide(page: number, id: string | null) {
		this.selectedGuide = id ? { page, id } : null;
		const guide = id ? this.getPage(page).guides.find((g) => g._id === id) : null;
		if (id) this.selectedText = null;
		if (guide) {
			this.color = guide.color ?? this.color;
			this.width = guide.strokeWidth ?? this.width;
		}
		this.renderAll();
	}

	async updateGuide(pageNumber: number, id: string, patch: Partial<GuideState>, options: { save?: boolean } = {}) {
		const guide = this.getPage(pageNumber).guides.find((g) => g._id === id);
		if (!guide) return;
		Object.assign(guide, patch);
		if (options.save !== false) await this.save();
		this.renderAll();
	}

	async removeGuide(pageNumber: number, id: string) {
		const page = this.getPage(pageNumber);
		page.guides = page.guides.filter((g) => g._id !== id);
		if (this.selectedGuide?.id === id) this.selectedGuide = null;
		await this.save();
		this.renderAll();
	}

	async clearCurrentPage() {
		const pageNumber = this.getCurrentPageNumber();
		if (!window.confirm(`清除第 ${pageNumber} 页的全部 PDF Art 标注？`)) return;
		this.overlays.get(pageNumber)?.closeTextEditor();
		const page = this.getPage(pageNumber);
		page.items = [];
		page.guides = [];
		this.selectedGuide = null;
		this.selectedText = null;
		await this.save();
		new Notice(`已清除第 ${pageNumber} 页的全部 PDF Art 标注`);
		this.renderAll();
	}

	private ensureMutationObserver() {
		if (this.mutationObserver || !this.root) return;
		this.mutationObserver = new MutationObserver(() => {
			if (this.mutationTimer !== null) window.clearTimeout(this.mutationTimer);
			this.mutationTimer = window.setTimeout(() => {
				this.mutationTimer = null;
				this.syncPages();
			}, MUTATION_DEBOUNCE_MS);
		});
		this.mutationObserver.observe(this.root, { childList: true, subtree: true });
	}

	private syncPages() {
		const pageElements = Array.from(this.root?.querySelectorAll<HTMLElement>(SELECTORS.pages) ?? []);
		const pageElementSet = new Set(pageElements);
		const pages = new Map<number, { pageEl: HTMLElement; wrapper: HTMLElement }>();
		this.ensureIntersectionObserver();
		for (const pageEl of pageElements) {
			const pageNumber = Number(pageEl.dataset.pageNumber);
			const wrapper = pageEl.querySelector<HTMLElement>(SELECTORS.canvasWrapper);
			if (!Number.isInteger(pageNumber) || !wrapper) continue;
			pages.set(pageNumber, { pageEl, wrapper });
			if (!this.observedPages.has(pageEl)) {
				this.observedPages.set(pageEl, pageNumber);
				this.intersectionObserver?.observe(pageEl);
			}
		}
		for (const [pageEl, pageNumber] of Array.from(this.observedPages.entries())) {
			if (!pageElementSet.has(pageEl)) {
				this.intersectionObserver?.unobserve(pageEl);
				this.observedPages.delete(pageEl);
				this.visiblePages.delete(pageNumber);
			}
		}
		const basePages = this.visiblePages.size > 0 ? this.visiblePages : new Set([this.getCurrentPageNumber()]);
		const wanted = new Set<number>();
		for (const pageNumber of basePages) {
			for (let page = Math.max(1, pageNumber - 1); page <= pageNumber + 1; page += 1) {
				wanted.add(page);
			}
		}
		for (const [pageNumber, { wrapper }] of pages.entries()) {
			if (!wanted.has(pageNumber)) continue;
			const existing = this.overlays.get(pageNumber);
			if (!existing || !existing.usesWrapper(wrapper)) {
				existing?.destroy();
				this.overlays.set(pageNumber, new NativePageOverlay(this, pageNumber, wrapper));
			}
		}
		for (const [page, overlay] of this.overlays) {
			if (!wanted.has(page) || !pages.has(page)) {
				overlay.destroy();
				this.overlays.delete(page);
			}
		}
		this.refreshOverlayState();
		this.renderAll();
	}

	private ensureIntersectionObserver() {
		if (this.intersectionObserver) return;
		const container = this.root?.querySelector<HTMLElement>(SELECTORS.viewerContainer);
		this.intersectionObserver = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				const page = this.observedPages.get(entry.target as HTMLElement);
				if (!page) continue;
				if (entry.isIntersecting) {
					this.visiblePages.add(page);
				} else {
					this.visiblePages.delete(page);
				}
			}
			this.syncPages();
		}, { root: container ?? null, threshold: 0.01 });
	}

	private refreshOverlayState() {
		for (const overlay of this.overlays.values()) overlay.refreshState();
	}

	private renderAll() {
		for (const overlay of this.overlays.values()) overlay.render();
	}

	private applySelectedGuideStyle(patch: Partial<GuideState>) {
		if (!this.selectedGuide) return;
		void this.updateGuide(this.selectedGuide.page, this.selectedGuide.id, patch);
	}

	private getCurrentPageNumber(): number {
		const container = this.root?.querySelector<HTMLElement>(SELECTORS.viewerContainer);
		const pages = Array.from(this.root?.querySelectorAll<HTMLElement>(SELECTORS.pages) ?? []);
		if (!container) return 1;
		const viewport = container.getBoundingClientRect();
		let best: { page: number; area: number; distance: number } | null = null;
		const centerY = (viewport.top + viewport.bottom) / 2;
		for (const pageEl of pages) {
			const page = Number(pageEl.dataset.pageNumber);
			if (!Number.isInteger(page)) continue;
			const rect = pageEl.getBoundingClientRect();
			const w = Math.max(0, Math.min(viewport.right, rect.right) - Math.max(viewport.left, rect.left));
			const h = Math.max(0, Math.min(viewport.bottom, rect.bottom) - Math.max(viewport.top, rect.top));
			const area = w * h;
			const distance = Math.abs((rect.top + rect.bottom) / 2 - centerY);
			if (area > 0 && (!best || area > best.area || (area === best.area && distance < best.distance))) {
				best = { page, area, distance };
			}
		}
		return best?.page ?? 1;
	}
}
