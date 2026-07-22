import { File, FileImage, FileText, FileType2, Globe2, GripVertical, Presentation, X } from 'lucide-react'
import type { OpenTab, PaneId } from '../../shared/types'

interface TabStripProps {
  pane: PaneId
  tabs: OpenTab[]
  activeId: string | null
  dirtyPaths: Set<string>
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onDropTab: (tabId: string, targetPane: PaneId, beforeTabId?: string) => void
}

function TabIcon({ tab }: { tab: OpenTab }): React.JSX.Element {
  if (tab.kind === 'image') return <FileImage size={13} />
  if (tab.kind === 'docx') return <FileType2 size={13} />
  if (tab.kind === 'ppt' || tab.kind === 'pptx') return <Presentation size={13} />
  if (tab.kind === 'webarchive') return <Globe2 size={13} />
  if (tab.kind === 'markdown' || tab.kind === 'text') return <FileText size={13} />
  return <File size={13} />
}

export function TabStrip({ pane, tabs, activeId, dirtyPaths, onActivate, onClose, onDropTab }: TabStripProps): React.JSX.Element {
  return (
    <div className="tab-strip" role="tablist" aria-label={`${pane === 'primary' ? '左侧' : '右侧'}编辑器标签`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      const id = event.dataTransfer.getData('application/x-vibe-tab')
      if (id) onDropTab(id, pane)
    }}>
      <div className="tab-strip__scroll">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`editor-tab ${activeId === tab.id ? 'is-active' : ''} ${tab.missing ? 'is-missing' : ''}`}
            role="tab"
            aria-selected={activeId === tab.id}
            title={tab.path}
            draggable
            onDragStart={(event) => { event.dataTransfer.setData('application/x-vibe-tab', tab.id); event.dataTransfer.effectAllowed = 'move' }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.stopPropagation(); const id = event.dataTransfer.getData('application/x-vibe-tab'); if (id && id !== tab.id) onDropTab(id, pane, tab.id) }}
            onClick={() => onActivate(tab.id)}
            onAuxClick={(event) => event.button === 1 && onClose(tab.id)}
          >
            <GripVertical className="editor-tab__grip" size={11} />
            <TabIcon tab={tab} />
            <span>{tab.name}</span>
            {dirtyPaths.has(tab.path) && <i className="dirty-dot" title="未保存" />}
            <button onClick={(event) => { event.stopPropagation(); onClose(tab.id) }} aria-label={`关闭 ${tab.name}`}><X size={12} /></button>
          </div>
        ))}
      </div>
    </div>
  )
}
