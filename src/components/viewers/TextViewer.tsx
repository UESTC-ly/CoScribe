import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Search, TextCursorInput, WrapText, X } from 'lucide-react'
import { cx, IconButton } from './ViewerChrome'
import type { TextViewerContext, TextViewerProps } from './types'

const TEXT_LINE_HEIGHT = 22

interface TextMatch {
  from: number
  to: number
}

function findTextMatches(content: string, query: string): TextMatch[] {
  if (!query) return []
  const haystack = content.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const matches: TextMatch[] = []
  let cursor = 0
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    matches.push({ from: cursor, to: cursor + query.length })
    cursor += Math.max(1, query.length)
  }
  return matches
}

function lineStartOffsets(content: string): number[] {
  const offsets = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') offsets.push(index + 1)
  }
  return offsets
}

export function TextViewer({
  content,
  fileName = '文本文件',
  className,
  language,
  wrap,
  onWrapChange,
  onContextChange,
  aiSelectionText,
  aiSelectionRevealToken = 0,
  aiSelectionClearToken = 0,
}: TextViewerProps): React.JSX.Element {
  const [internalWrap, setInternalWrap] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLPreElement>(null)
  const effectiveWrap = wrap ?? internalWrap
  const lines = useMemo(() => content.split('\n'), [content])
  const lineOffsets = useMemo(() => lineStartOffsets(content), [content])
  const matches = useMemo(() => findTextMatches(content, searchQuery.trim()), [content, searchQuery])

  useEffect(() => {
    if (matches.length === 0) setSearchIndex(0)
    else if (searchIndex >= matches.length) setSearchIndex(matches.length - 1)
  }, [matches.length, searchIndex])

  const emitContext = useCallback(
    (selectionStart: number, selectionEnd: number) => {
      const textarea = textareaRef.current
      const firstVisibleLine = Math.max(0, Math.floor((textarea?.scrollTop ?? 0) / TEXT_LINE_HEIGHT))
      const visibleLineCount = Math.ceil((textarea?.clientHeight ?? 440) / TEXT_LINE_HEIGHT) + 2
      const visibleStart = lineOffsets[firstVisibleLine] ?? 0
      const endLine = Math.min(lines.length, firstVisibleLine + visibleLineCount)
      const visibleEnd = lineOffsets[endLine] ?? content.length
      const context: TextViewerContext = {
        selection: content.slice(selectionStart, selectionEnd),
        selectionStart,
        selectionEnd,
        visibleText: content.slice(visibleStart, visibleEnd),
      }
      onContextChange?.(context)
    },
    [content, lineOffsets, lines.length, onContextChange],
  )

  useEffect(() => {
    emitContext(0, 0)
  }, [content])

  useEffect(() => {
    if (aiSelectionClearToken <= 0) return
    const textarea = textareaRef.current
    if (!textarea) return
    const head = textarea.selectionEnd
    textarea.setSelectionRange(head, head)
  }, [aiSelectionClearToken])

  useEffect(() => {
    if (aiSelectionRevealToken <= 0 || !aiSelectionText) return
    const textarea = textareaRef.current
    const start = content.indexOf(aiSelectionText)
    if (!textarea || start < 0) return
    textarea.setSelectionRange(start, start + aiSelectionText.length)
    const line = content.slice(0, start).split('\n').length - 1
    textarea.scrollTop = Math.max(0, line * TEXT_LINE_HEIGHT - textarea.clientHeight / 3)
    emitContext(start, start + aiSelectionText.length)
  }, [aiSelectionRevealToken, aiSelectionText, content, emitContext])

  const jumpToMatch = useCallback(
    (nextIndex: number) => {
      if (!matches.length) return
      const normalized = (nextIndex + matches.length) % matches.length
      const match = matches[normalized]
      setSearchIndex(normalized)
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(match.from, match.to)
      emitContext(match.from, match.to)
    },
    [emitContext, matches],
  )

  const toggleWrap = useCallback(() => {
    const next = !effectiveWrap
    if (wrap === undefined) setInternalWrap(next)
    onWrapChange?.(next)
  }, [effectiveWrap, onWrapChange, wrap])

  return (
    <section
      className={cx('vk-viewer', 'vk-text-viewer', aiSelectionText && 'has-ai-context-selection', className)}
      aria-label={`${fileName} 文本查看器`}
      onKeyDownCapture={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'f') {
          event.preventDefault()
          setSearchOpen(true)
        }
      }}
    >
      <header className="vk-viewer-toolbar">
        <div className="vk-viewer-toolbar-group">
          <IconButton label="查找" shortcut="⌘F / Ctrl+F" active={searchOpen} onClick={() => setSearchOpen((open) => !open)}>
            <Search size={17} />
          </IconButton>
          <IconButton label={effectiveWrap ? '关闭自动换行' : '开启自动换行'} active={effectiveWrap} onClick={toggleWrap}>
            <WrapText size={17} />
          </IconButton>
        </div>
        <div className="vk-text-meta">
          {language && <span className="vk-text-language">{language}</span>}
          <span>{lines.length.toLocaleString()} 行</span>
          <span>{content.length.toLocaleString()} 字符</span>
        </div>
      </header>

      {searchOpen && (
        <div className="vk-markdown-search-bar" role="search">
          <label className="vk-viewer-search-field">
            <Search size={15} aria-hidden="true" />
            <input
              autoFocus
              value={searchQuery}
              placeholder="在文本中查找"
              onChange={(event) => {
                setSearchQuery(event.target.value)
                setSearchIndex(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  jumpToMatch(searchIndex + (event.shiftKey ? -1 : 1))
                }
                if (event.key === 'Escape') setSearchOpen(false)
              }}
            />
          </label>
          <span className="vk-markdown-search-count">
            {matches.length ? `${searchIndex + 1} / ${matches.length}` : searchQuery ? '0 / 0' : '—'}
          </span>
          <IconButton label="上一个匹配" shortcut="⇧Enter" compact disabled={!matches.length} onClick={() => jumpToMatch(searchIndex - 1)}>
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton label="下一个匹配" shortcut="Enter" compact disabled={!matches.length} onClick={() => jumpToMatch(searchIndex + 1)}>
            <ChevronRight size={15} />
          </IconButton>
          <IconButton label="关闭查找" shortcut="Esc" compact onClick={() => setSearchOpen(false)}>
            <X size={14} />
          </IconButton>
        </div>
      )}

      <div className={cx('vk-text-content', effectiveWrap && 'is-wrapped')}>
        {!effectiveWrap && (
          <pre
            ref={gutterRef}
            className="vk-text-gutter"
            aria-hidden="true"
            style={{ transform: `translateY(${-scrollTop}px)` }}
          >
            {lines.map((_, index) => `${index + 1}\n`).join('')}
          </pre>
        )}
        <textarea
          ref={textareaRef}
          className="vk-text-source"
          value={content}
          readOnly
          wrap={effectiveWrap ? 'soft' : 'off'}
          spellCheck={false}
          aria-label={`${fileName} 内容`}
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop)
            emitContext(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)
          }}
          onSelect={(event) => emitContext(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
        />
        {!content && (
          <div className="vk-text-empty">
            <TextCursorInput size={22} />
            <span>这个文本文件是空的。</span>
          </div>
        )}
      </div>
    </section>
  )
}
