import type { NativePDFArtLeafState } from "../leaf-state";

export const ERASER_RADIUS_DIVISOR = 320;

// 擦除拖动时按路径补点，避免快速滑动时只擦到离散的 pointermove 位置。
export function eraseAlongPath(
  manager: NativePDFArtLeafState,
  pageNumber: number,
  wrapper: HTMLElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  radius: number,
) {
  const distance = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(1, Math.ceil(distance / Math.max(radius * 0.5, 0.002)));
  const eraserRect = wrapper.getBoundingClientRect();
  const pw = eraserRect.width;
  const ph = eraserRect.height;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    manager.eraseAt(
      pageNumber,
      x1 + (x2 - x1) * t,
      y1 + (y2 - y1) * t,
      radius,
      { save: false, pageWidth: pw, pageHeight: ph }
    );
  }
}
