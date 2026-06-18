import { Notice } from "obsidian";
import type { NativePDFArtLeafState, TextHitMode } from "../leaf-state";
import { TextAnnotation } from "../types";

export const TEXT_LINE_HEIGHT_MULTIPLIER = 1.35;
export const TEXT_DRAG_THRESHOLD = 0.003;

export class NativeTextTool {
	private textEditor: HTMLElement | null = null;
	private baseTextWidth = 0;

	constructor(
		private readonly ctx: CanvasRenderingContext2D,
		private readonly wrapper: HTMLElement,
		private readonly manager: NativePDFArtLeafState,
		private readonly pageNumber: number,
		private readonly getPageWidth: () => number,
	) { }

	updateBaseWidth(pageWidth: number) {
		if (this.baseTextWidth <= 0 && pageWidth > 0) this.baseTextWidth = pageWidth;
	}

	closeEditor() {
		this.textEditor?.remove();
		this.textEditor = null;
	}

	drawText(text: TextAnnotation, w: number, h: number, index: number) {
		const bounds = this.textBounds(text, w, h);
		this.ctx.save();
		this.ctx.fillStyle = text.color;
		const fontSize = this.textFontSize(text, w);
		this.ctx.font = `${fontSize}px sans-serif`;
		this.ctx.textBaseline = "top";
		const lines = this.wrapTextLines(text.text, bounds.w);
		lines.forEach((line, lineIndex) => {
			this.ctx.fillText(line, bounds.x, bounds.y + lineIndex * fontSize * TEXT_LINE_HEIGHT_MULTIPLIER, bounds.w);
		});
		if (this.manager.getSelectedText()?.page === this.pageNumber && this.manager.getSelectedText()?.index === index) {
			this.drawTextSelection(bounds.x, bounds.y, bounds.w, bounds.h);
		}
		this.ctx.restore();
	}

	openEditor(
		x: number,
		y: number,
		initial = "",
		onSubmit?: (text: string) => Promise<void>
	) {
		this.textEditor?.remove();
		const rect = this.wrapper.getBoundingClientRect();
		const editor = document.createElement("div");
		editor.className = "pdf-art-native-text-editor";
		const left = rect.left + x * rect.width;
		const top = rect.top + y * rect.height;
		const maxLeft = Math.max(8, window.innerWidth - 280);
		const maxTop = Math.max(8, window.innerHeight - 130);
		editor.style.left = `${Math.min(maxLeft, Math.max(8, left))}px`;
		editor.style.top = `${Math.min(maxTop, Math.max(8, top))}px`;
		const isolate = (event: Event) => {
			event.stopPropagation();
		};
		for (const eventName of ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "click", "touchstart", "touchmove", "touchend"]) {
			editor.addEventListener(eventName, isolate);
		}

		const textarea = document.createElement("textarea");
		textarea.className = "pdf-art-native-textarea";
		textarea.placeholder = "输入文字";
		textarea.rows = 3;
		textarea.value = initial;
		editor.appendChild(textarea);

		const actions = document.createElement("div");
		actions.className = "pdf-art-native-text-actions";
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.textContent = "取消";
		const ok = document.createElement("button");
		ok.type = "button";
		ok.textContent = "确定";
		ok.className = "mod-cta";
		actions.append(cancel, ok);
		editor.appendChild(actions);

