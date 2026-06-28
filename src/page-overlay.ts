import type { NativePDFArtLeafState, SelectedAnnotation } from "./leaf-state";
import { NormalizedPoint, StrokeAnnotation, TextAnnotation } from "./types";
import { drawGuide, guideBounds, guideControlPoints, GuideAnnotation } from "./guides";

export const ACTIVE_DRAW_GESTURE_EVENTS = [
  "gesturestart",
  "gesturechange",
  "gestureend",
  "contextmenu",
] as const;
export const NON_PASSIVE_CAPTURE: AddEventListenerOptions = { capture: true, passive: false };
const GUIDE_CONTROL_HIT_RADIUS = 16;
const GUIDE_MOVE_HIT_SLOP = 18;
const TOUCH_STYLUS_MAX_CONTACT_SIZE = 6;
type GuideResizeMode = "resize-nw" | "resize-ne" | "resize-se" | "resize-sw";
type SelectionBox = { start: NormalizedPoint; current: NormalizedPoint };
interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type GuideDrag =
  | { mode: "move"; id: string; startX: number; startY: number; origX: number; origY: number }
  | { mode: "rotate"; id: string; startAngle: number; origRotation: number }
  | {
      mode: GuideResizeMode;
      id: string;
      anchorX: number;
      anchorY: number;
      xSign: -1 | 1;
      ySign: -1 | 1;
      rotation: number;
    };

export class NativePageOverlay {
  private canvas = document.createElement("canvas");
  private textLayer = document.createElement("div");
  private cursor = document.createElement("div");
  private ctx = this.canvas.getContext("2d")!;
  private resizeObserver: ResizeObserver;
  private previousPosition = "";
  private currentStroke: StrokeAnnotation | null = null;
  private textEditor: HTMLElement | null = null;
  private finishTextEditor: (() => void) | null = null;
  private textDrag: { id: string; startX: number; startY: number; origX: number; origY: number; moved: boolean } | null = null;
  private guideDrag: GuideDrag | null = null;
  private selectionBox: SelectionBox | null = null;
  private eraserChanged = false;
  private activeDrawPointerId: number | null = null;
  private activeDrawGestureGuardInstalled = false;
  private touchPan: { pointerId: number; lastX: number; lastY: number; scrollElement: HTMLElement } | null = null;

  constructor(
    private readonly manager: NativePDFArtLeafState,
    private readonly pageNumber: number,
    private readonly wrapper: HTMLElement
  ) {
    this.canvas.className = "pdf-art-native-overlay";
    this.textLayer.className = "pdf-art-native-text-layer";
    this.cursor.className = "pdf-art-native-cursor";
    this.previousPosition = wrapper.style.position;
    if (getComputedStyle(wrapper).position === "static") wrapper.style.position = "relative";
    wrapper.appendChild(this.canvas);
    wrapper.appendChild(this.textLayer);
    wrapper.appendChild(this.cursor);
    this.textLayer.addEventListener("pointerdown", this.onTextLayerPointerDown);
    this.wrapper.addEventListener("pointerenter", this.onPointerEnter);
    this.wrapper.addEventListener("pointerleave", this.onPointerLeave);
    this.wrapper.addEventListener("pointerdown", this.onPointerDown, true);
    this.wrapper.addEventListener("pointermove", this.onPointerMove, true);
    this.wrapper.addEventListener("pointerup", this.onPointerUp, true);
    this.wrapper.addEventListener("pointercancel", this.onPointerUp, true);
    window.addEventListener("keydown", this.onKeyDown);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(wrapper);
    this.resize();
  }

  usesWrapper(wrapper: HTMLElement) { return this.wrapper === wrapper; }

  destroy() {
    this.resizeObserver.disconnect();
    this.textLayer.removeEventListener("pointerdown", this.onTextLayerPointerDown);
    this.wrapper.removeEventListener("pointerenter", this.onPointerEnter);
    this.wrapper.removeEventListener("pointerleave", this.onPointerLeave);
    this.wrapper.removeEventListener("pointerdown", this.onPointerDown, true);
    this.wrapper.removeEventListener("pointermove", this.onPointerMove, true);
    this.wrapper.removeEventListener("pointerup", this.onPointerUp, true);
    this.wrapper.removeEventListener("pointercancel", this.onPointerUp, true);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("pointermove", this.onTextPointerMove);
    window.removeEventListener("pointerup", this.onTextPointerUp);
    window.removeEventListener("pointermove", this.onGuidePointerMove);
    window.removeEventListener("pointerup", this.onGuidePointerUp);
    for (const eventName of ACTIVE_DRAW_GESTURE_EVENTS) {
      window.removeEventListener(eventName, this.blockActiveDrawCompatibilityGesture, NON_PASSIVE_CAPTURE);
    }
    this.activeDrawPointerId = null;
    this.activeDrawGestureGuardInstalled = false;
    this.finishTextEditor = null;
    this.textEditor?.remove();
    this.textLayer.remove();
    this.cursor.remove();
    this.canvas.remove();
    this.wrapper.style.position = this.previousPosition;
  }

