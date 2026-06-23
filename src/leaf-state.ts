import { Notice, TFile, WorkspaceLeaf } from "obsidian";
import { AnnotationStore } from "./storage";
import { PDFAnnotationData, PageAnnotations, StrokeAnnotation, TextAnnotation } from "./types";
import { NativePageOverlay } from "./page-overlay";
import { GuideAnnotation, GuideType } from "./guides";

export type Tool = "select" | "pen" | "highlighter" | "eraser" | "text" | "guide";
export type SelectableAnnotationType = "stroke" | "text" | "guide";
export interface SelectedAnnotation {
	page: number;
	type: SelectableAnnotationType;
	id: string;
}
export type GuideHitMode =
	| "move"
	| "delete"
	| "rotate"
	| "resize-nw"
	| "resize-ne"
	| "resize-se"
	| "resize-sw"
	| "mirror-x"
	| "mirror-y";

export const SELECTORS = {
	viewerContainer: ".pdf-viewer-container",
	pages: ".pdfViewer .page[data-page-number]",
	canvasWrapper: ".canvasWrapper",
} as const;

export const MAX_STROKE_WIDTH = 30;
export const MIN_STROKE_WIDTH = 1;
export const MAX_FONT_SIZE = 72;
export const MIN_FONT_SIZE = 8;
export const DEFAULT_TEXT_WIDTH = 0.28;
export const DEFAULT_GUIDE_SIZE = 0.72;

export interface NativeOverlaySettings {
	defaultPenColor: string;
	defaultPenWidth: number;
	defaultHighlighterColor: string;
	defaultHighlighterWidth: number;
	defaultTextColor: string;
	defaultFontSize: number;
	eraserWidth: number;
}

interface ActiveTextEditor {
	page: number;
	id: string | null;
	applyStyle: (style: { color: string; fontSize: number }) => void;
}

export function strokeNearPoint(stroke: StrokeAnnotation, x: number, y: number, radiusPx: number, pageWidth: number, pageHeight: number) {
	for (const point of stroke.points) {
		const dx = point.x * pageWidth - x * pageWidth;
		const dy = point.y * pageHeight - y * pageHeight;
		if (Math.hypot(dx, dy) <= radiusPx) return true;
	}
	return false;
}

export class NativePDFArtLeafState {
	private root: HTMLElement | null = null;
	private file: TFile | null = null;
	private data: PDFAnnotationData | null = null;
	private mutationObserver: MutationObserver | null = null;
	private intersectionObserver: IntersectionObserver | null = null;
	private syncingPages = false;
	private syncing = false;
	private observedPages = new Map<HTMLElement, number>();
	private visiblePages = new Set<number>();
	private overlays = new Map<number, NativePageOverlay>();
	private enabled = false;
	private tool: Tool = "pen";
	private guideType: GuideType = "grid-9";
	private selectedItems: SelectedAnnotation[] = [];
	private color = "#ff0000";
	private width = 3;
	private activeTextEditor: ActiveTextEditor | null = null;

	constructor(
		private readonly leaf: WorkspaceLeaf,
		private readonly store: AnnotationStore,
		private readonly getSettings: () => NativeOverlaySettings,
		private readonly onStateChange: () => void = () => {}
	) {
		const settings = this.getSettings();
		this.color = settings.defaultPenColor;
		this.width = settings.defaultPenWidth;
	}

