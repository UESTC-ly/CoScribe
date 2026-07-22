import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'

interface MermaidDiagramProps {
  code: string
}

type MermaidTheme = 'default' | 'dark'

interface MermaidRenderResult {
  svg: string
  bindFunctions?: (element: Element) => void
}

interface CachedMermaidRender extends MermaidRenderResult {
  sourceId: string
}

type MermaidApi = typeof import('mermaid')['default']

const MAX_RENDER_CACHE_ENTRIES = 48
const RENDER_DEBOUNCE_MS = 36

let renderSequence = 0
let renderQueue: Promise<void> = Promise.resolve()
let mermaidModulePromise: Promise<MermaidApi> | null = null
let initializedTheme: MermaidTheme | null = null
const renderCache = new Map<string, CachedMermaidRender>()
const rendersInFlight = new Map<string, Promise<CachedMermaidRender>>()

function themeFromDocument(): MermaidTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default'
}

function queueRender<Result>(task: () => Promise<Result>): Promise<Result> {
  const result = renderQueue.catch(() => undefined).then(task)
  renderQueue = result.then(() => undefined, () => undefined)
  return result
}

function loadMermaid(): Promise<MermaidApi> {
  mermaidModulePromise ??= import('mermaid').then((module) => module.default)
  return mermaidModulePromise
}

function cacheKey(code: string, theme: MermaidTheme): string {
  return `${theme}\u0000${code}`
}

function readCached(key: string): CachedMermaidRender | undefined {
  const cached = renderCache.get(key)
  if (!cached) return undefined
  renderCache.delete(key)
  renderCache.set(key, cached)
  return cached
}

function writeCached(key: string, result: CachedMermaidRender): void {
  renderCache.delete(key)
  renderCache.set(key, result)
  while (renderCache.size > MAX_RENDER_CACHE_ENTRIES) {
    const oldest = renderCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    renderCache.delete(oldest)
  }
}

function materializeCached(result: CachedMermaidRender, id: string): MermaidRenderResult {
  if (result.sourceId === id) {
    return { svg: result.svg, bindFunctions: result.bindFunctions }
  }
  // Mermaid's bind callback can close over the original render id. Cached
  // clones intentionally reuse only the strict-mode static SVG.
  return {
    svg: result.svg.split(result.sourceId).join(id),
  }
}

function renderDiagram(code: string, theme: MermaidTheme, id: string): Promise<MermaidRenderResult> {
  const key = cacheKey(code, theme)
  const cached = readCached(key)
  if (cached) return Promise.resolve(materializeCached(cached, id))

  let pending = rendersInFlight.get(key)
  if (!pending) {
    pending = queueRender(async () => {
      const mermaid = await loadMermaid()
      if (initializedTheme !== theme) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme,
          flowchart: { htmlLabels: false },
          fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
        })
        initializedTheme = theme
      }
      const rendered = await (mermaid.render(id, code) as Promise<MermaidRenderResult>)
      return { ...rendered, sourceId: id }
    })
    rendersInFlight.set(key, pending)
    void pending.then(
      (result) => writeCached(key, result),
      () => undefined,
    ).finally(() => {
      if (rendersInFlight.get(key) === pending) rendersInFlight.delete(key)
    })
  }

  return pending.then((result) => materializeCached(result, id))
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim().slice(0, 500)
  return '图表语法无法解析。'
}

export function MermaidDiagram({ code }: MermaidDiagramProps): React.JSX.Element {
  const reactId = useId()
  const hostRef = useRef<HTMLDivElement>(null)
  const [theme, setTheme] = useState<MermaidTheme>(() => themeFromDocument())
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const root = document.documentElement
    const update = (): void => setTheme(themeFromDocument())
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      const safeId = reactId.replace(/[^a-zA-Z0-9_-]/g, '') || 'diagram'
      const id = `mermaid-${safeId}-${++renderSequence}`
      setSvg(null)
      setError(null)
      void renderDiagram(code, theme, id)
        .then((result) => {
          if (cancelled) return
          setSvg(result.svg)
          window.requestAnimationFrame(() => {
            if (!cancelled && hostRef.current) result.bindFunctions?.(hostRef.current)
          })
        })
        .catch((reason: unknown) => {
          if (cancelled) return
          setSvg(null)
          setError(errorMessage(reason))
        })
    }, RENDER_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [code, reactId, theme])

  return (
    <figure className={`vk-mermaid ${error ? 'is-error' : ''}`} aria-label="Mermaid 图表">
      {error ? (
        <div className="vk-mermaid-error" role="alert">
          <div className="vk-mermaid-error-heading"><AlertTriangle size={15} /><strong>Mermaid 图表无法渲染</strong></div>
          <span>{error}</span>
          <pre><code>{code}</code></pre>
        </div>
      ) : svg ? (
        <div ref={hostRef} className="vk-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="vk-mermaid-loading" aria-live="polite"><LoaderCircle size={16} /><span>正在渲染图表…</span></div>
      )}
    </figure>
  )
}
