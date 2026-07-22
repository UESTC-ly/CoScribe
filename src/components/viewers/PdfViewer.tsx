import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Bookmark,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  FileWarning,
  Highlighter,
  ListTree,
  MessageSquareText,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  ScanText,
  Sparkles,
  X,
} from 'lucide-react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import { rasterizeCanvas } from '../../lib/local-ocr'
import { cx, IconButton, ToolbarDivider, ViewerNotice, ViewerSpinner } from './ViewerChrome'
import { OcrPanel } from './OcrPanel'
import type {
  PdfAnnotationColor,
  PdfFitMode,
  PdfTextSelection,
  PdfViewerAnnotation,
  PdfViewerContext,
  PdfViewerProps,
  PdfViewerReadingState,
} from './types'
import { useOcrSession } from './useOcrSession'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  // react-pdf pins its own pdf.js version. Point at that matching worker rather
  // than the app's direct pdfjs-dist dependency, whose protocol may differ.
  'react-pdf/node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const DEFAULT_PAGE_WIDTH = 720
const DEFAULT_PAGE_RATIO = 1.414
const PAGE_GAP = 24
const MIN_SCALE = 0.4
const MAX_SCALE = 3
const THUMBNAIL_ROW_HEIGHT = 158
const HIGHLIGHT_COLORS: readonly PdfAnnotationColor[] = ['amber', 'mint', 'blue', 'rose']

type SidebarPanel = 'thumbnails' | 'outline' | 'search'

interface PdfOutlineNode {
  title: string
  page: number | null
  depth: number
  id: string
}

interface RawOutlineNode {
  title?: string
  dest?: string | unknown[] | null
  items?: RawOutlineNode[]
}

interface PdfDocumentLike {
  numPages: number
  getPage: (page: number) => Promise<{
    getTextContent: () => Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>
  }>
  getOutline: () => Promise<RawOutlineNode[] | null>
  getDestination: (name: string) => Promise<unknown[] | null>
  getPageIndex: (ref: never) => Promise<number>
}

interface PageGeometry {
  offsets: number[]
  heights: number[]
  totalHeight: number
}

