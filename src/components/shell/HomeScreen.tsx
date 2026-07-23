import { useMemo, useState } from 'react'
import { AlertTriangle, BookOpenText, CircleHelp, FolderOpen, Plus, Settings } from 'lucide-react'
import type { ProjectRef } from '../../shared/types'
import { Dialog } from './Dialog'

interface HomeScreenProps {
  recentProjects: ProjectRef[]
  defaultParentPath?: string
  busy?: boolean
  error?: string | null
  onCreate: (name: string, parentPath: string) => Promise<void> | void
  onChooseLocation: () => Promise<string | null>
  onOpenFolder: () => Promise<void> | void
  onOpenRecent: (path: string) => Promise<void> | void
  onOpenGuide: () => void
  onOpenSettings: () => void
}

function formatOpenedAt(timestamp: number): string {
  const value = new Date(timestamp)
  const now = new Date()
  const sameDay = value.toDateString() === now.toDateString()
  return sameDay
    ? `今天 ${value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : value.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function HomeScreen(props: HomeScreenProps): React.JSX.Element {
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [parentPath, setParentPath] = useState(props.defaultParentPath ?? '')
  const targetPath = useMemo(() => parentPath && name.trim() ? `${parentPath.replace(/[\\/]$/, '')}/${name.trim()}` : '', [name, parentPath])

  const pickParent = async (): Promise<void> => {
    const selected = await props.onChooseLocation()
    if (selected) setParentPath(selected)
  }

  const create = async (): Promise<void> => {
    if (!name.trim() || !parentPath) return
    await props.onCreate(name.trim(), parentPath)
    setCreateOpen(false)
    setName('')
  }

  return (
    <main className="home-screen">
      <header className="home-titlebar">
        <button className="icon-button" onClick={props.onOpenGuide} aria-label="使用指南" title="使用指南"><CircleHelp size={17} /></button>
        <button className="icon-button" onClick={props.onOpenSettings} aria-label="设置" title="设置"><Settings size={17} /></button>
      </header>
      <section className="home-content">
        <div className="home-brand">
          <span className="home-brand__mark"><BookOpenText size={23} strokeWidth={1.8} /></span>
          <div><h1>CoScribe</h1><p>在本地项目里阅读、思考与沉淀</p></div>
        </div>
        <div className="home-actions">
          <button className="primary-button home-action" onClick={() => setCreateOpen(true)} disabled={props.busy}><Plus size={16} />新建项目</button>
          <button className="secondary-button home-action" onClick={() => void props.onOpenFolder()} disabled={props.busy}><FolderOpen size={16} />打开已有文件夹</button>
        </div>
        {props.error && <div className="home-error"><AlertTriangle size={15} />{props.error}</div>}
        <section className="recent-projects" aria-labelledby="recent-heading">
          <header><h2 id="recent-heading">最近项目</h2><span>{props.recentProjects.length ? `${props.recentProjects.length} 个本地文件夹` : '项目就是普通本地文件夹'}</span></header>
          {props.recentProjects.length === 0 ? (
            <div className="home-empty"><FolderOpen size={26} /><strong>还没有打开过项目</strong><p>新建一个空文件夹开始学习，或直接打开已有资料目录。</p></div>
          ) : (
            <div className="recent-list">
              {props.recentProjects.map((project) => (
                <button key={project.path} className="recent-row" onClick={() => project.exists && void props.onOpenRecent(project.path)} disabled={!project.exists || props.busy}>
                  <span className="recent-row__icon">{project.exists ? <FolderOpen size={17} /> : <AlertTriangle size={17} />}</span>
                  <span className="recent-row__main"><strong>{project.name}</strong><small>{project.exists ? project.path : '找不到项目文件夹，它可能已被移动或删除。'}</small></span>
                  <time>{project.exists ? formatOpenedAt(project.openedAt) : '路径不可用'}</time>
                </button>
              ))}
            </div>
          )}
        </section>
        <footer className="home-footnote">文件保留在你的设备上 · 不需要登录</footer>
      </section>
      <Dialog
        open={createOpen}
        title="新建项目"
        description="会创建一个普通文件夹，并加入可删除的“CoScribe 使用指南.md”。已有 Markdown 或子文件夹时，请使用“打开已有文件夹”。"
        onClose={() => setCreateOpen(false)}
        footer={<><button className="secondary-button" onClick={() => setCreateOpen(false)}>取消</button><button className="primary-button" disabled={!name.trim() || !parentPath || props.busy} onClick={() => void create()}>创建并打开</button></>}
      >
        <div className="form-stack">
          <label className="field-label">项目名称<input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：FastAPI 学习" /></label>
          <label className="field-label">保存位置（父文件夹）<div className="field-with-button"><input className="field" value={parentPath} onChange={(event) => setParentPath(event.target.value)} placeholder="选择父文件夹" /><button className="secondary-button" onClick={() => void pickParent()}>选择…</button></div></label>
          <div className="path-preview"><span>将创建项目和简明使用指南</span><code>{targetPath || '选择位置并输入名称'}</code></div>
          <button className="secondary-button create-project-open-existing" onClick={() => { setCreateOpen(false); void props.onOpenFolder() }} disabled={props.busy}><FolderOpen size={15} />打开已有文件夹</button>
        </div>
      </Dialog>
    </main>
  )
}
