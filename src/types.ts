/// <reference types="obsidian" />

import type { GuideAnnotation } from "./guides";

// 坐标全部保存为 0-1 的页面比例，而不是像素。
// 这样 PDF 缩放、不同屏幕 DPR、移动端宽度变化时，批注仍然贴在同一个页面位置。
export interface NormalizedPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface StrokeAnnotation {
  id: string;
  type: "pen" | "highlighter";
  points: NormalizedPoint[];
  color: string;
  width: number;
  opacity: number;
}

export interface TextAnnotation {
  id: string;
  x: number;
  y: number;
  width: number;
  text: string;
  color: string;
  fontSize: number;
}

export interface PageAnnotations {
  page: number;
  strokes: StrokeAnnotation[];
  texts: TextAnnotation[];
  guides: GuideAnnotation[];
}

export interface PDFAnnotationData {
  source: string;
  pages: PageAnnotations[];
  version: number;
}

export interface PDFArtSettings {
  defaultPenColor: string;
  defaultPenWidth: number;
  defaultHighlighterColor: string;
  defaultHighlighterWidth: number;
  defaultTextColor: string;
  defaultFontSize: number;
  eraserWidth: number;
  autoOpenPDF: boolean;
}

export const DEFAULT_SETTINGS: PDFArtSettings = {
  defaultPenColor: "#ff0000",
  defaultPenWidth: 3,
  defaultHighlighterColor: "#ffff00",
  defaultHighlighterWidth: 12,
  defaultTextColor: "#ff4444",
  defaultFontSize: 16,
  eraserWidth: 16,
  autoOpenPDF: true,
};
