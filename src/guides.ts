export type GuideType = "grid-9" | "grid-16" | "golden-ratio" | "golden-spiral";

export interface GuideAnnotation {
  id: string;
  type: GuideType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  mirrorX: boolean;
  mirrorY: boolean;
  color: string;
  strokeWidth: number;
}

const PHI = (1 + Math.sqrt(5)) / 2;
const INV_PHI = 1 / PHI;
const SELECTED_FRAME_HALO_WIDTH = 8;
const ROTATE_HANDLE_OFFSET = 36;
const ACTION_HANDLE_OFFSET = 30;

export function guideBounds(guide: GuideAnnotation, pageWidth: number, pageHeight: number) {
  return {
    x: guide.x * pageWidth,
    y: guide.y * pageHeight,
    w: guide.width * pageWidth,
    h: guide.height * pageHeight,
  };
}

export function guideControlPoints(guide: GuideAnnotation, pageWidth: number, pageHeight: number) {
  const bounds = guideBounds(guide, pageWidth, pageHeight);
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const localPoint = (x: number, y: number) => rotatePoint(cx + x, cy + y, cx, cy, guide.rotation);
  return {
    resizeNW: localPoint(-bounds.w / 2, -bounds.h / 2),
    resizeNE: localPoint(bounds.w / 2, -bounds.h / 2),
    resizeSE: localPoint(bounds.w / 2, bounds.h / 2),
    resizeSW: localPoint(-bounds.w / 2, bounds.h / 2),
    rotate: localPoint(0, -bounds.h / 2 - ROTATE_HANDLE_OFFSET),
    delete: localPoint(bounds.w / 2 + ACTION_HANDLE_OFFSET, -bounds.h / 2 - ACTION_HANDLE_OFFSET),
    mirrorX: localPoint(-ACTION_HANDLE_OFFSET / 1.5, -bounds.h / 2 - ACTION_HANDLE_OFFSET),
    mirrorY: localPoint(ACTION_HANDLE_OFFSET / 1.5, -bounds.h / 2 - ACTION_HANDLE_OFFSET),
  };
}