		let closed = false;
		let submitting = false;
		const close = () => {
			if (closed) return;
			closed = true;
			editor.remove();
			if (this.textEditor === editor) this.textEditor = null;
		};
		const handleCancel = (event?: Event) => {
			event?.preventDefault();
			event?.stopPropagation();
			close();
		};
		cancel.addEventListener("click", handleCancel);
		cancel.addEventListener("pointerup", handleCancel);
		cancel.addEventListener("touchend", handleCancel);
		const submit = () => {
			if (closed || submitting) return;
			const text = textarea.value.trim();
			if (!text) {
				close();
				return;
			}
			submitting = true;
			const action = onSubmit ?? ((value: string) => this.manager.addText(this.pageNumber, x, y, value, this.getPageWidth()));
			void action(text)
				.then(() => close())
				.catch((error) => {
					submitting = false;
					console.error("PDF Art Annotator: failed to save text", error);
					new Notice("PDF Art Annotator：文字保存失败，请查看控制台。");
				});
		};
		const handleSubmit = (event?: Event) => {
			event?.preventDefault();
			event?.stopPropagation();
			submit();
		};
		ok.addEventListener("click", handleSubmit);
		ok.addEventListener("pointerup", handleSubmit);
		ok.addEventListener("touchend", handleSubmit);
		textarea.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			}
			if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
				event.preventDefault();
				submit();
			}
		});

		document.body.appendChild(editor);
		this.textEditor = editor;
		window.setTimeout(() => {
			textarea.focus();
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		}, 0);
	}

	handleDoubleClick(event: MouseEvent, canvas: HTMLCanvasElement) {
		if (!this.manager.getEnabled() || this.manager.getTool() !== "text") return false;
		const rect = canvas.getBoundingClientRect();
		const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
		const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
		const hit = this.hitText(x, y);
		if (!hit || hit.mode === "delete") return false;
		const item = this.manager.getPage(this.pageNumber).items[hit.index];
		if (item?.type !== "text") return false;
		event.preventDefault();
		event.stopPropagation();
		this.openEditor(item.x, item.y, item.text, (text) => this.manager.updateText(this.pageNumber, hit.index, { text }));
		return true;
	}

	hitText(nx: number, ny: number): { index: number; mode: TextHitMode } | null {
		const rect = this.wrapper.getBoundingClientRect();
		const x = nx * rect.width;
		const y = ny * rect.height;
		const page = this.manager.getPage(this.pageNumber);
		const selected = this.manager.getSelectedText();
		if (selected?.page === this.pageNumber) {
			const item = page.items[selected.index];
			if (item?.type === "text") {
				const b = this.textBounds(item, rect.width, rect.height);
				if (Math.hypot(x - (b.x + b.w - 6), y - (b.y + 6)) <= 15) {
					return { index: selected.index, mode: "delete" };
				}
			}
		}
		for (let i = page.items.length - 1; i >= 0; i--) {
			const item = page.items[i];
			if (item.type !== "text") continue;
			const b = this.textBounds(item, rect.width, rect.height);
			if (x >= b.x - 8 && x <= b.x + b.w + 8 && y >= b.y - 8 && y <= b.y + b.h + 8) {
				return { index: i, mode: "move" };
			}
		}
		return null;
	}

	private textBounds(text: TextAnnotation, w: number, h: number) {
		const x = text.x <= 1 ? text.x * w : text.x;
		const y = text.y <= 1 ? text.y * h : text.y;
		const width = text.width <= 1 ? text.width * w : text.width;
		const fontSize = this.textFontSize(text, w);
		this.ctx.save();
		this.ctx.font = `${fontSize}px sans-serif`;
		const lines = this.wrapTextLines(text.text, width);
		this.ctx.restore();
		return { x, y, w: width, h: Math.max(1, lines.length) * fontSize * TEXT_LINE_HEIGHT_MULTIPLIER };
	}

	private textFontSize(text: TextAnnotation, pageWidth: number) {
		if (text.fontSizeRatio && text.fontSizeRatio > 0) {
			return Math.min(144, Math.max(4, text.fontSizeRatio * pageWidth));
		}
		const baseWidth = this.baseTextWidth > 0 ? this.baseTextWidth : pageWidth;
		const scale = baseWidth > 0 ? pageWidth / baseWidth : 1;
		return Math.min(144, Math.max(4, text.fontSize * scale));
	}

	private wrapTextLines(value: string, maxWidth: number) {
		const safeWidth = Math.max(8, maxWidth);
		const lines: string[] = [];
		for (const paragraph of value.split(/\r?\n/)) {
			if (!paragraph) {
				lines.push("");
				continue;
			}
			const isCJK = /[\u3400-\u9fff\uff00-\uffef]/.test(paragraph);
			const tokens = isCJK ? Array.from(paragraph) : paragraph.split(/(\s+)/);
			let line = "";
			for (const token of tokens) {
				const candidate = line + token;
				if (line && this.ctx.measureText(candidate).width > safeWidth) {
					lines.push(line.trimEnd());
					line = token.trimStart();
					while (line && this.ctx.measureText(line).width > safeWidth) {
						let cut = 1;
						while (cut < line.length && this.ctx.measureText(line.slice(0, cut + 1)).width <= safeWidth) cut += 1;
						lines.push(line.slice(0, cut));
						line = line.slice(cut);
					}
				} else {
					line = candidate;
				}
			}
			lines.push(line);
		}
		return lines.length > 0 ? lines : [""];
	}

	private drawTextSelection(x: number, y: number, w: number, h: number) {
		this.ctx.save();
		this.ctx.strokeStyle = "rgba(80, 160, 255, 0.95)";
		this.ctx.lineWidth = 2;
		this.ctx.setLineDash([5, 3]);
		this.ctx.strokeRect(x - 4, y - 4, w + 8, h + 8);
		this.ctx.setLineDash([]);
		const dx = x + w - 6;
		const dy = y + 6;
		this.ctx.fillStyle = "rgba(255, 90, 90, 0.95)";
		this.ctx.beginPath();
		this.ctx.arc(dx, dy, 12, 0, Math.PI * 2);
		this.ctx.fill();
		this.ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
		this.ctx.lineWidth = 2;
		this.ctx.beginPath();
		this.ctx.moveTo(dx - 4, dy - 4);
		this.ctx.lineTo(dx + 4, dy + 4);
		this.ctx.moveTo(dx + 4, dy - 4);
		this.ctx.lineTo(dx - 4, dy + 4);
		this.ctx.stroke();
		this.ctx.restore();
	}
}
