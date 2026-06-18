import { PenStroke } from "./types";
import { GuideRotation, GuideType } from "./guides";
import type { NativePDFArtLeafState } from "./leaf-state";
import { ERASER_RADIUS_DIVISOR, eraseAlongPath } from "./tools/eraser-tool";
import {
  drawGuideBox,
  getGoldenSpiralTargetAspect,
  getGuideInteractionRect,
  GuideDragState,
  hitGuide,
  updateGuideDragRect,
} from "./tools/guide-tool";
import { canDrawWithPointer, createStroke, drawStroke } from "./tools/stroke-tool";
import { NativeTextTool, TEXT_DRAG_THRESHOLD } from "./tools/text-tool";

// ── Constants ──

export const ACTIVE_DRAW_GESTURE_EVENTS = [
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "gesturestart",
  "gesturechange",
  "gestureend",
  "contextmenu",
] as const;
export const NON_PASSIVE_CAPTURE: AddEventListenerOptions = { capture: true, passive: false };

// ── Page overlay ──

export class NativePageOverlay {
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private resizeObserver: ResizeObserver;
  private previousPosition = "";
  private currentStroke: PenStroke | null = null;
  private guideDrag: GuideDragState | null = null;
  private textDrag: { index: number; startX: number; startY: number; origX: number; origY: number; moved: boolean } | null = null;
  private eraserDrag: { radius: number; lastX: number; lastY: number; changed: boolean } | null = null;
  private textTool: NativeTextTool;
  private activeDrawPointerId: number | null = null;
  private activeDrawGestureGuardInstalled = false;

  constructor(
    private readonly manager: NativePDFArtLeafState,
    private readonly pageNumber: number,
    private readonly wrapper: HTMLElement
  ) {
    this.textTool = new NativeTextTool(this.ctx, this.wrapper, this.manager, this.pageNumber, () => this.getPageWidth());
    this.canvas.className = "pdf-art-native-overlay";
    this.previousPosition = wrapper.style.position;
    if (getComputedStyle(wrapper).position === "static") wrapper.style.position = "relative";
    wrapper.appendChild(this.canvas);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("dblclick", this.onDoubleClick);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(wrapper);
    this.resize();
  }

  usesWrapper(wrapper: HTMLElement) { return this.wrapper === wrapper; }

  getPageWidth() {
    return this.wrapper.getBoundingClientRect().width;
  }

  closeTextEditor() {
    this.textTool.closeEditor();
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
    // Always clean up window-level gesture guards, even if state flags are inconsistent
    for (const eventName of ACTIVE_DRAW_GESTURE_EVENTS) {
      window.removeEventListener(eventName, this.blockActiveDrawCompatibilityGesture, NON_PASSIVE_CAPTURE);
    }
    this.activeDrawPointerId = null;
    this.activeDrawGestureGuardInstalled = false;
    this.closeTextEditor();
    this.canvas.remove();
    this.wrapper.style.position = this.previousPosition;
  }

  refreshState() {
    this.canvas.toggleClass("is-enabled", this.manager.getEnabled());
    this.canvas.dataset.tool = this.manager.getTool();
  }

  render() {
    const rect = this.wrapper.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    this.ctx.clearRect(0, 0, w, h);
    const page = this.manager.getPage(this.pageNumber);
    page.items.forEach((item, index) => {
      if (item.type === "text") this.textTool.drawText(item, w, h, index);
      else drawStroke(this.ctx, item, w, h);
    });
    if (this.currentStroke) drawStroke(this.ctx, this.currentStroke, w, h);
    for (const guide of page.guides) drawGuideBox(this.ctx, this.manager, guide, w, h);
  }

