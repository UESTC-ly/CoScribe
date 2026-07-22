import { Bot, FileText, Globe2, Highlighter, MessageSquareText, PanelRight, Search, Settings } from 'lucide-react'
import type { WorkspaceState } from '../../shared/types'

type NavSection = WorkspaceState['navSection']

interface ActivityRailProps {
  active: NavSection
  aiVisible: boolean
  browserActive: boolean
  onChange: (section: NavSection) => void
  onToggleBrowser: () => void
  onToggleAi: () => void
  onSettings: () => void
}

const actions: { id: NavSection; label: string; icon: typeof FileText }[] = [
  { id: 'files', label: '文件', icon: FileText },
  { id: 'sessions', label: '会话', icon: MessageSquareText },
  { id: 'search', label: '搜索', icon: Search },
  { id: 'annotations', label: '标注', icon: Highlighter }
]

export function ActivityRail({ active, aiVisible, browserActive, onChange, onToggleBrowser, onToggleAi, onSettings }: ActivityRailProps): React.JSX.Element {
  return (
    <nav className="activity-rail" aria-label="项目功能">
      <div className="activity-rail__brand" aria-label="CoScribe"><Bot size={19} /></div>
      <div className="activity-rail__main">
        {actions.map(({ id, label, icon: Icon }) => (
          <button key={id} className={`activity-button ${active === id ? 'is-active' : ''}`} onClick={() => onChange(id)} aria-label={label} aria-current={active === id ? 'page' : undefined} title={label}>
            <Icon size={18} /><span>{label}</span>
          </button>
        ))}
        <button className={`activity-button ${browserActive ? 'is-active' : ''}`} onClick={onToggleBrowser} aria-label="资料浏览器" aria-current={browserActive ? 'page' : undefined} title="资料浏览器">
          <Globe2 size={18} /><span>资料浏览器</span>
        </button>
      </div>
      <div className="activity-rail__bottom">
        <button className={`activity-button ${aiVisible ? 'is-active' : ''}`} onClick={onToggleAi} aria-label={aiVisible ? '隐藏 AI' : '显示 AI'} title={aiVisible ? '隐藏 AI' : '显示 AI'}><PanelRight size={18} /><span>AI</span></button>
        <button className="activity-button" onClick={onSettings} aria-label="设置" title="设置"><Settings size={18} /><span>设置</span></button>
      </div>
    </nav>
  )
}