  refreshState() {
    this.canvas.toggleClass("is-enabled", this.manager.getEnabled());
    this.canvas.toggleClass("is-text-tool", this.manager.getTool() === "text");
    this.textLayer.toggleClass("is-enabled", this.manager.getEnabled());
    this.textLayer.toggleClass("is-text-tool", this.manager.getTool() === "text");
    this.canvas.dataset.tool = this.manager.getTool();
    this.cursor.dataset.tool = this.manager.getTool();
    this.updateCursorStyle();
    if (!this.manager.getEnabled()) {
      this.finishTextEditor?.();
      this.hideCursor();
    }
  }

  render() {
    const rect = this.wrapper.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    this.ctx.clearRect(0, 0, w, h);
    const page = this.manager.getPage(this.pageNumber);
    const strokes = this.currentStroke ? [...page.strokes, this.currentStroke] : page.strokes;
    drawStrokes(this.ctx, strokes, w, h);
    for (const guide of page.guides) {
      drawGuide(this.ctx, guide, w, h, this.manager.isSelected(this.pageNumber, "guide", guide.id));
    }
    this.drawSelectionFrames(w, h);
    if (this.selectionBox) drawSelectionBox(this.ctx, this.selectionBox, w, h);
    this.renderTextLayer(w, h);
  }

  private resize() {
    const rect = this.wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  private point(event: PointerEvent): NormalizedPoint {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      pressure: event.pressure || 0.5,
    };
  }

  private readonly onPointerEnter = (event: PointerEvent) => {
    this.updateCursor(event);
  };

  private readonly onPointerLeave = () => {
    this.hideCursor();
  };

