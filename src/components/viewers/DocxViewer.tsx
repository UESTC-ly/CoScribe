import DOMPurify from 'dompurify'
import { Check, Copy, ExternalLink, FileType2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { ViewerNotice } from './ViewerChrome'
import type { DocxViewerProps } from './types'
import { usePersistentDomSelection } from './usePersistentDomSelection'

export function DocxViewer({
  html,
  text,
  fileName = 'Word 文档',
  warnings = [],
  onContextChange,
  onOpenLink,
  onOpenExternal,
  aiSelectionText,
  aiSelectionRevealToken = 0,
  aiSelectionClearToken = 0,
}: DocxViewerProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const contentRef = useRef<HTMLElement>(null)
  const onContextChangeRef = useRef(onContextChange)
  onContextChangeRef.current = onContextChange
  const persistentSelection = usePersistentDomSelection({
    rootRef: contentRef,
    selectionText: aiSelectionText,
    revealToken: aiSelectionRevealToken,
    clearToken: aiSelectionClearToken,
    contentKey: text,
  })
  const safeHtml = useMemo(() => DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['style']
  }), [html])

  useEffect(() => {
    onContextChangeRef.current?.({ selection: '', visibleText: text.slice(0, 20_000), documentText: text })
  }, [text])

  const publishSelection = (): void => {
    const selected = persistentSelection.captureSelection()
    onContextChangeRef.current?.({ selection: selected, visibleText: text.slice(0, 20_000), documentText: text })
  }

  return (
    <section className="vk-viewer vk-docx-viewer" aria-label={`${fileName} DOCX 阅读器`}>
      <header className="vk-viewer-toolbar">
        <div className="vk-viewer-toolbar-group vk-docx-title">
          <FileType2 size={16} />
          <span>{fileName}</span>
          <small>本地语义预览</small>
        </div>
        <div className="vk-viewer-toolbar-group">
          <button
            type="button"
            className="vk-viewer-text-button"
            onClick={() => void navigator.clipboard.writeText(text).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1_200)
            })}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? '已复制' : '复制正文'}
          </button>
          {onOpenExternal && (
            <button type="button" className="vk-viewer-text-button" onClick={onOpenExternal}>
              <ExternalLink size={15} /> 外部打开
            </button>
          )}
        </div>
      </header>
      {warnings.length > 0 && (
        <details className="vk-docx-warnings">
          <summary>{warnings.length} 条转换提示</summary>
          {warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </details>
      )}
      <div className="vk-docx-scroll">
        {safeHtml.trim() ? (
          <article
            ref={contentRef}
            className="vk-docx-page"
            onMouseUp={publishSelection}
            onKeyUp={publishSelection}
            onClick={(event) => {
              const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]')
              if (!link) return
              event.preventDefault()
              onOpenLink?.(link.getAttribute('href') ?? '')
            }}
            dangerouslySetInnerHTML={{ __html: safeHtml }}
          />
        ) : (
          <ViewerNotice
            icon={<FileType2 size={28} />}
            title="文档没有可预览正文"
            detail="文件可能只包含不受支持的对象，或正文为空。"
          />
        )}
      </div>
    </section>
  )
}
