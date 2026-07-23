import { useMemo, useState } from 'react'
import { ArrowLeft, FilePlus2, FolderPlus, Highlighter, MessageSquarePlus, PanelLeftClose, RefreshCw, Search, X } from 'lucide-react'
import type { AiOperationHistoryEntry, Annotation, ChatSession, FileNode, PluginPermission, SearchProgress, SearchResult, WorkspaceState } from '../../shared/types'
import { PluginCatalogView } from '../../plugins'
import '../../styles/plugins.css'
import { FileTree } from './FileTree'
import { ProjectMemoryView } from './ProjectMemoryView'
import { OperationHistoryView } from './OperationHistoryView'

type NavSection = WorkspaceState['navSection']

interface ProjectNavigatorProps {
  section: NavSection
  projectName: string
  projectPath: string
  tree: FileNode[]
  activePath?: string
  sessions: ChatSession[]
  currentSessionId: string | null
  annotations: Annotation[]
  searchQuery: string
  searchResults: SearchResult[]
  searchProgress?: SearchProgress | null
  onCloseProject: () => void
  onRefresh: () => void
  onCreateMarkdown: () => void
  onCreateFolder: () => void
  onOpenNode: (node: FileNode) => void
  onRenameNode: (node: FileNode) => void
  onMoveNode: (node: FileNode) => void
  onTrashNode: (node: FileNode) => void
  onRevealNode: (node: FileNode) => void
  onImportFiles: (files: File[], targetFolder: string) => void
  onMovePath: (path: string, targetFolder: string) => void
  onNewSession: () => void
  onSelectSession: (id: string) => void
  onRenameSession: (id: string, title: string) => void
  onDeleteSession: (id: string) => void
  onSearch: (query: string) => void
  onOpenSearchResult: (result: SearchResult) => void
  onOpenAnnotation: (annotation: Annotation) => void
  onDeleteAnnotation: (annotation: Annotation) => void
  onOpenMemory: (path: string) => void
  onMemorySaved: () => void | Promise<void>
  onSendMemoryToAi: (prompt: string) => void
  operationHistory: AiOperationHistoryEntry[]
  undoingOperationId: string | null
  onUndoOperation: (entry: AiOperationHistoryEntry) => void | Promise<void>
  enabledPluginIds: string[]
  pluginGrants: Record<string, PluginPermission[]>
  activePluginId: string | null
  onOpenPlugin: (pluginId: string) => void
  onTogglePlugin: (pluginId: string, enabled: boolean) => void | Promise<void>
  onClose: () => void
}

const sectionLabels: Record<NavSection, string> = {
  files: '文件',
  sessions: '会话',
  search: '项目搜索',
  annotations: '标注',
  memory: '项目记忆',
  operations: 'AI 操作记录',
  plugins: '插件中心'
}

