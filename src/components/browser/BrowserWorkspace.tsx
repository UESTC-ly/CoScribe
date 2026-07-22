import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FileDown,
  FileText,
  Globe2,
  LoaderCircle,
  Quote,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  TextSelect,
  X
} from 'lucide-react'

import type {
  FileReadResult,
  ResearchBrowserExtractMode,
  ResearchBrowserExtractResult,
  ResearchBrowserState
} from '../../shared/types'
import '../../styles/browser.css'

const EMPTY_STATE: ResearchBrowserState = {
  url: '',
  title: '新资料页',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  secure: false
}

interface BrowserWorkspaceProps {
  suspended?: boolean
  onClose: () => void
  onSendToAi: (capture: ResearchBrowserExtractResult) => void
  onCiteSource: (state: ResearchBrowserState) => void
  onSaved: (file: FileReadResult) => void | Promise<void>
  onError: (message: string) => void
}

export function BrowserWorkspace({
  suspended = false,
  onClose,
  onSendToAi,
  onCiteSource,
  onSaved,
  onError
}: BrowserWorkspaceProps): React.JSX.Element {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<ResearchBrowserState>(EMPTY_STATE)
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState<'selection' | 'article' | 'archive' | 'markdown' | 'pdf' | null>(null)
  const [localMessage, setLocalMessage] = useState<string | null>(null)

  const reportError = useCallback((reason: unknown): void => {
    const message = reason instanceof Error ? reason.message : '资料浏览器操作失败。'
    setLocalMessage(message)
    onError(message)
  }, [onError])

  const acceptState = useCallback((next: ResearchBrowserState): void => {
    setState(next)
    if (next.url) setAddress(next.url)
    if (next.error) setLocalMessage(next.error)
    else if (next.notice) setLocalMessage(next.notice)
  }, [])

  useEffect(() => {
    let alive = true
    const unsubscribeState = window.coscribe.browser.onState((next) => {
      if (alive) acceptState(next)
    })
    const unsubscribeSelection = window.coscribe.browser.onSelection((event) => {
      if (!alive) return
      if (event.type === 'captured') {
        setLocalMessage(null)
        onSendToAi(event.result)
      } else reportError(new Error(event.message))
    })
    void window.coscribe.browser.open().then((next) => {
      if (alive) acceptState(next)
    }).catch(reportError)
    return () => {
      alive = false
      unsubscribeState()
      unsubscribeSelection()
      void window.coscribe.browser.setVisible(false)
    }
  }, [acceptState, onSendToAi, reportError])

  useEffect(() => {
    void window.coscribe.browser.setVisible(!suspended)
  }, [suspended])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    let frame = 0
    const reportBounds = (): void => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const bounds = surface.getBoundingClientRect()
        let left = bounds.left
        let right = bounds.right
        for (const selector of ['.project-navigator', '.ai-workspace']) {
          const overlay = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
          if (!overlay || overlay.bottom <= bounds.top || overlay.top >= bounds.bottom) continue
          if (overlay.left <= left && overlay.right > left) left = Math.min(right, overlay.right)
          else if (overlay.right >= right && overlay.left < right) right = Math.max(left, overlay.left)
        }
        void window.coscribe.browser.setBounds({
          x: Math.round(left),
          y: Math.round(bounds.top),
          width: Math.round(Math.max(0, right - left)),
          height: Math.round(bounds.height)
        })
      })
    }
    const observer = new ResizeObserver(reportBounds)
    observer.observe(surface)
    const observedLayoutElements = new Set<Element>([surface])
    const observeLayoutElements = (): void => {
      for (const selector of ['.project-navigator', '.ai-workspace', '.app-body']) {
        const element = document.querySelector(selector)
        if (!element || observedLayoutElements.has(element)) continue
        observedLayoutElements.add(element)
        observer.observe(element)
      }
    }
    observeLayoutElements()
    const mutationObserver = new MutationObserver(reportBounds)
    mutationObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style'],
      childList: true,
      subtree: true
    })
    const layoutMutationObserver = new MutationObserver(() => {
      observeLayoutElements()
      reportBounds()
    })
    layoutMutationObserver.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', reportBounds)
    reportBounds()
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      mutationObserver.disconnect()
      layoutMutationObserver.disconnect()
      window.removeEventListener('resize', reportBounds)
    }
  }, [])

  const navigate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    try {
      setLocalMessage(null)
      acceptState(await window.coscribe.browser.navigate(address))
    } catch (reason) {
      reportError(reason)
    }
  }

  const extract = async (mode: ResearchBrowserExtractMode): Promise<void> => {
    setBusy(mode)
    try {
      setLocalMessage(null)
      onSendToAi(await window.coscribe.browser.extract(mode))
    } catch (reason) {
      reportError(reason)
    } finally {
      setBusy(null)
    }
  }

  const save = async (format: 'archive' | 'markdown' | 'pdf'): Promise<void> => {
    setBusy(format)
    try {
      setLocalMessage(null)
      const result = format === 'archive'
        ? await window.coscribe.browser.saveArchive()
        : format === 'markdown'
          ? await window.coscribe.browser.saveMarkdown()
          : await window.coscribe.browser.savePdf()
      await onSaved(result)
      setLocalMessage(`已保存到资料剪藏：${result.path.split(/[\\/]/u).at(-1) ?? result.path}`)
    } catch (reason) {
      reportError(reason)
    } finally {
      setBusy(null)
    }
  }

  const close = async (): Promise<void> => {
    try {
      await window.coscribe.browser.close()
    } finally {
      onClose()
    }
  }

  const hasPage = Boolean(state.url)
  const status = localMessage || state.error || state.notice || (state.loading ? '正在加载原网页…' : '')

  return (
    <section className="research-browser" aria-label="资料浏览器">
      <header className="research-browser__tabbar">
        <Globe2 size={14} aria-hidden="true" />
        <strong title={state.title}>{state.title || '新资料页'}</strong>
        {state.secure && <ShieldCheck size={13} aria-label="HTTPS 安全连接" />}
        <button className="icon-button" type="button" onClick={() => void close()} title="关闭资料浏览器" aria-label="关闭资料浏览器"><X size={15} /></button>
      </header>

      <div className="research-browser__toolbar" role="toolbar" aria-label="网页工具">
        <button className="icon-button" type="button" disabled={!state.canGoBack} onClick={() => void window.coscribe.browser.back().then(acceptState).catch(reportError)} title="后退" aria-label="后退"><ArrowLeft size={16} /></button>
        <button className="icon-button" type="button" disabled={!state.canGoForward} onClick={() => void window.coscribe.browser.forward().then(acceptState).catch(reportError)} title="前进" aria-label="前进"><ArrowRight size={16} /></button>
        <button
          className="icon-button"
          type="button"
          disabled={!hasPage}
          onClick={() => void (state.loading ? window.coscribe.browser.stop() : window.coscribe.browser.reload()).then(acceptState).catch(reportError)}
          title={state.loading ? '停止加载' : '刷新'}
          aria-label={state.loading ? '停止加载' : '刷新'}
        >
          {state.loading ? <Square size={13} /> : <RefreshCw size={15} />}
        </button>

        <form className="research-browser__address" onSubmit={(event) => void navigate(event)}>
          {state.loading ? <LoaderCircle className="is-spinning" size={14} aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
          <input value={address} onChange={(event) => setAddress(event.target.value)} aria-label="网址或搜索内容" placeholder="网址或搜索内容" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </form>

        <span className="research-browser__tool-separator" />
        <button className="icon-button" type="button" disabled={!hasPage || state.loading || busy !== null} onClick={() => void extract('selection')} title="把网页选中内容发送到 AI（Cmd/Ctrl+Shift+K）" aria-label="发送网页选中内容到 AI"><TextSelect size={16} /></button>
        <button className="icon-button" type="button" disabled={!hasPage || state.loading || busy !== null} onClick={() => void extract('article')} title="把网页正文发送到 AI" aria-label="发送网页正文到 AI"><FileText size={16} /></button>
        <button className="icon-button" type="button" disabled={!hasPage || state.loading || busy !== null} onClick={() => onCiteSource(state)} title="引用当前网页来源" aria-label="引用当前网页来源"><Quote size={16} /></button>
        <button className="icon-button" type="button" disabled={!hasPage || state.loading || busy !== null} onClick={() => void save('archive')} title="保存完整网页归档（MHTML，不受 AI 正文长度限制）" aria-label="保存完整网页归档"><Archive size={16} /></button>
        <button className="icon-button" type="button" disabled={!hasPage || state.loading || busy !== null} onClick={() => void save('markdown')} title="保存为 Markdown" aria-label="保存网页为 Markdown"><FileDown size={16} /></button>
        <button className="icon-button research-browser__pdf" type="button" disabled={!hasPage || state.loading || busy !== null} onClick={() => void save('pdf')} title="按原网页排版保存为 PDF" aria-label="保存原网页为 PDF"><span>PDF</span></button>
        <button className="icon-button" type="button" disabled={!hasPage} onClick={() => void window.coscribe.browser.openExternal().catch(reportError)} title="在系统浏览器中打开" aria-label="在系统浏览器中打开"><ExternalLink size={16} /></button>
      </div>

      <div className="research-browser__status" aria-live="polite">
        <span className={state.error || (localMessage && !state.notice) ? 'is-error' : ''}>{status}</span>
        <span>{hasPage ? '原网页' : '单标签'}</span>
      </div>

      <div ref={surfaceRef} className={`research-browser__surface ${hasPage ? 'has-page' : ''}`} aria-label="原网页内容">
        {!hasPage && (
          <div className="research-browser__empty">
            <Globe2 size={30} strokeWidth={1.4} />
            <strong>资料浏览器</strong>
            <span>在地址栏输入网址或搜索内容</span>
          </div>
        )}
      </div>
    </section>
  )
}