  private readonly onTextLayerPointerDown = (event: PointerEvent) => {
    if (!this.manager.getEnabled() || this.manager.getTool() !== "text") return;
    if (!canDrawWithPointer(event, this.manager.prefersPenInput())) return;
    this.preferPenInput(event);
    if (event.target !== this.textLayer) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.finishTextEditor) {
      this.finishTextEditor();
      return;
    }
    const rect = this.textLayer.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    this.openTextEditor(x, y);
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (!this.manager.getEnabled()) return;
    const tool = this.manager.getTool();
    if (!canDrawWithPointer(event, this.manager.prefersPenInput())) {
      this.beginTouchPan(event);
      return;
    }
    this.preferPenInput(event);
    this.updateCursor(event);
    const point = this.point(event);
    if (tool === "text") {
      if (isEditableTarget(event.target) || isTextAnnotationTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.finishTextEditor) {
        this.finishTextEditor();
        return;
      }
      this.openTextEditor(point.x, point.y);
      return;
    }
    if (tool === "select") {
      event.preventDefault();
      event.stopPropagation();
      const hit = this.hitSelectable(point.x, point.y);
      if (hit) {
        this.manager.selectItems([hit]);
        return;
      }
      this.selectionBox = { start: point, current: point };
      this.beginDrawGestureGuard(event);
      this.capturePointer(event.pointerId);
      this.render();
      return;
    }
    if (tool === "guide") {
      event.preventDefault();
      event.stopPropagation();
      this.handleGuidePointerDown(event, point.x, point.y);
      return;
    }
    if (tool === "eraser") {
      event.preventDefault();
      event.stopPropagation();
      this.eraserChanged = this.manager.eraseAt(this.pageNumber, point.x, point.y, this.wrapper, { save: false });
      this.beginDrawGestureGuard(event);
      this.capturePointer(event.pointerId);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.currentStroke = createStroke(tool, this.manager.getColor(), this.manager.getWidth(), point);
    this.beginDrawGestureGuard(event);
    this.capturePointer(event.pointerId);
    this.render();
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.touchPan) {
      this.updateTouchPan(event);
      return;
    }
    if (this.activeDrawPointerId !== null && event.pointerId !== this.activeDrawPointerId) return;
    this.updateCursor(event);
    const point = this.point(event);
    if (this.manager.getTool() === "eraser" && this.activeDrawPointerId !== null) {
      event.preventDefault();
      event.stopPropagation();
      this.eraserChanged = this.manager.eraseAt(this.pageNumber, point.x, point.y, this.wrapper, { save: false }) || this.eraserChanged;
      return;
    }
    if (this.manager.getTool() === "select" && this.activeDrawPointerId !== null && this.selectionBox) {
      event.preventDefault();
      event.stopPropagation();
      this.selectionBox.current = point;
      this.render();
      return;
    }
    if (this.manager.getTool() === "guide") return;
    if (!this.currentStroke) return;
    event.preventDefault();
    event.stopPropagation();
    this.currentStroke.points.push(point);
    this.render();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.touchPan) {
      this.endTouchPan(event);
      return;
    }
    if (this.activeDrawPointerId !== null && event.pointerId !== this.activeDrawPointerId) return;
    this.updateCursor(event);
    if (this.manager.getTool() === "eraser" && this.activeDrawPointerId !== null) {
      event.preventDefault();
      event.stopPropagation();
      this.releasePointer(event.pointerId);
      if (this.eraserChanged) void this.manager.save();
      this.eraserChanged = false;
      this.endDrawGestureGuard(event.pointerId);
      return;
    }
    if (this.manager.getTool() === "select" && this.activeDrawPointerId !== null) {
      event.preventDefault();
      event.stopPropagation();
      this.releasePointer(event.pointerId);
      if (this.selectionBox) {
        const items = this.itemsInSelection(this.selectionBox);
        this.selectionBox = null;
        this.manager.selectItems(items);
      }
      this.endDrawGestureGuard(event.pointerId);
      this.render();
      return;
    }
    if (this.manager.getTool() === "guide") return;
    if (!this.currentStroke) return;
    event.preventDefault();
    event.stopPropagation();
    this.releasePointer(event.pointerId);
    const stroke = this.currentStroke;
    this.currentStroke = null;
    this.endDrawGestureGuard(event.pointerId);
    void this.manager.addStroke(this.pageNumber, stroke);
    this.render();
  };

  private beginTouchPan(event: PointerEvent) {
    if (event.pointerType !== "touch" || this.touchPan || this.activeDrawPointerId !== null) return;
    const scrollElement = this.findTouchScrollElement();
    if (!scrollElement) return;
    event.preventDefault();
    event.stopPropagation();
    this.hideCursor();
    this.touchPan = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      scrollElement,
    };
    this.capturePointer(event.pointerId);
  }

  private updateTouchPan(event: PointerEvent) {
    const pan = this.touchPan;
    if (!pan || event.pointerId !== pan.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - pan.lastX;
    const dy = event.clientY - pan.lastY;
    pan.scrollElement.scrollLeft -= dx;
    pan.scrollElement.scrollTop -= dy;
    pan.lastX = event.clientX;
    pan.lastY = event.clientY;
  }

  private endTouchPan(event: PointerEvent) {
    const pan = this.touchPan;
    if (!pan || event.pointerId !== pan.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.touchPan = null;
    this.releasePointer(event.pointerId);
  }

  private findTouchScrollElement(): HTMLElement | null {
    const viewer = this.wrapper.closest(".pdf-viewer-container");
    if (viewer instanceof HTMLElement) return viewer;
    let element = this.wrapper.parentElement;
    while (element) {
      if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) return element;
      element = element.parentElement;
    }
    return null;
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.manager.getEnabled() || this.manager.getTool() !== "select") return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;
    if (!this.manager.getSelection().some((item) => item.page === this.pageNumber)) return;
    event.preventDefault();
    event.stopPropagation();
    void this.manager.deleteSelection();
  };

  private beginDrawGestureGuard(event: PointerEvent) {
    this.activeDrawPointerId = event.pointerId;
    this.canvas.addClass("is-writing");
    if (event.pointerType === "mouse" || this.activeDrawGestureGuardInstalled) return;
    for (const eventName of ACTIVE_DRAW_GESTURE_EVENTS) {
      window.addEventListener(eventName, this.blockActiveDrawCompatibilityGesture, NON_PASSIVE_CAPTURE);
    }
    this.activeDrawGestureGuardInstalled = true;
  }

  private capturePointer(pointerId: number) {
    try { this.wrapper.setPointerCapture(pointerId); } catch {}
  }

  private preferPenInput(event: PointerEvent) {
    if (isPenLikePointer(event)) this.manager.preferPenInput();
  }

  private releasePointer(pointerId: number) {
    try { this.wrapper.releasePointerCapture(pointerId); } catch {}
  }

  private endDrawGestureGuard(pointerId?: number) {
    if (pointerId !== undefined && this.activeDrawPointerId !== null && pointerId !== this.activeDrawPointerId) return;
    this.activeDrawPointerId = null;
    this.canvas.removeClass("is-writing");
    if (!this.activeDrawGestureGuardInstalled) return;
    for (const eventName of ACTIVE_DRAW_GESTURE_EVENTS) {
      window.removeEventListener(eventName, this.blockActiveDrawCompatibilityGesture, NON_PASSIVE_CAPTURE);
    }
    this.activeDrawGestureGuardInstalled = false;
  }

  private renderTextLayer(pageWidth: number, pageHeight: number) {
    const editor = this.textEditor;
    const editingId = editor?.dataset.textId ?? null;
    const existingEditorParent = editor?.parentElement;
    for (const child of Array.from(this.textLayer.children)) {
      if (child !== editor) child.remove();
    }
    for (const text of this.manager.getPage(this.pageNumber).texts) {
      if (text.id === editingId) continue;
      const box = this.textLayer.createDiv({ cls: "pdf-art-native-text-box" });
      box.dataset.id = text.id;
      box.style.left = `${text.x * pageWidth}px`;
      box.style.top = `${text.y * pageHeight}px`;
      box.style.width = `${text.width * pageWidth}px`;
      box.style.color = text.color;
      box.style.fontSize = `${text.fontSize}px`;
      box.setText(text.text);
      box.toggleClass("is-selected", this.manager.isSelected(this.pageNumber, "text", text.id));
      box.addEventListener("pointerdown", (event) => this.onTextPointerDown(event, text));
      if (this.manager.getEnabled() && this.manager.getTool() === "text") {
        const remove = box.createEl("button", { cls: "pdf-art-native-text-remove", text: "×" });
        remove.type = "button";
        remove.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.manager.removeText(this.pageNumber, text.id);
        });
      }
    }
    if (editor && existingEditorParent !== this.textLayer) {
      this.textLayer.appendChild(editor);
    }
  }

  private onTextPointerDown(event: PointerEvent, text: TextAnnotation) {
    if (!this.manager.getEnabled() || this.manager.getTool() !== "text") return;
    if (!canDrawWithPointer(event, this.manager.prefersPenInput())) return;
    this.preferPenInput(event);
    event.preventDefault();
    event.stopPropagation();
    const rect = this.wrapper.getBoundingClientRect();
    this.textDrag = {
      id: text.id,
      startX: event.clientX,
      startY: event.clientY,
      origX: text.x,
      origY: text.y,
      moved: false,
    };
    this.beginDrawGestureGuard(event);
    this.capturePointer(event.pointerId);
    window.addEventListener("pointermove", this.onTextPointerMove);
    window.addEventListener("pointerup", this.onTextPointerUp);
  }

  private readonly onTextPointerMove = (event: PointerEvent) => {
    if (this.activeDrawPointerId !== null && event.pointerId !== this.activeDrawPointerId) return;
    if (!this.textDrag) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = this.wrapper.getBoundingClientRect();
    const dx = rect.width > 0 ? (event.clientX - this.textDrag.startX) / rect.width : 0;
    const dy = rect.height > 0 ? (event.clientY - this.textDrag.startY) / rect.height : 0;
    const x = Math.min(0.98, Math.max(0, this.textDrag.origX + dx));
    const y = Math.min(0.98, Math.max(0, this.textDrag.origY + dy));
    this.textDrag.moved = this.textDrag.moved || Math.abs(dx) + Math.abs(dy) > 0.004;
    void this.manager.updateText(this.pageNumber, this.textDrag.id, { x, y }, { save: false });
  };

  private readonly onTextPointerUp = (event: PointerEvent) => {
    if (this.activeDrawPointerId !== null && event.pointerId !== this.activeDrawPointerId) return;
    if (!this.textDrag) return;
    event.preventDefault();
    event.stopPropagation();
    const drag = this.textDrag;
    this.textDrag = null;
    window.removeEventListener("pointermove", this.onTextPointerMove);
    window.removeEventListener("pointerup", this.onTextPointerUp);
    this.releasePointer(event.pointerId);
    this.endDrawGestureGuard(event.pointerId);
    const text = this.manager.getPage(this.pageNumber).texts.find((item) => item.id === drag.id);
    if (!text) return;
    if (drag.moved) {
      void this.manager.save();
    } else {
      this.openTextEditor(text.x, text.y, text);
    }
  };

  private handleGuidePointerDown(event: PointerEvent, x: number, y: number) {
    const hit = this.hitGuide(x, y);
    if (!hit) {
      void this.manager.addGuide(this.pageNumber, x, y);
      return;
    }
    this.manager.selectGuide(this.pageNumber, hit.guide.id);
    if (hit.mode === "delete") {
      void this.manager.removeGuide(this.pageNumber, hit.guide.id);
      return;
    }
    if (hit.mode === "mirror-x") {
      void this.manager.updateGuide(this.pageNumber, hit.guide.id, { mirrorX: !hit.guide.mirrorX });
      return;
    }
    if (hit.mode === "mirror-y") {
      void this.manager.updateGuide(this.pageNumber, hit.guide.id, { mirrorY: !hit.guide.mirrorY });
      return;
    }
    if (hit.mode === "rotate") {
      this.guideDrag = {
        mode: "rotate",
        id: hit.guide.id,
        startAngle: this.guidePointerAngle(hit.guide, event),
        origRotation: hit.guide.rotation,
      };
    } else if (isGuideResizeMode(hit.mode)) {
      this.guideDrag = this.createGuideResizeDrag(hit.guide, hit.mode);
    } else {
      this.guideDrag = {
        mode: "move",
        id: hit.guide.id,
        startX: x,
        startY: y,
        origX: hit.guide.x,
        origY: hit.guide.y,
      };
    }
    this.beginDrawGestureGuard(event);
    this.capturePointer(event.pointerId);
    window.addEventListener("pointermove", this.onGuidePointerMove);
    window.addEventListener("pointerup", this.onGuidePointerUp);
  }

  private readonly onGuidePointerMove = (event: PointerEvent) => {
    if (this.activeDrawPointerId !== null && event.pointerId !== this.activeDrawPointerId) return;
    const drag = this.guideDrag;
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    const point = this.point(event);
    const guide = this.manager.getPage(this.pageNumber).guides.find((item) => item.id === drag.id);
    if (!guide) return;
    if (drag.mode === "rotate") {
      void this.rotateGuideFromPointer(guide, event, drag);
      return;
    }
    if (isGuideResizeMode(drag.mode)) {
      void this.resizeGuideFromPointer(guide, event, drag.mode);
      return;
    }
    if (drag.mode !== "move") return;
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    void this.manager.updateGuide(this.pageNumber, guide.id, {
      x: Math.min(1 - guide.width, Math.max(0, drag.origX + dx)),
      y: Math.min(1 - guide.height, Math.max(0, drag.origY + dy)),
    }, { save: false });
  };

  private readonly onGuidePointerUp = (event: PointerEvent) => {
    if (this.activeDrawPointerId !== null && event.pointerId !== this.activeDrawPointerId) return;
    if (!this.guideDrag) return;
    event.preventDefault();
    event.stopPropagation();
    this.guideDrag = null;
    window.removeEventListener("pointermove", this.onGuidePointerMove);
    window.removeEventListener("pointerup", this.onGuidePointerUp);
    this.releasePointer(event.pointerId);
    this.endDrawGestureGuard(event.pointerId);
    void this.manager.save();
  };

  private hitGuide(x: number, y: number): { guide: GuideAnnotation; mode: "move" | "delete" | "rotate" | GuideResizeMode | "mirror-x" | "mirror-y" } | null {
    const page = this.manager.getPage(this.pageNumber);
    const rect = this.wrapper.getBoundingClientRect();
    const px = x * rect.width;
    const py = y * rect.height;
    const near = (point: { x: number; y: number }) => Math.hypot(px - point.x, py - point.y) <= GUIDE_CONTROL_HIT_RADIUS;
    for (let i = page.guides.length - 1; i >= 0; i -= 1) {
      const guide = page.guides[i];
      const controls = guideControlPoints(guide, rect.width, rect.height);
      if (near(controls.delete)) return { guide, mode: "delete" };
      if (near(controls.rotate)) return { guide, mode: "rotate" };
      if (near(controls.resizeNW)) return { guide, mode: "resize-nw" };
      if (near(controls.resizeNE)) return { guide, mode: "resize-ne" };
      if (near(controls.resizeSE)) return { guide, mode: "resize-se" };
      if (near(controls.resizeSW)) return { guide, mode: "resize-sw" };
      if (near(controls.mirrorX)) return { guide, mode: "mirror-x" };
      if (near(controls.mirrorY)) return { guide, mode: "mirror-y" };
      const bounds = guideBounds(guide, rect.width, rect.height);
      const cx = bounds.x + bounds.w / 2;
      const cy = bounds.y + bounds.h / 2;
      const local = inverseRotatePoint(px, py, cx, cy, guide.rotation);
      const inside = Math.abs(local.x - cx) <= bounds.w / 2 + GUIDE_MOVE_HIT_SLOP
        && Math.abs(local.y - cy) <= bounds.h / 2 + GUIDE_MOVE_HIT_SLOP;
      if (inside) return { guide, mode: "move" };
    }
    return null;
  }

  private rotateGuideFromPointer(guide: GuideAnnotation, event: PointerEvent, drag: Extract<GuideDrag, { mode: "rotate" }>) {
    const rect = this.wrapper.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const angle = this.guidePointerAngle(guide, event);
    return this.manager.updateGuide(this.pageNumber, guide.id, {
      rotation: normalizeAngle(drag.origRotation + angle - drag.startAngle),
    }, { save: false });
  }

  private createGuideResizeDrag(guide: GuideAnnotation, mode: GuideResizeMode): Extract<GuideDrag, { mode: GuideResizeMode }> {
    const rect = this.wrapper.getBoundingClientRect();
    const bounds = guideBounds(guide, rect.width, rect.height);
    const cx = bounds.x + bounds.w / 2;
    const cy = bounds.y + bounds.h / 2;
    const xSign = mode.endsWith("e") ? 1 : -1;
    const ySign = mode.includes("s") ? 1 : -1;
    const anchor = rotatePoint(cx - xSign * bounds.w / 2, cy - ySign * bounds.h / 2, cx, cy, guide.rotation);
    return {
      mode,
      id: guide.id,
      anchorX: anchor.x,
      anchorY: anchor.y,
      xSign,
      ySign,
      rotation: guide.rotation,
    };
  }

  private resizeGuideFromPointer(guide: GuideAnnotation, event: PointerEvent, mode: GuideResizeMode) {
    const rect = this.wrapper.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const drag = this.guideDrag;
    if (!drag || drag.mode !== mode || !isGuideResizeMode(drag.mode)) return;
    const ux = { x: Math.cos(drag.rotation), y: Math.sin(drag.rotation) };
    const uy = { x: -Math.sin(drag.rotation), y: Math.cos(drag.rotation) };
    const dx = event.clientX - rect.left - drag.anchorX;
    const dy = event.clientY - rect.top - drag.anchorY;
    const projectedX = dx * ux.x + dy * ux.y;
    const projectedY = dx * uy.x + dy * uy.y;
    const minW = 48 / rect.width;
    const minH = 48 / rect.height;
    const width = Math.min(1, Math.max(minW, (drag.xSign * projectedX) / rect.width));
    const height = Math.min(1, Math.max(minH, (drag.ySign * projectedY) / rect.height));
    const centerPxX = drag.anchorX + (drag.xSign * width * rect.width * ux.x + drag.ySign * height * rect.height * uy.x) / 2;
    const centerPxY = drag.anchorY + (drag.xSign * width * rect.width * ux.y + drag.ySign * height * rect.height * uy.y) / 2;
    const centerX = Math.min(1, Math.max(0, centerPxX / rect.width));
    const centerY = Math.min(1, Math.max(0, centerPxY / rect.height));
    return this.manager.updateGuide(this.pageNumber, guide.id, {
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
    }, { save: false });
  }

  private guidePointerAngle(guide: GuideAnnotation, event: PointerEvent) {
    const rect = this.wrapper.getBoundingClientRect();
    const bounds = guideBounds(guide, rect.width, rect.height);
    const cx = rect.left + bounds.x + bounds.w / 2;
    const cy = rect.top + bounds.y + bounds.h / 2;
    return Math.atan2(event.clientY - cy, event.clientX - cx);
  }

  private hitSelectable(x: number, y: number): SelectedAnnotation | null {
    const page = this.manager.getPage(this.pageNumber);
    const rect = this.wrapper.getBoundingClientRect();
    const px = x * rect.width;
    const py = y * rect.height;
    for (let i = page.guides.length - 1; i >= 0; i -= 1) {
      const guide = page.guides[i];
      const bounds = guideBounds(guide, rect.width, rect.height);
      const cx = bounds.x + bounds.w / 2;
      const cy = bounds.y + bounds.h / 2;
      const local = inverseRotatePoint(px, py, cx, cy, guide.rotation);
      if (Math.abs(local.x - cx) <= bounds.w / 2 + GUIDE_MOVE_HIT_SLOP && Math.abs(local.y - cy) <= bounds.h / 2 + GUIDE_MOVE_HIT_SLOP) {
        return { page: this.pageNumber, type: "guide", id: guide.id };
      }
    }
    for (let i = page.texts.length - 1; i >= 0; i -= 1) {
      const text = page.texts[i];
      if (pointInRect({ x, y }, textBounds(text, rect.width, rect.height))) {
        return { page: this.pageNumber, type: "text", id: text.id };
      }
    }
    for (let i = page.strokes.length - 1; i >= 0; i -= 1) {
      const stroke = page.strokes[i];
      const hitRadius = Math.max(10, stroke.width + 6);
      if (strokeHit(stroke, px, py, hitRadius, rect.width, rect.height)) {
        return { page: this.pageNumber, type: "stroke", id: stroke.id };
      }
    }
    return null;
  }

  private itemsInSelection(box: SelectionBox): SelectedAnnotation[] {
    const page = this.manager.getPage(this.pageNumber);
    const rect = this.wrapper.getBoundingClientRect();
    const selection = normalizedRectFromPoints(box.start, box.current);
    const items: SelectedAnnotation[] = [];
    for (const stroke of page.strokes) {
      if (rectContainsRect(selection, strokeBounds(stroke))) items.push({ page: this.pageNumber, type: "stroke", id: stroke.id });
    }
    for (const text of page.texts) {
      if (rectContainsRect(selection, textBounds(text, rect.width, rect.height))) items.push({ page: this.pageNumber, type: "text", id: text.id });
    }
    for (const guide of page.guides) {
      if (rectContainsRect(selection, guideBoundsNormalized(guide, rect.width, rect.height))) items.push({ page: this.pageNumber, type: "guide", id: guide.id });
    }
    return items;
  }

  private drawSelectionFrames(pageWidth: number, pageHeight: number) {
    for (const item of this.manager.getSelection()) {
      if (item.page !== this.pageNumber || item.type === "guide") continue;
      const page = this.manager.getPage(this.pageNumber);
      const bounds = item.type === "stroke"
        ? strokeBounds(page.strokes.find((stroke) => stroke.id === item.id) ?? null)
        : textBounds(page.texts.find((text) => text.id === item.id) ?? null, pageWidth, pageHeight);
      if (!bounds) continue;
      drawSelectionRect(this.ctx, bounds, pageWidth, pageHeight);
    }
  }

  private openTextEditor(x: number, y: number, existing?: TextAnnotation) {
    if (this.finishTextEditor) this.finishTextEditor();
    else this.textEditor?.remove();
    this.finishTextEditor = null;
    const editor = document.createElement("div");
    editor.className = "pdf-art-native-text-editor";
    editor.dataset.textId = existing?.id ?? "";
    editor.style.left = `${x * 100}%`;
    editor.style.top = `${y * 100}%`;
    editor.style.width = `${(existing?.width ?? 0.28) * 100}%`;
    const isolate = (event: Event) => {
      event.stopPropagation();
    };
    for (const eventName of ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "click", "touchstart", "touchmove", "touchend"]) {
      editor.addEventListener(eventName, isolate);
    }

    const textarea = editor.createEl("textarea", { cls: "pdf-art-native-textarea" });
    textarea.placeholder = "输入文字";
    textarea.value = existing?.text ?? "";
    textarea.style.color = existing?.color ?? this.manager.getColor();
    textarea.style.fontSize = `${existing?.fontSize ?? this.manager.getWidth()}px`;
    const textId = existing?.id ?? null;
    const applyStyle = (style: { color: string; fontSize: number }) => {
      textarea.style.color = style.color;
      textarea.style.fontSize = `${style.fontSize}px`;
    };
    this.manager.beginTextEdit(this.pageNumber, textId, {
      color: existing?.color ?? this.manager.getColor(),
      fontSize: existing?.fontSize ?? this.manager.getWidth(),
    }, applyStyle);

    const actions = editor.createDiv({ cls: "pdf-art-native-text-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.type = "button";
    const ok = actions.createEl("button", { text: "确定" });
    ok.type = "button";
    ok.addClass("mod-cta");

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      editor.remove();
      if (this.textEditor === editor) this.textEditor = null;
      if (this.finishTextEditor === submit) this.finishTextEditor = null;
      this.manager.endTextEdit(this.pageNumber, textId);
      this.render();
    };
    const submit = () => {
      const value = textarea.value.trim();
      const wrapperWidth = this.wrapper.getBoundingClientRect().width;
      const editorWidth = editor.getBoundingClientRect().width;
      const width = wrapperWidth > 0 ? Math.min(0.9, Math.max(0.08, editorWidth / wrapperWidth)) : existing?.width ?? 0.28;
      if (existing) {
        void this.manager.updateText(this.pageNumber, existing.id, { text: value, width, color: this.manager.getColor(), fontSize: this.manager.getWidth() }).then(close);
      } else if (value) {
        void this.manager.addText(this.pageNumber, x, y, value, width).then(close);
      } else {
        close();
      }
    };
    this.finishTextEditor = submit;
    cancel.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
    });
    ok.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      submit();
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    this.textEditor = editor;
    this.textLayer.appendChild(editor);
    window.setTimeout(() => {
      if (!editor.isConnected) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 0);
  }

  private updateCursor(event: PointerEvent) {
    if (!this.manager.getEnabled() || !canDrawWithPointer(event, this.manager.prefersPenInput())) {
      this.hideCursor();
      return;
    }
    const rect = this.wrapper.getBoundingClientRect();
    this.updateCursorStyle();
    this.cursor.style.transform = `translate(${event.clientX - rect.left}px, ${event.clientY - rect.top}px) translate(-50%, -50%)`;
    this.cursor.addClass("is-visible");
  }

  private hideCursor() {
    this.cursor.removeClass("is-visible");
  }

  private updateCursorStyle() {
    const tool = this.manager.getTool();
    if (tool === "select") {
      this.cursor.style.width = "18px";
      this.cursor.style.height = "18px";
      this.cursor.style.color = "var(--interactive-accent)";
      this.cursor.style.borderColor = "var(--interactive-accent)";
      this.cursor.style.backgroundColor = "transparent";
      return;
    }
    const width = Math.max(1, tool === "text" ? 2 : this.manager.getWidth());
    const height = Math.max(1, tool === "text" ? this.manager.getWidth() : this.manager.getWidth());
    const color = tool === "eraser" ? "var(--text-muted)" : this.manager.getColor();
    this.cursor.style.width = `${width}px`;
    this.cursor.style.height = `${height}px`;
    this.cursor.style.color = color;
    this.cursor.style.borderColor = color;
    this.cursor.style.backgroundColor = tool === "text" ? color : tool === "highlighter" ? colorToRgba(this.manager.getColor(), 0.28) : "transparent";
  }

  private readonly blockActiveDrawCompatibilityGesture = (event: Event) => {
    if (this.activeDrawPointerId === null) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, input, textarea, select, a, [contenteditable='true']")) return;
    event.preventDefault();
    event.stopPropagation();
    if ("stopImmediatePropagation" in event) event.stopImmediatePropagation();
  };
}

