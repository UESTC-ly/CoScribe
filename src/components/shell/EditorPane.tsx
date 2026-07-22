import { lazy, Suspense, useEffect } from 'react'
import { AlertTriangle, BookOpenText } from 'lucide-react'
import type { DocumentBuffer, DocumentContextState } from '../../store'
import type {
  Annotation,
  AppSettings,
  FileReadResult,
  OpenTab,
  PaneId,
  WorkspaceState
} from '../../shared/types'
import { resolveProjectAssetUrl, resolveProjectFilePath } from '../../lib'
import type {
  MarkdownConflictResolution,
  MarkdownSaveRequest,
  PdfTextSelection,
  PdfViewerAnnotation
} from '../viewers/types'
import { TabStrip } from './TabStrip'

const ImageViewer = lazy(() => import('../viewers/ImageViewer').then((module) => ({ default: module.ImageViewer })))
const DocxViewer = lazy(() => import('../viewers/DocxViewer').then((module) => ({ default: module.DocxViewer })))
const MarkdownViewer = lazy(() => import('../viewers/MarkdownViewer').then((module) => ({ default: module.MarkdownViewer })))
const PdfViewer = lazy(() => import('../viewers/PdfViewer').then((module) => ({ default: module.PdfViewer })))
const PptxViewer = lazy(() => import('../viewers/PptxViewer').then((module) => ({ default: module.PptxViewer })))
const TextViewer = lazy(() => import('../viewers/TextViewer').then((module) => ({ default: module.TextViewer })))
const UnsupportedViewer = lazy(() => import('../viewers/UnsupportedViewer').then((module) => ({ default: module.UnsupportedViewer })))

interface EditorPaneProps {
  projectPath: string
  pane: PaneId
  tabs: OpenTab[]
  activeTabId: string | null
  focused: boolean
  workspace: WorkspaceState
  documents: Record<string, DocumentBuffer>
  annotations: Annotation[]
  settings: AppSettings
  dirtyPaths: Set<string>
  onFocus: () => void
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onDropTab: (tabId: string, targetPane: PaneId, beforeTabId?: string) => void
  onEnsureDocument: (tab: OpenTab) => Promise<void>
  onUpdateDocument: (path: string, content: string) => void
  onSaveMarkdown: (tab: OpenTab, request: MarkdownSaveRequest) => Promise<FileReadResult>
  onPdfState: (path: string, state: WorkspaceState['pdf'][string]) => void
  onMarkdownState: (path: string, state: WorkspaceState['markdown'][string]) => void
  onContext: (path: string, patch: Partial<Omit<DocumentContextState, 'updatedAt'>>) => void
  onAddAnnotation: (annotation: Annotation) => void
  onDeleteAnnotation: (annotationId: string) => void
  onRequestComment: (path: string, selection: PdfTextSelection) => void
  onReveal: (path: string) => void
  onOpenExternal: (path: string) => void
  onOpenProjectPath: (path: string) => void
  onConvertPowerPoint: (path: string) => Promise<void>
  onResolveConflict: (path: string, resolution: MarkdownConflictResolution) => void
  onError: (message: string) => void
}

function extension(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.includes('.') ? name.split('.').pop() ?? '' : ''
}

