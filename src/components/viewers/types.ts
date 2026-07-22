import type { ReactNode } from 'react'
import type { DocumentProps } from 'react-pdf'

export type PdfSource = NonNullable<DocumentProps['file']>

export type PdfFitMode = 'width' | 'page' | 'custom'

export interface PdfViewerReadingState {
  page: number
  scale: number
  fit: PdfFitMode
  scrollTop: number
  visiblePages: number[]
}

export interface PdfSelectionRect {
  /** Position relative to the rendered page, expressed as a value from 0 to 1. */
  left: number
  top: number
  width: number
  height: number
}

export interface PdfTextSelection {
  page: number
  text: string
  rects: PdfSelectionRect[]
}

export type PdfAnnotationKind = 'highlight' | 'comment' | 'bookmark'
export type PdfAnnotationColor = 'amber' | 'mint' | 'blue' | 'rose'

export interface PdfViewerAnnotation {
  id: string
  page: number
  kind: PdfAnnotationKind
  quote?: string
  comment?: string
  color?: PdfAnnotationColor
}

export interface PdfViewerContext {
  page: number
  visiblePages: number[]
  pageText: string
  adjacentText: string
  selection?: PdfTextSelection
  readable: boolean
}

export interface PdfViewerProps {
  file: PdfSource
  filePath?: string
  sourceModifiedAt?: number
  sourceSize?: number
  fileName?: string
  className?: string
  annotations?: readonly PdfViewerAnnotation[]
  initialReadingState?: Partial<PdfViewerReadingState>
  /** Optional controlled state. Page and zoom changes are reflected when these values change. */
  readingState?: Partial<PdfViewerReadingState>
  virtualizationOverscan?: number
  onReadingStateChange?: (state: PdfViewerReadingState) => void
  onContextChange?: (context: PdfViewerContext) => void
  onSelectionChange?: (selection: PdfTextSelection | null) => void
  onCreateHighlight?: (selection: PdfTextSelection, color: PdfAnnotationColor) => void
  onCreateComment?: (selection: PdfTextSelection) => void
  onToggleBookmark?: (page: number, bookmarked: boolean) => void
  onAnnotationOpen?: (annotation: PdfViewerAnnotation) => void
  onError?: (error: Error) => void
}

export type MarkdownViewMode = 'edit' | 'preview' | 'both'
export type MarkdownSaveReason = 'auto' | 'manual' | 'conflict-overwrite'

export interface MarkdownSaveRequest {
  content: string
  reason: MarkdownSaveReason
  expectedModifiedAt?: number
}

export interface MarkdownExternalChange {
  content: string
  modifiedAt: number
}

export type MarkdownConflictResolution = 'use-external' | 'keep-local'

export interface MarkdownOutlineItem {
  id: string
  text: string
  level: number
  offset: number
}

export interface MarkdownViewerContext {
  mode: MarkdownViewMode
  cursor: number
  selection: string
  heading?: MarkdownOutlineItem
  visibleText: string
  sectionText: string
  documentText: string
}

export interface MarkdownViewerReadingState {
  mode: MarkdownViewMode
  cursor: number
  scrollTop: number
}

export interface MarkdownViewerProps {
  value: string
  /** Stable identity for tab reuse. Prefer the absolute project-relative file path. */
  documentId?: string
  fileName?: string
  className?: string
  readOnly?: boolean
  mode?: MarkdownViewMode
  defaultMode?: MarkdownViewMode
  autoSave?: boolean
  autoSaveDelayMs?: number
  modifiedAt?: number
  externalChange?: MarkdownExternalChange | null
  resolveAssetUrl?: (url: string) => string
  onOpenLink?: (url: string) => void
  onChange?: (content: string) => void
  onSave?: (request: MarkdownSaveRequest) => void | Promise<void>
  onModeChange?: (mode: MarkdownViewMode) => void
  onContextChange?: (context: MarkdownViewerContext) => void
  onReadingStateChange?: (state: MarkdownViewerReadingState) => void
  onResolveExternalChange?: (
    resolution: MarkdownConflictResolution,
    change: MarkdownExternalChange,
    localContent: string,
  ) => void
  onError?: (error: Error) => void
}

export interface ImageViewerState {
  scale: number
  rotation: 0 | 90 | 180 | 270
  fit: boolean
}

export interface ImageViewerProps {
  src: string
  filePath?: string
  sourceModifiedAt?: number
  sourceSize?: number
  alt?: string
  fileName?: string
  className?: string
  initialState?: Partial<ImageViewerState>
  onStateChange?: (state: ImageViewerState) => void
  onLoad?: (naturalSize: { width: number; height: number }) => void
  onError?: (error: Error) => void
  onOpenExternal?: () => void
  onOcrTextChange?: (text: string) => void
}

export interface DocxViewerContext {
  selection: string
  visibleText: string
  documentText: string
}

export interface DocxViewerProps {
  html: string
  text: string
  fileName?: string
  warnings?: readonly string[]
  onContextChange?: (context: DocxViewerContext) => void
  onOpenLink?: (url: string) => void
  onOpenExternal?: () => void
}

export interface PptxViewerContext {
  selection: string
  visibleText: string
  documentText: string
  slide: number
}

export interface PptxViewerProps {
  src: string
  text: string
  fileName?: string
  onContextChange?: (context: PptxViewerContext) => void
  onOpenExternal?: () => void
  onError?: (error: Error) => void
}

export interface TextViewerContext {
  selection: string
  selectionStart: number
  selectionEnd: number
  visibleText: string
}

export interface TextViewerProps {
  content: string
  fileName?: string
  className?: string
  language?: string
  wrap?: boolean
  onWrapChange?: (wrap: boolean) => void
  onContextChange?: (context: TextViewerContext) => void
}

export interface UnsupportedViewerProps {
  fileName?: string
  extension?: string
  className?: string
  detail?: ReactNode
  onReveal?: () => void
  onOpenExternal?: () => void
  onConvertToPdf?: () => void | Promise<void>
}
