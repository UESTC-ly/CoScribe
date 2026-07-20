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

let renderSequence = 0
let renderQueue: Promise<void> = Promise.resolve()

function themeFromDocument(): MermaidTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default'
}

function queueRender(task: () => Promise<MermaidRenderResult>): Promise<MermaidRenderResult> {
  const result = renderQueue.catch(() => undefined).then(task)
  renderQueue = result.then(() => undefined, () => undefined)
  return result
}

async function renderDiagram(code: string, theme: MermaidTheme, id: string): Promise<MermaidRenderResult> {
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme,
    flowchart: { htmlLabels: false },
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  })
  return mermaid.render(id, code) as Promise<MermaidRenderResult>
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
      void queueRender(() => renderDiagram(code, theme, id))
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
    }, 120)
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
