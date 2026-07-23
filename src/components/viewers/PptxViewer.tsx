import DOMPurify from 'dompurify'
import { ChevronLeft, ChevronRight, Expand, ExternalLink, Minus, Plus, Presentation } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PptxRenderer } from 'pptx-svg'

import { cx, IconButton, ToolbarDivider, ViewerNotice, ViewerSpinner } from './ViewerChrome'
import type { PptxViewerProps } from './types'
import { usePersistentDomSelection } from './usePersistentDomSelection'

const MIN_ZOOM = 0.5
const MAX_ZOOM = 2.5

function safeSlide(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_DATA_URI_TAGS: ['image'],
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['onload', 'onclick', 'onerror']
  })
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 10) / 10))
}

function textForSlide(text: string, slide: number): string {
  const marker = `[幻灯片 ${slide}]`
  const start = text.indexOf(marker)
  if (start < 0) return text.slice(0, 20_000)
  const contentStart = start + marker.length
  const next = text.indexOf('\n\n[幻灯片 ', contentStart)
  return text.slice(contentStart, next < 0 ? undefined : next).trim().slice(0, 20_000)
}

export function PptxViewer({
  src,
  text,
  fileName = 'PowerPoint 演示文稿',
  onContextChange,
  onOpenExternal,
  onError,
  aiSelectionText,
  aiSelectionRevealToken = 0,
  aiSelectionClearToken = 0,
}: PptxViewerProps): React.JSX.Element {
  const [renderer, setRenderer] = useState<PptxRenderer | null>(null)
  const [slideCount, setSlideCount] = useState(0)
  const [slideIndex, setSlideIndex] = useState(0)
  const [svg, setSvg] = useState('')
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const slideRef = useRef<HTMLDivElement>(null)
  const onContextChangeRef = useRef(onContextChange)
  const onErrorRef = useRef(onError)
  onContextChangeRef.current = onContextChange
  onErrorRef.current = onError
  const persistentSelection = usePersistentDomSelection({
    rootRef: slideRef,
    selectionText: aiSelectionText,
    revealToken: aiSelectionRevealToken,
    clearToken: aiSelectionClearToken,
    contentKey: svg,
  })

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setRenderer(null)
    setSlideCount(0)
    setSlideIndex(0)
    setSvg('')

    void (async () => {
      try {
        const [response, nextRenderer] = await Promise.all([
          fetch(src, { signal: controller.signal }),
          (async () => {
            const value = new PptxRenderer({ logLevel: 'error' })
            await value.init()
            return value
          })()
        ])
        if (!response.ok) throw new Error(`读取 PPTX 失败（HTTP ${response.status}）。`)
        const buffer = await response.arrayBuffer()
        if (controller.signal.aborted) return
        const loaded = await nextRenderer.loadPptx(buffer)
        if (!loaded.slideCount) throw new Error('演示文稿中没有可显示的幻灯片。')
        setRenderer(nextRenderer)
        setSlideCount(loaded.slideCount)
        setSvg(safeSlide(nextRenderer.renderSlideSvg(0)))
        onContextChangeRef.current?.({ selection: '', visibleText: textForSlide(text, 1), documentText: text, slide: 1 })
      } catch (reason) {
        if (controller.signal.aborted) return
        const nextError = reason instanceof Error ? reason : new Error('无法渲染这份 PowerPoint。')
        setError(nextError)
        onErrorRef.current?.(nextError)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [src, text])

  const showSlide = useCallback((index: number): void => {
    if (!renderer || slideCount < 1) return
    const nextIndex = Math.max(0, Math.min(slideCount - 1, index))
    try {
      setSlideIndex(nextIndex)
      setSvg(safeSlide(renderer.renderSlideSvg(nextIndex)))
      onContextChangeRef.current?.({
        selection: '',
        visibleText: textForSlide(text, nextIndex + 1),
        documentText: text,
        slide: nextIndex + 1
      })
    } catch (reason) {
      const nextError = reason instanceof Error ? reason : new Error('这页幻灯片无法渲染。')
      setError(nextError)
      onErrorRef.current?.(nextError)
    }
  }, [renderer, slideCount, text])

  const publishSelection = (): void => {
    const selected = persistentSelection.captureSelection()
    onContextChangeRef.current?.({
      selection: selected,
      visibleText: textForSlide(text, slideIndex + 1),
      documentText: text,
      slide: slideIndex + 1
    })
  }

  return (
    <section className="vk-viewer vk-pptx-viewer" aria-label={`${fileName} PowerPoint 阅读器`}>
      <header className="vk-viewer-toolbar">
        <div className="vk-viewer-toolbar-group">
          <Presentation size={16} />
          <strong className="vk-pptx-title" title={fileName}>{fileName}</strong>
          <ToolbarDivider />
          <IconButton label="上一页幻灯片" shortcut="← / Page Up" disabled={slideIndex <= 0} onClick={() => showSlide(slideIndex - 1)}>
            <ChevronLeft size={17} />
          </IconButton>
          <span className="vk-pptx-page">{slideCount ? slideIndex + 1 : 0} / {slideCount}</span>
          <IconButton label="下一页幻灯片" shortcut="→ / Page Down" disabled={slideIndex >= slideCount - 1} onClick={() => showSlide(slideIndex + 1)}>
            <ChevronRight size={17} />
          </IconButton>
          <ToolbarDivider />
          <IconButton label="缩小幻灯片" disabled={fit} onClick={() => setZoom((value) => clampZoom(value - 0.1))}>
            <Minus size={17} />
          </IconButton>
          <span className="vk-pptx-zoom">{fit ? '适应窗口' : `${Math.round(zoom * 100)}%`}</span>
          <IconButton label="放大幻灯片" disabled={fit} onClick={() => setZoom((value) => clampZoom(value + 0.1))}>
            <Plus size={17} />
          </IconButton>
          <button type="button" className={cx('vk-viewer-text-button', fit && 'is-active')} onClick={() => setFit((value) => !value)}>
            <Expand size={15} /> 适应窗口
          </button>
        </div>
        {onOpenExternal && (
          <div className="vk-viewer-toolbar-group">
            <button type="button" className="vk-viewer-text-button" onClick={onOpenExternal}>
              <ExternalLink size={15} /> 外部打开
            </button>
          </div>
        )}
      </header>

      <div
        className="vk-pptx-scroll"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'PageUp') showSlide(slideIndex - 1)
          if (event.key === 'ArrowRight' || event.key === 'PageDown') showSlide(slideIndex + 1)
        }}
      >
        {loading && <ViewerSpinner label="正在解析 PowerPoint…" />}
        {error ? (
          <ViewerNotice
            icon={<Presentation size={30} />}
            title="无法完整显示这份 PowerPoint"
            detail={`${error.message} 文件内容仍可供 AI 和搜索读取；也可以使用外部应用打开。`}
            actions={onOpenExternal && <button type="button" className="vk-viewer-primary-action" onClick={onOpenExternal}>使用外部应用打开</button>}
            tone="danger"
          />
        ) : svg ? (
          <div className="vk-pptx-stage">
            <div
              ref={slideRef}
              className={cx('vk-pptx-slide', fit && 'is-fit')}
              style={fit ? undefined : { width: `${Math.round(960 * zoom)}px` }}
              onMouseUp={publishSelection}
              onKeyUp={publishSelection}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        ) : null}
      </div>
    </section>
  )
}