export function drawGuide(ctx: CanvasRenderingContext2D, guide: GuideAnnotation, pageWidth: number, pageHeight: number, selected: boolean) {
  const bounds = guideBounds(guide, pageWidth, pageHeight);
  if (bounds.w <= 1 || bounds.h <= 1) return;

  ctx.save();
  ctx.translate(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2);
  ctx.rotate(guide.rotation);
  ctx.scale(guide.mirrorX ? -1 : 1, guide.mirrorY ? -1 : 1);
  ctx.translate(-bounds.w / 2, -bounds.h / 2);
  ctx.strokeStyle = withAlpha(guide.color, 0.76);
  ctx.fillStyle = withAlpha(guide.color, 0.9);
  ctx.lineWidth = Math.max(1, guide.strokeWidth);
  ctx.setLineDash([5, 4]);

  if (guide.type === "grid-9") drawGrid(ctx, bounds.w, bounds.h, 3, 3);
  else if (guide.type === "grid-16") drawGrid(ctx, bounds.w, bounds.h, 4, 4);
  else if (guide.type === "golden-ratio") drawGoldenRatio(ctx, bounds.w, bounds.h);
  else drawGoldenSpiral(ctx, bounds.w, bounds.h);

  ctx.restore();
  drawGuideFrame(ctx, bounds, selected, guide, pageWidth, pageHeight);
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, cols: number, rows: number) {
  ctx.beginPath();
  for (let col = 1; col < cols; col += 1) {
    const x = (w * col) / cols;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let row = 1; row < rows; row += 1) {
    const y = (h * row) / rows;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

function drawGoldenRatio(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const x1 = w * INV_PHI;
  const x2 = w * (1 - INV_PHI);
  const y1 = h * INV_PHI;
  const y2 = h * (1 - INV_PHI);
  ctx.beginPath();
  ctx.moveTo(x1, 0); ctx.lineTo(x1, h);
  ctx.moveTo(x2, 0); ctx.lineTo(x2, h);
  ctx.moveTo(0, y1); ctx.lineTo(w, y1);
  ctx.moveTo(0, y2); ctx.lineTo(w, y2);
  ctx.stroke();
  for (const [x, y] of [[x1, y1], [x1, y2], [x2, y1], [x2, y2]]) {
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawGoldenSpiral(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const fitted = fitAspect(w, h, PHI);
  ctx.translate(fitted.x, fitted.y);
  w = fitted.w;
  h = fitted.h;

  const squares = goldenSpiralSquares(w, h);
  ctx.beginPath();
  ctx.setLineDash([5, 4]);
  for (const square of squares.slice(0, 9)) {
    ctx.rect(square.x, square.y, square.size, square.size);
  }
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.lineWidth *= 1.45;
  for (const square of squares) {
    const { x, y, size } = square;
    let cx = x;
    let cy = y;
    let start = 0;
    let end = 0;
    if (square.side === "left") {
      cx = x + size; cy = y + size; start = Math.PI; end = Math.PI * 1.5;
    } else if (square.side === "top") {
      cx = x; cy = y + size; start = Math.PI * 1.5; end = Math.PI * 2;
    } else if (square.side === "right") {
      cx = x; cy = y; start = 0; end = Math.PI / 2;
    } else {
      cx = x + size; cy = y; start = Math.PI / 2; end = Math.PI;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, size, start, end);
    ctx.stroke();
  }
}

function goldenSpiralSquares(w: number, h: number) {
  const squares: Array<{ x: number; y: number; size: number; side: "left" | "top" | "right" | "bottom" }> = [];
  let rect = { x: 0, y: 0, w, h };
  const sides: Array<"left" | "top" | "right" | "bottom"> = ["left", "top", "right", "bottom"];
  for (let i = 0; i < 13 && rect.w > 2 && rect.h > 2; i += 1) {
    const side = sides[i % sides.length];
    if (side === "left") {
      const size = rect.h;
      squares.push({ x: rect.x, y: rect.y, size, side });
      rect = { x: rect.x + size, y: rect.y, w: rect.w - size, h: rect.h };
    } else if (side === "top") {
      const size = rect.w;
      squares.push({ x: rect.x, y: rect.y, size, side });
      rect = { x: rect.x, y: rect.y + size, w: rect.w, h: rect.h - size };
    } else if (side === "right") {
      const size = rect.h;
      squares.push({ x: rect.x + rect.w - size, y: rect.y, size, side });
      rect = { x: rect.x, y: rect.y, w: rect.w - size, h: rect.h };
    } else {
      const size = rect.w;
      squares.push({ x: rect.x, y: rect.y + rect.h - size, size, side });
      rect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h - size };
    }
  }
  return squares;
}

function drawGuideFrame(
  ctx: CanvasRenderingContext2D,
  bounds: { x: number; y: number; w: number; h: number },
  selected: boolean,
  guide: GuideAnnotation,
  pageWidth: number,
  pageHeight: number
) {
  ctx.save();
  ctx.translate(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2);
  ctx.rotate(guide.rotation);
  ctx.translate(-bounds.w / 2, -bounds.h / 2);
  if (selected) {
    ctx.strokeStyle = "rgba(80, 160, 255, 0.18)";
    ctx.lineWidth = SELECTED_FRAME_HALO_WIDTH;
    ctx.setLineDash([]);
    ctx.strokeRect(0, 0, bounds.w, bounds.h);
  }
  ctx.strokeStyle = selected ? "rgba(80, 160, 255, 0.95)" : "rgba(255, 255, 255, 0.58)";
  ctx.lineWidth = selected ? 2 : 1;
  ctx.setLineDash(selected ? [] : [6, 4]);
  ctx.strokeRect(0, 0, bounds.w, bounds.h);
  ctx.restore();
  if (selected) drawControls(ctx, guide, pageWidth, pageHeight);
}

function drawControls(ctx: CanvasRenderingContext2D, guide: GuideAnnotation, pageWidth: number, pageHeight: number) {
  const controls = guideControlPoints(guide, pageWidth, pageHeight);
  const resizeHandles = [
    controls.resizeNW,
    controls.resizeNE,
    controls.resizeSE,
    controls.resizeSW,
  ];
  const actionItems = [
    { ...controls.delete, label: "x", color: "#ff6b6b" },
    { ...controls.mirrorX, label: "↔", color: guide.mirrorX ? "#4fc878" : "#f2f2f2" },
    { ...controls.mirrorY, label: "↕", color: guide.mirrorY ? "#4fc878" : "#f2f2f2" },
  ];
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(80, 160, 255, 0.75)";
  ctx.lineWidth = 1.5;
  const top = rotatePoint(pageWidth * (guide.x + guide.width / 2), pageHeight * guide.y, pageWidth * (guide.x + guide.width / 2), pageHeight * (guide.y + guide.height / 2), guide.rotation);
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(controls.rotate.x, controls.rotate.y);
  ctx.stroke();

  for (const handle of resizeHandles) {
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(38, 119, 255, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(handle.x - 5, handle.y - 5, 10, 10);
    ctx.fill();
    ctx.stroke();
  }

  ctx.fillStyle = "#f8fbff";
  ctx.strokeStyle = "rgba(38, 119, 255, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(controls.rotate.x, controls.rotate.y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const control of actionItems) {
    ctx.fillStyle = control.color;
    ctx.beginPath();
    ctx.arc(control.x, control.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
    ctx.stroke();
    ctx.fillStyle = "#111";
    ctx.fillText(control.label, control.x, control.y + 0.5);
  }
  ctx.restore();
}

function fitAspect(w: number, h: number, aspect: number) {
  let fittedW = w;
  let fittedH = h;
  if (w / h > aspect) fittedW = h * aspect;
  else fittedH = w / aspect;
  return { x: (w - fittedW) / 2, y: (h - fittedH) / 2, w: fittedW, h: fittedH };
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

function withAlpha(color: string, alpha: number) {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return `rgba(255, 255, 255, ${alpha})`;
  const value = match[1];
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