export function EditorPane(props: EditorPaneProps): React.JSX.Element {
  const activeTab = props.tabs.find((tab) => tab.id === props.activeTabId)
  const document = activeTab ? props.documents[activeTab.path] : undefined

  useEffect(() => {
    if (activeTab && !activeTab.missing && !document) void props.onEnsureDocument(activeTab)
  }, [activeTab, document, props.onEnsureDocument])

  const renderContent = (): React.ReactNode => {
    if (!activeTab) {
      return (
        <div className="editor-empty">
          <span className="editor-empty__mark"><BookOpenText size={27} strokeWidth={1.6} /></span>
          <strong>{props.pane === 'secondary' ? '第二个内容区域' : '打开项目内容'}</strong>
          <p>{props.pane === 'secondary' ? '把标签拖到这里，或从来源跳转打开。' : '从左侧文件树选择 PDF、DOCX、PPTX、Markdown、文本或图片。'}</p>
        </div>
      )
    }
    if (activeTab.missing) return <div className="missing-file"><AlertTriangle size={25} /><strong>文件已被移动或删除</strong><span>{activeTab.path}</span><button className="secondary-button" onClick={() => props.onClose(activeTab.id)}>关闭失效标签</button></div>
    if (!document) return <div className="empty-state"><span className="viewer-spinner" /><strong>正在打开 {activeTab.name}</strong></div>

    if (activeTab.kind === 'pdf') {
      const pdfState = props.workspace.pdf[activeTab.path]
      const pdfAnnotations: PdfViewerAnnotation[] = props.annotations.filter((item) => item.path === activeTab.path).map((item) => ({
        id: item.id,
        page: item.page,
        kind: item.kind,
        quote: item.quote,
        comment: item.comment,
        color: item.color
      }))
      return (
        <PdfViewer
          file={document.url ?? ''}
          filePath={activeTab.path}
          sourceModifiedAt={document.modifiedAt}
          sourceSize={document.size}
          fileName={activeTab.name}
          annotations={pdfAnnotations}
          initialReadingState={pdfState}
          readingState={pdfState}
          onReadingStateChange={(state) => props.onPdfState(activeTab.path, { page: state.page, scale: state.scale, fit: state.fit, scrollTop: state.scrollTop })}
          onContextChange={(context) => props.onContext(activeTab.path, {
            pdfPage: context.page,
            visiblePages: context.visiblePages,
            selection: context.selection?.text,
            visibleText: context.readable ? context.pageText : '',
            sectionText: context.readable ? [context.pageText, context.adjacentText].filter(Boolean).join('\n\n') : ''
          })}
          onSelectionChange={(selection) => props.onContext(activeTab.path, { selection: selection?.text ?? '' })}
          onCreateHighlight={(selection, color) => props.onAddAnnotation({ id: crypto.randomUUID(), path: activeTab.path, page: selection.page, kind: 'highlight', quote: selection.text, color, createdAt: Date.now() })}
          onCreateComment={(selection) => props.onRequestComment(activeTab.path, selection)}
          onToggleBookmark={(page, bookmarked) => {
            const existing = props.annotations.find((item) => item.path === activeTab.path && item.kind === 'bookmark' && item.page === page)
            if (!bookmarked && existing) props.onDeleteAnnotation(existing.id)
            if (bookmarked && !existing) props.onAddAnnotation({ id: crypto.randomUUID(), path: activeTab.path, page, kind: 'bookmark', createdAt: Date.now() })
          }}
          onError={(error) => props.onError(`无法打开 PDF：${error.message}`)}
        />
      )
    }

    if (activeTab.kind === 'markdown') {
      const markdownState = props.workspace.markdown[activeTab.path]
      return (
        <MarkdownViewer
          documentId={activeTab.path}
          value={document.content}
          fileName={activeTab.name}
          modifiedAt={document.modifiedAt}
          defaultMode={markdownState?.mode ?? 'preview'}
          mode={markdownState?.mode}
          outlineWidth={markdownState?.outlineWidth}
          autoSave={props.settings.autoSave}
          autoSaveDelayMs={props.settings.autoSaveDelay}
          externalChange={document.externalVersion ? { content: document.externalVersion.content, modifiedAt: document.externalVersion.modifiedAt } : null}
          resolveAssetUrl={(url) => resolveProjectAssetUrl(props.projectPath, activeTab.path, url)}
          onOpenLink={(url) => {
            const target = resolveProjectFilePath(props.projectPath, activeTab.path, url)
            if (target) props.onOpenProjectPath(target)
            else if (/^(?:https?:|mailto:)/iu.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
          }}
          onChange={(content) => props.onUpdateDocument(activeTab.path, content)}
          onSave={(request) => props.onSaveMarkdown(activeTab, request).then(() => undefined)}
          onModeChange={(mode) => props.onMarkdownState(activeTab.path, { scrollTop: markdownState?.scrollTop ?? 0, cursor: markdownState?.cursor ?? 0, mode })}
          onReadingStateChange={(state) => props.onMarkdownState(activeTab.path, state)}
          onContextChange={(context) => props.onContext(activeTab.path, {
            selection: context.selection,
            visibleText: context.visibleText,
            sectionText: context.sectionText,
            documentText: context.documentText,
            markdownHeading: context.heading?.text
          })}
          onResolveExternalChange={(resolution) => props.onResolveConflict(activeTab.path, resolution)}
          onError={(error) => props.onError(`Markdown 编辑器错误：${error.message}`)}
        />
      )
    }

    if (activeTab.kind === 'image') {
      return (
        <ImageViewer
          src={document.url ?? ''}
          filePath={activeTab.path}
          sourceModifiedAt={document.modifiedAt}
          sourceSize={document.size}
          fileName={activeTab.name}
          onOcrTextChange={(text) => props.onContext(activeTab.path, {
            visibleText: text,
            sectionText: text,
            documentText: text
          })}
          onOpenExternal={() => props.onOpenExternal(activeTab.path)}
          onError={(error) => props.onError(`无法显示图片：${error.message}`)}
        />
      )
    }

    if (activeTab.kind === 'docx') {
      return (
        <DocxViewer
          html={document.html ?? ''}
          text={document.content}
          fileName={activeTab.name}
          warnings={document.warnings}
          onContextChange={(context) => props.onContext(activeTab.path, context)}
          onOpenLink={(url) => {
            const target = resolveProjectFilePath(props.projectPath, activeTab.path, url)
            if (target) props.onOpenProjectPath(target)
            else if (/^(?:https?:|mailto:)/iu.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
          }}
          onOpenExternal={() => props.onOpenExternal(activeTab.path)}
        />
      )
    }

    if (activeTab.kind === 'pptx') {
      return (
        <PptxViewer
          src={document.url ?? ''}
          text={document.content}
          fileName={activeTab.name}
          onContextChange={(context) => props.onContext(activeTab.path, {
            selection: context.selection,
            visibleText: context.visibleText,
            documentText: context.documentText,
            sectionText: context.visibleText
          })}
          onOpenExternal={() => props.onOpenExternal(activeTab.path)}
          onError={(error) => props.onError(`无法打开 PowerPoint：${error.message}`)}
        />
      )
    }

    if (activeTab.kind === 'ppt') {
      return (
        <UnsupportedViewer
          fileName={activeTab.name}
          extension="ppt"
          detail={document.warnings?.[0] ?? '旧版二进制 PPT 需要先用 PowerPoint 或 LibreOffice 转换为 PPTX/PDF。'}
          onReveal={() => props.onReveal(activeTab.path)}
          onOpenExternal={() => props.onOpenExternal(activeTab.path)}
          onConvertToPdf={() => props.onConvertPowerPoint(activeTab.path)}
        />
      )
    }

    if (activeTab.kind === 'webarchive') {
      return (
        <UnsupportedViewer
          fileName={activeTab.name}
          extension={extension(activeTab.path)}
          detail={<>这是由 Chromium 保存的完整网页归档，保留原始 HTML、样式和已加载资源，不受 AI 正文长度限制。请使用系统浏览器或支持 MHTML 的应用查看。</>}
          onReveal={() => props.onReveal(activeTab.path)}
          onOpenExternal={() => props.onOpenExternal(activeTab.path)}
        />
      )
    }

    if (activeTab.kind === 'text') {
      return <TextViewer content={document.content} fileName={activeTab.name} onContextChange={(context) => props.onContext(activeTab.path, { selection: context.selection, visibleText: context.visibleText, documentText: document.content })} />
    }

    return <UnsupportedViewer fileName={activeTab.name} extension={extension(activeTab.path)} onReveal={() => props.onReveal(activeTab.path)} onOpenExternal={() => props.onOpenExternal(activeTab.path)} />
  }

  return (
    <section className={`editor-group ${props.focused ? 'is-focused' : ''}`} onMouseDown={props.onFocus} aria-label={`${props.pane === 'primary' ? '主' : '第二'}内容区域`}>
      <TabStrip pane={props.pane} tabs={props.tabs} activeId={props.activeTabId} dirtyPaths={props.dirtyPaths} onActivate={props.onActivate} onClose={props.onClose} onDropTab={props.onDropTab} />
      <div className="editor-group-content" role="tabpanel">
        <Suspense fallback={<div className="empty-state"><span className="viewer-spinner" /><strong>正在载入阅读器…</strong></div>}>
          {renderContent()}
        </Suspense>
      </div>
    </section>
  )
}
