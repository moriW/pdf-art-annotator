import { PenStroke } from "../types";

export type StrokeToolKind = "pen" | "highlighter";

function toScreenPoint(point: { x: number; y: number }, w: number, h: number) {
  return {
    x: point.x <= 1 ? point.x * w : point.x,
    y: point.y <= 1 ? point.y * h : point.y,
  };
}

export function canDrawWithPointer(event: PointerEvent) {
  return (
    event.pointerType === "pen" ||
    event.pointerType === "touch" ||
    (event.pointerType === "mouse" && event.button === 0)
  );
}

export function createStroke(
  tool: StrokeToolKind,
  color: string,
  width: number,
  point: { x: number; y: number; pressure: number },
): PenStroke {
  return {
    type: tool,
    color,
    width,
    opacity: tool === "highlighter" ? 0.3 : 1,
    points: [point],
  };
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: PenStroke, w: number, h: number) {
  if (stroke.points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = stroke.type === "highlighter" ? 0.3 : stroke.opacity ?? 1;
  ctx.beginPath();
  const first = toScreenPoint(stroke.points[0], w, h);
  ctx.moveTo(first.x, first.y);
  for (const point of stroke.points.slice(1)) {
    const p = toScreenPoint(point, w, h);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}
