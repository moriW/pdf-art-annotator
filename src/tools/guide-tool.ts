import { drawGuide, getGuideRenderRect, GuideState } from "../guides";
import type { GuideHitMode, NativePDFArtLeafState } from "../leaf-state";

const PHI = (1 + Math.sqrt(5)) / 2;
const MIN_GUIDE_SIZE = 0.05;

export type GuideDragState = {
  id: string;
  mode: GuideHitMode;
  startX: number;
  startY: number;
  rect: { x: number; y: number; w: number; h: number };
  aspect?: number;
};

export function drawGuideBox(
  ctx: CanvasRenderingContext2D,
  manager: NativePDFArtLeafState,
  guide: GuideState,
  w: number,
  h: number,
) {
  if (!guide.visible) return;
  const r = guide.rect ?? { x: 0, y: 0, w: 1, h: 1 };
  const x = r.x * w, y = r.y * h, gw = r.w * w, gh = r.h * h;
  const box = getGuideRenderRect(guide.type, x, y, gw, gh, guide.rotation);
  drawGuide(ctx, guide.type, x, y, gw, gh, {
    rotation: guide.rotation,
    strokeWidth: guide.strokeWidth,
    color: guide.color,
    mirrorX: guide.mirrorX,
    mirrorY: guide.mirrorY,
  });
  const selected = manager.getSelectedGuide()?.id === guide._id;
  ctx.save();
  ctx.strokeStyle = selected ? "rgba(80, 160, 255, 0.95)" : "rgba(255, 255, 255, 0.65)";
  ctx.lineWidth = selected ? 2 : 1;
  ctx.setLineDash(selected ? [] : [6, 4]);
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  drawGuideControls(ctx, box.x, box.y, box.w, box.h, guide);
  ctx.restore();
}

export function hitGuide(
  manager: NativePDFArtLeafState,
  wrapper: HTMLElement,
  pageNumber: number,
  nx: number,
  ny: number,
): { id: string; mode: GuideHitMode } | null {
  const page = manager.getPage(pageNumber);
  for (let i = page.guides.length - 1; i >= 0; i--) {
    const guide = page.guides[i];
    if (!guide._id || !guide.visible) continue;
    const r = getGuideInteractionRect(wrapper, guide);
    const hit = (x: number, y: number, radius = 0.025) => Math.hypot(nx - x, ny - y) <= radius;
    if (hit(r.x + r.w, r.y)) return { id: guide._id, mode: "delete" };
    if (hit(r.x, r.y + r.h)) return { id: guide._id, mode: "rotate" };
    if (hit(r.x + r.w / 2, r.y)) return { id: guide._id, mode: "mirror-x" };
    if (hit(r.x, r.y + r.h / 2)) return { id: guide._id, mode: "mirror-y" };
    if (hit(r.x, r.y)) return { id: guide._id, mode: "resize-tl" };
    if (hit(r.x + r.w, r.y + r.h)) return { id: guide._id, mode: "resize-br" };
    const nearBorder =
      nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h &&
      Math.min(Math.abs(nx - r.x), Math.abs(nx - r.x - r.w), Math.abs(ny - r.y), Math.abs(ny - r.y - r.h)) < 0.018;
    if (nearBorder) return { id: guide._id, mode: "move" };
  }
  return null;
}

export function getGuideInteractionRect(wrapper: HTMLElement, guide: GuideState) {
  const r = guide.rect ?? { x: 0, y: 0, w: 1, h: 1 };
  const pageRect = wrapper.getBoundingClientRect();
  if (pageRect.width <= 0 || pageRect.height <= 0) return r;
  const box = getGuideRenderRect(
    guide.type,
    r.x * pageRect.width,
    r.y * pageRect.height,
    r.w * pageRect.width,
    r.h * pageRect.height,
    guide.rotation,
  );
  return {
    x: box.x / pageRect.width,
    y: box.y / pageRect.height,
    w: box.w / pageRect.width,
    h: box.h / pageRect.height,
  };
}

