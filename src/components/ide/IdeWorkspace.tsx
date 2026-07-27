import { useRef } from 'react'
import { Code2, FilePlus2, PanelBottomClose, PanelBottomOpen, TerminalSquare } from 'lucide-react'

import { TerminalPanel } from './TerminalPanel'

interface IdeWorkspaceProps {
  projectPath: string
  aiShellEnabled: boolean
  terminalVisible: boolean
  terminalHeight: number
  onTerminalVisibleChange: (visible: boolean) => void
  onTerminalHeightChange: (height: number) => void
  onCreateCodeFile: () => void
  onOpenSettings: () => void
  onError: (message: string) => void
  children: React.ReactNode
}

export function IdeWorkspace({
  projectPath,
  aiShellEnabled,
  terminalVisible,
  terminalHeight,
  onTerminalVisibleChange,
  onTerminalHeightChange,
  onCreateCodeFile,
  onOpenSettings,
  onError,
  children
}: IdeWorkspaceProps): React.JSX.Element {
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null)

  return (
    <section className="ide-workspace" aria-label="IDE 工作区">
      <header className="ide-workspace__toolbar">
        <span><Code2 size={15} /><strong>IDE</strong><small>项目文件夹即工作区</small></span>
        <div>
          <button type="button" className="secondary-button" onClick={onCreateCodeFile}><FilePlus2 size={13} />新建代码文件</button>
          <button type="button" className={terminalVisible ? 'primary-button' : 'secondary-button'} onClick={() => onTerminalVisibleChange(!terminalVisible)}>
            {terminalVisible ? <PanelBottomClose size={13} /> : <PanelBottomOpen size={13} />}
            {terminalVisible ? '收起终端' : '打开终端'}
          </button>
          <button type="button" className="icon-button" onClick={() => void window.coscribe.terminal.openExternal(projectPath).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : '无法打开系统终端。'))} aria-label="在系统终端打开项目" title="在系统终端打开项目"><TerminalSquare size={14} /></button>
        </div>
      </header>
      <div className="ide-workspace__editors">{children}</div>
      {terminalVisible && (
        <>
          <div
            className="ide-terminal-resize"
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整终端高度"
            tabIndex={0}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              resizeRef.current = { startY: event.clientY, startHeight: terminalHeight }
            }}
            onPointerMove={(event) => {
              if (!resizeRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
              onTerminalHeightChange(resizeRef.current.startHeight + resizeRef.current.startY - event.clientY)
            }}
            onPointerUp={(event) => {
              resizeRef.current = null
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              onTerminalHeightChange(terminalHeight + (event.key === 'ArrowUp' ? 16 : -16))
            }}
          />
          <div className="ide-workspace__terminal" style={{ height: terminalHeight }}>
            <TerminalPanel
              projectPath={projectPath}
              aiShellEnabled={aiShellEnabled}
              onClose={() => onTerminalVisibleChange(false)}
              onOpenSettings={onOpenSettings}
              onError={onError}
            />
          </div>
        </>
      )}
    </section>
  )
}
