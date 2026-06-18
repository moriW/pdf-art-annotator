/// <reference types="obsidian" />

import type { GuideState } from "./guides";

// ── Data Types ──

export interface GuideRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PenStroke {
  type: "pen" | "highlighter";
  points: { x: number; y: number; pressure: number }[];
  color: string;
  width: number;
  opacity: number;
}

export interface TextAnnotation {
  type: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fontSizeRatio?: number;
  color: string;
  width: number;
}

export type AnnotationItem = PenStroke | TextAnnotation;

export interface PageAnnotations {
  page: number;
  items: AnnotationItem[];
  guides: GuideState[];
}

export interface PDFAnnotationData {
  source: string;
  pages: PageAnnotations[];
  version: number;
}

// ── Settings ──

export interface PDFArtSettings {
  defaultPenColor: string;
  defaultPenWidth: number;
  defaultHighlighterColor: string;
  defaultHighlighterWidth: number;
  defaultFontSize: number;
  defaultTextColor: string;
  annotationFolder: string;
  /** When enabled, opening a PDF from the file explorer automatically opens it in the annotator */
  autoOpenPDF: boolean;
}

export const DEFAULT_SETTINGS: PDFArtSettings = {
  defaultPenColor: "#ff0000",
  defaultPenWidth: 3,
  defaultHighlighterColor: "#ffff00",
  defaultHighlighterWidth: 12,
  defaultFontSize: 16,
  defaultTextColor: "#ff4444",
  annotationFolder: "",
  autoOpenPDF: true,
};
