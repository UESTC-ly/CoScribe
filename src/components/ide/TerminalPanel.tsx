import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ExternalLink, ShieldAlert, ShieldCheck, TerminalSquare, X } from 'lucide-react'

import type { AiShellStatus } from '../../shared/types'

interface TerminalPanelProps {
  projectPath: string
  aiShellEnabled: boolean
  onClose: () => void
  onOpenSettings: () => void
  onError: (message: string) => void
}

export function TerminalPanel({
  projectPath,
  aiShellEnabled,
  onClose,
  onOpenSettings,
  onError
}: TerminalPanelProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const userSessionIdRef = useRef<string | null>(null)
  const aiSessionIdsRef = useRef(new Set<string>())
  const [status, setStatus] = useState<AiShellStatus | null>(null)
  const [authorizing, setAuthorizing] = useState(false)

  useEffect(() => {
    let disposed = false
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      scrollback: 5_000,
      theme: {
        background: '#17191f',
        foreground: '#e7e9ee',
        cursor: '#a49aff',
        selectionBackground: '#453f6d'
      }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fit

    const unsubscribe = window.coscribe.terminal.onEvent((event) => {
      if (disposed) return
      if (event.type === 'started' && event.session.kind === 'ai') {
        aiSessionIdsRef.current.add(event.sessionId)
        terminal.writeln(`\r\n\u001b[35m[AI Shell · ${event.session.cwd}]\u001b[0m`)
        return
      }
      if (event.type === 'data') {
        if (event.sessionId === userSessionIdRef.current || aiSessionIdsRef.current.has(event.sessionId)) {
          terminal.write(event.data)
        }
        return
      }
      if (event.type === 'exit' && aiSessionIdsRef.current.delete(event.sessionId)) {
        terminal.writeln(`\r\n\u001b[35m[AI Shell 已结束 · exit ${event.exitCode}]\u001b[0m`)
      }
      if (event.type === 'error') terminal.writeln(`\r\n\u001b[31m${event.message}\u001b[0m`)
    })
    const input = terminal.onData((data) => {
      const sessionId = userSessionIdRef.current
      if (sessionId) void window.coscribe.terminal.write(sessionId, data).catch((reason: unknown) => {
        onError(reason instanceof Error ? reason.message : '无法向终端写入输入。')
      })
    })
    const resize = new ResizeObserver(() => {
      if (disposed) return
      try {
        fit.fit()
        const sessionId = userSessionIdRef.current
        if (sessionId) void window.coscribe.terminal.resize(sessionId, terminal.cols, terminal.rows)
      } catch {
        // The panel may be between layout states while resizing.
      }
    })
    resize.observe(host)
    queueMicrotask(() => {
      if (disposed) return
      fit.fit()
      void window.coscribe.terminal.create({
        cwd: projectPath,
        cols: terminal.cols,
        rows: terminal.rows
      }).then((session) => {
        if (disposed) {
          void window.coscribe.terminal.kill(session.id)
          return
        }
        userSessionIdRef.current = session.id
      }).catch((reason: unknown) => {
        onError(reason instanceof Error ? reason.message : '内置终端启动失败。')
      })
    })
    return () => {
      disposed = true
      unsubscribe()
      input.dispose()
      resize.disconnect()
      const sessionId = userSessionIdRef.current
      userSessionIdRef.current = null
      if (sessionId) void window.coscribe.terminal.kill(sessionId)
      void window.coscribe.terminal.revokeAiShell()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [onError, projectPath])

  useEffect(() => {
    void window.coscribe.terminal.aiShellStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [aiShellEnabled])

  const authorize = async (): Promise<void> => {
    setAuthorizing(true)
    try {
      setStatus(await window.coscribe.terminal.authorizeAiShell())
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'AI Shell 授权失败。')
      setStatus(await window.coscribe.terminal.aiShellStatus().catch(() => null))
    } finally {
      setAuthorizing(false)
    }
  }

  const revoke = async (): Promise<void> => {
    setStatus(await window.coscribe.terminal.revokeAiShell())
  }

  return (
    <section className="terminal-panel" aria-label="IDE 终端">
      <header className="terminal-panel__toolbar">
        <span><TerminalSquare size={14} /><strong>终端</strong><small>{projectPath}</small></span>
        <div>
          {status?.authorized && (
            <span className="terminal-panel__authorization"><ShieldCheck size={13} />AI Shell 已授权</span>
          )}
          {status?.enabled ? (
            <button type="button" className="secondary-button" disabled={authorizing} onClick={() => void authorize()}>
              <ShieldAlert size={13} />{authorizing ? '等待确认…' : status.authorized ? '重新开启 AI Shell' : '开启 AI Shell'}
            </button>
          ) : (
            <button type="button" className="secondary-button" onClick={onOpenSettings}>
              <ShieldAlert size={13} />配置 AI Shell
            </button>
          )}
          {status?.authorized && <button type="button" className="text-button" onClick={() => void revoke()}>撤销授权</button>}
          <button type="button" className="icon-button" onClick={() => void window.coscribe.terminal.openExternal(projectPath).catch((reason: unknown) => onError(reason instanceof Error ? reason.message : '无法打开系统终端。'))} aria-label="在系统终端打开" title="在系统终端打开"><ExternalLink size={14} /></button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭终端" title="关闭终端"><X size={14} /></button>
        </div>
      </header>
      <div className="terminal-panel__host" ref={hostRef} />
    </section>
  )
}