export function getGoldenSpiralTargetAspect(guide: GuideState) {
  return (guide.rotation ?? 1) % 2 === 1 ? 1 / PHI : PHI;
}

export function updateGuideDragRect(drag: GuideDragState, x: number, y: number) {
  const dx = x - drag.startX;
  const dy = y - drag.startY;
  const r = { ...drag.rect };
  if (drag.mode === "move") {
    r.x = Math.min(1 - r.w, Math.max(0, r.x + dx));
    r.y = Math.min(1 - r.h, Math.max(0, r.y + dy));
  } else if (drag.mode === "resize-br") {
    if (drag.aspect) {
      resizeAspectFromBottomRight(r, x, y, drag.aspect);
    } else {
      r.w = Math.min(1 - r.x, Math.max(MIN_GUIDE_SIZE, r.w + dx));
      r.h = Math.min(1 - r.y, Math.max(MIN_GUIDE_SIZE, r.h + dy));
    }
  } else if (drag.mode === "resize-tl") {
    if (drag.aspect) {
      resizeAspectFromTopLeft(r, x, y, drag.aspect);
    } else {
      const nx = Math.min(r.x + r.w - MIN_GUIDE_SIZE, Math.max(0, r.x + dx));
      const ny = Math.min(r.y + r.h - MIN_GUIDE_SIZE, Math.max(0, r.y + dy));
      r.w = r.w + r.x - nx;
      r.h = r.h + r.y - ny;
      r.x = nx;
      r.y = ny;
    }
  }
  return r;
}

function resizeAspectFromBottomRight(
  r: { x: number; y: number; w: number; h: number },
  pointerX: number,
  pointerY: number,
  aspect: number,
) {
  const maxW = 1 - r.x;
  const maxH = 1 - r.y;
  const targetW = Math.min(maxW, Math.max(MIN_GUIDE_SIZE, pointerX - r.x));
  const targetH = Math.min(maxH, Math.max(MIN_GUIDE_SIZE, pointerY - r.y));
  applyAspectResize(r, targetW, targetH, maxW, maxH, aspect);
}

function resizeAspectFromTopLeft(
  r: { x: number; y: number; w: number; h: number },
  pointerX: number,
  pointerY: number,
  aspect: number,
) {
  const right = r.x + r.w;
  const bottom = r.y + r.h;
  const maxW = right;
  const maxH = bottom;
  const targetW = Math.min(maxW, Math.max(MIN_GUIDE_SIZE, right - pointerX));
  const targetH = Math.min(maxH, Math.max(MIN_GUIDE_SIZE, bottom - pointerY));
  applyAspectResize(r, targetW, targetH, maxW, maxH, aspect);
  r.x = right - r.w;
  r.y = bottom - r.h;
}

function applyAspectResize(
  r: { w: number; h: number },
  targetW: number,
  targetH: number,
  maxW: number,
  maxH: number,
  aspect: number,
) {
  let w = targetW;
  let h = w / aspect;
  if (h > targetH) {
    h = targetH;
    w = h * aspect;
  }
  if (w > maxW) {
    w = maxW;
    h = w / aspect;
  }
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  r.w = Math.max(MIN_GUIDE_SIZE, w);
  r.h = Math.max(MIN_GUIDE_SIZE, h);
}

function drawGuideControls(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, guide: GuideState) {
  const controls = [
    { x, y, label: "□", color: "#f2f2f2" },
    { x: x + w, y: y + h, label: "□", color: "#f2f2f2" },
    { x: x + w, y, label: "×", color: "#ff5a5a" },
    { x, y: y + h, label: "↻", color: "#55aaff" },
    { x: x + w / 2, y, label: "↔", color: guide.mirrorX ? "#46c578" : "#f2f2f2" },
    { x, y: y + h / 2, label: "↕", color: guide.mirrorY ? "#46c578" : "#f2f2f2" },
  ];
  ctx.setLineDash([]);
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const c of controls) {
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.stroke();
    ctx.fillStyle = "#111";
    ctx.fillText(c.label, c.x, c.y + 0.5);
  }
}