interface PdfSearchResult {
  page: number
  count: number
  excerpt: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function countOccurrences(text: string, query: string): number {
  if (!query) return 0
  const normalizedText = text.toLocaleLowerCase()
  const normalizedQuery = query.toLocaleLowerCase()
  let cursor = 0
  let count = 0
  while ((cursor = normalizedText.indexOf(normalizedQuery, cursor)) !== -1) {
    count += 1
    cursor += Math.max(1, normalizedQuery.length)
  }
  return count
}

function makeExcerpt(text: string, query: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const index = clean.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (index === -1) return clean.slice(0, 120)
  const start = Math.max(0, index - 42)
  const end = Math.min(clean.length, index + query.length + 72)
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`
}

function computeGeometry(
  numPages: number,
  pageWidth: number,
  pageRatios: Readonly<Record<number, number>>,
): PageGeometry {
  const offsets: number[] = []
  const heights: number[] = []
  let cursor = PAGE_GAP
  for (let page = 1; page <= numPages; page += 1) {
    const height = pageWidth * (pageRatios[page] ?? DEFAULT_PAGE_RATIO)
    offsets.push(cursor)
    heights.push(height)
    cursor += height + PAGE_GAP
  }
  return { offsets, heights, totalHeight: cursor }
}

function visiblePageRange(
  geometry: PageGeometry,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): { start: number; end: number; visible: number[]; primary: number } {
  const viewportBottom = scrollTop + Math.max(1, viewportHeight)
  let firstVisible = 0
  while (
    firstVisible < geometry.offsets.length - 1 &&
    geometry.offsets[firstVisible] + geometry.heights[firstVisible] < scrollTop
  ) {
    firstVisible += 1
  }

  let lastVisible = firstVisible
  while (
    lastVisible < geometry.offsets.length - 1 &&
    geometry.offsets[lastVisible] < viewportBottom
  ) {
    lastVisible += 1
  }

  const visible: number[] = []
  let primary = firstVisible + 1
  let largestIntersection = -1
  for (let index = firstVisible; index <= lastVisible; index += 1) {
    const top = geometry.offsets[index]
    const bottom = top + geometry.heights[index]
    const intersection = Math.max(0, Math.min(bottom, viewportBottom) - Math.max(top, scrollTop))
    if (intersection > 0) visible.push(index + 1)
    if (intersection > largestIntersection) {
      largestIntersection = intersection
      primary = index + 1
    }
  }

  return {
    start: Math.max(0, firstVisible - overscan),
    end: Math.min(geometry.offsets.length - 1, lastVisible + overscan),
    visible,
    primary,
  }
}

function AnnotationMarks({
  annotations,
  onOpen,
}: {
  annotations: readonly PdfViewerAnnotation[]
  onOpen?: (annotation: PdfViewerAnnotation) => void
}): React.JSX.Element | null {
  if (annotations.length === 0) return null
  return (
    <div className="vk-pdf-annotation-marks" aria-label={`${annotations.length} 条标注`}>
      {annotations.slice(0, 6).map((annotation) => (
        <button
          key={annotation.id}
          type="button"
          className={cx(
            'vk-pdf-annotation-mark',
            `is-${annotation.kind}`,
            annotation.color && `is-${annotation.color}`,
          )}
          title={annotation.comment || annotation.quote || annotation.kind}
          aria-label={annotation.comment || annotation.quote || '打开标注'}
          onClick={() => onOpen?.(annotation)}
        />
      ))}
    </div>
  )
}

export function PdfViewer({
  file,
  filePath,
  sourceModifiedAt,
  sourceSize,
  fileName = 'PDF 文档',
  className,
  annotations = [],
  initialReadingState,
  readingState,
  virtualizationOverscan = 2,
  onReadingStateChange,
  onContextChange,
  onSelectionChange,
  onCreateHighlight,
  onCreateComment,
  onToggleBookmark,
  onAnnotationOpen,
  onError,
}: PdfViewerProps): React.JSX.Element {
  const initial = { ...initialReadingState, ...readingState }
  const [documentProxy, setDocumentProxy] = useState<PdfDocumentLike | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [pageRatios, setPageRatios] = useState<Record<number, number>>({})
  const [pageTexts, setPageTexts] = useState<Record<number, string>>({})
  const [textExtractionDone, setTextExtractionDone] = useState(false)
  const [outline, setOutline] = useState<PdfOutlineNode[]>([])
  const [outlineLoaded, setOutlineLoaded] = useState(false)
  const [fit, setFit] = useState<PdfFitMode>(initial.fit ?? 'width')
  const [scale, setScale] = useState(clamp(initial.scale ?? 1, MIN_SCALE, MAX_SCALE))
  const [mainPage, setMainPage] = useState(Math.max(1, initial.page ?? 1))
  const [visiblePages, setVisiblePages] = useState<number[]>([Math.max(1, initial.page ?? 1)])
  const [scrollTop, setScrollTop] = useState(Math.max(0, initial.scrollTop ?? 0))
  const [viewportSize, setViewportSize] = useState({ width: 960, height: 720 })
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>('thumbnails')
  const [thumbnailScrollTop, setThumbnailScrollTop] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [pageInput, setPageInput] = useState(String(mainPage))
  const [selection, setSelection] = useState<PdfTextSelection | null>(null)
  const [highlightColor, setHighlightColor] = useState<PdfAnnotationColor>('amber')
  const [loadError, setLoadError] = useState<Error | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const restoredScrollRef = useRef(false)
  const scrollFrameRef = useRef<number | null>(null)
  const previousFileRef = useRef(file)
  const onReadingStateChangeRef = useRef(onReadingStateChange)
  const onContextChangeRef = useRef(onContextChange)

  onReadingStateChangeRef.current = onReadingStateChange
  onContextChangeRef.current = onContextChange

  const getOcrImage = useCallback(async () => {
    const canvas = scrollRef.current?.querySelector<HTMLCanvasElement>(`[data-pdf-page="${mainPage}"] canvas`)
    if (!canvas) throw new Error('当前页尚未渲染完成，请稍后重试。')
    return rasterizeCanvas(canvas)
  }, [mainPage])
  const ocr = useOcrSession({
    path: filePath,
    page: mainPage,
    sourceModifiedAt,
    sourceSize,
    getImage: getOcrImage
  })

  const pageWidth = useMemo(() => {
    const availableWidth = Math.max(260, viewportSize.width - 56)
    if (fit === 'width') return availableWidth
    if (fit === 'page') {
      const heightLimited = Math.max(220, viewportSize.height - PAGE_GAP * 2) / DEFAULT_PAGE_RATIO
      return Math.min(availableWidth, heightLimited)
    }
    return DEFAULT_PAGE_WIDTH * scale
  }, [fit, scale, viewportSize])

  useEffect(() => {
    if (previousFileRef.current === file) return
    previousFileRef.current = file
    const nextPage = Math.max(1, initial.page ?? 1)
    setDocumentProxy(null)
    setNumPages(0)
    setPageRatios({})
    setPageTexts({})
    setTextExtractionDone(false)
    setOutline([])
    setOutlineLoaded(false)
    setFit(initial.fit ?? 'width')
    setScale(clamp(initial.scale ?? 1, MIN_SCALE, MAX_SCALE))
    setMainPage(nextPage)
    setVisiblePages([nextPage])
    setScrollTop(Math.max(0, initial.scrollTop ?? 0))
    setPageInput(String(nextPage))
    setSelection(null)
    setLoadError(null)
    restoredScrollRef.current = false
  }, [file, initial.fit, initial.page, initial.scale, initial.scrollTop])

  const geometry = useMemo(
    () => computeGeometry(numPages, pageWidth, pageRatios),
    [numPages, pageRatios, pageWidth],
  )

  const range = useMemo(
    () =>
      visiblePageRange(
        geometry,
        scrollTop,
        viewportSize.height,
        Math.max(0, virtualizationOverscan),
      ),
    [geometry, scrollTop, viewportSize.height, virtualizationOverscan],
  )

  const renderedPages = useMemo(() => {
    const pages: number[] = []
    if (!numPages) return pages
    for (let index = range.start; index <= range.end; index += 1) pages.push(index + 1)
    return pages
  }, [numPages, range.end, range.start])

  const searchResults = useMemo<PdfSearchResult[]>(() => {
    const query = searchQuery.trim()
    if (!query) return []
    return Object.entries(pageTexts)
      .map(([page, text]) => ({
        page: Number(page),
        count: countOccurrences(text, query),
        excerpt: makeExcerpt(text, query),
      }))
      .filter((result) => result.count > 0)
      .sort((left, right) => left.page - right.page)
  }, [pageTexts, searchQuery])

  const totalMatches = useMemo(
    () => searchResults.reduce((total, result) => total + result.count, 0),
    [searchResults],
  )

  const bookmarkedPages = useMemo(
    () => new Set(annotations.filter((item) => item.kind === 'bookmark').map((item) => item.page)),
    [annotations],
  )

  const scannedLikely = useMemo(() => {
    if (!textExtractionDone || numPages === 0) return false
    const readablePages = Object.values(pageTexts).filter((text) => text.replace(/\s/g, '').length >= 20)
    return readablePages.length === 0
  }, [numPages, pageTexts, textExtractionDone])

  const jumpToPage = useCallback(
    (page: number) => {
      if (!numPages) return
      const nextPage = clamp(Math.round(page), 1, numPages)
      const nextTop = geometry.offsets[nextPage - 1] ?? 0
      scrollRef.current?.scrollTo({ top: nextTop, behavior: 'smooth' })
      setMainPage(nextPage)
      setPageInput(String(nextPage))
    },
    [geometry.offsets, numPages],
  )

  const updateViewport = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    setViewportSize({ width: element.clientWidth, height: element.clientHeight })
    setScrollTop(element.scrollTop)
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    updateViewport()
    const observer = new ResizeObserver(updateViewport)
    observer.observe(element)
    return () => observer.disconnect()
  }, [documentProxy, updateViewport])

  useEffect(() => {
    const nextMainPage = range.primary || 1
    setMainPage(nextMainPage)
    setPageInput(String(nextMainPage))
    setVisiblePages(range.visible.length ? range.visible : [nextMainPage])
  }, [range.primary, range.visible.join(',')])

  useEffect(() => {
    if (!documentProxy || restoredScrollRef.current || !geometry.totalHeight) return
    const targetTop = initial.scrollTop ?? geometry.offsets[(initial.page ?? 1) - 1] ?? 0
    scrollRef.current?.scrollTo({ top: Math.max(0, targetTop) })
    setScrollTop(Math.max(0, targetTop))
    restoredScrollRef.current = true
  }, [documentProxy, geometry.offsets, geometry.totalHeight, initial.page, initial.scrollTop])

  useEffect(() => {
    if (!readingState) return
    if (readingState.fit && readingState.fit !== fit) setFit(readingState.fit)
    if (typeof readingState.scale === 'number' && readingState.scale !== scale) {
      setScale(clamp(readingState.scale, MIN_SCALE, MAX_SCALE))
    }
  }, [fit, readingState, scale])

  useEffect(() => {
    if (!readingState?.page || !numPages) return
    if (readingState.page !== mainPage) jumpToPage(readingState.page)
    // Local scroll changes deliberately do not retrigger this controlled-value sync.
    // The parent callback can persist them without the previous prop snapping the view back.
  }, [numPages, readingState?.page])

  useEffect(() => {
    const state: PdfViewerReadingState = {
      page: mainPage,
      scale,
      fit,
      scrollTop,
      visiblePages,
    }
    onReadingStateChangeRef.current?.(state)
  }, [fit, mainPage, scale, scrollTop, visiblePages])

  useEffect(() => {
    if (!numPages) return
    const extractedText = pageTexts[mainPage] ?? ''
    const currentText = extractedText.replace(/\s/g, '').length >= 20
      ? extractedText
      : ocr.result?.page === mainPage ? ocr.result.text : extractedText
    const adjacentText = [pageTexts[mainPage - 1], currentText, pageTexts[mainPage + 1]]
      .filter(Boolean)
      .join('\n\n')
    const context: PdfViewerContext = {
      page: mainPage,
      visiblePages,
      pageText: currentText,
      adjacentText,
      selection: selection ?? undefined,
      readable: currentText.replace(/\s/g, '').length >= 20,
    }
    onContextChangeRef.current?.(context)
  }, [mainPage, numPages, ocr.result, pageTexts, selection, visiblePages])

  useEffect(() => {
    if (!documentProxy) return
    const pdf = documentProxy
    let cancelled = false
    setTextExtractionDone(false)
    setPageTexts({})

    async function extractText(): Promise<void> {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (cancelled) return
        try {
          const page = await pdf.getPage(pageNumber)
          const textContent = await page.getTextContent()
          const text = textContent.items
            .map((item) => `${item.str ?? ''}${item.hasEOL ? '\n' : ' '}`)
            .join('')
            .replace(/[ \t]+\n/g, '\n')
            .trim()
          if (!cancelled) setPageTexts((current) => ({ ...current, [pageNumber]: text }))
        } catch {
          if (!cancelled) setPageTexts((current) => ({ ...current, [pageNumber]: '' }))
        }
      }
      if (!cancelled) setTextExtractionDone(true)
    }

    void extractText()
    return () => {
      cancelled = true
    }
  }, [documentProxy])

  const loadOutline = useCallback(async (pdf: PdfDocumentLike) => {
    setOutlineLoaded(false)
    try {
      const rawOutline = await pdf.getOutline()
      const flat: PdfOutlineNode[] = []

      const visit = async (nodes: RawOutlineNode[], depth: number): Promise<void> => {
        for (const [index, node] of nodes.entries()) {
          let page: number | null = null
          try {
            let destination = node.dest ?? null
            if (typeof destination === 'string') destination = await pdf.getDestination(destination)
            if (Array.isArray(destination) && destination[0]) {
              page = (await pdf.getPageIndex(destination[0] as never)) + 1
            }
          } catch {
            page = null
          }
          flat.push({
            title: node.title?.trim() || '未命名章节',
            page,
            depth,
            id: `${depth}-${flat.length}-${index}`,
          })
          if (node.items?.length) await visit(node.items, depth + 1)
        }
      }

      if (rawOutline?.length) await visit(rawOutline, 0)
      setOutline(flat)
    } catch {
      setOutline([])
    } finally {
      setOutlineLoaded(true)
    }
  }, [])

  const handleDocumentLoad = useCallback(
    (loaded: unknown) => {
      const pdf = loaded as PdfDocumentLike
      setDocumentProxy(pdf)
      setNumPages(pdf.numPages)
      setLoadError(null)
      restoredScrollRef.current = false
      void loadOutline(pdf)
    },
    [loadOutline],
  )

  const handleLoadError = useCallback(
    (reason: Error) => {
      const error = reason instanceof Error ? reason : new Error(String(reason))
      setLoadError(error)
      onError?.(error)
    },
    [onError],
  )

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      const element = scrollRef.current
      if (element) setScrollTop(element.scrollTop)
    })
  }, [])

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    },
    [],
  )

  const handleSelection = useCallback(() => {
    const browserSelection = window.getSelection()
    const text = browserSelection?.toString().trim() ?? ''
    if (!browserSelection || browserSelection.rangeCount === 0 || !text) {
      setSelection(null)
      onSelectionChange?.(null)
      return
    }

    const anchorNode = browserSelection.anchorNode
    const anchorElement =
      anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement ?? null
    const pageElement = anchorElement?.closest<HTMLElement>('[data-pdf-page]')
    if (!pageElement || !scrollRef.current?.contains(pageElement)) return
    const page = Number(pageElement.dataset.pdfPage)
    const pageRect = pageElement.getBoundingClientRect()
    const rangeRectangles = Array.from(browserSelection.getRangeAt(0).getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        left: clamp((rect.left - pageRect.left) / pageRect.width, 0, 1),
        top: clamp((rect.top - pageRect.top) / pageRect.height, 0, 1),
        width: clamp(rect.width / pageRect.width, 0, 1),
        height: clamp(rect.height / pageRect.height, 0, 1),
      }))

    const nextSelection: PdfTextSelection = { page, text, rects: rangeRectangles }
    setSelection(nextSelection)
    onSelectionChange?.(nextSelection)
  }, [onSelectionChange])

  const setZoom = useCallback((nextScale: number) => {
    setFit('custom')
    setScale(clamp(Math.round(nextScale * 10) / 10, MIN_SCALE, MAX_SCALE))
  }, [])

  const switchSidebarPanel = useCallback((panel: SidebarPanel) => {
    setSidebarPanel(panel)
    setSidebarOpen(true)
  }, [])

  const commitPageInput = useCallback(() => {
    const parsed = Number(pageInput)
    if (Number.isFinite(parsed)) jumpToPage(parsed)
    else setPageInput(String(mainPage))
  }, [jumpToPage, mainPage, pageInput])

  const thumbnailStart = Math.max(0, Math.floor(thumbnailScrollTop / THUMBNAIL_ROW_HEIGHT) - 2)
  const thumbnailEnd = Math.min(numPages - 1, thumbnailStart + 8)
  const thumbnailPages: number[] = []
  for (let index = thumbnailStart; index <= thumbnailEnd; index += 1) thumbnailPages.push(index + 1)

  return (
    <section className={cx('vk-viewer', 'vk-pdf-viewer', className)} aria-label={`${fileName} PDF 阅读器`}>
      <header className="vk-viewer-toolbar vk-pdf-toolbar">
        <div className="vk-viewer-toolbar-group">
          <IconButton
            label={sidebarOpen ? '收起侧边栏' : '打开侧边栏'}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </IconButton>
          <IconButton
            label="页面缩略图"
            active={sidebarOpen && sidebarPanel === 'thumbnails'}
            onClick={() => switchSidebarPanel('thumbnails')}
          >
            <BookOpenText size={17} />
          </IconButton>
          <IconButton
            label="文档目录"
            active={sidebarOpen && sidebarPanel === 'outline'}
            onClick={() => switchSidebarPanel('outline')}
          >
            <ListTree size={17} />
          </IconButton>
          <IconButton
            label="在文档中搜索"
            active={sidebarOpen && sidebarPanel === 'search'}
            onClick={() => switchSidebarPanel('search')}
          >
            <Search size={17} />
          </IconButton>
        </div>

        <div className="vk-viewer-toolbar-group vk-pdf-page-control" aria-label="页码导航">
          <IconButton label="上一页" compact disabled={mainPage <= 1} onClick={() => jumpToPage(mainPage - 1)}>
            <ChevronLeft size={16} />
          </IconButton>
          <input
            className="vk-pdf-page-input"
            value={pageInput}
            inputMode="numeric"
            aria-label="当前页码"
            onChange={(event) => setPageInput(event.target.value.replace(/[^0-9]/g, ''))}
            onBlur={commitPageInput}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitPageInput()
            }}
          />
          <span className="vk-pdf-page-total">/ {numPages || '—'}</span>
          <IconButton
            label="下一页"
            compact
            disabled={!numPages || mainPage >= numPages}
            onClick={() => jumpToPage(mainPage + 1)}
          >
            <ChevronRight size={16} />
          </IconButton>
        </div>

        <div className="vk-viewer-toolbar-group vk-pdf-zoom-control" aria-label="缩放控制">
          <IconButton label="缩小" compact onClick={() => setZoom((fit === 'custom' ? scale : pageWidth / DEFAULT_PAGE_WIDTH) - 0.1)}>
            <Minus size={16} />
          </IconButton>
          <button
            type="button"
            className="vk-pdf-zoom-value"
            title="恢复 100%"
            onClick={() => setZoom(1)}
          >
            {Math.round((fit === 'custom' ? scale : pageWidth / DEFAULT_PAGE_WIDTH) * 100)}%
          </button>
          <IconButton label="放大" compact onClick={() => setZoom((fit === 'custom' ? scale : pageWidth / DEFAULT_PAGE_WIDTH) + 0.1)}>
            <Plus size={16} />
          </IconButton>
          <ToolbarDivider />
          <button
            type="button"
            className={cx('vk-viewer-text-button', fit === 'width' && 'is-active')}
            onClick={() => setFit('width')}
          >
            适宽
          </button>
          <button
            type="button"
            className={cx('vk-viewer-text-button', fit === 'page' && 'is-active')}
            onClick={() => setFit('page')}
          >
            适页
          </button>
        </div>

        <div className="vk-viewer-toolbar-group">
          <IconButton
            label={bookmarkedPages.has(mainPage) ? '移除本页书签' : '为本页添加书签'}
            active={bookmarkedPages.has(mainPage)}
            onClick={() => onToggleBookmark?.(mainPage, !bookmarkedPages.has(mainPage))}
          >
            <Bookmark size={17} fill={bookmarkedPages.has(mainPage) ? 'currentColor' : 'none'} />
          </IconButton>
          <IconButton label="本地识别当前页" active={ocr.panelOpen && ocr.result?.engine === 'paddleocr-v6'} onClick={() => void ocr.runLocal()}>
            <ScanText size={17} />
          </IconButton>
          <IconButton label="AI 增强识别当前页（发送页面图像）" active={ocr.panelOpen && ocr.result?.engine === 'ai-vision'} onClick={() => void ocr.runAi()}>
            <Sparkles size={17} />
          </IconButton>
        </div>
      </header>

      {ocr.panelOpen && (
        <OcrPanel
          result={ocr.result}
          status={ocr.status}
          error={ocr.error}
          onLocal={() => void ocr.runLocal()}
          onAi={() => void ocr.runAi()}
          onCancel={ocr.cancel}
          onClose={() => ocr.setPanelOpen(false)}
        />
      )}

      {selection && (
        <div className="vk-pdf-selection-bar" role="toolbar" aria-label="选中文字操作">
          <span className="vk-pdf-selection-quote">“{selection.text.slice(0, 80)}{selection.text.length > 80 ? '…' : ''}”</span>
          <div className="vk-pdf-highlight-palette" aria-label="高亮颜色">
            {HIGHLIGHT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={cx('vk-pdf-color-swatch', `is-${color}`, highlightColor === color && 'is-active')}
                aria-label={`${color} 高亮`}
                onClick={() => setHighlightColor(color)}
              />
            ))}
          </div>
          <button
            type="button"
            className="vk-viewer-text-button is-emphasis"
            onClick={() => onCreateHighlight?.(selection, highlightColor)}
          >
            <Highlighter size={15} /> 高亮
          </button>
          <button
            type="button"
            className="vk-viewer-text-button"
            onClick={() => onCreateComment?.(selection)}
          >
            <MessageSquareText size={15} /> 批注
          </button>
          <IconButton
            label="取消选择"
            compact
            onClick={() => {
              window.getSelection()?.removeAllRanges()
              setSelection(null)
              onSelectionChange?.(null)
            }}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}

      {scannedLikely && !ocr.result?.text && (
        <div className="vk-pdf-scan-warning" role="alert">
          <FileWarning size={16} aria-hidden="true" />
          <span>这份 PDF 似乎是扫描件，无法可靠提取正文；AI 不会把页面图片当作已读取文本。</span>
        </div>
      )}

      <Document
        file={file}
        className="vk-pdf-document"
        loading={<ViewerSpinner label="正在打开 PDF…" />}
        error={
          <ViewerNotice
            icon={<FileWarning size={28} />}
            title="无法打开这份 PDF"
            detail={loadError?.message || '文件可能已损坏、受密码保护，或路径已经失效。'}
            tone="danger"
          />
        }
        onLoadSuccess={handleDocumentLoad}
        onLoadError={handleLoadError}
      >
        <div className="vk-pdf-body">
          {sidebarOpen && (
            <aside className="vk-pdf-sidebar" aria-label="PDF 导航">
              <div className="vk-pdf-sidebar-heading">
                <strong>
                  {sidebarPanel === 'thumbnails' && '页面'}
                  {sidebarPanel === 'outline' && '目录'}
                  {sidebarPanel === 'search' && '文内搜索'}
                </strong>
                <span>{fileName}</span>
              </div>

              {sidebarPanel === 'thumbnails' && (
                <div
                  className="vk-pdf-thumbnail-list"
                  onScroll={(event) => setThumbnailScrollTop(event.currentTarget.scrollTop)}
                >
                  <div
                    className="vk-pdf-thumbnail-spacer"
                    style={{ height: numPages * THUMBNAIL_ROW_HEIGHT }}
                  >
                    {thumbnailPages.map((page) => (
                      <button
                        type="button"
                        key={page}
                        className={cx('vk-pdf-thumbnail', mainPage === page && 'is-active')}
                        style={{ top: (page - 1) * THUMBNAIL_ROW_HEIGHT }}
                        onClick={() => jumpToPage(page)}
                        aria-label={`前往第 ${page} 页`}
                      >
                        <Page
                          pageNumber={page}
                          width={104}
                          renderTextLayer={false}
                          renderAnnotationLayer={false}
                          loading={<span className="vk-pdf-thumbnail-loading" />}
                        />
                        <span>{page}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {sidebarPanel === 'outline' && (
                <nav className="vk-pdf-outline" aria-label="文档目录">
                  {!outlineLoaded && <ViewerSpinner label="正在读取目录…" />}
                  {outlineLoaded && outline.length === 0 && (
                    <p className="vk-viewer-muted">这份文档没有提供可用目录。</p>
                  )}
                  {outline.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      style={{ paddingInlineStart: 14 + item.depth * 14 }}
                      disabled={item.page === null}
                      onClick={() => item.page && jumpToPage(item.page)}
                    >
                      <span>{item.title}</span>
                      {item.page && <small>{item.page}</small>}
                    </button>
                  ))}
                </nav>
              )}

              {sidebarPanel === 'search' && (
                <div className="vk-pdf-search-panel">
                  <label className="vk-viewer-search-field">
                    <Search size={15} aria-hidden="true" />
                    <input
                      value={searchQuery}
                      autoFocus
                      placeholder="搜索这份 PDF"
                      aria-label="搜索 PDF 正文"
                      onChange={(event) => setSearchQuery(event.target.value)}
                    />
                    {searchQuery && (
                      <IconButton label="清除搜索" compact onClick={() => setSearchQuery('')}>
                        <X size={13} />
                      </IconButton>
                    )}
                  </label>
                  <div className="vk-pdf-search-summary">
                    {!searchQuery.trim()
                      ? '输入关键词开始搜索'
                      : textExtractionDone
                        ? `${searchResults.length} 页，共 ${totalMatches} 处`
                        : `正在建立文本索引 · 已找到 ${totalMatches} 处`}
                  </div>
                  <div className="vk-pdf-search-results">
                    {searchResults.map((result) => (
                      <button key={result.page} type="button" onClick={() => jumpToPage(result.page)}>
                        <span className="vk-pdf-search-result-meta">
                          第 {result.page} 页 <small>{result.count} 处</small>
                        </span>
                        <span>{result.excerpt}</span>
                      </button>
                    ))}
                    {searchQuery.trim() && textExtractionDone && searchResults.length === 0 && (
                      <p className="vk-viewer-muted">没有找到“{searchQuery.trim()}”。</p>
                    )}
                  </div>
                </div>
              )}
            </aside>
          )}

          <div
            ref={scrollRef}
            className="vk-pdf-scroll"
            onScroll={handleScroll}
            onMouseUp={handleSelection}
            tabIndex={0}
            aria-label={`${fileName} 连续滚动页面`}
          >
            <div className="vk-pdf-virtual-space" style={{ height: geometry.totalHeight }}>
              {renderedPages.map((page) => {
                const pageAnnotations = annotations.filter((annotation) => annotation.page === page)
                return (
                  <article
                    key={page}
                    data-pdf-page={page}
                    className={cx('vk-pdf-page-shell', mainPage === page && 'is-primary')}
                    style={{
                      top: geometry.offsets[page - 1],
                      width: pageWidth,
                      minHeight: geometry.heights[page - 1],
                    }}
                    aria-label={`第 ${page} 页`}
                  >
                    <Page
                      pageNumber={page}
                      width={pageWidth}
                      renderTextLayer
                      renderAnnotationLayer
                      loading={<div className="vk-pdf-page-placeholder">正在渲染第 {page} 页…</div>}
                      onLoadSuccess={(loadedPage) => {
                        const [, , width, height] = loadedPage.view
                        if (width > 0 && height > 0) {
                          const ratio = height / width
                          setPageRatios((current) =>
                            Math.abs((current[page] ?? 0) - ratio) < 0.001
                              ? current
                              : { ...current, [page]: ratio },
                          )
                        }
                      }}
                    />
                    <span className="vk-pdf-page-number" aria-hidden="true">{page}</span>
                    <AnnotationMarks annotations={pageAnnotations} onOpen={onAnnotationOpen} />
                  </article>
                )
              })}
            </div>
          </div>
        </div>
      </Document>
    </section>
  )
}
