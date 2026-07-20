import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { redo, undo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Eye,
  FileDiff,
  ListTree,
  PencilLine,
  Redo2,
  Save,
  Search,
  Undo2,
  X,
} from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { cx, IconButton, ToolbarDivider } from './ViewerChrome'
import { MermaidDiagram } from './MermaidDiagram'
import type {
  MarkdownExternalChange,
  MarkdownOutlineItem,
  MarkdownSaveReason,
  MarkdownViewMode,
  MarkdownViewerContext,
  MarkdownViewerProps,
} from './types'

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

interface SearchMatch {
  from: number
  to: number
}

function slugify(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[`*_~\[\](){}<>]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section'
}

function parseOutline(content: string): MarkdownOutlineItem[] {
  const items: MarkdownOutlineItem[] = []
  const slugs = new Map<string, number>()
  const lines = content.split('\n')
  let offset = 0
  let fence: { marker: '`' | '~'; length: number } | null = null

  const pushHeading = (textValue: string, level: number, headingOffset: number): void => {
    const text = textValue.replace(/[ \t]+#+[ \t]*$/, '').trim()
    const base = slugify(text)
    const occurrence = (slugs.get(base) ?? 0) + 1
    slugs.set(base, occurrence)
    items.push({
      id: occurrence === 1 ? base : `${base}-${occurrence}`,
      text,
      level,
      offset: headingOffset,
    })
  }

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/\r$/, '')
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const token = fenceMatch[1]
      const marker = token[0] as '`' | '~'
      if (!fence) {
        fence = { marker, length: token.length }
      } else if (
        fence.marker === marker &&
        token.length >= fence.length &&
        line.slice(fenceMatch[0].length).trim().length === 0
      ) {
        fence = null
      }
      offset += rawLine.length + 1
      continue
    }

    if (fence) {
      offset += rawLine.length + 1
      continue
    }

    const match = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line)
    if (match) {
      pushHeading(match[2], match[1].length, offset)
    } else {
      const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line)
      const previousRaw = index > 0 ? lines[index - 1] : undefined
      const previous = previousRaw?.replace(/\r$/, '')
      if (
        setext &&
        previous &&
        previous.trim().length > 0 &&
        !/^ {0,3}(?:>|[-+*][ \t]|\d+[.)][ \t])/.test(previous)
      ) {
        const previousOffset = offset - previousRaw!.length - 1
        pushHeading(previous.trim(), setext[1][0] === '=' ? 1 : 2, previousOffset)
      }
    }
    offset += rawLine.length + 1
  }
  return items
}

function headingAt(outline: readonly MarkdownOutlineItem[], cursor: number): MarkdownOutlineItem | undefined {
  let current: MarkdownOutlineItem | undefined
  for (const heading of outline) {
    if (heading.offset > cursor) break
    current = heading
  }
  return current
}

function sectionAt(
  content: string,
  outline: readonly MarkdownOutlineItem[],
  heading: MarkdownOutlineItem | undefined,
): string {
  if (!heading) return content.slice(0, outline[0]?.offset ?? content.length)
  const index = outline.indexOf(heading)
  const end = outline
    .slice(index + 1)
    .find((candidate) => candidate.level <= heading.level)?.offset ?? content.length
  return content.slice(heading.offset, end).trim()
}

function findMatches(content: string, query: string): SearchMatch[] {
  const normalizedQuery = query.toLocaleLowerCase()
  if (!normalizedQuery) return []
  const normalizedContent = content.toLocaleLowerCase()
  const matches: SearchMatch[] = []
  let cursor = 0
  while ((cursor = normalizedContent.indexOf(normalizedQuery, cursor)) !== -1) {
    matches.push({ from: cursor, to: cursor + query.length })
    cursor += Math.max(1, query.length)
  }
  return matches
}

function conflictKey(change: MarkdownExternalChange): string {
  return `${change.modifiedAt}:${change.content.length}:${change.content.slice(0, 24)}`
}