	async sync() {
		if (this.syncing) return;
		this.syncing = true;
		try {
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
						this.data = (await this.store.load(file.path)) ?? { source: file.path, pages: [], version: 5 };
				} catch (error) {
					console.error("PDF Art Annotator: failed to load annotations", error);
					new Notice("PDF Art Annotator：批注 JSON 损坏或无法读取，已停止加载以避免覆盖数据。");
					this.data = null;
					this.file = null;
					for (const overlay of this.overlays.values()) overlay.destroy();
					this.overlays.clear();
					return;
				}
			}
			this.ensureMutationObserver();
			this.syncPages();
			this.renderAll();
		} finally {
			this.syncing = false;
		}
	}

	destroy() {
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
		this.renderAll();
	}

	getEnabled() { return this.enabled; }
	getTool() { return this.tool; }
	getColor() { return this.color; }
	getWidth() { return this.width; }
	getGuideType() { return this.guideType; }
	getSelection() { return this.selectedItems; }
	getSelectedGuide() {
		const item = this.selectedItems.length === 1 && this.selectedItems[0].type === "guide" ? this.selectedItems[0] : null;
		return item ? { page: item.page, id: item.id } : null;
	}
	hasActiveTextEditor() { return this.activeTextEditor !== null; }

	setTool(tool: Tool) {
		this.tool = tool;
		const settings = this.getSettings();
		if (tool !== "select") this.selectedItems = [];
		if (tool === "select") {
			// Keep current visual values; selection style sync happens when an item is selected.
		} else if (tool === "pen") {
			this.color = settings.defaultPenColor;
			this.width = settings.defaultPenWidth;
		} else if (tool === "highlighter") {
			this.color = settings.defaultHighlighterColor;
			this.width = settings.defaultHighlighterWidth;
		} else if (tool === "text") {
			this.color = settings.defaultTextColor;
			this.width = settings.defaultFontSize;
		} else if (tool === "guide") {
			this.color = "#ffffff";
			this.width = 1;
		} else {
			this.width = settings.eraserWidth;
		}
		this.refreshOverlayState();
		this.renderAll();
	}

	setColor(color: string) {
		this.color = color;
		this.applyActiveTextStyle();
		this.applySelectedStyle();
		this.refreshOverlayState();
	}

	setWidth(width: number) {
		const selected = this.selectedItems.length > 0 ? this.selectedItems : null;
		const selectionIsTextOnly = selected?.every((item) => item.type === "text") ?? false;
		if (this.tool === "text" || selectionIsTextOnly) {
			this.width = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, width));
		} else {
			this.width = Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, width));
		}
		this.applyActiveTextStyle();
		this.applySelectedStyle();
		this.refreshOverlayState();
	}

	setGuideType(type: GuideType) {
		this.guideType = type;
		this.setTool("guide");
	}

	beginTextEdit(page: number, id: string | null, initialStyle: { color: string; fontSize: number }, applyStyle: ActiveTextEditor["applyStyle"]) {
		this.color = initialStyle.color;
		this.width = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, initialStyle.fontSize));
		this.activeTextEditor = { page, id, applyStyle };
		applyStyle({ color: this.color, fontSize: this.width });
		this.refreshOverlayState();
	}

	endTextEdit(page: number, id: string | null) {
		if (this.activeTextEditor?.page === page && this.activeTextEditor.id === id) {
			this.activeTextEditor = null;
		}
	}

	getPage(pageNumber: number): PageAnnotations {
		if (!this.data) throw new Error("PDF Art native overlay has no data");
		let page = this.data.pages.find((p) => p.page === pageNumber);
		if (!page) {
			page = { page: pageNumber, strokes: [], texts: [], guides: [] };
			this.data.pages.push(page);
		}
		page.texts ??= [];
		page.guides ??= [];
		return page;
	}

	async save() {
		if (!this.data) return;
		await this.store.save(this.data);
	}

	async addStroke(pageNumber: number, stroke: StrokeAnnotation) {
		this.getPage(pageNumber).strokes.push(stroke);
		await this.save();
	}

	async addText(pageNumber: number, x: number, y: number, text: string, width = DEFAULT_TEXT_WIDTH) {
		const trimmed = text.trim();
		if (!trimmed) return;
		const page = this.getPage(pageNumber);
		page.texts.push({
			id: `text-${Date.now()}-${Math.random().toString(16).slice(2)}`,
			x,
			y,
			width: Math.min(0.9, Math.max(0.08, width)),
			text: trimmed,
			color: this.color,
			fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, this.width)),
		});
		await this.save();
		this.renderAll();
	}

	async updateText(pageNumber: number, id: string, patch: Partial<TextAnnotation>, options: { save?: boolean } = {}) {
		const text = this.getPage(pageNumber).texts.find((item) => item.id === id);
		if (!text) return;
		Object.assign(text, patch);
		if (text.text.trim().length === 0) {
			await this.removeText(pageNumber, id);
			return;
		}
		if (options.save !== false) await this.save();
		this.renderAll();
	}

	async removeText(pageNumber: number, id: string) {
		const page = this.getPage(pageNumber);
		page.texts = page.texts.filter((item) => item.id !== id);
		this.selectedItems = this.selectedItems.filter((item) => !(item.page === pageNumber && item.type === "text" && item.id === id));
		if (this.activeTextEditor?.page === pageNumber && this.activeTextEditor.id === id) {
			this.activeTextEditor = null;
		}
		await this.save();
		this.renderAll();
		this.notifyStateChange();
	}

	async addGuide(pageNumber: number, x: number, y: number) {
		const size = DEFAULT_GUIDE_SIZE;
		const guide: GuideAnnotation = {
			id: `guide-${Date.now()}-${Math.random().toString(16).slice(2)}`,
			type: this.guideType,
			x: Math.min(1 - size, Math.max(0, x - size / 2)),
			y: Math.min(1 - size, Math.max(0, y - size / 2)),
			width: size,
			height: size,
			rotation: 0,
			mirrorX: false,
			mirrorY: false,
			color: this.color,
			strokeWidth: Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, this.width)),
		};
		this.getPage(pageNumber).guides.push(guide);
		this.selectItems([{ page: pageNumber, type: "guide", id: guide.id }]);
		await this.save();
		this.renderAll();
	}

	async updateGuide(pageNumber: number, id: string, patch: Partial<GuideAnnotation>, options: { save?: boolean } = {}) {
		const guide = this.getPage(pageNumber).guides.find((item) => item.id === id);
		if (!guide) return;
		Object.assign(guide, patch);
		if (options.save !== false) await this.save();
		this.renderAll();
	}

	async removeGuide(pageNumber: number, id: string) {
		const page = this.getPage(pageNumber);
		page.guides = page.guides.filter((item) => item.id !== id);
		this.selectedItems = this.selectedItems.filter((item) => !(item.page === pageNumber && item.type === "guide" && item.id === id));
		await this.save();
		this.renderAll();
		this.notifyStateChange();
	}

	selectGuide(pageNumber: number, id: string | null) {
		this.selectItems(id ? [{ page: pageNumber, type: "guide", id }] : []);
	}

	selectItems(items: SelectedAnnotation[]) {
		const seen = new Set<string>();
		this.selectedItems = items.filter((item) => {
			const key = `${item.page}:${item.type}:${item.id}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return Boolean(this.findSelectedTarget(item));
		});
		this.syncStyleFromSelection();
		this.refreshOverlayState();
		this.renderAll();
		this.notifyStateChange();
	}

	clearSelection() {
		if (this.selectedItems.length === 0) return;
		this.selectedItems = [];
		this.refreshOverlayState();
		this.renderAll();
		this.notifyStateChange();
	}

	isSelected(page: number, type: SelectableAnnotationType, id: string) {
		return this.selectedItems.some((item) => item.page === page && item.type === type && item.id === id);
	}

	async deleteSelection() {
		if (this.selectedItems.length === 0) return false;
		let deleted = 0;
		for (const pageNumber of new Set(this.selectedItems.map((item) => item.page))) {
			const page = this.getPage(pageNumber);
			const selectedOnPage = this.selectedItems.filter((item) => item.page === pageNumber);
			const strokeIds = new Set(selectedOnPage.filter((item) => item.type === "stroke").map((item) => item.id));
			const textIds = new Set(selectedOnPage.filter((item) => item.type === "text").map((item) => item.id));
			const guideIds = new Set(selectedOnPage.filter((item) => item.type === "guide").map((item) => item.id));
			const before = page.strokes.length + page.texts.length + page.guides.length;
			page.strokes = page.strokes.filter((item) => !strokeIds.has(item.id));
			page.texts = page.texts.filter((item) => !textIds.has(item.id));
			page.guides = page.guides.filter((item) => !guideIds.has(item.id));
			deleted += before - page.strokes.length - page.texts.length - page.guides.length;
			if (this.activeTextEditor?.page === pageNumber && this.activeTextEditor.id && textIds.has(this.activeTextEditor.id)) {
				this.activeTextEditor = null;
			}
		}
		this.selectedItems = [];
		this.refreshOverlayState();
		if (deleted === 0) {
			this.renderAll();
			this.notifyStateChange();
			return false;
		}
		await this.save();
		new Notice(`已删除 ${deleted} 个选中对象`);
		this.renderAll();
		this.notifyStateChange();
		return true;
	}

	eraseAt(pageNumber: number, x: number, y: number, wrapper: HTMLElement, options: { save?: boolean } = {}) {
		const page = this.getPage(pageNumber);
		const before = page.strokes.length;
		const rect = wrapper.getBoundingClientRect();
		page.strokes = page.strokes.filter((stroke) => !strokeNearPoint(stroke, x, y, this.width, rect.width, rect.height));
		const changed = page.strokes.length !== before;
		if (changed && options.save !== false) void this.save();
		if (changed) this.renderAll();
		return changed;
	}

	clearCurrentPage() {
		const pageNumber = this.getCurrentPageNumber();
		if (!window.confirm(`清除第 ${pageNumber} 页的 PDF Art 标注？`)) return;
		const page = this.getPage(pageNumber);
		page.strokes = [];
		page.texts = [];
		page.guides = [];
		this.selectedItems = this.selectedItems.filter((item) => item.page !== pageNumber);
		void this.save();
		new Notice(`已清除第 ${pageNumber} 页的 PDF Art 标注`);
		this.renderAll();
	}

	private ensureMutationObserver() {
		if (this.mutationObserver || !this.root) return;
		this.mutationObserver = new MutationObserver((mutations) => {
			if (mutations.every(isPDFArtMutation)) return;
			this.syncPages();
		});
		this.mutationObserver.observe(this.root, { childList: true, subtree: true });
	}

	private syncPages() {
		if (this.syncingPages) return;
		this.syncingPages = true;
		try {
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
		} finally {
			this.syncingPages = false;
		}
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

	private notifyStateChange() {
		this.onStateChange();
	}

	private applyActiveTextStyle() {
		if (this.tool !== "text" || !this.activeTextEditor) return;
		const fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, this.width));
		this.activeTextEditor.applyStyle({ color: this.color, fontSize });
		if (this.activeTextEditor.id) {
			void this.updateText(this.activeTextEditor.page, this.activeTextEditor.id, {
				color: this.color,
				fontSize,
			}, { save: false });
		}
	}

	private applySelectedStyle() {
		if (this.selectedItems.length === 0) return;
		for (const item of this.selectedItems) {
			const target = this.findSelectedTarget(item);
			if (!target) continue;
			if (item.type === "stroke") {
				Object.assign(target as StrokeAnnotation, {
					color: this.color,
					width: Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, this.width)),
				});
			} else if (item.type === "text") {
				Object.assign(target as TextAnnotation, {
					color: this.color,
					fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, this.width)),
				});
			} else {
				Object.assign(target as GuideAnnotation, {
					color: this.color,
					strokeWidth: Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, this.width)),
				});
			}
		}
		void this.save();
		this.renderAll();
	}

	private syncStyleFromSelection() {
		if (this.selectedItems.length !== 1) return;
		const item = this.selectedItems[0];
		const target = this.findSelectedTarget(item);
		if (!target) return;
		if (item.type === "stroke") {
			const stroke = target as StrokeAnnotation;
			this.color = stroke.color;
			this.width = stroke.width;
		} else if (item.type === "text") {
			const text = target as TextAnnotation;
			this.color = text.color;
			this.width = text.fontSize;
		} else {
			const guide = target as GuideAnnotation;
			this.color = guide.color;
			this.width = guide.strokeWidth;
		}
	}

	private findSelectedTarget(item: SelectedAnnotation): StrokeAnnotation | TextAnnotation | GuideAnnotation | null {
		const page = this.getPage(item.page);
		if (item.type === "stroke") return page.strokes.find((target) => target.id === item.id) ?? null;
		if (item.type === "text") return page.texts.find((target) => target.id === item.id) ?? null;
		return page.guides.find((target) => target.id === item.id) ?? null;
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

function isPDFArtMutation(mutation: MutationRecord): boolean {
	const target = mutation.target;
	if (target instanceof Element && target.closest(".pdf-art-native-overlay, .pdf-art-native-text-layer, .pdf-art-native-cursor")) {
		return true;
	}
	const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
	return changedNodes.length > 0 && changedNodes.every(isPDFArtNode);
}

function isPDFArtNode(node: Node): boolean {
	return node instanceof Element && node.matches(".pdf-art-native-overlay, .pdf-art-native-text-layer, .pdf-art-native-cursor");
}