export function canDrawWithPointer(event: PointerEvent, penInputPreferred = false): boolean {
  return event.pointerType === "pen"
    || event.pointerType === "mouse"
    || isStylusLikeTouch(event)
    || (event.pointerType === "touch" && !penInputPreferred);
}

export function isPenLikePointer(event: PointerEvent): boolean {
  return event.pointerType === "pen" || isStylusLikeTouch(event);
}

function isStylusLikeTouch(event: PointerEvent): boolean {
  if (event.pointerType !== "touch") return false;
  if (event.tiltX !== 0 || event.tiltY !== 0 || event.twist !== 0 || event.tangentialPressure !== 0) return true;
  const contactSize = Math.max(event.width || 0, event.height || 0);
  const hasPreciseContact = contactSize > 0 && contactSize <= TOUCH_STYLUS_MAX_CONTACT_SIZE;
  const hasRealPressure = event.pressure > 0 && event.pressure !== 0.5;
  return hasPreciseContact && hasRealPressure;
}

function colorToRgba(color: string, alpha: number): string {
  const hex = color.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(hex);
  if (short) {
    const [r, g, b] = short[1].split("").map((value) => parseInt(value + value, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const full = /^#([0-9a-f]{6})$/i.exec(hex);
  if (full) {
    const value = full[1];
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return "transparent";
}

function normalizeAngle(angle: number): number {
  const fullTurn = Math.PI * 2;
  const normalized = angle % fullTurn;
  return normalized < 0 ? normalized + fullTurn : normalized;
}

function isGuideResizeMode(mode: string): mode is GuideResizeMode {
  return mode === "resize-nw"
    || mode === "resize-ne"
    || mode === "resize-se"
    || mode === "resize-sw";
}

function inverseRotatePoint(x: number, y: number, cx: number, cy: number, angle: number) {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: cx + dx * cos + dy * sin,
    y: cy - dx * sin + dy * cos,
  };
}

function rotatePoint(x: number, y: number, cx: number, cy: number, angle: number) {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
}

function normalizedRectFromPoints(a: NormalizedPoint, b: NormalizedPoint): NormalizedRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function pointInRect(point: { x: number; y: number }, rect: NormalizedRect | null) {
  return Boolean(rect && point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h);
}

function rectContainsRect(outer: NormalizedRect, inner: NormalizedRect | null) {
  if (!inner) return false;
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w
    && inner.y + inner.h <= outer.y + outer.h;
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("button, input, textarea, select, a, [contenteditable='true'], .pdf-art-native-text-editor"));
}

function isTextAnnotationTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(".pdf-art-native-text-box"));
}