export function MarkdownViewer({
  value,
  documentId,
  fileName = 'Markdown 文档',
  className,
  readOnly = false,
  mode,
  defaultMode = 'both',
  autoSave = true,
  autoSaveDelayMs = 900,
  modifiedAt,
  externalChange,
  resolveAssetUrl,
  onOpenLink,
  onChange,
  onSave,
  onModeChange,
  onContextChange,
  onReadingStateChange,
  onResolveExternalChange,
  onError,
}: MarkdownViewerProps): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [internalMode, setInternalMode] = useState<MarkdownViewMode>(defaultMode)
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [cursor, setCursor] = useState(0)
  const [editorScrollTop, setEditorScrollTop] = useState(0)
  const [currentHeading, setCurrentHeading] = useState<MarkdownOutlineItem | undefined>()
  const [detectedConflict, setDetectedConflict] = useState<MarkdownExternalChange | null>(null)
  const [dismissedConflictKey, setDismissedConflictKey] = useState<string | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onErrorRef = useRef(onError)
  const onContextChangeRef = useRef(onContextChange)
  const onReadingStateChangeRef = useRef(onReadingStateChange)
  const draftRef = useRef(draft)
  const lastPropValueRef = useRef(value)
  const lastSavedValueRef = useRef(value)
  const saveSequenceRef = useRef(0)
  const documentIdentity = documentId ?? fileName
  const previousDocumentIdentityRef = useRef(documentIdentity)
  const effectiveMode = mode ?? internalMode
  const editorExtensions = useMemo(() => [markdown()], [])

  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onErrorRef.current = onError
  onContextChangeRef.current = onContextChange
  onReadingStateChangeRef.current = onReadingStateChange

  const outline = useMemo(() => parseOutline(draft), [draft])
  const searchMatches = useMemo(() => findMatches(draft, searchQuery.trim()), [draft, searchQuery])
  const pendingConflict = externalChange ?? detectedConflict
  const activeConflict =
    pendingConflict && conflictKey(pendingConflict) !== dismissedConflictKey ? pendingConflict : null
  const isDirty = draft !== lastSavedValueRef.current

  draftRef.current = draft

  useEffect(() => {
    if (previousDocumentIdentityRef.current === documentIdentity) return
    previousDocumentIdentityRef.current = documentIdentity
    lastPropValueRef.current = value
    lastSavedValueRef.current = value
    draftRef.current = value
    saveSequenceRef.current += 1
    setDraft(value)
    setInternalMode(defaultMode)
    setSaveStatus('idle')
    setSaveError(null)
    setSavedAt(null)
    setCursor(0)
    setEditorScrollTop(0)
    setDetectedConflict(null)
    setDismissedConflictKey(null)
    setCompareOpen(false)
    setSearchIndex(0)
  }, [defaultMode, documentIdentity, value])

  useEffect(() => {
    if (lastPropValueRef.current === value) return
    lastPropValueRef.current = value

    if (value === draftRef.current) {
      // This is usually the controlled-value echo from onChange. It confirms that
      // the parent accepted the edit, not that the file has reached disk.
      setDetectedConflict(null)
      return
    }

    if (draftRef.current !== lastSavedValueRef.current) {
      setDetectedConflict({ content: value, modifiedAt: modifiedAt ?? Date.now() })
      setCompareOpen(false)
      return
    }

    setDraft(value)
    draftRef.current = value
    lastSavedValueRef.current = value
    setSaveStatus('idle')
    setDetectedConflict(null)
  }, [modifiedAt, value])

  useEffect(() => {
    if (searchMatches.length === 0) setSearchIndex(0)
    else if (searchIndex >= searchMatches.length) setSearchIndex(searchMatches.length - 1)
  }, [searchIndex, searchMatches.length])

  const setViewMode = useCallback(
    (nextMode: MarkdownViewMode) => {
      if (mode === undefined) setInternalMode(nextMode)
      onModeChange?.(nextMode)
    },
    [mode, onModeChange],
  )

  const emitContext = useCallback(
    (nextCursor: number, selection: string, visibleText: string) => {
      const heading = headingAt(outline, nextCursor)
      setCurrentHeading(heading)
      const context: MarkdownViewerContext = {
        mode: effectiveMode,
        cursor: nextCursor,
        selection,
        heading,
        visibleText,
        sectionText: sectionAt(draftRef.current, outline, heading),
        documentText: draftRef.current,
      }
      onContextChangeRef.current?.(context)
    },
    [effectiveMode, outline],
  )

  useEffect(() => {
    const heading = headingAt(outline, cursor)
    setCurrentHeading(heading)
    onContextChangeRef.current?.({
      mode: effectiveMode,
      cursor,
      selection: '',
      heading,
      visibleText: sectionAt(draft, outline, heading).slice(0, 4000),
      sectionText: sectionAt(draft, outline, heading),
      documentText: draft,
    })
  }, []) // Initial context is emitted once; live updates are emitted by editor/preview events.

  const performSave = useCallback(
    async (
      reason: MarkdownSaveReason,
      content = draftRef.current,
      expectedModifiedAt = modifiedAt,
    ): Promise<void> => {
      if (!onSaveRef.current || readOnly) return
      const sequence = ++saveSequenceRef.current
      setSaveStatus('saving')
      setSaveError(null)
      try {
        await onSaveRef.current({ content, reason, expectedModifiedAt })
        lastSavedValueRef.current = content
        if (sequence === saveSequenceRef.current) {
          setSaveStatus(draftRef.current === content ? 'saved' : 'dirty')
          setSavedAt(Date.now())
        }
      } catch (reasonError) {
        const error = reasonError instanceof Error ? reasonError : new Error(String(reasonError))
        if (sequence === saveSequenceRef.current) {
          setSaveStatus('error')
          setSaveError(error.message)
        }
        onErrorRef.current?.(error)
      }
    },
    [modifiedAt, readOnly],
  )

  useEffect(() => {
    if (!autoSave || !onSave || readOnly || !isDirty || activeConflict) return
    const timeout = window.setTimeout(() => {
      void performSave('auto', draft)
    }, Math.max(250, autoSaveDelayMs))
    return () => window.clearTimeout(timeout)
  }, [activeConflict, autoSave, autoSaveDelayMs, draft, isDirty, onSave, performSave, readOnly])

  useEffect(() => {
    onReadingStateChangeRef.current?.({
      mode: effectiveMode,
      cursor,
      scrollTop: editorScrollTop,
    })
  }, [cursor, editorScrollTop, effectiveMode])

  const handleDraftChange = useCallback(
    (nextValue: string) => {
      setDraft(nextValue)
      draftRef.current = nextValue
      setSaveStatus(nextValue === lastSavedValueRef.current ? 'saved' : 'dirty')
      setSaveError(null)
      onChangeRef.current?.(nextValue)
    },
    [],
  )

  const jumpToOffset = useCallback((offset: number) => {
    const view = editorRef.current?.view
    if (view) {
      view.dispatch({ selection: { anchor: offset }, scrollIntoView: true })
      view.focus()
      return
    }
    const headingElement = previewRef.current?.querySelector<HTMLElement>(
      `[data-markdown-offset="${offset}"]`,
    )
    headingElement?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const jumpToSearchMatch = useCallback(
    (nextIndex: number) => {
      if (!searchMatches.length) return
      const normalizedIndex = (nextIndex + searchMatches.length) % searchMatches.length
      setSearchIndex(normalizedIndex)
      const match = searchMatches[normalizedIndex]
      const view = editorRef.current?.view
      if (view) {
        view.dispatch({
          selection: { anchor: match.from, head: match.to },
          scrollIntoView: true,
        })
        view.focus()
      } else {
        const heading = headingAt(outline, match.from)
        const element = heading
          ? previewRef.current?.querySelector<HTMLElement>(
              `[data-markdown-offset="${heading.offset}"]`,
            )
          : previewRef.current
        element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    },
    [outline, searchMatches],
  )

  const handleShortcut = useCallback(
    (event: React.KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey
      if (!modifier) return
      if (event.key.toLocaleLowerCase() === 's') {
        event.preventDefault()
        void performSave('manual')
      }
      if (event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault()
        setSearchOpen(true)
      }
    },
    [performSave],
  )

  const handlePreviewContext = useCallback(() => {
    const root = previewRef.current
    if (!root) return
    const browserSelection = window.getSelection()
    const selectedText = browserSelection?.toString().trim() ?? ''
    const anchorNode = browserSelection?.anchorNode
    const anchorElement = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement
    const headingElement = anchorElement?.closest<HTMLElement>('[data-markdown-offset]')
    const offset = Number(headingElement?.dataset.markdownOffset ?? currentHeading?.offset ?? 0)
    const heading = headingAt(outline, offset)
    const visibleText = sectionAt(draftRef.current, outline, heading).slice(0, 4000)
    setCursor(offset)
    emitContext(offset, selectedText, visibleText)
  }, [currentHeading?.offset, emitContext, outline])

  const handlePreviewScroll = useCallback(() => {
    const root = previewRef.current
    if (!root) return
    const headings = Array.from(root.querySelectorAll<HTMLElement>('[data-markdown-offset]'))
    const rootTop = root.getBoundingClientRect().top
    let activeOffset = 0
    for (const element of headings) {
      if (element.getBoundingClientRect().top - rootTop <= 72) {
        activeOffset = Number(element.dataset.markdownOffset ?? 0)
      } else break
    }
    const heading = headingAt(outline, activeOffset)
    setCursor(activeOffset)
    setEditorScrollTop(root.scrollTop)
    emitContext(activeOffset, '', sectionAt(draftRef.current, outline, heading).slice(0, 4000))
  }, [emitContext, outline])

  const markdownComponents = useMemo<Components>(() => {
    const headingProps = (node: { position?: { start?: { offset?: number } } } | undefined) => {
      const offset = node?.position?.start?.offset ?? 0
      const item = outline.find((candidate) => candidate.offset === offset)
      return {
        id: item?.id,
        'data-markdown-offset': offset,
      }
    }

    return {
      h1: ({ node, ...props }) => <h1 {...props} {...headingProps(node)} />,
      h2: ({ node, ...props }) => <h2 {...props} {...headingProps(node)} />,
      h3: ({ node, ...props }) => <h3 {...props} {...headingProps(node)} />,
      h4: ({ node, ...props }) => <h4 {...props} {...headingProps(node)} />,
      h5: ({ node, ...props }) => <h5 {...props} {...headingProps(node)} />,
      h6: ({ node, ...props }) => <h6 {...props} {...headingProps(node)} />,
      a: ({ node: _node, href, onClick: _onClick, ...props }) => (
        <a
          {...props}
          href={href}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            if (onOpenLink && href) {
              event.preventDefault()
              onOpenLink(href)
            }
          }}
        />
      ),
      pre: ({ node, children, ...props }) => {
        const codeNode = node?.children[0]
        if (codeNode?.type === 'element' && codeNode.tagName === 'code') {
          const classNames = codeNode.properties?.className
          const languages = Array.isArray(classNames) ? classNames.map(String) : [String(classNames ?? '')]
          if (languages.includes('language-mermaid')) {
            const source = codeNode.children
              .filter((child) => child.type === 'text')
              .map((child) => child.value)
              .join('')
              .replace(/\n$/, '')
            return <MermaidDiagram code={source} />
          }
        }
        return <pre {...props}>{children}</pre>
      },
    }
  }, [onOpenLink, outline])

  const resolveConflict = useCallback(
    (resolution: 'use-external' | 'keep-local') => {
      if (!activeConflict) return
      if (resolution === 'use-external') {
        setDraft(activeConflict.content)
        draftRef.current = activeConflict.content
        lastSavedValueRef.current = activeConflict.content
        lastPropValueRef.current = activeConflict.content
        setSaveStatus('saved')
        setDetectedConflict(null)
        onChange?.(activeConflict.content)
      } else {
        setSaveStatus('dirty')
      }
      setDismissedConflictKey(conflictKey(activeConflict))
      setCompareOpen(false)
      onResolveExternalChange?.(resolution, activeConflict, draftRef.current)
    },
    [activeConflict, onChange, onResolveExternalChange],
  )

  return (
    <section
      className={cx('vk-viewer', 'vk-markdown-viewer', className)}
      aria-label={`${fileName} Markdown 编辑器`}
      onKeyDownCapture={handleShortcut}
    >
      <header className="vk-viewer-toolbar vk-markdown-toolbar">
        <div className="vk-viewer-toolbar-group">
          <IconButton
            label={outlineOpen ? '隐藏大纲' : '显示大纲'}
            active={outlineOpen}
            onClick={() => setOutlineOpen((open) => !open)}
          >
            <ListTree size={17} />
          </IconButton>
          <IconButton
            label="查找"
            active={searchOpen}
            onClick={() => setSearchOpen((open) => !open)}
          >
            <Search size={17} />
          </IconButton>
          <ToolbarDivider />
          <IconButton label="撤销" disabled={readOnly} onClick={() => editorRef.current?.view && undo(editorRef.current.view)}>
            <Undo2 size={17} />
          </IconButton>
          <IconButton label="重做" disabled={readOnly} onClick={() => editorRef.current?.view && redo(editorRef.current.view)}>
            <Redo2 size={17} />
          </IconButton>
        </div>

        <div className="vk-markdown-mode-switch" role="group" aria-label="Markdown 显示方式">
          <button
            type="button"
            className={cx(effectiveMode === 'edit' && 'is-active')}
            aria-pressed={effectiveMode === 'edit'}
            onClick={() => setViewMode('edit')}
          >
            <PencilLine size={15} /> 编辑
          </button>
          <button
            type="button"
            className={cx(effectiveMode === 'preview' && 'is-active')}
            aria-pressed={effectiveMode === 'preview'}
            onClick={() => setViewMode('preview')}
          >
            <Eye size={15} /> 预览
          </button>
          <button
            type="button"
            className={cx(effectiveMode === 'both' && 'is-active')}
            aria-pressed={effectiveMode === 'both'}
            onClick={() => setViewMode('both')}
          >
            <Columns2 size={15} /> 双栏
          </button>
        </div>

        <div className="vk-viewer-toolbar-group vk-markdown-save-group">
          <span className={cx('vk-markdown-save-status', `is-${saveStatus}`)} role="status">
            {saveStatus === 'saving' && '正在保存…'}
            {saveStatus === 'dirty' && (autoSave ? '等待自动保存' : '有未保存修改')}
            {saveStatus === 'saved' && (
              <><Check size={13} /> 已保存{savedAt ? ` ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</>
            )}
            {saveStatus === 'error' && <><AlertTriangle size={13} /> {saveError || '保存失败'}</>}
            {saveStatus === 'idle' && (readOnly ? '只读' : '未修改')}
          </span>
          <button
            type="button"
            className="vk-viewer-text-button is-emphasis"
            disabled={readOnly || !onSave || saveStatus === 'saving'}
            onClick={() => void performSave('manual')}
          >
            <Save size={15} /> 保存
          </button>
        </div>
      </header>

      {searchOpen && (
        <div className="vk-markdown-search-bar" role="search">
          <label className="vk-viewer-search-field">
            <Search size={15} aria-hidden="true" />
            <input
              autoFocus
              value={searchQuery}
              placeholder="在文档中查找"
              aria-label="在 Markdown 中查找"
              onChange={(event) => {
                setSearchQuery(event.target.value)
                setSearchIndex(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  jumpToSearchMatch(searchIndex + (event.shiftKey ? -1 : 1))
                }
                if (event.key === 'Escape') setSearchOpen(false)
              }}
            />
          </label>
          <span className="vk-markdown-search-count">
            {searchMatches.length ? `${searchIndex + 1} / ${searchMatches.length}` : searchQuery ? '0 / 0' : '—'}
          </span>
          <IconButton label="上一个匹配" compact disabled={!searchMatches.length} onClick={() => jumpToSearchMatch(searchIndex - 1)}>
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton label="下一个匹配" compact disabled={!searchMatches.length} onClick={() => jumpToSearchMatch(searchIndex + 1)}>
            <ChevronRight size={15} />
          </IconButton>
          <IconButton label="关闭查找" compact onClick={() => setSearchOpen(false)}>
            <X size={14} />
          </IconButton>
        </div>
      )}

      {activeConflict && (
        <div className="vk-markdown-conflict" role="alert">
          <div className="vk-markdown-conflict-summary">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <strong>磁盘上的文件已被其他程序修改</strong>
              <span>为避免覆盖内容，自动保存已暂停。请选择要保留的版本。</span>
            </div>
            <button type="button" className="vk-viewer-text-button" onClick={() => setCompareOpen((open) => !open)}>
              <FileDiff size={15} /> {compareOpen ? '收起对比' : '查看对比'} <ChevronDown size={14} />
            </button>
            <button type="button" className="vk-viewer-text-button" onClick={() => resolveConflict('keep-local')}>
              保留我的编辑
            </button>
            <button type="button" className="vk-viewer-text-button is-emphasis" onClick={() => resolveConflict('use-external')}>
              载入磁盘版本
            </button>
          </div>
          {compareOpen && (
            <div className="vk-markdown-conflict-compare">
              <section>
                <header>我的编辑 <small>{draft.length.toLocaleString()} 字符</small></header>
                <pre>{draft}</pre>
              </section>
              <section>
                <header>磁盘版本 <small>{activeConflict.content.length.toLocaleString()} 字符</small></header>
                <pre>{activeConflict.content}</pre>
              </section>
            </div>
          )}
        </div>
      )}

      <div className="vk-markdown-body">
        {outlineOpen && (
          <aside className="vk-markdown-outline" aria-label="Markdown 大纲">
            <div className="vk-markdown-outline-heading">
              <strong>文档大纲</strong>
              <span>{outline.length} 个标题</span>
            </div>
            <nav>
              {outline.length === 0 && <p className="vk-viewer-muted">添加标题后，大纲会显示在这里。</p>}
              {outline.map((item) => (
                <button
                  type="button"
                  key={`${item.id}-${item.offset}`}
                  className={cx(currentHeading?.offset === item.offset && 'is-active')}
                  style={{ paddingInlineStart: 12 + (item.level - 1) * 12 }}
                  onClick={() => jumpToOffset(item.offset)}
                >
                  <span>{item.text}</span>
                  <small>H{item.level}</small>
                </button>
              ))}
            </nav>
          </aside>
        )}

        <div className={cx('vk-markdown-content', `is-${effectiveMode}`)}>
          {(effectiveMode === 'edit' || effectiveMode === 'both') && (
            <div className="vk-markdown-editor" aria-label="Markdown 源码编辑区">
              <CodeMirror
                ref={editorRef}
                value={draft}
                height="100%"
                editable={!readOnly}
                extensions={editorExtensions}
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: true,
                  highlightActiveLine: true,
                  highlightActiveLineGutter: true,
                  bracketMatching: true,
                  closeBrackets: true,
                  autocompletion: true,
                }}
                onChange={handleDraftChange}
                onUpdate={(update) => {
                  if (!update.docChanged && !update.selectionSet && !update.viewportChanged) return
                  const main = update.state.selection.main
                  const selected = update.state.sliceDoc(main.from, main.to)
                  const visibleText = update.view.visibleRanges
                    .map((range) => update.state.sliceDoc(range.from, range.to))
                    .join('\n')
                  setCursor(main.head)
                  setEditorScrollTop(update.view.scrollDOM.scrollTop)
                  emitContext(main.head, selected, visibleText)
                }}
              />
            </div>
          )}

          {(effectiveMode === 'preview' || effectiveMode === 'both') && (
            <article
              ref={previewRef}
              className="vk-markdown-preview"
              aria-label="Markdown 预览"
              onMouseUp={handlePreviewContext}
              onScroll={handlePreviewScroll}
            >
              {draft.trim() ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                  components={markdownComponents}
                  urlTransform={(url, key) => key === 'src' ? (resolveAssetUrl?.(url) ?? url) : url}
                >
                  {draft}
                </ReactMarkdown>
              ) : (
                <div className="vk-markdown-empty-preview">
                  <PencilLine size={22} />
                  <strong>这篇笔记还是空的</strong>
                  <span>在编辑区输入 Markdown，预览会实时出现在这里。</span>
                </div>
              )}
            </article>
          )}
        </div>
      </div>
    </section>
  )
}