  private resize() {
    const rect = this.wrapper.getBoundingClientRect();
    this.textTool.updateBaseWidth(rect.width);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  private point(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      pressure: event.pressure || 0.5,
    };
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (!this.manager.getEnabled()) return;
    if (event.pointerType === "touch") return;
    const p = this.point(event);
    const tool = this.manager.getTool();
    const guideHit = hitGuide(this.manager, this.wrapper, this.pageNumber, p.x, p.y);
    if (guideHit) {
      event.preventDefault();
      event.stopPropagation();
      this.manager.selectGuide(this.pageNumber, guideHit.id);
      const page = this.manager.getPage(this.pageNumber);
      const guide = page.guides.find((g) => g._id === guideHit.id);
      if (!guide) return;
      if (guideHit.mode === "delete") {
        void this.manager.removeGuide(this.pageNumber, guideHit.id);
        return;
      }
      if (guideHit.mode === "rotate") {
        const rotation = (((guide.rotation ?? 1) + 1) % 4) as GuideRotation;
        void this.manager.updateGuide(this.pageNumber, guideHit.id, { rotation });
        return;
      }
      if (guideHit.mode === "mirror-x") {
        void this.manager.updateGuide(this.pageNumber, guideHit.id, { mirrorX: !guide.mirrorX });
        return;
      }
      if (guideHit.mode === "mirror-y") {
        void this.manager.updateGuide(this.pageNumber, guideHit.id, { mirrorY: !guide.mirrorY });
        return;
      }
      const rect = getGuideInteractionRect(this.wrapper, guide);
      const pageRect = this.wrapper.getBoundingClientRect();
      const aspect = guide.type === "golden-spiral" && pageRect.width > 0
        ? getGoldenSpiralTargetAspect(guide) * (pageRect.height / pageRect.width)
        : undefined;
      this.guideDrag = { id: guideHit.id, mode: guideHit.mode, startX: p.x, startY: p.y, rect, aspect };
      this.beginDrawGestureGuard(event);
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }

    if (tool === "text") {
      event.preventDefault();
      event.stopPropagation();
      const textHit = this.textTool.hitText(p.x, p.y);
      if (textHit) {
        if (textHit.mode === "delete") {
          void this.manager.removeText(this.pageNumber, textHit.index);
          return;
        }
        const item = this.manager.getPage(this.pageNumber).items[textHit.index];
        if (item?.type === "text") {
          this.manager.selectText(this.pageNumber, textHit.index);
          this.textDrag = { index: textHit.index, startX: p.x, startY: p.y, origX: item.x, origY: item.y, moved: false };
          this.beginDrawGestureGuard(event);
          this.canvas.setPointerCapture(event.pointerId);
          return;
        }
      }
      this.textTool.openEditor(p.x, p.y);
      return;
    }
    if (tool === "eraser") {
      if (!canDrawWithPointer(event)) return;
      event.preventDefault();
      event.stopPropagation();
      this.eraserDrag = { radius: this.manager.getWidth() / ERASER_RADIUS_DIVISOR, lastX: p.x, lastY: p.y, changed: true };
      this.beginDrawGestureGuard(event);
      this.canvas.setPointerCapture(event.pointerId);
      const eraserRect = this.wrapper.getBoundingClientRect();
      void this.manager.eraseAt(this.pageNumber, p.x, p.y, this.eraserDrag.radius, { save: false, pageWidth: eraserRect.width, pageHeight: eraserRect.height });
      return;
    }
    if (tool === "guide") {
      if (!canDrawWithPointer(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void this.manager.addGuide(this.pageNumber, p.x, p.y);
      return;
    }

    if (!canDrawWithPointer(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.currentStroke = createStroke(tool === "highlighter" ? "highlighter" : "pen", this.manager.getColor(), this.manager.getWidth(), p);
    this.beginDrawGestureGuard(event);
    this.canvas.setPointerCapture(event.pointerId);
    this.render();
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.activeDrawPointerId !== null && event.pointerId !== this.activeDrawPointerId) return;
    const p = this.point(event);
    if (this.guideDrag) {
      event.preventDefault();
      event.stopPropagation();
      const r = updateGuideDragRect(this.guideDrag, p.x, p.y);
      void this.manager.updateGuide(this.pageNumber, this.guideDrag.id, { rect: r }, { save: false });
      return;
    }
    if (this.textDrag) {
      event.preventDefault();
      event.stopPropagation();
      const dx = p.x - this.textDrag.startX;
      const dy = p.y - this.textDrag.startY;
      const item = this.manager.getPage(this.pageNumber).items[this.textDrag.index];
      if (item?.type === "text") {
        item.x = Math.min(0.98, Math.max(0, this.textDrag.origX + dx));
        item.y = Math.min(0.98, Math.max(0, this.textDrag.origY + dy));
        this.textDrag.moved = this.textDrag.moved || Math.abs(dx) + Math.abs(dy) > TEXT_DRAG_THRESHOLD;
        this.render();
      }
      return;
    }
    if (this.eraserDrag) {
      event.preventDefault();
      event.stopPropagation();
      this.eraserDrag.changed = true;
      eraseAlongPath(this.manager, this.pageNumber, this.wrapper, this.eraserDrag.lastX, this.eraserDrag.lastY, p.x, p.y, this.eraserDrag.radius);
      this.eraserDrag.lastX = p.x;
      this.eraserDrag.lastY = p.y;
      return;
    }
    if (!this.currentStroke) return;
    event.preventDefault();
    event.stopPropagation();
    this.currentStroke.points.push(p);
    this.render();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.activeDrawPointerId !== null && event.pointerId !== this.activeDrawPointerId) return;
    if (this.guideDrag) {
      event.preventDefault();
      event.stopPropagation();
      try { this.canvas.releasePointerCapture(event.pointerId); } catch {}
      void this.manager.save();
      this.guideDrag = null;
      this.endDrawGestureGuard(event.pointerId);
      return;
    }
    if (this.textDrag) {
      event.preventDefault();
      event.stopPropagation();
      try { this.canvas.releasePointerCapture(event.pointerId); } catch {}
      if (this.textDrag.moved) void this.manager.save();
      this.textDrag = null;
      this.endDrawGestureGuard(event.pointerId);
      this.render();
      return;
    }
    if (this.eraserDrag) {
      event.preventDefault();
      event.stopPropagation();
      try { this.canvas.releasePointerCapture(event.pointerId); } catch {}
      if (this.eraserDrag.changed) void this.manager.save();
      this.eraserDrag = null;
      this.endDrawGestureGuard(event.pointerId);
      return;
    }
    if (!this.currentStroke) return;
    event.preventDefault();
    event.stopPropagation();
    try { this.canvas.releasePointerCapture(event.pointerId); } catch {}
    const stroke = this.currentStroke;
    this.currentStroke = null;
    this.endDrawGestureGuard(event.pointerId);
    void this.manager.addStroke(this.pageNumber, stroke);
    this.render();
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

  private readonly blockActiveDrawCompatibilityGesture = (event: Event) => {
    if (this.activeDrawPointerId === null) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".pdf-art-native-text-editor, button, input, textarea, select, a, [contenteditable='true']")) return;
    event.preventDefault();
    event.stopPropagation();
    if ("stopImmediatePropagation" in event) event.stopImmediatePropagation();
  };

  private readonly onDoubleClick = (event: MouseEvent) => {
    this.textTool.handleDoubleClick(event, this.canvas);
  };
}