function strokeBounds(stroke: StrokeAnnotation | null): NormalizedRect | null {
  if (!stroke || stroke.points.length === 0) return null;
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const point of stroke.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const padding = Math.max(0.006, stroke.width / 1600);
  return {
    x: Math.max(0, minX - padding),
    y: Math.max(0, minY - padding),
    w: Math.min(1, maxX + padding) - Math.max(0, minX - padding),
    h: Math.min(1, maxY + padding) - Math.max(0, minY - padding),
  };
}

function textBounds(text: TextAnnotation | null, pageWidth: number, pageHeight: number): NormalizedRect | null {
  if (!text || pageWidth <= 0 || pageHeight <= 0) return null;
  const estimatedHeight = Math.max(text.fontSize * 1.6, 24) / pageHeight;
  return {
    x: text.x,
    y: text.y,
    w: text.width,
    h: Math.min(1 - text.y, estimatedHeight),
  };
}

function guideBoundsNormalized(guide: GuideAnnotation, pageWidth: number, pageHeight: number): NormalizedRect | null {
  if (pageWidth <= 0 || pageHeight <= 0) return null;
  const bounds = guideBounds(guide, pageWidth, pageHeight);
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const corners = [
    rotatePoint(bounds.x, bounds.y, cx, cy, guide.rotation),
    rotatePoint(bounds.x + bounds.w, bounds.y, cx, cy, guide.rotation),
    rotatePoint(bounds.x + bounds.w, bounds.y + bounds.h, cx, cy, guide.rotation),
    rotatePoint(bounds.x, bounds.y + bounds.h, cx, cy, guide.rotation),
  ];
  const minX = Math.min(...corners.map((point) => point.x)) / pageWidth;
  const minY = Math.min(...corners.map((point) => point.y)) / pageHeight;
  const maxX = Math.max(...corners.map((point) => point.x)) / pageWidth;
  const maxY = Math.max(...corners.map((point) => point.y)) / pageHeight;
  return { x: Math.max(0, minX), y: Math.max(0, minY), w: Math.min(1, maxX) - Math.max(0, minX), h: Math.min(1, maxY) - Math.max(0, minY) };
}