function relativeTime(value: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function SessionsView({ sessions, currentId, onNew, onSelect, onRename, onDelete }: {
  sessions: ChatSession[]
  currentId: string | null
  onNew: () => void
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  const beginRename = (session: ChatSession): void => { setRenaming(session.id); setTitle(session.title) }
  return (
    <div className="session-list-wrap">
      <button className="navigator-primary-action" onClick={onNew}><MessageSquarePlus size={15} />新建会话</button>
      {sorted.length === 0 ? <div className="empty-state"><MessageSquarePlus size={23} /><strong>还没有会话</strong><span>创建一个独立会话，从当前内容开始提问。</span></div> : (
        <div className="session-list" role="listbox" aria-label="项目会话">
          {sorted.map((session) => (
            <div key={session.id} className={`session-row ${currentId === session.id ? 'is-active' : ''}`} role="option" aria-selected={currentId === session.id} onClick={() => onSelect(session.id)}>
              {renaming === session.id ? (
                <input className="session-row__input" value={title} autoFocus onClick={(event) => event.stopPropagation()} onChange={(event) => setTitle(event.target.value)} onBlur={() => { if (title.trim()) onRename(session.id, title.trim()); setRenaming(null) }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setRenaming(null) }} />
              ) : <><strong>{session.title}</strong><small>{session.messages.length} 条消息 · {relativeTime(session.updatedAt)}</small></>}
              <div className="session-row__actions"><button onClick={(event) => { event.stopPropagation(); beginRename(session) }}>重命名</button><button onClick={(event) => { event.stopPropagation(); onDelete(session.id) }} aria-label={`删除 ${session.title}`}><X size={13} /></button></div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SearchView({ query, results, progress, onSearch, onOpen }: { query: string; results: SearchResult[]; progress?: SearchProgress | null; onSearch: (query: string) => void; onOpen: (result: SearchResult) => void }): React.JSX.Element {
  const [value, setValue] = useState(query)
  const grouped = useMemo(() => ({ files: results.filter((item) => item.type !== 'session'), sessions: results.filter((item) => item.type === 'session') }), [results])
  return (
    <div className="navigator-search">
      <form className="navigator-search__input" onSubmit={(event) => { event.preventDefault(); onSearch(value.trim()) }}><Search size={14} /><input value={value} onChange={(event) => setValue(event.target.value)} placeholder="搜索文件、正文和会话" aria-label="搜索当前项目" /><kbd>↵</kbd></form>
      {progress && !progress.done && <div className="search-progress"><span style={{ width: progress.total ? `${Math.min(100, progress.scanned / progress.total * 100)}%` : '35%' }} /><small>正在读取 {progress.current ?? '项目内容'}…</small></div>}
      {!query ? <div className="empty-state"><Search size={23} /><strong>搜索当前项目</strong><span>查找文件名、Markdown、文本、PDF 正文和会话。</span></div> : results.length === 0 && (!progress || progress.done) ? <div className="empty-state"><Search size={23} /><strong>没有找到“{query}”</strong><span>试试更短或不同的关键词。</span></div> : (
        <div className="search-results">
          {grouped.files.length > 0 && <section><h3>文件内容 <span>{grouped.files.length}</span></h3>{grouped.files.map((result) => <SearchResultRow key={result.id} result={result} onOpen={onOpen} />)}</section>}
          {grouped.sessions.length > 0 && <section><h3>会话 <span>{grouped.sessions.length}</span></h3>{grouped.sessions.map((result) => <SearchResultRow key={result.id} result={result} onOpen={onOpen} />)}</section>}
        </div>
      )}
    </div>
  )
}

function SearchResultRow({ result, onOpen }: { result: SearchResult; onOpen: (result: SearchResult) => void }): React.JSX.Element {
  return <button className="search-result" onClick={() => onOpen(result)}><strong>{result.title}</strong><p>{result.excerpt}</p><small>{result.page ? `第 ${result.page} 页` : result.heading || (result.line ? `第 ${result.line} 行` : result.path || '会话')}</small></button>
}

function AnnotationsView({ annotations, onOpen, onDelete }: { annotations: Annotation[]; onOpen: (item: Annotation) => void; onDelete: (item: Annotation) => void }): React.JSX.Element {
  const grouped = useMemo(() => annotations.reduce<Record<string, Annotation[]>>((all, item) => { (all[item.path] ??= []).push(item); return all }, {}), [annotations])
  if (!annotations.length) return <div className="empty-state"><Highlighter size={23} /><strong>还没有标注</strong><span>在 PDF 中选择文字即可添加高亮和批注。</span></div>
  return <div className="annotation-list">{Object.entries(grouped).map(([path, items]) => <section key={path}><h3>{path.split('/').pop()}</h3>{items.sort((a, b) => a.page - b.page).map((item) => <div className="annotation-row" key={item.id} onClick={() => onOpen(item)}><span className={`annotation-swatch is-${item.color ?? 'amber'}`} /><div><strong>{item.kind === 'bookmark' ? `第 ${item.page} 页书签` : item.quote || item.comment || '标注'}</strong><small>第 {item.page} 页 · {relativeTime(item.createdAt)}</small></div><button className="icon-button" onClick={(event) => { event.stopPropagation(); onDelete(item) }} aria-label="删除标注"><X size={13} /></button></div>)}</section>)}</div>
}

export function ProjectNavigator(props: ProjectNavigatorProps): React.JSX.Element {
  return (
    <aside className="project-navigator" aria-label={`项目${sectionLabels[props.section]}`}>
      <header className="navigator-project-header">
        <button className="icon-button" onClick={props.onCloseProject} aria-label="返回首页" title="返回首页"><ArrowLeft size={16} /></button>
        <div><strong title={props.projectName}>{props.projectName}</strong><small title={props.projectPath}>{props.projectPath}</small></div>
      </header>
      <div className="navigator-section-header">
        <h2>{sectionLabels[props.section]}</h2>
        <div>
          {props.section === 'files' && <><button className="icon-button" onClick={props.onCreateMarkdown} aria-label="新建 Markdown" title="新建 Markdown"><FilePlus2 size={15} /></button><button className="icon-button" onClick={props.onCreateFolder} aria-label="新建文件夹" title="新建文件夹"><FolderPlus size={15} /></button><button className="icon-button" onClick={props.onRefresh} aria-label="刷新文件树" title="刷新"><RefreshCw size={15} /></button></>}
          <button className="icon-button" onClick={props.onClose} aria-label="收起左侧栏" title="收起左侧栏"><PanelLeftClose size={15} /></button>
        </div>
      </div>
      <div className="navigator-content">
        {props.section === 'files' && (props.tree.length ? <FileTree nodes={props.tree} activePath={props.activePath} onOpen={props.onOpenNode} onRename={props.onRenameNode} onMove={props.onMoveNode} onTrash={props.onTrashNode} onReveal={props.onRevealNode} onImport={props.onImportFiles} onMovePath={props.onMovePath} /> : <div className="empty-state"><FilePlus2 size={23} /><strong>这个项目文件夹没有文件</strong><span>新建项目会创建空目录；已有 Markdown 请从首页使用“打开已有文件夹”。</span><button className="secondary-button" onClick={props.onCreateMarkdown}>新建 Markdown</button></div>)}
        {props.section === 'sessions' && <SessionsView sessions={props.sessions} currentId={props.currentSessionId} onNew={props.onNewSession} onSelect={props.onSelectSession} onRename={props.onRenameSession} onDelete={props.onDeleteSession} />}
        {props.section === 'search' && <SearchView query={props.searchQuery} results={props.searchResults} progress={props.searchProgress} onSearch={props.onSearch} onOpen={props.onOpenSearchResult} />}
        {props.section === 'annotations' && <AnnotationsView annotations={props.annotations} onOpen={props.onOpenAnnotation} onDelete={props.onDeleteAnnotation} />}
        {props.section === 'memory' && <ProjectMemoryView projectPath={props.projectPath} onOpen={props.onOpenMemory} onSaved={props.onMemorySaved} onSendToAi={props.onSendMemoryToAi} />}
        {props.section === 'operations' && <OperationHistoryView entries={props.operationHistory} undoingId={props.undoingOperationId} onUndo={props.onUndoOperation} onOpen={props.onOpenMemory} />}
        {props.section === 'plugins' && <PluginCatalogView enabledPluginIds={props.enabledPluginIds} pluginGrants={props.pluginGrants} activePluginId={props.activePluginId} onOpen={props.onOpenPlugin} onToggle={props.onTogglePlugin} />}
      </div>
    </aside>
  )
}