function strokeHit(stroke: StrokeAnnotation, px: number, py: number, radiusPx: number, pageWidth: number, pageHeight: number) {
  for (const point of stroke.points) {
    if (Math.hypot(point.x * pageWidth - px, point.y * pageHeight - py) <= radiusPx) return true;
  }
  return false;
}

function drawSelectionBox(ctx: CanvasRenderingContext2D, box: SelectionBox, pageWidth: number, pageHeight: number) {
  drawSelectionRect(ctx, normalizedRectFromPoints(box.start, box.current), pageWidth, pageHeight, true);
}

function drawSelectionRect(ctx: CanvasRenderingContext2D, rect: NormalizedRect, pageWidth: number, pageHeight: number, filled = false) {
  ctx.save();
  ctx.strokeStyle = "rgba(80, 160, 255, 0.95)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  if (filled) {
    ctx.fillStyle = "rgba(80, 160, 255, 0.12)";
    ctx.fillRect(rect.x * pageWidth, rect.y * pageHeight, rect.w * pageWidth, rect.h * pageHeight);
  }
  ctx.strokeRect(rect.x * pageWidth, rect.y * pageHeight, rect.w * pageWidth, rect.h * pageHeight);
  ctx.restore();
}

function createStroke(
  tool: "pen" | "highlighter" | "eraser",
  color: string,
  width: number,
  firstPoint: NormalizedPoint
): StrokeAnnotation {
  return {
    id: `stroke-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: tool === "highlighter" ? "highlighter" : "pen",
    points: [firstPoint],
    color,
    width,
    opacity: tool === "highlighter" ? 0.35 : 1,
  };
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: StrokeAnnotation, pageWidth: number, pageHeight: number) {
  if (stroke.points.length === 0) return;
  ctx.save();
  ctx.globalAlpha = stroke.opacity;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.beginPath();
  const first = stroke.points[0];
  ctx.moveTo(first.x * pageWidth, first.y * pageHeight);
  for (const point of stroke.points.slice(1)) {
    ctx.lineTo(point.x * pageWidth, point.y * pageHeight);
  }
  if (stroke.points.length === 1) {
    ctx.lineTo(first.x * pageWidth + 0.01, first.y * pageHeight + 0.01);
  }
  ctx.stroke();
  ctx.restore();
}

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: StrokeAnnotation[], pageWidth: number, pageHeight: number) {
  drawHighlighterStrokes(ctx, strokes.filter((stroke) => stroke.type === "highlighter"), pageWidth, pageHeight);
  for (const stroke of strokes) {
    if (stroke.type !== "highlighter") drawStroke(ctx, stroke, pageWidth, pageHeight);
  }
}

function drawHighlighterStrokes(ctx: CanvasRenderingContext2D, strokes: StrokeAnnotation[], pageWidth: number, pageHeight: number) {
  if (strokes.length === 0) return;
  const groups = new Map<string, StrokeAnnotation[]>();
  for (const stroke of strokes) {
    const key = `${stroke.color}|${stroke.opacity}`;
    const group = groups.get(key);
    if (group) group.push(stroke);
    else groups.set(key, [stroke]);
  }

  for (const group of groups.values()) {
    const first = group[0];
    const layer = document.createElement("canvas");
    const layerCtx = layer.getContext("2d");
    if (!layerCtx) continue;
    const dpr = window.devicePixelRatio || 1;
    layer.width = Math.max(1, Math.round(pageWidth * dpr));
    layer.height = Math.max(1, Math.round(pageHeight * dpr));
    layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layerCtx.globalAlpha = 1;
    for (const stroke of group) {
      drawStroke(layerCtx, { ...stroke, opacity: 1 }, pageWidth, pageHeight);
    }
    ctx.save();
    ctx.globalAlpha = first.opacity;
    ctx.drawImage(layer, 0, 0, pageWidth, pageHeight);
    ctx.restore();
  }
}
